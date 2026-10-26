//! Password protection for complete backups. Fixed, versioned KDF parameters
//! prevent an untrusted header from requesting excessive resources.
use aes_gcm::{aead::{Aead, KeyInit, Payload}, Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;
use zeroize::Zeroizing;

pub(super) const MAGIC: &[u8; 8] = b"CHDBENC2";
pub(super) const MAX_BYTES: u64 = 256 * 1024 * 1024;
const HEADER_LEN: usize = 8 + 16 + 12;

pub(super) fn validate_password(password: &str) -> Result<(), String> {
    if password.chars().count() < 8 || password.len() > 1024 {
        return Err("备份密码至少 8 个字符，最多 1024 个 UTF-8 字节".into());
    }
    Ok(())
}

fn key(password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, String> {
    validate_password(password)?;
    let params = Params::new(65536, 3, 1, Some(32)).map_err(|_| "备份加密初始化失败")?;
    let kdf = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; 32]);
    kdf.hash_password_into(password.as_bytes(), salt, &mut key[..]).map_err(|_| "备份密钥派生失败")?;
    Ok(key)
}

pub(super) fn seal(plaintext: &[u8], password: &str) -> Result<Vec<u8>, String> {
    if plaintext.is_empty() || plaintext.len() as u64 > MAX_BYTES - 64 { return Err("备份超过 256 MB 限制".into()); }
    let mut header = [0u8; HEADER_LEN];
    header[..8].copy_from_slice(MAGIC);
    rand::thread_rng().fill_bytes(&mut header[8..]);
    let key = key(password, &header[8..24])?;
    let cipher = Aes256Gcm::new_from_slice(&key[..]).map_err(|_| "备份加密初始化失败")?;
    let encrypted = cipher.encrypt(Nonce::from_slice(&header[24..]), Payload { msg: plaintext, aad: &header })
        .map_err(|_| "备份加密失败")?;
    let mut result = header.to_vec();
    result.extend(encrypted);
    Ok(result)
}

pub(super) fn open(bytes: &[u8], password: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    if bytes.len() < HEADER_LEN + 16 || bytes.len() as u64 > MAX_BYTES || !bytes.starts_with(MAGIC) {
        return Err("加密备份格式或大小无效".into());
    }
    let key = key(password, &bytes[8..24])?;
    let cipher = Aes256Gcm::new_from_slice(&key[..]).map_err(|_| "备份加密初始化失败")?;
    cipher.decrypt(Nonce::from_slice(&bytes[24..HEADER_LEN]), Payload { msg: &bytes[HEADER_LEN..], aad: &bytes[..HEADER_LEN] })
        .map(Zeroizing::new).map_err(|_| "备份密码错误或文件已损坏".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn portable_backup_preserves_ciphertext_and_restores_with_embedded_key_without_password() {
        use crate::core::crypto::{encrypt_secret_with_key, decrypt_secret_with_key};
        let root = std::env::temp_dir().join(format!("cloudhub-portable-backup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let database_path = root.join("fixture.sqlite3");
        let package_path = root.join("fixture.chdb");
        let recovery_key = Zeroizing::new([73u8; 32]);
        let fixture = "non-sensitive-credential-fixture";
        let ciphertext = encrypt_secret_with_key(fixture, &recovery_key[..]).unwrap();
        let connection = rusqlite::Connection::open(&database_path).unwrap();
        connection.execute_batch("CREATE TABLE fixture(secret_ciphertext TEXT NOT NULL)").unwrap();
        connection.execute("INSERT INTO fixture VALUES(?1)", [&ciphertext]).unwrap();
        drop(connection);
        let database = std::fs::read(&database_path).unwrap();
        let package = Zeroizing::new(super::super::package_bytes(&database, &recovery_key[..]).unwrap());
        assert!(package.starts_with(b"CHDBMIG1"));
        assert!(!package.windows(fixture.len()).any(|part| part == fixture.as_bytes()));
        std::fs::write(&package_path, &*package).unwrap();
        let (restored_database, key, _) = super::super::parse_package_password(&package_path, None).unwrap();
        let key = Zeroizing::new(key);
        assert_eq!(restored_database, database);
        std::fs::write(&database_path, restored_database).unwrap();
        let restored = rusqlite::Connection::open(&database_path).unwrap();
        let saved: String = restored.query_row("SELECT secret_ciphertext FROM fixture", [], |row| row.get(0)).unwrap();
        assert_eq!(saved, ciphertext);
        assert_eq!(decrypt_secret_with_key(&saved, &key).unwrap(), fixture);
        assert!(decrypt_secret_with_key(&saved, &[74u8; 32]).is_err());
        drop(restored);
        let mut damaged = package.to_vec();
        *damaged.last_mut().unwrap() ^= 1;
        std::fs::write(&package_path, damaged).unwrap();
        assert!(super::super::parse_package_password(&package_path, None).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn password_backup_roundtrip_rejects_wrong_password_and_tampering() {
        let a = seal(b"non-secret fixture", "fixture-password").unwrap();
        let b = seal(b"non-secret fixture", "fixture-password").unwrap();
        assert_ne!(a, b);
        assert!(!a.windows(18).any(|part| part == b"non-secret fixture"));
        assert_eq!(&**open(&a, "fixture-password").unwrap(), b"non-secret fixture");
        assert!(open(&a, "wrong-password").is_err());
        let mut damaged = a;
        *damaged.last_mut().unwrap() ^= 1;
        assert!(open(&damaged, "fixture-password").is_err());
        assert!(seal(b"fixture", "short").is_err());
    }
    #[test]
    fn complete_package_hides_database_and_recovery_key_and_keeps_legacy_readable() {
        let database = b"SQLite format 3\0fixture-database";
        let recovery_key = [91u8; 32];
        let package = Zeroizing::new(super::super::package_bytes(database, &recovery_key).unwrap());
        let encrypted = seal(&package, "fixture-password").unwrap();
        assert!(!encrypted.windows(recovery_key.len()).any(|part| part == recovery_key));
        assert!(!encrypted.windows(database.len()).any(|part| part == database));
        let unlocked = open(&encrypted, "fixture-password").unwrap();
        for bytes in [&*package, &*unlocked] {
            let (db, key, _) = super::super::parse_package_bytes(bytes, std::path::Path::new("fixture.chdb")).unwrap();
            assert_eq!(db,database); assert_eq!(key,recovery_key);
        }
        let mut damaged = package.to_vec(); *damaged.last_mut().unwrap() ^= 1;
        assert!(super::super::parse_package_bytes(&damaged,std::path::Path::new("fixture.chdb")).is_err());
    }
}
