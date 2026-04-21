//! Contract tests: verify that Rust structs serialize to the JSON shape the TypeScript
//! frontend expects. Failures here mean a struct was changed without updating TS types.
//!
//! Each test serializes a representative instance and asserts field names, types,
//! nullability, and enum variants. A companion test then parses the shared fixture from
//! test/fixtures/ and verifies it has the same shape.
//!
//! Run with: cargo test --test contract_tests

use cockpit_pacman_backend::models::{
    CacheInfo, CachePackage, ConflictInfo, DependencyEdge, DependencyNode, DependencyTreeResponse,
    GroupedLogResponse, KeyInfo, KeyringKey, KeyringStatusResponse, LogEntry, LogGroup,
    MirrorEntry, MirrorListResponse, MirrorStatus, MirrorStatusResponse, MirrorTestResult,
    NewsItem, NewsResponse, OrphanPackage, OrphanResponse, Package, PackageDetails,
    PackageListResponse, PackageSecurityAdvisory, PreflightResponse, PreflightWarning,
    ProviderChoice, RebootStatus, RefreshMirrorsResponse, ReplacementInfo, RestartBlocked,
    RestoreMirrorBackupResponse, SaveMirrorlistResponse, ScheduledRunEntry, ScheduledRunsResponse,
    SearchResponse, SearchResult, SecurityInfoAdvisory, SecurityInfoGroup, SecurityInfoIssue,
    SecurityInfoResponse, SecurityResponse, ServiceRestart, ServicesStatus, StreamEvent,
    SyncPackageDetails, UpdateInfo, UpdateStats, UpdatesResponse, VersionMatch, WarningSeverity,
};
use serde_json::Value;

fn to_json<T: serde::Serialize>(v: &T) -> Value {
    serde_json::to_value(v).expect("serialization must not fail")
}

fn parse_fixture(fixture: &str) -> Value {
    serde_json::from_str(fixture).expect("fixture must be valid JSON")
}

fn assert_string(v: &Value, field: &str) {
    assert!(
        v[field].is_string(),
        "field `{field}` must be a string, got: {}",
        v[field]
    );
}

fn assert_number(v: &Value, field: &str) {
    assert!(
        v[field].is_number(),
        "field `{field}` must be a number, got: {}",
        v[field]
    );
}

fn assert_bool(v: &Value, field: &str) {
    assert!(
        v[field].is_boolean(),
        "field `{field}` must be a boolean, got: {}",
        v[field]
    );
}

fn assert_array(v: &Value, field: &str) {
    assert!(
        v[field].is_array(),
        "field `{field}` must be an array, got: {}",
        v[field]
    );
}

fn assert_null(v: &Value, field: &str) {
    assert!(
        v[field].is_null(),
        "field `{field}` must be null, got: {}",
        v[field]
    );
}

fn assert_object(v: &Value, field: &str) {
    assert!(
        v[field].is_object(),
        "field `{field}` must be an object, got: {}",
        v[field]
    );
}

fn assert_absent(v: &Value, field: &str) {
    assert!(
        v.get(field).is_none(),
        "field `{field}` must be absent (skip_serializing_if), but found: {}",
        v[field]
    );
}

// Package

#[test]
fn package_required_fields_are_correct_types() {
    let pkg = Package {
        name: "linux".into(),
        version: "6.7.0-arch1-1".into(),
        description: Some("The Linux kernel and modules".into()),
        installed_size: 142_000_000,
        install_date: Some(1_704_067_200),
        reason: "explicit".into(),
        repository: Some("core".into()),
    };
    let v = to_json(&pkg);

    assert_string(&v, "name");
    assert_string(&v, "version");
    assert_string(&v, "description");
    assert_number(&v, "installed_size");
    assert_number(&v, "install_date");
    assert_string(&v, "reason");
    assert_string(&v, "repository");

    assert_eq!(v["name"], "linux");
    assert_eq!(v["version"], "6.7.0-arch1-1");
    assert_eq!(v["installed_size"], 142_000_000i64);
    assert_eq!(v["install_date"], 1_704_067_200i64);
    assert_eq!(v["reason"], "explicit");
    assert_eq!(v["repository"], "core");
}

#[test]
fn package_optional_fields_serialize_as_null() {
    let pkg = Package {
        name: "minimal".into(),
        version: "1.0-1".into(),
        description: None,
        installed_size: 1024,
        install_date: None,
        reason: "dependency".into(),
        repository: None,
    };
    let v = to_json(&pkg);

    assert_null(&v, "description");
    assert_null(&v, "install_date");
    assert_null(&v, "repository");
}

#[test]
fn package_list_response_shape() {
    let response = PackageListResponse {
        packages: vec![],
        total: 100,
        total_explicit: 60,
        total_dependency: 40,
        repositories: vec!["core".into(), "extra".into()],
        warnings: vec![],
    };
    let v = to_json(&response);

    assert_array(&v, "packages");
    assert_number(&v, "total");
    assert_number(&v, "total_explicit");
    assert_number(&v, "total_dependency");
    assert_array(&v, "repositories");
    assert_array(&v, "warnings");

    assert_eq!(v["total"], 100);
    assert_eq!(v["total_explicit"], 60);
    assert_eq!(v["total_dependency"], 40);
}

#[test]
fn package_list_fixture_matches_struct_shape() {
    let fixture = parse_fixture(include_str!("../../test/fixtures/package-list.json"));

    assert_array(&fixture, "packages");
    assert_number(&fixture, "total");
    assert_number(&fixture, "total_explicit");
    assert_number(&fixture, "total_dependency");
    assert_array(&fixture, "repositories");
    assert_array(&fixture, "warnings");

    let first = &fixture["packages"][0];
    assert_string(first, "name");
    assert_string(first, "version");
    assert_string(first, "description");
    assert_number(first, "installed_size");
    assert_number(first, "install_date");
    assert_string(first, "reason");
    assert_string(first, "repository");

    let second = &fixture["packages"][1];
    assert_null(second, "description");
    assert_null(second, "install_date");
    assert_null(second, "repository");
}

// UpdateInfo / UpdatesResponse

#[test]
fn update_info_all_fields_present_and_typed() {
    let info = UpdateInfo {
        name: "linux".into(),
        current_version: "6.7.0-arch1-1".into(),
        new_version: "6.7.1-arch1-1".into(),
        download_size: 150_000_000,
        current_size: 142_000_000,
        new_size: 145_000_000,
        repository: "core".into(),
    };
    let v = to_json(&info);

    assert_string(&v, "name");
    assert_string(&v, "current_version");
    assert_string(&v, "new_version");
    assert_number(&v, "download_size");
    assert_number(&v, "current_size");
    assert_number(&v, "new_size");
    assert_string(&v, "repository");

    // repository is non-optional in UpdateInfo (unlike Package)
    assert_eq!(v["repository"], "core");
}

#[test]
fn updates_response_fixture_matches_struct_shape() {
    let fixture = parse_fixture(include_str!("../../test/fixtures/updates.json"));

    assert_array(&fixture, "updates");
    assert_array(&fixture, "warnings");

    let u = &fixture["updates"][0];
    assert_string(u, "name");
    assert_string(u, "current_version");
    assert_string(u, "new_version");
    assert_number(u, "download_size");
    assert_number(u, "current_size");
    assert_number(u, "new_size");
    assert_string(u, "repository");
}

// PackageDetails

#[test]
fn package_details_build_date_is_always_i64_not_null() {
    // Rust: pub build_date: i64 (non-optional, always present)
    // TypeScript: build_date: number | null (overly permissive - accepts null that never arrives)
    // This test documents the known drift: backend always emits an integer.
    let details = PackageDetails {
        name: "linux".into(),
        version: "6.7.0-arch1-1".into(),
        description: None,
        url: None,
        licenses: vec![],
        groups: vec![],
        provides: vec![],
        depends: vec![],
        optdepends: vec![],
        conflicts: vec![],
        replaces: vec![],
        required_by: vec![],
        optional_for: vec![],
        installed_size: 142_000_000,
        packager: None,
        architecture: None,
        build_date: 1_704_067_200,
        install_date: None,
        reason: "explicit".into(),
        validation: vec![],
        repository: None,
        update_stats: None,
    };
    let v = to_json(&details);

    assert_number(&v, "build_date");
    assert!(
        !v["build_date"].is_null(),
        "build_date is never null from backend"
    );
    assert_eq!(v["build_date"], 1_704_067_200i64);
}

#[test]
fn package_details_array_fields_always_present() {
    let details = PackageDetails {
        name: "test".into(),
        version: "1.0".into(),
        description: None,
        url: None,
        licenses: vec!["MIT".into()],
        groups: vec![],
        provides: vec![],
        depends: vec!["glibc".into()],
        optdepends: vec![],
        conflicts: vec![],
        replaces: vec![],
        required_by: vec![],
        optional_for: vec![],
        installed_size: 1024,
        packager: None,
        architecture: Some("x86_64".into()),
        build_date: 1_704_067_200,
        install_date: None,
        reason: "explicit".into(),
        validation: vec!["pgp".into()],
        repository: None,
        update_stats: None,
    };
    let v = to_json(&details);

    // All array fields are always present, even if empty
    assert_array(&v, "licenses");
    assert_array(&v, "groups");
    assert_array(&v, "provides");
    assert_array(&v, "depends");
    assert_array(&v, "optdepends");
    assert_array(&v, "conflicts");
    assert_array(&v, "replaces");
    assert_array(&v, "required_by");
    assert_array(&v, "optional_for");
    assert_array(&v, "validation");

    assert_null(&v, "update_stats");
    assert_null(&v, "install_date");
    assert_null(&v, "description");
    assert_null(&v, "url");
    assert_null(&v, "packager");
    assert_null(&v, "repository");
    assert_string(&v, "architecture");
}

#[test]
fn update_stats_nested_shape() {
    let details = PackageDetails {
        name: "test".into(),
        version: "1.0".into(),
        description: None,
        url: None,
        licenses: vec![],
        groups: vec![],
        provides: vec![],
        depends: vec![],
        optdepends: vec![],
        conflicts: vec![],
        replaces: vec![],
        required_by: vec![],
        optional_for: vec![],
        installed_size: 1024,
        packager: None,
        architecture: None,
        build_date: 1_704_067_200,
        install_date: None,
        reason: "explicit".into(),
        validation: vec![],
        repository: None,
        update_stats: Some(UpdateStats {
            update_count: 5,
            first_installed: Some("2023-01-01".into()),
            last_updated: Some("2024-01-01".into()),
            avg_days_between_updates: Some(73.2),
        }),
    };
    let v = to_json(&details);

    assert_object(&v, "update_stats");
    let stats = &v["update_stats"];
    assert_number(stats, "update_count");
    assert_string(stats, "first_installed");
    assert_string(stats, "last_updated");
    assert_number(stats, "avg_days_between_updates");

    assert_eq!(stats["update_count"], 5);
    assert_eq!(stats["avg_days_between_updates"], 73.2f64);
}

#[test]
fn package_detail_fixture_matches_struct_shape() {
    let fixture = parse_fixture(include_str!("../../test/fixtures/package-detail.json"));

    assert_string(&fixture, "name");
    assert_string(&fixture, "version");
    assert_string(&fixture, "description");
    assert_string(&fixture, "url");
    // build_date is a number (i64), never null
    assert_number(&fixture, "build_date");
    assert!(!fixture["build_date"].is_null());
    assert_number(&fixture, "install_date");
    assert_number(&fixture, "installed_size");
    assert_array(&fixture, "licenses");
    assert_array(&fixture, "depends");
    assert_array(&fixture, "optdepends");
    assert_string(&fixture, "reason");
    assert_string(&fixture, "repository");
    assert_null(&fixture, "update_stats");
}

// SearchResult / SearchResponse

#[test]
fn search_result_shape() {
    let result = SearchResult {
        name: "linux".into(),
        version: "6.7.1-arch1-1".into(),
        description: Some("The Linux kernel".into()),
        repository: "core".into(),
        installed: true,
        installed_version: Some("6.7.0-arch1-1".into()),
    };
    let v = to_json(&result);

    assert_string(&v, "name");
    assert_string(&v, "version");
    assert_string(&v, "description");
    assert_string(&v, "repository");
    assert_bool(&v, "installed");
    assert_string(&v, "installed_version");

    assert_eq!(v["installed"], true);
}

#[test]
fn search_result_not_installed_has_null_installed_version() {
    let result = SearchResult {
        name: "linux-lts".into(),
        version: "6.6.10-1".into(),
        description: None,
        repository: "core".into(),
        installed: false,
        installed_version: None,
    };
    let v = to_json(&result);

    assert_eq!(v["installed"], false);
    assert_null(&v, "installed_version");
    assert_null(&v, "description");
}

#[test]
fn search_response_has_all_count_fields() {
    let response = SearchResponse {
        results: vec![],
        total: 42,
        total_installed: 10,
        total_not_installed: 32,
        repositories: vec!["core".into()],
    };
    let v = to_json(&response);

    assert_number(&v, "total");
    assert_number(&v, "total_installed");
    assert_number(&v, "total_not_installed");
    assert_array(&v, "repositories");
    assert_array(&v, "results");

    assert_eq!(v["total"], 42);
    assert_eq!(v["total_installed"], 10);
    assert_eq!(v["total_not_installed"], 32);
}

#[test]
fn search_results_fixture_matches_struct_shape() {
    let fixture = parse_fixture(include_str!("../../test/fixtures/search-results.json"));

    assert_array(&fixture, "results");
    assert_number(&fixture, "total");
    assert_number(&fixture, "total_installed");
    assert_number(&fixture, "total_not_installed");
    assert_array(&fixture, "repositories");

    let installed = &fixture["results"][0];
    assert_bool(installed, "installed");
    assert_string(installed, "installed_version");
    assert_eq!(installed["installed"], true);

    let not_installed = &fixture["results"][1];
    assert_eq!(not_installed["installed"], false);
    assert_null(not_installed, "installed_version");
}

// SyncPackageDetails

#[test]
fn sync_package_details_has_download_size_not_install_date() {
    let details = SyncPackageDetails {
        name: "linux".into(),
        version: "6.7.1-arch1-1".into(),
        description: None,
        url: None,
        licenses: vec![],
        groups: vec![],
        provides: vec![],
        depends: vec![],
        optdepends: vec![],
        conflicts: vec![],
        replaces: vec![],
        download_size: 150_000_000,
        installed_size: 145_000_000,
        packager: None,
        architecture: None,
        build_date: 1_704_067_200,
        repository: "core".into(),
    };
    let v = to_json(&details);

    // SyncPackageDetails has download_size but NOT install_date/reason/validation
    assert_number(&v, "download_size");
    assert_number(&v, "installed_size");
    assert_number(&v, "build_date");
    assert_string(&v, "repository");
    assert!(
        v.get("install_date").is_none(),
        "SyncPackageDetails must not have install_date"
    );
    assert!(
        v.get("reason").is_none(),
        "SyncPackageDetails must not have reason"
    );
}

// PreflightResponse

#[test]
fn preflight_empty_optional_collections_are_absent() {
    // These fields use skip_serializing_if = "Vec::is_empty"
    // TS interface uses optional `?:` fields, so undefined is acceptable
    let response = PreflightResponse {
        success: true,
        error: None,
        conflicts: vec![],
        replacements: vec![],
        removals: vec![],
        providers: vec![],
        import_keys: vec![],
        warnings: vec![],
        packages_to_upgrade: 3,
        total_download_size: 150_000_000,
    };
    let v = to_json(&response);

    assert_bool(&v, "success");
    assert_number(&v, "packages_to_upgrade");
    assert_number(&v, "total_download_size");

    // All empty-collection fields are omitted entirely
    assert_absent(&v, "conflicts");
    assert_absent(&v, "replacements");
    assert_absent(&v, "removals");
    assert_absent(&v, "providers");
    assert_absent(&v, "import_keys");
    assert_absent(&v, "warnings");
    assert_absent(&v, "error");
}

#[test]
fn preflight_populated_optional_collections_are_present() {
    let response = PreflightResponse {
        success: true,
        error: None,
        conflicts: vec![ConflictInfo {
            package1: "mesa".into(),
            package2: "mesa-amber".into(),
        }],
        replacements: vec![ReplacementInfo {
            old_package: "libfoo".into(),
            new_package: "libfoo2".into(),
        }],
        removals: vec!["old-compat".into()],
        providers: vec![ProviderChoice {
            dependency: "sh".into(),
            providers: vec!["bash".into(), "dash".into()],
        }],
        import_keys: vec![KeyInfo {
            fingerprint: "ABCD1234".into(),
            uid: "Test <test@arch.org>".into(),
        }],
        warnings: vec![PreflightWarning {
            id: "warn-1".into(),
            severity: WarningSeverity::Warning,
            title: "Risk".into(),
            message: "Caution advised".into(),
            packages: vec!["mesa".into()],
        }],
        packages_to_upgrade: 2,
        total_download_size: 200_000_000,
    };
    let v = to_json(&response);

    assert_array(&v, "conflicts");
    assert_array(&v, "replacements");
    assert_array(&v, "removals");
    assert_array(&v, "providers");
    assert_array(&v, "import_keys");
    assert_array(&v, "warnings");

    // ConflictInfo shape
    let conflict = &v["conflicts"][0];
    assert_string(conflict, "package1");
    assert_string(conflict, "package2");

    // ReplacementInfo shape
    let replacement = &v["replacements"][0];
    assert_string(replacement, "old_package");
    assert_string(replacement, "new_package");

    // ProviderChoice shape
    let provider = &v["providers"][0];
    assert_string(provider, "dependency");
    assert_array(provider, "providers");

    // KeyInfo shape
    let key = &v["import_keys"][0];
    assert_string(key, "fingerprint");
    assert_string(key, "uid");

    // PreflightWarning shape
    let warning = &v["warnings"][0];
    assert_string(warning, "id");
    assert_string(warning, "severity");
    assert_string(warning, "title");
    assert_string(warning, "message");
    assert_array(warning, "packages");
}

#[test]
fn warning_severity_enum_serializes_lowercase() {
    // #[serde(rename_all = "lowercase")]
    assert_eq!(to_json(&WarningSeverity::Info), "info");
    assert_eq!(to_json(&WarningSeverity::Warning), "warning");
    assert_eq!(to_json(&WarningSeverity::Danger), "danger");
}

#[test]
fn preflight_fixture_min_shape() {
    // preflight.json has only the required fields (empty arrays omitted)
    let fixture = parse_fixture(include_str!("../../test/fixtures/preflight.json"));
    assert_bool(&fixture, "success");
    assert_number(&fixture, "packages_to_upgrade");
    assert_number(&fixture, "total_download_size");
    assert!(fixture.get("conflicts").is_none());
}

#[test]
fn preflight_with_data_fixture_has_all_optional_fields() {
    let fixture = parse_fixture(include_str!("../../test/fixtures/preflight-with-data.json"));
    assert_bool(&fixture, "success");
    assert_array(&fixture, "conflicts");
    assert_array(&fixture, "replacements");
    assert_array(&fixture, "removals");
    assert_array(&fixture, "providers");
    assert_array(&fixture, "import_keys");
    assert_array(&fixture, "warnings");

    let w = &fixture["warnings"][0];
    assert_string(w, "id");
    assert_string(w, "severity");
    assert!(["info", "warning", "danger"].contains(&w["severity"].as_str().unwrap()));
}

// StreamEvent

#[test]
fn stream_event_log_shape() {
    let event = StreamEvent::Log {
        level: "info".into(),
        message: "Starting upgrade".into(),
    };
    let v = to_json(&event);
    assert_eq!(v["type"], "log");
    assert_string(&v, "level");
    assert_string(&v, "message");
}

#[test]
fn stream_event_progress_shape() {
    let event = StreamEvent::Progress {
        operation: "upgrade".into(),
        package: "linux".into(),
        percent: 50,
        current: 1,
        total: 2,
    };
    let v = to_json(&event);
    assert_eq!(v["type"], "progress");
    assert_string(&v, "operation");
    assert_string(&v, "package");
    assert_number(&v, "percent");
    assert_number(&v, "current");
    assert_number(&v, "total");
    assert_eq!(v["percent"], 50);
}

#[test]
fn stream_event_download_optional_fields_absent_when_none() {
    let event = StreamEvent::Download {
        filename: "linux.pkg.tar.zst".into(),
        event: "started".into(),
        downloaded: None,
        total: None,
    };
    let v = to_json(&event);
    assert_eq!(v["type"], "download");
    assert_string(&v, "filename");
    assert_string(&v, "event");
    assert_absent(&v, "downloaded");
    assert_absent(&v, "total");
}

#[test]
fn stream_event_download_optional_fields_present_when_some() {
    let event = StreamEvent::Download {
        filename: "linux.pkg.tar.zst".into(),
        event: "progress".into(),
        downloaded: Some(75_000_000),
        total: Some(150_000_000),
    };
    let v = to_json(&event);
    assert_eq!(v["type"], "download");
    assert_number(&v, "downloaded");
    assert_number(&v, "total");
    assert_eq!(v["downloaded"], 75_000_000i64);
}

#[test]
fn stream_event_event_package_serializes_as_null_when_none() {
    // Event.package has no skip_serializing_if, so None → null (not absent)
    let event = StreamEvent::Event {
        event: "transaction_done".into(),
        package: None,
    };
    let v = to_json(&event);
    assert_eq!(v["type"], "event");
    assert_string(&v, "event");
    assert_null(&v, "package");
}

#[test]
fn stream_event_complete_message_serializes_as_null_when_none() {
    let event = StreamEvent::Complete {
        success: true,
        message: None,
    };
    let v = to_json(&event);
    assert_eq!(v["type"], "complete");
    assert_bool(&v, "success");
    assert_null(&v, "message");
}

#[test]
fn stream_event_mirror_test_shape() {
    let event = StreamEvent::MirrorTest {
        url: "https://mirror.example.com/".into(),
        current: 1,
        total: 3,
        result: MirrorTestResult {
            url: "https://mirror.example.com/".into(),
            success: true,
            speed_bps: Some(10_485_760),
            latency_ms: Some(48),
            error: None,
        },
    };
    let v = to_json(&event);
    assert_eq!(v["type"], "mirror_test");
    assert_string(&v, "url");
    assert_number(&v, "current");
    assert_number(&v, "total");
    assert_object(&v, "result");

    let result = &v["result"];
    assert_string(result, "url");
    assert_bool(result, "success");
    assert_number(result, "speed_bps");
    assert_number(result, "latency_ms");
    assert_null(result, "error");
}

#[test]
fn stream_events_fixture_has_correct_type_field() {
    let fixture = parse_fixture(include_str!("../../test/fixtures/stream-events.json"));
    let events = fixture.as_array().expect("fixture must be an array");

    let types: Vec<&str> = events
        .iter()
        .map(|e| {
            e["type"]
                .as_str()
                .expect("each event must have a string type")
        })
        .collect();

    assert!(types.contains(&"log"));
    assert!(types.contains(&"progress"));
    assert!(types.contains(&"download"));
    assert!(types.contains(&"event"));
    assert!(types.contains(&"mirror_test"));
    assert!(types.contains(&"complete"));
}

// KeyringStatusResponse

#[test]
fn keyring_key_nullable_fields() {
    let key = KeyringKey {
        fingerprint: "ABCDEF1234567890ABCDEF1234567890ABCDEF12".into(),
        uid: "Arch Linux <key@archlinux.org>".into(),
        created: Some("2023-01-01".into()),
        expires: None,
        trust: "full".into(),
    };
    let v = to_json(&key);

    assert_string(&v, "fingerprint");
    assert_string(&v, "uid");
    assert_string(&v, "created");
    assert_null(&v, "expires");
    assert_string(&v, "trust");
}

#[test]
fn keyring_status_response_shape() {
    let response = KeyringStatusResponse {
        keys: vec![],
        total: 42,
        master_key_initialized: true,
        warnings: vec![],
    };
    let v = to_json(&response);

    assert_array(&v, "keys");
    assert_number(&v, "total");
    assert_bool(&v, "master_key_initialized");
    assert_array(&v, "warnings");
}

#[test]
fn keyring_status_fixture_matches_struct_shape() {
    let fixture = parse_fixture(include_str!("../../test/fixtures/keyring-status.json"));

    assert_array(&fixture, "keys");
    assert_number(&fixture, "total");
    assert_bool(&fixture, "master_key_initialized");

    let key = &fixture["keys"][0];
    assert_string(key, "fingerprint");
    assert_string(key, "uid");
    assert_string(key, "created");
    assert_null(key, "expires");
    assert_string(key, "trust");
}

// Mirrors

#[test]
fn mirror_entry_shape() {
    let entry = MirrorEntry {
        url: "https://mirror.example.com/$repo/os/$arch".into(),
        enabled: true,
        comment: None,
    };
    let v = to_json(&entry);

    assert_string(&v, "url");
    assert_bool(&v, "enabled");
    assert_null(&v, "comment");
}

#[test]
fn mirror_list_response_last_modified_nullable() {
    let response = MirrorListResponse {
        mirrors: vec![],
        total: 0,
        enabled_count: 0,
        path: "/etc/pacman.d/mirrorlist".into(),
        last_modified: None,
    };
    let v = to_json(&response);

    assert_null(&v, "last_modified");
    assert_string(&v, "path");
    assert_number(&v, "total");
    assert_number(&v, "enabled_count");
}

#[test]
fn mirror_status_all_optional_fields_nullable() {
    let status = MirrorStatus {
        url: "https://mirror.example.com/".into(),
        country: None,
        country_code: None,
        last_sync: None,
        delay: None,
        score: None,
        completion_pct: None,
        active: false,
        ipv4: true,
        ipv6: false,
    };
    let v = to_json(&status);

    assert_string(&v, "url");
    assert_null(&v, "country");
    assert_null(&v, "country_code");
    assert_null(&v, "last_sync");
    assert_null(&v, "delay");
    assert_null(&v, "score");
    assert_null(&v, "completion_pct");
    assert_bool(&v, "active");
    assert_bool(&v, "ipv4");
    assert_bool(&v, "ipv6");
}

#[test]
fn mirror_list_fixture_matches_struct_shape() {
    let fixture = parse_fixture(include_str!("../../test/fixtures/mirror-list.json"));

    assert_array(&fixture, "mirrors");
    assert_number(&fixture, "total");
    assert_number(&fixture, "enabled_count");
    assert_string(&fixture, "path");
    assert_number(&fixture, "last_modified");

    let enabled = &fixture["mirrors"][0];
    assert_string(enabled, "url");
    assert_bool(enabled, "enabled");
    assert_null(enabled, "comment");
    assert_eq!(enabled["enabled"], true);

    let disabled = &fixture["mirrors"][1];
    assert_eq!(disabled["enabled"], false);
    assert_string(disabled, "comment");
}

#[test]
fn mirror_status_fixture_matches_struct_shape() {
    let fixture = parse_fixture(include_str!("../../test/fixtures/mirror-status.json"));

    assert_array(&fixture, "mirrors");
    assert_number(&fixture, "total");
    assert_string(&fixture, "last_check");

    let populated = &fixture["mirrors"][0];
    assert_string(populated, "url");
    assert_string(populated, "country");
    assert_string(populated, "country_code");
    assert_string(populated, "last_sync");
    assert_number(populated, "delay");
    assert_number(populated, "score");
    assert_number(populated, "completion_pct");
    assert_bool(populated, "active");
    assert_bool(populated, "ipv4");
    assert_bool(populated, "ipv6");

    let sparse = &fixture["mirrors"][1];
    assert_null(sparse, "last_sync");
    assert_null(sparse, "delay");
    assert_null(sparse, "score");
    assert_null(sparse, "completion_pct");
}

// SecurityResponse

#[test]
fn security_advisory_fixed_version_absent_when_none() {
    // DRIFT: fixed_version uses skip_serializing_if = "Option::is_none"
    // Rust: absent from JSON when no fix exists
    // TypeScript: `fixed_version: string | null` — should be `fixed_version?: string | null`
    // Result: advisory.fixed_version is `undefined`, not `null`, when unfixed
    let advisory = PackageSecurityAdvisory {
        package: "openssl".into(),
        severity: "High".into(),
        advisory_type: "multiple issues".into(),
        avg_name: "AVG-2024-1234".into(),
        cve_ids: vec!["CVE-2024-0001".into()],
        fixed_version: None,
        status: "Vulnerable".into(),
    };
    let v = to_json(&advisory);

    assert_string(&v, "package");
    assert_string(&v, "severity");
    assert_string(&v, "advisory_type");
    assert_string(&v, "avg_name");
    assert_array(&v, "cve_ids");
    assert_string(&v, "status");
    // When None, fixed_version is ABSENT (not null) due to skip_serializing_if
    assert_absent(&v, "fixed_version");
}

#[test]
fn security_advisory_fixed_version_present_when_some() {
    let advisory = PackageSecurityAdvisory {
        package: "curl".into(),
        severity: "Medium".into(),
        advisory_type: "info disclosure".into(),
        avg_name: "AVG-2024-5678".into(),
        cve_ids: vec![],
        fixed_version: Some("8.5.0-1".into()),
        status: "Fixed".into(),
    };
    let v = to_json(&advisory);
    assert_string(&v, "fixed_version");
    assert_eq!(v["fixed_version"], "8.5.0-1");
}

#[test]
fn security_advisories_fixture_documents_absent_vs_present_fixed_version() {
    let fixture = parse_fixture(include_str!("../../test/fixtures/security-advisories.json"));
    assert_array(&fixture, "advisories");

    // First advisory has no fixed_version (absent, not null)
    let unfixed = &fixture["advisories"][0];
    assert_string(unfixed, "package");
    assert_string(unfixed, "status");
    assert!(
        unfixed.get("fixed_version").is_none(),
        "unfixed advisory must omit fixed_version entirely"
    );

    // Second advisory has fixed_version present
    let fixed = &fixture["advisories"][1];
    assert_string(fixed, "fixed_version");
}

// LogEntry / GroupedLogResponse

#[test]
fn log_entry_old_new_version_nullable() {
    let installed = LogEntry {
        timestamp: "2024-01-01T10:00:00+0000".into(),
        action: "installed".into(),
        package: "neovim".into(),
        old_version: None,
        new_version: Some("0.9.5-1".into()),
    };
    let v = to_json(&installed);
    assert_null(&v, "old_version");
    assert_string(&v, "new_version");

    let removed = LogEntry {
        timestamp: "2024-01-01T10:01:00+0000".into(),
        action: "removed".into(),
        package: "vim".into(),
        old_version: Some("9.0-1".into()),
        new_version: None,
    };
    let v = to_json(&removed);
    assert_string(&v, "old_version");
    assert_null(&v, "new_version");
}

#[test]
fn log_group_all_count_fields_present() {
    let group = LogGroup {
        id: "group-0".into(),
        start_time: "2024-01-01T10:00:00+0000".into(),
        end_time: "2024-01-01T10:05:00+0000".into(),
        entries: vec![],
        upgraded_count: 3,
        installed_count: 1,
        removed_count: 0,
        downgraded_count: 0,
        reinstalled_count: 2,
    };
    let v = to_json(&group);

    assert_string(&v, "id");
    assert_string(&v, "start_time");
    assert_string(&v, "end_time");
    assert_array(&v, "entries");
    assert_number(&v, "upgraded_count");
    assert_number(&v, "installed_count");
    assert_number(&v, "removed_count");
    assert_number(&v, "downgraded_count");
    assert_number(&v, "reinstalled_count");
}

#[test]
fn grouped_log_response_shape() {
    let response = GroupedLogResponse {
        groups: vec![],
        total_groups: 5,
        total_upgraded: 12,
        total_installed: 3,
        total_removed: 1,
        total_other: 0,
    };
    let v = to_json(&response);

    assert_array(&v, "groups");
    assert_number(&v, "total_groups");
    assert_number(&v, "total_upgraded");
    assert_number(&v, "total_installed");
    assert_number(&v, "total_removed");
    assert_number(&v, "total_other");
}

#[test]
fn log_history_fixture_matches_struct_shape() {
    let fixture = parse_fixture(include_str!("../../test/fixtures/log-history.json"));

    assert_array(&fixture, "groups");
    assert_number(&fixture, "total_groups");
    assert_number(&fixture, "total_upgraded");
    assert_number(&fixture, "total_installed");
    assert_number(&fixture, "total_removed");
    assert_number(&fixture, "total_other");

    let group = &fixture["groups"][0];
    assert_string(group, "id");
    assert_string(group, "start_time");
    assert_string(group, "end_time");
    assert_array(group, "entries");
    assert_number(group, "upgraded_count");
    assert_number(group, "installed_count");
    assert_number(group, "removed_count");
    assert_number(group, "downgraded_count");
    assert_number(group, "reinstalled_count");

    let upgraded = &group["entries"][0];
    assert_string(upgraded, "old_version");
    assert_string(upgraded, "new_version");

    // "installed" entries live in the second group
    let install_group = &fixture["groups"][1];
    let installed = &install_group["entries"][0];
    assert!(
        installed.get("old_version").is_some_and(|v| v.is_null()),
        "installed entry must have old_version: null"
    );
}

// RebootStatus

#[test]
fn reboot_status_shape() {
    let status = RebootStatus {
        requires_reboot: true,
        reason: "kernel_update".into(),
        running_kernel: Some("6.6.9-1".into()),
        installed_kernel: Some("6.7.0.arch1-1".into()),
        kernel_package: Some("linux".into()),
        updated_packages: vec!["linux".into()],
    };
    let v = to_json(&status);

    assert_bool(&v, "requires_reboot");
    assert_string(&v, "reason");
    assert_string(&v, "running_kernel");
    assert_string(&v, "installed_kernel");
    assert_string(&v, "kernel_package");
    assert_array(&v, "updated_packages");

    assert_eq!(v["requires_reboot"], true);
    assert_eq!(v["reason"], "kernel_update");
}

#[test]
fn reboot_status_kernel_fields_nullable() {
    let status = RebootStatus {
        requires_reboot: false,
        reason: "none".into(),
        running_kernel: None,
        installed_kernel: None,
        kernel_package: None,
        updated_packages: vec![],
    };
    let v = to_json(&status);

    assert_null(&v, "running_kernel");
    assert_null(&v, "installed_kernel");
    assert_null(&v, "kernel_package");
}

#[test]
fn reboot_status_fixture_matches_struct_shape() {
    let fixture = parse_fixture(include_str!("../../test/fixtures/reboot-status.json"));

    assert_bool(&fixture, "requires_reboot");
    assert_string(&fixture, "reason");
    assert_string(&fixture, "running_kernel");
    assert_string(&fixture, "installed_kernel");
    assert_string(&fixture, "kernel_package");
    assert_array(&fixture, "updated_packages");
}

// CacheInfo

#[test]
fn cache_info_shape() {
    let info = CacheInfo {
        total_size: 524_288_000,
        package_count: 3,
        packages: vec![CachePackage {
            name: "linux".into(),
            version: "6.7.0-arch1-1".into(),
            filename: "linux-6.7.0.arch1-1-x86_64.pkg.tar.zst".into(),
            size: 142_000_000,
        }],
        path: "/var/cache/pacman/pkg".into(),
    };
    let v = to_json(&info);

    assert_number(&v, "total_size");
    assert_number(&v, "package_count");
    assert_array(&v, "packages");
    assert_string(&v, "path");

    let pkg = &v["packages"][0];
    assert_string(pkg, "name");
    assert_string(pkg, "version");
    assert_string(pkg, "filename");
    assert_number(pkg, "size");
}

#[test]
fn cache_info_fixture_matches_struct_shape() {
    let fixture = parse_fixture(include_str!("../../test/fixtures/cache-info.json"));

    assert_number(&fixture, "total_size");
    assert_number(&fixture, "package_count");
    assert_array(&fixture, "packages");
    assert_string(&fixture, "path");

    let pkg = &fixture["packages"][0];
    assert_string(pkg, "name");
    assert_string(pkg, "version");
    assert_string(pkg, "filename");
    assert_number(pkg, "size");
}

// DependencyTreeResponse

#[test]
fn dependency_node_shape() {
    let node = DependencyNode {
        id: "linux".into(),
        name: "linux".into(),
        version: "6.7.0-arch1-1".into(),
        depth: 0,
        installed: true,
        reason: Some("explicit".into()),
        repository: Some("core".into()),
    };
    let v = to_json(&node);

    assert_string(&v, "id");
    assert_string(&v, "name");
    assert_string(&v, "version");
    assert_number(&v, "depth");
    assert_bool(&v, "installed");
    assert_string(&v, "reason");
    assert_string(&v, "repository");
    assert_eq!(v["depth"], 0);
}

#[test]
fn dependency_node_optional_fields_nullable() {
    let node = DependencyNode {
        id: "zlib".into(),
        name: "zlib".into(),
        version: "1.3.1-1".into(),
        depth: 2,
        installed: true,
        reason: None,
        repository: None,
    };
    let v = to_json(&node);
    assert_null(&v, "reason");
    assert_null(&v, "repository");
}

#[test]
fn dependency_edge_shape() {
    let edge = DependencyEdge {
        source: "linux".into(),
        target: "kmod".into(),
        edge_type: "depends".into(),
    };
    let v = to_json(&edge);
    assert_string(&v, "source");
    assert_string(&v, "target");
    assert_string(&v, "edge_type");
}

#[test]
fn dependency_tree_fixture_matches_struct_shape() {
    let fixture = parse_fixture(include_str!("../../test/fixtures/dependency-tree.json"));

    assert_array(&fixture, "nodes");
    assert_array(&fixture, "edges");
    assert_string(&fixture, "root");
    assert_bool(&fixture, "max_depth_reached");
    assert_array(&fixture, "warnings");

    let node_with_reason = &fixture["nodes"][0];
    assert_string(node_with_reason, "reason");
    assert_string(node_with_reason, "repository");

    let node_without_reason = &fixture["nodes"][2];
    assert_null(node_without_reason, "reason");
    assert_null(node_without_reason, "repository");

    let edge = &fixture["edges"][0];
    assert_string(edge, "source");
    assert_string(edge, "target");
    assert_string(edge, "edge_type");
}

// VersionMatch enum

#[test]
fn version_match_enum_serializes_snake_case() {
    // #[serde(rename_all = "snake_case")]
    assert_eq!(to_json(&VersionMatch::Match), "match");
    assert_eq!(to_json(&VersionMatch::Mismatch), "mismatch");
    assert_eq!(to_json(&VersionMatch::NotInstalled), "not_installed");
}

// ScheduledRunEntry

#[test]
fn scheduled_run_entry_error_nullable() {
    let entry = ScheduledRunEntry {
        timestamp: "2024-01-01T03:00:00+0000".into(),
        mode: "upgrade".into(),
        success: true,
        packages_checked: 100,
        packages_upgraded: 5,
        error: None,
        details: vec!["linux upgraded".into()],
    };
    let v = to_json(&entry);

    assert_string(&v, "timestamp");
    assert_string(&v, "mode");
    assert_bool(&v, "success");
    assert_number(&v, "packages_checked");
    assert_number(&v, "packages_upgraded");
    assert_null(&v, "error");
    assert_array(&v, "details");
}

// OrphanResponse

#[test]
fn orphan_package_shape() {
    let pkg = OrphanPackage {
        name: "old-lib".into(),
        version: "2.1-1".into(),
        description: Some("An old library".into()),
        installed_size: 5_000_000,
        install_date: Some(1_600_000_000),
        repository: None,
    };
    let v = to_json(&pkg);

    assert_string(&v, "name");
    assert_string(&v, "version");
    assert_string(&v, "description");
    assert_number(&v, "installed_size");
    assert_number(&v, "install_date");
    assert_null(&v, "repository");

    let response = OrphanResponse {
        orphans: vec![],
        total_size: 5_000_000,
    };
    let rv = to_json(&response);
    assert_array(&rv, "orphans");
    assert_number(&rv, "total_size");
}

// SaveMirrorlistResponse / RefreshMirrorsResponse

#[test]
fn save_mirrorlist_response_shape() {
    let resp = SaveMirrorlistResponse {
        success: true,
        backup_path: Some("/etc/pacman.d/mirrorlist.bak".into()),
        message: "Saved successfully".into(),
    };
    let v = to_json(&resp);
    assert_bool(&v, "success");
    assert_string(&v, "backup_path");
    assert_string(&v, "message");

    let failed = SaveMirrorlistResponse {
        success: false,
        backup_path: None,
        message: "Failed to write".into(),
    };
    let fv = to_json(&failed);
    assert_null(&fv, "backup_path");
}

#[test]
fn refresh_mirrors_response_shape() {
    let resp = RefreshMirrorsResponse {
        mirrors: vec![],
        total: 0,
        last_check: None,
    };
    let v = to_json(&resp);
    assert_array(&v, "mirrors");
    assert_number(&v, "total");
    assert_null(&v, "last_check");
}

#[test]
fn restore_mirror_backup_response_shape() {
    let resp = RestoreMirrorBackupResponse {
        success: true,
        backup_path: Some("/var/backups/mirrorlist.1704067200".into()),
        message: "Restored".into(),
    };
    let v = to_json(&resp);
    assert_bool(&v, "success");
    assert_string(&v, "backup_path");
    assert_string(&v, "message");
}

// SecurityInfoResponse

#[test]
fn security_info_response_shape() {
    let resp = SecurityInfoResponse {
        name: "openssl".into(),
        advisories: vec![SecurityInfoAdvisory {
            name: "AVG-2024-1234".into(),
            date: "2024-01-15".into(),
            severity: "High".into(),
            advisory_type: "multiple issues".into(),
        }],
        groups: vec![SecurityInfoGroup {
            name: "openssl".into(),
            status: "Fixed".into(),
            severity: "High".into(),
        }],
        issues: vec![SecurityInfoIssue {
            name: "CVE-2024-0001".into(),
            severity: "High".into(),
            issue_type: "arbitrary code execution".into(),
            status: "Fixed".into(),
        }],
    };
    let v = to_json(&resp);

    assert_string(&v, "name");
    assert_array(&v, "advisories");
    assert_array(&v, "groups");
    assert_array(&v, "issues");

    let advisory = &v["advisories"][0];
    assert_string(advisory, "name");
    assert_string(advisory, "date");
    assert_string(advisory, "severity");
    assert_string(advisory, "advisory_type");

    let issue = &v["issues"][0];
    assert_string(issue, "name");
    assert_string(issue, "severity");
    assert_string(issue, "issue_type");
    assert_string(issue, "status");
}

// NewsResponse

#[test]
fn news_response_shape() {
    let resp = NewsResponse {
        items: vec![NewsItem {
            title: "grub 2.12-3 requires manual intervention".into(),
            link: "https://archlinux.org/news/grub/".into(),
            published: "2024-02-01T00:00:00+00:00".into(),
            summary: "Users of grub need to reinstall grub.".into(),
        }],
    };
    let v = to_json(&resp);

    assert_array(&v, "items");
    let item = &v["items"][0];
    assert_string(item, "title");
    assert_string(item, "link");
    assert_string(item, "published");
    assert_string(item, "summary");
}

// ScheduledRunsResponse

#[test]
fn scheduled_runs_response_shape() {
    let resp = ScheduledRunsResponse {
        runs: vec![],
        total: 0,
    };
    let v = to_json(&resp);
    assert_array(&v, "runs");
    assert_number(&v, "total");
}

// Each test deserializes the shared fixture directly into the Rust type.
// This catches field renames that Value-level shape checks miss: e.g. if a
// struct gains `#[serde(rename = "newName")]` but the fixture still has the
// old name, from_str will return Err and .unwrap() will panic.

#[test]
fn package_list_fixture_round_trip() {
    serde_json::from_str::<PackageListResponse>(include_str!(
        "../../test/fixtures/package-list.json"
    ))
    .unwrap();
}

#[test]
fn package_detail_fixture_round_trip() {
    serde_json::from_str::<PackageDetails>(include_str!("../../test/fixtures/package-detail.json"))
        .unwrap();
}

#[test]
fn updates_fixture_round_trip() {
    serde_json::from_str::<UpdatesResponse>(include_str!("../../test/fixtures/updates.json"))
        .unwrap();
}

#[test]
fn search_results_fixture_round_trip() {
    serde_json::from_str::<SearchResponse>(include_str!("../../test/fixtures/search-results.json"))
        .unwrap();
}

#[test]
fn preflight_fixture_round_trip() {
    serde_json::from_str::<PreflightResponse>(include_str!("../../test/fixtures/preflight.json"))
        .unwrap();
}

#[test]
fn preflight_with_data_fixture_round_trip() {
    serde_json::from_str::<PreflightResponse>(include_str!(
        "../../test/fixtures/preflight-with-data.json"
    ))
    .unwrap();
}

#[test]
fn mirror_list_fixture_round_trip() {
    serde_json::from_str::<MirrorListResponse>(include_str!(
        "../../test/fixtures/mirror-list.json"
    ))
    .unwrap();
}

#[test]
fn mirror_status_fixture_round_trip() {
    serde_json::from_str::<MirrorStatusResponse>(include_str!(
        "../../test/fixtures/mirror-status.json"
    ))
    .unwrap();
}

#[test]
fn security_advisories_fixture_round_trip() {
    serde_json::from_str::<SecurityResponse>(include_str!(
        "../../test/fixtures/security-advisories.json"
    ))
    .unwrap();
}

#[test]
fn log_history_fixture_round_trip() {
    serde_json::from_str::<GroupedLogResponse>(include_str!(
        "../../test/fixtures/log-history.json"
    ))
    .unwrap();
}

#[test]
fn reboot_status_fixture_round_trip() {
    serde_json::from_str::<RebootStatus>(include_str!("../../test/fixtures/reboot-status.json"))
        .unwrap();
}

#[test]
fn cache_info_fixture_round_trip() {
    serde_json::from_str::<CacheInfo>(include_str!("../../test/fixtures/cache-info.json")).unwrap();
}

#[test]
fn keyring_status_fixture_round_trip() {
    serde_json::from_str::<KeyringStatusResponse>(include_str!(
        "../../test/fixtures/keyring-status.json"
    ))
    .unwrap();
}

#[test]
fn dependency_tree_fixture_round_trip() {
    serde_json::from_str::<DependencyTreeResponse>(include_str!(
        "../../test/fixtures/dependency-tree.json"
    ))
    .unwrap();
}

#[test]
fn stream_events_fixture_round_trip() {
    serde_json::from_str::<Vec<StreamEvent>>(include_str!(
        "../../test/fixtures/stream-events.json"
    ))
    .unwrap();
}

// OrphanResponse

#[test]
fn orphans_fixture_matches_struct_shape() {
    let fixture = parse_fixture(include_str!("../../test/fixtures/orphans.json"));

    assert_array(&fixture, "orphans");
    assert_number(&fixture, "total_size");

    let populated = &fixture["orphans"][0];
    assert_string(populated, "name");
    assert_string(populated, "version");
    assert_string(populated, "description");
    assert_number(populated, "installed_size");
    assert_number(populated, "install_date");
    assert_string(populated, "repository");

    // Second entry covers null/sparse case
    let sparse = &fixture["orphans"][1];
    assert_null(sparse, "description");
    assert_null(sparse, "install_date");
    assert_null(sparse, "repository");
}

#[test]
fn orphans_fixture_round_trip() {
    serde_json::from_str::<OrphanResponse>(include_str!("../../test/fixtures/orphans.json"))
        .unwrap();
}

// SaveMirrorlistResponse

#[test]
fn save_mirrorlist_fixture_matches_struct_shape() {
    let fixture = parse_fixture(include_str!("../../test/fixtures/save-mirrorlist.json"));

    assert_bool(&fixture, "success");
    assert_string(&fixture, "backup_path");
    assert_string(&fixture, "message");
    assert_eq!(fixture["success"], true);
}

#[test]
fn save_mirrorlist_fixture_round_trip() {
    serde_json::from_str::<SaveMirrorlistResponse>(include_str!(
        "../../test/fixtures/save-mirrorlist.json"
    ))
    .unwrap();
}

// RefreshMirrorsResponse

#[test]
fn refresh_mirrors_fixture_matches_struct_shape() {
    let fixture = parse_fixture(include_str!("../../test/fixtures/refresh-mirrors.json"));

    assert_array(&fixture, "mirrors");
    assert_number(&fixture, "total");
    assert_string(&fixture, "last_check");

    let m = &fixture["mirrors"][0];
    assert_string(m, "url");
    assert_bool(m, "enabled");
    assert_null(m, "comment");

    let with_comment = &fixture["mirrors"][1];
    assert_string(with_comment, "comment");
}

#[test]
fn refresh_mirrors_fixture_round_trip() {
    serde_json::from_str::<RefreshMirrorsResponse>(include_str!(
        "../../test/fixtures/refresh-mirrors.json"
    ))
    .unwrap();
}

// RestoreMirrorBackupResponse

#[test]
fn restore_mirror_backup_fixture_matches_struct_shape() {
    let fixture = parse_fixture(include_str!(
        "../../test/fixtures/restore-mirror-backup.json"
    ));

    assert_bool(&fixture, "success");
    assert_string(&fixture, "backup_path");
    assert_string(&fixture, "message");
    assert_eq!(fixture["success"], true);
}

#[test]
fn restore_mirror_backup_fixture_round_trip() {
    serde_json::from_str::<RestoreMirrorBackupResponse>(include_str!(
        "../../test/fixtures/restore-mirror-backup.json"
    ))
    .unwrap();
}

// SecurityInfoResponse

#[test]
fn security_info_fixture_matches_struct_shape() {
    let fixture = parse_fixture(include_str!("../../test/fixtures/security-info.json"));

    assert_string(&fixture, "name");
    assert_array(&fixture, "advisories");
    assert_array(&fixture, "groups");
    assert_array(&fixture, "issues");

    let advisory = &fixture["advisories"][0];
    assert_string(advisory, "name");
    assert_string(advisory, "date");
    assert_string(advisory, "severity");
    assert_string(advisory, "advisory_type");

    let group = &fixture["groups"][0];
    assert_string(group, "name");
    assert_string(group, "status");
    assert_string(group, "severity");

    let issue = &fixture["issues"][0];
    assert_string(issue, "name");
    assert_string(issue, "severity");
    assert_string(issue, "issue_type");
    assert_string(issue, "status");
}

#[test]
fn security_info_fixture_round_trip() {
    serde_json::from_str::<SecurityInfoResponse>(include_str!(
        "../../test/fixtures/security-info.json"
    ))
    .unwrap();
}

// NewsResponse

#[test]
fn news_fixture_matches_struct_shape() {
    let fixture = parse_fixture(include_str!("../../test/fixtures/news.json"));

    assert_array(&fixture, "items");

    let item = &fixture["items"][0];
    assert_string(item, "title");
    assert_string(item, "link");
    assert_string(item, "published");
    assert_string(item, "summary");
}

#[test]
fn news_fixture_round_trip() {
    serde_json::from_str::<NewsResponse>(include_str!("../../test/fixtures/news.json")).unwrap();
}

// ScheduledRunsResponse

#[test]
fn scheduled_runs_fixture_matches_struct_shape() {
    let fixture = parse_fixture(include_str!("../../test/fixtures/scheduled-runs.json"));

    assert_array(&fixture, "runs");
    assert_number(&fixture, "total");

    // First run: successful, error is null
    let success_run = &fixture["runs"][0];
    assert_string(success_run, "timestamp");
    assert_string(success_run, "mode");
    assert_bool(success_run, "success");
    assert_number(success_run, "packages_checked");
    assert_number(success_run, "packages_upgraded");
    assert_null(success_run, "error");
    assert_array(success_run, "details");
    assert_eq!(success_run["success"], true);

    // Second run: failed, error is a string
    let failed_run = &fixture["runs"][1];
    assert_string(failed_run, "error");
    assert_eq!(failed_run["success"], false);
}

#[test]
fn scheduled_runs_fixture_round_trip() {
    serde_json::from_str::<ScheduledRunsResponse>(include_str!(
        "../../test/fixtures/scheduled-runs.json"
    ))
    .unwrap();
}

// SyncPackageDetails

#[test]
fn sync_package_detail_fixture_matches_struct_shape() {
    let fixture = parse_fixture(include_str!("../../test/fixtures/sync-package-detail.json"));

    assert_string(&fixture, "name");
    assert_string(&fixture, "version");
    assert_string(&fixture, "description");
    assert_string(&fixture, "url");
    assert_array(&fixture, "licenses");
    assert_array(&fixture, "groups");
    assert_array(&fixture, "provides");
    assert_array(&fixture, "depends");
    assert_array(&fixture, "optdepends");
    assert_array(&fixture, "conflicts");
    assert_array(&fixture, "replaces");
    assert_number(&fixture, "download_size");
    assert_number(&fixture, "installed_size");
    assert_string(&fixture, "packager");
    assert_string(&fixture, "architecture");
    assert_number(&fixture, "build_date");
    assert_string(&fixture, "repository");

    // SyncPackageDetails has download_size but NOT install_date or reason
    assert!(
        fixture.get("install_date").is_none(),
        "sync package detail must not have install_date"
    );
    assert!(
        fixture.get("reason").is_none(),
        "sync package detail must not have reason"
    );
}

#[test]
fn sync_package_detail_fixture_round_trip() {
    serde_json::from_str::<SyncPackageDetails>(include_str!(
        "../../test/fixtures/sync-package-detail.json"
    ))
    .unwrap();
}

#[test]
fn services_status_shape() {
    let status = ServicesStatus {
        restart_required: true,
        services: vec![ServiceRestart {
            name: "nginx.service".into(),
            pid: 1234,
            affected_packages: vec!["openssl".into(), "pcre2".into()],
            reason: "deleted_mappings".into(),
            restart_blocked: None,
        }],
    };
    let v = to_json(&status);

    assert_bool(&v, "restart_required");
    assert_array(&v, "services");
    assert_eq!(v["restart_required"], true);

    let svc = &v["services"][0];
    assert_string(svc, "name");
    assert_number(svc, "pid");
    assert_array(svc, "affected_packages");
    assert_string(svc, "reason");

    assert_eq!(svc["name"], "nginx.service");
    assert_eq!(svc["pid"], 1234);
    assert_eq!(svc["reason"], "deleted_mappings");
    assert!(
        svc.get("restart_blocked").is_none_or(|v| v.is_null()),
        "restart_blocked should be omitted when None"
    );
}

#[test]
fn service_restart_blocked_field_serializes_each_variant() {
    for (variant, expected) in [
        (RestartBlocked::SessionCritical, "session_critical"),
        (RestartBlocked::CockpitSession, "cockpit_session"),
        (RestartBlocked::CockpitTransport, "cockpit_transport"),
    ] {
        let svc = ServiceRestart {
            name: "x.service".into(),
            pid: 42,
            affected_packages: vec![],
            reason: "deleted_mappings".into(),
            restart_blocked: Some(variant),
        };
        assert_eq!(to_json(&svc)["restart_blocked"], expected);
    }
}

#[test]
fn services_status_fixture_matches_struct_shape() {
    let fixture = parse_fixture(include_str!("../../test/fixtures/services-status.json"));

    let empty = &fixture["empty"];
    assert_bool(empty, "restart_required");
    assert_array(empty, "services");
    assert_eq!(empty["restart_required"], false);
    assert_eq!(empty["services"].as_array().unwrap().len(), 0);

    let two = &fixture["two-services"];
    assert_bool(two, "restart_required");
    assert_array(two, "services");
    assert_eq!(two["restart_required"], true);

    let svc = &two["services"][0];
    assert_string(svc, "name");
    assert_number(svc, "pid");
    assert_array(svc, "affected_packages");
    assert_string(svc, "reason");

    // Service with no affected packages (unowned deleted mappings) is still included.
    let no_pkgs = &two["services"][1];
    assert_eq!(no_pkgs["affected_packages"].as_array().unwrap().len(), 0);
}

#[test]
fn services_status_empty_fixture_round_trip() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../test/fixtures/services-status.json")).unwrap();
    serde_json::from_value::<ServicesStatus>(fixture["empty"].clone()).unwrap();
}

#[test]
fn services_status_two_services_fixture_round_trip() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../test/fixtures/services-status.json")).unwrap();
    serde_json::from_value::<ServicesStatus>(fixture["two-services"].clone()).unwrap();
}
