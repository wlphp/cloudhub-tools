use crate::{account_cloud_type, account_credentials, array_at, rpc_encode, string_params, write_api_log, xml_blocks, xml_text, ResourceResponse};
use crate::core::storage::open_db;
use chrono::Utc;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use std::collections::BTreeMap;

fn baidu_encode(value: &str) -> String { rpc_encode(value) }

fn baidu_canonical_uri(path: &str) -> String {
    let value = path.split('/').map(|part| baidu_encode(part)).collect::<Vec<_>>().join("/");
    if value.is_empty() { "/".into() } else { value }
}

fn baidu_query(query: &BTreeMap<String, String>, include_empty: bool) -> String {
    let mut values = query.iter().filter(|(_, value)| include_empty || !value.is_empty()).map(|(key, value)| (baidu_encode(key), baidu_encode(value))).collect::<Vec<_>>();
    values.sort(); values.into_iter().map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>().join("&")
}

fn baidu_canonical_headers(headers: &[(&str, &str)]) -> String {
    let mut values = headers.iter()
        .map(|(name, value)| (name.to_ascii_lowercase(), value.trim()))
        .filter(|(_, value)| !value.is_empty())
        .map(|(name, value)| format!("{}:{}", baidu_encode(&name), baidu_encode(value)))
        .collect::<Vec<_>>();
    values.sort(); values.join("\n")
}

fn baidu_error_message(message: String) -> String {
    if message.contains("BceServiceRole_console_dns") {
        "DNS 服务未完成控制台服务角色授权。请用主账号登录百度智能云控制台并开通/访问一次智能云解析 DNS，或为当前子用户授予 DNS 只读权限后重试。".into()
    } else { message }
}

const BAIDU_BCC_REGIONS: [&str; 6] = ["bj", "bd", "gz", "su", "hkg", "fwh"];

fn baidu_regions(id: i64) -> Result<Vec<String>, String> {
    let value: Option<String> = open_db()?.query_row("SELECT region_id FROM cloud_accounts WHERE id=?1", [id], |row| row.get(0)).map_err(|error| error.to_string())?;
    let mut regions = value.unwrap_or_else(|| "bj".into()).split(|character: char| character == ',' || character == '，' || character.is_whitespace()).filter(|value| !value.is_empty()).map(String::from).collect::<Vec<_>>();
    if regions.is_empty() { regions.push("bj".into()); }
    // BCC has region-specific endpoints only; include every standard region
    // so a legacy "bj" default cannot cause instances in other regions to vanish.
    for region in BAIDU_BCC_REGIONS { if !regions.iter().any(|value| value == region) { regions.push(region.into()); } }
    Ok(regions)
}

pub(crate) async fn baidu_request_with_options(id: i64, host: &str, path: &str, query: BTreeMap<String, String>, method: &str, body: Option<Value>, include_empty_query: bool) -> Result<(Value, String), String> {
    if account_cloud_type(id)? != "baidu" { return Err("当前账号不是百度智能云账号".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let canonical_uri = baidu_canonical_uri(path); let query_text = baidu_query(&query, include_empty_query);
    let date = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let auth_prefix = format!("bce-auth-v1/{access_key_id}/{date}/1800");
    let body_text = body.map(|value| serde_json::to_string(&value).map_err(|error| format!("BCC 请求体序列化失败: {error}"))).transpose()?;
    let content_length = body_text.as_ref().map(|value| value.len().to_string());
    let mut signed_header_values = vec![("host", host), ("x-bce-date", date.as_str())];
    if body_text.is_some() { signed_header_values.push(("content-type", "application/json")); signed_header_values.push(("content-length", content_length.as_deref().unwrap_or("0"))); }
    let canonical_headers = baidu_canonical_headers(&signed_header_values);
    let mut signed_header_names = signed_header_values.iter().map(|(name, _)| name.to_ascii_lowercase()).collect::<Vec<_>>(); signed_header_names.sort();
    let signed_headers = signed_header_names.join(";");
    let canonical_request = format!("{method}\n{canonical_uri}\n{query_text}\n{canonical_headers}");
    let mut key_mac: Hmac<Sha256> = <Hmac<Sha256> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|error| error.to_string())?;
    // BCE v1 signs the request with the hexadecimal text of the derived HMAC key.
    key_mac.update(auth_prefix.as_bytes()); let signing_key = hex::encode(key_mac.finalize().into_bytes());
    let mut signature_mac: Hmac<Sha256> = <Hmac<Sha256> as Mac>::new_from_slice(signing_key.as_bytes()).map_err(|error| error.to_string())?;
    signature_mac.update(canonical_request.as_bytes());
    let authorization = format!("{auth_prefix}/{signed_headers}/{}", hex::encode(signature_mac.finalize().into_bytes()));
    let url = format!("https://{host}{canonical_uri}{}", if query_text.is_empty() { String::new() } else { format!("?{query_text}") });
    let client = reqwest::Client::new();
    let mut request = match method { "PUT" => client.put(url), "POST" => client.post(url), "DELETE" => client.delete(url), _ => client.get(url) }
        .header("Host", host).header("X-Bce-Date", &date).header("Authorization", authorization).timeout(std::time::Duration::from_secs(30));
    if let Some(body) = body_text { request = request.header("Content-Type", "application/json").header("Content-Length", content_length.unwrap_or_default()).body(body); }
    let response = request.send().await.map_err(|error| format!("百度智能云请求失败: {error}"))?;
    let status = response.status(); let body = response.text().await.map_err(|error| format!("百度智能云返回读取失败: {error}"))?;
    let data: Value = serde_json::from_str(&body).unwrap_or_else(|_| json!({"message": body}));
    if !status.is_success() { let message = baidu_error_message(data.get("message").or_else(|| data.pointer("/error/message")).or_else(|| data.get("code")).and_then(Value::as_str).unwrap_or(&format!("百度智能云 {status}")).to_string()); write_api_log(&access_key_id, host, &format!("{method} {path}"), &json!(query), Some(&data), "失败", Some(&message)); return Err(message); }
    write_api_log(&access_key_id, host, &format!("{method} {path}"), &json!(query), Some(&data), "成功", None); Ok((data, body))
}

pub(crate) async fn baidu_request(id: i64, host: &str, path: &str, query: BTreeMap<String, String>) -> Result<(Value, String), String> {
    baidu_request_with_options(id, host, path, query, "GET", None, false).await
}

#[tauri::command]
pub(crate) async fn instance_action(id: i64, region_id: String, instance_id: String, action: String, force_stop: bool) -> Result<Value, String> {
    if account_cloud_type(id)? != "baidu" { return Err("当前账号不是百度智能云账号".into()); }
    if region_id.trim().is_empty() || instance_id.trim().is_empty() { return Err("缺少服务器地域或实例 ID".into()); }
    let host = format!("bcc.{region_id}.baidubce.com"); let path = format!("/v2/instance/{instance_id}");
    if action == "status" {
        let (data, _) = baidu_request(id, &host, &path, BTreeMap::new()).await?;
        let instance = data.get("instance").unwrap_or(&data);
        return Ok(json!({"status": instance.get("status").and_then(Value::as_str).unwrap_or("Unknown")}));
    }
    if !["start", "stop", "reboot"].contains(&action.as_str()) { return Err("不支持的 BCC 服务器操作".into()); }
    let mut query = BTreeMap::new(); query.insert(action.clone(), String::new());
    let body = if force_stop && (action == "stop" || action == "reboot") { Some(json!({"forceStop": true})) } else { None };
    let (data, _) = baidu_request_with_options(id, &host, &path, query, "PUT", body, true).await?;
    Ok(data)
}

async fn baidu_pages(id: i64, host: &str, path: &str, keys: &[&str]) -> Result<Vec<Value>, String> {
    let mut items = Vec::new(); let mut marker = String::new();
    for _ in 0..100 {
        let (data, _) = baidu_request(id, host, path, string_params(&[("marker", marker.clone()), ("maxKeys", "1000".into())])).await?;
        let page = keys.iter().flat_map(|key| array_at(&data, &[*key]).into_iter().cloned()).collect::<Vec<_>>();
        items.extend(page.iter().cloned());
        let next_marker = data.get("nextMarker").or_else(|| data.get("NextMarker")).and_then(Value::as_str).unwrap_or("").to_string();
        if next_marker.is_empty() || next_marker == marker || data.get("isTruncated").and_then(Value::as_bool) == Some(false) || data.get("IsTruncated").and_then(Value::as_bool) == Some(false) { return Ok(items); }
        marker = next_marker;
    }
    Err("分页超过 100 页，已停止读取".into())
}

fn baidu_instance(item: &Value, region: &str) -> Value {
    let public_ip = item.get("publicIps").or_else(|| item.get("publicIp")).and_then(Value::as_array).and_then(|values| values.first()).cloned().or_else(|| item.get("publicIp").cloned()).unwrap_or(json!(""));
    let private_ip = item.get("internalIps").or_else(|| item.get("privateIps")).and_then(Value::as_array).and_then(|values| values.first()).cloned().or_else(|| item.get("internalIp").cloned()).unwrap_or(json!(""));
    json!({"InstanceId": item.get("id").or_else(|| item.get("instanceId")), "InstanceName": item.get("name").or_else(|| item.get("instanceName")).or_else(|| item.get("id")), "InstanceStatus": item.get("status"), "Status": item.get("status"), "PublicIpAddress": public_ip, "PrivateIpAddress": private_ip, "InstanceType": item.get("spec"), "VpcId": item.get("vpcId"), "_region_id": region, "_raw": item})
}

fn baidu_rds(item: &Value, region: &str) -> Value {
    json!({"DBInstanceId": item.get("instanceId").or_else(|| item.get("id")), "DBInstanceDescription": item.get("instanceName").or_else(|| item.get("name")).or_else(|| item.get("instanceId")), "DBInstanceStatus": item.get("status"), "DBInstanceClass": item.get("instanceClass").or_else(|| item.get("instanceType")), "DBInstanceStorage": item.get("volumeCapacity").or_else(|| item.get("capacity")).unwrap_or(&json!(0)), "ConnectionString": item.get("endpoint").or_else(|| item.get("vip")), "Port": item.get("port"), "Engine": item.get("engine").or_else(|| item.get("engineType")), "EngineVersion": item.get("engineVersion"), "CreateTime": item.get("createTime"), "_region_id": region, "_raw": item})
}

fn baidu_redis(item: &Value, region: &str) -> Value {
    json!({"InstanceId": item.get("instanceId").or_else(|| item.get("id")), "InstanceName": item.get("instanceName").or_else(|| item.get("name")).or_else(|| item.get("instanceId")), "InstanceStatus": item.get("instanceStatus").or_else(|| item.get("status")), "InstanceType": item.get("engine").unwrap_or(&json!("Redis")), "InstanceClass": item.get("instanceClass").or_else(|| item.get("nodeType")), "Capacity": item.get("capacity").or_else(|| item.get("memorySize")).unwrap_or(&json!(0)), "ConnectionDomain": item.get("domain").or_else(|| item.get("endpoint")).or_else(|| item.get("vip")), "Port": item.get("port"), "EngineVersion": item.get("engineVersion"), "NetworkType": item.get("vnetIp").or_else(|| item.get("vpcId")), "CreateTime": item.get("instanceCreateTime"), "_region_id": region, "_raw": item})
}

fn baidu_zone(item: &Value) -> Value {
    json!({"DomainName": item.get("domain").or_else(|| item.get("name")).or_else(|| item.get("zoneName")), "DomainStatus": item.get("status").unwrap_or(&json!("ACTIVE")), "ZoneId": item.get("id").or_else(|| item.get("domainId")).or_else(|| item.get("domain")), "RecordCount": item.get("recordCount").or_else(|| item.get("recordNum")).unwrap_or(&json!(0)), "RegistrationDate": item.get("createTime"), "_region_id": "global", "_baidu_public_zone": true, "_raw": item})
}

fn baidu_bucket(item: &Value) -> Value {
    let name = item.get("name").or_else(|| item.get("bucketName")).and_then(Value::as_str).unwrap_or(""); let region = item.get("location").or_else(|| item.get("region")).and_then(Value::as_str).unwrap_or("bj");
    json!({"Name": name, "BucketName": name, "Location": region, "CreationDate": item.get("creationDate").or_else(|| item.get("createTime")), "StorageClass": item.get("storageClass").unwrap_or(&json!("STANDARD")), "Acl": item.get("acl").unwrap_or(&json!("private")), "ExtranetEndpoint": if name.is_empty() { "-".to_string() } else { format!("{name}.{region}.bcebos.com") }, "IntranetEndpoint": "-", "_region_id": region, "_raw": item})
}

pub(crate) async fn resource_items(id: i64, resource_type: &str) -> ResourceResponse {
    let now = Utc::now().timestamp_millis(); let regions = match baidu_regions(id) { Ok(value) => value, Err(error) => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![error], fetched_at: now } }; let mut items = Vec::new(); let mut errors = Vec::new();
    if resource_type == "domain" {
        match baidu_pages(id, "dns.baidubce.com", "/v1/dns/zone", &["zones"]).await { Ok(values) => items.extend(values.into_iter().map(|item| baidu_zone(&item))), Err(error) => errors.push(error), }
        return ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now };
    }
    if resource_type == "oss" {
        match baidu_request(id, "bj.bcebos.com", "/", BTreeMap::new()).await {
            Ok((data, body)) => { let values = if array_at(&data, &["buckets"]).is_empty() { xml_blocks(&body, "Bucket").into_iter().map(|block| json!({"name": xml_text(&block, "Name"), "location": xml_text(&block, "Location"), "creationDate": xml_text(&block, "CreationDate")})).collect::<Vec<_>>() } else { array_at(&data, &["buckets"]).into_iter().cloned().collect::<Vec<_>>() }; items.extend(values.into_iter().map(|item| baidu_bucket(&item)).filter(|item| item.get("Name").and_then(Value::as_str).is_some_and(|value| !value.is_empty()))); }
            Err(error) => errors.push(error),
        }
        return ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now };
    }
    let service = match resource_type { "ecs" => Some(("bcc", "/v2/instance", vec!["instances", "instanceList"])), "rds" => Some(("rds", "/v1/instance", vec!["instances", "instanceList"])), "redis" => Some(("redis", "/v2/instance", vec!["instances", "instanceList"])), _ => None };
    let Some((service_name, path, keys)) = service else { return ResourceResponse { resource_type: resource_type.into(), items, errors: vec![format!("百度智能云暂未接入 {resource_type} 资源")], fetched_at: now }; };
    for region in regions { match baidu_pages(id, &format!("{service_name}.{region}.baidubce.com"), path, &keys).await { Ok(values) => for item in values { items.push(match resource_type { "ecs" => baidu_instance(&item, &region), "rds" => baidu_rds(&item, &region), "redis" => baidu_redis(&item, &region), _ => item }); }, Err(error) => errors.push(format!("{region}: {error}")), } }
    ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now }
}

#[tauri::command]
pub(crate) async fn verify_baidu_account(id: i64) -> Result<Value, String> {
    if account_cloud_type(id)? != "baidu" { return Err("当前账号不是百度智能云账号".into()); }
    let regions = baidu_regions(id)?; let first = regions.first().cloned().unwrap_or_else(|| "bj".into());
    baidu_pages(id, &format!("bcc.{first}.baidubce.com"), "/v2/instance", &["instances", "instanceList"]).await?;
    Ok(json!({"provider": "baidu", "verified": true, "region_count": regions.len(), "regions": regions, "default_region": first}))
}

