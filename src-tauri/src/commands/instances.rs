use crate::{account_cloud_type, account_credentials, aliyun_rpc, array_at, ensure_aliyun_account, ensure_tencent_account, open_db, string_params, tencent_request};
use crate::cloud::jdcloud::jdcloud_instance_action;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

#[tauri::command]
pub(crate) async fn instance_status(id: i64, region_id: String, instance_id: String) -> Result<String, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let result = aliyun_rpc(&format!("ecs.{region_id}.aliyuncs.com"), "2014-05-26", "DescribeInstanceStatus", string_params(&[("RegionId", region_id), ("InstanceId.1", instance_id)]), &access_key_id, &access_key_secret).await?;
    Ok(array_at(&result, &["InstanceStatuses", "InstanceStatus"]).first().and_then(|item| item.get("Status")).and_then(Value::as_str).unwrap_or("Unknown").to_string())
}

#[tauri::command]
pub(crate) async fn reboot_instance(id: i64, region_id: String, instance_id: String, force_stop: bool) -> Result<String, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let result = aliyun_rpc(&format!("ecs.{region_id}.aliyuncs.com"), "2014-05-26", "RebootInstance", string_params(&[
        ("RegionId", region_id), ("InstanceId", instance_id), ("ForceStop", force_stop.to_string()),
    ]), &access_key_id, &access_key_secret).await?;
    Ok(result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}

#[tauri::command]
pub(crate) async fn start_instance(id: i64, region_id: String, instance_id: String) -> Result<String, String> {
    ensure_aliyun_account(id)?;
    if region_id.is_empty() || instance_id.is_empty() { return Err("缺少服务器地域或实例 ID".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let result = aliyun_rpc(&format!("ecs.{region_id}.aliyuncs.com"), "2014-05-26", "StartInstance", string_params(&[
        ("RegionId", region_id), ("InstanceId", instance_id),
    ]), &access_key_id, &access_key_secret).await?;
    Ok(result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}

#[tauri::command]
pub(crate) async fn stop_instance(id: i64, region_id: String, instance_id: String) -> Result<String, String> {
    ensure_aliyun_account(id)?;
    if region_id.is_empty() || instance_id.is_empty() { return Err("缺少服务器地域或实例 ID".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let result = aliyun_rpc(&format!("ecs.{region_id}.aliyuncs.com"), "2014-05-26", "StopInstance", string_params(&[
        ("RegionId", region_id), ("InstanceId", instance_id),
    ]), &access_key_id, &access_key_secret).await?;
    Ok(result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}

#[tauri::command]
pub(crate) async fn cvm_instance_reboot(id: i64, region_id: String, instance_id: String, force_stop: bool) -> Result<String, String> {
    ensure_tencent_account(id)?;
    if region_id.is_empty() || instance_id.is_empty() { return Err("缺少服务器地域或实例 ID".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let mut payload = json!({"InstanceIds": [instance_id]});
    if force_stop { payload["ForceStop"] = json!(true); }
    let result = tencent_request("cvm", "2017-03-12", "RebootInstances", payload, Some(&region_id), &access_key_id, &access_key_secret).await?;
    Ok(result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}

#[tauri::command]
pub(crate) async fn cvm_instance_action(id: i64, region_id: String, instance_id: String, action: String, force_stop: bool) -> Result<String, String> {
    ensure_tencent_account(id)?;
    if region_id.is_empty() || instance_id.is_empty() { return Err("缺少服务器地域或实例 ID".into()); }
    let action_name = match action.as_str() {
        "start" => "StartInstances",
        "stop" => "StopInstances",
        "reboot" => "RebootInstances",
        _ => return Err("不支持的腾讯云服务器操作".into()),
    };
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let mut payload = json!({"InstanceIds": [instance_id]});
    if force_stop && (action == "stop" || action == "reboot") { payload["ForceStop"] = json!(true); }
    let result = tencent_request("cvm", "2017-03-12", action_name, payload, Some(&region_id), &access_key_id, &access_key_secret).await?;
    Ok(result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}

fn update_cached_server_name(account_id: i64, instance_id: &str, instance_name: &str) -> Result<(), String> {
    let conn = open_db()?;
    let cached: Option<String> = conn.query_row(
        "SELECT payload_json FROM cloud_assets WHERE account_id=?1 AND resource_type='ecs' AND asset_key=?2",
        params![account_id, instance_id],
        |row| row.get(0),
    ).optional().map_err(|e| format!("读取本地服务器缓存失败: {e}"))?;
    if let Some(payload_json) = cached {
        let mut payload: Value = serde_json::from_str(&payload_json).map_err(|e| format!("解析本地服务器缓存失败: {e}"))?;
        let object = payload.as_object_mut().ok_or("本地服务器缓存格式无效")?;
        object.insert("InstanceName".into(), json!(instance_name));
        conn.execute(
            "UPDATE cloud_assets SET payload_json=?1 WHERE account_id=?2 AND resource_type='ecs' AND asset_key=?3",
            params![serde_json::to_string(&payload).map_err(|e| e.to_string())?, account_id, instance_id],
        ).map_err(|e| format!("更新本地服务器缓存失败: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn rename_server(id: i64, region_id: String, instance_id: String, instance_name: String) -> Result<String, String> {
    let instance_name = instance_name.trim().to_string();
    if region_id.trim().is_empty() || instance_id.trim().is_empty() { return Err("缺少服务器地域或实例 ID".into()); }
    if instance_name.is_empty() { return Err("服务器名称不能为空".into()); }
    if instance_name.as_bytes().len() > 128 { return Err("服务器名称不能超过 128 个字节".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let request_id = if account_cloud_type(id)? == "tencent" {
        let result = tencent_request(
            "cvm", "2017-03-12", "ModifyInstancesAttribute",
            json!({"InstanceIds": [instance_id.clone()], "InstanceName": instance_name.clone()}),
            Some(&region_id), &access_key_id, &access_key_secret,
        ).await?;
        result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string()
    } else {
        ensure_aliyun_account(id)?;
        let result = aliyun_rpc(&format!("ecs.{region_id}.aliyuncs.com"), "2014-05-26", "ModifyInstanceAttribute", string_params(&[
            ("RegionId", region_id), ("InstanceId", instance_id.clone()), ("InstanceName", instance_name.clone()),
        ]), &access_key_id, &access_key_secret).await?;
        result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string()
    };
    update_cached_server_name(id, &instance_id, &instance_name)?;
    Ok(request_id)
}

#[tauri::command]
pub(crate) async fn swas_instance_action(id: i64, region_id: String, instance_id: String, action: String, force_stop: bool) -> Result<String, String> {
    if region_id.is_empty() || instance_id.is_empty() { return Err("缺少轻量服务器地域或实例 ID".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let cloud_type = account_cloud_type(id)?;
    let result = if cloud_type == "aliyun" {
        let action_name = match action.as_str() { "start" => "StartInstance", "reboot" => "RebootInstance", "stop" => "StopInstance", _ => return Err("不支持的轻量服务器操作".into()) };
        let force_reboot = action == "reboot" && force_stop;
        let params = if force_reboot {
            string_params(&[("RegionId", region_id.clone()), ("InstanceIds", json!([instance_id]).to_string()), ("ForceReboot", "true".into())])
        } else {
            string_params(&[("RegionId", region_id.clone()), ("InstanceId", instance_id)])
        };
        aliyun_rpc(&format!("swas.{region_id}.aliyuncs.com"), "2020-06-01", if force_reboot { "RebootInstances" } else { action_name }, params, &access_key_id, &access_key_secret).await?
    } else if cloud_type == "tencent" {
        let action_name = match action.as_str() { "start" => "StartInstances", "reboot" => "RebootInstances", "stop" => "StopInstances", _ => return Err("不支持的轻量服务器操作".into()) };
        let mut payload = json!({"InstanceIds": [instance_id]});
        if action == "reboot" && force_stop { payload["ForceStop"] = json!(true); }
        tencent_request("lighthouse", "2020-03-24", action_name, payload, Some(&region_id), &access_key_id, &access_key_secret).await?
    } else if cloud_type == "jdcloud" {
        let action_name = match action.as_str() { "start" => "startInstance", "reboot" => "rebootInstance", "stop" => "stopInstance", _ => return Err("不支持的轻量服务器操作".into()) };
        jdcloud_instance_action(id, &region_id, &instance_id, action_name).await?
    } else { return Err("当前云类型暂不支持轻量服务器操作".into()); };
    Ok(result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}
