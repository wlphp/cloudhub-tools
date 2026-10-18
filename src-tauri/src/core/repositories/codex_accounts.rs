use crate::core::codex::{
    auth::ImportedAccount, AccountMetadataInput, CodexAccountSummary, QuotaSnapshot,
};
use crate::core::storage::{decrypt_secret, encrypt_secret};
use rusqlite::{params, Connection};
use zeroize::Zeroizing;

const COLUMNS: &str =
    "id,label,email,account_id,auth_mode,plan,note,tags_json,quota_json,last_error,updated_at,(SELECT proxy_url FROM codex_account_controls WHERE account_id=codex_accounts.id),(SELECT benefits_json FROM codex_account_controls WHERE account_id=codex_accounts.id)";

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CodexAccountSummary> {
    Ok(CodexAccountSummary {
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
    import_with_encrypt(conn, accounts, encrypt_secret)
}

fn import_with_encrypt(
    conn: &mut Connection,
    accounts: Vec<ImportedAccount>,
    encrypt: impl Fn(&str) -> Result<String, String>,
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
        tx.execute("INSERT INTO codex_accounts(identity,label,email,account_id,auth_mode,plan,auth_ciphertext,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(identity) DO UPDATE SET email=excluded.email,account_id=excluded.account_id,plan=excluded.plan,auth_ciphertext=excluded.auth_ciphertext,last_error=NULL,updated_at=MAX(codex_accounts.updated_at+1,excluded.updated_at)", params![account.identity, account.label, account.email, account.account_id, account.auth_mode, account.plan, cipher, chrono::Utc::now().timestamp_millis()]).map_err(|_| "保存 Codex 账号失败")?;
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
    save_refresh_with_encrypt(conn, id, expected, auth, quota, plan, error, encrypt_secret)
}

fn save_refresh_with_encrypt(
    conn: &Connection,
    id: i64,
    expected: i64,
    auth: &str,
    quota: Option<&QuotaSnapshot>,
    plan: Option<&str>,
    error: Option<&str>,
    encrypt: impl Fn(&str) -> Result<String, String>,
) -> Result<(), String> {
    let cipher = encrypt(auth).map_err(|_| "保存 Codex 认证状态失败")?;
    let quota = quota
        .map(serde_json::to_string)
        .transpose()
        .map_err(|_| "保存 Codex 额度失败")?;
    let changed = conn.execute("UPDATE codex_accounts SET auth_ciphertext=?1,quota_json=COALESCE(?2,quota_json),plan=COALESCE(?3,plan),last_error=?4,updated_at=MAX(updated_at+1,?5) WHERE id=?6 AND updated_at=?7", params![cipher, quota, plan, error, chrono::Utc::now().timestamp_millis(), id, expected]).map_err(|_| "保存 Codex 额度失败")?;
    if changed != 1 {
        return Err("Codex 账号已变更，请重新刷新".into());
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
    #[test]
    fn imports_encrypt_preserve_metadata_and_rollback_on_failure() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(CODEX_SCHEMA).unwrap();
        import_with_encrypt(&mut conn, accounts(&["a"]), encrypt).unwrap();
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
        import_with_encrypt(&mut conn, accounts(&["a"]), encrypt).unwrap();
        let record = list(&conn).unwrap().remove(0);
        assert_eq!(record.label, "工作账号");
        assert_eq!(record.tags, vec!["测试"]);
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
        assert!(import_with_encrypt(&mut conn, accounts(&["b", "c"]), encrypt).is_err());
        assert_eq!(list(&conn).unwrap().len(), 1);
        assert!(import_with_encrypt(&mut conn, accounts(&["b"]), |_| Err(
            "encryption-unavailable".into()
        ))
        .is_err());
        assert_eq!(list(&conn).unwrap().len(), 1);
    }
    #[test]
    fn refresh_compare_and_swap_does_not_overwrite_concurrent_edit() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(CODEX_SCHEMA).unwrap();
        let account = import_with_encrypt(&mut conn, accounts(&["a"]), encrypt)
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
            encrypt
        )
        .is_err());
        assert_eq!(get(&conn, account.id).unwrap().label, "新名称");
    }
}
