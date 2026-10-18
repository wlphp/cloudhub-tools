//! Global recycle bin commands.
//!
//! One entry point serves every soft-deleted data type, so the settings panel
//! does not need to know which feature owns a row. The table id is checked
//! against `trash::RECYCLABLE` before it can reach SQL.
use crate::core::{
    database::open_db,
    error::PlatformResult,
    repositories::{preferences, trash},
};
use rusqlite::types::Value;
use serde::Serialize;

/// Client preference key holding how many days a trashed row keeps its
/// credentials before they are blanked. `0` disables scrubbing entirely.
const SCRUB_DAYS_KEY: &str = "trash.scrub_days";
/// Default retention when the preference has never been written.
const DEFAULT_SCRUB_DAYS: i64 = 30;
const MIN_SCRUB_DAYS: i64 = 0;
const MAX_SCRUB_DAYS: i64 = 3650;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    /// Recycle bin table id, e.g. `panel_connections`.
    pub kind: String,
    /// Row id as a string; text-keyed tables (authenticator) need this form.
    pub id: String,
    pub title: String,
    pub deleted_at: i64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrashGroup {
    pub kind: String,
    pub label: String,
    pub items: Vec<TrashEntry>,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

async fn work<T: Send + 'static, F: FnOnce() -> Result<T, String> + Send + 'static>(
    f: F,
) -> PlatformResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| "回收站任务执行失败".to_string())
        .and_then(|result| result)
        .map_err(Into::into)
}

/// Current credential-retention setting, in days. `0` means keep forever.
fn scrub_days(conn: &rusqlite::Connection) -> i64 {
    preferences::list(conn)
        .ok()
        .and_then(|all| all.get(SCRUB_DAYS_KEY).cloned())
        .and_then(|raw| raw.parse::<i64>().ok())
        .filter(|days| (MIN_SCRUB_DAYS..=MAX_SCRUB_DAYS).contains(days))
        .unwrap_or(DEFAULT_SCRUB_DAYS)
}

/// Blanks credentials on rows that have outlived the retention window. Runs on
/// every listing so the bin self-cleans without a background timer.
fn apply_scrub_policy(conn: &rusqlite::Connection) -> Result<u64, String> {
    let days = scrub_days(conn);
    if days <= 0 {
        return Ok(0);
    }
    let cutoff = now() - days * 24 * 60 * 60 * 1000;
    trash::scrub_all_expired(conn, cutoff)
}

/// Every trashed row across all supported types, grouped by kind, plus the
/// current retention setting so the UI can render the selector.
#[tauri::command]
pub(crate) async fn trash_list() -> PlatformResult<TrashSnapshot> {
    work(|| {
        let conn = open_db()?;
        let scrubbed = apply_scrub_policy(&conn)?;
        let mut groups = Vec::new();
        for (table, label, _, _) in trash::RECYCLABLE {
            let items = trash::trashed_rows(&conn, table)?
                .into_iter()
                .map(|(id, title, deleted_at)| TrashEntry { kind: table.to_string(), id: id_to_string(&id), title, deleted_at })
                .collect();
            groups.push(TrashGroup { kind: table.to_string(), label: label.to_string(), items });
        }
        Ok(TrashSnapshot { groups, scrub_days: scrub_days(&conn), scrubbed_now: scrubbed })
    })
    .await
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrashSnapshot {
    pub groups: Vec<TrashGroup>,
    /// Credential retention in days; `0` keeps them forever.
    pub scrub_days: i64,
    /// Rows whose credentials were cleared by this call.
    pub scrubbed_now: u64,
}

/// Sets how long trashed rows keep their credentials. Out-of-range values are
/// rejected rather than silently clamped.
#[tauri::command]
pub(crate) async fn trash_set_scrub_days(days: i64) -> PlatformResult<i64> {
    work(move || {
        if !(MIN_SCRUB_DAYS..=MAX_SCRUB_DAYS).contains(&days) {
            return Err(format!("保留天数需在 {MIN_SCRUB_DAYS} 到 {MAX_SCRUB_DAYS} 之间"));
        }
        preferences::save(&open_db()?, SCRUB_DAYS_KEY, &days.to_string(), now())?;
        Ok(days)
    })
    .await
}

/// Clears credentials on every trashed row immediately, regardless of age.
#[tauri::command]
pub(crate) async fn trash_scrub_now() -> PlatformResult<u64> {
    work(|| trash::scrub_all_expired(&open_db()?, now() + 1)).await
}

/// Ids arrive as strings so text-keyed tables share one command shape. The
/// table's key kind decides how each value is interpreted.
fn parse_ids(kind: trash::KeyKind, ids: &[String]) -> Result<Vec<Value>, String> {
    ids.iter()
        .map(|raw| match kind {
            trash::KeyKind::Integer => match raw.parse::<i64>() {
                Ok(value) if value > 0 => Ok(Value::Integer(value)),
                _ => Err("记录标识无效".to_string()),
            },
            trash::KeyKind::Text => {
                if raw.trim().is_empty() {
                    Err("记录标识无效".to_string())
                } else {
                    Ok(Value::Text(raw.clone()))
                }
            }
        })
        .collect()
}

fn id_to_string(value: &Value) -> String {
    match value {
        Value::Integer(number) => number.to_string(),
        Value::Text(text) => text.clone(),
        // `bind_ids` rejects every other variant before a row is touched.
        other => format!("{other:?}"),
    }
}

#[tauri::command]
pub(crate) async fn trash_restore(kind: String, ids: Vec<String>) -> PlatformResult<u64> {
    work(move || {
        let key = trash::key_kind(&kind)?;
        let values = parse_ids(key, &ids)?;
        let count = trash::restore(&open_db()?, &kind, &values, now())?;
        if kind == "memo_notes" {
            rearm_note_reminders(&open_db()?, &values)?;
        }
        Ok(count)
    })
    .await
}

/// A restored memo keeps its schedule, so its pending reminder row is rebuilt.
fn rearm_note_reminders(conn: &rusqlite::Connection, ids: &[Value]) -> Result<(), String> {
    let numbers: Vec<i64> = ids
        .iter()
        .filter_map(|value| match value {
            Value::Integer(number) => Some(*number),
            _ => None,
        })
        .collect();
    if numbers.is_empty() {
        return Ok(());
    }
    let marks = std::iter::repeat("?").take(numbers.len()).collect::<Vec<_>>().join(",");
    let mut statement = conn
        .prepare(&format!("SELECT id, remind_at FROM memo_notes WHERE deleted_at IS NULL AND id IN ({marks})"))
        .map_err(|_| "恢复提醒失败")?;
    let pending: Vec<(i64, Option<i64>)> = statement
        .query_map(rusqlite::params_from_iter(numbers.iter()), |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|_| "恢复提醒失败")?
        .map(|item| item.map_err(|_| "恢复提醒失败".to_string()))
        .collect::<Result<_, _>>()?;
    for (id, remind_at) in pending {
        let Some(fire_at) = remind_at else { continue };
        conn.execute("DELETE FROM memo_reminders WHERE note_id=?1 AND fired_at IS NULL", [id]).map_err(|_| "恢复提醒失败")?;
        conn.execute("INSERT INTO memo_reminders(note_id,fire_at) VALUES(?1,?2)", rusqlite::params![id, fire_at]).map_err(|_| "恢复提醒失败")?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn trash_purge(kind: String, ids: Vec<String>) -> PlatformResult<u64> {
    work(move || {
        let key = trash::key_kind(&kind)?;
        trash::purge(&open_db()?, &kind, &parse_ids(key, &ids)?)
    })
    .await
}

/// Empties the whole bin. Every type is purged in one transaction so a failure
/// on any table leaves the bin untouched rather than half-cleared.
#[tauri::command]
pub(crate) async fn trash_empty() -> PlatformResult<u64> {
    work(|| {
        let conn = open_db()?;
        let tx = conn.unchecked_transaction().map_err(|_| "无法开始清空回收站")?;
        let mut total = 0;
        for (table, _, _, _) in trash::RECYCLABLE {
            let ids = trash::trashed_ids(&tx, table)?;
            if ids.is_empty() {
                continue;
            }
            total += trash::purge(&tx, table, &ids)?;
        }
        tx.commit().map_err(|_| "提交清空回收站失败")?;
        Ok(total)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE client_preferences(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE cloud_accounts(id INTEGER PRIMARY KEY, account_name TEXT NOT NULL, secret_ciphertext TEXT, updated_at INTEGER NOT NULL, deleted_at INTEGER);
             CREATE TABLE memo_notes(id INTEGER PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);",
        )
        .unwrap();
        // Both rows were just trashed, so any sane retention window keeps them.
        let fresh = now();
        conn.execute("INSERT INTO cloud_accounts VALUES(1,'阿里云','secret',10,?1)", [fresh]).unwrap();
        conn.execute("INSERT INTO memo_notes VALUES(1,'笔记',10,?1)", [fresh]).unwrap();
        conn
    }

    /// Backdates every trashed row so the retention window has elapsed.
    fn age_all(conn: &rusqlite::Connection, deleted_at: i64) {
        conn.execute("UPDATE cloud_accounts SET deleted_at=?1", [deleted_at]).unwrap();
        conn.execute("UPDATE memo_notes SET deleted_at=?1", [deleted_at]).unwrap();
    }

    #[test]
    fn scrub_days_defaults_and_reads_the_preference() {
        let conn = db();
        assert_eq!(scrub_days(&conn), DEFAULT_SCRUB_DAYS);
        preferences::save(&conn, SCRUB_DAYS_KEY, "7", 1).unwrap();
        assert_eq!(scrub_days(&conn), 7);
        preferences::save(&conn, SCRUB_DAYS_KEY, "0", 2).unwrap();
        assert_eq!(scrub_days(&conn), 0);
    }

    #[test]
    fn an_unparsable_or_out_of_range_setting_falls_back_to_the_default() {
        let conn = db();
        preferences::save(&conn, SCRUB_DAYS_KEY, "not-a-number", 1).unwrap();
        assert_eq!(scrub_days(&conn), DEFAULT_SCRUB_DAYS);
        preferences::save(&conn, SCRUB_DAYS_KEY, "-5", 2).unwrap();
        assert_eq!(scrub_days(&conn), DEFAULT_SCRUB_DAYS);
        preferences::save(&conn, SCRUB_DAYS_KEY, "999999", 3).unwrap();
        assert_eq!(scrub_days(&conn), DEFAULT_SCRUB_DAYS);
    }

    #[test]
    fn policy_zero_keeps_credentials_forever() {
        let conn = db();
        preferences::save(&conn, SCRUB_DAYS_KEY, "0", 1).unwrap();
        age_all(&conn, 1);
        // Even an ancient row keeps its secret when scrubbing is disabled.
        assert_eq!(apply_scrub_policy(&conn).unwrap(), 0);
        let secret: Option<String> = conn.query_row("SELECT secret_ciphertext FROM cloud_accounts WHERE id=1", [], |row| row.get(0)).unwrap();
        assert_eq!(secret, Some("secret".into()));
    }

    #[test]
    fn policy_clears_credentials_once_the_row_ages_out() {
        let conn = db();
        preferences::save(&conn, SCRUB_DAYS_KEY, "1", 1).unwrap();
        age_all(&conn, 1);
        let cleared = apply_scrub_policy(&conn).unwrap();
        assert_eq!(cleared, 1, "过期的云账号密钥应被清空");
        let secret: Option<String> = conn.query_row("SELECT secret_ciphertext FROM cloud_accounts WHERE id=1", [], |row| row.get(0)).unwrap();
        assert_eq!(secret, None);
        // The row itself stays in the bin and can still be restored.
        let live: i64 = conn.query_row("SELECT COUNT(*) FROM cloud_accounts WHERE deleted_at IS NOT NULL", [], |row| row.get(0)).unwrap();
        assert_eq!(live, 1);
        // Running again is idempotent.
        assert_eq!(apply_scrub_policy(&conn).unwrap(), 0);
    }

    #[test]
    fn policy_leaves_recent_rows_alone() {
        let conn = db();
        preferences::save(&conn, SCRUB_DAYS_KEY, "3650", 1).unwrap();
        // Freshly trashed, so nothing has aged out.
        assert_eq!(apply_scrub_policy(&conn).unwrap(), 0);
        let secret: Option<String> = conn.query_row("SELECT secret_ciphertext FROM cloud_accounts WHERE id=1", [], |row| row.get(0)).unwrap();
        assert_eq!(secret, Some("secret".into()));
    }
}
