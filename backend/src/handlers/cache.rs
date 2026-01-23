use anyhow::{Context, Result};
use std::path::Path;
use std::process::Command;

use crate::models::{CacheInfo, CachePackage, StreamEvent};
use crate::util::{emit_event, emit_json, get_cache_dir, iter_cache_packages};

pub fn get_cache_info() -> Result<()> {
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

    for (entry, filename, name, version) in iter_cache_packages(cache_path) {
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

pub fn clean_cache(keep_versions: u32) -> Result<()> {
    emit_event(&StreamEvent::Event {
        event: "Starting cache cleanup".to_string(),
        package: None,
    });

    let keep_arg = format!("-k{}", keep_versions);
    let output = Command::new("paccache")
        .args(["-r", &keep_arg, "-v"])
        .output()
        .context("Failed to run paccache")?;

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
            message: Some("Cache cleanup completed".to_string()),
        });
    } else {
        emit_event(&StreamEvent::Complete {
            success: false,
            message: Some(format!(
                "paccache failed with exit code {}",
                output.status.code().unwrap_or(-1)
            )),
        });
    }

    Ok(())
}
