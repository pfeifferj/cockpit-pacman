use anyhow::{Context, Result};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use crate::models::{LogEntry, LogResponse};

const PACMAN_LOG_PATH: &str = "/var/log/pacman.log";

pub fn get_history(offset: usize, limit: usize, filter: Option<&str>) -> Result<()> {
    let log_path = Path::new(PACMAN_LOG_PATH);

    if !log_path.exists() {
        let response = LogResponse {
            entries: vec![],
            total: 0,
            total_upgraded: 0,
            total_installed: 0,
            total_removed: 0,
            total_other: 0,
        };
        println!("{}", serde_json::to_string(&response)?);
        return Ok(());
    }

    let file = File::open(log_path)
        .with_context(|| format!("Failed to open pacman log: {}", PACMAN_LOG_PATH))?;
    let reader = BufReader::new(file);

    let mut entries: Vec<LogEntry> = Vec::new();
    let mut total_upgraded = 0usize;
    let mut total_installed = 0usize;
    let mut total_removed = 0usize;
    let mut total_other = 0usize;

    for line in reader.lines().map_while(Result::ok) {
        if let Some(entry) = parse_log_line(&line) {
            match entry.action.as_str() {
                "upgraded" => total_upgraded += 1,
                "installed" => total_installed += 1,
                "removed" | "uninstalled" => total_removed += 1,
                _ => total_other += 1,
            }

            let matches_filter = match filter {
                Some("upgraded") => entry.action == "upgraded",
                Some("installed") => entry.action == "installed",
                Some("removed") => entry.action == "removed" || entry.action == "uninstalled",
                Some(_) | None => true,
            };

            if matches_filter {
                entries.push(entry);
            }
        }
    }

    entries.reverse();

    let total = entries.len();
    let paginated: Vec<LogEntry> = entries.into_iter().skip(offset).take(limit).collect();

    let response = LogResponse {
        entries: paginated,
        total,
        total_upgraded,
        total_installed,
        total_removed,
        total_other,
    };

    println!("{}", serde_json::to_string(&response)?);
    Ok(())
}

fn parse_log_line(line: &str) -> Option<LogEntry> {
    if !line.starts_with('[') {
        return None;
    }

    let timestamp_end = line.find(']')?;
    let timestamp = &line[1..timestamp_end];

    let rest = &line[timestamp_end + 2..];

    if !rest.starts_with("[ALPM]") && !rest.starts_with("[PACMAN]") {
        return None;
    }

    let source_end = rest.find(']')?;
    let source = &rest[1..source_end];

    let action_str = rest[source_end + 2..].trim();

    if action_str.is_empty() {
        return None;
    }

    let (action, package, old_version, new_version) = parse_action(action_str)?;

    Some(LogEntry {
        timestamp: timestamp.to_string(),
        source: source.to_string(),
        action,
        package,
        old_version,
        new_version,
    })
}

fn parse_action(s: &str) -> Option<(String, String, Option<String>, Option<String>)> {
    let parts: Vec<&str> = s.splitn(2, ' ').collect();
    if parts.len() < 2 {
        return None;
    }

    let action = parts[0].to_lowercase();
    let rest = parts[1];

    match action.as_str() {
        "upgraded" => {
            let paren_start = rest.find('(')?;
            let paren_end = rest.rfind(')')?;
            let package = rest[..paren_start].trim().to_string();
            let versions = &rest[paren_start + 1..paren_end];

            if let Some(arrow_pos) = versions.find(" -> ") {
                let old_version = versions[..arrow_pos].trim().to_string();
                let new_version = versions[arrow_pos + 4..].trim().to_string();
                Some((action, package, Some(old_version), Some(new_version)))
            } else {
                Some((action, package, None, None))
            }
        }
        "downgraded" => {
            let paren_start = rest.find('(')?;
            let paren_end = rest.rfind(')')?;
            let package = rest[..paren_start].trim().to_string();
            let versions = &rest[paren_start + 1..paren_end];

            if let Some(arrow_pos) = versions.find(" -> ") {
                let old_version = versions[..arrow_pos].trim().to_string();
                let new_version = versions[arrow_pos + 4..].trim().to_string();
                Some((action, package, Some(old_version), Some(new_version)))
            } else {
                Some((action, package, None, None))
            }
        }
        "installed" => {
            let paren_start = rest.find('(')?;
            let paren_end = rest.rfind(')')?;
            let package = rest[..paren_start].trim().to_string();
            let version = rest[paren_start + 1..paren_end].trim().to_string();
            Some((action, package, None, Some(version)))
        }
        "removed" | "uninstalled" => {
            let paren_start = rest.find('(')?;
            let paren_end = rest.rfind(')')?;
            let package = rest[..paren_start].trim().to_string();
            let version = rest[paren_start + 1..paren_end].trim().to_string();
            Some(("removed".to_string(), package, Some(version), None))
        }
        "reinstalled" => {
            let paren_start = rest.find('(')?;
            let paren_end = rest.rfind(')')?;
            let package = rest[..paren_start].trim().to_string();
            let version = rest[paren_start + 1..paren_end].trim().to_string();
            Some((action, package, Some(version.clone()), Some(version)))
        }
        _ => None,
    }
}
