use super::{profile, QuotaSnapshot, QuotaWindow};
use serde_json::{json, Value};

// Extract only allowlisted diagnostics. Provider text may contain credentials.
pub(crate) fn error_diagnostics(error: &Value) -> String {
    let raw = error.to_string();
    let lower = raw.to_ascii_lowercase();
    let mut parts = Vec::new();
    if let Some(code) = error.get("code").and_then(Value::as_i64) {
        parts.push(format!("rpc_code={code}"));
    }
    if let Some(status) = [error.get("status"), error.get("status_code"), error.pointer("/data/status")].into_iter().flatten()
        .filter_map(Value::as_u64).find(|status| (400..=599).contains(status)) {
        parts.push(format!("HTTP {status}"));
    }
    for marker in ["http ", "status=", "status: ", "status code ", "status code: "] {
        if let Some(start) = lower.find(marker) {
            let digits: String = lower[start + marker.len()..].chars().take_while(char::is_ascii_digit).collect();
            if let Ok(code @ 400..=599) = digits.parse::<u16>() {
                parts.push(format!("HTTP {code}"));
                break;
            }
        }
    }
    for code in ["invalid_refresh_token", "refresh_token_reused", "refresh_token_expired", "invalid_grant", "token_expired", "invalid_api_key", "insufficient_quota", "rate_limit_exceeded", "account_deactivated"] {
        if lower.split(|c: char| !c.is_ascii_alphanumeric() && c != '_').any(|word| word == code) {
            parts.push(format!("error_code={code}"));
        }
    }
    parts.push(format!("error_bytes={}", raw.len()));
    parts.join(", ")
}
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver},
        Arc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

pub struct AppServer {
    child: Child,
    #[cfg(windows)]
    job: super::process::OwnedJob,
    stdin: ChildStdin,
    messages: Receiver<Value>,
    reader: Option<JoinHandle<()>>,
    sequence: u64,
    notifications: VecDeque<Value>,
    cancelled: Option<Arc<AtomicBool>>,
}

impl AppServer {
    pub fn start(home: &Path) -> Result<Self, String> {
        Self::start_cancelled(home, None)
    }

    pub fn start_cancelled(
        home: &Path,
        cancelled: Option<Arc<AtomicBool>>,
    ) -> Result<Self, String> { Self::start_cancelled_proxy(home,cancelled,None) }
    pub fn start_cancelled_proxy(home:&Path,cancelled:Option<Arc<AtomicBool>>,proxy:Option<&str>)->Result<Self,String> {
        let cli = profile::cli_path().ok_or("未找到 Codex CLI，请先安装官方 CLI 并加入 PATH")?;
        let mut command = Command::new(cli);
        command
            .args(["app-server", "--listen", "stdio://"])
            .env("CODEX_HOME", home)
            .env_remove("OPENAI_API_KEY")
            .env_remove("CODEX_API_KEY")
            .env_remove("CODEX_ACCESS_TOKEN")
            .current_dir(home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        super::account_controls::apply_proxy(&mut command,proxy)?;
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn().map_err(|_| "启动 Codex CLI 失败")?;
        #[cfg(windows)]
        let job = match super::process::OwnedJob::attach(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let stdin = child.stdin.take().ok_or("Codex CLI 输入不可用")?;
        let stdout = child.stdout.take().ok_or("Codex CLI 输出不可用")?;
        let (sender, messages) = mpsc::sync_channel(32);
        let reader = std::thread::spawn(move || {
            let mut stream = BufReader::new(stdout);
            loop {
                let mut bytes = Vec::new();
                let read = stream
                    .by_ref()
                    .take(1024 * 1024 + 1)
                    .read_until(b'\n', &mut bytes);
                if !read.is_ok_and(|count| count > 0 && count <= 1024 * 1024) {
                    break;
                }
                let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
                    continue;
                };
                if sender.try_send(value).is_err() {
                    break;
                }
            }
        });
        let mut server = Self {
            child,
            #[cfg(windows)]
            job,
            stdin,
            messages,
            reader: Some(reader),
            sequence: 0,
            notifications: VecDeque::new(),
            cancelled,
        };
        server.request("initialize", json!({"clientInfo":{"name":"cloudhub_tools","title":"CloudHub Tools","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}), Duration::from_secs(20))?;
        server.send(&json!({"method":"initialized"}))?;
        Ok(server)
    }

    fn send(&mut self, value: &Value) -> Result<(), String> {
        serde_json::to_writer(&mut self.stdin, value).map_err(|_| "发送 Codex 请求失败")?;
        self.stdin
            .write_all(b"\n")
            .and_then(|_| self.stdin.flush())
            .map_err(|_| "Codex CLI 已退出".into())
    }

    pub fn request(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        if self
            .cancelled
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::SeqCst))
        {
            return Err("Codex 请求已取消".into());
        }
        self.sequence += 1;
        let id = self.sequence;
        self.send(&json!({"id":id,"method":method,"params":params}))?;
        let deadline = Instant::now() + timeout;
        loop {
            if self
                .cancelled
                .as_ref()
                .is_some_and(|flag| flag.load(Ordering::SeqCst))
            {
                return Err("Codex 请求已取消".into());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("Codex 请求超时，请检查网络或重新登录".into());
            }
            let message = match self
                .messages
                .recv_timeout(remaining.min(Duration::from_millis(100)))
            {
                Ok(message) => message,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => return Err("Codex 客户端已退出，请检查网络和 CLI 版本".into()),
            };
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                if message.get("method").and_then(Value::as_str)
                    == Some("account/chatgptAuthTokens/refresh")
                {
                    if let Some(request_id) = message.get("id") {
                        self.send(&json!({"id":request_id,"error":{"code":-32000,"message":"Reauthentication required"}}))?;
                    }
                    return Err("Codex 登录已过期，请重新登录或从当前客户端重新导入".into());
                }
                if message.get("method").is_some() && self.notifications.len() < 100 {
                    self.notifications.push_back(message);
                }
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(format!("Codex 请求失败；阶段：{method}；{}。请检查登录状态、额度与 CLI 版本后重试", error_diagnostics(error)));
            }
            return message
                .get("result")
                .cloned()
                .ok_or_else(|| "Codex 返回格式无效".into());
        }
    }

    pub fn notification(&mut self) -> Option<Value> {
        self.notifications
            .pop_front()
            .or_else(|| self.messages.try_recv().ok())
    }
}

impl Drop for AppServer {
    fn drop(&mut self) {
        #[cfg(windows)]
        self.job.terminate();
        // Windows CLI launchers can spawn the real executable. Closing only the launcher
        // leaves stdout inherited by that child and hangs the reader join indefinitely.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let _ = Command::new("taskkill.exe")
                .args(["/PID", &self.child.id().to_string(), "/T", "/F"])
                .creation_flags(0x08000000)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        #[cfg(unix)]
        {
            let _ = Command::new("kill")
                .args(["-TERM", "--", &format!("-{}", self.child.id())])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

pub fn parse_quota(value: &Value) -> Result<QuotaSnapshot, String> {
    let limits: Vec<(&str, &Value)> = if let Some(map) = value
        .get("rateLimitsByLimitId")
        .and_then(Value::as_object)
        .filter(|m| !m.is_empty())
    {
        map.iter().map(|(k, v)| (k.as_str(), v)).collect()
    } else {
        vec![(
            "codex",
            value.get("rateLimits").ok_or("Codex 暂未提供额度信息")?,
        )]
    };
    let mut windows = Vec::new();
    for (limit, snapshot) in limits.into_iter().take(30) {
        for (key, label) in [("primary", "主要窗口"), ("secondary", "次要窗口")] {
            let Some(window) = snapshot.get(key).filter(|v| !v.is_null()) else {
                continue;
            };
            let percent = window
                .get("usedPercent")
                .and_then(Value::as_f64)
                .filter(|p| p.is_finite() && (0.0..=100.0).contains(p))
                .ok_or("Codex 额度百分比格式无效")?;
            let minutes = window
                .get("windowDurationMins")
                .and_then(Value::as_u64)
                .filter(|m| *m > 0 && *m <= 525_600);
            windows.push(QuotaWindow {
                name: format!("{} · {label}", limit.chars().take(80).collect::<String>()),
                used_percent: percent,
                window_minutes: minutes,
                resets_at: window
                    .get("resetsAt")
                    .and_then(Value::as_i64)
                    .filter(|v| *v >= 0 && *v <= 32_503_680_000),
            });
        }
    }
    if windows.is_empty() {
        return Err("Codex 暂未提供额度窗口，请稍后刷新".into());
    }
    Ok(QuotaSnapshot {
        windows,
        fetched_at: Some(chrono::Utc::now().timestamp_millis()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires the installed official Codex CLI; uses an empty isolated profile"]
    fn codex_cli_handshake_without_user_credentials() {
        let profile = profile::TemporaryProfile::new("{}").unwrap();
        let mut server = AppServer::start(&profile.path).unwrap();
        let models = server.request("model/list", json!({"limit":100,"includeHidden":false,"cursor":null}), Duration::from_secs(30)).unwrap();
        assert!(models.get("data").and_then(Value::as_array).is_some());
        drop(server);
        let path = profile.path.clone();
        drop(profile);
        assert!(!path.exists());
    }
    #[test]
    fn error_details_keep_codes_without_provider_secrets() {
        let error = json!({"code":-32000,"message":"Token refresh failed: status=401 Unauthorized error_code=invalid_refresh_token access_token=test-only-secret"});
        let detail = error_diagnostics(&error);
        assert!(detail.contains("HTTP 401"));
        assert!(detail.contains("invalid_refresh_token"));
        assert!(detail.contains("rpc_code=-32000"));
        assert!(!detail.contains("test-only-secret"));
        assert!(!detail.contains("access_token"));
    }
    #[test]
    fn quota_uses_current_multiple_windows_and_legacy_fallback() {
        let primary = json!({"usedPercent":27,"windowDurationMins":300,"resetsAt":2000000000});
        let snapshot = parse_quota(&json!({"rateLimitsByLimitId":{"codex":{"primary":primary},"other":{"secondary":{"usedPercent":100}}}})).unwrap();
        assert_eq!(snapshot.windows.len(), 2);
        assert_eq!(snapshot.windows[0].window_minutes, Some(300));
        assert_eq!(
            parse_quota(&json!({"rateLimits":{"primary":primary}}))
                .unwrap()
                .windows
                .len(),
            1
        );
        assert!(parse_quota(&json!({"rateLimits":{"primary":{"usedPercent":101}}})).is_err());
        assert!(parse_quota(&json!({"rateLimits":null})).is_err());
    }
}
