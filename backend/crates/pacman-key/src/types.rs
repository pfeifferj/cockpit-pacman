use chrono::NaiveDate;
pub use tokio_util::sync::CancellationToken;

/// Result of [`crate::ReadOnlyKeyring::is_initialized`].
/// Checks are non-atomic; the result is informational only.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum InitializationStatus {
    /// Keyring is fully initialized and ready for use.
    Ready,
    /// The keyring directory does not exist.
    DirectoryMissing,
    /// Path exists but is a regular file, not a directory.
    PathIsFile,
    /// Directory exists but contains no keyring files (pubring.kbx or pubring.gpg).
    NoKeyringFiles,
    /// Directory exists but trustdb.gpg is missing.
    NoTrustDb,
    /// Directory exists but has incorrect permissions
    /// (`pacman-key --init` creates it 755).
    IncorrectPermissions { actual: u32 },
}

/// A GPG key from the pacman keyring.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Key {
    pub fingerprint: String,
    pub uid: String,
    pub created: Option<NaiveDate>,
    pub expires: Option<NaiveDate>,
    pub validity: KeyValidity,
    pub key_type: KeyType,
    /// Capabilities of the primary key itself (sign/certify/encrypt/auth).
    pub usage: KeyUsage,
    /// Subkeys attached to this primary key.
    pub subkeys: Vec<Subkey>,
}

/// A subkey attached to a primary key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subkey {
    pub fingerprint: String,
    pub key_type: KeyType,
    pub created: Option<NaiveDate>,
    pub expires: Option<NaiveDate>,
    pub usage: KeyUsage,
}

/// Key capabilities parsed from GPG's capability field.
///
/// Derived from the lowercase letters in the `--with-colons` capability field
/// (field 12), which describe what the key itself can do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct KeyUsage {
    pub sign: bool,
    pub certify: bool,
    pub encrypt: bool,
    pub authenticate: bool,
}

/// The cryptographic algorithm and key size.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyType {
    pub algorithm: String,
    pub bits: u32,
}

impl std::fmt::Display for KeyType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}{}", self.algorithm.to_lowercase(), self.bits)
    }
}

/// GPG's computed key validity, distinct from the owner's trust to sign other keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
#[non_exhaustive]
pub enum KeyValidity {
    /// Validity unknown (new key or insufficient data)
    #[default]
    Unknown,
    /// Validity undefined (not yet computed)
    Undefined,
    /// Key is explicitly distrusted
    Never,
    /// Marginally valid (some trust path exists)
    Marginal,
    /// Fully valid (strong trust path)
    Full,
    /// Ultimately valid (user's own key or explicitly trusted)
    Ultimate,
    /// Key has expired
    Expired,
    /// Key has been revoked
    Revoked,
    /// Key has been disabled
    Disabled,
    /// Key is invalid (e.g. missing self-signature)
    Invalid,
}

impl KeyValidity {
    pub fn from_gpg_char(c: char) -> Self {
        match c {
            'o' => Self::Unknown,
            'q' => Self::Undefined,
            'n' => Self::Never,
            'm' => Self::Marginal,
            'f' => Self::Full,
            'u' => Self::Ultimate,
            'e' => Self::Expired,
            'r' => Self::Revoked,
            'd' => Self::Disabled,
            'i' => Self::Invalid,
            _ => Self::Unknown,
        }
    }
}

/// A signature on a key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Signature {
    pub keyid: String,
    pub uid: String,
    pub created: Option<NaiveDate>,
    pub expires: Option<NaiveDate>,
    pub sig_class: String,
    /// Verification status, populated only by `check_signatures` (`--check-sigs`).
    /// `None` for the non-checking `list_signatures` (`--list-sigs`).
    pub status: Option<SigStatus>,
}

/// Verification status of a signature, from GPG's `--check-sigs` output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SigStatus {
    /// Signature verified good (`!`).
    Good,
    /// Signature is bad (`-`).
    Bad,
    /// Signing key is not in the local keyring (`?`).
    MissingKey,
    /// Other verification error (`%`).
    Error,
}

impl SigStatus {
    /// Maps a GPG `--check-sigs` field-2 marker to a status. Empty (non-checking
    /// `--list-sigs`) yields `None`.
    pub fn from_gpg_marker(marker: &str) -> Option<Self> {
        match marker {
            "!" => Some(Self::Good),
            "-" => Some(Self::Bad),
            "?" => Some(Self::MissingKey),
            "%" => Some(Self::Error),
            _ => None,
        }
    }
}

/// Result of verifying a signature with [`ReadOnlyKeyring::verify_signature`].
///
/// [`ReadOnlyKeyring::verify_signature`]: crate::ReadOnlyKeyring::verify_signature
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyResult {
    /// The signature is cryptographically valid (`GOODSIG`/`VALIDSIG`).
    pub good: bool,
    /// The signing key is trusted fully or ultimately (`TRUST_FULLY`/`TRUST_ULTIMATE`).
    /// pacman considers a package signature acceptable only when this is true.
    pub trusted: bool,
    /// Fingerprint of the signing key, if reported (`VALIDSIG`).
    pub key_fpr: Option<String>,
    /// User ID of the signer, if reported (`GOODSIG`).
    pub uid: Option<String>,
}

/// GPG owner trust level (how much the key owner is trusted to sign other keys).
///
/// Distinct from [`KeyValidity`], which is the computed validity of a key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnerTrust {
    /// No owner trust assigned.
    Unknown,
    /// Trust undefined.
    Undefined,
    /// Explicitly never trust.
    Never,
    /// Marginal trust.
    Marginal,
    /// Full trust.
    Full,
    /// Ultimate trust (own keys).
    Ultimate,
}

impl OwnerTrust {
    /// Parses a numeric level from `gpg --export-ownertrust` output.
    pub fn from_gpg_level(level: &str) -> Self {
        match level {
            "2" => Self::Undefined,
            "3" => Self::Never,
            "4" => Self::Marginal,
            "5" => Self::Full,
            "6" => Self::Ultimate,
            _ => Self::Unknown,
        }
    }

    /// The numeric level for `gpg --import-ownertrust` input.
    pub fn to_gpg_level(self) -> u8 {
        match self {
            Self::Unknown => 1,
            Self::Undefined => 2,
            Self::Never => 3,
            Self::Marginal => 4,
            Self::Full => 5,
            Self::Ultimate => 6,
        }
    }
}

/// Progress updates during key refresh operations.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum RefreshProgress {
    Starting {
        total_keys: usize,
    },
    Refreshing {
        current: usize,
        total: usize,
        keyid: String,
    },
    Completed,
    Error {
        keyid: String,
        message: String,
    },
}

/// Timeout and cancellation options for subprocess operations.
#[derive(Debug, Clone, Default)]
pub struct OperationOptions {
    /// Timeout for the operation, in seconds.
    /// If None or 0, no timeout is applied.
    pub timeout_secs: Option<u64>,
    /// Cancellation token for aborting the operation.
    /// When cancelled, the subprocess is terminated and `Error::Cancelled` is returned.
    pub cancel_token: Option<CancellationToken>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_key_validity_from_gpg_char() {
        assert_eq!(KeyValidity::from_gpg_char('o'), KeyValidity::Unknown);
        assert_eq!(KeyValidity::from_gpg_char('q'), KeyValidity::Undefined);
        assert_eq!(KeyValidity::from_gpg_char('n'), KeyValidity::Never);
        assert_eq!(KeyValidity::from_gpg_char('m'), KeyValidity::Marginal);
        assert_eq!(KeyValidity::from_gpg_char('f'), KeyValidity::Full);
        assert_eq!(KeyValidity::from_gpg_char('u'), KeyValidity::Ultimate);
        assert_eq!(KeyValidity::from_gpg_char('e'), KeyValidity::Expired);
        assert_eq!(KeyValidity::from_gpg_char('r'), KeyValidity::Revoked);
        assert_eq!(KeyValidity::from_gpg_char('d'), KeyValidity::Disabled);
        assert_eq!(KeyValidity::from_gpg_char('i'), KeyValidity::Invalid);
        assert_eq!(KeyValidity::from_gpg_char('x'), KeyValidity::Unknown);
        assert_eq!(KeyValidity::from_gpg_char('-'), KeyValidity::Unknown);
    }

    #[test]
    fn test_ownertrust_roundtrip() {
        for t in [
            OwnerTrust::Undefined,
            OwnerTrust::Never,
            OwnerTrust::Marginal,
            OwnerTrust::Full,
            OwnerTrust::Ultimate,
        ] {
            let level = t.to_gpg_level().to_string();
            assert_eq!(OwnerTrust::from_gpg_level(&level), t);
        }
        assert_eq!(OwnerTrust::from_gpg_level(""), OwnerTrust::Unknown);
    }

    #[test]
    fn test_sig_status_marker() {
        assert_eq!(SigStatus::from_gpg_marker("!"), Some(SigStatus::Good));
        assert_eq!(SigStatus::from_gpg_marker("-"), Some(SigStatus::Bad));
        assert_eq!(SigStatus::from_gpg_marker("?"), Some(SigStatus::MissingKey));
        assert_eq!(SigStatus::from_gpg_marker("%"), Some(SigStatus::Error));
        assert_eq!(SigStatus::from_gpg_marker(""), None);
    }
}
