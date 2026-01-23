use anyhow::Result;
use chrono::NaiveDateTime;
use pacman_log::{Action, LogReader};

use crate::models::{GroupedLogResponse, LogEntry, LogGroup, LogResponse};
use crate::util::emit_json;

const GROUP_THRESHOLD_SECS: i64 = 60;

struct LogStats {
    entries: Vec<LogEntry>,
    total_upgraded: usize,
    total_installed: usize,
    total_removed: usize,
    total_other: usize,
}

fn parse_filter(filter: Option<&str>) -> Option<Action> {
    filter.and_then(|f| match f {
        "upgraded" => Some(Action::Upgraded),
        "installed" => Some(Action::Installed),
        "removed" => Some(Action::Removed),
        _ => None,
    })
}

fn collect_log_entries(filter: Option<&str>) -> LogStats {
    let reader = LogReader::system();
    let filter_action = parse_filter(filter);

    let mut entries: Vec<LogEntry> = Vec::new();
    let mut total_upgraded = 0usize;
    let mut total_installed = 0usize;
    let mut total_removed = 0usize;
    let mut total_other = 0usize;

    for result in reader.reverse().into_iter() {
        let entry = match result {
            Ok(e) => e,
            Err(e) => {
                eprintln!("Warning: Failed to parse log entry: {}", e);
                continue;
            }
        };

        match entry.action {
            Action::Upgraded => total_upgraded += 1,
            Action::Installed => total_installed += 1,
            Action::Removed => total_removed += 1,
            Action::Downgraded | Action::Reinstalled => total_other += 1,
        }

        let matches_filter = match filter_action {
            Some(Action::Upgraded) => entry.action == Action::Upgraded,
            Some(Action::Installed) => entry.action == Action::Installed,
            Some(Action::Removed) => entry.action == Action::Removed,
            Some(_) | None => true,
        };

        if matches_filter {
            entries.push(LogEntry {
                timestamp: entry.timestamp.format("%Y-%m-%dT%H:%M:%S%z").to_string(),
                action: entry.action.to_string(),
                package: entry.package,
                old_version: entry.old_version,
                new_version: entry.new_version,
            });
        }
    }

    LogStats {
        entries,
        total_upgraded,
        total_installed,
        total_removed,
        total_other,
    }
}

pub fn get_history(offset: usize, limit: usize, filter: Option<&str>) -> Result<()> {
    let stats = collect_log_entries(filter);
    let total = stats.entries.len();
    let paginated: Vec<LogEntry> = stats.entries.into_iter().skip(offset).take(limit).collect();

    let response = LogResponse {
        entries: paginated,
        total,
        total_upgraded: stats.total_upgraded,
        total_installed: stats.total_installed,
        total_removed: stats.total_removed,
        total_other: stats.total_other,
    };

    emit_json(&response)
}

fn parse_timestamp(ts: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(ts, "%Y-%m-%dT%H:%M:%S%z").ok()
}

fn count_actions(entries: &[LogEntry]) -> (usize, usize, usize, usize, usize) {
    entries.iter().fold(
        (0, 0, 0, 0, 0),
        |(up, ins, rem, down, re), entry| match entry.action.as_str() {
            "upgraded" => (up + 1, ins, rem, down, re),
            "installed" => (up, ins + 1, rem, down, re),
            "removed" => (up, ins, rem + 1, down, re),
            "downgraded" => (up, ins, rem, down + 1, re),
            "reinstalled" => (up, ins, rem, down, re + 1),
            _ => (up, ins, rem, down, re),
        },
    )
}

fn finalize_group(entries: Vec<LogEntry>, group_index: usize) -> LogGroup {
    let (upgraded, installed, removed, downgraded, reinstalled) = count_actions(&entries);
    let start_time = entries
        .last()
        .map_or(String::new(), |e| e.timestamp.clone());
    let end_time = entries
        .first()
        .map_or(String::new(), |e| e.timestamp.clone());

    LogGroup {
        id: format!("group-{}", group_index),
        start_time,
        end_time,
        entries,
        upgraded_count: upgraded,
        installed_count: installed,
        removed_count: removed,
        downgraded_count: downgraded,
        reinstalled_count: reinstalled,
    }
}

pub fn get_grouped_history(offset: usize, limit: usize, filter: Option<&str>) -> Result<()> {
    let stats = collect_log_entries(filter);

    let mut groups: Vec<LogGroup> = Vec::new();
    let mut current_group_entries: Vec<LogEntry> = Vec::new();
    let mut last_timestamp: Option<NaiveDateTime> = None;

    for entry in stats.entries {
        let current_ts = parse_timestamp(&entry.timestamp);

        let should_start_new_group = match (last_timestamp, current_ts) {
            (Some(last), Some(current)) => {
                let diff = (last - current).num_seconds().abs();
                diff > GROUP_THRESHOLD_SECS
            }
            (None, _) => false,
            (Some(_), None) => true,
        };

        if should_start_new_group && !current_group_entries.is_empty() {
            groups.push(finalize_group(current_group_entries, groups.len()));
            current_group_entries = Vec::new();
        }

        last_timestamp = current_ts;
        current_group_entries.push(entry);
    }

    if !current_group_entries.is_empty() {
        groups.push(finalize_group(current_group_entries, groups.len()));
    }

    let total_groups = groups.len();
    let paginated_groups: Vec<LogGroup> = groups.into_iter().skip(offset).take(limit).collect();

    let response = GroupedLogResponse {
        groups: paginated_groups,
        total_groups,
        total_upgraded: stats.total_upgraded,
        total_installed: stats.total_installed,
        total_removed: stats.total_removed,
        total_other: stats.total_other,
    };

    emit_json(&response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_timestamp_with_positive_offset() {
        let ts = "2026-01-21T23:14:45+0100";
        let result = parse_timestamp(ts);
        assert!(result.is_some());
        let dt = result.unwrap();
        assert_eq!(dt.format("%Y-%m-%d").to_string(), "2026-01-21");
    }

    #[test]
    fn test_parse_timestamp_with_utc() {
        let ts = "2026-01-21T23:14:45+0000";
        let result = parse_timestamp(ts);
        assert!(result.is_some());
    }

    #[test]
    fn test_parse_timestamp_with_negative_offset() {
        let ts = "2026-01-21T23:14:45-0500";
        let result = parse_timestamp(ts);
        assert!(result.is_some());
    }

    #[test]
    fn test_count_actions() {
        let entries = vec![
            LogEntry {
                timestamp: "2026-01-21T10:00:00+0000".to_string(),
                action: "upgraded".to_string(),
                package: "pkg1".to_string(),
                old_version: Some("1.0".to_string()),
                new_version: Some("2.0".to_string()),
            },
            LogEntry {
                timestamp: "2026-01-21T10:00:01+0000".to_string(),
                action: "upgraded".to_string(),
                package: "pkg2".to_string(),
                old_version: Some("1.0".to_string()),
                new_version: Some("2.0".to_string()),
            },
            LogEntry {
                timestamp: "2026-01-21T10:00:02+0000".to_string(),
                action: "installed".to_string(),
                package: "pkg3".to_string(),
                old_version: None,
                new_version: Some("1.0".to_string()),
            },
            LogEntry {
                timestamp: "2026-01-21T10:00:03+0000".to_string(),
                action: "removed".to_string(),
                package: "pkg4".to_string(),
                old_version: Some("1.0".to_string()),
                new_version: None,
            },
        ];

        let (up, ins, rem, down, re) = count_actions(&entries);
        assert_eq!(up, 2);
        assert_eq!(ins, 1);
        assert_eq!(rem, 1);
        assert_eq!(down, 0);
        assert_eq!(re, 0);
    }

    #[test]
    fn test_finalize_group() {
        let entries = vec![
            LogEntry {
                timestamp: "2026-01-21T10:00:05+0000".to_string(),
                action: "upgraded".to_string(),
                package: "pkg1".to_string(),
                old_version: Some("1.0".to_string()),
                new_version: Some("2.0".to_string()),
            },
            LogEntry {
                timestamp: "2026-01-21T10:00:00+0000".to_string(),
                action: "installed".to_string(),
                package: "pkg2".to_string(),
                old_version: None,
                new_version: Some("1.0".to_string()),
            },
        ];

        let group = finalize_group(entries, 0);
        assert_eq!(group.id, "group-0");
        assert_eq!(group.start_time, "2026-01-21T10:00:00+0000");
        assert_eq!(group.end_time, "2026-01-21T10:00:05+0000");
        assert_eq!(group.upgraded_count, 1);
        assert_eq!(group.installed_count, 1);
        assert_eq!(group.entries.len(), 2);
    }

    #[test]
    fn test_grouping_threshold() {
        let ts1 = parse_timestamp("2026-01-21T10:00:00+0000").unwrap();
        let ts2 = parse_timestamp("2026-01-21T10:00:59+0000").unwrap();
        let ts3 = parse_timestamp("2026-01-21T10:01:01+0000").unwrap();

        // 59 seconds apart - should be same group
        let diff1 = (ts2 - ts1).num_seconds().abs();
        assert!(diff1 <= GROUP_THRESHOLD_SECS);

        // 61 seconds apart - should be different groups
        let diff2 = (ts3 - ts1).num_seconds().abs();
        assert!(diff2 > GROUP_THRESHOLD_SECS);
    }
}
