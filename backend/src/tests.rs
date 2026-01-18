use crate::models::{
    Package, PackageDetails, PackageListResponse, SearchResult, UpdateInfo, UpdatesResponse,
};
use crate::util::parse_package_filename;
use crate::validation::{
    validate_keep_versions, validate_package_name, validate_pagination, validate_search_query,
};

// --- Serialization tests ---

#[test]
fn test_package_serialization() {
    let pkg = Package {
        name: "linux".to_string(),
        version: "6.7.0-arch1-1".to_string(),
        description: Some("The Linux kernel".to_string()),
        installed_size: 150_000_000,
        install_date: Some(1704067200),
        reason: "explicit".to_string(),
        repository: Some("core".to_string()),
    };

    let json = serde_json::to_string(&pkg).unwrap();
    assert!(json.contains("\"name\":\"linux\""));
    assert!(json.contains("\"version\":\"6.7.0-arch1-1\""));
    assert!(json.contains("\"reason\":\"explicit\""));
}

#[test]
fn test_package_list_response_serialization() {
    let response = PackageListResponse {
        packages: vec![],
        total: 100,
        total_explicit: 60,
        total_dependency: 40,
        repositories: vec!["core".to_string(), "extra".to_string()],
        warnings: vec![],
    };

    let json = serde_json::to_string(&response).unwrap();
    assert!(json.contains("\"total\":100"));
    assert!(json.contains("\"total_explicit\":60"));
    assert!(json.contains("\"total_dependency\":40"));
}

#[test]
fn test_updates_response_serialization() {
    let response = UpdatesResponse {
        updates: vec![UpdateInfo {
            name: "linux".to_string(),
            current_version: "6.7.0-arch1-1".to_string(),
            new_version: "6.7.1-arch1-1".to_string(),
            download_size: 150_000_000,
            current_size: 140_000_000,
            new_size: 145_000_000,
            repository: "core".to_string(),
        }],
        warnings: vec![],
    };

    let json = serde_json::to_string(&response).unwrap();
    assert!(json.contains("\"name\":\"linux\""));
    assert!(json.contains("\"current_version\":\"6.7.0-arch1-1\""));
    assert!(json.contains("\"new_version\":\"6.7.1-arch1-1\""));
}

#[test]
fn test_package_details_serialization() {
    let details = PackageDetails {
        name: "linux".to_string(),
        version: "6.7.0-arch1-1".to_string(),
        description: Some("The Linux kernel".to_string()),
        url: Some("https://kernel.org/".to_string()),
        licenses: vec!["GPL-2.0-only".to_string()],
        groups: vec![],
        provides: vec!["WIREGUARD-MODULE".to_string()],
        depends: vec!["coreutils".to_string(), "kmod".to_string()],
        optdepends: vec![],
        conflicts: vec![],
        replaces: vec![],
        installed_size: 150_000_000,
        packager: Some("Arch Linux".to_string()),
        architecture: Some("x86_64".to_string()),
        build_date: 1704067200,
        install_date: Some(1704067200),
        reason: "explicit".to_string(),
        validation: vec!["pgp".to_string()],
        repository: Some("core".to_string()),
    };

    let json = serde_json::to_string(&details).unwrap();
    assert!(json.contains("\"licenses\":[\"GPL-2.0-only\"]"));
    assert!(json.contains("\"depends\":[\"coreutils\",\"kmod\"]"));
    assert!(json.contains("\"architecture\":\"x86_64\""));
}

#[test]
fn test_search_result_serialization() {
    let result = SearchResult {
        name: "linux".to_string(),
        version: "6.7.1-arch1-1".to_string(),
        description: Some("The Linux kernel".to_string()),
        repository: "core".to_string(),
        installed: true,
        installed_version: Some("6.7.0-arch1-1".to_string()),
    };

    let json = serde_json::to_string(&result).unwrap();
    assert!(json.contains("\"repository\":\"core\""));
}

#[test]
fn test_package_null_fields() {
    let pkg = Package {
        name: "test".to_string(),
        version: "1.0".to_string(),
        description: None,
        installed_size: 1000,
        install_date: None,
        reason: "dependency".to_string(),
        repository: None,
    };

    let json = serde_json::to_string(&pkg).unwrap();
    assert!(json.contains("\"description\":null"));
    assert!(json.contains("\"install_date\":null"));
    assert!(json.contains("\"repository\":null"));
}

// --- Validation tests ---

#[test]
fn test_validate_package_name_valid() {
    assert!(validate_package_name("linux").is_ok());
    assert!(validate_package_name("python-pip").is_ok());
    assert!(validate_package_name("lib32-gcc-libs").is_ok());
    assert!(validate_package_name("r").is_ok());
    assert!(validate_package_name("gtk4").is_ok());
    assert!(validate_package_name("xorg-server").is_ok());
    assert!(validate_package_name("Linux").is_ok()); // uppercase ok - ALPM allows it
    assert!(validate_package_name("foo;bar").is_ok()); // special chars ok
}

#[test]
fn test_validate_package_name_invalid() {
    assert!(validate_package_name("").is_err());
    assert!(validate_package_name(&"a".repeat(300)).is_err()); // too long
}

#[test]
fn test_validate_search_query_valid() {
    assert!(validate_search_query("linux").is_ok());
    assert!(validate_search_query("Python HTTP").is_ok()); // mixed case ok for search
    assert!(validate_search_query("lib").is_ok());
}

#[test]
fn test_validate_search_query_invalid() {
    assert!(validate_search_query("").is_err());
    assert!(validate_search_query(&"a".repeat(300)).is_err());
    assert!(validate_search_query("foo\x00bar").is_err()); // null byte
    assert!(validate_search_query("foo\nbar").is_err()); // newline
}

#[test]
fn test_validate_pagination_valid() {
    assert!(validate_pagination(0, 50).is_ok());
    assert!(validate_pagination(100, 100).is_ok());
    assert!(validate_pagination(0, 1000).is_ok());
    assert!(validate_pagination(1_000_000, 1).is_ok());
}

#[test]
fn test_validate_pagination_invalid() {
    assert!(validate_pagination(0, 0).is_err()); // zero limit
    assert!(validate_pagination(0, 1001).is_err()); // limit too high
    assert!(validate_pagination(2_000_000, 50).is_err()); // offset too high
}

#[test]
fn test_validate_keep_versions_valid() {
    assert!(validate_keep_versions(0).is_ok());
    assert!(validate_keep_versions(1).is_ok());
    assert!(validate_keep_versions(3).is_ok());
    assert!(validate_keep_versions(50).is_ok());
    assert!(validate_keep_versions(100).is_ok());
}

#[test]
fn test_validate_keep_versions_invalid() {
    assert!(validate_keep_versions(101).is_err());
    assert!(validate_keep_versions(1000).is_err());
    assert!(validate_keep_versions(u32::MAX).is_err());
}

// --- Package filename parsing tests ---

#[test]
fn test_parse_package_filename_simple() {
    let result = parse_package_filename("ada-1.0.0-1-x86_64.pkg.tar.zst");
    assert_eq!(result, Some(("ada".to_string(), "1.0.0-1".to_string())));
}

#[test]
fn test_parse_package_filename_with_dashes_in_name() {
    let result = parse_package_filename("lib32-glibc-2.39-1-x86_64.pkg.tar.zst");
    assert_eq!(
        result,
        Some(("lib32-glibc".to_string(), "2.39-1".to_string()))
    );
}

#[test]
fn test_parse_package_filename_complex_version() {
    let result = parse_package_filename("linux-6.7.0.arch1-1-x86_64.pkg.tar.zst");
    assert_eq!(
        result,
        Some(("linux".to_string(), "6.7.0.arch1-1".to_string()))
    );
}

#[test]
fn test_parse_package_filename_xz_extension() {
    let result = parse_package_filename("pacman-6.0.2-7-x86_64.pkg.tar.xz");
    assert_eq!(result, Some(("pacman".to_string(), "6.0.2-7".to_string())));
}

#[test]
fn test_parse_package_filename_gz_extension() {
    let result = parse_package_filename("gzip-1.13-1-x86_64.pkg.tar.gz");
    assert_eq!(result, Some(("gzip".to_string(), "1.13-1".to_string())));
}

#[test]
fn test_parse_package_filename_invalid_extension() {
    let result = parse_package_filename("package-1.0-1-x86_64.pkg.tar.bz2");
    assert_eq!(result, None);
}

#[test]
fn test_parse_package_filename_too_few_parts() {
    let result = parse_package_filename("incomplete-1.0.pkg.tar.zst");
    assert_eq!(result, None);
}

#[test]
fn test_parse_package_filename_any_arch() {
    let result = parse_package_filename("bash-completion-2.11-2-any.pkg.tar.zst");
    assert_eq!(
        result,
        Some(("bash-completion".to_string(), "2.11-2".to_string()))
    );
}

// --- Integration tests (require live pacman system) ---

#[cfg(feature = "integration-tests")]
mod integration {
    use crate::alpm::get_handle;

    #[test]
    fn test_get_handle_succeeds() {
        let handle = get_handle();
        assert!(
            handle.is_ok(),
            "Failed to get ALPM handle: {:?}",
            handle.err()
        );
    }

    #[test]
    fn test_localdb_has_packages() {
        let handle = get_handle().expect("Failed to get handle");
        let localdb = handle.localdb();
        let pkg_count = localdb.pkgs().len();
        assert!(pkg_count > 0, "Expected installed packages, found none");
    }

    #[test]
    fn test_syncdbs_exist() {
        let handle = get_handle().expect("Failed to get handle");
        let syncdb_count = handle.syncdbs().len();
        assert!(syncdb_count > 0, "Expected sync databases, found none");
    }

    #[test]
    fn test_search_finds_common_package() {
        let handle = get_handle().expect("Failed to get handle");
        let mut found = false;

        for syncdb in handle.syncdbs() {
            if syncdb.pkg("pacman").is_ok() {
                found = true;
                break;
            }
        }

        assert!(found, "Expected to find 'pacman' package in sync databases");
    }

    #[test]
    fn test_package_has_expected_fields() {
        let handle = get_handle().expect("Failed to get handle");
        let localdb = handle.localdb();

        let pkg = localdb.pkgs().first().expect("No packages installed");
        assert!(!pkg.name().is_empty(), "Package name should not be empty");
        assert!(
            !pkg.version().to_string().is_empty(),
            "Package version should not be empty"
        );
        assert!(pkg.isize() >= 0, "Package size should be non-negative");
    }
}
