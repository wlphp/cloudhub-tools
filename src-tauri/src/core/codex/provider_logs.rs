//! 供应商请求日志。记录请求参数、返回参数与错误；密钥在写入前脱敏。
use rusqlite::{params, Connection};
use serde::Serialize;

/// 每个供应商保留的最大日志条数，超出后丢弃最旧的记录。
pub const MAX_PER_PROVIDER: usize = 200;
/// 单条日志中请求体与响应体保留的最大字符数。
pub const MAX_BODY: usize = 64 * 1024;

pub const SCHEMA: &str = crate::core::database::CODEX_PROVIDER_LOGS_SCHEMA;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestLog {
    pub id: String,
    pub provider_id: String,
    pub source: String,
    pub method: String,
    pub url: String,
    pub request_body: String,
    pub client_request_body: String,
    pub status: Option<i64>,
    pub response_body: String,
    pub error: Option<String>,
    pub elapsed_ms: i64,
    pub created_at: i64,
}

/// 一次上游请求的明文快照，用于写入日志。
#[derive(Clone, Default)]
pub struct Exchange {
    pub method: String,
    pub url: String,
    pub request_body: String,
    pub client_request_body: String,
    pub status: Option<u16>,
    pub response_body: String,
    pub error: Option<String>,
    pub elapsed_ms: u64,
}

/// 脱敏：密钥不会以任何形式进入日志。
pub fn redact(text: &str, secret: Option<&str>) -> String {
    match secret {
        Some(secret) if !secret.is_empty() => text.replace(secret, "***"),
        _ => text.to_owned(),
    }
}

fn bounded(text: &str) -> String {
    if text.chars().count() <= MAX_BODY {
        return text.to_owned();
    }
    let mut value: String = text.chars().take(MAX_BODY).collect();
    value.push_str("\n…（内容过长已截断）");
    value
}

/// 保留请求参数正文用于本地排障，但始终移除凭据与授权字段。
fn safe_request_diagnostic(text: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(text) else { return String::new(); };
    fn scrub(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Object(map) => {
                let keys: Vec<String> = map.keys().cloned().collect();
                for key in keys {
                    let normalized = key.to_ascii_lowercase();
                    if matches!(normalized.as_str(), "authorization"|"api_key"|"apikey"|"token"|"secret"|"password"|"access_token"|"refresh_token") {
                        map.insert(key, serde_json::Value::String("[已省略]".into()));
                    } else if let Some(child) = map.get_mut(&key) { scrub(child); }
                }
            }
            serde_json::Value::Array(values) => values.iter_mut().for_each(scrub),
            _ => {}
        }
    }
    scrub(&mut value);
    serde_json::to_string(&value).map(|v| bounded(&v)).unwrap_or_default()
}

/// 仅保留诊断结构，不持久化模型输出或响应任意字段。
fn safe_diagnostic(text: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(text) else { return String::new(); };
    fn scrub(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Object(map) => {
                let keys: Vec<String> = map.keys().cloned().collect();
                for key in keys {
                    let normalized = key.to_ascii_lowercase();
                    if matches!(normalized.as_str(), "input"|"messages"|"prompt"|"content"|"text"|"output"|"choices"|"response"|"data"|"authorization"|"api_key"|"apikey"|"token"|"secret"|"client_metadata") {
                        map.insert(key, serde_json::Value::String("[已省略]".into()));
                    } else if let Some(child) = map.get_mut(&key) { scrub(child); }
                }
            }
            serde_json::Value::Array(values) => values.iter_mut().for_each(scrub),
            _ => {}
        }
    }
    scrub(&mut value);
    serde_json::to_string(&value).map(|v| bounded(&v)).unwrap_or_default()
}

/// 写入一条请求日志，并按供应商裁剪历史条数。
pub fn record(conn: &Connection, provider_id: &str, source: &str, exchange: &Exchange, secret: Option<&str>) -> Result<(), String> {
    conn.execute(
        "INSERT INTO codex_provider_request_logs(id,provider_id,source,method,url,request_body,status,response_body,error,elapsed_ms,created_at,client_request_body) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![
            uuid::Uuid::new_v4().to_string(),
            provider_id,
            source,
            exchange.method,
            exchange.url,
            safe_request_diagnostic(&redact(&exchange.request_body, secret)),
            exchange.status.map(i64::from),
            safe_diagnostic(&redact(&exchange.response_body, secret)),
            exchange.error,
            exchange.elapsed_ms as i64,
            chrono::Utc::now().timestamp_millis(),
            safe_request_diagnostic(&redact(&exchange.client_request_body, secret)),
        ],
    )
    .map_err(|_| "写入供应商请求日志失败")?;
    conn.execute(
        "DELETE FROM codex_provider_request_logs WHERE provider_id=?1 AND id NOT IN (SELECT id FROM codex_provider_request_logs WHERE provider_id=?1 ORDER BY created_at DESC,rowid DESC LIMIT ?2)",
        params![provider_id, MAX_PER_PROVIDER as i64],
    )
    .map_err(|_| "清理供应商请求日志失败")?;
    Ok(())
}

/// 读取供应商的请求日志，最新的排在前面。
pub fn list(conn: &Connection, provider_id: &str, limit: usize) -> Result<Vec<RequestLog>, String> {
    let limit = limit.clamp(1, MAX_PER_PROVIDER) as i64;
    let mut statement = conn
        .prepare("SELECT id,provider_id,source,method,url,request_body,status,response_body,error,elapsed_ms,created_at,client_request_body FROM codex_provider_request_logs WHERE provider_id=?1 ORDER BY created_at DESC,rowid DESC LIMIT ?2")
        .map_err(|_| "读取供应商请求日志失败")?;
    let rows = statement
        .query_map(params![provider_id, limit], |row| {
            Ok(RequestLog {
                id: row.get(0)?,
                provider_id: row.get(1)?,
                source: row.get(2)?,
                method: row.get(3)?,
                url: row.get(4)?,
                request_body: row.get(5)?,
                status: row.get(6)?,
                response_body: row.get(7)?,
                error: row.get(8)?,
                elapsed_ms: row.get(9)?,
                created_at: row.get(10)?,
                client_request_body: row.get(11)?,
            })
        })
        .map_err(|_| "读取供应商请求日志失败")?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| "读取供应商请求日志失败".into())
}

/// 清空供应商的请求日志，返回删除的条数。
pub fn clear(conn: &Connection, provider_id: &str) -> Result<usize, String> {
    conn.execute("DELETE FROM codex_provider_request_logs WHERE provider_id=?1", params![provider_id])
        .map_err(|_| "清空供应商请求日志失败".into())
}

/// 在后台线程写入请求日志，供网关等长驻任务使用。写日志失败不影响主流程。
pub fn record_async(provider_id: String, source: &'static str, exchange: Exchange, secret: Option<String>) {
    tokio::task::spawn_blocking(move || {
        if let Ok(conn) = crate::core::storage::open_db() {
            let _ = record(&conn, &provider_id, source, &exchange, secret.as_deref());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn
    }
    fn exchange() -> Exchange {
        Exchange {
            method: "POST".into(),
            url: "https://example.com/v1/responses".into(),
            request_body: "{\"model\":\"model-a\"}".into(),
            client_request_body: "{\"input\":\"client prompt\"}".into(),
            status: Some(200),
            response_body: "{\"ok\":true}".into(),
            error: None,
            elapsed_ms: 12,
        }
    }
    #[test]
    fn logs_keep_request_and_response_and_redact_credentials() {
        let conn = database();
        let secret = uuid::Uuid::new_v4().to_string();
        let mut value = exchange();
        value.request_body=format!(r#"{{"model":"model-a","input":[{{"role":"user","content":"private prompt"}}],"api_key":"{secret}"}}"#);
        value.response_body=format!(r#"{{"choices":[{{"message":{{"content":"private answer"}}}}],"usage":{{"total_tokens":12}},"echo":"{secret}"}}"#);
        record(&conn, "provider-a", "probe", &value, Some(&secret)).unwrap();
        let rows = list(&conn, "provider-a", 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].request_body.contains("model-a"));
        assert!(rows[0].request_body.contains("private prompt"));
        assert!(rows[0].request_body.contains("private prompt"));
        assert!(rows[0].request_body.contains("[已省略]"));
        assert!(!rows[0].request_body.contains(&secret));
        assert!(rows[0].client_request_body.contains("client prompt"));
        assert!(!rows[0].client_request_body.contains(&secret));
        assert!(rows[0].response_body.contains("total_tokens"));
        assert!(!rows[0].response_body.contains("private answer"));
        assert!(rows[0].response_body.contains("***"));
        assert!(!rows[0].response_body.contains(&secret));
        assert_eq!(rows[0].status, Some(200));
        assert_eq!(rows[0].elapsed_ms, 12);
        assert!(list(&conn, "provider-b", 10).unwrap().is_empty());
    }
    #[test]
    fn history_is_trimmed_to_the_newest_entries() {
        let conn = database();
        for index in 0..(MAX_PER_PROVIDER + 5) {
            let mut value = exchange();
            value.request_body = format!("{{\"index\":{index}}}");
            record(&conn, "provider-a", "probe", &value, None).unwrap();
        }
        let rows = list(&conn, "provider-a", MAX_PER_PROVIDER).unwrap();
        assert_eq!(rows.len(), MAX_PER_PROVIDER);
        assert!(rows[0].request_body.contains(&format!("{}", MAX_PER_PROVIDER + 4)));
        assert_eq!(clear(&conn, "provider-a").unwrap(), MAX_PER_PROVIDER);
        assert!(list(&conn, "provider-a", 10).unwrap().is_empty());
    }
}
