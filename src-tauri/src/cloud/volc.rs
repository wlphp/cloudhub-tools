pub(crate) mod servers;
use chrono::{TimeZone, Utc};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use serde_json::{json, Value};
use std::collections::BTreeMap;

use crate::ResourceResponse;

fn query(params: &BTreeMap<String, String>) -> String { let mut values = params.iter().map(|(key, value)| (crate::rpc_encode(key), crate::rpc_encode(value))).collect::<Vec<_>>(); values.sort(); values.into_iter().map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>().join("&") }
fn sign(key: &[u8], value: &str) -> Result<Vec<u8>, String> { let mut mac: Hmac<Sha256> = <Hmac<Sha256> as Mac>::new_from_slice(key).map_err(|error| error.to_string())?; mac.update(value.as_bytes()); Ok(mac.finalize().into_bytes().to_vec()) }

// Read only the structured code. Provider messages can echo credentials or signatures.
fn api_error(data: &Value, status: reqwest::StatusCode) -> String {
    let code = data.pointer("/ResponseMetadata/Error/Code")
        .or_else(|| data.pointer("/Error/Code"))
        .and_then(Value::as_str).unwrap_or("");
    crate::core::error::sanitize_resource_error(&format!("HTTP {} {code}", status.as_u16()))
}

fn json_host(service: &str, region: &str) -> String {
    match service {
        "rds_mysql" => format!("rds-mysql.{region}.volcengineapi.com"),
        "Redis" => format!("redis.{region}.volcengineapi.com"),
        "storage_ebs" | "billing" => "open.volcengineapi.com".into(),
        _ => format!("{service}.volcengineapi.com"),
    }
}

pub(crate) async fn request(service: &str, version: &str, action: &str, mut params: BTreeMap<String, String>, region: &str, access_key_id: &str, access_key_secret: &str) -> Result<Value, String> {
    let region = if region.is_empty() { "cn-beijing" } else { region };
    if !valid_region(region) { return Err("账号地域配置无效".into()); }
    let host = if matches!(service, "ecs" | "vpc") { format!("{service}.{region}.volcengineapi.com") } else { "open.volcengineapi.com".into() }; params.insert("Action".into(), action.into()); params.insert("Version".into(), version.into()); let canonical_query = query(&params); let datetime = Utc::now().format("%Y%m%dT%H%M%SZ").to_string(); let date = &datetime[..8]; let payload_hash = format!("{:x}", Sha256::digest(b"")); let canonical_headers = format!("host:{host}\nx-date:{datetime}\n"); let canonical_request = format!("GET\n/\n{canonical_query}\n{canonical_headers}\nhost;x-date\n{payload_hash}"); let scope = format!("{date}/{region}/{service}/request"); let string_to_sign = format!("HMAC-SHA256\n{datetime}\n{scope}\n{:x}", Sha256::digest(canonical_request.as_bytes())); let date_key = sign(access_key_secret.as_bytes(), date)?; let region_key = sign(&date_key, region)?; let service_key = sign(&region_key, service)?; let signing_key = sign(&service_key, "request")?; let signature = hex::encode(sign(&signing_key, &string_to_sign)?); let authorization = format!("HMAC-SHA256 Credential={access_key_id}/{scope}, SignedHeaders=host;x-date, Signature={signature}");
    let response = match reqwest::Client::new().get(format!("https://{host}/?{canonical_query}")).header("Host", &host).header("X-Date", &datetime).header("Authorization", authorization).timeout(std::time::Duration::from_secs(25)).send().await { Ok(response) => response, Err(error) => { let message = format!("火山引擎请求失败: {error}"); crate::write_api_log(access_key_id, &host, action, &json!(params), None, "失败", Some(&message)); return Err(message); } };
    let status = response.status(); let data: Value = match response.json().await { Ok(data) => data, Err(error) => { let message = format!("火山引擎返回解析失败: {error}"); crate::write_api_log(access_key_id, &host, action, &json!(params), None, "失败", Some(&message)); return Err(message); } };
    if !status.is_success() || data.pointer("/ResponseMetadata/Error").is_some() || data.get("Error").is_some() { let message = api_error(&data, status); crate::write_api_log(access_key_id, &host, action, &json!(params), Some(&json!({"HTTPStatus": status.as_u16()})), "失败", Some(&message)); return Err(message); }
    crate::write_api_log(access_key_id, &host, action, &json!(params), Some(&data), "成功", None); Ok(data.get("Result").cloned().unwrap_or(data))
}

pub(crate) async fn json_request(service: &str, version: &str, action: &str, payload: Value, region: &str, access_key_id: &str, access_key_secret: &str) -> Result<Value, String> {
    let region = if region.is_empty() { "cn-beijing" } else { region };
    if !valid_region(region) {
        return Err("账号地域配置无效".into());
    }
    let host = json_host(service, region);
    let params = BTreeMap::from([("Action".into(), action.into()), ("Version".into(), version.into())]);
    let canonical_query = query(&params);
    let body = serde_json::to_string(&payload).map_err(|_| "火山引擎请求序列化失败")?;
    let datetime = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let date = &datetime[..8];
    let payload_hash = format!("{:x}", Sha256::digest(body.as_bytes()));
    let canonical_headers = format!("host:{host}\nx-date:{datetime}\n");
    let canonical_request = format!("POST\n/\n{canonical_query}\n{canonical_headers}\nhost;x-date\n{payload_hash}");
    let scope = format!("{date}/{region}/{service}/request");
    let string_to_sign = format!("HMAC-SHA256\n{datetime}\n{scope}\n{:x}", Sha256::digest(canonical_request.as_bytes()));
    let date_key = sign(access_key_secret.as_bytes(), date)?;
    let region_key = sign(&date_key, region)?;
    let service_key = sign(&region_key, service)?;
    let signing_key = sign(&service_key, "request")?;
    let signature = hex::encode(sign(&signing_key, &string_to_sign)?);
    let authorization = format!("HMAC-SHA256 Credential={access_key_id}/{scope}, SignedHeaders=host;x-date, Signature={signature}");
    let response = reqwest::Client::new().post(format!("https://{host}/?{canonical_query}"))
        .header("Host", &host).header("Accept", "application/json")
        .header("Content-Type", "application/json").header("Region", region).header("Service", service).header("X-Date", &datetime)
        .header("Authorization", authorization).body(body)
        .timeout(std::time::Duration::from_secs(25)).send().await
        .map_err(|_| "火山引擎请求失败")?;
    let status = response.status();
    let data: Value = response.json().await.map_err(|_| "火山引擎返回解析失败")?;
    if !status.is_success() || data.pointer("/ResponseMetadata/Error").is_some_and(|error| !error.is_null()) || data.get("Error").is_some_and(|error| !error.is_null()) {
        let message = api_error(&data, status);
        crate::write_api_log(access_key_id, &host, action, &payload, Some(&json!({"HTTPStatus": status.as_u16()})), "失败", Some(&message));
        return Err(message);
    }
    crate::write_api_log(access_key_id, &host, action, &payload, Some(&json!({"HTTPStatus": status.as_u16()})), "成功", None);
    Ok(data.get("Result").cloned().unwrap_or(data))
}

pub(crate) async fn finance_snapshot(id: i64) -> Result<Value, String> {
    if crate::account_cloud_type(id)? != "volcengine" { return Err("当前账号不是火山引擎账号".into()); }
    let (access_key_id, access_key_secret) = crate::account_credentials(id)?;
    let region = "cn-beijing";
    let balance = request("billing", "2022-01-01", "QueryBalanceAcct", BTreeMap::new(), region, &access_key_id, &access_key_secret).await;
    let mut payload = crate::cloud::finance::base("volcengine");
    let mut payer_id = None;
    match &balance {
        Ok(data) => {
            if let Some(account_id) = data.get("AccountID").and_then(Value::as_str).filter(|value| !value.trim().is_empty()) {
                payer_id = Some(account_id.to_string());
            }
            let available = crate::cloud::finance::number_field(data, &["AvailableBalance", "Balance", "AvailableAmount"]);
            let cash = crate::cloud::finance::number_field(data, &["CashBalance", "CashAmount"]);
            let credit = crate::cloud::finance::number_field(data, &["CreditLimit", "CreditAmount"]);
            if available.is_none() && cash.is_none() && credit.is_none() {
                crate::cloud::finance::set_balance_error(&mut payload, "余额接口未返回可用金额字段");
            } else {
                crate::cloud::finance::set_balance_ok(&mut payload, available, cash, credit);
            }
            if let Some(currency) = data.get("Currency").and_then(Value::as_str).filter(|value| !value.trim().is_empty()) {
                payload["currency"] = json!(currency);
            }
        }
        Err(error) => crate::cloud::finance::set_balance_error(&mut payload, error),
    }
    let cloud_account_id = payer_id.clone().unwrap_or_else(|| access_key_id.clone());
    crate::cloud::finance::set_cloud_identity(&mut payload, Some(cloud_account_id), Some("火山引擎账号"));
    let billing_period = Utc::now().format("%Y-%m").to_string();
    let bill_params = crate::string_params(&[("BillPeriod", billing_period), ("Limit", "300".into()), ("Offset", "0".into())]);
    match request("billing", "2022-01-01", "ListBillOverviewByProd", bill_params, region, &access_key_id, &access_key_secret).await {
        Ok(data) => {
            if data.get("List").is_some() {
                let items = data.get("List").and_then(Value::as_array).cloned().unwrap_or_default();
                let consume = items.iter().filter_map(|item| crate::cloud::finance::number_field(item, &["PayableAmount", "PaidAmount", "BillAmount"])).sum::<f64>();
                let bill = items.iter().filter_map(|item| crate::cloud::finance::number_field(item, &["PaidAmount", "PayableAmount", "BillAmount"])).sum::<f64>();
                crate::cloud::finance::set_consume_ok(&mut payload, Some(consume), Some(bill));
            } else {
                crate::cloud::finance::set_consume_error(&mut payload, "账单接口返回格式不兼容");
            }
        }
        Err(error) => crate::cloud::finance::set_consume_error(&mut payload, &error),
    }
    Ok(payload)
}

pub(crate) async fn tos_list_buckets(region: &str, access_key_id: &str, access_key_secret: &str) -> Result<Vec<Value>, String> {
    let region = if region.is_empty() { "cn-beijing" } else { region }; let host = format!("tos-{region}.volces.com"); let datetime = Utc::now().format("%Y%m%dT%H%M%SZ").to_string(); let date = &datetime[..8]; let payload_hash = format!("{:x}", Sha256::digest(b"")); let canonical_headers = format!("host:{host}\nx-tos-content-sha256:{payload_hash}\nx-tos-date:{datetime}\n"); let canonical_request = format!("GET\n/\n\n{canonical_headers}\nhost;x-tos-content-sha256;x-tos-date\n{payload_hash}"); let scope = format!("{date}/{region}/tos/request"); let string_to_sign = format!("TOS4-HMAC-SHA256\n{datetime}\n{scope}\n{:x}", Sha256::digest(canonical_request.as_bytes())); let date_key = sign(access_key_secret.as_bytes(), date)?; let region_key = sign(&date_key, region)?; let service_key = sign(&region_key, "tos")?; let signing_key = sign(&service_key, "request")?; let signature = hex::encode(sign(&signing_key, &string_to_sign)?); let authorization = format!("TOS4-HMAC-SHA256 Credential={access_key_id}/{scope}, SignedHeaders=host;x-tos-content-sha256;x-tos-date, Signature={signature}"); let response = reqwest::Client::new().get(format!("https://{host}/")).header("Host", &host).header("X-Tos-Date", &datetime).header("X-Tos-Content-Sha256", &payload_hash).header("Authorization", authorization).timeout(std::time::Duration::from_secs(25)).send().await.map_err(|error| format!("TOS 请求失败: {error}"))?; let status = response.status(); let body = response.text().await.map_err(|error| format!("TOS 返回读取失败: {error}"))?; if !status.is_success() { let message = crate::xml_text(&body, "Message"); return Err(format!("TOS 返回错误（{status}）：{}", if message.is_empty() { crate::xml_text(&body, "Code") } else { message })); } let buckets = match serde_json::from_str::<Value>(&body) { Ok(data) => data.get("Buckets").and_then(Value::as_array).cloned().or_else(|| data.pointer("/Buckets/Bucket").and_then(Value::as_array).cloned()).or_else(|| data.get("Bucket").and_then(Value::as_array).cloned()).unwrap_or_default(), Err(_) => crate::xml_blocks(&body, "Bucket").into_iter().map(|bucket| json!({"Name": crate::xml_text(&bucket, "Name"), "Location": crate::xml_text(&bucket, "Location"), "CreationDate": crate::xml_text(&bucket, "CreationDate")})).collect() }; Ok(buckets.into_iter().map(|bucket| { let name = bucket.get("Name").or_else(|| bucket.get("BucketName")).and_then(Value::as_str).unwrap_or(""); let location = bucket.get("Location").or_else(|| bucket.get("Region")).and_then(Value::as_str).filter(|value| !value.is_empty()).unwrap_or(region); json!({"Name": name, "Location": location, "CreationDate": bucket.get("CreationDate").and_then(Value::as_str).unwrap_or(""), "StorageClass": "Standard", "ExtranetEndpoint": format!("{name}.tos-{location}.volces.com"), "Acl": "private"}) }).filter(|bucket| bucket.get("Name").and_then(Value::as_str).is_some_and(|name| !name.is_empty())).collect())
}

fn instance(item: &Value, region: &str) -> Value {
    let mut value = item.clone();
    if let Value::Object(target) = &mut value {
        let primary = item.get("NetworkInterfaces").and_then(Value::as_array)
            .and_then(|interfaces| interfaces.iter().find(|nic| nic.get("Type").and_then(Value::as_str) == Some("primary")).or_else(|| interfaces.first()));
        for (field, source) in [
            ("InstanceId", item.get("InstanceId").or_else(|| item.get("InstanceID"))),
            ("InstanceName", item.get("InstanceName").or_else(|| item.get("InstanceId"))),
            ("Status", item.get("Status").or_else(|| item.get("InstanceStatus"))),
            ("InstanceStatus", item.get("Status").or_else(|| item.get("InstanceStatus"))),
            ("Cpu", item.get("Cpus")), ("Memory", item.get("MemorySize")),
            ("InstanceType", item.get("InstanceTypeId")),
            ("OSName", item.get("OsName")), ("OSType", item.get("OsType")),
            ("CreationTime", item.get("CreatedAt")),
            ("PublicIpAddress", item.pointer("/EipAddress/IpAddress").or_else(|| item.get("PublicIpAddress"))),
            ("PrivateIpAddress", primary.and_then(|nic| nic.get("PrimaryIpAddress"))),
            ("SecurityGroupIds", primary.and_then(|nic| nic.get("SecurityGroupIds"))),
        ] { target.insert(field.into(), source.cloned().unwrap_or(Value::Null)); }
        let postpaid = item.get("InstanceChargeType").and_then(Value::as_str) == Some("PostPaid");
        target.insert("PaymentTiming".into(), json!(if postpaid { "Postpaid" } else { "Prepaid" }));
        let expiry = item.get("ExpiredAt").filter(|date| !postpaid && !date.as_str().unwrap_or("").starts_with("2200-"));
        target.insert("ExpiredTime".into(), expiry.cloned().unwrap_or(Value::Null));
        target.insert("_region_id".into(), json!(region));
    }
    value
}
fn rds(item: &Value, region: &str) -> Value { let mut value = item.clone(); if let Value::Object(target) = &mut value { let id = item.get("DBInstanceId").or_else(|| item.get("InstanceId")).or_else(|| item.get("InstanceID")).cloned().unwrap_or(json!("")); target.insert("DBInstanceId".into(), id.clone()); target.insert("DBInstanceDescription".into(), item.get("DBInstanceName").or_else(|| item.get("InstanceName")).cloned().unwrap_or(id)); target.insert("DBInstanceStatus".into(), item.get("Status").or_else(|| item.get("InstanceStatus")).or_else(|| item.get("DBInstanceStatus")).cloned().unwrap_or(json!(""))); target.insert("Engine".into(), item.get("Engine").cloned().unwrap_or(json!("MySQL"))); target.insert("_region_id".into(), json!(region)); } value }
fn redis(item: &Value, region: &str) -> Value { let mut value = item.clone(); if let Value::Object(target) = &mut value { let id = item.get("InstanceId").or_else(|| item.get("InstanceID")).or_else(|| item.get("DBInstanceId")).or_else(|| item.get("RedisInstanceId")).cloned().unwrap_or(json!("")); target.insert("KVStoreInstanceId".into(), id.clone()); target.insert("InstanceId".into(), id.clone()); target.insert("InstanceName".into(), item.get("InstanceName").or_else(|| item.get("DBInstanceName")).or_else(|| item.get("Name")).cloned().unwrap_or(id)); target.insert("InstanceStatus".into(), item.get("Status").or_else(|| item.get("InstanceStatus")).cloned().unwrap_or(json!(""))); target.insert("DBInstanceStatus".into(), item.get("Status").or_else(|| item.get("InstanceStatus")).cloned().unwrap_or(json!(""))); target.insert("EngineVersion".into(), item.get("EngineVersion").or_else(|| item.get("RedisVersion")).cloned().unwrap_or(json!("Redis"))); target.insert("_region_id".into(), json!(region)); } value }
fn zone(item: &Value) -> Value { let mut value = item.clone(); if let Value::Object(target) = &mut value { let expiry = item.get("ExpiredTime").and_then(Value::as_i64).and_then(|value| { let millis = if value < 1_000_000_000_000 { value.saturating_mul(1_000) } else { value }; Utc.timestamp_millis_opt(millis).single().map(|date| date.to_rfc3339()) }).unwrap_or_default(); target.insert("DomainName".into(), item.get("ZoneName").cloned().unwrap_or(json!(""))); target.insert("DomainStatus".into(), json!("正常")); target.insert("RegistrationDate".into(), item.get("CreatedAt").cloned().unwrap_or(json!(""))); target.insert("ExpirationDate".into(), json!(expiry)); target.insert("RecordCount".into(), item.get("RecordCount").cloned().unwrap_or(json!(0))); } value }

fn valid_region(region: &str) -> bool {
    !region.is_empty() && region.len() <= 64
        && region.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

// ECS uses NextToken pagination, including DescribeRegions. Do not silently
// treat an unrecognized response as an empty inventory and erase cached assets.
async fn ecs_pages<F, Fut>(fetch: &F, action: &'static str, region: &str, field: &str) -> Result<Vec<Value>, String>
where
    F: Fn(&'static str, BTreeMap<String, String>, String) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    let mut items = Vec::new();
    let mut next = String::new();
    let mut seen = std::collections::HashSet::new();
    for _ in 0..1000 {
        let mut params = crate::string_params(&[("MaxResults", if action == "DescribeRegions" { "20" } else { "100" }.into())]);
        if !next.is_empty() { params.insert("NextToken".into(), next); }
        let data = fetch(action, params, region.to_string()).await?;
        let page = data.get(field).and_then(Value::as_array).ok_or("火山引擎服务器响应格式不兼容，请更新客户端适配")?;
        items.extend(page.iter().cloned());
        next = match data.get("NextToken") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(value)) => value.clone(),
            _ => return Err("火山引擎服务器分页响应异常，查询未完成".into()),
        };
        if next.is_empty() { return Ok(items); }
        if !seen.insert(next.clone()) { return Err("火山引擎服务器分页响应异常，查询未完成".into()); }
    }
    Err("火山引擎服务器分页响应异常，查询未完成".into())
}

async fn ecs_instances<F, Fut>(preferred_region: &str, fetch: F) -> (Vec<Value>, Vec<String>)
where
    F: Fn(&'static str, BTreeMap<String, String>, String) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    let mut errors = Vec::new();
    let mut regions = std::collections::BTreeSet::from([preferred_region.to_string()]);
    match ecs_pages(&fetch, "DescribeRegions", preferred_region, "Regions").await {
        Ok(values) => for value in values {
            match value.get("RegionId").and_then(Value::as_str).filter(|region| valid_region(region)) {
                Some(region) => { regions.insert(region.to_string()); },
                None => errors.push("火山引擎服务器响应格式不兼容，请更新客户端适配".into()),
            }
        },
        Err(error) => errors.push(error),
    }
    let mut items = Vec::new();
    for region in regions {
        match ecs_pages(&fetch, "DescribeInstances", &region, "Instances").await {
            Ok(values) => items.extend(values.iter().map(|item| instance(item, &region))),
            Err(error) => errors.push(error),
        }
    }
    (items, errors)
}

pub(crate) async fn resource_items(id: i64, resource_type: &str, access_key_id: &str, access_key_secret: &str) -> ResourceResponse {
    let mut items = Vec::new(); let mut errors = Vec::new(); let now = Utc::now().timestamp_millis();
    let region = match crate::open_db().and_then(|db| crate::account_repository::region_id(&db, id)) { Ok(value) => value.filter(|value| !value.is_empty()).unwrap_or_else(|| "cn-beijing".into()), Err(error) => return ResourceResponse { resource_type: resource_type.into(), items, errors: vec![error], fetched_at: now } };
    match resource_type {
        "ecs" => {
            (items, errors) = ecs_instances(&region, |action, params, region| async move {
                request("ecs", "2020-04-01", action, params, &region, access_key_id, access_key_secret).await
            }).await;
            for item in &mut items {
                servers::enrich_bandwidth(item, access_key_id, access_key_secret).await;
            }
        },
        "oss" => match tos_list_buckets(&region, access_key_id, access_key_secret).await { Ok(values) => items.extend(values), Err(error) => errors.push(error) },
        "domain" => match json_request("dns", "2018-08-01", "ListZones", json!({"PageSize": 100, "PageNumber": 1}), &region, access_key_id, access_key_secret).await { Ok(data) => items.extend(crate::array_at(&data, &["Zones"]).into_iter().map(zone)), Err(error) => errors.push(error) },
        "rds" => match json_request("rds_mysql", "2022-01-01", "DescribeDBInstances", json!({"PageSize": 100, "PageNumber": 1}), &region, access_key_id, access_key_secret).await { Ok(data) => { let source = crate::array_at(&data, &["Instances"]); items.extend(source.into_iter().map(|item| rds(item, &region))); }, Err(error) => errors.push(error) },
        "swas" => errors.push("火山引擎轻量应用服务器同步尚未接入".into()),
        "redis" => match json_request("Redis", "2020-12-07", "DescribeDBInstances", json!({"RegionId": region, "PageSize": 100, "PageNumber": 1}), &region, access_key_id, access_key_secret).await { Ok(data) => { let source = crate::array_at(&data, &["Instances"]); items.extend(source.into_iter().map(|item| redis(item, &region))); }, Err(error) => errors.push(error) },
        "esa" => errors.push("火山引擎边缘安全加速同步尚未接入".into()),
        other => errors.push(format!("火山引擎暂未接入 {other} 资源")),
    }
    ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_volc_server_fields_and_postpaid_expiry() {
        let raw = json!({"InstanceId": "i-example", "InstanceName": "example", "Status": "RUNNING", "Cpus": 2, "MemorySize": 4096, "InstanceTypeId": "ecs.example", "OsName": "Ubuntu 22.04", "OsType": "Linux", "CreatedAt": "2026-01-01T00:00:00Z", "ExpiredAt": "2200-01-01T00:00:00+08:00", "InstanceChargeType": "PostPaid", "EipAddress": {"IpAddress": "192.0.2.10"}, "NetworkInterfaces": [{"Type": "primary", "PrimaryIpAddress": "10.0.0.8", "SecurityGroupIds": ["sg-example"]}]});
        let item = instance(&raw, "cn-guangzhou");
        assert_eq!(item["Cpu"], 2);
        assert_eq!(item["Memory"], 4096);
        assert_eq!(item["OSName"], "Ubuntu 22.04");
        assert_eq!(item["PrivateIpAddress"], "10.0.0.8");
        assert_eq!(item["PublicIpAddress"], "192.0.2.10");
        assert!(item["ExpiredTime"].is_null());
        assert_eq!(item["PaymentTiming"], "Postpaid");
        assert!(item.get("InternetMaxBandwidthOut").is_none());
    }

    #[tokio::test]
    async fn ecs_inventory_follows_region_and_instance_pages() {
        let (items, errors) = ecs_instances("cn-beijing", |action, params, region| async move {
            assert!(params.contains_key("MaxResults"));
            assert!(!params.contains_key("PageNumber"));
            match (action, region.as_str(), params.get("NextToken").map(String::as_str)) {
                ("DescribeRegions", _, None) => Ok(json!({"Regions": [{"RegionId": "cn-beijing"}], "NextToken": "region-page-2"})),
                ("DescribeRegions", _, Some("region-page-2")) => Ok(json!({"Regions": [{"RegionId": "cn-shanghai"}]})),
                ("DescribeInstances", "cn-beijing", None) => Ok(json!({"Instances": []})),
                ("DescribeInstances", "cn-shanghai", None) => Ok(json!({"Instances": [{"InstanceId": "instance-a"}], "NextToken": "instance-page-2"})),
                ("DescribeInstances", "cn-shanghai", Some("instance-page-2")) => Ok(json!({"Instances": [{"InstanceId": "instance-b"}]})),
                _ => panic!("unexpected inventory request"),
            }
        }).await;
        assert!(errors.is_empty());
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|item| item["_region_id"] == "cn-shanghai"));
        assert_eq!(items[1]["InstanceId"], "instance-b");
    }

    #[tokio::test]
    async fn ecs_inventory_does_not_treat_failed_region_discovery_as_complete() {
        let (items, errors) = ecs_instances("cn-beijing", |action, _, _| async move {
            if action == "DescribeRegions" { Err("HTTP 403".into()) }
            else { Ok(json!({"Instances": [{"InstanceId": "instance-a"}]})) }
        }).await;
        assert_eq!(items.len(), 1);
        assert!(!errors.is_empty()); // Incomplete inventory must preserve cached regions.
        let malformed = ecs_pages(&|_, _, _| async { Ok(json!({})) }, "DescribeInstances", "cn-beijing", "Instances").await;
        assert!(malformed.is_err());
        let repeated = ecs_pages(&|_, _, _| async { Ok(json!({"Instances": [], "NextToken": "same-page"})) }, "DescribeInstances", "cn-beijing", "Instances").await;
        assert!(repeated.is_err());
    }

    #[test]
    fn provider_error_uses_structured_code_without_echoing_message() {
        let data = json!({"ResponseMetadata": {"Error": {
            "Code": "InvalidActionOrVersion", "Message": "untrusted provider text"
        }}});
        let message = api_error(&data, reqwest::StatusCode::BAD_REQUEST);
        assert!(message.contains("InvalidActionOrVersion"));
        assert!(!message.contains("untrusted provider text"));
        assert_eq!(crate::core::error::sanitize_resource_error(&message), message);
        let unknown = json!({"Error": {"Code": "untrusted provider text", "Message": "untrusted provider text"}});
        assert_eq!(api_error(&unknown, reqwest::StatusCode::FORBIDDEN), "云厂商权限不足，请检查账号权限");
    }
}
