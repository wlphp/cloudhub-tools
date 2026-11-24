use std::time::Instant;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use zeroize::Zeroizing;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Operation,
    Voice,
    Tts,
}

impl Kind {
    fn key(self) -> &'static str {
        match self { Self::Operation => "operation", Self::Voice => "voice", Self::Tts => "tts" }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    id: String,
    time: i64,
    duration_ms: u64,
    title: String,
    status: String,
    detail: Option<String>,
    #[serde(default)]
    endpoint: Option<String>,
    #[serde(default)]
    request_body: Option<serde_json::Value>,
    #[serde(default)]
    response_body: Option<serde_json::Value>,
}

fn connection() -> Result<Connection, String> {
    let db = super::open_db()?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS pet_activity (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS pet_activity_by_kind ON pet_activity(kind, id);",
    ).map_err(|_| "无法初始化桌宠记录")?;
    Ok(db)
}

pub(in crate::commands) fn record(app: &AppHandle, kind: Kind, start: Instant, title: &str, status: &str, detail: Option<&str>) {
    let detail = detail.map(|value| {
        if !crate::core::ai::preview(value).is_ok_and(|safe| safe.removed_lines == 0) {
            return "识别到疑似敏感内容，已隐藏文字。".into();
        }
        value.trim().chars().take(1000).collect()
    }).filter(|text: &String| !text.is_empty());
    let entry = Entry {
        id: uuid::Uuid::new_v4().to_string(),
        time: chrono::Utc::now().timestamp_millis(),
        duration_ms: start.elapsed().as_millis() as u64,
        title: title.into(),
        status: status.into(),
        detail,
        endpoint: None,
        request_body: None,
        response_body: None,
    };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if append(kind, &entry).is_ok() {
            let _ = app.emit_to(super::LABEL, "pet-activity-changed", kind.key());
        }
    });
}

/// Records actual network calls, including early failures and cancellations.
pub(in crate::commands::desktop_pet) struct ApiCall {
    app: AppHandle,
    kind: Kind,
    start: Instant,
    entry: Entry,
    secrets: Vec<Zeroizing<String>>,
}

impl ApiCall {
    pub(in crate::commands::desktop_pet) fn new(app: &AppHandle, kind: Kind, title: &str, method: &str, endpoint: &str, request: serde_json::Value, secrets: &[&str]) -> Self {
        let secrets: Vec<_> = secrets.iter().map(|value| Zeroizing::new((*value).to_owned())).collect();
        let safe = |mut value| {
            for secret in &secrets { value = crate::core::ai::pet_log_body(&value, secret.as_str()); }
            crate::core::ai::pet_log_body(&value, "")
        };
        let endpoint = reqwest::Url::parse(endpoint).ok().map(|mut url| {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_query(None);
            url.set_fragment(None);
            url.to_string()
        }).unwrap_or_else(|| "[地址无效]".into());
        Self { app: app.clone(), kind, start: Instant::now(), entry: Entry {
            id: uuid::Uuid::new_v4().to_string(), time: chrono::Utc::now().timestamp_millis(), duration_ms: 0,
            title: title.into(), status: "失败或已取消".into(), detail: None,
            endpoint: safe(serde_json::json!(format!("{method} {endpoint}"))).as_str().map(str::to_owned),
            request_body: Some(safe(request)),
            response_body: Some(serde_json::json!({"说明":"未收到可记录的响应"})),
        }, secrets }
    }

    pub(in crate::commands::desktop_pet) fn response(&mut self, value: serde_json::Value) {
        let mut safe = value;
        for secret in &self.secrets { safe = crate::core::ai::pet_log_body(&safe, secret.as_str()); }
        self.entry.response_body = Some(crate::core::ai::pet_log_body(&safe, ""));
    }

    pub(in crate::commands::desktop_pet) fn success(&mut self) { self.entry.status = "成功".into(); }
}

impl Drop for ApiCall {
    fn drop(&mut self) {
        self.entry.duration_ms = self.start.elapsed().as_millis() as u64;
        let Ok(json) = serde_json::to_string(&self.entry) else { return; };
        let json = Zeroizing::new(json);
        let app = self.app.clone();
        let kind = self.kind;
        tauri::async_runtime::spawn_blocking(move || {
            let Ok(entry) = serde_json::from_str(&json) else { return; };
            if append(kind, &entry).is_ok() { let _ = app.emit_to(super::LABEL, "pet-activity-changed", kind.key()); }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activity_log_reads_older_records_without_api_fields() {
        let entry: Entry = serde_json::from_value(serde_json::json!({
            "id":"older", "time":0, "durationMs":12, "title":"语音播报", "status":"成功", "detail":"测试文字"
        })).unwrap();
        assert!(entry.endpoint.is_none());
        assert!(entry.request_body.is_none());
        assert!(entry.response_body.is_none());
    }

    #[test]
    fn activity_log_body_reuses_bounded_credential_redaction() {
        let body = crate::core::ai::pet_log_body(&serde_json::json!({
            "model":"example-model", "authorization":"占位内容", "nested":{"password":"占位内容"},
            "message":"测试文字", "large":"字".repeat(33000)
        }), "");
        assert_eq!(body["model"], "example-model");
        assert_eq!(body["authorization"], "[已脱敏]");
        assert_eq!(body["nested"]["password"], "[已脱敏]");
        assert_eq!(body["message"], "测试文字");
        assert_eq!(body["large"], "[字段超过记录上限]");
    }
}

fn append(kind: Kind, entry: &Entry) -> Result<(), String> {
    let json = Zeroizing::new(serde_json::to_string(entry).map_err(|_| "无法整理桌宠记录")?);
    let body = crate::core::crypto::encrypt_secret(&json).map_err(|_| "无法加密桌宠记录")?;
    let mut db = connection()?;
    let write_error = |_| "无法保存桌宠记录";
    let tx = db.transaction().map_err(write_error)?;
    tx.execute("INSERT INTO pet_activity(kind, body) VALUES (?1, ?2)", params![kind.key(), body]).map_err(write_error)?;
    tx.execute("DELETE FROM pet_activity WHERE id IN (SELECT id FROM pet_activity WHERE kind=?1 ORDER BY id DESC LIMIT -1 OFFSET 100)", [kind.key()]).map_err(write_error)?;
    tx.commit().map_err(|_| "无法保存桌宠记录".into())
}

pub(super) fn list(kind: Kind) -> Result<Vec<Entry>, String> {
    let db = connection()?;
    let read_error = |_| "无法读取桌宠记录";
    let mut statement = db.prepare("SELECT body FROM pet_activity WHERE kind=?1 ORDER BY id DESC LIMIT 100").map_err(read_error)?;
    let rows = statement.query_map([kind.key()], |row| row.get::<_, String>(0)).map_err(read_error)?;
    rows.map(|row| {
        let body = row.map_err(read_error)?;
        let json = Zeroizing::new(crate::core::crypto::decrypt_secret(&body).map_err(|_| "无法解密桌宠记录")?);
        serde_json::from_str(&json).map_err(|_| "桌宠记录格式无效".into())
    }).collect()
}
