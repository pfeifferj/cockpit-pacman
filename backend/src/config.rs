use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};
use ts_rs::TS;

const CONFIG_PATH: &str = "/etc/cockpit-pacman/config.json";
const CONFIG_LOCK_PATH: &str = "/etc/cockpit-pacman/config.json.lock";
const TIMER_DROP_IN_DIR: &str = "/etc/systemd/system/cockpit-pacman-scheduled.timer.d";
const TIMER_DROP_IN_PATH: &str =
    "/etc/systemd/system/cockpit-pacman-scheduled.timer.d/schedule.conf";
const SYSTEMCTL_TIMEOUT: Duration = Duration::from_secs(30);

const SYSTEMD_APPLY_BUDGET: Duration = Duration::from_secs(20);

struct Budget {
    deadline: Instant,
}

impl Budget {
    fn new(total: Duration) -> Self {
        Budget {
            deadline: Instant::now() + total,
        }
    }

    /// Floored rather than zero, so the call that undoes a half-applied change
    /// still gets to start.
    fn remaining(&self) -> Duration {
        self.deadline
            .saturating_duration_since(Instant::now())
            .max(Duration::from_secs(1))
    }
}

fn run_systemctl(args: &[&str], timeout: Duration) -> Result<std::process::Output> {
    let mut cmd = Command::new("systemctl");
    cmd.args(args);
    // Pin the locale so stderr stays parseable (timer_absent matches it) and
    // errors read the same regardless of the host language.
    cmd.env("LC_ALL", "C");
    crate::util::output_with_timeout(cmd, timeout)
}

/// Whether a systemctl failure just means the timer isn't installed/loaded,
/// which is a no-op when disabling rather than an error to surface.
fn timer_absent(stderr: &str) -> bool {
    let s = stderr.to_lowercase();
    s.contains("does not exist")
        || s.contains("not loaded")
        || s.contains("no such file")
        || s.contains("not found")
}

fn restore_drop_in(path: &Path, previous: Option<&[u8]>) {
    match previous {
        Some(bytes) => {
            let _ = crate::util::write_bytes_atomic_with_mode(path, bytes, 0o644);
        }
        None => {
            let _ = fs::remove_file(path);
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
#[serde(rename_all = "lowercase")]
pub enum ScheduleMode {
    Check,
    #[default]
    Upgrade,
}

impl std::fmt::Display for ScheduleMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ScheduleMode::Check => write!(f, "check"),
            ScheduleMode::Upgrade => write!(f, "upgrade"),
        }
    }
}

impl std::str::FromStr for ScheduleMode {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "check" => Ok(ScheduleMode::Check),
            "upgrade" => Ok(ScheduleMode::Upgrade),
            _ => Err(anyhow::anyhow!("Invalid schedule mode: {}", s)),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub mode: ScheduleMode,
    #[serde(default = "default_schedule")]
    pub schedule: String,
    #[serde(default)]
    pub max_packages: usize,
    // Round-trip keys this binary doesn't know about (e.g. fields added by a
    // newer version) instead of dropping them on the next update() rewrite.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

fn default_schedule() -> String {
    "weekly".to_string()
}

impl Default for ScheduleConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: ScheduleMode::Upgrade,
            schedule: default_schedule(),
            max_packages: 0,
            extra: serde_json::Map::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    #[serde(default)]
    pub ignored_packages: Vec<String>,
    #[serde(default)]
    pub schedule: ScheduleConfig,
    // Round-trip keys this binary doesn't know about (e.g. fields added by a
    // newer version) instead of dropping them on the next update() rewrite.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl AppConfig {
    pub fn load() -> Result<Self> {
        use std::io::Read;

        let path = Path::new(CONFIG_PATH);

        // Open without existence check - let File::open fail with NotFound
        let file = match File::open(path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default());
            }
            Err(e) => {
                return Err(e)
                    .with_context(|| format!("Failed to open config from {}", CONFIG_PATH));
            }
        };

        // Lock BEFORE reading
        file.lock_shared()
            .with_context(|| format!("Failed to acquire read lock on {}", CONFIG_PATH))?;

        // Read from locked file handle (not path) to avoid TOCTOU race
        let mut content = String::new();
        let mut reader = std::io::BufReader::new(&file);
        reader
            .read_to_string(&mut content)
            .with_context(|| format!("Failed to read config from {}", CONFIG_PATH))?;

        // Lock is automatically released when file is dropped
        serde_json::from_str(&content)
            .with_context(|| format!("Failed to parse config from {}", CONFIG_PATH))
    }

    /// Read-modify-write the on-disk config under a sidecar lock. The lock is a
    /// dedicated `.lock` file, not config.json itself: the data file is replaced
    /// via atomic rename (write_json_atomic_with_mode), so a lock on its inode
    /// would not cover a second writer that opens the path fresh. Holding the
    /// sidecar lock across read/mutate/write serializes concurrent backend
    /// invocations, and the atomic rename means a crash mid-write can never
    /// leave a partial config.json. Returns whatever the closure returns.
    pub fn update<F, R>(mutate: F) -> Result<R>
    where
        F: FnOnce(&mut AppConfig) -> Result<R>,
    {
        let path = Path::new(CONFIG_PATH);

        crate::util::with_file_lock(Path::new(CONFIG_LOCK_PATH), || {
            let mut config = match fs::read_to_string(path) {
                Ok(content) if content.trim().is_empty() => AppConfig::default(),
                Ok(content) => serde_json::from_str(&content)
                    .with_context(|| format!("Failed to parse config from {}", CONFIG_PATH))?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => AppConfig::default(),
                Err(e) => {
                    return Err(e)
                        .with_context(|| format!("Failed to read config from {}", CONFIG_PATH));
                }
            };

            let result = mutate(&mut config)?;

            crate::util::write_json_atomic_with_mode(path, &config, 0o600)
                .with_context(|| format!("Failed to write config to {}", CONFIG_PATH))?;

            Ok(result)
        })
    }

    pub fn add_ignored(&mut self, package: &str) -> bool {
        if !self.ignored_packages.contains(&package.to_string()) {
            self.ignored_packages.push(package.to_string());
            self.ignored_packages.sort();
            true
        } else {
            false
        }
    }

    pub fn remove_ignored(&mut self, package: &str) -> bool {
        if let Some(pos) = self.ignored_packages.iter().position(|p| p == package) {
            self.ignored_packages.remove(pos);
            true
        } else {
            false
        }
    }

    pub fn is_ignored(&self, package: &str) -> bool {
        self.ignored_packages.contains(&package.to_string())
    }

    pub fn apply_schedule_to_systemd(&self) -> Result<()> {
        let schedule = &self.schedule;
        let budget = Budget::new(SYSTEMD_APPLY_BUDGET);

        if schedule.enabled {
            // Create drop-in directory with proper permissions
            fs::create_dir_all(TIMER_DROP_IN_DIR).with_context(|| {
                format!(
                    "Failed to create timer drop-in directory {}",
                    TIMER_DROP_IN_DIR
                )
            })?;
            fs::set_permissions(TIMER_DROP_IN_DIR, fs::Permissions::from_mode(0o755))
                .with_context(|| format!("Failed to set permissions on {}", TIMER_DROP_IN_DIR))?;

            // Unlinking reverts the timer to the unit's own OnCalendar while
            // config.json still names the old schedule.
            let previous = fs::read(TIMER_DROP_IN_PATH).ok();

            // Write drop-in file with restrictive permissions
            let drop_in_content =
                format!("[Timer]\nOnCalendar=\nOnCalendar={}\n", schedule.schedule);

            let mut file = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o644)
                .open(TIMER_DROP_IN_PATH)
                .with_context(|| format!("Failed to open timer drop-in: {}", TIMER_DROP_IN_PATH))?;

            file.write_all(drop_in_content.as_bytes())
                .with_context(|| {
                    format!("Failed to write timer drop-in to {}", TIMER_DROP_IN_PATH)
                })?;

            // Undo the drop-in we just wrote when a systemctl step fails (spawn
            // error, timeout, or non-zero exit).
            let rollback = || {
                restore_drop_in(Path::new(TIMER_DROP_IN_PATH), previous.as_deref());
                let _ = run_systemctl(&["daemon-reload"], budget.remaining());
            };

            match run_systemctl(&["daemon-reload"], budget.remaining()) {
                Ok(o) if o.status.success() => {}
                Ok(o) => {
                    rollback();
                    bail!(
                        "systemctl daemon-reload failed: {}",
                        String::from_utf8_lossy(&o.stderr)
                    );
                }
                Err(e) => {
                    rollback();
                    return Err(e).context("Failed to run systemctl daemon-reload");
                }
            }

            match run_systemctl(
                &["enable", "--now", "cockpit-pacman-scheduled.timer"],
                budget.remaining(),
            ) {
                Ok(o) if o.status.success() => {}
                Ok(o) => {
                    rollback();
                    bail!(
                        "Failed to enable timer: {}",
                        String::from_utf8_lossy(&o.stderr)
                    );
                }
                Err(e) => {
                    rollback();
                    return Err(e).context("Failed to enable timer");
                }
            }
        } else {
            // A not-enabled or absent timer is fine to "disable", but a real
            // systemctl failure must surface or the timer keeps firing while
            // config claims it's off.
            match run_systemctl(
                &["disable", "--now", "cockpit-pacman-scheduled.timer"],
                budget.remaining(),
            ) {
                Ok(o) if o.status.success() => {}
                Ok(o) => {
                    let stderr = String::from_utf8_lossy(&o.stderr);
                    if !timer_absent(&stderr) {
                        bail!("Failed to disable timer: {}", stderr);
                    }
                }
                Err(e) => return Err(e).context("Failed to disable timer"),
            }

            let _ = fs::remove_file(TIMER_DROP_IN_PATH);

            match run_systemctl(&["daemon-reload"], budget.remaining()) {
                Ok(o) if o.status.success() => {}
                Ok(o) => {
                    bail!(
                        "systemctl daemon-reload failed: {}",
                        String::from_utf8_lossy(&o.stderr)
                    );
                }
                Err(e) => return Err(e).context("Failed to run systemctl daemon-reload"),
            }
        }

        Ok(())
    }
}

#[derive(Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct IgnoredPackagesResponse {
    pub packages: Vec<String>,
    pub total: usize,
}

impl From<&AppConfig> for IgnoredPackagesResponse {
    fn from(config: &AppConfig) -> Self {
        Self {
            total: config.ignored_packages.len(),
            packages: config.ignored_packages.clone(),
        }
    }
}

#[derive(Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct IgnoreOperationResponse {
    pub success: bool,
    pub package: String,
    pub message: String,
}

#[derive(Serialize, TS)]
#[ts(
    export,
    export_to = "../../src/bindings/index.ts",
    rename = "ScheduleConfig"
)]
pub struct ScheduleConfigResponse {
    pub enabled: bool,
    pub mode: String,
    pub schedule: String,
    pub max_packages: usize,
    pub timer_active: bool,
    pub timer_next_run: Option<String>,
    /// What the timer is actually set to, as systemd normalises it.
    pub timer_calendar: Option<String>,
}

impl ScheduleConfigResponse {
    pub fn from_config(config: &ScheduleConfig) -> Self {
        let (timer_active, timer_next_run, timer_calendar) = get_timer_status();
        Self {
            enabled: config.enabled,
            mode: config.mode.to_string(),
            schedule: config.schedule.clone(),
            max_packages: config.max_packages,
            timer_active,
            timer_next_run,
            timer_calendar,
        }
    }
}

/// Pull `OnCalendar=X` out of systemd's `{ OnCalendar=X ; next_elapse=Y }`.
fn parse_timer_calendar(value: &str) -> Option<String> {
    let rest = value.split("OnCalendar=").nth(1)?;
    let spec = rest.split(';').next()?.trim();
    (!spec.is_empty()).then(|| spec.to_string())
}

fn get_timer_status() -> (bool, Option<String>, Option<String>) {
    let output = run_systemctl(
        &[
            "show",
            "cockpit-pacman-scheduled.timer",
            "--property=ActiveState,NextElapseUSecRealtime,TimersCalendar",
        ],
        SYSTEMCTL_TIMEOUT,
    );

    match output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let mut active = false;
            let mut next_run = None;
            let mut calendar = None;

            for line in stdout.lines() {
                if let Some(state) = line.strip_prefix("ActiveState=") {
                    active = state == "active";
                }
                if let Some(next) = line.strip_prefix("NextElapseUSecRealtime=")
                    && !next.is_empty()
                    && next != "n/a"
                {
                    next_run = Some(next.to_string());
                }
                if let Some(value) = line.strip_prefix("TimersCalendar=") {
                    calendar = parse_timer_calendar(value);
                }
            }

            (active, next_run, calendar)
        }
        Err(_) => (false, None, None),
    }
}

#[derive(Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct ScheduleSetResponse {
    pub success: bool,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::{
        Budget, SYSTEMD_APPLY_BUDGET, parse_timer_calendar, restore_drop_in, timer_absent,
    };
    use std::time::Duration;

    // Must stay under BACKEND_TIMEOUT_MS in src/constants.ts, or the client
    // aborts the spawn mid-apply.
    #[test]
    fn apply_budget_stays_under_the_client_abort() {
        assert!(
            SYSTEMD_APPLY_BUDGET < Duration::from_secs(30),
            "the whole apply must finish before the frontend gives up on it"
        );
    }

    #[test]
    fn budget_shrinks_as_it_is_spent() {
        let budget = Budget::new(Duration::from_secs(20));
        let first = budget.remaining();
        std::thread::sleep(Duration::from_millis(20));

        assert!(
            budget.remaining() < first,
            "each call must draw from the same budget, not restart it"
        );
    }

    #[test]
    fn a_spent_budget_still_lets_a_call_start() {
        let budget = Budget::new(Duration::from_millis(0));

        assert_eq!(budget.remaining(), Duration::from_secs(1));
    }

    #[test]
    fn timer_calendar_is_read_out_of_systemd_normalised_form() {
        assert_eq!(
            parse_timer_calendar("{ OnCalendar=*-*-* 00:00:00 ; next_elapse=Sat 2026-08-22 }")
                .unwrap(),
            "*-*-* 00:00:00"
        );
        assert_eq!(
            parse_timer_calendar("{ OnCalendar=Mon *-*-* 00:00:00 ; next_elapse=n/a }").unwrap(),
            "Mon *-*-* 00:00:00"
        );
        assert_eq!(parse_timer_calendar(""), None);
        assert_eq!(parse_timer_calendar("{ }"), None);
    }

    use std::path::PathBuf;

    fn temp(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("cpac-dropin-{}-{}", tag, std::process::id()))
    }

    #[test]
    fn a_failed_apply_puts_the_previous_schedule_back() {
        let path = temp("restore");
        let before = b"[Timer]\nOnCalendar=\nOnCalendar=daily\n";
        std::fs::write(&path, before).unwrap();

        let previous = std::fs::read(&path).ok();
        std::fs::write(&path, b"[Timer]\nOnCalendar=\nOnCalendar=garbage\n").unwrap();
        restore_drop_in(&path, previous.as_deref());

        assert_eq!(std::fs::read(&path).unwrap(), before);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn a_failed_apply_removes_a_drop_in_that_was_not_there_before() {
        let path = temp("absent");
        let _ = std::fs::remove_file(&path);

        let previous = std::fs::read(&path).ok();
        std::fs::write(&path, b"[Timer]\nOnCalendar=\nOnCalendar=garbage\n").unwrap();
        restore_drop_in(&path, previous.as_deref());

        assert!(!path.exists(), "a drop-in we created must not survive");
    }

    #[test]
    fn timer_absent_matches_missing_unit_but_not_real_failures() {
        assert!(timer_absent(
            "Failed to disable unit: Unit file cockpit-pacman-scheduled.timer does not exist."
        ));
        assert!(timer_absent(
            "Unit cockpit-pacman-scheduled.timer not loaded."
        ));
        assert!(timer_absent("No such file or directory"));
        assert!(timer_absent(
            "Unit cockpit-pacman-scheduled.timer not found."
        ));
        assert!(!timer_absent("Failed to disable unit: Access denied"));
        assert!(!timer_absent(""));
    }
}
