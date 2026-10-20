use anyhow::{Context, Result};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::models::BackupSource;
use crate::util::{
    EntryCounts, with_file_lock, write_bytes_atomic_with_mode, write_json_atomic_with_mode,
};

#[derive(Debug)]
pub struct ConfigChanged;

impl std::fmt::Display for ConfigChanged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Configuration changed. Reload it before saving or undoing.")
    }
}

impl std::error::Error for ConfigChanged {}

pub fn file_revision(contents: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(contents))
}

pub fn check_revision(contents: &[u8], expected: &str) -> Result<()> {
    if expected.is_empty() {
        return Err(
            crate::models::InvalidInput("A configuration revision is required".into()).into(),
        );
    }
    if file_revision(contents) != expected {
        return Err(ConfigChanged.into());
    }
    Ok(())
}

pub fn read_snapshot(path: &Path) -> Result<(Vec<u8>, String)> {
    match fs::read(path) {
        Ok(bytes) => {
            let revision = file_revision(&bytes);
            Ok((bytes, revision))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok((Vec::new(), "missing".into())),
        Err(error) => Err(error.into()),
    }
}

pub fn check_current_revision(path: &Path, expected: &str) -> Result<()> {
    if expected.is_empty() {
        return Err(
            crate::models::InvalidInput("A configuration revision is required".into()).into(),
        );
    }
    if read_snapshot(path)?.1 != expected {
        return Err(ConfigChanged.into());
    }
    Ok(())
}

pub struct BackupStore<'a> {
    pub target: &'a Path,
    pub lock: &'a Path,
    pub manifest: &'a Path,
    pub name_prefix: &'a str,
    pub keep: usize,
}

pub struct BackupResult {
    pub revision: String,
    pub backup_timestamp: Option<i64>,
    pub backup_path: Option<String>,
    pub warnings: Vec<String>,
}

pub struct BackupEntry {
    pub timestamp: i64,
    pub date: String,
    pub counts: EntryCounts,
    pub size: u64,
    pub source: BackupSource,
}

impl BackupStore<'_> {
    fn parent(&self) -> &Path {
        self.target.parent().unwrap_or_else(|| Path::new("."))
    }

    fn path(&self, timestamp: i64) -> PathBuf {
        self.parent()
            .join(format!("{}{timestamp}", self.name_prefix))
    }

    fn read_manifest(&self, warnings: &mut Vec<String>) -> BTreeMap<i64, Value> {
        let result = match fs::read(self.manifest) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(anyhow::Error::from),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return BTreeMap::new(),
            Err(error) => Err(error.into()),
        };
        result.unwrap_or_else(|error| {
            warnings.push(format!(
                "Could not read backup provenance {}: {error}",
                self.manifest.display()
            ));
            BTreeMap::new()
        })
    }

    fn scan(&self, warnings: &mut Vec<String>) -> Result<Vec<(PathBuf, i64)>> {
        let mut entries = Vec::new();
        for entry in fs::read_dir(self.parent())? {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    warnings.push(format!(
                        "Could not inspect a backup directory entry: {error}"
                    ));
                    continue;
                }
            };
            let name = entry.file_name();
            let Some(timestamp) = name
                .to_str()
                .and_then(|name| name.strip_prefix(self.name_prefix))
                .and_then(|suffix| suffix.parse::<i64>().ok())
            else {
                continue;
            };
            entries.push((entry.path(), timestamp));
        }
        Ok(entries)
    }

    pub fn list(
        &self,
        count: impl Fn(&Path) -> Result<EntryCounts>,
    ) -> Result<(Vec<BackupEntry>, Vec<String>)> {
        let mut warnings = Vec::new();
        let provenance = self.read_manifest(&mut warnings);
        let mut backups = Vec::new();
        for (path, timestamp) in self.scan(&mut warnings)? {
            let inspected = (|| -> Result<(u64, EntryCounts)> {
                let metadata = fs::symlink_metadata(&path)?;
                anyhow::ensure!(metadata.is_file(), "not a regular file");
                Ok((metadata.len(), count(&path)?))
            })();
            match inspected {
                Ok((size, counts)) => backups.push(BackupEntry {
                    timestamp,
                    date: chrono::DateTime::from_timestamp(timestamp, 0)
                        .map(|date| date.format("%Y-%m-%d %H:%M:%S UTC").to_string())
                        .unwrap_or_else(|| "Unknown".to_string()),
                    counts,
                    size,
                    source: source_at(&provenance, timestamp),
                }),
                Err(error) => {
                    warnings.push(format!("Could not read backup {}: {error}", path.display()))
                }
            }
        }
        backups.sort_by_key(|backup| std::cmp::Reverse(backup.timestamp));
        Ok((backups, warnings))
    }

    fn copy_current(&self) -> Result<Option<(PathBuf, i64)>> {
        let mut original = match File::open(self.target) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let mode = original.metadata()?.permissions().mode() & 0o777;
        let mut timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as i64;
        let (path, mut backup) = loop {
            let path = self.path(timestamp);
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(mode)
                .open(&path)
            {
                Ok(file) => break (path, file),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => timestamp += 1,
                Err(error) => return Err(error).context("Could not create configuration backup"),
            }
        };
        let copied = (|| -> Result<()> {
            io::copy(&mut original, &mut backup)?;
            backup.set_permissions(fs::Permissions::from_mode(mode))?;
            backup.sync_all()?;
            File::open(self.parent())?.sync_all()?;
            Ok(())
        })();
        if let Err(error) = copied {
            let _ = fs::remove_file(&path);
            return Err(error).context("Could not make configuration backup durable");
        }
        Ok(Some((path, timestamp)))
    }

    /// The caller must hold this store's lock.
    pub fn replace_locked(&self, contents: &[u8], source: BackupSource) -> Result<BackupResult> {
        let backup = self.copy_current()?;
        write_bytes_atomic_with_mode(self.target, contents, 0o644)?;
        let warnings = self.maintain(backup.as_ref().map(|(_, timestamp)| (*timestamp, source)));
        Ok(BackupResult {
            revision: file_revision(contents),
            backup_timestamp: backup.as_ref().map(|(_, timestamp)| *timestamp),
            backup_path: backup.map(|(path, _)| path.to_string_lossy().into_owned()),
            warnings,
        })
    }

    fn restore_locked(
        &self,
        timestamp: i64,
        validate: impl Fn(&Path) -> Result<()>,
    ) -> Result<BackupResult> {
        let path = self.path(timestamp);
        anyhow::ensure!(
            fs::symlink_metadata(&path)
                .with_context(|| format!("Cannot open backup {}", path.display()))?
                .is_file(),
            "Backup is not a regular file: {}",
            path.display()
        );
        validate(&path)?;
        self.replace_locked(&fs::read(&path)?, BackupSource::Auto)
    }

    pub fn restore(
        &self,
        timestamp: i64,
        validate: impl Fn(&Path) -> Result<()>,
    ) -> Result<BackupResult> {
        with_file_lock(self.lock, || self.restore_locked(timestamp, validate))
    }

    pub fn undo(
        &self,
        timestamp: i64,
        expected_revision: &str,
        validate: impl Fn(&Path) -> Result<()>,
    ) -> Result<crate::models::ConfigurationUndoResponse> {
        with_file_lock(self.lock, || {
            check_current_revision(self.target, expected_revision)?;
            let result = self.restore_locked(timestamp, validate)?;
            Ok(crate::models::ConfigurationUndoResponse {
                success: true,
                revision: result.revision,
                backup_timestamp: result.backup_timestamp,
                backup_path: result.backup_path,
                warnings: result.warnings,
            })
        })
    }

    pub fn delete(&self, timestamp: i64) -> Result<Vec<String>> {
        with_file_lock(self.lock, || {
            let path = self.path(timestamp);
            fs::remove_file(&path)
                .with_context(|| format!("Cannot delete backup {}", path.display()))?;
            let mut warnings = self.maintain(None);
            if let Err(error) = File::open(self.parent()).and_then(|dir| dir.sync_all()) {
                warnings.push(format!("Could not sync backup deletion: {error}"));
            }
            Ok(warnings)
        })
    }

    fn maintain(&self, created: Option<(i64, BackupSource)>) -> Vec<String> {
        let mut warnings = Vec::new();
        let mut provenance = self.read_manifest(&mut warnings);
        if let Some((timestamp, source)) = created {
            provenance.insert(timestamp, serde_json::json!(source));
        }
        let mut entries = match self.scan(&mut warnings) {
            Ok(entries) => entries,
            Err(error) => {
                warnings.push(format!("Could not scan backups for cleanup: {error}"));
                return warnings;
            }
        };
        let protected = created.map(|(timestamp, _)| timestamp);
        entries.sort_by_key(|(_, timestamp)| {
            (
                Some(*timestamp) != protected,
                source_at(&provenance, *timestamp) != BackupSource::Manual,
                std::cmp::Reverse(*timestamp),
            )
        });
        let mut live = BTreeMap::new();
        for (index, (path, timestamp)) in entries.into_iter().enumerate() {
            if index >= self.keep.max(1) {
                match fs::remove_file(&path) {
                    Ok(()) => continue,
                    Err(error) => warnings.push(format!(
                        "Could not remove old backup {}: {error}",
                        path.display()
                    )),
                }
            }
            if let Some(value) = provenance.remove(&timestamp) {
                live.insert(timestamp, value);
            }
        }
        if let Err(error) = write_json_atomic_with_mode(self.manifest, &live, 0o644) {
            warnings.push(format!(
                "Could not write backup provenance {}: {error}",
                self.manifest.display()
            ));
        }
        warnings
    }
}

fn source_at(provenance: &BTreeMap<i64, Value>, timestamp: i64) -> BackupSource {
    provenance
        .get(&timestamp)
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

    struct TestStore {
        dir: PathBuf,
        target: PathBuf,
        lock: PathBuf,
        manifest: PathBuf,
    }

    impl TestStore {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "cpac-backups-{}-{}",
                std::process::id(),
                NEXT_DIR.fetch_add(1, Ordering::Relaxed)
            ));
            crate::util::private_dir(&dir);
            Self {
                target: dir.join("config"),
                lock: dir.join("lock"),
                manifest: dir.join("meta.json"),
                dir,
            }
        }

        fn store(&self) -> BackupStore<'_> {
            BackupStore {
                target: &self.target,
                lock: &self.lock,
                manifest: &self.manifest,
                name_prefix: "config.backup.",
                keep: 5,
            }
        }
    }

    impl Drop for TestStore {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn count(_: &Path) -> Result<EntryCounts> {
        Ok(EntryCounts {
            enabled: 1,
            total: 1,
        })
    }

    #[test]
    fn restoring_with_five_manual_backups_keeps_a_working_undo() {
        let fixture = TestStore::new();
        let store = fixture.store();
        fs::write(store.target, "original").unwrap();
        for version in 0..5 {
            store
                .replace_locked(version.to_string().as_bytes(), BackupSource::Manual)
                .unwrap();
        }
        let (before, _) = store.list(count).unwrap();
        assert_eq!(before.len(), 5);
        assert!(
            before
                .iter()
                .all(|entry| entry.source == BackupSource::Manual)
        );
        fs::set_permissions(store.target, fs::Permissions::from_mode(0o600)).unwrap();
        let result = store
            .restore(before.last().unwrap().timestamp, |_| Ok(()))
            .unwrap();
        assert!(result.warnings.is_empty());
        assert_eq!(fs::read_to_string(store.target).unwrap(), "original");
        let undo = result.backup_path.unwrap();
        assert_eq!(fs::read_to_string(&undo).unwrap(), "4");
        let (after, _) = store.list(count).unwrap();
        assert_eq!(after.len(), 5);
        let undo_timestamp = after
            .iter()
            .find(|entry| entry.source == BackupSource::Auto)
            .unwrap()
            .timestamp;
        store.restore(undo_timestamp, |_| Ok(())).unwrap();
        assert_eq!(fs::read_to_string(store.target).unwrap(), "4");
        assert_eq!(
            fs::metadata(store.target).unwrap().permissions().mode() & 0o777,
            0o644
        );
    }

    #[test]
    fn a_backup_failure_leaves_the_original_untouched() {
        let fixture = TestStore::new();
        let mut store = fixture.store();
        fs::write(store.target, "original").unwrap();
        store.name_prefix = "missing/config.backup.";
        assert!(store.replace_locked(b"new", BackupSource::Manual).is_err());
        assert_eq!(fs::read_to_string(store.target).unwrap(), "original");
    }

    #[test]
    fn a_manifest_write_failure_returns_a_warning_and_keeps_the_backup() {
        let fixture = TestStore::new();
        let store = fixture.store();
        fs::write(store.target, "original").unwrap();
        fs::create_dir(store.manifest).unwrap();
        let result = store.replace_locked(b"new", BackupSource::Manual).unwrap();
        assert!(!result.warnings.is_empty());
        assert_eq!(fs::read(result.backup_path.unwrap()).unwrap(), b"original");
        assert_eq!(fs::read(store.target).unwrap(), b"new");
    }

    #[test]
    fn an_unreadable_backup_is_reported_and_a_prune_failure_keeps_provenance() {
        let fixture = TestStore::new();
        let store = fixture.store();
        for timestamp in 1..=5 {
            fs::write(store.path(timestamp), "valid").unwrap();
        }
        fs::create_dir(store.path(0)).unwrap();
        fs::write(store.manifest, br#"{"0":"manual"}"#).unwrap();
        let (entries, warnings) = store.list(count).unwrap();
        assert_eq!(entries.len(), 5);
        assert_eq!(warnings.len(), 1);
        assert!(!store.maintain(None).is_empty());
        assert!(store.path(0).is_dir());
        assert!(store.read_manifest(&mut Vec::new()).contains_key(&0));
    }

    #[test]
    fn unknown_provenance_survives_and_deleted_entries_are_removed() {
        let fixture = TestStore::new();
        let store = fixture.store();
        fs::write(store.path(100), "a").unwrap();
        fs::write(store.path(200), "b").unwrap();
        fs::write(
            store.manifest,
            br#"{"100":"future","200":"manual","300":"auto"}"#,
        )
        .unwrap();
        assert!(store.maintain(None).is_empty());
        let provenance = store.read_manifest(&mut Vec::new());
        assert_eq!(provenance.get(&100), Some(&serde_json::json!("future")));
        assert!(!provenance.contains_key(&300));
        store.delete(200).unwrap();
        assert!(!store.read_manifest(&mut Vec::new()).contains_key(&200));
    }
    #[test]
    fn stale_undo_leaves_config_and_backups_untouched() {
        let fixture = TestStore::new();
        let store = fixture.store();
        fs::write(store.target, b"before").unwrap();
        let saved = store
            .replace_locked(b"saved", BackupSource::Manual)
            .unwrap();
        let stamp = saved.backup_timestamp.unwrap();
        fs::write(store.target, b"external edit").unwrap();
        let before = fs::read(store.manifest).unwrap();
        let count_before = fs::read_dir(&fixture.dir).unwrap().count();
        let error = store
            .undo(stamp, &file_revision(b"saved"), |_| Ok(()))
            .err()
            .unwrap();
        assert_eq!(crate::util::classify_error(&error), Some("config_changed"));
        assert_eq!(fs::read(store.target).unwrap(), b"external edit");
        assert_eq!(fs::read(store.manifest).unwrap(), before);
        assert_eq!(
            fs::read_dir(&fixture.dir).unwrap().count(),
            count_before + 1
        );
        assert_eq!(fs::read(saved.backup_path.unwrap()).unwrap(), b"before");
    }

    #[test]
    fn concurrent_undo_only_accepts_the_current_revision_once() {
        let fixture = TestStore::new();
        let store = fixture.store();
        fs::write(store.target, b"before").unwrap();
        let stamp = store
            .replace_locked(b"saved", BackupSource::Manual)
            .unwrap()
            .backup_timestamp
            .unwrap();
        let barrier = std::sync::Barrier::new(2);
        let results = std::thread::scope(|scope| {
            let a = scope.spawn(|| {
                barrier.wait();
                store.undo(stamp, &file_revision(b"saved"), |_| Ok(()))
            });
            let b = scope.spawn(|| {
                barrier.wait();
                store.undo(stamp, &file_revision(b"saved"), |_| Ok(()))
            });
            [a.join().unwrap(), b.join().unwrap()]
        });
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        let restored = results.into_iter().find_map(Result::ok).unwrap();
        assert_eq!(restored.revision, file_revision(b"before"));
        assert_eq!(fs::read(store.target).unwrap(), b"before");
        assert_eq!(fs::read(restored.backup_path.unwrap()).unwrap(), b"saved");
    }
    #[test]
    fn missing_revision_is_distinct_from_empty_and_detects_concurrent_creation() {
        let fixture = TestStore::new();
        let store = fixture.store();
        assert_eq!(read_snapshot(store.target).unwrap().1, "missing");
        assert!(check_current_revision(store.target, "missing").is_ok());
        assert!(check_current_revision(store.target, "").is_err());
        fs::write(store.target, b"").unwrap();
        assert_ne!(read_snapshot(store.target).unwrap().1, "missing");
        assert!(
            check_current_revision(store.target, "missing")
                .unwrap_err()
                .is::<ConfigChanged>()
        );
        fs::remove_file(store.target).unwrap();
        let result = with_file_lock(store.lock, || {
            check_current_revision(store.target, "missing")?;
            store.replace_locked(b"created", BackupSource::Manual)
        })
        .unwrap();
        assert!(result.backup_timestamp.is_none());
        assert_eq!(result.revision, file_revision(b"created"));
        assert_eq!(fs::read(store.target).unwrap(), b"created");
    }
}
