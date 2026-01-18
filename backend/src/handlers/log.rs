use anyhow::Result;
use pacman_log::{Action, LogReader};

use crate::models::{LogEntry, LogResponse};

pub fn get_history(offset: usize, limit: usize, filter: Option<&str>) -> Result<()> {
    let reader = LogReader::system();

    let filter_action = filter.and_then(|f| match f {
        "upgraded" => Some(Action::Upgraded),
        "installed" => Some(Action::Installed),
        "removed" => Some(Action::Removed),
        _ => None,
    });

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
