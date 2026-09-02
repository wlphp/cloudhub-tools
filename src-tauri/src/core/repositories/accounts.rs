use rusqlite::{params, Connection, OptionalExtension};

use crate::{AccountInput, CloudAccount};
use serde_json::Value;

pub struct ExportRecord {
    pub id: i64,
    pub account_name: String,
    pub cloud_type: String,
    pub group_name: Option<String>,
    pub access_key_id: String,
    pub secret_ciphertext: String,
    pub credential_meta: Option<String>,
    pub region_id: Option<String>,
    pub sort_order: i64,
    pub enabled: bool,
    pub remark: Option<String>,
}

pub fn export_records(conn: &Connection, selected_ids: Option<&[i64]>) -> Result<Vec<ExportRecord>, String> {
    let mut statement = conn.prepare("SELECT id,account_name,cloud_type,group_name,access_key_id,secret_ciphertext,credential_meta,region_id,sort_order,enabled,remark FROM cloud_accounts ORDER BY sort_order ASC, updated_at DESC").map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| Ok(ExportRecord {
        id: row.get(0)?, account_name: row.get(1)?, cloud_type: row.get(2)?, group_name: row.get(3)?, access_key_id: row.get(4)?, secret_ciphertext: row.get(5)?, credential_meta: row.get(6)?, region_id: row.get(7)?, sort_order: row.get(8)?, enabled: row.get::<_, i64>(9)? == 1, remark: row.get(10)?,
    })).map_err(|error| error.to_string())?;
    rows.filter_map(|row| match row {
        Ok(value) if selected_ids.is_none_or(|ids| ids.contains(&value.id)) => Some(Ok(value)),
        Ok(_) => None,
        Err(error) => Some(Err(error)),
    }).collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

fn row_account(row: &rusqlite::Row<'_>) -> rusqlite::Result<CloudAccount> {
    Ok(CloudAccount {
        id: row.get(0)?, account_name: row.get(1)?, cloud_type: row.get(2)?, group_name: row.get(3)?,
        access_key_id: row.get(4)?, credential_meta: row.get(5)?, region_id: row.get(6)?, sort_order: row.get(7)?,
        enabled: row.get::<_, i64>(8)? == 1, remark: row.get(9)?, created_at: row.get(10)?, updated_at: row.get(11)?,
    })
}

pub fn list(conn: &Connection, keyword: &str) -> Result<Vec<CloudAccount>, String> {
    let pattern = format!("%{keyword}%");
    let mut statement = conn.prepare("SELECT id,account_name,cloud_type,group_name,access_key_id,credential_meta,region_id,sort_order,enabled,remark,created_at,updated_at FROM cloud_accounts WHERE ?1='' OR account_name LIKE ?2 OR access_key_id LIKE ?2 OR COALESCE(group_name,'') LIKE ?2 ORDER BY sort_order ASC, updated_at DESC").map_err(|error| error.to_string())?;
    let rows = statement.query_map(params![keyword, pattern], row_account).map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

pub fn secret_ciphertext(conn: &Connection, id: i64) -> Result<Option<String>, String> {
    conn.query_row("SELECT secret_ciphertext FROM cloud_accounts WHERE id=?1", [id], |row| row.get(0))
        .optional().map_err(|error| error.to_string())
}

pub fn id_by_access_key(conn: &Connection, access_key_id: &str) -> Result<Option<i64>, String> {
    conn.query_row("SELECT id FROM cloud_accounts WHERE access_key_id=?1", [access_key_id], |row| row.get(0))
        .optional().map_err(|error| error.to_string())
}

pub fn credential_record(conn: &Connection, id: i64) -> Result<(String, String, i64), String> {
    conn.query_row("SELECT access_key_id,secret_ciphertext,enabled FROM cloud_accounts WHERE id=?1", [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).map_err(|error| format!("读取云账号失败: {error}"))
}

pub fn cloud_type(conn: &Connection, id: i64) -> Result<String, String> {
    conn.query_row("SELECT cloud_type FROM cloud_accounts WHERE id=?1", [id], |row| row.get(0)).map_err(|error| format!("读取云账号失败: {error}"))
}

pub fn region_id(conn: &Connection, id: i64) -> Result<Option<String>, String> {
    conn.query_row("SELECT region_id FROM cloud_accounts WHERE id=?1", [id], |row| row.get(0)).map_err(|error| format!("读取云账号失败: {error}"))
}

pub fn credential_meta(conn: &Connection, id: i64) -> Result<Value, String> {
    let raw: Option<String> = conn.query_row("SELECT credential_meta FROM cloud_accounts WHERE id=?1", [id], |row| row.get(0)).map_err(|error| format!("读取云账号失败: {error}"))?;
    serde_json::from_str(raw.as_deref().unwrap_or("{}")).map_err(|_| "云账号凭据元数据格式无效".to_string())
}

pub fn oracle_record(conn: &Connection, id: i64) -> Result<(String, String, Value, Option<String>, i64, String), String> {
    let (access_key_id, secret_ciphertext, credential_meta, region_id, enabled, cloud_type): (String, String, Option<String>, Option<String>, i64, String) = conn.query_row("SELECT access_key_id,secret_ciphertext,credential_meta,region_id,enabled,cloud_type FROM cloud_accounts WHERE id=?1", [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?))).map_err(|error| format!("读取 OCI 账号失败: {error}"))?;
    let meta = serde_json::from_str(credential_meta.as_deref().unwrap_or("{}")).map_err(|_| "OCI 账号元数据格式无效".to_string())?;
    Ok((access_key_id, secret_ciphertext, meta, region_id, enabled, cloud_type))
}

pub fn save(conn: &Connection, input: &AccountInput, secret_ciphertext: &str, now: i64) -> Result<CloudAccount, String> {
    let id = match input.id {
        Some(id) => {
            conn.execute("UPDATE cloud_accounts SET account_name=?1,cloud_type=?2,group_name=?3,access_key_id=?4,secret_ciphertext=?5,credential_meta=?6,region_id=?7,sort_order=?8,enabled=?9,remark=?10,updated_at=?11 WHERE id=?12", params![input.account_name.trim(), input.cloud_type, input.group_name, input.access_key_id.trim(), secret_ciphertext, input.credential_meta, input.region_id, input.sort_order.unwrap_or(0), input.enabled as i64, input.remark, now, id]).map_err(|error| error.to_string())?;
            id
        }
        None => {
            conn.execute("INSERT INTO cloud_accounts(account_name,cloud_type,group_name,access_key_id,secret_ciphertext,credential_meta,region_id,sort_order,enabled,remark,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)", params![input.account_name.trim(), input.cloud_type, input.group_name, input.access_key_id.trim(), secret_ciphertext, input.credential_meta, input.region_id, input.sort_order.unwrap_or(0), input.enabled as i64, input.remark, now]).map_err(|error| error.to_string())?;
            conn.last_insert_rowid()
        }
    };
    conn.query_row("SELECT id,account_name,cloud_type,group_name,access_key_id,credential_meta,region_id,sort_order,enabled,remark,created_at,updated_at FROM cloud_accounts WHERE id=?1", [id], row_account).map_err(|error| error.to_string())
}

pub fn delete(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM cloud_accounts WHERE id=?1", [id]).map(|_| ()).map_err(|error| error.to_string())
}
