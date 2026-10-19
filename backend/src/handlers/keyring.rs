use anyhow::{Context, Result};
use pacman_key::{
    CancellationToken, InitializationStatus, Keyring, OperationOptions, ReadOnlyKeyring,
    RefreshProgress,
};
use std::time::Duration;

use crate::alpm::validity_to_string;
use crate::models::{
    InvalidInput, KeyActionResponse, KeyringKey, KeyringState, KeyringStatusResponse, StreamEvent,
};
use crate::util::{emit_event, emit_failure, emit_json, is_cancelled, setup_signal_handler};

// Matches the crate's private DEFAULT_GPG_HOMEDIR.
const PACMAN_GNUPG_DIR: &str = "/etc/pacman.d/gnupg";

pub fn keyring_status() -> Result<()> {
    setup_signal_handler()?;
    let rt = tokio::runtime::Runtime::new().context("Failed to create tokio runtime")?;

    rt.block_on(async {
        let keyring = Keyring::with_homedir(PACMAN_GNUPG_DIR);
        let response =
            query_keyring_status(&keyring, PACMAN_GNUPG_DIR, Duration::from_secs(25)).await?;
        emit_json(&response)
    })
}

async fn query_keyring_status(
    keyring: &ReadOnlyKeyring,
    homedir: &str,
    timeout: Duration,
) -> Result<KeyringStatusResponse> {
    let cancelled = async {
        while !is_cancelled() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    };
    tokio::select! {
        biased;
        () = cancelled => Err(anyhow::Error::new(pacman_key::Error::Cancelled)
            .context("Keyring status query cancelled")),
        result = tokio::time::timeout(timeout, build_keyring_status(keyring, homedir)) => {
            result.context("Keyring status query timed out")
        }
    }
}

async fn build_keyring_status(keyring: &ReadOnlyKeyring, homedir: &str) -> KeyringStatusResponse {
    let mut warnings: Vec<String> = Vec::new();

    let status = match keyring.is_initialized() {
        Ok(InitializationStatus::Ready) => KeyringState::Ready,
        Ok(InitializationStatus::DirectoryMissing) => {
            warnings.push(
                "Keyring not initialized. Run 'pacman-key --init' to initialize.".to_string(),
            );
            KeyringState::Uninitialized
        }
        Ok(InitializationStatus::IncorrectPermissions { actual }) => {
            warnings.push(format!(
                "Keyring directory ({}) has mode {:o}; pacman expects 755. \
                     Fix with 'chmod 755 {}' or reinitialize with 'pacman-key --init'.",
                homedir, actual, homedir
            ));
            KeyringState::Ready
        }
        Ok(InitializationStatus::NoKeyringFiles) => {
            warnings.push(format!(
                "Keyring directory ({}) exists but contains no keys.",
                homedir,
            ));
            KeyringState::Uninitialized
        }
        Ok(InitializationStatus::NoTrustDb) => {
            warnings.push(format!(
                "Keyring directory ({}) missing trust database.",
                homedir,
            ));
            KeyringState::Uninitialized
        }
        Ok(other) => {
            warnings.push(format!("Keyring status: {:?}", other));
            KeyringState::Undetermined
        }
        Err(e) => {
            warnings.push(format!("Failed to check keyring status: {}", e));
            KeyringState::Undetermined
        }
    };
    let master_key_initialized = status == KeyringState::Ready;

    let keys: Vec<KeyringKey> = if master_key_initialized {
        match keyring.list_keys().await {
            Ok(key_list) => key_list
                .into_iter()
                .map(|k| KeyringKey {
                    fingerprint: k.fingerprint,
                    uid: k.uid,
                    created: k.created.map(|d| d.format("%Y-%m-%d").to_string()),
                    expires: k.expires.map(|d| d.format("%Y-%m-%d").to_string()),
                    trust: validity_to_string(&k.validity).to_string(),
                })
                .collect(),
            Err(e) => {
                warnings.push(format!("Failed to list keys: {}", e));
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };

    KeyringStatusResponse {
        total: keys.len(),
        keys,
        master_key_initialized,
        status,
        warnings,
    }
}

pub fn refresh_keyring() -> Result<()> {
    crate::network::require_keyring_network()?;
    setup_signal_handler()?;
    crate::util::spawn_cancel_listener()?;

    if is_cancelled() {
        emit_event(&StreamEvent::Complete {
            success: false,
            code: Some("cancelled".to_string()),
            details: None,
            message: Some("Operation cancelled".to_string()),
        });
        return Ok(());
    }

    let rt = tokio::runtime::Runtime::new().context("Failed to create tokio runtime")?;

    rt.block_on(async {
        emit_event(&StreamEvent::Log {
            level: "info".to_string(),
            message: "Refreshing pacman keyring...".to_string(),
        });

        let keyring = Keyring::new();
        let cancel_token = CancellationToken::new();
        let cancel_token_clone = cancel_token.clone();

        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                if is_cancelled() {
                    cancel_token_clone.cancel();
                    break;
                }
            }
        });

        let options = OperationOptions {
            timeout_secs: Some(600),
            cancel_token: Some(cancel_token),
        };

        let reached = std::cell::Cell::new(None);
        let callback = |progress: RefreshProgress| {
            if let RefreshProgress::Refreshing { current, total, .. } = progress {
                reached.set(Some((current, total)));
            }
            if let Some(event) = refresh_progress_event(progress) {
                emit_event(&event);
            }
        };

        match keyring.refresh_keys(callback, options).await {
            Ok(()) => {
                emit_event(&StreamEvent::Complete {
                    success: true,
                    code: None,
                    details: None,
                    message: Some("Keyring refresh completed".to_string()),
                });
            }
            Err(pacman_key::Error::Cancelled) => {
                emit_event(&StreamEvent::Complete {
                    success: false,
                    code: Some("cancelled".to_string()),
                    details: None,
                    message: Some(refresh_stopped_message(reached.get())),
                });
            }
            Err(pacman_key::Error::Timeout(secs)) => {
                emit_event(&StreamEvent::Complete {
                    success: false,
                    code: Some("timeout".to_string()),
                    details: None,
                    message: Some(format!("Operation timed out after {} seconds", secs)),
                });
            }
            Err(e) => {
                emit_failure(&format!("Keyring refresh failed: {}", e), "internal_error");
            }
        }
        Ok(())
    })
}

pub fn init_keyring() -> Result<()> {
    setup_signal_handler()?;
    crate::util::spawn_cancel_listener()?;

    if is_cancelled() {
        emit_event(&StreamEvent::Complete {
            success: false,
            code: Some("cancelled".to_string()),
            details: None,
            message: Some("Operation cancelled".to_string()),
        });
        return Ok(());
    }

    let rt = tokio::runtime::Runtime::new().context("Failed to create tokio runtime")?;

    rt.block_on(async {
        emit_event(&StreamEvent::Log {
            level: "info".to_string(),
            message: "Initializing pacman keyring...".to_string(),
        });

        let keyring = Keyring::new();
        let cancel_token = CancellationToken::new();
        let cancel_token_clone = cancel_token.clone();

        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                if is_cancelled() {
                    cancel_token_clone.cancel();
                    break;
                }
            }
        });

        let options = OperationOptions {
            timeout_secs: Some(120),
            cancel_token: Some(cancel_token.clone()),
        };

        match keyring.init_keyring_with_options(options).await {
            Ok(()) => {}
            Err(pacman_key::Error::Cancelled) => {
                emit_event(&StreamEvent::Complete {
                    success: false,
                    code: Some("cancelled".to_string()),
                    details: None,
                    message: Some("Operation cancelled by user".to_string()),
                });
                return Ok(());
            }
            Err(pacman_key::Error::Timeout(secs)) => {
                emit_failure(&format!("Init timed out after {} seconds", secs), "timeout");
                return Ok(());
            }
            Err(e) => {
                emit_failure(
                    &format!("Failed to initialize keyring: {}", e),
                    "internal_error",
                );
                return Ok(());
            }
        }

        emit_event(&StreamEvent::Log {
            level: "info".to_string(),
            message: "Populating keyring with Arch Linux keys...".to_string(),
        });

        let populate_options = OperationOptions {
            timeout_secs: Some(300),
            cancel_token: Some(cancel_token),
        };

        match keyring
            .populate_with_options(&["archlinux"], populate_options)
            .await
        {
            Ok(()) => {
                emit_event(&StreamEvent::Complete {
                    success: true,
                    code: None,
                    details: None,
                    message: Some("Keyring initialized and populated".to_string()),
                });
            }
            Err(pacman_key::Error::Cancelled) => {
                emit_event(&StreamEvent::Complete {
                    success: false,
                    code: Some("cancelled".to_string()),
                    details: None,
                    message: Some("Operation cancelled by user".to_string()),
                });
            }
            Err(pacman_key::Error::Timeout(secs)) => {
                emit_failure(
                    &format!("Populate timed out after {} seconds", secs),
                    "timeout",
                );
            }
            Err(e) => {
                emit_failure(
                    &format!("Failed to populate keyring: {}", e),
                    "internal_error",
                );
            }
        }
        Ok(())
    })
}

#[cfg(test)]
mod status_tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::process::{Child, Command, Stdio};
    use std::time::Instant;

    struct QueryFixture {
        directory: PathBuf,
        child: Option<Child>,
    }

    impl QueryFixture {
        fn new() -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let directory = std::env::temp_dir()
                .join(format!("cpac-keyring-query-{}-{nonce}", std::process::id()));
            fs::create_dir(&directory).unwrap();
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
            fs::create_dir(directory.join("bin")).unwrap();
            fs::create_dir(directory.join("homedir")).unwrap();
            fs::set_permissions(directory.join("homedir"), fs::Permissions::from_mode(0o755))
                .unwrap();
            for name in ["pubring.gpg", "trustdb.gpg"] {
                fs::write(directory.join("homedir").join(name), b"fixture").unwrap();
            }
            let gpg = directory.join("bin/gpg");
            fs::write(&gpg, r#"#!/bin/sh
echo $$ > "$KEYRING_QUERY_FIXTURE/parent"
flock "$KEYRING_QUERY_FIXTURE/lock" sh -c 'echo $$ > "$KEYRING_QUERY_FIXTURE/grandchild"; touch "$KEYRING_QUERY_FIXTURE/ready"; exec sleep 60' &
wait
"#).unwrap();
            fs::set_permissions(gpg, fs::Permissions::from_mode(0o755)).unwrap();
            Self {
                directory,
                child: None,
            }
        }

        fn pid(&self, name: &str) -> Option<libc::pid_t> {
            fs::read_to_string(self.directory.join(name))
                .ok()?
                .trim()
                .parse()
                .ok()
        }

        fn active(&self, name: &str) -> bool {
            self.pid(name).is_some_and(|pid| {
                fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
                    stat.rsplit_once(") ")
                        .is_some_and(|(_, fields)| !fields.starts_with('Z'))
                })
            })
        }

        fn check(&mut self, mode: &str) {
            self.child = Some(
                Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "handlers::keyring::status_tests::subprocess_query",
                        "--nocapture",
                    ])
                    .env("KEYRING_QUERY_FIXTURE", &self.directory)
                    .env("KEYRING_QUERY_MODE", mode)
                    .env(
                        "PATH",
                        format!("{}:/usr/bin", self.directory.join("bin").display()),
                    )
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                    .unwrap(),
            );
            let deadline = Instant::now() + Duration::from_secs(10);
            while !self.directory.join("ready").exists() {
                assert!(Instant::now() < deadline, "fake gpg did not start");
                std::thread::sleep(Duration::from_millis(10));
            }
            if mode.contains("stdin") {
                use std::io::Write;
                self.child
                    .as_mut()
                    .unwrap()
                    .stdin
                    .as_mut()
                    .unwrap()
                    .write_all(b"cancel\n")
                    .unwrap();
            } else if mode.ends_with("cancel") {
                let pid = self.child.as_ref().unwrap().id() as libc::pid_t;
                assert_eq!(unsafe { libc::kill(pid, libc::SIGTERM) }, 0);
            }
            while self.child.as_mut().unwrap().try_wait().unwrap().is_none() {
                assert!(Instant::now() < deadline, "keyring query did not stop");
                std::thread::sleep(Duration::from_millis(10));
            }
            let output = self.child.take().unwrap().wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            while self.active("parent") || self.active("grandchild") {
                assert!(
                    Instant::now() < deadline,
                    "gpg descendant survived query cleanup"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            assert!(
                Command::new("flock")
                    .arg("-n")
                    .arg(self.directory.join("lock"))
                    .arg("true")
                    .status()
                    .unwrap()
                    .success()
            );
        }
    }

    impl Drop for QueryFixture {
        fn drop(&mut self) {
            if let Some(child) = &mut self.child {
                let _ = child.kill();
                let _ = child.wait();
            }
            if (self.active("parent") || self.active("grandchild"))
                && let Some(group) = self.pid("parent")
            {
                unsafe {
                    libc::kill(-group, libc::SIGKILL);
                }
            }
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    #[test]
    fn subprocess_query() {
        let Ok(directory) = std::env::var("KEYRING_QUERY_FIXTURE") else {
            return;
        };
        setup_signal_handler().unwrap();
        let mode = std::env::var("KEYRING_QUERY_MODE").unwrap();
        if mode.contains("stdin") {
            crate::util::spawn_cancel_listener().unwrap();
        }
        let timeout = Duration::from_secs(if mode.ends_with("cancel") { 30 } else { 1 });
        let homedir = PathBuf::from(directory).join("homedir");
        let homedir = homedir.to_str().unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let keyring = Keyring::with_homedir(homedir);
        let result = if mode.starts_with("action") {
            runtime
                .block_on(await_key_action(
                    async { keyring.list_keys().await.map_err(anyhow::Error::from) },
                    timeout,
                ))
                .map(|_| ())
        } else {
            runtime
                .block_on(query_keyring_status(&keyring, homedir, timeout))
                .map(|_| ())
        };
        let error = result.expect_err("hung gpg unexpectedly succeeded");
        assert_eq!(
            crate::util::classify_error(&error),
            Some(if mode.ends_with("cancel") {
                "cancelled"
            } else {
                "timeout"
            })
        );
    }

    #[test]
    fn sigterm_cleans_up_a_query_gpg_and_its_descendant() {
        QueryFixture::new().check("cancel");
    }

    #[test]
    fn query_deadline_cleans_up_gpg_and_its_descendant() {
        QueryFixture::new().check("timeout");
    }

    #[test]
    fn cancelled_key_action_cleans_up_gpg_descendants() {
        QueryFixture::new().check("action-cancel");
    }

    #[test]
    fn key_action_deadline_covers_hung_readback() {
        QueryFixture::new().check("action-timeout");
    }

    #[test]
    fn control_pipe_cancellation_cleans_up_key_actions() {
        QueryFixture::new().check("action-stdin-cancel");
    }

    async fn status_for(path: &std::path::Path) -> KeyringStatusResponse {
        let path = path.to_str().unwrap();
        build_keyring_status(&Keyring::with_homedir(path), path).await
    }

    #[tokio::test]
    async fn a_missing_directory_is_uninitialized_with_a_warning() {
        let dir = std::env::temp_dir().join(format!("cpac-keyring-missing-{}", std::process::id()));
        let response = status_for(&dir).await;
        assert!(response.status == KeyringState::Uninitialized);
        assert!(!response.master_key_initialized);
        assert!(response.keys.is_empty());
        assert_eq!(response.warnings.len(), 1);
    }

    #[tokio::test]
    async fn an_empty_directory_is_uninitialized_with_a_warning() {
        let dir = std::env::temp_dir().join(format!("cpac-keyring-empty-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        let response = status_for(&dir).await;
        fs::remove_dir_all(&dir).unwrap();
        assert!(response.status == KeyringState::Uninitialized);
        assert!(!response.master_key_initialized);
        assert!(response.keys.is_empty());
        assert_eq!(response.warnings.len(), 1);
    }
}

pub fn validate_fingerprint(input: &str) -> Result<String> {
    let compact: String = input.chars().filter(|c| !c.is_whitespace()).collect();
    let hex = compact
        .strip_prefix("0x")
        .or_else(|| compact.strip_prefix("0X"))
        .unwrap_or(&compact);
    if hex.len() != 40 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(InvalidInput(
            "A key needs its full 40-character fingerprint; key ids are not accepted".to_string(),
        )
        .into());
    }
    Ok(hex.to_ascii_uppercase())
}

pub fn validate_keyserver(input: &str) -> Result<()> {
    let valid = input.len() <= 512
        && !input
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
        && arch_http_client::Url::parse(input).is_ok_and(|url| {
            ["hkps", "hkp", "https", "http", "ldap"].contains(&url.scheme())
                && url.host_str().is_some_and(|host| !host.is_empty())
                && url.username().is_empty()
                && url.password().is_none()
        });
    if !valid {
        return Err(InvalidInput("Keyserver must be an hkp, hkps, http, https or ldap URL with a host and no credentials".into()).into());
    }
    Ok(())
}

async fn read_key(keyring: &Keyring, fingerprint: &str) -> Result<KeyringKey> {
    let keys = keyring.list_keys().await.context("Failed to list keys")?;
    keys.into_iter()
        .find(|k| k.fingerprint.eq_ignore_ascii_case(fingerprint))
        .map(|k| KeyringKey {
            fingerprint: k.fingerprint,
            uid: k.uid,
            created: k.created.map(|d| d.format("%Y-%m-%d").to_string()),
            expires: k.expires.map(|d| d.format("%Y-%m-%d").to_string()),
            trust: validity_to_string(&k.validity).to_string(),
        })
        .ok_or_else(|| anyhow::anyhow!("Key {} is not in the pacman keyring", fingerprint))
}

async fn await_key_action<T>(
    future: impl std::future::Future<Output = Result<T>>,
    timeout: Duration,
) -> Result<T> {
    let cancelled = async {
        while !is_cancelled() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    };
    tokio::select! {
        biased;
        () = cancelled => Err(pacman_key::Error::Cancelled.into()),
        result = tokio::time::timeout(timeout, future) => {
            result.map_err(|_| anyhow::Error::from(pacman_key::Error::Timeout(timeout.as_secs())))?
        }
    }
}

fn finish_key_action(future: impl std::future::Future<Output = Result<KeyringKey>>) -> Result<()> {
    setup_signal_handler()?;
    crate::util::spawn_cancel_listener()?;
    let rt = tokio::runtime::Runtime::new().context("Failed to create tokio runtime")?;
    let key = rt.block_on(await_key_action(future, Duration::from_secs(90)))?;
    emit_json(&KeyActionResponse { key })
}

pub fn receive_key(fingerprint: &str, keyserver: Option<&str>) -> Result<()> {
    let fingerprint = validate_fingerprint(fingerprint)?;
    if let Some(server) = keyserver {
        validate_keyserver(server)?;
    }
    crate::network::require_keyring_network()?;
    finish_key_action(async {
        let keyring = match keyserver {
            Some(server) => Keyring::new().with_keyserver(server),
            None => Keyring::new(),
        };
        keyring
            .receive_keys_with_options(
                &[&fingerprint],
                OperationOptions {
                    timeout_secs: Some(90),
                    cancel_token: None,
                },
            )
            .await?;
        read_key(&keyring, &fingerprint).await
    })
}

pub fn lsign_key(fingerprint: &str) -> Result<()> {
    let fingerprint = validate_fingerprint(fingerprint)?;
    finish_key_action(async {
        let keyring = Keyring::new();
        read_key(&keyring, &fingerprint).await?;
        keyring.locally_sign_key(&fingerprint).await?;
        read_key(&keyring, &fingerprint).await
    })
}

fn refresh_progress_event(progress: RefreshProgress) -> Option<StreamEvent> {
    let log = |level: &str, message: String| {
        Some(StreamEvent::Log {
            level: level.to_string(),
            message,
        })
    };
    match progress {
        RefreshProgress::Starting { total_keys } => {
            log("info", format!("Starting refresh of {} keys", total_keys))
        }
        RefreshProgress::Refreshing {
            current,
            total,
            keyid,
        } => Some(StreamEvent::Event {
            event: "Refreshing key".to_string(),
            package: Some(keyid),
            current: Some(current),
            total: Some(total),
        }),
        RefreshProgress::Completed => log("info", "Key refresh completed".to_string()),
        RefreshProgress::Error { keyid, message } => log(
            "warning",
            format!("Error refreshing key {}: {}", keyid, message),
        ),
        _ => None,
    }
}

fn refresh_stopped_message(reached: Option<(usize, usize)>) -> String {
    match reached {
        Some((current, total)) => format!("Stopped at key {} of {}", current, total),
        None => "Stopped before any key was refreshed".to_string(),
    }
}

#[cfg(test)]
mod input_tests {
    use super::*;
    #[test]
    fn key_ids_and_empty_keyservers_are_refused() {
        for fingerprint in ["12345678", "0123456789ABCDEF", "--recv-keys"] {
            assert!(
                validate_fingerprint(fingerprint)
                    .unwrap_err()
                    .is::<InvalidInput>()
            );
        }
        assert_eq!(
            validate_fingerprint("0x3B94 A80E 50A4 77C7 C8E4 4F8A 0FA8 E1BC B1F1 A2C0").unwrap(),
            "3B94A80E50A477C7C8E44F8A0FA8E1BCB1F1A2C0"
        );
        for server in [
            "hkps://",
            "hkps:///missing",
            "hkps://:",
            "hkps://?",
            "hkps://user:password@host",
            "--keyserver",
        ] {
            assert!(validate_keyserver(server).is_err());
        }
        assert!(validate_keyserver("hkps://keyserver.ubuntu.com").is_ok());
    }
}
