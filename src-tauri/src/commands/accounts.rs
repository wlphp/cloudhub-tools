use crate::{
    decrypt_secret, encrypt_secret, open_db, serialize_oci_private_key, AccountInput, CloudAccount,
    ExportAccount, ImportAccount,
};
use crate::core::repositories::accounts as account_repository;
use chrono::Utc;
use serde_json::Value;
use std::path::PathBuf;

#[tauri::command]
pub(crate) fn export_accounts(account_ids: Option<Vec<i64>>) -> Result<Vec<ExportAccount>, String> {
    let conn = open_db()?;
    let selected_ids = account_ids.filter(|ids| !ids.is_empty());
    let rows = account_repository::export_records(&conn, selected_ids.as_deref())?;
    let mut result = Vec::new();
    for row in rows {
        result.push(ExportAccount { account_name: row.account_name, cloud_type: row.cloud_type, group_name: row.group_name, access_key_id: row.access_key_id, access_key_secret: decrypt_secret(&row.secret_ciphertext)?, credential_meta: row.credential_meta, region_id: row.region_id, sort_order: row.sort_order, enabled: row.enabled, remark: row.remark });
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
        let conn = open_db()?;
        let existing_id = account_repository::id_by_access_key(&conn, &account.access_key_id)?;
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
    let conn = open_db()?;
    let value = keyword.unwrap_or_default().trim().to_string();
    account_repository::list(&conn, &value)
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
    let old_secret = input.id.map(|id| account_repository::secret_ciphertext(&conn, id)).transpose()?.flatten();
    let secret = match input.access_key_secret.as_ref().filter(|v| !v.trim().is_empty()) { Some(value) => encrypt_secret(value)?, None => old_secret.ok_or_else(|| "首次添加必须填写 AccessKey Secret".to_string())? };
    account_repository::save(&conn, &input, &secret, now)
}

#[tauri::command]
pub(crate) fn delete_account(id: i64) -> Result<(), String> { account_repository::delete(&open_db()?, id) }
