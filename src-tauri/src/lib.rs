use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use hmac::{Hmac, Mac};
use md5::Md5;
use sha2::{Digest, Sha256};
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};

mod core;
use core::storage::{data_dir, decrypt_secret, encrypt_secret, open_db};
mod commands;
mod models;
pub(crate) use commands::accounts::{delete_account, export_accounts, export_accounts_file, import_accounts, list_accounts, save_account};
pub(crate) use commands::{
    assets::{delete_local_asset, list_local_assets},
    cloud_assets::{list_cloud_resources, sync_cloud_assets},
    logs::{clear_api_logs, clear_operation_logs, list_api_logs},
    managed_hosts::{delete_managed_host, export_managed_hosts_file, import_managed_hosts, list_managed_hosts, save_managed_host},
    panels::{delete_panel_connection, export_panel_connections_file, import_panel_connections, list_panel_connections, panel_temporary_login, refresh_panel_connection, save_panel_connection, update_panel_connection_order, update_panel_connection_remark},
    preferences::{list_client_preferences, save_client_preference},
    resource_details::{get_oss_acl, list_instance_disks, list_oss_objects, list_rds_accounts, list_rds_databases, list_redis_accounts, set_oss_cors, set_oss_public_read},
    resource_overview::{cloud_account_summary, esa_overview},
    ssh_connection::{authenticate_ssh, delete_rdp_connection, delete_ssh_connection, get_rdp_connection, get_ssh_connection, launch_managed_host_rdp, launch_rdp_connection, probe_managed_host, reveal_rdp_password, reveal_ssh_password, ssh_connect, ssh_test_connection, SshCommand, SshConnectionProfile, SshHostKeyHandler, SshTerminalStore},
    ssh_files::{ssh_delete_path, ssh_disconnect, ssh_download_file, ssh_list_files, ssh_make_directory, ssh_read, ssh_read_text_file, ssh_resize, ssh_upload_file, ssh_write, ssh_write_text_file},
    system::{app_data_path, open_app_data_directory},
};
pub(crate) use models::accounts::{AccountInput, CloudAccount, ExportAccount, ImportAccount};
pub(crate) use models::remote_access::{ExportManagedHost, ExportPanelConnection, ImportManagedHost, ImportPanelConnection, ManagedHost, ManagedHostInput, PanelConnection, PanelConnectionInput, RdpConnectionInput, SavedRdpConnection, SavedSshConnection, SshConnectInput, SshConnectResult, SshDirectoryListing, SshFileEntry};
pub(crate) use models::resources::{AssetSyncResult, LocalAsset, ResourceResponse};
mod cloud;
pub(crate) use cloud::oracle::serialize_oci_private_key;
pub(crate) use cloud::tencent::tencent_request;
use cloud::{aliyun::resource_items as aliyun_resource_items, ctyun::resource_items as ctyun_resource_items, huawei::resource_items as cloud_huawei_resource_items, tencent::resource_items as tencent_resource_items, volcengine::resource_items as volc_resource_items, vultr::*};
pub(crate) use cloud::aliyun::aliyun_rpc;

pub(crate) fn write_api_log(access_key_id: &str, endpoint: &str, action: &str, request_params: &Value, response: Option<&Value>, status: &str, message: Option<&str>) {
    if let Ok(conn) = open_db() {
        let account_id: Option<i64> = conn.query_row("SELECT id FROM cloud_accounts WHERE access_key_id=?1", [access_key_id], |row| row.get(0)).optional().ok().flatten();
        let _ = conn.execute("INSERT INTO api_logs(account_id,endpoint,action,request_params,response_params,status,message,created_at) VALUES(?,?,?,?,?,?,?,?)", params![account_id, endpoint, action, serde_json::to_string(request_params).unwrap_or_default(), response.map(|value| serde_json::to_string(value).unwrap_or_default()), status, message, Utc::now().timestamp_millis()]);
    }
}

pub(crate) fn account_credentials(id: i64) -> Result<(String, String), String> {
    let conn = open_db()?;
    let row: (String, String, i64) = conn.query_row(
        "SELECT access_key_id, secret_ciphertext, enabled FROM cloud_accounts WHERE id=?1",
        [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| format!("读取云账号失败: {e}"))?;
    if row.2 != 1 { return Err("云账号已停用".into()); }
    // Cloud access-key secrets cannot contain meaningful leading/trailing whitespace.
    // Tolerate accidental whitespace from a pasted credential without rewriting it.
    Ok((row.0, decrypt_secret(&row.1)?.trim().to_string()))
}

pub(crate) fn ensure_aliyun_account(id: i64) -> Result<(), String> {
    let conn = open_db()?;
    let cloud_type: String = conn.query_row("SELECT cloud_type FROM cloud_accounts WHERE id=?1", [id], |row| row.get(0))
        .map_err(|e| format!("读取云账号失败: {e}"))?;
    if cloud_type != "aliyun" {
        return Err(format!("{}资源 API 尚未接入", if cloud_type == "tencent" { "腾讯云" } else { "当前云类型" }));
    }
    Ok(())
}

pub(crate) fn account_cloud_type(id: i64) -> Result<String, String> {
    open_db()?.query_row("SELECT cloud_type FROM cloud_accounts WHERE id=?1", [id], |row| row.get(0))
        .map_err(|e| format!("读取云账号失败: {e}"))
}

pub(crate) fn account_region_id(id: i64) -> Result<String, String> {
    open_db()?.query_row("SELECT region_id FROM cloud_accounts WHERE id=?1", [id], |row| row.get::<_, Option<String>>(0))
        .map(|region| region.filter(|value| !value.is_empty()).unwrap_or_else(|| "ap-guangzhou".into()))
        .map_err(|e| format!("读取云账号失败: {e}"))
}

pub(crate) fn volc_region_id(id: i64) -> Result<String, String> {
    open_db()?.query_row("SELECT region_id FROM cloud_accounts WHERE id=?1", [id], |row| row.get::<_, Option<String>>(0))
        .map(|region| region.filter(|value| !value.is_empty()).unwrap_or_else(|| "cn-beijing".into()))
        .map_err(|e| format!("读取云账号失败: {e}"))
}

pub(crate) fn ensure_tencent_account(id: i64) -> Result<(), String> {
    let cloud_type = account_cloud_type(id)?;
    if cloud_type != "tencent" { return Err("当前账号不是腾讯云账号".into()); }
    Ok(())
}

#[tauri::command]
fn reveal_account_secret(id: i64) -> Result<String, String> {
    let conn = open_db()?;
    let ciphertext: String = conn.query_row("SELECT secret_ciphertext FROM cloud_accounts WHERE id=?1", [id], |row| row.get(0))
        .map_err(|e| format!("读取账号 Secret 失败: {e}"))?;
    decrypt_secret(&ciphertext)
}

// Aliyun RPC uses RFC3986 encoding: only ALPHA / DIGIT / - . _ ~ remain unescaped.
const RPC_ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

pub(crate) fn rpc_encode(value: &str) -> String {
    utf8_percent_encode(value, RPC_ENCODE_SET).to_string()
}

pub(crate) fn configured_regions(id: i64, fallback: &str) -> Result<Vec<String>, String> {
    let value: Option<String> = open_db()?.query_row("SELECT region_id FROM cloud_accounts WHERE id=?1", [id], |row| row.get(0)).map_err(|error| error.to_string())?;
    let mut regions = value.unwrap_or_else(|| fallback.into()).split(|character: char| character == ',' || character == '，' || character.is_whitespace()).filter(|value| !value.is_empty()).map(String::from).collect::<Vec<_>>();
    if regions.is_empty() { regions.push(fallback.into()); } regions.sort(); regions.dedup(); Ok(regions)
}

pub(crate) fn aws_sign(key: &[u8], value: &str) -> Result<Vec<u8>, String> {
    let mut mac: Hmac<Sha256> = <Hmac<Sha256> as Mac>::new_from_slice(key).map_err(|error| error.to_string())?;
    mac.update(value.as_bytes()); Ok(mac.finalize().into_bytes().to_vec())
}

pub(crate) fn aws_query(query: &BTreeMap<String, String>) -> String {
    query.iter().map(|(key, value)| (rpc_encode(key), rpc_encode(value))).collect::<Vec<_>>().into_iter().map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>().join("&")
}

pub(crate) fn string_params(entries: &[(&str, String)]) -> BTreeMap<String, String> {
    entries.iter().map(|(key, value)| ((*key).to_string(), value.clone())).collect()
}

pub(crate) fn array_at<'a>(value: &'a Value, path: &[&str]) -> Vec<&'a Value> {
    let mut current = value;
    for key in path { current = match current.get(*key) { Some(value) => value, None => return vec![] }; }
    match current { Value::Array(items) => items.iter().collect(), Value::Object(_) => vec![current], _ => vec![] }
}

pub(crate) fn value_first_string(value: Option<&Value>) -> Value {
    value.and_then(Value::as_array)
        .and_then(|items| items.first())
        .cloned()
        .or_else(|| value.cloned())
        .unwrap_or(json!(""))
}

pub(crate) fn xml_text(body: &str, tag: &str) -> String {
    let open = format!("<{tag}>"); let close = format!("</{tag}>");
    body.find(&open).and_then(|start| body[start + open.len()..].find(&close).map(|end| body[start + open.len()..start + open.len() + end].to_string())).unwrap_or_default()
}

pub(crate) fn xml_blocks(body: &str, tag: &str) -> Vec<String> {
    let open = format!("<{tag}>"); let close = format!("</{tag}>"); let mut values = Vec::new(); let mut rest = body;
    while let Some(start) = rest.find(&open) { let chunk = &rest[start + open.len()..]; let Some(end) = chunk.find(&close) else { break }; values.push(chunk[..end].to_string()); rest = &chunk[end + close.len()..]; }
    values
}


pub(crate) async fn fetch_cloud_resources(id: i64, resource_type: &str) -> Result<ResourceResponse, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    Ok(match account_cloud_type(id)?.as_str() {
        "aliyun" => aliyun_resource_items(resource_type, &access_key_id, &access_key_secret).await,
        "tencent" => tencent_resource_items(id, resource_type, &access_key_id, &access_key_secret).await,
        "volcengine" => volc_resource_items(id, resource_type, &access_key_id, &access_key_secret).await,
        "ctyun" => ctyun_resource_items(id, resource_type, &access_key_id, &access_key_secret).await,
        "huawei" => cloud_huawei_resource_items(id, resource_type).await,
        "baidu" => cloud::baidu::resource_items(id, resource_type).await,
        "ucloud" => cloud::ucloud::resource_items(id, resource_type).await,
        "qiniu" => cloud::qiniu::resource_items(id, resource_type).await,
        "aws" => cloud::aws::resource_items(id, resource_type).await,
        "azure" => cloud::azure::resource_items(id, resource_type).await,
        "gcp" => cloud::gcp::resource_items(id, resource_type).await,
        "jdcloud" => cloud::jdcloud::resource_items(id, resource_type).await,
        "qingcloud" => cloud::qingcloud::resource_items(id, resource_type).await,
        "ksyun" => cloud::ksyun::resource_items(id, resource_type).await,
        "oracle" => cloud::oracle::resource_items(id, resource_type).await,
        "vultr" => vultr_resource_items(id, resource_type).await,
        _ => return Err("当前云类型资源 API 尚未接入".into()),
    })
}

pub(crate) fn row_managed_host(row: &rusqlite::Row<'_>) -> rusqlite::Result<ManagedHost> {
    let metrics: String = row.get(17)?;
    Ok(ManagedHost {
        id: row.get(0)?, name: row.get(1)?, host: row.get(2)?, port: row.get(3)?, username: row.get(4)?,
        platform: row.get(5)?, auth_method: row.get(6)?, group_name: row.get(7)?, tags: row.get(8)?, source_account_id: row.get(9)?, source_asset_key: row.get(10)?,
        password_saved: row.get::<_, Option<String>>(11)?.is_some_and(|value| !value.is_empty()), private_key_saved: row.get::<_, Option<String>>(12)?.is_some_and(|value| !value.is_empty()), host_key_fingerprint: row.get(14)?, status: row.get(15)?,
        last_latency_ms: row.get(16)?, metrics: serde_json::from_str(&metrics).unwrap_or_else(|_| json!({})), last_checked_at: row.get(18)?,
        last_error: row.get(19)?, remark: row.get(20)?, created_at: row.get(21)?, updated_at: row.get(22)?,
    })
}

pub(crate) const MANAGED_HOST_SELECT: &str = "SELECT id,name,host,port,username,platform,auth_method,group_name,tags,source_account_id,source_asset_key,password_ciphertext,private_key_ciphertext,key_passphrase_ciphertext,host_key_fingerprint,status,last_latency_ms,metrics_json,last_checked_at,last_error,remark,created_at,updated_at FROM managed_hosts";

pub(crate) fn row_panel_connection(row: &rusqlite::Row<'_>) -> rusqlite::Result<PanelConnection> {
    let summary: String = row.get(10)?;
    Ok(PanelConnection {
        id: row.get(0)?, name: row.get(1)?, panel_url: row.get(2)?, sort_order: row.get(3)?, allow_insecure_tls: row.get::<_, i64>(4)? == 1, group_name: row.get(5)?, source_account_id: row.get(6)?, source_asset_key: row.get(7)?,
        api_key_saved: row.get::<_, Option<String>>(8)?.is_some(), status: row.get(9)?, summary: serde_json::from_str(&summary).unwrap_or_else(|_| json!({})),
        last_checked_at: row.get(11)?, last_error: row.get(12)?, remark: row.get(13)?, created_at: row.get(14)?, updated_at: row.get(15)?,
    })
}

pub(crate) fn normalize_panel_url(value: &str) -> Result<String, String> {
    let url = value.trim().trim_end_matches('/');
    if !(url.starts_with("http://") || url.starts_with("https://")) { return Err("面板 URL 必须以 http:// 或 https:// 开头".into()); }
    let host = &url[url.find("://").unwrap_or(0) + 3..];
    if host.is_empty() || host.contains('/') || host.contains('?') || host.contains('#') { return Err("请填写面板根地址，例如 https://192.168.1.2:8888".into()); }
    Ok(url.to_string())
}

fn panel_sign(api_key: &str) -> (String, String) {
    let request_time = Utc::now().timestamp().to_string();
    let api_key_md5 = format!("{:x}", Md5::digest(api_key.as_bytes()));
    let request_token = format!("{:x}", Md5::digest(format!("{request_time}{api_key_md5}").as_bytes()));
    (request_time, request_token)
}

pub(crate) async fn panel_api_request(panel_url: &str, api_key: &str, path: &str, allow_insecure_tls: bool) -> Result<Value, String> {
    let (request_time, request_token) = panel_sign(api_key);
    let mut data = BTreeMap::new(); data.insert("request_time", request_time); data.insert("request_token", request_token);
    let client = reqwest::Client::builder().danger_accept_invalid_certs(allow_insecure_tls).build().map_err(|error| format!("创建面板客户端失败: {error}"))?;
    let response = client.post(format!("{panel_url}{path}")).form(&data).timeout(std::time::Duration::from_secs(12)).send().await
        .map_err(|error| if !allow_insecure_tls && error.to_string().to_lowercase().contains("certificate") { "连接面板失败：HTTPS 证书不受信任。若这是确认可信的自签名面板，请勾选“允许不受信任 HTTPS 证书”后重试。".to_string() } else { format!("连接面板失败: {error}") })?;
    let status = response.status(); let text = response.text().await.map_err(|error| format!("读取面板响应失败: {error}"))?;
    let data: Value = serde_json::from_str(&text).map_err(|_| if status.is_success() { "面板未返回 JSON；请确认 URL、API 密钥及 API IP 白名单".to_string() } else { format!("面板请求失败：HTTP {status}") })?;
    if !status.is_success() || data.get("status").and_then(Value::as_bool) == Some(false) {
        return Err(data.get("msg").or_else(|| data.get("message")).and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("面板请求失败：HTTP {status}")));
    }
    Ok(data)
}

fn panel_field<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| value.get(*key))
}

fn panel_number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => {
            let mut token = String::new();
            let mut started = false;
            for character in text.chars() {
                if character.is_ascii_digit() || character == '.' || (character == '-' && !started) {
                    token.push(character);
                    started = true;
                } else if started {
                    break;
                }
            }
            token.parse().ok()
        }
        _ => None,
    }
}

pub(crate) fn panel_summary(data: &Value) -> Value {
    let load = data.get("load").or_else(|| data.get("load_average"));
    let load_value = |name: &str, index: usize| match load {
        Some(Value::Object(_)) => panel_number(load.and_then(|value| value.get(name))),
        Some(Value::Array(values)) => panel_number(values.get(index)),
        _ => None,
    };

    let cpu = data.get("cpu");
    let cpu_value = |keys: &[&str], index: usize| match cpu {
        Some(Value::Object(_)) => panel_number(cpu.and_then(|value| panel_field(value, keys))),
        Some(Value::Array(values)) => panel_number(values.get(index)),
        _ => None,
    };

    let memory = data.get("mem").or_else(|| data.get("memory"));
    let memory_used = memory.and_then(|value| panel_number(panel_field(value, &["memRealUsed", "used", "realUsed", "used_mb"])));
    let memory_total = memory.and_then(|value| panel_number(panel_field(value, &["memTotal", "total", "total_mb"])));
    let memory_percent = match (memory_used, memory_total) {
        (Some(used), Some(total)) if total > 0.0 => Some((used / total * 100.0).clamp(0.0, 100.0)),
        _ => None,
    };

    let disks = data.get("disk").and_then(Value::as_array).map(|items| items.iter().map(|item| {
        let disk_size = item.get("size").and_then(Value::as_array);
        let used = panel_field(item, &["used", "use"]).cloned().or_else(|| disk_size.and_then(|size| size.get(1).cloned()));
        let total = panel_field(item, &["total", "size_total"]).cloned().or_else(|| disk_size.and_then(|size| size.first().cloned()));
        let percent = panel_number(panel_field(item, &["used_percent", "percent", "usage"])).or_else(|| disk_size.and_then(|size| panel_number(size.get(3))));
        json!({
            "path": panel_field(item, &["path", "rname", "mount"]).cloned().unwrap_or(json!("")),
            "used": used,
            "total": total,
            "used_percent": percent
        })
    }).collect::<Vec<_>>()).unwrap_or_default();
    let disk = disks.iter().find(|item| item.get("path").and_then(Value::as_str) == Some("/")).cloned().or_else(|| disks.first().cloned()).unwrap_or(json!({}));

    let network = data.get("network");
    let network_up = panel_number(data.get("up")).or_else(|| network.and_then(|value| panel_number(panel_field(value, &["up", "upload"]))));
    let network_down = panel_number(data.get("down")).or_else(|| network.and_then(|value| panel_number(panel_field(value, &["down", "download"]))));

    json!({
        "title": data.get("title").or_else(|| data.get("hostname")).cloned().unwrap_or(json!("")),
        "version": data.get("version").or_else(|| data.get("panel_version")).cloned().unwrap_or(json!("")),
        "load": { "one": load_value("one", 0), "five": load_value("five", 1), "fifteen": load_value("fifteen", 2) },
        "network": { "up": network_up, "down": network_down, "unit": "KB/s" },
        "cpu": { "used_percent": cpu_value(&["used_percent", "usage", "used", "cpuRealUsed"], 0), "cores": cpu_value(&["cores", "cpuNum", "count"], 1) },
        "mem": { "used": memory_used, "total": memory_total, "used_percent": memory_percent, "unit": "MB" },
        "disk": {
            "path": disk.get("path").cloned().unwrap_or(json!("")),
            "used": disk.get("used").cloned(),
            "total": disk.get("total").cloned(),
            "used_percent": disk.get("used_percent").cloned(),
            "volumes": disks
        }
    })
}

pub(crate) fn load_panel_connection(id: i64) -> Result<(PanelConnection, String), String> {
    let conn = open_db()?;
    let row: (PanelConnection, String) = conn.query_row("SELECT id,name,panel_url,sort_order,allow_insecure_tls,group_name,source_account_id,source_asset_key,api_key_ciphertext,status,summary_json,last_checked_at,last_error,remark,created_at,updated_at,api_key_ciphertext FROM panel_connections WHERE id=?1", [id], |row| Ok((row_panel_connection(row)?, row.get(16)?))).map_err(|_| "面板不存在".to_string())?;
    Ok((row.0, decrypt_secret(&row.1)?))
}

pub(crate) fn display_json(value: &Value) -> String { match value { Value::String(v) => v.clone(), Value::Null => "-".into(), _ => value.to_string() } }

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SshTerminalStore { terminals: Mutex::new(HashMap::new()) })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![list_accounts, save_account, delete_account, app_data_path, open_app_data_directory, list_client_preferences, save_client_preference, reveal_account_secret, cloud_account_summary, list_cloud_resources, sync_cloud_assets, cloud::vultr::verify_vultr_account, cloud::ctyun::verify_account, cloud::huawei::verify_huawei_account, cloud::baidu::verify_baidu_account, cloud::ucloud::verify_ucloud_account, cloud::qiniu::verify_qiniu_account, cloud::aws::verify_aws_account, cloud::azure::verify_azure_account, cloud::gcp::verify_gcp_account, cloud::jdcloud::verify_jdcloud_account, cloud::qingcloud::verify_qingcloud_account, cloud::ksyun::verify_ksyun_account, esa_overview, list_local_assets, delete_local_asset, list_managed_hosts, save_managed_host, delete_managed_host, probe_managed_host, export_managed_hosts_file, import_managed_hosts, list_panel_connections, update_panel_connection_order, save_panel_connection, refresh_panel_connection, panel_temporary_login, delete_panel_connection, update_panel_connection_remark, export_panel_connections_file, import_panel_connections, list_api_logs, clear_api_logs, clear_operation_logs, list_instance_disks, commands::security_groups::list_aliyun_security_groups, commands::security_groups::authorize_aliyun_security_group_rule, commands::security_groups::revoke_aliyun_security_group_rule, commands::security_groups::list_tencent_security_groups, commands::security_groups::authorize_tencent_security_group_rule, commands::security_groups::revoke_tencent_security_group_rule, commands::security_groups::list_baidu_security_groups, commands::security_groups::authorize_baidu_security_group_rule, commands::security_groups::revoke_baidu_security_group_rule, commands::light_firewall::list_light_firewall_rules, commands::light_firewall::create_light_firewall_rule, commands::light_firewall::delete_light_firewall_rule, cloud::vultr::list_vultr_firewall_rules, cloud::vultr::create_vultr_firewall_rule, cloud::vultr::delete_vultr_firewall_rule, commands::instances::instance_status, commands::instances::reboot_instance, commands::instances::start_instance, commands::instances::stop_instance, cloud::vultr::vultr_instance_action, cloud::vultr::vultr_instance_manage, cloud::oracle::oracle_instance_action, commands::instances::cvm_instance_reboot, commands::instances::cvm_instance_action, cloud::baidu::instance_action, commands::instances::rename_server, commands::instances::swas_instance_action, commands::domains::list_dns_records, commands::domains::add_dns_record, commands::domains::update_dns_record, commands::domains::delete_dns_record, commands::domains::toggle_dns_record, commands::domains::list_domain_logs, commands::domains::query_whois, list_rds_databases, list_rds_accounts, list_redis_accounts, list_oss_objects, get_oss_acl, set_oss_public_read, set_oss_cors, get_ssh_connection, reveal_ssh_password, delete_ssh_connection, get_rdp_connection, reveal_rdp_password, delete_rdp_connection, launch_rdp_connection, launch_managed_host_rdp, ssh_connect, ssh_test_connection, ssh_list_files, ssh_read_text_file, ssh_write_text_file, ssh_upload_file, ssh_download_file, ssh_make_directory, ssh_delete_path, ssh_read, ssh_write, ssh_resize, ssh_disconnect, export_accounts, export_accounts_file, import_accounts])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
