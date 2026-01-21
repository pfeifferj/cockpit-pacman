use serde::Serialize;

#[derive(Serialize)]
pub struct Package {
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub installed_size: i64,
    pub install_date: Option<i64>,
    pub reason: String,
    pub repository: Option<String>,
}

#[derive(Serialize)]
pub struct PackageListResponse {
    pub packages: Vec<Package>,
    pub total: usize,
    pub total_explicit: usize,
    pub total_dependency: usize,
    pub repositories: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Serialize)]
pub struct UpdatesResponse {
    pub updates: Vec<UpdateInfo>,
    pub warnings: Vec<String>,
}

#[derive(Serialize)]
pub struct UpdateInfo {
    pub name: String,
    pub current_version: String,
    pub new_version: String,
    pub download_size: i64,
    pub current_size: i64,
    pub new_size: i64,
    pub repository: String,
}

#[derive(Serialize)]
pub struct PackageDetails {
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub url: Option<String>,
    pub licenses: Vec<String>,
    pub groups: Vec<String>,
    pub provides: Vec<String>,
    pub depends: Vec<String>,
    pub optdepends: Vec<String>,
    pub conflicts: Vec<String>,
    pub replaces: Vec<String>,
    pub installed_size: i64,
    pub packager: Option<String>,
    pub architecture: Option<String>,
    pub build_date: i64,
    pub install_date: Option<i64>,
    pub reason: String,
    pub validation: Vec<String>,
    pub repository: Option<String>,
}

#[derive(Serialize)]
pub struct SearchResult {
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub repository: String,
    pub installed: bool,
    pub installed_version: Option<String>,
}

#[derive(Serialize)]
pub struct SearchResponse {
    pub results: Vec<SearchResult>,
    pub total: usize,
    pub total_installed: usize,
    pub total_not_installed: usize,
    pub repositories: Vec<String>,
}

#[derive(Serialize)]
pub struct SyncPackageDetails {
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub url: Option<String>,
    pub licenses: Vec<String>,
    pub groups: Vec<String>,
    pub provides: Vec<String>,
    pub depends: Vec<String>,
    pub optdepends: Vec<String>,
    pub conflicts: Vec<String>,
    pub replaces: Vec<String>,
    pub download_size: i64,
    pub installed_size: i64,
    pub packager: Option<String>,
    pub architecture: Option<String>,
    pub build_date: i64,
    pub repository: String,
}

#[derive(Serialize, Clone)]
pub struct KeyInfo {
    pub fingerprint: String,
    pub uid: String,
}

#[derive(Serialize, Default)]
pub struct PreflightResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub conflicts: Vec<ConflictInfo>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub replacements: Vec<ReplacementInfo>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub removals: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub providers: Vec<ProviderChoice>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub import_keys: Vec<KeyInfo>,
    pub packages_to_upgrade: usize,
    pub total_download_size: i64,
}

#[derive(Serialize, Clone)]
pub struct ConflictInfo {
    pub package1: String,
    pub package2: String,
}

#[derive(Serialize, Clone)]
pub struct ReplacementInfo {
    pub old_package: String,
    pub new_package: String,
}

#[derive(Serialize, Clone)]
pub struct ProviderChoice {
    pub dependency: String,
    pub providers: Vec<String>,
}

#[derive(Default)]
pub struct PreflightState {
    pub conflicts: Vec<ConflictInfo>,
    pub replacements: Vec<ReplacementInfo>,
    pub removals: Vec<String>,
    pub providers: Vec<ProviderChoice>,
    pub import_keys: Vec<KeyInfo>,
}

#[derive(Serialize)]
#[serde(tag = "type")]
pub enum StreamEvent {
    #[serde(rename = "log")]
    Log { level: String, message: String },
    #[serde(rename = "progress")]
    Progress {
        operation: String,
        package: String,
        percent: i32,
        current: usize,
        total: usize,
    },
    #[serde(rename = "download")]
    Download {
        filename: String,
        event: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        downloaded: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        total: Option<i64>,
    },
    #[serde(rename = "event")]
    Event {
        event: String,
        package: Option<String>,
    },
    #[serde(rename = "complete")]
    Complete {
        success: bool,
        message: Option<String>,
    },
}

#[derive(Serialize)]
pub struct KeyringKey {
    pub fingerprint: String,
    pub uid: String,
    pub created: Option<String>,
    pub expires: Option<String>,
    pub trust: String,
}

#[derive(Serialize)]
pub struct KeyringStatusResponse {
    pub keys: Vec<KeyringKey>,
    pub total: usize,
    pub master_key_initialized: bool,
    pub warnings: Vec<String>,
}

#[derive(Serialize)]
pub struct OrphanPackage {
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub installed_size: i64,
    pub install_date: Option<i64>,
    pub repository: Option<String>,
}

#[derive(Serialize)]
pub struct OrphanResponse {
    pub orphans: Vec<OrphanPackage>,
    pub total_size: i64,
}

#[derive(Serialize)]
pub struct CachePackage {
    pub name: String,
    pub version: String,
    pub filename: String,
    pub size: i64,
}

#[derive(Serialize)]
pub struct CacheInfo {
    pub total_size: i64,
    pub package_count: usize,
    pub packages: Vec<CachePackage>,
    pub path: String,
}

#[derive(Serialize)]
pub struct LogEntry {
    pub timestamp: String,
    pub action: String,
    pub package: String,
    pub old_version: Option<String>,
    pub new_version: Option<String>,
}

#[derive(Serialize)]
pub struct LogResponse {
    pub entries: Vec<LogEntry>,
    pub total: usize,
    pub total_upgraded: usize,
    pub total_installed: usize,
    pub total_removed: usize,
    pub total_other: usize,
}

#[derive(Serialize)]
pub struct CachedVersion {
    pub name: String,
    pub version: String,
    pub filename: String,
    pub size: i64,
    pub installed_version: Option<String>,
    pub is_older: bool,
}

#[derive(Serialize)]
pub struct DowngradeResponse {
    pub packages: Vec<CachedVersion>,
    pub total: usize,
}

#[derive(Serialize)]
pub struct ScheduledRunEntry {
    pub timestamp: String,
    pub mode: String,
    pub success: bool,
    pub packages_checked: usize,
    pub packages_upgraded: usize,
    pub error: Option<String>,
    pub details: Vec<String>,
}

#[derive(Serialize)]
pub struct ScheduledRunsResponse {
    pub runs: Vec<ScheduledRunEntry>,
    pub total: usize,
}
