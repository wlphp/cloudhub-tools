use crate::core::{
    codex::{auth, profile, rpc},
    repositories::codex_accounts as repository,
    storage::open_db,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    task::{JoinHandle, JoinSet},
};
use zeroize::Zeroizing;
use super::gateway_controls::{CallLog, CallDetail, Controls, GatewaySettings, RoutingStrategy};

const MAX_BODY: usize = 512 * 1024;
// Official catalogs include model instructions and other metadata, so their
// response budget is separate from the local text request budget.
const MAX_CATALOG_BODY: usize = 8 * 1024 * 1024;
const MAX_OUTPUT: usize = 16 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewaySummary {
    pub running: bool,
    pub address: Option<String>,
    pub account_ids: Vec<i64>,
    pub completed: u64,
    pub failed: u64,
    pub active: usize,
    pub supports_custom_key: bool,
    pub supports_models: bool,
    pub supports_remote_models: bool,
    pub supports_persistent_config: bool,
    pub supports_function_tools: bool,
    pub configured_port: Option<u16>,
    pub settings: GatewaySettings,
}
impl Default for GatewaySummary {
    fn default() -> Self {
        Self { running: false, address: None, account_ids: Vec::new(), completed: 0, failed: 0, active: 0, supports_custom_key: true, supports_models: true, supports_remote_models: true, supports_persistent_config: true, supports_function_tools: true, configured_port: None, settings: GatewaySettings::default() }
    }
}

#[derive(Default)]
struct Routes {
    cursor: usize,
    sticky: HashMap<String, i64>,
    cooldown: HashMap<i64, Instant>,
    completed: u64,
    failed: u64,
}

struct Shared {
    controls: Mutex<Controls>,
    pool: Vec<i64>,
    key: Zeroizing<String>,
    routes: Mutex<Routes>,
    slots: Arc<Semaphore>,
    client: reqwest::Client,
    models: tokio::sync::Mutex<Option<(Instant, Vec<String>)>>,
    closed: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    test_endpoint: Mutex<Option<String>>,
}
pub struct RunningGateway {
    shared: Arc<Shared>,
    task: JoinHandle<()>,
    address: String,
}
impl Drop for RunningGateway {
    fn drop(&mut self) {
        self.shared.closed.store(true, std::sync::atomic::Ordering::SeqCst);
        self.task.abort();
    }
}
impl RunningGateway {
    #[cfg(test)]
    pub async fn start(port: u16, pool: Vec<i64>) -> Result<Self, String> {
        Self::start_with_key(port, pool, None).await
    }
    pub async fn start_with_key(port: u16, pool: Vec<i64>, service_key: Option<String>) -> Result<Self, String> {
        let service_key = service_key.map(Zeroizing::new);
        if service_key.as_ref().is_some_and(|key| !(24..=256).contains(&key.len()) || !key.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))) {
            return Err("服务密钥须为 24–256 位字母、数字或 . _ -，不能含空格".into());
        }
        if pool.is_empty() || pool.len() > 100 || pool.iter().any(|id| *id <= 0) {
            return Err("请选择 1 至 100 个 Codex 服务账号".into());
        }
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .map_err(|_| "本地 API 端口被占用或无法监听，请选择其他端口")?;
        let actual = listener.local_addr().map_err(|_| "查询本地 API 地址失败")?;
        let key = service_key.unwrap_or_else(|| {
            let mut bytes = Zeroizing::new([0u8; 32]);
            rand::thread_rng().fill_bytes(&mut *bytes);
            Zeroizing::new(hex::encode(&*bytes))
        });
        let shared = Arc::new(Shared {
            controls: Mutex::new(Controls::default()),
            pool,
            key,
            routes: Mutex::new(Routes::default()),
            slots: Arc::new(Semaphore::new(4)),
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(15))
                .timeout(Duration::from_secs(180))
                .build()
                .map_err(|_| "初始化 Codex API 客户端失败")?,
            models: tokio::sync::Mutex::new(None),
            closed: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            test_endpoint: Mutex::new(None),
        });
        let state = shared.clone();
        let host = actual.to_string();
        let task = tokio::spawn(async move {
            let mut workers = JoinSet::new();
            loop {
                tokio::select! {
                    accepted=listener.accept() => {
                        let Ok((mut stream,peer)) = accepted else { break; };
                        if !peer.ip().is_loopback() { continue; }
                        let Ok(permit) = state.slots.clone().try_acquire_owned() else {
                            // Do not block the admission loop on a slow reader.
                            drop(stream); continue;
                        };
                        let worker = state.clone(); let host = host.clone();
                        workers.spawn(async move {
                            let _permit = permit;
                            let mut trace = RequestTrace::new(worker.clone());
                            if tokio::time::timeout(Duration::from_secs(185),serve(&mut stream,&host,&worker,&mut trace)).await.is_err() { trace.entry.status = 504; trace.entry.outcome = "timeout"; let _=reply(&mut stream,504,"网关请求超时").await; }
                        });
                    }
                    _=workers.join_next(), if !workers.is_empty() => {}
                }
            }
            // JoinSet drop cancels active upstream requests and closes accepted sockets.
        });
        Ok(Self {
            shared,
            task,
            address: format!("http://{actual}/v1"),
        })
    }
    pub fn contains(&self, id: i64) -> bool {
        self.shared.pool.contains(&id) && !self.task.is_finished()
    }
    pub fn summary(&self) -> Result<GatewaySummary, String> {
        let routes = self
            .shared
            .routes
            .lock()
            .map_err(|_| "Codex 服务状态不可用")?;
        Ok(GatewaySummary {
            running: !self.task.is_finished(),
            address: Some(self.address.clone()),
            account_ids: self.shared.pool.clone(),
            completed: routes.completed,
            failed: routes.failed,
            active: 4 - self.shared.slots.available_permits(),
            supports_custom_key: true,
            supports_models: true,
            supports_remote_models: true,
            supports_persistent_config: true,
            supports_function_tools: true,
            configured_port: None,
            settings: self.shared.controls.lock().map_err(|_| "网关规则不可用")?.settings.clone(),
        })
    }
    pub fn copy_key(&self) -> Result<(), String> {
        arboard::Clipboard::new()
            .and_then(|mut clipboard| clipboard.set_text(self.shared.key.to_string()))
            .map_err(|_| "复制本地 API 密钥失败".into())
    }
    pub fn configure(&self, settings: GatewaySettings, accounts: Vec<super::CodexAccountSummary>) -> Result<(), String> {
        settings.validate()?;
        let mut controls = self.shared.controls.lock().map_err(|_| "网关规则不可用")?;
        controls.apply(settings);
        controls.quotas = accounts.into_iter().filter(|a| self.shared.pool.contains(&a.id)).map(|a| (a.id, a.quota)).collect();
        Ok(())
    }
    pub fn logs(&self) -> Result<Vec<CallLog>, String> {
        Ok(self.shared.controls.lock().map_err(|_| "网关日志不可用")?.logs.iter().rev().map(|v| CallLog { detail: CallDetail::default(), detail_bytes:0, id:v.id.clone(), model:v.model.clone(), timestamp:v.timestamp, endpoint:v.endpoint, account_id:v.account_id, status:v.status, upstream_status:v.upstream_status, outcome:v.outcome, streaming:v.streaming, duration_ms:v.duration_ms, input_tokens:v.input_tokens, output_tokens:v.output_tokens }).collect())
    }
    pub fn log_detail(&self, id: &str) -> Result<CallDetail, String> {
        if uuid::Uuid::parse_str(id).is_err() { return Err("日志标识无效".into()); }
        self.shared.controls.lock().map_err(|_| "网关日志不可用")?.logs.iter().find(|entry|entry.id==id).map(|entry|entry.detail.clone()).ok_or_else(|| "该日志已清除或过期，请刷新列表".into())
    }
    pub fn clear_logs(&self) -> Result<(), String> {
        self.shared.controls.lock().map_err(|_| "网关日志不可用")?.clear(); Ok(())
    }
    pub fn save_config(&self, conn: &rusqlite::Connection) -> Result<u16, String> {
        let port = self.address.strip_prefix("http://127.0.0.1:").and_then(|v| v.strip_suffix("/v1")).and_then(|v| v.parse::<u16>().ok()).ok_or("本地 API 地址无效")?;
        super::gateway_config::save(conn, port, &self.shared.key)?;
        Ok(port)
    }
    pub fn models_query(&self) -> impl std::future::Future<Output = Result<Vec<String>, String>> + Send + 'static {
        let shared = self.shared.clone();
        async move {
            if shared.closed.load(std::sync::atomic::Ordering::SeqCst) { return Err("本地服务已停止，模型查询已取消".into()); }
            let query = model_catalog(&shared);
            tokio::pin!(query);
            let mut timer = tokio::time::interval(Duration::from_millis(100));
            loop {
                tokio::select! {
                    result = &mut query => return if shared.closed.load(std::sync::atomic::Ordering::SeqCst) { Err("本地服务已停止，模型查询已取消".into()) } else { result },
                    _ = timer.tick() => if shared.closed.load(std::sync::atomic::Ordering::SeqCst) { return Err("本地服务已停止，模型查询已取消".into()); }
                }
            }
        }
    }
}

struct Request {
    path: String,
    session: Option<String>,
    body: Zeroizing<Vec<u8>>,
}
struct RequestTrace {
    shared: Arc<Shared>, started: Instant, generation: Option<u64>, entry: CallLog,
}
impl RequestTrace {
    fn new(shared: Arc<Shared>) -> Self {
        let generation = shared.controls.lock().ok().and_then(|c| c.settings.logging_enabled.then_some(c.generation));
        Self { shared, started: Instant::now(), generation, entry: CallLog { id: uuid::Uuid::new_v4().to_string(), timestamp: chrono::Utc::now().timestamp_millis(), endpoint: "unknown", model: None, account_id: None, status: 499, upstream_status: None, outcome: "cancelled", streaming: false, duration_ms: 0, input_tokens: None, output_tokens: None, detail: CallDetail::default(), detail_bytes: 0 } }
    }
    fn result(&mut self, status: u16, outcome: &'static str) { self.entry.status = status; self.entry.outcome = outcome; if self.generation.is_some() && status>=400 { self.entry.detail.response=Some(json!({"status":status,"outcome":outcome})); } }
    fn capture(&mut self, field: &str, value: &Value) {
        if self.generation.is_none() { return; }
        let clean=self.entry.detail.sanitize(value);
        match field { "request"=>self.entry.detail.request=Some(clean), "forwarded"=>self.entry.detail.forwarded=Some(clean), _=>self.entry.detail.response=Some(clean) }
    }
}
impl Drop for RequestTrace {
    fn drop(&mut self) {
        self.entry.duration_ms = self.started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        if let Ok(mut c) = self.shared.controls.lock() { c.record(self.generation, self.entry.clone()); }
    }
}
fn authorized(actual: &str, expected: &str) -> bool {
    // Fixed-length comparison; authentication failures do not disclose the key.
    let a = actual.as_bytes();
    let b = expected.as_bytes();
    let mut difference = a.len() ^ b.len();
    for (i, value) in b.iter().enumerate() {
        difference |= (a.get(i).copied().unwrap_or(0) ^ value) as usize;
    }
    difference == 0
}

async fn read_request(stream: &mut TcpStream, host: &str, key: &str) -> Result<Request, u16> {
    let mut bytes = Zeroizing::new(Vec::new());
    let end = loop {
        if let Some(at) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
            break at + 4;
        }
        if bytes.len() > 16 * 1024 {
            return Err(431);
        }
        let mut block = [0u8; 2048];
        let count = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut block))
            .await
            .map_err(|_| 408u16)?
            .map_err(|_| 400u16)?;
        if count == 0 {
            return Err(400);
        }
        bytes.extend_from_slice(&block[..count]);
    };
    if end > 16 * 1024 {
        return Err(431);
    }
    let text = std::str::from_utf8(&bytes[..end]).map_err(|_| 400u16)?;
    let mut lines = text.split("\r\n");
    let mut start = lines.next().ok_or(400u16)?.split(' ');
    let method = start.next().ok_or(400u16)?;
    let path = start.next().ok_or(400u16)?.to_string();
    let listing = method == "GET" && path == "/v1/models";
    if !listing && method != "POST" { return Err(405); }
    if !listing && !matches!(path.as_str(), "/v1/responses" | "/v1/chat/completions") {
        return Err(404);
    }
    if start.next() != Some("HTTP/1.1") || start.next().is_some() {
        return Err(400);
    }
    let mut headers = HashMap::new();
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').ok_or(400u16)?;
        let name = name.to_ascii_lowercase();
        if name.is_empty()
            || name
                .bytes()
                .any(|v| !v.is_ascii_alphanumeric() && v != b'-')
            || headers.insert(name, value.trim()).is_some()
        {
            return Err(400);
        }
    }
    if headers.contains_key("origin") || headers.contains_key("transfer-encoding") {
        return Err(403);
    }
    if headers.get("host").copied() != Some(host) {
        return Err(403);
    }
    let bearer = headers
        .get("authorization")
        .and_then(|s| s.strip_prefix("Bearer "))
        .ok_or(401u16)?;
    if !authorized(bearer, key) {
        return Err(401);
    }
    if listing {
        if headers.get("content-length").is_some_and(|value| *value != "0") || bytes.len() != end { return Err(400); }
        return Ok(Request { path, session: None, body: Zeroizing::new(Vec::new()) });
    }
    if headers.get("content-type").is_none_or(|s| {
        !s.split(';')
            .next()
            .is_some_and(|v| v.trim() == "application/json")
    }) {
        return Err(415);
    }
    let length = headers
        .get("content-length")
        .ok_or(411u16)?
        .parse::<usize>()
        .map_err(|_| 400u16)?;
    if length == 0 || length > MAX_BODY {
        return Err(413);
    }
    let session = headers
        .get("x-cloudhub-session")
        .map(|value| value.to_string());
    if session.as_ref().is_some_and(|s| {
        s.is_empty()
            || s.len() > 128
            || s.bytes()
                .any(|v| !v.is_ascii_alphanumeric() && !matches!(v, b'-' | b'_'))
    }) {
        return Err(400);
    }
    let mut body = Zeroizing::new(bytes[end..].to_vec());
    if body.len() > length {
        return Err(400);
    }
    body.resize(length, 0);
    let received = bytes.len() - end;
    tokio::time::timeout(
        Duration::from_secs(10),
        stream.read_exact(&mut body[received..]),
    )
    .await
    .map_err(|_| 408u16)?
    .map_err(|_| 400u16)?;
    Ok(Request {
        path,
        session,
        body,
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChatRequest {
    model: String,
    messages: Vec<Value>,
    #[serde(default)]
    stream: bool,
    max_tokens: Option<u64>,
}
pub fn model_valid(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= 100
        && model
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'.' | b'_'))
}
fn payload(request: &Request) -> Result<(Value, bool, bool), String> {
    let chat = request.path == "/v1/chat/completions";
    if !chat {
        let (body, streaming) = super::responses::normalize(&request.body)?;
        return Ok((body, streaming, false));
    }
    let (model, input, instructions, stream, reasoning, max) = {
        let value: ChatRequest =
            serde_json::from_slice(&request.body).map_err(|_| "Chat 请求参数不受支持")?;
        if value.messages.is_empty() || value.messages.len() > 100 {
            return Err("消息数量无效".into());
        }
        (
            value.model,
            Value::Array(value.messages),
            None::<String>,
            value.stream,
            None::<Value>,
            value.max_tokens,
        )
    };
    if !model_valid(&model) || max.is_some_and(|v| v == 0 || v > 32768) {
        return Err("模型或输出限制参数无效".into());
    }
    let input = if let Some(text) = input.as_str() {
        if text.is_empty() {
            return Err("输入不能为空".into());
        }
        json!([{"role":"user","content":[{"type":"input_text","text":text}]}])
    } else {
        let messages = input
            .as_array()
            .filter(|v| !v.is_empty() && v.len() <= 100)
            .ok_or("仅支持文本消息输入")?;
        let mut normalized = Vec::new();
        for message in messages {
            let role = message
                .get("role")
                .and_then(Value::as_str)
                .filter(|s| matches!(*s, "user" | "assistant" | "system" | "developer"))
                .ok_or("消息角色无效")?;
            let text = message.get("content").ok_or("消息缺少内容")?;
            let content = if let Some(text) = text.as_str() {
                json!([{"type":if role=="assistant" {"output_text"} else {"input_text"},"text":text}])
            } else {
                let parts = text
                    .as_array()
                    .filter(|v| v.len() <= 50)
                    .ok_or("仅支持文本内容")?;
                if parts.iter().any(|part| {
                    !matches!(
                        part.get("type").and_then(Value::as_str),
                        Some("input_text" | "output_text" | "text")
                    ) || part.get("text").and_then(Value::as_str).is_none()
                }) {
                    return Err("仅支持文本内容".into());
                }
                Value::Array(parts.iter().map(|part|json!({"type":if role=="assistant" {"output_text"} else {"input_text"},"text":part["text"]})).collect())
            };
            normalized.push(json!({"role":role,"content":content}));
        }
        Value::Array(normalized)
    };
    let mut body = json!({"model":model,"input":input,"instructions":instructions.unwrap_or_default(),"stream":true,"store":false,"tools":[]});
    if let Some(reasoning) = reasoning {
        let effort = reasoning
            .get("effort")
            .and_then(Value::as_str)
            .filter(|s| matches!(*s, "none" | "minimal" | "low" | "medium" | "high" | "xhigh"))
            .ok_or("推理参数无效")?;
        body["reasoning"] = json!({"effort":effort});
    }
    if let Some(max) = max {
        body["max_output_tokens"] = json!(max);
    }
    Ok((body, stream, chat))
}

fn route(shared: &Shared, session: Option<&str>) -> Result<i64, String> {
    let (strategy, scores) = {
        let c = shared.controls.lock().map_err(|_| "网关规则不可用")?;
        (c.settings.strategy, c.quotas.iter().map(|(id,q)| (*id, super::gateway_controls::remaining(q, chrono::Utc::now().timestamp_millis()))).collect::<HashMap<_,_>>())
    };
    let mut routes = shared.routes.lock().map_err(|_| "Codex 服务状态不可用")?;
    routes.cooldown.retain(|_, until| *until > Instant::now());
    if let Some(id) = session.and_then(|s| routes.sticky.get(s)).copied() {
        if routes.cooldown.contains_key(&id) {
            return Err("会话绑定账号暂不可用，请稍后重试或更换会话标识".into());
        }
        return Ok(id);
    }
    let mut candidates: Vec<i64> = (0..shared.pool.len()).map(|offset| shared.pool[(routes.cursor % shared.pool.len() + offset) % shared.pool.len()]).collect();
    if strategy == RoutingStrategy::Ordered { candidates = shared.pool.clone(); }
    if strategy == RoutingStrategy::QuotaFirst {
        candidates.sort_by(|a,b| scores.get(b).copied().flatten().unwrap_or(-1.0).total_cmp(&scores.get(a).copied().flatten().unwrap_or(-1.0)));
    }
    for id in candidates {
        if routes.cooldown.contains_key(&id) || (strategy == RoutingStrategy::QuotaFirst && scores.get(&id).copied().flatten() == Some(0.0)) { continue; }
        routes.cursor = (shared.pool.iter().position(|v| *v == id).unwrap_or(0) + 1) % shared.pool.len();
        if let Some(session) = session {
            if routes.sticky.len() >= 256 {
                return Err("会话绑定数量达到上限，请重启本地服务".into());
            }
            routes.sticky.insert(session.to_string(), id);
        }
        return Ok(id);
    }
    Err("服务账号均在冷却中或缓存额度已耗尽，请刷新额度后重试".into())
}

// Access tokens are borrowed from the latest local auth when it is the same identity.
// This adapter never rotates refresh tokens behind a running official client.
fn credentials(
    id: i64,
    cancelled: Arc<std::sync::atomic::AtomicBool>,
) -> Result<(Zeroizing<String>, Option<String>, Option<String>), String> {
    let _writer = super::AUTH_WRITER
        .lock()
        .map_err(|_| "Codex 账号操作不可用")?;
    credentials_locked(id,cancelled)
}
pub(crate) fn credentials_locked(id:i64,cancelled:Arc<std::sync::atomic::AtomicBool>)->Result<(Zeroizing<String>,Option<String>,Option<String>),String> {
    let conn = open_db()?;
    if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("Codex 请求已取消".into());
    }
    let summary = repository::get(&conn, id)?;
    let saved = auth::parse_import(&repository::credentials(&conn, id)?)?.remove(0);
    let external = profile::default_home()
        .ok()
        .and_then(|home| profile::read_auth(&home.join("auth.json")).ok())
        .and_then(|v| auth::parse_import(&v).ok())
        .and_then(|mut v| v.pop())
        .filter(|v| v.identity == saved.identity);
    let current = if let Some(external) = external {
        external
    } else if saved.auth_mode == "chatgpt" && auth::access_expiring(&saved.auth_json) {
        let isolated = profile::TemporaryProfile::new(&saved.auth_json)?;
        let result = (|| {
            let mut server = rpc::AppServer::start_cancelled_proxy(&isolated.path, Some(cancelled), summary.proxy_url.as_deref())?;
            server.request(
                "account/read",
                json!({"refreshToken":true}),
                Duration::from_secs(30),
            )
        })();
        let updated =
            auth::parse_import(&profile::read_auth(&isolated.path.join("auth.json"))?)?.remove(0);
        if updated.identity != saved.identity {
            return Err("Codex 返回了不同账号，未保存认证状态".into());
        }
        // Persist token rotation even when the subsequent RPC failed; errors are authored by rpc.
        if updated.auth_json.as_str() != saved.auth_json.as_str() {
            repository::save_refresh(
                &conn,
                id,
                summary.updated_at,
                &updated.auth_json,
                None,
                updated.plan.as_deref(),
                result.as_ref().err().map(String::as_str),
            )?;
        }
        result?;
        updated
    } else {
        saved
    };
    let value: Value =
        serde_json::from_str(&current.auth_json).map_err(|_| "Codex 认证数据无效")?;
    let token = if current.auth_mode == "apikey" {
        value.get("OPENAI_API_KEY")
    } else {
        value.pointer("/tokens/access_token")
    }
    .and_then(Value::as_str)
    .ok_or("Codex 认证数据无效")?;
    Ok((
        Zeroizing::new(token.to_string()),
        if current.auth_mode == "chatgpt" {
            current.account_id
        } else {
            None
        },
        summary.proxy_url,
    ))
}

fn upstream_http_error(status: u16, body: &[u8]) -> (u16, String) {
    // Provider text is untrusted and may echo credentials or request content.
    // Emit only our fixed categories and allowlisted parameter names.
    let value = serde_json::from_slice::<Value>(body).unwrap_or(Value::Null);
    let message = value.pointer("/error/message").or_else(|| value.get("detail"))
        .and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    let parameter = value.pointer("/error/param").and_then(Value::as_str)
        .filter(|name| matches!(*name, "model" | "instructions" | "tools" | "tool_choice" | "input" | "reasoning" | "max_output_tokens" | "temperature" | "top_p" | "store" | "stream" | "include" | "service_tier" | "text" | "prompt_cache_key"));
    let category = if message.contains("originator") { "客户端来源不受支持" }
        else if message.contains("model") { "模型不可用或模型参数不兼容" }
        else if message.contains("unsupported") || message.contains("not supported") { "请求参数不受支持" }
        else if message.contains("instructions") { "指令参数不兼容" }
        else { "请求被拒绝" };
    let code = match status { 401 | 403 => 401, 429 => 429, 400 | 404 | 422 => 400, _ => 502 };
    let detail = match parameter { Some(name) => format!("，参数 {name}"), None => String::new() };
    (code, format!("上游返回 HTTP {status}：{category}{detail}"))
}

async fn upstream(
    client: &reqwest::Client,
    id: i64,
    mut body: Value,
    trace: Option<&mut RequestTrace>,
) -> Result<reqwest::Response, (u16, String)> {
    struct Cancel(std::sync::Arc<std::sync::atomic::AtomicBool>);
    impl Drop for Cancel {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let _cancel = Cancel(cancelled.clone());
    let (token, account, proxy) = tauri::async_runtime::spawn_blocking(move || credentials(id, cancelled))
        .await
        .map_err(|_| (503u16, "读取账号认证任务失败".into()))?
        .map_err(|_| (401u16, "账号登录失效，请停止服务后重新登录或刷新认证".into()))?;
    let account_client=proxy.as_deref().map(|url|super::account_controls::client(Some(url))).transpose().map_err(|_|(502u16,"账号代理配置无效".into()))?;
    let client=account_client.as_ref().unwrap_or(client);
    let endpoint = if account.is_some() {
        super::responses::prepare_chatgpt(&mut body).map_err(|_| (400u16, "订阅请求参数不兼容".into()))?;
        "https://chatgpt.com/backend-api/codex/responses"
    } else {
        "https://api.openai.com/v1/responses"
    };
    if let Some(trace)=trace { trace.capture("forwarded",&body); }
    let mut request = client
        .post(endpoint)
        .bearer_auth(token.as_str())
        .header("Accept", "text/event-stream")
        .json(&body);
    if let Some(account) = account {
        request = request
            .header("ChatGPT-Account-Id", account)
            .header("originator", "cloudhub_tools");
    }
    let mut response = request.send().await.map_err(|_| (502u16, "连接上游失败，请检查网络".into()))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let mut bytes = Zeroizing::new(Vec::new());
        while let Ok(Some(chunk)) = response.chunk().await {
            if bytes.len() + chunk.len() > 64 * 1024 { bytes.clear(); break; }
            bytes.extend_from_slice(&chunk);
        }
        return Err(upstream_http_error(status, &bytes));
    }
    Ok(response)
}

async fn reply(stream: &mut TcpStream, code: u16, message: &str) -> std::io::Result<()> {
    json_reply(
        stream,
        code,
        &json!({"error":{"message":message,"type":"cloudhub_gateway_error"}}),
    )
    .await
}
async fn json_reply(stream: &mut TcpStream, code: u16, body: &Value) -> std::io::Result<()> {
    let bytes = body.to_string();
    stream.write_all(format!("HTTP/1.1 {code} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",bytes.len()).as_bytes()).await?;
    stream.write_all(bytes.as_bytes()).await
}
async fn event(stream: &mut TcpStream, value: &Value) -> std::io::Result<()> {
    stream
        .write_all(format!("data: {}\n\n", value).as_bytes())
        .await
}

#[derive(Default)]
struct SseDecoder {
    buffer: Vec<u8>,
    total: usize,
}
impl SseDecoder {
    fn feed(&mut self, chunk: &[u8]) -> Result<Vec<Value>, String> {
        self.total += chunk.len();
        if self.total > MAX_OUTPUT || self.buffer.len() + chunk.len() > 1024 * 1024 {
            return Err("上游流超出限制".into());
        }
        self.buffer.extend_from_slice(chunk);
        let mut events = Vec::new();
        loop {
            let lf = self.buffer.windows(2).position(|v| v == b"\n\n");
            let crlf = self.buffer.windows(4).position(|v| v == b"\r\n\r\n");
            let Some(end) = lf.into_iter().chain(crlf).min() else {
                break;
            };
            let delimiter = if self.buffer.get(end) == Some(&b'\r') {
                4
            } else {
                2
            };
            let raw = std::str::from_utf8(&self.buffer[..end]).map_err(|_| "上游流编码无效")?;
            let data = raw
                .lines()
                .filter_map(|line| line.strip_prefix("data:").map(str::trim_start))
                .collect::<Vec<_>>()
                .join("\n");
            if !data.is_empty() && data != "[DONE]" {
                events.push(serde_json::from_str(&data).map_err(|_| "上游流格式无效")?);
            }
            self.buffer.drain(..end + delimiter);
        }
        Ok(events)
    }
}

fn catalog_ids(value: &Value) -> Result<Vec<String>, String> {
    let rows = value.get("data").and_then(Value::as_array).filter(|rows| rows.len() <= 1000).ok_or("模型目录响应无效")?;
    let mut ids = std::collections::BTreeSet::new();
    for row in rows {
        if row.get("hidden").and_then(Value::as_bool) == Some(true) { continue; }
        let id = row.get("model").or_else(|| row.get("id")).and_then(Value::as_str).ok_or("模型目录响应无效")?;
        // Exclude model identifiers the text request adapter cannot accept.
        if !model_valid(id) { continue; }
        ids.insert(id.to_string());
    }
    Ok(ids.into_iter().collect())
}

fn remote_catalog_ids(value: &Value, chatgpt: bool) -> Result<Vec<String>, String> {
    if !chatgpt { return catalog_ids(value); }
    let rows = value.get("models").and_then(Value::as_array).filter(|rows| rows.len() <= 1000).ok_or("模型目录响应无效")?;
    let mut ids = std::collections::BTreeSet::new();
    for row in rows {
        if row.get("visibility").and_then(Value::as_str) == Some("hide") || row.get("hidden").and_then(Value::as_bool) == Some(true) { continue; }
        let id = row.get("slug").and_then(Value::as_str).ok_or("模型目录响应无效")?;
        if model_valid(id) { ids.insert(id.to_string()); }
    }
    Ok(ids.into_iter().collect())
}

async fn fetch_catalog(client: &reqwest::Client, token: &str, account: Option<&str>, version: Option<&str>, test_url: Option<&str>) -> Result<Vec<String>, String> {
    // Overrides exist only for isolated local tests; production always uses the
    // official HTTPS endpoint, with redirects disabled by the owning client.
    #[cfg(not(test))]
    if test_url.is_some() { return Err("模型目录地址无效".into()); }
    let url = test_url.unwrap_or(if account.is_some() { "https://chatgpt.com/backend-api/codex/models" } else { "https://api.openai.com/v1/models" });
    let mut request = client.get(url).bearer_auth(token).timeout(Duration::from_secs(20));
    if let Some(account) = account {
        let version = version.ok_or("Codex 客户端版本无效")?;
        request = request.query(&[("client_version", version)]).header("ChatGPT-Account-Id", account).header("originator", "codex_cli_rs");
    }
    let mut response = request.send().await.map_err(|_| "查询官方模型目录失败，请检查网络")?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 => "官方模型目录认证过期，请重新登录服务账号",
            403 => "官方模型目录访问被拒绝，请检查服务账号权限",
            429 => "官方模型目录请求过于频繁，请稍后重试",
            status => return Err(format!("官方模型目录返回 HTTP {status}")),
        }.into());
    }
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取模型目录失败")? {
        if bytes.len() + chunk.len() > MAX_CATALOG_BODY { return Err("模型目录响应过大".into()); }
        bytes.extend_from_slice(&chunk);
    }
    let value = serde_json::from_slice(&bytes).map_err(|_| "模型目录响应无效")?;
    remote_catalog_ids(&value, account.is_some())
}

async fn model_catalog(shared: &Shared) -> Result<Vec<String>, String> {
    // One bounded discovery request at a time; do not send inference or bind sessions.
    let mut cached = shared.models.lock().await;
    if let Some((_, ids)) = cached.as_ref().filter(|(at, _)| at.elapsed() < Duration::from_secs(60)) { return Ok(ids.clone()); }
    struct Cancel(Arc<std::sync::atomic::AtomicBool>);
    impl Drop for Cancel { fn drop(&mut self) { self.0.store(true, std::sync::atomic::Ordering::SeqCst); } }
    let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let _cancel = Cancel(cancelled.clone());
    let id = route(shared, None)?;
    let cancel = cancelled.clone();
    let (token, account, proxy) = tauri::async_runtime::spawn_blocking(move || credentials(id, cancel)).await
        .map_err(|_| "读取服务账号认证任务失败")?
        .map_err(|_| "读取服务账号认证失败，请重新登录或刷新账号")?;
    let version = if account.is_some() {
        Some(tauri::async_runtime::spawn_blocking(profile::catalog_client_version).await.map_err(|_| "读取模型客户端版本失败")??)
    } else { None };
    let account_client=proxy.as_deref().map(|url|super::account_controls::client(Some(url))).transpose()?;
    let ids = fetch_catalog(account_client.as_ref().unwrap_or(&shared.client), &token, account.as_deref(), version.as_deref(), None).await?;
    if ids.is_empty() { return Err("当前账号未返回模型目录，请检查登录及权限".into()); }
    *cached = Some((Instant::now(), ids.clone()));
    Ok(ids)
}

pub(crate) fn public_catalog_error(message: &str) -> String {
    // Only authored, exact messages may cross the HTTP boundary. Never return
    // an arbitrary database, CLI or upstream error containing local secrets.
    if message.strip_prefix("官方模型目录返回 HTTP ")
        .is_some_and(|status| status.len() == 3 && status.bytes().all(|c| c.is_ascii_digit()) && status.parse::<u16>().is_ok_and(|status| (100..=599).contains(&status))) {
        return message.to_string();
    }
    match message {
        "官方模型目录认证过期，请重新登录服务账号" => "官方模型目录认证过期，请重新登录服务账号",
        "官方模型目录访问被拒绝，请检查服务账号权限" => "官方模型目录访问被拒绝，请检查服务账号权限",
        "官方模型目录请求过于频繁，请稍后重试" => "官方模型目录请求过于频繁，请稍后重试",
        "查询官方模型目录失败，请检查网络" => "查询官方模型目录失败，请检查网络",
        "模型目录响应无效" => "官方模型目录响应格式不兼容",
        "当前账号未返回模型目录，请检查登录及权限" => "当前服务账号未返回模型目录",
        "服务账号均在冷却中或缓存额度已耗尽，请刷新额度后重试" => "服务账号均在冷却中或缓存额度已耗尽，请刷新额度后重试",
        "Codex 认证数据无效" => "服务账号认证数据无效，请重新登录",
        "读取服务账号认证失败，请重新登录或刷新账号" => "读取服务账号认证失败，请重新登录或刷新账号",
        "读取服务账号认证任务失败" => "读取服务账号认证任务失败",
        "未找到官方 Codex 客户端，无法查询模型目录" => "未找到官方 Codex 客户端，无法查询模型目录",
        "读取 Codex 客户端版本失败" | "读取模型客户端版本失败" => "读取 Codex 客户端版本失败",
        "读取 Codex 客户端版本超时" => "读取 Codex 客户端版本超时",
        "Codex 客户端版本无效" => "Codex 客户端版本无效",
        "读取模型目录失败" => "读取官方模型目录失败",
        "模型目录响应过大" => "官方模型目录响应超过限制",
        _ => "模型目录获取失败，请检查服务账号登录、权限与网络",
    }.to_string()
}

async fn serve(stream: &mut TcpStream, host: &str, shared: &Shared, trace: &mut RequestTrace) {
    let request = match read_request(stream, host, &shared.key).await {
        Ok(v) => v,
        Err(code) => {
            trace.result(code, "request_rejected");
            let _ = reply(stream, code, "本地 API 请求被拒绝，请检查授权与参数").await;
            return;
        }
    };
    trace.entry.endpoint = match request.path.as_str() { "/v1/models" => "/v1/models", "/v1/responses" => "/v1/responses", "/v1/chat/completions" => "/v1/chat/completions", _ => "unsupported" };
    if request.path == "/v1/models" {
        match model_catalog(shared).await {
            Ok(ids) => { trace.result(200, "completed"); let data: Vec<Value> = ids.into_iter().map(|id| json!({"id":id,"object":"model","created":0,"owned_by":"openai"})).collect(); let _ = json_reply(stream, 200, &json!({"object":"list","data":data})).await; }
            Err(message) => { trace.result(503, "catalog_error"); let _ = reply(stream, 503, &public_catalog_error(&message)).await; }
        }
        return;
    }
    if trace.generation.is_some() { if let Ok(value)=serde_json::from_slice::<Value>(&request.body) { trace.capture("request",&value); } }
    let (body, streaming, chat) = match payload(&request) {
        Ok(v) => v,
        Err(message) => {
            trace.result(400, "validation_error");
            if trace.generation.is_some() { trace.entry.detail.response=Some(json!({"error":{"message":message}})); }
            let _ = reply(stream, 400, &message).await;
            return;
        }
    };
    let model = body["model"].clone();
    trace.entry.model = model.as_str().map(str::to_owned);
    trace.entry.streaming = streaming;
    // CC Switch carries its client session in prompt_cache_key. Hash it before
    // storing affinity; never send a multi-account tool history to a new account.
    let affinity = request.session.clone().or_else(|| body.get("prompt_cache_key").and_then(Value::as_str).map(|key| {
        use sha2::Digest;
        hex::encode(sha2::Sha256::digest(key.as_bytes()))
    }));
    let uses_tools = body.get("tools").and_then(Value::as_array).is_some_and(|v| !v.is_empty())
        || body.get("input").and_then(Value::as_array).is_some_and(|items| items.iter().any(|item| matches!(item.get("type").and_then(Value::as_str), Some("function_call" | "function_call_output" | "reasoning"))));
    if shared.pool.len() > 1 && uses_tools && affinity.is_none() {
        trace.result(400, "affinity_required");
        let _ = reply(stream, 400, "多账号工具会话必须提供 prompt_cache_key 或 X-CloudHub-Session，请固定会话或仅选择一个服务账号").await;
        return;
    }
    let id = match route(shared, affinity.as_deref()) {
        Ok(v) => v,
        Err(message) => {
            trace.result(503, "no_available_account");
            let _ = reply(stream, 503, &message).await;
            return;
        }
    };
    trace.entry.account_id = Some(id);
    let forward = async {
        trace.capture("forwarded",&body);
        #[cfg(test)]
        {
            let endpoint = shared.test_endpoint.lock().unwrap().clone();
            if let Some(endpoint) = endpoint {
                let response = shared
                    .client
                    .post(endpoint)
                    .json(&body)
                    .send()
                    .await
                    .map_err(|_| (502u16, "连接上游失败，请检查网络".into()))?;
                return if response.status().is_success() {
                    Ok(response)
                } else {
                    Err(upstream_http_error(response.status().as_u16(), &[]))
                };
            }
        }
        upstream(&shared.client, id, body, Some(&mut *trace)).await
    };
    let mut closed = [0u8; 1];
    let forwarded =
        tokio::select! { response=forward=>response, _=stream.read(&mut closed)=>return };
    let mut response = match forwarded {
        Ok(v) => v,
        Err((code, message)) => {
            trace.result(code, "upstream_error");
            trace.entry.upstream_status = message.strip_prefix("上游返回 HTTP ").and_then(|s| s.split('：').next()).and_then(|s| s.parse().ok());
            let cooldown = shared.controls.lock().map(|c| c.settings.cooldown_seconds).unwrap_or(60);
            if let Ok(mut routes) = shared.routes.lock() {
                routes.failed += 1;
                if code != 400 { routes.cooldown.insert(
                    id,
                    Instant::now() + Duration::from_secs(if code == 401 { cooldown.max(300) } else { cooldown }),
                ); }
            }
            if trace.generation.is_some() { trace.entry.detail.response=Some(json!({"error":{"message":message}})); }
            let _ = reply(stream, code, &message)
            .await;
            return;
        }
    };
    trace.entry.upstream_status = Some(200);
    if streaming && stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n").await.is_err() { return; }
    let response_id = format!("chatcmpl-{}", uuid::Uuid::new_v4());
    let mut decoder = SseDecoder::default();
    let mut completed = None;
    let mut failed = false;
    loop {
        // Peer closing its receive side cancels the upstream response immediately.
        let mut disconnect = [0u8; 1];
        let chunk = tokio::select! {
            chunk=response.chunk()=>match chunk {Ok(Some(chunk))=>chunk,_=>break},
            closed=stream.read(&mut disconnect)=>{if matches!(closed, Ok(0) | Err(_)){return;} failed=true;break;}
        };
        let events = match decoder.feed(&chunk) {
            Ok(events) => events,
            Err(_) => {
                failed = true;
                break;
            }
        };
        for mut value in events {
            if trace.generation.is_some() { trace.entry.detail.event(&value); }
            let kind = value
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if matches!(
                kind.as_str(),
                "error" | "response.failed" | "response.incomplete"
            ) {
                failed = true;
                break;
            }
            if kind == "response.completed" {
                completed = value.get("response").cloned();
            }
            if streaming {
                if chat {
                    if kind == "response.output_text.delta" {
                        value = json!({"id":response_id,"object":"chat.completion.chunk","model":model,"choices":[{"index":0,"delta":{"content":value["delta"]},"finish_reason":null}]});
                    } else if kind == "response.completed" {
                        value = json!({"id":response_id,"object":"chat.completion.chunk","model":model,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
                    } else {
                        continue;
                    }
                }
                if event(stream, &value).await.is_err() {
                    return;
                }
            }
        }
        if failed || completed.is_some() {
            break;
        }
    }
    if completed.is_none() {
        failed = true;
    }
    if let Ok(mut routes) = shared.routes.lock() {
        if failed {
            routes.failed += 1;
        } else {
            routes.completed += 1;
        }
    }
    trace.result(if failed && !streaming { 502 } else { 200 }, if failed { "stream_error" } else { "completed" });
    if let Some(value) = &completed {
        trace.capture("response",value);
        trace.entry.input_tokens = value.pointer("/usage/input_tokens").and_then(Value::as_u64);
        trace.entry.output_tokens = value.pointer("/usage/output_tokens").and_then(Value::as_u64);
    }
    if failed {
        if trace.generation.is_some() { trace.entry.detail.response=Some(json!({"error":{"message":"上游流中断，请重试"}})); }
        if streaming {
            let _=event(stream,&json!({"type":"error","error":{"message":"上游流中断，请重试","type":"cloudhub_gateway_error"}})).await;
        } else {
            let _ = reply(stream, 502, "上游流中断，请重试").await;
        }
    } else if streaming {
        if chat {
            let _ = stream.write_all(b"data: [DONE]\n\n").await;
        }
    } else if let Some(value) = completed {
        let value = if chat {
            let text = value
                .get("output")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|item| item.get("content").and_then(Value::as_array))
                .flatten()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("");
            json!({"id":response_id,"object":"chat.completion","model":model,"choices":[{"index":0,"message":{"role":"assistant","content":text},"finish_reason":"stop"}],"usage":value.get("usage")})
        } else {
            value
        };
        trace.capture("response",&value);
        let _ = json_reply(stream, 200, &value).await;
    }
}

pub async fn wake(id: i64, model: String) -> Result<(), String> {
    if !model_valid(&model) {
        return Err("唤醒模型名称无效".into());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|_| "初始化唤醒请求失败")?;
    let mut response=upstream(&client,id,json!({"model":model,"instructions":"","input":[{"role":"user","content":[{"type":"input_text","text":"Reply with OK."}]}],"stream":true,"store":false,"tools":[]}),None).await.map_err(|_|"唤醒请求失败，请检查登录、模型权限或额度")?;
    let mut decoder = SseDecoder::default();
    let mut completed = false;
    while let Some(chunk) = response.chunk().await.map_err(|_| "唤醒响应中断")? {
        for value in decoder.feed(&chunk)? {
            match value.get("type").and_then(Value::as_str) {
                Some("response.completed") => completed = true,
                Some("error" | "response.failed" | "response.incomplete") => {
                    return Err("唤醒请求被上游中断".into())
                }
                _ => {}
            }
        }
        if completed {
            break;
        }
    }
    if !completed {
        return Err("唤醒请求未完成".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn routing_rules_respect_quota_cooldown_and_existing_tool_sessions() {
        let server = RunningGateway::start(0, vec![1,2,3]).await.unwrap();
        assert_eq!(route(&server.shared, None).unwrap(), 1);
        assert_eq!(route(&server.shared, None).unwrap(), 2);
        assert_eq!(route(&server.shared, Some("test-only-session")).unwrap(), 3);
        {
            let mut controls = server.shared.controls.lock().unwrap();
            controls.settings.strategy = RoutingStrategy::Ordered;
        }
        assert_eq!(route(&server.shared, None).unwrap(), 1);
        assert_eq!(route(&server.shared, Some("test-only-session")).unwrap(), 3);
        let now = chrono::Utc::now().timestamp_millis();
        let quota = |used| super::super::QuotaSnapshot { fetched_at:Some(now), windows:vec![super::super::QuotaWindow { name:"test".into(), used_percent:used, resets_at:None, window_minutes:Some(300) }] };
        {
            let mut controls = server.shared.controls.lock().unwrap();
            controls.settings.strategy = RoutingStrategy::QuotaFirst;
            controls.quotas.insert(1,quota(80.0)); controls.quotas.insert(2,quota(10.0)); controls.quotas.insert(3,quota(100.0));
        }
        assert_eq!(route(&server.shared, None).unwrap(), 2);
        assert_eq!(route(&server.shared, Some("test-only-session")).unwrap(), 3);
        server.shared.routes.lock().unwrap().cooldown.insert(2,Instant::now()+Duration::from_secs(60));
        assert_eq!(route(&server.shared, None).unwrap(), 1);
        server.shared.routes.lock().unwrap().cooldown.insert(3,Instant::now()+Duration::from_secs(60));
        assert!(route(&server.shared, Some("test-only-session")).is_err());
        server.shared.controls.lock().unwrap().quotas.insert(1,quota(100.0));
        assert!(route(&server.shared,None).is_err());
        let mut stale=quota(100.0);stale.fetched_at=Some(now-16*60*1000);
        server.shared.controls.lock().unwrap().quotas.insert(1,stale);
        assert_eq!(route(&server.shared,None).unwrap(),1);
    }
    #[tokio::test]
    async fn call_logs_record_safe_success_and_rejection_without_request_content() {
        let server = RunningGateway::start(0,vec![1]).await.unwrap();
        server.shared.controls.lock().unwrap().apply(GatewaySettings { logging_enabled:true,..Default::default() });
        let (endpoint,task)=fixture(format!("data: {}\n\n",json!({"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":3,"output_tokens":2}}})),200).await;
        *server.shared.test_endpoint.lock().unwrap()=Some(endpoint);
        let client=reqwest::Client::new();
        let result=client.post(format!("{}/responses",server.address)).bearer_auth(server.shared.key.as_str()).json(&json!({"model":"gpt-test","input":"test-only-private-prompt","stream":false})).send().await.unwrap();
        assert_eq!(result.status(),200);let _=result.bytes().await.unwrap();task.await.unwrap();
        let rejected=client.post(format!("{}/responses",server.address)).bearer_auth("test-only-invalid-token").json(&json!({"model":"private-invalid-model","input":"private-content"})).send().await.unwrap();
        assert_eq!(rejected.status(),401);let _=rejected.bytes().await.unwrap();
        // The request guard writes when the worker finishes closing its socket.
        tokio::time::sleep(Duration::from_millis(30)).await;
        let logs=server.logs().unwrap();assert_eq!(logs.len(),2);
        assert_eq!(logs[0].status,401);assert_eq!(logs[0].model,None);
        assert_eq!(logs[1].account_id,Some(1));assert_eq!(logs[1].input_tokens,Some(3));
        let serialized=serde_json::to_string(&logs).unwrap();
        for secret in ["test-only-private-prompt","test-only-invalid-token","private-content","private-invalid-model",server.shared.key.as_str()] { assert!(!serialized.contains(secret)); }
        let detail=server.log_detail(&logs[1].id).unwrap();
        assert_eq!(detail.request.as_ref().unwrap()["stream"],false);
        assert_eq!(detail.forwarded.as_ref().unwrap()["stream"],true);
        assert_eq!(detail.response.as_ref().unwrap()["usage"]["input_tokens"],3);
        assert_eq!(detail.event_count,1);
        let serialized=serde_json::to_string(&detail).unwrap();
        for secret in ["test-only-private-prompt",server.shared.key.as_str()] { assert!(!serialized.contains(secret)); }
        assert!(server.log_detail("invalid").is_err());
        server.clear_logs().unwrap();assert!(server.logs().unwrap().is_empty());
        assert!(server.log_detail(&logs[1].id).is_err());
    }
    #[test]
    fn upstream_diagnostics_never_echo_provider_text_or_unknown_parameters() {
        let body = json!({"error":{"message":"Unsupported parameter test-only-private-value", "param":"test-only-secret"}}).to_string();
        let (code, message) = upstream_http_error(400, body.as_bytes());
        assert_eq!(code, 400);
        assert_eq!(message, "上游返回 HTTP 400：请求参数不受支持");
        let body = json!({"error":{"message":"Unsupported parameter", "param":"reasoning"}}).to_string();
        assert_eq!(upstream_http_error(422, body.as_bytes()).1, "上游返回 HTTP 422：请求参数不受支持，参数 reasoning");
        assert_eq!(upstream_http_error(429, b"private text").0, 429);
        assert_eq!(upstream_http_error(500, b"private text").0, 502);
    }
    #[test]
    fn sse_retains_split_utf8_and_rejects_incomplete_or_oversize_events() {
        let mut decoder = SseDecoder::default();
        let data = format!(
            "data: {}\r\n\r\ndata: {}\n\n",
            json!({"type":"response.output_text.delta","delta":"你好🌧"}),
            json!({"type":"response.completed","response":{"status":"completed"}})
        );
        let mut values = Vec::new();
        for byte in data.as_bytes() {
            values.extend(decoder.feed(&[*byte]).unwrap());
        }
        assert_eq!(values[0]["delta"], "你好🌧");
        assert_eq!(values[1]["type"], "response.completed");
        assert!(decoder.feed(&vec![b'x'; 1024 * 1024 + 1]).is_err());
        assert!(SseDecoder::default()
            .feed(b"data: invalid-json\n\n")
            .is_err());
    }
    async fn fixture(body: String, status: u16) -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let endpoint = format!("http://{}/responses", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0u8; 2048];
                let count = stream.read(&mut chunk).await.unwrap();
                if count == 0 {
                    return;
                }
                bytes.extend_from_slice(&chunk[..count]);
                if bytes.windows(4).any(|v| v == b"\r\n\r\n") {
                    break;
                }
            }
            stream.write_all(format!("HTTP/1.1 {status} Response\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).as_bytes()).await.unwrap();
            for chunk in body.as_bytes().chunks(if body.len() > MAX_BODY { 8192 } else { 3 }) {
                if stream.write_all(chunk).await.is_err() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        });
        (endpoint, task)
    }
    #[tokio::test]
    async fn forward_converts_chat_preserves_unicode_and_hides_provider_errors() {
        let body = format!(
            "data: {}\n\ndata: {}\n\n",
            json!({"type":"response.output_text.delta","delta":"你好🌧"}),
            json!({"type":"response.completed","response":{"id":"response-fixture","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"你好🌧"}]}]}})
        );
        let (endpoint, fixture_task) = fixture(body, 200).await;
        let server = RunningGateway::start(0, vec![1]).await.unwrap();
        *server.shared.test_endpoint.lock().unwrap() = Some(endpoint);
        let client = reqwest::Client::new();
        let response = client
            .post(format!("{}/chat/completions", server.address))
            .bearer_auth(server.shared.key.as_str())
            .json(&json!({"model":"gpt-test","messages":[{"role":"user","content":"hello"}]}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 200);
        let value: Value = response.json().await.unwrap();
        assert_eq!(value["choices"][0]["message"]["content"], "你好🌧");
        fixture_task.await.unwrap();
        assert_eq!(server.summary().unwrap().completed, 1);
        let (endpoint,fixture_task)=fixture("data: {\"type\":\"response.failed\",\"error\":{\"message\":\"provider-private-detail\"}}\n\n".into(),200).await;
        *server.shared.test_endpoint.lock().unwrap() = Some(endpoint);
        let response = client
            .post(format!("{}/responses", server.address))
            .bearer_auth(server.shared.key.as_str())
            .json(&json!({"model":"gpt-test","input":"hello","stream":true}))
            .send()
            .await
            .unwrap();
        let text = response.text().await.unwrap();
        assert!(text.contains("cloudhub_gateway_error"));
        assert!(!text.contains("provider-private-detail"));
        fixture_task.await.unwrap();
        assert_eq!(server.summary().unwrap().failed, 1);
    }
    #[tokio::test]
    async fn stopping_gateway_cancels_an_active_upstream_stream() {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let endpoint = format!("http://{}/responses", listener.local_addr().unwrap());
        let (closed_sender, closed_receiver) = tokio::sync::oneshot::channel();
        let fixture_task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut block = [0u8; 2048];
            loop {
                let count = stream.read(&mut block).await.unwrap();
                bytes.extend_from_slice(&block[..count]);
                if bytes.windows(4).any(|v| v == b"\r\n\r\n") {
                    break;
                }
            }
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"type\":\"response.created\"}\n\n").await.unwrap();
            loop {
                match stream.read(&mut block).await {
                    Ok(0) | Err(_) => {
                        let _ = closed_sender.send(());
                        break;
                    }
                    Ok(_) => {}
                }
            }
        });
        let server = RunningGateway::start(0, vec![1]).await.unwrap();
        *server.shared.test_endpoint.lock().unwrap() = Some(endpoint);
        let response = reqwest::Client::new()
            .post(format!("{}/responses", server.address))
            .bearer_auth(server.shared.key.as_str())
            .json(&json!({"model":"gpt-test","input":"hello","stream":true}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 200);
        drop(server);
        tokio::time::timeout(Duration::from_secs(2), closed_receiver)
            .await
            .unwrap()
            .unwrap();
        fixture_task.await.unwrap();
        drop(response);
    }
    #[test]
    fn input_boundary_rejects_tools_storage_and_unknown_fields() {
        let request = |body: Value| Request {
            path: "/v1/responses".into(),
            session: None,
            body: Zeroizing::new(body.to_string().into_bytes()),
        };
        assert!(payload(&request(
            json!({"model":"gpt-test","input":"hello","tools":[{"type":"shell"}]})
        ))
        .is_err());
        assert!(payload(&request(
            json!({"model":"gpt-test","input":"hello","store":true})
        ))
        .is_err());
        assert!(payload(&request(
            json!({"model":"gpt-test","input":"hello","base_url":"http://untrusted"})
        ))
        .is_err());
        let (body, stream, chat) =
            payload(&request(json!({"model":"gpt-test","input":"你好"}))).unwrap();
        assert_eq!(body["input"][0]["content"][0]["text"], "你好");
        assert!(!stream);
        assert!(!chat);
        assert!(!authorized("wrong", "correct"));
        assert!(authorized("correct", "correct"));
    }
    #[tokio::test]
    async fn custom_service_key_is_validated_and_used_without_being_serialized() {
        for value in ["short".to_string(), "a".repeat(257), "a ".repeat(16), "密钥".repeat(16)] {
            let result = RunningGateway::start_with_key(0, vec![1], Some(value.clone())).await;
            let error = result.err().expect("invalid custom key must fail");
            assert!(!error.contains(&value));
        }
        let fake_key = "test-only-".repeat(4);
        let server = RunningGateway::start_with_key(0, vec![1], Some(fake_key.clone())).await.unwrap();
        assert_eq!(server.shared.key.as_str(), fake_key);
        let summary = serde_json::to_string(&server.summary().unwrap()).unwrap();
        assert!(!summary.contains(&fake_key));
        assert!(server.summary().unwrap().supports_custom_key);
        let client = reqwest::Client::new();
        for (key, status) in [("incorrect", 401), (fake_key.as_str(), 400)] {
            let response = client.post(format!("{}/responses", server.address)).bearer_auth(key)
                .json(&json!({"model":"gpt-test","input":"hello","tools":[{}]})).send().await.unwrap();
            assert_eq!(response.status().as_u16(), status);
        }
    }
    #[tokio::test]
    async fn remote_catalog_does_not_replace_failed_upstream_with_bundled_ids() {
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
        let (url, task) = fixture(json!({"models":[{"slug":"remote-test","visibility":"list"},{"slug":"hidden-test","visibility":"hide"}]}).to_string(),200).await;
        assert_eq!(fetch_catalog(&client,"test-only-token",Some("test-only-account"),Some("0.162.0"),Some(&url)).await.unwrap(),vec!["remote-test"]);
        task.await.unwrap();
        for (body,status) in [("test-only-secret".to_string(),401),(json!({"data":[{"id":"bundled-test"}]}).to_string(),200)] {
            let (url,task) = fixture(body,status).await;
            let error = fetch_catalog(&client,"test-only-token",Some("test-only-account"),Some("0.162.0"),Some(&url)).await.unwrap_err();
            assert!(!error.contains("test-only-secret"));
            assert!(!error.contains("test-only-token"));
            task.await.unwrap();
        }
        let (url,task) = fixture(json!({"data":[{"id":"api-test"}]}).to_string(),200).await;
        assert_eq!(fetch_catalog(&client,"test-only-key",None,None,Some(&url)).await.unwrap(),vec!["api-test"]);
        task.await.unwrap();
    }
    #[test]
    fn catalog_errors_expose_only_authored_diagnostics() {
        assert_eq!(public_catalog_error("模型目录响应无效"), "官方模型目录响应格式不兼容");
        assert_eq!(public_catalog_error("官方模型目录认证过期，请重新登录服务账号"), "官方模型目录认证过期，请重新登录服务账号");
        let unsafe_message = "provider secret=test-only-secret token=test-only-token";
        assert_eq!(public_catalog_error(unsafe_message), "模型目录获取失败，请检查服务账号登录、权限与网络");
        assert_eq!(public_catalog_error("官方模型目录返回 HTTP 400"), "官方模型目录返回 HTTP 400");
        assert_eq!(public_catalog_error("官方模型目录返回 HTTP 400 token=test-only"), "模型目录获取失败，请检查服务账号登录、权限与网络");
    }
    #[tokio::test]
    async fn catalog_metadata_has_a_separate_bounded_response_budget() {
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
        let body = json!({"models":[{"slug":"large-catalog-test","instructions":"x".repeat(MAX_BODY + 1)}]}).to_string();
        let (url, task) = fixture(body, 200).await;
        assert_eq!(fetch_catalog(&client, "test-only-token", Some("test-only-account"), Some("0.162.0"), Some(&url)).await.unwrap(), vec!["large-catalog-test"]);
        task.await.unwrap();
        let (url, task) = fixture("x".repeat(MAX_CATALOG_BODY + 1), 200).await;
        assert_eq!(fetch_catalog(&client, "test-only-token", Some("test-only-account"), Some("0.162.0"), Some(&url)).await.unwrap_err(), "模型目录响应过大");
        task.await.unwrap();
        let server = RunningGateway::start(0, vec![1]).await.unwrap();
        let host = server.address.strip_prefix("http://").unwrap().strip_suffix("/v1").unwrap();
        let mut stream = TcpStream::connect(host).await.unwrap();
        stream.write_all(format!("POST /v1/responses HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n", server.shared.key.as_str(), MAX_BODY + 1).as_bytes()).await.unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        assert!(response.starts_with(b"HTTP/1.1 413 "));
    }
    #[tokio::test]
    async fn responses_forward_tool_events_and_result_round_trip_with_account_affinity() {
        let server = RunningGateway::start(0, vec![1, 2]).await.unwrap();
        let tool = json!({"type":"function","name":"read_file","parameters":{"type":"object","properties":{"path":{"type":"string"}}},"strict":false});
        let call = json!({"type":"function_call","id":"fc-test","call_id":"call-test","name":"read_file","arguments":"{\"path\":\"fixture.test\"}"});
        let events = [
            json!({"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc-test","call_id":"call-test","name":"read_file","arguments":""}}),
            json!({"type":"response.function_call_arguments.delta","item_id":"fc-test","output_index":0,"delta":"{\"path\":\"fixture.test\"}"}),
            json!({"type":"response.output_item.done","output_index":0,"item":call}),
            json!({"type":"response.completed","response":{"id":"resp-test","status":"completed","output":[call]}}),
        ];
        let wire = events.iter().map(|event| format!("data: {event}\n\n")).collect::<String>();
        let (endpoint, task) = fixture(wire, 200).await;
        *server.shared.test_endpoint.lock().unwrap() = Some(endpoint);
        let client = reqwest::Client::new();
        let url = format!("{}/responses", server.address);
        let mut request = json!({"model":"gpt-test","input":"Read a test file","tools":[tool],"stream":true});
        assert_eq!(client.post(&url).bearer_auth(server.shared.key.as_str()).json(&request).send().await.unwrap().status().as_u16(), 400);
        request["prompt_cache_key"] = json!("test-only-session");
        let response = client.post(&url).bearer_auth(server.shared.key.as_str()).json(&request).send().await.unwrap();
        assert_eq!(response.status().as_u16(), 200);
        let wire = response.bytes().await.unwrap();
        let received = SseDecoder::default().feed(&wire).unwrap();
        assert_eq!(received, events);
        task.await.unwrap();
        let completed = json!({"type":"response.completed","response":{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Test file read"}]}]}});
        let (endpoint, task) = fixture(format!("data: {completed}\n\n"), 200).await;
        *server.shared.test_endpoint.lock().unwrap() = Some(endpoint);
        request["stream"] = json!(false);
        request["input"] = json!([{"role":"user","content":"Read a test file"},call,{"type":"function_call_output","call_id":"call-test","output":"test-only-file-content"}]);
        let response = client.post(&url).bearer_auth(server.shared.key.as_str()).json(&request).send().await.unwrap();
        assert_eq!(response.status().as_u16(), 200);
        assert_eq!(response.json::<Value>().await.unwrap(), completed["response"]);
        task.await.unwrap();
        let routes = server.shared.routes.lock().unwrap();
        assert_eq!(routes.completed, 2);
        assert_eq!(routes.sticky.len(), 1);
        assert_eq!(routes.sticky.values().next(), Some(&1));
        assert_eq!(routes.cursor, 1);
    }
    #[tokio::test]
    async fn models_route_requires_bearer_and_returns_only_normalized_catalog() {
        let server = RunningGateway::start(0, vec![1]).await.unwrap();
        let ids = catalog_ids(&json!({"data":[{"id":"display-only","model":"test-model","private":"must-not-leak"},{"id":"test-model"},{"id":"hidden-model","hidden":true},{"id":"ft:unsupported"}]})).unwrap();
        assert_eq!(ids, vec!["test-model"]);
        assert!(catalog_ids(&json!({"unexpected":"response"})).is_err());
        *server.shared.models.lock().await = Some((Instant::now(), ids));
        let client = reqwest::Client::new();
        let endpoint = format!("{}/models", server.address);
        assert_eq!(client.get(&endpoint).send().await.unwrap().status().as_u16(), 401);
        assert_eq!(client.get(&endpoint).bearer_auth("incorrect").send().await.unwrap().status().as_u16(), 401);
        let response = client.get(&endpoint).bearer_auth(server.shared.key.as_str()).send().await.unwrap();
        assert_eq!(response.status().as_u16(), 200);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body, json!({"object":"list","data":[{"id":"test-model","object":"model","created":0,"owned_by":"openai"}]}));
        assert!(!body.to_string().contains(server.shared.key.as_str()));
        assert!(server.summary().unwrap().supports_models);
        assert_eq!(server.summary().unwrap().completed, 0);
        assert_eq!(client.get(&endpoint).bearer_auth(server.shared.key.as_str()).header("Origin", "http://untrusted").send().await.unwrap().status().as_u16(), 403);
        assert_eq!(client.get(&endpoint).bearer_auth(server.shared.key.as_str()).body("bad").send().await.unwrap().status().as_u16(), 400);
        assert_eq!(server.models_query().await.unwrap(), vec!["test-model"]);
        let shared = server.shared.clone();
        let _blocked = shared.models.lock().await;
        let query = server.models_query();
        drop(server);
        assert!(tokio::time::timeout(Duration::from_secs(1), query).await.unwrap().is_err());
    }
    #[tokio::test]
    async fn loopback_server_enforces_authorization_and_owns_its_port() {
        let server = RunningGateway::start(0, vec![1]).await.unwrap();
        let address = server.address.strip_suffix("/v1").unwrap();
        let port = reqwest::Url::parse(address).unwrap().port().unwrap();
        assert!(RunningGateway::start(port, vec![1]).await.is_err());
        let client = reqwest::Client::new();
        let response = client
            .post(format!("{address}/v1/responses"))
            .json(&json!({"model":"gpt-test","input":"hello"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 401);
        let response = client
            .post(format!("{address}/v1/responses"))
            .bearer_auth(server.shared.key.as_str())
            .json(&json!({"model":"gpt-test","input":"hello","tools":[{}]}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 400);
        let response = client
            .post(format!("{address}/v1/responses"))
            .bearer_auth(server.shared.key.as_str())
            .header("Origin", "http://untrusted")
            .json(&json!({"model":"gpt-test","input":"hello"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 403);
        drop(server);
        tokio::task::yield_now().await;
        let _listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .unwrap();
    }
}
