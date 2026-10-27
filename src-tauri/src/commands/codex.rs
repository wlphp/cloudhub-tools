use crate::core::{
    codex::{auth, profile, rpc, AccountMetadataInput, CodexAccountSummary},
    error::PlatformResult,
    repositories::codex_accounts as repository,
    storage::{decrypt_secret, open_db},
};
use rusqlite::OptionalExtension;
#[cfg(test)]
use rusqlite::params;
use serde::Serialize;
use std::{
    fs,
    io::Read,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

// Auth import/refresh/switch share one writer. It also bounds simultaneous CLI processes.
pub(crate) use crate::core::codex::AUTH_WRITER;
static SWITCH_TICKET: Mutex<Option<SwitchTicket>> = Mutex::new(None);
struct RefreshLease { id: i64, active: std::sync::Arc<Mutex<std::collections::HashMap<i64, &'static str>>> }
impl Drop for RefreshLease { fn drop(&mut self) { if let Ok(mut active) = self.active.lock() { active.remove(&self.id); } } }
// Caller holds AUTH_WRITER. Reserve this account before releasing the global
// writer for remote I/O; instance launch, import and deletion honor this lease.
fn refresh_lease(app: &tauri::AppHandle, id: i64, operation: &'static str) -> Result<RefreshLease, String> {
    let store = app.state::<super::codex_runtime::CodexRuntimeStore>();
    if super::codex_instances::account_running(&store, id)? { return Err(super::codex_instances::account_busy_error(&store, id, "刷新登录凭据")?); }
    let active = store.wakes.clone();
    active.lock().map_err(|_| "Codex 账号操作不可用")?.insert(id, operation);
    Ok(RefreshLease { id, active })
}

#[tauri::command]
pub(crate) async fn codex_auth_metadata(id: i64) -> PlatformResult<auth::AuthMetadata> {
    tauri::async_runtime::spawn_blocking(move || -> Result<auth::AuthMetadata, String> {
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        auth::metadata(&repository::credentials(&open_db()?, id)?)
    }).await.map_err(|_| "读取 Codex 认证信息失败")?.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_force_refresh(app: tauri::AppHandle, id: i64) -> PlatformResult<auth::AuthMetadata> {
    tauri::async_runtime::spawn_blocking(move || -> Result<auth::AuthMetadata, String> {
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        if super::codex_instances::account_running(&app.state::<super::codex_runtime::CodexRuntimeStore>(), id)? {
            return Err(super::codex_instances::account_busy_error(&app.state::<super::codex_runtime::CodexRuntimeStore>(), id, "刷新 Token")?);
        }
        let conn = open_db()?;
        let account = repository::get(&conn, id)?;
        let saved = auth::parse_import(&repository::credentials(&conn, id)?)?.remove(0);
        auth::ensure_runtime_auth(&saved.auth_json)?;
        let default_home = profile::default_home()?;
        let default_auth = match fs::symlink_metadata(default_home.join("auth.json")) {
            Ok(_) => Some(auth::parse_import(&profile::read_auth(&default_home.join("auth.json"))?)?.remove(0)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err("检查 Codex 认证文件失败".into()),
        }.filter(|current| current.identity == saved.identity);
        let source = default_auth.as_ref().unwrap_or(&saved);
        auth::ensure_runtime_auth(&source.auth_json)?;
        // Import a grant already rotated by the owner before considering a new
        // refresh. Reading its snapshot is safe even while the client is running.
        if let Some(current) = &default_auth {
            if current.auth_json.as_str() != saved.auth_json.as_str() && !auth::access_expiring(&current.auth_json) {
                repository::save_refresh_action_with_details(&conn, id, account.updated_at, &current.auth_json, None, current.plan.as_deref(), None, "已同步默认客户端最新登录", None)?;
                return auth::metadata(&current.auth_json);
            }
        }
        if source.auth_mode != "chatgpt" || !auth::metadata(&source.auth_json)?.has_refresh_token {
            return Err("此账号没有可用的 Refresh Token，请重新授权或导入完整认证".into());
        }
        // An idle default profile can be refreshed by its official CLI in place.
        // Never fork its rotating grant into a temporary profile: that leaves the
        // desktop client holding an invalid refresh token on its next launch.
        let isolated = if default_auth.is_some() {
            profile::ensure_file_storage(&default_home)?;
            profile::ensure_default_idle()?;
            let current = auth::parse_import(&profile::read_auth(&default_home.join("auth.json"))?)?.remove(0);
            if current.auth_json.as_str() != source.auth_json.as_str() {
                return Err("默认 Codex 登录已变更，请重新刷新".into());
            }
            None
        } else {
            Some(profile::TemporaryProfile::new(&saved.auth_json)?)
        };
        let refresh_home = isolated.as_ref().map(|profile| profile.path.as_path()).unwrap_or(&default_home);
        let result = (|| {
            let mut server = rpc::AppServer::start_cancelled_proxy(refresh_home, None, account.proxy_url.as_deref())?;
            server.request("account/read", serde_json::json!({"refreshToken":true}), Duration::from_secs(30))
        })();
        let updated = auth::parse_import(&profile::read_auth(&refresh_home.join("auth.json"))?)?.remove(0);
        if updated.identity != saved.identity { return Err("Codex 刷新返回了不同账号，认证状态未保存".into()); }
        let credentials_changed = updated.auth_json.as_str() != saved.auth_json.as_str();
        let action = if result.is_ok() { "手动令牌续期成功" } else { "手动令牌续期失败" };
        let mut attempt = serde_json::json!({
            "transport":"官方 CLI RPC",
            "status":null,
            "outcome":if result.is_ok() {"completed"} else {"failed"},
            "calls":[{"method":"account/read","params":{"refreshToken":true}}],
            "response":{"credentialsChanged":credentials_changed,"tokenValues":"已省略"}
        });
        if let Err(error) = &result {
            attempt["error"] = serde_json::Value::String(error.clone());
        }
        let details = serde_json::json!({"attempts":[attempt]});
        // Persist rotated credentials even if the later RPC response failed.
        if credentials_changed {
            repository::save_refresh_action_with_details(&conn, id, account.updated_at, &updated.auth_json, None, updated.plan.as_deref(), None, action, Some(&details))?;
        } else {
            repository::record_event(&conn, id, "refresh", action, Some(&details))?;
        }
        result.map_err(|_| "官方 CLI 刷新失败，请检查网络或重新授权")?;
        auth::metadata(&updated.auth_json)
    }).await.map_err(|_| "刷新 Codex Token 任务失败")?.map_err(Into::into)
}
struct SwitchTicket {
    token: String,
    id: i64,
    version: i64,
    fingerprint: String,
    expires: Instant,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexState {
    accounts: Vec<CodexAccountSummary>,
    cli_available: bool,
    desktop_available: bool,
    can_open_default: bool,
    supports_remote_logs: bool,
    profile_home: String,
    current_account_id: Option<i64>,
    can_restore: bool,
}

fn state() -> Result<CodexState, String> {
    let conn = open_db()?;
    let home = profile::default_home()?;
    let current = profile::read_auth(&home.join("auth.json"))
        .ok()
        .and_then(|v| serde_json::from_str(&v).ok())
        .and_then(|v| auth::parse_account(&v).ok())
        .and_then(|account| {
            conn.query_row(
                "SELECT id FROM codex_accounts WHERE identity=?1",
                [account.identity],
                |row| row.get(0),
            )
            .ok()
        });
    let can_restore = conn
        .query_row(
            "SELECT COUNT(*) FROM codex_profile_backups WHERE profile_home=?1",
            [home.to_string_lossy().to_string()],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| "读取 Codex 恢复状态失败")?
        > 0;
    let desktop_available = crate::core::codex::desktop::installed().is_some();
    Ok(CodexState {
        accounts: repository::list(&conn)?,
        cli_available: profile::cli_path().is_some(),
        desktop_available,
        can_open_default: desktop_available,
        supports_remote_logs: true,
        profile_home: home.to_string_lossy().to_string(),
        current_account_id: current,
        can_restore,
    })
}

// Caller holds AUTH_WRITER so import cannot race an instance launch or token writeback.
pub(crate) fn import_accounts(
    app: &tauri::AppHandle,
    accounts: Vec<auth::ImportedAccount>,
) -> Result<(), String> {
    import_accounts_with_force(app, accounts, false)
}

fn import_accounts_with_force(
    app: &tauri::AppHandle,
    accounts: Vec<auth::ImportedAccount>,
    force: bool,
) -> Result<(), String> {
    let mut conn = open_db().map_err(|_| "无法打开本地账号数据库，请检查数据目录权限、数据库占用或客户端版本")?;
    let store = app.state::<super::codex_runtime::CodexRuntimeStore>();
    for account in &accounts {
        let id: Option<i64> = conn
            .query_row(
                "SELECT id FROM codex_accounts WHERE identity=?1",
                [&account.identity],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "查询 Codex 账号失败")?;
        if let Some(id) = id {
            if !force && super::codex_instances::account_running(&store, id)? {
                return Err("导入包含运行中实例的账号，请先停止实例，未保存任何账号".into());
            }
        }
    }
    repository::import(&mut conn, accounts)?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn codex_get_state() -> PlatformResult<CodexState> {
    tauri::async_runtime::spawn_blocking(state)
        .await
        .map_err(|_| "读取 Codex 状态任务失败")?
        .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_open_default(app: tauri::AppHandle) -> PlatformResult<String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        let store = app.state::<super::codex_runtime::CodexRuntimeStore>();
        if store.closing.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("应用正在退出，未打开 Codex".into());
        }
        super::codex_providers::ensure_gateway(&store,&profile::default_home()?)?;
        crate::core::codex::provider_oauth::sync(&profile::default_home()?)?;
        crate::core::codex::desktop::launch_default()
    })
    .await
    .map_err(|_| "打开 Codex 客户端任务失败")?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_import_local(app: tauri::AppHandle) -> PlatformResult<CodexState> {
    tauri::async_runtime::spawn_blocking(move || -> Result<CodexState, String> {
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        let content = profile::read_auth(&profile::default_home()?.join("auth.json"))?;
        import_accounts(&app, auth::parse_import(&content)?)?;
        state()
    })
    .await
    .map_err(|_| "导入 Codex 账号任务失败")?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_import_file(
    app: tauri::AppHandle,
    format: String,
) -> PlatformResult<Option<CodexState>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<CodexState>, String> {
        if !matches!(
            format.as_str(),
            "cockpit_tools" | "auth_json" | "sub2api" | "cpa"
        ) {
            return Err("Codex 导入格式无效".into());
        }
        let zip_allowed = matches!(format.as_str(), "auth_json" | "cpa");
        let dialog = app.dialog().file().set_title("导入 Codex 账号文件");
        let dialog = if zip_allowed {
            dialog.add_filter("JSON 或 ZIP", &["json", "zip"])
        } else {
            dialog.add_filter("JSON", &["json"])
        };
        let Some(selected) = dialog.blocking_pick_file() else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|_| "Codex 导入文件路径无效")?;
        let accounts = parse_codex_import_file(&path, &format)?;
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        import_accounts(&app, accounts)?;
        state().map(Some)
    })
    .await
    .map_err(|_| "导入 Codex 文件任务失败")?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_import_text(app: tauri::AppHandle, content: String, force: Option<bool>) -> PlatformResult<CodexState> {
    let content = zeroize::Zeroizing::new(content);
    tauri::async_runtime::spawn_blocking(move || -> Result<CodexState, String> {
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        let force = force.unwrap_or(false);
        let accounts = if force { crate::core::codex::token_import::parse_with_force(&content, true)? }
            else { crate::core::codex::token_import::parse(&content)? };
        import_accounts_with_force(&app, accounts, force).map_err(|message| {
            if message == "导入包含运行中实例的账号，请先停止实例，未保存任何账号" {
                "导入账号正在被实例、API 服务或供应商使用，普通导入已取消；可停止相关服务后重试，或选择强制导入".to_string()
            } else { message }
        })?;
        state().map_err(|_| "账号凭据已保存，但刷新账号列表失败，请重新打开账号页面查看".to_string())
    }).await.map_err(|_| "导入 Codex Token 任务失败")?.map_err(|message| crate::core::error::PlatformError {
        kind: "platform-error", code: "codex-import", message: crate::core::codex::token_import::public_error(&message).into(), retryable: false,
    })
}

fn normalize_import_value(value: &mut serde_json::Value, format: &str) -> Result<(), String> {
    use serde_json::{json, Value};
    if format == "sub2api" {
        let entries = value
            .get_mut("accounts")
            .and_then(Value::as_array_mut)
            .ok_or("Sub2API 文件缺少账号列表")?;
        for entry in entries.iter_mut() {
            let kind = entry.get("type").and_then(Value::as_str).unwrap_or("");
            let credentials = entry.get("credentials").cloned().unwrap_or(Value::Null);
            if kind == "apikey" {
                let key = credentials
                    .get("api_key")
                    .and_then(Value::as_str)
                    .ok_or("Sub2API API Key 凭据无效")?;
                *entry = json!({"OPENAI_API_KEY":key});
            } else if kind == "oauth" {
                let mut tokens = json!({});
                for name in ["access_token", "id_token", "refresh_token"] {
                    if let Some(token) = credentials.get(name) {
                        tokens[name] = token.clone();
                    }
                }
                if let Some(account_id) = credentials.get("chatgpt_account_id") {
                    tokens["account_id"] = account_id.clone();
                }
                *entry = json!({"tokens":tokens});
            } else {
                return Err("Sub2API 文件包含不支持的账号类型".into());
            }
        }
    } else if format == "cpa" {
        let normalize = |item: &mut Value| {
            if item.get("tokens").is_none() && item.get("access_token").is_some() {
                let mut tokens = json!({});
                for name in ["access_token", "id_token", "refresh_token", "account_id"] {
                    if let Some(token) = item.get(name) {
                        tokens[name] = token.clone();
                    }
                }
                let last_refresh = item.get("last_refresh").cloned();
                *item = json!({"tokens":tokens});
                if let Some(last_refresh) = last_refresh {
                    item["last_refresh"] = last_refresh;
                }
            }
        };
        if let Some(items) = value.as_array_mut() {
            for item in items {
                normalize(item);
            }
        } else {
            normalize(value);
        }
    }
    Ok(())
}

fn parse_codex_import_file(
    path: &std::path::Path,
    format: &str,
) -> Result<Vec<auth::ImportedAccount>, String> {
    use std::io::Cursor;
    use zeroize::Zeroizing;
    let file_size = fs::metadata(path)
        .map_err(|_| "读取 Codex 导入文件失败")?
        .len();
    if file_size == 0 || file_size > 4 * 1024 * 1024 {
        return Err("请选择不超过 4 MB 的非空 Codex 文件".into());
    }
    let bytes = Zeroizing::new(fs::read(path).map_err(|_| "读取 Codex 导入文件失败")?);
    if bytes.is_empty() || bytes.len() > 4 * 1024 * 1024 {
        return Err("请选择不超过 4 MB 的非空 Codex 文件".into());
    }
    let is_zip = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("zip"));
    if is_zip && !matches!(format, "auth_json" | "cpa") {
        return Err("所选格式不支持 ZIP 文件".into());
    }
    if is_zip {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes.as_slice()))
            .map_err(|_| "Codex ZIP 文件无效")?;
        if archive.len() == 0 || archive.len() > 100 {
            return Err("ZIP 中的账号文件数量超出限制".into());
        }
        let mut values = Vec::new();
        let mut total = 0usize;
        for index in 0..archive.len() {
            let file = archive.by_index(index).map_err(|_| "Codex ZIP 文件无效")?;
            if file.is_dir() || !file.name().to_ascii_lowercase().ends_with(".json") {
                continue;
            }
            let size = usize::try_from(file.size()).map_err(|_| "ZIP 文件超出大小限制")?;
            total = total
                .checked_add(size)
                .filter(|size| *size <= 2 * 1024 * 1024)
                .ok_or("ZIP 解压内容超出 2 MB 限制")?;
            let mut content = Vec::with_capacity(size);
            file.take(2 * 1024 * 1024 + 1)
                .read_to_end(&mut content)
                .map_err(|_| "读取 ZIP 中的账号文件失败")?;
            if content.len() != size {
                return Err("ZIP 中的账号文件大小无效".into());
            }
            let text = Zeroizing::new(
                String::from_utf8(content).map_err(|_| "ZIP 中的账号文件不是 UTF-8")?,
            );
            let mut value: serde_json::Value =
                serde_json::from_str(&text).map_err(|_| "ZIP 中的账号 JSON 无效")?;
            normalize_import_value(&mut value, format)?;
            let encoded = Zeroizing::new(value.to_string());
            values.extend(auth::parse_import(&encoded)?);
            if values.len() > 100 {
                return Err("每次可导入 1 至 100 个 Codex 账号".into());
            }
        }
        if values.is_empty() {
            return Err("ZIP 中没有可导入的 JSON 账号文件".into());
        }
        Ok(values)
    } else {
        if bytes.len() > 2 * 1024 * 1024 {
            return Err("JSON 文件不能超过 2 MB".into());
        }
        let text = Zeroizing::new(
            String::from_utf8(bytes.to_vec()).map_err(|_| "Codex 导入文件不是 UTF-8")?,
        );
        let mut value: serde_json::Value =
            serde_json::from_str(&text).map_err(|_| "Codex 导入文件不是有效 JSON")?;
        normalize_import_value(&mut value, format)?;
        let encoded = Zeroizing::new(value.to_string());
        auth::parse_import(&encoded)
    }
}

#[tauri::command]
pub(crate) async fn codex_save_metadata(
    input: AccountMetadataInput,
) -> PlatformResult<CodexAccountSummary> {
    tauri::async_runtime::spawn_blocking(move || -> Result<CodexAccountSummary, String> {
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        repository::metadata(&open_db()?, &input)
    })
    .await
    .map_err(|_| "保存 Codex 账号任务失败")?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_delete_account(
    app: tauri::AppHandle,
    id: i64,
) -> PlatformResult<CodexState> {
    tauri::async_runtime::spawn_blocking(move || -> Result<CodexState, String> {
        if id <= 0 {
            return Err("Codex 账号参数无效".into());
        }
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        if super::codex_instances::account_running(
            &app.state::<super::codex_runtime::CodexRuntimeStore>(),
            id,
        )? {
            return Err(super::codex_instances::account_busy_error(&app.state::<super::codex_runtime::CodexRuntimeStore>(), id, "删除账号")?);
        }
        let conn = open_db()?;
        crate::core::codex::providers::ensure_account_unbound(&conn, id)?;
        super::codex_instances::clear_account_projections(&conn, id)?;
        if conn
            .execute("UPDATE codex_accounts SET deleted_at=?2 WHERE id=?1 AND deleted_at IS NULL", rusqlite::params![id, chrono::Utc::now().timestamp_millis()])
            .map_err(|_| "删除 Codex 账号失败")?
            != 1
        {
            return Err("Codex 账号不存在".into());
        }
        state()
    })
    .await
    .map_err(|_| "删除 Codex 账号任务失败")?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_refresh_quota(
    app: tauri::AppHandle,
    id: i64,
) -> PlatformResult<CodexAccountSummary> {
    tauri::async_runtime::spawn_blocking(move || -> Result<CodexAccountSummary, String> {
        if id <= 0 { return Err("Codex 账号参数无效".into()); }
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        // A running credential owner may keep serving requests while we monitor
        // quota. Only an idle account may lease its rotating grant to our CLI.
        let usage = super::codex_instances::account_usage(&app.state::<super::codex_runtime::CodexRuntimeStore>(), id)?;
        let running = !usage.is_empty();
        let _lease = if running { None } else { Some(refresh_lease(&app, id, "额度刷新")?) };
        drop(_writer);
        let conn = open_db()?;
        let account = repository::get(&conn, id)?;
        if account.auth_mode != "chatgpt" { return Err("API Key 账号不提供 ChatGPT 订阅额度".into()); }
        if account.quota.fetched_at.is_some_and(|time| chrono::Utc::now().timestamp_millis() - time < 30_000) { return Err("额度刚刚刷新，请在 30 秒后重试".into()); }
        let auth_json = repository::credentials(&conn, id)?;
        let mut original = auth::parse_import(&auth_json)?.remove(0);
        if running {
            if let Some(current) = super::codex_instances::monitoring_auth(&app.state::<super::codex_runtime::CodexRuntimeStore>(), id, &original.identity)? {
                original = current;
            }
        }
        // A default client's refresh token belongs to that client. Use only its latest
        // access token for monitoring, so our temporary CLI cannot rotate its login away.
        let default_auth = profile::default_home().ok().and_then(|home| profile::read_auth(&home.join("auth.json")).ok()).and_then(|content| auth::parse_import(&content).ok()).and_then(|mut accounts| accounts.pop()).filter(|v| v.identity == original.identity);
        let mut owners = usage;
        if default_auth.is_some() {
            owners.push(format!("默认 Codex 客户端（配置目录：{}，由该客户端续期后重试）", profile::default_home()?.display()));
        }
        let external = !owners.is_empty();
        let monitored = default_auth.unwrap_or(original);
        let isolated = profile::TemporaryProfile::new(if external { "{}" } else { &monitored.auth_json })?;
        let mut api_log=crate::core::codex::remote_logs::RemoteTrace::new(Some(id),"cli_rpc","account/rateLimits/read","官方 CLI 内部远端请求（HTTP 地址及请求头不可见）",account.proxy_url.as_deref());
        api_log.request(&serde_json::json!({"rpcMethod":"account/rateLimits/read","params":{},"timeoutMs":30000,"headersAvailable":false,"note":"额度由官方 CLI 查询，无法采集其内部 HTTP 请求头、状态码或重试"}));
        let mut attempts = Vec::new();
        let fetched = (|| {
            // Read-only quota endpoint used by the reference; CLI remains the fallback.
            let mut direct_status = None;
            let direct = (|| {
                use crate::core::codex::account_controls as controls;
                let credentials: serde_json::Value = serde_json::from_str(&monitored.auth_json).map_err(|_| "Codex 登录数据无效")?;
                let token = credentials.pointer("/tokens/access_token").and_then(serde_json::Value::as_str).ok_or("缺少 Access Token")?;
                let workspace = monitored.account_id.as_deref().ok_or("缺少工作区标识")?;
                let client = controls::client(account.proxy_url.as_deref())?;
                let value = tauri::async_runtime::block_on(controls::request(&client, token, workspace, id, account.proxy_url.as_deref(), "wham/usage", None))?;
                direct_status = Some(200);
                let quota = controls::parse_usage(&value, workspace)?;
                let plan = value.get("plan_type").and_then(serde_json::Value::as_str).filter(|v| v.len() <= 80 && !v.chars().any(char::is_control)).map(str::to_owned);
                Ok::<_, String>((quota, plan))
            })();
            let direct_error = match direct {
                Ok((quota, plan)) => {
                    attempts.push(serde_json::json!({
                        "transport":"HTTP",
                        "method":"GET",
                        "path":"/backend-api/wham/usage",
                        "request":{"query":null,"headers":"Authorization 与账号标识头已省略"},
                        "status":200,
                        "outcome":"completed",
                        "response":{"quota":quota,"plan":plan}
                    }));
                    return Ok((quota, plan));
                }
                Err(error) => {
                    let status = direct_status.or_else(|| error.split("HTTP ").nth(1).and_then(|value| value.get(..3)).and_then(|value| value.parse::<u16>().ok()).filter(|value| (100..=599).contains(value)));
                    attempts.push(serde_json::json!({
                        "transport":"HTTP",
                        "method":"GET",
                        "path":"/backend-api/wham/usage",
                        "request":{"query":null,"headers":"Authorization 与账号标识头已省略"},
                        "status":status,
                        "outcome":"failed",
                        "error":error
                    }));
                    error
                }
            };
            let mut cli_calls = Vec::new();
            let cli_result = (|| {
            let mut server = rpc::AppServer::start_cancelled_proxy(&isolated.path,None,account.proxy_url.as_deref())?;
            if external {
                let credentials: serde_json::Value = serde_json::from_str(&monitored.auth_json).map_err(|_| "Codex 登录数据无效")?;
                let access = credentials.pointer("/tokens/access_token").and_then(serde_json::Value::as_str).ok_or("Codex 登录数据无效")?;
                cli_calls.push(serde_json::json!({"method":"account/login/start","params":{"type":"chatgptAuthTokens","accessToken":"[已隐藏]","chatgptAccountId":"[已隐藏]","chatgptPlanType":monitored.plan}}));
                server.request("account/login/start", serde_json::json!({"type":"chatgptAuthTokens","accessToken":access,"chatgptAccountId":monitored.account_id,"chatgptPlanType":monitored.plan}), Duration::from_secs(20))?;
            }
            cli_calls.push(serde_json::json!({"method":"account/read","params":{"refreshToken":!external}}));
            let info = server.request("account/read", serde_json::json!({"refreshToken":!external}), Duration::from_secs(30))?;
            cli_calls.push(serde_json::json!({"method":"account/rateLimits/read","params":{}}));
            let limits = server.request("account/rateLimits/read", serde_json::json!({}), Duration::from_secs(30))?;
            api_log.response(&limits);
            let plan = info.get("account").and_then(|v| v.get("planType")).and_then(serde_json::Value::as_str).filter(|v| v.len() <= 80).map(str::to_owned);
            let quota = rpc::parse_quota(&limits)?;
            Ok::<_, String>((quota, plan))
            })();
            match cli_result {
                Ok((quota, plan)) => {
                    attempts.push(serde_json::json!({
                        "transport":"官方 CLI RPC",
                        "status":null,
                        "outcome":"completed",
                        "calls":cli_calls,
                        "response":{"quota":quota,"plan":plan,"note":"仅记录解析后的额度字段；CLI 内部 HTTP 响应不可见"}
                    }));
                    Ok((quota, plan))
                }
                Err(cli_error) => {
                    attempts.push(serde_json::json!({
                        "transport":"官方 CLI RPC",
                        "status":null,
                        "outcome":"failed",
                        "calls":cli_calls,
                        "error":cli_error
                    }));
                    let hint = if external {
                        format!("；本次仅查询额度，未续期登录。凭据占用来源：{}。如认证过期，请由上述来源续期后重试，或解除占用后刷新 Token", owners.join("；"))
                    } else { String::new() };
                    Err(format!("{direct_error}；CLI 查询失败：{cli_error}{hint}"))
                }
            }
        })();
        api_log.finish(if fetched.is_ok(){"completed"}else{"cli_error"});
        let details = serde_json::json!({"attempts":attempts});
        if external {
            // Never write a borrowed credential snapshot back: the owner may
            // have rotated it while the read-only network request was in flight.
            // Serialize the cache write with token writers too: updated_at is
            // their CAS version, so changing it mid-rotation would reject save.
            let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
            match fetched {
                Ok((quota, plan)) => repository::save_quota_observation(&conn, id, Some(&quota), plan.as_deref(), None, Some(&details))?,
                Err(error) => repository::save_quota_observation(&conn, id, None, None, Some(&error), Some(&details))?,
            }
            return repository::get(&conn, id);
        }
        let updated = profile::read_auth(&isolated.path.join("auth.json"))?;
        let imported = auth::parse_import(&updated)?.remove(0);
        if imported.identity != monitored.identity { return Err("Codex 刷新返回了不同账号，认证状态未保存".into()); }
        match fetched {
            Ok((quota, plan)) => repository::save_refresh_action_with_details(&conn, id, account.updated_at, &imported.auth_json, Some(&quota), plan.as_deref(), None, "额度刷新成功", Some(&details))?,
            Err(error) => repository::save_refresh_action_with_details(&conn, id, account.updated_at, &imported.auth_json, None, None, Some(&error), "额度刷新失败", Some(&details))?,
        }
        repository::get(&conn, id)
    }).await.map_err(|_| "刷新 Codex 额度任务失败")?.map_err(Into::into)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SwitchPreview {
    token: String,
    account_label: String,
    profile_home: String,
    has_previous_auth: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SwitchResult {
    #[serde(flatten)]
    state: CodexState,
    // 切号时从 config.toml 移除的第三方接管摘要，供界面提示官方直连与官方模型列表已恢复。
    removed_overrides: Option<String>,
}

fn switch_home() -> Result<std::path::PathBuf, String> {
    let home = profile::default_home()?;
    if home.exists()
        && fs::symlink_metadata(&home)
            .map_err(|_| "检查 Codex 目录失败")?
            .file_type()
            .is_symlink()
    {
        return Err("默认 Codex 目录为链接，请使用独立实例".into());
    }
    profile::ensure_file_storage(&home)?;
    profile::ensure_default_idle()?;
    Ok(home)
}

fn previous_auth(home: &std::path::Path) -> Result<Option<zeroize::Zeroizing<String>>, String> {
    let path = home.join("auth.json");
    match fs::symlink_metadata(&path) {
        Ok(_) => profile::read_text(&path).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("检查 Codex 认证文件失败".into()),
    }
}

#[cfg(test)]
fn install_profile(
    conn: &rusqlite::Connection,
    home: &std::path::Path,
    auth: &str,
    previous: Option<&str>,
    encrypt: impl FnOnce(&str) -> Result<String, String>,
) -> Result<(), String> {
    let backup = previous
        .map(encrypt)
        .transpose()
        .map_err(|_| "加密 Codex 恢复备份失败")?;
    // Commit the encrypted recovery point before any directory or auth-file mutation.
    conn.execute("INSERT INTO codex_profile_backups(profile_home,auth_ciphertext,installed_fingerprint,previous_fingerprint) VALUES(?1,?2,?3,?4) ON CONFLICT(profile_home) DO UPDATE SET auth_ciphertext=excluded.auth_ciphertext,installed_fingerprint=excluded.installed_fingerprint,previous_fingerprint=excluded.previous_fingerprint", params![home.to_string_lossy().to_string(), backup, profile::fingerprint(Some(auth)), profile::fingerprint(previous)]).map_err(|_| "保存 Codex 恢复备份失败")?;
    if !home.exists() {
        fs::create_dir_all(home).map_err(|_| "创建 Codex 默认目录失败")?;
        profile::private_permissions(home, true)?;
    }
    profile::write_private(&home.join("auth.json"), auth)
}

fn restore_profile(
    conn: &rusqlite::Connection,
    home: &std::path::Path,
    decrypt: impl FnOnce(&str) -> Result<String, String>,
) -> Result<(), String> {
    let backup: Option<(Option<String>, String, String)> = conn.query_row("SELECT auth_ciphertext,installed_fingerprint,previous_fingerprint FROM codex_profile_backups WHERE profile_home=?1", [home.to_string_lossy().to_string()], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(|_| "读取 Codex 恢复备份失败")?;
    let (cipher, installed, previous) = backup.ok_or("Codex 恢复备份不存在")?;
    let current = previous_auth(home)?;
    let fingerprint = profile::fingerprint(current.as_deref().map(|s| s.as_str()));
    if fingerprint != installed && fingerprint != previous {
        return Err("Codex 认证文件已被客户端更新，未覆盖当前登录状态".into());
    }
    if fingerprint != previous {
        if let Some(cipher) = cipher {
            let content =
                zeroize::Zeroizing::new(decrypt(&cipher).map_err(|_| "解密 Codex 恢复备份失败")?);
            profile::write_private(&home.join("auth.json"), &content)?;
        } else {
            fs::remove_file(home.join("auth.json")).map_err(|_| "恢复 Codex 未登录状态失败")?;
        }
    }
    conn.execute(
        "DELETE FROM codex_profile_backups WHERE profile_home=?1",
        [home.to_string_lossy().to_string()],
    )
    .map_err(|_| "清理 Codex 恢复备份失败")?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn codex_prepare_switch(
    app: tauri::AppHandle,
    id: i64,
) -> PlatformResult<SwitchPreview> {
    tauri::async_runtime::spawn_blocking(move || -> Result<SwitchPreview, String> {
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        let home = switch_home()?;
        if super::codex_instances::account_running_except_target(
            &app.state::<super::codex_runtime::CodexRuntimeStore>(),
            id,&home,
        )? {
            return Err(super::codex_instances::account_busy_error(&app.state::<super::codex_runtime::CodexRuntimeStore>(), id, "切换默认账号")?);
        }
        repository::get(&open_db()?, id)?;
        if crate::core::codex::providers::is_provider_account(&open_db()?,id)? {return Err("请通过模型供应商启动预览应用此账号".into());}
        auth::ensure_runtime_auth(&repository::credentials(&open_db()?, id)?)?;
        // Preparing a confirmation must not mutate the target or its bindings.
        crate::core::codex::config_history::ensure_ready(&open_db()?,&home)?;
        let account = repository::get(&open_db()?, id)?;
        let previous = previous_auth(&home)?;
        let token = uuid::Uuid::new_v4().to_string();
        *SWITCH_TICKET.lock().map_err(|_| "Codex 切号状态不可用")? = Some(SwitchTicket {
            token: token.clone(),
            id,
            version: account.updated_at,
            fingerprint: crate::core::codex::config_history::version(&open_db()?,&home,None)?,
            expires: Instant::now() + Duration::from_secs(90),
        });
        Ok(SwitchPreview {
            token,
            account_label: account.label,
            profile_home: home.to_string_lossy().into_owned(),
            has_previous_auth: previous.is_some(),
        })
    })
    .await
    .map_err(|_| "准备 Codex 切号任务失败")?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_close_default_processes(
    app: tauri::AppHandle,
) -> PlatformResult<()> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        super::codex_instances::ensure_runtime_idle(
            &app.state::<super::codex_runtime::CodexRuntimeStore>(),
        )?;
        profile::close_default_processes()
    })
    .await
    .map_err(|_| "关闭 Codex 客户端任务失败")?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_confirm_switch(
    app: tauri::AppHandle,
    token: String,
) -> PlatformResult<SwitchResult> {
    tauri::async_runtime::spawn_blocking(move || -> Result<SwitchResult, String> {
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        let ticket = SWITCH_TICKET
            .lock()
            .map_err(|_| "Codex 切号状态不可用")?
            .take()
            .filter(|v| v.token == token && v.expires > Instant::now())
            .ok_or("切号确认已过期，请重新选择账号")?;
        let mut conn = open_db()?;
        let home = switch_home()?;
        let _target=crate::core::codex::target_lock::TargetLock::acquire(&home)?;
        if super::codex_instances::account_running_except_target(
            &app.state::<super::codex_runtime::CodexRuntimeStore>(),
            ticket.id,&home,
        )? {
            return Err(super::codex_instances::account_busy_error(&app.state::<super::codex_runtime::CodexRuntimeStore>(), ticket.id, "切换默认账号")?);
        }
        if repository::get(&conn, ticket.id)?.updated_at != ticket.version {
            return Err("Codex 账号已变更，请重新确认切号".into());
        }
        if crate::core::codex::providers::is_provider_account(&conn, ticket.id)? {
            return Err("请通过模型供应商启动预览应用此账号".into());
        }
        if crate::core::codex::config_history::version(&conn,&home,None)? != ticket.fingerprint {
            return Err("Codex 登录状态已变更，未执行切号，请重新确认".into());
        }
        crate::core::codex::config_history::migrate_legacy(&conn)?;
        crate::core::codex::provider_oauth::sync_before_replace(&conn,&home)?;
        let operation_version=crate::core::codex::config_history::version(&conn,&home,None)?;
        let (config,removed_overrides) = crate::core::codex::provider_config::official_config(&home)?;
        let auth = repository::credentials(&conn, ticket.id)?;
        auth::ensure_runtime_auth(&auth)?;
        let intended=vec![crate::core::codex::config_history::SavedFile{name:"config.toml".into(),content:config.map(|s|s.to_string())},crate::core::codex::config_history::SavedFile{name:"auth.json".into(),content:Some(auth.to_string())}];
        crate::core::codex::config_history::execute_checked(&mut conn,&home,None,"account",Some(&operation_version),intended,|tx|crate::core::codex::config_history::clear_bindings(tx,&home))?;
        app.state::<super::codex_runtime::CodexRuntimeStore>().provider_gateways.lock().map_err(|_| "供应商网关状态不可用")?.remove(home.to_string_lossy().as_ref());
        Ok(SwitchResult { state: state()?, removed_overrides })
    })
    .await
    .map_err(|_| "执行 Codex 切号任务失败")?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_restore_profile() -> PlatformResult<CodexState> {
    tauri::async_runtime::spawn_blocking(|| -> Result<CodexState, String> {
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        let home = switch_home()?;
        let _target=crate::core::codex::target_lock::TargetLock::acquire(&home)?;
        let conn = open_db()?;
        crate::core::codex::providers::ensure_home_unbound(&conn,&home)?;
        restore_profile(&conn, &home, decrypt_secret)?;
        state()
    })
    .await
    .map_err(|_| "恢复 Codex 登录任务失败")?
    .map_err(Into::into)
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    use crate::core::crypto::{decrypt_secret_with_key, encrypt_secret_with_key};
    use std::path::PathBuf;

    #[test]
    fn normalizes_sub2api_and_cpa_credentials_for_the_codex_importer() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        use serde_json::json;
        let id_token = format!(
            "fixture.{}.signature",
            URL_SAFE_NO_PAD.encode(json!({"sub":"user-fixture","https://api.openai.com/auth":{"chatgpt_account_id":"account-fixture","chatgpt_user_id":"user-fixture"}}).to_string())
        );
        let oauth = json!({"access_token":"access-fixture","id_token":id_token.clone(),"refresh_token":"refresh-fixture","chatgpt_account_id":"account-fixture"});
        let mut sub2api = json!({"accounts":[{"type":"oauth","credentials":oauth}]});
        normalize_import_value(&mut sub2api, "sub2api").unwrap();
        assert_eq!(auth::parse_import(&sub2api.to_string()).unwrap().len(), 1);

        let mut cpa = json!({"access_token":"access-fixture","id_token":id_token,"refresh_token":"refresh-fixture","account_id":"account-fixture"});
        normalize_import_value(&mut cpa, "cpa").unwrap();
        assert_eq!(auth::parse_import(&cpa.to_string()).unwrap().len(), 1);
    }

    struct Fixture {
        home: PathBuf,
        conn: rusqlite::Connection,
    }
    impl Fixture {
        fn new() -> Self {
            let home = std::env::temp_dir()
                .join(format!("cloudhub-codex-recovery-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&home).unwrap();
            profile::write_private(&home.join("config.toml"), "# fixture settings remain\n")
                .unwrap();
            let conn = rusqlite::Connection::open_in_memory().unwrap();
            conn.execute_batch(crate::core::database::CODEX_SCHEMA)
                .unwrap();
            Self { home, conn }
        }
        fn install(&self, previous: Option<&str>) -> Result<(), String> {
            install_profile(
                &self.conn,
                &self.home,
                "invalid-test-new-login",
                previous,
                |v| encrypt_secret_with_key(v, &[17; 32]),
            )
        }
        fn restore(&self) -> Result<(), String> {
            restore_profile(&self.conn, &self.home, |v| {
                decrypt_secret_with_key(v, &[17; 32])
            })
        }
        fn backup_count(&self) -> i64 {
            self.conn
                .query_row("SELECT COUNT(*) FROM codex_profile_backups", [], |row| {
                    row.get(0)
                })
                .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.home);
        }
    }

    #[test]
    fn switch_and_restore_preserve_settings_with_encrypted_recovery() {
        let f = Fixture::new();
        profile::write_private(&f.home.join("auth.json"), "invalid-test-old-login").unwrap();
        f.install(Some("invalid-test-old-login")).unwrap();
        let cipher: String = f
            .conn
            .query_row(
                "SELECT auth_ciphertext FROM codex_profile_backups",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!cipher.contains("invalid-test-old-login"));
        assert_eq!(
            decrypt_secret_with_key(&cipher, &[17; 32]).unwrap(),
            "invalid-test-old-login"
        );
        f.restore().unwrap();
        assert_eq!(
            profile::read_auth(&f.home.join("auth.json"))
                .unwrap()
                .as_str(),
            "invalid-test-old-login"
        );
        assert_eq!(
            fs::read_to_string(f.home.join("config.toml")).unwrap(),
            "# fixture settings remain\n"
        );
        assert_eq!(f.backup_count(), 0);
    }

    #[test]
    fn restore_refuses_external_changes_and_keeps_the_recovery_point() {
        let f = Fixture::new();
        f.install(Some("invalid-test-old-login")).unwrap();
        profile::write_private(&f.home.join("auth.json"), "invalid-test-external-login").unwrap();
        assert!(f.restore().is_err());
        assert_eq!(
            profile::read_auth(&f.home.join("auth.json"))
                .unwrap()
                .as_str(),
            "invalid-test-external-login"
        );
        assert_eq!(f.backup_count(), 1);
    }

    #[test]
    fn failed_projection_keeps_durable_backup_and_can_clear_after_rollback() {
        let f = Fixture::new();
        // A directory at the destination forces the real atomic rename to fail.
        fs::create_dir(f.home.join("auth.json")).unwrap();
        assert!(f.install(Some("invalid-test-old-login")).is_err());
        assert_eq!(f.backup_count(), 1);
        fs::remove_dir(f.home.join("auth.json")).unwrap();
        profile::write_private(&f.home.join("auth.json"), "invalid-test-old-login").unwrap();
        f.restore().unwrap();
        assert_eq!(f.backup_count(), 0);
    }

    #[test]
    fn restore_can_return_to_logged_out_state_and_reject_failed_encryption() {
        let f = Fixture::new();
        assert!(install_profile(
            &f.conn,
            &f.home,
            "invalid-test-new-login",
            Some("invalid-test-old-login"),
            |_| Err("fixture encryption failure".into())
        )
        .is_err());
        assert_eq!(f.backup_count(), 0);
        assert!(!f.home.join("auth.json").exists());
        f.install(None).unwrap();
        f.restore().unwrap();
        assert!(!f.home.join("auth.json").exists());
        assert_eq!(f.backup_count(), 0);
        assert!(f.home.join("config.toml").is_file());
    }
}

#[tauri::command]
pub(crate) fn codex_remote_logs() -> PlatformResult<crate::core::codex::remote_logs::LogState> {
    crate::core::codex::remote_logs::state().map_err(Into::into)
}
#[tauri::command]
pub(crate) fn codex_remote_log_detail(
    id: String,
) -> PlatformResult<crate::core::codex::gateway_controls::CallDetail> {
    crate::core::codex::remote_logs::detail(&id).map_err(Into::into)
}
#[tauri::command]
pub(crate) fn codex_remote_logs_configure(
    enabled: bool,
) -> PlatformResult<crate::core::codex::remote_logs::LogState> {
    crate::core::codex::remote_logs::configure_saved(&open_db()?, enabled).map_err(Into::into)
}
#[tauri::command]
pub(crate) fn codex_remote_logs_clear() -> PlatformResult<crate::core::codex::remote_logs::LogState>
{
    crate::core::codex::remote_logs::clear().map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_detect_proxies(
) -> PlatformResult<Vec<crate::core::codex::proxy_detection::ProxyCandidate>> {
    tauri::async_runtime::spawn_blocking(crate::core::codex::proxy_detection::detect)
        .await
        .map_err(|_| "读取本机代理配置失败，请手动填写代理地址")?
        .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_save_proxies(
    app: tauri::AppHandle,
    ids: Vec<i64>,
    url: String,
) -> PlatformResult<Vec<CodexAccountSummary>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        let _writer = AUTH_WRITER.lock().map_err(|_| "账号操作不可用")?;
        crate::core::codex::account_controls::validate_proxy(&url)?;
        if ids.is_empty() || ids.len() > 1000 || ids.iter().any(|id| *id <= 0) {
            return Err("请选择 1–1000 个有效账号后批量设置代理".into());
        }
        let store = app.state::<super::codex_runtime::CodexRuntimeStore>();
        for id in &ids {
            if super::codex_instances::account_running(&store, *id)? {
                return Err(super::codex_instances::account_busy_error(&store, *id, "批量设置代理（未修改任何账号）")?);
            }
        }
        crate::core::codex::account_controls::save_proxies(&mut open_db()?, &ids, &url)
    })
    .await
    .map_err(|_| "批量保存代理任务失败")?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_save_proxy(
    app: tauri::AppHandle,
    id: i64,
    url: String,
) -> PlatformResult<CodexAccountSummary> {
    tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        crate::core::codex::account_controls::validate_proxy(&url)?;
        let _writer = AUTH_WRITER.lock().map_err(|_| "账号操作不可用")?;
        let conn = open_db()?;
        repository::get(&conn, id)?;
        if super::codex_instances::account_running(
            &app.state::<super::codex_runtime::CodexRuntimeStore>(),
            id,
        )? {
            return Err(super::codex_instances::account_busy_error(&app.state::<super::codex_runtime::CodexRuntimeStore>(), id, "修改代理")?);
        }
        crate::core::codex::account_controls::save_proxy(&conn, id, &url)?;
        repository::get(&conn, id)
    })
    .await
    .map_err(|_| "保存账号代理任务失败")?
    .map_err(Into::into)
}
#[tauri::command]
pub(crate) async fn codex_refresh_benefits(app: tauri::AppHandle, id: i64) -> PlatformResult<CodexAccountSummary> {
    tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        use crate::core::codex::{account_controls as controls, gateway};
        let _writer = AUTH_WRITER.lock().map_err(|_| "账号操作不可用")?;
        let _lease = refresh_lease(&app, id, "订阅权益刷新")?;
        let conn = open_db()?;
        let mut summary = repository::get(&conn, id)?;
        if summary.auth_mode != "chatgpt" {
            return Err("API Key 账号无订阅权益".into());
        }
        drop(_writer);
        let (token, account, proxy) = gateway::credentials_locked(
            id,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )?;

        let account = account.ok_or("账号标识无效")?;
        let client = controls::client(proxy.as_deref())?;
        tauri::async_runtime::block_on(async {
            match controls::request(
                &client,
                &token,
                &account,
                id,
                proxy.as_deref(),
                "accounts/check/v4-2023-04-27",
                None,
            )
            .await
            {
                Ok(value) => {
                    let expiry = controls::parse_subscription(&value, &account);
                    if expiry.is_some_and(|time| time > chrono::Utc::now().timestamp()) {
                        summary.benefits.expires_at = expiry;
                        summary.benefits.subscription_error = None;
                    } else {
                        match controls::request(
                            &client,
                            &token,
                            &account,
                            id,
                            proxy.as_deref(),
                            "subscriptions",
                            None,
                        )
                        .await
                        {
                            Ok(value) => {
                                summary.benefits.expires_at =
                                    controls::parse_subscription(&value, &account).or(expiry);
                                summary.benefits.subscription_error = None;
                            }
                            Err(error) => summary.benefits.subscription_error = Some(error),
                        }
                    }
                }
                Err(error) => summary.benefits.subscription_error = Some(error),
            }
            match controls::request(
                &client,
                &token,
                &account,
                id,
                proxy.as_deref(),
                "wham/rate-limit-reset-credits",
                None,
            )
            .await
            .and_then(|value| {
                let cards=controls::parse_reset_cards(&value,chrono::Utc::now().timestamp());
                controls::parse_credits(&value, chrono::Utc::now().timestamp()).map(|parsed|(parsed,cards))
            })
            {
                Ok(((count, expiry),cards)) => {
                    summary.benefits.reset_credits = Some(count);
                    summary.benefits.reset_expires_at = expiry;
                    summary.benefits.reset_cards = cards;
                    summary.benefits.credits_error = None;
                }
                Err(error) => summary.benefits.credits_error = Some(error),
            }
        });
        summary.benefits.fetched_at = Some(chrono::Utc::now().timestamp_millis());
        controls::save_benefits(&conn, id, &summary.benefits)?;
        repository::get(&conn, id)
    })
    .await
    .map_err(|_| "刷新账号权益任务失败")?
    .map_err(Into::into)
}
#[tauri::command]
pub(crate) async fn codex_consume_reset(
    app: tauri::AppHandle,
    id: i64,
) -> PlatformResult<CodexAccountSummary> {
    tauri::async_runtime::spawn_blocking(move || -> Result<_,String> {
        use crate::core::codex::{account_controls as controls,gateway};
        let _writer=AUTH_WRITER.lock().map_err(|_|"账号操作不可用")?;
        let conn=open_db()?; let summary=repository::get(&conn,id)?;
        if summary.auth_mode!="chatgpt" {return Err("API Key 账号无法使用主动重置".into());}
        if super::codex_instances::account_running(&app.state::<super::codex_runtime::CodexRuntimeStore>(),id)? {return Err(super::codex_instances::account_busy_error(&app.state::<super::codex_runtime::CodexRuntimeStore>(), id, "重置额度")?);}
        let (token,account,proxy)=gateway::credentials_locked(id,std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)))?;
        let account=account.ok_or("账号标识无效")?; let client=controls::client(proxy.as_deref())?;
        let existing:Option<String>=rusqlite::OptionalExtension::optional(conn.query_row("SELECT reset_request_id FROM codex_account_controls WHERE account_id=?1",[id],|r|r.get::<_,Option<String>>(0))).map_err(|_|"读取重置请求标识失败")?.flatten();
        let request_id=existing.unwrap_or_else(||uuid::Uuid::new_v4().to_string());
        let value=tauri::async_runtime::block_on(controls::request(&client,&token,&account,id,proxy.as_deref(),"wham/rate-limit-reset-credits",None))?;
        let (count,_)=controls::parse_credits(&value,chrono::Utc::now().timestamp())?;
        if count==0 {return Err("账号没有可用的主动重置次数".into());}
        conn.execute("INSERT INTO codex_account_controls(account_id,reset_request_id) VALUES(?1,?2) ON CONFLICT(account_id) DO UPDATE SET reset_request_id=excluded.reset_request_id",rusqlite::params![id,request_id]).map_err(|_|"保存重置请求标识失败")?;
        tauri::async_runtime::block_on(controls::request(&client,&token,&account,id,proxy.as_deref(),"wham/rate-limit-reset-credits/consume",Some(&request_id)))?;
        // Leave the request ID persisted if the result is uncertain; explicit retries reuse it.
        // Invalidate stale counts before the UI can offer another reset.
        let tx=conn.unchecked_transaction().map_err(|_|"重置已完成，但本地状态未更新，请刷新账号信息")?;
        tx.execute("UPDATE codex_account_controls SET benefits_json=NULL,reset_request_id=NULL WHERE account_id=?1",[id]).map_err(|_|"重置已完成，但本地状态未更新，请刷新账号信息")?;
        tx.execute("UPDATE codex_accounts SET quota_json='{}' WHERE id=?1",[id]).map_err(|_|"重置已完成，但额度缓存未清除")?;
        tx.commit().map_err(|_|"重置已完成，但本地状态未更新，请刷新账号信息")?;
        repository::get(&conn,id)
    }).await.map_err(|_|"主动重置任务失败，请先刷新次数确认结果")?.map_err(Into::into)
}
