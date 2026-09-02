use serde_json::{json, Value};
use std::collections::BTreeMap;
use chrono::Utc;
use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::ResourceResponse;

const REGIONS: [&str; 6] = ["bj", "bd", "gz", "su", "hkg", "fwh"];

fn canonical_uri(path: &str) -> String { let value = path.split('/').map(crate::rpc_encode).collect::<Vec<_>>().join("/"); if value.is_empty() { "/".into() } else { value } }
fn canonical_query(query: &BTreeMap<String, String>, include_empty: bool) -> String { let mut values = query.iter().filter(|(_, value)| include_empty || !value.is_empty()).map(|(key, value)| (crate::rpc_encode(key), crate::rpc_encode(value))).collect::<Vec<_>>(); values.sort(); values.into_iter().map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>().join("&") }
fn canonical_headers(headers: &[(&str, &str)]) -> String { let mut values = headers.iter().map(|(name, value)| (name.to_ascii_lowercase(), value.trim())).filter(|(_, value)| !value.is_empty()).map(|(name, value)| format!("{}:{}", crate::rpc_encode(&name), crate::rpc_encode(value))).collect::<Vec<_>>(); values.sort(); values.join("\n") }
fn error_message(message: String) -> String { if message.contains("BceServiceRole_console_dns") { "DNS 服务未完成控制台服务角色授权。请用主账号登录百度智能云控制台并开通/访问一次智能云解析 DNS，或为当前子用户授予 DNS 只读权限后重试。".into() } else { message } }
async fn request_with_options(id: i64, host: &str, path: &str, query: BTreeMap<String, String>, method: &str, body: Option<Value>, include_empty: bool) -> Result<(Value, String), String> {
    if crate::account_cloud_type(id)? != "baidu" { return Err("当前账号不是百度智能云账号".into()); }
    let (access_key_id, access_key_secret) = crate::account_credentials(id)?;
    let uri = canonical_uri(path); let query_text = canonical_query(&query, include_empty); let date = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(); let auth_prefix = format!("bce-auth-v1/{access_key_id}/{date}/1800");
    let body_text = body.map(|value| serde_json::to_string(&value).map_err(|error| format!("BCC 请求体序列化失败: {error}"))).transpose()?;
    let content_length = body_text.as_ref().map(|value| value.len().to_string()); let mut signed_values = vec![("host", host), ("x-bce-date", date.as_str())];
    if body_text.is_some() { signed_values.push(("content-type", "application/json")); signed_values.push(("content-length", content_length.as_deref().unwrap_or("0"))); }
    let headers = canonical_headers(&signed_values); let mut signed_names = signed_values.iter().map(|(name, _)| (*name).to_string()).collect::<Vec<_>>(); signed_names.sort(); let signed = signed_names.join(";");
    let canonical = format!("{method}\n{uri}\n{query_text}\n{headers}"); let mut key_mac: Hmac<Sha256> = <Hmac<Sha256> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|error| error.to_string())?; key_mac.update(auth_prefix.as_bytes()); let signing_key = hex::encode(key_mac.finalize().into_bytes()); let mut signature_mac: Hmac<Sha256> = <Hmac<Sha256> as Mac>::new_from_slice(signing_key.as_bytes()).map_err(|error| error.to_string())?; signature_mac.update(canonical.as_bytes()); let authorization = format!("{auth_prefix}/{signed}/{}", hex::encode(signature_mac.finalize().into_bytes()));
    let url = format!("https://{host}{uri}{}", if query_text.is_empty() { String::new() } else { format!("?{query_text}") }); let client = reqwest::Client::new(); let mut request = match method { "PUT" => client.put(url), "POST" => client.post(url), "DELETE" => client.delete(url), _ => client.get(url) }.header("Host", host).header("X-Bce-Date", &date).header("Authorization", authorization).timeout(std::time::Duration::from_secs(30));
    if let Some(body) = body_text { request = request.header("Content-Type", "application/json").header("Content-Length", content_length.unwrap_or_default()).body(body); }
    let response = request.send().await.map_err(|error| format!("百度智能云请求失败: {error}"))?; let status = response.status(); let response_body = response.text().await.map_err(|error| format!("百度智能云返回读取失败: {error}"))?; let data: Value = serde_json::from_str(&response_body).unwrap_or_else(|_| json!({"message": response_body}));
    if !status.is_success() { let message = error_message(data.get("message").or_else(|| data.pointer("/error/message")).or_else(|| data.get("code")).and_then(Value::as_str).unwrap_or(&format!("百度智能云 {status}")).to_string()); crate::write_api_log(&access_key_id, host, &format!("{method} {path}"), &json!(query), Some(&data), "失败", Some(&message)); return Err(message); }
    crate::write_api_log(&access_key_id, host, &format!("{method} {path}"), &json!(query), Some(&data), "成功", None); Ok((data, response_body))
}

async fn request(id: i64, host: &str, path: &str, query: BTreeMap<String, String>) -> Result<(Value, String), String> { request_with_options(id, host, path, query, "GET", None, false).await }
async fn pages(id: i64, host: &str, path: &str, keys: &[&str]) -> Result<Vec<Value>, String> { let mut items = Vec::new(); let mut marker = String::new(); for _ in 0..100 { let (data, _) = request(id, host, path, crate::string_params(&[("marker", marker.clone()), ("maxKeys", "1000".into())])).await?; items.extend(keys.iter().flat_map(|key| crate::array_at(&data, &[*key]).into_iter().cloned())); let next = data.get("nextMarker").or_else(|| data.get("NextMarker")).and_then(Value::as_str).unwrap_or("").to_string(); if next.is_empty() || next == marker || data.get("isTruncated").and_then(Value::as_bool) == Some(false) || data.get("IsTruncated").and_then(Value::as_bool) == Some(false) { return Ok(items); } marker = next; } Err("分页超过 100 页，已停止读取".into()) }

fn regions(id: i64) -> Result<Vec<String>, String> {
    let value = crate::account_repository::region_id(&crate::open_db()?, id)?;
    let mut values = value.unwrap_or_else(|| "bj".into()).split(|c: char| c == ',' || c == '，' || c.is_whitespace()).filter(|v| !v.is_empty()).map(String::from).collect::<Vec<_>>();
    if values.is_empty() { values.push("bj".into()); }
    for region in REGIONS { if !values.iter().any(|value| value == region) { values.push(region.into()); } }
    Ok(values)
}

fn instance(item: &Value, region: &str) -> Value {
    let public = item.get("publicIps").or_else(|| item.get("publicIp")).and_then(Value::as_array).and_then(|v| v.first()).cloned().or_else(|| item.get("publicIp").cloned()).unwrap_or(json!(""));
    let private = item.get("internalIps").or_else(|| item.get("privateIps")).and_then(Value::as_array).and_then(|v| v.first()).cloned().or_else(|| item.get("internalIp").cloned()).unwrap_or(json!(""));
    json!({"InstanceId": item.get("id").or_else(|| item.get("instanceId")), "InstanceName": item.get("name").or_else(|| item.get("instanceName")).or_else(|| item.get("id")), "InstanceStatus": item.get("status"), "Status": item.get("status"), "PublicIpAddress": public, "PrivateIpAddress": private, "InstanceType": item.get("spec"), "VpcId": item.get("vpcId"), "_region_id": region, "_raw": item})
}
fn rds(item: &Value, region: &str) -> Value { json!({"DBInstanceId": item.get("instanceId").or_else(|| item.get("id")), "DBInstanceDescription": item.get("instanceName").or_else(|| item.get("name")).or_else(|| item.get("instanceId")), "DBInstanceStatus": item.get("status"), "DBInstanceClass": item.get("instanceClass").or_else(|| item.get("instanceType")), "DBInstanceStorage": item.get("volumeCapacity").or_else(|| item.get("capacity")).unwrap_or(&json!(0)), "ConnectionString": item.get("endpoint").or_else(|| item.get("vip")), "Port": item.get("port"), "Engine": item.get("engine").or_else(|| item.get("engineType")), "EngineVersion": item.get("engineVersion"), "CreateTime": item.get("createTime"), "_region_id": region, "_raw": item}) }
fn redis(item: &Value, region: &str) -> Value { json!({"InstanceId": item.get("instanceId").or_else(|| item.get("id")), "InstanceName": item.get("instanceName").or_else(|| item.get("name")).or_else(|| item.get("instanceId")), "InstanceStatus": item.get("instanceStatus").or_else(|| item.get("status")), "InstanceType": item.get("engine").unwrap_or(&json!("Redis")), "InstanceClass": item.get("instanceClass").or_else(|| item.get("nodeType")), "Capacity": item.get("capacity").or_else(|| item.get("memorySize")).unwrap_or(&json!(0)), "ConnectionDomain": item.get("domain").or_else(|| item.get("endpoint")).or_else(|| item.get("vip")), "Port": item.get("port"), "EngineVersion": item.get("engineVersion"), "NetworkType": item.get("vnetIp").or_else(|| item.get("vpcId")), "CreateTime": item.get("instanceCreateTime"), "_region_id": region, "_raw": item}) }
fn zone(item: &Value) -> Value { json!({"DomainName": item.get("domain").or_else(|| item.get("name")).or_else(|| item.get("zoneName")), "DomainStatus": item.get("status").unwrap_or(&json!("ACTIVE")), "ZoneId": item.get("id").or_else(|| item.get("domainId")).or_else(|| item.get("domain")), "RecordCount": item.get("recordCount").or_else(|| item.get("recordNum")).unwrap_or(&json!(0)), "RegistrationDate": item.get("createTime"), "_region_id": "global", "_baidu_public_zone": true, "_raw": item}) }
fn bucket(item: &Value) -> Value { let name = item.get("name").or_else(|| item.get("bucketName")).and_then(Value::as_str).unwrap_or(""); let region = item.get("location").or_else(|| item.get("region")).and_then(Value::as_str).unwrap_or("bj"); json!({"Name": name, "BucketName": name, "Location": region, "CreationDate": item.get("creationDate").or_else(|| item.get("createTime")), "StorageClass": item.get("storageClass").unwrap_or(&json!("STANDARD")), "Acl": item.get("acl").unwrap_or(&json!("private")), "ExtranetEndpoint": if name.is_empty() { "-".into() } else { format!("{name}.{region}.bcebos.com") }, "IntranetEndpoint": "-", "_region_id": region, "_raw": item}) }

pub(crate) async fn resource_items(id: i64, resource_type: &str) -> ResourceResponse {
    let now = Utc::now().timestamp_millis(); let regions = match regions(id) { Ok(v) => v, Err(e) => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![e], fetched_at: now } }; let mut items = Vec::new(); let mut errors = Vec::new();
    if resource_type == "domain" { match pages(id, "dns.baidubce.com", "/v1/dns/zone", &["zones"]).await { Ok(v) => items.extend(v.into_iter().map(|item| zone(&item))), Err(e) => errors.push(e) }; return ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now }; }
    if resource_type == "oss" { match request(id, "bj.bcebos.com", "/", BTreeMap::new()).await { Ok((data, body)) => { let values = if crate::array_at(&data, &["buckets"]).is_empty() { crate::xml_blocks(&body, "Bucket").into_iter().map(|block| json!({"name": crate::xml_text(&block, "Name"), "location": crate::xml_text(&block, "Location"), "creationDate": crate::xml_text(&block, "CreationDate")})).collect::<Vec<_>>() } else { crate::array_at(&data, &["buckets"]).into_iter().cloned().collect() }; items.extend(values.into_iter().map(|item| bucket(&item)).filter(|item| item.get("Name").and_then(Value::as_str).is_some_and(|v| !v.is_empty()))); }, Err(e) => errors.push(e) }; return ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now }; }
    let service = match resource_type { "ecs" => Some(("bcc", "/v2/instance", vec!["instances", "instanceList"])), "rds" => Some(("rds", "/v1/instance", vec!["instances", "instanceList"])), "redis" => Some(("redis", "/v2/instance", vec!["instances", "instanceList"])), _ => None };
    let Some((service, path, keys)) = service else { return ResourceResponse { resource_type: resource_type.into(), items, errors: vec![format!("百度智能云暂未接入 {resource_type} 资源")], fetched_at: now }; };
    for region in regions { match pages(id, &format!("{service}.{region}.baidubce.com"), path, &keys).await { Ok(values) => for item in values { items.push(match resource_type { "ecs" => instance(&item, &region), "rds" => rds(&item, &region), "redis" => redis(&item, &region), _ => item }); }, Err(e) => errors.push(format!("{region}: {e}")) } }
    ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now }
}

#[tauri::command]
pub(crate) async fn verify_baidu_account(id: i64) -> Result<Value, String> { verify_account(id).await }

pub(crate) async fn verify_account(id: i64) -> Result<Value, String> { let regions = regions(id)?; let first = regions.first().cloned().unwrap_or_else(|| "bj".into()); pages(id, &format!("bcc.{first}.baidubce.com"), "/v2/instance", &["instances", "instanceList"]).await?; Ok(json!({"provider":"baidu","verified":true,"region_count":regions.len(),"regions":regions,"default_region":first})) }

pub(crate) async fn instance_action(id: i64, region_id: &str, instance_id: &str, action: &str, force_stop: bool) -> Result<Value, String> {
    if region_id.trim().is_empty() || instance_id.trim().is_empty() { return Err("缺少服务器地域或实例 ID".into()); }
    let host = format!("bcc.{region_id}.baidubce.com"); let path = format!("/v2/instance/{instance_id}");
    if action == "status" { let (data, _) = request(id, &host, &path, BTreeMap::new()).await?; let instance = data.get("instance").unwrap_or(&data); return Ok(json!({"status": instance.get("status").and_then(Value::as_str).unwrap_or("Unknown")})); }
    if !["start", "stop", "reboot"].contains(&action) { return Err("不支持的 BCC 服务器操作".into()); }
    let mut query = BTreeMap::new(); query.insert(action.to_string(), String::new()); let body = if force_stop && (action == "stop" || action == "reboot") { Some(json!({"forceStop": true})) } else { None };
    let (data, _) = request_with_options(id, &host, &path, query, "PUT", body, true).await?; Ok(data)
}

fn security_group_rule_input(ip_protocol: String, port_range: String, source_cidr_ip: String, description: Option<String>) -> Result<Value, String> {
    let protocol = ip_protocol.trim().to_ascii_lowercase(); let port_range = port_range.trim(); let source_ip = source_cidr_ip.trim();
    let Some((start, end)) = port_range.split_once('/') else { return Err("端口范围格式无效，请使用 80/80 或 8000/9000".into()); };
    let Ok(start) = start.parse::<u16>() else { return Err("端口范围格式无效，请使用 80/80 或 8000/9000".into()); }; let Ok(end) = end.parse::<u16>() else { return Err("端口范围格式无效，请使用 80/80 或 8000/9000".into()); };
    if !matches!(protocol.as_str(), "tcp" | "udp") { return Err("百度云安全组端口仅支持 TCP 或 UDP".into()); }
    if start == 0 || end < start { return Err("端口范围必须在 1 到 65535 之间".into()); }
    if source_ip.is_empty() || !source_ip.contains('/') { return Err("来源地址必须是 CIDR，例如 0.0.0.0/0".into()); }
    let mut rule = json!({"direction":"ingress","ethertype":"IPv4","portRange":format!("{start}-{end}"),"protocol":protocol,"sourceIp":source_ip});
    if let Some(description) = description.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) { rule["remark"] = json!(description); }
    Ok(rule)
}

fn security_group_port(port_range: &str) -> String { let value = port_range.trim(); if value.is_empty() { return "-1/-1".into(); } if let Some((start, end)) = value.split_once('-') { format!("{start}/{end}") } else { format!("{value}/{value}") } }

pub(crate) async fn list_security_groups(id: i64, region_id: &str, instance_id: &str, security_group_id: Option<String>) -> Result<Value, String> {
    if region_id.trim().is_empty() || instance_id.trim().is_empty() { return Err("缺少服务器地域或实例 ID".into()); }
    let host = format!("bcc.{region_id}.baidubce.com"); let (result, _) = request(id, &host, "/v2/securityGroup", crate::string_params(&[("instanceId", instance_id.to_string()), ("maxKeys", "1000".into())])).await?;
    let groups = crate::array_at(&result, &["securityGroups"]).into_iter().map(|group| json!({"SecurityGroupId":group.get("id").cloned().unwrap_or(json!("")),"SecurityGroupName":group.get("name").cloned().unwrap_or(json!("")),"Description":group.get("desc").cloned().unwrap_or(json!("")),"VpcId":group.get("vpcId").cloned().unwrap_or(json!("")),"NicType":""})).collect::<Vec<_>>();
    let selected = security_group_id.filter(|value| groups.iter().any(|group| group.get("SecurityGroupId").and_then(Value::as_str) == Some(value.as_str()))).or_else(|| groups.first().and_then(|group| group.get("SecurityGroupId")).and_then(Value::as_str).map(String::from)).unwrap_or_default();
    if selected.is_empty() { return Ok(json!({"groups":groups,"selectedSecurityGroupId":"","rules":[]})); }
    let (detail, _) = request(id, &host, &format!("/v2/securityGroup/{selected}"), BTreeMap::new()).await?;
    let rules = crate::array_at(&detail, &["rules"]).into_iter().filter(|rule| rule.get("direction").and_then(Value::as_str).is_some_and(|direction| direction.eq_ignore_ascii_case("ingress"))).map(|rule| json!({"Direction":rule.get("direction").cloned().unwrap_or(json!("ingress")),"IpProtocol":rule.get("protocol").cloned().unwrap_or(json!("")),"PortRange":security_group_port(rule.get("portRange").and_then(Value::as_str).unwrap_or("")),"SourceCidrIp":rule.get("sourceIp").cloned().unwrap_or(json!("")),"SourceGroupId":rule.get("sourceGroupId").cloned().unwrap_or(json!("")),"Policy":"accept","Priority":0,"Description":rule.get("remark").cloned().unwrap_or(json!("")),"NicType":"","SecurityGroupRuleId":rule.get("securityGroupRuleId").cloned().unwrap_or(json!(""))})).collect::<Vec<_>>();
    Ok(json!({"groups":groups,"selectedSecurityGroupId":selected,"rules":rules,"sgVersion":detail.get("sgVersion").cloned().unwrap_or(Value::Null)}))
}

pub(crate) async fn authorize_security_group_rule(id: i64, region_id: &str, security_group_id: &str, ip_protocol: String, port_range: String, source_cidr_ip: String, description: Option<String>, sg_version: Option<i64>) -> Result<String, String> {
    if region_id.trim().is_empty() || security_group_id.trim().is_empty() { return Err("缺少安全组地域或安全组 ID".into()); }
    let mut query = crate::string_params(&[("authorizeRule", String::new()), ("clientToken", uuid::Uuid::new_v4().to_string())]); if let Some(version) = sg_version { query.insert("sgVersion".into(), version.to_string()); }
    let host = format!("bcc.{region_id}.baidubce.com"); let (result, _) = request_with_options(id, &host, &format!("/v2/securityGroup/{security_group_id}"), query, "PUT", Some(json!({"rule":security_group_rule_input(ip_protocol, port_range, source_cidr_ip, description)?})), true).await?;
    Ok(result.get("requestId").or_else(|| result.get("RequestId")).and_then(Value::as_str).unwrap_or_default().to_string())
}

pub(crate) async fn revoke_security_group_rule(id: i64, region_id: &str, _security_group_id: &str, rule_id: Option<String>, sg_version: Option<i64>) -> Result<String, String> {
    if region_id.trim().is_empty() { return Err("缺少安全组地域".into()); } let rule_id = rule_id.filter(|value| !value.trim().is_empty()).ok_or("缺少百度云安全组规则 ID")?;
    let mut query = crate::string_params(&[("clientToken", uuid::Uuid::new_v4().to_string())]); if let Some(version) = sg_version { query.insert("sgVersion".into(), version.to_string()); }
    let host = format!("bcc.{region_id}.baidubce.com"); let (result, _) = request_with_options(id, &host, &format!("/v2/securityGroup/rule/{rule_id}"), query, "DELETE", None, false).await?;
    Ok(result.get("requestId").or_else(|| result.get("RequestId")).and_then(Value::as_str).unwrap_or_default().to_string())
}
