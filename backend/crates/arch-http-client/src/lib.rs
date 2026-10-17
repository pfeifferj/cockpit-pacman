pub use url::Url;

use curl::easy::Easy;
use std::cell::{Cell, RefCell};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("HTTP request timed out")]
    Timeout,
    #[error("Could not resolve the server or proxy")]
    Dns,
    #[error("Could not connect to the server or proxy")]
    Connect,
    #[error("TLS connection or certificate verification failed")]
    Tls,
    #[error("HTTP server returned status {0}")]
    Status(u16),
    #[error("HTTP response exceeded the body limit")]
    BodyLimit,
    #[error("HTTP response exceeded the header limit")]
    HeaderLimit,
    #[error("HTTP response is not valid UTF-8")]
    Utf8,
    #[error("Only HTTP(S) URLs without credentials are accepted")]
    Url,
    #[error("System libcurl must support asynchronous DNS")]
    Resolver,
    #[error("HTTP transport failed (curl code {0})")]
    Transport(u32),
}

impl From<curl::Error> for Error {
    fn from(error: curl::Error) -> Self {
        if error.is_operation_timedout() {
            Self::Timeout
        } else if error.is_couldnt_resolve_host() || error.is_couldnt_resolve_proxy() {
            Self::Dns
        } else if error.is_couldnt_connect() {
            Self::Connect
        } else if error.is_ssl_connect_error()
            || error.is_peer_failed_verification()
            || error.is_ssl_certproblem()
            || error.is_ssl_cacert_badfile()
        {
            Self::Tls
        } else {
            // Curl's extended error text can contain proxy credentials.
            Self::Transport(error.code())
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug)]
pub struct Options {
    pub timeout: Duration,
    pub connect_timeout: Duration,
    pub upload_timeout: Option<Duration>,
    pub body_timeout: Option<Duration>,
    pub max_body: usize,
    pub max_headers: usize,
    pub max_redirects: u32,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(30),
            connect_timeout: Duration::from_secs(10),
            upload_timeout: None,
            body_timeout: None,
            max_body: 8 * 1024 * 1024,
            max_headers: 128 * 1024,
            max_redirects: 5,
        }
    }
}

pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
    pub headers: Vec<(String, String)>,
}

impl Response {
    pub fn text(self) -> Result<String> {
        String::from_utf8(self.body).map_err(|_| Error::Utf8)
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .rev()
            .find_map(|(key, value)| key.eq_ignore_ascii_case(name).then_some(value.as_str()))
    }
}

#[derive(Clone, Default)]
pub struct Client {
    options: Options,
}

impl Client {
    pub fn new(options: Options) -> Self {
        Self { options }
    }

    pub fn get(&self, url: &str) -> Result<Response> {
        request(&mut Easy::new(), &self.options, url, Method::Get, false)
    }

    pub fn head(&self, url: &str) -> Result<Response> {
        request(&mut Easy::new(), &self.options, url, Method::Head, false)
    }
}

pub struct Session {
    handle: RefCell<Easy>,
    options: Options,
}

impl Session {
    pub fn new(options: Options) -> Result<Self> {
        let mut handle = Easy::new();
        handle.cookie_file("")?;
        Ok(Self {
            handle: RefCell::new(handle),
            options,
        })
    }

    pub fn get(&self, url: &str) -> Result<Response> {
        request(
            &mut self.handle.borrow_mut(),
            &self.options,
            url,
            Method::Get,
            true,
        )
    }

    pub fn post_form(&self, url: &str, form: &[(&str, &str)]) -> Result<Response> {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(form.iter().copied())
            .finish();
        request(
            &mut self.handle.borrow_mut(),
            &self.options,
            url,
            Method::Post(&body),
            true,
        )
    }

    pub fn cookie(&self, url: &str, name: &str) -> Result<Option<String>> {
        let url = parse_url(url)?;
        let host = url.host_str().ok_or(Error::Url)?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let cookies = self.handle.borrow_mut().cookies()?;
        let mut selected = None;
        let mut longest_path = 0;
        for cookie in cookies.iter() {
            let Ok(cookie) = std::str::from_utf8(cookie) else {
                continue;
            };
            let fields: Vec<_> = cookie
                .trim_start_matches("#HttpOnly_")
                .split('\t')
                .collect();
            if fields.len() != 7 || fields[5] != name {
                continue;
            }
            let domain = fields[0].trim_start_matches('.');
            let domain_match = host.eq_ignore_ascii_case(domain)
                || (fields[1] == "TRUE"
                    && host
                        .to_ascii_lowercase()
                        .ends_with(&format!(".{}", domain.to_ascii_lowercase())));
            let path = fields[2];
            let path_match = url.path() == path
                || (url.path().starts_with(path)
                    && (path.ends_with('/')
                        || url.path().as_bytes().get(path.len()) == Some(&b'/')));
            let expiry = fields[4].parse::<u64>().unwrap_or(1);
            if domain_match
                && path_match
                && (fields[3] != "TRUE" || url.scheme() == "https")
                && (expiry == 0 || expiry > now)
                && path.len() >= longest_path
            {
                selected = Some(fields[6].to_string());
                longest_path = path.len();
            }
        }
        Ok(selected)
    }
}

enum Method<'a> {
    Get,
    Head,
    Post(&'a str),
}

fn parse_url(value: &str) -> Result<Url> {
    if value.chars().any(char::is_control) {
        return Err(Error::Url);
    }
    let url = Url::parse(value).map_err(|_| Error::Url)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(Error::Url);
    }
    Ok(url)
}

fn restrict_protocols(handle: &mut Easy) -> Result<()> {
    for option in [
        curl_sys::CURLOPT_PROTOCOLS,
        curl_sys::CURLOPT_REDIR_PROTOCOLS,
    ] {
        // Both options take a C long; the handle is exclusively borrowed here.
        let code = unsafe {
            curl_sys::curl_easy_setopt(
                handle.raw(),
                option,
                (curl_sys::CURLPROTO_HTTP | curl_sys::CURLPROTO_HTTPS) as std::ffi::c_long,
            )
        };
        if code != curl_sys::CURLE_OK {
            return Err(curl::Error::new(code).into());
        }
    }
    Ok(())
}

fn request(
    handle: &mut Easy,
    options: &Options,
    url: &str,
    method: Method<'_>,
    cookies: bool,
) -> Result<Response> {
    let url = parse_url(url)?;
    if !curl::Version::get().feature_async_dns() {
        return Err(Error::Resolver);
    }
    // Reset preserves the cookie engine but clears POST bodies and request headers.
    handle.reset();
    if cookies {
        handle.cookie_file("")?;
    }
    restrict_protocols(handle)?;
    handle.url(url.as_str())?;
    handle.signal(false)?;
    handle.timeout(options.timeout)?;
    handle.connect_timeout(options.connect_timeout)?;
    handle.ssl_verify_peer(true)?;
    handle.ssl_verify_host(true)?;
    handle.proxy_ssl_verify_peer(true)?;
    handle.proxy_ssl_verify_host(true)?;
    handle.accept_encoding("")?;
    handle.fail_on_error(true)?;
    handle.progress(options.upload_timeout.is_some() || options.body_timeout.is_some())?;
    handle.follow_location(!matches!(method, Method::Post(_)) && options.max_redirects > 0)?;
    handle.max_redirections(options.max_redirects)?;
    match method {
        Method::Get => handle.get(true)?,
        Method::Head => handle.nobody(true)?,
        Method::Post(body) => {
            handle.post_fields_copy(body.as_bytes())?;
            handle.referer(url.as_str())?;
        }
    }
    let mut response = Response {
        status: 0,
        body: Vec::new(),
        headers: Vec::new(),
    };
    let header_bytes = Cell::new(0usize);
    let body_bytes = Cell::new(0usize);
    let limit = Cell::new(None);
    let upload_started = Cell::new(None::<Instant>);
    let body_started = Cell::new(None::<Instant>);
    let header_status = Cell::new(0u16);
    let timed_out = Cell::new(false);
    let body = RefCell::new(&mut response.body);
    let result = {
        let mut transfer = handle.transfer();
        transfer.progress_function(|_, _, upload_total, uploaded| {
            if upload_total > 0.0 && uploaded < upload_total && upload_started.get().is_none() {
                upload_started.set(Some(Instant::now()));
            }
            let upload_expired = uploaded < upload_total
                && options
                    .upload_timeout
                    .zip(upload_started.get())
                    .is_some_and(|(limit, start)| start.elapsed() >= limit);
            let body_expired = options
                .body_timeout
                .zip(body_started.get())
                .is_some_and(|(limit, start)| start.elapsed() >= limit);
            timed_out.set(upload_expired || body_expired);
            !timed_out.get()
        })?;
        transfer.header_function(|line| {
            header_bytes.set(header_bytes.get().saturating_add(line.len()));
            if header_bytes.get() > options.max_headers {
                limit.set(Some(false));
                return false;
            }
            if line.starts_with(b"HTTP/") {
                response.headers.clear();
                body.borrow_mut().clear();
                body_started.set(None);
                header_status.set(
                    std::str::from_utf8(line)
                        .ok()
                        .and_then(|line| line.split_whitespace().nth(1))
                        .and_then(|status| status.parse().ok())
                        .unwrap_or(0),
                );
            } else if line == b"\r\n" && header_status.get() >= 200 {
                body_started.set(Some(Instant::now()));
            } else if let Some((name, value)) = String::from_utf8_lossy(line).split_once(':') {
                response
                    .headers
                    .push((name.trim().to_string(), value.trim().to_string()));
            }
            true
        })?;
        transfer.write_function(|bytes| {
            body_bytes.set(body_bytes.get().saturating_add(bytes.len()));
            if body_bytes.get() > options.max_body {
                limit.set(Some(true));
                return Ok(0);
            }
            body.borrow_mut().extend_from_slice(bytes);
            Ok(bytes.len())
        })?;
        transfer.perform()
    };
    if timed_out.get() {
        return Err(Error::Timeout);
    }
    if let Some(body) = limit.get() {
        return Err(if body {
            Error::BodyLimit
        } else {
            Error::HeaderLimit
        });
    }
    let status = handle.response_code()? as u16;
    let proxy_status = handle.http_connectcode()?;
    if proxy_status == 407 {
        return Err(Error::Status(407));
    }
    if status >= 400 {
        return Err(Error::Status(status));
    }
    result?;
    response.status = status;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_lookup_obeys_domain_path_secure_and_expiry() {
        let session = Session::new(Options::default()).unwrap();
        for cookie in [
            "example.org\tFALSE\t/\tFALSE\t0\tcsrf\troot",
            "example.org\tFALSE\t/login\tFALSE\t0\tcsrf\tlogin",
            "example.org\tFALSE\t/\tTRUE\t0\tsecure\tsecret",
            "example.org\tFALSE\t/\tFALSE\t1\texpired\told",
            ".example.org\tTRUE\t/\tFALSE\t0\tdomain\tshared",
        ] {
            session.handle.borrow_mut().cookie_list(cookie).unwrap();
        }
        assert_eq!(
            session
                .cookie("http://example.org/login/sub", "csrf")
                .unwrap()
                .as_deref(),
            Some("login")
        );
        assert_eq!(
            session
                .cookie("http://example.org/login-other", "csrf")
                .unwrap()
                .as_deref(),
            Some("root")
        );
        assert!(
            session
                .cookie("http://example.org/", "secure")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            session
                .cookie("https://example.org/", "secure")
                .unwrap()
                .as_deref(),
            Some("secret")
        );
        assert!(
            session
                .cookie("https://example.org/", "expired")
                .unwrap()
                .is_none()
        );
        assert!(
            session
                .cookie("https://sub.example.org/", "csrf")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            session
                .cookie("https://sub.example.org/", "domain")
                .unwrap()
                .as_deref(),
            Some("shared")
        );
        assert!(
            session
                .cookie("https://notexample.org/", "domain")
                .unwrap()
                .is_none()
        );
    }
}
