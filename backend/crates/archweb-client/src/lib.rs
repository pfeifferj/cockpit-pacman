pub mod models;

use anyhow::{Context, Result};
use arch_http_client::{Options, Session};
use models::{SignoffGroup, SignoffSpec};
use std::time::Duration;

pub const DEFAULT_BASE_URL: &str = "https://archlinux.org";

#[derive(serde::Deserialize)]
struct SignoffResponse {
    signoff_groups: Vec<SignoffGroup>,
}

#[derive(Debug)]
pub struct AuthRejected;

impl std::fmt::Display for AuthRejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Authentication failed: invalid credentials")
    }
}
impl std::error::Error for AuthRejected {}

pub struct SignoffSession {
    client: Session,
    base_url: String,
    logout_attempted: std::cell::Cell<bool>,
}

impl SignoffSession {
    pub fn login(username: &str, password: &str, base_url: &str) -> Result<Self> {
        let session = Self {
            client: Session::new(Options {
                timeout: Duration::from_secs(20),
                connect_timeout: Duration::from_secs(10),
                upload_timeout: Some(Duration::from_secs(10)),
                body_timeout: Some(Duration::from_secs(15)),
                max_body: 8 * 1024 * 1024,
                max_redirects: 3,
                ..Options::default()
            })?,
            base_url: base_url.trim_end_matches('/').to_string(),
            logout_attempted: std::cell::Cell::new(false),
        };
        session.authenticate(username, password)?;
        Ok(session)
    }

    fn csrf_token(&self, url: &str) -> Result<String> {
        self.client
            .cookie(url, "csrftoken")?
            .context("no CSRF cookie for request")
    }

    fn authenticate(&self, username: &str, password: &str) -> Result<()> {
        let url = format!("{}/login/", self.base_url);
        self.client
            .get(&url)
            .context("failed to fetch login page")?;
        self.client
            .post_form(
                &url,
                &[
                    ("username", username),
                    ("password", password),
                    ("csrfmiddlewaretoken", &self.csrf_token(&url)?),
                ],
            )
            .context("login request failed")?;
        if self
            .client
            .cookie(
                &format!("{}/packages/signoffs/json/", self.base_url),
                "sessionid",
            )?
            .is_none()
        {
            return Err(AuthRejected.into());
        }
        Ok(())
    }

    pub fn get_signoffs(&self) -> Result<Vec<SignoffGroup>> {
        let response = self
            .client
            .get(&format!("{}/packages/signoffs/json/", self.base_url))
            .context("failed to fetch signoffs")?;
        let response: SignoffResponse =
            serde_json::from_slice(&response.body).context("failed to parse signoffs JSON")?;
        Ok(response.signoff_groups)
    }

    fn post_no_redirect(&self, url: &str) -> Result<()> {
        self.client
            .post_form(url, &[("csrfmiddlewaretoken", &self.csrf_token(url)?)])
            .context("Archweb request failed")?;
        Ok(())
    }

    pub fn signoff_package(&self, spec: &SignoffSpec) -> Result<()> {
        let url = format!(
            "{}/packages/{}/{}/{}/signoff/",
            self.base_url, spec.repo, spec.arch, spec.pkgbase
        );
        self.post_no_redirect(&url)
            .with_context(|| format!("failed to sign off {}", spec.pkgbase))
    }

    pub fn revoke_package(&self, spec: &SignoffSpec) -> Result<()> {
        let url = format!(
            "{}/packages/{}/{}/{}/signoff/revoke/",
            self.base_url, spec.repo, spec.arch, spec.pkgbase
        );
        self.post_no_redirect(&url)
            .with_context(|| format!("failed to revoke signoff for {}", spec.pkgbase))
    }

    pub fn logout(&self) {
        if !self.logout_attempted.replace(true)
            && self
                .client
                .cookie(
                    &format!("{}/packages/signoffs/json/", self.base_url),
                    "sessionid",
                )
                .ok()
                .flatten()
                .is_some()
        {
            let _ = self.post_no_redirect(&format!("{}/logout/", self.base_url));
        }
    }
}

impl Drop for SignoffSession {
    fn drop(&mut self) {
        self.logout();
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

#[cfg(test)]
mod session_tests {
    use super::{SignoffSession, SignoffSpec};
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};

    fn server(
        responses: Vec<(u16, &'static str, &'static str)>,
    ) -> (String, JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut requests = Vec::new();
            for (status, headers, body) in responses {
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(Instant::now() < deadline, "missing HTTP request");
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("accept: {error}"),
                    }
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(&mut stream);
                let mut request = String::new();
                let mut length = 0;
                loop {
                    let mut header = String::new();
                    assert_ne!(reader.read_line(&mut header).unwrap(), 0);
                    if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:")
                    {
                        length = value.trim().parse().unwrap();
                    }
                    request.push_str(&header);
                    if header == "\r\n" {
                        break;
                    }
                }
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).unwrap();
                request.push_str(&String::from_utf8(bytes).unwrap());
                requests.push(request);
                write!(stream, "HTTP/1.1 {status} Test\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
            requests
        });
        (url, server)
    }

    const CSRF: &str = "Set-Cookie: csrftoken=first; Path=/\r\n";
    const LOGIN: &str = "Set-Cookie: sessionid=session; Path=/\r\nSet-Cookie: csrftoken=second; Path=/\r\nLocation: /unexpected\r\n";

    #[test]
    fn logs_out_after_a_failed_read_and_does_not_logout_twice() {
        for explicit_logout in [false, true] {
            let (url, server) = server(vec![
                (200, CSRF, ""),
                (302, LOGIN, ""),
                (500, "", ""),
                (200, "", ""),
            ]);
            {
                let session = SignoffSession::login("tester", "password", &url).unwrap();
                assert!(session.get_signoffs().is_err());
                if explicit_logout {
                    session.logout();
                    session.logout();
                }
            }
            let requests = server.join().unwrap();
            let paths: Vec<_> = requests.iter().map(|r| r.lines().next().unwrap()).collect();
            assert_eq!(
                paths,
                [
                    "GET /login/ HTTP/1.1",
                    "POST /login/ HTTP/1.1",
                    "GET /packages/signoffs/json/ HTTP/1.1",
                    "POST /logout/ HTTP/1.1"
                ]
            );
        }
    }

    #[test]
    fn rotated_tokens_are_used_for_signoff_and_logout() {
        let (url, server) = server(vec![
            (200, CSRF, ""),
            (302, LOGIN, ""),
            (
                200,
                "Set-Cookie: csrftoken=third; Path=/\r\n",
                "{\"signoff_groups\":[]}",
            ),
            (403, "", ""),
            (200, "", ""),
        ]);
        {
            let session = SignoffSession::login("tester", "päss☃&", &url).unwrap();
            assert!(session.get_signoffs().unwrap().is_empty());
            let error = session
                .signoff_package(&SignoffSpec {
                    repo: "core".into(),
                    arch: "x86_64".into(),
                    pkgbase: "linux".into(),
                })
                .unwrap_err();
            assert!(
                error
                    .chain()
                    .any(|e| e.downcast_ref::<arch_http_client::Error>()
                        == Some(&arch_http_client::Error::Status(403)))
            );
        }
        let requests = server.join().unwrap();
        assert!(requests[1].contains("password=p%C3%A4ss%E2%98%83%26"));
        assert!(requests[1].contains("csrfmiddlewaretoken=first"));
        assert!(requests[2].contains("csrftoken=second"));
        assert!(requests[3].starts_with("POST /packages/core/x86_64/linux/signoff/ HTTP/1.1"));
        assert!(requests[3].contains("csrfmiddlewaretoken=third"));
        assert!(requests[4].contains("csrfmiddlewaretoken=third"));
    }

    #[test]
    fn failed_login_does_not_create_an_authenticated_session() {
        let (url, server) = server(vec![(200, CSRF, ""), (200, "", "")]);
        assert!(SignoffSession::login("tester", "wrong", &url).is_err());
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[1].starts_with("POST /login/ HTTP/1.1"));
    }
    #[test]
    fn a_partial_login_response_still_logs_out() {
        let (url, server) = server(vec![
            (200, CSRF, ""),
            (
                200,
                "Set-Cookie: sessionid=partial; Path=/\r\nTransfer-Encoding: chunked\r\n",
                "2\r\nx",
            ),
            (200, "", ""),
        ]);
        assert!(SignoffSession::login("tester", "password", &url).is_err());
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 3);
        assert!(requests[2].starts_with("POST /logout/ HTTP/1.1"));
        assert!(requests[2].contains("sessionid=partial"));
    }

    #[test]
    fn simultaneous_accounts_keep_distinct_cookies() {
        let (url, server) = server(vec![
            (200, CSRF, ""),
            (302, LOGIN, ""),
            (200, CSRF, ""),
            (302, "Set-Cookie: sessionid=other; Path=/\r\n", ""),
            (200, "", "{\"signoff_groups\":[]}"),
            (200, "", "{\"signoff_groups\":[]}"),
            (500, "", ""),
            (200, "", ""),
        ]);
        let first = SignoffSession::login("first", "one", &url).unwrap();
        let second = SignoffSession::login("second", "two", &url).unwrap();
        first.get_signoffs().unwrap();
        second.get_signoffs().unwrap();
        first.logout();
        first.logout();
        drop(first);
        drop(second);
        let requests = server.join().unwrap();
        assert!(requests[1].contains("username=first"));
        assert!(requests[3].contains("username=second"));
        assert!(requests[4].contains("sessionid=session"));
        assert!(!requests[4].contains("sessionid=other"));
        assert!(requests[5].contains("sessionid=other"));
        assert!(!requests[5].contains("sessionid=session"));
        assert!(requests[6].starts_with("POST /logout/ HTTP/1.1"));
        assert!(requests[7].contains("sessionid=other"));
    }
}
