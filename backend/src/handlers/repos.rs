use anyhow::Result;
use serde::Serialize;
use std::fs;
use std::path::Path;
use ts_rs::TS;

use crate::backups::{BackupResult, BackupStore, check_revision, file_revision};
use crate::models::{
    BackupSource, ListReposResponse, RepoDirectiveFull, RepoEntry, SaveReposResponse,
};
use crate::util::{EntryCounts, emit_json};
use crate::validation::{validate_directive_value, validate_repo_name};

const PACMAN_CONF_PATH: &str = "/etc/pacman.conf";
const BACKUP_PREFIX: &str = "/etc/pacman.conf.backup.";
const BACKUP_NAME_PREFIX: &str = "pacman.conf.backup.";
const BACKUP_META_PATH: &str = "/etc/.pacman-conf-backups.meta.json";
const LOCK_PATH: &str = "/etc/pacman.conf.lock";
const MAX_BACKUPS: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DirectiveKind {
    Server,
    Include,
}

#[derive(Debug, Clone)]
pub struct Directive {
    pub kind: DirectiveKind,
    pub value: String,
    pub enabled: bool,
    pub leading: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct RepoSection {
    pub name: String,
    pub enabled: bool,
    pub sig_level: Option<String>,
    pub directives: Vec<Directive>,
    pub sig_leading: Vec<String>,
    pub sig_after: usize,
    /// Lines pacman understands but this tool does not model (Usage,
    /// CacheServer, in-section comments) that followed the last directive,
    /// kept verbatim so a round-trip does not silently drop them.
    pub trailing: Vec<String>,
    pub trailing_blank_lines: usize,
}

#[derive(Debug)]
pub struct PacmanConf {
    pub preamble: String,
    pub repos: Vec<RepoSection>,
}

pub fn parse_conf(input: &str) -> PacmanConf {
    let mut preamble = String::new();
    let mut repos: Vec<RepoSection> = Vec::new();
    let mut in_repo = false;
    let mut pending: Vec<String> = Vec::new();

    for line in input.lines() {
        let trimmed = line.trim();

        let (is_commented_section, section_name) = parse_section_header(trimmed);

        if let Some(name) = section_name {
            if let Some(previous) = repos.last_mut() {
                previous.trailing = std::mem::take(&mut pending);
            } else {
                pending.clear();
            }
            if name == "options" {
                in_repo = false;
                preamble.push_str(line);
                preamble.push('\n');
                continue;
            }
            in_repo = true;
            repos.push(RepoSection {
                name,
                enabled: !is_commented_section,
                sig_level: None,
                directives: Vec::new(),
                sig_leading: Vec::new(),
                sig_after: 0,
                trailing: Vec::new(),
                trailing_blank_lines: 0,
            });
            continue;
        }

        if !in_repo {
            preamble.push_str(line);
            preamble.push('\n');
            continue;
        }

        let Some(repo) = repos.last_mut() else {
            continue;
        };

        if trimmed.is_empty() {
            repo.trailing_blank_lines += 1;
            continue;
        }

        let hashes = trimmed.chars().take_while(|c| *c == '#').count();
        let content = trimmed[hashes..].trim();
        let commented = hashes > 0;

        let ours = !repo.enabled && commented;
        // One hash inside a disabled section is the serializer's; a second is
        // the user's own switch for that mirror.
        let directive_enabled = if repo.enabled {
            hashes == 0
        } else {
            hashes <= 1
        };

        if let Some(val) = strip_key_value(content, "SigLevel") {
            repo.sig_level = Some(val.to_string());
            repo.sig_leading = std::mem::take(&mut pending);
            repo.sig_after = repo.directives.len();
        } else if let Some(val) = strip_key_value(content, "Server") {
            repo.directives.push(Directive {
                kind: DirectiveKind::Server,
                value: val.to_string(),
                enabled: directive_enabled,
                leading: std::mem::take(&mut pending),
            });
        } else if let Some(val) = strip_key_value(content, "Include") {
            repo.directives.push(Directive {
                kind: DirectiveKind::Include,
                value: val.to_string(),
                enabled: directive_enabled,
                leading: std::mem::take(&mut pending),
            });
        } else if ours {
            pending.push(uncomment_once(trimmed).to_string());
        } else {
            pending.push(trimmed.to_string());
        }
    }

    if let Some(repo) = repos.last_mut() {
        repo.trailing = std::mem::take(&mut pending);
    }

    PacmanConf { preamble, repos }
}

fn uncomment_once(trimmed: &str) -> &str {
    let rest = &trimmed[1..];
    if rest.starts_with('#') || reads_as_setting(rest.trim_start_matches('#').trim()) {
        rest
    } else {
        trimmed
    }
}

fn reads_as_setting(content: &str) -> bool {
    content.split_once('=').is_some_and(|(key, _)| {
        let key = key.trim();
        !key.is_empty()
            && key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    })
}

fn parse_section_header(trimmed: &str) -> (bool, Option<String>) {
    if trimmed.starts_with('#') {
        let inner = trimmed.trim_start_matches('#').trim();
        if inner.starts_with('[') && inner.ends_with(']') && inner.len() > 2 {
            let name = &inner[1..inner.len() - 1];
            return (true, Some(name.to_string()));
        }
        return (false, None);
    }

    if trimmed.starts_with('[') && trimmed.ends_with(']') && trimmed.len() > 2 {
        let name = &trimmed[1..trimmed.len() - 1];
        (false, Some(name.to_string()))
    } else {
        (false, None)
    }
}

fn strip_key_value<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(key)?;
    let rest = rest.trim_start();
    let rest = rest.strip_prefix('=')?;
    Some(rest.trim())
}

pub fn serialize_conf(conf: &PacmanConf) -> String {
    let mut output = conf.preamble.clone();

    for repo in &conf.repos {
        if repo.enabled {
            output.push_str(&format!("[{}]\n", repo.name));
        } else {
            output.push_str(&format!("#[{}]\n", repo.name));
        }

        let emit_raw = |output: &mut String, raw: &str| {
            if !repo.enabled {
                output.push('#');
            }
            output.push_str(raw);
            output.push('\n');
        };

        let emit_sig = |output: &mut String| {
            if let Some(ref sig) = repo.sig_level {
                for raw in &repo.sig_leading {
                    emit_raw(output, raw);
                }
                if repo.enabled {
                    output.push_str(&format!("SigLevel = {}\n", sig));
                } else {
                    output.push_str(&format!("#SigLevel = {}\n", sig));
                }
            }
        };

        let mut sig_written = false;
        if repo.sig_after == 0 {
            emit_sig(&mut output);
            sig_written = true;
        }

        for (index, directive) in repo.directives.iter().enumerate() {
            if !sig_written && index == repo.sig_after {
                emit_sig(&mut output);
                sig_written = true;
            }

            for raw in &directive.leading {
                emit_raw(&mut output, raw);
            }

            let key = match directive.kind {
                DirectiveKind::Server => "Server",
                DirectiveKind::Include => "Include",
            };
            if !repo.enabled {
                output.push('#');
            }
            if !directive.enabled {
                output.push('#');
            }
            output.push_str(&format!("{} = {}\n", key, directive.value));
        }

        if !sig_written {
            emit_sig(&mut output);
        }

        for raw in &repo.trailing {
            emit_raw(&mut output, raw);
        }

        for _ in 0..repo.trailing_blank_lines {
            output.push('\n');
        }
    }

    output
}

fn repo_section_to_entry(section: &RepoSection) -> RepoEntry {
    RepoEntry {
        name: section.name.clone(),
        enabled: section.enabled,
        sig_level: section.sig_level.clone(),
        directives: section
            .directives
            .iter()
            .map(|d| RepoDirectiveFull {
                directive_type: match d.kind {
                    DirectiveKind::Server => "Server".to_string(),
                    DirectiveKind::Include => "Include".to_string(),
                },
                value: d.value.clone(),
                enabled: d.enabled,
            })
            .collect(),
    }
}

fn entry_to_repo_section(entry: &RepoEntry) -> RepoSection {
    RepoSection {
        name: entry.name.clone(),
        enabled: entry.enabled,
        sig_level: entry.sig_level.clone(),
        directives: entry
            .directives
            .iter()
            .map(|d| Directive {
                kind: if d.directive_type == "Server" {
                    DirectiveKind::Server
                } else {
                    DirectiveKind::Include
                },
                value: d.value.clone(),
                enabled: d.enabled,
                leading: Vec::new(),
            })
            .collect(),
        sig_leading: Vec::new(),
        sig_after: 0,
        trailing: Vec::new(),
        trailing_blank_lines: 1,
    }
}

pub fn list_repos() -> Result<()> {
    let path = Path::new(PACMAN_CONF_PATH);
    if !path.exists() {
        anyhow::bail!("pacman.conf not found at {}", PACMAN_CONF_PATH);
    }

    let content = fs::read_to_string(path)?;
    let conf = parse_conf(&content);

    let repos: Vec<RepoEntry> = conf.repos.iter().map(repo_section_to_entry).collect();
    let sync_dir = crate::handlers::lock::db_lock_path().with_file_name("sync");

    emit_json(&ListReposResponse {
        not_synced: repos
            .iter()
            .filter(|r| r.enabled && !sync_dir.join(format!("{}.db", r.name)).is_file())
            .map(|r| r.name.clone())
            .collect(),
        repos,
        revision: revision(&content),
    })
}

fn ensure_repos_usable(repos: &[RepoEntry]) -> Result<()> {
    let usable = repos
        .iter()
        .any(|r| r.enabled && r.directives.iter().any(|d| d.enabled));
    if !usable {
        anyhow::bail!(
            "Invalid repository list: no enabled repository has an enabled Server or Include, \
             which would leave pacman with no package source"
        );
    }
    Ok(())
}

fn revision(content: &str) -> String {
    file_revision(content.as_bytes())
}

fn backup_store() -> BackupStore<'static> {
    BackupStore {
        target: Path::new(PACMAN_CONF_PATH),
        lock: Path::new(LOCK_PATH),
        manifest: Path::new(BACKUP_META_PATH),
        name_prefix: BACKUP_NAME_PREFIX,
        keep: MAX_BACKUPS,
    }
}

pub fn save_repos(repos: &[RepoEntry], expected_revision: &str) -> Result<()> {
    let (result, revision) = save_repos_to(repos, expected_revision, &backup_store())?;
    emit_json(&SaveReposResponse {
        success: true,
        backup_path: result.backup_path,
        backup_timestamp: result.backup_timestamp,
        message: format!("Saved {} repositories to {}", repos.len(), PACMAN_CONF_PATH),
        revision,
        warnings: result.warnings,
    })
}

fn save_repos_to(
    repos: &[RepoEntry],
    expected_revision: &str,
    store: &BackupStore<'_>,
) -> Result<(BackupResult, String)> {
    ensure_repos_usable(repos)?;

    let mut seen = std::collections::HashSet::new();
    for entry in repos {
        validate_repo_name(&entry.name)?;
        if ["options", "local"].contains(&entry.name.as_str()) || !seen.insert(&entry.name) {
            return Err(crate::models::InvalidInput(format!(
                "Repository [{}] is reserved or listed more than once",
                entry.name
            ))
            .into());
        }
        if let Some(ref sig) = entry.sig_level {
            validate_directive_value(sig)?;
        }
        for d in &entry.directives {
            if d.directive_type != "Server" && d.directive_type != "Include" {
                anyhow::bail!(
                    "Invalid directive type '{}' for repo '{}': must be 'Server' or 'Include'",
                    d.directive_type,
                    entry.name
                );
            }
            validate_directive_value(&d.value)?;
        }
    }

    crate::util::with_file_lock(store.lock, || {
        let original = fs::read_to_string(store.target)?;
        check_revision(original.as_bytes(), expected_revision)?;
        let mut conf = parse_conf(&original);

        let mut preserved: std::collections::HashMap<String, RepoSection> =
            conf.repos.drain(..).map(|r| (r.name.clone(), r)).collect();

        conf.repos = repos.iter().map(entry_to_repo_section).collect();
        for section in &mut conf.repos {
            let Some(old) = preserved.remove(&section.name) else {
                continue;
            };
            section.sig_leading = old.sig_leading;
            section.sig_after = old.sig_after;
            section.trailing = old.trailing;
            section.trailing_blank_lines = old.trailing_blank_lines;

            let mut by_value: std::collections::HashMap<(DirectiveKind, String), Vec<String>> = old
                .directives
                .into_iter()
                .filter(|d| !d.leading.is_empty())
                .map(|d| ((d.kind, d.value), d.leading))
                .collect();
            for directive in &mut section.directives {
                if let Some(leading) = by_value.remove(&(directive.kind, directive.value.clone())) {
                    directive.leading = leading;
                }
            }

            for (_, orphaned) in by_value {
                section.trailing.extend(orphaned);
            }
        }

        let new_content = serialize_conf(&conf);

        let result = store.replace_locked(new_content.as_bytes(), BackupSource::Manual)?;
        Ok((result, revision(&new_content)))
    })
}

#[derive(Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct RepoBackup {
    #[ts(type = "number")]
    pub timestamp: i64,
    pub date: String,
    pub repo_count: usize,
    pub enabled_count: usize,
    #[ts(type = "number")]
    pub size: u64,
    pub source: BackupSource,
}

#[derive(Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct RepoBackupListResponse {
    pub backups: Vec<RepoBackup>,
    pub warnings: Vec<String>,
}

#[derive(Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct RestoreRepoBackupResponse {
    pub revision: Option<String>,
    #[ts(type = "number | null")]
    pub backup_timestamp: Option<i64>,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
    pub message: String,
    pub warnings: Vec<String>,
}

fn count_repos_in_file(path: &Path) -> Result<EntryCounts> {
    let content = fs::read_to_string(path)?;
    let conf = parse_conf(&content);
    Ok(EntryCounts {
        enabled: conf.repos.iter().filter(|r| r.enabled).count(),
        total: conf.repos.len(),
    })
}

fn ensure_repos_restorable(backup: &Path) -> Result<()> {
    let enabled = count_repos_in_file(backup)?.enabled;
    if enabled == 0 {
        anyhow::bail!(
            "Backup {} has no enabled repositories, refusing to restore",
            backup.display()
        );
    }
    Ok(())
}

pub fn list_repo_backups() -> Result<()> {
    let (entries, warnings) = backup_store().list(count_repos_in_file)?;
    let backups = entries
        .into_iter()
        .map(|entry| RepoBackup {
            timestamp: entry.timestamp,
            date: entry.date,
            repo_count: entry.counts.total,
            enabled_count: entry.counts.enabled,
            size: entry.size,
            source: entry.source,
        })
        .collect();
    emit_json(&RepoBackupListResponse { backups, warnings })
}

pub fn restore_repo_backup(timestamp: i64) -> Result<()> {
    let result = backup_store().restore(timestamp, ensure_repos_restorable)?;
    emit_json(&RestoreRepoBackupResponse {
        success: true,
        revision: Some(result.revision),
        backup_timestamp: result.backup_timestamp,
        backup_path: result.backup_path,
        message: format!("Restored pacman.conf from backup {BACKUP_PREFIX}{timestamp}"),
        warnings: result.warnings,
    })
}

pub fn undo_repo_save(timestamp: i64, expected_revision: &str) -> Result<()> {
    emit_json(&backup_store().undo(timestamp, expected_revision, ensure_repos_restorable)?)
}

pub fn delete_repo_backup(timestamp: i64) -> Result<()> {
    let warnings = backup_store().delete(timestamp)?;
    emit_json(&RestoreRepoBackupResponse {
        success: true,
        revision: None,
        backup_timestamp: None,
        backup_path: None,
        message: format!("Deleted backup {BACKUP_PREFIX}{timestamp}"),
        warnings,
    })
}

#[cfg(test)]
mod save_guard {
    use super::ensure_repos_usable;
    use crate::models::{RepoDirectiveFull, RepoEntry};

    fn repo(name: &str, enabled: bool, directive_enabled: bool) -> RepoEntry {
        RepoEntry {
            name: name.to_string(),
            enabled,
            sig_level: None,
            directives: vec![RepoDirectiveFull {
                directive_type: "Include".to_string(),
                value: "/etc/pacman.d/mirrorlist".to_string(),
                enabled: directive_enabled,
            }],
        }
    }

    #[test]
    fn a_list_with_one_usable_repo_is_accepted() {
        assert!(
            ensure_repos_usable(&[repo("core", true, true), repo("extra", false, true)]).is_ok()
        );
    }

    #[test]
    fn a_list_with_every_repo_disabled_is_refused() {
        assert!(
            ensure_repos_usable(&[repo("core", false, true), repo("extra", false, true)]).is_err()
        );
    }

    #[test]
    fn an_enabled_repo_with_no_live_directive_is_refused() {
        assert!(ensure_repos_usable(&[repo("core", true, false)]).is_err());
    }

    #[test]
    fn an_empty_list_is_refused() {
        assert!(ensure_repos_usable(&[]).is_err());
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod round_trip {
    use super::{parse_conf, serialize_conf};

    const WITH_A_DISABLED_MIRROR: &str = "[options]\nHoldPkg = pacman\n\n[core]\n# the internal mirror is first on purpose\nServer = https://internal.example/core\n#Server = https://retired.example/core\nUsage = Sync Search\nInclude = /etc/pacman.d/mirrorlist\n";

    fn toggled(conf: &str, name: &str, enabled: bool) -> String {
        let mut parsed = parse_conf(conf);
        for repo in &mut parsed.repos {
            if repo.name == name {
                repo.enabled = enabled;
            }
        }
        serialize_conf(&parsed)
    }

    #[test]
    fn a_comment_stays_with_the_line_it_documents() {
        let conf = "[core]\n# the internal mirror is first on purpose\nServer = https://internal.example/core\nUsage = Sync Search\nInclude = /etc/pacman.d/mirrorlist\nSigLevel = Required\n";

        let out = serialize_conf(&parse_conf(conf));

        let comment = out
            .find("# the internal mirror is first on purpose")
            .expect("comment kept");
        let server = out
            .find("Server = https://internal.example/core")
            .expect("server kept");
        assert!(
            comment < server,
            "the comment must stay above its Server:\n{out}"
        );

        let usage = out.find("Usage = Sync Search").expect("usage kept");
        let include = out
            .find("Include = /etc/pacman.d/mirrorlist")
            .expect("include kept");
        assert!(
            usage < include,
            "Usage must stay above the Include it preceded:\n{out}"
        );
    }

    #[test]
    fn a_section_round_trips_unchanged_when_nothing_is_edited() {
        for conf in [
            "[options]\nHoldPkg = pacman\n\n[core]\n# note\nServer = https://a.example/core\nUsage = Sync\nInclude = /etc/pacman.d/mirrorlist\n",
            "[core]\n# note\nServer = https://a.example/core\nInclude = /etc/pacman.d/mirrorlist\nSigLevel = Required\n",
            "[core]\nSigLevel = Required\nServer = https://a.example/core\n",
            "[core]\nServer = https://a.example/core\nSigLevel = Required\nInclude = /etc/pacman.d/mirrorlist\n",
        ] {
            assert_eq!(
                serialize_conf(&parse_conf(conf)),
                conf,
                "round trip changed:\n{conf}"
            );
        }
    }

    #[test]
    fn a_repo_still_has_its_sources_after_being_disabled_and_re_enabled() {
        let off = toggled(WITH_A_DISABLED_MIRROR, "core", false);
        assert!(off.contains("#[core]"), "section is disabled: {off}");

        let on = toggled(&off, "core", true);
        assert!(
            on.contains("\nServer = https://internal.example/core\n"),
            "{on}"
        );
        assert!(
            on.contains("\nInclude = /etc/pacman.d/mirrorlist\n"),
            "{on}"
        );
        assert!(on.contains("\nUsage = Sync Search\n"), "{on}");
    }

    #[test]
    fn a_mirror_the_user_disabled_stays_disabled_across_the_cycle() {
        let on = toggled(
            &toggled(WITH_A_DISABLED_MIRROR, "core", false),
            "core",
            true,
        );
        assert!(
            on.contains("#Server = https://retired.example/core"),
            "{on}"
        );
    }

    #[test]
    fn prose_the_user_wrote_is_not_turned_into_a_directive() {
        let on = toggled(
            &toggled(WITH_A_DISABLED_MIRROR, "core", false),
            "core",
            true,
        );
        assert!(
            on.contains("# the internal mirror is first on purpose"),
            "{on}"
        );
        assert!(
            !on.contains("\n the internal mirror"),
            "comment lost its #: {on}"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{
        backup_store, ensure_repos_restorable, parse_conf, repo_section_to_entry, revision,
        save_repos_to,
    };

    #[test]
    fn reserved_and_duplicate_repositories_fail_before_disk_access() {
        for names in [vec!["options"], vec!["local"], vec!["core", "core"]] {
            let repos: Vec<_> = names
                .into_iter()
                .map(|name| crate::models::RepoEntry {
                    name: name.into(),
                    enabled: true,
                    sig_level: None,
                    directives: vec![crate::models::RepoDirectiveFull {
                        directive_type: "Include".into(),
                        value: "/etc/pacman.d/mirrorlist".into(),
                        enabled: true,
                    }],
                })
                .collect();
            let error = save_repos_to(&repos, "revision", &backup_store())
                .err()
                .unwrap();
            assert!(error.is::<crate::models::InvalidInput>());
        }
    }

    #[test]
    fn a_stale_save_preserves_external_edits_and_a_fresh_save_can_delete_them() {
        let directory = std::env::temp_dir().join(format!("cpac-repos-cas-{}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let target = directory.join("pacman.conf");
        let lock = directory.join("lock");
        let manifest = directory.join("meta.json");
        let store = crate::backups::BackupStore {
            target: &target,
            lock: &lock,
            manifest: &manifest,
            ..backup_store()
        };
        let original =
            "[options]\nHoldPkg = pacman glibc\n\n[core]\nInclude = /etc/pacman.d/mirrorlist\n";
        let repos: Vec<_> = parse_conf(original)
            .repos
            .iter()
            .map(repo_section_to_entry)
            .collect();
        let changed =
            format!("{original}\n[external]\nServer = https://example.test/$repo/os/$arch\n");
        std::fs::write(&target, &changed).unwrap();

        assert!(save_repos_to(&repos, &revision(original), &store).is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), changed);
        assert!(!manifest.exists());
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 2);

        let (result, saved_revision) = save_repos_to(&repos, &revision(&changed), &store).unwrap();
        let saved = std::fs::read_to_string(&target).unwrap();
        assert_eq!(parse_conf(&saved).repos.len(), 1);
        assert_eq!(saved_revision, revision(&saved));
        assert_eq!(
            std::fs::read_to_string(result.backup_path.unwrap()).unwrap(),
            changed
        );
        assert!(result.warnings.is_empty());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_backup_whose_sections_are_all_commented_is_refused() {
        let path = std::env::temp_dir().join(format!("cpac-repos-{}", std::process::id()));
        let commented = "[options]\nHoldPkg = pacman glibc\n\n#[core]\n#Include = /etc/pacman.d/mirrorlist\n\n#[extra]\n#Include = /etc/pacman.d/mirrorlist\n";

        std::fs::write(&path, commented).unwrap();
        assert!(ensure_repos_restorable(&path).is_err());

        std::fs::write(
            &path,
            format!("{commented}\n[multilib]\nInclude = /etc/pacman.d/mirrorlist\n"),
        )
        .unwrap();
        assert!(ensure_repos_restorable(&path).is_ok());

        std::fs::remove_file(&path).unwrap();
    }
}
