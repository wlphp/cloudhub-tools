use crate::{
    decrypt_secret, encrypt_secret, open_db, row_managed_host, ManagedHost,
    RdpConnectionInput, SavedRdpConnection, SavedSshConnection, SshConnectInput,
    SshConnectResult, MANAGED_HOST_SELECT,
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use russh::{client, ChannelMsg};
use russh::keys::{decode_secret_key, PrivateKeyWithHashAlg};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    process::Command,
    sync::{mpsc, Arc, Mutex},
    time::Instant,
};
use uuid::Uuid;

pub(crate) struct SshTerminal {
    pub(crate) commands: tokio::sync::mpsc::UnboundedSender<SshCommand>,
    pub(crate) output: mpsc::Receiver<String>,
    pub(crate) profile: SshConnectionProfile,
}

pub(crate) enum SshCommand {
    Data(String),
    Resize(u32, u32),
    Disconnect,
}

#[derive(Clone)]
pub(crate) struct SshConnectionProfile {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) credentials: SshCredentials,
    pub(crate) fingerprint: String,
}

#[derive(Clone)]
pub(crate) enum SshCredentials {
    Password(String),
    PrivateKey { key: String, passphrase: Option<String> },
}

pub(crate) struct SshTerminalStore {
    pub(crate) terminals: Mutex<HashMap<String, SshTerminal>>,
}

#[derive(Clone)]
struct SavedSshCredentials {
    host: String,
    port: u16,
    username: String,
    platform: String,
    auth_method: String,
    password_ciphertext: Option<String>,
    private_key_ciphertext: Option<String>,
    key_passphrase_ciphertext: Option<String>,
    host_key_fingerprint: Option<String>,
}

pub(crate) struct SshHostKeyHandler {
    pub(crate) expected_fingerprint: Option<String>,
    pub(crate) observed_fingerprint: Arc<Mutex<Option<String>>>,
}

impl client::Handler for SshHostKeyHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key.public_key().fingerprint(russh::keys::HashAlg::Sha256).to_string();
        if let Ok(mut observed) = self.observed_fingerprint.lock() {
            *observed = Some(fingerprint.clone());
        }
        Ok(self.expected_fingerprint.as_ref().is_none_or(|known| known == &fingerprint))
    }
}

fn managed_host_saved_connection(id: i64) -> Result<Option<SavedSshCredentials>, String> {
    open_db()?.query_row(
        "SELECT host,port,username,platform,auth_method,password_ciphertext,private_key_ciphertext,key_passphrase_ciphertext,host_key_fingerprint FROM managed_hosts WHERE id=?1",
        [id],
        |row| Ok(SavedSshCredentials {
            host: row.get(0)?, port: row.get(1)?, username: row.get(2)?, platform: row.get(3)?, auth_method: row.get(4)?,
            password_ciphertext: row.get(5)?, private_key_ciphertext: row.get(6)?, key_passphrase_ciphertext: row.get(7)?, host_key_fingerprint: row.get(8)?,
        }),
    ).optional().map_err(|error| format!("读取受管服务器失败: {error}"))
}

#[tauri::command]
pub(crate) async fn probe_managed_host(id: i64) -> Result<ManagedHost, String> {
    let saved = managed_host_saved_connection(id)?.ok_or("服务器不存在")?;
    if saved.platform == "windows" {
        return Err("Windows 服务器请通过 RDP 打开，暂不支持 SSH 状态检测".into());
    }
    let host = saved.host.clone();
    let port = saved.port;
    let username = saved.username.clone();
    let credentials = credentials_from_saved(&saved)?;
    let started = Instant::now();
    let observed_fingerprint = Arc::new(Mutex::new(None));
    let handler = SshHostKeyHandler { expected_fingerprint: saved.host_key_fingerprint.clone(), observed_fingerprint: observed_fingerprint.clone() };
    let attempt = async {
        let config = Arc::new(client::Config::default());
        let mut session = client::connect(config, (host.as_str(), port), handler).await.map_err(|error| format!("连接 SSH 主机失败: {error}"))?;
        let fingerprint = observed_fingerprint.lock().map_err(|_| "SSH 主机密钥状态不可用".to_string())?.clone().ok_or("无法读取 SSH 主机密钥")?;
        authenticate_ssh(&mut session, &username, &credentials, "探测").await?;
        let mut channel = session.channel_open_session().await.map_err(|error| format!("打开 SSH 会话失败: {error}"))?;
        let command = r#"printf 'hostname='; hostname; printf 'os='; uname -sr; printf 'uptime='; uptime; printf 'memory='; free -b 2>/dev/null | awk '/^Mem:/ {print $2 \",\" $3}'; printf 'disk='; df -B1 / 2>/dev/null | awk 'NR==2 {print $2 \",\" $3}'"#;
        channel.exec(true, command).await.map_err(|error| format!("读取服务器状态失败: {error}"))?;
        let mut output = Vec::new();
        while let Some(message) = channel.wait().await {
            if let ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } = message {
                output.extend_from_slice(&data);
            }
        }
        let _ = session.disconnect(russh::Disconnect::ByApplication, "Host health probe complete", "en").await;
        Ok::<(String, String), String>((fingerprint, String::from_utf8_lossy(&output).to_string()))
    }.await;
    let conn = open_db()?;
    let now = Utc::now().timestamp_millis();
    match attempt {
        Ok((fingerprint, output)) => {
            let values = output.lines().filter_map(|line| line.split_once('=')).map(|(key, value)| (key.trim(), value.trim())).collect::<HashMap<_, _>>();
            let metric_pair = |key: &str| values.get(key).and_then(|value| value.split_once(',')).map(|(total, used)| json!({"total": total.trim().parse::<u64>().unwrap_or(0), "used": used.trim().parse::<u64>().unwrap_or(0)})).unwrap_or_else(|| json!(null));
            let metrics = json!({"hostname": values.get("hostname").copied().unwrap_or(""), "os": values.get("os").copied().unwrap_or(""), "uptime": values.get("uptime").copied().unwrap_or(""), "memory": metric_pair("memory"), "disk": metric_pair("disk")});
            conn.execute("UPDATE managed_hosts SET host_key_fingerprint=?1,status='online',last_latency_ms=?2,metrics_json=?3,last_checked_at=?4,last_error=NULL,updated_at=?4 WHERE id=?5", params![fingerprint, started.elapsed().as_millis() as i64, serde_json::to_string(&metrics).map_err(|error| error.to_string())?, now, id]).map_err(|error| error.to_string())?;
        }
        Err(error) => {
            conn.execute("UPDATE managed_hosts SET status='offline',last_checked_at=?1,last_error=?2,updated_at=?1 WHERE id=?3", params![now, error, id]).map_err(|error| error.to_string())?;
        }
    }
    conn.query_row(&format!("{MANAGED_HOST_SELECT} WHERE id=?1"), [id], row_managed_host).map_err(|error| error.to_string())
}

fn ssh_saved_connection(account_id: i64, asset_key: &str) -> Result<Option<SavedSshCredentials>, String> {
    let conn = open_db()?;
    let managed = conn.query_row(
        "SELECT host,port,username,platform,auth_method,password_ciphertext,private_key_ciphertext,key_passphrase_ciphertext,host_key_fingerprint FROM managed_hosts WHERE source_account_id=?1 AND source_asset_key=?2 AND platform='linux' ORDER BY id LIMIT 1",
        params![account_id, asset_key],
        |row| Ok(SavedSshCredentials { host: row.get(0)?, port: row.get(1)?, username: row.get(2)?, platform: row.get(3)?, auth_method: row.get(4)?, password_ciphertext: row.get(5)?, private_key_ciphertext: row.get(6)?, key_passphrase_ciphertext: row.get(7)?, host_key_fingerprint: row.get(8)? }),
    ).optional().map_err(|error| format!("读取终端管理 SSH 配置失败: {error}"))?;
    if managed.is_some() {
        return Ok(managed);
    }
    conn.query_row(
        "SELECT host,port,username,password_ciphertext,host_key_fingerprint FROM ssh_connections WHERE account_id=?1 AND asset_key=?2",
        params![account_id, asset_key],
        |row| Ok(SavedSshCredentials { host: row.get(0)?, port: row.get(1)?, username: row.get(2)?, platform: "linux".into(), auth_method: "password".into(), password_ciphertext: row.get(3)?, private_key_ciphertext: None, key_passphrase_ciphertext: None, host_key_fingerprint: row.get(4)? }),
    ).optional().map_err(|error| format!("读取 SSH 连接配置失败: {error}"))
}

fn credentials_from_saved(saved: &SavedSshCredentials) -> Result<SshCredentials, String> {
    if saved.auth_method == "private_key" {
        let key_ciphertext = saved.private_key_ciphertext.as_deref().filter(|value| !value.is_empty()).ok_or("服务器未保存 SSH 私钥")?;
        let key = decrypt_secret(key_ciphertext)?;
        let passphrase = saved.key_passphrase_ciphertext.as_deref().filter(|value| !value.is_empty()).map(decrypt_secret).transpose()?;
        return Ok(SshCredentials::PrivateKey { key, passphrase });
    }
    let password_ciphertext = saved.password_ciphertext.as_deref().filter(|value| !value.is_empty()).ok_or("服务器未保存 SSH 密码")?;
    let password = decrypt_secret(password_ciphertext)?;
    Ok(SshCredentials::Password(password))
}

fn ssh_credentials(input: &SshConnectInput, saved: &Option<SavedSshCredentials>) -> Result<SshCredentials, String> {
    if input.auth_method.as_deref() == Some("private_key") {
        let key = input.private_key.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(str::to_string)
            .or_else(|| saved.as_ref().and_then(|value| value.private_key_ciphertext.as_deref()).filter(|value| !value.is_empty()).map(decrypt_secret).transpose().ok().flatten())
            .ok_or("请粘贴 SSH 私钥，或使用已保存私钥连接")?;
        let passphrase = input.key_passphrase.as_deref().filter(|value| !value.is_empty()).map(str::to_string)
            .or_else(|| saved.as_ref().and_then(|value| value.key_passphrase_ciphertext.as_deref()).filter(|value| !value.is_empty()).map(decrypt_secret).transpose().ok().flatten());
        return Ok(SshCredentials::PrivateKey { key, passphrase });
    }
    input.password.as_deref().filter(|value| !value.is_empty()).map(str::to_owned)
        .or_else(|| saved.as_ref().and_then(|value| value.password_ciphertext.as_deref()).filter(|value| !value.is_empty()).map(decrypt_secret).transpose().ok().flatten())
        .map(SshCredentials::Password)
        .ok_or("请输入 SSH 密码，或使用已保存的密码连接".into())
}

pub(crate) async fn authenticate_ssh(session: &mut client::Handle<SshHostKeyHandler>, username: &str, credentials: &SshCredentials, context: &str) -> Result<(), String> {
    let authenticated = match credentials {
        SshCredentials::Password(password) => session.authenticate_password(username.to_string(), password.clone()).await.map_err(|error| format!("{context} SSH 身份验证失败: {error}"))?.success(),
        SshCredentials::PrivateKey { key, passphrase } => {
            let key = decode_secret_key(key, passphrase.as_deref()).map_err(|error| format!("读取 SSH 私钥失败: {error}"))?;
            let hash = session.best_supported_rsa_hash().await.map_err(|error| format!("读取 SSH 密钥算法失败: {error}"))?.flatten();
            session.authenticate_publickey(username.to_string(), PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await.map_err(|error| format!("{context} SSH 私钥验证失败: {error}"))?.success()
        }
    };
    if authenticated { Ok(()) } else { Err(format!("{context} SSH 身份验证失败，请检查认证信息")) }
}

fn save_ssh_connection(input: &SshConnectInput, password_ciphertext: Option<&str>, fingerprint: &str) -> Result<(), String> {
    let account_id = input.account_id.ok_or("缺少云账号标识")?;
    let asset_key = input.asset_key.as_deref().ok_or("缺少资产标识")?;
    open_db()?.execute(
        "INSERT INTO ssh_connections(account_id,asset_key,host,port,username,password_ciphertext,host_key_fingerprint,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(account_id,asset_key) DO UPDATE SET host=excluded.host,port=excluded.port,username=excluded.username,password_ciphertext=excluded.password_ciphertext,host_key_fingerprint=excluded.host_key_fingerprint,updated_at=excluded.updated_at",
        params![account_id, asset_key, input.host, input.port, input.username, password_ciphertext, fingerprint, Utc::now().timestamp_millis()],
    ).map_err(|error| format!("保存 SSH 连接配置失败: {error}"))?;
    Ok(())
}

fn managed_host_name_for_asset(conn: &Connection, account_id: i64, asset_key: &str) -> Result<(String, Option<String>), String> {
    let asset: Option<(String, Option<String>, Option<String>)> = conn.query_row(
        "SELECT a.account_name,a.group_name,assets.payload_json FROM cloud_assets assets JOIN cloud_accounts a ON a.id=assets.account_id WHERE assets.account_id=?1 AND assets.asset_key=?2 ORDER BY assets.fetched_at DESC LIMIT 1",
        params![account_id, asset_key],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional().map_err(|error| format!("读取云资源名称失败: {error}"))?;
    let Some((account_name, account_group, payload)) = asset else {
        return Ok((asset_key.to_string(), None));
    };
    let payload = payload.as_deref().and_then(|value| serde_json::from_str::<Value>(value).ok()).unwrap_or(Value::Null);
    let name = ["InstanceName", "Name", "name", "ServerName", "InstanceId", "Id"].iter().find_map(|key| payload.get(*key).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_string)).unwrap_or_else(|| asset_key.to_string());
    let group = account_group.filter(|value| !value.trim().is_empty()).or_else(|| (!account_name.trim().is_empty()).then_some(account_name));
    Ok((name, group))
}

fn save_managed_host_from_ssh(input: &SshConnectInput, password_ciphertext: &str, fingerprint: &str) -> Result<(), String> {
    let account_id = input.account_id.ok_or("缺少云账号标识")?;
    let asset_key = input.asset_key.as_deref().map(str::trim).filter(|value| !value.is_empty()).ok_or("缺少资产标识")?;
    let conn = open_db()?;
    let now = Utc::now().timestamp_millis();
    let existing_id: Option<i64> = conn.query_row("SELECT id FROM managed_hosts WHERE source_account_id=?1 AND source_asset_key=?2 ORDER BY id LIMIT 1", params![account_id, asset_key], |row| row.get(0)).optional().map_err(|error| format!("读取终端管理服务器失败: {error}"))?;
    if let Some(id) = existing_id {
        conn.execute("UPDATE managed_hosts SET host=?1,port=?2,username=?3,password_ciphertext=?4,host_key_fingerprint=?5,status='online',last_error=NULL,updated_at=?6 WHERE id=?7", params![input.host.trim(), input.port.max(1), input.username.trim(), password_ciphertext, fingerprint, now, id]).map_err(|error| format!("更新终端管理服务器失败: {error}"))?;
        return Ok(());
    }
    let (name, group_name) = managed_host_name_for_asset(&conn, account_id, asset_key)?;
    conn.execute("INSERT INTO managed_hosts(name,host,port,username,password_ciphertext,group_name,source_account_id,source_asset_key,host_key_fingerprint,status,metrics_json,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'online','{}',?10,?10)", params![name, input.host.trim(), input.port.max(1), input.username.trim(), password_ciphertext, group_name, account_id, asset_key, fingerprint, now]).map_err(|error| format!("保存终端管理服务器失败: {error}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn launch_managed_host_rdp(id: i64) -> Result<(), String> {
    let saved = managed_host_saved_connection(id)?.ok_or("服务器不存在")?;
    if saved.platform != "windows" { return Err("当前服务器不是 Windows / RDP 类型".into()); }
    launch_rdp_connection(RdpConnectionInput { target_key: format!("managed-host:{id}"), host: saved.host, port: saved.port, username: saved.username, password: saved.password_ciphertext.as_deref().filter(|value| !value.is_empty()).map(decrypt_secret).transpose()?, save_password: false })
}

#[tauri::command]
pub(crate) fn get_ssh_connection(account_id: i64, asset_key: String) -> Result<Option<SavedSshConnection>, String> {
    Ok(ssh_saved_connection(account_id, &asset_key)?.map(|saved| SavedSshConnection { host: saved.host, port: saved.port, username: saved.username, password_saved: saved.password_ciphertext.is_some_and(|value| !value.is_empty()) }))
}

#[tauri::command]
pub(crate) fn reveal_ssh_password(account_id: Option<i64>, asset_key: Option<String>, managed_host_id: Option<i64>) -> Result<String, String> {
    let ciphertext: Option<String> = if let Some(id) = managed_host_id {
        open_db()?.query_row("SELECT password_ciphertext FROM managed_hosts WHERE id=?1", [id], |row| row.get(0)).map_err(|error| format!("读取受管服务器 SSH 密码失败: {error}"))?
    } else {
        let account_id = account_id.ok_or("缺少云账号标识")?;
        let asset_key = asset_key.filter(|value| !value.trim().is_empty()).ok_or("缺少服务器标识")?;
        let conn = open_db()?;
        let managed: Option<String> = conn.query_row("SELECT password_ciphertext FROM managed_hosts WHERE source_account_id=?1 AND source_asset_key=?2 ORDER BY id LIMIT 1", params![account_id, asset_key], |row| row.get(0)).optional().map_err(|error| format!("读取终端管理 SSH 密码失败: {error}"))?;
        managed.or_else(|| conn.query_row("SELECT password_ciphertext FROM ssh_connections WHERE account_id=?1 AND asset_key=?2", params![account_id, asset_key], |row| row.get(0)).optional().ok().flatten())
    };
    decrypt_secret(&ciphertext.ok_or("当前没有保存 SSH 密码")?)
}

#[tauri::command]
pub(crate) fn delete_ssh_connection(account_id: i64, asset_key: String) -> Result<(), String> {
    open_db()?.execute("DELETE FROM ssh_connections WHERE account_id=?1 AND asset_key=?2", params![account_id, asset_key]).map_err(|error| format!("清除 SSH 连接配置失败: {error}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn get_rdp_connection(target_key: String) -> Result<Option<SavedRdpConnection>, String> {
    open_db()?.query_row("SELECT host,port,username,password_ciphertext FROM rdp_connections WHERE target_key=?1", [target_key], |row| Ok(SavedRdpConnection { host: row.get(0)?, port: row.get(1)?, username: row.get(2)?, password_saved: row.get::<_, Option<String>>(3)?.is_some() })).optional().map_err(|error| format!("读取 RDP 连接配置失败: {error}"))
}

#[tauri::command]
pub(crate) fn reveal_rdp_password(target_key: String) -> Result<String, String> {
    let ciphertext: String = open_db()?.query_row("SELECT password_ciphertext FROM rdp_connections WHERE target_key=?1", [target_key], |row| row.get::<_, Option<String>>(0)).optional().map_err(|error| format!("读取 RDP 密码失败: {error}"))?.flatten().ok_or("未保存 RDP 密码")?;
    decrypt_secret(&ciphertext)
}

#[tauri::command]
pub(crate) fn delete_rdp_connection(target_key: String) -> Result<(), String> {
    open_db()?.execute("DELETE FROM rdp_connections WHERE target_key=?1", [target_key]).map_err(|error| format!("清除 RDP 连接配置失败: {error}"))?;
    Ok(())
}

fn save_rdp_connection(input: &RdpConnectionInput) -> Result<(), String> {
    let target_key = input.target_key.trim();
    let host = input.host.trim();
    let username = input.username.trim();
    if target_key.is_empty() || host.is_empty() || username.is_empty() { return Err("请填写 RDP 主机和用户名".into()); }
    let conn = open_db()?;
    let existing_secret: Option<String> = conn.query_row("SELECT password_ciphertext FROM rdp_connections WHERE target_key=?1", [target_key], |row| row.get(0)).optional().map_err(|error| error.to_string())?.flatten();
    let secret = input.password.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(encrypt_secret).transpose()?.or(existing_secret);
    conn.execute("INSERT INTO rdp_connections(target_key,host,port,username,password_ciphertext,updated_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(target_key) DO UPDATE SET host=excluded.host,port=excluded.port,username=excluded.username,password_ciphertext=excluded.password_ciphertext,updated_at=excluded.updated_at", params![target_key, host, input.port.max(1), username, secret, Utc::now().timestamp_millis()]).map_err(|error| format!("保存 RDP 连接配置失败: {error}"))?;
    Ok(())
}

fn rdp_connection_password(input: &RdpConnectionInput) -> Result<Option<String>, String> {
    if let Some(password) = input.password.as_deref().map(str::trim).filter(|value| !value.is_empty()) { return Ok(Some(password.to_string())); }
    let target_key = input.target_key.trim();
    if target_key.is_empty() { return Ok(None); }
    let ciphertext: Option<String> = open_db()?.query_row("SELECT password_ciphertext FROM rdp_connections WHERE target_key=?1", [target_key], |row| row.get(0)).optional().map_err(|error| format!("读取 RDP 密码失败: {error}"))?.flatten();
    ciphertext.as_deref().filter(|value| !value.is_empty()).map(decrypt_secret).transpose()
}

#[tauri::command]
pub(crate) fn launch_rdp_connection(input: RdpConnectionInput) -> Result<(), String> {
    let host = input.host.trim();
    let username = input.username.trim();
    if host.is_empty() || username.is_empty() { return Err("请填写 RDP 主机和用户名".into()); }
    if input.save_password { save_rdp_connection(&input)?; }
    #[cfg(target_os = "windows")]
    {
        let address = if input.port == 3389 { host.to_string() } else { format!("{host}:{}", input.port) };
        let password = rdp_connection_password(&input)?;
        if let Some(password) = password.as_deref() {
            let credential_target = format!("TERMSRV/{host}");
            let status = Command::new("cmdkey.exe").arg(format!("/generic:{credential_target}")).arg(format!("/user:{username}")).arg(format!("/pass:{password}")).status().map_err(|error| format!("无法保存 Windows RDP 凭据: {error}"))?;
            if !status.success() { return Err("Windows RDP 凭据保存失败".into()); }
        }
        let path = std::env::temp_dir().join(format!("cloudhub-tools-rdp-{}.rdp", Uuid::new_v4()));
        let prompt_for_credentials = if password.is_some() { 0 } else { 1 };
        let content = format!("full address:s:{address}\r\nusername:s:{username}\r\nprompt for credentials:i:{prompt_for_credentials}\r\nauthentication level:i:2\r\nredirectclipboard:i:1\r\n");
        fs::write(&path, content).map_err(|error| format!("创建 RDP 配置失败: {error}"))?;
        Command::new("mstsc.exe").arg(&path).spawn().map_err(|error| format!("无法启动 Windows 远程桌面: {error}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = input;
        Err("RDP 连接仅支持 Windows 桌面客户端".into())
    }
}

#[tauri::command]
pub(crate) async fn ssh_connect(store: tauri::State<'_, SshTerminalStore>, input: SshConnectInput) -> Result<SshConnectResult, String> {
    let host = input.host.trim().to_string();
    let username = input.username.trim().to_string();
    let asset_key = input.asset_key.as_deref().unwrap_or_default().trim().to_string();
    if host.is_empty() || username.is_empty() || (input.managed_host_id.is_none() && !input.direct.unwrap_or(false) && (input.account_id.is_none() || asset_key.is_empty())) { return Err("请填写 SSH 主机、用户名和服务器标识".into()); }
    let port = if input.port == 0 { 22 } else { input.port };
    let saved = match input.managed_host_id { Some(id) => managed_host_saved_connection(id)?, None if input.direct.unwrap_or(false) => None, None => ssh_saved_connection(input.account_id.ok_or("缺少云账号标识")?, &asset_key)? };
    let credentials = ssh_credentials(&input, &saved)?;
    let observed_fingerprint = Arc::new(Mutex::new(None));
    let handler = SshHostKeyHandler { expected_fingerprint: saved.as_ref().and_then(|value| value.host_key_fingerprint.clone()), observed_fingerprint: observed_fingerprint.clone() };
    let config = Arc::new(client::Config::default());
    let mut session = client::connect(config, (host.clone(), port), handler).await.map_err(|error| if observed_fingerprint.lock().ok().and_then(|value| value.clone()).is_some() { "SSH 主机密钥与已保存记录不一致，已拒绝连接。请确认服务器变更后清除本地 SSH 配置再重试。".to_string() } else { format!("连接 SSH 主机失败: {error}") })?;
    let fingerprint = observed_fingerprint.lock().map_err(|_| "SSH 主机密钥状态不可用".to_string())?.clone().ok_or("无法读取 SSH 主机密钥")?;
    authenticate_ssh(&mut session, &username, &credentials, "").await?;
    let channel = session.channel_open_session().await.map_err(|error| format!("打开 SSH 终端失败: {error}"))?;
    let (mut reader, writer) = channel.split();
    writer.request_pty(true, "xterm-256color", input.cols.unwrap_or(100).max(20), input.rows.unwrap_or(28).max(8), 0, 0, &[]).await.map_err(|error| format!("初始化 SSH 终端失败: {error}"))?;
    writer.request_shell(true).await.map_err(|error| format!("启动 SSH Shell 失败: {error}"))?;
    let (output_sender, output_receiver) = mpsc::channel();
    let (command_sender, mut command_receiver) = tokio::sync::mpsc::unbounded_channel();
    tauri::async_runtime::spawn(async move {
        let writer = writer;
        loop {
            tokio::select! {
                command = command_receiver.recv() => match command {
                    Some(SshCommand::Data(data)) => if let Err(error) = writer.data_bytes(bytes::Bytes::from(data)).await { let _ = output_sender.send(format!("\r\n[SSH 写入失败：{error}]\r\n")); break; },
                    Some(SshCommand::Resize(cols, rows)) => if let Err(error) = writer.window_change(cols.max(20), rows.max(8), 0, 0).await { let _ = output_sender.send(format!("\r\n[SSH 终端尺寸更新失败：{error}]\r\n")); },
                    Some(SshCommand::Disconnect) | None => break,
                },
                message = reader.wait() => match message {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => { let _ = output_sender.send(String::from_utf8_lossy(&data).to_string()); }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {},
                },
            }
        }
        let _ = writer.close().await;
        let _ = session.disconnect(russh::Disconnect::ByApplication, "Local SSH client closed", "en").await;
    });
    let managed_password = if let SshCredentials::Password(password) = &credentials { Some(encrypt_secret(password)?) } else { None };
    let persisted = if input.save_password { managed_password.clone() } else { None };
    let mut persisted_input = input;
    persisted_input.host = host;
    persisted_input.username = username;
    persisted_input.asset_key = Some(asset_key);
    persisted_input.port = port;
    if persisted_input.direct.unwrap_or(false) {
        // Quick connections are intentionally ephemeral and never enter the cloud asset database.
    } else if let Some(managed_host_id) = persisted_input.managed_host_id {
        open_db()?.execute("UPDATE managed_hosts SET host=?1,port=?2,username=?3,password_ciphertext=COALESCE(?4,password_ciphertext),host_key_fingerprint=?5,status='online',last_error=NULL,updated_at=?6 WHERE id=?7", params![persisted_input.host, port, persisted_input.username, persisted.as_deref(), fingerprint, Utc::now().timestamp_millis(), managed_host_id]).map_err(|error| error.to_string())?;
    } else {
        save_ssh_connection(&persisted_input, persisted.as_deref(), &fingerprint)?;
        if let Some(password_ciphertext) = managed_password.as_deref() { save_managed_host_from_ssh(&persisted_input, password_ciphertext, &fingerprint)?; }
    }
    let session_id = Uuid::new_v4().to_string();
    let profile = SshConnectionProfile { host: persisted_input.host.clone(), port, username: persisted_input.username.clone(), credentials, fingerprint: fingerprint.clone() };
    store.terminals.lock().map_err(|_| "SSH 终端状态不可用".to_string())?.insert(session_id.clone(), SshTerminal { commands: command_sender, output: output_receiver, profile });
    Ok(SshConnectResult { session_id, host_key_fingerprint: fingerprint })
}

#[tauri::command]
pub(crate) async fn ssh_test_connection(input: SshConnectInput) -> Result<(), String> {
    let host = input.host.trim().to_string();
    let username = input.username.trim().to_string();
    let asset_key = input.asset_key.as_deref().unwrap_or_default().trim().to_string();
    if host.is_empty() || username.is_empty() || (input.managed_host_id.is_none() && !input.direct.unwrap_or(false) && (input.account_id.is_none() || asset_key.is_empty())) { return Err("请填写 SSH 主机、用户名和服务器标识".into()); }
    let port = if input.port == 0 { 22 } else { input.port };
    let saved = match input.managed_host_id { Some(id) => managed_host_saved_connection(id)?, None if input.direct.unwrap_or(false) => None, None => ssh_saved_connection(input.account_id.ok_or("缺少云账号标识")?, &asset_key)? };
    let credentials = ssh_credentials(&input, &saved)?;
    let observed_fingerprint = Arc::new(Mutex::new(None));
    let handler = SshHostKeyHandler { expected_fingerprint: saved.as_ref().and_then(|value| value.host_key_fingerprint.clone()), observed_fingerprint };
    let config = Arc::new(client::Config::default());
    let mut session = client::connect(config, (host.as_str(), port), handler).await.map_err(|error| format!("连接 SSH 主机失败: {error}"))?;
    authenticate_ssh(&mut session, &username, &credentials, "测试").await?;
    session.disconnect(russh::Disconnect::ByApplication, "SSH connection test completed", "en").await.map_err(|error| format!("关闭测试连接失败: {error}"))?;
    Ok(())
}
