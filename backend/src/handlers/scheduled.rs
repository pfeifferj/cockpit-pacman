use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use crate::alpm::{
    InterventionFlags, SysupgradeOutcome, find_available_updates, get_handle, run_sysupgrade,
    setup_dl_cb, setup_log_cb,
};
use crate::config::{AppConfig, ScheduleConfigResponse, ScheduleMode, ScheduleSetResponse};
use crate::models::{ScheduledRunEntry, ScheduledRunsResponse};
use crate::util::{
    CheckResult, TimeoutGuard, check_cancel, emit_json, setup_signal_handler, with_file_lock,
};
use crate::validation::{validate_max_packages, validate_schedule};

const LOG_DIR: &str = "/var/log/cockpit-pacman";
const LOG_PATH: &str = "/var/log/cockpit-pacman/scheduled.jsonl";
const LOG_LOCK_PATH: &str = "/var/log/cockpit-pacman/.scheduled.jsonl.lock";
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
        }
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

fn log_run(entry: &LogEntry) -> Result<()> {
    fs::create_dir_all(LOG_DIR).context("Failed to create log directory")?;
    fs::set_permissions(LOG_DIR, fs::Permissions::from_mode(0o750))
        .context("Failed to set log directory permissions")?;

    // Hold the lock across the rotate-check and the append: otherwise a
    // concurrent writer can interleave a half-written line, or lose an append
    // into a file being rotated out from under it.
    with_file_lock(Path::new(LOG_LOCK_PATH), || {
        rotate_if_needed()?;

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o640)
            .open(LOG_PATH)
            .context("Failed to open log file")?;

        let json = serde_json::to_string(entry)?;
        writeln!(file, "{}", json)?;
        Ok(())
    })
}

fn rotate_if_needed() -> Result<()> {
    let path = Path::new(LOG_PATH);

    let size = match fs::metadata(path) {
        Ok(m) => m.len(),
        Err(_) => return Ok(()),
    };

    let mut entries: Vec<LogEntry> = Vec::new();
    {
        let file = fs::File::open(path).context("Failed to open log for rotation")?;
        let reader = BufReader::new(file);
        for line in reader.lines().map_while(Result::ok) {
            if let Ok(entry) = serde_json::from_str::<LogEntry>(&line) {
                entries.push(entry);
            }
        }
    }

    if size <= MAX_LOG_SIZE_BYTES && entries.len() <= MAX_LOG_ENTRIES {
        return Ok(());
    }

    let keep_count = MAX_LOG_ENTRIES / 2;
    if entries.len() > keep_count {
        entries = entries.split_off(entries.len() - keep_count);
    }

    let parent = path.parent().unwrap_or(Path::new(LOG_DIR));
    let tmp = parent.join(format!(".scheduled.jsonl.tmp.{}", std::process::id()));
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o640)
            .open(&tmp)
            .context("Failed to open temp log for writing")?;
        for entry in &entries {
            writeln!(file, "{}", serde_json::to_string(entry)?)?;
        }
        file.sync_all()?;
    }

    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e).context("Failed to replace rotated log");
    }

    Ok(())
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

    let config = AppConfig::update(|config| {
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
        Ok(config.clone())
    })?;

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

pub fn get_scheduled_runs(offset: usize, limit: usize) -> Result<()> {
    let mut runs = Vec::new();

    if Path::new(LOG_PATH).exists() {
        let file = fs::File::open(LOG_PATH).context("Failed to open log file")?;
        let reader = BufReader::new(file);

        for line in reader.lines().map_while(Result::ok) {
            if let Ok(entry) = serde_json::from_str::<LogEntry>(&line) {
                runs.push(ScheduledRunEntry {
                    timestamp: entry.timestamp,
                    mode: entry.mode,
                    success: entry.success,
                    status: derive_status(&entry.status, entry.success),
                    packages_checked: entry.packages_checked,
                    packages_upgraded: entry.packages_upgraded,
                    error: entry.error,
                    details: entry.details,
                });
            }
        }
    }

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
    log_run(&entry)
}

pub fn scheduled_run() -> Result<()> {
    let config = AppConfig::load()?;

    if !config.schedule.enabled {
        eprintln!("Scheduled upgrades not enabled, exiting");
        return Ok(());
    }

    // Set up signal handler and timeout guard
    setup_signal_handler();
    let _timeout_guard = TimeoutGuard::new(SCHEDULED_TIMEOUT_SECS);

    let ignored_packages = config.ignored_packages.clone();
    let mode = config.schedule.mode;
    let max_packages = config.schedule.max_packages;

    let mut details = Vec::new();
    let timestamp = get_timestamp();

    eprintln!("[{}] Starting scheduled {} run", timestamp, mode);

    // A locked db is logged as a skipped run; the unit intentionally has no
    // ConditionPathExists so the skip is recorded rather than silent. A lock
    // with no holder process is reaped first, so a crashed pacman doesn't make
    // every future run skip.
    match crate::handlers::lock::try_remove_stale_lock() {
        Ok(true) => {
            eprintln!("removed stale pacman database lock, continuing");
            details.push("Removed stale database lock (no holder process)".to_string());
        }
        Ok(false) => {}
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
            log_run(&entry)?;
            return Ok(());
        }
    }

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
        log_run(&entry)?;
        anyhow::bail!("Operation cancelled or timed out");
    }

    let mut handle = get_handle()?;

    for pkg_name in &ignored_packages {
        handle.add_ignorepkg(pkg_name.as_str())?;
    }

    setup_log_cb(&mut handle);
    setup_dl_cb(&mut handle);

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
        log_run(&entry)?;
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
        log_run(&entry)?;
        anyhow::bail!("Operation cancelled or timed out");
    }

    let updates = find_available_updates(&handle, &ignored_packages);
    let packages_checked = updates.len();

    if updates.is_empty() {
        eprintln!("No updates available");
        let entry = LogEntry::new(
            timestamp,
            mode,
            "ok",
            0,
            0,
            None,
            vec!["No updates available".to_string()],
        );
        log_run(&entry)?;
        return Ok(());
    }

    eprintln!("Found {} package(s) with updates", packages_checked);
    for update in &updates {
        details.push(format!("{} -> {}", update.name, update.new_version));
    }

    if mode == ScheduleMode::Check {
        eprintln!("Check mode: logging updates without applying");
        let entry = LogEntry::new(timestamp, mode, "ok", packages_checked, 0, None, details);
        log_run(&entry)?;
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
        log_run(&entry)?;
        return Ok(());
    }

    let flags = InterventionFlags::default();
    flags.install(&mut handle);

    let outcome = match run_sysupgrade(
        &mut handle,
        &_timeout_guard,
        Some(&flags),
        "Applying scheduled package upgrade",
    ) {
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
            log_run(&entry)?;
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
    log_run(&entry)?;

    if status == "failed" {
        anyhow::bail!(error.unwrap_or_else(|| "Scheduled upgrade failed".to_string()));
    }
    Ok(())
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
        SysupgradeOutcome::Intervention { reasons, .. } => (
            "skipped",
            0,
            None,
            Some(format!(
                "Skipped: manual intervention required ({})",
                reasons.join(", ")
            )),
        ),
        SysupgradeOutcome::CancelledEarly(_) => (
            "failed",
            0,
            Some("Operation cancelled or timed out before commit".to_string()),
            None,
        ),
        SysupgradeOutcome::Interrupted(CheckResult::TimedOut(secs)) => (
            "failed",
            0,
            Some(format!(
                "Upgrade timed out after {} seconds during commit",
                secs
            )),
            None,
        ),
        SysupgradeOutcome::Interrupted(_) => (
            "failed",
            0,
            Some("Upgrade interrupted during commit".to_string()),
            None,
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
mod tests {
    use super::{SysupgradeOutcome, derive_status, is_kill_result, outcome_to_log_parts};
    use crate::util::CheckResult;

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
        for outcome in [prepare_conflict, commit_import] {
            let (status, upgraded, error, detail) = outcome_to_log_parts(&outcome);
            assert_eq!(status, "skipped");
            assert_eq!(upgraded, 0);
            assert_eq!(error, None);
            assert!(
                detail
                    .unwrap()
                    .starts_with("Skipped: manual intervention required (")
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
    }

    #[test]
    fn failures_keep_failed_status_and_error() {
        let cases = [
            SysupgradeOutcome::SyncFailed("e".into()),
            SysupgradeOutcome::PrepareFailed("e".into()),
            SysupgradeOutcome::CommitFailed("e".into()),
            SysupgradeOutcome::CancelledEarly(CheckResult::Cancelled),
            SysupgradeOutcome::Interrupted(CheckResult::Cancelled),
            SysupgradeOutcome::Interrupted(CheckResult::TimedOut(1800)),
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
