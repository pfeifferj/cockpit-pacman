use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use std::ffi::{CStr, CString};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::backups::ConfigChanged;
use crate::models::{
    InvalidInput, PacnewFile, PacnewResolution, PacnewResolveRequest, PacnewResolveResponse,
};

pub(super) const MAX_CONTENT_BYTES: usize = 1024 * 1024;
const MAX_SCAN_ENTRIES: usize = 50_000;
const MAX_SCAN_DEPTH: usize = 32;
const MAX_XATTR_BYTES: usize = 1024 * 1024;
// Drop-in loaders such as logrotate parse every file, dotfiles included, in the
// directories they include, so backups never sit beside the configuration they copy.
const BACKUP_DIRECTORY: &str = ".cockpit-pacman-backups";
static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

fn invalid(message: impl Into<String>) -> anyhow::Error {
    InvalidInput(message.into()).into()
}
fn is_io_kind(error: &anyhow::Error, kind: io::ErrorKind) -> bool {
    error
        .downcast_ref::<io::Error>()
        .is_some_and(|error| error.kind() == kind)
}
fn component(name: &str) -> Result<CString> {
    if name.contains('/') || name == ".." {
        return Err(invalid("Invalid configuration path component"));
    }
    CString::new(name).map_err(|_| invalid("Configuration path contains a NUL byte"))
}
fn io_result(result: libc::c_int) -> io::Result<()> {
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub(super) struct ConfigSelection {
    relative: String,
    pub kind: &'static str,
    suffix: usize,
}
/// Splits a pending filename into the current filename and its kind. Pacman
/// shifts an existing `.pacsave` to `.pacsave.1` and so on.
pub(super) fn split_pending(name: &str) -> Option<(&str, &'static str)> {
    if let Some(current) = name.strip_suffix(".pacnew") {
        return Some((current, "pacnew"));
    }
    let saved = match name.rsplit_once('.') {
        Some((saved, number))
            if !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()) =>
        {
            saved
        }
        _ => name,
    };
    Some((saved.strip_suffix(".pacsave")?, "pacsave"))
}
impl ConfigSelection {
    pub fn parse(path: &str) -> Result<Self> {
        let relative = path
            .strip_prefix("/etc/")
            .ok_or_else(|| invalid("Configuration must be under /etc"))?;
        if relative.len() > 4096
            || relative.chars().any(char::is_control)
            || relative
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(invalid("Invalid configuration path"));
        }
        let filename = relative.rsplit('/').next().unwrap_or("");
        let (current, kind) =
            split_pending(filename).ok_or_else(|| invalid("Select a .pacnew or .pacsave file"))?;
        if matches!(current, "" | "." | "..") {
            return Err(invalid("Invalid configuration filename"));
        }
        Ok(Self {
            relative: relative.into(),
            kind,
            suffix: filename.len() - current.len(),
        })
    }
    fn path(&self) -> String {
        format!("/etc/{}", self.relative)
    }
    fn pending_name(&self) -> &str {
        self.relative.rsplit('/').next().unwrap_or("")
    }
    fn current_name(&self) -> &str {
        &self.pending_name()[..self.pending_name().len() - self.suffix]
    }
    pub fn current_path(&self) -> String {
        format!(
            "/etc/{}",
            &self.relative[..self.relative.len() - self.suffix]
        )
    }
    fn parent_components(&self) -> impl Iterator<Item = &str> {
        let parent = self
            .relative
            .rsplit_once('/')
            .map(|(parent, _)| parent)
            .unwrap_or("");
        parent.split('/').filter(|part| !part.is_empty())
    }
    fn backup_display(&self, name: &str) -> String {
        match self.relative.rsplit_once('/') {
            Some((parent, _)) => format!("/etc/{BACKUP_DIRECTORY}/{parent}/{name}"),
            None => format!("/etc/{BACKUP_DIRECTORY}/{name}"),
        }
    }
}

pub(super) struct ConfigRoot {
    directory: File,
    owner: u32,
    privileged: bool,
}
struct Scan {
    remaining: usize,
    truncated: bool,
    files: Vec<PacnewFile>,
    warnings: Vec<String>,
}
impl ConfigRoot {
    pub fn open(path: &Path, owner: u32) -> Result<Self> {
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)?;
        safe_directory(&directory, owner, &path.display().to_string())?;
        Ok(Self {
            directory,
            owner,
            privileged: unsafe { libc::geteuid() } == 0,
        })
    }
    fn parent(&self, selection: &ConfigSelection) -> Result<File> {
        let mut directory = self.directory.try_clone()?;
        let mut location = String::from("/etc");
        for name in selection.parent_components() {
            location = format!("{location}/{name}");
            directory = open_at(&directory, name, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
            safe_directory(&directory, self.owner, &location)?;
        }
        Ok(directory)
    }
    fn backup_parent(&self, selection: &ConfigSelection) -> Result<File> {
        let mut directory = self.directory.try_clone()?;
        let mut location = String::from("/etc");
        for name in std::iter::once(BACKUP_DIRECTORY).chain(selection.parent_components()) {
            location = format!("{location}/{name}");
            directory = open_or_create_directory(&directory, name)?;
            safe_directory(&directory, self.owner, &location)?;
        }
        Ok(directory)
    }
    pub fn preview(&self, selection: &ConfigSelection) -> Result<Pair> {
        read_pair(&self.parent(selection)?, selection, self.owner)?.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "The pending configuration file no longer exists",
            )
            .into()
        })
    }
    pub fn discover(&self) -> Result<(Vec<PacnewFile>, Vec<String>)> {
        self.discover_within(MAX_SCAN_ENTRIES)
    }
    fn discover_within(&self, limit: usize) -> Result<(Vec<PacnewFile>, Vec<String>)> {
        let mut scan = Scan {
            remaining: limit,
            truncated: false,
            files: Vec::new(),
            warnings: Vec::new(),
        };
        self.scan(&mut scan, &self.directory, "", 0)?;
        if scan.truncated {
            scan.warnings.push(
                "Configuration scan reached its file limit; some files were not checked.".into(),
            );
        }
        scan.files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok((scan.files, scan.warnings))
    }
    fn scan(&self, scan: &mut Scan, directory: &File, relative: &str, depth: usize) -> Result<()> {
        let location = if relative.is_empty() {
            "/etc".to_string()
        } else {
            format!("/etc/{relative}")
        };
        if depth > MAX_SCAN_DEPTH {
            scan.warnings
                .push(format!("Scan depth limit reached under {location}."));
            return Ok(());
        }
        // Opening "." gives this scan its own directory offset.
        let duplicate =
            open_at(directory, ".", libc::O_RDONLY | libc::O_DIRECTORY, 0)?.into_raw_fd();
        let stream = unsafe { libc::fdopendir(duplicate) };
        if stream.is_null() {
            unsafe {
                libc::close(duplicate);
            }
            return Err(io::Error::last_os_error().into());
        }
        struct DirectoryStream(*mut libc::DIR);
        impl Drop for DirectoryStream {
            fn drop(&mut self) {
                unsafe {
                    libc::closedir(self.0);
                }
            }
        }
        let stream = DirectoryStream(stream);
        loop {
            unsafe {
                *libc::__errno_location() = 0;
            }
            let entry = unsafe { libc::readdir(stream.0) };
            if entry.is_null() {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(0) {
                    scan.warnings
                        .push(format!("Could not finish scanning {location}: {error}"));
                }
                break;
            }
            // The stream owns d_name until the next readdir call.
            let bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if bytes == b"."
                || bytes == b".."
                || (depth == 0 && bytes == BACKUP_DIRECTORY.as_bytes())
            {
                continue;
            }
            if scan.remaining == 0 {
                scan.truncated = true;
                break;
            }
            scan.remaining -= 1;
            let Ok(name) = std::str::from_utf8(bytes) else {
                scan.warnings
                    .push(format!("Skipped a non-UTF-8 filename under {location}."));
                continue;
            };
            let child = if relative.is_empty() {
                name.to_string()
            } else {
                format!("{relative}/{name}")
            };
            let inspected = (|| -> Result<()> {
                let metadata = stat_at(directory, name)?;
                if metadata.st_mode & libc::S_IFMT == libc::S_IFDIR {
                    // An untrusted directory's owner controls how much a walk reads; its
                    // package files come from the backup list instead.
                    match open_at(directory, name, libc::O_RDONLY | libc::O_DIRECTORY, 0) {
                        Ok(next) => {
                            safe_directory(&next, self.owner, &format!("/etc/{child}"))?;
                            self.scan(scan, &next, &child, depth + 1)?
                        }
                        Err(error)
                            if !self.privileged
                                && is_io_kind(&error, io::ErrorKind::PermissionDenied) => {}
                        Err(error) => return Err(error),
                    }
                } else if split_pending(name).is_some() {
                    let selection = ConfigSelection::parse(&format!("/etc/{child}"))?;
                    anyhow::ensure!(
                        metadata.st_mode & libc::S_IFMT == libc::S_IFREG && metadata.st_nlink == 1,
                        "not a regular, single-link file"
                    );
                    scan.files.push(PacnewFile {
                        path: format!("/etc/{child}"),
                        package: None,
                        kind: selection.kind.into(),
                        mtime: metadata.st_mtime,
                    });
                }
                Ok(())
            })();
            if let Err(error) = inspected {
                scan.warnings
                    .push(format!("Could not inspect /etc/{child}: {error:#}"));
            }
        }
        Ok(())
    }
    /// Callers hold pacman's db.lck, which serializes resolutions.
    pub fn resolve(
        &self,
        selection: &ConfigSelection,
        request: &PacnewResolveRequest,
    ) -> Result<PacnewResolveResponse> {
        self.resolve_with(selection, request, || Ok(()), || Ok(()))
    }
    fn resolve_with(
        &self,
        selection: &ConfigSelection,
        request: &PacnewResolveRequest,
        before_publish: impl FnOnce() -> Result<()>,
        before_cleanup: impl FnOnce() -> Result<()>,
    ) -> Result<PacnewResolveResponse> {
        let parent = self.parent(selection)?;
        if request.revision.is_empty() {
            return Err(invalid("A configuration revision is required"));
        }
        let pair = read_pair(&parent, selection, self.owner)?.ok_or(ConfigChanged)?;
        if pair.revision() != request.revision {
            return Err(ConfigChanged.into());
        }
        if request.resolution != PacnewResolution::SaveMerged && request.merged_content.is_some() {
            return Err(invalid(
                "Merged content is only accepted when saving a merge",
            ));
        }
        // A .pacnew carries its package's metadata and a .pacsave the local file's;
        // a merge keeps the local file's.
        let (content, metadata_source) = match request.resolution {
            PacnewResolution::KeepCurrent => (None, &pair.pending),
            PacnewResolution::UsePending => (Some(pair.pending.content.as_str()), &pair.pending),
            PacnewResolution::SaveMerged => {
                let content = request
                    .merged_content
                    .as_deref()
                    .ok_or_else(|| invalid("Merged content is required"))?;
                validate_content(content.as_bytes())?;
                let local = match &pair.current {
                    Some(current) if selection.kind == "pacnew" => current,
                    _ => &pair.pending,
                };
                (Some(content), local)
            }
        };
        let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        let mut replacement = content
            .map(|content| {
                let key = format!("{:x}", Sha256::digest(selection.current_name().as_bytes()));
                create_copy(
                    &parent,
                    &format!(".cockpit-pacman-tmp.{}.{stamp}", &key[..16]),
                    content.as_bytes(),
                    metadata_source,
                )
            })
            .transpose()?;
        let backup_parent = self.backup_parent(selection)?;
        let mut backups = Vec::new();
        if content.is_some()
            && let Some(current) = &pair.current
        {
            backups.push(create_copy(
                &backup_parent,
                &backup_stem(selection.current_name(), &stamp),
                current.content.as_bytes(),
                current,
            )?);
        }
        backups.push(create_copy(
            &backup_parent,
            &backup_stem(selection.pending_name(), &stamp),
            pair.pending.content.as_bytes(),
            &pair.pending,
        )?);
        backup_parent.sync_all()?;
        before_publish()?;
        let current_parent = self.parent(selection)?;
        if directory_identity(&parent)? != directory_identity(&current_parent)? {
            return Err(ConfigChanged.into());
        }
        if read_pair(&parent, selection, self.owner)?
            .ok_or(ConfigChanged)?
            .revision()
            != request.revision
        {
            return Err(ConfigChanged.into());
        }
        let backup_paths: Vec<String> = backups
            .iter()
            .map(|backup| selection.backup_display(&backup.name))
            .collect();
        let response = |warnings| PacnewResolveResponse {
            success: true,
            message: outcome(selection, request.resolution, pair.current.is_some()),
            backup_paths: backup_paths.clone(),
            warnings,
        };
        let mut warnings = Vec::new();
        if let Some(replacement) = &mut replacement {
            rename_at(
                &parent,
                &replacement.name,
                selection.current_name(),
                pair.current.is_none(),
            )
            .with_context(|| format!("Could not write {}", selection.current_path()))?;
            replacement.keep = true;
            backups.iter_mut().for_each(|backup| backup.keep = true);
            if let Err(error) = parent.sync_all() {
                warnings.push(format!("The configuration was replaced, but its directory could not be synced: {error}. The pending file was kept."));
                return Ok(response(warnings));
            }
        }
        let cleanup = (|| -> Result<()> {
            before_cleanup()?;
            let current_parent = self.parent(selection)?;
            if directory_identity(&parent)? != directory_identity(&current_parent)? {
                return Err(ConfigChanged.into());
            }
            let pending = read_snapshot(&parent, selection.pending_name(), self.owner)?
                .ok_or(ConfigChanged)?;
            if pending.revision() != pair.pending.revision() {
                return Err(ConfigChanged.into());
            }
            unlink_at(&parent, selection.pending_name())?;
            Ok(())
        })();
        if let Err(error) = cleanup {
            if replacement.is_none() {
                return Err(error).context(
                    "The current configuration was kept; the pending file could not be removed",
                );
            }
            warnings.push(format!(
                "The configuration was replaced, but the pending file was kept: {error:#}"
            ));
        } else {
            backups.iter_mut().for_each(|backup| backup.keep = true);
            if let Err(error) = parent.sync_all() {
                warnings.push(format!("The pending file was removed, but its directory could not be synced: {error}. Backups were retained."));
            }
        }
        Ok(response(warnings))
    }
}

fn outcome(
    selection: &ConfigSelection,
    resolution: PacnewResolution,
    current_existed: bool,
) -> String {
    let current = selection.current_path();
    let pending = selection.path();
    match resolution {
        PacnewResolution::KeepCurrent if current_existed => {
            format!("Kept {current} and removed {pending}")
        }
        PacnewResolution::KeepCurrent => format!("Removed {pending}; {current} stays absent"),
        PacnewResolution::UsePending if selection.kind == "pacsave" => {
            format!("Restored {current} from {pending}")
        }
        PacnewResolution::UsePending if current_existed => {
            format!("Replaced {current} with {pending}")
        }
        PacnewResolution::UsePending => format!("Created {current} from {pending}"),
        PacnewResolution::SaveMerged => format!("Saved the merged configuration to {current}"),
    }
}
fn safe_directory(directory: &File, owner: u32, location: &str) -> Result<()> {
    let metadata = directory.metadata()?;
    if !(metadata.is_dir() && metadata.uid() == owner && metadata.mode() & 0o022 == 0) {
        return Err(invalid(format!(
            "{location} must be owned by root and not writable by group or others"
        )));
    }
    Ok(())
}
fn backup_stem(name: &str, stamp: &str) -> String {
    // Leave room within Linux NAME_MAX for the digest, timestamp, PID and counter.
    const MAX_READABLE_BYTES: usize = 128;
    if name.len() <= MAX_READABLE_BYTES {
        return format!("{name}.{stamp}");
    }
    let mut end = MAX_READABLE_BYTES;
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    let digest = format!("{:x}", Sha256::digest(name.as_bytes()));
    format!("{}.{digest}.{stamp}", &name[..end])
}
fn open_or_create_directory(directory: &File, name: &str) -> Result<File> {
    let c_name = component(name)?;
    let created = unsafe { libc::mkdirat(directory.as_raw_fd(), c_name.as_ptr(), 0o700) } == 0;
    if !created {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::AlreadyExists {
            return Err(error).with_context(|| format!("Cannot create {name}"));
        }
    }
    let opened = open_at(directory, name, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
    if created {
        directory.sync_all()?;
    }
    Ok(opened)
}
fn directory_identity(directory: &File) -> Result<(u64, u64)> {
    let metadata = directory.metadata()?;
    Ok((metadata.dev(), metadata.ino()))
}
fn open_at(directory: &File, name: &str, flags: i32, mode: u32) -> Result<File> {
    let name = component(name)?;
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            mode,
        )
    };
    if fd < 0 {
        let error = io::Error::last_os_error();
        let name = name.to_string_lossy();
        return Err(match error.raw_os_error() {
            Some(libc::ELOOP) => invalid(format!("{name} is a symbolic link")),
            Some(libc::ENOTDIR) if flags & libc::O_DIRECTORY != 0 => {
                invalid(format!("{name} is a symbolic link or not a directory"))
            }
            _ => anyhow::Error::new(error).context(format!("Cannot open {name}")),
        });
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn stat_at(directory: &File, name: &str) -> Result<libc::stat> {
    let name = component(name)?;
    let mut metadata = std::mem::MaybeUninit::uninit();
    io_result(unsafe {
        libc::fstatat(
            directory.as_raw_fd(),
            name.as_ptr(),
            metadata.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    })?;
    Ok(unsafe { metadata.assume_init() })
}

pub(super) struct Snapshot {
    pub content: String,
    metadata: std::fs::Metadata,
    attrs: Vec<(Vec<u8>, Vec<u8>)>,
}
fn identity(metadata: &std::fs::Metadata) -> [u64; 12] {
    [
        metadata.dev(),
        metadata.ino(),
        metadata.mode() as u64,
        metadata.uid() as u64,
        metadata.gid() as u64,
        metadata.nlink(),
        metadata.size(),
        metadata.mtime() as u64,
        metadata.mtime_nsec() as u64,
        metadata.ctime() as u64,
        metadata.ctime_nsec() as u64,
        metadata.rdev(),
    ]
}
impl Snapshot {
    fn revision(&self) -> Vec<u8> {
        let mut hash = Sha256::new();
        for value in identity(&self.metadata) {
            hash.update(value.to_le_bytes());
        }
        hash.update((self.content.len() as u64).to_le_bytes());
        hash.update(self.content.as_bytes());
        for (name, value) in &self.attrs {
            hash.update((name.len() as u64).to_le_bytes());
            hash.update(name);
            hash.update((value.len() as u64).to_le_bytes());
            hash.update(value);
        }
        hash.finalize().to_vec()
    }
}
pub(super) struct Pair {
    path: String,
    pub current: Option<Snapshot>,
    pub pending: Snapshot,
}
impl Pair {
    pub fn revision(&self) -> String {
        let mut hash = Sha256::new();
        hash.update(b"cockpit-pacman-reconciliation-v1");
        hash.update((self.path.len() as u64).to_le_bytes());
        hash.update(self.path.as_bytes());
        match &self.current {
            Some(current) => {
                hash.update([1]);
                hash.update(current.revision());
            }
            None => hash.update([0]),
        }
        hash.update(self.pending.revision());
        format!("{:x}", hash.finalize())
    }
}
fn validate_content(bytes: &[u8]) -> Result<()> {
    if bytes.len() > MAX_CONTENT_BYTES {
        return Err(invalid("Configuration exceeds the 1 MiB limit"));
    }
    if bytes.contains(&0) {
        return Err(invalid("Binary configuration files cannot be edited here"));
    }
    std::str::from_utf8(bytes).map_err(|_| invalid("Configuration is not UTF-8 text"))?;
    Ok(())
}
fn read_snapshot(directory: &File, name: &str, owner: u32) -> Result<Option<Snapshot>> {
    let file = match open_at(directory, name, libc::O_RDONLY, 0) {
        Ok(file) => file,
        Err(error) if is_io_kind(&error, io::ErrorKind::NotFound) => return Ok(None),
        Err(error) => return Err(error),
    };
    let before = file.metadata()?;
    if !(before.is_file() && before.nlink() == 1) {
        return Err(invalid(
            "Configuration must be a regular file with a single link",
        ));
    }
    if !(before.uid() == owner && before.mode() & 0o022 == 0) {
        return Err(invalid(
            "Configuration must be owned by root and not writable by group or others",
        ));
    }
    let mut bytes = Vec::new();
    (&file)
        .take((MAX_CONTENT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    validate_content(&bytes)?;
    let attrs = read_attrs(&file)?;
    let after = file.metadata()?;
    if identity(&before) != identity(&after) {
        return Err(ConfigChanged.into());
    }
    Ok(Some(Snapshot {
        content: String::from_utf8(bytes)?,
        metadata: after,
        attrs,
    }))
}
fn read_pair(directory: &File, selection: &ConfigSelection, owner: u32) -> Result<Option<Pair>> {
    let Some(pending) = read_snapshot(directory, selection.pending_name(), owner)? else {
        return Ok(None);
    };
    let current = read_snapshot(directory, selection.current_name(), owner)?;
    Ok(Some(Pair {
        path: selection.relative.clone(),
        current,
        pending,
    }))
}
fn read_attrs(file: &File) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
    let size = unsafe { libc::flistxattr(file.as_raw_fd(), std::ptr::null_mut(), 0) };
    if size < 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ENOTSUP) {
            return Ok(Vec::new());
        }
        return Err(error.into());
    }
    if size as usize > MAX_XATTR_BYTES {
        return Err(invalid(
            "Configuration extended attributes exceed their limit",
        ));
    }
    let mut names = vec![0u8; size as usize];
    if size > 0 {
        let read =
            unsafe { libc::flistxattr(file.as_raw_fd(), names.as_mut_ptr().cast(), names.len()) };
        if read < 0 {
            return Err(io::Error::last_os_error().into());
        }
        names.truncate(read as usize);
    }
    let mut attrs = Vec::new();
    let mut total = names.len();
    for name in names
        .split(|byte| *byte == 0)
        .filter(|name| !name.is_empty())
    {
        let c_name = CString::new(name)?;
        let size =
            unsafe { libc::fgetxattr(file.as_raw_fd(), c_name.as_ptr(), std::ptr::null_mut(), 0) };
        if size < 0 {
            return Err(io::Error::last_os_error().into());
        }
        total = total
            .checked_add(size as usize)
            .ok_or_else(|| invalid("Extended attributes are too large"))?;
        if total > MAX_XATTR_BYTES {
            return Err(invalid(
                "Configuration extended attributes exceed their limit",
            ));
        }
        let mut value = vec![0; size as usize];
        let read = unsafe {
            libc::fgetxattr(
                file.as_raw_fd(),
                c_name.as_ptr(),
                value.as_mut_ptr().cast(),
                value.len(),
            )
        };
        if read < 0 {
            return Err(io::Error::last_os_error().into());
        }
        value.truncate(read as usize);
        attrs.push((name.to_vec(), value));
    }
    attrs.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(attrs)
}
struct Artifact<'a> {
    directory: &'a File,
    name: String,
    keep: bool,
}
impl Drop for Artifact<'_> {
    fn drop(&mut self) {
        if !self.keep {
            let _ = unlink_at(self.directory, &self.name);
        }
    }
}
fn create_copy<'a>(
    directory: &'a File,
    stem: &str,
    bytes: &[u8],
    source: &Snapshot,
) -> Result<Artifact<'a>> {
    create_copy_durable(directory, stem, bytes, source, File::sync_all)
}
fn create_copy_durable<'a>(
    directory: &'a File,
    stem: &str,
    bytes: &[u8],
    source: &Snapshot,
    sync: impl FnOnce(&File) -> io::Result<()>,
) -> Result<Artifact<'a>> {
    let (mut file, artifact) = loop {
        let candidate = format!(
            "{stem}.{}.{}",
            std::process::id(),
            NEXT_FILE.fetch_add(1, Ordering::Relaxed)
        );
        match open_at(
            directory,
            &candidate,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            0o600,
        ) {
            Ok(file) => {
                break (
                    file,
                    Artifact {
                        directory,
                        name: candidate,
                        keep: false,
                    },
                );
            }
            Err(error) if is_io_kind(&error, io::ErrorKind::AlreadyExists) => continue,
            Err(error) => return Err(error).context("Could not create a configuration copy"),
        }
    };
    file.write_all(bytes)?;
    let metadata = file.metadata()?;
    if metadata.uid() != source.metadata.uid() || metadata.gid() != source.metadata.gid() {
        std::os::unix::fs::fchown(
            &file,
            Some(source.metadata.uid()),
            Some(source.metadata.gid()),
        )
        .context("Could not preserve configuration ownership")?;
    }
    // A new file may inherit its directory's default ACL or security label.
    for (name, _) in read_attrs(&file)? {
        if !source.attrs.iter().any(|(wanted, _)| *wanted == name) {
            let name = CString::new(name)?;
            io_result(unsafe { libc::fremovexattr(file.as_raw_fd(), name.as_ptr()) })?;
        }
    }
    for (name, value) in &source.attrs {
        let name = CString::new(name.as_slice())?;
        io_result(unsafe {
            libc::fsetxattr(
                file.as_raw_fd(),
                name.as_ptr(),
                value.as_ptr().cast(),
                value.len(),
                0,
            )
        })
        .context("Could not preserve configuration extended attributes")?;
    }
    // An unchanged copy keeps its source's mtime, as pacdiff's mv does.
    if bytes == source.content.as_bytes() {
        file.set_modified(source.metadata.modified()?)?;
    }
    file.set_permissions(std::fs::Permissions::from_mode(
        source.metadata.mode() & 0o7777,
    ))?;
    let final_metadata = file.metadata()?;
    anyhow::ensure!(
        final_metadata.uid() == source.metadata.uid()
            && final_metadata.gid() == source.metadata.gid()
            && final_metadata.mode() & 0o7777 == source.metadata.mode() & 0o7777
            && read_attrs(&file)? == source.attrs,
        "Configuration ownership, permissions or extended attributes could not be preserved"
    );
    sync(&file).context("Could not write the configuration copy to disk")?;
    Ok(artifact)
}
fn unlink_at(directory: &File, name: &str) -> Result<()> {
    let name = component(name)?;
    io_result(unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) })
        .map_err(Into::into)
}
fn rename_at(directory: &File, from: &str, to: &str, missing_destination: bool) -> Result<()> {
    let from = component(from)?;
    let to = component(to)?;
    let flags = if missing_destination {
        libc::RENAME_NOREPLACE
    } else {
        0
    };
    io_result(unsafe {
        libc::renameat2(
            directory.as_raw_fd(),
            from.as_ptr(),
            directory.as_raw_fd(),
            to.as_ptr(),
            flags,
        )
    })
    .map_err(Into::into)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
