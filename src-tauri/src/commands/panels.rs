use crate::{
    decrypt_secret, encrypt_secret, load_panel_connection, normalize_panel_url, open_db,
    panel_api_request, panel_summary, row_panel_connection, ExportPanelConnection,
    ImportPanelConnection, PanelConnection, PanelConnectionInput,
};
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::path::PathBuf;

#[tauri::command]
pub(crate) fn list_panel_connections() -> Result<Vec<PanelConnection>, String> {
    let conn = open_db()?;
    let mut stmt = conn.prepare("SELECT id,name,panel_url,sort_order,allow_insecure_tls,group_name,source_account_id,source_asset_key,api_key_ciphertext,status,summary_json,last_checked_at,last_error,remark,created_at,updated_at FROM panel_connections ORDER BY sort_order ASC, name COLLATE NOCASE").map_err(|e| e.to_string())?;
    let panels = stmt.query_map([], row_panel_connection).map_err(|e| e.to_string())?.map(|row| row.map_err(|e| e.to_string())).collect();
    panels
}

#[tauri::command]
pub(crate) fn update_panel_connection_order(ids: Vec<i64>) -> Result<(), String> {
    let conn = open_db()?;
    let transaction = conn.unchecked_transaction().map_err(|e| format!("更新面板排序失败: {e}"))?;
    let now = Utc::now().timestamp_millis();
    for (sort_order, id) in ids.into_iter().enumerate() {
        transaction.execute("UPDATE panel_connections SET sort_order=?1,updated_at=?2 WHERE id=?3", params![sort_order as i64, now, id]).map_err(|e| format!("更新面板排序失败: {e}"))?;
    }
    transaction.commit().map_err(|e| format!("保存面板排序失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn save_panel_connection(input: PanelConnectionInput) -> Result<PanelConnection, String> {
    let name = input.name.trim();
    let panel_url = normalize_panel_url(&input.panel_url)?;
    if name.is_empty() { return Err("请填写面板名称".into()); }
    let existing = input.id.and_then(|id| open_db().ok()?.query_row("SELECT api_key_ciphertext FROM panel_connections WHERE id=?1", [id], |row| row.get::<_, String>(0)).optional().ok().flatten());
    let api_key_ciphertext = match input.api_key.as_deref().map(str::trim).filter(|value| !value.is_empty()) { Some(key) => encrypt_secret(key)?, None => existing.ok_or_else(|| "首次绑定需要填写面板 API 密钥".to_string())? };
    let api_key = decrypt_secret(&api_key_ciphertext)?;
    let data = panel_api_request(&panel_url, &api_key, "/system?action=GetNetWork", input.allow_insecure_tls).await?;
    let summary = panel_summary(&data);
    let now = Utc::now().timestamp_millis();
    let conn = open_db()?;
    let id = match input.id {
        Some(id) => { conn.execute("UPDATE panel_connections SET name=?1,panel_url=?2,api_key_ciphertext=?3,sort_order=?4,allow_insecure_tls=?5,group_name=?6,source_account_id=?7,source_asset_key=?8,status='online',summary_json=?9,last_checked_at=?10,last_error=NULL,remark=?11,updated_at=?10 WHERE id=?12", params![name,panel_url,api_key_ciphertext,input.sort_order.max(0),input.allow_insecure_tls as i64,input.group_name,input.source_account_id,input.source_asset_key,serde_json::to_string(&summary).map_err(|e| e.to_string())?,now,input.remark,id]).map_err(|e| e.to_string())?; id }
        None => { conn.execute("INSERT INTO panel_connections(name,panel_url,api_key_ciphertext,sort_order,allow_insecure_tls,group_name,source_account_id,source_asset_key,status,summary_json,last_checked_at,remark,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'online',?9,?10,?11,?10,?10)", params![name,panel_url,api_key_ciphertext,input.sort_order.max(0),input.allow_insecure_tls as i64,input.group_name,input.source_account_id,input.source_asset_key,serde_json::to_string(&summary).map_err(|e| e.to_string())?,now,input.remark]).map_err(|e| e.to_string())?; conn.last_insert_rowid() }
    };
    conn.query_row("SELECT id,name,panel_url,sort_order,allow_insecure_tls,group_name,source_account_id,source_asset_key,api_key_ciphertext,status,summary_json,last_checked_at,last_error,remark,created_at,updated_at FROM panel_connections WHERE id=?1", [id], row_panel_connection).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn refresh_panel_connection(id: i64) -> Result<PanelConnection, String> {
    let (panel, api_key) = load_panel_connection(id)?;
    let now = Utc::now().timestamp_millis();
    let result = panel_api_request(&panel.panel_url, &api_key, "/system?action=GetNetWork", panel.allow_insecure_tls).await;
    let conn = open_db()?;
    match result {
        Ok(data) => { conn.execute("UPDATE panel_connections SET status='online',summary_json=?1,last_checked_at=?2,last_error=NULL,updated_at=?2 WHERE id=?3", params![serde_json::to_string(&panel_summary(&data)).map_err(|e| e.to_string())?,now,id]).map_err(|e| e.to_string())?; }
        Err(error) => { conn.execute("UPDATE panel_connections SET status='offline',last_checked_at=?1,last_error=?2,updated_at=?1 WHERE id=?3", params![now,error,id]).map_err(|e| e.to_string())?; }
    }
    conn.query_row("SELECT id,name,panel_url,sort_order,allow_insecure_tls,group_name,source_account_id,source_asset_key,api_key_ciphertext,status,summary_json,last_checked_at,last_error,remark,created_at,updated_at FROM panel_connections WHERE id=?1", [id], row_panel_connection).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn panel_temporary_login(id: i64) -> Result<String, String> {
    let (panel, api_key) = load_panel_connection(id)?;
    let data = panel_api_request(&panel.panel_url, &api_key, "/config?action=get_tmp_token", panel.allow_insecure_tls).await?;
    let token = data.get("msg").or_else(|| data.get("token")).and_then(Value::as_str).filter(|value| !value.is_empty()).ok_or("面板未返回临时登录令牌")?;
    Ok(format!("{}/login?tmp_token={}", panel.panel_url, token))
}

#[tauri::command]
pub(crate) fn delete_panel_connection(id: i64) -> Result<(), String> {
    open_db()?.execute("DELETE FROM panel_connections WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn update_panel_connection_remark(id: i64, remark: Option<String>) -> Result<PanelConnection, String> {
    let remark = remark.and_then(|value| (!value.trim().is_empty()).then(|| value.trim().to_string()));
    let conn = open_db()?;
    let now = Utc::now().timestamp_millis();
    conn.execute("UPDATE panel_connections SET remark=?1,updated_at=?2 WHERE id=?3", params![remark, now, id]).map_err(|e| e.to_string())?;
    conn.query_row("SELECT id,name,panel_url,sort_order,allow_insecure_tls,group_name,source_account_id,source_asset_key,api_key_ciphertext,status,summary_json,last_checked_at,last_error,remark,created_at,updated_at FROM panel_connections WHERE id=?1", [id], row_panel_connection).map_err(|_| "面板不存在".to_string())
}

#[tauri::command]
pub(crate) fn export_panel_connections_file(panel_ids: Option<Vec<i64>>) -> Result<String, String> {
    let conn = open_db()?;
    let selected_ids = panel_ids.filter(|ids| !ids.is_empty());
    let mut stmt = conn.prepare("SELECT id,name,panel_url,sort_order,api_key_ciphertext,allow_insecure_tls,group_name,source_account_id,source_asset_key,remark FROM panel_connections ORDER BY sort_order ASC, name COLLATE NOCASE").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?, row.get::<_, String>(4)?, row.get::<_, i64>(5)? == 1, row.get::<_, Option<String>>(6)?, row.get::<_, Option<i64>>(7)?, row.get::<_, Option<String>>(8)?, row.get::<_, Option<String>>(9)?))).map_err(|e| e.to_string())?;
    let mut panels = Vec::new();
    for row in rows {
        let (id, name, panel_url, sort_order, ciphertext, allow_insecure_tls, group_name, source_account_id, source_asset_key, remark) = row.map_err(|e| e.to_string())?;
        if selected_ids.as_ref().is_some_and(|ids| !ids.contains(&id)) { continue; }
        panels.push(ExportPanelConnection { name, panel_url, sort_order, api_key: decrypt_secret(&ciphertext)?, allow_insecure_tls, group_name, source_account_id, source_asset_key, remark });
    }
    if panels.is_empty() { return Err("未找到选择的面板".into()); }
    let base = dirs::home_dir().unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let desktop = base.join("Desktop");
    let dir = if desktop.exists() { desktop } else { base };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("cloudhub-tools-panels-{}.json", Utc::now().format("%Y%m%d-%H%M%S")));
    let payload = json!({"format": "cloudhub-tools-panel-export", "version": 1, "encryption": "plaintext", "api_key_exported": true, "exported_at": Utc::now().to_rfc3339(), "panels": panels});
    std::fs::write(&path, serde_json::to_vec_pretty(&payload).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub(crate) fn import_panel_connections(panels: Vec<ImportPanelConnection>) -> Result<usize, String> {
    if panels.is_empty() { return Err("导入文件中没有面板配置".into()); }
    let conn = open_db()?;
    let now = Utc::now().timestamp_millis();
    let mut imported = 0usize;
    for (index, panel) in panels.into_iter().enumerate() {
        let name = panel.name.trim();
        let panel_url = normalize_panel_url(&panel.panel_url)?;
        if name.is_empty() || panel.api_key.trim().is_empty() { return Err(format!("第 {} 条面板缺少名称或 API 密钥", index + 1)); }
        let ciphertext = encrypt_secret(panel.api_key.trim())?;
        let existing_id: Option<i64> = conn.query_row("SELECT id FROM panel_connections WHERE panel_url=?1", [&panel_url], |row| row.get(0)).optional().map_err(|e| e.to_string())?;
        match existing_id {
            Some(id) => conn.execute("UPDATE panel_connections SET name=?1,api_key_ciphertext=?2,sort_order=?3,allow_insecure_tls=?4,group_name=?5,source_account_id=?6,source_asset_key=?7,remark=?8,updated_at=?9 WHERE id=?10", params![name,ciphertext,panel.sort_order.unwrap_or(0).max(0),panel.allow_insecure_tls.unwrap_or(false) as i64,panel.group_name,panel.source_account_id,panel.source_asset_key,panel.remark,now,id]).map_err(|e| e.to_string())?,
            None => conn.execute("INSERT INTO panel_connections(name,panel_url,api_key_ciphertext,sort_order,allow_insecure_tls,group_name,source_account_id,source_asset_key,status,summary_json,remark,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'unknown','{}',?9,?10,?10)", params![name,panel_url,ciphertext,panel.sort_order.unwrap_or(0).max(0),panel.allow_insecure_tls.unwrap_or(false) as i64,panel.group_name,panel.source_account_id,panel.source_asset_key,panel.remark,now]).map_err(|e| e.to_string())?,
        };
        imported += 1;
    }
    Ok(imported)
}
