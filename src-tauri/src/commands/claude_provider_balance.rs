use crate::core::{claude_providers::ClaudeProvider, error::PlatformResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize, Serialize)]
struct Balance { is_available: bool, balance_infos: Vec<BalanceInfo> }
#[derive(Deserialize, Serialize)]
struct BalanceInfo { currency: String, total_balance: String, granted_balance: String, topped_up_balance: String }

fn official(value: &str) -> bool {
    reqwest::Url::parse(value).is_ok_and(|url| url.scheme() == "https" && url.host_str() == Some("api.deepseek.com") && url.username().is_empty() && url.password().is_none() && url.port_or_known_default() == Some(443) && url.query().is_none() && url.fragment().is_none())
}
fn parse(value: &[u8]) -> Result<Value, &'static str> {
    let balance: Balance = serde_json::from_slice(value).map_err(|_| "余额响应格式无效")?;
    if balance.balance_infos.is_empty() || balance.balance_infos.len() > 8 || balance.balance_infos.iter().any(|info| {
        !matches!(info.currency.as_str(), "CNY" | "USD") || [&info.total_balance, &info.granted_balance, &info.topped_up_balance].iter().any(|amount| amount.len() > 40 || amount.parse::<f64>().map_or(true, |value| !value.is_finite()))
    }) { return Err("余额响应格式无效"); }
    serde_json::to_value(balance).map_err(|_| "余额响应格式无效")
}
pub async fn query(provider: ClaudeProvider) -> PlatformResult<Value> {
    let error = super::transfer::error;
    if !official(&provider.base_url) || provider.official_login { return Err(error("仅支持 DeepSeek 官方 API 余额查询")); }
    if provider.api_key.trim().is_empty() { return Err(error("请先配置 API Key")); }
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(std::time::Duration::from_secs(15)).build().map_err(|_| error("无法初始化余额查询"))?;
    let mut response = client.get("https://api.deepseek.com/user/balance").bearer_auth(&provider.api_key).send().await.map_err(|_| error("余额查询失败，请检查网络后重试"))?;
    match response.status().as_u16() {
        200 => {}, 401 | 403 => return Err(error("余额查询认证失败，请检查 API Key")),
        429 => return Err(error("余额查询过于频繁，请稍后重试")),
        _ => return Err(error("DeepSeek 余额服务暂不可用，请稍后重试")),
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| error("读取余额响应失败"))? {
        if body.len() + chunk.len() > 16384 { return Err(error("余额响应超出大小限制")); }
        body.extend_from_slice(&chunk);
    }
    parse(&body).map_err(error)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn official_origin_only() {
        assert!(official("https://api.deepseek.com/anthropic"));
        for url in ["http://api.deepseek.com", "https://api.deepseek.com.evil.test", "https://user@api.deepseek.com", "https://api.deepseek.com:8443"] { assert!(!official(url)); }
    }
    #[test]
    fn whitelist_and_validate_balance() {
        let data = br#"{"is_available":false,"balance_infos":[{"currency":"CNY","total_balance":"0.00","granted_balance":"0","topped_up_balance":"0"}],"unexpected":"not returned"}"#;
        let result = parse(data).unwrap(); assert!(result.get("unexpected").is_none()); assert_eq!(result["balance_infos"][0]["total_balance"], "0.00");
        assert!(parse(br#"{"is_available":true,"balance_infos":[]}"#).is_err());
        assert!(parse(b"not json").is_err());
    }
}
