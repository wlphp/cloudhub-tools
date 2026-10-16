//! Offline reader for a stopped environment's stored cookies.
//!
//! Chromium only hands out cookies through CDP while it is running. Inspecting a
//! closed environment therefore means reading `Default/Network/Cookies` directly
//! and decrypting each value the same way Chromium wrote it:
//!
//! * the AES-256 key lives in `Local State` under `os_crypt.encrypted_key`,
//!   base64-encoded with a `DPAPI` prefix and protected by the current Windows
//!   user account;
//! * each cookie value is `v10` || nonce(12) || ciphertext || tag(16) under
//!   AES-256-GCM.
//!
//! Decrypted values never reach logs, error messages or operation records. They
//! are returned only because the operator explicitly opened the data inspector.
use super::error;
use crate::core::error::PlatformResult;
use serde::Serialize;
use std::path::Path;

/// Chromium timestamps are microseconds since 1601-01-01 UTC.
const CHROMIUM_EPOCH_OFFSET_SECONDS: f64 = 11_644_473_600.0;
const MAX_COOKIE_ROWS: usize = 10_000;
const MAX_VALUE_BYTES: usize = 16 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieView {
    pub name: String,
    pub domain: String,
    pub path: String,
    pub value: String,
    pub expires: Option<f64>,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: Option<String>,
    pub session: bool,
    /// True when the stored value could not be decrypted and the field is empty
    /// because of that, rather than because the cookie really is empty.
    pub value_unavailable: bool,
}

impl CookieView {
    /// Live cookies arrive from CDP with the browser's own field names and are
    /// already decrypted, so only shape normalisation is needed.
    pub fn from_live(source: &serde_json::Value) -> Self {
        let text = |key: &str| source[key].as_str().unwrap_or_default().to_string();
        let flag = |key: &str| source[key].as_bool().unwrap_or(false);
        let expires = source.get("expires").and_then(serde_json::Value::as_f64).filter(|v| *v > 0.0);
        Self {
            name: text("name"), domain: text("domain"), path: text("path"), value: text("value"),
            session: expires.is_none(), expires,
            secure: flag("secure"), http_only: flag("httpOnly"),
            same_site: source["sameSite"].as_str().map(str::to_string),
            value_unavailable: false,
        }
    }
}

/// Reads every cookie stored for one environment profile.
pub fn read(id: &str) -> PlatformResult<Vec<CookieView>> {
    super::validate_id(id)?;
    let profile = super::root()?.join("environments").join(id);
    if !profile.is_dir() { return Err(error("环境资料目录不存在")); }
    let key = platform::master_key(&profile.join("Local State"))?;
    let database = profile.join("Default").join("Network").join("Cookies");
    if !database.is_file() { return Ok(Vec::new()); }
    read_database(&database, key.as_ref())
}

fn read_database(path: &Path, key: Option<&[u8; 32]>) -> PlatformResult<Vec<CookieView>> {
    // Read-only so an accidentally running browser can never have its profile
    // modified by an inspection; immutable avoids touching the WAL.
    let uri = format!("file:{}?mode=ro", percent_encoding::utf8_percent_encode(&path.to_string_lossy(), percent_encoding::NON_ALPHANUMERIC));
    let connection = rusqlite::Connection::open_with_flags(&uri, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI)
        .map_err(|_| error("无法读取浏览器 Cookie 数据库"))?;
    let mut statement = connection.prepare("SELECT host_key,name,path,expires_utc,is_secure,is_httponly,samesite,is_persistent,encrypted_value FROM cookies ORDER BY host_key,name LIMIT ?1")
        .map_err(|_| error("无法读取浏览器 Cookie 数据库"))?;
    let rows = statement.query_map([MAX_COOKIE_ROWS as i64], |row| Ok((
        row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
        row.get::<_, i64>(3)?, row.get::<_, i64>(4)?, row.get::<_, i64>(5)?,
        row.get::<_, i64>(6)?, row.get::<_, i64>(7)?, row.get::<_, Vec<u8>>(8)?,
    ))).map_err(|_| error("无法读取浏览器 Cookie 数据库"))?;
    let mut cookies = Vec::new();
    for row in rows {
        let (domain, name, cookie_path, expires_utc, secure, http_only, same_site, persistent, encrypted) = row.map_err(|_| error("浏览器 Cookie 数据无效"))?;
        if encrypted.len() > MAX_VALUE_BYTES { continue; }
        let (value, unavailable) = match key.and_then(|key| platform::decrypt_value(key, &encrypted)) {
            Some(value) => (value, false),
            // A present-but-undecryptable value is reported explicitly: an empty
            // string here would misrepresent a login cookie as an empty one.
            None => (String::new(), !encrypted.is_empty()),
        };
        let expires = if persistent == 1 && expires_utc > 0 { Some(expires_utc as f64 / 1_000_000.0 - CHROMIUM_EPOCH_OFFSET_SECONDS) } else { None };
        cookies.push(CookieView {
            name, domain, path: cookie_path, value, expires,
            secure: secure == 1, http_only: http_only == 1,
            same_site: match same_site { 0 => Some("None".into()), 1 => Some("Lax".into()), 2 => Some("Strict".into()), _ => None },
            session: expires.is_none(), value_unavailable: unavailable,
        });
    }
    Ok(cookies)
}

/// Windows DPAPI access. Kept behind cfg so macOS and Linux builds do not pull in
/// any Windows surface; those platforms simply cannot read Chromium's cookie store.
#[cfg(windows)]
mod platform {
    use super::error;
    use crate::core::error::PlatformResult;
    use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
    use base64::Engine;
    use std::{fs, path::Path, ptr};

    pub fn master_key(local_state: &Path) -> PlatformResult<Option<[u8; 32]>> {
        let Ok(bytes) = fs::read(local_state) else { return Ok(None); };
        if bytes.len() > 16 * 1024 * 1024 { return Err(error("浏览器加密配置超过读取限制")); }
        let state: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| error("浏览器加密配置无效"))?;
        let Some(encoded) = state["os_crypt"]["encrypted_key"].as_str() else { return Ok(None); };
        let decoded = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| error("浏览器加密密钥无效"))?;
        let Some(blob) = decoded.strip_prefix(b"DPAPI") else { return Err(error("浏览器加密密钥格式不受支持")); };
        let unlocked = unprotect(blob)?;
        let key: [u8; 32] = unlocked.try_into().map_err(|_| error("浏览器加密密钥长度无效"))?;
        Ok(Some(key))
    }

    pub(super) fn unprotect(blob: &[u8]) -> PlatformResult<Vec<u8>> {
        use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
        use windows_sys::Win32::Foundation::LocalFree;
        let mut input = CRYPT_INTEGER_BLOB { cbData: blob.len() as u32, pbData: blob.as_ptr() as *mut u8 };
        let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: ptr::null_mut() };
        // Runs in the interactive user's context, which is the same account that
        // wrote the key. No UI prompt and no password is requested.
        let ok = unsafe { CryptUnprotectData(&mut input, ptr::null_mut(), ptr::null_mut(), ptr::null_mut(), ptr::null_mut(), 0, &mut output) };
        if ok == 0 { return Err(error("无法解密浏览器密钥，请确认当前 Windows 用户与安装环境一致")); }
        let result = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
        unsafe { LocalFree(output.pbData as *mut core::ffi::c_void); }
        Ok(result)
    }

    pub fn decrypt_value(key: &[u8; 32], encrypted: &[u8]) -> Option<String> {
        if encrypted.is_empty() { return Some(String::new()); }
        // Only the v10 layout is produced by the reviewed Chrome for Testing builds.
        let Some(rest) = encrypted.strip_prefix(b"v10") else { return None; };
        if rest.len() < 12 + 16 { return None; }
        let (nonce, body) = rest.split_at(12);
        let cipher = Aes256Gcm::new_from_slice(key).ok()?;
        let plain = cipher.decrypt(Nonce::from_slice(nonce), body).ok()?;
        String::from_utf8(plain).ok()
    }
}

#[cfg(not(windows))]
mod platform {
    use super::error;
    use crate::core::error::PlatformResult;
    use std::path::Path;
    pub fn master_key(_local_state: &Path) -> PlatformResult<Option<[u8; 32]>> { Err(error("离线读取浏览器 Cookie 仅支持 Windows 桌面端")) }
    pub fn decrypt_value(_key: &[u8; 32], _encrypted: &[u8]) -> Option<String> { None }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use base64::Engine;

    /// DPAPI round-trip proof: protect a random key, then read it back through the
    /// same path the reader uses. This validates the CryptUnprotectData wiring
    /// without needing a real Chromium profile on the machine.
    #[test]
    fn dpapi_unprotects_a_key_this_user_protected() {
        use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
        let key: [u8; 32] = core::array::from_fn(|i| i as u8);
        let mut input = CRYPT_INTEGER_BLOB { cbData: key.len() as u32, pbData: key.as_ptr() as *mut u8 };
        let mut protected = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let ok = unsafe { CryptProtectData(&mut input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut protected) };
        assert_ne!(ok, 0, "CryptProtectData must succeed for the current user");
        let blob = unsafe { std::slice::from_raw_parts(protected.pbData, protected.cbData as usize).to_vec() };
        unsafe { windows_sys::Win32::Foundation::LocalFree(protected.pbData as *mut core::ffi::c_void); }
        let round_tripped = platform::unprotect(&blob).expect("protected blob must decrypt");
        assert_eq!(round_tripped, key.to_vec());
    }

    /// Encrypted values must round-trip through the v10 AES-GCM layout, and a
    /// truncated or foreign prefix must report failure rather than empty success.
    #[test]
    fn v10_values_round_trip_and_reject_foreign_payloads() {
        use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
        let key: [u8; 32] = core::array::from_fn(|i| (i * 7) as u8);
        let nonce = [9u8; 12];
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let sealed = cipher.encrypt(Nonce::from_slice(&nonce), b"cookie-value".as_slice()).unwrap();
        let mut stored = b"v10".to_vec();
        stored.extend_from_slice(&nonce);
        stored.extend_from_slice(&sealed);
        assert_eq!(platform::decrypt_value(&key, &stored).as_deref(), Some("cookie-value"));
        assert_eq!(platform::decrypt_value(&key, b"v11short"), None);
        assert_eq!(platform::decrypt_value(&key, b"v10only"), None);
    }

}
