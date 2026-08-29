use crate::{account_cloud_type, account_credentials, aliyun_rpc, array_at, display_json, ensure_aliyun_account, string_params, tencent_request};
use serde_json::{json, Value};

#[tauri::command]
pub(crate) async fn list_dns_records(id: i64, domain: String, record_type: Option<String>, keyword: Option<String>) -> Result<Value, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    if account_cloud_type(id)? == "tencent" {
        let mut payload = serde_json::Map::new();
        payload.insert("Domain".into(), json!(domain));
        if let Some(value) = record_type.filter(|value| !value.is_empty()) { payload.insert("RecordType".into(), json!(value)); }
        if let Some(value) = keyword.filter(|value| !value.is_empty()) { payload.insert("Value".into(), json!(value)); }
        let result = tencent_request("dnspod", "2021-03-23", "DescribeRecordList", Value::Object(payload), None, &access_key_id, &access_key_secret).await?;
        let items = array_at(&result, &["RecordList"]).into_iter().map(|item| json!({
            "RecordId": item.get("RecordId").cloned().unwrap_or(json!("")), "Type": item.get("Type").cloned().unwrap_or(json!("")),
            "RR": item.get("Name").or_else(|| item.get("RR")).cloned().unwrap_or(json!("")), "Value": item.get("Value").cloned().unwrap_or(json!("")),
            "TTL": item.get("TTL").cloned().unwrap_or(json!("")), "MX": item.get("MX").cloned().unwrap_or(json!("")),
            "Line": item.get("Line").cloned().unwrap_or(json!("")), "Status": item.get("Status").cloned().unwrap_or(json!("")),
        })).collect::<Vec<_>>();
        return Ok(json!({"items": items, "total": result.pointer("/RecordCountInfo/TotalCount").cloned().or_else(|| result.get("TotalCount").cloned()).unwrap_or(json!(0))}));
    }
    if account_cloud_type(id)? == "ctyun" {
        let zones = crate::cloud::ctyun::resource_items(id, "domain", &access_key_id, &access_key_secret).await;
        let zone = zones.items.iter().find(|item| item.get("DomainName").and_then(Value::as_str).is_some_and(|name| name.eq_ignore_ascii_case(&domain)));
        let Some(zone_id) = zone.and_then(|item| item.get("ZoneId")).and_then(Value::as_str).filter(|value| !value.is_empty()) else { return Ok(json!({"items": [], "total": 0})); };
        let region = zone.and_then(|item| item.get("_region_id")).and_then(Value::as_str).unwrap_or("cn-huabei-9");
        let result = crate::cloud::ctyun::list_private_zone_records(id, region, zone_id, keyword.as_deref()).await?;
        let expected_type = record_type.unwrap_or_default();
        let items = array_at(&result, &["zoneRecords"]).into_iter().filter(|item| expected_type.is_empty() || item.get("type").and_then(Value::as_str).is_some_and(|value| value.eq_ignore_ascii_case(&expected_type))).map(|item| json!({
            "RecordId": item.get("zoneRecordID").cloned().unwrap_or(json!("")), "Type": item.get("type").cloned().unwrap_or(json!("")), "RR": item.get("name").cloned().unwrap_or(json!("@")),
            "Value": item.get("value").map(|value| if let Value::Array(values) = value { values.iter().map(display_json).collect::<Vec<_>>().join(", ") } else { display_json(value) }).unwrap_or_default(),
            "TTL": item.get("TTL").cloned().unwrap_or(json!(0)), "Priority": "", "Line": "默认", "Status": "ENABLE",
        })).collect::<Vec<_>>();
        let total = result.get("totalCount").cloned().unwrap_or(json!(items.len()));
        return Ok(json!({"items": items, "total": total}));
    }
    ensure_aliyun_account(id)?;
    let mut entries = vec![("DomainName", domain), ("PageNumber", "1".into()), ("PageSize", "500".into())];
    if let Some(value) = record_type.filter(|value| !value.is_empty()) { entries.push(("TypeKeyWord", value)); }
    if let Some(value) = keyword.filter(|value| !value.is_empty()) { entries.push(("RRKeyWord", value)); }
    let result = aliyun_rpc("alidns.aliyuncs.com", "2015-01-09", "DescribeDomainRecords", string_params(&entries), &access_key_id, &access_key_secret).await?;
    Ok(json!({"items": array_at(&result, &["DomainRecords", "Record"]).into_iter().cloned().collect::<Vec<_>>(), "total": result.get("TotalCount").cloned().unwrap_or(json!(0))}))
}

#[tauri::command]
pub(crate) async fn add_dns_record(id: i64, domain: String, record_type: String, rr: String, value: String, ttl: Option<i64>, priority: Option<i64>, line: Option<String>) -> Result<Value, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let mut entries = vec![("DomainName", domain), ("RR", rr), ("Type", record_type.clone()), ("Value", value), ("TTL", ttl.unwrap_or(600).to_string()), ("Line", line.unwrap_or_else(|| "default".into()))];
    if record_type == "MX" { entries.push(("Priority", priority.unwrap_or(10).to_string())); }
    aliyun_rpc("alidns.aliyuncs.com", "2015-01-09", "AddDomainRecord", string_params(&entries), &access_key_id, &access_key_secret).await
}

#[tauri::command]
pub(crate) async fn update_dns_record(id: i64, record_id: String, record_type: String, rr: String, value: String, ttl: Option<i64>, priority: Option<i64>, line: Option<String>) -> Result<Value, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let mut entries = vec![("RecordId", record_id), ("RR", rr), ("Type", record_type.clone()), ("Value", value), ("TTL", ttl.unwrap_or(600).to_string()), ("Line", line.unwrap_or_else(|| "default".into()))];
    if record_type == "MX" { entries.push(("Priority", priority.unwrap_or(10).to_string())); }
    aliyun_rpc("alidns.aliyuncs.com", "2015-01-09", "UpdateDomainRecord", string_params(&entries), &access_key_id, &access_key_secret).await
}

#[tauri::command]
pub(crate) async fn delete_dns_record(id: i64, record_id: String) -> Result<Value, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    aliyun_rpc("alidns.aliyuncs.com", "2015-01-09", "DeleteDomainRecord", string_params(&[("RecordId", record_id)]), &access_key_id, &access_key_secret).await
}

#[tauri::command]
pub(crate) async fn toggle_dns_record(id: i64, record_id: String, status: String) -> Result<Value, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    aliyun_rpc("alidns.aliyuncs.com", "2015-01-09", "SetDomainRecordStatus", string_params(&[("RecordId", record_id), ("Status", status)]), &access_key_id, &access_key_secret).await
}

#[tauri::command]
pub(crate) async fn list_domain_logs(id: i64, domain: String, start_date: Option<String>, end_date: Option<String>, keyword: Option<String>) -> Result<Value, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let mut entries = vec![("DomainName", domain), ("PageNumber", "1".into()), ("PageSize", "100".into())];
    if let Some(value) = start_date.filter(|value| !value.is_empty()) { entries.push(("StartDate", value)); }
    if let Some(value) = end_date.filter(|value| !value.is_empty()) { entries.push(("EndDate", value)); }
    if let Some(value) = keyword.filter(|value| !value.is_empty()) { entries.push(("KeyWord", value)); }
    let result = aliyun_rpc("alidns.aliyuncs.com", "2015-01-09", "DescribeRecordLogs", string_params(&entries), &access_key_id, &access_key_secret).await?;
    Ok(json!({"items": array_at(&result, &["RecordLogs", "RecordLog"]).into_iter().cloned().collect::<Vec<_>>(), "total": result.get("TotalCount").cloned().unwrap_or(json!(0))}))
}

#[tauri::command]
pub(crate) async fn query_whois(id: i64, domain: String) -> Result<String, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let result = aliyun_rpc("domain.aliyuncs.com", "2018-01-29", "QueryDomainByDomainName", string_params(&[("DomainName", domain)]), &access_key_id, &access_key_secret).await?;
    let get = |key: &str| result.get(key).map(display_json).unwrap_or_else(|| "-".into());
    Ok(format!("域名信息查询结果\n=====================================\n\n域名: {}\n域名持有者: {}\n持有者类型: {}\n联系人: {}\n联系邮箱: {}\n\n注册时间: {}\n到期时间: {}\n注册商: 阿里云\n\n实名认证: {}\n域名状态: {}\nDNS服务器: {}", get("DomainName"), result.get("ZhRegistrantOrganization").or_else(|| result.get("RegistrantOrganization")).map(display_json).unwrap_or_else(|| "-".into()), get("RegistrantType"), result.get("ZhRegistrantName").or_else(|| result.get("RegistrantName")).map(display_json).unwrap_or_else(|| "-".into()), get("Email"), get("RegistrationDate"), get("ExpirationDate"), get("RealNameStatus"), get("DomainStatus"), result.get("DnsList").map(display_json).unwrap_or_else(|| "-".into())))
}
