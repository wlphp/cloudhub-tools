use super::{formats, Entry, EntrySummary};
use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::RngCore;
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

pub struct Stage {
    pub id: String,
    pub entries: Vec<Entry>,
    pub created: Instant,
}
pub struct Session {
    pub key: Zeroizing<[u8; 32]>,
    pub owner: String,
    pub header: String,
    pub action: Instant,
    pub poll: Instant,
    pub stage: Option<Stage>,
}
#[derive(Default, Clone)]
pub struct VaultStore {
    pub session: Arc<Mutex<Option<Session>>>,
    pub failed_unlock: Arc<Mutex<Option<Instant>>>,
    pub dialog_active: Arc<AtomicBool>,
    pub generation: Arc<AtomicU64>,
}
pub struct DialogGuard(Arc<AtomicBool>);
impl Drop for DialogGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub initialized: bool,
    pub unlocked: bool,
    pub password_required: bool,
}

pub const DEVICE_HEADER: &str = "{\"format\":\"cloudhub-authenticator-device\",\"version\":1}";

pub fn device_key_path() -> Result<std::path::PathBuf, String> {
    Ok(crate::core::paths::data_dir()?.join(".authenticator.key"))
}

#[cfg(not(mobile))]
pub fn read_device_key(path: &std::path::Path) -> Result<Zeroizing<[u8; 32]>, String> {
    use std::io::Read;
    let mut bytes = Zeroizing::new(Vec::new());
    std::fs::File::open(path)
        .map_err(|_| "验证器本机密钥文件缺失，需从独立备份恢复")?
        .take(33)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取验证器本机密钥")?;
    Ok(Zeroizing::new(
        bytes
            .as_slice()
            .try_into()
            .map_err(|_| "验证器本机密钥文件无效")?,
    ))
}

#[cfg(mobile)]
pub fn read_device_key(_path: &std::path::Path) -> Result<Zeroizing<[u8; 32]>, String> {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    let root = Zeroizing::new(crate::core::crypto::crypto_key_bytes()?);
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&root).map_err(|_| "手机验证器密钥不可用")?;
    mac.update(b"cloudhub-authenticator-device-key:v1");
    Ok(Zeroizing::new(mac.finalize().into_bytes().into()))
}

pub fn persist_device_key(path: &std::path::Path, key: &[u8; 32]) -> Result<(), String> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(path) {
        Ok(mut file) => {
            if file.write_all(key).and_then(|_| file.sync_all()).is_err() {
                drop(file);
                let _ = std::fs::remove_file(path);
                return Err("无法保存验证器本机密钥".into());
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            if *read_device_key(path)? != *key {
                return Err("本机已有不同的验证器密钥，未覆盖原数据".into());
            }
            Ok(())
        }
        Err(_) => Err("无法创建验证器本机密钥".into()),
    }
}

pub fn initialize_device(
    db: &mut rusqlite::Connection,
    path: &std::path::Path,
) -> Result<String, String> {
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| "无法开始验证器初始化")?;
    if let Some(header) = crate::core::repositories::authenticator::header(&tx)? {
        return Ok(header);
    }
    #[cfg(mobile)]
    let key = read_device_key(path)?;
    #[cfg(not(mobile))]
    let key = if path.exists() {
        read_device_key(path)?
    } else {
        let mut key = Zeroizing::new([0u8; 32]);
        rand::thread_rng().fill_bytes(&mut *key);
        persist_device_key(path, &key)?;
        key
    };
    let _ = key;
    tx.execute(
        "INSERT INTO authenticator_vault(id,envelope_json) VALUES(1,?1)",
        [DEVICE_HEADER],
    )
    .map_err(|_| "无法初始化验证器")?;
    tx.commit().map_err(|_| "无法提交验证器初始化")?;
    Ok(DEVICE_HEADER.into())
}

pub fn migrate_device(
    db: &mut rusqlite::Connection,
    path: &std::path::Path,
    old_header: &str,
    password: &str,
) -> Result<Zeroizing<[u8; 32]>, String> {
    let key = unwrap_key(old_header, password)?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| "无法开始验证器迁移")?;
    crate::core::repositories::authenticator::load(&tx, &key)?;
    if crate::core::repositories::authenticator::header(&tx)?.as_deref() != Some(old_header) {
        return Err("验证器数据已变化，请重试".into());
    }
    #[cfg(not(mobile))]
    persist_device_key(path, &key)?;
    #[cfg(mobile)]
    let key = {
        let entries = crate::core::repositories::authenticator::load(&tx, &key)?;
        let new_key = read_device_key(path)?;
        for entry in entries { crate::core::repositories::authenticator::write(&tx, &new_key, &entry)?; }
        new_key
    };
    tx.execute(
        "UPDATE authenticator_vault SET envelope_json=?1 WHERE id=1",
        [DEVICE_HEADER],
    )
    .map_err(|_| "无法迁移验证器")?;
    tx.commit().map_err(|_| "无法提交验证器迁移")?;
    Ok(key)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Code {
    pub id: String,
    pub current: String,
    pub next: Option<String>,
    pub remaining: u64,
    pub period: u64,
    pub counter: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewItem {
    pub entry: EntrySummary,
    pub duplicate_id: Option<String>,
    pub conflict: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub token: String,
    pub items: Vec<PreviewItem>,
    pub errors: Vec<String>,
    pub format: String,
}

impl VaultStore {
    pub fn lock(&self) {
        if let Ok(mut guard) = self.session.lock() {
            self.generation.fetch_add(1, Ordering::SeqCst);
            *guard = None;
        }
    }
    pub fn dialog(&self) -> Result<DialogGuard, String> {
        if self.dialog_active.swap(true, Ordering::SeqCst) {
            return Err("已有验证器文件窗口打开".into());
        }
        Ok(DialogGuard(self.dialog_active.clone()))
    }
}
impl Session {
    pub fn authorize(&mut self, owner: &str, header: &str, touch: bool) -> Result<(), String> {
        if self.owner != owner
            || self.header != header
            || self.action.elapsed() > Duration::from_secs(300)
            || self.poll.elapsed() > Duration::from_secs(30)
        {
            return Err("验证器已锁定，请重新解锁".into());
        }
        self.poll = Instant::now();
        if touch {
            self.action = Instant::now();
        }
        Ok(())
    }
}
#[cfg(test)]
pub fn wrap_key(password: &str) -> Result<(Zeroizing<[u8; 32]>, formats::Envelope), String> {
    if password.chars().count() < 8 {
        return Err("主密码至少 8 个字符".into());
    }
    let mut key = Zeroizing::new([0u8; 32]);
    rand::thread_rng().fill_bytes(&mut *key);
    let mut payload = Zeroizing::new(b"cloudhub-authenticator-vault:v1:".to_vec());
    payload.extend_from_slice(&*key);
    Ok((key, formats::seal(&payload, password)?))
}
pub fn unwrap_key(header: &str, password: &str) -> Result<Zeroizing<[u8; 32]>, String> {
    let envelope: formats::Envelope = serde_json::from_str(header).map_err(|_| "密码库格式无效")?;
    let data = formats::unseal(&envelope, password)?;
    let prefix = b"cloudhub-authenticator-vault:v1:";
    if !data.starts_with(prefix) || data.len() != prefix.len() + 32 {
        return Err("密码库内容无效".into());
    }
    Ok(Zeroizing::new(
        data[prefix.len()..]
            .try_into()
            .map_err(|_| "密码库密钥无效")?,
    ))
}
pub fn encrypt_entry(key: &[u8; 32], entry: &Entry) -> Result<String, String> {
    let data = Zeroizing::new(serde_json::to_vec(entry).map_err(|_| "验证码序列化失败")?);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "加密初始化失败")?;
    let mut nonce = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce);
    let encrypted = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &data,
                aad: entry.id.as_bytes(),
            },
        )
        .map_err(|_| "验证码加密失败")?;
    let mut packed = nonce.to_vec();
    packed.extend(encrypted);
    Ok(B64.encode(packed))
}
pub fn decrypt_entry(key: &[u8; 32], id: &str, ciphertext: &str) -> Result<Entry, String> {
    let packed = B64.decode(ciphertext).map_err(|_| "验证码存储格式无效")?;
    if packed.len() < 28 || packed.len() > 16384 {
        return Err("验证码存储长度无效".into());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "解密初始化失败")?;
    let data = Zeroizing::new(
        cipher
            .decrypt(
                Nonce::from_slice(&packed[..12]),
                Payload {
                    msg: &packed[12..],
                    aad: id.as_bytes(),
                },
            )
            .map_err(|_| "验证码解密失败")?,
    );
    let mut entry: Entry = serde_json::from_slice(&data).map_err(|_| "验证码内容无效")?;
    if entry.id != id {
        return Err("验证码标识不匹配".into());
    }
    entry.validate()?;
    Ok(entry)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authenticator_device_key_restart_and_legacy_migration() {
        use crate::core::repositories::authenticator as repository;
        let path = std::env::temp_dir().join(format!("auth-device-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        let key_path = path.join("device.key");
        let db_path = path.join("db.sqlite3");
        let mut db = rusqlite::Connection::open(&db_path).unwrap();
        db.execute_batch(repository::SCHEMA).unwrap();
        assert_eq!(
            initialize_device(&mut db, &key_path).unwrap(),
            DEVICE_HEADER
        );
        let key = read_device_key(&key_path).unwrap();
        let entry = super::super::formats::parse_uri(
            "otpauth://totp/Test:demo?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
        )
        .unwrap();
        repository::write(&db, &key, &entry).unwrap();
        drop(db);
        let mut db = rusqlite::Connection::open(&db_path).unwrap();
        assert_eq!(
            initialize_device(&mut db, &key_path).unwrap(),
            DEVICE_HEADER
        );
        assert_eq!(
            repository::load(&db, &read_device_key(&key_path).unwrap())
                .unwrap()
                .len(),
            1
        );
        assert!(persist_device_key(&key_path, &[0u8; 32]).is_err());
        std::fs::remove_file(&key_path).unwrap();
        assert_eq!(
            initialize_device(&mut db, &key_path).unwrap(),
            DEVICE_HEADER
        );
        assert!(read_device_key(&key_path).is_err());
        db.execute_batch("DELETE FROM authenticator_entries; DELETE FROM authenticator_vault;")
            .unwrap();
        let (key, envelope) = wrap_key("test-passphrase").unwrap();
        let header = repository::create(&db, &envelope).unwrap();
        repository::write(&db, &key, &entry).unwrap();
        assert!(migrate_device(&mut db, &key_path, &header, "incorrect").is_err());
        assert!(!key_path.exists());
        assert_eq!(repository::header(&db).unwrap().unwrap(), header);
        let migrated = migrate_device(&mut db, &key_path, &header, "test-passphrase").unwrap();
        assert_eq!(*migrated, *key);
        assert_eq!(*read_device_key(&key_path).unwrap(), *key);
        assert_eq!(repository::header(&db).unwrap().unwrap(), DEVICE_HEADER);
        assert_eq!(repository::load(&db, &migrated).unwrap().len(), 1);
        drop(db);
        std::fs::remove_file(key_path).unwrap();
        std::fs::remove_file(db_path).unwrap();
        std::fs::remove_dir(path).unwrap();
    }
    #[test]
    fn vault_password_and_session_expiry() {
        let (key, envelope) = wrap_key("test-passphrase").unwrap();
        let header = serde_json::to_string(&envelope).unwrap();
        assert_eq!(*unwrap_key(&header, "test-passphrase").unwrap(), *key);
        assert!(unwrap_key(&header, "incorrect").is_err());
        let mut s = Session {
            key,
            header: header.clone(),
            owner: "main".into(),
            action: Instant::now(),
            poll: Instant::now(),
            stage: None,
        };
        assert!(s.authorize("other", &header, false).is_err());
        assert!(s.authorize("main", "changed", false).is_err());
        assert!(s.authorize("main", &header, false).is_ok());
        s.action = Instant::now() - Duration::from_secs(301);
        assert!(s.authorize("main", &header, false).is_err());
        s.action = Instant::now();
        s.poll = Instant::now() - Duration::from_secs(31);
        assert!(s.authorize("main", &header, true).is_err());
    }
}
