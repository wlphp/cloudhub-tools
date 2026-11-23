use super::open_db;
use crate::core::ai::PetRequestTrace;
use crate::core::crypto::{decrypt_secret, encrypt_secret};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

const LIMIT: i64 = 100;
const ENCRYPTED_PREFIX: &str = "encrypted:";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: String,
    pub started_at: i64,
    pub duration_ms: u64,
    pub outcome: String,
    pub trace: PetRequestTrace,
}

fn connection() -> Result<Connection, String> {
    let db = open_db()?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS pet_chat_calls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at INTEGER NOT NULL,
            diagnostic TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pet_chat_calls_time ON pet_chat_calls(started_at, id);",
    ).map_err(|_| "无法初始化模型调用记录")?;
    Ok(db)
}

pub(super) fn append(record: &Record) -> Result<(), String> {
    let mut db = connection()?;
    let json = zeroize::Zeroizing::new(serde_json::to_string(record).map_err(|_| "无法整理模型调用记录")?);
    let encrypted = encrypt_secret(&json).map_err(|_| "无法加密模型调用记录")?;
    let diagnostic = format!("{ENCRYPTED_PREFIX}{encrypted}");
    let save = || "无法保存模型调用记录";
    let tx = db.transaction().map_err(|_| save())?;
    tx.execute("INSERT INTO pet_chat_calls(started_at, diagnostic) VALUES (?1, ?2)",
        params![record.started_at, diagnostic]).map_err(|_| save())?;
    tx.execute(
        "DELETE FROM pet_chat_calls WHERE id IN (
            SELECT id FROM pet_chat_calls ORDER BY started_at DESC, id DESC LIMIT -1 OFFSET ?1
        )", [LIMIT],
    ).map_err(|_| save())?;
    tx.commit().map_err(|_| save().into())
}

pub(super) fn list() -> Result<Vec<Record>, String> {
    let db = connection()?;
    let read = || "无法读取模型调用记录";
    let mut query = db.prepare("SELECT diagnostic FROM pet_chat_calls ORDER BY started_at DESC, id DESC LIMIT ?1")
        .map_err(|_| read())?;
    let rows = query.query_map([LIMIT], |row| row.get::<_, String>(0)).map_err(|_| read())?;
    rows.map(|row| {
        let diagnostic = row.map_err(|_| read())?;
        let json = zeroize::Zeroizing::new(match diagnostic.strip_prefix(ENCRYPTED_PREFIX) {
            Some(ciphertext) => decrypt_secret(ciphertext).map_err(|_| "无法解密模型调用记录")?,
            None => diagnostic,
        });
        serde_json::from_str(&json).map_err(|_| "模型调用记录格式无效".into())
    }).collect()
}
