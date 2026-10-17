use anyhow::{Context, Result};
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::VecDeque;
use std::fs::File;
use std::io::{self, BufRead, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

use crate::models::StreamEvent;

static CANCELLED: AtomicBool = AtomicBool::new(false);

pub fn is_cancelled() -> bool {
    CANCELLED.load(AtomicOrdering::SeqCst)
}

#[cfg(test)]
pub fn reset_cancelled() {
    CANCELLED.store(false, AtomicOrdering::SeqCst);
}

/// Requests cancellation at the next safe checkpoint.
pub fn request_cancel() {
    CANCELLED.store(true, AtomicOrdering::SeqCst);
}

pub fn spawn_cancel_listener() -> Result<()> {
    // Keep scriptlets on /dev/null and the control pipe private to this process.
    let descriptor = unsafe { libc::dup(libc::STDIN_FILENO) };
    if descriptor < 0 {
        return Err(io::Error::last_os_error()).context("Cannot duplicate cancellation channel");
    }
    // SAFETY: dup returned a new descriptor owned by this File.
    let file = unsafe { File::from_raw_fd(descriptor) };
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error()).context("Cannot protect cancellation channel");
    }
    let devnull = File::open("/dev/null")?;
    if unsafe { libc::dup2(devnull.as_raw_fd(), libc::STDIN_FILENO) } < 0 {
        return Err(io::Error::last_os_error()).context("Cannot isolate scriptlet input");
    }
    std::thread::Builder::new()
        .name("cancellation".into())
        .spawn(move || {
            let mut reader = io::BufReader::new(file);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => {
                        request_cancel();
                        journal_note(
                            "control channel closed; \
                         work not yet applied will stop, an upgrade already \
                         applying will run to completion",
                        );
                        return;
                    }
                    Ok(_) => {
                        if line.trim() == "cancel" {
                            request_cancel();
                        }
                    }
                }
            }
        })
        .context("Cannot start cancellation listener")?;
    Ok(())
}

pub fn journal_note(message: &str) {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let Ok(mut child) = Command::new("systemd-cat")
        .args(["-t", "cockpit-pacman", "-p", "warning"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    if let Some(mut stdin) = child.stdin.take() {
        // Keep the write within PIPE_BUF even if the journal reader stalls.
        let mut end = message.len().min(4095);
        while !message.is_char_boundary(end) {
            end -= 1;
        }
        let _ = writeln!(stdin, "{}", &message[..end]);
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    while matches!(child.try_wait(), Ok(None)) {
        if Instant::now() >= deadline {
            let _ = child.kill();
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = child.wait();
}

pub fn mtime_secs(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs() as i64)
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

pub fn setup_signal_handler() -> Result<()> {
    static HANDLER: OnceLock<std::result::Result<(), String>> = OnceLock::new();
    HANDLER
        .get_or_init(|| ctrlc::set_handler(request_cancel).map_err(|e| e.to_string()))
        .as_ref()
        .map_err(|e| anyhow::anyhow!("Cannot install cancellation signal handler: {e}"))?;
    Ok(())
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EntryCounts {
    pub enabled: usize,
    pub total: usize,
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

/// Shared lock for readers. Opens read-only and never creates anything, so an
/// unprivileged reader can take it against a root-owned directory, which
/// with_file_lock cannot. A lock file that is busy, missing or unreadable falls
/// through to an unlocked read: the readers here already tolerate a torn line,
/// and refusing to read at all would be the worse failure.
pub fn with_file_read_lock<F, R>(lock_path: &Path, body: F) -> Result<R>
where
    F: FnOnce() -> Result<R>,
{
    let guard = match std::fs::File::open(lock_path) {
        Ok(file) => file.try_lock_shared().ok().map(|()| file),
        Err(_) => None,
    };

    let result = body();
    drop(guard);
    result
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

fn sync_parent_dir(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    File::open(parent)
        .and_then(|dir| dir.sync_all())
        .with_context(|| format!("Failed to sync directory {}", parent.display()))
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
        if let Some(m) = mode {
            std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(m))
                .with_context(|| format!("Failed to set permissions on {:?}", tmp_path))?;
        }
        tmp.sync_all()
            .with_context(|| format!("Failed to sync {}", tmp_path.display()))?;
        std::fs::rename(&tmp_path, path)
            .with_context(|| format!("Failed to rename {:?} to {:?}", tmp_path, path))?;
        sync_parent_dir(path)?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = std::fs::remove_file(&tmp_path);
    }
    write_result
}

/// Write `bytes` to `path` via a temp file in the same directory, fsync, then
/// atomically rename. Set `mode` before publishing the file. The caller must
/// hold the relevant file lock.
pub fn write_bytes_atomic_with_mode(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("Invalid path: {:?}", path))?;
    let tmp_path = parent.join(format!(
        ".{}.tmp.{}",
        file_name.to_string_lossy(),
        std::process::id()
    ));

    let write_result = (|| -> Result<()> {
        let mut tmp = File::create(&tmp_path)
            .with_context(|| format!("Failed to create temp file {:?}", tmp_path))?;
        tmp.write_all(bytes)
            .with_context(|| format!("Failed to write temp file {:?}", tmp_path))?;
        std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(mode))
            .with_context(|| format!("Failed to set permissions on {:?}", tmp_path))?;
        tmp.sync_all()
            .with_context(|| format!("Failed to sync {}", tmp_path.display()))?;
        std::fs::rename(&tmp_path, path)
            .with_context(|| format!("Failed to rename {:?} to {:?}", tmp_path, path))?;
        sync_parent_dir(path)?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = std::fs::remove_file(&tmp_path);
    }
    write_result
}

/// The error-code vocabulary shared with the frontend. The backend must never
/// emit a code outside this set; both ends pin it to test/fixtures/error-codes.json
/// so the two lists can't drift. Mirrors KNOWN_ERROR_CODES / ErrorCode in api.ts.
pub const ERROR_CODES: &[&str] = &[
    "timeout",
    "database_locked",
    "network_error",
    "transaction_failed",
    "validation_error",
    "cancelled",
    "not_found",
    "permission_denied",
    "internal_error",
];

/// Substrings that mark an error message as a network failure. Mirrored by
/// parseErrorCode in src/api.ts and pinned alongside ERROR_CODES.
pub const NETWORK_ERROR_KEYWORDS: &[&str] = &[
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

pub fn classify_message(message: &str) -> Option<&'static str> {
    let lower = message.to_lowercase();
    if lower.contains("timed out") || lower.contains("timeout") {
        return Some("timeout");
    }
    if lower.contains("unable to lock database") || lower.contains("database is locked") {
        return Some("database_locked");
    }
    if NETWORK_ERROR_KEYWORDS.iter().any(|kw| lower.contains(kw)) {
        return Some("network_error");
    }
    None
}

/// The frontend gives this streaming failure code precedence over the envelope's code.
pub fn failure_code(message: &str, fallback: &'static str) -> &'static str {
    classify_message(message).unwrap_or(fallback)
}

/// Emit a failed Complete for `message`, coded by [`failure_code`].
pub fn emit_failure(message: &str, fallback: &'static str) {
    emit_event(&StreamEvent::Complete {
        success: false,
        code: Some(failure_code(message, fallback).to_string()),
        details: None,
        message: Some(message.to_string()),
    });
}

/// Classify typed causes before falling back to the rendered error message.
pub fn classify_error(err: &anyhow::Error) -> Option<&'static str> {
    for cause in err.chain() {
        if matches!(
            cause.downcast_ref::<pacman_key::Error>(),
            Some(pacman_key::Error::Cancelled)
        ) {
            return Some("cancelled");
        }
        if let Some(http_error) = cause.downcast_ref::<arch_http_client::Error>() {
            return Some(classify_http(http_error));
        }
        if let Some(io_err) = cause.downcast_ref::<io::Error>()
            && let Some(code) = classify_io(io_err.kind())
        {
            return Some(code);
        }
    }
    classify_message(&format!("{:#}", err))
}

fn classify_http(error: &arch_http_client::Error) -> &'static str {
    match error {
        arch_http_client::Error::Timeout => "timeout",
        arch_http_client::Error::Status(404) => "not_found",
        _ => "network_error",
    }
}

fn classify_io(kind: io::ErrorKind) -> Option<&'static str> {
    use io::ErrorKind::*;
    match kind {
        PermissionDenied => Some("permission_denied"),
        TimedOut => Some("timeout"),
        ConnectionRefused | ConnectionReset | ConnectionAborted | NotConnected
        | AddrNotAvailable => Some("internal_error"),
        HostUnreachable | NetworkUnreachable => Some("network_error"),
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

pub fn cancellation_message(reason: &CheckResult) -> Option<String> {
    match reason {
        CheckResult::Cancelled => Some("Operation cancelled by user".to_string()),
        CheckResult::TimedOut(secs) => Some(format!("Operation timed out after {} seconds", secs)),
        CheckResult::Continue => None,
    }
}

pub fn emit_cancellation_complete(reason: &CheckResult) {
    if let Some(message) = cancellation_message(reason) {
        emit_event(&StreamEvent::Complete {
            success: false,
            code: Some(
                match reason {
                    CheckResult::TimedOut(_) => "timeout",
                    _ => "cancelled",
                }
                .to_string(),
            ),
            details: None,
            message: Some(message),
        });
    }
}

/// Get the configured pacman cache directory.
pub fn get_cache_dir() -> String {
    #[cfg(feature = "e2e-fixtures")]
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

pub fn handle_commit_error(
    err_msg: &str,
    cancelled: bool,
    interrupted_message: &str,
) -> Result<()> {
    let message = if cancelled {
        format!("Failed to commit transaction: {err_msg}. {interrupted_message}")
    } else {
        format!("Failed to commit transaction: {err_msg}")
    };
    emit_failure(&message, "transaction_failed");
    Err(anyhow::anyhow!(message))
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
        ERROR_CODES, classify_error, classify_message, config_path, enqueue_capped,
        list_cache_packages, output_with_timeout, write_bytes_atomic_with_mode,
        write_event_flushed, write_json_atomic_with_mode,
    };
    use crate::models::StreamEvent;
    use std::collections::VecDeque;
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
                code: None,
                details: None,
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
    #[allow(clippy::unwrap_used)]
    fn write_bytes_atomic_replaces_and_leaves_no_temp() {
        let dir = std::env::temp_dir().join(format!("cpac-atomic-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("mirrorlist");
        std::fs::write(&target, b"old contents").unwrap();

        write_bytes_atomic_with_mode(&target, b"new contents", 0o644).unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"new contents");
        let stray: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp."))
            .collect();
        assert!(stray.is_empty(), "temp file left behind: {stray:?}");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn classify_returns_none_for_unclassifiable_error() {
        assert_eq!(classify_message("something entirely unexpected"), None);
        assert_eq!(classify_error(&anyhow::anyhow!("weird failure")), None);
        assert!(classify_message("connection refused").is_some());
        // main.rs's unwrap_or fallback is only valid if internal_error is in the set.
        assert!(ERROR_CODES.contains(&"internal_error"));
    }

    #[test]
    fn a_failed_database_refresh_reads_as_a_network_error() {
        assert_eq!(
            classify_message("Failed to refresh package databases: failed to retrieve some files"),
            Some("network_error")
        );
    }

    #[test]
    fn every_classified_code_is_in_the_shared_vocabulary() {
        // classify_* return bare literals; this pins them to ERROR_CODES so the
        // backend can't emit a code the frontend doesn't know.
        let messages = [
            "operation timed out",
            "unable to lock database",
            "could not resolve host",
            "failed retrieving file from mirror",
            "not found",
            "permission denied",
        ];
        for msg in messages {
            if let Some(code) = classify_message(msg) {
                assert!(
                    ERROR_CODES.contains(&code),
                    "unknown code {code:?} for {msg:?}"
                );
            }
        }
        for msg in messages {
            if let Some(code) = classify_error(&anyhow::anyhow!("{msg}")) {
                assert!(
                    ERROR_CODES.contains(&code),
                    "unknown code {code:?} for {msg:?}"
                );
            }
        }
    }

    #[test]
    fn request_cancel_sets_the_flag() {
        super::reset_cancelled();
        super::request_cancel();
        assert!(super::is_cancelled());
        super::reset_cancelled();
    }

    /// Losing ctrlc's "termination" feature would silently break SIGTERM
    /// survival for every transaction handler.
    #[test]
    #[allow(clippy::unwrap_used)]
    fn signal_handler_traps_sigterm() {
        super::setup_signal_handler().unwrap();
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
