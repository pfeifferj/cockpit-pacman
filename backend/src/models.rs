use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Wire mirror of archweb_client's Signoff so the type can derive TS bindings
/// without depending on the external crate's type. Mapped from the client type
/// in the signoff handler.
#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct Signoff {
    pub user: String,
    pub created: String,
    pub revoked: bool,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct NewsItem {
    pub title: String,
    pub link: String,
    pub published: String,
    pub summary: String,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct NewsResponse {
    pub items: Vec<NewsItem>,
    /// True when served from the on-disk cache because the live fetch failed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stale: bool,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct Package {
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    #[ts(type = "number")]
    pub installed_size: i64,
    #[ts(type = "number | null")]
    pub install_date: Option<i64>,
    pub reason: String,
    pub repository: Option<String>,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct PackageListResponse {
    pub packages: Vec<Package>,
    pub total: usize,
    pub total_explicit: usize,
    pub total_dependency: usize,
    pub repositories: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct UpdatesResponse {
    pub updates: Vec<UpdateInfo>,
    pub warnings: Vec<String>,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct UpdateInfo {
    pub name: String,
    pub current_version: String,
    pub new_version: String,
    #[ts(type = "number")]
    pub download_size: i64,
    #[ts(type = "number")]
    pub current_size: i64,
    #[ts(type = "number")]
    pub new_size: i64,
    pub repository: String,
    #[serde(default)]
    pub ignored: bool,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
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
    pub required_by: Vec<String>,
    pub optional_for: Vec<String>,
    #[ts(type = "number")]
    pub installed_size: i64,
    pub packager: Option<String>,
    pub architecture: Option<String>,
    #[ts(type = "number")]
    pub build_date: i64,
    #[ts(type = "number | null")]
    pub install_date: Option<i64>,
    pub reason: String,
    pub validation: Vec<String>,
    pub repository: Option<String>,
    pub update_stats: Option<UpdateStats>,
}

#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct UpdateStats {
    pub update_count: usize,
    pub first_installed: Option<String>,
    pub last_updated: Option<String>,
    pub avg_days_between_updates: Option<f64>,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct SearchResult {
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub repository: String,
    pub installed: bool,
    pub installed_version: Option<String>,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct SearchResponse {
    pub results: Vec<SearchResult>,
    pub total: usize,
    pub total_installed: usize,
    pub total_not_installed: usize,
    pub repositories: Vec<String>,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
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
    #[ts(type = "number")]
    pub download_size: i64,
    #[ts(type = "number")]
    pub installed_size: i64,
    pub packager: Option<String>,
    pub architecture: Option<String>,
    #[ts(type = "number")]
    pub build_date: i64,
    pub repository: String,
}

#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(
    export,
    export_to = "../../src/bindings/index.ts",
    rename = "PreflightKeyInfo"
)]
pub struct KeyInfo {
    pub fingerprint: String,
    pub uid: String,
}

#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
#[serde(rename_all = "lowercase")]
pub enum WarningSeverity {
    Info,
    Warning,
    Danger,
}

#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct PreflightWarning {
    pub id: String,
    pub severity: WarningSeverity,
    pub title: String,
    pub message: String,
    pub packages: Vec<String>,
}

#[derive(Serialize, Deserialize, Default, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct PreflightResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conflicts: Vec<ConflictInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub replacements: Vec<ReplacementInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removals: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub providers: Vec<ProviderChoice>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub import_keys: Vec<KeyInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<PreflightWarning>,
    pub packages_to_upgrade: usize,
    #[ts(type = "number")]
    pub total_download_size: i64,
}

#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct ConflictInfo {
    pub package1: String,
    pub package2: String,
}

#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct ReplacementInfo {
    pub old_package: String,
    pub new_package: String,
}

#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
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

/// Error envelope emitted to stdout for classified failures, consumed by the
/// frontend as an authoritative error code (see runBackend in api.ts).
// Not TS-exported: the frontend keeps a hand-written StructuredError whose
// `code` is the ErrorCode union rather than a bare string.
#[derive(Serialize, Deserialize)]
pub struct StructuredError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
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
        #[ts(optional, as = "Option<i32>")]
        downloaded: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional, as = "Option<i32>")]
        total: Option<i64>,
    },
    #[serde(rename = "event")]
    Event {
        event: String,
        #[ts(optional)]
        package: Option<String>,
    },
    #[serde(rename = "complete")]
    Complete {
        success: bool,
        #[ts(optional)]
        message: Option<String>,
    },
    #[serde(rename = "mirror_test")]
    MirrorTest {
        url: String,
        current: usize,
        total: usize,
        result: MirrorTestResult,
    },
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct KeyringKey {
    pub fingerprint: String,
    pub uid: String,
    pub created: Option<String>,
    pub expires: Option<String>,
    pub trust: String,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct KeyringStatusResponse {
    pub keys: Vec<KeyringKey>,
    pub total: usize,
    pub master_key_initialized: bool,
    pub warnings: Vec<String>,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct OrphanPackage {
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    #[ts(type = "number")]
    pub installed_size: i64,
    #[ts(type = "number | null")]
    pub install_date: Option<i64>,
    pub repository: Option<String>,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct OrphanResponse {
    pub orphans: Vec<OrphanPackage>,
    #[ts(type = "number")]
    pub total_size: i64,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct CachePackage {
    pub name: String,
    pub version: String,
    pub filename: String,
    #[ts(type = "number")]
    pub size: i64,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct CacheInfo {
    #[ts(type = "number")]
    pub total_size: i64,
    pub package_count: usize,
    pub packages: Vec<CachePackage>,
    pub path: String,
}

#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct LogEntry {
    pub timestamp: String,
    pub action: String,
    pub package: String,
    pub old_version: Option<String>,
    pub new_version: Option<String>,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct LogResponse {
    pub entries: Vec<LogEntry>,
    pub total: usize,
    pub total_upgraded: usize,
    pub total_installed: usize,
    pub total_removed: usize,
    pub total_other: usize,
}

#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct LogGroup {
    pub id: String,
    pub start_time: String,
    pub end_time: String,
    pub entries: Vec<LogEntry>,
    pub upgraded_count: usize,
    pub installed_count: usize,
    pub removed_count: usize,
    pub downgraded_count: usize,
    pub reinstalled_count: usize,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct GroupedLogResponse {
    pub groups: Vec<LogGroup>,
    pub total_groups: usize,
    pub total_upgraded: usize,
    pub total_installed: usize,
    pub total_removed: usize,
    pub total_other: usize,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct CachedVersion {
    pub name: String,
    pub version: String,
    pub filename: String,
    #[ts(type = "number")]
    pub size: i64,
    pub installed_version: Option<String>,
    pub is_older: bool,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct DowngradeResponse {
    pub packages: Vec<CachedVersion>,
    pub total: usize,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct ScheduledRunEntry {
    pub timestamp: String,
    pub mode: String,
    pub success: bool,
    // "ok" | "skipped" | "failed". `skipped` is a deferred run (safety limit or
    // manual intervention required); `success` stays true for those.
    pub status: String,
    pub packages_checked: usize,
    pub packages_upgraded: usize,
    pub error: Option<String>,
    pub details: Vec<String>,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct ScheduledRunsResponse {
    pub runs: Vec<ScheduledRunEntry>,
    pub total: usize,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct RebootStatus {
    pub requires_reboot: bool,
    pub reason: String,
    pub running_kernel: Option<String>,
    pub installed_kernel: Option<String>,
    pub kernel_package: Option<String>,
    pub updated_packages: Vec<String>,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct PacnewFile {
    pub path: String,
    pub package: String,
    pub kind: String,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct PacnewStatus {
    pub has_pacnew: bool,
    pub files: Vec<PacnewFile>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
#[serde(rename_all = "snake_case")]
pub enum RestartBlocked {
    SessionCritical,
    CockpitSession,
    CockpitTransport,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct ServiceRestart {
    pub name: String,
    pub pid: u32,
    pub affected_packages: Vec<String>,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart_blocked: Option<RestartBlocked>,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct ServicesStatus {
    pub restart_required: bool,
    pub services: Vec<ServiceRestart>,
}

#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct MirrorEntry {
    pub url: String,
    pub enabled: bool,
    pub comment: Option<String>,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct MirrorListResponse {
    pub mirrors: Vec<MirrorEntry>,
    pub total: usize,
    pub enabled_count: usize,
    pub path: String,
    #[ts(type = "number | null")]
    pub last_modified: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct MirrorStatus {
    pub url: String,
    pub country: Option<String>,
    pub country_code: Option<String>,
    pub last_sync: Option<String>,
    #[ts(type = "number | null")]
    pub delay: Option<i64>,
    pub score: Option<f64>,
    pub completion_pct: Option<f64>,
    pub active: bool,
    pub ipv4: bool,
    pub ipv6: bool,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct MirrorStatusResponse {
    pub mirrors: Vec<MirrorStatus>,
    pub total: usize,
    pub last_check: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct MirrorTestResult {
    pub url: String,
    pub success: bool,
    #[ts(type = "number | null")]
    pub speed_bps: Option<u64>,
    #[ts(type = "number | null")]
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct SaveMirrorlistResponse {
    pub success: bool,
    pub backup_path: Option<String>,
    pub message: String,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct RefreshMirrorsResponse {
    pub mirrors: Vec<MirrorEntry>,
    pub total: usize,
    pub last_check: Option<String>,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct MirrorBackup {
    #[ts(type = "number")]
    pub timestamp: i64,
    pub date: String,
    pub enabled_count: usize,
    pub total_count: usize,
    #[ts(type = "number")]
    pub size: u64,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct MirrorBackupListResponse {
    pub backups: Vec<MirrorBackup>,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct RestoreMirrorBackupResponse {
    pub success: bool,
    pub backup_path: Option<String>,
    pub message: String,
}

#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct DependencyNode {
    pub id: String,
    pub name: String,
    pub version: String,
    pub depth: u32,
    pub installed: bool,
    pub reason: Option<String>,
    pub repository: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct DependencyEdge {
    pub source: String,
    pub target: String,
    pub edge_type: String,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct DependencyTreeResponse {
    pub nodes: Vec<DependencyNode>,
    pub edges: Vec<DependencyEdge>,
    pub root: String,
    pub max_depth_reached: bool,
    pub warnings: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
#[serde(rename_all = "snake_case")]
pub enum VersionMatch {
    Match,
    Mismatch,
    NotInstalled,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct SignoffGroupWithLocal {
    pub pkgbase: String,
    pub pkgnames: Vec<String>,
    pub version: String,
    pub arch: String,
    pub repo: String,
    pub packager: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub comments: Option<String>,
    pub last_update: String,
    pub known_bad: bool,
    pub approved: bool,
    pub required: u32,
    pub enabled: bool,
    pub signoffs: Vec<Signoff>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_version: Option<String>,
    pub version_match: VersionMatch,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct SignoffListResponse {
    pub signoff_groups: Vec<SignoffGroupWithLocal>,
    pub total: usize,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct SignoffActionResponse {
    pub success: bool,
    pub pkgbase: String,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct PackageSecurityAdvisory {
    pub package: String,
    pub severity: String,
    pub advisory_type: String,
    pub avg_name: String,
    pub cve_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fixed_version: Option<String>,
    pub status: String,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct SecurityResponse {
    pub advisories: Vec<PackageSecurityAdvisory>,
    /// True when served from the on-disk cache because the live fetch failed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stale: bool,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct SecurityInfoAdvisory {
    pub name: String,
    pub date: String,
    pub severity: String,
    pub advisory_type: String,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct SecurityInfoGroup {
    pub name: String,
    pub status: String,
    pub severity: String,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct SecurityInfoIssue {
    pub name: String,
    pub severity: String,
    pub issue_type: String,
    pub status: String,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct SecurityInfoResponse {
    pub name: String,
    pub advisories: Vec<SecurityInfoAdvisory>,
    pub groups: Vec<SecurityInfoGroup>,
    pub issues: Vec<SecurityInfoIssue>,
}

#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct RepoDirectiveFull {
    pub directive_type: String,
    pub value: String,
    pub enabled: bool,
}

#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct RepoEntry {
    pub name: String,
    pub enabled: bool,
    pub sig_level: Option<String>,
    pub directives: Vec<RepoDirectiveFull>,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct ListReposResponse {
    pub repos: Vec<RepoEntry>,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct SaveReposResponse {
    pub success: bool,
    pub backup_path: Option<String>,
    pub message: String,
}
