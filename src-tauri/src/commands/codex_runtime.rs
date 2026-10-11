use crate::core::{
    codex::{auth, profile, rpc},
    error::PlatformResult,
};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

#[derive(Default, Clone)]
pub(crate) struct CodexRuntimeStore {
    pub login: Arc<Mutex<Option<PendingLogin>>>,
    pub instances: Arc<Mutex<HashMap<String, super::codex_instances::ManagedInstance>>>,
    pub gateway: Arc<Mutex<Option<crate::core::codex::gateway::RunningGateway>>>,
    pub wakes: Arc<Mutex<HashSet<i64>>>,
    pub closing: Arc<AtomicBool>,
}

pub(crate) struct PendingLogin {
    token: String,
    // Server is dropped before its credential directory is removed.
    server: rpc::AppServer,
    profile: profile::TemporaryProfile,
    expires: Instant,
}

impl CodexRuntimeStore {
    pub fn cleanup_expired(&self) {
        if let Ok(mut pending) = self.login.try_lock() {
            if pending
                .as_ref()
                .is_some_and(|v| v.expires <= Instant::now())
            {
                *pending = None;
            }
        }
    }
    pub fn shutdown(&self) {
        self.closing.store(true, Ordering::SeqCst);
        if let Ok(mut gateway) = self.gateway.lock() {
            *gateway = None;
        }
        if let Ok(mut pending) = self.login.lock() {
            *pending = None;
        }
        super::codex_instances::stop_all(self);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoginStart {
    token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoginPoll {
    status: &'static str,
}

#[tauri::command]
pub(crate) async fn codex_start_login(app: tauri::AppHandle) -> PlatformResult<LoginStart> {
    tauri::async_runtime::spawn_blocking(move || -> Result<LoginStart, String> {
        let store = app.state::<CodexRuntimeStore>();
        store.cleanup_expired();
        let mut slot = store.login.lock().map_err(|_| "Codex 登录状态不可用")?;
        if store.closing.load(Ordering::SeqCst) {
            return Err("应用正在退出，未启动登录".into());
        }
        if slot.is_some() {
            return Err("已有 Codex 登录等待完成，请先完成或取消".into());
        }
        let profile = profile::TemporaryProfile::new("{}")?;
        let mut server = rpc::AppServer::start(&profile.path)?;
        let result = server.request(
            "account/login/start",
            serde_json::json!({"type":"chatgpt"}),
            Duration::from_secs(30),
        )?;
        let url = result
            .get("authUrl")
            .and_then(serde_json::Value::as_str)
            .filter(|v| v.len() < 16_384)
            .ok_or("当前 Codex CLI 不支持浏览器登录，请更新 CLI")?;
        let parsed = reqwest::Url::parse(url).map_err(|_| "Codex 返回的登录地址无效")?;
        if parsed.scheme() != "https"
            || !matches!(parsed.host_str(), Some("auth.openai.com" | "chatgpt.com"))
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err("Codex 返回的登录地址不可信".into());
        }
        let token = uuid::Uuid::new_v4().to_string();
        if store.closing.load(Ordering::SeqCst) {
            return Err("应用正在退出，已取消登录".into());
        }
        tauri_plugin_opener::open_url(url, None::<&str>)
            .map_err(|_| "无法打开 Codex 官方登录页面")?;
        *slot = Some(PendingLogin {
            token: token.clone(),
            server,
            profile,
            expires: Instant::now() + Duration::from_secs(300),
        });
        Ok(LoginStart { token })
    })
    .await
    .map_err(|_| "启动 Codex 登录任务失败")?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_poll_login(
    app: tauri::AppHandle,
    token: String,
) -> PlatformResult<LoginPoll> {
    tauri::async_runtime::spawn_blocking(move || -> Result<LoginPoll, String> {
        let _writer = super::codex::AUTH_WRITER
            .lock()
            .map_err(|_| "Codex 账号操作不可用")?;
        let store = app.state::<CodexRuntimeStore>();
        let mut slot = store.login.lock().map_err(|_| "Codex 登录状态不可用")?;
        let pending = slot
            .as_mut()
            .filter(|v| v.token == token)
            .ok_or("Codex 登录已取消或过期")?;
        if pending.expires <= Instant::now() {
            *slot = None;
            return Err("Codex 登录已过期，请重新授权".into());
        }
        // Read completed auth directly in Rust; tokens never enter the UI notification.
        let imported = profile::read_auth(&pending.profile.path.join("auth.json"))
            .ok()
            .and_then(|v| auth::parse_import(&v).ok());
        if let Some(accounts) = imported {
            super::codex::import_accounts(&app, accounts)?;
            *slot = None;
            return Ok(LoginPoll {
                status: "completed",
            });
        }
        while let Some(notification) = pending.server.notification() {
            if notification
                .get("method")
                .and_then(serde_json::Value::as_str)
                == Some("account/login/completed")
                && notification
                    .pointer("/params/success")
                    .and_then(serde_json::Value::as_bool)
                    == Some(false)
            {
                *slot = None;
                return Err("Codex 授权未完成或被拒绝，请重新登录".into());
            }
        }
        Ok(LoginPoll { status: "pending" })
    })
    .await
    .map_err(|_| "检查 Codex 登录任务失败")?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_cancel_login(app: tauri::AppHandle, token: String) -> PlatformResult<()> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let store = app.state::<CodexRuntimeStore>();
        let mut slot = store.login.lock().map_err(|_| "Codex 登录状态不可用")?;
        if slot.as_ref().is_some_and(|v| v.token == token) {
            *slot = None;
        }
        Ok(())
    })
    .await
    .map_err(|_| "取消 Codex 登录任务失败")?
    .map_err(Into::into)
}
