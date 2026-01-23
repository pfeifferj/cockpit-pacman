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

pub fn validate_mirror_url(url: &str) -> Result<()> {
    if url.is_empty() {
        anyhow::bail!("Mirror URL cannot be empty");
    }
    if url.len() > 2048 {
        anyhow::bail!("Mirror URL too long (max 2048)");
    }
    if url.chars().any(|c| c.is_control()) {
        anyhow::bail!("Mirror URL contains invalid control characters");
    }
    if !url.starts_with("https://") && !url.starts_with("http://") {
        anyhow::bail!("Mirror URL must start with https:// or http://");
    }
    if url.contains("..") || url.contains("//./") || url.contains("/../") {
        anyhow::bail!("Mirror URL contains suspicious path traversal");
    }
    let dangerous_chars = ['<', '>', '"', '\'', '`', '|', ';', '&', '\\', '\n', '\r'];
    if url.chars().any(|c| dangerous_chars.contains(&c)) {
        anyhow::bail!("Mirror URL contains potentially dangerous characters");
    }
    // Check that $ only appears as part of $repo or $arch
    if url.contains('$') {
        let replaced = url.replace("$repo", "").replace("$arch", "");
        if replaced.contains('$') {
            anyhow::bail!("Mirror URL contains invalid $ usage (only $repo and $arch allowed)");
        }
    }
    Ok(())
}

pub fn validate_mirror_timeout(timeout: u64) -> Result<()> {
    if timeout == 0 || timeout > 300 {
        anyhow::bail!(
            "Mirror timeout must be between 1 and 300 seconds (got {})",
            timeout
        );
    }
    Ok(())
}

pub fn validate_depth(depth: u32) -> Result<()> {
    if depth == 0 || depth > 5 {
        anyhow::bail!("Depth must be between 1 and 5 (got {})", depth);
    }
    Ok(())
}

pub fn validate_direction(direction: &str) -> Result<()> {
    match direction {
        "forward" | "reverse" | "both" => Ok(()),
        _ => anyhow::bail!(
            "Direction must be 'forward', 'reverse', or 'both' (got '{}')",
            direction
        ),
    }
}

const MAX_JSON_PAYLOAD_BYTES: usize = 1024 * 1024; // 1 MiB

pub fn validate_json_payload_size(payload: &str) -> Result<()> {
    if payload.len() > MAX_JSON_PAYLOAD_BYTES {
        anyhow::bail!(
            "JSON payload too large ({} bytes, max {})",
            payload.len(),
            MAX_JSON_PAYLOAD_BYTES
        );
    }
    Ok(())
}
