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
}

impl Kind {
    fn key(self) -> &'static str {
        match self { Self::Operation => "operation", Self::Voice => "voice" }
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
    };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if append(kind, &entry).is_ok() {
            let _ = app.emit_to(super::LABEL, "pet-activity-changed", kind.key());
        }
    });
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
