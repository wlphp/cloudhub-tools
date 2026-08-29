use crate::{account_cloud_type, account_credentials, account_region_id, array_at, rpc_encode, string_params, ResourceResponse};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chrono::Utc;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, future::Future};
use uuid::Uuid;

fn sign(key: &[u8], value: &str) -> Result<Vec<u8>, String> {
    let mut mac: Hmac<Sha256> = <Hmac<Sha256> as Mac>::new_from_slice(key).map_err(|error| error.to_string())?;
    mac.update(value.as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}

fn total(data: &Value) -> Option<usize> {
    ["totalCount", "total", "totalNum", "totalSize"].into_iter().filter_map(|key| data.get(key)).find_map(|value| value.as_u64().map(|value| value as usize).or_else(|| value.as_str()?.parse::<usize>().ok())).or_else(|| data.get("pageInfo").or_else(|| data.get("page")).and_then(|page| page.get("total")).and_then(|value| value.as_u64().map(|value| value as usize).or_else(|| value.as_str()?.parse::<usize>().ok())))
}

async fn pages<F, Fut>(mut fetch_page: F, path: &[&str], page_size: usize) -> Result<Vec<Value>, String>
where
    F: FnMut(usize) -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    let mut items = Vec::new();
    for page in 1..=100 {
        let data = fetch_page(page).await?;
        let current = array_at(&data, path).into_iter().cloned().collect::<Vec<_>>();
        let count = current.len();
        items.extend(current);
        if count == 0 || count < page_size || total(&data).is_some_and(|total| items.len() >= total) { return Ok(items); }
    }
    Err("分页超过 100 页，已停止读取".into())
}

async fn request(endpoint: &str, method: reqwest::Method, path: &str, payload: Option<Value>, query: BTreeMap<String, String>, access_key_id: &str, access_key_secret: &str) -> Result<Value, String> {
    request_with_headers(endpoint, method, path, payload, query, BTreeMap::new(), access_key_id, access_key_secret).await
}

async fn request_with_headers(endpoint: &str, method: reqwest::Method, path: &str, payload: Option<Value>, query: BTreeMap<String, String>, extra_headers: BTreeMap<String, String>, access_key_id: &str, access_key_secret: &str) -> Result<Value, String> {
    let query = query.into_iter().map(|(key, value)| format!("{}={}", rpc_encode(&key), rpc_encode(&value))).collect::<Vec<_>>().join("&");
    let body = match payload { Some(value) => serde_json::to_string(&value).map_err(|error| format!("天翼云请求序列化失败: {error}"))?, None => String::new() };
    let datetime = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let request_id = Uuid::new_v4().to_string();
    let payload_hash = format!("{:x}", Sha256::digest(body.as_bytes()));
    let string_to_sign = format!("ctyun-eop-request-id:{request_id}\neop-date:{datetime}\n\n{query}\n{payload_hash}");
    let date_key = sign(access_key_secret.as_bytes(), &datetime)?;
    let ak_key = sign(&date_key, access_key_id)?;
    let signing_key = sign(&ak_key, &datetime[..8])?;
    let signature = B64.encode(sign(&signing_key, &string_to_sign)?);
    let authorization = format!("{access_key_id} Headers=ctyun-eop-request-id;eop-date Signature={signature}");
    let url = format!("https://{endpoint}{path}{}", if query.is_empty() { String::new() } else { format!("?{query}") });
    let mut request = reqwest::Client::new().request(method, url).header("ctyun-eop-request-id", request_id).header("Eop-date", datetime).header("Eop-Authorization", authorization).timeout(std::time::Duration::from_secs(25));
    for (key, value) in extra_headers { request = request.header(key, value); }
    if !body.is_empty() { request = request.header("Content-Type", "application/json").body(body); }
    let response = request.send().await.map_err(|error| format!("天翼云请求失败: {error}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|error| format!("天翼云返回读取失败: {error}"))?;
    let data: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({"message": text}));
    let code = data.get("code").or_else(|| data.get("statusCode")).and_then(|value| match value { Value::String(value) => Some(value.clone()), Value::Number(value) => Some(value.to_string()), _ => None }).unwrap_or_default();
    if !status.is_success() || (!code.is_empty() && !["0", "200", "800", "Success", "SUCCESS"].contains(&code.as_str())) {
        let message = data.get("message").or_else(|| data.get("msg")).or_else(|| data.pointer("/error/message")).and_then(Value::as_str).unwrap_or_else(|| if code.is_empty() { "天翼云 API 返回错误" } else { &code });
        return Err(message.into());
    }
    Ok(data.get("returnObj").or_else(|| data.get("result")).cloned().unwrap_or(data))
}

fn instance(item: &Value, region: &str) -> Value { let mut value = item.clone(); if let Value::Object(ref mut target) = value { let instance_id = item.get("InstanceID").or_else(|| item.get("instanceID")).or_else(|| item.get("ResourceID")).or_else(|| item.get("resourceID")).cloned().unwrap_or(json!("")); let name = item.get("InstanceName").or_else(|| item.get("instanceName")).or_else(|| item.get("DisplayName")).or_else(|| item.get("displayName")).cloned().unwrap_or(instance_id.clone()); let status = item.get("InstanceStatus").or_else(|| item.get("instanceStatus")).or_else(|| item.get("State")).or_else(|| item.get("state")).cloned().unwrap_or(json!("")); target.insert("InstanceId".into(), instance_id); target.insert("InstanceName".into(), name); target.insert("InstanceStatus".into(), status.clone()); target.insert("Status".into(), status); target.insert("PublicIpAddress".into(), item.get("FloatingIP").or_else(|| item.get("floatingIP")).or_else(|| item.get("PublicIP")).or_else(|| item.get("publicIP")).cloned().unwrap_or(json!(""))); target.insert("PrivateIpAddress".into(), item.get("PrivateIP").or_else(|| item.get("privateIP")).or_else(|| item.get("FixedIP")).or_else(|| item.get("fixedIP")).cloned().unwrap_or(json!(""))); target.insert("VpcId".into(), item.get("VpcID").or_else(|| item.get("vpcID")).or_else(|| item.get("VpcId")).cloned().unwrap_or(json!(""))); target.insert("InstanceType".into(), item.get("InstanceType").or_else(|| item.get("instanceType")).or_else(|| item.get("FlavorName")).or_else(|| item.get("flavorName")).cloned().unwrap_or(json!(""))); target.insert("_region_id".into(), json!(region)); } value }

fn domain(item: &Value, region: &str) -> Value { let mut value = item.clone(); if let Value::Object(ref mut target) = value { let name = item.get("name").or_else(|| item.get("ZoneName")).or_else(|| item.get("zoneName")).or_else(|| item.get("zoneID")).cloned().unwrap_or(json!("")); target.insert("DomainName".into(), name); target.insert("DomainStatus".into(), json!("私有 DNS")); target.insert("ZoneId".into(), item.get("zoneID").or_else(|| item.get("ZoneID")).cloned().unwrap_or(json!(""))); target.insert("RecordCount".into(), item.get("recordCount").cloned().unwrap_or(json!(0))); target.insert("_region_id".into(), json!(region)); target.insert("_ctyun_private_zone".into(), json!(true)); } value }

fn rds_instance(item: &Value, region: &str) -> Value { let running = item.get("prodRunningStatus").and_then(Value::as_i64) == Some(0) || item.get("prodRunningStatus").and_then(Value::as_str).is_some_and(|value| value.eq_ignore_ascii_case("running")); json!({"DBInstanceId": item.get("outerProdInstId").or_else(|| item.get("prodInstId")).cloned().unwrap_or(json!("")), "DBInstanceDescription": item.get("prodInstName").or_else(|| item.get("outerProdInstId")).cloned().unwrap_or(json!("")), "DBInstanceStatus": if running { json!("Running") } else { item.get("prodRunningStatus").or_else(|| item.get("alive")).cloned().unwrap_or(json!("Unknown")) }, "DBInstanceType": item.get("prodType").cloned().unwrap_or(json!("")), "DBInstanceClass": item.get("machineSpec").or_else(|| item.get("resources")).cloned().unwrap_or(json!("")), "DBInstanceStorage": item.get("diskSize").cloned().unwrap_or(json!(0)), "ConnectionString": item.get("vip").cloned().unwrap_or(json!("")), "Port": item.get("writePort").cloned().unwrap_or(json!("")), "Engine": item.get("prodDbEngine").cloned().unwrap_or(json!("MySQL")), "EngineVersion": item.get("newMysqlVersion").or_else(|| item.get("dbMysqlVersion")).cloned().unwrap_or(json!("")), "CreateTime": item.get("createTime").cloned().unwrap_or(json!("")), "ExpireTime": item.get("expireTime").cloned().unwrap_or(json!("")), "_region_id": region, "_raw": item}) }

fn redis_instance(item: &Value, region: &str) -> Value { let normal = item.get("status").and_then(Value::as_i64) == Some(0) || item.get("statusName").and_then(Value::as_str).is_some_and(|value| value.eq_ignore_ascii_case("normal")); let capacity = item.get("capacity").and_then(|value| value.as_f64().or_else(|| value.as_str()?.parse().ok())).unwrap_or(0.0) * 1024.0; json!({"InstanceId": item.get("prodInstId").or_else(|| item.get("user")).cloned().unwrap_or(json!("")), "InstanceName": item.get("instanceName").or_else(|| item.get("prodInstId")).cloned().unwrap_or(json!("")), "InstanceStatus": if normal { json!("Normal") } else { item.get("statusName").or_else(|| item.get("status")).cloned().unwrap_or(json!("Unknown")) }, "InstanceType": item.get("archTypeName").or_else(|| item.get("archType")).cloned().unwrap_or(json!("")), "InstanceClass": item.get("capacityInfo").or_else(|| item.get("capacity")).cloned().unwrap_or(json!("")), "Capacity": capacity, "ConnectionDomain": item.get("connectionAddress").or_else(|| item.get("vip")).cloned().unwrap_or(json!("")), "Port": item.get("vipPort").cloned().unwrap_or(json!("")), "EngineVersion": item.get("engineVersionName").or_else(|| item.get("engineVersion")).cloned().unwrap_or(json!("")), "NetworkType": item.get("netName").cloned().unwrap_or(json!("")), "EndTime": item.get("expTime").or_else(|| item.get("expiration")).cloned().unwrap_or(json!("")), "ArchitectureType": item.get("archTypeName").or_else(|| item.get("archType")).cloned().unwrap_or(json!("")), "_region_id": region, "_raw": item}) }

fn bucket(item: &Value, fallback_region: &str) -> Value { let region = item.get("regionID").or_else(|| item.get("RegionID")).and_then(Value::as_str).unwrap_or(fallback_region); json!({"Name": item.get("bucket").or_else(|| item.get("Bucket")).cloned().unwrap_or(json!("")), "Location": region, "CreationDate": item.get("creationDate").or_else(|| item.get("CreationDate")).cloned().unwrap_or(json!("")), "StorageClass": item.get("storageType").or_else(|| item.get("StorageType")).cloned().unwrap_or(json!("STANDARD")), "Acl": "private", "ExtranetEndpoint": "-", "IntranetEndpoint": "-", "_region_id": region, "_raw": item}) }

pub(crate) async fn resource_items(id: i64, resource_type: &str, access_key_id: &str, access_key_secret: &str) -> ResourceResponse {
  let mut items = Vec::new(); let mut errors = Vec::new(); let fallback = account_region_id(id).unwrap_or_else(|_| "cn-huabei-9".into()); let regions = match request("ctecs-global.ctapi.ctyun.cn", reqwest::Method::GET, "/v4/region/list-regions", None, BTreeMap::new(), access_key_id, access_key_secret).await { Ok(data) => { let mut values = array_at(&data, &["regionList"]).into_iter().filter_map(|item| item.get("regionID").or_else(|| item.get("RegionID")).and_then(Value::as_str).filter(|value| !value.is_empty()).map(String::from)).collect::<Vec<_>>(); values.push(fallback.clone()); values.sort(); values.dedup(); values }, Err(_) => vec![fallback] };
  match resource_type {
    "ecs" => for region in &regions { let region_id = region.clone(); match pages(|page_no| request("ctecs-global.ctapi.ctyun.cn", reqwest::Method::POST, "/v4/ecs/list-instances", Some(json!({"regionID": region_id, "pageNo": page_no, "pageSize": 100})), BTreeMap::new(), access_key_id, access_key_secret), &["results"], 100).await { Ok(values) => items.extend(values.iter().map(|item| instance(item, region))), Err(error) => errors.push(format!("{region}: {error}")) } },
    "domain" => for region in &regions { let region_id = region.clone(); match pages(|page_no| request("ctvpc-global.ctapi.ctyun.cn", reqwest::Method::GET, "/v4/private-zone/list", None, string_params(&[("regionID", region_id.clone()), ("pageNo", page_no.to_string()), ("pageSize", "50".into())]), access_key_id, access_key_secret), &["zones"], 50).await { Ok(values) => items.extend(values.iter().map(|item| domain(item, region))), Err(error) => errors.push(format!("{region}: {error}")) } },
    "rds" => for region in &regions { let region_id = region.clone(); match pages(|page_now| request_with_headers("rds2-global.ctapi.ctyun.cn", reqwest::Method::POST, "/RDS2/v1/open-api/instance/instance-list", Some(json!({"pageNow": page_now, "pageSize": 100})), BTreeMap::new(), string_params(&[("regionId", region_id.clone())]), access_key_id, access_key_secret), &["list"], 100).await { Ok(values) => items.extend(values.iter().map(|item| rds_instance(item, region))), Err(error) => errors.push(format!("{region}: {error}")) } },
    "redis" => for region in &regions { let region_id = region.clone(); match pages(|page_index| request_with_headers("dcs2-global.ctapi.ctyun.cn", reqwest::Method::GET, "/v2/instanceManageMgrServant/describeInstances", None, string_params(&[("pageIndex", page_index.to_string()), ("pageSize", "100".into())]), string_params(&[("regionId", region_id.clone())]), access_key_id, access_key_secret), &["rows"], 100).await { Ok(values) => items.extend(values.iter().map(|item| redis_instance(item, region))), Err(error) => errors.push(format!("{region}: {error}")) } },
    "oss" => match request("zos-global.ctapi.ctyun.cn", reqwest::Method::GET, "/v4/oss/list-regions", None, BTreeMap::new(), access_key_id, access_key_secret).await { Ok(data) => { let mut oss_regions = array_at(&data, &[]).into_iter().filter_map(|item| item.get("regionID").or_else(|| item.get("RegionID")).and_then(Value::as_str).map(String::from)).collect::<Vec<_>>(); oss_regions.push("public".into()); oss_regions.sort(); oss_regions.dedup(); for region in oss_regions { let region_id = region.clone(); match pages(|page_no| request("zos-global.ctapi.ctyun.cn", reqwest::Method::GET, "/v4/oss/list-buckets", None, string_params(&[("regionID", region_id.clone()), ("pageNo", page_no.to_string()), ("pageSize", "50".into())]), access_key_id, access_key_secret), &["bucketList"], 50).await { Ok(values) => items.extend(values.iter().map(|item| bucket(item, &region))), Err(error) => errors.push(format!("{region}: {error}")) } } }, Err(error) => errors.push(error) },
    _ => errors.push(format!("天翼云暂未提供 {resource_type} 对应的统一只读清单 API")),
  }
  ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: Utc::now().timestamp_millis() }
}

pub(crate) async fn list_private_zone_records(id: i64, region: &str, zone_id: &str, keyword: Option<&str>) -> Result<Value, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let mut query = string_params(&[("regionID", region.to_string()), ("zoneID", zone_id.to_string()), ("pageNo", "1".into()), ("pageSize", "100".into())]);
    if let Some(value) = keyword.filter(|value| !value.is_empty()) {
        query.insert("zoneRecordName".into(), value.to_string());
    }
    request(
        "ctvpc-global.ctapi.ctyun.cn",
        reqwest::Method::GET,
        "/v4/private-zone-record/list",
        None,
        query,
        &access_key_id,
        &access_key_secret,
    ).await
}

#[tauri::command]
pub(crate) async fn verify_account(id: i64) -> Result<Value, String> {
    if account_cloud_type(id)? != "ctyun" { return Err("当前账号不是天翼云账号".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let fallback = account_region_id(id).unwrap_or_else(|_| "cn-huabei-9".into());
    let data = request("ctecs-global.ctapi.ctyun.cn", reqwest::Method::GET, "/v4/region/list-regions", None, BTreeMap::new(), &access_key_id, &access_key_secret).await?;
    let mut regions = array_at(&data, &["regionList"]).into_iter().filter_map(|item| item.get("regionID").or_else(|| item.get("RegionID")).and_then(Value::as_str).filter(|value| !value.is_empty()).map(String::from)).collect::<Vec<_>>();
    if !regions.contains(&fallback) { regions.push(fallback.clone()); }
    regions.sort(); regions.dedup();
    if regions.is_empty() { return Err("未读取到可用地域，请检查 AccessKey、SecretKey 与 EOP 权限".into()); }
    Ok(json!({"provider": "ctyun", "verified": true, "region_count": regions.len(), "regions": regions, "default_region": fallback}))
}
