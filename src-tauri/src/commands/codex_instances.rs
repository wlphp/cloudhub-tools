use super::{codex::AUTH_WRITER, codex_runtime::CodexRuntimeStore};
use crate::core::{
    codex::{auth, profile},
    error::PlatformResult,
    paths::data_dir,
    repositories::codex_accounts as repository,
    storage::open_db,
};
use rusqlite::params;
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

pub(crate) struct ManagedInstance {
    pub account_id: i64,
    pub path: PathBuf,
    pub child: Child,
    #[cfg(windows)]
    job: crate::core::codex::process::OwnedJob,
}

pub(crate) fn terminate(child: &mut Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill.exe")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-TERM", "--", &format!("-{}", child.id())])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

impl ManagedInstance {
    fn stop(&mut self) {
        #[cfg(windows)]
        self.job.terminate();
        terminate(&mut self.child);
    }
}
impl Drop for ManagedInstance {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstanceSummary {
    id: String,
    account_id: i64,
    name: String,
    work_dir: String,
    kind: String,
    running: bool,
    last_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstanceBindResult {
    instances: Vec<InstanceSummary>,
    // 绑定时从实例 config.toml 移除的第三方接管摘要，供界面提示官方直连与官方模型列表已恢复。
    removed_overrides: Option<String>,
}

fn instance_path(id: &str) -> Result<PathBuf, String> {
    let id = uuid::Uuid::parse_str(id).map_err(|_| "Codex 实例标识无效")?;
    let root = data_dir()?.join("codex-instances");
    fs::create_dir_all(&root).map_err(|_| "创建 Codex 实例目录失败")?;
    if fs::symlink_metadata(&root)
        .map_err(|_| "检查 Codex 实例目录失败")?
        .file_type()
        .is_symlink()
    {
        return Err("Codex 实例目录不能是链接".into());
    }
    profile::private_permissions(&root, true)?;
    let path = root.join(id.to_string());
    if path.exists() {
        if fs::symlink_metadata(&path)
            .map_err(|_| "检查 Codex 实例失败")?
            .file_type()
            .is_symlink()
            || !path.is_dir()
        {
            return Err("Codex 实例目录类型无效".into());
        }
    } else {
        fs::create_dir(&path).map_err(|_| "创建 Codex 实例失败")?;
    }
    profile::private_permissions(&path, true)?;
    Ok(path)
}

#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LaunchConfig {
    version: String,
    model: Option<String>,
    context_window: Option<i64>,
    compact_limit: Option<i64>,
}

pub(crate) fn config_home(store: &CodexRuntimeStore, id: Option<&str>, writing: bool) -> Result<PathBuf, String> {
    if let Some(id) = id {
        let _: i64 = open_db()?.query_row("SELECT account_id FROM codex_profiles WHERE id=?1", [id], |row| row.get(0)).map_err(|_| "Codex 实例不存在")?;
        if writing && store.instances.lock().map_err(|_| "Codex 实例状态不可用")?.contains_key(id) { return Err("请先停止实例再修改启动配置".into()); }
        instance_path(id)
    } else {
        let home = profile::default_home()?;
        if home.exists() && fs::symlink_metadata(&home).map_err(|_| "检查 Codex 目录失败")?.file_type().is_symlink() { return Err("默认 Codex 目录为链接，请使用独立实例".into()); }
        if writing { profile::ensure_default_idle()?; }
        Ok(home)
    }
}

fn config_content(home: &Path) -> Result<Option<zeroize::Zeroizing<String>>, String> {
    match fs::symlink_metadata(home.join("config.toml")) {
        Ok(_) => profile::read_auth(&home.join("config.toml")).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("读取 Codex 启动配置失败".into()),
    }
}

#[tauri::command]
pub(crate) async fn codex_launch_config(app: tauri::AppHandle, id: Option<String>, input: Option<LaunchConfig>) -> PlatformResult<LaunchConfig> {
    tauri::async_runtime::spawn_blocking(move || -> Result<LaunchConfig, String> {
        use crate::core::codex::rpc;
        use serde_json::json;
        use std::time::Duration;
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        let store = app.state::<CodexRuntimeStore>();
        let home = config_home(&store, id.as_deref(), input.is_some())?;
        let _target = if input.is_some() { Some(crate::core::codex::target_lock::TargetLock::acquire(&home)?) } else { None };
        if input.is_some() { crate::core::codex::config_history::ensure_ready(&open_db()?, &home)?; }
        if input.is_some() { crate::core::codex::providers::ensure_home_unbound(&open_db()?, &home)?; }
        let original = config_content(&home)?;
        let version = profile::fingerprint(original.as_ref().map(|v| v.as_str()));
        let isolated = profile::TemporaryProfile::new("{}")?;
        if let Some(content) = &original { profile::write_private(&isolated.path.join("config.toml"), content)?; }
        let mut server = rpc::AppServer::start(&isolated.path)?;
        if let Some(input) = input {
            if input.version != version { return Err("启动配置已被修改，请重新读取后再保存".into()); }
            if input.model.as_ref().is_some_and(|v| v.is_empty() || v.len() > 160 || !v.chars().all(|c| c.is_ascii_alphanumeric() || "-._/:".contains(c)))
                || input.context_window.is_some_and(|v| !(1024..=10_000_000).contains(&v))
                || input.compact_limit.is_some_and(|v| v < 1024 || v > input.context_window.unwrap_or(10_000_000)) {
                return Err("模型名称或上下文参数无效".into());
            }
            let edits = [("model", json!(input.model)), ("model_context_window", json!(input.context_window)), ("model_auto_compact_token_limit", json!(input.compact_limit))]
                .into_iter().map(|(key, value)| json!({"keyPath":key,"value":value,"mergeStrategy":"replace"})).collect::<Vec<_>>();
            server.request("config/batchWrite", json!({"edits":edits,"reloadUserConfig":false}), Duration::from_secs(20))
                .map_err(|_| "官方 CLI 无法保存启动配置，请检查版本或参数")?;
            let updated = profile::read_auth(&isolated.path.join("config.toml"))?;
            if profile::fingerprint(config_content(&home)?.as_ref().map(|v| v.as_str())) != version { return Err("启动配置已被修改，请重新读取后再保存".into()); }
            config_home(&store, id.as_deref(), true)?;
            if !home.exists() { fs::create_dir_all(&home).map_err(|_| "创建 Codex 默认目录失败")?; profile::private_permissions(&home, true)?; }
            profile::write_private(&home.join("config.toml"), &updated)?;
        }
        let response = server.request("config/read", json!({"includeLayers":false}), Duration::from_secs(20)).map_err(|_| "官方 CLI 无法读取启动配置，请检查版本")?;
        let config = &response["config"];
        Ok(LaunchConfig { version: profile::fingerprint(config_content(&home)?.as_ref().map(|v| v.as_str())),
            model: config.get("model").and_then(serde_json::Value::as_str).filter(|v| v.len() <= 160 && v.chars().all(|c| c.is_ascii_alphanumeric() || "-._/:".contains(c))).map(str::to_owned),
            context_window: config.get("model_context_window").and_then(serde_json::Value::as_i64),
            compact_limit: config.get("model_auto_compact_token_limit").and_then(serde_json::Value::as_i64) })
    }).await.map_err(|_| "读取 Codex 启动配置任务失败")?.map_err(Into::into)
}

pub(crate) fn clear_account_projections(
    conn: &rusqlite::Connection,
    account_id: i64,
) -> Result<(), String> {
    let mut statement = conn
        .prepare("SELECT id FROM codex_profiles WHERE account_id=?1")
        .map_err(|_| "读取 Codex 实例失败")?;
    let ids = statement
        .query_map([account_id], |row| row.get::<_, String>(0))
        .map_err(|_| "读取 Codex 实例失败")?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| "读取 Codex 实例失败")?;
    for id in ids {
        clear_projection(&id)?;
    }
    Ok(())
}

fn clear_projection(id: &str) -> Result<(), String> {
    let id = uuid::Uuid::parse_str(id).map_err(|_| "Codex 实例标识无效")?;
    let root = data_dir()?.join("codex-instances");
    if !root.exists() {
        return Ok(());
    }
    if fs::symlink_metadata(&root)
        .map_err(|_| "检查 Codex 实例目录失败")?
        .file_type()
        .is_symlink()
    {
        return Err("Codex 实例目录不能是链接".into());
    }
    let path = root.join(id.to_string());
    let _target=crate::core::codex::target_lock::TargetLock::acquire(&path)?;
    if !path.exists() {
        return Ok(());
    }
    if fs::symlink_metadata(&path)
        .map_err(|_| "检查 Codex 实例目录失败")?
        .file_type()
        .is_symlink()
        || !path.is_dir()
    {
        return Err("Codex 实例目录类型无效".into());
    }
    let auth = path.join("auth.json");
    match fs::symlink_metadata(&auth) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.is_file() {
                return Err("Codex 认证文件类型无效，未删除".into());
            }
            fs::remove_file(auth).map_err(|_| "删除实例登录凭据失败，请检查占用与权限".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("检查实例登录凭据失败".into()),
    }
}

#[tauri::command]
pub(crate) async fn codex_delete_instance(
    app: tauri::AppHandle,
    id: String,
) -> PlatformResult<Vec<InstanceSummary>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<InstanceSummary>, String> {
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        let store = app.state::<CodexRuntimeStore>();
        if store
            .instances
            .lock()
            .map_err(|_| "Codex 实例状态不可用")?
            .contains_key(&id)
        {
            return Err("请先停止实例，再删除实例配置".into());
        }
        let conn = open_db()?;
        let _: String = conn
            .query_row("SELECT id FROM codex_profiles WHERE id=?1", [&id], |row| {
                row.get(0)
            })
            .map_err(|_| "Codex 实例不存在")?;
        crate::core::codex::providers::ensure_home_unbound(&conn, &instance_path(&id)?)?;
        clear_projection(&id)?;
        conn.execute("DELETE FROM codex_profiles WHERE id=?1", [&id])
            .map_err(|_| "删除 Codex 实例配置失败")?;
        summaries(&store)
    })
    .await
    .map_err(|_| "删除 Codex 实例任务失败")?
    .map_err(Into::into)
}

fn sync_instance(account_id: i64, path: &Path) -> Result<(), String> {
    let _target=crate::core::codex::target_lock::TargetLock::acquire(path)?;
    sync_instance_locked(account_id,path)
}
fn sync_instance_locked(account_id: i64, path: &Path) -> Result<(), String> {
    if crate::core::codex::provider_oauth::sync_locked(path)? {return Ok(());}
    let conn = open_db()?;
    let account = repository::get(&conn, account_id)?;
    auth::ensure_runtime_auth(&repository::credentials(&conn, account_id)?)?;
    let content = profile::read_auth(&path.join("auth.json"))?;
    let imported = auth::parse_import(&content)?.remove(0);
    let saved = auth::parse_import(&repository::credentials(&conn, account_id)?)?.remove(0);
    if imported.identity != saved.identity {
        return Err("实例已登录不同账号，请使用 JSON 导入，未覆盖原账号凭据".into());
    }
    repository::save_refresh(
        &conn,
        account_id,
        account.updated_at,
        &imported.auth_json,
        None,
        imported.plan.as_deref(),
        None,
    )
}

#[tauri::command]
pub(crate) async fn codex_bind_instance(app: tauri::AppHandle, id: String, account_id: i64) -> PlatformResult<InstanceBindResult> {
    tauri::async_runtime::spawn_blocking(move || -> Result<InstanceBindResult, String> {
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        let store = app.state::<CodexRuntimeStore>();
        let mut conn = open_db()?;
        let path=config_home(&store,Some(&id),true)?;
        let _target=crate::core::codex::target_lock::TargetLock::acquire(&path)?;
        crate::core::codex::config_history::ensure_ready(&conn,&path)?;
        let old: i64 = conn.query_row("SELECT account_id FROM codex_profiles WHERE id=?1", [&id], |row| row.get(0)).map_err(|_| "Codex 实例不存在")?;
        if crate::core::codex::providers::is_provider_account(&conn,account_id)? {return Err("请通过模型供应商启动预览应用此账号".into());}
        for account in [old, account_id] {
            if account_running_except_target(&store, account,&path)? {
                return Err(account_busy_error(&store, account, "切换实例账号")?);
            }
        }
        repository::get(&conn, account_id)?;
        auth::ensure_runtime_auth(&repository::credentials(&conn, account_id)?)?;
        crate::core::codex::config_history::migrate_legacy(&conn)?;
        crate::core::codex::provider_oauth::sync_before_replace(&conn,&path)?;
        if old != account_id && crate::core::codex::provider_oauth::owner(&conn,&path)?.is_none() && !crate::core::codex::providers::is_provider_account(&conn,old)? {
            // Preserve the old account's latest rotated grant before changing binding.
            if path.join("auth.json").exists() {
                let previous: Option<String> = conn.query_row("SELECT auth_fingerprint FROM codex_profiles WHERE id=?1", [&id], |row| row.get(0)).map_err(|_| "读取 Codex 实例失败")?;
                let disk = profile::read_auth(&path.join("auth.json"))?;
                let stored = repository::credentials(&conn, old)?;
                let disk_hash = profile::fingerprint(Some(&disk));
                let stored_hash = profile::fingerprint(Some(&stored));
                let previous = previous.ok_or("实例目录已有登录数据，请创建新实例，未覆盖原文件")?;
                if disk_hash != previous && disk_hash != stored_hash {
                    if previous != stored_hash { return Err("实例与账号凭据均已变更，请新建实例或先导入该实例 auth.json，未覆盖登录状态".into()); }
                    // A stale provider projection is explicitly superseded below;
                    // an ordinary instance still requires a matching identity.
                    if crate::core::codex::provider_oauth::owner(&conn,&path)?.is_none() {sync_instance_locked(old, &path)?;}
                }
            }
        }
        let operation_version=crate::core::codex::config_history::version(&conn,&path,Some(&id))?;
        let (config,removed_overrides)=crate::core::codex::provider_config::official_config(&path)?;
        let auth=repository::credentials(&conn,account_id)?;
        let intended=vec![crate::core::codex::config_history::SavedFile{name:"config.toml".into(),content:config.map(|s|s.to_string())},crate::core::codex::config_history::SavedFile{name:"auth.json".into(),content:Some(auth.to_string())}];
        crate::core::codex::config_history::execute_checked(&mut conn,&path,Some(&id),"instance",Some(&operation_version),intended,|tx|{
            crate::core::codex::config_history::clear_bindings(tx,&path)?;
            tx.execute("UPDATE codex_profiles SET account_id=?1,auth_fingerprint=?2 WHERE id=?3",params![account_id,profile::fingerprint(Some(&auth)),id]).map_err(|_| "保存 Codex 实例失败")?;
            Ok(())
        })?;
        store.provider_gateways.lock().map_err(|_| "供应商网关状态不可用")?.remove(path.to_string_lossy().as_ref());
        let instances = summaries(&store)?;
        Ok(InstanceBindResult { instances, removed_overrides })
    }).await.map_err(|_| "切换 Codex 实例任务失败")?.map_err(Into::into)
}

pub(crate) fn stop_all(store: &CodexRuntimeStore) {
    if let Ok(_writer) = AUTH_WRITER.lock() {
        if let Ok(mut instances) = store.instances.lock() {
            for (_, mut instance) in instances.drain() {
                instance.stop();
                let _ = sync_instance(instance.account_id, &instance.path);
            }
        }
    }
}

pub(crate) fn account_running(store: &CodexRuntimeStore, account_id: i64) -> Result<bool, String> {
    if crate::core::codex::provider_oauth::bound(&open_db()?,account_id)? {return Ok(true);}
    runtime_account_running(store,account_id)
}

pub(crate) fn account_running_except_target(store:&CodexRuntimeStore,account_id:i64,home:&Path)->Result<bool,String> {
    let conn=open_db()?;
    let other:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM codex_provider_oauth WHERE account_id=?1 AND home!=?2)",params![account_id,home.to_string_lossy()],|r|r.get(0)).map_err(|_| "读取供应商 OAuth 归属失败")?;
    Ok(other||runtime_account_running(store,account_id)?)
}

pub(crate) fn account_usage(store: &CodexRuntimeStore, account_id: i64) -> Result<Vec<String>, String> {
    let conn = open_db()?;
    account_usage_with_conn(&conn, store, account_id)
}

fn account_usage_with_conn(conn: &rusqlite::Connection, store: &CodexRuntimeStore, account_id: i64) -> Result<Vec<String>, String> {
    let mut sources = Vec::new();
    let mut statement = conn.prepare("SELECT home FROM codex_provider_oauth WHERE account_id=?1 ORDER BY home")
        .map_err(|_| "读取供应商 OAuth 归属失败")?;
    let homes = statement.query_map([account_id], |row| row.get::<_, String>(0))
        .map_err(|_| "读取供应商 OAuth 归属失败")?;
    for home in homes {
        sources.push(format!("供应商 OAuth 配置（{}，需恢复该目标的配置与登录以解除绑定）", home.map_err(|_| "读取供应商 OAuth 归属失败")?));
    }
    let instances = store.instances.lock().map_err(|_| "Codex 实例状态不可用")?;
    let mut running = instances.iter().filter(|(_, instance)| instance.account_id == account_id).collect::<Vec<_>>();
    running.sort_by_key(|(id, _)| *id);
    for (id, instance) in running {
        let name: String = conn.query_row("SELECT name FROM codex_profiles WHERE id=?1", [id], |row| row.get(0))
            .map_err(|_| "读取 Codex 实例名称失败")?;
        sources.push(format!("运行实例「{name}」（ID：{id}，PID：{}，需停止该实例）", instance.child.id()));
    }
    drop(instances);
    if let Some(gateway) = store.gateway.lock().map_err(|_| "Codex 服务状态不可用")?.as_ref().filter(|gateway| gateway.contains(account_id)) {
        sources.push(format!("API 服务（本机端口 {} 的服务账号池，需停止该服务或从账号池移除此账号）", gateway.port()?));
    }
    if let Some(operation) = store.wakes.lock().map_err(|_| "Codex 账号操作状态不可用")?.get(&account_id) {
        sources.push(format!("{operation}正在执行（需等待本次操作结束）"));
    }
    Ok(sources)
}

pub(crate) fn account_busy_error(store: &CodexRuntimeStore, account_id: i64, action: &str) -> Result<String, String> {
    Ok(format!("无法{action}：账号 {account_id} 的占用来源：{}", account_usage(store, account_id)?.join("；")))
}

// Borrow the owner's latest access token without syncing or changing its login.
pub(crate) fn monitoring_auth(store: &CodexRuntimeStore, account_id: i64, identity: &str) -> Result<Option<auth::ImportedAccount>, String> {
    let mut paths: Vec<PathBuf> = store.instances.lock().map_err(|_| "Codex 实例状态不可用")?
        .values().filter(|instance| instance.account_id == account_id).map(|instance| instance.path.clone()).collect();
    let conn = open_db()?;
    let mut statement = conn.prepare("SELECT home FROM codex_provider_oauth WHERE account_id=?1")
        .map_err(|_| "读取供应商 OAuth 归属失败")?;
    let homes = statement.query_map([account_id], |row| row.get::<_, String>(0)).map_err(|_| "读取供应商 OAuth 归属失败")?;
    for home in homes { paths.push(PathBuf::from(home.map_err(|_| "读取供应商 OAuth 归属失败")?)); }
    paths.sort();
    paths.dedup();
    if let Some(path) = paths.first() {
        let current = auth::parse_import(&profile::read_auth(&path.join("auth.json"))?)?.remove(0);
        if current.identity != identity { return Err(format!("额度查询未执行：凭据所属目录 {} 已登录其他账号，请检查该实例或供应商配置", path.display())); }
        return Ok(Some(current));
    }
    Ok(None)
}

#[cfg(test)]
mod quota_usage_tests {
    use super::*;

    #[test]
    fn quota_usage_identifies_bound_home_and_exact_inflight_operation() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE codex_provider_oauth(home TEXT,account_id INTEGER); INSERT INTO codex_provider_oauth VALUES('fixture-provider-home',7);").unwrap();
        let store = CodexRuntimeStore::default();
        store.wakes.lock().unwrap().insert(7, "订阅权益刷新");
        let sources = account_usage_with_conn(&conn, &store, 7).unwrap();
        assert_eq!(sources.len(), 2);
        assert!(sources[0].contains("fixture-provider-home"));
        assert!(sources[0].contains("恢复该目标"));
        assert!(sources[1].contains("订阅权益刷新正在执行"));
        assert!(!sources.iter().any(|source| source.contains("运行实例")));
        assert!(account_usage_with_conn(&conn, &store, 8).unwrap().is_empty());
        store.wakes.lock().unwrap().remove(&7);
        assert_eq!(account_usage_with_conn(&conn, &store, 7).unwrap().len(), 1);
    }
}

pub(crate) fn runtime_account_running(store: &CodexRuntimeStore, account_id: i64) -> Result<bool, String> {
    let instance_running = store
        .instances
        .lock()
        .map_err(|_| "Codex 实例状态不可用")?
        .values()
        .any(|v| v.account_id == account_id);
    let gateway_running = store
        .gateway
        .lock()
        .map_err(|_| "Codex 服务状态不可用")?
        .as_ref()
        .is_some_and(|v| v.contains(account_id));
    let waking = store
        .wakes
        .lock()
        .map_err(|_| "Codex 唤醒状态不可用")?
        .contains_key(&account_id);
    Ok(instance_running || gateway_running || waking)
}

pub(crate) fn ensure_idle(store: &CodexRuntimeStore) -> Result<(), String> {
    let conn=open_db()?;
    let provider_active:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM codex_provider_config_backups)",[],|r|r.get(0)).map_err(|_| "读取供应商配置状态失败")?;
    if provider_active {return Err("请先恢复所有供应商目标的配置与登录，再执行此操作".into());}
    ensure_runtime_idle(store)
}

pub(crate) fn ensure_runtime_idle(store: &CodexRuntimeStore) -> Result<(), String> {
    if !store
        .instances
        .lock()
        .map_err(|_| "Codex 实例状态不可用")?
        .is_empty()
    {
        return Err("请先停止 Codex 实例，再执行数据库迁移或登录备份".into());
    }
    if store
        .gateway
        .lock()
        .map_err(|_| "Codex 服务状态不可用")?
        .as_ref()
        .is_some_and(|v| v.summary().map_or(true, |s| s.running))
    {
        return Err("请先停止 Codex 本地服务，再执行数据库迁移或登录备份".into());
    }
    if !store
        .wakes
        .lock()
        .map_err(|_| "Codex 唤醒状态不可用")?
        .is_empty()
    {
        return Err("请等待 Codex 唤醒结束后，再执行数据库迁移或登录备份".into());
    }
    Ok(())
}

fn summaries(store: &CodexRuntimeStore) -> Result<Vec<InstanceSummary>, String> {
    let conn = open_db()?;
    let mut statement = conn
        .prepare(
            "SELECT id,account_id,name,work_dir,kind FROM codex_profiles ORDER BY created_at,id",
        )
        .map_err(|_| "读取 Codex 实例失败")?;
    let rows = statement
        .query_map([], |row| {
            Ok(InstanceSummary {
                id: row.get(0)?,
                account_id: row.get(1)?,
                name: row.get(2)?,
                work_dir: row.get(3)?,
                kind: row.get(4)?,
                running: false,
                last_error: None,
            })
        })
        .map_err(|_| "读取 Codex 实例失败")?;
    let mut records = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| "读取 Codex 实例失败")?;
    let mut instances = store.instances.lock().map_err(|_| "Codex 实例状态不可用")?;
    for record in &mut records {
        let exited = if let Some(instance) = instances.get_mut(&record.id) {
            instance
                .child
                .try_wait()
                .map_err(|_| "查询 Codex 实例失败")?
                .is_some()
        } else {
            false
        };
        if exited {
            if let Some(mut instance) = instances.remove(&record.id) {
                instance.stop();
                record.last_error = sync_instance(instance.account_id, &instance.path).err();
            }
        }
        record.running = instances.contains_key(&record.id);
    }
    Ok(records)
}

#[tauri::command]
pub(crate) async fn codex_list_instances(
    app: tauri::AppHandle,
) -> PlatformResult<Vec<InstanceSummary>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<InstanceSummary>, String> {
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        summaries(&app.state::<CodexRuntimeStore>())
    })
    .await
    .map_err(|_| "读取 Codex 实例任务失败")?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_create_instance(
    app: tauri::AppHandle,
    account_id: i64,
    name: String,
    kind: String,
) -> PlatformResult<Option<Vec<InstanceSummary>>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<Vec<InstanceSummary>>,String> {
        if name.trim().is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) { return Err("Codex 实例名称参数无效".into()); }
        if !matches!(kind.as_str(),"cli"|"desktop"){return Err("Codex 实例类型无效".into());}
        if kind=="desktop"&&crate::core::codex::desktop::installed().is_none(){return Err("未检测到支持隔离启动的 Codex 桌面客户端".into());}
        let Some(selected) = app.dialog().file().set_title("选择 Codex 实例的项目目录").blocking_pick_folder() else { return Ok(None); };
        let workspace = selected.into_path().map_err(|_| "项目目录路径无效")?.canonicalize().map_err(|_| "无法读取项目目录")?;
        if !workspace.is_dir() || workspace.to_str().is_none() { return Err("请选择有效的项目目录".into()); }
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        repository::get(&open_db()?,account_id)?;
        let id = uuid::Uuid::new_v4().to_string();
        open_db()?.execute("INSERT INTO codex_profiles(id,account_id,name,work_dir,created_at,kind) VALUES(?1,?2,?3,?4,?5,?6)",params![id,account_id,name.trim(),workspace.to_string_lossy().to_string(),chrono::Utc::now().timestamp_millis(),kind]).map_err(|_| "保存 Codex 实例失败")?;
        summaries(&app.state::<CodexRuntimeStore>()).map(Some)
    }).await.map_err(|_| "创建 Codex 实例任务失败")?.map_err(Into::into)
}

fn launch_terminal(cli: &Path, home: &Path, workspace: &Path, proxy:Option<&str>) -> Result<Child, String> {
    #[cfg(windows)]
    {
        use base64::{engine::general_purpose::STANDARD, Engine};
        use std::os::windows::process::CommandExt;
        let encode = |path: &Path| STANDARD.encode(path.to_string_lossy().as_bytes());
        // Paths are decoded as data, never embedded as executable shell syntax.
        let script = format!("$env:CODEX_HOME=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{}')); Remove-Item Env:OPENAI_API_KEY,Env:CODEX_API_KEY,Env:CODEX_ACCESS_TOKEN -ErrorAction SilentlyContinue; $cli=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{}')); $workspace=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{}')); Set-Location -LiteralPath $workspace; & $cli",encode(home),encode(cli),encode(workspace));
        let encoded = STANDARD.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        let mut terminal=Command::new("powershell.exe");
        crate::core::codex::account_controls::apply_proxy(&mut terminal,proxy)?;
        terminal.args([
                "-NoLogo",
                "-NoProfile",
                "-NoExit",
                "-EncodedCommand",
                &encoded,
            ])
            .creation_flags(0x00000010)
            .spawn()
            .map_err(|_| "打开 Codex 实例终端失败".into())
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        let mut terminal=Command::new("xterm");
        crate::core::codex::account_controls::apply_proxy(&mut terminal,proxy)?;
        terminal.arg("-e")
            .arg(cli)
            .env("CODEX_HOME", home)
            .env_remove("OPENAI_API_KEY")
            .env_remove("CODEX_API_KEY")
            .env_remove("CODEX_ACCESS_TOKEN")
            .current_dir(workspace)
            .process_group(0)
            .spawn()
            .map_err(|_| "打开 Codex 实例终端失败，请安装 xterm".into())
    }
    #[cfg(target_os = "macos")]
    {
        let _ = (cli, home, workspace,proxy);
        Err("macOS 独立终端启动适配尚未完成".into())
    }
}

#[tauri::command]
pub(crate) async fn codex_open_default_cli(app:tauri::AppHandle) -> PlatformResult<()> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        let home = profile::default_home()?;
        profile::ensure_file_storage(&home)?;
        profile::ensure_default_idle()?;
        let _target=crate::core::codex::target_lock::TargetLock::acquire(&home)?;
        super::codex_providers::ensure_gateway_locked(&app.state::<CodexRuntimeStore>(),&home)?;
        crate::core::codex::provider_oauth::sync_locked(&home)?;
        let cli = profile::cli_path().ok_or("未找到 Codex CLI，请先安装官方 CLI 并加入 PATH")?;
        let _child = launch_terminal(&cli, &home, &home, None)?;
        Ok(())
    }).await.map_err(|_| "打开 Codex 实例终端失败")?.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_start_instance(
    app: tauri::AppHandle,
    id: String,
) -> PlatformResult<Vec<InstanceSummary>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<InstanceSummary>,String> {
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        let conn = open_db()?;
        let (account_id,work_dir,last_projection,kind): (i64,String,Option<String>,String) = conn.query_row("SELECT account_id,work_dir,auth_fingerprint,kind FROM codex_profiles WHERE id=?1",[&id],|row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).map_err(|_| "Codex 实例不存在")?;
        let store = app.state::<CodexRuntimeStore>();
        if store.closing.load(std::sync::atomic::Ordering::SeqCst){return Err("应用正在退出，未启动实例".into());}
        if account_running(&store,account_id)? { return Err(account_busy_error(&store, account_id, "启动独立实例")?); }
        let workspace = PathBuf::from(work_dir).canonicalize().map_err(|_| "项目目录不存在")?;
        if !matches!(kind.as_str(),"cli"|"desktop"){return Err("Codex 实例类型无效".into());}
        let path = instance_path(&id)?;
        let _target=crate::core::codex::target_lock::TargetLock::acquire(&path)?;
        profile::ensure_file_storage(&path)?;
        crate::core::codex::config_history::ensure_ready(&conn,&path)?;
        super::codex_providers::ensure_gateway_locked(&store,&path)?;
        if crate::core::codex::providers::is_provider_account(&conn,account_id)? {
            let matches:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM codex_provider_bindings WHERE home=?1 AND account_id=?2 AND instance_id=?3)",params![path.to_string_lossy(),account_id,id],|r|r.get(0)).map_err(|_| "读取供应商绑定失败")?;
            if !matches {return Err("请通过模型供应商启动预览应用此账号".into());}
        }
        let mut stored_auth = crate::core::codex::provider_oauth::credentials(&conn,&path)?.unwrap_or(repository::credentials(&conn,account_id)?);
        if crate::core::codex::provider_oauth::owner(&conn,&path)?.is_some() {
            crate::core::codex::provider_oauth::sync_locked(&path)?;
            stored_auth=crate::core::codex::provider_oauth::credentials(&conn,&path)?.ok_or("供应商 OAuth 账号不可用")?;
        }
        auth::ensure_runtime_auth(&stored_auth)?;
        let saved_identity=auth::parse_import(&stored_auth)?.remove(0).identity;
        if profile::default_home().ok().and_then(|home|profile::read_auth(&home.join("auth.json")).ok()).and_then(|content|auth::parse_import(&content).ok()).is_some_and(|accounts|accounts.iter().any(|account|account.auth_mode=="chatgpt"&&account.identity==saved_identity)){
            // A copied refresh grant can rotate after launch even when the default client
            // was idle. Keep the default login out of that independent writer's scope.
            return Err("该账号仍是默认 Codex 登录，请先切换默认账号，再启动此独立实例，避免登录续期互相覆盖".into());
        }
        let stored_fingerprint = profile::fingerprint(Some(&stored_auth));
        if path.join("auth.json").exists() {
            let instance_auth = profile::read_auth(&path.join("auth.json"))?;
            let instance_fingerprint = profile::fingerprint(Some(&instance_auth));
            if let Some(previous) = last_projection {
                if instance_fingerprint != previous && instance_fingerprint != stored_fingerprint {
                    if previous != stored_fingerprint { return Err("实例与账号凭据均已变更，请新建实例或先导入该实例 auth.json，未覆盖登录状态".into()); }
                    sync_instance_locked(account_id,&path)?;
                    stored_auth = crate::core::codex::provider_oauth::credentials(&conn,&path)?.unwrap_or(repository::credentials(&conn,account_id)?);
                }
            } else { return Err("实例目录已有登录数据，请创建新实例，未覆盖原文件".into()); }
        }
        profile::write_private(&path.join("auth.json"),&stored_auth)?;
        conn.execute("UPDATE codex_profiles SET auth_fingerprint=?1 WHERE id=?2",params![profile::fingerprint(Some(&stored_auth)),id]).map_err(|_| "保存实例认证状态失败")?;
        if !path.join("config.toml").exists() { profile::write_private(&path.join("config.toml"),"cli_auth_credentials_store = \"file\"\n[analytics]\nenabled = false\n")?; }
        let proxy=crate::core::codex::account_controls::proxy(&conn,account_id)?;
        let mut child = if kind=="desktop" {crate::core::codex::desktop::launch(&path,&workspace,proxy.as_deref())?}else{let cli=profile::cli_path().ok_or("未找到 Codex CLI，请先安装并加入 PATH")?;launch_terminal(&cli,&path,&workspace,proxy.as_deref())?};
        #[cfg(windows)]
        let job = match crate::core::codex::process::OwnedJob::attach(&child) { Ok(job) => job, Err(error) => { terminate(&mut child); return Err(error); } };
        let instance = ManagedInstance { account_id,path,child, #[cfg(windows)] job };
        store.instances.lock().map_err(|_| "Codex 实例状态不可用")?.insert(id,instance);
        summaries(&store)
    }).await.map_err(|_| "启动 Codex 实例任务失败")?.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_stop_instance(
    app: tauri::AppHandle,
    id: String,
) -> PlatformResult<Vec<InstanceSummary>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<InstanceSummary>, String> {
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        let store = app.state::<CodexRuntimeStore>();
        let instance = store
            .instances
            .lock()
            .map_err(|_| "Codex 实例状态不可用")?
            .remove(&id);
        if let Some(mut instance) = instance {
            instance.stop();
            sync_instance(instance.account_id, &instance.path)?;
        }
        summaries(&store)
    })
    .await
    .map_err(|_| "停止 Codex 实例任务失败")?
    .map_err(Into::into)
}
