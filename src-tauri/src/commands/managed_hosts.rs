use crate::{
    decrypt_secret, encrypt_secret, open_db, row_managed_host, ExportManagedHost,
    ImportManagedHost, ManagedHost, ManagedHostInput, MANAGED_HOST_SELECT,
};
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde_json::json;
use std::path::PathBuf;

#[tauri::command]
pub(crate) fn list_managed_hosts() -> Result<Vec<ManagedHost>, String> {
    let conn = open_db()?;
    let mut stmt = conn.prepare(&format!("{MANAGED_HOST_SELECT} ORDER BY COALESCE(group_name,''), name COLLATE NOCASE")).map_err(|e| e.to_string())?;
    let hosts = stmt.query_map([], row_managed_host).map_err(|e| e.to_string())?.map(|row| row.map_err(|e| e.to_string())).collect();
    hosts
}

#[tauri::command]
pub(crate) fn save_managed_host(input: ManagedHostInput) -> Result<ManagedHost, String> {
    let name = input.name.trim();
    let host = input.host.trim();
    let username = input.username.trim();
    let platform = input.platform.as_deref().unwrap_or("linux");
    if !matches!(platform, "linux" | "windows") { return Err("不支持的操作系统类型".into()); }
    let auth_method = if platform == "linux" { input.auth_method.as_deref().unwrap_or("password") } else { "password" };
    if !matches!(auth_method, "password" | "private_key") { return Err("不支持的 Linux 验证方式".into()); }
    if name.is_empty() || host.is_empty() || username.is_empty() { return Err(format!("请填写服务器名称、主机地址和 {}用户名", if platform == "windows" { "RDP " } else { "SSH " })); }
    let port = input.port.unwrap_or(if platform == "windows" { 3389 } else { 22 }).max(1);
    let conn = open_db()?;
    let now = Utc::now().timestamp_millis();
    let existing = input.id.and_then(|id| conn.query_row("SELECT password_ciphertext,private_key_ciphertext,key_passphrase_ciphertext FROM managed_hosts WHERE id=?1", [id], |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, Option<String>>(2)?))).optional().ok().flatten());
    let password_secret = input.password.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(encrypt_secret).transpose()?.or_else(|| existing.as_ref().and_then(|value| value.0.clone()));
    let has_new_key = input.private_key.as_deref().is_some_and(|value| !value.trim().is_empty());
    let private_key_secret = if auth_method == "private_key" { input.private_key.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(encrypt_secret).transpose()?.or_else(|| existing.as_ref().and_then(|value| value.1.clone())) } else { None };
    let key_passphrase_secret = if auth_method == "private_key" { if has_new_key || input.key_passphrase.is_some() { input.key_passphrase.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(encrypt_secret).transpose()? } else { existing.as_ref().and_then(|value| value.2.clone()) } } else { None };
    if platform == "linux" && auth_method == "password" && password_secret.as_deref().is_none_or(str::is_empty) { return Err("首次添加 Linux 服务器需要填写 SSH 密码".into()); }
    if platform == "linux" && auth_method == "private_key" && private_key_secret.as_deref().is_none_or(str::is_empty) { return Err("首次添加 Linux 服务器需要粘贴 SSH 私钥".into()); }
    let password_value = if auth_method == "private_key" { String::new() } else { password_secret.unwrap_or_default() };
    let id = match input.id {
        Some(id) => { conn.execute("UPDATE managed_hosts SET name=?1,host=?2,port=?3,username=?4,platform=?5,auth_method=?6,password_ciphertext=?7,private_key_ciphertext=?8,key_passphrase_ciphertext=?9,group_name=?10,tags=?11,source_account_id=?12,source_asset_key=?13,remark=?14,host_key_fingerprint=CASE WHEN platform<>?5 OR auth_method<>?6 THEN NULL ELSE host_key_fingerprint END,updated_at=?15 WHERE id=?16", params![name,host,port,username,platform,auth_method,password_value,private_key_secret,key_passphrase_secret,input.group_name,input.tags,input.source_account_id,input.source_asset_key,input.remark,now,id]).map_err(|e| e.to_string())?; id }
        None => { conn.execute("INSERT INTO managed_hosts(name,host,port,username,platform,auth_method,password_ciphertext,private_key_ciphertext,key_passphrase_ciphertext,group_name,tags,source_account_id,source_asset_key,remark,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?15)", params![name,host,port,username,platform,auth_method,password_value,private_key_secret,key_passphrase_secret,input.group_name,input.tags,input.source_account_id,input.source_asset_key,input.remark,now]).map_err(|e| e.to_string())?; conn.last_insert_rowid() }
    };
    conn.query_row(&format!("{MANAGED_HOST_SELECT} WHERE id=?1"), [id], row_managed_host).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn delete_managed_host(id: i64) -> Result<(), String> {
    open_db()?.execute("DELETE FROM managed_hosts WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn export_managed_hosts_file() -> Result<String, String> {
    let conn = open_db()?;
    let mut stmt = conn.prepare("SELECT name,host,port,username,platform,auth_method,password_ciphertext,private_key_ciphertext,key_passphrase_ciphertext,group_name,tags,source_account_id,source_asset_key,remark FROM managed_hosts ORDER BY COALESCE(group_name,''), name COLLATE NOCASE").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, u16>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, Option<String>>(6)?, row.get::<_, Option<String>>(7)?, row.get::<_, Option<String>>(8)?, row.get::<_, Option<String>>(9)?, row.get::<_, Option<String>>(10)?, row.get::<_, Option<i64>>(11)?, row.get::<_, Option<String>>(12)?, row.get::<_, Option<String>>(13)?))).map_err(|e| e.to_string())?;
    let mut hosts = Vec::new();
    for row in rows {
        let (name, host, port, username, platform, auth_method, password_ciphertext, private_key_ciphertext, key_passphrase_ciphertext, group_name, tags, source_account_id, source_asset_key, remark) = row.map_err(|e| e.to_string())?;
        let decrypt_optional = |value: Option<String>| value.filter(|item| !item.is_empty()).map(|item| decrypt_secret(&item)).transpose();
        hosts.push(ExportManagedHost { name, host, port, username, platform, auth_method, password: decrypt_optional(password_ciphertext)?, private_key: decrypt_optional(private_key_ciphertext)?, key_passphrase: decrypt_optional(key_passphrase_ciphertext)?, group_name, tags, source_account_id, source_asset_key, remark });
    }
    if hosts.is_empty() { return Err("没有可导出的服务器".into()); }
    let base = dirs::home_dir().unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let desktop = base.join("Desktop");
    let dir = if desktop.exists() { desktop } else { base };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("cloudhub-tools-terminal-hosts-{}.json", Utc::now().format("%Y%m%d-%H%M%S")));
    let payload = json!({"format": "cloudhub-tools-managed-host-export", "version": 1, "encryption": "plaintext", "credentials_exported": true, "exported_at": Utc::now().to_rfc3339(), "hosts": hosts});
    std::fs::write(&path, serde_json::to_vec_pretty(&payload).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub(crate) fn import_managed_hosts(hosts: Vec<ImportManagedHost>) -> Result<usize, String> {
    if hosts.is_empty() { return Err("导入文件中没有服务器配置".into()); }
    let conn = open_db()?;
    let now = Utc::now().timestamp_millis();
    let mut imported = 0usize;
    for (index, host) in hosts.into_iter().enumerate() {
        let name = host.name.trim();
        let address = host.host.trim();
        let username = host.username.trim();
        let platform = host.platform.as_deref().unwrap_or("linux");
        if !matches!(platform, "linux" | "windows") { return Err(format!("第 {} 条服务器的操作系统类型不支持", index + 1)); }
        let auth_method = if platform == "linux" { host.auth_method.as_deref().unwrap_or("password") } else { "password" };
        if !matches!(auth_method, "password" | "private_key") { return Err(format!("第 {} 条服务器的 Linux 验证方式不支持", index + 1)); }
        if name.is_empty() || address.is_empty() || username.is_empty() { return Err(format!("第 {} 条服务器缺少名称、主机地址或用户名", index + 1)); }
        let port = host.port.unwrap_or(if platform == "windows" { 3389 } else { 22 }).max(1);
        let password = host.password.as_deref().map(str::trim).filter(|value| !value.is_empty());
        let private_key = host.private_key.as_deref().map(str::trim).filter(|value| !value.is_empty());
        if platform == "linux" && auth_method == "password" && password.is_none() { return Err(format!("第 {} 条 Linux 服务器缺少 SSH 密码", index + 1)); }
        if platform == "linux" && auth_method == "private_key" && private_key.is_none() { return Err(format!("第 {} 条 Linux 服务器缺少 SSH 私钥", index + 1)); }
        let password_ciphertext = if auth_method == "private_key" { String::new() } else { password.map(encrypt_secret).transpose()?.unwrap_or_default() };
        let private_key_ciphertext = if auth_method == "private_key" { private_key.map(encrypt_secret).transpose()? } else { None };
        let key_passphrase_ciphertext = if auth_method == "private_key" { host.key_passphrase.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(encrypt_secret).transpose()? } else { None };
        let existing_id: Option<i64> = conn.query_row("SELECT id FROM managed_hosts WHERE host=?1 AND port=?2 AND username=?3", params![address, port, username], |row| row.get(0)).optional().map_err(|e| e.to_string())?;
        match existing_id {
            Some(id) => conn.execute("UPDATE managed_hosts SET name=?1,platform=?2,auth_method=?3,password_ciphertext=?4,private_key_ciphertext=?5,key_passphrase_ciphertext=?6,group_name=?7,tags=?8,source_account_id=?9,source_asset_key=?10,remark=?11,host_key_fingerprint=NULL,status='unknown',last_latency_ms=NULL,metrics_json='{}',last_checked_at=NULL,last_error=NULL,updated_at=?12 WHERE id=?13", params![name,platform,auth_method,password_ciphertext,private_key_ciphertext,key_passphrase_ciphertext,host.group_name,host.tags,host.source_account_id,host.source_asset_key,host.remark,now,id]).map_err(|e| e.to_string())?,
            None => conn.execute("INSERT INTO managed_hosts(name,host,port,username,platform,auth_method,password_ciphertext,private_key_ciphertext,key_passphrase_ciphertext,group_name,tags,source_account_id,source_asset_key,status,metrics_json,remark,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'unknown','{}',?14,?15,?15)", params![name,address,port,username,platform,auth_method,password_ciphertext,private_key_ciphertext,key_passphrase_ciphertext,host.group_name,host.tags,host.source_account_id,host.source_asset_key,host.remark,now]).map_err(|e| e.to_string())?,
        };
        imported += 1;
    }
    Ok(imported)
}
