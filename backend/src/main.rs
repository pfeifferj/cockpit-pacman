use std::env;
use std::time::Duration;

use cockpit_pacman_backend::handlers::{
    add_ignored, check_lock, check_security, check_updates, clean_cache, delete_mirror_backup,
    delete_repo_backup, downgrade_from_archive, downgrade_package, fetch_mirror_status, fetch_news,
    get_cache_info, get_dependency_tree, get_grouped_history, get_history, get_pacnew_status,
    get_reboot_status, get_schedule_config, get_scheduled_runs, get_services_status, init_keyring,
    install_package, keyring_status, list_archive_versions, list_downgrades, list_ignored,
    list_installed, list_mirror_backups, list_mirrors, list_orphans, list_repo_backups, list_repos,
    local_package_info, mark_dismissed, mark_news_read, preflight_upgrade,
    read_credentials_from_stdin, read_dismissal, read_news_state, refresh_keyring, refresh_mirrors,
    remove_ignored, remove_orphans, remove_package, remove_stale_lock, restore_mirror_backup,
    restore_repo_backup, run_upgrade, save_mirrorlist, save_repos, scheduled_run, search,
    security_info, set_schedule_config, signoff_list, signoff_revoke, signoff_sign, sync_database,
    sync_package_info, test_mirrors,
};
use cockpit_pacman_backend::models::{MirrorEntry, RepoEntry, StructuredError};
use cockpit_pacman_backend::util::{classify_error, emit_json, shutdown_event_writer};
use cockpit_pacman_backend::validation::{
    validate_archive_filename, validate_depth, validate_direction, validate_json_payload_size,
    validate_keep_versions, validate_mirror_timeout, validate_mirror_url, validate_package_name,
    validate_pagination, validate_refresh_protocol, validate_refresh_sort, validate_search_query,
    validate_signoff_arg,
};

/// Every dispatched subcommand name. Single source of truth for the help text
/// (USAGE is checked against it in tests) and the unknown-command suggestion.
/// Keep in sync with the dispatch match in `main`.
const COMMANDS: &[&str] = &[
    "list-installed",
    "check-updates",
    "preflight-upgrade",
    "sync-database",
    "upgrade",
    "local-package-info",
    "sync-package-info",
    "search",
    "keyring-status",
    "refresh-keyring",
    "init-keyring",
    "list-orphans",
    "remove-orphans",
    "install-package",
    "remove-package",
    "list-ignored",
    "add-ignored",
    "remove-ignored",
    "cache-info",
    "clean-cache",
    "history",
    "history-grouped",
    "list-downgrades",
    "downgrade",
    "list-archive-versions",
    "downgrade-archive",
    "get-schedule",
    "set-schedule",
    "list-scheduled-runs",
    "scheduled-run",
    "reboot-status",
    "services-status",
    "pacnew-status",
    "list-mirrors",
    "fetch-mirror-status",
    "refresh-mirrors",
    "test-mirrors",
    "save-mirrorlist",
    "list-mirror-backups",
    "restore-mirror-backup",
    "delete-mirror-backup",
    "dependency-tree",
    "fetch-news",
    "news-read-state",
    "news-mark-read",
    "signoff-list",
    "signoff-sign",
    "signoff-revoke",
    "check-security",
    "security-info",
    "check-lock",
    "remove-stale-lock",
    "list-repos",
    "save-repos",
    "list-repo-backups",
    "restore-repo-backup",
    "delete-repo-backup",
    "reboot-dismissal-state",
    "reboot-mark-dismissed",
    "services-dismissal-state",
    "services-mark-dismissed",
    "pacnew-dismissal-state",
    "pacnew-mark-dismissed",
    "scheduled-dismissal-state",
    "scheduled-mark-dismissed",
];

const USAGE: &str = r#"Usage: cockpit-pacman-backend <command> [args]

Commands:
  list-installed [offset] [limit] [search] [filter] [repo] [sort_by] [sort_dir]
                         List installed packages (paginated)
                         filter: all|explicit|dependency
                         repo: all|core|extra|multilib|user|...
                         sort_by: name|size|reason
                         sort_dir: asc|desc
  check-updates          Check for available updates
  preflight-upgrade [ignore]
                         Check what the upgrade will do (requires root)
                         ignore: comma-separated list of packages to skip
                         Returns conflicts, replacements, keys to import
  sync-database [force] [timeout]
                         Sync package databases (requires root)
                         force: true|false (default: true)
                         timeout: seconds (default: 300)
  upgrade [ignore] [timeout]
                         Perform system upgrade (requires root)
                         ignore: comma-separated list of packages to skip
                         timeout: seconds (default: 300)
  local-package-info NAME
                         Get detailed info for an installed package
  sync-package-info NAME [REPO]
                         Get detailed info for a package from sync databases
  search QUERY [offset] [limit] [installed] [sort_by] [sort_dir]
                         Search packages by name/description (paginated)
                         installed: all|installed|not-installed
                         sort_by: name|repository|status
                         sort_dir: asc|desc
  keyring-status         Get pacman keyring status and list keys
  refresh-keyring        Refresh keys from keyserver (requires root)
  init-keyring           Initialize and populate keyring (requires root)
  list-orphans           List orphan packages (dependencies no longer required)
  remove-orphans [timeout]
                         Remove all orphan packages (requires root)
                         timeout: seconds (default: 300)
  install-package NAME [timeout]
                         Install a package from repositories (requires root)
                         timeout: seconds (default: 300)
  remove-package NAME [timeout]
                         Remove an installed package (requires root)
                         timeout: seconds (default: 300)
  list-ignored           List packages ignored during upgrades
  add-ignored NAME       Add a package to the ignored list (requires root)
  remove-ignored NAME    Remove a package from the ignored list (requires root)
  cache-info             Show package cache information and size
  clean-cache [KEEP] [PKGS]  Clean package cache (requires root)
                         KEEP: number of versions to keep (default: 3)
                         PKGS: comma-separated package names to clean
  history [offset] [limit] [filter] [search]
                         View package history from pacman.log
                         filter: all|upgraded|installed|removed
                         search: filter by package name (substring)
  history-grouped [offset] [limit] [filter] [search]
                         View package history grouped by upgrade runs
                         Groups entries within 60s of each other
                         filter: all|upgraded|installed|removed
                         search: filter by package name (substring)
  list-downgrades [NAME] List cached package versions available for downgrade
                         NAME: optional package name to filter
  downgrade NAME VERSION [timeout]
                         Downgrade a package to a cached version (requires root)
                         timeout: seconds (default: 300)
  list-archive-versions NAME [QUERY]
                         List versions available in the Arch Linux Archive
                         filtered to the system architecture and 'any'
                         QUERY: optional version substring, applied before the cap
  downgrade-archive NAME FILENAME [timeout]
                         Downgrade to an archive version via pacman -U URL
                         (requires root; downloads and verifies the package)
                         timeout: seconds (default: 300)
  get-schedule           Get scheduled upgrade configuration
  set-schedule [enabled] [mode] [schedule] [max_packages]
                         Configure scheduled upgrades (requires root)
                         enabled: true|false
                         mode: check|upgrade
                         schedule: systemd OnCalendar spec (e.g., weekly, daily)
                         max_packages: safety limit (0 = unlimited)
  list-scheduled-runs [offset] [limit]
                         List scheduled run history
  scheduled-run          Execute scheduled operation (called by systemd)
  reboot-status          Check if system reboot is recommended
  services-status        List running services whose binaries were replaced
  pacnew-status          List .pacnew/.pacsave config files needing manual merge
  list-mirrors           List mirrors from /etc/pacman.d/mirrorlist
  fetch-mirror-status    Fetch mirror status from archlinux.org API
  refresh-mirrors [count] [country] [protocol] [sort_by]
                         Generate a ranked mirrorlist from archlinux.org API
                         count: number of mirrors (default: 20, max: 100)
                         country: country code or name filter
                         protocol: https|http|all (default: https)
                         sort_by: score|delay|age (default: score)
  test-mirrors [urls] [timeout]
                         Test mirror speed and latency
                         urls: comma-separated list of mirror URLs
                         timeout: seconds (default: 60)
  save-mirrorlist <json> Save mirrorlist (requires root)
                         json: JSON array of mirror entries
  list-mirror-backups    List available mirrorlist backups
  restore-mirror-backup <timestamp>
                         Restore a mirrorlist backup (requires root)
  delete-mirror-backup <timestamp>
                         Delete a mirrorlist backup (requires root)
  dependency-tree NAME [depth] [direction]
                         Get dependency tree for a package
                         depth: 1-10 (default: 3)
                         direction: forward|reverse|both (default: forward)
  fetch-news [days]      Fetch recent Arch Linux news items
                         days: lookback period (default: 30)
  news-read-state        Get read state of news items
  news-mark-read LINK    Mark a news item as read
  signoff-list           List packages awaiting signoff
  signoff-sign PKGBASE REPO ARCH
                         Sign off a package
  signoff-revoke PKGBASE REPO ARCH
                         Revoke a signoff
                         credentials: base64-encoded JSON {username, password} on stdin
  check-security         Check installed packages against Arch Security Tracker
  security-info NAME     Get security advisory history for a package
  check-lock             Check if the pacman database lock exists and if it's stale
  remove-stale-lock      Remove a stale database lock (requires root)
  list-repos             List configured repositories from pacman.conf
  save-repos <json>      Save repositories to pacman.conf (requires root)
  list-repo-backups      List available pacman.conf backups
  restore-repo-backup <timestamp>
                         Restore a pacman.conf backup (requires root)
  delete-repo-backup <timestamp>
                         Delete a pacman.conf backup (requires root)
  reboot-dismissal-state         Get the dismissed-alert signature for reboot
  reboot-mark-dismissed SIG      Dismiss the reboot alert
  services-dismissal-state       Get the dismissed-alert signature for services
  services-mark-dismissed SIG    Dismiss the services-restart alert
  pacnew-dismissal-state         Get the dismissed-alert signature for pacnew
  pacnew-mark-dismissed SIG      Dismiss the pacnew alert
  scheduled-dismissal-state      Get the dismissed-alert signature for scheduled runs
  scheduled-mark-dismissed SIG   Dismiss the scheduled-run alert
"#;

fn print_usage() {
    eprint!("{USAGE}");
}

// Positional-argv parsers, split out from the dispatch so the contract (which
// position maps to which parameter) is unit-testable without invoking handlers.
// Frontend send order is pinned by contract tests in src/test/contract.test.ts.

fn arg_opt(args: &[String], i: usize) -> Option<String> {
    args.get(i)
        .map(|s| s.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn arg_opt_not_all(args: &[String], i: usize) -> Option<String> {
    args.get(i)
        .map(|s| s.as_str())
        .filter(|s| !s.is_empty() && *s != "all")
        .map(|s| s.to_string())
}

fn arg_usize(args: &[String], i: usize, default: usize) -> usize {
    args.get(i).and_then(|s| s.parse().ok()).unwrap_or(default)
}

type ListInstalledArgs = (
    usize,
    usize,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);
fn parse_list_installed(args: &[String]) -> ListInstalledArgs {
    (
        arg_usize(args, 2, 0),
        arg_usize(args, 3, 50),
        arg_opt(args, 4),
        arg_opt_not_all(args, 5),
        arg_opt_not_all(args, 6),
        arg_opt(args, 7),
        arg_opt(args, 8),
    )
}

type SearchTailArgs = (usize, usize, Option<bool>, Option<String>, Option<String>);
fn parse_search_tail(args: &[String]) -> SearchTailArgs {
    let installed = args.get(5).and_then(|s| match s.as_str() {
        "installed" => Some(true),
        "not-installed" => Some(false),
        _ => None,
    });
    (
        arg_usize(args, 3, 0),
        arg_usize(args, 4, 100),
        installed,
        arg_opt(args, 6),
        arg_opt(args, 7),
    )
}

type HistoryArgs = (usize, usize, Option<String>, Option<String>);
fn parse_history(args: &[String], default_limit: usize) -> HistoryArgs {
    (
        arg_usize(args, 2, 0),
        arg_usize(args, 3, default_limit),
        arg_opt_not_all(args, 4),
        arg_opt(args, 5),
    )
}

type RefreshMirrorsArgs = (usize, Option<String>, String, String);
fn parse_refresh_mirrors(args: &[String]) -> RefreshMirrorsArgs {
    let count = arg_usize(args, 2, 20).min(100);
    let protocol = arg_opt(args, 4).unwrap_or_else(|| "https".to_string());
    let sort_by = arg_opt(args, 5).unwrap_or_else(|| "score".to_string());
    (count, arg_opt(args, 3), protocol, sort_by)
}

type SetScheduleArgs = (Option<bool>, Option<String>, Option<String>, Option<usize>);
fn parse_set_schedule(args: &[String]) -> SetScheduleArgs {
    let enabled = args.get(2).and_then(|s| match s.as_str() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    });
    let max_packages = args.get(5).and_then(|s| s.parse().ok());
    (enabled, arg_opt(args, 3), arg_opt(args, 4), max_packages)
}

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        print_usage();
        std::process::exit(1);
    }

    let result = match args[1].as_str() {
        "list-installed" => {
            let (offset, limit, search, filter, repo_filter, sort_by, sort_dir) =
                parse_list_installed(&args);
            validate_pagination(offset, limit).and_then(|_| {
                list_installed(
                    offset,
                    limit,
                    search.as_deref(),
                    filter.as_deref(),
                    repo_filter.as_deref(),
                    sort_by.as_deref(),
                    sort_dir.as_deref(),
                )
            })
        }
        "check-updates" => check_updates(),
        "preflight-upgrade" => {
            let ignore_pkgs: Vec<String> = args
                .get(2)
                .filter(|s| !s.is_empty())
                .map(|s| {
                    s.split(',')
                        .map(|p| p.trim().to_string())
                        .filter(|p| !p.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            preflight_upgrade(&ignore_pkgs)
        }
        "sync-database" => {
            let force = args.get(2).map(|s| s == "true").unwrap_or(true);
            let timeout = args.get(3).and_then(|s| s.parse().ok());
            sync_database(force, timeout)
        }
        "upgrade" => {
            let ignore_pkgs: Vec<String> = args
                .get(2)
                .filter(|s| !s.is_empty())
                .map(|s| {
                    s.split(',')
                        .map(|p| p.trim().to_string())
                        .filter(|p| !p.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            let timeout = args.get(3).and_then(|s| s.parse().ok());
            run_upgrade(&ignore_pkgs, timeout)
        }
        "local-package-info" => {
            if args.len() < 3 {
                eprintln!("Error: local-package-info requires a package name");
                std::process::exit(1);
            }
            validate_package_name(&args[2]).and_then(|_| local_package_info(&args[2]))
        }
        "search" => {
            if args.len() < 3 {
                eprintln!("Error: search requires a query");
                std::process::exit(1);
            }
            let (offset, limit, installed_filter, sort_by, sort_dir) = parse_search_tail(&args);
            validate_search_query(&args[2])
                .and_then(|_| validate_pagination(offset, limit))
                .and_then(|_| {
                    search(
                        &args[2],
                        offset,
                        limit,
                        installed_filter,
                        sort_by.as_deref(),
                        sort_dir.as_deref(),
                    )
                })
        }
        "sync-package-info" => {
            if args.len() < 3 {
                eprintln!("Error: sync-package-info requires a package name");
                std::process::exit(1);
            }
            let repo = args.get(3).map(|s| s.as_str()).filter(|s| !s.is_empty());
            validate_package_name(&args[2]).and_then(|_| sync_package_info(&args[2], repo))
        }
        "keyring-status" => keyring_status(),
        "refresh-keyring" => refresh_keyring(),
        "init-keyring" => init_keyring(),
        "list-orphans" => list_orphans(),
        "remove-orphans" => {
            let timeout = args.get(2).and_then(|s| s.parse().ok());
            remove_orphans(timeout)
        }
        "install-package" => {
            if args.len() < 3 {
                eprintln!("Error: install-package requires a package name");
                std::process::exit(1);
            }
            let timeout = args.get(3).and_then(|s| s.parse().ok());
            validate_package_name(&args[2]).and_then(|_| install_package(&args[2], timeout))
        }
        "remove-package" => {
            if args.len() < 3 {
                eprintln!("Error: remove-package requires a package name");
                std::process::exit(1);
            }
            let timeout = args.get(3).and_then(|s| s.parse().ok());
            validate_package_name(&args[2]).and_then(|_| remove_package(&args[2], timeout))
        }
        "list-ignored" => list_ignored(),
        "add-ignored" => {
            if args.len() < 3 {
                eprintln!("Error: add-ignored requires a package name");
                std::process::exit(1);
            }
            validate_package_name(&args[2]).and_then(|_| add_ignored(&args[2]))
        }
        "remove-ignored" => {
            if args.len() < 3 {
                eprintln!("Error: remove-ignored requires a package name");
                std::process::exit(1);
            }
            validate_package_name(&args[2]).and_then(|_| remove_ignored(&args[2]))
        }
        "cache-info" => get_cache_info(),
        "clean-cache" => {
            let keep_versions = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(3);
            let filter_pkgs: Vec<String> = args
                .get(3)
                .filter(|s| !s.is_empty())
                .map(|s| {
                    s.split(',')
                        .map(|p| p.trim().to_string())
                        .filter(|p| !p.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            validate_keep_versions(keep_versions)
                .and_then(|_| {
                    filter_pkgs
                        .iter()
                        .try_for_each(|p| validate_package_name(p))
                })
                .and_then(|_| clean_cache(keep_versions, &filter_pkgs))
        }
        "history" => {
            let (offset, limit, filter, search) = parse_history(&args, 100);
            validate_pagination(offset, limit).and_then(|_| {
                if let Some(q) = search.as_deref() {
                    validate_search_query(q)?;
                }
                get_history(offset, limit, filter.as_deref(), search.as_deref())
            })
        }
        "history-grouped" => {
            let (offset, limit, filter, search) = parse_history(&args, 20);
            validate_pagination(offset, limit).and_then(|_| {
                if let Some(q) = search.as_deref() {
                    validate_search_query(q)?;
                }
                get_grouped_history(offset, limit, filter.as_deref(), search.as_deref())
            })
        }
        "list-downgrades" => {
            let name = args.get(2).map(|s| s.as_str()).filter(|s| !s.is_empty());
            if let Some(n) = name {
                validate_package_name(n).and_then(|_| list_downgrades(Some(n)))
            } else {
                list_downgrades(None)
            }
        }
        "downgrade" => {
            if args.len() < 4 {
                eprintln!("Error: downgrade requires NAME and VERSION");
                std::process::exit(1);
            }
            let timeout = args.get(4).and_then(|s| s.parse().ok());
            validate_package_name(&args[2])
                .and_then(|_| downgrade_package(&args[2], &args[3], timeout))
        }
        "list-archive-versions" => {
            if args.len() < 3 {
                eprintln!("Error: list-archive-versions requires a package name");
                std::process::exit(1);
            }
            let query = args.get(3).map(|s| s.as_str()).filter(|s| !s.is_empty());
            validate_package_name(&args[2])
                .and_then(|_| {
                    if let Some(q) = query {
                        validate_search_query(q)?;
                    }
                    Ok(())
                })
                .and_then(|_| list_archive_versions(&args[2], query))
        }
        "downgrade-archive" => {
            if args.len() < 4 {
                eprintln!("Error: downgrade-archive requires NAME and FILENAME");
                std::process::exit(1);
            }
            let timeout = args.get(4).and_then(|s| s.parse().ok());
            validate_package_name(&args[2])
                .and_then(|_| validate_archive_filename(&args[3], &args[2]))
                .and_then(|_| downgrade_from_archive(&args[2], &args[3], timeout))
        }
        "get-schedule" => get_schedule_config(),
        "set-schedule" => {
            let (enabled, mode, schedule, max_packages) = parse_set_schedule(&args);
            set_schedule_config(enabled, mode.as_deref(), schedule.as_deref(), max_packages)
        }
        "list-scheduled-runs" => {
            let offset = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
            let limit = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(50);
            validate_pagination(offset, limit).and_then(|_| get_scheduled_runs(offset, limit))
        }
        "scheduled-run" => scheduled_run(),
        "reboot-status" => get_reboot_status(),
        "services-status" => get_services_status(),
        "pacnew-status" => get_pacnew_status(),
        "list-mirrors" => list_mirrors(),
        "fetch-mirror-status" => fetch_mirror_status(),
        "refresh-mirrors" => {
            let (count, country, protocol, sort_by) = parse_refresh_mirrors(&args);
            validate_refresh_protocol(&protocol)
                .and_then(|_| validate_refresh_sort(&sort_by))
                .and_then(|_| refresh_mirrors(count, country.as_deref(), &protocol, &sort_by))
        }
        "test-mirrors" => {
            let urls: Vec<String> = args
                .get(2)
                .filter(|s| !s.is_empty())
                .map(|s| s.split(',').map(|u| u.trim().to_string()).collect())
                .unwrap_or_default();
            let timeout = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(60);
            urls.iter()
                .try_for_each(|url| validate_mirror_url(url))
                .and_then(|_| validate_mirror_timeout(timeout))
                .and_then(|_| test_mirrors(&urls, timeout))
        }
        "save-mirrorlist" => {
            if args.len() < 3 {
                eprintln!("Error: save-mirrorlist requires a JSON array of mirrors");
                std::process::exit(1);
            }
            validate_json_payload_size(&args[2])
                .and_then(|_| {
                    serde_json::from_str::<Vec<MirrorEntry>>(&args[2])
                        .map_err(|e| anyhow::anyhow!("Invalid JSON: {}", e))
                })
                .and_then(|mirrors| save_mirrorlist(&mirrors))
        }
        "list-mirror-backups" => list_mirror_backups(),
        "restore-mirror-backup" => {
            if args.len() < 3 {
                eprintln!("Error: restore-mirror-backup requires a timestamp");
                std::process::exit(1);
            }
            match args[2].parse::<i64>() {
                Ok(ts) => restore_mirror_backup(ts),
                Err(_) => {
                    eprintln!("Error: invalid timestamp '{}'", args[2]);
                    std::process::exit(1);
                }
            }
        }
        "delete-mirror-backup" => {
            if args.len() < 3 {
                eprintln!("Error: delete-mirror-backup requires a timestamp");
                std::process::exit(1);
            }
            match args[2].parse::<i64>() {
                Ok(ts) => delete_mirror_backup(ts),
                Err(_) => {
                    eprintln!("Error: invalid timestamp '{}'", args[2]);
                    std::process::exit(1);
                }
            }
        }
        "dependency-tree" => {
            if args.len() < 3 {
                eprintln!("Error: dependency-tree requires a package name");
                std::process::exit(1);
            }
            let depth = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(3);
            let direction = args
                .get(4)
                .map(|s| s.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("forward");
            validate_package_name(&args[2])
                .and_then(|_| validate_depth(depth))
                .and_then(|_| validate_direction(direction))
                .and_then(|_| get_dependency_tree(&args[2], depth, direction))
        }
        "fetch-news" => {
            let days = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(30u32);
            fetch_news(days)
        }
        "news-read-state" => read_news_state(),
        "news-mark-read" => {
            if args.len() < 3 {
                eprintln!("Error: news-mark-read requires a URL");
                std::process::exit(1);
            }
            validate_mirror_url(&args[2]).and_then(|_| mark_news_read(&args[2]))
        }
        "services-dismissal-state" => read_dismissal("services"),
        "services-mark-dismissed" => {
            if args.len() < 3 {
                eprintln!("Error: services-mark-dismissed requires a SIGNATURE");
                std::process::exit(1);
            }
            mark_dismissed("services", &args[2])
        }
        "reboot-dismissal-state" => read_dismissal("reboot"),
        "reboot-mark-dismissed" => {
            if args.len() < 3 {
                eprintln!("Error: reboot-mark-dismissed requires a SIGNATURE");
                std::process::exit(1);
            }
            mark_dismissed("reboot", &args[2])
        }
        "pacnew-dismissal-state" => read_dismissal("pacnew"),
        "pacnew-mark-dismissed" => {
            if args.len() < 3 {
                eprintln!("Error: pacnew-mark-dismissed requires a SIGNATURE");
                std::process::exit(1);
            }
            mark_dismissed("pacnew", &args[2])
        }
        "scheduled-dismissal-state" => read_dismissal("scheduled"),
        "scheduled-mark-dismissed" => {
            if args.len() < 3 {
                eprintln!("Error: scheduled-mark-dismissed requires a SIGNATURE");
                std::process::exit(1);
            }
            mark_dismissed("scheduled", &args[2])
        }
        "signoff-list" => read_credentials_from_stdin().and_then(|creds| signoff_list(&creds)),
        "signoff-sign" => {
            if args.len() < 5 {
                eprintln!("Error: signoff-sign requires PKGBASE REPO ARCH");
                std::process::exit(1);
            }
            validate_signoff_arg(&args[2], "pkgbase")
                .and_then(|_| validate_signoff_arg(&args[3], "repo"))
                .and_then(|_| validate_signoff_arg(&args[4], "arch"))
                .and_then(|_| read_credentials_from_stdin())
                .and_then(|creds| signoff_sign(&creds, &args[2..]))
        }
        "signoff-revoke" => {
            if args.len() < 5 {
                eprintln!("Error: signoff-revoke requires PKGBASE REPO ARCH");
                std::process::exit(1);
            }
            validate_signoff_arg(&args[2], "pkgbase")
                .and_then(|_| validate_signoff_arg(&args[3], "repo"))
                .and_then(|_| validate_signoff_arg(&args[4], "arch"))
                .and_then(|_| read_credentials_from_stdin())
                .and_then(|creds| signoff_revoke(&creds, &args[2..]))
        }
        "check-security" => check_security(),
        "security-info" => {
            if args.len() < 3 {
                eprintln!("Error: security-info requires a package name");
                std::process::exit(1);
            }
            validate_package_name(&args[2]).and_then(|_| security_info(&args[2]))
        }
        "check-lock" => check_lock(),
        "list-repos" => list_repos(),
        "save-repos" => {
            if args.len() < 3 {
                eprintln!("Error: save-repos requires a JSON array of repositories");
                std::process::exit(1);
            }
            validate_json_payload_size(&args[2])
                .and_then(|_| {
                    serde_json::from_str::<Vec<RepoEntry>>(&args[2])
                        .map_err(|e| anyhow::anyhow!("Invalid JSON: {}", e))
                })
                .and_then(|repos| save_repos(&repos))
        }
        "list-repo-backups" => list_repo_backups(),
        "restore-repo-backup" => {
            if args.len() < 3 {
                eprintln!("Error: restore-repo-backup requires a timestamp");
                std::process::exit(1);
            }
            match args[2].parse::<i64>() {
                Ok(ts) => restore_repo_backup(ts),
                Err(_) => {
                    eprintln!("Error: invalid timestamp '{}'", args[2]);
                    std::process::exit(1);
                }
            }
        }
        "delete-repo-backup" => {
            if args.len() < 3 {
                eprintln!("Error: delete-repo-backup requires a timestamp");
                std::process::exit(1);
            }
            match args[2].parse::<i64>() {
                Ok(ts) => delete_repo_backup(ts),
                Err(_) => {
                    eprintln!("Error: invalid timestamp '{}'", args[2]);
                    std::process::exit(1);
                }
            }
        }
        "remove-stale-lock" => remove_stale_lock(),
        "help" | "--help" | "-h" => {
            print_usage();
            Ok(())
        }
        cmd => {
            eprintln!(
                "Error: unknown command '{}' ({} commands available)",
                cmd,
                COMMANDS.len()
            );
            print_usage();
            std::process::exit(1);
        }
    };

    // Deliver any queued stream events (incl. the terminal Complete) before the
    // process exits, then continue to the result/envelope handling. Bounded so a
    // dead Cockpit channel can't hold us here.
    shutdown_event_writer(Duration::from_secs(5));

    if let Err(e) = result {
        // The structured envelope + exit 0 is for commands whose stdout the
        // frontend parses. scheduled-run is invoked by a systemd oneshot unit
        // with no such consumer, so it must exit non-zero on failure for the
        // unit result to reflect reality.
        let emit_envelope = args[1] != "scheduled-run";
        if emit_envelope {
            // Every frontend-consumed command reports failure as an envelope, so
            // an unclassifiable error still carries its real message.
            let code = classify_error(&e).unwrap_or("internal_error");
            let _ = emit_json(&StructuredError {
                code: code.to_string(),
                message: format!("{}", e),
                details: Some(format!("{:#}", e)),
            });
            std::process::exit(0);
        }
        eprintln!("Error: {:#}", e);
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn svec(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn list_installed_positions() {
        let args = svec(&[
            "bin",
            "list-installed",
            "5",
            "20",
            "foo",
            "explicit",
            "core",
            "name",
            "asc",
        ]);
        assert_eq!(
            parse_list_installed(&args),
            (
                5,
                20,
                Some("foo".to_string()),
                Some("explicit".to_string()),
                Some("core".to_string()),
                Some("name".to_string()),
                Some("asc".to_string()),
            )
        );
    }

    #[test]
    fn list_installed_defaults_and_all() {
        assert_eq!(
            parse_list_installed(&svec(&["bin", "list-installed"])),
            (0, 50, None, None, None, None, None)
        );
        // empty search and "all" filter/repo collapse to None
        assert_eq!(
            parse_list_installed(&svec(&[
                "bin",
                "list-installed",
                "0",
                "50",
                "",
                "all",
                "all"
            ])),
            (0, 50, None, None, None, None, None)
        );
    }

    #[test]
    fn search_tail_positions() {
        let args = svec(&[
            "bin",
            "search",
            "query",
            "5",
            "30",
            "installed",
            "name",
            "asc",
        ]);
        assert_eq!(
            parse_search_tail(&args),
            (
                5,
                30,
                Some(true),
                Some("name".to_string()),
                Some("asc".to_string())
            )
        );
        assert_eq!(
            parse_search_tail(&svec(&["bin", "search", "q", "0", "10", "not-installed"])),
            (0, 10, Some(false), None, None)
        );
        assert_eq!(
            parse_search_tail(&svec(&["bin", "search", "q"])),
            (0, 100, None, None, None)
        );
    }

    #[test]
    fn history_positions_and_default_limit() {
        assert_eq!(
            parse_history(
                &svec(&["bin", "history", "2", "10", "upgraded", "linux"]),
                100
            ),
            (
                2,
                10,
                Some("upgraded".to_string()),
                Some("linux".to_string())
            )
        );
        assert_eq!(
            parse_history(&svec(&["bin", "history"]), 100),
            (0, 100, None, None)
        );
        assert_eq!(
            parse_history(&svec(&["bin", "history-grouped"]), 20),
            (0, 20, None, None)
        );
    }

    #[test]
    fn refresh_mirrors_clamp_and_defaults() {
        assert_eq!(
            parse_refresh_mirrors(&svec(&[
                "bin",
                "refresh-mirrors",
                "50",
                "de",
                "http",
                "delay"
            ])),
            (
                50,
                Some("de".to_string()),
                "http".to_string(),
                "delay".to_string()
            )
        );
        assert_eq!(
            parse_refresh_mirrors(&svec(&["bin", "refresh-mirrors"])),
            (20, None, "https".to_string(), "score".to_string())
        );
        // count clamps to 100
        assert_eq!(
            parse_refresh_mirrors(&svec(&["bin", "refresh-mirrors", "999"])).0,
            100
        );
    }

    #[test]
    fn set_schedule_positions() {
        assert_eq!(
            parse_set_schedule(&svec(&[
                "bin",
                "set-schedule",
                "true",
                "upgrade",
                "weekly",
                "50"
            ])),
            (
                Some(true),
                Some("upgrade".to_string()),
                Some("weekly".to_string()),
                Some(50)
            )
        );
        assert_eq!(
            parse_set_schedule(&svec(&["bin", "set-schedule", "false"])),
            (Some(false), None, None, None)
        );
        assert_eq!(
            parse_set_schedule(&svec(&["bin", "set-schedule"])),
            (None, None, None, None)
        );
    }

    #[test]
    fn usage_documents_every_command() {
        for c in COMMANDS {
            let line = format!("  {c} ");
            assert!(
                USAGE.contains(&line),
                "command `{c}` is not documented in USAGE"
            );
        }
    }

    #[test]
    fn commands_have_no_duplicates() {
        let mut seen = std::collections::HashSet::new();
        for c in COMMANDS {
            assert!(seen.insert(*c), "duplicate command in COMMANDS: {c}");
        }
    }
}
