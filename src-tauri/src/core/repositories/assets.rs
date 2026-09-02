use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::LocalAsset;

pub fn list(conn: &Connection, account_id: Option<i64>, resource_type: Option<&str>) -> Result<Vec<LocalAsset>, String> {
    let mut statement = conn.prepare("SELECT account_id,resource_type,asset_key,region_id,payload_json,fetched_at FROM cloud_assets WHERE (?1 IS NULL OR account_id=?1) AND (?2 IS NULL OR resource_type=?2) ORDER BY resource_type,asset_key").map_err(|error| error.to_string())?;
    let rows = statement.query_map(params![account_id, resource_type], |row| {
        let payload: String = row.get(4)?;
        Ok(LocalAsset { account_id: row.get(0)?, resource_type: row.get(1)?, asset_key: row.get(2)?, region_id: row.get(3)?, payload: serde_json::from_str(&payload).unwrap_or(Value::Null), fetched_at: row.get(5)? })
    }).map_err(|error| error.to_string())?;
    rows.map(|row| row.map_err(|error| error.to_string())).collect()
}

pub fn delete(conn: &Connection, account_id: i64, resource_type: &str, asset_key: &str) -> Result<(), String> {
    let deleted = conn.execute("DELETE FROM cloud_assets WHERE account_id=?1 AND resource_type=?2 AND asset_key=?3", params![account_id, resource_type, asset_key]).map_err(|error| error.to_string())?;
    if deleted == 0 { return Err("本地资产记录不存在".into()); }
    Ok(())
}

pub fn update_server_name(conn: &Connection, account_id: i64, instance_id: &str, instance_name: &str) -> Result<(), String> {
    let cached: Option<String> = conn.query_row("SELECT payload_json FROM cloud_assets WHERE account_id=?1 AND resource_type='ecs' AND asset_key=?2", params![account_id, instance_id], |row| row.get(0)).map_err(|error| format!("读取本地服务器缓存失败: {error}"))?;
    if let Some(payload_json) = cached {
        let mut payload: Value = serde_json::from_str(&payload_json).map_err(|error| format!("解析本地服务器缓存失败: {error}"))?;
        let object = payload.as_object_mut().ok_or("本地服务器缓存格式无效")?;
        object.insert("InstanceName".into(), serde_json::json!(instance_name));
        conn.execute("UPDATE cloud_assets SET payload_json=?1 WHERE account_id=?2 AND resource_type='ecs' AND asset_key=?3", params![serde_json::to_string(&payload).map_err(|error| error.to_string())?, account_id, instance_id]).map_err(|error| format!("更新本地服务器缓存失败: {error}"))?;
    }
    Ok(())
}

pub fn name_for_asset(conn: &Connection, account_id: i64, asset_key: &str) -> Result<(String, Option<String>), String> {
    let asset: Option<(String, Option<String>, Option<String>)> = conn.query_row("SELECT a.account_name,a.group_name,assets.payload_json FROM cloud_assets assets JOIN cloud_accounts a ON a.id=assets.account_id WHERE assets.account_id=?1 AND assets.asset_key=?2 ORDER BY assets.fetched_at DESC LIMIT 1", params![account_id, asset_key], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional().map_err(|error| format!("读取云资源名称失败: {error}"))?;
    let Some((account_name, account_group, payload)) = asset else { return Ok((asset_key.to_string(), None)); };
    let payload = payload.as_deref().and_then(|value| serde_json::from_str::<Value>(value).ok()).unwrap_or(Value::Null);
    let name = ["InstanceName", "Name", "name", "ServerName", "InstanceId", "Id"].iter().find_map(|key| payload.get(*key).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_string)).unwrap_or_else(|| asset_key.to_string());
    let group = account_group.filter(|value| !value.trim().is_empty()).or_else(|| (!account_name.trim().is_empty()).then_some(account_name));
    Ok((name, group))
}

pub struct AssetRow {
    pub resource_type: String,
    pub asset_key: String,
    pub region_id: Option<String>,
    pub payload_json: String,
    pub fetched_at: i64,
}

pub fn replace_for_account(conn: &mut Connection, account_id: i64, resource_types: &[String], rows: &[AssetRow]) -> Result<usize, String> {
    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    let mut fetched = 0;
    for resource_type in resource_types {
        transaction.execute("DELETE FROM cloud_assets WHERE account_id=?1 AND resource_type=?2", params![account_id, resource_type]).map_err(|error| error.to_string())?;
    }
    for row in rows {
        transaction.execute("INSERT OR REPLACE INTO cloud_assets(account_id,resource_type,asset_key,region_id,payload_json,fetched_at) VALUES(?1,?2,?3,?4,?5,?6)", params![account_id, row.resource_type, row.asset_key, row.region_id, row.payload_json, row.fetched_at]).map_err(|error| error.to_string())?;
        fetched += 1;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(fetched)
}
