use crate::{account_cloud_type, account_credentials, asset_key, fetch_resource_with_retry, AssetSyncProgress, AssetSyncResult, AssetSyncStore, ResourceResponse};
use crate::core::repositories::assets as asset_repository;
use crate::core::error::{sanitize_resource_error, PlatformResult};
use serde_json::Value;
use tauri::Emitter;
use chrono::Utc;
use std::{sync::{Arc, Mutex}, time::Instant};
use tokio::task::JoinSet;

const MAX_CONCURRENT_RESOURCE_FETCHES: usize = 3;

struct SyncRunGuard {
    running_accounts: Arc<Mutex<std::collections::HashSet<i64>>>,
    account_id: i64,
}

fn acquire_sync_run(
    running_accounts: &Arc<Mutex<std::collections::HashSet<i64>>>,
    account_id: i64,
) -> Result<SyncRunGuard, String> {
    let mut running = running_accounts.lock().map_err(|_| "同步状态不可用".to_string())?;
    if !running.insert(account_id) { return Err("同步任务已在运行".into()); }
    Ok(SyncRunGuard { running_accounts: running_accounts.clone(), account_id })
}

impl Drop for SyncRunGuard {
    fn drop(&mut self) {
        if let Ok(mut running) = self.running_accounts.lock() {
            running.remove(&self.account_id);
        }
    }
}

async fn fetch_cloud_resource(
    id: i64,
    cloud_type: String,
    resource_type: String,
    access_key_id: String,
    access_key_secret: String,
    cancelled_accounts: Arc<Mutex<std::collections::HashSet<i64>>>,
) -> Result<(String, ResourceResponse), String> {
    let fetch_type = resource_type.clone();
    let cloud = cloud_type;
    let response = fetch_resource_with_retry(|| async {
        if cloud == "vultr" { crate::cloud::vultr::vultr_resource_items(id, &fetch_type).await }
        else if cloud == "huawei" { crate::cloud::huawei::resource_items(id, &fetch_type).await }
        else if cloud == "baidu" { crate::cloud::baidu::resource_items(id, &fetch_type).await }
        else if cloud == "ucloud" { crate::cloud::ucloud::resource_items(id, &fetch_type).await }
        else if cloud == "qiniu" { crate::cloud::qiniu::resource_items(id, &fetch_type).await }
        else if cloud == "aws" { crate::cloud::aws::resource_items(id, &fetch_type).await }
        else if cloud == "azure" { crate::cloud::azure::resource_items(id, &fetch_type).await }
        else if cloud == "gcp" { crate::cloud::gcp::resource_items(id, &fetch_type).await }
        else if cloud == "jdcloud" { crate::cloud::jdcloud::resource_items(id, &fetch_type).await }
        else if cloud == "qingcloud" { crate::cloud::qingcloud::resource_items(id, &fetch_type).await }
        else if cloud == "ksyun" { crate::cloud::ksyun::resource_items(id, &fetch_type).await }
        else if cloud == "oracle" { crate::cloud::oracle::resource_items(id, &fetch_type).await }
        else if cloud == "tencent" { crate::cloud::tencent::resource_items(id, &fetch_type, &access_key_id, &access_key_secret).await }
        else if cloud == "volcengine" { crate::cloud::volc::resource_items(id, &fetch_type, &access_key_id, &access_key_secret).await }
        else if cloud == "ctyun" { crate::cloud::ctyun::resource_items(id, &fetch_type, &access_key_id, &access_key_secret).await }
        else if cloud == "aliyun" { crate::cloud::aliyun::resource_items(&fetch_type, &access_key_id, &access_key_secret).await }
        else { ResourceResponse { resource_type: fetch_type.clone(), items: vec![], errors: vec!["当前云类型资源实时拉取尚未接入".into()], fetched_at: Utc::now().timestamp_millis() } }
    }, || cancelled_accounts.lock().map(|cancelled| cancelled.contains(&id)).unwrap_or(true)).await?;
    Ok((resource_type, response))
}

#[tauri::command]
pub(crate) async fn list_cloud_resources(id: i64, resource_type: String) -> PlatformResult<ResourceResponse> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let mut response = match account_cloud_type(id)?.as_str() {
        "aliyun" => crate::cloud::aliyun::resource_items(&resource_type, &access_key_id, &access_key_secret).await,
        "tencent" => crate::cloud::tencent::resource_items(id, &resource_type, &access_key_id, &access_key_secret).await,
        "volcengine" => crate::cloud::volc::resource_items(id, &resource_type, &access_key_id, &access_key_secret).await,
        "ctyun" => crate::cloud::ctyun::resource_items(id, &resource_type, &access_key_id, &access_key_secret).await,
        "huawei" => crate::cloud::huawei::resource_items(id, &resource_type).await,
        "baidu" => crate::cloud::baidu::resource_items(id, &resource_type).await,
        "ucloud" => crate::cloud::ucloud::resource_items(id, &resource_type).await,
        "qiniu" => crate::cloud::qiniu::resource_items(id, &resource_type).await,
        "aws" => crate::cloud::aws::resource_items(id, &resource_type).await,
        "azure" => crate::cloud::azure::resource_items(id, &resource_type).await,
        "gcp" => crate::cloud::gcp::resource_items(id, &resource_type).await,
        "jdcloud" => crate::cloud::jdcloud::resource_items(id, &resource_type).await,
        "qingcloud" => crate::cloud::qingcloud::resource_items(id, &resource_type).await,
        "ksyun" => crate::cloud::ksyun::resource_items(id, &resource_type).await,
        "oracle" => crate::cloud::oracle::resource_items(id, &resource_type).await,
        "vultr" => crate::cloud::vultr::vultr_resource_items(id, &resource_type).await,
        _ => return Err("当前云类型资源 API 尚未接入".into()),
    };
    response.errors = response.errors.iter().map(|error| sanitize_resource_error(error)).collect();
    Ok(response)
}

#[tauri::command]
pub(crate) async fn cancel_cloud_asset_sync(state: tauri::State<'_, AssetSyncStore>, id: i64) -> PlatformResult<()> {
    state.cancelled_accounts.lock().map_err(|_| "同步状态不可用".to_string())?.insert(id);
    Ok(())
}

#[tauri::command]
pub(crate) async fn sync_cloud_assets(app: tauri::AppHandle, state: tauri::State<'_, AssetSyncStore>, id: i64, resource_types: Vec<String>) -> PlatformResult<AssetSyncResult> {
    let _run_guard = acquire_sync_run(&state.running_accounts, id)?;
    let started_at = Instant::now();
    state.cancelled_accounts.lock().map_err(|_| "同步状态不可用".to_string())?.remove(&id);
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let cloud_type = account_cloud_type(id)?;
    if !["aliyun", "tencent", "volcengine", "ctyun", "oracle", "huawei", "baidu", "ucloud", "qiniu", "aws", "azure", "gcp", "jdcloud", "qingcloud", "ksyun", "vultr"].contains(&cloud_type.as_str()) { return Err("当前云类型资源实时拉取尚未接入".into()); }
    let now = Utc::now().timestamp_millis();
    let types = if resource_types.is_empty() {
        if cloud_type == "vultr" { vec!["ecs", "domain", "oss", "rds", "block", "network", "firewall", "ip", "loadbalancer", "snapshot", "kubernetes"].into_iter().map(String::from).collect() } else if cloud_type == "qiniu" { vec!["oss"].into_iter().map(String::from).collect() } else if cloud_type == "jdcloud" { vec!["ecs", "domain", "swas", "rds", "redis", "oss"].into_iter().map(String::from).collect() } else if cloud_type == "qingcloud" { vec!["ecs", "domain", "rds", "redis", "oss"].into_iter().map(String::from).collect() } else if cloud_type == "ksyun" { vec!["ecs", "rds", "redis", "oss"].into_iter().map(String::from).collect() } else if ["huawei", "baidu", "ucloud", "aws", "azure", "gcp"].contains(&cloud_type.as_str()) { vec!["ecs", "domain", "rds", "redis", "oss"].into_iter().map(String::from).collect() } else if cloud_type == "oracle" { vec!["ecs", "domain", "rds", "oss"].into_iter().map(String::from).collect() } else if cloud_type == "ctyun" { vec!["ecs", "domain", "rds", "redis", "oss"].into_iter().map(String::from).collect() } else if cloud_type == "volcengine" { vec!["ecs", "domain", "swas", "rds", "redis", "oss", "esa"].into_iter().map(String::from).collect() } else { vec!["ecs", "domain", "oss", "rds", "redis", "swas", "esa"].into_iter().map(String::from).collect() }
    } else { resource_types };
    let total = types.len();
    let _ = app.emit("asset-sync-progress", AssetSyncProgress { account_id: id, completed: 0, total, resource_type: String::new(), status: "started".into(), elapsed_ms: started_at.elapsed().as_millis() });
    let mut counts = std::collections::BTreeMap::new(); let mut errors = Vec::new(); let mut rows: Vec<(String, ResourceResponse)> = Vec::new();
    let mut pending: JoinSet<Result<(String, ResourceResponse), String>> = JoinSet::new();
    let cancelled_accounts = state.cancelled_accounts.clone();
    for resource_type in types.iter().cloned() {
        if state.cancelled_accounts.lock().map_err(|_| "同步状态不可用".to_string())?.contains(&id) { return Err("同步已取消".into()); }
        while pending.len() >= MAX_CONCURRENT_RESOURCE_FETCHES {
            let result = pending.join_next().await.ok_or_else(|| "同步任务状态不可用".to_string())?
                .map_err(|_| "同步任务状态不可用".to_string())??;
            let (resource_type, mut response) = result;
            response.errors = response.errors.iter().map(|error| sanitize_resource_error(error)).collect();
            let completed = rows.len() + 1;
            if !response.errors.is_empty() { errors.extend(response.errors.clone().into_iter().map(|error| format!("{resource_type}: {error}"))); }
            let _ = app.emit("asset-sync-progress", AssetSyncProgress { account_id: id, completed, total, resource_type: resource_type.clone(), status: if response.errors.is_empty() { "completed" } else { "failed" }.into(), elapsed_ms: started_at.elapsed().as_millis() });
            rows.push((resource_type, response));
        }
        pending.spawn(fetch_cloud_resource(id, cloud_type.clone(), resource_type, access_key_id.clone(), access_key_secret.clone(), cancelled_accounts.clone()));
    }
    while let Some(result) = pending.join_next().await {
        let (resource_type, mut response) = result.map_err(|_| "同步任务状态不可用".to_string())??;
        response.errors = response.errors.iter().map(|error| sanitize_resource_error(error)).collect();
        let completed = rows.len() + 1;
        if !response.errors.is_empty() { errors.extend(response.errors.clone().into_iter().map(|error| format!("{resource_type}: {error}"))); }
        let _ = app.emit("asset-sync-progress", AssetSyncProgress { account_id: id, completed, total, resource_type: resource_type.clone(), status: if response.errors.is_empty() { "completed" } else { "failed" }.into(), elapsed_ms: started_at.elapsed().as_millis() });
        rows.push((resource_type, response));
    }
    let mut conn = crate::open_db()?;
    let mut asset_rows = Vec::new();
    for (resource_type, response) in rows {
        let item_count = response.items.len(); counts.insert(resource_type.clone(), item_count);
        for (index, item) in response.items.iter().enumerate() {
            let region = item.get("_region_id").and_then(Value::as_str).or_else(|| item.get("RegionId").and_then(Value::as_str)).map(str::to_string);
            asset_rows.push(asset_repository::AssetRow { resource_type: resource_type.clone(), asset_key: asset_key(&resource_type, item, index), region_id: region, payload_json: serde_json::to_string(item).map_err(|error| error.to_string())?, fetched_at: response.fetched_at });
        }
    }
    let fetched = asset_repository::replace_for_account(&mut conn, id, &types, &asset_rows)?;
    state.cancelled_accounts.lock().map_err(|_| "同步状态不可用".to_string())?.remove(&id);
    Ok(AssetSyncResult { fetched, counts, errors, fetched_at: now })
}

#[cfg(test)]
mod tests {
    use super::acquire_sync_run;
    use std::{collections::HashSet, sync::{Arc, Mutex}};

    #[test]
    fn releases_account_lock_after_guard_is_dropped() {
        let running = Arc::new(Mutex::new(HashSet::new()));
        let first = acquire_sync_run(&running, 7).expect("first sync should start");
        assert!(acquire_sync_run(&running, 7).is_err());
        drop(first);
        assert!(acquire_sync_run(&running, 7).is_ok());
    }
}
