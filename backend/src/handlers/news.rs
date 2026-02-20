use anyhow::Result;
use chrono::Utc;
use std::io::Read;
use std::time::Duration;

use crate::models::{NewsItem, NewsResponse};
use crate::util::emit_json;

const ARCH_NEWS_URL: &str = "https://archlinux.org/feeds/news/";
const MAX_RSS_BYTES: u64 = 512 * 1024;

pub fn fetch_news(days: u32) -> Result<()> {
    let days = days.min(365);
    let items = fetch_news_items(days).unwrap_or_default();
    emit_json(&NewsResponse { items })
}

fn fetch_news_items(days: u32) -> Result<Vec<NewsItem>> {
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(15)))
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
            .map(|d| strip_html_and_truncate(d, 300))
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
