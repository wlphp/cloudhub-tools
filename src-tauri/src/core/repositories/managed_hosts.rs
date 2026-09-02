use rusqlite::{params, Connection, OptionalExtension};

use crate::{ManagedHost, SavedSshCredentials};

pub const SELECT: &str = "SELECT id,name,host,port,username,platform,auth_method,group_name,tags,source_account_id,source_asset_key,password_ciphertext,private_key_ciphertext,key_passphrase_ciphertext,host_key_fingerprint,status,last_latency_ms,metrics_json,last_checked_at,last_error,remark,created_at,updated_at FROM managed_hosts";

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ManagedHost> {
    let metrics: String = row.get(17)?;
    Ok(ManagedHost {
        id: row.get(0)?, name: row.get(1)?, host: row.get(2)?, port: row.get(3)?, username: row.get(4)?,
        platform: row.get(5)?, auth_method: row.get(6)?, group_name: row.get(7)?, tags: row.get(8)?, source_account_id: row.get(9)?, source_asset_key: row.get(10)?,
        password_saved: row.get::<_, Option<String>>(11)?.is_some_and(|value| !value.is_empty()), private_key_saved: row.get::<_, Option<String>>(12)?.is_some_and(|value| !value.is_empty()), host_key_fingerprint: row.get(14)?, status: row.get(15)?,
        last_latency_ms: row.get(16)?, metrics: serde_json::from_str(&metrics).unwrap_or_else(|_| serde_json::json!({})), last_checked_at: row.get(18)?,
        last_error: row.get(19)?, remark: row.get(20)?, created_at: row.get(21)?, updated_at: row.get(22)?,
    })
}

pub fn list(conn: &Connection) -> Result<Vec<ManagedHost>, String> {
    let mut statement = conn.prepare(&format!("{SELECT} ORDER BY COALESCE(group_name,''), name COLLATE NOCASE")).map_err(|error| error.to_string())?;
    let rows = statement.query_map([], row).map_err(|error| error.to_string())?;
    rows.map(|item| item.map_err(|error| error.to_string())).collect()
}

pub fn get(conn: &Connection, id: i64) -> Result<ManagedHost, String> {
    conn.query_row(&format!("{SELECT} WHERE id=?1"), [id], row).map_err(|error| error.to_string())
}

pub fn delete(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM managed_hosts WHERE id=?1", [id]).map(|_| ()).map_err(|error| error.to_string())
}

pub fn saved_connection(conn: &Connection, id: i64) -> Result<Option<SavedSshCredentials>, String> {
    conn.query_row("SELECT host,port,username,platform,auth_method,password_ciphertext,private_key_ciphertext,key_passphrase_ciphertext,host_key_fingerprint FROM managed_hosts WHERE id=?1", [id], |row| Ok(SavedSshCredentials {
        host: row.get(0)?, port: row.get(1)?, username: row.get(2)?, platform: row.get(3)?, auth_method: row.get(4)?, password_ciphertext: row.get(5)?, private_key_ciphertext: row.get(6)?, key_passphrase_ciphertext: row.get(7)?, host_key_fingerprint: row.get(8)?,
    })).optional().map_err(|error| format!("读取受管服务器失败: {error}"))
}

pub fn existing_secrets(conn: &Connection, id: i64) -> Result<Option<(Option<String>, Option<String>, Option<String>)>, String> {
    conn.query_row("SELECT password_ciphertext,private_key_ciphertext,key_passphrase_ciphertext FROM managed_hosts WHERE id=?1", [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .optional().map_err(|error| error.to_string())
}

pub fn save(conn: &Connection, input: &crate::ManagedHostInput, name: &str, host: &str, username: &str, platform: &str, auth_method: &str, port: u16, password_ciphertext: &str, private_key_ciphertext: Option<&str>, key_passphrase_ciphertext: Option<&str>, now: i64) -> Result<ManagedHost, String> {
    let id = match input.id {
        Some(id) => {
            conn.execute("UPDATE managed_hosts SET name=?1,host=?2,port=?3,username=?4,platform=?5,auth_method=?6,password_ciphertext=?7,private_key_ciphertext=?8,key_passphrase_ciphertext=?9,group_name=?10,tags=?11,source_account_id=?12,source_asset_key=?13,remark=?14,host_key_fingerprint=CASE WHEN platform<>?5 OR auth_method<>?6 THEN NULL ELSE host_key_fingerprint END,updated_at=?15 WHERE id=?16", params![name,host,port,username,platform,auth_method,password_ciphertext,private_key_ciphertext,key_passphrase_ciphertext,input.group_name,input.tags,input.source_account_id,input.source_asset_key,input.remark,now,id]).map_err(|error| error.to_string())?;
            id
        }
        None => {
            conn.execute("INSERT INTO managed_hosts(name,host,port,username,platform,auth_method,password_ciphertext,private_key_ciphertext,key_passphrase_ciphertext,group_name,tags,source_account_id,source_asset_key,remark,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?15)", params![name,host,port,username,platform,auth_method,password_ciphertext,private_key_ciphertext,key_passphrase_ciphertext,input.group_name,input.tags,input.source_account_id,input.source_asset_key,input.remark,now]).map_err(|error| error.to_string())?;
            conn.last_insert_rowid()
        }
    };
    get(conn, id)
}

pub fn mark_probe_success(conn: &Connection, id: i64, fingerprint: &str, latency_ms: i64, metrics_json: &str, now: i64) -> Result<(), String> {
    conn.execute("UPDATE managed_hosts SET host_key_fingerprint=?1,status='online',last_latency_ms=?2,metrics_json=?3,last_checked_at=?4,last_error=NULL,updated_at=?4 WHERE id=?5", params![fingerprint, latency_ms, metrics_json, now, id])
        .map(|_| ()).map_err(|error| error.to_string())
}

pub fn mark_probe_failure(conn: &Connection, id: i64, error_message: &str, now: i64) -> Result<(), String> {
    conn.execute("UPDATE managed_hosts SET status='offline',last_checked_at=?1,last_error=?2,updated_at=?1 WHERE id=?3", params![now, error_message, id])
        .map(|_| ()).map_err(|error| error.to_string())
}

pub fn source_id(conn: &Connection, account_id: i64, asset_key: &str) -> Result<Option<i64>, String> {
    conn.query_row("SELECT id FROM managed_hosts WHERE source_account_id=?1 AND source_asset_key=?2 ORDER BY id LIMIT 1", params![account_id, asset_key], |row| row.get(0)).optional().map_err(|error| format!("读取终端管理服务器失败: {error}"))
}

pub fn password_ciphertext(conn: &Connection, id: i64) -> Result<Option<String>, String> {
    conn.query_row("SELECT password_ciphertext FROM managed_hosts WHERE id=?1", [id], |row| row.get(0)).map_err(|error| format!("读取受管服务器 SSH 密码失败: {error}"))
}

pub fn update_from_ssh(conn: &Connection, id: i64, host: &str, port: u16, username: &str, password_ciphertext: &str, fingerprint: &str, now: i64) -> Result<(), String> {
    conn.execute("UPDATE managed_hosts SET host=?1,port=?2,username=?3,password_ciphertext=?4,host_key_fingerprint=?5,status='online',last_error=NULL,updated_at=?6 WHERE id=?7", params![host, port, username, password_ciphertext, fingerprint, now, id]).map(|_| ()).map_err(|error| format!("更新终端管理服务器失败: {error}"))
}

pub fn mark_ssh_online(conn: &Connection, id: i64, host: &str, port: u16, username: &str, password_ciphertext: Option<&str>, fingerprint: &str, now: i64) -> Result<(), String> {
    conn.execute("UPDATE managed_hosts SET host=?1,port=?2,username=?3,password_ciphertext=COALESCE(?4,password_ciphertext),host_key_fingerprint=?5,status='online',last_error=NULL,updated_at=?6 WHERE id=?7", params![host, port, username, password_ciphertext, fingerprint, now, id]).map(|_| ()).map_err(|error| error.to_string())
}

pub fn insert_from_ssh(conn: &Connection, name: &str, host: &str, port: u16, username: &str, password_ciphertext: &str, group_name: Option<&str>, account_id: i64, asset_key: &str, fingerprint: &str, now: i64) -> Result<(), String> {
    conn.execute("INSERT INTO managed_hosts(name,host,port,username,password_ciphertext,group_name,source_account_id,source_asset_key,host_key_fingerprint,status,metrics_json,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'online','{}',?10,?10)", params![name, host, port, username, password_ciphertext, group_name, account_id, asset_key, fingerprint, now]).map(|_| ()).map_err(|error| format!("保存终端管理服务器失败: {error}"))
}

pub fn id_by_endpoint(conn: &Connection, host: &str, port: u16, username: &str) -> Result<Option<i64>, String> {
    conn.query_row("SELECT id FROM managed_hosts WHERE host=?1 AND port=?2 AND username=?3", params![host, port, username], |row| row.get(0)).optional().map_err(|error| error.to_string())
}

pub fn import_update(conn: &Connection, id: i64, name: &str, platform: &str, auth_method: &str, password_ciphertext: &str, private_key_ciphertext: Option<&str>, key_passphrase_ciphertext: Option<&str>, group_name: Option<&str>, tags: Option<&str>, source_account_id: Option<i64>, source_asset_key: Option<&str>, remark: Option<&str>, now: i64) -> Result<(), String> {
    conn.execute("UPDATE managed_hosts SET name=?1,platform=?2,auth_method=?3,password_ciphertext=?4,private_key_ciphertext=?5,key_passphrase_ciphertext=?6,group_name=?7,tags=?8,source_account_id=?9,source_asset_key=?10,remark=?11,host_key_fingerprint=NULL,status='unknown',last_latency_ms=NULL,metrics_json='{}',last_checked_at=NULL,last_error=NULL,updated_at=?12 WHERE id=?13", params![name,platform,auth_method,password_ciphertext,private_key_ciphertext,key_passphrase_ciphertext,group_name,tags,source_account_id,source_asset_key,remark,now,id]).map(|_| ()).map_err(|error| error.to_string())
}

pub fn import_insert(conn: &Connection, name: &str, host: &str, port: u16, username: &str, platform: &str, auth_method: &str, password_ciphertext: &str, private_key_ciphertext: Option<&str>, key_passphrase_ciphertext: Option<&str>, group_name: Option<&str>, tags: Option<&str>, source_account_id: Option<i64>, source_asset_key: Option<&str>, remark: Option<&str>, now: i64) -> Result<(), String> {
    conn.execute("INSERT INTO managed_hosts(name,host,port,username,platform,auth_method,password_ciphertext,private_key_ciphertext,key_passphrase_ciphertext,group_name,tags,source_account_id,source_asset_key,status,metrics_json,remark,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'unknown','{}',?14,?15,?15)", params![name,host,port,username,platform,auth_method,password_ciphertext,private_key_ciphertext,key_passphrase_ciphertext,group_name,tags,source_account_id,source_asset_key,remark,now]).map(|_| ()).map_err(|error| error.to_string())
}

pub struct ExportRow { pub name: String, pub host: String, pub port: u16, pub username: String, pub platform: String, pub auth_method: String, pub password_ciphertext: Option<String>, pub private_key_ciphertext: Option<String>, pub key_passphrase_ciphertext: Option<String>, pub group_name: Option<String>, pub tags: Option<String>, pub source_account_id: Option<i64>, pub source_asset_key: Option<String>, pub remark: Option<String> }

pub fn export_rows(conn: &Connection) -> Result<Vec<ExportRow>, String> {
    let mut statement = conn.prepare("SELECT name,host,port,username,platform,auth_method,password_ciphertext,private_key_ciphertext,key_passphrase_ciphertext,group_name,tags,source_account_id,source_asset_key,remark FROM managed_hosts ORDER BY COALESCE(group_name,''), name COLLATE NOCASE").map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| Ok(ExportRow { name: row.get(0)?, host: row.get(1)?, port: row.get(2)?, username: row.get(3)?, platform: row.get(4)?, auth_method: row.get(5)?, password_ciphertext: row.get(6)?, private_key_ciphertext: row.get(7)?, key_passphrase_ciphertext: row.get(8)?, group_name: row.get(9)?, tags: row.get(10)?, source_account_id: row.get(11)?, source_asset_key: row.get(12)?, remark: row.get(13)? })).map_err(|error| error.to_string())?;
    rows.map(|row| row.map_err(|error| error.to_string())).collect()
}
