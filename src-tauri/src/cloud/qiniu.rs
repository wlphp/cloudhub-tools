use crate::{account_cloud_type, account_credentials, configured_regions, write_api_log, ResourceResponse};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha1::Sha1;

async fn buckets(id: i64) -> Result<Vec<Value>, String> {
    if account_cloud_type(id)? != "qiniu" { return Err("当前账号不是七牛云账号".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let region = configured_regions(id, "z0")?.first().cloned().unwrap_or_else(|| "z0".into());
    let mut mac: Hmac<Sha1> = <Hmac<Sha1> as Mac>::new_from_slice(access_key_secret.as_bytes()).map_err(|error| error.to_string())?;
    mac.update(b"/buckets\n");
    let authorization = format!("QBox {access_key_id}:{}", URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()));
    let response = reqwest::Client::new().get("https://rs.qiniuapi.com/buckets").header("Authorization", authorization).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|error| format!("七牛云请求失败: {error}"))?;
    let status = response.status();
    let data: Value = response.json().await.map_err(|error| format!("七牛云返回解析失败: {error}"))?;
    if !status.is_success() {
        let message = data.get("error").or_else(|| data.get("message")).and_then(Value::as_str).unwrap_or("七牛云 API 返回错误").to_string();
        write_api_log(&access_key_id, "rs.qiniuapi.com", "ListBuckets", &json!({}), Some(&data), "失败", Some(&message));
        return Err(message);
    }
    let values = data.as_array().cloned().unwrap_or_default().into_iter().filter_map(|value| value.as_str().map(String::from)).map(|name| json!({"Name": name, "BucketName": name, "Location": region, "CreationDate": "", "StorageClass": "STANDARD", "Acl": "private", "ExtranetEndpoint": "-", "IntranetEndpoint": "-", "_region_id": region})).collect::<Vec<_>>();
    write_api_log(&access_key_id, "rs.qiniuapi.com", "ListBuckets", &json!({}), Some(&json!({"count": values.len()})), "成功", None);
    Ok(values)
}

pub(crate) async fn resource_items(id: i64, resource_type: &str) -> ResourceResponse {
    let now = Utc::now().timestamp_millis();
    if resource_type != "oss" { return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![format!("七牛云暂未接入 {resource_type} 资源；当前仅支持 Kodo 空间")], fetched_at: now }; }
    match buckets(id).await {
        Ok(items) => ResourceResponse { resource_type: resource_type.into(), items, errors: vec![], fetched_at: now },
        Err(error) => ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![error], fetched_at: now },
    }
}

#[tauri::command]
pub(crate) async fn verify_qiniu_account(id: i64) -> Result<Value, String> {
    let items = buckets(id).await?;
    let regions = configured_regions(id, "z0")?;
    Ok(json!({"provider":"qiniu","verified":true,"region_count":regions.len(),"regions":regions,"default_region":configured_regions(id, "z0")?[0],"bucket_count":items.len()}))
}
