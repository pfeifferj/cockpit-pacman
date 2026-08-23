use anyhow::{Context, Result};
use std::fs;
use std::process::Command;

use crate::alpm::get_handle;
use crate::models::RebootStatus;
use crate::util::emit_json;

pub(crate) const CRITICAL_PACKAGES: &[&str] =
    &["systemd", "linux-firmware", "amd-ucode", "intel-ucode"];

fn get_running_kernel() -> Result<String> {
    let output = Command::new("uname")
        .arg("-r")
        .output()
        .context("Failed to run uname -r")?;

    if !output.status.success() {
        anyhow::bail!("uname -r failed");
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn get_boot_time() -> Result<i64> {
    let stat = fs::read_to_string("/proc/stat").context("Failed to read /proc/stat")?;

    for line in stat.lines() {
        if line.starts_with("btime ") {
            let btime_str = line.strip_prefix("btime ").unwrap_or("0");
            return btime_str
                .trim()
                .parse::<i64>()
                .context("Failed to parse btime");
        }
    }

    anyhow::bail!("btime not found in /proc/stat")
}

fn normalize_uname_to_alpm(uname_version: &str, kernel_type: &str) -> String {
    match kernel_type {
        "linux-lts" => {
            // uname: 6.12.61-1-lts -> alpm: 6.12.61-1
            uname_version
                .strip_suffix("-lts")
                .unwrap_or(uname_version)
                .to_string()
        }
        "linux-zen" => {
            // uname: 6.17.9-zen1-1-zen -> alpm: 6.17.9.zen1-1
            let stripped = uname_version.strip_suffix("-zen").unwrap_or(uname_version);
            replace_leading_dashes(stripped, 1)
        }
        "linux-hardened" => {
            // uname: 6.17.11-hardened1-1-hardened -> alpm: 6.17.11.hardened1-1
            let stripped = uname_version
                .strip_suffix("-hardened")
                .unwrap_or(uname_version);
            replace_leading_dashes(stripped, 1)
        }
        "linux-rt" => {
            let stripped = uname_version.strip_suffix("-rt").unwrap_or(uname_version);
            replace_leading_dashes(stripped, 2)
        }
        "linux-rt-lts" => {
            let stripped = uname_version
                .strip_suffix("-rt-lts")
                .unwrap_or(uname_version);
            replace_leading_dashes(stripped, 2)
        }
        _ => {
            // linux: uname: 6.17.9-arch1-1 -> alpm: 6.17.9.arch1-1
            replace_leading_dashes(uname_version, 1)
        }
    }
}

fn replace_leading_dashes(s: &str, count: usize) -> String {
    let mut result = String::with_capacity(s.len());
    let mut replaced = 0;
    for c in s.chars() {
        if c == '-' && replaced < count {
            result.push('.');
            replaced += 1;
        } else {
            result.push(c);
        }
    }
    result
}

fn detect_kernel_package(running_kernel: &str) -> Option<&'static str> {
    if running_kernel.ends_with("-rt-lts") {
        Some("linux-rt-lts")
    } else if running_kernel.ends_with("-rt") {
        Some("linux-rt")
    } else if running_kernel.ends_with("-lts") {
        Some("linux-lts")
    } else if running_kernel.ends_with("-zen") {
        Some("linux-zen")
    } else if running_kernel.ends_with("-hardened") {
        Some("linux-hardened")
    } else if running_kernel.contains("-arch") {
        Some("linux")
    } else {
        None
    }
}

pub fn get_reboot_status() -> Result<()> {
    let running_kernel = get_running_kernel()?;
    let boot_time = get_boot_time()?;

    let handle = get_handle()?;
    let localdb = handle.localdb();

    let mut status = RebootStatus {
        requires_reboot: false,
        reason: "none".to_string(),
        running_kernel: Some(running_kernel.clone()),
        installed_kernel: None,
        kernel_package: None,
        updated_packages: vec![],
    };

    if let Some(kernel_pkg_name) = detect_kernel_package(&running_kernel)
        && let Ok(pkg) = localdb.pkg(kernel_pkg_name)
    {
        let installed_version = pkg.version().to_string();
        let normalized_running = normalize_uname_to_alpm(&running_kernel, kernel_pkg_name);
        status.installed_kernel = Some(installed_version.clone());
        status.kernel_package = Some(kernel_pkg_name.to_string());

        if installed_version != normalized_running {
            status.requires_reboot = true;
            status.reason = "kernel_update".to_string();
        }
    }

    if !status.requires_reboot {
        for pkg_name in CRITICAL_PACKAGES {
            if let Ok(pkg) = localdb.pkg(*pkg_name)
                && let Some(install_date) = pkg.install_date()
                && install_date > boot_time
            {
                status.updated_packages.push(pkg_name.to_string());
            }
        }

        if !status.updated_packages.is_empty() {
            status.requires_reboot = true;
            status.reason = "critical_packages".to_string();
        }
    }

    emit_json(&status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_uname_to_alpm() {
        assert_eq!(
            normalize_uname_to_alpm("6.17.9-arch1-1", "linux"),
            "6.17.9.arch1-1"
        );
        assert_eq!(
            normalize_uname_to_alpm("6.12.61-1-lts", "linux-lts"),
            "6.12.61-1"
        );
        assert_eq!(
            normalize_uname_to_alpm("6.17.9-zen1-1-zen", "linux-zen"),
            "6.17.9.zen1-1"
        );
        assert_eq!(
            normalize_uname_to_alpm("6.17.11-hardened1-1-hardened", "linux-hardened"),
            "6.17.11.hardened1-1"
        );
    }

    #[test]
    fn test_detect_kernel_package() {
        assert_eq!(detect_kernel_package("6.17.9-arch1-1"), Some("linux"));
        assert_eq!(detect_kernel_package("6.12.61-1-lts"), Some("linux-lts"));
        assert_eq!(
            detect_kernel_package("6.17.9-zen1-1-zen"),
            Some("linux-zen")
        );
        assert_eq!(
            detect_kernel_package("6.17.11-hardened1-1-hardened"),
            Some("linux-hardened")
        );
        assert_eq!(detect_kernel_package("5.15.0-generic"), None);
    }

    #[test]
    fn realtime_kernels_are_not_mistaken_for_the_kernel_they_collide_with() {
        assert_eq!(
            detect_kernel_package("7.1.9-rt1-arch1-2-rt"),
            Some("linux-rt")
        );
        assert_eq!(
            detect_kernel_package("6.18.45-rt6-arch1-2-rt-lts"),
            Some("linux-rt-lts")
        );
    }

    #[test]
    fn realtime_releases_normalize_onto_their_package_version() {
        assert_eq!(
            normalize_uname_to_alpm("7.1.9-rt1-arch1-2-rt", "linux-rt"),
            "7.1.9.rt1.arch1-2"
        );
        assert_eq!(
            normalize_uname_to_alpm("6.18.45-rt6-arch1-2-rt-lts", "linux-rt-lts"),
            "6.18.45.rt6.arch1-2"
        );
    }
}
