use crate::{account_cloud_type, account_credentials, aliyun_rpc, array_at, ensure_aliyun_account, string_params, tencent_request, xml_text};
use crate::cloud::{aliyun::{oss_get_acl, oss_list_objects, oss_set_cors, oss_set_public_read}, oracle::oracle_instance_disks, tencent::{cos_list_objects, cos_request}};
use serde_json::{json, Value};

#[tauri::command]
pub(crate) async fn list_instance_disks(id: i64, region_id: String, instance_id: String, compartment_ocid: Option<String>) -> Result<Vec<Value>, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    if account_cloud_type(id)? == "oracle" {
        return oracle_instance_disks(id, &region_id, &instance_id, compartment_ocid.as_deref().unwrap_or("")).await;
    }
    if account_cloud_type(id)? == "tencent" {
        let result = tencent_request("cbs", "2017-03-12", "DescribeDisks", json!({"InstanceId": instance_id}), Some(&region_id), &access_key_id, &access_key_secret).await?;
        return Ok(array_at(&result, &["DiskSet"]).into_iter().map(|disk| json!({
            "DiskId": disk.get("DiskId").cloned().unwrap_or(json!("")),
            "DiskName": disk.get("DiskName").or_else(|| disk.get("DiskId")).cloned().unwrap_or(json!("")),
            "Category": disk.get("DiskType").cloned().unwrap_or(json!("")),
            "Size": disk.get("DiskSize").cloned().unwrap_or(json!(0)),
            "Status": disk.get("DiskState").cloned().unwrap_or(json!("")),
        })).collect());
    }
    ensure_aliyun_account(id)?;
    let result = aliyun_rpc(&format!("ecs.{region_id}.aliyuncs.com"), "2014-05-26", "DescribeDisks", string_params(&[("RegionId", region_id), ("InstanceId", instance_id)]), &access_key_id, &access_key_secret).await?;
    Ok(array_at(&result, &["Disks", "Disk"]).into_iter().cloned().collect())
}

#[tauri::command]
pub(crate) async fn list_rds_databases(id: i64, region_id: String, instance_id: String) -> Result<Vec<Value>, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    if account_cloud_type(id)? == "tencent" {
        let data = tencent_request("cdb", "2017-03-20", "DescribeDatabases", json!({"InstanceId": instance_id}), Some(&region_id), &access_key_id, &access_key_secret).await?;
        return Ok(array_at(&data, &["Items"]).into_iter().map(|item| {
            let mut value = (*item).clone();
            if let Value::Object(ref mut target) = value {
                target.insert("DBName".into(), item.get("DatabaseName").or_else(|| item.get("DBName")).cloned().unwrap_or(json!("")));
            }
            value
        }).collect());
    }
    let result = aliyun_rpc("rds.aliyuncs.com", "2014-08-15", "DescribeDatabases", string_params(&[("RegionId", region_id), ("DBInstanceId", instance_id)]), &access_key_id, &access_key_secret).await?;
    Ok(array_at(&result, &["Databases", "Database"]).into_iter().cloned().collect())
}

#[tauri::command]
pub(crate) async fn list_rds_accounts(id: i64, region_id: String, instance_id: String) -> Result<Vec<Value>, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    if account_cloud_type(id)? == "tencent" {
        let data = tencent_request("cdb", "2017-03-20", "DescribeAccounts", json!({"InstanceId": instance_id}), Some(&region_id), &access_key_id, &access_key_secret).await?;
        return Ok(array_at(&data, &["Items"]).into_iter().map(|item| json!({"AccountName": item.get("AccountName").or_else(|| item.get("UserName")).cloned().unwrap_or(json!("")), "AccountType": item.get("AccountType").cloned().unwrap_or(json!("Normal")), "AccountStatus": item.get("Status").cloned().unwrap_or(json!("Available")), "AccountDescription": item.get("Description").cloned().unwrap_or(json!(""))})).collect());
    }
    let result = aliyun_rpc("rds.aliyuncs.com", "2014-08-15", "DescribeAccounts", string_params(&[("RegionId", region_id), ("DBInstanceId", instance_id)]), &access_key_id, &access_key_secret).await?;
    Ok(array_at(&result, &["Accounts", "DBInstanceAccount"]).into_iter().cloned().collect())
}

#[tauri::command]
pub(crate) async fn list_redis_accounts(id: i64, instance_id: String, region_id: String) -> Result<Vec<Value>, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    if account_cloud_type(id)? == "tencent" {
        let data = tencent_request("redis", "2018-04-12", "DescribeInstanceAccount", json!({"InstanceId": instance_id}), Some(&region_id), &access_key_id, &access_key_secret).await?;
        return Ok(array_at(&data, &["Accounts"]).into_iter().map(|item| json!({"AccountName": item.get("AccountName").or_else(|| item.get("UserName")).cloned().unwrap_or(json!("")), "AccountType": item.get("AccountType").cloned().unwrap_or(json!("Normal")), "AccountStatus": item.get("Status").cloned().unwrap_or(json!("Available")), "AccountDescription": item.get("Description").cloned().unwrap_or(json!(""))})).collect());
    }
    let result = aliyun_rpc("r-kvstore.aliyuncs.com", "2015-01-01", "DescribeAccounts", string_params(&[("InstanceId", instance_id), ("RegionId", region_id)]), &access_key_id, &access_key_secret).await?;
    Ok(array_at(&result, &["Accounts", "Account"]).into_iter().cloned().collect())
}

#[tauri::command]
pub(crate) async fn list_oss_objects(id: i64, bucket: String, location: String, prefix: String, marker: String) -> Result<Value, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    if account_cloud_type(id)? == "tencent" {
        return cos_list_objects(&bucket, &location, &access_key_id, &access_key_secret, &prefix, &marker).await;
    }
    oss_list_objects(&bucket, &location, &access_key_id, &access_key_secret, &prefix, &marker).await
}

#[tauri::command]
pub(crate) async fn get_oss_acl(id: i64, bucket: String, location: String) -> Result<String, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    if account_cloud_type(id)? == "tencent" {
        let body = cos_request(&bucket, &location, "acl", &access_key_id, &access_key_secret).await?;
        return Ok(xml_text(&body, "Permission"));
    }
    oss_get_acl(&bucket, &location, &access_key_id, &access_key_secret).await
}

#[tauri::command]
pub(crate) async fn set_oss_cors(id: i64, bucket: String, location: String, origins: String) -> Result<(), String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    oss_set_cors(&bucket, &location, &origins, &access_key_id, &access_key_secret).await
}

#[tauri::command]
pub(crate) async fn set_oss_public_read(id: i64, bucket: String, location: String) -> Result<(), String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    oss_set_public_read(&bucket, &location, &access_key_id, &access_key_secret).await
}
