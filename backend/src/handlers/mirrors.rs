use anyhow::Result;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant, UNIX_EPOCH};

use crate::backups::{BackupStore, check_current_revision, file_revision, read_snapshot};
use crate::models::{
    BackupSource, MirrorBackup, MirrorBackupListResponse, MirrorEntry, MirrorListResponse,
    MirrorStatus, MirrorStatusResponse, MirrorTestResult, RefreshMirrorsResponse,
    RestoreMirrorBackupResponse, SaveMirrorlistResponse, StreamEvent,
};
use crate::util::{
    EntryCounts, TimeoutGuard, emit_event, emit_json, is_cancelled, setup_signal_handler,
};
use crate::validation::{validate_directive_value, validate_mirror_url};

const MIRRORLIST_PATH: &str = "/etc/pacman.d/mirrorlist";
const LOCK_PATH: &str = "/etc/pacman.d/.mirrorlist.lock";
const TEST_FILE: &str = "core.db";
const MIN_COMPLETION: f64 = 0.9;
// core.db should be at least 100KB (100,000 bytes) to be valid
const MIN_CONTENT_LENGTH: u64 = 100_000;

pub fn list_mirrors() -> Result<()> {
    let path = Path::new(MIRRORLIST_PATH);

    let (contents, revision) = read_snapshot(path)?;
    let reader = BufReader::new(contents.as_slice());
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

    let last_modified = fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64);

    let enabled_count = mirrors.iter().filter(|m| m.enabled).count();

    let response = MirrorListResponse {
        revision,
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

fn status_client() -> arch_http_client::Client {
    arch_http_client::Client::default()
}

pub fn fetch_mirror_status() -> Result<()> {
    crate::network::require_network()?;
    let url = crate::endpoints::endpoint(
        arch_mirror_client::STATUS_URL,
        "COCKPIT_PACMAN_TEST_MIRRORS_URL",
    )?;
    let status = arch_mirror_client::fetch_from(&status_client(), &url)?;

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
    crate::network::require_network()?;
    let url = crate::endpoints::endpoint(
        arch_mirror_client::STATUS_URL,
        "COCKPIT_PACMAN_TEST_MIRRORS_URL",
    )?;
    let status = arch_mirror_client::fetch_from(&status_client(), &url)?;

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
    crate::network::require_network()?;
    setup_signal_handler()?;
    let timeout = TimeoutGuard::new(timeout_secs);

    let total = urls.len();
    let client = arch_http_client::Client::new(arch_http_client::Options {
        timeout: Duration::from_secs(10),
        ..arch_http_client::Options::default()
    });

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
                    let result = test_single_mirror(&client, url);
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
            code: Some("cancelled".to_string()),
            details: None,
            message: Some("Operation cancelled by user".to_string()),
        }
    } else if timeout.is_timed_out() {
        StreamEvent::Complete {
            success: false,
            code: Some("timeout".to_string()),
            details: None,
            message: Some(format!(
                "Operation timed out after {} seconds",
                timeout_secs
            )),
        }
    } else {
        StreamEvent::Complete {
            success: true,
            code: None,
            details: None,
            message: Some(format!("Tested {} mirrors", total)),
        }
    };
    emit_event(&complete);

    Ok(())
}

fn test_single_mirror(client: &arch_http_client::Client, mirror_url: &str) -> MirrorTestResult {
    let base_url = mirror_url
        .replace("$repo", "core")
        .replace("$arch", "x86_64");
    let base_url = base_url.trim_end_matches('/');
    let test_url = format!("{}/{}", base_url, TEST_FILE);

    let start = Instant::now();

    match client.head(&test_url) {
        Ok(response) => {
            let latency = start.elapsed().as_millis() as u64;

            // Validate Content-Length to ensure mirror serves valid content
            let content_length = response
                .header("content-length")
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
const BACKUP_NAME_PREFIX: &str = "mirrorlist.backup.";
const BACKUP_PREFIX: &str = "/etc/pacman.d/mirrorlist.backup.";
const BACKUP_META_PATH: &str = "/etc/pacman.d/.mirrorlist-backups.meta.json";

pub fn save_mirrorlist(mirrors: &[MirrorEntry], expected_revision: &str) -> Result<()> {
    if !mirrors.iter().any(|m| m.enabled) {
        anyhow::bail!(
            "Invalid mirror list: no enabled mirrors, which would leave pacman \
             with nothing to sync from"
        );
    }

    for mirror in mirrors {
        validate_mirror_url(&mirror.url)?;
        if let Some(comment) = mirror.comment.as_deref().filter(|c| !c.is_empty()) {
            validate_directive_value(comment)?;
        }
    }

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

    let store = backup_store();
    let result = crate::util::with_file_lock(store.lock, || {
        check_current_revision(store.target, expected_revision)?;
        store.replace_locked(content.as_bytes(), BackupSource::Manual)
    })?;

    emit_json(&SaveMirrorlistResponse {
        revision: file_revision(content.as_bytes()),
        backup_timestamp: result.backup_timestamp,
        success: true,
        backup_path: result.backup_path,
        message: format!("Saved {} mirrors to {}", mirrors.len(), MIRRORLIST_PATH),
        warnings: result.warnings,
    })
}

fn backup_store() -> BackupStore<'static> {
    BackupStore {
        target: Path::new(MIRRORLIST_PATH),
        lock: Path::new(LOCK_PATH),
        manifest: Path::new(BACKUP_META_PATH),
        name_prefix: BACKUP_NAME_PREFIX,
        keep: MAX_BACKUPS,
    }
}

fn count_mirrors_in_file(path: &Path) -> Result<EntryCounts> {
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

    Ok(EntryCounts { enabled, total })
}

fn ensure_mirrors_restorable(backup: &Path) -> Result<()> {
    let enabled = count_mirrors_in_file(backup)?.enabled;
    if enabled == 0 {
        anyhow::bail!(
            "Backup {} has no enabled Server entries, refusing to restore",
            backup.display()
        );
    }
    Ok(())
}

pub fn list_mirror_backups() -> Result<()> {
    let (entries, warnings) = backup_store().list(count_mirrors_in_file)?;
    let backups = entries
        .into_iter()
        .map(|entry| MirrorBackup {
            timestamp: entry.timestamp,
            date: entry.date,
            enabled_count: entry.counts.enabled,
            total_count: entry.counts.total,
            size: entry.size,
            source: entry.source,
        })
        .collect();
    emit_json(&MirrorBackupListResponse { backups, warnings })
}

pub fn restore_mirror_backup(timestamp: i64) -> Result<()> {
    let result = backup_store().restore(timestamp, ensure_mirrors_restorable)?;
    emit_json(&RestoreMirrorBackupResponse {
        success: true,
        revision: Some(result.revision),
        backup_timestamp: result.backup_timestamp,
        backup_path: result.backup_path,
        message: format!("Restored mirrorlist from backup {BACKUP_PREFIX}{timestamp}"),
        warnings: result.warnings,
    })
}

pub fn undo_mirror_save(timestamp: i64, expected_revision: &str) -> Result<()> {
    emit_json(&backup_store().undo(timestamp, expected_revision, ensure_mirrors_restorable)?)
}

pub fn delete_mirror_backup(timestamp: i64) -> Result<()> {
    let warnings = backup_store().delete(timestamp)?;
    emit_json(&RestoreMirrorBackupResponse {
        success: true,
        revision: None,
        backup_timestamp: None,
        backup_path: None,
        message: format!("Deleted backup {BACKUP_PREFIX}{timestamp}"),
        warnings,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::{ensure_mirrors_restorable, parse_server_line};

    #[test]
    fn a_backup_whose_servers_are_all_commented_is_refused() {
        let path = std::env::temp_dir().join(format!("cpac-mirrors-{}", std::process::id()));
        let commented = "## Arch Linux mirrorlist\n#Server = https://a.example/$repo/os/$arch\n#Server = https://b.example/$repo/os/$arch\n";

        std::fs::write(&path, commented).unwrap();
        assert!(ensure_mirrors_restorable(&path).is_err());

        std::fs::write(
            &path,
            format!("Server = https://a.example/$repo/os/$arch\n{commented}"),
        )
        .unwrap();
        assert!(ensure_mirrors_restorable(&path).is_ok());

        std::fs::remove_file(&path).unwrap();
    }

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
