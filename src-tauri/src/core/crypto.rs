use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rand::RngCore;
use std::fs;

use super::paths::data_dir;

fn crypto_key() -> Result<[u8; 32], String> {
    let path = data_dir()?.join(".key");
    if path.exists() {
        let bytes = fs::read(&path).map_err(|error| error.to_string())?;
        return bytes.try_into().map_err(|_| "本地密钥无效".to_string());
    }
    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    fs::write(path, key).map_err(|error| error.to_string())?;
    Ok(key)
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
