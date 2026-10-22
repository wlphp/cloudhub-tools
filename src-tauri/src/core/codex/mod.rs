pub mod account_controls;
pub mod proxy_detection;
pub mod remote_logs;
pub mod auth;
pub mod token_import;
pub mod desktop;
pub mod gateway;
pub mod gateway_config;
pub mod gateway_controls;
pub mod process;
pub mod profile;
pub mod rpc;
pub mod responses;
pub mod protocols;
pub mod providers;
pub mod provider_config;
pub mod provider_probe;
pub mod provider_protocol;
pub mod provider_gateway;
pub mod provider_oauth;
pub mod provider_usage;
pub mod provider_import;
pub mod provider_export;
pub mod provider_logs;
pub mod provider_aggregate;
pub(crate) static AUTH_WRITER: std::sync::Mutex<()> = std::sync::Mutex::new(());

use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub name: String,
    pub used_percent: f64,
    pub window_minutes: Option<u64>,
    pub resets_at: Option<i64>,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QuotaSnapshot {
    pub windows: Vec<QuotaWindow>,
    pub fetched_at: Option<i64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccountSummary {
    pub is_web_session: bool,
    pub user_id: Option<String>,
    pub login_provider: Option<String>,
    pub workspace_name: Option<String>,
    pub id: i64,
    pub label: String,
    pub email: Option<String>,
    pub account_id: Option<String>,
    pub auth_mode: String,
    pub plan: Option<String>,
    pub proxy_url: Option<String>,
    pub benefits: account_controls::Benefits,
    pub note: String,
    pub tags: Vec<String>,
    pub quota: QuotaSnapshot,
    pub last_error: Option<String>,
    pub updated_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountMetadataInput {
    pub id: i64,
    pub label: String,
    pub note: String,
    pub tags: Vec<String>,
}

pub fn validate_metadata(input: &AccountMetadataInput) -> Result<(), String> {
    if input.id <= 0
        || input.label.trim().is_empty()
        || input.label.chars().count() > 160
        || input.note.chars().count() > 2000
        || input.tags.len() > 20
        || input.tags.iter().any(|tag| {
            tag.trim().is_empty() || tag.chars().count() > 40 || tag.chars().any(char::is_control)
        })
        || input.label.chars().any(char::is_control)
    {
        return Err("Codex 账号名称、备注或标签参数无效".into());
    }
    Ok(())
}

pub mod network;
