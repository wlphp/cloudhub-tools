use crate::cloud;
use crate::core::error::PlatformResult;
use serde_json::Value;

#[tauri::command]
pub(crate) async fn verify_ctyun_account(id: i64) -> PlatformResult<Value> { cloud::ctyun::verify_account(id).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn verify_huawei_account(id: i64) -> PlatformResult<Value> { cloud::huawei::verify_account(id).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn baidu_instance_action(id: i64, region_id: String, instance_id: String, action: String, force_stop: bool) -> PlatformResult<Value> { cloud::baidu::instance_action(id, &region_id, &instance_id, &action, force_stop).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn verify_ucloud_account(id: i64) -> PlatformResult<Value> { cloud::ucloud::verify_account(id).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn verify_qiniu_account(id: i64) -> PlatformResult<Value> { cloud::qiniu::verify_account(id).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn verify_aws_account(id: i64) -> PlatformResult<Value> { cloud::aws::verify_account(id).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn verify_azure_account(id: i64) -> PlatformResult<Value> { cloud::azure::verify_account(id).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn verify_gcp_account(id: i64) -> PlatformResult<Value> { cloud::gcp::verify_account(id).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn verify_jdcloud_account(id: i64) -> PlatformResult<Value> { cloud::jdcloud::verify_account(id).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn verify_qingcloud_account(id: i64) -> PlatformResult<Value> { cloud::qingcloud::verify_account(id).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn verify_ksyun_account(id: i64) -> PlatformResult<Value> { cloud::ksyun::verify_account(id).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn verify_vultr_account(id: i64) -> PlatformResult<Value> { cloud::vultr::verify_vultr_account(id).await.map_err(Into::into) }

#[tauri::command]
pub(crate) async fn verify_baidu_account(id: i64) -> PlatformResult<Value> { cloud::baidu::verify_baidu_account(id).await.map_err(Into::into) }
