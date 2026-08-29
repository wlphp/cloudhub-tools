use crate::{account_cloud_type, fetch_cloud_resources, AssetSyncResult, ResourceResponse};
use crate::core::storage::open_db;
use chrono::Utc;
use rusqlite::params;
use serde_json::Value;
use std::collections::BTreeMap;

fn asset_key(resource_type: &str, item: &Value, index: usize) -> String {
    for key in ["InstanceId", "DBInstanceId", "KVStoreInstanceId", "AssetId", "SiteId", "DomainName", "Name", "BucketName", "Id", "id"] {
        if let Some(value) = item.get(key).and_then(Value::as_str).filter(|value| !value.is_empty()) { return value.to_string(); }
        if let Some(value) = item.get(key).and_then(Value::as_i64) { return value.to_string(); }
    }
    format!("{resource_type}-{index}")
}

fn default_resource_types(cloud_type: &str) -> Vec<String> {
    let types: &[&str] = match cloud_type {
        "vultr" => &["ecs", "domain", "oss", "rds", "block", "network", "firewall", "ip", "loadbalancer", "snapshot", "kubernetes"],
        "qiniu" => &["oss"],
        "jdcloud" => &["ecs", "domain", "swas", "rds", "redis", "oss"],
        "qingcloud" => &["ecs", "domain", "rds", "redis", "oss"],
        "ksyun" => &["ecs", "rds", "redis", "oss"],
        "huawei" | "baidu" | "ucloud" | "aws" | "azure" | "gcp" => &["ecs", "domain", "rds", "redis", "oss"],
        "oracle" => &["ecs", "domain", "rds", "oss"],
        "ctyun" => &["ecs", "domain", "rds", "redis", "oss"],
        "volcengine" => &["ecs", "domain", "swas", "rds", "redis", "oss", "esa"],
        _ => &["ecs", "domain", "oss", "rds", "redis", "swas", "esa"],
    };
    types.iter().map(|value| (*value).to_string()).collect()
}

#[tauri::command]
pub(crate) async fn list_cloud_resources(id: i64, resource_type: String) -> Result<ResourceResponse, String> {
    fetch_cloud_resources(id, &resource_type).await
}

#[tauri::command]
pub(crate) async fn sync_cloud_assets(id: i64, resource_types: Vec<String>) -> Result<AssetSyncResult, String> {
    let cloud_type = account_cloud_type(id)?;
    if !matches!(cloud_type.as_str(), "aliyun" | "tencent" | "volcengine" | "ctyun" | "oracle" | "huawei" | "baidu" | "ucloud" | "qiniu" | "aws" | "azure" | "gcp" | "jdcloud" | "qingcloud" | "ksyun" | "vultr") {
        return Err("当前云类型资源实时拉取尚未接入".into());
    }
    let types = if resource_types.is_empty() { default_resource_types(&cloud_type) } else { resource_types };
    let now = Utc::now().timestamp_millis();
    let mut fetched = 0usize;
    let mut counts = BTreeMap::new();
    let mut errors = Vec::new();
    let mut rows = Vec::new();
    for resource_type in types {
        let response = fetch_cloud_resources(id, &resource_type).await?;
        if !response.errors.is_empty() { errors.extend(response.errors.clone().into_iter().map(|error| format!("{resource_type}: {error}"))); }
        rows.push((resource_type, response));
    }
    let mut conn = open_db()?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    for (resource_type, response) in rows {
        counts.insert(resource_type.clone(), response.items.len());
        tx.execute("DELETE FROM cloud_assets WHERE account_id=?1 AND resource_type=?2", params![id, resource_type]).map_err(|error| error.to_string())?;
        for (index, item) in response.items.iter().enumerate() {
            let key = asset_key(&resource_type, item, index);
            let region = item.get("_region_id").and_then(Value::as_str).or_else(|| item.get("RegionId").and_then(Value::as_str));
            tx.execute("INSERT OR REPLACE INTO cloud_assets(account_id,resource_type,asset_key,region_id,payload_json,fetched_at) VALUES(?1,?2,?3,?4,?5,?6)", params![id, resource_type, key, region, serde_json::to_string(item).map_err(|error| error.to_string())?, response.fetched_at]).map_err(|error| error.to_string())?;
            fetched += 1;
        }
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(AssetSyncResult { fetched, counts, errors, fetched_at: now })
}
