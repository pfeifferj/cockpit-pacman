use anyhow::Result;

pub fn endpoint(default: &str, variable: &str) -> Result<String> {
    #[cfg(feature = "e2e-fixtures")]
    if let Ok(value) = std::env::var(variable) {
        validate_loopback(&value)?;
        return Ok(value.trim_end_matches('/').to_owned());
    }
    let _ = variable;
    Ok(default.to_owned())
}

#[cfg(all(test, not(feature = "e2e-fixtures")))]
#[test]
fn production_ignores_environment_overrides() {
    assert_eq!(
        endpoint("https://archlinux.org", "PATH").ok().as_deref(),
        Some("https://archlinux.org")
    );
}

#[cfg(feature = "e2e-fixtures")]
fn validate_loopback(value: &str) -> Result<()> {
    let authority = value
        .strip_prefix("http://")
        .and_then(|value| value.split('/').next())
        .ok_or_else(|| anyhow::anyhow!("fixture endpoint must use loopback HTTP"))?;
    let address: std::net::SocketAddr = authority.parse()?;
    anyhow::ensure!(
        address.ip().is_loopback(),
        "fixture endpoint must use loopback HTTP"
    );
    anyhow::ensure!(!value.contains(['?', '#']), "invalid fixture endpoint path");
    Ok(())
}

#[cfg(all(test, feature = "e2e-fixtures"))]
mod tests {
    use super::validate_loopback;

    #[test]
    fn fixture_endpoints_cannot_send_credentials_to_remote_hosts() {
        assert!(validate_loopback("http://127.0.0.1:18080/archive").is_ok());
        assert!(validate_loopback("http://[::1]:18080").is_ok());
        for url in [
            "https://archlinux.org",
            "http://192.0.2.1:80",
            "http://127.0.0.1:80@archlinux.org:80",
            "http://localhost:80",
            "http://127.0.0.1:80/?redirect=example.com",
        ] {
            assert!(validate_loopback(url).is_err(), "{url}");
        }
    }
}
