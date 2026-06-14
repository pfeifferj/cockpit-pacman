use anyhow::{Context, Result};
use serde::Serialize;
use std::cmp::Ordering;
use std::fs::File;
use std::io::{self, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use ureq::config::IpFamily;

use crate::models::StreamEvent;

static DETECTED_IP_FAMILY: LazyLock<IpFamily> = LazyLock::new(|| {
    // Resolve archlinux.org and probe its AAAA record with a short TCP connect.
    let ipv6_addr = ("archlinux.org", 443)
        .to_socket_addrs()
        .ok()
        .and_then(|addrs| addrs.into_iter().find(SocketAddr::is_ipv6));

    let Some(addr) = ipv6_addr else {
        return IpFamily::Any;
    };

    match TcpStream::connect_timeout(&addr, Duration::from_millis(500)) {
        Ok(_) => IpFamily::Any,
        Err(_) => IpFamily::Ipv4Only,
    }
});

pub fn detected_ip_family() -> IpFamily {
    *DETECTED_IP_FAMILY
}

static CANCELLED: AtomicBool = AtomicBool::new(false);

pub fn is_cancelled() -> bool {
    CANCELLED.load(AtomicOrdering::SeqCst)
}

pub fn reset_cancelled() {
    CANCELLED.store(false, AtomicOrdering::SeqCst);
}

pub const DEFAULT_MUTATION_TIMEOUT_SECS: u64 = 300;

pub struct TimeoutGuard {
    start: Instant,
    timeout: Duration,
}

impl TimeoutGuard {
    pub fn new(timeout_secs: u64) -> Self {
        Self {
            start: Instant::now(),
            timeout: Duration::from_secs(timeout_secs),
        }
    }

    pub fn is_timed_out(&self) -> bool {
        self.start.elapsed() >= self.timeout
    }

    pub fn elapsed_secs(&self) -> u64 {
        self.start.elapsed().as_secs()
    }

    pub fn timeout_secs(&self) -> u64 {
        self.timeout.as_secs()
    }
}

/// Install the cooperative-cancellation handler. ctrlc's `termination` feature
/// makes this catch SIGTERM (and SIGHUP) too, not just SIGINT, so cockpit's
/// `proc.close()` sets the CANCELLED flag instead of hard-killing the process.
/// Handlers poll `is_cancelled()` at safe points; a cancel arriving during an
/// alpm commit is therefore deferred until the commit finishes rather than
/// tearing the transaction apart mid-write.
pub fn setup_signal_handler() {
    static HANDLER_SET: AtomicBool = AtomicBool::new(false);

    reset_cancelled();

    if HANDLER_SET
        .compare_exchange(false, true, AtomicOrdering::SeqCst, AtomicOrdering::SeqCst)
        .is_err()
    {
        return;
    }

    if let Err(e) = ctrlc::set_handler(move || {
        CANCELLED.store(true, AtomicOrdering::SeqCst);
    }) {
        eprintln!("Warning: Failed to set signal handler: {}", e);
        HANDLER_SET.store(false, AtomicOrdering::SeqCst);
    }
}

pub fn emit_event(event: &StreamEvent) {
    if let Ok(json) = serde_json::to_string(event) {
        println!("{}", json);
        let _ = io::stdout().flush();
    }
}

pub fn emit_json<T: Serialize>(response: &T) -> Result<()> {
    println!("{}", serde_json::to_string(response)?);
    Ok(())
}

/// Path of a state or cache file under ~/.config/cockpit-pacman.
/// `file` must be a bare file name; path components are rejected.
pub fn config_path(file: &str) -> Result<std::path::PathBuf> {
    if file.is_empty() || file.contains('/') || file.contains("..") {
        anyhow::bail!("Invalid config file name: {}", file);
    }
    let home = std::env::var("HOME").context("HOME environment variable is not set")?;
    Ok(std::path::PathBuf::from(home)
        .join(".config/cockpit-pacman")
        .join(file))
}

/// Run `f` while holding an exclusive advisory lock on `lock_path`, serializing
/// concurrent backend invocations (each a separate process) that mutate the
/// same on-disk file. The lock is a dedicated sidecar file, never the data file
/// itself: the data file is replaced via rename, so a lock on its inode would
/// not cover a second writer that opens the path fresh. The sidecar is created
/// if absent and left in place between runs.
pub fn with_file_lock<F, R>(lock_path: &Path, f: F) -> Result<R>
where
    F: FnOnce() -> Result<R>,
{
    use fs2::FileExt;
    use std::fs::OpenOptions;

    if let Some(parent) = lock_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create directory for lock {:?}", lock_path))?;
    }

    let lock_file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)
        .with_context(|| format!("Failed to open lock file {:?}", lock_path))?;

    lock_file
        .lock_exclusive()
        .with_context(|| format!("Failed to acquire lock on {:?}", lock_path))?;

    // Lock is released when lock_file is dropped, including on early return.
    f()
}

/// Return a backup path of the form `{prefix}{unix_secs}` that does not yet
/// exist, advancing the second counter on collision. Callers hold the relevant
/// file lock, so the existence check is race-free against other backend
/// processes and two saves in the same wall-clock second won't clobber a
/// backup. The suffix stays a plain unix-seconds integer so the listing/restore
/// parsers keep working.
pub fn unique_backup_path(prefix: &str) -> String {
    let mut secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs();
    loop {
        let candidate = format!("{prefix}{secs}");
        if !Path::new(&candidate).exists() {
            return candidate;
        }
        secs += 1;
    }
}

/// Serialize `state` to `path` via a temp file and atomic rename, so a crash
/// mid-write can't leave a partially-written file. Shared by state and cache
/// writers across handlers.
pub fn write_json_atomic<T: Serialize>(path: &Path, state: &T) -> Result<()> {
    let file_name = path
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("Invalid state path: {:?}", path))?;

    let content = serde_json::to_string_pretty(state).context("Failed to serialize state")?;

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_nanos();
    let tid: String = format!("{:?}", std::thread::current().id())
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let base = file_name.to_string_lossy();
    let tmp_path = path.with_file_name(format!("{base}.{nanos}.{tid}.tmp"));

    let write_result = (|| -> Result<()> {
        let mut tmp = File::create(&tmp_path)
            .with_context(|| format!("Failed to create temp file {:?}", tmp_path))?;
        tmp.write_all(content.as_bytes())
            .with_context(|| format!("Failed to write temp file {:?}", tmp_path))?;
        let _ = tmp.sync_all();
        std::fs::rename(&tmp_path, path)
            .with_context(|| format!("Failed to rename {:?} to {:?}", tmp_path, path))?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = std::fs::remove_file(&tmp_path);
    }
    write_result
}

/// Classify an error message into a frontend ErrorCode by keyword. Returns None
/// when nothing matches confidently. Mirrors parseErrorCode in api.ts so both
/// ends agree on the same buckets.
pub fn classify_message(message: &str) -> Option<&'static str> {
    let lower = message.to_lowercase();
    if lower.contains("timed out") || lower.contains("timeout") {
        return Some("timeout");
    }
    if lower.contains("unable to lock database") || lower.contains("database is locked") {
        return Some("database_locked");
    }
    // Canonical network-error keyword list. Kept in sync with
    // NETWORK_ERROR_KEYWORDS / parseErrorCode in src/api.ts; the two can't share
    // code across the FFI boundary, so the list is mirrored deliberately.
    const NETWORK_ERROR_KEYWORDS: &[&str] = &[
        "network",
        "connection",
        "could not connect",
        "unable to connect",
        "could not resolve",
        "resolve host",
        "host not found",
        "name resolution",
        "temporary failure in name resolution",
        "dns",
        "failed retrieving file",
        "failed to retrieve",
        "download library error",
    ];
    if NETWORK_ERROR_KEYWORDS.iter().any(|kw| lower.contains(kw)) {
        return Some("network_error");
    }
    None
}

/// Classify an anyhow error chain into a frontend ErrorCode. Inspects ureq and
/// io errors in the chain first (authoritative), then falls back to keyword
/// matching on the rendered message.
pub fn classify_error(err: &anyhow::Error) -> Option<&'static str> {
    for cause in err.chain() {
        if let Some(ureq_err) = cause.downcast_ref::<ureq::Error>() {
            return Some(classify_ureq(ureq_err));
        }
        if let Some(io_err) = cause.downcast_ref::<io::Error>()
            && let Some(code) = classify_io(io_err.kind())
        {
            return Some(code);
        }
    }
    classify_message(&format!("{:#}", err))
}

fn classify_ureq(err: &ureq::Error) -> &'static str {
    use ureq::Error;
    match err {
        Error::Timeout(_) => "timeout",
        Error::HostNotFound | Error::ConnectionFailed => "network_error",
        Error::Io(io_err) => classify_io(io_err.kind()).unwrap_or("network_error"),
        Error::StatusCode(404) => "not_found",
        Error::Tls(_) => "network_error",
        _ => "network_error",
    }
}

fn classify_io(kind: io::ErrorKind) -> Option<&'static str> {
    use io::ErrorKind::*;
    match kind {
        TimedOut => Some("timeout"),
        ConnectionRefused | ConnectionReset | ConnectionAborted | NotConnected
        | HostUnreachable | NetworkUnreachable | AddrNotAvailable => Some("network_error"),
        _ => None,
    }
}

pub fn sort_with_direction<T, F>(items: &mut [T], ascending: bool, cmp_fn: F)
where
    F: Fn(&T, &T) -> Ordering,
{
    items.sort_by(|a, b| {
        let cmp = cmp_fn(a, b);
        if ascending { cmp } else { cmp.reverse() }
    });
}

pub enum CheckResult {
    Continue,
    Cancelled,
    TimedOut(u64),
}

pub fn check_cancel(timeout: &TimeoutGuard) -> CheckResult {
    if is_cancelled() {
        CheckResult::Cancelled
    } else if timeout.is_timed_out() {
        CheckResult::TimedOut(timeout.timeout_secs())
    } else {
        CheckResult::Continue
    }
}

pub fn emit_cancellation_complete(reason: &CheckResult) {
    match reason {
        CheckResult::Cancelled => {
            emit_event(&StreamEvent::Complete {
                success: false,
                message: Some("Operation cancelled by user".to_string()),
            });
        }
        CheckResult::TimedOut(secs) => {
            emit_event(&StreamEvent::Complete {
                success: false,
                message: Some(format!("Operation timed out after {} seconds", secs)),
            });
        }
        CheckResult::Continue => {}
    }
}

/// Get the pacman cache directory from environment, pacman.conf, or default.
pub fn get_cache_dir() -> String {
    if let Ok(dir) = std::env::var("PACMAN_CACHE_DIR") {
        return dir;
    }

    if let Ok(config) = pacmanconf::Config::new()
        && let Some(dir) = config.cache_dir.first()
    {
        return dir.clone();
    }

    "/var/cache/pacman/pkg".to_string()
}

/// Load package metadata from cached .pkg.tar files using alpm.
/// Skips files that fail to load (corrupted or partial downloads).
pub fn load_cache_packages(
    handle: &alpm::Alpm,
    cache_path: &std::path::Path,
) -> Vec<(std::fs::DirEntry, String, String, String)> {
    let entries = match std::fs::read_dir(cache_path) {
        Ok(rd) => rd,
        Err(_) => return Vec::new(),
    };

    entries
        .filter_map(|entry_result| {
            let entry = entry_result.ok()?;
            let path = entry.path();
            let filename = path.file_name()?.to_string_lossy().to_string();
            if !filename.ends_with(".pkg.tar.zst")
                && !filename.ends_with(".pkg.tar.xz")
                && !filename.ends_with(".pkg.tar.gz")
            {
                return None;
            }

            let pkg = match handle.pkg_load(path.to_str()?, false, alpm::SigLevel::NONE) {
                Ok(pkg) => pkg,
                Err(e) => {
                    eprintln!("Warning: skipping {}: {}", filename, e);
                    return None;
                }
            };

            Some((
                entry,
                filename,
                pkg.name().to_string(),
                pkg.version().to_string(),
            ))
        })
        .collect()
}

/// Parse a pacman package filename into (name, version, arch).
pub(crate) fn parse_package_filename(filename: &str) -> Option<(String, String, String)> {
    let base = filename
        .strip_suffix(".pkg.tar.zst")
        .or_else(|| filename.strip_suffix(".pkg.tar.xz"))
        .or_else(|| filename.strip_suffix(".pkg.tar.gz"))?;

    // Split into [arch, pkgrel, pkgver, ...name_parts]
    let parts: Vec<&str> = base.rsplitn(4, '-').collect();
    if parts.len() >= 4 {
        let arch = parts[0].to_string();
        let version = format!("{}-{}", parts[2], parts[1]);
        let pkg_name = parts[3..].join("-");
        Some((pkg_name, version, arch))
    } else {
        None
    }
}

/// Handle transaction commit errors with proper cancellation/timeout detection.
/// Returns Ok(true) if commit succeeded, Ok(false) if it was cancelled/timed out, Err on actual failure.
pub fn handle_commit_error(
    err_msg: &str,
    was_cancelled_before: bool,
    was_timed_out_before: bool,
    timeout: &TimeoutGuard,
    interrupted_message: &str,
) -> Result<bool> {
    let cancelled_during = !was_cancelled_before && is_cancelled();
    let timed_out_during = !was_timed_out_before && timeout.is_timed_out();
    let err_lower = err_msg.to_lowercase();
    let error_indicates_interrupt = err_lower.contains("interrupt")
        || err_lower.contains("cancel")
        || err_lower.contains("signal")
        || err_lower.contains("timeout");

    if cancelled_during || error_indicates_interrupt {
        emit_event(&StreamEvent::Complete {
            success: false,
            message: Some(interrupted_message.to_string()),
        });
        return Ok(false);
    } else if timed_out_during {
        emit_event(&StreamEvent::Complete {
            success: false,
            message: Some(format!(
                "Operation timed out after {} seconds",
                timeout.timeout_secs()
            )),
        });
        return Ok(false);
    }

    emit_event(&StreamEvent::Complete {
        success: false,
        message: Some(format!("Failed to commit transaction: {}", err_msg)),
    });
    Err(anyhow::anyhow!("Failed to commit transaction: {}", err_msg))
}

#[macro_export]
macro_rules! check_cancel_early {
    ($timeout:expr_2021) => {{
        let result = $crate::util::check_cancel($timeout);
        if !matches!(result, $crate::util::CheckResult::Continue) {
            $crate::util::emit_cancellation_complete(&result);
            return Ok(());
        }
    }};
}

#[cfg(test)]
mod tests {
    use super::config_path;

    #[test]
    fn config_path_rejects_path_components() {
        assert!(config_path("../etc/passwd").is_err());
        assert!(config_path("a/b.json").is_err());
        assert!(config_path("..").is_err());
        assert!(config_path("").is_err());
    }

    #[test]
    fn config_path_accepts_bare_file_names() {
        let path = config_path("news-cache.json").unwrap();
        assert!(path.ends_with(".config/cockpit-pacman/news-cache.json"));
    }
}
