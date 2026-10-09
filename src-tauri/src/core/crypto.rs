use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::Sha256;
use std::{fs, ops::RangeInclusive};
use zeroize::{Zeroize, Zeroizing};
#[cfg(mobile)]
use std::sync::OnceLock;

use super::paths::data_dir;

const SYNC_ENVELOPE_VERSION: u16 = 1;
const SYNC_ENVELOPE_AAD: &[u8] = b"cloudhub-tools-sync-envelope:v1";
const SYNC_KDF_ITERATIONS: u32 = 210_000;
const SYNC_KDF_ACCEPTED_ITERATIONS: RangeInclusive<u32> = 100_000..=1_000_000;
const MAX_SYNC_PAYLOAD_BYTES: usize = 10 * 1024 * 1024;

/// Portable, authenticated ciphertext for a one-time sync or migration transfer.
/// It deliberately does not contain a device-local database key.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncEnvelope {
    pub version: u16,
    pub kdf: String,
    pub iterations: u32,
    pub salt: String,
    pub cipher: String,
    pub nonce: String,
    pub ciphertext: String,
}

fn derive_transfer_key(passphrase: &[u8], salt: &[u8], iterations: u32) -> Result<[u8; 32], String> {
    if iterations == 0 || iterations > *SYNC_KDF_ACCEPTED_ITERATIONS.end() {
        return Err("同步加密参数无效".into());
    }

    // PBKDF2-HMAC-SHA256, one 32-byte output block (RFC 8018, block index 1).
    let mut input = Vec::with_capacity(salt.len() + 4);
    input.extend_from_slice(salt);
    input.extend_from_slice(&1u32.to_be_bytes());
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(passphrase).map_err(|_| "同步加密初始化失败")?;
    mac.update(&input);
    let mut u = Zeroizing::new([0u8; 32]);
    let mut output = Zeroizing::new([0u8; 32]);
    let mut block = mac.finalize().into_bytes();
    u.copy_from_slice(&block);
    output.copy_from_slice(&block);
    block.as_mut_slice().zeroize();
    for _ in 1..iterations {
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(passphrase).map_err(|_| "同步加密初始化失败")?;
        mac.update(&u[..]);
        let mut next = mac.finalize().into_bytes();
        u.copy_from_slice(&next);
        for (target, value) in output.iter_mut().zip(next.iter()) { *target ^= value; }
        next.as_mut_slice().zeroize();
    }
    Ok(*output)
}

fn validate_transfer_passphrase(passphrase: &str) -> Result<(), String> {
    if passphrase.is_empty() || passphrase.len() > 1024 { return Err("请输入同步口令（最多 1024 个 UTF-8 字节）".into()); }
    Ok(())
}

/// Encrypts a typed payload for transfer. Plaintext is serialized and consumed
/// inside the native process; the caller receives only the envelope.
pub fn seal_sync_payload<T: Serialize>(payload: &T, passphrase: &str) -> Result<SyncEnvelope, String> {
    validate_transfer_passphrase(passphrase)?;
    let plaintext = Zeroizing::new(serde_json::to_vec(payload).map_err(|_| "同步数据序列化失败".to_string())?);
    if plaintext.is_empty() || plaintext.len() > MAX_SYNC_PAYLOAD_BYTES {
        return Err("同步数据超出允许大小".into());
    }
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce);
    let key = Zeroizing::new(derive_transfer_key(passphrase.as_bytes(), &salt, SYNC_KDF_ITERATIONS)?);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key[..]));
    let ciphertext = cipher.encrypt(Nonce::from_slice(&nonce), aes_gcm::aead::Payload { msg: &plaintext, aad: SYNC_ENVELOPE_AAD })
        .map_err(|_| "同步数据加密失败".to_string())?;
    Ok(SyncEnvelope {
        version: SYNC_ENVELOPE_VERSION,
        kdf: "PBKDF2-HMAC-SHA256".into(),
        iterations: SYNC_KDF_ITERATIONS,
        salt: B64.encode(salt),
        cipher: "AES-256-GCM".into(),
        nonce: B64.encode(nonce),
        ciphertext: B64.encode(ciphertext),
    })
}

/// Opens an authenticated transfer envelope inside the native process.
pub fn open_sync_payload<T: DeserializeOwned>(envelope: &SyncEnvelope, passphrase: &str) -> Result<T, String> {
    validate_transfer_passphrase(passphrase)?;
    if envelope.version != SYNC_ENVELOPE_VERSION || envelope.kdf != "PBKDF2-HMAC-SHA256" || envelope.cipher != "AES-256-GCM" {
        return Err("同步包版本或加密算法不受支持".into());
    }
    if !SYNC_KDF_ACCEPTED_ITERATIONS.contains(&envelope.iterations) { return Err("同步加密参数无效".into()); }
    let salt = B64.decode(&envelope.salt).map_err(|_| "同步包格式无效".to_string())?;
    let nonce = B64.decode(&envelope.nonce).map_err(|_| "同步包格式无效".to_string())?;
    let ciphertext = B64.decode(&envelope.ciphertext).map_err(|_| "同步包格式无效".to_string())?;
    if salt.len() != 16 || nonce.len() != 12 || ciphertext.len() < 16 || ciphertext.len() > MAX_SYNC_PAYLOAD_BYTES + 16 {
        return Err("同步包格式或大小无效".into());
    }
    let key = Zeroizing::new(derive_transfer_key(passphrase.as_bytes(), &salt, envelope.iterations)?);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key[..]));
    let plaintext = Zeroizing::new(cipher.decrypt(Nonce::from_slice(&nonce), aes_gcm::aead::Payload { msg: &ciphertext, aad: SYNC_ENVELOPE_AAD })
        .map_err(|_| "同步包无法解密，请检查口令或文件完整性".to_string())?);
    serde_json::from_slice(&plaintext).map_err(|_| "同步包内容格式无效".to_string())
}

#[cfg(not(mobile))]
fn crypto_key() -> Result<[u8; 32], String> {
    let path = data_dir()?.join(".key");
    if path.exists() {
        let bytes = fs::read(&path).map_err(|error| error.to_string())?;
        restrict_key_permissions(&path)?;
        return bytes.try_into().map_err(|_| "本地密钥无效".to_string());
    }
    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    fs::write(&path, key).map_err(|error| error.to_string())?;
    restrict_key_permissions(&path)?;
    Ok(key)
}

#[cfg(mobile)]
static MOBILE_CRYPTO_KEY: OnceLock<[u8; 32]> = OnceLock::new();

/// Migrates the legacy mobile `.key` file into the device keystore before any
/// commands can access encrypted SQLite values.
#[cfg(mobile)]
pub fn initialize_mobile_key_store<R: tauri::Runtime, M: tauri::Manager<R>>(manager: &M) -> Result<(), String> {
    let base = manager.path().app_local_data_dir()
        .map_err(|_| "无法获取本机应用数据目录".to_string())?;
    super::paths::initialize_app_local_data_base(base.clone())?;
    let current_data = base.join("CloudHubTools");
    let legacy_data = base.join("AliyunTools");
    fs::create_dir_all(&current_data).map_err(|_| "无法准备本机数据目录；本地数据保持不变".to_string())?;
    tauri_plugin_cloudhub_keystore::exclude_data_from_backup(manager, &current_data.to_string_lossy())
        .map_err(|_| "无法确认本机数据库不会被系统备份迁移；本地数据保持不变".to_string())?;
    if legacy_data.is_dir() {
        tauri_plugin_cloudhub_keystore::exclude_data_from_backup(manager, &legacy_data.to_string_lossy())
            .map_err(|_| "无法保护旧数据目录中的待迁移文件；本地数据保持不变".to_string())?;
    }
    // data_dir copies legacy files, so mark both paths excluded before calling it.
    let data = data_dir()?;
    let legacy_path = data.join(".key");
    let database_path = data.join("cloudhub_tools.sqlite3");
    let secure_key = tauri_plugin_cloudhub_keystore::load_key(manager)
        .map_err(|_| "无法访问手机系统安全存储；本地数据保持不变".to_string())?
        .map(Zeroizing::new);
    let legacy_key = if legacy_path.exists() { Some(read_local_key(&legacy_path)?) } else { None };
    let selected = select_mobile_key(secure_key.clone(), legacy_key.clone(), database_path.exists())?;
    let key = match selected {
        Some(key) if secure_key.is_none() => {
            tauri_plugin_cloudhub_keystore::store_key(manager, &key)
                .map_err(|_| "无法将本地密钥保存到手机系统安全存储；旧密钥文件保持不变".to_string())?;
            let verified = tauri_plugin_cloudhub_keystore::load_key(manager)
                .map_err(|_| "无法验证手机系统安全存储中的密钥；旧密钥文件保持不变".to_string())?
                .map(Zeroizing::new)
                .ok_or_else(|| "手机系统安全存储未保存密钥；旧密钥文件保持不变".to_string())?;
            if verified != key { return Err("手机系统安全存储密钥校验失败；旧密钥文件保持不变".into()); }
            if legacy_key.is_some() { fs::remove_file(&legacy_path).map_err(|_| "密钥已迁移，但无法清理旧密钥文件".to_string())?; }
            key
        }
        Some(key) => {
            if legacy_key.is_some() { fs::remove_file(&legacy_path).map_err(|_| "安全密钥已验证，但无法清理旧密钥文件".to_string())?; }
            key
        }
        None => {
            let mut generated = Zeroizing::new(vec![0u8; 32]);
            rand::thread_rng().fill_bytes(&mut generated);
            tauri_plugin_cloudhub_keystore::store_key(manager, &generated)
                .map_err(|_| "无法在手机系统安全存储中创建本地密钥".to_string())?;
            let verified = tauri_plugin_cloudhub_keystore::load_key(manager)
                .map_err(|_| "无法验证手机系统安全存储中的新密钥".to_string())?
                .map(Zeroizing::new)
                .ok_or_else(|| "手机系统安全存储未返回新密钥".to_string())?;
            if verified.as_slice() != generated.as_slice() { return Err("手机系统安全存储密钥校验失败".into()); }
            generated
        }
    };
    let key = Zeroizing::new(key.as_slice().try_into().map_err(|_| "本机安全密钥长度无效".to_string())?);
    if let Err(mut rejected_key) = MOBILE_CRYPTO_KEY.set(*key) {
        rejected_key.zeroize();
        return Err("本机安全密钥已初始化".into());
    }
    cleanup_legacy_mobile_files(&data)?;
    Ok(())
}

#[cfg(any(mobile, test))]
fn cleanup_legacy_mobile_files(data: &std::path::Path) -> Result<(), String> {
    let legacy = data.parent().ok_or_else(|| "无法确定旧本地数据目录".to_string())?.join("AliyunTools");
    for (old_name, migrated_name) in [(".key", ".key"), ("aliyun_tools.sqlite3", "cloudhub_tools.sqlite3")] {
        let old_file = legacy.join(old_name);
        let migrated_file = data.join(migrated_name);
        if old_file.exists() && migrated_file.is_file() {
            fs::remove_file(old_file).map_err(|_| "本地密钥已就绪，但无法清理旧数据目录中的已迁移文件；请确保有足够的存储权限后重启应用".to_string())?;
        }
    }
    Ok(())
}

#[cfg(any(mobile, test))]
fn select_mobile_key(secure: Option<Zeroizing<Vec<u8>>>, legacy: Option<Zeroizing<Vec<u8>>>, database_exists: bool) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
    if secure.as_ref().is_some_and(|key| key.len() != 32) || legacy.as_ref().is_some_and(|key| key.len() != 32) {
        return Err("本机安全密钥长度无效；本地数据保持不变".into());
    }
    match (secure, legacy) {
        (Some(secure), Some(legacy)) if secure != legacy => Err("系统安全密钥与旧本地密钥不一致；为保护数据库，应用已停止启动".into()),
        (Some(secure), _) => Ok(Some(secure)),
        (None, Some(legacy)) => Ok(Some(legacy)),
        (None, None) if database_exists => Err("找不到本机数据库密钥；为避免覆盖或损坏现有数据，应用已停止启动".into()),
        (None, None) => Ok(None),
    }
}

#[cfg(mobile)]
fn read_local_key(path: &std::path::Path) -> Result<Zeroizing<Vec<u8>>, String> {
    let value = Zeroizing::new(fs::read(path).map_err(|_| "无法读取现有本地密钥；本地数据保持不变".to_string())?);
    if value.len() != 32 { return Err("现有本地密钥格式无效；本地数据保持不变".into()); }
    restrict_key_permissions(path)?;
    Ok(value)
}

#[cfg(mobile)]
fn crypto_key() -> Result<[u8; 32], String> {
    MOBILE_CRYPTO_KEY.get().copied().ok_or_else(|| "手机本地安全密钥尚未初始化".into())
}

#[cfg(unix)]
fn restrict_key_permissions(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path).map_err(|error| error.to_string())?.permissions();
    permissions.set_mode(0o600);
    fs::set_permissions(path, permissions).map_err(|error| format!("设置本地密钥权限失败: {error}"))
}

#[cfg(not(unix))]
fn restrict_key_permissions(_path: &std::path::Path) -> Result<(), String> { Ok(()) }

pub fn crypto_key_bytes() -> Result<Vec<u8>, String> {
    Ok(crypto_key()?.to_vec())
}

pub fn encrypt_secret(secret: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&crypto_key()?));
    let mut nonce = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce);
    let encrypted = cipher.encrypt(Nonce::from_slice(&nonce), secret.as_bytes()).map_err(|_| "加密 Secret 失败".to_string())?;
    let mut packed = nonce.to_vec();
    packed.extend(encrypted);
    Ok(B64.encode(packed))
}

pub fn decrypt_secret(ciphertext: &str) -> Result<String, String> {
    let packed = B64.decode(ciphertext).map_err(|error| format!("读取 Secret 失败: {error}"))?;
    if packed.len() < 12 { return Err("本地 Secret 数据损坏".into()); }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&crypto_key()?));
    let value = cipher.decrypt(Nonce::from_slice(&packed[..12]), &packed[12..]).map_err(|_| "解密 Secret 失败".to_string())?;
    String::from_utf8(value).map_err(|_| "Secret 编码无效".into())
}

#[cfg(test)]
mod sync_envelope_tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[test]
    fn mobile_key_selection_preserves_existing_data_and_rejects_missing_or_conflicting_keys() {
        let old = vec![7u8; 32];
        let secret = |bytes: Vec<u8>| Zeroizing::new(bytes);
        assert_eq!(select_mobile_key(Some(secret(old.clone())), None, true).unwrap().as_ref().map(|key| key.as_slice()), Some(old.as_slice()));
        assert_eq!(select_mobile_key(None, Some(secret(old.clone())), true).unwrap().as_ref().map(|key| key.as_slice()), Some(old.as_slice()));
        assert_eq!(select_mobile_key(Some(secret(old.clone())), Some(secret(old.clone())), true).unwrap().as_ref().map(|key| key.as_slice()), Some(old.as_slice()));
        assert!(select_mobile_key(Some(secret(vec![1; 32])), Some(secret(vec![2; 32])), true).is_err());
        assert!(select_mobile_key(None, None, true).is_err());
        assert_eq!(select_mobile_key(None, None, false).unwrap(), None);
        assert!(select_mobile_key(Some(secret(vec![0; 16])), None, false).is_err());
    }

    #[test]
    fn legacy_mobile_files_are_removed_only_after_their_migrated_copies_exist() {
        let root = std::env::temp_dir().join(format!("cloudhub-mobile-key-migration-{}", uuid::Uuid::new_v4()));
        let data = root.join("CloudHubTools");
        let legacy = root.join("AliyunTools");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&legacy).unwrap();
        fs::write(data.join(".key"), [7u8; 32]).unwrap();
        fs::write(data.join("cloudhub_tools.sqlite3"), b"migrated database").unwrap();
        fs::write(legacy.join(".key"), [7u8; 32]).unwrap();
        fs::write(legacy.join("aliyun_tools.sqlite3"), b"legacy database").unwrap();
        fs::write(legacy.join("unrelated.txt"), b"keep").unwrap();

        cleanup_legacy_mobile_files(&data).unwrap();

        assert!(!legacy.join(".key").exists());
        assert!(!legacy.join("aliyun_tools.sqlite3").exists());
        assert!(legacy.join("unrelated.txt").is_file());
        fs::remove_file(data.join(".key")).unwrap();
        fs::remove_file(data.join("cloudhub_tools.sqlite3")).unwrap();
        fs::remove_file(legacy.join("unrelated.txt")).unwrap();
        fs::remove_dir(&data).unwrap();
        fs::remove_dir(&legacy).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
    struct SecretPayload { account: String, secret: String }

    #[test]
    fn sync_envelope_round_trips_without_embedding_a_local_key() {
        let payload = SecretPayload { account: "prod".into(), secret: "never-return-this-in-cleartext".into() };
        let envelope = seal_sync_payload(&payload, "correct horse battery staple") .unwrap();
        let encoded = serde_json::to_string(&envelope).unwrap();
        assert!(!encoded.contains(&payload.secret));
        assert!(!encoded.contains(".key"));
        assert_eq!(open_sync_payload::<SecretPayload>(&envelope, "correct horse battery staple").unwrap(), payload);
    }

    #[test]
    fn sync_envelope_rejects_wrong_passphrase_and_tampering() {
        let envelope = seal_sync_payload(&SecretPayload { account: "a".into(), secret: "sensitive".into() }, "a sufficiently long passphrase").unwrap();
        assert!(open_sync_payload::<SecretPayload>(&envelope, "a different sufficiently long passphrase").is_err());
        let mut tampered = envelope;
        tampered.ciphertext.push('A');
        assert!(open_sync_payload::<SecretPayload>(&tampered, "a sufficiently long passphrase").is_err());
    }

    #[test]
    fn sync_envelope_rejects_empty_passphrases_and_unsafe_parameters() {
        assert!(seal_sync_payload(&SecretPayload { account: "a".into(), secret: "s".into() }, "").is_err());
        let mut envelope = seal_sync_payload(&SecretPayload { account: "a".into(), secret: "s".into() }, "a sufficiently long passphrase").unwrap();
        envelope.iterations = u32::MAX;
        assert!(open_sync_payload::<SecretPayload>(&envelope, "a sufficiently long passphrase").is_err());
        envelope.iterations = SYNC_KDF_ITERATIONS;
        envelope.version = 99;
        assert!(open_sync_payload::<SecretPayload>(&envelope, "a sufficiently long passphrase").is_err());
    }

    #[test]
    fn transfer_key_derivation_matches_the_pbkdf2_sha256_known_vector() {
        let key = derive_transfer_key(b"password", b"salt", 1).unwrap();
        assert_eq!(hex::encode(key), "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b");
    }
}
