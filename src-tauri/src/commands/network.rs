use crate::core::{crypto::decrypt_secret, database::open_db, error::PlatformResult, network::{self, ProxyEntry, ProxyPoolConfig, ProxyPoolStatus}};
use rusqlite::OptionalExtension;

const PREF_KEY: &str = "network.global_proxy";

fn read_pool() -> PlatformResult<ProxyPoolConfig> {
    let conn = open_db()?;
    let encrypted: Option<String> = conn.query_row("SELECT value FROM client_preferences WHERE key=?1", [PREF_KEY], |row| row.get(0)).optional().map_err(|_| "读取全局代理配置失败")?;
    let pool = encrypted.map(|value| {
        let plaintext = decrypt_secret(&value).map_err(|_| "解密全局代理配置失败")?;
        serde_json::from_str::<ProxyPoolConfig>(&plaintext).map_err(|_| "全局代理配置格式无效".to_string())
    }).transpose()?.unwrap_or_default();
    Ok(network::migrate_legacy_pool(pool))
}

#[tauri::command]
pub(crate) fn network_proxy_get() -> PlatformResult<ProxyPoolStatus> {
    let pool = read_pool()?;
    Ok(network::pool_status(Some(&pool)))
}

#[tauri::command]
pub(crate) fn network_proxy_save(enabled: bool, proxies: Vec<ProxyEntry>, selected_id: Option<String>) -> PlatformResult<ProxyPoolStatus> {
    let conn = open_db()?;
    let previous = read_pool()?;
    let proxies = proxies.into_iter().map(|mut proxy| {
        if proxy.username.is_empty() && proxy.password.is_empty() {
            if let Some(old) = previous.proxies.iter().find(|item| item.id == proxy.id) {
                proxy.username = old.username.clone();
                proxy.password = old.password.clone();
            }
        }
        proxy
    }).collect();
    Ok(network::save_pool(&conn, ProxyPoolConfig { enabled, proxies, selected_id, ..ProxyPoolConfig::default() })?)
}

#[tauri::command]
pub(crate) async fn network_proxy_test(proxy_id: Option<String>, url: String, username: String, password: String, keep_auth: bool) -> PlatformResult<u64> {
    let (username, password) = if keep_auth && username.is_empty() && password.is_empty() {
        let pool = read_pool()?;
        let old = pool.proxies.iter().find(|item| Some(item.id.as_str()) == proxy_id.as_deref());
        old.map(|item| (item.username.clone(), item.password.clone())).unwrap_or_default()
    } else { (username, password) };
    network::test(&url, &username, &password).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn network_proxy_detect() -> PlatformResult<Vec<crate::core::codex::proxy_detection::ProxyCandidate>> {
    tauri::async_runtime::spawn_blocking(crate::core::codex::proxy_detection::detect)
        .await.map_err(|_| "读取本机代理配置失败，请手动填写地址")?.map_err(Into::into)
}
