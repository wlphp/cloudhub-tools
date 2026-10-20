use crate::core::{codex::{auth, AUTH_WRITER}, error::PlatformResult, repositories::codex_accounts as repository, storage::{open_db, encrypt_secret, decrypt_secret}};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

#[tauri::command]
pub(crate) async fn codex_account_events(id: i64) -> PlatformResult<Vec<repository::AccountEvent>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<repository::AccountEvent>, String> {
        if id <= 0 { return Err("Codex 账号参数无效".into()); }
        let _guard = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        let conn = open_db()?;
        repository::get(&conn, id)?;
        repository::events(&conn, id)
    }).await.map_err(|_| "读取 Codex 账号日志失败")?.map_err(Into::into)
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AccountDetails {
    pub email: String,
    pub password: String,
    pub two_factor: String,
    pub mail_url: String,
    pub phone: String,
    pub note: String,
}
fn read(conn: &Connection, id: i64) -> Result<AccountDetails, String> {
    let cipher: Option<String> = conn.query_row("SELECT details_ciphertext FROM codex_accounts WHERE id=?1 AND deleted_at IS NULL", [id], |row| row.get(0)).map_err(|_| "Codex 账号不存在")?;
    cipher.map(|value| {
        let plain = Zeroizing::new(decrypt_secret(&value).map_err(|_| "读取账号资料失败")?);
        serde_json::from_str(&plain).map_err(|_| "读取账号资料失败".into())
    }).unwrap_or_else(|| Ok(AccountDetails::default()))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountDetailView { details: AccountDetails, version: i64, auth: auth::AuthMetadata, available_secrets: Vec<String>, last_refresh: Option<String> }
fn secret(auth: &serde_json::Value, field: &str) -> Result<String, String> {
    let value = match field {
        "access_token" | "refresh_token" | "id_token" => auth.get("tokens").and_then(|v| v.get(field)),
        "api_key" => auth.get("OPENAI_API_KEY"),
        _ => return Err("账号凭据字段无效".into()),
    };
    Ok(value.and_then(serde_json::Value::as_str).unwrap_or("").to_owned())
}
#[tauri::command]
pub(crate) async fn codex_account_details(id: i64) -> PlatformResult<AccountDetailView> {
    tauri::async_runtime::spawn_blocking(move || -> Result<AccountDetailView, String> {
        let _guard = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        let conn = open_db()?;
        let account = repository::get(&conn, id)?;
        let content = repository::credentials(&conn, id)?;
        let value: serde_json::Value = serde_json::from_str(&content).map_err(|_| "读取账号资料失败")?;
        let mut details = read(&conn, id)?;
        if details.email.is_empty() { details.email = account.email.unwrap_or_default(); }
        Ok(AccountDetailView { details, version: account.updated_at, auth: auth::metadata(&content)?,
            available_secrets: ["access_token", "refresh_token", "id_token", "api_key"].into_iter().filter(|field| secret(&value, field).is_ok_and(|v| !v.is_empty())).map(str::to_owned).collect(),
            last_refresh: value.get("last_refresh").and_then(serde_json::Value::as_str).filter(|v| chrono::DateTime::parse_from_rfc3339(v).is_ok()).map(str::to_owned) })
    }).await.map_err(|_| "读取账号资料失败")?.map_err(Into::into)
}
#[tauri::command]
pub(crate) async fn codex_save_account_details(id: i64, version: i64, input: AccountDetails) -> PlatformResult<()> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        if input.email.len() > 254 || input.password.len() > 4096 || input.two_factor.len() > 4096 || input.mail_url.len() > 2048 || input.phone.len() > 80 || input.note.chars().count() > 8000 { return Err("账号资料字段过长".into()); }
        if !input.mail_url.is_empty() {
            let url = reqwest::Url::parse(&input.mail_url).map_err(|_| "邮件地址必须是 HTTP 或 HTTPS 网页地址")?;
            if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() { return Err("邮件地址必须是 HTTP 或 HTTPS 网页地址".into()); }
        }
        let _guard = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        let content = Zeroizing::new(serde_json::to_string(&input).map_err(|_| "保存账号资料失败")?);
        let encrypted = encrypt_secret(&content).map_err(|_| "保存账号资料失败")?;
        let changed = open_db()?.execute("UPDATE codex_accounts SET details_ciphertext=?1,updated_at=MAX(updated_at+1,?2) WHERE id=?3 AND updated_at=?4 AND deleted_at IS NULL", params![encrypted,chrono::Utc::now().timestamp_millis(),id,version]).map_err(|_| "保存账号资料失败")?;
        if changed != 1 { return Err("账号资料已变更，请重新打开后保存".into()); }
        Ok(())
    }).await.map_err(|_| "保存账号资料失败")?.map_err(Into::into)
}
#[tauri::command]
pub(crate) async fn codex_account_secret(id: i64, field: String, copy: bool) -> PlatformResult<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
        let _guard = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        let content = repository::credentials(&open_db()?, id)?;
        let value = serde_json::from_str(&content).map_err(|_| "读取账号凭据失败")?;
        let value = Zeroizing::new(secret(&value, &field)?);
        if copy { arboard::Clipboard::new().and_then(|mut clipboard| clipboard.set_text(value.as_str())).map_err(|_| "复制账号凭据失败")?; Ok(None) }
        else { Ok(Some(value.to_string())) }
    }).await.map_err(|_| "读取账号凭据失败")?.map_err(Into::into)
}
