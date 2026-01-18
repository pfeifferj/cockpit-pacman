use anyhow::Result;

pub fn validate_package_name(name: &str) -> Result<()> {
    if name.is_empty() {
        anyhow::bail!("Package name cannot be empty");
    }
    if name.len() > 256 {
        anyhow::bail!("Package name too long (max 256)");
    }
    Ok(())
}

pub fn validate_search_query(query: &str) -> Result<()> {
    if query.is_empty() {
        anyhow::bail!("Search query cannot be empty");
    }
    if query.len() > 256 {
        anyhow::bail!("Search query too long (max 256)");
    }
    if query.chars().any(|c| c.is_control()) {
        anyhow::bail!("Search query contains invalid characters");
    }
    Ok(())
}

pub fn validate_pagination(offset: usize, limit: usize) -> Result<()> {
    if limit == 0 || limit > 1000 {
        anyhow::bail!("Limit must be between 1 and 1000");
    }
    if offset > 1_000_000 {
        anyhow::bail!("Offset too large");
    }
    Ok(())
}

pub fn validate_version(version: &str) -> Result<()> {
    if version.is_empty() {
        anyhow::bail!("Version cannot be empty");
    }
    if version.len() > 128 {
        anyhow::bail!("Version string too long (max 128)");
    }
    if version.contains("..") || version.contains('/') || version.contains('\\') {
        anyhow::bail!("Version contains invalid path characters");
    }
    if version.chars().any(|c| c.is_control()) {
        anyhow::bail!("Version contains invalid control characters");
    }
    Ok(())
}
