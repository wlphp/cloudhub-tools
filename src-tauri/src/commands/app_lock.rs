//! 移动端应用锁：数字密码、滑动图案与生物识别门禁。
//!
//! 验证器只保存 Argon2id 哈希（CHAPLV1 格式），外层再套设备密钥 AES-GCM 加密，
//! 防止小空间 PIN 遭到离线爆破；明文从不落库、不进入日志或错误消息。
//! 模块本身跨平台编译以便主机侧 `cargo check` 全覆盖；命令仅注册到移动端。

use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::core::crypto::{decrypt_secret, encrypt_secret};
use crate::core::error::PlatformResult;
use crate::core::repositories::preferences as preferences_repository;
use crate::core::storage::open_db;

const CONFIG_KEY: &str = "app.lock.config";
const PIN_VERIFIER_KEY: &str = "app.lock.verifier.pin";
const PATTERN_VERIFIER_KEY: &str = "app.lock.verifier.pattern";
const FAILURES_KEY: &str = "app.lock.failures";

/// 与备份口令加密一致的固定 KDF 参数，防止不可信记录要求过量资源。
const ARGON2_M_KIB: u32 = 65536;
const ARGON2_T: u32 = 3;
const ARGON2_P: u32 = 1;
const SALT_LEN: usize = 16;
const VERIFIER_LEN: usize = 32;
const MAGIC: &[u8; 8] = b"CHAPLKV1";

/// Argon2id 每次派生约几十毫秒，连续 5 次失败后按指数退避冷却。
const FAILURE_FREE_LIMIT: u32 = 5;
const FAILURE_BASE_COOLDOWN_MS: u64 = 30_000;
const FAILURE_MAX_COOLDOWN_MS: u64 = 300_000;

const METHOD_PIN: &str = "pin";
const METHOD_PATTERN: &str = "pattern";
/// 自动上锁允许的延时档位（秒）；0 表示切后台立即锁定。
const ALLOWED_AUTO_LOCK_SECONDS: [u32; 4] = [0, 30, 60, 300];

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AppLockConfig {
    enabled: bool,
    has_pin: bool,
    has_pattern: bool,
    biometric_enabled: bool,
    auto_lock_seconds: u32,
}

impl Default for AppLockConfig {
    fn default() -> Self {
        Self { enabled: false, has_pin: false, has_pattern: false, biometric_enabled: false, auto_lock_seconds: 0 }
    }
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct FailureRecord {
    count: u32,
    locked_until_ms: u64,
}

impl Default for FailureRecord {
    fn default() -> Self {
        Self { count: 0, locked_until_ms: 0 }
    }
}

fn failure_cooldown_ms(count: u32) -> u64 {
    // 前 5 次不计冷却；第 6 次起 30 秒指数递增，封顶 5 分钟。
    if count <= FAILURE_FREE_LIMIT { return 0; }
    let steps = count - FAILURE_FREE_LIMIT - 1;
    FAILURE_BASE_COOLDOWN_MS
        .saturating_mul(1u64 << steps.min(31))
        .min(FAILURE_MAX_COOLDOWN_MS)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_millis() as u64).unwrap_or(0)
}

fn validate_pin(pin: &str) -> Result<(), &'static str> {
    let digits = pin.chars().count();
    if !(4..=8).contains(&digits) || !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err("数字密码需为 4-8 位数字");
    }
    Ok(())
}

fn validate_pattern(pattern: &str) -> Result<(), &'static str> {
    let dots: Vec<char> = pattern.chars().collect();
    if !(4..=9).contains(&dots.len()) {
        return Err("滑动图案至少连接 4 个点");
    }
    let mut seen = [false; 9];
    for dot in dots {
        let index = dot.to_digit(10).ok_or("图案点无效")? as usize;
        if index >= 9 || seen[index] {
            return Err("图案点无效");
        }
        seen[index] = true;
    }
    Ok(())
}

/// 生成 CHAPLKV1 验证器：magic + salt + Argon2id(secret, salt)。
fn build_verifier_blob(secret: &str) -> Result<Vec<u8>, String> {
    use argon2::{Algorithm, Argon2, Params, Version};
    use rand::RngCore;

    let mut salt = [0u8; SALT_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    let params = Params::new(ARGON2_M_KIB, ARGON2_T, ARGON2_P, Some(VERIFIER_LEN))
        .map_err(|_| "应用锁初始化失败")?;
    let kdf = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut verifier = [0u8; VERIFIER_LEN];
    kdf.hash_password_into(secret.as_bytes(), &salt, &mut verifier)
        .map_err(|_| "应用锁验证器生成失败")?;
    let mut blob = Vec::with_capacity(MAGIC.len() + SALT_LEN + VERIFIER_LEN);
    blob.extend_from_slice(MAGIC);
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&verifier);
    Ok(blob)
}

/// 常数时间比对，避免逐位短路泄露匹配长度。
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() { return false; }
    let mut diff = 0u8;
    for (left, right) in a.iter().zip(b.iter()) { diff |= left ^ right; }
    diff == 0
}

/// 校验输入是否匹配验证器；格式损坏视为不匹配。
fn verify_verifier_blob(blob: &[u8], secret: &str) -> bool {
    use argon2::{Algorithm, Argon2, Params, Version};

    if blob.len() != MAGIC.len() + SALT_LEN + VERIFIER_LEN || !blob.starts_with(MAGIC) {
        return false;
    }
    let mut computed = [0u8; VERIFIER_LEN];
    let params = match Params::new(ARGON2_M_KIB, ARGON2_T, ARGON2_P, Some(VERIFIER_LEN)) {
        Ok(params) => params,
        Err(_) => return false,
    };
    let kdf = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    if kdf.hash_password_into(secret.as_bytes(), &blob[MAGIC.len()..MAGIC.len() + SALT_LEN], &mut computed).is_err() {
        return false;
    }
    constant_time_eq(&computed, &blob[MAGIC.len() + SALT_LEN..])
}

fn encode_verifier(secret: &str) -> Result<String, String> {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;
    encrypt_secret(&B64.encode(build_verifier_blob(secret)?))
}

fn decode_verifier(stored: &str) -> Option<Vec<u8>> {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;
    let plaintext = decrypt_secret(stored).ok()?;
    B64.decode(plaintext.as_bytes()).ok()
}

fn read_preference(key: &str) -> Option<String> {
    let conn = open_db().ok()?;
    preferences_repository::list(&conn).ok()?.remove(key)
}

fn write_preference(key: &str, value: &str) -> Result<(), String> {
    let conn = open_db()?;
    preferences_repository::save(&conn, key, value, now_ms() as i64)
}

fn load_config() -> AppLockConfig {
    read_preference(CONFIG_KEY)
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default()
}

fn save_config(config: &AppLockConfig) -> Result<(), String> {
    write_preference(CONFIG_KEY, &serde_json::to_string(config).map_err(|error| error.to_string())?)
}

#[cfg(mobile)]
fn probe_biometric(app: &tauri::AppHandle) -> bool {
    tauri_plugin_cloudhub_keystore::biometric_availability(app)
        .map(|availability| availability.any)
        .unwrap_or(false)
}

#[cfg(not(mobile))]
fn probe_biometric(_app: &tauri::AppHandle) -> bool { false }

/// 内存锁定状态：进程重启后回到未解锁（启动即锁），由命令按配置惰性刷新。
#[derive(Default)]
pub struct AppLockStore {
    state: Mutex<LockState>,
}

#[derive(Default)]
struct LockState {
    unlocked: bool,
    background_since: Option<Instant>,
}

impl AppLockStore {
    /// 返回当前是否处于锁定态，并按切后台时长把过期会话重新上锁。
    fn refresh_locked(&self, config: &AppLockConfig) -> bool {
        let mut state = match self.state.lock() { Ok(state) => state, Err(_) => return config.enabled };
        if let Some(background_since) = state.background_since {
            if state.unlocked && background_since.elapsed().as_secs() >= u64::from(config.auto_lock_seconds) {
                state.unlocked = false;
            }
        }
        config.enabled && !state.unlocked
    }

    fn unlock(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.unlocked = true;
            state.background_since = None;
        }
    }

    fn lock(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.unlocked = false;
            state.background_since = None;
        }
    }

    fn note_background(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.background_since = Some(Instant::now());
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppLockStatus {
    enabled: bool,
    has_pin: bool,
    has_pattern: bool,
    biometric_enabled: bool,
    biometric_available: bool,
    locked: bool,
    cooldown_ms: u64,
    auto_lock_seconds: u32,
}

#[tauri::command]
pub(crate) fn app_lock_status(app: tauri::AppHandle) -> PlatformResult<AppLockStatus> {
    let config = load_config();
    let store: tauri::State<'_, AppLockStore> = app.state();
    let cooldown_ms = remaining_cooldown_ms();
    let biometric_available = probe_biometric(&app);
    Ok(AppLockStatus {
        enabled: config.enabled,
        has_pin: config.has_pin,
        has_pattern: config.has_pattern,
        biometric_enabled: config.biometric_enabled,
        biometric_available,
        locked: store.refresh_locked(&config),
        cooldown_ms,
        auto_lock_seconds: config.auto_lock_seconds,
    })
}

fn remaining_cooldown_ms() -> u64 {
    let record: FailureRecord = read_preference(FAILURES_KEY)
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default();
    record.locked_until_ms.saturating_sub(now_ms())
}

/// 记录失败次数并返回新的冷却剩余毫秒；成功时应调用 `clear_failures`。
fn record_failure() -> u64 {
    let mut record: FailureRecord = read_preference(FAILURES_KEY)
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default();
    record.count = record.count.saturating_add(1);
    if record.count > FAILURE_FREE_LIMIT {
        record.locked_until_ms = now_ms() + failure_cooldown_ms(record.count);
    }
    if let Ok(payload) = serde_json::to_string(&record) {
        let _ = write_preference(FAILURES_KEY, &payload);
    }
    remaining_cooldown_ms()
}

fn clear_failures() {
    if let Ok(payload) = serde_json::to_string(&FailureRecord::default()) {
        let _ = write_preference(FAILURES_KEY, &payload);
    }
}

fn verifier_key(method: &str) -> Result<&'static str, String> {
    match method {
        METHOD_PIN => Ok(PIN_VERIFIER_KEY),
        METHOD_PATTERN => Ok(PATTERN_VERIFIER_KEY),
        _ => Err("应用锁方式无效".into()),
    }
}

fn validate_secret(method: &str, secret: &str) -> Result<(), String> {
    match method {
        METHOD_PIN => validate_pin(secret),
        METHOD_PATTERN => validate_pattern(secret),
        _ => Err("应用锁方式无效"),
    }.map_err(|message| message.into())
}

#[tauri::command]
pub(crate) fn app_lock_verify(app: tauri::AppHandle, method: String, secret: String) -> PlatformResult<bool> {
    let store: tauri::State<'_, AppLockStore> = app.state();
    validate_secret(&method, &secret)?;
    if remaining_cooldown_ms() > 0 {
        return Err("尝试次数过多，请稍后再试".into());
    }
    let key = verifier_key(&method)?;
    let Some(stored) = read_preference(key).filter(|value| !value.is_empty()) else {
        return Err("该解锁方式尚未设置".into())
    };
    let Some(blob) = decode_verifier(&stored) else { return Err("应用锁验证器损坏，请重新设置".into()) };
    if !verify_verifier_blob(&blob, &secret) {
        let cooldown_ms = record_failure();
        if cooldown_ms > 0 {
            return Err("尝试次数过多，请稍后再试".into());
        }
        let wrong_message = if method == METHOD_PATTERN { "滑动图案不正确" } else { "数字密码不正确" };
        return Err(wrong_message.into());
    }
    clear_failures();
    store.unlock();
    Ok(true)
}

#[cfg(mobile)]
#[tauri::command]
pub(crate) async fn app_lock_biometric_verify(
    app: tauri::AppHandle,
    allow_device_credentials: bool,
) -> PlatformResult<bool> {
    let config = load_config();
    let store: tauri::State<'_, AppLockStore> = app.state();
    if !config.biometric_enabled {
        return Err("生物识别未启用".into());
    }
    let available = tauri_plugin_cloudhub_keystore::biometric_availability(&app)
        .map_err(|error| error.to_string())?;
    if !available.any {
        return Err("此设备暂不可用生物识别".into());
    }
    let result = tauri_plugin_cloudhub_keystore::authenticate_biometric(
        &app,
        "解锁云枢工具箱",
        "验证身份以继续",
        allow_device_credentials,
    ).map_err(|error| error.to_string())?;
    if !result.authenticated {
        if result.cancelled {
            return Ok(false);
        }
        return Err("身份验证未通过".into());
    }
    clear_failures();
    store.unlock();
    Ok(true)
}

#[tauri::command]
pub(crate) fn app_lock_set_secret(
    app: tauri::AppHandle,
    method: String,
    current_secret: Option<String>,
    new_secret: String,
) -> PlatformResult<bool> {
    let config = load_config();
    let store: tauri::State<'_, AppLockStore> = app.state();
    if store.refresh_locked(&config) {
        return Err("请先解锁后再修改应用锁".into());
    }
    validate_secret(&method, &new_secret)?;
    let key = verifier_key(&method)?;
    if let Some(stored) = read_preference(key).filter(|value| !value.is_empty()) {
        let Some(current) = current_secret.as_deref() else { return Err("请先输入当前密码".into()) };
        validate_secret(&method, current)?;
        match decode_verifier(&stored).filter(|blob| verify_verifier_blob(blob, current)) {
            Some(_) => {}
            None => return Err("当前密码不正确".into()),
        }
    }
    let encoded = encode_verifier(&new_secret)?;
    write_preference(key, &encoded)?;
    let mut config = config;
    match method.as_str() {
        METHOD_PIN => config.has_pin = true,
        METHOD_PATTERN => config.has_pattern = true,
        _ => return Err("应用锁方式无效".into()),
    }
    save_config(&config)?;
    Ok(true)
}

#[tauri::command]
pub(crate) fn app_lock_remove_secret(app: tauri::AppHandle, method: String) -> PlatformResult<bool> {
    let mut config = load_config();
    let store: tauri::State<'_, AppLockStore> = app.state();
    if store.refresh_locked(&config) {
        return Err("请先解锁后再修改应用锁".into());
    }
    let key = verifier_key(&method)?;
    let exists = match method.as_str() {
        METHOD_PIN => config.has_pin,
        METHOD_PATTERN => config.has_pattern,
        _ => return Err("应用锁方式无效".into()),
    };
    if !exists {
        return Err("该解锁方式尚未设置".into());
    }
    if config.enabled && config.has_pin && config.has_pattern {
        // 已启用且还有一种本地凭证可保留，允许移除。
    } else if config.enabled {
        return Err("已启用的应用锁至少需要保留一种本地密码".into());
    }
    write_preference(key, "")?;
    match method.as_str() {
        METHOD_PIN => config.has_pin = false,
        _ => config.has_pattern = false,
    }
    if !config.has_pin && !config.has_pattern {
        // 本地密码全部移除时自动停用，避免留下无凭据的锁。
        config.enabled = false;
        config.biometric_enabled = false;
    }
    save_config(&config)?;
    Ok(true)
}

#[tauri::command]
pub(crate) fn app_lock_set_config(
    app: tauri::AppHandle,
    enabled: Option<bool>,
    biometric_enabled: Option<bool>,
    auto_lock_seconds: Option<u32>,
) -> PlatformResult<bool> {
    let mut config = load_config();
    let store: tauri::State<'_, AppLockStore> = app.state();
    if store.refresh_locked(&config) {
        return Err("请先解锁后再修改应用锁".into());
    }
    if let Some(enabled) = enabled {
        if enabled && !config.has_pin && !config.has_pattern {
            return Err("请先设置数字密码或滑动图案".into());
        }
        config.enabled = enabled;
        if !enabled {
            store.lock();
        }
    }
    if let Some(biometric_enabled) = biometric_enabled {
        if biometric_enabled && !probe_biometric(&app) {
            return Err("此设备暂不可用生物识别".into());
        }
        config.biometric_enabled = biometric_enabled;
    }
    if let Some(seconds) = auto_lock_seconds {
        if !ALLOWED_AUTO_LOCK_SECONDS.contains(&seconds) {
            return Err("自动上锁时长无效".into());
        }
        config.auto_lock_seconds = seconds;
    }
    save_config(&config)?;
    Ok(true)
}

#[tauri::command]
pub(crate) fn app_lock_note_background(app: tauri::AppHandle) -> PlatformResult<()> {
    let config = load_config();
    let store: tauri::State<'_, AppLockStore> = app.state();
    store.note_background();
    // 立即上锁档位在切后台瞬间生效，锁屏 UI 同步覆盖。
    if config.enabled && config.auto_lock_seconds == 0 {
        store.lock();
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn app_lock_lock_now(app: tauri::AppHandle) -> PlatformResult<()> {
    let store: tauri::State<'_, AppLockStore> = app.state();
    store.lock();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pin_validation_accepts_digits_only() {
        assert!(validate_pin("1234").is_ok());
        assert!(validate_pin("0123456789".split_at(8).0).is_ok());
        assert!(validate_pin("1234567890").is_err());
        assert!(validate_pin("123").is_err());
        assert!(validate_pin("12a4").is_err());
        assert!(validate_pin("12 4").is_err());
        assert!(validate_pin("").is_err());
    }

    #[test]
    fn pattern_validation_requires_distinct_dots() {
        assert!(validate_pattern("0123").is_ok());
        assert!(validate_pattern("012345678").is_ok());
        assert!(validate_pattern("012").is_err());
        assert!(validate_pattern("0012").is_err());
        assert!(validate_pattern("abcd").is_err());
        assert!(validate_pattern("0123456789").is_err());
    }

    #[test]
    fn verifier_roundtrip_and_rejection() {
        let blob = build_verifier_blob("123456").unwrap();
        assert!(blob.starts_with(MAGIC));
        assert!(verify_verifier_blob(&blob, "123456"));
        assert!(!verify_verifier_blob(&blob, "654321"));
        assert!(!verify_verifier_blob(&blob, "12345"));
        let mut corrupted = blob.clone();
        corrupted[MAGIC.len()] ^= 0x40;
        assert!(!verify_verifier_blob(&corrupted, "123456"));
    }

    #[test]
    fn constant_time_eq_matches_lengths() {
        assert!(constant_time_eq(b"abcd", b"abcd"));
        assert!(!constant_time_eq(b"abcd", b"abce"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
    }

    #[test]
    fn failure_cooldown_grows_and_is_capped() {
        assert_eq!(failure_cooldown_ms(FAILURE_FREE_LIMIT), 0);
        assert_eq!(failure_cooldown_ms(FAILURE_FREE_LIMIT + 1), FAILURE_BASE_COOLDOWN_MS);
        assert_eq!(failure_cooldown_ms(FAILURE_FREE_LIMIT + 2), FAILURE_BASE_COOLDOWN_MS * 2);
        assert_eq!(failure_cooldown_ms(FAILURE_FREE_LIMIT + 20), FAILURE_MAX_COOLDOWN_MS);
    }
}
