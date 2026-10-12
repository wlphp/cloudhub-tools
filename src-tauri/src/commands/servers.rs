use crate::{account_cloud_type, account_credentials, array_at, ensure_aliyun_account, esa_field_details, esa_number, open_db, string_params, aliyun_esa};
use crate::cloud;
use crate::core::repositories::assets as asset_repository;
use crate::core::error::PlatformResult;
use chrono::{Duration, Local, TimeZone, Utc};
use serde_json::{Value, json};

fn esa_fields_params(fields: &[(&str, &[&str])]) -> std::collections::BTreeMap<String, String> {
    let mut params = std::collections::BTreeMap::new();
    for (field_index, (field_name, dimensions)) in fields.iter().enumerate() {
        let field_prefix = format!("Fields.{}", field_index + 1);
        params.insert(format!("{field_prefix}.FieldName"), (*field_name).to_string());
        for (dimension_index, dimension) in dimensions.iter().enumerate() {
            params.insert(format!("{field_prefix}.Dimension.{}", dimension_index + 1), (*dimension).to_string());
        }
    }
    params
}

fn esa_summarized_value(data: &Value, field_name: &str) -> f64 {
    array_at(data, &["SummarizedData"]).into_iter()
        .find(|item| item.get("FieldName").and_then(Value::as_str) == Some(field_name))
        .and_then(|item| item.get("Value"))
        .and_then(|value| value.as_f64().or_else(|| value.as_str().and_then(|text| text.parse().ok())))
        .unwrap_or_else(|| esa_field_details(data, field_name).iter().map(|item| esa_number(item.get("Value"))).sum())
}

fn esa_waf_blocked_requests(data: &Value) -> f64 {
    array_at(data, &["SummarizedData"]).into_iter()
        .filter(|item| item.get("FieldName").and_then(Value::as_str) == Some("Requests")
            && item.get("DimensionName").and_then(Value::as_str) == Some("Action")
            && item.get("DimensionValue").and_then(Value::as_str).is_some_and(|value| value.eq_ignore_ascii_case("block")))
        .map(|item| esa_number(item.get("Value")))
        .sum()
}

#[tauri::command]
pub(crate) async fn oracle_instance_action(id: i64, region_id: String, instance_id: String, action: String) -> PlatformResult<String> { cloud::oracle::instance_action(id, region_id, instance_id, action).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn vultr_instance_action(id: i64, instance_id: String, action: String) -> PlatformResult<Value> { cloud::vultr::vultr_instance_action(id, instance_id, action).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn vultr_instance_manage(id: i64, instance_id: String, action: String, value: Option<String>) -> PlatformResult<Value> { cloud::vultr::vultr_instance_manage(id, instance_id, action, value).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn list_vultr_firewall_rules(id: i64, firewall_group_id: String) -> PlatformResult<Value> { cloud::vultr::list_vultr_firewall_rules(id, firewall_group_id).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn create_vultr_firewall_rule(id: i64, firewall_group_id: String, ip_protocol: String, port: String, source_cidr_ip: String, description: Option<String>) -> PlatformResult<Value> { cloud::vultr::create_vultr_firewall_rule(id, firewall_group_id, ip_protocol, port, source_cidr_ip, description).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn delete_vultr_firewall_rule(id: i64, firewall_group_id: String, rule_id: String) -> PlatformResult<Value> { cloud::vultr::delete_vultr_firewall_rule(id, firewall_group_id, rule_id).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn esa_overview(id: i64, range: String, site_id: Option<String>) -> PlatformResult<Value> {
    if account_cloud_type(id)? == "tencent" || account_cloud_type(id)? == "volcengine" {
        let (access_key_id, access_key_secret) = account_credentials(id)?;
        let zones = if account_cloud_type(id)? == "tencent" {
            cloud::tencent::resource_items(id, "esa", &access_key_id, &access_key_secret).await
        } else {
            cloud::volc::resource_items(id, "esa", &access_key_id, &access_key_secret).await
        };
        let label = match range.as_str() { "yesterday" => "昨日", "week" => "近 7 日", "month" => "近 30 日", _ => "今日" };
        return Ok(json!({
            "traffic": 0, "requests": 0, "defence_requests": 0,
            "site_count": zones.items.len(), "active_count": zones.items.iter().filter(|site| site.get("Status").and_then(Value::as_str).is_some_and(|status| status.eq_ignore_ascii_case("active"))).count(),
            "range_label": label, "trend": {"traffic": [], "requests": [], "page_view": []},
            "site_options": zones.items.iter().map(|site| json!({"id": site.get("SiteId").cloned().unwrap_or(json!("")), "name": site.get("SiteName").or_else(|| site.get("DomainName")).or_else(|| site.get("SiteId")).cloned().unwrap_or(json!(""))})).collect::<Vec<_>>(),
        }));
    }
    ensure_aliyun_account(id)?;
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let sites_result = aliyun_esa("ListSites", string_params(&[
        ("SiteSearchType", "fuzzy".into()), ("SiteName", "".into()),
        ("PageNumber", "1".into()), ("PageSize", "100".into()),
    ]), "GET", &access_key_id, &access_key_secret).await?;
    let sites = array_at(&sites_result, &["Sites"]);
    let now = Local::now();
    let today = Local.from_local_datetime(&now.date_naive().and_hms_opt(0, 0, 0).ok_or("无法计算今日起点")?).single().unwrap_or(now);
    let (start, end, label, interval) = match range.as_str() {
        "yesterday" => (today - Duration::days(1), today, "昨日", "3600"),
        "week" => (today - Duration::days(6), now, "近 7 日", "3600"),
        "month" => (today - Duration::days(29), now, "近 30 日", "86400"),
        _ => (today, now, "今日", "3600"),
    };
    let mut base = string_params(&[
        ("StartTime", start.with_timezone(&Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string()),
        ("EndTime", end.with_timezone(&Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string()),
        ("Interval", interval.into()),
    ]);
    let selected_site = site_id.filter(|value| !value.is_empty());
    if let Some(ref value) = selected_site { base.insert("SiteId".into(), value.clone()); }
    let mut trend_params = base.clone(); trend_params.extend(esa_fields_params(&[
        ("Requests", &["ALL"]), ("Traffic", &["ALL"]), ("PageView", &["ALL"]),
    ]));
    let mut waf_params = base; waf_params.extend(esa_fields_params(&[("Requests", &["Action"])]));
    let (trend_result, waf_result) = tokio::join!(
        aliyun_esa("DescribeSiteTimeSeriesData", trend_params, "POST", &access_key_id, &access_key_secret),
        aliyun_esa("DescribeSiteWafTimeSeriesData", waf_params, "POST", &access_key_id, &access_key_secret),
    );
    let trend = trend_result?;
    let defence_requests = waf_result.as_ref().ok().map(|waf| esa_waf_blocked_requests(waf));
    let make_trend = |field_name: &str| esa_field_details(&trend, field_name).into_iter().map(|detail| json!({
        "time": detail.get("Time").or_else(|| detail.get("Timestamp")).or_else(|| detail.get("TimeStamp")).or_else(|| detail.get("Date")).cloned().unwrap_or(json!("")),
        "value": esa_number(detail.get("Value")),
    })).collect::<Vec<_>>();
    Ok(json!({
        "traffic": esa_summarized_value(&trend, "Traffic"),
        "requests": esa_summarized_value(&trend, "Requests"),
        "defence_requests": defence_requests,
        "site_count": sites_result.get("TotalCount").and_then(Value::as_i64).unwrap_or(sites.len() as i64),
        "active_count": sites.iter().filter(|site| site.get("Status").and_then(Value::as_str).map(|status| status.eq_ignore_ascii_case("active")).unwrap_or(false)).count(),
        "range_label": label,
        "trend": {"traffic": make_trend("Traffic"), "requests": make_trend("Requests"), "page_view": make_trend("PageView")},
        "site_options": sites.iter().map(|site| json!({"id": site.get("SiteId").cloned().unwrap_or(json!("")), "name": site.get("SiteName").or_else(|| site.get("DomainName")).or_else(|| site.get("SiteId")).cloned().unwrap_or(json!(""))})).collect::<Vec<_>>(),
    }))
}

#[tauri::command]
pub(crate) async fn list_instance_disks(id: i64, region_id: String, instance_id: String, compartment_ocid: Option<String>) -> PlatformResult<Vec<Value>> {
    if account_cloud_type(id)? == "oracle" { return cloud::oracle::instance_disks(id, &region_id, &instance_id, compartment_ocid.as_deref().unwrap_or("")).await.map_err(Into::into); }
    if account_cloud_type(id)? == "tencent" { return cloud::tencent::instance_disks(id, &region_id, &instance_id).await.map_err(Into::into); }
    cloud::aliyun::instance_disks(id, &region_id, &instance_id).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn list_aliyun_security_groups(id: i64, region_id: String, instance_id: String, security_group_id: Option<String>) -> PlatformResult<Value> { cloud::aliyun::list_security_groups(id, &region_id, &instance_id, security_group_id).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn authorize_aliyun_security_group_rule(id: i64, region_id: String, security_group_id: String, ip_protocol: String, port_range: String, source_cidr_ip: String, description: Option<String>, nic_type: Option<String>) -> PlatformResult<String> { cloud::aliyun::authorize_security_group_rule(id, &region_id, &security_group_id, ip_protocol, port_range, source_cidr_ip, description, nic_type).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn revoke_aliyun_security_group_rule(id: i64, region_id: String, security_group_id: String, ip_protocol: String, port_range: String, source_cidr_ip: String, policy: String, priority: i32, nic_type: Option<String>) -> PlatformResult<String> { cloud::aliyun::revoke_security_group_rule(id, &region_id, &security_group_id, ip_protocol, port_range, source_cidr_ip, policy, priority, nic_type).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn list_tencent_security_groups(id: i64, region_id: String, instance_id: String, security_group_id: Option<String>) -> PlatformResult<Value> { cloud::tencent::list_security_groups(id, &region_id, &instance_id, security_group_id).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn list_baidu_security_groups(id: i64, region_id: String, instance_id: String, security_group_id: Option<String>) -> PlatformResult<Value> { cloud::baidu::list_security_groups(id, &region_id, &instance_id, security_group_id).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn reboot_instance(id: i64, region_id: String, instance_id: String, force_stop: bool) -> PlatformResult<String> { cloud::aliyun::instance_action(id, region_id, instance_id, "reboot", force_stop).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn start_instance(id: i64, region_id: String, instance_id: String) -> PlatformResult<String> { cloud::aliyun::instance_action(id, region_id, instance_id, "start", false).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn stop_instance(id: i64, region_id: String, instance_id: String) -> PlatformResult<String> { cloud::aliyun::instance_action(id, region_id, instance_id, "stop", false).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn instance_status(id: i64, region_id: String, instance_id: String) -> PlatformResult<String> { cloud::aliyun::instance_status(id, region_id, instance_id).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn cvm_instance_action(id: i64, region_id: String, instance_id: String, action: String, force_stop: bool) -> PlatformResult<String> { cloud::tencent::cvm_instance_action(id, &region_id, &instance_id, &action, force_stop).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn cvm_instance_reboot(id: i64, region_id: String, instance_id: String, force_stop: bool) -> PlatformResult<String> { cloud::tencent::cvm_instance_reboot(id, &region_id, &instance_id, force_stop).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn authorize_tencent_security_group_rule(id: i64, region_id: String, security_group_id: String, ip_protocol: String, port_range: String, source_cidr_ip: String, description: Option<String>, nic_type: Option<String>) -> PlatformResult<String> {
    let _ = nic_type;
    cloud::tencent::authorize_security_group_rule(id, &region_id, &security_group_id, ip_protocol, port_range, source_cidr_ip, description).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn revoke_tencent_security_group_rule(id: i64, region_id: String, security_group_id: String, _ip_protocol: String, _port_range: String, _source_cidr_ip: String, _policy: String, priority: i32, _nic_type: Option<String>) -> PlatformResult<String> { cloud::tencent::revoke_security_group_rule(id, &region_id, &security_group_id, priority).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn authorize_baidu_security_group_rule(id: i64, region_id: String, security_group_id: String, ip_protocol: String, port_range: String, source_cidr_ip: String, description: Option<String>, nic_type: Option<String>, sg_version: Option<i64>) -> PlatformResult<String> {
    let _ = nic_type;
    cloud::baidu::authorize_security_group_rule(id, &region_id, &security_group_id, ip_protocol, port_range, source_cidr_ip, description, sg_version).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn revoke_baidu_security_group_rule(id: i64, region_id: String, security_group_id: String, _ip_protocol: String, _port_range: String, _source_cidr_ip: String, _policy: String, _priority: i32, _nic_type: Option<String>, security_group_rule_id: Option<String>, sg_version: Option<i64>) -> PlatformResult<String> { cloud::baidu::revoke_security_group_rule(id, &region_id, &security_group_id, security_group_rule_id, sg_version).await.map_err(Into::into) }

fn update_cached_server_name(account_id: i64, instance_id: &str, instance_name: &str) -> Result<(), String> { asset_repository::update_server_name(&open_db()?, account_id, instance_id, instance_name) }

#[tauri::command]
pub(crate) async fn rename_server(id: i64, region_id: String, instance_id: String, instance_name: String) -> PlatformResult<String> {
    let instance_name = instance_name.trim().to_string();
    if region_id.trim().is_empty() || instance_id.trim().is_empty() { return Err("缺少服务器地域或实例 ID".into()); }
    if instance_name.is_empty() { return Err("服务器名称不能为空".into()); }
    if instance_name.as_bytes().len() > 128 { return Err("服务器名称不能超过 128 个字节".into()); }
    let request_id = if account_cloud_type(id)? == "tencent" { cloud::tencent::rename_instance(id, &region_id, &instance_id, &instance_name).await? } else { cloud::aliyun::rename_instance(id, &region_id, &instance_id, &instance_name).await? };
    update_cached_server_name(id, &instance_id, &instance_name)?;
    Ok(request_id)
}

#[tauri::command]
pub(crate) async fn swas_instance_action(id: i64, region_id: String, instance_id: String, action: String, force_stop: bool) -> PlatformResult<String> {
    if region_id.is_empty() || instance_id.is_empty() { return Err("缺少轻量服务器地域或实例 ID".into()); }
    let cloud_type = account_cloud_type(id)?;
    let result = if cloud_type == "aliyun" { cloud::aliyun::swas_instance_action(id, &region_id, &instance_id, &action, force_stop).await? } else if cloud_type == "tencent" { cloud::tencent::swas_instance_action(id, &region_id, &instance_id, &action, force_stop).await? } else if cloud_type == "jdcloud" { let action_name = match action.as_str() { "start" => "startInstance", "reboot" => "rebootInstance", "stop" => "stopInstance", _ => return Err("不支持的轻量服务器操作".into()) }; cloud::jdcloud::instance_action(id, &region_id, &instance_id, action_name).await? } else { return Err("当前云类型暂不支持轻量服务器操作".into()); };
    Ok(result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}

fn light_firewall_rule_input(ip_protocol: String, port_range: String, source_cidr_ip: String, description: Option<String>) -> Result<(String, String, String, String), String> {
    let protocol = ip_protocol.trim().to_ascii_lowercase();
    let port_range = port_range.trim().to_string();
    let source_cidr_ip = source_cidr_ip.trim().to_string();
    let parts = port_range.split('/').collect::<Vec<_>>();
    if !matches!(protocol.as_str(), "tcp" | "udp") { return Err("轻量服务器仅支持 TCP 或 UDP 端口规则".into()); }
    if parts.len() != 2 { return Err("端口范围格式无效，请使用 80/80 或 8000/9000".into()); }
    let start = parts[0].parse::<u16>().ok();
    let end = parts[1].parse::<u16>().ok();
    if start.is_none() || end.is_none() || start.unwrap() == 0 || end.unwrap() < start.unwrap() { return Err("端口范围必须在 1 到 65535 之间".into()); }
    if source_cidr_ip.is_empty() || !source_cidr_ip.contains('/') { return Err("来源地址必须是 CIDR，例如 0.0.0.0/0".into()); }
    Ok((protocol, port_range, source_cidr_ip, description.unwrap_or_default().trim().to_string()))
}

#[tauri::command]
pub(crate) async fn list_light_firewall_rules(id: i64, region_id: String, instance_id: String) -> PlatformResult<Value> {
    if region_id.is_empty() || instance_id.is_empty() { return Err("缺少轻量服务器地域或实例 ID".into()); }
    let cloud_type = account_cloud_type(id)?;
    if cloud_type == "aliyun" { return cloud::aliyun::list_light_firewall_rules(id, &region_id, &instance_id).await.map_err(Into::into); }
    if cloud_type == "tencent" { return cloud::tencent::list_light_firewall_rules(id, &region_id, &instance_id).await.map_err(Into::into); }
    if cloud_type == "jdcloud" { return cloud::jdcloud::list_firewall_rules(id, &region_id, &instance_id).await.map_err(Into::into); }
    Err("当前云类型暂不支持轻量服务器防火墙管理".into())
}

#[tauri::command]
pub(crate) async fn create_light_firewall_rule(id: i64, region_id: String, instance_id: String, ip_protocol: String, port_range: String, source_cidr_ip: String, description: Option<String>, firewall_version: Option<i64>) -> PlatformResult<String> {
    if region_id.is_empty() || instance_id.is_empty() { return Err("缺少轻量服务器地域或实例 ID".into()); }
    let (protocol, port_range, source_cidr_ip, description) = light_firewall_rule_input(ip_protocol, port_range, source_cidr_ip, description)?;
    let cloud_type = account_cloud_type(id)?;
    let result = if cloud_type == "aliyun" { cloud::aliyun::create_light_firewall_rule(id, &region_id, &instance_id, &protocol, &port_range, &source_cidr_ip, &description).await? } else if cloud_type == "tencent" { cloud::tencent::create_light_firewall_rule(id, &region_id, &instance_id, &protocol, &port_range, &source_cidr_ip, &description, firewall_version).await? } else if cloud_type == "jdcloud" { cloud::jdcloud::create_firewall_rule(id, &region_id, &instance_id, &protocol, &port_range, &source_cidr_ip, &description).await? } else { return Err("当前云类型暂不支持轻量服务器防火墙管理".into()); };
    Ok(result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}

#[tauri::command]
pub(crate) async fn delete_light_firewall_rule(id: i64, region_id: String, instance_id: String, rule_id: Option<String>, firewall_rule: Option<Value>, firewall_version: Option<i64>) -> PlatformResult<String> {
    if region_id.is_empty() || instance_id.is_empty() { return Err("缺少轻量服务器地域或实例 ID".into()); }
    let cloud_type = account_cloud_type(id)?;
    let result = if cloud_type == "aliyun" { let rule_id = rule_id.filter(|value| !value.trim().is_empty()).ok_or("缺少阿里云防火墙规则 ID")?; cloud::aliyun::delete_light_firewall_rule(id, &region_id, &instance_id, &rule_id).await? } else if cloud_type == "tencent" { let firewall_rule = firewall_rule.filter(Value::is_object).ok_or("缺少腾讯云防火墙规则内容")?; cloud::tencent::delete_light_firewall_rule(id, &region_id, &instance_id, firewall_rule, firewall_version).await? } else if cloud_type == "jdcloud" { let rule_id = rule_id.filter(|value| !value.trim().is_empty()).ok_or("缺少京东云防火墙规则 ID")?; cloud::jdcloud::delete_firewall_rule(id, &region_id, &instance_id, &rule_id).await? } else { return Err("当前云类型暂不支持轻量服务器防火墙管理".into()); };
    Ok(result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}

#[cfg(test)]
mod esa_overview_tests {
    use super::{esa_fields_params, esa_summarized_value, esa_waf_blocked_requests};
    use serde_json::json;

    #[test]
    fn encodes_esa_fields_as_rpc_array_parameters() {
        let params = esa_fields_params(&[("Requests", &["ALL"]), ("Traffic", &["ALL"])]);
        assert_eq!(params.get("Fields.1.FieldName").map(String::as_str), Some("Requests"));
        assert_eq!(params.get("Fields.1.Dimension.1").map(String::as_str), Some("ALL"));
        assert_eq!(params.get("Fields.2.FieldName").map(String::as_str), Some("Traffic"));
        assert!(!params.contains_key("Fields"));
    }

    #[test]
    fn reads_summary_and_counts_only_blocked_waf_requests() {
        let traffic = json!({
            "SummarizedData": [{"FieldName":"Traffic", "Value":"1234"}],
            "Data": [{"FieldName":"Traffic", "DetailData":[{"Value":"1000"}, {"Value":"234"}]}]
        });
        let waf = json!({"SummarizedData": [
            {"FieldName":"Requests", "DimensionName":"Action", "DimensionValue":"block", "Value":"7"},
            {"FieldName":"Requests", "DimensionName":"Action", "DimensionValue":"allow", "Value":"19"}
        ]});
        assert_eq!(esa_summarized_value(&traffic, "Traffic"), 1234.0);
        assert_eq!(esa_waf_blocked_requests(&waf), 7.0);
    }
}
