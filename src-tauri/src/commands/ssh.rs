use crate::core::repositories::{assets as asset_repository, connections as connection_repository, managed_hosts as managed_host_repository};
use crate::core::storage::{decrypt_secret, encrypt_secret, open_db};
use crate::core::error::PlatformResult;
use crate::{managed_host_saved_connection, RdpConnectionInput, SavedSshCredentials, SshCommand, SshConnectInput, SshConnectResult, SshConnectionProfile, SshCredentials, SshDirectoryListing, SshFileEntry, SshHostKeyHandler, SshTerminal, SshTerminalStore};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chrono::Utc;
use russh::{client, ChannelMsg};
use russh::keys::{decode_secret_key, PrivateKeyWithHashAlg};
use rusqlite::Connection;
use std::{fs, process::Command, sync::{mpsc, Arc, Mutex}};
use uuid::Uuid;

pub(crate) fn ssh_saved_connection(account_id: i64, asset_key: &str) -> PlatformResult<Option<SavedSshCredentials>> {
    Ok(connection_repository::ssh_saved(&open_db()?, account_id, asset_key)?)
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
        SshCredentials::Password(password) => session.authenticate_password(username.to_string(), password.clone()).await
            .map_err(|error| format!("{context} SSH 身份验证失败: {error}"))?.success(),
        SshCredentials::PrivateKey { key, passphrase } => {
            let key = decode_secret_key(key, passphrase.as_deref()).map_err(|error| format!("读取 SSH 私钥失败: {error}"))?;
            let hash = session.best_supported_rsa_hash().await.map_err(|error| format!("读取 SSH 密钥算法失败: {error}"))?.flatten();
            session.authenticate_publickey(username.to_string(), PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await
                .map_err(|error| format!("{context} SSH 私钥验证失败: {error}"))?.success()
        }
    };
    if authenticated { Ok(()) } else { Err(format!("{context} SSH 身份验证失败，请检查认证信息")) }
}

fn save_ssh_connection(input: &SshConnectInput, password_ciphertext: Option<&str>, fingerprint: &str) -> Result<(), String> {
    connection_repository::save_ssh(&open_db()?, input, password_ciphertext, fingerprint, Utc::now().timestamp_millis())
}

fn managed_host_name_for_asset(conn: &Connection, account_id: i64, asset_key: &str) -> Result<(String, Option<String>), String> {
    asset_repository::name_for_asset(conn, account_id, asset_key)
}

fn save_managed_host_from_ssh(input: &SshConnectInput, password_ciphertext: &str, fingerprint: &str) -> Result<(), String> {
    let account_id = input.account_id.ok_or("缺少云账号标识")?;
    let asset_key = input.asset_key.as_deref().map(str::trim).filter(|value| !value.is_empty()).ok_or("缺少资产标识")?;
    let conn = open_db()?;
    let now = Utc::now().timestamp_millis();
    let existing_id = managed_host_repository::source_id(&conn, account_id, asset_key)?;
    if let Some(id) = existing_id {
        managed_host_repository::update_from_ssh(&conn, id, input.host.trim(), input.port.max(1), input.username.trim(), password_ciphertext, fingerprint, now)?;
        return Ok(());
    }
    let (name, group_name) = managed_host_name_for_asset(&conn, account_id, asset_key)?;
    managed_host_repository::insert_from_ssh(&conn, &name, input.host.trim(), input.port.max(1), input.username.trim(), password_ciphertext, group_name.as_deref(), account_id, asset_key, fingerprint, now)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn launch_managed_host_rdp(id: i64) -> PlatformResult<()> {
    let saved = managed_host_saved_connection(id)?.ok_or("服务器不存在")?;
    if saved.platform != "windows" { return Err("当前服务器不是 Windows / RDP 类型".into()); }
    launch_rdp_connection(RdpConnectionInput {
        target_key: format!("managed-host:{id}"),
        host: saved.host,
        port: saved.port,
        username: saved.username,
        password: saved.password_ciphertext.as_deref().filter(|value| !value.is_empty()).map(decrypt_secret).transpose()?,
        save_password: false,
    })
}

fn save_rdp_connection(input: &RdpConnectionInput) -> Result<(), String> {
    let target_key = input.target_key.trim();
    let host = input.host.trim();
    let username = input.username.trim();
    if target_key.is_empty() || host.is_empty() || username.is_empty() { return Err("请填写 RDP 主机和用户名".into()); }
    let conn = open_db()?;
    let existing_secret = connection_repository::rdp_password_ciphertext(&conn, target_key)?;
    let secret = input.password.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(encrypt_secret).transpose()?.or(existing_secret);
    connection_repository::save_rdp(&conn, target_key, host, input.port.max(1), username, secret.as_deref(), Utc::now().timestamp_millis())
}

fn rdp_connection_password(input: &RdpConnectionInput) -> Result<Option<String>, String> {
    if let Some(password) = input.password.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        return Ok(Some(password.to_string()));
    }
    let target_key = input.target_key.trim();
    if target_key.is_empty() { return Ok(None); }
    let ciphertext = connection_repository::rdp_password_ciphertext(&open_db()?, target_key)?;
    ciphertext.as_deref().filter(|value| !value.is_empty()).map(decrypt_secret).transpose()
}

#[tauri::command]
pub(crate) fn launch_rdp_connection(input: RdpConnectionInput) -> PlatformResult<()> {
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
            let status = Command::new("cmdkey.exe")
                .arg(format!("/generic:{credential_target}"))
                .arg(format!("/user:{username}"))
                .arg(format!("/pass:{password}"))
                .status()
                .map_err(|e| format!("无法保存 Windows RDP 凭据: {e}"))?;
            if !status.success() { return Err("Windows RDP 凭据保存失败".into()); }
        }
        let path = std::env::temp_dir().join(format!("cloudhub-tools-rdp-{}.rdp", Uuid::new_v4()));
        let prompt_for_credentials = if password.is_some() { 0 } else { 1 };
        let content = format!("full address:s:{address}\r\nusername:s:{username}\r\nprompt for credentials:i:{prompt_for_credentials}\r\nauthentication level:i:2\r\nredirectclipboard:i:1\r\n");
        fs::write(&path, content).map_err(|e| format!("创建 RDP 配置失败: {e}"))?;
        Command::new("mstsc.exe").arg(&path).spawn().map_err(|e| format!("无法启动 Windows 远程桌面: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = input;
        Err("RDP 连接仅支持 Windows 桌面客户端".into())
    }
}

#[tauri::command]
pub(crate) async fn ssh_connect(store: tauri::State<'_, SshTerminalStore>, input: SshConnectInput) -> PlatformResult<SshConnectResult> {
    let host = input.host.trim().to_string();
    let username = input.username.trim().to_string();
    let asset_key = input.asset_key.as_deref().unwrap_or_default().trim().to_string();
    if host.is_empty() || username.is_empty() || (input.managed_host_id.is_none() && !input.direct.unwrap_or(false) && (input.account_id.is_none() || asset_key.is_empty())) { return Err("请填写 SSH 主机、用户名和服务器标识".into()); }
    let port = if input.port == 0 { 22 } else { input.port };
    let saved = match input.managed_host_id {
        Some(id) => managed_host_saved_connection(id)?,
        None if input.direct.unwrap_or(false) => None,
        None => ssh_saved_connection(input.account_id.ok_or("缺少云账号标识")?, &asset_key)?,
    };
    let credentials = ssh_credentials(&input, &saved)?;
    let observed_fingerprint = Arc::new(Mutex::new(None));
    let handler = SshHostKeyHandler {
        expected_fingerprint: saved.as_ref().and_then(|value| value.host_key_fingerprint.clone()),
        observed_fingerprint: observed_fingerprint.clone(),
    };
    let config = Arc::new(client::Config::default());
    let mut session = client::connect(config, (host.clone(), port), handler).await
        .map_err(|error| {
            if observed_fingerprint.lock().ok().and_then(|value| value.clone()).is_some() {
                "SSH 主机密钥与已保存记录不一致，已拒绝连接。请确认服务器变更后清除本地 SSH 配置再重试。".to_string()
            } else { format!("连接 SSH 主机失败: {error}") }
        })?;
    let fingerprint = observed_fingerprint.lock().map_err(|_| "SSH 主机密钥状态不可用".to_string())?.clone().ok_or("无法读取 SSH 主机密钥")?;
    authenticate_ssh(&mut session, &username, &credentials, "").await?;
    let channel = session.channel_open_session().await.map_err(|error| format!("打开 SSH 终端失败: {error}"))?;
    let (mut reader, writer) = channel.split();
    writer.request_pty(true, "xterm-256color", input.cols.unwrap_or(100).max(20), input.rows.unwrap_or(28).max(8), 0, 0, &[])
        .await.map_err(|error| format!("初始化 SSH 终端失败: {error}"))?;
    writer.request_shell(true).await.map_err(|error| format!("启动 SSH Shell 失败: {error}"))?;
    let (output_sender, output_receiver) = mpsc::channel();
    let (command_sender, mut command_receiver) = tokio::sync::mpsc::unbounded_channel();
    tauri::async_runtime::spawn(async move {
        let writer = writer;
        loop {
            tokio::select! {
                command = command_receiver.recv() => match command {
                    Some(SshCommand::Data(data)) => {
                        if let Err(error) = writer.data_bytes(bytes::Bytes::from(data)).await {
                            let _ = output_sender.send(format!("\r\n[SSH 写入失败：{error}]\r\n"));
                            break;
                        }
                    }
                    Some(SshCommand::Resize(cols, rows)) => {
                        if let Err(error) = writer.window_change(cols.max(20), rows.max(8), 0, 0).await {
                            let _ = output_sender.send(format!("\r\n[SSH 终端尺寸更新失败：{error}]\r\n"));
                        }
                    }
                    Some(SshCommand::Disconnect) | None => break,
                },
                message = reader.wait() => match message {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let _ = output_sender.send(String::from_utf8_lossy(&data).to_string());
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {},
                }
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
        managed_host_repository::mark_ssh_online(&open_db()?, managed_host_id, &persisted_input.host, port, &persisted_input.username, persisted.as_deref(), &fingerprint, Utc::now().timestamp_millis())?;
    } else {
        save_ssh_connection(&persisted_input, persisted.as_deref(), &fingerprint)?;
        if let Some(password_ciphertext) = managed_password.as_deref() {
            save_managed_host_from_ssh(&persisted_input, password_ciphertext, &fingerprint)?;
        }
    }
    let session_id = Uuid::new_v4().to_string();
    let profile = SshConnectionProfile { host: persisted_input.host.clone(), port, username: persisted_input.username.clone(), credentials, fingerprint: fingerprint.clone() };
    store.terminals.lock().map_err(|_| "SSH 终端状态不可用".to_string())?.insert(session_id.clone(), SshTerminal { commands: command_sender, output: output_receiver, profile });
    Ok(SshConnectResult { session_id, host_key_fingerprint: fingerprint })
}

#[tauri::command]
pub(crate) async fn ssh_test_connection(input: SshConnectInput) -> PlatformResult<()> {
    let host = input.host.trim().to_string();
    let username = input.username.trim().to_string();
    let asset_key = input.asset_key.as_deref().unwrap_or_default().trim().to_string();
    if host.is_empty() || username.is_empty() || (input.managed_host_id.is_none() && !input.direct.unwrap_or(false) && (input.account_id.is_none() || asset_key.is_empty())) { return Err("请填写 SSH 主机、用户名和服务器标识".into()); }
    let port = if input.port == 0 { 22 } else { input.port };
    let saved = match input.managed_host_id {
        Some(id) => managed_host_saved_connection(id)?,
        None if input.direct.unwrap_or(false) => None,
        None => ssh_saved_connection(input.account_id.ok_or("缺少云账号标识")?, &asset_key)?,
    };
    let credentials = ssh_credentials(&input, &saved)?;
    let observed_fingerprint = Arc::new(Mutex::new(None));
    let handler = SshHostKeyHandler { expected_fingerprint: saved.as_ref().and_then(|value| value.host_key_fingerprint.clone()), observed_fingerprint: observed_fingerprint.clone() };
    let config = Arc::new(client::Config::default());
    let mut session = client::connect(config, (host.as_str(), port), handler).await.map_err(|error| format!("连接 SSH 主机失败: {error}"))?;
    authenticate_ssh(&mut session, &username, &credentials, "测试").await?;
    session.disconnect(russh::Disconnect::ByApplication, "SSH connection test completed", "en").await.map_err(|error| format!("关闭测试连接失败: {error}"))?;
    Ok(())
}

fn shell_quote(value: &str) -> String { format!("'{}'", value.replace('\'', "'\"'\"'")) }

fn ssh_file_profile(store: &tauri::State<'_, SshTerminalStore>, session_id: &str) -> Result<SshConnectionProfile, String> {
    store.terminals.lock().map_err(|_| "SSH 终端状态不可用".to_string())?.get(session_id).map(|terminal| terminal.profile.clone()).ok_or_else(|| "SSH 会话已关闭".into())
}

async fn ssh_exec(profile: SshConnectionProfile, command: &str, stdin: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
    let observed_fingerprint = Arc::new(Mutex::new(None));
    let handler = SshHostKeyHandler { expected_fingerprint: Some(profile.fingerprint.clone()), observed_fingerprint };
    let config = Arc::new(client::Config::default());
    let mut session = client::connect(config, (profile.host.as_str(), profile.port), handler).await.map_err(|error| format!("文件管理连接 SSH 主机失败: {error}"))?;
    authenticate_ssh(&mut session, &profile.username, &profile.credentials, "文件管理").await?;
    let mut channel = session.channel_open_session().await.map_err(|error| format!("打开文件管理通道失败: {error}"))?;
    channel.exec(true, command).await.map_err(|error| format!("执行远程文件操作失败: {error}"))?;
    if let Some(data) = stdin { channel.data_bytes(bytes::Bytes::from(data)).await.map_err(|error| format!("上传文件失败: {error}"))?; channel.eof().await.map_err(|error| format!("结束上传失败: {error}"))?; }
    let mut output = Vec::new(); let mut exit_status = None;
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => output.extend_from_slice(&data),
            ChannelMsg::ExitStatus { exit_status: status } => exit_status = Some(status),
            _ => {}
        }
    }
    let _ = session.disconnect(russh::Disconnect::ByApplication, "SSH file manager closed", "en").await;
    if exit_status.unwrap_or(1) != 0 { return Err(String::from_utf8_lossy(&output).trim().to_string().if_empty("远程文件操作失败")); }
    Ok(output)
}

trait EmptyFallback { fn if_empty(self, fallback: &str) -> String; }
impl EmptyFallback for String { fn if_empty(self, fallback: &str) -> String { if self.is_empty() { fallback.into() } else { self } } }

fn remote_join(parent: &str, name: &str) -> String { if parent == "/" { format!("/{name}") } else { format!("{}/{}", parent.trim_end_matches('/'), name) } }

fn validate_remote_path(value: &str, allow_root: bool) -> Result<&str, String> {
    let path = value.trim();
    if path.is_empty() || path.contains('\0') || path.split('/').any(|part| part == ".." || part == ".") {
        return Err("远程路径无效，不允许空路径或路径回退".into());
    }
    if !allow_root && path == "/" { return Err("不能操作远程根目录".into()); }
    Ok(path)
}

#[cfg(test)]
mod remote_path_tests {
    use super::validate_remote_path;

    #[test]
    fn permits_absolute_paths_but_rejects_root_for_destructive_operations() {
        assert_eq!(validate_remote_path("/var/www/app.txt", false).unwrap(), "/var/www/app.txt");
        assert!(validate_remote_path("/", false).is_err());
        assert_eq!(validate_remote_path("/", true).unwrap(), "/");
    }

    #[test]
    fn rejects_path_backtracking_and_empty_values() {
        assert!(validate_remote_path("/var/www/../etc", false).is_err());
        assert!(validate_remote_path("./config", false).is_err());
        assert!(validate_remote_path("   ", false).is_err());
    }
}

#[tauri::command]
pub(crate) async fn ssh_list_files(store: tauri::State<'_, SshTerminalStore>, session_id: String, path: String) -> PlatformResult<SshDirectoryListing> {
    let profile = ssh_file_profile(&store, &session_id)?; let requested = if path.trim().is_empty() { "/" } else { validate_remote_path(&path, true)? };
    let command = format!("cd -- {} && printf '%s\\n' \"$PWD\" && find -L . -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%m\\t%u\\t%g\\t%TY-%Tm-%Td %TH:%TM\\t%f\\0' | sort -z", shell_quote(requested));
    let output = ssh_exec(profile, &command, None).await?; let newline = output.iter().position(|byte| *byte == b'\n').ok_or("远程目录返回格式错误")?;
    let resolved = String::from_utf8_lossy(&output[..newline]).trim().to_string(); if resolved.is_empty() { return Err("远程目录路径为空".into()); }
    let entries = String::from_utf8_lossy(&output[newline + 1..]).split('\0').filter(|row| !row.is_empty()).filter_map(|row| {
        let mut columns = row.splitn(7, '\t'); let kind = columns.next()?; let size = columns.next()?.parse::<u64>().unwrap_or(0); let mode = columns.next()?.to_string(); let owner = columns.next()?.to_string(); let group = columns.next()?.to_string(); let modified = columns.next()?.to_string(); let name = columns.next()?.to_string();
        if name.is_empty() { return None; } Some(SshFileEntry { path: remote_join(&resolved, &name), is_dir: kind == "d", is_file: kind == "f", name, size, mode, owner, group, modified })
    }).collect::<Vec<_>>();
    Ok(SshDirectoryListing { path: resolved, entries })
}

#[tauri::command]
pub(crate) async fn ssh_read_text_file(store: tauri::State<'_, SshTerminalStore>, session_id: String, path: String) -> PlatformResult<String> {
    let profile = ssh_file_profile(&store, &session_id)?; let path = validate_remote_path(&path, false)?;
    let quoted = shell_quote(path); let command = format!("if [ -f {quoted} ] && [ \"$(wc -c < {quoted})\" -le 1048576 ]; then base64 -w 0 -- {quoted}; else echo '文件不存在、不是普通文件或超过 1 MB' >&2; exit 2; fi");
    let encoded = ssh_exec(profile, &command, None).await?; let bytes = B64.decode(encoded.iter().filter(|byte| !byte.is_ascii_whitespace()).copied().collect::<Vec<_>>()).map_err(|_| "远程文件内容无法解码".to_string())?;
    String::from_utf8(bytes).map_err(|_| "该文件不是 UTF-8 文本，暂不支持在线编辑；可下载到本机查看".into())
}

#[tauri::command]
pub(crate) async fn ssh_write_text_file(store: tauri::State<'_, SshTerminalStore>, session_id: String, path: String, content: String) -> PlatformResult<()> {
    if content.as_bytes().len() > 1_048_576 { return Err("在线保存仅支持 1 MB 以内文本文件".into()); }
    let profile = ssh_file_profile(&store, &session_id)?; let path = validate_remote_path(&path, false)?;
    ssh_exec(profile, &format!("cat > {}", shell_quote(path)), Some(content.into_bytes())).await?; Ok(())
}

#[tauri::command]
pub(crate) async fn ssh_upload_file(store: tauri::State<'_, SshTerminalStore>, session_id: String, path: String, content_base64: String) -> PlatformResult<()> {
    let bytes = B64.decode(content_base64).map_err(|_| "本地文件数据无效".to_string())?; if bytes.len() > 20 * 1024 * 1024 { return Err("单次上传暂限 20 MB".into()); }
    let profile = ssh_file_profile(&store, &session_id)?; let path = validate_remote_path(&path, false)?;
    ssh_exec(profile, &format!("cat > {}", shell_quote(path)), Some(bytes)).await?; Ok(())
}

#[tauri::command]
pub(crate) async fn ssh_download_file(store: tauri::State<'_, SshTerminalStore>, session_id: String, path: String) -> PlatformResult<String> {
    let profile = ssh_file_profile(&store, &session_id)?; let path = validate_remote_path(&path, false)?;
    let bytes = ssh_exec(profile, &format!("if [ -f {} ]; then cat -- {}; else echo '文件不存在或不是普通文件' >&2; exit 2; fi", shell_quote(path), shell_quote(path)), None).await?; if bytes.len() > 50 * 1024 * 1024 { return Err("单次下载暂限 50 MB".into()); }
    let filename = path.rsplit('/').next().filter(|name| !name.is_empty()).unwrap_or("download").replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_"); let directory = dirs::download_dir().unwrap_or_else(|| std::env::temp_dir()).join("CloudHub Tools"); fs::create_dir_all(&directory).map_err(|error| format!("创建下载目录失败: {error}"))?; let target = directory.join(&filename); fs::write(&target, bytes).map_err(|error| format!("保存下载文件失败: {error}"))?; Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) async fn ssh_make_directory(store: tauri::State<'_, SshTerminalStore>, session_id: String, path: String) -> PlatformResult<()> { let profile = ssh_file_profile(&store, &session_id)?; let path = validate_remote_path(&path, false)?; ssh_exec(profile, &format!("mkdir -- {}", shell_quote(path)), None).await?; Ok(()) }

#[tauri::command]
pub(crate) async fn ssh_delete_path(store: tauri::State<'_, SshTerminalStore>, session_id: String, path: String) -> PlatformResult<()> { let profile = ssh_file_profile(&store, &session_id)?; let path = validate_remote_path(&path, false)?; ssh_exec(profile, &format!("rm -rf -- {}", shell_quote(path)), None).await?; Ok(()) }

#[tauri::command]
pub(crate) fn ssh_read(store: tauri::State<'_, SshTerminalStore>, session_id: String) -> PlatformResult<String> {
    let mut terminals = store.terminals.lock().map_err(|_| "SSH 终端状态不可用".to_string())?;
    let terminal = terminals.get_mut(&session_id).ok_or("SSH 会话已关闭")?;
    Ok(terminal.output.try_iter().collect())
}

#[tauri::command]
pub(crate) fn ssh_write(store: tauri::State<'_, SshTerminalStore>, session_id: String, data: String) -> PlatformResult<()> {
    let mut terminals = store.terminals.lock().map_err(|_| "SSH 终端状态不可用".to_string())?;
    let terminal = terminals.get_mut(&session_id).ok_or("SSH 会话已关闭")?;
    Ok(terminal.commands.send(SshCommand::Data(data)).map_err(|_| "SSH 会话已关闭".to_string())?)
}

#[tauri::command]
pub(crate) fn ssh_resize(store: tauri::State<'_, SshTerminalStore>, session_id: String, cols: u32, rows: u32) -> PlatformResult<()> {
    let mut terminals = store.terminals.lock().map_err(|_| "SSH 终端状态不可用".to_string())?;
    let terminal = terminals.get_mut(&session_id).ok_or("SSH 会话已关闭")?;
    Ok(terminal.commands.send(SshCommand::Resize(cols, rows)).map_err(|_| "SSH 会话已关闭".to_string())?)
}

#[tauri::command]
pub(crate) fn ssh_disconnect(store: tauri::State<'_, SshTerminalStore>, session_id: String) -> PlatformResult<()> {
    let mut terminals = store.terminals.lock().map_err(|_| "SSH 终端状态不可用".to_string())?;
    if let Some(terminal) = terminals.remove(&session_id) {
        let _ = terminal.commands.send(SshCommand::Disconnect);
    }
    Ok(())
}
