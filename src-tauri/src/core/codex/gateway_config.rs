use crate::core::storage::{decrypt_secret, encrypt_secret};
use rusqlite::{params, Connection, OptionalExtension};
use zeroize::Zeroizing;

pub fn allow_lan(conn: &Connection) -> Result<bool, String> {
    conn.query_row("SELECT allow_lan FROM codex_gateway_network WHERE id=1", [], |row| row.get(0)).optional().map(|value| value.unwrap_or(false)).map_err(|_| "读取服务访问范围失败".into())
}
pub fn save_allow_lan(conn: &Connection, enabled: bool) -> Result<(), String> {
    conn.execute("INSERT INTO codex_gateway_network(id,allow_lan) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET allow_lan=excluded.allow_lan", [enabled]).map_err(|_| "保存服务访问范围失败")?;
    Ok(())
}

pub fn summary(conn: &Connection) -> Result<Option<u16>, String> {
    conn.query_row("SELECT port FROM codex_gateway_config WHERE id=1", [], |row| row.get(0))
        .optional().map_err(|_| "读取本地 API 配置失败".into())
}

pub fn key(conn: &Connection) -> Result<Option<Zeroizing<String>>, String> {
    let cipher: Option<String> = conn.query_row("SELECT key_ciphertext FROM codex_gateway_config WHERE id=1", [], |row| row.get(0))
        .optional().map_err(|_| "读取本地 API 配置失败")?;
    cipher.map(|value| decrypt_secret(&value).map(Zeroizing::new).map_err(|_| "解密本地 API 配置失败".into())).transpose()
}

pub fn save(conn: &Connection, port: u16, key: &str) -> Result<(), String> {
    let cipher = encrypt_secret(key).map_err(|_| "加密本地 API 配置失败")?;
    save_cipher(conn, port, &cipher)
}

pub fn startup(conn: &Connection) -> Result<(bool, Vec<i64>), String> {
    let row: Option<(bool, String)> = conn.query_row("SELECT auto_start,account_ids_json FROM codex_gateway_config WHERE id=1", [], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional().map_err(|_| "读取反代自动启动配置失败")?;
    let (enabled, raw) = row.unwrap_or_else(|| (false, "[]".into()));
    let raw = conn.query_row("SELECT account_ids_json FROM codex_gateway_pool WHERE id=1", [], |row| row.get::<_, String>(0)).optional().map_err(|_| "读取反代账号池失败")?.unwrap_or(raw);
    let ids: Vec<i64> = serde_json::from_str(&raw).map_err(|_| "反代自动启动账号配置无效")?;
    if ids.len() > 100 || ids.iter().any(|id| *id <= 0) || ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len() { return Err("反代自动启动账号配置无效".into()); }
    Ok((enabled, ids))
}
pub fn save_pool(conn: &Connection, ids: &[i64]) -> Result<(), String> {
    if ids.len() > 100 || ids.iter().any(|id| *id <= 0) || ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len() { return Err("服务账号选择无效".into()); }
    let raw = serde_json::to_string(ids).map_err(|_| "保存反代账号配置失败")?;
    conn.execute("INSERT INTO codex_gateway_pool(id,account_ids_json) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET account_ids_json=excluded.account_ids_json", [raw]).map_err(|_| "保存反代账号配置失败")?;
    Ok(())
}
pub fn save_startup(conn: &Connection, enabled: bool, ids: &[i64]) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|_| "保存反代自动启动配置失败")?;
    if enabled { if ids.is_empty() { return Err("请选择服务账号".into()); } save_pool(&tx, ids)?; }
    if tx.execute("UPDATE codex_gateway_config SET auto_start=?1 WHERE id=1", [enabled]).map_err(|_| "保存反代自动启动配置失败")? != 1 { return Err("请先保存端口或启动一次服务".into()); }
    tx.commit().map_err(|_| "保存反代自动启动配置失败".into())
}

fn save_cipher(conn: &Connection, port: u16, cipher: &str) -> Result<(), String> {
    if port < 1024 { return Err("本地 API 固定端口无效".into()); }
    conn.execute("INSERT INTO codex_gateway_config(id,port,key_ciphertext) VALUES(1,?1,?2) ON CONFLICT(id) DO UPDATE SET port=excluded.port,key_ciphertext=excluded.key_ciphertext", params![port, cipher])
        .map_err(|_| "保存本地 API 配置失败")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn network_scope_defaults_to_loopback_and_survives_reopen() {
        let path = std::env::temp_dir().join(format!("cloudhub-network-{}.sqlite", uuid::Uuid::new_v4()));
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(crate::core::database::CODEX_SCHEMA).unwrap();
        assert!(!allow_lan(&conn).unwrap());
        save_allow_lan(&conn, true).unwrap();
        drop(conn);
        let conn = Connection::open(&path).unwrap();
        assert!(allow_lan(&conn).unwrap());
        save_allow_lan(&conn, false).unwrap();
        assert!(!allow_lan(&conn).unwrap());
        drop(conn);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn account_pool_survives_reopen_without_starting_or_configuring_service() {
        let path = std::env::temp_dir().join(format!("cloudhub-pool-{}.sqlite", uuid::Uuid::new_v4()));
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(crate::core::database::CODEX_SCHEMA).unwrap();
        save_pool(&conn, &[1, 2]).unwrap();
        assert_eq!(summary(&conn).unwrap(), None);
        assert_eq!(startup(&conn).unwrap(), (false, vec![1, 2]));
        drop(conn);
        let conn = Connection::open(&path).unwrap();
        assert_eq!(startup(&conn).unwrap(), (false, vec![1, 2]));
        assert!(save_pool(&conn, &[1, 1]).is_err());
        assert_eq!(startup(&conn).unwrap(), (false, vec![1, 2]));
        save_pool(&conn, &[]).unwrap();
        drop(conn);
        let conn = Connection::open(&path).unwrap();
        assert_eq!(startup(&conn).unwrap(), (false, vec![]));
        drop(conn);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn encrypted_configuration_survives_reopen_and_explicit_changes() {
        use crate::core::crypto::{decrypt_secret_with_key, encrypt_secret_with_key};
        let path = std::env::temp_dir().join(format!("cloudhub-gateway-config-{}.sqlite", uuid::Uuid::new_v4()));
        let encryption_key = [7u8; 32];
        let first = Zeroizing::new("test-only-".repeat(4));
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(crate::core::database::CODEX_SCHEMA).unwrap();
        assert_eq!(summary(&conn).unwrap(), None);
        save_cipher(&conn, 58169, &encrypt_secret_with_key(&first, &encryption_key).unwrap()).unwrap();
        assert_eq!(startup(&conn).unwrap(), (false, vec![]));
        assert!(save_startup(&conn, true, &[]).is_err());
        save_startup(&conn, true, &[1, 2]).unwrap();
        drop(conn);
        let conn = Connection::open(&path).unwrap();
        assert_eq!(summary(&conn).unwrap(), Some(58169));
        assert_eq!(startup(&conn).unwrap(), (true, vec![1, 2]));
        assert!(save_startup(&conn, true, &[1, 1]).is_err());
        assert_eq!(startup(&conn).unwrap(), (true, vec![1, 2]));
        let cipher: String = conn.query_row("SELECT key_ciphertext FROM codex_gateway_config", [], |row| row.get(0)).unwrap();
        assert!(!cipher.contains(&*first));
        assert_eq!(decrypt_secret_with_key(&cipher, &encryption_key).unwrap(), *first);
        assert!(save_cipher(&conn, 80, &cipher).is_err());
        assert_eq!(summary(&conn).unwrap(), Some(58169));
        save_cipher(&conn, 8005, &cipher).unwrap();
        assert_eq!(summary(&conn).unwrap(), Some(8005));
        assert_eq!(startup(&conn).unwrap(), (true, vec![1, 2]));
        save_startup(&conn, false, &[]).unwrap();
        assert_eq!(startup(&conn).unwrap(), (false, vec![1, 2]));
        drop(conn);
        std::fs::remove_file(path).unwrap();
    }
}
