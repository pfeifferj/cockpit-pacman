use std::env;

use cockpit_pacman_backend::handlers::{
    check_updates, init_keyring, keyring_status, list_installed, local_package_info,
    preflight_upgrade, refresh_keyring, run_upgrade, search, sync_database, sync_package_info,
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
    eprintln!("  sync-database [force]  Sync package databases (requires root)");
    eprintln!("                         force: true|false (default: true)");
    eprintln!("  upgrade [ignore]       Perform system upgrade (requires root)");
    eprintln!("                         ignore: comma-separated list of packages to skip");
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
            sync_database(force)
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
            run_upgrade(&ignore_pkgs)
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
