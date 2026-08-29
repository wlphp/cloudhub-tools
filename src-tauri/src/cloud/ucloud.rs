use crate::{account_cloud_type, account_credentials, array_at, configured_regions, rpc_encode, string_params, write_api_log, ResourceResponse};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chrono::Utc;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::collections::BTreeMap;

async fn request(id: i64, action: &str, mut params: BTreeMap<String, String>) -> Result<Value, String> {
    if account_cloud_type(id)? != "ucloud" { return Err("当前账号不是 UCloud 账号".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    params.insert("Action".into(), action.into());
    params.insert("PublicKey".into(), access_key_id.clone());
    let plain = params.iter().map(|(key, value)| format!("{key}{value}")).collect::<String>() + &access_key_secret;
    params.insert("Signature".into(), B64.encode(Sha1::digest(plain.as_bytes())));
    let query = params.iter().map(|(key, value)| format!("{}={}", rpc_encode(key), rpc_encode(value))).collect::<Vec<_>>().join("&");
    let response = reqwest::Client::new().get(format!("https://api.ucloud.cn/?{query}")).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("UCloud 请求失败: {error}"))?;
    let status = response.status();
    let data: Value = response.json().await.map_err(|error| format!("UCloud 返回解析失败: {error}"))?;
    if !status.is_success() || data.get("RetCode").and_then(Value::as_i64).unwrap_or(0) != 0 {
        let message = data.get("Message").or_else(|| data.get("message")).and_then(Value::as_str).unwrap_or("UCloud API 返回错误").to_string();
        write_api_log(&access_key_id, "api.ucloud.cn", action, &json!(params), Some(&data), "失败", Some(&message));
        return Err(message);
    }
    write_api_log(&access_key_id, "api.ucloud.cn", action, &json!(params), Some(&data), "成功", None);
    Ok(data)
}

async fn pages(id: i64, action: &str, region: &str, keys: &[&str]) -> Result<Vec<Value>, String> {
    let mut items = Vec::new();
    for offset in (0..100_000).step_by(100) {
        let data = request(id, action, string_params(&[("Region", region.into()), ("Offset", offset.to_string()), ("Limit", "100".into())])).await?;
        let page = keys.iter().flat_map(|key| array_at(&data, &[*key]).into_iter().cloned()).collect::<Vec<_>>();
        let count = page.len();
        items.extend(page);
        let total = data.get("TotalCount").or_else(|| data.get("Total")).and_then(Value::as_u64).unwrap_or(u64::MAX) as usize;
        if count < 100 || items.len() >= total { return Ok(items); }
    }
    Err("分页超过 1000 页，已停止读取".into())
}

fn first_ip(item: &Value, public: bool) -> Value {
    let Some(values) = item.get("IPSet").and_then(Value::as_array) else { return json!(""); };
    values.iter().find(|value| value.get("Type").and_then(Value::as_str).map(|kind| (kind == "EIP") == public).unwrap_or(!public)).and_then(|value| value.get("IP").or_else(|| value.get("Ip"))).cloned().unwrap_or(json!(""))
}

fn instance(item: &Value, region: &str) -> Value { json!({"InstanceId": item.get("UHostId"), "InstanceName": item.get("Name").or_else(|| item.get("UHostId")), "InstanceStatus": item.get("State"), "Status": item.get("State"), "PublicIpAddress": first_ip(item, true), "PrivateIpAddress": first_ip(item, false), "InstanceType": item.get("UHostType").or_else(|| item.get("CPU")), "VpcId": item.get("VPCId"), "_region_id": region, "_raw": item}) }
fn rds(item: &Value, region: &str) -> Value { json!({"DBInstanceId": item.get("DBId"), "DBInstanceDescription": item.get("Name").or_else(|| item.get("DBId")), "DBInstanceStatus": item.get("State"), "DBInstanceClass": item.get("MemoryLimit").or_else(|| item.get("DBType")), "DBInstanceStorage": item.get("DiskSpace").unwrap_or(&json!(0)), "ConnectionString": item.get("VirtualIP"), "Port": item.get("Port"), "Engine": item.get("DBType"), "EngineVersion": item.get("DBVersion"), "CreateTime": item.get("CreateTime"), "_region_id": region, "_raw": item}) }
fn redis(item: &Value, region: &str) -> Value { json!({"InstanceId": item.get("GroupId"), "InstanceName": item.get("Name").or_else(|| item.get("GroupId")), "InstanceStatus": item.get("State"), "InstanceType": "Redis", "InstanceClass": item.get("MemoryLimit"), "Capacity": item.get("MemoryLimit").unwrap_or(&json!(0)), "ConnectionDomain": item.get("VirtualIP").or_else(|| item.get("VIP")), "Port": item.get("Port"), "EngineVersion": item.get("Version"), "NetworkType": item.get("VPCId"), "_region_id": region, "_raw": item}) }
fn bucket(item: &Value, region: &str) -> Value { let name = item.get("BucketName").or_else(|| item.get("Name")); json!({"Name": name, "BucketName": name, "Location": item.get("Region").unwrap_or(&json!(region)), "CreationDate": item.get("CreateTime"), "StorageClass": item.get("StorageClass").unwrap_or(&json!("STANDARD")), "Acl": item.get("ACL").unwrap_or(&json!("private")), "ExtranetEndpoint": "-", "IntranetEndpoint": "-", "_region_id": item.get("Region").unwrap_or(&json!(region)), "_raw": item}) }
fn zone(item: &Value) -> Value { json!({"DomainName": item.get("DomainName").or_else(|| item.get("Domain")), "DomainStatus": item.get("Status").unwrap_or(&json!("ACTIVE")), "ZoneId": item.get("DomainId").or_else(|| item.get("DomainName")), "RecordCount": item.get("RecordCount").unwrap_or(&json!(0)), "RegistrationDate": item.get("CreateTime"), "_region_id": "global", "_ucloud_dns": true, "_raw": item}) }

pub(crate) async fn resource_items(id: i64, resource_type: &str) -> ResourceResponse {
    let now = Utc::now().timestamp_millis();
    let regions = match configured_regions(id, "cn-bj2") { Ok(value) => value, Err(error) => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![error], fetched_at: now } };
    let mut items = Vec::new();
    let mut errors = Vec::new();
    if resource_type == "domain" {
        match request(id, "DescribeUDNSDomain", string_params(&[("Offset", "0".into()), ("Limit", "100".into())])).await {
            Ok(data) => items.extend(array_at(&data, &["DomainSet"]).into_iter().map(zone)),
            Err(error) => errors.push(error),
        }
        return ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now };
    }
    let service = match resource_type { "ecs" => Some(("DescribeUHostInstance", vec!["UHostSet"])), "rds" => Some(("DescribeUDBInstance", vec!["DataSet"])), "redis" => Some(("DescribeURedisGroup", vec!["DataSet"])), "oss" => Some(("DescribeUFileBucket", vec!["DataSet"])), _ => None };
    let Some((action, keys)) = service else { return ResourceResponse { resource_type: resource_type.into(), items, errors: vec![format!("UCloud 暂未接入 {resource_type} 资源")], fetched_at: now }; };
    for region in regions {
        match pages(id, action, &region, &keys).await {
            Ok(values) => for item in values { items.push(match resource_type { "ecs" => instance(&item, &region), "rds" => rds(&item, &region), "redis" => redis(&item, &region), "oss" => bucket(&item, &region), _ => item }); },
            Err(error) => errors.push(format!("{region}: {error}")),
        }
    }
    ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now }
}

#[tauri::command]
pub(crate) async fn verify_ucloud_account(id: i64) -> Result<Value, String> {
    let regions = configured_regions(id, "cn-bj2")?;
    request(id, "DescribeUHostInstance", string_params(&[("Region", regions[0].clone()), ("Offset", "0".into()), ("Limit", "1".into())])).await?;
    Ok(json!({"provider":"ucloud","verified":true,"region_count":regions.len(),"regions":regions,"default_region":configured_regions(id, "cn-bj2")?[0]}))
}
