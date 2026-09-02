use crate::core::{repositories::logs as log_repository, storage::open_db};
use crate::ApiLog;

#[tauri::command]
pub(crate) fn list_api_logs() -> Result<Vec<ApiLog>, String> {
    log_repository::list_api(&open_db()?)
}

#[tauri::command]
pub(crate) fn clear_api_logs() -> Result<usize, String> {
    Ok(log_repository::clear_api(&open_db()?)?)
}

#[tauri::command]
pub(crate) fn clear_operation_logs() -> Result<usize, String> {
    Ok(log_repository::clear_operations(&open_db()?)?)
}
