use anyhow::Result;
use serde::Deserialize;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::check_cancel_early;
use crate::models::{
    MirrorEntry, MirrorListResponse, MirrorStatus, MirrorStatusResponse, MirrorTestResult,
    SaveMirrorlistResponse, StreamEvent,
};
use crate::util::{TimeoutGuard, emit_event, emit_json, setup_signal_handler};
use crate::validation::validate_mirror_url;

const MIRRORLIST_PATH: &str = "/etc/pacman.d/mirrorlist";
const MIRROR_STATUS_URL: &str = "https://archlinux.org/mirrors/status/json/";
const TEST_FILE: &str = "core.db";
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

#[derive(Deserialize)]
struct ApiMirrorStatus {
    urls: Vec<ApiMirror>,
    last_check: Option<String>,
}

#[derive(Deserialize)]
struct ApiMirror {
    url: String,
    country: Option<String>,
    country_code: Option<String>,
    last_sync: Option<String>,
    delay: Option<i64>,
    score: Option<f64>,
    completion_pct: Option<f64>,
    active: Option<bool>,
    ipv4: Option<bool>,
    ipv6: Option<bool>,
}

pub fn fetch_mirror_status() -> Result<()> {
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(30)))
            .build(),
    );

    let response = agent.get(MIRROR_STATUS_URL).call()?;
    let body = response.into_body().read_to_string()?;
    let api_status: ApiMirrorStatus = serde_json::from_str(&body)?;

    let mirrors: Vec<MirrorStatus> = api_status
        .urls
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

    let response = MirrorStatusResponse {
        total: mirrors.len(),
        mirrors,
        last_check: api_status.last_check,
    };

    emit_json(&response)
}

pub fn test_mirrors(urls: &[String], timeout_secs: u64) -> Result<()> {
    setup_signal_handler();
    let timeout = TimeoutGuard::new(timeout_secs);

    let total = urls.len();
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(10)))
            .build(),
    );

    for (i, url) in urls.iter().enumerate() {
        check_cancel_early!(&timeout);

        let current = i + 1;
        let result = test_single_mirror(&agent, url);

        emit_event(&StreamEvent::MirrorTest {
            url: url.clone(),
            current,
            total,
            result,
        });
    }

    emit_event(&StreamEvent::Complete {
        success: true,
        message: Some(format!("Tested {} mirrors", total)),
    });

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

    // Write to temp file first (atomic write pattern)
    let temp_path = parent.join(format!(".mirrorlist.tmp.{}", std::process::id()));
    {
        let mut file = fs::File::create(&temp_path)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
    }

    // Create backup if original exists
    let backup_path = if path.exists() {
        let backup = format!(
            "{}{}",
            BACKUP_PREFIX,
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs()
        );
        fs::copy(path, &backup)?;
        Some(backup)
    } else {
        None
    };

    // Atomic rename (on same filesystem)
    fs::rename(&temp_path, path)?;

    // Clean up old backups, keeping only the most recent MAX_BACKUPS
    cleanup_old_backups()?;

    let response = SaveMirrorlistResponse {
        success: true,
        backup_path,
        message: format!("Saved {} mirrors to {}", mirrors.len(), MIRRORLIST_PATH),
    };

    emit_json(&response)
}

fn cleanup_old_backups() -> Result<()> {
    let parent = Path::new("/etc/pacman.d");
    let mut backups: Vec<_> = fs::read_dir(parent)?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with("mirrorlist.backup."))
        })
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            let modified = metadata.modified().ok()?;
            Some((entry.path(), modified))
        })
        .collect();

    if backups.len() <= MAX_BACKUPS {
        return Ok(());
    }

    // Sort by modification time, newest first
    backups.sort_by(|a, b| b.1.cmp(&a.1));

    // Remove all but MAX_BACKUPS
    for (path, _) in backups.into_iter().skip(MAX_BACKUPS) {
        if let Err(e) = fs::remove_file(&path) {
            eprintln!("Warning: failed to remove old backup {:?}: {}", path, e);
        }
    }

    Ok(())
}
