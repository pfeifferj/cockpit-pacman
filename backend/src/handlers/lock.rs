use anyhow::{Context, Result};
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

/// Whether pacman's transaction lock is currently present.
pub(crate) fn is_db_locked() -> bool {
    db_path().join("db.lck").exists()
}

// alpm holds an open fd to db.lck while locked, so the owner is whichever
// process has that exact file open; matching anything under the db dir would
// misreport read-only queries (and our own backend) as the holder. `lock` must
// be canonical since /proc fd links resolve fully.
fn find_lock_holder(lock: &Path) -> Option<String> {
    for entry in fs::read_dir("/proc").ok()?.flatten() {
        let pid = entry.file_name().to_str()?.to_string();
        if !pid.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let fd_dir = entry.path().join("fd");
        let fds = match fs::read_dir(&fd_dir) {
            Ok(fds) => fds,
            Err(_) => continue,
        };
        for fd in fds.flatten() {
            if let Ok(target) = fs::read_link(fd.path())
                && target == lock
            {
                let comm = fs::read_to_string(entry.path().join("comm"))
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                return Some(format!("{} (pid {})", comm, pid));
            }
        }
    }
    None
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
    let blocking = canonical.as_deref().and_then(find_lock_holder);
    let stale = canonical.is_some() && blocking.is_none();

    emit_json(&LockStatus {
        locked,
        stale,
        lock_path: lock.to_string_lossy().to_string(),
        blocking_process: blocking,
    })
}

pub fn remove_stale_lock() -> Result<()> {
    let db = db_path();
    let lock = db.join("db.lck");

    if !lock.exists() {
        return emit_json(&LockRemoveResult {
            removed: false,
            error: Some("No lock file exists".to_string()),
        });
    }

    // Match and remove the same canonical path; a failed resolve refuses
    // removal rather than deleting a lock we can't verify.
    let canonical = match lock.canonicalize() {
        Ok(path) => path,
        Err(e) => {
            return emit_json(&LockRemoveResult {
                removed: false,
                error: Some(format!("Could not resolve lock file: {}", e)),
            });
        }
    };

    let before = match lock_identity(&canonical) {
        Some(id) => id,
        None => {
            return emit_json(&LockRemoveResult {
                removed: false,
                error: Some("Could not stat lock file".to_string()),
            });
        }
    };

    if let Some(proc) = find_lock_holder(&canonical) {
        return emit_json(&LockRemoveResult {
            removed: false,
            error: Some(format!("Database in use by {}", proc)),
        });
    }

    // db.lck is an O_EXCL presence lock: it can't be acquired while it exists, so
    // an unchanged identity from inspection to here proves it was never released
    // and re-taken, i.e. genuinely stale. A live lock only reaches this path if
    // the stale file was replaced by a new instance, which a changed identity
    // catches. The remaining stat->unlink gap is an accepted micro-window (a
    // path-based unlink can't be made conditional on inode).
    if lock_identity(&canonical) != Some(before) {
        return emit_json(&LockRemoveResult {
            removed: false,
            error: Some(
                "Lock file changed during check; not removing (a process may have taken the lock)"
                    .to_string(),
            ),
        });
    }

    fs::remove_file(&canonical).context("Failed to remove lock file")?;

    emit_json(&LockRemoveResult {
        removed: true,
        error: None,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::{find_lock_holder, lock_identity};
    use std::fs::File;

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

        let holder = find_lock_holder(&canonical);
        assert!(holder.is_some());
        assert!(
            holder
                .unwrap()
                .contains(&format!("(pid {})", std::process::id()))
        );

        drop(file);
        assert!(find_lock_holder(&canonical).is_none());
        std::fs::remove_file(&path).unwrap();
    }
}
