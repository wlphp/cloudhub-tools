use serde_json::{json, Value};
use crate::core::error::PlatformResult;
use std::{net::IpAddr, time::Duration};

#[tauri::command]
pub(crate) async fn query_ip_location(ip: String) -> PlatformResult<Value> {
    let address = ip.trim().parse::<IpAddr>().map_err(|_| "请输入有效的 IP 地址")?;
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
    Ok(value)
}
