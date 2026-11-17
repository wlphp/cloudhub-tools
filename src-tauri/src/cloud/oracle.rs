use chrono::Utc;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rsa::{pkcs1::DecodeRsaPrivateKey, pkcs8::DecodePrivateKey, RsaPrivateKey};
use rsa::pkcs1v15::SigningKey;
use rsa::signature::{SignatureEncoding, Signer};
use serde_json::json;
use serde_json::Value;
use sha2::{Digest, Sha256};
use crate::ResourceResponse;

#[derive(Clone)]
struct Credentials { user_ocid: String, tenancy_ocid: String, fingerprint: String, private_key: String, region: String }

fn normalize_key(value: &str) -> String { let mut key = value.trim().to_string(); if key.to_ascii_uppercase().starts_with("OCI_API_KEY") { if let Some((name, rest)) = key.split_once('=') { if name.trim().eq_ignore_ascii_case("OCI_API_KEY") { key = rest.trim().to_string(); } } } if key.len() >= 2 && ((key.starts_with('"') && key.ends_with('"')) || (key.starts_with('\'') && key.ends_with('\''))) { key = key[1..key.len() - 1].to_string(); } key = key.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\r", "\n").replace("\r\n", "\n").replace('\r', "\n"); key.lines().map(|line| { let trimmed = line.trim_start(); if (trimmed.starts_with("\\-----BEGIN ") || trimmed.starts_with("\\-----END ")) && trimmed.contains("PRIVATE KEY-----") { &trimmed[1..] } else { line } }).collect::<Vec<_>>().join("\n") }

fn credentials(id: i64) -> Result<Credentials, String> { let conn = crate::open_db()?; let row = crate::account_repository::oracle_record(&conn, id)?; if row.4 != 1 { return Err("云账号已停用".into()); } if row.5 != "oracle" { return Err("当前账号不是 Oracle Cloud 账号".into()); } let tenancy_ocid = row.2.get("tenancy_ocid").and_then(Value::as_str).unwrap_or("").trim().to_string(); let fingerprint = row.2.get("key_fingerprint").and_then(Value::as_str).unwrap_or("").trim().to_string(); if tenancy_ocid.is_empty() || fingerprint.is_empty() { return Err("OCI 账号缺少 Tenancy OCID 或 Key Fingerprint".into()); } Ok(Credentials { user_ocid: row.0, tenancy_ocid, fingerprint, private_key: normalize_key(&crate::decrypt_secret(&row.1)?), region: row.3.filter(|value| !value.trim().is_empty()).unwrap_or_else(|| "ap-tokyo-1".into()) }) }

fn query(params: &[(String, String)]) -> String { params.iter().map(|(key, value)| format!("{}={}", crate::rpc_encode(key), crate::rpc_encode(value))).collect::<Vec<_>>().join("&") }
fn object_storage_host(region: &str) -> String { format!("objectstorage.{region}.oci.customer-oci.com") }
fn is_user_compartment(compartment: &Value) -> bool { !compartment.get("name").and_then(Value::as_str).is_some_and(|name| name.eq_ignore_ascii_case("ManagedCompartmentForPaaS")) }

async fn request(credentials: &Credentials, host: &str, path: &str) -> Result<(Value, Option<String>), String> { let private_key = RsaPrivateKey::from_pkcs8_pem(&credentials.private_key).or_else(|_| RsaPrivateKey::from_pkcs1_pem(&credentials.private_key)).map_err(|_| "OCI API 私钥无效，需使用未加密的 RSA PEM 私钥".to_string())?; let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string(); let canonical = format!("(request-target): get {path}\nhost: {host}\ndate: {date}"); let signature = B64.encode(SigningKey::<Sha256>::new(private_key).sign(canonical.as_bytes()).to_vec()); let key_id = format!("{}/{}/{}", credentials.tenancy_ocid, credentials.user_ocid, credentials.fingerprint); let authorization = format!("Signature version=\"1\",keyId=\"{key_id}\",algorithm=\"rsa-sha256\",headers=\"(request-target) host date\",signature=\"{signature}\""); let response = reqwest::Client::new().get(format!("https://{host}{path}")).header("host", host).header("date", &date).header("authorization", authorization).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("OCI 请求失败: {error}"))?; let status = response.status(); let next_page = response.headers().get("opc-next-page").and_then(|value| value.to_str().ok()).map(str::to_string); let text = response.text().await.map_err(|error| format!("OCI 返回读取失败: {error}"))?; let data = serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text)); if !status.is_success() { let message = data.get("message").or_else(|| data.get("code")).and_then(Value::as_str).unwrap_or("OCI API 返回错误").to_string(); crate::write_api_log(&credentials.user_ocid, host, &format!("GET {}", path.split('?').next().unwrap_or(path)), &json!({}), Some(&data), "失败", Some(&message)); return Err(message); } crate::write_api_log(&credentials.user_ocid, host, &format!("GET {}", path.split('?').next().unwrap_or(path)), &json!({}), Some(&data), "成功", None); Ok((data, next_page)) }

async fn pages(credentials: &Credentials, host: &str, base_path: &str, parameters: Vec<(String, String)>) -> Result<Vec<Value>, String> { let mut values = Vec::new(); let mut page = None; for _ in 0..100 { let mut params = parameters.clone(); if let Some(token) = page { params.push(("page".into(), token)); } let query_text = query(&params); let path = if query_text.is_empty() { base_path.to_string() } else { format!("{base_path}?{query_text}") }; let (data, next) = request(credentials, host, &path).await?; if let Some(array) = data.as_array() { values.extend(array.iter().cloned()); } if next.is_none() { return Ok(values); } page = next; } Err("OCI 分页超过 100 页，已停止读取".into()) }

async fn context(credentials: &Credentials) -> Result<(Vec<Value>, Vec<String>), String> { let host = format!("identity.{}.oci.oraclecloud.com", credentials.region); let compartments = pages(credentials, &host, "/20160918/compartments", vec![("compartmentId".into(), credentials.tenancy_ocid.clone()), ("compartmentIdInSubtree".into(), "true".into()), ("accessLevel".into(), "ACCESSIBLE".into()), ("lifecycleState".into(), "ACTIVE".into())]).await?; let subscriptions = pages(credentials, &host, &format!("/20160918/tenancy/{}/regionSubscriptions", crate::rpc_encode(&credentials.tenancy_ocid)), vec![]).await.unwrap_or_default(); let mut all = vec![json!({"id": credentials.tenancy_ocid, "name": "Root Compartment"})]; for item in compartments { if is_user_compartment(&item) && item.get("id").is_some_and(|id| !all.iter().any(|current| current.get("id") == Some(id))) { all.push(item); } } let mut regions = subscriptions.iter().filter(|item| item.get("status").and_then(Value::as_str).is_some_and(|status| status.eq_ignore_ascii_case("READY"))).filter_map(|item| item.get("regionName").and_then(Value::as_str)).map(str::to_string).collect::<Vec<_>>(); regions.sort(); regions.dedup(); if regions.is_empty() { regions.push(credentials.region.clone()); } Ok((all, regions)) }

fn address_list(values: Vec<String>) -> String { let mut result = Vec::new(); for value in values.into_iter().filter(|value| !value.is_empty()) { if !result.contains(&value) { result.push(value); } } result.join(", ") }
async fn image_name(credentials: &Credentials, host: &str, image_id: &str) -> String { if image_id.is_empty() { return String::new(); } match request(credentials, host, &format!("/20160918/images/{}", crate::rpc_encode(image_id))).await { Ok((image, _)) => image.get("displayName").and_then(Value::as_str).map(str::to_string).or_else(|| { let os = image.get("operatingSystem").and_then(Value::as_str).unwrap_or(""); let version = image.get("operatingSystemVersion").and_then(Value::as_str).unwrap_or(""); let name = format!("{os} {version}").trim().to_string(); if name.is_empty() { None } else { Some(name) } }).unwrap_or_else(|| image_id.to_string()), Err(_) => image_id.to_string() } }
async fn instance(credentials: &Credentials, host: &str, item: &Value, region: &str, compartment: &Value, shape: Option<&Value>) -> Value { let compartment_id = compartment.get("id").and_then(Value::as_str).unwrap_or(""); let instance_id = item.get("id").and_then(Value::as_str).unwrap_or(""); let detail = request(credentials, host, &format!("/20160918/instances/{}", crate::rpc_encode(instance_id))).await.ok().map(|(value, _)| value).unwrap_or_else(|| item.clone()); let mut network_errors = Vec::new(); let attachments = match pages(credentials, host, "/20160918/vnicAttachments", vec![("compartmentId".into(), compartment_id.into()), ("instanceId".into(), instance_id.into())]).await { Ok(values) => values, Err(error) => { network_errors.push(error); vec![] } }; let mut public_ips = Vec::new(); let mut private_ips = Vec::new(); for attachment in attachments { for key in ["publicIp", "publicIpAddress"] { if let Some(ip) = attachment.get(key).and_then(Value::as_str) { public_ips.push(ip.to_string()); } } for key in ["privateIp", "privateIpAddress"] { if let Some(ip) = attachment.get(key).and_then(Value::as_str) { private_ips.push(ip.to_string()); } } let Some(vnic_id) = attachment.get("vnicId").and_then(Value::as_str) else { network_errors.push("VNIC attachment 缺少 vnicId".into()); continue }; match request(credentials, host, &format!("/20160918/vnics/{}", crate::rpc_encode(vnic_id))).await { Ok((vnic, _)) => { for key in ["publicIp", "publicIpAddress"] { if let Some(ip) = vnic.get(key).and_then(Value::as_str) { public_ips.push(ip.to_string()); } } for key in ["privateIp", "privateIpAddress"] { if let Some(ip) = vnic.get(key).and_then(Value::as_str) { private_ips.push(ip.to_string()); } } }, Err(error) => network_errors.push(error) } } let shape_config = detail.get("shapeConfig").or_else(|| item.get("shapeConfig")).unwrap_or(&Value::Null); let ocpus = shape_config.get("ocpus").or_else(|| shape.and_then(|value| value.get("ocpus"))).cloned().unwrap_or(Value::Null); let memory = shape_config.get("memoryInGBs").or_else(|| shape.and_then(|value| value.get("memoryInGBs"))).and_then(Value::as_f64).map(|value| json!(value * 1024.0)).unwrap_or(Value::Null); let image_id = detail.get("imageId").or_else(|| item.get("imageId")).and_then(Value::as_str).unwrap_or(""); json!({"InstanceId": detail.get("id").or_else(|| item.get("id")), "InstanceName": detail.get("displayName").or_else(|| item.get("displayName")).or_else(|| item.get("id")), "InstanceStatus": detail.get("lifecycleState").or_else(|| item.get("lifecycleState")), "Status": detail.get("lifecycleState").or_else(|| item.get("lifecycleState")), "InstanceType": detail.get("shape").or_else(|| item.get("shape")).unwrap_or(&json!("")), "Cpu": ocpus, "Memory": memory, "PublicIpAddress": address_list(public_ips), "PrivateIpAddress": address_list(private_ips), "OSName": image_name(credentials, host, image_id).await, "ImageId": image_id, "CreationTime": detail.get("timeCreated").or_else(|| item.get("timeCreated")).unwrap_or(&json!("")), "_network_error": network_errors.join("；"), "_region_id": region, "_compartment_ocid": compartment.get("id"), "_compartment_name": compartment.get("name"), "_raw": detail}) }
fn db_system(item: &Value, region: &str, compartment: &Value) -> Value { json!({"DBInstanceId": item.get("id"), "DBInstanceDescription": item.get("displayName").or_else(|| item.get("id")), "DBInstanceStatus": item.get("lifecycleState"), "Engine": item.get("databaseEdition").unwrap_or(&json!("Oracle Database")), "EngineVersion": item.get("dbVersion"), "ConnectionString": item.get("hostname"), "_region_id": region, "_compartment_ocid": compartment.get("id"), "_compartment_name": compartment.get("name"), "_raw": item}) }
fn zone(item: &Value, region: &str, compartment: &Value) -> Value { let name = item.get("name").and_then(Value::as_str).unwrap_or("").trim_end_matches('.'); json!({"DomainName": name, "ZoneId": item.get("id").or_else(|| item.get("name")), "DomainStatus": item.get("lifecycleState").unwrap_or(&json!("ACTIVE")), "RecordCount": 0, "_region_id": region, "_compartment_ocid": compartment.get("id"), "_compartment_name": compartment.get("name"), "_raw": item}) }
fn bucket(item: &Value, region: &str, compartment: &Value) -> Value { json!({"Name": item.get("name"), "BucketName": item.get("name"), "Location": region, "StorageClass": item.get("publicAccessType").unwrap_or(&json!("Standard")), "Acl": item.get("publicAccessType").unwrap_or(&json!("NoPublicAccess")), "_region_id": region, "_compartment_ocid": compartment.get("id"), "_compartment_name": compartment.get("name"), "_raw": item}) }

pub(crate) async fn resource_items(id: i64, resource_type: &str) -> ResourceResponse {
    let now = Utc::now().timestamp_millis(); let credentials = match credentials(id) { Ok(v) => v, Err(e) => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![e], fetched_at: now } }; let (compartments, regions) = match context(&credentials).await { Ok(v) => v, Err(e) => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![e], fetched_at: now } }; let mut items = Vec::new(); let mut errors = Vec::new();
    for region in regions { let host = match resource_type { "ecs" => format!("iaas.{region}.oraclecloud.com"), "rds" => format!("database.{region}.oci.oraclecloud.com"), "domain" => format!("dns.{region}.oci.oraclecloud.com"), "oss" => object_storage_host(&region), _ => { errors.push(format!("Oracle Cloud 暂未接入 {resource_type} 资源")); break } }; let namespace = if resource_type == "oss" { match request(&credentials, &host, "/n/").await { Ok((Value::String(value), _)) if !value.is_empty() => Some(value), Ok(_) => { errors.push(format!("{region}: 未能读取 Object Storage namespace")); None }, Err(e) => { errors.push(format!("{region}: {e}")); None } } } else { None }; if resource_type == "oss" && namespace.is_none() { continue; }
        for compartment in &compartments { let compartment_id = compartment.get("id").and_then(Value::as_str).unwrap_or(""); if compartment_id.is_empty() { continue; } let result = match resource_type { "ecs" => pages(&credentials, &host, "/20160918/instances", vec![("compartmentId".into(), compartment_id.into())]).await, "rds" => pages(&credentials, &host, "/20160918/dbSystems", vec![("compartmentId".into(), compartment_id.into())]).await, "domain" => pages(&credentials, &host, "/20180115/zones", vec![("compartmentId".into(), compartment_id.into())]).await, "oss" => pages(&credentials, &host, &format!("/n/{}/b/", crate::rpc_encode(namespace.as_deref().unwrap_or(""))), vec![("compartmentId".into(), compartment_id.into())]).await, _ => unreachable!() };
            match result { Ok(values) if resource_type == "ecs" => { let shapes = pages(&credentials, &host, "/20160928/shapes", vec![("compartmentId".into(), compartment_id.into())]).await.unwrap_or_default(); for item in values { let shape = item.get("shape").and_then(Value::as_str).and_then(|name| shapes.iter().find(|candidate| candidate.get("shape").and_then(Value::as_str) == Some(name))); items.push(instance(&credentials, &host, &item, &region, compartment, shape).await); } }, Ok(values) => for item in values { items.push(match resource_type { "rds" => db_system(&item, &region, compartment), "domain" => zone(&item, &region, compartment), "oss" => bucket(&item, &region, compartment), _ => item }); }, Err(e) => errors.push(format!("{region}/{}: {e}", compartment.get("name").and_then(Value::as_str).unwrap_or(compartment_id))) }
        }
    }
    ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now }
}

pub(crate) async fn instance_action(id: i64, region_id: String, instance_id: String, action: String) -> Result<Value, String> {
    if region_id.trim().is_empty() || instance_id.trim().is_empty() { return Err("缺少 OCI 地域或实例 ID".into()); }
    if !region_id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-') || !instance_id.starts_with("ocid1.instance.") || !instance_id.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-')) { return Err("OCI 地域或实例 ID 格式无效".into()); }
    let action_name = match action.as_str() { "start" => "START", "stop" => "STOP", "reboot" => "SOFTRESET", "forceReboot" => "RESET", _ => return Err("不支持的 OCI 实例操作".into()) };
    let credentials = credentials(id)?; let host = format!("iaas.{region_id}.oraclecloud.com"); let path = format!("/20160918/instances/{}?action={action_name}", crate::rpc_encode(&instance_id)); let private_key = RsaPrivateKey::from_pkcs8_pem(&credentials.private_key).or_else(|_| RsaPrivateKey::from_pkcs1_pem(&credentials.private_key)).map_err(|_| "OCI API 私钥无效，需使用未加密的 RSA PEM 私钥".to_string())?; let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string(); let body = ""; let content_sha256 = B64.encode(Sha256::digest(body.as_bytes())); let canonical = format!("(request-target): post {path}\nhost: {host}\ndate: {date}\ncontent-type: application/json\ncontent-length: {}\nx-content-sha256: {content_sha256}", body.len()); let signature = B64.encode(SigningKey::<Sha256>::new(private_key).sign(canonical.as_bytes()).to_vec()); let key_id = format!("{}/{}/{}", credentials.tenancy_ocid, credentials.user_ocid, credentials.fingerprint); let authorization = format!("Signature version=\"1\",keyId=\"{key_id}\",algorithm=\"rsa-sha256\",headers=\"(request-target) host date content-type content-length x-content-sha256\",signature=\"{signature}\""); let request_params = json!({"action": action_name, "instanceId": instance_id, "regionId": region_id});
    let response = reqwest::Client::new().post(format!("https://{host}{path}")).header("host", &host).header("date", &date).header("content-type", "application/json").header("content-length", body.len()).header("x-content-sha256", &content_sha256).header("authorization", &authorization).body(body).timeout(std::time::Duration::from_secs(30)).send().await;
    let result = match response {
        Ok(response) => {
            let status = response.status();
            let request_id = response.headers().get("opc-request-id").and_then(|v| v.to_str().ok()).map(str::to_string);
            match response.text().await {
                Ok(text) => {
                    let mut safe_text = text;
                    for secret in [&credentials.private_key, &authorization] { if !secret.is_empty() { safe_text = safe_text.replace(secret.as_str(), "[REDACTED]"); } }
                    let data = if safe_text.is_empty() { Value::Null } else { serde_json::from_str::<Value>(&safe_text).unwrap_or(Value::String(safe_text)) };
                    let data = crate::core::repositories::logs::sanitize_json(&data, None);
                    json!({"success": status.is_success(), "httpStatus": status.as_u16(), "requestId": request_id, "response": data})
                },
                Err(_) => json!({"success": false, "httpStatus": status.as_u16(), "requestId": request_id, "message": "OCI 返回读取失败，操作结果未知，请刷新状态核实"}),
            }
        },
        Err(_) => json!({"success": false, "message": "OCI 请求失败或超时，操作结果未知，请刷新状态核实"}),
    };
    let success = result.get("success").and_then(Value::as_bool).unwrap_or(false);
    let message = result.get("message").and_then(Value::as_str);
    crate::write_api_log(&credentials.user_ocid, &host, "POST /20160918/instances", &request_params, Some(&result), if success { "成功" } else { "失败" }, message);
    Ok(result)
}

pub(crate) async fn instance_disks(id: i64, region: &str, instance_id: &str, compartment_id: &str) -> Result<Vec<Value>, String> {
    if region.is_empty() || instance_id.is_empty() || compartment_id.is_empty() { return Ok(vec![]); }
    let credentials = credentials(id)?; let host = format!("iaas.{region}.oraclecloud.com"); let query = vec![("compartmentId".into(), compartment_id.into()), ("instanceId".into(), instance_id.into())]; let boot_attachments = pages(&credentials, &host, "/20160918/bootVolumeAttachments", query.clone()).await.unwrap_or_default(); let volume_attachments = pages(&credentials, &host, "/20160918/volumeAttachments", query).await.unwrap_or_default(); let mut disks = Vec::new();
    for attachment in boot_attachments { let Some(volume_id) = attachment.get("bootVolumeId").and_then(Value::as_str) else { continue }; if let Ok((volume, _)) = request(&credentials, &host, &format!("/20160918/bootVolumes/{}", crate::rpc_encode(volume_id))).await { disks.push(json!({"DiskId": volume_id, "DiskName": volume.get("displayName").or_else(|| attachment.get("displayName")).unwrap_or(&json!(volume_id)), "Category": "启动卷", "Size": volume.get("sizeInGBs").unwrap_or(&json!(0)), "Status": volume.get("lifecycleState").or_else(|| attachment.get("lifecycleState")).unwrap_or(&json!("")), "Device": attachment.get("device").unwrap_or(&json!(""))})); } }
    for attachment in volume_attachments { let Some(volume_id) = attachment.get("volumeId").and_then(Value::as_str) else { continue }; if let Ok((volume, _)) = request(&credentials, &host, &format!("/20160918/volumes/{}", crate::rpc_encode(volume_id))).await { disks.push(json!({"DiskId": volume_id, "DiskName": volume.get("displayName").or_else(|| attachment.get("displayName")).unwrap_or(&json!(volume_id)), "Category": "数据卷", "Size": volume.get("sizeInGBs").unwrap_or(&json!(0)), "Status": volume.get("lifecycleState").or_else(|| attachment.get("lifecycleState")).unwrap_or(&json!("")), "Device": attachment.get("device").unwrap_or(&json!(""))})); } }
    Ok(disks)
}

fn key_id(credentials: &Credentials) -> String { format!("{}/{}/{}", credentials.tenancy_ocid, credentials.user_ocid, credentials.fingerprint) }

fn signing_key(credentials: &Credentials) -> Result<SigningKey<Sha256>, String> {
    let private_key = RsaPrivateKey::from_pkcs8_pem(&credentials.private_key).or_else(|_| RsaPrivateKey::from_pkcs1_pem(&credentials.private_key)).map_err(|_| "OCI API 私钥无效，需使用未加密的 RSA PEM 私钥".to_string())?;
    Ok(SigningKey::<Sha256>::new(private_key))
}

/// 写操作签名请求：GET 只签 host/date，其余方法额外签 content-type、content-length、x-content-sha256。
async fn mutate(credentials: &Credentials, method: &str, host: &str, path: &str, body: &str) -> Result<Value, String> {
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "不支持的 OCI 请求方法".to_string())?;
    let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    let mut canonical = format!("(request-target): {} {path}\nhost: {host}\ndate: {date}", method.as_str().to_ascii_lowercase());
    let mut signed_headers = "(request-target) host date".to_string();
    let mut builder = reqwest::Client::new().request(method.clone(), format!("https://{host}{path}")).header("host", host).header("date", &date);
    if method != reqwest::Method::GET {
        let content_sha256 = B64.encode(Sha256::digest(body.as_bytes()));
        canonical.push_str(&format!("\ncontent-type: application/json\ncontent-length: {}\nx-content-sha256: {content_sha256}", body.len()));
        signed_headers = "(request-target) host date content-type content-length x-content-sha256".to_string();
        builder = builder.header("content-type", "application/json").header("content-length", body.len()).header("x-content-sha256", content_sha256).body(body.to_string());
    }
    let signature = B64.encode(signing_key(credentials)?.sign(canonical.as_bytes()).to_vec());
    let authorization = format!("Signature version=\"1\",keyId=\"{}\",algorithm=\"rsa-sha256\",headers=\"{signed_headers}\",signature=\"{signature}\"", key_id(credentials));
    let response = builder.header("authorization", authorization).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("OCI 请求失败: {error}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|error| format!("OCI 返回读取失败: {error}"))?;
    let data = if text.trim().is_empty() { Value::Null } else { serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text)) };
    let action = format!("{method} {}", path.split('?').next().unwrap_or(path));
    if !status.is_success() {
        let message = data.get("message").or_else(|| data.get("code")).and_then(Value::as_str).unwrap_or("OCI API 返回错误").to_string();
        crate::write_api_log(&credentials.user_ocid, host, &action, &json!({}), Some(&data), "失败", Some(&message));
        return Err(message);
    }
    crate::write_api_log(&credentials.user_ocid, host, &action, &json!({}), Some(&data), "成功", None);
    Ok(data)
}

/// 网络安全组规则的 protocol 是数字：6=TCP、17=UDP、1=ICMP、all=全部。
fn rule_protocol(protocol: &str) -> Option<&'static str> {
    match protocol.trim().to_ascii_lowercase().as_str() { "tcp" => Some("6"), "udp" => Some("17"), "icmp" => Some("1"), "all" => Some("all"), _ => None }
}

fn rule_port_range(protocol: &str, port_range: &str) -> Result<(i64, i64), String> {
    if !matches!(protocol, "tcp" | "udp") { return Ok((-1, -1)); }
    let value = port_range.trim();
    if value.is_empty() || value == "-1/-1" { return Ok((1, 65535)); }
    let (start_text, end_text) = value.split_once('/').ok_or("端口范围格式无效，请使用 80/80 或 8000/9000")?;
    let start = start_text.parse::<i64>().map_err(|_| "端口范围格式无效，请使用 80/80 或 8000/9000".to_string())?;
    let end = end_text.parse::<i64>().map_err(|_| "端口范围格式无效，请使用 80/80 或 8000/9000".to_string())?;
    if start < 1 || end < start || end > 65535 { return Err("端口范围必须在 1 到 65535 之间".into()); }
    Ok((start, end))
}

fn rule_source(source: &str) -> Result<String, String> {
    let value = source.trim();
    let (address, mask) = value.split_once('/').ok_or("来源地址必须是 CIDR，例如 0.0.0.0/0")?;
    let address = address.parse::<std::net::IpAddr>().map_err(|_| "来源地址必须是有效的 CIDR".to_string())?;
    let mask = mask.parse::<u8>().map_err(|_| "来源地址必须是有效的 CIDR".to_string())?;
    if mask > if address.is_ipv4() { 32 } else { 128 } { return Err("来源地址必须是有效的 CIDR".into()); }
    Ok(value.to_string())
}

fn security_rule_body(protocol: &str, port_range: &str, source: &str, description: &str, is_stateless: bool, rule_id: Option<&str>) -> Result<Value, String> {
    let protocol_value = rule_protocol(protocol).ok_or("Oracle Cloud 网络安全组仅支持 TCP、UDP、ICMP 或 ALL 规则")?;
    let source = rule_source(source)?;
    let description = description.trim();
    if description.chars().count() > 255 || description.chars().any(char::is_control) { return Err("规则描述无效，最多 255 个字符".into()); }
    let mut body = json!({"direction": "INGRESS", "protocol": protocol_value, "source": source, "sourceType": "CIDR_BLOCK", "isStateless": is_stateless, "description": description});
    if let Some(rule_id) = rule_id { body["id"] = json!(rule_id); }
    let (start, end) = rule_port_range(protocol, port_range)?;
    if matches!(protocol_value, "6" | "17") {
        body[if protocol_value == "6" { "tcpOptions" } else { "udpOptions" }] = json!({"destinationPortRange": {"min": start, "max": end}});
    }
    Ok(body)
}

fn option_port_range(item: &Value, key: &str) -> String {
    let range = item.get(key).and_then(|value| value.get("destinationPortRange"));
    match (range.and_then(|value| value.get("min")).and_then(Value::as_i64), range.and_then(|value| value.get("max")).and_then(Value::as_i64)) {
        (Some(min), Some(max)) => format!("{min}/{max}"),
        _ => "-1/-1".into(),
    }
}

fn security_rule(item: &Value) -> Value {
    let protocol = match item.get("protocol").and_then(Value::as_str).unwrap_or("") { "6" => "tcp", "17" => "udp", "1" => "icmp", "58" => "icmpv6", _ => "all" };
    let ports = match protocol { "tcp" => option_port_range(item, "tcpOptions"), "udp" => option_port_range(item, "udpOptions"), _ => "-1/-1".into() };
    let source_type = item.get("sourceType").and_then(Value::as_str).unwrap_or("CIDR_BLOCK");
    let source = item.get("source").and_then(Value::as_str).unwrap_or("");
    let cidr = source_type.eq_ignore_ascii_case("CIDR_BLOCK");
    json!({
        "RuleId": item.get("id").cloned().unwrap_or(json!("")),
        "Direction": item.get("direction").and_then(Value::as_str).unwrap_or("INGRESS").to_ascii_lowercase(),
        "IpProtocol": protocol,
        "PortRange": ports,
        "SourceCidrIp": if cidr { source } else { "" },
        "SourceGroupId": if source_type.eq_ignore_ascii_case("NETWORK_SECURITY_GROUP") { source } else { "" },
        "Policy": "accept",
        "Description": item.get("description").cloned().unwrap_or(json!("")),
        "IsStateless": item.get("isStateless").cloned().unwrap_or(json!(false)),
        "ReadOnly": !cidr,
    })
}

pub(crate) async fn list_security_groups(id: i64, region: &str, instance_id: &str, compartment_id: &str, security_group_id: Option<String>) -> Result<Value, String> {
    if region.trim().is_empty() || instance_id.trim().is_empty() || compartment_id.trim().is_empty() { return Err("缺少 OCI 地域、实例 ID 或区间 OCID".into()); }
    let credentials = credentials(id)?;
    let host = format!("iaas.{region}.oraclecloud.com");
    let attachments = pages(&credentials, &host, "/20160918/vnicAttachments", vec![("compartmentId".into(), compartment_id.to_string()), ("instanceId".into(), instance_id.to_string())]).await.unwrap_or_default();
    let mut nsg_ids: Vec<String> = Vec::new();
    let mut subnet_ids: Vec<String> = Vec::new();
    for attachment in &attachments {
        let Some(vnic_id) = attachment.get("vnicId").and_then(Value::as_str) else { continue };
        let Ok((vnic, _)) = request(&credentials, &host, &format!("/20160918/vnics/{}", crate::rpc_encode(vnic_id))).await else { continue };
        for nsg in vnic.get("nsgIds").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) { if !nsg_ids.iter().any(|value| value == nsg) { nsg_ids.push(nsg.to_string()); } }
        if let Some(subnet) = vnic.get("subnetId").and_then(Value::as_str) { if !subnet_ids.iter().any(|value| value == subnet) { subnet_ids.push(subnet.to_string()); } }
    }
    let mut groups = Vec::new();
    for nsg_id in &nsg_ids {
        let (name, vcn) = match request(&credentials, &host, &format!("/20160918/networkSecurityGroups/{}", crate::rpc_encode(nsg_id))).await {
            Ok((group, _)) => (group.get("displayName").and_then(Value::as_str).unwrap_or(nsg_id).to_string(), group.get("vcnId").and_then(Value::as_str).unwrap_or("").to_string()),
            Err(_) => (nsg_id.clone(), String::new()),
        };
        groups.push(json!({"SecurityGroupId": nsg_id, "SecurityGroupName": name, "Description": if vcn.is_empty() { "网络安全组".to_string() } else { format!("网络安全组 · VCN {vcn}") }, "NicType": ""}));
    }
    // 实例没有绑定 NSG 时退回子网安全列表（OCI 默认 VCN 的常见用法），同样支持增删改。
    if groups.is_empty() {
        for subnet_id in &subnet_ids {
            let Ok((subnet, _)) = request(&credentials, &host, &format!("/20160918/subnets/{}", crate::rpc_encode(subnet_id))).await else { continue };
            let subnet_name = subnet.get("displayName").and_then(Value::as_str).unwrap_or(subnet_id).to_string();
            for list_id in subnet.get("securityListIds").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
                groups.push(json!({"SecurityGroupId": format!("sl:{list_id}"), "SecurityGroupName": format!("安全列表 · {subnet_name}"), "Description": "子网安全列表：规则对该子网内所有实例生效，修改前请确认影响范围", "NicType": ""}));
            }
        }
    }
    let selected = security_group_id.filter(|value| groups.iter().any(|group| group.get("SecurityGroupId").and_then(Value::as_str) == Some(value.as_str()))).or_else(|| groups.first().and_then(|group| group.get("SecurityGroupId")).and_then(Value::as_str).map(String::from)).unwrap_or_default();
    let rules = if selected.is_empty() {
        Vec::new()
    } else if let Some(list_id) = selected.strip_prefix("sl:") {
        let (list, _) = request(&credentials, &host, &format!("/20160918/securityLists/{}", crate::rpc_encode(list_id))).await?;
        // 安全列表规则没有 OCID，用「在入方向数组里的下标」当标识；写回时再按内容校验一次。
        crate::array_at(&list, &["ingressSecurityRules"]).into_iter().enumerate().map(|(index, item)| { let mut rule = security_rule(&item); rule["RuleId"] = json!(""); rule["RuleIndex"] = json!(index); rule }).collect()
    } else {
        pages(&credentials, &host, &format!("/20160918/networkSecurityGroups/{}/securityRules", crate::rpc_encode(&selected)), vec![("direction".into(), "INGRESS".into())]).await?.into_iter().enumerate().map(|(index, item)| { let mut rule = security_rule(&item); rule["RuleIndex"] = json!(index); rule }).collect()
    };
    Ok(json!({"groups": groups, "selectedSecurityGroupId": selected, "rules": rules}))
}

fn network_security_group_id(security_group_id: &str) -> Result<String, String> {
    let value = security_group_id.trim();
    if !value.starts_with("ocid1.networksecuritygroup.") { return Err("网络安全组 ID 格式无效".into()); }
    if !value.bytes().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'.' | b'_' | b'-')) { return Err("网络安全组 ID 格式无效".into()); }
    Ok(value.to_string())
}

fn security_list_id(security_list: &str) -> Result<String, String> {
    let value = security_list.trim();
    if !value.starts_with("ocid1.securitylist.") { return Err("安全列表 ID 格式无效".into()); }
    if !value.bytes().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'.' | b'_' | b'-')) { return Err("安全列表 ID 格式无效".into()); }
    Ok(value.to_string())
}

/// 安全列表的规则按 ingressSecurityRules 数组下标存放，写入前把界面字段和云端条目都归一化再比对。
fn rule_signature(protocol: &str, ports: &str, source: &str, description: &str) -> (String, String, String, String) {
    let protocol = protocol.trim().to_ascii_lowercase();
    let ports = match ports.trim() { "" => "-1/-1".to_string(), value if value == "-1/-1" => "-1/-1".to_string(), value => value.to_string() };
    (protocol, ports, source.trim().to_string(), description.trim().to_string())
}

fn entry_signature(item: &Value) -> (String, String, String, String) {
    let mapped = security_rule(item);
    rule_signature(mapped.get("IpProtocol").and_then(Value::as_str).unwrap_or(""), mapped.get("PortRange").and_then(Value::as_str).unwrap_or(""), mapped.get("SourceCidrIp").and_then(Value::as_str).unwrap_or(""), mapped.get("Description").and_then(Value::as_str).unwrap_or(""))
}

/// 安全列表条目没有 direction/id 字段，写回前要清掉。
fn security_list_entry(rule: Value) -> Value {
    match rule { Value::Object(mut object) => { object.remove("direction"); object.remove("id"); Value::Object(object) }, other => other }
}

fn find_security_list_index(ingress: &[Value], index: Option<usize>, original: Option<&Value>) -> Result<usize, String> {
    let original = original.ok_or("缺少原安全列表规则内容，请刷新后重试")?;
    let signature = rule_signature(
        original.get("protocol").and_then(Value::as_str).unwrap_or(""),
        original.get("ports").and_then(Value::as_str).unwrap_or(""),
        original.get("source").and_then(Value::as_str).unwrap_or(""),
        original.get("description").and_then(Value::as_str).unwrap_or(""),
    );
    if let Some(position) = index.filter(|position| ingress.get(*position).is_some_and(|item| entry_signature(item) == signature)) { return Ok(position); }
    // 下标对不上（列表被别处改过或刚删过一条）时按内容重新定位，避免改错规则。
    ingress.iter().position(|item| entry_signature(item) == signature).ok_or_else(|| "安全列表规则已被修改，请刷新后重试".to_string())
}

async fn security_list_rules(credentials: &Credentials, host: &str, list_id: &str) -> Result<(Vec<Value>, Vec<Value>), String> {
    let (list, _) = request(credentials, host, &format!("/20160918/securityLists/{}", crate::rpc_encode(list_id))).await?;
    Ok((crate::array_at(&list, &["ingressSecurityRules"]).into_iter().cloned().collect(), crate::array_at(&list, &["egressSecurityRules"]).into_iter().cloned().collect()))
}

async fn write_security_list_rules(credentials: &Credentials, host: &str, list_id: &str, ingress: Vec<Value>, egress: Vec<Value>) -> Result<(), String> {
    // 出方向规则原样回传，避免整表替换时把出方向清空。
    let body = json!({"ingressSecurityRules": ingress, "egressSecurityRules": egress});
    mutate(credentials, "PUT", host, &format!("/20160918/securityLists/{}", crate::rpc_encode(list_id)), &body.to_string()).await.map(|_| ())
}

async fn authorize_security_list_rule(id: i64, region: &str, list_id: &str, ip_protocol: &str, port_range: &str, source_cidr_ip: &str, description: Option<String>) -> Result<String, String> {
    let list_id = security_list_id(list_id)?;
    let rule = security_list_entry(security_rule_body(ip_protocol, port_range, source_cidr_ip, description.as_deref().unwrap_or(""), false, None)?);
    let credentials = credentials(id)?;
    let host = format!("iaas.{region}.oraclecloud.com");
    let (mut ingress, egress) = security_list_rules(&credentials, &host, &list_id).await?;
    ingress.push(rule);
    write_security_list_rules(&credentials, &host, &list_id, ingress, egress).await?;
    Ok(String::new())
}

async fn modify_security_list_rule(id: i64, region: &str, list_id: &str, rule_index: Option<usize>, original: Option<&Value>, ip_protocol: &str, port_range: &str, source_cidr_ip: &str, description: Option<String>, is_stateless: bool) -> Result<String, String> {
    let list_id = security_list_id(list_id)?;
    let rule = security_list_entry(security_rule_body(ip_protocol, port_range, source_cidr_ip, description.as_deref().unwrap_or(""), is_stateless, None)?);
    let credentials = credentials(id)?;
    let host = format!("iaas.{region}.oraclecloud.com");
    let (mut ingress, egress) = security_list_rules(&credentials, &host, &list_id).await?;
    let position = find_security_list_index(&ingress, rule_index, original)?;
    ingress[position] = rule;
    write_security_list_rules(&credentials, &host, &list_id, ingress, egress).await?;
    Ok(String::new())
}

async fn revoke_security_list_rule(id: i64, region: &str, list_id: &str, rule_index: Option<usize>, original: Option<&Value>) -> Result<String, String> {
    let list_id = security_list_id(list_id)?;
    let credentials = credentials(id)?;
    let host = format!("iaas.{region}.oraclecloud.com");
    let (mut ingress, egress) = security_list_rules(&credentials, &host, &list_id).await?;
    let position = find_security_list_index(&ingress, rule_index, original)?;
    ingress.remove(position);
    write_security_list_rules(&credentials, &host, &list_id, ingress, egress).await?;
    Ok(String::new())
}

pub(crate) async fn authorize_security_group_rule(id: i64, region: &str, security_group_id: &str, ip_protocol: &str, port_range: &str, source_cidr_ip: &str, description: Option<String>) -> Result<String, String> {
    if region.trim().is_empty() { return Err("缺少 OCI 地域".into()); }
    if let Some(list_id) = security_group_id.trim().strip_prefix("sl:") { return authorize_security_list_rule(id, region, list_id, ip_protocol, port_range, source_cidr_ip, description).await; }
    let security_group_id = network_security_group_id(security_group_id)?;
    let rule = security_rule_body(ip_protocol, port_range, source_cidr_ip, description.as_deref().unwrap_or(""), false, None)?;
    let credentials = credentials(id)?;
    let host = format!("iaas.{region}.oraclecloud.com");
    let data = mutate(&credentials, "POST", &host, &format!("/20160918/networkSecurityGroups/{}/actions/addSecurityRules", crate::rpc_encode(&security_group_id)), &json!({"securityRules": [rule]}).to_string()).await?;
    Ok(data.get("securityRules").and_then(Value::as_array).and_then(|rules| rules.first()).and_then(|rule| rule.get("id")).and_then(Value::as_str).unwrap_or_default().to_string())
}

pub(crate) async fn modify_security_group_rule(id: i64, region: &str, security_group_id: &str, rule_id: &str, ip_protocol: &str, port_range: &str, source_cidr_ip: &str, description: Option<String>, is_stateless: bool, rule_index: Option<usize>, original: Option<Value>) -> Result<String, String> {
    if region.trim().is_empty() { return Err("缺少 OCI 地域".into()); }
    if let Some(list_id) = security_group_id.trim().strip_prefix("sl:") { return modify_security_list_rule(id, region, list_id, rule_index, original.as_ref(), ip_protocol, port_range, source_cidr_ip, description, is_stateless).await; }
    let security_group_id = network_security_group_id(security_group_id)?;
    if !rule_id.starts_with("ocid1.securityrule.") { return Err("网络安全组规则 ID 无效".into()); }
    let rule = security_rule_body(ip_protocol, port_range, source_cidr_ip, description.as_deref().unwrap_or(""), is_stateless, Some(rule_id))?;
    let credentials = credentials(id)?;
    let host = format!("iaas.{region}.oraclecloud.com");
    mutate(&credentials, "POST", &host, &format!("/20160918/networkSecurityGroups/{}/actions/updateSecurityRules", crate::rpc_encode(&security_group_id)), &json!({"securityRules": [rule]}).to_string()).await?;
    Ok(rule_id.to_string())
}

pub(crate) async fn revoke_security_group_rule(id: i64, region: &str, security_group_id: &str, rule_id: &str, rule_index: Option<usize>, original: Option<Value>) -> Result<String, String> {
    if region.trim().is_empty() { return Err("缺少 OCI 地域".into()); }
    if let Some(list_id) = security_group_id.trim().strip_prefix("sl:") { return revoke_security_list_rule(id, region, list_id, rule_index, original.as_ref()).await; }
    let security_group_id = network_security_group_id(security_group_id)?;
    if !rule_id.starts_with("ocid1.securityrule.") { return Err("网络安全组规则 ID 无效".into()); }
    let credentials = credentials(id)?;
    let host = format!("iaas.{region}.oraclecloud.com");
    mutate(&credentials, "POST", &host, &format!("/20160918/networkSecurityGroups/{}/actions/removeSecurityRules", crate::rpc_encode(&security_group_id)), &json!({"securityRuleIds": [rule_id]}).to_string()).await?;
    Ok(rule_id.to_string())
}

#[cfg(test)]
mod security_rule_tests {
    use super::{find_security_list_index, rule_port_range, rule_protocol, rule_source, security_list_entry, security_rule, security_rule_body};
    use serde_json::json;

    #[test]
    fn maps_protocols_and_ports_to_oracle_shape() {
        assert_eq!(rule_protocol("tcp"), Some("6"));
        assert_eq!(rule_protocol("UDP"), Some("17"));
        assert_eq!(rule_protocol("icmp"), Some("1"));
        assert_eq!(rule_protocol("all"), Some("all"));
        assert_eq!(rule_protocol("gre"), None);
        assert_eq!(rule_port_range("tcp", "8080/8080").unwrap(), (8080, 8080));
        assert_eq!(rule_port_range("udp", "2000/3000").unwrap(), (2000, 3000));
        assert_eq!(rule_port_range("tcp", "-1/-1").unwrap(), (1, 65535));
        assert!(rule_port_range("tcp", "3000/2000").is_err());
        assert!(rule_port_range("icmp", "-1/-1").unwrap().0 < 0);
    }

    #[test]
    fn builds_ingress_rule_bodies() {
        let body = security_rule_body("tcp", "80/80", "0.0.0.0/0", "web", false, None).unwrap();
        assert_eq!(body["protocol"], json!("6"));
        assert_eq!(body["sourceType"], json!("CIDR_BLOCK"));
        assert_eq!(body["tcpOptions"]["destinationPortRange"]["min"], json!(80));
        assert!(body.get("udpOptions").is_none());
        let icmp = security_rule_body("icmp", "-1/-1", "0.0.0.0/0", "", false, None).unwrap();
        assert_eq!(icmp["protocol"], json!("1"));
        assert!(icmp.get("tcpOptions").is_none());
        let updated = security_rule_body("udp", "53/53", "::/0", "", true, Some("ocid1.securityrule.example")).unwrap();
        assert_eq!(updated["id"], json!("ocid1.securityrule.example"));
        assert_eq!(updated["isStateless"], json!(true));
        assert_eq!(updated["udpOptions"]["destinationPortRange"]["max"], json!(53));
        assert!(security_rule_body("gre", "80/80", "0.0.0.0/0", "", false, None).is_err());
        assert!(security_rule_body("tcp", "80/80", "0.0.0.0", "", false, None).is_err());
        assert!(rule_source("192.0.2.0/33").is_err());
    }

    #[test]
    fn maps_oracle_rules_back_to_the_shared_shape() {
        let rule = security_rule(&json!({"id": "ocid1.securityrule.example", "direction": "INGRESS", "protocol": "6", "source": "192.0.2.0/24", "sourceType": "CIDR_BLOCK", "isStateless": false, "description": "SSH", "tcpOptions": {"destinationPortRange": {"min": 22, "max": 22}}}));
        assert_eq!(rule["IpProtocol"], json!("tcp"));
        assert_eq!(rule["PortRange"], json!("22/22"));
        assert_eq!(rule["SourceCidrIp"], json!("192.0.2.0/24"));
        assert_eq!(rule["ReadOnly"], json!(false));
        let group = security_rule(&json!({"id": "ocid1.securityrule.two", "protocol": "all", "source": "ocid1.networksecuritygroup.example", "sourceType": "NETWORK_SECURITY_GROUP"}));
        assert_eq!(group["IpProtocol"], json!("all"));
        assert_eq!(group["PortRange"], json!("-1/-1"));
        assert_eq!(group["SourceGroupId"], json!("ocid1.networksecuritygroup.example"));
        assert_eq!(group["ReadOnly"], json!(true));
    }

    #[test]
    fn locates_security_list_entries_by_content() {
        let ingress = vec![
            json!({"protocol": "all", "source": "0.0.0.0/0", "sourceType": "CIDR_BLOCK"}),
            json!({"protocol": "6", "source": "192.0.2.0/24", "sourceType": "CIDR_BLOCK", "tcpOptions": {"destinationPortRange": {"min": 22, "max": 22}}, "description": "SSH"}),
        ];
        let original = json!({"protocol": "tcp", "ports": "22/22", "source": "192.0.2.0/24", "description": "SSH"});
        assert_eq!(find_security_list_index(&ingress, Some(1), Some(&original)).unwrap(), 1);
        // 列表被别处改过、下标漂移时按内容重新定位，避免改错规则。
        assert_eq!(find_security_list_index(&ingress, Some(0), Some(&original)).unwrap(), 1);
        assert_eq!(find_security_list_index(&ingress, None, Some(&original)).unwrap(), 1);
        assert!(find_security_list_index(&ingress, Some(0), Some(&json!({"protocol": "tcp", "ports": "80/80", "source": "0.0.0.0/0"}))).is_err());
        assert!(find_security_list_index(&ingress, Some(0), None).is_err());
    }

    #[test]
    fn strips_direction_when_writing_security_list_entries() {
        // 安全列表条目没有 direction/id，写回整表时带上会被 OCI 拒绝。
        let entry = security_list_entry(security_rule_body("tcp", "80/80", "0.0.0.0/0", "web", false, None).unwrap());
        assert!(entry.get("direction").is_none());
        assert_eq!(entry["protocol"], json!("6"));
        assert_eq!(entry["tcpOptions"]["destinationPortRange"]["max"], json!(80));
    }
}
