use anyhow::{Context, Result};
use archweb_client::models::SignoffSpec;
use archweb_client::{DEFAULT_BASE_URL, SignoffSession};

use crate::models::{
    Signoff, SignoffActionResponse, SignoffBatchResponse, SignoffBatchResult,
    SignoffGroupWithLocal, SignoffListResponse, SignoffTarget, VersionMatch,
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
        &crate::endpoints::endpoint(DEFAULT_BASE_URL, "COCKPIT_PACMAN_TEST_ARCHWEB_URL")?,
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
        &crate::endpoints::endpoint(DEFAULT_BASE_URL, "COCKPIT_PACMAN_TEST_ARCHWEB_URL")?,
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

const MAX_SIGNOFF_BATCH: usize = 100;

pub fn parse_signoff_batch(payload: &str) -> Result<Vec<SignoffTarget>> {
    crate::validation::validate_json_payload_size(payload)?;
    let targets: Vec<SignoffTarget> =
        serde_json::from_str(payload).context("Invalid signoff batch JSON")?;
    if targets.is_empty() || targets.len() > MAX_SIGNOFF_BATCH {
        anyhow::bail!("A signoff batch requires between 1 and {MAX_SIGNOFF_BATCH} packages");
    }
    let mut seen = std::collections::HashSet::new();
    for target in &targets {
        crate::validation::validate_signoff_arg(&target.pkgbase, "pkgbase")?;
        crate::validation::validate_signoff_arg(&target.repo, "repo")?;
        crate::validation::validate_signoff_arg(&target.arch, "arch")?;
        if !seen.insert((&target.pkgbase, &target.repo, &target.arch)) {
            anyhow::bail!("Duplicate signoff target: {}", target.pkgbase);
        }
    }
    Ok(targets)
}

fn collect_signoffs(
    targets: &[SignoffTarget],
    mut sign: impl FnMut(&SignoffSpec) -> Result<()>,
) -> SignoffBatchResponse {
    SignoffBatchResponse {
        results: targets
            .iter()
            .map(|target| {
                let result = sign(&SignoffSpec {
                    pkgbase: target.pkgbase.clone(),
                    repo: target.repo.clone(),
                    arch: target.arch.clone(),
                });
                SignoffBatchResult {
                    target: target.clone(),
                    success: result.is_ok(),
                    error: result.err().map(|error| format!("{error:#}")),
                }
            })
            .collect(),
    }
}

pub fn signoff_batch(creds_b64: &str, targets: &[SignoffTarget]) -> Result<()> {
    let (username, password) = resolve_credentials(creds_b64)?;
    let session = SignoffSession::login(
        &username,
        &password,
        &crate::endpoints::endpoint(DEFAULT_BASE_URL, "COCKPIT_PACMAN_TEST_ARCHWEB_URL")?,
    )?;
    let response = collect_signoffs(targets, |spec| session.signoff_package(spec));
    session.logout();
    emit_json(&response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_every_target_before_opening_a_session() {
        for payload in [
            "[]".to_string(),
            serde_json::json!([{ "pkgbase": "../linux", "repo": "core-testing", "arch": "x86_64" }]).to_string(),
            serde_json::json!([{ "pkgbase": "linux", "repo": "bad/repo", "arch": "x86_64" }]).to_string(),
            serde_json::json!([{ "pkgbase": "linux", "repo": "core-testing", "arch": "" }]).to_string(),
            serde_json::to_string(&vec![serde_json::json!({ "pkgbase": "linux", "repo": "core-testing", "arch": "x86_64" }); 101]).unwrap(),
        ] {
            assert!(parse_signoff_batch(&payload).is_err());
        }
        let target =
            serde_json::json!({ "pkgbase": "linux", "repo": "core-testing", "arch": "x86_64" });
        assert!(
            parse_signoff_batch(&serde_json::json!([target.clone(), target]).to_string()).is_err()
        );
    }

    #[test]
    fn keeps_failed_targets_and_continues_the_batch() {
        let targets = parse_signoff_batch(
            r#"[
            {"pkgbase":"linux","repo":"core-testing","arch":"x86_64"},
            {"pkgbase":"htop","repo":"extra-testing","arch":"x86_64"}
        ]"#,
        )
        .unwrap();
        let mut calls = Vec::new();
        let response = collect_signoffs(&targets, |spec| {
            calls.push(spec.pkgbase.clone());
            if spec.pkgbase == "linux" {
                anyhow::bail!("server rejected signoff");
            }
            Ok(())
        });
        assert_eq!(calls, ["linux", "htop"]);
        assert!(!response.results[0].success);
        assert_eq!(response.results[0].target.repo, "core-testing");
        assert_eq!(
            response.results[0].error.as_deref(),
            Some("server rejected signoff")
        );
        assert!(response.results[1].success);
    }
}
