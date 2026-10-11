use anyhow::Result;

use crate::config::{
    AppConfig, IgnoreOperationResponse, IgnoredPackagesResponse, SettingsResponse,
    SettingsSetResponse,
};
use crate::util::emit_json;

pub fn list_ignored() -> Result<()> {
    let (config, degraded) = AppConfig::load_degraded()?;
    let response = if degraded {
        IgnoredPackagesResponse {
            packages: None,
            total: None,
        }
    } else {
        IgnoredPackagesResponse::from(&config)
    };
    emit_json(&response)
}

pub fn add_ignored(package: &str) -> Result<()> {
    let added = AppConfig::update(|config| Ok(config.add_ignored(package)))?;

    let response = IgnoreOperationResponse {
        success: true,
        package: package.to_string(),
        message: if added {
            format!("Package '{}' added to ignored list", package)
        } else {
            format!("Package '{}' was already in ignored list", package)
        },
    };

    emit_json(&response)
}

pub fn remove_ignored(package: &str) -> Result<()> {
    let removed = AppConfig::update(|config| Ok(config.remove_ignored(package)))?;

    let response = IgnoreOperationResponse {
        success: removed,
        package: package.to_string(),
        message: if removed {
            format!("Package '{}' removed from ignored list", package)
        } else {
            format!("Package '{}' was not in ignored list", package)
        },
    };

    emit_json(&response)
}

pub fn get_settings() -> Result<()> {
    let (config, degraded) = AppConfig::load_degraded()?;
    emit_json(&SettingsResponse {
        security_advisories: (!degraded).then_some(config.security_advisories),
    })
}

pub fn set_settings(security_advisories: Option<bool>) -> Result<()> {
    AppConfig::update(|config| {
        if let Some(enabled) = security_advisories {
            config.security_advisories = enabled;
        }
        Ok(())
    })?;

    emit_json(&SettingsSetResponse {
        success: true,
        message: "Settings saved".to_string(),
    })
}
