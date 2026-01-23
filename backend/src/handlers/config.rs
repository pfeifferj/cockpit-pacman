use anyhow::Result;

use crate::config::{AppConfig, IgnoreOperationResponse, IgnoredPackagesResponse};
use crate::util::emit_json;

pub fn list_ignored() -> Result<()> {
    let config = AppConfig::load()?;
    let response = IgnoredPackagesResponse::from(&config);
    emit_json(&response)
}

pub fn add_ignored(package: &str) -> Result<()> {
    let mut config = AppConfig::load()?;
    let added = config.add_ignored(package);

    if added {
        config.save()?;
    }

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
    let mut config = AppConfig::load()?;
    let removed = config.remove_ignored(package);

    if removed {
        config.save()?;
    }

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
