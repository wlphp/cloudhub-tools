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
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::Manager;
use zeroize::{Zeroize, Zeroizing};

#[path = "cloud_sync_transport.rs"]
mod transport;
#[path = "cloud_sync_oss_versions.rs"]
mod oss_versions;
pub(super) const CONFIG_KEY: &str = "cloud.sync.config";
static OPERATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static STATUS: OnceLock<Mutex<SyncStatus>> = OnceLock::new();
static CHANNEL_STATUS: OnceLock<Mutex<HashMap<String, SyncStatus>>> = OnceLock::new();
static ACTIVE_CHANNEL: OnceLock<Mutex<String>> = OnceLock::new();

fn default_id() -> String { "default".into() }
fn default_name() -> String { "默认渠道".into() }

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Config {
    #[serde(default = "default_id")]
    pub id: String,
    #[serde(default = "default_name")]
    pub name: String,
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
    #[serde(default)]
    pub tables: Option<Vec<String>>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            id: default_id(),
            name: default_name(),
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
            tables: None,
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
fn channel_status(id: &str) -> Result<SyncStatus, String> {
    let active = ACTIVE_CHANNEL.get_or_init(|| Mutex::new(default_id())).lock().map_err(|_| "同步状态不可用")?;
    if *active == id { return Ok(status().lock().map_err(|_| "同步状态不可用")?.clone()); }
    Ok(CHANNEL_STATUS.get_or_init(|| Mutex::new(HashMap::new())).lock().map_err(|_| "同步状态不可用")?.get(id).cloned().unwrap_or_default())
}
fn activate(id: &str) -> Result<(), String> {
    let mut active = ACTIVE_CHANNEL.get_or_init(|| Mutex::new(default_id())).lock().map_err(|_| "同步状态不可用")?;
    let mut state = status().lock().map_err(|_| "同步状态不可用")?;
    let mut all = CHANNEL_STATUS.get_or_init(|| Mutex::new(HashMap::new())).lock().map_err(|_| "同步状态不可用")?;
    all.insert(active.clone(), state.clone());
    *state = all.get(id).cloned().unwrap_or_default();
    *active = id.into();
    Ok(())
}
fn checked_id(id: Option<&str>) -> Result<&str, String> {
    let id = id.unwrap_or("default");
    if id == "default" || uuid::Uuid::parse_str(id).is_ok_and(|v| v.to_string() == id) { Ok(id) }
    else { Err("同步渠道无效".into()) }
}
fn view(config: &Config, configured: bool) -> Result<SyncView, String> {
    Ok(SyncView {
        configured,
        status: channel_status(&config.id)?,
        config: serde_json::json!({
            "id": config.id, "name": config.name,
            "method": config.method, "provider": config.provider, "endpoint": config.endpoint, "username": config.username,
            "accessKeyId": config.access_key_id, "bucket": config.bucket, "region": config.region, "pathStyle": config.path_style,
            "remoteRoot": config.remote_root, "profile": config.profile, "autoSync": config.auto_sync, "allowInsecure": config.allow_insecure,
            "passwordProtected": config.password_protected, "hasPassword": !config.password.is_empty(), "hasSecretKey": !config.secret_key.is_empty(),
            "hasBackupPassword": !config.backup_password.is_empty(),
            "tables": config.tables,
        }),
    })
}

#[derive(Serialize, Deserialize)]
pub(super) struct ChannelConfigs { pub channels: Vec<Config> }
pub(super) fn parse_configs(text: &str) -> Result<ChannelConfigs, String> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|_| "云同步配置格式无效")?;
    if value.get("channels").is_some() {
        serde_json::from_value(value).map_err(|_| "云同步配置格式无效".into())
    } else {
        Ok(ChannelConfigs { channels: vec![serde_json::from_value(value).map_err(|_| "云同步配置格式无效")?] })
    }
}
fn load_all() -> Result<ChannelConfigs, String> {
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
            parse_configs(&text)
        })
        .transpose()
        .map(|value| value.unwrap_or(ChannelConfigs { channels: vec![] }))
}
fn load_channel(id: &str) -> Result<Option<Config>, String> {
    checked_id(Some(id))?;
    Ok(load_all()?.channels.into_iter().find(|config| config.id == id))
}
fn persist_all(configs: &ChannelConfigs) -> Result<(), String> {
    let serialized =
        Zeroizing::new(serde_json::to_string(configs).map_err(|_| "生成云同步配置失败")?);
    let encrypted = encrypt_secret(&serialized)?;
    crate::core::repositories::preferences::save(
        &open_db()?,
        CONFIG_KEY,
        &encrypted,
        chrono::Utc::now().timestamp_millis(),
    )
    .map_err(|_| "保存云同步配置失败".into())
}
fn persist(config: &Config) -> Result<(), String> {
    let mut all = load_all()?;
    if let Some(saved) = all.channels.iter_mut().find(|item| item.id == config.id) { *saved = config.clone(); }
    else {
        if all.channels.len() >= 50 { return Err("同步渠道最多可添加 50 条".into()); }
        all.channels.push(config.clone());
    }
    persist_all(&all)
}

#[tauri::command]
pub(crate) fn cloud_sync_channels() -> PlatformResult<Vec<SyncView>> {
    Ok(load_all()?.channels.iter().map(|config| view(config, true)).collect::<Result<Vec<_>, _>>()?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudSyncChannelSummary {
    id: String,
    name: String,
    method: String,
    endpoint: String,
    username: String,
    has_password: bool,
    has_secret_key: bool,
    has_backup_password: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudSyncImportStaging {
    token: String,
    channels: Vec<CloudSyncChannelSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudSyncImportSummary {
    added: usize,
    updated: usize,
    skipped: usize,
}

static IMPORT_STAGE: OnceLock<Mutex<Option<(String, Instant, Vec<Config>)>>> = OnceLock::new();

fn channel_summaries(channels: &[Config]) -> Vec<CloudSyncChannelSummary> {
    channels
        .iter()
        .map(|config| CloudSyncChannelSummary {
            id: config.id.clone(),
            name: config.name.clone(),
            method: config.method.clone(),
            endpoint: config.endpoint.clone(),
            username: config.username.clone(),
            has_password: !config.password.is_empty(),
            has_secret_key: !config.secret_key.is_empty(),
            has_backup_password: !config.backup_password.is_empty(),
        })
        .collect()
}

/// 解析导入文件并校验渠道内容；文件本身是明文，凭据只在本函数内短暂存在。
fn parse_import_channels(text: &str) -> Result<Vec<Config>, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|_| "云同步配置文件格式无效")?;
    if value.get("format").and_then(|format| format.as_str()).is_some_and(|format| format != "cloudhub-tools-cloud-sync") {
        return Err("这不是 CloudHub 导出的云同步配置文件".into());
    }
    let list: Vec<serde_json::Value> = match value.get("channels") {
        Some(serde_json::Value::Array(items)) => items.clone(),
        _ if value.as_object().is_some() => vec![value],
        _ => return Err("云同步配置文件格式无效".into()),
    };
    if list.is_empty() {
        return Err("文件中没有可导入的同步渠道".into());
    }
    if list.len() > 50 {
        return Err("一次最多导入 50 条同步渠道".into());
    }
    list.into_iter()
        .map(|item| {
            serde_json::from_value::<Config>(item)
                .map_err(|_| "云同步渠道配置无效，请使用本应用导出的配置文件".into())
        })
        .collect()
}

fn normalize_imported(config: &mut Config) {
    config.name = config.name.trim().to_string();
    config.endpoint = config.endpoint.trim().trim_end_matches('/').to_string();
    config.remote_root = config.remote_root.trim().to_string();
    config.profile = config.profile.trim().to_string();
}

const IMPORT_STAGE_TTL: Duration = Duration::from_secs(600);

#[tauri::command]
pub(crate) fn cloud_sync_export_file(
    app: tauri::AppHandle,
    channel_ids: Option<Vec<String>>,
) -> PlatformResult<Option<String>> {
    supported()?;
    use tauri_plugin_dialog::DialogExt;
    let mut channels = load_all()?.channels;
    if let Some(ids) = &channel_ids {
        if ids.is_empty() {
            return Err("请选择至少一个同步渠道".into());
        }
        channels.retain(|config| ids.iter().any(|id| id == &config.id));
        if channels.is_empty() {
            return Err("所选同步渠道不存在，请刷新列表后重试".into());
        }
    } else if channels.is_empty() {
        return Err("尚未添加同步渠道，先添加并保存后才能导出".into());
    }
    for config in &channels {
        validate(config).map_err(|error| format!("渠道“{}”配置无效：{error}", config.name))?;
    }
    // 明文导出：与明文 SQL 一致，凭据由用户自行保管；此处绝不写入日志。
    let exported = serde_json::json!({
        "format": "cloudhub-tools-cloud-sync",
        "version": 1,
        "exportedAt": chrono::Utc::now().to_rfc3339(),
        "channels": channels,
    });
    let bytes = Zeroizing::new(
        serde_json::to_vec_pretty(&exported).map_err(|_| "生成云同步导出文件失败")?,
    );
    let file = app
        .dialog()
        .file()
        .set_file_name(format!("cloudhub-cloud-sync-{}.json", chrono::Utc::now().format("%Y%m%d-%H%M%S")))
        .add_filter("CloudHub 云同步配置", &["json"])
        .blocking_save_file();
    let Some(file) = file else { return Ok(None) };
    let path = file.into_path().map_err(|_| "保存位置无效")?;
    super::database_migration::write_new_or_replace(&path, &bytes)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub(crate) fn cloud_sync_import_prepare(
    app: tauri::AppHandle,
    payload: Option<String>,
) -> PlatformResult<Option<CloudSyncImportStaging>> {
    supported()?;
    use tauri_plugin_dialog::DialogExt;
    // payload 仅浏览器预览降级使用；桌面端始终弹出文件选择框。
    let text = if let Some(payload) = payload.filter(|value| !value.trim().is_empty()) {
        Zeroizing::new(payload)
    } else {
        let Some(file) = app
            .dialog()
            .file()
            .add_filter("CloudHub 云同步配置", &["json"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = file.into_path().map_err(|_| "文件位置无效")?;
        if std::fs::metadata(&path).map_err(|_| "无法读取云同步配置文件")?.len() > 2 * 1024 * 1024 {
            return Err("云同步配置文件超过 2 MB 限制".into());
        }
        Zeroizing::new(std::fs::read_to_string(&path).map_err(|_| "无法读取云同步配置文件")?)
    };
    if text.len() > 2 * 1024 * 1024 {
        return Err("云同步配置文件超过 2 MB 限制".into());
    }
    let mut channels = parse_import_channels(&text)?;
    for config in &mut channels {
        normalize_imported(config);
        validate(config).map_err(|error| format!("渠道“{}”配置无效：{error}", config.name))?;
    }
    let token = uuid::Uuid::new_v4().to_string();
    let summaries = channel_summaries(&channels);
    let stage = IMPORT_STAGE.get_or_init(|| Mutex::new(None));
    *stage.lock().map_err(|_| "导入状态不可用")? = Some((token.clone(), Instant::now(), channels));
    Ok(Some(CloudSyncImportStaging { token, channels: summaries }))
}

/// 按渠道 id 或连接身份合并；merge 跳过已有，overwrite 覆盖内容并保留本机 id。
fn apply_import(all: &mut ChannelConfigs, staged: Vec<Config>, mode: &str) -> Result<CloudSyncImportSummary, String> {
    let mut added = 0;
    let mut updated = 0;
    let mut skipped = 0;
    for mut config in staged {
        normalize_imported(&mut config);
        validate(&config).map_err(|error| format!("渠道“{}”配置无效：{error}", config.name))?;
        let same_identity = |item: &Config| {
            item.id == config.id
                || (item.method == config.method
                    && item.endpoint.trim_end_matches('/') == config.endpoint
                    && item.username == config.username
                    && item.access_key_id == config.access_key_id)
        };
        if let Some(index) = all.channels.iter().position(same_identity) {
            if mode == "merge" {
                skipped += 1;
                continue;
            }
            // 覆盖已有渠道时保留本机 id，本机上传/下载记录保持关联。
            config.id = all.channels[index].id.clone();
            all.channels[index] = config;
            updated += 1;
        } else {
            if all.channels.len() >= 50 {
                return Err("同步渠道最多可添加 50 条".into());
            }
            all.channels.push(config);
            added += 1;
        }
    }
    Ok(CloudSyncImportSummary { added, updated, skipped })
}

#[tauri::command]
pub(crate) fn cloud_sync_import_confirm(token: String, mode: Option<String>) -> PlatformResult<CloudSyncImportSummary> {
    supported()?;
    let mode = mode.unwrap_or_else(|| "merge".into());
    if !["merge", "overwrite"].contains(&mode.as_str()) {
        return Err("导入方式无效".into());
    }
    let staged = {
        let stage = IMPORT_STAGE.get_or_init(|| Mutex::new(None));
        let mut guard = stage.lock().map_err(|_| "导入状态不可用")?;
        match guard.take() {
            Some((staged_token, at, channels)) if staged_token == token && at.elapsed() <= IMPORT_STAGE_TTL => channels,
            _ => return Err("导入预览已失效，请重新选择文件".into()),
        }
    };
    let _guard = OPERATION.try_lock().map_err(|_| "云同步正在执行，请稍后重试")?;
    let mut all = load_all()?;
    let summary = apply_import(&mut all, staged, &mode)?;
    if summary.added + summary.updated > 0 {
        persist_all(&all)?;
    }
    Ok(summary)
}

#[tauri::command]
pub(crate) async fn cloud_sync_delete(channel_id: String) -> PlatformResult<()> {
    checked_id(Some(&channel_id))?;
    let _guard = OPERATION.try_lock().map_err(|_| "云同步正在执行，请稍后重试")?;
    let mut all = load_all()?;
    if !all.channels.iter().any(|item| item.id == channel_id) { return Err("同步渠道不存在，请刷新列表".into()); }
    all.channels.retain(|item| item.id != channel_id);
    persist_all(&all)?;
    activate(&channel_id)?;
    *status().lock().map_err(|_| "同步状态不可用")? = SyncStatus::default();
    Ok(())
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
    super::database_migration::sql::selected(config.tables.clone())?;
    checked_id(Some(&config.id))?;
    if config.name.trim().is_empty() || config.name.chars().count() > 80 || config.name.chars().any(char::is_control) {
        return Err("请填写有效的渠道名称（最多 80 个字符）".into());
    }
    if !["webdav", "s3", "oss"].contains(&config.method.as_str())
        || !["custom", "jianguoyun", "nextcloud", "alist"].contains(&config.provider.as_str())
    {
        return Err("同步方式或服务商无效".into());
    }
    if config.endpoint.len() > 2048 {
        return Err("服务地址过长".into());
    }
    transport::base(config)?;
    if config.method == "oss" && !transport::oss_endpoint(config)? {
        return Err("请填写阿里云 OSS 区域 Endpoint，例如 https://oss-cn-beijing.aliyuncs.com".into());
    }
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
    input.name = input.name.trim().to_string();
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
    let saved = load_channel(&config.id)?.ok_or("尚未保存云同步配置")?;
    Ok(reveal_secret(&config, &saved, &field)?.to_string())
}

fn reveal_secret<'a>(input: &Config, saved: &'a Config, field: &str) -> Result<&'a str, String> {
    let same_identity = input.method == saved.method
        && input.endpoint.trim().trim_end_matches('/') == saved.endpoint
        && input.username == saved.username
        && input.access_key_id == saved.access_key_id;
    let secret = match field {
        "password" if same_identity && saved.method == "webdav" => &saved.password,
        "secretKey" if same_identity && ["s3", "oss"].contains(&saved.method.as_str()) => &saved.secret_key,
        "backupPassword" if input.password_protected && saved.password_protected => &saved.backup_password,
        _ => return Err("当前配置没有可查看的已保存凭据".into()),
    };
    if secret.is_empty() {
        return Err("当前配置没有可查看的已保存凭据".into());
    }
    Ok(secret)
}

#[tauri::command]
pub(crate) fn cloud_sync_state(channel_id: Option<String>) -> PlatformResult<SyncView> {
    supported()?;
    let id = checked_id(channel_id.as_deref())?;
    let config = load_channel(id)?;
    let mut fallback = Config::default(); fallback.id = id.into();
    Ok(view(
        config.as_ref().unwrap_or(&fallback),
        config.is_some(),
    )?)
}
#[tauri::command]
pub(crate) async fn cloud_sync_save(config: Config) -> PlatformResult<SyncView> {
    supported()?;
    let _guard = OPERATION
        .try_lock()
        .map_err(|_| "云同步正在执行，请稍后重试")?;
    let saved = load_channel(&config.id)?;
    let config = merge_input(config, saved.as_ref())?;
    persist(&config)?;
    activate(&config.id)?;
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
    let saved = load_channel(&config.id)?;
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

const VERSION_INDEX: &str = "versions.json";
const MAX_VERSIONS: usize = 10000;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BackupVersion {
    id: String,
    machine_name: String,
    uploaded_at: Option<String>,
    #[serde(default)]
    password_protected: Option<bool>,
}

impl BackupVersion {
    fn new() -> Self {
        let machine_name = std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .ok().filter(|name| !name.trim().is_empty())
            .unwrap_or_else(machine_name)
            .trim().chars().filter(|c| !c.is_control()).take(100).collect::<String>();
        Self {
            id: format!("backup-{}.chdb", uuid::Uuid::new_v4()),
            machine_name: format!("{machine_name}{}", crate::core::data_transfer::BUILD_SUFFIX),
            uploaded_at: Some(chrono::Utc::now().to_rfc3339()),
            password_protected: None,
        }
    }
}

fn machine_name() -> String {
    #[cfg(target_os = "macos")]
    if let Ok(output) = std::process::Command::new("/usr/sbin/scutil").args(["--get", "ComputerName"]).output() {
        if output.status.success() {
            let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !name.is_empty() { return name; }
        }
    }
    if let Ok(name) = std::fs::read_to_string("/etc/hostname") {
        if !name.trim().is_empty() { return name; }
    }
    let device = open_db().ok().and_then(|db| db.query_row(
        "SELECT device_id,device_name FROM sync_local_device WHERE id=1", [],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).ok());
    match device {
        Some((_, name)) if name != "本机" && !name.trim().is_empty() => name,
        Some((id, _)) => format!("{}-{}", std::env::consts::OS, id.chars().take(8).collect::<String>()),
        None => std::env::consts::OS.into(),
    }
}

fn selected_version(id: Option<&str>) -> Result<String, String> {
    let id = id.unwrap_or("database.chdb");
    if id == "database.chdb" || id.strip_prefix("backup-").and_then(|s| s.strip_suffix(".chdb"))
        .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok() && s.len() == 36) {
        Ok(id.into())
    } else {
        Err("备份版本无效，请刷新版本列表".into())
    }
}

async fn version_index(client: &reqwest::Client, config: &Config) -> Result<(Vec<BackupVersion>, Option<String>), String> {
    let (versions, tag) = legacy_version_index(client, config).await?;
    if transport::oss_endpoint(config)? {
        return Ok((oss_versions::versions(client, config, versions).await?, None));
    }
    Ok((versions, tag))
}

async fn legacy_version_index(client: &reqwest::Client, config: &Config) -> Result<(Vec<BackupVersion>, Option<String>), String> {
    let mut response = transport::request(client, config, Method::GET,
        transport::named_url(config, VERSION_INDEX)?, vec![], None).await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND { return Ok((vec![], None)); }
    transport::check(response.status())?;
    let tag = transport::etag(&response);
    if tag.is_none() && !transport::oss_endpoint(config)? {
        return Err("服务未提供版本目录 ETag，无法安全维护多版本备份".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取备份版本目录失败")? {
        if bytes.len().saturating_add(chunk.len()) > 4 * 1024 * 1024 { return Err("备份版本目录过大".into()); }
        bytes.extend_from_slice(&chunk);
    }
    let versions: Vec<BackupVersion> = serde_json::from_slice(&bytes).map_err(|_| "备份版本目录无效")?;
    if versions.len() > MAX_VERSIONS || versions.iter().any(|v| selected_version(Some(&v.id)).is_err()
        || v.id == "database.chdb" || v.machine_name.len() > 400 || v.machine_name.chars().any(char::is_control)
        || v.uploaded_at.as_ref().is_none_or(|s| chrono::DateTime::parse_from_rfc3339(s).is_err())) {
        return Err("备份版本目录无效".into());
    }
    Ok((versions, tag))
}

async fn register_version(client: &reqwest::Client, config: &Config, version: BackupVersion) -> Result<(), String> {
    if transport::oss_endpoint(config)? { return oss_versions::register(client, config, version).await; }
    for _ in 0..5 {
        let (mut versions, tag) = version_index(client, config).await?;
        if versions.iter().any(|v| v.id == version.id) { return Ok(()); }
        if versions.len() >= MAX_VERSIONS { return Err("备份版本已达一万条，请更换同步配置名".into()); }
        versions.push(version.clone());
        versions.sort_by(|a, b| b.uploaded_at.cmp(&a.uploaded_at));
        let response = transport::request(client, config, Method::PUT,
            transport::named_url(config, VERSION_INDEX)?,
            serde_json::to_vec(&versions).map_err(|_| "生成备份版本目录失败")?,
            Some(tag.as_deref().map(|s| ("If-Match", s)).unwrap_or(("If-None-Match", "*")))).await;
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                if let Ok((confirmed, _)) = version_index(client, config).await {
                    if confirmed.iter().any(|item| item.id == version.id) { return Ok(()); }
                }
                return Err(error);
            }
        };
        if response.status() == reqwest::StatusCode::PRECONDITION_FAILED { continue; }
        return transport::check(response.status());
    }
    Err("其他设备正在上传，版本登记未完成，请稍后重试上传".into())
}

#[tauri::command]
pub(crate) async fn cloud_sync_delete_version(channel_id: Option<String>, version_id: String) -> PlatformResult<()> {
    let _guard = OPERATION.try_lock().map_err(|_| "云同步正在执行，请稍后重试")?;
    let id = selected_version(Some(&version_id))?;
    let config = load_channel(checked_id(channel_id.as_deref())?)?.ok_or("请先保存云同步配置")?;
    validate(&config)?;
    let client = transport::client()?;
    let remove = |name: String| {
        let client = &client;
        let config = &config;
        async move {
            let response = transport::request(client, config, Method::DELETE,
                transport::named_url(config, &name)?, vec![], None).await?;
            if response.status() == reqwest::StatusCode::NOT_FOUND { Ok(()) }
            else { transport::check(response.status()) }
        }
    };
    remove(id.clone()).await?;
    if id == "database.chdb" { return Ok(()); }
    if transport::oss_endpoint(&config)? { remove(format!("{id}.json")).await?; return Ok(()); }
    for _ in 0..5 {
        let (mut versions, tag) = legacy_version_index(&client, &config).await?;
        if !versions.iter().any(|v| v.id == id) { return Ok(()); }
        versions.retain(|v| v.id != id);
        let response = transport::request(&client, &config, Method::PUT,
            transport::named_url(&config, VERSION_INDEX)?,
            serde_json::to_vec(&versions).map_err(|_| "生成备份版本目录失败")?,
            Some(("If-Match", tag.as_deref().ok_or("版本目录缺少 ETag")?))).await?;
        if response.status() == reqwest::StatusCode::PRECONDITION_FAILED { continue; }
        return Ok(transport::check(response.status())?);
    }
    Err("备份文件已删除，但其他设备正在更新版本目录，请重试删除以完成清理".into())
}

#[tauri::command]
pub(crate) async fn cloud_sync_versions(channel_id: Option<String>) -> PlatformResult<Vec<BackupVersion>> {
    let _guard = OPERATION.try_lock().map_err(|_| "云同步正在执行，请稍后重试")?;
    let config = load_channel(checked_id(channel_id.as_deref())?)?.ok_or("请先保存云同步配置")?;
    validate(&config)?;
    let client = transport::client()?;
    let (mut versions, _) = version_index(&client, &config).await?;
    versions.sort_by(|a, b| {
        let time = |v: &BackupVersion| v.uploaded_at.as_ref().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok());
        time(b).cmp(&time(a)).then_with(|| a.id.cmp(&b.id))
    });
    if transport::head(&client, &config).await?.0 {
        versions.push(BackupVersion { id: "database.chdb".into(), machine_name: "旧版备份（机器名称未知）".into(), uploaded_at: None, password_protected: None });
    }
    Ok(versions)
}

async fn upload(automatic: bool, channel_id: &str) -> Result<(), String> {
    progress("connecting", 0, None);
    let mut config = load_channel(channel_id)?.ok_or("请先保存云同步配置")?;
    validate(&config)?;
    if automatic && (!config.auto_sync || status().lock().map_err(|_| "同步状态不可用")?.paused)
    {
        return Ok(());
    }
    let client = transport::client()?;
    transport::ensure_directories(&client, &config).await?;
    let password = if config.password_protected {
        Some(config.backup_password.clone())
    } else {
        None
    };
    progress("preparing", 0, None);
    let tables=config.tables.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        super::database_migration::cloud_snapshot_scoped(password,tables)
    })
    .await
    .map_err(|_| "创建云备份快照失败")??;
    let mut version = BackupVersion::new();
    version.password_protected = Some(config.password_protected);
    let response = transport::request(
        &client,
        &config,
        Method::PUT,
        transport::named_url(&config, &version.id)?,
        bytes,
        Some(("If-None-Match", "*")),
    )
    .await?;
    transport::check(response.status())?;
    progress("finishing", 0, None);
    register_version(&client, &config, version).await
        .map_err(|error| format!("备份文件已上传，但版本目录登记失败：{error}"))?;
    config.last_etag = transport::etag(&response);
    // Do not fetch a newer ETag here: a second device could have replaced our upload.
    persist(&config)?;
    if let Ok(mut state) = status().lock() {
        state.paused = false;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn cloud_sync_upload(channel_id: Option<String>) -> PlatformResult<SyncView> {
    supported()?;
    let _guard = OPERATION
        .try_lock()
        .map_err(|_| "云同步正在执行，请勿重复操作")?;
    let id = checked_id(channel_id.as_deref())?;
    activate(id)?;
    let busy = Busy::start()?;
    let result = upload(false, id).await;
    busy.finish(result.as_ref().err().cloned(), true);
    result?;
    drop(busy);
    Ok(view(&load_channel(id)?.ok_or("配置已失效")?, true)?)
}

fn restore_password(config: &Config, password: Option<String>) -> Result<Option<String>, String> {
    if password.as_ref().is_some_and(|value| value.len() > 4096) {
        return Err("备份密码长度超出限制".into());
    }
    Ok(password.filter(|value| !value.is_empty()).or_else(|| {
        config.password_protected.then(|| config.backup_password.clone())
    }))
}

#[tauri::command]
pub(crate) async fn cloud_sync_download(
    app: tauri::AppHandle,
    version_id: Option<String>,
    channel_id: Option<String>,
    password: Option<String>,
) -> PlatformResult<super::database_migration::ImportPreview> {
    if password.as_ref().is_some_and(|value| value.len() > 4096) {
        return Err("备份密码长度超出限制".into());
    }
    supported()?;
    let _guard = OPERATION
        .try_lock()
        .map_err(|_| "云同步正在执行，请勿重复操作")?;
    let id = checked_id(channel_id.as_deref())?;
    activate(id)?;
    let busy = Busy::start()?;
    progress("connecting", 0, None);
    let result = async {
        let mut config = load_channel(id)?.ok_or("请先保存云同步配置")?;
        validate(&config)?;
        let client = transport::client()?;
        let response = transport::request(
            &client,
            &config,
            Method::GET,
            transport::named_url(&config, &selected_version(version_id.as_deref())?)?,
            vec![],
            None,
        )
        .await?;
        let tag = transport::etag(&response);
        let bytes = transport::read(response).await?;
        progress("verifying", 0, None);
        let password = restore_password(&config, password)?;
        config.last_etag = tag;
        // A preview may be cancelled or the app may restart before restore. Never
        // accept a remote version as the baseline for automatic local overwrite.
        config.auto_sync = false;
        let preview = tauri::async_runtime::spawn_blocking(move || {
            super::database_migration::prepare_cloud_snapshot(
                &bytes,
                password,
                &app.state::<super::database_migration::DatabaseImportStore>(),
            )
        })
        .await
        .map_err(|_| "准备云备份预览失败")??;
        persist(&config)?;
        Ok::<_, String>(preview)
    }
    .await;
    busy.finish(result.as_ref().err().cloned(), false);
    result.map_err(Into::into)
}

pub(super) fn pause_for_restore() {
    if let Ok(mut all) = CHANNEL_STATUS.get_or_init(|| Mutex::new(HashMap::new())).lock() {
        for state in all.values_mut() { state.paused = true; }
        if let Ok(configs) = load_all() {
            for config in configs.channels { all.entry(config.id.clone()).or_default().paused = true; }
        }
    }
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
        let mut trackers: HashMap<String, (Option<String>, Option<(Instant, Instant)>, Instant)> = HashMap::new();
        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            let Ok(configs) = load_all() else { continue; };
            trackers.retain(|id, _| configs.channels.iter().any(|config| config.id == *id));
            let hash = tauri::async_runtime::spawn_blocking(|| fingerprint(&open_db()?)).await;
            let Ok(Ok(hash)) = hash else { continue; };
            for config in configs.channels {
                let (previous, pending, retry_after) = trackers.entry(config.id.clone()).or_insert((None, None, Instant::now()));
                if !config.auto_sync || channel_status(&config.id).map(|state| state.paused).unwrap_or(true) {
                    *previous = None; *pending = None; continue;
                }
                if previous.as_ref().is_some_and(|old| old != &hash) {
                    let now = Instant::now();
                    *pending = Some((pending.map(|v| v.0).unwrap_or(now), now));
                }
                *previous = Some(hash.clone());
                let Some((first, last)) = *pending else {
                    continue;
                };
                if Instant::now() < *retry_after
                    || (last.elapsed() < Duration::from_secs(30)
                        && first.elapsed() < Duration::from_secs(120))
                {
                    continue;
                }
                let Ok(_guard) = OPERATION.try_lock() else {
                    continue;
                };
                if activate(&config.id).is_err() { continue; }
                let Ok(busy) = Busy::start() else {
                    continue;
                };
                let result = upload(true, &config.id).await;
                busy.finish(result.as_ref().err().cloned(), true);
                if result.is_ok() {
                    *pending = None;
                }
                *retry_after =
                    Instant::now() + Duration::from_secs(if result.is_ok() { 30 } else { 300 });
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restore_password_is_independent_of_upload_protection() {
        let mut config = Config::default();
        let temporary = "non-sensitive-restore-fixture".to_string();
        assert_eq!(restore_password(&config, Some(temporary.clone())).unwrap(), Some(temporary.clone()));
        assert!(restore_password(&config, None).unwrap().is_none());
        config.password_protected = true;
        config.backup_password = "non-sensitive-saved-fixture".into();
        assert_eq!(restore_password(&config, None).unwrap().as_deref(), Some(config.backup_password.as_str()));
        assert_eq!(restore_password(&config, Some(String::new())).unwrap().as_deref(), Some(config.backup_password.as_str()));
        assert_eq!(restore_password(&config, Some(temporary.clone())).unwrap(), Some(temporary));
        assert!(restore_password(&config, Some("x".repeat(4097))).is_err());
    }

    #[test]
    fn version_password_metadata_preserves_unknown_legacy_state() {
        let old = r#"{"id":"database.chdb","machineName":"fixture","uploadedAt":null}"#;
        let mut version: BackupVersion = serde_json::from_str(old).unwrap();
        assert_eq!(version.password_protected, None);
        for flag in [true, false] {
            version.password_protected = Some(flag);
            let parsed: BackupVersion = serde_json::from_slice(&serde_json::to_vec(&version).unwrap()).unwrap();
            assert_eq!(parsed.password_protected, Some(flag));
        }
    }
    fn fixture() -> Config {
        let mut value = Config::default();
        value.endpoint = "https://storage.example/dav".into();
        value.username = "fixture-user".into();
        value.password = "fixture-password".into();
        value
    }
    #[test]
    fn legacy_and_multi_channel_configs_keep_separate_identities() {
        let config = fixture();
        let mut legacy = serde_json::to_value(&config).unwrap();
        legacy.as_object_mut().unwrap().remove("id");
        legacy.as_object_mut().unwrap().remove("name");
        let migrated = parse_configs(&legacy.to_string()).unwrap();
        assert_eq!(migrated.channels[0].id, "default");
        let mut second = fixture();
        second.id = uuid::Uuid::new_v4().to_string(); second.name = "备用渠道".into();
        second.password = "second-fixture".into();
        let all = ChannelConfigs { channels: vec![config, second] };
        let parsed = parse_configs(&serde_json::to_string(&all).unwrap()).unwrap();
        assert_eq!(parsed.channels.len(), 2);
        assert_ne!(parsed.channels[0].id, parsed.channels[1].id);
        assert_ne!(parsed.channels[0].password, parsed.channels[1].password);
        assert!(checked_id(Some("../private")).is_err());
    }
    #[test]
    fn import_parse_accepts_exported_and_legacy_single_channel_files() {
        let mut first = fixture();
        first.id = uuid::Uuid::new_v4().to_string();
        first.name = "家庭 NAS".into();
        let mut second = fixture();
        second.id = uuid::Uuid::new_v4().to_string();
        second.name = "备用 S3".into();
        second.method = "s3".into();
        second.access_key_id = "AKIA-fixture".into();
        second.secret_key = "sk-fixture".into();
        second.bucket = "fixture-bucket".into();
        second.password = String::new();
        let exported = serde_json::json!({
            "format": "cloudhub-tools-cloud-sync", "version": 1,
            "exportedAt": "2026-01-01T00:00:00Z",
            "channels": [first, second],
        });
        let parsed = parse_import_channels(&exported.to_string()).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[1].secret_key, "sk-fixture");
        let legacy = serde_json::to_value(&fixture()).unwrap();
        let legacy_parsed = parse_import_channels(&legacy.to_string()).unwrap();
        assert_eq!(legacy_parsed.len(), 1);
        assert!(parse_import_channels(r#"{"format":"other-tool","channels":[]}"#).is_err());
        assert!(parse_import_channels(r#"{"channels":[]}"#).is_err());
        assert!(parse_import_channels(r#"{"channels":[{"id":"broken"}]}"#).is_err());
    }
    #[test]
    fn import_merges_by_identity_and_overwrite_keeps_local_id() {
        let mut local = fixture();
        local.name = "本机渠道".into();
        let mut incoming = fixture();
        incoming.name = "导入渠道".into();
        incoming.password = "new-fixture-password".into();
        let mut extra = fixture();
        extra.id = uuid::Uuid::new_v4().to_string();
        extra.endpoint = "https://other.example/dav/".into();
        let mut all = ChannelConfigs { channels: vec![local] };
        let summary = apply_import(&mut all, vec![incoming, extra], "merge").unwrap();
        assert_eq!((summary.added, summary.updated, summary.skipped), (1, 0, 1));
        assert_eq!(all.channels.len(), 2);
        assert_eq!(all.channels[0].name, "本机渠道");
        let mut replacement = fixture();
        replacement.password = "overwritten-fixture".into();
        replacement.name = "导入渠道".into();
        let local_id = all.channels[0].id.clone();
        let summary = apply_import(&mut all, vec![replacement], "overwrite").unwrap();
        assert_eq!((summary.added, summary.updated, summary.skipped), (0, 1, 0));
        assert_eq!(all.channels[0].id, local_id);
        assert_eq!(all.channels[0].password, "overwritten-fixture");
        assert_eq!(all.channels[0].name, "导入渠道");
        let mut broken = fixture();
        broken.endpoint = "https://".into();
        assert!(apply_import(&mut all, vec![broken], "merge").is_err());
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
    fn oss_channels_validate_and_preserve_secrets() {
        let mut input = Config::default();
        input.method = "oss".into();
        input.endpoint = "https://oss-cn-beijing.aliyuncs.com".into();
        input.bucket = "fixture-bucket".into();
        input.region = "cn-beijing".into();
        input.access_key_id = "fixture-access".into();
        input.secret_key = "fixture-signing".into();
        let saved = merge_input(input.clone(), None).unwrap();
        input.secret_key.clear();
        let merged = merge_input(input.clone(), Some(&saved)).unwrap();
        assert_eq!(merged.secret_key, saved.secret_key);
        assert!(reveal_secret(&input, &saved, "secretKey").is_ok());
        assert!(!serde_json::to_string(&view(&merged, true).unwrap()).unwrap().contains("fixture-signing"));
        input.endpoint = "https://storage.example".into();
        assert!(validate(&input).unwrap_err().contains("OSS"));
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
