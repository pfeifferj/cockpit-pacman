use anyhow::{Context, Result};
use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::OwnedFd;

const LOGIND_DEST: &str = "org.freedesktop.login1";
const LOGIND_PATH: &str = "/org/freedesktop/login1";
const LOGIND_MANAGER_IFACE: &str = "org.freedesktop.login1.Manager";

/// A held logind block inhibitor; dropping the fd releases it. Makes
/// logind-mediated shutdowns wait for the commit, closing the reboot window
/// that SendSIGKILL=no leaves open (`reboot -f` and power loss still bypass it).
pub struct ShutdownInhibitor {
    _fd: OwnedFd,
}

impl ShutdownInhibitor {
    /// Best-effort: returns None (commit still runs) if logind is unavailable.
    pub fn take(why: &str) -> Option<Self> {
        match Self::try_take(why) {
            Ok(guard) => Some(guard),
            Err(e) => {
                eprintln!("shutdown inhibitor unavailable ({e:#}); proceeding without it");
                None
            }
        }
    }

    fn try_take(why: &str) -> Result<Self> {
        let conn = Connection::system().context("connect to system bus")?;
        let proxy = Proxy::new(&conn, LOGIND_DEST, LOGIND_PATH, LOGIND_MANAGER_IFACE)
            .context("create logind Manager proxy")?;
        let fd: OwnedFd = proxy
            .call("Inhibit", &("shutdown", "cockpit-pacman", why, "block"))
            .context("call login1 Inhibit")?;
        Ok(Self { _fd: fd })
    }
}
