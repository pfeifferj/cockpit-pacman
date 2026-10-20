mod filesystem;

use alpm::Alpm;
use anyhow::{Context, Result};
use std::collections::HashSet;
use std::io::{self, Read};
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::time::Duration;

use crate::alpm::{TransactionGuard, get_handle, resolve_file_owners};
use crate::models::{InvalidInput, PacnewFile, PacnewPreview, PacnewResolveRequest, PacnewStatus};
use crate::util::{emit_json, with_file_lock_timeout};

use filesystem::{ConfigRoot, ConfigSelection, MAX_CONTENT_BYTES};

fn require_root() -> Result<()> {
    if unsafe { libc::geteuid() } != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Administrative access is required",
        )
        .into());
    }
    Ok(())
}

fn assign_owners(handle: &Alpm, files: &mut [PacnewFile]) {
    let current_path = |file: &PacnewFile| {
        ConfigSelection::parse(&file.path)
            .ok()
            .map(|selection| selection.current_path())
    };
    let owners = resolve_file_owners(handle, &files.iter().filter_map(current_path).collect());
    for file in files.iter_mut() {
        file.package = current_path(file).and_then(|path| owners.get(&path).cloned());
    }
}

fn pending_backups(handle: &Alpm, root: &Path, listed: &[PacnewFile]) -> Vec<PacnewFile> {
    let mut seen: HashSet<String> = listed.iter().map(|file| file.path.clone()).collect();
    let mut files = Vec::new();
    for pkg in handle.localdb().pkgs() {
        for backup in pkg.backup() {
            for kind in ["pacnew", "pacsave"] {
                let path = root.join(format!("{}.{kind}", backup.name()));
                if let Ok(metadata) = std::fs::symlink_metadata(&path)
                    && metadata.is_file()
                    && seen.insert(path.to_string_lossy().into_owned())
                {
                    files.push(PacnewFile {
                        path: path.to_string_lossy().into_owned(),
                        package: Some(pkg.name().to_string()),
                        kind: kind.to_string(),
                        mtime: metadata.mtime(),
                    });
                }
            }
        }
    }
    files
}

pub fn get_pacnew_status() -> Result<()> {
    let root = ConfigRoot::open(Path::new("/etc"), 0)?;
    let (mut files, mut warnings) = root.discover()?;
    match get_handle() {
        Ok(handle) => {
            assign_owners(&handle, &mut files);
            let backups = pending_backups(&handle, Path::new("/"), &files);
            files.extend(backups);
            files.sort_by(|a, b| a.path.cmp(&b.path));
        }
        Err(_) => {
            warnings.push("Package names could not be read from the package database.".into())
        }
    }
    emit_json(&PacnewStatus {
        has_pacnew: !files.is_empty(),
        files,
        warnings: (!warnings.is_empty()).then_some(warnings),
    })
}

pub fn preview_pacnew(path: &str) -> Result<()> {
    require_root()?;
    let selection = ConfigSelection::parse(path)?;
    let root = ConfigRoot::open(Path::new("/etc"), 0)?;
    let pair = root.preview(&selection)?;
    emit_json(&PacnewPreview {
        path: path.to_string(),
        current_path: selection.current_path(),
        kind: selection.kind.to_string(),
        revision: pair.revision(),
        current_content: pair.current.map(|snapshot| snapshot.content),
        pending_content: pair.pending.content,
    })
}

fn read_request(reader: impl Read) -> Result<PacnewResolveRequest> {
    let mut body = Vec::new();
    // JSON escaping can expand one UTF-8 byte to six ASCII bytes.
    let limit = MAX_CONTENT_BYTES * 6 + 8192;
    reader.take((limit + 1) as u64).read_to_end(&mut body)?;
    if body.len() > limit {
        return Err(InvalidInput("Configuration request is too large".into()).into());
    }
    serde_json::from_slice(&body)
        .map_err(|error| InvalidInput(format!("Invalid configuration request: {error}")).into())
}

enum WriterLock<'a> {
    File(&'a str),
    Accounts,
}

fn writer_lock(current_path: &str) -> Option<WriterLock<'static>> {
    match current_path {
        "/etc/pacman.conf" => Some(WriterLock::File(super::repos::LOCK_PATH)),
        "/etc/pacman.d/mirrorlist" => Some(WriterLock::File(super::mirrors::LOCK_PATH)),
        "/etc/passwd" | "/etc/shadow" | "/etc/group" | "/etc/gshadow" | "/etc/subuid"
        | "/etc/subgid" => Some(WriterLock::Accounts),
        _ => None,
    }
}

const ACCOUNT_LOCK_PATH: &str = "/etc/.pwd.lock";

// The lock glibc's lckpwdf takes and shadow-utils honours. lckpwdf itself
// waits up to 15 s, so the same record lock is polled here instead.
struct AccountLock {
    _file: std::fs::File,
}
impl AccountLock {
    fn acquire(path: &Path, timeout: Duration) -> Result<Self> {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::OpenOptionsExt;

        let file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(path)
            .context("Could not open the account database lock")?;
        let mut lock: libc::flock = unsafe { std::mem::zeroed() };
        lock.l_type = libc::F_WRLCK as libc::c_short;
        lock.l_whence = libc::SEEK_SET as libc::c_short;
        let started = std::time::Instant::now();
        loop {
            if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETLK, &lock) } == 0 {
                return Ok(Self { _file: file });
            }
            let error = io::Error::last_os_error();
            if !matches!(error.raw_os_error(), Some(libc::EAGAIN | libc::EACCES)) {
                return Err(error).context("Could not lock the account databases");
            }
            if started.elapsed() >= timeout {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Timed out waiting for the account database lock; try again when the other program finishes",
                )
                .into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

fn with_writer_lock<R>(
    lock: Option<WriterLock<'_>>,
    timeout: Duration,
    resolve: impl FnOnce() -> Result<R>,
) -> Result<R> {
    match lock {
        Some(WriterLock::File(lock)) => with_file_lock_timeout(Path::new(lock), timeout, resolve),
        Some(WriterLock::Accounts) => {
            let _accounts = AccountLock::acquire(Path::new(ACCOUNT_LOCK_PATH), timeout)?;
            resolve()
        }
        None => resolve(),
    }
}

pub fn resolve_pacnew() -> Result<()> {
    require_root()?;
    let request = read_request(std::io::stdin())?;
    let selection = ConfigSelection::parse(&request.path)?;
    let root = ConfigRoot::open(Path::new("/etc"), 0)?;
    crate::util::setup_signal_handler()?;
    let resolve = || {
        let mut handle = get_handle()?;
        // Pacman must not replace either file between the final check and cleanup.
        let _transaction = TransactionGuard::new(&mut handle, alpm::TransFlag::NONE)?;
        root.resolve(&selection, &request)
    };
    let response = with_writer_lock(
        writer_lock(&selection.current_path()),
        Duration::from_secs(2),
        resolve,
    )?;
    emit_json(&response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_or_non_utf8_requests_are_validation_errors() {
        for body in [
            b"{".as_slice(),
            b"\xff",
            b"{}",
            b"{\"resolution\":\"unknown\"}",
        ] {
            let error = read_request(body).err().expect("invalid input");
            assert_eq!(
                crate::util::classify_error(&error),
                Some("validation_error")
            );
        }
    }

    #[test]
    fn oversized_requests_are_bounded_and_classified() {
        let body = io::repeat(b' ').take((MAX_CONTENT_BYTES * 6 + 8193) as u64);
        let error = read_request(body).err().expect("oversized input");
        assert_eq!(
            crate::util::classify_error(&error),
            Some("validation_error")
        );
    }

    #[test]
    fn merged_text_keeps_its_original_bytes() {
        let body = br#"{"path":"/etc/example.pacnew","revision":"pair","resolution":"save_merged","merged_content":"key=value\r\n"}"#;
        let request = read_request(body.as_slice()).expect("valid request");
        assert_eq!(request.merged_content.as_deref(), Some("key=value\r\n"));
    }

    #[test]
    fn files_with_their_own_writers_take_those_writers_locks() {
        assert!(matches!(
            writer_lock("/etc/pacman.conf"),
            Some(WriterLock::File(lock)) if lock == crate::handlers::repos::LOCK_PATH
        ));
        assert!(matches!(
            writer_lock("/etc/pacman.d/mirrorlist"),
            Some(WriterLock::File(lock)) if lock == crate::handlers::mirrors::LOCK_PATH
        ));
        for path in ["/etc/shadow", "/etc/subuid", "/etc/subgid"] {
            assert!(matches!(writer_lock(path), Some(WriterLock::Accounts)));
        }
        assert!(writer_lock("/etc/ssh/sshd_config").is_none());
    }

    struct Root(std::path::PathBuf);
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn waiting_for_a_config_writer_does_not_lock_the_package_database() {
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};

        let root = Root(
            std::env::temp_dir().join(format!("cpac-pacnew-writer-lock-{}", std::process::id())),
        );
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&root.0)
            .unwrap();
        let database = root.0.join("db");
        std::fs::create_dir_all(database.join("local")).unwrap();
        let mut handle = Alpm::new(root.0.to_str().unwrap(), database.to_str().unwrap()).unwrap();
        let lock = root.0.join("config.lock");
        let held = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&lock)
            .unwrap();
        held.lock().unwrap();
        let entered = std::cell::Cell::new(false);
        let error = with_writer_lock(
            Some(WriterLock::File(lock.to_str().unwrap())),
            Duration::from_millis(20),
            || {
                entered.set(true);
                let _transaction = TransactionGuard::new(&mut handle, alpm::TransFlag::NONE)?;
                Ok(())
            },
        )
        .unwrap_err();
        assert_eq!(crate::util::classify_error(&error), Some("timeout"));
        assert!(!entered.get());
        assert!(!database.join("db.lck").exists());
        held.unlock().unwrap();
        with_writer_lock(
            Some(WriterLock::File(lock.to_str().unwrap())),
            Duration::ZERO,
            || {
                let _transaction = TransactionGuard::new(&mut handle, alpm::TransFlag::NONE)?;
                assert!(database.join("db.lck").exists());
                assert!(matches!(
                    std::fs::File::open(&lock)?.try_lock_shared(),
                    Err(std::fs::TryLockError::WouldBlock)
                ));
                Ok(())
            },
        )
        .unwrap();
        assert!(!database.join("db.lck").exists());
    }

    #[test]
    fn the_account_lock_gives_up_after_its_timeout() {
        use std::os::fd::AsRawFd;

        let root =
            Root(std::env::temp_dir().join(format!("cpac-pacnew-accounts-{}", std::process::id())));
        std::fs::create_dir(&root.0).unwrap();
        let path = root.0.join(".pwd.lock");
        let holder = std::fs::File::create(&path).unwrap();
        // An open file description lock conflicts with the record lock even within one process.
        let mut lock: libc::flock = unsafe { std::mem::zeroed() };
        lock.l_type = libc::F_WRLCK as libc::c_short;
        lock.l_whence = libc::SEEK_SET as libc::c_short;
        assert_eq!(
            unsafe { libc::fcntl(holder.as_raw_fd(), libc::F_OFD_SETLK, &lock) },
            0
        );
        let started = std::time::Instant::now();
        let error = AccountLock::acquire(&path, Duration::from_millis(50))
            .err()
            .expect("held lock");
        assert_eq!(crate::util::classify_error(&error), Some("timeout"));
        assert!(started.elapsed() < Duration::from_secs(2));
        drop(holder);
        AccountLock::acquire(&path, Duration::ZERO).unwrap();
    }

    #[test]
    fn owners_follow_the_current_path_and_unwalked_backups_are_listed() {
        let root =
            Root(std::env::temp_dir().join(format!("cpac-pacnew-status-{}", std::process::id())));
        let package = root.0.join("db/local/widget-1-1");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::create_dir_all(root.0.join("db/sync")).unwrap();
        std::fs::write(root.0.join("db/local/ALPM_DB_VERSION"), "9\n").unwrap();
        std::fs::write(
            package.join("desc"),
            "%NAME%\nwidget\n\n%VERSION%\n1-1\n\n%ARCH%\nany\n\n%REASON%\n0\n\n",
        )
        .unwrap();
        std::fs::write(
            package.join("files"),
            "%FILES%\netc/\netc/example.conf\nvar/lib/widget/state\n\n\
             %BACKUP%\netc/example.conf\td41d8cd98f00b204e9800998ecf8427e\n\
             var/lib/widget/state\td41d8cd98f00b204e9800998ecf8427e\n\n",
        )
        .unwrap();
        let handle = Alpm::new(
            root.0.to_str().unwrap(),
            root.0.join("db").to_str().unwrap(),
        )
        .unwrap();
        let file = |path: &str| PacnewFile {
            path: path.into(),
            package: None,
            kind: "pacnew".into(),
            mtime: 0,
        };
        let mut files = [
            file("/etc/example.conf.pacnew"),
            file("/etc/unowned.conf.pacnew"),
        ];
        assign_owners(&handle, &mut files);
        assert_eq!(files[0].package.as_deref(), Some("widget"));
        assert_eq!(files[1].package, None);

        assert!(pending_backups(&handle, &root.0, &[]).is_empty());
        std::fs::create_dir_all(root.0.join("var/lib/widget")).unwrap();
        std::fs::write(root.0.join("var/lib/widget/state.pacnew"), "new").unwrap();
        std::fs::create_dir_all(root.0.join("etc")).unwrap();
        let in_etc = root.0.join("etc/example.conf.pacnew");
        std::fs::write(&in_etc, "new").unwrap();
        let found = pending_backups(&handle, &root.0, &[]);
        assert_eq!(
            found.iter().map(|f| Path::new(&f.path)).collect::<Vec<_>>(),
            [
                in_etc.as_path(),
                &root.0.join("var/lib/widget/state.pacnew")
            ]
        );
        assert!(
            found
                .iter()
                .all(|f| f.package.as_deref() == Some("widget") && f.kind == "pacnew")
        );
        let walked = file(in_etc.to_str().unwrap());
        assert_eq!(pending_backups(&handle, &root.0, &[walked]).len(), 1);
    }
}
