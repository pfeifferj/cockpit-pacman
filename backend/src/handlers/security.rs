use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::Result;
use arch_security_client::SecurityClient;
use arch_security_client::models::{Avg, AvgStatus, Severity};
use serde::{Deserialize, Serialize};

use crate::alpm::{find_upgrade_candidate, get_handle};
use crate::models::{PackageSecurityAdvisory, SecurityInfoResponse, SecurityResponse};
use crate::util::{config_path, emit_json, write_json_atomic};

const FEED_TTL_SECS: i64 = 3600;

#[derive(Serialize, Deserialize)]
struct FeedCache {
    fetched_at: i64,
    body: String,
}

fn security_cache_path() -> Result<PathBuf> {
    config_path("security-issues.json")
}

fn read_feed_cache(path: &Path) -> Option<FeedCache> {
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn write_feed_cache(path: &Path, cache: &FeedCache) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        for old in ["security-cache.json", "security-feed.json"] {
            let _ = std::fs::remove_file(parent.join(old));
        }
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

fn advisories_enabled() -> Result<bool> {
    Ok(crate::config::AppConfig::load()?.security_advisories)
}

fn advisory_for<'a>(
    pkg_name: &str,
    installed: &str,
    avg: &Avg,
    available: impl FnOnce() -> Option<&'a str>,
) -> Option<PackageSecurityAdvisory> {
    if matches!(avg.status, AvgStatus::NotAffected) {
        return None;
    }

    // alpm::vercmp panics on interior NULs. A malformed tracker version keeps
    // the advisory listed rather than hiding it.
    let valid = |version: &str| {
        !version.is_empty() && !version.chars().any(|c| c.is_control() || c.is_whitespace())
    };
    let fixed = avg.fixed.as_deref().filter(|fixed| valid(fixed));

    if valid(&avg.affected) && alpm::vercmp(installed, &avg.affected) == std::cmp::Ordering::Less {
        return None;
    }

    if let Some(fixed) = fixed
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
        fixed_version: fixed.map(str::to_string),
        fix_available: fixed.is_some_and(|fixed| {
            available()
                .is_some_and(|candidate| alpm::vercmp(candidate, fixed) != std::cmp::Ordering::Less)
        }),
        affected_version: avg.affected.clone(),
        installed_version: installed.to_string(),
        status: avg.status.as_str().to_string(),
    })
}

fn is_actionable(a: &PackageSecurityAdvisory) -> bool {
    a.fix_available
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

fn load_feed(client: &SecurityClient, force: bool, path: Option<&Path>) -> Result<Feed> {
    let mut cached = if force {
        None
    } else {
        path.and_then(read_feed_cache)
    };

    if let Some(ref c) = cached
        && feed_is_fresh(c.fetched_at, now_secs())
        && let Ok(avgs) = arch_security_client::parse_issues(&c.body)
    {
        return Ok(Feed { avgs, stale: false });
    }

    let stale_fallback = |cached: Option<FeedCache>| {
        cached
            .or_else(|| path.and_then(read_feed_cache))
            .and_then(|c| arch_security_client::parse_issues(&c.body).ok())
            .map(|avgs| Feed { avgs, stale: true })
    };

    let fetched = crate::network::require_network()
        .map_err(anyhow::Error::from)
        .and_then(|_| client.fetch_issues_raw());
    match fetched {
        Ok(body) => match arch_security_client::parse_issues(&body) {
            Ok(avgs) => {
                if let Some(p) = path {
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
    if !advisories_enabled()? {
        return emit_json(&SecurityResponse {
            advisories: Vec::new(),
            stale: false,
            disabled: true,
        });
    }

    let url = crate::endpoints::endpoint(
        arch_security_client::DEFAULT_BASE_URL,
        "COCKPIT_PACMAN_TEST_SECURITY_URL",
    )?;
    let client = SecurityClient::with_base_url(&url);
    let feed = load_feed(&client, force, security_cache_path().ok().as_deref())?;
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

        // The first candidate lookup loads the sync databases.
        let available = || {
            find_upgrade_candidate(&handle, pkg.name())
                .map(|candidate| candidate.version().as_str())
        };
        for avg in matching_avgs {
            if let Some(advisory) = advisory_for(pkg.name(), pkg.version().as_str(), avg, available)
            {
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
    if !advisories_enabled()? {
        return emit_json(&SecurityInfoResponse {
            name: name.to_string(),
            advisories: Vec::new(),
            groups: Vec::new(),
            issues: Vec::new(),
            disabled: true,
        });
    }

    let url = crate::endpoints::endpoint(
        arch_security_client::DEFAULT_BASE_URL,
        "COCKPIT_PACMAN_TEST_SECURITY_URL",
    )?;
    let client = SecurityClient::with_base_url(&url);
    crate::network::require_network()?;
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
    fn versions_before_the_first_affected_one_are_not_reported() {
        let a = avg(AvgStatus::Vulnerable, "5.15.8.arch1-1", None);
        assert!(advisory_for("linux", "5.15.7.arch1-1", &a, || unreachable!()).is_none());
        assert!(advisory_for("linux", "5.15.8.arch1-1", &a, || unreachable!()).is_some());
    }

    #[test]
    fn no_recorded_fix_keeps_matching_newer_versions_without_becoming_available() {
        let a = avg(AvgStatus::Vulnerable, "5.15.8.arch1-1", None);
        let got =
            advisory_for("linux", "7.1.8.arch1-3", &a, || unreachable!()).expect("still reported");

        assert!(!is_actionable(&got));
        assert_eq!(got.affected_version, "5.15.8.arch1-1");
        assert_eq!(got.installed_version, "7.1.8.arch1-3");
    }

    #[test]
    fn a_recorded_fix_needs_an_available_candidate_that_reaches_it() {
        let a = avg(AvgStatus::Vulnerable, "9.0.1224-1", Some("9.0.1225-1"));
        for (candidate, available) in [
            (None, false),
            (Some("9.0.1224-1"), false),
            (Some("9.0.1224-2"), false),
            (Some("9.0.1225-1"), true),
            (Some("9.2.0849-1"), true),
        ] {
            let got = advisory_for("vim", "9.0.1224-1", &a, || candidate).expect("reported");
            assert_eq!(got.fix_available, available, "candidate: {candidate:?}");
            assert_eq!(got.fixed_version.as_deref(), Some("9.0.1225-1"));
        }
    }

    #[test]
    fn reaching_the_fix_clears_the_advisory() {
        let a = avg(AvgStatus::Vulnerable, "9.0.1224-1", Some("9.0.1225-1"));
        assert!(advisory_for("vim", "9.0.1225-1", &a, || unreachable!()).is_none());
        assert!(advisory_for("vim", "9.2.0849-1", &a, || unreachable!()).is_none());
    }

    #[test]
    fn a_closed_group_still_covers_an_installed_unfixed_version() {
        let a: Avg = serde_json::from_str(
            r#"{"name":"AVG-1","packages":["bash"],"status":"Fixed",
                "severity":"High","type":"code execution","affected":"5.0-1",
                "fixed":"5.1-1","issues":["CVE-2024-1"],"advisories":[]}"#,
        )
        .unwrap();

        for (installed, candidate, expected) in [
            ("4.9-1", Some("5.1-1"), None),
            ("5.0-1", None, Some(false)),
            ("5.0-1", Some("5.0-2"), Some(false)),
            ("5.0-1", Some("5.1-1"), Some(true)),
            ("5.1-1", Some("5.2-1"), None),
        ] {
            let advisory = advisory_for("bash", installed, &a, || candidate);
            assert_eq!(
                advisory.as_ref().map(|advisory| advisory.fix_available),
                expected,
                "installed: {installed}, candidate: {candidate:?}"
            );
            if let Some(advisory) = advisory {
                assert_eq!(advisory.status, "Fixed");
            }
        }
    }

    #[test]
    fn an_unaffected_package_is_not_reported() {
        let a = avg(AvgStatus::NotAffected, "5.15.8.arch1-1", None);
        assert!(advisory_for("linux", "7.1.8.arch1-3", &a, || unreachable!()).is_none());
    }

    #[test]
    fn a_feed_inside_its_window_is_reused_and_an_older_one_is_not() {
        let now = 1_800_000_000;
        assert!(feed_is_fresh(now, now));
        assert!(feed_is_fresh(now - (super::FEED_TTL_SECS - 1), now));
        assert!(!feed_is_fresh(now - super::FEED_TTL_SECS, now));
        assert!(!feed_is_fresh(now - 86_400, now));
        assert!(!feed_is_fresh(now + 60, now));
    }

    #[test]
    fn an_untriaged_group_with_an_available_fix_is_still_reported() {
        let a = Avg {
            severity: Severity::Unknown,
            advisory_type: "unknown".to_string(),
            ..avg(AvgStatus::Unknown, "9.0.1224-1", Some("9.0.1225-1"))
        };
        let got = advisory_for("vim", "9.0.1224-1", &a, || Some("9.0.1225-1")).expect("reported");

        assert!(is_actionable(&got));
        assert_eq!(got.severity, "Unknown");
    }

    #[test]
    fn epochs_apply_to_installed_and_candidate_versions() {
        let a = avg(AvgStatus::Vulnerable, "1:1.0-1", Some("2:1.0-1"));
        assert!(advisory_for("pkg", "2.0-1", &a, || unreachable!()).is_none());
        let older_epoch =
            advisory_for("pkg", "1:1.0-1", &a, || Some("1:99.0-1")).expect("reported");
        let fixed = advisory_for("pkg", "1:1.0-1", &a, || Some("2:1.0-1")).expect("reported");
        assert!(!older_epoch.fix_available);
        assert!(fixed.fix_available);
    }

    #[test]
    fn malformed_tracker_versions_keep_the_advisory_listed() {
        for invalid in ["", "5.0-1\0", "5.0-1\n", "5.0 -1"] {
            let a = avg(AvgStatus::Vulnerable, invalid, None);
            assert!(advisory_for("bash", "5.2-1", &a, || unreachable!()).is_some());
            let a = avg(AvgStatus::Vulnerable, "5.0-1", Some(invalid));
            let got = advisory_for("bash", "5.2-1", &a, || unreachable!()).expect("reported");
            assert_eq!(got.fixed_version, None);
            assert!(!got.fix_available);
        }
    }

    #[test]
    fn pkgrel_bumps_use_arch_version_ordering() {
        let a = avg(AvgStatus::Vulnerable, "1.0-1", Some("1.0-3"));
        assert!(
            !advisory_for("pkg", "1.0-2", &a, || Some("1.0-2.1"))
                .unwrap()
                .fix_available
        );
        assert!(
            advisory_for("pkg", "1.0-2", &a, || Some("1.0-3"))
                .unwrap()
                .fix_available
        );
        assert!(advisory_for("pkg", "1.0-3", &a, || unreachable!()).is_none());
    }

    #[test]
    fn available_fixes_sort_above_unavailable_tracker_fixes() {
        let low_fixable = advisory_for(
            "vim",
            "9.0.1224-1",
            &Avg {
                severity: Severity::Low,
                ..avg(AvgStatus::Vulnerable, "9.0.1224-1", Some("9.0.1225-1"))
            },
            || Some("9.0.1225-1"),
        )
        .expect("reported");
        let high_stuck = advisory_for(
            "linux",
            "5.15.8.arch1-1",
            &avg(
                AvgStatus::Vulnerable,
                "5.15.8.arch1-1",
                Some("5.15.9.arch1-1"),
            ),
            || Some("5.15.8.arch1-2"),
        )
        .expect("reported");
        let mut list = vec![high_stuck, low_fixable];
        sort_advisories(&mut list);
        assert_eq!(list[0].package, "vim");
        assert_eq!(list[1].package, "linux");
    }
}

#[cfg(test)]
mod feed_tests {
    use super::{FeedCache, load_feed, now_secs, write_feed_cache};
    use arch_security_client::SecurityClient;
    use wiremock::matchers::{method, path as req_path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const ONE_AVG: &str = r#"[{"name":"AVG-1","packages":["bash"],"status":"Vulnerable",
        "severity":"High","type":"code execution","affected":"5.0-1","fixed":null,
        "issues":["CVE-2024-1"],"advisories":[]}]"#;

    fn cache_file(tag: &str) -> std::path::PathBuf {
        crate::network::test_context();
        std::env::temp_dir().join(format!("cpac-feed-{tag}-{}", std::process::id()))
    }

    async fn serving(body: &str) -> MockServer {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(req_path("/issues/all.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(body))
            .mount(&server)
            .await;
        server
    }

    #[tokio::test]
    async fn a_fresh_cache_is_served_without_asking_upstream() {
        let path = cache_file("fresh");
        write_feed_cache(
            &path,
            &FeedCache {
                fetched_at: now_secs(),
                body: ONE_AVG.to_string(),
            },
        )
        .expect("writes");

        let server = MockServer::start().await;
        let client = SecurityClient::with_base_url(&server.uri());

        let feed = load_feed(&client, false, Some(&path)).expect("served from cache");
        assert_eq!(feed.avgs.len(), 1);
        assert!(!feed.stale, "reuse inside the window is not staleness");
        assert!(
            server
                .received_requests()
                .await
                .unwrap_or_default()
                .is_empty()
        );

        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn a_legacy_cache_cannot_hide_issues_from_the_complete_feed() {
        let directory = cache_file("migration");
        crate::util::private_dir(&directory);
        for old in ["security-cache.json", "security-feed.json"] {
            std::fs::write(
                directory.join(old),
                serde_json::to_vec(&FeedCache {
                    fetched_at: now_secs(),
                    body: "[]".to_string(),
                })
                .unwrap(),
            )
            .unwrap();
        }
        let configured = super::security_cache_path().unwrap();
        let path = directory.join(configured.file_name().unwrap());
        let server = serving(ONE_AVG).await;
        let client = SecurityClient::with_base_url(&server.uri());

        let feed = load_feed(&client, false, Some(&path)).unwrap();

        assert_eq!(feed.avgs.len(), 1);
        assert!(!feed.stale);
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
        assert!(path.is_file());
        assert!(!directory.join("security-cache.json").exists());
        assert!(!directory.join("security-feed.json").exists());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn force_refetches_even_when_the_cache_is_fresh() {
        let path = cache_file("force");
        write_feed_cache(
            &path,
            &FeedCache {
                fetched_at: now_secs(),
                body: "[]".to_string(),
            },
        )
        .expect("writes");

        let server = serving(ONE_AVG).await;
        let client = SecurityClient::with_base_url(&server.uri());

        let feed = load_feed(&client, true, Some(&path)).expect("refetches");
        assert_eq!(
            feed.avgs.len(),
            1,
            "the served feed won, not the cached one"
        );
        assert_eq!(
            server.received_requests().await.unwrap_or_default().len(),
            1
        );

        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn an_old_cache_answers_when_the_fetch_fails() {
        let path = cache_file("stale");
        write_feed_cache(
            &path,
            &FeedCache {
                fetched_at: now_secs() - 86_400,
                body: ONE_AVG.to_string(),
            },
        )
        .expect("writes");

        let client = SecurityClient::with_base_url("http://127.0.0.1:1");
        let feed = load_feed(&client, false, Some(&path)).expect("falls back");

        assert_eq!(feed.avgs.len(), 1);
        assert!(feed.stale, "a fallback must be marked stale");

        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn a_fresh_but_malformed_cache_is_refetched() {
        let path = cache_file("malformed-fresh");
        write_feed_cache(
            &path,
            &FeedCache {
                fetched_at: now_secs(),
                body: "not json".to_string(),
            },
        )
        .expect("writes");

        let server = serving(ONE_AVG).await;
        let client = SecurityClient::with_base_url(&server.uri());

        let feed = load_feed(&client, false, Some(&path)).expect("refetches");
        assert_eq!(feed.avgs.len(), 1);
        assert_eq!(
            server.received_requests().await.unwrap_or_default().len(),
            1
        );

        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn a_garbled_live_body_falls_back_to_an_old_cache() {
        let path = cache_file("garbled-live");
        write_feed_cache(
            &path,
            &FeedCache {
                fetched_at: now_secs() - 86_400,
                body: ONE_AVG.to_string(),
            },
        )
        .expect("writes");

        let server = serving("<html>maintenance</html>").await;
        let client = SecurityClient::with_base_url(&server.uri());

        let feed = load_feed(&client, false, Some(&path)).expect("falls back");
        assert_eq!(feed.avgs.len(), 1);
        assert!(feed.stale);

        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn a_failed_fetch_with_no_cache_is_an_error() {
        let client = SecurityClient::with_base_url("http://127.0.0.1:1");
        let missing = cache_file("absent");
        std::fs::remove_file(&missing).ok();

        assert!(
            load_feed(&client, false, Some(&missing)).is_err(),
            "the failure must be explicit, not an empty advisory list"
        );
    }
}
