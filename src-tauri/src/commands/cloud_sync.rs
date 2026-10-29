use crate::core::{
    crypto::{decrypt_secret, encrypt_secret},
    error::PlatformResult,
    storage::open_db,
};
use reqwest::Method;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::Manager;
use zeroize::{Zeroize, Zeroizing};

#[path = "cloud_sync_transport.rs"]
mod transport;
pub(super) const CONFIG_KEY: &str = "cloud.sync.config";
static OPERATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static STATUS: OnceLock<Mutex<SyncStatus>> = OnceLock::new();

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Config {
    pub method: String,
    pub provider: String,
    pub endpoint: String,
    pub username: String,
    pub password: String,
    pub access_key_id: String,
    pub secret_key: String,
    pub bucket: String,
    pub region: String,
    pub path_style: bool,
    pub remote_root: String,
    pub profile: String,
    pub auto_sync: bool,
    pub allow_insecure: bool,
    pub password_protected: bool,
    pub backup_password: String,
    pub last_etag: Option<String>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            method: "webdav".into(),
            provider: "custom".into(),
            endpoint: String::new(),
            username: String::new(),
            password: String::new(),
            access_key_id: String::new(),
            secret_key: String::new(),
            bucket: String::new(),
            region: "us-east-1".into(),
            path_style: true,
            remote_root: "cloudhub-sync".into(),
            profile: "default".into(),
            auto_sync: false,
            allow_insecure: false,
            password_protected: false,
            backup_password: String::new(),
            last_etag: None,
        }
    }
}
impl Drop for Config {
    fn drop(&mut self) {
        self.password.zeroize();
        self.secret_key.zeroize();
        self.backup_password.zeroize();
    }
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncStatus {
    busy: bool,
    progress: Option<TransferProgress>,
    last_upload: Option<String>,
    last_download: Option<String>,
    error: Option<String>,
    paused: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferProgress {
    phase: String,
    transferred: u64,
    total: Option<u64>,
}

pub(super) fn progress(phase: &str, transferred: u64, total: Option<u64>) {
    if let Ok(mut state) = status().lock() {
        state.progress = Some(TransferProgress {
            phase: phase.into(),
            transferred,
            total,
        });
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncView {
    config: serde_json::Value,
    configured: bool,
    status: SyncStatus,
}

fn status() -> &'static Mutex<SyncStatus> {
    STATUS.get_or_init(|| Mutex::new(SyncStatus::default()))
}
fn view(config: &Config, configured: bool) -> Result<SyncView, String> {
    Ok(SyncView {
        configured,
        status: status().lock().map_err(|_| "同步状态不可用")?.clone(),
        config: serde_json::json!({
            "method": config.method, "provider": config.provider, "endpoint": config.endpoint, "username": config.username,
            "accessKeyId": config.access_key_id, "bucket": config.bucket, "region": config.region, "pathStyle": config.path_style,
            "remoteRoot": config.remote_root, "profile": config.profile, "autoSync": config.auto_sync, "allowInsecure": config.allow_insecure,
            "passwordProtected": config.password_protected, "hasPassword": !config.password.is_empty(), "hasSecretKey": !config.secret_key.is_empty(),
            "hasBackupPassword": !config.backup_password.is_empty(),
        }),
    })
}

fn load() -> Result<Option<Config>, String> {
    let connection = open_db()?;
    let saved: Option<String> = connection
        .query_row(
            "SELECT value FROM client_preferences WHERE key=?1",
            [CONFIG_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "读取云同步配置失败")?;
    saved
        .map(|ciphertext| {
            let text = Zeroizing::new(
                decrypt_secret(&ciphertext).map_err(|_| "云同步配置无法解密，请重新配置")?,
            );
            serde_json::from_str(&text).map_err(|_| "云同步配置格式无效".into())
        })
        .transpose()
}
fn persist(config: &Config) -> Result<(), String> {
    let serialized =
        Zeroizing::new(serde_json::to_string(config).map_err(|_| "生成云同步配置失败")?);
    let encrypted = encrypt_secret(&serialized)?;
    crate::core::repositories::preferences::save(
        &open_db()?,
        CONFIG_KEY,
        &encrypted,
        chrono::Utc::now().timestamp_millis(),
    )
    .map_err(|_| "保存云同步配置失败".into())
}

fn safe_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value != "."
        && value != ".."
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_ .".contains(c))
        && value.trim() == value
}
fn validate(config: &Config) -> Result<(), String> {
    if !["webdav", "s3"].contains(&config.method.as_str())
        || !["custom", "jianguoyun", "nextcloud", "alist"].contains(&config.provider.as_str())
    {
        return Err("同步方式或服务商无效".into());
    }
    if config.endpoint.len() > 2048 {
        return Err("服务地址过长".into());
    }
    transport::base(config)?;
    if config.remote_root.len() > 240
        || !config.remote_root.split('/').all(safe_segment)
        || !safe_segment(&config.profile)
    {
        return Err(
            "根目录和配置名仅支持英文、数字、空格、横线和下划线；目录不能包含路径跳转".into(),
        );
    }
    if [
        &config.username,
        &config.access_key_id,
        &config.region,
        &config.bucket,
    ]
    .iter()
    .any(|v| v.len() > 256 || v.chars().any(char::is_control))
    {
        return Err("云同步配置字段无效".into());
    }
    if config.method == "webdav" {
        if config.username.trim().is_empty()
            || config.username.contains(':')
            || config.password.is_empty()
            || config.password.len() > 4096
        {
            return Err("请填写 WebDAV 账号与应用密码".into());
        }
    } else if config.access_key_id.trim().is_empty()
        || config.secret_key.is_empty()
        || config.secret_key.len() > 4096
        || config.bucket.len() < 3
        || !config
            .bucket
            .bytes()
            .all(|v| v.is_ascii_lowercase() || v.is_ascii_digit() || v == b'-' || v == b'.')
        || config.region.is_empty()
        || !config
            .region
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || v == b'-')
    {
        return Err("请填写有效的 S3 存储桶、区域、Access Key ID 和 Secret Access Key".into());
    }
    if config.password_protected {
        super::database_migration::validate_cloud_password(&config.backup_password)?;
    }
    Ok(())
}

fn merge_input(mut input: Config, saved: Option<&Config>) -> Result<Config, String> {
    input.endpoint = input.endpoint.trim().trim_end_matches('/').to_string();
    input.remote_root = input.remote_root.trim().to_string();
    input.profile = input.profile.trim().to_string();
    if let Some(saved) = saved {
        let same_identity = input.method == saved.method
            && input.endpoint == saved.endpoint
            && input.username == saved.username
            && input.access_key_id == saved.access_key_id;
        if same_identity {
            if input.password.is_empty() {
                input.password = saved.password.clone();
            }
            if input.secret_key.is_empty() {
                input.secret_key = saved.secret_key.clone();
            }
        }
        if input.password_protected && input.backup_password.is_empty() && saved.password_protected
        {
            input.backup_password = saved.backup_password.clone();
        }
        input.last_etag = if same_identity
            && input.remote_root == saved.remote_root
            && input.profile == saved.profile
            && input.bucket == saved.bucket
            && input.region == saved.region
            && input.path_style == saved.path_style
        {
            saved.last_etag.clone()
        } else {
            None
        };
    } else {
        input.last_etag = None;
    }
    if !input.password_protected {
        input.backup_password.zeroize();
        input.backup_password.clear();
    }
    if input.method == "webdav" {
        input.secret_key.zeroize();
        input.secret_key.clear();
    } else {
        input.password.zeroize();
        input.password.clear();
    }
    validate(&input)?;
    Ok(input)
}

fn supported() -> Result<(), String> {
    // Cloud backup operations are explicit user actions and are available on
    // mobile too. Background auto-upload remains desktop-only.
    Ok(())
}

#[tauri::command]
pub(crate) fn cloud_sync_reveal_secret(config: Config, field: String) -> PlatformResult<String> {
    supported()?;
    let saved = load()?.ok_or("尚未保存云同步配置")?;
    Ok(reveal_secret(&config, &saved, &field)?.to_string())
}

fn reveal_secret<'a>(input: &Config, saved: &'a Config, field: &str) -> Result<&'a str, String> {
    let same_identity = input.method == saved.method
        && input.endpoint.trim().trim_end_matches('/') == saved.endpoint
        && input.username == saved.username
        && input.access_key_id == saved.access_key_id;
    let secret = match field {
        "password" if same_identity && saved.method == "webdav" => &saved.password,
        "secretKey" if same_identity && saved.method == "s3" => &saved.secret_key,
        "backupPassword" if input.password_protected && saved.password_protected => &saved.backup_password,
        _ => return Err("当前配置没有可查看的已保存凭据".into()),
    };
    if secret.is_empty() {
        return Err("当前配置没有可查看的已保存凭据".into());
    }
    Ok(secret)
}

#[tauri::command]
pub(crate) fn cloud_sync_state() -> PlatformResult<SyncView> {
    supported()?;
    let config = load()?;
    Ok(view(
        config.as_ref().unwrap_or(&Config::default()),
        config.is_some(),
    )?)
}
#[tauri::command]
pub(crate) async fn cloud_sync_save(config: Config) -> PlatformResult<SyncView> {
    supported()?;
    let _guard = OPERATION
        .try_lock()
        .map_err(|_| "云同步正在执行，请稍后重试")?;
    let saved = load()?;
    let config = merge_input(config, saved.as_ref())?;
    persist(&config)?;
    {
        let mut state = status().lock().map_err(|_| "同步状态不可用")?;
        state.paused = false;
        state.error = None;
    }
    Ok(view(&config, true)?)
}
#[tauri::command]
pub(crate) async fn cloud_sync_test(config: Config) -> PlatformResult<()> {
    supported()?;
    let _guard = OPERATION
        .try_lock()
        .map_err(|_| "云同步正在执行，请稍后重试")?;
    let saved = load()?;
    let config = merge_input(config, saved.as_ref())?;
    let client = transport::client()?;
    let method = if config.method == "webdav" {
        Method::from_bytes(b"PROPFIND").map_err(|_| "请求初始化失败")?
    } else {
        Method::HEAD
    };
    let response = transport::request(
        &client,
        &config,
        method,
        transport::url(&config, false)?,
        vec![],
        None,
    )
    .await?;
    transport::check(response.status())?;
    Ok(())
}

struct Busy;
impl Busy {
    fn start() -> Result<Self, String> {
        let mut state = status().lock().map_err(|_| "同步状态不可用")?;
        state.busy = true;
        state.error = None;
        state.progress = None;
        Ok(Self)
    }
    fn finish(&self, error: Option<String>, upload: bool) {
        if let Ok(mut state) = status().lock() {
            state.error = error;
            if state.error.is_none() {
                if upload {
                    state.last_upload = Some(chrono::Utc::now().to_rfc3339());
                } else {
                    state.last_download = Some(chrono::Utc::now().to_rfc3339());
                }
            }
        }
    }
}
impl Drop for Busy {
    fn drop(&mut self) {
        if let Ok(mut state) = status().lock() {
            state.busy = false;
            state.progress = None;
        }
    }
}

async fn upload(automatic: bool) -> Result<(), String> {
    progress("connecting", 0, None);
    let mut config = load()?.ok_or("请先保存云同步配置")?;
    validate(&config)?;
    if automatic && (!config.auto_sync || status().lock().map_err(|_| "同步状态不可用")?.paused)
    {
        return Ok(());
    }
    let client = transport::client()?;
    transport::ensure_directories(&client, &config).await?;
    let (exists, current_etag) = transport::head(&client, &config).await?;
    if automatic && exists && (current_etag.is_none() || config.last_etag != current_etag) {
        return Err("云端存在其他版本，自动上传已停止；请先下载检查，或手动确认上传".into());
    }
    if exists && current_etag.is_none() {
        return Err(
            "服务未提供有效 ETag，无法安全覆盖已有备份；请更换配置名或使用支持 ETag 的服务".into(),
        );
    }
    let password = if config.password_protected {
        Some(config.backup_password.clone())
    } else {
        None
    };
    progress("preparing", 0, None);
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        super::database_migration::cloud_snapshot(password)
    })
    .await
    .map_err(|_| "创建云备份快照失败")??;
    let condition = current_etag
        .as_deref()
        .map(|tag| ("If-Match", tag))
        .unwrap_or(("If-None-Match", "*"));
    let response = transport::request(
        &client,
        &config,
        Method::PUT,
        transport::url(&config, true)?,
        bytes,
        Some(condition),
    )
    .await?;
    transport::check(response.status())?;
    progress("finishing", 0, None);
    config.last_etag = transport::etag(&response);
    // Do not fetch a newer ETag here: a second device could have replaced our upload.
    persist(&config)?;
    if let Ok(mut state) = status().lock() {
        state.paused = false;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn cloud_sync_upload() -> PlatformResult<SyncView> {
    supported()?;
    let _guard = OPERATION
        .try_lock()
        .map_err(|_| "云同步正在执行，请勿重复操作")?;
    let busy = Busy::start()?;
    let result = upload(false).await;
    busy.finish(result.as_ref().err().cloned(), true);
    result?;
    drop(busy);
    Ok(view(&load()?.ok_or("配置已失效")?, true)?)
}

#[tauri::command]
pub(crate) async fn cloud_sync_download(
    app: tauri::AppHandle,
) -> PlatformResult<super::database_migration::ImportPreview> {
    supported()?;
    let _guard = OPERATION
        .try_lock()
        .map_err(|_| "云同步正在执行，请勿重复操作")?;
    let busy = Busy::start()?;
    progress("connecting", 0, None);
    let result = async {
        let mut config = load()?.ok_or("请先保存云同步配置")?;
        validate(&config)?;
        let client = transport::client()?;
        let response = transport::request(
            &client,
            &config,
            Method::GET,
            transport::url(&config, true)?,
            vec![],
            None,
        )
        .await?;
        let tag = transport::etag(&response);
        let bytes = transport::read(response).await?;
        progress("verifying", 0, None);
        let password = if config.password_protected {
            Some(config.backup_password.clone())
        } else {
            None
        };
        config.last_etag = tag;
        // A preview may be cancelled or the app may restart before restore. Never
        // accept a remote version as the baseline for automatic local overwrite.
        config.auto_sync = false;
        persist(&config)?;
        let preview = tauri::async_runtime::spawn_blocking(move || {
            super::database_migration::prepare_cloud_snapshot(
                &bytes,
                password,
                &app.state::<super::database_migration::DatabaseImportStore>(),
            )
        })
        .await
        .map_err(|_| "准备云备份预览失败")??;
        pause_for_restore();
        Ok::<_, String>(preview)
    }
    .await;
    busy.finish(result.as_ref().err().cloned(), false);
    result.map_err(Into::into)
}

pub(super) fn pause_for_restore() {
    if let Ok(mut state) = status().lock() {
        state.paused = true;
        state.error =
            Some("数据库已恢复，自动上传已暂停；检查数据后可手动上传或重新保存配置".into());
    }
}

pub(super) fn restore_guard() -> Result<tokio::sync::MutexGuard<'static, ()>, String> {
    let guard = OPERATION
        .try_lock()
        .map_err(|_| "云同步正在执行，请完成后再恢复数据库")?;
    pause_for_restore();
    Ok(guard)
}

fn fingerprint(connection: &Connection) -> Result<String, String> {
    let mut hash = Sha256::new();
    // Ignore logs, cache and our own status/config writes so uploads never trigger themselves.
    for &(table, _) in crate::core::data_transfer::TABLES {
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [table],
                |row| row.get(0),
            )
            .map_err(|_| "检测数据库变化失败")?;
        if !exists {
            continue;
        }
        let sql = if table == "client_preferences" {
            "SELECT * FROM client_preferences WHERE key NOT LIKE 'cloud.sync.%' ORDER BY key"
                .to_string()
        } else {
            format!("SELECT * FROM {table} ORDER BY rowid")
        };
        hash.update(table.as_bytes());
        let mut statement = connection.prepare(&sql).map_err(|_| "检测数据库变化失败")?;
        let count = statement.column_count();
        let fields = statement.column_names().iter().map(|name| name.to_string()).collect::<Vec<_>>();
        let mut rows = statement.query([]).map_err(|_| "检测数据库变化失败")?;
        while let Some(row) = rows.next().map_err(|_| "检测数据库变化失败")? {
            if table == "client_preferences" && !crate::core::data_transfer::portable_preference(&row.get::<_,String>(0).map_err(|_| "读取偏好失败")?) { continue; }
            for index in 0..count {
                use rusqlite::types::ValueRef;
                let raw = row.get::<_,rusqlite::types::Value>(index).map_err(|_| "检测数据库变化失败")?;
                let value = crate::core::data_transfer::clean_value(table, &fields[index], raw);
                match ValueRef::from(&value) {
                    ValueRef::Null => hash.update([0]),
                    ValueRef::Integer(v) => {
                        hash.update([1]);
                        hash.update(v.to_le_bytes());
                    }
                    ValueRef::Real(v) => {
                        hash.update([2]);
                        hash.update(v.to_le_bytes());
                    }
                    ValueRef::Text(v) | ValueRef::Blob(v) => {
                        hash.update([3]);
                        hash.update((v.len() as u64).to_le_bytes());
                        hash.update(v);
                    }
                }
            }
            hash.update([255]);
        }
    }
    Ok(hex::encode(hash.finalize()))
}

#[cfg(desktop)]
pub(crate) fn initialize() {
    tauri::async_runtime::spawn(async {
        let mut previous = None;
        let mut pending: Option<(Instant, Instant)> = None;
        let mut retry_after = Instant::now();
        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            let Ok(Some(config)) = load() else {
                continue;
            };
            if !config.auto_sync || status().lock().map(|state| state.paused).unwrap_or(true) {
                previous = None;
                pending = None;
                continue;
            }
            let hash = tauri::async_runtime::spawn_blocking(|| fingerprint(&open_db()?)).await;
            let Ok(Ok(hash)) = hash else {
                continue;
            };
            if previous.as_ref().is_some_and(|old| old != &hash) {
                let now = Instant::now();
                pending = Some((pending.map(|v| v.0).unwrap_or(now), now));
            }
            previous = Some(hash);
            let Some((first, last)) = pending else {
                continue;
            };
            if Instant::now() < retry_after
                || (last.elapsed() < Duration::from_secs(30)
                    && first.elapsed() < Duration::from_secs(120))
            {
                continue;
            }
            let Ok(_guard) = OPERATION.try_lock() else {
                continue;
            };
            let Ok(busy) = Busy::start() else {
                continue;
            };
            let result = upload(true).await;
            busy.finish(result.as_ref().err().cloned(), true);
            if result.is_ok() {
                pending = None;
            }
            retry_after =
                Instant::now() + Duration::from_secs(if result.is_ok() { 30 } else { 300 });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Config {
        let mut value = Config::default();
        value.endpoint = "https://storage.example/dav".into();
        value.username = "fixture-user".into();
        value.password = "fixture-password".into();
        value
    }
    #[test]
    fn reveal_requires_matching_identity_and_supported_secret_field() {
        let mut saved = fixture();
        let mut input = fixture();
        assert!(reveal_secret(&input, &saved, "password").is_ok());
        assert!(reveal_secret(&input, &saved, "secretKey").is_err());
        assert!(reveal_secret(&input, &saved, "endpoint").is_err());
        input.username = "another-fixture-user".into();
        assert!(reveal_secret(&input, &saved, "password").is_err());
        input = fixture();
        input.endpoint = "https://other.example/dav".into();
        assert!(reveal_secret(&input, &saved, "password").is_err());
        saved.password_protected = true;
        saved.backup_password = "non-sensitive-fixture".into();
        assert!(reveal_secret(&input, &saved, "backupPassword").is_err());
        input.password_protected = true;
        assert!(reveal_secret(&input, &saved, "backupPassword").is_ok());
        input = fixture();
        saved.method = "s3".into();
        saved.secret_key = "non-sensitive-fixture".into();
        input.method = "s3".into();
        assert!(reveal_secret(&input, &saved, "secretKey").is_ok());
        assert!(reveal_secret(&input, &saved, "password").is_err());
    }
    #[test]
    fn secrets_are_redacted_and_only_preserved_for_same_identity() {
        let saved = fixture();
        let mut input = fixture();
        input.password.clear();
        let merged = merge_input(input.clone(), Some(&saved)).unwrap();
        assert_eq!(merged.password, saved.password);
        let encoded = serde_json::to_string(&view(&merged, true).unwrap()).unwrap();
        assert!(!encoded.contains("fixture-password"));
        input.endpoint = "https://other.example/dav".into();
        assert!(merge_input(input, Some(&saved)).is_err());
        for path in [
            "../escape",
            "a//b",
            "/absolute",
            "a/%2e%2e",
            "a?token=fixture",
        ] {
            let mut value = fixture();
            value.remote_root = path.into();
            assert!(validate(&value).is_err());
        }
    }
    #[test]
    fn auto_fingerprint_ignores_own_configuration_but_detects_business_updates() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE client_preferences(key TEXT,value TEXT); CREATE TABLE cloud_accounts(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO cloud_accounts VALUES(1,'fixture');").unwrap();
        let before = fingerprint(&conn).unwrap();
        conn.execute(
            "INSERT INTO client_preferences VALUES(?1,?2)",
            [CONFIG_KEY, "non-secret-fixture"],
        )
        .unwrap();
        assert_eq!(fingerprint(&conn).unwrap(), before);
        conn.execute("UPDATE cloud_accounts SET name='changed'", [])
            .unwrap();
        assert_ne!(fingerprint(&conn).unwrap(), before);
    }

    #[test]
    fn fingerprint_tracks_new_business_modules_and_ignores_runtime_and_logs() {
        let conn=Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE memo_notes(id INTEGER PRIMARY KEY,body TEXT); CREATE TABLE browser_environments(id TEXT,config_json TEXT,last_opened_at INTEGER); CREATE TABLE operation_logs(message TEXT); INSERT INTO memo_notes VALUES(1,'fixture'); INSERT INTO browser_environments VALUES('fixture','{}',NULL);").unwrap();
        let before=fingerprint(&conn).unwrap();
        conn.execute_batch("INSERT INTO operation_logs VALUES('fixture'); UPDATE browser_environments SET last_opened_at=123;").unwrap();
        assert_eq!(before,fingerprint(&conn).unwrap());
        conn.execute("UPDATE memo_notes SET body='changed'",[]).unwrap();
        assert_ne!(before,fingerprint(&conn).unwrap());
    }
}
