use anyhow::Result;

use crate::config::{AppConfig, IgnoreOperationResponse, IgnoredPackagesResponse};

pub fn list_ignored() -> Result<()> {
    let config = AppConfig::load()?;
    let response = IgnoredPackagesResponse::from(&config);
    println!("{}", serde_json::to_string(&response)?);
    Ok(())
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

    println!("{}", serde_json::to_string(&response)?);
    Ok(())
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

    println!("{}", serde_json::to_string(&response)?);
    Ok(())
}
