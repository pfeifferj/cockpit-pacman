use anyhow::Result;
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::Path;
use ts_rs::TS;

use crate::models::{
    BackupSource, ListReposResponse, RepoDirectiveFull, RepoEntry, SaveReposResponse,
};
use crate::util::emit_json;
use crate::validation::{validate_directive_value, validate_repo_name};

const PACMAN_CONF_PATH: &str = "/etc/pacman.conf";
const BACKUP_PREFIX: &str = "/etc/pacman.conf.backup.";
const BACKUP_NAME_PREFIX: &str = "pacman.conf.backup.";
const BACKUP_DIR: &str = "/etc";
const BACKUP_META_PATH: &str = "/etc/.pacman-conf-backups.meta.json";
const LOCK_PATH: &str = "/etc/pacman.conf.lock";
const MAX_BACKUPS: usize = 5;

#[derive(Debug, Clone, PartialEq)]
pub enum DirectiveKind {
    Server,
    Include,
}

#[derive(Debug, Clone)]
pub struct Directive {
    pub kind: DirectiveKind,
    pub value: String,
    pub enabled: bool,
}

#[derive(Debug, Clone)]
pub struct RepoSection {
    pub name: String,
    pub enabled: bool,
    pub sig_level: Option<String>,
    pub directives: Vec<Directive>,
    /// Lines pacman understands but this tool does not model (Usage,
    /// CacheServer, in-section comments), kept verbatim so a round-trip does
    /// not silently drop them.
    pub passthrough: Vec<String>,
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

    for line in input.lines() {
        let trimmed = line.trim();

        let (is_commented_section, section_name) = parse_section_header(trimmed);

        if let Some(name) = section_name {
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
                passthrough: Vec::new(),
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

        let (commented, content) = if trimmed.starts_with('#') {
            (true, trimmed.trim_start_matches('#').trim())
        } else {
            (false, trimmed)
        };

        if let Some(val) = strip_key_value(content, "SigLevel") {
            repo.sig_level = Some(val.to_string());
        } else if let Some(val) = strip_key_value(content, "Server") {
            repo.directives.push(Directive {
                kind: DirectiveKind::Server,
                value: val.to_string(),
                enabled: !commented,
            });
        } else if let Some(val) = strip_key_value(content, "Include") {
            repo.directives.push(Directive {
                kind: DirectiveKind::Include,
                value: val.to_string(),
                enabled: !commented,
            });
        } else {
            repo.passthrough.push(trimmed.to_string());
        }
    }

    PacmanConf { preamble, repos }
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

        if let Some(ref sig) = repo.sig_level {
            if repo.enabled {
                output.push_str(&format!("SigLevel = {}\n", sig));
            } else {
                output.push_str(&format!("#SigLevel = {}\n", sig));
            }
        }

        for directive in &repo.directives {
            let key = match directive.kind {
                DirectiveKind::Server => "Server",
                DirectiveKind::Include => "Include",
            };
            let line_enabled = repo.enabled && directive.enabled;
            if line_enabled {
                output.push_str(&format!("{} = {}\n", key, directive.value));
            } else {
                output.push_str(&format!("#{} = {}\n", key, directive.value));
            }
        }

        for raw in &repo.passthrough {
            // A disabled section's header is commented, so any live directive
            // under it would bind to the wrong section; comment passthrough too.
            if repo.enabled || raw.starts_with('#') {
                output.push_str(raw);
            } else {
                output.push('#');
                output.push_str(raw);
            }
            output.push('\n');
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
            })
            .collect(),
        passthrough: Vec::new(),
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

    emit_json(&ListReposResponse { repos })
}

pub fn save_repos(repos: &[RepoEntry]) -> Result<()> {
    for entry in repos {
        validate_repo_name(&entry.name)?;
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

    let path = Path::new(PACMAN_CONF_PATH);
    let parent = path.parent().unwrap_or(Path::new("/etc"));

    // Serialize the whole read/modify/backup/rename cycle so concurrent saves
    // can't lose each other's edits or clobber a backup.
    let backup_path = crate::util::with_file_lock(Path::new(LOCK_PATH), || {
        let original = fs::read_to_string(path)?;
        let mut conf = parse_conf(&original);

        // Passthrough isn't in RepoEntry, so recover it from the on-disk
        // section by name before the rewrite drops it.
        let mut preserved: std::collections::HashMap<String, Vec<String>> = conf
            .repos
            .drain(..)
            .map(|r| (r.name, r.passthrough))
            .collect();

        conf.repos = repos.iter().map(entry_to_repo_section).collect();
        for section in &mut conf.repos {
            if let Some(p) = preserved.remove(&section.name) {
                section.passthrough = p;
            }
        }

        let new_content = serialize_conf(&conf);

        let temp_path = parent.join(format!(".pacman.conf.tmp.{}", std::process::id()));
        {
            let mut file = fs::File::create(&temp_path)?;
            file.write_all(new_content.as_bytes())?;
            file.sync_all()?;
        }

        let backup_path = if path.exists() {
            let backup = crate::util::unique_backup_path(BACKUP_PREFIX);
            if let Err(e) = fs::copy(path, &backup) {
                let _ = fs::remove_file(&temp_path);
                return Err(e.into());
            }
            Some(backup)
        } else {
            None
        };

        if let Err(e) = fs::rename(&temp_path, path) {
            let _ = fs::remove_file(&temp_path);
            return Err(e.into());
        }

        cleanup_old_backups();
        note_backup(&backup_path, BackupSource::Manual);

        Ok(backup_path)
    })?;

    emit_json(&SaveReposResponse {
        success: true,
        backup_path,
        message: format!("Saved {} repositories to {}", repos.len(), PACMAN_CONF_PATH),
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
}

#[derive(Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct RestoreRepoBackupResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
    pub message: String,
}

fn count_repos_in_file(path: &Path) -> (usize, usize) {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return (0, 0),
    };
    let conf = parse_conf(&content);
    let total = conf.repos.len();
    let enabled = conf.repos.iter().filter(|r| r.enabled).count();
    (total, enabled)
}

pub fn list_repo_backups() -> Result<()> {
    let parent = Path::new(PACMAN_CONF_PATH)
        .parent()
        .unwrap_or(Path::new("/etc"));
    let mut backups: Vec<RepoBackup> = Vec::new();

    let read_dir = match fs::read_dir(parent) {
        Ok(rd) => rd,
        Err(_) => return emit_json(&RepoBackupListResponse { backups }),
    };
    let provenance = crate::util::read_backup_provenance(Path::new(BACKUP_META_PATH));

    for entry in read_dir.flatten() {
        let name = match entry.file_name().into_string() {
            Ok(n) => n,
            Err(_) => continue,
        };
        let timestamp_str = match name.strip_prefix(BACKUP_NAME_PREFIX) {
            Some(s) => s,
            None => continue,
        };
        let timestamp: i64 = match timestamp_str.parse() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        let (repo_count, enabled_count) = count_repos_in_file(&entry.path());
        let date = chrono::DateTime::from_timestamp(timestamp, 0)
            .map(|dt| dt.format("%Y-%m-%d %H:%M:%S UTC").to_string())
            .unwrap_or_else(|| "Unknown".to_string());

        let source = provenance.get(&timestamp).copied().unwrap_or_default();

        backups.push(RepoBackup {
            timestamp,
            date,
            repo_count,
            enabled_count,
            size,
            source,
        });
    }

    backups.sort_by_key(|b| std::cmp::Reverse(b.timestamp));
    emit_json(&RepoBackupListResponse { backups })
}

pub fn restore_repo_backup(timestamp: i64) -> Result<()> {
    let backup_path = format!("{}{}", BACKUP_PREFIX, timestamp);

    let pre_restore_backup = crate::util::with_file_lock(Path::new(LOCK_PATH), || {
        let backup = Path::new(&backup_path);
        if !backup.exists() {
            anyhow::bail!("Backup not found: {}", backup_path);
        }

        // Reject an empty or repo-less backup before touching the live file.
        let (total, _) = count_repos_in_file(backup);
        if total == 0 {
            anyhow::bail!(
                "Backup {} has no repositories, refusing to restore",
                backup_path
            );
        }
        let contents = fs::read(backup)?;

        let conf = Path::new(PACMAN_CONF_PATH);

        // Back up the current pacman.conf before overwriting it, so a restore is
        // itself reversible.
        let pre_restore_backup = if conf.exists() {
            let p = crate::util::unique_backup_path(BACKUP_PREFIX);
            fs::copy(conf, &p)?;
            Some(p)
        } else {
            None
        };

        crate::util::write_bytes_atomic(conf, &contents)?;

        note_backup(&pre_restore_backup, BackupSource::Auto);

        Ok(pre_restore_backup)
    })?;

    emit_json(&RestoreRepoBackupResponse {
        success: true,
        backup_path: pre_restore_backup,
        message: format!("Restored pacman.conf from backup {}", backup_path),
    })
}

pub fn delete_repo_backup(timestamp: i64) -> Result<()> {
    let backup_path = format!("{}{}", BACKUP_PREFIX, timestamp);

    crate::util::with_file_lock(Path::new(LOCK_PATH), || {
        let backup = Path::new(&backup_path);
        if !backup.exists() {
            anyhow::bail!("Backup not found: {}", backup_path);
        }
        fs::remove_file(backup)?;
        reconcile_backups();
        Ok(())
    })?;

    emit_json(&RestoreRepoBackupResponse {
        success: true,
        backup_path: None,
        message: format!("Deleted backup {}", backup_path),
    })
}

/// Keep only the most recent MAX_BACKUPS pacman.conf backups. Best-effort:
/// failures are logged, not propagated, so cleanup never fails a save. Callers
/// hold the pacman.conf lock.
fn cleanup_old_backups() {
    let parent = Path::new(PACMAN_CONF_PATH)
        .parent()
        .unwrap_or(Path::new("/etc"));
    crate::util::prune_old_backups(parent, BACKUP_NAME_PREFIX, MAX_BACKUPS);
}

fn note_backup(backup: &Option<String>, source: BackupSource) {
    if let Some(b) = backup
        && let Some(ts) = crate::util::backup_timestamp(b, BACKUP_PREFIX)
    {
        crate::util::record_backup_provenance(
            Path::new(BACKUP_META_PATH),
            Path::new(BACKUP_DIR),
            BACKUP_NAME_PREFIX,
            ts,
            source,
        );
    }
}

fn reconcile_backups() {
    crate::util::reconcile_backup_provenance(
        Path::new(BACKUP_META_PATH),
        Path::new(BACKUP_DIR),
        BACKUP_NAME_PREFIX,
    );
}
