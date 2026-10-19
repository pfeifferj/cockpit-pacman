use anyhow::Result;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::alpm::{find_available_updates, get_handle, reason_to_string};
use crate::db::{find_package_repo, get_repo_map};
use crate::models::{
    InvalidInput, OrphanPackage, OrphanResponse, Package, PackageDetails, PackageListResponse,
    RepositoryCount, SearchResponse, SearchResult, SyncPackageDetails, UpdatesResponse,
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
    let sync_dir = crate::handlers::lock::db_lock_path().with_file_name("sync");
    let response = UpdatesResponse {
        updates,
        warnings,
        last_sync_at: crate::handlers::log::last_sync_at(),
        oldest_database_at: oldest_sync_db_mtime(
            handle.syncdbs().iter().map(|db| db.name()),
            &sync_dir,
        ),
    };
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
        installed_optdepends: Some(installed_optdepends(handle.localdb(), pkg.optdepends())),
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
    repo_filter: Option<&str>,
    sort_by: Option<&str>,
    sort_dir: Option<&str>,
) -> Result<()> {
    let handle = get_handle()?;
    let localdb = handle.localdb();
    let query_lower = query.to_lowercase();
    let repo_names: Vec<String> = handle
        .syncdbs()
        .iter()
        .map(|db| db.name().to_string())
        .collect();

    let mut matches: Vec<SearchResult> = Vec::new();
    for syncdb in handle.syncdbs() {
        for pkg in syncdb.pkgs() {
            let name_match = pkg.name().to_lowercase().contains(&query_lower);
            let desc_match = pkg
                .desc()
                .map(|d| d.to_lowercase().contains(&query_lower))
                .unwrap_or(false);
            if !name_match && !desc_match {
                continue;
            }
            let local_pkg = localdb.pkg(pkg.name()).ok();
            matches.push(SearchResult {
                name: pkg.name().to_string(),
                version: pkg.version().to_string(),
                description: pkg.desc().map(|s| s.to_string()),
                repository: syncdb.name().to_string(),
                installed: local_pkg.is_some(),
                installed_version: local_pkg.map(|p| p.version().to_string()),
            });
        }
    }

    let filters = SearchFilters {
        installed: installed_filter,
        repo: repo_filter,
        sort_by,
        sort_dir,
        offset,
        limit,
    };
    emit_json(&filter_search(matches, &repo_names, &filters)?)
}

pub(crate) struct SearchFilters<'a> {
    pub installed: Option<bool>,
    pub repo: Option<&'a str>,
    pub sort_by: Option<&'a str>,
    pub sort_dir: Option<&'a str>,
    pub offset: usize,
    pub limit: usize,
}

/// Each facet count ignores its own filter.
pub(crate) fn filter_search(
    matches: Vec<SearchResult>,
    repo_names: &[String],
    filters: &SearchFilters,
) -> Result<SearchResponse> {
    if let Some(repo) = filters.repo
        && !repo_names.iter().any(|r| r == repo)
    {
        return Err(InvalidInput(format!(
            "Invalid repository '{}'. Valid repositories: {}",
            repo,
            repo_names.join(", ")
        ))
        .into());
    }

    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut total_installed = 0usize;
    let mut total_not_installed = 0usize;
    let mut filtered: Vec<SearchResult> = Vec::new();

    for result in matches {
        let in_repo = filters.repo.is_none_or(|r| r == result.repository);
        let in_state = filters.installed.is_none_or(|i| i == result.installed);
        let count = counts.entry(result.repository.clone()).or_insert(0);
        if in_state {
            *count += 1;
        }
        if !in_repo {
            continue;
        }
        if result.installed {
            total_installed += 1;
        } else {
            total_not_installed += 1;
        }
        if in_state {
            filtered.push(result);
        }
    }

    let ascending = filters.sort_dir != Some("desc");
    match filters.sort_by {
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
    let results: Vec<SearchResult> = filtered
        .into_iter()
        .skip(filters.offset)
        .take(filters.limit)
        .collect();
    let mut repository_counts: Vec<RepositoryCount> = counts
        .into_iter()
        .map(|(name, count)| RepositoryCount { name, count })
        .collect();
    repository_counts.sort_by(|a, b| a.name.cmp(&b.name));
    let repositories = repository_counts.iter().map(|c| c.name.clone()).collect();

    Ok(SearchResponse {
        results,
        total,
        total_installed,
        total_not_installed,
        repositories,
        repository_counts: Some(repository_counts),
    })
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
        installed_optdepends: Some(installed_optdepends(handle.localdb(), pkg.optdepends())),
        installed_version: handle
            .localdb()
            .pkg(name)
            .ok()
            .map(|p| p.version().to_string()),
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

fn installed_optdepends<'a>(
    localdb: &alpm::Db,
    optdepends: impl IntoIterator<Item = &'a alpm::Dep>,
) -> Vec<String> {
    let installed = localdb.pkgs();
    optdepends
        .into_iter()
        .filter(|d| installed.find_satisfier(d.name()).is_some())
        .map(|d| d.name().to_string())
        .collect()
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

#[cfg(test)]
mod optdepends_tests {
    use super::installed_optdepends;
    use std::path::PathBuf;

    struct TestRoot(PathBuf);

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn local_db(tag: &str, packages: &[(&str, &[&str], &[&str])]) -> TestRoot {
        let root = TestRoot(
            std::env::temp_dir().join(format!("cpac-optdepends-{}-{tag}", std::process::id())),
        );
        let local = root.0.join("local");
        std::fs::create_dir_all(&local).unwrap();
        std::fs::write(local.join("ALPM_DB_VERSION"), "9\n").unwrap();
        for (name, provides, optdepends) in packages {
            let dir = local.join(format!("{name}-1-1"));
            std::fs::create_dir(&dir).unwrap();
            let mut desc = format!("%NAME%\n{name}\n\n%VERSION%\n1-1\n\n%REASON%\n0\n\n");
            for (field, values) in [("PROVIDES", provides), ("OPTDEPENDS", optdepends)] {
                if !values.is_empty() {
                    desc.push_str(&format!("%{field}%\n{}\n\n", values.join("\n")));
                }
            }
            std::fs::write(dir.join("desc"), desc).unwrap();
        }
        root
    }

    #[test]
    fn installed_optdepends_lists_installed_and_provided_entries() {
        let root = local_db(
            "mixed",
            &[
                (
                    "vim",
                    &[],
                    &[
                        "python: Python scripting",
                        "ruby: Ruby scripting",
                        "java-runtime: Java",
                    ],
                ),
                ("python", &[], &[]),
                ("jre-openjdk", &["java-runtime=21"], &[]),
            ],
        );
        let path = root.0.to_str().unwrap();
        let handle = alpm::Alpm::new(path, path).unwrap();
        let localdb = handle.localdb();
        let vim = localdb.pkg("vim").unwrap();
        assert_eq!(
            installed_optdepends(localdb, vim.optdepends()),
            vec!["python".to_string(), "java-runtime".to_string()]
        );
    }

    #[test]
    fn installed_optdepends_is_empty_when_nothing_is_installed() {
        let root = local_db("none", &[("vim", &[], &["ruby: Ruby scripting"])]);
        let path = root.0.to_str().unwrap();
        let handle = alpm::Alpm::new(path, path).unwrap();
        let localdb = handle.localdb();
        let vim = localdb.pkg("vim").unwrap();
        assert!(installed_optdepends(localdb, vim.optdepends()).is_empty());
    }
}

#[cfg(test)]
mod search_tests {
    use super::{SearchFilters, filter_search};
    use crate::models::{InvalidInput, RepositoryCount, SearchResult};

    fn result(name: &str, repo: &str, installed: bool) -> SearchResult {
        SearchResult {
            name: name.into(),
            version: "1-1".into(),
            description: None,
            repository: repo.into(),
            installed,
            installed_version: installed.then(|| "1-1".into()),
        }
    }

    fn matches() -> Vec<SearchResult> {
        vec![
            result("linux", "core", true),
            result("linux-lts", "core", false),
            result("linux", "core-testing", false),
            result("linux-zen", "extra", false),
            result("linux-firmware", "core", true),
        ]
    }

    fn repos() -> Vec<String> {
        ["core", "core-testing", "extra", "multilib"]
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    fn filters<'a>(installed: Option<bool>, repo: Option<&'a str>) -> SearchFilters<'a> {
        SearchFilters {
            installed,
            repo,
            sort_by: None,
            sort_dir: None,
            offset: 0,
            limit: 100,
        }
    }

    fn count(name: &str, count: usize) -> RepositoryCount {
        RepositoryCount {
            name: name.into(),
            count,
        }
    }

    #[test]
    fn a_repository_filter_keeps_only_that_repository() {
        let r = filter_search(matches(), &repos(), &filters(None, Some("core"))).unwrap();
        assert!(r.results.iter().all(|x| x.repository == "core"));
        assert_eq!(r.total, 3);
        assert_eq!(r.total_installed, 2);
        assert_eq!(r.total_not_installed, 1);
    }

    #[test]
    fn repository_counts_sum_to_the_unfiltered_total() {
        let all = filter_search(matches(), &repos(), &filters(None, None)).unwrap();
        let narrowed = filter_search(matches(), &repos(), &filters(None, Some("extra"))).unwrap();
        for r in [&all, &narrowed] {
            let counts = r.repository_counts.as_deref().unwrap();
            assert_eq!(counts.iter().map(|c| c.count).sum::<usize>(), all.total);
            assert_eq!(
                counts,
                vec![
                    count("core", 3),
                    count("core-testing", 1),
                    count("extra", 1)
                ]
            );
            assert_eq!(r.repositories, vec!["core", "core-testing", "extra"]);
        }
    }

    #[test]
    fn repository_counts_follow_the_installed_filter() {
        let r = filter_search(matches(), &repos(), &filters(Some(false), Some("core"))).unwrap();
        assert_eq!(r.total, 1);
        assert_eq!(
            r.repository_counts.unwrap(),
            vec![
                count("core", 1),
                count("core-testing", 1),
                count("extra", 1)
            ]
        );
    }

    #[test]
    fn a_repository_without_matches_is_valid_and_empty() {
        let r = filter_search(matches(), &repos(), &filters(None, Some("multilib"))).unwrap();
        assert_eq!(r.total, 0);
        assert!(r.results.is_empty());
    }

    #[test]
    fn paging_applies_to_the_filtered_set() {
        let mut f = filters(None, Some("core"));
        f.sort_by = Some("name");
        f.offset = 1;
        f.limit = 1;
        let r = filter_search(matches(), &repos(), &f).unwrap();
        assert_eq!(r.total, 3);
        assert_eq!(r.results.len(), 1);
        assert_eq!(r.results[0].name, "linux-firmware");
    }

    #[test]
    fn an_unknown_repository_is_refused_as_invalid_input() {
        let err = filter_search(matches(), &repos(), &filters(None, Some("nope")))
            .err()
            .unwrap();
        assert!(err.chain().any(|c| c.is::<InvalidInput>()));
    }
}

pub(crate) fn oldest_sync_db_mtime<'a>(
    repos: impl IntoIterator<Item = &'a str>,
    sync_dir: &Path,
) -> Option<i64> {
    let mut oldest: Option<i64> = None;
    for name in repos {
        let modified = std::fs::metadata(sync_dir.join(format!("{name}.db")))
            .and_then(|m| m.modified())
            .ok()?;
        let secs = match modified.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_secs() as i64,
            Err(e) => -(e.duration().as_secs() as i64),
        };
        oldest = Some(oldest.map_or(secs, |o| o.min(secs)));
    }
    oldest
}
