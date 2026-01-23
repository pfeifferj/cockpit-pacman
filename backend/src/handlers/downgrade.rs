use alpm::Alpm;
use anyhow::{Context, Result};
use std::cmp::Ordering;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Instant;

use crate::alpm::get_handle;
use crate::models::{CachedVersion, DowngradeResponse, StreamEvent};
use crate::util::{
    DEFAULT_MUTATION_TIMEOUT_SECS, emit_event, emit_json, get_cache_dir, is_cancelled,
    iter_cache_packages, parse_package_filename, setup_signal_handler,
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

    for (entry, filename, name, version) in iter_cache_packages(cache_path) {
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
    setup_signal_handler();
    validate_package_name(name)?;
    validate_version(version)?;

    let cache_dir = get_cache_dir();
    let cache_path = Path::new(&cache_dir);
    let target_filename = find_package_file(cache_path, name, version)?;

    emit_event(&StreamEvent::Event {
        event: format!("Downgrading {} to version {}", name, version),
        package: Some(name.to_string()),
    });

    let pkg_path = cache_path.join(&target_filename);
    let timeout_secs = timeout.unwrap_or(DEFAULT_MUTATION_TIMEOUT_SECS);
    let timeout_duration = std::time::Duration::from_secs(timeout_secs);
    let start_time = Instant::now();

    emit_event(&StreamEvent::Log {
        level: "info".to_string(),
        message: format!(
            "Running: pacman -U --noconfirm {} (timeout: {}s)",
            pkg_path.display(),
            timeout_secs
        ),
    });

    let mut child = Command::new("pacman")
        .args(["-U", "--noconfirm"])
        .arg(&pkg_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("Failed to spawn pacman")?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let stdout_handle = std::thread::spawn(move || {
        if let Some(stdout) = stdout {
            let reader = BufReader::new(stdout);
            for line_result in reader.lines() {
                let line = match line_result {
                    Ok(l) => l,
                    Err(e) => {
                        eprintln!("Warning: Failed to read stdout line: {}", e);
                        continue;
                    }
                };
                if !line.trim().is_empty() {
                    emit_event(&StreamEvent::Log {
                        level: "info".to_string(),
                        message: line,
                    });
                }
            }
        }
    });

    let stderr_handle = std::thread::spawn(move || {
        if let Some(stderr) = stderr {
            let reader = BufReader::new(stderr);
            for line_result in reader.lines() {
                let line = match line_result {
                    Ok(l) => l,
                    Err(e) => {
                        eprintln!("Warning: Failed to read stderr line: {}", e);
                        continue;
                    }
                };
                if !line.trim().is_empty() {
                    emit_event(&StreamEvent::Log {
                        level: "warning".to_string(),
                        message: line,
                    });
                }
            }
        }
    });

    loop {
        if is_cancelled() {
            let _ = child.kill();
            emit_event(&StreamEvent::Complete {
                success: false,
                message: Some("Operation cancelled by user".to_string()),
            });
            return Ok(());
        }

        if start_time.elapsed() > timeout_duration {
            let _ = child.kill();
            emit_event(&StreamEvent::Complete {
                success: false,
                message: Some(format!(
                    "Operation timed out after {} seconds",
                    timeout_secs
                )),
            });
            return Ok(());
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                if let Err(e) = stdout_handle.join() {
                    eprintln!("Warning: stdout reader thread panicked: {:?}", e);
                }
                if let Err(e) = stderr_handle.join() {
                    eprintln!("Warning: stderr reader thread panicked: {:?}", e);
                }

                if status.success() {
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
                            status.code().unwrap_or(-1)
                        )),
                    });
                }
                return Ok(());
            }
            Ok(None) => {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => {
                emit_event(&StreamEvent::Complete {
                    success: false,
                    message: Some(format!("Failed to check process status: {}", e)),
                });
                return Err(e.into());
            }
        }
    }
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
            && let Some((pkg_name, pkg_version)) = parse_package_filename(&filename)
            && pkg_name == name
            && pkg_version == version
        {
            return Ok(filename);
        }
    }

    anyhow::bail!("Package file not found in cache: {}-{}", name, version)
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
