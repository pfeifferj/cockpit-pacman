use anyhow::Result;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use crate::alpm::get_handle;
use crate::models::{CacheFiles, CacheGroup, CacheInfo, CachePackage, StreamEvent};
use crate::util::{emit_event, emit_json, get_cache_dir, list_cache_packages};

fn cache_packages(cache_path: &Path, name_filter: Option<&str>) -> Vec<CachePackage> {
    list_cache_packages(cache_path)
        .into_iter()
        .filter_map(|(entry, filename, name, version)| {
            if name_filter.is_some_and(|filter| name != filter) {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            Some(CachePackage {
                name,
                version,
                filename,
                size: metadata.len() as i64,
            })
        })
        .collect()
}

fn cache_info_at(
    cache_path: &Path,
    offset: usize,
    limit: usize,
    search: &str,
    sort_by: &str,
    sort_dir: &str,
) -> Result<CacheInfo> {
    crate::validation::validate_pagination(offset, limit)?;
    if !search.is_empty() {
        crate::validation::validate_search_query(search)?;
    }
    if !matches!(sort_by, "name" | "version" | "size") {
        anyhow::bail!("Invalid cache sort field: {}", sort_by);
    }
    if !matches!(sort_dir, "asc" | "desc") {
        anyhow::bail!("Invalid cache sort direction: {}", sort_dir);
    }

    let mut groups: HashMap<String, CacheGroup> = HashMap::new();
    let mut multi_version_packages = HashSet::new();
    let mut total_size = 0;
    let mut package_count = 0;
    for file in cache_packages(cache_path, None) {
        total_size += file.size;
        package_count += 1;
        let group = groups
            .entry(file.name.clone())
            .or_insert_with(|| CacheGroup {
                name: file.name,
                latest_version: file.version.clone(),
                file_count: 0,
                total_size: 0,
            });
        if file.version != group.latest_version {
            multi_version_packages.insert(group.name.clone());
        }
        if alpm::vercmp(file.version.as_str(), group.latest_version.as_str()).is_gt() {
            group.latest_version = file.version;
        }
        group.file_count += 1;
        group.total_size += file.size;
    }

    let unique_packages = groups.len();
    let multi_version_packages = multi_version_packages.len();
    let search = search.to_lowercase();
    let mut groups: Vec<_> = groups
        .into_values()
        .filter(|group| group.name.to_lowercase().contains(&search))
        .collect();
    groups.sort_by(|a, b| {
        let order = match sort_by {
            "size" => a.total_size.cmp(&b.total_size),
            "version" => alpm::vercmp(a.latest_version.as_str(), b.latest_version.as_str()),
            _ => a.name.cmp(&b.name),
        };
        let order = if sort_dir == "desc" {
            order.reverse()
        } else {
            order
        };
        order.then_with(|| a.name.cmp(&b.name))
    });
    let total = groups.len();
    Ok(CacheInfo {
        total_size,
        package_count,
        unique_packages,
        multi_version_packages,
        total,
        groups: groups.into_iter().skip(offset).take(limit).collect(),
        path: cache_path.to_string_lossy().into_owned(),
    })
}

pub fn get_cache_info(
    offset: usize,
    limit: usize,
    search: &str,
    sort_by: &str,
    sort_dir: &str,
) -> Result<()> {
    let info = cache_info_at(
        Path::new(&get_cache_dir()),
        offset,
        limit,
        search,
        sort_by,
        sort_dir,
    )?;
    emit_json(&info)
}

fn cache_files_at(
    cache_path: &Path,
    name: &str,
    offset: usize,
    limit: usize,
) -> Result<CacheFiles> {
    crate::validation::validate_package_name(name)?;
    crate::validation::validate_pagination(offset, limit)?;
    let mut files = cache_packages(cache_path, Some(name));
    files.sort_by(|a, b| {
        alpm::vercmp(b.version.as_str(), a.version.as_str())
            .then_with(|| a.filename.cmp(&b.filename))
    });
    let total = files.len();
    Ok(CacheFiles {
        files: files.into_iter().skip(offset).take(limit).collect(),
        total,
    })
}

pub fn get_cache_files(name: &str, offset: usize, limit: usize) -> Result<()> {
    emit_json(&cache_files_at(
        Path::new(&get_cache_dir()),
        name,
        offset,
        limit,
    )?)
}

pub fn validate_cache_selection(mode: &str, packages: &[String]) -> Result<()> {
    match mode {
        "all" if !packages.is_empty() => {
            anyhow::bail!("All-package cleanup does not accept package names")
        }
        "only" if packages.is_empty() => anyhow::bail!("Select at least one package to clean"),
        "all" | "only" | "except" => {}
        _ => anyhow::bail!("Invalid cache selection mode: {}", mode),
    }
    packages
        .iter()
        .try_for_each(|name| crate::validation::validate_package_name(name))
}

fn selected_for_cleanup(name: &str, mode: &str, packages: &HashSet<&str>) -> bool {
    match mode {
        "all" => true,
        "only" => packages.contains(name),
        "except" => !packages.contains(name),
        _ => false,
    }
}

pub fn clean_cache(keep_versions: u32, filter_pkgs: &[String], mode: &str) -> Result<()> {
    validate_cache_selection(mode, filter_pkgs)?;
    crate::util::setup_signal_handler()?;
    crate::util::spawn_cancel_listener()?;
    let handle = get_handle()?;
    let cache_dir = get_cache_dir();
    let cache_path = Path::new(&cache_dir);

    emit_event(&StreamEvent::Event {
        event: "Starting cache cleanup".to_string(),
        package: None,
    });

    if !cache_path.exists() {
        emit_event(&StreamEvent::Complete {
            success: true,
            code: None,
            details: None,
            message: Some("Cache directory does not exist".to_string()),
        });
        return Ok(());
    }

    let filter: HashSet<&str> = filter_pkgs.iter().map(|s| s.as_str()).collect();

    let mut groups: HashMap<String, Vec<(fs::DirEntry, String, String)>> = HashMap::new();
    for (entry, filename, name, version) in list_cache_packages(cache_path) {
        if !selected_for_cleanup(&name, mode, &filter) {
            continue;
        }
        groups
            .entry(name)
            .or_default()
            .push((entry, filename, version));
    }

    let mut removed_count: u32 = 0;
    let mut freed_bytes: u64 = 0;
    let keep = keep_versions as usize;

    for versions in groups.values_mut() {
        if versions.len() <= keep {
            continue;
        }
        versions
            .sort_by(|a, b| alpm::vercmp(b.2.as_str(), a.2.as_str()).then_with(|| a.1.cmp(&b.1)));

        let mut kept = 0usize;
        for (entry, filename, _) in versions.iter() {
            if crate::util::is_cancelled() {
                crate::util::emit_cancellation_complete(&crate::util::CheckResult::Cancelled);
                return Ok(());
            }
            let path = entry.path();

            let loadable = path
                .to_str()
                .is_some_and(|p| handle.pkg_load(p, false, alpm::SigLevel::NONE).is_ok());
            if !loadable {
                emit_event(&StreamEvent::Log {
                    level: "warning".to_string(),
                    message: format!("Skipping {}: not a readable package", filename),
                });
                continue;
            }
            if kept < keep {
                kept += 1;
                continue;
            }

            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);

            match fs::remove_file(&path) {
                Ok(()) => {
                    removed_count += 1;
                    freed_bytes += size;
                    emit_event(&StreamEvent::Log {
                        level: "info".to_string(),
                        message: format!("Removed {}", filename),
                    });

                    let sig_path = path.with_file_name(format!("{}.sig", filename));
                    if sig_path.exists()
                        && let Err(e) = fs::remove_file(&sig_path)
                    {
                        emit_event(&StreamEvent::Log {
                            level: "warning".to_string(),
                            message: format!("Failed to remove {}.sig: {}", filename, e),
                        });
                    }
                }
                Err(e) => {
                    emit_event(&StreamEvent::Log {
                        level: "warning".to_string(),
                        message: format!("Failed to remove {}: {}", filename, e),
                    });
                }
            }
        }
    }

    let message = if removed_count == 0 {
        "No packages to remove".to_string()
    } else {
        format!(
            "Removed {} package{}, freed {}",
            removed_count,
            if removed_count == 1 { "" } else { "s" },
            format_bytes(freed_bytes)
        )
    };

    emit_event(&StreamEvent::Complete {
        success: true,
        code: None,
        details: None,
        message: Some(message),
    });

    Ok(())
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: &[&str] = &["B", "KiB", "MiB", "GiB"];
    let mut size = bytes as f64;
    for unit in UNITS {
        if size < 1024.0 {
            return format!("{:.2} {}", size, unit);
        }
        size /= 1024.0;
    }
    format!("{:.2} TiB", size)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct CacheDir(PathBuf);

    impl CacheDir {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "cockpit-cache-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn file(&self, filename: &str, size: usize) {
            fs::write(self.0.join(filename), vec![0; size]).unwrap();
        }
    }

    impl Drop for CacheDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn groups_are_paged_without_losing_global_totals() {
        let cache = CacheDir::new();
        for i in 0..105 {
            cache.file(&format!("pkg{i:03}-1.0-1-any.pkg.tar.zst"), 2);
        }
        cache.file("pkg000-2.0-1-x86_64.pkg.tar.zst", 5);
        let first = cache_info_at(&cache.0, 0, 50, "", "name", "asc").unwrap();
        let second = cache_info_at(&cache.0, 50, 50, "", "name", "asc").unwrap();
        assert_eq!(first.groups.len(), 50);
        assert_eq!(first.groups[0].name, "pkg000");
        assert_eq!(second.groups[0].name, "pkg050");
        assert_eq!(first.total, 105);
        assert_eq!(first.unique_packages, 105);
        assert_eq!(first.package_count, 106);
        assert_eq!(first.total_size, 215);
        assert_eq!(first.multi_version_packages, 1);
        let filtered = cache_info_at(&cache.0, 0, 50, "PKG000", "name", "asc").unwrap();
        assert_eq!(filtered.total, 1);
        assert_eq!(filtered.groups[0].file_count, 2);
        assert_eq!(filtered.groups[0].total_size, 7);
        assert_eq!(filtered.total_size, first.total_size);
        assert_eq!(filtered.unique_packages, 105);
        let absent = cache_info_at(&cache.0, 0, 50, "absent", "name", "asc").unwrap();
        assert_eq!(absent.total, 0);
        assert_eq!(absent.package_count, 106);
    }

    #[test]
    fn package_file_pages_preserve_architecture_and_compression_identity() {
        let cache = CacheDir::new();
        for i in 0..105 {
            cache.file(&format!("linux-{i}-1-x86_64.pkg.tar.zst"), 1);
        }
        cache.file("linux-104-1-aarch64.pkg.tar.zst", 2);
        cache.file("linux-104-1-x86_64.pkg.tar.xz", 3);
        let group = cache_info_at(&cache.0, 0, 1, "", "name", "asc").unwrap();
        assert_eq!(group.groups.len(), 1);
        assert_eq!(group.groups[0].file_count, 107);
        assert_eq!(group.groups[0].latest_version, "104-1");
        let first = cache_files_at(&cache.0, "linux", 0, 2).unwrap();
        let second = cache_files_at(&cache.0, "linux", 2, 2).unwrap();
        assert_eq!(first.total, 107);
        assert_eq!(first.files.len(), 2);
        assert_eq!(first.files[0].filename, "linux-104-1-aarch64.pkg.tar.zst");
        assert_eq!(first.files[1].filename, "linux-104-1-x86_64.pkg.tar.xz");
        assert_eq!(second.files[0].filename, "linux-104-1-x86_64.pkg.tar.zst");
        assert_eq!(second.files[1].version, "103-1");
        let serialized = serde_json::to_string(&group).unwrap();
        assert!(
            serialized.len() < 500,
            "one large package history stays a summary"
        );
    }

    #[test]
    fn version_sort_uses_alpm_and_breaks_equal_keys_by_name() {
        let cache = CacheDir::new();
        for (name, version) in [
            ("zeta", "9-1"),
            ("alpha", "10-1"),
            ("beta", "10-1"),
            ("epoch", "1:1-1"),
        ] {
            cache.file(&format!("{name}-{version}-any.pkg.tar.zst"), 1);
        }
        let sorted = cache_info_at(&cache.0, 0, 10, "", "version", "asc").unwrap();
        assert_eq!(
            sorted
                .groups
                .iter()
                .map(|g| g.name.as_str())
                .collect::<Vec<_>>(),
            ["zeta", "alpha", "beta", "epoch"]
        );
        let size_page = cache_info_at(&cache.0, 1, 2, "", "size", "desc").unwrap();
        assert_eq!(
            size_page
                .groups
                .iter()
                .map(|g| g.name.as_str())
                .collect::<Vec<_>>(),
            ["beta", "epoch"]
        );
    }

    #[test]
    fn two_architectures_of_one_version_are_not_multiple_versions() {
        let cache = CacheDir::new();
        cache.file("linux-1-1-x86_64.pkg.tar.zst", 1);
        cache.file("linux-1-1-aarch64.pkg.tar.zst", 1);
        assert_eq!(
            cache_info_at(&cache.0, 0, 50, "", "name", "asc")
                .unwrap()
                .multi_version_packages,
            0
        );
    }

    #[test]
    fn read_limits_and_sort_fields_are_validated() {
        let cache = CacheDir::new();
        for limit in [0, 1001] {
            assert!(cache_info_at(&cache.0, 0, limit, "", "name", "asc").is_err());
            assert!(cache_files_at(&cache.0, "linux", 0, limit).is_err());
        }
        assert!(cache_info_at(&cache.0, 0, 50, "", "unknown", "asc").is_err());
        assert!(cache_info_at(&cache.0, 0, 50, "", "name", "unknown").is_err());
        assert!(cache_files_at(&cache.0, "../linux", 0, 50).is_err());
    }

    #[test]
    fn cleanup_selection_is_explicit_and_empty_only_is_refused() {
        let names = vec!["linux".to_string()];
        let set = HashSet::from(["linux"]);
        assert!(validate_cache_selection("only", &[]).is_err());
        assert!(validate_cache_selection("all", &names).is_err());
        assert!(validate_cache_selection("bogus", &[]).is_err());
        assert!(validate_cache_selection("except", &["../linux".to_string()]).is_err());
        assert!(selected_for_cleanup("linux", "only", &set));
        assert!(!selected_for_cleanup("glibc", "only", &set));
        assert!(!selected_for_cleanup("linux", "except", &set));
        assert!(selected_for_cleanup("glibc", "except", &set));
        assert!(selected_for_cleanup("linux", "all", &HashSet::new()));
    }
}
