use serde::Deserialize;
use std::ffi::{OsStr, OsString};
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::sync::OnceLock;

const MAX_CONFIG_BYTES: u64 = 64 * 1024;
static POLICY: OnceLock<Result<Policy, NetworkError>> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NetworkError(&'static str);

impl std::fmt::Display for NetworkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Proxy configuration: {}", self.0)
    }
}
impl std::error::Error for NetworkError {}

struct Policy {
    deny_keyring: bool,
    diagnostic_prefixes: Vec<String>,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Inherit,
    Direct,
    Proxy,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Keyring {
    Deny,
    External,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    mode: Mode,
    all_proxy: Option<String>,
    http_proxy: Option<String>,
    https_proxy: Option<String>,
    no_proxy: Option<String>,
    keyring: Option<Keyring>,
}

fn read_config(directory: &Path, owner: u32) -> Result<Option<Config>, NetworkError> {
    let directory = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(directory)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(NetworkError("cannot open the configuration directory")),
    };
    let metadata = directory
        .metadata()
        .map_err(|_| NetworkError("cannot inspect the configuration directory"))?;
    if metadata.uid() != owner || metadata.mode() & 0o022 != 0 {
        return Err(NetworkError(
            "the configuration directory must be root-owned and not group/world writable",
        ));
    }
    // The directory descriptor prevents a path replacement between validation and open.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            c"proxy.json".as_ptr(),
            libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::NotFound {
            return Ok(None);
        }
        return Err(NetworkError(
            "cannot read proxy.json; check file permissions",
        ));
    }
    // openat returned an owned descriptor that has not been wrapped elsewhere.
    let file = unsafe { File::from_raw_fd(fd) };
    let metadata = file
        .metadata()
        .map_err(|_| NetworkError("cannot inspect proxy.json"))?;
    if !metadata.is_file() || metadata.uid() != owner || metadata.mode() & 0o022 != 0 {
        return Err(NetworkError(
            "proxy.json must be a regular root-owned file without group/world write access",
        ));
    }
    let mut bytes = Vec::new();
    file.take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| NetworkError("cannot read proxy.json"))?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(NetworkError("proxy.json exceeds 64 KiB"));
    }
    let config: Config = serde_json::from_slice(&bytes)
        .map_err(|_| NetworkError("proxy.json has invalid JSON, fields or mode"))?;
    let credentials = validate_config(&config)?;
    if credentials && metadata.mode() & 0o004 != 0 {
        return Err(NetworkError(
            "proxy credentials require restricted read permissions (0600 or deliberately shared 0640/ACL)",
        ));
    }
    Ok(Some(config))
}

fn validate_endpoint(value: &str, inherited: bool) -> Result<bool, NetworkError> {
    if value.is_empty()
        || value
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || c == '\\')
    {
        return Err(NetworkError(
            "proxy endpoints must be nonempty URLs without whitespace, backslashes or control characters",
        ));
    }
    let value = if inherited && !value.contains("://") {
        format!("http://{value}")
    } else {
        value.to_owned()
    };
    let url = arch_http_client::Url::parse(&value)
        .map_err(|_| NetworkError("invalid proxy endpoint URL"))?;
    if !matches!(url.scheme(), "http" | "https" | "socks5" | "socks5h")
        || url.host_str().is_none_or(|host| host.contains('%'))
        || !matches!(url.path(), "" | "/")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(NetworkError(
            "proxy endpoints must use HTTP, HTTPS, SOCKS5 or SOCKS5h without paths, queries or fragments",
        ));
    }
    Ok(!url.username().is_empty() || url.password().is_some())
}

fn validate_config(config: &Config) -> Result<bool, NetworkError> {
    if config.mode != Mode::Proxy {
        if config.all_proxy.is_some()
            || config.http_proxy.is_some()
            || config.https_proxy.is_some()
            || config.no_proxy.is_some()
        {
            return Err(NetworkError(
                "inherit/direct modes do not accept proxy endpoint or bypass fields",
            ));
        }
        return Ok(false);
    }
    if config.all_proxy.as_deref().is_none_or(str::is_empty) {
        return Err(NetworkError(
            "proxy mode requires all_proxy to cover every transfer scheme",
        ));
    }
    let mut credentials = false;
    for value in [&config.all_proxy, &config.http_proxy, &config.https_proxy]
        .into_iter()
        .flatten()
    {
        credentials |= validate_endpoint(value, false)?;
    }
    if config
        .no_proxy
        .as_ref()
        .is_some_and(|value| value.chars().any(char::is_control))
    {
        return Err(NetworkError("no_proxy must not contain control characters"));
    }
    Ok(credentials)
}

fn proxy_variable(name: &OsStr) -> bool {
    name.to_str()
        .is_some_and(|name| name.to_ascii_lowercase().ends_with("_proxy"))
}

fn inherited_endpoints(environment: &[(OsString, OsString)]) -> Result<Vec<String>, NetworkError> {
    let mut endpoints = Vec::new();
    for scheme in arch_http_client::supported_protocols()
        .into_iter()
        .chain(["all".into()])
    {
        if scheme == "file" {
            continue;
        }
        let name = format!("{scheme}_proxy");
        let value = |key: &str| {
            environment
                .iter()
                .find(|(name, value)| name == key && !value.is_empty())
                .map(|(_, value)| value)
        };
        let selected = value(&name).or_else(|| {
            if name == "http_proxy" {
                None
            } else {
                value(&name.to_ascii_uppercase())
            }
        });
        if let Some(value) = selected {
            let endpoint = value
                .to_str()
                .ok_or(NetworkError("proxy environment must be valid UTF-8"))?;
            validate_endpoint(endpoint, true)?;
            endpoints.push(endpoint.to_owned());
        }
    }
    Ok(endpoints)
}

struct Resolved {
    policy: Policy,
    values: Vec<(OsString, OsString)>,
    replace: bool,
}

fn resolve(
    config: Option<Config>,
    environment: &[(OsString, OsString)],
) -> Result<Resolved, NetworkError> {
    if let Some(config) = &config {
        validate_config(config)?;
    }
    let mode = config.as_ref().map_or(Mode::Inherit, |config| config.mode);
    let keyring = config.as_ref().and_then(|config| config.keyring);
    let mut endpoints = if mode == Mode::Inherit {
        inherited_endpoints(environment)?
    } else {
        Vec::new()
    };
    let active = mode == Mode::Proxy || !endpoints.is_empty();
    let deny_keyring = match keyring {
        Some(Keyring::External) => false,
        Some(Keyring::Deny) => true,
        None => mode != Mode::Inherit || active,
    };
    let mut values = Vec::new();
    if let Some(config) = config
        && mode == Mode::Proxy
    {
        for (name, value) in [
            ("all_proxy", config.all_proxy),
            ("http_proxy", config.http_proxy),
            ("https_proxy", config.https_proxy),
            ("no_proxy", config.no_proxy),
        ] {
            if let Some(value) = value {
                if name != "no_proxy" {
                    endpoints.push(value.clone());
                }
                values.push((name.into(), value.into()));
            }
        }
    }
    let diagnostic_prefixes = endpoints
        .into_iter()
        .filter(|value| validate_endpoint(value, true) == Ok(true))
        .map(|value| value.chars().take(16).collect())
        .collect();
    Ok(Resolved {
        policy: Policy {
            deny_keyring,
            diagnostic_prefixes,
        },
        values,
        replace: mode != Mode::Inherit,
    })
}

/// Initialize proxy policy before starting any other threads.
///
/// # Safety
/// No other thread may read or write the process environment during this call.
pub unsafe fn initialize(command: &str) {
    if POLICY.get().is_some() {
        return;
    }
    if !matches!(
        command,
        "sync-database"
            | "upgrade"
            | "install-package"
            | "preflight-downgrade-archive"
            | "downgrade"
            | "downgrade-archive"
            | "scheduled-run"
            | "refresh-keyring"
            | "fetch-news"
            | "fetch-mirror-status"
            | "refresh-mirrors"
            | "test-mirrors"
            | "list-archive-versions"
            | "check-security"
            | "security-info"
            | "signoff-list"
            | "signoff-sign"
            | "signoff-revoke"
            | "signoff-batch"
    ) {
        return;
    }
    // main calls this before creating any threads.
    unsafe {
        initialize_from(Path::new("/etc/cockpit-pacman"), 0);
    }
}

unsafe fn initialize_from(directory: &Path, owner: u32) {
    let environment: Vec<_> = std::env::vars_os().collect();
    let result = read_config(directory, owner)
        .and_then(|config| resolve(config, &environment))
        .map(|resolved| {
            if resolved.replace {
                for (name, _) in &environment {
                    if proxy_variable(name) {
                        // The caller guarantees exclusive access to the environment.
                        unsafe {
                            std::env::remove_var(name);
                        }
                    }
                }
                for (name, value) in resolved.values {
                    // The caller guarantees exclusive access to the environment.
                    unsafe {
                        std::env::set_var(name, value);
                    }
                }
            }
            resolved.policy
        });
    let _ = POLICY.set(result);
}

pub fn require_network() -> Result<(), NetworkError> {
    match POLICY.get() {
        Some(Ok(_)) => Ok(()),
        Some(Err(error)) => Err(*error),
        None => Err(NetworkError("network policy was not initialized")),
    }
}

pub fn require_keyring_network() -> Result<(), NetworkError> {
    require_network()?;
    if POLICY
        .get()
        .and_then(|result| result.as_ref().ok())
        .is_some_and(|policy| policy.deny_keyring)
    {
        return Err(NetworkError(
            "key refresh uses independent dirmngr routing; configure it separately and opt in with keyring: external",
        ));
    }
    Ok(())
}

impl Policy {
    fn diagnostic(&self, message: &str) -> String {
        // libcurl can truncate a credential-bearing endpoint inside its error buffer.
        if !self.diagnostic_prefixes.is_empty()
            && (message.to_ascii_lowercase().contains("proxy")
                || self
                    .diagnostic_prefixes
                    .iter()
                    .any(|prefix| message.contains(prefix)))
        {
            "Package transfer failed; check proxy configuration and connectivity".to_owned()
        } else {
            message.to_owned()
        }
    }
}

pub(crate) fn native_diagnostic(message: &str) -> String {
    match POLICY.get() {
        Some(Ok(policy)) => policy.diagnostic(message),
        _ => message.to_owned(),
    }
}

#[cfg(test)]
pub(crate) fn test_context() {
    let _ = POLICY.set(Ok(Policy {
        deny_keyring: false,
        diagnostic_prefixes: Vec::new(),
    }));
}

#[cfg(test)]
mod tests;
