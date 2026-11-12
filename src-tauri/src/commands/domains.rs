use crate::account_cloud_type;
use crate::core::error::PlatformResult;
use serde_json::Value;

#[tauri::command]
pub(crate) async fn list_dns_records(id: i64, domain: String, record_type: Option<String>, keyword: Option<String>) -> PlatformResult<Value> {
    if account_cloud_type(id)? == "tencent" {
        return crate::cloud::tencent::list_dns_records(id, &domain, record_type, keyword).await.map_err(Into::into);
    }
    if account_cloud_type(id)? == "ctyun" {
        return crate::cloud::ctyun::list_dns_records(id, &domain, record_type, keyword).await.map_err(Into::into);
    }
    crate::cloud::aliyun::list_dns_records(id, &domain, record_type, keyword).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn add_dns_record(id: i64, domain: String, record_type: String, rr: String, value: String, ttl: Option<i64>, priority: Option<i64>, line: Option<String>) -> PlatformResult<Value> {
    crate::cloud::aliyun::add_dns_record(id, &domain, &record_type, &rr, &value, ttl, priority, line).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn update_dns_record(id: i64, record_id: String, record_type: String, rr: String, value: String, ttl: Option<i64>, priority: Option<i64>, line: Option<String>) -> PlatformResult<Value> {
    crate::cloud::aliyun::update_dns_record(id, &record_id, &record_type, &rr, &value, ttl, priority, line).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn delete_dns_record(id: i64, record_id: String) -> PlatformResult<Value> {
    crate::cloud::aliyun::delete_dns_record(id, &record_id).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn toggle_dns_record(id: i64, record_id: String, status: String) -> PlatformResult<Value> {
    crate::cloud::aliyun::toggle_dns_record(id, &record_id, &status).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn list_domain_logs(id: i64, domain: String, start_date: Option<String>, end_date: Option<String>, keyword: Option<String>) -> PlatformResult<Value> {
    crate::cloud::aliyun::list_domain_logs(id, &domain, start_date, end_date, keyword).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn query_whois(id: i64, domain: String) -> PlatformResult<String> {
    crate::cloud::aliyun::query_whois(id, &domain).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn list_rds_databases(id: i64, region_id: String, instance_id: String) -> PlatformResult<Vec<Value>> {
    if account_cloud_type(id)? == "tencent" { return crate::cloud::tencent::list_rds_databases(id, &region_id, &instance_id).await.map_err(Into::into); }
    crate::cloud::aliyun::list_rds_databases(id, &region_id, &instance_id).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn rds_storage_usage(id: i64, region_id: String, instance_id: String) -> PlatformResult<Value> {
    crate::cloud::aliyun::rds_storage_usage(id, &region_id, &instance_id).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn rds_connection_addresses(id: i64, region_id: String, instance_id: String) -> PlatformResult<Vec<Value>> {
    crate::cloud::aliyun::rds_connection_addresses(id, &region_id, &instance_id).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn list_rds_accounts(id: i64, region_id: String, instance_id: String) -> PlatformResult<Vec<Value>> {
    if account_cloud_type(id)? == "tencent" { return crate::cloud::tencent::list_rds_accounts(id, &region_id, &instance_id).await.map_err(Into::into); }
    crate::cloud::aliyun::list_rds_accounts(id, &region_id, &instance_id).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn list_redis_accounts(id: i64, instance_id: String, region_id: String) -> PlatformResult<Vec<Value>> {
    if account_cloud_type(id)? == "tencent" { return crate::cloud::tencent::list_redis_accounts(id, &instance_id, &region_id).await.map_err(Into::into); }
    crate::cloud::aliyun::list_redis_accounts(id, &instance_id, &region_id).await.map_err(Into::into)
}


/// 独立查询公网 NS，不使用云账户中可能已停用的托管区配置。
#[tauri::command]
pub(crate) async fn resolve_domain_nameservers(domain: String) -> PlatformResult<Vec<String>> {
    let domain = domain.trim().trim_end_matches('.').to_ascii_lowercase();
    if domain.len() > 253 || !domain.contains('.') || domain.parse::<std::net::IpAddr>().is_ok() || !domain.split('.').all(|label| !label.is_empty() && label.len() <= 63 && !label.starts_with('-') && !label.ends_with('-') && label.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')) {
        return Err("域名格式无效，请使用有效域名（国际域名请使用 Punycode）".into());
    }
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(8)).build().map_err(|_| "无法初始化 DNS 查询")?;
    for endpoint in ["https://dns.alidns.com/resolve", "https://cloudflare-dns.com/dns-query", "https://dns.google/resolve"] {
        let Ok(response) = client.get(endpoint).query(&[("name", domain.as_str()), ("type", "NS")]).header("accept", "application/dns-json").send().await else { continue };
        if !response.status().is_success() { continue; }
        let Ok(data) = response.json::<Value>().await else { continue };
        if let Ok(nameservers) = public_nameservers(&data, &domain) { return Ok(nameservers); }
    }
    Err("公网 NS 查询失败或未返回 NS 记录，请稍后重试；未使用云账户配置代替查询结果".into())
}

fn public_nameservers(data: &Value, domain: &str) -> Result<Vec<String>, ()> {
    if data.get("Status").and_then(Value::as_u64) != Some(0) { return Err(()); }
    let mut nameservers: Vec<String> = data.get("Answer").and_then(Value::as_array).into_iter().flatten()
        .filter(|item| item.get("type").and_then(Value::as_u64) == Some(2) && item.get("name").and_then(Value::as_str).is_some_and(|name| name.trim_end_matches('.').eq_ignore_ascii_case(domain)))
        .filter_map(|item| item.get("data").and_then(Value::as_str)).map(|name| name.trim_end_matches('.').to_ascii_lowercase()).filter(|name| !name.is_empty()).collect();
    nameservers.sort(); nameservers.dedup();
    if nameservers.is_empty() { Err(()) } else { Ok(nameservers) }
}

#[cfg(test)]
mod public_dns_tests {
    #[test]
    fn ns_answers_exclude_unrelated_records_and_failed_responses() {
        let data = serde_json::json!({"Status": 0, "Answer": [
            {"name":"example.test.", "type":2, "data":"B.ns.cloudflare.com."},
            {"name":"EXAMPLE.TEST.", "type":2, "data":"a.ns.cloudflare.com."},
            {"name":"other.test.", "type":2, "data":"wrong.test."},
            {"name":"example.test.", "type":1, "data":"192.0.2.1"}
        ]});
        assert_eq!(super::public_nameservers(&data, "example.test").unwrap(), vec!["a.ns.cloudflare.com", "b.ns.cloudflare.com"]);
        assert!(super::public_nameservers(&serde_json::json!({"Status": 2}), "example.test").is_err());
        assert!(super::public_nameservers(&serde_json::json!({"Status": 0}), "example.test").is_err());
    }
}
