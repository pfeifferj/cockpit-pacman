use anyhow::{Context, Result};
use pacman_log::{Event, LogReader};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use crate::models::{LogEntry, UpdateStats};
const CACHE_VERSION: u8 = 1;
const MAX_CACHE_BYTES: u64 = 64 * 1024 * 1024;
const LOG_PATH: &str = "/var/log/pacman.log";
const TS_FMT: &str = "%Y-%m-%dT%H:%M:%S%z";

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Signature {
    device: u64,
    inode: u64,
    length: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}

impl Signature {
    fn from_metadata(metadata: &fs::Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            length: metadata.len(),
            modified: (metadata.mtime(), metadata.mtime_nsec()),
            changed: (metadata.ctime(), metadata.ctime_nsec()),
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Snapshot<T> {
    version: u8,
    signature: Signature,
    data: T,
}

#[derive(Serialize, Deserialize, Default)]
pub(crate) struct ParsedLog {
    pub entries: Vec<LogEntry>,
    pub transactions: Vec<LogTransaction>,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct LogTransaction {
    pub command: Option<String>,
    pub start_time: String,
    pub end_time: String,
    pub start: usize,
    pub end: usize,
}

fn trusted_directory(path: &Path) -> bool {
    let created = fs::DirBuilder::new().mode(0o700).create(path);
    if created.is_err_and(|error| error.kind() != std::io::ErrorKind::AlreadyExists) {
        return false;
    }
    fs::symlink_metadata(path).is_ok_and(|metadata| {
        metadata.is_dir()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o077 == 0
    })
}

fn cache_directory() -> Option<PathBuf> {
    let path = PathBuf::from(format!("/tmp/cockpit-pacman-log-{}", unsafe {
        libc::geteuid()
    }));
    trusted_directory(&path).then_some(path)
}

fn read_cache<T: DeserializeOwned>(
    directory: Option<&Path>,
    name: &str,
    signature: &Signature,
) -> Option<T> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(directory?.join(name))
        .ok()?;
    let metadata = file.metadata().ok()?;
    let limit = signature
        .length
        .saturating_mul(10)
        .saturating_add(4096)
        .min(MAX_CACHE_BYTES);
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || metadata.len() > limit
    {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > limit {
        return None;
    }
    let snapshot: Snapshot<T> = serde_json::from_slice(&bytes).ok()?;
    (snapshot.version == CACHE_VERSION && snapshot.signature == *signature).then_some(snapshot.data)
}

struct CacheWriter {
    file: BufWriter<File>,
    remaining: u64,
}

impl Write for CacheWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() as u64 > self.remaining {
            return Err(std::io::Error::other("Log cache exceeds its size limit"));
        }
        let written = self.file.write(bytes)?;
        self.remaining -= written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}

fn publish_with_limit<T: Serialize>(directory: &Path, name: &str, snapshot: &T, limit: u64) {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = directory.join(format!(".{name}.{}.{nonce}.tmp", std::process::id()));
    let Ok(file) = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
    else {
        return;
    };
    let mut writer = CacheWriter {
        file: BufWriter::new(file),
        remaining: limit,
    };
    let result = (|| -> Result<()> {
        serde_json::to_writer(&mut writer, snapshot)?;
        writer.flush()?;
        writer.file.get_ref().sync_all()?;
        fs::rename(&temporary, directory.join(name))?;
        File::open(directory)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
}

fn publish<T: Serialize>(directory: Option<&Path>, name: &str, signature: Signature, data: &T) {
    if let Some(directory) = directory {
        publish_with_limit(
            directory,
            name,
            &Snapshot {
                version: CACHE_VERSION,
                signature,
                data,
            },
            MAX_CACHE_BYTES,
        );
    }
}

fn unchanged(path: &Path, file: &File, signature: &Signature) -> bool {
    file.metadata()
        .is_ok_and(|metadata| Signature::from_metadata(&metadata) == *signature)
        && fs::metadata(path)
            .is_ok_and(|metadata| Signature::from_metadata(&metadata) == *signature)
}

fn parse(file: &File) -> Result<ParsedLog> {
    let mut parsed = ParsedLog::default();
    let mut command = None;
    let mut active: Option<LogTransaction> = None;
    // Keep the opened inode when pacman.log is rotated during the read.
    for entry in LogReader::open(format!("/proc/self/fd/{}", file.as_raw_fd())).entries() {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) if error.kind() == std::io::ErrorKind::InvalidData => continue,
            Err(error) => return Err(error).context("Could not read pacman.log"),
        };
        match entry.event {
            Event::Command(value) => command = Some(value),
            Event::TransactionStart => {
                if let Some(mut transaction) = active.take() {
                    transaction.end = parsed.entries.len();
                    parsed.transactions.push(transaction);
                }
                let timestamp = entry.timestamp.format(TS_FMT).to_string();
                active = Some(LogTransaction {
                    command: command.take(),
                    start_time: timestamp.clone(),
                    end_time: timestamp,
                    start: parsed.entries.len(),
                    end: parsed.entries.len(),
                });
            }
            Event::TransactionComplete => {
                if let Some(mut transaction) = active.take() {
                    transaction.end_time = entry.timestamp.format(TS_FMT).to_string();
                    transaction.end = parsed.entries.len();
                    parsed.transactions.push(transaction);
                }
            }
            Event::Operation(operation) => parsed.entries.push(LogEntry {
                timestamp: operation.timestamp.format(TS_FMT).to_string(),
                action: operation.action.to_string(),
                package: operation.package,
                old_version: operation.old_version,
                new_version: operation.new_version,
            }),
            Event::Other(_) => {}
        }
    }
    if let Some(mut transaction) = active {
        transaction.end = parsed.entries.len();
        parsed.transactions.push(transaction);
    }
    Ok(parsed)
}

fn valid_ranges(parsed: &ParsedLog) -> bool {
    parsed.transactions.iter().all(|transaction| {
        transaction.start <= transaction.end && transaction.end <= parsed.entries.len()
    })
}

fn load_at(path: &Path, directory: Option<&Path>) -> Result<ParsedLog> {
    let file = File::open(path).context("Could not read pacman.log")?;
    let signature = Signature::from_metadata(&file.metadata()?);
    if let Some(parsed) = read_cache::<ParsedLog>(directory, "history.json", &signature)
        && valid_ranges(&parsed)
        && unchanged(path, &file, &signature)
    {
        return Ok(parsed);
    }
    let parsed = parse(&file)?;
    // pacman appends to the log during every transaction. A read that raced an
    // append is still a valid prefix, but only a stable signature is cached.
    if unchanged(path, &file, &signature) {
        let stats = build_update_stats_map(parsed.entries.iter().cloned());
        publish(directory, "stats.json", signature.clone(), &stats);
        publish(directory, "history.json", signature, &parsed);
    }
    Ok(parsed)
}

pub(crate) fn load() -> Result<ParsedLog> {
    load_at(Path::new(LOG_PATH), cache_directory().as_deref())
}

pub(crate) fn package_stats(name: &str) -> Option<UpdateStats> {
    let directory = cache_directory();
    package_stats_at(name, Path::new(LOG_PATH), directory.as_deref())
}

fn package_stats_at(name: &str, path: &Path, directory: Option<&Path>) -> Option<UpdateStats> {
    let file = File::open(path).ok()?;
    let signature = Signature::from_metadata(&file.metadata().ok()?);
    if let Some(mut stats) =
        read_cache::<HashMap<String, UpdateStats>>(directory, "stats.json", &signature)
        && unchanged(path, &file, &signature)
    {
        return stats.remove(&name.to_lowercase());
    }
    let parsed = load_at(path, directory).ok()?;
    let mut stats = build_update_stats_map(parsed.entries);
    if unchanged(path, &file, &signature) {
        publish(directory, "stats.json", signature, &stats);
    }
    stats.remove(&name.to_lowercase())
}

pub(crate) fn build_update_stats_map(
    entries: impl IntoIterator<Item = LogEntry>,
) -> HashMap<String, UpdateStats> {
    struct Accum {
        first_installed: Option<String>,
        last_updated: Option<String>,
        update_count: usize,
        upgrade_timestamps: Vec<chrono::NaiveDateTime>,
    }

    let mut per_pkg: HashMap<String, Accum> = HashMap::new();
    for entry in entries {
        let key = entry.package.to_lowercase();
        let acc = per_pkg.entry(key).or_insert_with(|| Accum {
            first_installed: None,
            last_updated: None,
            update_count: 0,
            upgrade_timestamps: Vec::new(),
        });
        match entry.action.as_str() {
            "installed" if acc.first_installed.is_none() => {
                acc.first_installed = Some(entry.timestamp);
            }
            "upgraded" => {
                acc.update_count += 1;
                acc.last_updated = Some(entry.timestamp.clone());
                if let Ok(dt) =
                    chrono::NaiveDateTime::parse_from_str(&entry.timestamp, "%Y-%m-%dT%H:%M:%S%z")
                {
                    acc.upgrade_timestamps.push(dt);
                }
            }
            _ => {}
        }
    }

    per_pkg
        .into_iter()
        .filter_map(|(name, acc)| {
            if acc.update_count == 0 && acc.first_installed.is_none() {
                return None;
            }
            let avg_days = if acc.upgrade_timestamps.len() >= 2 {
                let total_days: f64 = acc
                    .upgrade_timestamps
                    .windows(2)
                    .map(|w| (w[1] - w[0]).num_seconds().abs() as f64 / 86400.0)
                    .sum();
                Some(total_days / (acc.upgrade_timestamps.len() - 1) as f64)
            } else {
                None
            };
            Some((
                name,
                UpdateStats {
                    update_count: acc.update_count,
                    first_installed: acc.first_installed,
                    last_updated: acc.last_updated,
                    avg_days_between_updates: avg_days,
                },
            ))
        })
        .collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::util::write_json_atomic_with_mode;
    use std::io::Write;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Fixture {
        directory: PathBuf,
        log: PathBuf,
        cache: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "cpac-log-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&directory).unwrap();
            let cache = directory.join("cache");
            assert!(trusted_directory(&cache));
            Self {
                log: directory.join("pacman.log"),
                directory,
                cache,
            }
        }

        fn write(&self, name: &str) {
            fs::write(&self.log, format!("[2026-01-21T10:00:00+0000] [PACMAN] Running 'pacman -Syu'\n[2026-01-21T10:00:00+0000] [ALPM] transaction started\n[2026-01-21T10:00:00+0000] [ALPM] upgraded {name} (1-1 -> 2-1)\n[2026-01-21T10:00:01+0000] [ALPM] transaction completed\n")).unwrap();
        }

        fn read(&self) -> ParsedLog {
            load_at(&self.log, Some(&self.cache)).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    #[test]
    fn separate_reads_reuse_history_and_stats_without_a_process_static() {
        let fixture = Fixture::new();
        fixture.write("first");
        assert_eq!(fixture.read().entries.len(), 1);
        let history = fixture.cache.join("history.json");
        let inode = fs::metadata(&history).unwrap().ino();
        assert_eq!(fixture.read().entries[0].package, "first");
        assert_eq!(fs::metadata(&history).unwrap().ino(), inode);
        fs::remove_file(&history).unwrap();
        let stats = package_stats_at("first", &fixture.log, Some(&fixture.cache)).unwrap();
        assert_eq!(stats.update_count, 1);
        assert!(!history.exists());
    }

    #[test]
    fn append_truncate_rotation_and_same_size_rewrite_invalidate_the_cache() {
        let fixture = Fixture::new();
        fixture.write("first");
        assert_eq!(fixture.read().entries.len(), 1);
        let mut file = OpenOptions::new().append(true).open(&fixture.log).unwrap();
        writeln!(
            file,
            "[2026-01-21T10:00:02+0000] [ALPM] installed second (1-1)"
        )
        .unwrap();
        assert_eq!(fixture.read().entries.len(), 2);
        fixture.write("short");
        assert_eq!(fixture.read().entries.len(), 1);

        let original_modified = fs::metadata(&fixture.log).unwrap().modified().unwrap();
        fixture.write("other");
        File::options()
            .write(true)
            .open(&fixture.log)
            .unwrap()
            .set_modified(original_modified)
            .unwrap();
        assert_eq!(fixture.read().entries[0].package, "other");
        fs::rename(&fixture.log, fixture.directory.join("pacman.log.1")).unwrap();
        fixture.write("after");
        assert_eq!(fixture.read().entries[0].package, "after");
    }

    #[test]
    fn malformed_caches_and_unwritable_cache_locations_fall_back_to_the_log() {
        let fixture = Fixture::new();
        fixture.write("first");
        fs::write(fixture.cache.join("history.json"), b"not json").unwrap();
        assert_eq!(fixture.read().entries.len(), 1);
        let unavailable = fixture.directory.join("absent");
        assert_eq!(
            load_at(&fixture.log, Some(&unavailable))
                .unwrap()
                .entries
                .len(),
            1
        );
        assert!(!unavailable.exists());
    }

    #[test]
    fn invalid_utf8_lines_do_not_discard_valid_history_or_stats() {
        let fixture = Fixture::new();
        fs::write(&fixture.log, b"[2026-01-21T10:00:00+0000] [ALPM] transaction started\n[2026-01-21T10:00:01+0000] [ALPM] installed first (1-1)\n[2026-01-21T10:00:02+0000] [ALPM-SCRIPTLET] invalid byte: \xff\n[2026-01-21T10:00:03+0000] [ALPM] upgraded first (1-1 -> 2-1)\n[2026-01-21T10:00:04+0000] [ALPM] transaction completed\n").unwrap();
        for _ in 0..2 {
            let parsed = fixture.read();
            assert_eq!(parsed.entries.len(), 2);
            assert_eq!(parsed.entries[0].action, "installed");
            assert_eq!(parsed.entries[1].action, "upgraded");
            assert_eq!(parsed.transactions.len(), 1);
            assert_eq!(
                (parsed.transactions[0].start, parsed.transactions[0].end),
                (0, 2)
            );
            assert_eq!(
                package_stats_at("first", &fixture.log, Some(&fixture.cache))
                    .unwrap()
                    .update_count,
                1
            );
        }
    }

    #[test]
    fn persistent_reader_io_errors_are_returned() {
        let fixture = Fixture::new();
        let directory = File::open(&fixture.directory).unwrap();
        let error = parse(&directory).err().unwrap();
        assert_eq!(
            error
                .downcast_ref::<std::io::Error>()
                .unwrap()
                .raw_os_error(),
            Some(libc::EISDIR)
        );
    }

    #[test]
    fn cache_permissions_and_symlinks_are_not_trusted() {
        let fixture = Fixture::new();
        fixture.write("first");
        let outside = fixture.directory.join("outside.json");
        let signature = Signature::from_metadata(&fs::metadata(&fixture.log).unwrap());
        let fake = ParsedLog {
            entries: vec![LogEntry {
                timestamp: String::new(),
                action: "installed".into(),
                package: "fake".into(),
                old_version: None,
                new_version: None,
            }],
            transactions: vec![],
        };
        write_json_atomic_with_mode(
            &outside,
            &Snapshot {
                version: CACHE_VERSION,
                signature,
                data: fake,
            },
            0o600,
        )
        .unwrap();
        symlink(&outside, fixture.cache.join("history.json")).unwrap();
        assert_eq!(fixture.read().entries[0].package, "first");
        assert!(fs::read_to_string(&outside).unwrap().contains("fake"));
        fs::set_permissions(&fixture.cache, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(!trusted_directory(&fixture.cache));
        let link = fixture.directory.join("cache-link");
        symlink(&fixture.cache, &link).unwrap();
        assert!(!trusted_directory(&link));
    }

    #[test]
    fn nonregular_and_public_cache_files_are_ignored() {
        let fixture = Fixture::new();
        fixture.write("first");
        let history = fixture.cache.join("history.json");
        let signature = Signature::from_metadata(&fs::metadata(&fixture.log).unwrap());
        let fifo = std::ffi::CString::new(history.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(
            read_cache::<ParsedLog>(Some(&fixture.cache), "history.json", &signature).is_none()
        );
        fs::remove_file(&history).unwrap();
        fixture.read();
        fs::set_permissions(&history, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(
            read_cache::<ParsedLog>(Some(&fixture.cache), "history.json", &signature).is_none()
        );
        assert_eq!(fixture.read().entries[0].package, "first");
        assert_eq!(fs::metadata(&history).unwrap().mode() & 0o777, 0o600);
    }

    #[test]
    fn oversized_cache_reads_fall_back_and_failed_writes_keep_the_previous_cache() {
        let fixture = Fixture::new();
        fixture.write("first");
        let history = fixture.cache.join("history.json");
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&history)
            .unwrap();
        file.set_len(MAX_CACHE_BYTES + 1).unwrap();
        let mut signature = Signature::from_metadata(&fs::metadata(&fixture.log).unwrap());
        signature.length = MAX_CACHE_BYTES;
        assert!(
            read_cache::<ParsedLog>(Some(&fixture.cache), "history.json", &signature).is_none()
        );
        assert_eq!(fixture.read().entries[0].package, "first");
        let before = fs::read(&history).unwrap();
        publish_with_limit(&fixture.cache, "history.json", &"x".repeat(256), 64);
        assert_eq!(fs::read(&history).unwrap(), before);
        let files: Vec<_> = fs::read_dir(&fixture.cache)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(files.len(), 2);
        assert!(files.contains(&"history.json".into()));
        assert!(files.contains(&"stats.json".into()));
        assert_eq!(fixture.read().entries[0].package, "first");
    }

    #[test]
    fn open_transactions_and_operations_without_markers_are_preserved() {
        let fixture = Fixture::new();
        fs::write(&fixture.log, "[2026-01-21T10:00:00+0000] [ALPM] installed legacy (1-1)\n[2026-01-21T10:00:01+0000] [ALPM] transaction started\n[2026-01-21T10:00:02+0000] [ALPM] upgraded first (1-1 -> 2-1)\n").unwrap();
        let parsed = fixture.read();
        assert_eq!(parsed.entries.len(), 2);
        assert_eq!(parsed.transactions.len(), 1);
        assert_eq!(
            (parsed.transactions[0].start, parsed.transactions[0].end),
            (1, 2)
        );
        assert_eq!(
            package_stats_at("first", &fixture.log, Some(&fixture.cache))
                .unwrap()
                .update_count,
            1
        );
    }

    #[test]
    #[ignore = "manual performance measurement"]
    fn representative_log_cache_timings() {
        let fixture = Fixture::new();
        let mut text = String::new();
        for transaction in 0..400 {
            text.push_str("[2026-01-21T10:00:00+0000] [ALPM] transaction started\n");
            for package in 0..150 {
                text.push_str(&format!("[2026-01-21T10:00:00+0000] [ALPM] upgraded package-{package:03} ({transaction}-1 -> {}-1)\n", transaction + 1));
            }
            text.push_str("[2026-01-21T10:00:01+0000] [ALPM] transaction completed\n");
        }
        fs::write(&fixture.log, &text).unwrap();
        let started = std::time::Instant::now();
        let cold = fixture.read();
        let cold_time = started.elapsed();
        let started = std::time::Instant::now();
        let warm = fixture.read();
        let warm_time = started.elapsed();
        let started = std::time::Instant::now();
        let stats = package_stats_at("package-001", &fixture.log, Some(&fixture.cache)).unwrap();
        let stats_time = started.elapsed();
        assert_eq!(cold.entries.len(), warm.entries.len());
        assert_eq!(stats.update_count, 400);
        eprintln!(
            "{} bytes, {} operations: cold={cold_time:?}, cached history={warm_time:?}, cached stats={stats_time:?}",
            text.len(),
            warm.entries.len()
        );
    }
}
