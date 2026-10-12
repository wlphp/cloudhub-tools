use super::codex::AUTH_WRITER;
use crate::core::{
    codex::{auth, profile},
    crypto::{open_sync_payload, seal_sync_payload, SyncEnvelope},
    error::PlatformResult,
    repositories::codex_accounts as repository,
    storage::open_db,
};
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use zeroize::{Zeroize, Zeroizing};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Backup {
    format: String,
    version: u32,
    accounts: Vec<String>,
}
impl Drop for Backup {
    fn drop(&mut self) {
        for auth in &mut self.accounts {
            auth.zeroize();
        }
    }
}

fn passphrase(value: String) -> Result<Zeroizing<String>, String> {
    let value = Zeroizing::new(value);
    if value.chars().count() < 12 || value.len() > 1024 {
        return Err("迁移口令至少 12 个字符，最多 1024 个 UTF-8 字节".into());
    }
    Ok(value)
}

fn plain_accounts(auths: &[Zeroizing<String>]) -> Result<Zeroizing<String>, String> {
    if auths.is_empty() || auths.len() > 100 {
        return Err("请选择 1 至 100 个账号导出".into());
    }
    let mut encoded = Zeroizing::new(String::new());
    if auths.len() > 1 {
        encoded.push('[');
    }
    for (index, auth) in auths.iter().enumerate() {
        let parsed = auth::parse_import(auth)?;
        if parsed.len() != 1 {
            return Err("导出账号认证格式无效".into());
        }
        if index > 0 {
            encoded.push(',');
        }
        encoded.push_str(&parsed[0].auth_json);
        if encoded.len() > 2 * 1024 * 1024 {
            return Err("账号导出文件超出大小限制".into());
        }
    }
    if auths.len() > 1 {
        encoded.push(']');
    }
    if encoded.len() > 2 * 1024 * 1024 {
        return Err("账号导出文件超出大小限制".into());
    }
    Ok(encoded)
}

#[tauri::command]
pub(crate) async fn codex_export_accounts_file(
    app: tauri::AppHandle,
    account_id: Option<i64>,
) -> PlatformResult<bool> {
    if account_id.is_some_and(|id| id <= 0) {
        return Err("导出账号无效".into());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
        let Some(selected) = app
            .dialog()
            .file()
            .set_title("保存 Codex 账号 JSON（包含登录凭据）")
            .set_file_name("cloudhub-codex-accounts.json")
            .add_filter("JSON", &["json"])
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = selected.into_path().map_err(|_| "账号导出路径无效")?;
        let encoded = {
            let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
            super::codex_instances::ensure_idle(
                &app.state::<super::codex_runtime::CodexRuntimeStore>(),
            )?;
            let conn = open_db()?;
            let accounts = if let Some(id) = account_id {
                vec![repository::get(&conn, id)?]
            } else {
                repository::list(&conn)?
            };
            let auths = accounts
                .iter()
                .map(|account| repository::credentials(&conn, account.id))
                .collect::<Result<Vec<_>, _>>()?;
            plain_accounts(&auths)?
        };
        profile::write_private(&path, &encoded)?;
        Ok(true)
    })
    .await
    .map_err(|_| "导出账号任务失败")?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_export_backup(
    app: tauri::AppHandle,
    password: String,
    account_id: Option<i64>,
) -> PlatformResult<bool> {
    if account_id.is_some_and(|id| id <= 0) {
        return Err("备份账号无效".into());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
        let password = passphrase(password)?;
        let Some(selected) = app
            .dialog()
            .file()
            .set_title("保存口令加密的 Codex 登录备份")
            .set_file_name("cloudhub-codex-backup.json")
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = selected.into_path().map_err(|_| "Codex 备份路径无效")?;
        let envelope = {
            let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
            super::codex_instances::ensure_idle(
                &app.state::<super::codex_runtime::CodexRuntimeStore>(),
            )?;
            let conn = open_db()?;
            let accounts = if let Some(id) = account_id {
                vec![repository::get(&conn, id)?]
            } else {
                repository::list(&conn)?
            };
            if accounts.is_empty() || accounts.len() > 100 {
                return Err("Codex 备份需要 1 至 100 个账号".into());
            }
            let mut payload = Backup {
                format: "cloudhub-codex-auth-backup".into(),
                version: 1,
                accounts: Vec::new(),
            };
            for account in accounts {
                payload
                    .accounts
                    .push(repository::credentials(&conn, account.id)?.to_string());
            }
            seal_sync_payload(&payload, &password).map_err(|_| "Codex 备份加密失败")?
        };
        let encoded = serde_json::to_string(&envelope).map_err(|_| "Codex 备份编码失败")?;
        if encoded.len() > 2 * 1024 * 1024 {
            return Err("Codex 备份超出大小限制".into());
        }
        profile::write_private(&path, &encoded)?;
        Ok(true)
    })
    .await
    .map_err(|_| "Codex 备份任务失败")?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_import_backup(
    app: tauri::AppHandle,
    password: String,
) -> PlatformResult<bool> {
    tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
        let password = passphrase(password)?;
        let Some(selected) = app
            .dialog()
            .file()
            .set_title("选择加密 Codex 登录备份")
            .add_filter("JSON", &["json"])
            .blocking_pick_file()
        else {
            return Ok(false);
        };
        let path = selected.into_path().map_err(|_| "Codex 备份路径无效")?;
        let content = profile::read_auth(&path)?;
        let envelope: SyncEnvelope =
            serde_json::from_str(&content).map_err(|_| "Codex 加密备份格式无效")?;
        let payload: Backup = open_sync_payload(&envelope, &password)
            .map_err(|_| "无法解密 Codex 备份，请检查口令及文件完整性")?;
        let accounts = validate(&payload)?;
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        super::codex::import_accounts(&app, accounts)?;
        Ok(true)
    })
    .await
    .map_err(|_| "Codex 备份导入任务失败")?
    .map_err(Into::into)
}

fn validate(payload: &Backup) -> Result<Vec<auth::ImportedAccount>, String> {
    if payload.format != "cloudhub-codex-auth-backup"
        || payload.version != 1
        || payload.accounts.is_empty()
        || payload.accounts.len() > 100
    {
        return Err("Codex 备份版本或账号数量无效".into());
    }
    let mut accounts = Vec::new();
    for item in &payload.accounts {
        let mut parsed = auth::parse_import(item)?;
        if parsed.len() != 1 {
            return Err("Codex 备份账号格式无效".into());
        }
        accounts.append(&mut parsed);
    }
    Ok(accounts)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plain_exports_round_trip_as_single_auth_or_account_array() {
        let auth = Zeroizing::new(r#"{"OPENAI_API_KEY":"test-only-api-key"}"#.to_string());
        let single = plain_accounts(&[auth.clone()]).unwrap();
        assert!(single.starts_with('{'));
        assert_eq!(auth::parse_import(&single).unwrap().len(), 1);
        let batch = plain_accounts(&[
            auth.clone(),
            Zeroizing::new(r#"{"OPENAI_API_KEY":"test-only-second-key"}"#.to_string()),
        ])
        .unwrap();
        assert!(batch.starts_with('['));
        assert_eq!(auth::parse_import(&batch).unwrap().len(), 2);
        assert!(plain_accounts(&[]).is_err());
        assert!(plain_accounts(&[Zeroizing::new("{}".into())]).is_err());
    }
    #[test]
    fn backup_format_is_separate_from_other_sync_payloads() {
        let payload = Backup {
            format: "other-product".into(),
            version: 1,
            accounts: vec!["{}".into()],
        };
        assert!(validate(&payload).is_err());
        assert!(passphrase("short".into()).is_err());
    }
}
