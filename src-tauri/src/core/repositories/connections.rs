use rusqlite::{params, Connection, OptionalExtension};

use crate::{SavedRdpConnection, SavedSshCredentials};

pub fn ssh_saved(conn: &Connection, account_id: i64, asset_key: &str) -> Result<Option<SavedSshCredentials>, String> {
    let managed = conn.query_row("SELECT host,port,username,platform,auth_method,password_ciphertext,private_key_ciphertext,key_passphrase_ciphertext,host_key_fingerprint FROM managed_hosts WHERE source_account_id=?1 AND source_asset_key=?2 AND platform='linux' ORDER BY id LIMIT 1", params![account_id, asset_key], |row| Ok(SavedSshCredentials { host: row.get(0)?, port: row.get(1)?, username: row.get(2)?, platform: row.get(3)?, auth_method: row.get(4)?, password_ciphertext: row.get(5)?, private_key_ciphertext: row.get(6)?, key_passphrase_ciphertext: row.get(7)?, host_key_fingerprint: row.get(8)? })).optional().map_err(|error| format!("读取终端管理 SSH 配置失败: {error}"))?;
    if managed.is_some() { return Ok(managed); }
    conn.query_row("SELECT host,port,username,password_ciphertext,host_key_fingerprint FROM ssh_connections WHERE account_id=?1 AND asset_key=?2", params![account_id, asset_key], |row| Ok(SavedSshCredentials { host: row.get(0)?, port: row.get(1)?, username: row.get(2)?, platform: "linux".into(), auth_method: "password".into(), password_ciphertext: row.get(3)?, private_key_ciphertext: None, key_passphrase_ciphertext: None, host_key_fingerprint: row.get(4)? })).optional().map_err(|error| format!("读取 SSH 连接配置失败: {error}"))
}

pub fn delete_ssh(conn: &Connection, account_id: i64, asset_key: &str) -> Result<(), String> {
    conn.execute("DELETE FROM ssh_connections WHERE account_id=?1 AND asset_key=?2", params![account_id, asset_key]).map(|_| ()).map_err(|error| format!("清除 SSH 连接配置失败: {error}"))
}

pub fn ssh_password_ciphertext(conn: &Connection, account_id: i64, asset_key: &str) -> Result<Option<String>, String> {
    let managed: Option<String> = conn.query_row("SELECT password_ciphertext FROM managed_hosts WHERE source_account_id=?1 AND source_asset_key=?2 ORDER BY id LIMIT 1", params![account_id, asset_key], |row| row.get(0)).optional().map_err(|error| format!("读取终端管理 SSH 密码失败: {error}"))?;
    if managed.is_some() { return Ok(managed); }
    conn.query_row("SELECT password_ciphertext FROM ssh_connections WHERE account_id=?1 AND asset_key=?2", params![account_id, asset_key], |row| row.get(0)).optional().map_err(|error| format!("读取 SSH 连接配置失败: {error}"))?
        .map_or(Ok(None), |value: Option<String>| Ok(value))
}

pub fn rdp_saved(conn: &Connection, target_key: &str) -> Result<Option<SavedRdpConnection>, String> {
    conn.query_row("SELECT host,port,username,password_ciphertext FROM rdp_connections WHERE target_key=?1", [target_key], |row| Ok(SavedRdpConnection { host: row.get(0)?, port: row.get(1)?, username: row.get(2)?, password_saved: row.get::<_, Option<String>>(3)?.is_some() })).optional().map_err(|error| format!("读取 RDP 连接配置失败: {error}"))
}

pub fn rdp_password_ciphertext(conn: &Connection, target_key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT password_ciphertext FROM rdp_connections WHERE target_key=?1", [target_key], |row| row.get(0)).optional().map_err(|error| format!("读取 RDP 密码失败: {error}"))?.map_or(Ok(None), |value: Option<String>| Ok(value))
}

pub fn delete_rdp(conn: &Connection, target_key: &str) -> Result<(), String> {
    conn.execute("DELETE FROM rdp_connections WHERE target_key=?1", [target_key]).map(|_| ()).map_err(|error| format!("清除 RDP 连接配置失败: {error}"))
}

pub fn save_ssh(conn: &Connection, input: &crate::SshConnectInput, password_ciphertext: Option<&str>, fingerprint: &str, now: i64) -> Result<(), String> {
    let account_id = input.account_id.ok_or("缺少云账号标识")?;
    let asset_key = input.asset_key.as_deref().ok_or("缺少资产标识")?;
    conn.execute("INSERT INTO ssh_connections(account_id,asset_key,host,port,username,password_ciphertext,host_key_fingerprint,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(account_id,asset_key) DO UPDATE SET host=excluded.host,port=excluded.port,username=excluded.username,password_ciphertext=excluded.password_ciphertext,host_key_fingerprint=excluded.host_key_fingerprint,updated_at=excluded.updated_at", params![account_id, asset_key, input.host, input.port, input.username, password_ciphertext, fingerprint, now]).map_err(|error| format!("保存 SSH 连接配置失败: {error}"))?;
    Ok(())
}

pub fn save_rdp(conn: &Connection, target_key: &str, host: &str, port: u16, username: &str, password_ciphertext: Option<&str>, now: i64) -> Result<(), String> {
    conn.execute("INSERT INTO rdp_connections(target_key,host,port,username,password_ciphertext,updated_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(target_key) DO UPDATE SET host=excluded.host,port=excluded.port,username=excluded.username,password_ciphertext=excluded.password_ciphertext,updated_at=excluded.updated_at", params![target_key, host, port, username, password_ciphertext, now]).map_err(|error| format!("保存 RDP 连接配置失败: {error}"))?;
    Ok(())
}
