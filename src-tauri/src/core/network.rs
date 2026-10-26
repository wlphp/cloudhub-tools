use std::{collections::HashMap, ffi::OsString, sync::{OnceLock, RwLock}};

use serde::{Deserialize, Serialize};

const PREF_KEY: &str = "network.global_proxy";

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    pub enabled: bool,
    pub url: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyPoolConfig {
    pub enabled: bool,
    #[serde(default)]
    pub proxies: Vec<ProxyEntry>,
    #[serde(default)]
    pub selected_id: Option<String>,
    // Legacy single-proxy fields are read once and migrated on the next save.
    #[serde(default, skip_serializing)]
    pub url: String,
    #[serde(default, skip_serializing)]
    pub username: String,
    #[serde(default, skip_serializing)]
    pub password: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyEntry {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyPoolStatus {
    pub enabled: bool,
    pub selected_id: Option<String>,
    pub proxies: Vec<ProxyEntryStatus>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyEntryStatus {
    pub id: String,
    pub name: String,
    pub url: String,
    pub auth_configured: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRoute {
    pub used: bool,
    pub mode: String,
    pub url: Option<String>,
    pub name: Option<String>,
}

fn active() -> &'static RwLock<Option<ProxyPoolConfig>> {
    static ACTIVE: OnceLock<RwLock<Option<ProxyPoolConfig>>> = OnceLock::new();
    ACTIVE.get_or_init(|| RwLock::new(None))
}

fn original_proxy_env() -> &'static HashMap<&'static str, Option<OsString>> {
    static ORIGINAL: OnceLock<HashMap<&'static str, Option<OsString>>> = OnceLock::new();
    ORIGINAL.get_or_init(|| ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy"]
        .into_iter().map(|key| (key, std::env::var_os(key))).collect())
}

fn normalize_url(raw: &str) -> Result<String, String> {
    if raw.len() > 512 || raw.chars().any(char::is_control) {
        return Err("代理地址无效".into());
    }
    let raw = raw.trim();
    let parsed = reqwest::Url::parse(raw).map_err(|_| "请输入有效的 HTTP/HTTPS 代理地址")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || parsed.port() == Some(0)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !matches!(parsed.path(), "" | "/")
    {
        return Err("仅支持不含认证信息的 HTTP/HTTPS 代理地址，例如 http://127.0.0.1:7890".into());
    }
    Ok(parsed.to_string())
}

fn proxy_url(config: &ProxyConfig) -> Result<String, String> {
    let mut url = reqwest::Url::parse(&normalize_url(&config.url)?)
        .map_err(|_| "代理地址无效")?;
    if !config.username.is_empty() {
        url.set_username(&config.username).map_err(|_| "代理用户名无效")?;
        url.set_password(Some(&config.password)).map_err(|_| "代理认证信息无效")?;
    }
    Ok(url.to_string())
}

fn set_process_proxy(config: Option<&ProxyConfig>) -> Result<(), String> {
    let original = original_proxy_env();
    let value = config.filter(|config| config.enabled).map(proxy_url).transpose()?;
    for key in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] {
        if let Some(value) = &value { std::env::set_var(key, value); }
        else if let Some(Some(value)) = original.get(key) { std::env::set_var(key, value); }
        else { std::env::remove_var(key); }
    }
    if value.is_some() {
        for key in ["NO_PROXY", "no_proxy"] {
            let existing = original.get(key).and_then(Option::as_ref).and_then(|value| value.to_str()).unwrap_or("");
            let merged = if existing.is_empty() { "localhost,127.0.0.1,::1".to_string() } else { format!("{existing},localhost,127.0.0.1,::1") };
            std::env::set_var(key, merged);
        }
    } else {
        for key in ["NO_PROXY", "no_proxy"] {
            if let Some(Some(value)) = original.get(key) { std::env::set_var(key, value); }
            else { std::env::remove_var(key); }
        }
    }
    Ok(())
}

pub fn initialize(conn: &rusqlite::Connection) -> Result<(), String> {
    use rusqlite::OptionalExtension;
    let encrypted: Option<String> = conn.query_row(
        "SELECT value FROM client_preferences WHERE key=?1", [PREF_KEY], |row| row.get(0),
    ).optional().map_err(|_| "读取全局代理配置失败")?;
    let config = encrypted.map(|value| {
        let plaintext = crate::core::crypto::decrypt_secret(&value).map_err(|_| "解密全局代理配置失败")?;
        let pool = serde_json::from_str::<ProxyPoolConfig>(&plaintext).map_err(|_| "全局代理配置格式无效".to_string())?;
        Ok::<ProxyPoolConfig, String>(migrate_legacy_pool(pool))
    }).transpose()?;
    let selected = config.as_ref().filter(|pool| pool.enabled).and_then(selected_proxy).map(|proxy| ProxyConfig {
        enabled: true, url: proxy.url.clone(), username: proxy.username.clone(), password: proxy.password.clone(),
    });
    if let Some(proxy) = selected.as_ref() { let _ = normalize_url(&proxy.url)?; }
    set_process_proxy(selected.as_ref())?;
    *active().write().map_err(|_| "全局代理状态不可用")? = config;
    Ok(())
}

fn selected_proxy(pool: &ProxyPoolConfig) -> Option<&ProxyEntry> {
    pool.selected_id.as_deref().and_then(|id| pool.proxies.iter().find(|proxy| proxy.id == id))
}

pub fn migrate_legacy_pool(mut pool: ProxyPoolConfig) -> ProxyPoolConfig {
    if pool.proxies.is_empty() && !pool.url.trim().is_empty() {
        let id = "legacy-proxy".to_string();
        pool.proxies.push(ProxyEntry { id: id.clone(), name: "旧版代理".into(), url: pool.url.clone(), username: pool.username.clone(), password: pool.password.clone() });
        pool.selected_id = Some(id);
        pool.url.clear(); pool.username.clear(); pool.password.clear();
    }
    pool
}

pub fn pool_status(pool: Option<&ProxyPoolConfig>) -> ProxyPoolStatus {
    let pool = pool.cloned().unwrap_or_default();
    ProxyPoolStatus {
        enabled: pool.enabled,
        selected_id: pool.selected_id.clone(),
        proxies: pool.proxies.iter().map(|proxy| ProxyEntryStatus {
            id: proxy.id.clone(), name: proxy.name.clone(),
            url: normalize_url(&proxy.url).unwrap_or_default(),
            auth_configured: !proxy.username.is_empty(),
        }).collect(),
    }
}

pub fn save_pool(conn: &rusqlite::Connection, mut pool: ProxyPoolConfig) -> Result<ProxyPoolStatus, String> {
    if pool.proxies.len() > 50 { return Err("代理池最多保存 50 个代理".into()); }
    let mut ids = std::collections::HashSet::new();
    for proxy in &mut pool.proxies {
        proxy.id = proxy.id.trim().to_string();
        proxy.name = proxy.name.trim().to_string();
        if proxy.id.is_empty() || proxy.id.len() > 64 || !ids.insert(proxy.id.clone()) { return Err("代理标识无效或重复".into()); }
        if proxy.name.is_empty() || proxy.name.len() > 80 || proxy.name.chars().any(char::is_control) { return Err("代理名称需为 1-80 个字符".into()); }
        proxy.url = normalize_url(&proxy.url)?;
        if proxy.username.len() > 256 || proxy.password.len() > 1024
            || proxy.username.chars().any(char::is_control) || proxy.password.chars().any(char::is_control)
            || proxy.username.is_empty() != proxy.password.is_empty() { return Err("代理认证信息无效；用户名与密码需同时填写".into()); }
    }
    if pool.selected_id.as_ref().is_some_and(|id| !pool.proxies.iter().any(|proxy| &proxy.id == id)) { return Err("所选代理不在代理池中".into()); }
    if pool.enabled && pool.selected_id.is_none() { return Err("启用全局代理前，请先选择一个代理".into()); }
    let selected = selected_proxy(&pool);
    if pool.enabled { if let Some(proxy) = selected { proxy_url(&ProxyConfig { enabled: true, url: proxy.url.clone(), username: proxy.username.clone(), password: proxy.password.clone() })?; } }
    let encrypted = crate::core::crypto::encrypt_secret(&serde_json::to_string(&pool).map_err(|_| "保存全局代理配置失败")?)
        .map_err(|_| "加密全局代理配置失败")?;
    crate::core::repositories::preferences::save(conn, PREF_KEY, &encrypted, chrono::Utc::now().timestamp_millis())
        .map_err(|_| "保存全局代理配置失败")?;
    let selected = selected.filter(|_| pool.enabled).map(|proxy| ProxyConfig { enabled: true, url: proxy.url.clone(), username: proxy.username.clone(), password: proxy.password.clone() });
    set_process_proxy(selected.as_ref())?;
    *active().write().map_err(|_| "全局代理状态不可用")? = Some(pool.clone());
    Ok(pool_status(Some(&pool)))
}

pub fn current_route() -> ProxyRoute {
    match active().read().ok().and_then(|value| value.clone()).filter(|pool| pool.enabled).and_then(|pool| {
        let proxy = selected_proxy(&pool)?.clone(); Some((proxy, pool))
    }) {
        Some((proxy, _)) => ProxyRoute { used: true, mode: "global".into(), url: normalize_url(&proxy.url).ok().and_then(|url| safe_proxy_address(&url)), name: Some(proxy.name) },
        None => ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].into_iter()
            .find_map(|key| original_proxy_env().get(key).and_then(Option::as_ref).and_then(|value| value.to_str()).and_then(safe_proxy_address)
                .map(|url| ProxyRoute { used: true, mode: "system".into(), url: Some(url), name: Some("系统代理".into()) }))
            .unwrap_or(ProxyRoute { used: false, mode: "direct".into(), url: None, name: None }),
    }
}

fn route_from_config(config: &ProxyConfig, mode: &str) -> ProxyRoute {
    ProxyRoute { used: true, mode: mode.into(), url: normalize_url(&config.url).ok().and_then(|url| safe_proxy_address(&url)), name: Some(if mode == "account" { "账号专属代理" } else { "全局代理" }.into()) }
}

fn safe_proxy_address(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw).ok()?;
    Some(match url.port() { Some(port) => format!("{}://{}:{port}", url.scheme(), url.host_str()?), None => format!("{}://{}", url.scheme(), url.host_str()?) })
}

pub fn route_for_account(account_proxy: Option<&str>) -> ProxyRoute {
    if let Some(url) = account_proxy.and_then(|raw| crate::core::codex::account_controls::validate_proxy(raw).ok().flatten()) {
        let config = ProxyConfig { enabled: true, url, ..ProxyConfig::default() };
        return route_from_config(&config, "account");
    }
    current_route()
}

pub async fn test(url: &str, username: &str, password: &str) -> Result<u64, String> {
    let config = ProxyConfig { enabled: true, url: normalize_url(url)?, username: username.into(), password: password.into() };
    if config.username.is_empty() != config.password.is_empty() { return Err("用户名与密码需同时填写".into()); }
    let proxy = reqwest::Proxy::all(proxy_url(&config)?).map_err(|_| "代理地址无效")?;
    let client = reqwest::Client::builder().no_proxy().proxy(proxy)
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(10))
        .build().map_err(|_| "创建代理测试连接失败")?;
    let started = std::time::Instant::now();
    let response = client.get("https://example.com/").send().await
        .map_err(|_| "代理连接失败，请检查代理地址、认证信息和网络状态")?;
    if response.status().is_success() { Ok(started.elapsed().as_millis().min(u64::MAX as u128) as u64) } else { Err(format!("代理已连接，但目标站点返回 HTTP {}", response.status().as_u16())) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_proxy_and_redacts_credentials_from_status() {
        assert_eq!(normalize_url("http://127.0.0.1:7890").unwrap(), "http://127.0.0.1:7890/");
        for value in ["socks5://127.0.0.1:1080", "http://user:secret@localhost:80", "http://host:80/path", "http://host:80/?token=x"] {
            assert!(normalize_url(value).is_err());
        }
        let config = ProxyConfig { enabled: true, url: "http://127.0.0.1:7890".into(), username: "private-user".into(), password: "private-password".into() };
        let value = serde_json::to_string(&ProxyEntryStatus { id: "p1".into(), name: "测试节点".into(), url: config.url, auth_configured: !config.username.is_empty() }).unwrap();
        assert!(!value.contains("private-user") && !value.contains("private-password"));
    }

    #[test]
    fn pool_status_exposes_selection_without_proxy_credentials() {
        let pool = ProxyPoolConfig { enabled: true, selected_id: Some("p2".into()), proxies: vec![
            ProxyEntry { id: "p1".into(), name: "节点 A".into(), url: "http://127.0.0.1:7890".into(), username: "private-user".into(), password: "private-password".into() },
            ProxyEntry { id: "p2".into(), name: "节点 B".into(), url: "https://proxy.example:8443".into(), username: String::new(), password: String::new() },
        ], ..ProxyPoolConfig::default() };
        let value = serde_json::to_string(&pool_status(Some(&pool))).unwrap();
        assert!(value.contains("p2") && value.contains("节点 A") && value.contains("authConfigured"));
        assert!(!value.contains("private-user") && !value.contains("private-password"));
    }

    #[test]
    fn legacy_single_proxy_migrates_to_selected_pool_entry() {
        let legacy: ProxyPoolConfig = serde_json::from_str(r#"{"enabled":true,"url":"http://127.0.0.1:7890"}"#).unwrap();
        let migrated = migrate_legacy_pool(legacy);
        assert_eq!(migrated.selected_id.as_deref(), Some("legacy-proxy"));
        assert_eq!(migrated.proxies.len(), 1);
        assert_eq!(migrated.proxies[0].url, "http://127.0.0.1:7890");
    }

    #[test]
    fn route_labels_never_include_proxy_credentials() {
        let raw = ProxyConfig { enabled: true, url: "http://127.0.0.1:7890".into(), username: "private-user".into(), password: "private-password".into() };
        let route = route_from_config(&raw, "global");
        let serialized = serde_json::to_string(&route).unwrap();
        assert!(route.used && route.mode == "global");
        assert_eq!(route.url.as_deref(), Some("http://127.0.0.1:7890"));
        assert!(!serialized.contains("private-user") && !serialized.contains("private-password"));
    }

    #[test]
    fn account_proxy_is_reported_as_the_selected_route() {
        let route = route_for_account(Some("http://127.0.0.1:8899"));
        assert!(route.used);
        assert_eq!(route.mode, "account");
        assert_eq!(route.url.as_deref(), Some("http://127.0.0.1:8899"));
    }
}
