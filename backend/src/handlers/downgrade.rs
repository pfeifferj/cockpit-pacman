use alpm::{Alpm, SigLevel, TransFlag};
use anyhow::{Context, Result};
use std::cmp::Ordering;
use std::fs;
use std::path::Path;

use crate::alpm::{TransactionGuard, get_handle};
use crate::check_cancel_early;
use crate::handlers::mutation::{
    EventScope, MutationOpts, add_pkg_failure, begin_mutation, commit_and_complete, fail_complete,
    prepare_failure,
};
use crate::inhibit::ShutdownInhibitor;
use crate::models::{CachedVersion, DowngradeResponse, StreamEvent};
use crate::util::{
    emit_event, emit_json, get_cache_dir, list_cache_packages, parse_package_filename,
};

use crate::validation::{validate_package_name, validate_version};

pub fn list_downgrades(package_name: Option<&str>) -> Result<()> {
    let alpm = get_handle()?;
    let cache_dir = get_cache_dir();
    let cache_path = Path::new(&cache_dir);

    if !cache_path.exists() {
        let response = DowngradeResponse {
            packages: vec![],
            total: 0,
        };
        return emit_json(&response);
    }

    let mut packages: Vec<CachedVersion> = Vec::new();

    for (entry, filename, name, version) in list_cache_packages(cache_path) {
        if let Some(filter_name) = package_name
            && name != filter_name
        {
            continue;
        }

        let installed_version = get_installed_version(&alpm, &name);
        let is_older = installed_version
            .as_ref()
            .map(|iv| is_version_older(&version, iv))
            .unwrap_or(false);

        if let Ok(metadata) = entry.metadata() {
            packages.push(CachedVersion {
                name,
                version,
                filename,
                size: metadata.len() as i64,
                installed_version,
                is_older,
            });
        }
    }

    packages.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then_with(|| compare_versions(&b.version, &a.version))
    });

    let total = packages.len();
    let response = DowngradeResponse { packages, total };

    emit_json(&response)
}

pub fn downgrade_package(name: &str, version: &str, timeout: Option<u64>) -> Result<()> {
    validate_package_name(name)?;
    validate_version(version)?;

    let cache_dir = get_cache_dir();
    let cache_path = Path::new(&cache_dir);
    let target_filename = find_package_file(cache_path, name, version)?;
    let pkg_path = cache_path.join(&target_filename);

    install_downgrade(
        DowngradeSource::Cached(pkg_path.to_string_lossy().into_owned()),
        name,
        version,
        timeout,
    )
}

pub(crate) enum DowngradeSource {
    Cached(String),
    Url(String),
}

fn file_siglevel(level: SigLevel, default: SigLevel) -> SigLevel {
    if level.is_empty() { default } else { level }
}

pub(crate) fn install_downgrade(
    source: DowngradeSource,
    name: &str,
    version: &str,
    timeout_secs: Option<u64>,
) -> Result<()> {
    let (mut handle, timeout) = begin_mutation(
        EventScope::Upgrade,
        MutationOpts {
            questions: Some(false),
        },
        timeout_secs,
    )?;

    check_cancel_early!(&timeout);

    emit_event(&StreamEvent::Event {
        event: format!("Downgrading {} to version {}", name, version),
        package: Some(name.to_string()),
    });

    let (path, siglevel) = match source {
        DowngradeSource::Cached(path) => (
            path,
            file_siglevel(handle.local_file_siglevel(), handle.default_siglevel()),
        ),
        DowngradeSource::Url(url) => {
            let siglevel = file_siglevel(handle.remote_file_siglevel(), handle.default_siglevel());
            handle.set_remote_file_siglevel(siglevel)?;
            let fetched = handle
                .fetch_pkgurl([url.as_str()].into_iter())
                .map_err(|e| {
                    fail_complete(format!("Failed to download {} {}: {}", name, version, e))
                })?;
            let Some(path) = fetched.first().map(|p| p.to_string()) else {
                return Err(fail_complete(format!(
                    "Download of {} {} produced no file",
                    name, version
                )));
            };
            (path, siglevel)
        }
    };

    check_cancel_early!(&timeout);

    let _inhibitor = ShutdownInhibitor::take("Downgrading package");

    let mut tx = TransactionGuard::new(&mut handle, TransFlag::NONE)?;

    let pkg = match tx.load_pkg(&path, siglevel) {
        Ok(pkg) => pkg,
        Err(e) => return Err(fail_complete(format!("Failed to load {}: {}", path, e))),
    };

    if let Err(e) = tx.add_pkg(pkg) {
        return Err(add_pkg_failure(name, e));
    }

    check_cancel_early!(&timeout);

    if let Some(err_msg) = tx.prepare().err() {
        return Err(prepare_failure(&err_msg));
    }

    commit_and_complete(
        &mut tx,
        "Operation interrupted - package may be in inconsistent state",
        Some(format!("Successfully downgraded {} to {}", name, version)),
    )
}

fn find_package_file(cache_path: &Path, name: &str, version: &str) -> Result<String> {
    let entries = fs::read_dir(cache_path)
        .with_context(|| format!("Failed to read cache directory: {}", cache_path.display()))?;

    for entry_result in entries {
        let entry = match entry_result {
            Ok(e) => e,
            Err(e) => {
                eprintln!("Warning: Failed to read directory entry: {}", e);
                continue;
            }
        };
        let path = entry.path();
        if let Some(filename) = path.file_name().map(|s| s.to_string_lossy().to_string())
            && let Some((pkg_name, pkg_version, _)) = parse_package_filename(&filename)
            && pkg_name == name
            && pkg_version == version
        {
            return Ok(filename);
        }
    }

    anyhow::bail!("Package file not found in cache: {}-{}", name, version)
}

pub(crate) fn get_installed_version(alpm: &Alpm, name: &str) -> Option<String> {
    alpm.localdb()
        .pkg(name)
        .ok()
        .map(|p| p.version().to_string())
}

pub(crate) fn is_version_older(cached: &str, installed: &str) -> bool {
    matches!(compare_versions(cached, installed), Ordering::Less)
}

pub(crate) fn compare_versions(a: &str, b: &str) -> Ordering {
    alpm::vercmp(a, b)
}

#[cfg(test)]
mod siglevel_tests {
    use super::file_siglevel;
    use alpm::SigLevel;

    #[test]
    fn an_unset_file_level_falls_back_to_the_default() {
        let default = SigLevel::PACKAGE | SigLevel::PACKAGE_OPTIONAL;
        assert_eq!(file_siglevel(SigLevel::NONE, default), default);
    }

    #[test]
    fn a_configured_file_level_is_used_as_is() {
        let configured = SigLevel::PACKAGE;
        let default = SigLevel::PACKAGE | SigLevel::PACKAGE_OPTIONAL;
        assert_eq!(file_siglevel(configured, default), configured);
    }
}
