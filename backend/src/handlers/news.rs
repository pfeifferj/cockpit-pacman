use anyhow::{Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use fs2::FileExt;

fn atomic_write_json_locked<T: Serialize>(path: &Path, state: &T) -> Result<()> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create directory {:?}", parent))?;
    }

    let file_name = path
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("Invalid state path: {:?}", path))?;

    let mut lock_name = file_name.to_os_string();
    lock_name.push(".lock");
    let lock_path = path.with_file_name(lock_name);

    let lock_file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(&lock_path)
        .with_context(|| format!("Failed to open lock file {:?}", lock_path))?;
    lock_file
        .lock_exclusive()
        .with_context(|| format!("Failed to acquire lock on {:?}", lock_path))?;

    let content = serde_json::to_string_pretty(state).context("Failed to serialize state")?;

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_nanos();
    let tid: String = format!("{:?}", std::thread::current().id())
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let base = file_name.to_string_lossy();
    let tmp_path = path.with_file_name(format!("{base}.{nanos}.{tid}.tmp"));

    let write_result = (|| -> Result<()> {
        let mut tmp = File::create(&tmp_path)
            .with_context(|| format!("Failed to create temp file {:?}", tmp_path))?;
        tmp.write_all(content.as_bytes())
            .with_context(|| format!("Failed to write temp file {:?}", tmp_path))?;
        let _ = tmp.sync_all();
        std::fs::rename(&tmp_path, path)
            .with_context(|| format!("Failed to rename {:?} to {:?}", tmp_path, path))?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = std::fs::remove_file(&tmp_path);
    }
    write_result
}

use crate::models::{NewsItem, NewsResponse};
use crate::util::emit_json;

const ARCH_NEWS_URL: &str = "https://archlinux.org/feeds/news/";
const MAX_RSS_BYTES: u64 = 512 * 1024;

#[derive(Serialize, Deserialize, Default)]
pub struct NewsReadState {
    pub dismissed: Vec<String>,
}

#[derive(Serialize, Deserialize, Default)]
pub struct ServicesDismissal {
    pub signature: Option<String>,
}

pub fn fetch_news(days: u32) -> Result<()> {
    let days = days.min(365);
    let items = fetch_news_items(days)?;
    emit_json(&NewsResponse { items })
}

fn fetch_news_items(days: u32) -> Result<Vec<NewsItem>> {
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(15)))
            .ip_family(crate::util::detected_ip_family())
            .build(),
    );

    let mut body = agent.get(ARCH_NEWS_URL).call()?.into_body();
    let mut buf = Vec::new();
    body.as_reader().take(MAX_RSS_BYTES).read_to_end(&mut buf)?;

    let channel = rss::Channel::read_from(&buf[..])?;
    let cutoff = Utc::now() - chrono::Duration::days(i64::from(days));

    let mut items = Vec::new();
    for item in channel.items() {
        let pub_date = match item.pub_date() {
            Some(d) => d,
            None => continue,
        };
        let parsed = match chrono::DateTime::parse_from_rfc2822(pub_date) {
            Ok(dt) => dt.with_timezone(&Utc),
            Err(_) => continue,
        };
        if parsed < cutoff {
            continue;
        }

        let title = item.title().unwrap_or("").to_string();
        let link = item.link().unwrap_or("").to_string();
        let summary = item
            .description()
            .map(|d| parse_rss_body(d, 300))
            .unwrap_or_default();

        items.push(NewsItem {
            title,
            link,
            published: parsed.to_rfc3339(),
            summary,
        });
    }

    Ok(items)
}

pub fn read_news_state_from(path: &Path) -> Result<NewsReadState> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create directory {:?}", parent))?;
    }
    match std::fs::read_to_string(path) {
        Ok(content) => {
            if content.trim().is_empty() {
                return Ok(NewsReadState::default());
            }
            let state: NewsReadState = serde_json::from_str(&content)
                .with_context(|| format!("Failed to parse news state from {:?}", path))?;
            Ok(state)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(NewsReadState::default()),
        Err(e) => Err(e).with_context(|| format!("Failed to read news state from {:?}", path)),
    }
}

pub fn mark_news_read_to(path: &Path, link: &str) -> Result<NewsReadState> {
    let mut state = read_news_state_from(path)?;
    if !state.dismissed.iter().any(|u| u == link) {
        state.dismissed.push(link.to_string());
    }
    atomic_write_json_locked(path, &state)?;
    Ok(state)
}

fn news_state_path() -> Result<PathBuf> {
    let home = std::env::var("HOME").context("HOME environment variable is not set")?;
    Ok(PathBuf::from(home).join(".config/cockpit-pacman/news-read.json"))
}

fn services_dismissal_path() -> Result<PathBuf> {
    let home = std::env::var("HOME").context("HOME environment variable is not set")?;
    Ok(PathBuf::from(home).join(".config/cockpit-pacman/services-dismissed.json"))
}

pub fn read_news_state() -> Result<()> {
    let path = news_state_path()?;
    let state = read_news_state_from(&path)?;
    emit_json(&state)
}

pub fn mark_news_read(link: &str) -> Result<()> {
    crate::validation::validate_mirror_url(link)?;
    let path = news_state_path()?;
    let state = mark_news_read_to(&path, link)?;
    emit_json(&state)
}

pub fn read_services_dismissal_from(path: &Path) -> Result<ServicesDismissal> {
    match std::fs::read_to_string(path) {
        Ok(content) => {
            if content.trim().is_empty() {
                return Ok(ServicesDismissal::default());
            }
            let state: ServicesDismissal = serde_json::from_str(&content)
                .with_context(|| format!("Failed to parse services dismissal from {:?}", path))?;
            Ok(state)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ServicesDismissal::default()),
        Err(e) => {
            Err(e).with_context(|| format!("Failed to read services dismissal from {:?}", path))
        }
    }
}

pub fn write_services_dismissal_to(path: &Path, signature: &str) -> Result<ServicesDismissal> {
    let state = ServicesDismissal {
        signature: Some(signature.to_string()),
    };
    atomic_write_json_locked(path, &state)?;
    Ok(state)
}

pub fn read_services_dismissal() -> Result<()> {
    let path = services_dismissal_path()?;
    let state = read_services_dismissal_from(&path)?;
    emit_json(&state)
}

pub fn mark_services_dismissed(signature: &str) -> Result<()> {
    if signature.is_empty() {
        anyhow::bail!("Signature must not be empty");
    }
    if signature.len() > 4096 {
        anyhow::bail!("Signature length {} exceeds 4096", signature.len());
    }
    if signature.chars().any(|c| c.is_control()) {
        anyhow::bail!("Signature contains control characters");
    }
    let path = services_dismissal_path()?;
    let state = write_services_dismissal_to(&path, signature)?;
    emit_json(&state)
}

pub(crate) fn parse_rss_body(html: &str, max: usize) -> String {
    let text = html2text::from_read(html.as_bytes(), usize::MAX);
    let trimmed = text.trim_end();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let mut end = 0usize;
    for (i, (idx, _)) in trimmed.char_indices().enumerate() {
        if i == max {
            end = idx;
            break;
        }
    }
    if end == 0 {
        return trimmed.to_string();
    }
    let truncated = &trimmed[..end];
    match truncated.rfind(' ') {
        Some(pos) if pos > end / 2 => format!("{}...", &truncated[..pos]),
        _ => format!("{}...", truncated),
    }
}

#[cfg(test)]
pub(crate) fn strip_html_and_truncate(html: &str, max_len: usize) -> String {
    let mut result = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut chars = html.chars().peekable();
    let mut last_was_space = false;

    while let Some(ch) = chars.next() {
        if ch == '<' {
            in_tag = true;
            continue;
        }
        if ch == '>' {
            in_tag = false;
            if !result.is_empty() && !last_was_space {
                result.push(' ');
                last_was_space = true;
            }
            continue;
        }
        if in_tag {
            continue;
        }
        if ch == '&' {
            let entity = decode_entity(&mut chars);
            for ec in entity.chars() {
                if ec.is_whitespace() {
                    if !last_was_space && !result.is_empty() {
                        result.push(' ');
                        last_was_space = true;
                    }
                } else {
                    result.push(ec);
                    last_was_space = false;
                }
            }
            continue;
        }
        if ch.is_whitespace() {
            if !last_was_space && !result.is_empty() {
                result.push(' ');
                last_was_space = true;
            }
        } else {
            result.push(ch);
            last_was_space = false;
        }
    }

    let trimmed = result.trim_end().to_string();
    if trimmed.len() <= max_len {
        return trimmed;
    }

    let truncated = &trimmed[..max_len];
    match truncated.rfind(' ') {
        Some(pos) if pos > max_len / 2 => format!("{}...", &truncated[..pos]),
        _ => format!("{}...", truncated),
    }
}

#[cfg(test)]
fn decode_entity(chars: &mut std::iter::Peekable<std::str::Chars>) -> String {
    let mut entity = String::new();
    let mut terminated = false;
    for _ in 0..10 {
        match chars.next() {
            Some(';') => {
                terminated = true;
                break;
            }
            Some(c) => entity.push(c),
            None => break,
        }
    }
    if !terminated {
        return format!("&{}", entity);
    }
    match entity.as_str() {
        "amp" => "&".to_string(),
        "lt" => "<".to_string(),
        "gt" => ">".to_string(),
        "quot" => "\"".to_string(),
        "apos" => "'".to_string(),
        "nbsp" => " ".to_string(),
        _ if entity.starts_with('#') => {
            let code_str = &entity[1..];
            let code_point = if let Some(hex) = code_str.strip_prefix('x') {
                u32::from_str_radix(hex, 16).ok()
            } else {
                code_str.parse::<u32>().ok()
            };
            code_point
                .and_then(char::from_u32)
                .map(|c| c.to_string())
                .unwrap_or_else(|| format!("&{};", entity))
        }
        _ => format!("&{};", entity),
    }
}
