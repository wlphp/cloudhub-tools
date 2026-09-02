use chrono::Utc;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rsa::{pkcs1::DecodeRsaPrivateKey, pkcs8::DecodePrivateKey, RsaPrivateKey};
use rsa::pkcs1v15::SigningKey;
use rsa::signature::{SignatureEncoding, Signer};
use serde_json::{json, Value};
use sha2::Sha256;
use crate::ResourceResponse;

struct GcpCredentials { email: String, private_key: String, project_id: String }

fn credentials(id: i64) -> Result<GcpCredentials, String> {
    let conn = crate::open_db()?;
    let (email, secret_ciphertext, enabled) = crate::account_repository::credential_record(&conn, id)?;
    if enabled != 1 { return Err("云账号已停用".into()); }
    if crate::account_repository::cloud_type(&conn, id)? != "gcp" { return Err("当前账号不是 Google Cloud 账号".into()); }
    let project_id = crate::account_repository::credential_meta(&conn, id)?.get("project_id").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if project_id.is_empty() { return Err("GCP 账号缺少 Project ID".into()); }
    Ok(GcpCredentials { email, private_key: crate::decrypt_secret(&secret_ciphertext)?.replace("\\n", "\n"), project_id })
}

async fn token(credentials: &GcpCredentials) -> Result<String, String> {
    let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"RS256","typ":"JWT"}"#); let now = Utc::now().timestamp(); let claim = URL_SAFE_NO_PAD.encode(serde_json::to_string(&json!({"iss": credentials.email, "scope": "https://www.googleapis.com/auth/cloud-platform", "aud": "https://oauth2.googleapis.com/token", "iat": now, "exp": now + 3600})).map_err(|error| error.to_string())?); let signing_input = format!("{header}.{claim}"); let private_key = RsaPrivateKey::from_pkcs8_pem(&credentials.private_key).or_else(|_| RsaPrivateKey::from_pkcs1_pem(&credentials.private_key)).map_err(|_| "GCP 服务账号私钥无效，需使用未加密的 PEM 私钥".to_string())?; let signature = URL_SAFE_NO_PAD.encode(SigningKey::<Sha256>::new(private_key).sign(signing_input.as_bytes()).to_vec()); let assertion = format!("{signing_input}.{signature}");
    let response = reqwest::Client::new().post("https://oauth2.googleapis.com/token").form(&[("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"), ("assertion", assertion.as_str())]).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("GCP OAuth 请求失败: {error}"))?; let status = response.status(); let data: Value = response.json().await.map_err(|error| format!("GCP OAuth 返回解析失败: {error}"))?; if !status.is_success() { return Err(data.get("error_description").or_else(|| data.get("error")).and_then(Value::as_str).unwrap_or("GCP OAuth 失败").to_string()); } data.get("access_token").and_then(Value::as_str).map(String::from).ok_or_else(|| "GCP OAuth 未返回 access token".into())
}

async fn get(token: &str, url: &str) -> Result<Value, String> { let response = reqwest::Client::new().get(url).bearer_auth(token).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("GCP 请求失败: {error}"))?; let status = response.status(); let data: Value = response.json().await.map_err(|error| format!("GCP 返回解析失败: {error}"))?; if !status.is_success() { return Err(data.pointer("/error/message").or_else(|| data.get("message")).and_then(Value::as_str).unwrap_or("GCP API 返回错误").to_string()); } Ok(data) }

async fn pages(token: &str, url: &str, key: &str) -> Result<Vec<Value>, String> { let mut items = Vec::new(); let mut next = url.to_string(); for _ in 0..100 { let data = get(token, &next).await?; items.extend(crate::array_at(&data, &[key]).into_iter().cloned()); let Some(page_token) = data.get("nextPageToken").and_then(Value::as_str) else { break; }; next = format!("{}{}pageToken={}", url, if url.contains('?') { "&" } else { "?" }, crate::rpc_encode(page_token)); } Ok(items) }

fn instance(item: &Value, region: &str) -> Value { let network = item.pointer("/networkInterfaces/0"); json!({"InstanceId": item.get("id").or_else(|| item.get("name")), "InstanceName": item.get("name"), "InstanceStatus": item.get("status"), "Status": item.get("status"), "PublicIpAddress": network.and_then(|v| v.pointer("/accessConfigs/0/natIP")), "PrivateIpAddress": network.and_then(|v| v.get("networkIP")), "InstanceType": item.get("machineType").and_then(Value::as_str).unwrap_or("").rsplit('/').next().unwrap_or(""), "VpcId": network.and_then(|v| v.get("network")).and_then(Value::as_str).unwrap_or("").rsplit('/').next().unwrap_or(""), "_region_id": region, "_raw": item}) }
fn rds(item: &Value) -> Value { json!({"DBInstanceId": item.get("name"), "DBInstanceDescription": item.get("name"), "DBInstanceStatus": item.get("state"), "DBInstanceClass": item.pointer("/settings/tier"), "DBInstanceStorage": item.pointer("/settings/dataDiskSizeGb").unwrap_or(&json!(0)), "ConnectionString": item.get("ipAddresses").and_then(Value::as_array).and_then(|v| v.iter().find(|x| x.get("type").and_then(Value::as_str) == Some("PRIMARY"))).and_then(|v| v.get("ipAddress")), "Port": "3306", "Engine": item.get("databaseVersion"), "EngineVersion": item.get("databaseVersion"), "CreateTime": item.get("createTime"), "_region_id": item.get("region"), "_raw": item}) }
fn redis(item: &Value) -> Value { json!({"InstanceId": item.get("name"), "InstanceName": item.get("name").and_then(Value::as_str).unwrap_or("").rsplit('/').next().unwrap_or(""), "InstanceStatus": item.get("state"), "InstanceType": "Redis", "InstanceClass": item.get("tier"), "Capacity": item.get("memorySizeGb").and_then(Value::as_i64).unwrap_or(0) * 1024, "ConnectionDomain": item.get("host"), "Port": item.get("port"), "EngineVersion": item.get("redisVersion"), "NetworkType": item.get("authorizedNetwork"), "_region_id": item.get("locationId"), "_raw": item}) }
fn bucket(item: &Value) -> Value { json!({"Name": item.get("name"), "BucketName": item.get("name"), "Location": item.get("location"), "CreationDate": item.get("timeCreated"), "StorageClass": item.get("storageClass").unwrap_or(&json!("STANDARD")), "Acl": "private", "ExtranetEndpoint": "-", "IntranetEndpoint": "-", "_region_id": item.get("location"), "_raw": item}) }
fn zone(item: &Value) -> Value { json!({"DomainName": item.get("dnsName").and_then(Value::as_str).unwrap_or("").trim_end_matches('.'), "DomainStatus": "ACTIVE", "ZoneId": item.get("id").or_else(|| item.get("name")), "RecordCount": 0, "RegistrationDate": item.get("creationTime"), "_region_id": "global", "_gcp_dns": true, "_raw": item}) }

pub(crate) async fn resource_items(id: i64, resource_type: &str) -> ResourceResponse {
    let now = Utc::now().timestamp_millis(); let credentials = match credentials(id) { Ok(v) => v, Err(e) => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![e], fetched_at: now } }; let token = match token(&credentials).await { Ok(v) => v, Err(e) => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![e], fetched_at: now } }; let project = crate::rpc_encode(&credentials.project_id);
    let result = match resource_type {
        "ecs" => get(&token, &format!("https://compute.googleapis.com/compute/v1/projects/{project}/aggregated/instances")).await.map(|data| {
            data.get("items").and_then(Value::as_object).into_iter().flat_map(|values| values.iter()).flat_map(|(scope, value)| {
                crate::array_at(value, &["instances"]).into_iter().map(|item| instance(item, scope.rsplit('/').next().unwrap_or(""))).collect::<Vec<_>>()
            }).collect::<Vec<_>>()
        }),
        "rds" => pages(&token, &format!("https://sqladmin.googleapis.com/sql/v1beta4/projects/{project}/instances"), "items").await.map(|v| v.into_iter().map(|item| rds(&item)).collect()),
        "redis" => pages(&token, &format!("https://redis.googleapis.com/v1/projects/{project}/locations/-/instances"), "instances").await.map(|v| v.into_iter().map(|item| redis(&item)).collect()),
        "oss" => pages(&token, &format!("https://storage.googleapis.com/storage/v1/b?project={project}"), "items").await.map(|v| v.into_iter().map(|item| bucket(&item)).collect()),
        "domain" => pages(&token, &format!("https://dns.googleapis.com/dns/v1/projects/{project}/managedZones"), "managedZones").await.map(|v| v.into_iter().map(|item| zone(&item)).collect()),
        _ => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![format!("GCP 暂未接入 {resource_type} 资源")], fetched_at: now }
    };
    match result { Ok(items) => ResourceResponse { resource_type: resource_type.into(), items, errors: vec![], fetched_at: now }, Err(error) => ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![error], fetched_at: now } }
}

pub(crate) async fn verify_account(id: i64) -> Result<Value, String> {
    let credentials = credentials(id)?;
    let token = token(&credentials).await?;
    get(&token, &format!("https://cloudresourcemanager.googleapis.com/v1/projects/{}", crate::rpc_encode(&credentials.project_id))).await?;
    let regions = crate::configured_regions(id, "asia-east1")?;
    let default_region = regions.first().cloned().ok_or_else(|| "GCP 未配置可用区域".to_string())?;
    Ok(json!({"provider":"gcp","verified":true,"region_count":regions.len(),"regions":regions,"default_region":default_region}))
}
