use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use crate::alpm::{
    InterventionFlags, SysupgradeOutcome, Verbosity, find_available_updates, get_handle,
    run_sysupgrade, setup_dl_cb, setup_log_cb,
};
use crate::config::{AppConfig, ScheduleConfigResponse, ScheduleMode, ScheduleSetResponse};
use crate::inhibit::ShutdownInhibitor;
use crate::models::{ScheduledRunEntry, ScheduledRunsResponse};
use crate::util::{
    CheckResult, TimeoutGuard, check_cancel, emit_json, setup_signal_handler, with_file_lock,
    with_file_read_lock, write_bytes_atomic_with_mode,
};
use crate::validation::{validate_max_packages, validate_schedule};

const LOG_DIR: &str = "/var/log/cockpit-pacman";
const LOG_PATH: &str = "/var/log/cockpit-pacman/scheduled.jsonl";
const LOG_LOCK_PATH: &str = "/var/log/cockpit-pacman/.scheduled.jsonl.lock";
// 0644 like pacman.log: the plugin reads the run history from an unprivileged
// session. Creation, rotation and the mode reset below must agree.
const LOG_DIR_MODE: u32 = 0o755;
const LOG_FILE_MODE: u32 = 0o644;
const MAX_LOG_SIZE_BYTES: u64 = 1024 * 1024; // 1MB max log size
const MAX_LOG_ENTRIES: usize = 1000;
const SCHEDULED_TIMEOUT_SECS: u64 = 1800;

#[derive(Serialize, Deserialize)]
struct LogEntry {
    timestamp: String,
    mode: String,
    success: bool,
    #[serde(default)]
    status: String,
    packages_checked: usize,
    packages_upgraded: usize,
    error: Option<String>,
    details: Vec<String>,
    // Absent on records written before it existed, and on ExecStopPost records,
    // which never saw the run start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    duration_secs: Option<u64>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    removed_stale_lock: bool,
}

impl LogEntry {
    /// `status` is "ok" | "skipped" | "failed"; `success` is kept in sync so old
    /// readers and the wire `success` flag stay correct.
    fn new(
        timestamp: String,
        mode: ScheduleMode,
        status: &str,
        packages_checked: usize,
        packages_upgraded: usize,
        error: Option<String>,
        details: Vec<String>,
    ) -> Self {
        LogEntry {
            timestamp,
            mode: mode.to_string(),
            success: status != "failed",
            status: status.to_string(),
            packages_checked,
            packages_upgraded,
            error,
            details,
            duration_secs: None,
            removed_stale_lock: false,
        }
    }

    fn took(mut self, started: std::time::Instant) -> Self {
        self.duration_secs = Some(started.elapsed().as_secs());
        self
    }

    /// Every entry a run can write carries this, not just the successful one:
    /// the evidence is about the previous run either way.
    fn after_stale_lock(mut self, removed: bool) -> Self {
        self.removed_stale_lock = removed;
        self
    }
}

/// Status for a run record, deriving from `success` when an older log entry has
/// no explicit `status` field.
fn derive_status(status: &str, success: bool) -> String {
    if !status.is_empty() {
        status.to_string()
    } else if success {
        "ok".to_string()
    } else {
        "failed".to_string()
    }
}

fn get_timestamp() -> String {
    chrono::Local::now()
        .format("%Y-%m-%dT%H:%M:%S%z")
        .to_string()
}

/// A failed write must not change what the process returns; returning unit
/// stops a caller reintroducing the coupling with `?`.
fn log_run(entry: &LogEntry) {
    if let Err(e) = write_run(entry) {
        eprintln!("failed to write scheduled run record: {:#}", e);
    }
}

fn write_run(entry: &LogEntry) -> Result<()> {
    fs::create_dir_all(LOG_DIR).context("Failed to create log directory")?;
    fs::set_permissions(LOG_DIR, fs::Permissions::from_mode(LOG_DIR_MODE))
        .context("Failed to set log directory permissions")?;

    // Hold the lock across the rotate-check and the append: otherwise a
    // concurrent writer can interleave a half-written line, or lose an append
    // into a file being rotated out from under it.
    with_file_lock(Path::new(LOG_LOCK_PATH), || {
        rotate_if_needed()?;

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(LOG_FILE_MODE)
            .open(LOG_PATH)
            .context("Failed to open log file")?;

        // .mode() applies only when the file is created, so an existing log
        // keeps whatever mode it already has otherwise.
        file.set_permissions(fs::Permissions::from_mode(LOG_FILE_MODE))
            .context("Failed to set log file permissions")?;

        let json = serde_json::to_string(entry)?;
        writeln!(file, "{}", json)?;
        Ok(())
    })
}

fn rotate_if_needed() -> Result<()> {
    rotate_if_needed_at(Path::new(LOG_PATH))
}

/// Trim without parsing: a rotation run by an older build must not drop fields
/// a newer one wrote.
fn rotate_if_needed_at(path: &Path) -> Result<()> {
    let size = match fs::metadata(path) {
        Ok(m) => m.len(),
        Err(_) => return Ok(()),
    };

    // Bytes, not text: a torn multibyte write must not make rotation fail, which
    // would take every later append down with it.
    let content = fs::read(path).context("Failed to read log for rotation")?;
    let lines: Vec<&[u8]> = content
        .split(|b| *b == b'\n')
        .filter(|l| !l.is_empty())
        .collect();

    if size <= MAX_LOG_SIZE_BYTES && lines.len() <= MAX_LOG_ENTRIES {
        return Ok(());
    }

    // `details` is unbounded, so one run can carry the file past the byte cap
    // with too few lines to trip the line cap.
    let mut kept = &lines[lines.len().saturating_sub(MAX_LOG_ENTRIES / 2)..];
    let budget = MAX_LOG_SIZE_BYTES as usize / 2;
    let mut bytes: usize = kept.iter().map(|l| l.len() + 1).sum();
    while kept.len() > 1 && bytes > budget {
        bytes -= kept[0].len() + 1;
        kept = &kept[1..];
    }

    let mut out = Vec::with_capacity(size as usize);
    for line in kept {
        out.extend_from_slice(line);
        out.push(b'\n');
    }

    write_bytes_atomic_with_mode(path, &out, LOG_FILE_MODE).context("Failed to replace rotated log")
}

use std::os::unix::fs::PermissionsExt;

pub fn get_schedule_config() -> Result<()> {
    let config = AppConfig::load()?;
    let response = ScheduleConfigResponse::from_config(&config.schedule);
    emit_json(&response)
}

pub fn set_schedule_config(
    enabled: Option<bool>,
    mode: Option<&str>,
    schedule: Option<&str>,
    max_packages: Option<usize>,
) -> Result<()> {
    // Validate inputs before modifying config
    if let Some(s) = schedule {
        validate_schedule(s)?;
    }
    if let Some(mp) = max_packages {
        validate_max_packages(mp)?;
    }

    // Latch a TERM instead of dying on it: the default disposition would tear
    // this down between the systemd apply and the config write.
    setup_signal_handler();

    // The apply reaches systemd before the config write, so a failed write
    // leaves the timer and config.json disagreeing.
    let mut previous = None;
    let mut applied = None;

    let result = AppConfig::update(|config| {
        previous = Some(config.clone());

        if let Some(e) = enabled {
            config.schedule.enabled = e;
        }
        if let Some(m) = mode {
            config.schedule.mode = m.parse()?;
        }
        if let Some(s) = schedule {
            config.schedule.schedule = s.to_string();
        }
        if let Some(mp) = max_packages {
            config.schedule.max_packages = mp;
        }
        // Must run before update() writes: on failure the closure returns Err
        // and config.json is left untouched, never claiming a timer state that
        // didn't take.
        config.apply_schedule_to_systemd()?;
        applied = Some(config.schedule.schedule.clone());
        Ok(config.clone())
    });

    let config = match result {
        Ok(config) => config,
        Err(e) => return Err(undo_apply(previous, applied, e)),
    };

    let response = ScheduleSetResponse {
        success: true,
        message: if config.schedule.enabled {
            format!("Schedule enabled with {} mode", config.schedule.mode)
        } else {
            "Schedule disabled".to_string()
        },
    };
    emit_json(&response)
}

/// `applied` is None when the failure came before the apply, leaving nothing to
/// undo. A failed undo is the one case where the timer and config.json really
/// do disagree.
fn undo_apply(
    previous: Option<AppConfig>,
    applied: Option<String>,
    cause: anyhow::Error,
) -> anyhow::Error {
    let (Some(applied), Some(previous)) = (applied, previous) else {
        return cause;
    };

    match previous.apply_schedule_to_systemd() {
        Ok(()) => cause.context("Failed to save the schedule, so the timer was left unchanged"),
        Err(undo) => cause.context(format!(
            "Failed to save the schedule and could not put the timer back: it is now on '{}' \
             while the saved configuration still says '{}' ({:#})",
            applied, previous.schedule.schedule, undo
        )),
    }
}

/// Entries oldest-first, skipping any line that does not parse. A single
/// unreadable line must not hide the entries after it.
fn parse_run_entries(content: &[u8]) -> Vec<ScheduledRunEntry> {
    content
        .split(|b| *b == b'\n')
        .filter_map(|line| serde_json::from_slice::<LogEntry>(line).ok())
        .map(|entry| ScheduledRunEntry {
            timestamp: entry.timestamp,
            mode: entry.mode,
            success: entry.success,
            status: derive_status(&entry.status, entry.success),
            packages_checked: entry.packages_checked,
            packages_upgraded: entry.packages_upgraded,
            error: entry.error,
            details: entry.details,
            duration_secs: entry.duration_secs,
            removed_stale_lock: entry.removed_stale_lock,
        })
        .collect()
}

pub fn get_scheduled_runs(offset: usize, limit: usize) -> Result<()> {
    // A shared lock, not the writer's: this runs unprivileged whenever the
    // session has not escalated, and taking the write lock would fail on the
    // root-owned directory before the log itself was ever opened.
    //
    // Only a missing log means "no runs yet". Path::exists() cannot say that:
    // it is equally false for a reader denied the directory.
    let content = with_file_read_lock(Path::new(LOG_LOCK_PATH), || match fs::read(LOG_PATH) {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).context("Failed to read run history"),
    })?;

    let mut runs = content
        .as_deref()
        .map(parse_run_entries)
        .unwrap_or_default();

    runs.reverse();
    let total = runs.len();
    let paginated: Vec<_> = runs.into_iter().skip(offset).take(limit).collect();

    let response = ScheduledRunsResponse {
        runs: paginated,
        total,
    };
    emit_json(&response)
}

/// True only for outcomes where the process died without running its own
/// logging. `timeout` is excluded on purpose: SendSIGKILL=no lets a timed-out
/// run finish and self-report (or wedge forever, in which case ExecStopPost
/// never fires), so recording it here would duplicate the run's own entry.
fn is_kill_result(result: &str) -> bool {
    matches!(result, "signal" | "core-dump" | "watchdog" | "oom-kill")
}

/// Called from the unit's ExecStopPost. Records a failed run only for an abrupt
/// kill, the one outcome scheduled_run() cannot report itself.
pub fn record_interrupted() -> Result<()> {
    let result = std::env::var("SERVICE_RESULT").unwrap_or_default();
    if !is_kill_result(&result) {
        return Ok(());
    }

    let mode = AppConfig::load()
        .map(|c| c.schedule.mode)
        .unwrap_or_default();
    let entry = LogEntry::new(
        get_timestamp(),
        mode,
        "failed",
        0,
        0,
        Some(format!("Run killed by systemd (result={result})")),
        Vec::new(),
    );
    log_run(&entry);
    Ok(())
}

pub fn scheduled_run() -> Result<()> {
    let config = AppConfig::load()?;

    let mut details = Vec::new();
    let timestamp = get_timestamp();
    let started = std::time::Instant::now();

    // Reaching here at all means the timer fired, so config.json and the timer
    // disagree. Recording the skip is the only way to tell that apart from a
    // timer that never fired, which looks identical: no entry either way.
    if !config.schedule.enabled {
        eprintln!("Scheduled upgrades not enabled, exiting");
        let entry = LogEntry::new(
            timestamp,
            config.schedule.mode,
            "skipped",
            0,
            0,
            None,
            vec![
                "Skipped: the timer fired while scheduled upgrades are disabled. The timer is \
                 active but the saved configuration is not; setting the schedule again will put \
                 them back in step."
                    .to_string(),
            ],
        );
        log_run(&entry.took(started));
        return Ok(());
    }

    // Set up signal handler and timeout guard
    setup_signal_handler();
    let _timeout_guard = TimeoutGuard::new(SCHEDULED_TIMEOUT_SECS);

    let ignored_packages = config.ignored_packages.clone();
    let mode = config.schedule.mode;
    let max_packages = config.schedule.max_packages;

    eprintln!("[{}] Starting scheduled {} run", timestamp, mode);

    // A locked db is logged as a skipped run; the unit intentionally has no
    // ConditionPathExists so the skip is recorded rather than silent. A lock
    // with no holder process is reaped first, so a crashed pacman doesn't make
    // every future run skip.
    let reaped_lock = match crate::handlers::lock::try_remove_stale_lock() {
        Ok(true) => {
            eprintln!("removed stale pacman database lock, continuing");
            details.push("Removed stale database lock (no holder process)".to_string());
            true
        }
        Ok(false) => false,
        Err(reason) => {
            eprintln!(
                "pacman database is locked ({}), skipping scheduled run",
                reason
            );
            let entry = LogEntry::new(
                timestamp,
                mode,
                "skipped",
                0,
                0,
                None,
                vec![format!("Skipped: pacman database locked ({})", reason)],
            );
            log_run(&entry.took(started));
            return Ok(());
        }
    };

    // Check for cancellation before starting
    if let CheckResult::Cancelled | CheckResult::TimedOut(_) = check_cancel(&_timeout_guard) {
        let entry = LogEntry::new(
            timestamp,
            mode,
            "failed",
            0,
            0,
            Some("Operation cancelled or timed out before starting".to_string()),
            details,
        );
        log_run(&entry.took(started).after_stale_lock(reaped_lock));
        anyhow::bail!("Operation cancelled or timed out");
    }

    let mut handle = get_handle()?;

    for pkg_name in &ignored_packages {
        handle.add_ignorepkg(pkg_name.as_str())?;
    }

    setup_log_cb(&mut handle);
    setup_dl_cb(&mut handle, Verbosity::Journal);

    eprintln!("Syncing package databases...");
    if let Err(e) = handle.syncdbs_mut().update(false) {
        let entry = LogEntry::new(
            timestamp,
            mode,
            "failed",
            0,
            0,
            Some(format!("Failed to sync databases: {}", e)),
            details,
        );
        log_run(&entry.took(started).after_stale_lock(reaped_lock));
        return Err(e.into());
    }

    // Check for cancellation after database sync
    if let CheckResult::Cancelled | CheckResult::TimedOut(_) = check_cancel(&_timeout_guard) {
        let entry = LogEntry::new(
            timestamp,
            mode,
            "failed",
            0,
            0,
            Some("Operation cancelled or timed out after database sync".to_string()),
            details,
        );
        log_run(&entry.took(started).after_stale_lock(reaped_lock));
        anyhow::bail!("Operation cancelled or timed out");
    }

    let updates = find_available_updates(&handle, &ignored_packages);
    // Ignored packages are still listed, so the UI can show them held back, but
    // the handle carries them as IgnorePkg and the upgrade will not touch them.
    // Counting them inflates the record and can trip the safety cap on work
    // that was never going to happen.
    let upgradable: Vec<_> = updates.iter().filter(|u| !u.ignored).collect();
    let packages_checked = upgradable.len();
    let held_back = updates.len() - packages_checked;

    if upgradable.is_empty() {
        eprintln!("No updates available ({held_back} held back)");
        let detail = if held_back > 0 {
            format!("No updates to apply ({held_back} held back by the ignore list)")
        } else {
            "No updates available".to_string()
        };
        let entry = LogEntry::new(timestamp, mode, "ok", 0, 0, None, vec![detail]);
        log_run(&entry.took(started).after_stale_lock(reaped_lock));
        return Ok(());
    }

    eprintln!("Found {packages_checked} package(s) with updates ({held_back} held back)");
    for update in &upgradable {
        details.push(format!("{} -> {}", update.name, update.new_version));
    }
    if held_back > 0 {
        details.push(format!("{held_back} held back by the ignore list"));
    }

    if mode == ScheduleMode::Check {
        eprintln!("Check mode: logging updates without applying");
        let entry = LogEntry::new(timestamp, mode, "ok", packages_checked, 0, None, details);
        log_run(&entry.took(started).after_stale_lock(reaped_lock));
        return Ok(());
    }

    if max_packages > 0 && packages_checked > max_packages {
        eprintln!(
            "Safety limit: {} updates exceed max_packages ({}), skipping upgrade",
            packages_checked, max_packages
        );
        let entry = LogEntry::new(
            timestamp,
            mode,
            "skipped",
            packages_checked,
            0,
            None,
            vec![format!(
                "Skipped: {} updates exceed safety limit of {}",
                packages_checked, max_packages
            )],
        );
        log_run(&entry.took(started).after_stale_lock(reaped_lock));
        return Ok(());
    }

    let flags = InterventionFlags::default();
    flags.install(&mut handle);

    let _inhibitor = ShutdownInhibitor::take("Applying scheduled package upgrade");

    let outcome = match run_sysupgrade(&mut handle, &_timeout_guard, Some(&flags)) {
        Ok(outcome) => outcome,
        Err(e) => {
            let entry = LogEntry::new(
                timestamp,
                mode,
                "failed",
                packages_checked,
                0,
                Some(format!("{:#}", e)),
                details,
            );
            log_run(&entry.took(started).after_stale_lock(reaped_lock));
            return Err(e);
        }
    };

    let (status, upgraded, error, detail_override) = outcome_to_log_parts(&outcome);
    eprintln!("Scheduled run finished: {}", status);
    let entry = LogEntry::new(
        timestamp,
        mode,
        status,
        packages_checked,
        upgraded,
        error.clone(),
        match detail_override {
            Some(detail) => vec![detail],
            None => details,
        },
    );
    log_run(&entry.took(started).after_stale_lock(reaped_lock));

    if status == "failed" {
        anyhow::bail!(error.unwrap_or_else(|| "Scheduled upgrade failed".to_string()));
    }
    Ok(())
}

/// Whether an alpm error adds anything to a skip record. A refused question
/// aborts the transaction with alpm's generic string, which appended after the
/// reason reads like a second, separate failure. The conflict arm carries
/// something real ("conflicting files"), so only the empty cases are dropped.
fn carries_a_cause(error: &str) -> bool {
    !matches!(
        error.trim().to_ascii_lowercase().as_str(),
        "" | "unexpected error"
    )
}

/// Map a sysupgrade outcome onto run-record fields:
/// (status, packages_upgraded, error, detail replacing the update list).
fn outcome_to_log_parts(
    outcome: &SysupgradeOutcome,
) -> (&'static str, usize, Option<String>, Option<String>) {
    match outcome {
        SysupgradeOutcome::Upgraded { packages } => ("ok", *packages, None, None),
        SysupgradeOutcome::NothingToDo => (
            "ok",
            0,
            None,
            Some("No packages to upgrade after preparation".to_string()),
        ),
        // Skipped, not failed, even when it was a commit that returned the
        // error: a refused question aborts before anything is applied, so the
        // run is a safe no-op awaiting a human.
        SysupgradeOutcome::Intervention { reasons, error } => (
            "skipped",
            0,
            None,
            Some(match error.as_deref().filter(|e| carries_a_cause(e)) {
                Some(e) => format!(
                    "Skipped: manual intervention required ({}); {}",
                    reasons.join(", "),
                    e
                ),
                None => format!(
                    "Skipped: manual intervention required ({})",
                    reasons.join(", ")
                ),
            }),
        ),
        SysupgradeOutcome::CancelledEarly(_) => (
            "failed",
            0,
            Some("Operation cancelled or timed out with nothing applied".to_string()),
            None,
        ),
        SysupgradeOutcome::Interrupted => (
            "failed",
            0,
            Some("Upgrade interrupted during commit".to_string()),
            None,
        ),
        SysupgradeOutcome::CompletedDespiteCancel { packages } => (
            "ok",
            *packages,
            None,
            Some("Upgrade finished before the cancel could take effect".to_string()),
        ),
        SysupgradeOutcome::SyncFailed(e) => (
            "failed",
            0,
            Some(format!("Failed to prepare upgrade: {}", e)),
            None,
        ),
        SysupgradeOutcome::PrepareFailed(e) => (
            "failed",
            0,
            Some(format!("Failed to prepare upgrade transaction: {}", e)),
            None,
        ),
        SysupgradeOutcome::CommitFailed(e) => (
            "failed",
            0,
            Some(format!("Failed to commit upgrade: {}", e)),
            None,
        ),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::{
        MAX_LOG_ENTRIES, MAX_LOG_SIZE_BYTES, SysupgradeOutcome, derive_status, is_kill_result,
        outcome_to_log_parts, parse_run_entries, rotate_if_needed_at, undo_apply,
    };
    use crate::util::CheckResult;
    use std::path::PathBuf;

    #[test]
    fn a_failure_before_the_apply_is_reported_as_itself() {
        let err = undo_apply(None, None, anyhow::anyhow!("Failed to write config"));

        assert_eq!(err.to_string(), "Failed to write config");
    }

    fn temp_log(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("cpac-sched-{}-{}.jsonl", tag, std::process::id()))
    }

    fn entry(ts: u32) -> String {
        format!(
            r#"{{"timestamp":"{ts}","mode":"check","success":true,"status":"ok","packages_checked":0,"packages_upgraded":0,"error":null,"details":[]}}"#
        )
    }

    #[test]
    fn rotation_keeps_lines_it_cannot_parse() {
        let path = temp_log("odd");
        let unknown = r#"{"timestamp":"1","mode":"check","success":true,"status":"ok","packages_checked":0,"packages_upgraded":0,"error":null,"details":[],"from_the_future":{"a":1}}"#;
        let garbage = "{not json at all";

        // Both odd lines must land in the newest half or the trim drops them
        // before the assertions can see them.
        let mut lines: Vec<String> = (0..MAX_LOG_ENTRIES as u32).map(entry).collect();
        lines.push(unknown.to_string());
        lines.push(garbage.to_string());
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();

        rotate_if_needed_at(&path).unwrap();

        let after = std::fs::read_to_string(&path).unwrap();
        assert!(
            after.contains("from_the_future"),
            "an unknown field must survive rotation verbatim"
        );
        assert!(
            after.contains(garbage),
            "an unparseable line must survive rotation"
        );
        assert!(after.contains(&entry(MAX_LOG_ENTRIES as u32 - 1)));
        assert!(
            !after.contains(&entry(0)),
            "rotation must still drop the oldest entries"
        );

        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn rotation_trims_to_half_and_keeps_the_newest() {
        let path = temp_log("trim");
        let total = MAX_LOG_ENTRIES as u32 + 10;
        let lines: Vec<String> = (0..total).map(entry).collect();
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();

        rotate_if_needed_at(&path).unwrap();

        let after = std::fs::read_to_string(&path).unwrap();
        let kept: Vec<&str> = after.lines().collect();
        assert_eq!(kept.len(), MAX_LOG_ENTRIES / 2);
        assert_eq!(kept[kept.len() - 1], entry(total - 1));
        assert_eq!(kept[0], entry(total - (MAX_LOG_ENTRIES / 2) as u32));

        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn rotation_survives_a_non_utf8_line() {
        let path = temp_log("binary");
        let mut raw: Vec<u8> = Vec::new();
        for line in (0..MAX_LOG_ENTRIES as u32).map(entry) {
            raw.extend_from_slice(line.as_bytes());
            raw.push(b'\n');
        }
        raw.extend_from_slice(&[0xff, 0xfe, b'\n']);
        raw.extend_from_slice(entry(9999).as_bytes());
        raw.push(b'\n');
        std::fs::write(&path, &raw).unwrap();

        rotate_if_needed_at(&path).unwrap();

        let after = std::fs::read(&path).unwrap();
        assert!(
            after.windows(2).any(|w| w == [0xff, 0xfe]),
            "invalid bytes must survive rotation"
        );
        assert!(
            String::from_utf8_lossy(&after).contains(&entry(9999)),
            "the entry after the invalid bytes must survive"
        );

        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn parse_run_entries_skips_bad_lines_without_truncating() {
        let content = format!("{}\n{{bad\n\n{}\n", entry(1), entry(2));
        let runs = parse_run_entries(content.as_bytes());

        assert_eq!(runs.len(), 2, "a bad line must skip only itself");
        assert_eq!(runs[0].timestamp, "1");
        assert_eq!(runs[1].timestamp, "2");
        assert_eq!(runs[0].status, "ok");
    }

    #[test]
    fn parse_run_entries_handles_invalid_utf8() {
        let mut content: Vec<u8> = Vec::new();
        content.extend_from_slice(&[0xff, 0xfe, b'\n']);
        content.extend_from_slice(entry(3).as_bytes());
        content.push(b'\n');

        let runs = parse_run_entries(&content);
        assert_eq!(runs.len(), 1, "invalid bytes must not hide later entries");
        assert_eq!(runs[0].timestamp, "3");
    }

    #[test]
    fn rotation_shrinks_an_oversized_log_with_few_lines() {
        let path = temp_log("fat");
        // Ten fat entries: well past the byte budget, nowhere near the line cap.
        let fat = format!(
            r#"{{"timestamp":"1","mode":"check","success":true,"status":"ok","packages_checked":0,"packages_upgraded":0,"error":null,"details":["{}"]}}"#,
            "x".repeat(150_000)
        );
        let before: Vec<String> = (0..10).map(|_| fat.clone()).collect();
        std::fs::write(&path, before.join("\n") + "\n").unwrap();
        let size_before = std::fs::metadata(&path).unwrap().len();
        assert!(size_before > MAX_LOG_SIZE_BYTES);

        rotate_if_needed_at(&path).unwrap();

        let size_after = std::fs::metadata(&path).unwrap().len();
        assert!(
            size_after <= MAX_LOG_SIZE_BYTES,
            "{size_before} -> {size_after} must fit the byte budget"
        );
        assert!(
            std::fs::read_to_string(&path).unwrap().lines().count() >= 1,
            "the newest entry must survive"
        );

        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn rotation_keeps_the_newest_entry_even_when_it_alone_is_oversized() {
        let path = temp_log("huge");
        let huge = format!(
            r#"{{"timestamp":"9","mode":"check","success":true,"status":"ok","packages_checked":0,"packages_upgraded":0,"error":null,"details":["{}"]}}"#,
            "x".repeat((MAX_LOG_SIZE_BYTES as usize) * 2)
        );
        std::fs::write(&path, format!("{}\n{}\n", entry(1), huge)).unwrap();

        rotate_if_needed_at(&path).unwrap();

        let after = std::fs::read_to_string(&path).unwrap();
        assert!(after.contains(r#""timestamp":"9""#), "newest must survive");
        assert!(!after.contains(&entry(1)), "the older entry must go first");

        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn rotation_leaves_a_small_log_untouched() {
        let path = temp_log("small");
        let before = (0..10).map(entry).collect::<Vec<_>>().join("\n") + "\n";
        std::fs::write(&path, &before).unwrap();

        rotate_if_needed_at(&path).unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn rotation_is_a_noop_when_there_is_no_log() {
        let path = temp_log("absent");
        let _ = std::fs::remove_file(&path);
        assert!(rotate_if_needed_at(&path).is_ok());
        assert!(!path.exists());
    }

    #[test]
    fn intervention_maps_to_skipped_at_every_stage() {
        // Prepare-time conflict: flag set and prepare errored.
        let prepare_conflict = SysupgradeOutcome::Intervention {
            reasons: vec!["conflicts detected"],
            error: Some("conflicting files".to_string()),
        };
        // Commit-time ImportKey refusal: flag set and commit errored.
        let commit_import = SysupgradeOutcome::Intervention {
            reasons: vec!["key imports required"],
            error: Some("required key missing from keyring".to_string()),
        };
        for (outcome, alpm_error) in [
            (prepare_conflict, "conflicting files"),
            (commit_import, "required key missing from keyring"),
        ] {
            let (status, upgraded, error, detail) = outcome_to_log_parts(&outcome);
            assert_eq!(status, "skipped");
            assert_eq!(upgraded, 0);
            assert_eq!(error, None);
            let detail = detail.unwrap();
            assert!(detail.starts_with("Skipped: manual intervention required ("));
            assert!(
                detail.ends_with(alpm_error),
                "the alpm error must land in the skip detail"
            );
        }

        let (_, _, _, detail) = outcome_to_log_parts(&SysupgradeOutcome::Intervention {
            reasons: vec!["conflicts detected", "key imports required"],
            error: None,
        });
        assert_eq!(
            detail.unwrap(),
            "Skipped: manual intervention required (conflicts detected, key imports required)"
        );

        for empty in ["unexpected error", "Unexpected error", "  ", ""] {
            let (_, _, _, detail) = outcome_to_log_parts(&SysupgradeOutcome::Intervention {
                reasons: vec!["key imports required"],
                error: Some(empty.to_string()),
            });
            assert_eq!(
                detail.unwrap(),
                "Skipped: manual intervention required (key imports required)",
                "{empty:?} must not be appended"
            );
        }
    }

    #[test]
    fn failures_keep_failed_status_and_error() {
        let cases = [
            SysupgradeOutcome::SyncFailed("e".into()),
            SysupgradeOutcome::PrepareFailed("e".into()),
            SysupgradeOutcome::CommitFailed("e".into()),
            SysupgradeOutcome::CancelledEarly(CheckResult::Cancelled),
            SysupgradeOutcome::CancelledEarly(CheckResult::TimedOut(1800)),
            SysupgradeOutcome::Interrupted,
        ];
        for outcome in cases {
            let (status, upgraded, error, _) = outcome_to_log_parts(&outcome);
            assert_eq!(status, "failed", "{outcome:?} must record failed");
            assert_eq!(upgraded, 0);
            assert!(error.is_some(), "{outcome:?} must carry an error");
        }
    }

    #[test]
    fn success_records_upgraded_count() {
        let (status, upgraded, error, detail) =
            outcome_to_log_parts(&SysupgradeOutcome::Upgraded { packages: 7 });
        assert_eq!((status, upgraded, error, detail), ("ok", 7, None, None));

        let (status, upgraded, _, detail) = outcome_to_log_parts(&SysupgradeOutcome::NothingToDo);
        assert_eq!(status, "ok");
        assert_eq!(upgraded, 0);
        assert_eq!(detail.unwrap(), "No packages to upgrade after preparation");
    }

    #[test]
    fn is_kill_result_matches_only_abrupt_kills() {
        for r in ["signal", "core-dump", "watchdog", "oom-kill"] {
            assert!(is_kill_result(r), "{r} should count as a kill");
        }
        // "timeout" is self-reported (SendSIGKILL=no), so it must not record here.
        for r in ["success", "exit-code", "timeout", "protocol", ""] {
            assert!(!is_kill_result(r), "{r} should not count as a kill");
        }
    }

    #[test]
    fn derive_status_uses_explicit_value() {
        assert_eq!(derive_status("skipped", true), "skipped");
        assert_eq!(derive_status("failed", false), "failed");
        assert_eq!(derive_status("ok", true), "ok");
    }

    #[test]
    fn derive_status_falls_back_to_success_when_absent() {
        assert_eq!(derive_status("", true), "ok");
        assert_eq!(derive_status("", false), "failed");
    }

    #[test]
    fn service_unit_never_sigkills_and_outlives_internal_guard() {
        const UNIT_PATH: &str = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../systemd/cockpit-pacman-scheduled.service"
        );
        let unit =
            std::fs::read_to_string(UNIT_PATH).unwrap_or_else(|e| panic!("read {UNIT_PATH}: {e}"));

        // systemd honors the last occurrence of a directive.
        let last_value = |key: &str| unit.lines().rev().find_map(|l| l.trim().strip_prefix(key));

        assert_eq!(
            last_value("SendSIGKILL="),
            Some("no"),
            "unit must set SendSIGKILL=no"
        );

        // control-group would TERM mkinitcpio and dkms hooks directly, which
        // know nothing of the backend's cooperative cancel.
        assert_eq!(
            last_value("KillMode="),
            Some("mixed"),
            "unit must TERM only the main process"
        );

        // Kernel OOM is the one SIGKILL SendSIGKILL=no cannot forbid.
        assert_eq!(
            last_value("OOMScoreAdjust="),
            Some("-500"),
            "unit must deprioritize the commit as an OOM victim"
        );
        assert_eq!(
            last_value("OOMPolicy="),
            Some("continue"),
            "a child's OOM kill must not stop a commit in progress"
        );

        assert_eq!(
            last_value("LogRateLimitIntervalSec="),
            Some("0"),
            "unit must exempt its own output from journald rate limiting"
        );

        let stop_timeout: u64 = last_value("TimeoutStopSec=")
            .expect("unit must set TimeoutStopSec")
            .parse()
            .expect("TimeoutStopSec must be plain seconds");
        assert!(
            stop_timeout >= 300,
            "TimeoutStopSec ({stop_timeout}s) must give a commit real shutdown grace"
        );

        // Absent TimeoutStartSec is safe: Type=oneshot defaults it to infinity.
        if let Some(value) = last_value("TimeoutStartSec=") {
            let start_timeout: u64 = value
                .parse()
                .expect("TimeoutStartSec must be plain seconds");
            assert!(
                start_timeout >= 2 * super::SCHEDULED_TIMEOUT_SECS,
                "TimeoutStartSec ({start_timeout}s) must be at least 2x SCHEDULED_TIMEOUT_SECS ({}s)",
                super::SCHEDULED_TIMEOUT_SECS
            );
        }
    }
}
