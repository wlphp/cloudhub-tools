use crate::core::{error::PlatformResult, paths::data_dir, storage::{decrypt_secret, encrypt_secret, open_db}};
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet, VecDeque}, ffi::OsStr, fs, io::Read, net::TcpListener, path::{Path, PathBuf}, process::{Child, Command, Stdio}, sync::{Arc, Mutex}, time::{Duration, Instant}};
use tauri::{ipc::Channel, State};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub(crate) async fn select_frp_tls_file(app: tauri::AppHandle, kind: String) -> PlatformResult<Option<String>> {
    let (title, extensions) = match kind.as_str() {
        "certificate" => ("选择 FRP HTTPS 证书文件", vec!["pem", "crt", "cer"]),
        "private-key" => ("选择 FRP HTTPS 私钥文件", vec!["pem", "key"]),
        _ => return Err("证书文件类型参数无效".into()),
    };
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
        let Some(selected) = app.dialog().file().set_title(title).add_filter("PEM 文件", &extensions).blocking_pick_file() else { return Ok(None); };
        let path = selected.into_path().map_err(|_| "不支持所选文件地址")?;
        let value = path.to_str().filter(|value| valid_plugin_path(value)).ok_or("所选文件路径无效")?;
        let metadata = path.metadata().map_err(|_| "读取所选文件信息失败")?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 2 * 1024 * 1024 { return Err("请选择不超过 2 MB 的非空证书或私钥文件，文件参数无效".into()); }
        let _file = fs::File::open(&path).map_err(|_| "没有权限读取所选文件")?;
        // 仅返回路径，文件内容由本机 frpc 使用，不传入前端或日志。
        Ok(Some(value.to_string()))
    }).await.map_err(|_| "选择证书文件任务失败")?.map_err(Into::into)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrpInstallProgress {
    stage: &'static str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
}

fn install_progress(channel: &Channel<FrpInstallProgress>, stage: &'static str, downloaded_bytes: u64, total_bytes: Option<u64>) {
    // 界面关闭不取消已经授权的安装；通道仅传输阶段和字节数。
    let _ = channel.send(FrpInstallProgress { stage, downloaded_bytes, total_bytes });
}

fn valid_frp_version(value: &str) -> bool {
    let parts: Vec<_> = value.split('.').collect();
    value.len() <= 24 && parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) && (p.len() == 1 || !p.starts_with('0')))
}

fn frp_arch() -> Result<&'static str, String> {
    if !cfg!(windows) { return Err("本机一键安装当前支持 Windows".into()); }
    match std::env::consts::ARCH { "x86_64" => Ok("amd64"), "aarch64" => Ok("arm64"), _ => Err("当前 Windows 架构暂不支持一键安装".into()) }
}

#[derive(Deserialize)]
struct GithubFrpAsset { name: String, digest: Option<String> }
#[derive(Deserialize)]
struct GithubFrpRelease { tag_name: String, draft: bool, prerelease: bool, assets: Vec<GithubFrpAsset> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrpRelease { version: String, architecture: String, release_url: String, sha256: String }

fn supported_release(release: GithubFrpRelease, arch: &str) -> Option<FrpRelease> {
    let version = release.tag_name.strip_prefix('v')?;
    if release.draft || release.prerelease || !valid_frp_version(version) { return None; }
    let name = format!("frp_{version}_windows_{arch}.zip");
    let digest = release.assets.iter().find(|a| a.name == name)?.digest.as_deref()?.strip_prefix("sha256:")?;
    if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) { return None; }
    Some(FrpRelease { version: version.into(), architecture: arch.into(), release_url: format!("https://github.com/fatedier/frp/releases/tag/v{version}"), sha256: digest.to_ascii_lowercase() })
}

async fn frp_download(url: &str, limit: usize, seconds: u64, progress: Option<&Channel<FrpInstallProgress>>) -> Result<Vec<u8>, String> {
    let mut response = reqwest::Client::new().get(url).header("User-Agent", "CloudHubTools").timeout(Duration::from_secs(seconds)).send().await
        .map_err(|_| "访问 FRP 官方 GitHub 失败，请检查网络".to_string())?.error_for_status()
        .map_err(|_| "FRP 官方发布信息不可用或 GitHub 请求限额已用尽，请稍后重试".to_string())?;
    let total = response.content_length().filter(|size| *size > 0);
    if total.is_some_and(|size| size > limit as u64) { return Err("FRP 官方下载数据超过大小限制".into()); }
    if let Some(channel) = progress { install_progress(channel, "downloading", 0, total); }
    let mut last_update = Instant::now();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取 FRP 官方下载数据失败".to_string())? {
        if chunk.len() > limit.saturating_sub(bytes.len()) { return Err("FRP 官方下载数据超过大小限制".into()); }
        bytes.extend_from_slice(&chunk);
        if last_update.elapsed() >= Duration::from_millis(150) {
            if let Some(channel) = progress { install_progress(channel, "downloading", bytes.len() as u64, total); }
            last_update = Instant::now();
        }
    }
    if let Some(channel) = progress { install_progress(channel, "downloading", bytes.len() as u64, total); }
    Ok(bytes)
}

#[tauri::command]
pub(crate) async fn list_frp_releases() -> PlatformResult<Vec<FrpRelease>> {
    let arch = frp_arch()?;
    let bytes = frp_download("https://api.github.com/repos/fatedier/frp/releases?per_page=30", 4_000_000, 30, None).await?;
    let releases: Vec<GithubFrpRelease> = serde_json::from_slice(&bytes).map_err(|_| "解析 FRP 官方版本信息失败".to_string())?;
    let supported: Vec<_> = releases.into_iter().filter_map(|r| supported_release(r, arch)).collect();
    if supported.is_empty() { return Err("没有适合当前系统且带 SHA-256 校验信息的稳定版本".into()); }
    Ok(supported)
}

fn installed_frp_version(binary: &Path) -> Option<String> {
    let mut child = hidden_command(binary).arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) if start.elapsed() < Duration::from_secs(2) => std::thread::sleep(Duration::from_millis(20)),
            _ => { let _ = child.kill(); let _ = child.wait(); return None; }
        }
    }
    let output = child.wait_with_output().ok()?;
    let value = String::from_utf8(output.stdout).ok()?;
    let version = value.trim().trim_start_matches('v');
    valid_frp_version(version).then(|| version.to_string())
}
const FIRST_PANEL_PORT: u16 = 7400;

#[cfg(test)]
mod release_tests {
    use super::*;

    #[test]
    fn occupied_panel_port_records_failure_before_spawn() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let buffer: FrpLogBuffer = Arc::new(Mutex::new(VecDeque::new()));
        let error = check_panel_port(port, &buffer).unwrap_err();
        assert!(error.contains("已被占用"));
        assert!(buffer.lock().unwrap().back().unwrap().contains(&port.to_string()));
        drop(listener);
        assert!(check_panel_port(port, &buffer).is_ok());
    }

    #[test]
    fn runtime_logs_redact_before_buffering_and_remain_bounded() {
        let secret = uuid::Uuid::new_v4().to_string();
        let buffer: FrpLogBuffer = Arc::new(Mutex::new(VecDeque::new()));
        let output = format!("\u{1b}[32mconnected\u{1b}[0m\nvalue {secret}\nauth.token = unknown\n{}\nlast line", "x".repeat(FRP_LOG_LINE_BYTES + 1));
        read_frp_output(std::io::Cursor::new(output.into_bytes()), buffer.clone(), "输出", Arc::new(vec![secret.clone()])).join().unwrap();
        let logs = buffer.lock().unwrap();
        assert!(logs.iter().all(|line| !line.contains(&secret) && !line.contains('\u{1b}')));
        assert!(logs.iter().any(|line| line.contains("connected")));
        assert!(logs.iter().any(|line| line.contains("[已隐藏]")));
        assert!(logs.iter().any(|line| line.contains("[含凭据信息的日志已隐藏]")));
        assert!(logs.iter().any(|line| line.contains("[日志行过长，已省略]")));
        assert!(logs.back().unwrap().ends_with("last line"));
        drop(logs);
        for index in 0..400 { push_frp_log(&buffer, "系统", &index.to_string()); }
        let logs = buffer.lock().unwrap();
        assert_eq!(logs.len(), FRP_LOG_LINES);
        assert!(logs.front().unwrap().ends_with("100"));
        assert!(logs.back().unwrap().ends_with("399"));
    }

    fn download_server(headers: &'static str, chunks: Vec<&'static [u8]>) -> String {
        use std::io::{Read, Write};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 2048]; let _ = stream.read(&mut request);
            stream.write_all(format!("HTTP/1.1 200 OK\r\nConnection: close\r\n{headers}\r\n").as_bytes()).unwrap();
            for chunk in chunks {
                if stream.write_all(chunk).is_err() { break; }
                let _ = stream.flush();
                std::thread::sleep(Duration::from_millis(180));
            }
        });
        format!("http://{address}/package.zip")
    }

    fn recording_channel() -> (Channel<FrpInstallProgress>, Arc<Mutex<Vec<serde_json::Value>>>) {
        let messages = Arc::new(Mutex::new(Vec::new()));
        let capture = messages.clone();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                capture.lock().unwrap().push(serde_json::from_str(&json).unwrap());
            }
            Ok(())
        });
        (channel, messages)
    }

    #[tokio::test]
    async fn download_reports_actual_bytes_and_unknown_size() {
        for (headers, expected_total) in [("Content-Length: 8\r\n", Some(8)), ("", None)] {
            let (channel, messages) = recording_channel();
            let url = download_server(headers, vec![b"ab", b"cd", b"efgh"]);
            assert_eq!(frp_download(&url, 16, 3, Some(&channel)).await.unwrap(), b"abcdefgh");
            let events = messages.lock().unwrap();
            assert_eq!(events.first().unwrap()["downloadedBytes"], 0);
            assert_eq!(events.last().unwrap()["downloadedBytes"], 8);
            assert!(events.iter().any(|event| event["downloadedBytes"] == 4));
            assert!(events.iter().all(|event| event["totalBytes"].as_u64() == expected_total));
            assert!(events.iter().all(|event| event["stage"] == "downloading"));
        }
    }

    #[tokio::test]
    async fn reject_incomplete_and_oversized_downloads() {
        let url = download_server("Content-Length: 10\r\n", vec![b"abcd"]);
        assert!(frp_download(&url, 16, 3, None).await.is_err());
        let url = download_server("Content-Length: 100\r\n", vec![]);
        assert!(frp_download(&url, 16, 3, None).await.is_err());
        let url = download_server("", vec![b"abcdefghijklmnop", b"extra"]);
        assert!(frp_download(&url, 16, 3, None).await.is_err());
    }

    fn release(digest: Option<&str>) -> GithubFrpRelease {
        GithubFrpRelease { tag_name: "v0.71.0".into(), draft: false, prerelease: false,
            assets: vec![GithubFrpAsset { name: "frp_0.71.0_windows_amd64.zip".into(), digest: digest.map(str::to_string) }] }
    }

    #[test]
    fn reject_unsafe_versions() {
        for value in ["", "../0.71.0", "0.71.0/bad", "0.71.0?x", "0.71", "0.71.0-beta", "00.71.0", "0.７1.0"] {
            assert!(!valid_frp_version(value));
        }
        assert!(valid_frp_version("0.71.0"));
    }

    #[test]
    fn require_matching_stable_asset_and_digest() {
        let digest = format!("sha256:{}", "a".repeat(64));
        let selected = supported_release(release(Some(&digest)), "amd64").unwrap();
        assert_eq!(selected.version, "0.71.0");
        assert_eq!(selected.release_url, "https://github.com/fatedier/frp/releases/tag/v0.71.0");
        assert!(supported_release(release(Some(&digest)), "arm64").is_none());
        assert!(supported_release(release(None), "amd64").is_none());
        assert!(supported_release(release(Some("sha256:invalid")), "amd64").is_none());
        let mut prerelease = release(Some(&digest)); prerelease.prerelease = true;
        assert!(supported_release(prerelease, "amd64").is_none());
        let mut draft = release(Some(&digest)); draft.draft = true;
        assert!(supported_release(draft, "amd64").is_none());
    }
}

#[derive(Clone, Default)]
pub(crate) struct FrpProcessStore(Arc<Mutex<HashMap<i64, Child>>>, Arc<Mutex<HashMap<i64, FrpLogBuffer>>>);

type FrpLogBuffer = Arc<Mutex<VecDeque<String>>>;
const FRP_LOG_LINES: usize = 300;
const FRP_LOG_LINE_BYTES: usize = 8192;

fn push_frp_log(buffer: &FrpLogBuffer, source: &str, text: &str) {
    if let Ok(mut lines) = buffer.lock() {
        while lines.len() >= FRP_LOG_LINES { lines.pop_front(); }
        let text = if text.len() > FRP_LOG_LINE_BYTES { "[日志行过长，已省略]" } else { text };
        lines.push_back(format!("[{}] [{source}] {text}", Utc::now().format("%H:%M:%S UTC")));
    }
}

fn sanitize_frp_line(text: &str, secrets: &[String]) -> String {
    let mut cleaned = String::new();
    let mut escape = false;
    for c in text.chars() {
        if c == '\u{1b}' { escape = true; continue; }
        if escape { if c.is_ascii_alphabetic() { escape = false; } continue; }
        if !c.is_control() { cleaned.push(c); }
    }
    for secret in secrets.iter().filter(|value| !value.is_empty()) { cleaned = cleaned.replace(secret, "[已隐藏]"); }
    let lower = cleaned.to_ascii_lowercase();
    if ["token", "password", "authorization", "secret", "private key", "private_key", "credential"].iter().any(|key| lower.contains(key)) {
        return "[含凭据信息的日志已隐藏]".into();
    }
    cleaned
}

fn frp_log_secrets(config: &Path, server: &SavedServer) -> Result<Vec<String>, String> {
    let mut secrets = Vec::new();
    if let Some(ciphertext) = &server.token_ciphertext { secrets.push(decrypt_secret(ciphertext)?); }
    if let Some(global) = get_global()? { secrets.push(decrypt_secret(&global.admin_password_ciphertext)?); }
    // 同时覆盖尚未同步到数据库的手工配置中的凭据；解析失败时禁止采集原始输出。
    let content = fs::read_to_string(config).map_err(|_| "读取日志脱敏配置失败".to_string())?;
    for line in content.lines() {
        let Some((key, value)) = line.split_once('=') else { continue; };
        if !["token", "password", "secret"].iter().any(|part| key.to_ascii_lowercase().contains(part)) { continue; }
        let value = value.trim();
        let secret = serde_json::from_str::<String>(value).ok().or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')).map(str::to_string))
            .ok_or("无法安全解析日志脱敏配置")?;
        secrets.push(secret);
    }
    // 长值优先替换，避免某个短凭据先破坏另一个完整凭据的匹配。
    if secrets.iter().any(|secret| secret.chars().any(char::is_control)) { return Err("凭据包含控制字符，无法安全采集日志".into()); }
    secrets.sort_by_key(|value| std::cmp::Reverse(value.len()));
    Ok(secrets)
}

fn read_frp_output(mut reader: impl Read + Send + 'static, buffer: FrpLogBuffer, source: &'static str, secrets: Arc<Vec<String>>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut chunk = [0; 2048]; let mut line = Vec::new(); let mut overflow = false;
        loop {
            let count = match reader.read(&mut chunk) { Ok(0) => break, Ok(count) => count, Err(_) => { push_frp_log(&buffer, "系统", "读取客户端输出失败"); break; } };
            for byte in &chunk[..count] {
                if *byte == b'\n' {
                    if overflow { push_frp_log(&buffer, source, "[日志行过长，已省略]"); }
                    else if !line.is_empty() { push_frp_log(&buffer, source, &sanitize_frp_line(&String::from_utf8_lossy(&line), &secrets)); }
                    line.clear(); overflow = false;
                } else if !overflow {
                    if line.len() >= FRP_LOG_LINE_BYTES { line.clear(); overflow = true; } else { line.push(*byte); }
                }
            }
        }
        if overflow { push_frp_log(&buffer, source, "[日志行过长，已省略]"); }
        else if !line.is_empty() { push_frp_log(&buffer, source, &sanitize_frp_line(&String::from_utf8_lossy(&line), &secrets)); }
    })
}

#[tauri::command]
pub(crate) fn get_frpc_logs(store: State<'_, FrpProcessStore>, server_id: i64) -> PlatformResult<Vec<String>> {
    load_server(server_id)?.ok_or("FRP 服务端配置不存在")?;
    is_running(&store, server_id)?;
    let buffer = store.1.lock().map_err(|_| "FRP 日志状态不可用".to_string())?.get(&server_id).cloned();
    match buffer {
        Some(buffer) => Ok(buffer.lock().map_err(|_| "FRP 日志读取失败".to_string())?.iter().cloned().collect()),
        None => Ok(Vec::new()),
    }
}

impl Drop for FrpProcessStore {
    fn drop(&mut self) {
        if Arc::strong_count(&self.0) == 1 {
            if let Some(mutex) = Arc::get_mut(&mut self.0) {
                if let Ok(processes) = mutex.get_mut() {
                    for (_, mut child) in processes.drain() { let _ = child.kill(); let _ = child.wait(); }
                }
            }
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrpProxy {
    id: Option<i64>,
    server_id: i64,
    name: String,
    kind: String,
    local_ip: String,
    local_port: u16,
    remote_port: Option<u16>,
    custom_domain: Option<String>,
    #[serde(default)]
    custom_domains: Vec<String>,
    #[serde(default)]
    plugin: Option<FrpHttps2HttpPlugin>,
    enabled: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FrpHttps2HttpPlugin {
    #[serde(rename = "type")]
    kind: String,
    local_addr: String,
    crt_path: String,
    key_path: String,
}

impl FrpProxy {
    fn domains(&self) -> Vec<String> {
        if self.custom_domains.is_empty() {
            self.custom_domain.iter().cloned().collect()
        } else { self.custom_domains.clone() }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrpServerInput {
    id: Option<i64>,
    name: String,
    server_addr: String,
    server_port: u16,
    token: Option<String>,
    panel_url: Option<String>,
    panel_username: Option<String>,
    panel_password: Option<String>,
    proxies: Vec<FrpProxy>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrpServer {
    id: i64,
    name: String,
    server_addr: String,
    server_port: u16,
    token_saved: bool,
    panel_url: Option<String>,
    panel_username: Option<String>,
    panel_password_saved: bool,
    admin_port: u16,
    proxies: Vec<FrpProxy>,
    updated_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrpGlobalSettingsInput {
    admin_user: String,
    admin_password: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrpGlobalSettings {
    admin_user: String,
    admin_password_saved: bool,
}

struct SavedGlobalSettings { admin_user: String, admin_password_ciphertext: String }
struct SavedServer { server_addr: String, server_port: u16, token_ciphertext: Option<String>, admin_port: u16, proxies: Vec<FrpProxy> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrpProxyRuntime { name: String, status: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrpRuntime {
    server_id: i64,
    installed: bool,
    config_present: bool,
    config_current: bool,
    running: bool,
    connected: bool,
    version: Option<String>,
    proxies: Vec<FrpProxyRuntime>,
}

fn get_global() -> Result<Option<SavedGlobalSettings>, String> {
    open_db()?.query_row("SELECT admin_user,admin_password_ciphertext FROM frp_local_settings WHERE id=1", [], |row| Ok(SavedGlobalSettings { admin_user: row.get(0)?, admin_password_ciphertext: row.get(1)? })).optional().map_err(|error| format!("读取 FRP 全局设置失败: {error}"))
}

#[tauri::command]
pub(crate) fn get_frp_global_settings() -> PlatformResult<Option<FrpGlobalSettings>> {
    Ok(get_global()?.map(|saved| FrpGlobalSettings { admin_user: saved.admin_user, admin_password_saved: !saved.admin_password_ciphertext.is_empty() }))
}

#[tauri::command]
pub(crate) fn reveal_frp_server_token(server_id: i64) -> PlatformResult<String> {
    let server = load_server(server_id)?.ok_or("FRP 服务端配置不存在")?;
    match server.token_ciphertext {
        Some(ciphertext) => decrypt_secret(&ciphertext).map_err(|_| "读取 FRP 认证 Token 失败".into()),
        None => Ok(String::new()),
    }
}

#[tauri::command]
pub(crate) fn reveal_frp_admin_password() -> PlatformResult<String> {
    let saved = get_global()?.ok_or("尚未设置 FRP 客户端面板密码")?;
    decrypt_secret(&saved.admin_password_ciphertext)
        .map_err(|_| "读取 FRP 客户端面板密码失败".into())
}

#[tauri::command]
pub(crate) fn save_frp_global_settings(input: FrpGlobalSettingsInput) -> PlatformResult<FrpGlobalSettings> {
    if input.admin_user.is_empty() || input.admin_user.len() > 64 || !input.admin_user.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte)) { return Err("客户端面板账号无效".into()); }
    if input.admin_password.as_ref().is_some_and(|value| value.len() > 256) { return Err("客户端面板密码长度无效".into()); }
    let existing = get_global()?;
    let password = match input.admin_password.as_deref().filter(|value| !value.is_empty()) { Some(value) => encrypt_secret(value)?, None => existing.as_ref().map(|value| value.admin_password_ciphertext.clone()).filter(|value| !value.is_empty()).ok_or("首次配置必须填写客户端面板密码")? };
    open_db()?.execute("INSERT INTO frp_local_settings(id,admin_user,admin_password_ciphertext,updated_at) VALUES(1,?1,?2,?3) ON CONFLICT(id) DO UPDATE SET admin_user=excluded.admin_user,admin_password_ciphertext=excluded.admin_password_ciphertext,updated_at=excluded.updated_at", params![input.admin_user, password, Utc::now().timestamp_millis()]).map_err(|error| error.to_string())?;
    Ok(FrpGlobalSettings { admin_user: input.admin_user, admin_password_saved: true })
}

fn load_proxies(server_id: i64) -> Result<Vec<FrpProxy>, String> {
    let db = open_db()?;
    load_proxies_from(&db, server_id)
}

fn load_proxies_from(db: &rusqlite::Connection, server_id: i64) -> Result<Vec<FrpProxy>, String> {
    let mut statement = db.prepare("SELECT id,name,kind,local_ip,local_port,remote_port,custom_domain,enabled,custom_domains_json,plugin_json FROM frp_local_proxies WHERE server_id=?1 ORDER BY id").map_err(|error| error.to_string())?;
    let result = statement.query_map([server_id], |row| {
        let domains_json: String = row.get(8)?;
        let plugin_json: Option<String> = row.get(9)?;
        let decode_error = |index, error| rusqlite::Error::FromSqlConversionFailure(index, rusqlite::types::Type::Text, Box::new(error));
        Ok(FrpProxy { id: Some(row.get(0)?), server_id, name: row.get(1)?, kind: row.get(2)?, local_ip: row.get(3)?, local_port: row.get(4)?, remote_port: row.get(5)?, custom_domain: row.get(6)?, enabled: row.get(7)?, custom_domains: serde_json::from_str(&domains_json).map_err(|error| decode_error(8, error))?, plugin: plugin_json.map(|json| serde_json::from_str(&json).map_err(|error| decode_error(9, error))).transpose()? })
    }).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string());
    result
}

fn insert_proxy(tx: &rusqlite::Transaction<'_>, server_id: i64, proxy: &FrpProxy, now: i64) -> Result<(), String> {
    let domains = proxy.domains();
    let domains_json = serde_json::to_string(&domains).map_err(|_| "保存 FRP 域名失败")?;
    let plugin_json = proxy.plugin.as_ref().map(serde_json::to_string).transpose().map_err(|_| "保存 FRP 插件失败")?;
    tx.execute("INSERT INTO frp_local_proxies(server_id,name,kind,local_ip,local_port,remote_port,custom_domain,enabled,created_at,updated_at,custom_domains_json,plugin_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,?10,?11)",params![server_id,proxy.name,proxy.kind,proxy.local_ip.trim(),proxy.local_port,proxy.remote_port,domains.first(),proxy.enabled,now,domains_json,plugin_json]).map_err(|e|e.to_string())?;
    Ok(())
}

fn load_server(server_id: i64) -> Result<Option<SavedServer>, String> {
    let row = open_db()?.query_row("SELECT server_addr,server_port,token_ciphertext,admin_port FROM frp_local_servers WHERE id=?1", [server_id], |row| Ok((row.get::<_,String>(0)?, row.get::<_,u16>(1)?, row.get::<_,Option<String>>(2)?, row.get::<_,u16>(3)?))).optional().map_err(|error| format!("读取 FRP 服务端失败: {error}"))?;
    row.map(|(server_addr,server_port,token_ciphertext,admin_port)| Ok(SavedServer { server_addr,server_port,token_ciphertext,admin_port,proxies:load_proxies(server_id)? })).transpose()
}

#[tauri::command]
pub(crate) fn list_frp_servers() -> PlatformResult<Vec<FrpServer>> {
    let db = open_db()?;
    let rows = {
        let mut statement = db.prepare("SELECT id,name,server_addr,server_port,token_ciphertext,admin_port,updated_at,panel_url,panel_username,panel_password_ciphertext FROM frp_local_servers ORDER BY id").map_err(|error| error.to_string())?;
        let result = statement.query_map([], |row| Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,u16>(3)?,row.get::<_,Option<String>>(4)?,row.get::<_,u16>(5)?,row.get::<_,i64>(6)?,row.get::<_,Option<String>>(7)?,row.get::<_,Option<String>>(8)?,row.get::<_,Option<String>>(9)?))).map_err(|error| error.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|error| error.to_string())?;
        result
    };
    rows.into_iter().map(|(id,name,server_addr,server_port,token,admin_port,updated_at,panel_url,panel_username,panel_password)| Ok(FrpServer { id,name,server_addr,server_port,token_saved:token.as_ref().is_some_and(|value| !value.is_empty()),panel_url,panel_username,panel_password_saved:panel_password.as_ref().is_some_and(|value|!value.is_empty()),admin_port,proxies:load_proxies(id)?,updated_at })).collect::<Result<Vec<_>,String>>().map_err(Into::into)
}

fn valid_hostname(value: &str) -> bool { !value.is_empty() && value.len() <= 253 && value.split('.').all(|part| !part.is_empty() && part.len() <= 63 && !part.starts_with('-') && !part.ends_with('-') && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')) }
fn valid_address(value: &str) -> bool { valid_hostname(value) || value.parse::<std::net::IpAddr>().is_ok() }

fn valid_server_panel_url(value: &str) -> Result<String, String> {
    let invalid = || "服务端面板地址需为 HTTP/HTTPS 地址，不能包含账号、密码、查询参数或片段".to_string();
    if value.len() > 2048 || value.chars().any(char::is_control) { return Err(invalid()); }
    let url = reqwest::Url::parse(value).map_err(|_| invalid())?;
    if !["http", "https"].contains(&url.scheme()) || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() || url.port() == Some(0) { return Err(invalid()); }
    Ok(url.to_string())
}

#[cfg(test)]
mod server_panel_tests {
    use super::*;

    #[test]
    fn restricts_panel_opening_to_plain_web_addresses() {
        for value in ["file:///C:/test", "javascript:alert(1)", "https://user@example.test", "http://example.test/?token=fixture", "https://example.test/#fragment", "http://example.test:0", "https://example.test/\n"] {
            assert!(valid_server_panel_url(value).is_err());
        }
        assert_eq!(valid_server_panel_url("https://example.test:7500/panel").unwrap(), "https://example.test:7500/panel");
        assert!(valid_server_panel_url("http://[::1]:7500").is_ok());
    }

    #[test]
    fn legacy_inputs_leave_panel_notes_unspecified_and_responses_hide_password() {
        let input: FrpServerInput = serde_json::from_value(serde_json::json!({"name":"fixture","serverAddr":"example.test","serverPort":7000,"proxies":[]})).unwrap();
        assert!(input.panel_url.is_none() && input.panel_username.is_none() && input.panel_password.is_none());
        let server = FrpServer { id:1,name:input.name,server_addr:input.server_addr,server_port:7000,token_saved:false,panel_url:None,panel_username:None,panel_password_saved:true,admin_port:7400,proxies:vec![],updated_at:0 };
        let value = serde_json::to_value(server).unwrap();
        assert_eq!(value["panelPasswordSaved"],true);
        assert!(value.get("panelPassword").is_none() && value.get("panelPasswordCiphertext").is_none());
    }
}

#[cfg(test)]
mod https2http_tests {
    use super::*;

    fn input() -> FrpServerInput {
        serde_json::from_value(serde_json::json!({"name":"fixture","serverAddr":"example.test","serverPort":7000,"proxies":[{
            "serverId":1,"name":"https_plugin","kind":"https","localIp":"127.0.0.1","localPort":5012,"enabled":true,
            "customDomains":["one.example.test","two.example.test"],
            "plugin":{"type":"https2http","localAddr":"127.0.0.1:5012","crtPath":"/fixture/fullchain.pem","keyPath":"/fixture/privkey.key"}
        }]})).unwrap()
    }

    #[test]
    fn renders_https2http_and_multiple_domains_without_changing_legacy_rules() {
        let mut input = input();
        validate_server(&input).unwrap();
        let rendered = render_proxy_config(&input.proxies[0]).unwrap();
        assert!(rendered.contains("customDomains = [\"one.example.test\",\"two.example.test\"]"));
        assert!(rendered.contains("[proxies.plugin]\ntype = \"https2http\"\nlocalAddr = \"127.0.0.1:5012\""));
        assert!(rendered.contains("keyPath = \"/fixture/privkey.key\""));
        input.proxies[0].plugin = None;
        input.proxies[0].custom_domains.clear();
        input.proxies[0].custom_domain = Some("legacy.example.test".into());
        validate_server(&input).unwrap();
        let legacy = render_proxy_config(&input.proxies[0]).unwrap();
        assert!(legacy.contains("customDomains = [\"legacy.example.test\"]"));
        assert!(!legacy.contains("[proxies.plugin]"));
    }

    #[test]
    fn persists_https2http_and_all_domains_in_sqlite() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE frp_local_proxies(id INTEGER PRIMARY KEY,server_id INTEGER,name TEXT,kind TEXT,local_ip TEXT,local_port INTEGER,remote_port INTEGER,custom_domain TEXT,enabled INTEGER,created_at INTEGER,updated_at INTEGER,custom_domains_json TEXT,plugin_json TEXT);").unwrap();
        let input = input();
        let tx = db.transaction().unwrap();
        insert_proxy(&tx,1,&input.proxies[0],0).unwrap();
        tx.commit().unwrap();
        let loaded = load_proxies_from(&db,1).unwrap();
        assert_eq!(loaded[0].custom_domains, input.proxies[0].custom_domains);
        assert_eq!(loaded[0].plugin.as_ref().unwrap().local_addr,"127.0.0.1:5012");
        assert_eq!(loaded[0].plugin.as_ref().unwrap().key_path,"/fixture/privkey.key");
        assert_eq!(render_proxy_config(&loaded[0]).unwrap(),render_proxy_config(&input.proxies[0]).unwrap());
    }

    #[test]
    fn installed_frpc_verifies_generated_https2http_config() {
        let Some(binary) = std::env::var_os("CLOUDHUB_FRPC_TEST_BINARY") else { return; };
        let input = input();
        let path = std::env::temp_dir().join(format!("cloudhub-frp-https2http-{}.toml",uuid::Uuid::new_v4()));
        let config = format!("serverAddr = \"127.0.0.1\"\nserverPort = 7000\n{}{}",render_proxy_config(&input.proxies[0]).unwrap(),render_proxy_config(&input.proxies[0]).unwrap().replace("https_plugin","second_plugin").replace("one.example.test","three.example.test").replace("two.example.test","four.example.test"));
        fs::write(&path,config).unwrap();
        let result = hidden_command(binary).args(["verify","-c"]).arg(&path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
        let _ = fs::remove_file(&path);
        assert!(result.unwrap().success(),"本机 frpc 未接受生成的插件配置");
    }

    #[test]
    fn rejects_wrong_plugin_protocol_duplicate_domains_and_unsafe_fields() {
        let mut input = input();
        input.proxies[0].kind = "http".into();
        assert!(validate_server(&input).is_err());
        input.proxies[0].kind = "https".into();
        input.proxies[0].custom_domains.push("ONE.example.test".into());
        assert!(validate_server(&input).is_err());
        for value in ["http://127.0.0.1:80", "user@host:80", "127.0.0.1:0", "host:65536", "::1:80"] { assert!(!valid_plugin_address(value)); }
        for value in ["127.0.0.1:5012", "backend.example.test:80", "[::1]:80"] { assert!(valid_plugin_address(value)); }
        for value in ["", "relative.key", "/path\nkey", "-----BEGIN PRIVATE KEY-----"] { assert!(!valid_plugin_path(value)); }
    }
}

#[tauri::command]
pub(crate) fn reveal_frp_server_panel_password(server_id: i64) -> PlatformResult<String> {
    let value: Option<String> = open_db()?.query_row("SELECT panel_password_ciphertext FROM frp_local_servers WHERE id=?1", [server_id], |row| row.get(0)).optional().map_err(|_| "读取服务端面板密码失败".to_string())?.ok_or("FRP 服务端配置不存在")?;
    match value { Some(value) => Ok(decrypt_secret(&value)?), None => Ok(String::new()) }
}

#[tauri::command]
pub(crate) fn open_frp_server_panel(server_id: i64) -> PlatformResult<()> {
    let value: Option<String> = open_db()?.query_row("SELECT panel_url FROM frp_local_servers WHERE id=?1", [server_id], |row| row.get(0)).optional().map_err(|_| "读取服务端面板地址失败".to_string())?.ok_or("FRP 服务端配置不存在")?;
    let url = valid_server_panel_url(value.as_deref().ok_or("请先保存服务端面板地址")?)?;
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|_| "打开服务端面板失败".to_string())?;
    Ok(())
}

fn validate_server(input: &FrpServerInput) -> Result<(), String> {
    if input.name.trim().is_empty() || input.name.len() > 80 || input.server_port == 0 || !valid_address(input.server_addr.trim()) { return Err("服务端名称、地址或端口无效".into()); }
    if input.token.as_ref().is_some_and(|value| value.len() > 1024) { return Err("服务端 Token 长度无效".into()); }
    if let Some(url) = input.panel_url.as_deref().filter(|url| !url.trim().is_empty()) { valid_server_panel_url(url.trim())?; }
    if input.panel_username.as_ref().is_some_and(|v|v.len()>128 || v.chars().any(char::is_control)) || input.panel_password.as_ref().is_some_and(|v|v.len()>1024 || v.chars().any(char::is_control)) { return Err("服务端面板账号或密码格式无效".into()); }
    if input.proxies.len() > 100 { return Err("每个服务端最多配置 100 条穿透规则".into()); }
    let mut names = HashSet::new(); let mut ports = HashSet::new(); let mut domains = HashSet::new();
    for proxy in &input.proxies {
        if proxy.name.is_empty() || proxy.name.len() > 64 || !proxy.name.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte)) || !names.insert(&proxy.name) { return Err("穿透规则名称无效或重复".into()); }
        if !["tcp","udp","http","https"].contains(&proxy.kind.as_str()) || !valid_address(proxy.local_ip.trim()) || proxy.local_port == 0 { return Err("穿透规则类型或本地目标无效".into()); }
        if ["tcp","udp"].contains(&proxy.kind.as_str()) {
            let port = proxy.remote_port.unwrap_or(0); if port == 0 || !proxy.domains().is_empty() || !ports.insert((proxy.kind.as_str(),port)) { return Err("TCP/UDP 远端端口无效或重复".into()); }
        } else {
            let values = proxy.domains();
            if values.is_empty() || values.len() > 20 || proxy.remote_port.is_some() { return Err("HTTP/HTTPS 规则需要 1 至 20 个有效域名".into()); }
            for domain in values {
                if !valid_hostname(&domain) || !domains.insert((proxy.kind.as_str(), domain.to_ascii_lowercase())) { return Err("HTTP/HTTPS 域名无效或重复".into()); }
            }
        }
        if let Some(plugin) = &proxy.plugin {
            if proxy.kind != "https" || plugin.kind != "https2http" || !valid_plugin_address(&plugin.local_addr) || !valid_plugin_path(&plugin.crt_path) || !valid_plugin_path(&plugin.key_path) {
                return Err("HTTPS 转 HTTP 插件参数无效，请检查后端地址及证书、私钥文件路径".into());
            }
        }
    }
    Ok(())
}

fn valid_plugin_address(value: &str) -> bool {
    let Some((host, port)) = value.rsplit_once(':') else { return false; };
    let host = if host.starts_with('[') && host.ends_with(']') { &host[1..host.len()-1] } else if host.contains(':') { return false; } else { host };
    valid_address(host) && port.parse::<u16>().is_ok_and(|port| port > 0)
}

fn valid_plugin_path(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && !value.chars().any(char::is_control) && !value.contains("-----BEGIN")
        && (Path::new(value).is_absolute() || value.starts_with('/'))
}

fn panel_port_available(port: u16) -> bool { TcpListener::bind(("127.0.0.1",port)).is_ok() }
fn allocate_panel_port(db: &rusqlite::Connection, existing_id: Option<i64>) -> Result<u16,String> {
    if let Some(id)=existing_id { if let Some(port)=db.query_row("SELECT admin_port FROM frp_local_servers WHERE id=?1",[id],|r|r.get::<_,u16>(0)).optional().map_err(|e|e.to_string())? { return Ok(port); } }
    for port in FIRST_PANEL_PORT..=u16::MAX {
        let used: bool=db.query_row("SELECT EXISTS(SELECT 1 FROM frp_local_servers WHERE admin_port=?1)",[port],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !used && panel_port_available(port) { return Ok(port); }
    }
    Err("没有可用的本机客户端面板端口".into())
}

#[tauri::command]
pub(crate) fn save_frp_server(input: FrpServerInput) -> PlatformResult<FrpServer> {
    validate_server(&input)?;
    let existing=load_server(input.id.unwrap_or_default())?;
    if input.id.is_some() && existing.is_none() { return Err("FRP 服务端配置不存在".into()); }
    let token=match input.token.as_deref() { Some(value) if !value.is_empty()=>Some(encrypt_secret(value)?),Some(_)=>None,None=>existing.as_ref().and_then(|server|server.token_ciphertext.clone()) };
    let db=open_db()?; let panel_port=allocate_panel_port(&db,input.id)?; let now=Utc::now().timestamp_millis();
    let previous_panel: (Option<String>, Option<String>, Option<String>) = if let Some(id) = input.id {
        db.query_row("SELECT panel_url,panel_username,panel_password_ciphertext FROM frp_local_servers WHERE id=?1", [id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).map_err(|_| "读取服务端面板备注失败".to_string())?
    } else { (None, None, None) };
    let panel_url = match input.panel_url.as_deref() { Some(value) if !value.trim().is_empty() => Some(valid_server_panel_url(value.trim())?), Some(_) => None, None => previous_panel.0 };
    let panel_username = input.panel_username.as_ref().map(|v|v.trim().to_string()).or(previous_panel.1);
    let panel_password = match input.panel_password.as_deref() { Some(value) if !value.is_empty() => Some(encrypt_secret(value)?), Some(_) => None, None => previous_panel.2 };
    let tx=db.unchecked_transaction().map_err(|e|e.to_string())?;
    let id=if let Some(id)=input.id {
        tx.execute("UPDATE frp_local_servers SET name=?1,server_addr=?2,server_port=?3,token_ciphertext=?4,updated_at=?5 WHERE id=?6",params![input.name.trim(),input.server_addr.trim(),input.server_port,token,now,id]).map_err(|e|e.to_string())?; id
    } else {
        tx.execute("INSERT INTO frp_local_servers(name,server_addr,server_port,token_ciphertext,admin_port,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6)",params![input.name.trim(),input.server_addr.trim(),input.server_port,token,panel_port,now]).map_err(|e|e.to_string())?; tx.last_insert_rowid()
    };
    tx.execute("UPDATE frp_local_servers SET panel_url=?1,panel_username=?2,panel_password_ciphertext=?3 WHERE id=?4", params![panel_url,panel_username,panel_password,id]).map_err(|_| "保存服务端面板备注失败".to_string())?;
    tx.execute("DELETE FROM frp_local_proxies WHERE server_id=?1",[id]).map_err(|e|e.to_string())?;
    for proxy in input.proxies { insert_proxy(&tx, id, &proxy, now)?; }
    tx.commit().map_err(|e|e.to_string())?;
    Ok(list_frp_servers()?.into_iter().find(|server|server.id==id).ok_or_else(||String::from("保存 FRP 服务端失败"))?)
}

#[tauri::command]
pub(crate) fn delete_frp_server(store: State<'_,FrpProcessStore>, id:i64) -> PlatformResult<()> {
    stop_process(&store,id)?;
    let changed=open_db()?.execute("DELETE FROM frp_local_servers WHERE id=?1",[id]).map_err(|e|e.to_string())?;
    if changed==0 { return Err("FRP 服务端配置不存在".into()); }
    if let Ok(mut logs) = store.1.lock() { logs.remove(&id); }
    let _=fs::remove_dir_all(server_dir(id)?); Ok(())
}

fn toml_string(value:&str)->Result<String,String>{serde_json::to_string(value).map_err(|_|"FRP 配置字段无效".into())}
fn render_config(server:&SavedServer,global:&SavedGlobalSettings)->Result<String,String>{
    let password=decrypt_secret(&global.admin_password_ciphertext)?;
    let mut config=format!("serverAddr = {}\nserverPort = {}\nauth.method = \"token\"\ntransport.tls.enable = true\nwebServer.addr = \"127.0.0.1\"\nwebServer.port = {}\nwebServer.user = {}\nwebServer.password = {}\n",toml_string(&server.server_addr)?,server.server_port,server.admin_port,toml_string(&global.admin_user)?,toml_string(&password)?);
    if let Some(ciphertext)=server.token_ciphertext.as_deref(){config.push_str(&format!("auth.token = {}\n",toml_string(&decrypt_secret(ciphertext)?)?));}
    for proxy in &server.proxies { if !proxy.enabled { continue; }
        config.push_str(&render_proxy_config(proxy)?);
    }
    Ok(config)
}

fn render_proxy_config(proxy: &FrpProxy) -> Result<String, String> {
        let mut config = String::new();
        config.push_str(&format!("\n[[proxies]]\nname = {}\ntype = {}\nenabled = true\nlocalIP = {}\nlocalPort = {}\n",toml_string(&proxy.name)?,toml_string(&proxy.kind)?,toml_string(&proxy.local_ip)?,proxy.local_port));
        if let Some(port)=proxy.remote_port {config.push_str(&format!("remotePort = {port}\n"));}
        let domains = proxy.domains();
        if !domains.is_empty() { config.push_str(&format!("customDomains = {}\n", serde_json::to_string(&domains).map_err(|_| "FRP 域名参数无效")?)); }
        if let Some(plugin) = &proxy.plugin {
            config.push_str(&format!("\n[proxies.plugin]\ntype = \"https2http\"\nlocalAddr = {}\ncrtPath = {}\nkeyPath = {}\n", toml_string(&plugin.local_addr)?, toml_string(&plugin.crt_path)?, toml_string(&plugin.key_path)?));
        }
    Ok(config)
}
fn frp_root()->Result<PathBuf,String>{let path=data_dir()?.join("frp");fs::create_dir_all(&path).map_err(|_|"创建本机 FRP 目录失败".to_string())?;Ok(path)}
fn server_dir(id:i64)->Result<PathBuf,String>{let path=frp_root()?.join(format!("server-{id}"));fs::create_dir_all(&path).map_err(|_|"创建服务端 FRP 目录失败".to_string())?;Ok(path)}
fn binary_path()->Result<PathBuf,String>{Ok(frp_root()?.join(if cfg!(windows){"frpc.exe"}else{"frpc"}))}
fn config_path(id:i64)->Result<PathBuf,String>{Ok(server_dir(id)?.join("frpc.toml"))}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrpLocalPaths {
    binary_path: String,
    installed: bool,
    version: Option<String>,
    config_path: Option<String>,
}

#[tauri::command]
pub(crate) fn get_frp_local_paths(server_id: Option<i64>) -> PlatformResult<FrpLocalPaths> {
    let config = if let Some(id) = server_id {
        load_server(id)?.ok_or("FRP 服务端配置不存在")?;
        Some(config_path(id)?.to_string_lossy().into_owned())
    } else { None };
    let binary = binary_path()?;
    Ok(FrpLocalPaths { installed: binary.is_file(), version: installed_frp_version(&binary), binary_path: binary.to_string_lossy().into_owned(), config_path: config })
}

#[tauri::command]
pub(crate) fn open_frp_install_directory() -> PlatformResult<()> {
    let path = frp_root()?;
    tauri_plugin_opener::open_path(&path, None::<&str>)
        .map_err(|_| "打开 FRP 安装目录失败".to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn open_frp_config_file(server_id: i64) -> PlatformResult<()> {
    load_server(server_id)?.ok_or("FRP 服务端配置不存在")?;
    let path = config_path(server_id)?;
    if !path.is_file() { return Err("配置文件不存在，请先应用此服务端配置".into()); }
    // Only open the derived profile file; never accept an arbitrary path from the UI.
    #[cfg(windows)] {
        let system_root = std::env::var_os("SystemRoot").ok_or("无法定位 Windows 系统目录")?;
        hidden_command(PathBuf::from(system_root).join("System32").join("notepad.exe"))
            .arg(&path).spawn().map_err(|_| "打开 FRP 配置文件失败".to_string())?;
    }
    #[cfg(not(windows))] {
        tauri_plugin_opener::open_path(&path, None::<&str>)
            .map_err(|_| "打开 FRP 配置文件失败".to_string())?;
    }
    Ok(())
}
fn hidden_command(program:impl AsRef<OsStr>)->Command{let mut command=Command::new(program);#[cfg(windows)]{use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}command}
fn is_running(store:&FrpProcessStore,id:i64)->Result<bool,String>{let mut processes=store.0.lock().map_err(|_|"FRP 进程状态不可用".to_string())?;if let Some(child)=processes.get_mut(&id){if let Some(status) = child.try_wait().map_err(|_|"读取 FRP 进程状态失败".to_string())? {
if let Ok(logs) = store.1.lock() { if let Some(buffer) = logs.get(&id) { push_frp_log(buffer, "系统", &format!("客户端进程已退出，退出码：{}", status.code().map(|code|code.to_string()).unwrap_or_else(|| "未知".into()))); } }
processes.remove(&id);return Ok(false);}return Ok(true);}Ok(false)}
fn stop_process(store:&FrpProcessStore,id:i64)->Result<(),String>{if let Some(mut child)=store.0.lock().map_err(|_|"FRP 进程状态不可用".to_string())?.remove(&id){let _=child.kill();let _=child.wait();
if let Ok(logs) = store.1.lock() { if let Some(buffer) = logs.get(&id) { push_frp_log(buffer, "系统", "客户端连接已停止"); } }
}Ok(())}
fn check_panel_port(port: u16, buffer: &FrpLogBuffer) -> Result<(), String> {
    match TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => { drop(listener); Ok(()) }
        Err(error) => {
            let message = if error.kind() == std::io::ErrorKind::AddrInUse {
                "本机 FRP 面板端口已被占用，请先停止旧连接或占用该端口的进程"
            } else {
                "无法绑定本机 FRP 面板端口，请检查本机端口保留设置或权限"
            };
            push_frp_log(buffer, "系统", &format!("面板端口 {port}：{message}"));
            Err(message.into())
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrpPortOwner { pid: u32, can_terminate: bool, started_at: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrpPortConflict { server_id: i64, port: u16, owners: Vec<FrpPortOwner> }

fn port_process_command(server_id: i64, server: &SavedServer) -> Result<Command, String> {
    if !cfg!(windows) { return Err("端口进程诊断当前仅支持 Windows".into()); }
    let root = std::env::var_os("SystemRoot").ok_or("无法定位 Windows 系统目录")?;
    let mut command = hidden_command(PathBuf::from(root).join("System32/WindowsPowerShell/v1.0/powershell.exe"));
    command.args(["-NoProfile", "-NonInteractive", "-Command", include_str!("../../../scripts/frp-port-process.ps1")])
        .env("CLOUDHUB_FRP_PORT", server.admin_port.to_string())
        .env("CLOUDHUB_FRP_BINARY", binary_path()?)
        .env("CLOUDHUB_FRP_CONFIG", config_path(server_id)?)
        .stdin(Stdio::null()).stderr(Stdio::null());
    Ok(command)
}

#[tauri::command]
pub(crate) async fn get_frp_port_conflict(server_id: i64) -> PlatformResult<FrpPortConflict> {
    tauri::async_runtime::spawn_blocking(move || -> Result<FrpPortConflict, String> {
        let server = load_server(server_id)?.ok_or("FRP 服务端配置不存在")?;
        let output = port_process_command(server_id, &server)?.env("CLOUDHUB_FRP_MODE", "inspect").output().map_err(|_| "读取本机端口占用失败")?;
        if !output.status.success() || output.stdout.len() > 16_384 { return Err("读取本机端口占用失败".into()); }
        let owners = serde_json::from_slice(&output.stdout).map_err(|_| "解析本机端口占用失败")?;
        Ok(FrpPortConflict { server_id, port: server.admin_port, owners })
    }).await.map_err(|_| "端口诊断任务失败")?.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn terminate_stale_frpc(store: State<'_, FrpProcessStore>, server_id: i64, pid: u32, started_at: String) -> PlatformResult<()> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        if pid == 0 || started_at.len() > 64 { return Err("进程参数无效".into()); }
        if is_running(&store, server_id)? { return Err("当前连接已在运行，请使用停止连接操作".into()); }
        let server = load_server(server_id)?.ok_or("FRP 服务端配置不存在")?;
        let output = port_process_command(server_id, &server)?.env("CLOUDHUB_FRP_MODE", "terminate")
            .env("CLOUDHUB_FRP_PID", pid.to_string()).env("CLOUDHUB_FRP_STARTED_AT", started_at)
            .output().map_err(|_| "结束旧 frpc 进程失败")?;
        if !output.status.success() { return Err("进程已改变或不属于当前连接的残留 frpc，请重新检查端口占用".into()); }
        if let Ok(logs) = store.1.lock() { if let Some(buffer) = logs.get(&server_id) {
            push_frp_log(buffer, "系统", &format!("已结束当前连接的旧 frpc 进程，PID：{pid}"));
        } }
        Ok(())
    }).await.map_err(|_| "结束旧进程任务失败")?.map_err(Into::into)
}

fn start_process(store:&FrpProcessStore,id:i64)->Result<(),String>{if !binary_path()?.is_file(){return Err("请先安装本机 frpc".into());}let config=config_path(id)?;if !config.is_file(){return Err("请先应用该服务端的 FRP 配置".into());}if is_running(store,id)?{return Ok(());}let server=load_server(id)?.ok_or("FRP 服务端配置不存在")?;let buffer: FrpLogBuffer = Arc::new(Mutex::new(VecDeque::new()));
let secrets = frp_log_secrets(&config, &server).ok().map(Arc::new);
store.1.lock().map_err(|_| "FRP 日志状态不可用".to_string())?.insert(id, buffer.clone());
check_panel_port(server.admin_port, &buffer)?;
if secrets.is_none() { push_frp_log(&buffer, "系统", "无法安全读取脱敏配置，仅记录客户端生命周期"); }
push_frp_log(&buffer, "系统", "正在启动本机 frpc");
let capture = secrets.is_some();
let mut child = hidden_command(binary_path()?).arg("-c").arg(config).stdin(Stdio::null())
    .stdout(if capture { Stdio::piped() } else { Stdio::null() }).stderr(if capture { Stdio::piped() } else { Stdio::null() })
    .spawn().map_err(|_| { push_frp_log(&buffer, "系统", "启动本机 frpc 失败"); "启动本机 frpc 失败".to_string() })?;
if let Some(secrets) = secrets {
    if let Some(stdout) = child.stdout.take() { let _ = read_frp_output(stdout, buffer.clone(), "输出", secrets.clone()); }
    if let Some(stderr) = child.stderr.take() { let _ = read_frp_output(stderr, buffer.clone(), "错误", secrets); }
}
store.0.lock().map_err(|_|"FRP 进程状态不可用".to_string())?.insert(id,child);Ok(())}

#[tauri::command]
pub(crate) async fn install_frpc(store:State<'_,FrpProcessStore>, version: String, on_progress: Channel<FrpInstallProgress>)->PlatformResult<()>{if !store.0.lock().map_err(|_|"FRP 进程状态不可用".to_string())?.is_empty(){return Err("请先停止所有 frpc 实例再更新".into());}#[cfg(not(windows))]{return Err("本机一键安装当前支持 Windows".into());}#[cfg(windows)]{if !valid_frp_version(&version) { return Err("FRP 版本号无效".into()); }
install_progress(&on_progress, "metadata", 0, None);
let arch = frp_arch()?;
let metadata = frp_download(&format!("https://api.github.com/repos/fatedier/frp/releases/tags/v{version}"), 2_000_000, 30, None).await?;
let release: GithubFrpRelease = serde_json::from_slice(&metadata).map_err(|_| "解析 FRP 官方版本信息失败".to_string())?;
let release = supported_release(release, arch).filter(|r| r.version == version).ok_or("该版本没有适合当前系统的官方校验安装包")?;
let checksum = release.sha256;
let archive_name=format!("frp_{version}_windows_{arch}.zip");let url=format!("https://github.com/fatedier/frp/releases/download/v{version}/{archive_name}");install_progress(&on_progress, "downloading", 0, None);
let bytes=frp_download(&url,50_000_000,180,Some(&on_progress)).await?;
let size = bytes.len() as u64;
install_progress(&on_progress, "verifying", size, Some(size));
if bytes.len()>50_000_000||hex::encode(Sha256::digest(&bytes))!=checksum{return Err("frpc 安装包校验失败".into());}let store = store.inner().clone();
tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
let directory=frp_root()?;let stage=directory.join(format!("stage-{}",uuid::Uuid::new_v4()));fs::create_dir(&stage).map_err(|_|"创建 frpc 安装临时目录失败".to_string())?;let result=(||->Result<(),String>{let archive=stage.join(&archive_name);fs::write(&archive,bytes).map_err(|_|"保存 frpc 安装包失败".to_string())?;let system_root=std::env::var_os("SystemRoot").ok_or("无法定位 Windows 系统目录")?;let tar=PathBuf::from(system_root).join("System32").join("tar.exe");install_progress(&on_progress, "extracting", size, Some(size));
let member=format!("frp_{version}_windows_{arch}/frpc.exe");let extracted=hidden_command(tar).arg("-xf").arg(&archive).arg("-C").arg(&stage).arg(&member).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|_|"解压 frpc 安装包失败".to_string())?;if !extracted.success(){return Err("解压 frpc 安装包失败".into());}let source=stage.join(member);
install_progress(&on_progress, "checking", size, Some(size));
if installed_frp_version(&source).as_deref() != Some(version.as_str()) { return Err("安装包中的 frpc 版本与所选版本不一致".into()); }
for server in list_frp_servers().map_err(|e| e.message)? {
    let config = config_path(server.id)?;
    if config.is_file() {
        let verified = hidden_command(&source).arg("verify").arg("-c").arg(&config).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|_| "检查现有配置兼容性失败".to_string())?;
        if !verified.success() { return Err("所选版本不兼容现有配置，已保留当前 frpc".into()); }
    }
}
// 下载期间可能启动了连接，在替换前重新检查并持锁，防止替换运行中的程序。
let processes = store.0.lock().map_err(|_| "FRP 进程状态不可用".to_string())?;
if !processes.is_empty() { return Err("请先停止所有 frpc 实例再更新".into()); }
install_progress(&on_progress, "installing", size, Some(size));
let destination=binary_path()?;let backup=directory.join("frpc.exe.bak");let _=fs::remove_file(&backup);if destination.is_file(){fs::rename(&destination,&backup).map_err(|_|"备份旧版 frpc 失败".to_string())?;}if fs::copy(&source,&destination).is_err(){let _ = fs::remove_file(&destination);
if backup.is_file() && fs::rename(&backup, &destination).is_err() { return Err("安装失败且恢复旧程序失败，请从安装目录中的 frpc.exe.bak 恢复".into()); }
return Err("安装 frpc 可执行文件失败，已恢复原程序".into());}let _=fs::remove_file(backup);Ok(())})();let _=fs::remove_file(stage.join(format!("frp_{version}_windows_{arch}")).join("frpc.exe"));let _=fs::remove_file(stage.join(archive_name));let _=fs::remove_dir(stage.join(format!("frp_{version}_windows_{arch}")));let _=fs::remove_dir(&stage);result?;
install_progress(&on_progress, "complete", size, Some(size));
Ok(())
}).await.map_err(|_| "FRP 安装任务失败".to_string())??;
Ok(())}}

fn apply_one(store:&FrpProcessStore,id:i64)->Result<FrpRuntime,String>{let server=load_server(id)?.ok_or("FRP 服务端配置不存在")?;let global=get_global()?.ok_or("请先设置客户端面板账号和密码")?;let binary=binary_path()?;if !binary.is_file(){return Err("请先安装本机 frpc".into());}let config=render_config(&server,&global)?;let path=config_path(id)?;let next=path.with_extension("toml.next");let backup=path.with_extension("toml.bak");let was_running=is_running(store,id)?;let _=fs::remove_file(&backup);fs::write(&next,config).map_err(|_|"写入本机 FRP 配置失败".to_string())?;let verified=hidden_command(&binary).arg("verify").arg("-c").arg(&next).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|_|"校验本机 FRP 配置失败".to_string())?;if !verified.success(){let _=fs::remove_file(next);return Err("FRP 配置校验未通过，请检查规则名称、端口和域名".into());}if path.is_file(){fs::copy(&path,&backup).map_err(|_|"备份原 FRP 配置失败".to_string())?;}if was_running{stop_process(store,id)?;}if fs::rename(&next,&path).is_err(){if was_running{let _=start_process(store,id);}return Err("替换本机 FRP 配置失败".into());}if let Err(error)=start_process(store,id){if backup.is_file(){let _=fs::copy(&backup,&path);if was_running{let _=start_process(store,id);}}else{let _=fs::remove_file(&path);}let _=fs::remove_file(&backup);return Err(error);}std::thread::sleep(Duration::from_secs(2));let state=runtime_one(store,id)?;if !state.running{stop_process(store,id)?;if backup.is_file(){let _=fs::copy(&backup,&path);if was_running{let _=start_process(store,id);}}else{let _=fs::remove_file(&path);}let _=fs::remove_file(&backup);return Err("frpc 启动后退出，已恢复应用前配置".into());}let _=fs::remove_file(backup);Ok(state)}

fn proxy_statuses(binary:&Path,config:&Path)->Vec<FrpProxyRuntime>{let Ok(mut child)=hidden_command(binary).arg("status").arg("-c").arg(config).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()else{return Vec::new()};let deadline=Instant::now()+Duration::from_secs(3);loop{match child.try_wait(){Ok(Some(status))=>{if !status.success(){return Vec::new();}return child.wait_with_output().ok().map(|output|String::from_utf8_lossy(&output.stdout).lines().filter_map(|line|{let mut fields=line.split_whitespace();let name=fields.next()?;let state=fields.next()?;if !name.bytes().all(|b|b.is_ascii_alphanumeric()||b"_.-".contains(&b))||!["running","wait","error"].contains(&state){return None;}Some(FrpProxyRuntime{name:name.to_string(),status:state.to_string()})}).collect()).unwrap_or_default();},Ok(None)if Instant::now()<deadline=>std::thread::sleep(Duration::from_millis(50)),_=>{let _=child.kill();let _=child.wait();return Vec::new();}}}}
fn runtime_one(store:&FrpProcessStore,id:i64)->Result<FrpRuntime,String>{let binary=binary_path()?;let config=config_path(id)?;let installed=binary.is_file();let config_present=config.is_file();let config_current=if config_present{load_server(id)?.zip(get_global()?).and_then(|(s,g)|render_config(&s,&g).ok()).zip(fs::read_to_string(&config).ok()).is_some_and(|(expected,actual)|expected==actual)}else{false};let running=is_running(store,id)?;let proxies=if installed&&config_present&&running{proxy_statuses(&binary,&config)}else{Vec::new()};let connected=proxies.iter().any(|proxy|proxy.status=="running");Ok(FrpRuntime{server_id:id,installed,config_present,config_current,running,connected,version:if installed { installed_frp_version(&binary) } else { None },proxies})}
fn runtime_all(store:&FrpProcessStore)->Result<Vec<FrpRuntime>,String>{list_frp_servers().map_err(|error|error.message)?.into_iter().map(|server|runtime_one(store,server.id)).collect()}

#[tauri::command]
pub(crate) async fn apply_frp_profile(store:State<'_,FrpProcessStore>,server_id:i64)->PlatformResult<FrpRuntime>{let store=store.inner().clone();tauri::async_runtime::spawn_blocking(move||apply_one(&store,server_id)).await.map_err(|_|"应用 FRP 配置任务失败".to_string())?.map_err(Into::into)}
#[tauri::command]
pub(crate) async fn get_frpc_runtime(store:State<'_,FrpProcessStore>)->PlatformResult<Vec<FrpRuntime>>{let store=store.inner().clone();tauri::async_runtime::spawn_blocking(move||runtime_all(&store)).await.map_err(|_|"读取 FRP 状态失败".to_string())?.map_err(Into::into)}
#[tauri::command]
pub(crate) async fn control_frpc(store:State<'_,FrpProcessStore>,server_id:i64,action:String)->PlatformResult<Vec<FrpRuntime>>{let store=store.inner().clone();tauri::async_runtime::spawn_blocking(move||{match action.as_str(){"start"=>start_process(&store,server_id)?,"stop"=>stop_process(&store,server_id)?,"restart"=>{stop_process(&store,server_id)?;start_process(&store,server_id)?;},_=>return Err("FRP 服务操作无效".into())}if action!="stop"{std::thread::sleep(Duration::from_secs(2));if !is_running(&store,server_id)?{return Err("frpc 启动后立即退出，请检查服务端连接、认证配置及本机面板端口".into());}}runtime_all(&store)}).await.map_err(|_|"FRP 服务操作任务失败".to_string())?.map_err(Into::into)}
#[tauri::command]
pub(crate) fn open_frpc_panel(store:State<'_,FrpProcessStore>,server_id:i64)->PlatformResult<String>{let server=load_server(server_id)?.ok_or("FRP 服务端配置不存在")?;if !is_running(&store,server_id)?{return Err("请先启动该服务端的 frpc".into());}Ok(format!("http://127.0.0.1:{}",server.admin_port))}
