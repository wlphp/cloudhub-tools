use std::collections::BTreeMap;

use crate::core::{repositories::preferences as preferences_repository, storage::open_db};

#[tauri::command]
pub(crate) fn list_client_preferences() -> Result<BTreeMap<String, String>, String> {
    preferences_repository::list(&open_db()?)
}

#[tauri::command]
pub(crate) fn save_client_preference(key: String, value: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() || key.len() > 120 || value.len() > 100_000 { return Err("客户端设置数据无效".into()); }
    preferences_repository::save(&open_db()?, key, &value, chrono::Utc::now().timestamp_millis())
}
