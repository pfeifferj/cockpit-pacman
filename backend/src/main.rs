use std::env;

use cockpit_pacman_backend::handlers::{
    add_ignored, check_updates, clean_cache, downgrade_package, get_cache_info, get_history,
    init_keyring, keyring_status, list_downgrades, list_ignored, list_installed, list_orphans,
    local_package_info, preflight_upgrade, refresh_keyring, remove_ignored, remove_orphans,
    run_upgrade, search, sync_database, sync_package_info,
};
use cockpit_pacman_backend::validation::{
    validate_package_name, validate_pagination, validate_search_query,
};

fn print_usage() {
    eprintln!("Usage: cockpit-pacman-backend <command> [args]");
    eprintln!();
    eprintln!("Commands:");
    eprintln!("  list-installed [offset] [limit] [search] [filter] [repo] [sort_by] [sort_dir]");
    eprintln!("                         List installed packages (paginated)");
    eprintln!("                         filter: all|explicit|dependency");
    eprintln!("                         repo: all|core|extra|multilib|user|...");
    eprintln!("                         sort_by: name|size|reason");
    eprintln!("                         sort_dir: asc|desc");
    eprintln!("  check-updates          Check for available updates");
    eprintln!("  preflight-upgrade [ignore]");
    eprintln!("                         Check what the upgrade will do (requires root)");
    eprintln!("                         ignore: comma-separated list of packages to skip");
    eprintln!("                         Returns conflicts, replacements, keys to import");
    eprintln!("  sync-database [force] [timeout]");
    eprintln!("                         Sync package databases (requires root)");
    eprintln!("                         force: true|false (default: true)");
    eprintln!("                         timeout: seconds (default: 300)");
    eprintln!("  upgrade [ignore] [timeout]");
    eprintln!("                         Perform system upgrade (requires root)");
    eprintln!("                         ignore: comma-separated list of packages to skip");
    eprintln!("                         timeout: seconds (default: 300)");
    eprintln!("  local-package-info NAME");
    eprintln!("                         Get detailed info for an installed package");
    eprintln!("  sync-package-info NAME [REPO]");
    eprintln!("                         Get detailed info for a package from sync databases");
    eprintln!("  search QUERY [offset] [limit] [installed] [sort_by] [sort_dir]");
    eprintln!("                         Search packages by name/description (paginated)");
    eprintln!("                         installed: all|installed|not-installed");
    eprintln!("                         sort_by: name|repository|status");
    eprintln!("                         sort_dir: asc|desc");
    eprintln!("  keyring-status         Get pacman keyring status and list keys");
    eprintln!("  refresh-keyring        Refresh keys from keyserver (requires root)");
    eprintln!("  init-keyring           Initialize and populate keyring (requires root)");
    eprintln!("  list-orphans           List orphan packages (dependencies no longer required)");
    eprintln!("  remove-orphans [timeout]");
    eprintln!("                         Remove all orphan packages (requires root)");
    eprintln!("                         timeout: seconds (default: 300)");
    eprintln!("  list-ignored           List packages ignored during upgrades");
    eprintln!("  add-ignored NAME       Add a package to the ignored list (requires root)");
    eprintln!("  remove-ignored NAME    Remove a package from the ignored list (requires root)");
    eprintln!("  cache-info             Show package cache information and size");
    eprintln!("  clean-cache [KEEP]     Clean package cache (requires root)");
    eprintln!("                         KEEP: number of versions to keep (default: 3)");
    eprintln!("  history [offset] [limit] [filter]");
    eprintln!("                         View package history from pacman.log");
    eprintln!("                         filter: all|upgraded|installed|removed");
    eprintln!("  list-downgrades [NAME] List cached package versions available for downgrade");
    eprintln!("                         NAME: optional package name to filter");
    eprintln!("  downgrade NAME VERSION [timeout]");
    eprintln!("                         Downgrade a package to a cached version (requires root)");
    eprintln!("                         timeout: seconds (default: 300)");
}

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        print_usage();
        std::process::exit(1);
    }

    let result = match args[1].as_str() {
        "list-installed" => {
            let offset = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
            let limit = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(50);
            let search = args.get(4).map(|s| s.as_str()).filter(|s| !s.is_empty());
            let filter = args
                .get(5)
                .map(|s| s.as_str())
                .filter(|s| !s.is_empty() && *s != "all");
            let repo_filter = args
                .get(6)
                .map(|s| s.as_str())
                .filter(|s| !s.is_empty() && *s != "all");
            let sort_by = args.get(7).map(|s| s.as_str()).filter(|s| !s.is_empty());
            let sort_dir = args.get(8).map(|s| s.as_str()).filter(|s| !s.is_empty());
            validate_pagination(offset, limit).and_then(|_| {
                list_installed(
                    offset,
                    limit,
                    search,
                    filter,
                    repo_filter,
                    sort_by,
                    sort_dir,
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
            let offset = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);
            let limit = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(100);
            let installed_filter = args.get(5).and_then(|s| match s.as_str() {
                "installed" => Some(true),
                "not-installed" => Some(false),
                _ => None,
            });
            let sort_by = args.get(6).map(|s| s.as_str()).filter(|s| !s.is_empty());
            let sort_dir = args.get(7).map(|s| s.as_str()).filter(|s| !s.is_empty());
            validate_search_query(&args[2])
                .and_then(|_| validate_pagination(offset, limit))
                .and_then(|_| search(&args[2], offset, limit, installed_filter, sort_by, sort_dir))
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
            clean_cache(keep_versions)
        }
        "history" => {
            let offset = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
            let limit = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(100);
            let filter = args
                .get(4)
                .map(|s| s.as_str())
                .filter(|s| !s.is_empty() && *s != "all");
            validate_pagination(offset, limit).and_then(|_| get_history(offset, limit, filter))
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
        "help" | "--help" | "-h" => {
            print_usage();
            Ok(())
        }
        cmd => {
            eprintln!("Error: unknown command '{}'", cmd);
            print_usage();
            std::process::exit(1);
        }
    };

    if let Err(e) = result {
        eprintln!("Error: {:#}", e);
        std::process::exit(1);
    }
}
