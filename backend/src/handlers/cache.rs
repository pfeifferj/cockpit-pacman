use anyhow::Result;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use crate::alpm::get_handle;
use crate::models::{CacheInfo, CachePackage, StreamEvent};
use crate::util::{emit_event, emit_json, get_cache_dir, load_cache_packages};

pub fn get_cache_info() -> Result<()> {
    let handle = get_handle()?;
    let cache_dir = get_cache_dir();
    let cache_path = Path::new(&cache_dir);

    if !cache_path.exists() {
        let info = CacheInfo {
            total_size: 0,
            package_count: 0,
            packages: vec![],
            path: cache_dir,
        };
        return emit_json(&info);
    }

    let mut packages: Vec<CachePackage> = Vec::new();
    let mut total_size: i64 = 0;

    for (entry, filename, name, version) in load_cache_packages(&handle, cache_path) {
        if let Ok(metadata) = entry.metadata() {
            let size = metadata.len() as i64;
            total_size += size;
            packages.push(CachePackage {
                name,
                version,
                filename,
                size,
            });
        }
    }

    packages.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then_with(|| alpm::vercmp(b.version.as_str(), a.version.as_str()))
    });

    let info = CacheInfo {
        total_size,
        package_count: packages.len(),
        packages,
        path: cache_dir,
    };

    emit_json(&info)
}

pub fn clean_cache(keep_versions: u32, filter_pkgs: &[String]) -> Result<()> {
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
            message: Some("Cache directory does not exist".to_string()),
        });
        return Ok(());
    }

    let filter: HashSet<&str> = filter_pkgs.iter().map(|s| s.as_str()).collect();

    let mut groups: HashMap<String, Vec<(fs::DirEntry, String, String)>> = HashMap::new();
    for (entry, filename, name, version) in load_cache_packages(&handle, cache_path) {
        if !filter.is_empty() && !filter.contains(name.as_str()) {
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
        versions.sort_by(|a, b| alpm::vercmp(b.2.as_str(), a.2.as_str()));

        for (entry, filename, _) in versions.iter().skip(keep) {
            let path = entry.path();
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
