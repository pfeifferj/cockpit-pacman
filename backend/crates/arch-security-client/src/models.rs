use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub enum AvgStatus {
    Fixed,
    Vulnerable,
    Testing,
    #[serde(rename = "Not affected")]
    NotAffected,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
pub enum Severity {
    Low,
    Medium,
    High,
    Critical,
    #[serde(other)]
    Unknown,
}

impl Severity {
    fn rank(self) -> u8 {
        match self {
            Severity::Unknown => 0,
            Severity::Low => 1,
            Severity::Medium => 2,
            Severity::High => 3,
            Severity::Critical => 4,
        }
    }
}

impl Ord for Severity {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.rank().cmp(&other.rank())
    }
}

impl PartialOrd for Severity {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl AvgStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            AvgStatus::Fixed => "Fixed",
            AvgStatus::Vulnerable => "Vulnerable",
            AvgStatus::Testing => "Testing",
            AvgStatus::NotAffected => "Not affected",
            AvgStatus::Unknown => "Unknown",
        }
    }
}

impl Severity {
    pub fn as_str(&self) -> &'static str {
        match self {
            Severity::Critical => "Critical",
            Severity::High => "High",
            Severity::Medium => "Medium",
            Severity::Low => "Low",
            Severity::Unknown => "Unknown",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Avg {
    pub name: String,
    pub packages: Vec<String>,
    pub status: AvgStatus,
    pub severity: Severity,
    #[serde(rename = "type")]
    pub advisory_type: String,
    pub affected: String,
    pub fixed: Option<String>,
    pub issues: Vec<String>,
    pub advisories: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PackageAdvisory {
    pub name: String,
    pub date: String,
    pub severity: Severity,
    #[serde(rename = "type")]
    pub advisory_type: String,
    pub reference: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PackageVulnGroup {
    pub name: String,
    pub status: AvgStatus,
    pub severity: Severity,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PackageCve {
    pub name: String,
    pub severity: Severity,
    #[serde(rename = "type")]
    pub issue_type: String,
    pub status: AvgStatus,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PackageVersion {
    pub version: String,
    pub database: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PackageInfo {
    pub name: String,
    pub versions: Vec<PackageVersion>,
    pub advisories: Vec<PackageAdvisory>,
    pub groups: Vec<PackageVulnGroup>,
    pub issues: Vec<PackageCve>,
}
