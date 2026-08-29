use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshConnectInput {
    pub(crate) account_id: Option<i64>, pub(crate) asset_key: Option<String>, pub(crate) managed_host_id: Option<i64>, pub(crate) host: String, pub(crate) port: u16, pub(crate) username: String, pub(crate) password: Option<String>, pub(crate) auth_method: Option<String>, pub(crate) private_key: Option<String>, pub(crate) key_passphrase: Option<String>, pub(crate) direct: Option<bool>, pub(crate) save_password: bool, pub(crate) cols: Option<u32>, pub(crate) rows: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedSshConnection { pub(crate) host: String, pub(crate) port: u16, pub(crate) username: String, pub(crate) password_saved: bool }

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RdpConnectionInput { pub(crate) target_key: String, pub(crate) host: String, pub(crate) port: u16, pub(crate) username: String, pub(crate) password: Option<String>, pub(crate) save_password: bool }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedRdpConnection { pub(crate) host: String, pub(crate) port: u16, pub(crate) username: String, pub(crate) password_saved: bool }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshConnectResult { pub(crate) session_id: String, pub(crate) host_key_fingerprint: String }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshFileEntry { pub(crate) name: String, pub(crate) path: String, pub(crate) is_dir: bool, pub(crate) is_file: bool, pub(crate) size: u64, pub(crate) mode: String, pub(crate) owner: String, pub(crate) group: String, pub(crate) modified: String }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshDirectoryListing { pub(crate) path: String, pub(crate) entries: Vec<SshFileEntry> }

#[derive(Debug, Serialize, Clone)]
pub(crate) struct ManagedHost { pub(crate) id: i64, pub(crate) name: String, pub(crate) host: String, pub(crate) port: u16, pub(crate) username: String, pub(crate) platform: String, pub(crate) auth_method: String, pub(crate) group_name: Option<String>, pub(crate) tags: Option<String>, pub(crate) source_account_id: Option<i64>, pub(crate) source_asset_key: Option<String>, pub(crate) password_saved: bool, pub(crate) private_key_saved: bool, pub(crate) host_key_fingerprint: Option<String>, pub(crate) status: String, pub(crate) last_latency_ms: Option<i64>, pub(crate) metrics: Value, pub(crate) last_checked_at: Option<i64>, pub(crate) last_error: Option<String>, pub(crate) remark: Option<String>, pub(crate) created_at: i64, pub(crate) updated_at: i64 }

#[derive(Debug, Deserialize)]
pub(crate) struct ManagedHostInput { pub(crate) id: Option<i64>, pub(crate) name: String, pub(crate) host: String, pub(crate) port: Option<u16>, pub(crate) username: String, pub(crate) password: Option<String>, pub(crate) platform: Option<String>, pub(crate) auth_method: Option<String>, pub(crate) private_key: Option<String>, pub(crate) key_passphrase: Option<String>, pub(crate) group_name: Option<String>, pub(crate) tags: Option<String>, pub(crate) source_account_id: Option<i64>, pub(crate) source_asset_key: Option<String>, pub(crate) remark: Option<String> }

#[derive(Debug, Serialize, Clone)]
pub(crate) struct PanelConnection { pub(crate) id: i64, pub(crate) name: String, pub(crate) panel_url: String, pub(crate) sort_order: i64, pub(crate) allow_insecure_tls: bool, pub(crate) group_name: Option<String>, pub(crate) source_account_id: Option<i64>, pub(crate) source_asset_key: Option<String>, pub(crate) api_key_saved: bool, pub(crate) status: String, pub(crate) summary: Value, pub(crate) last_checked_at: Option<i64>, pub(crate) last_error: Option<String>, pub(crate) remark: Option<String>, pub(crate) created_at: i64, pub(crate) updated_at: i64 }

#[derive(Debug, Deserialize)]
pub(crate) struct PanelConnectionInput { pub(crate) id: Option<i64>, pub(crate) name: String, pub(crate) panel_url: String, pub(crate) sort_order: i64, pub(crate) api_key: Option<String>, pub(crate) allow_insecure_tls: bool, pub(crate) group_name: Option<String>, pub(crate) source_account_id: Option<i64>, pub(crate) source_asset_key: Option<String>, pub(crate) remark: Option<String> }

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct ExportPanelConnection { pub(crate) name: String, pub(crate) panel_url: String, pub(crate) sort_order: i64, pub(crate) api_key: String, pub(crate) allow_insecure_tls: bool, pub(crate) group_name: Option<String>, pub(crate) source_account_id: Option<i64>, pub(crate) source_asset_key: Option<String>, pub(crate) remark: Option<String> }

#[derive(Debug, Deserialize)]
pub(crate) struct ImportPanelConnection { pub(crate) name: String, pub(crate) panel_url: String, pub(crate) sort_order: Option<i64>, pub(crate) api_key: String, pub(crate) allow_insecure_tls: Option<bool>, pub(crate) group_name: Option<String>, pub(crate) source_account_id: Option<i64>, pub(crate) source_asset_key: Option<String>, pub(crate) remark: Option<String> }

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct ExportManagedHost { pub(crate) name: String, pub(crate) host: String, pub(crate) port: u16, pub(crate) username: String, pub(crate) platform: String, pub(crate) auth_method: String, pub(crate) password: Option<String>, pub(crate) private_key: Option<String>, pub(crate) key_passphrase: Option<String>, pub(crate) group_name: Option<String>, pub(crate) tags: Option<String>, pub(crate) source_account_id: Option<i64>, pub(crate) source_asset_key: Option<String>, pub(crate) remark: Option<String> }

#[derive(Debug, Deserialize)]
pub(crate) struct ImportManagedHost { pub(crate) name: String, pub(crate) host: String, pub(crate) port: Option<u16>, pub(crate) username: String, #[serde(default)] pub(crate) platform: Option<String>, #[serde(default)] pub(crate) auth_method: Option<String>, #[serde(default)] pub(crate) password: Option<String>, #[serde(default)] pub(crate) private_key: Option<String>, #[serde(default)] pub(crate) key_passphrase: Option<String>, pub(crate) group_name: Option<String>, pub(crate) tags: Option<String>, pub(crate) source_account_id: Option<i64>, pub(crate) source_asset_key: Option<String>, pub(crate) remark: Option<String> }
