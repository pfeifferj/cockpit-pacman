//! Client for the Arch Linux mirror status API
//! (<https://archlinux.org/mirrors/status/json/>): fetch the status report and
//! filter/rank mirrors. No mirrorlist file handling; that is caller territory.

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("fetching mirror status failed")]
    Http(#[from] ureq::Error),
    #[error("parsing mirror status failed")]
    Parse(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

pub const STATUS_URL: &str = "https://archlinux.org/mirrors/status/json/";

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Status {
    #[serde(rename = "urls")]
    pub mirrors: Vec<Mirror>,
    pub last_check: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Mirror {
    pub url: String,
    pub country: Option<String>,
    pub country_code: Option<String>,
    pub last_sync: Option<String>,
    pub delay: Option<i64>,
    pub score: Option<f64>,
    pub completion_pct: Option<f64>,
    pub active: Option<bool>,
    pub ipv4: Option<bool>,
    pub ipv6: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    Http,
    Https,
    Any,
}

impl Protocol {
    /// "https"/"http" map to the matching protocol; anything else is `Any`.
    pub fn parse(s: &str) -> Self {
        match s {
            "https" => Self::Https,
            "http" => Self::Http,
            _ => Self::Any,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortBy {
    Score,
    Delay,
    Age,
}

impl SortBy {
    /// "delay"/"age" map to the matching key; anything else is `Score`.
    pub fn parse(s: &str) -> Self {
        match s {
            "delay" => Self::Delay,
            "age" => Self::Age,
            _ => Self::Score,
        }
    }
}

/// Fetch and parse the mirror status report. The caller supplies the agent so it
/// controls timeouts and IP family.
pub fn fetch(agent: &ureq::Agent) -> Result<Status> {
    let body = agent.get(STATUS_URL).call()?.into_body().read_to_string()?;
    Ok(serde_json::from_str(&body)?)
}

/// Keep active mirrors at or above `min_completion` (0.0-1.0) matching
/// `protocol` and optional `country` (by code or name), sort by `sort_by`, and
/// truncate to `count`.
pub fn rank(
    mirrors: Vec<Mirror>,
    protocol: Protocol,
    country: Option<&str>,
    min_completion: f64,
    sort_by: SortBy,
    count: usize,
) -> Vec<Mirror> {
    let mut candidates: Vec<Mirror> = mirrors
        .into_iter()
        .filter(|m| m.active.unwrap_or(false))
        .filter(|m| m.completion_pct.unwrap_or(0.0) >= min_completion)
        .filter(|m| match protocol {
            Protocol::Https => m.url.starts_with("https://"),
            Protocol::Http => m.url.starts_with("http://") && !m.url.starts_with("https://"),
            Protocol::Any => true,
        })
        .filter(|m| country.is_none_or(|c| matches_country(m, c)))
        .collect();

    match sort_by {
        SortBy::Delay => candidates.sort_by(|a, b| {
            a.delay
                .unwrap_or(i64::MAX)
                .cmp(&b.delay.unwrap_or(i64::MAX))
        }),
        SortBy::Age => candidates.sort_by(|a, b| b.last_sync.cmp(&a.last_sync)),
        SortBy::Score => candidates.sort_by(|a, b| {
            a.score
                .unwrap_or(f64::MAX)
                .partial_cmp(&b.score.unwrap_or(f64::MAX))
                .unwrap_or(Ordering::Equal)
        }),
    }

    candidates.truncate(count);
    candidates
}

fn matches_country(m: &Mirror, c: &str) -> bool {
    m.country_code
        .as_deref()
        .is_some_and(|cc| cc.eq_ignore_ascii_case(c))
        || m.country
            .as_deref()
            .is_some_and(|cn| cn.eq_ignore_ascii_case(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mirror(url: &str, active: bool, completion: f64, score: f64, cc: &str) -> Mirror {
        Mirror {
            url: url.to_string(),
            country: None,
            country_code: Some(cc.to_string()),
            last_sync: None,
            delay: None,
            score: Some(score),
            completion_pct: Some(completion),
            active: Some(active),
            ipv4: None,
            ipv6: None,
        }
    }

    #[test]
    fn rank_filters_sorts_and_truncates() {
        let mirrors = vec![
            mirror("https://a/", true, 1.0, 3.0, "DE"),
            mirror("https://b/", true, 1.0, 1.0, "DE"),
            mirror("http://c/", true, 1.0, 0.5, "DE"),
            mirror("https://d/", false, 1.0, 0.1, "DE"),
            mirror("https://e/", true, 0.5, 0.2, "DE"),
            mirror("https://f/", true, 1.0, 2.0, "FR"),
        ];

        let out = rank(mirrors, Protocol::Https, Some("de"), 0.9, SortBy::Score, 2);

        // http (c), inactive (d), low completion (e), wrong country (f) dropped;
        // remaining sorted by ascending score, capped at 2.
        let urls: Vec<&str> = out.iter().map(|m| m.url.as_str()).collect();
        assert_eq!(urls, vec!["https://b/", "https://a/"]);
    }
}
