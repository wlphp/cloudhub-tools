use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::ApiLog;

pub fn list_api(conn: &Connection) -> Result<Vec<ApiLog>, String> {
    let mut statement = conn.prepare("SELECT l.id,l.account_id,a.account_name,l.endpoint,l.action,l.request_params,l.response_params,l.status,l.message,l.created_at FROM api_logs l LEFT JOIN cloud_accounts a ON a.id=l.account_id ORDER BY l.created_at DESC LIMIT 500").map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| Ok(ApiLog {
        id: row.get(0)?, account_id: row.get(1)?, account_name: row.get(2)?, endpoint: row.get(3)?, action: row.get(4)?, request_params: row.get(5)?, response_params: row.get(6)?, status: row.get(7)?, message: row.get(8)?, created_at: row.get(9)?,
    })).map_err(|error| error.to_string())?;
    rows.map(|row| row.map_err(|error| error.to_string())).collect()
}

pub fn clear_api(conn: &Connection) -> Result<usize, String> { conn.execute("DELETE FROM api_logs", []).map_err(|error| error.to_string()) }

pub fn clear_operations(conn: &Connection) -> Result<usize, String> { conn.execute("DELETE FROM operation_logs", []).map_err(|error| error.to_string()) }

pub fn write_api(conn: &Connection, access_key_id: &str, endpoint: &str, action: &str, request: &Value, response: Option<&Value>, status: &str, message: Option<&str>, now: i64) -> Result<(), String> {
    let account_id: Option<i64> = conn.query_row("SELECT id FROM cloud_accounts WHERE access_key_id=?1", [access_key_id], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
    conn.execute("INSERT INTO api_logs(account_id,endpoint,action,request_params,response_params,status,message,created_at) VALUES(?,?,?,?,?,?,?,?)", params![account_id, endpoint, action, serde_json::to_string(request).unwrap_or_default(), response.map(|value| serde_json::to_string(value).unwrap_or_default()), status, message, now]).map(|_| ()).map_err(|error| error.to_string())
}
