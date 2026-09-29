use crate::core::{error::PlatformResult, paths::data_dir, storage::{decrypt_secret, encrypt_secret, open_db}};
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, ffi::OsStr, fs, net::TcpListener, path::{Path, PathBuf}, process::{Child, Command, Stdio}, sync::{Arc, Mutex}, time::{Duration, Instant}};
use tauri::State;

const FRP_VERSION: &str = "0.71.0";
const FIRST_PANEL_PORT: u16 = 7400;

#[derive(Clone, Default)]
pub(crate) struct FrpProcessStore(Arc<Mutex<HashMap<i64, Child>>>);

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
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrpServerInput {
    id: Option<i64>,
    name: String,
    server_addr: String,
    server_port: u16,
    token: Option<String>,
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
    let mut statement = db.prepare("SELECT id,name,kind,local_ip,local_port,remote_port,custom_domain,enabled FROM frp_local_proxies WHERE server_id=?1 ORDER BY id").map_err(|error| error.to_string())?;
    let result = statement.query_map([server_id], |row| Ok(FrpProxy { id: Some(row.get(0)?), server_id, name: row.get(1)?, kind: row.get(2)?, local_ip: row.get(3)?, local_port: row.get(4)?, remote_port: row.get(5)?, custom_domain: row.get(6)?, enabled: row.get(7)? })).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string());
    result
}

fn load_server(server_id: i64) -> Result<Option<SavedServer>, String> {
    let row = open_db()?.query_row("SELECT server_addr,server_port,token_ciphertext,admin_port FROM frp_local_servers WHERE id=?1", [server_id], |row| Ok((row.get::<_,String>(0)?, row.get::<_,u16>(1)?, row.get::<_,Option<String>>(2)?, row.get::<_,u16>(3)?))).optional().map_err(|error| format!("读取 FRP 服务端失败: {error}"))?;
    row.map(|(server_addr,server_port,token_ciphertext,admin_port)| Ok(SavedServer { server_addr,server_port,token_ciphertext,admin_port,proxies:load_proxies(server_id)? })).transpose()
}

#[tauri::command]
pub(crate) fn list_frp_servers() -> PlatformResult<Vec<FrpServer>> {
    let db = open_db()?;
    let rows = {
        let mut statement = db.prepare("SELECT id,name,server_addr,server_port,token_ciphertext,admin_port,updated_at FROM frp_local_servers ORDER BY id").map_err(|error| error.to_string())?;
        let result = statement.query_map([], |row| Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,u16>(3)?,row.get::<_,Option<String>>(4)?,row.get::<_,u16>(5)?,row.get::<_,i64>(6)?))).map_err(|error| error.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|error| error.to_string())?;
        result
    };
    rows.into_iter().map(|(id,name,server_addr,server_port,token,admin_port,updated_at)| Ok(FrpServer { id,name,server_addr,server_port,token_saved:token.as_ref().is_some_and(|value| !value.is_empty()),admin_port,proxies:load_proxies(id)?,updated_at })).collect::<Result<Vec<_>,String>>().map_err(Into::into)
}

fn valid_hostname(value: &str) -> bool { !value.is_empty() && value.len() <= 253 && value.split('.').all(|part| !part.is_empty() && part.len() <= 63 && !part.starts_with('-') && !part.ends_with('-') && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')) }
fn valid_address(value: &str) -> bool { valid_hostname(value) || value.parse::<std::net::IpAddr>().is_ok() }

fn validate_server(input: &FrpServerInput) -> Result<(), String> {
    if input.name.trim().is_empty() || input.name.len() > 80 || input.server_port == 0 || !valid_address(input.server_addr.trim()) { return Err("服务端名称、地址或端口无效".into()); }
    if input.token.as_ref().is_some_and(|value| value.len() > 1024) { return Err("服务端 Token 长度无效".into()); }
    if input.proxies.len() > 100 { return Err("每个服务端最多配置 100 条穿透规则".into()); }
    let mut names = HashSet::new(); let mut ports = HashSet::new(); let mut domains = HashSet::new();
    for proxy in &input.proxies {
        if proxy.name.is_empty() || proxy.name.len() > 64 || !proxy.name.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte)) || !names.insert(&proxy.name) { return Err("穿透规则名称无效或重复".into()); }
        if !["tcp","udp","http","https"].contains(&proxy.kind.as_str()) || !valid_address(proxy.local_ip.trim()) || proxy.local_port == 0 { return Err("穿透规则类型或本地目标无效".into()); }
        if ["tcp","udp"].contains(&proxy.kind.as_str()) {
            let port = proxy.remote_port.unwrap_or(0); if port == 0 || proxy.custom_domain.as_ref().is_some_and(|value| !value.is_empty()) || !ports.insert((proxy.kind.as_str(),port)) { return Err("TCP/UDP 远端端口无效或重复".into()); }
        } else {
            let domain = proxy.custom_domain.as_deref().filter(|value| valid_hostname(value)).ok_or("HTTP/HTTPS 规则需要有效域名")?;
            if proxy.remote_port.is_some() || !domains.insert((proxy.kind.as_str(),domain)) { return Err("HTTP/HTTPS 域名无效或重复".into()); }
        }
    }
    Ok(())
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
    let tx=db.unchecked_transaction().map_err(|e|e.to_string())?;
    let id=if let Some(id)=input.id {
        tx.execute("UPDATE frp_local_servers SET name=?1,server_addr=?2,server_port=?3,token_ciphertext=?4,updated_at=?5 WHERE id=?6",params![input.name.trim(),input.server_addr.trim(),input.server_port,token,now,id]).map_err(|e|e.to_string())?; id
    } else {
        tx.execute("INSERT INTO frp_local_servers(name,server_addr,server_port,token_ciphertext,admin_port,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6)",params![input.name.trim(),input.server_addr.trim(),input.server_port,token,panel_port,now]).map_err(|e|e.to_string())?; tx.last_insert_rowid()
    };
    tx.execute("DELETE FROM frp_local_proxies WHERE server_id=?1",[id]).map_err(|e|e.to_string())?;
    for proxy in input.proxies { tx.execute("INSERT INTO frp_local_proxies(server_id,name,kind,local_ip,local_port,remote_port,custom_domain,enabled,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)",params![id,proxy.name,proxy.kind,proxy.local_ip.trim(),proxy.local_port,proxy.remote_port,proxy.custom_domain,proxy.enabled,now]).map_err(|e|e.to_string())?; }
    tx.commit().map_err(|e|e.to_string())?;
    Ok(list_frp_servers()?.into_iter().find(|server|server.id==id).ok_or_else(||String::from("保存 FRP 服务端失败"))?)
}

#[tauri::command]
pub(crate) fn delete_frp_server(store: State<'_,FrpProcessStore>, id:i64) -> PlatformResult<()> {
    stop_process(&store,id)?;
    let changed=open_db()?.execute("DELETE FROM frp_local_servers WHERE id=?1",[id]).map_err(|e|e.to_string())?;
    if changed==0 { return Err("FRP 服务端配置不存在".into()); }
    let _=fs::remove_dir_all(server_dir(id)?); Ok(())
}

fn toml_string(value:&str)->Result<String,String>{serde_json::to_string(value).map_err(|_|"FRP 配置字段无效".into())}
fn render_config(server:&SavedServer,global:&SavedGlobalSettings)->Result<String,String>{
    let password=decrypt_secret(&global.admin_password_ciphertext)?;
    let mut config=format!("serverAddr = {}\nserverPort = {}\nauth.method = \"token\"\ntransport.tls.enable = true\nwebServer.addr = \"127.0.0.1\"\nwebServer.port = {}\nwebServer.user = {}\nwebServer.password = {}\n",toml_string(&server.server_addr)?,server.server_port,server.admin_port,toml_string(&global.admin_user)?,toml_string(&password)?);
    if let Some(ciphertext)=server.token_ciphertext.as_deref(){config.push_str(&format!("auth.token = {}\n",toml_string(&decrypt_secret(ciphertext)?)?));}
    for proxy in &server.proxies { if !proxy.enabled { continue; }
        config.push_str(&format!("\n[[proxies]]\nname = {}\ntype = {}\nenabled = true\nlocalIP = {}\nlocalPort = {}\n",toml_string(&proxy.name)?,toml_string(&proxy.kind)?,toml_string(&proxy.local_ip)?,proxy.local_port));
        if let Some(port)=proxy.remote_port {config.push_str(&format!("remotePort = {port}\n"));}
        if let Some(domain)=proxy.custom_domain.as_deref(){config.push_str(&format!("customDomains = [{}]\n",toml_string(domain)?));}
    }
    Ok(config)
}
fn frp_root()->Result<PathBuf,String>{let path=data_dir()?.join("frp");fs::create_dir_all(&path).map_err(|_|"创建本机 FRP 目录失败".to_string())?;Ok(path)}
fn server_dir(id:i64)->Result<PathBuf,String>{let path=frp_root()?.join(format!("server-{id}"));fs::create_dir_all(&path).map_err(|_|"创建服务端 FRP 目录失败".to_string())?;Ok(path)}
fn binary_path()->Result<PathBuf,String>{Ok(frp_root()?.join(if cfg!(windows){"frpc.exe"}else{"frpc"}))}
fn config_path(id:i64)->Result<PathBuf,String>{Ok(server_dir(id)?.join("frpc.toml"))}
fn hidden_command(program:impl AsRef<OsStr>)->Command{let mut command=Command::new(program);#[cfg(windows)]{use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}command}
fn is_running(store:&FrpProcessStore,id:i64)->Result<bool,String>{let mut processes=store.0.lock().map_err(|_|"FRP 进程状态不可用".to_string())?;if let Some(child)=processes.get_mut(&id){if child.try_wait().map_err(|_|"读取 FRP 进程状态失败".to_string())?.is_some(){processes.remove(&id);return Ok(false);}return Ok(true);}Ok(false)}
fn stop_process(store:&FrpProcessStore,id:i64)->Result<(),String>{if let Some(mut child)=store.0.lock().map_err(|_|"FRP 进程状态不可用".to_string())?.remove(&id){let _=child.kill();let _=child.wait();}Ok(())}
fn start_process(store:&FrpProcessStore,id:i64)->Result<(),String>{if !binary_path()?.is_file(){return Err("请先安装本机 frpc".into());}let config=config_path(id)?;if !config.is_file(){return Err("请先应用该服务端的 FRP 配置".into());}if is_running(store,id)?{return Ok(());}let child=hidden_command(binary_path()?).arg("-c").arg(config).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|_|"启动本机 frpc 失败".to_string())?;store.0.lock().map_err(|_|"FRP 进程状态不可用".to_string())?.insert(id,child);Ok(())}

#[tauri::command]
pub(crate) async fn install_frpc(store:State<'_,FrpProcessStore>)->PlatformResult<()>{if !store.0.lock().map_err(|_|"FRP 进程状态不可用".to_string())?.is_empty(){return Err("请先停止所有 frpc 实例再更新".into());}#[cfg(not(windows))]{return Err("本机一键安装当前支持 Windows".into());}#[cfg(windows)]{let(arch,checksum)=match std::env::consts::ARCH{"x86_64"=>("amd64","9e5062e3e5cf07e67144a3a4acf175ef6a2486f3605dd6cf288bae34ab39819f"),"aarch64"=>("arm64","b56a5c2a1a2a55d11bc27aeef6edabd39f3d194360ea66660cc27281b502cb1c"),_=>return Err("当前 Windows 架构暂不支持一键安装".into())};let archive_name=format!("frp_{FRP_VERSION}_windows_{arch}.zip");let url=format!("https://github.com/fatedier/frp/releases/download/v{FRP_VERSION}/{archive_name}");let bytes=reqwest::Client::new().get(url).timeout(Duration::from_secs(180)).send().await.map_err(|_|"下载官方 frpc 失败：请检查 GitHub 网络".to_string())?.error_for_status().map_err(|_|"下载官方 frpc 失败：发布文件不可用".to_string())?.bytes().await.map_err(|_|"读取 frpc 安装包失败".to_string())?;if bytes.len()>50_000_000||hex::encode(Sha256::digest(&bytes))!=checksum{return Err("frpc 安装包校验失败".into());}let directory=frp_root()?;let stage=directory.join(format!("stage-{}",uuid::Uuid::new_v4()));fs::create_dir(&stage).map_err(|_|"创建 frpc 安装临时目录失败".to_string())?;let result=(||->Result<(),String>{let archive=stage.join(&archive_name);fs::write(&archive,bytes).map_err(|_|"保存 frpc 安装包失败".to_string())?;let system_root=std::env::var_os("SystemRoot").ok_or("无法定位 Windows 系统目录")?;let tar=PathBuf::from(system_root).join("System32").join("tar.exe");let member=format!("frp_{FRP_VERSION}_windows_{arch}/frpc.exe");let extracted=hidden_command(tar).arg("-xf").arg(&archive).arg("-C").arg(&stage).arg(&member).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|_|"解压 frpc 安装包失败".to_string())?;if !extracted.success(){return Err("解压 frpc 安装包失败".into());}let source=stage.join(member);let destination=binary_path()?;let backup=directory.join("frpc.exe.bak");let _=fs::remove_file(&backup);if destination.is_file(){fs::rename(&destination,&backup).map_err(|_|"备份旧版 frpc 失败".to_string())?;}if fs::copy(&source,&destination).is_err(){if backup.is_file(){let _=fs::rename(&backup,&destination);}return Err("安装 frpc 可执行文件失败".into());}let _=fs::remove_file(backup);Ok(())})();let _=fs::remove_file(stage.join(format!("frp_{FRP_VERSION}_windows_{arch}")).join("frpc.exe"));let _=fs::remove_file(stage.join(archive_name));let _=fs::remove_dir(stage.join(format!("frp_{FRP_VERSION}_windows_{arch}")));let _=fs::remove_dir(&stage);Ok(result?)}}

fn apply_one(store:&FrpProcessStore,id:i64)->Result<FrpRuntime,String>{let server=load_server(id)?.ok_or("FRP 服务端配置不存在")?;let global=get_global()?.ok_or("请先设置客户端面板账号和密码")?;let binary=binary_path()?;if !binary.is_file(){return Err("请先安装本机 frpc".into());}let config=render_config(&server,&global)?;let path=config_path(id)?;let next=path.with_extension("toml.next");let backup=path.with_extension("toml.bak");let was_running=is_running(store,id)?;let _=fs::remove_file(&backup);fs::write(&next,config).map_err(|_|"写入本机 FRP 配置失败".to_string())?;let verified=hidden_command(&binary).arg("verify").arg("-c").arg(&next).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|_|"校验本机 FRP 配置失败".to_string())?;if !verified.success(){let _=fs::remove_file(next);return Err("FRP 配置校验未通过，请检查规则名称、端口和域名".into());}if path.is_file(){fs::copy(&path,&backup).map_err(|_|"备份原 FRP 配置失败".to_string())?;}if was_running{stop_process(store,id)?;}if fs::rename(&next,&path).is_err(){if was_running{let _=start_process(store,id);}return Err("替换本机 FRP 配置失败".into());}if let Err(error)=start_process(store,id){if backup.is_file(){let _=fs::copy(&backup,&path);if was_running{let _=start_process(store,id);}}else{let _=fs::remove_file(&path);}let _=fs::remove_file(&backup);return Err(error);}std::thread::sleep(Duration::from_secs(2));let state=runtime_one(store,id)?;if !state.running{stop_process(store,id)?;if backup.is_file(){let _=fs::copy(&backup,&path);if was_running{let _=start_process(store,id);}}else{let _=fs::remove_file(&path);}let _=fs::remove_file(&backup);return Err("frpc 启动后退出，已恢复应用前配置".into());}let _=fs::remove_file(backup);Ok(state)}

fn proxy_statuses(binary:&Path,config:&Path)->Vec<FrpProxyRuntime>{let Ok(mut child)=hidden_command(binary).arg("status").arg("-c").arg(config).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()else{return Vec::new()};let deadline=Instant::now()+Duration::from_secs(3);loop{match child.try_wait(){Ok(Some(status))=>{if !status.success(){return Vec::new();}return child.wait_with_output().ok().map(|output|String::from_utf8_lossy(&output.stdout).lines().filter_map(|line|{let mut fields=line.split_whitespace();let name=fields.next()?;let state=fields.next()?;if !name.bytes().all(|b|b.is_ascii_alphanumeric()||b"_.-".contains(&b))||!["running","wait","error"].contains(&state){return None;}Some(FrpProxyRuntime{name:name.to_string(),status:state.to_string()})}).collect()).unwrap_or_default();},Ok(None)if Instant::now()<deadline=>std::thread::sleep(Duration::from_millis(50)),_=>{let _=child.kill();let _=child.wait();return Vec::new();}}}}
fn runtime_one(store:&FrpProcessStore,id:i64)->Result<FrpRuntime,String>{let binary=binary_path()?;let config=config_path(id)?;let installed=binary.is_file();let config_present=config.is_file();let config_current=if config_present{load_server(id)?.zip(get_global()?).and_then(|(s,g)|render_config(&s,&g).ok()).zip(fs::read_to_string(&config).ok()).is_some_and(|(expected,actual)|expected==actual)}else{false};let running=is_running(store,id)?;let proxies=if installed&&config_present&&running{proxy_statuses(&binary,&config)}else{Vec::new()};let connected=proxies.iter().any(|proxy|proxy.status=="running");Ok(FrpRuntime{server_id:id,installed,config_present,config_current,running,connected,version:installed.then(||FRP_VERSION.to_string()),proxies})}
fn runtime_all(store:&FrpProcessStore)->Result<Vec<FrpRuntime>,String>{list_frp_servers().map_err(|error|error.message)?.into_iter().map(|server|runtime_one(store,server.id)).collect()}

#[tauri::command]
pub(crate) async fn apply_frp_profile(store:State<'_,FrpProcessStore>,server_id:i64)->PlatformResult<FrpRuntime>{let store=store.inner().clone();tauri::async_runtime::spawn_blocking(move||apply_one(&store,server_id)).await.map_err(|_|"应用 FRP 配置任务失败".to_string())?.map_err(Into::into)}
#[tauri::command]
pub(crate) async fn get_frpc_runtime(store:State<'_,FrpProcessStore>)->PlatformResult<Vec<FrpRuntime>>{let store=store.inner().clone();tauri::async_runtime::spawn_blocking(move||runtime_all(&store)).await.map_err(|_|"读取 FRP 状态失败".to_string())?.map_err(Into::into)}
#[tauri::command]
pub(crate) async fn control_frpc(store:State<'_,FrpProcessStore>,server_id:i64,action:String)->PlatformResult<Vec<FrpRuntime>>{let store=store.inner().clone();tauri::async_runtime::spawn_blocking(move||{match action.as_str(){"start"=>start_process(&store,server_id)?,"stop"=>stop_process(&store,server_id)?,"restart"=>{stop_process(&store,server_id)?;start_process(&store,server_id)?;},_=>return Err("FRP 服务操作无效".into())}if action!="stop"{std::thread::sleep(Duration::from_secs(2));}runtime_all(&store)}).await.map_err(|_|"FRP 服务操作任务失败".to_string())?.map_err(Into::into)}
#[tauri::command]
pub(crate) fn open_frpc_panel(store:State<'_,FrpProcessStore>,server_id:i64)->PlatformResult<String>{let server=load_server(server_id)?.ok_or("FRP 服务端配置不存在")?;if !is_running(&store,server_id)?{return Err("请先启动该服务端的 frpc".into());}Ok(format!("http://127.0.0.1:{}",server.admin_port))}
