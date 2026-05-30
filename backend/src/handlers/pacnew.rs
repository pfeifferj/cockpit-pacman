use anyhow::Result;
use std::collections::HashSet;
use std::path::Path;

use crate::alpm::get_handle;
use crate::models::{PacnewFile, PacnewStatus};
use crate::util::emit_json;

const KINDS: &[&str] = &["pacnew", "pacsave"];

fn merge_file_path(backup_name: &str, kind: &str) -> String {
    format!("/{}.{}", backup_name.trim_start_matches('/'), kind)
}

// Scans the backup arrays of installed packages, matching pacdiff's default
// db-scan mode. A .pacsave left by a fully removed package is not attributable
// here because the package is gone from the local db. Runs as the cockpit user,
// so files under directories it cannot traverse (e.g. 0750 /etc/sudoers.d) are
// skipped: exists() returns false on a stat permission error.
pub fn get_pacnew_status() -> Result<()> {
    let handle = get_handle()?;
    let localdb = handle.localdb();

    let mut seen: HashSet<String> = HashSet::new();
    let mut files: Vec<PacnewFile> = Vec::new();

    for pkg in localdb.pkgs() {
        let pkg_name = pkg.name().to_string();
        for backup in pkg.backup() {
            for kind in KINDS {
                let path = merge_file_path(backup.name(), kind);
                if Path::new(&path).exists() && seen.insert(path.clone()) {
                    files.push(PacnewFile {
                        path,
                        package: pkg_name.clone(),
                        kind: (*kind).to_string(),
                    });
                }
            }
        }
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));

    emit_json(&PacnewStatus {
        has_pacnew: !files.is_empty(),
        files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_merge_file_path() {
        assert_eq!(
            merge_file_path("etc/pacman.conf", "pacnew"),
            "/etc/pacman.conf.pacnew"
        );
        assert_eq!(
            merge_file_path("/etc/ssh/sshd_config", "pacsave"),
            "/etc/ssh/sshd_config.pacsave"
        );
    }
}
