use crate::{
    decrypt_secret, encrypt_secret, open_db, serialize_oci_private_key, AccountInput, CloudAccount,
    ExportAccount, ImportAccount,
};
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde_json::Value;
use std::path::PathBuf;

fn row_account(row: &rusqlite::Row<'_>) -> rusqlite::Result<CloudAccount> {
    Ok(CloudAccount { id: row.get(0)?, account_name: row.get(1)?, cloud_type: row.get(2)?, group_name: row.get(3)?, access_key_id: row.get(4)?, credential_meta: row.get(5)?, region_id: row.get(6)?, sort_order: row.get(7)?, enabled: row.get::<_, i64>(8)? == 1, remark: row.get(9)?, created_at: row.get(10)?, updated_at: row.get(11)? })
}

#[tauri::command]
pub(crate) fn export_accounts(account_ids: Option<Vec<i64>>) -> Result<Vec<ExportAccount>, String> {
    let conn = open_db()?;
    let selected_ids = account_ids.filter(|ids| !ids.is_empty());
    let mut stmt = conn.prepare("SELECT id,account_name,cloud_type,group_name,access_key_id,secret_ciphertext,credential_meta,region_id,sort_order,enabled,remark FROM cloud_accounts ORDER BY sort_order ASC, updated_at DESC").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        let ciphertext: String = row.get(5)?;
        Ok((
            row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?,
            row.get::<_, String>(4)?, ciphertext, row.get::<_, Option<String>>(6)?, row.get::<_, Option<String>>(7)?, row.get::<_, i64>(8)?,
            row.get::<_, i64>(9)? == 1, row.get::<_, Option<String>>(10)?,
        ))
    }).map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for row in rows {
        let (id, account_name, cloud_type, group_name, access_key_id, ciphertext, credential_meta, region_id, sort_order, enabled, remark) = row.map_err(|e| e.to_string())?;
        if selected_ids.as_ref().is_some_and(|ids| !ids.contains(&id)) { continue; }
        result.push(ExportAccount { account_name, cloud_type, group_name, access_key_id, access_key_secret: decrypt_secret(&ciphertext)?, credential_meta, region_id, sort_order, enabled, remark });
    }
    Ok(result)
}

#[tauri::command]
pub(crate) fn export_accounts_file(account_ids: Option<Vec<i64>>) -> Result<String, String> {
    let accounts = export_accounts(account_ids)?;
    let filename = format!("cloudhub-tools-accounts-{}.json", Utc::now().format("%Y%m%d-%H%M%S"));
    let base = dirs::home_dir().unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    // Keep exported credentials easy to find: write to the current user's Desktop.
    // Fall back to the home directory when the Desktop folder is unavailable.
    let desktop = base.join("Desktop");
    let dir = if desktop.exists() { desktop } else { base };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(filename);
    let payload = serde_json::json!({
        "format": "cloudhub-tools-account-export",
        "version": 2,
        "encryption": "plaintext",
        "secret_exported": true,
        "exported_at": Utc::now().to_rfc3339(),
        "accounts": accounts,
    });
    std::fs::write(&path, serde_json::to_vec_pretty(&payload).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub(crate) fn import_accounts(accounts: Vec<ImportAccount>) -> Result<usize, String> {
    if accounts.is_empty() { return Err("导入文件中没有云账号".into()); }
    let mut imported = 0usize;
    for (index, account) in accounts.into_iter().enumerate() {
        if account.account_name.trim().is_empty() || account.access_key_id.trim().is_empty() || account.access_key_secret.trim().is_empty() {
            return Err(format!("第 {} 条账号缺少账号名称、AccessKey ID 或 AccessKey Secret", index + 1));
        }
        let existing_id: Option<i64> = open_db()?.query_row("SELECT id FROM cloud_accounts WHERE access_key_id=?1", [&account.access_key_id], |row| row.get(0)).optional().map_err(|e| e.to_string())?;
        save_account(AccountInput {
            id: existing_id,
            account_name: account.account_name,
            cloud_type: account.cloud_type.unwrap_or_else(|| "aliyun".into()),
            group_name: account.group_name,
            access_key_id: account.access_key_id,
            access_key_secret: Some(account.access_key_secret),
            credential_meta: account.credential_meta,
            region_id: account.region_id,
            sort_order: account.sort_order,
            enabled: account.enabled.unwrap_or(true),
            remark: account.remark,
        })?;
        imported += 1;
    }
    Ok(imported)
}

#[tauri::command]
pub(crate) fn list_accounts(keyword: Option<String>) -> Result<Vec<CloudAccount>, String> {
    let conn = open_db()?; let value = keyword.unwrap_or_default().trim().to_string(); let pattern = format!("%{value}%");
    let mut stmt = conn.prepare("SELECT id,account_name,cloud_type,group_name,access_key_id,credential_meta,region_id,sort_order,enabled,remark,created_at,updated_at FROM cloud_accounts WHERE ?1='' OR account_name LIKE ?2 OR access_key_id LIKE ?2 OR COALESCE(group_name,'') LIKE ?2 ORDER BY sort_order ASC, updated_at DESC").map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![value, pattern], row_account).map_err(|e| e.to_string())?; rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn save_account(mut input: AccountInput) -> Result<CloudAccount, String> {
    if input.account_name.trim().is_empty() || input.access_key_id.trim().is_empty() { return Err("账号名称和 AccessKey ID 不能为空".into()); }
    let conn = open_db()?; let now = Utc::now().timestamp_millis();
    if input.cloud_type == "oracle" {
        if let Some(private_key) = input.access_key_secret.as_mut() { *private_key = serialize_oci_private_key(private_key); }
        let meta: Value = serde_json::from_str(input.credential_meta.as_deref().unwrap_or("{}")).map_err(|_| "OCI 凭证信息格式无效".to_string())?;
        if meta.get("tenancy_ocid").and_then(Value::as_str).is_none_or(|value| value.trim().is_empty()) || meta.get("key_fingerprint").and_then(Value::as_str).is_none_or(|value| value.trim().is_empty()) { return Err("OCI 账号需要填写 Tenancy OCID 和 Key Fingerprint".into()); }
    }
    if input.cloud_type == "azure" {
        let meta: Value = serde_json::from_str(input.credential_meta.as_deref().unwrap_or("{}")).map_err(|_| "Azure 凭证信息格式无效".to_string())?;
        if meta.get("tenant_id").and_then(Value::as_str).is_none_or(|value| value.trim().is_empty()) || meta.get("subscription_id").and_then(Value::as_str).is_none_or(|value| value.trim().is_empty()) { return Err("Azure 账号需要填写 Tenant ID 和 Subscription ID".into()); }
    }
    if input.cloud_type == "gcp" {
        let meta: Value = serde_json::from_str(input.credential_meta.as_deref().unwrap_or("{}")).map_err(|_| "GCP 凭证信息格式无效".to_string())?;
        if meta.get("project_id").and_then(Value::as_str).is_none_or(|value| value.trim().is_empty()) { return Err("GCP 账号需要填写 Project ID".into()); }
    }
    let old_secret: Option<String> = input.id.and_then(|id| conn.query_row("SELECT secret_ciphertext FROM cloud_accounts WHERE id=?1", [id], |r| r.get(0)).optional().ok().flatten());
    let secret = match input.access_key_secret.filter(|v| !v.trim().is_empty()) { Some(value) => encrypt_secret(&value)?, None => old_secret.ok_or_else(|| "首次添加必须填写 AccessKey Secret".to_string())? };
    let id = match input.id {
        Some(id) => { conn.execute("UPDATE cloud_accounts SET account_name=?1,cloud_type=?2,group_name=?3,access_key_id=?4,secret_ciphertext=?5,credential_meta=?6,region_id=?7,sort_order=?8,enabled=?9,remark=?10,updated_at=?11 WHERE id=?12", params![input.account_name.trim(), input.cloud_type, input.group_name, input.access_key_id.trim(), secret, input.credential_meta, input.region_id, input.sort_order.unwrap_or(0), input.enabled as i64, input.remark, now, id]).map_err(|e| e.to_string())?; id }
        None => { conn.execute("INSERT INTO cloud_accounts(account_name,cloud_type,group_name,access_key_id,secret_ciphertext,credential_meta,region_id,sort_order,enabled,remark,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)", params![input.account_name.trim(), input.cloud_type, input.group_name, input.access_key_id.trim(), secret, input.credential_meta, input.region_id, input.sort_order.unwrap_or(0), input.enabled as i64, input.remark, now]).map_err(|e| e.to_string())?; conn.last_insert_rowid() }
    };
    conn.query_row("SELECT id,account_name,cloud_type,group_name,access_key_id,credential_meta,region_id,sort_order,enabled,remark,created_at,updated_at FROM cloud_accounts WHERE id=?1", [id], row_account).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn delete_account(id: i64) -> Result<(), String> { open_db()?.execute("DELETE FROM cloud_accounts WHERE id=?1", [id]).map(|_| ()).map_err(|e| e.to_string()) }
