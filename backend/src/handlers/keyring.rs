use anyhow::{Context, Result};
use pacman_key::{
    CancellationToken, InitializationStatus, Keyring, OperationOptions, RefreshProgress,
};

use crate::alpm::validity_to_string;
use crate::models::{KeyringKey, KeyringStatusResponse, StreamEvent};
use crate::util::{emit_event, is_cancelled, setup_signal_handler};

pub fn keyring_status() -> Result<()> {
    let rt = tokio::runtime::Runtime::new().context("Failed to create tokio runtime")?;

    rt.block_on(async {
        let mut warnings: Vec<String> = Vec::new();
        let keyring = Keyring::new();

        let master_key_initialized = match keyring.is_initialized() {
            Ok(InitializationStatus::Ready) => true,
            Ok(InitializationStatus::DirectoryMissing) => {
                warnings.push(
                    "Keyring not initialized. Run 'pacman-key --init' to initialize.".to_string(),
                );
                false
            }
            Ok(InitializationStatus::PathIsSymlink) => {
                warnings.push(
                    "Security warning: keyring path is a symlink. This may be unsafe.".to_string(),
                );
                false
            }
            Ok(InitializationStatus::IncorrectPermissions { actual }) => {
                warnings.push(format!(
                    "Keyring directory has incorrect permissions: {:o} (expected 700)",
                    actual
                ));
                true
            }
            Ok(InitializationStatus::NoKeyringFiles) => {
                warnings.push("Keyring directory exists but contains no keys.".to_string());
                false
            }
            Ok(InitializationStatus::NoTrustDb) => {
                warnings.push("Keyring missing trust database.".to_string());
                false
            }
            Ok(status) => {
                warnings.push(format!("Keyring status: {:?}", status));
                false
            }
            Err(e) => {
                warnings.push(format!("Failed to check keyring status: {}", e));
                false
            }
        };

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

        let response = KeyringStatusResponse {
            total: keys.len(),
            keys,
            master_key_initialized,
            warnings,
        };

        println!("{}", serde_json::to_string(&response)?);
        Ok(())
    })
}

pub fn refresh_keyring() -> Result<()> {
    setup_signal_handler();

    if is_cancelled() {
        emit_event(&StreamEvent::Complete {
            success: false,
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

        let callback = |progress: RefreshProgress| match progress {
            RefreshProgress::Starting { total_keys } => {
                emit_event(&StreamEvent::Log {
                    level: "info".to_string(),
                    message: format!("Starting refresh of {} keys", total_keys),
                });
            }
            RefreshProgress::Refreshing {
                current,
                total,
                keyid,
            } => {
                emit_event(&StreamEvent::Log {
                    level: "info".to_string(),
                    message: format!("Refreshing key {}/{}: {}", current, total, keyid),
                });
            }
            RefreshProgress::Completed => {
                emit_event(&StreamEvent::Log {
                    level: "info".to_string(),
                    message: "Key refresh completed".to_string(),
                });
            }
            RefreshProgress::Error { keyid, message } => {
                emit_event(&StreamEvent::Log {
                    level: "warning".to_string(),
                    message: format!("Error refreshing key {}: {}", keyid, message),
                });
            }
            _ => {}
        };

        match keyring.refresh_keys(callback, options).await {
            Ok(()) => {
                emit_event(&StreamEvent::Complete {
                    success: true,
                    message: Some("Keyring refresh completed".to_string()),
                });
            }
            Err(pacman_key::Error::Cancelled) => {
                emit_event(&StreamEvent::Complete {
                    success: false,
                    message: Some("Operation cancelled by user".to_string()),
                });
            }
            Err(pacman_key::Error::Timeout(secs)) => {
                emit_event(&StreamEvent::Complete {
                    success: false,
                    message: Some(format!("Operation timed out after {} seconds", secs)),
                });
            }
            Err(e) => {
                emit_event(&StreamEvent::Complete {
                    success: false,
                    message: Some(format!("Keyring refresh failed: {}", e)),
                });
            }
        }
        Ok(())
    })
}

pub fn init_keyring() -> Result<()> {
    setup_signal_handler();

    if is_cancelled() {
        emit_event(&StreamEvent::Complete {
            success: false,
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
                    message: Some("Operation cancelled by user".to_string()),
                });
                return Ok(());
            }
            Err(pacman_key::Error::Timeout(secs)) => {
                emit_event(&StreamEvent::Complete {
                    success: false,
                    message: Some(format!("Init timed out after {} seconds", secs)),
                });
                return Ok(());
            }
            Err(e) => {
                emit_event(&StreamEvent::Complete {
                    success: false,
                    message: Some(format!("Failed to initialize keyring: {}", e)),
                });
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
                    message: Some("Keyring initialized and populated".to_string()),
                });
            }
            Err(pacman_key::Error::Cancelled) => {
                emit_event(&StreamEvent::Complete {
                    success: false,
                    message: Some("Operation cancelled by user".to_string()),
                });
            }
            Err(pacman_key::Error::Timeout(secs)) => {
                emit_event(&StreamEvent::Complete {
                    success: false,
                    message: Some(format!("Populate timed out after {} seconds", secs)),
                });
            }
            Err(e) => {
                emit_event(&StreamEvent::Complete {
                    success: false,
                    message: Some(format!("Failed to populate keyring: {}", e)),
                });
            }
        }
        Ok(())
    })
}
