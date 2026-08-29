use crate::{decrypt_secret, open_db, rpc_encode, write_api_log, ResourceResponse};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chrono::Utc;
use rsa::{pkcs1::DecodeRsaPrivateKey, pkcs8::DecodePrivateKey, pkcs1v15::SigningKey, RsaPrivateKey};
use rsa::signature::{SignatureEncoding, Signer};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[derive(Clone)]
struct OracleCredentials {
    user_ocid: String,
    tenancy_ocid: String,
    fingerprint: String,
    private_key: String,
    region: String,
}

fn oracle_credentials(id: i64) -> Result<OracleCredentials, String> {
    let conn = open_db()?;
    let row: (String, String, Option<String>, Option<String>, i64, String) = conn.query_row(
        "SELECT access_key_id,secret_ciphertext,credential_meta,region_id,enabled,cloud_type FROM cloud_accounts WHERE id=?1",
        [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
    ).map_err(|e| format!("读取 OCI 账号失败: {e}"))?;
    if row.4 != 1 { return Err("云账号已停用".into()); }
    if row.5 != "oracle" { return Err("当前账号不是 Oracle Cloud 账号".into()); }
    let meta: Value = serde_json::from_str(row.2.as_deref().unwrap_or("{}")).map_err(|_| "OCI 账号元数据格式无效".to_string())?;
    let tenancy_ocid = meta.get("tenancy_ocid").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let fingerprint = meta.get("key_fingerprint").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if tenancy_ocid.is_empty() || fingerprint.is_empty() { return Err("OCI 账号缺少 Tenancy OCID 或 Key Fingerprint".into()); }
    Ok(OracleCredentials {
        user_ocid: row.0,
        tenancy_ocid,
        fingerprint,
        private_key: normalize_oci_private_key(&decrypt_secret(&row.1)?),
        region: row.3.filter(|value| !value.trim().is_empty()).unwrap_or_else(|| "ap-tokyo-1".into()),
    })
}

fn normalize_oci_private_key(value: &str) -> String {
    let mut key = value.trim().to_string();
    if key.to_ascii_uppercase().starts_with("OCI_API_KEY") {
        if let Some((name, rest)) = key.split_once('=') {
            if name.trim().eq_ignore_ascii_case("OCI_API_KEY") { key = rest.trim().to_string(); }
        }
    }
    if key.len() >= 2 && ((key.starts_with('"') && key.ends_with('"')) || (key.starts_with('\'') && key.ends_with('\''))) {
        key = key[1..key.len() - 1].to_string();
    }
    key = key.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\r", "\n").replace("\r\n", "\n").replace('\r', "\n");
    key = key.lines().map(|line| {
        let trimmed = line.trim_start();
        if (trimmed.starts_with("\\-----BEGIN ") || trimmed.starts_with("\\-----END ")) && (trimmed.contains("PRIVATE KEY-----")) {
            &trimmed[1..]
        } else { line }
    }).collect::<Vec<_>>().join("\n");

    for kind in ["PRIVATE KEY", "RSA PRIVATE KEY"] {
        let begin = format!("-----BEGIN {kind}-----");
        let end = format!("-----END {kind}-----");
        let Some(start) = key.find(&begin) else { continue };
        let body_start = start + begin.len();
        let Some(end_offset) = key[body_start..].find(&end) else { continue };
        let body = key[body_start..body_start + end_offset].chars().filter(|character| !character.is_whitespace()).collect::<String>();
        if body.is_empty() || !body.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/' || byte == b'=') { return key; }
        let lines = body.as_bytes().chunks(64).map(|chunk| std::str::from_utf8(chunk).expect("OCI PEM body is ASCII")).collect::<Vec<_>>().join("\n");
        return format!("{begin}\n{lines}\n{end}");
    }
    key
}

pub(crate) fn serialize_oci_private_key(value: &str) -> String {
    normalize_oci_private_key(value).replace('\n', "\\n")
}

#[cfg(test)]
mod oci_private_key_tests {
    use super::{normalize_oci_private_key, serialize_oci_private_key};

    #[test]
    fn serializes_and_restores_a_pem_key() {
        let input = "OCI_API_KEY=\"\\-----BEGIN PRIVATE KEY-----\\nQUJDRA==\\n\\-----END PRIVATE KEY-----\"";
        let expected = "-----BEGIN PRIVATE KEY-----\nQUJDRA==\n-----END PRIVATE KEY-----";
        assert_eq!(serialize_oci_private_key(input), "-----BEGIN PRIVATE KEY-----\\nQUJDRA==\\n-----END PRIVATE KEY-----");
        assert_eq!(normalize_oci_private_key(&serialize_oci_private_key(input)), expected);
    }
}

fn oracle_query(params: &[(String, String)]) -> String {
    params.iter().map(|(key, value)| format!("{}={}", rpc_encode(key), rpc_encode(value))).collect::<Vec<_>>().join("&")
}

fn oracle_object_storage_host(region: &str) -> String {
    format!("objectstorage.{region}.oci.customer-oci.com")
}

fn oracle_is_user_compartment(compartment: &Value) -> bool {
    !compartment.get("name").and_then(Value::as_str).is_some_and(|name| name.eq_ignore_ascii_case("ManagedCompartmentForPaaS"))
}

#[cfg(test)]
mod oracle_resource_tests {
    use super::{oracle_is_user_compartment, oracle_object_storage_host};
    use serde_json::json;

    #[test]
    fn uses_the_tls_validated_object_storage_endpoint() {
        assert_eq!(oracle_object_storage_host("me-dubai-1"), "objectstorage.me-dubai-1.oci.customer-oci.com");
    }

    #[test]
    fn excludes_the_oracle_managed_paas_compartment_only() {
        assert!(!oracle_is_user_compartment(&json!({"name": "ManagedCompartmentForPaaS"})));
        assert!(oracle_is_user_compartment(&json!({"name": "业务资源组"})));
    }
}

async fn oracle_request(credentials: &OracleCredentials, host: &str, path: &str) -> Result<(Value, Option<String>), String> {
    let private_key = RsaPrivateKey::from_pkcs8_pem(&credentials.private_key)
        .or_else(|_| RsaPrivateKey::from_pkcs1_pem(&credentials.private_key))
        .map_err(|_| "OCI API 私钥无效，需使用未加密的 RSA PEM 私钥".to_string())?;
    let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    let canonical = format!("(request-target): get {path}\nhost: {host}\ndate: {date}");
    let signer = SigningKey::<Sha256>::new(private_key);
    let signature = B64.encode(signer.sign(canonical.as_bytes()).to_vec());
    let key_id = format!("{}/{}/{}", credentials.tenancy_ocid, credentials.user_ocid, credentials.fingerprint);
    let authorization = format!("Signature version=\"1\",keyId=\"{key_id}\",algorithm=\"rsa-sha256\",headers=\"(request-target) host date\",signature=\"{signature}\"");
    let response = reqwest::Client::new().get(format!("https://{host}{path}"))
        .header("host", host).header("date", &date).header("authorization", authorization)
        .timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("OCI 请求失败: {error}"))?;
    let status = response.status();
    let next_page = response.headers().get("opc-next-page").and_then(|value| value.to_str().ok()).map(str::to_string);
    let text = response.text().await.map_err(|error| format!("OCI 返回读取失败: {error}"))?;
    let data = serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text));
    if !status.is_success() {
        let message = data.get("message").or_else(|| data.get("code")).and_then(Value::as_str).unwrap_or("OCI API 返回错误").to_string();
        write_api_log(&credentials.user_ocid, host, &format!("GET {}", path.split('?').next().unwrap_or(path)), &json!({}), Some(&data), "失败", Some(&message));
        return Err(message);
    }
    write_api_log(&credentials.user_ocid, host, &format!("GET {}", path.split('?').next().unwrap_or(path)), &json!({}), Some(&data), "成功", None);
    Ok((data, next_page))
}

async fn oracle_pages(credentials: &OracleCredentials, host: &str, base_path: &str, query: Vec<(String, String)>) -> Result<Vec<Value>, String> {
    let mut values = Vec::new(); let mut page: Option<String> = None;
    for _ in 0..100 {
        let mut params = query.clone();
        if let Some(token) = page { params.push(("page".into(), token)); }
        let query_string = oracle_query(&params);
        let path = if query_string.is_empty() { base_path.to_string() } else { format!("{base_path}?{query_string}") };
        let (data, next) = oracle_request(credentials, host, &path).await?;
        if let Some(array) = data.as_array() { values.extend(array.iter().cloned()); }
        if next.is_none() { return Ok(values); }
        page = next;
    }
    Err("OCI 分页超过 100 页，已停止读取".into())
}

async fn oracle_context(credentials: &OracleCredentials) -> Result<(Vec<Value>, Vec<String>), String> {
    let host = format!("identity.{}.oci.oraclecloud.com", credentials.region);
    let compartments = oracle_pages(credentials, &host, "/20160918/compartments", vec![
        ("compartmentId".into(), credentials.tenancy_ocid.clone()), ("compartmentIdInSubtree".into(), "true".into()),
        ("accessLevel".into(), "ACCESSIBLE".into()), ("lifecycleState".into(), "ACTIVE".into()),
    ]).await?;
    // OCI can separately deny region subscription discovery even when the caller
    // can inspect resources. Keep using the configured region instead of failing
    // every resource type.
    let subscriptions = oracle_pages(credentials, &host, &format!("/20160918/tenancy/{}/regionSubscriptions", rpc_encode(&credentials.tenancy_ocid)), vec![]).await.unwrap_or_default();
    let mut all_compartments = vec![json!({"id": credentials.tenancy_ocid, "name": "Root Compartment"})];
    for item in compartments {
        if oracle_is_user_compartment(&item) && item.get("id").is_some_and(|id| !all_compartments.iter().any(|current| current.get("id") == Some(id))) {
            all_compartments.push(item);
        }
    }
    let mut regions = subscriptions.iter().filter(|item| item.get("status").and_then(Value::as_str).is_some_and(|status| status.eq_ignore_ascii_case("READY"))).filter_map(|item| item.get("regionName").and_then(Value::as_str)).map(str::to_string).collect::<Vec<_>>();
    regions.sort(); regions.dedup();
    if regions.is_empty() { regions.push(credentials.region.clone()); }
    Ok((all_compartments, regions))
}

fn oracle_address_list(values: Vec<String>) -> String {
    let mut result = Vec::new();
    for value in values.into_iter().filter(|value| !value.is_empty()) { if !result.contains(&value) { result.push(value); } }
    result.join(", ")
}

async fn oracle_image_name(credentials: &OracleCredentials, host: &str, image_id: &str) -> String {
    if image_id.is_empty() { return String::new(); }
    match oracle_request(credentials, host, &format!("/20160918/images/{}", rpc_encode(image_id))).await {
        Ok((image, _)) => image.get("displayName").and_then(Value::as_str).map(str::to_string).or_else(|| {
            let os = image.get("operatingSystem").and_then(Value::as_str).unwrap_or("");
            let version = image.get("operatingSystemVersion").and_then(Value::as_str).unwrap_or("");
            let name = format!("{os} {version}").trim().to_string(); if name.is_empty() { None } else { Some(name) }
        }).unwrap_or_else(|| image_id.to_string()),
        Err(_) => image_id.to_string(),
    }
}

#[tauri::command]
pub(crate) async fn oracle_instance_action(id: i64, region_id: String, instance_id: String, action: String) -> Result<String, String> {
    if region_id.trim().is_empty() || instance_id.trim().is_empty() { return Err("缺少 OCI 地域或实例 ID".into()); }
    let action_name = match action.as_str() {
        "start" => "START",
        "stop" => "STOP",
        "reboot" => "SOFTRESET",
        "forceReboot" => "RESET",
        _ => return Err("不支持的 OCI 实例操作".into()),
    };
    let credentials = oracle_credentials(id)?;
    let host = format!("iaas.{region_id}.oraclecloud.com");
    let path = format!("/20160918/instances/{}?action={action_name}", rpc_encode(&instance_id));
    let private_key = RsaPrivateKey::from_pkcs8_pem(&credentials.private_key)
        .or_else(|_| RsaPrivateKey::from_pkcs1_pem(&credentials.private_key))
        .map_err(|_| "OCI API 私钥无效，需使用未加密的 RSA PEM 私钥".to_string())?;
    let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    let body = "";
    let content_sha256 = B64.encode(Sha256::digest(body.as_bytes()));
    let canonical = format!("(request-target): post {path}\nhost: {host}\ndate: {date}\ncontent-type: application/json\ncontent-length: {}\nx-content-sha256: {content_sha256}", body.len());
    let signature = B64.encode(SigningKey::<Sha256>::new(private_key).sign(canonical.as_bytes()).to_vec());
    let key_id = format!("{}/{}/{}", credentials.tenancy_ocid, credentials.user_ocid, credentials.fingerprint);
    let authorization = format!("Signature version=\"1\",keyId=\"{key_id}\",algorithm=\"rsa-sha256\",headers=\"(request-target) host date content-type content-length x-content-sha256\",signature=\"{signature}\"");
    let response = reqwest::Client::new().post(format!("https://{host}{path}"))
        .header("host", &host).header("date", &date).header("content-type", "application/json")
        .header("content-length", body.len()).header("x-content-sha256", &content_sha256)
        .header("authorization", authorization).body(body).timeout(std::time::Duration::from_secs(30)).send().await
        .map_err(|error| format!("OCI 请求失败: {error}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|error| format!("OCI 返回读取失败: {error}"))?;
    let data = serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text));
    if !status.is_success() {
        let message = data.get("message").or_else(|| data.get("code")).and_then(Value::as_str).unwrap_or("OCI API 返回错误").to_string();
        write_api_log(&credentials.user_ocid, &host, "POST /20160918/instances", &json!({"action": action_name}), Some(&data), "失败", Some(&message));
        return Err(message);
    }
    write_api_log(&credentials.user_ocid, &host, "POST /20160918/instances", &json!({"action": action_name}), Some(&data), "成功", None);
    Ok(String::new())
}

async fn oracle_instance(credentials: &OracleCredentials, host: &str, item: &Value, region: &str, compartment: &Value, shape: Option<&Value>) -> Value {
    let compartment_id = compartment.get("id").and_then(Value::as_str).unwrap_or("");
    let instance_id = item.get("id").and_then(Value::as_str).unwrap_or("");
    let detail = oracle_request(credentials, host, &format!("/20160918/instances/{}", rpc_encode(instance_id))).await.ok().map(|(value, _)| value).unwrap_or_else(|| item.clone());
    let mut network_errors = Vec::new();
    let attachments = match oracle_pages(credentials, host, "/20160918/vnicAttachments", vec![("compartmentId".into(), compartment_id.into()), ("instanceId".into(), instance_id.into())]).await {
        Ok(values) => values,
        Err(error) => { network_errors.push(error); vec![] }
    };
    let mut public_ips = Vec::new(); let mut private_ips = Vec::new();
    for attachment in attachments {
        for key in ["publicIp", "publicIpAddress"] { if let Some(ip) = attachment.get(key).and_then(Value::as_str) { public_ips.push(ip.to_string()); } }
        for key in ["privateIp", "privateIpAddress"] { if let Some(ip) = attachment.get(key).and_then(Value::as_str) { private_ips.push(ip.to_string()); } }
        let Some(vnic_id) = attachment.get("vnicId").and_then(Value::as_str) else { network_errors.push("VNIC attachment 缺少 vnicId".into()); continue };
        match oracle_request(credentials, host, &format!("/20160918/vnics/{}", rpc_encode(vnic_id))).await {
            Ok((vnic, _)) => {
                for key in ["publicIp", "publicIpAddress"] { if let Some(ip) = vnic.get(key).and_then(Value::as_str) { public_ips.push(ip.to_string()); } }
                for key in ["privateIp", "privateIpAddress"] { if let Some(ip) = vnic.get(key).and_then(Value::as_str) { private_ips.push(ip.to_string()); } }
            }
            Err(error) => network_errors.push(error),
        }
    }
    let shape_config = detail.get("shapeConfig").or_else(|| item.get("shapeConfig")).unwrap_or(&Value::Null);
    let ocpus = shape_config.get("ocpus").or_else(|| shape.and_then(|value| value.get("ocpus"))).cloned().unwrap_or(Value::Null);
    let memory = shape_config.get("memoryInGBs").or_else(|| shape.and_then(|value| value.get("memoryInGBs"))).and_then(Value::as_f64).map(|value| json!(value * 1024.0)).unwrap_or(Value::Null);
    let image_id = detail.get("imageId").or_else(|| item.get("imageId")).and_then(Value::as_str).unwrap_or("");
    json!({"InstanceId": detail.get("id").or_else(|| item.get("id")), "InstanceName": detail.get("displayName").or_else(|| item.get("displayName")).or_else(|| item.get("id")), "InstanceStatus": detail.get("lifecycleState").or_else(|| item.get("lifecycleState")), "Status": detail.get("lifecycleState").or_else(|| item.get("lifecycleState")), "InstanceType": detail.get("shape").or_else(|| item.get("shape")).unwrap_or(&json!("")), "Cpu": ocpus, "Memory": memory, "PublicIpAddress": oracle_address_list(public_ips), "PrivateIpAddress": oracle_address_list(private_ips), "OSName": oracle_image_name(credentials, host, image_id).await, "ImageId": image_id, "CreationTime": detail.get("timeCreated").or_else(|| item.get("timeCreated")).unwrap_or(&json!("")), "_network_error": network_errors.join("；"), "_region_id": region, "_compartment_ocid": compartment.get("id"), "_compartment_name": compartment.get("name"), "_raw": detail})
}
fn oracle_db_system(item: &Value, region: &str, compartment: &Value) -> Value {
    json!({"DBInstanceId": item.get("id"), "DBInstanceDescription": item.get("displayName").or_else(|| item.get("id")), "DBInstanceStatus": item.get("lifecycleState"), "Engine": item.get("databaseEdition").unwrap_or(&json!("Oracle Database")), "EngineVersion": item.get("dbVersion"), "ConnectionString": item.get("hostname"), "_region_id": region, "_compartment_ocid": compartment.get("id"), "_compartment_name": compartment.get("name"), "_raw": item})
}
fn oracle_zone(item: &Value, region: &str, compartment: &Value) -> Value {
    let name = item.get("name").and_then(Value::as_str).unwrap_or("").trim_end_matches('.');
    json!({"DomainName": name, "ZoneId": item.get("id").or_else(|| item.get("name")), "DomainStatus": item.get("lifecycleState").unwrap_or(&json!("ACTIVE")), "RecordCount": 0, "_region_id": region, "_compartment_ocid": compartment.get("id"), "_compartment_name": compartment.get("name"), "_raw": item})
}
fn oracle_bucket(item: &Value, region: &str, compartment: &Value) -> Value {
    json!({"Name": item.get("name"), "BucketName": item.get("name"), "Location": region, "StorageClass": item.get("publicAccessType").unwrap_or(&json!("Standard")), "Acl": item.get("publicAccessType").unwrap_or(&json!("NoPublicAccess")), "_region_id": region, "_compartment_ocid": compartment.get("id"), "_compartment_name": compartment.get("name"), "_raw": item})
}

pub(crate) async fn oracle_instance_disks(id: i64, region: &str, instance_id: &str, compartment_id: &str) -> Result<Vec<Value>, String> {
    if region.is_empty() || instance_id.is_empty() || compartment_id.is_empty() { return Ok(vec![]); }
    let credentials = oracle_credentials(id)?;
    let host = format!("iaas.{region}.oraclecloud.com");
    let query = vec![("compartmentId".into(), compartment_id.into()), ("instanceId".into(), instance_id.into())];
    let boot_attachments = oracle_pages(&credentials, &host, "/20160918/bootVolumeAttachments", query.clone()).await.unwrap_or_default();
    let volume_attachments = oracle_pages(&credentials, &host, "/20160918/volumeAttachments", query).await.unwrap_or_default();
    let mut disks = Vec::new();
    for attachment in boot_attachments {
        let Some(volume_id) = attachment.get("bootVolumeId").and_then(Value::as_str) else { continue };
        if let Ok((volume, _)) = oracle_request(&credentials, &host, &format!("/20160918/bootVolumes/{}", rpc_encode(volume_id))).await {
            disks.push(json!({"DiskId": volume_id, "DiskName": volume.get("displayName").or_else(|| attachment.get("displayName")).unwrap_or(&json!(volume_id)), "Category": "启动卷", "Size": volume.get("sizeInGBs").unwrap_or(&json!(0)), "Status": volume.get("lifecycleState").or_else(|| attachment.get("lifecycleState")).unwrap_or(&json!("")), "Device": attachment.get("device").unwrap_or(&json!(""))}));
        }
    }
    for attachment in volume_attachments {
        let Some(volume_id) = attachment.get("volumeId").and_then(Value::as_str) else { continue };
        if let Ok((volume, _)) = oracle_request(&credentials, &host, &format!("/20160918/volumes/{}", rpc_encode(volume_id))).await {
            disks.push(json!({"DiskId": volume_id, "DiskName": volume.get("displayName").or_else(|| attachment.get("displayName")).unwrap_or(&json!(volume_id)), "Category": "数据卷", "Size": volume.get("sizeInGBs").unwrap_or(&json!(0)), "Status": volume.get("lifecycleState").or_else(|| attachment.get("lifecycleState")).unwrap_or(&json!("")), "Device": attachment.get("device").unwrap_or(&json!(""))}));
        }
    }
    Ok(disks)
}

pub(crate) async fn resource_items(id: i64, resource_type: &str) -> ResourceResponse {
    let now = Utc::now().timestamp_millis();
    let credentials = match oracle_credentials(id) { Ok(value) => value, Err(error) => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![error], fetched_at: now } };
    let (compartments, regions) = match oracle_context(&credentials).await { Ok(value) => value, Err(error) => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![error], fetched_at: now } };
    let mut items = Vec::new(); let mut errors = Vec::new();
    for region in regions {
        let host = match resource_type { "ecs" => format!("iaas.{region}.oraclecloud.com"), "rds" => format!("database.{region}.oci.oraclecloud.com"), "domain" => format!("dns.{region}.oci.oraclecloud.com"), "oss" => oracle_object_storage_host(&region), _ => { errors.push(format!("Oracle Cloud 暂未接入 {resource_type} 资源")); break; } };
        let namespace = if resource_type == "oss" { match oracle_request(&credentials, &host, "/n/").await { Ok((Value::String(value), _)) if !value.is_empty() => Some(value), Ok(_) => { errors.push(format!("{region}: 未能读取 Object Storage namespace")); None }, Err(error) => { errors.push(format!("{region}: {error}")); None } } } else { None };
        if resource_type == "oss" && namespace.is_none() { continue; }
        for compartment in &compartments {
            let compartment_id = compartment.get("id").and_then(Value::as_str).unwrap_or("");
            if compartment_id.is_empty() { continue; }
            let result = match resource_type {
                "ecs" => oracle_pages(&credentials, &host, "/20160918/instances", vec![("compartmentId".into(), compartment_id.into())]).await,
                "rds" => oracle_pages(&credentials, &host, "/20160918/dbSystems", vec![("compartmentId".into(), compartment_id.into())]).await,
                "domain" => oracle_pages(&credentials, &host, "/20180115/zones", vec![("compartmentId".into(), compartment_id.into())]).await,
                "oss" => oracle_pages(&credentials, &host, &format!("/n/{}/b/", rpc_encode(namespace.as_deref().unwrap_or(""))), vec![("compartmentId".into(), compartment_id.into())]).await,
                _ => unreachable!(),
            };
            match result {
                Ok(values) if resource_type == "ecs" => {
                    let shapes = oracle_pages(&credentials, &host, "/20160928/shapes", vec![("compartmentId".into(), compartment_id.into())]).await.unwrap_or_default();
                    for item in values {
                        let shape = item.get("shape").and_then(Value::as_str).and_then(|name| shapes.iter().find(|candidate| candidate.get("shape").and_then(Value::as_str) == Some(name)));
                        items.push(oracle_instance(&credentials, &host, &item, &region, compartment, shape).await);
                    }
                }
                Ok(values) => for item in values { items.push(match resource_type { "rds" => oracle_db_system(&item, &region, compartment), "domain" => oracle_zone(&item, &region, compartment), "oss" => oracle_bucket(&item, &region, compartment), _ => item }); },
                Err(error) => errors.push(format!("{region}/{}: {error}", compartment.get("name").and_then(Value::as_str).unwrap_or(compartment_id))),
            }
        }
    }
    ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: now }
}
