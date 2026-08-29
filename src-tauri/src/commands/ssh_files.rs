use crate::{authenticate_ssh, SshCommand, SshConnectionProfile, SshDirectoryListing, SshFileEntry, SshHostKeyHandler, SshTerminalStore};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use russh::{client, ChannelMsg};
use std::{fs, sync::{Arc, Mutex}};

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn profile(store: &tauri::State<'_, SshTerminalStore>, session_id: &str) -> Result<SshConnectionProfile, String> {
    store
        .terminals
        .lock()
        .map_err(|_| "SSH 终端状态不可用".to_string())?
        .get(session_id)
        .map(|terminal| terminal.profile.clone())
        .ok_or_else(|| "SSH 会话已关闭".into())
}

async fn execute(profile: SshConnectionProfile, command: &str, stdin: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
    let observed_fingerprint = Arc::new(Mutex::new(None));
    let handler = SshHostKeyHandler { expected_fingerprint: Some(profile.fingerprint.clone()), observed_fingerprint };
    let config = Arc::new(client::Config::default());
    let mut session = client::connect(config, (profile.host.as_str(), profile.port), handler)
        .await
        .map_err(|error| format!("文件管理连接 SSH 主机失败: {error}"))?;
    authenticate_ssh(&mut session, &profile.username, &profile.credentials, "文件管理").await?;
    let mut channel = session.channel_open_session().await.map_err(|error| format!("打开文件管理通道失败: {error}"))?;
    channel.exec(true, command).await.map_err(|error| format!("执行远程文件操作失败: {error}"))?;
    if let Some(data) = stdin {
        channel.data_bytes(bytes::Bytes::from(data)).await.map_err(|error| format!("上传文件失败: {error}"))?;
        channel.eof().await.map_err(|error| format!("结束上传失败: {error}"))?;
    }
    let mut output = Vec::new();
    let mut exit_status = None;
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => output.extend_from_slice(&data),
            ChannelMsg::ExitStatus { exit_status: status } => exit_status = Some(status),
            _ => {}
        }
    }
    let _ = session.disconnect(russh::Disconnect::ByApplication, "SSH file manager closed", "en").await;
    if exit_status.unwrap_or(1) != 0 {
        let error = String::from_utf8_lossy(&output).trim().to_string();
        return Err(if error.is_empty() { "远程文件操作失败".into() } else { error });
    }
    Ok(output)
}

fn remote_join(parent: &str, name: &str) -> String {
    if parent == "/" { format!("/{name}") } else { format!("{}/{}", parent.trim_end_matches('/'), name) }
}

#[tauri::command]
pub(crate) async fn ssh_list_files(store: tauri::State<'_, SshTerminalStore>, session_id: String, path: String) -> Result<SshDirectoryListing, String> {
    let requested = if path.trim().is_empty() { "/" } else { path.trim() };
    let command = format!("cd -- {} && printf '%s\\n' \"$PWD\" && find -L . -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%m\\t%u\\t%g\\t%TY-%Tm-%Td %TH:%TM\\t%f\\0' | sort -z", shell_quote(requested));
    let output = execute(profile(&store, &session_id)?, &command, None).await?;
    let newline = output.iter().position(|byte| *byte == b'\n').ok_or("远程目录返回格式错误")?;
    let resolved = String::from_utf8_lossy(&output[..newline]).trim().to_string();
    if resolved.is_empty() { return Err("远程目录路径为空".into()); }
    let entries = String::from_utf8_lossy(&output[newline + 1..])
        .split('\0')
        .filter(|row| !row.is_empty())
        .filter_map(|row| {
            let mut columns = row.splitn(7, '\t');
            let kind = columns.next()?;
            let size = columns.next()?.parse::<u64>().unwrap_or(0);
            let mode = columns.next()?.to_string();
            let owner = columns.next()?.to_string();
            let group = columns.next()?.to_string();
            let modified = columns.next()?.to_string();
            let name = columns.next()?.to_string();
            (!name.is_empty()).then(|| SshFileEntry { path: remote_join(&resolved, &name), is_dir: kind == "d", is_file: kind == "f", name, size, mode, owner, group, modified })
        })
        .collect();
    Ok(SshDirectoryListing { path: resolved, entries })
}

#[tauri::command]
pub(crate) async fn ssh_read_text_file(store: tauri::State<'_, SshTerminalStore>, session_id: String, path: String) -> Result<String, String> {
    let path = path.trim();
    if path.is_empty() { return Err("请选择文件".into()); }
    let quoted = shell_quote(path);
    let command = format!("if [ -f {quoted} ] && [ \"$(wc -c < {quoted})\" -le 1048576 ]; then base64 -w 0 -- {quoted}; else echo '文件不存在、不是普通文件或超过 1 MB' >&2; exit 2; fi");
    let encoded = execute(profile(&store, &session_id)?, &command, None).await?;
    let bytes = B64.decode(encoded.iter().filter(|byte| !byte.is_ascii_whitespace()).copied().collect::<Vec<_>>()).map_err(|_| "远程文件内容无法解码".to_string())?;
    String::from_utf8(bytes).map_err(|_| "该文件不是 UTF-8 文本，暂不支持在线编辑；可下载到本机查看".into())
}

#[tauri::command]
pub(crate) async fn ssh_write_text_file(store: tauri::State<'_, SshTerminalStore>, session_id: String, path: String, content: String) -> Result<(), String> {
    if content.as_bytes().len() > 1_048_576 { return Err("在线保存仅支持 1 MB 以内文本文件".into()); }
    let path = path.trim();
    if path.is_empty() { return Err("请选择文件".into()); }
    execute(profile(&store, &session_id)?, &format!("cat > {}", shell_quote(path)), Some(content.into_bytes())).await?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn ssh_upload_file(store: tauri::State<'_, SshTerminalStore>, session_id: String, path: String, content_base64: String) -> Result<(), String> {
    let bytes = B64.decode(content_base64).map_err(|_| "本地文件数据无效".to_string())?;
    if bytes.len() > 20 * 1024 * 1024 { return Err("单次上传暂限 20 MB".into()); }
    let path = path.trim();
    if path.is_empty() { return Err("请选择上传目录".into()); }
    execute(profile(&store, &session_id)?, &format!("cat > {}", shell_quote(path)), Some(bytes)).await?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn ssh_download_file(store: tauri::State<'_, SshTerminalStore>, session_id: String, path: String) -> Result<String, String> {
    let path = path.trim();
    if path.is_empty() { return Err("请选择文件".into()); }
    let bytes = execute(profile(&store, &session_id)?, &format!("if [ -f {} ]; then cat -- {}; else echo '文件不存在或不是普通文件' >&2; exit 2; fi", shell_quote(path), shell_quote(path)), None).await?;
    if bytes.len() > 50 * 1024 * 1024 { return Err("单次下载暂限 50 MB".into()); }
    let filename = path.rsplit('/').next().filter(|name| !name.is_empty()).unwrap_or("download").replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_");
    let directory = dirs::download_dir().unwrap_or_else(std::env::temp_dir).join("CloudHub Tools");
    fs::create_dir_all(&directory).map_err(|error| format!("创建下载目录失败: {error}"))?;
    let target = directory.join(filename);
    fs::write(&target, bytes).map_err(|error| format!("保存下载文件失败: {error}"))?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) async fn ssh_make_directory(store: tauri::State<'_, SshTerminalStore>, session_id: String, path: String) -> Result<(), String> {
    let path = path.trim();
    if path.is_empty() || path == "/" { return Err("请填写新建文件夹名称".into()); }
    execute(profile(&store, &session_id)?, &format!("mkdir -- {}", shell_quote(path)), None).await?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn ssh_delete_path(store: tauri::State<'_, SshTerminalStore>, session_id: String, path: String) -> Result<(), String> {
    let path = path.trim();
    if path.is_empty() || path == "/" { return Err("不能删除根目录".into()); }
    execute(profile(&store, &session_id)?, &format!("rm -rf -- {}", shell_quote(path)), None).await?;
    Ok(())
}

#[tauri::command]
pub(crate) fn ssh_read(store: tauri::State<'_, SshTerminalStore>, session_id: String) -> Result<String, String> {
    let mut terminals = store.terminals.lock().map_err(|_| "SSH 终端状态不可用".to_string())?;
    let terminal = terminals.get_mut(&session_id).ok_or("SSH 会话已关闭")?;
    Ok(terminal.output.try_iter().collect())
}

#[tauri::command]
pub(crate) fn ssh_write(store: tauri::State<'_, SshTerminalStore>, session_id: String, data: String) -> Result<(), String> {
    let mut terminals = store.terminals.lock().map_err(|_| "SSH 终端状态不可用".to_string())?;
    let terminal = terminals.get_mut(&session_id).ok_or("SSH 会话已关闭")?;
    terminal.commands.send(SshCommand::Data(data)).map_err(|_| "SSH 会话已关闭".to_string())
}

#[tauri::command]
pub(crate) fn ssh_resize(store: tauri::State<'_, SshTerminalStore>, session_id: String, cols: u32, rows: u32) -> Result<(), String> {
    let mut terminals = store.terminals.lock().map_err(|_| "SSH 终端状态不可用".to_string())?;
    let terminal = terminals.get_mut(&session_id).ok_or("SSH 会话已关闭")?;
    terminal.commands.send(SshCommand::Resize(cols, rows)).map_err(|_| "SSH 会话已关闭".to_string())
}

#[tauri::command]
pub(crate) fn ssh_disconnect(store: tauri::State<'_, SshTerminalStore>, session_id: String) -> Result<(), String> {
    let mut terminals = store.terminals.lock().map_err(|_| "SSH 终端状态不可用".to_string())?;
    if let Some(terminal) = terminals.remove(&session_id) {
        let _ = terminal.commands.send(SshCommand::Disconnect);
    }
    Ok(())
}
