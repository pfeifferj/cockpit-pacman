use std::io;

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    #[error("command execution failed: {0}")]
    Command(#[from] io::Error),

    #[error("pacman-key exited with status {status}: {stderr}")]
    PacmanKey { status: i32, stderr: String },

    #[error("invalid key ID '{keyid}': {reason}")]
    InvalidKeyId { keyid: String, reason: String },

    #[error("invalid keyring name '{name}': {reason}")]
    InvalidKeyringName { name: String, reason: String },

    #[error("invalid path '{path}': {reason}")]
    InvalidPath { path: String, reason: String },

    #[error("keyring not initialized")]
    KeyringNotInitialized,

    #[error("permission denied (requires root)")]
    PermissionDenied,

    #[error("operation timed out after {0} seconds")]
    Timeout(u64),

    #[error("operation was cancelled")]
    Cancelled,
}

pub type Result<T> = std::result::Result<T, Error>;
