use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD}, Engine as _};
use chrono::{Duration, Local, TimeZone, Utc};
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    future::Future,
    fs,
    path::PathBuf,
    process::Command,
    sync::{mpsc, Arc, Mutex},
    time::Instant,
};
use hmac::{Hmac, Mac};
use sha1::Sha1;
use md5::Md5;
use sha2::{Digest, Sha256};
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use russh::{client, ChannelMsg};
use russh::keys::{decode_secret_key, PrivateKeyWithHashAlg};
use rsa::{pkcs1::DecodeRsaPrivateKey, pkcs8::DecodePrivateKey, pkcs1v15::SigningKey, RsaPrivateKey};
use rsa::signature::{SignatureEncoding, Signer};
use uuid::Uuid;

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
    group_name: Option<String>,
    tags: Option<String>,
    source_account_id: Option<i64>,
    source_asset_key: Option<String>,
    password_saved: bool,
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

fn data_dir() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir().ok_or_else(|| "无法获取本机应用数据目录".to_string())?;
    let path = base.join("CloudHubTools");
    let legacy_path = base.join("AliyunTools");
    if !path.exists() && legacy_path.exists() {
        fs::create_dir_all(&path).map_err(|e| format!("创建数据目录失败: {e}"))?;
        for (legacy_name, current_name) in [("aliyun_tools.sqlite3", "cloudhub_tools.sqlite3"), (".key", ".key")] {
            let source = legacy_path.join(legacy_name);
            if source.exists() {
                fs::copy(&source, path.join(current_name)).map_err(|e| format!("迁移本地数据失败: {e}"))?;
            }
        }
    }
    fs::create_dir_all(&path).map_err(|e| format!("创建数据目录失败: {e}"))?;
    Ok(path)
}

fn open_db() -> Result<Connection, String> {
    let conn = Connection::open(data_dir()?.join("cloudhub_tools.sqlite3")).map_err(|e| format!("打开 SQLite 失败: {e}"))?;
    conn.execute_batch("PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS cloud_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, account_name TEXT NOT NULL, cloud_type TEXT NOT NULL DEFAULT 'aliyun', group_name TEXT, access_key_id TEXT NOT NULL, secret_ciphertext TEXT NOT NULL, region_id TEXT, enabled INTEGER NOT NULL DEFAULT 1, remark TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_assets (account_id INTEGER NOT NULL, resource_type TEXT NOT NULL, asset_key TEXT NOT NULL, region_id TEXT, payload_json TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY(account_id, resource_type, asset_key), FOREIGN KEY(account_id) REFERENCES cloud_accounts(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS ssh_connections (account_id INTEGER NOT NULL, asset_key TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 22, username TEXT NOT NULL, password_ciphertext TEXT, host_key_fingerprint TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(account_id, asset_key), FOREIGN KEY(account_id) REFERENCES cloud_accounts(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS rdp_connections (target_key TEXT PRIMARY KEY, host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 3389, username TEXT NOT NULL, password_ciphertext TEXT, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS managed_hosts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 22, username TEXT NOT NULL, password_ciphertext TEXT NOT NULL, group_name TEXT, tags TEXT, source_account_id INTEGER, source_asset_key TEXT, host_key_fingerprint TEXT, status TEXT NOT NULL DEFAULT 'unknown', last_latency_ms INTEGER, metrics_json TEXT NOT NULL DEFAULT '{}', last_checked_at INTEGER, last_error TEXT, remark TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS panel_connections (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, panel_url TEXT NOT NULL UNIQUE, api_key_ciphertext TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, allow_insecure_tls INTEGER NOT NULL DEFAULT 0, group_name TEXT, source_account_id INTEGER, source_asset_key TEXT, status TEXT NOT NULL DEFAULT 'unknown', summary_json TEXT NOT NULL DEFAULT '{}', last_checked_at INTEGER, last_error TEXT, remark TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS operation_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, action TEXT NOT NULL, result TEXT NOT NULL, message TEXT, created_at INTEGER NOT NULL);")
      .map_err(|e| format!("初始化 SQLite 表失败: {e}"))?;
    let has_sort: bool = conn.prepare("PRAGMA table_info(cloud_accounts)").map_err(|e| e.to_string())?.query_map([], |row| row.get::<_, String>(1)).map_err(|e| e.to_string())?.filter_map(Result::ok).any(|name| name == "sort_order");
    if !has_sort { conn.execute("ALTER TABLE cloud_accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0", []).map_err(|e| e.to_string())?; }
    let has_credential_meta: bool = conn.prepare("PRAGMA table_info(cloud_accounts)").map_err(|e| e.to_string())?.query_map([], |row| row.get::<_, String>(1)).map_err(|e| e.to_string())?.filter_map(Result::ok).any(|name| name == "credential_meta");
    if !has_credential_meta { conn.execute("ALTER TABLE cloud_accounts ADD COLUMN credential_meta TEXT", []).map_err(|e| e.to_string())?; }
    let has_panel_insecure_tls: bool = conn.prepare("PRAGMA table_info(panel_connections)").map_err(|e| e.to_string())?.query_map([], |row| row.get::<_, String>(1)).map_err(|e| e.to_string())?.filter_map(Result::ok).any(|name| name == "allow_insecure_tls");
    if !has_panel_insecure_tls { conn.execute("ALTER TABLE panel_connections ADD COLUMN allow_insecure_tls INTEGER NOT NULL DEFAULT 0", []).map_err(|e| e.to_string())?; }
    let has_panel_sort_order: bool = conn.prepare("PRAGMA table_info(panel_connections)").map_err(|e| e.to_string())?.query_map([], |row| row.get::<_, String>(1)).map_err(|e| e.to_string())?.filter_map(Result::ok).any(|name| name == "sort_order");
    if !has_panel_sort_order { conn.execute("ALTER TABLE panel_connections ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0", []).map_err(|e| e.to_string())?; }
    conn.execute("CREATE TABLE IF NOT EXISTS api_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, endpoint TEXT NOT NULL, action TEXT NOT NULL, request_params TEXT NOT NULL, response_params TEXT, status TEXT NOT NULL, message TEXT, created_at INTEGER NOT NULL)", []).map_err(|e| e.to_string())?;
    Ok(conn)
}

fn write_api_log(access_key_id: &str, endpoint: &str, action: &str, request_params: &Value, response: Option<&Value>, status: &str, message: Option<&str>) {
    if let Ok(conn) = open_db() {
        let account_id: Option<i64> = conn.query_row("SELECT id FROM cloud_accounts WHERE access_key_id=?1", [access_key_id], |row| row.get(0)).optional().ok().flatten();
        let _ = conn.execute("INSERT INTO api_logs(account_id,endpoint,action,request_params,response_params,status,message,created_at) VALUES(?,?,?,?,?,?,?,?)", params![account_id, endpoint, action, serde_json::to_string(request_params).unwrap_or_default(), response.map(|value| serde_json::to_string(value).unwrap_or_default()), status, message, Utc::now().timestamp_millis()]);
    }
}

fn crypto_key() -> Result<[u8; 32], String> {
    let path = data_dir()?.join(".key");
    if path.exists() { let bytes = fs::read(&path).map_err(|e| e.to_string())?; return bytes.try_into().map_err(|_| "本地密钥无效".to_string()); }
    let mut key = [0u8; 32]; rand::thread_rng().fill_bytes(&mut key); fs::write(path, key).map_err(|e| e.to_string())?; Ok(key)
}

fn encrypt_secret(secret: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&crypto_key()?));
    let mut nonce = [0u8; 12]; rand::thread_rng().fill_bytes(&mut nonce);
    let encrypted = cipher.encrypt(Nonce::from_slice(&nonce), secret.as_bytes()).map_err(|_| "加密 Secret 失败".to_string())?;
    let mut packed = nonce.to_vec(); packed.extend(encrypted); Ok(B64.encode(packed))
}

fn decrypt_secret(ciphertext: &str) -> Result<String, String> {
    let packed = B64.decode(ciphertext).map_err(|e| format!("读取 Secret 失败: {e}"))?;
    if packed.len() < 12 { return Err("本地 Secret 数据损坏".into()); }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&crypto_key()?));
    let value = cipher.decrypt(Nonce::from_slice(&packed[..12]), &packed[12..])
        .map_err(|_| "解密 Secret 失败".to_string())?;
    String::from_utf8(value).map_err(|_| "Secret 编码无效".into())
}

fn account_credentials(id: i64) -> Result<(String, String), String> {
    let conn = open_db()?;
    let row: (String, String, i64) = conn.query_row(
        "SELECT access_key_id, secret_ciphertext, enabled FROM cloud_accounts WHERE id=?1",
        [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| format!("读取云账号失败: {e}"))?;
    if row.2 != 1 { return Err("云账号已停用".into()); }
    // Cloud access-key secrets cannot contain meaningful leading/trailing whitespace.
    // Tolerate accidental whitespace from a pasted credential without rewriting it.
    Ok((row.0, decrypt_secret(&row.1)?.trim().to_string()))
}

async fn vultr_request(id: i64, path: &str, query: &BTreeMap<String, String>) -> Result<Value, String> {
    if account_cloud_type(id)? != "vultr" { return Err("当前账号不是 Vultr 账号".into()); }
    let (access_key_id, api_key) = account_credentials(id)?;
    let mut url = reqwest::Url::parse(&format!("https://api.vultr.com/v2/{path}"))
        .map_err(|error| format!("Vultr URL 无效: {error}"))?;
    url.query_pairs_mut().extend_pairs(query.iter().map(|(key, value)| (key.as_str(), value.as_str())));
    let response = reqwest::Client::new()
        .get(url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(30))
        .send().await.map_err(|error| format!("Vultr 请求失败: {error}"))?;
    let status = response.status();
    let data: Value = response.json().await.map_err(|error| format!("Vultr 返回解析失败: {error}"))?;
    let action = format!("GET /v2/{}", path.split('?').next().unwrap_or(path));
    if !status.is_success() {
        let message = data.get("error").and_then(Value::as_str)
            .or_else(|| data.get("message").and_then(Value::as_str))
            .or_else(|| data.pointer("/error/message").and_then(Value::as_str))
            .map(str::to_string).unwrap_or_else(|| format!("Vultr API 返回 HTTP {status}"));
        write_api_log(&access_key_id, "api.vultr.com", &action, &json!(query), Some(&data), "失败", Some(&message));
        return Err(message);
    }
    write_api_log(&access_key_id, "api.vultr.com", &action, &json!(query), Some(&data), "成功", None);
    Ok(data)
}

fn vultr_cursor(next: &str) -> Option<String> {
    next.split('?').nth(1)?.split('&').find_map(|entry| {
        let (key, value) = entry.split_once('=')?;
        (key == "cursor" && !value.is_empty()).then(|| value.to_string())
    })
}

async fn vultr_pages(id: i64, path: &str, item_key: &str) -> Result<Vec<Value>, String> {
    let mut query = string_params(&[("per_page", "100".into())]);
    let mut items = Vec::new();
    for _ in 0..100 {
        let data = vultr_request(id, path, &query).await?;
        let page = array_at(&data, &[item_key]);
        let count = page.len();
        items.extend(page.into_iter().cloned());
        let next = data.pointer("/meta/links/next").and_then(Value::as_str).unwrap_or("");
        let Some(cursor) = vultr_cursor(next) else { break };
        if count == 0 { break; }
        query.insert("cursor".into(), cursor);
    }
    Ok(items)
}

fn vultr_value(item: &Value, keys: &[&str]) -> Value {
    keys.iter().find_map(|key| item.get(*key).filter(|value| !value.is_null()).cloned()).unwrap_or(json!(""))
}

fn vultr_instance(item: &Value) -> Value {
    json!({
        "InstanceId": vultr_value(item, &["id"]),
        "InstanceName": vultr_value(item, &["label", "hostname", "id"]),
        "Status": vultr_value(item, &["status"]),
        "InstanceStatus": vultr_value(item, &["status"]),
        "PublicIpAddress": vultr_value(item, &["main_ip"]),
        "PrivateIpAddress": vultr_value(item, &["internal_ip"]),
        "InstanceType": vultr_value(item, &["plan"]),
        "Cpu": vultr_value(item, &["vcpu_count"]),
        "Memory": vultr_value(item, &["ram"]),
        "Disk": vultr_value(item, &["disk"]),
        "OSName": vultr_value(item, &["os"]),
        "VpcIds": vultr_value(item, &["vpc2_ids"]),
        "FirewallGroupId": vultr_value(item, &["firewall_group_id"]),
        "Tags": vultr_value(item, &["tags"]),
        "CreationTime": vultr_value(item, &["date_created"]),
        "_region_id": vultr_value(item, &["region"]),
        "_raw": item,
    })
}

fn vultr_domain(item: &Value) -> Value {
    json!({
        "DomainName": vultr_value(item, &["domain"]), "DomainStatus": "ACTIVE",
        "RecordCount": 0, "RegistrationDate": vultr_value(item, &["date_created"]),
        "DnsSec": vultr_value(item, &["dns_sec"]), "ZoneId": vultr_value(item, &["domain"]),
        "_region_id": "global", "_raw": item,
    })
}

fn vultr_object_storage(item: &Value) -> Value {
    json!({
        "AssetId": vultr_value(item, &["id", "cluster_id"]), "Name": vultr_value(item, &["label", "cluster_id", "id"]),
        "BucketName": vultr_value(item, &["label", "cluster_id", "id"]), "Status": vultr_value(item, &["status"]),
        "Location": vultr_value(item, &["region"]), "CreationDate": vultr_value(item, &["date_created"]),
        "StorageClass": vultr_value(item, &["plan"]), "_region_id": vultr_value(item, &["region"]), "_raw": item,
    })
}

fn vultr_database(item: &Value) -> Value {
    json!({
        "DBInstanceId": vultr_value(item, &["id"]), "DBInstanceDescription": vultr_value(item, &["label", "id"]),
        "DBInstanceStatus": vultr_value(item, &["status"]), "DBInstanceClass": vultr_value(item, &["plan"]),
        "ConnectionString": vultr_value(item, &["host"]), "Port": vultr_value(item, &["port"]),
        "Engine": vultr_value(item, &["database_engine"]), "EngineVersion": vultr_value(item, &["database_engine_version"]),
        "CreateTime": vultr_value(item, &["date_created"]), "VpcId": vultr_value(item, &["vpc_id"]),
        "_region_id": vultr_value(item, &["region"]), "_raw": item,
    })
}

fn vultr_inventory_item(item: &Value, resource_type: &str) -> Value {
    let (name, region, status) = match resource_type {
        "block" => (vultr_value(item, &["label", "id"]), vultr_value(item, &["region"]), vultr_value(item, &["status"])),
        "network" => (vultr_value(item, &["description", "id"]), vultr_value(item, &["region"]), json!("active")),
        "firewall" => (vultr_value(item, &["description", "id"]), json!("global"), json!("active")),
        "ip" => (vultr_value(item, &["label", "subnet", "id"]), vultr_value(item, &["region"]), json!("active")),
        "loadbalancer" => (vultr_value(item, &["label", "id"]), vultr_value(item, &["region"]), vultr_value(item, &["status"])),
        "snapshot" => (vultr_value(item, &["description", "id"]), vultr_value(item, &["region"]), vultr_value(item, &["status"])),
        "kubernetes" => (vultr_value(item, &["label", "id"]), vultr_value(item, &["region"]), vultr_value(item, &["status"])),
        _ => (vultr_value(item, &["label", "description", "id"]), vultr_value(item, &["region"]), vultr_value(item, &["status"])),
    };
    json!({
        "AssetId": vultr_value(item, &["id"]), "Name": name, "Status": status, "RegionId": region,
        "IpAddress": vultr_value(item, &["ip", "instance_ip"]), "SizeGb": vultr_value(item, &["size_gb"]),
        "AttachedTo": vultr_value(item, &["attached_to_instance", "instance_id"]), "VpcId": vultr_value(item, &["vpc2_id", "vpc_id"]),
        "CreatedAt": vultr_value(item, &["date_created"]), "Tags": vultr_value(item, &["tags"]),
        "_region_id": vultr_value(item, &["region"]), "_raw": item,
    })
}

fn vultr_block(item: &Value) -> Value { vultr_inventory_item(item, "block") }
fn vultr_network(item: &Value) -> Value { vultr_inventory_item(item, "network") }
fn vultr_firewall(item: &Value) -> Value { vultr_inventory_item(item, "firewall") }
fn vultr_ip(item: &Value) -> Value { vultr_inventory_item(item, "ip") }
fn vultr_loadbalancer(item: &Value) -> Value { vultr_inventory_item(item, "loadbalancer") }
fn vultr_snapshot(item: &Value) -> Value { vultr_inventory_item(item, "snapshot") }
fn vultr_kubernetes(item: &Value) -> Value { vultr_inventory_item(item, "kubernetes") }

async fn vultr_resource_items(id: i64, resource_type: &str) -> ResourceResponse {
    let now = Utc::now().timestamp_millis();
    let definition = match resource_type {
        "ecs" => Some(("instances", "instances", vultr_instance as fn(&Value) -> Value)),
        "domain" => Some(("domains", "domains", vultr_domain as fn(&Value) -> Value)),
        "oss" => Some(("object-storage", "object_storages", vultr_object_storage as fn(&Value) -> Value)),
        "rds" => Some(("databases", "databases", vultr_database as fn(&Value) -> Value)),
        "block" => Some(("blocks", "blocks", vultr_block as fn(&Value) -> Value)),
        "network" => Some(("vpc2", "vpc2", vultr_network as fn(&Value) -> Value)),
        "firewall" => Some(("firewalls", "firewall_groups", vultr_firewall as fn(&Value) -> Value)),
        "ip" => Some(("reserved-ips", "reserved_ips", vultr_ip as fn(&Value) -> Value)),
        "loadbalancer" => Some(("load-balancers", "load_balancers", vultr_loadbalancer as fn(&Value) -> Value)),
        "snapshot" => Some(("snapshots", "snapshots", vultr_snapshot as fn(&Value) -> Value)),
        "kubernetes" => Some(("kubernetes/clusters", "vke_clusters", vultr_kubernetes as fn(&Value) -> Value)),
        _ => None,
    };
    let Some((path, key, normalize)) = definition else {
        return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![format!("Vultr 暂未接入 {resource_type} 资源")], fetched_at: now };
    };
    match vultr_pages(id, path, key).await {
        Ok(items) => ResourceResponse { resource_type: resource_type.into(), items: items.iter().map(normalize).collect(), errors: vec![], fetched_at: now },
        Err(error) => ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![error], fetched_at: now },
    }
}

#[tauri::command]
async fn verify_vultr_account(id: i64) -> Result<Value, String> {
    let account = vultr_request(id, "account", &BTreeMap::new()).await?;
    let regions = vultr_pages(id, "regions", "regions").await?;
    let region_ids = regions.iter().filter_map(|item| item.get("id").and_then(Value::as_str).map(String::from)).collect::<Vec<_>>();
    Ok(json!({
        "provider": "vultr", "verified": true, "region_count": region_ids.len(), "regions": region_ids,
        "default_region": regions.first().and_then(|item| item.get("id")).cloned().unwrap_or(json!("ewr")),
        "account": account.get("account").cloned().unwrap_or(account),
    }))
}

fn ensure_aliyun_account(id: i64) -> Result<(), String> {
    let conn = open_db()?;
    let cloud_type: String = conn.query_row("SELECT cloud_type FROM cloud_accounts WHERE id=?1", [id], |row| row.get(0))
        .map_err(|e| format!("读取云账号失败: {e}"))?;
    if cloud_type != "aliyun" {
        return Err(format!("{}资源 API 尚未接入", if cloud_type == "tencent" { "腾讯云" } else { "当前云类型" }));
    }
    Ok(())
}

fn account_cloud_type(id: i64) -> Result<String, String> {
    open_db()?.query_row("SELECT cloud_type FROM cloud_accounts WHERE id=?1", [id], |row| row.get(0))
        .map_err(|e| format!("读取云账号失败: {e}"))
}

fn account_region_id(id: i64) -> Result<String, String> {
    open_db()?.query_row("SELECT region_id FROM cloud_accounts WHERE id=?1", [id], |row| row.get::<_, Option<String>>(0))
        .map(|region| region.filter(|value| !value.is_empty()).unwrap_or_else(|| "ap-guangzhou".into()))
        .map_err(|e| format!("读取云账号失败: {e}"))
}

fn volc_region_id(id: i64) -> Result<String, String> {
    open_db()?.query_row("SELECT region_id FROM cloud_accounts WHERE id=?1", [id], |row| row.get::<_, Option<String>>(0))
        .map(|region| region.filter(|value| !value.is_empty()).unwrap_or_else(|| "cn-beijing".into()))
        .map_err(|e| format!("读取云账号失败: {e}"))
}

fn ensure_tencent_account(id: i64) -> Result<(), String> {
    let cloud_type = account_cloud_type(id)?;
    if cloud_type != "tencent" { return Err("当前账号不是腾讯云账号".into()); }
    Ok(())
}

#[tauri::command]
fn reveal_account_secret(id: i64) -> Result<String, String> {
    let conn = open_db()?;
    let ciphertext: String = conn.query_row("SELECT secret_ciphertext FROM cloud_accounts WHERE id=?1", [id], |row| row.get(0))
        .map_err(|e| format!("读取账号 Secret 失败: {e}"))?;
    decrypt_secret(&ciphertext)
}

// Aliyun RPC uses RFC3986 encoding: only ALPHA / DIGIT / - . _ ~ remain unescaped.
const RPC_ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

fn rpc_encode(value: &str) -> String {
    utf8_percent_encode(value, RPC_ENCODE_SET).to_string()
}

async fn aliyun_rpc(
    endpoint: &str, version: &str, action: &str, params: BTreeMap<String, String>,
    access_key_id: &str, access_key_secret: &str,
) -> Result<Value, String> {
    let mut query = params;
    query.insert("AccessKeyId".into(), access_key_id.into());
    query.insert("Action".into(), action.into());
    query.insert("Format".into(), "JSON".into());
    query.insert("SignatureMethod".into(), "HMAC-SHA1".into());
    query.insert("SignatureNonce".into(), Uuid::new_v4().to_string());
    query.insert("SignatureVersion".into(), "1.0".into());
    query.insert("Timestamp".into(), Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string());
    query.insert("Version".into(), version.into());
    // Encode first, then sort by encoded key and encoded value as required by RPC signing.
    let mut encoded: Vec<(String, String)> = query.iter()
        .map(|(k, v)| (rpc_encode(k), rpc_encode(v)))
        .collect();
    encoded.sort_by(|a, b| a.cmp(b));
    let canonical = encoded.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&");
    let string_to_sign = format!("GET&%2F&{}", rpc_encode(&canonical));
    let mut mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(format!("{access_key_secret}&").as_bytes()).map_err(|e| e.to_string())?;
    mac.update(string_to_sign.as_bytes());
    query.insert("Signature".into(), B64.encode(mac.finalize().into_bytes()));
    let mut request_params: Vec<(String, String)> = query.iter()
        .map(|(k, v)| (rpc_encode(k), rpc_encode(v)))
        .collect();
    request_params.sort_by(|a, b| a.cmp(b));
    let url = format!("https://{endpoint}/?{}", request_params.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&"));
    let response = match reqwest::Client::new().get(url).timeout(std::time::Duration::from_secs(25)).send().await {
        Ok(response) => response,
        Err(error) => { let message = format!("阿里云请求失败: {error}"); write_api_log(access_key_id, endpoint, action, &json!(query), None, "失败", Some(&message)); return Err(message); }
    };
    let status = response.status();
    let data: Value = match response.json().await {
        Ok(data) => data,
        Err(error) => { let message = format!("阿里云返回解析失败: {error}"); write_api_log(access_key_id, endpoint, action, &json!(query), None, "失败", Some(&message)); return Err(message); }
    };
    let api_code = data.get("Code").and_then(Value::as_str);
    let api_error = api_code.is_some_and(|code| code != "200" && code != "Success");
    if !status.is_success() || api_error { let message = data.get("Message").and_then(Value::as_str).or_else(|| data.get("Code").and_then(Value::as_str)).unwrap_or("阿里云 API 返回错误"); write_api_log(access_key_id, endpoint, action, &json!(query), Some(&data), "失败", Some(message)); return Err(message.to_string()); }
    write_api_log(access_key_id, endpoint, action, &json!(query), Some(&data), "成功", None);
    Ok(data)
}

async fn tencent_request(
    service: &str, version: &str, action: &str, payload: Value, region: Option<&str>,
    access_key_id: &str, access_key_secret: &str,
) -> Result<Value, String> {
    let host = format!("{service}.tencentcloudapi.com");
    let timestamp = Utc::now().timestamp();
    let date = Utc::now().format("%Y-%m-%d").to_string();
    let body = serde_json::to_string(&payload).map_err(|e| format!("腾讯云请求序列化失败: {e}"))?;
    let payload_hash = format!("{:x}", Sha256::digest(body.as_bytes()));
    let canonical_headers = format!("content-type:application/json; charset=utf-8\nhost:{host}\n");
    let signed_headers = "content-type;host";
    let canonical_request = format!("POST\n/\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let credential_scope = format!("{date}/{service}/tc3_request");
    let string_to_sign = format!("TC3-HMAC-SHA256\n{timestamp}\n{credential_scope}\n{:x}", Sha256::digest(canonical_request.as_bytes()));
    let sign = |key: &[u8], value: &str| -> Result<Vec<u8>, String> {
        let mut mac: Hmac<Sha256> = <Hmac<Sha256> as Mac>::new_from_slice(key).map_err(|e| e.to_string())?;
        mac.update(value.as_bytes());
        Ok(mac.finalize().into_bytes().to_vec())
    };
    let secret_date = sign(format!("TC3{access_key_secret}").as_bytes(), &date)?;
    let secret_service = sign(&secret_date, service)?;
    let secret_signing = sign(&secret_service, "tc3_request")?;
    let signature = hex::encode(sign(&secret_signing, &string_to_sign)?);
    let authorization = format!("TC3-HMAC-SHA256 Credential={access_key_id}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}");
    let mut request = reqwest::Client::new().post(format!("https://{host}/"))
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Host", &host)
        .header("Authorization", authorization)
        .header("X-TC-Action", action)
        .header("X-TC-Version", version)
        .header("X-TC-Timestamp", timestamp.to_string())
        .body(body)
        .timeout(std::time::Duration::from_secs(25));
    if let Some(region) = region.filter(|value| !value.is_empty()) { request = request.header("X-TC-Region", region); }
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => { let message = format!("腾讯云请求失败: {error}"); write_api_log(access_key_id, &host, action, &payload, None, "失败", Some(&message)); return Err(message); }
    };
    let status = response.status();
    let data: Value = match response.json().await {
        Ok(data) => data,
        Err(error) => { let message = format!("腾讯云返回解析失败: {error}"); write_api_log(access_key_id, &host, action, &payload, None, "失败", Some(&message)); return Err(message); }
    };
    if !status.is_success() || data.pointer("/Response/Error").is_some() {
        let message = data.pointer("/Response/Error/Message").and_then(Value::as_str)
            .or_else(|| data.pointer("/Response/Error/Code").and_then(Value::as_str))
            .unwrap_or("腾讯云 API 返回错误");
        write_api_log(access_key_id, &host, action, &payload, Some(&data), "失败", Some(message));
        return Err(message.into());
    }
    write_api_log(access_key_id, &host, action, &payload, Some(&data), "成功", None);
    Ok(data.get("Response").cloned().unwrap_or(Value::Null))
}

fn ctyun_sign(key: &[u8], value: &str) -> Result<Vec<u8>, String> {
    let mut mac: Hmac<Sha256> = <Hmac<Sha256> as Mac>::new_from_slice(key).map_err(|error| error.to_string())?;
    mac.update(value.as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}

fn ctyun_total(data: &Value) -> Option<usize> {
    ["totalCount", "total", "totalNum", "totalSize"].into_iter()
        .filter_map(|key| data.get(key))
        .find_map(|value| value.as_u64().map(|value| value as usize).or_else(|| value.as_str()?.parse::<usize>().ok()))
        .or_else(|| data.get("pageInfo").or_else(|| data.get("page")).and_then(|page| page.get("total")).and_then(|value| value.as_u64().map(|value| value as usize).or_else(|| value.as_str()?.parse::<usize>().ok())))
}

async fn ctyun_pages<F, Fut>(mut fetch_page: F, path: &[&str], page_size: usize) -> Result<Vec<Value>, String>
where
    F: FnMut(usize) -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    let mut items = Vec::new();
    for page in 1..=100 {
        let data = fetch_page(page).await?;
        let current = array_at(&data, path).into_iter().cloned().collect::<Vec<_>>();
        let count = current.len();
        items.extend(current);
        if count == 0 || count < page_size || ctyun_total(&data).is_some_and(|total| items.len() >= total) { return Ok(items); }
    }
    Err("分页超过 100 页，已停止读取".into())
}

async fn ctyun_request(
    endpoint: &str, method: reqwest::Method, path: &str, payload: Option<Value>, query: BTreeMap<String, String>,
    access_key_id: &str, access_key_secret: &str,
) -> Result<Value, String> {
    ctyun_request_with_headers(endpoint, method, path, payload, query, BTreeMap::new(), access_key_id, access_key_secret).await
}

async fn ctyun_request_with_headers(
    endpoint: &str, method: reqwest::Method, path: &str, payload: Option<Value>, query: BTreeMap<String, String>, extra_headers: BTreeMap<String, String>,
    access_key_id: &str, access_key_secret: &str,
) -> Result<Value, String> {
    let query = query.into_iter().map(|(key, value)| format!("{}={}", rpc_encode(&key), rpc_encode(&value))).collect::<Vec<_>>().join("&");
    let body = match payload { Some(value) => serde_json::to_string(&value).map_err(|error| format!("天翼云请求序列化失败: {error}"))?, None => String::new() };
    let datetime = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let request_id = Uuid::new_v4().to_string();
    let payload_hash = format!("{:x}", Sha256::digest(body.as_bytes()));
    let string_to_sign = format!("ctyun-eop-request-id:{request_id}\neop-date:{datetime}\n\n{query}\n{payload_hash}");
    let date_key = ctyun_sign(access_key_secret.as_bytes(), &datetime)?;
    let ak_key = ctyun_sign(&date_key, access_key_id)?;
    let signing_key = ctyun_sign(&ak_key, &datetime[..8])?;
    let signature = B64.encode(ctyun_sign(&signing_key, &string_to_sign)?);
    let authorization = format!("{access_key_id} Headers=ctyun-eop-request-id;eop-date Signature={signature}");
    let url = format!("https://{endpoint}{path}{}", if query.is_empty() { String::new() } else { format!("?{query}") });
    let mut request = reqwest::Client::new().request(method, url)
        .header("ctyun-eop-request-id", request_id).header("Eop-date", datetime).header("Eop-Authorization", authorization)
        .timeout(std::time::Duration::from_secs(25));
    for (key, value) in extra_headers { request = request.header(key, value); }
    if !body.is_empty() { request = request.header("Content-Type", "application/json").body(body); }
    let response = request.send().await.map_err(|error| format!("天翼云请求失败: {error}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|error| format!("天翼云返回读取失败: {error}"))?;
    let data: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({"message": text}));
    let code = data.get("code").or_else(|| data.get("statusCode")).and_then(|value| match value { Value::String(value) => Some(value.clone()), Value::Number(value) => Some(value.to_string()), _ => None }).unwrap_or_default();
    if !status.is_success() || (!code.is_empty() && !["0", "200", "800", "Success", "SUCCESS"].contains(&code.as_str())) {
        let message = data.get("message").or_else(|| data.get("msg")).or_else(|| data.pointer("/error/message")).and_then(Value::as_str).unwrap_or_else(|| if code.is_empty() { "天翼云 API 返回错误" } else { &code });
        return Err(message.into());
    }
    Ok(data.get("returnObj").or_else(|| data.get("result")).cloned().unwrap_or(data))
}

fn ctyun_instance(item: &Value, region: &str) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        let instance_id = item.get("InstanceID").or_else(|| item.get("instanceID")).or_else(|| item.get("ResourceID")).or_else(|| item.get("resourceID")).cloned().unwrap_or(json!(""));
        let name = item.get("InstanceName").or_else(|| item.get("instanceName")).or_else(|| item.get("DisplayName")).or_else(|| item.get("displayName")).cloned().unwrap_or(instance_id.clone());
        let status = item.get("InstanceStatus").or_else(|| item.get("instanceStatus")).or_else(|| item.get("State")).or_else(|| item.get("state")).cloned().unwrap_or(json!(""));
        target.insert("InstanceId".into(), instance_id); target.insert("InstanceName".into(), name); target.insert("InstanceStatus".into(), status.clone()); target.insert("Status".into(), status);
        target.insert("PublicIpAddress".into(), item.get("FloatingIP").or_else(|| item.get("floatingIP")).or_else(|| item.get("PublicIP")).or_else(|| item.get("publicIP")).cloned().unwrap_or(json!("")));
        target.insert("PrivateIpAddress".into(), item.get("PrivateIP").or_else(|| item.get("privateIP")).or_else(|| item.get("FixedIP")).or_else(|| item.get("fixedIP")).cloned().unwrap_or(json!("")));
        target.insert("VpcId".into(), item.get("VpcID").or_else(|| item.get("vpcID")).or_else(|| item.get("VpcId")).cloned().unwrap_or(json!("")));
        target.insert("InstanceType".into(), item.get("InstanceType").or_else(|| item.get("instanceType")).or_else(|| item.get("FlavorName")).or_else(|| item.get("flavorName")).cloned().unwrap_or(json!("")));
        target.insert("_region_id".into(), json!(region));
    }
    value
}

fn ctyun_domain(item: &Value, region: &str) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        let name = item.get("name").or_else(|| item.get("ZoneName")).or_else(|| item.get("zoneName")).or_else(|| item.get("zoneID")).cloned().unwrap_or(json!(""));
        target.insert("DomainName".into(), name); target.insert("DomainStatus".into(), json!("私有 DNS"));
        target.insert("ZoneId".into(), item.get("zoneID").or_else(|| item.get("ZoneID")).cloned().unwrap_or(json!("")));
        target.insert("RecordCount".into(), item.get("recordCount").cloned().unwrap_or(json!(0))); target.insert("_region_id".into(), json!(region));
        target.insert("_ctyun_private_zone".into(), json!(true));
    }
    value
}

fn ctyun_rds_instance(item: &Value, region: &str) -> Value {
    let running = item.get("prodRunningStatus").and_then(Value::as_i64) == Some(0) || item.get("prodRunningStatus").and_then(Value::as_str).is_some_and(|value| value.eq_ignore_ascii_case("running"));
    json!({
        "DBInstanceId": item.get("outerProdInstId").or_else(|| item.get("prodInstId")).cloned().unwrap_or(json!("")),
        "DBInstanceDescription": item.get("prodInstName").or_else(|| item.get("outerProdInstId")).cloned().unwrap_or(json!("")),
        "DBInstanceStatus": if running { json!("Running") } else { item.get("prodRunningStatus").or_else(|| item.get("alive")).cloned().unwrap_or(json!("Unknown")) },
        "DBInstanceType": item.get("prodType").cloned().unwrap_or(json!("")), "DBInstanceClass": item.get("machineSpec").or_else(|| item.get("resources")).cloned().unwrap_or(json!("")),
        "DBInstanceStorage": item.get("diskSize").cloned().unwrap_or(json!(0)), "ConnectionString": item.get("vip").cloned().unwrap_or(json!("")), "Port": item.get("writePort").cloned().unwrap_or(json!("")),
        "Engine": item.get("prodDbEngine").cloned().unwrap_or(json!("MySQL")), "EngineVersion": item.get("newMysqlVersion").or_else(|| item.get("dbMysqlVersion")).cloned().unwrap_or(json!("")),
        "CreateTime": item.get("createTime").cloned().unwrap_or(json!("")), "ExpireTime": item.get("expireTime").cloned().unwrap_or(json!("")), "_region_id": region, "_raw": item,
    })
}

fn ctyun_redis_instance(item: &Value, region: &str) -> Value {
    let normal = item.get("status").and_then(Value::as_i64) == Some(0) || item.get("statusName").and_then(Value::as_str).is_some_and(|value| value.eq_ignore_ascii_case("normal"));
    let capacity = item.get("capacity").and_then(|value| value.as_f64().or_else(|| value.as_str()?.parse().ok())).unwrap_or(0.0) * 1024.0;
    json!({
        "InstanceId": item.get("prodInstId").or_else(|| item.get("user")).cloned().unwrap_or(json!("")), "InstanceName": item.get("instanceName").or_else(|| item.get("prodInstId")).cloned().unwrap_or(json!("")),
        "InstanceStatus": if normal { json!("Normal") } else { item.get("statusName").or_else(|| item.get("status")).cloned().unwrap_or(json!("Unknown")) },
        "InstanceType": item.get("archTypeName").or_else(|| item.get("archType")).cloned().unwrap_or(json!("")), "InstanceClass": item.get("capacityInfo").or_else(|| item.get("capacity")).cloned().unwrap_or(json!("")),
        "Capacity": capacity, "ConnectionDomain": item.get("connectionAddress").or_else(|| item.get("vip")).cloned().unwrap_or(json!("")), "Port": item.get("vipPort").cloned().unwrap_or(json!("")),
        "EngineVersion": item.get("engineVersionName").or_else(|| item.get("engineVersion")).cloned().unwrap_or(json!("")), "NetworkType": item.get("netName").cloned().unwrap_or(json!("")),
        "EndTime": item.get("expTime").or_else(|| item.get("expiration")).cloned().unwrap_or(json!("")), "ArchitectureType": item.get("archTypeName").or_else(|| item.get("archType")).cloned().unwrap_or(json!("")), "_region_id": region, "_raw": item,
    })
}

fn ctyun_bucket(item: &Value, fallback_region: &str) -> Value {
    let region = item.get("regionID").or_else(|| item.get("RegionID")).and_then(Value::as_str).unwrap_or(fallback_region);
    json!({
        "Name": item.get("bucket").or_else(|| item.get("Bucket")).cloned().unwrap_or(json!("")), "Location": region,
        "CreationDate": item.get("creationDate").or_else(|| item.get("CreationDate")).cloned().unwrap_or(json!("")),
        "StorageClass": item.get("storageType").or_else(|| item.get("StorageType")).cloned().unwrap_or(json!("STANDARD")),
        "Acl": "private", "ExtranetEndpoint": "-", "IntranetEndpoint": "-", "_region_id": region, "_raw": item,
    })
}

async fn ctyun_resource_items(id: i64, resource_type: &str, access_key_id: &str, access_key_secret: &str) -> ResourceResponse {
    let mut items = Vec::new(); let mut errors = Vec::new();
    let fallback = account_region_id(id).unwrap_or_else(|_| "cn-huabei-9".into());
    let regions = match ctyun_request("ctecs-global.ctapi.ctyun.cn", reqwest::Method::GET, "/v4/region/list-regions", None, BTreeMap::new(), access_key_id, access_key_secret).await {
        Ok(data) => { let mut values = array_at(&data, &["regionList"]).into_iter().filter_map(|item| item.get("regionID").or_else(|| item.get("RegionID")).and_then(Value::as_str).filter(|value| !value.is_empty()).map(String::from)).collect::<Vec<_>>(); values.push(fallback.clone()); values.sort(); values.dedup(); values },
        Err(_) => vec![fallback],
    };
    match resource_type {
        "ecs" => for region in &regions {
            let region_id = region.clone();
            match ctyun_pages(|page_no| ctyun_request("ctecs-global.ctapi.ctyun.cn", reqwest::Method::POST, "/v4/ecs/list-instances", Some(json!({"regionID": region_id, "pageNo": page_no, "pageSize": 100})), BTreeMap::new(), access_key_id, access_key_secret), &["results"], 100).await {
                Ok(values) => items.extend(values.iter().map(|item| ctyun_instance(item, region))), Err(error) => errors.push(format!("{region}: {error}")),
            }
        },
        "domain" => for region in &regions {
            let region_id = region.clone();
            match ctyun_pages(|page_no| ctyun_request("ctvpc-global.ctapi.ctyun.cn", reqwest::Method::GET, "/v4/private-zone/list", None, string_params(&[("regionID", region_id.clone()), ("pageNo", page_no.to_string()), ("pageSize", "50".into())]), access_key_id, access_key_secret), &["zones"], 50).await {
                Ok(values) => items.extend(values.iter().map(|item| ctyun_domain(item, region))), Err(error) => errors.push(format!("{region}: {error}")),
            }
        },
        "rds" => for region in &regions {
            let region_id = region.clone();
            match ctyun_pages(|page_now| ctyun_request_with_headers("rds2-global.ctapi.ctyun.cn", reqwest::Method::POST, "/RDS2/v1/open-api/instance/instance-list", Some(json!({"pageNow": page_now, "pageSize": 100})), BTreeMap::new(), string_params(&[("regionId", region_id.clone())]), access_key_id, access_key_secret), &["list"], 100).await {
                Ok(values) => items.extend(values.iter().map(|item| ctyun_rds_instance(item, region))), Err(error) => errors.push(format!("{region}: {error}")),
            }
        },
        "redis" => for region in &regions {
            let region_id = region.clone();
            match ctyun_pages(|page_index| ctyun_request_with_headers("dcs2-global.ctapi.ctyun.cn", reqwest::Method::GET, "/v2/instanceManageMgrServant/describeInstances", None, string_params(&[("pageIndex", page_index.to_string()), ("pageSize", "100".into())]), string_params(&[("regionId", region_id.clone())]), access_key_id, access_key_secret), &["rows"], 100).await {
                Ok(values) => items.extend(values.iter().map(|item| ctyun_redis_instance(item, region))), Err(error) => errors.push(format!("{region}: {error}")),
            }
        },
        "oss" => match ctyun_request("zos-global.ctapi.ctyun.cn", reqwest::Method::GET, "/v4/oss/list-regions", None, BTreeMap::new(), access_key_id, access_key_secret).await {
            Ok(data) => {
                let mut oss_regions = array_at(&data, &[]).into_iter().filter_map(|item| item.get("regionID").or_else(|| item.get("RegionID")).and_then(Value::as_str).map(String::from)).collect::<Vec<_>>();
                oss_regions.push("public".into()); oss_regions.sort(); oss_regions.dedup();
                for region in oss_regions {
                    let region_id = region.clone();
                    match ctyun_pages(|page_no| ctyun_request("zos-global.ctapi.ctyun.cn", reqwest::Method::GET, "/v4/oss/list-buckets", None, string_params(&[("regionID", region_id.clone()), ("pageNo", page_no.to_string()), ("pageSize", "50".into())]), access_key_id, access_key_secret), &["bucketList"], 50).await {
                        Ok(values) => items.extend(values.iter().map(|item| ctyun_bucket(item, &region))), Err(error) => errors.push(format!("{region}: {error}")),
                    }
                }
            },
            Err(error) => errors.push(error),
        },
        _ => errors.push(format!("天翼云暂未提供 {resource_type} 对应的统一只读清单 API")),
    }
    ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: Utc::now().timestamp_millis() }
}

#[tauri::command]
async fn verify_ctyun_account(id: i64) -> Result<Value, String> {
    if account_cloud_type(id)? != "ctyun" { return Err("当前账号不是天翼云账号".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let fallback = account_region_id(id).unwrap_or_else(|_| "cn-huabei-9".into());
    let data = ctyun_request("ctecs-global.ctapi.ctyun.cn", reqwest::Method::GET, "/v4/region/list-regions", None, BTreeMap::new(), &access_key_id, &access_key_secret).await?;
    let mut regions = array_at(&data, &["regionList"]).into_iter().filter_map(|item| item.get("regionID").or_else(|| item.get("RegionID")).and_then(Value::as_str).filter(|value| !value.is_empty()).map(String::from)).collect::<Vec<_>>();
    if !regions.contains(&fallback) { regions.push(fallback.clone()); }
    regions.sort(); regions.dedup();
    if regions.is_empty() { return Err("未读取到可用地域，请检查 AccessKey、SecretKey 与 EOP 权限".into()); }
    Ok(json!({"provider": "ctyun", "verified": true, "region_count": regions.len(), "regions": regions, "default_region": fallback}))
}

fn huawei_encode(value: &str) -> String { rpc_encode(value) }

fn huawei_canonical_uri(path: &str) -> String {
    let value = path.split('/').map(|part| huawei_encode(part)).collect::<Vec<_>>().join("/");
    if value.is_empty() { "/".into() } else { value }
}

fn huawei_query(query: &BTreeMap<String, String>) -> String {
    let mut values = query.iter().filter(|(_, value)| !value.is_empty()).map(|(key, value)| (huawei_encode(key), huawei_encode(value))).collect::<Vec<_>>();
    values.sort(); values.into_iter().map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>().join("&")
}

fn huawei_error(data: &Value, status: reqwest::StatusCode) -> String {
    data.get("error_msg").or_else(|| data.get("message")).or_else(|| data.pointer("/error/message")).or_else(|| data.get("code")).and_then(Value::as_str).unwrap_or(&format!("华为云 {status}")).to_string()
}

async fn huawei_request(id: i64, host: &str, path: &str, query: BTreeMap<String, String>) -> Result<Value, String> {
    if account_cloud_type(id)? != "huawei" { return Err("当前账号不是华为云账号".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let query_text = huawei_query(&query);
    let canonical_uri = huawei_canonical_uri(path);
    let date = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let canonical_headers = format!("host:{host}\nx-sdk-date:{date}\n");
    let payload_hash = format!("{:x}", Sha256::digest(b""));
    let canonical_request = format!("GET\n{canonical_uri}\n{query_text}\n{canonical_headers}\nhost;x-sdk-date\n{payload_hash}");
    let string_to_sign = format!("SDK-HMAC-SHA256\n{date}\n{:x}", Sha256::digest(canonical_request.as_bytes()));
    let mut mac: Hmac<Sha256> = <Hmac<Sha256> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|error| error.to_string())?;
    mac.update(string_to_sign.as_bytes());
    let authorization = format!("SDK-HMAC-SHA256 Access={access_key_id}, SignedHeaders=host;x-sdk-date, Signature={}", hex::encode(mac.finalize().into_bytes()));
    let url = format!("https://{host}{canonical_uri}{}", if query_text.is_empty() { String::new() } else { format!("?{query_text}") });
    let response = reqwest::Client::new().get(url).header("Host", host).header("X-Sdk-Date", &date).header("Authorization", authorization).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("华为云请求失败: {error}"))?;
    let status = response.status(); let text = response.text().await.map_err(|error| format!("华为云返回读取失败: {error}"))?;
    let data: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({"message": text}));
    if !status.is_success() { let message = huawei_error(&data, status); write_api_log(&access_key_id, host, &format!("GET {path}"), &json!(query), Some(&data), "失败", Some(&message)); return Err(message); }
    write_api_log(&access_key_id, host, &format!("GET {path}"), &json!(query), Some(&data), "成功", None);
    Ok(data)
}

async fn huawei_offset_pages<F, Fut>(mut fetch_page: F, path: &[&str], page_size: usize) -> Result<Vec<Value>, String>
where
    F: FnMut(usize) -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    let mut items = Vec::new();
    for offset in (0..10_000).step_by(page_size) {
        let data = fetch_page(offset).await?;
        let page = array_at(&data, path).into_iter().cloned().collect::<Vec<_>>();
        let count = page.len(); items.extend(page);
        if count < page_size { return Ok(items); }
    }
    Err("分页超过 100 页，已停止读取".into())
}

async fn huawei_context(id: i64) -> Result<(String, Vec<Value>), String> {
    let default_region = open_db()?.query_row("SELECT region_id FROM cloud_accounts WHERE id=?1", [id], |row| row.get::<_, Option<String>>(0)).map_err(|error| error.to_string())?.filter(|value| !value.trim().is_empty()).unwrap_or_else(|| "cn-north-4".into());
    let data = huawei_request(id, &format!("iam.{default_region}.myhuaweicloud.com"), "/v3/projects", string_params(&[("enabled", "true".into())])).await?;
    let projects = array_at(&data, &["projects"]).into_iter().filter(|project| project.get("id").and_then(Value::as_str).is_some_and(|value| !value.is_empty()) && project.get("name").and_then(Value::as_str).is_some_and(|value| !value.is_empty()) && project.get("status").and_then(Value::as_str).map(|value| value.eq_ignore_ascii_case("enabled")).unwrap_or(true)).cloned().collect::<Vec<_>>();
    if projects.is_empty() { return Err("未读取到可用项目，请检查 IAM 项目权限".into()); }
    Ok((default_region, projects))
}

fn huawei_instance(item: &Value, region: &str, project: &Value) -> Value {
    let addresses = item.get("addresses").and_then(Value::as_object).into_iter().flat_map(|group| group.values()).filter_map(Value::as_array).flatten().collect::<Vec<_>>();
    let public_ip = addresses.iter().find(|address| address.get("OS-EXT-IPS:type").and_then(Value::as_str).is_some_and(|kind| kind.eq_ignore_ascii_case("floating"))).and_then(|address| address.get("addr")).cloned().unwrap_or(json!(""));
    let private_ip = addresses.iter().find(|address| !address.get("OS-EXT-IPS:type").and_then(Value::as_str).is_some_and(|kind| kind.eq_ignore_ascii_case("floating"))).and_then(|address| address.get("addr")).cloned().unwrap_or(json!(""));
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        target.insert("InstanceId".into(), item.get("id").cloned().unwrap_or(json!(""))); target.insert("InstanceName".into(), item.get("name").or_else(|| item.get("id")).cloned().unwrap_or(json!("")));
        target.insert("InstanceStatus".into(), item.get("status").cloned().unwrap_or(json!(""))); target.insert("Status".into(), item.get("status").cloned().unwrap_or(json!("")));
        target.insert("PublicIpAddress".into(), public_ip); target.insert("PrivateIpAddress".into(), private_ip); target.insert("InstanceType".into(), item.pointer("/flavor/id").or_else(|| item.pointer("/flavor/name")).cloned().unwrap_or(json!("")));
        target.insert("VpcId".into(), item.pointer("/metadata/vpc_id").cloned().unwrap_or(json!(""))); target.insert("_region_id".into(), json!(region)); target.insert("_project_id".into(), project.get("id").cloned().unwrap_or(json!("")));
    }
    value
}

fn huawei_rds(item: &Value, region: &str, project: &Value) -> Value {
    json!({"DBInstanceId": item.get("id"), "DBInstanceDescription": item.get("name").or_else(|| item.get("id")), "DBInstanceStatus": item.get("status"), "DBInstanceClass": item.get("flavor_ref").or_else(|| item.pointer("/flavor/id")), "DBInstanceStorage": item.pointer("/volume/size").unwrap_or(&json!(0)), "ConnectionString": item.pointer("/private_ips/0").or_else(|| item.pointer("/nodes/0/private_ip")), "Port": item.get("port"), "Engine": item.pointer("/datastore/type"), "EngineVersion": item.pointer("/datastore/version"), "CreateTime": item.get("created"), "_region_id": region, "_project_id": project.get("id"), "_raw": item})
}

fn huawei_redis(item: &Value, region: &str, project: &Value) -> Value {
    let capacity = item.get("capacity").and_then(|value| value.as_f64().or_else(|| value.as_str()?.parse().ok())).unwrap_or(0.0) * 1024.0;
    json!({"InstanceId": item.get("instance_id").or_else(|| item.get("id")), "InstanceName": item.get("name").or_else(|| item.get("instance_id")).or_else(|| item.get("id")), "InstanceStatus": item.get("status").or_else(|| item.get("operating_status")), "InstanceType": item.get("engine").unwrap_or(&json!("Redis")), "InstanceClass": item.get("specification").or_else(|| item.get("capacity")), "Capacity": capacity, "ConnectionDomain": item.get("ip").or_else(|| item.get("private_ip")), "Port": item.get("port"), "EngineVersion": item.get("engine_version"), "NetworkType": item.get("vpc_name"), "_region_id": region, "_project_id": project.get("id"), "_raw": item})
}

fn huawei_zone(item: &Value) -> Value {
    let name = item.get("name").and_then(Value::as_str).unwrap_or("").trim_end_matches('.');
    json!({"DomainName": name, "DomainStatus": item.get("status").unwrap_or(&json!("ACTIVE")), "ZoneId": item.get("id"), "RecordCount": item.get("record_num").unwrap_or(&json!(0)), "RegistrationDate": item.get("created_at"), "_region_id": "cn-north-4", "_huawei_public_zone": true, "_raw": item})
}

async fn huawei_obs_buckets(id: i64, region: &str) -> Result<Vec<Value>, String> {
    if account_cloud_type(id)? != "huawei" { return Err("当前账号不是华为云账号".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let host = format!("obs.{region}.myhuaweicloud.com"); let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    let mut mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|error| error.to_string())?;
    mac.update(format!("GET\n\n\n{date}\n/").as_bytes());
    let response = reqwest::Client::new().get(format!("https://{host}/")).header("Date", &date).header("Host", &host).header("Authorization", format!("OBS {access_key_id}:{}", B64.encode(mac.finalize().into_bytes()))).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("OBS 请求失败: {error}"))?;
    let status = response.status(); let body = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() { let message = format!("OBS {status}: {}", { let value = xml_text(&body, "Message"); if value.is_empty() { xml_text(&body, "Code") } else { value } }); write_api_log(&access_key_id, &host, "ListBuckets", &json!({}), Some(&json!({"body": body})), "失败", Some(&message)); return Err(message); }
    let buckets = xml_blocks(&body, "Bucket").into_iter().map(|bucket| { let name = xml_text(&bucket, "Name"); let location = { let value = xml_text(&bucket, "Location"); if value.is_empty() { region.to_string() } else { value } }; json!({"Name": name, "BucketName": name, "Location": location, "CreationDate": xml_text(&bucket, "CreationDate"), "StorageClass": "STANDARD", "Acl": "private", "ExtranetEndpoint": "-", "IntranetEndpoint": "-", "_region_id": location}) }).filter(|bucket| bucket.get("Name").and_then(Value::as_str).is_some_and(|value| !value.is_empty())).collect::<Vec<_>>();
    write_api_log(&access_key_id, &host, "ListBuckets", &json!({}), Some(&json!({"count": buckets.len()})), "成功", None); Ok(buckets)
}

async fn huawei_resource_items(id: i64, resource_type: &str) -> ResourceResponse {
    let now = Utc::now().timestamp_millis();
    let (default_region, projects) = match huawei_context(id).await { Ok(value) => value, Err(error) => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![error], fetched_at: now } };
    let mut items = Vec::new(); let mut errors = Vec::new();
    if resource_type == "domain" {
        match huawei_offset_pages(|offset| huawei_request(id, "dns.cn-north-4.myhuaweicloud.com", "/v2/zones", string_params(&[("limit", "500".into()), ("offset", offset.to_string())])), &["zones"], 500).await { Ok(values) => items.extend(values.into_iter().map(|item| huawei_zone(&item))), Err(error) => errors.push(format!("cn-north-4: {error}")), }
        return ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now };
    }
    if resource_type == "oss" {
        let mut regions = projects.iter().filter_map(|project| project.get("name").and_then(Value::as_str)).map(String::from).collect::<Vec<_>>(); regions.push(default_region); regions.sort(); regions.dedup();
        for region in regions { match huawei_obs_buckets(id, &region).await { Ok(values) => items.extend(values), Err(error) => errors.push(format!("{region}: {error}")), } }
        let mut unique = BTreeMap::new(); for item in items { if let Some(name) = item.get("Name").and_then(Value::as_str) { unique.insert(name.to_string(), item); } }
        return ResourceResponse { resource_type: resource_type.into(), items: unique.into_values().collect(), errors, fetched_at: now };
    }
    let service = match resource_type { "ecs" => Some(("ecs", "/v1/{project}/cloudservers/detail", "servers")), "rds" => Some(("rds", "/v3/{project}/instances", "instances")), "redis" => Some(("dcs", "/v2/{project}/instances", "instances")), _ => None };
    let Some((service_name, path_template, response_path)) = service else { return ResourceResponse { resource_type: resource_type.into(), items, errors: vec![format!("华为云暂未接入 {resource_type} 资源")], fetched_at: now }; };
    for project in &projects {
        let region = project.get("name").and_then(Value::as_str).unwrap_or(""); let project_id = project.get("id").and_then(Value::as_str).unwrap_or("");
        if region.is_empty() || project_id.is_empty() { continue; }
        let path = path_template.replace("{project}", &huawei_encode(project_id)); let host = format!("{service_name}.{region}.myhuaweicloud.com");
        match huawei_offset_pages(|offset| huawei_request(id, &host, &path, string_params(&[("limit", "100".into()), ("offset", offset.to_string())])), &[response_path], 100).await {
            Ok(values) => for item in values { items.push(match resource_type { "ecs" => huawei_instance(&item, region, project), "rds" => huawei_rds(&item, region, project), "redis" => huawei_redis(&item, region, project), _ => item }); },
            Err(error) => errors.push(format!("{region}: {error}")),
        }
    }
    ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now }
}

#[tauri::command]
async fn verify_huawei_account(id: i64) -> Result<Value, String> {
    let (default_region, projects) = huawei_context(id).await?;
    let mut regions = projects.iter().filter_map(|project| project.get("name").and_then(Value::as_str)).map(String::from).collect::<Vec<_>>(); regions.sort(); regions.dedup();
    Ok(json!({"provider": "huawei", "verified": true, "region_count": regions.len(), "regions": regions, "default_region": default_region, "project_count": projects.len()}))
}

fn baidu_encode(value: &str) -> String { rpc_encode(value) }

fn baidu_canonical_uri(path: &str) -> String {
    let value = path.split('/').map(|part| baidu_encode(part)).collect::<Vec<_>>().join("/");
    if value.is_empty() { "/".into() } else { value }
}

fn baidu_query(query: &BTreeMap<String, String>, include_empty: bool) -> String {
    let mut values = query.iter().filter(|(_, value)| include_empty || !value.is_empty()).map(|(key, value)| (baidu_encode(key), baidu_encode(value))).collect::<Vec<_>>();
    values.sort(); values.into_iter().map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>().join("&")
}

fn baidu_canonical_headers(headers: &[(&str, &str)]) -> String {
    let mut values = headers.iter()
        .map(|(name, value)| (name.to_ascii_lowercase(), value.trim()))
        .filter(|(_, value)| !value.is_empty())
        .map(|(name, value)| format!("{}:{}", baidu_encode(&name), baidu_encode(value)))
        .collect::<Vec<_>>();
    values.sort(); values.join("\n")
}

fn baidu_error_message(message: String) -> String {
    if message.contains("BceServiceRole_console_dns") {
        "DNS 服务未完成控制台服务角色授权。请用主账号登录百度智能云控制台并开通/访问一次智能云解析 DNS，或为当前子用户授予 DNS 只读权限后重试。".into()
    } else { message }
}

const BAIDU_BCC_REGIONS: [&str; 6] = ["bj", "bd", "gz", "su", "hkg", "fwh"];

fn baidu_regions(id: i64) -> Result<Vec<String>, String> {
    let value: Option<String> = open_db()?.query_row("SELECT region_id FROM cloud_accounts WHERE id=?1", [id], |row| row.get(0)).map_err(|error| error.to_string())?;
    let mut regions = value.unwrap_or_else(|| "bj".into()).split(|character: char| character == ',' || character == '，' || character.is_whitespace()).filter(|value| !value.is_empty()).map(String::from).collect::<Vec<_>>();
    if regions.is_empty() { regions.push("bj".into()); }
    // BCC has region-specific endpoints only; include every standard region
    // so a legacy "bj" default cannot cause instances in other regions to vanish.
    for region in BAIDU_BCC_REGIONS { if !regions.iter().any(|value| value == region) { regions.push(region.into()); } }
    Ok(regions)
}

async fn baidu_request_with_options(id: i64, host: &str, path: &str, query: BTreeMap<String, String>, method: &str, body: Option<Value>, include_empty_query: bool) -> Result<(Value, String), String> {
    if account_cloud_type(id)? != "baidu" { return Err("当前账号不是百度智能云账号".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let canonical_uri = baidu_canonical_uri(path); let query_text = baidu_query(&query, include_empty_query);
    let date = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let auth_prefix = format!("bce-auth-v1/{access_key_id}/{date}/1800");
    let body_text = body.map(|value| serde_json::to_string(&value).map_err(|error| format!("BCC 请求体序列化失败: {error}"))).transpose()?;
    let content_length = body_text.as_ref().map(|value| value.len().to_string());
    let mut signed_header_values = vec![("host", host), ("x-bce-date", date.as_str())];
    if body_text.is_some() { signed_header_values.push(("content-type", "application/json")); signed_header_values.push(("content-length", content_length.as_deref().unwrap_or("0"))); }
    let canonical_headers = baidu_canonical_headers(&signed_header_values);
    let mut signed_header_names = signed_header_values.iter().map(|(name, _)| name.to_ascii_lowercase()).collect::<Vec<_>>(); signed_header_names.sort();
    let signed_headers = signed_header_names.join(";");
    let canonical_request = format!("{method}\n{canonical_uri}\n{query_text}\n{canonical_headers}");
    let mut key_mac: Hmac<Sha256> = <Hmac<Sha256> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|error| error.to_string())?;
    // BCE v1 signs the request with the hexadecimal text of the derived HMAC key.
    key_mac.update(auth_prefix.as_bytes()); let signing_key = hex::encode(key_mac.finalize().into_bytes());
    let mut signature_mac: Hmac<Sha256> = <Hmac<Sha256> as Mac>::new_from_slice(signing_key.as_bytes()).map_err(|error| error.to_string())?;
    signature_mac.update(canonical_request.as_bytes());
    let authorization = format!("{auth_prefix}/{signed_headers}/{}", hex::encode(signature_mac.finalize().into_bytes()));
    let url = format!("https://{host}{canonical_uri}{}", if query_text.is_empty() { String::new() } else { format!("?{query_text}") });
    let client = reqwest::Client::new();
    let mut request = match method { "PUT" => client.put(url), "POST" => client.post(url), "DELETE" => client.delete(url), _ => client.get(url) }
        .header("Host", host).header("X-Bce-Date", &date).header("Authorization", authorization).timeout(std::time::Duration::from_secs(30));
    if let Some(body) = body_text { request = request.header("Content-Type", "application/json").header("Content-Length", content_length.unwrap_or_default()).body(body); }
    let response = request.send().await.map_err(|error| format!("百度智能云请求失败: {error}"))?;
    let status = response.status(); let body = response.text().await.map_err(|error| format!("百度智能云返回读取失败: {error}"))?;
    let data: Value = serde_json::from_str(&body).unwrap_or_else(|_| json!({"message": body}));
    if !status.is_success() { let message = baidu_error_message(data.get("message").or_else(|| data.pointer("/error/message")).or_else(|| data.get("code")).and_then(Value::as_str).unwrap_or(&format!("百度智能云 {status}")).to_string()); write_api_log(&access_key_id, host, &format!("{method} {path}"), &json!(query), Some(&data), "失败", Some(&message)); return Err(message); }
    write_api_log(&access_key_id, host, &format!("{method} {path}"), &json!(query), Some(&data), "成功", None); Ok((data, body))
}

async fn baidu_request(id: i64, host: &str, path: &str, query: BTreeMap<String, String>) -> Result<(Value, String), String> {
    baidu_request_with_options(id, host, path, query, "GET", None, false).await
}

#[tauri::command]
async fn baidu_instance_action(id: i64, region_id: String, instance_id: String, action: String, force_stop: bool) -> Result<Value, String> {
    if account_cloud_type(id)? != "baidu" { return Err("当前账号不是百度智能云账号".into()); }
    if region_id.trim().is_empty() || instance_id.trim().is_empty() { return Err("缺少服务器地域或实例 ID".into()); }
    let host = format!("bcc.{region_id}.baidubce.com"); let path = format!("/v2/instance/{instance_id}");
    if action == "status" {
        let (data, _) = baidu_request(id, &host, &path, BTreeMap::new()).await?;
        let instance = data.get("instance").unwrap_or(&data);
        return Ok(json!({"status": instance.get("status").and_then(Value::as_str).unwrap_or("Unknown")}));
    }
    if !["start", "stop", "reboot"].contains(&action.as_str()) { return Err("不支持的 BCC 服务器操作".into()); }
    let mut query = BTreeMap::new(); query.insert(action.clone(), String::new());
    let body = if force_stop && (action == "stop" || action == "reboot") { Some(json!({"forceStop": true})) } else { None };
    let (data, _) = baidu_request_with_options(id, &host, &path, query, "PUT", body, true).await?;
    Ok(data)
}

async fn baidu_pages(id: i64, host: &str, path: &str, keys: &[&str]) -> Result<Vec<Value>, String> {
    let mut items = Vec::new(); let mut marker = String::new();
    for _ in 0..100 {
        let (data, _) = baidu_request(id, host, path, string_params(&[("marker", marker.clone()), ("maxKeys", "1000".into())])).await?;
        let page = keys.iter().flat_map(|key| array_at(&data, &[*key]).into_iter().cloned()).collect::<Vec<_>>();
        items.extend(page.iter().cloned());
        let next_marker = data.get("nextMarker").or_else(|| data.get("NextMarker")).and_then(Value::as_str).unwrap_or("").to_string();
        if next_marker.is_empty() || next_marker == marker || data.get("isTruncated").and_then(Value::as_bool) == Some(false) || data.get("IsTruncated").and_then(Value::as_bool) == Some(false) { return Ok(items); }
        marker = next_marker;
    }
    Err("分页超过 100 页，已停止读取".into())
}

fn baidu_instance(item: &Value, region: &str) -> Value {
    let public_ip = item.get("publicIps").or_else(|| item.get("publicIp")).and_then(Value::as_array).and_then(|values| values.first()).cloned().or_else(|| item.get("publicIp").cloned()).unwrap_or(json!(""));
    let private_ip = item.get("internalIps").or_else(|| item.get("privateIps")).and_then(Value::as_array).and_then(|values| values.first()).cloned().or_else(|| item.get("internalIp").cloned()).unwrap_or(json!(""));
    json!({"InstanceId": item.get("id").or_else(|| item.get("instanceId")), "InstanceName": item.get("name").or_else(|| item.get("instanceName")).or_else(|| item.get("id")), "InstanceStatus": item.get("status"), "Status": item.get("status"), "PublicIpAddress": public_ip, "PrivateIpAddress": private_ip, "InstanceType": item.get("spec"), "VpcId": item.get("vpcId"), "_region_id": region, "_raw": item})
}

fn baidu_rds(item: &Value, region: &str) -> Value {
    json!({"DBInstanceId": item.get("instanceId").or_else(|| item.get("id")), "DBInstanceDescription": item.get("instanceName").or_else(|| item.get("name")).or_else(|| item.get("instanceId")), "DBInstanceStatus": item.get("status"), "DBInstanceClass": item.get("instanceClass").or_else(|| item.get("instanceType")), "DBInstanceStorage": item.get("volumeCapacity").or_else(|| item.get("capacity")).unwrap_or(&json!(0)), "ConnectionString": item.get("endpoint").or_else(|| item.get("vip")), "Port": item.get("port"), "Engine": item.get("engine").or_else(|| item.get("engineType")), "EngineVersion": item.get("engineVersion"), "CreateTime": item.get("createTime"), "_region_id": region, "_raw": item})
}

fn baidu_redis(item: &Value, region: &str) -> Value {
    json!({"InstanceId": item.get("instanceId").or_else(|| item.get("id")), "InstanceName": item.get("instanceName").or_else(|| item.get("name")).or_else(|| item.get("instanceId")), "InstanceStatus": item.get("instanceStatus").or_else(|| item.get("status")), "InstanceType": item.get("engine").unwrap_or(&json!("Redis")), "InstanceClass": item.get("instanceClass").or_else(|| item.get("nodeType")), "Capacity": item.get("capacity").or_else(|| item.get("memorySize")).unwrap_or(&json!(0)), "ConnectionDomain": item.get("domain").or_else(|| item.get("endpoint")).or_else(|| item.get("vip")), "Port": item.get("port"), "EngineVersion": item.get("engineVersion"), "NetworkType": item.get("vnetIp").or_else(|| item.get("vpcId")), "CreateTime": item.get("instanceCreateTime"), "_region_id": region, "_raw": item})
}

fn baidu_zone(item: &Value) -> Value {
    json!({"DomainName": item.get("domain").or_else(|| item.get("name")).or_else(|| item.get("zoneName")), "DomainStatus": item.get("status").unwrap_or(&json!("ACTIVE")), "ZoneId": item.get("id").or_else(|| item.get("domainId")).or_else(|| item.get("domain")), "RecordCount": item.get("recordCount").or_else(|| item.get("recordNum")).unwrap_or(&json!(0)), "RegistrationDate": item.get("createTime"), "_region_id": "global", "_baidu_public_zone": true, "_raw": item})
}

fn baidu_bucket(item: &Value) -> Value {
    let name = item.get("name").or_else(|| item.get("bucketName")).and_then(Value::as_str).unwrap_or(""); let region = item.get("location").or_else(|| item.get("region")).and_then(Value::as_str).unwrap_or("bj");
    json!({"Name": name, "BucketName": name, "Location": region, "CreationDate": item.get("creationDate").or_else(|| item.get("createTime")), "StorageClass": item.get("storageClass").unwrap_or(&json!("STANDARD")), "Acl": item.get("acl").unwrap_or(&json!("private")), "ExtranetEndpoint": if name.is_empty() { "-".to_string() } else { format!("{name}.{region}.bcebos.com") }, "IntranetEndpoint": "-", "_region_id": region, "_raw": item})
}

async fn baidu_resource_items(id: i64, resource_type: &str) -> ResourceResponse {
    let now = Utc::now().timestamp_millis(); let regions = match baidu_regions(id) { Ok(value) => value, Err(error) => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![error], fetched_at: now } }; let mut items = Vec::new(); let mut errors = Vec::new();
    if resource_type == "domain" {
        match baidu_pages(id, "dns.baidubce.com", "/v1/dns/zone", &["zones"]).await { Ok(values) => items.extend(values.into_iter().map(|item| baidu_zone(&item))), Err(error) => errors.push(error), }
        return ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now };
    }
    if resource_type == "oss" {
        match baidu_request(id, "bj.bcebos.com", "/", BTreeMap::new()).await {
            Ok((data, body)) => { let values = if array_at(&data, &["buckets"]).is_empty() { xml_blocks(&body, "Bucket").into_iter().map(|block| json!({"name": xml_text(&block, "Name"), "location": xml_text(&block, "Location"), "creationDate": xml_text(&block, "CreationDate")})).collect::<Vec<_>>() } else { array_at(&data, &["buckets"]).into_iter().cloned().collect::<Vec<_>>() }; items.extend(values.into_iter().map(|item| baidu_bucket(&item)).filter(|item| item.get("Name").and_then(Value::as_str).is_some_and(|value| !value.is_empty()))); }
            Err(error) => errors.push(error),
        }
        return ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now };
    }
    let service = match resource_type { "ecs" => Some(("bcc", "/v2/instance", vec!["instances", "instanceList"])), "rds" => Some(("rds", "/v1/instance", vec!["instances", "instanceList"])), "redis" => Some(("redis", "/v2/instance", vec!["instances", "instanceList"])), _ => None };
    let Some((service_name, path, keys)) = service else { return ResourceResponse { resource_type: resource_type.into(), items, errors: vec![format!("百度智能云暂未接入 {resource_type} 资源")], fetched_at: now }; };
    for region in regions { match baidu_pages(id, &format!("{service_name}.{region}.baidubce.com"), path, &keys).await { Ok(values) => for item in values { items.push(match resource_type { "ecs" => baidu_instance(&item, &region), "rds" => baidu_rds(&item, &region), "redis" => baidu_redis(&item, &region), _ => item }); }, Err(error) => errors.push(format!("{region}: {error}")), } }
    ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now }
}

#[tauri::command]
async fn verify_baidu_account(id: i64) -> Result<Value, String> {
    if account_cloud_type(id)? != "baidu" { return Err("当前账号不是百度智能云账号".into()); }
    let regions = baidu_regions(id)?; let first = regions.first().cloned().unwrap_or_else(|| "bj".into());
    baidu_pages(id, &format!("bcc.{first}.baidubce.com"), "/v2/instance", &["instances", "instanceList"]).await?;
    Ok(json!({"provider": "baidu", "verified": true, "region_count": regions.len(), "regions": regions, "default_region": first}))
}

fn configured_regions(id: i64, fallback: &str) -> Result<Vec<String>, String> {
    let value: Option<String> = open_db()?.query_row("SELECT region_id FROM cloud_accounts WHERE id=?1", [id], |row| row.get(0)).map_err(|error| error.to_string())?;
    let mut regions = value.unwrap_or_else(|| fallback.into()).split(|character: char| character == ',' || character == '，' || character.is_whitespace()).filter(|value| !value.is_empty()).map(String::from).collect::<Vec<_>>();
    if regions.is_empty() { regions.push(fallback.into()); } regions.sort(); regions.dedup(); Ok(regions)
}

async fn ucloud_request(id: i64, action: &str, mut params: BTreeMap<String, String>) -> Result<Value, String> {
    if account_cloud_type(id)? != "ucloud" { return Err("当前账号不是 UCloud 账号".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    params.insert("Action".into(), action.into()); params.insert("PublicKey".into(), access_key_id.clone());
    let plain = params.iter().map(|(key, value)| format!("{key}{value}")).collect::<String>() + &access_key_secret;
    params.insert("Signature".into(), B64.encode(Sha1::digest(plain.as_bytes())));
    let query = params.iter().map(|(key, value)| format!("{}={}", rpc_encode(key), rpc_encode(value))).collect::<Vec<_>>().join("&");
    let response = reqwest::Client::new().get(format!("https://api.ucloud.cn/?{query}")).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("UCloud 请求失败: {error}"))?;
    let status = response.status(); let data: Value = response.json().await.map_err(|error| format!("UCloud 返回解析失败: {error}"))?;
    if !status.is_success() || data.get("RetCode").and_then(Value::as_i64).unwrap_or(0) != 0 { let message = data.get("Message").or_else(|| data.get("message")).and_then(Value::as_str).unwrap_or("UCloud API 返回错误").to_string(); write_api_log(&access_key_id, "api.ucloud.cn", action, &json!(params), Some(&data), "失败", Some(&message)); return Err(message); }
    write_api_log(&access_key_id, "api.ucloud.cn", action, &json!(params), Some(&data), "成功", None); Ok(data)
}

async fn ucloud_pages(id: i64, action: &str, region: &str, keys: &[&str]) -> Result<Vec<Value>, String> {
    let mut items = Vec::new();
    for offset in (0..100_000).step_by(100) {
        let data = ucloud_request(id, action, string_params(&[("Region", region.into()), ("Offset", offset.to_string()), ("Limit", "100".into())])).await?;
        let page = keys.iter().flat_map(|key| array_at(&data, &[*key]).into_iter().cloned()).collect::<Vec<_>>(); let count = page.len(); items.extend(page);
        let total = data.get("TotalCount").or_else(|| data.get("Total")).and_then(Value::as_u64).unwrap_or(u64::MAX) as usize;
        if count < 100 || items.len() >= total { return Ok(items); }
    }
    Err("分页超过 1000 页，已停止读取".into())
}

fn ucloud_first_ip(item: &Value, public: bool) -> Value {
    let Some(values) = item.get("IPSet").and_then(Value::as_array) else { return json!(""); };
    values.iter()
        .find(|value| value.get("Type").and_then(Value::as_str).map(|kind| (kind == "EIP") == public).unwrap_or(!public))
        .and_then(|value| value.get("IP").or_else(|| value.get("Ip")))
        .cloned()
        .unwrap_or(json!(""))
}

fn ucloud_instance(item: &Value, region: &str) -> Value { json!({"InstanceId": item.get("UHostId"), "InstanceName": item.get("Name").or_else(|| item.get("UHostId")), "InstanceStatus": item.get("State"), "Status": item.get("State"), "PublicIpAddress": ucloud_first_ip(item, true), "PrivateIpAddress": ucloud_first_ip(item, false), "InstanceType": item.get("UHostType").or_else(|| item.get("CPU")), "VpcId": item.get("VPCId"), "_region_id": region, "_raw": item}) }
fn ucloud_rds(item: &Value, region: &str) -> Value { json!({"DBInstanceId": item.get("DBId"), "DBInstanceDescription": item.get("Name").or_else(|| item.get("DBId")), "DBInstanceStatus": item.get("State"), "DBInstanceClass": item.get("MemoryLimit").or_else(|| item.get("DBType")), "DBInstanceStorage": item.get("DiskSpace").unwrap_or(&json!(0)), "ConnectionString": item.get("VirtualIP"), "Port": item.get("Port"), "Engine": item.get("DBType"), "EngineVersion": item.get("DBVersion"), "CreateTime": item.get("CreateTime"), "_region_id": region, "_raw": item}) }
fn ucloud_redis(item: &Value, region: &str) -> Value { json!({"InstanceId": item.get("GroupId"), "InstanceName": item.get("Name").or_else(|| item.get("GroupId")), "InstanceStatus": item.get("State"), "InstanceType": "Redis", "InstanceClass": item.get("MemoryLimit"), "Capacity": item.get("MemoryLimit").unwrap_or(&json!(0)), "ConnectionDomain": item.get("VirtualIP").or_else(|| item.get("VIP")), "Port": item.get("Port"), "EngineVersion": item.get("Version"), "NetworkType": item.get("VPCId"), "_region_id": region, "_raw": item}) }
fn ucloud_bucket(item: &Value, region: &str) -> Value { let name = item.get("BucketName").or_else(|| item.get("Name")); json!({"Name": name, "BucketName": name, "Location": item.get("Region").unwrap_or(&json!(region)), "CreationDate": item.get("CreateTime"), "StorageClass": item.get("StorageClass").unwrap_or(&json!("STANDARD")), "Acl": item.get("ACL").unwrap_or(&json!("private")), "ExtranetEndpoint": "-", "IntranetEndpoint": "-", "_region_id": item.get("Region").unwrap_or(&json!(region)), "_raw": item}) }
fn ucloud_zone(item: &Value) -> Value { json!({"DomainName": item.get("DomainName").or_else(|| item.get("Domain")), "DomainStatus": item.get("Status").unwrap_or(&json!("ACTIVE")), "ZoneId": item.get("DomainId").or_else(|| item.get("DomainName")), "RecordCount": item.get("RecordCount").unwrap_or(&json!(0)), "RegistrationDate": item.get("CreateTime"), "_region_id": "global", "_ucloud_dns": true, "_raw": item}) }

async fn ucloud_resource_items(id: i64, resource_type: &str) -> ResourceResponse {
    let now = Utc::now().timestamp_millis(); let regions = match configured_regions(id, "cn-bj2") { Ok(value) => value, Err(error) => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![error], fetched_at: now } }; let mut items = Vec::new(); let mut errors = Vec::new();
    if resource_type == "domain" { match ucloud_request(id, "DescribeUDNSDomain", string_params(&[("Offset", "0".into()), ("Limit", "100".into())])).await { Ok(data) => items.extend(array_at(&data, &["DomainSet"]).into_iter().map(|item| ucloud_zone(item))), Err(error) => errors.push(error), }; return ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now }; }
    let service = match resource_type { "ecs" => Some(("DescribeUHostInstance", vec!["UHostSet"])), "rds" => Some(("DescribeUDBInstance", vec!["DataSet"])), "redis" => Some(("DescribeURedisGroup", vec!["DataSet"])), "oss" => Some(("DescribeUFileBucket", vec!["DataSet"])), _ => None };
    let Some((action, keys)) = service else { return ResourceResponse { resource_type: resource_type.into(), items, errors: vec![format!("UCloud 暂未接入 {resource_type} 资源")], fetched_at: now }; };
    for region in regions { match ucloud_pages(id, action, &region, &keys).await { Ok(values) => for item in values { items.push(match resource_type { "ecs" => ucloud_instance(&item, &region), "rds" => ucloud_rds(&item, &region), "redis" => ucloud_redis(&item, &region), "oss" => ucloud_bucket(&item, &region), _ => item }); }, Err(error) => errors.push(format!("{region}: {error}")), } }
    ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now }
}

#[tauri::command]
async fn verify_ucloud_account(id: i64) -> Result<Value, String> { let regions = configured_regions(id, "cn-bj2")?; ucloud_request(id, "DescribeUHostInstance", string_params(&[("Region", regions[0].clone()), ("Offset", "0".into()), ("Limit", "1".into())])).await?; Ok(json!({"provider":"ucloud","verified":true,"region_count":regions.len(),"regions":regions,"default_region":configured_regions(id, "cn-bj2")?[0]})) }

async fn qiniu_buckets(id: i64) -> Result<Vec<Value>, String> {
    if account_cloud_type(id)? != "qiniu" { return Err("当前账号不是七牛云账号".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?; let region = configured_regions(id, "z0")?.first().cloned().unwrap_or_else(|| "z0".into());
    let mut mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|error| error.to_string())?;
    mac.update(b"/buckets\n"); let authorization = format!("QBox {access_key_id}:{}", URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()));
    let response = reqwest::Client::new().get("https://rs.qiniuapi.com/buckets").header("Authorization", authorization).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("七牛云请求失败: {error}"))?;
    let status = response.status(); let data: Value = response.json().await.map_err(|error| format!("七牛云返回解析失败: {error}"))?;
    if !status.is_success() { let message = data.get("error").or_else(|| data.get("message")).and_then(Value::as_str).unwrap_or("七牛云 API 返回错误").to_string(); write_api_log(&access_key_id, "rs.qiniuapi.com", "ListBuckets", &json!({}), Some(&data), "失败", Some(&message)); return Err(message); }
    let values = data.as_array().cloned().unwrap_or_default().into_iter().filter_map(|value| value.as_str().map(String::from)).map(|name| json!({"Name": name, "BucketName": name, "Location": region, "CreationDate": "", "StorageClass": "STANDARD", "Acl": "private", "ExtranetEndpoint": "-", "IntranetEndpoint": "-", "_region_id": region})).collect::<Vec<_>>();
    write_api_log(&access_key_id, "rs.qiniuapi.com", "ListBuckets", &json!({}), Some(&json!({"count": values.len()})), "成功", None); Ok(values)
}

async fn qiniu_resource_items(id: i64, resource_type: &str) -> ResourceResponse { let now = Utc::now().timestamp_millis(); if resource_type != "oss" { return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![format!("七牛云暂未接入 {resource_type} 资源；当前仅支持 Kodo 空间")], fetched_at: now }; } match qiniu_buckets(id).await { Ok(items) => ResourceResponse { resource_type: resource_type.into(), items, errors: vec![], fetched_at: now }, Err(error) => ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![error], fetched_at: now } } }

#[tauri::command]
async fn verify_qiniu_account(id: i64) -> Result<Value, String> { let items = qiniu_buckets(id).await?; let regions = configured_regions(id, "z0")?; Ok(json!({"provider":"qiniu","verified":true,"region_count":regions.len(),"regions":regions,"default_region":configured_regions(id, "z0")?[0],"bucket_count":items.len()})) }

fn aws_sign(key: &[u8], value: &str) -> Result<Vec<u8>, String> {
    let mut mac: Hmac<Sha256> = <Hmac<Sha256> as Mac>::new_from_slice(key).map_err(|error| error.to_string())?;
    mac.update(value.as_bytes()); Ok(mac.finalize().into_bytes().to_vec())
}

fn aws_query(query: &BTreeMap<String, String>) -> String {
    query.iter().map(|(key, value)| (rpc_encode(key), rpc_encode(value))).collect::<Vec<_>>().into_iter().map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>().join("&")
}

async fn aws_request(id: i64, service: &str, region: &str, host: &str, path: &str, query: BTreeMap<String, String>) -> Result<String, String> {
    if account_cloud_type(id)? != "aws" { return Err("当前账号不是 AWS 账号".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?; let datetime = Utc::now().format("%Y%m%dT%H%M%SZ").to_string(); let date = &datetime[..8]; let query_text = aws_query(&query); let payload_hash = format!("{:x}", Sha256::digest(b"")); let canonical_headers = format!("host:{host}\nx-amz-date:{datetime}\n"); let signed_headers = "host;x-amz-date"; let canonical_request = format!("GET\n{path}\n{query_text}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"); let scope = format!("{date}/{region}/{service}/aws4_request"); let string_to_sign = format!("AWS4-HMAC-SHA256\n{datetime}\n{scope}\n{:x}", Sha256::digest(canonical_request.as_bytes())); let date_key = aws_sign(format!("AWS4{access_key_secret}").as_bytes(), date)?; let region_key = aws_sign(&date_key, region)?; let service_key = aws_sign(&region_key, service)?; let signing_key = aws_sign(&service_key, "aws4_request")?; let authorization = format!("AWS4-HMAC-SHA256 Credential={access_key_id}/{scope}, SignedHeaders={signed_headers}, Signature={}", hex::encode(aws_sign(&signing_key, &string_to_sign)?)); let url = format!("https://{host}{path}{}", if query_text.is_empty() { String::new() } else { format!("?{query_text}") });
    let response = reqwest::Client::new().get(url).header("Host", host).header("X-Amz-Date", &datetime).header("Authorization", authorization).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("AWS 请求失败: {error}"))?; let status = response.status(); let body = response.text().await.map_err(|error| format!("AWS 返回读取失败: {error}"))?;
    if !status.is_success() { let message = { let value = xml_text(&body, "Message"); if value.is_empty() { xml_text(&body, "Code") } else { value } }; write_api_log(&access_key_id, host, &format!("GET {path}"), &json!(query), Some(&json!({"body": body})), "失败", Some(&message)); return Err(format!("AWS {status}: {message}")); }
    write_api_log(&access_key_id, host, &format!("GET {path}"), &json!(query), Some(&json!({"body": body})), "成功", None); Ok(body)
}

fn aws_instance(item: &str, region: &str) -> Value { json!({"InstanceId": xml_text(item, "instanceId"), "InstanceName": xml_text(item, "instanceId"), "InstanceStatus": xml_text(&xml_text(item, "instanceState"), "name"), "Status": xml_text(&xml_text(item, "instanceState"), "name"), "PublicIpAddress": xml_text(item, "ipAddress"), "PrivateIpAddress": xml_text(item, "privateIpAddress"), "InstanceType": xml_text(item, "instanceType"), "VpcId": xml_text(item, "vpcId"), "_region_id": region, "_raw_xml": item}) }
fn aws_rds(item: &str, region: &str) -> Value { json!({"DBInstanceId": xml_text(item, "DBInstanceIdentifier"), "DBInstanceDescription": xml_text(item, "DBInstanceIdentifier"), "DBInstanceStatus": xml_text(item, "DBInstanceStatus"), "DBInstanceClass": xml_text(item, "DBInstanceClass"), "DBInstanceStorage": xml_text(item, "AllocatedStorage").parse::<i64>().unwrap_or(0), "ConnectionString": xml_text(&xml_text(item, "Endpoint"), "Address"), "Port": xml_text(&xml_text(item, "Endpoint"), "Port"), "Engine": xml_text(item, "Engine"), "EngineVersion": xml_text(item, "EngineVersion"), "CreateTime": xml_text(item, "InstanceCreateTime"), "_region_id": region, "_raw_xml": item}) }
fn aws_redis(item: &str, region: &str) -> Value { json!({"InstanceId": xml_text(item, "CacheClusterId"), "InstanceName": xml_text(item, "CacheClusterId"), "InstanceStatus": xml_text(item, "CacheClusterStatus"), "InstanceType": "Redis", "InstanceClass": xml_text(item, "CacheNodeType"), "Capacity": 0, "ConnectionDomain": xml_text(&xml_text(item, "ConfigurationEndpoint"), "Address"), "Port": xml_text(&xml_text(item, "ConfigurationEndpoint"), "Port"), "EngineVersion": xml_text(item, "EngineVersion"), "NetworkType": xml_text(item, "VpcId"), "_region_id": region, "_raw_xml": item}) }

async fn aws_resource_items(id: i64, resource_type: &str) -> ResourceResponse {
    let now = Utc::now().timestamp_millis(); let regions = match configured_regions(id, "ap-northeast-1") { Ok(value) => value, Err(error) => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![error], fetched_at: now } }; let mut items = Vec::new(); let mut errors = Vec::new();
    if resource_type == "oss" { match aws_request(id, "s3", "us-east-1", "s3.amazonaws.com", "/", BTreeMap::new()).await { Ok(body) => items.extend(xml_blocks(&body, "Bucket").into_iter().map(|bucket| json!({"Name": xml_text(&bucket, "Name"), "BucketName": xml_text(&bucket, "Name"), "Location": "global", "CreationDate": xml_text(&bucket, "CreationDate"), "StorageClass": "STANDARD", "Acl": "private", "ExtranetEndpoint": "-", "IntranetEndpoint": "-", "_region_id": "global"}))), Err(error) => errors.push(error), }; return ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now }; }
    if resource_type == "domain" { match aws_request(id, "route53", "us-east-1", "route53.amazonaws.com", "/2013-04-01/hostedzone", BTreeMap::new()).await { Ok(body) => items.extend(xml_blocks(&body, "HostedZone").into_iter().map(|zone| json!({"DomainName": xml_text(&zone, "Name").trim_end_matches('.'), "DomainStatus": "ACTIVE", "ZoneId": xml_text(&zone, "Id"), "RecordCount": xml_text(&zone, "ResourceRecordSetCount").parse::<i64>().unwrap_or(0), "RegistrationDate": "", "_region_id": "global", "_aws_route53": true}))), Err(error) => errors.push(error), }; return ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now }; }
    for region in regions { let response = match resource_type { "ecs" => aws_request(id, "ec2", &region, &format!("ec2.{region}.amazonaws.com"), "/", string_params(&[("Action", "DescribeInstances".into()), ("Version", "2016-11-15".into())])).await.map(|body| xml_blocks(&body, "instancesSet").into_iter().flat_map(|set| xml_blocks(&set, "item")).map(|item| aws_instance(&item, &region)).collect::<Vec<_>>()), "rds" => aws_request(id, "rds", &region, &format!("rds.{region}.amazonaws.com"), "/", string_params(&[("Action", "DescribeDBInstances".into()), ("Version", "2014-10-31".into())])).await.map(|body| xml_blocks(&body, "DBInstances").into_iter().flat_map(|set| xml_blocks(&set, "DBInstance")).map(|item| aws_rds(&item, &region)).collect::<Vec<_>>()), "redis" => aws_request(id, "elasticache", &region, &format!("elasticache.{region}.amazonaws.com"), "/", string_params(&[("Action", "DescribeCacheClusters".into()), ("Version", "2015-02-02".into()), ("ShowCacheNodeInfo", "true".into())])).await.map(|body| xml_blocks(&body, "CacheClusters").into_iter().flat_map(|set| xml_blocks(&set, "CacheCluster")).map(|item| aws_redis(&item, &region)).collect::<Vec<_>>()), _ => return ResourceResponse { resource_type: resource_type.into(), items, errors: vec![format!("AWS 暂未接入 {resource_type} 资源")], fetched_at: now } }; match response { Ok(values) => items.extend(values), Err(error) => errors.push(format!("{region}: {error}")), } }
    ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now }
}

#[tauri::command]
async fn verify_aws_account(id: i64) -> Result<Value, String> { let regions = configured_regions(id, "ap-northeast-1")?; aws_request(id, "ec2", &regions[0], &format!("ec2.{}.amazonaws.com", regions[0]), "/", string_params(&[("Action", "DescribeInstances".into()), ("Version", "2016-11-15".into()), ("MaxResults", "5".into())])).await?; Ok(json!({"provider":"aws","verified":true,"region_count":regions.len(),"regions":regions,"default_region":configured_regions(id, "ap-northeast-1")?[0]})) }

struct AzureCredentials { client_id: String, client_secret: String, tenant_id: String, subscription_id: String }

fn azure_credentials(id: i64) -> Result<AzureCredentials, String> {
    let conn = open_db()?; let row: (String, String, Option<String>, i64, String) = conn.query_row("SELECT access_key_id,secret_ciphertext,credential_meta,enabled,cloud_type FROM cloud_accounts WHERE id=?1", [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))).map_err(|error| format!("读取云账号失败: {error}"))?;
    if row.3 != 1 { return Err("云账号已停用".into()); } if row.4 != "azure" { return Err("当前账号不是 Microsoft Azure 账号".into()); }
    let meta: Value = serde_json::from_str(row.2.as_deref().unwrap_or("{}")).map_err(|_| "Azure 凭证信息格式无效".to_string())?; let tenant_id = meta.get("tenant_id").and_then(Value::as_str).unwrap_or("").trim().to_string(); let subscription_id = meta.get("subscription_id").and_then(Value::as_str).unwrap_or("").trim().to_string(); if tenant_id.is_empty() || subscription_id.is_empty() { return Err("Azure 账号缺少 Tenant ID 或 Subscription ID".into()); }
    Ok(AzureCredentials { client_id: row.0, client_secret: decrypt_secret(&row.1)?, tenant_id, subscription_id })
}

async fn azure_token(credentials: &AzureCredentials) -> Result<String, String> {
    let response = reqwest::Client::new().post(format!("https://login.microsoftonline.com/{}/oauth2/v2.0/token", rpc_encode(&credentials.tenant_id))).form(&[("client_id", credentials.client_id.as_str()), ("client_secret", credentials.client_secret.as_str()), ("grant_type", "client_credentials"), ("scope", "https://management.azure.com/.default")]).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("Azure OAuth 请求失败: {error}"))?; let status = response.status(); let data: Value = response.json().await.map_err(|error| format!("Azure OAuth 返回解析失败: {error}"))?; if !status.is_success() { return Err(data.get("error_description").or_else(|| data.get("error")).and_then(Value::as_str).unwrap_or("Azure OAuth 失败").to_string()); } data.get("access_token").and_then(Value::as_str).map(String::from).ok_or_else(|| "Azure OAuth 未返回 access token".into())
}

async fn azure_resources_raw(credentials: &AzureCredentials) -> Result<Vec<Value>, String> {
    let token = azure_token(credentials).await?; let mut next = format!("https://management.azure.com/subscriptions/{}/resources?api-version=2021-04-01", rpc_encode(&credentials.subscription_id)); let mut values = Vec::new();
    for _ in 0..100 { if next.is_empty() { break; } let response = reqwest::Client::new().get(&next).bearer_auth(&token).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("Azure ARM 请求失败: {error}"))?; let status = response.status(); let data: Value = response.json().await.map_err(|error| format!("Azure ARM 返回解析失败: {error}"))?; if !status.is_success() { return Err(data.pointer("/error/message").or_else(|| data.get("message")).and_then(Value::as_str).unwrap_or("Azure ARM 返回错误").to_string()); } values.extend(array_at(&data, &["value"]).into_iter().cloned()); next = data.get("nextLink").and_then(Value::as_str).unwrap_or("").to_string(); }
    Ok(values)
}

fn azure_instance(item: &Value) -> Value { let p = item.get("properties").cloned().unwrap_or(Value::Null); json!({"InstanceId": item.get("id"), "InstanceName": item.get("name"), "InstanceStatus": p.get("provisioningState"), "Status": p.get("provisioningState"), "PublicIpAddress": "", "PrivateIpAddress": "", "InstanceType": p.pointer("/hardwareProfile/vmSize"), "VpcId": "", "_region_id": item.get("location"), "_raw": item}) }
fn azure_rds(item: &Value) -> Value { let p = item.get("properties").cloned().unwrap_or(Value::Null); json!({"DBInstanceId": item.get("id"), "DBInstanceDescription": item.get("name"), "DBInstanceStatus": p.get("state").or_else(|| p.get("provisioningState")), "DBInstanceClass": item.pointer("/sku/name"), "DBInstanceStorage": 0, "ConnectionString": p.get("fullyQualifiedDomainName"), "Port": "", "Engine": "Azure SQL", "EngineVersion": p.get("version"), "CreateTime": "", "_region_id": item.get("location"), "_raw": item}) }
fn azure_redis(item: &Value) -> Value { let p = item.get("properties").cloned().unwrap_or(Value::Null); json!({"InstanceId": item.get("id"), "InstanceName": item.get("name"), "InstanceStatus": p.get("provisioningState"), "InstanceType": "Redis", "InstanceClass": item.pointer("/sku/name"), "Capacity": item.pointer("/sku/capacity").cloned().unwrap_or(json!(0)), "ConnectionDomain": p.get("hostName"), "Port": p.get("sslPort").or_else(|| p.get("port")), "EngineVersion": p.get("redisVersion"), "NetworkType": p.get("subnetId"), "_region_id": item.get("location"), "_raw": item}) }
fn azure_bucket(item: &Value) -> Value { let p = item.get("properties").cloned().unwrap_or(Value::Null); json!({"Name": item.get("name"), "BucketName": item.get("name"), "Location": item.get("location"), "CreationDate": p.get("creationTime"), "StorageClass": item.pointer("/sku/name").cloned().unwrap_or(json!("Standard")), "Acl": if p.get("allowBlobPublicAccess").and_then(Value::as_bool) == Some(true) { "public" } else { "private" }, "ExtranetEndpoint": "-", "IntranetEndpoint": "-", "_region_id": item.get("location"), "_raw": item}) }
fn azure_zone(item: &Value) -> Value { let p = item.get("properties").cloned().unwrap_or(Value::Null); json!({"DomainName": item.get("name"), "DomainStatus": p.get("provisioningState").cloned().unwrap_or(json!("ACTIVE")), "ZoneId": item.get("id"), "RecordCount": p.get("numberOfRecordSets").cloned().unwrap_or(json!(0)), "RegistrationDate": "", "_region_id": item.get("location").cloned().unwrap_or(json!("global")), "_azure_dns": true, "_raw": item}) }

async fn azure_resource_items(id: i64, resource_type: &str) -> ResourceResponse {
    let now = Utc::now().timestamp_millis(); let credentials = match azure_credentials(id) { Ok(value) => value, Err(error) => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![error], fetched_at: now } }; let values = match azure_resources_raw(&credentials).await { Ok(value) => value, Err(error) => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![error], fetched_at: now } }; let expected = match resource_type { "ecs" => "microsoft.compute/virtualmachines", "rds" => "microsoft.sql/servers", "redis" => "microsoft.cache/redis", "oss" => "microsoft.storage/storageaccounts", "domain" => "microsoft.network/dnszones", _ => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![format!("Azure 暂未接入 {resource_type} 资源")], fetched_at: now } }; let items = values.into_iter().filter(|item| item.get("type").and_then(Value::as_str).map(|value| value.eq_ignore_ascii_case(expected)).unwrap_or(false)).map(|item| match resource_type { "ecs" => azure_instance(&item), "rds" => azure_rds(&item), "redis" => azure_redis(&item), "oss" => azure_bucket(&item), "domain" => azure_zone(&item), _ => item }).collect(); ResourceResponse { resource_type: resource_type.into(), items, errors: vec![], fetched_at: now }
}

#[tauri::command]
async fn verify_azure_account(id: i64) -> Result<Value, String> { let credentials = azure_credentials(id)?; let token = azure_token(&credentials).await?; let response = reqwest::Client::new().get(format!("https://management.azure.com/subscriptions/{}?api-version=2022-12-01", rpc_encode(&credentials.subscription_id))).bearer_auth(token).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("Azure ARM 请求失败: {error}"))?; if !response.status().is_success() { return Err(format!("Azure 订阅验证失败：{}", response.status())); } let regions = configured_regions(id, "eastasia")?; Ok(json!({"provider":"azure","verified":true,"region_count":regions.len(),"regions":regions,"default_region":configured_regions(id, "eastasia")?[0]})) }

struct GcpCredentials { email: String, private_key: String, project_id: String }

fn gcp_credentials(id: i64) -> Result<GcpCredentials, String> {
    let conn = open_db()?; let row: (String, String, Option<String>, i64, String) = conn.query_row("SELECT access_key_id,secret_ciphertext,credential_meta,enabled,cloud_type FROM cloud_accounts WHERE id=?1", [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))).map_err(|error| format!("读取云账号失败: {error}"))?;
    if row.3 != 1 { return Err("云账号已停用".into()); } if row.4 != "gcp" { return Err("当前账号不是 Google Cloud 账号".into()); } let meta: Value = serde_json::from_str(row.2.as_deref().unwrap_or("{}")).map_err(|_| "GCP 凭证信息格式无效".to_string())?; let project_id = meta.get("project_id").and_then(Value::as_str).unwrap_or("").trim().to_string(); if project_id.is_empty() { return Err("GCP 账号缺少 Project ID".into()); } Ok(GcpCredentials { email: row.0, private_key: decrypt_secret(&row.1)?.replace("\\n", "\n"), project_id })
}

async fn gcp_token(credentials: &GcpCredentials) -> Result<String, String> {
    let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"RS256","typ":"JWT"}"#); let now = Utc::now().timestamp(); let claim = URL_SAFE_NO_PAD.encode(serde_json::to_string(&json!({"iss": credentials.email, "scope": "https://www.googleapis.com/auth/cloud-platform", "aud": "https://oauth2.googleapis.com/token", "iat": now, "exp": now + 3600})).map_err(|error| error.to_string())?); let signing_input = format!("{header}.{claim}"); let private_key = RsaPrivateKey::from_pkcs8_pem(&credentials.private_key).or_else(|_| RsaPrivateKey::from_pkcs1_pem(&credentials.private_key)).map_err(|_| "GCP 服务账号私钥无效，需使用未加密的 PEM 私钥".to_string())?; let signature = URL_SAFE_NO_PAD.encode(SigningKey::<Sha256>::new(private_key).sign(signing_input.as_bytes()).to_vec()); let assertion = format!("{signing_input}.{signature}");
    let response = reqwest::Client::new().post("https://oauth2.googleapis.com/token").form(&[("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"), ("assertion", assertion.as_str())]).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("GCP OAuth 请求失败: {error}"))?; let status = response.status(); let data: Value = response.json().await.map_err(|error| format!("GCP OAuth 返回解析失败: {error}"))?; if !status.is_success() { return Err(data.get("error_description").or_else(|| data.get("error")).and_then(Value::as_str).unwrap_or("GCP OAuth 失败").to_string()); } data.get("access_token").and_then(Value::as_str).map(String::from).ok_or_else(|| "GCP OAuth 未返回 access token".into())
}

async fn gcp_get(token: &str, url: &str) -> Result<Value, String> { let response = reqwest::Client::new().get(url).bearer_auth(token).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("GCP 请求失败: {error}"))?; let status = response.status(); let data: Value = response.json().await.map_err(|error| format!("GCP 返回解析失败: {error}"))?; if !status.is_success() { return Err(data.pointer("/error/message").or_else(|| data.get("message")).and_then(Value::as_str).unwrap_or("GCP API 返回错误").to_string()); } Ok(data) }

async fn gcp_pages(token: &str, url: &str, key: &str) -> Result<Vec<Value>, String> { let mut items = Vec::new(); let mut next = url.to_string(); for _ in 0..100 { let data = gcp_get(token, &next).await?; items.extend(array_at(&data, &[key]).into_iter().cloned()); let Some(page_token) = data.get("nextPageToken").and_then(Value::as_str) else { break; }; next = format!("{}{}pageToken={}", url, if url.contains('?') { "&" } else { "?" }, rpc_encode(page_token)); } Ok(items) }

fn gcp_instance(item: &Value, region: &str) -> Value { let network = item.pointer("/networkInterfaces/0"); json!({"InstanceId": item.get("id").or_else(|| item.get("name")), "InstanceName": item.get("name"), "InstanceStatus": item.get("status"), "Status": item.get("status"), "PublicIpAddress": network.and_then(|value| value.pointer("/accessConfigs/0/natIP")), "PrivateIpAddress": network.and_then(|value| value.get("networkIP")), "InstanceType": item.get("machineType").and_then(Value::as_str).unwrap_or("").rsplit('/').next().unwrap_or(""), "VpcId": network.and_then(|value| value.get("network")).and_then(Value::as_str).unwrap_or("").rsplit('/').next().unwrap_or(""), "_region_id": region, "_raw": item}) }
fn gcp_rds(item: &Value) -> Value { json!({"DBInstanceId": item.get("name"), "DBInstanceDescription": item.get("name"), "DBInstanceStatus": item.get("state"), "DBInstanceClass": item.pointer("/settings/tier"), "DBInstanceStorage": item.pointer("/settings/dataDiskSizeGb").unwrap_or(&json!(0)), "ConnectionString": item.get("ipAddresses").and_then(Value::as_array).and_then(|items| items.iter().find(|value| value.get("type").and_then(Value::as_str) == Some("PRIMARY"))).and_then(|value| value.get("ipAddress")), "Port": "3306", "Engine": item.get("databaseVersion"), "EngineVersion": item.get("databaseVersion"), "CreateTime": item.get("createTime"), "_region_id": item.get("region"), "_raw": item}) }
fn gcp_redis(item: &Value) -> Value { json!({"InstanceId": item.get("name"), "InstanceName": item.get("name").and_then(Value::as_str).unwrap_or("").rsplit('/').next().unwrap_or(""), "InstanceStatus": item.get("state"), "InstanceType": "Redis", "InstanceClass": item.get("tier"), "Capacity": item.get("memorySizeGb").and_then(Value::as_i64).unwrap_or(0) * 1024, "ConnectionDomain": item.get("host"), "Port": item.get("port"), "EngineVersion": item.get("redisVersion"), "NetworkType": item.get("authorizedNetwork"), "_region_id": item.get("locationId"), "_raw": item}) }
fn gcp_bucket(item: &Value) -> Value { json!({"Name": item.get("name"), "BucketName": item.get("name"), "Location": item.get("location"), "CreationDate": item.get("timeCreated"), "StorageClass": item.get("storageClass").unwrap_or(&json!("STANDARD")), "Acl": "private", "ExtranetEndpoint": "-", "IntranetEndpoint": "-", "_region_id": item.get("location"), "_raw": item}) }
fn gcp_zone(item: &Value) -> Value { json!({"DomainName": item.get("dnsName").and_then(Value::as_str).unwrap_or("").trim_end_matches('.'), "DomainStatus": "ACTIVE", "ZoneId": item.get("id").or_else(|| item.get("name")), "RecordCount": 0, "RegistrationDate": item.get("creationTime"), "_region_id": "global", "_gcp_dns": true, "_raw": item}) }

async fn gcp_resource_items(id: i64, resource_type: &str) -> ResourceResponse {
    let now = Utc::now().timestamp_millis(); let credentials = match gcp_credentials(id) { Ok(value) => value, Err(error) => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![error], fetched_at: now } }; let token = match gcp_token(&credentials).await { Ok(value) => value, Err(error) => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![error], fetched_at: now } }; let project = rpc_encode(&credentials.project_id);
    let result = match resource_type { "ecs" => gcp_get(&token, &format!("https://compute.googleapis.com/compute/v1/projects/{project}/aggregated/instances")).await.map(|data| data.get("items").and_then(Value::as_object).into_iter().flat_map(|values| values.iter()).flat_map(|(scope, value)| array_at(value, &["instances"]).into_iter().map(|item| gcp_instance(item, scope.rsplit('/').next().unwrap_or(""))).collect::<Vec<_>>()).collect::<Vec<_>>()), "rds" => gcp_pages(&token, &format!("https://sqladmin.googleapis.com/sql/v1beta4/projects/{project}/instances"), "items").await.map(|values| values.into_iter().map(|item| gcp_rds(&item)).collect()), "redis" => gcp_pages(&token, &format!("https://redis.googleapis.com/v1/projects/{project}/locations/-/instances"), "instances").await.map(|values| values.into_iter().map(|item| gcp_redis(&item)).collect()), "oss" => gcp_pages(&token, &format!("https://storage.googleapis.com/storage/v1/b?project={project}"), "items").await.map(|values| values.into_iter().map(|item| gcp_bucket(&item)).collect()), "domain" => gcp_pages(&token, &format!("https://dns.googleapis.com/dns/v1/projects/{project}/managedZones"), "managedZones").await.map(|values| values.into_iter().map(|item| gcp_zone(&item)).collect()), _ => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![format!("GCP 暂未接入 {resource_type} 资源")], fetched_at: now } };
    match result { Ok(items) => ResourceResponse { resource_type: resource_type.into(), items, errors: vec![], fetched_at: now }, Err(error) => ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![error], fetched_at: now } }
}

#[tauri::command]
async fn verify_gcp_account(id: i64) -> Result<Value, String> { let credentials = gcp_credentials(id)?; let token = gcp_token(&credentials).await?; gcp_get(&token, &format!("https://cloudresourcemanager.googleapis.com/v1/projects/{}", rpc_encode(&credentials.project_id))).await?; let regions = configured_regions(id, "asia-east1")?; Ok(json!({"provider":"gcp","verified":true,"region_count":regions.len(),"regions":regions,"default_region":configured_regions(id, "asia-east1")?[0]})) }

async fn jdcloud_request(id: i64, service: &str, region: &str, path: &str, query: BTreeMap<String, String>) -> Result<Value, String> {
    if account_cloud_type(id)? != "jdcloud" { return Err("当前账号不是京东云账号".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let datetime = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let date = &datetime[..8];
    let host = if service == "oss" { "oss.jdcloud-api.com".to_string() } else if service == "domainservice" { "domainservice.jdcloud-api.com".to_string() } else { format!("{service}.{region}.jdcloud-api.com") };
    let query_text = aws_query(&query);
    let payload_hash = format!("{:x}", Sha256::digest(b""));
    let canonical_headers = format!("host:{host}\nx-jdcloud-date:{datetime}\n");
    let signed_headers = "host;x-jdcloud-date";
    let canonical_request = format!("GET\n{path}\n{query_text}\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let scope = format!("{date}/{region}/{service}/jdcloud2_request");
    let string_to_sign = format!("JDCLOUD2-HMAC-SHA256\n{datetime}\n{scope}\n{:x}", Sha256::digest(canonical_request.as_bytes()));
    let date_key = aws_sign(format!("JDCLOUD2{access_key_secret}").as_bytes(), date)?;
    let region_key = aws_sign(&date_key, region)?;
    let service_key = aws_sign(&region_key, service)?;
    let signing_key = aws_sign(&service_key, "jdcloud2_request")?;
    let authorization = format!("JDCLOUD2-HMAC-SHA256 Credential={access_key_id}/{scope}, SignedHeaders={signed_headers}, Signature={}", hex::encode(aws_sign(&signing_key, &string_to_sign)?));
    let response = reqwest::Client::new().get(format!("https://{host}{path}{}", if query_text.is_empty() { String::new() } else { format!("?{query_text}") })).header("Host", &host).header("X-Jdcloud-Date", &datetime).header("Authorization", authorization).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("京东云请求失败: {error}"))?;
    let status = response.status(); let data: Value = response.json().await.map_err(|error| format!("京东云返回解析失败: {error}"))?;
    if !status.is_success() { let message = data.pointer("/error/message").or_else(|| data.get("message")).or_else(|| data.get("code")).and_then(Value::as_str).unwrap_or("京东云 API 返回错误").to_string(); write_api_log(&access_key_id, &host, &format!("GET {path}"), &json!(query), Some(&data), "失败", Some(&message)); return Err(message); }
    write_api_log(&access_key_id, &host, &format!("GET {path}"), &json!(query), Some(&data), "成功", None); Ok(data)
}

fn value_first_string(value: Option<&Value>) -> Value { value.and_then(Value::as_array).and_then(|items| items.first()).cloned().or_else(|| value.cloned()).unwrap_or(json!("")) }
fn jdcloud_instance(item: &Value, region: &str) -> Value { json!({"InstanceId": item.get("instanceId").or_else(|| item.get("id")), "InstanceName": item.get("name").or_else(|| item.get("instanceId")), "InstanceStatus": item.get("status"), "Status": item.get("status"), "PublicIpAddress": value_first_string(item.get("elasticIp").or_else(|| item.get("publicIpAddress"))), "PrivateIpAddress": value_first_string(item.get("privateIpAddress")), "InstanceType": item.get("instanceType").unwrap_or(&json!("")), "VpcId": item.get("vpcId").unwrap_or(&json!("")), "_region_id": region, "_raw": item}) }
fn jdcloud_rds(item: &Value, region: &str) -> Value { json!({"DBInstanceId": item.get("instanceId").or_else(|| item.get("id")), "DBInstanceDescription": item.get("instanceName").or_else(|| item.get("name")).or_else(|| item.get("instanceId")), "DBInstanceStatus": item.get("instanceStatus").or_else(|| item.get("status")), "DBInstanceClass": item.get("instanceClass").or_else(|| item.get("instanceType")), "DBInstanceStorage": item.get("instanceStorageGB").or_else(|| item.get("storageGB")).unwrap_or(&json!(0)), "ConnectionString": item.get("internalDomainName").or_else(|| item.get("connectionString")), "Port": item.get("port"), "Engine": item.get("engine").or_else(|| item.get("engineType")), "EngineVersion": item.get("engineVersion"), "CreateTime": item.get("createTime"), "_region_id": region, "_raw": item}) }
fn jdcloud_redis(item: &Value, region: &str) -> Value { json!({"InstanceId": item.get("cacheInstanceId").or_else(|| item.get("instanceId")).or_else(|| item.get("id")), "InstanceName": item.get("cacheInstanceName").or_else(|| item.get("name")).or_else(|| item.get("cacheInstanceId")), "InstanceStatus": item.get("cacheInstanceStatus").or_else(|| item.get("status")), "InstanceType": "Redis", "InstanceClass": item.get("cacheInstanceClass").or_else(|| item.get("instanceClass")), "Capacity": item.get("cacheInstanceMemoryMB").or_else(|| item.get("memory")).unwrap_or(&json!(0)), "ConnectionDomain": item.get("cacheInstanceDomainName").or_else(|| item.get("connectionDomain")), "Port": item.get("port"), "EngineVersion": item.get("engineVersion"), "NetworkType": item.get("vpcId"), "_region_id": region, "_raw": item}) }
fn jdcloud_bucket(item: &Value, region: &str) -> Value { let name = item.get("name").or_else(|| item.get("bucketName")).or_else(|| item.get("bucket")); json!({"Name": name, "BucketName": name, "Location": item.get("location").or_else(|| item.get("region")).unwrap_or(&json!(region)), "CreationDate": item.get("creationDate").or_else(|| item.get("createTime")), "StorageClass": item.get("storageClass").unwrap_or(&json!("STANDARD")), "Acl": item.get("acl").unwrap_or(&json!("private")), "ExtranetEndpoint": name.and_then(Value::as_str).filter(|name| !name.is_empty()).map(|name| format!("{name}.s3.{region}.jdcloud-oss.com")).unwrap_or_else(|| "-".into()), "IntranetEndpoint": "-", "_region_id": item.get("location").or_else(|| item.get("region")).unwrap_or(&json!(region)), "_raw": item}) }
fn jdcloud_zone(item: &Value, region: &str) -> Value { json!({"DomainName": item.get("domainName").or_else(|| item.get("domain")).or_else(|| item.get("name")), "DomainStatus": item.get("status").unwrap_or(&json!("ACTIVE")), "ZoneId": item.get("id").or_else(|| item.get("domainId")).or_else(|| item.get("domainName")), "RecordCount": item.get("recordCount").or_else(|| item.get("recordNum")).unwrap_or(&json!(0)), "RegistrationDate": item.get("createTime"), "_region_id": region, "_jdcloud_dns": true, "_raw": item}) }
fn jdcloud_swas_instance(item: &Value, region: &str) -> Value { json!({"InstanceId": item.get("instanceId").or_else(|| item.get("id")), "InstanceName": item.get("name").or_else(|| item.get("instanceName")).or_else(|| item.get("instanceId")), "InstanceStatus": item.get("status").or_else(|| item.get("instanceStatus")), "Status": item.get("status").or_else(|| item.get("instanceStatus")), "PublicIpAddress": value_first_string(item.get("publicIpAddress").or_else(|| item.get("elasticIp"))), "PrivateIpAddress": value_first_string(item.get("privateIpAddress")), "InstanceType": item.get("instanceType").or_else(|| item.get("planName")).unwrap_or(&json!("")), "VpcId": item.get("vpcId").unwrap_or(&json!("")), "_region_id": region, "_raw": item}) }

async fn jdcloud_resource_items(id: i64, resource_type: &str) -> ResourceResponse {
    let now = Utc::now().timestamp_millis(); let regions = match configured_regions(id, "cn-north-1") { Ok(value) => value, Err(error) => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![error], fetched_at: now } };
    let definition = match resource_type { "ecs" => Some(("vm", "v1", "instances")), "rds" => Some(("rds", "v1", "instances")), "redis" => Some(("redis", "v1", "cacheInstance")), "oss" => Some(("oss", "v1", "buckets")), "domain" => Some(("domainservice", "v2", "domain")), "swas" => Some(("lavm", "v1", "instances")), _ => None };
    let Some((service, version, resource)) = definition else { return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![format!("京东云暂未接入 {resource_type} 资源")], fetched_at: now }; };
    let mut items = Vec::new(); let mut errors = Vec::new();
    for region in regions { let query = if resource_type == "oss" { BTreeMap::new() } else { string_params(&[("pageNumber", "1".into()), ("pageSize", "100".into())]) }; match jdcloud_request(id, service, &region, &format!("/{version}/regions/{}/{}", rpc_encode(&region), resource), query).await { Ok(data) => { let values = array_at(&data, &["result", "instances"]).into_iter().chain(array_at(&data, &["result", "cacheInstances"])).chain(array_at(&data, &["result", "cacheInstance"])).chain(array_at(&data, &["result", "buckets"])).chain(array_at(&data, &["result", "dataList"])).chain(array_at(&data, &["result", "data"])).chain(array_at(&data, &["buckets"])); for item in values { items.push(match resource_type { "ecs" => jdcloud_instance(item, &region), "rds" => jdcloud_rds(item, &region), "redis" => jdcloud_redis(item, &region), "oss" => jdcloud_bucket(item, &region), "domain" => jdcloud_zone(item, &region), "swas" => jdcloud_swas_instance(item, &region), _ => item.clone() }); } }, Err(error) => errors.push(format!("{region}: {error}")), } }
    ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now }
}

#[tauri::command]
async fn verify_jdcloud_account(id: i64) -> Result<Value, String> { let regions = configured_regions(id, "cn-north-1")?; jdcloud_request(id, "vm", &regions[0], &format!("/v1/regions/{}/instances", rpc_encode(&regions[0])), string_params(&[("pageNumber", "1".into()), ("pageSize", "1".into())])).await?; Ok(json!({"provider":"jdcloud","verified":true,"region_count":regions.len(),"regions":regions,"default_region":configured_regions(id, "cn-north-1")?[0]})) }

async fn qingcloud_request(id: i64, action: &str, zone: &str, mut params: BTreeMap<String, String>) -> Result<Value, String> {
    if account_cloud_type(id)? != "qingcloud" { return Err("当前账号不是青云 QingCloud 账号".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    params.insert("action".into(), action.into()); params.insert("zone".into(), zone.into()); params.insert("access_key_id".into(), access_key_id.clone()); params.insert("time_stamp".into(), Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()); params.insert("version".into(), "1".into()); params.insert("signature_method".into(), "HmacSHA256".into()); params.insert("signature_version".into(), "1".into());
    let canonical = aws_query(&params); let mut mac: Hmac<Sha256> = <Hmac<Sha256> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|error| error.to_string())?; mac.update(format!("GET\n/iaas/\n{canonical}").as_bytes()); params.insert("signature".into(), B64.encode(mac.finalize().into_bytes()));
    let query = aws_query(&params); let response = reqwest::Client::new().get(format!("https://api.qingcloud.com/iaas/?{query}")).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("青云请求失败: {error}"))?; let status = response.status(); let data: Value = response.json().await.map_err(|error| format!("青云返回解析失败: {error}"))?;
    if !status.is_success() || data.get("ret_code").and_then(Value::as_i64).unwrap_or(0) != 0 { let message = data.get("message").or_else(|| data.get("ret_message")).and_then(Value::as_str).unwrap_or("青云 API 返回错误").to_string(); write_api_log(&access_key_id, "api.qingcloud.com", action, &json!(params), Some(&data), "失败", Some(&message)); return Err(message); }
    write_api_log(&access_key_id, "api.qingcloud.com", action, &json!(params), Some(&data), "成功", None); Ok(data)
}

fn qingcloud_instance(item: &Value, zone: &str) -> Value { let vxnets = item.get("vxnets").and_then(Value::as_array); let public = vxnets.and_then(|items| items.iter().flat_map(|value| value.get("eips").and_then(Value::as_array).into_iter().flatten()).next()).cloned().unwrap_or(json!("")); let private = vxnets.and_then(|items| items.iter().flat_map(|value| value.get("private_ips").and_then(Value::as_array).into_iter().flatten()).next()).cloned().unwrap_or(json!("")); json!({"InstanceId": item.get("instance_id"), "InstanceName": item.get("instance_name").or_else(|| item.get("instance_id")), "InstanceStatus": item.get("status"), "Status": item.get("status"), "PublicIpAddress": public, "PrivateIpAddress": private, "InstanceType": item.get("instance_type").unwrap_or(&json!("")), "VpcId": item.get("vpc_id").unwrap_or(&json!("")), "_region_id": zone, "_raw": item}) }
fn qingcloud_rds(item: &Value, zone: &str) -> Value { json!({"DBInstanceId": item.get("rdb_id").or_else(|| item.get("rdb")), "DBInstanceDescription": item.get("rdb_name").or_else(|| item.get("rdb_id")).or_else(|| item.get("rdb")), "DBInstanceStatus": item.get("status"), "DBInstanceClass": item.get("rdb_type").or_else(|| item.get("rdb_class")).unwrap_or(&json!("")), "DBInstanceStorage": item.get("storage_size").or_else(|| item.get("storage")).unwrap_or(&json!(0)), "ConnectionString": value_first_string(item.get("vips").or_else(|| item.get("private_ips")).or_else(|| item.get("endpoint"))), "Port": item.get("port").unwrap_or(&json!("")), "Engine": item.get("rdb_engine").unwrap_or(&json!("")), "EngineVersion": item.get("engine_version").unwrap_or(&json!("")), "CreateTime": item.get("create_time").unwrap_or(&json!("")), "_region_id": zone, "_raw": item}) }
fn qingcloud_redis(item: &Value, zone: &str) -> Value { json!({"InstanceId": item.get("cache_id").or_else(|| item.get("cache")), "InstanceName": item.get("cache_name").or_else(|| item.get("cache_id")).or_else(|| item.get("cache")), "InstanceStatus": item.get("status"), "InstanceType": item.get("cache_type").unwrap_or(&json!("Redis")), "InstanceClass": item.get("cache_class").unwrap_or(&json!("")), "Capacity": item.get("cache_size").or_else(|| item.get("memory_size")).unwrap_or(&json!(0)), "ConnectionDomain": value_first_string(item.get("vips").or_else(|| item.get("private_ips")).or_else(|| item.get("endpoint"))), "Port": item.get("port").unwrap_or(&json!("")), "EngineVersion": item.get("cache_version").unwrap_or(&json!("")), "NetworkType": item.get("vxnet_id").or_else(|| item.get("vxnet")).unwrap_or(&json!("")), "_region_id": zone, "_raw": item}) }
fn qingcloud_dns_alias(item: &Value, zone: &str) -> Value { json!({"DomainName": item.get("domain_name").or_else(|| item.get("dns_alias")).or_else(|| item.get("dns_alias_id")), "DomainStatus": item.get("status").unwrap_or(&json!("ACTIVE")), "ZoneId": item.get("dns_alias_id").or_else(|| item.get("dns_alias")).or_else(|| item.get("domain_name")), "RecordCount": 0, "RegistrationDate": item.get("create_time").unwrap_or(&json!("")), "_region_id": zone, "_qingcloud_dns_alias": true, "_raw": item}) }
async fn qingcloud_buckets(id: i64) -> Result<Vec<Value>, String> { if account_cloud_type(id)? != "qingcloud" { return Err("当前账号不是青云 QingCloud 账号".into()); } let (access_key_id, access_key_secret) = account_credentials(id)?; let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string(); let mut mac: Hmac<Sha256> = <Hmac<Sha256> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|error| error.to_string())?; mac.update(format!("GET\n\n\n{date}\n/").as_bytes()); let response = reqwest::Client::new().get("https://qingstor.com/").header("Date", &date).header("Authorization", format!("QS {access_key_id}:{}", B64.encode(mac.finalize().into_bytes()))).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("QingStor 请求失败: {error}"))?; let status = response.status(); let data: Value = response.json().await.map_err(|error| format!("QingStor 返回解析失败: {error}"))?; if !status.is_success() { let message = data.get("message").and_then(Value::as_str).unwrap_or("QingStor API 返回错误").to_string(); write_api_log(&access_key_id, "qingstor.com", "ListBuckets", &json!({}), Some(&data), "失败", Some(&message)); return Err(message); } let values = array_at(&data, &["buckets"]).into_iter().map(|bucket| json!({"Name":bucket.get("name"),"BucketName":bucket.get("name"),"Location":bucket.get("location").unwrap_or(&json!("")),"CreationDate":bucket.get("created").unwrap_or(&json!("")),"StorageClass":"STANDARD","Acl":"private","ExtranetEndpoint":value_first_string(bucket.get("urls")),"IntranetEndpoint":"-","_region_id":bucket.get("location").unwrap_or(&json!(""))})).collect::<Vec<_>>(); write_api_log(&access_key_id, "qingstor.com", "ListBuckets", &json!({}), Some(&json!({"count":values.len()})), "成功", None); Ok(values) }
async fn qingcloud_resource_items(id: i64, resource_type: &str) -> ResourceResponse { let now = Utc::now().timestamp_millis(); if resource_type == "oss" { return match qingcloud_buckets(id).await { Ok(items) => ResourceResponse { resource_type: resource_type.into(), items, errors: vec![], fetched_at: now }, Err(error) => ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![error], fetched_at: now } }; } let definition = match resource_type { "ecs" => Some(("DescribeInstances", "instance_set", qingcloud_instance as fn(&Value, &str) -> Value)), "rds" => Some(("DescribeRDBs", "rdb_set", qingcloud_rds as fn(&Value, &str) -> Value)), "redis" => Some(("DescribeCaches", "cache_set", qingcloud_redis as fn(&Value, &str) -> Value)), "domain" => Some(("DescribeDNSAliases", "dns_alias_set", qingcloud_dns_alias as fn(&Value, &str) -> Value)), _ => None }; let Some((action, key, normalize)) = definition else { return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![format!("青云 QingCloud 暂未接入 {resource_type} 资源")], fetched_at: now }; }; let zones = match configured_regions(id, "pek3a") { Ok(value) => value, Err(error) => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![error], fetched_at: now } }; let mut items = Vec::new(); let mut errors = Vec::new(); for zone in zones { match qingcloud_request(id, action, &zone, string_params(&[("limit", "100".into())])).await { Ok(data) => items.extend(array_at(&data, &[key]).into_iter().map(|item| normalize(item, &zone))), Err(error) => errors.push(format!("{zone}: {error}")), } } ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now } }
#[tauri::command]
async fn verify_qingcloud_account(id: i64) -> Result<Value, String> { let zones = configured_regions(id, "pek3a")?; qingcloud_request(id, "DescribeInstances", &zones[0], string_params(&[("limit", "1".into())])).await?; Ok(json!({"provider":"qingcloud","verified":true,"region_count":zones.len(),"regions":zones,"default_region":configured_regions(id, "pek3a")?[0]})) }

async fn ksyun_request(id: i64, service: &str, region: &str, action: &str, version: &str, mut params: BTreeMap<String, String>) -> Result<Value, String> {
    if account_cloud_type(id)? != "ksyun" { return Err("当前账号不是金山云账号".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?; let host = format!("{service}.{region}.api.ksyun.com");
    params.insert("Action".into(), action.into()); params.insert("Version".into(), version.into()); params.insert("AccessKeyId".into(), access_key_id.clone()); params.insert("SignatureMethod".into(), "HMAC-SHA256".into()); params.insert("SignatureVersion".into(), "1.0".into()); params.insert("Timestamp".into(), Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string());
    let canonical = aws_query(&params); let mut mac: Hmac<Sha256> = <Hmac<Sha256> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|error| error.to_string())?; mac.update(format!("GET\n{host}\n/\n{canonical}").as_bytes()); params.insert("Signature".into(), B64.encode(mac.finalize().into_bytes())); let query = aws_query(&params);
    let response = reqwest::Client::new().get(format!("https://{host}/?{query}")).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("金山云请求失败: {error}"))?; let status = response.status(); let data: Value = response.json().await.map_err(|error| format!("金山云返回解析失败: {error}"))?;
    if !status.is_success() || data.get("Error").is_some() { let message = data.pointer("/Error/Message").or_else(|| data.get("Message")).and_then(Value::as_str).unwrap_or("金山云 API 返回错误").to_string(); write_api_log(&access_key_id, &host, action, &json!(params), Some(&data), "失败", Some(&message)); return Err(message); } write_api_log(&access_key_id, &host, action, &json!(params), Some(&data), "成功", None); Ok(data)
}

fn ksyun_instance(item: &Value, region: &str) -> Value { json!({"InstanceId": item.get("InstanceId"), "InstanceName": item.get("InstanceName").or_else(|| item.get("InstanceId")), "InstanceStatus": item.pointer("/InstanceState/Name").or_else(|| item.get("InstanceState")), "Status": item.pointer("/InstanceState/Name").or_else(|| item.get("InstanceState")), "PublicIpAddress": item.get("PublicIpAddress").unwrap_or(&json!("")), "PrivateIpAddress": item.pointer("/NetworkInterfaces/0/PrivateIpAddress").unwrap_or(&json!("")), "InstanceType": item.get("InstanceType").unwrap_or(&json!("")), "VpcId": item.get("VpcId").unwrap_or(&json!("")), "_region_id": region, "_raw": item}) }
fn ksyun_rds(item: &Value, region: &str) -> Value { json!({"DBInstanceId":item.get("DBInstanceIdentifier"),"DBInstanceDescription":item.get("DBInstanceName").or_else(||item.get("DBInstanceIdentifier")),"DBInstanceStatus":item.get("DBInstanceStatus"),"DBInstanceClass":item.pointer("/DBInstanceClass/Id").or_else(||item.get("DBInstanceClass")).unwrap_or(&json!("")),"DBInstanceStorage":item.pointer("/DBInstanceClass/Disk").or_else(||item.get("Storage")).unwrap_or(&json!(0)),"ConnectionString":item.get("Vip").or_else(||item.get("VipAddress")).unwrap_or(&json!("")),"Port":item.get("Port").unwrap_or(&json!("")),"Engine":item.get("Engine").unwrap_or(&json!("")),"EngineVersion":item.get("EngineVersion").unwrap_or(&json!("")),"CreateTime":item.get("InstanceCreateTime").unwrap_or(&json!("")),"_region_id":region,"_raw":item}) }
fn ksyun_redis(item: &Value, region: &str) -> Value { json!({"InstanceId":item.get("CacheId").or_else(||item.get("CacheClusterId")).or_else(||item.get("InstanceId")),"InstanceName":item.get("Name").or_else(||item.get("CacheName")).or_else(||item.get("CacheClusterName")).or_else(||item.get("CacheId")),"InstanceStatus":item.get("Status").or_else(||item.get("CacheStatus")).or_else(||item.get("CacheClusterStatus")),"InstanceType":"Redis","InstanceClass":item.get("CacheNodeType").or_else(||item.get("InstanceClass")).or_else(||item.get("Type")).unwrap_or(&json!("")),"Capacity":item.get("Capacity").or_else(||item.get("MemorySize")).unwrap_or(&json!(0)),"ConnectionDomain":item.get("Vip").or_else(||item.get("Host")).or_else(||item.get("Endpoint")).unwrap_or(&json!("")),"Port":item.get("Port").unwrap_or(&json!("")),"EngineVersion":item.get("EngineVersion").or_else(||item.get("RedisVersion")).unwrap_or(&json!("")),"NetworkType":item.get("VpcId").unwrap_or(&json!("")),"_region_id":region,"_raw":item}) }
async fn ksyun_ks3_buckets(id: i64) -> Result<Vec<Value>, String> { if account_cloud_type(id)? != "ksyun" { return Err("当前账号不是金山云账号".into()); } let (access_key_id, access_key_secret) = account_credentials(id)?; let host = "kss.ksyun.com"; let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string(); let mut mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|error| error.to_string())?; mac.update(format!("GET\n\n\n{date}\n/").as_bytes()); let response = reqwest::Client::new().get(format!("https://{host}/")).header("Date", &date).header("Authorization", format!("KSS {access_key_id}:{}", B64.encode(mac.finalize().into_bytes()))).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("KS3 请求失败: {error}"))?; let status = response.status(); let body = response.text().await.map_err(|error| format!("KS3 返回读取失败: {error}"))?; if !status.is_success() { let message = xml_text(&body, "Message"); write_api_log(&access_key_id, host, "ListBuckets", &json!({}), Some(&json!({"body":body})), "失败", Some(&message)); return Err(if message.is_empty() { format!("KS3 {status}") } else { message }); } let values = xml_blocks(&body, "Bucket").into_iter().filter_map(|bucket| { let name = xml_text(&bucket, "Name"); if name.is_empty() { None } else { let location = xml_text(&bucket, "Location"); Some(json!({"Name":name,"BucketName":name,"Location":location,"CreationDate":xml_text(&bucket,"CreationDate"),"StorageClass":"STANDARD","Acl":"private","ExtranetEndpoint":format!("{name}.{host}"),"IntranetEndpoint":"-","_region_id":location})) } }).collect::<Vec<_>>(); write_api_log(&access_key_id, host, "ListBuckets", &json!({}), Some(&json!({"count":values.len()})), "成功", None); Ok(values) }
async fn ksyun_resource_items(id: i64, resource_type: &str) -> ResourceResponse { let now = Utc::now().timestamp_millis(); if resource_type == "oss" { return match ksyun_ks3_buckets(id).await { Ok(items) => ResourceResponse { resource_type: resource_type.into(), items, errors: vec![], fetched_at: now }, Err(error) => ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![error], fetched_at: now } }; } let definition = match resource_type { "ecs" => Some(("kec", "DescribeInstances", "2016-03-04", "InstancesSet", ksyun_instance as fn(&Value, &str) -> Value)), "rds" => Some(("krds", "DescribeDBInstances", "2016-07-01", "Data.Instances", ksyun_rds as fn(&Value, &str) -> Value)), "redis" => Some(("kcs", "DescribeCacheClusters", "2016-07-01", "CacheClusters", ksyun_redis as fn(&Value, &str) -> Value)), _ => None }; let Some((service, action, version, key, normalize)) = definition else { return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![format!("金山云暂未接入 {resource_type} 资源")], fetched_at: now }; }; let regions = match configured_regions(id, "cn_beijing_6") { Ok(value) => value, Err(error) => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![error], fetched_at: now } }; let mut items = Vec::new(); let mut errors = Vec::new(); for region in regions { match ksyun_request(id, service, &region, action, version, if resource_type == "ecs" { string_params(&[("MaxResults", "100".into())]) } else { string_params(&[("MaxRecords", "100".into())]) }).await { Ok(data) => { let values = if key == "Data.Instances" { array_at(&data, &["Data", "Instances"]) } else if key == "CacheClusters" { let first = array_at(&data, &["CacheClusters"]); if first.is_empty() { array_at(&data, &["Data", "CacheClusters"]) } else { first } } else { let first = array_at(&data, &["InstancesSet"]); if first.is_empty() { array_at(&data, &["Instances"]) } else { first } }; items.extend(values.into_iter().map(|item| normalize(item, &region))); }, Err(error) => errors.push(format!("{region}: {error}")), } } ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now } }
#[tauri::command]
async fn verify_ksyun_account(id: i64) -> Result<Value, String> { let regions = configured_regions(id, "cn_beijing_6")?; ksyun_request(id, "kec", &regions[0], "DescribeInstances", "2016-03-04", string_params(&[("MaxResults", "1".into())])).await?; Ok(json!({"provider":"ksyun","verified":true,"region_count":regions.len(),"regions":regions,"default_region":configured_regions(id, "cn_beijing_6")?[0]})) }

fn volc_query(params: &BTreeMap<String, String>) -> String {
    let mut values = params.iter().map(|(key, value)| (rpc_encode(key), rpc_encode(value))).collect::<Vec<_>>();
    values.sort();
    values.into_iter().map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>().join("&")
}

fn volc_sign(key: &[u8], value: &str) -> Result<Vec<u8>, String> {
    let mut mac: Hmac<Sha256> = <Hmac<Sha256> as Mac>::new_from_slice(key).map_err(|error| error.to_string())?;
    mac.update(value.as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}

async fn volc_request(
    service: &str, version: &str, action: &str, mut params: BTreeMap<String, String>, region: &str,
    access_key_id: &str, access_key_secret: &str,
) -> Result<Value, String> {
    let host = "open.volcengineapi.com";
    let region = if region.is_empty() { "cn-beijing" } else { region };
    params.insert("Action".into(), action.into());
    params.insert("Version".into(), version.into());
    let query = volc_query(&params);
    let datetime = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let date = &datetime[..8];
    let payload_hash = format!("{:x}", Sha256::digest(b""));
    let canonical_headers = format!("x-date:{datetime}\n");
    let signed_headers = "x-date";
    let canonical_request = format!("GET\n/\n{query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let credential_scope = format!("{date}/{region}/{service}/request");
    let string_to_sign = format!("HMAC-SHA256\n{datetime}\n{credential_scope}\n{:x}", Sha256::digest(canonical_request.as_bytes()));
    let date_key = volc_sign(access_key_secret.as_bytes(), date)?;
    let region_key = volc_sign(&date_key, region)?;
    let service_key = volc_sign(&region_key, service)?;
    let signing_key = volc_sign(&service_key, "request")?;
    let signature = hex::encode(volc_sign(&signing_key, &string_to_sign)?);
    let authorization = format!("HMAC-SHA256 Credential={access_key_id}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}");
    let response = match reqwest::Client::new().get(format!("https://{host}/?{query}"))
        .header("X-Date", &datetime).header("Authorization", authorization)
        .timeout(std::time::Duration::from_secs(25)).send().await {
        Ok(response) => response,
        Err(error) => { let message = format!("火山引擎请求失败: {error}"); write_api_log(access_key_id, host, action, &json!(params), None, "失败", Some(&message)); return Err(message); }
    };
    let status = response.status();
    let data: Value = match response.json().await {
        Ok(data) => data,
        Err(error) => { let message = format!("火山引擎返回解析失败: {error}"); write_api_log(access_key_id, host, action, &json!(params), None, "失败", Some(&message)); return Err(message); }
    };
    if !status.is_success() || data.pointer("/ResponseMetadata/Error").is_some() || data.get("Error").is_some() {
        let message = data.pointer("/ResponseMetadata/Error/Message").and_then(Value::as_str)
            .or_else(|| data.pointer("/ResponseMetadata/Error/Code").and_then(Value::as_str))
            .or_else(|| data.pointer("/Error/Message").and_then(Value::as_str))
            .or_else(|| data.get("Message").and_then(Value::as_str)).unwrap_or("火山引擎 API 返回错误");
        write_api_log(access_key_id, host, action, &json!(params), Some(&data), "失败", Some(message));
        return Err(message.into());
    }
    write_api_log(access_key_id, host, action, &json!(params), Some(&data), "成功", None);
    Ok(data.get("Result").cloned().unwrap_or(data))
}

async fn volc_json_request(
    service: &str, version: &str, action: &str, payload: Value, region: &str,
    access_key_id: &str, access_key_secret: &str,
) -> Result<Value, String> {
    let region = if region.is_empty() { "cn-beijing" } else { region };
    let host = format!("{service}.volcengineapi.com");
    let mut params = BTreeMap::new();
    params.insert("Action".into(), action.into()); params.insert("Version".into(), version.into());
    let query = volc_query(&params);
    let body = serde_json::to_string(&payload).map_err(|error| format!("火山引擎请求序列化失败: {error}"))?;
    let datetime = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let date = &datetime[..8];
    let payload_hash = format!("{:x}", Sha256::digest(body.as_bytes()));
    let canonical_headers = format!("x-date:{datetime}\n");
    let signed_headers = "x-date";
    let canonical_request = format!("POST\n/\n{query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let credential_scope = format!("{date}/{region}/{service}/request");
    let string_to_sign = format!("HMAC-SHA256\n{datetime}\n{credential_scope}\n{:x}", Sha256::digest(canonical_request.as_bytes()));
    let date_key = volc_sign(access_key_secret.as_bytes(), date)?;
    let region_key = volc_sign(&date_key, region)?;
    let service_key = volc_sign(&region_key, service)?;
    let signing_key = volc_sign(&service_key, "request")?;
    let signature = hex::encode(volc_sign(&signing_key, &string_to_sign)?);
    let authorization = format!("HMAC-SHA256 Credential={access_key_id}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}");
    let url = format!("https://{host}/?{query}");
    let response = reqwest::Client::new().post(url)
        .header("Accept", "application/json").header("Content-Type", "application/json").header("X-Date", &datetime).header("Authorization", authorization)
        .body(body).timeout(std::time::Duration::from_secs(25)).send().await
        .map_err(|error| format!("火山引擎请求失败: {error}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|error| format!("火山引擎返回读取失败: {error}"))?;
    let data: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({"Message": text}));
    if !status.is_success() || data.pointer("/ResponseMetadata/Error").is_some() || data.get("Error").is_some() {
        let message = data.pointer("/ResponseMetadata/Error/Message").and_then(Value::as_str)
            .or_else(|| data.pointer("/ResponseMetadata/Error/Code").and_then(Value::as_str))
            .or_else(|| data.pointer("/Error/Message").and_then(Value::as_str))
            .or_else(|| data.get("Message").and_then(Value::as_str)).unwrap_or("火山引擎 API 返回错误");
        return Err(message.into());
    }
    Ok(data.get("Result").cloned().unwrap_or(data))
}

async fn volc_tos_list_buckets(region: &str, access_key_id: &str, access_key_secret: &str) -> Result<Vec<Value>, String> {
    let region = if region.is_empty() { "cn-beijing" } else { region };
    let host = format!("tos-{region}.volces.com");
    let datetime = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let date = &datetime[..8];
    let payload_hash = format!("{:x}", Sha256::digest(b""));
    let canonical_headers = format!("host:{host}\nx-tos-content-sha256:{payload_hash}\nx-tos-date:{datetime}\n");
    let signed_headers = "host;x-tos-content-sha256;x-tos-date";
    let canonical_request = format!("GET\n/\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let credential_scope = format!("{date}/{region}/tos/request");
    let string_to_sign = format!("TOS4-HMAC-SHA256\n{datetime}\n{credential_scope}\n{:x}", Sha256::digest(canonical_request.as_bytes()));
    let date_key = volc_sign(access_key_secret.as_bytes(), date)?;
    let region_key = volc_sign(&date_key, region)?;
    let service_key = volc_sign(&region_key, "tos")?;
    let signing_key = volc_sign(&service_key, "request")?;
    let signature = hex::encode(volc_sign(&signing_key, &string_to_sign)?);
    let authorization = format!("TOS4-HMAC-SHA256 Credential={access_key_id}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}");
    let response = reqwest::Client::new().get(format!("https://{host}/"))
        .header("Host", &host).header("X-Tos-Date", &datetime).header("X-Tos-Content-Sha256", &payload_hash).header("Authorization", authorization)
        .timeout(std::time::Duration::from_secs(25)).send().await.map_err(|error| format!("TOS 请求失败: {error}"))?;
    let status = response.status(); let body = response.text().await.map_err(|error| format!("TOS 返回读取失败: {error}"))?;
    if !status.is_success() { let message = xml_text(&body, "Message"); return Err(format!("TOS 返回错误（{status}）：{}", if message.is_empty() { xml_text(&body, "Code") } else { message })); }
    let buckets = match serde_json::from_str::<Value>(&body) {
        Ok(data) => data.get("Buckets").and_then(Value::as_array).cloned()
            .or_else(|| data.pointer("/Buckets/Bucket").and_then(Value::as_array).cloned())
            .or_else(|| data.get("Bucket").and_then(Value::as_array).cloned())
            .unwrap_or_default(),
        Err(_) => xml_blocks(&body, "Bucket").into_iter().map(|bucket| json!({"Name": xml_text(&bucket, "Name"), "Location": xml_text(&bucket, "Location"), "CreationDate": xml_text(&bucket, "CreationDate")})).collect(),
    };
    Ok(buckets.into_iter().map(|bucket| { let name = bucket.get("Name").or_else(|| bucket.get("BucketName")).and_then(Value::as_str).unwrap_or(""); let location = bucket.get("Location").or_else(|| bucket.get("Region")).and_then(Value::as_str).filter(|value| !value.is_empty()).unwrap_or(region); let creation_date = bucket.get("CreationDate").and_then(Value::as_str).unwrap_or(""); json!({"Name": name, "Location": location, "CreationDate": creation_date, "StorageClass": "Standard", "ExtranetEndpoint": format!("{name}.tos-{location}.volces.com"), "Acl": "private"}) }).filter(|bucket| bucket.get("Name").and_then(Value::as_str).is_some_and(|name| !name.is_empty())).collect())
}

async fn aliyun_esa(action: &str, params: BTreeMap<String, String>, method: &str, access_key_id: &str, access_key_secret: &str) -> Result<Value, String> {
    let host = "esa.cn-hangzhou.aliyuncs.com";
    let encoded_query = {
        let mut values: Vec<(String, String)> = params.iter().map(|(key, value)| (rpc_encode(key), rpc_encode(value))).collect();
        values.sort();
        values.iter().map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>().join("&")
    };
    let payload_hash = format!("{:x}", Sha256::digest(b""));
    let acs_date = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let nonce = Uuid::new_v4().to_string();
    let mut headers = BTreeMap::new();
    headers.insert("host", host.to_string());
    headers.insert("x-acs-action", action.to_string());
    headers.insert("x-acs-content-sha256", payload_hash.clone());
    headers.insert("x-acs-date", acs_date.clone());
    headers.insert("x-acs-signature-nonce", nonce.clone());
    headers.insert("x-acs-version", "2024-09-10".to_string());
    let canonical_headers = headers.iter().map(|(key, value)| format!("{key}:{value}\n")).collect::<String>();
    let signed_headers = headers.keys().cloned().collect::<Vec<_>>().join(";");
    let method = method.to_uppercase();
    let canonical_request = format!("{method}\n/\n{encoded_query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let string_to_sign = format!("ACS3-HMAC-SHA256\n{:x}", Sha256::digest(canonical_request.as_bytes()));
    let mut mac: Hmac<Sha256> = <Hmac<Sha256> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|e| e.to_string())?;
    mac.update(string_to_sign.as_bytes());
    let authorization = format!("ACS3-HMAC-SHA256 Credential={access_key_id},SignedHeaders={signed_headers},Signature={}", hex::encode(mac.finalize().into_bytes()));
    let url = if encoded_query.is_empty() { format!("https://{host}/") } else { format!("https://{host}/?{encoded_query}") };
    let client = reqwest::Client::new();
    let request = if method == "POST" { client.post(url) } else { client.get(url) };
    let response = request
        .header("host", host).header("x-acs-action", action).header("x-acs-content-sha256", payload_hash)
        .header("x-acs-date", acs_date).header("x-acs-signature-nonce", nonce).header("x-acs-version", "2024-09-10")
        .header("authorization", authorization).timeout(std::time::Duration::from_secs(25)).send().await
        .map_err(|e| format!("ESA 请求失败: {e}"))?;
    let status = response.status(); let data: Value = response.json().await.map_err(|e| format!("ESA 返回解析失败: {e}"))?;
    if !status.is_success() || data.get("Code").is_some() { let message = data.get("Message").and_then(Value::as_str).or_else(|| data.get("Code").and_then(Value::as_str)).unwrap_or("ESA API 返回错误"); write_api_log(access_key_id, host, action, &json!(params), Some(&data), "失败", Some(message)); return Err(message.to_string()); }
    write_api_log(access_key_id, host, action, &json!(params), Some(&data), "成功", None);
    Ok(data)
}

fn string_params(entries: &[(&str, String)]) -> BTreeMap<String, String> {
    entries.iter().map(|(key, value)| ((*key).to_string(), value.clone())).collect()
}

fn array_at<'a>(value: &'a Value, path: &[&str]) -> Vec<&'a Value> {
    let mut current = value;
    for key in path { current = match current.get(*key) { Some(value) => value, None => return vec![] }; }
    match current { Value::Array(items) => items.iter().collect(), Value::Object(_) => vec![current], _ => vec![] }
}

async fn oss_list_buckets(access_key_id: &str, access_key_secret: &str) -> Result<Vec<Value>, String> {
    let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    let string_to_sign = format!("GET\n\n\n{date}\n/");
    let mut mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|e| e.to_string())?;
    mac.update(string_to_sign.as_bytes());
    let authorization = format!("OSS {}:{}", access_key_id, B64.encode(mac.finalize().into_bytes()));
    let response = reqwest::Client::new()
        .get("https://oss-cn-hangzhou.aliyuncs.com/")
        .header("Date", date)
        .header("Host", "oss-cn-hangzhou.aliyuncs.com")
        .header("Authorization", authorization)
        .timeout(std::time::Duration::from_secs(25))
        .send().await.map_err(|e| format!("OSS 请求失败: {e}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|e| format!("OSS 返回读取失败: {e}"))?;
    if !status.is_success() { return Err(format!("OSS 返回错误（{}）", status)); }
    let mut items = Vec::new();
    let mut rest = body.as_str();
    while let Some(start) = rest.find("<Bucket>") {
        let chunk = &rest[start..];
        let Some(end) = chunk.find("</Bucket>") else { break };
        let bucket = &chunk[..end];
        let value = |tag: &str| -> String {
            let open = format!("<{tag}>"); let close = format!("</{tag}>");
            bucket.find(&open).and_then(|s| bucket[s + open.len()..].find(&close).map(|e| bucket[s + open.len()..s + open.len() + e].to_string())).unwrap_or_default()
        };
        let location = value("Location");
        items.push(json!({"Name": value("Name"), "Location": location, "CreationDate": value("CreationDate"), "StorageClass": "Standard", "ExtranetEndpoint": format!("{}.{}.aliyuncs.com", value("Name"), location)}));
        rest = &chunk[end + "</Bucket>".len()..];
    }
    Ok(items)
}

async fn oss_list_objects(bucket: &str, location: &str, access_key_id: &str, access_key_secret: &str, prefix: &str, marker: &str) -> Result<Value, String> {
    let location = if location.is_empty() { "oss-cn-hangzhou" } else { location };
    let host = format!("{bucket}.{location}.aliyuncs.com"); let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    let resource = format!("/{bucket}/"); let string_to_sign = format!("GET\n\n\n{date}\n{resource}");
    let mut mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|e| e.to_string())?; mac.update(string_to_sign.as_bytes());
    let mut query = "delimiter=%2F&max-keys=1000".to_string();
    if !prefix.is_empty() { query.push_str(&format!("&prefix={}", rpc_encode(prefix))); }
    if !marker.is_empty() { query.push_str(&format!("&marker={}", rpc_encode(marker))); }
    let response = reqwest::Client::new().get(format!("https://{host}/?{query}")).header("Date", date).header("Host", &host).header("Authorization", format!("OSS {access_key_id}:{}", B64.encode(mac.finalize().into_bytes()))).timeout(std::time::Duration::from_secs(25)).send().await.map_err(|e| format!("OSS 请求失败: {e}"))?;
    let status = response.status(); let body = response.text().await.map_err(|e| e.to_string())?; if !status.is_success() { let code = body.split("<Code>").nth(1).and_then(|v| v.split("</Code>").next()).unwrap_or("请求被拒绝"); return Err(format!("OSS 返回错误（{status}）：{code}")); }
    let objects = xml_blocks(&body, "Contents").into_iter().map(|object| json!({"Key": xml_text(&object, "Key"), "Size": xml_text(&object, "Size"), "LastModified": xml_text(&object, "LastModified"), "ETag": xml_text(&object, "ETag")})).filter(|object| object.get("Key").and_then(Value::as_str).is_some_and(|key| !key.is_empty() && key != prefix)).collect::<Vec<_>>();
    Ok(json!({"objects": objects, "prefixes": xml_blocks(&body, "CommonPrefixes").into_iter().map(|entry| xml_text(&entry, "Prefix")).filter(|value| !value.is_empty()).collect::<Vec<_>>(), "isTruncated": xml_text(&body, "IsTruncated").eq_ignore_ascii_case("true"), "nextMarker": xml_text(&body, "NextMarker")}))
}

async fn oss_get_acl(bucket: &str, location: &str, access_key_id: &str, access_key_secret: &str) -> Result<String, String> {
    let location = if location.is_empty() { "oss-cn-hangzhou" } else { location };
    let host = format!("{bucket}.{location}.aliyuncs.com");
    let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    let resource = format!("/{bucket}/?acl");
    let string_to_sign = format!("GET\n\n\n{date}\n{resource}");
    let mut mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|e| e.to_string())?;
    mac.update(string_to_sign.as_bytes());
    let response = reqwest::Client::new().get(format!("https://{host}/?acl"))
        .header("Date", date).header("Host", &host)
        .header("Authorization", format!("OSS {access_key_id}:{}", B64.encode(mac.finalize().into_bytes())))
        .timeout(std::time::Duration::from_secs(25)).send().await.map_err(|e| format!("OSS 请求失败: {e}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { let code = body.split("<Code>").nth(1).and_then(|v| v.split("</Code>").next()).unwrap_or("请求被拒绝"); return Err(format!("OSS 返回错误（{status}）：{code}")); }
    let grant = body.split("<Grant>").nth(1).and_then(|v| v.split("</Grant>").next()).unwrap_or("");
    Ok(grant.split("<Permission>").nth(1).and_then(|v| v.split("</Permission>").next()).unwrap_or("private").to_string())
}

async fn oss_set_public_read(bucket: &str, location: &str, access_key_id: &str, access_key_secret: &str) -> Result<(), String> {
    let location = if location.is_empty() { "oss-cn-hangzhou" } else { location };
    let host = format!("{bucket}.{location}.aliyuncs.com");
    let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    let resource = format!("/{bucket}/?acl");
    let string_to_sign = format!("PUT\n\n\n{date}\nx-oss-acl:public-read\n{resource}");
    let mut mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|e| e.to_string())?;
    mac.update(string_to_sign.as_bytes());
    let response = reqwest::Client::new().put(format!("https://{host}/?acl")).header("Date", date).header("Host", &host).header("x-oss-acl", "public-read").header("Content-Length", "0").header("Authorization", format!("OSS {access_key_id}:{}", B64.encode(mac.finalize().into_bytes()))).timeout(std::time::Duration::from_secs(25)).send().await.map_err(|e| format!("OSS 请求失败: {e}"))?;
    if !response.status().is_success() { return Err(format!("OSS 返回错误（{}）", response.status())); }
    Ok(())
}

async fn oss_set_cors(bucket: &str, location: &str, origins: &str, access_key_id: &str, access_key_secret: &str) -> Result<(), String> {
    let location = if location.is_empty() { "oss-cn-hangzhou" } else { location };
    let host = format!("{bucket}.{location}.aliyuncs.com");
    let safe_origin = origins.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let body = format!(r#"<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration><CORSRule><AllowedOrigin>{safe_origin}</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>POST</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>DELETE</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><ExposeHeader>x-oss-request-id</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>"#);
    let md5 = B64.encode(Md5::digest(body.as_bytes()));
    let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    let resource = format!("/{bucket}/?cors");
    let string_to_sign = format!("PUT\n{md5}\napplication/xml\n{date}\n{resource}");
    let mut mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|e| e.to_string())?;
    mac.update(string_to_sign.as_bytes());
    let response = reqwest::Client::new().put(format!("https://{host}/?cors")).header("Date", date).header("Host", &host).header("Content-Type", "application/xml").header("Content-MD5", md5).header("Authorization", format!("OSS {access_key_id}:{}", B64.encode(mac.finalize().into_bytes()))).body(body).timeout(std::time::Duration::from_secs(25)).send().await.map_err(|e| format!("OSS 请求失败: {e}"))?;
    if !response.status().is_success() { return Err(format!("OSS 返回错误（{}）", response.status())); }
    Ok(())
}

fn xml_text(body: &str, tag: &str) -> String {
    let open = format!("<{tag}>"); let close = format!("</{tag}>");
    body.find(&open).and_then(|start| body[start + open.len()..].find(&close).map(|end| body[start + open.len()..start + open.len() + end].to_string())).unwrap_or_default()
}

fn xml_blocks(body: &str, tag: &str) -> Vec<String> {
    let open = format!("<{tag}>"); let close = format!("</{tag}>"); let mut values = Vec::new(); let mut rest = body;
    while let Some(start) = rest.find(&open) { let chunk = &rest[start + open.len()..]; let Some(end) = chunk.find(&close) else { break }; values.push(chunk[..end].to_string()); rest = &chunk[end + close.len()..]; }
    values
}

fn cos_authorization(access_key_id: &str, access_key_secret: &str, host: &str, query: &str, sign_host: bool) -> Result<String, String> {
    let start = Utc::now().timestamp() - 1; let sign_time = format!("{start};{}", start + 900);
    let mut query_items = query.split('&').filter(|value| !value.is_empty()).map(|value| {
        let mut entry = value.splitn(2, '=');
        let key = percent_decode_str(entry.next().unwrap_or("")).decode_utf8_lossy();
        let value = percent_decode_str(entry.next().unwrap_or("")).decode_utf8_lossy();
        (rpc_encode(&key), rpc_encode(&value))
    }).collect::<Vec<_>>();
    query_items.sort(); let canonical_query = query_items.iter().map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>().join("&");
    let signed_query_keys = query_items.iter().map(|(key, _)| key.as_str()).collect::<Vec<_>>().join(";");
    let canonical_request = format!("get\n/\n{canonical_query}\n{}\n", if sign_host { format!("host={host}") } else { String::new() });
    let mut key_mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|e| e.to_string())?; key_mac.update(sign_time.as_bytes());
    let sign_key = hex::encode(key_mac.finalize().into_bytes());
    let string_to_sign = format!("sha1\n{sign_time}\n{:x}\n", Sha1::digest(canonical_request.as_bytes()));
    let mut sign_mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(sign_key.as_bytes()).map_err(|e| e.to_string())?; sign_mac.update(string_to_sign.as_bytes());
    Ok(format!("q-sign-algorithm=sha1&q-ak={}&q-sign-time={sign_time}&q-key-time={sign_time}&q-header-list={}&q-url-param-list={signed_query_keys}&q-signature={}", rpc_encode(access_key_id), if sign_host { "host" } else { "" }, hex::encode(sign_mac.finalize().into_bytes())))
}

async fn cos_request(bucket: &str, location: &str, query: &str, access_key_id: &str, access_key_secret: &str) -> Result<String, String> {
    let host = if bucket.is_empty() { "service.cos.myqcloud.com".to_string() } else { format!("{bucket}.cos.{location}.myqcloud.com") };
    let authorization = cos_authorization(access_key_id, access_key_secret, &host, query, !bucket.is_empty())?;
    let url = if query.is_empty() { format!("https://{host}/") } else { format!("https://{host}/?{query}") };
    let response = reqwest::Client::new().get(url).header("Host", &host).header("Authorization", authorization).timeout(std::time::Duration::from_secs(25)).send().await.map_err(|e| format!("COS 请求失败: {e}"))?;
    let status = response.status(); let body = response.text().await.map_err(|e| format!("COS 返回读取失败: {e}"))?;
    if !status.is_success() { let message = { let value = xml_text(&body, "Message"); if value.is_empty() { xml_text(&body, "Code") } else { value } }; return Err(format!("COS 返回错误（{status}）：{message}")); }
    Ok(body)
}

async fn cos_list_buckets(access_key_id: &str, access_key_secret: &str) -> Result<Vec<Value>, String> {
    let body = cos_request("", "", "", access_key_id, access_key_secret).await?;
    Ok(xml_blocks(&body, "Bucket").into_iter().map(|bucket| { let name = xml_text(&bucket, "Name"); let location = xml_text(&bucket, "Location"); json!({"Name": name, "Location": location, "CreationDate": xml_text(&bucket, "CreationDate"), "StorageClass": "Standard", "ExtranetEndpoint": format!("{}.cos.{}.myqcloud.com", name, location), "IntranetEndpoint": "-", "Acl": "private"}) }).filter(|bucket| bucket.get("Name").and_then(Value::as_str).is_some_and(|name| !name.is_empty())).collect())
}

async fn cos_list_objects(bucket: &str, location: &str, access_key_id: &str, access_key_secret: &str, prefix: &str, marker: &str) -> Result<Value, String> {
    let mut query = "list-type=2&max-keys=1000&delimiter=%2F".to_string();
    if !prefix.is_empty() { query.push_str(&format!("&prefix={}", rpc_encode(prefix))); }
    if !marker.is_empty() { query.push_str(&format!("&continuation-token={}", rpc_encode(marker))); }
    let body = cos_request(bucket, location, &query, access_key_id, access_key_secret).await?;
    let objects = xml_blocks(&body, "Contents").into_iter().map(|object| json!({"Key": xml_text(&object, "Key"), "Size": xml_text(&object, "Size"), "LastModified": xml_text(&object, "LastModified"), "ETag": xml_text(&object, "ETag")})).filter(|object| object.get("Key").and_then(Value::as_str).is_some_and(|key| !key.is_empty() && key != prefix)).collect::<Vec<_>>();
    Ok(json!({"objects": objects, "prefixes": xml_blocks(&body, "CommonPrefixes").into_iter().map(|entry| xml_text(&entry, "Prefix")).filter(|value| !value.is_empty()).collect::<Vec<_>>(), "isTruncated": xml_text(&body, "IsTruncated").eq_ignore_ascii_case("true"), "nextMarker": xml_text(&body, "NextContinuationToken")}))
}

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

async fn list_regions(access_key_id: &str, access_key_secret: &str) -> Result<Vec<(String, String)>, String> {
    let result = aliyun_rpc("ecs.aliyuncs.com", "2014-05-26", "DescribeRegions", BTreeMap::new(), access_key_id, access_key_secret).await?;
    Ok(array_at(&result, &["Regions", "Region"]).into_iter().filter_map(|r| Some((r.get("RegionId")?.as_str()?.to_string(), r.get("LocalName").and_then(Value::as_str).unwrap_or("").to_string()))).collect())
}

async fn resource_items(resource_type: &str, access_key_id: &str, access_key_secret: &str) -> ResourceResponse {
    let mut items = Vec::new(); let mut errors = Vec::new();
    let mut add_error = |message: String| errors.push(message);
    match resource_type {
        "ecs" => match list_regions(access_key_id, access_key_secret).await {
            Ok(regions) => for (region_id, region_name) in regions {
                let params = string_params(&[("RegionId", region_id.clone()), ("PageSize", "100".into())]);
                match aliyun_rpc(&format!("ecs.{region_id}.aliyuncs.com"), "2014-05-26", "DescribeInstances", params, access_key_id, access_key_secret).await {
                    Ok(result) => for item in array_at(&result, &["Instances", "Instance"]) { let mut v = item.clone(); if let Value::Object(ref mut object) = v { object.insert("_region_id".into(), json!(region_id)); object.insert("_region_name".into(), json!(region_name)); } items.push(v); },
                    Err(error) => add_error(format!("{region_id}: {error}")),
                }
            },
            Err(error) => add_error(error),
        },
        // The account domain list in the reference page comes from the Domain Registration API,
        // not AliDNS. AliDNS DescribeDomains rejects PageSize=200 for some accounts.
        "domain" => {
            let registration = aliyun_rpc("domain.aliyuncs.com", "2018-01-29", "QueryDomainList", string_params(&[("PageNum", "1".into()), ("PageSize", "100".into())]), access_key_id, access_key_secret).await;
            let dns = aliyun_rpc("alidns.aliyuncs.com", "2015-01-09", "DescribeDomains", string_params(&[("PageNumber", "1".into()), ("PageSize", "20".into())]), access_key_id, access_key_secret).await;
            let registration_failed = registration.is_err(); let dns_failed = dns.is_err();
            let mut merged: BTreeMap<String, Value> = BTreeMap::new();
            if let Ok(result) = registration { for item in array_at(&result, &["Data", "Domain"]) { if let Some(name) = item.get("DomainName").and_then(Value::as_str) { merged.insert(name.to_lowercase(), (*item).clone()); } } }
            if let Ok(result) = dns { for item in array_at(&result, &["Domains", "Domain"]) { if let Some(name) = item.get("DomainName").and_then(Value::as_str) { let entry = merged.entry(name.to_lowercase()).or_insert_with(|| json!({"DomainName": name})); if let (Value::Object(target), Value::Object(source)) = (entry, (*item).clone()) { for (key, value) in source { target.insert(key, value); } } } } }
            if merged.is_empty() && registration_failed && dns_failed { add_error("域名注册和 DNS 接口均请求失败".into()); }
            items.extend(merged.into_values());
        },
        "rds" => match list_regions(access_key_id, access_key_secret).await {
            Ok(regions) => for (region_id, region_name) in regions {
                let params = string_params(&[("RegionId", region_id.clone()), ("PageSize", "100".into())]);
                match aliyun_rpc("rds.aliyuncs.com", "2014-08-15", "DescribeDBInstances", params, access_key_id, access_key_secret).await {
                    Ok(result) => for item in array_at(&result, &["Items", "DBInstance"]) { let mut v=item.clone(); if let Value::Object(ref mut o)=v { o.insert("_region_id".into(), json!(region_id)); o.insert("_region_name".into(), json!(region_name)); } items.push(v); }, Err(error)=>add_error(format!("{region_id}: {error}")),
                }
            }, Err(error)=>add_error(error),
        },
        "redis" => match list_regions(access_key_id, access_key_secret).await {
            Ok(regions) => for (region_id, region_name) in regions {
                let params = string_params(&[("RegionId", region_id.clone()), ("PageSize", "100".into())]);
                match aliyun_rpc("r-kvstore.aliyuncs.com", "2015-01-01", "DescribeInstances", params, access_key_id, access_key_secret).await {
                    Ok(result) => for item in array_at(&result, &["Instances", "KVStoreInstance"]) { let mut v=item.clone(); if let Value::Object(ref mut o)=v { o.insert("_region_id".into(), json!(region_id)); o.insert("_region_name".into(), json!(region_name)); } items.push(v); }, Err(error)=>add_error(format!("{region_id}: {error}")),
                }
            }, Err(error)=>add_error(error),
        },
        "swas" => {
            let regions = ["cn-hangzhou", "cn-shanghai", "cn-beijing", "cn-shenzhen", "cn-hongkong", "ap-southeast-1"];
            for region_id in regions { let params=string_params(&[("RegionId", region_id.to_string()), ("PageSize", "100".into())]); match aliyun_rpc(&format!("swas.{region_id}.aliyuncs.com"), "2020-06-01", "ListInstances", params, access_key_id, access_key_secret).await { Ok(result)=>items.extend(array_at(&result, &["Instances"]).into_iter().cloned()), Err(error)=>add_error(format!("{region_id}: {error}")) } }
        },
        "esa" => match aliyun_esa("ListSites", string_params(&[("PageNumber", "1".into()), ("PageSize", "100".into())]), "GET", access_key_id, access_key_secret).await { Ok(result)=>items.extend(array_at(&result, &["Sites"]).into_iter().cloned()), Err(error)=>add_error(error) },
        "oss" => match oss_list_buckets(access_key_id, access_key_secret).await { Ok(values) => items.extend(values), Err(error) => add_error(error) },
        other => add_error(format!("暂不支持资源类型: {other}")),
    }
    ResourceResponse { resource_type: resource_type.to_string(), items, errors, fetched_at: Utc::now().timestamp_millis() }
}

fn tencent_number(value: Option<&Value>) -> f64 {
    value.and_then(Value::as_f64)
        .or_else(|| value.and_then(Value::as_i64).map(|number| number as f64))
        .or_else(|| value.and_then(Value::as_str).and_then(|text| text.parse::<f64>().ok()))
        .unwrap_or(0.0)
}

fn tencent_instance(item: &Value, region: &Value) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        let state = item.get("InstanceState").and_then(Value::as_str).unwrap_or("");
        let status = match state.to_uppercase().as_str() { "RUNNING" => "Running", "STOPPED" => "Stopped", _ => state };
        let network = item.get("InternetAccessible").cloned().unwrap_or_else(|| json!({}));
        target.insert("InstanceName".into(), item.get("InstanceName").cloned().or_else(|| item.get("InstanceId").cloned()).unwrap_or(json!("")));
        target.insert("Status".into(), json!(status));
        target.insert("PublicIpAddress".into(), item.get("PublicIpAddresses").cloned().unwrap_or_else(|| json!([])));
        target.insert("PrivateIpAddress".into(), item.get("PrivateIpAddresses").cloned().unwrap_or_else(|| json!([])));
        target.insert("Cpu".into(), item.get("CPU").cloned().unwrap_or(json!(0)));
        target.insert("Memory".into(), item.get("Memory").cloned().unwrap_or(json!(0)));
        target.insert("InternetMaxBandwidthIn".into(), json!(0));
        target.insert("InternetMaxBandwidthOut".into(), network.get("InternetMaxBandwidthOut").cloned().unwrap_or(json!(0)));
        target.insert("OSName".into(), item.get("OsName").or_else(|| item.get("OsType")).cloned().unwrap_or(json!("-")));
        target.insert("CreationTime".into(), item.get("CreatedTime").cloned().unwrap_or(json!("")));
        target.insert("ExpiredTime".into(), item.get("ExpiredTime").cloned().unwrap_or(json!("")));
        target.insert("_region_id".into(), region.get("Region").cloned().unwrap_or(json!("")));
        target.insert("_region_name".into(), region.get("RegionName").or_else(|| region.get("Region")).cloned().unwrap_or(json!("")));
    }
    value
}

fn tencent_lighthouse_instance(item: &Value, region: &str) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        let state = item.get("InstanceState").or_else(|| item.get("InstanceStatus")).and_then(Value::as_str).unwrap_or("");
        let status = match state.to_uppercase().as_str() { "RUNNING" => "Running", "STOPPED" => "Stopped", _ => state };
        let public_addresses = item.get("PublicAddresses").or_else(|| item.get("PublicIpAddresses")).cloned().unwrap_or_else(|| json!([]));
        target.insert("InstanceName".into(), item.get("InstanceName").cloned().or_else(|| item.get("InstanceId").cloned()).unwrap_or(json!("")));
        target.insert("Status".into(), json!(status));
        target.insert("InstanceStatus".into(), json!(status));
        target.insert("PublicIpAddress".into(), public_addresses.clone());
        target.insert("PublicIp".into(), public_addresses.as_array().and_then(|values| values.first()).cloned().unwrap_or_else(|| json!("")));
        target.insert("ImageName".into(), item.get("BlueprintName").or_else(|| item.get("BlueprintId")).cloned().unwrap_or(json!("")));
        target.insert("PlanId".into(), item.get("BundleId").or_else(|| item.get("BundleName")).cloned().unwrap_or(json!("")));
        target.insert("ExpiredTime".into(), item.get("ExpiredTime").cloned().unwrap_or(json!("")));
        target.insert("_region_id".into(), json!(region));
    }
    value
}

fn tencent_cdb_instance(item: &Value, region: &str) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        let status = item.get("Status").or_else(|| item.get("DBInstanceStatus")).and_then(Value::as_str).unwrap_or("");
        target.insert("DBInstanceId".into(), item.get("InstanceId").or_else(|| item.get("DBInstanceId")).cloned().unwrap_or(json!("")));
        target.insert("DBInstanceDescription".into(), item.get("InstanceName").or_else(|| item.get("DBInstanceDescription")).or_else(|| item.get("InstanceId")).cloned().unwrap_or(json!("")));
        target.insert("DBInstanceStatus".into(), json!(match status { "1" => "Running", "0" => "Stopped", _ => status }));
        target.insert("DBInstanceType".into(), item.get("DeviceType").or_else(|| item.get("InstanceType")).cloned().unwrap_or(json!("")));
        target.insert("DBInstanceClass".into(), item.get("InstanceType").or_else(|| item.get("Model")).cloned().unwrap_or(json!("")));
        target.insert("DBInstanceStorage".into(), item.get("Volume").or_else(|| item.get("Storage")).cloned().unwrap_or(json!(0)));
        target.insert("ConnectionString".into(), item.get("Vip").or_else(|| item.get("ConnectionString")).cloned().unwrap_or(json!("")));
        target.insert("Port".into(), item.get("Vport").or_else(|| item.get("Port")).cloned().unwrap_or(json!("")));
        target.insert("DBInstanceNetType".into(), json!(if item.get("ProjectId").is_some() { "私有网络" } else { "-" }));
        target.insert("Engine".into(), item.get("Engine").cloned().unwrap_or(json!("MySQL")));
        target.insert("EngineVersion".into(), item.get("EngineVersion").cloned().unwrap_or(json!("")));
        target.insert("CreateTime".into(), item.get("CreateTime").cloned().unwrap_or(json!("")));
        target.insert("ExpireTime".into(), item.get("DeadlineTime").or_else(|| item.get("ExpireTime")).cloned().unwrap_or(json!("")));
        target.insert("_region_id".into(), json!(region));
    }
    value
}

fn tencent_redis_instance(item: &Value, region: &str) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        let status = item.get("Status").or_else(|| item.get("InstanceStatus")).and_then(Value::as_str).unwrap_or("");
        let normalized = if ["2", "RUNNING", "NORMAL"].contains(&status.to_uppercase().as_str()) { "Normal" } else { status };
        target.insert("InstanceName".into(), item.get("InstanceName").or_else(|| item.get("InstanceId")).cloned().unwrap_or(json!("")));
        target.insert("InstanceStatus".into(), json!(normalized));
        target.insert("InstanceType".into(), item.get("Type").or_else(|| item.get("TypeName")).cloned().unwrap_or(json!("")));
        target.insert("InstanceClass".into(), item.get("Size").or_else(|| item.get("TypeName")).cloned().unwrap_or(json!("")));
        target.insert("Capacity".into(), item.get("Size").or_else(|| item.get("Capacity")).cloned().unwrap_or(json!(0)));
        target.insert("Bandwidth".into(), item.get("Bandwidth").cloned().unwrap_or(json!(0)));
        target.insert("Connections".into(), item.get("ClientLimit").or_else(|| item.get("Connections")).cloned().unwrap_or(json!(0)));
        target.insert("ConnectionDomain".into(), item.get("WanIp").or_else(|| item.get("PrivateIp")).or_else(|| item.get("ConnectionDomain")).cloned().unwrap_or(json!("")));
        target.insert("Port".into(), item.get("Port").cloned().unwrap_or(json!("")));
        target.insert("EngineVersion".into(), item.get("CurrentRedisVersion").or_else(|| item.get("RedisVersion")).cloned().unwrap_or(json!("")));
        target.insert("NetworkType".into(), item.get("NetType").cloned().unwrap_or(json!("")));
        target.insert("ChargeType".into(), item.get("BillingMode").cloned().unwrap_or(json!("")));
        target.insert("EndTime".into(), item.get("DeadTime").or_else(|| item.get("EndTime")).cloned().unwrap_or(json!("")));
        target.insert("ArchitectureType".into(), item.get("Type").cloned().unwrap_or(json!("standard")));
        target.insert("_region_id".into(), json!(region));
    }
    value
}

fn tencent_edge_zone(item: &Value) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        target.insert("SiteId".into(), item.get("ZoneId").or_else(|| item.get("Id")).cloned().unwrap_or(json!("")));
        target.insert("SiteName".into(), item.get("ZoneName").or_else(|| item.get("ZoneId")).cloned().unwrap_or(json!("")));
        target.insert("DomainName".into(), item.get("ZoneName").cloned().unwrap_or(json!("")));
        target.insert("Status".into(), item.get("ActiveStatus").or_else(|| item.get("Status")).cloned().unwrap_or(json!("")));
        target.insert("AccessType".into(), item.get("Type").or_else(|| item.get("ZoneType")).cloned().unwrap_or(json!("")));
        target.insert("Coverage".into(), item.get("Area").or_else(|| item.get("PlanType")).cloned().unwrap_or(json!("")));
        target.insert("PlanName".into(), item.get("PlanType").or_else(|| item.get("Plan")).cloned().unwrap_or(json!("")));
    }
    value
}

async fn tencent_regions(access_key_id: &str, access_key_secret: &str) -> Result<Vec<String>, String> {
    let data = tencent_request("cvm", "2017-03-12", "DescribeRegions", json!({}), None, access_key_id, access_key_secret).await?;
    Ok(array_at(&data, &["RegionSet"]).into_iter().filter(|region| region.get("RegionState").and_then(Value::as_str).unwrap_or("AVAILABLE").eq_ignore_ascii_case("AVAILABLE")).filter_map(|region| region.get("Region").and_then(Value::as_str).filter(|value| !value.is_empty()).map(String::from)).collect())
}

fn tencent_registered_domain(item: &Value) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        target.insert("DomainName".into(), item.get("DomainName").or_else(|| item.get("Name")).cloned().unwrap_or(json!("")));
        target.insert("RegistrationDate".into(), item.get("RegistrationDate").or_else(|| item.get("CreationDate")).or_else(|| item.get("CreatedOn")).cloned().unwrap_or(json!("")));
        target.insert("ExpirationDate".into(), item.get("ExpirationDate").or_else(|| item.get("ExpiredDate")).cloned().unwrap_or(json!("")));
        target.insert("RegistrantOrganization".into(), item.get("RegistrantOrganization").or_else(|| item.get("RegistrantName")).cloned().unwrap_or(json!("")));
        target.insert("DomainAuditStatus".into(), item.get("RealNameAuditStatus").or_else(|| item.get("DomainAuditStatus")).cloned().unwrap_or(json!("")));
        target.insert("DomainStatus".into(), item.get("Status").cloned().unwrap_or(json!("")));
        target.insert("DnsServers".into(), item.get("DnsList").or_else(|| item.get("NameServerSet")).cloned().unwrap_or(json!([])));
    }
    value
}

fn tencent_dnspod_domain(item: &Value) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        target.insert("DomainName".into(), item.get("Name").or_else(|| item.get("DomainName")).cloned().unwrap_or(json!("")));
        target.insert("RecordCount".into(), json!(tencent_number(item.get("RecordCount"))));
        target.insert("VersionCode".into(), item.get("Grade").or_else(|| item.get("GradeTitle")).cloned().unwrap_or(json!("")));
        target.insert("CreateTime".into(), item.get("CreatedOn").or_else(|| item.get("CreatedAt")).cloned().unwrap_or(json!("")));
        target.insert("DomainStatus".into(), item.get("Status").cloned().unwrap_or(json!("")));
        target.insert("DnsServers".into(), item.get("NameServers").cloned().unwrap_or(json!([])));
        target.insert("DnsSource".into(), json!("DNSPod"));
    }
    value
}

async fn tencent_paged(
    service: &str, version: &str, action: &str, payload: Value, path: &[&str], region: Option<&str>,
    access_key_id: &str, access_key_secret: &str,
) -> Result<Vec<Value>, String> {
    let mut items = Vec::new();
    for offset in (0..10_000).step_by(100) {
        let mut params = payload.clone();
        let object = params.as_object_mut().ok_or("腾讯云分页请求参数无效")?;
        object.insert("Offset".into(), json!(offset));
        object.insert("Limit".into(), json!(100));
        let data = tencent_request(service, version, action, params, region, access_key_id, access_key_secret).await?;
        let page = array_at(&data, path).into_iter().cloned().collect::<Vec<_>>();
        let total = tencent_number(data.get("TotalCount").or_else(|| data.pointer("/DomainCountInfo/AllTotal")).or_else(|| data.pointer("/DomainCountInfo/TotalCount"))) as usize;
        let count = page.len();
        items.extend(page);
        if count == 0 || count < 100 || (total > 0 && items.len() >= total) { break; }
    }
    Ok(items)
}

async fn tencent_resource_items(id: i64, resource_type: &str, access_key_id: &str, access_key_secret: &str) -> ResourceResponse {
    let mut items = Vec::new();
    let mut errors = Vec::new();
    if let Err(error) = ensure_tencent_account(id) {
        return ResourceResponse { resource_type: resource_type.into(), items, errors: vec![error], fetched_at: Utc::now().timestamp_millis() };
    }
    match resource_type {
        "ecs" => match tencent_request("cvm", "2017-03-12", "DescribeRegions", json!({}), None, access_key_id, access_key_secret).await {
            Ok(data) => for region in array_at(&data, &["RegionSet"]) {
                if !region.get("RegionState").and_then(Value::as_str).unwrap_or("AVAILABLE").eq_ignore_ascii_case("AVAILABLE") { continue; }
                let region_id = region.get("Region").and_then(Value::as_str).unwrap_or("");
                match tencent_paged("cvm", "2017-03-12", "DescribeInstances", json!({}), &["InstanceSet"], Some(region_id), access_key_id, access_key_secret).await {
                    Ok(values) => items.extend(values.iter().map(|item| tencent_instance(item, region))),
                    Err(error) => errors.push(format!("{}: {error}", if region_id.is_empty() { "未知地域" } else { region_id })),
                }
            },
            Err(error) => errors.push(error),
        },
        "domain" => {
            let registration = tencent_paged("domain", "2018-08-08", "DescribeDomainNameList", json!({}), &["DomainSet"], None, access_key_id, access_key_secret).await;
            let dns = tencent_paged("dnspod", "2021-03-23", "DescribeDomainList", json!({}), &["DomainList"], None, access_key_id, access_key_secret).await;
            let mut merged: BTreeMap<String, Value> = BTreeMap::new();
            match registration { Ok(values) => for item in values { let domain = tencent_registered_domain(&item); if let Some(name) = domain.get("DomainName").and_then(Value::as_str).filter(|name| !name.is_empty()) { merged.insert(name.to_lowercase(), domain); } }, Err(error) => errors.push(format!("域名注册: {error}")) }
            match dns { Ok(values) => for item in values { let domain = tencent_dnspod_domain(&item); if let Some(name) = domain.get("DomainName").and_then(Value::as_str).filter(|name| !name.is_empty()) { let entry = merged.entry(name.to_lowercase()).or_insert_with(|| json!({"DomainName": name})); if let (Value::Object(target), Value::Object(source)) = (entry, domain) { for (key, value) in source { target.insert(key, value); } } } }, Err(error) => errors.push(format!("DNSPod: {error}")) }
            items.extend(merged.into_values());
        },
        "swas" => {
            let fallback_region = match account_region_id(id) { Ok(region) => region, Err(error) => { errors.push(error); return ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: Utc::now().timestamp_millis() }; } };
            let mut regions = vec![fallback_region.clone()];
            match tencent_request("lighthouse", "2020-03-24", "DescribeRegions", json!({}), None, access_key_id, access_key_secret).await {
                Ok(data) => {
                    let mut listed = array_at(&data, &["RegionSet"]).into_iter()
                        .filter(|region| region.get("RegionState").and_then(Value::as_str).unwrap_or("AVAILABLE").eq_ignore_ascii_case("AVAILABLE"))
                        .filter_map(|region| region.get("Region").and_then(Value::as_str).filter(|value| !value.is_empty()).map(String::from))
                        .collect::<Vec<_>>();
                    listed.push(fallback_region);
                    listed.sort(); listed.dedup(); regions = listed;
                },
                Err(error) => errors.push(format!("读取轻量服务器地域失败，已仅查询 {}: {error}", fallback_region)),
            }
            for region in regions {
                match tencent_paged("lighthouse", "2020-03-24", "DescribeInstances", json!({}), &["InstanceSet"], Some(&region), access_key_id, access_key_secret).await {
                    Ok(values) => items.extend(values.iter().map(|item| tencent_lighthouse_instance(item, &region))),
                    Err(error) => errors.push(format!("{region}: {error}")),
                }
            }
        },
        "rds" | "redis" => match tencent_regions(access_key_id, access_key_secret).await {
            Ok(regions) => for region in regions {
                let (service, version, path) = if resource_type == "rds" { ("cdb", "2017-03-20", &["Items"][..]) } else { ("redis", "2018-04-12", &["InstanceSet"][..]) };
                let action = if resource_type == "rds" { "DescribeDBInstances" } else { "DescribeInstances" };
                match tencent_paged(service, version, action, json!({}), path, Some(&region), access_key_id, access_key_secret).await {
                    Ok(values) => items.extend(values.iter().map(|item| if resource_type == "rds" { tencent_cdb_instance(item, &region) } else { tencent_redis_instance(item, &region) })),
                    Err(error) => errors.push(format!("{region}: {error}")),
                }
            },
            Err(error) => errors.push(error),
        },
        "oss" => match cos_list_buckets(access_key_id, access_key_secret).await { Ok(values) => items.extend(values), Err(error) => errors.push(error) },
        "esa" => match tencent_paged("teo", "2022-09-01", "DescribeZones", json!({}), &["Zones"], None, access_key_id, access_key_secret).await {
            Ok(values) => items.extend(values.iter().map(tencent_edge_zone)),
            Err(error) => errors.push(error),
        },
        other => errors.push(format!("腾讯云暂未接入 {other} 资源")),
    }
    ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: Utc::now().timestamp_millis() }
}

fn volc_instance(item: &Value, region: &str) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        let instance_id = item.get("InstanceId").or_else(|| item.get("InstanceID")).cloned().unwrap_or(json!(""));
        let status = item.get("Status").or_else(|| item.get("InstanceStatus")).cloned().unwrap_or(json!(""));
        target.insert("InstanceId".into(), instance_id.clone());
        target.insert("InstanceName".into(), item.get("InstanceName").cloned().unwrap_or(instance_id));
        target.insert("Status".into(), status.clone()); target.insert("InstanceStatus".into(), status);
        target.insert("PublicIpAddress".into(), item.get("PublicIpAddress").or_else(|| item.pointer("/PublicIpAddresses/0")).or_else(|| item.get("EipAddress")).cloned().unwrap_or(json!("")));
        target.insert("_region_id".into(), json!(region));
    }
    value
}

fn volc_rds_instance(item: &Value, region: &str) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        let instance_id = item.get("DBInstanceId").or_else(|| item.get("InstanceId")).or_else(|| item.get("InstanceID")).cloned().unwrap_or(json!(""));
        target.insert("DBInstanceId".into(), instance_id.clone());
        target.insert("DBInstanceDescription".into(), item.get("DBInstanceName").or_else(|| item.get("InstanceName")).cloned().unwrap_or(instance_id));
        target.insert("DBInstanceStatus".into(), item.get("Status").or_else(|| item.get("DBInstanceStatus")).cloned().unwrap_or(json!("")));
        target.insert("Engine".into(), item.get("Engine").cloned().unwrap_or(json!("MySQL")));
        target.insert("_region_id".into(), json!(region));
    }
    value
}

fn volc_swas_instance(item: &Value, region: &str) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        let instance_id = item.get("InstanceId").or_else(|| item.get("InstanceID")).cloned().unwrap_or(json!(""));
        let status = item.get("Status").or_else(|| item.get("InstanceStatus")).cloned().unwrap_or(json!(""));
        target.insert("InstanceId".into(), instance_id.clone());
        target.insert("InstanceName".into(), item.get("InstanceName").or_else(|| item.get("Name")).cloned().unwrap_or(instance_id));
        target.insert("Status".into(), status.clone()); target.insert("InstanceStatus".into(), status);
        target.insert("PublicIpAddress".into(), item.get("PublicIpAddress").or_else(|| item.get("PublicIp")).or_else(|| item.pointer("/PublicIpAddresses/0")).or_else(|| item.get("EipAddress")).cloned().unwrap_or(json!("")));
        target.insert("_region_id".into(), json!(region));
    }
    value
}

fn volc_redis_instance(item: &Value, region: &str) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        let instance_id = item.get("InstanceId").or_else(|| item.get("InstanceID")).or_else(|| item.get("DBInstanceId")).or_else(|| item.get("RedisInstanceId")).cloned().unwrap_or(json!(""));
        let status = item.get("Status").or_else(|| item.get("InstanceStatus")).cloned().unwrap_or(json!(""));
        target.insert("KVStoreInstanceId".into(), instance_id.clone()); target.insert("InstanceId".into(), instance_id.clone());
        target.insert("InstanceName".into(), item.get("InstanceName").or_else(|| item.get("DBInstanceName")).or_else(|| item.get("Name")).cloned().unwrap_or(instance_id));
        target.insert("InstanceStatus".into(), status.clone()); target.insert("DBInstanceStatus".into(), status);
        target.insert("EngineVersion".into(), item.get("EngineVersion").or_else(|| item.get("RedisVersion")).cloned().unwrap_or(json!("Redis")));
        target.insert("_region_id".into(), json!(region));
    }
    value
}

fn volc_edge_domain(item: &Value) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        let domain = item.get("DomainName").or_else(|| item.get("Domain")).or_else(|| item.get("Name")).cloned().unwrap_or(json!(""));
        target.insert("SiteId".into(), item.get("DomainId").or_else(|| item.get("DomainID")).cloned().unwrap_or(domain.clone()));
        target.insert("SiteName".into(), domain.clone()); target.insert("DomainName".into(), domain);
        target.insert("Status".into(), item.get("Status").or_else(|| item.get("DomainStatus")).cloned().unwrap_or(json!("")));
        target.insert("AccessType".into(), item.get("ServiceType").or_else(|| item.get("BusinessType")).cloned().unwrap_or(json!("CDN")));
        target.insert("Coverage".into(), item.get("Area").or_else(|| item.get("Scope")).cloned().unwrap_or(json!("")));
        target.insert("PlanName".into(), item.get("Plan").or_else(|| item.get("ProductType")).cloned().unwrap_or(json!("")));
    }
    value
}

fn volc_dns_zone(item: &Value) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        let expires_at = item.get("ExpiredTime").and_then(Value::as_i64).unwrap_or_default();
        let expiration = if expires_at > 0 {
            let timestamp = if expires_at < 1_000_000_000_000 { expires_at.saturating_mul(1_000) } else { expires_at };
            Utc.timestamp_millis_opt(timestamp).single().map(|value| value.to_rfc3339()).unwrap_or_default()
        } else { String::new() };
        target.insert("DomainName".into(), item.get("ZoneName").cloned().unwrap_or(json!("")));
        target.insert("DomainStatus".into(), json!("正常"));
        target.insert("RegistrationDate".into(), item.get("CreatedAt").cloned().unwrap_or(json!("")));
        target.insert("ExpirationDate".into(), json!(expiration));
        target.insert("RecordCount".into(), item.get("RecordCount").cloned().unwrap_or(json!(0)));
    }
    value
}

async fn volc_resource_items(id: i64, resource_type: &str, access_key_id: &str, access_key_secret: &str) -> ResourceResponse {
    let mut items = Vec::new(); let mut errors = Vec::new();
    let region = match volc_region_id(id) { Ok(region) => region, Err(error) => return ResourceResponse { resource_type: resource_type.into(), items, errors: vec![error], fetched_at: Utc::now().timestamp_millis() } };
    match resource_type {
        "ecs" => match volc_request("ecs", "2020-04-01", "DescribeInstances", string_params(&[("PageSize", "100".into()), ("PageNumber", "1".into())]), &region, access_key_id, access_key_secret).await {
            Ok(data) => { let source = if !array_at(&data, &["Instances"]).is_empty() { array_at(&data, &["Instances"]) } else { array_at(&data, &["Instances", "Instance"]) }; items.extend(source.into_iter().map(|item| volc_instance(item, &region))); },
            Err(error) => errors.push(error),
        },
        "oss" => match volc_tos_list_buckets(&region, access_key_id, access_key_secret).await { Ok(values) => items.extend(values), Err(error) => errors.push(error) },
        "domain" => match volc_json_request("dns", "2018-08-01", "ListZones", json!({"PageSize": 100, "PageNumber": 1}), &region, access_key_id, access_key_secret).await {
            Ok(data) => items.extend(array_at(&data, &["Zones"]).into_iter().map(volc_dns_zone)),
            Err(error) => errors.push(error),
        },
        "rds" => match volc_request("rds_mysql", "2018-01-01", "DescribeDBInstances", string_params(&[("PageSize", "100".into()), ("PageNumber", "1".into())]), &region, access_key_id, access_key_secret).await {
            Ok(data) => { let source = if !array_at(&data, &["DBInstances"]).is_empty() { array_at(&data, &["DBInstances"]) } else { array_at(&data, &["Items"]) }; items.extend(source.into_iter().map(|item| volc_rds_instance(item, &region))); },
            Err(error) => errors.push(error),
        },
        "swas" => match volc_request("lighthouse", "2020-04-01", "DescribeInstances", string_params(&[("PageSize", "100".into()), ("PageNumber", "1".into())]), &region, access_key_id, access_key_secret).await {
            Ok(data) => { let source = if !array_at(&data, &["Instances"]).is_empty() { array_at(&data, &["Instances"]) } else { array_at(&data, &["InstanceSet"]) }; items.extend(source.into_iter().map(|item| volc_swas_instance(item, &region))); },
            Err(error) => errors.push(error),
        },
        "redis" => match volc_request("Redis", "2020-12-07", "DescribeDBInstances", string_params(&[("PageSize", "100".into()), ("PageNumber", "1".into())]), &region, access_key_id, access_key_secret).await {
            Ok(data) => { let source = if !array_at(&data, &["DBInstances"]).is_empty() { array_at(&data, &["DBInstances"]) } else { array_at(&data, &["Items"]) }; items.extend(source.into_iter().map(|item| volc_redis_instance(item, &region))); },
            Err(error) => errors.push(error),
        },
        "esa" => match volc_request("cdn", "2021-03-01", "ListCdnDomains", string_params(&[("PageSize", "100".into()), ("PageNumber", "1".into())]), &region, access_key_id, access_key_secret).await {
            Ok(data) => { let source = if !array_at(&data, &["Domains"]).is_empty() { array_at(&data, &["Domains"]) } else { array_at(&data, &["DomainList"]) }; items.extend(source.into_iter().map(volc_edge_domain)); },
            Err(error) => errors.push(error),
        },
        other => errors.push(format!("火山引擎暂未接入 {other} 资源")),
    }
    ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: Utc::now().timestamp_millis() }
}

#[derive(Clone)]
struct OracleCredentials {
    user_ocid: String,
    tenancy_ocid: String,
    fingerprint: String,
    private_key: String,
    region: String,
}

fn oracle_credentials(id: i64) -> Result<OracleCredentials, String> {
    let conn = open_db()?;
    let row: (String, String, Option<String>, Option<String>, i64, String) = conn.query_row(
        "SELECT access_key_id,secret_ciphertext,credential_meta,region_id,enabled,cloud_type FROM cloud_accounts WHERE id=?1",
        [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
    ).map_err(|e| format!("读取 OCI 账号失败: {e}"))?;
    if row.4 != 1 { return Err("云账号已停用".into()); }
    if row.5 != "oracle" { return Err("当前账号不是 Oracle Cloud 账号".into()); }
    let meta: Value = serde_json::from_str(row.2.as_deref().unwrap_or("{}")).map_err(|_| "OCI 账号元数据格式无效".to_string())?;
    let tenancy_ocid = meta.get("tenancy_ocid").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let fingerprint = meta.get("key_fingerprint").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if tenancy_ocid.is_empty() || fingerprint.is_empty() { return Err("OCI 账号缺少 Tenancy OCID 或 Key Fingerprint".into()); }
    Ok(OracleCredentials {
        user_ocid: row.0,
        tenancy_ocid,
        fingerprint,
        private_key: normalize_oci_private_key(&decrypt_secret(&row.1)?),
        region: row.3.filter(|value| !value.trim().is_empty()).unwrap_or_else(|| "ap-tokyo-1".into()),
    })
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

fn oracle_query(params: &[(String, String)]) -> String {
    params.iter().map(|(key, value)| format!("{}={}", rpc_encode(key), rpc_encode(value))).collect::<Vec<_>>().join("&")
}

async fn oracle_request(credentials: &OracleCredentials, host: &str, path: &str) -> Result<(Value, Option<String>), String> {
    let private_key = RsaPrivateKey::from_pkcs8_pem(&credentials.private_key)
        .or_else(|_| RsaPrivateKey::from_pkcs1_pem(&credentials.private_key))
        .map_err(|_| "OCI API 私钥无效，需使用未加密的 RSA PEM 私钥".to_string())?;
    let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    let canonical = format!("(request-target): get {path}\nhost: {host}\ndate: {date}");
    let signer = SigningKey::<Sha256>::new(private_key);
    let signature = B64.encode(signer.sign(canonical.as_bytes()).to_vec());
    let key_id = format!("{}/{}/{}", credentials.tenancy_ocid, credentials.user_ocid, credentials.fingerprint);
    let authorization = format!("Signature version=\"1\",keyId=\"{key_id}\",algorithm=\"rsa-sha256\",headers=\"(request-target) host date\",signature=\"{signature}\"");
    let response = reqwest::Client::new().get(format!("https://{host}{path}"))
        .header("host", host).header("date", &date).header("authorization", authorization)
        .timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("OCI 请求失败: {error}"))?;
    let status = response.status();
    let next_page = response.headers().get("opc-next-page").and_then(|value| value.to_str().ok()).map(str::to_string);
    let text = response.text().await.map_err(|error| format!("OCI 返回读取失败: {error}"))?;
    let data = serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text));
    if !status.is_success() {
        let message = data.get("message").or_else(|| data.get("code")).and_then(Value::as_str).unwrap_or("OCI API 返回错误").to_string();
        write_api_log(&credentials.user_ocid, host, &format!("GET {}", path.split('?').next().unwrap_or(path)), &json!({}), Some(&data), "失败", Some(&message));
        return Err(message);
    }
    write_api_log(&credentials.user_ocid, host, &format!("GET {}", path.split('?').next().unwrap_or(path)), &json!({}), Some(&data), "成功", None);
    Ok((data, next_page))
}

async fn oracle_pages(credentials: &OracleCredentials, host: &str, base_path: &str, query: Vec<(String, String)>) -> Result<Vec<Value>, String> {
    let mut values = Vec::new(); let mut page: Option<String> = None;
    for _ in 0..100 {
        let mut params = query.clone();
        if let Some(token) = page { params.push(("page".into(), token)); }
        let query_string = oracle_query(&params);
        let path = if query_string.is_empty() { base_path.to_string() } else { format!("{base_path}?{query_string}") };
        let (data, next) = oracle_request(credentials, host, &path).await?;
        if let Some(array) = data.as_array() { values.extend(array.iter().cloned()); }
        if next.is_none() { return Ok(values); }
        page = next;
    }
    Err("OCI 分页超过 100 页，已停止读取".into())
}

async fn oracle_context(credentials: &OracleCredentials) -> Result<(Vec<Value>, Vec<String>), String> {
    let host = format!("identity.{}.oci.oraclecloud.com", credentials.region);
    let compartments = oracle_pages(credentials, &host, "/20160918/compartments", vec![
        ("compartmentId".into(), credentials.tenancy_ocid.clone()), ("compartmentIdInSubtree".into(), "true".into()),
        ("accessLevel".into(), "ACCESSIBLE".into()), ("lifecycleState".into(), "ACTIVE".into()),
    ]).await?;
    // OCI can separately deny region subscription discovery even when the caller
    // can inspect resources. Keep using the configured region instead of failing
    // every resource type.
    let subscriptions = oracle_pages(credentials, &host, &format!("/20160918/tenancy/{}/regionSubscriptions", rpc_encode(&credentials.tenancy_ocid)), vec![]).await.unwrap_or_default();
    let mut all_compartments = vec![json!({"id": credentials.tenancy_ocid, "name": "Root Compartment"})];
    for item in compartments { if item.get("id").is_some_and(|id| !all_compartments.iter().any(|current| current.get("id") == Some(id))) { all_compartments.push(item); } }
    let mut regions = subscriptions.iter().filter(|item| item.get("status").and_then(Value::as_str).is_some_and(|status| status.eq_ignore_ascii_case("READY"))).filter_map(|item| item.get("regionName").and_then(Value::as_str)).map(str::to_string).collect::<Vec<_>>();
    regions.sort(); regions.dedup();
    if regions.is_empty() { regions.push(credentials.region.clone()); }
    Ok((all_compartments, regions))
}

fn oracle_address_list(values: Vec<String>) -> String {
    let mut result = Vec::new();
    for value in values.into_iter().filter(|value| !value.is_empty()) { if !result.contains(&value) { result.push(value); } }
    result.join(", ")
}

async fn oracle_image_name(credentials: &OracleCredentials, host: &str, image_id: &str) -> String {
    if image_id.is_empty() { return String::new(); }
    match oracle_request(credentials, host, &format!("/20160918/images/{}", rpc_encode(image_id))).await {
        Ok((image, _)) => image.get("displayName").and_then(Value::as_str).map(str::to_string).or_else(|| {
            let os = image.get("operatingSystem").and_then(Value::as_str).unwrap_or("");
            let version = image.get("operatingSystemVersion").and_then(Value::as_str).unwrap_or("");
            let name = format!("{os} {version}").trim().to_string(); if name.is_empty() { None } else { Some(name) }
        }).unwrap_or_else(|| image_id.to_string()),
        Err(_) => image_id.to_string(),
    }
}

#[tauri::command]
async fn oracle_instance_action(id: i64, region_id: String, instance_id: String, action: String) -> Result<String, String> {
    if region_id.trim().is_empty() || instance_id.trim().is_empty() { return Err("缺少 OCI 地域或实例 ID".into()); }
    let action_name = match action.as_str() {
        "start" => "START",
        "stop" => "STOP",
        "reboot" => "SOFTRESET",
        "forceReboot" => "RESET",
        _ => return Err("不支持的 OCI 实例操作".into()),
    };
    let credentials = oracle_credentials(id)?;
    let host = format!("iaas.{region_id}.oci.oraclecloud.com");
    let path = format!("/20160918/instances/{}?action={action_name}", rpc_encode(&instance_id));
    let private_key = RsaPrivateKey::from_pkcs8_pem(&credentials.private_key)
        .or_else(|_| RsaPrivateKey::from_pkcs1_pem(&credentials.private_key))
        .map_err(|_| "OCI API 私钥无效，需使用未加密的 RSA PEM 私钥".to_string())?;
    let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    let body = "";
    let content_sha256 = B64.encode(Sha256::digest(body.as_bytes()));
    let canonical = format!("(request-target): post {path}\nhost: {host}\ndate: {date}\ncontent-type: application/json\ncontent-length: {}\nx-content-sha256: {content_sha256}", body.len());
    let signature = B64.encode(SigningKey::<Sha256>::new(private_key).sign(canonical.as_bytes()).to_vec());
    let key_id = format!("{}/{}/{}", credentials.tenancy_ocid, credentials.user_ocid, credentials.fingerprint);
    let authorization = format!("Signature version=\"1\",keyId=\"{key_id}\",algorithm=\"rsa-sha256\",headers=\"(request-target) host date content-type content-length x-content-sha256\",signature=\"{signature}\"");
    let response = reqwest::Client::new().post(format!("https://{host}{path}"))
        .header("host", &host).header("date", &date).header("content-type", "application/json")
        .header("content-length", body.len()).header("x-content-sha256", &content_sha256)
        .header("authorization", authorization).body(body).timeout(std::time::Duration::from_secs(30)).send().await
        .map_err(|error| format!("OCI 请求失败: {error}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|error| format!("OCI 返回读取失败: {error}"))?;
    let data = serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text));
    if !status.is_success() {
        let message = data.get("message").or_else(|| data.get("code")).and_then(Value::as_str).unwrap_or("OCI API 返回错误").to_string();
        write_api_log(&credentials.user_ocid, &host, "POST /20160918/instances", &json!({"action": action_name}), Some(&data), "失败", Some(&message));
        return Err(message);
    }
    write_api_log(&credentials.user_ocid, &host, "POST /20160918/instances", &json!({"action": action_name}), Some(&data), "成功", None);
    Ok(String::new())
}

async fn oracle_instance(credentials: &OracleCredentials, host: &str, item: &Value, region: &str, compartment: &Value, shape: Option<&Value>) -> Value {
    let compartment_id = compartment.get("id").and_then(Value::as_str).unwrap_or("");
    let instance_id = item.get("id").and_then(Value::as_str).unwrap_or("");
    let detail = oracle_request(credentials, host, &format!("/20160918/instances/{}", rpc_encode(instance_id))).await.ok().map(|(value, _)| value).unwrap_or_else(|| item.clone());
    let mut network_errors = Vec::new();
    let attachments = match oracle_pages(credentials, host, "/20160918/vnicAttachments", vec![("compartmentId".into(), compartment_id.into()), ("instanceId".into(), instance_id.into())]).await {
        Ok(values) => values,
        Err(error) => { network_errors.push(error); vec![] }
    };
    let mut public_ips = Vec::new(); let mut private_ips = Vec::new();
    for attachment in attachments {
        for key in ["publicIp", "publicIpAddress"] { if let Some(ip) = attachment.get(key).and_then(Value::as_str) { public_ips.push(ip.to_string()); } }
        for key in ["privateIp", "privateIpAddress"] { if let Some(ip) = attachment.get(key).and_then(Value::as_str) { private_ips.push(ip.to_string()); } }
        let Some(vnic_id) = attachment.get("vnicId").and_then(Value::as_str) else { network_errors.push("VNIC attachment 缺少 vnicId".into()); continue };
        match oracle_request(credentials, host, &format!("/20160918/vnics/{}", rpc_encode(vnic_id))).await {
            Ok((vnic, _)) => {
                for key in ["publicIp", "publicIpAddress"] { if let Some(ip) = vnic.get(key).and_then(Value::as_str) { public_ips.push(ip.to_string()); } }
                for key in ["privateIp", "privateIpAddress"] { if let Some(ip) = vnic.get(key).and_then(Value::as_str) { private_ips.push(ip.to_string()); } }
            }
            Err(error) => network_errors.push(error),
        }
    }
    let shape_config = detail.get("shapeConfig").or_else(|| item.get("shapeConfig")).unwrap_or(&Value::Null);
    let ocpus = shape_config.get("ocpus").or_else(|| shape.and_then(|value| value.get("ocpus"))).cloned().unwrap_or(Value::Null);
    let memory = shape_config.get("memoryInGBs").or_else(|| shape.and_then(|value| value.get("memoryInGBs"))).and_then(Value::as_f64).map(|value| json!(value * 1024.0)).unwrap_or(Value::Null);
    let image_id = detail.get("imageId").or_else(|| item.get("imageId")).and_then(Value::as_str).unwrap_or("");
    json!({"InstanceId": detail.get("id").or_else(|| item.get("id")), "InstanceName": detail.get("displayName").or_else(|| item.get("displayName")).or_else(|| item.get("id")), "InstanceStatus": detail.get("lifecycleState").or_else(|| item.get("lifecycleState")), "Status": detail.get("lifecycleState").or_else(|| item.get("lifecycleState")), "InstanceType": detail.get("shape").or_else(|| item.get("shape")).unwrap_or(&json!("")), "Cpu": ocpus, "Memory": memory, "PublicIpAddress": oracle_address_list(public_ips), "PrivateIpAddress": oracle_address_list(private_ips), "OSName": oracle_image_name(credentials, host, image_id).await, "ImageId": image_id, "CreationTime": detail.get("timeCreated").or_else(|| item.get("timeCreated")).unwrap_or(&json!("")), "_network_error": network_errors.join("；"), "_region_id": region, "_compartment_ocid": compartment.get("id"), "_compartment_name": compartment.get("name"), "_raw": detail})
}
fn oracle_db_system(item: &Value, region: &str, compartment: &Value) -> Value {
    json!({"DBInstanceId": item.get("id"), "DBInstanceDescription": item.get("displayName").or_else(|| item.get("id")), "DBInstanceStatus": item.get("lifecycleState"), "Engine": item.get("databaseEdition").unwrap_or(&json!("Oracle Database")), "EngineVersion": item.get("dbVersion"), "ConnectionString": item.get("hostname"), "_region_id": region, "_compartment_ocid": compartment.get("id"), "_compartment_name": compartment.get("name"), "_raw": item})
}
fn oracle_zone(item: &Value, region: &str, compartment: &Value) -> Value {
    let name = item.get("name").and_then(Value::as_str).unwrap_or("").trim_end_matches('.');
    json!({"DomainName": name, "ZoneId": item.get("id").or_else(|| item.get("name")), "DomainStatus": item.get("lifecycleState").unwrap_or(&json!("ACTIVE")), "RecordCount": 0, "_region_id": region, "_compartment_ocid": compartment.get("id"), "_compartment_name": compartment.get("name"), "_raw": item})
}
fn oracle_bucket(item: &Value, region: &str, compartment: &Value) -> Value {
    json!({"Name": item.get("name"), "BucketName": item.get("name"), "Location": region, "StorageClass": item.get("publicAccessType").unwrap_or(&json!("Standard")), "Acl": item.get("publicAccessType").unwrap_or(&json!("NoPublicAccess")), "_region_id": region, "_compartment_ocid": compartment.get("id"), "_compartment_name": compartment.get("name"), "_raw": item})
}

async fn oracle_instance_disks(id: i64, region: &str, instance_id: &str, compartment_id: &str) -> Result<Vec<Value>, String> {
    if region.is_empty() || instance_id.is_empty() || compartment_id.is_empty() { return Ok(vec![]); }
    let credentials = oracle_credentials(id)?;
    let host = format!("iaas.{region}.oci.oraclecloud.com");
    let query = vec![("compartmentId".into(), compartment_id.into()), ("instanceId".into(), instance_id.into())];
    let boot_attachments = oracle_pages(&credentials, &host, "/20160918/bootVolumeAttachments", query.clone()).await.unwrap_or_default();
    let volume_attachments = oracle_pages(&credentials, &host, "/20160918/volumeAttachments", query).await.unwrap_or_default();
    let mut disks = Vec::new();
    for attachment in boot_attachments {
        let Some(volume_id) = attachment.get("bootVolumeId").and_then(Value::as_str) else { continue };
        if let Ok((volume, _)) = oracle_request(&credentials, &host, &format!("/20160918/bootVolumes/{}", rpc_encode(volume_id))).await {
            disks.push(json!({"DiskId": volume_id, "DiskName": volume.get("displayName").or_else(|| attachment.get("displayName")).unwrap_or(&json!(volume_id)), "Category": "启动卷", "Size": volume.get("sizeInGBs").unwrap_or(&json!(0)), "Status": volume.get("lifecycleState").or_else(|| attachment.get("lifecycleState")).unwrap_or(&json!("")), "Device": attachment.get("device").unwrap_or(&json!(""))}));
        }
    }
    for attachment in volume_attachments {
        let Some(volume_id) = attachment.get("volumeId").and_then(Value::as_str) else { continue };
        if let Ok((volume, _)) = oracle_request(&credentials, &host, &format!("/20160918/volumes/{}", rpc_encode(volume_id))).await {
            disks.push(json!({"DiskId": volume_id, "DiskName": volume.get("displayName").or_else(|| attachment.get("displayName")).unwrap_or(&json!(volume_id)), "Category": "数据卷", "Size": volume.get("sizeInGBs").unwrap_or(&json!(0)), "Status": volume.get("lifecycleState").or_else(|| attachment.get("lifecycleState")).unwrap_or(&json!("")), "Device": attachment.get("device").unwrap_or(&json!(""))}));
        }
    }
    Ok(disks)
}

async fn oracle_resource_items(id: i64, resource_type: &str) -> ResourceResponse {
    let now = Utc::now().timestamp_millis();
    let credentials = match oracle_credentials(id) { Ok(value) => value, Err(error) => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![error], fetched_at: now } };
    let (compartments, regions) = match oracle_context(&credentials).await { Ok(value) => value, Err(error) => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![error], fetched_at: now } };
    let mut items = Vec::new(); let mut errors = Vec::new();
    for region in regions {
        let host = match resource_type { "ecs" => format!("iaas.{region}.oci.oraclecloud.com"), "rds" => format!("database.{region}.oci.oraclecloud.com"), "domain" => format!("dns.{region}.oci.oraclecloud.com"), "oss" => format!("objectstorage.{region}.oci.oraclecloud.com"), _ => { errors.push(format!("Oracle Cloud 暂未接入 {resource_type} 资源")); break; } };
        let namespace = if resource_type == "oss" { match oracle_request(&credentials, &host, "/n/").await { Ok((Value::String(value), _)) if !value.is_empty() => Some(value), Ok(_) => { errors.push(format!("{region}: 未能读取 Object Storage namespace")); None }, Err(error) => { errors.push(format!("{region}: {error}")); None } } } else { None };
        if resource_type == "oss" && namespace.is_none() { continue; }
        for compartment in &compartments {
            let compartment_id = compartment.get("id").and_then(Value::as_str).unwrap_or("");
            if compartment_id.is_empty() { continue; }
            let result = match resource_type {
                "ecs" => oracle_pages(&credentials, &host, "/20160918/instances", vec![("compartmentId".into(), compartment_id.into())]).await,
                "rds" => oracle_pages(&credentials, &host, "/20160918/dbSystems", vec![("compartmentId".into(), compartment_id.into())]).await,
                "domain" => oracle_pages(&credentials, &host, "/20180115/zones", vec![("compartmentId".into(), compartment_id.into())]).await,
                "oss" => oracle_pages(&credentials, &host, &format!("/n/{}/b/", rpc_encode(namespace.as_deref().unwrap_or(""))), vec![("compartmentId".into(), compartment_id.into())]).await,
                _ => unreachable!(),
            };
            match result {
                Ok(values) if resource_type == "ecs" => {
                    let shapes = oracle_pages(&credentials, &host, "/20160928/shapes", vec![("compartmentId".into(), compartment_id.into())]).await.unwrap_or_default();
                    for item in values {
                        let shape = item.get("shape").and_then(Value::as_str).and_then(|name| shapes.iter().find(|candidate| candidate.get("shape").and_then(Value::as_str) == Some(name)));
                        items.push(oracle_instance(&credentials, &host, &item, &region, compartment, shape).await);
                    }
                }
                Ok(values) => for item in values { items.push(match resource_type { "rds" => oracle_db_system(&item, &region, compartment), "domain" => oracle_zone(&item, &region, compartment), "oss" => oracle_bucket(&item, &region, compartment), _ => item }); },
                Err(error) => errors.push(format!("{region}/{}: {error}", compartment.get("name").and_then(Value::as_str).unwrap_or(compartment_id))),
            }
        }
    }
    ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now }
}

#[tauri::command]
async fn list_cloud_resources(id: i64, resource_type: String) -> Result<ResourceResponse, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    Ok(match account_cloud_type(id)?.as_str() {
        "aliyun" => resource_items(&resource_type, &access_key_id, &access_key_secret).await,
        "tencent" => tencent_resource_items(id, &resource_type, &access_key_id, &access_key_secret).await,
        "volcengine" => volc_resource_items(id, &resource_type, &access_key_id, &access_key_secret).await,
        "ctyun" => ctyun_resource_items(id, &resource_type, &access_key_id, &access_key_secret).await,
        "huawei" => huawei_resource_items(id, &resource_type).await,
        "baidu" => baidu_resource_items(id, &resource_type).await,
        "ucloud" => ucloud_resource_items(id, &resource_type).await,
        "qiniu" => qiniu_resource_items(id, &resource_type).await,
        "aws" => aws_resource_items(id, &resource_type).await,
        "azure" => azure_resource_items(id, &resource_type).await,
        "gcp" => gcp_resource_items(id, &resource_type).await,
        "jdcloud" => jdcloud_resource_items(id, &resource_type).await,
        "qingcloud" => qingcloud_resource_items(id, &resource_type).await,
        "ksyun" => ksyun_resource_items(id, &resource_type).await,
        "oracle" => oracle_resource_items(id, &resource_type).await,
        "vultr" => vultr_resource_items(id, &resource_type).await,
        _ => return Err("当前云类型资源 API 尚未接入".into()),
    })
}

#[tauri::command]
async fn esa_overview(id: i64, range: String, site_id: Option<String>) -> Result<Value, String> {
    if account_cloud_type(id)? == "tencent" || account_cloud_type(id)? == "volcengine" {
        let (access_key_id, access_key_secret) = account_credentials(id)?;
        let zones = if account_cloud_type(id)? == "tencent" {
            tencent_resource_items(id, "esa", &access_key_id, &access_key_secret).await
        } else {
            volc_resource_items(id, "esa", &access_key_id, &access_key_secret).await
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
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    if account_cloud_type(id)? == "oracle" { return oracle_instance_disks(id, &region_id, &instance_id, compartment_ocid.as_deref().unwrap_or("")).await; }
    if account_cloud_type(id)? == "tencent" {
        let result = tencent_request("cbs", "2017-03-12", "DescribeDisks", json!({"InstanceId": instance_id}), Some(&region_id), &access_key_id, &access_key_secret).await?;
        return Ok(array_at(&result, &["DiskSet"]).into_iter().map(|disk| json!({
            "DiskId": disk.get("DiskId").cloned().unwrap_or(json!("")),
            "DiskName": disk.get("DiskName").or_else(|| disk.get("DiskId")).cloned().unwrap_or(json!("")),
            "Category": disk.get("DiskType").cloned().unwrap_or(json!("")),
            "Size": disk.get("DiskSize").cloned().unwrap_or(json!(0)),
            "Status": disk.get("DiskState").cloned().unwrap_or(json!("")),
        })).collect());
    }
    ensure_aliyun_account(id)?;
    let result = aliyun_rpc(&format!("ecs.{region_id}.aliyuncs.com"), "2014-05-26", "DescribeDisks", string_params(&[("RegionId", region_id), ("InstanceId", instance_id)]), &access_key_id, &access_key_secret).await?;
    Ok(array_at(&result, &["Disks", "Disk"]).into_iter().cloned().collect())
}

#[tauri::command]
async fn instance_status(id: i64, region_id: String, instance_id: String) -> Result<String, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let result = aliyun_rpc(&format!("ecs.{region_id}.aliyuncs.com"), "2014-05-26", "DescribeInstanceStatus", string_params(&[("RegionId", region_id), ("InstanceId.1", instance_id)]), &access_key_id, &access_key_secret).await?;
    Ok(array_at(&result, &["InstanceStatuses", "InstanceStatus"]).first().and_then(|item| item.get("Status")).and_then(Value::as_str).unwrap_or("Unknown").to_string())
}

#[tauri::command]
async fn reboot_instance(id: i64, region_id: String, instance_id: String, force_stop: bool) -> Result<String, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let result = aliyun_rpc(&format!("ecs.{region_id}.aliyuncs.com"), "2014-05-26", "RebootInstance", string_params(&[
        ("RegionId", region_id), ("InstanceId", instance_id), ("ForceStop", force_stop.to_string()),
    ]), &access_key_id, &access_key_secret).await?;
    Ok(result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}

#[tauri::command]
async fn start_instance(id: i64, region_id: String, instance_id: String) -> Result<String, String> {
    ensure_aliyun_account(id)?;
    if region_id.is_empty() || instance_id.is_empty() { return Err("缺少服务器地域或实例 ID".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let result = aliyun_rpc(&format!("ecs.{region_id}.aliyuncs.com"), "2014-05-26", "StartInstance", string_params(&[
        ("RegionId", region_id), ("InstanceId", instance_id),
    ]), &access_key_id, &access_key_secret).await?;
    Ok(result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}

#[tauri::command]
async fn stop_instance(id: i64, region_id: String, instance_id: String) -> Result<String, String> {
    ensure_aliyun_account(id)?;
    if region_id.is_empty() || instance_id.is_empty() { return Err("缺少服务器地域或实例 ID".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let result = aliyun_rpc(&format!("ecs.{region_id}.aliyuncs.com"), "2014-05-26", "StopInstance", string_params(&[
        ("RegionId", region_id), ("InstanceId", instance_id),
    ]), &access_key_id, &access_key_secret).await?;
    Ok(result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}

#[tauri::command]
async fn cvm_instance_reboot(id: i64, region_id: String, instance_id: String, force_stop: bool) -> Result<String, String> {
    ensure_tencent_account(id)?;
    if region_id.is_empty() || instance_id.is_empty() { return Err("缺少服务器地域或实例 ID".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let mut payload = json!({"InstanceIds": [instance_id]});
    if force_stop { payload["ForceStop"] = json!(true); }
    let result = tencent_request("cvm", "2017-03-12", "RebootInstances", payload, Some(&region_id), &access_key_id, &access_key_secret).await?;
    Ok(result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}

#[tauri::command]
async fn cvm_instance_action(id: i64, region_id: String, instance_id: String, action: String, force_stop: bool) -> Result<String, String> {
    ensure_tencent_account(id)?;
    if region_id.is_empty() || instance_id.is_empty() { return Err("缺少服务器地域或实例 ID".into()); }
    let action_name = match action.as_str() {
        "start" => "StartInstances",
        "stop" => "StopInstances",
        "reboot" => "RebootInstances",
        _ => return Err("不支持的腾讯云服务器操作".into()),
    };
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let mut payload = json!({"InstanceIds": [instance_id]});
    if force_stop && (action == "stop" || action == "reboot") { payload["ForceStop"] = json!(true); }
    let result = tencent_request("cvm", "2017-03-12", action_name, payload, Some(&region_id), &access_key_id, &access_key_secret).await?;
    Ok(result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}

fn update_cached_server_name(account_id: i64, instance_id: &str, instance_name: &str) -> Result<(), String> {
    let conn = open_db()?;
    let cached: Option<String> = conn.query_row(
        "SELECT payload_json FROM cloud_assets WHERE account_id=?1 AND resource_type='ecs' AND asset_key=?2",
        params![account_id, instance_id],
        |row| row.get(0),
    ).optional().map_err(|e| format!("读取本地服务器缓存失败: {e}"))?;
    if let Some(payload_json) = cached {
        let mut payload: Value = serde_json::from_str(&payload_json).map_err(|e| format!("解析本地服务器缓存失败: {e}"))?;
        let object = payload.as_object_mut().ok_or("本地服务器缓存格式无效")?;
        object.insert("InstanceName".into(), json!(instance_name));
        conn.execute(
            "UPDATE cloud_assets SET payload_json=?1 WHERE account_id=?2 AND resource_type='ecs' AND asset_key=?3",
            params![serde_json::to_string(&payload).map_err(|e| e.to_string())?, account_id, instance_id],
        ).map_err(|e| format!("更新本地服务器缓存失败: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn rename_server(id: i64, region_id: String, instance_id: String, instance_name: String) -> Result<String, String> {
    let instance_name = instance_name.trim().to_string();
    if region_id.trim().is_empty() || instance_id.trim().is_empty() { return Err("缺少服务器地域或实例 ID".into()); }
    if instance_name.is_empty() { return Err("服务器名称不能为空".into()); }
    if instance_name.as_bytes().len() > 128 { return Err("服务器名称不能超过 128 个字节".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let request_id = if account_cloud_type(id)? == "tencent" {
        let result = tencent_request(
            "cvm", "2017-03-12", "ModifyInstancesAttribute",
            json!({"InstanceIds": [instance_id.clone()], "InstanceName": instance_name.clone()}),
            Some(&region_id), &access_key_id, &access_key_secret,
        ).await?;
        result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string()
    } else {
        ensure_aliyun_account(id)?;
        let result = aliyun_rpc(&format!("ecs.{region_id}.aliyuncs.com"), "2014-05-26", "ModifyInstanceAttribute", string_params(&[
            ("RegionId", region_id), ("InstanceId", instance_id.clone()), ("InstanceName", instance_name.clone()),
        ]), &access_key_id, &access_key_secret).await?;
        result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string()
    };
    update_cached_server_name(id, &instance_id, &instance_name)?;
    Ok(request_id)
}

#[tauri::command]
async fn swas_instance_action(id: i64, region_id: String, instance_id: String, action: String, force_stop: bool) -> Result<String, String> {
    if region_id.is_empty() || instance_id.is_empty() { return Err("缺少轻量服务器地域或实例 ID".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let cloud_type = account_cloud_type(id)?;
    let result = if cloud_type == "aliyun" {
        let action_name = match action.as_str() { "start" => "StartInstance", "reboot" => "RebootInstance", "stop" => "StopInstance", _ => return Err("不支持的轻量服务器操作".into()) };
        let force_reboot = action == "reboot" && force_stop;
        let params = if force_reboot {
            string_params(&[("RegionId", region_id.clone()), ("InstanceIds", json!([instance_id]).to_string()), ("ForceReboot", "true".into())])
        } else {
            string_params(&[("RegionId", region_id.clone()), ("InstanceId", instance_id)])
        };
        aliyun_rpc(&format!("swas.{region_id}.aliyuncs.com"), "2020-06-01", if force_reboot { "RebootInstances" } else { action_name }, params, &access_key_id, &access_key_secret).await?
    } else if cloud_type == "tencent" {
        let action_name = match action.as_str() { "start" => "StartInstances", "reboot" => "RebootInstances", "stop" => "StopInstances", _ => return Err("不支持的轻量服务器操作".into()) };
        let mut payload = json!({"InstanceIds": [instance_id]});
        if action == "reboot" && force_stop { payload["ForceStop"] = json!(true); }
        tencent_request("lighthouse", "2020-03-24", action_name, payload, Some(&region_id), &access_key_id, &access_key_secret).await?
    } else { return Err("当前云类型暂不支持轻量服务器操作".into()); };
    Ok(result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}

#[tauri::command]
async fn list_dns_records(id: i64, domain: String, record_type: Option<String>, keyword: Option<String>) -> Result<Value, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    if account_cloud_type(id)? == "tencent" {
        let mut payload = serde_json::Map::new();
        payload.insert("Domain".into(), json!(domain));
        if let Some(value) = record_type.filter(|value| !value.is_empty()) { payload.insert("RecordType".into(), json!(value)); }
        if let Some(value) = keyword.filter(|value| !value.is_empty()) { payload.insert("Value".into(), json!(value)); }
        let result = tencent_request("dnspod", "2021-03-23", "DescribeRecordList", Value::Object(payload), None, &access_key_id, &access_key_secret).await?;
        let items = array_at(&result, &["RecordList"]).into_iter().map(|item| json!({
            "RecordId": item.get("RecordId").cloned().unwrap_or(json!("")),
            "Type": item.get("Type").cloned().unwrap_or(json!("")),
            "RR": item.get("Name").or_else(|| item.get("RR")).cloned().unwrap_or(json!("")),
            "Value": item.get("Value").cloned().unwrap_or(json!("")),
            "TTL": item.get("TTL").cloned().unwrap_or(json!("")),
            "MX": item.get("MX").cloned().unwrap_or(json!("")),
            "Line": item.get("Line").cloned().unwrap_or(json!("")),
            "Status": item.get("Status").cloned().unwrap_or(json!("")),
        })).collect::<Vec<_>>();
        return Ok(json!({"items": items, "total": result.pointer("/RecordCountInfo/TotalCount").cloned().or_else(|| result.get("TotalCount").cloned()).unwrap_or(json!(0))}));
    }
    if account_cloud_type(id)? == "ctyun" {
        let zones = ctyun_resource_items(id, "domain", &access_key_id, &access_key_secret).await;
        let zone = zones.items.iter().find(|item| item.get("DomainName").and_then(Value::as_str).is_some_and(|name| name.eq_ignore_ascii_case(&domain)));
        let Some(zone_id) = zone.and_then(|item| item.get("ZoneId")).and_then(Value::as_str).filter(|value| !value.is_empty()) else { return Ok(json!({"items": [], "total": 0})); };
        let region = zone.and_then(|item| item.get("_region_id")).and_then(Value::as_str).unwrap_or("cn-huabei-9");
        let mut query = string_params(&[("regionID", region.to_string()), ("zoneID", zone_id.to_string()), ("pageNo", "1".into()), ("pageSize", "100".into())]);
        if let Some(value) = keyword.filter(|value| !value.is_empty()) { query.insert("zoneRecordName".into(), value); }
        let result = ctyun_request("ctvpc-global.ctapi.ctyun.cn", reqwest::Method::GET, "/v4/private-zone-record/list", None, query, &access_key_id, &access_key_secret).await?;
        let expected_type = record_type.unwrap_or_default();
        let items = array_at(&result, &["zoneRecords"]).into_iter().filter(|item| expected_type.is_empty() || item.get("type").and_then(Value::as_str).is_some_and(|value| value.eq_ignore_ascii_case(&expected_type))).map(|item| json!({
            "RecordId": item.get("zoneRecordID").cloned().unwrap_or(json!("")), "Type": item.get("type").cloned().unwrap_or(json!("")), "RR": item.get("name").cloned().unwrap_or(json!("@")),
            "Value": item.get("value").map(|value| if let Value::Array(values) = value { values.iter().map(display_json).collect::<Vec<_>>().join(", ") } else { display_json(value) }).unwrap_or_default(),
            "TTL": item.get("TTL").cloned().unwrap_or(json!(0)), "Priority": "", "Line": "默认", "Status": "ENABLE",
        })).collect::<Vec<_>>();
        let total = result.get("totalCount").cloned().unwrap_or(json!(items.len()));
        return Ok(json!({"items": items, "total": total}));
    }
    ensure_aliyun_account(id)?;
    let mut entries = vec![("DomainName", domain), ("PageNumber", "1".into()), ("PageSize", "500".into())];
    if let Some(value) = record_type.filter(|v| !v.is_empty()) { entries.push(("TypeKeyWord", value)); }
    if let Some(value) = keyword.filter(|v| !v.is_empty()) { entries.push(("RRKeyWord", value)); }
    let result = aliyun_rpc("alidns.aliyuncs.com", "2015-01-09", "DescribeDomainRecords", string_params(&entries), &access_key_id, &access_key_secret).await?;
    Ok(json!({"items": array_at(&result, &["DomainRecords", "Record"]).into_iter().cloned().collect::<Vec<_>>(), "total": result.get("TotalCount").cloned().unwrap_or(json!(0))}))
}

#[tauri::command]
async fn add_dns_record(id: i64, domain: String, record_type: String, rr: String, value: String, ttl: Option<i64>, priority: Option<i64>, line: Option<String>) -> Result<Value, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let mut entries = vec![("DomainName", domain), ("RR", rr), ("Type", record_type.clone()), ("Value", value), ("TTL", ttl.unwrap_or(600).to_string()), ("Line", line.unwrap_or_else(|| "default".into()))];
    if record_type == "MX" { entries.push(("Priority", priority.unwrap_or(10).to_string())); }
    aliyun_rpc("alidns.aliyuncs.com", "2015-01-09", "AddDomainRecord", string_params(&entries), &access_key_id, &access_key_secret).await
}

#[tauri::command]
async fn update_dns_record(id: i64, record_id: String, record_type: String, rr: String, value: String, ttl: Option<i64>, priority: Option<i64>, line: Option<String>) -> Result<Value, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let mut entries = vec![("RecordId", record_id), ("RR", rr), ("Type", record_type.clone()), ("Value", value), ("TTL", ttl.unwrap_or(600).to_string()), ("Line", line.unwrap_or_else(|| "default".into()))];
    if record_type == "MX" { entries.push(("Priority", priority.unwrap_or(10).to_string())); }
    aliyun_rpc("alidns.aliyuncs.com", "2015-01-09", "UpdateDomainRecord", string_params(&entries), &access_key_id, &access_key_secret).await
}

#[tauri::command]
async fn delete_dns_record(id: i64, record_id: String) -> Result<Value, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    aliyun_rpc("alidns.aliyuncs.com", "2015-01-09", "DeleteDomainRecord", string_params(&[("RecordId", record_id)]), &access_key_id, &access_key_secret).await
}

#[tauri::command]
async fn toggle_dns_record(id: i64, record_id: String, status: String) -> Result<Value, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    aliyun_rpc("alidns.aliyuncs.com", "2015-01-09", "SetDomainRecordStatus", string_params(&[("RecordId", record_id), ("Status", status)]), &access_key_id, &access_key_secret).await
}

#[tauri::command]
async fn list_domain_logs(id: i64, domain: String, start_date: Option<String>, end_date: Option<String>, keyword: Option<String>) -> Result<Value, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let mut entries = vec![("DomainName", domain), ("PageNumber", "1".into()), ("PageSize", "100".into())];
    if let Some(value) = start_date.filter(|v| !v.is_empty()) { entries.push(("StartDate", value)); }
    if let Some(value) = end_date.filter(|v| !v.is_empty()) { entries.push(("EndDate", value)); }
    if let Some(value) = keyword.filter(|v| !v.is_empty()) { entries.push(("KeyWord", value)); }
    let result = aliyun_rpc("alidns.aliyuncs.com", "2015-01-09", "DescribeRecordLogs", string_params(&entries), &access_key_id, &access_key_secret).await?;
    Ok(json!({"items": array_at(&result, &["RecordLogs", "RecordLog"]).into_iter().cloned().collect::<Vec<_>>(), "total": result.get("TotalCount").cloned().unwrap_or(json!(0))}))
}

#[tauri::command]
async fn query_whois(id: i64, domain: String) -> Result<String, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let result = aliyun_rpc("domain.aliyuncs.com", "2018-01-29", "QueryDomainByDomainName", string_params(&[("DomainName", domain)]), &access_key_id, &access_key_secret).await?;
    let get = |key: &str| result.get(key).map(display_json).unwrap_or_else(|| "-".into());
    Ok(format!("域名信息查询结果\n=====================================\n\n域名: {}\n域名持有者: {}\n持有者类型: {}\n联系人: {}\n联系邮箱: {}\n\n注册时间: {}\n到期时间: {}\n注册商: 阿里云\n\n实名认证: {}\n域名状态: {}\nDNS服务器: {}", get("DomainName"), result.get("ZhRegistrantOrganization").or_else(|| result.get("RegistrantOrganization")).map(display_json).unwrap_or_else(|| "-".into()), get("RegistrantType"), result.get("ZhRegistrantName").or_else(|| result.get("RegistrantName")).map(display_json).unwrap_or_else(|| "-".into()), get("Email"), get("RegistrationDate"), get("ExpirationDate"), get("RealNameStatus"), get("DomainStatus"), result.get("DnsList").map(display_json).unwrap_or_else(|| "-".into())))
}

#[tauri::command]
async fn list_rds_databases(id: i64, region_id: String, instance_id: String) -> Result<Vec<Value>, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    if account_cloud_type(id)? == "tencent" {
        let data = tencent_request("cdb", "2017-03-20", "DescribeDatabases", json!({"InstanceId": instance_id}), Some(&region_id), &access_key_id, &access_key_secret).await?;
        return Ok(array_at(&data, &["Items"]).into_iter().map(|item| { let mut value = (*item).clone(); if let Value::Object(ref mut target) = value { target.insert("DBName".into(), item.get("DatabaseName").or_else(|| item.get("DBName")).cloned().unwrap_or(json!(""))); } value }).collect());
    }
    let result = aliyun_rpc("rds.aliyuncs.com", "2014-08-15", "DescribeDatabases", string_params(&[("RegionId", region_id), ("DBInstanceId", instance_id)]), &access_key_id, &access_key_secret).await?;
    Ok(array_at(&result, &["Databases", "Database"]).into_iter().cloned().collect())
}

#[tauri::command]
async fn list_rds_accounts(id: i64, region_id: String, instance_id: String) -> Result<Vec<Value>, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    if account_cloud_type(id)? == "tencent" {
        let data = tencent_request("cdb", "2017-03-20", "DescribeAccounts", json!({"InstanceId": instance_id}), Some(&region_id), &access_key_id, &access_key_secret).await?;
        return Ok(array_at(&data, &["Items"]).into_iter().map(|item| json!({"AccountName": item.get("AccountName").or_else(|| item.get("UserName")).cloned().unwrap_or(json!("")), "AccountType": item.get("AccountType").cloned().unwrap_or(json!("Normal")), "AccountStatus": item.get("Status").cloned().unwrap_or(json!("Available")), "AccountDescription": item.get("Description").cloned().unwrap_or(json!(""))})).collect());
    }
    let result = aliyun_rpc("rds.aliyuncs.com", "2014-08-15", "DescribeAccounts", string_params(&[("RegionId", region_id), ("DBInstanceId", instance_id)]), &access_key_id, &access_key_secret).await?;
    Ok(array_at(&result, &["Accounts", "DBInstanceAccount"]).into_iter().cloned().collect())
}

#[tauri::command]
async fn list_redis_accounts(id: i64, instance_id: String, region_id: String) -> Result<Vec<Value>, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    if account_cloud_type(id)? == "tencent" {
        let data = tencent_request("redis", "2018-04-12", "DescribeInstanceAccount", json!({"InstanceId": instance_id}), Some(&region_id), &access_key_id, &access_key_secret).await?;
        return Ok(array_at(&data, &["Accounts"]).into_iter().map(|item| json!({"AccountName": item.get("AccountName").or_else(|| item.get("UserName")).cloned().unwrap_or(json!("")), "AccountType": item.get("AccountType").cloned().unwrap_or(json!("Normal")), "AccountStatus": item.get("Status").cloned().unwrap_or(json!("Available")), "AccountDescription": item.get("Description").cloned().unwrap_or(json!(""))})).collect());
    }
    let result = aliyun_rpc("r-kvstore.aliyuncs.com", "2015-01-01", "DescribeAccounts", string_params(&[("InstanceId", instance_id), ("RegionId", region_id)]), &access_key_id, &access_key_secret).await?;
    Ok(array_at(&result, &["Accounts", "Account"]).into_iter().cloned().collect())
}

#[tauri::command]
async fn list_oss_objects(id: i64, bucket: String, location: String, prefix: String, marker: String) -> Result<Value, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    if account_cloud_type(id)? == "tencent" { return cos_list_objects(&bucket, &location, &access_key_id, &access_key_secret, &prefix, &marker).await; }
    oss_list_objects(&bucket, &location, &access_key_id, &access_key_secret, &prefix, &marker).await
}

#[tauri::command]
async fn get_oss_acl(id: i64, bucket: String, location: String) -> Result<String, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    if account_cloud_type(id)? == "tencent" {
        let body = cos_request(&bucket, &location, "acl", &access_key_id, &access_key_secret).await?;
        return Ok(xml_text(&body, "Permission"));
    }
    oss_get_acl(&bucket, &location, &access_key_id, &access_key_secret).await
}

#[tauri::command]
async fn set_oss_cors(id: i64, bucket: String, location: String, origins: String) -> Result<(), String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    oss_set_cors(&bucket, &location, &origins, &access_key_id, &access_key_secret).await
}

#[derive(Debug, Serialize)]
struct LocalAsset { account_id: i64, resource_type: String, asset_key: String, region_id: Option<String>, payload: Value, fetched_at: i64 }

#[derive(Debug, Serialize)]
struct AssetSyncResult { fetched: usize, counts: BTreeMap<String, usize>, errors: Vec<String>, fetched_at: i64 }

#[derive(Debug, Serialize)]
struct ApiLog { id: i64, account_id: Option<i64>, account_name: Option<String>, endpoint: String, action: String, request_params: String, response_params: Option<String>, status: String, message: Option<String>, created_at: i64 }

#[tauri::command]
fn list_api_logs() -> Result<Vec<ApiLog>, String> {
    let conn = open_db()?;
    let mut stmt = conn.prepare("SELECT l.id,l.account_id,a.account_name,l.endpoint,l.action,l.request_params,l.response_params,l.status,l.message,l.created_at FROM api_logs l LEFT JOIN cloud_accounts a ON a.id=l.account_id ORDER BY l.created_at DESC LIMIT 500").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| Ok(ApiLog {
        id: row.get(0)?, account_id: row.get(1)?, account_name: row.get(2)?, endpoint: row.get(3)?, action: row.get(4)?, request_params: row.get(5)?, response_params: row.get(6)?, status: row.get(7)?, message: row.get(8)?, created_at: row.get(9)?,
    })).map_err(|e| e.to_string())?;
    rows.map(|row| row.map_err(|e| e.to_string())).collect()
}

#[tauri::command]
fn clear_api_logs() -> Result<usize, String> {
    Ok(open_db()?.execute("DELETE FROM api_logs", []).map_err(|e| e.to_string())?)
}

#[tauri::command]
fn clear_operation_logs() -> Result<usize, String> {
    Ok(open_db()?.execute("DELETE FROM operation_logs", []).map_err(|e| e.to_string())?)
}

fn row_managed_host(row: &rusqlite::Row<'_>) -> rusqlite::Result<ManagedHost> {
    let metrics: String = row.get(13)?;
    Ok(ManagedHost {
        id: row.get(0)?, name: row.get(1)?, host: row.get(2)?, port: row.get(3)?, username: row.get(4)?,
        group_name: row.get(5)?, tags: row.get(6)?, source_account_id: row.get(7)?, source_asset_key: row.get(8)?,
        password_saved: row.get::<_, Option<String>>(9)?.is_some(), host_key_fingerprint: row.get(10)?, status: row.get(11)?,
        last_latency_ms: row.get(12)?, metrics: serde_json::from_str(&metrics).unwrap_or_else(|_| json!({})), last_checked_at: row.get(14)?,
        last_error: row.get(15)?, remark: row.get(16)?, created_at: row.get(17)?, updated_at: row.get(18)?,
    })
}

#[tauri::command]
fn list_managed_hosts() -> Result<Vec<ManagedHost>, String> {
    let conn = open_db()?;
    let mut stmt = conn.prepare("SELECT id,name,host,port,username,group_name,tags,source_account_id,source_asset_key,password_ciphertext,host_key_fingerprint,status,last_latency_ms,metrics_json,last_checked_at,last_error,remark,created_at,updated_at FROM managed_hosts ORDER BY COALESCE(group_name,''), name COLLATE NOCASE")
        .map_err(|e| e.to_string())?;
    let hosts = stmt.query_map([], row_managed_host).map_err(|e| e.to_string())?.map(|row| row.map_err(|e| e.to_string())).collect();
    hosts
}

#[tauri::command]
fn save_managed_host(input: ManagedHostInput) -> Result<ManagedHost, String> {
    let name = input.name.trim(); let host = input.host.trim(); let username = input.username.trim();
    if name.is_empty() || host.is_empty() || username.is_empty() { return Err("请填写服务器名称、主机地址和 SSH 用户名".into()); }
    let port = input.port.unwrap_or(22).max(1);
    let conn = open_db()?; let now = Utc::now().timestamp_millis();
    let existing_secret = input.id.and_then(|id| conn.query_row("SELECT password_ciphertext FROM managed_hosts WHERE id=?1", [id], |row| row.get::<_, String>(0)).optional().ok().flatten());
    let secret = match input.password.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(password) => encrypt_secret(password)?,
        None => existing_secret.ok_or_else(|| "首次添加服务器需要填写 SSH 密码".to_string())?,
    };
    let id = match input.id {
        Some(id) => { conn.execute("UPDATE managed_hosts SET name=?1,host=?2,port=?3,username=?4,password_ciphertext=?5,group_name=?6,tags=?7,source_account_id=?8,source_asset_key=?9,remark=?10,updated_at=?11 WHERE id=?12", params![name,host,port,username,secret,input.group_name,input.tags,input.source_account_id,input.source_asset_key,input.remark,now,id]).map_err(|e| e.to_string())?; id }
        None => { conn.execute("INSERT INTO managed_hosts(name,host,port,username,password_ciphertext,group_name,tags,source_account_id,source_asset_key,remark,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)", params![name,host,port,username,secret,input.group_name,input.tags,input.source_account_id,input.source_asset_key,input.remark,now]).map_err(|e| e.to_string())?; conn.last_insert_rowid() }
    };
    conn.query_row("SELECT id,name,host,port,username,group_name,tags,source_account_id,source_asset_key,password_ciphertext,host_key_fingerprint,status,last_latency_ms,metrics_json,last_checked_at,last_error,remark,created_at,updated_at FROM managed_hosts WHERE id=?1", [id], row_managed_host).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_managed_host(id: i64) -> Result<(), String> {
    open_db()?.execute("DELETE FROM managed_hosts WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

fn managed_host_saved_connection(id: i64) -> Result<Option<(String, u16, String, Option<String>, Option<String>)>, String> {
    open_db()?.query_row("SELECT host,port,username,password_ciphertext,host_key_fingerprint FROM managed_hosts WHERE id=?1", [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))
        .optional().map_err(|e| format!("读取受管服务器失败: {e}"))
}

#[tauri::command]
async fn probe_managed_host(id: i64) -> Result<ManagedHost, String> {
    let saved = managed_host_saved_connection(id)?.ok_or("服务器不存在")?;
    let (host, port, username, password_ciphertext, known_fingerprint) = saved;
    let password = decrypt_secret(&password_ciphertext.ok_or("服务器未保存 SSH 密码")?)?;
    let started = Instant::now(); let observed_fingerprint = Arc::new(Mutex::new(None));
    let handler = SshHostKeyHandler { expected_fingerprint: known_fingerprint, observed_fingerprint: observed_fingerprint.clone() };
    let attempt = async {
        let config = Arc::new(client::Config::default());
        let mut session = client::connect(config, (host.as_str(), port), handler).await.map_err(|error| format!("连接 SSH 主机失败: {error}"))?;
        let fingerprint = observed_fingerprint.lock().map_err(|_| "SSH 主机密钥状态不可用".to_string())?.clone().ok_or("无法读取 SSH 主机密钥")?;
        if !session.authenticate_password(username.clone(), password).await.map_err(|error| format!("SSH 身份验证失败: {error}"))?.success() { return Err("SSH 身份验证失败，请检查用户名和密码".into()); }
        let mut channel = session.channel_open_session().await.map_err(|error| format!("打开 SSH 会话失败: {error}"))?;
        let command = r#"printf 'hostname='; hostname; printf 'os='; uname -sr; printf 'uptime='; uptime; printf 'memory='; free -b 2>/dev/null | awk '/^Mem:/ {print $2 \",\" $3}'; printf 'disk='; df -B1 / 2>/dev/null | awk 'NR==2 {print $2 \",\" $3}'"#;
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
            let metric_pair = |key: &str| values.get(key).and_then(|value| value.split_once(',')).map(|(total, used)| json!({"total": total.trim().parse::<u64>().unwrap_or(0), "used": used.trim().parse::<u64>().unwrap_or(0)})).unwrap_or_else(|| json!(null));
            let metrics = json!({"hostname": values.get("hostname").copied().unwrap_or(""), "os": values.get("os").copied().unwrap_or(""), "uptime": values.get("uptime").copied().unwrap_or(""), "memory": metric_pair("memory"), "disk": metric_pair("disk")});
            conn.execute("UPDATE managed_hosts SET host_key_fingerprint=?1,status='online',last_latency_ms=?2,metrics_json=?3,last_checked_at=?4,last_error=NULL,updated_at=?4 WHERE id=?5", params![fingerprint, started.elapsed().as_millis() as i64, serde_json::to_string(&metrics).map_err(|e| e.to_string())?, now, id]).map_err(|e| e.to_string())?;
        }
        Err(error) => {
            conn.execute("UPDATE managed_hosts SET status='offline',last_checked_at=?1,last_error=?2,updated_at=?1 WHERE id=?3", params![now, error, id]).map_err(|e| e.to_string())?;
        }
    }
    conn.query_row("SELECT id,name,host,port,username,group_name,tags,source_account_id,source_asset_key,password_ciphertext,host_key_fingerprint,status,last_latency_ms,metrics_json,last_checked_at,last_error,remark,created_at,updated_at FROM managed_hosts WHERE id=?1", [id], row_managed_host).map_err(|e| e.to_string())
}

fn row_panel_connection(row: &rusqlite::Row<'_>) -> rusqlite::Result<PanelConnection> {
    let summary: String = row.get(10)?;
    Ok(PanelConnection {
        id: row.get(0)?, name: row.get(1)?, panel_url: row.get(2)?, sort_order: row.get(3)?, allow_insecure_tls: row.get::<_, i64>(4)? == 1, group_name: row.get(5)?, source_account_id: row.get(6)?, source_asset_key: row.get(7)?,
        api_key_saved: row.get::<_, Option<String>>(8)?.is_some(), status: row.get(9)?, summary: serde_json::from_str(&summary).unwrap_or_else(|_| json!({})),
        last_checked_at: row.get(11)?, last_error: row.get(12)?, remark: row.get(13)?, created_at: row.get(14)?, updated_at: row.get(15)?,
    })
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
    let conn = open_db()?;
    let row: (PanelConnection, String) = conn.query_row("SELECT id,name,panel_url,sort_order,allow_insecure_tls,group_name,source_account_id,source_asset_key,api_key_ciphertext,status,summary_json,last_checked_at,last_error,remark,created_at,updated_at,api_key_ciphertext FROM panel_connections WHERE id=?1", [id], |row| Ok((row_panel_connection(row)?, row.get(16)?))).map_err(|_| "面板不存在".to_string())?;
    Ok((row.0, decrypt_secret(&row.1)?))
}

#[tauri::command]
fn list_panel_connections() -> Result<Vec<PanelConnection>, String> {
    let conn = open_db()?; let mut stmt = conn.prepare("SELECT id,name,panel_url,sort_order,allow_insecure_tls,group_name,source_account_id,source_asset_key,api_key_ciphertext,status,summary_json,last_checked_at,last_error,remark,created_at,updated_at FROM panel_connections ORDER BY sort_order ASC, name COLLATE NOCASE").map_err(|e| e.to_string())?;
    let panels = stmt.query_map([], row_panel_connection).map_err(|e| e.to_string())?.map(|row| row.map_err(|e| e.to_string())).collect(); panels
}

#[tauri::command]
async fn save_panel_connection(input: PanelConnectionInput) -> Result<PanelConnection, String> {
    let name = input.name.trim(); let panel_url = normalize_panel_url(&input.panel_url)?;
    if name.is_empty() { return Err("请填写面板名称".into()); }
    let existing = input.id.and_then(|id| open_db().ok()?.query_row("SELECT api_key_ciphertext FROM panel_connections WHERE id=?1", [id], |row| row.get::<_, String>(0)).optional().ok().flatten());
    let api_key_ciphertext = match input.api_key.as_deref().map(str::trim).filter(|value| !value.is_empty()) { Some(key) => encrypt_secret(key)?, None => existing.ok_or_else(|| "首次绑定需要填写面板 API 密钥".to_string())? };
    let api_key = decrypt_secret(&api_key_ciphertext)?;
    let data = panel_api_request(&panel_url, &api_key, "/system?action=GetNetWork", input.allow_insecure_tls).await?;
    let summary = panel_summary(&data); let now = Utc::now().timestamp_millis(); let conn = open_db()?;
    let id = match input.id {
        Some(id) => { conn.execute("UPDATE panel_connections SET name=?1,panel_url=?2,api_key_ciphertext=?3,sort_order=?4,allow_insecure_tls=?5,group_name=?6,source_account_id=?7,source_asset_key=?8,status='online',summary_json=?9,last_checked_at=?10,last_error=NULL,remark=?11,updated_at=?10 WHERE id=?12", params![name,panel_url,api_key_ciphertext,input.sort_order.max(0),input.allow_insecure_tls as i64,input.group_name,input.source_account_id,input.source_asset_key,serde_json::to_string(&summary).map_err(|e| e.to_string())?,now,input.remark,id]).map_err(|e| e.to_string())?; id }
        None => { conn.execute("INSERT INTO panel_connections(name,panel_url,api_key_ciphertext,sort_order,allow_insecure_tls,group_name,source_account_id,source_asset_key,status,summary_json,last_checked_at,remark,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'online',?9,?10,?11,?10,?10)", params![name,panel_url,api_key_ciphertext,input.sort_order.max(0),input.allow_insecure_tls as i64,input.group_name,input.source_account_id,input.source_asset_key,serde_json::to_string(&summary).map_err(|e| e.to_string())?,now,input.remark]).map_err(|e| e.to_string())?; conn.last_insert_rowid() }
    };
    conn.query_row("SELECT id,name,panel_url,sort_order,allow_insecure_tls,group_name,source_account_id,source_asset_key,api_key_ciphertext,status,summary_json,last_checked_at,last_error,remark,created_at,updated_at FROM panel_connections WHERE id=?1", [id], row_panel_connection).map_err(|e| e.to_string())
}

#[tauri::command]
async fn refresh_panel_connection(id: i64) -> Result<PanelConnection, String> {
    let (panel, api_key) = load_panel_connection(id)?; let now = Utc::now().timestamp_millis(); let result = panel_api_request(&panel.panel_url, &api_key, "/system?action=GetNetWork", panel.allow_insecure_tls).await;
    let conn = open_db()?;
    match result { Ok(data) => { conn.execute("UPDATE panel_connections SET status='online',summary_json=?1,last_checked_at=?2,last_error=NULL,updated_at=?2 WHERE id=?3", params![serde_json::to_string(&panel_summary(&data)).map_err(|e| e.to_string())?,now,id]).map_err(|e| e.to_string())?; }
        Err(error) => { conn.execute("UPDATE panel_connections SET status='offline',last_checked_at=?1,last_error=?2,updated_at=?1 WHERE id=?3", params![now,error,id]).map_err(|e| e.to_string())?; }
    }
    conn.query_row("SELECT id,name,panel_url,sort_order,allow_insecure_tls,group_name,source_account_id,source_asset_key,api_key_ciphertext,status,summary_json,last_checked_at,last_error,remark,created_at,updated_at FROM panel_connections WHERE id=?1", [id], row_panel_connection).map_err(|e| e.to_string())
}

#[tauri::command]
async fn panel_temporary_login(id: i64) -> Result<String, String> {
    let (panel, api_key) = load_panel_connection(id)?; let data = panel_api_request(&panel.panel_url, &api_key, "/config?action=get_tmp_token", panel.allow_insecure_tls).await?;
    let token = data.get("msg").or_else(|| data.get("token")).and_then(Value::as_str).filter(|value| !value.is_empty()).ok_or("面板未返回临时登录令牌")?;
    Ok(format!("{}/login?tmp_token={}", panel.panel_url, token))
}

#[tauri::command]
fn delete_panel_connection(id: i64) -> Result<(), String> { open_db()?.execute("DELETE FROM panel_connections WHERE id=?1", [id]).map_err(|e| e.to_string())?; Ok(()) }

#[tauri::command]
fn export_panel_connections_file(panel_ids: Vec<i64>) -> Result<String, String> {
    if panel_ids.is_empty() { return Err("请至少选择一个面板".into()); }
    let conn = open_db()?;
    let mut stmt = conn.prepare("SELECT id,name,panel_url,sort_order,api_key_ciphertext,allow_insecure_tls,group_name,source_account_id,source_asset_key,remark FROM panel_connections ORDER BY sort_order ASC, name COLLATE NOCASE").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| Ok((
        row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?, row.get::<_, String>(4)?, row.get::<_, i64>(5)? == 1,
        row.get::<_, Option<String>>(6)?, row.get::<_, Option<i64>>(7)?, row.get::<_, Option<String>>(8)?, row.get::<_, Option<String>>(9)?,
    ))).map_err(|e| e.to_string())?;
    let mut panels = Vec::new();
    for row in rows {
        let (id, name, panel_url, sort_order, ciphertext, allow_insecure_tls, group_name, source_account_id, source_asset_key, remark) = row.map_err(|e| e.to_string())?;
        if !panel_ids.contains(&id) { continue; }
        panels.push(ExportPanelConnection { name, panel_url, sort_order, api_key: decrypt_secret(&ciphertext)?, allow_insecure_tls, group_name, source_account_id, source_asset_key, remark });
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
        let existing_id: Option<i64> = conn.query_row("SELECT id FROM panel_connections WHERE panel_url=?1", [&panel_url], |row| row.get(0)).optional().map_err(|e| e.to_string())?;
        match existing_id {
            Some(id) => conn.execute("UPDATE panel_connections SET name=?1,api_key_ciphertext=?2,sort_order=?3,allow_insecure_tls=?4,group_name=?5,source_account_id=?6,source_asset_key=?7,remark=?8,updated_at=?9 WHERE id=?10", params![name,ciphertext,panel.sort_order.unwrap_or(0).max(0),panel.allow_insecure_tls.unwrap_or(false) as i64,panel.group_name,panel.source_account_id,panel.source_asset_key,panel.remark,now,id]).map_err(|e| e.to_string())?,
            None => conn.execute("INSERT INTO panel_connections(name,panel_url,api_key_ciphertext,sort_order,allow_insecure_tls,group_name,source_account_id,source_asset_key,status,summary_json,remark,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'unknown','{}',?9,?10,?10)", params![name,panel_url,ciphertext,panel.sort_order.unwrap_or(0).max(0),panel.allow_insecure_tls.unwrap_or(false) as i64,panel.group_name,panel.source_account_id,panel.source_asset_key,panel.remark,now]).map_err(|e| e.to_string())?,
        };
        imported += 1;
    }
    Ok(imported)
}

fn ssh_saved_connection(account_id: i64, asset_key: &str) -> Result<Option<(String, u16, String, Option<String>, Option<String>)>, String> {
    let conn = open_db()?;
    let managed = conn.query_row(
        "SELECT host,port,username,password_ciphertext,host_key_fingerprint FROM managed_hosts WHERE source_account_id=?1 AND source_asset_key=?2 ORDER BY id LIMIT 1",
        params![account_id, asset_key],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).optional().map_err(|e| format!("读取终端管理 SSH 配置失败: {e}"))?;
    if managed.is_some() { return Ok(managed); }
    conn.query_row(
        "SELECT host,port,username,password_ciphertext,host_key_fingerprint FROM ssh_connections WHERE account_id=?1 AND asset_key=?2",
        params![account_id, asset_key],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).optional().map_err(|e| format!("读取 SSH 连接配置失败: {e}"))
}

fn ssh_credentials(input: &SshConnectInput, saved: &Option<(String, u16, String, Option<String>, Option<String>)>) -> Result<SshCredentials, String> {
    if input.auth_method.as_deref() == Some("private_key") {
        let key = input.private_key.as_deref().map(str::trim).filter(|value| !value.is_empty()).ok_or("请粘贴 SSH 私钥")?;
        return Ok(SshCredentials::PrivateKey { key: key.to_string(), passphrase: input.key_passphrase.as_deref().filter(|value| !value.is_empty()).map(str::to_string) });
    }
    input.password.as_deref().filter(|value| !value.is_empty()).map(str::to_owned)
        .or_else(|| saved.as_ref().and_then(|(_, _, _, value, _)| value.as_ref()).map(|value| decrypt_secret(value)).transpose().ok().flatten())
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
    let account_id = input.account_id.ok_or("缺少云账号标识")?;
    let asset_key = input.asset_key.as_deref().ok_or("缺少资产标识")?;
    open_db()?.execute(
        "INSERT INTO ssh_connections(account_id,asset_key,host,port,username,password_ciphertext,host_key_fingerprint,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(account_id,asset_key) DO UPDATE SET host=excluded.host,port=excluded.port,username=excluded.username,password_ciphertext=excluded.password_ciphertext,host_key_fingerprint=excluded.host_key_fingerprint,updated_at=excluded.updated_at",
        params![account_id, asset_key, input.host, input.port, input.username, password_ciphertext, fingerprint, Utc::now().timestamp_millis()],
    ).map_err(|e| format!("保存 SSH 连接配置失败: {e}"))?;
    Ok(())
}

fn managed_host_name_for_asset(conn: &Connection, account_id: i64, asset_key: &str) -> Result<(String, Option<String>), String> {
    let asset: Option<(String, Option<String>, Option<String>)> = conn.query_row(
        "SELECT a.account_name,a.group_name,assets.payload_json FROM cloud_assets assets JOIN cloud_accounts a ON a.id=assets.account_id WHERE assets.account_id=?1 AND assets.asset_key=?2 ORDER BY assets.fetched_at DESC LIMIT 1",
        params![account_id, asset_key],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional().map_err(|e| format!("读取云资源名称失败: {e}"))?;
    let Some((account_name, account_group, payload)) = asset else { return Ok((asset_key.to_string(), None)); };
    let payload = payload.as_deref().and_then(|value| serde_json::from_str::<Value>(value).ok()).unwrap_or(Value::Null);
    let name = ["InstanceName", "Name", "name", "ServerName", "InstanceId", "Id"]
        .iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_string))
        .unwrap_or_else(|| asset_key.to_string());
    let group = account_group.filter(|value| !value.trim().is_empty()).or_else(|| (!account_name.trim().is_empty()).then_some(account_name));
    Ok((name, group))
}

fn save_managed_host_from_ssh(input: &SshConnectInput, password_ciphertext: &str, fingerprint: &str) -> Result<(), String> {
    let account_id = input.account_id.ok_or("缺少云账号标识")?;
    let asset_key = input.asset_key.as_deref().map(str::trim).filter(|value| !value.is_empty()).ok_or("缺少资产标识")?;
    let conn = open_db()?;
    let now = Utc::now().timestamp_millis();
    let existing_id: Option<i64> = conn.query_row(
        "SELECT id FROM managed_hosts WHERE source_account_id=?1 AND source_asset_key=?2 ORDER BY id LIMIT 1",
        params![account_id, asset_key],
        |row| row.get(0),
    ).optional().map_err(|e| format!("读取终端管理服务器失败: {e}"))?;
    if let Some(id) = existing_id {
        conn.execute(
            "UPDATE managed_hosts SET host=?1,port=?2,username=?3,password_ciphertext=?4,host_key_fingerprint=?5,status='online',last_error=NULL,updated_at=?6 WHERE id=?7",
            params![input.host.trim(), input.port.max(1), input.username.trim(), password_ciphertext, fingerprint, now, id],
        ).map_err(|e| format!("更新终端管理服务器失败: {e}"))?;
        return Ok(());
    }
    let (name, group_name) = managed_host_name_for_asset(&conn, account_id, asset_key)?;
    conn.execute(
        "INSERT INTO managed_hosts(name,host,port,username,password_ciphertext,group_name,source_account_id,source_asset_key,host_key_fingerprint,status,metrics_json,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'online','{}',?10,?10)",
        params![name, input.host.trim(), input.port.max(1), input.username.trim(), password_ciphertext, group_name, account_id, asset_key, fingerprint, now],
    ).map_err(|e| format!("保存终端管理服务器失败: {e}"))?;
    Ok(())
}

#[tauri::command]
fn get_ssh_connection(account_id: i64, asset_key: String) -> Result<Option<SavedSshConnection>, String> {
    Ok(ssh_saved_connection(account_id, &asset_key)?.map(|(host, port, username, password, _)| SavedSshConnection {
        host, port, username, password_saved: password.is_some(),
    }))
}

#[tauri::command]
fn reveal_ssh_password(account_id: Option<i64>, asset_key: Option<String>, managed_host_id: Option<i64>) -> Result<String, String> {
    let ciphertext: Option<String> = if let Some(id) = managed_host_id {
        open_db()?.query_row("SELECT password_ciphertext FROM managed_hosts WHERE id=?1", [id], |row| row.get(0))
            .map_err(|e| format!("读取受管服务器 SSH 密码失败: {e}"))?
    } else {
        let account_id = account_id.ok_or("缺少云账号标识")?;
        let asset_key = asset_key.filter(|value| !value.trim().is_empty()).ok_or("缺少服务器标识")?;
        let conn = open_db()?;
        let managed: Option<String> = conn.query_row("SELECT password_ciphertext FROM managed_hosts WHERE source_account_id=?1 AND source_asset_key=?2 ORDER BY id LIMIT 1", params![account_id, asset_key], |row| row.get(0))
            .optional().map_err(|e| format!("读取终端管理 SSH 密码失败: {e}"))?;
        managed.or_else(|| conn.query_row("SELECT password_ciphertext FROM ssh_connections WHERE account_id=?1 AND asset_key=?2", params![account_id, asset_key], |row| row.get(0)).optional().ok().flatten())
    };
    let ciphertext = ciphertext.ok_or("当前没有保存 SSH 密码")?;
    decrypt_secret(&ciphertext)
}

#[tauri::command]
fn delete_ssh_connection(account_id: i64, asset_key: String) -> Result<(), String> {
    open_db()?.execute("DELETE FROM ssh_connections WHERE account_id=?1 AND asset_key=?2", params![account_id, asset_key])
        .map_err(|e| format!("清除 SSH 连接配置失败: {e}"))?;
    Ok(())
}

#[tauri::command]
fn get_rdp_connection(target_key: String) -> Result<Option<SavedRdpConnection>, String> {
    open_db()?.query_row(
        "SELECT host,port,username,password_ciphertext FROM rdp_connections WHERE target_key=?1",
        [target_key],
        |row| Ok(SavedRdpConnection {
            host: row.get(0)?, port: row.get(1)?, username: row.get(2)?,
            password_saved: row.get::<_, Option<String>>(3)?.is_some(),
        }),
    ).optional().map_err(|e| format!("读取 RDP 连接配置失败: {e}"))
}

#[tauri::command]
fn reveal_rdp_password(target_key: String) -> Result<String, String> {
    let ciphertext: String = open_db()?.query_row("SELECT password_ciphertext FROM rdp_connections WHERE target_key=?1", [target_key], |row| row.get::<_, Option<String>>(0))
        .optional().map_err(|e| format!("读取 RDP 密码失败: {e}"))?
        .flatten().ok_or("未保存 RDP 密码")?;
    decrypt_secret(&ciphertext)
}

#[tauri::command]
fn delete_rdp_connection(target_key: String) -> Result<(), String> {
    open_db()?.execute("DELETE FROM rdp_connections WHERE target_key=?1", [target_key])
        .map_err(|e| format!("清除 RDP 连接配置失败: {e}"))?;
    Ok(())
}

fn save_rdp_connection(input: &RdpConnectionInput) -> Result<(), String> {
    let target_key = input.target_key.trim();
    let host = input.host.trim();
    let username = input.username.trim();
    if target_key.is_empty() || host.is_empty() || username.is_empty() { return Err("请填写 RDP 主机和用户名".into()); }
    let conn = open_db()?;
    let existing_secret: Option<String> = conn.query_row("SELECT password_ciphertext FROM rdp_connections WHERE target_key=?1", [target_key], |row| row.get(0)).optional().map_err(|e| e.to_string())?.flatten();
    let secret = input.password.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(encrypt_secret).transpose()?.or(existing_secret);
    conn.execute(
        "INSERT INTO rdp_connections(target_key,host,port,username,password_ciphertext,updated_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(target_key) DO UPDATE SET host=excluded.host,port=excluded.port,username=excluded.username,password_ciphertext=excluded.password_ciphertext,updated_at=excluded.updated_at",
        params![target_key, host, input.port.max(1), username, secret, Utc::now().timestamp_millis()],
    ).map_err(|e| format!("保存 RDP 连接配置失败: {e}"))?;
    Ok(())
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
        let path = std::env::temp_dir().join(format!("cloudhub-tools-rdp-{}.rdp", Uuid::new_v4()));
        let content = format!("full address:s:{address}\r\nusername:s:{username}\r\nprompt for credentials:i:1\r\nauthentication level:i:2\r\nredirectclipboard:i:1\r\n");
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
        expected_fingerprint: saved.as_ref().and_then(|(_, _, _, _, fingerprint)| fingerprint.clone()),
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
        open_db()?.execute("UPDATE managed_hosts SET host=?1,port=?2,username=?3,password_ciphertext=COALESCE(?4,password_ciphertext),host_key_fingerprint=?5,status='online',last_error=NULL,updated_at=?6 WHERE id=?7", params![persisted_input.host, port, persisted_input.username, persisted.as_deref(), fingerprint, Utc::now().timestamp_millis(), managed_host_id]).map_err(|e| e.to_string())?;
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
    let handler = SshHostKeyHandler { expected_fingerprint: saved.as_ref().and_then(|(_, _, _, _, fingerprint)| fingerprint.clone()), observed_fingerprint: observed_fingerprint.clone() };
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
    let mut fetched = 0usize; let mut counts = BTreeMap::new(); let mut errors = Vec::new(); let mut rows: Vec<(String, ResourceResponse)> = Vec::new();
    for resource_type in types {
        let response = if cloud_type == "vultr" { vultr_resource_items(id, &resource_type).await } else if cloud_type == "huawei" { huawei_resource_items(id, &resource_type).await } else if cloud_type == "baidu" { baidu_resource_items(id, &resource_type).await } else if cloud_type == "ucloud" { ucloud_resource_items(id, &resource_type).await } else if cloud_type == "qiniu" { qiniu_resource_items(id, &resource_type).await } else if cloud_type == "aws" { aws_resource_items(id, &resource_type).await } else if cloud_type == "azure" { azure_resource_items(id, &resource_type).await } else if cloud_type == "gcp" { gcp_resource_items(id, &resource_type).await } else if cloud_type == "jdcloud" { jdcloud_resource_items(id, &resource_type).await } else if cloud_type == "qingcloud" { qingcloud_resource_items(id, &resource_type).await } else if cloud_type == "ksyun" { ksyun_resource_items(id, &resource_type).await } else if cloud_type == "oracle" { oracle_resource_items(id, &resource_type).await } else if cloud_type == "tencent" { tencent_resource_items(id, &resource_type, &access_key_id, &access_key_secret).await } else if cloud_type == "volcengine" { volc_resource_items(id, &resource_type, &access_key_id, &access_key_secret).await } else if cloud_type == "ctyun" { ctyun_resource_items(id, &resource_type, &access_key_id, &access_key_secret).await } else { resource_items(&resource_type, &access_key_id, &access_key_secret).await };
        if !response.errors.is_empty() { errors.extend(response.errors.clone().into_iter().map(|e| format!("{resource_type}: {e}"))); }
        rows.push((resource_type, response));
    }
    let mut conn = open_db()?; let tx = conn.transaction().map_err(|e| e.to_string())?;
    for (resource_type, response) in rows { let item_count = response.items.len(); counts.insert(resource_type.clone(), item_count); tx.execute("DELETE FROM cloud_assets WHERE account_id=?1 AND resource_type=?2", params![id, resource_type]).map_err(|e| e.to_string())?; for (index, item) in response.items.iter().enumerate() { let key = asset_key(&resource_type, item, index); let region = item.get("_region_id").and_then(Value::as_str).or_else(|| item.get("RegionId").and_then(Value::as_str)); tx.execute("INSERT OR REPLACE INTO cloud_assets(account_id,resource_type,asset_key,region_id,payload_json,fetched_at) VALUES(?1,?2,?3,?4,?5,?6)", params![id, resource_type, key, region, serde_json::to_string(item).map_err(|e| e.to_string())?, response.fetched_at]).map_err(|e| e.to_string())?; fetched += 1; } }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(AssetSyncResult { fetched, counts, errors, fetched_at: now })
}

#[tauri::command]
fn list_local_assets(account_id: Option<i64>, resource_type: Option<String>) -> Result<Vec<LocalAsset>, String> {
    let conn = open_db()?; let mut stmt = conn.prepare("SELECT account_id,resource_type,asset_key,region_id,payload_json,fetched_at FROM cloud_assets WHERE (?1 IS NULL OR account_id=?1) AND (?2 IS NULL OR resource_type=?2) ORDER BY resource_type,asset_key").map_err(|e| e.to_string())?;
    let rows = stmt.query_map(rusqlite::params![account_id, resource_type], |row| { let payload: String = row.get(4)?; Ok(LocalAsset { account_id: row.get(0)?, resource_type: row.get(1)?, asset_key: row.get(2)?, region_id: row.get(3)?, payload: serde_json::from_str(&payload).unwrap_or(Value::Null), fetched_at: row.get(5)? }) }).map_err(|e| e.to_string())?;
    rows.map(|r| r.map_err(|e| e.to_string())).collect()
}

#[tauri::command]
async fn set_oss_public_read(id: i64, bucket: String, location: String) -> Result<(), String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    oss_set_public_read(&bucket, &location, &access_key_id, &access_key_secret).await
}

fn display_json(value: &Value) -> String { match value { Value::String(v) => v.clone(), Value::Null => "-".into(), _ => value.to_string() } }

#[tauri::command]
async fn cloud_account_summary(id: i64) -> Result<Value, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    if account_cloud_type(id)? == "tencent" {
        let (cvm, domains, swas, rds, redis, oss, esa, identity, balance, bill) = tokio::join!(
            tencent_resource_items(id, "ecs", &access_key_id, &access_key_secret),
            tencent_resource_items(id, "domain", &access_key_id, &access_key_secret),
            tencent_resource_items(id, "swas", &access_key_id, &access_key_secret),
            tencent_resource_items(id, "rds", &access_key_id, &access_key_secret),
            tencent_resource_items(id, "redis", &access_key_id, &access_key_secret),
            tencent_resource_items(id, "oss", &access_key_id, &access_key_secret),
            tencent_resource_items(id, "esa", &access_key_id, &access_key_secret),
            tencent_request("cam", "2019-01-16", "GetUserAppId", json!({}), None, &access_key_id, &access_key_secret),
            tencent_request("billing", "2018-07-09", "DescribeAccountBalance", json!({}), None, &access_key_id, &access_key_secret),
            tencent_request("billing", "2018-07-09", "DescribeBillSummaryByPayMode", json!({"BeginTime": format!("{}-01", Utc::now().format("%Y-%m")), "EndTime": Utc::now().format("%Y-%m-%d").to_string()}), None, &access_key_id, &access_key_secret),
        );
        let identity = identity.unwrap_or_else(|_| json!({}));
        let balance = balance.unwrap_or_else(|_| json!({}));
        let bill = bill.unwrap_or_else(|_| json!({}));
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
            volc_resource_items(id, "ecs", &access_key_id, &access_key_secret),
            volc_resource_items(id, "domain", &access_key_id, &access_key_secret),
            volc_resource_items(id, "swas", &access_key_id, &access_key_secret),
            volc_resource_items(id, "oss", &access_key_id, &access_key_secret),
            volc_resource_items(id, "rds", &access_key_id, &access_key_secret),
            volc_resource_items(id, "redis", &access_key_id, &access_key_secret),
            volc_resource_items(id, "esa", &access_key_id, &access_key_secret),
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
            ctyun_resource_items(id, "ecs", &access_key_id, &access_key_secret), ctyun_resource_items(id, "domain", &access_key_id, &access_key_secret),
            ctyun_resource_items(id, "rds", &access_key_id, &access_key_secret), ctyun_resource_items(id, "redis", &access_key_id, &access_key_secret), ctyun_resource_items(id, "oss", &access_key_id, &access_key_secret),
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
    if let Ok(identity) = aliyun_rpc("sts.aliyuncs.com", "2015-04-01", "GetCallerIdentity", BTreeMap::new(), &access_key_id, &access_key_secret).await {
        summary["account_id"] = identity.get("AccountId").cloned().unwrap_or(json!("-"));
        summary["account_type"] = json!(match identity.get("IdentityType").and_then(Value::as_str).unwrap_or("") { "Account" => "主账号", "RAMUser" => "RAM子用户", "AssumedRoleUser" => "角色用户", other if !other.is_empty() => other, _ => "-" });
    }
    if let Ok(balance) = aliyun_rpc("business.aliyuncs.com", "2017-12-14", "QueryAccountBalance", BTreeMap::new(), &access_key_id, &access_key_secret).await {
        if let Some(data) = balance.get("Data") {
            for (source, target) in [("AvailableAmount", "available_amount"), ("AvailableCashAmount", "available_cash_amount"), ("CreditAmount", "credit_amount")] {
                summary[target] = data.get(source).cloned().unwrap_or(json!(0));
            }
        }
    }
    let billing_cycle = Utc::now().format("%Y-%m").to_string();
    if let Ok(bill) = aliyun_rpc("business.aliyuncs.com", "2017-12-14", "QueryBill", string_params(&[("BillingCycle", billing_cycle)]), &access_key_id, &access_key_secret).await {
        let total: f64 = array_at(&bill, &["Data", "Items", "Item"]).into_iter().filter_map(|item| item.get("PretaxAmount").and_then(|v| v.as_f64().or_else(|| v.as_str()?.parse().ok()))).sum();
        summary["month_bill"] = json!(total);
    }
    for resource_type in ["ecs", "domain", "oss", "rds", "redis", "swas", "esa"] { let result = resource_items(resource_type, &access_key_id, &access_key_secret).await; summary[&format!("{resource_type}_count")] = json!(result.items.len()); }
    if let Ok(dns) = aliyun_rpc("alidns.aliyuncs.com", "2015-01-09", "DescribeDomains", string_params(&[("PageNumber", "1".into()), ("PageSize", "20".into())]), &access_key_id, &access_key_secret).await {
        summary["dns_record_count"] = json!(array_at(&dns, &["Domains", "Domain"]).into_iter().filter_map(|item| item.get("RecordCount").and_then(Value::as_i64)).sum::<i64>());
    }
    Ok(summary)
}

fn row_account(row: &rusqlite::Row<'_>) -> rusqlite::Result<CloudAccount> {
    Ok(CloudAccount { id: row.get(0)?, account_name: row.get(1)?, cloud_type: row.get(2)?, group_name: row.get(3)?, access_key_id: row.get(4)?, credential_meta: row.get(5)?, region_id: row.get(6)?, sort_order: row.get(7)?, enabled: row.get::<_, i64>(8)? == 1, remark: row.get(9)?, created_at: row.get(10)?, updated_at: row.get(11)? })
}

#[tauri::command]
fn export_accounts(account_ids: Option<Vec<i64>>) -> Result<Vec<ExportAccount>, String> {
    let conn = open_db()?;
    let selected_ids = account_ids.filter(|ids| !ids.is_empty());
    let mut stmt = conn.prepare("SELECT id,account_name,cloud_type,group_name,access_key_id,secret_ciphertext,credential_meta,region_id,sort_order,enabled,remark FROM cloud_accounts ORDER BY sort_order ASC, updated_at DESC").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        let ciphertext: String = row.get(5)?;
        Ok((
            row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?,
            row.get::<_, String>(4)?, ciphertext, row.get::<_, Option<String>>(6)?, row.get::<_, Option<String>>(7)?, row.get::<_, i64>(8)?,
            row.get::<_, i64>(9)? == 1, row.get::<_, Option<String>>(10)?,
        ))
    }).map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for row in rows {
        let (id, account_name, cloud_type, group_name, access_key_id, ciphertext, credential_meta, region_id, sort_order, enabled, remark) = row.map_err(|e| e.to_string())?;
        if selected_ids.as_ref().is_some_and(|ids| !ids.contains(&id)) { continue; }
        result.push(ExportAccount { account_name, cloud_type, group_name, access_key_id, access_key_secret: decrypt_secret(&ciphertext)?, credential_meta, region_id, sort_order, enabled, remark });
    }
    Ok(result)
}

#[tauri::command]
fn export_accounts_file(account_ids: Option<Vec<i64>>) -> Result<String, String> {
    let accounts = export_accounts(account_ids)?;
    let filename = format!("cloudhub-tools-accounts-{}.json", Utc::now().format("%Y%m%d-%H%M%S"));
    let base = dirs::home_dir().unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    // Keep exported credentials easy to find: write to the current user's Desktop.
    // Fall back to the home directory when the Desktop folder is unavailable.
    let desktop = base.join("Desktop");
    let dir = if desktop.exists() { desktop } else { base };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(filename);
    let payload = serde_json::json!({
        "format": "cloudhub-tools-account-export",
        "version": 2,
        "encryption": "plaintext",
        "secret_exported": true,
        "exported_at": Utc::now().to_rfc3339(),
        "accounts": accounts,
    });
    std::fs::write(&path, serde_json::to_vec_pretty(&payload).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn import_accounts(accounts: Vec<ImportAccount>) -> Result<usize, String> {
    if accounts.is_empty() { return Err("导入文件中没有云账号".into()); }
    let mut imported = 0usize;
    for (index, account) in accounts.into_iter().enumerate() {
        if account.account_name.trim().is_empty() || account.access_key_id.trim().is_empty() || account.access_key_secret.trim().is_empty() {
            return Err(format!("第 {} 条账号缺少账号名称、AccessKey ID 或 AccessKey Secret", index + 1));
        }
        let existing_id: Option<i64> = open_db()?.query_row("SELECT id FROM cloud_accounts WHERE access_key_id=?1", [&account.access_key_id], |row| row.get(0)).optional().map_err(|e| e.to_string())?;
        save_account(AccountInput {
            id: existing_id,
            account_name: account.account_name,
            cloud_type: account.cloud_type.unwrap_or_else(|| "aliyun".into()),
            group_name: account.group_name,
            access_key_id: account.access_key_id,
            access_key_secret: Some(account.access_key_secret),
            credential_meta: account.credential_meta,
            region_id: account.region_id,
            sort_order: account.sort_order,
            enabled: account.enabled.unwrap_or(true),
            remark: account.remark,
        })?;
        imported += 1;
    }
    Ok(imported)
}

#[tauri::command]
fn list_accounts(keyword: Option<String>) -> Result<Vec<CloudAccount>, String> {
    let conn = open_db()?; let value = keyword.unwrap_or_default().trim().to_string(); let pattern = format!("%{value}%");
    let mut stmt = conn.prepare("SELECT id,account_name,cloud_type,group_name,access_key_id,credential_meta,region_id,sort_order,enabled,remark,created_at,updated_at FROM cloud_accounts WHERE ?1='' OR account_name LIKE ?2 OR access_key_id LIKE ?2 OR COALESCE(group_name,'') LIKE ?2 ORDER BY sort_order ASC, updated_at DESC").map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![value, pattern], row_account).map_err(|e| e.to_string())?; rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_account(mut input: AccountInput) -> Result<CloudAccount, String> {
    if input.account_name.trim().is_empty() || input.access_key_id.trim().is_empty() { return Err("账号名称和 AccessKey ID 不能为空".into()); }
    let conn = open_db()?; let now = Utc::now().timestamp_millis();
    if input.cloud_type == "oracle" {
        if let Some(private_key) = input.access_key_secret.as_mut() { *private_key = serialize_oci_private_key(private_key); }
        let meta: Value = serde_json::from_str(input.credential_meta.as_deref().unwrap_or("{}")).map_err(|_| "OCI 凭证信息格式无效".to_string())?;
        if meta.get("tenancy_ocid").and_then(Value::as_str).is_none_or(|value| value.trim().is_empty()) || meta.get("key_fingerprint").and_then(Value::as_str).is_none_or(|value| value.trim().is_empty()) { return Err("OCI 账号需要填写 Tenancy OCID 和 Key Fingerprint".into()); }
    }
    if input.cloud_type == "azure" {
        let meta: Value = serde_json::from_str(input.credential_meta.as_deref().unwrap_or("{}")).map_err(|_| "Azure 凭证信息格式无效".to_string())?;
        if meta.get("tenant_id").and_then(Value::as_str).is_none_or(|value| value.trim().is_empty()) || meta.get("subscription_id").and_then(Value::as_str).is_none_or(|value| value.trim().is_empty()) { return Err("Azure 账号需要填写 Tenant ID 和 Subscription ID".into()); }
    }
    if input.cloud_type == "gcp" {
        let meta: Value = serde_json::from_str(input.credential_meta.as_deref().unwrap_or("{}")).map_err(|_| "GCP 凭证信息格式无效".to_string())?;
        if meta.get("project_id").and_then(Value::as_str).is_none_or(|value| value.trim().is_empty()) { return Err("GCP 账号需要填写 Project ID".into()); }
    }
    let old_secret: Option<String> = input.id.and_then(|id| conn.query_row("SELECT secret_ciphertext FROM cloud_accounts WHERE id=?1", [id], |r| r.get(0)).optional().ok().flatten());
    let secret = match input.access_key_secret.filter(|v| !v.trim().is_empty()) { Some(value) => encrypt_secret(&value)?, None => old_secret.ok_or_else(|| "首次添加必须填写 AccessKey Secret".to_string())? };
    let id = match input.id {
        Some(id) => { conn.execute("UPDATE cloud_accounts SET account_name=?1,cloud_type=?2,group_name=?3,access_key_id=?4,secret_ciphertext=?5,credential_meta=?6,region_id=?7,sort_order=?8,enabled=?9,remark=?10,updated_at=?11 WHERE id=?12", params![input.account_name.trim(), input.cloud_type, input.group_name, input.access_key_id.trim(), secret, input.credential_meta, input.region_id, input.sort_order.unwrap_or(0), input.enabled as i64, input.remark, now, id]).map_err(|e| e.to_string())?; id }
        None => { conn.execute("INSERT INTO cloud_accounts(account_name,cloud_type,group_name,access_key_id,secret_ciphertext,credential_meta,region_id,sort_order,enabled,remark,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)", params![input.account_name.trim(), input.cloud_type, input.group_name, input.access_key_id.trim(), secret, input.credential_meta, input.region_id, input.sort_order.unwrap_or(0), input.enabled as i64, input.remark, now]).map_err(|e| e.to_string())?; conn.last_insert_rowid() }
    };
    conn.query_row("SELECT id,account_name,cloud_type,group_name,access_key_id,credential_meta,region_id,sort_order,enabled,remark,created_at,updated_at FROM cloud_accounts WHERE id=?1", [id], row_account).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_account(id: i64) -> Result<(), String> { open_db()?.execute("DELETE FROM cloud_accounts WHERE id=?1", [id]).map(|_| ()).map_err(|e| e.to_string()) }

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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![list_accounts, save_account, delete_account, app_data_path, open_app_data_directory, reveal_account_secret, cloud_account_summary, list_cloud_resources, sync_cloud_assets, verify_vultr_account, verify_ctyun_account, verify_huawei_account, verify_baidu_account, verify_ucloud_account, verify_qiniu_account, verify_aws_account, verify_azure_account, verify_gcp_account, verify_jdcloud_account, verify_qingcloud_account, verify_ksyun_account, esa_overview, list_local_assets, list_managed_hosts, save_managed_host, delete_managed_host, probe_managed_host, list_panel_connections, save_panel_connection, refresh_panel_connection, panel_temporary_login, delete_panel_connection, export_panel_connections_file, import_panel_connections, list_api_logs, clear_api_logs, clear_operation_logs, list_instance_disks, instance_status, reboot_instance, start_instance, stop_instance, oracle_instance_action, cvm_instance_reboot, cvm_instance_action, baidu_instance_action, rename_server, swas_instance_action, list_dns_records, add_dns_record, update_dns_record, delete_dns_record, toggle_dns_record, list_domain_logs, query_whois, list_rds_databases, list_rds_accounts, list_redis_accounts, list_oss_objects, get_oss_acl, set_oss_public_read, set_oss_cors, get_ssh_connection, reveal_ssh_password, delete_ssh_connection, get_rdp_connection, reveal_rdp_password, delete_rdp_connection, launch_rdp_connection, ssh_connect, ssh_test_connection, ssh_list_files, ssh_read_text_file, ssh_write_text_file, ssh_upload_file, ssh_download_file, ssh_make_directory, ssh_delete_path, ssh_read, ssh_write, ssh_resize, ssh_disconnect, export_accounts, export_accounts_file, import_accounts])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
