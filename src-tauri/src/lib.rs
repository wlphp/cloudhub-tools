use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chrono::{Duration, Local, TimeZone, Utc};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::PathBuf,
    process::Command,
    sync::{mpsc, Arc, Mutex},
    time::Instant,
};
use hmac::{Hmac, Mac};
use md5::Md5;
use sha2::{Digest, Sha256};
use russh::{client, ChannelMsg};
use russh::keys::{decode_secret_key, PrivateKeyWithHashAlg};
use uuid::Uuid;
use tauri_plugin_dialog::DialogExt;

mod core;
use core::storage::{data_dir, decrypt_secret, encrypt_secret, open_db};
use core::repositories::managed_hosts as managed_host_repository;
use core::repositories::accounts as account_repository;
use core::repositories::panel_connections as panel_repository;
use core::repositories::{assets as asset_repository, connections as connection_repository, logs as log_repository};
mod commands;
pub(crate) use commands::accounts::{delete_account, export_accounts, export_accounts_file, import_accounts, list_accounts, save_account};
pub(crate) use commands::preferences::{list_client_preferences, save_client_preference};
pub(crate) use commands::logs::{clear_api_logs, clear_operation_logs, list_api_logs};
pub(crate) use commands::assets::{delete_local_asset, list_local_assets};
pub(crate) use commands::managed_hosts::{delete_managed_host, list_managed_hosts};
pub(crate) use commands::panel_connections::{delete_panel_connection, list_panel_connections, update_panel_connection_order, update_panel_connection_remark};
pub(crate) use commands::connections::{delete_rdp_connection, delete_ssh_connection, get_rdp_connection, get_ssh_connection};
pub(crate) use commands::database_migration::{cancel_database_import, confirm_database_import, export_database_file, import_database_file, prepare_database_import, DatabaseImportStore};
mod cloud;

struct SshTerminal {
    commands: tokio::sync::mpsc::UnboundedSender<SshCommand>,
    output: mpsc::Receiver<String>,
    profile: SshConnectionProfile,
}

enum SshCommand {
    Data(String),
    Resize(u32, u32),
    Disconnect,
}

#[derive(Clone)]
struct SshConnectionProfile {
    host: String,
    port: u16,
    username: String,
    credentials: SshCredentials,
    fingerprint: String,
}

#[derive(Clone)]
enum SshCredentials {
    Password(String),
    PrivateKey { key: String, passphrase: Option<String> },
}

struct SshTerminalStore {
    terminals: Mutex<HashMap<String, SshTerminal>>,
}

struct OssUploadSelectionStore {
    files: Mutex<HashMap<String, PathBuf>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OssUploadSelection {
    token: String,
    name: String,
    size: u64,
}

#[derive(Clone)]
struct SavedSshCredentials {
    host: String,
    port: u16,
    username: String,
    platform: String,
    auth_method: String,
    password_ciphertext: Option<String>,
    private_key_ciphertext: Option<String>,
    key_passphrase_ciphertext: Option<String>,
    host_key_fingerprint: Option<String>,
}

struct SshHostKeyHandler {
    expected_fingerprint: Option<String>,
    observed_fingerprint: Arc<Mutex<Option<String>>>,
}

impl client::Handler for SshHostKeyHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key.public_key().fingerprint(russh::keys::HashAlg::Sha256).to_string();
        if let Ok(mut observed) = self.observed_fingerprint.lock() { *observed = Some(fingerprint.clone()); }
        Ok(self.expected_fingerprint.as_ref().is_none_or(|known| known == &fingerprint))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SshConnectInput {
    account_id: Option<i64>,
    asset_key: Option<String>,
    managed_host_id: Option<i64>,
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    auth_method: Option<String>,
    private_key: Option<String>,
    key_passphrase: Option<String>,
    direct: Option<bool>,
    save_password: bool,
    cols: Option<u32>,
    rows: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedSshConnection {
    host: String,
    port: u16,
    username: String,
    password_saved: bool,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RdpConnectionInput {
    target_key: String,
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    save_password: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedRdpConnection {
    host: String,
    port: u16,
    username: String,
    password_saved: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshConnectResult {
    session_id: String,
    host_key_fingerprint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshFileEntry {
    name: String,
    path: String,
    is_dir: bool,
    is_file: bool,
    size: u64,
    mode: String,
    owner: String,
    group: String,
    modified: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshDirectoryListing {
    path: String,
    entries: Vec<SshFileEntry>,
}

#[derive(Debug, Serialize, Clone)]
struct ManagedHost {
    id: i64,
    name: String,
    host: String,
    port: u16,
    username: String,
    platform: String,
    auth_method: String,
    group_name: Option<String>,
    tags: Option<String>,
    source_account_id: Option<i64>,
    source_asset_key: Option<String>,
    password_saved: bool,
    private_key_saved: bool,
    host_key_fingerprint: Option<String>,
    status: String,
    last_latency_ms: Option<i64>,
    metrics: Value,
    last_checked_at: Option<i64>,
    last_error: Option<String>,
    remark: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Deserialize)]
struct ManagedHostInput {
    id: Option<i64>,
    name: String,
    host: String,
    port: Option<u16>,
    username: String,
    password: Option<String>,
    platform: Option<String>,
    auth_method: Option<String>,
    private_key: Option<String>,
    key_passphrase: Option<String>,
    group_name: Option<String>,
    tags: Option<String>,
    source_account_id: Option<i64>,
    source_asset_key: Option<String>,
    remark: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
struct PanelConnection {
    id: i64,
    name: String,
    panel_url: String,
    sort_order: i64,
    allow_insecure_tls: bool,
    group_name: Option<String>,
    source_account_id: Option<i64>,
    source_asset_key: Option<String>,
    api_key_saved: bool,
    status: String,
    summary: Value,
    last_checked_at: Option<i64>,
    last_error: Option<String>,
    remark: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Deserialize)]
struct PanelConnectionInput {
    id: Option<i64>,
    name: String,
    panel_url: String,
    sort_order: i64,
    api_key: Option<String>,
    allow_insecure_tls: bool,
    group_name: Option<String>,
    source_account_id: Option<i64>,
    source_asset_key: Option<String>,
    remark: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ExportPanelConnection {
    name: String,
    panel_url: String,
    sort_order: i64,
    api_key: String,
    allow_insecure_tls: bool,
    group_name: Option<String>,
    source_account_id: Option<i64>,
    source_asset_key: Option<String>,
    remark: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ImportPanelConnection {
    name: String,
    panel_url: String,
    sort_order: Option<i64>,
    api_key: String,
    allow_insecure_tls: Option<bool>,
    group_name: Option<String>,
    source_account_id: Option<i64>,
    source_asset_key: Option<String>,
    remark: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ExportManagedHost {
    name: String,
    host: String,
    port: u16,
    username: String,
    platform: String,
    auth_method: String,
    password: Option<String>,
    private_key: Option<String>,
    key_passphrase: Option<String>,
    group_name: Option<String>,
    tags: Option<String>,
    source_account_id: Option<i64>,
    source_asset_key: Option<String>,
    remark: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ImportManagedHost {
    name: String,
    host: String,
    port: Option<u16>,
    username: String,
    #[serde(default)]
    platform: Option<String>,
    #[serde(default)]
    auth_method: Option<String>,
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    private_key: Option<String>,
    #[serde(default)]
    key_passphrase: Option<String>,
    group_name: Option<String>,
    tags: Option<String>,
    source_account_id: Option<i64>,
    source_asset_key: Option<String>,
    remark: Option<String>,
}


#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CloudAccount {
    pub id: i64, pub account_name: String, pub cloud_type: String, pub group_name: Option<String>,
    pub access_key_id: String, pub credential_meta: Option<String>, pub region_id: Option<String>, pub sort_order: i64, pub enabled: bool, pub remark: Option<String>,
    pub created_at: i64, pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
pub struct AccountInput {
    pub id: Option<i64>, pub account_name: String, pub cloud_type: String, pub group_name: Option<String>,
    pub access_key_id: String, pub access_key_secret: Option<String>, pub region_id: Option<String>, pub sort_order: Option<i64>,
    pub credential_meta: Option<String>,
    pub enabled: bool, pub remark: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ExportAccount {
    pub account_name: String,
    pub cloud_type: String,
    pub group_name: Option<String>,
    pub access_key_id: String,
    pub access_key_secret: String,
    pub credential_meta: Option<String>,
    pub region_id: Option<String>, pub sort_order: i64,
    pub enabled: bool,
    pub remark: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ImportAccount {
    pub account_name: String,
    pub cloud_type: Option<String>,
    pub group_name: Option<String>,
    pub access_key_id: String,
    pub access_key_secret: String,
    pub credential_meta: Option<String>,
    pub region_id: Option<String>, pub sort_order: Option<i64>,
    pub enabled: Option<bool>,
    pub remark: Option<String>,
}

fn write_api_log(access_key_id: &str, endpoint: &str, action: &str, request_params: &Value, response: Option<&Value>, status: &str, message: Option<&str>) {
    if let Ok(conn) = open_db() {
        let _ = log_repository::write_api(&conn, access_key_id, endpoint, action, request_params, response, status, message, Utc::now().timestamp_millis());
    }
}

fn account_credentials(id: i64) -> Result<(String, String), String> {
    let conn = open_db()?;
    let row = account_repository::credential_record(&conn, id)?;
    if row.2 != 1 { return Err("云账号已停用".into()); }
    // Cloud access-key secrets cannot contain meaningful leading/trailing whitespace.
    // Tolerate accidental whitespace from a pasted credential without rewriting it.
    Ok((row.0, decrypt_secret(&row.1)?.trim().to_string()))
}

fn ensure_aliyun_account(id: i64) -> Result<(), String> {
    let conn = open_db()?;
    let cloud_type = account_repository::cloud_type(&conn, id)?;
    if cloud_type != "aliyun" {
        return Err(format!("{}资源 API 尚未接入", if cloud_type == "tencent" { "腾讯云" } else { "当前云类型" }));
    }
    Ok(())
}

fn account_cloud_type(id: i64) -> Result<String, String> {
    account_repository::cloud_type(&open_db()?, id)
}

fn account_region_id(id: i64) -> Result<String, String> {
    Ok(account_repository::region_id(&open_db()?, id)?.filter(|value| !value.is_empty()).unwrap_or_else(|| "ap-guangzhou".into()))
}

#[tauri::command]
fn reveal_account_secret(id: i64) -> Result<String, String> {
    let conn = open_db()?;
    let ciphertext = account_repository::secret_ciphertext(&conn, id)?.ok_or("读取账号 Secret 失败")?;
    decrypt_secret(&ciphertext)
}

// Aliyun RPC uses RFC3986 encoding: only ALPHA / DIGIT / - . _ ~ remain unescaped.
fn rpc_encode(value: &str) -> String {
    cloud::aliyun::encode(value)
}

#[tauri::command]
async fn verify_ctyun_account(id: i64) -> Result<Value, String> {
    cloud::ctyun::verify_account(id).await
}

#[tauri::command]
async fn verify_huawei_account(id: i64) -> Result<Value, String> {
    cloud::huawei::verify_account(id).await
}

#[tauri::command]
async fn baidu_instance_action(id: i64, region_id: String, instance_id: String, action: String, force_stop: bool) -> Result<Value, String> {
    cloud::baidu::instance_action(id, &region_id, &instance_id, &action, force_stop).await
}

fn configured_regions(id: i64, fallback: &str) -> Result<Vec<String>, String> {
    let value = account_repository::region_id(&open_db()?, id)?;
    let mut regions = value.unwrap_or_else(|| fallback.into()).split(|character: char| character == ',' || character == '，' || character.is_whitespace()).filter(|value| !value.is_empty()).map(String::from).collect::<Vec<_>>();
    if regions.is_empty() { regions.push(fallback.into()); } regions.sort(); regions.dedup(); Ok(regions)
}

#[tauri::command]
async fn verify_ucloud_account(id: i64) -> Result<Value, String> { cloud::ucloud::verify_account(id).await }

#[tauri::command]
async fn verify_qiniu_account(id: i64) -> Result<Value, String> { cloud::qiniu::verify_account(id).await }

#[tauri::command]
async fn verify_aws_account(id: i64) -> Result<Value, String> { cloud::aws::verify_account(id).await }

#[tauri::command]
async fn verify_azure_account(id: i64) -> Result<Value, String> { cloud::azure::verify_account(id).await }

#[tauri::command]
async fn verify_gcp_account(id: i64) -> Result<Value, String> { cloud::gcp::verify_account(id).await }

fn value_first_string(value: Option<&Value>) -> Value { value.and_then(Value::as_array).and_then(|items| items.first()).cloned().or_else(|| value.cloned()).unwrap_or(json!("")) }
#[tauri::command]
async fn verify_jdcloud_account(id: i64) -> Result<Value, String> { cloud::jdcloud::verify_account(id).await }

#[tauri::command]
async fn verify_qingcloud_account(id: i64) -> Result<Value, String> { cloud::qingcloud::verify_account(id).await }

#[tauri::command]
async fn verify_ksyun_account(id: i64) -> Result<Value, String> { cloud::ksyun::verify_account(id).await }

async fn aliyun_esa(action: &str, params: BTreeMap<String, String>, method: &str, access_key_id: &str, access_key_secret: &str) -> Result<Value, String> {
    let host = "esa.cn-hangzhou.aliyuncs.com";
    let encoded_query = { let mut values: Vec<(String, String)> = params.iter().map(|(key, value)| (rpc_encode(key), rpc_encode(value))).collect(); values.sort(); values.iter().map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>().join("&") };
    let payload_hash = format!("{:x}", Sha256::digest(b""));
    let acs_date = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let nonce = Uuid::new_v4().to_string();
    let mut headers = BTreeMap::new();
    headers.insert("host", host.to_string()); headers.insert("x-acs-action", action.to_string()); headers.insert("x-acs-content-sha256", payload_hash.clone()); headers.insert("x-acs-date", acs_date.clone()); headers.insert("x-acs-signature-nonce", nonce.clone()); headers.insert("x-acs-version", "2024-09-10".to_string());
    let canonical_headers = headers.iter().map(|(key, value)| format!("{key}:{value}\n")).collect::<String>(); let signed_headers = headers.keys().cloned().collect::<Vec<_>>().join(";"); let method = method.to_uppercase(); let canonical_request = format!("{method}\n/\n{encoded_query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"); let string_to_sign = format!("ACS3-HMAC-SHA256\n{:x}", Sha256::digest(canonical_request.as_bytes()));
    let mut mac: Hmac<Sha256> = <Hmac<Sha256> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|e| e.to_string())?; mac.update(string_to_sign.as_bytes()); let authorization = format!("ACS3-HMAC-SHA256 Credential={access_key_id},SignedHeaders={signed_headers},Signature={}", hex::encode(mac.finalize().into_bytes()));
    let url = if encoded_query.is_empty() { format!("https://{host}/") } else { format!("https://{host}/?{encoded_query}") }; let client = reqwest::Client::new(); let request = if method == "POST" { client.post(url) } else { client.get(url) }; let response = request.header("host", host).header("x-acs-action", action).header("x-acs-content-sha256", payload_hash).header("x-acs-date", acs_date).header("x-acs-signature-nonce", nonce).header("x-acs-version", "2024-09-10").header("authorization", authorization).timeout(std::time::Duration::from_secs(25)).send().await.map_err(|e| format!("ESA 请求失败: {e}"))?;
    let status = response.status(); let data: Value = response.json().await.map_err(|e| format!("ESA 返回解析失败: {e}"))?; if !status.is_success() || data.get("Code").is_some() { let message = data.get("Message").and_then(Value::as_str).or_else(|| data.get("Code").and_then(Value::as_str)).unwrap_or("ESA API 返回错误"); write_api_log(access_key_id, host, action, &json!(params), Some(&data), "失败", Some(message)); return Err(message.to_string()); } write_api_log(access_key_id, host, action, &json!(params), Some(&data), "成功", None); Ok(data)
}

fn string_params(entries: &[(&str, String)]) -> BTreeMap<String, String> { entries.iter().map(|(key, value)| ((*key).to_string(), value.clone())).collect() }

fn array_at<'a>(value: &'a Value, path: &[&str]) -> Vec<&'a Value> { let mut current = value; for key in path { current = match current.get(*key) { Some(value) => value, None => return vec![] }; } match current { Value::Array(items) => items.iter().collect(), Value::Object(_) => vec![current], _ => vec![] } }

#[derive(Debug, Serialize)]
struct ResourceResponse { resource_type: String, items: Vec<Value>, errors: Vec<String>, fetched_at: i64 }

fn esa_field_details<'a>(data: &'a Value, field_name: &str) -> Vec<&'a Value> {
    array_at(data, &["Data"]).into_iter()
        .find(|item| item.get("FieldName").and_then(Value::as_str) == Some(field_name))
        .map(|item| array_at(item, &["DetailData"]))
        .unwrap_or_default()
}

fn esa_number(value: Option<&Value>) -> f64 {
    value.and_then(Value::as_f64)
        .or_else(|| value.and_then(Value::as_str).and_then(|text| text.parse::<f64>().ok()))
        .unwrap_or(0.0)
}

fn tencent_number(value: Option<&Value>) -> f64 {
    value.and_then(Value::as_f64)
        .or_else(|| value.and_then(Value::as_i64).map(|number| number as f64))
        .or_else(|| value.and_then(Value::as_str).and_then(|text| text.parse::<f64>().ok()))
        .unwrap_or(0.0)
}

fn validate_object_key(key: &str) -> Result<(), String> {
    if key.is_empty() { return Err("对象路径不能为空".into()); }
    if key.as_bytes().len() > 1023 { return Err("对象路径不能超过 1023 字节".into()); }
    if key.starts_with('/') || key.starts_with('\\') { return Err("对象路径不能以斜杠开头".into()); }
    if key.chars().any(char::is_control) { return Err("对象路径不能包含控制字符".into()); }
    Ok(())
}

pub(crate) fn xml_text(body: &str, tag: &str) -> String {
    let open = format!("<{tag}>"); let close = format!("</{tag}>");
    body.find(&open).and_then(|start| body[start + open.len()..].find(&close).map(|end| body[start + open.len()..start + open.len() + end].to_string())).unwrap_or_default()
}

pub(crate) fn xml_blocks(body: &str, tag: &str) -> Vec<String> {
    let open = format!("<{tag}>"); let close = format!("</{tag}>"); let mut values = Vec::new(); let mut rest = body;
    while let Some(start) = rest.find(&open) { let chunk = &rest[start + open.len()..]; let Some(end) = chunk.find(&close) else { break }; values.push(chunk[..end].to_string()); rest = &chunk[end + close.len()..]; }
    values
}

fn normalize_oci_private_key(value: &str) -> String {
    let mut key = value.trim().to_string();
    if key.to_ascii_uppercase().starts_with("OCI_API_KEY") {
        if let Some((name, rest)) = key.split_once('=') {
            if name.trim().eq_ignore_ascii_case("OCI_API_KEY") { key = rest.trim().to_string(); }
        }
    }
    if key.len() >= 2 && ((key.starts_with('"') && key.ends_with('"')) || (key.starts_with('\'') && key.ends_with('\''))) {
        key = key[1..key.len() - 1].to_string();
    }
    key = key.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\r", "\n").replace("\r\n", "\n").replace('\r', "\n");
    key = key.lines().map(|line| {
        let trimmed = line.trim_start();
        if (trimmed.starts_with("\\-----BEGIN ") || trimmed.starts_with("\\-----END ")) && (trimmed.contains("PRIVATE KEY-----")) {
            &trimmed[1..]
        } else { line }
    }).collect::<Vec<_>>().join("\n");

    for kind in ["PRIVATE KEY", "RSA PRIVATE KEY"] {
        let begin = format!("-----BEGIN {kind}-----");
        let end = format!("-----END {kind}-----");
        let Some(start) = key.find(&begin) else { continue };
        let body_start = start + begin.len();
        let Some(end_offset) = key[body_start..].find(&end) else { continue };
        let body = key[body_start..body_start + end_offset].chars().filter(|character| !character.is_whitespace()).collect::<String>();
        if body.is_empty() || !body.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/' || byte == b'=') { return key; }
        let lines = body.as_bytes().chunks(64).map(|chunk| std::str::from_utf8(chunk).expect("OCI PEM body is ASCII")).collect::<Vec<_>>().join("\n");
        return format!("{begin}\n{lines}\n{end}");
    }
    key
}

fn serialize_oci_private_key(value: &str) -> String {
    normalize_oci_private_key(value).replace('\n', "\\n")
}

#[cfg(test)]
mod oci_private_key_tests {
    use super::{normalize_oci_private_key, serialize_oci_private_key};

    #[test]
    fn serializes_and_restores_a_pem_key() {
        let input = "OCI_API_KEY=\"\\-----BEGIN PRIVATE KEY-----\\nQUJDRA==\\n\\-----END PRIVATE KEY-----\"";
        let expected = "-----BEGIN PRIVATE KEY-----\nQUJDRA==\n-----END PRIVATE KEY-----";
        assert_eq!(serialize_oci_private_key(input), "-----BEGIN PRIVATE KEY-----\\nQUJDRA==\\n-----END PRIVATE KEY-----");
        assert_eq!(normalize_oci_private_key(&serialize_oci_private_key(input)), expected);
    }
}


#[cfg(test)]
fn oracle_object_storage_host(region: &str) -> String {
    format!("objectstorage.{region}.oci.customer-oci.com")
}

#[cfg(test)]
fn oracle_is_user_compartment(compartment: &Value) -> bool {
    !compartment.get("name").and_then(Value::as_str).is_some_and(|name| name.eq_ignore_ascii_case("ManagedCompartmentForPaaS"))
}

#[cfg(test)]
mod oracle_resource_tests {
    use super::{oracle_is_user_compartment, oracle_object_storage_host};
    use serde_json::json;

    #[test]
    fn uses_the_tls_validated_object_storage_endpoint() {
        assert_eq!(oracle_object_storage_host("me-dubai-1"), "objectstorage.me-dubai-1.oci.customer-oci.com");
    }

    #[test]
    fn excludes_the_oracle_managed_paas_compartment_only() {
        assert!(!oracle_is_user_compartment(&json!({"name": "ManagedCompartmentForPaaS"})));
        assert!(oracle_is_user_compartment(&json!({"name": "业务资源组"})));
    }
}







#[tauri::command]
async fn oracle_instance_action(id: i64, region_id: String, instance_id: String, action: String) -> Result<String, String> { cloud::oracle::instance_action(id, region_id, instance_id, action).await }


#[tauri::command]
async fn list_cloud_resources(id: i64, resource_type: String) -> Result<ResourceResponse, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    Ok(match account_cloud_type(id)?.as_str() {
        "aliyun" => cloud::aliyun::resource_items(&resource_type, &access_key_id, &access_key_secret).await,
        "tencent" => cloud::tencent::resource_items(id, &resource_type, &access_key_id, &access_key_secret).await,
        "volcengine" => cloud::volc::resource_items(id, &resource_type, &access_key_id, &access_key_secret).await,
        "ctyun" => cloud::ctyun::resource_items(id, &resource_type, &access_key_id, &access_key_secret).await,
        "huawei" => cloud::huawei::resource_items(id, &resource_type).await,
        "baidu" => cloud::baidu::resource_items(id, &resource_type).await,
        "ucloud" => cloud::ucloud::resource_items(id, &resource_type).await,
        "qiniu" => cloud::qiniu::resource_items(id, &resource_type).await,
        "aws" => cloud::aws::resource_items(id, &resource_type).await,
        "azure" => cloud::azure::resource_items(id, &resource_type).await,
        "gcp" => cloud::gcp::resource_items(id, &resource_type).await,
        "jdcloud" => cloud::jdcloud::resource_items(id, &resource_type).await,
        "qingcloud" => cloud::qingcloud::resource_items(id, &resource_type).await,
        "ksyun" => cloud::ksyun::resource_items(id, &resource_type).await,
        "oracle" => cloud::oracle::resource_items(id, &resource_type).await,
        "vultr" => cloud::vultr::vultr_resource_items(id, &resource_type).await,
        _ => return Err("当前云类型资源 API 尚未接入".into()),
    })
}

#[tauri::command]
async fn esa_overview(id: i64, range: String, site_id: Option<String>) -> Result<Value, String> {
    if account_cloud_type(id)? == "tencent" || account_cloud_type(id)? == "volcengine" {
        let (access_key_id, access_key_secret) = account_credentials(id)?;
        let zones = if account_cloud_type(id)? == "tencent" {
            cloud::tencent::resource_items(id, "esa", &access_key_id, &access_key_secret).await
        } else {
            cloud::volc::resource_items(id, "esa", &access_key_id, &access_key_secret).await
        };
        let label = match range.as_str() { "yesterday" => "昨日", "week" => "近 7 日", "month" => "近 30 日", _ => "今日" };
        return Ok(json!({
            "traffic": 0, "requests": 0, "defence_requests": 0,
            "site_count": zones.items.len(), "active_count": zones.items.iter().filter(|site| site.get("Status").and_then(Value::as_str).is_some_and(|status| status.eq_ignore_ascii_case("active"))).count(),
            "range_label": label, "trend": {"traffic": [], "requests": [], "page_view": []},
            "site_options": zones.items.iter().map(|site| json!({"id": site.get("SiteId").cloned().unwrap_or(json!("")), "name": site.get("SiteName").or_else(|| site.get("DomainName")).or_else(|| site.get("SiteId")).cloned().unwrap_or(json!(""))})).collect::<Vec<_>>(),
        }));
    }
    ensure_aliyun_account(id)?;
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let sites_result = aliyun_esa("ListSites", string_params(&[
        ("SiteSearchType", "fuzzy".into()), ("SiteName", "".into()),
        ("PageNumber", "1".into()), ("PageSize", "100".into()),
    ]), "GET", &access_key_id, &access_key_secret).await?;
    let sites = array_at(&sites_result, &["Sites"]);
    let now = Local::now();
    let today = Local.from_local_datetime(&now.date_naive().and_hms_opt(0, 0, 0).ok_or("无法计算今日起点")?).single().unwrap_or(now);
    let (start, end, label, interval) = match range.as_str() {
        "yesterday" => (today - Duration::days(1), today, "昨日", "3600"),
        "week" => (today - Duration::days(6), now, "近 7 日", "86400"),
        "month" => (today - Duration::days(29), now, "近 30 日", "86400"),
        _ => (today, now, "今日", "3600"),
    };
    let fields = json!([
        {"FieldName": "Requests", "Dimension": ["ALL"]},
        {"FieldName": "Traffic", "Dimension": ["ALL"]},
        {"FieldName": "PageView", "Dimension": ["ALL"]},
    ]).to_string();
    let mut base = string_params(&[
        ("StartTime", start.with_timezone(&Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string()),
        ("EndTime", end.with_timezone(&Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string()),
        ("Interval", interval.into()),
    ]);
    let selected_site = site_id.filter(|value| !value.is_empty());
    if let Some(ref value) = selected_site { base.insert("SiteId".into(), value.clone()); }
    let mut top_params = base.clone(); top_params.insert("AnalysisType".into(), "1".into()); top_params.insert("Fields".into(), fields.clone());
    let mut defence_params = base.clone();
    defence_params.insert("Fields".into(), json!([{"FieldName":"Requests", "Dimension":["ALL"]}]).to_string());
    defence_params.insert("Filter".into(), json!({"where":{"and":[[{"key":"MitigationType","operator":"in","value":["WafMitigated"]}]]}}).to_string());
    let mut trend_params = base; trend_params.insert("Fields".into(), fields);
    let (top, defence, trend) = tokio::try_join!(
        aliyun_esa("DescribeSiteTopData", top_params, "POST", &access_key_id, &access_key_secret),
        aliyun_esa("DescribeSiteStatisticsData", defence_params, "POST", &access_key_id, &access_key_secret),
        aliyun_esa("DescribeSiteStatisticsData", trend_params, "POST", &access_key_id, &access_key_secret),
    )?;
    let make_trend = |field_name: &str| esa_field_details(&trend, field_name).into_iter().map(|detail| json!({
        "time": detail.get("Time").or_else(|| detail.get("Timestamp")).or_else(|| detail.get("TimeStamp")).or_else(|| detail.get("Date")).cloned().unwrap_or(json!("")),
        "value": esa_number(detail.get("Value")),
    })).collect::<Vec<_>>();
    Ok(json!({
        "traffic": esa_number(esa_field_details(&top, "Traffic").first().and_then(|detail| detail.get("Value"))),
        "requests": esa_number(esa_field_details(&top, "Requests").first().and_then(|detail| detail.get("Value"))),
        "defence_requests": esa_number(esa_field_details(&defence, "Requests").first().and_then(|detail| detail.get("Value"))),
        "site_count": sites_result.get("TotalCount").and_then(Value::as_i64).unwrap_or(sites.len() as i64),
        "active_count": sites.iter().filter(|site| site.get("Status").and_then(Value::as_str).map(|status| status.eq_ignore_ascii_case("active")).unwrap_or(false)).count(),
        "range_label": label,
        "trend": {"traffic": make_trend("Traffic"), "requests": make_trend("Requests"), "page_view": make_trend("PageView")},
        "site_options": sites.iter().map(|site| json!({"id": site.get("SiteId").cloned().unwrap_or(json!("")), "name": site.get("SiteName").or_else(|| site.get("DomainName")).or_else(|| site.get("SiteId")).cloned().unwrap_or(json!(""))})).collect::<Vec<_>>(),
    }))
}

#[tauri::command]
async fn list_instance_disks(id: i64, region_id: String, instance_id: String, compartment_ocid: Option<String>) -> Result<Vec<Value>, String> {
    if account_cloud_type(id)? == "oracle" { return cloud::oracle::instance_disks(id, &region_id, &instance_id, compartment_ocid.as_deref().unwrap_or("")).await; }
    if account_cloud_type(id)? == "tencent" { return cloud::tencent::instance_disks(id, &region_id, &instance_id).await; }
    cloud::aliyun::instance_disks(id, &region_id, &instance_id).await
}


#[tauri::command]
async fn list_aliyun_security_groups(id: i64, region_id: String, instance_id: String, security_group_id: Option<String>) -> Result<Value, String> {
    cloud::aliyun::list_security_groups(id, &region_id, &instance_id, security_group_id).await
}

#[tauri::command]
async fn authorize_aliyun_security_group_rule(id: i64, region_id: String, security_group_id: String, ip_protocol: String, port_range: String, source_cidr_ip: String, description: Option<String>, nic_type: Option<String>) -> Result<String, String> {
    cloud::aliyun::authorize_security_group_rule(id, &region_id, &security_group_id, ip_protocol, port_range, source_cidr_ip, description, nic_type).await
}

#[tauri::command]
async fn revoke_aliyun_security_group_rule(id: i64, region_id: String, security_group_id: String, ip_protocol: String, port_range: String, source_cidr_ip: String, policy: String, priority: i32, nic_type: Option<String>) -> Result<String, String> {
    cloud::aliyun::revoke_security_group_rule(id, &region_id, &security_group_id, ip_protocol, port_range, source_cidr_ip, policy, priority, nic_type).await
}


#[tauri::command]
async fn list_tencent_security_groups(id: i64, region_id: String, instance_id: String, security_group_id: Option<String>) -> Result<Value, String> {
    cloud::tencent::list_security_groups(id, &region_id, &instance_id, security_group_id).await
}

#[tauri::command]
async fn list_baidu_security_groups(id: i64, region_id: String, instance_id: String, security_group_id: Option<String>) -> Result<Value, String> {
    cloud::baidu::list_security_groups(id, &region_id, &instance_id, security_group_id).await
}

#[tauri::command]
async fn reboot_instance(id: i64, region_id: String, instance_id: String, force_stop: bool) -> Result<String, String> {
    cloud::aliyun::instance_action(id, region_id, instance_id, "reboot", force_stop).await
}

#[tauri::command]
async fn start_instance(id: i64, region_id: String, instance_id: String) -> Result<String, String> {
    cloud::aliyun::instance_action(id, region_id, instance_id, "start", false).await
}

#[tauri::command]
async fn stop_instance(id: i64, region_id: String, instance_id: String) -> Result<String, String> {
    cloud::aliyun::instance_action(id, region_id, instance_id, "stop", false).await
}

#[tauri::command]
async fn instance_status(id: i64, region_id: String, instance_id: String) -> Result<String, String> {
    cloud::aliyun::instance_status(id, region_id, instance_id).await
}

#[tauri::command]
async fn cvm_instance_action(id: i64, region_id: String, instance_id: String, action: String, force_stop: bool) -> Result<String, String> {
    cloud::tencent::cvm_instance_action(id, &region_id, &instance_id, &action, force_stop).await
}

#[tauri::command]
async fn cvm_instance_reboot(id: i64, region_id: String, instance_id: String, force_stop: bool) -> Result<String, String> {
    cloud::tencent::cvm_instance_reboot(id, &region_id, &instance_id, force_stop).await
}

#[tauri::command]
async fn authorize_tencent_security_group_rule(id: i64, region_id: String, security_group_id: String, ip_protocol: String, port_range: String, source_cidr_ip: String, description: Option<String>, nic_type: Option<String>) -> Result<String, String> {
    let _ = nic_type;
    cloud::tencent::authorize_security_group_rule(id, &region_id, &security_group_id, ip_protocol, port_range, source_cidr_ip, description).await
}

#[tauri::command]
async fn revoke_tencent_security_group_rule(id: i64, region_id: String, security_group_id: String, _ip_protocol: String, _port_range: String, _source_cidr_ip: String, _policy: String, priority: i32, _nic_type: Option<String>) -> Result<String, String> {
    cloud::tencent::revoke_security_group_rule(id, &region_id, &security_group_id, priority).await
}

#[tauri::command]
async fn authorize_baidu_security_group_rule(id: i64, region_id: String, security_group_id: String, ip_protocol: String, port_range: String, source_cidr_ip: String, description: Option<String>, nic_type: Option<String>, sg_version: Option<i64>) -> Result<String, String> {
    let _ = nic_type;
    cloud::baidu::authorize_security_group_rule(id, &region_id, &security_group_id, ip_protocol, port_range, source_cidr_ip, description, sg_version).await
}

#[tauri::command]
async fn revoke_baidu_security_group_rule(id: i64, region_id: String, security_group_id: String, _ip_protocol: String, _port_range: String, _source_cidr_ip: String, _policy: String, _priority: i32, _nic_type: Option<String>, security_group_rule_id: Option<String>, sg_version: Option<i64>) -> Result<String, String> {
    cloud::baidu::revoke_security_group_rule(id, &region_id, &security_group_id, security_group_rule_id, sg_version).await
}

fn update_cached_server_name(account_id: i64, instance_id: &str, instance_name: &str) -> Result<(), String> {
    asset_repository::update_server_name(&open_db()?, account_id, instance_id, instance_name)
}

#[tauri::command]
async fn rename_server(id: i64, region_id: String, instance_id: String, instance_name: String) -> Result<String, String> {
    let instance_name = instance_name.trim().to_string();
    if region_id.trim().is_empty() || instance_id.trim().is_empty() { return Err("缺少服务器地域或实例 ID".into()); }
    if instance_name.is_empty() { return Err("服务器名称不能为空".into()); }
    if instance_name.as_bytes().len() > 128 { return Err("服务器名称不能超过 128 个字节".into()); }
    let request_id = if account_cloud_type(id)? == "tencent" {
        cloud::tencent::rename_instance(id, &region_id, &instance_id, &instance_name).await?
    } else {
        cloud::aliyun::rename_instance(id, &region_id, &instance_id, &instance_name).await?
    };
    update_cached_server_name(id, &instance_id, &instance_name)?;
    Ok(request_id)
}

#[tauri::command]
async fn swas_instance_action(id: i64, region_id: String, instance_id: String, action: String, force_stop: bool) -> Result<String, String> {
    if region_id.is_empty() || instance_id.is_empty() { return Err("缺少轻量服务器地域或实例 ID".into()); }
    let cloud_type = account_cloud_type(id)?;
    let result = if cloud_type == "aliyun" {
        cloud::aliyun::swas_instance_action(id, &region_id, &instance_id, &action, force_stop).await?
    } else if cloud_type == "tencent" {
        cloud::tencent::swas_instance_action(id, &region_id, &instance_id, &action, force_stop).await?
    } else if cloud_type == "jdcloud" {
        let action_name = match action.as_str() { "start" => "startInstance", "reboot" => "rebootInstance", "stop" => "stopInstance", _ => return Err("不支持的轻量服务器操作".into()) };
        cloud::jdcloud::instance_action(id, &region_id, &instance_id, action_name).await?
    } else { return Err("当前云类型暂不支持轻量服务器操作".into()); };
    Ok(result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}

fn light_firewall_rule_input(ip_protocol: String, port_range: String, source_cidr_ip: String, description: Option<String>) -> Result<(String, String, String, String), String> {
    let protocol = ip_protocol.trim().to_ascii_lowercase();
    let port_range = port_range.trim().to_string();
    let source_cidr_ip = source_cidr_ip.trim().to_string();
    let parts = port_range.split('/').collect::<Vec<_>>();
    if !matches!(protocol.as_str(), "tcp" | "udp") { return Err("轻量服务器仅支持 TCP 或 UDP 端口规则".into()); }
    if parts.len() != 2 { return Err("端口范围格式无效，请使用 80/80 或 8000/9000".into()); }
    let start = parts[0].parse::<u16>().ok();
    let end = parts[1].parse::<u16>().ok();
    if start.is_none() || end.is_none() || start.unwrap() == 0 || end.unwrap() < start.unwrap() { return Err("端口范围必须在 1 到 65535 之间".into()); }
    if source_cidr_ip.is_empty() || !source_cidr_ip.contains('/') { return Err("来源地址必须是 CIDR，例如 0.0.0.0/0".into()); }
    Ok((protocol, port_range, source_cidr_ip, description.unwrap_or_default().trim().to_string()))
}

#[tauri::command]
async fn list_light_firewall_rules(id: i64, region_id: String, instance_id: String) -> Result<Value, String> {
    if region_id.is_empty() || instance_id.is_empty() { return Err("缺少轻量服务器地域或实例 ID".into()); }
    let cloud_type = account_cloud_type(id)?;
    if cloud_type == "aliyun" {
        return cloud::aliyun::list_light_firewall_rules(id, &region_id, &instance_id).await;
    }
    if cloud_type == "tencent" {
        return cloud::tencent::list_light_firewall_rules(id, &region_id, &instance_id).await;
    }
    if cloud_type == "jdcloud" {
        return cloud::jdcloud::list_firewall_rules(id, &region_id, &instance_id).await;
    }
    Err("当前云类型暂不支持轻量服务器防火墙管理".into())
}

#[tauri::command]
async fn create_light_firewall_rule(id: i64, region_id: String, instance_id: String, ip_protocol: String, port_range: String, source_cidr_ip: String, description: Option<String>, firewall_version: Option<i64>) -> Result<String, String> {
    if region_id.is_empty() || instance_id.is_empty() { return Err("缺少轻量服务器地域或实例 ID".into()); }
    let (protocol, port_range, source_cidr_ip, description) = light_firewall_rule_input(ip_protocol, port_range, source_cidr_ip, description)?;
    let cloud_type = account_cloud_type(id)?;
    let result = if cloud_type == "aliyun" {
        cloud::aliyun::create_light_firewall_rule(id, &region_id, &instance_id, &protocol, &port_range, &source_cidr_ip, &description).await?
    } else if cloud_type == "tencent" {
        cloud::tencent::create_light_firewall_rule(id, &region_id, &instance_id, &protocol, &port_range, &source_cidr_ip, &description, firewall_version).await?
    } else if cloud_type == "jdcloud" {
        cloud::jdcloud::create_firewall_rule(id, &region_id, &instance_id, &protocol, &port_range, &source_cidr_ip, &description).await?
    } else { return Err("当前云类型暂不支持轻量服务器防火墙管理".into()); };
    Ok(result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}

#[tauri::command]
async fn delete_light_firewall_rule(id: i64, region_id: String, instance_id: String, rule_id: Option<String>, firewall_rule: Option<Value>, firewall_version: Option<i64>) -> Result<String, String> {
    if region_id.is_empty() || instance_id.is_empty() { return Err("缺少轻量服务器地域或实例 ID".into()); }
    let cloud_type = account_cloud_type(id)?;
    let result = if cloud_type == "aliyun" {
        let rule_id = rule_id.filter(|value| !value.trim().is_empty()).ok_or("缺少阿里云防火墙规则 ID")?;
        cloud::aliyun::delete_light_firewall_rule(id, &region_id, &instance_id, &rule_id).await?
    } else if cloud_type == "tencent" {
        let firewall_rule = firewall_rule.filter(Value::is_object).ok_or("缺少腾讯云防火墙规则内容")?;
        cloud::tencent::delete_light_firewall_rule(id, &region_id, &instance_id, firewall_rule, firewall_version).await?
    } else if cloud_type == "jdcloud" {
        let rule_id = rule_id.filter(|value| !value.trim().is_empty()).ok_or("缺少京东云防火墙规则 ID")?;
        cloud::jdcloud::delete_firewall_rule(id, &region_id, &instance_id, &rule_id).await?
    } else { return Err("当前云类型暂不支持轻量服务器防火墙管理".into()); };
    Ok(result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}

#[tauri::command]
async fn list_dns_records(id: i64, domain: String, record_type: Option<String>, keyword: Option<String>) -> Result<Value, String> {
    if account_cloud_type(id)? == "tencent" {
        return cloud::tencent::list_dns_records(id, &domain, record_type, keyword).await;
    }
    if account_cloud_type(id)? == "ctyun" {
        return cloud::ctyun::list_dns_records(id, &domain, record_type, keyword).await;
    }
    cloud::aliyun::list_dns_records(id, &domain, record_type, keyword).await
}

#[tauri::command]
async fn add_dns_record(id: i64, domain: String, record_type: String, rr: String, value: String, ttl: Option<i64>, priority: Option<i64>, line: Option<String>) -> Result<Value, String> {
    cloud::aliyun::add_dns_record(id, &domain, &record_type, &rr, &value, ttl, priority, line).await
}

#[tauri::command]
async fn update_dns_record(id: i64, record_id: String, record_type: String, rr: String, value: String, ttl: Option<i64>, priority: Option<i64>, line: Option<String>) -> Result<Value, String> {
    cloud::aliyun::update_dns_record(id, &record_id, &record_type, &rr, &value, ttl, priority, line).await
}

#[tauri::command]
async fn delete_dns_record(id: i64, record_id: String) -> Result<Value, String> {
    cloud::aliyun::delete_dns_record(id, &record_id).await
}

#[tauri::command]
async fn toggle_dns_record(id: i64, record_id: String, status: String) -> Result<Value, String> {
    cloud::aliyun::toggle_dns_record(id, &record_id, &status).await
}

#[tauri::command]
async fn list_domain_logs(id: i64, domain: String, start_date: Option<String>, end_date: Option<String>, keyword: Option<String>) -> Result<Value, String> {
    cloud::aliyun::list_domain_logs(id, &domain, start_date, end_date, keyword).await
}

#[tauri::command]
async fn query_whois(id: i64, domain: String) -> Result<String, String> {
    cloud::aliyun::query_whois(id, &domain).await
}

#[tauri::command]
async fn list_rds_databases(id: i64, region_id: String, instance_id: String) -> Result<Vec<Value>, String> {
    if account_cloud_type(id)? == "tencent" { return cloud::tencent::list_rds_databases(id, &region_id, &instance_id).await; }
    cloud::aliyun::list_rds_databases(id, &region_id, &instance_id).await
}

#[tauri::command]
async fn list_rds_accounts(id: i64, region_id: String, instance_id: String) -> Result<Vec<Value>, String> {
    if account_cloud_type(id)? == "tencent" { return cloud::tencent::list_rds_accounts(id, &region_id, &instance_id).await; }
    cloud::aliyun::list_rds_accounts(id, &region_id, &instance_id).await
}

#[tauri::command]
async fn list_redis_accounts(id: i64, instance_id: String, region_id: String) -> Result<Vec<Value>, String> {
    if account_cloud_type(id)? == "tencent" { return cloud::tencent::list_redis_accounts(id, &instance_id, &region_id).await; }
    cloud::aliyun::list_redis_accounts(id, &instance_id, &region_id).await
}

#[tauri::command]
async fn list_oss_objects(id: i64, bucket: String, location: String, prefix: String, marker: String) -> Result<Value, String> {
    if account_cloud_type(id)? == "tencent" { return cloud::tencent::list_objects(id, &bucket, &location, &prefix, &marker).await; }
    cloud::aliyun::list_objects(id, &bucket, &location, &prefix, &marker).await
}

#[tauri::command]
fn get_oss_object_url(id: i64, bucket: String, location: String, object_key: String) -> Result<String, String> {
    cloud::aliyun::signed_object_url(id, &bucket, &location, &object_key)
}

#[tauri::command]
fn select_oss_upload_file(app: tauri::AppHandle, store: tauri::State<'_, OssUploadSelectionStore>) -> Result<Option<OssUploadSelection>, String> {
    let Some(selected) = app.dialog().file().blocking_pick_file() else { return Ok(None) };
    let path = selected.into_path().map_err(|_| "当前平台返回了不支持的文件地址".to_string())?;
    stage_oss_upload_path(store, path).map(Some)
}

fn stage_oss_upload_path(store: tauri::State<'_, OssUploadSelectionStore>, path: PathBuf) -> Result<OssUploadSelection, String> {
    let canonical = path.canonicalize().map_err(|error| format!("读取所选文件失败: {error}"))?;
    let metadata = canonical.metadata().map_err(|error| format!("读取所选文件信息失败: {error}"))?;
    if !metadata.is_file() { return Err("请选择一个本机文件".into()); }
    if metadata.len() > 5 * 1024 * 1024 * 1024 { return Err("单文件上传不能超过 5 GB".into()); }
    let name = canonical.file_name().and_then(|value| value.to_str()).filter(|value| !value.is_empty()).ok_or_else(|| "无法识别文件名".to_string())?.to_string();
    let token = Uuid::new_v4().to_string();
    store.files.lock().map_err(|_| "上传文件选择状态不可用".to_string())?.insert(token.clone(), canonical);
    Ok(OssUploadSelection { token, name, size: metadata.len() })
}

#[tauri::command]
fn stage_oss_upload_file(store: tauri::State<'_, OssUploadSelectionStore>, source_path: String) -> Result<OssUploadSelection, String> {
    stage_oss_upload_path(store, PathBuf::from(source_path))
}

#[tauri::command]
fn discard_oss_upload_selection(store: tauri::State<'_, OssUploadSelectionStore>, selection_token: String) -> Result<(), String> {
    store.files.lock().map_err(|_| "上传文件选择状态不可用".to_string())?.remove(&selection_token);
    Ok(())
}

#[tauri::command]
async fn upload_oss_object(store: tauri::State<'_, OssUploadSelectionStore>, id: i64, bucket: String, location: String, object_key: String, selection_token: String, overwrite: bool) -> Result<(), String> {
    let source_path = store.files.lock().map_err(|_| "上传文件选择状态不可用".to_string())?.remove(&selection_token).ok_or_else(|| "上传文件选择已失效，请重新选择文件".to_string())?;
    if account_cloud_type(id)? != "aliyun" { return Err("当前仅支持阿里云 OSS 文件上传".into()); }
    cloud::aliyun::upload_object(id, &bucket, &location, &object_key, &source_path, overwrite).await
}

#[tauri::command]
async fn download_oss_object(app: tauri::AppHandle, id: i64, bucket: String, location: String, object_key: String) -> Result<Option<String>, String> {
    validate_object_key(&object_key)?;
    if account_cloud_type(id)? != "aliyun" { return Err("当前仅支持阿里云 OSS 文件下载".into()); }
    let suggested_name = object_key.rsplit('/').find(|value| !value.is_empty()).unwrap_or("download").replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_");
    let Some(selected) = app.dialog().file().set_file_name(suggested_name).blocking_save_file() else { return Ok(None) };
    let target_path = selected.into_path().map_err(|_| "当前平台返回了不支持的下载地址".to_string())?;
    cloud::aliyun::download_object(id, &bucket, &location, &object_key, &target_path).await?;
    Ok(Some(target_path.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn download_oss_objects(app: tauri::AppHandle, id: i64, bucket: String, location: String, object_keys: Vec<String>) -> Result<Option<Vec<String>>, String> {
    if account_cloud_type(id)? != "aliyun" { return Err("当前仅支持阿里云 OSS 文件下载".into()); }
    if object_keys.is_empty() { return Err("请至少选择一个文件".into()); }
    if object_keys.len() > 50 { return Err("单次最多下载 50 个文件".into()); }
    let mut names = std::collections::HashSet::new();
    for key in &object_keys {
        validate_object_key(key)?;
        let name = key.rsplit('/').find(|value| !value.is_empty()).unwrap_or("download").replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_");
        if !names.insert(name.to_ascii_lowercase()) { return Err("所选文件存在同名目标，无法安全批量下载".into()); }
    }
    let Some(folder) = app.dialog().file().blocking_pick_folder() else { return Ok(None) };
    let folder_path = folder.into_path().map_err(|_| "当前平台返回了不支持的下载目录".to_string())?;
    let mut paths = Vec::with_capacity(object_keys.len());
    for key in object_keys {
        let filename = key.rsplit('/').find(|value| !value.is_empty()).unwrap_or("download").replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_");
        let target = folder_path.join(filename);
        cloud::aliyun::download_object(id, &bucket, &location, &key, &target).await?;
        paths.push(target.to_string_lossy().into_owned());
    }
    Ok(Some(paths))
}

#[tauri::command]
async fn get_oss_acl(id: i64, bucket: String, location: String) -> Result<String, String> {
    if account_cloud_type(id)? == "tencent" { return cloud::tencent::get_acl(id, &bucket, &location).await; }
    cloud::aliyun::get_acl(id, &bucket, &location).await
}

#[tauri::command]
async fn set_oss_cors(id: i64, bucket: String, location: String, origins: String) -> Result<(), String> {
    cloud::aliyun::set_cors(id, &bucket, &location, &origins).await
}

#[derive(Debug, Serialize)]
struct LocalAsset { account_id: i64, resource_type: String, asset_key: String, region_id: Option<String>, payload: Value, fetched_at: i64 }

#[derive(Debug, Serialize)]
struct AssetSyncResult { fetched: usize, counts: BTreeMap<String, usize>, errors: Vec<String>, fetched_at: i64 }

#[derive(Debug, Serialize)]
struct ApiLog { id: i64, account_id: Option<i64>, account_name: Option<String>, endpoint: String, action: String, request_params: String, response_params: Option<String>, status: String, message: Option<String>, created_at: i64 }

#[tauri::command]
fn save_managed_host(input: ManagedHostInput) -> Result<ManagedHost, String> {
    let name = input.name.trim(); let host = input.host.trim(); let username = input.username.trim();
    let platform = input.platform.as_deref().unwrap_or("linux");
    if !matches!(platform, "linux" | "windows") { return Err("不支持的操作系统类型".into()); }
    let auth_method = if platform == "linux" { input.auth_method.as_deref().unwrap_or("password") } else { "password" };
    if !matches!(auth_method, "password" | "private_key") { return Err("不支持的 Linux 验证方式".into()); }
    if name.is_empty() || host.is_empty() || username.is_empty() { return Err(format!("请填写服务器名称、主机地址和 {}用户名", if platform == "windows" { "RDP " } else { "SSH " })); }
    let port = input.port.unwrap_or(if platform == "windows" { 3389 } else { 22 }).max(1);
    let conn = open_db()?; let now = Utc::now().timestamp_millis();
    let existing = input.id.map(|id| managed_host_repository::existing_secrets(&conn, id)).transpose()?.flatten();
    let password_secret = input.password.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(encrypt_secret).transpose()?.or_else(|| existing.as_ref().and_then(|value| value.0.clone()));
    let has_new_key = input.private_key.as_deref().is_some_and(|value| !value.trim().is_empty());
    let private_key_secret = if auth_method == "private_key" {
        input.private_key.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(encrypt_secret).transpose()?.or_else(|| existing.as_ref().and_then(|value| value.1.clone()))
    } else { None };
    let key_passphrase_secret = if auth_method == "private_key" {
        if has_new_key || input.key_passphrase.is_some() { input.key_passphrase.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(encrypt_secret).transpose()? } else { existing.as_ref().and_then(|value| value.2.clone()) }
    } else { None };
    if platform == "linux" && auth_method == "password" && password_secret.as_deref().is_none_or(str::is_empty) { return Err("首次添加 Linux 服务器需要填写 SSH 密码".into()); }
    if platform == "linux" && auth_method == "private_key" && private_key_secret.as_deref().is_none_or(str::is_empty) { return Err("首次添加 Linux 服务器需要粘贴 SSH 私钥".into()); }
    let password_value = if auth_method == "private_key" { String::new() } else { password_secret.unwrap_or_default() };
    managed_host_repository::save(&conn, &input, name, host, username, platform, auth_method, port, &password_value, private_key_secret.as_deref(), key_passphrase_secret.as_deref(), now)
}

fn managed_host_saved_connection(id: i64) -> Result<Option<SavedSshCredentials>, String> {
    managed_host_repository::saved_connection(&open_db()?, id)
}

#[tauri::command]
async fn probe_managed_host(id: i64) -> Result<ManagedHost, String> {
    let saved = managed_host_saved_connection(id)?.ok_or("服务器不存在")?;
    if saved.platform == "windows" { return Err("Windows 服务器请通过 RDP 打开，暂不支持 SSH 状态检测".into()); }
    let host = saved.host.clone(); let port = saved.port; let username = saved.username.clone(); let known_fingerprint = saved.host_key_fingerprint.clone();
    let credentials = if saved.auth_method == "private_key" {
        let key_ciphertext = saved.private_key_ciphertext.as_deref().filter(|value| !value.is_empty()).ok_or_else(|| "服务器未保存 SSH 私钥".to_string())?;
        let key = decrypt_secret(key_ciphertext)?;
        let passphrase = saved.key_passphrase_ciphertext.as_deref().filter(|value| !value.is_empty()).map(decrypt_secret).transpose()?;
        SshCredentials::PrivateKey { key, passphrase }
    } else { SshCredentials::Password(decrypt_secret(saved.password_ciphertext.as_deref().filter(|value| !value.is_empty()).ok_or("服务器未保存 SSH 密码")?)?) };
    let started = Instant::now(); let observed_fingerprint = Arc::new(Mutex::new(None));
    let handler = SshHostKeyHandler { expected_fingerprint: known_fingerprint, observed_fingerprint: observed_fingerprint.clone() };
    let attempt = async {
        let config = Arc::new(client::Config::default());
        let mut session = client::connect(config, (host.as_str(), port), handler).await.map_err(|error| format!("连接 SSH 主机失败: {error}"))?;
        let fingerprint = observed_fingerprint.lock().map_err(|_| "SSH 主机密钥状态不可用".to_string())?.clone().ok_or("无法读取 SSH 主机密钥")?;
        authenticate_ssh(&mut session, &username, &credentials, "探测").await?;
        let mut channel = session.channel_open_session().await.map_err(|error| format!("打开 SSH 会话失败: {error}"))?;
        let command = r#"net_bytes(){ awk 'NR>2 {gsub(\":\",\"\",$1); rx+=$2; tx+=$10} END {print tx+0\" \"rx+0}' /proc/net/dev; }; disk_stats(){ awk '$3 ~ /^[sv]d[a-z]+$/ || $3 ~ /^nvme[0-9]+n[0-9]+$/ {rb += $6*512; wb += $10*512; ri += $4; wi += $8; rt += $7; wt += $11} END {print rb+0\" \"wb+0\" \"ri+0\" \"wi+0\" \"rt+0\" \"wt+0}' /proc/diskstats; }; net1=$(net_bytes); disk1=$(disk_stats); printf '\n'; printf 'hostname='; hostname; printf '\n'; printf '\n'; printf '\n'; printf 'ip='; hostname -I 2>/dev/null | awk '{print $1}'; printf '\n'; printf '\n'; printf 'os_name='; if [ -r /etc/os-release ]; then . /etc/os-release 2>/dev/null; printf '%s' "${PRETTY_NAME:-}"; fi; printf '\n'; printf '\n'; printf '\n'; printf 'os='; uname -sr; printf '\n'; printf '\n'; printf '\n'; printf 'uptime='; uptime -p 2>/dev/null || uptime; printf '\n'; printf '\n'; printf '\n'; printf 'load='; awk '{print $1\" / \"$2\" / \"$3}' /proc/loadavg 2>/dev/null; printf '\n'; printf '\n'; printf '\n'; printf 'processes='; ps -e --no-headers 2>/dev/null | wc -l; printf '\n'; printf '\n'; printf '\n'; printf 'active_processes='; ps -eo stat= 2>/dev/null | awk '$1 ~ /^R/ {n++} END {print n+0}'; printf '\n'; printf '\n'; printf '\n'; printf 'cpu_cores='; nproc 2>/dev/null || grep -c processor /proc/cpuinfo 2>/dev/null; printf '\n'; printf '\n'; printf '\n'; printf 'cpu_model='; awk -F: '/model name|Hardware|Processor/{gsub(/^ +/,\"\",$2); print $2; exit}' /proc/cpuinfo 2>/dev/null; printf '\n'; printf '\n'; printf '\n'; printf 'cpu_usage='; vmstat 1 2 2>/dev/null | tail -1 | awk '{print 100-$15}'; printf '\n'; printf '\n'; printf '\n'; printf 'memory='; if command -v free >/dev/null 2>&1; then free -b | awk '/^Mem:/ {print $2 \",\" $3}'; else awk '/MemTotal:/{t=$2} /MemAvailable:/{a=$2} END{print t*1024 \",\" (t-a)*1024}' /proc/meminfo; fi; printf '\n'; printf '\n'; printf '\n'; printf 'swap='; if command -v free >/dev/null 2>&1; then free -b | awk '/^Swap:/ {print $2 \",\" $3}'; else awk '/SwapTotal:/{t=$2} /SwapFree:/{f=$2} END{print t*1024 \",\" (t-f)*1024}' /proc/meminfo; fi; printf '\n'; printf '\n'; printf '\n'; printf 'disk='; df -B1 / 2>/dev/null | awk 'NR==2 {print $2 \",\" $3}'; printf '\n'; net2=$(net_bytes); disk2=$(disk_stats); printf '\n'; printf '\n'; printf 'network_rate='; awk -v a=\"$net1\" -v b=\"$net2\" 'BEGIN {split(a,x); split(b,y); print int(y[1]-x[1])\",\"int(y[2]-x[2])}' ; printf '\n'; printf '\n'; printf 'network_total='; echo \"$net2\" | awk '{print $1\",\"$2}'; printf '\n'; printf '\n'; printf 'disk_io_rate='; awk -v a=\"$disk1\" -v b=\"$disk2\" 'BEGIN {split(a,x); split(b,y); print int(y[1]-x[1])\",\"int(y[2]-x[2])\",\"int(y[3]-x[3]+y[4]-x[4])}' ; printf '\n'; printf '\n'; printf 'disk_io_total='; echo \"$disk2\" | awk '{print $1\",\"$2}'"#;
        channel.exec(true, command).await.map_err(|error| format!("读取服务器状态失败: {error}"))?;
        let mut output = Vec::new();
        while let Some(message) = channel.wait().await { if let ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } = message { output.extend_from_slice(&data); } }
        let _ = session.disconnect(russh::Disconnect::ByApplication, "Host health probe complete", "en").await;
        Ok::<(String, String), String>((fingerprint, String::from_utf8_lossy(&output).to_string()))
    }.await;
    let conn = open_db()?; let now = Utc::now().timestamp_millis();
    match attempt {
        Ok((fingerprint, output)) => {
            let values = output.lines().filter_map(|line| line.split_once('=')).map(|(key, value)| (key.trim(), value.trim())).collect::<HashMap<_, _>>();
            let metric_pair = |key: &str| values.get(key).and_then(|value| value.split_once(',')).map(|(total, used)| { let total = total.trim().parse::<u64>().unwrap_or(0); let used = used.trim().parse::<u64>().unwrap_or(0); if total == 0 { json!(null) } else { json!({"total": total, "used": used}) } }).unwrap_or_else(|| json!(null));
            let metric_value = |key: &str| values.get(key).and_then(|value| value.parse::<u64>().ok()).unwrap_or(0);
            let metric_at = |key: &str, index: usize| values.get(key).and_then(|value| value.split(',').nth(index)).and_then(|value| value.trim().parse::<u64>().ok()).unwrap_or(0);
            let metrics = json!({"hostname": values.get("hostname").copied().unwrap_or(""), "ip": values.get("ip").copied().unwrap_or(""), "os": values.get("os_name").or_else(|| values.get("os")).copied().unwrap_or(""), "kernel": values.get("os").copied().unwrap_or(""), "uptime": values.get("uptime").copied().unwrap_or(""), "load": values.get("load").copied().unwrap_or(""), "processes": metric_value("processes"), "active_processes": metric_value("active_processes"), "cpu": {"cores": metric_value("cpu_cores"), "model": values.get("cpu_model").copied().unwrap_or(""), "usage": values.get("cpu_usage").and_then(|value| value.parse::<f64>().ok()).unwrap_or(0.0)}, "memory": metric_pair("memory"), "swap": metric_pair("swap"), "disk": metric_pair("disk"), "network": {"up_rate": metric_at("network_rate", 0), "down_rate": metric_at("network_rate", 1), "up_total": metric_at("network_total", 0), "down_total": metric_at("network_total", 1)}, "disk_io": {"read": metric_at("disk_io_total", 0), "write": metric_at("disk_io_total", 1), "read_rate": metric_at("disk_io_rate", 0), "write_rate": metric_at("disk_io_rate", 1), "iops": metric_at("disk_io_rate", 2), "latency": 0}});
            managed_host_repository::mark_probe_success(&conn, id, &fingerprint, started.elapsed().as_millis() as i64, &serde_json::to_string(&metrics).map_err(|e| e.to_string())?, now)?;
        }
        Err(error) => {
            managed_host_repository::mark_probe_failure(&conn, id, &error, now)?;
        }
    }
    managed_host_repository::get(&conn, id)
}

fn normalize_panel_url(value: &str) -> Result<String, String> {
    let url = value.trim().trim_end_matches('/');
    if !(url.starts_with("http://") || url.starts_with("https://")) { return Err("面板 URL 必须以 http:// 或 https:// 开头".into()); }
    let host = &url[url.find("://").unwrap_or(0) + 3..];
    if host.is_empty() || host.contains('/') || host.contains('?') || host.contains('#') { return Err("请填写面板根地址，例如 https://192.168.1.2:8888".into()); }
    Ok(url.to_string())
}

fn panel_sign(api_key: &str) -> (String, String) {
    let request_time = Utc::now().timestamp().to_string();
    let api_key_md5 = format!("{:x}", Md5::digest(api_key.as_bytes()));
    let request_token = format!("{:x}", Md5::digest(format!("{request_time}{api_key_md5}").as_bytes()));
    (request_time, request_token)
}

async fn panel_api_request(panel_url: &str, api_key: &str, path: &str, allow_insecure_tls: bool) -> Result<Value, String> {
    let (request_time, request_token) = panel_sign(api_key);
    let mut data = BTreeMap::new(); data.insert("request_time", request_time); data.insert("request_token", request_token);
    let client = reqwest::Client::builder().danger_accept_invalid_certs(allow_insecure_tls).build().map_err(|error| format!("创建面板客户端失败: {error}"))?;
    let response = client.post(format!("{panel_url}{path}")).form(&data).timeout(std::time::Duration::from_secs(12)).send().await
        .map_err(|error| if !allow_insecure_tls && error.to_string().to_lowercase().contains("certificate") { "连接面板失败：HTTPS 证书不受信任。若这是确认可信的自签名面板，请勾选“允许不受信任 HTTPS 证书”后重试。".to_string() } else { format!("连接面板失败: {error}") })?;
    let status = response.status(); let text = response.text().await.map_err(|error| format!("读取面板响应失败: {error}"))?;
    let data: Value = serde_json::from_str(&text).map_err(|_| if status.is_success() { "面板未返回 JSON；请确认 URL、API 密钥及 API IP 白名单".to_string() } else { format!("面板请求失败：HTTP {status}") })?;
    if !status.is_success() || data.get("status").and_then(Value::as_bool) == Some(false) {
        return Err(data.get("msg").or_else(|| data.get("message")).and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("面板请求失败：HTTP {status}")));
    }
    Ok(data)
}

fn panel_field<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| value.get(*key))
}

fn panel_number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => {
            let mut token = String::new();
            let mut started = false;
            for character in text.chars() {
                if character.is_ascii_digit() || character == '.' || (character == '-' && !started) {
                    token.push(character);
                    started = true;
                } else if started {
                    break;
                }
            }
            token.parse().ok()
        }
        _ => None,
    }
}

fn panel_summary(data: &Value) -> Value {
    let load = data.get("load").or_else(|| data.get("load_average"));
    let load_value = |name: &str, index: usize| match load {
        Some(Value::Object(_)) => panel_number(load.and_then(|value| value.get(name))),
        Some(Value::Array(values)) => panel_number(values.get(index)),
        _ => None,
    };

    let cpu = data.get("cpu");
    let cpu_value = |keys: &[&str], index: usize| match cpu {
        Some(Value::Object(_)) => panel_number(cpu.and_then(|value| panel_field(value, keys))),
        Some(Value::Array(values)) => panel_number(values.get(index)),
        _ => None,
    };

    let memory = data.get("mem").or_else(|| data.get("memory"));
    let memory_used = memory.and_then(|value| panel_number(panel_field(value, &["memRealUsed", "used", "realUsed", "used_mb"])));
    let memory_total = memory.and_then(|value| panel_number(panel_field(value, &["memTotal", "total", "total_mb"])));
    let memory_percent = match (memory_used, memory_total) {
        (Some(used), Some(total)) if total > 0.0 => Some((used / total * 100.0).clamp(0.0, 100.0)),
        _ => None,
    };

    let disks = data.get("disk").and_then(Value::as_array).map(|items| items.iter().map(|item| {
        let disk_size = item.get("size").and_then(Value::as_array);
        let used = panel_field(item, &["used", "use"]).cloned().or_else(|| disk_size.and_then(|size| size.get(1).cloned()));
        let total = panel_field(item, &["total", "size_total"]).cloned().or_else(|| disk_size.and_then(|size| size.first().cloned()));
        let percent = panel_number(panel_field(item, &["used_percent", "percent", "usage"])).or_else(|| disk_size.and_then(|size| panel_number(size.get(3))));
        json!({
            "path": panel_field(item, &["path", "rname", "mount"]).cloned().unwrap_or(json!("")),
            "used": used,
            "total": total,
            "used_percent": percent
        })
    }).collect::<Vec<_>>()).unwrap_or_default();
    let disk = disks.iter().find(|item| item.get("path").and_then(Value::as_str) == Some("/")).cloned().or_else(|| disks.first().cloned()).unwrap_or(json!({}));

    let network = data.get("network");
    let network_up = panel_number(data.get("up")).or_else(|| network.and_then(|value| panel_number(panel_field(value, &["up", "upload"]))));
    let network_down = panel_number(data.get("down")).or_else(|| network.and_then(|value| panel_number(panel_field(value, &["down", "download"]))));

    json!({
        "title": data.get("title").or_else(|| data.get("hostname")).cloned().unwrap_or(json!("")),
        "version": data.get("version").or_else(|| data.get("panel_version")).cloned().unwrap_or(json!("")),
        "load": { "one": load_value("one", 0), "five": load_value("five", 1), "fifteen": load_value("fifteen", 2) },
        "network": { "up": network_up, "down": network_down, "unit": "KB/s" },
        "cpu": { "used_percent": cpu_value(&["used_percent", "usage", "used", "cpuRealUsed"], 0), "cores": cpu_value(&["cores", "cpuNum", "count"], 1) },
        "mem": { "used": memory_used, "total": memory_total, "used_percent": memory_percent, "unit": "MB" },
        "disk": {
            "path": disk.get("path").cloned().unwrap_or(json!("")),
            "used": disk.get("used").cloned(),
            "total": disk.get("total").cloned(),
            "used_percent": disk.get("used_percent").cloned(),
            "volumes": disks
        }
    })
}

fn load_panel_connection(id: i64) -> Result<(PanelConnection, String), String> {
    let (panel, ciphertext) = panel_repository::load_with_secret(&open_db()?, id)?;
    Ok((panel, decrypt_secret(&ciphertext)?))
}

#[tauri::command]
async fn save_panel_connection(input: PanelConnectionInput) -> Result<PanelConnection, String> {
    let name = input.name.trim(); let panel_url = normalize_panel_url(&input.panel_url)?;
    if name.is_empty() { return Err("请填写面板名称".into()); }
    let existing = input.id.map(|id| panel_repository::existing_api_key(&open_db()?, id)).transpose()?.flatten();
    let api_key_ciphertext = match input.api_key.as_deref().map(str::trim).filter(|value| !value.is_empty()) { Some(key) => encrypt_secret(key)?, None => existing.ok_or_else(|| "首次绑定需要填写面板 API 密钥".to_string())? };
    let api_key = decrypt_secret(&api_key_ciphertext)?;
    let data = panel_api_request(&panel_url, &api_key, "/system?action=GetNetWork", input.allow_insecure_tls).await?;
    let summary = panel_summary(&data); let now = Utc::now().timestamp_millis(); let conn = open_db()?;
    panel_repository::save(&conn, &input, name, &panel_url, &api_key_ciphertext, &serde_json::to_string(&summary).map_err(|e| e.to_string())?, now)
}

#[tauri::command]
async fn refresh_panel_connection(id: i64) -> Result<PanelConnection, String> {
    let (panel, api_key) = load_panel_connection(id)?; let now = Utc::now().timestamp_millis(); let result = panel_api_request(&panel.panel_url, &api_key, "/system?action=GetNetWork", panel.allow_insecure_tls).await;
    let conn = open_db()?;
    match result { Ok(data) => {
            panel_repository::mark_refresh_success(&conn, id, &serde_json::to_string(&panel_summary(&data)).map_err(|e| e.to_string())?, now)?;
        }
        Err(error) => { panel_repository::mark_refresh_failure(&conn, id, &error, now)?; }
    }
    panel_repository::get(&conn, id)
}

#[tauri::command]
async fn panel_temporary_login(id: i64) -> Result<String, String> {
    let (panel, api_key) = load_panel_connection(id)?; let data = panel_api_request(&panel.panel_url, &api_key, "/config?action=get_tmp_token", panel.allow_insecure_tls).await?;
    let token = data.get("msg").or_else(|| data.get("token")).and_then(Value::as_str).filter(|value| !value.is_empty()).ok_or("面板未返回临时登录令牌")?;
    Ok(format!("{}/login?tmp_token={}", panel.panel_url, token))
}

#[tauri::command]
fn export_panel_connections_file(panel_ids: Option<Vec<i64>>) -> Result<String, String> {
    let conn = open_db()?;
    let selected_ids = panel_ids.filter(|ids| !ids.is_empty());
    let rows = panel_repository::export_rows(&conn)?;
    let mut panels = Vec::new();
    for row in rows {
        if selected_ids.as_ref().is_some_and(|ids| !ids.contains(&row.id)) { continue; }
        panels.push(ExportPanelConnection { name: row.name, panel_url: row.panel_url, sort_order: row.sort_order, api_key: decrypt_secret(&row.ciphertext)?, allow_insecure_tls: row.allow_insecure_tls, group_name: row.group_name, source_account_id: row.source_account_id, source_asset_key: row.source_asset_key, remark: row.remark });
    }
    if panels.is_empty() { return Err("未找到选择的面板".into()); }
    let base = dirs::home_dir().unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let desktop = base.join("Desktop");
    let dir = if desktop.exists() { desktop } else { base };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("cloudhub-tools-panels-{}.json", Utc::now().format("%Y%m%d-%H%M%S")));
    let payload = json!({
        "format": "cloudhub-tools-panel-export",
        "version": 1,
        "encryption": "plaintext",
        "api_key_exported": true,
        "exported_at": Utc::now().to_rfc3339(),
        "panels": panels,
    });
    std::fs::write(&path, serde_json::to_vec_pretty(&payload).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn import_panel_connections(panels: Vec<ImportPanelConnection>) -> Result<usize, String> {
    if panels.is_empty() { return Err("导入文件中没有面板配置".into()); }
    let conn = open_db()?;
    let now = Utc::now().timestamp_millis();
    let mut imported = 0usize;
    for (index, panel) in panels.into_iter().enumerate() {
        let name = panel.name.trim();
        let panel_url = normalize_panel_url(&panel.panel_url)?;
        if name.is_empty() || panel.api_key.trim().is_empty() { return Err(format!("第 {} 条面板缺少名称或 API 密钥", index + 1)); }
        let ciphertext = encrypt_secret(panel.api_key.trim())?;
        let existing_id = panel_repository::id_by_url(&conn, &panel_url)?;
        match existing_id {
            Some(id) => panel_repository::import_update(&conn, id, name, &ciphertext, panel.sort_order.unwrap_or(0).max(0), panel.allow_insecure_tls.unwrap_or(false), panel.group_name.as_deref(), panel.source_account_id, panel.source_asset_key.as_deref(), panel.remark.as_deref(), now)?,
            None => panel_repository::import_insert(&conn, name, &panel_url, &ciphertext, panel.sort_order.unwrap_or(0).max(0), panel.allow_insecure_tls.unwrap_or(false), panel.group_name.as_deref(), panel.source_account_id, panel.source_asset_key.as_deref(), panel.remark.as_deref(), now)?,
        };
        imported += 1;
    }
    Ok(imported)
}

#[tauri::command]
fn export_managed_hosts_file() -> Result<String, String> {
    let conn = open_db()?;
    let rows = managed_host_repository::export_rows(&conn)?;
    let mut hosts = Vec::new();
    for row in rows {
        let decrypt_optional = |value: Option<String>| value.filter(|item| !item.is_empty()).map(|item| decrypt_secret(&item)).transpose();
        hosts.push(ExportManagedHost { name: row.name, host: row.host, port: row.port, username: row.username, platform: row.platform, auth_method: row.auth_method, password: decrypt_optional(row.password_ciphertext)?, private_key: decrypt_optional(row.private_key_ciphertext)?, key_passphrase: decrypt_optional(row.key_passphrase_ciphertext)?, group_name: row.group_name, tags: row.tags, source_account_id: row.source_account_id, source_asset_key: row.source_asset_key, remark: row.remark });
    }
    if hosts.is_empty() { return Err("没有可导出的服务器".into()); }
    let base = dirs::home_dir().unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let desktop = base.join("Desktop");
    let dir = if desktop.exists() { desktop } else { base };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("cloudhub-tools-terminal-hosts-{}.json", Utc::now().format("%Y%m%d-%H%M%S")));
    let payload = json!({
        "format": "cloudhub-tools-managed-host-export",
        "version": 1,
        "encryption": "plaintext",
        "credentials_exported": true,
        "exported_at": Utc::now().to_rfc3339(),
        "hosts": hosts,
    });
    std::fs::write(&path, serde_json::to_vec_pretty(&payload).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn import_managed_hosts(hosts: Vec<ImportManagedHost>) -> Result<usize, String> {
    if hosts.is_empty() { return Err("导入文件中没有服务器配置".into()); }
    let conn = open_db()?;
    let now = Utc::now().timestamp_millis();
    let mut imported = 0usize;
    for (index, host) in hosts.into_iter().enumerate() {
        let name = host.name.trim();
        let address = host.host.trim();
        let username = host.username.trim();
        let platform = host.platform.as_deref().unwrap_or("linux");
        if !matches!(platform, "linux" | "windows") { return Err(format!("第 {} 条服务器的操作系统类型不支持", index + 1)); }
        let auth_method = if platform == "linux" { host.auth_method.as_deref().unwrap_or("password") } else { "password" };
        if !matches!(auth_method, "password" | "private_key") { return Err(format!("第 {} 条服务器的 Linux 验证方式不支持", index + 1)); }
        if name.is_empty() || address.is_empty() || username.is_empty() { return Err(format!("第 {} 条服务器缺少名称、主机地址或用户名", index + 1)); }
        let port = host.port.unwrap_or(if platform == "windows" { 3389 } else { 22 }).max(1);
        let password = host.password.as_deref().map(str::trim).filter(|value| !value.is_empty());
        let private_key = host.private_key.as_deref().map(str::trim).filter(|value| !value.is_empty());
        if platform == "linux" && auth_method == "password" && password.is_none() { return Err(format!("第 {} 条 Linux 服务器缺少 SSH 密码", index + 1)); }
        if platform == "linux" && auth_method == "private_key" && private_key.is_none() { return Err(format!("第 {} 条 Linux 服务器缺少 SSH 私钥", index + 1)); }
        let password_ciphertext = if auth_method == "private_key" { String::new() } else { password.map(encrypt_secret).transpose()?.unwrap_or_default() };
        let private_key_ciphertext = if auth_method == "private_key" { private_key.map(encrypt_secret).transpose()? } else { None };
        let key_passphrase_ciphertext = if auth_method == "private_key" { host.key_passphrase.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(encrypt_secret).transpose()? } else { None };
        let existing_id = managed_host_repository::id_by_endpoint(&conn, address, port, username)?;
        match existing_id {
            Some(id) => managed_host_repository::import_update(&conn, id, name, platform, auth_method, &password_ciphertext, private_key_ciphertext.as_deref(), key_passphrase_ciphertext.as_deref(), host.group_name.as_deref(), host.tags.as_deref(), host.source_account_id, host.source_asset_key.as_deref(), host.remark.as_deref(), now)?,
            None => managed_host_repository::import_insert(&conn, name, address, port, username, platform, auth_method, &password_ciphertext, private_key_ciphertext.as_deref(), key_passphrase_ciphertext.as_deref(), host.group_name.as_deref(), host.tags.as_deref(), host.source_account_id, host.source_asset_key.as_deref(), host.remark.as_deref(), now)?,
        };
        imported += 1;
    }
    Ok(imported)
}

fn ssh_saved_connection(account_id: i64, asset_key: &str) -> Result<Option<SavedSshCredentials>, String> {
    connection_repository::ssh_saved(&open_db()?, account_id, asset_key)
}

fn ssh_credentials(input: &SshConnectInput, saved: &Option<SavedSshCredentials>) -> Result<SshCredentials, String> {
    if input.auth_method.as_deref() == Some("private_key") {
        let key = input.private_key.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(str::to_string)
            .or_else(|| saved.as_ref().and_then(|value| value.private_key_ciphertext.as_deref()).filter(|value| !value.is_empty()).map(decrypt_secret).transpose().ok().flatten())
            .ok_or("请粘贴 SSH 私钥，或使用已保存私钥连接")?;
        let passphrase = input.key_passphrase.as_deref().filter(|value| !value.is_empty()).map(str::to_string)
            .or_else(|| saved.as_ref().and_then(|value| value.key_passphrase_ciphertext.as_deref()).filter(|value| !value.is_empty()).map(decrypt_secret).transpose().ok().flatten());
        return Ok(SshCredentials::PrivateKey { key, passphrase });
    }
    input.password.as_deref().filter(|value| !value.is_empty()).map(str::to_owned)
        .or_else(|| saved.as_ref().and_then(|value| value.password_ciphertext.as_deref()).filter(|value| !value.is_empty()).map(decrypt_secret).transpose().ok().flatten())
        .map(SshCredentials::Password)
        .ok_or("请输入 SSH 密码，或使用已保存的密码连接".into())
}

async fn authenticate_ssh(session: &mut client::Handle<SshHostKeyHandler>, username: &str, credentials: &SshCredentials, context: &str) -> Result<(), String> {
    let authenticated = match credentials {
        SshCredentials::Password(password) => session.authenticate_password(username.to_string(), password.clone()).await
            .map_err(|error| format!("{context} SSH 身份验证失败: {error}"))?.success(),
        SshCredentials::PrivateKey { key, passphrase } => {
            let key = decode_secret_key(key, passphrase.as_deref()).map_err(|error| format!("读取 SSH 私钥失败: {error}"))?;
            let hash = session.best_supported_rsa_hash().await.map_err(|error| format!("读取 SSH 密钥算法失败: {error}"))?.flatten();
            session.authenticate_publickey(username.to_string(), PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await
                .map_err(|error| format!("{context} SSH 私钥验证失败: {error}"))?.success()
        }
    };
    if authenticated { Ok(()) } else { Err(format!("{context} SSH 身份验证失败，请检查认证信息")) }
}

fn save_ssh_connection(input: &SshConnectInput, password_ciphertext: Option<&str>, fingerprint: &str) -> Result<(), String> {
    connection_repository::save_ssh(&open_db()?, input, password_ciphertext, fingerprint, Utc::now().timestamp_millis())
}

fn managed_host_name_for_asset(conn: &Connection, account_id: i64, asset_key: &str) -> Result<(String, Option<String>), String> {
    asset_repository::name_for_asset(conn, account_id, asset_key)
}

fn save_managed_host_from_ssh(input: &SshConnectInput, password_ciphertext: &str, fingerprint: &str) -> Result<(), String> {
    let account_id = input.account_id.ok_or("缺少云账号标识")?;
    let asset_key = input.asset_key.as_deref().map(str::trim).filter(|value| !value.is_empty()).ok_or("缺少资产标识")?;
    let conn = open_db()?;
    let now = Utc::now().timestamp_millis();
    let existing_id = managed_host_repository::source_id(&conn, account_id, asset_key)?;
    if let Some(id) = existing_id {
        managed_host_repository::update_from_ssh(&conn, id, input.host.trim(), input.port.max(1), input.username.trim(), password_ciphertext, fingerprint, now)?;
        return Ok(());
    }
    let (name, group_name) = managed_host_name_for_asset(&conn, account_id, asset_key)?;
    managed_host_repository::insert_from_ssh(&conn, &name, input.host.trim(), input.port.max(1), input.username.trim(), password_ciphertext, group_name.as_deref(), account_id, asset_key, fingerprint, now)?;
    Ok(())
}

#[tauri::command]
fn launch_managed_host_rdp(id: i64) -> Result<(), String> {
    let saved = managed_host_saved_connection(id)?.ok_or("服务器不存在")?;
    if saved.platform != "windows" { return Err("当前服务器不是 Windows / RDP 类型".into()); }
    launch_rdp_connection(RdpConnectionInput {
        target_key: format!("managed-host:{id}"),
        host: saved.host,
        port: saved.port,
        username: saved.username,
        password: saved.password_ciphertext.as_deref().filter(|value| !value.is_empty()).map(decrypt_secret).transpose()?,
        save_password: false,
    })
}

#[tauri::command]
fn reveal_ssh_password(account_id: Option<i64>, asset_key: Option<String>, managed_host_id: Option<i64>) -> Result<String, String> {
    let ciphertext: Option<String> = if let Some(id) = managed_host_id {
        managed_host_repository::password_ciphertext(&open_db()?, id)?
    } else {
        let account_id = account_id.ok_or("缺少云账号标识")?;
        let asset_key = asset_key.filter(|value| !value.trim().is_empty()).ok_or("缺少服务器标识")?;
        connection_repository::ssh_password_ciphertext(&open_db()?, account_id, &asset_key)?
    };
    let ciphertext = ciphertext.ok_or("当前没有保存 SSH 密码")?;
    decrypt_secret(&ciphertext)
}

#[tauri::command]
fn reveal_rdp_password(target_key: String) -> Result<String, String> {
    let ciphertext = connection_repository::rdp_password_ciphertext(&open_db()?, &target_key)?.ok_or("未保存 RDP 密码")?;
    decrypt_secret(&ciphertext)
}

fn save_rdp_connection(input: &RdpConnectionInput) -> Result<(), String> {
    let target_key = input.target_key.trim();
    let host = input.host.trim();
    let username = input.username.trim();
    if target_key.is_empty() || host.is_empty() || username.is_empty() { return Err("请填写 RDP 主机和用户名".into()); }
    let conn = open_db()?;
    let existing_secret = connection_repository::rdp_password_ciphertext(&conn, target_key)?;
    let secret = input.password.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(encrypt_secret).transpose()?.or(existing_secret);
    connection_repository::save_rdp(&conn, target_key, host, input.port.max(1), username, secret.as_deref(), Utc::now().timestamp_millis())
}

fn rdp_connection_password(input: &RdpConnectionInput) -> Result<Option<String>, String> {
    if let Some(password) = input.password.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        return Ok(Some(password.to_string()));
    }
    let target_key = input.target_key.trim();
    if target_key.is_empty() { return Ok(None); }
    let ciphertext = connection_repository::rdp_password_ciphertext(&open_db()?, target_key)?;
    ciphertext.as_deref().filter(|value| !value.is_empty()).map(decrypt_secret).transpose()
}

#[tauri::command]
fn launch_rdp_connection(input: RdpConnectionInput) -> Result<(), String> {
    let host = input.host.trim();
    let username = input.username.trim();
    if host.is_empty() || username.is_empty() { return Err("请填写 RDP 主机和用户名".into()); }
    if input.save_password { save_rdp_connection(&input)?; }
    #[cfg(target_os = "windows")]
    {
        let address = if input.port == 3389 { host.to_string() } else { format!("{host}:{}", input.port) };
        let password = rdp_connection_password(&input)?;
        if let Some(password) = password.as_deref() {
            let credential_target = format!("TERMSRV/{host}");
            let status = Command::new("cmdkey.exe")
                .arg(format!("/generic:{credential_target}"))
                .arg(format!("/user:{username}"))
                .arg(format!("/pass:{password}"))
                .status()
                .map_err(|e| format!("无法保存 Windows RDP 凭据: {e}"))?;
            if !status.success() { return Err("Windows RDP 凭据保存失败".into()); }
        }
        let path = std::env::temp_dir().join(format!("cloudhub-tools-rdp-{}.rdp", Uuid::new_v4()));
        let prompt_for_credentials = if password.is_some() { 0 } else { 1 };
        let content = format!("full address:s:{address}\r\nusername:s:{username}\r\nprompt for credentials:i:{prompt_for_credentials}\r\nauthentication level:i:2\r\nredirectclipboard:i:1\r\n");
        fs::write(&path, content).map_err(|e| format!("创建 RDP 配置失败: {e}"))?;
        Command::new("mstsc.exe").arg(&path).spawn().map_err(|e| format!("无法启动 Windows 远程桌面: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = input;
        Err("RDP 连接仅支持 Windows 桌面客户端".into())
    }
}

#[tauri::command]
async fn ssh_connect(store: tauri::State<'_, SshTerminalStore>, input: SshConnectInput) -> Result<SshConnectResult, String> {
    let host = input.host.trim().to_string();
    let username = input.username.trim().to_string();
    let asset_key = input.asset_key.as_deref().unwrap_or_default().trim().to_string();
    if host.is_empty() || username.is_empty() || (input.managed_host_id.is_none() && !input.direct.unwrap_or(false) && (input.account_id.is_none() || asset_key.is_empty())) { return Err("请填写 SSH 主机、用户名和服务器标识".into()); }
    let port = if input.port == 0 { 22 } else { input.port };
    let saved = match input.managed_host_id {
        Some(id) => managed_host_saved_connection(id)?,
        None if input.direct.unwrap_or(false) => None,
        None => ssh_saved_connection(input.account_id.ok_or("缺少云账号标识")?, &asset_key)?,
    };
    let credentials = ssh_credentials(&input, &saved)?;
    let observed_fingerprint = Arc::new(Mutex::new(None));
    let handler = SshHostKeyHandler {
        expected_fingerprint: saved.as_ref().and_then(|value| value.host_key_fingerprint.clone()),
        observed_fingerprint: observed_fingerprint.clone(),
    };
    let config = Arc::new(client::Config::default());
    let mut session = client::connect(config, (host.clone(), port), handler).await
        .map_err(|error| {
            if observed_fingerprint.lock().ok().and_then(|value| value.clone()).is_some() {
                "SSH 主机密钥与已保存记录不一致，已拒绝连接。请确认服务器变更后清除本地 SSH 配置再重试。".to_string()
            } else { format!("连接 SSH 主机失败: {error}") }
        })?;
    let fingerprint = observed_fingerprint.lock().map_err(|_| "SSH 主机密钥状态不可用".to_string())?.clone().ok_or("无法读取 SSH 主机密钥")?;
    authenticate_ssh(&mut session, &username, &credentials, "").await?;
    let channel = session.channel_open_session().await.map_err(|error| format!("打开 SSH 终端失败: {error}"))?;
    let (mut reader, writer) = channel.split();
    writer.request_pty(true, "xterm-256color", input.cols.unwrap_or(100).max(20), input.rows.unwrap_or(28).max(8), 0, 0, &[])
        .await.map_err(|error| format!("初始化 SSH 终端失败: {error}"))?;
    writer.request_shell(true).await.map_err(|error| format!("启动 SSH Shell 失败: {error}"))?;
    let (output_sender, output_receiver) = mpsc::channel();
    let (command_sender, mut command_receiver) = tokio::sync::mpsc::unbounded_channel();
    tauri::async_runtime::spawn(async move {
        let writer = writer;
        loop {
            tokio::select! {
                command = command_receiver.recv() => match command {
                    Some(SshCommand::Data(data)) => {
                        if let Err(error) = writer.data_bytes(bytes::Bytes::from(data)).await {
                            let _ = output_sender.send(format!("\r\n[SSH 写入失败：{error}]\r\n"));
                            break;
                        }
                    }
                    Some(SshCommand::Resize(cols, rows)) => {
                        if let Err(error) = writer.window_change(cols.max(20), rows.max(8), 0, 0).await {
                            let _ = output_sender.send(format!("\r\n[SSH 终端尺寸更新失败：{error}]\r\n"));
                        }
                    }
                    Some(SshCommand::Disconnect) | None => break,
                },
                message = reader.wait() => match message {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let _ = output_sender.send(String::from_utf8_lossy(&data).to_string());
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {},
                }
            }
        }
        let _ = writer.close().await;
        let _ = session.disconnect(russh::Disconnect::ByApplication, "Local SSH client closed", "en").await;
    });
    let managed_password = if let SshCredentials::Password(password) = &credentials { Some(encrypt_secret(password)?) } else { None };
    let persisted = if input.save_password { managed_password.clone() } else { None };
    let mut persisted_input = input;
    persisted_input.host = host;
    persisted_input.username = username;
    persisted_input.asset_key = Some(asset_key);
    persisted_input.port = port;
    if persisted_input.direct.unwrap_or(false) {
        // Quick connections are intentionally ephemeral and never enter the cloud asset database.
    } else if let Some(managed_host_id) = persisted_input.managed_host_id {
        managed_host_repository::mark_ssh_online(&open_db()?, managed_host_id, &persisted_input.host, port, &persisted_input.username, persisted.as_deref(), &fingerprint, Utc::now().timestamp_millis())?;
    } else {
        save_ssh_connection(&persisted_input, persisted.as_deref(), &fingerprint)?;
        if let Some(password_ciphertext) = managed_password.as_deref() {
            save_managed_host_from_ssh(&persisted_input, password_ciphertext, &fingerprint)?;
        }
    }
    let session_id = Uuid::new_v4().to_string();
    let profile = SshConnectionProfile { host: persisted_input.host.clone(), port, username: persisted_input.username.clone(), credentials, fingerprint: fingerprint.clone() };
    store.terminals.lock().map_err(|_| "SSH 终端状态不可用".to_string())?.insert(session_id.clone(), SshTerminal { commands: command_sender, output: output_receiver, profile });
    Ok(SshConnectResult { session_id, host_key_fingerprint: fingerprint })
}

#[tauri::command]
async fn ssh_test_connection(input: SshConnectInput) -> Result<(), String> {
    let host = input.host.trim().to_string();
    let username = input.username.trim().to_string();
    let asset_key = input.asset_key.as_deref().unwrap_or_default().trim().to_string();
    if host.is_empty() || username.is_empty() || (input.managed_host_id.is_none() && !input.direct.unwrap_or(false) && (input.account_id.is_none() || asset_key.is_empty())) { return Err("请填写 SSH 主机、用户名和服务器标识".into()); }
    let port = if input.port == 0 { 22 } else { input.port };
    let saved = match input.managed_host_id {
        Some(id) => managed_host_saved_connection(id)?,
        None if input.direct.unwrap_or(false) => None,
        None => ssh_saved_connection(input.account_id.ok_or("缺少云账号标识")?, &asset_key)?,
    };
    let credentials = ssh_credentials(&input, &saved)?;
    let observed_fingerprint = Arc::new(Mutex::new(None));
    let handler = SshHostKeyHandler { expected_fingerprint: saved.as_ref().and_then(|value| value.host_key_fingerprint.clone()), observed_fingerprint: observed_fingerprint.clone() };
    let config = Arc::new(client::Config::default());
    let mut session = client::connect(config, (host.as_str(), port), handler).await.map_err(|error| format!("连接 SSH 主机失败: {error}"))?;
    authenticate_ssh(&mut session, &username, &credentials, "测试").await?;
    session.disconnect(russh::Disconnect::ByApplication, "SSH connection test completed", "en").await.map_err(|error| format!("关闭测试连接失败: {error}"))?;
    Ok(())
}

fn shell_quote(value: &str) -> String { format!("'{}'", value.replace('\'', "'\"'\"'")) }

fn ssh_file_profile(store: &tauri::State<'_, SshTerminalStore>, session_id: &str) -> Result<SshConnectionProfile, String> {
    store.terminals.lock().map_err(|_| "SSH 终端状态不可用".to_string())?.get(session_id).map(|terminal| terminal.profile.clone()).ok_or_else(|| "SSH 会话已关闭".into())
}

async fn ssh_exec(profile: SshConnectionProfile, command: &str, stdin: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
    let observed_fingerprint = Arc::new(Mutex::new(None));
    let handler = SshHostKeyHandler { expected_fingerprint: Some(profile.fingerprint.clone()), observed_fingerprint };
    let config = Arc::new(client::Config::default());
    let mut session = client::connect(config, (profile.host.as_str(), profile.port), handler).await.map_err(|error| format!("文件管理连接 SSH 主机失败: {error}"))?;
    authenticate_ssh(&mut session, &profile.username, &profile.credentials, "文件管理").await?;
    let mut channel = session.channel_open_session().await.map_err(|error| format!("打开文件管理通道失败: {error}"))?;
    channel.exec(true, command).await.map_err(|error| format!("执行远程文件操作失败: {error}"))?;
    if let Some(data) = stdin { channel.data_bytes(bytes::Bytes::from(data)).await.map_err(|error| format!("上传文件失败: {error}"))?; channel.eof().await.map_err(|error| format!("结束上传失败: {error}"))?; }
    let mut output = Vec::new(); let mut exit_status = None;
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => output.extend_from_slice(&data),
            ChannelMsg::ExitStatus { exit_status: status } => exit_status = Some(status),
            _ => {}
        }
    }
    let _ = session.disconnect(russh::Disconnect::ByApplication, "SSH file manager closed", "en").await;
    if exit_status.unwrap_or(1) != 0 { return Err(String::from_utf8_lossy(&output).trim().to_string().if_empty("远程文件操作失败")); }
    Ok(output)
}

trait EmptyFallback { fn if_empty(self, fallback: &str) -> String; }
impl EmptyFallback for String { fn if_empty(self, fallback: &str) -> String { if self.is_empty() { fallback.into() } else { self } } }

fn remote_join(parent: &str, name: &str) -> String { if parent == "/" { format!("/{name}") } else { format!("{}/{}", parent.trim_end_matches('/'), name) } }

#[tauri::command]
async fn ssh_list_files(store: tauri::State<'_, SshTerminalStore>, session_id: String, path: String) -> Result<SshDirectoryListing, String> {
    let profile = ssh_file_profile(&store, &session_id)?; let requested = if path.trim().is_empty() { "/" } else { path.trim() };
    let command = format!("cd -- {} && printf '%s\\n' \"$PWD\" && find -L . -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%m\\t%u\\t%g\\t%TY-%Tm-%Td %TH:%TM\\t%f\\0' | sort -z", shell_quote(requested));
    let output = ssh_exec(profile, &command, None).await?; let newline = output.iter().position(|byte| *byte == b'\n').ok_or("远程目录返回格式错误")?;
    let resolved = String::from_utf8_lossy(&output[..newline]).trim().to_string(); if resolved.is_empty() { return Err("远程目录路径为空".into()); }
    let entries = String::from_utf8_lossy(&output[newline + 1..]).split('\0').filter(|row| !row.is_empty()).filter_map(|row| {
        let mut columns = row.splitn(7, '\t'); let kind = columns.next()?; let size = columns.next()?.parse::<u64>().unwrap_or(0); let mode = columns.next()?.to_string(); let owner = columns.next()?.to_string(); let group = columns.next()?.to_string(); let modified = columns.next()?.to_string(); let name = columns.next()?.to_string();
        if name.is_empty() { return None; } Some(SshFileEntry { path: remote_join(&resolved, &name), is_dir: kind == "d", is_file: kind == "f", name, size, mode, owner, group, modified })
    }).collect::<Vec<_>>();
    Ok(SshDirectoryListing { path: resolved, entries })
}

#[tauri::command]
async fn ssh_read_text_file(store: tauri::State<'_, SshTerminalStore>, session_id: String, path: String) -> Result<String, String> {
    let profile = ssh_file_profile(&store, &session_id)?; let path = path.trim(); if path.is_empty() { return Err("请选择文件".into()); }
    let quoted = shell_quote(path); let command = format!("if [ -f {quoted} ] && [ \"$(wc -c < {quoted})\" -le 1048576 ]; then base64 -w 0 -- {quoted}; else echo '文件不存在、不是普通文件或超过 1 MB' >&2; exit 2; fi");
    let encoded = ssh_exec(profile, &command, None).await?; let bytes = B64.decode(encoded.iter().filter(|byte| !byte.is_ascii_whitespace()).copied().collect::<Vec<_>>()).map_err(|_| "远程文件内容无法解码".to_string())?;
    String::from_utf8(bytes).map_err(|_| "该文件不是 UTF-8 文本，暂不支持在线编辑；可下载到本机查看".into())
}

#[tauri::command]
async fn ssh_write_text_file(store: tauri::State<'_, SshTerminalStore>, session_id: String, path: String, content: String) -> Result<(), String> {
    if content.as_bytes().len() > 1_048_576 { return Err("在线保存仅支持 1 MB 以内文本文件".into()); }
    let profile = ssh_file_profile(&store, &session_id)?; let path = path.trim(); if path.is_empty() { return Err("请选择文件".into()); }
    ssh_exec(profile, &format!("cat > {}", shell_quote(path)), Some(content.into_bytes())).await?; Ok(())
}

#[tauri::command]
async fn ssh_upload_file(store: tauri::State<'_, SshTerminalStore>, session_id: String, path: String, content_base64: String) -> Result<(), String> {
    let bytes = B64.decode(content_base64).map_err(|_| "本地文件数据无效".to_string())?; if bytes.len() > 20 * 1024 * 1024 { return Err("单次上传暂限 20 MB".into()); }
    let profile = ssh_file_profile(&store, &session_id)?; let path = path.trim(); if path.is_empty() { return Err("请选择上传目录".into()); }
    ssh_exec(profile, &format!("cat > {}", shell_quote(path)), Some(bytes)).await?; Ok(())
}

#[tauri::command]
async fn ssh_download_file(store: tauri::State<'_, SshTerminalStore>, session_id: String, path: String) -> Result<String, String> {
    let profile = ssh_file_profile(&store, &session_id)?; let path = path.trim(); if path.is_empty() { return Err("请选择文件".into()); }
    let bytes = ssh_exec(profile, &format!("if [ -f {} ]; then cat -- {}; else echo '文件不存在或不是普通文件' >&2; exit 2; fi", shell_quote(path), shell_quote(path)), None).await?; if bytes.len() > 50 * 1024 * 1024 { return Err("单次下载暂限 50 MB".into()); }
    let filename = path.rsplit('/').next().filter(|name| !name.is_empty()).unwrap_or("download").replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_"); let directory = dirs::download_dir().unwrap_or_else(|| std::env::temp_dir()).join("CloudHub Tools"); fs::create_dir_all(&directory).map_err(|error| format!("创建下载目录失败: {error}"))?; let target = directory.join(&filename); fs::write(&target, bytes).map_err(|error| format!("保存下载文件失败: {error}"))?; Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
async fn ssh_make_directory(store: tauri::State<'_, SshTerminalStore>, session_id: String, path: String) -> Result<(), String> { let profile = ssh_file_profile(&store, &session_id)?; let path = path.trim(); if path.is_empty() || path == "/" { return Err("请填写新建文件夹名称".into()); } ssh_exec(profile, &format!("mkdir -- {}", shell_quote(path)), None).await?; Ok(()) }

#[tauri::command]
async fn ssh_delete_path(store: tauri::State<'_, SshTerminalStore>, session_id: String, path: String) -> Result<(), String> { let profile = ssh_file_profile(&store, &session_id)?; let path = path.trim(); if path.is_empty() || path == "/" { return Err("不能删除根目录".into()); } ssh_exec(profile, &format!("rm -rf -- {}", shell_quote(path)), None).await?; Ok(()) }

#[tauri::command]
fn ssh_read(store: tauri::State<'_, SshTerminalStore>, session_id: String) -> Result<String, String> {
    let mut terminals = store.terminals.lock().map_err(|_| "SSH 终端状态不可用".to_string())?;
    let terminal = terminals.get_mut(&session_id).ok_or("SSH 会话已关闭")?;
    Ok(terminal.output.try_iter().collect())
}

#[tauri::command]
fn ssh_write(store: tauri::State<'_, SshTerminalStore>, session_id: String, data: String) -> Result<(), String> {
    let mut terminals = store.terminals.lock().map_err(|_| "SSH 终端状态不可用".to_string())?;
    let terminal = terminals.get_mut(&session_id).ok_or("SSH 会话已关闭")?;
    terminal.commands.send(SshCommand::Data(data)).map_err(|_| "SSH 会话已关闭".to_string())
}

#[tauri::command]
fn ssh_resize(store: tauri::State<'_, SshTerminalStore>, session_id: String, cols: u32, rows: u32) -> Result<(), String> {
    let mut terminals = store.terminals.lock().map_err(|_| "SSH 终端状态不可用".to_string())?;
    let terminal = terminals.get_mut(&session_id).ok_or("SSH 会话已关闭")?;
    terminal.commands.send(SshCommand::Resize(cols, rows)).map_err(|_| "SSH 会话已关闭".to_string())
}

#[tauri::command]
fn ssh_disconnect(store: tauri::State<'_, SshTerminalStore>, session_id: String) -> Result<(), String> {
    let mut terminals = store.terminals.lock().map_err(|_| "SSH 终端状态不可用".to_string())?;
    if let Some(terminal) = terminals.remove(&session_id) {
        let _ = terminal.commands.send(SshCommand::Disconnect);
    }
    Ok(())
}

fn asset_key(resource_type: &str, item: &Value, index: usize) -> String {
    for key in ["InstanceId", "DBInstanceId", "KVStoreInstanceId", "AssetId", "SiteId", "DomainName", "Name", "BucketName", "Id", "id"] {
        if let Some(value) = item.get(key).and_then(Value::as_str).filter(|v| !v.is_empty()) { return value.to_string(); }
        if let Some(value) = item.get(key).and_then(Value::as_i64) { return value.to_string(); }
    }
    format!("{resource_type}-{index}")
}

#[tauri::command]
async fn sync_cloud_assets(id: i64, resource_types: Vec<String>) -> Result<AssetSyncResult, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let cloud_type = account_cloud_type(id)?;
    if cloud_type != "aliyun" && cloud_type != "tencent" && cloud_type != "volcengine" && cloud_type != "ctyun" && cloud_type != "oracle" && cloud_type != "huawei" && cloud_type != "baidu" && cloud_type != "ucloud" && cloud_type != "qiniu" && cloud_type != "aws" && cloud_type != "azure" && cloud_type != "gcp" && cloud_type != "jdcloud" && cloud_type != "qingcloud" && cloud_type != "ksyun" && cloud_type != "vultr" { return Err("当前云类型资源实时拉取尚未接入".into()); }
    let now = Utc::now().timestamp_millis();
    let types = if resource_types.is_empty() {
        if cloud_type == "vultr" { vec!["ecs", "domain", "oss", "rds", "block", "network", "firewall", "ip", "loadbalancer", "snapshot", "kubernetes"].into_iter().map(String::from).collect() } else if cloud_type == "qiniu" { vec!["oss"].into_iter().map(String::from).collect() } else if cloud_type == "jdcloud" { vec!["ecs", "domain", "swas", "rds", "redis", "oss"].into_iter().map(String::from).collect() } else if cloud_type == "qingcloud" { vec!["ecs", "domain", "rds", "redis", "oss"].into_iter().map(String::from).collect() } else if cloud_type == "ksyun" { vec!["ecs", "rds", "redis", "oss"].into_iter().map(String::from).collect() } else if cloud_type == "huawei" || cloud_type == "baidu" || cloud_type == "ucloud" || cloud_type == "aws" || cloud_type == "azure" || cloud_type == "gcp" { vec!["ecs", "domain", "rds", "redis", "oss"].into_iter().map(String::from).collect() } else if cloud_type == "oracle" { vec!["ecs", "domain", "rds", "oss"].into_iter().map(String::from).collect() } else if cloud_type == "ctyun" { vec!["ecs", "domain", "rds", "redis", "oss"].into_iter().map(String::from).collect() } else if cloud_type == "volcengine" { vec!["ecs", "domain", "swas", "rds", "redis", "oss", "esa"].into_iter().map(String::from).collect() } else { vec!["ecs", "domain", "oss", "rds", "redis", "swas", "esa"].into_iter().map(String::from).collect() }
    } else { resource_types };
    let mut counts = BTreeMap::new(); let mut errors = Vec::new(); let mut rows: Vec<(String, ResourceResponse)> = Vec::new();
    for resource_type in &types {
        let response = if cloud_type == "vultr" { cloud::vultr::vultr_resource_items(id, &resource_type).await } else if cloud_type == "huawei" { cloud::huawei::resource_items(id, &resource_type).await } else if cloud_type == "baidu" { cloud::baidu::resource_items(id, &resource_type).await } else if cloud_type == "ucloud" { cloud::ucloud::resource_items(id, &resource_type).await } else if cloud_type == "qiniu" { cloud::qiniu::resource_items(id, &resource_type).await } else if cloud_type == "aws" { cloud::aws::resource_items(id, &resource_type).await } else if cloud_type == "azure" { cloud::azure::resource_items(id, &resource_type).await } else if cloud_type == "gcp" { cloud::gcp::resource_items(id, &resource_type).await } else if cloud_type == "jdcloud" { cloud::jdcloud::resource_items(id, &resource_type).await } else if cloud_type == "qingcloud" { cloud::qingcloud::resource_items(id, &resource_type).await } else if cloud_type == "ksyun" { cloud::ksyun::resource_items(id, &resource_type).await } else if cloud_type == "oracle" { cloud::oracle::resource_items(id, &resource_type).await } else if cloud_type == "tencent" { cloud::tencent::resource_items(id, &resource_type, &access_key_id, &access_key_secret).await } else if cloud_type == "volcengine" { cloud::volc::resource_items(id, &resource_type, &access_key_id, &access_key_secret).await } else if cloud_type == "ctyun" { cloud::ctyun::resource_items(id, &resource_type, &access_key_id, &access_key_secret).await } else if cloud_type == "aliyun" { cloud::aliyun::resource_items(&resource_type, &access_key_id, &access_key_secret).await } else { return Err("当前云类型资源实时拉取尚未接入".into()); };
        if !response.errors.is_empty() { errors.extend(response.errors.clone().into_iter().map(|e| format!("{resource_type}: {e}"))); }
        rows.push((resource_type.clone(), response));
    }
    let mut conn = open_db()?;
    let mut asset_rows = Vec::new();
    for (resource_type, response) in rows {
        let item_count = response.items.len(); counts.insert(resource_type.clone(), item_count);
        for (index, item) in response.items.iter().enumerate() {
            let region = item.get("_region_id").and_then(Value::as_str).or_else(|| item.get("RegionId").and_then(Value::as_str)).map(str::to_string);
            asset_rows.push(asset_repository::AssetRow { resource_type: resource_type.clone(), asset_key: asset_key(&resource_type, item, index), region_id: region, payload_json: serde_json::to_string(item).map_err(|e| e.to_string())?, fetched_at: response.fetched_at });
        }
    }
    let fetched = asset_repository::replace_for_account(&mut conn, id, &types, &asset_rows)?;
    Ok(AssetSyncResult { fetched, counts, errors, fetched_at: now })
}

#[tauri::command]
async fn set_oss_public_read(id: i64, bucket: String, location: String) -> Result<(), String> {
    cloud::aliyun::set_public_read(id, &bucket, &location).await
}

#[tauri::command]
async fn cloud_account_summary(id: i64) -> Result<Value, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    if account_cloud_type(id)? == "tencent" {
        let (identity, balance, bill) = cloud::tencent::finance_summary(id).await;
        let (cvm, domains, swas, rds, redis, oss, esa) = tokio::join!(
            cloud::tencent::resource_items(id, "ecs", &access_key_id, &access_key_secret),
            cloud::tencent::resource_items(id, "domain", &access_key_id, &access_key_secret),
            cloud::tencent::resource_items(id, "swas", &access_key_id, &access_key_secret),
            cloud::tencent::resource_items(id, "rds", &access_key_id, &access_key_secret),
            cloud::tencent::resource_items(id, "redis", &access_key_id, &access_key_secret),
            cloud::tencent::resource_items(id, "oss", &access_key_id, &access_key_secret),
            cloud::tencent::resource_items(id, "esa", &access_key_id, &access_key_secret),
        );
        let overview = bill.get("SummaryOverview").or_else(|| bill.pointer("/SummarySet/0")).cloned().unwrap_or_else(|| json!({}));
        let monthly_total = tencent_number(overview.get("RealTotalCost").or_else(|| overview.get("TotalCost")).or_else(|| overview.get("CashPayAmount")));
        return Ok(json!({
            "account_id": identity.get("AppId").or_else(|| identity.get("UserAppId")).cloned().unwrap_or(json!(access_key_id)), "account_type": "腾讯云账号",
            "available_amount": tencent_number(balance.get("Balance").or_else(|| balance.get("RealBalance"))) / 100.0,
            "available_cash_amount": tencent_number(balance.get("CashAccountBalance")) / 100.0,
            "credit_amount": tencent_number(balance.get("PresentAccountBalance").or_else(|| balance.get("IncentiveAccountBalance")).or_else(|| balance.get("VoucherBalance"))) / 100.0,
            "month_consume": monthly_total, "month_bill": monthly_total,
            "ecs_count": cvm.items.len(), "domain_count": domains.items.len(),
            "dns_record_count": domains.items.iter().map(|item| tencent_number(item.get("RecordCount")) as usize).sum::<usize>(),
            "oss_count": oss.items.len(), "rds_count": rds.items.len(), "redis_count": redis.items.len(), "swas_count": swas.items.len(), "esa_count": esa.items.len(),
        }));
    }
    if account_cloud_type(id)? == "volcengine" {
        let (ecs, domains, swas, oss, rds, redis, esa) = tokio::join!(
            cloud::volc::resource_items(id, "ecs", &access_key_id, &access_key_secret),
            cloud::volc::resource_items(id, "domain", &access_key_id, &access_key_secret),
            cloud::volc::resource_items(id, "swas", &access_key_id, &access_key_secret),
            cloud::volc::resource_items(id, "oss", &access_key_id, &access_key_secret),
            cloud::volc::resource_items(id, "rds", &access_key_id, &access_key_secret),
            cloud::volc::resource_items(id, "redis", &access_key_id, &access_key_secret),
            cloud::volc::resource_items(id, "esa", &access_key_id, &access_key_secret),
        );
        return Ok(json!({
            "account_id": access_key_id, "account_type": "火山引擎账号",
            "available_amount": 0, "available_cash_amount": 0, "credit_amount": 0,
            "month_consume": 0, "month_bill": 0,
            "ecs_count": ecs.items.len(), "domain_count": domains.items.len(), "dns_record_count": 0,
            "oss_count": oss.items.len(), "rds_count": rds.items.len(), "redis_count": redis.items.len(),
            "swas_count": swas.items.len(), "esa_count": esa.items.len(),
        }));
    }
    if account_cloud_type(id)? == "ctyun" {
        let (ecs, domains, rds, redis, oss) = tokio::join!(
            cloud::ctyun::resource_items(id, "ecs", &access_key_id, &access_key_secret), cloud::ctyun::resource_items(id, "domain", &access_key_id, &access_key_secret),
            cloud::ctyun::resource_items(id, "rds", &access_key_id, &access_key_secret), cloud::ctyun::resource_items(id, "redis", &access_key_id, &access_key_secret), cloud::ctyun::resource_items(id, "oss", &access_key_id, &access_key_secret),
        );
        return Ok(json!({
            "account_id": access_key_id, "account_type": "天翼云账号",
            "available_amount": 0, "available_cash_amount": 0, "credit_amount": 0,
            "month_consume": 0, "month_bill": 0,
            "ecs_count": ecs.items.len(), "domain_count": domains.items.len(), "dns_record_count": domains.items.iter().map(|item| tencent_number(item.get("RecordCount")) as usize).sum::<usize>(),
            "oss_count": oss.items.len(), "rds_count": rds.items.len(), "redis_count": redis.items.len(), "swas_count": 0, "esa_count": 0,
        }));
    }
    ensure_aliyun_account(id)?;
    let mut summary = json!({"account_id":"-","account_type":"-","available_amount":0,"available_cash_amount":0,"credit_amount":0,"month_consume":0,"month_bill":0,"ecs_count":0,"domain_count":0,"dns_record_count":0,"oss_count":0,"rds_count":0,"redis_count":0,"swas_count":0,"esa_count":0});
    let (identity, balance, bill, dns) = cloud::aliyun::finance_summary(id).await;
    if !identity.is_object() || identity.as_object().is_some_and(|value| value.is_empty()) { } else {
        summary["account_id"] = identity.get("AccountId").cloned().unwrap_or(json!("-"));
        summary["account_type"] = json!(match identity.get("IdentityType").and_then(Value::as_str).unwrap_or("") { "Account" => "主账号", "RAMUser" => "RAM子用户", "AssumedRoleUser" => "角色用户", other if !other.is_empty() => other, _ => "-" });
    }
    if let Some(data) = balance.get("Data") {
            for (source, target) in [("AvailableAmount", "available_amount"), ("AvailableCashAmount", "available_cash_amount"), ("CreditAmount", "credit_amount")] {
                summary[target] = data.get(source).cloned().unwrap_or(json!(0));
            }
    }
    let total: f64 = array_at(&bill, &["Data", "Items", "Item"]).into_iter().filter_map(|item| item.get("PretaxAmount").and_then(|v| v.as_f64().or_else(|| v.as_str()?.parse().ok()))).sum(); summary["month_bill"] = json!(total);
    for resource_type in ["ecs", "domain", "oss", "rds", "redis", "swas", "esa"] { let result = cloud::aliyun::resource_items(resource_type, &access_key_id, &access_key_secret).await; summary[&format!("{resource_type}_count")] = json!(result.items.len()); }
    summary["dns_record_count"] = json!(array_at(&dns, &["Domains", "Domain"]).into_iter().filter_map(|item| item.get("RecordCount").and_then(Value::as_i64)).sum::<i64>());
    Ok(summary)
}

#[tauri::command]
fn app_data_path() -> Result<String, String> { Ok(data_dir()?.to_string_lossy().to_string()) }

#[tauri::command]
fn open_app_data_directory() -> Result<(), String> {
    let path = data_dir()?;

    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer.exe");
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = Command::new("xdg-open");

    command
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开数据目录: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SshTerminalStore { terminals: Mutex::new(HashMap::new()) })
        .manage(OssUploadSelectionStore { files: Mutex::new(HashMap::new()) })
        .manage(DatabaseImportStore::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![list_accounts, save_account, delete_account, app_data_path, open_app_data_directory, export_database_file, import_database_file, prepare_database_import, confirm_database_import, cancel_database_import, list_client_preferences, save_client_preference, reveal_account_secret, cloud_account_summary, list_cloud_resources, sync_cloud_assets, cloud::vultr::verify_vultr_account, verify_ctyun_account, verify_huawei_account, cloud::baidu::verify_baidu_account, verify_ucloud_account, verify_qiniu_account, verify_aws_account, verify_azure_account, verify_gcp_account, verify_jdcloud_account, verify_qingcloud_account, verify_ksyun_account, esa_overview, list_local_assets, delete_local_asset, list_managed_hosts, save_managed_host, delete_managed_host, probe_managed_host, export_managed_hosts_file, import_managed_hosts, list_panel_connections, update_panel_connection_order, save_panel_connection, refresh_panel_connection, panel_temporary_login, delete_panel_connection, update_panel_connection_remark, export_panel_connections_file, import_panel_connections, list_api_logs, clear_api_logs, clear_operation_logs, list_instance_disks, list_aliyun_security_groups, authorize_aliyun_security_group_rule, revoke_aliyun_security_group_rule, list_tencent_security_groups, authorize_tencent_security_group_rule, revoke_tencent_security_group_rule, list_baidu_security_groups, authorize_baidu_security_group_rule, revoke_baidu_security_group_rule, list_light_firewall_rules, create_light_firewall_rule, delete_light_firewall_rule, cloud::vultr::list_vultr_firewall_rules, cloud::vultr::create_vultr_firewall_rule, cloud::vultr::delete_vultr_firewall_rule, instance_status, reboot_instance, start_instance, stop_instance, cloud::vultr::vultr_instance_action, cloud::vultr::vultr_instance_manage, oracle_instance_action, cvm_instance_reboot, cvm_instance_action, baidu_instance_action, rename_server, swas_instance_action, list_dns_records, add_dns_record, update_dns_record, delete_dns_record, toggle_dns_record, list_domain_logs, query_whois, list_rds_databases, list_rds_accounts, list_redis_accounts, list_oss_objects, select_oss_upload_file, stage_oss_upload_file, discard_oss_upload_selection, upload_oss_object, download_oss_object, download_oss_objects, get_oss_object_url, get_oss_acl, set_oss_public_read, set_oss_cors, get_ssh_connection, reveal_ssh_password, delete_ssh_connection, get_rdp_connection, reveal_rdp_password, delete_rdp_connection, launch_rdp_connection, launch_managed_host_rdp, ssh_connect, ssh_test_connection, ssh_list_files, ssh_read_text_file, ssh_write_text_file, ssh_upload_file, ssh_download_file, ssh_make_directory, ssh_delete_path, ssh_read, ssh_write, ssh_resize, ssh_disconnect, export_accounts, export_accounts_file, import_accounts])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
