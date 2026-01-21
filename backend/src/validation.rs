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

pub fn validate_keep_versions(keep: u32) -> Result<()> {
    if keep > 100 {
        anyhow::bail!("Keep versions must be at most 100 (got {})", keep);
    }
    Ok(())
}

pub fn validate_schedule(schedule: &str) -> Result<()> {
    if schedule.is_empty() {
        anyhow::bail!("Schedule cannot be empty");
    }
    if schedule.len() > 256 {
        anyhow::bail!("Schedule string too long (max 256)");
    }
    // Critical: prevent injection of systemd directives via newlines or other control chars
    if schedule.chars().any(|c| c.is_control()) {
        anyhow::bail!("Schedule contains invalid control characters");
    }
    // Reject characters that could be used for injection
    if schedule.contains('[') || schedule.contains(']') || schedule.contains('=') {
        anyhow::bail!("Schedule contains invalid characters");
    }
    // Only allow known safe presets or valid OnCalendar-like patterns
    let safe_presets = [
        "hourly",
        "daily",
        "weekly",
        "monthly",
        "yearly",
        "quarterly",
    ];
    if safe_presets.contains(&schedule) {
        return Ok(());
    }
    // For custom schedules, validate basic OnCalendar format
    // Allow: digits, letters, spaces, dashes, colons, asterisks, commas, slashes, dots
    let valid_chars = |c: char| {
        c.is_ascii_alphanumeric()
            || c == ' '
            || c == '-'
            || c == ':'
            || c == '*'
            || c == ','
            || c == '/'
            || c == '.'
            || c == '~'
    };
    if !schedule.chars().all(valid_chars) {
        anyhow::bail!("Schedule contains invalid characters for OnCalendar format");
    }
    Ok(())
}

pub fn validate_max_packages(max: usize) -> Result<()> {
    if max > 1000 {
        anyhow::bail!("max_packages must be at most 1000 (got {})", max);
    }
    Ok(())
}
