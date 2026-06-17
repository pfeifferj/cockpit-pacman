use anyhow::Result;
use pacman_log::{Action, LogReader, Transaction};

use crate::models::{GroupedLogResponse, LogEntry, LogGroup, LogResponse};
use crate::util::emit_json;

const TS_FMT: &str = "%Y-%m-%dT%H:%M:%S%z";

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

fn collect_log_entries(filter: Option<&str>, search: Option<&str>) -> LogStats {
    let reader = LogReader::system();
    let filter_action = parse_filter(filter);
    let search_lower = search.map(|s| s.to_lowercase());

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

        if let Some(ref needle) = search_lower
            && !entry.package.to_lowercase().contains(needle.as_str())
        {
            continue;
        }

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

pub fn get_history(
    offset: usize,
    limit: usize,
    filter: Option<&str>,
    search: Option<&str>,
) -> Result<()> {
    let stats = collect_log_entries(filter, search);
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

fn map_entry(op: pacman_log::LogEntry) -> LogEntry {
    LogEntry {
        timestamp: op.timestamp.format(TS_FMT).to_string(),
        action: op.action.to_string(),
        package: op.package,
        old_version: op.old_version,
        new_version: op.new_version,
    }
}

struct GroupTotals {
    upgraded: usize,
    installed: usize,
    removed: usize,
    other: usize,
}

/// Build log groups from real pacman transactions. Totals count every
/// search-matched operation regardless of the action filter; group entries are
/// additionally narrowed to the filtered action. Empty groups are dropped.
fn build_groups(
    txs: impl IntoIterator<Item = Transaction>,
    filter_action: Option<Action>,
    search_lower: Option<&str>,
) -> (Vec<LogGroup>, GroupTotals) {
    let mut totals = GroupTotals {
        upgraded: 0,
        installed: 0,
        removed: 0,
        other: 0,
    };
    let mut groups: Vec<LogGroup> = Vec::new();

    for tx in txs {
        let mut entries: Vec<LogEntry> = Vec::new();
        let (mut up, mut ins, mut rem, mut down, mut re) = (0, 0, 0, 0, 0);

        for op in tx.operations {
            if let Some(needle) = search_lower
                && !op.package.to_lowercase().contains(needle)
            {
                continue;
            }

            match op.action {
                Action::Upgraded => totals.upgraded += 1,
                Action::Installed => totals.installed += 1,
                Action::Removed => totals.removed += 1,
                Action::Downgraded | Action::Reinstalled => totals.other += 1,
            }

            if filter_action.is_some_and(|a| a != op.action) {
                continue;
            }

            match op.action {
                Action::Upgraded => up += 1,
                Action::Installed => ins += 1,
                Action::Removed => rem += 1,
                Action::Downgraded => down += 1,
                Action::Reinstalled => re += 1,
            }
            entries.push(map_entry(op));
        }

        if entries.is_empty() {
            continue;
        }
        entries.reverse();

        groups.push(LogGroup {
            id: String::new(),
            command: tx.command,
            start_time: tx.started.format(TS_FMT).to_string(),
            end_time: tx
                .completed
                .unwrap_or(tx.started)
                .format(TS_FMT)
                .to_string(),
            entries,
            upgraded_count: up,
            installed_count: ins,
            removed_count: rem,
            downgraded_count: down,
            reinstalled_count: re,
        });
    }

    (groups, totals)
}

pub fn get_grouped_history(
    offset: usize,
    limit: usize,
    filter: Option<&str>,
    search: Option<&str>,
) -> Result<()> {
    let filter_action = parse_filter(filter);
    let search_lower = search.map(|s| s.to_lowercase());

    let txs = LogReader::system().transactions().filter_map(|r| match r {
        Ok(tx) => Some(tx),
        Err(e) => {
            eprintln!("Warning: Failed to parse transaction: {}", e);
            None
        }
    });

    let (mut groups, totals) = build_groups(txs, filter_action, search_lower.as_deref());

    groups.reverse();
    for (i, group) in groups.iter_mut().enumerate() {
        group.id = format!("group-{}", i);
    }

    let total_groups = groups.len();
    let paginated_groups: Vec<LogGroup> = groups.into_iter().skip(offset).take(limit).collect();

    let response = GroupedLogResponse {
        groups: paginated_groups,
        total_groups,
        total_upgraded: totals.upgraded,
        total_installed: totals.installed,
        total_removed: totals.removed,
        total_other: totals.other,
    };

    emit_json(&response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::DateTime;

    fn ts(s: &str) -> DateTime<chrono::FixedOffset> {
        DateTime::parse_from_str(s, TS_FMT).unwrap()
    }

    fn op(action: Action, pkg: &str) -> pacman_log::LogEntry {
        pacman_log::LogEntry {
            timestamp: ts("2026-01-21T10:00:00+0000"),
            action,
            package: pkg.to_string(),
            old_version: None,
            new_version: None,
        }
    }

    #[test]
    fn build_groups_tallies_and_labels() {
        let tx = Transaction {
            command: Some("pacman -Syu".to_string()),
            started: ts("2026-01-21T10:00:00+0000"),
            completed: Some(ts("2026-01-21T10:00:05+0000")),
            operations: vec![
                op(Action::Upgraded, "pkg1"),
                op(Action::Installed, "pkg2"),
                op(Action::Removed, "pkg3"),
            ],
        };

        let (groups, totals) = build_groups(vec![tx], None, None);
        assert_eq!(groups.len(), 1);
        let g = &groups[0];
        assert_eq!(g.command.as_deref(), Some("pacman -Syu"));
        assert_eq!(g.start_time, "2026-01-21T10:00:00+0000");
        assert_eq!(g.end_time, "2026-01-21T10:00:05+0000");
        assert_eq!(
            (g.upgraded_count, g.installed_count, g.removed_count),
            (1, 1, 1)
        );
        assert_eq!(
            (totals.upgraded, totals.installed, totals.removed),
            (1, 1, 1)
        );
    }

    #[test]
    fn build_groups_action_filter_keeps_totals() {
        let tx = Transaction {
            command: None,
            started: ts("2026-01-21T10:00:00+0000"),
            completed: Some(ts("2026-01-21T10:00:05+0000")),
            operations: vec![op(Action::Upgraded, "a"), op(Action::Installed, "b")],
        };

        let (groups, totals) = build_groups(vec![tx], Some(Action::Installed), None);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].entries.len(), 1);
        assert_eq!(groups[0].installed_count, 1);
        assert_eq!(groups[0].upgraded_count, 0);
        assert_eq!(totals.upgraded, 1);
        assert_eq!(totals.installed, 1);
    }

    #[test]
    fn build_groups_search_drops_empty_group() {
        let tx = Transaction {
            command: None,
            started: ts("2026-01-21T10:00:00+0000"),
            completed: None,
            operations: vec![op(Action::Upgraded, "firefox")],
        };

        let (groups, _) = build_groups(vec![tx], None, Some("chromium"));
        assert!(groups.is_empty());
    }
}
