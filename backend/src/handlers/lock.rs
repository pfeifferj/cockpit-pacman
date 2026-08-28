use anyhow::Result;
use serde::Serialize;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use ts_rs::TS;

use crate::util::emit_json;

#[derive(Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct LockStatus {
    pub locked: bool,
    pub stale: bool,
    pub lock_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub blocking_process: Option<String>,
    pub holder_unknown: bool,
}

#[derive(Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct LockRemoveResult {
    pub removed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

fn db_path() -> PathBuf {
    PathBuf::from(
        pacmanconf::Config::new()
            .ok()
            .map(|c| c.db_path)
            .unwrap_or_else(|| "/var/lib/pacman/".to_string()),
    )
}

enum Holder {
    Process(String),
    None,
    Unknown,
}

fn scan_error_hides_a_holder(e: &std::io::Error) -> bool {
    e.kind() != std::io::ErrorKind::NotFound
}

fn find_lock_holder(lock: &Path) -> Holder {
    let Ok(meta) = fs::metadata(lock) else {
        return Holder::Unknown;
    };
    let target = (meta.dev(), meta.ino());

    let Ok(entries) = fs::read_dir("/proc") else {
        return Holder::Unknown;
    };

    let mut hidden_from_us = false;
    for entry in entries {
        let Ok(entry) = entry else {
            hidden_from_us = true;
            continue;
        };
        let name = entry.file_name();
        let Some(pid) = name.to_str() else {
            hidden_from_us = true;
            continue;
        };
        if !pid.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let fds = match fs::read_dir(entry.path().join("fd")) {
            Ok(fds) => fds,
            Err(e) => {
                hidden_from_us |= scan_error_hides_a_holder(&e);
                continue;
            }
        };
        for fd in fds {
            let Ok(fd) = fd else {
                hidden_from_us = true;
                continue;
            };
            match fs::metadata(fd.path()) {
                Ok(m) if (m.dev(), m.ino()) == target => {
                    let comm = fs::read_to_string(entry.path().join("comm"))
                        .unwrap_or_default()
                        .trim()
                        .to_string();
                    return Holder::Process(format!("{} (pid {})", comm, pid));
                }
                Ok(_) => {}
                Err(e) => hidden_from_us |= scan_error_hides_a_holder(&e),
            }
        }
    }

    if hidden_from_us {
        Holder::Unknown
    } else {
        Holder::None
    }
}

/// Identify a specific file instance: (dev, ino, ctime_secs, ctime_nsec). ctime
/// is included so a same-path replacement that happens to reuse the inode is
/// still detected as a different instance.
fn lock_identity(path: &Path) -> Option<(u64, u64, i64, i64)> {
    let m = fs::metadata(path).ok()?;
    Some((m.dev(), m.ino(), m.ctime(), m.ctime_nsec()))
}

pub fn check_lock() -> Result<()> {
    let db = db_path();
    let lock = db.join("db.lck");
    let locked = lock.exists();

    // A failed resolve can't match the holder's /proc fd, so don't report stale.
    let canonical = if locked {
        lock.canonicalize().ok()
    } else {
        None
    };

    let (blocking, holder_unknown) = match canonical.as_deref().map(find_lock_holder) {
        Some(Holder::Process(name)) => (Some(name), false),
        Some(Holder::None) => (None, false),
        Some(Holder::Unknown) => (None, true),
        None => (None, locked),
    };

    emit_json(&LockStatus {
        locked,
        stale: canonical.is_some() && blocking.is_none() && !holder_unknown,
        lock_path: lock.to_string_lossy().to_string(),
        blocking_process: blocking,
        holder_unknown,
    })
}

/// Remove db.lck only if no process holds it open. Ok(true) if removed,
/// Ok(false) if no lock existed, Err with the refusal reason otherwise.
pub(crate) fn try_remove_stale_lock() -> Result<bool, String> {
    remove_if_holderless(&db_path().join("db.lck"), find_lock_holder)
}

fn remove_if_holderless(lock: &Path, scan: impl Fn(&Path) -> Holder) -> Result<bool, String> {
    if !lock.exists() {
        return Ok(false);
    }

    // Match and remove the same canonical path; a failed resolve refuses
    // removal rather than deleting a lock we can't verify.
    let canonical = lock
        .canonicalize()
        .map_err(|e| format!("Could not resolve lock file: {}", e))?;

    let before = lock_identity(&canonical).ok_or("Could not stat lock file")?;

    match scan(&canonical) {
        Holder::Process(proc) => return Err(format!("Database in use by {}", proc)),
        Holder::Unknown => {
            return Err(
                "Could not determine whether the database is in use; not removing".to_string(),
            );
        }
        Holder::None => {}
    }

    // db.lck is an O_EXCL presence lock: it can't be acquired while it exists, so
    // an unchanged identity from inspection to here proves it was never released
    // and re-taken, i.e. genuinely stale. A live lock only reaches this path if
    // the stale file was replaced by a new instance, which a changed identity
    // catches. The remaining stat->unlink gap is an accepted micro-window (a
    // path-based unlink can't be made conditional on inode).
    if lock_identity(&canonical) != Some(before) {
        return Err(
            "Lock file changed during check; not removing (a process may have taken the lock)"
                .to_string(),
        );
    }

    fs::remove_file(&canonical).map_err(|e| format!("Failed to remove lock file: {}", e))?;
    Ok(true)
}

pub fn remove_stale_lock() -> Result<()> {
    let result = match try_remove_stale_lock() {
        Ok(true) => {
            crate::util::journal_note(
                "cleared stale pacman database lock: a package transaction was interrupted \
                 before it could finish",
            );
            LockRemoveResult {
                removed: true,
                error: None,
            }
        }
        Ok(false) => LockRemoveResult {
            removed: false,
            error: Some("No lock file exists".to_string()),
        },
        Err(e) => LockRemoveResult {
            removed: false,
            error: Some(e),
        },
    };
    emit_json(&result)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::{
        Holder, find_lock_holder, lock_identity, remove_if_holderless, scan_error_hides_a_holder,
    };
    use std::fs::File;

    #[test]
    fn only_a_vanished_process_proves_it_is_not_the_holder() {
        use std::io::{Error, ErrorKind};

        assert!(!scan_error_hides_a_holder(&Error::from(
            ErrorKind::NotFound
        )));

        for kind in [
            ErrorKind::PermissionDenied,
            ErrorKind::OutOfMemory,
            ErrorKind::Other,
        ] {
            assert!(
                scan_error_hides_a_holder(&Error::from(kind)),
                "{kind:?} leaves the scan unable to tell"
            );
        }
    }

    #[test]
    fn try_remove_reaps_only_a_holderless_lock() {
        let path = std::env::temp_dir().join(format!("db-lck-reap-{}", std::process::id()));

        assert_eq!(remove_if_holderless(&path, find_lock_holder), Ok(false));

        let file = File::create(&path).unwrap();
        let err = remove_if_holderless(&path, find_lock_holder).unwrap_err();
        assert!(err.contains(&format!("(pid {})", std::process::id())));
        assert!(path.exists(), "a held lock must not be removed");

        drop(file);
        assert_eq!(remove_if_holderless(&path, |_| Holder::None), Ok(true));
        assert!(!path.exists(), "a holderless lock must be removed");
    }

    #[test]
    fn finds_a_holder_that_opened_the_lock_by_another_path() {
        let path = std::env::temp_dir().join(format!("db-lck-alias-{}", std::process::id()));
        let alias = std::env::temp_dir().join(format!("db-lck-alias-{}-2", std::process::id()));
        File::create(&path).unwrap();
        std::fs::hard_link(&path, &alias).unwrap();

        let held = File::open(&alias).unwrap();
        let found = find_lock_holder(&path.canonicalize().unwrap());

        drop(held);
        std::fs::remove_file(&alias).unwrap();
        std::fs::remove_file(&path).unwrap();
        match found {
            Holder::Process(name) => {
                assert!(name.contains(&format!("(pid {})", std::process::id())))
            }
            _ => panic!("a holder that opened the same file by another path must still be found"),
        }
    }

    #[test]
    fn a_scan_that_saw_nothing_is_not_a_holderless_lock() {
        let path = std::env::temp_dir().join(format!("db-lck-blind-{}", std::process::id()));
        File::create(&path).unwrap();

        let err = remove_if_holderless(&path, |_| Holder::Unknown).unwrap_err();

        assert!(err.contains("Could not determine"));
        assert!(
            path.exists(),
            "a lock that could not be checked must survive"
        );
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn lock_identity_detects_replacement() {
        let path = std::env::temp_dir().join(format!("db-lck-id-{}", std::process::id()));

        File::create(&path).unwrap();
        let id1 = lock_identity(&path);
        assert!(id1.is_some());

        std::fs::remove_file(&path).unwrap();
        // Ensure the clock advances so ctime differs even if the inode is reused.
        std::thread::sleep(std::time::Duration::from_millis(10));
        File::create(&path).unwrap();
        let id2 = lock_identity(&path);
        assert!(id2.is_some());
        assert_ne!(id1, id2, "a replaced file must have a different identity");

        std::fs::remove_file(&path).unwrap();
        assert_eq!(lock_identity(&path), None);
    }

    #[test]
    fn lock_identity_stable_for_same_file() {
        let path = std::env::temp_dir().join(format!("db-lck-stable-{}", std::process::id()));
        File::create(&path).unwrap();

        assert_eq!(lock_identity(&path), lock_identity(&path));

        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn reports_only_the_process_holding_the_lock_file_open() {
        let path = std::env::temp_dir().join(format!("db-lck-test-{}", std::process::id()));
        let file = File::create(&path).unwrap();
        let canonical = path.canonicalize().unwrap();

        match find_lock_holder(&canonical) {
            Holder::Process(name) => {
                assert!(name.contains(&format!("(pid {})", std::process::id())))
            }
            _ => panic!("the scan must name the process holding the file open"),
        }

        drop(file);
        assert!(!matches!(find_lock_holder(&canonical), Holder::Process(_)));
        std::fs::remove_file(&path).unwrap();
    }
}
