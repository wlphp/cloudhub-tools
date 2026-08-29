use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chrono::Utc;
use hmac::{Hmac, Mac};
use md5::Md5;
use serde_json::{json, Value};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use uuid::Uuid;

use crate::{array_at, rpc_encode, string_params, write_api_log, xml_blocks, xml_text, ResourceResponse};

pub(crate) async fn aliyun_rpc(
    endpoint: &str,
    version: &str,
    action: &str,
    params: BTreeMap<String, String>,
    access_key_id: &str,
    access_key_secret: &str,
) -> Result<Value, String> {
    let mut query = params;
    query.insert("AccessKeyId".into(), access_key_id.into());
    query.insert("Action".into(), action.into());
    query.insert("Format".into(), "JSON".into());
    query.insert("SignatureMethod".into(), "HMAC-SHA1".into());
    query.insert("SignatureNonce".into(), Uuid::new_v4().to_string());
    query.insert("SignatureVersion".into(), "1.0".into());
    query.insert("Timestamp".into(), Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string());
    query.insert("Version".into(), version.into());

    let mut encoded: Vec<(String, String)> = query
        .iter()
        .map(|(key, value)| (rpc_encode(key), rpc_encode(value)))
        .collect();
    encoded.sort();
    let canonical = encoded
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&");
    let string_to_sign = format!("GET&%2F&{}", rpc_encode(&canonical));
    let mut mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(format!("{access_key_secret}&").as_bytes())
        .map_err(|error| error.to_string())?;
    mac.update(string_to_sign.as_bytes());
    query.insert("Signature".into(), B64.encode(mac.finalize().into_bytes()));

    let mut request_params: Vec<(String, String)> = query
        .iter()
        .map(|(key, value)| (rpc_encode(key), rpc_encode(value)))
        .collect();
    request_params.sort();
    let url = format!(
        "https://{endpoint}/?{}",
        request_params
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join("&")
    );
    let response = match reqwest::Client::new()
        .get(url)
        .timeout(std::time::Duration::from_secs(25))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            let message = format!("阿里云请求失败: {error}");
            write_api_log(access_key_id, endpoint, action, &json!(query), None, "失败", Some(&message));
            return Err(message);
        }
    };
    let status = response.status();
    let data: Value = match response.json().await {
        Ok(data) => data,
        Err(error) => {
            let message = format!("阿里云返回解析失败: {error}");
            write_api_log(access_key_id, endpoint, action, &json!(query), None, "失败", Some(&message));
            return Err(message);
        }
    };
    let api_error = data
        .get("Code")
        .and_then(Value::as_str)
        .is_some_and(|code| code != "200" && code != "Success");
    if !status.is_success() || api_error {
        let message = data
            .get("Message")
            .and_then(Value::as_str)
            .or_else(|| data.get("Code").and_then(Value::as_str))
            .unwrap_or("阿里云 API 返回错误");
        write_api_log(access_key_id, endpoint, action, &json!(query), Some(&data), "失败", Some(message));
        return Err(message.to_string());
    }
    write_api_log(access_key_id, endpoint, action, &json!(query), Some(&data), "成功", None);
    Ok(data)
}

pub(crate) async fn aliyun_esa(
    action: &str,
    params: BTreeMap<String, String>,
    method: &str,
    access_key_id: &str,
    access_key_secret: &str,
) -> Result<Value, String> {
    let host = "esa.cn-hangzhou.aliyuncs.com";
    let mut query: Vec<(String, String)> = params
        .iter()
        .map(|(key, value)| (rpc_encode(key), rpc_encode(value)))
        .collect();
    query.sort();
    let encoded_query = query
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&");
    let payload_hash = format!("{:x}", Sha256::digest(b""));
    let acs_date = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let nonce = Uuid::new_v4().to_string();
    let mut headers = BTreeMap::new();
    headers.insert("host", host.to_string());
    headers.insert("x-acs-action", action.to_string());
    headers.insert("x-acs-content-sha256", payload_hash.clone());
    headers.insert("x-acs-date", acs_date.clone());
    headers.insert("x-acs-signature-nonce", nonce.clone());
    headers.insert("x-acs-version", "2024-09-10".to_string());
    let canonical_headers = headers
        .iter()
        .map(|(key, value)| format!("{key}:{value}\n"))
        .collect::<String>();
    let signed_headers = headers.keys().cloned().collect::<Vec<_>>().join(";");
    let method = method.to_uppercase();
    let canonical_request = format!("{method}\n/\n{encoded_query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let string_to_sign = format!("ACS3-HMAC-SHA256\n{:x}", Sha256::digest(canonical_request.as_bytes()));
    let mut mac: Hmac<Sha256> = <Hmac<Sha256> as Mac>::new_from_slice(access_key_secret.as_bytes())
        .map_err(|error| error.to_string())?;
    mac.update(string_to_sign.as_bytes());
    let authorization = format!(
        "ACS3-HMAC-SHA256 Credential={access_key_id},SignedHeaders={signed_headers},Signature={}",
        hex::encode(mac.finalize().into_bytes())
    );
    let url = if encoded_query.is_empty() {
        format!("https://{host}/")
    } else {
        format!("https://{host}/?{encoded_query}")
    };
    let client = reqwest::Client::new();
    let request = if method == "POST" { client.post(url) } else { client.get(url) };
    let response = request
        .header("host", host)
        .header("x-acs-action", action)
        .header("x-acs-content-sha256", payload_hash)
        .header("x-acs-date", acs_date)
        .header("x-acs-signature-nonce", nonce)
        .header("x-acs-version", "2024-09-10")
        .header("authorization", authorization)
        .timeout(std::time::Duration::from_secs(25))
        .send()
        .await
        .map_err(|error| format!("ESA 请求失败: {error}"))?;
    let status = response.status();
    let data: Value = response.json().await.map_err(|error| format!("ESA 返回解析失败: {error}"))?;
    if !status.is_success() || data.get("Code").is_some() {
        let message = data
            .get("Message")
            .and_then(Value::as_str)
            .or_else(|| data.get("Code").and_then(Value::as_str))
            .unwrap_or("ESA API 返回错误");
        write_api_log(access_key_id, host, action, &json!(params), Some(&data), "失败", Some(message));
        return Err(message.to_string());
    }
    write_api_log(access_key_id, host, action, &json!(params), Some(&data), "成功", None);
    Ok(data)
}

pub(crate) async fn oss_list_buckets(access_key_id: &str, access_key_secret: &str) -> Result<Vec<Value>, String> {
    let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    let string_to_sign = format!("GET\n\n\n{date}\n/");
    let mut mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(access_key_secret.as_bytes())
        .map_err(|error| error.to_string())?;
    mac.update(string_to_sign.as_bytes());
    let authorization = format!("OSS {access_key_id}:{}", B64.encode(mac.finalize().into_bytes()));
    let response = reqwest::Client::new()
        .get("https://oss-cn-hangzhou.aliyuncs.com/")
        .header("Date", date)
        .header("Host", "oss-cn-hangzhou.aliyuncs.com")
        .header("Authorization", authorization)
        .timeout(std::time::Duration::from_secs(25))
        .send()
        .await
        .map_err(|error| format!("OSS 请求失败: {error}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|error| format!("OSS 返回读取失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("OSS 返回错误（{}）", status));
    }
    let mut items = Vec::new();
    let mut rest = body.as_str();
    while let Some(start) = rest.find("<Bucket>") {
        let chunk = &rest[start..];
        let Some(end) = chunk.find("</Bucket>") else { break };
        let bucket = &chunk[..end];
        let value = |tag: &str| -> String {
            let open = format!("<{tag}>");
            let close = format!("</{tag}>");
            bucket
                .find(&open)
                .and_then(|start| bucket[start + open.len()..].find(&close).map(|end| bucket[start + open.len()..start + open.len() + end].to_string()))
                .unwrap_or_default()
        };
        let name = value("Name");
        let location = value("Location");
        items.push(json!({
            "Name": name,
            "Location": location,
            "CreationDate": value("CreationDate"),
            "StorageClass": "Standard",
            "ExtranetEndpoint": format!("{}.{}.aliyuncs.com", name, location),
        }));
        rest = &chunk[end + "</Bucket>".len()..];
    }
    Ok(items)
}

pub(crate) async fn oss_list_objects(bucket: &str, location: &str, access_key_id: &str, access_key_secret: &str, prefix: &str, marker: &str) -> Result<Value, String> {
    let location = if location.is_empty() { "oss-cn-hangzhou" } else { location };
    let host = format!("{bucket}.{location}.aliyuncs.com");
    let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    let string_to_sign = format!("GET\n\n\n{date}\n/{bucket}/");
    let mut mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|error| error.to_string())?;
    mac.update(string_to_sign.as_bytes());
    let mut query = "delimiter=%2F&max-keys=1000".to_string();
    if !prefix.is_empty() { query.push_str(&format!("&prefix={}", rpc_encode(prefix))); }
    if !marker.is_empty() { query.push_str(&format!("&marker={}", rpc_encode(marker))); }
    let response = reqwest::Client::new().get(format!("https://{host}/?{query}"))
        .header("Date", date).header("Host", &host)
        .header("Authorization", format!("OSS {access_key_id}:{}", B64.encode(mac.finalize().into_bytes())))
        .timeout(std::time::Duration::from_secs(25)).send().await
        .map_err(|error| format!("OSS 请求失败: {error}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        let code = body.split("<Code>").nth(1).and_then(|value| value.split("</Code>").next()).unwrap_or("请求被拒绝");
        return Err(format!("OSS 返回错误（{status}）：{code}"));
    }
    let objects = xml_blocks(&body, "Contents").into_iter().map(|object| json!({
        "Key": xml_text(&object, "Key"), "Size": xml_text(&object, "Size"),
        "LastModified": xml_text(&object, "LastModified"), "ETag": xml_text(&object, "ETag"),
    })).filter(|object| object.get("Key").and_then(Value::as_str).is_some_and(|key| !key.is_empty() && key != prefix)).collect::<Vec<_>>();
    Ok(json!({
        "objects": objects,
        "prefixes": xml_blocks(&body, "CommonPrefixes").into_iter().map(|entry| xml_text(&entry, "Prefix")).filter(|value| !value.is_empty()).collect::<Vec<_>>(),
        "isTruncated": xml_text(&body, "IsTruncated").eq_ignore_ascii_case("true"),
        "nextMarker": xml_text(&body, "NextMarker"),
    }))
}

pub(crate) async fn oss_get_acl(bucket: &str, location: &str, access_key_id: &str, access_key_secret: &str) -> Result<String, String> {
    let location = if location.is_empty() { "oss-cn-hangzhou" } else { location };
    let host = format!("{bucket}.{location}.aliyuncs.com");
    let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    let string_to_sign = format!("GET\n\n\n{date}\n/{bucket}/?acl");
    let mut mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|error| error.to_string())?;
    mac.update(string_to_sign.as_bytes());
    let response = reqwest::Client::new().get(format!("https://{host}/?acl"))
        .header("Date", date).header("Host", &host)
        .header("Authorization", format!("OSS {access_key_id}:{}", B64.encode(mac.finalize().into_bytes())))
        .timeout(std::time::Duration::from_secs(25)).send().await
        .map_err(|error| format!("OSS 请求失败: {error}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        let code = body.split("<Code>").nth(1).and_then(|value| value.split("</Code>").next()).unwrap_or("请求被拒绝");
        return Err(format!("OSS 返回错误（{status}）：{code}"));
    }
    let grant = body.split("<Grant>").nth(1).and_then(|value| value.split("</Grant>").next()).unwrap_or("");
    Ok(grant.split("<Permission>").nth(1).and_then(|value| value.split("</Permission>").next()).unwrap_or("private").to_string())
}

pub(crate) async fn oss_set_public_read(bucket: &str, location: &str, access_key_id: &str, access_key_secret: &str) -> Result<(), String> {
    let location = if location.is_empty() { "oss-cn-hangzhou" } else { location };
    let host = format!("{bucket}.{location}.aliyuncs.com");
    let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    let string_to_sign = format!("PUT\n\n\n{date}\nx-oss-acl:public-read\n/{bucket}/?acl");
    let mut mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|error| error.to_string())?;
    mac.update(string_to_sign.as_bytes());
    let response = reqwest::Client::new().put(format!("https://{host}/?acl"))
        .header("Date", date).header("Host", &host).header("x-oss-acl", "public-read").header("Content-Length", "0")
        .header("Authorization", format!("OSS {access_key_id}:{}", B64.encode(mac.finalize().into_bytes())))
        .timeout(std::time::Duration::from_secs(25)).send().await
        .map_err(|error| format!("OSS 请求失败: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("OSS 返回错误（{}）", response.status()));
    }
    Ok(())
}

pub(crate) async fn oss_set_cors(bucket: &str, location: &str, origins: &str, access_key_id: &str, access_key_secret: &str) -> Result<(), String> {
    let location = if location.is_empty() { "oss-cn-hangzhou" } else { location };
    let host = format!("{bucket}.{location}.aliyuncs.com");
    let safe_origin = origins.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let body = format!(r#"<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration><CORSRule><AllowedOrigin>{safe_origin}</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>POST</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>DELETE</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><ExposeHeader>x-oss-request-id</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>"#);
    let md5 = B64.encode(Md5::digest(body.as_bytes()));
    let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    let string_to_sign = format!("PUT\n{md5}\napplication/xml\n{date}\n/{bucket}/?cors");
    let mut mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|error| error.to_string())?;
    mac.update(string_to_sign.as_bytes());
    let response = reqwest::Client::new().put(format!("https://{host}/?cors"))
        .header("Date", date).header("Host", &host).header("Content-Type", "application/xml").header("Content-MD5", md5)
        .header("Authorization", format!("OSS {access_key_id}:{}", B64.encode(mac.finalize().into_bytes())))
        .body(body).timeout(std::time::Duration::from_secs(25)).send().await
        .map_err(|error| format!("OSS 请求失败: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("OSS 返回错误（{}）", response.status()));
    }
    Ok(())
}

pub(crate) fn esa_field_details<'a>(data: &'a Value, field_name: &str) -> Vec<&'a Value> {
    array_at(data, &["Data"])
        .into_iter()
        .find(|item| item.get("FieldName").and_then(Value::as_str) == Some(field_name))
        .map(|item| array_at(item, &["DetailData"]))
        .unwrap_or_default()
}

pub(crate) fn esa_number(value: Option<&Value>) -> f64 {
    value.and_then(Value::as_f64).or_else(|| value.and_then(Value::as_str).and_then(|text| text.parse::<f64>().ok())).unwrap_or(0.0)
}

async fn list_regions(access_key_id: &str, access_key_secret: &str) -> Result<Vec<(String, String)>, String> {
    let result = aliyun_rpc("ecs.aliyuncs.com", "2014-05-26", "DescribeRegions", BTreeMap::new(), access_key_id, access_key_secret).await?;
    Ok(array_at(&result, &["Regions", "Region"]).into_iter().filter_map(|region| Some((region.get("RegionId")?.as_str()?.to_string(), region.get("LocalName").and_then(Value::as_str).unwrap_or("").to_string()))).collect())
}

pub(crate) async fn resource_items(resource_type: &str, access_key_id: &str, access_key_secret: &str) -> ResourceResponse {
    let mut items = Vec::new();
    let mut errors = Vec::new();
    let mut add_error = |message: String| errors.push(message);
    match resource_type {
        "ecs" => match list_regions(access_key_id, access_key_secret).await {
            Ok(regions) => for (region_id, region_name) in regions {
                match aliyun_rpc(&format!("ecs.{region_id}.aliyuncs.com"), "2014-05-26", "DescribeInstances", string_params(&[("RegionId", region_id.clone()), ("PageSize", "100".into())]), access_key_id, access_key_secret).await {
                    Ok(result) => for item in array_at(&result, &["Instances", "Instance"]) { let mut value = item.clone(); if let Value::Object(ref mut object) = value { object.insert("_region_id".into(), json!(region_id)); object.insert("_region_name".into(), json!(region_name)); } items.push(value); },
                    Err(error) => add_error(format!("{region_id}: {error}")),
                }
            },
            Err(error) => add_error(error),
        },
        "domain" => {
            let registration = aliyun_rpc("domain.aliyuncs.com", "2018-01-29", "QueryDomainList", string_params(&[("PageNum", "1".into()), ("PageSize", "100".into())]), access_key_id, access_key_secret).await;
            let dns = aliyun_rpc("alidns.aliyuncs.com", "2015-01-09", "DescribeDomains", string_params(&[("PageNumber", "1".into()), ("PageSize", "20".into())]), access_key_id, access_key_secret).await;
            let registration_failed = registration.is_err();
            let dns_failed = dns.is_err();
            let mut merged: BTreeMap<String, Value> = BTreeMap::new();
            if let Ok(result) = registration { for item in array_at(&result, &["Data", "Domain"]) { if let Some(name) = item.get("DomainName").and_then(Value::as_str) { merged.insert(name.to_lowercase(), (*item).clone()); } } }
            if let Ok(result) = dns { for item in array_at(&result, &["Domains", "Domain"]) { if let Some(name) = item.get("DomainName").and_then(Value::as_str) { let entry = merged.entry(name.to_lowercase()).or_insert_with(|| json!({"DomainName": name})); if let Some(target) = entry.as_object_mut() { if let Some(source) = item.as_object() { for (key, value) in source { target.insert(key.clone(), value.clone()); } } target.insert("RecordCount".into(), item.get("RecordCount").cloned().unwrap_or(json!(0))); } } } }
            if merged.is_empty() && registration_failed && dns_failed { add_error("域名注册和 DNS 接口均请求失败".into()); }
            items.extend(merged.into_values());
        }
        "rds" => match list_regions(access_key_id, access_key_secret).await {
            Ok(regions) => for (region_id, region_name) in regions { match aliyun_rpc("rds.aliyuncs.com", "2014-08-15", "DescribeDBInstances", string_params(&[("RegionId", region_id.clone()), ("PageSize", "100".into())]), access_key_id, access_key_secret).await { Ok(result) => for item in array_at(&result, &["Items", "DBInstance"]) { let mut value = item.clone(); if let Value::Object(ref mut object) = value { object.insert("_region_id".into(), json!(region_id)); object.insert("_region_name".into(), json!(region_name)); } items.push(value); }, Err(error) => add_error(format!("{region_id}: {error}")), } },
            Err(error) => add_error(error),
        },
        "redis" => match list_regions(access_key_id, access_key_secret).await {
            Ok(regions) => for (region_id, region_name) in regions { match aliyun_rpc("r-kvstore.aliyuncs.com", "2015-01-01", "DescribeInstances", string_params(&[("RegionId", region_id.clone()), ("PageSize", "100".into())]), access_key_id, access_key_secret).await { Ok(result) => for item in array_at(&result, &["Instances", "KVStoreInstance"]) { let mut value = item.clone(); if let Value::Object(ref mut object) = value { object.insert("_region_id".into(), json!(region_id)); object.insert("_region_name".into(), json!(region_name)); } items.push(value); }, Err(error) => add_error(format!("{region_id}: {error}")), } },
            Err(error) => add_error(error),
        },
        "swas" => for region_id in ["cn-hangzhou", "cn-shanghai", "cn-beijing", "cn-shenzhen", "cn-hongkong", "ap-southeast-1"] { match aliyun_rpc(&format!("swas.{region_id}.aliyuncs.com"), "2020-06-01", "ListInstances", string_params(&[("RegionId", region_id.to_string()), ("PageSize", "100".into())]), access_key_id, access_key_secret).await { Ok(result) => items.extend(array_at(&result, &["Instances"]).into_iter().cloned()), Err(error) => add_error(format!("{region_id}: {error}")), } },
        "esa" => match aliyun_esa("ListSites", string_params(&[("PageNumber", "1".into()), ("PageSize", "100".into())]), "GET", access_key_id, access_key_secret).await { Ok(result) => items.extend(array_at(&result, &["Sites"]).into_iter().cloned()), Err(error) => add_error(error) },
        "oss" => match oss_list_buckets(access_key_id, access_key_secret).await { Ok(values) => items.extend(values), Err(error) => add_error(error) },
        other => add_error(format!("暂不支持资源类型: {other}")),
    }
    ResourceResponse { resource_type: resource_type.to_string(), items, errors, fetched_at: Utc::now().timestamp_millis() }
}
