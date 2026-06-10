use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use arch_security_client::SecurityClient;
use arch_security_client::models::{AvgStatus, Severity};

use crate::alpm::get_handle;
use crate::models::{PackageSecurityAdvisory, SecurityInfoResponse, SecurityResponse};
use crate::util::{emit_json, write_json_atomic};

fn security_cache_path() -> Result<PathBuf> {
    let home = std::env::var("HOME").context("HOME environment variable is not set")?;
    Ok(PathBuf::from(home).join(".config/cockpit-pacman/security-cache.json"))
}

fn read_security_cache(path: PathBuf) -> Option<Vec<PackageSecurityAdvisory>> {
    let content = std::fs::read_to_string(&path).ok()?;
    let cached: SecurityResponse = serde_json::from_str(&content).ok()?;
    Some(cached.advisories)
}

fn write_security_cache(path: &Path, response: &SecurityResponse) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    write_json_atomic(path, response)
}

pub fn check_security() -> Result<()> {
    let client = SecurityClient::new(crate::util::detected_ip_family());
    let avgs = match client.fetch_vulnerable() {
        Ok(v) => v,
        Err(e) => {
            // Serve cached advisories (marked stale) if we have them. With no
            // cache, propagate the error: an empty list would be
            // indistinguishable from "no known vulnerabilities", a false
            // sense of safety. The frontend renders this as "unavailable".
            if let Some(advisories) = security_cache_path().ok().and_then(read_security_cache) {
                return emit_json(&SecurityResponse {
                    advisories,
                    stale: true,
                });
            }
            return Err(e);
        }
    };

    let handle = get_handle()?;
    let localdb = handle.localdb();

    let mut pkg_map: HashMap<&str, Vec<&arch_security_client::models::Avg>> = HashMap::new();
    for avg in &avgs {
        for pkg_name in &avg.packages {
            pkg_map.entry(pkg_name.as_str()).or_default().push(avg);
        }
    }

    let mut advisories = Vec::new();

    for pkg in localdb.pkgs() {
        let Some(matching_avgs) = pkg_map.get(pkg.name()) else {
            continue;
        };

        for avg in matching_avgs {
            let is_actionable = matches!(
                avg.status,
                AvgStatus::Vulnerable | AvgStatus::Fixed | AvgStatus::Testing
            );
            if !is_actionable {
                continue;
            }

            // "affected" is the first version known to be vulnerable.
            // The package is affected if installed >= affected.
            let installed_ver = pkg.version().as_str();
            let at_or_above_affected =
                alpm::vercmp(installed_ver, &avg.affected) != std::cmp::Ordering::Less;
            if !at_or_above_affected {
                continue;
            }

            // If a fix exists, the package is only vulnerable if installed < fixed.
            if let Some(ref fixed) = avg.fixed
                && alpm::vercmp(installed_ver, fixed) != std::cmp::Ordering::Less
            {
                continue;
            }

            advisories.push(PackageSecurityAdvisory {
                package: pkg.name().to_string(),
                severity: avg.severity.as_str().to_string(),
                advisory_type: avg.advisory_type.clone(),
                avg_name: avg.name.clone(),
                cve_ids: avg.issues.clone(),
                fixed_version: avg.fixed.clone(),
                status: avg.status.as_str().to_string(),
            });
        }
    }

    advisories.sort_by(|a, b| {
        let sev_a = parse_severity(&a.severity);
        let sev_b = parse_severity(&b.severity);
        sev_b.cmp(&sev_a).then(a.package.cmp(&b.package))
    });

    let response = SecurityResponse {
        advisories,
        stale: false,
    };
    if let Ok(path) = security_cache_path() {
        let _ = write_security_cache(&path, &response);
    }
    emit_json(&response)
}

pub fn security_info(name: &str) -> Result<()> {
    let client = SecurityClient::new(crate::util::detected_ip_family());
    let info = client.fetch_package(name)?;

    let advisories: Vec<_> = info
        .advisories
        .into_iter()
        .map(|a| crate::models::SecurityInfoAdvisory {
            name: a.name,
            date: a.date,
            severity: a.severity.as_str().to_string(),
            advisory_type: a.advisory_type,
        })
        .collect();

    let groups: Vec<_> = info
        .groups
        .into_iter()
        .map(|g| crate::models::SecurityInfoGroup {
            name: g.name,
            status: g.status.as_str().to_string(),
            severity: g.severity.as_str().to_string(),
        })
        .collect();

    let issues: Vec<_> = info
        .issues
        .into_iter()
        .map(|i| crate::models::SecurityInfoIssue {
            name: i.name,
            severity: i.severity.as_str().to_string(),
            issue_type: i.issue_type,
            status: i.status.as_str().to_string(),
        })
        .collect();

    emit_json(&SecurityInfoResponse {
        name: info.name,
        advisories,
        groups,
        issues,
    })
}

fn parse_severity(s: &str) -> Severity {
    match s {
        "Critical" => Severity::Critical,
        "High" => Severity::High,
        "Medium" => Severity::Medium,
        "Low" => Severity::Low,
        _ => Severity::Unknown,
    }
}
