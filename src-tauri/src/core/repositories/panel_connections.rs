use rusqlite::{params, Connection, OptionalExtension};
use serde_json::json;

use crate::PanelConnection;

pub const SELECT: &str = "SELECT id,name,panel_url,sort_order,allow_insecure_tls,group_name,source_account_id,source_asset_key,api_key_ciphertext,status,summary_json,last_checked_at,last_error,remark,created_at,updated_at FROM panel_connections WHERE deleted_at IS NULL";

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PanelConnection> {
    let summary: String = row.get(10)?;
    Ok(PanelConnection {
        id: row.get(0)?, name: row.get(1)?, panel_url: row.get(2)?, sort_order: row.get(3)?, allow_insecure_tls: row.get::<_, i64>(4)? == 1,
        group_name: row.get(5)?, source_account_id: row.get(6)?, source_asset_key: row.get(7)?, api_key_saved: row.get::<_, Option<String>>(8)?.is_some(),
        status: row.get(9)?, summary: serde_json::from_str(&summary).unwrap_or_else(|_| json!({})), last_checked_at: row.get(11)?, last_error: row.get(12)?,
        remark: row.get(13)?, created_at: row.get(14)?, updated_at: row.get(15)?,
    })
}

pub fn list(conn: &Connection) -> Result<Vec<PanelConnection>, String> {
    let mut statement = conn.prepare(&format!("{SELECT} ORDER BY sort_order ASC, name COLLATE NOCASE")).map_err(|error| error.to_string())?;
    let rows = statement.query_map([], row).map_err(|error| error.to_string())?;
    rows.map(|item| item.map_err(|error| error.to_string())).collect()
}

pub fn get(conn: &Connection, id: i64) -> Result<PanelConnection, String> {
    conn.query_row(&format!("{SELECT} AND id=?1"), [id], row).map_err(|_| "面板不存在".to_string())
}

pub fn load_with_secret(conn: &Connection, id: i64) -> Result<(PanelConnection, String), String> {
    let panel = get(conn, id)?;
    let ciphertext = conn.query_row("SELECT api_key_ciphertext FROM panel_connections WHERE id=?1 AND deleted_at IS NULL", [id], |row| row.get(0))
        .map_err(|_| "面板不存在".to_string())?;
    Ok((panel, ciphertext))
}

pub fn existing_api_key(conn: &Connection, id: i64) -> Result<Option<String>, String> {
    conn.query_row("SELECT api_key_ciphertext FROM panel_connections WHERE id=?1 AND deleted_at IS NULL", [id], |row| row.get(0))
        .optional().map_err(|error| error.to_string())
}

pub fn id_by_url(conn: &Connection, panel_url: &str) -> Result<Option<i64>, String> {
    conn.query_row("SELECT id FROM panel_connections WHERE panel_url=?1 AND deleted_at IS NULL", [panel_url], |row| row.get(0)).optional().map_err(|error| error.to_string())
}

pub fn import_update(conn: &Connection, id: i64, name: &str, ciphertext: &str, sort_order: i64, allow_insecure_tls: bool, group_name: Option<&str>, source_account_id: Option<i64>, source_asset_key: Option<&str>, remark: Option<&str>, now: i64) -> Result<(), String> {
    conn.execute("UPDATE panel_connections SET name=?1,api_key_ciphertext=?2,sort_order=?3,allow_insecure_tls=?4,group_name=?5,source_account_id=?6,source_asset_key=?7,remark=?8,updated_at=?9 WHERE id=?10", params![name,ciphertext,sort_order,allow_insecure_tls as i64,group_name,source_account_id,source_asset_key,remark,now,id]).map(|_| ()).map_err(|error| error.to_string())
}

pub fn import_insert(conn: &Connection, name: &str, panel_url: &str, ciphertext: &str, sort_order: i64, allow_insecure_tls: bool, group_name: Option<&str>, source_account_id: Option<i64>, source_asset_key: Option<&str>, remark: Option<&str>, now: i64) -> Result<(), String> {
    conn.execute("INSERT INTO panel_connections(name,panel_url,api_key_ciphertext,sort_order,allow_insecure_tls,group_name,source_account_id,source_asset_key,status,summary_json,remark,created_at,updated_at,sync_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'unknown','{}',?9,?10,?10,?11)", params![name,panel_url,ciphertext,sort_order,allow_insecure_tls as i64,group_name,source_account_id,source_asset_key,remark,now,uuid::Uuid::new_v4().to_string()]).map(|_| ()).map_err(|error| error.to_string())
}

pub struct ExportRow { pub id: i64, pub name: String, pub panel_url: String, pub sort_order: i64, pub ciphertext: String, pub allow_insecure_tls: bool, pub group_name: Option<String>, pub source_account_id: Option<i64>, pub source_asset_key: Option<String>, pub remark: Option<String> }

pub fn export_rows(conn: &Connection) -> Result<Vec<ExportRow>, String> {
    let mut statement = conn.prepare("SELECT id,name,panel_url,sort_order,api_key_ciphertext,allow_insecure_tls,group_name,source_account_id,source_asset_key,remark FROM panel_connections ORDER BY sort_order ASC, name COLLATE NOCASE").map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| Ok(ExportRow { id: row.get(0)?, name: row.get(1)?, panel_url: row.get(2)?, sort_order: row.get(3)?, ciphertext: row.get(4)?, allow_insecure_tls: row.get::<_, i64>(5)? == 1, group_name: row.get(6)?, source_account_id: row.get(7)?, source_asset_key: row.get(8)?, remark: row.get(9)? })).map_err(|error| error.to_string())?;
    rows.map(|row| row.map_err(|error| error.to_string())).collect()
}

pub fn save(conn: &Connection, input: &crate::PanelConnectionInput, name: &str, panel_url: &str, api_key_ciphertext: &str, summary_json: &str, unverified_error: Option<&str>, now: i64) -> Result<PanelConnection, String> {
    // 强制保存（用户确认过验证失败）的面板按未验证入库：状态落 offline 并记下原因，
    // 卡片上立刻看得出这份配置还没通过验证，不假装在线。
    let status = if unverified_error.is_some() { "offline" } else { "online" };
    let id = match input.id {
        Some(id) => {
            conn.execute("UPDATE panel_connections SET name=?1,panel_url=?2,api_key_ciphertext=?3,sort_order=?4,allow_insecure_tls=?5,group_name=?6,source_account_id=?7,source_asset_key=?8,status=?9,summary_json=?10,last_checked_at=?11,last_error=?12,remark=?13,updated_at=?11 WHERE id=?14", params![name,panel_url,api_key_ciphertext,input.sort_order.max(0),input.allow_insecure_tls as i64,input.group_name,input.source_account_id,input.source_asset_key,status,summary_json,now,unverified_error,input.remark,id]).map_err(|error| error.to_string())?;
            id
        }
        None => {
            conn.execute("INSERT INTO panel_connections(name,panel_url,api_key_ciphertext,sort_order,allow_insecure_tls,group_name,source_account_id,source_asset_key,status,summary_json,last_checked_at,last_error,remark,created_at,updated_at,sync_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?11,?11,?14)", params![name,panel_url,api_key_ciphertext,input.sort_order.max(0),input.allow_insecure_tls as i64,input.group_name,input.source_account_id,input.source_asset_key,status,summary_json,now,unverified_error,input.remark,uuid::Uuid::new_v4().to_string()]).map_err(|error| error.to_string())?;
            conn.last_insert_rowid()
        }
    };
    get(conn, id)
}

pub fn mark_refresh_success(conn: &Connection, id: i64, summary_json: &str, now: i64) -> Result<(), String> {
    conn.execute("UPDATE panel_connections SET status='online',summary_json=?1,last_checked_at=?2,last_error=NULL,updated_at=?2 WHERE id=?3", params![summary_json, now, id])
        .map(|_| ()).map_err(|error| error.to_string())
}

pub fn mark_refresh_failure(conn: &Connection, id: i64, error_message: &str, now: i64) -> Result<(), String> {
    conn.execute("UPDATE panel_connections SET status='offline',last_checked_at=?1,last_error=?2,updated_at=?1 WHERE id=?3", params![now, error_message, id])
        .map(|_| ()).map_err(|error| error.to_string())
}

pub fn update_order(conn: &mut Connection, ids: &[i64], now: i64) -> Result<(), String> {
    let transaction = conn.unchecked_transaction().map_err(|error| format!("更新面板排序失败: {error}"))?;
    for (sort_order, id) in ids.iter().enumerate() {
        transaction.execute("UPDATE panel_connections SET sort_order=?1,updated_at=?2 WHERE id=?3", params![sort_order as i64, now, id])
            .map_err(|error| format!("更新面板排序失败: {error}"))?;
    }
    transaction.commit().map_err(|error| format!("保存面板排序失败: {error}"))
}

/// Moves the panel to the recycle bin; `trash::purge` is the only real delete.
pub fn delete(conn: &Connection, id: i64, now: i64) -> Result<(), String> {
    super::trash::soft_delete(conn, "panel_connections", &[rusqlite::types::Value::Integer(id)], now).map(|_| ())
}

pub fn update_remark(conn: &Connection, id: i64, remark: Option<String>, now: i64) -> Result<PanelConnection, String> {
    conn.execute("UPDATE panel_connections SET remark=?1,updated_at=?2 WHERE id=?3", params![remark, now, id]).map_err(|error| error.to_string())?;
    get(conn, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 只取面板自己用到的列，与 database.rs 的建表语句保持一致；sync_id 由迁移补上，
    // 这里一并建出来，save 的 INSERT 才不会因为缺列而报错。
    const TEST_SCHEMA: &str = "CREATE TABLE panel_connections (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, panel_url TEXT NOT NULL UNIQUE, api_key_ciphertext TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, allow_insecure_tls INTEGER NOT NULL DEFAULT 0, group_name TEXT, source_account_id INTEGER, source_asset_key TEXT, status TEXT NOT NULL DEFAULT 'unknown', summary_json TEXT NOT NULL DEFAULT '{}', last_checked_at INTEGER, last_error TEXT, remark TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, sync_id TEXT);";

    fn input(id: Option<i64>) -> crate::PanelConnectionInput {
        crate::PanelConnectionInput {
            id,
            name: "示例面板".into(),
            panel_url: "https://panel.example.test".into(),
            sort_order: 0,
            api_key: None,
            allow_insecure_tls: false,
            group_name: None,
            source_account_id: None,
            source_asset_key: None,
            remark: None,
            force: None,
        }
    }

    #[test]
    fn forced_save_is_stored_as_unverified_with_its_reason() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(TEST_SCHEMA).unwrap();
        let reason = "面板请求失败：HTTP 404 Not Found";
        let saved = save(&conn, &input(None), "示例面板", "https://panel.example.test", "cipher", "{}", Some(reason), 100).unwrap();
        // 验证没过但用户确认过要保存：面板照常进列表，状态必须是 offline 而不是假装在线。
        assert_eq!(saved.status, "offline");
        assert_eq!(saved.last_error.as_deref(), Some(reason));
        assert!(saved.api_key_saved);
    }

    #[test]
    fn a_later_verified_save_clears_the_previous_reason() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(TEST_SCHEMA).unwrap();
        let first = save(&conn, &input(None), "示例面板", "https://panel.example.test", "cipher", "{}", Some("面板请求失败：HTTP 404 Not Found"), 100).unwrap();
        assert_eq!(first.status, "offline");

        // 修好 URL 后再存一次：状态回到 online，上一轮的原因不能留在卡片上误导排查。
        let mut update = input(Some(first.id));
        update.remark = Some("强制保存过".into());
        let retried = save(&conn, &update, "示例面板", "https://panel.example.test", "cipher", r#"{"version":"1.0"}"#, None, 200).unwrap();
        assert_eq!(retried.status, "online");
        assert!(retried.last_error.is_none());
        assert_eq!(retried.remark.as_deref(), Some("强制保存过"));
        assert_eq!(retried.updated_at, 200);
    }
}
