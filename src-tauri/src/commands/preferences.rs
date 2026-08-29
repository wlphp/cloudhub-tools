use crate::open_db;
use chrono::Utc;
use rusqlite::params;
use std::collections::BTreeMap;

#[tauri::command]
pub(crate) fn list_client_preferences() -> Result<BTreeMap<String, String>, String> {
    let conn = open_db()?;
    let mut statement = conn
        .prepare("SELECT key, value FROM client_preferences")
        .map_err(|error| error.to_string())?;
    let preferences = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| error.to_string())?
        .map(|row| row.map_err(|error| error.to_string()))
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    Ok(preferences)
}

#[tauri::command]
pub(crate) fn save_client_preference(key: String, value: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() || key.len() > 120 || value.len() > 100_000 {
        return Err("客户端设置数据无效".into());
    }
    open_db()?
        .execute(
            "INSERT INTO client_preferences(key, value, updated_at) VALUES(?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            params![key, value, Utc::now().timestamp_millis()],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}
