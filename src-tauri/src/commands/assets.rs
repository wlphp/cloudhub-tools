use crate::{open_db, LocalAsset};
use rusqlite::params;
use serde_json::Value;

#[tauri::command]
pub(crate) fn list_local_assets(account_id: Option<i64>, resource_type: Option<String>) -> Result<Vec<LocalAsset>, String> {
    let conn = open_db()?;
    let mut statement = conn
        .prepare("SELECT account_id,resource_type,asset_key,region_id,payload_json,fetched_at FROM cloud_assets WHERE (?1 IS NULL OR account_id=?1) AND (?2 IS NULL OR resource_type=?2) ORDER BY resource_type,asset_key")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![account_id, resource_type], |row| {
            let payload: String = row.get(4)?;
            Ok(LocalAsset {
                account_id: row.get(0)?,
                resource_type: row.get(1)?,
                asset_key: row.get(2)?,
                region_id: row.get(3)?,
                payload: serde_json::from_str(&payload).unwrap_or(Value::Null),
                fetched_at: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.map(|row| row.map_err(|error| error.to_string())).collect()
}

#[tauri::command]
pub(crate) fn delete_local_asset(account_id: i64, resource_type: String, asset_key: String) -> Result<(), String> {
    if account_id <= 0 || resource_type.trim().is_empty() || asset_key.trim().is_empty() {
        return Err("缺少本地资产标识".into());
    }
    let deleted = open_db()?
        .execute(
            "DELETE FROM cloud_assets WHERE account_id=?1 AND resource_type=?2 AND asset_key=?3",
            params![account_id, resource_type, asset_key],
        )
        .map_err(|error| error.to_string())?;
    if deleted == 0 {
        return Err("本地资产记录不存在".into());
    }
    Ok(())
}
