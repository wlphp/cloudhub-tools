use crate::{account_cloud_type, account_credentials, array_at, aws_query, aws_sign, configured_regions, rpc_encode, string_params, value_first_string, write_api_log, ResourceResponse};
use chrono::Utc;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use uuid::Uuid;

pub(crate) async fn jdcloud_request(id: i64, service: &str, region: &str, path: &str, query: BTreeMap<String, String>) -> Result<Value, String> {
    if account_cloud_type(id)? != "jdcloud" { return Err("当前账号不是京东云账号".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let datetime = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let date = &datetime[..8];
    let host = if service == "oss" { "oss.jdcloud-api.com".to_string() } else if service == "domainservice" { "domainservice.jdcloud-api.com".to_string() } else { format!("{service}.{region}.jdcloud-api.com") };
    let query_text = aws_query(&query);
    let nonce = Uuid::new_v4().to_string();
    let payload_hash = format!("{:x}", Sha256::digest(b""));
    let canonical_headers = format!("host:{host}\nx-jdcloud-date:{datetime}\nx-jdcloud-nonce:{nonce}\n");
    let signed_headers = "host;x-jdcloud-date;x-jdcloud-nonce";
    let canonical_request = format!("GET\n{path}\n{query_text}\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let scope = format!("{date}/{region}/{service}/jdcloud2_request");
    let string_to_sign = format!("JDCLOUD2-HMAC-SHA256\n{datetime}\n{scope}\n{:x}", Sha256::digest(canonical_request.as_bytes()));
    let date_key = aws_sign(format!("JDCLOUD2{access_key_secret}").as_bytes(), date)?;
    let region_key = aws_sign(&date_key, region)?;
    let service_key = aws_sign(&region_key, service)?;
    let signing_key = aws_sign(&service_key, "jdcloud2_request")?;
    let authorization = format!("JDCLOUD2-HMAC-SHA256 Credential={access_key_id}/{scope}, SignedHeaders={signed_headers}, Signature={}", hex::encode(aws_sign(&signing_key, &string_to_sign)?));
    let response = reqwest::Client::new().get(format!("https://{host}{path}{}", if query_text.is_empty() { String::new() } else { format!("?{query_text}") })).header("Host", &host).header("X-Jdcloud-Date", &datetime).header("X-Jdcloud-Nonce", nonce).header("Authorization", authorization).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("京东云请求失败: {error}"))?;
    let status = response.status(); let data: Value = response.json().await.map_err(|error| format!("京东云返回解析失败: {error}"))?;
    if !status.is_success() { let message = data.pointer("/error/message").or_else(|| data.get("message")).or_else(|| data.get("code")).and_then(Value::as_str).unwrap_or("京东云 API 返回错误").to_string(); write_api_log(&access_key_id, &host, &format!("GET {path}"), &json!(query), Some(&data), "失败", Some(&message)); return Err(message); }
    write_api_log(&access_key_id, &host, &format!("GET {path}"), &json!(query), Some(&data), "成功", None); Ok(data)
}

pub(crate) async fn jdcloud_instance_action(id: i64, region: &str, instance_id: &str, action: &str) -> Result<Value, String> {
    let path = format!("/v1/regions/{}/instances/{}:{}", rpc_encode(region), rpc_encode(instance_id), action);
    if account_cloud_type(id)? != "jdcloud" { return Err("当前账号不是京东云账号".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let datetime = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let date = &datetime[..8];
    let host = format!("lavm.{region}.jdcloud-api.com");
    let nonce = Uuid::new_v4().to_string();
    let payload_hash = format!("{:x}", Sha256::digest(b""));
    let canonical_headers = format!("host:{host}\nx-jdcloud-date:{datetime}\nx-jdcloud-nonce:{nonce}\n");
    let signed_headers = "host;x-jdcloud-date;x-jdcloud-nonce";
    let canonical_request = format!("POST\n{path}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let scope = format!("{date}/{region}/lavm/jdcloud2_request");
    let string_to_sign = format!("JDCLOUD2-HMAC-SHA256\n{datetime}\n{scope}\n{:x}", Sha256::digest(canonical_request.as_bytes()));
    let date_key = aws_sign(format!("JDCLOUD2{access_key_secret}").as_bytes(), date)?;
    let region_key = aws_sign(&date_key, region)?;
    let service_key = aws_sign(&region_key, "lavm")?;
    let signing_key = aws_sign(&service_key, "jdcloud2_request")?;
    let authorization = format!("JDCLOUD2-HMAC-SHA256 Credential={access_key_id}/{scope}, SignedHeaders={signed_headers}, Signature={}", hex::encode(aws_sign(&signing_key, &string_to_sign)?));
    let response = reqwest::Client::new().post(format!("https://{host}{path}")).header("Host", &host).header("X-Jdcloud-Date", &datetime).header("X-Jdcloud-Nonce", nonce).header("Authorization", authorization).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("京东云请求失败: {error}"))?;
    let status = response.status(); let data: Value = response.json().await.map_err(|error| format!("京东云返回解析失败: {error}"))?;
    if !status.is_success() { return Err(data.pointer("/error/message").or_else(|| data.get("message")).or_else(|| data.get("code")).and_then(Value::as_str).unwrap_or("京东云 API 返回错误").to_string()); }
    Ok(data)
}

pub(crate) async fn jdcloud_firewall_mutation(id: i64, region: &str, method: reqwest::Method, path: &str, payload: Value) -> Result<Value, String> {
    if account_cloud_type(id)? != "jdcloud" { return Err("当前账号不是京东云账号".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let datetime = Utc::now().format("%Y%m%dT%H%M%SZ").to_string(); let date = &datetime[..8]; let host = format!("lavm.{region}.jdcloud-api.com"); let nonce = Uuid::new_v4().to_string();
    let body = serde_json::to_string(&payload).map_err(|error| error.to_string())?; let payload_hash = format!("{:x}", Sha256::digest(body.as_bytes()));
    let canonical_headers = format!("content-type:application/json\nhost:{host}\nx-jdcloud-date:{datetime}\nx-jdcloud-nonce:{nonce}\n"); let signed_headers = "content-type;host;x-jdcloud-date;x-jdcloud-nonce";
    let canonical_request = format!("{}\n{path}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}", method.as_str()); let scope = format!("{date}/{region}/lavm/jdcloud2_request"); let string_to_sign = format!("JDCLOUD2-HMAC-SHA256\n{datetime}\n{scope}\n{:x}", Sha256::digest(canonical_request.as_bytes()));
    let date_key = aws_sign(format!("JDCLOUD2{access_key_secret}").as_bytes(), date)?; let region_key = aws_sign(&date_key, region)?; let service_key = aws_sign(&region_key, "lavm")?; let signing_key = aws_sign(&service_key, "jdcloud2_request")?; let authorization = format!("JDCLOUD2-HMAC-SHA256 Credential={access_key_id}/{scope}, SignedHeaders={signed_headers}, Signature={}", hex::encode(aws_sign(&signing_key, &string_to_sign)?));
    let response = reqwest::Client::new().request(method, format!("https://{host}{path}")).header("Host", &host).header("Content-Type", "application/json").header("X-Jdcloud-Date", &datetime).header("X-Jdcloud-Nonce", nonce).header("Authorization", authorization).body(body).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("京东云请求失败: {error}"))?;
    let status = response.status(); let data: Value = response.json().await.map_err(|error| format!("京东云返回解析失败: {error}"))?; if !status.is_success() { return Err(data.pointer("/error/message").or_else(|| data.get("message")).or_else(|| data.get("code")).and_then(Value::as_str).unwrap_or("京东云防火墙 API 返回错误").to_string()); } Ok(data)
}

fn jdcloud_instance(item: &Value, region: &str) -> Value { json!({"InstanceId": item.get("instanceId").or_else(|| item.get("id")), "InstanceName": item.get("name").or_else(|| item.get("instanceId")), "InstanceStatus": item.get("status"), "Status": item.get("status"), "PublicIpAddress": value_first_string(item.get("elasticIp").or_else(|| item.get("publicIpAddress"))), "PrivateIpAddress": value_first_string(item.get("privateIpAddress")), "InstanceType": item.get("instanceType").unwrap_or(&json!("")), "VpcId": item.get("vpcId").unwrap_or(&json!("")), "_region_id": region, "_raw": item}) }
fn jdcloud_rds(item: &Value, region: &str) -> Value { json!({"DBInstanceId": item.get("instanceId").or_else(|| item.get("id")), "DBInstanceDescription": item.get("instanceName").or_else(|| item.get("name")).or_else(|| item.get("instanceId")), "DBInstanceStatus": item.get("instanceStatus").or_else(|| item.get("status")), "DBInstanceClass": item.get("instanceClass").or_else(|| item.get("instanceType")), "DBInstanceStorage": item.get("instanceStorageGB").or_else(|| item.get("storageGB")).unwrap_or(&json!(0)), "ConnectionString": item.get("internalDomainName").or_else(|| item.get("connectionString")), "Port": item.get("port"), "Engine": item.get("engine").or_else(|| item.get("engineType")), "EngineVersion": item.get("engineVersion"), "CreateTime": item.get("createTime"), "_region_id": region, "_raw": item}) }
fn jdcloud_redis(item: &Value, region: &str) -> Value { json!({"InstanceId": item.get("cacheInstanceId").or_else(|| item.get("instanceId")).or_else(|| item.get("id")), "InstanceName": item.get("cacheInstanceName").or_else(|| item.get("name")).or_else(|| item.get("cacheInstanceId")), "InstanceStatus": item.get("cacheInstanceStatus").or_else(|| item.get("status")), "InstanceType": "Redis", "InstanceClass": item.get("cacheInstanceClass").or_else(|| item.get("instanceClass")), "Capacity": item.get("cacheInstanceMemoryMB").or_else(|| item.get("memory")).unwrap_or(&json!(0)), "ConnectionDomain": item.get("cacheInstanceDomainName").or_else(|| item.get("connectionDomain")), "Port": item.get("port"), "EngineVersion": item.get("engineVersion"), "NetworkType": item.get("vpcId"), "_region_id": region, "_raw": item}) }
fn jdcloud_bucket(item: &Value, region: &str) -> Value { let name = item.get("name").or_else(|| item.get("bucketName")).or_else(|| item.get("bucket")); json!({"Name": name, "BucketName": name, "Location": item.get("location").or_else(|| item.get("region")).unwrap_or(&json!(region)), "CreationDate": item.get("creationDate").or_else(|| item.get("createTime")), "StorageClass": item.get("storageClass").unwrap_or(&json!("STANDARD")), "Acl": item.get("acl").unwrap_or(&json!("private")), "ExtranetEndpoint": name.and_then(Value::as_str).filter(|name| !name.is_empty()).map(|name| format!("{name}.s3.{region}.jdcloud-oss.com")).unwrap_or_else(|| "-".into()), "IntranetEndpoint": "-", "_region_id": item.get("location").or_else(|| item.get("region")).unwrap_or(&json!(region)), "_raw": item}) }
fn jdcloud_zone(item: &Value, region: &str) -> Value { json!({"DomainName": item.get("domainName").or_else(|| item.get("domain")).or_else(|| item.get("name")), "DomainStatus": item.get("status").unwrap_or(&json!("ACTIVE")), "ZoneId": item.get("id").or_else(|| item.get("domainId")).or_else(|| item.get("domainName")), "RecordCount": item.get("recordCount").or_else(|| item.get("recordNum")).unwrap_or(&json!(0)), "RegistrationDate": item.get("createTime"), "_region_id": region, "_jdcloud_dns": true, "_raw": item}) }
fn jdcloud_swas_instance(item: &Value, region: &str) -> Value { json!({"InstanceId": item.get("instanceId").or_else(|| item.get("id")), "InstanceName": item.get("name").or_else(|| item.get("instanceName")).or_else(|| item.get("instanceId")), "InstanceStatus": item.get("status").or_else(|| item.get("instanceStatus")), "Status": item.get("status").or_else(|| item.get("instanceStatus")), "PublicIpAddress": value_first_string(item.get("publicIpAddress").or_else(|| item.get("elasticIp")).or_else(|| item.get("publicIp"))), "PrivateIpAddress": value_first_string(item.get("privateIpAddress").or_else(|| item.get("privateIp"))), "InstanceType": item.get("instanceType").or_else(|| item.get("planName")).or_else(|| item.get("planId")).unwrap_or(&json!("")), "PlanId": item.get("planId").or_else(|| item.get("planName")).unwrap_or(&json!("")), "ImageId": item.get("imageId").or_else(|| item.get("imageName")).unwrap_or(&json!("")), "Cpu": item.get("cpu").or_else(|| item.get("cpuCores")).or_else(|| item.get("vCpu")).unwrap_or(&json!(0)), "Memory": item.get("memory").or_else(|| item.get("memorySize")).or_else(|| item.get("memoryMB")).unwrap_or(&json!(0)), "Bandwidth": item.get("bandwidth").or_else(|| item.get("bandwidthMbps")).unwrap_or(&json!(0)), "SystemDiskSize": item.get("systemDiskSize").or_else(|| item.get("systemDisk")).unwrap_or(&json!(0)), "ExpiredTime": item.get("expiredTime").or_else(|| item.get("expirationTime")).or_else(|| item.get("expireTime")).unwrap_or(&json!("")), "CreateTime": item.get("createTime").or_else(|| item.get("createdTime")).unwrap_or(&json!("")), "VpcId": item.get("vpcId").unwrap_or(&json!("")), "_region_id": region, "_raw": item}) }

pub(crate) async fn resource_items(id: i64, resource_type: &str) -> ResourceResponse {
    let now = Utc::now().timestamp_millis(); let regions = match configured_regions(id, "cn-north-1") { Ok(value) => value, Err(error) => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![error], fetched_at: now } };
    let definition = match resource_type { "ecs" => Some(("vm", "v1", "instances")), "rds" => Some(("rds", "v1", "instances")), "redis" => Some(("redis", "v1", "cacheInstance")), "oss" => Some(("oss", "v1", "buckets")), "domain" => Some(("domainservice", "v2", "domain")), "swas" => Some(("lavm", "v1", "instances")), _ => None };
    let Some((service, version, resource)) = definition else { return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![format!("京东云暂未接入 {resource_type} 资源")], fetched_at: now }; };
    let mut items = Vec::new(); let mut errors = Vec::new();
    for region in regions { let query = if resource_type == "oss" { BTreeMap::new() } else { string_params(&[("pageNumber", "1".into()), ("pageSize", "100".into())]) }; match jdcloud_request(id, service, &region, &format!("/{version}/regions/{}/{}", rpc_encode(&region), resource), query).await { Ok(data) => { let values = array_at(&data, &["result", "instances"]).into_iter().chain(array_at(&data, &["result", "cacheInstances"])).chain(array_at(&data, &["result", "cacheInstance"])).chain(array_at(&data, &["result", "buckets"])).chain(array_at(&data, &["result", "dataList"])).chain(array_at(&data, &["result", "data"])).chain(array_at(&data, &["buckets"])); for item in values { items.push(match resource_type { "ecs" => jdcloud_instance(item, &region), "rds" => jdcloud_rds(item, &region), "redis" => jdcloud_redis(item, &region), "oss" => jdcloud_bucket(item, &region), "domain" => jdcloud_zone(item, &region), "swas" => jdcloud_swas_instance(item, &region), _ => item.clone() }); } }, Err(error) => errors.push(format!("{region}: {error}")), } }
    ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now }
}

#[tauri::command]
pub(crate) async fn verify_jdcloud_account(id: i64) -> Result<Value, String> { let regions = configured_regions(id, "cn-north-1")?; jdcloud_request(id, "vm", &regions[0], &format!("/v1/regions/{}/instances", rpc_encode(&regions[0])), string_params(&[("pageNumber", "1".into()), ("pageSize", "1".into())])).await?; Ok(json!({"provider":"jdcloud","verified":true,"region_count":regions.len(),"regions":regions,"default_region":configured_regions(id, "cn-north-1")?[0]})) }

