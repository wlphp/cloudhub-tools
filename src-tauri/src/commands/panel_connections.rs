use crate::core::{repositories::panel_connections as panel_repository, storage::open_db};
use crate::PanelConnection;

#[tauri::command]
pub(crate) fn list_panel_connections() -> Result<Vec<PanelConnection>, String> { panel_repository::list(&open_db()?) }

#[tauri::command]
pub(crate) fn update_panel_connection_order(ids: Vec<i64>) -> Result<(), String> {
    let mut conn = open_db()?;
    panel_repository::update_order(&mut conn, &ids, chrono::Utc::now().timestamp_millis())
}

#[tauri::command]
pub(crate) fn delete_panel_connection(id: i64) -> Result<(), String> { panel_repository::delete(&open_db()?, id) }

#[tauri::command]
pub(crate) fn update_panel_connection_remark(id: i64, remark: Option<String>) -> Result<PanelConnection, String> {
    let remark = remark.and_then(|value| (!value.trim().is_empty()).then(|| value.trim().to_string()));
    panel_repository::update_remark(&open_db()?, id, remark, chrono::Utc::now().timestamp_millis())
}
