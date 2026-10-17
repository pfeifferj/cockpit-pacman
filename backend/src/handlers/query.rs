use anyhow::Result;
use std::collections::HashSet;

use crate::alpm::{find_available_updates, get_handle, reason_to_string};
use crate::db::{find_package_repo, get_repo_map};
use crate::models::{
    OrphanPackage, OrphanResponse, Package, PackageDetails, PackageListResponse, SearchResponse,
    SearchResult, SyncPackageDetails, UpdatesResponse,
};
use crate::util::{emit_json, sort_with_direction};

pub fn list_installed(
    offset: usize,
    limit: usize,
    search: Option<&str>,
    filter: Option<&str>,
    repo_filter: Option<&str>,
    sort_by: Option<&str>,
    sort_dir: Option<&str>,
) -> Result<()> {
    let handle = get_handle()?;
    let localdb = handle.localdb();
    let repo_map = get_repo_map(&handle);

    if let Some(repo_f) = repo_filter {
        let valid_repos: HashSet<&str> = handle
            .syncdbs()
            .iter()
            .map(|db| db.name())
            .chain(std::iter::once("user"))
            .collect();

        if !valid_repos.contains(repo_f) {
            anyhow::bail!(
                "Invalid repository '{}'. Valid repositories: {}",
                repo_f,
                valid_repos.into_iter().collect::<Vec<_>>().join(", ")
            );
        }
    }

    let search_lower = search.map(|s| s.to_lowercase());
    let filter_reason = filter.and_then(|f| match f {
        "explicit" => Some(alpm::PackageReason::Explicit),
        "dependency" => Some(alpm::PackageReason::Depend),
        _ => None,
    });

    let (mut filtered, repo_set, total_explicit, total_dependency) = localdb.pkgs().iter().fold(
        (Vec::new(), HashSet::<String>::new(), 0usize, 0usize),
        |(mut filtered, mut repo_set, mut total_explicit, mut total_dependency), pkg| {
            let repo = repo_map.get(pkg.name()).map(|s| s.to_string());
            repo_set.insert(repo.as_deref().unwrap_or("user").to_string());

            if let Some(ref query) = search_lower {
                let name_match = pkg.name().to_lowercase().contains(query);
                let desc_match = pkg
                    .desc()
                    .map(|d| d.to_lowercase().contains(query))
                    .unwrap_or(false);
                if !name_match && !desc_match {
                    return (filtered, repo_set, total_explicit, total_dependency);
                }
            }

            if let Some(repo_f) = repo_filter
                && repo.as_deref().unwrap_or("user") != repo_f
            {
                return (filtered, repo_set, total_explicit, total_dependency);
            }

            match pkg.reason() {
                alpm::PackageReason::Explicit => total_explicit += 1,
                alpm::PackageReason::Depend => total_dependency += 1,
            }

            if filter_reason.is_none_or(|r| pkg.reason() == r) {
                filtered.push((pkg, repo));
            }

            (filtered, repo_set, total_explicit, total_dependency)
        },
    );

    let ascending = sort_dir != Some("desc");
    match sort_by {
        Some("name") => sort_with_direction(&mut filtered, ascending, |(a, _), (b, _)| {
            a.name().cmp(b.name())
        }),
        Some("size") => sort_with_direction(&mut filtered, ascending, |(a, _), (b, _)| {
            a.isize().cmp(&b.isize())
        }),
        Some("reason") => sort_with_direction(&mut filtered, ascending, |(a, _), (b, _)| {
            reason_to_string(a.reason()).cmp(reason_to_string(b.reason()))
        }),
        _ => {}
    }

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
            reason: reason_to_string(pkg.reason()).to_string(),
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

    emit_json(&response)
}

pub fn check_updates() -> Result<()> {
    let handle = get_handle()?;
    let (config, degraded) = crate::config::AppConfig::load_degraded()?;
    let updates = find_available_updates(&handle, &config.ignored_packages);

    let mut warnings = Vec::new();
    if degraded {
        warnings.push("Saved cockpit-pacman package ignores could not be read".to_string());
    }
    let response = UpdatesResponse { updates, warnings };
    emit_json(&response)
}

fn split_licenses(license: &str) -> Vec<String> {
    license
        .split(" AND ")
        .flat_map(|s| s.split(" OR "))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

pub fn local_package_info(name: &str) -> Result<()> {
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
        licenses: pkg.licenses().iter().flat_map(split_licenses).collect(),
        groups: pkg.groups().iter().map(|s| s.to_string()).collect(),
        provides: pkg
            .provides()
            .iter()
            .map(|d| d.name().to_string())
            .collect(),
        depends: pkg.depends().iter().map(|d| d.name().to_string()).collect(),
        optdepends: pkg
            .optdepends()
            .iter()
            .map(|d| d.name().to_string())
            .collect(),
        conflicts: pkg
            .conflicts()
            .iter()
            .map(|d| d.name().to_string())
            .collect(),
        replaces: pkg
            .replaces()
            .iter()
            .map(|d| d.name().to_string())
            .collect(),
        required_by: pkg.required_by().into_iter().collect(),
        optional_for: pkg.optional_for().into_iter().collect(),
        installed_size: pkg.isize(),
        packager: pkg.packager().map(|s| s.to_string()),
        architecture: pkg.arch().map(|s| s.to_string()),
        build_date: pkg.build_date(),
        install_date: pkg.install_date(),
        reason: reason_to_string(pkg.reason()).to_string(),
        validation: pkg
            .validation()
            .iter()
            .map(|v| {
                match v {
                    alpm::PackageValidation::MD5SUM => "MD5",
                    alpm::PackageValidation::SHA256SUM => "SHA-256",
                    alpm::PackageValidation::SIGNATURE => "PGP Signature",
                    _ => "Unknown",
                }
                .to_string()
            })
            .collect(),
        repository,
        update_stats: crate::log_cache::package_stats(name),
    };

    emit_json(&details)
}

pub fn search(
    query: &str,
    offset: usize,
    limit: usize,
    installed_filter: Option<bool>,
    sort_by: Option<&str>,
    sort_dir: Option<&str>,
) -> Result<()> {
    let handle = get_handle()?;
    let localdb = handle.localdb();
    let mut repo_set: HashSet<String> = HashSet::new();
    let query_lower = query.to_lowercase();

    let mut total_installed = 0usize;
    let mut total_not_installed = 0usize;
    let mut filtered: Vec<SearchResult> = Vec::new();

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

                if is_installed {
                    total_installed += 1;
                } else {
                    total_not_installed += 1;
                }

                let should_include = match installed_filter {
                    Some(filter) => is_installed == filter,
                    None => true,
                };

                if should_include {
                    filtered.push(SearchResult {
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
    }

    let ascending = sort_dir != Some("desc");
    match sort_by {
        Some("name") => sort_with_direction(&mut filtered, ascending, |a, b| a.name.cmp(&b.name)),
        Some("repository") => sort_with_direction(&mut filtered, ascending, |a, b| {
            a.repository.cmp(&b.repository)
        }),
        Some("status") => sort_with_direction(&mut filtered, ascending, |a, b| {
            a.installed.cmp(&b.installed)
        }),
        _ => {}
    }

    let total = filtered.len();
    let results: Vec<SearchResult> = filtered.into_iter().skip(offset).take(limit).collect();
    let mut repositories: Vec<String> = repo_set.into_iter().collect();
    repositories.sort();

    let response = SearchResponse {
        results,
        total,
        total_installed,
        total_not_installed,
        repositories,
    };
    emit_json(&response)
}

pub fn sync_package_info(name: &str, repo: Option<&str>) -> Result<()> {
    let handle = get_handle()?;

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
        licenses: pkg.licenses().iter().flat_map(split_licenses).collect(),
        groups: pkg.groups().iter().map(|s| s.to_string()).collect(),
        provides: pkg
            .provides()
            .iter()
            .map(|d| d.name().to_string())
            .collect(),
        depends: pkg.depends().iter().map(|d| d.name().to_string()).collect(),
        optdepends: pkg
            .optdepends()
            .iter()
            .map(|d| d.name().to_string())
            .collect(),
        conflicts: pkg
            .conflicts()
            .iter()
            .map(|d| d.name().to_string())
            .collect(),
        replaces: pkg
            .replaces()
            .iter()
            .map(|d| d.name().to_string())
            .collect(),
        download_size: pkg.download_size(),
        installed_size: pkg.isize(),
        packager: pkg.packager().map(|s| s.to_string()),
        architecture: pkg.arch().map(|s| s.to_string()),
        build_date: pkg.build_date(),
        repository,
    };

    emit_json(&details)
}

fn depended_on_names(localdb: &alpm::Db) -> HashSet<String> {
    let mut names = HashSet::new();
    for pkg in localdb.pkgs() {
        for dep in pkg.depends() {
            if !names.contains(dep.name()) {
                names.insert(dep.name().to_string());
            }
        }
        for dep in pkg.optdepends() {
            if !names.contains(dep.name()) {
                names.insert(dep.name().to_string());
            }
        }
    }
    names
}

fn nothing_depends_on<'a>(
    name: &str,
    provides: impl Iterator<Item = &'a str>,
    depended_on: &HashSet<String>,
) -> bool {
    !depended_on.contains(name) && !provides.into_iter().any(|p| depended_on.contains(p))
}

pub fn list_orphans() -> Result<()> {
    let handle = get_handle()?;
    let localdb = handle.localdb();
    let repo_map = get_repo_map(&handle);
    let depended_on = depended_on_names(localdb);

    let orphans: Vec<OrphanPackage> = localdb
        .pkgs()
        .iter()
        .filter(|pkg| {
            pkg.reason() == alpm::PackageReason::Depend
                && nothing_depends_on(
                    pkg.name(),
                    pkg.provides().iter().map(|p| p.name()),
                    &depended_on,
                )
        })
        .map(|pkg| OrphanPackage {
            name: pkg.name().to_string(),
            version: pkg.version().to_string(),
            description: pkg.desc().map(|s| s.to_string()),
            installed_size: pkg.isize(),
            install_date: pkg.install_date(),
            repository: repo_map.get(pkg.name()).map(|s| s.to_string()),
        })
        .collect();

    let total_size: i64 = orphans.iter().map(|p| p.installed_size).sum();

    let response = OrphanResponse {
        orphans,
        total_size,
    };

    emit_json(&response)
}

#[cfg(test)]
mod orphan_tests {
    use super::nothing_depends_on;
    use std::collections::HashSet;

    fn depended_on(names: &[&str]) -> HashSet<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_package_nothing_names_is_an_orphan() {
        let d = depended_on(&["glibc", "bash"]);
        assert!(nothing_depends_on("leftover", std::iter::empty(), &d));
    }

    #[test]
    fn a_package_named_directly_is_not() {
        let d = depended_on(&["glibc"]);
        assert!(!nothing_depends_on("glibc", std::iter::empty(), &d));
    }

    #[test]
    fn a_package_wanted_only_through_what_it_provides_is_not() {
        let d = depended_on(&["sh"]);
        assert!(!nothing_depends_on(
            "bash",
            ["sh", "bash-shell"].into_iter(),
            &d
        ));
    }
}
