use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    future::Future,
    path::PathBuf,
    sync::{mpsc, Arc, Mutex},
};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use russh::client;
use uuid::Uuid;

mod core;
use core::storage::{decrypt_secret, encrypt_secret, open_db};
use core::repositories::managed_hosts as managed_host_repository;
use core::repositories::accounts as account_repository;
use core::repositories::logs as log_repository;
mod commands;
pub(crate) use commands::accounts::{delete_account, export_accounts, export_accounts_file, import_accounts, list_accounts, reveal_account_secret, save_account};
pub(crate) use commands::preferences::{list_client_preferences, save_client_preference};
pub(crate) use commands::logs::{clear_api_logs, clear_operation_logs, list_api_logs};
pub(crate) use commands::assets::{delete_local_asset, list_local_assets};
pub(crate) use commands::managed_hosts::{delete_managed_host, export_managed_hosts_file, import_managed_hosts, list_managed_hosts, probe_managed_host, save_managed_host};
pub(crate) use commands::panel_connections::{delete_panel_connection, export_panel_connections_file, import_panel_connections, list_panel_connections, panel_temporary_login, refresh_panel_connection, save_panel_connection, update_panel_connection_order, update_panel_connection_remark};
pub(crate) use commands::connections::{delete_rdp_connection, delete_ssh_connection, get_rdp_connection, get_ssh_connection, reveal_rdp_password, reveal_ssh_password};
pub(crate) use commands::database_migration::{cancel_database_import, confirm_database_import, export_database_file, import_database_file, prepare_database_import, DatabaseImportStore};
pub(crate) use commands::app::{app_data_path, open_app_data_directory};
pub(crate) use commands::domains::{add_dns_record, delete_dns_record, list_dns_records, list_domain_logs, list_rds_accounts, list_rds_databases, list_redis_accounts, query_whois, toggle_dns_record, update_dns_record};
pub(crate) use commands::storage::{discard_oss_upload_selection, download_oss_object, download_oss_objects, get_oss_acl, get_oss_object_url, list_oss_objects, select_oss_upload_file, set_oss_cors, set_oss_public_read, stage_oss_upload_file, upload_oss_object};
pub(crate) use commands::resources::{cancel_cloud_asset_sync, list_cloud_resources, sync_cloud_assets};
pub(crate) use commands::servers::{authorize_aliyun_security_group_rule, authorize_baidu_security_group_rule, authorize_tencent_security_group_rule, create_light_firewall_rule, create_vultr_firewall_rule, cvm_instance_action, cvm_instance_reboot, delete_light_firewall_rule, delete_vultr_firewall_rule, esa_overview, instance_status, list_aliyun_security_groups, list_baidu_security_groups, list_instance_disks, list_light_firewall_rules, list_tencent_security_groups, list_vultr_firewall_rules, oracle_instance_action, reboot_instance, rename_server, revoke_aliyun_security_group_rule, revoke_baidu_security_group_rule, revoke_tencent_security_group_rule, start_instance, stop_instance, swas_instance_action, vultr_instance_action, vultr_instance_manage};
pub(crate) use commands::ssh::{authenticate_ssh, launch_managed_host_rdp, launch_rdp_connection, ssh_connect, ssh_delete_path, ssh_disconnect, ssh_download_file, ssh_list_files, ssh_make_directory, ssh_read, ssh_read_text_file, ssh_resize, ssh_saved_connection, ssh_test_connection, ssh_upload_file, ssh_write, ssh_write_text_file};
pub(crate) use commands::providers::{baidu_instance_action, verify_aws_account, verify_azure_account, verify_baidu_account, verify_ctyun_account, verify_gcp_account, verify_huawei_account, verify_jdcloud_account, verify_ksyun_account, verify_qingcloud_account, verify_qiniu_account, verify_ucloud_account, verify_vultr_account};
pub(crate) use commands::summary::cloud_account_summary;
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

#[derive(Default)]
struct AssetSyncStore {
    cancelled_accounts: Arc<Mutex<HashSet<i64>>>,
    running_accounts: Arc<Mutex<HashSet<i64>>>,
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

// Aliyun RPC uses RFC3986 encoding: only ALPHA / DIGIT / - . _ ~ remain unescaped.
fn rpc_encode(value: &str) -> String {
    cloud::aliyun::encode(value)
}

fn configured_regions(id: i64, fallback: &str) -> Result<Vec<String>, String> {
    let value = account_repository::region_id(&open_db()?, id)?;
    let mut regions = value.unwrap_or_else(|| fallback.into()).split(|character: char| character == ',' || character == '，' || character.is_whitespace()).filter(|value| !value.is_empty()).map(String::from).collect::<Vec<_>>();
    if regions.is_empty() { regions.push(fallback.into()); } regions.sort(); regions.dedup(); Ok(regions)
}

fn value_first_string(value: Option<&Value>) -> Value { value.and_then(Value::as_array).and_then(|items| items.first()).cloned().or_else(|| value.cloned()).unwrap_or(json!("")) }
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





#[derive(Debug, Serialize)]
struct LocalAsset { account_id: i64, resource_type: String, asset_key: String, region_id: Option<String>, payload: Value, fetched_at: i64 }

#[derive(Debug, Serialize)]
struct AssetSyncResult { fetched: usize, counts: BTreeMap<String, usize>, errors: Vec<String>, fetched_at: i64 }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetSyncProgress { account_id: i64, completed: usize, total: usize, resource_type: String, status: String, elapsed_ms: u128 }

#[derive(Debug, Serialize)]
struct ApiLog { id: i64, account_id: Option<i64>, account_name: Option<String>, endpoint: String, action: String, request_params: String, response_params: Option<String>, status: String, message: Option<String>, created_at: i64 }

fn managed_host_saved_connection(id: i64) -> Result<Option<SavedSshCredentials>, String> {
    managed_host_repository::saved_connection(&open_db()?, id)
}


fn asset_key(resource_type: &str, item: &Value, _index: usize) -> String {
    for key in ["InstanceId", "DBInstanceId", "KVStoreInstanceId", "AssetId", "SiteId", "DomainName", "Name", "BucketName", "Id", "id"] {
        if let Some(value) = item.get(key).and_then(Value::as_str).filter(|v| !v.is_empty()) { return value.to_string(); }
        if let Some(value) = item.get(key).and_then(Value::as_i64) { return value.to_string(); }
    }
    let region = item.get("_region_id").or_else(|| item.get("RegionId")).and_then(Value::as_str).unwrap_or("global");
    let identity = item.get("PrivateIpAddress").or_else(|| item.get("PublicIpAddress")).or_else(|| item.get("ConnectionDomain")).or_else(|| item.get("Endpoint")).and_then(Value::as_str).filter(|v| !v.is_empty());
    if let Some(identity) = identity { return format!("{resource_type}:{region}:{identity}"); }
    let payload = serde_json::to_vec(item).unwrap_or_default();
    format!("{resource_type}:{region}:{:x}", Sha256::digest(payload))
}

fn resource_errors_retryable(errors: &[String]) -> bool {
    !errors.is_empty() && errors.iter().all(|error| {
        let normalized = error.to_ascii_lowercase();
        normalized.contains("超时") || normalized.contains("网络") || normalized.contains("连接") || normalized.contains("请求失败") || normalized.contains("timeout") || normalized.contains("network") || normalized.contains("connection") || normalized.contains("429") || normalized.contains("502") || normalized.contains("503") || normalized.contains("504")
    })
}

async fn fetch_once_with_cancellation<Fut, C>(future: Fut, is_cancelled: &C) -> Result<ResourceResponse, String>
where
    Fut: Future<Output = ResourceResponse>,
    C: Fn() -> bool,
{
    if is_cancelled() { return Err("同步已取消".into()); }
    tokio::pin!(future);
    loop {
        tokio::select! {
            response = &mut future => return Ok(response),
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
                if is_cancelled() { return Err("同步已取消".into()); }
            }
        }
    }
}

async fn fetch_resource_with_retry<F, Fut, C>(mut fetch: F, is_cancelled: C) -> Result<ResourceResponse, String>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = ResourceResponse>,
    C: Fn() -> bool,
{
    let mut response = fetch_once_with_cancellation(fetch(), &is_cancelled).await?;
    for delay in [250_u64, 750_u64] {
        if response.errors.is_empty() || !resource_errors_retryable(&response.errors) { return Ok(response); }
        if is_cancelled() { return Err("同步已取消".into()); }
        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        response = fetch_once_with_cancellation(fetch(), &is_cancelled).await?;
    }
    if is_cancelled() { Err("同步已取消".into()) } else { Ok(response) }
}

#[cfg(test)]
mod asset_key_tests {
    use super::{asset_key, fetch_resource_with_retry, resource_errors_retryable, ResourceResponse};
    use serde_json::json;
    use std::sync::{atomic::{AtomicBool, Ordering}, Arc};

    #[test]
    fn does_not_depend_on_result_order_when_no_provider_id_exists() {
        let item = json!({"Name":"unnamed","_region_id":"cn-hz"});
        assert_eq!(asset_key("ecs", &item, 0), asset_key("ecs", &item, 99));
    }

    #[test]
    fn includes_region_and_connection_identity_for_fallback_keys() {
        assert_eq!(asset_key("ecs", &json!({"PublicIpAddress":"1.2.3.4","_region_id":"cn-hz"}), 0), "ecs:cn-hz:1.2.3.4");
    }

    #[test]
    fn retries_only_transient_resource_errors() {
        assert!(resource_errors_retryable(&["请求超时".into(), "HTTP 503".into()]));
        assert!(!resource_errors_retryable(&["AccessKey 凭据无效".into()]));
        assert!(!resource_errors_retryable(&["请求超时".into(), "权限不足".into()]));
    }

    #[tokio::test]
    async fn cancels_an_inflight_resource_request() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancel_for_check = cancelled.clone();
        let task = tokio::spawn(async move {
            fetch_resource_with_retry(
                || async {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    ResourceResponse { resource_type: "ecs".into(), items: vec![], errors: vec![], fetched_at: 0 }
                },
                move || cancel_for_check.load(Ordering::Relaxed),
            ).await
        });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        cancelled.store(true, Ordering::Relaxed);
        let result = task.await.expect("取消测试任务应正常结束");
        assert_eq!(result.expect_err("请求应被取消"), "同步已取消");
    }
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SshTerminalStore { terminals: Mutex::new(HashMap::new()) })
        .manage(OssUploadSelectionStore { files: Mutex::new(HashMap::new()) })
        .manage(AssetSyncStore::default())
        .manage(DatabaseImportStore::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![list_accounts, save_account, delete_account, app_data_path, open_app_data_directory, export_database_file, import_database_file, prepare_database_import, confirm_database_import, cancel_database_import, list_client_preferences, save_client_preference, reveal_account_secret, cloud_account_summary, list_cloud_resources, sync_cloud_assets, cancel_cloud_asset_sync, verify_vultr_account, verify_ctyun_account, verify_huawei_account, verify_baidu_account, verify_ucloud_account, verify_qiniu_account, verify_aws_account, verify_azure_account, verify_gcp_account, verify_jdcloud_account, verify_qingcloud_account, verify_ksyun_account, esa_overview, list_local_assets, delete_local_asset, list_managed_hosts, save_managed_host, delete_managed_host, probe_managed_host, export_managed_hosts_file, import_managed_hosts, list_panel_connections, update_panel_connection_order, save_panel_connection, refresh_panel_connection, panel_temporary_login, delete_panel_connection, update_panel_connection_remark, export_panel_connections_file, import_panel_connections, list_api_logs, clear_api_logs, clear_operation_logs, list_instance_disks, list_aliyun_security_groups, authorize_aliyun_security_group_rule, revoke_aliyun_security_group_rule, list_tencent_security_groups, authorize_tencent_security_group_rule, revoke_tencent_security_group_rule, list_baidu_security_groups, authorize_baidu_security_group_rule, revoke_baidu_security_group_rule, list_light_firewall_rules, create_light_firewall_rule, delete_light_firewall_rule, list_vultr_firewall_rules, create_vultr_firewall_rule, delete_vultr_firewall_rule, instance_status, reboot_instance, start_instance, stop_instance, vultr_instance_action, vultr_instance_manage, oracle_instance_action, cvm_instance_reboot, cvm_instance_action, baidu_instance_action, rename_server, swas_instance_action, list_dns_records, add_dns_record, update_dns_record, delete_dns_record, toggle_dns_record, list_domain_logs, query_whois, list_rds_databases, list_rds_accounts, list_redis_accounts, list_oss_objects, select_oss_upload_file, stage_oss_upload_file, discard_oss_upload_selection, upload_oss_object, download_oss_object, download_oss_objects, get_oss_object_url, get_oss_acl, set_oss_public_read, set_oss_cors, get_ssh_connection, reveal_ssh_password, delete_ssh_connection, get_rdp_connection, reveal_rdp_password, delete_rdp_connection, launch_rdp_connection, launch_managed_host_rdp, ssh_connect, ssh_test_connection, ssh_list_files, ssh_read_text_file, ssh_write_text_file, ssh_upload_file, ssh_download_file, ssh_make_directory, ssh_delete_path, ssh_read, ssh_write, ssh_resize, ssh_disconnect, export_accounts, export_accounts_file, import_accounts])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
