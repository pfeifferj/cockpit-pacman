use alpm::Alpm;
use alpm_utils::{alpm_with_conf, DbListExt};
use anyhow::{Context, Result};
use pacmanconf::Config;
use serde::Serialize;
use std::env;

#[cfg(test)]
mod tests;

#[derive(Serialize)]
struct Package {
    name: String,
    version: String,
    description: Option<String>,
    installed_size: i64,
    install_date: Option<i64>,
    reason: String,
    repository: Option<String>,
}

#[derive(Serialize)]
struct PackageListResponse {
    packages: Vec<Package>,
    total: usize,
    total_explicit: usize,
    total_dependency: usize,
    repositories: Vec<String>,
    warnings: Vec<String>,
}

#[derive(Serialize)]
struct UpdatesResponse {
    updates: Vec<UpdateInfo>,
    warnings: Vec<String>,
}

#[derive(Serialize)]
struct UpdateInfo {
    name: String,
    current_version: String,
    new_version: String,
    download_size: i64,
}

#[derive(Serialize)]
struct PackageDetails {
    name: String,
    version: String,
    description: Option<String>,
    url: Option<String>,
    licenses: Vec<String>,
    groups: Vec<String>,
    provides: Vec<String>,
    depends: Vec<String>,
    optdepends: Vec<String>,
    conflicts: Vec<String>,
    replaces: Vec<String>,
    installed_size: i64,
    packager: Option<String>,
    architecture: Option<String>,
    build_date: i64,
    install_date: Option<i64>,
    reason: String,
    validation: Vec<String>,
    repository: Option<String>,
}

#[derive(Serialize)]
struct SearchResult {
    name: String,
    version: String,
    description: Option<String>,
    repository: String,
    installed: bool,
    installed_version: Option<String>,
}

fn get_handle() -> Result<Alpm> {
    let conf = Config::new().context("Failed to parse pacman.conf")?;
    alpm_with_conf(&conf).context("Failed to initialize alpm handle")
}

fn validate_package_name(name: &str) -> Result<()> {
    if name.is_empty() {
        anyhow::bail!("Package name cannot be empty");
    }
    if name.len() > 256 {
        anyhow::bail!("Package name too long (max 256)");
    }
    Ok(())
}

fn validate_search_query(query: &str) -> Result<()> {
    if query.is_empty() {
        anyhow::bail!("Search query cannot be empty");
    }
    if query.len() > 256 {
        anyhow::bail!("Search query too long (max 256)");
    }
    if query.chars().any(|c| c.is_control()) {
        anyhow::bail!("Search query contains invalid characters");
    }
    Ok(())
}

fn validate_pagination(offset: usize, limit: usize) -> Result<()> {
    if limit == 0 || limit > 1000 {
        anyhow::bail!("Limit must be between 1 and 1000");
    }
    if offset > 1_000_000 {
        anyhow::bail!("Offset too large");
    }
    Ok(())
}


fn find_package_repo(handle: &Alpm, pkg_name: &str) -> Option<String> {
    handle
        .syncdbs()
        .pkg(pkg_name)
        .ok()
        .and_then(|pkg| pkg.db())
        .map(|db| db.name().to_string())
}

fn list_installed(
    offset: usize,
    limit: usize,
    search: Option<&str>,
    filter: Option<&str>,
    repo_filter: Option<&str>,
) -> Result<()> {
    let handle = get_handle()?;
    let localdb = handle.localdb();

    let search_lower = search.map(|s| s.to_lowercase());
    let filter_reason = filter.and_then(|f| match f {
        "explicit" => Some(alpm::PackageReason::Explicit),
        "dependency" => Some(alpm::PackageReason::Depend),
        _ => None,
    });

    let mut total_explicit = 0usize;
    let mut total_dependency = 0usize;
    let mut repo_set: std::collections::HashSet<String> = std::collections::HashSet::new();

    // First pass: collect all packages with their repos and count totals
    let all_with_repos: Vec<_> = localdb
        .pkgs()
        .iter()
        .map(|pkg| {
            // Count totals for ALL packages (before any filtering)
            match pkg.reason() {
                alpm::PackageReason::Explicit => total_explicit += 1,
                alpm::PackageReason::Depend => total_dependency += 1,
            }

            let repo = find_package_repo(&handle, pkg.name());
            if let Some(ref r) = repo {
                repo_set.insert(r.clone());
            } else {
                repo_set.insert("local".to_string());
            }
            (pkg, repo)
        })
        .collect();

    // Second pass: apply filters
    let filtered: Vec<_> = all_with_repos
        .iter()
        .filter(|(pkg, repo)| {
            if let Some(ref query) = search_lower {
                let name_match = pkg.name().to_lowercase().contains(query);
                let desc_match = pkg
                    .desc()
                    .map(|d| d.to_lowercase().contains(query))
                    .unwrap_or(false);
                if !name_match && !desc_match {
                    return false;
                }
            }

            if let Some(reason) = filter_reason {
                if pkg.reason() != reason {
                    return false;
                }
            }

            if let Some(repo_f) = repo_filter {
                let pkg_repo = repo.as_deref().unwrap_or("local");
                if pkg_repo != repo_f {
                    return false;
                }
            }

            true
        })
        .collect();

    let total = filtered.len();

    let packages: Vec<Package> = filtered
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|(pkg, repo)| Package {
            name: pkg.name().to_string(),
            version: pkg.version().to_string(),
            description: pkg.desc().map(|s| s.to_string()),
            installed_size: pkg.isize(),
            install_date: pkg.install_date(),
            reason: match pkg.reason() {
                alpm::PackageReason::Explicit => "explicit".to_string(),
                alpm::PackageReason::Depend => "dependency".to_string(),
            },
            repository: repo.clone(),
        })
        .collect();

    let mut repositories: Vec<String> = repo_set.into_iter().collect();
    repositories.sort();

    let response = PackageListResponse {
        packages,
        total,
        total_explicit,
        total_dependency,
        repositories,
        warnings: Vec::new(),
    };

    println!("{}", serde_json::to_string(&response)?);
    Ok(())
}

fn check_updates() -> Result<()> {
    let handle = get_handle()?;
    let localdb = handle.localdb();
    let mut updates: Vec<UpdateInfo> = Vec::new();

    for pkg in localdb.pkgs() {
        if let Ok(syncpkg) = handle.syncdbs().pkg(pkg.name()) {
            if syncpkg.version() > pkg.version() {
                updates.push(UpdateInfo {
                    name: pkg.name().to_string(),
                    current_version: pkg.version().to_string(),
                    new_version: syncpkg.version().to_string(),
                    download_size: syncpkg.download_size(),
                });
            }
        }
    }

    let response = UpdatesResponse {
        updates,
        warnings: Vec::new(),
    };
    println!("{}", serde_json::to_string(&response)?);
    Ok(())
}

fn local_package_info(name: &str) -> Result<()> {
    let handle = get_handle()?;
    let localdb = handle.localdb();

    let pkg = localdb
        .pkg(name)
        .map_err(|_| anyhow::anyhow!("Package '{}' not found", name))?;

    let repository = find_package_repo(&handle, name);

    let details = PackageDetails {
        name: pkg.name().to_string(),
        version: pkg.version().to_string(),
        description: pkg.desc().map(|s| s.to_string()),
        url: pkg.url().map(|s| s.to_string()),
        licenses: pkg.licenses().iter().map(|s| s.to_string()).collect(),
        groups: pkg.groups().iter().map(|s| s.to_string()).collect(),
        provides: pkg.provides().iter().map(|d| d.name().to_string()).collect(),
        depends: pkg.depends().iter().map(|d| d.name().to_string()).collect(),
        optdepends: pkg.optdepends().iter().map(|d| d.name().to_string()).collect(),
        conflicts: pkg.conflicts().iter().map(|d| d.name().to_string()).collect(),
        replaces: pkg.replaces().iter().map(|d| d.name().to_string()).collect(),
        installed_size: pkg.isize(),
        packager: pkg.packager().map(|s| s.to_string()),
        architecture: pkg.arch().map(|s| s.to_string()),
        build_date: pkg.build_date(),
        install_date: pkg.install_date(),
        reason: match pkg.reason() {
            alpm::PackageReason::Explicit => "explicit".to_string(),
            alpm::PackageReason::Depend => "dependency".to_string(),
        },
        validation: pkg
            .validation()
            .iter()
            .map(|v| format!("{:?}", v))
            .collect(),
        repository,
    };

    println!("{}", serde_json::to_string(&details)?);
    Ok(())
}

#[derive(Serialize)]
struct SearchResponse {
    results: Vec<SearchResult>,
    total: usize,
    repositories: Vec<String>,
}

fn search(query: &str, offset: usize, limit: usize, installed_filter: Option<bool>) -> Result<()> {
    let handle = get_handle()?;
    let localdb = handle.localdb();
    let mut all_results: Vec<SearchResult> = Vec::new();
    let mut repo_set: std::collections::HashSet<String> = std::collections::HashSet::new();
    let query_lower = query.to_lowercase();

    for syncdb in handle.syncdbs() {
        for pkg in syncdb.pkgs() {
            let name_match = pkg.name().to_lowercase().contains(&query_lower);
            let desc_match = pkg
                .desc()
                .map(|d| d.to_lowercase().contains(&query_lower))
                .unwrap_or(false);

            if name_match || desc_match {
                let repo_name = syncdb.name().to_string();
                repo_set.insert(repo_name.clone());
                let local_pkg = localdb.pkg(pkg.name()).ok();
                let is_installed = local_pkg.is_some();

                if let Some(filter) = installed_filter {
                    if is_installed != filter {
                        continue;
                    }
                }

                all_results.push(SearchResult {
                    name: pkg.name().to_string(),
                    version: pkg.version().to_string(),
                    description: pkg.desc().map(|s| s.to_string()),
                    repository: repo_name,
                    installed: is_installed,
                    installed_version: local_pkg.map(|p| p.version().to_string()),
                });
            }
        }
    }

    let total = all_results.len();
    let results: Vec<SearchResult> = all_results.into_iter().skip(offset).take(limit).collect();
    let mut repositories: Vec<String> = repo_set.into_iter().collect();
    repositories.sort();

    let response = SearchResponse { results, total, repositories };
    println!("{}", serde_json::to_string(&response)?);
    Ok(())
}

#[derive(Serialize)]
struct SyncPackageDetails {
    name: String,
    version: String,
    description: Option<String>,
    url: Option<String>,
    licenses: Vec<String>,
    groups: Vec<String>,
    provides: Vec<String>,
    depends: Vec<String>,
    optdepends: Vec<String>,
    conflicts: Vec<String>,
    replaces: Vec<String>,
    download_size: i64,
    installed_size: i64,
    packager: Option<String>,
    architecture: Option<String>,
    build_date: i64,
    repository: String,
}

fn sync_package_info(name: &str, repo: Option<&str>) -> Result<()> {
    let handle = get_handle()?;

    // If repo specified, search only that repo; otherwise search all
    let pkg_result = if let Some(repo_name) = repo {
        handle
            .syncdbs()
            .iter()
            .find(|db| db.name() == repo_name)
            .and_then(|db| db.pkg(name).ok())
            .map(|pkg| (pkg, repo_name.to_string()))
    } else {
        handle
            .syncdbs()
            .iter()
            .find_map(|db| db.pkg(name).ok().map(|pkg| (pkg, db.name().to_string())))
    };

    let (pkg, repository) = pkg_result
        .ok_or_else(|| anyhow::anyhow!("Package '{}' not found in sync databases", name))?;

    let details = SyncPackageDetails {
        name: pkg.name().to_string(),
        version: pkg.version().to_string(),
        description: pkg.desc().map(|s| s.to_string()),
        url: pkg.url().map(|s| s.to_string()),
        licenses: pkg.licenses().iter().map(|s| s.to_string()).collect(),
        groups: pkg.groups().iter().map(|s| s.to_string()).collect(),
        provides: pkg.provides().iter().map(|d| d.name().to_string()).collect(),
        depends: pkg.depends().iter().map(|d| d.name().to_string()).collect(),
        optdepends: pkg.optdepends().iter().map(|d| d.name().to_string()).collect(),
        conflicts: pkg.conflicts().iter().map(|d| d.name().to_string()).collect(),
        replaces: pkg.replaces().iter().map(|d| d.name().to_string()).collect(),
        download_size: pkg.download_size(),
        installed_size: pkg.isize(),
        packager: pkg.packager().map(|s| s.to_string()),
        architecture: pkg.arch().map(|s| s.to_string()),
        build_date: pkg.build_date(),
        repository,
    };

    println!("{}", serde_json::to_string(&details)?);
    Ok(())
}

fn print_usage() {
    eprintln!("Usage: cockpit-pacman-backend <command> [args]");
    eprintln!();
    eprintln!("Commands:");
    eprintln!("  list-installed [offset] [limit] [search] [filter] [repo]");
    eprintln!("                         List installed packages (paginated)");
    eprintln!("                         filter: all|explicit|dependency");
    eprintln!("                         repo: all|core|extra|multilib|local|...");
    eprintln!("  check-updates          Check for available updates");
    eprintln!("  local-package-info NAME");
    eprintln!("                         Get detailed info for an installed package");
    eprintln!("  sync-package-info NAME [REPO]");
    eprintln!("                         Get detailed info for a package from sync databases");
    eprintln!("  search QUERY [offset] [limit] [installed]");
    eprintln!("                         Search packages by name/description (paginated)");
    eprintln!("                         installed: all|installed|not-installed");
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
            let filter = args.get(5).map(|s| s.as_str()).filter(|s| !s.is_empty() && *s != "all");
            let repo_filter = args.get(6).map(|s| s.as_str()).filter(|s| !s.is_empty() && *s != "all");
            validate_pagination(offset, limit)
                .and_then(|_| list_installed(offset, limit, search, filter, repo_filter))
        }
        "check-updates" => check_updates(),
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
            validate_search_query(&args[2])
                .and_then(|_| validate_pagination(offset, limit))
                .and_then(|_| search(&args[2], offset, limit, installed_filter))
        }
        "sync-package-info" => {
            if args.len() < 3 {
                eprintln!("Error: sync-package-info requires a package name");
                std::process::exit(1);
            }
            let repo = args.get(3).map(|s| s.as_str()).filter(|s| !s.is_empty());
            validate_package_name(&args[2]).and_then(|_| sync_package_info(&args[2], repo))
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
