use crate::core::storage::{decrypt_secret, encrypt_secret};
use rusqlite::{params, Connection, OptionalExtension};
use zeroize::Zeroizing;

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
    fn encrypted_configuration_survives_reopen_and_explicit_changes() {
        use crate::core::crypto::{decrypt_secret_with_key, encrypt_secret_with_key};
        let path = std::env::temp_dir().join(format!("cloudhub-gateway-config-{}.sqlite", uuid::Uuid::new_v4()));
        let encryption_key = [7u8; 32];
        let first = Zeroizing::new("test-only-".repeat(4));
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(crate::core::database::CODEX_SCHEMA).unwrap();
        assert_eq!(summary(&conn).unwrap(), None);
        save_cipher(&conn, 58169, &encrypt_secret_with_key(&first, &encryption_key).unwrap()).unwrap();
        drop(conn);
        let conn = Connection::open(&path).unwrap();
        assert_eq!(summary(&conn).unwrap(), Some(58169));
        let cipher: String = conn.query_row("SELECT key_ciphertext FROM codex_gateway_config", [], |row| row.get(0)).unwrap();
        assert!(!cipher.contains(&*first));
        assert_eq!(decrypt_secret_with_key(&cipher, &encryption_key).unwrap(), *first);
        assert!(save_cipher(&conn, 80, &cipher).is_err());
        assert_eq!(summary(&conn).unwrap(), Some(58169));
        save_cipher(&conn, 8005, &cipher).unwrap();
        assert_eq!(summary(&conn).unwrap(), Some(8005));
        drop(conn);
        std::fs::remove_file(path).unwrap();
    }
}
