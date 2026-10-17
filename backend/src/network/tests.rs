use super::*;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt, symlink};
use std::sync::atomic::{AtomicU64, Ordering};

struct Directory(std::path::PathBuf);

impl Directory {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "cockpit-proxy-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .unwrap();
        Self(path)
    }

    fn write(&self, content: &str, mode: u32) {
        let path = self.0.join("proxy.json");
        std::fs::write(&path, content).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    fn read(&self) -> Result<Option<Config>, NetworkError> {
        read_config(&self.0, unsafe { libc::getuid() })
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

fn resolve_json(json: &str, env: &[(&str, &str)]) -> Result<Resolved, NetworkError> {
    let config = serde_json::from_str(json).unwrap();
    let env = env
        .iter()
        .map(|(name, value)| ((*name).into(), (*value).into()))
        .collect::<Vec<_>>();
    resolve(config, &env)
}

#[test]
fn missing_config_inherits_and_direct_discards_aliases() {
    let directory = Directory::new();
    assert!(directory.read().unwrap().is_none());
    assert!(
        read_config(&directory.0.join("absent"), 0)
            .unwrap()
            .is_none()
    );
    let resolved = resolve_json("null", &[("https_proxy", "http://proxy:3128")]).unwrap();
    assert!(!resolved.replace);
    assert!(resolved.values.is_empty());
    assert!(resolved.policy.deny_keyring);
    let resolved = resolve_json(
        r#"{"mode":"direct"}"#,
        &[("ALL_PROXY", "garbage"), ("ftp_proxy", "bad")],
    )
    .unwrap();
    assert!(resolved.replace);
    assert!(resolved.values.is_empty());
    assert!(resolved.policy.deny_keyring);
    for name in [
        "HTTP_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "ftp_proxy",
        "SFTP_PROXY",
        "No_Proxy",
    ] {
        assert!(proxy_variable(OsStr::new(name)));
    }
    assert!(!proxy_variable(OsStr::new("PATH")));
}

#[test]
fn explicit_proxy_replaces_the_environment_and_requires_a_fallback() {
    let resolved = resolve_json(r#"{"mode":"proxy", "all_proxy":"socks5h://proxy:1080", "https_proxy":"http://proxy:3128", "no_proxy":"localhost,10.0.0.0/8"}"#,
        &[("http_proxy", "http://stale:1"), ("NO_PROXY", "*")]).unwrap();
    assert!(resolved.replace);
    assert_eq!(
        resolved.values,
        vec![
            ("all_proxy".into(), "socks5h://proxy:1080".into()),
            ("https_proxy".into(), "http://proxy:3128".into()),
            ("no_proxy".into(), "localhost,10.0.0.0/8".into()),
        ]
    );
    for json in [
        r#"{"mode":"proxy"}"#,
        r#"{"mode":"proxy","all_proxy":""}"#,
        r#"{"mode":"proxy","http_proxy":"http://proxy:3128"}"#,
        r#"{"mode":"direct","no_proxy":"*"}"#,
        r#"{"mode":"inherit","https_proxy":"http://proxy:3128"}"#,
    ] {
        assert!(resolve_json(json, &[]).is_err());
    }
}

#[test]
fn inherited_precedence_and_keyring_routing_are_explicit() {
    for env in [
        vec![],
        vec![("HTTP_PROXY", "garbage")],
        vec![("NO_PROXY", "*")],
    ] {
        assert!(!resolve_json("null", &env).unwrap().policy.deny_keyring);
    }
    for env in [
        vec![("ALL_PROXY", "socks5h://proxy:1080"), ("NO_PROXY", "*")],
        vec![("http_proxy", "proxy:3128")],
        vec![("HTTPS_PROXY", "https://proxy:443")],
        vec![("ftp_proxy", "socks5://proxy:1080")],
    ] {
        assert!(resolve_json("null", &env).unwrap().policy.deny_keyring);
    }
    assert!(
        resolve_json(
            "null",
            &[
                ("https_proxy", "http://proxy:1"),
                ("HTTPS_PROXY", "invalid://bad")
            ]
        )
        .is_ok()
    );
    assert!(
        resolve_json(
            "null",
            &[("https_proxy", ""), ("HTTPS_PROXY", "invalid://bad")]
        )
        .is_err()
    );
    assert!(resolve_json("null", &[("all_proxy", "socks4://proxy:1")]).is_err());
    assert!(
        !resolve_json(r#"{"mode":"direct","keyring":"external"}"#, &[])
            .unwrap()
            .policy
            .deny_keyring
    );
    assert!(
        resolve_json(r#"{"mode":"inherit","keyring":"deny"}"#, &[])
            .unwrap()
            .policy
            .deny_keyring
    );
    assert!(
        resolve_json(
            r#"{"mode":"inherit","keyring":"external"}"#,
            &[("all_proxy", "bad://proxy")]
        )
        .is_err()
    );
}

#[test]
fn malformed_endpoints_and_schema_are_rejected_without_echoing_secrets() {
    let directory = Directory::new();
    for content in [
        r#"{"mode":"proxy","all_proxy":"file:///secret"}"#,
        r#"{"mode":"proxy","all_proxy":"http://secret:pass@proxy/path"}"#,
        r#"{"mode":"proxy","all_proxy":"http://secret:pass@proxy?query"}"#,
        r#"{"mode":"proxy","all_proxy":"http://secret:pass@proxy#fragment"}"#,
        r#"{"mode":"proxy","all_proxy":"http://secret:pass@proxy\n"}"#,
        r#"{"mode":"proxy","all_proxy":"http://proxy","no_proxy":"secret\n"}"#,
        r#"{"mode":"typo","secret":"pass"}"#,
        r#"{"mode":"direct","secret":"pass"}"#,
        r#"{"mode":"direct","mode":"proxy"}"#,
        "secret:pass",
    ] {
        directory.write(content, 0o600);
        let error = directory.read().err().unwrap();
        assert!(!format!("{error:?} {error}").contains("secret"));
        assert_eq!(
            crate::util::classify_error(&anyhow::Error::new(error)),
            Some("validation_error")
        );
    }
    for endpoint in [
        "http://proxy:3128",
        "https://proxy:443",
        "socks5://proxy:1080",
        "socks5h://[::1]:1080",
    ] {
        assert_eq!(validate_endpoint(endpoint, false), Ok(false));
    }
    assert_eq!(
        validate_endpoint("http://user:p%40ss@proxy", false),
        Ok(true)
    );
}

#[test]
fn config_ownership_modes_and_size_are_checked() {
    let directory = Directory::new();
    directory.write(r#"{"mode":"direct"}"#, 0o644);
    assert!(directory.read().unwrap().is_some());
    assert!(read_config(&directory.0, unsafe { libc::getuid() } + 1).is_err());
    for mode in [0o620, 0o602, 0o666] {
        directory.write(r#"{"mode":"direct"}"#, mode);
        assert!(directory.read().is_err());
    }
    directory.write(
        r#"{"mode":"proxy","all_proxy":"http://user:secret@proxy"}"#,
        0o644,
    );
    assert!(directory.read().is_err());
    for mode in [0o600, 0o640] {
        directory.write(
            r#"{"mode":"proxy","all_proxy":"http://user:secret@proxy"}"#,
            mode,
        );
        assert!(directory.read().is_ok());
    }
    directory.write(&" ".repeat(MAX_CONFIG_BYTES as usize + 1), 0o600);
    assert!(directory.read().is_err());
    directory.write(r#"{"mode":"direct"}"#, 0o600);
    std::fs::set_permissions(&directory.0, std::fs::Permissions::from_mode(0o770)).unwrap();
    assert!(directory.read().is_err());
}

#[test]
fn symlinks_and_special_files_are_refused_without_blocking() {
    let directory = Directory::new();
    let outside = Directory::new();
    outside.write(r#"{"mode":"direct"}"#, 0o600);
    symlink(&outside.0, directory.0.join("linked")).unwrap();
    assert!(read_config(&directory.0.join("linked"), unsafe { libc::getuid() }).is_err());
    let path = directory.0.join("proxy.json");
    symlink(outside.0.join("proxy.json"), &path).unwrap();
    assert!(directory.read().is_err());
    std::fs::remove_file(&path).unwrap();
    let name = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    assert!(directory.read().is_err());
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(directory.read().is_err());
}

#[test]
fn native_proxy_errors_do_not_expose_truncated_credentials() {
    let endpoint = format!("http://user:{}@proxy:3128", "secret".repeat(100));
    let policy = resolve_json(
        &serde_json::json!({"mode":"proxy", "all_proxy":endpoint}).to_string(),
        &[],
    )
    .unwrap()
    .policy;
    for message in [
        format!("Unsupported proxy syntax in '{endpoint}'"),
        format!("Unsupported proxy syntax in '{endpoint}'")
            .chars()
            .take(255)
            .collect(),
        "Could not connect to proxy".to_owned(),
    ] {
        let redacted = policy.diagnostic(&message);
        assert!(!redacted.contains("secret"));
        assert!(!redacted.contains("user"));
        assert_ne!(redacted, message);
    }
    assert_eq!(policy.diagnostic("disk full"), "disk full");
    assert_eq!(policy.diagnostic("file exists"), "file exists");
    for endpoint in [
        " http://user:secret@proxy",
        "http://user:secret@proxy\\",
        "socks5h://user:secret@ho%zzst",
        "socks5://user:secret@%00",
    ] {
        assert!(validate_endpoint(endpoint, false).is_err());
        assert!(validate_endpoint(endpoint, true).is_err());
    }
    assert!(
        resolve_json("null", &[("sftp_proxy", "http://proxy:3128")])
            .unwrap()
            .policy
            .deny_keyring
    );
    assert!(resolve_json("null", &[("SFTP_PROXY", "bad://proxy")]).is_err());
}
