use alpm::Alpm;
use anyhow::{Context, Result};
use std::cmp::Ordering;
use std::fs;
use std::path::Path;
use std::process::Command;

use crate::alpm::get_handle;
use crate::models::{CachedVersion, DowngradeResponse, StreamEvent};
use crate::util::emit_event;

const CACHE_DIR: &str = "/var/cache/pacman/pkg";

pub fn list_downgrades(package_name: Option<&str>) -> Result<()> {
    let alpm = get_handle()?;
    let cache_path = Path::new(CACHE_DIR);

    if !cache_path.exists() {
        let response = DowngradeResponse {
            packages: vec![],
            total: 0,
        };
        println!("{}", serde_json::to_string(&response)?);
        return Ok(());
    }

    let entries = fs::read_dir(cache_path)
        .with_context(|| format!("Failed to read cache directory: {}", CACHE_DIR))?;

    let mut packages: Vec<CachedVersion> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if path
            .extension()
            .is_some_and(|ext| ext == "zst" || ext == "xz" || ext == "gz")
        {
            let filename = path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();

            if let Some((name, version)) = parse_package_filename(&filename) {
                if let Some(filter_name) = package_name {
                    if name != filter_name {
                        continue;
                    }
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
        }
    }

    packages.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then_with(|| compare_versions(&b.version, &a.version))
    });

    let total = packages.len();
    let response = DowngradeResponse { packages, total };

    println!("{}", serde_json::to_string(&response)?);
    Ok(())
}

pub fn downgrade_package(name: &str, version: &str, timeout: Option<u64>) -> Result<()> {
    let cache_path = Path::new(CACHE_DIR);
    let target_filename = find_package_file(cache_path, name, version)?;

    emit_event(&StreamEvent::Event {
        event: format!("Downgrading {} to version {}", name, version),
        package: Some(name.to_string()),
    });

    let pkg_path = cache_path.join(&target_filename);

    let mut cmd = Command::new("pacman");
    cmd.args(["-U", "--noconfirm"]);
    cmd.arg(&pkg_path);

    let timeout_secs = timeout.unwrap_or(300);
    emit_event(&StreamEvent::Log {
        level: "info".to_string(),
        message: format!(
            "Running: pacman -U --noconfirm {} (timeout: {}s)",
            pkg_path.display(),
            timeout_secs
        ),
    });

    let output = cmd.output().context("Failed to run pacman")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    for line in stdout.lines().chain(stderr.lines()) {
        if !line.trim().is_empty() {
            emit_event(&StreamEvent::Log {
                level: "info".to_string(),
                message: line.to_string(),
            });
        }
    }

    if output.status.success() {
        emit_event(&StreamEvent::Complete {
            success: true,
            message: Some(format!("Successfully downgraded {} to {}", name, version)),
        });
    } else {
        emit_event(&StreamEvent::Complete {
            success: false,
            message: Some(format!(
                "Failed to downgrade {}: exit code {}",
                name,
                output.status.code().unwrap_or(-1)
            )),
        });
    }

    Ok(())
}

fn find_package_file(cache_path: &Path, name: &str, version: &str) -> Result<String> {
    let entries = fs::read_dir(cache_path)
        .with_context(|| format!("Failed to read cache directory: {}", cache_path.display()))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if let Some(filename) = path.file_name().map(|s| s.to_string_lossy().to_string()) {
            if let Some((pkg_name, pkg_version)) = parse_package_filename(&filename) {
                if pkg_name == name && pkg_version == version {
                    return Ok(filename);
                }
            }
        }
    }

    anyhow::bail!("Package file not found in cache: {}-{}", name, version)
}

fn parse_package_filename(filename: &str) -> Option<(String, String)> {
    let name = filename
        .strip_suffix(".pkg.tar.zst")
        .or_else(|| filename.strip_suffix(".pkg.tar.xz"))
        .or_else(|| filename.strip_suffix(".pkg.tar.gz"))?;

    let parts: Vec<&str> = name.rsplitn(3, '-').collect();
    if parts.len() >= 3 {
        let version = format!("{}-{}", parts[1], parts[0]);
        let pkg_name = parts[2..].join("-");
        Some((pkg_name, version))
    } else {
        None
    }
}

fn get_installed_version(alpm: &Alpm, name: &str) -> Option<String> {
    alpm.localdb()
        .pkg(name)
        .ok()
        .map(|p| p.version().to_string())
}

fn is_version_older(cached: &str, installed: &str) -> bool {
    matches!(compare_versions(cached, installed), Ordering::Less)
}

fn compare_versions(a: &str, b: &str) -> Ordering {
    alpm::vercmp(a, b)
}
