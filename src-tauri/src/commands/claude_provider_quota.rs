use crate::core::{claude_providers::ClaudeProvider, error::PlatformResult};
use serde::Serialize;
use serde_json::Value;

// API Key never leaves the native layer; only validated quota fields reach the UI.
fn endpoint(base: &str) -> Option<String> {
    let url = reqwest::Url::parse(base).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some()
        || url.port_or_known_default() != Some(443) || url.query().is_some() || url.fragment().is_some() { return None; }
    let host = url.host_str()?;
    if !matches!(host, "api.minimaxi.com" | "api.minimax.io" | "api.minimax.cn") { return None; }
    Some(format!("https://{host}/v1/token_plan/remains"))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Window { model: String, period: String, remaining_percent: f64, resets_at: Option<i64> }
fn number(value: &Value) -> Option<f64> {
    value.as_f64().or_else(|| value.as_str()?.parse().ok()).filter(|n| n.is_finite())
}
fn parse(body: &[u8]) -> Result<Value, &'static str> {
    let root: Value = serde_json::from_slice(body).map_err(|_| "官方额度响应格式无效")?;
    let data = root.get("data").filter(|v| v.is_object()).unwrap_or(&root);
    let status = root.get("base_resp").or_else(|| data.get("base_resp"))
        .and_then(|v| v.get("status_code")).and_then(number).ok_or("官方额度响应缺少状态")?;
    if status != 0.0 { return Err("官方额度查询被拒绝，请确认使用对应地区的套餐 API Key"); }
    let models = data.get("model_remains").and_then(Value::as_array).ok_or("官方暂未提供套餐额度数据")?;
    if models.len() > 32 { return Err("官方额度响应超出限制"); }
    let mut windows = Vec::new();
    for item in models {
        let model = item.get("model_name").and_then(Value::as_str).filter(|v| !v.is_empty() && v.len() <= 120 && !v.chars().any(char::is_control)).ok_or("官方额度模型字段无效")?;
        for (period, percent_key, end_key, status_key) in [
            ("5h", "current_interval_remaining_percent", "end_time", "current_interval_status"),
            ("week", "current_weekly_remaining_percent", "weekly_end_time", "current_weekly_status"),
        ] {
            // Status 3 can mean unavailable or unlimited; do not invent a finite quota.
            if item.get(status_key).and_then(number) == Some(3.0) { continue; }
            let Some(percent) = item.get(percent_key).and_then(number) else { continue };
            if !(0.0..=100.0).contains(&percent) { return Err("官方额度比例无效"); }
            let resets_at = item.get(end_key).and_then(number).filter(|n| *n > 0.0).and_then(|n| {
                let ms = if n < 100_000_000_000.0 { n * 1000.0 } else { n };
                (ms <= 32_503_680_000_000.0).then_some(ms as i64)
            });
            windows.push(Window { model: model.into(), period: period.into(), remaining_percent: percent, resets_at });
        }
    }
    if windows.is_empty() { return Err("官方未提供可展示的周期余量；请在 MiniMax 控制台查看"); }
    Ok(serde_json::json!({"windows": windows, "queriedAt": chrono::Utc::now().timestamp_millis()}))
}
pub async fn query(provider: ClaudeProvider) -> PlatformResult<Value> {
    let error = super::transfer::error;
    let url = endpoint(&provider.base_url).filter(|_| !provider.official_login).ok_or_else(|| error("仅支持 MiniMax 官方套餐额度查询"))?;
    if provider.api_key.trim().is_empty() { return Err(error("请先配置 API Key")); }
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15)).build().map_err(|_| error("无法初始化额度查询"))?;
    let mut response = client.get(url).bearer_auth(&provider.api_key).header("Accept", "application/json")
        .send().await.map_err(|_| error("官方额度查询失败，请检查网络后重试"))?;
    match response.status().as_u16() {
        200 => {}, 401 | 403 => return Err(error("额度查询认证失败，请检查套餐 API Key 及地区")),
        429 => return Err(error("额度查询过于频繁，请稍后重试")),
        _ => return Err(error("官方额度服务暂不可用，请稍后重试")),
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| error("读取官方额度响应失败"))? {
        if body.len() + chunk.len() > 65536 { return Err(error("官方额度响应超出限制")); }
        body.extend_from_slice(&chunk);
    }
    parse(&body).map_err(error)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quota_origins_are_fixed() {
        assert_eq!(endpoint("https://api.minimaxi.com/anthropic").unwrap(), "https://api.minimaxi.com/v1/token_plan/remains");
        for url in ["http://api.minimaxi.com", "https://api.minimaxi.com.evil.test", "https://user@api.minimaxi.com", "https://api.minimaxi.com:8443", "https://api.minimaxi.com/?key=x"] { assert!(endpoint(url).is_none()); }
    }
    #[test]
    fn parses_official_percentages_without_local_estimates() {
        let result = parse(br#"{"base_resp":{"status_code":0},"data":{"model_remains":[{"model_name":"general","current_interval_remaining_percent":"96","current_weekly_remaining_percent":"99","end_time":1780297200000,"weekly_end_time":1780848000000}],"ignored":"not returned"}}"#).unwrap();
        assert_eq!(result["windows"][0]["remainingPercent"], 96.0);
        assert_eq!(result["windows"][1]["period"], "week");
        assert!(result.get("ignored").is_none());
        assert!(parse(br#"{"base_resp":{"status_code":1004,"status_msg":"not returned"}}"#).is_err());
        assert!(parse(br#"{"base_resp":{"status_code":0},"model_remains":[{"model_name":"general","current_interval_remaining_percent":101}]}"#).is_err());
        assert!(parse(br#"{"base_resp":{"status_code":0},"model_remains":[]}"#).is_err());
    }
    #[test]
    fn missing_week_and_unavailable_windows_are_not_fabricated() {
        let result = parse(br#"{"base_resp":{"status_code":0},"model_remains":[{"model_name":"general","current_interval_remaining_percent":45,"end_time":1780297200}]}"#).unwrap();
        assert_eq!(result["windows"].as_array().unwrap().len(), 1);
        assert_eq!(result["windows"][0]["resetsAt"], 1780297200000_i64);
        assert!(parse(br#"{"base_resp":{"status_code":0},"model_remains":[{"model_name":"general","current_weekly_remaining_percent":100,"current_weekly_status":3}]}"#).is_err());
        assert!(parse(br#"{"model_remains":[{"model_name":"general","current_interval_remaining_percent":45}]}"#).is_err());
    }
}
