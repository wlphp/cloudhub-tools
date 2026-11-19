use chrono::Utc;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use uuid::Uuid;
use crate::ResourceResponse;

fn sign(key: &[u8], value: &str) -> Result<Vec<u8>, String> { let mut mac: Hmac<Sha256> = <Hmac<Sha256> as Mac>::new_from_slice(key).map_err(|error| error.to_string())?; mac.update(value.as_bytes()); Ok(mac.finalize().into_bytes().to_vec()) }
fn query(params: &BTreeMap<String, String>) -> String { params.iter().map(|(key, value)| (crate::rpc_encode(key), crate::rpc_encode(value))).map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>().join("&") }
async fn request(id: i64, service: &str, region: &str, path: &str, params: BTreeMap<String, String>) -> Result<Value, String> {
    if crate::account_cloud_type(id)? != "jdcloud" { return Err("当前账号不是京东云账号".into()); }
    let (access_key_id, access_key_secret) = crate::account_credentials(id)?; let datetime = Utc::now().format("%Y%m%dT%H%M%SZ").to_string(); let date = &datetime[..8]; let host = if service == "oss" { "oss.jdcloud-api.com".to_string() } else if service == "domainservice" { "domainservice.jdcloud-api.com".to_string() } else { format!("{service}.{region}.jdcloud-api.com") }; let query_text = query(&params); let nonce = Uuid::new_v4().to_string(); let payload_hash = format!("{:x}", Sha256::digest(b"")); let canonical_headers = format!("host:{host}\nx-jdcloud-date:{datetime}\nx-jdcloud-nonce:{nonce}\n"); let signed_headers = "host;x-jdcloud-date;x-jdcloud-nonce"; let canonical_request = format!("GET\n{path}\n{query_text}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"); let scope = format!("{date}/{region}/{service}/jdcloud2_request"); let string_to_sign = format!("JDCLOUD2-HMAC-SHA256\n{datetime}\n{scope}\n{:x}", Sha256::digest(canonical_request.as_bytes())); let date_key = sign(format!("JDCLOUD2{access_key_secret}").as_bytes(), date)?; let region_key = sign(&date_key, region)?; let service_key = sign(&region_key, service)?; let signing_key = sign(&service_key, "jdcloud2_request")?; let authorization = format!("JDCLOUD2-HMAC-SHA256 Credential={access_key_id}/{scope}, SignedHeaders={signed_headers}, Signature={}", hex::encode(sign(&signing_key, &string_to_sign)?));
    let response = reqwest::Client::new().get(format!("https://{host}{path}{}", if query_text.is_empty() { String::new() } else { format!("?{query_text}") })).header("Host", &host).header("X-Jdcloud-Date", &datetime).header("X-Jdcloud-Nonce", nonce).header("Authorization", authorization).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("京东云请求失败: {error}"))?; let status = response.status(); let data: Value = response.json().await.map_err(|error| format!("京东云返回解析失败: {error}"))?; if !status.is_success() { let message = data.pointer("/error/message").or_else(|| data.get("message")).or_else(|| data.get("code")).and_then(Value::as_str).unwrap_or("京东云 API 返回错误").to_string(); crate::write_api_log(&access_key_id, &host, &format!("GET {path}"), &json!(params), Some(&data), "失败", Some(&message)); return Err(message); } crate::write_api_log(&access_key_id, &host, &format!("GET {path}"), &json!(params), Some(&data), "成功", None); Ok(data)
}

/// 京东云财务接口使用独立 host（asset / billing）且账单为 POST JSON；现有 GET 签名器无法复用。
async fn signed_request(id: i64, method: &str, service: &str, region: &str, host: &str, path: &str, query_params: &BTreeMap<String, String>, body: Option<&Value>) -> Result<Value, String> {
    if crate::account_cloud_type(id)? != "jdcloud" { return Err("当前账号不是京东云账号".into()); }
    let (access_key_id, access_key_secret) = crate::account_credentials(id)?;
    let datetime = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let date = &datetime[..8];
    let query_text = query(query_params);
    let nonce = Uuid::new_v4().to_string();
    let body_text = body.map(serde_json::to_string).transpose().map_err(|_| "京东云请求序列化失败".to_string())?;
    let payload_hash = format!("{:x}", Sha256::digest(body_text.as_deref().unwrap_or("").as_bytes()));
    let (canonical_headers, signed_headers) = if body_text.is_some() {
        (format!("content-type:application/json\nhost:{host}\nx-jdcloud-date:{datetime}\nx-jdcloud-nonce:{nonce}\n"), "content-type;host;x-jdcloud-date;x-jdcloud-nonce")
    } else {
        (format!("host:{host}\nx-jdcloud-date:{datetime}\nx-jdcloud-nonce:{nonce}\n"), "host;x-jdcloud-date;x-jdcloud-nonce")
    };
    let canonical_request = format!("{method}\n{path}\n{query_text}\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let scope = format!("{date}/{region}/{service}/jdcloud2_request");
    let string_to_sign = format!("JDCLOUD2-HMAC-SHA256\n{datetime}\n{scope}\n{:x}", Sha256::digest(canonical_request.as_bytes()));
    let date_key = sign(format!("JDCLOUD2{access_key_secret}").as_bytes(), date)?;
    let region_key = sign(&date_key, region)?;
    let service_key = sign(&region_key, service)?;
    let signing_key = sign(&service_key, "jdcloud2_request")?;
    let authorization = format!("JDCLOUD2-HMAC-SHA256 Credential={access_key_id}/{scope}, SignedHeaders={signed_headers}, Signature={}", hex::encode(sign(&signing_key, &string_to_sign)?));
    let url = format!("https://{host}{path}{}", if query_text.is_empty() { String::new() } else { format!("?{query_text}") });
    let client = reqwest::Client::new();
    let mut request = match method {
        "POST" => client.post(url),
        "PUT" => client.put(url),
        "DELETE" => client.delete(url),
        _ => client.get(url),
    }
    .header("Host", host)
    .header("X-Jdcloud-Date", &datetime)
    .header("X-Jdcloud-Nonce", nonce)
    .header("Authorization", authorization)
    .timeout(std::time::Duration::from_secs(30));
    if let Some(body_text) = body_text {
        request = request.header("Content-Type", "application/json").body(body_text);
    }
    let response = request.send().await.map_err(|error| format!("京东云请求失败: {error}"))?;
    let status = response.status();
    let data: Value = response.json().await.map_err(|error| format!("京东云返回解析失败: {error}"))?;
    if !status.is_success() {
        let message = data.pointer("/error/message").or_else(|| data.get("message")).or_else(|| data.get("code")).and_then(Value::as_str).unwrap_or("京东云 API 返回错误").to_string();
        crate::write_api_log(&access_key_id, host, &format!("{method} {path}"), &json!({}), Some(&data), "失败", Some(&message));
        return Err(message);
    }
    crate::write_api_log(&access_key_id, host, &format!("{method} {path}"), &json!({}), Some(&data), "成功", None);
    Ok(data)
}

pub(crate) async fn finance_snapshot(id: i64) -> Result<Value, String> {
    if crate::account_cloud_type(id)? != "jdcloud" { return Err("当前账号不是京东云账号".into()); }
    let (access_key_id, _) = crate::account_credentials(id)?;
    let region = crate::configured_regions(id, "cn-north-1")?.first().cloned().unwrap_or_else(|| "cn-north-1".into());
    let mut payload = crate::cloud::finance::base("jdcloud");
    crate::cloud::finance::set_cloud_identity(&mut payload, Some(access_key_id.clone()), Some("京东云账号"));
    let balance = signed_request(id, "GET", "asset", &region, "asset.jdcloud-api.com", &format!("/v1/regions/{}/assets%3AdescribeAccountAmount", crate::rpc_encode(&region)), &BTreeMap::new(), None).await;
    match balance {
        Ok(data) => {
            let result = data.get("result").unwrap_or(&data);
            let available = crate::cloud::finance::number_field(result, &["availableAmount", "totalAmount"]);
            let cash = crate::cloud::finance::number_field(result, &["totalAmount", "availableAmount"]);
            let frozen = crate::cloud::finance::number_field(result, &["frozenAmount"]);
            if available.is_none() && cash.is_none() {
                crate::cloud::finance::set_balance_error(&mut payload, "余额接口未返回可用金额字段");
            } else {
                crate::cloud::finance::set_balance_ok(&mut payload, available, cash, None);
                if let Some(frozen) = frozen {
                    payload["frozen_amount"] = json!(frozen);
                }
                payload["currency"] = json!("CNY");
            }
        }
        Err(error) => crate::cloud::finance::set_balance_error(&mut payload, &error),
    }
    let cycle = Utc::now().format("%Y-%m").to_string();
    let bill_body = json!({
        "startTime": format!("{cycle}-01 00:00:00"),
        "endTime": Utc::now().format("%Y-%m-%d 23:59:59").to_string(),
        "appCode": "",
        "serviceCode": "",
        "resourceIds": [],
        "tags": [],
        "pageIndex": 1,
        "pageSize": 100
    });
    let bill_path = format!("/v1/regions/{}/billSummary%3Alist", crate::rpc_encode(&region));
    match signed_request(id, "POST", "billing", &region, "billing.jdcloud-api.com", &bill_path, &BTreeMap::new(), Some(&bill_body)).await {
        Ok(data) => {
            let result = data.get("result").unwrap_or(&data);
            let items = result.get("result").and_then(Value::as_array)
                .or_else(|| result.get("data").and_then(Value::as_array))
                .or_else(|| result.as_array());
            match items {
                Some(items) => {
                    let consume = items.iter().filter_map(|item| crate::cloud::finance::number_field(item, &["realTotalFee", "cashPayFee", "balancePayFee", "totalFee"])).sum::<f64>();
                    let bill = items.iter().filter_map(|item| crate::cloud::finance::number_field(item, &["totalFee", "realTotalFee"])).sum::<f64>();
                    crate::cloud::finance::set_consume_ok(&mut payload, Some(consume), Some(bill));
                }
                None => crate::cloud::finance::set_consume_error(&mut payload, "账单接口返回格式不兼容"),
            }
        }
        Err(error) => crate::cloud::finance::set_consume_error(&mut payload, &error),
    }
    Ok(payload)
}

fn first_string(value: Option<&Value>) -> Value { match value { Some(Value::String(v)) if !v.is_empty() => json!(v), Some(Value::Array(v)) => v.iter().find_map(Value::as_str).map(|v| json!(v)).unwrap_or(json!("")), Some(v) => v.clone(), None => json!("") } }
fn instance(item: &Value, region: &str) -> Value { json!({"InstanceId": item.get("instanceId").or_else(|| item.get("id")), "InstanceName": item.get("name").or_else(|| item.get("instanceId")), "InstanceStatus": item.get("status"), "Status": item.get("status"), "PublicIpAddress": first_string(item.get("elasticIp").or_else(|| item.get("publicIpAddress"))), "PrivateIpAddress": first_string(item.get("privateIpAddress")), "InstanceType": item.get("instanceType").unwrap_or(&json!("")), "VpcId": item.get("vpcId").unwrap_or(&json!("")), "_region_id": region, "_raw": item}) }
fn rds(item: &Value, region: &str) -> Value { json!({"DBInstanceId": item.get("instanceId").or_else(|| item.get("id")), "DBInstanceDescription": item.get("instanceName").or_else(|| item.get("name")).or_else(|| item.get("instanceId")), "DBInstanceStatus": item.get("instanceStatus").or_else(|| item.get("status")), "DBInstanceClass": item.get("instanceClass").or_else(|| item.get("instanceType")), "DBInstanceStorage": item.get("instanceStorageGB").or_else(|| item.get("storageGB")).unwrap_or(&json!(0)), "ConnectionString": item.get("internalDomainName").or_else(|| item.get("connectionString")), "Port": item.get("port"), "Engine": item.get("engine").or_else(|| item.get("engineType")), "EngineVersion": item.get("engineVersion"), "CreateTime": item.get("createTime"), "_region_id": region, "_raw": item}) }
fn redis(item: &Value, region: &str) -> Value { json!({"InstanceId": item.get("cacheInstanceId").or_else(|| item.get("instanceId")).or_else(|| item.get("id")), "InstanceName": item.get("cacheInstanceName").or_else(|| item.get("name")).or_else(|| item.get("cacheInstanceId")), "InstanceStatus": item.get("cacheInstanceStatus").or_else(|| item.get("status")), "InstanceType": "Redis", "InstanceClass": item.get("cacheInstanceClass").or_else(|| item.get("instanceClass")), "Capacity": item.get("cacheInstanceMemoryMB").or_else(|| item.get("memory")).unwrap_or(&json!(0)), "ConnectionDomain": item.get("cacheInstanceDomainName").or_else(|| item.get("connectionDomain")), "Port": item.get("port"), "EngineVersion": item.get("engineVersion"), "NetworkType": item.get("vpcId"), "_region_id": region, "_raw": item}) }
fn bucket(item: &Value, region: &str) -> Value { let name = item.get("name").or_else(|| item.get("bucketName")).or_else(|| item.get("bucket")); json!({"Name": name, "BucketName": name, "Location": item.get("location").or_else(|| item.get("region")).unwrap_or(&json!(region)), "CreationDate": item.get("creationDate").or_else(|| item.get("createTime")), "StorageClass": item.get("storageClass").unwrap_or(&json!("STANDARD")), "Acl": item.get("acl").unwrap_or(&json!("private")), "ExtranetEndpoint": name.and_then(Value::as_str).filter(|v| !v.is_empty()).map(|v| format!("{v}.s3.{region}.jdcloud-oss.com")).unwrap_or_else(|| "-".into()), "IntranetEndpoint": "-", "_region_id": item.get("location").or_else(|| item.get("region")).unwrap_or(&json!(region)), "_raw": item}) }
fn zone(item: &Value, region: &str) -> Value { json!({"DomainName": item.get("domainName").or_else(|| item.get("domain")).or_else(|| item.get("name")), "DomainStatus": item.get("status").unwrap_or(&json!("ACTIVE")), "ZoneId": item.get("id").or_else(|| item.get("domainId")).or_else(|| item.get("domainName")), "RecordCount": item.get("recordCount").or_else(|| item.get("recordNum")).unwrap_or(&json!(0)), "RegistrationDate": item.get("createTime"), "_region_id": region, "_jdcloud_dns": true, "_raw": item}) }
fn swas_field<'a>(item: &'a Value, keys: &[&str]) -> Option<&'a Value> { keys.iter().find_map(|key| item.get(*key).filter(|value| !value.is_null())) }

fn swas(item: &Value, region: &str, plan: Option<&Value>, image: Option<&Value>) -> Value {
    let charge_type = swas_field(item, &["chargeType", "ChargeType"]).cloned().unwrap_or(Value::Null);
    let payment_timing = charge_type.as_str().map(|value| {
        if value.to_ascii_lowercase().contains("postpaid") { "Postpaid" }
        else if value.to_ascii_lowercase().contains("prepaid") || value.to_ascii_lowercase().contains("duration") { "Prepaid" }
        else { "" }
    }).unwrap_or("");
    json!({
        "InstanceId": swas_field(item, &["instanceId", "InstanceId", "id"]).unwrap_or(&Value::Null),
        "InstanceName": swas_field(item, &["instanceName", "InstanceName", "name", "instanceId"]).unwrap_or(&Value::Null),
        "InstanceStatus": swas_field(item, &["status", "instanceStatus", "InstanceStatus"]).unwrap_or(&Value::Null),
        "Status": swas_field(item, &["status", "instanceStatus", "InstanceStatus"]).unwrap_or(&Value::Null),
        "PublicIpAddress": first_string(swas_field(item, &["publicIpAddress", "PublicIpAddress", "elasticIp", "publicIp"])),
        "PrivateIpAddress": first_string(swas_field(item, &["innerIpAddress", "privateIpAddress", "privateIp", "InnerIpAddress"])),
        "InstanceType": swas_field(item, &["instanceType", "planName", "planId", "PlanId"]).or_else(|| plan.and_then(|value| swas_field(value, &["planName", "name"]))).unwrap_or(&Value::Null),
        "PlanId": swas_field(item, &["planId", "PlanId", "planName"]).unwrap_or(&Value::Null),
        "ImageId": swas_field(item, &["imageId", "ImageId", "imageName"]).unwrap_or(&Value::Null),
        "ImageName": swas_field(item, &["imageName", "ImageName"]).or_else(|| image.and_then(|value| swas_field(value, &["imageName", "ImageName"]))).unwrap_or(&Value::Null),
        "ImagePlatform": image.and_then(|value| swas_field(value, &["platform", "osType"])).unwrap_or(&Value::Null),
        "Cpu": swas_field(item, &["cpu", "cpuCores", "vCpu", "Cpu", "CPU"]).or_else(|| plan.and_then(|value| swas_field(value, &["core", "cpu"]))).unwrap_or(&Value::Null),
        "Memory": swas_field(item, &["memory", "memorySize", "memoryMB", "Memory"]).or_else(|| plan.and_then(|value| swas_field(value, &["memory"]))).unwrap_or(&Value::Null),
        "Bandwidth": swas_field(item, &["bandwidth", "bandwidthMbps", "Bandwidth"]).or_else(|| plan.and_then(|value| swas_field(value, &["bandwidth"]))).unwrap_or(&Value::Null),
        "SystemDiskSize": swas_field(item, &["systemDiskSize", "SystemDiskSize"]).or_else(|| plan.and_then(|value| swas_field(value, &["diskSize"]))).or_else(|| image.and_then(|value| swas_field(value, &["systemDiskSize"]))).unwrap_or(&Value::Null),
        "DiskType": plan.and_then(|value| swas_field(value, &["diskType"])).unwrap_or(&Value::Null),
        "MonthlyFlow": plan.and_then(|value| swas_field(value, &["flow"])).unwrap_or(&Value::Null),
        "PlanClassification": plan.and_then(|value| swas_field(value, &["classification"])).unwrap_or(&Value::Null),
        "OSType": swas_field(item, &["osType", "platform"]).or_else(|| image.and_then(|value| swas_field(value, &["platform", "osType"]))).unwrap_or(&Value::Null),
        "ExpiredTime": swas_field(item, &["expiredTime", "ExpiredTime", "expirationTime", "expireTime"]).unwrap_or(&Value::Null),
        "CreateTime": swas_field(item, &["createdTime", "createTime", "CreateTime", "CreationTime"]).unwrap_or(&Value::Null),
        "CreationTime": swas_field(item, &["createdTime", "createTime", "CreateTime", "CreationTime"]).unwrap_or(&Value::Null),
        "PaymentTiming": payment_timing,
        "ChargeType": charge_type,
        "BusinessStatus": swas_field(item, &["businessStatus", "BusinessStatus"]).unwrap_or(&Value::Null),
        "RegionId": swas_field(item, &["regionId", "RegionId"]).unwrap_or(&json!(region)),
        "VpcId": swas_field(item, &["vpcId", "VpcId"]).unwrap_or(&Value::Null),
        "_region_id": region,
        "_raw": item
    })
}

pub(crate) async fn resource_items(id: i64, resource_type: &str) -> ResourceResponse {
    let now = Utc::now().timestamp_millis(); let regions = match crate::configured_regions(id, "cn-north-1") { Ok(v) => v, Err(e) => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![e], fetched_at: now } }; let mut items = Vec::new(); let mut errors = Vec::new();
    let definition = match resource_type { "ecs" => Some(("vm", "v1", "instances")), "rds" => Some(("rds", "v1", "instances")), "redis" => Some(("redis", "v1", "cacheInstance")), "oss" => Some(("oss", "v1", "buckets")), "domain" => Some(("domainservice", "v2", "domain")), "swas" => Some(("lavm", "v1", "instances")), _ => None };
    let Some((service, version, resource)) = definition else { return ResourceResponse { resource_type: resource_type.into(), items, errors: vec![format!("京东云暂未接入 {resource_type} 资源")], fetched_at: now }; };
    for region in regions { let query = if resource_type == "oss" { BTreeMap::new() } else { crate::string_params(&[("pageNumber", "1".into()), ("pageSize", "100".into())]) }; match request(id, service, &region, &format!("/{version}/regions/{}/{}", crate::rpc_encode(&region), resource), query).await { Ok(data) => { let values = crate::array_at(&data, &["result", "instances"]).into_iter().chain(crate::array_at(&data, &["result", "cacheInstances"])).chain(crate::array_at(&data, &["result", "cacheInstance"])).chain(crate::array_at(&data, &["result", "buckets"])).chain(crate::array_at(&data, &["result", "dataList"])).chain(crate::array_at(&data, &["result", "data"])).chain(crate::array_at(&data, &["buckets"])).cloned().collect::<Vec<_>>();
            if resource_type == "swas" {
                // Plans and images only enrich the instance list. Their failure must not make
                // the successful base list look incomplete, otherwise native sync keeps stale
                // cached rows and the newly mapped instance fields never become visible.
                let plans = match request(id, "lavm", &region, &format!("/v1/regions/{}/plans", crate::rpc_encode(&region)), BTreeMap::new()).await { Ok(response) => crate::array_at(&response, &["result", "plans"]).into_iter().cloned().collect::<Vec<_>>(), Err(_) => Vec::new() };
                let image_ids = values.iter().filter_map(|item| swas_field(item, &["imageId", "ImageId"]).and_then(Value::as_str)).filter(|value| !value.is_empty()).collect::<std::collections::BTreeSet<_>>();
                let images = if image_ids.is_empty() { Vec::new() } else { let encoded_ids = serde_json::to_string(&image_ids).unwrap_or_else(|_| "[]".into()); match request(id, "lavm", &region, &format!("/v1/regions/{}/images", crate::rpc_encode(&region)), crate::string_params(&[("imageIds", encoded_ids)])).await { Ok(response) => crate::array_at(&response, &["result", "images"]).into_iter().cloned().collect::<Vec<_>>(), Err(_) => Vec::new() } };
                for item in &values { let plan = swas_field(item, &["planId", "PlanId"]).and_then(Value::as_str).and_then(|key| plans.iter().find(|candidate| swas_field(candidate, &["planId"]).and_then(Value::as_str) == Some(key))); let image = swas_field(item, &["imageId", "ImageId"]).and_then(Value::as_str).and_then(|key| images.iter().find(|candidate| swas_field(candidate, &["imageId"]).and_then(Value::as_str) == Some(key))); items.push(swas(item, &region, plan, image)); }
            } else { for item in &values { items.push(match resource_type { "ecs" => instance(item, &region), "rds" => rds(item, &region), "redis" => redis(item, &region), "oss" => bucket(item, &region), "domain" => zone(item, &region), _ => item.clone() }); } }
        }, Err(e) => errors.push(format!("{region}: {e}")) } }
    ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now }
}

pub(crate) async fn verify_account(id: i64) -> Result<Value, String> {
    let regions = crate::configured_regions(id, "cn-north-1")?; let default_region = regions.first().cloned().ok_or_else(|| "京东云未配置可用区域".to_string())?;
    request(id, "vm", &default_region, &format!("/v1/regions/{}/instances", crate::rpc_encode(&default_region)), crate::string_params(&[("pageNumber", "1".into()), ("pageSize", "1".into())])).await?;
    Ok(json!({"provider":"jdcloud","verified":true,"region_count":regions.len(),"regions":regions,"default_region":default_region}))
}

pub(crate) async fn instance_action(id: i64, region: &str, instance_id: &str, action: &str) -> Result<Value, String> {
    if crate::account_cloud_type(id)? != "jdcloud" { return Err("当前账号不是京东云账号".into()); }
    if region.trim().is_empty() || instance_id.trim().is_empty() { return Err("缺少轻量服务器地域或实例 ID".into()); }
    let path = format!("/v1/regions/{}/instances/{}:{}", crate::rpc_encode(region), crate::rpc_encode(instance_id), action); let (access_key_id, access_key_secret) = crate::account_credentials(id)?;
    let datetime = Utc::now().format("%Y%m%dT%H%M%SZ").to_string(); let date = &datetime[..8]; let host = format!("lavm.{region}.jdcloud-api.com"); let nonce = Uuid::new_v4().to_string(); let payload_hash = format!("{:x}", Sha256::digest(b"")); let canonical_headers = format!("host:{host}\nx-jdcloud-date:{datetime}\nx-jdcloud-nonce:{nonce}\n"); let signed_headers = "host;x-jdcloud-date;x-jdcloud-nonce"; let canonical_request = format!("POST\n{path}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"); let scope = format!("{date}/{region}/lavm/jdcloud2_request"); let string_to_sign = format!("JDCLOUD2-HMAC-SHA256\n{datetime}\n{scope}\n{:x}", Sha256::digest(canonical_request.as_bytes())); let date_key = sign(format!("JDCLOUD2{access_key_secret}").as_bytes(), date)?; let region_key = sign(&date_key, region)?; let service_key = sign(&region_key, "lavm")?; let signing_key = sign(&service_key, "jdcloud2_request")?; let authorization = format!("JDCLOUD2-HMAC-SHA256 Credential={access_key_id}/{scope}, SignedHeaders={signed_headers}, Signature={}", hex::encode(sign(&signing_key, &string_to_sign)?));
    let response = reqwest::Client::new().post(format!("https://{host}{path}")).header("Host", &host).header("X-Jdcloud-Date", &datetime).header("X-Jdcloud-Nonce", nonce).header("Authorization", authorization).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("京东云请求失败: {error}"))?; let status = response.status(); let data: Value = response.json().await.map_err(|error| format!("京东云返回解析失败: {error}"))?; if !status.is_success() { let message = data.pointer("/error/message").or_else(|| data.get("message")).or_else(|| data.get("code")).and_then(Value::as_str).unwrap_or("京东云 API 返回错误").to_string(); crate::write_api_log(&access_key_id, &host, &format!("POST {path}"), &json!({"action":action}), Some(&data), "失败", Some(&message)); return Err(message); } crate::write_api_log(&access_key_id, &host, &format!("POST {path}"), &json!({"action":action}), Some(&data), "成功", None); Ok(data)
}

async fn firewall_mutation(id: i64, region: &str, method: reqwest::Method, path: &str, payload: Value) -> Result<Value, String> {
    if crate::account_cloud_type(id)? != "jdcloud" { return Err("当前账号不是京东云账号".into()); }
    let (access_key_id, access_key_secret) = crate::account_credentials(id)?;
    let datetime = Utc::now().format("%Y%m%dT%H%M%SZ").to_string(); let date = &datetime[..8]; let host = format!("lavm.{region}.jdcloud-api.com"); let nonce = Uuid::new_v4().to_string();
    // JDCloud's DELETE firewall endpoint accepts its identifying fields as query parameters,
    // not as a JSON body (which is commonly discarded by HTTP clients/proxies).
    let deleting = method == reqwest::Method::DELETE;
    let query_params = if deleting { payload.as_object().map(|values| values.iter().map(|(key, value)| (key.clone(), value.as_str().map(str::to_owned).unwrap_or_else(|| value.to_string()))).collect::<BTreeMap<_, _>>()).unwrap_or_default() } else { BTreeMap::new() };
    let query_text = query(&query_params);
    let body = if deleting { String::new() } else { serde_json::to_string(&payload).map_err(|error| error.to_string())? };
    let payload_hash = format!("{:x}", Sha256::digest(body.as_bytes()));
    let (canonical_headers, signed_headers) = if deleting { (format!("host:{host}\nx-jdcloud-date:{datetime}\nx-jdcloud-nonce:{nonce}\n"), "host;x-jdcloud-date;x-jdcloud-nonce") } else { (format!("content-type:application/json\nhost:{host}\nx-jdcloud-date:{datetime}\nx-jdcloud-nonce:{nonce}\n"), "content-type;host;x-jdcloud-date;x-jdcloud-nonce") };
    let canonical_request = format!("{}\n{path}\n{query_text}\n{canonical_headers}\n{signed_headers}\n{payload_hash}", method.as_str()); let scope = format!("{date}/{region}/lavm/jdcloud2_request"); let string_to_sign = format!("JDCLOUD2-HMAC-SHA256\n{datetime}\n{scope}\n{:x}", Sha256::digest(canonical_request.as_bytes())); let date_key = sign(format!("JDCLOUD2{access_key_secret}").as_bytes(), date)?; let region_key = sign(&date_key, region)?; let service_key = sign(&region_key, "lavm")?; let signing_key = sign(&service_key, "jdcloud2_request")?; let authorization = format!("JDCLOUD2-HMAC-SHA256 Credential={access_key_id}/{scope}, SignedHeaders={signed_headers}, Signature={}", hex::encode(sign(&signing_key, &string_to_sign)?));
    let url = format!("https://{host}{path}{}", if query_text.is_empty() { String::new() } else { format!("?{query_text}") });
    let mut request = reqwest::Client::new().request(method.clone(), url).header("Host", &host).header("X-Jdcloud-Date", &datetime).header("X-Jdcloud-Nonce", nonce).header("Authorization", authorization);
    if !deleting { request = request.header("Content-Type", "application/json").body(body); }
    let response = request.timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("京东云请求失败: {error}"))?; let status = response.status(); let data: Value = response.json().await.map_err(|error| format!("京东云返回解析失败: {error}"))?; let operation = format!("{} {path}", method.as_str());
    if !status.is_success() { let message = data.pointer("/error/message").or_else(|| data.get("message")).or_else(|| data.get("code")).and_then(Value::as_str).unwrap_or("京东云防火墙 API 返回错误").to_string(); crate::write_api_log(&access_key_id, &host, &operation, &payload, Some(&data), "失败", Some(&message)); return Err(message); }
    crate::write_api_log(&access_key_id, &host, &operation, &payload, Some(&data), "成功", None); Ok(data)
}

pub(crate) async fn list_firewall_rules(id: i64, region: &str, instance_id: &str) -> Result<Value, String> {
    let result = request(id, "lavm", region, &format!("/v1/regions/{}/firewallRule", crate::rpc_encode(region)), crate::string_params(&[("instanceId", instance_id.to_string()), ("pageSize", "100".into()), ("pageNumber", "1".into())])).await?;
    let rules = crate::array_at(&result, &["result", "firewallRules"]).into_iter().map(|rule| json!({"RuleId": rule.get("ruleId").cloned().unwrap_or(json!("")), "IpProtocol": rule.get("ruleProtocol").cloned().unwrap_or(json!("")), "PortRange": rule.get("port").cloned().unwrap_or(json!("")), "SourceCidrIp": rule.get("sourceAddress").cloned().unwrap_or(json!("")), "Policy": "accept", "Description": rule.get("remark").cloned().unwrap_or(json!(""))})).collect::<Vec<_>>();
    Ok(json!({"rules": rules}))
}

pub(crate) async fn create_firewall_rule(id: i64, region: &str, instance_id: &str, protocol: &str, port: &str, source: &str, remark: &str) -> Result<Value, String> {
    firewall_mutation(id, region, reqwest::Method::POST, &format!("/v1/regions/{}/firewallRule", crate::rpc_encode(region)), json!({"instanceId": instance_id, "sourceAddress": source, "ruleProtocol": protocol.to_ascii_uppercase(), "port": port, "remark": remark, "clientToken": Uuid::new_v4().to_string(), "regionId": region})).await
}

pub(crate) async fn delete_firewall_rule(id: i64, region: &str, instance_id: &str, rule_id: &str) -> Result<Value, String> {
    firewall_mutation(id, region, reqwest::Method::DELETE, &format!("/v1/regions/{}/firewallRule", crate::rpc_encode(region)), json!({"instanceId": instance_id, "ruleId": rule_id})).await
}

#[cfg(test)]
mod tests {
    use super::swas;
    use serde_json::json;

    #[test]
    fn maps_documented_jdcloud_light_server_fields() {
        let plan = json!({"planId":"plan-basic","core":2,"memory":4,"bandwidth":5,"diskSize":80,"flow":1000,"diskType":"SSD"});
        let image = json!({"imageId":"img-example","imageName":"Ubuntu 22.04","platform":"Ubuntu","systemDiskSize":"40"});
        let item = swas(&json!({
            "instanceId": "lavm-example", "instanceName": "web", "status": "running",
            "createdTime": "2026-01-02T03:04:05Z", "innerIpAddress": "10.0.0.8",
            "chargeType": "prepaid_by_duration", "planId": "plan-basic",
            "publicIpAddress": ["192.0.2.8"], "regionId": "cn-north-1",
            "expiredTime": "2027-01-02T03:04:05Z", "imageId": "img-example",
            "businessStatus": "normal"
        }), "cn-north-1", Some(&plan), Some(&image));

        assert_eq!(item["InstanceId"], "lavm-example");
        assert_eq!(item["PrivateIpAddress"], "10.0.0.8");
        assert_eq!(item["PlanId"], "plan-basic");
        assert_eq!(item["ImageId"], "img-example");
        assert_eq!(item["CreateTime"], "2026-01-02T03:04:05Z");
        assert_eq!(item["ExpiredTime"], "2027-01-02T03:04:05Z");
        assert_eq!(item["PaymentTiming"], "Prepaid");
        assert_eq!(item["Cpu"], 2);
        assert_eq!(item["Memory"], 4);
        assert_eq!(item["Bandwidth"], 5);
        assert_eq!(item["SystemDiskSize"], 80);
        assert_eq!(item["ImageName"], "Ubuntu 22.04");
        assert_eq!(item["MonthlyFlow"], 1000);
    }
}
