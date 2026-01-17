use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

const CONFIG_PATH: &str = "/etc/cockpit-pacman/config.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    #[serde(default)]
    pub ignored_packages: Vec<String>,
}

impl AppConfig {
    pub fn load() -> Result<Self> {
        let path = Path::new(CONFIG_PATH);
        if !path.exists() {
            return Ok(Self::default());
        }

        let content = fs::read_to_string(path)
            .with_context(|| format!("Failed to read config from {}", CONFIG_PATH))?;

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

        fs::write(path, content)
            .with_context(|| format!("Failed to write config to {}", CONFIG_PATH))
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
