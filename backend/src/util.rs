use anyhow::Result;
use serde::Serialize;
use std::cmp::Ordering;
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::time::{Duration, Instant};

use crate::models::StreamEvent;

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

/// Iterate over package files in the pacman cache directory.
/// Yields (DirEntry, filename, parsed_name, parsed_version) for each valid package file.
pub fn iter_cache_packages(
    cache_path: &std::path::Path,
) -> impl Iterator<Item = (std::fs::DirEntry, String, String, String)> {
    std::fs::read_dir(cache_path)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|entry_result| {
            let entry = entry_result.ok()?;
            let path = entry.path();
            let ext = path.extension()?;
            if ext != "zst" && ext != "xz" && ext != "gz" {
                return None;
            }
            let filename = path.file_name()?.to_string_lossy().to_string();
            let (name, version) = parse_package_filename(&filename)?;
            Some((entry, filename, name, version))
        })
}

/// Parse a pacman package filename into (name, version).
/// Handles .pkg.tar.zst, .pkg.tar.xz, and .pkg.tar.gz extensions.
/// Pacman filename format: {pkgname}-{pkgver}-{pkgrel}-{arch}.pkg.tar.{ext}
/// Returns None if the filename cannot be parsed.
pub fn parse_package_filename(filename: &str) -> Option<(String, String)> {
    let base = filename
        .strip_suffix(".pkg.tar.zst")
        .or_else(|| filename.strip_suffix(".pkg.tar.xz"))
        .or_else(|| filename.strip_suffix(".pkg.tar.gz"))?;

    // Split into [arch, pkgrel, pkgver, ...name_parts]
    let parts: Vec<&str> = base.rsplitn(4, '-').collect();
    if parts.len() >= 4 {
        // parts[0] = arch (ignored), parts[1] = pkgrel, parts[2] = pkgver
        let version = format!("{}-{}", parts[2], parts[1]);
        let pkg_name = parts[3..].join("-");
        Some((pkg_name, version))
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
