pub mod models;

use anyhow::{Context, Result};
use models::{SignoffGroup, SignoffSpec};

pub const DEFAULT_BASE_URL: &str = "https://archlinux.org";

#[derive(serde::Deserialize)]
struct SignoffResponse {
    signoff_groups: Vec<SignoffGroup>,
}

pub struct SignoffSession {
    agent: ureq::Agent,
    base_url: String,
    csrf_token: String,
}

impl SignoffSession {
    pub fn login(username: &str, password: &str, base_url: &str) -> Result<Self> {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(std::time::Duration::from_secs(20)))
            .timeout_connect(Some(std::time::Duration::from_secs(10)))
            .timeout_send_body(Some(std::time::Duration::from_secs(10)))
            .timeout_recv_body(Some(std::time::Duration::from_secs(15)))
            .max_redirects(3)
            .build();
        let agent = ureq::Agent::new_with_config(config);
        let mut session = Self {
            agent,
            base_url: base_url.trim_end_matches('/').to_string(),
            csrf_token: String::new(),
        };
        session.authenticate(username, password)?;
        Ok(session)
    }

    fn extract_csrf_token(&self) -> Option<String> {
        let jar = self.agent.cookie_jar_lock();
        for cookie in jar.iter() {
            if cookie.name() == "csrftoken" {
                return Some(cookie.value().to_string());
            }
        }
        None
    }

    fn authenticate(&mut self, username: &str, password: &str) -> Result<()> {
        let login_url = format!("{}/login/", self.base_url);

        // GET /login/ to get CSRF cookie
        let resp = self
            .agent
            .get(&login_url)
            .call()
            .context("failed to fetch login page")?;
        let _ = resp.into_body().read_to_vec();

        let csrf_token = self
            .extract_csrf_token()
            .context("no CSRF token found in cookies after GET /login/")?;

        // POST /login/ with credentials
        let form = [
            ("username", username),
            ("password", password),
            ("csrfmiddlewaretoken", &csrf_token),
        ];

        let _ = self
            .agent
            .post(&login_url)
            .header("Referer", &login_url)
            .config()
            .max_redirects(0)
            .http_status_as_error(false)
            .build()
            .send_form(form)
            .context("login request failed")?;

        // Verify we got a session cookie
        let has_session = {
            let jar = self.agent.cookie_jar_lock();
            jar.iter().any(|c| c.name() == "sessionid")
        };

        if !has_session {
            anyhow::bail!("authentication failed: invalid credentials");
        }

        // Re-read CSRF token (Django may rotate it after login)
        self.csrf_token = self.extract_csrf_token().unwrap_or(csrf_token);

        Ok(())
    }

    pub fn get_signoffs(&self) -> Result<Vec<SignoffGroup>> {
        let url = format!("{}/packages/signoffs/json/", self.base_url);
        let body = self
            .agent
            .get(&url)
            .call()
            .context("failed to fetch signoffs")?
            .body_mut()
            .read_to_string()
            .context("failed to read signoffs response body")?;

        let response: SignoffResponse =
            serde_json::from_str(&body).context("failed to parse signoffs JSON")?;

        Ok(response.signoff_groups)
    }

    fn post_no_redirect(&self, url: &str, form: &[(&str, &str)]) -> Result<()> {
        let resp = self
            .agent
            .post(url)
            .header("Referer", url)
            .config()
            .max_redirects(0)
            .http_status_as_error(false)
            .build()
            .send_form(form.iter().copied())
            .with_context(|| format!("POST {} failed", url))?;
        let status = resp.status();
        if status.is_client_error() || status.is_server_error() {
            anyhow::bail!("POST {} returned {}", url, status.as_u16());
        }
        Ok(())
    }

    pub fn signoff_package(&self, spec: &SignoffSpec) -> Result<()> {
        let url = format!(
            "{}/packages/{}/{}/{}/signoff/",
            self.base_url, spec.repo, spec.arch, spec.pkgbase
        );
        self.post_no_redirect(&url, &[("csrfmiddlewaretoken", &self.csrf_token)])
            .with_context(|| format!("failed to sign off {}", spec.pkgbase))
    }

    pub fn revoke_package(&self, spec: &SignoffSpec) -> Result<()> {
        let url = format!(
            "{}/packages/{}/{}/{}/signoff/revoke/",
            self.base_url, spec.repo, spec.arch, spec.pkgbase
        );
        self.post_no_redirect(&url, &[("csrfmiddlewaretoken", &self.csrf_token)])
            .with_context(|| format!("failed to revoke signoff for {}", spec.pkgbase))
    }

    pub fn logout(&self) {
        let url = format!("{}/logout/", self.base_url);
        let _ = self.post_no_redirect(&url, &[("csrfmiddlewaretoken", &self.csrf_token)]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserialize_signoff_response() {
        let json = r#"{
            "signoff_groups": [
                {
                    "pkgbase": "linux",
                    "pkgnames": ["linux", "linux-headers"],
                    "version": "6.8.1-1",
                    "arch": "x86_64",
                    "repo": "core",
                    "packager": "someone",
                    "comments": null,
                    "last_update": "2024-03-15T10:00:00Z",
                    "known_bad": false,
                    "approved": false,
                    "required": 2,
                    "enabled": true,
                    "signoffs": [
                        {
                            "user": "testuser",
                            "created": "2024-03-15T12:00:00Z",
                            "revoked": false
                        }
                    ]
                }
            ]
        }"#;

        let response: SignoffResponse = serde_json::from_str(json).unwrap();
        assert_eq!(response.signoff_groups.len(), 1);
        let group = &response.signoff_groups[0];
        assert_eq!(group.pkgbase, "linux");
        assert_eq!(group.pkgnames, vec!["linux", "linux-headers"]);
        assert_eq!(group.version, "6.8.1-1");
        assert_eq!(group.signoffs.len(), 1);
        assert_eq!(group.signoffs[0].user, "testuser");
        assert!(!group.signoffs[0].revoked);
    }
}
