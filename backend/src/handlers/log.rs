use anyhow::{Context, Result};
use std::collections::VecDeque;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use crate::models::{LogEntry, LogResponse};
use crate::util::get_log_path;

const CHUNK_SIZE: usize = 64 * 1024;

type LogCounts = (usize, usize, usize, usize);
type LogReadResult = (Vec<LogEntry>, LogCounts);

pub fn get_history(offset: usize, limit: usize, filter: Option<&str>) -> Result<()> {
    let log_path_str = get_log_path();
    let log_path = Path::new(&log_path_str);

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
        .with_context(|| format!("Failed to open pacman log: {}", log_path_str))?;

    let metadata = file.metadata()?;
    let file_size = metadata.len();

    if file_size == 0 {
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

    let entries_needed = offset + limit;
    let (entries, totals) = if file_size > 10 * 1024 * 1024 && entries_needed <= 1000 {
        read_log_reverse(&file, file_size, entries_needed, filter)?
    } else {
        read_log_forward(&file, filter)?
    };

    let total = entries.len();
    let paginated: Vec<LogEntry> = entries.into_iter().skip(offset).take(limit).collect();

    let response = LogResponse {
        entries: paginated,
        total,
        total_upgraded: totals.0,
        total_installed: totals.1,
        total_removed: totals.2,
        total_other: totals.3,
    };

    println!("{}", serde_json::to_string(&response)?);
    Ok(())
}

fn read_log_forward(file: &File, filter: Option<&str>) -> Result<LogReadResult> {
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
    Ok((
        entries,
        (total_upgraded, total_installed, total_removed, total_other),
    ))
}

fn read_log_reverse(
    file: &File,
    file_size: u64,
    entries_needed: usize,
    filter: Option<&str>,
) -> Result<LogReadResult> {
    let mut file = file.try_clone()?;
    let mut entries: VecDeque<LogEntry> = VecDeque::with_capacity(entries_needed);
    let mut leftover = String::new();
    let mut pos = file_size;
    let mut total_upgraded = 0usize;
    let mut total_installed = 0usize;
    let mut total_removed = 0usize;
    let mut total_other = 0usize;

    while pos > 0 && entries.len() < entries_needed {
        let chunk_size = std::cmp::min(pos, CHUNK_SIZE as u64);
        pos -= chunk_size;

        file.seek(SeekFrom::Start(pos))?;
        let mut buffer = vec![0u8; chunk_size as usize];
        file.read_exact(&mut buffer)?;

        let chunk_str = String::from_utf8_lossy(&buffer);
        let combined = format!("{}{}", chunk_str, leftover);
        let mut lines: Vec<&str> = combined.lines().collect();

        if pos > 0 && !lines.is_empty() {
            leftover = lines.remove(0).to_string();
        } else {
            leftover.clear();
        }

        for line in lines.into_iter().rev() {
            if let Some(entry) = parse_log_line(line) {
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
                    entries.push_front(entry);
                    if entries.len() >= entries_needed {
                        break;
                    }
                }
            }
        }
    }

    if !leftover.is_empty() && entries.len() < entries_needed {
        if let Some(entry) = parse_log_line(&leftover) {
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
                entries.push_front(entry);
            }
        }
    }

    Ok((
        entries.into_iter().collect(),
        (total_upgraded, total_installed, total_removed, total_other),
    ))
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
