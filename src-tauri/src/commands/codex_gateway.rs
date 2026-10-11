use super::{codex::AUTH_WRITER, codex_runtime::CodexRuntimeStore};
use crate::core::{
    codex::gateway::{GatewaySummary, RunningGateway},
    error::PlatformResult,
    repositories::codex_accounts as repository,
    storage::open_db,
};
use std::collections::HashSet;
use tauri::Manager;

#[tauri::command]
pub(crate) fn codex_gateway_state(app: tauri::AppHandle) -> PlatformResult<GatewaySummary> {
    let store = app.state::<CodexRuntimeStore>();
    let slot = store.gateway.lock().map_err(|_| "Codex 服务状态不可用")?;
    let mut summary = slot.as_ref()
        .map(|v| v.summary())
        .unwrap_or_else(|| Ok(GatewaySummary::default()))?;
    let conn = open_db()?;
    summary.configured_port = crate::core::codex::gateway_config::summary(&conn)?;
    if slot.is_none() { summary.settings = crate::core::codex::gateway_controls::load(&conn)?; }
    Ok(summary)
}

#[tauri::command]
pub(crate) async fn codex_gateway_models(app: tauri::AppHandle) -> PlatformResult<Vec<String>> {
    let query = {
        let store = app.state::<CodexRuntimeStore>();
        let slot = store.gateway.lock().map_err(|_| "Codex 服务状态不可用")?;
        let server = slot.as_ref().ok_or("请先启动本地 API 服务，再获取模型列表")?;
        if !server.summary()?.running { return Err("请先启动本地 API 服务，再获取模型列表".into()); }
        server.models_query()
    };
    tokio::time::timeout(std::time::Duration::from_secs(90), query).await
        .map_err(|_| "获取模型列表超时，请检查网络或账号登录")?
        .map_err(|message| crate::core::error::PlatformError {
            kind: "platform-error",
            code: "codex-model-catalog",
            message: crate::core::codex::gateway::public_catalog_error(&message),
            retryable: false,
        })
}

#[tauri::command]
pub(crate) async fn codex_gateway_start(
    app: tauri::AppHandle,
    port: u16,
    account_ids: Vec<i64>,
    service_key: Option<String>,
) -> PlatformResult<GatewaySummary> {
    if port != 0 && port < 1024 {
        return Err("请选择 1024 以上的本地 API 端口，或 0 自动分配".into());
    }
    if account_ids.is_empty()
        || account_ids.len() > 100
        || account_ids.iter().any(|id| *id <= 0)
        || account_ids.iter().collect::<HashSet<_>>().len() != account_ids.len()
    {
        return Err("服务账号选择无效".into());
    }
    let service_key = service_key.map(zeroize::Zeroizing::new);
    let (port, service_key) = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        let conn = open_db()?;
        let port = if port == 0 { crate::core::codex::gateway_config::summary(&conn)?.unwrap_or(0) } else { port };
        let key = if let Some(key) = service_key { Some(key) }
        else { crate::core::codex::gateway_config::key(&conn)? };
        Ok((port, key))
    }).await.map_err(|_| "读取本地 API 配置任务失败")??;
    let server = RunningGateway::start_with_key(port, account_ids.clone(), service_key.map(|v| v.to_string())).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<GatewaySummary, String> {
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        let store = app.state::<CodexRuntimeStore>();
        if store.closing.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("应用正在退出，未启动本地服务".into());
        }
        // Validate ownership again under the same writer used by launch/import/delete.
        for id in &account_ids {
            repository::get(&open_db()?, *id)?;
            if super::codex_instances::account_running(&store, *id)? {
                return Err("所选账号已有实例或服务运行，请先停止".into());
            }
        }
        let mut slot = store.gateway.lock().map_err(|_| "Codex 服务状态不可用")?;
        if slot
            .as_ref()
            .is_some_and(|v| v.summary().map_or(true, |s| s.running))
        {
            return Err("本地服务已运行，请先停止再修改配置".into());
        }
        let conn = open_db()?;
        server.configure(crate::core::codex::gateway_controls::load(&conn)?, repository::list(&conn)?)?;
        let mut summary = server.summary()?;
        summary.configured_port = Some(server.save_config(&conn)?);
        *slot = Some(server);
        Ok(summary)
    })
    .await
    .map_err(|_| "启动 Codex 服务任务失败")?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn codex_gateway_configure(app: tauri::AppHandle, settings: crate::core::codex::gateway_controls::GatewaySettings) -> PlatformResult<GatewaySummary> {
    settings.validate()?;
    let store = app.state::<CodexRuntimeStore>();
    {
        let slot = store.gateway.lock().map_err(|_| "Codex 服务状态不可用")?;
        let conn = open_db()?;
        let accounts = repository::list(&conn)?;
        crate::core::codex::gateway_controls::save(&conn, &settings)?;
        if let Some(server) = slot.as_ref() { server.configure(settings, accounts)?; }
    }
    codex_gateway_state(app)
}

#[tauri::command]
pub(crate) fn codex_gateway_logs(app: tauri::AppHandle) -> PlatformResult<Vec<crate::core::codex::gateway_controls::CallLog>> {
    let store = app.state::<CodexRuntimeStore>();
    let slot = store.gateway.lock().map_err(|_| "Codex 服务状态不可用")?;
    slot.as_ref().map(|v| v.logs()).unwrap_or_else(|| Ok(Vec::new())).map_err(Into::into)
}

#[tauri::command]
pub(crate) fn codex_gateway_clear_logs(app: tauri::AppHandle) -> PlatformResult<()> {
    let store = app.state::<CodexRuntimeStore>();
    let slot = store.gateway.lock().map_err(|_| "Codex 服务状态不可用")?;
    if let Some(server) = slot.as_ref() { server.clear_logs()?; }
    Ok(())
}

#[tauri::command]
pub(crate) fn codex_gateway_stop(app: tauri::AppHandle) -> PlatformResult<GatewaySummary> {
    let store = app.state::<CodexRuntimeStore>();
    *store.gateway.lock().map_err(|_| "Codex 服务状态不可用")? = None;
    codex_gateway_state(app)
}

#[tauri::command]
pub(crate) fn codex_gateway_copy_key(app: tauri::AppHandle) -> PlatformResult<()> {
    let store = app.state::<CodexRuntimeStore>();
    let slot = store.gateway.lock().map_err(|_| "Codex 服务状态不可用")?;
    slot.as_ref()
        .ok_or("本地服务未启动")?
        .copy_key()
        .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_wake_account(
    app: tauri::AppHandle,
    id: i64,
    model: String,
) -> PlatformResult<()> {
    // Users must explicitly confirm consumption in the UI; no timer or auto-wakeup.
    let store = app.state::<CodexRuntimeStore>();
    struct Lease {
        id: i64,
        wakes: std::sync::Arc<std::sync::Mutex<HashSet<i64>>>,
    }
    impl Drop for Lease {
        fn drop(&mut self) {
            if let Ok(mut wakes) = self.wakes.lock() {
                wakes.remove(&self.id);
            }
        }
    }
    let lease = {
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        if store.closing.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("应用正在退出".into());
        }
        if super::codex_instances::account_running(&store, id)? {
            return Err("该账号已有实例、服务或唤醒请求运行，请等待结束".into());
        }
        store
            .wakes
            .lock()
            .map_err(|_| "Codex 唤醒状态不可用")?
            .insert(id);
        Lease {
            id,
            wakes: store.wakes.clone(),
        }
    };
    let cancelled = async {
        loop {
            if store.closing.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    };
    let result = tokio::select! {result=crate::core::codex::gateway::wake(id,model)=>result,_=cancelled=>Err("应用退出，唤醒请求已取消".into())};
    drop(lease);
    result.map_err(Into::into)
}

#[tauri::command]
pub(crate) fn codex_gateway_log_detail(app: tauri::AppHandle, id: String) -> PlatformResult<crate::core::codex::gateway_controls::CallDetail> {
    let store=app.state::<CodexRuntimeStore>();
    let slot=store.gateway.lock().map_err(|_| "网关日志不可用")?;
    slot.as_ref().ok_or("本地服务已停止，日志已清除")?.log_detail(&id).map_err(Into::into)
}
