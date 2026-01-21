use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::process::Command;

use fs2::FileExt;

const CONFIG_PATH: &str = "/etc/cockpit-pacman/config.json";
const TIMER_DROP_IN_DIR: &str = "/etc/systemd/system/cockpit-pacman-scheduled.timer.d";
const TIMER_DROP_IN_PATH: &str =
    "/etc/systemd/system/cockpit-pacman-scheduled.timer.d/schedule.conf";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
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
        let path = Path::new(CONFIG_PATH);
        if !path.exists() {
            return Ok(Self::default());
        }

        let file = File::open(path)
            .with_context(|| format!("Failed to open config from {}", CONFIG_PATH))?;

        // Acquire shared lock for reading
        file.lock_shared()
            .with_context(|| format!("Failed to acquire read lock on {}", CONFIG_PATH))?;

        let content = fs::read_to_string(path)
            .with_context(|| format!("Failed to read config from {}", CONFIG_PATH))?;

        // Lock is automatically released when file is dropped
        serde_json::from_str(&content)
            .with_context(|| format!("Failed to parse config from {}", CONFIG_PATH))
    }

    pub fn save(&self) -> Result<()> {
        let path = Path::new(CONFIG_PATH);

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("Failed to create config directory {:?}", parent))?;
        }

        let content = serde_json::to_string_pretty(self).context("Failed to serialize config")?;

        // Open with exclusive lock and restrictive permissions (0600)
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .with_context(|| format!("Failed to open config for writing: {}", CONFIG_PATH))?;

        // Acquire exclusive lock for writing
        file.lock_exclusive()
            .with_context(|| format!("Failed to acquire write lock on {}", CONFIG_PATH))?;

        file.write_all(content.as_bytes())
            .with_context(|| format!("Failed to write config to {}", CONFIG_PATH))?;

        // Lock is automatically released when file is dropped
        Ok(())
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

            // Reload systemd and check exit status
            let output = Command::new("systemctl")
                .args(["daemon-reload"])
                .output()
                .context("Failed to run systemctl daemon-reload")?;

            if !output.status.success() {
                // Rollback: remove the drop-in file
                let _ = fs::remove_file(TIMER_DROP_IN_PATH);
                bail!(
                    "systemctl daemon-reload failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }

            // Enable timer and check exit status
            let output = Command::new("systemctl")
                .args(["enable", "--now", "cockpit-pacman-scheduled.timer"])
                .output()
                .context("Failed to enable timer")?;

            if !output.status.success() {
                // Rollback: remove drop-in and reload
                let _ = fs::remove_file(TIMER_DROP_IN_PATH);
                let _ = Command::new("systemctl").args(["daemon-reload"]).output();
                bail!(
                    "Failed to enable timer: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
        } else {
            // Disable timer (ignore errors - timer might not exist)
            let _ = Command::new("systemctl")
                .args(["disable", "--now", "cockpit-pacman-scheduled.timer"])
                .output();

            // Remove drop-in file
            let _ = fs::remove_file(TIMER_DROP_IN_PATH);

            // Reload systemd
            let output = Command::new("systemctl")
                .args(["daemon-reload"])
                .output()
                .context("Failed to run systemctl daemon-reload")?;

            if !output.status.success() {
                bail!(
                    "systemctl daemon-reload failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
        }

        Ok(())
    }
}

#[derive(Serialize)]
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

#[derive(Serialize)]
pub struct IgnoreOperationResponse {
    pub success: bool,
    pub package: String,
    pub message: String,
}

#[derive(Serialize)]
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
    let output = Command::new("systemctl")
        .args([
            "show",
            "cockpit-pacman-scheduled.timer",
            "--property=ActiveState,NextElapseUSecRealtime",
        ])
        .output();

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

#[derive(Serialize)]
pub struct ScheduleSetResponse {
    pub success: bool,
    pub message: String,
}
