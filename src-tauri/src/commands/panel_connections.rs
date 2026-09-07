use crate::core::{repositories::panel_connections as panel_repository, storage::open_db};
use crate::core::error::PlatformResult;
use crate::{decrypt_secret, encrypt_secret, ExportPanelConnection, ImportPanelConnection, PanelConnection, PanelConnectionInput};
use chrono::Utc;
use md5::{Digest, Md5};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;

#[tauri::command]
pub(crate) fn list_panel_connections() -> PlatformResult<Vec<PanelConnection>> { panel_repository::list(&open_db()?).map_err(Into::into) }

#[tauri::command]
pub(crate) fn update_panel_connection_order(ids: Vec<i64>) -> PlatformResult<()> {
    let mut conn = open_db()?;
    Ok(panel_repository::update_order(&mut conn, &ids, chrono::Utc::now().timestamp_millis())?)
}

#[tauri::command]
pub(crate) fn delete_panel_connection(id: i64) -> PlatformResult<()> { panel_repository::delete(&open_db()?, id).map_err(Into::into) }

#[tauri::command]
pub(crate) fn update_panel_connection_remark(id: i64, remark: Option<String>) -> PlatformResult<PanelConnection> {
    let remark = remark.and_then(|value| (!value.trim().is_empty()).then(|| value.trim().to_string()));
    Ok(panel_repository::update_remark(&open_db()?, id, remark, chrono::Utc::now().timestamp_millis())?)
}

fn normalize_panel_url(value: &str) -> Result<String, String> {
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

async fn panel_api_request(panel_url: &str, api_key: &str, path: &str, allow_insecure_tls: bool) -> Result<Value, String> {
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

fn panel_summary(data: &Value) -> Value {
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

fn load_panel_connection(id: i64) -> Result<(PanelConnection, String), String> {
    let (panel, ciphertext) = panel_repository::load_with_secret(&open_db()?, id)?;
    Ok((panel, decrypt_secret(&ciphertext)?))
}

#[tauri::command]
pub(crate) async fn save_panel_connection(input: PanelConnectionInput) -> PlatformResult<PanelConnection> {
    let name = input.name.trim(); let panel_url = normalize_panel_url(&input.panel_url)?;
    if name.is_empty() { return Err("请填写面板名称".into()); }
    let existing = input.id.map(|id| panel_repository::existing_api_key(&open_db()?, id)).transpose()?.flatten();
    let api_key_ciphertext = match input.api_key.as_deref().map(str::trim).filter(|value| !value.is_empty()) { Some(key) => encrypt_secret(key)?, None => existing.ok_or_else(|| "首次绑定需要填写面板 API 密钥".to_string())? };
    let api_key = decrypt_secret(&api_key_ciphertext)?;
    let data = panel_api_request(&panel_url, &api_key, "/system?action=GetNetWork", input.allow_insecure_tls).await?;
    let summary = panel_summary(&data); let now = Utc::now().timestamp_millis(); let conn = open_db()?;
    Ok(panel_repository::save(&conn, &input, name, &panel_url, &api_key_ciphertext, &serde_json::to_string(&summary).map_err(|e| e.to_string())?, now)?)
}

#[tauri::command]
pub(crate) async fn refresh_panel_connection(id: i64) -> PlatformResult<PanelConnection> {
    let (panel, api_key) = load_panel_connection(id)?; let now = Utc::now().timestamp_millis(); let result = panel_api_request(&panel.panel_url, &api_key, "/system?action=GetNetWork", panel.allow_insecure_tls).await;
    let conn = open_db()?;
    match result { Ok(data) => {
            panel_repository::mark_refresh_success(&conn, id, &serde_json::to_string(&panel_summary(&data)).map_err(|e| e.to_string())?, now)?;
        }
        Err(error) => { panel_repository::mark_refresh_failure(&conn, id, &error, now)?; }
    }
    Ok(panel_repository::get(&conn, id)?)
}

#[tauri::command]
pub(crate) async fn panel_temporary_login(id: i64) -> PlatformResult<String> {
    let (panel, api_key) = load_panel_connection(id)?; let data = panel_api_request(&panel.panel_url, &api_key, "/config?action=get_tmp_token", panel.allow_insecure_tls).await?;
    let token = data.get("msg").or_else(|| data.get("token")).and_then(Value::as_str).filter(|value| !value.is_empty()).ok_or("面板未返回临时登录令牌")?;
    Ok(format!("{}/login?tmp_token={}", panel.panel_url, token))
}

#[tauri::command]
pub(crate) fn export_panel_connections_file(panel_ids: Option<Vec<i64>>) -> PlatformResult<String> {
    let conn = open_db()?;
    let selected_ids = panel_ids.filter(|ids| !ids.is_empty());
    let rows = panel_repository::export_rows(&conn)?;
    let mut panels = Vec::new();
    for row in rows {
        if selected_ids.as_ref().is_some_and(|ids| !ids.contains(&row.id)) { continue; }
        panels.push(ExportPanelConnection { name: row.name, panel_url: row.panel_url, sort_order: row.sort_order, api_key: decrypt_secret(&row.ciphertext)?, allow_insecure_tls: row.allow_insecure_tls, group_name: row.group_name, source_account_id: row.source_account_id, source_asset_key: row.source_asset_key, remark: row.remark });
    }
    if panels.is_empty() { return Err("未找到选择的面板".into()); }
    let base = dirs::home_dir().unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let desktop = base.join("Desktop");
    let dir = if desktop.exists() { desktop } else { base };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("cloudhub-tools-panels-{}.json", Utc::now().format("%Y%m%d-%H%M%S")));
    let payload = json!({
        "format": "cloudhub-tools-panel-export",
        "version": 1,
        "encryption": "plaintext",
        "api_key_exported": true,
        "exported_at": Utc::now().to_rfc3339(),
        "panels": panels,
    });
    std::fs::write(&path, serde_json::to_vec_pretty(&payload).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub(crate) fn import_panel_connections(panels: Vec<ImportPanelConnection>) -> PlatformResult<usize> {
    if panels.is_empty() { return Err("导入文件中没有面板配置".into()); }
    let conn = open_db()?;
    let now = Utc::now().timestamp_millis();
    let mut imported = 0usize;
    for (index, panel) in panels.into_iter().enumerate() {
        let name = panel.name.trim();
        let panel_url = normalize_panel_url(&panel.panel_url)?;
        if name.is_empty() || panel.api_key.trim().is_empty() { return Err(format!("第 {} 条面板缺少名称或 API 密钥", index + 1).into()); }
        let ciphertext = encrypt_secret(panel.api_key.trim())?;
        let existing_id = panel_repository::id_by_url(&conn, &panel_url)?;
        match existing_id {
            Some(id) => panel_repository::import_update(&conn, id, name, &ciphertext, panel.sort_order.unwrap_or(0).max(0), panel.allow_insecure_tls.unwrap_or(false), panel.group_name.as_deref(), panel.source_account_id, panel.source_asset_key.as_deref(), panel.remark.as_deref(), now)?,
            None => panel_repository::import_insert(&conn, name, &panel_url, &ciphertext, panel.sort_order.unwrap_or(0).max(0), panel.allow_insecure_tls.unwrap_or(false), panel.group_name.as_deref(), panel.source_account_id, panel.source_asset_key.as_deref(), panel.remark.as_deref(), now)?,
        };
        imported += 1;
    }
    Ok(imported)
}
