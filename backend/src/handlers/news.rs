use anyhow::{Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;
use ts_rs::TS;

fn with_state_lock<R, F>(path: &Path, f: F) -> Result<R>
where
    F: FnOnce() -> Result<R>,
{
    let file_name = path
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("Invalid state path: {:?}", path))?;

    let mut lock_name = file_name.to_os_string();
    lock_name.push(".lock");
    let lock_path = path.with_file_name(lock_name);

    crate::util::with_file_lock(&lock_path, f)
}

use crate::models::{NewsItem, NewsResponse};
use crate::util::{config_path, emit_json, write_json_atomic};

const ARCH_NEWS_URL: &str = "https://archlinux.org/feeds/news/";
const MAX_RSS_BYTES: u64 = 512 * 1024;

#[derive(Serialize, Deserialize, Default, TS)]
#[ts(export, export_to = "../../src/bindings/index.ts")]
pub struct NewsReadState {
    pub dismissed: Vec<String>,
}

#[derive(Serialize, Deserialize, Default, TS)]
#[ts(
    export,
    export_to = "../../src/bindings/index.ts",
    rename = "DismissalState"
)]
pub struct Dismissal {
    pub signature: Option<String>,
}

const NEWS_TTL_SECS: i64 = 3600;

#[derive(Serialize, Deserialize)]
struct NewsCache {
    #[serde(default)]
    fetched_at: i64,
    items: Vec<NewsItem>,
}

pub fn fetch_news(days: u32, force: bool) -> Result<()> {
    let url = crate::endpoints::endpoint(ARCH_NEWS_URL, "COCKPIT_PACMAN_TEST_NEWS_URL")?;
    let response = news_with_cache(&url, &news_cache_path()?, days.min(365), force)?;
    emit_json(&response)
}

fn news_with_cache(url: &str, path: &Path, days: u32, force: bool) -> Result<NewsResponse> {
    let cached = read_news_cache(path);
    let now = Utc::now().timestamp();
    if !force
        && let Some(cache) = cached.as_ref()
        && (0..NEWS_TTL_SECS).contains(&(now - cache.fetched_at))
    {
        return Ok(NewsResponse {
            items: filter_items_within_days(cache.items.clone(), days),
            stale: false,
        });
    }
    match fetch_news_items_from(url, 365) {
        Ok(items) => {
            let cache = NewsCache {
                fetched_at: now,
                items,
            };
            if let Err(error) = write_json_atomic(path, &cache) {
                crate::util::journal_note(&format!("fetch-news: could not save cache: {error:#}"));
            }
            Ok(NewsResponse {
                items: filter_items_within_days(cache.items, days),
                stale: false,
            })
        }
        Err(error) => match cached {
            Some(cache) => {
                crate::util::journal_note(&format!(
                    "fetch-news: using cached news after refresh failed: {error:#}"
                ));
                Ok(NewsResponse {
                    items: filter_items_within_days(cache.items, days),
                    stale: true,
                })
            }
            None => Err(error),
        },
    }
}

pub(crate) fn filter_items_within_days(items: Vec<NewsItem>, days: u32) -> Vec<NewsItem> {
    let cutoff = Utc::now() - chrono::Duration::days(i64::from(days));
    items
        .into_iter()
        .filter(|item| {
            chrono::DateTime::parse_from_rfc3339(&item.published)
                .map(|d| d.with_timezone(&Utc) >= cutoff)
                .unwrap_or(true)
        })
        .collect()
}

fn news_cache_path() -> Result<PathBuf> {
    config_path("news-cache.json")
}

fn read_news_cache(path: &Path) -> Option<NewsCache> {
    let file = std::fs::File::open(path).ok()?;
    if file.metadata().ok()?.len() > MAX_RSS_BYTES * 8 {
        return None;
    }
    serde_json::from_reader(file.take(MAX_RSS_BYTES * 8)).ok()
}

fn fetch_news_items_from(url: &str, days: u32) -> Result<Vec<NewsItem>> {
    crate::network::require_network()?;
    let client = arch_http_client::Client::new(arch_http_client::Options {
        timeout: Duration::from_secs(15),
        max_body: MAX_RSS_BYTES as usize,
        ..arch_http_client::Options::default()
    });
    let buf = client.get(url)?.body;

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
    with_state_lock(path, || {
        let mut state = read_news_state_from(path)?;
        if !state.dismissed.iter().any(|u| u == link) {
            state.dismissed.push(link.to_string());
        }
        write_json_atomic(path, &state)?;
        Ok(state)
    })
}

pub fn mark_news_unread_to(path: &Path, link: &str) -> Result<NewsReadState> {
    with_state_lock(path, || {
        let mut state = read_news_state_from(path)?;
        state.dismissed.retain(|url| url != link);
        write_json_atomic(path, &state)?;
        Ok(state)
    })
}

pub fn mark_news_unread(link: &str) -> Result<()> {
    crate::validation::validate_mirror_url(link)?;
    emit_json(&mark_news_unread_to(&news_state_path()?, link)?)
}

pub fn restore_dismissal_to(
    path: &Path,
    expected: &str,
    previous: Option<&str>,
) -> Result<Dismissal> {
    with_state_lock(path, || {
        let current = read_dismissal_from(path, "alert")?;
        if current.signature.as_deref() != Some(expected) {
            return Err(crate::backups::ConfigChanged.into());
        }
        let restored = Dismissal {
            signature: previous.map(str::to_owned),
        };
        write_json_atomic(path, &restored)?;
        Ok(restored)
    })
}

pub fn restore_dismissed(kind: &str, expected: &str, previous: Option<&str>) -> Result<()> {
    validate_signature(expected)?;
    if let Some(previous) = previous {
        validate_signature(previous)?;
    }
    emit_json(&restore_dismissal_to(
        &dismissal_path(kind)?,
        expected,
        previous,
    )?)
}

fn news_state_path() -> Result<PathBuf> {
    config_path("news-read.json")
}

const DISMISSAL_KINDS: &[&str] = &["reboot", "services", "pacnew", "scheduled"];

fn dismissal_path(kind: &str) -> Result<PathBuf> {
    if !DISMISSAL_KINDS.contains(&kind) {
        anyhow::bail!("Unknown dismissal kind: {}", kind);
    }
    config_path(&format!("{}-dismissed.json", kind))
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

pub fn read_dismissal_from(path: &Path, kind: &str) -> Result<Dismissal> {
    match std::fs::read_to_string(path) {
        Ok(content) => {
            if content.trim().is_empty() {
                return Ok(Dismissal::default());
            }
            let state: Dismissal = serde_json::from_str(&content)
                .with_context(|| format!("Failed to parse {} dismissal from {:?}", kind, path))?;
            Ok(state)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Dismissal::default()),
        Err(e) => {
            Err(e).with_context(|| format!("Failed to read {} dismissal from {:?}", kind, path))
        }
    }
}

pub fn write_dismissal_to(path: &Path, signature: &str) -> Result<Dismissal> {
    with_state_lock(path, || {
        let state = Dismissal {
            signature: Some(signature.to_string()),
        };
        write_json_atomic(path, &state)?;
        Ok(state)
    })
}

pub fn read_dismissal(kind: &str) -> Result<()> {
    let path = dismissal_path(kind)?;
    let state = read_dismissal_from(&path, kind)?;
    emit_json(&state)
}

fn validate_signature(signature: &str) -> Result<()> {
    if signature.is_empty() {
        anyhow::bail!("Signature must not be empty");
    }
    if signature.len() > 4096 {
        anyhow::bail!("Signature length {} exceeds 4096", signature.len());
    }
    if signature.chars().any(|c| c.is_control()) {
        anyhow::bail!("Signature contains control characters");
    }
    Ok(())
}

pub fn mark_dismissed(kind: &str, signature: &str) -> Result<()> {
    validate_signature(signature)?;
    let path = dismissal_path(kind)?;
    let state = write_dismissal_to(&path, signature)?;
    emit_json(&state)
}

pub(crate) fn parse_rss_body(html: &str, max: usize) -> String {
    let text = html2text::from_read(html.as_bytes(), usize::MAX).unwrap_or_default();
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

#[cfg(test)]
mod fetch_tests {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn serve(body: &str) -> MockServer {
        crate::network::test_context();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/feeds/news/"))
            .respond_with(ResponseTemplate::new(200).set_body_string(body))
            .mount(&server)
            .await;
        server
    }

    #[tokio::test]
    async fn fresh_news_is_reused_and_force_refreshes() {
        let server = serve(r#"<rss version="2.0"><channel><title>News</title><link>https://archlinux.org</link><description>News</description></channel></rss>"#).await;
        let url = format!("{}/feeds/news/", server.uri());
        let directory = std::env::temp_dir().join(format!(
            "news-ttl-{}-{}",
            std::process::id(),
            super::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("news.json");
        assert!(!super::news_with_cache(&url, &path, 1, false).unwrap().stale);
        assert!(
            !super::news_with_cache(&url, &path, 365, false)
                .unwrap()
                .stale
        );
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
        assert!(!super::news_with_cache(&url, &path, 30, true).unwrap().stale);
        assert_eq!(server.received_requests().await.unwrap().len(), 2);
        let mut cache = super::read_news_cache(&path).unwrap();
        cache.fetched_at -= super::NEWS_TTL_SECS;
        super::write_json_atomic(&path, &cache).unwrap();
        assert!(
            super::news_with_cache("http://127.0.0.1:1/", &path, 30, false)
                .unwrap()
                .stale
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn a_feed_that_is_not_rss_is_an_error_not_an_empty_list() {
        let server = serve("not an rss document").await;
        let url = format!("{}/feeds/news/", server.uri());

        assert!(super::fetch_news_items_from(&url, 30).is_err());
    }

    #[tokio::test]
    async fn an_item_older_than_the_window_is_dropped() {
        let feed = r#"<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
            <link>https://archlinux.org</link><description>d</description>
            <item><title>ancient</title><link>https://archlinux.org/news/a/</link>
            <pubDate>Tue, 01 Jan 2019 00:00:00 +0000</pubDate><description>old</description></item>
            </channel></rss>"#;
        let server = serve(feed).await;
        let url = format!("{}/feeds/news/", server.uri());

        let items = super::fetch_news_items_from(&url, 30).expect("parses");
        assert!(
            items.is_empty(),
            "an item from 2019 is outside a 30 day window"
        );
    }

    #[tokio::test]
    async fn an_unreachable_feed_is_an_error_so_the_caller_can_fall_back() {
        assert!(super::fetch_news_items_from("http://127.0.0.1:1/feeds/news/", 30).is_err());
    }
}

#[cfg(test)]
mod dismissal_kind_tests {
    #[test]
    fn a_known_kind_resolves_to_a_path() {
        for kind in super::DISMISSAL_KINDS {
            let path = super::dismissal_path(kind).unwrap();
            assert_eq!(
                path.file_name().unwrap().to_str().unwrap(),
                format!("{kind}-dismissed.json")
            );
            assert!(path.parent().unwrap().ends_with(".config/cockpit-pacman"));
        }
    }

    #[test]
    fn an_unknown_kind_is_rejected() {
        assert!(super::dismissal_path("../etc/passwd").is_err());
        assert!(super::dismissal_path("news").is_err());
    }
}

#[cfg(test)]
mod undo_tests {
    use super::*;
    #[test]
    fn undo_preserves_other_news_and_refuses_later_dismissals() {
        let dir = std::env::temp_dir().join(format!(
            "news-undo-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("news.json");
        mark_news_read_to(&path, "https://example.org/one").unwrap();
        mark_news_read_to(&path, "https://example.org/two").unwrap();
        let state = mark_news_unread_to(&path, "https://example.org/one").unwrap();
        assert_eq!(state.dismissed, ["https://example.org/two"]);
        let path = dir.join("dismissed.json");
        write_dismissal_to(&path, "later").unwrap();
        let error = restore_dismissal_to(&path, "earlier", None).err().unwrap();
        assert_eq!(crate::util::classify_error(&error), Some("config_changed"));
        assert_eq!(
            read_dismissal_from(&path, "alert")
                .unwrap()
                .signature
                .as_deref(),
            Some("later")
        );
        assert!(
            restore_dismissal_to(&path, "later", None)
                .unwrap()
                .signature
                .is_none()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
