use crate::{
    account_cloud_type, account_credentials, array_at, rpc_encode, string_params,
    write_api_log, ResourceResponse,
};
use crate::core::storage::open_db;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chrono::Utc;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, future::Future};

fn encode(value: &str) -> String { rpc_encode(value) }

fn canonical_uri(path: &str) -> String {
    let value = path.split('/').map(encode).collect::<Vec<_>>().join("/");
    if value.is_empty() { "/".into() } else { value }
}

fn query_string(query: &BTreeMap<String, String>) -> String {
    let mut values = query.iter().filter(|(_, value)| !value.is_empty()).map(|(key, value)| (encode(key), encode(value))).collect::<Vec<_>>();
    values.sort();
    values.into_iter().map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>().join("&")
}

fn error_message(data: &Value, status: reqwest::StatusCode) -> String {
    data.get("error_msg").or_else(|| data.get("message")).or_else(|| data.pointer("/error/message")).or_else(|| data.get("code")).and_then(Value::as_str).unwrap_or(&format!("华为云 {status}")).to_string()
}

async fn request(id: i64, host: &str, path: &str, query: BTreeMap<String, String>) -> Result<Value, String> {
    if account_cloud_type(id)? != "huawei" { return Err("当前账号不是华为云账号".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let query_text = query_string(&query);
    let canonical_uri = canonical_uri(path);
    let date = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let canonical_headers = format!("host:{host}\nx-sdk-date:{date}\n");
    let payload_hash = format!("{:x}", Sha256::digest(b""));
    let canonical_request = format!("GET\n{canonical_uri}\n{query_text}\n{canonical_headers}\nhost;x-sdk-date\n{payload_hash}");
    let string_to_sign = format!("SDK-HMAC-SHA256\n{date}\n{:x}", Sha256::digest(canonical_request.as_bytes()));
    let mut mac: Hmac<Sha256> = <Hmac<Sha256> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|error| error.to_string())?;
    mac.update(string_to_sign.as_bytes());
    let authorization = format!("SDK-HMAC-SHA256 Access={access_key_id}, SignedHeaders=host;x-sdk-date, Signature={}", hex::encode(mac.finalize().into_bytes()));
    let url = format!("https://{host}{canonical_uri}{}", if query_text.is_empty() { String::new() } else { format!("?{query_text}") });
    let response = reqwest::Client::new().get(url).header("Host", host).header("X-Sdk-Date", &date).header("Authorization", authorization).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("华为云请求失败: {error}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|error| format!("华为云返回读取失败: {error}"))?;
    let data: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({"message": text}));
    if !status.is_success() {
        let message = error_message(&data, status);
        write_api_log(&access_key_id, host, &format!("GET {path}"), &json!(query), Some(&data), "失败", Some(&message));
        return Err(message);
    }
    write_api_log(&access_key_id, host, &format!("GET {path}"), &json!(query), Some(&data), "成功", None);
    Ok(data)
}

async fn offset_pages<F, Fut>(mut fetch_page: F, path: &[&str], page_size: usize) -> Result<Vec<Value>, String>
where
    F: FnMut(usize) -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    let mut items = Vec::new();
    for offset in (0..10_000).step_by(page_size) {
        let data = fetch_page(offset).await?;
        let page = array_at(&data, path).into_iter().cloned().collect::<Vec<_>>();
        let count = page.len();
        items.extend(page);
        if count < page_size { return Ok(items); }
    }
    Err("分页超过 100 页，已停止读取".into())
}

async fn context(id: i64) -> Result<(String, Vec<Value>), String> {
    let default_region = open_db()?.query_row("SELECT region_id FROM cloud_accounts WHERE id=?1", [id], |row| row.get::<_, Option<String>>(0)).map_err(|error| error.to_string())?.filter(|value| !value.trim().is_empty()).unwrap_or_else(|| "cn-north-4".into());
    let data = request(id, &format!("iam.{default_region}.myhuaweicloud.com"), "/v3/projects", string_params(&[("enabled", "true".into())])).await?;
    let projects = array_at(&data, &["projects"]).into_iter().filter(|project| project.get("id").and_then(Value::as_str).is_some_and(|value| !value.is_empty()) && project.get("name").and_then(Value::as_str).is_some_and(|value| !value.is_empty()) && project.get("status").and_then(Value::as_str).map(|value| value.eq_ignore_ascii_case("enabled")).unwrap_or(true)).cloned().collect::<Vec<_>>();
    if projects.is_empty() { return Err("未读取到可用项目，请检查 IAM 项目权限".into()); }
    Ok((default_region, projects))
}

fn instance(item: &Value, region: &str, project: &Value) -> Value {
    let addresses = item.get("addresses").and_then(Value::as_object).into_iter().flat_map(|group| group.values()).filter_map(Value::as_array).flatten().collect::<Vec<_>>();
    let public_ip = addresses.iter().find(|address| address.get("OS-EXT-IPS:type").and_then(Value::as_str).is_some_and(|kind| kind.eq_ignore_ascii_case("floating"))).and_then(|address| address.get("addr")).cloned().unwrap_or(json!(""));
    let private_ip = addresses.iter().find(|address| !address.get("OS-EXT-IPS:type").and_then(Value::as_str).is_some_and(|kind| kind.eq_ignore_ascii_case("floating"))).and_then(|address| address.get("addr")).cloned().unwrap_or(json!(""));
    let mut value = item.clone();
    if let Value::Object(ref mut target) = value {
        target.insert("InstanceId".into(), item.get("id").cloned().unwrap_or(json!(""))); target.insert("InstanceName".into(), item.get("name").or_else(|| item.get("id")).cloned().unwrap_or(json!("")));
        target.insert("InstanceStatus".into(), item.get("status").cloned().unwrap_or(json!(""))); target.insert("Status".into(), item.get("status").cloned().unwrap_or(json!("")));
        target.insert("PublicIpAddress".into(), public_ip); target.insert("PrivateIpAddress".into(), private_ip); target.insert("InstanceType".into(), item.pointer("/flavor/id").or_else(|| item.pointer("/flavor/name")).cloned().unwrap_or(json!("")));
        target.insert("VpcId".into(), item.pointer("/metadata/vpc_id").cloned().unwrap_or(json!(""))); target.insert("_region_id".into(), json!(region)); target.insert("_project_id".into(), project.get("id").cloned().unwrap_or(json!("")));
    }
    value
}

fn rds(item: &Value, region: &str, project: &Value) -> Value {
    json!({"DBInstanceId": item.get("id"), "DBInstanceDescription": item.get("name").or_else(|| item.get("id")), "DBInstanceStatus": item.get("status"), "DBInstanceClass": item.get("flavor_ref").or_else(|| item.pointer("/flavor/id")), "DBInstanceStorage": item.pointer("/volume/size").unwrap_or(&json!(0)), "ConnectionString": item.pointer("/private_ips/0").or_else(|| item.pointer("/nodes/0/private_ip")), "Port": item.get("port"), "Engine": item.pointer("/datastore/type"), "EngineVersion": item.pointer("/datastore/version"), "CreateTime": item.get("created"), "_region_id": region, "_project_id": project.get("id"), "_raw": item})
}

fn redis(item: &Value, region: &str, project: &Value) -> Value {
    let capacity = item.get("capacity").and_then(|value| value.as_f64().or_else(|| value.as_str()?.parse().ok())).unwrap_or(0.0) * 1024.0;
    json!({"InstanceId": item.get("instance_id").or_else(|| item.get("id")), "InstanceName": item.get("name").or_else(|| item.get("instance_id")).or_else(|| item.get("id")), "InstanceStatus": item.get("status").or_else(|| item.get("operating_status")), "InstanceType": item.get("engine").unwrap_or(&json!("Redis")), "InstanceClass": item.get("specification").or_else(|| item.get("capacity")), "Capacity": capacity, "ConnectionDomain": item.get("ip").or_else(|| item.get("private_ip")), "Port": item.get("port"), "EngineVersion": item.get("engine_version"), "NetworkType": item.get("vpc_name"), "_region_id": region, "_project_id": project.get("id"), "_raw": item})
}

fn zone(item: &Value) -> Value {
    let name = item.get("name").and_then(Value::as_str).unwrap_or("").trim_end_matches('.');
    json!({"DomainName": name, "DomainStatus": item.get("status").unwrap_or(&json!("ACTIVE")), "ZoneId": item.get("id"), "RecordCount": item.get("record_num").unwrap_or(&json!(0)), "RegistrationDate": item.get("created_at"), "_region_id": "cn-north-4", "_huawei_public_zone": true, "_raw": item})
}

fn xml_text(body: &str, tag: &str) -> String {
    let open = format!("<{tag}>"); let close = format!("</{tag}>");
    body.find(&open).and_then(|start| body[start + open.len()..].find(&close).map(|end| body[start + open.len()..start + open.len() + end].to_string())).unwrap_or_default()
}

fn xml_blocks(body: &str, tag: &str) -> Vec<String> {
    let open = format!("<{tag}>"); let close = format!("</{tag}>"); let mut values = Vec::new(); let mut rest = body;
    while let Some(start) = rest.find(&open) { let chunk = &rest[start + open.len()..]; let Some(end) = chunk.find(&close) else { break }; values.push(chunk[..end].to_string()); rest = &chunk[end + close.len()..]; }
    values
}

async fn obs_buckets(id: i64, region: &str) -> Result<Vec<Value>, String> {
    if account_cloud_type(id)? != "huawei" { return Err("当前账号不是华为云账号".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let host = format!("obs.{region}.myhuaweicloud.com");
    let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    let mut mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|error| error.to_string())?;
    mac.update(format!("GET\n\n\n{date}\n/").as_bytes());
    let response = reqwest::Client::new().get(format!("https://{host}/")).header("Date", &date).header("Host", &host).header("Authorization", format!("OBS {access_key_id}:{}", B64.encode(mac.finalize().into_bytes()))).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("OBS 请求失败: {error}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        let message = format!("OBS {status}: {}", { let value = xml_text(&body, "Message"); if value.is_empty() { xml_text(&body, "Code") } else { value } });
        write_api_log(&access_key_id, &host, "ListBuckets", &json!({}), Some(&json!({"body": body})), "失败", Some(&message));
        return Err(message);
    }
    let buckets = xml_blocks(&body, "Bucket").into_iter().map(|bucket| {
        let name = xml_text(&bucket, "Name");
        let location = { let value = xml_text(&bucket, "Location"); if value.is_empty() { region.to_string() } else { value } };
        json!({"Name": name, "BucketName": name, "Location": location, "CreationDate": xml_text(&bucket, "CreationDate"), "StorageClass": "STANDARD", "Acl": "private", "ExtranetEndpoint": "-", "IntranetEndpoint": "-", "_region_id": location})
    }).filter(|bucket| bucket.get("Name").and_then(Value::as_str).is_some_and(|value| !value.is_empty())).collect::<Vec<_>>();
    write_api_log(&access_key_id, &host, "ListBuckets", &json!({}), Some(&json!({"count": buckets.len()})), "成功", None);
    Ok(buckets)
}

pub(crate) async fn resource_items(id: i64, resource_type: &str) -> ResourceResponse {
    let now = Utc::now().timestamp_millis();
    let (default_region, projects) = match context(id).await { Ok(value) => value, Err(error) => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![error], fetched_at: now } };
    let mut items = Vec::new(); let mut errors = Vec::new();
    if resource_type == "domain" {
        match offset_pages(|offset| request(id, "dns.cn-north-4.myhuaweicloud.com", "/v2/zones", string_params(&[("limit", "500".into()), ("offset", offset.to_string())])), &["zones"], 500).await { Ok(values) => items.extend(values.into_iter().map(|item| zone(&item))), Err(error) => errors.push(format!("cn-north-4: {error}")), }
        return ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now };
    }
    if resource_type == "oss" {
        let mut regions = projects.iter().filter_map(|project| project.get("name").and_then(Value::as_str)).map(String::from).collect::<Vec<_>>(); regions.push(default_region); regions.sort(); regions.dedup();
        for region in regions { match obs_buckets(id, &region).await { Ok(values) => items.extend(values), Err(error) => errors.push(format!("{region}: {error}")), } }
        let mut unique = BTreeMap::new(); for item in items { if let Some(name) = item.get("Name").and_then(Value::as_str) { unique.insert(name.to_string(), item); } }
        return ResourceResponse { resource_type: resource_type.into(), items: unique.into_values().collect(), errors, fetched_at: now };
    }
    let service = match resource_type { "ecs" => Some(("ecs", "/v1/{project}/cloudservers/detail", "servers")), "rds" => Some(("rds", "/v3/{project}/instances", "instances")), "redis" => Some(("dcs", "/v2/{project}/instances", "instances")), _ => None };
    let Some((service_name, path_template, response_path)) = service else { return ResourceResponse { resource_type: resource_type.into(), items, errors: vec![format!("华为云暂未接入 {resource_type} 资源")], fetched_at: now }; };
    for project in &projects {
        let region = project.get("name").and_then(Value::as_str).unwrap_or(""); let project_id = project.get("id").and_then(Value::as_str).unwrap_or("");
        if region.is_empty() || project_id.is_empty() { continue; }
        let path = path_template.replace("{project}", &encode(project_id)); let host = format!("{service_name}.{region}.myhuaweicloud.com");
        match offset_pages(|offset| request(id, &host, &path, string_params(&[("limit", "100".into()), ("offset", offset.to_string())])), &[response_path], 100).await {
            Ok(values) => for item in values { items.push(match resource_type { "ecs" => instance(&item, region, project), "rds" => rds(&item, region, project), "redis" => redis(&item, region, project), _ => item }); },
            Err(error) => errors.push(format!("{region}: {error}")),
        }
    }
    ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now }
}

#[tauri::command]
pub(crate) async fn verify_huawei_account(id: i64) -> Result<Value, String> {
    let (default_region, projects) = context(id).await?;
    let mut regions = projects.iter().filter_map(|project| project.get("name").and_then(Value::as_str)).map(String::from).collect::<Vec<_>>(); regions.sort(); regions.dedup();
    Ok(json!({"provider": "huawei", "verified": true, "region_count": regions.len(), "regions": regions, "default_region": default_region, "project_count": projects.len()}))
}
