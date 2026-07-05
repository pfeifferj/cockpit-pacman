use anyhow::{Context, Result};
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::VecDeque;
use std::fs::File;
use std::io::{self, BufRead, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::os::fd::FromRawFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, Condvar, LazyLock, Mutex, OnceLock};
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

/// Only sets the flag; the alpm callbacks re-issue the interrupt on the commit
/// thread, so a cancel never reaches libalpm from another thread.
pub fn request_cancel() {
    CANCELLED.store(true, AtomicOrdering::SeqCst);
}

/// Watch stdin for a "cancel" line; EOF or read error also cancels (the
/// channel is gone). Runs until process exit.
pub fn spawn_cancel_listener() {
    // Off fd 0 so a libalpm scriptlet inheriting stdin can't steal the cancel
    // line; scriptlets get /dev/null, we keep a private close-on-exec dup.
    let control_fd = unsafe {
        let dup = libc::dup(0);
        if dup < 0 {
            return;
        }
        libc::fcntl(dup, libc::F_SETFD, libc::FD_CLOEXEC);
        let devnull = libc::open(c"/dev/null".as_ptr(), libc::O_RDONLY);
        if devnull >= 0 {
            libc::dup2(devnull, 0);
            libc::close(devnull);
        }
        dup
    };

    std::thread::spawn(move || {
        // SAFETY: control_fd is a fresh dup owned solely by this thread.
        let file = unsafe { std::fs::File::from_raw_fd(control_fd) };
        let mut reader = io::BufReader::new(file);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => {
                    request_cancel();
                    return;
                }
                Ok(_) => {
                    if line.trim() == "cancel" {
                        request_cancel();
                    }
                }
            }
        }
    });
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

/// ctrlc's `termination` feature catches SIGTERM/SIGHUP too, so cockpit's
/// `proc.close()` requests a cancel instead of killing the process mid-commit.
pub fn setup_signal_handler() {
    static HANDLER_SET: AtomicBool = AtomicBool::new(false);

    reset_cancelled();

    if HANDLER_SET
        .compare_exchange(false, true, AtomicOrdering::SeqCst, AtomicOrdering::SeqCst)
        .is_err()
    {
        return;
    }

    if let Err(e) = ctrlc::set_handler(request_cancel) {
        eprintln!("Warning: Failed to set signal handler: {}", e);
        HANDLER_SET.store(false, AtomicOrdering::SeqCst);
    }
}

const EVENT_QUEUE_CAP: usize = 4096;

struct WriterState {
    buf: VecDeque<(String, bool)>,
    stop: bool,
    writing: bool,
}

struct WriterInner {
    state: Mutex<WriterState>,
    not_empty: Condvar,
    drained: Condvar,
}

static EVENT_WRITER: OnceLock<Arc<WriterInner>> = OnceLock::new();

/// Get (lazily starting) the background stdout writer. Streaming events are
/// enqueued by the alpm/main thread and drained here, so a stalled Cockpit
/// channel can never block the transaction (and, with DownloadUser, deadlock the
/// download child). The writer is created on first use, so non-streaming commands
/// never spawn it.
fn event_writer() -> &'static Arc<WriterInner> {
    EVENT_WRITER.get_or_init(|| {
        let inner = Arc::new(WriterInner {
            state: Mutex::new(WriterState {
                buf: VecDeque::new(),
                stop: false,
                writing: false,
            }),
            not_empty: Condvar::new(),
            drained: Condvar::new(),
        });
        let worker = Arc::clone(&inner);
        std::thread::spawn(move || writer_loop(&worker));
        inner
    })
}

fn writer_loop(inner: &WriterInner) {
    loop {
        let line = {
            let mut state = inner.state.lock().unwrap_or_else(|e| e.into_inner());
            while state.buf.is_empty() && !state.stop {
                state = inner
                    .not_empty
                    .wait(state)
                    .unwrap_or_else(|e| e.into_inner());
            }
            match state.buf.pop_front() {
                Some((line, _terminal)) => {
                    state.writing = true;
                    line
                }
                None => {
                    // stop requested and queue drained
                    inner.drained.notify_all();
                    return;
                }
            }
        };

        // Blocking write happens outside the lock: a stalled consumer parks this
        // thread only, never a producer. IO errors (dead pipe) are expected.
        let _ = write_line_flushed(&mut io::stdout().lock(), &line);

        let mut state = inner.state.lock().unwrap_or_else(|e| e.into_inner());
        state.writing = false;
        if state.buf.is_empty() {
            inner.drained.notify_all();
        }
    }
}

/// Enqueue a serialized event line for the background writer. Never blocks on
/// stdout.
pub fn emit_event(event: &StreamEvent) {
    let Ok(line) = serde_json::to_string(event) else {
        return;
    };
    let terminal = matches!(event, StreamEvent::Complete { .. });
    let inner = event_writer();
    let mut state = inner.state.lock().unwrap_or_else(|e| e.into_inner());
    enqueue_capped(&mut state.buf, (line, terminal), EVENT_QUEUE_CAP);
    inner.not_empty.notify_one();
}

/// Push an event onto the bounded queue. At capacity, evict the oldest
/// non-terminal (log/progress/download) entry to make room; terminal events
/// (Complete) are never dropped, so the frontend always receives the outcome.
fn enqueue_capped(buf: &mut VecDeque<(String, bool)>, item: (String, bool), cap: usize) {
    if buf.len() >= cap
        && let Some(pos) = buf.iter().position(|(_, terminal)| !*terminal)
    {
        buf.remove(pos);
    }
    buf.push_back(item);
}

/// Drain the event queue and stop the writer, waiting up to `timeout` for the
/// queue to flush (so a queued Complete reaches a live consumer). If the consumer
/// is dead the writer stays blocked in write(); we time out and let the process
/// exit reap it. No-op when no writer was started.
pub fn shutdown_event_writer(timeout: Duration) {
    let Some(inner) = EVENT_WRITER.get() else {
        return;
    };
    let mut state = inner.state.lock().unwrap_or_else(|e| e.into_inner());
    state.stop = true;
    inner.not_empty.notify_all();

    let deadline = Instant::now() + timeout;
    while !state.buf.is_empty() || state.writing {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let (next, res) = inner
            .drained
            .wait_timeout(state, remaining)
            .unwrap_or_else(|e| e.into_inner());
        state = next;
        if res.timed_out() {
            break;
        }
    }
}

fn write_line_flushed<W: Write>(w: &mut W, line: &str) -> io::Result<()> {
    writeln!(w, "{line}")?;
    w.flush()?;
    Ok(())
}

/// Serialize `event` and write it flushed. Only used by tests now (the writer
/// thread uses `write_line_flushed`); kept to validate the serialize+flush path.
#[cfg(test)]
fn write_event_flushed<W: Write>(w: &mut W, event: &StreamEvent) -> io::Result<()> {
    match serde_json::to_string(event) {
        Ok(json) => write_line_flushed(w, &json),
        Err(_) => Ok(()),
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
        .lock()
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

/// Given (path, filename-timestamp) pairs, return the paths to delete so only
/// the `keep` entries with the highest timestamps survive. Ranking is by the
/// timestamp embedded in the filename, never the file's mtime, so a restored or
/// copied backup (which gets a fresh mtime) is not mistaken for the newest.
pub fn backups_to_prune(mut entries: Vec<(PathBuf, i64)>, keep: usize) -> Vec<PathBuf> {
    if entries.len() <= keep {
        return Vec::new();
    }
    entries.sort_by_key(|(_, ts)| std::cmp::Reverse(*ts));
    entries.into_iter().skip(keep).map(|(p, _)| p).collect()
}

/// Remove all but the `keep` most recent backups in `parent` whose name starts
/// with `name_prefix`, ranked by the unix-seconds suffix in the filename. Files
/// whose suffix is not an integer are ignored (matching the listing logic), so
/// they neither count toward `keep` nor get deleted. Best-effort: scan and
/// remove failures are logged, not propagated, so cleanup never fails a save.
pub fn prune_old_backups(parent: &Path, name_prefix: &str, keep: usize) {
    let read_dir = match std::fs::read_dir(parent) {
        Ok(rd) => rd,
        Err(e) => {
            eprintln!(
                "Warning: failed to scan {:?} for old backups: {}",
                parent, e
            );
            return;
        }
    };

    let entries: Vec<(PathBuf, i64)> = read_dir
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let ts: i64 = name.strip_prefix(name_prefix)?.parse().ok()?;
            Some((entry.path(), ts))
        })
        .collect();

    for path in backups_to_prune(entries, keep) {
        if let Err(e) = std::fs::remove_file(&path) {
            eprintln!("Warning: failed to remove old backup {:?}: {}", path, e);
        }
    }
}

/// SIGINT a child (pacman traps it and defers to a safe point). `Some(grace)`
/// escalates to SIGKILL after the grace; a pacman child passes `None` because
/// a hard kill mid-commit corrupts the db and hooks have no safe upper bound.
pub(crate) fn terminate_child(
    child: &mut std::process::Child,
    grace: Option<Duration>,
) -> std::process::ExitStatus {
    use std::os::unix::process::ExitStatusExt;

    // SAFETY: kill(2) with a valid pid and signal number has no memory effects.
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGINT);
    }

    let deadline = grace.map(|g| Instant::now() + g);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status,
            Ok(None) => {
                if deadline.is_some_and(|d| Instant::now() >= d) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => break,
        }
    }

    let _ = child.kill();
    child.wait().unwrap_or_else(|_| {
        // Already reaped between the loop and here; report the SIGINT we sent.
        std::process::ExitStatus::from_raw(libc::SIGINT)
    })
}

/// Run a command and capture its output, killing it and returning an error if it
/// doesn't finish within `timeout`. `wait_with_output` drains stdout/stderr and
/// reaps on a worker thread (so a hung child can't deadlock on a full pipe),
/// bounded by `recv_timeout`; on timeout the child is SIGKILLed so the worker
/// unblocks. Used for systemctl calls, which can block on a wedged systemd.
pub(crate) fn output_with_timeout(
    mut cmd: std::process::Command,
    timeout: Duration,
) -> Result<std::process::Output> {
    use std::process::Stdio;
    use std::sync::mpsc;

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = cmd.spawn().context("Failed to spawn command")?;
    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });

    match rx.recv_timeout(timeout) {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(e)) => Err(e).context("Command failed"),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            // SAFETY: kill(2) with a valid pid + signal has no memory effects.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
            anyhow::bail!("Command timed out after {}s", timeout.as_secs())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            anyhow::bail!("Command worker terminated unexpectedly")
        }
    }
}

/// Serialize `state` to `path` via a temp file and atomic rename, so a crash
/// mid-write can't leave a partially-written file. Shared by state and cache
/// writers across handlers.
pub fn write_json_atomic<T: Serialize>(path: &Path, state: &T) -> Result<()> {
    write_json_atomic_inner(path, state, None)
}

/// Like [`write_json_atomic`], but chmods the file to `mode` before the rename
/// so the final file never appears with looser permissions, even briefly.
pub fn write_json_atomic_with_mode<T: Serialize>(path: &Path, state: &T, mode: u32) -> Result<()> {
    write_json_atomic_inner(path, state, Some(mode))
}

fn write_json_atomic_inner<T: Serialize>(path: &Path, state: &T, mode: Option<u32>) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

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
        if let Some(m) = mode {
            std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(m))
                .with_context(|| format!("Failed to set permissions on {:?}", tmp_path))?;
        }
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

/// Enumerate cache packages by parsing the filename for name/version instead of
/// opening each archive with pkg_load. Use for read/report paths (cache info,
/// downgrade listing); load_cache_packages stays for clean_cache, where only
/// alpm-verified packages should be removed. Files whose name doesn't parse are
/// skipped, matching load_cache_packages skipping files it can't load.
pub fn list_cache_packages(
    cache_path: &std::path::Path,
) -> Vec<(std::fs::DirEntry, String, String, String)> {
    let entries = match std::fs::read_dir(cache_path) {
        Ok(rd) => rd,
        Err(_) => return Vec::new(),
    };

    entries
        .filter_map(|entry_result| {
            let entry = entry_result.ok()?;
            let filename = entry.path().file_name()?.to_string_lossy().to_string();
            if !filename.ends_with(".pkg.tar.zst")
                && !filename.ends_with(".pkg.tar.xz")
                && !filename.ends_with(".pkg.tar.gz")
            {
                return None;
            }
            let (name, version, _) = parse_package_filename(&filename)?;
            Some((entry, filename, name, version))
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

/// Classify a failed commit: Ok(false) on cancel/timeout, Err on a real
/// failure. `cancelled` decides it, not the error text, since the abort
/// carries no reliable keyword and sniffing would mask real failures.
pub fn handle_commit_error(
    err_msg: &str,
    cancelled: bool,
    timeout: &TimeoutGuard,
    interrupted_message: &str,
) -> Result<bool> {
    if cancelled {
        emit_event(&StreamEvent::Complete {
            success: false,
            message: Some(interrupted_message.to_string()),
        });
        return Ok(false);
    } else if timeout.is_timed_out() {
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
    use super::{
        backups_to_prune, config_path, enqueue_capped, list_cache_packages, output_with_timeout,
        terminate_child, write_event_flushed, write_json_atomic_with_mode,
    };
    use crate::models::StreamEvent;
    use std::collections::VecDeque;
    use std::path::PathBuf;
    use std::time::Duration;

    fn ev(n: usize) -> (String, bool) {
        (format!("e{n}"), false)
    }

    #[test]
    fn enqueue_capped_drops_oldest_nonterminal_at_cap() {
        let mut buf: VecDeque<(String, bool)> = (0..4).map(ev).collect();
        enqueue_capped(&mut buf, ev(4), 4);
        let lines: Vec<&str> = buf.iter().map(|(l, _)| l.as_str()).collect();
        // oldest (e0) evicted, newest (e4) appended, size held at cap
        assert_eq!(lines, vec!["e1", "e2", "e3", "e4"]);
    }

    #[test]
    fn enqueue_capped_under_cap_just_appends() {
        let mut buf: VecDeque<(String, bool)> = (0..2).map(ev).collect();
        enqueue_capped(&mut buf, ev(2), 4);
        assert_eq!(buf.len(), 3);
    }

    #[test]
    fn enqueue_capped_never_drops_terminals() {
        // a full buffer of terminal events: pushing another keeps them all
        let mut buf: VecDeque<(String, bool)> = (0..3).map(|n| (format!("c{n}"), true)).collect();
        enqueue_capped(&mut buf, ("c3".to_string(), true), 3);
        let lines: Vec<&str> = buf.iter().map(|(l, _)| l.as_str()).collect();
        assert_eq!(lines, vec!["c0", "c1", "c2", "c3"]);

        // with one non-terminal present, that is the one evicted, terminal kept
        let mut buf2: VecDeque<(String, bool)> = VecDeque::new();
        buf2.push_back(("log".to_string(), false));
        buf2.push_back(("done".to_string(), true));
        enqueue_capped(&mut buf2, ("new".to_string(), false), 2);
        let lines2: Vec<&str> = buf2.iter().map(|(l, _)| l.as_str()).collect();
        assert_eq!(lines2, vec!["done", "new"]);
    }

    #[test]
    #[allow(clippy::unwrap_used)]
    fn list_cache_packages_parses_filenames_and_skips_others() {
        let dir = std::env::temp_dir().join(format!("cpac-cache-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for name in [
            "linux-6.7.0-1-x86_64.pkg.tar.zst",
            "glibc-2.39-1-x86_64.pkg.tar.xz",
            "not-a-package.txt",
            "garbage.pkg.tar.zst",
        ] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }

        let mut found: Vec<(String, String)> = list_cache_packages(&dir)
            .into_iter()
            .map(|(_, _, name, version)| (name, version))
            .collect();
        found.sort();

        assert_eq!(
            found,
            vec![
                ("glibc".to_string(), "2.39-1".to_string()),
                ("linux".to_string(), "6.7.0-1".to_string()),
            ],
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    #[allow(clippy::unwrap_used)]
    fn output_with_timeout_returns_output() {
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", "printf hello"]);
        let out = output_with_timeout(cmd, Duration::from_secs(5)).unwrap();
        assert!(out.status.success());
        assert_eq!(out.stdout, b"hello");
    }

    #[test]
    #[allow(clippy::unwrap_used)]
    fn output_with_timeout_kills_on_timeout() {
        let mut cmd = std::process::Command::new("sleep");
        cmd.arg("30");
        let start = std::time::Instant::now();
        let result = output_with_timeout(cmd, Duration::from_millis(200));
        assert!(result.is_err());
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[test]
    #[allow(clippy::unwrap_used)]
    fn emit_event_flushes_before_returning() {
        struct Tracker {
            buf: Vec<u8>,
            flushed: bool,
        }
        impl std::io::Write for Tracker {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.buf.extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                self.flushed = true;
                Ok(())
            }
        }

        let mut t = Tracker {
            buf: Vec::new(),
            flushed: false,
        };
        write_event_flushed(
            &mut t,
            &StreamEvent::Complete {
                success: true,
                message: None,
            },
        )
        .unwrap();

        assert!(t.flushed, "Complete must be flushed before returning");
        let line = String::from_utf8(t.buf).unwrap();
        assert!(line.ends_with('\n'));
        let v: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(v["type"], "complete");
        assert_eq!(v["success"], true);
    }

    #[test]
    fn request_cancel_sets_the_flag() {
        super::reset_cancelled();
        super::request_cancel();
        assert!(super::is_cancelled());
        super::reset_cancelled();
    }

    #[test]
    fn try_interrupt_without_transaction_is_noop() {
        crate::alpm::try_interrupt();
    }

    /// Losing ctrlc's "termination" feature would silently break SIGTERM
    /// survival for every transaction handler.
    #[test]
    #[allow(clippy::unwrap_used)]
    fn signal_handler_traps_sigterm() {
        super::setup_signal_handler();
        let status = std::fs::read_to_string("/proc/self/status").unwrap();
        let caught = status
            .lines()
            .find_map(|l| l.strip_prefix("SigCgt:"))
            .unwrap();
        let mask = u64::from_str_radix(caught.trim(), 16).unwrap();
        assert_ne!(
            mask & (1 << (libc::SIGTERM - 1)),
            0,
            "SIGTERM not in SigCgt; ctrlc 'termination' feature missing?"
        );
    }

    #[test]
    #[allow(clippy::unwrap_used)]
    fn terminate_child_graceful_exit() {
        use std::os::unix::process::ExitStatusExt;

        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let start = std::time::Instant::now();
        let status = terminate_child(&mut child, Some(Duration::from_secs(5)));
        // SIGINT ended it well before the grace window, no SIGKILL escalation.
        assert!(start.elapsed() < Duration::from_secs(5));
        assert_eq!(status.signal(), Some(libc::SIGINT));
    }

    // The wait-forever branch (child ignoring SIGINT) is left untested: it
    // would hang the suite.
    #[test]
    #[allow(clippy::unwrap_used)]
    fn terminate_child_without_grace_waits_for_exit() {
        use std::os::unix::process::ExitStatusExt;

        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let status = terminate_child(&mut child, None);
        assert_eq!(status.signal(), Some(libc::SIGINT));
    }

    #[test]
    #[allow(clippy::unwrap_used)]
    fn terminate_child_escalates_when_sigint_ignored() {
        use std::os::unix::process::ExitStatusExt;

        // The loop keeps the shell resident (no exec-into-sleep optimization) so
        // it actually stays alive ignoring SIGINT, forcing the SIGKILL path.
        let mut child = std::process::Command::new("sh")
            .args(["-c", "trap \"\" INT; while :; do sleep 1; done"])
            .spawn()
            .unwrap();
        // Let the shell install the trap before signalling, else SIGINT hits the
        // default disposition during startup and kills it before the loop.
        std::thread::sleep(Duration::from_millis(300));
        let status = terminate_child(&mut child, Some(Duration::from_millis(300)));
        assert_eq!(status.signal(), Some(libc::SIGKILL));
    }

    #[test]
    #[allow(clippy::unwrap_used)]
    fn write_json_atomic_with_mode_sets_0600() {
        use std::os::unix::fs::PermissionsExt;

        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("cpac-test-{}-{}.json", std::process::id(), nanos));

        write_json_atomic_with_mode(&path, &vec!["a", "b"], 0o600).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let read: Vec<String> =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(read, vec!["a", "b"]);

        // Overwriting an existing file replaces it atomically.
        write_json_atomic_with_mode(&path, &vec!["c"], 0o600).unwrap();
        let read: Vec<String> =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(read, vec!["c"]);

        std::fs::remove_file(&path).unwrap();
    }

    fn entry(ts: i64) -> (PathBuf, i64) {
        (
            PathBuf::from(format!("/etc/pacman.d/mirrorlist.backup.{ts}")),
            ts,
        )
    }

    #[test]
    fn backups_to_prune_keeps_highest_timestamps() {
        // Shuffled input order; the lowest two timestamps must be pruned
        // regardless of input or file mtime.
        let entries = vec![
            entry(4),
            entry(7),
            entry(1),
            entry(5),
            entry(3),
            entry(6),
            entry(2),
        ];
        let pruned = backups_to_prune(entries, 5);
        assert_eq!(pruned, vec![entry(2).0, entry(1).0]);
    }

    #[test]
    fn backups_to_prune_noop_under_cap() {
        let entries = vec![entry(1), entry(2), entry(3)];
        assert!(backups_to_prune(entries, 5).is_empty());
    }

    #[test]
    fn backups_to_prune_equal_to_cap() {
        let entries = vec![entry(1), entry(2), entry(3), entry(4), entry(5)];
        assert!(backups_to_prune(entries, 5).is_empty());
    }

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
