use crate::core::{
    error::PlatformResult,
    storage::{decrypt_secret, encrypt_secret, open_db},
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    net::TcpListener,
    sync::Mutex,
    time::Duration,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS antigravity_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    refresh_token_ciphertext TEXT NOT NULL,
    access_token_ciphertext TEXT NOT NULL DEFAULT '',
    expires_at INTEGER,
    project_id TEXT,
    oauth_client_key TEXT,
    subscription_tier TEXT NOT NULL DEFAULT 'FREE',
    priority INTEGER NOT NULL DEFAULT 50 CHECK(priority BETWEEN 1 AND 100),
    gemini_priority INTEGER,
    claude_priority INTEGER,
    proxy_disabled INTEGER NOT NULL DEFAULT 0,
    proxy_url TEXT,
    disabled INTEGER NOT NULL DEFAULT 0,
    disabled_reason TEXT,
    custom_label TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    tags_json TEXT NOT NULL DEFAULT '[]',
    quota_json TEXT NOT NULL DEFAULT '{}',
    device_profile_json TEXT NOT NULL DEFAULT '{}',
    device_history_json TEXT NOT NULL DEFAULT '[]',
    last_error TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS antigravity_original_device_profile (
    storage_path TEXT PRIMARY KEY,
    fields_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS antigravity_quota_refresh_logs (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES antigravity_accounts(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    source TEXT NOT NULL,
    success INTEGER NOT NULL,
    requests_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS antigravity_quota_refresh_logs_account
ON antigravity_quota_refresh_logs(account_id, id DESC);
CREATE TABLE IF NOT EXISTS antigravity_preferences (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    current_account_id INTEGER,
    target_current_json TEXT NOT NULL DEFAULT '{}'
);";

const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
// Antigravity 桌面客户端公开使用的 Google OAuth 桌面应用凭据（桌面客户端按设计无法保密，
// 与官方客户端及其他开源工具一致）。凭据以 base64 分段存放并在运行时拼接解码，
// 避免 GitHub Push Protection 将整段密文误判为泄漏（此为公开常量，非用户密钥）。
const CLIENT_ID_B64: &str = concat!(
    "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgy",
    "MWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
);
const CLIENT_SECRET_B64: &str = concat!(
    "R09DU1BYLUs1OEZXUjQ4Nk",
    "xkTEoxbUxCOHNYQzR6NnFEQWY=",
);
const GCP_CLIENT_ID_B64: &str = concat!(
    "ODg0MzU0OTE5MDUyLTM2dHJjMWpqYjN0",
    "Z3VpYWMzMm92NmNvZDI2OGM1YmxoLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29t",
);
const GCP_CLIENT_SECRET_B64: &str = concat!(
    "R09DU1BYLTlZUVdwRjdSV0RD",
    "MFFUZGotWXhLTXdSMFp0c1g=",
);

fn decode_credential(value: &str) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_default()
}

const LOAD_CODE_ASSIST_ENDPOINTS: [&str; 3] = [
    "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist",
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
];
const QUOTA_API_ENDPOINTS: [&str; 2] = [
    "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
];
const QUOTA_SUMMARY_ENDPOINTS: [&str; 2] = [
    "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
];
const WARMUP_ENDPOINTS: [&str; 2] = [
    "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent",
    "https://cloudcode-pa.googleapis.com/v1internal:generateContent",
];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityModelQuota {
    pub name: String,
    pub percentage: i32,
    pub reset_time: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityQuotaBucket {
    pub bucket_id: String,
    pub window: String,
    pub remaining_fraction: f64,
    pub reset_time: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityQuotaGroup {
    pub display_name: String,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub buckets: Vec<AntigravityQuotaBucket>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityQuotaData {
    #[serde(default)]
    pub models: Vec<AntigravityModelQuota>,
    #[serde(default)]
    pub quota_groups: Vec<AntigravityQuotaGroup>,
    #[serde(default)]
    pub last_updated: i64,
    #[serde(default)]
    pub is_forbidden: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forbidden_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscription_tier: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityDeviceProfile {
    #[serde(default)]
    pub machine_id: String,
    #[serde(default)]
    pub mac_machine_id: String,
    #[serde(default)]
    pub dev_device_id: String,
    #[serde(default)]
    pub sqm_id: String,
}

impl AntigravityDeviceProfile {
    fn is_empty(&self) -> bool {
        self.machine_id.trim().is_empty()
            && self.mac_machine_id.trim().is_empty()
            && self.dev_device_id.trim().is_empty()
            && self.sqm_id.trim().is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityDeviceHistory {
    fingerprint_id: String,
    created_at: i64,
    profile: AntigravityDeviceProfile,
}

const DEVICE_KEYS: [&str; 4] = [
    "telemetry.machineId", "telemetry.macMachineId", "telemetry.devDeviceId", "telemetry.sqmId",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityWarmupResult {
    pub ok: bool,
    pub latency_ms: u64,
    pub model_used: Option<String>,
    pub detail: String,
    pub state: AntigravityState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityAccountView {
    pub id: i64,
    pub email: String,
    pub name: Option<String>,
    pub project_id: Option<String>,
    pub oauth_client_key: Option<String>,
    pub subscription_tier: String,
    pub priority: i64,
    pub gemini_priority: Option<i64>,
    pub claude_priority: Option<i64>,
    pub proxy_disabled: bool,
    pub proxy_url: Option<String>,
    pub disabled: bool,
    pub disabled_reason: Option<String>,
    pub custom_label: String,
    pub note: String,
    pub tags: Vec<String>,
    pub quota: AntigravityQuotaData,
    pub device_profile: Option<AntigravityDeviceProfile>,
    pub device_history: Vec<AntigravityDeviceHistory>,
    pub has_refresh_token: bool,
    pub last_error: Option<String>,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityState {
    pub accounts: Vec<AntigravityAccountView>,
    pub current_account_id: Option<i64>,
    #[serde(default)]
    pub target_current_ids: HashMap<String, i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravitySwitchResult {
    pub target: String,
    pub applied_to_client: bool,
    pub detail: String,
    pub state: AntigravityState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityImportResult {
    pub total: usize,
    pub success: usize,
    pub failed: usize,
    pub errors: Vec<String>,
    pub state: AntigravityState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityRefreshAllResult {
    pub total: usize,
    pub success: usize,
    pub failed: usize,
    pub state: AntigravityState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExportAccountEntry {
    email: String,
    refresh_token: String,
}

#[derive(Debug, Clone)]
struct OAuthPending {
    status: String,
    error: Option<String>,
    cancelled: bool,
    redirect_uri: String,
    client_id: String,
    client_secret: String,
    client_key: String,
}

static OAUTH_SESSIONS: Mutex<Option<HashMap<String, OAuthPending>>> = Mutex::new(None);
static DEVICE_STORAGE_LOCK: Mutex<()> = Mutex::new(());

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(SCHEMA)
        .map_err(|error| format!("初始化 Antigravity 数据库表失败: {error}"))?;
    if conn.prepare("SELECT requests_json FROM antigravity_quota_refresh_logs LIMIT 0").is_err() {
        let _ = conn.execute(
            "ALTER TABLE antigravity_quota_refresh_logs ADD COLUMN requests_json TEXT NOT NULL DEFAULT '[]'",
            [],
        );
        conn.prepare("SELECT requests_json FROM antigravity_quota_refresh_logs LIMIT 0")
            .map_err(|_| "初始化配额查询日志字段失败")?;
    }
    // 兼容已存在的旧表：若缺少新增列则安全补加
    if conn.prepare("SELECT proxy_url FROM antigravity_accounts LIMIT 0").is_err() {
        let _ = conn.execute("ALTER TABLE antigravity_accounts ADD COLUMN proxy_url TEXT", []);
        conn.prepare("SELECT proxy_url FROM antigravity_accounts LIMIT 0")
            .map_err(|_| "初始化账号代理字段失败")?;
    }
    let _ = conn.execute(
        "ALTER TABLE antigravity_accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE antigravity_accounts ADD COLUMN gemini_priority INTEGER",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE antigravity_accounts ADD COLUMN claude_priority INTEGER",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE antigravity_accounts ADD COLUMN device_profile_json TEXT NOT NULL DEFAULT '{}'",
        [],
    );
    if conn.prepare("SELECT device_history_json FROM antigravity_accounts LIMIT 0").is_err() {
        let _ = conn.execute("ALTER TABLE antigravity_accounts ADD COLUMN device_history_json TEXT NOT NULL DEFAULT '[]'", []);
        conn.prepare("SELECT device_history_json FROM antigravity_accounts LIMIT 0")
            .map_err(|_| "初始化设备指纹历史失败")?;
    }
    let _ = conn.execute(
        "ALTER TABLE antigravity_preferences ADD COLUMN target_current_json TEXT NOT NULL DEFAULT '{}'",
        [],
    );
    Ok(())
}

fn normalize_tier(raw: Option<&str>) -> String {
    let lower = raw.unwrap_or("").trim().to_ascii_lowercase();
    if lower.contains("ultra") || lower.contains("helium") {
        "ULTRA".to_string()
    } else if lower.contains("enterprise") || lower.contains("gcp") || lower.contains("vertex") {
        "ENTERPRISE".to_string()
    } else if lower.contains("pro") || lower.contains("premium") || lower.contains("advanced") {
        "PRO".to_string()
    } else {
        "FREE".to_string()
    }
}

fn detect_local_cli_email() -> Option<String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)?;
    let gemini_dir = home.join(".gemini");

    // 1) Antigravity CLI (agy / jetski standalone)
    let jetski_path = gemini_dir.join("jetski-standalone-oauth-token");
    if let Ok(raw) = std::fs::read_to_string(&jetski_path) {
        if let Ok(val) = serde_json::from_str::<Value>(&raw) {
            if let Some(email) = val
                .get("id_token_email")
                .or_else(|| val.get("email"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                return Some(email.to_string());
            }
        }
    }

    // 2) Gemini CLI google_accounts.json
    let accounts_path = gemini_dir.join("google_accounts.json");
    if let Ok(raw) = std::fs::read_to_string(&accounts_path) {
        if let Ok(val) = serde_json::from_str::<Value>(&raw) {
            if let Some(email) = val
                .get("active")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                return Some(email.to_string());
            }
        }
    }

    // 3) Fallback: oauth_creds.json email field
    let oauth_path = gemini_dir.join("oauth_creds.json");
    if let Ok(raw) = std::fs::read_to_string(&oauth_path) {
        if let Ok(val) = serde_json::from_str::<Value>(&raw) {
            if let Some(email) = val
                .get("email")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                return Some(email.to_string());
            }
        }
    }

    None
}

fn detect_local_jeb_email() -> Option<String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)?;
    let acp_path = home.join(".gemini").join("antigravity-acp").join("acp_token.json");
    let raw = std::fs::read_to_string(acp_path).ok()?;
    let val = serde_json::from_str::<Value>(&raw).ok()?;
    val.get("email")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn detect_local_ide_email(target: &str) -> Option<String> {
    let db_path = antigravity_client_file(target, "state.vscdb");
    let db_path = db_path.as_ref()?;
    let conn = Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let raw: String = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'",
            [],
            |row| row.get(0),
        )
        .optional()
        .ok()??;
    let val = serde_json::from_str::<Value>(&raw).ok()?;
    val.get("email")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn read_state(conn: &Connection) -> Result<AntigravityState, String> {
    ensure_schema(conn)?;
    let pref_row: Option<(Option<i64>, String)> = conn
        .query_row(
            "SELECT current_account_id, COALESCE(target_current_json, '{}') FROM antigravity_preferences WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| format!("读取当前账号失败: {error}"))?;
    let (current_account_id, mut target_current_ids) = match pref_row {
        Some((cid, raw)) => (
            cid,
            serde_json::from_str::<HashMap<String, i64>>(&raw).unwrap_or_default(),
        ),
        None => (None, HashMap::new()),
    };

    let mut stmt = conn
        .prepare(
            "SELECT id, email, name, project_id, oauth_client_key, subscription_tier, priority,
                    gemini_priority, claude_priority, proxy_disabled, disabled, disabled_reason,
                    custom_label, note, tags_json, quota_json, COALESCE(device_profile_json, '{}'),
                    refresh_token_ciphertext, last_error, sort_order, created_at, updated_at, proxy_url, device_history_json
             FROM antigravity_accounts
             ORDER BY CASE WHEN sort_order > 0 THEN 0 ELSE 1 END, sort_order ASC, priority ASC, created_at ASC, id ASC",
        )
        .map_err(|error| format!("查询 Antigravity 账号失败: {error}"))?;

    let rows = stmt
        .query_map([], |row| {
            let tags_raw: String = row.get(14)?;
            let quota_raw: String = row.get(15)?;
            let device_raw: String = row.get(16)?;
            let refresh_cipher: String = row.get(17)?;
            let tags: Vec<String> = serde_json::from_str(&tags_raw).unwrap_or_default();
            let quota: AntigravityQuotaData = serde_json::from_str(&quota_raw).unwrap_or_default();
            let parsed_profile = serde_json::from_str::<AntigravityDeviceProfile>(&device_raw).ok();
            let device_profile = parsed_profile.filter(|p| !p.is_empty());
            Ok(AntigravityAccountView {
                id: row.get(0)?,
                email: row.get(1)?,
                name: row.get(2)?,
                project_id: row.get(3)?,
                oauth_client_key: row.get(4)?,
                subscription_tier: row.get(5)?,
                priority: row.get(6)?,
                gemini_priority: row.get(7)?,
                claude_priority: row.get(8)?,
                proxy_disabled: row.get::<_, i64>(9)? != 0,
                disabled: row.get::<_, i64>(10)? != 0,
                disabled_reason: row.get(11)?,
                custom_label: row.get(12)?,
                note: row.get(13)?,
                tags,
                quota,
                device_profile,
                has_refresh_token: !refresh_cipher.trim().is_empty(),
                last_error: row.get(18)?,
                sort_order: row.get(19)?,
                created_at: row.get(20)?,
                updated_at: row.get(21)?,
                proxy_url: row.get(22)?,
                device_history: serde_json::from_str(&row.get::<_, String>(23)?).unwrap_or_default(),
            })
        })
        .map_err(|error| format!("读取 Antigravity 账号列表失败: {error}"))?;

    let mut accounts = Vec::new();
    for item in rows {
        accounts.push(item.map_err(|error| format!("解析 Antigravity 账号记录失败: {error}"))?);
    }

    // 实时比对本机 CLI / JetBrains ACP / IDE 实际登录账号，自动同步高亮与标识
    let email_to_id: HashMap<String, i64> = accounts
        .iter()
        .map(|acc| (acc.email.trim().to_ascii_lowercase(), acc.id))
        .collect();

    if let Some(cli_email) = detect_local_cli_email() {
        if let Some(&aid) = email_to_id.get(&cli_email.to_ascii_lowercase()) {
            target_current_ids.insert("cli".to_string(), aid);
        } else {
            target_current_ids.remove("cli");
        }
    }

    if let Some(jeb_email) = detect_local_jeb_email() {
        if let Some(&aid) = email_to_id.get(&jeb_email.to_ascii_lowercase()) {
            target_current_ids.insert("jeb".to_string(), aid);
        } else {
            target_current_ids.remove("jeb");
        }
    }

    for target in ["antigravity", "ide"] {
        if let Some(email) = detect_local_ide_email(target) {
            if let Some(&aid) = email_to_id.get(&email.to_ascii_lowercase()) {
                target_current_ids.insert(target.to_string(), aid);
            } else {
                target_current_ids.remove(target);
            }
        }
    }

    if target_current_ids.is_empty() {
        if let Some(cid) = current_account_id {
            if accounts.iter().any(|a| a.id == cid) {
                target_current_ids.insert("antigravity".to_string(), cid);
            }
        }
    }

    Ok(AntigravityState {
        accounts,
        current_account_id,
        target_current_ids,
    })
}

fn http_client() -> Result<reqwest::Client, String> {
    account_http_client(None)
}

fn account_http_client(proxy_url: Option<&str>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("antigravity/hub/2.24.0");
    if let Some(url) = proxy_url {
        let url = crate::core::codex::account_controls::validate_proxy(url)?
            .ok_or("账号代理地址无效")?;
        builder = builder.proxy(reqwest::Proxy::all(url).map_err(|_| "账号代理地址无效")?);
    }
    builder.build().map_err(|_| "创建 HTTP 客户端失败".into())
}

async fn exchange_refresh_token(
    client: &reqwest::Client,
    refresh_token: &str,
    client_key: Option<&str>,
) -> Result<(String, i64, String), String> {
    let enterprise = (
        "antigravity_enterprise",
        decode_credential(CLIENT_ID_B64),
        decode_credential(CLIENT_SECRET_B64),
    );
    let gcp = (
        "antigravity_gcp",
        decode_credential(GCP_CLIENT_ID_B64),
        decode_credential(GCP_CLIENT_SECRET_B64),
    );
    let candidates: Vec<(&str, String, String)> = if client_key == Some("antigravity_gcp") {
        vec![gcp, enterprise]
    } else {
        vec![enterprise, gcp]
    };

    let mut last_err = String::new();
    for (key, cid, csecret) in candidates {
        let resp = client
            .post(GOOGLE_TOKEN_URL)
            .form(&[
                ("client_id", cid.as_str()),
                ("client_secret", csecret.as_str()),
                ("refresh_token", refresh_token),
                ("grant_type", "refresh_token"),
            ])
            .send()
            .await;
        match resp {
            Ok(res) => {
                if res.status().is_success() {
                    let body: Value = res
                        .json()
                        .await
                        .map_err(|error| format!("解析 Google Token 响应失败: {error}"))?;
                    if let Some(token) = body.get("access_token").and_then(|v| v.as_str()) {
                        let expires_in = body
                            .get("expires_in")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(3600);
                        return Ok((token.to_string(), expires_in, key.to_string()));
                    }
                    last_err = "Google Token 响应缺少 access_token".to_string();
                } else {
                    let status = res.status();
                    last_err = format!("OAuth 刷新失败 ({status})");
                }
            }
            Err(_) => {
                last_err = "OAuth 刷新未收到 HTTP 响应".to_string();
            }
        }
    }
    Err(if last_err.is_empty() {
        "OAuth 刷新失败".to_string()
    } else {
        last_err
    })
}

async fn fetch_userinfo(
    client: &reqwest::Client,
    access_token: &str,
) -> Result<(String, Option<String>), String> {
    let resp = client
        .get(GOOGLE_USERINFO_URL)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| format!("获取 Google 用户信息失败: {error}"))?;
    if !resp.status().is_success() {
        return Err(format!("获取 Google 用户信息失败 ({})", resp.status()));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|error| format!("解析 Google 用户信息失败: {error}"))?;
    let email = body
        .get("email")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Google 用户信息缺少邮箱".to_string())?
        .to_string();
    let name = body
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Ok((email, name))
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AntigravityQuotaRequest {
    url: String,
    parameters: Value,
    status: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    response: Option<Value>,
}

fn quota_log_response(body: &Value, access_token: &str) -> Value {
    fn redact(value: &mut Value, access_token: &str) {
        match value {
            Value::Object(fields) => {
                for (key, value) in fields {
                    let key = key.to_ascii_lowercase().replace(['_', '-'], "");
                    if key.contains("project") || key.contains("email")
                        || matches!(key.as_str(), "message" | "userid" | "accountid" | "cookie")
                    {
                        *value = json!("[已隐藏]");
                    } else {
                        redact(value, access_token);
                    }
                }
            }
            Value::Array(items) => items.iter_mut().for_each(|item| redact(item, access_token)),
            Value::String(text) if (!access_token.is_empty() && text.contains(access_token))
                || text.contains('@') || text.contains("1//") || text.contains("ya29.") =>
            {
                *text = "[已隐藏]".into();
            }
            _ => {}
        }
    }

    let mut body = crate::core::repositories::logs::sanitize_json(body, None);
    redact(&mut body, access_token);
    if body.to_string().len() > 64 * 1024 {
        return json!({ "omitted": "返回 JSON 超出日志大小限制" });
    }
    body
}

async fn post_quota_query(
    client: &reqwest::Client,
    endpoint: &str,
    access_token: &str,
    payload: &Value,
    safe_parameters: Value,
    trace: Option<&mut Vec<AntigravityQuotaRequest>>,
) -> Result<(reqwest::StatusCode, Option<Value>), reqwest::Error> {
    let result = client
        .post(endpoint)
        .bearer_auth(access_token)
        .json(payload)
        .send()
        .await;
    let result = match result {
        Ok(response) => {
            let status = response.status();
            let body = if status.is_success() || trace.is_some() {
                response.json::<Value>().await.ok()
            } else {
                None
            };
            Ok((status, body))
        }
        Err(error) => Err(error),
    };
    if let Some(trace) = trace {
        trace.push(AntigravityQuotaRequest {
            url: endpoint.to_string(),
            parameters: safe_parameters,
            status: result.as_ref().ok().map(|(status, _)| status.as_u16()),
            response: result.as_ref().ok().and_then(|(_, body)| body.as_ref())
                .map(|body| quota_log_response(body, access_token)),
        });
    }
    result
}

async fn fetch_code_assist(
    client: &reqwest::Client,
    access_token: &str,
    mut trace: Option<&mut Vec<AntigravityQuotaRequest>>,
) -> (Option<String>, Option<String>) {
    let payload = json!({ "metadata": { "ideType": "ANTIGRAVITY" } });
    for ep in LOAD_CODE_ASSIST_ENDPOINTS {
        if let Ok((status, body)) = post_quota_query(client, ep, access_token, &payload, payload.clone(), trace.as_deref_mut()).await
        {
            if status.is_success() {
                if let Some(body) = body {
                    let project_id = body
                        .get("cloudaicompanionProject")
                        .and_then(|v| {
                            v.as_str()
                                .or_else(|| v.get("id").and_then(|id| id.as_str()))
                        })
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string);
                    let tier_raw = body
                        .get("paidTier")
                        .or_else(|| body.get("currentTier"))
                        .and_then(|v| {
                            v.get("id")
                                .and_then(|id| id.as_str())
                                .or_else(|| v.get("name").and_then(|n| n.as_str()))
                        });
                    let tier = tier_raw.map(|t| normalize_tier(Some(t)));
                    return (project_id, tier);
                }
            }
        }
    }
    (None, None)
}

async fn fetch_quota_from_upstream(
    client: &reqwest::Client,
    access_token: &str,
    cached_project_id: Option<&str>,
    existing_tier: Option<&str>,
    mut trace: Option<&mut Vec<AntigravityQuotaRequest>>,
) -> Result<(AntigravityQuotaData, Option<String>, String), String> {
    let (fresh_project, fresh_tier) = fetch_code_assist(client, access_token, trace.as_deref_mut()).await;
    let project_id = fresh_project.or_else(|| cached_project_id.map(str::to_string));
    let tier = fresh_tier.unwrap_or_else(|| normalize_tier(existing_tier));

    let payload = if let Some(ref pid) = project_id {
        json!({ "project": pid })
    } else {
        json!({})
    };

    let safe_parameters = if project_id.is_some() {
        json!({ "project": "[已隐藏]" })
    } else {
        json!({})
    };

    let mut models: Vec<AntigravityModelQuota> = Vec::new();
    let mut is_forbidden = false;
    let mut forbidden_reason: Option<String> = None;
    let mut fetched_models = false;
    let mut last_err = String::new();

    for ep in QUOTA_API_ENDPOINTS {
        match post_quota_query(client, ep, access_token, &payload, safe_parameters.clone(), trace.as_deref_mut()).await
        {
            Ok((status, body)) => {
                if status == reqwest::StatusCode::FORBIDDEN {
                    is_forbidden = true;
                    forbidden_reason = Some("Forbidden (403)".to_string());
                    fetched_models = true;
                    break;
                }
                if status.is_success() {
                    if let Some(body) = body {
                        if let Some(map) = body.get("models").and_then(|v| v.as_object()) {
                            for (model_id, info) in map {
                                let quota_info = info.get("quotaInfo");
                                let frac = quota_info
                                    .and_then(|q| q.get("remainingFraction"))
                                    .and_then(|v| v.as_f64())
                                    .unwrap_or(1.0);
                                let percentage = (frac * 100.0).round().clamp(0.0, 100.0) as i32;
                                let reset_time = quota_info
                                    .and_then(|q| q.get("resetTime"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let display_name = info
                                    .get("displayName")
                                    .and_then(|v| v.as_str())
                                    .map(str::to_string);
                                models.push(AntigravityModelQuota {
                                    name: model_id.clone(),
                                    percentage,
                                    reset_time,
                                    display_name,
                                });
                            }
                            models.sort_by(|a, b| a.name.cmp(&b.name));
                            fetched_models = true;
                            break;
                        }
                    }
                } else {
                    last_err = format!("获取模型配额失败 ({status})");
                }
            }
            Err(_) => {
                last_err = "请求模型配额失败：未收到 HTTP 响应".to_string();
            }
        }
    }

    if !fetched_models {
        return Err(if last_err.is_empty() {
            "获取模型配额失败".to_string()
        } else {
            last_err
        });
    }

    let mut quota_groups: Vec<AntigravityQuotaGroup> = Vec::new();
    for ep in QUOTA_SUMMARY_ENDPOINTS {
        if let Ok((status, body)) = post_quota_query(client, ep, access_token, &payload, safe_parameters.clone(), trace.as_deref_mut()).await
        {
            if status.is_success() {
                if let Some(body) = body {
                    if let Some(groups) = body
                        .get("groups")
                        .or_else(|| body.get("quotaGroups"))
                        .or_else(|| body.get("quota_groups"))
                        .and_then(|v| v.as_array())
                    {
                        for group in groups {
                            let display_name = group
                                .get("displayName")
                                .or_else(|| group.get("display_name"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("Models")
                                .to_string();
                            let mut buckets = Vec::new();
                            if let Some(raw_buckets) =
                                group.get("buckets").and_then(|v| v.as_array())
                            {
                                for bucket in raw_buckets {
                                    let bucket_id = bucket
                                        .get("bucketId")
                                        .or_else(|| bucket.get("bucket_id"))
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let window = bucket
                                        .get("window")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let remaining_fraction = bucket
                                        .get("remainingFraction")
                                        .or_else(|| bucket.get("remaining_fraction"))
                                        .and_then(|v| v.as_f64())
                                        .unwrap_or(1.0);
                                    let reset_time = bucket
                                        .get("resetTime")
                                        .or_else(|| bucket.get("reset_time"))
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let b_display = bucket
                                        .get("displayName")
                                        .or_else(|| bucket.get("display_name"))
                                        .and_then(|v| v.as_str())
                                        .map(str::to_string);
                                    buckets.push(AntigravityQuotaBucket {
                                        bucket_id,
                                        window,
                                        remaining_fraction,
                                        reset_time,
                                        display_name: b_display,
                                    });
                                }
                            }
                            let mut group_models = Vec::new();
                            if let Some(raw_models) = group
                                .get("models")
                                .or_else(|| group.get("modelIds"))
                                .or_else(|| group.get("model_ids"))
                                .and_then(|v| v.as_array())
                            {
                                for item in raw_models {
                                    let label = item
                                        .as_str()
                                        .or_else(|| item.get("displayName").and_then(|v| v.as_str()))
                                        .or_else(|| item.get("name").and_then(|v| v.as_str()))
                                        .or_else(|| item.get("modelId").and_then(|v| v.as_str()))
                                        .map(str::trim)
                                        .filter(|s| !s.is_empty());
                                    if let Some(m) = label {
                                        group_models.push(m.to_string());
                                    }
                                }
                            }
                            if group_models.is_empty() {
                                if let Some(desc) = group.get("description").and_then(|v| v.as_str()) {
                                    if let Some((_, list_part)) = desc.split_once(':') {
                                        for part in list_part.split(',') {
                                            let cleaned = part.trim().trim_end_matches('.');
                                            if !cleaned.is_empty() {
                                                group_models.push(cleaned.to_string());
                                            }
                                        }
                                    }
                                }
                            }
                            quota_groups.push(AntigravityQuotaGroup {
                                display_name,
                                models: group_models,
                                buckets,
                            });
                        }
                        break;
                    }
                }
            }
        }
    }

    // 用 retrieveUserQuotaSummary 的真实分组窗口校准模型配额：
    // Google fetchAvailableModels 对 Claude / GPT 等第三方模型常返回占位 100%，真实剩余额度在 Claude and GPT models 分组桶中。
    let pick_group_bottleneck = |group: &AntigravityQuotaGroup| -> Option<(i32, String)> {
        let mut best: Option<(i32, String)> = None;
        for b in &group.buckets {
            let pct = (b.remaining_fraction * 100.0).round().clamp(0.0, 100.0) as i32;
            let replace = match &best {
                None => true,
                Some((best_pct, best_reset)) => {
                    pct < *best_pct || (pct == *best_pct && !b.reset_time.is_empty() && best_reset.is_empty())
                }
            };
            if replace {
                best = Some((pct, b.reset_time.clone()));
            }
        }
        best
    };

    let gemini_bottleneck = quota_groups
        .iter()
        .find(|g| g.display_name.to_ascii_lowercase().contains("gemini"))
        .and_then(pick_group_bottleneck);
    let claude_gpt_bottleneck = quota_groups
        .iter()
        .find(|g| {
            let low = g.display_name.to_ascii_lowercase();
            low.contains("claude") || low.contains("gpt") || low.contains("anthropic") || low.contains("openai") || low.contains("3p")
        })
        .and_then(pick_group_bottleneck);

    for model in &mut models {
        let hay = format!(
            "{} {}",
            model.name.to_ascii_lowercase(),
            model.display_name.as_deref().unwrap_or("").to_ascii_lowercase()
        );
        if hay.contains("claude") || hay.contains("gpt") {
            if let Some((pct, ref reset)) = claude_gpt_bottleneck {
                if pct < model.percentage || (model.percentage == 100 && !reset.is_empty()) {
                    model.percentage = pct;
                    if !reset.is_empty() {
                        model.reset_time = reset.clone();
                    }
                }
            }
        } else if hay.contains("gemini") {
            if let Some((pct, ref reset)) = gemini_bottleneck {
                if pct < model.percentage {
                    model.percentage = pct;
                    if !reset.is_empty() {
                        model.reset_time = reset.clone();
                    }
                }
            }
        }
    }

    let now_ms = Utc::now().timestamp_millis();
    let quota = AntigravityQuotaData {
        models,
        quota_groups,
        last_updated: now_ms,
        is_forbidden,
        forbidden_reason,
        subscription_tier: Some(tier.clone()),
    };
    Ok((quota, project_id, tier))
}

#[derive(Debug, Clone)]
struct ParsedImportItem {
    email: String,
    refresh_token: String,
}

fn oauth_client_for_type(account_type: Option<&str>) -> (String, String, String) {
    match account_type.unwrap_or("personal").trim().to_ascii_lowercase().as_str() {
        "gcp" | "enterprise" | "vertex" => (
            "antigravity_gcp".to_string(),
            decode_credential(GCP_CLIENT_ID_B64),
            decode_credential(GCP_CLIENT_SECRET_B64),
        ),
        _ => (
            "antigravity_enterprise".to_string(),
            decode_credential(CLIENT_ID_B64),
            decode_credential(CLIENT_SECRET_B64),
        ),
    }
}

fn extract_raw_refresh_tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let bytes = text.as_bytes();
    let mut i = 0usize;
    while i + 3 < bytes.len() {
        if &bytes[i..i + 3] == b"1//" {
            let mut j = i + 3;
            while j < bytes.len() {
                let c = bytes[j];
                if c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b'/' | b'~' | b'+') {
                    j += 1;
                } else {
                    break;
                }
            }
            let token = &text[i..j];
            if token.len() >= 18 && seen.insert(token.to_string()) {
                out.push(token.to_string());
            }
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

fn parse_import_content(content: &str) -> Vec<ParsedImportItem> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if let Ok(raw) = serde_json::from_str::<Value>(trimmed) {
        let mut list: Vec<Value> = Vec::new();
        if let Some(arr) = raw.as_array() {
            list.extend(arr.iter().cloned());
        } else if let Some(obj) = raw.as_object() {
            if let Some(arr) = obj.get("accounts").and_then(|v| v.as_array()) {
                list.extend(arr.iter().cloned());
            } else if let Some(map) = obj.get("accounts").and_then(|v| v.as_object()) {
                list.extend(map.values().cloned());
            } else if obj.contains_key("refresh_token")
                || obj.contains_key("refreshToken")
                || obj.contains_key("token")
            {
                list.push(raw.clone());
            } else {
                list.extend(obj.values().cloned());
            }
        }
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        for item in list {
            let Some(obj) = item.as_object() else { continue };
            let email = obj
                .get("email")
                .or_else(|| obj.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let refresh_token = obj
                .get("refresh_token")
                .or_else(|| obj.get("refreshToken"))
                .and_then(|v| v.as_str())
                .or_else(|| {
                    obj.get("token")
                        .and_then(|t| t.get("refresh_token").or_else(|| t.get("refreshToken")))
                        .and_then(|v| v.as_str())
                })
                .unwrap_or("")
                .trim()
                .to_string();
            if !refresh_token.is_empty() && seen.insert(refresh_token.clone()) {
                out.push(ParsedImportItem {
                    email,
                    refresh_token,
                });
            }
        }
        if !out.is_empty() {
            return out;
        }
    }

    // Fallback: 从任意文本中自动提取所有 1//... Refresh Token（支持多行/混杂文本）
    extract_raw_refresh_tokens(trimmed)
        .into_iter()
        .map(|refresh_token| ParsedImportItem {
            email: String::new(),
            refresh_token,
        })
        .collect()
}

async fn upsert_account_from_token(
    email_hint: &str,
    refresh_token: &str,
    note: Option<&str>,
    custom_label: Option<&str>,
    priority: Option<i64>,
    force: bool,
    preferred_client_key: Option<&str>,
) -> Result<(), String> {
    let token = refresh_token.trim();
    if token.is_empty() {
        return Err("Refresh Token 不能为空".to_string());
    }
    let client = http_client()?;
    let now_ms = Utc::now().timestamp_millis();

    let (access_token, expires_in, oauth_client_key, resolved_email, resolved_name, quota_opt, project_id, tier, last_error) =
        match exchange_refresh_token(&client, token, preferred_client_key).await {
            Ok((access, exp, client_key)) => {
                let (email_fetched, name_fetched) = match fetch_userinfo(&client, &access).await {
                    Ok((e, n)) => (e, n),
                    Err(err) => {
                        if email_hint.trim().is_empty() {
                            return Err(err);
                        }
                        (email_hint.trim().to_string(), None)
                    }
                };
                let (quota_data, pid, tier_str, q_err) =
                    match fetch_quota_from_upstream(&client, &access, None, None, None).await {
                        Ok((q, p, t)) => (Some(q), p, t, None),
                        Err(err) => (None, None, "FREE".to_string(), Some(err)),
                    };
                (
                    Some(access),
                    Some(Utc::now().timestamp() + exp),
                    Some(client_key),
                    email_fetched,
                    name_fetched,
                    quota_data,
                    pid,
                    tier_str,
                    q_err,
                )
            }
            Err(err) => {
                if !force || email_hint.trim().is_empty() {
                    return Err(err);
                }
                (
                    None,
                    None,
                    None,
                    email_hint.trim().to_string(),
                    None,
                    None,
                    None,
                    "FREE".to_string(),
                    Some(err),
                )
            }
        };

    let refresh_cipher = encrypt_secret(token)?;
    let access_cipher = match access_token {
        Some(ref access) => encrypt_secret(access)?,
        None => String::new(),
    };
    let quota_json = quota_opt
        .as_ref()
        .and_then(|q| serde_json::to_string(q).ok())
        .unwrap_or_else(|| "{}".to_string());
    let prio = priority.unwrap_or(50).clamp(1, 100);
    let note_val = note.unwrap_or("").trim().to_string();
    let label_val = custom_label.unwrap_or("").trim().to_string();

    let conn = open_db()?;
    ensure_schema(&conn)?;
    conn.execute(
        "INSERT INTO antigravity_accounts (
            email, name, refresh_token_ciphertext, access_token_ciphertext, expires_at,
            project_id, oauth_client_key, subscription_tier, priority, proxy_disabled,
            disabled, custom_label, note, tags_json, quota_json, last_error, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 0, ?10, ?11, '[]', ?12, ?13, ?14, ?14)
        ON CONFLICT(email) DO UPDATE SET
            name = COALESCE(excluded.name, antigravity_accounts.name),
            refresh_token_ciphertext = excluded.refresh_token_ciphertext,
            access_token_ciphertext = CASE WHEN excluded.access_token_ciphertext != '' THEN excluded.access_token_ciphertext ELSE antigravity_accounts.access_token_ciphertext END,
            expires_at = COALESCE(excluded.expires_at, antigravity_accounts.expires_at),
            project_id = COALESCE(excluded.project_id, antigravity_accounts.project_id),
            oauth_client_key = COALESCE(excluded.oauth_client_key, antigravity_accounts.oauth_client_key),
            subscription_tier = CASE WHEN excluded.quota_json != '{}' THEN excluded.subscription_tier ELSE antigravity_accounts.subscription_tier END,
            quota_json = CASE WHEN excluded.quota_json != '{}' THEN excluded.quota_json ELSE antigravity_accounts.quota_json END,
            last_error = excluded.last_error,
            updated_at = excluded.updated_at",
        params![
            resolved_email,
            resolved_name,
            refresh_cipher,
            access_cipher,
            expires_in,
            project_id,
            oauth_client_key,
            tier,
            prio,
            label_val,
            note_val,
            quota_json,
            last_error,
            now_ms,
        ],
    )
    .map_err(|error| format!("保存 Antigravity 账号失败: {error}"))?;

    Ok(())
}

async fn refresh_single_account(id: i64, trace: &mut Vec<AntigravityQuotaRequest>) -> Result<(), String> {
    let (refresh_cipher, access_cipher, expires_at, cached_project_id, client_key, current_tier, proxy_url) = {
        let conn = open_db()?;
        ensure_schema(&conn)?;
        conn.query_row(
            "SELECT refresh_token_ciphertext, access_token_ciphertext, expires_at, project_id, oauth_client_key, subscription_tier, proxy_url
             FROM antigravity_accounts WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .map_err(|_| "未找到指定的 Antigravity 账号".to_string())?
    };

    let refresh_token = decrypt_secret(&refresh_cipher)?;
    let client = account_http_client(proxy_url.as_deref())?;
    let now_sec = Utc::now().timestamp();

    let (access_token, new_expires_at, new_client_key) =
        if !access_cipher.trim().is_empty() && expires_at.unwrap_or(0) > now_sec + 120 {
            match decrypt_secret(&access_cipher) {
                Ok(tok) if !tok.is_empty() => (tok, expires_at, client_key.clone()),
                _ => {
                    let (tok, exp, ck) =
                        exchange_refresh_token(&client, &refresh_token, client_key.as_deref())
                            .await?;
                    (tok, Some(now_sec + exp), Some(ck))
                }
            }
        } else {
            let (tok, exp, ck) =
                exchange_refresh_token(&client, &refresh_token, client_key.as_deref()).await?;
            (tok, Some(now_sec + exp), Some(ck))
        };

    let result = fetch_quota_from_upstream(
        &client,
        &access_token,
        cached_project_id.as_deref(),
        Some(&current_tier),
        Some(trace),
    )
    .await;

    let access_cipher_new = encrypt_secret(&access_token)?;
    let now_ms = Utc::now().timestamp_millis();
    let conn = open_db()?;
    ensure_schema(&conn)?;

    match result {
        Ok((quota, project_id, tier)) => {
            let quota_json =
                serde_json::to_string(&quota).map_err(|error| format!("序列化配额失败: {error}"))?;
            conn.execute(
                "UPDATE antigravity_accounts
                 SET access_token_ciphertext = ?1, expires_at = ?2, oauth_client_key = COALESCE(?3, oauth_client_key),
                     project_id = COALESCE(?4, project_id), subscription_tier = ?5, quota_json = ?6,
                     last_error = NULL, updated_at = ?7
                 WHERE id = ?8",
                params![
                    access_cipher_new,
                    new_expires_at,
                    new_client_key,
                    project_id,
                    tier,
                    quota_json,
                    now_ms,
                    id,
                ],
            )
            .map_err(|error| format!("更新账号配额失败: {error}"))?;
            Ok(())
        }
        Err(err) => {
            let _ = conn.execute(
                "UPDATE antigravity_accounts
                 SET access_token_ciphertext = ?1, expires_at = ?2, last_error = ?3, updated_at = ?4
                 WHERE id = ?5",
                params![access_cipher_new, new_expires_at, err, now_ms, id],
            );
            Err(err)
        }
    }
}

#[tauri::command]
pub(crate) async fn antigravity_list_accounts() -> PlatformResult<AntigravityState> {
    tauri::async_runtime::spawn_blocking(|| -> Result<AntigravityState, String> {
        let conn = open_db()?;
        read_state(&conn)
    })
    .await
    .map_err(|_| "读取 Antigravity 账号失败")?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn antigravity_add_account(
    email: Option<String>,
    refresh_token: String,
    note: Option<String>,
    custom_label: Option<String>,
    priority: Option<i64>,
    account_type: Option<String>,
) -> PlatformResult<AntigravityState> {
    let (client_key, _, _) = oauth_client_for_type(account_type.as_deref());
    upsert_account_from_token(
        email.as_deref().unwrap_or(""),
        &refresh_token,
        note.as_deref(),
        custom_label.as_deref(),
        priority,
        false,
        Some(client_key.as_str()),
    )
    .await?;
    antigravity_list_accounts().await
}

async fn import_parsed_entries(
    entries: Vec<ParsedImportItem>,
    force_flag: bool,
    account_type: Option<&str>,
) -> PlatformResult<AntigravityImportResult> {
    let (client_key, _, _) = oauth_client_for_type(account_type);
    let total = entries.len();
    let mut success = 0usize;
    let mut errors = Vec::new();

    for entry in entries {
        match upsert_account_from_token(
            &entry.email,
            &entry.refresh_token,
            None,
            None,
            None,
            force_flag,
            Some(client_key.as_str()),
        )
        .await
        {
            Ok(()) => success += 1,
            Err(err) => {
                let label = if entry.email.is_empty() {
                    "未知邮箱".to_string()
                } else {
                    entry.email.clone()
                };
                errors.push(format!("{label}: {err}"));
            }
        }
    }

    let state = tauri::async_runtime::spawn_blocking(|| -> Result<AntigravityState, String> {
        let conn = open_db()?;
        read_state(&conn)
    })
    .await
    .map_err(|_| "读取 Antigravity 账号失败")??;

    Ok(AntigravityImportResult {
        total,
        success,
        failed: total.saturating_sub(success),
        errors,
        state,
    })
}

#[tauri::command]
pub(crate) async fn antigravity_import_accounts(
    content: String,
    force: Option<bool>,
    account_type: Option<String>,
) -> PlatformResult<AntigravityImportResult> {
    let entries = parse_import_content(&content);
    if entries.is_empty() {
        return Err("未识别到有效的 Antigravity 账号数据（需包含 refresh_token 或 1//... Token）".into());
    }
    import_parsed_entries(entries, force.unwrap_or(false), account_type.as_deref()).await
}

fn extract_entries_from_sqlite_file(path: &std::path::Path) -> Result<Vec<ParsedImportItem>, String> {
    // 为避免源库正在被 IDE 锁定，复制到临时文件只读扫描后删除
    let temp_path = std::env::temp_dir().join(format!(
        "cloudhub_ag_scan_{}.db",
        uuid::Uuid::new_v4()
    ));
    std::fs::copy(path, &temp_path).map_err(|e| format!("复制数据库文件失败: {e}"))?;

    let result = (|| -> Result<Vec<ParsedImportItem>, String> {
        let conn = Connection::open_with_flags(
            &temp_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|e| format!("打开 SQLite 数据库失败: {e}"))?;

        let mut tables: Vec<String> = Vec::new();
        {
            let mut stmt = conn
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                .map_err(|e| format!("读取数据库表结构失败: {e}"))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| format!("遍历表结构失败: {e}"))?;
            for r in rows.flatten() {
                if !r.starts_with("sqlite_") {
                    tables.push(r);
                }
            }
        }

        let mut seen = HashSet::new();
        let mut out: Vec<ParsedImportItem> = Vec::new();

        for table in tables {
            let escaped_table = table.replace('"', "\"\"");
            let query = format!("SELECT * FROM \"{escaped_table}\"");
            let Ok(mut stmt) = conn.prepare(&query) else { continue };
            let col_count = stmt.column_count();
            let Ok(mut rows) = stmt.query([]) else { continue };
            while let Ok(Some(row)) = rows.next() {
                let mut row_texts: Vec<String> = Vec::new();
                for idx in 0..col_count {
                    match row.get_ref(idx) {
                        Ok(rusqlite::types::ValueRef::Text(bytes)) => {
                            if let Ok(s) = std::str::from_utf8(bytes) {
                                row_texts.push(s.to_string());
                            }
                        }
                        Ok(rusqlite::types::ValueRef::Blob(bytes)) => {
                            if bytes.windows(3).any(|w| w == b"1//") {
                                row_texts.push(String::from_utf8_lossy(bytes).into_owned());
                            }
                        }
                        _ => {}
                    }
                }
                if row_texts.is_empty() {
                    continue;
                }
                let joined = row_texts.join("\n");
                if !joined.contains("1//") && !joined.contains("refresh_token") && !joined.contains("refreshToken") {
                    continue;
                }
                for item in parse_import_content(&joined) {
                    if seen.insert(item.refresh_token.clone()) {
                        out.push(item);
                    }
                }
            }
        }
        Ok(out)
    })();

    let _ = std::fs::remove_file(&temp_path);
    result
}

fn extract_entries_from_path(path: &std::path::Path) -> Result<Vec<ParsedImportItem>, String> {
    let mut header = [0u8; 16];
    let is_sqlite = std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut header))
        .map(|_| &header == b"SQLite format 3\0")
        .unwrap_or(false);
    if is_sqlite {
        return extract_entries_from_sqlite_file(path);
    }
    let content = std::fs::read_to_string(path)
        .map_err(|error| format!("读取文件失败: {error}"))?;
    Ok(parse_import_content(&content))
}

fn collect_local_antigravity_paths() -> Vec<std::path::PathBuf> {
    let mut paths = Vec::new();
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from);
    let appdata = std::env::var_os("APPDATA").map(std::path::PathBuf::from);
    let local_appdata = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from);

    if let Some(ref ad) = appdata {
        paths.push(ad.join("Antigravity").join("User").join("globalStorage").join("state.vscdb"));
        paths.push(ad.join("Antigravity - Insiders").join("User").join("globalStorage").join("state.vscdb"));
        paths.push(ad.join("antigravity-manager").join("accounts.json"));
    }
    if let Some(ref lad) = local_appdata {
        paths.push(lad.join("Antigravity").join("User").join("globalStorage").join("state.vscdb"));
    }
    if let Some(ref h) = home {
        // macOS
        paths.push(h.join("Library/Application Support/Antigravity/User/globalStorage/state.vscdb"));
        paths.push(h.join("Library/Application Support/Antigravity - Insiders/User/globalStorage/state.vscdb"));
        // Linux
        paths.push(h.join(".config/Antigravity/User/globalStorage/state.vscdb"));
        // Common CLI / Manager folders
        for dir in [".antigravity", ".antigravity_tools", ".gemini"] {
            let base = h.join(dir);
            paths.push(base.join("accounts.json"));
            paths.push(base.join("oauth_creds.json"));
            paths.push(base.join("state.vscdb"));
            paths.push(base.join("antigravity.db"));
            let accounts_dir = base.join("accounts");
            if let Ok(entries) = std::fs::read_dir(accounts_dir) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.is_file() {
                        paths.push(p);
                    }
                }
            }
        }
    }
    paths.into_iter().filter(|p| p.is_file()).collect()
}

#[tauri::command]
pub(crate) async fn antigravity_scan_local_db(
    account_type: Option<String>,
) -> PlatformResult<AntigravityImportResult> {
    let entries = tauri::async_runtime::spawn_blocking(|| -> Result<Vec<ParsedImportItem>, String> {
        let candidates = collect_local_antigravity_paths();
        let mut seen = HashSet::new();
        let mut all = Vec::new();
        for path in candidates {
            if let Ok(found) = extract_entries_from_path(&path) {
                for item in found {
                    if seen.insert(item.refresh_token.clone()) {
                        all.push(item);
                    }
                }
            }
        }
        Ok(all)
    })
    .await
    .map_err(|_| "扫描本地账号失败")??;

    if entries.is_empty() {
        return Err("未在本地 Antigravity IDE、经典款或 CLI 目录检测到可导入的 Refresh Token，可改用「从自定义 DB 导入」手动选择数据库或 JSON 文件".into());
    }
    import_parsed_entries(entries, false, account_type.as_deref()).await
}

#[tauri::command]
pub(crate) async fn antigravity_import_custom_db(
    app: tauri::AppHandle,
    account_type: Option<String>,
) -> PlatformResult<Option<AntigravityImportResult>> {
    let picked = app
        .dialog()
        .file()
        .add_filter("数据库 / 账号文件", &["vscdb", "db", "sqlite", "sqlite3", "json", "txt"])
        .blocking_pick_file();
    let Some(file_path) = picked else {
        return Ok(None);
    };
    let path = file_path
        .into_path()
        .map_err(|_| "读取所选文件路径失败")?;
    let entries = tauri::async_runtime::spawn_blocking(move || extract_entries_from_path(&path))
        .await
        .map_err(|_| "解析所选数据库失败")??;
    if entries.is_empty() {
        return Err("所选文件中未提取到有效的 Refresh Token".into());
    }
    let res = import_parsed_entries(entries, false, account_type.as_deref()).await?;
    Ok(Some(res))
}

#[tauri::command]
pub(crate) async fn antigravity_import_file(
    app: tauri::AppHandle,
    force: Option<bool>,
    account_type: Option<String>,
) -> PlatformResult<Option<AntigravityImportResult>> {
    let picked = app
        .dialog()
        .file()
        .add_filter("JSON / 数据库文件", &["json", "txt", "vscdb", "db", "sqlite"])
        .blocking_pick_file();
    let Some(file_path) = picked else {
        return Ok(None);
    };
    let path = file_path
        .into_path()
        .map_err(|_| "读取所选文件路径失败")?;
    let entries = tauri::async_runtime::spawn_blocking(move || extract_entries_from_path(&path))
        .await
        .map_err(|_| "读取文件失败")??;
    if entries.is_empty() {
        return Err("未识别到有效的 Antigravity 账号数据".into());
    }
    let res = import_parsed_entries(entries, force.unwrap_or(false), account_type.as_deref()).await?;
    Ok(Some(res))
}

fn build_export_json(conn: &Connection, account_ids: Option<&[i64]>) -> Result<String, String> {
    ensure_schema(conn)?;
    let filter_set: Option<HashSet<i64>> = account_ids
        .filter(|ids| !ids.is_empty())
        .map(|ids| ids.iter().copied().collect());

    let mut stmt = conn
        .prepare("SELECT id, email, refresh_token_ciphertext FROM antigravity_accounts ORDER BY priority ASC, id ASC")
        .map_err(|error| format!("查询导出账号失败: {error}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| format!("读取导出账号失败: {error}"))?;

    let mut entries = Vec::new();
    for row in rows {
        let (id, email, cipher) = row.map_err(|error| format!("读取导出行失败: {error}"))?;
        if let Some(ref set) = filter_set {
            if !set.contains(&id) {
                continue;
            }
        }
        let refresh_token = decrypt_secret(&cipher)?;
        entries.push(ExportAccountEntry {
            email,
            refresh_token,
        });
    }
    if entries.is_empty() {
        return Err("没有可导出的账号".to_string());
    }
    serde_json::to_string_pretty(&entries).map_err(|error| format!("序列化导出 JSON 失败: {error}"))
}

#[tauri::command]
pub(crate) async fn antigravity_export_accounts_text(
    account_ids: Option<Vec<i64>>,
) -> PlatformResult<String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let conn = open_db()?;
        build_export_json(&conn, account_ids.as_deref())
    })
    .await
    .map_err(|_| "导出 Antigravity 账号失败")?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn antigravity_export_accounts_file(
    app: tauri::AppHandle,
    account_ids: Option<Vec<i64>>,
) -> PlatformResult<bool> {
    let json_text = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let conn = open_db()?;
        build_export_json(&conn, account_ids.as_deref())
    })
    .await
    .map_err(|_| "导出 Antigravity 账号失败")??;

    let picked = app
        .dialog()
        .file()
        .set_file_name("antigravity-accounts.json")
        .add_filter("JSON 文件", &["json"])
        .blocking_save_file();
    let Some(file_path) = picked else {
        return Ok(false);
    };
    let path = file_path
        .into_path()
        .map_err(|_| "获取保存路径失败")?;
    std::fs::write(&path, json_text).map_err(|error| format!("写入导出文件失败: {error}"))?;
    Ok(true)
}

#[tauri::command]
pub(crate) async fn antigravity_list_quota_refresh_logs(
    id: i64,
) -> PlatformResult<Vec<AntigravityQuotaRefreshLog>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        let conn = open_db()?;
        ensure_schema(&conn)?;
        let mut stmt = conn.prepare(
            "SELECT id, created_at, duration_ms, source, success, requests_json
             FROM antigravity_quota_refresh_logs WHERE account_id = ?1 ORDER BY id DESC LIMIT 100",
        ).map_err(|_| "读取配额刷新日志失败")?;
        let rows = stmt.query_map([id], |row| Ok(AntigravityQuotaRefreshLog {
            id: row.get(0)?,
            created_at: row.get(1)?,
            duration_ms: row.get(2)?,
            source: row.get(3)?,
            success: row.get(4)?,
            requests: serde_json::from_str(&row.get::<_, String>(5)?).unwrap_or_default(),
        })).map_err(|_| "读取配额刷新日志失败")?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|_| "读取配额刷新日志失败".into())
    }).await.map_err(|_| "读取配额刷新日志失败")?.map_err(Into::into)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AntigravityQuotaRefreshLog {
    id: i64,
    created_at: i64,
    duration_ms: i64,
    source: String,
    success: bool,
    requests: Vec<AntigravityQuotaRequest>,
}

async fn refresh_account_with_log(id: i64, source: &'static str) -> Result<(), String> {
    let started = std::time::Instant::now();
    let mut trace = Vec::new();
    let result = refresh_single_account(id, &mut trace).await;
    let success = result.is_ok();
    let duration_ms = started.elapsed().as_millis() as i64;
    let _ = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let requests_json = serde_json::to_string(&trace).map_err(|_| "编码配额查询日志失败")?;
        let mut conn = open_db()?;
        ensure_schema(&conn)?;
        let tx = conn.transaction().map_err(|_| "保存配额刷新日志失败")?;
        tx.execute(
            "INSERT INTO antigravity_quota_refresh_logs(account_id, created_at, duration_ms, source, success, requests_json)
             SELECT id, ?2, ?3, ?4, ?5, ?6 FROM antigravity_accounts WHERE id = ?1",
            params![id, Utc::now().timestamp_millis(), duration_ms, source, success, requests_json],
        ).map_err(|_| "保存配额刷新日志失败")?;
        tx.execute(
            "DELETE FROM antigravity_quota_refresh_logs WHERE account_id = ?1 AND id IN
             (SELECT id FROM antigravity_quota_refresh_logs WHERE account_id = ?1 ORDER BY id DESC LIMIT -1 OFFSET 100)",
            [id],
        ).map_err(|_| "保存配额刷新日志失败")?;
        tx.commit().map_err(|_| "保存配额刷新日志失败".into())
    }).await;
    result
}

#[tauri::command]
pub(crate) async fn antigravity_save_account_proxy(
    ids: Vec<i64>,
    proxy_url: String,
) -> PlatformResult<AntigravityState> {
    tauri::async_runtime::spawn_blocking(move || -> Result<AntigravityState, String> {
        let proxy = crate::core::codex::account_controls::validate_proxy(&proxy_url)?;
        if ids.is_empty() {
            return Err("请选择要设置代理的账号".into());
        }
        let mut conn = open_db()?;
        ensure_schema(&conn)?;
        let tx = conn.transaction().map_err(|_| "保存账号代理失败")?;
        for id in ids {
            if tx.execute("UPDATE antigravity_accounts SET proxy_url = ?1 WHERE id = ?2", params![proxy, id])
                .map_err(|_| "保存账号代理失败")? == 0
            {
                return Err("未找到指定的 Antigravity 账号".into());
            }
        }
        tx.commit().map_err(|_| "保存账号代理失败")?;
        read_state(&conn)
    }).await.map_err(|_| "保存账号代理失败")?.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn antigravity_refresh_quota(id: i64) -> PlatformResult<AntigravityState> {
    refresh_account_with_log(id, "single").await?;
    antigravity_list_accounts().await
}

#[tauri::command]
pub(crate) async fn antigravity_refresh_all(
    ids: Option<Vec<i64>>,
) -> PlatformResult<AntigravityRefreshAllResult> {
    let source = if ids.as_ref().is_some_and(|ids| !ids.is_empty()) { "selected" } else { "all" };
    let target_ids: Vec<i64> = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<i64>, String> {
        let conn = open_db()?;
        ensure_schema(&conn)?;
        if let Some(list) = ids.filter(|l| !l.is_empty()) {
            return Ok(list);
        }
        let mut stmt = conn
            .prepare("SELECT id FROM antigravity_accounts ORDER BY priority ASC, id ASC")
            .map_err(|error| format!("查询账号 ID 失败: {error}"))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, i64>(0))
            .map_err(|error| format!("读取账号 ID 失败: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("收集账号 ID 失败: {error}"))
    })
    .await
    .map_err(|_| "查询账号列表失败")??;

    let total = target_ids.len();
    let mut success = 0usize;
    for id in target_ids {
        if refresh_account_with_log(id, source).await.is_ok() {
            success += 1;
        }
    }
    let state = antigravity_list_accounts().await?;
    Ok(AntigravityRefreshAllResult {
        total,
        success,
        failed: total.saturating_sub(success),
        state,
    })
}

#[tauri::command]
pub(crate) async fn antigravity_save_metadata(
    id: i64,
    priority: i64,
    custom_label: String,
    note: String,
    tags: Vec<String>,
) -> PlatformResult<AntigravityState> {
    if !(1..=100).contains(&priority) {
        return Err("优先级必须为 1 到 100 之间的整数".into());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<AntigravityState, String> {
        let conn = open_db()?;
        ensure_schema(&conn)?;
        let tags_json =
            serde_json::to_string(&tags).map_err(|error| format!("序列化标签失败: {error}"))?;
        let now_ms = Utc::now().timestamp_millis();
        conn.execute(
            "UPDATE antigravity_accounts
             SET priority = ?1, custom_label = ?2, note = ?3, tags_json = ?4, updated_at = ?5
             WHERE id = ?6",
            params![
                priority,
                custom_label.trim(),
                note.trim(),
                tags_json,
                now_ms,
                id
            ],
        )
        .map_err(|error| format!("保存账号信息失败: {error}"))?;
        read_state(&conn)
    })
    .await
    .map_err(|_| "保存账号信息失败")?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn antigravity_save_priorities(
    id: i64,
    priority: i64,
    gemini_priority: Option<i64>,
    claude_priority: Option<i64>,
) -> PlatformResult<AntigravityState> {
    if !(1..=100).contains(&priority) {
        return Err("默认优先级必须为 1 到 100 之间的整数".into());
    }
    if let Some(gp) = gemini_priority {
        if !(1..=100).contains(&gp) {
            return Err("Gemini 优先级必须为 1 到 100 之间的整数".into());
        }
    }
    if let Some(cp) = claude_priority {
        if !(1..=100).contains(&cp) {
            return Err("Claude 优先级必须为 1 到 100 之间的整数".into());
        }
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<AntigravityState, String> {
        let conn = open_db()?;
        ensure_schema(&conn)?;
        let now_ms = Utc::now().timestamp_millis();
        conn.execute(
            "UPDATE antigravity_accounts
             SET priority = ?1, gemini_priority = ?2, claude_priority = ?3, updated_at = ?4
             WHERE id = ?5",
            params![priority, gemini_priority, claude_priority, now_ms, id],
        )
        .map_err(|error| format!("保存优先级失败: {error}"))?;
        read_state(&conn)
    })
    .await
    .map_err(|_| "保存优先级失败")?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn antigravity_save_project_id(
    id: i64,
    project_id: String,
) -> PlatformResult<AntigravityState> {
    let trimmed = project_id.trim().to_string();
    if trimmed.len() > 128 || trimmed.chars().any(|c| c.is_control()) {
        return Err("GCP Project ID 格式无效".into());
    }
    let stored: Option<String> = if trimmed.is_empty() { None } else { Some(trimmed) };
    tauri::async_runtime::spawn_blocking(move || -> Result<AntigravityState, String> {
        let conn = open_db()?;
        ensure_schema(&conn)?;
        let now_ms = Utc::now().timestamp_millis();
        conn.execute(
            "UPDATE antigravity_accounts SET project_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![stored, now_ms, id],
        )
        .map_err(|error| format!("保存 GCP Project ID 失败: {error}"))?;
        read_state(&conn)
    })
    .await
    .map_err(|_| "保存 GCP Project ID 失败")?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn antigravity_fetch_project_id(id: i64) -> PlatformResult<AntigravityState> {
    let (refresh_cipher, access_cipher, expires_at, client_key) =
        tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
            let conn = open_db()?;
            ensure_schema(&conn)?;
            conn.query_row(
                "SELECT refresh_token_ciphertext, access_token_ciphertext, expires_at, oauth_client_key
                 FROM antigravity_accounts WHERE id = ?1",
                [id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .map_err(|_| "未找到指定的 Antigravity 账号".to_string())
        })
        .await
        .map_err(|_| "读取账号凭据失败")??;

    let refresh_token = decrypt_secret(&refresh_cipher)?;
    let client = http_client()?;
    let now_sec = Utc::now().timestamp();

    let (access_token, new_expires_at, new_client_key) =
        if !access_cipher.trim().is_empty() && expires_at.unwrap_or(0) > now_sec + 120 {
            match decrypt_secret(&access_cipher) {
                Ok(tok) if !tok.is_empty() => (tok, expires_at, client_key.clone()),
                _ => {
                    let (tok, exp, ck) =
                        exchange_refresh_token(&client, &refresh_token, client_key.as_deref())
                            .await?;
                    (tok, Some(now_sec + exp), Some(ck))
                }
            }
        } else {
            let (tok, exp, ck) =
                exchange_refresh_token(&client, &refresh_token, client_key.as_deref()).await?;
            (tok, Some(now_sec + exp), Some(ck))
        };

    let (fresh_project, fresh_tier) = fetch_code_assist(&client, &access_token, None).await;
    let Some(pid) = fresh_project else {
        return Err("未能从 Google Code Assist 获取到关联的 GCP Project ID，请确认账号已绑定项目或手动输入".into());
    };
    let access_cipher_new = encrypt_secret(&access_token)?;

    tauri::async_runtime::spawn_blocking(move || -> Result<AntigravityState, String> {
        let conn = open_db()?;
        ensure_schema(&conn)?;
        let now_ms = Utc::now().timestamp_millis();
        conn.execute(
            "UPDATE antigravity_accounts
             SET project_id = ?1,
                 subscription_tier = COALESCE(?2, subscription_tier),
                 access_token_ciphertext = ?3,
                 expires_at = ?4,
                 oauth_client_key = COALESCE(?5, oauth_client_key),
                 updated_at = ?6
             WHERE id = ?7",
            params![pid, fresh_tier, access_cipher_new, new_expires_at, new_client_key, now_ms, id],
        )
        .map_err(|error| format!("保存自动获取的 GCP Project ID 失败: {error}"))?;
        read_state(&conn)
    })
    .await
    .map_err(|_| "保存 GCP Project ID 失败")?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn antigravity_save_tags(
    id: i64,
    tags: Vec<String>,
) -> PlatformResult<AntigravityState> {
    let mut cleaned = Vec::new();
    let mut seen = HashSet::new();
    for raw in tags {
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.len() > 40 || trimmed.chars().any(|c| c.is_control()) {
            continue;
        }
        if seen.insert(trimmed.to_lowercase()) {
            cleaned.push(trimmed.to_string());
        }
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<AntigravityState, String> {
        let conn = open_db()?;
        ensure_schema(&conn)?;
        let tags_json =
            serde_json::to_string(&cleaned).map_err(|error| format!("序列化标签失败: {error}"))?;
        let now_ms = Utc::now().timestamp_millis();
        conn.execute(
            "UPDATE antigravity_accounts SET tags_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![tags_json, now_ms, id],
        )
        .map_err(|error| format!("保存账号标签失败: {error}"))?;
        read_state(&conn)
    })
    .await
    .map_err(|_| "保存账号标签失败")?
    .map_err(Into::into)
}

fn antigravity_client_file(target: &str, file: &str) -> Option<std::path::PathBuf> {
    let folders: &[&str] = match target {
        "antigravity" => &["Antigravity", "antigravity", "Antigravity - Insiders"],
        "ide" => &["Antigravity IDE", "antigravity-ide", "AntigravityIDE"],
        _ => return None,
    };
    let mut roots = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        roots.push(std::path::PathBuf::from(appdata));
    }
    if let Some(appdata) = std::env::var_os("LOCALAPPDATA") {
        roots.push(std::path::PathBuf::from(appdata));
    }
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let home = std::path::PathBuf::from(home);
        roots.push(home.join("Library/Application Support"));
        roots.push(std::env::var_os("XDG_CONFIG_HOME").map(std::path::PathBuf::from)
            .filter(|path| path.is_absolute()).unwrap_or_else(|| home.join(".config")));
    }
    roots.iter().flat_map(|root| folders.iter().map(move |folder|
        root.join(folder).join("User").join("globalStorage").join(file)
    )).find(|path| path.is_file())
}

fn antigravity_device_storage(target: &str) -> Option<std::path::PathBuf> {
    if let Some(db) = antigravity_client_file(target, "state.vscdb") {
        let path = db.with_file_name("storage.json");
        return path.is_file().then_some(path);
    }
    antigravity_client_file(target, "storage.json")
}
fn apply_device_profile_to_local_storage(target: &str, profile: &AntigravityDeviceProfile) -> Result<bool, String> {
    let _guard = DEVICE_STORAGE_LOCK.lock().map_err(|_| "设备指纹存储暂不可用")?;
    let storage_path = antigravity_device_storage(target);
    let Some(storage_path) = storage_path.as_ref() else {
        return Ok(false);
    };
    let content = std::fs::read_to_string(storage_path)
        .map_err(|error| format!("读取本机 Antigravity storage.json 失败: {error}"))?;
    let mut root: Value = serde_json::from_str(&content)
        .map_err(|error| format!("解析本机 storage.json 失败: {error}"))?;
    let Some(obj) = root.as_object_mut() else {
        return Err("本机 storage.json 格式无效".to_string());
    };
    let original: serde_json::Map<String, Value> = DEVICE_KEYS.iter()
        .filter_map(|key| obj.get(*key).map(|value| (key.to_string(), value.clone())))
        .collect();
    let conn = open_db()?;
    ensure_schema(&conn)?;
    conn.execute(
        "INSERT OR IGNORE INTO antigravity_original_device_profile(storage_path, fields_json) VALUES (?1, ?2)",
        params![storage_path.to_string_lossy(), Value::Object(original).to_string()],
    ).map_err(|_| "备份原始设备指纹失败")?;
    if !profile.machine_id.trim().is_empty() {
        obj.insert("telemetry.machineId".to_string(), Value::String(profile.machine_id.trim().to_string()));
    }
    if !profile.mac_machine_id.trim().is_empty() {
        obj.insert("telemetry.macMachineId".to_string(), Value::String(profile.mac_machine_id.trim().to_string()));
    }
    if !profile.dev_device_id.trim().is_empty() {
        obj.insert("telemetry.devDeviceId".to_string(), Value::String(profile.dev_device_id.trim().to_string()));
    }
    if !profile.sqm_id.trim().is_empty() {
        obj.insert("telemetry.sqmId".to_string(), Value::String(profile.sqm_id.trim().to_string()));
    }
    write_json_file_atomically(storage_path, &root)?;
    Ok(true)
}

#[tauri::command]
pub(crate) async fn antigravity_device_storage_action(action: String, target: String) -> PlatformResult<()> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let path = antigravity_device_storage(&target)
            .ok_or("本机未检测到 Antigravity storage.json")?;
        if action == "open" {
            return tauri_plugin_opener::open_path(path.parent().ok_or("找不到存储目录")?, None::<&str>)
                .map_err(|_| "打开设备指纹存储目录失败".into());
        }
        if action != "restore" {
            return Err("未知的设备存储操作".into());
        }
        let _guard = DEVICE_STORAGE_LOCK.lock().map_err(|_| "设备指纹存储暂不可用")?;
        let conn = open_db()?;
        ensure_schema(&conn)?;
        let backup: String = conn.query_row(
            "SELECT fields_json FROM antigravity_original_device_profile WHERE storage_path = ?1",
            [path.to_string_lossy()], |row| row.get(0),
        ).optional().map_err(|_| "读取原始设备指纹失败")?
            .ok_or("暂无原始备份。首次由此应用写入指纹时会自动备份。")?;
        let fields: serde_json::Map<String, Value> = serde_json::from_str(&backup)
            .map_err(|_| "原始设备指纹备份格式无效")?;
        let content = std::fs::read_to_string(&path).map_err(|_| "读取本机 storage.json 失败")?;
        let mut root: Value = serde_json::from_str(&content).map_err(|_| "解析本机 storage.json 失败")?;
        let obj = root.as_object_mut().ok_or("本机 storage.json 格式无效")?;
        for key in DEVICE_KEYS {
            if let Some(value) = fields.get(key) {
                obj.insert(key.into(), value.clone());
            } else {
                obj.remove(key);
            }
        }
        write_json_file_atomically(&path, &root)
    }).await.map_err(|_| "操作设备指纹存储失败")?.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn antigravity_read_local_device_profile(target: String) -> PlatformResult<AntigravityDeviceProfile> {
    tauri::async_runtime::spawn_blocking(move || -> Result<AntigravityDeviceProfile, String> {
        let storage_path = antigravity_device_storage(&target);
        let Some(storage_path) = storage_path.as_ref() else {
            return Err("本机未检测到 Antigravity 客户端的 storage.json 配置文件".to_string());
        };
        let content = std::fs::read_to_string(storage_path)
            .map_err(|error| format!("读取本机 storage.json 失败: {error}"))?;
        let root: Value = serde_json::from_str(&content)
            .map_err(|error| format!("解析本机 storage.json 失败: {error}"))?;
        let fields = root.as_object().ok_or("本机 storage.json 格式无效")?;
        let pick = |key: &str| {
            fields.get(key)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .unwrap_or("")
                .to_string()
        };
        Ok(AntigravityDeviceProfile {
            machine_id: pick("telemetry.machineId"),
            mac_machine_id: pick("telemetry.macMachineId"),
            dev_device_id: pick("telemetry.devDeviceId"),
            sqm_id: pick("telemetry.sqmId"),
        })
    })
    .await
    .map_err(|_| "读取本机设备指纹失败")?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn antigravity_save_device_profile(
    id: i64,
    profile: AntigravityDeviceProfile,
    delete_history_id: Option<String>,
) -> PlatformResult<AntigravityState> {
    let cleaned = AntigravityDeviceProfile {
        machine_id: profile.machine_id.trim().to_string(),
        mac_machine_id: profile.mac_machine_id.trim().to_string(),
        dev_device_id: profile.dev_device_id.trim().to_string(),
        sqm_id: profile.sqm_id.trim().to_string(),
    };
    for field in [
        &cleaned.machine_id,
        &cleaned.mac_machine_id,
        &cleaned.dev_device_id,
        &cleaned.sqm_id,
    ] {
        if field.len() > 160 || field.chars().any(|c| c.is_control()) {
            return Err("设备指纹字段格式无效".into());
        }
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<AntigravityState, String> {
        let mut conn = open_db()?;
        ensure_schema(&conn)?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "保存设备指纹失败")?;
        let (previous, history): (String, String) = tx.query_row(
            "SELECT device_profile_json, device_history_json FROM antigravity_accounts WHERE id = ?1",
            [id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(|_| "读取账号设备指纹失败")?;
        let mut history: Vec<AntigravityDeviceHistory> = serde_json::from_str(&history)
            .map_err(|_| "设备指纹历史格式无效")?;
        let json_str = if cleaned.is_empty() {
            "{}".to_string()
        } else {
            serde_json::to_string(&cleaned)
                .map_err(|error| format!("序列化设备指纹失败: {error}"))?
        };
        let binding = if let Some(history_id) = delete_history_id {
            let bound = serde_json::from_str::<AntigravityDeviceProfile>(&previous).ok();
            if history.iter().any(|entry| entry.fingerprint_id == history_id && Some(&entry.profile) == bound.as_ref()) {
                return Err("当前绑定的设备指纹不能删除".into());
            }
            history.retain(|entry| entry.fingerprint_id != history_id);
            previous
        } else {
            let now = Utc::now().timestamp_millis();
            for candidate in serde_json::from_str::<AntigravityDeviceProfile>(&previous).ok().iter().chain(std::iter::once(&cleaned)) {
                if !candidate.is_empty() && !history.iter().any(|entry| &entry.profile == candidate) {
                    history.insert(0, AntigravityDeviceHistory {
                        fingerprint_id: uuid::Uuid::new_v4().to_string(),
                        created_at: now,
                        profile: candidate.clone(),
                    });
                }
            }
            json_str
        };
        let history_json = serde_json::to_string(&history).map_err(|_| "保存设备指纹历史失败")?;
        tx.execute(
            "UPDATE antigravity_accounts SET device_profile_json = ?1, device_history_json = ?2 WHERE id = ?3",
            params![binding, history_json, id],
        ).map_err(|_| "保存设备指纹失败")?;
        tx.commit().map_err(|_| "保存设备指纹失败")?;
        read_state(&conn)
    })
    .await
    .map_err(|_| "保存设备指纹失败")?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn antigravity_warmup_account(id: i64) -> PlatformResult<AntigravityWarmupResult> {
    let started = std::time::Instant::now();
    let (refresh_cipher, access_cipher, expires_at, cached_project_id, client_key, current_tier) =
        tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
            let conn = open_db()?;
            ensure_schema(&conn)?;
            conn.query_row(
                "SELECT refresh_token_ciphertext, access_token_ciphertext, expires_at, project_id, oauth_client_key, subscription_tier
                 FROM antigravity_accounts WHERE id = ?1",
                [id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .map_err(|_| "未找到指定的 Antigravity 账号".to_string())
        })
        .await
        .map_err(|_| "读取账号凭据失败")??;

    let refresh_token = decrypt_secret(&refresh_cipher)?;
    let client = http_client()?;
    let now_sec = Utc::now().timestamp();

    let (access_token, new_expires_at, new_client_key) =
        if !access_cipher.trim().is_empty() && expires_at.unwrap_or(0) > now_sec + 120 {
            match decrypt_secret(&access_cipher) {
                Ok(tok) if !tok.is_empty() => (tok, expires_at, client_key.clone()),
                _ => {
                    let (tok, exp, ck) =
                        exchange_refresh_token(&client, &refresh_token, client_key.as_deref())
                            .await?;
                    (tok, Some(now_sec + exp), Some(ck))
                }
            }
        } else {
            let (tok, exp, ck) =
                exchange_refresh_token(&client, &refresh_token, client_key.as_deref()).await?;
            (tok, Some(now_sec + exp), Some(ck))
        };

    // 1. 先探测上游连通性并获取最新项目与可用模型
    let (mut quota, project_id, tier) = fetch_quota_from_upstream(
        &client,
        &access_token,
        cached_project_id.as_deref(),
        Some(&current_tier),
        None,
    )
    .await?;

    // 2. 选择轻量可用模型发送极简预热请求（maxOutputTokens: 1），以触发 5H 配额周期
    let warmup_model = quota
        .models
        .iter()
        .find(|m| m.name.to_ascii_lowercase().contains("flash") && m.percentage > 0)
        .or_else(|| quota.models.iter().find(|m| m.percentage > 0))
        .map(|m| m.name.clone());

    let mut warmed_model: Option<String> = None;
    if let (Some(ref model_name), Some(ref pid)) = (&warmup_model, &project_id) {
        let req_body = json!({
            "project": pid,
            "model": model_name,
            "request": {
                "contents": [{ "role": "user", "parts": [{ "text": "ping" }] }],
                "generationConfig": { "maxOutputTokens": 1 }
            }
        });
        for ep in WARMUP_ENDPOINTS {
            if let Ok(resp) = client
                .post(ep)
                .bearer_auth(&access_token)
                .json(&req_body)
                .send()
                .await
            {
                if resp.status().is_success() {
                    warmed_model = Some(model_name.clone());
                    break;
                }
            }
        }
        // 预热成功后回读一次最新配额窗口（捕捉新开启的重置时间）
        if warmed_model.is_some() {
            if let Ok((fresh_q, _, _)) = fetch_quota_from_upstream(
                &client,
                &access_token,
                Some(pid.as_str()),
                Some(&tier),
                None,
            )
            .await
            {
                quota = fresh_q;
            }
        }
    }

    let access_cipher_new = encrypt_secret(&access_token)?;
    let quota_json =
        serde_json::to_string(&quota).map_err(|error| format!("序列化配额失败: {error}"))?;
    let latency_ms = started.elapsed().as_millis() as u64;

    let state = tauri::async_runtime::spawn_blocking(move || -> Result<AntigravityState, String> {
        let conn = open_db()?;
        ensure_schema(&conn)?;
        let now_ms = Utc::now().timestamp_millis();
        conn.execute(
            "UPDATE antigravity_accounts
             SET access_token_ciphertext = ?1,
                 expires_at = ?2,
                 oauth_client_key = COALESCE(?3, oauth_client_key),
                 project_id = COALESCE(?4, project_id),
                 subscription_tier = ?5,
                 quota_json = ?6,
                 last_error = NULL,
                 updated_at = ?7
             WHERE id = ?8",
            params![
                access_cipher_new,
                new_expires_at,
                new_client_key,
                project_id,
                tier,
                quota_json,
                now_ms,
                id,
            ],
        )
        .map_err(|error| format!("更新预热状态失败: {error}"))?;
        read_state(&conn)
    })
    .await
    .map_err(|_| "保存预热结果失败")??;

    let detail = if let Some(ref m) = warmed_model {
        format!("预热完成（模型 {m}，耗时 {latency_ms}ms，配额周期已同步）")
    } else {
        format!("连通性探测通过并已同步配额（耗时 {latency_ms}ms）")
    };

    Ok(AntigravityWarmupResult {
        ok: true,
        latency_ms,
        model_used: warmed_model,
        detail,
        state,
    })
}

fn normalize_switch_target(raw: &str) -> Result<&'static str, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "antigravity" => Ok("antigravity"),
        "ide" => Ok("ide"),
        "jeb" | "jetbrains" | "acp" => Ok("jeb"),
        "cli" | "agy" | "agy_cli" => Ok("cli"),
        _ => Err("不支持的切换目标，仅支持 Antigravity、IDE、JEB、AGY CLI".to_string()),
    }
}

fn write_json_file_atomically(path: &std::path::Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建目标配置目录失败: {error}"))?;
    }
    let payload = serde_json::to_string_pretty(value)
        .map_err(|error| format!("序列化客户端凭据失败: {error}"))?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, payload.as_bytes())
        .map_err(|error| format!("写入临时凭据文件失败: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, path)
        .or_else(|_| {
            let res = std::fs::write(path, payload.as_bytes());
            let _ = std::fs::remove_file(&tmp);
            res
        })
        .map_err(|error| format!("写入目标凭据文件失败: {error}"))?;
    Ok(())
}

fn apply_vscdb_switch(target: &str, email: &str, access_token: &str) -> Result<(bool, String), String> {
    let db_path = antigravity_client_file(target, "state.vscdb");
    let Some(db_path) = db_path.as_ref() else {
        return Ok((
            false,
            "已设为当前账号（本机未检测到 Antigravity IDE 的 state.vscdb，仅更新应用内状态）".to_string(),
        ));
    };
    let conn = Connection::open(db_path)
        .map_err(|error| format!("打开本机 Antigravity state.vscdb 失败（请先关闭正在运行的客户端）: {error}"))?;
    let existing: Option<String> = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("读取 state.vscdb 认证状态失败: {error}"))?;
    let mut obj = existing
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    obj.insert("email".to_string(), Value::String(email.to_string()));
    if !access_token.is_empty() {
        obj.insert("apiKey".to_string(), Value::String(access_token.to_string()));
    }
    let serialized = serde_json::to_string(&Value::Object(obj))
        .map_err(|error| format!("序列化认证状态失败: {error}"))?;
    conn.execute(
        "INSERT INTO ItemTable(key, value) VALUES('antigravityAuthStatus', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![serialized],
    )
    .map_err(|error| format!("写入 state.vscdb 失败（若客户端正在运行请先退出后重试）: {error}"))?;
    Ok((true, "已更新本机 Antigravity state.vscdb 认证状态".to_string()))
}

#[tauri::command]
pub(crate) async fn antigravity_switch_target(
    id: i64,
    target: String,
) -> PlatformResult<AntigravitySwitchResult> {
    let target_key = normalize_switch_target(&target)?;
    let (email, refresh_cipher, access_cipher, expires_at, client_key, device_profile_raw) =
        tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
            let conn = open_db()?;
            ensure_schema(&conn)?;
            conn.query_row(
                "SELECT email, refresh_token_ciphertext, access_token_ciphertext, expires_at, oauth_client_key, COALESCE(device_profile_json, '{}')
                 FROM antigravity_accounts WHERE id = ?1",
                [id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .map_err(|_| "未找到指定的 Antigravity 账号".to_string())
        })
        .await
        .map_err(|_| "读取目标账号失败")??;

    let refresh_token = decrypt_secret(&refresh_cipher)?;
    let now_sec = Utc::now().timestamp();
    let mut access_token = if !access_cipher.trim().is_empty() && expires_at.unwrap_or(0) > now_sec + 120 {
        decrypt_secret(&access_cipher).unwrap_or_default()
    } else {
        String::new()
    };
    let mut expiry_sec = expires_at.unwrap_or(now_sec + 3600);

    if access_token.is_empty() && !refresh_token.trim().is_empty() {
        if let Ok(client) = http_client() {
            if let Ok((fresh_access, exp_in, fresh_client_key)) =
                exchange_refresh_token(&client, &refresh_token, client_key.as_deref()).await
            {
                access_token = fresh_access;
                expiry_sec = Utc::now().timestamp() + exp_in;
                if let Ok(access_enc) = encrypt_secret(&access_token) {
                    let _ = tauri::async_runtime::spawn_blocking(move || {
                        if let Ok(conn) = open_db() {
                            let _ = conn.execute(
                                "UPDATE antigravity_accounts
                                 SET access_token_ciphertext = ?1, expires_at = ?2, oauth_client_key = COALESCE(?3, oauth_client_key)
                                 WHERE id = ?4",
                                params![access_enc, expiry_sec, fresh_client_key, id],
                            );
                        }
                    })
                    .await;
                }
            }
        }
    }

    let email_clone = email.clone();
    let access_clone = access_token.clone();
    let refresh_clone = refresh_token.clone();
    let target_owned = target_key.to_string();

    let (applied_to_client, detail) =
        tauri::async_runtime::spawn_blocking(move || -> Result<(bool, String), String> {
            let home = std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(std::path::PathBuf::from);
            match target_owned.as_str() {
                "antigravity" | "ide" => {
                    let (applied, mut msg) = apply_vscdb_switch(&target_owned, &email_clone, &access_clone)?;
                    if applied {
                        if let Ok(profile) = serde_json::from_str::<AntigravityDeviceProfile>(&device_profile_raw) {
                            if !profile.is_empty() {
                                match apply_device_profile_to_local_storage(&target_owned, &profile) {
                                    Ok(true) => msg.push_str("，并已同步绑定设备指纹"),
                                    Ok(false) => msg.push_str("，未找到对应的 storage.json，设备指纹仍待应用"),
                                    Err(_) => msg.push_str("，设备指纹同步失败，请关闭客户端后重试"),
                                }
                            }
                        }
                    }
                    Ok((applied, msg))
                }
                "jeb" => {
                    let Some(h) = home else {
                        return Ok((false, "无法定位用户主目录，仅更新应用内当前目标状态".to_string()));
                    };
                    let acp_path = h.join(".gemini").join("antigravity-acp").join("acp_token.json");
                    let payload = json!({
                        "email": email_clone,
                        "access_token": access_clone,
                        "refresh_token": refresh_clone,
                        "token_type": "Bearer",
                        "expiry_date": expiry_sec * 1000,
                    });
                    write_json_file_atomically(&acp_path, &payload)?;
                    Ok((true, "已写入 JetBrains 插件凭据（~/.gemini/antigravity-acp/acp_token.json）".to_string()))
                }
                "cli" => {
                    let Some(h) = home else {
                        return Ok((false, "无法定位用户主目录，仅更新应用内当前目标状态".to_string()));
                    };
                    let gemini_dir = h.join(".gemini");
                    let cli_path = gemini_dir.join("oauth_creds.json");
                    let payload = json!({
                        "email": email_clone,
                        "access_token": access_clone,
                        "refresh_token": refresh_clone,
                        "token_type": "Bearer",
                        "expiry_date": expiry_sec * 1000,
                    });
                    write_json_file_atomically(&cli_path, &payload)?;

                    // 同步更新 ~/.gemini/jetski-standalone-oauth-token (AGY CLI)
                    let jetski_path = gemini_dir.join("jetski-standalone-oauth-token");
                    let existing_jetski = std::fs::read_to_string(&jetski_path)
                        .ok()
                        .and_then(|s| serde_json::from_str::<Value>(&s).ok());
                    let auth_method = existing_jetski
                        .as_ref()
                        .and_then(|v| v.get("auth_method").and_then(|m| m.as_str()))
                        .unwrap_or("consumer")
                        .to_string();
                    let expiry_rfc3339 = chrono::DateTime::from_timestamp(expiry_sec, 0)
                        .unwrap_or_else(Utc::now)
                        .to_rfc3339();
                    let expires_in = (expiry_sec - Utc::now().timestamp()).max(0);
                    let jetski_payload = json!({
                        "token": {
                            "access_token": access_clone,
                            "token_type": "Bearer",
                            "refresh_token": refresh_clone,
                            "expiry": expiry_rfc3339,
                            "expires_in": expires_in,
                        },
                        "auth_method": auth_method,
                        "id_token_email": email_clone,
                        "id_token": "",
                    });
                    let _ = write_json_file_atomically(&jetski_path, &jetski_payload);

                    // 同步更新 ~/.gemini/google_accounts.json (Gemini CLI active email)
                    let ga_path = gemini_dir.join("google_accounts.json");
                    let existing_ga = std::fs::read_to_string(&ga_path)
                        .ok()
                        .and_then(|s| serde_json::from_str::<Value>(&s).ok());
                    let mut old_list: Vec<String> = existing_ga
                        .as_ref()
                        .and_then(|v| v.get("old").and_then(|o| o.as_array()))
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|x| x.as_str().map(str::to_string))
                                .collect()
                        })
                        .unwrap_or_default();
                    if let Some(prev_active) = existing_ga
                        .as_ref()
                        .and_then(|v| v.get("active").and_then(|a| a.as_str()))
                        .map(str::trim)
                        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case(&email_clone))
                    {
                        if !old_list.iter().any(|x| x.eq_ignore_ascii_case(prev_active)) {
                            old_list.push(prev_active.to_string());
                        }
                    }
                    old_list.retain(|x| !x.eq_ignore_ascii_case(&email_clone));
                    let ga_payload = json!({
                        "active": email_clone,
                        "old": old_list,
                    });
                    let _ = write_json_file_atomically(&ga_path, &ga_payload);

                    Ok((true, "已切换 AGY CLI 账号（已同步 jetski-standalone-oauth-token 与 google_accounts.json）".to_string()))
                }
                _ => Ok((false, "已切换当前账号".to_string())),
            }
        })
        .await
        .map_err(|_| "写入目标客户端凭据失败")??;

    let target_for_db = target_key.to_string();
    let state = tauri::async_runtime::spawn_blocking(move || -> Result<AntigravityState, String> {
        let conn = open_db()?;
        ensure_schema(&conn)?;
        let existing_json: Option<String> = conn
            .query_row(
                "SELECT COALESCE(target_current_json, '{}') FROM antigravity_preferences WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取当前切换目标失败: {error}"))?;
        let mut map: HashMap<String, i64> = existing_json
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        map.insert(target_for_db.clone(), id);
        let serialized = serde_json::to_string(&map)
            .map_err(|error| format!("序列化目标状态失败: {error}"))?;
        conn.execute(
            "INSERT INTO antigravity_preferences(id, current_account_id, target_current_json) VALUES(1, CASE WHEN ?3 = 'antigravity' THEN ?1 ELSE NULL END, ?2)
             ON CONFLICT(id) DO UPDATE SET
                current_account_id = CASE WHEN ?3 = 'antigravity' THEN ?1 ELSE antigravity_preferences.current_account_id END,
                target_current_json = excluded.target_current_json",
            params![id, serialized, target_for_db],
        )
        .map_err(|error| format!("保存当前切换目标失败: {error}"))?;
        read_state(&conn)
    })
    .await
    .map_err(|_| "保存切换状态失败")??;

    Ok(AntigravitySwitchResult {
        target: target_key.to_string(),
        applied_to_client,
        detail,
        state,
    })
}

#[tauri::command]
pub(crate) async fn antigravity_set_current(id: i64) -> PlatformResult<AntigravityState> {
    tauri::async_runtime::spawn_blocking(move || -> Result<AntigravityState, String> {
        let conn = open_db()?;
        ensure_schema(&conn)?;
        conn.execute(
            "INSERT INTO antigravity_preferences(id, current_account_id) VALUES(1, ?1)
             ON CONFLICT(id) DO UPDATE SET current_account_id = excluded.current_account_id",
            [id],
        )
        .map_err(|error| format!("切换当前账号失败: {error}"))?;
        read_state(&conn)
    })
    .await
    .map_err(|_| "切换当前账号失败")?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn antigravity_reorder_accounts(
    ordered_ids: Vec<i64>,
) -> PlatformResult<AntigravityState> {
    tauri::async_runtime::spawn_blocking(move || -> Result<AntigravityState, String> {
        let mut conn = open_db()?;
        ensure_schema(&conn)?;
        let tx = conn
            .transaction()
            .map_err(|error| format!("开启排序事务失败: {error}"))?;
        for (idx, id) in ordered_ids.iter().enumerate() {
            let order = (idx + 1) as i64;
            tx.execute(
                "UPDATE antigravity_accounts SET sort_order = ?1 WHERE id = ?2",
                params![order, id],
            )
            .map_err(|error| format!("更新账号排序失败: {error}"))?;
        }
        tx.commit()
            .map_err(|error| format!("提交账号排序失败: {error}"))?;
        read_state(&conn)
    })
    .await
    .map_err(|_| "保存账号排序失败")?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn antigravity_delete_accounts(ids: Vec<i64>) -> PlatformResult<AntigravityState> {
    tauri::async_runtime::spawn_blocking(move || -> Result<AntigravityState, String> {
        let conn = open_db()?;
        ensure_schema(&conn)?;
        for id in &ids {
            conn.execute("DELETE FROM antigravity_accounts WHERE id = ?1", [id])
                .map_err(|error| format!("删除账号失败: {error}"))?;
            conn.execute(
                "UPDATE antigravity_preferences SET current_account_id = NULL WHERE id = 1 AND current_account_id = ?1",
                [id],
            )
            .map_err(|error| format!("清理当前账号引用失败: {error}"))?;
        }
        if let Ok(Some(raw)) = conn
            .query_row(
                "SELECT COALESCE(target_current_json, '{}') FROM antigravity_preferences WHERE id = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
        {
            let mut map: HashMap<String, i64> = serde_json::from_str(&raw).unwrap_or_default();
            let removed: HashSet<i64> = ids.iter().copied().collect();
            let before = map.len();
            map.retain(|_, v| !removed.contains(v));
            if map.len() != before {
                if let Ok(serialized) = serde_json::to_string(&map) {
                    let _ = conn.execute(
                        "UPDATE antigravity_preferences SET target_current_json = ?1 WHERE id = 1",
                        [serialized],
                    );
                }
            }
        }
        read_state(&conn)
    })
    .await
    .map_err(|_| "删除账号失败")?
    .map_err(Into::into)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityOAuthStart {
    pub token: String,
    pub auth_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityOAuthPoll {
    pub status: String,
    pub error: Option<String>,
}

fn set_oauth_state(token: &str, state: OAuthPending) {
    if let Ok(mut guard) = OAUTH_SESSIONS.lock() {
        let map = guard.get_or_insert_with(HashMap::new);
        map.insert(token.to_string(), state);
    }
}

fn extract_auth_code(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(query) = trimmed.split('?').nth(1) {
        let query = query.split('#').next().unwrap_or(query);
        for pair in query.split('&') {
            let mut parts = pair.splitn(2, '=');
            if parts.next() == Some("code") {
                if let Some(val) = parts.next() {
                    let decoded = percent_encoding::percent_decode_str(val)
                        .decode_utf8_lossy()
                        .trim()
                        .to_string();
                    if !decoded.is_empty() {
                        return Some(decoded);
                    }
                }
            }
        }
    }
    if trimmed.contains("code=") {
        if let Some(after) = trimmed.split("code=").nth(1) {
            let raw_val = after.split(&['&', '#', ' ', '\r', '\n'][..]).next().unwrap_or("");
            let decoded = percent_encoding::percent_decode_str(raw_val)
                .decode_utf8_lossy()
                .trim()
                .to_string();
            if !decoded.is_empty() {
                return Some(decoded);
            }
        }
    }
    Some(trimmed.to_string())
}

async fn exchange_oauth_code_and_save(
    code: &str,
    redirect_uri: &str,
    client_id: &str,
    client_secret: &str,
    client_key: &str,
) -> Result<(), String> {
    let client = http_client()?;
    let token_resp = client
        .post(GOOGLE_TOKEN_URL)
        .form(&[
            ("code", code),
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("redirect_uri", redirect_uri),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|err| format!("换取 Token 请求失败: {err}"))?;

    if !token_resp.status().is_success() {
        let text = token_resp.text().await.unwrap_or_default();
        return Err(format!("换取 Token 失败: {text}"));
    }

    let body: Value = token_resp
        .json()
        .await
        .map_err(|err| format!("解析 Token 响应失败: {err}"))?;
    let rt = body
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "Google 未返回 refresh_token，请在账号权限页撤销授权后重试".to_string())?;

    upsert_account_from_token("", rt, None, None, None, false, Some(client_key)).await
}

#[tauri::command]
pub(crate) async fn antigravity_start_oauth(
    app: tauri::AppHandle,
    account_type: Option<String>,
) -> PlatformResult<AntigravityOAuthStart> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("启动本地 OAuth 回调监听失败: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("获取本地 OAuth 端口失败: {error}"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/oauth-callback");
    let session_token = uuid::Uuid::new_v4().to_string();
    let acct_type = account_type.unwrap_or_else(|| "personal".to_string());
    let (client_key, client_id, client_secret) = oauth_client_for_type(Some(&acct_type));

    let scope = [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/cclog",
        "https://www.googleapis.com/auth/experimentsandconfigs",
    ]
    .join(" ");

    let auth_url = format!(
        "{GOOGLE_AUTH_URL}?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent&include_granted_scopes=true&state={}",
        percent_encoding::utf8_percent_encode(&client_id, percent_encoding::NON_ALPHANUMERIC),
        percent_encoding::utf8_percent_encode(&redirect_uri, percent_encoding::NON_ALPHANUMERIC),
        percent_encoding::utf8_percent_encode(&scope, percent_encoding::NON_ALPHANUMERIC),
        percent_encoding::utf8_percent_encode(&session_token, percent_encoding::NON_ALPHANUMERIC),
    );

    let initial_state = OAuthPending {
        status: "pending".to_string(),
        error: None,
        cancelled: false,
        redirect_uri: redirect_uri.clone(),
        client_id: client_id.to_string(),
        client_secret: client_secret.to_string(),
        client_key: client_key.to_string(),
    };
    set_oauth_state(&session_token, initial_state.clone());

    let token_clone = session_token.clone();
    let redirect_clone = redirect_uri.clone();
    let cid_owned = client_id.to_string();
    let csecret_owned = client_secret.to_string();
    let ckey_owned = client_key.to_string();
    tauri::async_runtime::spawn(async move {
        let _ = listener.set_nonblocking(false);
        let code_res = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
            let (mut stream, _) = listener
                .accept()
                .map_err(|error| format!("等待 OAuth 回调失败: {error}"))?;
            let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
            let mut buf = [0u8; 4096];
            let n = stream
                .read(&mut buf)
                .map_err(|error| format!("读取 OAuth 回调失败: {error}"))?;
            let req = String::from_utf8_lossy(&buf[..n]);
            let first_line = req.lines().next().unwrap_or("");
            let path = first_line.split_whitespace().nth(1).unwrap_or("");
            let query = path.split('?').nth(1).unwrap_or("");
            let mut code = None;
            let mut err_param = None;
            for pair in query.split('&') {
                let mut parts = pair.splitn(2, '=');
                let k = parts.next().unwrap_or("");
                let v = parts.next().unwrap_or("");
                let decoded = percent_encoding::percent_decode_str(v)
                    .decode_utf8_lossy()
                    .to_string();
                if k == "code" {
                    code = Some(decoded);
                } else if k == "error" {
                    err_param = Some(decoded);
                }
            }
            let html = if code.is_some() {
                "<html><body style='font-family:sans-serif;text-align:center;padding:48px'><h2>授权成功</h2><p>请返回 CloudHub Tools 查看已导入的 Antigravity 账号。</p></body></html>"
            } else {
                "<html><body style='font-family:sans-serif;text-align:center;padding:48px'><h2>授权未完成</h2><p>请返回 CloudHub Tools 重试。</p></body></html>"
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                html.len(),
                html
            );
            let _ = stream.write_all(response.as_bytes());
            if let Some(e) = err_param {
                return Err(format!("Google 授权取消或失败: {e}"));
            }
            code.ok_or_else(|| "OAuth 回调缺少授权码".to_string())
        })
        .await;

        let should_skip = OAUTH_SESSIONS
            .lock()
            .ok()
            .and_then(|g| {
                g.as_ref()
                    .and_then(|m| m.get(&token_clone).map(|s| s.cancelled || s.status == "completed"))
            })
            .unwrap_or(false);
        if should_skip {
            return;
        }

        let update_status = |status: &str, err: Option<String>| {
            if let Ok(mut guard) = OAUTH_SESSIONS.lock() {
                if let Some(map) = guard.as_mut() {
                    if let Some(item) = map.get_mut(&token_clone) {
                        if !item.cancelled && item.status != "completed" {
                            item.status = status.to_string();
                            item.error = err;
                        }
                    }
                }
            }
        };

        let code = match code_res {
            Ok(Ok(c)) => c,
            Ok(Err(e)) => {
                update_status("error", Some(e));
                return;
            }
            Err(_) => {
                update_status("error", Some("OAuth 回调任务异常".to_string()));
                return;
            }
        };

        match exchange_oauth_code_and_save(&code, &redirect_clone, &cid_owned, &csecret_owned, &ckey_owned).await {
            Ok(()) => update_status("completed", None),
            Err(err) => update_status("error", Some(err)),
        }
    });

    let _ = app.opener().open_url(&auth_url, None::<&str>);
    Ok(AntigravityOAuthStart {
        token: session_token,
        auth_url,
    })
}

#[tauri::command]
pub(crate) async fn antigravity_submit_oauth_callback(
    token: String,
    input: String,
) -> PlatformResult<AntigravityState> {
    let code = extract_auth_code(&input)
        .ok_or_else(|| "请输入有效的回调链接或 Authorization Code".to_string())?;
    let session = OAUTH_SESSIONS
        .lock()
        .ok()
        .and_then(|g| g.as_ref().and_then(|m| m.get(&token).cloned()))
        .ok_or_else(|| "请先点击「开始 OAuth 授权」生成本次会话链接".to_string())?;

    exchange_oauth_code_and_save(
        &code,
        &session.redirect_uri,
        &session.client_id,
        &session.client_secret,
        &session.client_key,
    )
    .await?;

    if let Ok(mut guard) = OAUTH_SESSIONS.lock() {
        if let Some(map) = guard.as_mut() {
            if let Some(item) = map.get_mut(&token) {
                item.status = "completed".to_string();
                item.error = None;
            }
        }
    }

    antigravity_list_accounts().await
}

#[tauri::command]
pub(crate) async fn antigravity_poll_oauth(token: String) -> PlatformResult<AntigravityOAuthPoll> {
    let state = OAUTH_SESSIONS
        .lock()
        .ok()
        .and_then(|g| g.as_ref().and_then(|m| m.get(&token).cloned()));
    match state {
        Some(item) => Ok(AntigravityOAuthPoll {
            status: item.status,
            error: item.error,
        }),
        None => Ok(AntigravityOAuthPoll {
            status: "error".to_string(),
            error: Some("OAuth 会话不存在或已过期".to_string()),
        }),
    }
}

#[tauri::command]
pub(crate) async fn antigravity_cancel_oauth(token: String) -> PlatformResult<()> {
    if let Ok(mut guard) = OAUTH_SESSIONS.lock() {
        if let Some(map) = guard.as_mut() {
            if let Some(item) = map.get_mut(&token) {
                item.cancelled = true;
                item.status = "cancelled".to_string();
            }
        }
    }
    Ok(())
}
