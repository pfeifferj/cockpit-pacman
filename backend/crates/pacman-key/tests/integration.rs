use pacman_key::{Error, KeyValidity, Keyring, ReadOnlyKeyring};

#[tokio::test]
#[ignore]
async fn test_list_keys_real() {
    let keyring = Keyring::new();
    let keys = keyring.list_keys().await.expect("failed to list keys");

    assert!(!keys.is_empty(), "pacman keyring should contain keys");

    for key in &keys {
        assert!(!key.fingerprint.is_empty(), "key should have fingerprint");
        assert_eq!(
            key.fingerprint.len(),
            40,
            "fingerprint should be 40 hex chars"
        );
        assert!(
            key.fingerprint.chars().all(|c| c.is_ascii_hexdigit()),
            "fingerprint should be hex"
        );
        assert!(key.key_type.bits > 0, "key should have valid bit length");
    }

    let has_arch_key = keys.iter().any(|k| k.uid.contains("archlinux.org"));
    assert!(has_arch_key, "should find at least one archlinux.org key");
}

#[tokio::test]
#[ignore]
async fn test_list_signatures_real() {
    let keyring = Keyring::new();
    let keys = keyring.list_keys().await.expect("failed to list keys");

    assert!(!keys.is_empty(), "need keys to test signatures");

    let first_key = &keys[0];
    let sigs = keyring
        .list_signatures(Some(&first_key.fingerprint))
        .await
        .expect("failed to list signatures");

    for sig in &sigs {
        assert!(!sig.keyid.is_empty(), "signature should have keyid");
    }
}

#[tokio::test]
#[ignore]
async fn test_key_validity_levels() {
    let keyring = Keyring::new();
    let keys = keyring.list_keys().await.expect("failed to list keys");

    let validity_counts: std::collections::HashMap<_, usize> =
        keys.iter()
            .fold(std::collections::HashMap::new(), |mut acc, k| {
                *acc.entry(k.validity).or_insert(0) += 1;
                acc
            });

    println!("Validity level distribution:");
    for (validity, count) in &validity_counts {
        println!("  {:?}: {}", validity, count);
    }

    let has_valid_key = keys.iter().any(|k| {
        matches!(
            k.validity,
            KeyValidity::Full | KeyValidity::Ultimate | KeyValidity::Marginal
        )
    });
    assert!(has_valid_key, "should have at least one valid key");
}

#[tokio::test]
#[ignore]
async fn test_keyring_not_found() {
    let keyring = Keyring::with_homedir("/nonexistent/path");
    let result = keyring.list_keys().await;

    assert!(result.is_err(), "should fail for nonexistent keyring");
}

#[tokio::test]
async fn test_invalid_keyid_empty() {
    let keyring = Keyring::new();
    let result = keyring.list_signatures(Some("")).await;

    assert!(matches!(result, Err(Error::InvalidKeyId { .. })));
}

#[tokio::test]
async fn test_invalid_keyid_wrong_length() {
    let keyring = Keyring::new();
    let result = keyring.list_signatures(Some("ABC")).await;

    assert!(matches!(result, Err(Error::InvalidKeyId { .. })));
}

#[tokio::test]
async fn test_invalid_keyid_non_hex() {
    let keyring = Keyring::new();
    let result = keyring.list_signatures(Some("GHIJKLMN")).await;

    assert!(matches!(result, Err(Error::InvalidKeyId { .. })));
}

#[tokio::test]
async fn test_valid_keyid_formats() {
    let keyring = Keyring::with_homedir("/nonexistent");

    let result_short = keyring.list_signatures(Some("DEADBEEF")).await;
    assert!(!matches!(result_short, Err(Error::InvalidKeyId { .. })));

    let result_long = keyring.list_signatures(Some("786C63F330D7CB92")).await;
    assert!(!matches!(result_long, Err(Error::InvalidKeyId { .. })));

    let result_fingerprint = keyring
        .list_signatures(Some("ABAF11C65A2970B130ABE3C479BE3E4300411886"))
        .await;
    assert!(!matches!(
        result_fingerprint,
        Err(Error::InvalidKeyId { .. })
    ));

    let result_prefixed = keyring.list_signatures(Some("0xDEADBEEF")).await;
    assert!(!matches!(result_prefixed, Err(Error::InvalidKeyId { .. })));
}

#[tokio::test]
async fn test_receive_keys_empty_list() {
    let keyring = Keyring::new();
    let result = keyring.receive_keys(&[]).await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn test_receive_keys_invalid_keyid() {
    let keyring = Keyring::new();
    let result = keyring.receive_keys(&["invalid"]).await;
    assert!(matches!(result, Err(Error::InvalidKeyId { .. })));
}

#[tokio::test]
async fn test_populate_invalid_keyring_name() {
    let keyring = Keyring::new();
    let result = keyring.populate(&[""]).await;
    assert!(matches!(result, Err(Error::InvalidKeyringName { .. })));
}

#[tokio::test]
async fn test_populate_command_injection_attempt() {
    let keyring = Keyring::new();

    let result = keyring.populate(&["$(whoami)"]).await;
    assert!(matches!(result, Err(Error::InvalidKeyringName { .. })));

    let result = keyring.populate(&["arch;linux"]).await;
    assert!(matches!(result, Err(Error::InvalidKeyringName { .. })));

    let result = keyring.populate(&["arch&rm -rf /"]).await;
    assert!(matches!(result, Err(Error::InvalidKeyringName { .. })));

    let result = keyring.populate(&["arch|cat /etc/passwd"]).await;
    assert!(matches!(result, Err(Error::InvalidKeyringName { .. })));

    let result = keyring.populate(&["arch`id`"]).await;
    assert!(matches!(result, Err(Error::InvalidKeyringName { .. })));
}

#[test]
fn test_with_homedir_returns_readonly_keyring() {
    let reader: ReadOnlyKeyring = Keyring::with_homedir("/tmp/test-keyring");
    let _ = reader;
}
