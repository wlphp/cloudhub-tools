use crate::core::{repositories::logs as log_repository, storage::open_db};
use crate::core::error::PlatformResult;
use crate::ApiLog;

#[tauri::command]
pub(crate) fn list_api_logs(keyword: Option<String>, status: Option<String>, limit: Option<i64>, offset: Option<i64>) -> PlatformResult<Vec<ApiLog>> {
    Ok(log_repository::list_api(&open_db()?, keyword.as_deref(), status.as_deref(), limit.unwrap_or(500), offset.unwrap_or(0))?)
}

#[tauri::command]
pub(crate) fn clear_api_logs() -> PlatformResult<usize> {
    Ok(log_repository::clear_api(&open_db()?)?)
}

#[tauri::command]
pub(crate) fn clear_operation_logs() -> PlatformResult<usize> {
    Ok(log_repository::clear_operations(&open_db()?)?)
}
