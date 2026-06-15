use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::process::Command;
use std::time::Duration;
use ts_rs::TS;

const CONFIG_PATH: &str = "/etc/cockpit-pacman/config.json";
const CONFIG_LOCK_PATH: &str = "/etc/cockpit-pacman/config.json.lock";
const TIMER_DROP_IN_DIR: &str = "/etc/systemd/system/cockpit-pacman-scheduled.timer.d";
const TIMER_DROP_IN_PATH: &str =
    "/etc/systemd/system/cockpit-pacman-scheduled.timer.d/schedule.conf";
const SYSTEMCTL_TIMEOUT: Duration = Duration::from_secs(30);

/// Run `systemctl <args>` bounded by SYSTEMCTL_TIMEOUT so a wedged systemd can't
/// hang the request.
fn run_systemctl(args: &[&str]) -> Result<std::process::Output> {
    let mut cmd = Command::new("systemctl");
    cmd.args(args);
    crate::util::output_with_timeout(cmd, SYSTEMCTL_TIMEOUT)
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
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    #[serde(default)]
    pub ignored_packages: Vec<String>,
    #[serde(default)]
    pub schedule: ScheduleConfig,
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
                let _ = fs::remove_file(TIMER_DROP_IN_PATH);
                let _ = run_systemctl(&["daemon-reload"]);
            };

            match run_systemctl(&["daemon-reload"]) {
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

            match run_systemctl(&["enable", "--now", "cockpit-pacman-scheduled.timer"]) {
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
            // Disable timer (ignore errors - timer might not exist)
            let _ = run_systemctl(&["disable", "--now", "cockpit-pacman-scheduled.timer"]);

            // Remove drop-in file
            let _ = fs::remove_file(TIMER_DROP_IN_PATH);

            // Reload systemd
            match run_systemctl(&["daemon-reload"]) {
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
}

impl ScheduleConfigResponse {
    pub fn from_config(config: &ScheduleConfig) -> Self {
        let (timer_active, timer_next_run) = get_timer_status();
        Self {
            enabled: config.enabled,
            mode: config.mode.to_string(),
            schedule: config.schedule.clone(),
            max_packages: config.max_packages,
            timer_active,
            timer_next_run,
        }
    }
}

fn get_timer_status() -> (bool, Option<String>) {
    let output = run_systemctl(&[
        "show",
        "cockpit-pacman-scheduled.timer",
        "--property=ActiveState,NextElapseUSecRealtime",
    ]);

    match output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let mut active = false;
            let mut next_run = None;

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
            }

            (active, next_run)
        }
        Err(_) => (false, None),
    }
}

#[derive(Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct ScheduleSetResponse {
    pub success: bool,
    pub message: String,
}
