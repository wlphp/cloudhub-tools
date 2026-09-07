use crate::account_cloud_type;
use crate::core::error::PlatformResult;
use serde_json::Value;

#[tauri::command]
pub(crate) async fn list_dns_records(id: i64, domain: String, record_type: Option<String>, keyword: Option<String>) -> PlatformResult<Value> {
    if account_cloud_type(id)? == "tencent" {
        return crate::cloud::tencent::list_dns_records(id, &domain, record_type, keyword).await.map_err(Into::into);
    }
    if account_cloud_type(id)? == "ctyun" {
        return crate::cloud::ctyun::list_dns_records(id, &domain, record_type, keyword).await.map_err(Into::into);
    }
    crate::cloud::aliyun::list_dns_records(id, &domain, record_type, keyword).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn add_dns_record(id: i64, domain: String, record_type: String, rr: String, value: String, ttl: Option<i64>, priority: Option<i64>, line: Option<String>) -> PlatformResult<Value> {
    crate::cloud::aliyun::add_dns_record(id, &domain, &record_type, &rr, &value, ttl, priority, line).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn update_dns_record(id: i64, record_id: String, record_type: String, rr: String, value: String, ttl: Option<i64>, priority: Option<i64>, line: Option<String>) -> PlatformResult<Value> {
    crate::cloud::aliyun::update_dns_record(id, &record_id, &record_type, &rr, &value, ttl, priority, line).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn delete_dns_record(id: i64, record_id: String) -> PlatformResult<Value> {
    crate::cloud::aliyun::delete_dns_record(id, &record_id).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn toggle_dns_record(id: i64, record_id: String, status: String) -> PlatformResult<Value> {
    crate::cloud::aliyun::toggle_dns_record(id, &record_id, &status).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn list_domain_logs(id: i64, domain: String, start_date: Option<String>, end_date: Option<String>, keyword: Option<String>) -> PlatformResult<Value> {
    crate::cloud::aliyun::list_domain_logs(id, &domain, start_date, end_date, keyword).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn query_whois(id: i64, domain: String) -> PlatformResult<String> {
    crate::cloud::aliyun::query_whois(id, &domain).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn list_rds_databases(id: i64, region_id: String, instance_id: String) -> PlatformResult<Vec<Value>> {
    if account_cloud_type(id)? == "tencent" { return crate::cloud::tencent::list_rds_databases(id, &region_id, &instance_id).await.map_err(Into::into); }
    crate::cloud::aliyun::list_rds_databases(id, &region_id, &instance_id).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn list_rds_accounts(id: i64, region_id: String, instance_id: String) -> PlatformResult<Vec<Value>> {
    if account_cloud_type(id)? == "tencent" { return crate::cloud::tencent::list_rds_accounts(id, &region_id, &instance_id).await.map_err(Into::into); }
    crate::cloud::aliyun::list_rds_accounts(id, &region_id, &instance_id).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn list_redis_accounts(id: i64, instance_id: String, region_id: String) -> PlatformResult<Vec<Value>> {
    if account_cloud_type(id)? == "tencent" { return crate::cloud::tencent::list_redis_accounts(id, &instance_id, &region_id).await.map_err(Into::into); }
    crate::cloud::aliyun::list_redis_accounts(id, &instance_id, &region_id).await.map_err(Into::into)
}
