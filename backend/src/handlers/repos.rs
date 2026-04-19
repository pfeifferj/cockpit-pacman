use anyhow::Result;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::models::{ListReposResponse, RepoDirectiveFull, RepoEntry, SaveReposResponse};
use crate::util::emit_json;
use crate::validation::{validate_directive_value, validate_repo_name};

const PACMAN_CONF_PATH: &str = "/etc/pacman.conf";
const BACKUP_PREFIX: &str = "/etc/pacman.conf.backup.";

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
                trailing_blank_lines: 0,
            });
            continue;
        }

        if !in_repo {
            preamble.push_str(line);
            preamble.push('\n');
            continue;
        }

        let repo = repos.last_mut().unwrap();

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

    let original = fs::read_to_string(path)?;
    let mut conf = parse_conf(&original);

    conf.repos = repos.iter().map(entry_to_repo_section).collect();

    let new_content = serialize_conf(&conf);

    let temp_path = parent.join(format!(".pacman.conf.tmp.{}", std::process::id()));
    {
        let mut file = fs::File::create(&temp_path)?;
        file.write_all(new_content.as_bytes())?;
        file.sync_all()?;
    }

    let backup_path = if path.exists() {
        let backup = format!(
            "{}{}",
            BACKUP_PREFIX,
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs()
        );
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

    emit_json(&SaveReposResponse {
        success: true,
        backup_path,
        message: format!("Saved {} repositories to {}", repos.len(), PACMAN_CONF_PATH),
    })
}
