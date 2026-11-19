use rusqlite::{params, Connection};
use serde_json::Value;

/// 余额缓存以完整 payload 保存，避免字段升级时反复改表。
pub fn list(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut statement = conn
        .prepare("SELECT b.payload_json FROM cloud_account_balances b JOIN cloud_accounts a ON a.id=b.account_id WHERE a.deleted_at IS NULL ORDER BY b.fetched_at DESC")
        .map_err(|error| format!("读取余额缓存失败: {error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("读取余额缓存失败: {error}"))?;
    Ok(rows
        .filter_map(|row| row.ok())
        .filter_map(|payload| serde_json::from_str::<Value>(&payload).ok())
        .collect())
}

pub fn upsert(conn: &Connection, account_id: i64, cloud_type: &str, payload: &Value, fetched_at: i64) -> Result<(), String> {
    let payload_json = serde_json::to_string(payload).map_err(|_| "余额缓存序列化失败".to_string())?;
    conn.execute(
        "INSERT INTO cloud_account_balances(account_id,cloud_type,payload_json,fetched_at) VALUES(?1,?2,?3,?4) ON CONFLICT(account_id) DO UPDATE SET cloud_type=excluded.cloud_type,payload_json=excluded.payload_json,fetched_at=excluded.fetched_at",
        params![account_id, cloud_type, payload_json, fetched_at],
    )
    .map_err(|error| format!("保存账号余额缓存失败: {error}"))?;
    Ok(())
}

pub fn delete(conn: &Connection, account_id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM cloud_account_balances WHERE account_id=?1", [account_id])
        .map_err(|error| format!("清理账号余额缓存失败: {error}"))?;
    Ok(())
}
