mod callbacks;
mod sysupgrade;
mod transaction;

pub use callbacks::{Verbosity, interrupt_if_cancelled, setup_dl_cb, setup_log_cb};
pub use sysupgrade::{InterventionFlags, SysupgradeOutcome, run_sysupgrade};
pub use transaction::{TransactionGuard, try_interrupt};

use alpm::{Alpm, LogLevel, Progress};
use alpm_utils::alpm_with_conf;
use anyhow::{Context, Result};
use pacman_key::KeyValidity;
use pacmanconf::Config;
use std::collections::{HashMap, HashSet};

use crate::models::UpdateInfo;

pub fn get_handle() -> Result<Alpm> {
    let conf = Config::new().context("Failed to parse pacman.conf")?;
    let mut handle = alpm_with_conf(&conf).context("Failed to initialize alpm handle")?;

    // Workaround: alpm_utils uses set_hookdirs() which replaces the system hookdir
    // (/usr/share/libalpm/hooks/) that alpm_initialize() sets by default. Pacman
    // avoids this by using add_hookdir() instead. Re-add the system hookdir so
    // post-transaction hooks (mkinitcpio, depmod, systemd, etc.) are found.
    // https://github.com/archlinux/alpm.rs/issues/65
    handle
        .add_hookdir("/usr/share/libalpm/hooks/")
        .context("Failed to add system hookdir")?;

    Ok(handle)
}

pub fn resolve_file_owners(handle: &Alpm, wanted: &HashSet<String>) -> HashMap<String, String> {
    let mut owners = HashMap::new();
    if wanted.is_empty() {
        return owners;
    }

    let by_relative: HashMap<Vec<u8>, &str> = wanted
        .iter()
        .map(|path| {
            (
                path.strip_prefix('/').unwrap_or(path).as_bytes().to_vec(),
                path.as_str(),
            )
        })
        .collect();

    for pkg in handle.localdb().pkgs() {
        for file in pkg.files().files() {
            if let Some(absolute) = by_relative.get(file.name())
                && !owners.contains_key(*absolute)
            {
                owners.insert((*absolute).to_string(), pkg.name().to_string());
            }
        }
        if owners.len() == wanted.len() {
            break;
        }
    }
    owners
}

/// Find all packages with available updates by comparing local versions to sync databases.
pub fn find_available_updates(handle: &Alpm, extra_ignored: &[String]) -> Vec<UpdateInfo> {
    let localdb = handle.localdb();
    let mut updates = Vec::new();

    for pkg in localdb.pkgs() {
        for syncdb in handle.syncdbs() {
            if let Ok(syncpkg) = syncdb.pkg(pkg.name()) {
                if syncpkg.version() > pkg.version() {
                    let ignored = handle.ignorepkgs().iter().any(|n| n == pkg.name())
                        || handle.ignoregroups().iter().any(|g| {
                            handle.syncdbs().iter().any(|db| {
                                db.group(g)
                                    .map(|grp| {
                                        grp.packages().iter().any(|p| p.name() == pkg.name())
                                    })
                                    .unwrap_or(false)
                            })
                        })
                        || extra_ignored.iter().any(|n| n == pkg.name());
                    updates.push(UpdateInfo {
                        name: pkg.name().to_string(),
                        current_version: pkg.version().to_string(),
                        new_version: syncpkg.version().to_string(),
                        download_size: syncpkg.download_size(),
                        current_size: pkg.isize(),
                        new_size: syncpkg.isize(),
                        repository: syncdb.name().to_string(),
                        ignored,
                    });
                }
                break;
            }
        }
    }

    updates
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
