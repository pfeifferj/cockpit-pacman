use anyhow::{Context, Result};
use std::collections::HashSet;
use std::fs;
use std::io::ErrorKind;

use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::{OwnedObjectPath, OwnedValue};

use crate::alpm::{build_file_owner_index, get_handle, lookup_file_owner};
use crate::models::{RestartBlocked, ServiceRestart, ServicesStatus};
use crate::util::emit_json;

const WATCHED_PREFIXES: &[&str] = &["/usr/lib", "/usr/lib64", "/usr/bin", "/usr/sbin"];

const REBOOT_PACKAGES: &[&str] = &[
    "linux",
    "linux-lts",
    "linux-zen",
    "linux-hardened",
    "systemd",
    "linux-firmware",
    "amd-ucode",
    "intel-ucode",
];

// `graphical.target` is deliberately not a sentinel: it transitively
// Requires multi-user.target and pulls the whole boot tree into the set.
const SENTINELS: &[&str] = &["display-manager.service"];

// Listed explicitly (not only via the dep-graph) so headless hosts
// without a display manager still tag these.
const COCKPIT_SESSION_CRITICAL: &[&str] = &[
    "cockpit.service",
    "cockpit.socket",
    "polkit.service",
    "dbus.service",
    "dbus-broker.service",
    "systemd-logind.service",
];

// Frontend honours this tag only when the UI is reached over the network.
const COCKPIT_TRANSPORT_CRITICAL: &[&str] = &["wpa_supplicant.service", "iwd.service"];

// Strong edges only. Wants/PartOf/Requisite over-broaden the closure.
const DEP_PROPERTIES: &[&str] = &["Requires", "BindsTo"];

const SYSTEMD_DEST: &str = "org.freedesktop.systemd1";
const SYSTEMD_MANAGER_PATH: &str = "/org/freedesktop/systemd1";
const SYSTEMD_MANAGER_IFACE: &str = "org.freedesktop.systemd1.Manager";
const SYSTEMD_UNIT_IFACE: &str = "org.freedesktop.systemd1.Unit";
const SYSTEMD_SERVICE_IFACE: &str = "org.freedesktop.systemd1.Service";
const DBUS_PROPS_IFACE: &str = "org.freedesktop.DBus.Properties";

fn parse_maps_line(line: &str) -> Option<String> {
    let path = line.splitn(6, char::is_whitespace).nth(5)?.trim_start();
    let stripped = path.strip_suffix(" (deleted)")?;
    if !WATCHED_PREFIXES.iter().any(|p| stripped.starts_with(p)) {
        return None;
    }
    Some(stripped.to_string())
}

fn all_owners_are_reboot_packages(owners: &[String]) -> bool {
    !owners.is_empty() && owners.iter().all(|p| REBOOT_PACKAGES.contains(&p.as_str()))
}

fn tag_restart_blocked(unit: &str, session_critical: &HashSet<String>) -> Option<RestartBlocked> {
    if session_critical.contains(unit) {
        Some(RestartBlocked::SessionCritical)
    } else if COCKPIT_SESSION_CRITICAL.contains(&unit) {
        Some(RestartBlocked::CockpitSession)
    } else if COCKPIT_TRANSPORT_CRITICAL.contains(&unit) {
        Some(RestartBlocked::CockpitTransport)
    } else {
        None
    }
}

trait SystemdGraph {
    fn forward_deps(&self, unit: &str) -> Result<Vec<String>>;
    fn running_user_services(&self) -> Result<Vec<String>>;
    fn running_services_with_pids(&self) -> Result<Vec<(String, Option<u32>)>>;
}

fn compute_session_critical_set<G: SystemdGraph>(graph: &G) -> Result<HashSet<String>> {
    let mut set: HashSet<String> = HashSet::new();
    let mut work: Vec<String> = SENTINELS.iter().map(|s| s.to_string()).collect();
    work.extend(graph.running_user_services()?);
    while let Some(unit) = work.pop() {
        if !set.insert(unit.clone()) {
            continue;
        }
        for dep in graph.forward_deps(&unit)? {
            work.push(dep);
        }
    }
    Ok(set)
}

struct ZbusSystemdGraph {
    conn: Connection,
}

impl ZbusSystemdGraph {
    fn connect() -> Result<Self> {
        let conn = Connection::system().context("Failed to connect to system bus")?;
        Ok(Self { conn })
    }

    fn manager_proxy(&self) -> Result<Proxy<'_>> {
        Proxy::new(
            &self.conn,
            SYSTEMD_DEST,
            SYSTEMD_MANAGER_PATH,
            SYSTEMD_MANAGER_IFACE,
        )
        .context("Failed to create systemd Manager proxy")
    }

    fn load_unit_path(&self, unit: &str) -> Option<OwnedObjectPath> {
        let proxy = self.manager_proxy().ok()?;
        proxy.call("LoadUnit", &(unit)).ok()
    }

    fn list_by_patterns(
        &self,
        states: &[&str],
        patterns: &[&str],
    ) -> Result<Vec<(String, OwnedObjectPath)>> {
        let proxy = self.manager_proxy()?;
        let states: Vec<String> = states.iter().map(|s| s.to_string()).collect();
        let patterns: Vec<String> = patterns.iter().map(|s| s.to_string()).collect();
        // ListUnitsByPatterns returns a(ssssssouso); we only keep name + object path.
        type UnitTuple = (
            String,
            String,
            String,
            String,
            String,
            String,
            OwnedObjectPath,
            u32,
            String,
            OwnedObjectPath,
        );
        let units: Vec<UnitTuple> = proxy
            .call("ListUnitsByPatterns", &(states, patterns))
            .context("ListUnitsByPatterns failed")?;
        Ok(units.into_iter().map(|u| (u.0, u.6)).collect())
    }

    fn props_proxy<'p>(&'p self, path: &OwnedObjectPath) -> Result<Proxy<'p>> {
        Proxy::new(&self.conn, SYSTEMD_DEST, path.clone(), DBUS_PROPS_IFACE)
            .context("Failed to create Properties proxy")
    }

    fn get_unit_string_array(&self, path: &OwnedObjectPath, prop: &str) -> Vec<String> {
        let Ok(proxy) = self.props_proxy(path) else {
            return Vec::new();
        };
        let value: Result<OwnedValue, _> = proxy.call("Get", &(SYSTEMD_UNIT_IFACE, prop));
        let Ok(value) = value else {
            return Vec::new();
        };
        Vec::<String>::try_from(value).unwrap_or_default()
    }

    fn get_service_main_pid(&self, path: &OwnedObjectPath) -> Option<u32> {
        let proxy = self.props_proxy(path).ok()?;
        let value: OwnedValue = proxy
            .call("Get", &(SYSTEMD_SERVICE_IFACE, "MainPID"))
            .ok()?;
        u32::try_from(value).ok().filter(|p| *p > 0)
    }
}

impl SystemdGraph for ZbusSystemdGraph {
    fn forward_deps(&self, unit: &str) -> Result<Vec<String>> {
        let Some(path) = self.load_unit_path(unit) else {
            return Ok(Vec::new());
        };
        let mut all = Vec::new();
        for prop in DEP_PROPERTIES {
            all.extend(self.get_unit_string_array(&path, prop));
        }
        Ok(all)
    }

    fn running_user_services(&self) -> Result<Vec<String>> {
        let units = self.list_by_patterns(&["running"], &["user@*.service"])?;
        Ok(units.into_iter().map(|(name, _)| name).collect())
    }

    fn running_services_with_pids(&self) -> Result<Vec<(String, Option<u32>)>> {
        let units = self.list_by_patterns(&["running"], &["*.service"])?;
        Ok(units
            .into_iter()
            .filter(|(name, _)| !name.starts_with("user@"))
            .map(|(name, path)| (name, self.get_service_main_pid(&path)))
            .collect())
    }
}

pub fn get_services_status() -> Result<()> {
    let status = match ZbusSystemdGraph::connect() {
        Ok(graph) => services_status_with_graph(&graph)?,
        Err(e) => {
            eprintln!("services-status: zbus connect failed ({e}); returning empty");
            ServicesStatus {
                restart_required: false,
                services: Vec::new(),
            }
        }
    };
    emit_json(&status)
}

fn services_status_with_graph<G: SystemdGraph>(graph: &G) -> Result<ServicesStatus> {
    let session_critical = match compute_session_critical_set(graph) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("services-status: closure computation failed ({e}); returning empty");
            return Ok(ServicesStatus {
                restart_required: false,
                services: Vec::new(),
            });
        }
    };

    let handle = get_handle()?;
    let file_owner_index = build_file_owner_index(&handle);
    let mut services = Vec::new();

    for (unit, pid) in graph.running_services_with_pids()? {
        let Some(pid) = pid else {
            continue;
        };

        let maps = match fs::read_to_string(format!("/proc/{}/maps", pid)) {
            Ok(m) => m,
            Err(e) if e.kind() == ErrorKind::PermissionDenied => continue,
            Err(e) if e.kind() == ErrorKind::NotFound => continue,
            Err(e) => return Err(e).context(format!("Failed to read /proc/{}/maps", pid)),
        };

        let mut deleted_paths: HashSet<String> = HashSet::new();
        for line in maps.lines() {
            if let Some(path) = parse_maps_line(line) {
                deleted_paths.insert(path);
            }
        }
        if deleted_paths.is_empty() {
            continue;
        }

        let mut owners_seen: HashSet<String> = HashSet::new();
        let mut affected_packages: Vec<String> = Vec::new();
        for path in &deleted_paths {
            if let Some(owner) = lookup_file_owner(&file_owner_index, path)
                && owners_seen.insert(owner.to_string())
            {
                affected_packages.push(owner.to_string());
            }
        }

        if all_owners_are_reboot_packages(&affected_packages) {
            continue;
        }

        affected_packages.sort();
        services.push(ServiceRestart {
            name: unit.clone(),
            pid,
            affected_packages,
            reason: "deleted_mappings".to_string(),
            restart_blocked: tag_restart_blocked(&unit, &session_critical),
        });
    }

    Ok(ServicesStatus {
        restart_required: !services.is_empty(),
        services,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn parse_maps_line_detects_deleted_lib() {
        let line = "7f5e4c000000-7f5e4c100000 r-xp 00000000 00:00 0 /usr/lib/libssl.so.3 (deleted)";
        assert_eq!(
            parse_maps_line(line),
            Some("/usr/lib/libssl.so.3".to_string())
        );
    }

    #[test]
    fn parse_maps_line_detects_deleted_lib64() {
        let line =
            "7f5e4c000000-7f5e4c100000 r-xp 00000000 00:00 0 /usr/lib64/libfoo.so.1 (deleted)";
        assert_eq!(
            parse_maps_line(line),
            Some("/usr/lib64/libfoo.so.1".to_string())
        );
    }

    #[test]
    fn parse_maps_line_detects_deleted_bin() {
        let line = "55abc0000000-55abc0100000 r-xp 00000000 00:00 0 /usr/bin/nginx (deleted)";
        assert_eq!(parse_maps_line(line), Some("/usr/bin/nginx".to_string()));
    }

    #[test]
    fn parse_maps_line_detects_deleted_sbin() {
        let line = "55abc0000000-55abc0100000 r-xp 00000000 00:00 0 /usr/sbin/sshd (deleted)";
        assert_eq!(parse_maps_line(line), Some("/usr/sbin/sshd".to_string()));
    }

    #[test]
    fn parse_maps_line_ignores_non_deleted() {
        let line = "7f5e4c000000-7f5e4c100000 r-xp 00000000 00:00 0 /usr/lib/libssl.so.3";
        assert_eq!(parse_maps_line(line), None);
    }

    #[test]
    fn parse_maps_line_ignores_memfd() {
        let line = "7f5e4c000000-7f5e4c100000 rw-p 00000000 00:00 0 /memfd:foo (deleted)";
        assert_eq!(parse_maps_line(line), None);
    }

    #[test]
    fn parse_maps_line_ignores_dev_shm() {
        let line = "7f5e4c000000-7f5e4c100000 rw-p 00000000 00:00 0 /dev/shm/bar (deleted)";
        assert_eq!(parse_maps_line(line), None);
    }

    #[test]
    fn parse_maps_line_ignores_anonymous_trailing_space() {
        let line = "7f5e4c000000-7f5e4c100000 rw-p 00000000 00:00 0 ";
        assert_eq!(parse_maps_line(line), None);
    }

    #[test]
    fn parse_maps_line_ignores_anonymous_no_path() {
        let line = "7f5e4c000000-7f5e4c100000 rw-p 00000000 00:00 0";
        assert_eq!(parse_maps_line(line), None);
    }

    #[test]
    fn parse_maps_line_ignores_unwatched_path() {
        let line = "7f5e4c000000-7f5e4c100000 r-xp 00000000 00:00 0 /opt/custom/lib.so (deleted)";
        assert_eq!(parse_maps_line(line), None);
    }

    #[test]
    fn reboot_package_filter_excludes_kernel_only_service() {
        let owners = vec!["linux".to_string()];
        assert!(all_owners_are_reboot_packages(&owners));
    }

    #[test]
    fn reboot_package_filter_excludes_systemd_only_service() {
        let owners = vec!["systemd".to_string(), "linux-firmware".to_string()];
        assert!(all_owners_are_reboot_packages(&owners));
    }

    #[test]
    fn reboot_package_filter_keeps_mixed_service() {
        let owners = vec!["openssl".to_string(), "linux".to_string()];
        assert!(!all_owners_are_reboot_packages(&owners));
    }

    #[test]
    fn reboot_package_filter_keeps_non_reboot_service() {
        let owners = vec!["openssl".to_string(), "pcre2".to_string()];
        assert!(!all_owners_are_reboot_packages(&owners));
    }

    #[test]
    fn reboot_package_filter_keeps_empty_owners() {
        let owners: Vec<String> = vec![];
        assert!(!all_owners_are_reboot_packages(&owners));
    }

    struct FakeGraph {
        deps: HashMap<String, Vec<String>>,
        user_services: Vec<String>,
    }

    impl FakeGraph {
        fn new() -> Self {
            Self {
                deps: HashMap::new(),
                user_services: Vec::new(),
            }
        }

        fn edge(mut self, from: &str, to: &[&str]) -> Self {
            self.deps
                .insert(from.to_string(), to.iter().map(|s| s.to_string()).collect());
            self
        }

        fn user(mut self, u: &str) -> Self {
            self.user_services.push(u.to_string());
            self
        }
    }

    impl SystemdGraph for FakeGraph {
        fn forward_deps(&self, unit: &str) -> Result<Vec<String>> {
            Ok(self.deps.get(unit).cloned().unwrap_or_default())
        }

        fn running_user_services(&self) -> Result<Vec<String>> {
            Ok(self.user_services.clone())
        }

        fn running_services_with_pids(&self) -> Result<Vec<(String, Option<u32>)>> {
            Ok(Vec::new())
        }
    }

    #[test]
    fn fake_graph_pulls_dbus_via_dm_requires() {
        let g = FakeGraph::new().edge(
            "display-manager.service",
            &["dbus.service", "systemd-logind.service"],
        );
        let set = compute_session_critical_set(&g).unwrap();
        assert!(set.contains("display-manager.service"));
        assert!(set.contains("dbus.service"));
        assert!(set.contains("systemd-logind.service"));
    }

    #[test]
    fn fake_graph_excludes_regular_services() {
        let g = FakeGraph::new().edge("display-manager.service", &["dbus.service"]);
        let set = compute_session_critical_set(&g).unwrap();
        assert!(!set.contains("nginx.service"));
        assert!(!set.contains("sshd.service"));
        assert!(!set.contains("systemd-journald.service"));
        assert!(!set.contains("NetworkManager.service"));
    }

    #[test]
    fn fake_graph_includes_running_user_instances() {
        let g = FakeGraph::new()
            .user("user@1000.service")
            .edge("user@1000.service", &["dbus.service"]);
        let set = compute_session_critical_set(&g).unwrap();
        assert!(set.contains("user@1000.service"));
        assert!(set.contains("dbus.service"));
    }

    #[test]
    fn fake_graph_handles_missing_sentinel() {
        let g = FakeGraph::new();
        let set = compute_session_critical_set(&g).unwrap();
        assert_eq!(set.len(), SENTINELS.len());
        for s in SENTINELS {
            assert!(set.contains(*s));
        }
        assert!(!set.contains("dbus.service"));
    }

    #[test]
    fn fake_graph_tolerates_cycles() {
        let g = FakeGraph::new()
            .edge("display-manager.service", &["a.service"])
            .edge("a.service", &["b.service"])
            .edge("b.service", &["a.service"]);
        let set = compute_session_critical_set(&g).unwrap();
        assert!(set.contains("a.service"));
        assert!(set.contains("b.service"));
    }

    fn session_set(units: &[&str]) -> HashSet<String> {
        units.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn tag_session_critical_wins_over_cockpit_session() {
        let set = session_set(&["dbus.service"]);
        assert_eq!(
            tag_restart_blocked("dbus.service", &set),
            Some(RestartBlocked::SessionCritical),
        );
    }

    #[test]
    fn tag_cockpit_session_from_static_list() {
        let set = session_set(&[]);
        assert_eq!(
            tag_restart_blocked("polkit.service", &set),
            Some(RestartBlocked::CockpitSession),
        );
    }

    #[test]
    fn tag_cockpit_transport_from_static_list() {
        let set = session_set(&[]);
        assert_eq!(
            tag_restart_blocked("wpa_supplicant.service", &set),
            Some(RestartBlocked::CockpitTransport),
        );
    }

    #[test]
    fn tag_unknown_service_is_unblocked() {
        let set = session_set(&[]);
        assert_eq!(tag_restart_blocked("nginx.service", &set), None);
    }

    #[test]
    fn cockpit_session_critical_covers_auth_bus_and_own_daemons() {
        for unit in [
            "cockpit.service",
            "cockpit.socket",
            "polkit.service",
            "dbus.service",
            "dbus-broker.service",
            "systemd-logind.service",
        ] {
            assert!(
                COCKPIT_SESSION_CRITICAL.contains(&unit),
                "{} should be in the always-block list",
                unit
            );
        }
    }

    #[test]
    fn cockpit_transport_critical_covers_wifi_supplicants() {
        for unit in ["wpa_supplicant.service", "iwd.service"] {
            assert!(
                COCKPIT_TRANSPORT_CRITICAL.contains(&unit),
                "{} should be in the remote-only block list",
                unit
            );
        }
    }

    #[test]
    fn blocklists_do_not_cover_safe_transport_managers() {
        for unit in [
            "NetworkManager.service",
            "systemd-networkd.service",
            "dhcpcd.service",
            "ModemManager.service",
        ] {
            assert!(
                !COCKPIT_SESSION_CRITICAL.contains(&unit)
                    && !COCKPIT_TRANSPORT_CRITICAL.contains(&unit),
                "{} should not be on either blocklist",
                unit
            );
        }
    }

    #[test]
    fn blocklists_do_not_cover_auth_caches() {
        for unit in [
            "systemd-userdbd.service",
            "sssd.service",
            "nscd.service",
            "winbind.service",
            "sshd.service",
        ] {
            assert!(
                !COCKPIT_SESSION_CRITICAL.contains(&unit)
                    && !COCKPIT_TRANSPORT_CRITICAL.contains(&unit),
                "{} should not be on either blocklist",
                unit
            );
        }
    }
}
