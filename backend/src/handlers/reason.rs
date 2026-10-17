use alpm::{Alpm, PackageReason, TransFlag};
use anyhow::{Result, anyhow};
use serde::Serialize;

use crate::alpm::{TransactionGuard, get_handle, reason_to_string};
use crate::util::emit_json;

/// Install reason change, including the previous value for Undo.
#[derive(Debug, Serialize)]
pub struct InstallReasonResponse {
    pub success: bool,
    pub name: String,
    pub reason: &'static str,
    pub previous: &'static str,
}

pub fn parse_reason(value: &str) -> Result<PackageReason> {
    match value {
        "explicit" => Ok(PackageReason::Explicit),
        "dependency" => Ok(PackageReason::Depend),
        other => Err(anyhow!(
            "Invalid install reason '{}': expected explicit or dependency",
            other
        )),
    }
}

pub fn set_install_reason(name: &str, reason: &str) -> Result<()> {
    crate::validation::validate_package_name(name)?;
    crate::util::setup_signal_handler()?;
    let reason = parse_reason(reason)?;
    let mut handle = get_handle()?;
    emit_json(&set_install_reason_in(&mut handle, name, reason)?)
}

fn set_install_reason_in(
    handle: &mut Alpm,
    name: &str,
    reason: PackageReason,
) -> Result<InstallReasonResponse> {
    // An empty transaction holds db.lck while the local db is written, the
    // same way pacman -D does (trans_init(0) in src/pacman/database.c).
    let tx = TransactionGuard::new(handle, TransFlag::NONE)?;
    let pkg = tx
        .localdb()
        .pkg(name)
        .map_err(|_| anyhow!("Package '{}' not found in the local database", name))?;
    let previous = pkg.reason();
    pkg.set_reason(reason)
        .map_err(|e| anyhow!("Failed to set the install reason of '{}': {}", name, e))?;
    Ok(InstallReasonResponse {
        success: true,
        name: name.to_string(),
        reason: reason_to_string(reason),
        previous: reason_to_string(previous),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::classify_error;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new(packages: &[(&str, u8)]) -> Self {
            static NEXT_ID: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "cpac-reason-{}-{}",
                std::process::id(),
                NEXT_ID.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = std::fs::remove_dir_all(&path);
            let local = path.join("local");
            std::fs::create_dir_all(&local).unwrap();
            std::fs::write(local.join("ALPM_DB_VERSION"), "9\n").unwrap();
            for (name, reason) in packages {
                let dir = local.join(format!("{name}-1-1"));
                std::fs::create_dir(&dir).unwrap();
                std::fs::write(
                    dir.join("desc"),
                    format!("%NAME%\n{name}\n\n%VERSION%\n1-1\n\n%REASON%\n{reason}\n\n"),
                )
                .unwrap();
            }
            Self(path)
        }

        fn handle(&self) -> Alpm {
            let path = self.0.to_str().unwrap();
            Alpm::new(path, path).unwrap()
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn unknown_reason_is_rejected() {
        assert!(parse_reason("explicit").is_ok());
        assert!(parse_reason("dependency").is_ok());
        for bad in ["", "depend", "Explicit", "asdeps"] {
            assert!(parse_reason(bad).is_err(), "{bad:?} was accepted");
        }
    }

    #[test]
    fn response_serialises_previous() {
        let value = serde_json::to_value(InstallReasonResponse {
            success: true,
            name: "foo".into(),
            reason: "dependency",
            previous: "explicit",
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "success": true,
                "name": "foo",
                "reason": "dependency",
                "previous": "explicit",
            })
        );
    }

    #[test]
    fn sets_the_reason_persists_it_and_releases_the_lock() {
        let root = TestRoot::new(&[("foo", 0)]);
        let mut handle = root.handle();

        let res = set_install_reason_in(&mut handle, "foo", PackageReason::Depend).unwrap();
        assert_eq!((res.reason, res.previous), ("dependency", "explicit"));
        assert!(!root.0.join("db.lck").exists());

        let reread = root.handle();
        assert_eq!(
            reread.localdb().pkg("foo").unwrap().reason(),
            PackageReason::Depend
        );

        let undo = set_install_reason_in(&mut handle, "foo", PackageReason::Explicit).unwrap();
        assert_eq!((undo.reason, undo.previous), ("explicit", "dependency"));
    }

    #[test]
    fn held_lock_is_database_locked_and_changes_nothing() {
        let root = TestRoot::new(&[("foo", 1)]);
        std::fs::write(root.0.join("db.lck"), "").unwrap();
        let mut handle = root.handle();

        let err = set_install_reason_in(&mut handle, "foo", PackageReason::Explicit).unwrap_err();
        assert_eq!(classify_error(&err), Some("database_locked"));
        assert_eq!(
            root.handle().localdb().pkg("foo").unwrap().reason(),
            PackageReason::Depend
        );
        assert!(root.0.join("db.lck").exists());
    }

    #[test]
    fn missing_package_fails_and_releases_the_lock() {
        let root = TestRoot::new(&[]);
        let mut handle = root.handle();
        assert!(set_install_reason_in(&mut handle, "nope", PackageReason::Depend).is_err());
        assert!(!root.0.join("db.lck").exists());
    }
}
