use crate::core::{
    codex::{auth, profile, rpc, AccountMetadataInput, CodexAccountSummary},
    error::PlatformResult,
    repositories::codex_accounts as repository,
    storage::{decrypt_secret, encrypt_secret, open_db},
};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::{
    fs,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

// Auth import/refresh/switch share one writer. It also bounds simultaneous CLI processes.
pub(crate) use crate::core::codex::AUTH_WRITER;
static SWITCH_TICKET: Mutex<Option<SwitchTicket>> = Mutex::new(None);
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
    let mut conn = open_db()?;
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
            if super::codex_instances::account_running(&store, id)? {
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
pub(crate) async fn codex_open_default(app: tauri::AppHandle) -> PlatformResult<()> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        let store = app.state::<super::codex_runtime::CodexRuntimeStore>();
        if store.closing.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("应用正在退出，未打开 Codex".into());
        }
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
pub(crate) async fn codex_import_file(app: tauri::AppHandle) -> PlatformResult<Option<CodexState>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<CodexState>, String> {
        let Some(selected) = app
            .dialog()
            .file()
            .set_title("导入 Codex 账号 JSON（包含登录凭据）")
            .add_filter("JSON", &["json"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|_| "Codex 导入文件路径无效")?;
        let content = profile::read_auth(&path)?;
        let accounts = auth::parse_import(&content)?;
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        import_accounts(&app, accounts)?;
        state().map(Some)
    })
    .await
    .map_err(|_| "导入 Codex 文件任务失败")?
    .map_err(Into::into)
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
            return Err("该账号有实例运行，请先停止实例再删除".into());
        }
        let conn = open_db()?;
        super::codex_instances::clear_account_projections(&conn, id)?;
        if conn
            .execute("DELETE FROM codex_accounts WHERE id=?1", [id])
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
        if super::codex_instances::account_running(&app.state::<super::codex_runtime::CodexRuntimeStore>(),id)? { return Err("该账号有实例运行，请先停止实例再刷新，避免凭据更新冲突".into()); }
        let conn = open_db()?;
        let account = repository::get(&conn, id)?;
        if account.auth_mode != "chatgpt" { return Err("API Key 账号不提供 ChatGPT 订阅额度".into()); }
        if account.quota.fetched_at.is_some_and(|time| chrono::Utc::now().timestamp_millis() - time < 30_000) { return Err("额度刚刚刷新，请在 30 秒后重试".into()); }
        let auth_json = repository::credentials(&conn, id)?;
        let original = auth::parse_import(&auth_json)?.remove(0);
        // A default client's refresh token belongs to that client. Use only its latest
        // access token for monitoring, so our temporary CLI cannot rotate its login away.
        let default_auth = profile::default_home().ok().and_then(|home| profile::read_auth(&home.join("auth.json")).ok()).and_then(|content| auth::parse_import(&content).ok()).and_then(|mut accounts| accounts.pop()).filter(|v| v.identity == original.identity);
        let external = default_auth.is_some();
        let monitored = default_auth.unwrap_or(original);
        let isolated = profile::TemporaryProfile::new(if external { "{}" } else { &monitored.auth_json })?;
        let mut api_log=crate::core::codex::remote_logs::RemoteTrace::new(Some(id),"cli_rpc","account/rateLimits/read","官方 CLI 内部远端请求（HTTP 地址及请求头不可见）",account.proxy_url.as_deref());
        api_log.request(&serde_json::json!({"rpcMethod":"account/rateLimits/read","params":{},"timeoutMs":30000,"headersAvailable":false,"note":"额度由官方 CLI 查询，无法采集其内部 HTTP 请求头、状态码或重试"}));
        let fetched = (|| {
            let mut server = rpc::AppServer::start_cancelled_proxy(&isolated.path,None,account.proxy_url.as_deref())?;
            if external {
                let credentials: serde_json::Value = serde_json::from_str(&monitored.auth_json).map_err(|_| "Codex 登录数据无效")?;
                let access = credentials.pointer("/tokens/access_token").and_then(serde_json::Value::as_str).ok_or("Codex 登录数据无效")?;
                server.request("account/login/start", serde_json::json!({"type":"chatgptAuthTokens","accessToken":access,"chatgptAccountId":monitored.account_id,"chatgptPlanType":monitored.plan}), Duration::from_secs(20))?;
            }
            let info = server.request("account/read", serde_json::json!({"refreshToken":!external}), Duration::from_secs(30))?;
            let limits = server.request("account/rateLimits/read", serde_json::json!({}), Duration::from_secs(30))?;
            api_log.response(&limits);
            let plan = info.get("account").and_then(|v| v.get("planType")).and_then(serde_json::Value::as_str).filter(|v| v.len() <= 80).map(str::to_owned);
            Ok::<_, String>((rpc::parse_quota(&limits)?, plan))
        })();
        api_log.finish(if fetched.is_ok(){"completed"}else{"cli_error"});
        let updated = if external { monitored.auth_json } else { profile::read_auth(&isolated.path.join("auth.json"))? };
        let imported = auth::parse_import(&updated)?.remove(0);
        if imported.identity != monitored.identity { return Err("Codex 刷新返回了不同账号，认证状态未保存".into()); }
        match fetched {
            Ok((quota, plan)) => repository::save_refresh(&conn, id, account.updated_at, &imported.auth_json, Some(&quota), plan.as_deref(), None)?,
            Err(error) => repository::save_refresh(&conn, id, account.updated_at, &imported.auth_json, None, None, Some(&error))?,
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
        Ok(_) => profile::read_auth(&path).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("检查 Codex 认证文件失败".into()),
    }
}

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
        if super::codex_instances::account_running(
            &app.state::<super::codex_runtime::CodexRuntimeStore>(),
            id,
        )? {
            return Err("该账号有实例运行，请先停止实例再切换默认账号".into());
        }
        let account = repository::get(&open_db()?, id)?;
        let home = switch_home()?;
        let previous = previous_auth(&home)?;
        let token = uuid::Uuid::new_v4().to_string();
        *SWITCH_TICKET.lock().map_err(|_| "Codex 切号状态不可用")? = Some(SwitchTicket {
            token: token.clone(),
            id,
            version: account.updated_at,
            fingerprint: profile::fingerprint(previous.as_deref().map(|s| s.as_str())),
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
pub(crate) async fn codex_confirm_switch(
    app: tauri::AppHandle,
    token: String,
) -> PlatformResult<CodexState> {
    tauri::async_runtime::spawn_blocking(move || -> Result<CodexState, String> {
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        let ticket = SWITCH_TICKET
            .lock()
            .map_err(|_| "Codex 切号状态不可用")?
            .take()
            .filter(|v| v.token == token && v.expires > Instant::now())
            .ok_or("切号确认已过期，请重新选择账号")?;
        let conn = open_db()?;
        if super::codex_instances::account_running(
            &app.state::<super::codex_runtime::CodexRuntimeStore>(),
            ticket.id,
        )? {
            return Err("该账号有实例运行，未执行切换，请先停止实例".into());
        }
        if repository::get(&conn, ticket.id)?.updated_at != ticket.version {
            return Err("Codex 账号已变更，请重新确认切号".into());
        }
        let home = switch_home()?;
        let previous = previous_auth(&home)?;
        if profile::fingerprint(previous.as_deref().map(|s| s.as_str())) != ticket.fingerprint {
            return Err("Codex 登录状态已变更，未执行切号，请重新确认".into());
        }
        let auth = repository::credentials(&conn, ticket.id)?;
        install_profile(
            &conn,
            &home,
            &auth,
            previous.as_deref().map(|s| s.as_str()),
            encrypt_secret,
        )?;
        state()
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
        let conn = open_db()?;
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
pub(crate) fn codex_remote_logs() -> PlatformResult<crate::core::codex::remote_logs::LogState> { crate::core::codex::remote_logs::state().map_err(Into::into) }
#[tauri::command]
pub(crate) fn codex_remote_log_detail(id: String) -> PlatformResult<crate::core::codex::gateway_controls::CallDetail> { crate::core::codex::remote_logs::detail(&id).map_err(Into::into) }
#[tauri::command]
pub(crate) fn codex_remote_logs_configure(enabled: bool) -> PlatformResult<crate::core::codex::remote_logs::LogState> { crate::core::codex::remote_logs::configure(enabled).map_err(Into::into) }
#[tauri::command]
pub(crate) fn codex_remote_logs_clear() -> PlatformResult<crate::core::codex::remote_logs::LogState> { crate::core::codex::remote_logs::clear().map_err(Into::into) }

#[tauri::command]
pub(crate) async fn codex_detect_proxies() -> PlatformResult<Vec<crate::core::codex::proxy_detection::ProxyCandidate>> {
    tauri::async_runtime::spawn_blocking(crate::core::codex::proxy_detection::detect)
        .await.map_err(|_| "读取本机代理配置失败，请手动填写代理地址")?.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_save_proxies(app: tauri::AppHandle, ids: Vec<i64>, url: String) -> PlatformResult<Vec<CodexAccountSummary>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        let _writer = AUTH_WRITER.lock().map_err(|_| "账号操作不可用")?;
        crate::core::codex::account_controls::validate_proxy(&url)?;
        if ids.is_empty() || ids.len() > 1000 || ids.iter().any(|id| *id <= 0) {
            return Err("请选择 1–1000 个有效账号后批量设置代理".into());
        }
        let store = app.state::<super::codex_runtime::CodexRuntimeStore>();
        for id in &ids {
            if super::codex_instances::account_running(&store, *id)? {
                return Err("所选账号中有服务、实例或唤醒任务运行，请先停止后批量设置代理；未修改任何账号".into());
            }
        }
        crate::core::codex::account_controls::save_proxies(&mut open_db()?, &ids, &url)
    }).await.map_err(|_| "批量保存代理任务失败")?.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_save_proxy(app:tauri::AppHandle,id:i64,url:String)->PlatformResult<CodexAccountSummary> {
    tauri::async_runtime::spawn_blocking(move || -> Result<_,String> {
        crate::core::codex::account_controls::validate_proxy(&url)?;
        let _writer=AUTH_WRITER.lock().map_err(|_|"账号操作不可用")?;
        let conn=open_db()?; repository::get(&conn,id)?;
        if super::codex_instances::account_running(&app.state::<super::codex_runtime::CodexRuntimeStore>(),id)? {return Err("请先停止该账号的服务或实例，再修改代理".into());}
        crate::core::codex::account_controls::save_proxy(&conn,id,&url)?; repository::get(&conn,id)
    }).await.map_err(|_|"保存账号代理任务失败")?.map_err(Into::into)
}
#[tauri::command]
pub(crate) async fn codex_refresh_benefits(id:i64)->PlatformResult<CodexAccountSummary> {
    tauri::async_runtime::spawn_blocking(move || -> Result<_,String> {
        use crate::core::codex::{account_controls as controls,gateway};
        let _writer=AUTH_WRITER.lock().map_err(|_|"账号操作不可用")?;
        let conn=open_db()?; let mut summary=repository::get(&conn,id)?;
        if summary.auth_mode!="chatgpt" {return Err("API Key 账号无订阅权益".into());}
        let (token,account,proxy)=gateway::credentials_locked(id,std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)))?;
        let account=account.ok_or("账号标识无效")?; let client=controls::client(proxy.as_deref())?;
        tauri::async_runtime::block_on(async {
            match controls::request(&client,&token,&account,id,proxy.as_deref(),"accounts/check/v4-2023-04-27",None).await {
                Ok(value)=>{
                    let expiry=controls::parse_subscription(&value,&account);
                    if expiry.is_some_and(|time|time>chrono::Utc::now().timestamp()) {
                        summary.benefits.expires_at=expiry;summary.benefits.subscription_error=None;
                    } else {
                        match controls::request(&client,&token,&account,id,proxy.as_deref(),"subscriptions",None).await {
                            Ok(value)=>{summary.benefits.expires_at=controls::parse_subscription(&value,&account).or(expiry);summary.benefits.subscription_error=None;},
                            Err(error)=>summary.benefits.subscription_error=Some(error),
                        }
                    }
                },
                Err(error)=>summary.benefits.subscription_error=Some(error),
            }
            match controls::request(&client,&token,&account,id,proxy.as_deref(),"wham/rate-limit-reset-credits",None).await.and_then(|value|controls::parse_credits(&value,chrono::Utc::now().timestamp())) {
                Ok((count,expiry))=>{summary.benefits.reset_credits=Some(count);summary.benefits.reset_expires_at=expiry;summary.benefits.credits_error=None;},
                Err(error)=>summary.benefits.credits_error=Some(error),
            }
        });
        summary.benefits.fetched_at=Some(chrono::Utc::now().timestamp_millis());
        controls::save_benefits(&conn,id,&summary.benefits)?; repository::get(&conn,id)
    }).await.map_err(|_|"刷新账号权益任务失败")?.map_err(Into::into)
}
#[tauri::command]
pub(crate) async fn codex_consume_reset(app:tauri::AppHandle,id:i64)->PlatformResult<CodexAccountSummary> {
    tauri::async_runtime::spawn_blocking(move || -> Result<_,String> {
        use crate::core::codex::{account_controls as controls,gateway};
        let _writer=AUTH_WRITER.lock().map_err(|_|"账号操作不可用")?;
        let conn=open_db()?; let summary=repository::get(&conn,id)?;
        if summary.auth_mode!="chatgpt" {return Err("API Key 账号无法使用主动重置".into());}
        if super::codex_instances::account_running(&app.state::<super::codex_runtime::CodexRuntimeStore>(),id)? {return Err("请先停止该账号的服务或实例，再重置额度".into());}
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
