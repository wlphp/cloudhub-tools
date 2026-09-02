use chrono::Utc;
use serde_json::{json, Value};
use crate::ResourceResponse;

struct AzureCredentials { client_id: String, client_secret: String, tenant_id: String, subscription_id: String }

fn credentials(id: i64) -> Result<AzureCredentials, String> {
    let conn = crate::open_db()?;
    let (client_id, secret_ciphertext, enabled) = crate::account_repository::credential_record(&conn, id)?;
    if enabled != 1 { return Err("云账号已停用".into()); }
    if crate::account_repository::cloud_type(&conn, id)? != "azure" { return Err("当前账号不是 Azure 账号".into()); }
    let meta = crate::account_repository::credential_meta(&conn, id)?;
    let tenant_id = meta.get("tenant_id").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let subscription_id = meta.get("subscription_id").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if tenant_id.is_empty() || subscription_id.is_empty() { return Err("Azure 账号缺少 Tenant ID 或 Subscription ID".into()); }
    Ok(AzureCredentials { client_id, client_secret: crate::decrypt_secret(&secret_ciphertext)?, tenant_id, subscription_id })
}

async fn token(credentials: &AzureCredentials) -> Result<String, String> {
    let response = reqwest::Client::new().post(format!("https://login.microsoftonline.com/{}/oauth2/v2.0/token", crate::rpc_encode(&credentials.tenant_id))).form(&[("client_id", credentials.client_id.as_str()), ("client_secret", credentials.client_secret.as_str()), ("grant_type", "client_credentials"), ("scope", "https://management.azure.com/.default")]).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("Azure OAuth 请求失败: {error}"))?; let status = response.status(); let data: Value = response.json().await.map_err(|error| format!("Azure OAuth 返回解析失败: {error}"))?; if !status.is_success() { return Err(data.get("error_description").or_else(|| data.get("error")).and_then(Value::as_str).unwrap_or("Azure OAuth 失败").to_string()); } data.get("access_token").and_then(Value::as_str).map(String::from).ok_or_else(|| "Azure OAuth 未返回 access token".into())
}

async fn resources_raw(credentials: &AzureCredentials) -> Result<Vec<Value>, String> {
    let access_token = token(credentials).await?; let mut next = format!("https://management.azure.com/subscriptions/{}/resources?api-version=2021-04-01", crate::rpc_encode(&credentials.subscription_id)); let mut values = Vec::new();
    for _ in 0..100 { if next.is_empty() { break; } let response = reqwest::Client::new().get(&next).bearer_auth(&access_token).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("Azure ARM 请求失败: {error}"))?; let status = response.status(); let data: Value = response.json().await.map_err(|error| format!("Azure ARM 返回解析失败: {error}"))?; if !status.is_success() { return Err(data.pointer("/error/message").or_else(|| data.get("message")).and_then(Value::as_str).unwrap_or("Azure ARM 返回错误").to_string()); } values.extend(crate::array_at(&data, &["value"]).into_iter().cloned()); next = data.get("nextLink").and_then(Value::as_str).unwrap_or("").to_string(); }
    Ok(values)
}

fn instance(item: &Value) -> Value { let p = item.get("properties").cloned().unwrap_or(Value::Null); json!({"InstanceId": item.get("id"), "InstanceName": item.get("name"), "InstanceStatus": p.get("provisioningState"), "Status": p.get("provisioningState"), "PublicIpAddress": "", "PrivateIpAddress": "", "InstanceType": p.pointer("/hardwareProfile/vmSize"), "VpcId": "", "_region_id": item.get("location"), "_raw": item}) }
fn rds(item: &Value) -> Value { let p = item.get("properties").cloned().unwrap_or(Value::Null); json!({"DBInstanceId": item.get("id"), "DBInstanceDescription": item.get("name"), "DBInstanceStatus": p.get("state").or_else(|| p.get("provisioningState")), "DBInstanceClass": item.pointer("/sku/name"), "DBInstanceStorage": 0, "ConnectionString": p.get("fullyQualifiedDomainName"), "Port": "", "Engine": "Azure SQL", "EngineVersion": p.get("version"), "CreateTime": "", "_region_id": item.get("location"), "_raw": item}) }
fn redis(item: &Value) -> Value { let p = item.get("properties").cloned().unwrap_or(Value::Null); json!({"InstanceId": item.get("id"), "InstanceName": item.get("name"), "InstanceStatus": p.get("provisioningState"), "InstanceType": "Redis", "InstanceClass": item.pointer("/sku/name"), "Capacity": item.pointer("/sku/capacity").cloned().unwrap_or(json!(0)), "ConnectionDomain": p.get("hostName"), "Port": p.get("sslPort").or_else(|| p.get("port")), "EngineVersion": p.get("redisVersion"), "NetworkType": p.get("subnetId"), "_region_id": item.get("location"), "_raw": item}) }
fn bucket(item: &Value) -> Value { let p = item.get("properties").cloned().unwrap_or(Value::Null); json!({"Name": item.get("name"), "BucketName": item.get("name"), "Location": item.get("location"), "CreationDate": p.get("creationTime"), "StorageClass": item.pointer("/sku/name").cloned().unwrap_or(json!("Standard")), "Acl": if p.get("allowBlobPublicAccess").and_then(Value::as_bool) == Some(true) { "public" } else { "private" }, "ExtranetEndpoint": "-", "IntranetEndpoint": "-", "_region_id": item.get("location"), "_raw": item}) }
fn zone(item: &Value) -> Value { let p = item.get("properties").cloned().unwrap_or(Value::Null); json!({"DomainName": item.get("name"), "DomainStatus": p.get("provisioningState").cloned().unwrap_or(json!("ACTIVE")), "ZoneId": item.get("id"), "RecordCount": p.get("numberOfRecordSets").cloned().unwrap_or(json!(0)), "RegistrationDate": "", "_region_id": item.get("location").cloned().unwrap_or(json!("global")), "_azure_dns": true, "_raw": item}) }

pub(crate) async fn resource_items(id: i64, resource_type: &str) -> ResourceResponse {
    let now = Utc::now().timestamp_millis(); let credentials = match credentials(id) { Ok(v) => v, Err(e) => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![e], fetched_at: now } }; let values = match resources_raw(&credentials).await { Ok(v) => v, Err(e) => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![e], fetched_at: now } };
    let expected = match resource_type { "ecs" => "microsoft.compute/virtualmachines", "rds" => "microsoft.sql/servers", "redis" => "microsoft.cache/redis", "oss" => "microsoft.storage/storageaccounts", "domain" => "microsoft.network/dnszones", _ => return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![format!("Azure 暂未接入 {resource_type} 资源")], fetched_at: now } };
    let items = values.into_iter().filter(|item| item.get("type").and_then(Value::as_str).map(|v| v.eq_ignore_ascii_case(expected)).unwrap_or(false)).map(|item| match resource_type { "ecs" => instance(&item), "rds" => rds(&item), "redis" => redis(&item), "oss" => bucket(&item), "domain" => zone(&item), _ => item }).collect();
    ResourceResponse { resource_type: resource_type.into(), items, errors: vec![], fetched_at: now }
}

pub(crate) async fn verify_account(id: i64) -> Result<Value, String> {
    let credentials = credentials(id)?;
    let access_token = token(&credentials).await?;
    let response = reqwest::Client::new().get(format!("https://management.azure.com/subscriptions/{}?api-version=2022-12-01", crate::rpc_encode(&credentials.subscription_id))).bearer_auth(access_token).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("Azure ARM 请求失败: {error}"))?;
    if !response.status().is_success() { return Err(format!("Azure 订阅验证失败：{}", response.status())); }
    let regions = crate::configured_regions(id, "eastasia")?;
    let default_region = regions.first().cloned().ok_or_else(|| "Azure 未配置可用区域".to_string())?;
    Ok(json!({"provider":"azure","verified":true,"region_count":regions.len(),"regions":regions,"default_region":default_region}))
}
