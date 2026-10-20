use super::*;
use crate::util::classify_error;
use std::fs;
use std::os::unix::fs::{DirBuilderExt, symlink};
use std::path::PathBuf;

fn write_config(path: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> io::Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(contents.as_ref())
}

fn create_config_dir(path: impl AsRef<Path>) -> io::Result<()> {
    fs::DirBuilder::new().mode(0o700).create(path)
}

fn set_attr(path: impl AsRef<Path>, name: &str, value: &[u8]) {
    let file = File::open(path).unwrap();
    let name = CString::new(name).unwrap();
    assert_eq!(
        unsafe {
            libc::fsetxattr(
                file.as_raw_fd(),
                name.as_ptr(),
                value.as_ptr().cast(),
                value.len(),
                0,
            )
        },
        0
    );
}

fn attrs(path: impl AsRef<Path>) -> Vec<(Vec<u8>, Vec<u8>)> {
    read_attrs(&File::open(path).unwrap()).unwrap()
}

fn rejection<T>(result: Result<T>) -> Option<&'static str> {
    classify_error(&result.err().expect("rejected"))
}

fn paths(files: &[PacnewFile]) -> Vec<&str> {
    files.iter().map(|file| file.path.as_str()).collect()
}

struct Fixture {
    path: PathBuf,
    root: ConfigRoot,
    selection: ConfigSelection,
}
impl Fixture {
    fn new(kind: &str, current: Option<&str>, pending: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "cpac-reconcile-{}-{}",
            std::process::id(),
            NEXT_FILE.fetch_add(1, Ordering::Relaxed)
        ));
        create_config_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let owner = fs::metadata(&path).unwrap().uid();
        if let Some(current) = current {
            write_config(path.join("config"), current).unwrap();
        }
        write_config(path.join(format!("config.{kind}")), pending).unwrap();
        let root = ConfigRoot::open(&path, owner).unwrap();
        Self {
            path,
            root,
            selection: ConfigSelection::parse(&format!("/etc/config.{kind}")).unwrap(),
        }
    }
    fn request(&self, resolution: PacnewResolution) -> PacnewResolveRequest {
        PacnewResolveRequest {
            path: self.selection.path(),
            revision: self.root.preview(&self.selection).unwrap().revision(),
            resolution,
            merged_content: None,
        }
    }
    fn read(&self, name: &str) -> String {
        fs::read_to_string(self.path.join(name)).unwrap()
    }
    fn backup(&self, display: &str) -> PathBuf {
        self.path.join(display.strip_prefix("/etc/").unwrap())
    }
    fn backups(&self) -> Vec<PathBuf> {
        let mut directories = vec![self.path.join(BACKUP_DIRECTORY)];
        let mut found = Vec::new();
        while let Some(directory) = directories.pop() {
            let Ok(entries) = fs::read_dir(&directory) else {
                continue;
            };
            for entry in entries {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    directories.push(path);
                } else {
                    found.push(path);
                }
            }
        }
        found
    }
    fn assert_no_temporary_files(&self) {
        assert!(!fs::read_dir(&self.path).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("-tmp.")
        }));
    }
    fn assert_untouched(&self) {
        assert_eq!(self.read("config"), "old");
        assert_eq!(self.read("config.pacnew"), "new");
        self.assert_no_temporary_files();
        assert!(self.backups().is_empty());
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[test]
fn rejects_untrusted_paths() {
    for path in [
        "/tmp/config.pacnew",
        "/etc/../config.pacnew",
        "/etc//config.pacnew",
        "/etc/./config.pacnew",
        "/etc/config",
        "/etc/.pacnew",
        "/etc/..pacnew",
        "/etc/...pacnew",
        "/etc/sub/..pacsave",
        "/etc/config.pacnew/",
        "/etc/a\n.pacnew",
        "/etc/config.pacnew.1",
        "/etc/config.pacsave.",
        "/etc/config.pacsave.1a",
        "/etc/.pacsave.1",
    ] {
        assert!(ConfigSelection::parse(path).is_err(), "accepted {path:?}");
    }
    assert_eq!(
        ConfigSelection::parse("/etc/sub/配置.pacsave")
            .unwrap()
            .current_path(),
        "/etc/sub/配置"
    );
    let shifted = ConfigSelection::parse("/etc/sub/config.pacsave.12").unwrap();
    assert_eq!(
        (shifted.current_path().as_str(), shifted.kind),
        ("/etc/sub/config", "pacsave")
    );
}

#[test]
fn discovery_finds_unowned_pacsave_and_does_not_follow_links() {
    let fixture = Fixture::new("pacsave", None, "saved");
    create_config_dir(fixture.path.join("nested")).unwrap();
    write_config(fixture.path.join("nested/extra.pacnew"), "new").unwrap();
    write_config(fixture.path.join("config.pacsave.1"), "older").unwrap();
    write_config(fixture.path.join("config.pacsave.old"), "copy").unwrap();
    symlink("config.pacsave", fixture.path.join("linked.pacnew")).unwrap();
    symlink("nested", fixture.path.join("directory-link")).unwrap();
    write_config(fixture.path.join("plain"), "plain").unwrap();
    fs::hard_link(fixture.path.join("plain"), fixture.path.join("hard.pacnew")).unwrap();
    let (files, warnings) = fixture.root.discover().unwrap();
    assert_eq!(
        paths(&files),
        [
            "/etc/config.pacsave",
            "/etc/config.pacsave.1",
            "/etc/nested/extra.pacnew"
        ]
    );
    assert!(files.iter().all(|file| file.package.is_none()));
    assert_eq!(warnings.len(), 2);
    assert_eq!(fixture.root.discover().unwrap().0.len(), 3);
}

#[test]
fn unsafe_directories_are_neither_walked_nor_previewed() {
    let fixture = Fixture::new("pacnew", Some("old"), "new");
    create_config_dir(fixture.path.join("unsafe")).unwrap();
    write_config(fixture.path.join("unsafe/config.pacnew"), "new").unwrap();
    fs::set_permissions(
        fixture.path.join("unsafe"),
        fs::Permissions::from_mode(0o777),
    )
    .unwrap();
    let (files, warnings) = fixture.root.discover().unwrap();
    assert_eq!(paths(&files), ["/etc/config.pacnew"]);
    assert_eq!(warnings.len(), 1);
    assert_eq!(
        rejection(
            fixture
                .root
                .preview(&ConfigSelection::parse("/etc/unsafe/config.pacnew").unwrap())
        ),
        Some("validation_error")
    );
}

#[test]
fn an_unwalked_orphan_pacsave_does_not_make_the_scan_look_complete() {
    let fixture = Fixture::new("pacsave", None, "saved");
    fs::remove_file(fixture.path.join("config.pacsave")).unwrap();
    let directory = fixture.path.join("unsafe");
    create_config_dir(&directory).unwrap();
    write_config(
        directory.join("orphan.pacsave"),
        "saved local configuration",
    )
    .unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o777)).unwrap();

    let (files, warnings) = fixture.root.discover_within(1).unwrap();

    assert!(files.is_empty());
    assert_eq!(warnings.len(), 1);
    assert_eq!(
        fs::read_to_string(directory.join("orphan.pacsave")).unwrap(),
        "saved local configuration"
    );
}

#[test]
fn symlinked_directories_are_not_followed() {
    let fixture = Fixture::new("pacnew", Some("old"), "new");
    create_config_dir(fixture.path.join("safe")).unwrap();
    write_config(fixture.path.join("safe/config.pacnew"), "new").unwrap();
    assert!(
        fixture
            .root
            .preview(&ConfigSelection::parse("/etc/safe/config.pacnew").unwrap())
            .is_ok()
    );
    symlink("safe", fixture.path.join("redirect")).unwrap();
    assert_eq!(
        rejection(
            fixture
                .root
                .preview(&ConfigSelection::parse("/etc/redirect/config.pacnew").unwrap())
        ),
        Some("validation_error")
    );
}

#[test]
fn unprivileged_discovery_skips_unreadable_directories_quietly() {
    let fixture = Fixture::new("pacnew", Some("old"), "new");
    create_config_dir(fixture.path.join("private")).unwrap();
    write_config(fixture.path.join("private/secret.pacnew"), "new").unwrap();
    fs::set_permissions(
        fixture.path.join("private"),
        fs::Permissions::from_mode(0o000),
    )
    .unwrap();
    let (files, warnings) = fixture.root.discover().unwrap();
    fs::set_permissions(
        fixture.path.join("private"),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    assert!(warnings.is_empty());
    // Root reads the directory regardless of its mode.
    if fixture.root.privileged {
        assert_eq!(
            paths(&files),
            ["/etc/config.pacnew", "/etc/private/secret.pacnew"]
        );
    } else {
        assert_eq!(paths(&files), ["/etc/config.pacnew"]);
    }
}

#[test]
fn the_file_limit_is_reported_once_and_only_when_entries_were_skipped() {
    let fixture = Fixture::new("pacnew", Some("old"), "new");
    create_config_dir(fixture.path.join("a")).unwrap();
    create_config_dir(fixture.path.join("a/b")).unwrap();
    write_config(fixture.path.join("a/b/x"), "").unwrap();
    // config, config.pacnew, a, a/b and a/b/x
    assert_eq!(fixture.root.discover_within(4).unwrap().1.len(), 1);
    assert!(fixture.root.discover_within(5).unwrap().1.is_empty());
}

#[test]
fn directories_past_the_depth_limit_are_reported_once() {
    let fixture = Fixture::new("pacnew", Some("old"), "new");
    let mut deep = fixture.path.clone();
    for _ in 0..MAX_SCAN_DEPTH + 2 {
        deep.push("d");
        create_config_dir(&deep).unwrap();
    }
    write_config(deep.join("deep.pacnew"), "new").unwrap();
    let (files, warnings) = fixture.root.discover().unwrap();
    assert_eq!(paths(&files), ["/etc/config.pacnew"]);
    assert_eq!(warnings.len(), 1);
}

#[test]
fn non_utf8_names_are_skipped_with_a_warning() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    let fixture = Fixture::new("pacnew", Some("old"), "new");
    write_config(
        fixture.path.join(OsStr::from_bytes(b"bad\xff.pacnew")),
        "new",
    )
    .unwrap();
    let (files, warnings) = fixture.root.discover().unwrap();
    assert_eq!(paths(&files), ["/etc/config.pacnew"]);
    assert_eq!(warnings.len(), 1);
}

#[test]
fn discovery_ignores_the_backup_directory() {
    let fixture = Fixture::new("pacnew", Some("old"), "new");
    create_config_dir(fixture.path.join(BACKUP_DIRECTORY)).unwrap();
    write_config(
        fixture.path.join(BACKUP_DIRECTORY).join("old.pacnew"),
        "old",
    )
    .unwrap();
    assert_eq!(
        paths(&fixture.root.discover().unwrap().0),
        ["/etc/config.pacnew"]
    );
}

#[test]
fn preview_rejects_leaf_symlinks_hardlinks_and_fifos() {
    let fixture = Fixture::new("pacnew", Some("old"), "new");
    fs::remove_file(fixture.path.join("config.pacnew")).unwrap();
    symlink("config", fixture.path.join("config.pacnew")).unwrap();
    assert_eq!(
        rejection(fixture.root.preview(&fixture.selection)),
        Some("validation_error")
    );
    fs::remove_file(fixture.path.join("config.pacnew")).unwrap();
    fs::hard_link(
        fixture.path.join("config"),
        fixture.path.join("config.pacnew"),
    )
    .unwrap();
    assert_eq!(
        rejection(fixture.root.preview(&fixture.selection)),
        Some("validation_error")
    );
    fs::remove_file(fixture.path.join("config.pacnew")).unwrap();
    let fifo = CString::new(fixture.path.join("config.pacnew").to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    assert_eq!(
        rejection(fixture.root.preview(&fixture.selection)),
        Some("validation_error")
    );
}

#[test]
fn preview_limits_content_and_rejects_binary_or_non_utf8() {
    let fixture = Fixture::new("pacnew", Some("old"), "new");
    for bytes in [vec![b'x'; MAX_CONTENT_BYTES + 1], vec![b'x', 0], vec![0xff]] {
        write_config(fixture.path.join("config.pacnew"), bytes).unwrap();
        assert_eq!(
            rejection(fixture.root.preview(&fixture.selection)),
            Some("validation_error")
        );
    }
}

#[test]
fn writable_current_or_pending_files_are_not_previewed_or_resolved() {
    for (name, mode) in [("config", 0o660), ("config.pacnew", 0o622)] {
        let fixture = Fixture::new("pacnew", Some("old"), "new");
        let request = fixture.request(PacnewResolution::UsePending);
        fs::set_permissions(fixture.path.join(name), fs::Permissions::from_mode(mode)).unwrap();
        assert_eq!(
            rejection(fixture.root.preview(&fixture.selection)),
            Some("validation_error")
        );
        assert_eq!(
            rejection(fixture.root.resolve(&fixture.selection, &request)),
            Some("validation_error")
        );
        fixture.assert_untouched();
    }
}

#[test]
fn non_owner_current_or_pending_files_are_rejected() {
    // A non-root test process cannot change ownership to another uid.
    if unsafe { libc::geteuid() } != 0 {
        return;
    }
    for name in ["config", "config.pacnew"] {
        let fixture = Fixture::new("pacnew", Some("old"), "new");
        let request = fixture.request(PacnewResolution::UsePending);
        let file = File::open(fixture.path.join(name)).unwrap();
        assert_eq!(
            unsafe { libc::fchown(file.as_raw_fd(), 123456, u32::MAX) },
            0
        );
        assert_eq!(
            rejection(fixture.root.preview(&fixture.selection)),
            Some("validation_error")
        );
        assert_eq!(
            rejection(fixture.root.resolve(&fixture.selection, &request)),
            Some("validation_error")
        );
        fixture.assert_untouched();
    }
}

#[test]
fn using_the_pending_file_takes_its_metadata_and_backs_up_both_versions() {
    let fixture = Fixture::new("pacnew", Some("old\n"), "new\n");
    fs::set_permissions(
        fixture.path.join("config"),
        fs::Permissions::from_mode(0o640),
    )
    .unwrap();
    set_attr(
        fixture.path.join("config"),
        "user.cockpit-pacman-test",
        b"current",
    );
    set_attr(
        fixture.path.join("config.pacnew"),
        "user.cockpit-pacman-test",
        b"pending",
    );
    let result = fixture
        .root
        .resolve(
            &fixture.selection,
            &fixture.request(PacnewResolution::UsePending),
        )
        .unwrap();
    assert!(result.warnings.is_empty());
    assert_eq!(fixture.read("config"), "new\n");
    assert!(!fixture.path.join("config.pacnew").exists());
    assert_eq!(result.backup_paths.len(), 2);
    assert!(
        result
            .backup_paths
            .iter()
            .all(|path| path.starts_with(&format!("/etc/{BACKUP_DIRECTORY}/")))
    );
    let current = fixture.backup(&result.backup_paths[0]);
    let pending = fixture.backup(&result.backup_paths[1]);
    assert_eq!(fs::read_to_string(&current).unwrap(), "old\n");
    assert_eq!(fs::read_to_string(&pending).unwrap(), "new\n");
    let metadata = |path: &Path| {
        (
            fs::metadata(path).unwrap().mode() & 0o7777,
            attrs(path)
                .into_iter()
                .map(|(_, value)| value)
                .collect::<Vec<_>>(),
        )
    };
    assert_eq!(
        metadata(&fixture.path.join("config")),
        (0o600, vec![b"pending".to_vec()])
    );
    assert_eq!(metadata(&current), (0o640, vec![b"current".to_vec()]));
    assert_eq!(metadata(&pending), (0o600, vec![b"pending".to_vec()]));
    fixture.assert_no_temporary_files();
}

#[test]
fn long_ascii_and_unicode_filenames_are_resolved_and_backed_up() {
    for current_name in ["a".repeat(240), "配置".repeat(40)] {
        let mut fixture = Fixture::new("pacnew", Some("old"), "new");
        let pending_name = format!("{current_name}.pacnew");
        fs::rename(
            fixture.path.join("config"),
            fixture.path.join(&current_name),
        )
        .unwrap();
        fs::rename(
            fixture.path.join("config.pacnew"),
            fixture.path.join(&pending_name),
        )
        .unwrap();
        fixture.selection = ConfigSelection::parse(&format!("/etc/{pending_name}")).unwrap();
        let request = fixture.request(PacnewResolution::UsePending);
        let result = fixture.root.resolve(&fixture.selection, &request).unwrap();
        assert_eq!(fixture.read(&current_name), "new");
        assert!(!fixture.path.join(&pending_name).exists());
        assert_eq!(result.backup_paths.len(), 2);
        for (backup, expected) in result.backup_paths.iter().zip(["old", "new"]) {
            let path = fixture.backup(backup);
            assert!(path.file_name().unwrap().len() <= 255);
            assert_eq!(fs::read_to_string(path).unwrap(), expected);
        }
        fixture.assert_no_temporary_files();
    }
}

#[test]
fn saving_a_merge_keeps_the_local_files_metadata() {
    for (kind, local) in [("pacnew", "config"), ("pacsave", "config.pacsave")] {
        let fixture = Fixture::new(kind, Some("old\n"), "new\n");
        fs::set_permissions(fixture.path.join(local), fs::Permissions::from_mode(0o640)).unwrap();
        set_attr(
            fixture.path.join(local),
            "user.cockpit-pacman-test",
            b"local",
        );
        let mut request = fixture.request(PacnewResolution::SaveMerged);
        request.merged_content = Some("merged\n".into());
        let result = fixture.root.resolve(&fixture.selection, &request).unwrap();
        assert_eq!(fixture.read("config"), "merged\n");
        assert_eq!(
            fs::metadata(fixture.path.join("config")).unwrap().mode() & 0o7777,
            0o640
        );
        assert_eq!(
            attrs(fixture.path.join("config")),
            vec![(b"user.cockpit-pacman-test".to_vec(), b"local".to_vec())]
        );
        assert_eq!(result.backup_paths.len(), 2);
    }
}

#[test]
fn unchanged_copies_keep_their_source_mtime() {
    let fixture = Fixture::new("pacnew", Some("old"), "new");
    let packaged = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
    File::options()
        .write(true)
        .open(fixture.path.join("config.pacnew"))
        .unwrap()
        .set_modified(packaged)
        .unwrap();
    let request = fixture.request(PacnewResolution::UsePending);
    let result = fixture.root.resolve(&fixture.selection, &request).unwrap();
    let mtime = |path: PathBuf| fs::metadata(path).unwrap().modified().unwrap();
    assert_eq!(mtime(fixture.path.join("config")), packaged);
    assert_eq!(mtime(fixture.backup(&result.backup_paths[1])), packaged);

    let fixture = Fixture::new("pacnew", Some("old"), "new");
    File::options()
        .write(true)
        .open(fixture.path.join("config"))
        .unwrap()
        .set_modified(packaged)
        .unwrap();
    let mut request = fixture.request(PacnewResolution::SaveMerged);
    request.merged_content = Some("merged".into());
    fixture.root.resolve(&fixture.selection, &request).unwrap();
    assert_ne!(mtime(fixture.path.join("config")), packaged);
}

#[test]
fn saving_merge_preserves_exact_text_and_missing_target_uses_pending_metadata() {
    let fixture = Fixture::new("pacsave", None, "saved\n");
    fs::set_permissions(
        fixture.path.join("config.pacsave"),
        fs::Permissions::from_mode(0o640),
    )
    .unwrap();
    let mut request = fixture.request(PacnewResolution::SaveMerged);
    request.merged_content = Some("merged without newline".into());
    let result = fixture.root.resolve(&fixture.selection, &request).unwrap();
    assert_eq!(fixture.read("config"), "merged without newline");
    assert_eq!(
        fs::metadata(fixture.path.join("config")).unwrap().mode() & 0o7777,
        0o640
    );
    assert!(!fixture.path.join("config.pacsave").exists());
    assert_eq!(result.backup_paths.len(), 1);
}

#[test]
fn merged_content_with_nul_or_over_the_limit_is_rejected_without_writes() {
    for merged in ["key=value\0".to_string(), "x".repeat(MAX_CONTENT_BYTES + 1)] {
        let fixture = Fixture::new("pacnew", Some("old"), "new");
        let mut request = fixture.request(PacnewResolution::SaveMerged);
        request.merged_content = Some(merged);
        assert_eq!(
            rejection(fixture.root.resolve(&fixture.selection, &request)),
            Some("validation_error")
        );
        fixture.assert_untouched();
    }
}

fn acl(entries: &[(u16, u16, u32)]) -> Vec<u8> {
    let mut bytes = 2u32.to_le_bytes().to_vec();
    for (tag, permissions, id) in entries {
        bytes.extend(tag.to_le_bytes());
        bytes.extend(permissions.to_le_bytes());
        bytes.extend(id.to_le_bytes());
    }
    bytes
}

#[test]
fn replacement_and_backups_preserve_acl_without_inheriting_other_access() {
    let fixture = Fixture::new("pacnew", Some("old"), "new");
    let undefined = u32::MAX;
    set_attr(
        fixture.path.join("config"),
        "system.posix_acl_access",
        &acl(&[
            (1, 6, undefined),
            (2, 4, 123456),
            (4, 0, undefined),
            (16, 4, undefined),
            (32, 0, undefined),
        ]),
    );
    set_attr(
        &fixture.path,
        "system.posix_acl_default",
        &acl(&[
            (1, 7, undefined),
            (2, 7, 234567),
            (4, 0, undefined),
            (16, 7, undefined),
            (32, 0, undefined),
        ]),
    );
    let expected = attrs(fixture.path.join("config"));
    let mut request = fixture.request(PacnewResolution::SaveMerged);
    request.merged_content = Some("merged".into());
    let result = fixture.root.resolve(&fixture.selection, &request).unwrap();
    assert_eq!(attrs(fixture.path.join("config")), expected);
    assert_eq!(attrs(fixture.backup(&result.backup_paths[0])), expected);
    assert!(attrs(fixture.backup(&result.backup_paths[1])).is_empty());
}

#[test]
fn named_write_acl_is_rejected_on_current_and_pending_files() {
    for filename in ["config", "config.pacnew"] {
        let fixture = Fixture::new("pacnew", Some("old"), "new");
        let request = fixture.request(PacnewResolution::KeepCurrent);
        let undefined = u32::MAX;
        set_attr(
            fixture.path.join(filename),
            "system.posix_acl_access",
            &acl(&[
                (1, 6, undefined),
                (2, 6, 123456),
                (4, 0, undefined),
                (16, 6, undefined),
                (32, 0, undefined),
            ]),
        );
        assert_ne!(
            fs::metadata(fixture.path.join(filename)).unwrap().mode() & 0o020,
            0
        );
        assert_eq!(
            rejection(fixture.root.preview(&fixture.selection)),
            Some("validation_error")
        );
        assert_eq!(
            rejection(fixture.root.resolve(&fixture.selection, &request)),
            Some("validation_error")
        );
        fixture.assert_untouched();
    }
}

#[test]
fn extended_attribute_changes_invalidate_preview() {
    let fixture = Fixture::new("pacnew", Some("old"), "new");
    let request = fixture.request(PacnewResolution::UsePending);
    set_attr(
        fixture.path.join("config"),
        "user.cockpit-pacman-test",
        b"outside",
    );
    assert_eq!(
        rejection(fixture.root.resolve(&fixture.selection, &request)),
        Some("config_changed")
    );
    assert_eq!(fixture.read("config"), "old");
}

#[test]
fn keeping_current_removes_only_the_pending_file_and_never_recreates_a_missing_one() {
    for (kind, current) in [("pacnew", Some("old")), ("pacsave", None)] {
        let fixture = Fixture::new(kind, current, "pending\n");
        let request = fixture.request(PacnewResolution::KeepCurrent);
        let result = fixture.root.resolve(&fixture.selection, &request).unwrap();
        assert_eq!(
            fs::read_to_string(fixture.path.join("config"))
                .ok()
                .as_deref(),
            current
        );
        assert!(!fixture.path.join(format!("config.{kind}")).exists());
        assert_eq!(result.backup_paths.len(), 1);
        assert_eq!(
            fs::read_to_string(fixture.backup(&result.backup_paths[0])).unwrap(),
            "pending\n"
        );
        assert!(result.warnings.is_empty());
        fixture.assert_no_temporary_files();
    }
}

#[test]
fn stale_content_permissions_pending_or_missing_current_is_rejected_without_writes() {
    for changed in ["current", "pending", "permissions", "absence"] {
        let fixture = Fixture::new(
            "pacnew",
            if changed == "absence" {
                None
            } else {
                Some("old")
            },
            "new",
        );
        let request = fixture.request(PacnewResolution::UsePending);
        match changed {
            "current" => write_config(fixture.path.join("config"), "outside").unwrap(),
            "pending" => write_config(fixture.path.join("config.pacnew"), "outside").unwrap(),
            "permissions" => fs::set_permissions(
                fixture.path.join("config"),
                fs::Permissions::from_mode(0o400),
            )
            .unwrap(),
            _ => write_config(fixture.path.join("config"), "").unwrap(),
        }
        assert_eq!(
            rejection(fixture.root.resolve(&fixture.selection, &request)),
            Some("config_changed")
        );
        assert!(fixture.backups().is_empty());
        assert!(fixture.path.join("config.pacnew").exists());
    }
}

#[test]
fn pending_removed_after_preview_is_a_stale_configuration() {
    let fixture = Fixture::new("pacnew", Some("old"), "new");
    let request = fixture.request(PacnewResolution::UsePending);
    fs::remove_file(fixture.path.join("config.pacnew")).unwrap();
    assert_eq!(
        rejection(fixture.root.resolve(&fixture.selection, &request)),
        Some("config_changed")
    );
    assert_eq!(fixture.read("config"), "old");
    assert_eq!(
        rejection(fixture.root.preview(&fixture.selection)),
        Some("not_found")
    );
    assert!(fixture.backups().is_empty());
}

#[test]
fn outside_change_after_backups_prevents_publication() {
    let fixture = Fixture::new("pacnew", Some("old"), "new");
    let request = fixture.request(PacnewResolution::UsePending);
    assert_eq!(
        rejection(fixture.root.resolve_with(
            &fixture.selection,
            &request,
            || {
                write_config(fixture.path.join("config"), "outside")?;
                Ok(())
            },
            || Ok(()),
        )),
        Some("config_changed")
    );
    assert_eq!(fixture.read("config"), "outside");
    assert_eq!(fixture.read("config.pacnew"), "new");
    fixture.assert_no_temporary_files();
    assert!(fixture.backups().is_empty());
}

#[test]
fn cleanup_failure_reports_applied_result_and_keeps_pending_and_backups() {
    let fixture = Fixture::new("pacnew", Some("old"), "new");
    let request = fixture.request(PacnewResolution::UsePending);
    let result = fixture
        .root
        .resolve_with(
            &fixture.selection,
            &request,
            || Ok(()),
            || anyhow::bail!("injected cleanup failure"),
        )
        .unwrap();
    assert!(result.success);
    assert_eq!(result.warnings.len(), 1);
    assert_eq!(fixture.read("config"), "new");
    assert_eq!(fixture.read("config.pacnew"), "new");
    assert!(
        result
            .backup_paths
            .iter()
            .all(|path| fixture.backup(path).is_file())
    );
}

#[test]
fn a_failed_cleanup_when_keeping_the_current_file_changes_nothing() {
    let fixture = Fixture::new("pacnew", Some("old"), "new");
    let request = fixture.request(PacnewResolution::KeepCurrent);
    assert!(
        fixture
            .root
            .resolve_with(
                &fixture.selection,
                &request,
                || Ok(()),
                || anyhow::bail!("injected cleanup failure"),
            )
            .is_err()
    );
    fixture.assert_untouched();
}

#[test]
fn changed_pending_after_publication_is_not_removed() {
    let fixture = Fixture::new("pacnew", Some("old"), "new");
    let request = fixture.request(PacnewResolution::UsePending);
    let result = fixture
        .root
        .resolve_with(
            &fixture.selection,
            &request,
            || Ok(()),
            || {
                write_config(fixture.path.join("config.pacnew"), "newer")?;
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(fixture.read("config"), "new");
    assert_eq!(fixture.read("config.pacnew"), "newer");
    assert_eq!(result.warnings.len(), 1);
}

#[test]
fn failed_backup_sync_removes_partial_backup_and_preserves_both_originals() {
    let fixture = Fixture::new("pacnew", Some("old"), "new");
    let source = fixture.root.preview(&fixture.selection).unwrap().pending;
    let error = create_copy_durable(
        &fixture.root.directory,
        "copy",
        source.content.as_bytes(),
        &source,
        |_| Err(io::Error::from(io::ErrorKind::StorageFull)),
    )
    .err()
    .unwrap();
    assert!(is_io_kind(&error, io::ErrorKind::StorageFull));
    assert!(!fs::read_dir(&fixture.path).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("copy.")
    }));
    fixture.assert_untouched();
}

#[test]
fn parent_replacement_after_preview_cannot_redirect_publication() {
    let fixture = Fixture::new("pacnew", Some("old"), "new");
    create_config_dir(fixture.path.join("nested")).unwrap();
    write_config(fixture.path.join("nested/config"), "old").unwrap();
    write_config(fixture.path.join("nested/config.pacnew"), "new").unwrap();
    let selection = ConfigSelection::parse("/etc/nested/config.pacnew").unwrap();
    let request = PacnewResolveRequest {
        path: selection.path(),
        revision: fixture.root.preview(&selection).unwrap().revision(),
        resolution: PacnewResolution::UsePending,
        merged_content: None,
    };
    assert_eq!(
        rejection(fixture.root.resolve_with(
            &selection,
            &request,
            || {
                fs::rename(fixture.path.join("nested"), fixture.path.join("moved"))?;
                create_config_dir(fixture.path.join("nested"))?;
                write_config(fixture.path.join("nested/config"), "outside")?;
                write_config(fixture.path.join("nested/config.pacnew"), "outside new")?;
                Ok(())
            },
            || Ok(()),
        )),
        Some("config_changed")
    );
    assert_eq!(fixture.read("nested/config"), "outside");
    assert_eq!(fixture.read("moved/config"), "old");
    assert!(fixture.backups().is_empty());
}

#[test]
fn parent_replacement_before_cleanup_keeps_the_pending_file() {
    let fixture = Fixture::new("pacnew", Some("old"), "new");
    create_config_dir(fixture.path.join("nested")).unwrap();
    write_config(fixture.path.join("nested/config"), "old").unwrap();
    write_config(fixture.path.join("nested/config.pacnew"), "new").unwrap();
    let selection = ConfigSelection::parse("/etc/nested/config.pacnew").unwrap();
    let request = PacnewResolveRequest {
        path: selection.path(),
        revision: fixture.root.preview(&selection).unwrap().revision(),
        resolution: PacnewResolution::UsePending,
        merged_content: None,
    };
    let result = fixture
        .root
        .resolve_with(
            &selection,
            &request,
            || Ok(()),
            || {
                fs::rename(fixture.path.join("nested"), fixture.path.join("moved"))?;
                create_config_dir(fixture.path.join("nested"))?;
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(result.warnings.len(), 1);
    assert_eq!(fixture.read("moved/config"), "new");
    assert_eq!(fixture.read("moved/config.pacnew"), "new");
    assert!(
        result
            .backup_paths
            .iter()
            .all(|path| fixture.backup(path).is_file())
    );
}
