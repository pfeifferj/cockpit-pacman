//! Estimates space on the cache and /usr filesystems; excludes other mounts.

use std::ffi::CString;
use std::mem::MaybeUninit;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use crate::models::{DiskSpaceShortfall, PreflightWarning, WarningSeverity};
use crate::util::get_cache_dir;

const GIB: u64 = 1024 * 1024 * 1024;
const INSTALL_ROOT: &str = "/usr";

/// A filesystem as seen from one path.
#[derive(Debug, Clone, PartialEq)]
pub struct FsSpace {
    pub dev: u64,
    /// Bytes available to unprivileged writers (`f_bavail * f_frsize`).
    pub free: u64,
    pub total: u64,
    /// Mount point shown to the user.
    pub mount: String,
}

fn low_space_floor(total: u64) -> u64 {
    (total / 20).min(GIB)
}

fn format_gib(bytes: u64) -> String {
    let gib = bytes as f64 / GIB as f64;
    if gib >= 0.1 {
        format!("{:.1} GiB", gib)
    } else {
        format!("{:.0} MiB", bytes as f64 / (1024.0 * 1024.0))
    }
}

/// Decides the `disk_space` warning from measured filesystems and the
/// preview's totals. `cache` receives the download, `usr` the net installed
/// size; a negative need counts as zero.
pub fn decide(
    cache: Option<&FsSpace>,
    usr: Option<&FsSpace>,
    download: i64,
    net_installed: i64,
) -> Option<PreflightWarning> {
    let mut needs: Vec<(&FsSpace, u64)> = Vec::new();
    for (fs, need) in [(usr, net_installed), (cache, download)] {
        let (Some(fs), Ok(need)) = (fs, u64::try_from(need)) else {
            continue;
        };
        if need == 0 {
            continue;
        }
        match needs.iter_mut().find(|(f, _)| f.dev == fs.dev) {
            Some((_, total)) => *total += need,
            None => needs.push((fs, need)),
        }
    }

    let mut worst: Option<(bool, &FsSpace, u64)> = None;
    for (fs, need) in needs {
        let danger = fs.free < need;
        if !danger && fs.free - need >= low_space_floor(fs.total) {
            continue;
        }
        if worst.is_none_or(|(worst_danger, _, _)| danger && !worst_danger) {
            worst = Some((danger, fs, need));
        }
    }

    let (danger, fs, need) = worst?;
    let deficit = if danger {
        need - fs.free
    } else {
        low_space_floor(fs.total) - (fs.free - need)
    };
    let holds_cache = cache.is_some_and(|c| c.dev == fs.dev);
    let estimate = "Estimated from package sizes; files placed on other mounts are not counted.";
    let (severity, title, message) = if danger {
        (
            WarningSeverity::Danger,
            format!("Not enough free space on {}", fs.mount),
            format!(
                "Needs about {}, {} free. {estimate}",
                format_gib(need),
                format_gib(fs.free)
            ),
        )
    } else {
        (
            WarningSeverity::Warning,
            format!("Little space left on {} after this change", fs.mount),
            format!(
                "Needs about {}, {} free, leaving {}. {estimate}",
                format_gib(need),
                format_gib(fs.free),
                format_gib(fs.free - need)
            ),
        )
    };
    Some(PreflightWarning {
        id: "disk_space".to_string(),
        severity,
        title,
        message,
        packages: Vec::new(),
        blocking: danger,
        disk: Some(DiskSpaceShortfall {
            mount: fs.mount.clone(),
            deficit,
            holds_cache,
        }),
    })
}

// /proc/self/mounts uses octal escapes.
fn unescape_mount(field: &str) -> String {
    let bytes = field.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let octal = bytes
            .get(i + 1..i + 4)
            .filter(|d| d.iter().all(|b| (b'0'..=b'7').contains(b)));
        if bytes[i] == b'\\'
            && let Some(digits) = octal
        {
            out.push(
                digits
                    .iter()
                    .fold(0u8, |acc, d| acc.wrapping_mul(8).wrapping_add(d - b'0')),
            );
            i += 4;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The longest mount point in `mounts` (the text of `/proc/self/mounts`)
/// that contains `path`.
pub fn mount_point(mounts: &str, path: &Path) -> Option<String> {
    mounts
        .lines()
        .filter_map(|line| line.split_whitespace().nth(1))
        .map(unescape_mount)
        .filter(|mount| path.starts_with(mount))
        .max_by_key(|mount| mount.len())
}

fn existing_ancestor(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|p| p.exists())
        .and_then(|p| p.canonicalize().ok())
}

fn statvfs(path: &Path) -> Option<(u64, u64)> {
    let c_path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stat = MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: c_path is NUL-terminated and stat is a valid out pointer.
    if unsafe { libc::statvfs(c_path.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return None;
    }
    // SAFETY: statvfs returned 0, so it filled the struct.
    let stat = unsafe { stat.assume_init() };
    let frsize = stat.f_frsize;
    Some((
        stat.f_bavail.saturating_mul(frsize),
        stat.f_blocks.saturating_mul(frsize),
    ))
}

/// Measures the filesystem holding `path`, or its nearest existing ancestor.
pub fn measure(path: &Path, mounts: &str) -> Option<FsSpace> {
    let path = existing_ancestor(path)?;
    let dev = std::fs::metadata(&path).ok()?.dev();
    let (free, total) = statvfs(&path)?;
    let mount = mount_point(mounts, &path).unwrap_or_else(|| path.to_string_lossy().into_owned());
    Some(FsSpace {
        dev,
        free,
        total,
        mount,
    })
}

/// The `disk_space` warning for a transaction that downloads `download`
/// bytes into the pacman cache and grows the installed size by
/// `net_installed`. Filesystems that cannot be measured are skipped.
pub fn check(download: i64, net_installed: i64) -> Option<PreflightWarning> {
    if download <= 0 && net_installed <= 0 {
        return None;
    }
    let mounts = std::fs::read_to_string("/proc/self/mounts").unwrap_or_default();
    let cache = measure(Path::new(&get_cache_dir()), &mounts);
    let usr = measure(Path::new(INSTALL_ROOT), &mounts);
    decide(cache.as_ref(), usr.as_ref(), download, net_installed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fs(dev: u64, free: u64, total: u64, mount: &str) -> FsSpace {
        FsSpace {
            dev,
            free,
            total,
            mount: mount.to_string(),
        }
    }

    fn shortfall(mount: &str, deficit: u64, holds_cache: bool) -> Option<DiskSpaceShortfall> {
        Some(DiskSpaceShortfall {
            mount: mount.to_string(),
            deficit,
            holds_cache,
        })
    }

    fn outcome(
        cache: Option<&FsSpace>,
        usr: Option<&FsSpace>,
        download: u64,
        net_installed: u64,
    ) -> Option<(bool, Option<DiskSpaceShortfall>)> {
        decide(cache, usr, download as i64, net_installed as i64).map(|w| (w.blocking, w.disk))
    }

    #[test]
    fn shared_filesystem_blocks_and_holds_the_cache() {
        let root = fs(1, 2 * GIB, 100 * GIB, "/");
        assert_eq!(
            outcome(Some(&root), Some(&root), GIB, 2 * GIB),
            Some((true, shortfall("/", GIB, true)))
        );
    }

    #[test]
    fn short_usr_on_its_own_filesystem_does_not_hold_the_cache() {
        let usr = fs(1, GIB, 100 * GIB, "/usr");
        let cache = fs(2, 50 * GIB, 100 * GIB, "/var/cache");
        assert_eq!(
            outcome(Some(&cache), Some(&usr), GIB, 3 * GIB),
            Some((true, shortfall("/usr", 2 * GIB, false)))
        );
    }

    #[test]
    fn short_cache_on_its_own_filesystem_holds_the_cache() {
        let usr = fs(1, 50 * GIB, 100 * GIB, "/usr");
        let cache = fs(2, GIB, 100 * GIB, "/var/cache");
        assert_eq!(
            outcome(Some(&cache), Some(&usr), 2 * GIB, GIB),
            Some((true, shortfall("/var/cache", GIB, true)))
        );
    }

    #[test]
    fn low_space_warning_does_not_block_and_names_the_floor_deficit() {
        let usr = fs(1, 2 * GIB, 100 * GIB, "/");
        let cache = fs(2, 50 * GIB, 100 * GIB, "/var/cache");
        assert_eq!(
            outcome(Some(&cache), Some(&usr), GIB, GIB + GIB / 2),
            Some((false, shortfall("/", GIB / 2, false)))
        );
    }

    #[test]
    fn unmeasured_cache_is_not_claimed() {
        let usr = fs(1, GIB, 100 * GIB, "/");
        assert_eq!(
            outcome(None, Some(&usr), 0, 2 * GIB),
            Some((true, shortfall("/", GIB, false)))
        );
    }
}
