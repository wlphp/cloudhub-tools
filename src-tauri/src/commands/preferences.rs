use std::collections::BTreeMap;

use crate::core::{repositories::preferences as preferences_repository, storage::open_db};

use crate::core::error::PlatformResult;

#[tauri::command]
pub(crate) fn list_client_preferences() -> PlatformResult<BTreeMap<String, String>> {
    Ok(preferences_repository::list(&open_db()?)?)
}

#[tauri::command]
pub(crate) fn save_client_preference(key: String, value: String) -> PlatformResult<()> {
    let key = key.trim();
    if key.is_empty() || key.len() > 120 || value.len() > 100_000 { return Err("客户端设置数据无效".into()); }
    Ok(preferences_repository::save(&open_db()?, key, &value, chrono::Utc::now().timestamp_millis())?)
}
