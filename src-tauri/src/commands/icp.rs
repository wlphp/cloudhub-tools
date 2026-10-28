use crate::core::error::PlatformResult;
use serde_json::{json, Value};
use std::time::Duration;

fn normalize_domain(input: &str) -> Result<String, &'static str> {
    let domain = input.trim().trim_start_matches("*.").trim_end_matches('.').to_ascii_lowercase();
    if domain.len() > 253 || !domain.contains('.') || domain.parse::<std::net::IpAddr>().is_ok()
        || domain.split('.').any(|label| label.is_empty() || label.len() > 63
            || label.starts_with('-') || label.ends_with('-')
            || !label.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')) {
        return Err("请输入有效的域名");
    }
    Ok(domain)
}

fn parse_result(value: &Value, domain: &str) -> Result<Value, &'static str> {
    let rows = value["results"].as_array().ok_or("宝塔返回的备案数据无效")?;
    if value["feature"] != "icp" || rows.len() != 1 || rows[0]["target"] != domain {
        return Err("宝塔返回的备案数据无效");
    }
    let row = &rows[0];
    if row["ok"] != true { return Err("宝塔未能完成备案查询，请稍后重试"); }
    let data = &row["data"];
    let registered = data["registered"].as_bool().ok_or("宝塔返回的备案状态无效")?;
    let mut result = json!({ "target": domain, "registered": registered, "checkedAt": value["checked_at"].as_u64() });
    for key in ["company_beian_code", "company_name", "domain", "name", "site_beian_code", "type", "update_time", "verify_time", "website_index"] {
        if let Some(text) = data[key].as_str() {
            if text.len() > 2048 { return Err("宝塔返回的备案字段过长"); }
            result[key] = json!(text);
        }
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn query_domain_icp(domain: String) -> PlatformResult<Value> {
    let domain = normalize_domain(&domain)?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|_| "无法初始化备案查询")?;
    let mut response = client.post("https://t.bt.cn/api/v3/domain-checks/icp")
        .json(&json!({ "targets": [&domain] })).send().await
        .map_err(|_| "备案查询连接失败或超时，请重试")?;
    if !response.status().is_success() { return Err("宝塔查询服务暂不可用，请稍后重试".into()); }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取备案信息失败")? {
        if body.len() + chunk.len() > 65_536 { return Err("备案查询响应过大".into()); }
        body.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&body).map_err(|_| "宝塔返回的数据格式无效")?;
    Ok(parse_result(&value, &domain)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_domain_and_target() {
        assert_eq!(normalize_domain(" *.Example.COM. "), Ok("example.com".into()));
        for invalid in ["127.0.0.1", "https://example.com", "a.com/path", "a..com", "-a.com", "a.com:80"] {
            assert!(normalize_domain(invalid).is_err());
        }
        let mut response = json!({"feature":"icp","results":[{"target":"example.com","ok":true,"data":{"registered":false}}]});
        assert_eq!(parse_result(&response, "example.com").unwrap()["registered"], false);
        assert!(parse_result(&response, "other.com").is_err());
        response["results"][0]["ok"] = json!(false);
        assert!(parse_result(&response, "example.com").is_err());
        response["results"][0]["ok"] = json!(true);
        response["results"][0]["data"]["registered"] = Value::Null;
        assert!(parse_result(&response, "example.com").is_err());
    }
}
