#[cfg(test)]
use crate::core::authenticator::formats::Envelope;
use crate::core::authenticator::vault::{decrypt_entry, encrypt_entry};
use crate::core::authenticator::{Entry, MAX_ENTRIES};
use rusqlite::{params, Connection, OptionalExtension};

pub const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS authenticator_vault (id INTEGER PRIMARY KEY CHECK(id=1), envelope_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS authenticator_entries (id TEXT PRIMARY KEY, ciphertext TEXT NOT NULL);";
pub fn header(conn: &Connection) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT envelope_json FROM authenticator_vault WHERE id=1",
        [],
        |r| r.get(0),
    )
    .optional()
    .map_err(|_| "读取验证器密码库失败".into())
}
#[cfg(test)]
pub fn create(conn: &Connection, envelope: &Envelope) -> Result<String, String> {
    let json = serde_json::to_string(envelope).map_err(|_| "密码库初始化失败")?;
    conn.execute(
        "INSERT INTO authenticator_vault(id,envelope_json) VALUES(1,?1)",
        [&json],
    )
    .map_err(|_| "密码库已存在或无法初始化")?;
    Ok(json)
}
pub fn load(conn: &Connection, key: &[u8; 32]) -> Result<Vec<Entry>, String> {
    let mut statement = conn
        .prepare("SELECT id,ciphertext FROM authenticator_entries ORDER BY id LIMIT 10001")
        .map_err(|_| "读取验证码失败")?;
    let rows = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|_| "读取验证码失败")?;
    let mut entries = vec![];
    for row in rows {
        let (id, ciphertext) = row.map_err(|_| "读取验证码失败")?;
        entries.push(decrypt_entry(key, &id, &ciphertext)?);
    }
    if entries.len() > MAX_ENTRIES {
        return Err("验证码数量超过 10000".into());
    }
    entries.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then(a.order.cmp(&b.order))
            .then(a.issuer.cmp(&b.issuer))
            .then(a.account.cmp(&b.account))
    });
    Ok(entries)
}
pub fn write(conn: &Connection, key: &[u8; 32], entry: &Entry) -> Result<(), String> {
    let ciphertext = encrypt_entry(key, entry)?;
    conn.execute("INSERT INTO authenticator_entries(id,ciphertext) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext",params![entry.id,ciphertext]).map_err(|_| "保存验证码失败")?;
    Ok(())
}
pub fn selected(conn: &Connection, key: &[u8; 32], ids: &[String]) -> Result<Vec<Entry>, String> {
    if ids.len() > MAX_ENTRIES {
        return Err("验证码选择数量过大".into());
    }
    let mut query = conn
        .prepare_cached("SELECT ciphertext FROM authenticator_entries WHERE id=?1")
        .map_err(|_| "读取验证码失败")?;
    let mut entries = vec![];
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        if !seen.insert(id) {
            continue;
        }
        let ciphertext: Option<String> = query
            .query_row([id], |row| row.get(0))
            .optional()
            .map_err(|_| "读取验证码失败")?;
        if let Some(ciphertext) = ciphertext {
            entries.push(decrypt_entry(key, id, &ciphertext)?);
        }
    }
    Ok(entries)
}
pub fn remove(conn: &mut Connection, ids: &[String]) -> Result<(), String> {
    if ids.is_empty() || ids.len() > MAX_ENTRIES {
        return Err("删除选择无效".into());
    }
    let tx = conn.transaction().map_err(|_| "无法开始删除事务")?;
    for id in ids {
        if tx
            .execute("DELETE FROM authenticator_entries WHERE id=?1", [id])
            .map_err(|_| "删除验证码失败")?
            != 1
        {
            return Err("待删除验证码不存在".into());
        }
    }
    tx.commit().map_err(|_| "提交删除失败".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::authenticator::formats::parse_uri;
    #[test]
    fn encrypted_repository_atomic_delete_and_wrong_key() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch(SCHEMA).unwrap();
        let key = [8u8; 32];
        let entry =
            parse_uri("otpauth://totp/Example:demo?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")
                .unwrap();
        write(&db, &key, &entry).unwrap();
        assert!(load(&db, &[9u8; 32]).is_err());
        assert_eq!(load(&db, &key).unwrap().len(), 1);
        assert!(remove(&mut db, &[entry.id.clone(), "missing".into()]).is_err());
        assert_eq!(load(&db, &key).unwrap().len(), 1);
        remove(&mut db, &[entry.id.clone()]).unwrap();
        assert!(load(&db, &key).unwrap().is_empty());
    }
}
