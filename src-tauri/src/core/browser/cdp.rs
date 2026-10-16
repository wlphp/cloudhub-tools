//! Small, bounded CDP transport. No public debug port, arbitrary CDP commands or
//! provider diagnostics are exposed to the renderer. Only our own child is used.
use super::{error, model::EnvironmentConfig};
use crate::core::error::PlatformResult;
use base64::{Engine, engine::general_purpose::STANDARD};
use rand::RngCore;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::{collections::{HashMap, HashSet, VecDeque}, io::{Read, Write}, net::{SocketAddr, TcpStream}, time::Duration};

const MAX_MESSAGE: usize = 4 * 1024 * 1024;
pub struct Connection {
    stream: TcpStream,
    next: u64,
    events: VecDeque<Value>,
    identity: Option<Value>,
    probe_targets: HashSet<String>,
}
impl Connection {
    fn native_identity_metadata(&mut self) -> PlatformResult<Value> {
        // An internal browser page is a secure context. Read metadata there
        // before any user URL runs, never from an untrusted site's JavaScript.
        let target=self.call("Target.createTarget",json!({"url":"chrome://version","background":true}),None)?["targetId"]
            .as_str().ok_or(error("无法读取内核身份信息"))?.to_string();
        self.probe_targets.insert(target.clone());
        let result=(|| {
            let session=self.call("Target.attachToTarget",json!({"targetId":target,"flatten":true}),None)?["sessionId"]
                .as_str().ok_or(error("无法读取内核身份信息"))?.to_string();
            let deadline=std::time::Instant::now()+Duration::from_secs(3);
            loop {
                if let Ok(value)=self.call("Runtime.evaluate",json!({"expression":"navigator.userAgentData ? navigator.userAgentData.getHighEntropyValues(['fullVersionList','architecture','bitness','platformVersion','model','wow64']) : null","returnByValue":true,"awaitPromise":true}),Some(&session)) {
                    let metadata=&value["result"]["value"];
                    if metadata.is_object() && ["brands","fullVersionList"].iter().all(|field|metadata[field].as_array().is_some_and(|brands|!brands.is_empty() && brands.len()<=8 && brands.iter().all(|entry|
                        entry["brand"].as_str().is_some_and(|s|s.len()<=80 && !s.chars().any(char::is_control))
                        && entry["version"].as_str().is_some_and(|s|s.len()<=40 && !s.chars().any(char::is_control))))) {
                        return Ok(metadata.clone());
                    }
                }
                if std::time::Instant::now()>=deadline {return Err(error("当前内核不能提供完整的 Client Hints"));}
                std::thread::sleep(Duration::from_millis(50));
            }
        })();
        let closed=self.call("Target.closeTarget",json!({"targetId":target}),None);
        // Discard only the probe target's queued attach event; its session is
        // closed and must never enter the user-environment configuration loop.
        self.events.retain(|event|event["params"]["targetInfo"]["targetId"].as_str()!=Some(target.as_str()));
        match result {Ok(value)=>{if closed?["success"]!=true {return Err(error("无法关闭内核身份探测页"));}Ok(value)},Err(error)=>Err(error)}
    }
    pub fn connect(port: u16, path: &str) -> PlatformResult<Self> {
        if !path.starts_with("/devtools/browser/") || path.len() > 200 || !path.bytes().all(|b| b.is_ascii_alphanumeric() || b"/-".contains(&b)) {
            return Err(error("浏览器控制通道无效"));
        }
        let mut stream = TcpStream::connect_timeout(&SocketAddr::from(([127,0,0,1], port)), Duration::from_secs(3))
            .map_err(|_| error("无法连接浏览器控制通道"))?;
        stream.set_read_timeout(Some(Duration::from_secs(5))).map_err(|_| error("无法配置浏览器控制通道"))?;
        stream.set_write_timeout(Some(Duration::from_secs(5))).map_err(|_| error("无法配置浏览器控制通道"))?;
        let mut random = [0u8; 16]; rand::thread_rng().fill_bytes(&mut random);
        let key = STANDARD.encode(random);
        let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n");
        stream.write_all(request.as_bytes()).map_err(|_| error("浏览器控制通道握手失败"))?;
        let mut response = Vec::new(); let mut byte = [0];
        while !response.ends_with(b"\r\n\r\n") {
            if response.len() > 8192 { return Err(error("浏览器控制通道握手无效")); }
            stream.read_exact(&mut byte).map_err(|_| error("浏览器控制通道握手失败"))?; response.push(byte[0]);
        }
        let expected = STANDARD.encode(Sha1::digest(format!("{key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11").as_bytes()));
        let text = String::from_utf8_lossy(&response);
        if !text.starts_with("HTTP/1.1 101 ") || !text.lines().any(|line| line.split_once(':').is_some_and(|(h,v)| h.eq_ignore_ascii_case("Sec-WebSocket-Accept") && v.trim() == expected)) {
            return Err(error("浏览器控制通道校验失败"));
        }
        Ok(Self { stream, next: 0, events: VecDeque::new(), identity: None, probe_targets: HashSet::new() })
    }
    fn send_frame(&mut self, opcode: u8, payload: &[u8]) -> PlatformResult<()> {
        let mut bytes = vec![0x80 | opcode];
        if payload.len() < 126 { bytes.push(0x80 | payload.len() as u8); }
        else if payload.len() <= 65535 { bytes.push(0x80 | 126); bytes.extend_from_slice(&(payload.len() as u16).to_be_bytes()); }
        else { bytes.push(0x80 | 127); bytes.extend_from_slice(&(payload.len() as u64).to_be_bytes()); }
        let mut mask = [0u8; 4]; rand::thread_rng().fill_bytes(&mut mask); bytes.extend_from_slice(&mask);
        bytes.extend(payload.iter().enumerate().map(|(i,b)| b ^ mask[i % 4]));
        self.stream.write_all(&bytes).map_err(|_| error("浏览器控制通道已断开"))
    }
    fn read_message(&mut self) -> PlatformResult<Value> {
        let mut data = Vec::new();
        loop {
            let mut head = [0u8; 2]; self.stream.read_exact(&mut head).map_err(|_| error("浏览器控制响应超时或已断开"))?;
            let opcode = head[0] & 15;
            if head[0] & 0x70 != 0 || head[1] & 0x80 != 0 { return Err(error("浏览器控制帧无效")); }
            let mut length = (head[1] & 127) as u64;
            if length == 126 { let mut b = [0u8; 2]; self.stream.read_exact(&mut b).map_err(|_| error("浏览器控制帧不完整"))?; length = u16::from_be_bytes(b) as u64; }
            else if length == 127 { let mut b = [0u8; 8]; self.stream.read_exact(&mut b).map_err(|_| error("浏览器控制帧不完整"))?; length = u64::from_be_bytes(b); }
            if length > MAX_MESSAGE as u64 || data.len() as u64 + length > MAX_MESSAGE as u64 { return Err(error("浏览器控制响应超过限制")); }
            let mut payload = vec![0; length as usize]; self.stream.read_exact(&mut payload).map_err(|_| error("浏览器控制帧不完整"))?;
            match opcode {
                8 => return Err(error("浏览器已关闭")),
                9 => { self.send_frame(10, &payload)?; continue; },
                10 => continue,
                1 if data.is_empty() => {},
                0 if !data.is_empty() => {},
                _ => return Err(error("浏览器控制帧类型无效")),
            }
            data.extend_from_slice(&payload);
            if head[0] & 0x80 != 0 { return serde_json::from_slice(&data).map_err(|_| error("浏览器控制响应无效")); }
        }
    }
    pub fn call(&mut self, method: &str, params: Value, session: Option<&str>) -> PlatformResult<Value> {
        self.next += 1; let id = self.next;
        let mut request = json!({"id":id,"method":method,"params":params});
        if let Some(session) = session { request["sessionId"] = json!(session); }
        self.send_frame(1, &serde_json::to_vec(&request).map_err(|_| error("浏览器控制参数无效"))?)?;
        for _ in 0..4096 {
            let value = self.read_message()?;
            if value["id"].as_u64() == Some(id) {
                if value.get("error").is_some() {
                    // ICU overrides are renderer-wide. Another attached frame
                    // in this same immutable environment may already own them.
                    // Accept only Chromium's exact already-applied responses;
                    // invalid configuration and every other error still fail.
                    let already_applied = value["error"]["code"] == -32000 && matches!(
                        (method,value["error"]["message"].as_str()),
                        ("Emulation.setLocaleOverride",Some("Another locale override is already in effect"))
                        | ("Emulation.setTimezoneOverride",Some("Timezone override is already in effect"))
                    );
                    if already_applied { return Ok(json!({})); }
                    return Err(error("浏览器不支持此环境配置，请检查时区和内核版本"));
                }
                return Ok(value["result"].clone());
            }
            if self.events.len() > 4096 { return Err(error("浏览器控制事件过多")); }
            if value.get("method").is_some() { self.events.push_back(value); }
        }
        Err(error("浏览器控制响应超时"))
    }
    fn configure_events(&mut self, config: &EnvironmentConfig, urls: &mut HashMap<String, String>) -> PlatformResult<()> {
        while let Some(event) = self.events.pop_front() {
            if event["method"] != "Target.attachedToTarget" { continue; }
            if event["params"]["targetInfo"]["targetId"].as_str().is_some_and(|id|self.probe_targets.contains(id)) {continue;}
            let Some(session) = event["params"]["sessionId"].as_str() else { continue; };
            let kind = event["params"]["targetInfo"]["type"].as_str().unwrap_or("");
            if matches!(kind,"page"|"iframe"|"worker"|"shared_worker"|"service_worker") {
                if let Some(identity)=self.identity.clone() { self.call("Emulation.setUserAgentOverride",identity,Some(session))?; }
            }
            if matches!(kind, "page" | "iframe") {
                if !config.timezone.is_empty() { self.call("Emulation.setTimezoneOverride", json!({"timezoneId":config.timezone}), Some(session))?; }
                self.call("Emulation.setLocaleOverride", json!({"locale":config.language}), Some(session))?;
                let geolocation = config.geolocation.as_ref().map(|p| json!({"latitude":p.latitude,"longitude":p.longitude,"accuracy":p.accuracy})).unwrap_or(json!({}));
                self.call("Emulation.setGeolocationOverride", geolocation, Some(session))?;
                self.call("Target.setAutoAttach", json!({"autoAttach":true,"waitForDebuggerOnStart":true,"flatten":true}), Some(session))?;
            }
            self.call("Runtime.runIfWaitingForDebugger", json!({}), Some(session))?;
            if let Some(target) = event["params"]["targetInfo"]["targetId"].as_str() {
                if let Some(url) = urls.remove(target) { self.call("Page.navigate", json!({"url":url}), Some(session))?; }
            }
        }
        Ok(())
    }
    pub fn initialize(&mut self, config: &EnvironmentConfig) -> PlatformResult<()> {
        if let Some(platform_version)=config.identity.platform_version() {
            let version=self.call("Browser.getVersion",json!({}),None)?;
            let ua=version["userAgent"].as_str().filter(|value| value.len()<=1024 && value.contains("Windows NT 10.0") && !value.chars().any(char::is_control))
                .ok_or(error("当前内核不支持 Windows 身份模板"))?;
            let mut metadata=self.native_identity_metadata()?;
            metadata["platform"]=json!("Windows");metadata["platformVersion"]=json!(platform_version);
            metadata["architecture"]=json!("x86");metadata["bitness"]=json!("64");metadata["model"]=json!("");metadata["mobile"]=json!(false);metadata["wow64"]=json!(false);
            // Workers do not fill omitted brand lists as pages do. Send the
            // same complete native metadata to every context, preserving native-reported
            // browser versions and GREASE values.
            self.identity=Some(json!({"userAgent":ua,"platform":"Win32","acceptLanguage":config.language,
                "userAgentMetadata":metadata}));
        }
        self.call("Browser.setPermission",json!({"permission":{"name":"geolocation"},"setting":if config.geolocation.is_some() { "prompt" } else { "denied" }}),None)?;
        self.call("Target.setAutoAttach", json!({"autoAttach":true,"waitForDebuggerOnStart":true,"flatten":true}), None)?;
        let mut urls = HashMap::new();
        self.configure_events(config, &mut urls)?;
        for url in &config.start_urls {
            let result = self.call("Target.createTarget", json!({"url":"about:blank"}), None)?;
            if let Some(id) = result["targetId"].as_str() { urls.insert(id.to_string(), url.clone()); }
            self.configure_events(config, &mut urls)?;
        }
        // Drain any delayed attached events using a harmless command as a barrier.
        self.call("Target.getTargets", json!({}), None)?;
        self.configure_events(config, &mut urls)?;
        Ok(())
    }
    pub fn pump(&mut self, config: &EnvironmentConfig) -> PlatformResult<()> {
        self.call("Target.getTargets", json!({}), None)?;
        self.configure_events(config, &mut HashMap::new())
    }
    pub fn close(&mut self) { let _ = self.call("Browser.close", json!({}), None); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::{Path, PathBuf}, process::{Child,Command,Stdio}, time::Instant};
    struct Browser { child: Child, connection: Connection, evaluation_session: Option<String> }
    impl Drop for Browser { fn drop(&mut self) { self.connection.close(); let _ = self.child.kill(); let _ = self.child.wait(); } }
    fn launch(executable: &Path, dir: &Path) -> Browser {
        launch_with_flags(executable,dir,super::super::runtime::network_flags(None))
    }
    fn launch_with_flags(executable: &Path, dir: &Path, flags: Vec<String>) -> Browser {
        fs::create_dir_all(dir.join("Default")).unwrap();
        fs::write(dir.join("Default/Preferences"), r#"{"intl":{"accept_languages":"en-US"}}"#).unwrap();
        let _ = fs::remove_file(dir.join("DevToolsActivePort"));
        let mut child = Command::new(executable).arg(format!("--user-data-dir={}",dir.display()))
            // Exercise the same sandbox policy as production, including Job ownership.
            .args(["--headless=new","--no-first-run","--no-default-browser-check","--remote-debugging-port=0","--remote-debugging-address=127.0.0.1","--disable-background-networking","--lang=en-US"])
            .args(flags)
            .arg("about:blank")
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        let text = loop {
            if let Ok(text) = fs::read_to_string(dir.join("DevToolsActivePort")) { if text.lines().count() >= 2 { break text; } }
            if Instant::now() > deadline || child.try_wait().unwrap().is_some() { let _ = child.kill(); panic!("test browser startup failed"); }
            std::thread::sleep(Duration::from_millis(100));
        };
        let mut lines = text.lines();
        let connection = Connection::connect(lines.next().unwrap().parse().unwrap(),lines.next().unwrap()).unwrap();
        Browser { child, connection, evaluation_session: None }
    }
    fn config() -> EnvironmentConfig {
        EnvironmentConfig { name:"native test".into(), group:String::new(), tags:String::new(),note:String::new(),kernel_version:super::super::kernel::VERSION.into(),start_urls:vec![],proxy:super::super::model::ProxyConfig { kind:"direct".into(),host:String::new(),port:0,username:String::new() },language:"en-US".into(),timezone:"America/New_York".into(),width:1280,height:900,geolocation:None,fingerprint:None,identity:super::super::model::BrowserIdentity::Native }
    }
    fn evaluate(browser: &mut Browser, expression: &str) -> Value {
        let session=if let Some(session)=&browser.evaluation_session {session.clone()} else {
        let targets = browser.connection.call("Target.getTargets",json!({}),None).unwrap();
        let target = targets["targetInfos"].as_array().unwrap().iter().find(|t| t["type"] == "page").unwrap()["targetId"].as_str().unwrap();
        let session = browser.connection.call("Target.attachToTarget",json!({"targetId":target,"flatten":true}),None).unwrap()["sessionId"].as_str().unwrap().to_string();
        browser.evaluation_session=Some(session.clone());session
        };
        browser.connection.call("Runtime.evaluate",json!({"expression":expression,"returnByValue":true,"awaitPromise":true}),Some(&session)).unwrap()["result"]["value"].clone()
    }
    #[tokio::test(flavor="multi_thread",worker_threads=2)]
    #[ignore = "Requires both reviewed browser executables"]
    async fn windows_templates_keep_page_worker_and_request_client_hints_consistent() {
        use tokio::io::{AsyncReadExt,AsyncWriteExt};
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port=listener.local_addr().unwrap().port();let url=format!("http://127.0.0.1:{port}/");
        let server=tokio::spawn(async move {loop {
            let Ok((mut stream,_))=listener.accept().await else {break;};
            tokio::spawn(async move {
                let mut bytes=Vec::new();let mut chunk=[0u8;2048];
                while bytes.len()<8192 && !bytes.ends_with(b"\r\n\r\n") {
                    let Ok(n)=stream.read(&mut chunk).await else {return;};if n==0{return;}bytes.extend_from_slice(&chunk[..n]);
                }
                let request=String::from_utf8_lossy(&bytes);let path=request.lines().next().unwrap_or("");
                let headers:serde_json::Map<String,Value>=request.lines().skip(1).filter_map(|line|line.split_once(':').map(|(k,v)|(k.to_ascii_lowercase(),json!(v.trim())))).collect();
                let (kind,body)=if path.starts_with("GET /headers ") {("application/json",serde_json::to_string(&headers).unwrap())}
                else if path.starts_with("GET /worker.js ") {("application/javascript",r#"(async()=>{const metadata=await navigator.userAgentData.getHighEntropyValues(['platformVersion','fullVersionList','architecture','bitness']);const headers=await(await fetch('/headers')).json();postMessage({metadata,ua:navigator.userAgent,headers})})()"#.to_string())}
                else if path.starts_with("GET /frame ") {("text/html",r#"<!doctype html><script>(async()=>{const metadata=await navigator.userAgentData.getHighEntropyValues(['platformVersion','fullVersionList','architecture','bitness']);const headers=await(await fetch('/headers')).json();parent.postMessage({metadata,ua:navigator.userAgent,headers},new URL(document.referrer).origin)})()</script>"#.to_string())}
                else {("text/html","<!doctype html><title>identity-test</title>".into())};
                let response=format!("HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nAccept-CH: Sec-CH-UA-Platform-Version, Sec-CH-UA-Full-Version-List\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                let _=stream.write_all(response.as_bytes()).await;
            });
        }});
        let root=std::env::temp_dir().join(format!("cloudhub-identity-consistency-{}",uuid::Uuid::new_v4()));
        for (variable,kernel,full_version) in [("CLOUDHUB_BROWSER_TEST_EXE",super::super::kernel::VERSION,"155.0.8059.84"),("CLOUDHUB_BROWSER_FINGERPRINT_TEST_EXE",super::super::kernel::EXPERIMENTAL_VERSION,"150.0.7871.115")] {
            for (identity,platform_version) in [(super::super::model::BrowserIdentity::Windows10,"10.0.0"),(super::super::model::BrowserIdentity::Windows11,"19.0.0")] {
                let executable=PathBuf::from(std::env::var_os(variable).expect("set reviewed browser paths"));
                let mut config=config();config.kernel_version=kernel.into();config.identity=identity;
                if super::super::kernel::experimental(kernel) {config.fingerprint=Some(super::super::model::Fingerprint {seed:172904001,canvas_noise:true,hardware_concurrency:4,device_memory:8});}
                let mut flags=super::super::runtime::network_flags(None);flags.extend(super::super::runtime::fingerprint_flags(&config));
                let mut browser=launch_with_flags(&executable,&root.join(format!("{kernel}-{platform_version}")),flags);
                browser.connection.initialize(&config).unwrap();
                evaluate(&mut browser,&format!("location.href={};true",serde_json::to_string(&url).unwrap()));
                let deadline=Instant::now()+Duration::from_secs(5);
                while evaluate(&mut browser,"document.title")!="identity-test" {assert!(Instant::now()<deadline);std::thread::sleep(Duration::from_millis(50));}
                let metadata=evaluate(&mut browser,"navigator.userAgentData.getHighEntropyValues(['platformVersion','fullVersionList','architecture','bitness'])");
                assert_eq!(metadata["platformVersion"],platform_version);assert_eq!(metadata["platform"],"Windows");assert_eq!(metadata["bitness"],"64");
                assert!(metadata["fullVersionList"].as_array().unwrap().iter().any(|brand|brand["version"]==full_version));
                let ua=evaluate(&mut browser,"navigator.userAgent");
                let headers=evaluate(&mut browser,"fetch('/headers').then(r=>r.json())");
                assert_eq!(headers["user-agent"],ua);assert_eq!(headers["sec-ch-ua-platform-version"],format!("\"{platform_version}\""));
                assert!(headers["sec-ch-ua-full-version-list"].as_str().unwrap().contains(full_version));
                evaluate(&mut browser,"globalThis.identityWorkerResult=null;globalThis.identityWorker=new Worker('/worker.js');identityWorker.onmessage=e=>{globalThis.identityWorkerResult=e.data;identityWorker.terminate()};true");
                let deadline=Instant::now()+Duration::from_secs(10);
                let worker=loop {
                    browser.connection.pump(&config).unwrap();let result=evaluate(&mut browser,"globalThis.identityWorkerResult");
                    if !result.is_null(){break result;}assert!(Instant::now()<deadline,"worker identity sample did not arrive");std::thread::sleep(Duration::from_millis(50));
                };
                assert_eq!(worker["metadata"],metadata);assert_eq!(worker["ua"],ua);assert_eq!(worker["headers"]["user-agent"],ua);
                // Native Chromium also omits Client Hints on worker fetches.
                // Do not inject extra headers; any present hint must agree.
                if !worker["headers"]["sec-ch-ua-platform-version"].is_null() {assert_eq!(worker["headers"]["sec-ch-ua-platform-version"],headers["sec-ch-ua-platform-version"]);}
                evaluate(&mut browser,&format!("globalThis.identityFrameResult=null;const origin={};globalThis.identityFrame=document.createElement('iframe');addEventListener('message',e=>{{if(e.origin===origin && e.source===identityFrame.contentWindow)globalThis.identityFrameResult=e.data}});identityFrame.src=origin+'/frame';document.body.appendChild(identityFrame);true",serde_json::to_string(&format!("http://localhost:{port}")).unwrap()));
                let deadline=Instant::now()+Duration::from_secs(10);
                let frame=loop {
                    browser.connection.pump(&config).unwrap();let result=evaluate(&mut browser,"globalThis.identityFrameResult");
                    if !result.is_null(){break result;}assert!(Instant::now()<deadline,"cross-site frame identity sample did not arrive");std::thread::sleep(Duration::from_millis(50));
                };
                assert_eq!(frame["metadata"],metadata);assert_eq!(frame["ua"],ua);assert_eq!(frame["headers"]["user-agent"],ua);
                // Cross-site high-entropy hints also depend on delegation by
                // Permissions-Policy. Their absence is native privacy behavior.
                if !frame["headers"]["sec-ch-ua-platform-version"].is_null() {assert_eq!(frame["headers"]["sec-ch-ua-platform-version"],headers["sec-ch-ua-platform-version"]);}
            }
        }
        server.abort();fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test(flavor="multi_thread",worker_threads=2)]
    #[ignore = "Requires CLOUDHUB_BROWSER_FINGERPRINT_TEST_EXE pointing to the pinned experimental browser"]
    async fn experimental_browser_uses_persisted_seed_and_native_hardware_flags() {
        use tokio::io::{AsyncReadExt,AsyncWriteExt};
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url=format!("http://127.0.0.1:{}/",listener.local_addr().unwrap().port());
        let server=tokio::spawn(async move {loop {
            let Ok((mut stream,_))=listener.accept().await else {break;};
            tokio::spawn(async move {
                let mut request=[0u8;4096];let _=stream.read(&mut request).await;
                let body="<!doctype html><title>fingerprint-test</title>";
                let response=format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                let _=stream.write_all(response.as_bytes()).await;
            });
        }});
        let executable=PathBuf::from(std::env::var_os("CLOUDHUB_BROWSER_FINGERPRINT_TEST_EXE").expect("set experimental browser path"));
        let root=std::env::temp_dir().join(format!("cloudhub-fingerprint-native-{}",uuid::Uuid::new_v4()));
        let mut canvases=Vec::new();
        for (index,seed,noise) in [(0,172904001,true),(1,172904001,true),(2,172904099,true),(3,172904001,false),(4,172904099,false)] {
            let mut config=config();
            config.kernel_version=super::super::kernel::EXPERIMENTAL_VERSION.into();
            config.fingerprint=Some(super::super::model::Fingerprint {seed,canvas_noise:noise,hardware_concurrency:4,device_memory:8});
            super::super::model::validate(&config).unwrap();
            let mut flags=super::super::runtime::network_flags(None);
            flags.extend(super::super::runtime::fingerprint_flags(&config));
            let mut browser=launch_with_flags(&executable,&root.join(index.to_string()),flags);
            browser.connection.initialize(&config).unwrap();
            let targets=browser.connection.call("Target.getTargets",json!({}),None).unwrap();
            let target=targets["targetInfos"].as_array().unwrap().iter().find(|t|t["type"]=="page").unwrap()["targetId"].as_str().unwrap();
            let session=browser.connection.call("Target.attachToTarget",json!({"targetId":target,"flatten":true}),None).unwrap()["sessionId"].as_str().unwrap().to_string();
            browser.connection.call("Page.navigate",json!({"url":url}),Some(&session)).unwrap();
            let deadline=Instant::now()+Duration::from_secs(5);
            while evaluate(&mut browser,"document.title") != "fingerprint-test" {
                assert!(Instant::now()<deadline);std::thread::sleep(Duration::from_millis(50));
            }
            assert_eq!(evaluate(&mut browser,"[navigator.hardwareConcurrency,navigator.deviceMemory,navigator.language,Intl.DateTimeFormat().resolvedOptions().timeZone]"),json!([4,8,"en-US","America/New_York"]));
            let canvas=evaluate(&mut browser,r#"(()=>{const c=document.createElement('canvas');c.width=240;c.height=80;const x=c.getContext('2d');x.fillStyle='#159';x.fillRect(0,0,240,80);x.font='18px Arial';x.fillStyle='#e63';x.fillText('CloudHub sample Ω 0123',7,35);return c.toDataURL()})()"#);
            assert!(canvas.as_str().is_some_and(|value|value.starts_with("data:image/png;base64,")));
            canvases.push(canvas);
        }
        assert_eq!(canvases[0],canvases[1]);
        assert_ne!(canvases[0],canvases[2]);
        assert_eq!(canvases[3],canvases[4]);
        assert_ne!(canvases[0],canvases[3]);
        server.abort();fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[ignore = "Requires CLOUDHUB_BROWSER_TEST_EXE pointing to the verified test browser"]
    fn actual_browser_applies_timezone_and_keeps_profiles_isolated() {
        let executable = PathBuf::from(std::env::var_os("CLOUDHUB_BROWSER_TEST_EXE").expect("set browser path"));
        let root = std::env::temp_dir().join(format!("cloudhub-cdp-test-{}",uuid::Uuid::new_v4()));
        {
            let mut a = launch(&executable, &root.join("a"));
            a.connection.initialize(&config()).unwrap();
            assert_eq!(evaluate(&mut a,"Intl.DateTimeFormat().resolvedOptions().timeZone"),json!("America/New_York"));
            assert_eq!(evaluate(&mut a,"navigator.language"),json!("en-US"));
            evaluate(&mut a,r#"globalThis.cloudhubWorkerProbe=new Promise((resolve,reject)=>{const url=URL.createObjectURL(new Blob(["postMessage([navigator.language,Intl.DateTimeFormat().resolvedOptions().timeZone])"],{type:'application/javascript'}));const w=new Worker(url);const timer=setTimeout(()=>{w.terminate();URL.revokeObjectURL(url);reject('worker timeout')},10000);w.onmessage=e=>{clearTimeout(timer);w.terminate();URL.revokeObjectURL(url);resolve(e.data)}});globalThis.cloudhubWorkerProbe.then(v=>globalThis.cloudhubWorkerProbeResult=v,e=>globalThis.cloudhubWorkerProbeResult=String(e));true"#);
            // Runtime.pump resumes newly attached workers before they execute.
            // Keep pumping while the worker attach event arrives; waiting for
            // the promise inside a CDP call would leave that worker paused.
            let deadline=Instant::now()+Duration::from_secs(5);
            let worker=loop {
                a.connection.pump(&config()).unwrap();
                let value=evaluate(&mut a,"globalThis.cloudhubWorkerProbeResult ?? null");
                if !value.is_null() {break value;}
                assert!(Instant::now()<deadline,"worker result did not arrive");
                std::thread::sleep(Duration::from_millis(50));
            };
            assert_eq!(worker,json!(["en-US","America/New_York"]));
            assert_eq!(evaluate(&mut a,"navigator.permissions.query({name:'geolocation'}).then(p=>p.state)"),json!("denied"));
            a.connection.call("Storage.setCookies",json!({"cookies":[{"name":"cloudhub-test","value":"profile-a","url":"https://example.test","expires":4102444800i64}]}),None).unwrap();
            let mut b = launch(&executable, &root.join("b"));
            b.connection.initialize(&config()).unwrap();
            assert!(b.connection.call("Storage.getCookies",json!({}),None).unwrap()["cookies"].as_array().unwrap().is_empty());
            assert_eq!(a.connection.call("Storage.getCookies",json!({}),None).unwrap()["cookies"][0]["value"],json!("profile-a"));
            a.connection.close();
            let deadline = Instant::now() + Duration::from_secs(10);
            while a.child.try_wait().unwrap().is_none() { assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(100)); }
        }
        {
            let mut reopened = launch(&executable,&root.join("a"));
            reopened.connection.initialize(&config()).unwrap();
            assert_eq!(reopened.connection.call("Storage.getCookies",json!({}),None).unwrap()["cookies"][0]["value"],json!("profile-a"));
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "Requires CLOUDHUB_BROWSER_TEST_EXE pointing to the verified test browser"]
    fn process_job_closes_browser_when_owner_disappears() {
        let executable=PathBuf::from(std::env::var_os("CLOUDHUB_BROWSER_TEST_EXE").expect("set browser path"));
        let root=std::env::temp_dir().join(format!("cloudhub-job-test-{}",uuid::Uuid::new_v4()));
        let mut browser=launch(&executable,&root);
        let job=super::super::process::ProcessJob::attach(&browser.child).unwrap();
        drop(job);
        let deadline=Instant::now()+Duration::from_secs(5);
        while browser.child.try_wait().unwrap().is_none() { assert!(Instant::now()<deadline);std::thread::sleep(Duration::from_millis(50)); }
        drop(browser);
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test(flavor="multi_thread",worker_threads=4)]
    #[ignore = "Requires CLOUDHUB_BROWSER_TEST_EXE pointing to the verified test browser"]
    async fn actual_browser_routes_loopback_through_proxy_and_does_not_fall_back() {
        use tokio::{net::TcpListener,io::{AsyncReadExt,AsyncWriteExt}};
        use std::sync::{Arc,Mutex,atomic::{AtomicUsize,Ordering}};
        let direct=TcpListener::bind("127.0.0.1:0").await.unwrap();let direct_port=direct.local_addr().unwrap().port();
        let direct_hits=Arc::new(AtomicUsize::new(0));let direct_count=direct_hits.clone();
        let direct_task=tokio::spawn(async move {loop {let Ok((mut stream,_))=direct.accept().await else{break;};direct_count.fetch_add(1,Ordering::SeqCst);let _=stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;}});
        let direct6=TcpListener::bind("[::1]:0").await.expect("IPv6 loopback is required for this explicit native test");
        let ipv6_port=direct6.local_addr().unwrap().port();let count6=direct_hits.clone();
        let direct6_task=tokio::spawn(async move {loop {let Ok((mut stream,_))=direct6.accept().await else {break;};count6.fetch_add(1,Ordering::SeqCst);let _=stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;}});
        let stun=tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();let stun_port=stun.local_addr().unwrap().port();
        let stun_hits=Arc::new(AtomicUsize::new(0));let stun_count=stun_hits.clone();
        let stun_task=tokio::spawn(async move {let mut bytes=[0u8;2048];while stun.recv_from(&mut bytes).await.is_ok(){stun_count.fetch_add(1,Ordering::SeqCst);}});
        let upstream=TcpListener::bind("127.0.0.1:0").await.unwrap();let upstream_port=upstream.local_addr().unwrap().port();
        let proxy_hits=Arc::new(AtomicUsize::new(0));let proxy_count=proxy_hits.clone();
        let proxy_targets=Arc::new(Mutex::new(Vec::<String>::new()));let target_log=proxy_targets.clone();
        let proxy_task=tokio::spawn(async move {loop {
            let Ok((mut stream,_))=upstream.accept().await else{break;};let proxy_count=proxy_count.clone();let target_log=target_log.clone();
            tokio::spawn(async move {
                let mut request=Vec::new();while !request.ends_with(b"\r\n\r\n") && request.len()<65536 {let Ok(byte)=stream.read_u8().await else{return;};request.push(byte);}
                if String::from_utf8_lossy(&request).starts_with("GET http://127.0.0.1:") {proxy_count.fetch_add(1,Ordering::SeqCst);}
                target_log.lock().unwrap().push(String::from_utf8_lossy(&request).lines().next().unwrap_or("").to_string());
                let body="<html><head><title>proxied-only</title></head><body>proxy</body></html>";
                let response=format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());let _=stream.write_all(response.as_bytes()).await;
            });
        }});
        for variable in ["CLOUDHUB_BROWSER_TEST_EXE","CLOUDHUB_BROWSER_FINGERPRINT_TEST_EXE"] {
        let relay=super::super::proxy::start(super::super::model::ProxyConfig {kind:"http".into(),host:"127.0.0.1".into(),port:upstream_port,username:String::new()},None).await.unwrap();
        let executable=PathBuf::from(std::env::var_os(variable).expect("set both reviewed browser paths"));
        let root=std::env::temp_dir().join(format!("cloudhub-routing-test-{}",uuid::Uuid::new_v4()));
        let mut environment=config();environment.geolocation=Some(super::super::model::Geolocation {latitude:0.0,longitude:0.0,accuracy:25.0});
        if variable=="CLOUDHUB_BROWSER_FINGERPRINT_TEST_EXE" {
            environment.kernel_version=super::super::kernel::EXPERIMENTAL_VERSION.into();
            environment.fingerprint=Some(super::super::model::Fingerprint {seed:172904001,canvas_noise:true,hardware_concurrency:4,device_memory:8});
        }
        let mut flags=super::super::runtime::network_flags(Some(relay.port));flags.extend(super::super::runtime::fingerprint_flags(&environment));
        let mut browser=launch_with_flags(&executable,&root,flags);
        browser.connection.initialize(&environment).unwrap();
        let targets=browser.connection.call("Target.getTargets",json!({}),None).unwrap();
        let target=targets["targetInfos"].as_array().unwrap().iter().find(|t|t["type"]=="page").unwrap()["targetId"].as_str().unwrap();
        let session=browser.connection.call("Target.attachToTarget",json!({"targetId":target,"flatten":true}),None).unwrap()["sessionId"].as_str().unwrap().to_string();
        let url=format!("http://127.0.0.1:{direct_port}/route-test");
        let navigation=browser.connection.call("Page.navigate",json!({"url":url}),Some(&session)).unwrap();assert!(navigation.get("errorText").is_none(),"Navigation failed: {}",navigation["errorText"]);
        let deadline=Instant::now()+Duration::from_secs(5);
        loop {
            let result=browser.connection.call("Runtime.evaluate",json!({"expression":"document.title","returnByValue":true}),Some(&session)).unwrap();
            if result["result"]["value"]=="proxied-only" {break;}
            assert!(Instant::now()<deadline);std::thread::sleep(Duration::from_millis(50));
        }
        assert!(proxy_hits.load(Ordering::SeqCst)>0);assert_eq!(direct_hits.load(Ordering::SeqCst),0);
        // The test grants the prompt explicitly; production always asks the website's user.
        browser.connection.call("Browser.setPermission",json!({"permission":{"name":"geolocation"},"setting":"granted"}),None).unwrap();
        let location=browser.connection.call("Runtime.evaluate",json!({"expression":"new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(p=>resolve([p.coords.latitude,p.coords.longitude,p.coords.accuracy]),()=>reject('location unavailable')))","returnByValue":true,"awaitPromise":true}),Some(&session)).unwrap();
        assert_eq!(location["result"]["value"],json!([0,0,25]));
        let ice_script=format!("new Promise(async resolve=>{{const p=new RTCPeerConnection({{iceServers:[{{urls:'stun:127.0.0.1:{stun_port}'}}]}});const c=[];p.onicecandidate=e=>{{if(e.candidate)c.push(e.candidate.candidate);else{{p.close();resolve(c)}}}};p.createDataChannel('test');await p.setLocalDescription(await p.createOffer());setTimeout(()=>{{p.close();resolve(c)}},1200)}})");
        let ice=browser.connection.call("Runtime.evaluate",json!({"expression":ice_script,"returnByValue":true,"awaitPromise":true}),Some(&session)).unwrap();
        assert!(ice["result"]["value"].as_array().unwrap().is_empty(),"Non-proxied ICE candidates unexpectedly exposed");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(stun_hits.load(Ordering::SeqCst),0,"WebRTC sent non-proxied UDP to the STUN listener");
        let extra_urls=[format!("http://[::1]:{ipv6_port}/ipv6-test"),format!("http://cloudhub-no-dns.invalid:{direct_port}/dns-test")];
        for extra in &extra_urls {
            let navigation=browser.connection.call("Page.navigate",json!({"url":extra}),Some(&session)).unwrap();
            assert!(navigation.get("errorText").is_none(),"Expected upstream proxy navigation");
            let deadline=Instant::now()+Duration::from_secs(5);
            while !proxy_targets.lock().unwrap().iter().any(|line|line.starts_with(&format!("GET {extra} "))) {
                assert!(Instant::now()<deadline,"Destination was not received by the upstream proxy");std::thread::sleep(Duration::from_millis(50));
            }
            assert_eq!(direct_hits.load(Ordering::SeqCst),0);
        }
        drop(relay);tokio::time::sleep(Duration::from_millis(100)).await;
        let navigation=browser.connection.call("Page.navigate",json!({"url":format!("{url}?after-stop=1")}),Some(&session)).unwrap();
        assert!(navigation["errorText"].as_str().is_some_and(|s|s.contains("PROXY")));assert_eq!(direct_hits.load(Ordering::SeqCst),0);
        for extra in extra_urls {
            let failed=browser.connection.call("Page.navigate",json!({"url":extra}),Some(&session)).unwrap();
            assert!(failed["errorText"].as_str().is_some_and(|s|s.contains("PROXY")));
        }
        assert_eq!(direct_hits.load(Ordering::SeqCst),0);
        drop(browser);fs::remove_dir_all(root).unwrap();
        }
        proxy_task.abort();direct_task.abort();direct6_task.abort();stun_task.abort();
    }
}
