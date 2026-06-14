use anyhow::{Context, Result};
use archweb_client::models::SignoffSpec;
use archweb_client::{DEFAULT_BASE_URL, SignoffSession};

use crate::models::{
    Signoff, SignoffActionResponse, SignoffGroupWithLocal, SignoffListResponse, VersionMatch,
};
use crate::util::emit_json;

#[derive(serde::Deserialize)]
struct Credentials {
    username: String,
    password: String,
}

pub fn resolve_credentials(encoded: &str) -> Result<(String, String)> {
    use base64::Engine;
    let json = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .context("invalid base64 in credentials")?;
    let creds: Credentials =
        serde_json::from_slice(&json).context("invalid JSON in credentials")?;
    if creds.username.is_empty() || creds.password.is_empty() {
        anyhow::bail!("username and password are required");
    }
    Ok((creds.username, creds.password))
}

/// Read the base64-encoded credential blob from stdin. Credentials are passed
/// this way, not on argv, because /proc/<pid>/cmdline is world-readable and
/// would leak the archweb password to any local user.
pub fn read_credentials_from_stdin() -> Result<String> {
    use std::io::Read;
    let mut buf = String::new();
    std::io::stdin()
        .read_to_string(&mut buf)
        .context("failed to read credentials from stdin")?;
    let creds = buf.trim().to_string();
    if creds.is_empty() {
        anyhow::bail!("no credentials provided on stdin");
    }
    Ok(creds)
}

fn get_local_version(handle: &alpm::Alpm, pkgbase: &str, pkgnames: &[String]) -> Option<String> {
    if let Ok(pkg) = handle.localdb().pkg(pkgbase) {
        return Some(pkg.version().to_string());
    }
    for name in pkgnames {
        if let Ok(pkg) = handle.localdb().pkg(name.as_str()) {
            return Some(pkg.version().to_string());
        }
    }
    None
}

pub fn signoff_list(creds_b64: &str) -> Result<()> {
    let (username, password) = resolve_credentials(creds_b64)?;
    let session = SignoffSession::login(
        &username,
        &password,
        DEFAULT_BASE_URL,
        crate::util::detected_ip_family(),
    )?;
    let groups = session.get_signoffs()?;
    session.logout();

    let handle = crate::alpm::get_handle().ok();

    let signoff_groups: Vec<SignoffGroupWithLocal> = groups
        .into_iter()
        .map(|g| {
            let (local_version, version_match) = match &handle {
                Some(h) => match get_local_version(h, &g.pkgbase, &g.pkgnames) {
                    Some(v) => {
                        let matches = v == g.version;
                        (
                            Some(v),
                            if matches {
                                VersionMatch::Match
                            } else {
                                VersionMatch::Mismatch
                            },
                        )
                    }
                    None => (None, VersionMatch::NotInstalled),
                },
                None => (None, VersionMatch::NotInstalled),
            };

            SignoffGroupWithLocal {
                pkgbase: g.pkgbase,
                pkgnames: g.pkgnames,
                version: g.version,
                arch: g.arch,
                repo: g.repo,
                packager: g.packager,
                comments: g.comments,
                last_update: g.last_update,
                known_bad: g.known_bad,
                approved: g.approved,
                required: g.required,
                enabled: g.enabled,
                signoffs: g
                    .signoffs
                    .into_iter()
                    .map(|s| Signoff {
                        user: s.user,
                        created: s.created,
                        revoked: s.revoked,
                    })
                    .collect(),
                local_version,
                version_match,
            }
        })
        .collect();

    let total = signoff_groups.len();
    emit_json(&SignoffListResponse {
        signoff_groups,
        total,
    })
}

fn run_signoff_action(
    creds_b64: &str,
    args: &[String],
    action: &str,
    f: impl FnOnce(&SignoffSession, &SignoffSpec) -> Result<()>,
) -> Result<()> {
    if args.len() < 3 {
        anyhow::bail!("{} requires pkgbase repo arch", action);
    }
    let pkgbase = &args[0];

    let (username, password) = resolve_credentials(creds_b64)?;
    let session = SignoffSession::login(
        &username,
        &password,
        DEFAULT_BASE_URL,
        crate::util::detected_ip_family(),
    )?;
    let spec = SignoffSpec {
        repo: args[1].clone(),
        arch: args[2].clone(),
        pkgbase: pkgbase.clone(),
    };

    let result = f(&session, &spec);
    session.logout();

    match result {
        Ok(()) => emit_json(&SignoffActionResponse {
            success: true,
            pkgbase: pkgbase.clone(),
            action: action.to_string(),
            error: None,
        }),
        Err(e) => emit_json(&SignoffActionResponse {
            success: false,
            pkgbase: pkgbase.clone(),
            action: action.to_string(),
            error: Some(e.to_string()),
        }),
    }
}

pub fn signoff_sign(creds_b64: &str, args: &[String]) -> Result<()> {
    run_signoff_action(creds_b64, args, "signoff", |session, spec| {
        session.signoff_package(spec)
    })
}

pub fn signoff_revoke(creds_b64: &str, args: &[String]) -> Result<()> {
    run_signoff_action(creds_b64, args, "revoke", |session, spec| {
        session.revoke_package(spec)
    })
}
