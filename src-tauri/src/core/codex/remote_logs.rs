use super::gateway_controls::CallDetail;
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::VecDeque, sync::{Mutex, OnceLock}, time::Instant};
use zeroize::Zeroizing;
use rusqlite::{Connection, OptionalExtension};

const ENABLED_KEY: &str = "codex.remote_logs.enabled";
fn load_enabled(conn: &Connection) -> Result<bool, String> {
    let value: Option<String> = conn.query_row("SELECT value FROM client_preferences WHERE key=?1", [ENABLED_KEY], |row| row.get(0)).optional().map_err(|_| "读取远端 API 日志设置失败")?;
    Ok(value.as_deref() == Some("true"))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteLog {
    pub id: String, pub timestamp: i64, pub account_id: Option<i64>, pub transport: String,
    pub method: String, pub url: String, pub status: Option<u16>, pub outcome: String,
    pub duration_ms: u64, pub proxy_mode: String, pub proxy_url: Option<String>,
    #[serde(skip)] pub detail: CallDetail,
    #[serde(skip)] bytes: usize,
}
#[derive(Serialize)]
pub struct LogState { pub enabled: bool, pub logs: Vec<RemoteLog> }
#[derive(Default)]
struct Store { enabled: bool, generation: u64, bytes: usize, logs: VecDeque<RemoteLog> }
impl Store {
    fn set_enabled(&mut self, enabled: bool) {
        if self.enabled != enabled { self.generation += 1; }
        self.enabled = enabled;
    }
    fn save_enabled(&mut self, conn: &Connection, enabled: bool) -> Result<(), String> {
        crate::core::repositories::preferences::save(conn, ENABLED_KEY, if enabled { "true" } else { "false" }, chrono::Utc::now().timestamp_millis()).map_err(|_| "保存远端 API 日志设置失败")?;
        self.set_enabled(enabled);
        Ok(())
    }
    fn push(&mut self, entry: RemoteLog) {
        while self.logs.len()>=500 || self.bytes+entry.bytes>8*1024*1024 {
            if let Some(old)=self.logs.pop_front(){self.bytes=self.bytes.saturating_sub(old.bytes);}else{break;}
        }
        self.bytes+=entry.bytes;self.logs.push_back(entry);
    }
}
static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
fn store() -> &'static Mutex<Store> { STORE.get_or_init(|| Mutex::new(Store::default())) }
pub fn state() -> Result<LogState, String> {
    let store = store().lock().map_err(|_| "远端 API 日志不可用")?;
    Ok(LogState { enabled: store.enabled, logs: store.logs.iter().rev().map(|log| { let mut summary=log.clone(); summary.detail=CallDetail::default(); summary }).collect() })
}
pub fn initialize(conn: &Connection) -> Result<(), String> {
    let enabled = load_enabled(conn)?;
    store().lock().map_err(|_| "远端 API 日志不可用")?.set_enabled(enabled);
    Ok(())
}
pub fn configure_saved(conn: &Connection, enabled: bool) -> Result<LogState, String> {
    store().lock().map_err(|_| "远端 API 日志不可用")?.save_enabled(conn, enabled)?;
    state()
}
#[cfg(test)]
fn configure(enabled: bool) -> Result<LogState, String> {
    store().lock().map_err(|_| "远端 API 日志不可用")?.set_enabled(enabled);
    state()
}
pub fn clear() -> Result<LogState, String> {
    { let mut store=store().lock().map_err(|_| "远端 API 日志不可用")?; store.logs.clear(); store.bytes=0; store.generation+=1; }
    state()
}
pub fn detail(id: &str) -> Result<CallDetail, String> {
    let store=store().lock().map_err(|_| "远端 API 日志不可用")?;
    store.logs.iter().find(|log|log.id==id).map(|log|log.detail.clone()).ok_or("该日志已清除或过期，请刷新列表".into())
}
pub struct RemoteTrace { entry: RemoteLog, start: Instant, generation: Option<u64>, secrets: Vec<Zeroizing<String>> }
impl RemoteTrace {
    pub fn enabled(&self) -> bool { self.generation.is_some() }
    pub fn new(id: Option<i64>, transport: &str, method: &str, url: &str, proxy: Option<&str>) -> Self {
        let generation=store().lock().ok().filter(|store|store.enabled).map(|store|store.generation);
        Self { entry: RemoteLog { id: uuid::Uuid::new_v4().to_string(), timestamp: chrono::Utc::now().timestamp_millis(), account_id:id, transport:transport.into(), method:method.into(), url:url.into(), status:None, outcome:"cancelled".into(), duration_ms:0, proxy_mode:if proxy.is_some(){"account"}else{"system"}.into(), proxy_url:proxy.and_then(|url|super::account_controls::validate_proxy(url).ok().flatten()), detail:CallDetail::default(), bytes:0 }, start:Instant::now(), generation, secrets:Vec::new() }
    }
    pub fn secret(&mut self, secret: &str) { if self.generation.is_some() && !secret.is_empty() { self.secrets.push(Zeroizing::new(secret.into())); } }
    fn clean(&mut self, value: &Value) -> Value {
        // Remove known secrets before truncation, so a cut-off token cannot survive.
        let mut raw=CallDetail {request:Some(value.clone()),..Default::default()};
        for secret in &self.secrets {raw.redact_secret(secret);}
        self.entry.detail.sanitize(raw.request.as_ref().unwrap())
    }
    pub fn request(&mut self, value: &Value) { if self.generation.is_some() { self.entry.detail.request=Some(self.clean(value)); } }
    pub fn response(&mut self, value: &Value) { if self.generation.is_some() { self.entry.detail.response=Some(self.clean(value)); } }
    pub fn event(&mut self, value: &Value) {
        if self.generation.is_none() { return; }
        self.entry.detail.event_count+=1;
        let clean=self.clean(value);
        let used=self.entry.detail.events.iter().map(|event|event.to_string().len()).sum::<usize>();
        let terminal=value.get("type").and_then(Value::as_str).is_some_and(|kind|matches!(kind,"response.completed"|"response.failed"|"response.incomplete"|"error"));
        if self.entry.detail.events.len()<128 && used+clean.to_string().len()<=192*1024 {self.entry.detail.events.push(clean);}
        else {self.entry.detail.truncated=true;if terminal {let _=self.entry.detail.events.pop();self.entry.detail.events.push(clean);}}
        if terminal { if let Some(body)=value.get("response") {self.json_body(body);} }
    }
    pub fn finish(&mut self, outcome: &str) { self.entry.outcome=outcome.into(); }
    pub fn body(&mut self, bytes: &[u8]) {
        if self.generation.is_none() { return; }
        let value=serde_json::from_slice::<Value>(bytes).unwrap_or_else(|_|json!({"unavailable":"非 JSON 响应原文未记录", "bytes":bytes.len()}));
        self.json_body(&value);
    }
    pub fn json_body(&mut self, value: &Value) {
        if self.generation.is_none() { return; }
        let body=self.clean(value);
        if let Some(response)=self.entry.detail.response.as_mut().and_then(Value::as_object_mut) { response.insert("body".into(),body); }
        else { self.response(&json!({"body":body})); }
    }
}
impl Drop for RemoteTrace {
    fn drop(&mut self) {
        let Some(generation)=self.generation else {return;};
        for secret in &self.secrets { self.entry.detail.redact_secret(secret); }
        self.entry.duration_ms=self.start.elapsed().as_millis().min(u64::MAX as u128) as u64;
        let Ok(bytes)=serde_json::to_vec(&self.entry.detail) else {return;};
        self.entry.bytes=bytes.len();
        // Per-entry cap plus process-wide caps, including headers and stream events.
        if self.entry.bytes > 512*1024 { self.entry.detail.events.clear(); self.entry.detail.truncated=true; self.entry.bytes=serde_json::to_vec(&self.entry.detail).map(|v|v.len()).unwrap_or(0); }
        if self.entry.bytes > 512*1024 {self.entry.detail=CallDetail{truncated:true,..Default::default()};self.entry.bytes=64;}
        if let Ok(mut store)=store().lock() {
            if !store.enabled || store.generation!=generation {return;}
            store.push(self.entry.clone());
        }
    }
}
fn headers(headers: &reqwest::header::HeaderMap) -> Value {
    let mut result=serde_json::Map::new();
    for (key,value) in headers {
        let name=key.as_str();
        let sensitive=["authorization","cookie","token","key","secret","signature","account","organization"].iter().any(|word|name.contains(word));
        let value=if sensitive {"[凭据或身份已隐藏]"} else {value.to_str().unwrap_or("[非文本头]")};
        result.insert(name.into(),json!(value));
    }
    Value::Object(result)
}
pub async fn send(client: &reqwest::Client, builder: reqwest::RequestBuilder, id: Option<i64>, proxy: Option<&str>, token: &str) -> Result<(reqwest::Response,RemoteTrace),reqwest::Error> {
    let request=builder.build()?;
    let mut trace=RemoteTrace::new(id,"http",request.method().as_str(),request.url().as_str(),proxy);
    trace.secret(token);
    let body=request.body().and_then(|body|body.as_bytes()).and_then(|bytes|serde_json::from_slice::<Value>(bytes).ok());
    trace.request(&json!({"headers":headers(request.headers()),"body":body,"query":request.url().query(),"proxyMode":trace.entry.proxy_mode,"proxyUrl":trace.entry.proxy_url,"timeoutMs":request.timeout().map(|duration|duration.as_millis()),"networkNote":"记录配置路径；系统网络是否经过环境代理、NO_PROXY、系统代理或 VPN，由网络栈决定"}));
    match client.execute(request).await {
        Ok(response) => {trace.entry.status=Some(response.status().as_u16());trace.response(&json!({"headers":headers(response.headers()),"httpVersion":format!("{:?}",response.version())}));trace.finish(if response.status().is_success(){"body_pending"}else{"http_error"});Ok((response,trace))},
        Err(error) => {trace.finish(if error.is_timeout(){"timeout"}else if error.is_connect(){"connect_error"}else{"request_error"});trace.response(&json!({"errorCategory":trace.entry.outcome}));Err(error)}
    }
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn enabled_preference_survives_restart_and_failed_save_preserves_state() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE client_preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL);").unwrap();
        assert!(!load_enabled(&conn).unwrap());
        let mut first = Store::default();
        first.save_enabled(&conn, true).unwrap();
        let mut restarted = Store::default();
        restarted.set_enabled(load_enabled(&conn).unwrap());
        assert!(restarted.enabled);
        assert!(restarted.logs.is_empty());
        restarted.save_enabled(&conn, false).unwrap();
        assert!(!load_enabled(&conn).unwrap());
        let broken = Connection::open_in_memory().unwrap();
        assert!(restarted.save_enabled(&broken, true).is_err());
        assert!(!restarted.enabled);
        assert_eq!(restarted.generation, 2);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM client_preferences", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    }
    #[test] fn remote_headers_and_bodies_hide_credentials() {
        let mut map=reqwest::header::HeaderMap::new();
        map.insert("authorization","Bearer test-only-secret".parse().unwrap());map.insert("set-cookie","session=test-only-secret".parse().unwrap());map.insert("content-type","application/json".parse().unwrap());
        let clean=headers(&map);assert!(!clean.to_string().contains("test-only-secret"));assert_eq!(clean["content-type"],"application/json");
        let mut detail=CallDetail::default();detail.request=Some(detail.sanitize(&json!({"access_token":"test-only-secret","nested":{"password":"test-only-secret"},"text":"echo test-only-secret"})));
        detail.redact_secret("test-only-secret");assert!(!detail.request.unwrap().to_string().contains("test-only-secret"));
        let mut trace=RemoteTrace::new(None,"http","POST","https://example.invalid",None);trace.generation=Some(u64::MAX);
        trace.secret("test-only-secret");
        trace.request(&json!({"text":format!("{}test-only-secret", "x".repeat(65528))}));
        assert!(!trace.entry.detail.request.as_ref().unwrap().to_string().contains("test-only"));
        for _ in 0..200 {trace.event(&json!({"type":"response.output_text.delta","delta":"sample"}));}
        trace.event(&json!({"type":"response.completed","response":{"status":"completed"}}));
        assert_eq!(trace.entry.detail.event_count,201);assert!(trace.entry.detail.events.len()<=128);assert!(trace.entry.detail.truncated);
        assert_eq!(trace.entry.detail.response.as_ref().unwrap()["body"]["status"],"completed");
    }
    #[tokio::test] async fn real_http_capture_redacts_and_clear_discards_inflight() {
        use tokio::io::{AsyncReadExt,AsyncWriteExt};
        clear().unwrap();configure(true).unwrap();
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let address=listener.local_addr().unwrap();
        let server=tokio::spawn(async move {let(mut socket,_)=listener.accept().await.unwrap();let mut request=[0u8;4096];let _=socket.read(&mut request).await.unwrap();let body=r#"{"result":"echo test-only-secret","access_token":"test-only-secret","usage":{"input_tokens":3}}"#;let response=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nSet-Cookie: session=test-only-secret\r\nX-Request-Id: fixture-request\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);socket.write_all(response.as_bytes()).await.unwrap();});
        let client=reqwest::Client::builder().no_proxy().build().unwrap();
        let (response,mut trace)=send(&client,client.post(format!("http://{address}/test")).bearer_auth("test-only-secret").json(&json!({"model":"fixture-model","input":"hello"})),Some(999),Some("http://127.0.0.1:10808"),"test-only-secret").await.unwrap();
        let id=trace.entry.id.clone();trace.body(&response.bytes().await.unwrap());trace.finish("completed");drop(trace);server.await.unwrap();
        let captured=detail(&id).unwrap();let text=serde_json::to_string(&captured).unwrap();assert!(!text.contains("test-only-secret"));assert_eq!(captured.response.unwrap()["body"]["usage"]["input_tokens"],3);
        let logs=state().unwrap();assert!(logs.logs.iter().any(|row|row.id==id&&row.status==Some(200)&&row.proxy_mode=="account"));assert!(!serde_json::to_string(&logs).unwrap().contains("hello"));
        let refused=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let refused_address=refused.local_addr().unwrap();drop(refused);
        assert!(send(&client,client.get(format!("http://{refused_address}/refused")),Some(999),None,"test-only-secret").await.is_err());
        assert!(state().unwrap().logs.iter().any(|row|row.url.ends_with("/refused")&&row.status.is_none()&&row.outcome=="connect_error"));
        let slow=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let slow_address=slow.local_addr().unwrap();
        let slow_server=tokio::spawn(async move{let(_socket,_)=slow.accept().await.unwrap();tokio::time::sleep(std::time::Duration::from_millis(200)).await;});
        assert!(send(&client,client.get(format!("http://{slow_address}/slow")).timeout(std::time::Duration::from_millis(50)),Some(999),None,"test-only-secret").await.is_err());
        slow_server.await.unwrap();assert!(state().unwrap().logs.iter().any(|row|row.url.ends_with("/slow")&&row.outcome=="timeout"));
        let inflight=RemoteTrace::new(Some(999),"http","GET","https://example.invalid",None);let discarded=inflight.entry.id.clone();clear().unwrap();drop(inflight);assert!(detail(&discarded).is_err());
        let off=RemoteTrace::new(Some(999),"http","GET","https://example.invalid",None);let discarded=off.entry.id.clone();configure(false).unwrap();drop(off);assert!(detail(&discarded).is_err());
        let mut bounded=Store::default();let mut row=logs.logs.into_iter().find(|row|row.id==id).unwrap();row.bytes=32768;
        for _ in 0..600 {bounded.push(row.clone());}assert!(bounded.logs.len()<=500);assert!(bounded.bytes<=8*1024*1024);
    }
}
