//! Shared soft-delete helpers for the recycle bin.
//!
//! Every recyclable table keeps its rows and gains a `deleted_at` column:
//! `NULL` means live, a timestamp means "in the bin". Restoring clears the
//! column; purging is the only path that issues a real `DELETE`.
//!
//! Table and column names are validated against a fixed allowlist before they
//! reach SQL, because they cannot be bound as query parameters. Identifiers may
//! be integers (most tables) or text (`authenticator_entries`), so both forms
//! are bound as query parameters rather than interpolated.
use rusqlite::Connection;
use rusqlite::types::Value;

/// How a table's primary key is addressed.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum KeyKind {
    Integer,
    Text,
}

/// A recyclable table: its id, the label shown in the shared panel, how its
/// rows are keyed, and which column names the row. Adding a data type means
/// adding it here, giving its table a `deleted_at` column, and passing the
/// matching kind through the helpers.
pub const RECYCLABLE: [(&str, &str, KeyKind, &str); 8] = [
    ("panel_connections", "面板连接", KeyKind::Integer, "name"),
    ("managed_hosts", "SSH 主机", KeyKind::Integer, "name"),
    ("flow_connections", "云效流水线", KeyKind::Integer, "name"),
    ("memo_notes", "备忘录", KeyKind::Integer, "title"),
    ("cloud_accounts", "云账号", KeyKind::Integer, "account_name"),
    ("certificates", "HTTPS 证书", KeyKind::Integer, "primary_domain"),
    ("authenticator_entries", "身份验证器", KeyKind::Text, "name"),
    ("codex_accounts", "Codex 账号", KeyKind::Integer, "label"),
];

/// The column that names a row in the shared panel.
pub fn display_column(table: &str) -> Result<&'static str, String> {
    table_entry(table).map(|(_, _, _, column)| column)
}

/// Credential columns per table, blanked once a trashed row ages out. These
/// names are also checked against the allowlist because they reach SQL.
/// Tables without secrets (memo notes, panels, hosts, pipelines) map to an
/// empty list and are never touched.
pub const SECRET_COLUMNS: [(&str, &[&str]); 8] = [
    ("panel_connections", &["api_key_ciphertext"]),
    ("managed_hosts", &["password_ciphertext", "private_key_ciphertext", "key_passphrase_ciphertext"]),
    ("flow_connections", &["token_ciphertext"]),
    ("memo_notes", &[]),
    ("cloud_accounts", &["secret_ciphertext"]),
    ("certificates", &["certificate_pem_ciphertext", "private_key_ciphertext"]),
    ("authenticator_entries", &["ciphertext"]),
    ("codex_accounts", &["auth_ciphertext", "details_ciphertext"]),
];

/// Credential columns for a table, validated against the allowlist.
pub fn secret_columns(table: &str) -> Result<&'static [&'static str], String> {
    let name = table_name(table)?;
    SECRET_COLUMNS
        .iter()
        .find(|(key, _)| *key == name)
        .map(|(_, columns)| *columns)
        .ok_or_else(|| "不支持回收站的数据类型".to_string())
}

/// Blanks the credential columns of rows trashed before `cutoff`, keeping the
/// record itself restorable. This shrinks the key footprint of the bin without
/// losing the metadata a user needs to decide what to purge. Returns the number
/// of rows whose secrets were cleared.
pub fn scrub_expired(conn: &Connection, table: &str, cutoff: i64) -> Result<u64, String> {
    let (name, _, _, _) = table_entry(table)?;
    let columns = secret_columns(name)?;
    if columns.is_empty() {
        return Ok(0);
    }
    // A database mid-migration may not have every table yet.
    let exists: Option<String> = conn
        .query_row("SELECT name FROM sqlite_master WHERE type='table' AND name=?1", [name], |row| row.get(0))
        .ok();
    if exists.is_none() {
        return Ok(0);
    }
    let assignments = columns
        .iter()
        .map(|column| if name == "codex_accounts" && *column == "auth_ciphertext" { format!("{column}=''") } else { format!("{column}=NULL") })
        .collect::<Vec<_>>()
        .join(",");
    let changed = conn
        .execute(
            &format!(
                "UPDATE {name} SET {assignments} WHERE deleted_at IS NOT NULL AND deleted_at < ?1 AND ({guard})",
                guard = columns.iter().map(|column| if name == "codex_accounts" && *column == "auth_ciphertext" { format!("{column} IS NOT NULL AND {column}<>''") } else { format!("{column} IS NOT NULL") }).collect::<Vec<_>>().join(" OR ")
            ),
            [cutoff],
        )
        .map_err(|error| error.to_string())?;
    Ok(changed as u64)
}

/// Same as `scrub_expired` across every recyclable type; returns rows touched.
pub fn scrub_all_expired(conn: &Connection, cutoff: i64) -> Result<u64, String> {
    let mut total = 0;
    for (table, _, _, _) in RECYCLABLE {
        total += scrub_expired(conn, table, cutoff)?;
    }
    Ok(total)
}

/// Resolves a table id to its canonical entry, rejecting anything unknown.
pub fn table_entry(table: &str) -> Result<(&'static str, &'static str, KeyKind, &'static str), String> {
    RECYCLABLE
        .iter()
        .find(|(name, _, _, _)| *name == table)
        .map(|(name, label, key, column)| (*name, *label, *key, *column))
        .ok_or_else(|| "不支持回收站的数据类型".to_string())
}

/// Rejects anything that is not a known recyclable table.
pub fn table_name(table: &str) -> Result<&'static str, String> {
    table_entry(table).map(|(name, _, _, _)| name)
}

pub fn key_kind(table: &str) -> Result<KeyKind, String> {
    table_entry(table).map(|(_, _, key, _)| key)
}

/// Live rows only. Applies to every read path so trashed rows never surface in
/// normal lists, and `get` reports them as missing.
pub fn live_filter(table: &str) -> Result<&'static str, String> {
    table_name(table)?;
    Ok(" AND deleted_at IS NULL")
}

/// Binds ids as parameters after validating them against the table's key kind.
fn bind_ids(table: &str, kind: KeyKind, ids: &[Value]) -> Result<Vec<Value>, String> {
    if ids.is_empty() {
        return Err("请选择要操作的记录".into());
    }
    for id in ids {
        let valid = match (kind, id) {
            (KeyKind::Integer, Value::Integer(value)) => *value > 0,
            (KeyKind::Text, Value::Text(value)) => !value.trim().is_empty(),
            _ => false,
        };
        if !valid {
            return Err("记录标识无效".into());
        }
    }
    Ok(ids.to_vec())
}

fn placeholders(count: usize) -> String {
    std::iter::repeat("?").take(count).collect::<Vec<_>>().join(",")
}

/// Moves rows into the bin and reports how many were actually moved.
pub fn soft_delete(conn: &Connection, table: &str, ids: &[Value], now: i64) -> Result<u64, String> {
    let (table, _, kind, _) = table_entry(table)?;
    let ids = bind_ids(table, kind, ids)?;
    let marks = placeholders(ids.len());
    let mut params = vec![Value::Integer(now)];
    params.extend(ids.iter().cloned());
    let changed = conn
        .execute(&format!("UPDATE {table} SET deleted_at=? WHERE id IN ({marks}) AND deleted_at IS NULL"), rusqlite::params_from_iter(params.iter()))
        .map_err(|error| error.to_string())?;
    Ok(changed as u64)
}

/// Returns rows to the live set. Only trashed rows are affected.
pub fn restore(conn: &Connection, table: &str, ids: &[Value], now: i64) -> Result<u64, String> {
    let (table, _, kind, _) = table_entry(table)?;
    let ids = bind_ids(table, kind, ids)?;
    let marks = placeholders(ids.len());
    let mut params = vec![Value::Integer(now)];
    params.extend(ids.iter().cloned());
    let changed = conn
        .execute(&format!("UPDATE {table} SET deleted_at=NULL, updated_at=? WHERE id IN ({marks}) AND deleted_at IS NOT NULL"), rusqlite::params_from_iter(params.iter()))
        .map_err(|error| error.to_string())?;
    Ok(changed as u64)
}

/// Irreversibly removes trashed rows. Live rows are never purged.
pub fn purge(conn: &Connection, table: &str, ids: &[Value]) -> Result<u64, String> {
    let (table, _, kind, _) = table_entry(table)?;
    let ids = bind_ids(table, kind, ids)?;
    let marks = placeholders(ids.len());
    let changed = conn
        .execute(&format!("DELETE FROM {table} WHERE id IN ({marks}) AND deleted_at IS NOT NULL"), rusqlite::params_from_iter(ids.iter()))
        .map_err(|error| error.to_string())?;
    Ok(changed as u64)
}

/// Every trashed id in a table, used by the "empty the bin" command.
pub fn trashed_ids(conn: &Connection, table: &str) -> Result<Vec<Value>, String> {
    let (table, _, _, column) = table_entry(table)?;
    let mut statement = conn
        .prepare(&format!("SELECT id FROM {table} WHERE deleted_at IS NOT NULL"))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| match key_kind(table).unwrap_or(KeyKind::Integer) {
            KeyKind::Integer => Ok(Value::Integer(row.get(0)?)),
            KeyKind::Text => Ok(Value::Text(row.get(0)?)),
        })
        .map_err(|error| error.to_string())?;
    rows.map(|item| item.map_err(|error| error.to_string())).collect()
}

/// `(id, display name, deleted_at)` rows for the shared recycle bin panel.
pub fn trashed_rows(conn: &Connection, table: &str) -> Result<Vec<(Value, String, i64)>, String> {
    let (table, _, _, column) = table_entry(table)?;
    let mut statement = conn
        .prepare(&format!(
            "SELECT id, {column}, deleted_at FROM {table} WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, rowid DESC"
        ))
        .map_err(|error| error.to_string())?;
    let (_, _, kind, _) = table_entry(table)?;
    let rows = statement
        .query_map([], |row| {
            let id = match kind {
                KeyKind::Integer => Value::Integer(row.get(0)?),
                KeyKind::Text => Value::Text(row.get(0)?),
            };
            Ok((id, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))
        })
        .map_err(|error| error.to_string())?;
    rows.map(|item| item.map_err(|error| error.to_string())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE panel_connections(id INTEGER PRIMARY KEY, name TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
             CREATE TABLE authenticator_entries(id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);",
        )
        .unwrap();
        conn.execute("INSERT INTO panel_connections(id,name,updated_at) VALUES(1,'面板',10)", []).unwrap();
        conn.execute("INSERT INTO authenticator_entries(id,name,updated_at) VALUES('abc','验证器',10)", []).unwrap();
        conn
    }

    #[test]
    fn unknown_table_is_rejected() {
        let conn = db();
        // Table names cannot be bound, so anything off the allowlist must fail
        // before it can reach SQL.
        let ids = [Value::Integer(1)];
        assert!(soft_delete(&conn, "cloud_accounts_wrong", &ids, 20).is_err());
        assert!(soft_delete(&conn, "panel_connections; DROP TABLE managed_hosts", &ids, 20).is_err());
        assert!(trashed_rows(&conn, "sqlite_master").is_err());
    }

    #[test]
    fn empty_and_mismatched_ids_are_rejected() {
        let conn = db();
        assert!(soft_delete(&conn, "panel_connections", &[], 20).is_err());
        assert!(soft_delete(&conn, "panel_connections", &[Value::Integer(0)], 20).is_err());
        assert!(soft_delete(&conn, "panel_connections", &[Value::Integer(-1)], 20).is_err());
        // An integer id against a text-keyed table is a caller bug, not input.
        assert!(soft_delete(&conn, "authenticator_entries", &[Value::Integer(1)], 20).is_err());
        assert!(soft_delete(&conn, "authenticator_entries", &[Value::Text("  ".into())], 20).is_err());
    }

    #[test]
    fn integer_key_round_trip() {
        let conn = db();
        let ids = [Value::Integer(1)];
        assert_eq!(soft_delete(&conn, "panel_connections", &ids, 20).unwrap(), 1);
        assert_eq!(trashed_rows(&conn, "panel_connections").unwrap().len(), 1);
        assert_eq!(soft_delete(&conn, "panel_connections", &ids, 30).unwrap(), 0);
        assert_eq!(restore(&conn, "panel_connections", &ids, 40).unwrap(), 1);
        assert!(trashed_rows(&conn, "panel_connections").unwrap().is_empty());
        soft_delete(&conn, "panel_connections", &ids, 50).unwrap();
        assert_eq!(purge(&conn, "panel_connections", &ids).unwrap(), 1);
        assert_eq!(purge(&conn, "panel_connections", &ids).unwrap(), 0);
    }

    #[test]
    fn text_key_round_trip() {
        let conn = db();
        let ids = [Value::Text("abc".into())];
        assert_eq!(soft_delete(&conn, "authenticator_entries", &ids, 20).unwrap(), 1);
        let rows = trashed_rows(&conn, "authenticator_entries").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, Value::Text("abc".into()));
        assert_eq!(restore(&conn, "authenticator_entries", &ids, 30).unwrap(), 1);
        soft_delete(&conn, "authenticator_entries", &ids, 40).unwrap();
        assert_eq!(purge(&conn, "authenticator_entries", &ids).unwrap(), 1);
    }

    #[test]
    fn purge_never_removes_live_rows() {
        let conn = db();
        let ids = [Value::Integer(1)];
        assert_eq!(purge(&conn, "panel_connections", &ids).unwrap(), 0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM panel_connections", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn trashed_ids_lists_only_deleted_rows() {
        let conn = db();
        assert!(trashed_ids(&conn, "panel_connections").unwrap().is_empty());
        soft_delete(&conn, "panel_connections", &[Value::Integer(1)], 20).unwrap();
        assert_eq!(trashed_ids(&conn, "panel_connections").unwrap(), vec![Value::Integer(1)]);
    }

    /// Every recyclable type follows the same contract: a deleted row leaves the
    /// live set, is restorable, and is only really removed by an explicit purge.
    fn all_types() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE panel_connections(id INTEGER PRIMARY KEY, name TEXT NOT NULL, updated_at INTEGER, deleted_at INTEGER);
             CREATE TABLE managed_hosts(id INTEGER PRIMARY KEY, name TEXT NOT NULL, updated_at INTEGER, deleted_at INTEGER);
             CREATE TABLE flow_connections(id INTEGER PRIMARY KEY, name TEXT NOT NULL, updated_at INTEGER, deleted_at INTEGER);
             CREATE TABLE memo_notes(id INTEGER PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER, deleted_at INTEGER);
             CREATE TABLE cloud_accounts(id INTEGER PRIMARY KEY, account_name TEXT NOT NULL, updated_at INTEGER, deleted_at INTEGER);
             CREATE TABLE certificates(id INTEGER PRIMARY KEY, primary_domain TEXT NOT NULL, updated_at INTEGER, deleted_at INTEGER);
             CREATE TABLE authenticator_entries(id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at INTEGER, deleted_at INTEGER);
             CREATE TABLE codex_accounts(id INTEGER PRIMARY KEY, label TEXT NOT NULL, updated_at INTEGER, deleted_at INTEGER);",
        )
        .unwrap();
        for (table, _, _, _) in RECYCLABLE {
            let key = match key_kind(table).unwrap() {
                KeyKind::Integer => "(1,'示例',10)".to_string(),
                KeyKind::Text => "('key-1','示例',10)".to_string(),
            };
            conn.execute(&format!("INSERT INTO {table}(id,{},updated_at) VALUES {key}", display_column(table).unwrap()), []).unwrap();
        }
        conn
    }

    #[test]
    fn every_recyclable_type_supports_the_full_lifecycle() {
        let conn = all_types();
        for (table, label, kind, column) in RECYCLABLE {
            let ids = match kind {
                KeyKind::Integer => vec![Value::Integer(1)],
                KeyKind::Text => vec![Value::Text("key-1".into())],
            };
            assert_eq!(soft_delete(&conn, table, &ids, 20).unwrap(), 1, "{label} 软删除");
            let rows = trashed_rows(&conn, table).unwrap();
            assert_eq!(rows.len(), 1, "{label} 应出现在回收站");
            assert_eq!(rows[0].1, "示例", "{label} 应使用 {column} 作为显示名");
            assert_eq!(restore(&conn, table, &ids, 30).unwrap(), 1, "{label} 恢复");
            assert!(trashed_rows(&conn, table).unwrap().is_empty(), "{label} 恢复后应移出回收站");
            soft_delete(&conn, table, &ids, 40).unwrap();
            assert_eq!(purge(&conn, table, &ids).unwrap(), 1, "{label} 彻底删除");
        }
    }

    #[test]
    fn a_second_delete_does_not_double_count() {
        let conn = all_types();
        let ids = [Value::Integer(1)];
        assert_eq!(soft_delete(&conn, "cloud_accounts", &ids, 20).unwrap(), 1);
        assert_eq!(soft_delete(&conn, "cloud_accounts", &ids, 30).unwrap(), 0);
        assert_eq!(soft_delete(&conn, "certificates", &ids, 30).unwrap(), 1);
        // Purging a still-live row must never remove it.
        assert_eq!(purge(&conn, "codex_accounts", &ids).unwrap(), 0);
        soft_delete(&conn, "codex_accounts", &ids, 40).unwrap();
        assert_eq!(purge(&conn, "codex_accounts", &ids).unwrap(), 1);
    }

    #[test]
    fn deleting_one_account_leaves_other_rows_alone() {
        let conn = all_types();
        conn.execute("INSERT INTO cloud_accounts(id,account_name,updated_at) VALUES(2,'另一个',10)", []).unwrap();
        soft_delete(&conn, "cloud_accounts", &[Value::Integer(1)], 20).unwrap();
        // Only the targeted row is trashed.
        assert_eq!(trashed_rows(&conn, "cloud_accounts").unwrap().len(), 1);
        assert_eq!(purge(&conn, "cloud_accounts", &[Value::Integer(2)]).unwrap(), 0);
    }

    fn secrets_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE cloud_accounts(id INTEGER PRIMARY KEY, account_name TEXT NOT NULL, secret_ciphertext TEXT, updated_at INTEGER, deleted_at INTEGER);
             CREATE TABLE managed_hosts(id INTEGER PRIMARY KEY, name TEXT NOT NULL, password_ciphertext TEXT, private_key_ciphertext TEXT, key_passphrase_ciphertext TEXT, updated_at INTEGER, deleted_at INTEGER);
             CREATE TABLE certificates(id INTEGER PRIMARY KEY, primary_domain TEXT NOT NULL, certificate_pem_ciphertext TEXT, private_key_ciphertext TEXT, updated_at INTEGER, deleted_at INTEGER);
             CREATE TABLE authenticator_entries(id TEXT PRIMARY KEY, name TEXT NOT NULL, ciphertext TEXT, updated_at INTEGER, deleted_at INTEGER);
             CREATE TABLE memo_notes(id INTEGER PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER, deleted_at INTEGER);",
        )
        .unwrap();
        conn.execute("INSERT INTO cloud_accounts VALUES(1,'阿里云','secret-a',10,NULL)", []).unwrap();
        conn.execute("INSERT INTO managed_hosts VALUES(1,'主机','pw','pk','kp',10,NULL)", []).unwrap();
        conn.execute("INSERT INTO certificates VALUES(1,'example.test','pem','key',10,NULL)", []).unwrap();
        conn.execute("INSERT INTO authenticator_entries VALUES('k1','GitHub','enc',10,NULL)", []).unwrap();
        conn.execute("INSERT INTO memo_notes VALUES(1,'笔记',10,NULL)", []).unwrap();
        conn
    }

    fn secret_of(conn: &Connection, table: &str, id: &str, column: &str) -> Option<String> {
        conn.query_row(&format!("SELECT {column} FROM {table} WHERE id=?1"), [id], |row| row.get::<_, Option<String>>(0)).unwrap()
    }

    #[test]
    fn scrubbing_clears_only_expired_secrets() {
        let conn = secrets_db();
        let ids = [Value::Integer(1)];
        for table in ["cloud_accounts", "managed_hosts", "certificates"] {
            soft_delete(&conn, table, &ids, 100).unwrap();
        }
        // Nothing has aged out yet: cutoff is older than every delete.
        assert_eq!(scrub_all_expired(&conn, 50).unwrap(), 0);
        assert_eq!(secret_of(&conn, "cloud_accounts", "1", "secret_ciphertext"), Some("secret-a".into()));
        // Once the cutoff passes the delete time the credentials go, rows stay.
        assert_eq!(scrub_all_expired(&conn, 200).unwrap(), 3);
        assert_eq!(secret_of(&conn, "cloud_accounts", "1", "secret_ciphertext"), None);
        assert_eq!(secret_of(&conn, "certificates", "1", "private_key_ciphertext"), None);
        assert_eq!(trashed_rows(&conn, "cloud_accounts").unwrap().len(), 1);
        // Running again is a no-op rather than a re-count.
        assert_eq!(scrub_all_expired(&conn, 50).unwrap(), 0);
    }

    #[test]
    fn scrubbing_clears_every_secret_column_of_a_host() {
        let conn = secrets_db();
        soft_delete(&conn, "managed_hosts", &[Value::Integer(1)], 100).unwrap();
        scrub_expired(&conn, "managed_hosts", 200).unwrap();
        for column in ["password_ciphertext", "private_key_ciphertext", "key_passphrase_ciphertext"] {
            assert_eq!(secret_of(&conn, "managed_hosts", "1", column), None, "{column} 应被清空");
        }
    }

    #[test]
    fn scrubbing_text_keyed_entries_and_skipping_secretless_tables() {
        let conn = secrets_db();
        soft_delete(&conn, "authenticator_entries", &[Value::Text("k1".into())], 100).unwrap();
        soft_delete(&conn, "memo_notes", &[Value::Integer(1)], 100).unwrap();
        scrub_all_expired(&conn, 200).unwrap();
        assert_eq!(secret_of(&conn, "authenticator_entries", "k1", "ciphertext"), None);
        // A table with no secrets is left completely alone.
        assert_eq!(secret_columns("memo_notes").unwrap().len(), 0);
        assert_eq!(scrub_expired(&conn, "memo_notes", 50).unwrap(), 0);
    }

    #[test]
    fn live_rows_are_never_scrubbed() {
        let conn = secrets_db();
        // A live account keeps its secret no matter how old the cutoff is.
        assert_eq!(scrub_all_expired(&conn, i64::MAX).unwrap(), 0);
        assert_eq!(secret_of(&conn, "cloud_accounts", "1", "secret_ciphertext"), Some("secret-a".into()));
    }

    #[test]
    fn a_scrubbed_row_can_still_be_restored() {
        let conn = secrets_db();
        let ids = [Value::Integer(1)];
        soft_delete(&conn, "cloud_accounts", &ids, 100).unwrap();
        scrub_expired(&conn, "cloud_accounts", 200).unwrap();
        assert_eq!(restore(&conn, "cloud_accounts", &ids, 200).unwrap(), 1);
        // The record comes back without its (already cleared) secret.
        assert_eq!(trashed_rows(&conn, "cloud_accounts").unwrap().len(), 0);
        assert_eq!(secret_of(&conn, "cloud_accounts", "1", "secret_ciphertext"), None);
    }
}
