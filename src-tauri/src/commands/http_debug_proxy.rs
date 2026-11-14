//! Windows-only local HTTP debugging proxy.
//!
//! Captured sessions are kept in memory for the app lifetime and are only removed
//! by the explicit clear action. The listener is loopback-only and the system
//! proxy recovery record is encrypted in the existing preferences DB.
use crate::core::{crypto::{decrypt_secret, encrypt_secret}, database::open_db, error::PlatformResult};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Serialize, Deserialize};
use serde_json::{json, Value};
use tauri_plugin_dialog::DialogExt;
use tokio::io::AsyncWriteExt;
use tokio::sync::Semaphore;
use zeroize::Zeroizing;
use std::{collections::VecDeque, io::{Read, Write}, net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs}, sync::{Arc, Mutex, OnceLock}, time::{Duration, Instant}};
use rusqlite::OptionalExtension;
use tokio::task::JoinHandle;

const RECOVERY_KEY: &str = "http_debug_proxy.windows_recovery";
const CA_KEY: &str = "http_debug_proxy.root_ca";
const MAX_MESSAGE: usize = 4 * 1024 * 1024;
const MAX_CAPTURED_TEXT: usize = 64 * 1024;
static RUNTIME: OnceLock<tokio::sync::Mutex<Option<Runtime>>> = OnceLock::new();
static SESSION_HISTORY: OnceLock<Mutex<VecDeque<Session>>> = OnceLock::new();
fn runtime() -> &'static tokio::sync::Mutex<Option<Runtime>> { RUNTIME.get_or_init(|| tokio::sync::Mutex::new(None)) }
fn session_history() -> &'static Mutex<VecDeque<Session>> { SESSION_HISTORY.get_or_init(|| Mutex::new(VecDeque::new())) }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String, pub timestamp: i64, pub method: String, pub url: String,
    pub status: u16, pub duration_ms: u64, pub request_headers: Vec<(String, String)>,
    pub response_headers: Vec<(String, String)>, pub request_body: String, pub response_body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_image_data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_image_data: Option<String>,
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary { pub id: String, pub timestamp: i64, pub method: String, pub url: String, pub status: u16, pub duration_ms: u64, pub response_content_type: String, #[serde(skip_serializing_if = "Option::is_none")] pub note: Option<String> }
impl From<&Session> for SessionSummary {
    fn from(value: &Session) -> Self { Self{id:value.id.clone(),timestamp:value.timestamp,method:value.method.clone(),url:redact_url(&value.url),status:value.status,duration_ms:value.duration_ms,response_content_type:value.response_headers.iter().find(|(name,_)|name.eq_ignore_ascii_case("content-type")).map(|(_,value)|value.split(';').next().unwrap_or("").trim().to_ascii_lowercase()).unwrap_or_default(),note:value.note.clone()} }
}
#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStats { pub accepted_connections: u64, pub recorded_sessions: u64, pub failed_connections: u64, pub overloaded_connections: u64 }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot { pub running: bool, pub address: String, pub system_proxy: bool, pub system_proxy_enabled: bool, pub system_proxy_server: Option<String>, pub system_proxy_recovery_available: bool, pub system_proxy_recovery_safe: bool, pub upstream_proxy: bool, pub root_certificate_installed: bool, pub https_decryption: bool, pub stats: CaptureStats, pub sessions: Vec<SessionSummary> }
struct Shared { intercept: InterceptState, sessions: VecDeque<Session>, root_cert: String, decrypt_https: bool, stats: CaptureStats }
// Breakpoints belong to one listener generation; stopping it cancels its waiters.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterceptConfig { pub request: bool, pub response: bool, pub keyword: String }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSummary { pub id: String, pub phase: String, pub url: String, pub method: String, pub expires_at: i64 }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingDetail { pub summary: PendingSummary, pub body: Option<String>, pub status: u16 }
struct Pending { detail: PendingDetail, sender: tokio::sync::oneshot::Sender<InterceptDecision> }
#[derive(Default)]
struct InterceptState { config: InterceptConfig, pending: Vec<Pending>, stopped: bool }
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InterceptDecision { pub cancel: bool, pub body: Option<String>, pub url: Option<String>, pub status: Option<u16> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterceptSnapshot { pub config: InterceptConfig, pub pending: Vec<PendingSummary> }
fn editable_body(headers: &[(String,String)], body: &[u8]) -> Option<String> {
    if body.len()>256*1024 || headers.iter().any(|(key,value)|key.eq_ignore_ascii_case("content-encoding") && !value.eq_ignore_ascii_case("identity")) { return None; }
    std::str::from_utf8(body).ok().filter(|text|!text.contains('\0')).map(str::to_owned)
}
fn update_body_headers(headers: &mut Vec<(String,String)>, length: usize) {
    headers.retain(|(key,_)|!["content-length","transfer-encoding","etag","content-md5","digest"].iter().any(|name|key.eq_ignore_ascii_case(name)));
    headers.push(("content-length".into(),length.to_string()));
}
async fn intercept(shared: &Arc<Mutex<Shared>>, phase: &str, method: &str, url: &str, headers: &[(String,String)], body: &[u8], status: u16) -> Result<InterceptDecision,String> {
    let id=uuid::Uuid::new_v4().to_string();
    let receiver={
        let mut shared=shared.lock().map_err(|_|"代理状态不可用")?;
        let state=&mut shared.intercept;
        if state.stopped { return Err("抓包已停止".into()); }
        let enabled=if phase=="request" {state.config.request} else {state.config.response};
        if !enabled || !url.contains(&state.config.keyword) { return Ok(InterceptDecision::default()); }
        let (sender,receiver)=tokio::sync::oneshot::channel();
        state.pending.push(Pending{detail:PendingDetail{summary:PendingSummary{id:id.clone(),phase:phase.into(),url:redact_url(url),method:method.into(),expires_at:chrono::Utc::now().timestamp_millis()+180_000},body:editable_body(headers,body),status},sender});
        receiver
    };
    let result=tokio::time::timeout(Duration::from_secs(180),receiver).await;
    if let Ok(mut shared)=shared.lock() {shared.intercept.pending.retain(|item|item.detail.summary.id!=id);}
    let decision=match result {Ok(Ok(value))=>value,Ok(Err(_))=>return Err("抓包已停止".into()),Err(_)=>InterceptDecision::default()};
    if decision.cancel {Err("请求已取消".into())} else {Ok(decision)}
}
#[tauri::command]
pub(crate) async fn http_debug_proxy_intercepts()->PlatformResult<InterceptSnapshot> {
    let guard=runtime().lock().await;
    let r=guard.as_ref().ok_or("请先启动抓包")?;
    let shared=r.shared.lock().map_err(|_|"代理状态不可用")?;
    Ok(InterceptSnapshot{config:shared.intercept.config.clone(),pending:shared.intercept.pending.iter().map(|item|item.detail.summary.clone()).collect()})
}
#[tauri::command]
pub(crate) async fn http_debug_proxy_configure_intercept(config: InterceptConfig)->PlatformResult<()> {
    if config.keyword.len()>2048 || config.keyword.chars().any(char::is_control) {return Err("地址关键字无效".into());}
    let guard=runtime().lock().await;
    let r=guard.as_ref().ok_or("请先启动抓包")?;
    let mut shared=r.shared.lock().map_err(|_|"代理状态不可用")?;
    let state=&mut shared.intercept;
    state.config=config;
    let mut keep=Vec::new();
    for pending in state.pending.drain(..) {
        let enabled=if pending.detail.summary.phase=="request" {state.config.request} else {state.config.response};
        if enabled {keep.push(pending);} else {let _=pending.sender.send(InterceptDecision::default());}
    }
    state.pending=keep;
    Ok(())
}
#[tauri::command]
pub(crate) async fn http_debug_proxy_intercept_detail(id: String)->PlatformResult<PendingDetail> {
    let guard=runtime().lock().await;
    let r=guard.as_ref().ok_or("抓包已停止")?;
    let shared=r.shared.lock().map_err(|_|"代理状态不可用")?;
    shared.intercept.pending.iter().find(|item|item.detail.summary.id==id).map(|item|item.detail.clone()).ok_or_else(||"暂停已结束，请刷新列表".into())
}
#[tauri::command]
pub(crate) async fn http_debug_proxy_resolve_intercept(id: String, decision: InterceptDecision)->PlatformResult<()> {
    if decision.body.as_ref().is_some_and(|body|body.len()>256*1024) {return Err("编辑正文超过 256 KB 限制".into());}
    if let Some(url)=&decision.url {
        let parsed=reqwest::Url::parse(url).map_err(|_|"目标 URL 无效")?;
        if url.len()>8192 || !matches!(parsed.scheme(),"http"|"https") || parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() || url.chars().any(char::is_control) {return Err("目标必须是无内嵌凭据的 HTTP(S) URL".into());}
    }
    if decision.status.is_some_and(|status|!(200..=599).contains(&status)) {return Err("状态码必须在 200 至 599 之间".into());}
    let guard=runtime().lock().await;
    let r=guard.as_ref().ok_or("抓包已停止")?;
    let mut shared=r.shared.lock().map_err(|_|"代理状态不可用")?;
    let index=shared.intercept.pending.iter().position(|item|item.detail.summary.id==id).ok_or("暂停已结束，请刷新列表")?;
    let detail=&shared.intercept.pending[index].detail;
    if decision.body.is_some() && detail.body.is_none() {return Err("此正文不能安全编辑，请原样放行".into());}
    if (detail.summary.phase=="response" && decision.url.is_some()) || (detail.summary.phase=="request" && decision.status.is_some()) {return Err("编辑字段与暂停阶段不匹配".into());}
    shared.intercept.pending.remove(index).sender.send(decision).map_err(|_|"暂停已结束".into())
}
#[derive(Clone, Default)]
struct UpstreamProxy { http: Option<String>, https: Option<String> }
impl UpstreamProxy { fn for_scheme(&self, scheme: &str) -> Option<&str> { if scheme.eq_ignore_ascii_case("https") { self.https.as_deref() } else { self.http.as_deref() } } }
struct Runtime { shared: Arc<Mutex<Shared>>, task: JoinHandle<()>, port: u16, system_proxy: bool, upstream: UpstreamProxy }
impl Drop for Runtime { fn drop(&mut self) { if let Ok(mut shared)=self.shared.lock() { shared.intercept.stopped=true; shared.intercept.pending.clear(); } self.task.abort(); } }

fn pref(key: &str) -> Result<Option<String>, String> {
    open_db()?.query_row("SELECT value FROM client_preferences WHERE key=?1", [key], |r| r.get(0))
        .optional().map_err(|_| "读取调试代理配置失败".into())
}
fn save_pref(key: &str, value: &str) -> Result<(), String> {
    open_db()?.execute("INSERT INTO client_preferences(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
        rusqlite::params![key, value, chrono::Utc::now().timestamp_millis()]).map_err(|_| "保存调试代理配置失败".to_string())?; Ok(())
}

#[cfg(target_os = "windows")]
fn windows_tool(name:&str)->Option<std::path::PathBuf>{
    std::env::var_os("SystemRoot").map(std::path::PathBuf::from).map(|root|root.join("System32").join(name)).filter(|path|path.is_file())
}
#[cfg(target_os = "windows")]
fn reg_value(name: &str) -> Option<String> {
    let out = std::process::Command::new(windows_tool("reg.exe")?).args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings", "/v", name]).output().ok()?;
    if !out.status.success() { return None; }
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let key = parts.next()?; let kind = parts.next()?; let value = parts.collect::<Vec<_>>().join(" ");
        (key.eq_ignore_ascii_case(name) && !kind.is_empty()).then_some(value)
    })
}
#[cfg(target_os = "windows")]
fn set_reg(name: &str, kind: &str, value: Option<&str>) -> Result<(), String> {
    if value.is_none() && reg_value(name).is_none() { return Ok(()); }
    let result = if let Some(value) = value {
        std::process::Command::new(windows_tool("reg.exe").ok_or("无法定位 Windows 注册表工具")?).args(["add", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings", "/v", name, "/t", kind, "/d", value, "/f"]).output()
    } else {
        std::process::Command::new(windows_tool("reg.exe").ok_or("无法定位 Windows 注册表工具")?).args(["delete", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings", "/v", name, "/f"]).output()
    }.map_err(|_| "无法更新 Windows 代理设置")?;
    if result.status.success() { refresh_wininet(); Ok(()) } else { Err("更新 Windows 代理设置失败".into()) }
}
#[cfg(target_os = "windows")]
fn refresh_wininet() {
    use windows_sys::Win32::Networking::WinInet::{InternetSetOptionW, INTERNET_OPTION_SETTINGS_CHANGED, INTERNET_OPTION_REFRESH};
    unsafe { InternetSetOptionW(std::ptr::null(), INTERNET_OPTION_SETTINGS_CHANGED, std::ptr::null_mut(), 0); InternetSetOptionW(std::ptr::null(), INTERNET_OPTION_REFRESH, std::ptr::null_mut(), 0); }
}
#[cfg(target_os = "windows")]
fn set_proxy(address: &str) -> Result<(), String> { set_reg("ProxyServer", "REG_SZ", Some(address))?; set_reg("ProxyEnable", "REG_DWORD", Some("1")) }
#[cfg(target_os = "windows")]
fn normalize_upstream(value: &str) -> Result<String, String> {
    let value = value.trim().strip_prefix("http://").unwrap_or(value.trim());
    if value.contains("://") || value.contains(['/', '\\', '@', '?', '#']) { return Err("检测到非 HTTP 上游代理；请先关闭代理链或使用 HTTP 代理端口".into()); }
    let (host, port) = if let Some(rest) = value.strip_prefix('[') {
        let (host, suffix) = rest.split_once(']').ok_or("Windows 上游代理地址无效")?;
        (host, suffix.strip_prefix(':').ok_or("Windows 上游代理端口无效")?)
    } else { value.rsplit_once(':').ok_or("Windows 上游代理端口无效")? };
    let port: u16 = port.parse().map_err(|_| "Windows 上游代理端口无效")?;
    if host.is_empty() || port == 0 || host.chars().any(char::is_whitespace) { return Err("Windows 上游代理地址无效".into()); }
    Ok(format!("{host}:{port}"))
}
#[cfg(target_os = "windows")]
fn local_proxy_is_listening(value: &str) -> bool {
    let value=value.strip_prefix("http://").unwrap_or(value);
    let (host,port)=if let Some(rest)=value.strip_prefix('[') { let Some((host,suffix))=rest.split_once(']') else{return false;}; let Some(port)=suffix.strip_prefix(':') else{return false;}; (host,port) } else { let Some((host,port))=value.rsplit_once(':') else{return false;}; (host,port) };
    if !matches!(host,"127.0.0.1"|"localhost"|"::1") { return false; }
    let Ok(port)=port.parse::<u16>() else{return false;};
    (host,port).to_socket_addrs().is_ok_and(|addresses| addresses.into_iter().any(|address| TcpStream::connect_timeout(&address,Duration::from_millis(300)).is_ok()))
}
#[cfg(target_os = "windows")]
fn current_upstream() -> Result<UpstreamProxy, String> {
    let enabled=reg_value("ProxyEnable").as_deref()==Some("0x1");
    let Some(raw) = reg_value("ProxyServer") else { return Ok(UpstreamProxy::default()); };
    let mut upstream = UpstreamProxy::default();
    if raw.contains('=') {
        for entry in raw.split(';') {
            if let Some((scheme, address)) = entry.split_once('=') {
                match scheme.trim().to_ascii_lowercase().as_str() {
                    "http" => upstream.http = Some(normalize_upstream(address)?),
                    "https" => upstream.https = Some(normalize_upstream(address)?),
                    _ => {}
                }
            }
        }
    } else {
        let target = normalize_upstream(&raw)?;
        upstream.http = Some(target.clone());
        upstream.https = Some(target);
    }
    if !enabled && ![upstream.http.as_deref(),upstream.https.as_deref()].into_iter().flatten().any(local_proxy_is_listening) { return Ok(UpstreamProxy::default()); }
    Ok(upstream)
}
#[cfg(target_os = "windows")]
fn restore_proxy() -> Result<(), String> {
    let Some(raw) = pref(RECOVERY_KEY)? else { return Ok(()); };
    let plaintext = decrypt_secret(&raw).map_err(|_| "系统代理恢复记录不可用，未修改 Windows 设置")?;
    let saved: Value = serde_json::from_str(&plaintext).map_err(|_| "系统代理恢复记录格式无效")?;
    let expected = saved["writtenServer"].as_str().unwrap_or("");
    let server_is_ours=reg_value("ProxyServer").as_deref()==Some(expected);
    if server_is_ours {
        if let Some(old) = saved["server"].as_str() { set_reg("ProxyServer", "REG_SZ", Some(old))?; } else { set_reg("ProxyServer", "REG_SZ", None)?; }
    }
    if server_is_ours && reg_value("ProxyEnable").as_deref() == saved["writtenEnable"].as_str().or(Some("0x1")) {
        if let Some(old) = saved["enable"].as_str() { set_reg("ProxyEnable", "REG_DWORD", Some(old))?; } else { set_reg("ProxyEnable", "REG_DWORD", None)?; }
    }
    open_db()?.execute("DELETE FROM client_preferences WHERE key=?1", [RECOVERY_KEY]).map_err(|_| "清理系统代理恢复记录失败")?;
    Ok(())
}
#[cfg(target_os = "windows")]
fn safe_proxy_server(value: &str) -> String {
    value.split(';').map(|entry| {
        let (scheme, target) = entry.split_once('=').unwrap_or(("", entry));
        let target = target.rsplit_once('@').map(|(_, host)| host).unwrap_or(target);
        let target = target.chars().filter(|character| !character.is_control()).take(256).collect::<String>();
        if scheme.is_empty() { target } else { format!("{scheme}={target}") }
    }).collect::<Vec<_>>().join(";")
}
#[cfg(target_os = "windows")]
fn system_proxy_details() -> (bool, Option<String>, bool, bool) {
    let enabled = reg_value("ProxyEnable").as_deref() == Some("0x1");
    let server = reg_value("ProxyServer");
    let recovery = pref(RECOVERY_KEY).ok().flatten();
    let recovery_available = recovery.is_some();
    let recovery_safe = recovery.as_deref().and_then(|raw| decrypt_secret(raw).ok())
        .and_then(|plain| serde_json::from_str::<Value>(&plain).ok())
        .and_then(|saved| saved["writtenServer"].as_str().map(str::to_owned))
        .is_some_and(|expected| server.as_deref() == Some(expected.as_str()));
    (enabled, server.as_deref().map(safe_proxy_server), recovery_available, recovery_safe)
}
#[cfg(not(target_os = "windows"))]
fn restore_proxy() -> Result<(), String> { Ok(()) }
#[cfg(not(target_os = "windows"))]
fn system_proxy_details() -> (bool, Option<String>, bool, bool) { (false, None, false, false) }

fn ensure_ca() -> Result<(String, Zeroizing<String>), String> {
    if let Some(raw) = pref(CA_KEY)? {
        let plaintext = Zeroizing::new(decrypt_secret(&raw).map_err(|_| "HTTPS 调试证书密钥无法解密")?);
        let value: Value = serde_json::from_str(&plaintext).map_err(|_| "HTTPS 调试证书格式无效")?;
        if let (Some(cert), Some(key)) = (value["cert"].as_str(), value["key"].as_str()) {
            let valid= x509_parser::pem::parse_x509_pem(cert.as_bytes()).ok().and_then(|(_,pem)|x509_parser::parse_x509_certificate(&pem.contents).ok().map(|(_,parsed)|(parsed.validity().not_before.timestamp(),parsed.validity().not_after.timestamp())))
                .is_some_and(|(not_before,not_after)| {
                    let now=chrono::Utc::now().timestamp();
                    let latest_supported=chrono::NaiveDate::from_ymd_opt(2050,1,1).and_then(|date|date.and_hms_opt(0,0,0)).map(|date|date.and_utc().timestamp()).unwrap_or(i64::MAX);
                    not_before<=now+300 && not_after>now+86_400 && not_after<latest_supported
                });
            if valid { return Ok((cert.into(), Zeroizing::new(key.into()))); }
            #[cfg(target_os="windows")]
            if certificate_installed(cert) { install_certificate(cert,false)?; }
        }
    }
    let key = rcgen::KeyPair::generate().map_err(|_| "生成 HTTPS 调试证书失败")?;
    let params = ca_params();
    let cert = params.self_signed(&key).map_err(|_| "生成 HTTPS 调试证书失败")?;
    let cert = cert.pem();
    let key = Zeroizing::new(key.serialize_pem());
    let serialized = Zeroizing::new(json!({"cert":cert,"key":key.as_str()}).to_string());
    let encrypted = encrypt_secret(&serialized).map_err(|_| "保护 HTTPS 调试证书失败")?;
    save_pref(CA_KEY, &encrypted)?;
    Ok((cert, key))
}

fn ca_params() -> rcgen::CertificateParams {
    use chrono::Datelike;
    let mut params=rcgen::CertificateParams::default();
    let today=chrono::Utc::now().date_naive();
    let year=today.year();
    params.not_before=rcgen::date_time_ymd(year-1,1,1);
    params.not_after=rcgen::date_time_ymd((year+15).min(2049),1,1);
    params.is_ca=rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    params.key_usages=vec![rcgen::KeyUsagePurpose::KeyCertSign,rcgen::KeyUsagePurpose::CrlSign,rcgen::KeyUsagePurpose::DigitalSignature];
    params.distinguished_name.push(rcgen::DnType::CommonName,"CloudHub Tools Local HTTPS Debug CA");
    params
}

fn ca_params_from_installed_cert(cert_pem: &str) -> Result<rcgen::CertificateParams, String> {
    let (_, pem)=x509_parser::pem::parse_x509_pem(cert_pem.as_bytes()).map_err(|_| "解析已安装的 HTTPS 根证书失败")?;
    let (_, cert)=x509_parser::parse_x509_certificate(&pem.contents).map_err(|_| "解析已安装的 HTTPS 根证书失败")?;
    let common_name=cert.subject().iter_common_name().next().and_then(|name|name.as_str().ok()).ok_or("HTTPS 根证书缺少名称")?;
    if common_name.is_empty() || common_name.len()>256 || common_name.chars().any(char::is_control) { return Err("HTTPS 根证书名称无效".into()); }
    let subject_key_id=cert.extensions().iter().find_map(|extension|match extension.parsed_extension(){
        x509_parser::extensions::ParsedExtension::SubjectKeyIdentifier(value)=>Some(value.0.to_vec()),
        _=>None,
    }).ok_or("HTTPS 根证书缺少密钥标识")?;
    let mut params=ca_params();
    params.not_before=cert.validity().not_before.to_datetime();
    params.not_after=cert.validity().not_after.to_datetime();
    params.distinguished_name=rcgen::DistinguishedName::new();
    params.distinguished_name.push(rcgen::DnType::CommonName,common_name.to_owned());
    params.key_identifier_method=rcgen::KeyIdMethod::PreSpecified(subject_key_id);
    Ok(params)
}

fn make_server_config(host: &str, ca_cert_pem: &str, ca_key_pem: &str) -> Result<Arc<rustls::ServerConfig>, String> {
    use chrono::Datelike;
    if host.is_empty() || host.len() > 253 || host.chars().any(|c| !(c.is_ascii_alphanumeric() || c == '.' || c == '-')) { return Err("HTTPS 主机名无效".into()); }
    let ca_key = rcgen::KeyPair::from_pem(ca_key_pem).map_err(|_| "HTTPS 根证书密钥不可用")?;
    let ca_cert = ca_params_from_installed_cert(ca_cert_pem)?.self_signed(&ca_key).map_err(|_| "HTTPS 根证书不可用")?;
    let leaf_key = rcgen::KeyPair::generate().map_err(|_| "生成 HTTPS 站点证书失败")?;
    let mut params = rcgen::CertificateParams::new(vec![host.to_string()]).map_err(|_| "生成 HTTPS 站点证书失败")?;
    let today=chrono::Utc::now().date_naive();
    params.not_before=rcgen::date_time_ymd(today.year()-1,today.month() as u8,today.day() as u8);
    params.not_after=rcgen::date_time_ymd((today.year()+2).min(2049),today.month() as u8,today.day() as u8);
    params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
    params.use_authority_key_identifier_extension = true;
    let leaf = params.signed_by(&leaf_key, &ca_cert, &ca_key).map_err(|_| "生成 HTTPS 站点证书失败")?;
    let key = rustls::pki_types::PrivateKeyDer::Pkcs8(rustls::pki_types::PrivatePkcs8KeyDer::from(leaf_key.serialize_der()));
    let config = rustls::ServerConfig::builder().with_no_client_auth().with_single_cert(vec![leaf.der().clone()], key).map_err(|_| "配置 HTTPS 站点证书失败")?;
    let mut config=config;
    config.alpn_protocols=vec![b"http/1.1".to_vec()];
    Ok(Arc::new(config))
}

fn read_message<S: Read + Write>(stream: &mut S) -> Result<(String, Vec<(String,String)>, Vec<u8>), String> {
    let mut header = Vec::new(); let mut byte = [0u8;1];
    while !header.ends_with(b"\r\n\r\n") { if header.len() >= 64*1024 { return Err("请求头超过 64 KB 限制".into()); } stream.read_exact(&mut byte).map_err(|e| format!("读取请求头失败：{e}"))?; header.push(byte[0]); }
    let text = std::str::from_utf8(&header).map_err(|_| "请求头编码无效")?;
    let mut lines = text.split("\r\n"); let start = lines.next().unwrap_or("").to_string();
    let mut headers=Vec::new(); let mut length=0usize; let mut chunked=false;
    for line in lines.filter(|v|!v.is_empty()) { let (name,value)=line.split_once(':').ok_or("请求头格式无效")?; if name.len()>128||value.len()>8192 {return Err("请求头字段过长".into());} if name.eq_ignore_ascii_case("content-length") { length=value.trim().parse().map_err(|_| "请求长度无效")?; } if name.eq_ignore_ascii_case("transfer-encoding") && value.to_ascii_lowercase().contains("chunked") { chunked=true; } headers.push((name.to_string(),value.trim().to_string())); }
    if headers.iter().any(|(name,value)|name.eq_ignore_ascii_case("expect")&&value.eq_ignore_ascii_case("100-continue")) { stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").map_err(|_|"发送 HTTP 继续响应失败")?; }
    if length>MAX_MESSAGE { return Err("请求正文超过 4 MB 限制".into()); }
    let mut body=Vec::new();
    if chunked {
        loop {
            let mut line=Vec::new(); let mut byte=[0u8;1];
            while !line.ends_with(b"\r\n") { if line.len()>128 {return Err("HTTP 分块长度字段过长".into());} stream.read_exact(&mut byte).map_err(|_|"读取 HTTP 分块失败")?;line.push(byte[0]); }
            let size_text=std::str::from_utf8(&line[..line.len()-2]).map_err(|_|"HTTP 分块长度无效")?.split(';').next().unwrap_or("");
            let size=usize::from_str_radix(size_text.trim(),16).map_err(|_|"HTTP 分块长度无效")?;
            if size==0 { loop { let mut trailer=Vec::new(); while !trailer.ends_with(b"\r\n") {if trailer.len()>8192{return Err("HTTP 尾部字段过长".into());}stream.read_exact(&mut byte).map_err(|_|"读取 HTTP 尾部字段失败")?;trailer.push(byte[0]);} if trailer==b"\r\n"{break;} } break; }
            if body.len().saturating_add(size)>MAX_MESSAGE{return Err("请求正文超过 4 MB 限制".into());}
            let at=body.len();body.resize(at+size,0);stream.read_exact(&mut body[at..]).map_err(|_|"HTTP 分块正文不完整")?;
            let mut crlf=[0u8;2];stream.read_exact(&mut crlf).map_err(|_|"HTTP 分块结尾无效")?;if crlf!=*b"\r\n"{return Err("HTTP 分块结尾无效".into());}
        }
    } else { body.resize(length,0); stream.read_exact(&mut body).map_err(|_| "请求正文不完整")?; }
    Ok((start,headers,body))
}
fn safe_headers(headers: &[(String,String)]) -> Vec<(String,String)> {
    headers.iter().map(|(k,v)| (k.clone(), if ["authorization","proxy-authorization","cookie","set-cookie","x-api-key","x-auth-token","x-access-token"].iter().any(|name|k.eq_ignore_ascii_case(name)) { "[已隐藏]".into() } else { v.clone() })).collect()
}
fn session_for_display(session: &Session, reveal_sensitive: bool) -> Session {
    let mut displayed = session.clone();
    if !reveal_sensitive {
        displayed.url = redact_url(&displayed.url);
        displayed.request_headers = safe_headers(&displayed.request_headers);
        displayed.response_headers = safe_headers(&displayed.response_headers);
    }
    displayed
}
fn redact_url(value:&str)->String {
    let Ok(mut url)=reqwest::Url::parse(value) else{return "[无效 URL]".into();};
    let pairs=url.query_pairs().map(|(key,value)|(key.into_owned(),value.into_owned())).collect::<Vec<_>>();
    if pairs.iter().any(|(key,_)|["token","access_token","auth","authorization","key","api_key","password","secret","signature","sig","code","cookie"].iter().any(|s|key.eq_ignore_ascii_case(s))) {
        url.set_query(None);
        url.query_pairs_mut().extend_pairs(pairs.iter().map(|(key,value)| (key.as_str(),if ["token","access_token","auth","authorization","key","api_key","password","secret","signature","sig","code","cookie"].iter().any(|s|key.eq_ignore_ascii_case(s)){"[已隐藏]"}else{value.as_str()})));
    }
    url.to_string()
}
fn body_text(bytes: &[u8]) -> String {
    let Ok(mut value)=String::from_utf8(bytes.to_vec()) else{return format!("[二进制内容，{} 字节]",bytes.len());};
    if value.len()>MAX_CAPTURED_TEXT { let mut end=MAX_CAPTURED_TEXT;while !value.is_char_boundary(end){end-=1;}value.truncate(end);value.push_str("\n[正文已截断，单条上限 64 KB]"); }
    value
}
fn response_image_data(headers: &[(String, String)], bytes: &[u8]) -> Option<String> {
    if bytes.len() > MAX_MESSAGE { return None; }
    let content_type = headers.iter().find(|(name, _)| name.eq_ignore_ascii_case("content-type"))?.1.split(';').next()?.trim().to_ascii_lowercase();
    if !matches!(content_type.as_str(), "image/png" | "image/jpeg" | "image/gif" | "image/webp") { return None; }
    Some(format!("data:{content_type};base64,{}", BASE64.encode(bytes)))
}
fn record(shared: &Arc<Mutex<Shared>>, session: Session) { if let Ok(mut s)=shared.lock(){s.sessions.push_front(session);s.stats.recorded_sessions=s.stats.recorded_sessions.saturating_add(1);} }
fn record_connect_error(shared: &Arc<Mutex<Shared>>, host: &str, started: Instant, error: String) {
    record(shared,Session{id:uuid::Uuid::new_v4().to_string(),timestamp:chrono::Utc::now().timestamp_millis(),method:"CONNECT".into(),url:format!("https://{host}"),status:0,duration_ms:started.elapsed().as_millis() as u64,request_headers:Vec::new(),response_headers:Vec::new(),request_body:String::new(),response_body:String::new(),request_image_data:None,response_image_data:None,error:Some(error),note:None});
}
fn connect_host(address: &str) -> Result<TcpStream, String> {
    let addresses = address.to_socket_addrs().map_err(|_| "无法解析 HTTPS 目标地址")?;
    let mut last_error = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, Duration::from_secs(10)) {
            Ok(stream) => return Ok(stream),
            Err(error) => last_error = Some(error.kind()),
        }
    }
    Err(match last_error { Some(kind) => format!("连接 HTTPS 目标失败：{kind}"), None => "连接 HTTPS 目标失败：没有可用地址".into() })
}
/// Opens a plain TCP tunnel to the CONNECT authority, reusing the configured
/// upstream HTTP proxy when present. Used while the root CA is not trusted, so
/// HTTPS traffic keeps working but stays encrypted.
fn tunnel_target(authority: &str, upstream: &UpstreamProxy) -> Result<TcpStream, String> {
    if authority.is_empty() || authority.len() > 300 || authority.chars().any(|character| character.is_control() || character.is_whitespace()) {
        return Err("CONNECT 目标无效".into());
    }
    let Some(proxy) = upstream.for_scheme("https") else { return connect_host(authority); };
    let mut stream = connect_host(proxy)?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    write!(stream, "CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n").map_err(|_| "无法向上游代理发送 CONNECT")?;
    let mut header = Vec::new(); let mut byte = [0u8; 1];
    while !header.ends_with(b"\r\n\r\n") {
        if header.len() >= 16 * 1024 { return Err("上游代理 CONNECT 响应头过长".into()); }
        stream.read_exact(&mut byte).map_err(|_| "读取上游代理 CONNECT 响应失败")?;
        header.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&header);
    let status = head.lines().next().and_then(|line| line.split_whitespace().nth(1)).and_then(|code| code.parse::<u16>().ok()).unwrap_or(0);
    if status != 200 { return Err(format!("上游代理拒绝 HTTPS 隧道（HTTP {status}）")); }
    let _ = stream.set_read_timeout(None);
    Ok(stream)
}
fn relay_tunnel(socket: TcpStream, remote: TcpStream, handle: &tokio::runtime::Handle) {
    // Hand the tunnel to an async task so the blocking worker and its
    // connection slot are released immediately. A generous cap only bounds
    // sockets that both peers leave open indefinitely.
    if socket.set_nonblocking(true).is_err() { return; }
    if remote.set_nonblocking(true).is_err() { return; }
    let _guard = handle.enter();
    let (Ok(client), Ok(server)) = (tokio::net::TcpStream::from_std(socket), tokio::net::TcpStream::from_std(remote)) else { return; };
    drop(_guard);
    handle.spawn(async move {
        let (mut client, mut server) = (client, server);
        let _ = tokio::time::timeout(Duration::from_secs(3600), tokio::io::copy_bidirectional(&mut client, &mut server)).await;
        let _ = client.shutdown().await;
        let _ = server.shutdown().await;
    });
}

async fn handle_request<S: Read + Write>(stream: &mut S, shared: &Arc<Mutex<Shared>>, upstream: &UpstreamProxy, host_override: Option<&str>, start: String, headers: Vec<(String,String)>, body: Vec<u8>) -> Result<(), String> {
    let started=Instant::now(); let parts=start.split_whitespace().collect::<Vec<_>>();
    if parts.len()!=3 || !parts[2].starts_with("HTTP/1.") { return Err("HTTP 请求行无效".into()); }
    let method=parts[0]; let uri=parts[1];
    if uri.len()>8192{return Err("HTTP 目标地址超过 8 KB 限制".into());}
    let host=headers.iter().find(|(k,_)|k.eq_ignore_ascii_case("host")).map(|(_,v)|v.as_str()).or(host_override).ok_or("请求缺少目标主机")?;
    let url=if uri.starts_with("http://")||uri.starts_with("https://") {uri.to_string()} else {format!("{}://{}{}",if host_override.is_some(){"https"}else{"http"},host,if uri.starts_with('/') {uri.to_string()} else {format!("/{uri}")})};
    let decision=intercept(shared,"request",method,&url,&headers,&body,0).await?;
    let url=decision.url.unwrap_or(url);
    let mut headers=headers;
    let body=if let Some(value)=decision.body {let bytes=value.into_bytes();update_body_headers(&mut headers,bytes.len());bytes} else {body};
    let parsed_url=reqwest::Url::parse(&url).map_err(|_|"HTTP 目标地址无效")?;
    if !matches!(parsed_url.scheme(),"http"|"https")||!parsed_url.username().is_empty()||parsed_url.password().is_some(){return Err("代理目标必须是无内嵌凭据的 HTTP(S) 地址".into());}
    let mut client_builder=reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(90));
    if let Some(proxy) = upstream.for_scheme(parsed_url.scheme()) {
        let proxy_url=format!("http://{proxy}");
        let configured=if parsed_url.scheme()=="https" {reqwest::Proxy::https(&proxy_url)} else {reqwest::Proxy::http(&proxy_url)}.map_err(|_| "配置上游 HTTP 代理失败")?;
        client_builder=client_builder.proxy(configured);
    }
    let client=client_builder.build().map_err(|_| "初始化 HTTP 转发失败")?;
    let mut req=client.request(reqwest::Method::from_bytes(method.as_bytes()).map_err(|_|"HTTP 方法无效")?, &url).body(body.clone());
    for (key,value) in &headers { if !["host","connection","proxy-connection","content-length","transfer-encoding","accept-encoding","expect"].iter().any(|k|key.eq_ignore_ascii_case(k)) { req=req.header(key,value); } }
    let response=req.send().await.map_err(|error| {
        // reqwest errors may contain the full destination URL, including query
        // parameters. Keep the actionable transport reason but always strip URL.
        let detail = if error.is_timeout() { "连接超时" }
            else if error.is_connect() { "连接或 TLS 握手失败" }
            else if error.is_request() { "请求发送失败" }
            else { "传输失败" };
        let source = error.without_url().to_string();
        let source = source.split(" for url (").next().unwrap_or(&source);
        format!("上游 HTTP 请求失败：{detail}（{}）", source.chars().take(240).collect::<String>())
    })?;
    let mut status=response.status(); let mut response_headers=response.headers().iter().filter_map(|(k,v)|v.to_str().ok().map(|v|(k.to_string(),v.to_string()))).collect::<Vec<_>>();
    let mut response=response;
    let mut response_body=Vec::new();
    while let Some(chunk)=response.chunk().await.map_err(|_| "读取上游 HTTP 响应失败")? { if response_body.len().saturating_add(chunk.len())>MAX_MESSAGE{return Err("上游响应超过 4 MB 限制".into());}response_body.extend_from_slice(&chunk); }
    let decision=intercept(shared,"response",method,&url,&response_headers,&response_body,status.as_u16()).await?;
    if let Some(value)=decision.status {status=reqwest::StatusCode::from_u16(value).map_err(|_|"状态码无效")?;}
    if let Some(value)=decision.body {
        response_body=value.into_bytes();
        update_body_headers(&mut response_headers,response_body.len());
    }
    if method=="HEAD" || status.as_u16()==204 || status.as_u16()==304 {response_body.clear();}
    let reason=status.canonical_reason().unwrap_or("Response");
    write!(stream,"HTTP/1.1 {} {}\r\n",status.as_u16(),reason).map_err(|_|"写入代理响应失败")?;
    for (key,value) in &response_headers { if !["content-length","transfer-encoding","connection"].iter().any(|k|key.eq_ignore_ascii_case(k)) && !key.contains(['\r','\n']) && !value.contains(['\r','\n']) {write!(stream,"{key}: {value}\r\n").map_err(|_|"写入代理响应失败")?;} }
    write!(stream,"Content-Length: {}\r\nConnection: close\r\n\r\n",response_body.len()).and_then(|_|stream.write_all(&response_body)).map_err(|_|"写入代理响应失败")?;
    let request_image=response_image_data(&headers,&body);
    let response_image=response_image_data(&response_headers,&response_body);
    record(shared,Session{id:uuid::Uuid::new_v4().to_string(),timestamp:chrono::Utc::now().timestamp_millis(),method:method.to_string(),url,status:status.as_u16(),duration_ms:started.elapsed().as_millis() as u64,request_headers:headers,response_headers,request_body:body_text(&body),response_body:body_text(&response_body),request_image_data:request_image,response_image_data:response_image,error:None,note:None});
    Ok(())
}

fn client_worker(socket: TcpStream, peer: SocketAddr, shared: Arc<Mutex<Shared>>, ca_key: Arc<Zeroizing<String>>, handle: tokio::runtime::Handle, upstream: UpstreamProxy) -> Result<(),String> {
    if !peer.ip().is_loopback(){return Err("非本机代理连接".into());}
    // The listener is nonblocking so Tokio can poll accept(); accepted streams
    // must be switched back to blocking mode before rustls/std::io reads.
    socket.set_nonblocking(false).map_err(|_|"配置代理连接失败")?;
    let _=socket.set_read_timeout(Some(Duration::from_secs(30))); let _=socket.set_write_timeout(Some(Duration::from_secs(30)));
    serve_client(socket,shared,ca_key,handle,upstream)
}
fn serve_client(mut socket: TcpStream, shared: Arc<Mutex<Shared>>, ca_key: Arc<Zeroizing<String>>, handle: tokio::runtime::Handle, upstream: UpstreamProxy) -> Result<(),String> {
    let (start,headers,body)=read_message(&mut socket)?;
    if start.starts_with("CONNECT ") {
        let authority=start.split_whitespace().nth(1).ok_or("CONNECT 目标无效")?;
        let host=authority.rsplit_once(':').map(|(h,_)|h).unwrap_or(authority);
        let started=Instant::now();
        let (ca_cert,decrypt_https)={let s=shared.lock().map_err(|_|"代理状态不可用")?;(s.root_cert.clone(),s.decrypt_https)};
        if !decrypt_https {
            // Without a trusted root CA an intercepted TLS handshake is rejected
            // by every client, so keep HTTPS working through an opaque tunnel and
            // mark the session so the UI can prompt for certificate installation.
            match tunnel_target(authority,&upstream) {
                Ok(remote)=>{
                    socket.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").map_err(|_|"建立 HTTPS 隧道失败")?;
                    record(&shared,Session{id:uuid::Uuid::new_v4().to_string(),timestamp:chrono::Utc::now().timestamp_millis(),method:"CONNECT".into(),url:format!("https://{host}"),status:200,duration_ms:started.elapsed().as_millis() as u64,request_headers:Vec::new(),response_headers:Vec::new(),request_body:String::new(),response_body:String::new(),request_image_data:None,response_image_data:None,error:None,note:Some("HTTPS 未解密：未安装根证书，流量已加密转发".into())});
                    relay_tunnel(socket,remote,&handle);
                }
                Err(error)=>{let _=socket.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");record_connect_error(&shared,host,started,error);}
            }
            return Ok(());
        }
        let config=match make_server_config(host,&ca_cert,ca_key.as_str()) { Ok(config)=>config,Err(error)=>{record_connect_error(&shared,host,started,error.clone());return Err(error);} };
        socket.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").map_err(|_|"建立 HTTPS 隧道失败")?;
        let connection=rustls::ServerConnection::new(config).map_err(|_|"建立 HTTPS 解密连接失败")?;
        let mut tls=rustls::StreamOwned::new(connection,socket);
        let (inner,inner_headers,inner_body)=match read_message(&mut tls) { Ok(request)=>request,Err(error)=>{record_connect_error(&shared,host,started,error.clone());return Err(error);} };
        if let Err(error)=handle.block_on(handle_request(&mut tls,&shared,&upstream,Some(host),inner,inner_headers,inner_body)) {let _=tls.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");record_connect_error(&shared,host,started,error.clone());return Err(error);}
    } else {
        if let Err(error)=handle.block_on(handle_request(&mut socket,&shared,&upstream,None,start,headers,body)) {
            let _=socket.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            return Err(error);
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateSummary {
    pub common_name: String,
    pub subject: String,
    pub issuer: String,
    pub serial: String,
    pub fingerprint: String,
    pub not_before: i64,
    pub not_after: i64,
    pub expired: bool,
    pub is_ca: bool,
    pub installed: bool,
    pub is_application: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pem: Option<String>,
}
#[derive(Serialize)]
pub struct CertificateOverview { pub application: CertificateSummary, pub store: Vec<CertificateSummary> }

#[cfg(target_os="windows")]
fn format_fingerprint(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02X}")).collect::<Vec<_>>().join(":")
}
#[cfg(target_os="windows")]
fn parse_fingerprint(value: &str) -> Option<[u8;20]> {
    if !value.chars().all(|character| character.is_ascii_hexdigit() || character == ':') { return None; }
    let normalized: String = value.chars().filter(|character| *character != ':').collect();
    if normalized.len() != 40 { return None; }
    hex::decode(normalized).ok()?.try_into().ok()
}
#[cfg(target_os="windows")]
fn der_to_pem(der:&[u8])->String{
    let encoded=BASE64.encode(der);
    let mut pem=String::with_capacity(encoded.len()+64);
    pem.push_str("-----BEGIN CERTIFICATE-----\n");
    for chunk in encoded.as_bytes().chunks(64){ if let Ok(text)=std::str::from_utf8(chunk){ pem.push_str(text); pem.push('\n'); } }
    pem.push_str("-----END CERTIFICATE-----\n");
    pem
}
#[cfg(target_os="windows")]
fn certificate_summary(der: &[u8], application_fingerprint: &str) -> Option<CertificateSummary> {
    use sha1::{Digest,Sha1};
    let (_,cert)=x509_parser::parse_x509_certificate(der).ok()?;
    let fingerprint=format_fingerprint(&Sha1::digest(der));
    let not_before=cert.validity().not_before.timestamp();
    let not_after=cert.validity().not_after.timestamp();
    // Bind borrowed values before the struct literal: the iterator temporary
    // must drop while `cert` is still alive.
    let common_name=cert.subject().iter_common_name().next().and_then(|name|name.as_str().ok()).unwrap_or("").to_string();
    let subject=cert.subject().to_string();
    let issuer=cert.issuer().to_string();
    let serial=cert.raw_serial_as_string();
    let is_ca=cert.basic_constraints().ok().flatten().is_some_and(|extension|extension.value.ca);
    Some(CertificateSummary{
        common_name,
        subject,
        issuer,
        serial,
        is_application:fingerprint==application_fingerprint,
        fingerprint,
        not_before:not_before.saturating_mul(1000),
        not_after:not_after.saturating_mul(1000),
        expired:not_after<=chrono::Utc::now().timestamp(),
        is_ca,
        installed:true,
        pem:Some(der_to_pem(der)),
    })
}
#[cfg(target_os="windows")]
fn application_certificate_summary(cert_pem: &str) -> Result<CertificateSummary, String> {
    let (_,pem)=x509_parser::pem::parse_x509_pem(cert_pem.as_bytes()).map_err(|_|"解析应用根证书失败")?;
    let fingerprint=certificate_fingerprint(cert_pem).map(|value|format_fingerprint(&value)).ok_or("计算应用根证书指纹失败")?;
    let mut summary=certificate_summary(&pem.contents,&fingerprint).ok_or("解析应用根证书失败")?;
    summary.installed=certificate_installed(cert_pem);
    summary.is_application=true;
    summary.pem=Some(cert_pem.to_string());
    Ok(summary)
}
#[cfg(target_os="windows")]
fn cloudhub_store_certificates(application_fingerprint: &str) -> Result<Vec<CertificateSummary>, String> {
    use windows_sys::Win32::Security::Cryptography::*;
    let store=open_current_user_root_store(true)?;
    let mut items=Vec::new();
    let mut previous=std::ptr::null();
    let mut visited=0usize;
    loop {
        let current=unsafe { CertEnumCertificatesInStore(store,previous) };
        if current.is_null(){break;}
        visited+=1;
        let context=unsafe { &*current };
        let encoded=unsafe { std::slice::from_raw_parts(context.pbCertEncoded,context.cbCertEncoded as usize) };
        if let Some(summary)=certificate_summary(encoded,application_fingerprint) {
            if summary.subject.to_ascii_lowercase().contains("cloudhub") { items.push(summary); }
        }
        if items.len()>=64 || visited>=512 { unsafe { CertFreeCertificateContext(current); } break; }
        previous=current;
    }
    unsafe { CertCloseStore(store,0); }
    items.sort_by(|left,right|right.not_before.cmp(&left.not_before));
    Ok(items)
}
#[cfg(target_os="windows")]
async fn certificate_overview() -> Result<CertificateOverview, String> {
    tauri::async_runtime::spawn_blocking(||{
        let (cert,_)=ensure_ca()?;
        let application=application_certificate_summary(&cert)?;
        let store=cloudhub_store_certificates(&application.fingerprint).unwrap_or_default();
        Ok(CertificateOverview{application,store})
    }).await.map_err(|_|"读取根证书信息失败")?
}

#[cfg(target_os="windows")]
fn certificate_fingerprint(cert_pem: &str) -> Option<[u8;20]> {
    use sha1::{Digest,Sha1};
    let Ok((_,cert))=x509_parser::pem::parse_x509_pem(cert_pem.as_bytes()) else{return None;};
    Some(Sha1::digest(&cert.contents).into())
}
#[cfg(target_os="windows")]
fn open_current_user_root_store(read_only: bool) -> Result<windows_sys::Win32::Security::Cryptography::HCERTSTORE,String> {
    use windows_sys::Win32::Security::Cryptography::*;
    let name="Root\0".encode_utf16().collect::<Vec<_>>();
    // CurrentUser\Root is a protected store: modifications require the
    // unprotected flag. On this platform the registry-backed provider combined
    // with that flag reports a successful add and commit but keeps the
    // certificate in a volatile in-process store: nothing is written to HKCU
    // and other readers never see it. The plain system provider persists to the
    // current user's root store and reads back after reopening, so reads use it
    // without the unprotected flag and only writes request it.
    let flags=CERT_SYSTEM_STORE_CURRENT_USER | if read_only { CERT_STORE_READONLY_FLAG } else { CERT_SYSTEM_STORE_UNPROTECTED_FLAG };
    let store=unsafe { CertOpenStore(CERT_STORE_PROV_SYSTEM_W, 0, 0, flags, name.as_ptr().cast()) };
    if store.is_null() { Err(format!("无法打开当前用户根证书库：{}",std::io::Error::last_os_error())) } else { Ok(store) }
}
#[cfg(target_os="windows")]
fn find_root_certificate(store: windows_sys::Win32::Security::Cryptography::HCERTSTORE, thumb: &[u8;20]) -> *mut windows_sys::Win32::Security::Cryptography::CERT_CONTEXT {
    use sha1::{Digest,Sha1};
    use windows_sys::Win32::Security::Cryptography::*;
    let mut previous=std::ptr::null();
    loop {
        let current=unsafe { CertEnumCertificatesInStore(store,previous) };
        if current.is_null(){return std::ptr::null_mut();}
        let context=unsafe { &*current };
        let encoded=unsafe { std::slice::from_raw_parts(context.pbCertEncoded,context.cbCertEncoded as usize) };
        if Sha1::digest(encoded).as_slice()==thumb { return current; }
        previous=current;
    }
}
#[cfg(target_os="windows")]
fn certificate_installed(cert_pem: &str) -> bool {
    use windows_sys::Win32::Security::Cryptography::*;
    let Some(thumb)=certificate_fingerprint(cert_pem) else{return false;};
    let Ok(store)=open_current_user_root_store(true) else{return false;};
    let found=find_root_certificate(store,&thumb);
    unsafe { if !found.is_null(){CertFreeCertificateContext(found);} CertCloseStore(store,0); }
    !found.is_null()
}
#[cfg(not(target_os="windows"))]
fn certificate_installed(_: &str)->bool { false }
#[cfg(target_os="windows")]
fn install_certificate(cert_pem:&str, install:bool)->Result<(),String>{
    use windows_sys::Win32::Security::Cryptography::*;
    let data=x509_parser::pem::parse_x509_pem(cert_pem.as_bytes()).map_err(|_|"读取 HTTPS 根证书失败")?.1;
    let thumb=certificate_fingerprint(cert_pem).ok_or("计算 HTTPS 根证书指纹失败")?;
    if install {
        let store=open_current_user_root_store(false)?;
        let mut added_context=std::ptr::null_mut();
        let added=unsafe { CertAddEncodedCertificateToStore(
            store,
            X509_ASN_ENCODING,
            data.contents.as_ptr(),
            data.contents.len() as u32,
            CERT_STORE_ADD_REPLACE_EXISTING,
            &mut added_context,
        ) };
        let add_error=if added==0 { Some(std::io::Error::last_os_error()) } else { None };
        let committed=unsafe { CertControlStore(store,0,CERT_STORE_CTRL_COMMIT,std::ptr::null()) };
        let commit_error=if committed==0 { Some(std::io::Error::last_os_error()) } else { None };
        unsafe {
            if !added_context.is_null() { CertFreeCertificateContext(added_context); }
            CertCloseStore(store,0);
        }
        if let Some(error)=add_error { return Err(format!("Windows 拒绝将 HTTPS 根证书写入当前用户证书库：{error}")); }
        if let Some(error)=commit_error { return Err(format!("Windows 未能提交 HTTPS 根证书到当前用户证书库：{error}")); }
        if !certificate_installed(cert_pem) {
            let thumb_hex=hex::encode_upper(thumb);
            let user_key=format!(r"HKCU\Software\Microsoft\SystemCertificates\Root\Certificates\{thumb_hex}");
            let machine_key=format!(r"HKLM\Software\Microsoft\SystemCertificates\Root\Certificates\{thumb_hex}");
            let has_registry_key=|key:&str|windows_tool("reg.exe").and_then(|tool|std::process::Command::new(tool).args(["query",key]).output().ok()).is_some_and(|output|output.status.success());
            let user=has_registry_key(&user_key);
            let machine=has_registry_key(&machine_key);
            return Err(format!("证书写入操作返回成功，但重新打开当前用户根证书库后未找到对应指纹（用户存储记录：{}；本机存储记录：{}）",if user{"存在"}else{"不存在"},if machine{"存在"}else{"不存在"}));
        }
        return Ok(());
    }
    let store=open_current_user_root_store(false)?;
    let found=find_root_certificate(store,&thumb);
    let result=if found.is_null() { Ok(()) }
        else if unsafe { CertDeleteCertificateFromStore(found) }==0 { Err(format!("无法从当前用户根证书库移除 HTTPS 根证书：{}",std::io::Error::last_os_error())) }
        else { Ok(()) };
    unsafe { CertCloseStore(store,0); }
    result?;
    if !install && certificate_installed(cert_pem) { return Err("该证书仍存在于当前用户的 Windows 根证书存储中".into()); }
    Ok(())
}
#[cfg(not(target_os="windows"))]
fn install_certificate(_: &str,_:bool)->Result<(),String>{Err("HTTP 调试代理仅支持 Windows 桌面端".into())}

#[cfg(target_os="windows")]
fn remove_store_certificate(fingerprint: &str) -> Result<(), String> {
    use windows_sys::Win32::Security::Cryptography::*;
    let thumb=parse_fingerprint(fingerprint).ok_or("证书指纹格式无效")?;
    let store=open_current_user_root_store(false)?;
    let found=find_root_certificate(store,&thumb);
    if found.is_null() {
        unsafe { CertCloseStore(store,0); }
        return Err("该证书已不在当前用户根证书库中，可能已被移除".into());
    }
    let context=unsafe { &*found };
    let encoded=unsafe { std::slice::from_raw_parts(context.pbCertEncoded,context.cbCertEncoded as usize) };
    let subject=x509_parser::parse_x509_certificate(encoded).ok().map(|(_,cert)|cert.subject().to_string()).unwrap_or_default();
    if !subject.to_ascii_lowercase().contains("cloudhub") {
        unsafe { CertFreeCertificateContext(found); CertCloseStore(store,0); }
        return Err("仅允许移除 CloudHub 根证书".into());
    }
    let deleted=unsafe { CertDeleteCertificateFromStore(found) };
    let delete_error=if deleted==0 { Some(std::io::Error::last_os_error()) } else { None };
    let committed=unsafe { CertControlStore(store,0,CERT_STORE_CTRL_COMMIT,std::ptr::null()) };
    let commit_error=if committed==0 { Some(std::io::Error::last_os_error()) } else { None };
    unsafe {
        if deleted==0 { CertFreeCertificateContext(found); }
        CertCloseStore(store,0);
    }
    if let Some(error)=delete_error { return Err(format!("无法从当前用户根证书库移除证书：{error}")); }
    if let Some(error)=commit_error { return Err(format!("Windows 未能提交证书移除操作：{error}")); }
    let store=open_current_user_root_store(true)?;
    let remaining=find_root_certificate(store,&thumb);
    unsafe { if !remaining.is_null() { CertFreeCertificateContext(remaining); } CertCloseStore(store,0); }
    if !remaining.is_null() { return Err("该证书仍存在于当前用户的 Windows 根证书存储中".into()); }
    Ok(())
}

#[cfg(all(test,target_os="windows"))]
mod ca_store_integration_tests {
    use super::*;

    #[test]
    fn application_ca_round_trips_through_current_user_root_store() {
        let (cert, _) = ensure_ca().expect("load app HTTPS CA");
        if certificate_installed(&cert) { install_certificate(&cert,false).expect("remove pre-existing app CA for test"); }
        assert!(!certificate_installed(&cert),"app CA must be absent before import test");
        let install_result=install_certificate(&cert,true);
        let found_after_install=certificate_installed(&cert);
        let remove_result=install_certificate(&cert,false);
        assert!(install_result.is_ok(),"app CA import failed: {install_result:?}");
        assert!(found_after_install,"app CA was not found in the current-user root store after import");
        assert!(remove_result.is_ok(),"app CA removal failed: {remove_result:?}");
        assert!(!certificate_installed(&cert),"app CA remains after removal");
    }
}

#[tauri::command]
pub(crate) async fn http_debug_proxy_state()->PlatformResult<Snapshot>{
    #[cfg(not(target_os="windows"))] { return Err("HTTP 调试代理仅支持 Windows 桌面端".into()); }
    #[cfg(target_os="windows")] {
        let guard=runtime().lock().await;
        let (running,address,sessions,cert,https_decryption,upstream_proxy,proxy_requested,stats)=if let Some(r)=guard.as_ref(){let s=r.shared.lock().map_err(|_|"代理状态不可用")?;( !r.task.is_finished(),format!("127.0.0.1:{}",r.port),s.sessions.iter().cloned().collect(),s.root_cert.clone(),s.decrypt_https,r.upstream.http.is_some()||r.upstream.https.is_some(),r.system_proxy,s.stats)}else{let (cert,_)=ensure_ca()?;let sessions:Vec<Session>=session_history().lock().map_err(|_|"代理状态不可用")?.iter().cloned().collect();let decrypt_https=certificate_installed(&cert);(false,String::new(),sessions,cert,decrypt_https,false,false,CaptureStats::default())};
        let (system_proxy_enabled,system_proxy_server,system_proxy_recovery_available,system_proxy_recovery_safe)=system_proxy_details();
        let system_proxy=proxy_requested&&running&&system_proxy_enabled&&system_proxy_server.as_deref()==Some(address.as_str());
        Ok(Snapshot{running,address,system_proxy,system_proxy_enabled,system_proxy_server,system_proxy_recovery_available,system_proxy_recovery_safe,upstream_proxy,root_certificate_installed:certificate_installed(&cert),https_decryption,stats,sessions:sessions.iter().map(SessionSummary::from).collect()})
    }
}
#[tauri::command]
pub(crate) async fn http_debug_proxy_start(system_proxy:bool)->PlatformResult<Snapshot>{
    #[cfg(not(target_os="windows"))] { let _=system_proxy; return Err("HTTP 调试代理仅支持 Windows 桌面端".into()); }
    #[cfg(target_os="windows")] {
        let mut guard=runtime().lock().await;
        if guard.is_none(){
            restore_proxy()?;
            let upstream=current_upstream()?;
            let (root_cert,root_key)=ensure_ca()?;
            // Capture works without the CA: HTTPS stays encrypted through a raw
            // tunnel until the user installs the root certificate.
            let decrypt_https=certificate_installed(&root_cert);
            let listener=TcpListener::bind("127.0.0.1:0").map_err(|_|"无法启动本地代理监听")?;
            let port=listener.local_addr().map_err(|_|"读取本地代理端口失败")?.port(); listener.set_nonblocking(true).map_err(|_|"配置本地代理监听失败")?;
            let root_key=Arc::new(root_key);
            let sessions=session_history().lock().map_err(|_|"代理状态不可用")?.iter().cloned().collect();
            let shared=Arc::new(Mutex::new(Shared{intercept:InterceptState::default(),sessions,root_cert:root_cert.clone(),decrypt_https,stats:CaptureStats::default()}));
            let task_shared=shared.clone();
            let task_upstream=upstream.clone();
            let task=tokio::spawn(async move {
                let slots=Arc::new(Semaphore::new(16));
                loop { match listener.accept(){
                    Ok((stream,peer))=>{
                        if let Ok(mut shared)=task_shared.lock(){shared.stats.accepted_connections=shared.stats.accepted_connections.saturating_add(1);}
                        let Ok(permit)=slots.clone().try_acquire_owned() else { if let Ok(mut shared)=task_shared.lock(){shared.stats.overloaded_connections=shared.stats.overloaded_connections.saturating_add(1);} drop(stream); continue; };
                        let s=task_shared.clone();let key=root_key.clone();let handle=tokio::runtime::Handle::current();let upstream=task_upstream.clone();
                        let _=tokio::task::spawn_blocking(move||{let _permit=permit;let failure_shared=s.clone();if client_worker(stream,peer,s,key,handle,upstream).is_err(){if let Ok(mut shared)=failure_shared.lock(){shared.stats.failed_connections=shared.stats.failed_connections.saturating_add(1);}}});
                    },
                    Err(e) if e.kind()==std::io::ErrorKind::WouldBlock=>tokio::time::sleep(Duration::from_millis(20)).await,
                    Err(_)=>break
                } }
            });
            *guard=Some(Runtime{shared,task,port,system_proxy:false,upstream});
        }
        let r=guard.as_mut().ok_or("代理状态不可用")?;
        if system_proxy && !r.system_proxy {
            let written=format!("127.0.0.1:{}",r.port);
            let recovery=json!({"enable":reg_value("ProxyEnable"),"server":reg_value("ProxyServer"),"writtenServer":written,"writtenEnable":"0x1"});
            save_pref(RECOVERY_KEY,&encrypt_secret(&recovery.to_string()).map_err(|_|"无法保护系统代理恢复设置")?)?;
            if let Err(e)=set_proxy(&written){let _=restore_proxy();return Err(e.into());}
            r.system_proxy=true;
        }
        let s=r.shared.lock().map_err(|_|"代理状态不可用")?;
        let expected=format!("127.0.0.1:{}",r.port);
        let system_proxy=r.system_proxy&&reg_value("ProxyEnable").as_deref()==Some("0x1")&&reg_value("ProxyServer").as_deref()==Some(expected.as_str());
        let (system_proxy_enabled,system_proxy_server,system_proxy_recovery_available,system_proxy_recovery_safe)=system_proxy_details();
        Ok(Snapshot{running:!r.task.is_finished(),address:expected,system_proxy,system_proxy_enabled,system_proxy_server,system_proxy_recovery_available,system_proxy_recovery_safe,upstream_proxy:r.upstream.http.is_some()||r.upstream.https.is_some(),root_certificate_installed:certificate_installed(&s.root_cert),https_decryption:s.decrypt_https,stats:s.stats,sessions:s.sessions.iter().map(SessionSummary::from).collect()})
    }
}
#[tauri::command]
pub(crate) async fn http_debug_proxy_stop()->PlatformResult<()>{
    let mut guard=runtime().lock().await;
    #[cfg(target_os="windows")] restore_proxy()?;
    if let Some(r)=guard.as_ref(){
        let sessions=r.shared.lock().map_err(|_|"代理状态不可用")?.sessions.clone();
        *session_history().lock().map_err(|_|"代理状态不可用")?=sessions;
    }
    guard.take(); Ok(())
}
#[tauri::command]
pub(crate) async fn http_debug_proxy_restore_system_proxy()->PlatformResult<()> {
    #[cfg(not(target_os="windows"))] { return Err("HTTP(S) 抓包仅支持 Windows 桌面端".into()); }
    #[cfg(target_os="windows")] {
        let guard=runtime().lock().await;
        if guard.is_some() { return Err("请先停止抓包，再恢复 Windows 系统代理设置".into()); }
        let raw=pref(RECOVERY_KEY)?.ok_or("没有待恢复的系统代理设置")?;
        let plaintext=decrypt_secret(&raw).map_err(|_|"系统代理恢复记录不可用，未修改 Windows 设置")?;
        let saved:Value=serde_json::from_str(&plaintext).map_err(|_|"系统代理恢复记录格式无效")?;
        let expected=saved["writtenServer"].as_str().unwrap_or("");
        if expected.is_empty() || reg_value("ProxyServer").as_deref()!=Some(expected) {
            return Err("检测到 Windows 系统代理已被其他操作修改，为避免覆盖当前设置，未执行恢复".into());
        }
        restore_proxy()?;
        Ok(())
    }
}
#[tauri::command]
pub(crate) async fn http_debug_proxy_set_certificate(installed:bool)->PlatformResult<Snapshot>{
    #[cfg(not(target_os="windows"))] {let _=installed;return Err("HTTP 调试代理仅支持 Windows 桌面端".into());}
    #[cfg(target_os="windows")] {
        let (cert,_)=ensure_ca()?;
        if certificate_installed(&cert)!=installed {
            // Root store changes may block on a Windows security warning dialog.
            // Keep that wait off the async worker threads.
            let target=cert.clone();
            tauri::async_runtime::spawn_blocking(move||install_certificate(&target,installed)).await.map_err(|_|"证书操作意外终止")??;
        }
        let trusted=certificate_installed(&cert);
        {
            let guard=runtime().lock().await;
            if let Some(r)=guard.as_ref(){ if let Ok(mut shared)=r.shared.lock(){ shared.decrypt_https=trusted; } }
        }
        http_debug_proxy_state().await
    }
}
#[tauri::command]
pub(crate) async fn http_debug_proxy_certificates()->PlatformResult<CertificateOverview>{
    #[cfg(not(target_os="windows"))] { return Err("HTTP(S) 抓包根证书管理仅支持 Windows 桌面端".into()); }
    #[cfg(target_os="windows")] { certificate_overview().await.map_err(Into::into) }
}
#[tauri::command]
pub(crate) async fn http_debug_proxy_remove_certificate(fingerprint:String)->PlatformResult<Snapshot>{
    #[cfg(not(target_os="windows"))] { let _=fingerprint; return Err("HTTP(S) 抓包根证书管理仅支持 Windows 桌面端".into()); }
    #[cfg(target_os="windows")] {
        if fingerprint.is_empty()||fingerprint.len()>128 { return Err("证书指纹无效".into()); }
        // Removing a certificate from the root store can block on a Windows
        // confirmation dialog, so keep the wait off the async worker threads.
        let target=fingerprint.clone();
        tauri::async_runtime::spawn_blocking(move||remove_store_certificate(&target)).await.map_err(|_|"证书操作意外终止")??;
        let (cert,_)=ensure_ca()?;
        let trusted=certificate_installed(&cert);
        {
            let guard=runtime().lock().await;
            if let Some(r)=guard.as_ref(){ if let Ok(mut shared)=r.shared.lock(){ shared.decrypt_https=trusted; } }
        }
        http_debug_proxy_state().await
    }
}
#[tauri::command]
pub(crate) async fn http_debug_proxy_delete_application_certificate()->PlatformResult<()> {
    #[cfg(not(target_os="windows"))] { return Err("HTTP(S) 抓包根证书管理仅支持 Windows 桌面端".into()); }
    #[cfg(target_os="windows")] {
        {
            let guard=runtime().lock().await;
            if guard.as_ref().is_some_and(|running| !running.task.is_finished()) {
                return Err("请先停止 HTTP 调试代理，再删除应用根证书".into());
            }
        }
        let (cert,_)=ensure_ca()?;
        if certificate_installed(&cert) {
            let target=cert.clone();
            tauri::async_runtime::spawn_blocking(move||install_certificate(&target,false)).await.map_err(|_|"证书操作意外终止")??;
        }
        open_db()?.execute("DELETE FROM client_preferences WHERE key=?1", [CA_KEY]).map_err(|_|"删除本机 HTTPS 调试证书失败")?;
        Ok(())
    }
}
#[tauri::command]
pub(crate) async fn http_debug_proxy_clear()->PlatformResult<()>{
    session_history().lock().map_err(|_|"代理状态不可用")?.clear();
    let guard=runtime().lock().await;if let Some(r)=guard.as_ref(){let mut shared=r.shared.lock().map_err(|_|"代理状态不可用")?;shared.sessions.clear();shared.stats=CaptureStats::default();}Ok(())
}
#[tauri::command]
pub(crate) async fn http_debug_proxy_session(id:String,reveal_sensitive:bool)->PlatformResult<Session>{
    if id.is_empty()||id.len()>64{return Err("会话标识无效".into());}
    let guard=runtime().lock().await;
    let item=if let Some(r)=guard.as_ref(){r.shared.lock().map_err(|_|"代理状态不可用")?.sessions.iter().find(|item|item.id==id).cloned()}else{session_history().lock().map_err(|_|"代理状态不可用")?.iter().find(|item|item.id==id).cloned()};
    item.map(|item|session_for_display(&item,reveal_sensitive)).ok_or_else(||"会话不存在，可能已被手动清空".into())
}
#[tauri::command]
pub(crate) async fn http_debug_proxy_export_session(app:tauri::AppHandle,id:String)->PlatformResult<Option<String>>{
    if id.is_empty()||id.len()>64{return Err("会话标识无效".into());}
    let filename=format!("http-session-{}.json",chrono::Utc::now().format("%Y%m%d-%H%M%S"));
    let picker=tauri::async_runtime::spawn_blocking(move||app.dialog().file().set_title("导出 HTTP 会话（可能包含敏感正文）").set_file_name(filename).add_filter("HTTP 会话 JSON（可能包含敏感内容）",&["json"]).blocking_save_file()).await.map_err(|_|"打开会话导出对话框失败")?;
    let Some(file)=picker else{return Ok(None)};
    let mut target=file.into_path().map_err(|_|"导出路径无效")?;
    if target.extension().is_none(){target.set_extension("json");}
    if !target.extension().is_some_and(|ext|ext.eq_ignore_ascii_case("json")){return Err("请使用 JSON 文件扩展名".into());}
    let guard=runtime().lock().await;
    let session=if let Some(r)=guard.as_ref(){r.shared.lock().map_err(|_|"代理状态不可用")?.sessions.iter().find(|item|item.id==id).cloned()}else{session_history().lock().map_err(|_|"代理状态不可用")?.iter().find(|item|item.id==id).cloned()}.ok_or("会话不存在，可能已被手动清空")?;
    let value=serde_json::to_vec_pretty(&session_for_display(&session,false)).map_err(|_|"会话序列化失败")?;
    std::fs::write(&target,value).map_err(|_|"导出失败，请检查保存目录权限")?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

pub(crate) fn shutdown() {
    #[cfg(target_os="windows")] { let _=restore_proxy(); }
    if let Some(value)=RUNTIME.get() { if let Ok(mut guard)=value.try_lock(){guard.take();} }
}

pub(crate) fn recover_abandoned() { #[cfg(target_os="windows")] { let _=restore_proxy(); } }

#[cfg(test)]
mod intercept_tests {
    use super::*;
    fn shared() -> Arc<Mutex<Shared>> {
        Arc::new(Mutex::new(Shared { intercept: InterceptState { config: InterceptConfig { request: true, response: true, keyword: "127.0.0.1".into() }, ..Default::default() }, sessions: VecDeque::new(), root_cert: String::new(), decrypt_https: false, stats: CaptureStats::default() }))
    }
    async fn wait_pending(shared: &Arc<Mutex<Shared>>, phase: &str) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if shared.lock().unwrap().intercept.pending.iter().any(|item|item.detail.summary.phase==phase) {break;}
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.expect("breakpoint must arrive");
    }
    fn release(shared: &Arc<Mutex<Shared>>, decision: InterceptDecision) {
        assert!(shared.lock().unwrap().intercept.pending.remove(0).sender.send(decision).is_ok());
    }
    #[tokio::test]
    async fn edits_reach_origin_and_client() {
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();
        let address=listener.local_addr().unwrap();
        let origin=std::thread::spawn(move || {
            let (mut socket,_)=listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let (start,headers,body)=read_message(&mut socket).unwrap();
            assert!(start.contains("/changed?value=2"));
            assert_eq!(body,b"modified request");
            assert!(headers.iter().any(|(key,value)|key.eq_ignore_ascii_case("content-length") && value=="16"));
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 8\r\n\r\noriginal").unwrap();
        });
        let shared=shared();
        let worker_shared=shared.clone();
        let task=tokio::spawn(async move {
            let mut output=std::io::Cursor::new(Vec::<u8>::new());
            handle_request(&mut output,&worker_shared,&UpstreamProxy::default(),None,format!("POST http://{address}/original HTTP/1.1"),vec![("Host".into(),address.to_string()),("Content-Length".into(),"3".into())],b"old".to_vec()).await.unwrap();
            output.into_inner()
        });
        wait_pending(&shared,"request").await;
        // No connection has reached the origin before the request breakpoint is released.
        release(&shared,InterceptDecision {body:Some("modified request".into()),url:Some(format!("http://{address}/changed?value=2")),..Default::default()});
        wait_pending(&shared,"response").await;
        assert_eq!(shared.lock().unwrap().intercept.pending[0].detail.body.as_deref(),Some("original"));
        assert!(!task.is_finished());
        release(&shared,InterceptDecision {body:Some("modified response".into()),status:Some(201),..Default::default()});
        let output=String::from_utf8(task.await.unwrap()).unwrap();
        assert!(output.starts_with("HTTP/1.1 201 Created"));
        assert!(output.ends_with("modified response"));
        assert!(output.contains("Content-Length: 17\r\n"));
        assert!(shared.lock().unwrap().intercept.pending.is_empty());
        origin.join().unwrap();
    }
    #[tokio::test]
    async fn cancel_and_stop_release_waiters() {
        for cancel in [true,false] {
            let shared=shared();
            let worker_shared=shared.clone();
            let task=tokio::spawn(async move {intercept(&worker_shared,"request","POST","http://127.0.0.1/test",&[],b"body",0).await});
            wait_pending(&shared,"request").await;
            if cancel {release(&shared,InterceptDecision {cancel:true,..Default::default()});}
            else {let mut value=shared.lock().unwrap();value.intercept.stopped=true;value.intercept.pending.clear();}
            assert!(task.await.unwrap().is_err());
            assert!(shared.lock().unwrap().intercept.pending.is_empty());
        }
    }
    #[tokio::test]
    async fn invalid_edits_are_rejected_before_resolving() {
        for url in ["file:///tmp/sample", "http://example.test/\r\nx", "http://name:sample@example.test/"] {
            assert!(http_debug_proxy_resolve_intercept("missing".into(),InterceptDecision {url:Some(url.into()),..Default::default()}).await.is_err());
        }
        assert!(http_debug_proxy_resolve_intercept("missing".into(),InterceptDecision {status:Some(100),..Default::default()}).await.is_err());
        assert!(http_debug_proxy_resolve_intercept("missing".into(),InterceptDecision {body:Some("a".repeat(256*1024+1)),..Default::default()}).await.is_err());
    }
    #[tokio::test]
    async fn unmatched_requests_bypass_and_unsafe_bodies_are_readonly() {
        let shared=shared();
        assert!(intercept(&shared,"request","GET","http://example.test/",&[],b"",0).await.is_ok());
        assert!(shared.lock().unwrap().intercept.pending.is_empty());
        assert!(editable_body(&[],b"\xff\x00").is_none());
        assert!(editable_body(&[("Content-Encoding".into(),"gzip".into())],b"text").is_none());
        assert!(editable_body(&[],&vec![b'a';256*1024+1]).is_none());
    }
}
