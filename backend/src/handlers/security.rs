use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::Result;
use arch_security_client::SecurityClient;
use arch_security_client::models::{Avg, AvgStatus, Severity};
use serde::{Deserialize, Serialize};

use crate::alpm::get_handle;
use crate::models::{PackageSecurityAdvisory, SecurityInfoResponse, SecurityResponse};
use crate::util::{config_path, emit_json, write_json_atomic};

const FEED_TTL_SECS: i64 = 3600;

#[derive(Serialize, Deserialize)]
struct FeedCache {
    fetched_at: i64,
    body: String,
}

fn security_cache_path() -> Result<PathBuf> {
    config_path("security-feed.json")
}

fn read_feed_cache(path: &Path) -> Option<FeedCache> {
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn write_feed_cache(path: &Path, cache: &FeedCache) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        let _ = std::fs::remove_file(parent.join("security-cache.json"));
    }
    write_json_atomic(path, cache)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

fn feed_is_fresh(fetched_at: i64, now: i64) -> bool {
    let age = now - fetched_at;
    (0..FEED_TTL_SECS).contains(&age)
}

fn advisories_enabled() -> bool {
    crate::config::AppConfig::load().map_or(true, |c| c.security_advisories)
}

fn advisory_for(pkg_name: &str, installed: &str, avg: &Avg) -> Option<PackageSecurityAdvisory> {
    if matches!(avg.status, AvgStatus::NotAffected) {
        return None;
    }

    // alpm::vercmp goes through CString and panics on interior NULs, and the
    // versions come from the remote feed.
    if avg.affected.contains('\0') || avg.fixed.as_deref().is_some_and(|f| f.contains('\0')) {
        return None;
    }

    if alpm::vercmp(installed, &avg.affected) == std::cmp::Ordering::Less {
        return None;
    }

    if let Some(ref fixed) = avg.fixed
        && alpm::vercmp(installed, fixed) != std::cmp::Ordering::Less
    {
        return None;
    }

    Some(PackageSecurityAdvisory {
        package: pkg_name.to_string(),
        severity: avg.severity.as_str().to_string(),
        advisory_type: avg.advisory_type.clone(),
        avg_name: avg.name.clone(),
        cve_ids: avg.issues.clone(),
        fixed_version: avg.fixed.clone(),
        affected_version: avg.affected.clone(),
        installed_version: installed.to_string(),
        status: avg.status.as_str().to_string(),
    })
}

fn is_actionable(a: &PackageSecurityAdvisory) -> bool {
    a.fixed_version.is_some()
}

fn sort_advisories(advisories: &mut [PackageSecurityAdvisory]) {
    advisories.sort_by(|a, b| {
        is_actionable(b)
            .cmp(&is_actionable(a))
            .then_with(|| parse_severity(&b.severity).cmp(&parse_severity(&a.severity)))
            .then_with(|| a.package.cmp(&b.package))
    });
}

struct Feed {
    avgs: Vec<Avg>,
    stale: bool,
}

fn load_feed(client: &SecurityClient, force: bool) -> Result<Feed> {
    let path = security_cache_path().ok();
    let mut cached = if force {
        None
    } else {
        path.as_deref().and_then(read_feed_cache)
    };

    if let Some(ref c) = cached
        && feed_is_fresh(c.fetched_at, now_secs())
        && let Ok(avgs) = arch_security_client::parse_vulnerable(&c.body)
    {
        return Ok(Feed { avgs, stale: false });
    }

    let stale_fallback = |cached: Option<FeedCache>| {
        cached
            .or_else(|| path.as_deref().and_then(read_feed_cache))
            .and_then(|c| arch_security_client::parse_vulnerable(&c.body).ok())
            .map(|avgs| Feed { avgs, stale: true })
    };

    match client.fetch_vulnerable_raw() {
        Ok(body) => match arch_security_client::parse_vulnerable(&body) {
            Ok(avgs) => {
                if let Some(ref p) = path {
                    let _ = write_feed_cache(
                        p,
                        &FeedCache {
                            fetched_at: now_secs(),
                            body,
                        },
                    );
                }
                Ok(Feed { avgs, stale: false })
            }
            Err(e) => stale_fallback(cached.take()).ok_or(e),
        },
        Err(e) => stale_fallback(cached.take()).ok_or(e),
    }
}

pub fn check_security(force: bool) -> Result<()> {
    if !advisories_enabled() {
        return emit_json(&SecurityResponse {
            advisories: Vec::new(),
            stale: false,
            disabled: true,
        });
    }

    let client = SecurityClient::new(crate::util::detected_ip_family());
    let feed = load_feed(&client, force)?;
    let avgs = feed.avgs;

    let handle = get_handle()?;
    let localdb = handle.localdb();

    let mut pkg_map: HashMap<&str, Vec<&Avg>> = HashMap::new();
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
            if let Some(advisory) = advisory_for(pkg.name(), pkg.version().as_str(), avg) {
                advisories.push(advisory);
            }
        }
    }

    sort_advisories(&mut advisories);

    emit_json(&SecurityResponse {
        advisories,
        stale: feed.stale,
        disabled: false,
    })
}

pub fn security_info(name: &str) -> Result<()> {
    if !advisories_enabled() {
        return emit_json(&SecurityInfoResponse {
            name: name.to_string(),
            advisories: Vec::new(),
            groups: Vec::new(),
            issues: Vec::new(),
            disabled: true,
        });
    }

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
        disabled: false,
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

#[cfg(test)]
mod tests {
    use super::{advisory_for, feed_is_fresh, is_actionable, sort_advisories};
    use arch_security_client::models::{Avg, AvgStatus, Severity};

    fn avg(status: AvgStatus, affected: &str, fixed: Option<&str>) -> Avg {
        Avg {
            name: "AVG-1879".to_string(),
            packages: vec!["linux".to_string()],
            status,
            severity: Severity::High,
            advisory_type: "arbitrary code execution".to_string(),
            affected: affected.to_string(),
            fixed: fixed.map(str::to_string),
            issues: vec!["CVE-2021-43976".to_string()],
            advisories: vec![],
        }
    }

    #[test]
    fn a_version_below_the_first_affected_one_is_not_reported() {
        let a = avg(AvgStatus::Vulnerable, "5.15.8.arch1-1", None);
        assert!(advisory_for("linux", "5.15.7.arch1-1", &a).is_none());
    }

    #[test]
    fn the_first_affected_version_itself_is_reported() {
        let a = avg(AvgStatus::Vulnerable, "5.15.8.arch1-1", None);
        assert!(advisory_for("linux", "5.15.8.arch1-1", &a).is_some());
    }

    #[test]
    fn an_advisory_with_no_recorded_fix_keeps_matching_far_newer_versions() {
        let a = avg(AvgStatus::Vulnerable, "5.15.8.arch1-1", None);
        let got = advisory_for("linux", "7.1.8.arch1-3", &a).expect("still reported");

        assert!(!is_actionable(&got), "nothing to update to");
        assert_eq!(got.affected_version, "5.15.8.arch1-1");
        assert_eq!(got.installed_version, "7.1.8.arch1-3");
    }

    #[test]
    fn a_version_short_of_the_fix_is_reported_as_actionable() {
        let a = avg(AvgStatus::Vulnerable, "9.0.1224-1", Some("9.0.1225-1"));
        let got = advisory_for("vim", "9.0.1224-1", &a).expect("reported");

        assert!(is_actionable(&got));
        assert_eq!(got.fixed_version.as_deref(), Some("9.0.1225-1"));
    }

    #[test]
    fn reaching_the_fix_clears_the_advisory() {
        let a = avg(AvgStatus::Vulnerable, "9.0.1224-1", Some("9.0.1225-1"));
        assert!(advisory_for("vim", "9.0.1225-1", &a).is_none());
        assert!(advisory_for("vim", "9.2.0849-1", &a).is_none());
    }

    #[test]
    fn a_package_the_tracker_says_is_unaffected_is_not_reported() {
        let a = avg(AvgStatus::NotAffected, "5.15.8.arch1-1", None);
        assert!(advisory_for("linux", "7.1.8.arch1-3", &a).is_none());
    }

    #[test]
    fn a_feed_inside_its_window_is_reused_and_an_older_one_is_not() {
        let now = 1_800_000_000;
        assert!(feed_is_fresh(now, now));
        assert!(feed_is_fresh(now - (super::FEED_TTL_SECS - 1), now));
        assert!(!feed_is_fresh(now - super::FEED_TTL_SECS, now));
        assert!(!feed_is_fresh(now - 86_400, now));
    }

    #[test]
    fn a_feed_stamped_in_the_future_is_not_reused() {
        let now = 1_800_000_000;
        assert!(!feed_is_fresh(now + 60, now));
    }

    #[test]
    fn an_untriaged_group_with_a_fix_is_still_reported() {
        let a = Avg {
            severity: Severity::Unknown,
            advisory_type: "unknown".to_string(),
            ..avg(AvgStatus::Unknown, "9.0.1224-1", Some("9.0.1225-1"))
        };
        let got = advisory_for("vim", "9.0.1224-1", &a).expect("reported");

        assert!(is_actionable(&got));
        assert_eq!(got.fixed_version.as_deref(), Some("9.0.1225-1"));
        assert_eq!(got.severity, "Unknown");
    }

    #[test]
    fn an_epoch_outranks_a_higher_looking_version() {
        let a = avg(AvgStatus::Vulnerable, "1:1.0-1", None);
        assert!(
            advisory_for("pkg", "2.0-1", &a).is_none(),
            "2.0-1 < 1:1.0-1"
        );
        assert!(advisory_for("pkg", "1:1.0-1", &a).is_some());
    }

    #[test]
    fn a_version_with_an_interior_nul_is_dropped_not_a_panic() {
        let a = avg(AvgStatus::Vulnerable, "5.0-1\0", None);
        assert!(advisory_for("bash", "5.2-1", &a).is_none());

        let a = avg(AvgStatus::Vulnerable, "5.0-1", Some("5.1\0-1"));
        assert!(advisory_for("bash", "5.2-1", &a).is_none());
    }

    #[test]
    fn a_pkgrel_bump_is_enough_to_be_affected() {
        let a = avg(AvgStatus::Vulnerable, "1.0-1", Some("1.0-3"));
        assert!(advisory_for("pkg", "1.0-2", &a).is_some());
        assert!(advisory_for("pkg", "1.0-3", &a).is_none());
    }

    #[test]
    fn what_an_update_can_fix_sorts_above_what_it_cannot() {
        let low_fixable = advisory_for(
            "vim",
            "9.0.1224-1",
            &Avg {
                severity: Severity::Low,
                ..avg(AvgStatus::Vulnerable, "9.0.1224-1", Some("9.0.1225-1"))
            },
        )
        .expect("reported");
        let high_stuck = advisory_for(
            "linux",
            "7.1.8.arch1-3",
            &avg(AvgStatus::Vulnerable, "5.15.8.arch1-1", None),
        )
        .expect("reported");

        let mut list = vec![high_stuck, low_fixable];
        sort_advisories(&mut list);

        assert_eq!(
            list[0].package, "vim",
            "a Low one an update fixes outranks a High one it cannot"
        );
        assert_eq!(list[1].package, "linux");
    }
}
