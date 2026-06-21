use anyhow::Result;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant, UNIX_EPOCH};

use crate::models::{
    MirrorBackup, MirrorBackupListResponse, MirrorEntry, MirrorListResponse, MirrorStatus,
    MirrorStatusResponse, MirrorTestResult, RefreshMirrorsResponse, RestoreMirrorBackupResponse,
    SaveMirrorlistResponse, StreamEvent,
};
use crate::util::{TimeoutGuard, emit_event, emit_json, is_cancelled, setup_signal_handler};
use crate::validation::validate_mirror_url;

const MIRRORLIST_PATH: &str = "/etc/pacman.d/mirrorlist";
const LOCK_PATH: &str = "/etc/pacman.d/.mirrorlist.lock";
const TEST_FILE: &str = "core.db";
const MIN_COMPLETION: f64 = 0.9;
// core.db should be at least 100KB (100,000 bytes) to be valid
const MIN_CONTENT_LENGTH: u64 = 100_000;

pub fn list_mirrors() -> Result<()> {
    let path = Path::new(MIRRORLIST_PATH);

    if !path.exists() {
        anyhow::bail!("Mirrorlist not found at {}", MIRRORLIST_PATH);
    }

    let file = fs::File::open(path)?;
    let reader = BufReader::new(file);
    let mut mirrors = Vec::new();
    let mut pending_comment: Option<String> = None;

    for line in reader.lines() {
        let line = line?;
        let trimmed = line.trim();

        if trimmed.is_empty() {
            pending_comment = None;
            continue;
        }

        if trimmed.starts_with("##") {
            pending_comment = Some(trimmed.trim_start_matches('#').trim().to_string());
            continue;
        }

        if trimmed.starts_with('#') {
            let content = trimmed.trim_start_matches('#').trim();
            if content.starts_with("Server") {
                if let Some(url) = parse_server_line(content) {
                    mirrors.push(MirrorEntry {
                        url,
                        enabled: false,
                        comment: pending_comment.take(),
                    });
                }
            } else {
                pending_comment = Some(content.to_string());
            }
            continue;
        }

        if trimmed.starts_with("Server")
            && let Some(url) = parse_server_line(trimmed)
        {
            mirrors.push(MirrorEntry {
                url,
                enabled: true,
                comment: pending_comment.take(),
            });
        }
    }

    let metadata = fs::metadata(path)?;
    let last_modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);

    let enabled_count = mirrors.iter().filter(|m| m.enabled).count();

    let response = MirrorListResponse {
        total: mirrors.len(),
        enabled_count,
        mirrors,
        path: MIRRORLIST_PATH.to_string(),
        last_modified,
    };

    emit_json(&response)
}

fn parse_server_line(line: &str) -> Option<String> {
    let parts: Vec<&str> = line.splitn(2, '=').collect();
    if parts.len() == 2 {
        Some(parts[1].trim().to_string())
    } else {
        None
    }
}

fn status_agent() -> ureq::Agent {
    ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(30)))
            .ip_family(crate::util::detected_ip_family())
            .build(),
    )
}

pub fn fetch_mirror_status() -> Result<()> {
    let status = arch_mirror_client::fetch(&status_agent())?;

    let mirrors: Vec<MirrorStatus> = status
        .mirrors
        .into_iter()
        .map(|m| MirrorStatus {
            url: m.url,
            country: m.country,
            country_code: m.country_code,
            last_sync: m.last_sync,
            delay: m.delay,
            score: m.score,
            completion_pct: m.completion_pct,
            active: m.active.unwrap_or(false),
            ipv4: m.ipv4.unwrap_or(false),
            ipv6: m.ipv6.unwrap_or(false),
        })
        .collect();

    emit_json(&MirrorStatusResponse {
        total: mirrors.len(),
        mirrors,
        last_check: status.last_check,
    })
}

pub fn refresh_mirrors(
    count: usize,
    country: Option<&str>,
    protocol: &str,
    sort_by: &str,
) -> Result<()> {
    let status = arch_mirror_client::fetch(&status_agent())?;

    let candidates = arch_mirror_client::rank(
        status.mirrors,
        arch_mirror_client::Protocol::parse(protocol),
        country,
        MIN_COMPLETION,
        arch_mirror_client::SortBy::parse(sort_by),
        count,
    );

    let mirrors: Vec<MirrorEntry> = candidates
        .into_iter()
        .map(|m| {
            let comment = m.country;
            let base = m.url.trim_end_matches('/');
            MirrorEntry {
                url: format!("{base}/$repo/os/$arch"),
                enabled: true,
                comment,
            }
        })
        .collect();

    emit_json(&RefreshMirrorsResponse {
        total: mirrors.len(),
        mirrors,
        last_check: status.last_check,
    })
}

const MIRROR_TEST_CONCURRENCY: usize = 8;

pub fn test_mirrors(urls: &[String], timeout_secs: u64) -> Result<()> {
    setup_signal_handler();
    let timeout = TimeoutGuard::new(timeout_secs);

    let total = urls.len();
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(10)))
            .ip_family(crate::util::detected_ip_family())
            .build(),
    );

    // Probe mirrors concurrently with a bounded pool: the requests are
    // independent and I/O-bound, so a sequential loop costs ~N x per-request
    // timeout. Workers pull from a shared index; `completed` drives the progress
    // counter in completion order. emit_event locks stdout, so result lines never
    // interleave. Each worker stops pulling on cancel/timeout.
    let next = AtomicUsize::new(0);
    let completed = AtomicUsize::new(0);
    let workers = total.clamp(1, MIRROR_TEST_CONCURRENCY);

    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                loop {
                    if is_cancelled() || timeout.is_timed_out() {
                        break;
                    }
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= total {
                        break;
                    }
                    let url = &urls[i];
                    let result = test_single_mirror(&agent, url);
                    let current = completed.fetch_add(1, Ordering::Relaxed) + 1;
                    emit_event(&StreamEvent::MirrorTest {
                        url: url.clone(),
                        current,
                        total,
                        result,
                    });
                }
            });
        }
    });

    let complete = if is_cancelled() {
        StreamEvent::Complete {
            success: false,
            message: Some("Operation cancelled by user".to_string()),
        }
    } else if timeout.is_timed_out() {
        StreamEvent::Complete {
            success: false,
            message: Some(format!(
                "Operation timed out after {} seconds",
                timeout_secs
            )),
        }
    } else {
        StreamEvent::Complete {
            success: true,
            message: Some(format!("Tested {} mirrors", total)),
        }
    };
    emit_event(&complete);

    Ok(())
}

fn test_single_mirror(agent: &ureq::Agent, mirror_url: &str) -> MirrorTestResult {
    let base_url = mirror_url
        .replace("$repo", "core")
        .replace("$arch", "x86_64");
    let base_url = base_url.trim_end_matches('/');
    let test_url = format!("{}/{}", base_url, TEST_FILE);

    let start = Instant::now();

    match agent.head(&test_url).call() {
        Ok(response) => {
            let latency = start.elapsed().as_millis() as u64;

            // Validate Content-Length to ensure mirror serves valid content
            let content_length = response
                .headers()
                .get("content-length")
                .and_then(|h| h.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok());

            match content_length {
                Some(len) if len >= MIN_CONTENT_LENGTH => MirrorTestResult {
                    url: mirror_url.to_string(),
                    success: true,
                    speed_bps: None,
                    latency_ms: Some(latency),
                    error: None,
                },
                Some(len) => MirrorTestResult {
                    url: mirror_url.to_string(),
                    success: false,
                    speed_bps: None,
                    latency_ms: Some(latency),
                    error: Some(format!(
                        "Content-Length {} too small (expected >= {})",
                        len, MIN_CONTENT_LENGTH
                    )),
                },
                None => MirrorTestResult {
                    url: mirror_url.to_string(),
                    success: false,
                    speed_bps: None,
                    latency_ms: Some(latency),
                    error: Some("Missing Content-Length header".to_string()),
                },
            }
        }
        Err(e) => MirrorTestResult {
            url: mirror_url.to_string(),
            success: false,
            speed_bps: None,
            latency_ms: None,
            error: Some(e.to_string()),
        },
    }
}

const MAX_BACKUPS: usize = 5;
const BACKUP_DIR: &str = "/etc/pacman.d";
const BACKUP_NAME_PREFIX: &str = "mirrorlist.backup.";
const BACKUP_PREFIX: &str = "/etc/pacman.d/mirrorlist.backup.";

pub fn save_mirrorlist(mirrors: &[MirrorEntry]) -> Result<()> {
    for mirror in mirrors {
        validate_mirror_url(&mirror.url)?;
    }

    let path = Path::new(MIRRORLIST_PATH);
    let parent = path.parent().unwrap_or(Path::new("/etc/pacman.d"));

    // Build content first
    let mut content = String::new();
    content.push_str("##\n");
    content.push_str("## Arch Linux repository mirrorlist\n");
    content.push_str("## Generated by cockpit-pacman\n");
    content.push_str("##\n\n");

    for mirror in mirrors {
        if let Some(ref comment) = mirror.comment {
            content.push_str(&format!("## {}\n", comment));
        }
        if mirror.enabled {
            content.push_str(&format!("Server = {}\n", mirror.url));
        } else {
            content.push_str(&format!("#Server = {}\n", mirror.url));
        }
    }

    // Serialize the whole write/backup/rename/cleanup cycle against other
    // mirrorlist mutations (save, restore, delete) sharing this lock.
    let backup_path = crate::util::with_file_lock(Path::new(LOCK_PATH), || {
        // Write to temp file first (atomic write pattern)
        let temp_path = parent.join(format!(".mirrorlist.tmp.{}", std::process::id()));
        {
            let mut file = fs::File::create(&temp_path)?;
            file.write_all(content.as_bytes())?;
            file.sync_all()?;
        }

        // Create backup if original exists
        let backup_path = if path.exists() {
            let backup = crate::util::unique_backup_path(BACKUP_PREFIX);
            if let Err(e) = fs::copy(path, &backup) {
                let _ = fs::remove_file(&temp_path);
                return Err(e.into());
            }
            Some(backup)
        } else {
            None
        };

        // Atomic rename (on same filesystem)
        if let Err(e) = fs::rename(&temp_path, path) {
            let _ = fs::remove_file(&temp_path);
            return Err(e.into());
        }

        // Clean up old backups, keeping only the most recent MAX_BACKUPS
        cleanup_old_backups();

        Ok(backup_path)
    })?;

    let response = SaveMirrorlistResponse {
        success: true,
        backup_path,
        message: format!("Saved {} mirrors to {}", mirrors.len(), MIRRORLIST_PATH),
    };

    emit_json(&response)
}

fn count_mirrors_in_file(path: &Path) -> Result<(usize, usize)> {
    let file = fs::File::open(path)?;
    let reader = BufReader::new(file);
    let mut enabled = 0usize;
    let mut total = 0usize;

    for line in reader.lines() {
        let line = line?;
        let trimmed = line.trim();

        if trimmed.starts_with('#') {
            let content = trimmed.trim_start_matches('#').trim();
            if content.starts_with("Server") && parse_server_line(content).is_some() {
                total += 1;
            }
            continue;
        }

        if trimmed.starts_with("Server") && parse_server_line(trimmed).is_some() {
            enabled += 1;
            total += 1;
        }
    }

    Ok((enabled, total))
}

pub fn list_mirror_backups() -> Result<()> {
    let parent = Path::new("/etc/pacman.d");
    let mut backups: Vec<MirrorBackup> = Vec::new();

    for entry in fs::read_dir(parent)? {
        let entry = entry?;
        let name = match entry.file_name().into_string() {
            Ok(n) => n,
            Err(_) => continue,
        };

        let timestamp_str = match name.strip_prefix(BACKUP_NAME_PREFIX) {
            Some(s) => s,
            None => continue,
        };

        let timestamp: i64 = match timestamp_str.parse() {
            Ok(t) => t,
            Err(_) => continue,
        };

        let metadata = entry.metadata()?;
        let size = metadata.len();

        let (enabled_count, total_count) = count_mirrors_in_file(&entry.path()).unwrap_or((0, 0));

        let date = chrono::DateTime::from_timestamp(timestamp, 0)
            .map(|dt| dt.format("%Y-%m-%d %H:%M:%S UTC").to_string())
            .unwrap_or_else(|| "Unknown".to_string());

        backups.push(MirrorBackup {
            timestamp,
            date,
            enabled_count,
            total_count,
            size,
        });
    }

    backups.sort_by_key(|b| std::cmp::Reverse(b.timestamp));

    emit_json(&MirrorBackupListResponse { backups })
}

pub fn restore_mirror_backup(timestamp: i64) -> Result<()> {
    let backup_path = format!("{}{}", BACKUP_PREFIX, timestamp);

    let pre_restore_backup = crate::util::with_file_lock(Path::new(LOCK_PATH), || {
        let backup = Path::new(&backup_path);

        if !backup.exists() {
            anyhow::bail!("Backup not found: {}", backup_path);
        }

        let mirrorlist = Path::new(MIRRORLIST_PATH);

        // Create a backup of the current mirrorlist before restoring
        let pre_restore_backup = if mirrorlist.exists() {
            let path = crate::util::unique_backup_path(BACKUP_PREFIX);
            fs::copy(mirrorlist, &path)?;
            Some(path)
        } else {
            None
        };

        fs::copy(backup, mirrorlist)?;

        cleanup_old_backups();

        Ok(pre_restore_backup)
    })?;

    let response = RestoreMirrorBackupResponse {
        success: true,
        backup_path: pre_restore_backup,
        message: format!("Restored mirrorlist from backup {}", backup_path),
    };

    emit_json(&response)
}

pub fn delete_mirror_backup(timestamp: i64) -> Result<()> {
    let backup_path = format!("{}{}", BACKUP_PREFIX, timestamp);

    crate::util::with_file_lock(Path::new(LOCK_PATH), || {
        let backup = Path::new(&backup_path);

        if !backup.exists() {
            anyhow::bail!("Backup not found: {}", backup_path);
        }

        fs::remove_file(backup)?;
        Ok(())
    })?;

    emit_json(&RestoreMirrorBackupResponse {
        success: true,
        backup_path: None,
        message: format!("Deleted backup {}", backup_path),
    })
}

fn cleanup_old_backups() {
    crate::util::prune_old_backups(Path::new(BACKUP_DIR), BACKUP_NAME_PREFIX, MAX_BACKUPS);
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::parse_server_line;

    #[test]
    fn well_formed_server_line_returns_trimmed_url() {
        assert_eq!(
            parse_server_line("Server = https://mirror.example/$repo/os/$arch"),
            Some("https://mirror.example/$repo/os/$arch".to_string())
        );
    }

    #[test]
    fn line_without_equals_returns_none() {
        assert_eq!(parse_server_line("Server https://mirror.example/"), None);
    }

    #[test]
    fn empty_value_after_equals_returns_some_empty_string() {
        assert_eq!(parse_server_line("Key = "), Some("".to_string()));
    }

    #[test]
    fn leading_trailing_whitespace_around_value_is_trimmed() {
        assert_eq!(
            parse_server_line("Server =   https://mirror.example/   "),
            Some("https://mirror.example/".to_string())
        );
    }

    #[test]
    fn commented_server_line_returns_value_after_equals() {
        assert_eq!(
            parse_server_line("#Server = https://mirror.example/"),
            Some("https://mirror.example/".to_string())
        );
    }

    #[test]
    fn url_with_equals_in_query_param_preserves_full_value() {
        assert_eq!(
            parse_server_line("Server = https://example.com/?token=abc"),
            Some("https://example.com/?token=abc".to_string())
        );
    }
}
