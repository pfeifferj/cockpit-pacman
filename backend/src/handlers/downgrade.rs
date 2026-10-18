use alpm::{Alpm, SigLevel, TransFlag};
use anyhow::{Context, Result};
use std::cell::RefCell;
use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Mutex, mpsc};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::alpm::{TransactionGuard, Verbosity, get_handle, setup_dl_cb};
use crate::check_cancel_early;
use crate::handlers::mutation::{
    EventScope, MutationOpts, add_pkg_failure, begin_mutation, build_preview, commit_and_complete,
    fail_complete, prepare_failure, record_questions,
};
use crate::inhibit::ShutdownInhibitor;
use crate::models::{
    CachedVersion, DowngradeResponse, PreflightState, StreamEvent, TransactionPreview,
};
use crate::util::{
    emit_event, emit_json, get_cache_dir, is_cancelled, list_cache_packages,
    parse_package_filename, setup_signal_handler, spawn_cancel_listener,
};

use crate::validation::{validate_package_name, validate_version};

pub fn list_downgrades(package_name: Option<&str>) -> Result<()> {
    let alpm = get_handle()?;
    let cache_dir = get_cache_dir();
    let cache_path = Path::new(&cache_dir);

    if !cache_path.exists() {
        let response = DowngradeResponse {
            packages: vec![],
            total: 0,
        };
        return emit_json(&response);
    }

    let mut packages: Vec<CachedVersion> = Vec::new();

    for (entry, filename, name, version) in list_cache_packages(cache_path) {
        if let Some(filter_name) = package_name
            && name != filter_name
        {
            continue;
        }

        let installed_version = get_installed_version(&alpm, &name);
        let is_older = installed_version
            .as_ref()
            .map(|iv| is_version_older(&version, iv))
            .unwrap_or(false);

        if let Ok(metadata) = entry.metadata() {
            packages.push(CachedVersion {
                name,
                version,
                filename,
                size: metadata.len() as i64,
                installed_version,
                is_older,
            });
        }
    }

    packages.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then_with(|| compare_versions(&b.version, &a.version))
    });

    let total = packages.len();
    let response = DowngradeResponse { packages, total };

    emit_json(&response)
}

pub fn downgrade_package(
    name: &str,
    version: &str,
    timeout: Option<u64>,
    approved_removals: &[String],
) -> Result<()> {
    validate_package_name(name)?;
    validate_version(version)?;

    let cache_dir = get_cache_dir();
    let cache_path = Path::new(&cache_dir);
    let target_filename = find_package_file(cache_path, name, version)?;
    let pkg_path = cache_path.join(&target_filename);

    install_downgrade(
        DowngradeSource::Cached(pkg_path.to_string_lossy().into_owned()),
        name,
        version,
        timeout,
        approved_removals,
    )
}

pub(crate) enum DowngradeSource {
    Cached(String),
    /// An Arch Linux Archive package, verified with the remote file siglevel
    /// whether it is fetched now or was fetched into the cache by a preview.
    Archive {
        url: String,
        filename: String,
    },
}

fn file_siglevel(level: SigLevel, default: SigLevel) -> SigLevel {
    if level.is_empty() { default } else { level }
}

/// The first cache directory that already holds `filename`.
pub(crate) fn cached_file<I, P>(cache_dirs: I, filename: &str) -> Option<PathBuf>
where
    I: IntoIterator<Item = P>,
    P: AsRef<Path>,
{
    cache_dirs
        .into_iter()
        .map(|dir| dir.as_ref().join(filename))
        .find(|path| path.is_file())
}

fn needs_signature_file(siglevel: SigLevel, path: &Path) -> bool {
    let required =
        siglevel.contains(SigLevel::PACKAGE) && !siglevel.contains(SigLevel::PACKAGE_OPTIONAL);
    let mut sig = path.as_os_str().to_owned();
    sig.push(".sig");
    required && !Path::new(&sig).is_file()
}

fn resolve_source(handle: &Alpm, source: &DowngradeSource) -> Result<(String, SigLevel), String> {
    match source {
        DowngradeSource::Cached(path) => Ok((
            path.clone(),
            file_siglevel(handle.local_file_siglevel(), handle.default_siglevel()),
        )),
        DowngradeSource::Archive { url, filename } => {
            crate::network::require_network().map_err(|e| e.to_string())?;
            let siglevel = file_siglevel(handle.remote_file_siglevel(), handle.default_siglevel());
            // alpm downloads the detached signature only when the remote level
            // asks for one, and an unset RemoteFileSigLevel arrives here empty.
            if handle.remote_file_siglevel().is_empty() {
                handle
                    .set_remote_file_siglevel(siglevel)
                    .map_err(|e| format!("Failed to set signature level: {}", e))?;
            }
            if let Some(path) = cached_file(handle.cachedirs().iter(), filename) {
                if !needs_signature_file(siglevel, &path) {
                    return Ok((path.to_string_lossy().into_owned(), siglevel));
                }
                return Err(format!(
                    "Cached {} is missing required signature. Remove it through Cache and retry the archive download.",
                    filename
                ));
            }
            let fetched = handle
                .fetch_pkgurl([url.as_str()].into_iter())
                .map_err(|e| format!("Failed to download {}: {}", filename, e))?;
            let path = fetched
                .first()
                .map(|p| p.to_string())
                .ok_or_else(|| format!("Download of {} produced no file", filename))?;
            Ok((path, siglevel))
        }
    }
}

/// Previews a cached package version without committing.
pub fn preflight_downgrade(name: &str, version: &str) -> Result<()> {
    validate_package_name(name)?;
    validate_version(version)?;
    setup_signal_handler()?;

    let mut handle = get_handle()?;
    let preview = downgrade_preview(&mut handle, Path::new(&get_cache_dir()), name, version)?;
    emit_json(&preview)
}

fn downgrade_preview(
    handle: &mut Alpm,
    cache_path: &Path,
    name: &str,
    version: &str,
) -> Result<TransactionPreview> {
    let filename = match find_package_file(cache_path, name, version) {
        Ok(f) => f,
        Err(e) => {
            return Ok(TransactionPreview {
                error: Some(e.to_string()),
                ..Default::default()
            });
        }
    };
    let source = DowngradeSource::Cached(cache_path.join(filename).to_string_lossy().into_owned());
    preview_source(handle, &source, name)
}

/// Previews a downgrade from the archive. The package is fetched into the
/// cache first, with download progress streamed, so the commit reuses it.
pub(crate) fn emit_archive_preview(name: &str, source: DowngradeSource) -> Result<()> {
    let mut handle = get_handle()?;
    let diagnostics = Rc::new(RefCell::new(String::new()));
    handle.set_log_cb(Rc::clone(&diagnostics), |level, message, diagnostics| {
        if level.intersects(alpm::LogLevel::ERROR | alpm::LogLevel::WARNING) {
            let mut details = diagnostics.borrow_mut();
            if details.len() < 16 * 1024 {
                details.push_str(&crate::network::native_diagnostic(message.trim()));
                details.push('\n');
            }
        }
    });
    setup_dl_cb(&mut handle, Verbosity::Streaming);
    let preview = preview_source(&mut handle, &source, name)?;
    if let Some(error) = preview.error.as_ref() {
        let details = diagnostics.borrow();
        if !details.is_empty() {
            return Err(anyhow::anyhow!(details.trim().to_owned()).context(error.clone()));
        }
    }
    emit_json(&preview)
}

struct PreviewFetchGuard {
    fetching: Arc<Mutex<bool>>,
    stop: mpsc::Sender<()>,
    watchdog: Option<JoinHandle<()>>,
}

fn cancel_preview_fetch(fetching: &Mutex<bool>, group: libc::pid_t) {
    let fetching = fetching
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if *fetching {
        // libalpm's sandbox downloader is a child; terminating only the parent can leave it running.
        // SAFETY: group was verified to be this command's private process group.
        unsafe {
            libc::kill(-group, libc::SIGKILL);
        }
    }
    crate::util::request_cancel();
}

impl PreviewFetchGuard {
    fn new() -> Result<Self> {
        let group = std::process::id() as libc::pid_t;
        // SAFETY: no child or transaction has started; setpgid isolates only this process.
        if unsafe { libc::getpgrp() } != group && unsafe { libc::setpgid(0, 0) } != 0 {
            return Err(std::io::Error::last_os_error()).context("Cannot isolate archive preview");
        }
        let fetching = Arc::new(Mutex::new(true));
        let signal_state = Arc::clone(&fetching);
        ctrlc::set_handler(move || cancel_preview_fetch(&signal_state, group))
            .context("Cannot install archive preview cancellation handler")?;
        let (stop, receiver) = mpsc::channel();
        let timeout_state = Arc::clone(&fetching);
        let watchdog = std::thread::Builder::new()
            .name("archive-preview-timeout".into())
            .spawn(move || {
                if receiver.recv_timeout(Duration::from_secs(300))
                    == Err(mpsc::RecvTimeoutError::Timeout)
                {
                    cancel_preview_fetch(&timeout_state, group);
                }
            })?;
        Ok(Self {
            fetching,
            stop,
            watchdog: Some(watchdog),
        })
    }
}

impl Drop for PreviewFetchGuard {
    fn drop(&mut self) {
        // Serialize this transition with cancellation before any database lock is acquired.
        *self
            .fetching
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = false;
        let _ = self.stop.send(());
        if let Some(watchdog) = self.watchdog.take() {
            let _ = watchdog.join();
        }
    }
}

fn preview_source(
    handle: &mut Alpm,
    source: &DowngradeSource,
    name: &str,
) -> Result<TransactionPreview> {
    let error = |message: String| TransactionPreview {
        error: Some(message),
        ..Default::default()
    };
    let resolved = if matches!(source, DowngradeSource::Archive { .. }) {
        let fetch = PreviewFetchGuard::new()?;
        let result = resolve_source(handle, source);
        drop(fetch);
        spawn_cancel_listener()?;
        result
    } else {
        resolve_source(handle, source)
    };
    let (path, siglevel) = match resolved {
        Ok(resolved) => resolved,
        Err(message) => return Ok(error(message)),
    };
    if is_cancelled() {
        anyhow::bail!("Operation cancelled");
    }

    let state = Rc::new(RefCell::new(PreflightState::default()));
    // install_downgrade declines dependent-removal prompts, so its preview does too.
    record_questions(handle, &state);

    let mut tx = TransactionGuard::new(handle, TransFlag::NONE)?;
    let pkg = match tx.load_pkg(&path, siglevel) {
        Ok(pkg) => pkg,
        Err(e) => return Ok(error(format!("Failed to load {}: {}", path, e))),
    };
    if let Err(e) = tx.add_pkg(pkg) {
        return Ok(error(format!(
            "Failed to add '{}' to transaction: {}",
            name, e
        )));
    }
    build_preview(&mut tx, &[name.to_string()], false, &state, Vec::new())
}

pub(crate) fn install_downgrade(
    source: DowngradeSource,
    name: &str,
    version: &str,
    timeout_secs: Option<u64>,
    approved_removals: &[String],
) -> Result<()> {
    if matches!(source, DowngradeSource::Archive { .. }) {
        crate::network::require_network()?;
    }
    let (mut handle, timeout) = begin_mutation(
        EventScope::Upgrade,
        MutationOpts {
            questions: Some(!approved_removals.is_empty()),
        },
        timeout_secs,
    )?;

    check_cancel_early!(&timeout);

    emit_event(&StreamEvent::Event {
        event: format!("Downgrading {} to version {}", name, version),
        package: Some(name.to_string()),
        current: None,
        total: None,
    });

    let (path, siglevel) = resolve_source(&handle, &source).map_err(fail_complete)?;

    check_cancel_early!(&timeout);

    let _inhibitor = ShutdownInhibitor::take("Downgrading package");

    let mut tx = TransactionGuard::new(&mut handle, TransFlag::NONE)?;

    let pkg = match tx.load_pkg(&path, siglevel) {
        Ok(pkg) => pkg,
        Err(e) => return Err(fail_complete(format!("Failed to load {}: {}", path, e))),
    };

    if let Err(e) = tx.add_pkg(pkg) {
        return Err(add_pkg_failure(name, e));
    }

    check_cancel_early!(&timeout);

    if let Some(err_msg) = tx.prepare().err() {
        return Err(prepare_failure(&err_msg));
    }

    crate::alpm::check_approved_removals(
        tx.remove().iter().map(|pkg| pkg.name()),
        approved_removals,
    )
    .map_err(|e| prepare_failure(&e))?;

    commit_and_complete(
        &mut tx,
        &timeout,
        Some(format!("Successfully downgraded {} to {}", name, version)),
    )
}

fn find_package_file(cache_path: &Path, name: &str, version: &str) -> Result<String> {
    let entries = fs::read_dir(cache_path)
        .with_context(|| format!("Failed to read cache directory: {}", cache_path.display()))?;

    for entry_result in entries {
        let entry = match entry_result {
            Ok(e) => e,
            Err(e) => {
                eprintln!("Warning: Failed to read directory entry: {}", e);
                continue;
            }
        };
        let path = entry.path();
        if let Some(filename) = path.file_name().map(|s| s.to_string_lossy().to_string())
            && let Some((pkg_name, pkg_version, _)) = parse_package_filename(&filename)
            && pkg_name == name
            && pkg_version == version
        {
            return Ok(filename);
        }
    }

    anyhow::bail!("Package file not found in cache: {}-{}", name, version)
}

pub(crate) fn get_installed_version(alpm: &Alpm, name: &str) -> Option<String> {
    alpm.localdb()
        .pkg(name)
        .ok()
        .map(|p| p.version().to_string())
}

pub(crate) fn is_version_older(cached: &str, installed: &str) -> bool {
    matches!(compare_versions(cached, installed), Ordering::Less)
}

pub(crate) fn compare_versions(a: &str, b: &str) -> Ordering {
    alpm::vercmp(a, b)
}

#[cfg(test)]
mod siglevel_tests {
    use super::file_siglevel;
    use alpm::SigLevel;

    #[test]
    fn an_unset_file_level_falls_back_to_the_default() {
        let default = SigLevel::PACKAGE | SigLevel::PACKAGE_OPTIONAL;
        assert_eq!(file_siglevel(SigLevel::NONE, default), default);
    }

    #[test]
    fn a_configured_file_level_is_used_as_is() {
        let configured = SigLevel::PACKAGE;
        let default = SigLevel::PACKAGE | SigLevel::PACKAGE_OPTIONAL;
        assert_eq!(file_siglevel(configured, default), configured);
    }
}

#[cfg(test)]
mod preview_tests {
    use super::{cached_file, downgrade_preview, needs_signature_file};
    use crate::models::AddReason;
    use alpm::Alpm;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn scratch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cockpit-pacman-downgrade-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn tar_entry(name: &str, body: &[u8]) -> Vec<u8> {
        let mut header = [0u8; 512];
        let field = |h: &mut [u8; 512], at: usize, value: &[u8]| {
            h[at..at + value.len()].copy_from_slice(value);
        };
        field(&mut header, 0, name.as_bytes());
        field(&mut header, 100, b"0000644\0");
        field(&mut header, 108, b"0000000\0");
        field(&mut header, 116, b"0000000\0");
        field(
            &mut header,
            124,
            format!("{:011o}\0", body.len()).as_bytes(),
        );
        field(&mut header, 136, b"00000000000\0");
        field(&mut header, 148, b"        ");
        header[156] = b'0';
        field(&mut header, 257, b"ustar\x0000");
        let sum: u32 = header.iter().map(|&b| b as u32).sum();
        field(&mut header, 148, format!("{:06o}\0 ", sum).as_bytes());

        let mut out = header.to_vec();
        out.extend_from_slice(body);
        out.resize(out.len().div_ceil(512) * 512, 0);
        out
    }

    /// An uncompressed package; libarchive detects the format from content.
    fn write_package(dir: &Path, name: &str, version: &str) {
        let pkginfo = format!(
            "pkgname = {name}\npkgbase = {name}\npkgver = {version}\npkgdesc = test\n\
             arch = any\nsize = 4096\n"
        );
        let mut tar = tar_entry(".PKGINFO", pkginfo.as_bytes());
        tar.extend(vec![0u8; 1024]);
        fs::write(dir.join(format!("{name}-{version}-any.pkg.tar.gz")), tar).unwrap();
    }

    fn handle_with_installed(root: &Path, name: &str, version: &str) -> Alpm {
        let local = root.join("db/local");
        let entry = local.join(format!("{name}-{version}"));
        fs::create_dir_all(&entry).unwrap();
        fs::write(local.join("ALPM_DB_VERSION"), "9\n").unwrap();
        fs::write(
            entry.join("desc"),
            format!(
                "%NAME%\n{name}\n\n%VERSION%\n{version}\n\n%ARCH%\nany\n\n\
                 %SIZE%\n8192\n\n%REASON%\n0\n\n"
            ),
        )
        .unwrap();
        fs::write(entry.join("files"), "").unwrap();
        Alpm::new(
            root.to_string_lossy().into_owned(),
            root.join("db").to_string_lossy().into_owned(),
        )
        .unwrap()
    }

    #[test]
    fn a_cached_version_previews_as_a_target_add_over_the_installed_one() {
        let root = scratch_dir("ok");
        let cache = root.join("cache");
        fs::create_dir_all(&cache).unwrap();
        write_package(&cache, "foo", "1.0-1");
        let mut handle = handle_with_installed(&root, "foo", "2.0-1");

        let preview = downgrade_preview(&mut handle, &cache, "foo", "1.0-1").unwrap();

        assert!(preview.success, "{:?}", preview.error);
        assert_eq!(preview.add.len(), 1);
        let add = &preview.add[0];
        assert_eq!(add.name, "foo");
        assert_eq!(add.version, "1.0-1");
        assert_eq!(add.old_version.as_deref(), Some("2.0-1"));
        assert_eq!(add.reason, AddReason::Target);
        assert!(preview.remove.is_empty());
        assert!(!preview.warnings.iter().any(|w| w.id == "disk_space"));
        assert!(!root.join("db/db.lck").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_uncached_version_gives_the_preview_error_envelope() {
        let root = scratch_dir("missing");
        let cache = root.join("cache");
        fs::create_dir_all(&cache).unwrap();
        write_package(&cache, "foo", "1.0-1");
        let mut handle = handle_with_installed(&root, "foo", "2.0-1");

        let preview = downgrade_preview(&mut handle, &cache, "foo", "0.9-1").unwrap();

        assert!(!preview.success);
        assert!(preview.error.is_some());
        assert!(preview.add.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_required_signature_needs_the_sig_file_next_to_the_package() {
        use alpm::SigLevel;
        let root = scratch_dir("sig");
        let pkg = root.join("foo-1.0-1-any.pkg.tar.zst");
        fs::write(&pkg, b"x").unwrap();

        assert!(needs_signature_file(SigLevel::PACKAGE, &pkg));
        assert!(!needs_signature_file(
            SigLevel::PACKAGE | SigLevel::PACKAGE_OPTIONAL,
            &pkg
        ));
        assert!(!needs_signature_file(SigLevel::NONE, &pkg));
        fs::write(root.join("foo-1.0-1-any.pkg.tar.zst.sig"), b"s").unwrap();
        assert!(!needs_signature_file(SigLevel::PACKAGE, &pkg));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cached_file_prefers_a_cache_dir_that_holds_the_file() {
        let root = scratch_dir("cachepath");
        let empty = root.join("a");
        let full = root.join("b");
        fs::create_dir_all(&empty).unwrap();
        fs::create_dir_all(&full).unwrap();
        let filename = "foo-1.0-1-any.pkg.tar.zst";
        fs::write(full.join(filename), b"x").unwrap();

        assert_eq!(
            cached_file([&empty, &full], filename),
            Some(full.join(filename))
        );
        assert_eq!(cached_file([&empty], filename), None);
        let _ = fs::remove_dir_all(&root);
    }
}
