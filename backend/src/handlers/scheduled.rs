use alpm::{AnyQuestion, Question, TransFlag};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::alpm::{
    TransactionGuard, find_available_updates, get_handle, setup_dl_cb, setup_log_cb,
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
const SCHEDULED_TIMEOUT_SECS: u64 = 1800; // 30 minutes

#[derive(Serialize, Deserialize)]
struct LogEntry {
    timestamp: String,
    mode: String,
    success: bool,
    packages_checked: usize,
    packages_upgraded: usize,
    error: Option<String>,
    details: Vec<String>,
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

/// Trim the log when it exceeds either the size or the entry-count cap, keeping
/// the most recent half. Rewrites via a temp file + rename so an unlocked
/// reader (get_scheduled_runs) never observes a partially-rewritten file.
/// Callers must hold the log lock.
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
        Ok(config.clone())
    })?;

    config.apply_schedule_to_systemd()?;

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

    // Check for cancellation before starting
    if let CheckResult::Cancelled | CheckResult::TimedOut(_) = check_cancel(&_timeout_guard) {
        let entry = LogEntry {
            timestamp,
            mode: mode.to_string(),
            success: false,
            packages_checked: 0,
            packages_upgraded: 0,
            error: Some("Operation cancelled or timed out before starting".to_string()),
            details,
        };
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
        let entry = LogEntry {
            timestamp,
            mode: mode.to_string(),
            success: false,
            packages_checked: 0,
            packages_upgraded: 0,
            error: Some(format!("Failed to sync databases: {}", e)),
            details,
        };
        log_run(&entry)?;
        return Err(e.into());
    }

    // Check for cancellation after database sync
    if let CheckResult::Cancelled | CheckResult::TimedOut(_) = check_cancel(&_timeout_guard) {
        let entry = LogEntry {
            timestamp,
            mode: mode.to_string(),
            success: false,
            packages_checked: 0,
            packages_upgraded: 0,
            error: Some("Operation cancelled or timed out after database sync".to_string()),
            details,
        };
        log_run(&entry)?;
        anyhow::bail!("Operation cancelled or timed out");
    }

    let updates = find_available_updates(&handle, &ignored_packages);
    let packages_checked = updates.len();

    if updates.is_empty() {
        eprintln!("No updates available");
        let entry = LogEntry {
            timestamp,
            mode: mode.to_string(),
            success: true,
            packages_checked: 0,
            packages_upgraded: 0,
            error: None,
            details: vec!["No updates available".to_string()],
        };
        log_run(&entry)?;
        return Ok(());
    }

    eprintln!("Found {} package(s) with updates", packages_checked);
    for update in &updates {
        details.push(format!("{} -> {}", update.name, update.new_version));
    }

    if mode == ScheduleMode::Check {
        eprintln!("Check mode: logging updates without applying");
        let entry = LogEntry {
            timestamp,
            mode: mode.to_string(),
            success: true,
            packages_checked,
            packages_upgraded: 0,
            error: None,
            details,
        };
        log_run(&entry)?;
        return Ok(());
    }

    if max_packages > 0 && packages_checked > max_packages {
        eprintln!(
            "Safety limit: {} updates exceed max_packages ({}), skipping upgrade",
            packages_checked, max_packages
        );
        let entry = LogEntry {
            timestamp,
            mode: mode.to_string(),
            success: true,
            packages_checked,
            packages_upgraded: 0,
            error: None,
            details: vec![format!(
                "Skipped: {} updates exceed safety limit of {}",
                packages_checked, max_packages
            )],
        };
        log_run(&entry)?;
        return Ok(());
    }

    let has_conflicts = Arc::new(AtomicBool::new(false));
    let has_removals = Arc::new(AtomicBool::new(false));
    let has_import_keys = Arc::new(AtomicBool::new(false));

    let conflicts_cb = Arc::clone(&has_conflicts);
    let removals_cb = Arc::clone(&has_removals);
    let import_keys_cb = Arc::clone(&has_import_keys);

    handle.set_question_cb(
        (),
        move |question: AnyQuestion, _: &mut ()| match question.question() {
            Question::Conflict(_) => conflicts_cb.store(true, Ordering::SeqCst),
            Question::RemovePkgs(_) => removals_cb.store(true, Ordering::SeqCst),
            Question::ImportKey(_) => import_keys_cb.store(true, Ordering::SeqCst),
            Question::Replace(_) => removals_cb.store(true, Ordering::SeqCst),
            _ => {}
        },
    );

    let mut tx = match TransactionGuard::new(&mut handle, TransFlag::NONE) {
        Ok(tx) => tx,
        Err(e) => {
            let entry = LogEntry {
                timestamp,
                mode: mode.to_string(),
                success: false,
                packages_checked,
                packages_upgraded: 0,
                error: Some(format!("{:#}", e)),
                details,
            };
            log_run(&entry)?;
            return Err(e);
        }
    };

    if let Err(e) = tx.sync_sysupgrade(false) {
        let entry = LogEntry {
            timestamp,
            mode: mode.to_string(),
            success: false,
            packages_checked,
            packages_upgraded: 0,
            error: Some(format!("Failed to prepare upgrade: {}", e)),
            details,
        };
        log_run(&entry)?;
        return Err(e.into());
    }

    let conflicts_detected = has_conflicts.load(Ordering::SeqCst);
    let removals_detected = has_removals.load(Ordering::SeqCst);
    let imports_detected = has_import_keys.load(Ordering::SeqCst);

    if tx.prepare().is_err() || conflicts_detected || removals_detected || imports_detected {
        eprintln!("Preflight check failed or manual intervention required, skipping");
        let mut reasons = Vec::new();
        if conflicts_detected {
            reasons.push("conflicts detected");
        }
        if removals_detected {
            reasons.push("package removals required");
        }
        if imports_detected {
            reasons.push("key imports required");
        }
        let entry = LogEntry {
            timestamp,
            mode: mode.to_string(),
            success: true,
            packages_checked,
            packages_upgraded: 0,
            error: None,
            details: vec![format!(
                "Skipped: manual intervention required ({})",
                reasons.join(", ")
            )],
        };
        log_run(&entry)?;
        return Ok(());
    }

    let packages_to_upgrade = tx.add().len();

    if packages_to_upgrade == 0 {
        eprintln!("No packages to upgrade after preparation");
        let entry = LogEntry {
            timestamp,
            mode: mode.to_string(),
            success: true,
            packages_checked,
            packages_upgraded: 0,
            error: None,
            details: vec!["No packages to upgrade after preparation".to_string()],
        };
        log_run(&entry)?;
        return Ok(());
    }

    // Final check before committing - this is the point of no return
    if let CheckResult::Cancelled | CheckResult::TimedOut(_) = check_cancel(&_timeout_guard) {
        let entry = LogEntry {
            timestamp,
            mode: mode.to_string(),
            success: false,
            packages_checked,
            packages_upgraded: 0,
            error: Some("Operation cancelled or timed out before commit".to_string()),
            details,
        };
        log_run(&entry)?;
        anyhow::bail!("Operation cancelled or timed out");
    }

    eprintln!(
        "Committing upgrade of {} package(s)...",
        packages_to_upgrade
    );

    if let Err(e) = tx.commit() {
        let entry = LogEntry {
            timestamp,
            mode: mode.to_string(),
            success: false,
            packages_checked,
            packages_upgraded: 0,
            error: Some(format!("Failed to commit upgrade: {}", e)),
            details,
        };
        log_run(&entry)?;
        return Err(e.into());
    }

    eprintln!("Upgrade completed successfully");
    let entry = LogEntry {
        timestamp,
        mode: mode.to_string(),
        success: true,
        packages_checked,
        packages_upgraded: packages_to_upgrade,
        error: None,
        details,
    };
    log_run(&entry)?;

    Ok(())
}
