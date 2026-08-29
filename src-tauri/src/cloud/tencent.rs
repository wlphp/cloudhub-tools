use crate::{account_region_id, array_at, ensure_tencent_account, rpc_encode, write_api_log, xml_blocks, xml_text, ResourceResponse};
use chrono::Utc;
use hmac::{Hmac, Mac};
use percent_encoding::percent_decode_str;
use serde_json::{json, Value};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub(crate) async fn tencent_request(
    service: &str, version: &str, action: &str, payload: Value, region: Option<&str>,
    access_key_id: &str, access_key_secret: &str,
) -> Result<Value, String> {
    let host = format!("{service}.tencentcloudapi.com");
    let timestamp = Utc::now().timestamp();
    let date = Utc::now().format("%Y-%m-%d").to_string();
    let body = serde_json::to_string(&payload).map_err(|e| format!("腾讯云请求序列化失败: {e}"))?;
    let payload_hash = format!("{:x}", Sha256::digest(body.as_bytes()));
    let canonical_headers = format!("content-type:application/json; charset=utf-8\nhost:{host}\n");
    let signed_headers = "content-type;host";
    let canonical_request = format!("POST\n/\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let credential_scope = format!("{date}/{service}/tc3_request");
    let string_to_sign = format!("TC3-HMAC-SHA256\n{timestamp}\n{credential_scope}\n{:x}", Sha256::digest(canonical_request.as_bytes()));
    let sign = |key: &[u8], value: &str| -> Result<Vec<u8>, String> {
        let mut mac: Hmac<Sha256> = <Hmac<Sha256> as Mac>::new_from_slice(key).map_err(|e| e.to_string())?;
        mac.update(value.as_bytes());
        Ok(mac.finalize().into_bytes().to_vec())
    };
    let secret_date = sign(format!("TC3{access_key_secret}").as_bytes(), &date)?;
    let secret_service = sign(&secret_date, service)?;
    let secret_signing = sign(&secret_service, "tc3_request")?;
    let signature = hex::encode(sign(&secret_signing, &string_to_sign)?);
    let authorization = format!("TC3-HMAC-SHA256 Credential={access_key_id}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}");
    let mut request = reqwest::Client::new().post(format!("https://{host}/"))
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Host", &host)
        .header("Authorization", authorization)
        .header("X-TC-Action", action)
        .header("X-TC-Version", version)
        .header("X-TC-Timestamp", timestamp.to_string())
        .body(body)
        .timeout(std::time::Duration::from_secs(25));
    if let Some(region) = region.filter(|value| !value.is_empty()) { request = request.header("X-TC-Region", region); }
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => { let message = format!("腾讯云请求失败: {error}"); write_api_log(access_key_id, &host, action, &payload, None, "失败", Some(&message)); return Err(message); }
    };
    let status = response.status();
    let data: Value = match response.json().await {
        Ok(data) => data,
        Err(error) => { let message = format!("腾讯云返回解析失败: {error}"); write_api_log(access_key_id, &host, action, &payload, None, "失败", Some(&message)); return Err(message); }
    };
    if !status.is_success() || data.pointer("/Response/Error").is_some() {
        let message = data.pointer("/Response/Error/Message").and_then(Value::as_str)
            .or_else(|| data.pointer("/Response/Error/Code").and_then(Value::as_str))
            .unwrap_or("腾讯云 API 返回错误");
        write_api_log(access_key_id, &host, action, &payload, Some(&data), "失败", Some(message));
        return Err(message.into());
    }
    write_api_log(access_key_id, &host, action, &payload, Some(&data), "成功", None);
    Ok(data.get("Response").cloned().unwrap_or(Value::Null))
}


fn cos_authorization(access_key_id: &str, access_key_secret: &str, host: &str, query: &str, sign_host: bool) -> Result<String, String> {
    let start = Utc::now().timestamp() - 1; let sign_time = format!("{start};{}", start + 900);
    let mut query_items = query.split('&').filter(|value| !value.is_empty()).map(|value| {
        let mut entry = value.splitn(2, '=');
        let key = percent_decode_str(entry.next().unwrap_or("")).decode_utf8_lossy();
        let value = percent_decode_str(entry.next().unwrap_or("")).decode_utf8_lossy();
        (rpc_encode(&key), rpc_encode(&value))
    }).collect::<Vec<_>>();
    query_items.sort(); let canonical_query = query_items.iter().map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>().join("&");
    let signed_query_keys = query_items.iter().map(|(key, _)| key.as_str()).collect::<Vec<_>>().join(";");
    let canonical_request = format!("get\n/\n{canonical_query}\n{}\n", if sign_host { format!("host={host}") } else { String::new() });
    let mut key_mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|e| e.to_string())?; key_mac.update(sign_time.as_bytes());
    let sign_key = hex::encode(key_mac.finalize().into_bytes());
    let string_to_sign = format!("sha1\n{sign_time}\n{:x}\n", Sha1::digest(canonical_request.as_bytes()));
    let mut sign_mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(sign_key.as_bytes()).map_err(|e| e.to_string())?; sign_mac.update(string_to_sign.as_bytes());
    Ok(format!("q-sign-algorithm=sha1&q-ak={}&q-sign-time={sign_time}&q-key-time={sign_time}&q-header-list={}&q-url-param-list={signed_query_keys}&q-signature={}", rpc_encode(access_key_id), if sign_host { "host" } else { "" }, hex::encode(sign_mac.finalize().into_bytes())))
}

pub(crate) async fn cos_request(bucket: &str, location: &str, query: &str, access_key_id: &str, access_key_secret: &str) -> Result<String, String> {
    let host = if bucket.is_empty() { "service.cos.myqcloud.com".to_string() } else { format!("{bucket}.cos.{location}.myqcloud.com") };
    let authorization = cos_authorization(access_key_id, access_key_secret, &host, query, !bucket.is_empty())?;
    let url = if query.is_empty() { format!("https://{host}/") } else { format!("https://{host}/?{query}") };
    let response = reqwest::Client::new().get(url).header("Host", &host).header("Authorization", authorization).timeout(std::time::Duration::from_secs(25)).send().await.map_err(|e| format!("COS 请求失败: {e}"))?;
    let status = response.status(); let body = response.text().await.map_err(|e| format!("COS 返回读取失败: {e}"))?;
    if !status.is_success() { let message = { let value = xml_text(&body, "Message"); if value.is_empty() { xml_text(&body, "Code") } else { value } }; return Err(format!("COS 返回错误（{status}）：{message}")); }
    Ok(body)
}

async fn cos_list_buckets(access_key_id: &str, access_key_secret: &str) -> Result<Vec<Value>, String> {
    let body = cos_request("", "", "", access_key_id, access_key_secret).await?;
    Ok(xml_blocks(&body, "Bucket").into_iter().map(|bucket| { let name = xml_text(&bucket, "Name"); let location = xml_text(&bucket, "Location"); json!({"Name": name, "Location": location, "CreationDate": xml_text(&bucket, "CreationDate"), "StorageClass": "Standard", "ExtranetEndpoint": format!("{}.cos.{}.myqcloud.com", name, location), "IntranetEndpoint": "-", "Acl": "private"}) }).filter(|bucket| bucket.get("Name").and_then(Value::as_str).is_some_and(|name| !name.is_empty())).collect())
}

pub(crate) async fn cos_list_objects(bucket: &str, location: &str, access_key_id: &str, access_key_secret: &str, prefix: &str, marker: &str) -> Result<Value, String> {
    let mut query = "list-type=2&max-keys=1000&delimiter=%2F".to_string();
    if !prefix.is_empty() { query.push_str(&format!("&prefix={}", rpc_encode(prefix))); }
    if !marker.is_empty() { query.push_str(&format!("&continuation-token={}", rpc_encode(marker))); }
    let body = cos_request(bucket, location, &query, access_key_id, access_key_secret).await?;
    let objects = xml_blocks(&body, "Contents").into_iter().map(|object| json!({"Key": xml_text(&object, "Key"), "Size": xml_text(&object, "Size"), "LastModified": xml_text(&object, "LastModified"), "ETag": xml_text(&object, "ETag")})).filter(|object| object.get("Key").and_then(Value::as_str).is_some_and(|key| !key.is_empty() && key != prefix)).collect::<Vec<_>>();
    Ok(json!({"objects": objects, "prefixes": xml_blocks(&body, "CommonPrefixes").into_iter().map(|entry| xml_text(&entry, "Prefix")).filter(|value| !value.is_empty()).collect::<Vec<_>>(), "isTruncated": xml_text(&body, "IsTruncated").eq_ignore_ascii_case("true"), "nextMarker": xml_text(&body, "NextContinuationToken")}))
}


pub(crate) fn tencent_number(value: Option<&Value>) -> f64 {
    value.and_then(Value::as_f64)
        .or_else(|| value.and_then(Value::as_i64).map(|number| number as f64))
        .or_else(|| value.and_then(Value::as_str).and_then(|text| text.parse::<f64>().ok()))
        .unwrap_or(0.0)
}

fn tencent_instance(item: &Value, region: &Value) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        let state = item.get("InstanceState").and_then(Value::as_str).unwrap_or("");
        let status = match state.to_uppercase().as_str() { "RUNNING" => "Running", "STOPPED" => "Stopped", _ => state };
        let network = item.get("InternetAccessible").cloned().unwrap_or_else(|| json!({}));
        target.insert("InstanceName".into(), item.get("InstanceName").cloned().or_else(|| item.get("InstanceId").cloned()).unwrap_or(json!("")));
        target.insert("Status".into(), json!(status));
        target.insert("PublicIpAddress".into(), item.get("PublicIpAddresses").cloned().unwrap_or_else(|| json!([])));
        target.insert("PrivateIpAddress".into(), item.get("PrivateIpAddresses").cloned().unwrap_or_else(|| json!([])));
        target.insert("Cpu".into(), item.get("CPU").cloned().unwrap_or(json!(0)));
        target.insert("Memory".into(), item.get("Memory").cloned().unwrap_or(json!(0)));
        target.insert("InternetMaxBandwidthIn".into(), json!(0));
        target.insert("InternetMaxBandwidthOut".into(), network.get("InternetMaxBandwidthOut").cloned().unwrap_or(json!(0)));
        target.insert("OSName".into(), item.get("OsName").or_else(|| item.get("OsType")).cloned().unwrap_or(json!("-")));
        target.insert("CreationTime".into(), item.get("CreatedTime").cloned().unwrap_or(json!("")));
        target.insert("ExpiredTime".into(), item.get("ExpiredTime").cloned().unwrap_or(json!("")));
        target.insert("_region_id".into(), region.get("Region").cloned().unwrap_or(json!("")));
        target.insert("_region_name".into(), region.get("RegionName").or_else(|| region.get("Region")).cloned().unwrap_or(json!("")));
    }
    value
}

fn tencent_lighthouse_instance(item: &Value, region: &str) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        let state = item.get("InstanceState").or_else(|| item.get("InstanceStatus")).and_then(Value::as_str).unwrap_or("");
        let status = match state.to_uppercase().as_str() { "RUNNING" => "Running", "STOPPED" => "Stopped", _ => state };
        let public_addresses = item.get("PublicAddresses").or_else(|| item.get("PublicIpAddresses")).cloned().unwrap_or_else(|| json!([]));
        target.insert("InstanceName".into(), item.get("InstanceName").cloned().or_else(|| item.get("InstanceId").cloned()).unwrap_or(json!("")));
        target.insert("Status".into(), json!(status));
        target.insert("InstanceStatus".into(), json!(status));
        target.insert("PublicIpAddress".into(), public_addresses.clone());
        target.insert("PublicIp".into(), public_addresses.as_array().and_then(|values| values.first()).cloned().unwrap_or_else(|| json!("")));
        target.insert("ImageName".into(), item.get("BlueprintName").or_else(|| item.get("BlueprintId")).cloned().unwrap_or(json!("")));
        target.insert("PlanId".into(), item.get("BundleId").or_else(|| item.get("BundleName")).cloned().unwrap_or(json!("")));
        target.insert("ExpiredTime".into(), item.get("ExpiredTime").cloned().unwrap_or(json!("")));
        target.insert("_region_id".into(), json!(region));
    }
    value
}

fn tencent_cdb_instance(item: &Value, region: &str) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        let status = item.get("Status").or_else(|| item.get("DBInstanceStatus")).and_then(Value::as_str).unwrap_or("");
        target.insert("DBInstanceId".into(), item.get("InstanceId").or_else(|| item.get("DBInstanceId")).cloned().unwrap_or(json!("")));
        target.insert("DBInstanceDescription".into(), item.get("InstanceName").or_else(|| item.get("DBInstanceDescription")).or_else(|| item.get("InstanceId")).cloned().unwrap_or(json!("")));
        target.insert("DBInstanceStatus".into(), json!(match status { "1" => "Running", "0" => "Stopped", _ => status }));
        target.insert("DBInstanceType".into(), item.get("DeviceType").or_else(|| item.get("InstanceType")).cloned().unwrap_or(json!("")));
        target.insert("DBInstanceClass".into(), item.get("InstanceType").or_else(|| item.get("Model")).cloned().unwrap_or(json!("")));
        target.insert("DBInstanceStorage".into(), item.get("Volume").or_else(|| item.get("Storage")).cloned().unwrap_or(json!(0)));
        target.insert("ConnectionString".into(), item.get("Vip").or_else(|| item.get("ConnectionString")).cloned().unwrap_or(json!("")));
        target.insert("Port".into(), item.get("Vport").or_else(|| item.get("Port")).cloned().unwrap_or(json!("")));
        target.insert("DBInstanceNetType".into(), json!(if item.get("ProjectId").is_some() { "私有网络" } else { "-" }));
        target.insert("Engine".into(), item.get("Engine").cloned().unwrap_or(json!("MySQL")));
        target.insert("EngineVersion".into(), item.get("EngineVersion").cloned().unwrap_or(json!("")));
        target.insert("CreateTime".into(), item.get("CreateTime").cloned().unwrap_or(json!("")));
        target.insert("ExpireTime".into(), item.get("DeadlineTime").or_else(|| item.get("ExpireTime")).cloned().unwrap_or(json!("")));
        target.insert("_region_id".into(), json!(region));
    }
    value
}

fn tencent_redis_instance(item: &Value, region: &str) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        let status = item.get("Status").or_else(|| item.get("InstanceStatus")).and_then(Value::as_str).unwrap_or("");
        let normalized = if ["2", "RUNNING", "NORMAL"].contains(&status.to_uppercase().as_str()) { "Normal" } else { status };
        target.insert("InstanceName".into(), item.get("InstanceName").or_else(|| item.get("InstanceId")).cloned().unwrap_or(json!("")));
        target.insert("InstanceStatus".into(), json!(normalized));
        target.insert("InstanceType".into(), item.get("Type").or_else(|| item.get("TypeName")).cloned().unwrap_or(json!("")));
        target.insert("InstanceClass".into(), item.get("Size").or_else(|| item.get("TypeName")).cloned().unwrap_or(json!("")));
        target.insert("Capacity".into(), item.get("Size").or_else(|| item.get("Capacity")).cloned().unwrap_or(json!(0)));
        target.insert("Bandwidth".into(), item.get("Bandwidth").cloned().unwrap_or(json!(0)));
        target.insert("Connections".into(), item.get("ClientLimit").or_else(|| item.get("Connections")).cloned().unwrap_or(json!(0)));
        target.insert("ConnectionDomain".into(), item.get("WanIp").or_else(|| item.get("PrivateIp")).or_else(|| item.get("ConnectionDomain")).cloned().unwrap_or(json!("")));
        target.insert("Port".into(), item.get("Port").cloned().unwrap_or(json!("")));
        target.insert("EngineVersion".into(), item.get("CurrentRedisVersion").or_else(|| item.get("RedisVersion")).cloned().unwrap_or(json!("")));
        target.insert("NetworkType".into(), item.get("NetType").cloned().unwrap_or(json!("")));
        target.insert("ChargeType".into(), item.get("BillingMode").cloned().unwrap_or(json!("")));
        target.insert("EndTime".into(), item.get("DeadTime").or_else(|| item.get("EndTime")).cloned().unwrap_or(json!("")));
        target.insert("ArchitectureType".into(), item.get("Type").cloned().unwrap_or(json!("standard")));
        target.insert("_region_id".into(), json!(region));
    }
    value
}

fn tencent_edge_zone(item: &Value) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        target.insert("SiteId".into(), item.get("ZoneId").or_else(|| item.get("Id")).cloned().unwrap_or(json!("")));
        target.insert("SiteName".into(), item.get("ZoneName").or_else(|| item.get("ZoneId")).cloned().unwrap_or(json!("")));
        target.insert("DomainName".into(), item.get("ZoneName").cloned().unwrap_or(json!("")));
        target.insert("Status".into(), item.get("ActiveStatus").or_else(|| item.get("Status")).cloned().unwrap_or(json!("")));
        target.insert("AccessType".into(), item.get("Type").or_else(|| item.get("ZoneType")).cloned().unwrap_or(json!("")));
        target.insert("Coverage".into(), item.get("Area").or_else(|| item.get("PlanType")).cloned().unwrap_or(json!("")));
        target.insert("PlanName".into(), item.get("PlanType").or_else(|| item.get("Plan")).cloned().unwrap_or(json!("")));
    }
    value
}

async fn tencent_regions(access_key_id: &str, access_key_secret: &str) -> Result<Vec<String>, String> {
    let data = tencent_request("cvm", "2017-03-12", "DescribeRegions", json!({}), None, access_key_id, access_key_secret).await?;
    Ok(array_at(&data, &["RegionSet"]).into_iter().filter(|region| region.get("RegionState").and_then(Value::as_str).unwrap_or("AVAILABLE").eq_ignore_ascii_case("AVAILABLE")).filter_map(|region| region.get("Region").and_then(Value::as_str).filter(|value| !value.is_empty()).map(String::from)).collect())
}

fn tencent_registered_domain(item: &Value) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        target.insert("DomainName".into(), item.get("DomainName").or_else(|| item.get("Name")).cloned().unwrap_or(json!("")));
        target.insert("RegistrationDate".into(), item.get("RegistrationDate").or_else(|| item.get("CreationDate")).or_else(|| item.get("CreatedOn")).cloned().unwrap_or(json!("")));
        target.insert("ExpirationDate".into(), item.get("ExpirationDate").or_else(|| item.get("ExpiredDate")).cloned().unwrap_or(json!("")));
        target.insert("RegistrantOrganization".into(), item.get("RegistrantOrganization").or_else(|| item.get("RegistrantName")).cloned().unwrap_or(json!("")));
        target.insert("DomainAuditStatus".into(), item.get("RealNameAuditStatus").or_else(|| item.get("DomainAuditStatus")).cloned().unwrap_or(json!("")));
        target.insert("DomainStatus".into(), item.get("Status").cloned().unwrap_or(json!("")));
        target.insert("DnsServers".into(), item.get("DnsList").or_else(|| item.get("NameServerSet")).cloned().unwrap_or(json!([])));
    }
    value
}

fn tencent_dnspod_domain(item: &Value) -> Value {
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        target.insert("DomainName".into(), item.get("Name").or_else(|| item.get("DomainName")).cloned().unwrap_or(json!("")));
        target.insert("RecordCount".into(), json!(tencent_number(item.get("RecordCount"))));
        target.insert("VersionCode".into(), item.get("Grade").or_else(|| item.get("GradeTitle")).cloned().unwrap_or(json!("")));
        target.insert("CreateTime".into(), item.get("CreatedOn").or_else(|| item.get("CreatedAt")).cloned().unwrap_or(json!("")));
        target.insert("DomainStatus".into(), item.get("Status").cloned().unwrap_or(json!("")));
        target.insert("DnsServers".into(), item.get("NameServers").cloned().unwrap_or(json!([])));
        target.insert("DnsSource".into(), json!("DNSPod"));
    }
    value
}

async fn tencent_paged(
    service: &str, version: &str, action: &str, payload: Value, path: &[&str], region: Option<&str>,
    access_key_id: &str, access_key_secret: &str,
) -> Result<Vec<Value>, String> {
    let mut items = Vec::new();
    for offset in (0..10_000).step_by(100) {
        let mut params = payload.clone();
        let object = params.as_object_mut().ok_or("腾讯云分页请求参数无效")?;
        object.insert("Offset".into(), json!(offset));
        object.insert("Limit".into(), json!(100));
        let data = tencent_request(service, version, action, params, region, access_key_id, access_key_secret).await?;
        let page = array_at(&data, path).into_iter().cloned().collect::<Vec<_>>();
        let total = tencent_number(data.get("TotalCount").or_else(|| data.pointer("/DomainCountInfo/AllTotal")).or_else(|| data.pointer("/DomainCountInfo/TotalCount"))) as usize;
        let count = page.len();
        items.extend(page);
        if count == 0 || count < 100 || (total > 0 && items.len() >= total) { break; }
    }
    Ok(items)
}

pub(crate) async fn resource_items(id: i64, resource_type: &str, access_key_id: &str, access_key_secret: &str) -> ResourceResponse {
    let mut items = Vec::new();
    let mut errors = Vec::new();
    if let Err(error) = ensure_tencent_account(id) {
        return ResourceResponse { resource_type: resource_type.into(), items, errors: vec![error], fetched_at: Utc::now().timestamp_millis() };
    }
    match resource_type {
        "ecs" => match tencent_request("cvm", "2017-03-12", "DescribeRegions", json!({}), None, access_key_id, access_key_secret).await {
            Ok(data) => for region in array_at(&data, &["RegionSet"]) {
                if !region.get("RegionState").and_then(Value::as_str).unwrap_or("AVAILABLE").eq_ignore_ascii_case("AVAILABLE") { continue; }
                let region_id = region.get("Region").and_then(Value::as_str).unwrap_or("");
                match tencent_paged("cvm", "2017-03-12", "DescribeInstances", json!({}), &["InstanceSet"], Some(region_id), access_key_id, access_key_secret).await {
                    Ok(values) => items.extend(values.iter().map(|item| tencent_instance(item, region))),
                    Err(error) => errors.push(format!("{}: {error}", if region_id.is_empty() { "未知地域" } else { region_id })),
                }
            },
            Err(error) => errors.push(error),
        },
        "domain" => {
            let registration = tencent_paged("domain", "2018-08-08", "DescribeDomainNameList", json!({}), &["DomainSet"], None, access_key_id, access_key_secret).await;
            let dns = tencent_paged("dnspod", "2021-03-23", "DescribeDomainList", json!({}), &["DomainList"], None, access_key_id, access_key_secret).await;
            let mut merged: BTreeMap<String, Value> = BTreeMap::new();
            match registration { Ok(values) => for item in values { let domain = tencent_registered_domain(&item); if let Some(name) = domain.get("DomainName").and_then(Value::as_str).filter(|name| !name.is_empty()) { merged.insert(name.to_lowercase(), domain); } }, Err(error) => errors.push(format!("域名注册: {error}")) }
            match dns { Ok(values) => for item in values { let domain = tencent_dnspod_domain(&item); if let Some(name) = domain.get("DomainName").and_then(Value::as_str).filter(|name| !name.is_empty()) { let entry = merged.entry(name.to_lowercase()).or_insert_with(|| json!({"DomainName": name})); if let (Value::Object(target), Value::Object(source)) = (entry, domain) { for (key, value) in source { target.insert(key, value); } } } }, Err(error) => errors.push(format!("DNSPod: {error}")) }
            items.extend(merged.into_values());
        },
        "swas" => {
            let fallback_region = match account_region_id(id) { Ok(region) => region, Err(error) => { errors.push(error); return ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: Utc::now().timestamp_millis() }; } };
            let mut regions = vec![fallback_region.clone()];
            match tencent_request("lighthouse", "2020-03-24", "DescribeRegions", json!({}), None, access_key_id, access_key_secret).await {
                Ok(data) => {
                    let mut listed = array_at(&data, &["RegionSet"]).into_iter()
                        .filter(|region| region.get("RegionState").and_then(Value::as_str).unwrap_or("AVAILABLE").eq_ignore_ascii_case("AVAILABLE"))
                        .filter_map(|region| region.get("Region").and_then(Value::as_str).filter(|value| !value.is_empty()).map(String::from))
                        .collect::<Vec<_>>();
                    listed.sort(); listed.dedup(); regions = listed;
                },
                Err(error) => errors.push(format!("读取轻量服务器地域失败，已仅查询 {}: {error}", fallback_region)),
            }
            for region in regions {
                match tencent_paged("lighthouse", "2020-03-24", "DescribeInstances", json!({}), &["InstanceSet"], Some(&region), access_key_id, access_key_secret).await {
                    Ok(values) => items.extend(values.iter().map(|item| tencent_lighthouse_instance(item, &region))),
                    Err(error) => errors.push(format!("{region}: {error}")),
                }
            }
        },
        "rds" | "redis" => match tencent_regions(access_key_id, access_key_secret).await {
            Ok(regions) => for region in regions {
                let (service, version, path) = if resource_type == "rds" { ("cdb", "2017-03-20", &["Items"][..]) } else { ("redis", "2018-04-12", &["InstanceSet"][..]) };
                let action = if resource_type == "rds" { "DescribeDBInstances" } else { "DescribeInstances" };
                match tencent_paged(service, version, action, json!({}), path, Some(&region), access_key_id, access_key_secret).await {
                    Ok(values) => items.extend(values.iter().map(|item| if resource_type == "rds" { tencent_cdb_instance(item, &region) } else { tencent_redis_instance(item, &region) })),
                    Err(error) => errors.push(format!("{region}: {error}")),
                }
            },
            Err(error) => errors.push(error),
        },
        "oss" => match cos_list_buckets(access_key_id, access_key_secret).await { Ok(values) => items.extend(values), Err(error) => errors.push(error) },
        "esa" => match tencent_paged("teo", "2022-09-01", "DescribeZones", json!({}), &["Zones"], None, access_key_id, access_key_secret).await {
            Ok(values) => items.extend(values.iter().map(tencent_edge_zone)),
            Err(error) => errors.push(error),
        },
        other => errors.push(format!("腾讯云暂未接入 {other} 资源")),
    }
    ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: Utc::now().timestamp_millis() }
}
