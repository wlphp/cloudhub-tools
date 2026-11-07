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
    if key.is_empty() || key.starts_with("cloud.sync.") || key.starts_with("cloud.drive.") || key.len() > 120 || value.len() > 100_000 { return Err("客户端设置数据无效".into()); }
    let conn = open_db()?;
    preferences_repository::save_detailed(&conn, key, &value, chrono::Utc::now().timestamp_millis()).map_err(|error| {
        match error {
            rusqlite::Error::SqliteFailure(code, message) => {
                let readonly = conn.is_readonly(rusqlite::DatabaseName::Main).unwrap_or(true);
                let profile = if crate::core::paths::desktop_development() { "development" } else { "production" };
                format!("SQLite诊断：code={:?}, extended_code={}, connection_readonly={readonly}, data_profile={profile}; {message:?}", code.code, code.extended_code)
            }
            other => format!("SQLite诊断：{other}"),
        }.into()
    })
}
