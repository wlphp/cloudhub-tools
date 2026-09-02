use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use hmac::{Hmac, Mac};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use md5::Md5;
use serde_json::{json, Value};
use chrono::Utc;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use uuid::Uuid;
use std::path::Path;
use std::collections::BTreeMap;
use tokio_util::io::ReaderStream;
use tokio::io::AsyncWriteExt;
use crate::ResourceResponse;

const RPC_ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');

pub(crate) fn encode(value: &str) -> String { utf8_percent_encode(value, RPC_ENCODE_SET).to_string() }

pub(crate) async fn request(endpoint: &str, version: &str, action: &str, params: std::collections::BTreeMap<String, String>, access_key_id: &str, access_key_secret: &str) -> Result<Value, String> {
    let mut query = params;
    query.insert("AccessKeyId".into(), access_key_id.into()); query.insert("Action".into(), action.into()); query.insert("Format".into(), "JSON".into()); query.insert("SignatureMethod".into(), "HMAC-SHA1".into()); query.insert("SignatureNonce".into(), Uuid::new_v4().to_string()); query.insert("SignatureVersion".into(), "1.0".into()); query.insert("Timestamp".into(), Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()); query.insert("Version".into(), version.into());
    let mut encoded = query.iter().map(|(key, value)| (encode(key), encode(value))).collect::<Vec<_>>();
    encoded.sort();
    let canonical = encoded.iter().map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>().join("&");
    let string_to_sign = format!("GET&%2F&{}", encode(&canonical));
    let mut mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(format!("{access_key_secret}&").as_bytes()).map_err(|error| error.to_string())?;
    mac.update(string_to_sign.as_bytes());
    query.insert("Signature".into(), B64.encode(mac.finalize().into_bytes()));
    let mut request_params = query.iter().map(|(key, value)| (encode(key), encode(value))).collect::<Vec<_>>();
    request_params.sort();
    let url = format!("https://{endpoint}/?{}", request_params.iter().map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>().join("&"));
    let response = match reqwest::Client::new().get(url).timeout(std::time::Duration::from_secs(25)).send().await {
        Ok(response) => response,
        Err(error) => { let message = format!("阿里云请求失败: {error}"); crate::write_api_log(access_key_id, endpoint, action, &json!(query), None, "失败", Some(&message)); return Err(message); }
    };
    let status = response.status();
    let data: Value = match response.json().await {
        Ok(data) => data,
        Err(error) => { let message = format!("阿里云返回解析失败: {error}"); crate::write_api_log(access_key_id, endpoint, action, &json!(query), None, "失败", Some(&message)); return Err(message); }
    };
    let api_code = data.get("Code").and_then(Value::as_str);
    if !status.is_success() || api_code.is_some_and(|code| code != "200" && code != "Success") {
        let message = data.get("Message").and_then(Value::as_str).or_else(|| data.get("Code").and_then(Value::as_str)).unwrap_or("阿里云 API 返回错误");
        crate::write_api_log(access_key_id, endpoint, action, &json!(query), Some(&data), "失败", Some(message));
        return Err(message.to_string());
    }
    crate::write_api_log(access_key_id, endpoint, action, &json!(query), Some(&data), "成功", None);
    Ok(data)
}

fn xml_text(body: &str, tag: &str) -> String { let open = format!("<{tag}>"); let close = format!("</{tag}>"); body.find(&open).and_then(|start| body[start + open.len()..].find(&close).map(|end| body[start + open.len()..start + open.len() + end].to_string())).unwrap_or_default() }
fn xml_blocks(body: &str, tag: &str) -> Vec<String> { let open = format!("<{tag}>"); let close = format!("</{tag}>"); let mut values = Vec::new(); let mut rest = body; while let Some(start) = rest.find(&open) { let chunk = &rest[start + open.len()..]; let Some(end) = chunk.find(&close) else { break }; values.push(chunk[..end].to_string()); rest = &chunk[end + close.len()..]; } values }

async fn oss_buckets(access_key_id: &str, access_key_secret: &str) -> Result<Vec<Value>, String> {
    let host = "oss-cn-hangzhou.aliyuncs.com";
    let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    let mut mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|error| error.to_string())?;
    mac.update(format!("GET\n\n\n{date}\n/").as_bytes());
    let authorization = format!("OSS {access_key_id}:{}", B64.encode(mac.finalize().into_bytes()));
    let response = reqwest::Client::new().get(format!("https://{host}/")).header("Date", &date).header("Host", host).header("Authorization", authorization).timeout(std::time::Duration::from_secs(25)).send().await.map_err(|error| format!("OSS 请求失败: {error}"))?;
    let status = response.status(); let body = response.text().await.map_err(|error| format!("OSS 返回读取失败: {error}"))?;
    if !status.is_success() { let message = format!("OSS 返回错误（{status}）"); crate::write_api_log(access_key_id, host, "ListBuckets", &json!({}), Some(&json!({"body": body})), "失败", Some(&message)); return Err(message); }
    let values = xml_blocks(&body, "Bucket").into_iter().map(|bucket| { let name = xml_text(&bucket, "Name"); let location = xml_text(&bucket, "Location"); json!({"Name": name, "Location": location, "CreationDate": xml_text(&bucket, "CreationDate"), "StorageClass": "Standard", "ExtranetEndpoint": format!("{name}.{location}.aliyuncs.com")}) }).filter(|item| item.get("Name").and_then(Value::as_str).is_some_and(|name| !name.is_empty())).collect::<Vec<_>>();
    crate::write_api_log(access_key_id, host, "ListBuckets", &json!({}), Some(&json!({"count": values.len()})), "成功", None);
    Ok(values)
}

fn security_group_params(region_id: String, security_group_id: String, ip_protocol: String, port_range: String, source_cidr_ip: String, policy: String, priority: i32, nic_type: Option<String>) -> Result<std::collections::BTreeMap<String, String>, String> {
    let protocol = ip_protocol.trim().to_ascii_lowercase(); let range = port_range.trim().to_string(); let source = source_cidr_ip.trim().to_string();
    if region_id.is_empty() || security_group_id.trim().is_empty() { return Err("缺少安全组地域或安全组 ID".into()); }
    if !matches!(protocol.as_str(), "tcp" | "udp" | "icmp" | "gre" | "all") { return Err("不支持的安全组协议".into()); }
    let valid = range.split_once('/').and_then(|(start, end)| Some((start.parse::<i32>().ok()?, end.parse::<i32>().ok()?))).is_some_and(|(start, end)| if matches!(protocol.as_str(), "tcp" | "udp") { (start == -1 && end == -1) || (start >= 1 && end >= start && end <= 65535) } else { start == -1 && end == -1 });
    if !valid { return Err("端口范围与协议不匹配，请使用 80/80、8000/9000 或 -1/-1".into()); }
    if source.is_empty() || !source.contains('/') { return Err("来源地址必须是 CIDR，例如 0.0.0.0/0".into()); }
    if !(1..=100).contains(&priority) { return Err("安全组规则优先级必须在 1 到 100 之间".into()); }
    let mut params = crate::string_params(&[("RegionId", region_id), ("SecurityGroupId", security_group_id), ("IpProtocol", protocol), ("PortRange", range), ("SourceCidrIp", source), ("Policy", if policy.eq_ignore_ascii_case("drop") { "drop".into() } else { "accept".into() }), ("Priority", priority.to_string())]);
    if let Some(nic_type) = nic_type.map(|value| value.trim().to_ascii_lowercase()).filter(|value| matches!(value.as_str(), "internet" | "intranet")) { params.insert("NicType".into(), nic_type); }
    Ok(params)
}

pub(crate) async fn list_security_groups(id: i64, region_id: &str, instance_id: &str, security_group_id: Option<String>) -> Result<Value, String> {
    if region_id.is_empty() || instance_id.is_empty() { return Err("缺少服务器地域或实例 ID".into()); }
    let (access_key_id, access_key_secret) = crate::account_credentials(id)?; let endpoint = format!("ecs.{region_id}.aliyuncs.com");
    let instance = request(&endpoint, "2014-05-26", "DescribeInstanceAttribute", crate::string_params(&[("RegionId", region_id.to_string()), ("InstanceId", instance_id.to_string())]), &access_key_id, &access_key_secret).await?;
    let attached = crate::array_at(&instance, &["SecurityGroupIds", "SecurityGroupId"]).into_iter().filter_map(Value::as_str).map(String::from).collect::<Vec<_>>();
    let response = request(&endpoint, "2014-05-26", "DescribeSecurityGroups", crate::string_params(&[("RegionId", region_id.to_string()), ("PageSize", "100".into())]), &access_key_id, &access_key_secret).await?;
    let groups = crate::array_at(&response, &["SecurityGroups", "SecurityGroup"]).into_iter().map(|group| { let vpc_id = group.get("VpcId").and_then(Value::as_str).unwrap_or(""); json!({"SecurityGroupId":group.get("SecurityGroupId").cloned().unwrap_or(json!("")),"SecurityGroupName":group.get("SecurityGroupName").cloned().unwrap_or(json!("")),"Description":group.get("Description").cloned().unwrap_or(json!("")),"VpcId":vpc_id,"NicType":if vpc_id.is_empty(){"internet"}else{"intranet"}}) }).filter(|group| attached.is_empty() || group.get("SecurityGroupId").and_then(Value::as_str).is_some_and(|value| attached.iter().any(|id| id == value))).collect::<Vec<_>>();
    let selected = security_group_id.filter(|value| groups.iter().any(|group| group.get("SecurityGroupId").and_then(Value::as_str) == Some(value.as_str()))).or_else(|| groups.first().and_then(|group| group.get("SecurityGroupId")).and_then(Value::as_str).map(String::from)).unwrap_or_default();
    let rules = if selected.is_empty() { Vec::new() } else { let detail = request(&endpoint, "2014-05-26", "DescribeSecurityGroupAttribute", crate::string_params(&[("RegionId", region_id.to_string()), ("SecurityGroupId", selected.clone())]), &access_key_id, &access_key_secret).await?; crate::array_at(&detail, &["Permissions", "Permission"]).into_iter().filter(|rule| rule.get("Direction").and_then(Value::as_str).is_some_and(|direction| direction.eq_ignore_ascii_case("ingress"))).map(|rule| json!({"Direction":rule.get("Direction").cloned().unwrap_or(json!("")),"IpProtocol":rule.get("IpProtocol").cloned().unwrap_or(json!("")),"PortRange":rule.get("PortRange").cloned().unwrap_or(json!("")),"SourceCidrIp":rule.get("SourceCidrIp").cloned().unwrap_or(json!("")),"SourceGroupId":rule.get("SourceGroupId").cloned().unwrap_or(json!("")),"Policy":rule.get("Policy").cloned().unwrap_or(json!("accept")),"Priority":rule.get("Priority").cloned().unwrap_or(json!(1)),"Description":rule.get("Description").cloned().unwrap_or(json!("")),"NicType":rule.get("NicType").cloned().unwrap_or(json!(""))})).collect() };
    Ok(json!({"groups":groups,"selectedSecurityGroupId":selected,"rules":rules}))
}

pub(crate) async fn authorize_security_group_rule(id: i64, region_id: &str, security_group_id: &str, ip_protocol: String, port_range: String, source_cidr_ip: String, description: Option<String>, nic_type: Option<String>) -> Result<String, String> {
    let (access_key_id, access_key_secret) = crate::account_credentials(id)?; let mut params = security_group_params(region_id.to_string(), security_group_id.to_string(), ip_protocol, port_range, source_cidr_ip, "accept".into(), 1, nic_type)?;
    if let Some(description) = description.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) { params.insert("Description".into(), description); }
    let result = request(&format!("ecs.{region_id}.aliyuncs.com"), "2014-05-26", "AuthorizeSecurityGroup", params, &access_key_id, &access_key_secret).await?; Ok(result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}

pub(crate) async fn revoke_security_group_rule(id: i64, region_id: &str, security_group_id: &str, ip_protocol: String, port_range: String, source_cidr_ip: String, policy: String, priority: i32, nic_type: Option<String>) -> Result<String, String> {
    let (access_key_id, access_key_secret) = crate::account_credentials(id)?; let params = security_group_params(region_id.to_string(), security_group_id.to_string(), ip_protocol, port_range, source_cidr_ip, policy, priority, nic_type)?;
    let result = request(&format!("ecs.{region_id}.aliyuncs.com"), "2014-05-26", "RevokeSecurityGroup", params, &access_key_id, &access_key_secret).await?; Ok(result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}

fn ensure_account(id: i64) -> Result<(), String> { if crate::account_cloud_type(id)? != "aliyun" { return Err("当前账号不是阿里云账号".into()); } Ok(()) }

pub(crate) async fn instance_status(id: i64, region_id: String, instance_id: String) -> Result<String, String> {
    ensure_account(id)?; if region_id.trim().is_empty() || instance_id.trim().is_empty() { return Err("缺少服务器地域或实例 ID".into()); }
    let (access_key_id, access_key_secret) = crate::account_credentials(id)?; let data = request(&format!("ecs.{region_id}.aliyuncs.com"), "2014-05-26", "DescribeInstanceStatus", crate::string_params(&[("RegionId", region_id), ("InstanceId.1", instance_id)]), &access_key_id, &access_key_secret).await?;
    Ok(crate::array_at(&data, &["InstanceStatuses", "InstanceStatus"]).first().and_then(|item| item.get("Status")).and_then(Value::as_str).unwrap_or("Unknown").to_string())
}

pub(crate) async fn instance_action(id: i64, region_id: String, instance_id: String, action: &str, force_stop: bool) -> Result<String, String> {
    ensure_account(id)?; if region_id.trim().is_empty() || instance_id.trim().is_empty() { return Err("缺少服务器地域或实例 ID".into()); }
    let action_name = match action { "reboot" => "RebootInstance", "start" => "StartInstance", "stop" => "StopInstance", _ => return Err("不支持的阿里云服务器操作".into()) };
    let (access_key_id, access_key_secret) = crate::account_credentials(id)?; let mut params = crate::string_params(&[("RegionId", region_id.clone()), ("InstanceId", instance_id)]); if action == "reboot" { params.insert("ForceStop".into(), force_stop.to_string()); }
    let data = request(&format!("ecs.{region_id}.aliyuncs.com"), "2014-05-26", action_name, params, &access_key_id, &access_key_secret).await?; Ok(data.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}

pub(crate) async fn rename_instance(id: i64, region_id: &str, instance_id: &str, instance_name: &str) -> Result<String, String> {
    ensure_account(id)?; if region_id.trim().is_empty() || instance_id.trim().is_empty() { return Err("缺少服务器地域或实例 ID".into()); }
    let (access_key_id, access_key_secret) = crate::account_credentials(id)?; let data = request(&format!("ecs.{region_id}.aliyuncs.com"), "2014-05-26", "ModifyInstanceAttribute", crate::string_params(&[("RegionId", region_id.to_string()), ("InstanceId", instance_id.to_string()), ("InstanceName", instance_name.to_string())]), &access_key_id, &access_key_secret).await?;
    Ok(data.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}

pub(crate) async fn swas_instance_action(id: i64, region_id: &str, instance_id: &str, action: &str, force_stop: bool) -> Result<Value, String> {
    ensure_account(id)?;
    let action_name = match action { "start" => "StartInstance", "reboot" => "RebootInstance", "stop" => "StopInstance", _ => return Err("不支持的轻量服务器操作".into()) };
    let force_reboot = action == "reboot" && force_stop;
    let params = if force_reboot { crate::string_params(&[("RegionId", region_id.to_string()), ("InstanceIds", json!([instance_id]).to_string()), ("ForceReboot", "true".into())]) } else { crate::string_params(&[("RegionId", region_id.to_string()), ("InstanceId", instance_id.to_string())]) };
    let (access_key_id, access_key_secret) = crate::account_credentials(id)?;
    request(&format!("swas.{region_id}.aliyuncs.com"), "2020-06-01", if force_reboot { "RebootInstances" } else { action_name }, params, &access_key_id, &access_key_secret).await
}

pub(crate) async fn instance_disks(id: i64, region_id: &str, instance_id: &str) -> Result<Vec<Value>, String> {
    if crate::account_cloud_type(id)? != "aliyun" { return Err("当前账号不是阿里云账号".into()); }
    let (access_key_id, access_key_secret) = crate::account_credentials(id)?;
    let result = request(&format!("ecs.{region_id}.aliyuncs.com"), "2014-05-26", "DescribeDisks", crate::string_params(&[("RegionId", region_id.to_string()), ("InstanceId", instance_id.to_string())]), &access_key_id, &access_key_secret).await?;
    Ok(crate::array_at(&result, &["Disks", "Disk"]).into_iter().cloned().collect())
}

pub(crate) async fn list_rds_databases(id: i64, region_id: &str, instance_id: &str) -> Result<Vec<Value>, String> {
    if crate::account_cloud_type(id)? != "aliyun" { return Err("当前账号不是阿里云账号".into()); }
    let (access_key_id, access_key_secret) = crate::account_credentials(id)?; let result = request("rds.aliyuncs.com", "2014-08-15", "DescribeDatabases", crate::string_params(&[("RegionId", region_id.to_string()), ("DBInstanceId", instance_id.to_string())]), &access_key_id, &access_key_secret).await?;
    Ok(crate::array_at(&result, &["Databases", "Database"]).into_iter().cloned().collect())
}

pub(crate) async fn list_rds_accounts(id: i64, region_id: &str, instance_id: &str) -> Result<Vec<Value>, String> {
    if crate::account_cloud_type(id)? != "aliyun" { return Err("当前账号不是阿里云账号".into()); }
    let (access_key_id, access_key_secret) = crate::account_credentials(id)?; let result = request("rds.aliyuncs.com", "2014-08-15", "DescribeAccounts", crate::string_params(&[("RegionId", region_id.to_string()), ("DBInstanceId", instance_id.to_string())]), &access_key_id, &access_key_secret).await?;
    Ok(crate::array_at(&result, &["Accounts", "DBInstanceAccount"]).into_iter().cloned().collect())
}

pub(crate) async fn list_redis_accounts(id: i64, instance_id: &str, region_id: &str) -> Result<Vec<Value>, String> {
    if crate::account_cloud_type(id)? != "aliyun" { return Err("当前账号不是阿里云账号".into()); }
    let (access_key_id, access_key_secret) = crate::account_credentials(id)?; let result = request("r-kvstore.aliyuncs.com", "2015-01-01", "DescribeAccounts", crate::string_params(&[("InstanceId", instance_id.to_string()), ("RegionId", region_id.to_string())]), &access_key_id, &access_key_secret).await?;
    Ok(crate::array_at(&result, &["Accounts", "Account"]).into_iter().cloned().collect())
}

pub(crate) async fn list_objects(id: i64, bucket: &str, location: &str, prefix: &str, marker: &str) -> Result<Value, String> {
    if crate::account_cloud_type(id)? != "aliyun" { return Err("当前账号不是阿里云账号".into()); }
    let (access_key_id, access_key_secret) = crate::account_credentials(id)?; let location = if location.is_empty() { "oss-cn-hangzhou" } else { location }; let host = format!("{bucket}.{location}.aliyuncs.com"); let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string(); let resource = format!("/{bucket}/"); let mut mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|error| error.to_string())?; mac.update(format!("GET\n\n\n{date}\n{resource}").as_bytes()); let mut query = "delimiter=%2F&max-keys=1000".to_string(); if !prefix.is_empty() { query.push_str(&format!("&prefix={}", crate::rpc_encode(prefix))); } if !marker.is_empty() { query.push_str(&format!("&marker={}", crate::rpc_encode(marker))); }
    let response = reqwest::Client::new().get(format!("https://{host}/?{query}")).header("Date", date).header("Host", &host).header("Authorization", format!("OSS {access_key_id}:{}", B64.encode(mac.finalize().into_bytes()))).timeout(std::time::Duration::from_secs(25)).send().await.map_err(|error| format!("OSS 请求失败: {error}"))?; let status = response.status(); let body = response.text().await.map_err(|error| error.to_string())?; if !status.is_success() { let code = xml_text(&body, "Code"); return Err(format!("OSS 返回错误（{status}）：{}", if code.is_empty() { "请求被拒绝" } else { &code })); }
    let objects = xml_blocks(&body, "Contents").into_iter().map(|object| json!({"Key": xml_text(&object, "Key"), "Size": xml_text(&object, "Size"), "LastModified": xml_text(&object, "LastModified"), "ETag": xml_text(&object, "ETag")})).filter(|object| object.get("Key").and_then(Value::as_str).is_some_and(|key| !key.is_empty() && key != prefix)).collect::<Vec<_>>(); Ok(json!({"objects": objects, "prefixes": xml_blocks(&body, "CommonPrefixes").into_iter().map(|entry| xml_text(&entry, "Prefix")).filter(|value| !value.is_empty()).collect::<Vec<_>>(), "isTruncated": xml_text(&body, "IsTruncated").eq_ignore_ascii_case("true"), "nextMarker": xml_text(&body, "NextMarker")}))
}

pub(crate) async fn get_acl(id: i64, bucket: &str, location: &str) -> Result<String, String> {
    if crate::account_cloud_type(id)? != "aliyun" { return Err("当前账号不是阿里云账号".into()); } let (access_key_id, access_key_secret) = crate::account_credentials(id)?; let location = if location.is_empty() { "oss-cn-hangzhou" } else { location }; let host = format!("{bucket}.{location}.aliyuncs.com"); let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string(); let resource = format!("/{bucket}/?acl"); let mut mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|error| error.to_string())?; mac.update(format!("GET\n\n\n{date}\n{resource}").as_bytes()); let response = reqwest::Client::new().get(format!("https://{host}/?acl")).header("Date", date).header("Host", &host).header("Authorization", format!("OSS {access_key_id}:{}", B64.encode(mac.finalize().into_bytes()))).timeout(std::time::Duration::from_secs(25)).send().await.map_err(|error| format!("OSS 请求失败: {error}"))?; let status = response.status(); let body = response.text().await.map_err(|error| error.to_string())?; if !status.is_success() { return Err(format!("OSS 返回错误（{status}）：{}", xml_text(&body, "Code"))); } Ok(xml_text(&body, "Permission"))
}

pub(crate) async fn set_public_read(id: i64, bucket: &str, location: &str) -> Result<(), String> {
    if crate::account_cloud_type(id)? != "aliyun" { return Err("当前账号不是阿里云账号".into()); } let (access_key_id, access_key_secret) = crate::account_credentials(id)?; let location = if location.is_empty() { "oss-cn-hangzhou" } else { location }; let host = format!("{bucket}.{location}.aliyuncs.com"); let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string(); let resource = format!("/{bucket}/?acl"); let mut mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|error| error.to_string())?; mac.update(format!("PUT\n\n\n{date}\nx-oss-acl:public-read\n{resource}").as_bytes()); let response = reqwest::Client::new().put(format!("https://{host}/?acl")).header("Date", date).header("Host", &host).header("x-oss-acl", "public-read").header("Content-Length", "0").header("Authorization", format!("OSS {access_key_id}:{}", B64.encode(mac.finalize().into_bytes()))).timeout(std::time::Duration::from_secs(25)).send().await.map_err(|error| format!("OSS 请求失败: {error}"))?; if !response.status().is_success() { return Err(format!("OSS 返回错误（{}）", response.status())); } Ok(())
}

pub(crate) async fn set_cors(id: i64, bucket: &str, location: &str, origins: &str) -> Result<(), String> {
    if crate::account_cloud_type(id)? != "aliyun" { return Err("当前账号不是阿里云账号".into()); } let (access_key_id, access_key_secret) = crate::account_credentials(id)?; let location = if location.is_empty() { "oss-cn-hangzhou" } else { location }; let host = format!("{bucket}.{location}.aliyuncs.com"); let safe_origin = origins.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;"); let body = format!(r#"<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration><CORSRule><AllowedOrigin>{safe_origin}</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>POST</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>DELETE</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><ExposeHeader>x-oss-request-id</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>"#); let md5 = B64.encode(Md5::digest(body.as_bytes())); let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string(); let resource = format!("/{bucket}/?cors"); let mut mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|error| error.to_string())?; mac.update(format!("PUT\n{md5}\napplication/xml\n{date}\n{resource}").as_bytes()); let response = reqwest::Client::new().put(format!("https://{host}/?cors")).header("Date", date).header("Host", &host).header("Content-Type", "application/xml").header("Content-MD5", &md5).header("Authorization", format!("OSS {access_key_id}:{}", B64.encode(mac.finalize().into_bytes()))).body(body).timeout(std::time::Duration::from_secs(25)).send().await.map_err(|error| format!("OSS 请求失败: {error}"))?; if !response.status().is_success() { return Err(format!("OSS 返回错误（{}）", response.status())); } Ok(())
}

fn dns_params(record_type: &str, ttl: Option<i64>, line: Option<String>) -> std::collections::BTreeMap<String, String> {
    let mut params = crate::string_params(&[("Type", record_type.to_string()), ("TTL", ttl.unwrap_or(600).to_string()), ("Line", line.unwrap_or_else(|| "default".into()))]);
    if record_type == "MX" { params.insert("Priority".into(), "10".into()); } params
}

pub(crate) async fn add_dns_record(id: i64, domain: &str, record_type: &str, rr: &str, value: &str, ttl: Option<i64>, priority: Option<i64>, line: Option<String>) -> Result<Value, String> {
    if crate::account_cloud_type(id)? != "aliyun" { return Err("当前账号不是阿里云账号".into()); } let (access_key_id, access_key_secret) = crate::account_credentials(id)?; let mut params = dns_params(record_type, ttl, line); params.insert("DomainName".into(), domain.into()); params.insert("RR".into(), rr.into()); params.insert("Value".into(), value.into()); if record_type == "MX" { params.insert("Priority".into(), priority.unwrap_or(10).to_string()); } request("alidns.aliyuncs.com", "2015-01-09", "AddDomainRecord", params, &access_key_id, &access_key_secret).await
}

pub(crate) async fn update_dns_record(id: i64, record_id: &str, record_type: &str, rr: &str, value: &str, ttl: Option<i64>, priority: Option<i64>, line: Option<String>) -> Result<Value, String> {
    if crate::account_cloud_type(id)? != "aliyun" { return Err("当前账号不是阿里云账号".into()); } let (access_key_id, access_key_secret) = crate::account_credentials(id)?; let mut params = dns_params(record_type, ttl, line); params.insert("RecordId".into(), record_id.into()); params.insert("RR".into(), rr.into()); params.insert("Value".into(), value.into()); if record_type == "MX" { params.insert("Priority".into(), priority.unwrap_or(10).to_string()); } request("alidns.aliyuncs.com", "2015-01-09", "UpdateDomainRecord", params, &access_key_id, &access_key_secret).await
}

pub(crate) async fn delete_dns_record(id: i64, record_id: &str) -> Result<Value, String> {
    if crate::account_cloud_type(id)? != "aliyun" { return Err("当前账号不是阿里云账号".into()); } let (access_key_id, access_key_secret) = crate::account_credentials(id)?; request("alidns.aliyuncs.com", "2015-01-09", "DeleteDomainRecord", crate::string_params(&[("RecordId", record_id.to_string())]), &access_key_id, &access_key_secret).await
}

pub(crate) async fn toggle_dns_record(id: i64, record_id: &str, status: &str) -> Result<Value, String> {
    if crate::account_cloud_type(id)? != "aliyun" { return Err("当前账号不是阿里云账号".into()); } let (access_key_id, access_key_secret) = crate::account_credentials(id)?; request("alidns.aliyuncs.com", "2015-01-09", "SetDomainRecordStatus", crate::string_params(&[("RecordId", record_id.to_string()), ("Status", status.to_string())]), &access_key_id, &access_key_secret).await
}

pub(crate) async fn list_dns_records(id: i64, domain: &str, record_type: Option<String>, keyword: Option<String>) -> Result<Value, String> {
    if crate::account_cloud_type(id)? != "aliyun" { return Err("当前账号不是阿里云账号".into()); } let (access_key_id, access_key_secret) = crate::account_credentials(id)?; let mut params = crate::string_params(&[("DomainName", domain.to_string()), ("PageNumber", "1".into()), ("PageSize", "500".into())]); if let Some(value) = record_type.filter(|value| !value.is_empty()) { params.insert("TypeKeyWord".into(), value); } if let Some(value) = keyword.filter(|value| !value.is_empty()) { params.insert("RRKeyWord".into(), value); } let result = request("alidns.aliyuncs.com", "2015-01-09", "DescribeDomainRecords", params, &access_key_id, &access_key_secret).await?; Ok(json!({"items": crate::array_at(&result, &["DomainRecords", "Record"]).into_iter().cloned().collect::<Vec<_>>(), "total": result.get("TotalCount").cloned().unwrap_or(json!(0))}))
}

pub(crate) async fn list_domain_logs(id: i64, domain: &str, start_date: Option<String>, end_date: Option<String>, keyword: Option<String>) -> Result<Value, String> {
    if crate::account_cloud_type(id)? != "aliyun" { return Err("当前账号不是阿里云账号".into()); } let (access_key_id, access_key_secret) = crate::account_credentials(id)?; let mut params = crate::string_params(&[("DomainName", domain.to_string()), ("PageNumber", "1".into()), ("PageSize", "100".into())]); if let Some(value) = start_date.filter(|value| !value.is_empty()) { params.insert("StartDate".into(), value); } if let Some(value) = end_date.filter(|value| !value.is_empty()) { params.insert("EndDate".into(), value); } if let Some(value) = keyword.filter(|value| !value.is_empty()) { params.insert("KeyWord".into(), value); } let result = request("alidns.aliyuncs.com", "2015-01-09", "DescribeRecordLogs", params, &access_key_id, &access_key_secret).await?; Ok(json!({"items": crate::array_at(&result, &["RecordLogs", "RecordLog"]).into_iter().cloned().collect::<Vec<_>>(), "total": result.get("TotalCount").cloned().unwrap_or(json!(0))}))
}

fn display(value: Option<&Value>) -> String { match value { Some(Value::String(value)) => value.clone(), Some(Value::Null) | None => "-".into(), Some(value) => value.to_string() } }

pub(crate) async fn query_whois(id: i64, domain: &str) -> Result<String, String> {
    if crate::account_cloud_type(id)? != "aliyun" { return Err("当前账号不是阿里云账号".into()); } let (access_key_id, access_key_secret) = crate::account_credentials(id)?; let result = request("domain.aliyuncs.com", "2018-01-29", "QueryDomainByDomainName", crate::string_params(&[("DomainName", domain.to_string())]), &access_key_id, &access_key_secret).await?; let get = |key: &str| display(result.get(key)); let registrant_org = result.get("ZhRegistrantOrganization").or_else(|| result.get("RegistrantOrganization")); let registrant_name = result.get("ZhRegistrantName").or_else(|| result.get("RegistrantName")); Ok(format!("域名信息查询结果\n=====================================\n\n域名: {}\n域名持有者: {}\n持有者类型: {}\n联系人: {}\n联系邮箱: {}\n\n注册时间: {}\n到期时间: {}\n注册商: 阿里云\n\n实名认证: {}\n域名状态: {}\nDNS服务器: {}", get("DomainName"), display(registrant_org), get("RegistrantType"), display(registrant_name), get("Email"), get("RegistrationDate"), get("ExpirationDate"), get("RealNameStatus"), get("DomainStatus"), display(result.get("DnsList"))))
}

pub(crate) async fn finance_summary(id: i64) -> (Value, Value, Value, Value) {
    if crate::account_cloud_type(id).as_deref() != Ok("aliyun") { return (json!({}), json!({}), json!({}), json!({})); }
    let Ok((access_key_id, access_key_secret)) = crate::account_credentials(id) else { return (json!({}), json!({}), json!({}), json!({})); }; let billing_cycle = Utc::now().format("%Y-%m").to_string(); let (identity, balance, bill, dns) = tokio::join!(request("sts.aliyuncs.com", "2015-04-01", "GetCallerIdentity", BTreeMap::new(), &access_key_id, &access_key_secret), request("business.aliyuncs.com", "2017-12-14", "QueryAccountBalance", BTreeMap::new(), &access_key_id, &access_key_secret), request("business.aliyuncs.com", "2017-12-14", "QueryBill", crate::string_params(&[("BillingCycle", billing_cycle)]), &access_key_id, &access_key_secret), request("alidns.aliyuncs.com", "2015-01-09", "DescribeDomains", crate::string_params(&[("PageNumber", "1".into()), ("PageSize", "20".into())]), &access_key_id, &access_key_secret)); (identity.unwrap_or_else(|_| json!({})), balance.unwrap_or_else(|_| json!({})), bill.unwrap_or_else(|_| json!({})), dns.unwrap_or_else(|_| json!({})))
}

pub(crate) async fn list_light_firewall_rules(id: i64, region: &str, instance_id: &str) -> Result<Value, String> {
    if crate::account_cloud_type(id)? != "aliyun" { return Err("当前账号不是阿里云账号".into()); } let (access_key_id, access_key_secret) = crate::account_credentials(id)?; let result = request(&format!("swas.{region}.aliyuncs.com"), "2020-06-01", "ListFirewallRules", crate::string_params(&[("RegionId", region.to_string()), ("InstanceId", instance_id.to_string()), ("PageNumber", "1".into()), ("PageSize", "100".into())]), &access_key_id, &access_key_secret).await?; let rules = crate::array_at(&result, &["FirewallRules"]).into_iter().filter(|rule| rule.get("Policy").and_then(Value::as_str).unwrap_or("accept").eq_ignore_ascii_case("accept")).map(|rule| json!({"RuleId": rule.get("RuleId").cloned().unwrap_or(json!("")), "IpProtocol": rule.get("RuleProtocol").cloned().unwrap_or(json!("")), "PortRange": rule.get("Port").cloned().unwrap_or(json!("")), "SourceCidrIp": rule.get("SourceCidrIp").cloned().unwrap_or(json!("")), "Policy": rule.get("Policy").cloned().unwrap_or(json!("accept")), "Description": rule.get("Remark").cloned().unwrap_or(json!(""))})).collect::<Vec<_>>(); Ok(json!({"rules": rules}))
}

pub(crate) async fn create_light_firewall_rule(id: i64, region: &str, instance_id: &str, protocol: &str, port: &str, source: &str, description: &str) -> Result<Value, String> {
    if crate::account_cloud_type(id)? != "aliyun" { return Err("当前账号不是阿里云账号".into()); } let (access_key_id, access_key_secret) = crate::account_credentials(id)?; let rule = json!({"Port": port, "RuleProtocol": protocol.to_ascii_uppercase(), "SourceCidrIp": source, "Remark": description}); request(&format!("swas.{region}.aliyuncs.com"), "2020-06-01", "CreateFirewallRules", crate::string_params(&[("RegionId", region.to_string()), ("InstanceId", instance_id.to_string()), ("FirewallRules", json!([rule]).to_string())]), &access_key_id, &access_key_secret).await
}

pub(crate) async fn delete_light_firewall_rule(id: i64, region: &str, instance_id: &str, rule_id: &str) -> Result<Value, String> {
    if crate::account_cloud_type(id)? != "aliyun" { return Err("当前账号不是阿里云账号".into()); } let (access_key_id, access_key_secret) = crate::account_credentials(id)?; request(&format!("swas.{region}.aliyuncs.com"), "2020-06-01", "DeleteFirewallRules", crate::string_params(&[("RegionId", region.to_string()), ("InstanceId", instance_id.to_string()), ("RuleIds", rule_id.to_string())]), &access_key_id, &access_key_secret).await
}

fn validate_object_key(key: &str) -> Result<(), String> { if key.is_empty() { return Err("对象路径不能为空".into()); } if key.as_bytes().len() > 1023 { return Err("对象路径不能超过 1023 字节".into()); } if key.starts_with('/') || key.starts_with('\\') { return Err("对象路径不能以斜杠开头".into()); } if key.chars().any(char::is_control) { return Err("对象路径不能包含控制字符".into()); } Ok(()) }
fn encode_object_path(key: &str) -> String { key.split('/').map(crate::rpc_encode).collect::<Vec<_>>().join("/") }

pub(crate) fn signed_object_url(id: i64, bucket: &str, location: &str, key: &str) -> Result<String, String> {
    if crate::account_cloud_type(id)? != "aliyun" { return Err("当前仅支持阿里云 OSS 文件 URL".into()); } validate_object_key(key)?; let (access_key_id, access_key_secret) = crate::account_credentials(id)?; let location = if location.is_empty() { "oss-cn-hangzhou" } else { location }; let expires = (Utc::now().timestamp() + 15 * 60).to_string(); let resource = format!("/{bucket}/{key}"); let mut mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|error| error.to_string())?; mac.update(format!("GET\n\n\n{expires}\n{resource}").as_bytes()); let signature = B64.encode(mac.finalize().into_bytes()); let host = format!("{bucket}.{location}.aliyuncs.com"); Ok(format!("https://{host}/{}?Expires={}&OSSAccessKeyId={}&Signature={}", encode_object_path(key), crate::rpc_encode(&expires), crate::rpc_encode(&access_key_id), crate::rpc_encode(&signature)))
}

pub(crate) async fn upload_object(id: i64, bucket: &str, location: &str, key: &str, source_path: &Path, overwrite: bool) -> Result<(), String> {
    if crate::account_cloud_type(id)? != "aliyun" { return Err("当前仅支持阿里云 OSS 文件上传".into()); } validate_object_key(key)?; let metadata = tokio::fs::metadata(source_path).await.map_err(|error| format!("读取本机文件失败: {error}"))?; if !metadata.is_file() { return Err("所选路径不是文件".into()); } if metadata.len() > 5 * 1024 * 1024 * 1024 { return Err("单文件上传不能超过 5 GB，请使用 OSS 分片上传工具".into()); } let location = if location.is_empty() { "oss-cn-hangzhou" } else { location }; let (access_key_id, access_key_secret) = crate::account_credentials(id)?; let host = format!("{bucket}.{location}.aliyuncs.com"); let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string(); let content_type = "application/octet-stream"; let resource = format!("/{bucket}/{key}"); let overwrite_header = if overwrite { "" } else { "x-oss-forbid-overwrite:true\n" }; let mut mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|error| error.to_string())?; mac.update(format!("PUT\n\n{content_type}\n{date}\n{overwrite_header}{resource}").as_bytes()); let file = tokio::fs::File::open(source_path).await.map_err(|error| format!("打开本机文件失败: {error}"))?; let body = reqwest::Body::wrap_stream(ReaderStream::new(file)); let mut request = reqwest::Client::new().put(format!("https://{host}/{}", encode_object_path(key))).header("Date", date).header("Host", &host).header("Content-Type", content_type).header("Content-Length", metadata.len()).header("Authorization", format!("OSS {access_key_id}:{}", B64.encode(mac.finalize().into_bytes()))); if !overwrite { request = request.header("x-oss-forbid-overwrite", "true"); } let response = request.body(body).timeout(std::time::Duration::from_secs(60 * 60)).send().await.map_err(|error| format!("OSS 上传失败: {error}"))?; let status = response.status(); if !status.is_success() { let body = response.text().await.unwrap_or_default(); let code = xml_text(&body, "Code"); let message = xml_text(&body, "Message"); return Err(if code == "FileAlreadyExists" { "同名对象已存在，请确认覆盖后重试".into() } else { format!("OSS 上传失败（{status}）：{}", if message.is_empty() { if code.is_empty() { "请求被拒绝" } else { &code } } else { &message }) }); } Ok(())
}

pub(crate) async fn download_object(id: i64, bucket: &str, location: &str, key: &str, target_path: &Path) -> Result<(), String> {
    if crate::account_cloud_type(id)? != "aliyun" { return Err("当前仅支持阿里云 OSS 文件下载".into()); } validate_object_key(key)?; let location = if location.is_empty() { "oss-cn-hangzhou" } else { location }; let (access_key_id, access_key_secret) = crate::account_credentials(id)?; let host = format!("{bucket}.{location}.aliyuncs.com"); let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string(); let resource = format!("/{bucket}/{key}"); let mut mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|error| error.to_string())?; mac.update(format!("GET\n\n\n{date}\n{resource}").as_bytes()); let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().map_err(|error| format!("创建 OSS 客户端失败: {error}"))?; let response = client.get(format!("https://{host}/{}", encode_object_path(key))).header("Date", date).header("Host", &host).header("Authorization", format!("OSS {access_key_id}:{}", B64.encode(mac.finalize().into_bytes()))).timeout(std::time::Duration::from_secs(60 * 60)).send().await.map_err(|error| format!("OSS 下载失败: {error}"))?; let status = response.status(); if !status.is_success() { let body = response.text().await.unwrap_or_default(); let code = xml_text(&body, "Code"); let message = xml_text(&body, "Message"); return Err(format!("OSS 下载失败（{status}）：{}", if message.is_empty() { if code.is_empty() { "请求被拒绝" } else { &code } } else { &message })); } let parent = target_path.parent().ok_or_else(|| "下载位置无效".to_string())?; if !parent.is_dir() { return Err("下载目录不存在".into()); } let temp_path = parent.join(format!(".cloudhub-download-{}.part", Uuid::new_v4())); let result = async { let mut file = tokio::fs::File::create(&temp_path).await.map_err(|error| format!("创建临时文件失败: {error}"))?; let mut response = response; while let Some(chunk) = response.chunk().await.map_err(|error| format!("读取下载数据失败: {error}"))? { file.write_all(&chunk).await.map_err(|error| format!("写入下载文件失败: {error}"))?; } file.flush().await.map_err(|error| format!("刷新下载文件失败: {error}"))?; drop(file); if target_path.exists() { tokio::fs::remove_file(target_path).await.map_err(|error| format!("替换已有文件失败: {error}"))?; } tokio::fs::rename(&temp_path, target_path).await.map_err(|error| format!("保存下载文件失败: {error}")) }.await; if result.is_err() { let _ = tokio::fs::remove_file(&temp_path).await; } result
}

async fn esa_request(action: &str, params: std::collections::BTreeMap<String, String>, method: &str, access_key_id: &str, access_key_secret: &str) -> Result<Value, String> { let host = "esa.cn-hangzhou.aliyuncs.com"; let mut values = params.iter().map(|(key, value)| (encode(key), encode(value))).collect::<Vec<_>>(); values.sort(); let encoded_query = values.iter().map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>().join("&"); let payload_hash = format!("{:x}", Sha256::digest(b"")); let acs_date = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(); let nonce = Uuid::new_v4().to_string(); let mut headers = std::collections::BTreeMap::new(); headers.insert("host", host.to_string()); headers.insert("x-acs-action", action.to_string()); headers.insert("x-acs-content-sha256", payload_hash.clone()); headers.insert("x-acs-date", acs_date.clone()); headers.insert("x-acs-signature-nonce", nonce.clone()); headers.insert("x-acs-version", "2024-09-10".to_string()); let canonical_headers = headers.iter().map(|(key, value)| format!("{key}:{value}\n")).collect::<String>(); let signed_headers = headers.keys().cloned().collect::<Vec<_>>().join(";"); let method = method.to_uppercase(); let canonical_request = format!("{method}\n/\n{encoded_query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"); let string_to_sign = format!("ACS3-HMAC-SHA256\n{:x}", Sha256::digest(canonical_request.as_bytes())); let mut mac: Hmac<Sha256> = <Hmac<Sha256> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|error| error.to_string())?; mac.update(string_to_sign.as_bytes()); let authorization = format!("ACS3-HMAC-SHA256 Credential={access_key_id},SignedHeaders={signed_headers},Signature={}", hex::encode(mac.finalize().into_bytes())); let url = if encoded_query.is_empty() { format!("https://{host}/") } else { format!("https://{host}/?{encoded_query}") }; let client = reqwest::Client::new(); let builder = if method == "POST" { client.post(url) } else { client.get(url) }; let response = builder.header("host", host).header("x-acs-action", action).header("x-acs-content-sha256", payload_hash).header("x-acs-date", acs_date).header("x-acs-signature-nonce", nonce).header("x-acs-version", "2024-09-10").header("authorization", authorization).timeout(std::time::Duration::from_secs(25)).send().await.map_err(|error| format!("ESA 请求失败: {error}"))?; let status = response.status(); let data: Value = response.json().await.map_err(|error| format!("ESA 返回解析失败: {error}"))?; if !status.is_success() || data.get("Code").is_some() { let message = data.get("Message").and_then(Value::as_str).or_else(|| data.get("Code").and_then(Value::as_str)).unwrap_or("ESA API 返回错误"); crate::write_api_log(access_key_id, host, action, &json!(params), Some(&data), "失败", Some(message)); return Err(message.to_string()); } crate::write_api_log(access_key_id, host, action, &json!(params), Some(&data), "成功", None); Ok(data) }

pub(crate) async fn resource_items(resource_type: &str, access_key_id: &str, access_key_secret: &str) -> ResourceResponse {
    let now = Utc::now().timestamp_millis(); let mut items = Vec::new(); let mut errors = Vec::new();
    let regions = || async { let result = request("ecs.aliyuncs.com", "2014-05-26", "DescribeRegions", std::collections::BTreeMap::new(), access_key_id, access_key_secret).await?; Ok::<Vec<(String, String)>, String>(crate::array_at(&result, &["Regions", "Region"]).into_iter().filter_map(|v| Some((v.get("RegionId")?.as_str()?.to_string(), v.get("LocalName").and_then(Value::as_str).unwrap_or("").to_string()))).collect()) };
    match resource_type {
        "ecs" => match regions().await { Ok(values) => for (region, name) in values { match request(&format!("ecs.{region}.aliyuncs.com"), "2014-05-26", "DescribeInstances", [("RegionId".into(), region.clone()), ("PageSize".into(), "100".into())].into_iter().collect(), access_key_id, access_key_secret).await { Ok(data) => for item in crate::array_at(&data, &["Instances", "Instance"]) { let mut value = item.clone(); if let Value::Object(object) = &mut value { object.insert("_region_id".into(), json!(region)); object.insert("_region_name".into(), json!(name)); } items.push(value); }, Err(e) => errors.push(format!("{region}: {e}")) } }, Err(e) => errors.push(e) },
        "rds" => match regions().await { Ok(values) => for (region, name) in values { match request("rds.aliyuncs.com", "2014-08-15", "DescribeDBInstances", [("RegionId".into(), region.clone()), ("PageSize".into(), "100".into())].into_iter().collect(), access_key_id, access_key_secret).await { Ok(data) => for item in crate::array_at(&data, &["Items", "DBInstance"]) { let mut value = item.clone(); if let Value::Object(object) = &mut value { object.insert("_region_id".into(), json!(region)); object.insert("_region_name".into(), json!(name)); } items.push(value); }, Err(e) => errors.push(format!("{region}: {e}")) } }, Err(e) => errors.push(e) },
        "redis" => match regions().await { Ok(values) => for (region, name) in values { match request("r-kvstore.aliyuncs.com", "2015-01-01", "DescribeInstances", [("RegionId".into(), region.clone()), ("PageSize".into(), "100".into())].into_iter().collect(), access_key_id, access_key_secret).await { Ok(data) => for item in crate::array_at(&data, &["Instances", "KVStoreInstance"]) { let mut value = item.clone(); if let Value::Object(object) = &mut value { object.insert("_region_id".into(), json!(region)); object.insert("_region_name".into(), json!(name)); } items.push(value); }, Err(e) => errors.push(format!("{region}: {e}")) } }, Err(e) => errors.push(e) },
        "domain" => { let registration = request("domain.aliyuncs.com", "2018-01-29", "QueryDomainList", [("PageNum".into(), "1".into()), ("PageSize".into(), "100".into())].into_iter().collect(), access_key_id, access_key_secret).await; let dns = request("alidns.aliyuncs.com", "2015-01-09", "DescribeDomains", [("PageNumber".into(), "1".into()), ("PageSize".into(), "20".into())].into_iter().collect(), access_key_id, access_key_secret).await; let registration_failed = registration.is_err(); let dns_failed = dns.is_err(); let mut merged = std::collections::BTreeMap::new(); if let Ok(data) = registration { for item in crate::array_at(&data, &["Data", "Domain"]) { if let Some(name) = item.get("DomainName").and_then(Value::as_str) { merged.insert(name.to_lowercase(), item.clone()); } } } if let Ok(data) = dns { for item in crate::array_at(&data, &["Domains", "Domain"]) { if let Some(name) = item.get("DomainName").and_then(Value::as_str) { let entry = merged.entry(name.to_lowercase()).or_insert_with(|| json!({"DomainName": name})); if let (Some(target), Some(source)) = (entry.as_object_mut(), item.as_object()) { target.extend(source.clone()); target.insert("RecordCount".into(), item.get("RecordCount").cloned().unwrap_or(json!(0))); } } } } items.extend(merged.into_values()); if items.is_empty() && registration_failed && dns_failed { errors.push("域名注册和 DNS 接口均请求失败".into()); } },
        "swas" => for region in ["cn-hangzhou", "cn-shanghai", "cn-beijing", "cn-shenzhen", "cn-hongkong", "ap-southeast-1"] { match request(&format!("swas.{region}.aliyuncs.com"), "2020-06-01", "ListInstances", [("RegionId".into(), region.into()), ("PageSize".into(), "100".into())].into_iter().collect(), access_key_id, access_key_secret).await { Ok(data) => items.extend(crate::array_at(&data, &["Instances"]).into_iter().cloned()), Err(e) => errors.push(format!("{region}: {e}")) } },
        "esa" => match esa_request("ListSites", [("PageNumber".into(), "1".into()), ("PageSize".into(), "100".into())].into_iter().collect(), "GET", access_key_id, access_key_secret).await { Ok(data) => items.extend(crate::array_at(&data, &["Sites"]).into_iter().cloned()), Err(e) => errors.push(e) },
        "oss" => match oss_buckets(access_key_id, access_key_secret).await { Ok(values) => items.extend(values), Err(e) => errors.push(e) },
        other => errors.push(format!("暂不支持资源类型: {other}")),
    }
    ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now }
}
