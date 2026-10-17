//! Rust interface to pacman-key and GPG on Arch Linux.
//!
//! # Example
//!
//! ```no_run
//! use pacman_key::Keyring;
//!
//! #[tokio::main]
//! async fn main() -> pacman_key::Result<()> {
//!     let keyring = Keyring::new();
//!
//!     let keys = keyring.list_keys().await?;
//!     for key in keys {
//!         println!("{}: {}", &key.fingerprint[..16], key.uid);
//!     }
//!
//!     Ok(())
//! }
//! ```
//!
//! # Requirements
//!
//! - Arch Linux with `pacman-key` available
//! - Root access for write operations (init, populate, sign, delete)
//! - Read access to `/etc/pacman.d/gnupg` for list operations

mod error;
mod keyring;
mod parse;
mod process;
mod types;
mod validation;

pub use error::{Error, Result};
pub use keyring::{Keyring, ReadOnlyKeyring};
pub use types::{
    CancellationToken, InitializationStatus, Key, KeyType, KeyUsage, KeyValidity, OperationOptions,
    OwnerTrust, RefreshProgress, SigStatus, Signature, Subkey, VerifyResult,
};
