use super::open_db;
use crate::core::crypto::{decrypt_secret, encrypt_secret};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

const PAGE_SIZE: usize = 9;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Attachment {
    pub name: String,
    pub text: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Turn {
    pub user: String,
    pub reply: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment: Option<Attachment>,
}

#[derive(Serialize)]
pub struct Record {
    id: i64,
    #[serde(flatten)]
    turn: Turn,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    turns: Vec<Record>,
    has_older: bool,
}

fn connection() -> Result<Connection, String> {
    let db = open_db()?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS pet_chat_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_id TEXT NOT NULL,
            revision INTEGER NOT NULL,
            ciphertext TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pet_chat_history_profile ON pet_chat_history(profile_id, revision, id);",
    ).map_err(|_| "无法初始化本地聊天记录")?;
    Ok(db)
}

fn decode(ciphertext: &str) -> Result<Turn, String> {
    let json = zeroize::Zeroizing::new(decrypt_secret(ciphertext)
        .map_err(|_| "无法解密本地聊天记录")?);
    serde_json::from_str(&json).map_err(|_| "本地聊天记录格式无效".into())
}

pub(super) fn page(before: Option<i64>) -> Result<Page, String> {
    let db = connection()?;
    let mut query = db.prepare("SELECT id, ciphertext FROM pet_chat_history WHERE id < ?1 ORDER BY id DESC LIMIT ?2")
        .map_err(|_| "无法读取本地聊天记录")?;
    let mut rows = query.query(params![before.unwrap_or(i64::MAX), PAGE_SIZE + 1])
        .map_err(|_| "无法读取本地聊天记录")?;
    let mut turns = Vec::with_capacity(PAGE_SIZE);
    while turns.len() < PAGE_SIZE {
        let Some(row) = rows.next().map_err(|_| "无法读取本地聊天记录")? else { break };
        turns.push(Record {
            id: row.get(0).map_err(|_| "无法读取聊天记录编号")?,
            turn: decode(&row.get::<_, String>(1).map_err(|_| "无法读取本地聊天内容")?)?,
        });
    }
    let has_older = rows.next().map_err(|_| "无法读取本地聊天记录")?.is_some();
    turns.reverse();
    Ok(Page { turns, has_older })
}

pub(super) fn recent(profile: &str, revision: i64) -> Result<Vec<Turn>, String> {
    let db = connection()?;
    let mut query = db.prepare("SELECT ciphertext FROM pet_chat_history WHERE profile_id = ?1 AND revision = ?2 ORDER BY id DESC LIMIT 9")
        .map_err(|_| "无法读取聊天上下文")?;
    let rows = query.query_map(params![profile, revision], |row| row.get::<_, String>(0))
        .map_err(|_| "无法读取聊天上下文")?;
    rows.map(|row| decode(&row.map_err(|_| "无法读取聊天上下文")?)).collect()
}

pub(super) fn append(profile: &str, revision: i64, turn: Turn) -> Result<Record, String> {
    let json = zeroize::Zeroizing::new(serde_json::to_string(&turn).map_err(|_| "无法整理聊天记录")?);
    let ciphertext = encrypt_secret(&json).map_err(|_| "无法加密聊天记录")?;
    let db = connection()?;
    db.execute("INSERT INTO pet_chat_history(profile_id, revision, ciphertext) VALUES (?1, ?2, ?3)", params![profile, revision, ciphertext])
        .map_err(|_| "无法保存聊天记录")?;
    Ok(Record { id: db.last_insert_rowid(), turn })
}

pub(super) fn clear() -> Result<(), String> {
    connection()?.execute_batch("PRAGMA secure_delete=ON; DELETE FROM pet_chat_history;")
        .map_err(|_| "无法清空聊天记录".into())
}
