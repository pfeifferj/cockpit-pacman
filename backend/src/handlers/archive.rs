use anyhow::Result;
use std::io::Read;
use std::time::Duration;

use crate::alpm::get_handle;
use crate::handlers::downgrade::{
    compare_versions, get_installed_version, is_version_older, run_pacman_upgrade,
};
use crate::models::{CachedVersion, DowngradeResponse};
use crate::util::{emit_json, parse_package_filename};
use crate::validation::{validate_archive_filename, validate_package_name};

const ARCHIVE_BASE_URL: &str = "https://archive.archlinux.org/packages";
const MAX_LISTING_BYTES: u64 = 4 * 1024 * 1024;
const MAX_ARCHIVE_VERSIONS: usize = 100;

fn archive_dir_url(name: &str) -> Option<String> {
    let first = name.chars().next()?;
    Some(format!("{}/{}/{}/", ARCHIVE_BASE_URL, first, name))
}

fn archive_file_url(name: &str, filename: &str) -> Option<String> {
    let first = name.chars().next()?;
    Some(format!(
        "{}/{}/{}/{}",
        ARCHIVE_BASE_URL, first, name, filename
    ))
}

/// Extract (filename, size) pairs (excluding signatures) from an archive
/// directory listing. Hrefs are percent-decoded so epoch packages (served as
/// `%3A`) surface with a literal `:`. Size is the autoindex column (rounded,
/// e.g. `2M`); 0 when it can't be parsed.
fn parse_listing(html: &str) -> Vec<(String, i64)> {
    let mut files = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in html.lines() {
        let Some(href_pos) = line.find("href=\"") else {
            continue;
        };
        let rest = &line[href_pos + 6..];
        let Some(end) = rest.find('"') else { continue };
        let href = percent_encoding::percent_decode_str(&rest[..end])
            .decode_utf8_lossy()
            .into_owned();
        if href.contains('/') || href.contains('\\') {
            continue;
        }
        if !href.ends_with(".pkg.tar.zst")
            && !href.ends_with(".pkg.tar.xz")
            && !href.ends_with(".pkg.tar.gz")
        {
            continue;
        }
        let size = parse_listing_size(&rest[end + 1..]);
        if seen.insert(href.clone()) {
            files.push((href, size));
        }
    }
    files
}

/// Parse the trailing autoindex size column (`2M`, `512K`, `1.2G`, or raw
/// bytes). Returns 0 when absent or unparseable.
fn parse_listing_size(tail: &str) -> i64 {
    let Some(tok) = tail.split_whitespace().next_back() else {
        return 0;
    };
    let (digits, mult) = match tok.chars().last() {
        Some('K') | Some('k') => (&tok[..tok.len() - 1], 1024.0),
        Some('M') | Some('m') => (&tok[..tok.len() - 1], 1024.0 * 1024.0),
        Some('G') | Some('g') => (&tok[..tok.len() - 1], 1024.0 * 1024.0 * 1024.0),
        Some('T') | Some('t') => (&tok[..tok.len() - 1], 1024.0_f64.powi(4)),
        Some(c) if c.is_ascii_digit() => (tok, 1.0),
        _ => return 0,
    };
    digits
        .parse::<f64>()
        .ok()
        .map(|n| (n * mult) as i64)
        .unwrap_or(0)
}

fn system_arch() -> &'static str {
    std::env::consts::ARCH
}

pub fn list_archive_versions(name: &str, query: Option<&str>) -> Result<()> {
    validate_package_name(name)?;
    let alpm = get_handle()?;
    let installed_version = get_installed_version(&alpm, name);
    let arch = system_arch();

    let url = archive_dir_url(name).ok_or_else(|| anyhow::anyhow!("Invalid package name"))?;

    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(30)))
            .ip_family(crate::util::detected_ip_family())
            .build(),
    );

    let resp = match agent.get(&url).call() {
        Ok(r) => r,
        Err(ureq::Error::StatusCode(404)) => {
            return emit_json(&DowngradeResponse {
                packages: vec![],
                total: 0,
            });
        }
        Err(e) => return Err(e.into()),
    };

    let mut body = resp.into_body();
    let mut buf = Vec::new();
    body.as_reader()
        .take(MAX_LISTING_BYTES)
        .read_to_end(&mut buf)?;
    let html = String::from_utf8_lossy(&buf);

    let packages = build_archive_versions(&html, name, arch, installed_version.as_deref(), query);
    let total = packages.len();
    emit_json(&DowngradeResponse { packages, total })
}

/// Turn an archive directory listing into the package versions for `name`,
/// filtered to `arch` (plus `any`) and an optional case-insensitive version
/// substring, newest first, capped at MAX_ARCHIVE_VERSIONS.
fn build_archive_versions(
    html: &str,
    name: &str,
    arch: &str,
    installed_version: Option<&str>,
    query: Option<&str>,
) -> Vec<CachedVersion> {
    let query = query.map(str::to_lowercase);
    let mut packages: Vec<CachedVersion> = Vec::new();
    for (filename, size) in parse_listing(html) {
        let Some((pkg_name, version, pkg_arch)) = parse_package_filename(&filename) else {
            continue;
        };
        if pkg_name != name {
            continue;
        }
        if pkg_arch != arch && pkg_arch != "any" {
            continue;
        }
        if let Some(q) = &query
            && !version.to_lowercase().contains(q)
        {
            continue;
        }
        let is_older = installed_version
            .map(|iv| is_version_older(&version, iv))
            .unwrap_or(false);
        packages.push(CachedVersion {
            name: pkg_name,
            version,
            filename,
            size,
            installed_version: installed_version.map(str::to_string),
            is_older,
        });
    }

    packages.sort_by(|a, b| compare_versions(&b.version, &a.version));
    packages.truncate(MAX_ARCHIVE_VERSIONS);
    packages
}

pub fn downgrade_from_archive(name: &str, filename: &str, timeout: Option<u64>) -> Result<()> {
    crate::util::setup_signal_handler();
    validate_package_name(name)?;
    validate_archive_filename(filename, name)?;

    let (_, version, _) = parse_package_filename(filename)
        .ok_or_else(|| anyhow::anyhow!("Invalid package filename"))?;
    let url =
        archive_file_url(name, filename).ok_or_else(|| anyhow::anyhow!("Invalid package name"))?;

    run_pacman_upgrade(&url, name, &version, timeout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_listing_skipping_sigs_and_dirs() {
        let html = r#"
            <a href="../">../</a>
            <a href="bash-5.1.016-1-x86_64.pkg.tar.zst">bash-5.1.016-1-x86_64.pkg.tar.zst</a>
            <a href="bash-5.1.016-1-x86_64.pkg.tar.zst.sig">sig</a>
            <a href="bash-5.2.015-1-x86_64.pkg.tar.zst">x</a>
            <a href="bash-5.0.018-1-x86_64.pkg.tar.xz">old</a>
        "#;
        let names: Vec<String> = parse_listing(html).into_iter().map(|(f, _)| f).collect();
        assert_eq!(names.len(), 3);
        assert!(names.contains(&"bash-5.1.016-1-x86_64.pkg.tar.zst".to_string()));
        assert!(names.contains(&"bash-5.0.018-1-x86_64.pkg.tar.xz".to_string()));
        assert!(!names.iter().any(|f| f.ends_with(".sig")));
    }

    #[test]
    fn parse_listing_reads_the_autoindex_size_column() {
        let html = "<a href=\"bash-5.1-1-x86_64.pkg.tar.zst\">bash-5.1-1-x86_64.pkg.tar.zst</a>     09-Mar-2019 07:17      2M\r\n";
        let files = parse_listing(html);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].1, 2 * 1024 * 1024);
    }

    #[test]
    fn parses_human_and_byte_size_tokens() {
        assert_eq!(parse_listing_size("  date   512K"), 512 * 1024);
        assert_eq!(
            parse_listing_size("  date   1.5G"),
            (1.5 * 1024.0 * 1024.0 * 1024.0) as i64
        );
        assert_eq!(parse_listing_size("  date   4096"), 4096);
        assert_eq!(parse_listing_size("</a>"), 0);
    }

    #[test]
    fn parses_filename_with_epoch() {
        let (name, version, arch) =
            parse_package_filename("grub-2:2.04-1-x86_64.pkg.tar.zst").unwrap();
        assert_eq!(name, "grub");
        assert_eq!(version, "2:2.04-1");
        assert_eq!(arch, "x86_64");
    }

    #[test]
    fn parse_listing_decodes_percent_encoded_epoch() {
        // The archive serves epoch packages with the colon escaped as %3A.
        let html = listing(&["grub-2%3A2.04-1-x86_64.pkg.tar.zst"]);
        let names: Vec<String> = parse_listing(&html).into_iter().map(|(f, _)| f).collect();
        assert_eq!(names, ["grub-2:2.04-1-x86_64.pkg.tar.zst"]);
    }

    #[test]
    fn parse_listing_drops_encoded_path_separators() {
        let html = listing(&["%2e%2e%2fevil-1-1-x86_64.pkg.tar.zst"]);
        assert!(parse_listing(&html).is_empty());
    }

    #[test]
    fn build_archive_versions_surfaces_epoch_packages() {
        let html = listing(&["grub-2%3A2.04-1-x86_64.pkg.tar.zst"]);
        let versions = build_archive_versions(&html, "grub", "x86_64", None, None);
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].version, "2:2.04-1");
        assert_eq!(versions[0].filename, "grub-2:2.04-1-x86_64.pkg.tar.zst");
    }

    fn listing(filenames: &[&str]) -> String {
        filenames
            .iter()
            .map(|f| format!("<a href=\"{f}\">{f}</a>\n"))
            .collect()
    }

    #[test]
    fn keeps_system_arch_and_any_drops_others() {
        let html = listing(&[
            "bash-5.1-1-x86_64.pkg.tar.zst",
            "bash-5.1-1-i686.pkg.tar.zst",
            "bash-5.1-1-any.pkg.tar.zst",
            "bash-5.1-1-aarch64.pkg.tar.zst",
        ]);
        let versions = build_archive_versions(&html, "bash", "x86_64", None, None);
        let archs: Vec<&str> = versions
            .iter()
            .map(|v| v.filename.rsplit('-').nth(0).unwrap())
            .collect();
        assert_eq!(versions.len(), 2);
        assert!(
            archs
                .iter()
                .all(|a| a.starts_with("x86_64") || a.starts_with("any"))
        );
    }

    #[test]
    fn filters_to_requested_package_only() {
        let html = listing(&[
            "bash-5.1-1-x86_64.pkg.tar.zst",
            "bash-completion-2.11-1-any.pkg.tar.zst",
        ]);
        let versions = build_archive_versions(&html, "bash", "x86_64", None, None);
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].version, "5.1-1");
    }

    #[test]
    fn sorts_newest_first() {
        let html = listing(&[
            "bash-5.0-1-x86_64.pkg.tar.zst",
            "bash-5.2-1-x86_64.pkg.tar.zst",
            "bash-5.1-1-x86_64.pkg.tar.zst",
        ]);
        let versions = build_archive_versions(&html, "bash", "x86_64", None, None);
        let order: Vec<&str> = versions.iter().map(|v| v.version.as_str()).collect();
        assert_eq!(order, ["5.2-1", "5.1-1", "5.0-1"]);
    }

    #[test]
    fn caps_at_max_versions() {
        let files: Vec<String> = (0..MAX_ARCHIVE_VERSIONS + 25)
            .map(|i| format!("bash-1.{i}-1-x86_64.pkg.tar.zst"))
            .collect();
        let refs: Vec<&str> = files.iter().map(String::as_str).collect();
        let versions = build_archive_versions(&listing(&refs), "bash", "x86_64", None, None);
        assert_eq!(versions.len(), MAX_ARCHIVE_VERSIONS);
    }

    #[test]
    fn marks_older_versions_against_installed() {
        let html = listing(&[
            "bash-5.2-1-x86_64.pkg.tar.zst",
            "bash-5.0-1-x86_64.pkg.tar.zst",
        ]);
        let versions = build_archive_versions(&html, "bash", "x86_64", Some("5.1-1"), None);
        let older: Vec<bool> = versions.iter().map(|v| v.is_older).collect();
        assert_eq!(older, [false, true]);
        assert!(
            versions
                .iter()
                .all(|v| v.installed_version.as_deref() == Some("5.1-1"))
        );
    }

    #[test]
    fn query_filters_versions_before_the_cap() {
        let mut files: Vec<String> = (0..MAX_ARCHIVE_VERSIONS + 5)
            .map(|i| format!("bash-9.{i}-1-x86_64.pkg.tar.zst"))
            .collect();
        files.push("bash-1.2.3-1-x86_64.pkg.tar.zst".to_string());
        let refs: Vec<&str> = files.iter().map(String::as_str).collect();
        let versions =
            build_archive_versions(&listing(&refs), "bash", "x86_64", None, Some("1.2.3"));
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].version, "1.2.3-1");
    }

    #[test]
    fn not_installed_yields_no_older_flag() {
        let html = listing(&["bash-5.0-1-x86_64.pkg.tar.zst"]);
        let versions = build_archive_versions(&html, "bash", "x86_64", None, None);
        assert_eq!(versions.len(), 1);
        assert!(!versions[0].is_older);
        assert_eq!(versions[0].installed_version, None);
    }

    #[test]
    fn builds_urls_from_first_char() {
        assert_eq!(
            archive_dir_url("bash").unwrap(),
            "https://archive.archlinux.org/packages/b/bash/"
        );
        assert_eq!(
            archive_file_url("bash", "bash-5.1.016-1-x86_64.pkg.tar.zst").unwrap(),
            "https://archive.archlinux.org/packages/b/bash/bash-5.1.016-1-x86_64.pkg.tar.zst"
        );
    }
}
