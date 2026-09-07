use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::ApiLog;

const MAX_LOG_JSON_BYTES: usize = 32 * 1024;
const LOG_RETENTION_MILLIS: i64 = 90 * 24 * 60 * 60 * 1000;

fn sensitive_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase().replace(['_', '-', '.'], "");
    ["secret", "token", "authorization", "signature", "password", "privatekey", "passphrase", "ciphertext", "assertion"]
        .iter()
        .any(|needle| normalized.contains(needle))
}

fn sanitize_json(value: &Value, key: Option<&str>) -> Value {
    if key.is_some_and(sensitive_key) {
        return Value::String("[REDACTED]".into());
    }
    match value {
        Value::Object(object) => Value::Object(object.iter().map(|(name, child)| (name.clone(), sanitize_json(child, Some(name)))).collect()),
        Value::Array(items) => Value::Array(items.iter().map(|child| sanitize_json(child, None)).collect()),
        _ => value.clone(),
    }
}

fn log_json(value: &Value) -> String {
    let sanitized = sanitize_json(value, None);
    let serialized = serde_json::to_string(&sanitized).unwrap_or_else(|_| "{}".into());
    if serialized.len() <= MAX_LOG_JSON_BYTES {
        serialized
    } else {
        serde_json::json!({ "truncated": true, "bytes": serialized.len() }).to_string()
    }
}

pub fn list_api(conn: &Connection, keyword: Option<&str>, status: Option<&str>, limit: i64, offset: i64) -> Result<Vec<ApiLog>, String> {
    let keyword = keyword.map(|value| format!("%{}%", value.trim()));
    let status = status.map(str::trim).filter(|value| !value.is_empty());
    let limit = limit.clamp(1, 500);
    let offset = offset.max(0);
    let mut statement = conn.prepare("SELECT l.id,l.account_id,a.account_name,l.endpoint,l.action,l.request_params,l.response_params,l.status,l.message,l.created_at FROM api_logs l LEFT JOIN cloud_accounts a ON a.id=l.account_id WHERE (?1 IS NULL OR COALESCE(a.account_name,'') LIKE ?1 OR l.endpoint LIKE ?1 OR l.action LIKE ?1 OR l.status LIKE ?1 OR COALESCE(l.message,'') LIKE ?1) AND (?2 IS NULL OR l.status=?2) ORDER BY l.created_at DESC LIMIT ?3 OFFSET ?4").map_err(|error| error.to_string())?;
    let rows = statement.query_map(params![keyword, status, limit, offset], |row| Ok(ApiLog {
        id: row.get(0)?, account_id: row.get(1)?, account_name: row.get(2)?, endpoint: row.get(3)?, action: row.get(4)?, request_params: row.get(5)?, response_params: row.get(6)?, status: row.get(7)?, message: row.get(8)?, created_at: row.get(9)?,
    })).map_err(|error| error.to_string())?;
    rows.map(|row| row.map_err(|error| error.to_string())).collect()
}

pub fn clear_api(conn: &Connection) -> Result<usize, String> { conn.execute("DELETE FROM api_logs", []).map_err(|error| error.to_string()) }

pub fn clear_operations(conn: &Connection) -> Result<usize, String> { conn.execute("DELETE FROM operation_logs", []).map_err(|error| error.to_string()) }

fn prune_old(conn: &Connection, now: i64) -> Result<(), String> {
    let cutoff = now.saturating_sub(LOG_RETENTION_MILLIS);
    conn.execute("DELETE FROM api_logs WHERE created_at < ?1", [cutoff]).map_err(|error| error.to_string())?;
    conn.execute("DELETE FROM operation_logs WHERE created_at < ?1", [cutoff]).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn write_api(conn: &Connection, access_key_id: &str, endpoint: &str, action: &str, request: &Value, response: Option<&Value>, status: &str, message: Option<&str>, now: i64) -> Result<(), String> {
    let account_id: Option<i64> = conn.query_row("SELECT id FROM cloud_accounts WHERE access_key_id=?1", [access_key_id], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
    conn.execute("INSERT INTO api_logs(account_id,endpoint,action,request_params,response_params,status,message,created_at) VALUES(?,?,?,?,?,?,?,?)", params![account_id, endpoint, action, log_json(request), response.map(log_json), status, message, now]).map_err(|error| error.to_string())?;
    prune_old(conn, now)
}

#[cfg(test)]
mod tests {
    use super::{list_api, log_json, write_api, LOG_RETENTION_MILLIS, MAX_LOG_JSON_BYTES};
    use rusqlite::Connection;
    use serde_json::json;

    #[test]
    fn redacts_sensitive_nested_values() {
        let output = log_json(&json!({
            "AccessKeyId": "public-id",
            "AccessKeySecret": "secret-value",
            "nested": { "authorization": "bearer-value", "safe": "kept" },
            "items": [{ "private_key": "pem-value" }]
        }));
        assert!(output.contains("public-id"));
        assert!(output.contains("kept"));
        assert!(!output.contains("secret-value"));
        assert!(!output.contains("bearer-value"));
        assert!(!output.contains("pem-value"));
        assert!(output.matches("[REDACTED]").count() >= 3);
    }

    #[test]
    fn truncates_oversized_payload_without_retaining_content() {
        let output = log_json(&json!({ "body": "x".repeat(MAX_LOG_JSON_BYTES) }));
        assert!(output.contains("\"truncated\":true"));
        assert!(!output.contains(&"x".repeat(100)));
    }

    #[test]
    fn prunes_api_and_operation_logs_older_than_retention_window() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE cloud_accounts (id INTEGER PRIMARY KEY, access_key_id TEXT NOT NULL); CREATE TABLE api_logs (id INTEGER PRIMARY KEY, account_id INTEGER, endpoint TEXT NOT NULL, action TEXT NOT NULL, request_params TEXT NOT NULL, response_params TEXT, status TEXT NOT NULL, message TEXT, created_at INTEGER NOT NULL); CREATE TABLE operation_logs (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL);").unwrap();
        let now = 1_000_000_000_i64;
        conn.execute("INSERT INTO api_logs(endpoint,action,request_params,status,created_at) VALUES('old','old','{}','成功',?1)", [now - LOG_RETENTION_MILLIS - 1]).unwrap();
        conn.execute("INSERT INTO operation_logs(created_at) VALUES(?1)", [now - LOG_RETENTION_MILLIS - 1]).unwrap();
        write_api(&conn, "missing", "new", "new", &json!({}), None, "成功", None, now).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM api_logs", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM operation_logs", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn filters_api_logs_by_keyword_and_status_with_bounded_pagination() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE cloud_accounts (id INTEGER PRIMARY KEY, account_name TEXT NOT NULL, access_key_id TEXT NOT NULL); CREATE TABLE api_logs (id INTEGER PRIMARY KEY, account_id INTEGER, endpoint TEXT NOT NULL, action TEXT NOT NULL, request_params TEXT NOT NULL, response_params TEXT, status TEXT NOT NULL, message TEXT, created_at INTEGER NOT NULL);").unwrap();
        conn.execute("INSERT INTO cloud_accounts(id,account_name,access_key_id) VALUES(1,'生产账号','public-id')", []).unwrap();
        conn.execute("INSERT INTO api_logs(account_id,endpoint,action,request_params,status,created_at) VALUES(1,'ecs.example.com','DescribeInstances','{}','成功',3)", []).unwrap();
        conn.execute("INSERT INTO api_logs(account_id,endpoint,action,request_params,status,created_at) VALUES(1,'dns.example.com','ListRecords','{}','失败',2)", []).unwrap();
        let rows = list_api(&conn, Some("ecs"), Some("成功"), 9999, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].action, "DescribeInstances");
        let empty = list_api(&conn, Some("ecs"), Some("失败"), 1, 0).unwrap();
        assert!(empty.is_empty());
    }
}
