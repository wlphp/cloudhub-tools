use rusqlite::{params, Connection, OptionalExtension};
use serde_json::json;

use crate::PanelConnection;

pub const SELECT: &str = "SELECT id,name,panel_url,sort_order,allow_insecure_tls,group_name,source_account_id,source_asset_key,api_key_ciphertext,status,summary_json,last_checked_at,last_error,remark,created_at,updated_at FROM panel_connections";

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
    conn.query_row(&format!("{SELECT} WHERE id=?1"), [id], row).map_err(|_| "面板不存在".to_string())
}

pub fn load_with_secret(conn: &Connection, id: i64) -> Result<(PanelConnection, String), String> {
    let panel = get(conn, id)?;
    let ciphertext = conn.query_row("SELECT api_key_ciphertext FROM panel_connections WHERE id=?1", [id], |row| row.get(0))
        .map_err(|_| "面板不存在".to_string())?;
    Ok((panel, ciphertext))
}

pub fn existing_api_key(conn: &Connection, id: i64) -> Result<Option<String>, String> {
    conn.query_row("SELECT api_key_ciphertext FROM panel_connections WHERE id=?1", [id], |row| row.get(0))
        .optional().map_err(|error| error.to_string())
}

pub fn id_by_url(conn: &Connection, panel_url: &str) -> Result<Option<i64>, String> {
    conn.query_row("SELECT id FROM panel_connections WHERE panel_url=?1", [panel_url], |row| row.get(0)).optional().map_err(|error| error.to_string())
}

pub fn import_update(conn: &Connection, id: i64, name: &str, ciphertext: &str, sort_order: i64, allow_insecure_tls: bool, group_name: Option<&str>, source_account_id: Option<i64>, source_asset_key: Option<&str>, remark: Option<&str>, now: i64) -> Result<(), String> {
    conn.execute("UPDATE panel_connections SET name=?1,api_key_ciphertext=?2,sort_order=?3,allow_insecure_tls=?4,group_name=?5,source_account_id=?6,source_asset_key=?7,remark=?8,updated_at=?9 WHERE id=?10", params![name,ciphertext,sort_order,allow_insecure_tls as i64,group_name,source_account_id,source_asset_key,remark,now,id]).map(|_| ()).map_err(|error| error.to_string())
}

pub fn import_insert(conn: &Connection, name: &str, panel_url: &str, ciphertext: &str, sort_order: i64, allow_insecure_tls: bool, group_name: Option<&str>, source_account_id: Option<i64>, source_asset_key: Option<&str>, remark: Option<&str>, now: i64) -> Result<(), String> {
    conn.execute("INSERT INTO panel_connections(name,panel_url,api_key_ciphertext,sort_order,allow_insecure_tls,group_name,source_account_id,source_asset_key,status,summary_json,remark,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'unknown','{}',?9,?10,?10)", params![name,panel_url,ciphertext,sort_order,allow_insecure_tls as i64,group_name,source_account_id,source_asset_key,remark,now]).map(|_| ()).map_err(|error| error.to_string())
}

pub struct ExportRow { pub id: i64, pub name: String, pub panel_url: String, pub sort_order: i64, pub ciphertext: String, pub allow_insecure_tls: bool, pub group_name: Option<String>, pub source_account_id: Option<i64>, pub source_asset_key: Option<String>, pub remark: Option<String> }

pub fn export_rows(conn: &Connection) -> Result<Vec<ExportRow>, String> {
    let mut statement = conn.prepare("SELECT id,name,panel_url,sort_order,api_key_ciphertext,allow_insecure_tls,group_name,source_account_id,source_asset_key,remark FROM panel_connections ORDER BY sort_order ASC, name COLLATE NOCASE").map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| Ok(ExportRow { id: row.get(0)?, name: row.get(1)?, panel_url: row.get(2)?, sort_order: row.get(3)?, ciphertext: row.get(4)?, allow_insecure_tls: row.get::<_, i64>(5)? == 1, group_name: row.get(6)?, source_account_id: row.get(7)?, source_asset_key: row.get(8)?, remark: row.get(9)? })).map_err(|error| error.to_string())?;
    rows.map(|row| row.map_err(|error| error.to_string())).collect()
}

pub fn save(conn: &Connection, input: &crate::PanelConnectionInput, name: &str, panel_url: &str, api_key_ciphertext: &str, summary_json: &str, now: i64) -> Result<PanelConnection, String> {
    let id = match input.id {
        Some(id) => {
            conn.execute("UPDATE panel_connections SET name=?1,panel_url=?2,api_key_ciphertext=?3,sort_order=?4,allow_insecure_tls=?5,group_name=?6,source_account_id=?7,source_asset_key=?8,status='online',summary_json=?9,last_checked_at=?10,last_error=NULL,remark=?11,updated_at=?10 WHERE id=?12", params![name,panel_url,api_key_ciphertext,input.sort_order.max(0),input.allow_insecure_tls as i64,input.group_name,input.source_account_id,input.source_asset_key,summary_json,now,input.remark,id]).map_err(|error| error.to_string())?;
            id
        }
        None => {
            conn.execute("INSERT INTO panel_connections(name,panel_url,api_key_ciphertext,sort_order,allow_insecure_tls,group_name,source_account_id,source_asset_key,status,summary_json,last_checked_at,remark,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'online',?9,?10,?11,?10,?10)", params![name,panel_url,api_key_ciphertext,input.sort_order.max(0),input.allow_insecure_tls as i64,input.group_name,input.source_account_id,input.source_asset_key,summary_json,now,input.remark]).map_err(|error| error.to_string())?;
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

pub fn delete(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM panel_connections WHERE id=?1", [id]).map(|_| ()).map_err(|error| error.to_string())
}

pub fn update_remark(conn: &Connection, id: i64, remark: Option<String>, now: i64) -> Result<PanelConnection, String> {
    conn.execute("UPDATE panel_connections SET remark=?1,updated_at=?2 WHERE id=?3", params![remark, now, id]).map_err(|error| error.to_string())?;
    get(conn, id)
}
