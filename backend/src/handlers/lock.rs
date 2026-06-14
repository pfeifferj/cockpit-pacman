use anyhow::{Context, Result};
use serde::Serialize;
use std::fs;
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

    if let Some(proc) = find_lock_holder(&canonical) {
        return emit_json(&LockRemoveResult {
            removed: false,
            error: Some(format!("Database in use by {}", proc)),
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
    use super::find_lock_holder;
    use std::fs::File;

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
