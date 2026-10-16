use super::{cdp::Connection, error, kernel::{self, KernelState}, model, proxy, require_supported, root, validate_id};
use crate::core::error::PlatformResult;
use serde::Serialize;
use std::{collections::HashMap, fs, process::{Child, Command, Stdio}, sync::{Arc, Mutex, mpsc}, time::{Duration, Instant}};

pub(super) fn network_flags(proxy_port: Option<u16>) -> Vec<String> {
    // CfT ships a testing variations config. Do not force experimental trials
    // into user environments (the pinned build otherwise exits before CDP with
    // the sandbox enabled on this Windows host). This does not disable sandboxing.
    let mut flags=vec!["--disable-field-trial-config".into(),"--disable-background-networking".into(),"--disable-quic".into(),"--dns-prefetch-disable".into(),"--webrtc-ip-handling-policy=disable_non_proxied_udp".into(),"--force-webrtc-ip-handling-policy=disable_non_proxied_udp".into()];
    if let Some(port)=proxy_port {
        flags.extend([format!("--proxy-server=http://127.0.0.1:{port}"),"--proxy-bypass-list=<-loopback>".into(),"--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1".into()]);
    } else {flags.push("--no-proxy-server".into());}
    flags
}

pub(super) fn fingerprint_flags(config: &model::EnvironmentConfig) -> Vec<String> {
    let Some(fp) = &config.fingerprint else { return vec![]; };
    let mut flags=vec![format!("--fingerprint={}",fp.seed),"--fingerprint-platform=windows".into(),
        "--disable-gpu-fingerprint".into(),format!("--fingerprint-hardware-concurrency={}",fp.hardware_concurrency),
        format!("--fingerprint-device-memory={}",fp.device_memory),format!("--accept-lang={}",config.language)];
    if !fp.canvas_noise { flags.push("--disable-canvas-noise".into()); }
    if let Some(version)=config.identity.platform_version() { flags.push(format!("--fingerprint-platform-version={version}")); }
    if !config.timezone.is_empty() { flags.push(format!("--timezone={}",config.timezone)); }
    flags
}

struct Running {
    child: Arc<Mutex<Child>>,
    close: mpsc::Sender<Control>,
    _relay: Option<proxy::Relay>,
    _lease: fs::File,
    _kernel_lease: fs::File,
    _job: super::process::ProcessJob,
}
enum Control {
    Close,
    Cookies { cookies: Option<serde_json::Value>, reply: mpsc::Sender<PlatformResult<serde_json::Value>> },
}
#[derive(Default)]
pub struct BrowserState {
    pub kernel: Arc<KernelState>,
    pub operations: tokio::sync::Mutex<()>,
    running: Mutex<HashMap<String, Running>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    supported: bool,
    kernel: kernel::KernelStatus,
    kernels: Vec<kernel::KernelStatus>,
    environments: Vec<model::Environment>,
}
impl BrowserState {
    fn prune(&self) -> PlatformResult<()> {
        let mut running = self.running.lock().map_err(|_| error("浏览器运行状态不可用"))?;
        running.retain(|_, r| r.child.lock().map(|mut c| c.try_wait().ok().flatten().is_none()).unwrap_or(true));
        Ok(())
    }
    pub fn is_running(&self, id: &str) -> PlatformResult<bool> {
        self.prune()?;
        if self.running.lock().map_err(|_| error("浏览器运行状态不可用"))?.contains_key(id) { return Ok(true); }
        Ok(super::profile_in_use(id)? || super::process::is_orphan(id)?)
    }
    pub fn snapshot(&self) -> PlatformResult<Snapshot> {
        self.prune()?;
        let mut environments = model::list()?;
        let running = self.running.lock().map_err(|_| error("浏览器运行状态不可用"))?;
        for environment in &mut environments {
            let owned = running.contains_key(&environment.id);
            let elsewhere = super::profile_in_use(&environment.id)?;
            environment.recovery_required = !owned && !elsewhere && super::process::is_orphan(&environment.id)?;
            environment.running = owned || elsewhere || environment.recovery_required;
        }
        Ok(Snapshot { supported: super::supported(), kernel: kernel::status(&self.kernel,kernel::VERSION)?, kernels: kernel::catalog(&self.kernel)?, environments })
    }
    pub async fn launch(&self, id: &str) -> PlatformResult<()> {
        require_supported()?; validate_id(id)?;
        if self.is_running(id)? { return Err(error("该环境已打开")); }
        let environment = model::get(id)?;
        if environment.deleted_at.is_some() { return Err(error("请先从回收站恢复环境")); }
        model::validate(&environment.config)?;
        if !kernel::installed(&environment.config.kernel_version) { return Err(error("请先下载并安装浏览器内核")); }
        let kernel_lease = super::kernel_lease(false,&environment.config.kernel_version)?;
        kernel::prepare_for_launch(&environment.config.kernel_version)?;
        let config = environment.config;
        let relay = if config.proxy.kind != "direct" { Some(proxy::start(config.proxy.clone(), model::password(id)?).await?) } else { None };
        let dir = root()?.join("environments").join(id);
        fs::create_dir_all(&dir).map_err(|_| error("无法创建环境资料目录"))?;
        // Windows sharing lock also protects profiles from another CloudHub process.
        let lease = super::profile_lease(id)?;
        if super::process::is_orphan(id)? { return Err(error("请先关闭遗留浏览器，再重新打开此环境")); }
        // Set preferences only while stopped. Never modify Chromium's files while open.
        let default = dir.join("Default"); fs::create_dir_all(&default).map_err(|_| error("无法创建环境资料目录"))?;
        let preferences_path = default.join("Preferences");
        let mut preferences: serde_json::Value = if preferences_path.exists() {
            let bytes = fs::read(&preferences_path).map_err(|_| error("无法读取浏览器偏好设置"))?;
            if bytes.len() > 16 * 1024 * 1024 { return Err(error("浏览器偏好设置超过读取限制")); }
            serde_json::from_slice(&bytes).map_err(|_| error("浏览器偏好设置无效，未覆盖现有资料"))?
        } else { serde_json::json!({}) };
        if !preferences.is_object() { return Err(error("浏览器偏好设置无效")); }
        if !preferences["intl"].is_object() { preferences["intl"] = serde_json::json!({}); }
        preferences["intl"]["accept_languages"] = serde_json::json!(config.language);
        if !preferences["webrtc"].is_object() { preferences["webrtc"]=serde_json::json!({}); }
        preferences["webrtc"]["ip_handling_policy"]=serde_json::json!("disable_non_proxied_udp");
        // Chromium decides whether to persist session cookies and Local Storage
        // from the previous shutdown's bookkeeping. A profile left at
        // exit_type=Crashed (which is what any forced kill produces) makes the
        // next start a crash recovery: session cookies are dropped and the
        // environment appears to have lost its login. Only rewritten while the
        // environment is stopped, which is exactly the launch path.
        if !preferences["profile"].is_object() { preferences["profile"]=serde_json::json!({}); }
        preferences["profile"]["exit_type"]=serde_json::json!("Normal");
        preferences["profile"]["exited_cleanly"]=serde_json::json!(true);
        let temporary = default.join("CloudHubPreferences.tmp");
        fs::write(&temporary, serde_json::to_vec(&preferences).map_err(|_| error("浏览器偏好设置无效"))?).map_err(|_| error("无法保存浏览器偏好设置"))?;
        // Windows rename replaces files atomically via std's MoveFileEx implementation.
        fs::rename(&temporary, &preferences_path).map_err(|_| error("无法保存浏览器偏好设置，请确认环境已关闭"))?;
        let port_file = dir.join("DevToolsActivePort");
        if port_file.exists() { fs::remove_file(&port_file).map_err(|_| error("浏览器环境可能仍被占用"))?; }
        let mut command = Command::new(kernel::executable(&config.kernel_version)?);
        command.arg(format!("--user-data-dir={}", dir.display()))
            .args(["--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"])
            .args(network_flags(relay.as_ref().map(|relay|relay.port)))
            .args(fingerprint_flags(&config))
            .arg(format!("--lang={}",config.language)).arg(format!("--window-size={},{}", config.width, config.height));
        command.arg("about:blank").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        let mut child = command.spawn().map_err(|_| error("无法启动浏览器，请检查内核文件和系统权限"))?;
        let job = match super::process::ProcessJob::attach(&child) {
            Ok(job) => job,
            Err(error) => { let _=child.kill();let _=child.wait();return Err(error); }
        };
        if let Err(error) = super::process::record(id,&child,&config.kernel_version) { let _=child.kill();let _=child.wait();return Err(error); }
        let config_copy = config.clone();
        let initialization = tokio::task::spawn_blocking(move || -> PlatformResult<(Child, Connection)> {
            let result = (|| {
                let deadline = Instant::now() + Duration::from_secs(15);
                let (port, path) = loop {
                    if child.try_wait().map_err(|_| error("无法检查浏览器进程"))?.is_some() { return Err(error("浏览器启动后退出，环境可能被其他窗口占用")); }
                    if let Ok(text) = fs::read_to_string(&port_file) {
                        let mut lines = text.lines();
                        if let (Some(port), Some(path)) = (lines.next().and_then(|p| p.parse::<u16>().ok()), lines.next()) { break (port, path.to_string()); }
                    }
                    if Instant::now() >= deadline { return Err(error("浏览器启动超时")); }
                    std::thread::sleep(Duration::from_millis(100));
                };
                let mut cdp = Connection::connect(port, &path)?;
                cdp.initialize(&config_copy)?;
                Ok(cdp)
            })();
            match result { Ok(cdp) => Ok((child, cdp)), Err(e) => { let _ = child.kill(); let _ = child.wait(); Err(e) } }
        }).await.map_err(|_| error("浏览器启动任务失败"))?;
        let (child, mut cdp) = initialization?;
        let child = Arc::new(Mutex::new(child));
        let (close, receiver) = mpsc::channel();
        let worker_child = child.clone();
        std::thread::spawn(move || {
            loop {
                match receiver.recv_timeout(Duration::from_millis(500)) {
                    Ok(Control::Close) | Err(mpsc::RecvTimeoutError::Disconnected) => { cdp.close(); break; },
                    Ok(Control::Cookies { cookies, reply }) => {
                        let result = if let Some(cookies) = cookies { cdp.call("Storage.setCookies",serde_json::json!({"cookies":cookies}),None) }
                            else { cdp.call("Storage.getCookies",serde_json::json!({}),None) };
                        let _ = reply.send(result);
                    },
                    Err(mpsc::RecvTimeoutError::Timeout) => {},
                }
                if worker_child.lock().map(|mut c| c.try_wait().ok().flatten().is_some()).unwrap_or(true) { break; }
                if let Err(reason) = cdp.pump(&config) {
                    // Environment configuration must stay applied, so a browser that
                    // can no longer be configured is closed rather than left running.
                    // Record the reason first: silently killing here made a rejected
                    // CDP injection look identical to a browser crash.
                    eprintln!("[browser] 环境配置注入失败，已关闭内核: {}", reason.message);
                    // Close through CDP first: Browser.close lets Chromium write
                    // exit_type=Normal and flush cookies and Local Storage. Forcing
                    // the process down instead left the profile marked as crashed,
                    // which is what made stored logins vanish on the next launch.
                    cdp.close();
                    let deadline = Instant::now() + Duration::from_secs(5);
                    loop {
                        if worker_child.lock().map(|mut c| c.try_wait().ok().flatten().is_some()).unwrap_or(true) { break; }
                        if Instant::now() >= deadline {
                            if let Ok(mut child) = worker_child.lock() { let _ = child.kill(); let _ = child.wait(); }
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    break;
                }
            }
        });
        self.running.lock().map_err(|_| error("浏览器运行状态不可用"))?.insert(id.into(), Running { child, close, _relay: relay, _lease: lease, _kernel_lease: kernel_lease, _job: job });
        model::record_open(id)?;
        Ok(())
    }
    pub async fn stop(&self, id: &str) -> PlatformResult<()> {
        validate_id(id)?; self.prune()?;
        let child = {
            let running = self.running.lock().map_err(|_| error("浏览器运行状态不可用"))?;
            let Some(item) = running.get(id) else {
                if super::profile_in_use(id)? { return Err(error("该环境由其他 CloudHub 窗口打开，请在原窗口关闭")); }
                let _lease = super::profile_lease(id)?;
                return super::process::close_orphan(id);
            };
            let _ = item.close.send(Control::Close); item.child.clone()
        };
        tokio::task::spawn_blocking(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let mut child = child.lock().map_err(|_| error("浏览器运行状态不可用"))?;
                if child.try_wait().map_err(|_| error("无法检查浏览器进程"))?.is_some() { return Ok::<_,crate::core::error::PlatformError>(()); }
                if Instant::now() >= deadline {
                    // Graceful CDP close has already run; a still-running process here
                    // is unresponsive, so terminate it. This is the only forced kill
                    // on the normal stop path.
                    child.kill().map_err(|_| error("无法关闭浏览器，请关闭对应浏览器窗口"))?;
                    child.wait().map_err(|_| error("无法确认浏览器已关闭"))?;
                    return Ok(());
                }
                drop(child); std::thread::sleep(Duration::from_millis(100));
            }
        }).await.map_err(|_| error("浏览器关闭任务失败"))??;
        self.prune()?; Ok(())
    }
    pub async fn cookies(&self, id: &str, cookies: Option<serde_json::Value>) -> PlatformResult<serde_json::Value> {
        validate_id(id)?; self.prune()?;
        let receiver = {
            let running = self.running.lock().map_err(|_| error("浏览器运行状态不可用"))?;
            let item = running.get(id).ok_or(error("请先打开环境，再导入或导出 Cookie"))?;
            let (reply, receiver) = mpsc::channel();
            item.close.send(Control::Cookies { cookies, reply }).map_err(|_| error("浏览器控制通道已关闭"))?;
            receiver
        };
        tokio::task::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(15)).map_err(|_| error("Cookie 操作超时，请检查浏览器窗口")))
            .await.map_err(|_| error("Cookie 操作任务失败"))??
    }
    pub fn shutdown(&self) {
        self.kernel.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Ok(mut running) = self.running.lock() {
            for item in running.values() { let _ = item.close.send(Control::Close); }
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline && running.values().any(|r| r.child.lock().is_ok_and(|mut c| c.try_wait().ok().flatten().is_none())) {
                std::thread::sleep(Duration::from_millis(100));
            }
            for item in running.values() { if let Ok(mut c) = item.child.lock() { if c.try_wait().ok().flatten().is_none() { let _ = c.kill(); let _ = c.wait(); } } }
            running.clear();
        }
    }
}
impl Drop for BrowserState {
    fn drop(&mut self) {
        self.kernel.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Ok(running) = self.running.lock() { for item in running.values() { let _ = item.close.send(Control::Close); } }
    }
}
