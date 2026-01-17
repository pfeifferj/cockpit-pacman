mod callbacks;
mod transaction;

pub use callbacks::{setup_dl_cb, setup_log_cb};
pub use transaction::TransactionGuard;

use alpm::{Alpm, LogLevel, Progress};
use alpm_utils::alpm_with_conf;
use anyhow::{Context, Result};
use pacman_key::KeyValidity;
use pacmanconf::Config;

pub fn get_handle() -> Result<Alpm> {
    let conf = Config::new().context("Failed to parse pacman.conf")?;
    alpm_with_conf(&conf).context("Failed to initialize alpm handle")
}

pub fn progress_to_string(progress: Progress) -> &'static str {
    match progress {
        Progress::AddStart => "add_start",
        Progress::UpgradeStart => "upgrade_start",
        Progress::DowngradeStart => "downgrade_start",
        Progress::ReinstallStart => "reinstall_start",
        Progress::RemoveStart => "remove_start",
        Progress::ConflictsStart => "conflicts_start",
        Progress::DiskspaceStart => "diskspace_start",
        Progress::IntegrityStart => "integrity_start",
        Progress::LoadStart => "load_start",
        Progress::KeyringStart => "keyring_start",
    }
}

pub fn reason_to_string(reason: alpm::PackageReason) -> &'static str {
    match reason {
        alpm::PackageReason::Explicit => "explicit",
        alpm::PackageReason::Depend => "dependency",
    }
}

pub fn validity_to_string(v: &KeyValidity) -> &'static str {
    match v {
        KeyValidity::Unknown => "unknown",
        KeyValidity::Undefined => "undefined",
        KeyValidity::Never => "never",
        KeyValidity::Marginal => "marginal",
        KeyValidity::Full => "full",
        KeyValidity::Ultimate => "ultimate",
        KeyValidity::Expired => "expired",
        KeyValidity::Revoked => "revoked",
        _ => "unknown",
    }
}

pub fn log_level_to_string(level: LogLevel) -> &'static str {
    match level {
        LogLevel::ERROR => "error",
        LogLevel::WARNING => "warning",
        LogLevel::DEBUG => "debug",
        LogLevel::FUNCTION => "function",
        _ => "info",
    }
}
