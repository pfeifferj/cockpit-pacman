pub mod models;

use std::io::Read;
use std::time::Duration;

use anyhow::{Context, Result};
use models::{Avg, PackageInfo};

pub const DEFAULT_BASE_URL: &str = "https://security.archlinux.org";
const MAX_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;

pub struct SecurityClient {
    agent: ureq::Agent,
    base_url: String,
}

impl SecurityClient {
    pub fn new(ip_family: ureq::config::IpFamily) -> Self {
        Self::with_base_url(DEFAULT_BASE_URL, ip_family)
    }

    pub fn with_base_url(url: &str, ip_family: ureq::config::IpFamily) -> Self {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(15)))
            .timeout_connect(Some(Duration::from_secs(5)))
            .ip_family(ip_family)
            .build();
        Self {
            agent: ureq::Agent::new_with_config(config),
            base_url: url.trim_end_matches('/').to_string(),
        }
    }

    pub fn fetch_vulnerable(&self) -> Result<Vec<Avg>> {
        let url = format!("{}/issues/vulnerable.json", self.base_url);
        let body = self
            .get_json(&url)
            .context("failed to fetch vulnerable issues")?;
        serde_json::from_str(&body).context("failed to parse vulnerable issues JSON")
    }

    pub fn fetch_package(&self, name: &str) -> Result<PackageInfo> {
        let url = format!("{}/package/{}.json", self.base_url, name);
        let body = self
            .get_json(&url)
            .with_context(|| format!("failed to fetch security info for {}", name))?;
        serde_json::from_str(&body)
            .with_context(|| format!("failed to parse security info for {}", name))
    }

    fn get_json(&self, url: &str) -> Result<String> {
        let mut body = self
            .agent
            .get(url)
            .call()
            .with_context(|| format!("GET {} failed", url))?
            .into_body();
        let mut buf = Vec::new();
        body.as_reader()
            .take(MAX_RESPONSE_BYTES)
            .read_to_end(&mut buf)?;
        String::from_utf8(buf).context("response is not valid UTF-8")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use models::{AvgStatus, Severity};

    #[test]
    fn deserialize_avg() {
        let json = r#"{
            "name": "AVG-1",
            "packages": ["lib32-gdk-pixbuf2"],
            "status": "Fixed",
            "severity": "Critical",
            "type": "arbitrary code execution",
            "affected": "2.34.0-1",
            "fixed": "2.36.0+2+ga7c869a-1",
            "ticket": null,
            "issues": ["CVE-2016-6352"],
            "advisories": ["ASA-201611-12"],
            "references": [],
            "notes": null
        }"#;

        let avg: Avg = serde_json::from_str(json).unwrap();
        assert_eq!(avg.name, "AVG-1");
        assert_eq!(avg.packages, vec!["lib32-gdk-pixbuf2"]);
        assert_eq!(avg.status, AvgStatus::Fixed);
        assert_eq!(avg.severity, Severity::Critical);
        assert_eq!(avg.advisory_type, "arbitrary code execution");
        assert_eq!(avg.affected, "2.34.0-1");
        assert_eq!(avg.fixed.as_deref(), Some("2.36.0+2+ga7c869a-1"));
        assert_eq!(avg.issues, vec!["CVE-2016-6352"]);
        assert_eq!(avg.advisories, vec!["ASA-201611-12"]);
    }

    #[test]
    fn deserialize_avg_vulnerable_no_fix() {
        let json = r#"{
            "name": "AVG-2843",
            "packages": ["vim", "gvim"],
            "status": "Vulnerable",
            "severity": "Unknown",
            "type": "unknown",
            "affected": "9.1.0000-1",
            "fixed": null,
            "ticket": null,
            "issues": ["CVE-2023-0433"],
            "advisories": [],
            "references": [],
            "notes": null
        }"#;

        let avg: Avg = serde_json::from_str(json).unwrap();
        assert_eq!(avg.status, AvgStatus::Vulnerable);
        assert_eq!(avg.severity, Severity::Unknown);
        assert!(avg.fixed.is_none());
        assert!(avg.advisories.is_empty());
    }

    #[test]
    fn deserialize_avg_list() {
        let json = r#"[
            {
                "name": "AVG-1",
                "packages": ["pkg1"],
                "status": "Fixed",
                "severity": "High",
                "type": "privilege escalation",
                "affected": "1.0-1",
                "fixed": "1.1-1",
                "ticket": null,
                "issues": ["CVE-2024-0001"],
                "advisories": [],
                "references": [],
                "notes": null
            },
            {
                "name": "AVG-2",
                "packages": ["pkg2"],
                "status": "Not affected",
                "severity": "Low",
                "type": "information disclosure",
                "affected": "2.0-1",
                "fixed": null,
                "ticket": null,
                "issues": [],
                "advisories": [],
                "references": [],
                "notes": null
            }
        ]"#;

        let avgs: Vec<Avg> = serde_json::from_str(json).unwrap();
        assert_eq!(avgs.len(), 2);
        assert_eq!(avgs[0].severity, Severity::High);
        assert_eq!(avgs[1].status, AvgStatus::NotAffected);
    }

    #[test]
    fn deserialize_package_info() {
        let json = r#"{
            "name": "vim",
            "versions": [
                {"version": "9.2.0204-2", "database": "extra"}
            ],
            "advisories": [
                {
                    "name": "ASA-201906-8",
                    "date": "2019-06-11",
                    "severity": "High",
                    "type": "arbitrary code execution",
                    "reference": "https://lists.archlinux.org/example"
                }
            ],
            "groups": [
                {"name": "AVG-2843", "status": "Unknown", "severity": "Unknown"}
            ],
            "issues": [
                {
                    "name": "CVE-2023-0433",
                    "severity": "Unknown",
                    "type": "unknown",
                    "status": "Unknown"
                }
            ]
        }"#;

        let info: PackageInfo = serde_json::from_str(json).unwrap();
        assert_eq!(info.name, "vim");
        assert_eq!(info.versions.len(), 1);
        assert_eq!(info.versions[0].database, "extra");
        assert_eq!(info.advisories.len(), 1);
        assert_eq!(info.advisories[0].severity, Severity::High);
        assert_eq!(info.groups.len(), 1);
        assert_eq!(info.issues.len(), 1);
    }

    #[test]
    fn severity_ordering() {
        assert!(Severity::Critical > Severity::High);
        assert!(Severity::High > Severity::Medium);
        assert!(Severity::Medium > Severity::Low);
        assert!(Severity::Low > Severity::Unknown);
    }
}
