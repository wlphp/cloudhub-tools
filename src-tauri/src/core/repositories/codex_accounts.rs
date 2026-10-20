use crate::core::codex::{
    auth::ImportedAccount, AccountMetadataInput, CodexAccountSummary, QuotaSnapshot,
};
use crate::core::storage::{decrypt_secret, encrypt_secret};
use rusqlite::{params, Connection, OptionalExtension};
use zeroize::Zeroizing;

const COLUMNS: &str =
    "id,label,email,account_id,auth_mode,plan,note,tags_json,quota_json,last_error,updated_at,(SELECT proxy_url FROM codex_account_controls WHERE account_id=codex_accounts.id),(SELECT benefits_json FROM codex_account_controls WHERE account_id=codex_accounts.id),auth_ciphertext";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountEvent {
    pub id: i64,
    pub account_id: i64,
    pub event_type: String,
    pub message: String,
    pub details: Option<serde_json::Value>,
    pub created_at: i64,
}

pub fn events(conn: &Connection, account_id: i64) -> Result<Vec<AccountEvent>, String> {
    if account_id <= 0 {
        return Err("Codex 账号参数无效".into());
    }
    let mut statement = conn.prepare(
        "SELECT id,account_id,event_type,message,details_json,created_at FROM codex_account_events WHERE account_id=?1 ORDER BY created_at DESC,id DESC LIMIT 500",
    ).map_err(|_| "读取 Codex 账号日志失败")?;
    let rows = statement.query_map([account_id], |row| Ok(AccountEvent {
        id: row.get(0)?, account_id: row.get(1)?, event_type: row.get(2)?,
        message: row.get(3)?,
        details: row.get::<_, Option<String>>(4)?.and_then(|value| serde_json::from_str(&value).ok()),
        created_at: row.get(5)?,
    })).map_err(|_| "读取 Codex 账号日志失败")?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| "读取 Codex 账号日志失败".into())
}

fn append_event(conn: &Connection, account_id: i64, event_type: &str, message: &str, details: Option<&serde_json::Value>) -> Result<(), String> {
    let details = details.and_then(|value| serde_json::to_string(value).ok()).filter(|value| value.len() <= 16 * 1024);
    conn.execute(
        "INSERT INTO codex_account_events(account_id,event_type,message,details_json,created_at) VALUES(?1,?2,?3,?4,?5)",
        params![account_id,event_type,message,details,chrono::Utc::now().timestamp_millis()],
    ).map(|_| ()).map_err(|_| "保存 Codex 账号日志失败".into())
}

pub fn record_event(conn: &Connection, account_id: i64, event_type: &str, message: &str, details: Option<&serde_json::Value>) -> Result<(), String> {
    if account_id <= 0 || event_type.len() > 40 || message.len() > 1000 {
        return Err("Codex 账号日志参数无效".into());
    }
    append_event(conn, account_id, event_type, message, details)
}

fn token_changes(previous: Option<&str>, next: &str) -> Vec<&'static str> {
    let previous: serde_json::Value = previous.and_then(|value| serde_json::from_str(value).ok()).unwrap_or_default();
    let next: serde_json::Value = serde_json::from_str(next).unwrap_or_default();
    ["access_token", "id_token", "refresh_token"].into_iter().filter(|field| {
        previous.pointer(&format!("/tokens/{field}")) != next.pointer(&format!("/tokens/{field}"))
    }).map(|field| match field {
        "access_token" => "Access Token",
        "id_token" => "ID Token",
        _ => "Refresh Token",
    }).collect()
}

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CodexAccountSummary> {
    // Only bounded display metadata crosses the command boundary; credentials stay local.
    let display = row.get::<_, String>(13).ok()
        .and_then(|cipher| decrypt_secret(&cipher).ok()).map(Zeroizing::new)
        .and_then(|content| crate::core::codex::auth::metadata(&content).ok());
    Ok(CodexAccountSummary {
        is_web_session: display.as_ref().is_some_and(|v| v.is_web_session),
        user_id: display.as_ref().and_then(|v| v.user_id.clone()),
        login_provider: display.as_ref().and_then(|v| v.login_provider.clone()),
        workspace_name: display.as_ref().and_then(|v| v.workspace_name.clone()),
        id: row.get(0)?,
        label: row.get(1)?,
        email: row.get(2)?,
        account_id: row.get(3)?,
        auth_mode: row.get(4)?,
        plan: row.get(5)?,
        note: row.get(6)?,
        tags: serde_json::from_str(&row.get::<_, String>(7)?).unwrap_or_default(),
        quota: serde_json::from_str(&row.get::<_, String>(8)?).unwrap_or_default(),
        last_error: row.get(9)?,
        updated_at: row.get(10)?,
        proxy_url: row.get::<_,Option<String>>(11)?.and_then(|url|crate::core::codex::account_controls::validate_proxy(&url).ok().flatten()),
        benefits: row.get::<_,Option<String>>(12)?.and_then(|v|serde_json::from_str(&v).ok()).unwrap_or_default(),
    })
}

pub fn list(conn: &Connection) -> Result<Vec<CodexAccountSummary>, String> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {COLUMNS} FROM codex_accounts WHERE deleted_at IS NULL ORDER BY label COLLATE NOCASE,id"
        ))
        .map_err(|_| "读取 Codex 账号失败")?;
    let rows = statement
        .query_map([], row)
        .map_err(|_| "读取 Codex 账号失败")?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| "读取 Codex 账号失败".into())
}

pub fn get(conn: &Connection, id: i64) -> Result<CodexAccountSummary, String> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM codex_accounts WHERE id=?1 AND deleted_at IS NULL"),
        [id],
        row,
    )
    .map_err(|_| "Codex 账号不存在".into())
}

pub fn credentials(conn: &Connection, id: i64) -> Result<Zeroizing<String>, String> {
    let cipher: String = conn
        .query_row(
            "SELECT auth_ciphertext FROM codex_accounts WHERE id=?1 AND deleted_at IS NULL",
            [id],
            |row| row.get(0),
        )
        .map_err(|_| "Codex 账号不存在")?;
    decrypt_secret(&cipher)
        .map(Zeroizing::new)
        .map_err(|_| "解密 Codex 账号失败".into())
}

pub fn import(
    conn: &mut Connection,
    accounts: Vec<ImportedAccount>,
) -> Result<Vec<CodexAccountSummary>, String> {
    import_with_encrypt(conn, accounts, encrypt_secret, |value| crate::core::storage::decrypt_secret(value).ok().map(Zeroizing::new))
}

fn import_with_encrypt(
    conn: &mut Connection,
    accounts: Vec<ImportedAccount>,
    encrypt: impl Fn(&str) -> Result<String, String>,
    decrypt: impl Fn(&str) -> Option<Zeroizing<String>>,
) -> Result<Vec<CodexAccountSummary>, String> {
    // Validate and encrypt the whole batch before the first database mutation.
    let encrypted = accounts
        .into_iter()
        .map(|account| {
            encrypt(&account.auth_json)
                .map(|cipher| (account, cipher))
                .map_err(|_| "加密 Codex 账号失败".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let tx = conn.transaction().map_err(|_| "保存 Codex 账号失败")?;
    for (account, cipher) in encrypted {
        let previous: Option<(i64, String)> = tx.query_row(
            "SELECT id,auth_ciphertext FROM codex_accounts WHERE identity=?1",
            [&account.identity],
            |row| Ok((row.get(0)?,row.get(1)?)),
        ).optional().map_err(|_| "查询 Codex 账号失败")?;
        let tags = serde_json::to_string(&account.tags).map_err(|_| "标签参数无效")?;
        tx.execute("INSERT INTO codex_accounts(identity,label,email,account_id,auth_mode,plan,note,tags_json,auth_ciphertext,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(identity) DO UPDATE SET email=excluded.email,account_id=excluded.account_id,plan=excluded.plan,auth_ciphertext=excluded.auth_ciphertext,last_error=NULL,updated_at=MAX(codex_accounts.updated_at+1,excluded.updated_at)", params![account.identity, account.label, account.email, account.account_id, account.auth_mode, account.plan, account.note, tags, cipher, chrono::Utc::now().timestamp_millis()]).map_err(|_| "保存 Codex 账号失败")?;
        let account_id: i64 = tx.query_row("SELECT id FROM codex_accounts WHERE identity=?1", [&account.identity], |row| row.get(0)).map_err(|_| "读取 Codex 账号失败")?;
        let (message, changes, is_new) = if let Some((_, previous_cipher)) = previous {
            let prior = decrypt(&previous_cipher);
            let changes = token_changes(prior.as_deref().map(|value| value.as_str()), account.auth_json.as_str());
            let message = if changes.is_empty() { "账号已导入，凭据未变化".to_string() }
            else { format!("凭据通过导入更新（{}）", changes.join("、")) };
            (message, changes, false)
        } else {
            ("账号首次导入".to_string(), token_changes(None, &account.auth_json), true)
        };
        let details = serde_json::json!({"attempts":[{
            "transport":"本地导入",
            "status":null,
            "outcome":"completed",
            "request":{"authMode":account.auth_mode,"credentialFields":changes,"credentialValues":"已省略"},
            "response":{"result":if is_new {"首次保存"} else {"更新保存"},"credentialValues":"本机加密保存"}
        }]});
        let details = serde_json::to_string(&details).map_err(|_| "保存 Codex 账号日志失败")?;
        tx.execute("INSERT INTO codex_account_events(account_id,event_type,message,details_json,created_at) VALUES(?1,'import',?2,?3,?4)", params![account_id,message,details,chrono::Utc::now().timestamp_millis()]).map_err(|_| "保存 Codex 账号日志失败")?;
    }
    tx.commit().map_err(|_| "保存 Codex 账号失败")?;
    list(conn)
}

pub fn metadata(
    conn: &Connection,
    input: &AccountMetadataInput,
) -> Result<CodexAccountSummary, String> {
    crate::core::codex::validate_metadata(input)?;
    let tags: Vec<_> = input.tags.iter().map(|v| v.trim()).collect();
    let changed = conn.execute("UPDATE codex_accounts SET label=?1,note=?2,tags_json=?3,updated_at=MAX(updated_at+1,?4) WHERE id=?5", params![input.label.trim(), input.note, serde_json::to_string(&tags).map_err(|_| "标签参数无效")?, chrono::Utc::now().timestamp_millis(), input.id]).map_err(|_| "保存 Codex 备注失败")?;
    if changed != 1 {
        return Err("Codex 账号不存在".into());
    }
    get(conn, input.id)
}

pub fn save_refresh(
    conn: &Connection,
    id: i64,
    expected: i64,
    auth: &str,
    quota: Option<&QuotaSnapshot>,
    plan: Option<&str>,
    error: Option<&str>,
) -> Result<(), String> {
    save_refresh_with_encrypt(conn, id, expected, auth, quota, plan, error, None, encrypt_secret)
}

pub fn save_refresh_action_with_details(
    conn: &Connection,
    id: i64,
    expected: i64,
    auth: &str,
    quota: Option<&QuotaSnapshot>,
    plan: Option<&str>,
    error: Option<&str>,
    action: &str,
    details: Option<&serde_json::Value>,
) -> Result<(), String> {
    save_refresh_with_encrypt_and_details(conn, id, expected, auth, quota, plan, error, Some(action), details, encrypt_secret)
}

fn save_refresh_with_encrypt(
    conn: &Connection,
    id: i64,
    expected: i64,
    auth: &str,
    quota: Option<&QuotaSnapshot>,
    plan: Option<&str>,
    error: Option<&str>,
    action: Option<&str>,
    encrypt: impl Fn(&str) -> Result<String, String>,
) -> Result<(), String> {
    save_refresh_with_encrypt_and_details(conn, id, expected, auth, quota, plan, error, action, None, encrypt)
}

fn save_refresh_with_encrypt_and_details(
    conn: &Connection,
    id: i64,
    expected: i64,
    auth: &str,
    quota: Option<&QuotaSnapshot>,
    plan: Option<&str>,
    error: Option<&str>,
    action: Option<&str>,
    details: Option<&serde_json::Value>,
    encrypt: impl Fn(&str) -> Result<String, String>,
) -> Result<(), String> {
    let previous_cipher: String = conn.query_row("SELECT auth_ciphertext FROM codex_accounts WHERE id=?1 AND updated_at=?2 AND deleted_at IS NULL", params![id,expected], |row| row.get(0)).map_err(|_| "Codex 账号已变更，请重新刷新")?;
    let previous = crate::core::storage::decrypt_secret(&previous_cipher).ok();
    let changes = token_changes(previous.as_deref(), auth);
    let cipher = encrypt(auth).map_err(|_| "保存 Codex 认证状态失败")?;
    let quota = quota
        .map(serde_json::to_string)
        .transpose()
        .map_err(|_| "保存 Codex 额度失败")?;
    let changed = conn.execute("UPDATE codex_accounts SET auth_ciphertext=?1,quota_json=COALESCE(?2,quota_json),plan=COALESCE(?3,plan),last_error=?4,updated_at=MAX(updated_at+1,?5) WHERE id=?6 AND updated_at=?7", params![cipher, quota, plan, error, chrono::Utc::now().timestamp_millis(), id, expected]).map_err(|_| "保存 Codex 额度失败")?;
    if changed != 1 {
        return Err("Codex 账号已变更，请重新刷新".into());
    }
    if let Some(action) = action {
        let message = if changes.is_empty() {
            action.to_string()
        } else {
            format!("{action}；登录凭据更新（{}）", changes.join("、"))
        };
        append_event(conn, id, "refresh", &message, details)?;
    } else if !changes.is_empty() {
        append_event(conn, id, "token_refresh", &format!("登录凭据已更新（{}）", changes.join("、")), None)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{
        codex::auth,
        crypto::{decrypt_secret_with_key, encrypt_secret_with_key},
        database::CODEX_SCHEMA,
    };
    fn accounts(names: &[&str]) -> Vec<ImportedAccount> {
        names
            .iter()
            .map(|name| {
                auth::parse_account(
                    &serde_json::json!({"OPENAI_API_KEY":format!("invalid-fixture-{name}")}),
                )
                .unwrap()
            })
            .collect()
    }
    fn encrypt(value: &str) -> Result<String, String> {
        encrypt_secret_with_key(value, &[7u8; 32])
    }
    fn decrypt(value: &str) -> Option<Zeroizing<String>> {
        decrypt_secret_with_key(value, &[7u8; 32]).ok().map(Zeroizing::new)
    }
    #[test]
    fn imports_encrypt_preserve_metadata_and_rollback_on_failure() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(CODEX_SCHEMA).unwrap();
        conn.execute_batch(crate::core::database::CODEX_ACCOUNT_EVENTS_SCHEMA).unwrap();
        import_with_encrypt(&mut conn, accounts(&["a"]), encrypt, decrypt).unwrap();
        let saved = list(&conn).unwrap().remove(0);
        metadata(
            &conn,
            &AccountMetadataInput {
                id: saved.id,
                label: "工作账号".into(),
                note: "备注".into(),
                tags: vec!["测试".into()],
            },
        )
        .unwrap();
        import_with_encrypt(&mut conn, accounts(&["a"]), encrypt, decrypt).unwrap();
        let record = list(&conn).unwrap().remove(0);
        assert_eq!(record.label, "工作账号");
        assert_eq!(record.tags, vec!["测试"]);
        let events = events(&conn, record.id).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].message, "账号首次导入");
        assert_eq!(events[0].message, "账号已导入，凭据未变化");
        let serialized_events = serde_json::to_string(&events).unwrap();
        assert!(serialized_events.contains("本机加密保存"));
        assert!(!serialized_events.contains("invalid-fixture"));
        let cipher: String = conn
            .query_row("SELECT auth_ciphertext FROM codex_accounts", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(!cipher.contains("invalid-fixture"));
        assert!(decrypt_secret_with_key(&cipher, &[7u8; 32])
            .unwrap()
            .contains("invalid-fixture"));
        let summary = serde_json::to_string(&record).unwrap();
        assert!(!summary.contains("invalid-fixture"));
        assert!(!summary.contains("auth_ciphertext"));
        conn.execute_batch("CREATE TRIGGER reject_fixture BEFORE INSERT ON codex_accounts WHEN (SELECT COUNT(*) FROM codex_accounts)>1 BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
        assert!(import_with_encrypt(&mut conn, accounts(&["b", "c"]), encrypt, decrypt).is_err());
        assert_eq!(list(&conn).unwrap().len(), 1);
        assert!(import_with_encrypt(&mut conn, accounts(&["b"]), |_| Err(
            "encryption-unavailable".into()
        ), decrypt)
        .is_err());
        assert_eq!(list(&conn).unwrap().len(), 1);
    }
    #[test]
    fn refresh_compare_and_swap_does_not_overwrite_concurrent_edit() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(CODEX_SCHEMA).unwrap();
        conn.execute_batch(crate::core::database::CODEX_ACCOUNT_EVENTS_SCHEMA).unwrap();
        let account = import_with_encrypt(&mut conn, accounts(&["a"]), encrypt, decrypt)
            .unwrap()
            .remove(0);
        metadata(
            &conn,
            &AccountMetadataInput {
                id: account.id,
                label: "新名称".into(),
                note: "".into(),
                tags: vec![],
            },
        )
        .unwrap();
        assert!(save_refresh_with_encrypt(
            &conn,
            account.id,
            account.updated_at,
            "{}",
            None,
            None,
            None,
            None,
            encrypt
        )
        .is_err());
        assert_eq!(get(&conn, account.id).unwrap().label, "新名称");
    }
    #[test]
    fn credential_change_events_name_changed_token_fields_without_values() {
        let before = r#"{"tokens":{"access_token":"test-only-access-a","refresh_token":"test-only-refresh"}}"#;
        let after = r#"{"tokens":{"access_token":"test-only-access-b","refresh_token":"test-only-refresh"}}"#;
        let changed = token_changes(Some(before), after);
        assert_eq!(changed, vec!["Access Token"]);
        assert!(!changed.iter().any(|value| value.contains("test-only")));
    }
    #[test]
    fn refresh_events_record_changed_token_names_without_token_values() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(CODEX_SCHEMA).unwrap();
        conn.execute_batch(crate::core::database::CODEX_ACCOUNT_EVENTS_SCHEMA).unwrap();
        let account = import_with_encrypt(&mut conn, accounts(&["log-refresh"]), encrypt, decrypt)
            .unwrap()
            .remove(0);
        let updated = r#"{"tokens":{"access_token":"fixture-new-access","refresh_token":"fixture-new-refresh"}}"#;
        let details = serde_json::json!({
            "attempts":[{
                "transport":"HTTP",
                "method":"GET",
                "path":"/backend-api/wham/usage",
                "request":{"headers":"Authorization 已省略"},
                "status":200,
                "outcome":"completed",
                "response":{"quota":{"windows":[]}}
            }]
        });

        save_refresh_with_encrypt_and_details(
            &conn,
            account.id,
            account.updated_at,
            updated,
            None,
            None,
            None,
            Some("手动令牌续期成功"),
            Some(&details),
            encrypt,
        )
        .unwrap();

        let records = events(&conn, account.id).unwrap();
        assert_eq!(records[0].event_type, "refresh");
        assert_eq!(
            records[0].message,
            "手动令牌续期成功；登录凭据更新（Access Token、Refresh Token）"
        );
        assert_eq!(records[0].details, Some(details));
        let serialized = serde_json::to_string(&records).unwrap();
        assert!(!serialized.contains("fixture-old"));
        assert!(!serialized.contains("fixture-new"));
    }
}
