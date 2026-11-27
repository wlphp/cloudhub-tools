use super::{codex::AUTH_WRITER, codex_runtime::CodexRuntimeStore};
use crate::core::{
    codex::pelican::{
        self, Artifact, Batch, CleanupSummary, History, RetentionSettings, RuntimeHooks, StartRequest, EVENT,
    },
    error::PlatformResult,
};
use std::collections::HashMap;
use std::sync::{atomic::Ordering, Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

struct TauriPelicanHooks {
    app: AppHandle,
}

struct WakeLease {
    id: i64,
    wakes: Arc<Mutex<HashMap<i64, &'static str>>>,
}

impl Drop for WakeLease {
    fn drop(&mut self) {
        if let Ok(mut wakes) = self.wakes.lock() {
            wakes.remove(&self.id);
        }
    }
}

impl RuntimeHooks for TauriPelicanHooks {
    fn emit(&self, batch: &Batch) {
        let _ = self.app.emit(EVENT, batch);
    }

    fn closing(&self) -> bool {
        self.app
            .state::<CodexRuntimeStore>()
            .closing
            .load(Ordering::SeqCst)
    }

    fn acquire_lease(&self, account_id: i64) -> Result<Box<dyn Send>, String> {
        let store = self.app.state::<CodexRuntimeStore>();
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用".to_string())?;
        if store.closing.load(Ordering::SeqCst) {
            return Err("应用正在退出".into());
        }
        if super::codex_instances::account_running(&store, account_id)? {
            return Err(super::codex_instances::account_busy_error(&store, account_id, "执行账号测智")?);
        }
        store
            .wakes
            .lock()
            .map_err(|_| "Codex 运行状态不可用".to_string())?
            .insert(account_id, "账号测智请求");
        Ok(Box::new(WakeLease {
            id: account_id,
            wakes: store.wakes.clone(),
        }))
    }
}

fn hooks(app: AppHandle) -> Arc<dyn RuntimeHooks> {
    Arc::new(TauriPelicanHooks { app })
}

#[tauri::command]
pub(crate) async fn codex_pelican_start(app: AppHandle, request: StartRequest) -> PlatformResult<Batch> {
    pelican::start(hooks(app), request).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) fn codex_pelican_active() -> PlatformResult<Option<Batch>> {
    pelican::active().map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_pelican_get(batch_id: String) -> PlatformResult<Batch> {
    pelican::get(batch_id).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_pelican_cancel(batch_id: String) -> PlatformResult<Batch> {
    pelican::cancel(batch_id).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_pelican_dismiss(batch_id: String) -> PlatformResult<()> {
    pelican::dismiss(batch_id).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_pelican_retry(app: AppHandle, batch_id: String, item_id: String) -> PlatformResult<Batch> {
    pelican::retry(hooks(app), batch_id, item_id).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_pelican_artifact(batch_id: String, item_id: String) -> PlatformResult<Artifact> {
    pelican::artifact(batch_id, item_id).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_pelican_browser(batch_id: String, item_id: String) -> PlatformResult<String> {
    pelican::start_browser_preview(batch_id, item_id).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_pelican_history(offset: Option<usize>, limit: Option<usize>) -> PlatformResult<History> {
    pelican::history(offset.unwrap_or(0), limit.unwrap_or(20)).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_pelican_delete(batch_id: String) -> PlatformResult<()> {
    pelican::delete(batch_id).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_pelican_clear_all() -> PlatformResult<CleanupSummary> {
    pelican::clear_all().await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_pelican_retention_get() -> PlatformResult<RetentionSettings> {
    pelican::retention_settings().await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_pelican_retention_set(days: u32) -> PlatformResult<RetentionSettings> {
    pelican::update_retention_days(days).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_pelican_cleanup() -> PlatformResult<CleanupSummary> {
    pelican::cleanup_expired().await.map_err(Into::into)
}
