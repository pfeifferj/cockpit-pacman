use anyhow::Result;

use crate::log_cache::ParsedLog;
use crate::models::{GroupedLogResponse, LogEntry, LogGroup, LogResponse};
use crate::util::emit_json;

const ENTRIES_PER_GROUP: usize = 100;

#[derive(Default)]
struct Totals {
    upgraded: usize,
    installed: usize,
    removed: usize,
    downgraded: usize,
    reinstalled: usize,
}

impl Totals {
    fn add(&mut self, entry: &LogEntry) {
        match entry.action.as_str() {
            "upgraded" => self.upgraded += 1,
            "installed" => self.installed += 1,
            "removed" => self.removed += 1,
            "downgraded" => self.downgraded += 1,
            "reinstalled" => self.reinstalled += 1,
            _ => {}
        }
    }

    fn other(&self) -> usize {
        self.downgraded + self.reinstalled
    }
}

fn action_filter(filter: Option<&str>) -> Option<&str> {
    filter.filter(|value| matches!(*value, "upgraded" | "installed" | "removed"))
}

fn matches_search(entry: &LogEntry, search: Option<&str>) -> bool {
    search.is_none_or(|query| entry.package.to_lowercase().contains(query))
}

fn history_page(
    parsed: &ParsedLog,
    offset: usize,
    limit: usize,
    filter: Option<&str>,
    search: Option<&str>,
) -> LogResponse {
    let filter = action_filter(filter);
    let search = search.map(str::to_lowercase);
    let mut totals = Totals::default();
    let mut total = 0;
    let mut entries = Vec::new();
    for entry in parsed.entries.iter().rev() {
        if !matches_search(entry, search.as_deref()) {
            continue;
        }
        totals.add(entry);
        if filter.is_some_and(|action| action != entry.action) {
            continue;
        }
        if total >= offset && entries.len() < limit {
            entries.push(entry.clone());
        }
        total += 1;
    }
    LogResponse {
        entries,
        total,
        total_upgraded: totals.upgraded,
        total_installed: totals.installed,
        total_removed: totals.removed,
        total_other: totals.other(),
    }
}

pub fn get_history(
    offset: usize,
    limit: usize,
    filter: Option<&str>,
    search: Option<&str>,
) -> Result<()> {
    emit_json(&history_page(
        &crate::log_cache::load()?,
        offset,
        limit,
        filter,
        search,
    ))
}

fn grouped_page(
    parsed: &ParsedLog,
    offset: usize,
    limit: usize,
    filter: Option<&str>,
    search: Option<&str>,
) -> GroupedLogResponse {
    let filter = action_filter(filter);
    let search = search.map(str::to_lowercase);
    let mut totals = Totals::default();
    let mut total_groups = 0;
    let mut groups = Vec::new();
    for (transaction_index, transaction) in parsed.transactions.iter().enumerate().rev() {
        let entries: Vec<_> = parsed.entries[transaction.start..transaction.end]
            .iter()
            .rev()
            .filter(|entry| {
                if !matches_search(entry, search.as_deref()) {
                    return false;
                }
                totals.add(entry);
                filter.is_none_or(|action| action == entry.action)
            })
            .collect();
        let parts = entries.len().div_ceil(ENTRIES_PER_GROUP);
        for (part, entries) in entries.chunks(ENTRIES_PER_GROUP).enumerate() {
            if total_groups >= offset && groups.len() < limit {
                let mut counts = Totals::default();
                for entry in entries {
                    counts.add(entry);
                }
                groups.push(LogGroup {
                    id: format!("group-{transaction_index}-{part}"),
                    command: transaction.command.clone(),
                    start_time: transaction.start_time.clone(),
                    end_time: transaction.end_time.clone(),
                    entries: entries.iter().map(|entry| (*entry).clone()).collect(),
                    upgraded_count: counts.upgraded,
                    installed_count: counts.installed,
                    removed_count: counts.removed,
                    downgraded_count: counts.downgraded,
                    reinstalled_count: counts.reinstalled,
                    part: (parts > 1).then_some(part + 1),
                    parts: (parts > 1).then_some(parts),
                });
            }
            total_groups += 1;
        }
    }
    GroupedLogResponse {
        groups,
        total_groups,
        total_upgraded: totals.upgraded,
        total_installed: totals.installed,
        total_removed: totals.removed,
        total_other: totals.other(),
    }
}

pub fn get_grouped_history(
    offset: usize,
    limit: usize,
    filter: Option<&str>,
    search: Option<&str>,
) -> Result<()> {
    emit_json(&grouped_page(
        &crate::log_cache::load()?,
        offset,
        limit,
        filter,
        search,
    ))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::log_cache::LogTransaction;

    fn log(actions: &[(&str, &str)]) -> ParsedLog {
        ParsedLog {
            entries: actions
                .iter()
                .map(|(action, package)| LogEntry {
                    timestamp: "2026-01-21T10:00:00+0000".to_string(),
                    action: action.to_string(),
                    package: package.to_string(),
                    old_version: None,
                    new_version: None,
                })
                .collect(),
            transactions: vec![LogTransaction {
                command: Some("pacman -Syu".to_string()),
                start_time: "2026-01-21T10:00:00+0000".to_string(),
                end_time: "2026-01-21T10:00:05+0000".to_string(),
                start: 0,
                end: actions.len(),
            }],
        }
    }

    #[test]
    fn history_and_groups_keep_search_totals_across_action_filters() {
        let parsed = log(&[
            ("upgraded", "abc"),
            ("installed", "abcd"),
            ("removed", "other"),
        ]);
        let grouped = grouped_page(&parsed, 0, 10, Some("installed"), Some("ABC"));
        assert_eq!(grouped.total_groups, 1);
        assert_eq!(grouped.groups[0].entries[0].package, "abcd");
        assert_eq!(grouped.groups[0].command.as_deref(), Some("pacman -Syu"));
        assert_eq!(
            (
                grouped.total_upgraded,
                grouped.total_installed,
                grouped.total_removed
            ),
            (1, 1, 0)
        );
        assert_eq!(
            (
                grouped.groups[0].upgraded_count,
                grouped.groups[0].installed_count
            ),
            (0, 1)
        );
        let flat = history_page(&parsed, 0, 10, Some("installed"), Some("ABC"));
        assert_eq!(flat.total, 1);
        assert_eq!(
            (
                flat.total_upgraded,
                flat.total_installed,
                flat.total_removed
            ),
            (1, 1, 0)
        );
    }

    #[test]
    fn large_transactions_page_without_losing_or_repeating_entries() {
        let names: Vec<_> = (0..251).map(|index| format!("pkg{index}")).collect();
        let actions: Vec<_> = names
            .iter()
            .map(|name| ("upgraded", name.as_str()))
            .collect();
        let parsed = log(&actions);
        let mut packages = Vec::new();
        for offset in 0..3 {
            let page = grouped_page(&parsed, offset, 1, None, None);
            assert_eq!(page.total_groups, 3);
            assert_eq!(page.total_upgraded, 251);
            assert_eq!(page.groups.len(), 1);
            let group = &page.groups[0];
            assert_eq!(group.part, Some(offset + 1));
            assert_eq!(group.parts, Some(3));
            assert!(group.entries.len() <= ENTRIES_PER_GROUP);
            assert_eq!(group.upgraded_count, group.entries.len());
            packages.extend(group.entries.iter().map(|entry| entry.package.clone()));
        }
        assert_eq!(packages, names.into_iter().rev().collect::<Vec<_>>());
        assert!(grouped_page(&parsed, 3, 1, None, None).groups.is_empty());
        let filtered = grouped_page(&parsed, 0, 1, None, Some("pkg250"));
        assert_eq!(filtered.groups[0].part, None);
        assert_eq!(filtered.total_groups, 1);
    }

    #[test]
    fn flat_pages_keep_requested_order_and_totals() {
        let parsed = log(&[
            ("upgraded", "first"),
            ("installed", "middle"),
            ("removed", "last"),
        ]);
        let page = history_page(&parsed, 1, 1, None, None);
        assert_eq!(page.total, 3);
        assert_eq!(page.entries.len(), 1);
        assert_eq!(page.entries[0].package, "middle");
        assert!(
            grouped_page(&parsed, 0, 10, None, Some("absent"))
                .groups
                .is_empty()
        );
    }
}
