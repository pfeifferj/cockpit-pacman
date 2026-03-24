use serde::{Deserialize, Serialize};

fn default_false() -> bool {
    false
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignoffGroup {
    pub pkgbase: String,
    pub pkgnames: Vec<String>,
    pub version: String,
    pub arch: String,
    pub repo: String,
    pub packager: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comments: Option<String>,
    pub last_update: String,
    #[serde(
        default = "default_false",
        deserialize_with = "deserialize_bool_or_null"
    )]
    pub known_bad: bool,
    #[serde(
        default = "default_false",
        deserialize_with = "deserialize_bool_or_null"
    )]
    pub approved: bool,
    pub required: u32,
    #[serde(
        default = "default_false",
        deserialize_with = "deserialize_bool_or_null"
    )]
    pub enabled: bool,
    pub signoffs: Vec<Signoff>,
}

fn deserialize_bool_or_null<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<bool>::deserialize(deserializer).map(|v| v.unwrap_or(false))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Signoff {
    pub user: String,
    pub created: String,
    #[serde(deserialize_with = "deserialize_revoked")]
    pub revoked: bool,
}

fn deserialize_revoked<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde_json::Value;
    let v = Value::deserialize(deserializer)?;
    match v {
        Value::Bool(b) => Ok(b),
        Value::Null => Ok(false),
        Value::String(s) => Ok(!s.is_empty()),
        _ => Ok(false),
    }
}

#[derive(Debug, Clone)]
pub struct SignoffSpec {
    pub repo: String,
    pub arch: String,
    pub pkgbase: String,
}
