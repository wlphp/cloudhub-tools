use crate::{array_at, string_params, volc_region_id, write_api_log, xml_blocks, xml_text, ResourceResponse};
use chrono::{TimeZone, Utc};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

fn query(params: &BTreeMap<String, String>) -> String {
    let mut values = params.iter().map(|(key, value)| (crate::rpc_encode(key), crate::rpc_encode(value))).collect::<Vec<_>>();
    values.sort();
    values.into_iter().map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>().join("&")
}

fn sign(key: &[u8], value: &str) -> Result<Vec<u8>, String> {
    let mut mac: Hmac<Sha256> = <Hmac<Sha256> as Mac>::new_from_slice(key).map_err(|error| error.to_string())?;
    mac.update(value.as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}

async fn request(
    service: &str, version: &str, action: &str, mut params: BTreeMap<String, String>, region: &str,
    access_key_id: &str, access_key_secret: &str,
) -> Result<Value, String> {
    let host = "open.volcengineapi.com";
    let region = if region.is_empty() { "cn-beijing" } else { region };
    params.insert("Action".into(), action.into());
    params.insert("Version".into(), version.into());
    let query = query(&params);
    let datetime = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let date = &datetime[..8];
    let payload_hash = format!("{:x}", Sha256::digest(b""));
    let canonical_headers = format!("x-date:{datetime}\n");
    let signed_headers = "x-date";
    let canonical_request = format!("GET\n/\n{query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let credential_scope = format!("{date}/{region}/{service}/request");
    let string_to_sign = format!("HMAC-SHA256\n{datetime}\n{credential_scope}\n{:x}", Sha256::digest(canonical_request.as_bytes()));
    let date_key = sign(access_key_secret.as_bytes(), date)?;
    let region_key = sign(&date_key, region)?;
    let service_key = sign(&region_key, service)?;
    let signing_key = sign(&service_key, "request")?;
    let signature = hex::encode(sign(&signing_key, &string_to_sign)?);
    let authorization = format!("HMAC-SHA256 Credential={access_key_id}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}");
    let response = match reqwest::Client::new().get(format!("https://{host}/?{query}"))
        .header("X-Date", &datetime).header("Authorization", authorization)
        .timeout(std::time::Duration::from_secs(25)).send().await {
        Ok(response) => response,
        Err(error) => {
            let message = format!("火山引擎请求失败: {error}");
            write_api_log(access_key_id, host, action, &json!(params), None, "失败", Some(&message));
            return Err(message);
        }
    };
    let status = response.status();
    let data: Value = match response.json().await {
        Ok(data) => data,
        Err(error) => {
            let message = format!("火山引擎返回解析失败: {error}");
            write_api_log(access_key_id, host, action, &json!(params), None, "失败", Some(&message));
            return Err(message);
        }
    };
    if !status.is_success() || data.pointer("/ResponseMetadata/Error").is_some() || data.get("Error").is_some() {
        let message = data.pointer("/ResponseMetadata/Error/Message").and_then(Value::as_str)
            .or_else(|| data.pointer("/ResponseMetadata/Error/Code").and_then(Value::as_str))
            .or_else(|| data.pointer("/Error/Message").and_then(Value::as_str))
            .or_else(|| data.get("Message").and_then(Value::as_str)).unwrap_or("火山引擎 API 返回错误");
        write_api_log(access_key_id, host, action, &json!(params), Some(&data), "失败", Some(message));
        return Err(message.into());
    }
    write_api_log(access_key_id, host, action, &json!(params), Some(&data), "成功", None);
    Ok(data.get("Result").cloned().unwrap_or(data))
}

async fn json_request(
    service: &str, version: &str, action: &str, payload: Value, region: &str,
    access_key_id: &str, access_key_secret: &str,
) -> Result<Value, String> {
    let region = if region.is_empty() { "cn-beijing" } else { region };
    let host = format!("{service}.volcengineapi.com");
    let mut params = BTreeMap::new();
    params.insert("Action".into(), action.into());
    params.insert("Version".into(), version.into());
    let query = query(&params);
    let body = serde_json::to_string(&payload).map_err(|error| format!("火山引擎请求序列化失败: {error}"))?;
    let datetime = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let date = &datetime[..8];
    let payload_hash = format!("{:x}", Sha256::digest(body.as_bytes()));
    let canonical_headers = format!("x-date:{datetime}\n");
    let signed_headers = "x-date";
    let canonical_request = format!("POST\n/\n{query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let credential_scope = format!("{date}/{region}/{service}/request");
    let string_to_sign = format!("HMAC-SHA256\n{datetime}\n{credential_scope}\n{:x}", Sha256::digest(canonical_request.as_bytes()));
    let date_key = sign(access_key_secret.as_bytes(), date)?;
    let region_key = sign(&date_key, region)?;
    let service_key = sign(&region_key, service)?;
    let signing_key = sign(&service_key, "request")?;
    let signature = hex::encode(sign(&signing_key, &string_to_sign)?);
    let authorization = format!("HMAC-SHA256 Credential={access_key_id}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}");
    let response = reqwest::Client::new().post(format!("https://{host}/?{query}"))
        .header("Accept", "application/json").header("Content-Type", "application/json").header("X-Date", &datetime).header("Authorization", authorization)
        .body(body).timeout(std::time::Duration::from_secs(25)).send().await
        .map_err(|error| format!("火山引擎请求失败: {error}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|error| format!("火山引擎返回读取失败: {error}"))?;
    let data: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({"Message": text}));
    if !status.is_success() || data.pointer("/ResponseMetadata/Error").is_some() || data.get("Error").is_some() {
        let message = data.pointer("/ResponseMetadata/Error/Message").and_then(Value::as_str)
            .or_else(|| data.pointer("/ResponseMetadata/Error/Code").and_then(Value::as_str))
            .or_else(|| data.pointer("/Error/Message").and_then(Value::as_str))
            .or_else(|| data.get("Message").and_then(Value::as_str)).unwrap_or("火山引擎 API 返回错误");
        return Err(message.into());
    }
    Ok(data.get("Result").cloned().unwrap_or(data))
}

async fn tos_list_buckets(region: &str, access_key_id: &str, access_key_secret: &str) -> Result<Vec<Value>, String> {
    let region = if region.is_empty() { "cn-beijing" } else { region };
    let host = format!("tos-{region}.volces.com");
    let datetime = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let date = &datetime[..8];
    let payload_hash = format!("{:x}", Sha256::digest(b""));
    let canonical_headers = format!("host:{host}\nx-tos-content-sha256:{payload_hash}\nx-tos-date:{datetime}\n");
    let signed_headers = "host;x-tos-content-sha256;x-tos-date";
    let canonical_request = format!("GET\n/\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let credential_scope = format!("{date}/{region}/tos/request");
    let string_to_sign = format!("TOS4-HMAC-SHA256\n{datetime}\n{credential_scope}\n{:x}", Sha256::digest(canonical_request.as_bytes()));
    let date_key = sign(access_key_secret.as_bytes(), date)?;
    let region_key = sign(&date_key, region)?;
    let service_key = sign(&region_key, "tos")?;
    let signing_key = sign(&service_key, "request")?;
    let signature = hex::encode(sign(&signing_key, &string_to_sign)?);
    let authorization = format!("TOS4-HMAC-SHA256 Credential={access_key_id}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}");
    let response = reqwest::Client::new().get(format!("https://{host}/"))
        .header("Host", &host).header("X-Tos-Date", &datetime).header("X-Tos-Content-Sha256", &payload_hash).header("Authorization", authorization)
        .timeout(std::time::Duration::from_secs(25)).send().await.map_err(|error| format!("TOS 请求失败: {error}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|error| format!("TOS 返回读取失败: {error}"))?;
    if !status.is_success() {
        let message = xml_text(&body, "Message");
        return Err(format!("TOS 返回错误（{status}）：{}", if message.is_empty() { xml_text(&body, "Code") } else { message }));
    }
    let buckets = match serde_json::from_str::<Value>(&body) {
        Ok(data) => data.get("Buckets").and_then(Value::as_array).cloned()
            .or_else(|| data.pointer("/Buckets/Bucket").and_then(Value::as_array).cloned())
            .or_else(|| data.get("Bucket").and_then(Value::as_array).cloned())
            .unwrap_or_default(),
        Err(_) => xml_blocks(&body, "Bucket").into_iter().map(|bucket| json!({"Name": xml_text(&bucket, "Name"), "Location": xml_text(&bucket, "Location"), "CreationDate": xml_text(&bucket, "CreationDate")})).collect(),
    };
    Ok(buckets.into_iter().map(|bucket| {
        let name = bucket.get("Name").or_else(|| bucket.get("BucketName")).and_then(Value::as_str).unwrap_or("");
        let location = bucket.get("Location").or_else(|| bucket.get("Region")).and_then(Value::as_str).filter(|value| !value.is_empty()).unwrap_or(region);
        let creation_date = bucket.get("CreationDate").and_then(Value::as_str).unwrap_or("");
        json!({"Name": name, "Location": location, "CreationDate": creation_date, "StorageClass": "Standard", "ExtranetEndpoint": format!("{name}.tos-{location}.volces.com"), "Acl": "private"})
    }).filter(|bucket| bucket.get("Name").and_then(Value::as_str).is_some_and(|name| !name.is_empty())).collect())
}

fn instance(item: &Value, region: &str) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        let instance_id = item.get("InstanceId").or_else(|| item.get("InstanceID")).cloned().unwrap_or(json!(""));
        let status = item.get("Status").or_else(|| item.get("InstanceStatus")).cloned().unwrap_or(json!(""));
        target.insert("InstanceId".into(), instance_id.clone());
        target.insert("InstanceName".into(), item.get("InstanceName").cloned().unwrap_or(instance_id));
        target.insert("Status".into(), status.clone()); target.insert("InstanceStatus".into(), status);
        target.insert("PublicIpAddress".into(), item.get("PublicIpAddress").or_else(|| item.pointer("/PublicIpAddresses/0")).or_else(|| item.get("EipAddress")).cloned().unwrap_or(json!("")));
        target.insert("_region_id".into(), json!(region));
    }
    value
}

fn rds_instance(item: &Value, region: &str) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        let instance_id = item.get("DBInstanceId").or_else(|| item.get("InstanceId")).or_else(|| item.get("InstanceID")).cloned().unwrap_or(json!(""));
        target.insert("DBInstanceId".into(), instance_id.clone());
        target.insert("DBInstanceDescription".into(), item.get("DBInstanceName").or_else(|| item.get("InstanceName")).cloned().unwrap_or(instance_id));
        target.insert("DBInstanceStatus".into(), item.get("Status").or_else(|| item.get("DBInstanceStatus")).cloned().unwrap_or(json!("")));
        target.insert("Engine".into(), item.get("Engine").cloned().unwrap_or(json!("MySQL")));
        target.insert("_region_id".into(), json!(region));
    }
    value
}

fn swas_instance(item: &Value, region: &str) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        let instance_id = item.get("InstanceId").or_else(|| item.get("InstanceID")).cloned().unwrap_or(json!(""));
        let status = item.get("Status").or_else(|| item.get("InstanceStatus")).cloned().unwrap_or(json!(""));
        target.insert("InstanceId".into(), instance_id.clone());
        target.insert("InstanceName".into(), item.get("InstanceName").or_else(|| item.get("Name")).cloned().unwrap_or(instance_id));
        target.insert("Status".into(), status.clone()); target.insert("InstanceStatus".into(), status);
        target.insert("PublicIpAddress".into(), item.get("PublicIpAddress").or_else(|| item.get("PublicIp")).or_else(|| item.pointer("/PublicIpAddresses/0")).or_else(|| item.get("EipAddress")).cloned().unwrap_or(json!("")));
        target.insert("_region_id".into(), json!(region));
    }
    value
}

fn redis_instance(item: &Value, region: &str) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        let instance_id = item.get("InstanceId").or_else(|| item.get("InstanceID")).or_else(|| item.get("DBInstanceId")).or_else(|| item.get("RedisInstanceId")).cloned().unwrap_or(json!(""));
        let status = item.get("Status").or_else(|| item.get("InstanceStatus")).cloned().unwrap_or(json!(""));
        target.insert("KVStoreInstanceId".into(), instance_id.clone()); target.insert("InstanceId".into(), instance_id.clone());
        target.insert("InstanceName".into(), item.get("InstanceName").or_else(|| item.get("DBInstanceName")).or_else(|| item.get("Name")).cloned().unwrap_or(instance_id));
        target.insert("InstanceStatus".into(), status.clone()); target.insert("DBInstanceStatus".into(), status);
        target.insert("EngineVersion".into(), item.get("EngineVersion").or_else(|| item.get("RedisVersion")).cloned().unwrap_or(json!("Redis")));
        target.insert("_region_id".into(), json!(region));
    }
    value
}

fn edge_domain(item: &Value) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        let domain = item.get("DomainName").or_else(|| item.get("Domain")).or_else(|| item.get("Name")).cloned().unwrap_or(json!(""));
        target.insert("SiteId".into(), item.get("DomainId").or_else(|| item.get("DomainID")).cloned().unwrap_or(domain.clone()));
        target.insert("SiteName".into(), domain.clone()); target.insert("DomainName".into(), domain);
        target.insert("Status".into(), item.get("Status").or_else(|| item.get("DomainStatus")).cloned().unwrap_or(json!("")));
        target.insert("AccessType".into(), item.get("ServiceType").or_else(|| item.get("BusinessType")).cloned().unwrap_or(json!("CDN")));
        target.insert("Coverage".into(), item.get("Area").or_else(|| item.get("Scope")).cloned().unwrap_or(json!("")));
        target.insert("PlanName".into(), item.get("Plan").or_else(|| item.get("ProductType")).cloned().unwrap_or(json!("")));
    }
    value
}

fn dns_zone(item: &Value) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        let expires_at = item.get("ExpiredTime").and_then(Value::as_i64).unwrap_or_default();
        let expiration = if expires_at > 0 {
            let timestamp = if expires_at < 1_000_000_000_000 { expires_at.saturating_mul(1_000) } else { expires_at };
            Utc.timestamp_millis_opt(timestamp).single().map(|value| value.to_rfc3339()).unwrap_or_default()
        } else { String::new() };
        target.insert("DomainName".into(), item.get("ZoneName").cloned().unwrap_or(json!("")));
        target.insert("DomainStatus".into(), json!("正常"));
        target.insert("RegistrationDate".into(), item.get("CreatedAt").cloned().unwrap_or(json!("")));
        target.insert("ExpirationDate".into(), json!(expiration));
        target.insert("RecordCount".into(), item.get("RecordCount").cloned().unwrap_or(json!(0)));
    }
    value
}

pub(crate) async fn resource_items(id: i64, resource_type: &str, access_key_id: &str, access_key_secret: &str) -> ResourceResponse {
    let mut items = Vec::new();
    let mut errors = Vec::new();
    let region = match volc_region_id(id) {
        Ok(region) => region,
        Err(error) => return ResourceResponse { resource_type: resource_type.into(), items, errors: vec![error], fetched_at: Utc::now().timestamp_millis() },
    };
    match resource_type {
        "ecs" => match request("ecs", "2020-04-01", "DescribeInstances", string_params(&[("PageSize", "100".into()), ("PageNumber", "1".into())]), &region, access_key_id, access_key_secret).await {
            Ok(data) => { let source = if !array_at(&data, &["Instances"]).is_empty() { array_at(&data, &["Instances"]) } else { array_at(&data, &["Instances", "Instance"]) }; items.extend(source.into_iter().map(|item| instance(item, &region))); },
            Err(error) => errors.push(error),
        },
        "oss" => match tos_list_buckets(&region, access_key_id, access_key_secret).await { Ok(values) => items.extend(values), Err(error) => errors.push(error) },
        "domain" => match json_request("dns", "2018-08-01", "ListZones", json!({"PageSize": 100, "PageNumber": 1}), &region, access_key_id, access_key_secret).await {
            Ok(data) => items.extend(array_at(&data, &["Zones"]).into_iter().map(dns_zone)),
            Err(error) => errors.push(error),
        },
        "rds" => match request("rds_mysql", "2018-01-01", "DescribeDBInstances", string_params(&[("PageSize", "100".into()), ("PageNumber", "1".into())]), &region, access_key_id, access_key_secret).await {
            Ok(data) => { let source = if !array_at(&data, &["DBInstances"]).is_empty() { array_at(&data, &["DBInstances"]) } else { array_at(&data, &["Items"]) }; items.extend(source.into_iter().map(|item| rds_instance(item, &region))); },
            Err(error) => errors.push(error),
        },
        "swas" => match request("lighthouse", "2020-04-01", "DescribeInstances", string_params(&[("PageSize", "100".into()), ("PageNumber", "1".into())]), &region, access_key_id, access_key_secret).await {
            Ok(data) => { let source = if !array_at(&data, &["Instances"]).is_empty() { array_at(&data, &["Instances"]) } else { array_at(&data, &["InstanceSet"]) }; items.extend(source.into_iter().map(|item| swas_instance(item, &region))); },
            Err(error) => errors.push(error),
        },
        "redis" => match request("Redis", "2020-12-07", "DescribeDBInstances", string_params(&[("PageSize", "100".into()), ("PageNumber", "1".into())]), &region, access_key_id, access_key_secret).await {
            Ok(data) => { let source = if !array_at(&data, &["DBInstances"]).is_empty() { array_at(&data, &["DBInstances"]) } else { array_at(&data, &["Items"]) }; items.extend(source.into_iter().map(|item| redis_instance(item, &region))); },
            Err(error) => errors.push(error),
        },
        "esa" => match request("cdn", "2021-03-01", "ListCdnDomains", string_params(&[("PageSize", "100".into()), ("PageNumber", "1".into())]), &region, access_key_id, access_key_secret).await {
            Ok(data) => { let source = if !array_at(&data, &["Domains"]).is_empty() { array_at(&data, &["Domains"]) } else { array_at(&data, &["DomainList"]) }; items.extend(source.into_iter().map(edge_domain)); },
            Err(error) => errors.push(error),
        },
        other => errors.push(format!("火山引擎暂未接入 {other} 资源")),
    }
    ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: Utc::now().timestamp_millis() }
}
