use serde_json::{json, Value};
use crate::core::error::PlatformResult;
use std::{net::IpAddr, time::Duration};
use crate::core::storage::open_db;
use rusqlite::OptionalExtension;

static QUERY_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tauri::command]
pub(crate) fn list_ip_locations() -> PlatformResult<Vec<Value>> {
    let conn = open_db()?;
    let mut stmt = conn.prepare("SELECT result_json FROM ip_location_cache").map_err(|_| "读取归属地缓存失败")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(|_| "读取归属地缓存失败")?;
    rows.map(|row| {
        let raw = row.map_err(|_| "读取归属地缓存失败")?;
        serde_json::from_str(&raw).map_err(|_| "归属地缓存格式无效".into())
    }).collect()
}

#[tauri::command]
pub(crate) async fn delete_ip_location(ip: String) -> PlatformResult<()> {
    let address = ip.trim().parse::<IpAddr>().map_err(|_| "请输入有效的 IP 地址")?;
    let _guard = QUERY_LOCK.lock().await;
    open_db()?.execute("DELETE FROM ip_location_cache WHERE ip=?1", [address.to_string()])
        .map_err(|_| "删除归属地缓存失败")?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn query_ip_location(ip: String) -> PlatformResult<Value> {
    let address = ip.trim().parse::<IpAddr>().map_err(|_| "请输入有效的 IP 地址")?;
    let _guard = QUERY_LOCK.lock().await;
    let cached: Option<String> = open_db()?.query_row("SELECT result_json FROM ip_location_cache WHERE ip=?1", [address.to_string()], |row| row.get(0))
        .optional().map_err(|_| "读取归属地缓存失败")?;
    if let Some(raw) = cached {
        return serde_json::from_str(&raw).map_err(|_| "归属地缓存格式无效".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build().map_err(|_| "无法初始化归属地查询")?;
    let mut response = client.post("https://t.bt.cn/api/v3/ip-lookup")
        .json(&json!({ "target": address.to_string() }))
        .send().await.map_err(|_| "归属地查询连接失败或超时，请重试")?;
    if !response.status().is_success() { return Err("宝塔查询服务暂不可用，请稍后重试".into()); }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取归属地信息失败")? {
        if body.len() + chunk.len() > 65_536 { return Err("归属地响应过大".into()); }
        body.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&body).map_err(|_| "宝塔返回的数据格式无效")?;
    if value["feature"] != "ip" || value["found"].as_bool().is_none()
        || value["target"].as_str().and_then(|target| target.parse::<IpAddr>().ok()) != Some(address)
        || (value["found"] == true && !value["location"].is_object()) {
        return Err("宝塔返回的归属地数据无效".into());
    }
    let mut value = value;
    value["target"] = json!(address.to_string());
    open_db()?.execute("INSERT INTO ip_location_cache(ip,result_json) VALUES(?1,?2)", rusqlite::params![address.to_string(), value.to_string()])
        .map_err(|_| "保存归属地缓存失败")?;
    Ok(value)
}
