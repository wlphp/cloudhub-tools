//! Desktop-only companion, bounded background monitoring and local preferences.
use crate::core::{
    error::PlatformResult,
    pet_alerts::{expiry_severity, panel_access_alert, panel_metric_alert, severity_rank, reconcile, retire_missing, Alert},
    repositories::{assets, certificates, panel_connections, preferences},
    storage::open_db,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager};
mod docking;
mod computer;

const CONFIG: &str = "desktop-pet-config-v1";
const HISTORY: &str = "desktop-pet-alerts-v1";
const POSITION: &str = "desktop-pet-position-v1";
const LABEL: &str = "desktop-pet";
const NOTICE_LABEL: &str = "desktop-pet-alert";

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub enabled: bool,
    pub appearance: String,
    pub monitoring: bool,
    pub panels: bool,
    pub panel_access: bool,
    pub certificates: bool,
    pub servers: bool,
    pub size: u32,
    pub roam: String,
    pub activity: u32,
    pub sound: bool,
    pub reduced_motion: bool,
    pub quiet: bool,
    pub interval_seconds: u64,
    pub expiry_days: i64,
    pub cpu_threshold: f64,
    pub disk_threshold: f64,
    pub keep_in_tray: bool,
    pub life: crate::core::pet_life::LifeSettings,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            appearance: "alpaca".into(),
            monitoring: false,
            panels: false,
            panel_access: true,
            certificates: true,
            servers: true,
            size: 120,
            roam: "edge".into(),
            activity: 1,
            sound: false,
            reduced_motion: false,
            quiet: false,
            interval_seconds: 300,
            expiry_days: 30,
            cpu_threshold: 90.,
            disk_threshold: 90.,
            keep_in_tray: false,
            life: Default::default(),
        }
    }
}
impl Settings {
    fn validate(&self) -> Result<(), String> {
        self.life.validate()?;
        if !["alpaca", "dog", "penguin", "fish"].contains(&self.appearance.as_str()) || !(80..=240).contains(&self.size)
            || !["edge", "free", "still"].contains(&self.roam.as_str())
            || self.activity > 2
            || !(60..=3600).contains(&self.interval_seconds)
            || !(1..=365).contains(&self.expiry_days)
            || !self.cpu_threshold.is_finite()
            || !(50.0..=100.0).contains(&self.cpu_threshold)
            || !self.disk_threshold.is_finite()
            || !(50.0..=100.0).contains(&self.disk_threshold)
        {
            return Err("桌宠设置无效".into());
        }
        Ok(())
    }
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Snapshot {
    pub alerts: Vec<Alert>,
    pub checked_at: i64,
    pub last_error: Option<String>,
}
#[derive(Default)]
pub struct PetStore {
    pub checking: AtomicBool,
    pub expanded: AtomicBool,
    pub docked: Mutex<Option<(i32, i32)>>,
    pub tray_ready: AtomicBool,
    pub size: AtomicU32,
    pub sprite: Mutex<(u32, u32, bool, usize)>,
    pub regions: Mutex<Vec<[f64; 4]>>,
    pub notice: Mutex<Option<Alert>>,
    pub failures: Mutex<HashMap<String, u32>>,
    pub last_manual: Mutex<i64>,
    pub life: Mutex<crate::core::pet_life::LifeState>,
    pub life_checking: AtomicBool,
}

fn read_settings() -> Result<Settings, String> {
    let all = preferences::list(&open_db()?)?;
    let settings: Settings = all
        .get(CONFIG)
        .map(|v| serde_json::from_str(v).map_err(|_| "桌宠设置读取失败".to_string()))
        .transpose()?
        .unwrap_or_default();
    settings.validate()?;
    Ok(settings)
}
fn snapshot() -> Result<Snapshot, String> {
    let all = preferences::list(&open_db()?)?;
    all.get(HISTORY)
        .map(|v| serde_json::from_str(v).map_err(|_| "提醒记录读取失败".to_string()))
        .transpose()
        .map(|v| v.unwrap_or_default())
}
fn save_json<T: Serialize>(key: &str, value: &T) -> Result<(), String> {
    preferences::save(
        &open_db()?,
        key,
        &serde_json::to_string(value).map_err(|_| "桌宠数据保存失败")?,
        chrono::Utc::now().timestamp_millis(),
    )
}
fn caller(window: &tauri::WebviewWindow) -> Result<(), String> {
    if ["main", LABEL, NOTICE_LABEL].contains(&window.label()) {
        Ok(())
    } else {
        Err("此窗口不支持桌宠操作".into())
    }
}
pub fn restricted<R: tauri::Runtime>(
    handler: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        if [LABEL, NOTICE_LABEL].contains(&invoke.message.webview_ref().label())
            && ![
                "pet_settings",
                "pet_snapshot",
                "pet_save_settings",
                "pet_show",
                "pet_hide",
                "pet_layout",
                "pet_move",
                "pet_open",
                "pet_computer_action",
                "pet_snooze",
                "pet_ignore",
                "pet_check",
                "pet_sprite",
                "pet_regions",
                "pet_notice",
                "pet_dismiss",
                "pet_chat_services",
                "pet_chat",
                "pet_chat_cancel",
                "pet_chat_read_image",
                "pet_life_state",
                "pet_life_action",
                "pet_life_weather",
            ]
            .contains(&invoke.message.command())
        {
            invoke.resolver.reject("桌宠窗口无权调用此命令");
            return true;
        }
        handler(invoke)
    }
}
#[tauri::command]
pub fn pet_settings(window: tauri::WebviewWindow) -> PlatformResult<Settings> {
    caller(&window)?;
    Ok(read_settings()?)
}

#[tauri::command]
pub async fn pet_computer_action(window: tauri::WebviewWindow, action: computer::ComputerAction) -> PlatformResult<()> {
    if window.label() != LABEL { return Err("电脑快捷操作仅允许从桌宠窗口执行".into()); }
    tauri::async_runtime::spawn_blocking(move || computer::run(action)).await
        .map_err(|_| "电脑快捷操作执行失败")?.map_err(Into::into)
}

const LIFE_HISTORY: &str = "desktop-pet-life-v1";
fn update_life(app: &tauri::AppHandle, change: impl FnOnce(&mut crate::core::pet_life::LifeState) -> Result<(), String>) -> Result<crate::core::pet_life::LifeState, String> {
    let store = app.state::<PetStore>();
    let mut guard = store.life.lock().map_err(|_| "生活提醒状态不可用")?;
    let mut next = guard.clone();
    change(&mut next)?;
    if next != *guard {
        save_json(LIFE_HISTORY, &next)?;
        *guard = next.clone();
        let _ = app.emit("pet-life-changed", &next);
    }
    Ok(next)
}
#[tauri::command]
pub fn pet_life_state(window: tauri::WebviewWindow, app: tauri::AppHandle) -> PlatformResult<crate::core::pet_life::LifeState> {
    caller(&window)?;
    Ok(app.state::<PetStore>().life.lock().map_err(|_| "生活提醒状态不可用")?.clone())
}
#[tauri::command]
pub fn pet_life_action(window: tauri::WebviewWindow, app: tauri::AppHandle, id: String, action: String) -> PlatformResult<crate::core::pet_life::LifeState> {
    caller(&window)?;
    if id.len() > 100 { return Err("生活提醒参数无效".into()); }
    let now = chrono::Utc::now().timestamp();
    if action == "openWeather" {
        use tauri_plugin_opener::OpenerExt;
        let state = app.state::<PetStore>().life.lock().map_err(|_| "生活提醒状态不可用")?.clone();
        let notice = state.notices.iter().find(|n| n.id == id && n.kind == "weather" && n.expires_at > now).ok_or("天气预警已过期")?;
        // Construct the destination from the validated ID, never use a provider-supplied URL.
        let key = notice.id.strip_prefix("weather:").filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit() || b == b'_')).ok_or("天气预警地址无效")?;
        app.opener().open_url(format!("https://www.nmc.cn/publish/alarm/{key}.html"), None::<&str>).map_err(|_| "无法打开天气预警原文")?;
        return Ok(state);
    }
    let config = read_settings()?;
    if !config.enabled || !config.life.enabled { return Err("请先启用桌宠与生活提醒".into()); }
    Ok(update_life(&app, |state| {
        if action == "testWater" {
            if state.notices.iter().any(|n| n.kind == "water" && n.created_at > now - 60) { return Err("请稍等一分钟再试".into()); }
            state.add(crate::core::pet_life::notice(format!("preview:{now}"), "water", "主人，该喝水啦！", "这是喝水提醒预览。喝几口水吧，我陪你活动一下。", now));
            Ok(())
        } else { state.action(&id, &action, now) }
    })?)
}
async fn life_weather(app: &tauri::AppHandle, manual: bool) -> Result<crate::core::pet_life::LifeState, String> {
    let config = read_settings()?;
    if !config.life.enabled || !config.life.weather || config.life.province.is_empty() { return Err("请先配置地区并启用天气预警".into()); }
    let store = app.state::<PetStore>();
    if store.life_checking.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() { return Err("天气预警正在查询".into()); }
    let result = async {
        let now = chrono::Utc::now().timestamp();
        update_life(app, |state| {
            if manual && now - state.weather_attempt_at < 60 { return Err("天气预警查询间隔至少一分钟".into()); }
            state.weather_attempt_at = now;
            Ok(())
        })?;
        let fetched = tokio::time::timeout(Duration::from_secs(35), crate::core::pet_life::fetch_weather(&config.life, now)).await
            .unwrap_or_else(|_| Err("天气预警查询超时，请稍后重试".into()));
        let current = read_settings()?;
        if !current.life.enabled || !current.life.weather || current.life.province != config.life.province || current.life.city != config.life.city {
            return Err("地区设置已改变，请重新查询".into());
        }
        update_life(app, |state| {
            match fetched {
                Ok(notices) => {
                    let ids: Vec<_> = notices.iter().map(|n| n.id.clone()).collect();
                    for n in &mut state.notices { if n.kind == "weather" && !ids.contains(&n.id) { n.expires_at = now; } }
                    for n in notices { state.add(n); }
                    state.weather_checked_at = now; state.weather_error = None;
                    state.region = format!("{}{}", config.life.province, config.life.city);
                }
                Err(error) => state.weather_error = Some(error),
            }
            Ok(())
        })
    }.await;
    store.life_checking.store(false, Ordering::SeqCst);
    result
}
#[tauri::command]
pub async fn pet_life_weather(window: tauri::WebviewWindow, app: tauri::AppHandle) -> PlatformResult<crate::core::pet_life::LifeState> {
    caller(&window)?;
    Ok(life_weather(&app, true).await?)
}

async fn life_tick(app: &tauri::AppHandle) {
    let Ok(config) = read_settings() else { return; };
    let now = chrono::Utc::now().timestamp();
    let Ok(state) = update_life(app, |state| {
        let region = format!("{}{}", config.life.province, config.life.city);
        if state.region != region {
            state.notices.retain(|n| n.kind != "weather");
            state.region = region; state.weather_checked_at = 0; state.weather_attempt_at = 0; state.weather_error = None;
        }
        crate::core::pet_life::tick(state, &config.life, now, config.quiet || !config.enabled);
        Ok(())
    }) else { return; };
    if config.life.enabled && config.life.weather && !config.life.province.is_empty() && now - state.weather_attempt_at >= 900 {
        let _ = life_weather(app, false).await;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatService {
    id: String,
    name: String,
    model: String,
    revision: i64,
    supports_images: bool,
}
fn chat_caller(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == LABEL { Ok(()) } else { Err("仅桌宠窗口支持聊天".into()) }
}
fn chat_error(message: String) -> crate::core::error::PlatformError {
    crate::core::error::PlatformError { kind: "ai", code: "ai", message, retryable: false }
}
#[tauri::command]
pub fn pet_chat_services(window: tauri::WebviewWindow) -> PlatformResult<Vec<ChatService>> {
    chat_caller(&window)?;
    Ok(crate::core::repositories::ai::list(&open_db()?)?.into_iter()
        .filter(|p| p.enabled).map(|p| ChatService { id: p.id, name: p.name, model: p.model, revision: p.updated_at, supports_images: p.vision_status == "supported" }).collect())
}
#[tauri::command]
pub async fn pet_chat_read_image(window: tauri::WebviewWindow, source_path: String) -> PlatformResult<String> {
    chat_caller(&window)?;
    tauri::async_runtime::spawn_blocking(move || crate::core::ai_images::read_source_file(&source_path))
        .await.map_err(|_| chat_error("读取图片失败".into()))?.map_err(chat_error)
}
fn chat_image_allowed(status: &str, reviewed: bool) -> Result<(), String> {
    if status != "supported" || !reviewed {
        return Err("请先完成图像能力测试并确认截图已裁剪遮挡".into());
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatMessage { role: String, text: String }
fn chat_context(messages: &[ChatMessage]) -> Result<String, String> {
    if messages.is_empty() || messages.len() > 20 || messages.last().is_none_or(|m| m.role != "user") {
        return Err("聊天记录无效或过长，请清空后重试".into());
    }
    for message in messages {
        if !["user", "assistant"].contains(&message.role.as_str()) || message.text.trim().is_empty() || message.text.len() > 12000 {
            return Err("聊天消息无效或过长".into());
        }
        let safe = crate::core::ai::preview(&message.text)?;
        if safe.removed_lines > 0 { return Err("聊天内容含疑似凭据，请移除后再发送".into()); }
    }
    let text = messages.iter().map(|m| format!("{}：{}", if m.role == "user" { "用户" } else { "宠物" }, m.text)).collect::<Vec<_>>().join("\n\n");
    if text.len() > 28000 { return Err("聊天记录过长，请清空后重试".into()); }
    Ok(text)
}
struct ChatGuard<'a> { store: &'a crate::core::ai::RequestStore, id: String }
impl Drop for ChatGuard<'_> {
    fn drop(&mut self) { if let Ok(mut active) = self.store.active.lock() { active.remove(&self.id); } }
}
#[tauri::command]
pub async fn pet_chat(
    window: tauri::WebviewWindow,
    store: tauri::State<'_, crate::core::ai::RequestStore>,
    request_id: String,
    profile_id: String,
    revision: i64,
    messages: Vec<ChatMessage>,
    image: Option<crate::core::ai_images::ImageInput>,
) -> PlatformResult<String> {
    let result: Result<String, String> = async {
    chat_caller(&window)?;
    if uuid::Uuid::parse_str(&request_id).is_err() { return Err("聊天请求标识无效".into()); }
    let text = format!("当前宠物形象：{}。\n\n{}", match read_settings()?.appearance.as_str() { "dog" => "小狗（柯基）", "penguin" => "企鹅", "fish" => "大鱼（DeepSeek）", _ => "羊驼" }, chat_context(&messages)?);
    let id = format!("pet:{request_id}");
    let (sender, mut receiver) = tokio::sync::watch::channel(false);
    store.begin(&id, &profile_id, sender)?;
    let _guard = ChatGuard { store: &store, id };
    let (profile, key) = crate::core::repositories::ai::load(&open_db()?, &profile_id)?;
    if profile.updated_at != revision { return Err("AI配置已更新，请关闭聊天后重新打开".into()); }
    let image = if let Some(image) = image {
        chat_image_allowed(&profile.vision_status, image.reviewed)?;
        Some(tauri::async_runtime::spawn_blocking(move || crate::core::ai_images::normalize(&image.data_url))
            .await.map_err(|_| "处理截图失败".to_string())??)
    } else { None };
    let result = tokio::select! {
        biased;
        _ = receiver.changed() => Err("聊天已停止".to_string()),
        result = crate::core::ai::request_with_options(&profile, &key, &crate::core::ai::Task::PetChat, &text, image.as_ref(), false, |_, _| {}) => result,
    }?;
    if result.0.summary.trim().is_empty() { return Err("回复为空，请重试".into()); }
    Ok(result.0.summary)
    }.await;
    result.map_err(chat_error)
}
#[tauri::command]
pub fn pet_chat_cancel(window: tauri::WebviewWindow, store: tauri::State<'_, crate::core::ai::RequestStore>, request_id: String) -> PlatformResult<()> {
    chat_caller(&window)?;
    if uuid::Uuid::parse_str(&request_id).is_err() { return Err("聊天请求标识无效".into()); }
    store.cancel(&format!("pet:{request_id}")).map_err(chat_error)?;
    Ok(())
}
#[tauri::command]
pub fn pet_snapshot(window: tauri::WebviewWindow) -> PlatformResult<Snapshot> {
    caller(&window)?;
    Ok(snapshot()?)
}
#[tauri::command]
pub fn pet_notice(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> PlatformResult<Option<Alert>> {
    caller(&window)?;
    Ok(app
        .state::<PetStore>()
        .notice
        .lock()
        .map_err(|_| "提醒状态不可用")?
        .clone())
}
#[tauri::command]
pub fn pet_dismiss(window: tauri::WebviewWindow, app: tauri::AppHandle) -> PlatformResult<()> {
    caller(&window)?;
    if let Some(w) = app.get_webview_window(NOTICE_LABEL) {
        w.destroy().map_err(|_| "无法关闭提醒")?;
    }
    *app.state::<PetStore>()
        .notice
        .lock()
        .map_err(|_| "提醒状态不可用")? = None;
    Ok(())
}

pub fn notify(app: &tauri::AppHandle, alert: Alert) -> Result<(), String> {
    *app.state::<PetStore>()
        .notice
        .lock()
        .map_err(|_| "提醒状态不可用")? = Some(alert.clone());
    if app
        .get_webview_window(LABEL)
        .is_some_and(|w| w.is_visible().unwrap_or(false))
    {
        if let Some(w) = app.get_webview_window(LABEL) { undock(app, &w)?; }
        let _ = app.emit_to(LABEL, "pet-notification", alert);
    } else {
        if let Some(w) = app.get_webview_window(NOTICE_LABEL) {
            let _ = w.emit("pet-notification", alert);
            let _ = w.show();
        } else {
            let w = tauri::WebviewWindowBuilder::new(
                app,
                NOTICE_LABEL,
                tauri::WebviewUrl::App("index.html?desktopPetAlerts=1".into()),
            )
            .title("CloudHub 运维提醒")
            .inner_size(360., 240.)
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .build()
            .map_err(|_| "无法显示桌面提醒")?;
            position(&w, None, None)?;
        }
    }
    Ok(())
}

/// Whether the pet itself is on screen. Reminders use it to decide between the
/// pet bubble and the standalone alert window.
pub fn visible(app: &tauri::AppHandle) -> bool {
    app.get_webview_window(LABEL)
        .is_some_and(|w| w.is_visible().unwrap_or(false))
}

pub fn wants_tray(app: &tauri::AppHandle) -> bool {
    app.state::<PetStore>().tray_ready.load(Ordering::SeqCst)
        && read_settings().map(|s| s.keep_in_tray).unwrap_or(false)
}

fn position(window: &tauri::WebviewWindow, x: Option<i32>, y: Option<i32>) -> Result<(), String> {
    let monitors = window.available_monitors().map_err(|_| "无法读取显示器")?;
    let size = window.outer_size().map_err(|_| "无法读取桌宠窗口")?;
    let selected = monitors
        .iter()
        .find(|m| {
            let a = m.work_area();
            x.zip(y).is_some_and(|(x, y)| {
                let cx = x + size.width as i32 / 2;
                let cy = y + size.height as i32 / 2;
                cx >= a.position.x
                    && cy >= a.position.y
                    && cx < a.position.x + a.size.width as i32
                    && cy < a.position.y + a.size.height as i32
            })
        })
        .or_else(|| x.zip(y).and_then(|(x,y)| monitors.iter().min_by_key(|m| {
            let a = m.work_area();
            let cx = x as i64 + size.width as i64/2;
            let cy = y as i64 + size.height as i64/2;
            let dx = (a.position.x as i64-cx).max(0).max(cx-a.position.x as i64-a.size.width as i64);
            let dy = (a.position.y as i64-cy).max(0).max(cy-a.position.y as i64-a.size.height as i64);
            dx*dx+dy*dy
        })))
        .or_else(|| monitors.first())
        .ok_or("未找到显示器")?;
    let area = selected.work_area();
    let right = (area.position.x + area.size.width as i32 - size.width as i32).max(area.position.x);
    let bottom =
        (area.position.y + area.size.height as i32 - size.height as i32).max(area.position.y);
    let x = x.unwrap_or(right - 40).clamp(area.position.x, right);
    let y = y.unwrap_or(bottom).clamp(area.position.y, bottom);
    window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|_| "无法移动桌宠".into())
}
fn head_rect(appearance: usize) -> [u32; 4] {
    static HEADS: std::sync::OnceLock<[[u32;4];4]> = std::sync::OnceLock::new();
    HEADS.get_or_init(|| serde_json::from_str(include_str!("../../../src/features/desktop-pet/assets/pet-heads.json")).expect("bundled pet head bounds"))[appearance]
}

fn undock(app: &tauri::AppHandle, w: &tauri::WebviewWindow) -> Result<(), String> {
    let store = app.state::<PetStore>();
    let mut docked = store.docked.lock().map_err(|_| "桌宠贴边状态不可用")?;
    if let Some((x,y)) = *docked {
        let s = read_settings()?;
        w.set_size(tauri::LogicalSize::new(s.size as f64+80.,s.size as f64+40.)).map_err(|_| "无法展开桌宠")?;
        position(w,Some(x),Some(y))?;
        *docked = None;
        let _ = w.emit("pet-docked",false);
    }
    Ok(())
}

fn dock_after_drag(app: &tauri::AppHandle, w: &tauri::WebviewWindow) -> Result<(), String> {
    let store = app.state::<PetStore>();
    // Serialize with message-driven undocking and layout changes.
    let mut docked = store.docked.lock().map_err(|_| "桌宠贴边状态不可用")?;
    if docked.is_some() { return Ok(()); }
    let Some(monitor) = w.current_monitor().map_err(|_| "无法读取显示器")?.or(w.primary_monitor().map_err(|_| "无法读取显示器")?) else { return Ok(()); };
    let area = monitor.work_area();
    let area = (area.position.x,area.position.y,area.size.width,area.size.height);
    let raw = w.outer_position().map_err(|_| "无法读取桌宠位置")?;
    let size = w.outer_size().map_err(|_| "无法读取桌宠大小")?;
    let s = read_settings()?;
    let scale = monitor.scale_factor();
    let (avatar, avatar_size) = docking::avatar_bounds((raw.x,raw.y),size.height,s.size,scale);
    let edge = docking::edge_at(avatar,avatar_size,area,(16.*scale) as i32);
    position(w,Some(raw.x),Some(raw.y))?;
    let Some(edge) = edge else { return Ok(()); };
    let full = w.outer_position().map_err(|_| "无法读取桌宠位置")?;
    let appearance = match s.appearance.as_str() { "dog"=>1,"penguin"=>2,"fish"=>3,_=>0 };
    let [hx,hy,hw,hh] = head_rect(appearance);
    let width = (s.size as f64 * hw as f64 / 256.).min(area.2 as f64 / scale);
    let height = (s.size as f64 * hh as f64 / 256.).min(area.3 as f64 / scale);
    w.set_size(tauri::LogicalSize::new(width,height)).map_err(|_| "无法收起桌宠")?;
    let size = w.outer_size().map_err(|_| "无法读取桌宠大小")?;
    let head = (avatar.0+(hx as f64/256.*s.size as f64*scale).round() as i32,avatar.1+(hy as f64/256.*s.size as f64*scale).round() as i32);
    let (x,y) = docking::head_position(edge,head,(size.width,size.height),area);
    if w.set_position(tauri::PhysicalPosition::new(x,y)).is_err() {
        let _ = w.set_size(tauri::LogicalSize::new(s.size as f64+80.,s.size as f64+40.));
        return Err("无法将桌宠收起到边缘".into());
    }
    *docked = Some((full.x,avatar.1-(28.*scale).round() as i32));
    let _ = w.emit("pet-docked",true);
    Ok(())
}

pub fn sync_window(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LABEL) { undock(app,&w)?; }
    else { *app.state::<PetStore>().docked.lock().map_err(|_| "桌宠贴边状态不可用")? = None; }
    let settings = read_settings()?;
    app.state::<PetStore>()
        .size
        .store(settings.size, Ordering::SeqCst);
    if !settings.enabled {
        if let Some(w) = app.get_webview_window(LABEL) {
            w.destroy().map_err(|_| "无法关闭桌宠")?;
        }
        return Ok(());
    }
    if let Some(w) = app.get_webview_window(LABEL) {
        w.set_maximizable(false).map_err(|_| "无法关闭桌宠系统最大化")?;
        w.set_size(tauri::LogicalSize::new(
            settings.size as f64 + 80.,
            settings.size as f64 + 40.,
        ))
        .map_err(|_| "无法调整桌宠大小")?;
        let p = w.outer_position().map_err(|_| "无法读取桌宠位置")?;
        position(&w, Some(p.x), Some(p.y))?;
        w.show().map_err(|_| "无法显示桌宠")?;
        let _ = w.emit("pet-visibility", true);
    } else {
        let w = tauri::WebviewWindowBuilder::new(
            app,
            LABEL,
            tauri::WebviewUrl::App("index.html?desktopPet=1".into()),
        )
        .title("CloudHub 宠物")
        .inner_size(settings.size as f64 + 80., settings.size as f64 + 40.)
        .transparent(true)
        .background_color(tauri::webview::Color(0, 0, 0, 0))
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .build()
        .map_err(|_| "无法创建桌宠窗口")?;
        let saved = preferences::list(&open_db()?)?
            .get(POSITION)
            .and_then(|v| serde_json::from_str::<(i32, i32)>(v).ok());
        position(&w, saved.map(|p| p.0), saved.map(|p| p.1))?;
    }
    Ok(())
}
#[tauri::command]
pub async fn pet_save_settings(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    settings: Settings,
) -> PlatformResult<()> {
    caller(&window)?;
    settings.validate()?;
    let previous = read_settings()?;
    save_json(CONFIG, &settings)?;
    if let Err(error) = sync_window(&app) {
        let _ = save_json(CONFIG, &previous);
        return Err(error.into());
    }
    if previous.life != settings.life {
        // A changed schedule must not replay a pending greeting from the previous configuration.
        let _ = update_life(&app, |state| {
            for notice in &mut state.notices { if notice.kind != "weather" { notice.acknowledged = true; } }
            if previous.life.province != settings.life.province || previous.life.city != settings.life.city {
                state.notices.retain(|n| n.kind != "weather");
                state.region = format!("{}{}", settings.life.province, settings.life.city);
                state.weather_checked_at = 0; state.weather_attempt_at = 0; state.weather_error = None;
            }
            Ok(())
        });
    }
    let _ = app.emit("pet-settings-changed", &settings);
    Ok(())
}
#[tauri::command]
pub async fn pet_show(window: tauri::WebviewWindow, app: tauri::AppHandle) -> PlatformResult<()> {
    caller(&window)?;
    sync_window(&app)?;
    Ok(())
}
#[tauri::command]
pub fn pet_hide(window: tauri::WebviewWindow, app: tauri::AppHandle) -> PlatformResult<()> {
    caller(&window)?;
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.emit("pet-visibility", false);
        w.hide().map_err(|_| "无法隐藏桌宠")?;
    }
    Ok(())
}
#[tauri::command]
pub fn pet_sprite(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    column: u32,
    row: u32,
    flipped: bool,
    appearance: Option<String>,
) -> PlatformResult<()> {
    caller(&window)?;
    let appearance = appearance.as_deref().unwrap_or("alpaca");
    if column > 5 || row > 3 || !["alpaca", "dog", "penguin", "fish"].contains(&appearance) {
        return Err("桌宠动画帧无效".into());
    }
    *app.state::<PetStore>()
        .sprite
        .lock()
        .map_err(|_| "桌宠状态不可用")? = (column, row, flipped, match appearance { "dog" => 1, "penguin" => 2, "fish" => 3, _ => 0 });
    Ok(())
}
#[tauri::command]
pub fn pet_regions(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    regions: Vec<[f64; 4]>,
) -> PlatformResult<()> {
    caller(&window)?;
    if regions.len() > 8
        || regions
            .iter()
            .flatten()
            .any(|n| !n.is_finite() || *n < -1000. || *n > 2000.)
    {
        return Err("桌宠交互区域无效".into());
    }
    *app.state::<PetStore>()
        .regions
        .lock()
        .map_err(|_| "桌宠状态不可用")? = regions;
    Ok(())
}
#[tauri::command]
pub fn pet_layout(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    expanded: bool,
    enlarged: Option<bool>,
) -> PlatformResult<()> {
    caller(&window)?;
    let state = app.state::<PetStore>();
    state.expanded.store(expanded, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window(LABEL) {
        if expanded { undock(&app,&w)?; }
        else if state.docked.lock().map_err(|_| "桌宠贴边状态不可用")?.is_some() { let _ = w.emit("pet-docked",true); return Ok(()); }
        let s = read_settings()?;
        let old = w.outer_size().map_err(|_| "无法读取桌宠大小")?;
        let p = w.outer_position().map_err(|_| "无法读取桌宠位置")?;
        let (width, height): (f64, f64) = if expanded {
            if enlarged.unwrap_or(false) { (520., 720.) } else { (360., 480.) }
        } else {
            (s.size as f64 + 80., s.size as f64 + 40.)
        };
        let monitor = w.current_monitor().map_err(|_| "无法读取桌宠显示器")?
            .or(w.primary_monitor().map_err(|_| "无法读取主显示器")?);
        let (width, height) = monitor.map(|m| {
            let area = m.work_area();
            (width.min(area.size.width as f64 / m.scale_factor()),
             height.min(area.size.height as f64 / m.scale_factor()))
        }).unwrap_or((width, height));
        w.set_size(tauri::LogicalSize::new(width, height))
        .map_err(|_| "无法调整桌宠窗口")?;
        let new = w.outer_size().map_err(|_| "无法读取桌宠大小")?;
        position(
            &w,
            Some(p.x),
            Some(p.y + old.height as i32 - new.height as i32),
        )?;
    }
    Ok(())
}
#[tauri::command]
pub async fn pet_move(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    dx: i32,
    dy: i32,
    reset: bool,
    remember: bool,
    dock: Option<bool>,
    reveal: Option<bool>,
) -> PlatformResult<()> {
    caller(&window)?;
    if !(-100..=100).contains(&dx) || !(-100..=100).contains(&dy) {
        return Err("桌宠移动距离无效".into());
    }
    if remember && !reset && !reveal.unwrap_or(false) {
        docking::wait_for_drop().await?;
    }
    if let Some(w) = app.get_webview_window(LABEL) {
        if reset || reveal.unwrap_or(false) { undock(&app,&w)?; }
        else if app.state::<PetStore>().docked.lock().map_err(|_| "桌宠贴边状态不可用")?.is_some() { return Ok(()); }
        if dock.unwrap_or(false) && !reset { dock_after_drag(&app,&w)?; }
        else if reset {
            position(&w, None, None)?;
        } else {
            let p = w.outer_position().map_err(|_| "无法读取桌宠位置")?;
            position(&w, Some(p.x + dx), Some(p.y + dy))?;
        }
        if remember {
            let p = w.outer_position().map_err(|_| "无法读取桌宠位置")?;
            let docked = *app.state::<PetStore>().docked.lock().map_err(|_| "桌宠贴边状态不可用")?;
            save_json(POSITION, &docked.unwrap_or((p.x,p.y)))?;
        }
    }
    Ok(())
}
#[tauri::command]
pub fn pet_open(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    section: String,
    key: Option<String>,
) -> PlatformResult<()> {
    caller(&window)?;
    if !["panels", "resources", "certificates", "settings", "notes"].contains(&section.as_str()) {
        return Err("无效的桌宠入口".into());
    }
    if let Some(ref key)=key { if key.len()>1024 || !snapshot()?.alerts.iter().any(|a|a.key==*key && a.section==section) { return Err("提醒不存在".into()); } }
    if let Some(main) = app.get_webview_window("main") {
        main.show().map_err(|_| "无法打开主窗口")?;
        let _ = main.unminimize();
        let _ = main.set_focus();
        let _ = main.emit("pet-open-section", serde_json::json!({"section":section,"key":key}));
    }
    Ok(())
}
#[tauri::command]
pub fn pet_snooze(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    key: String,
    minutes: i64,
) -> PlatformResult<()> {
    caller(&window)?;
    if ![15, 60, 1440].contains(&minutes) || key.len() > 256 {
        return Err("提醒暂缓参数无效".into());
    }
    // Serialize persistence with the monitoring writer.
    let store = app.state::<PetStore>();
    if store
        .checking
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("巡检正在执行，请稍后重试".into());
    }
    let result = (|| -> Result<(), String> {
        let mut state = snapshot()?;
        let alert = state
            .alerts
            .iter_mut()
            .find(|a| a.key == key)
            .ok_or("提醒不存在")?;
        alert.snoozed_until = chrono::Utc::now().timestamp() + minutes * 60;
        save_json(HISTORY, &state)?;
        let _ = app.emit("pet-alerts-changed", &state);
        Ok(())
    })();
    store.checking.store(false, Ordering::SeqCst);
    result?;
    Ok(())
}

#[tauri::command]
pub fn pet_ignore(window: tauri::WebviewWindow, app: tauri::AppHandle, keys: Vec<String>, ignored: bool) -> PlatformResult<Snapshot> {
    caller(&window)?;
    if keys.is_empty() || keys.len() > 300 || keys.iter().any(|k| k.is_empty() || k.len() > 1024) {
        return Err("提醒暂缓参数无效".into());
    }
    let store = app.state::<PetStore>();
    if store.checking.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err("巡检正在执行，请稍后重试".into());
    }
    let result = (|| -> Result<Snapshot, String> {
        let mut state = snapshot()?;
        if keys.iter().any(|key| !state.alerts.iter().any(|a| a.key == *key)) { return Err("提醒不存在".into()); }
        crate::core::pet_alerts::set_ignored(&mut state.alerts, &keys, ignored);
        save_json(HISTORY, &state)?;
        let _ = app.emit("pet-alerts-changed", &state);
        Ok(state)
    })();
    store.checking.store(false, Ordering::SeqCst);
    Ok(result?)
}

fn date(value: &Value) -> Option<i64> {
    if let Some(n) = value
        .as_i64()
        .or_else(|| value.as_str().and_then(|s| s.parse::<i64>().ok()))
    {
        return (n > 0).then_some(if n > 10_000_000_000 { n / 1000 } else { n });
    }
    let s = value.as_str()?;
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|v| v.timestamp())
        .ok()
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
                .ok()
                .map(|v| v.and_utc().timestamp())
        })
        .or_else(|| {
            chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
                .ok()
                .and_then(|v| v.and_hms_opt(0, 0, 0))
                .map(|v| v.and_utc().timestamp())
        })
}
fn expiry(
    out: &mut Vec<Alert>,
    key: String,
    label: &str,
    at: i64,
    now: i64,
    days: i64,
    section: &str,
    source: &str,
) {
    if let Some(severity) = expiry_severity(at, now, days) {
        let days_left = ((at - now) as f64 / 86400.).ceil() as i64;
        out.push(Alert::candidate(
            key,
            format!(
                "{}{}",
                label.chars().take(90).collect::<String>(),
                if days_left <= 0 {
                    " 已到期"
                } else {
                    " 即将到期"
                }
            ),
            format!(
                "{}；{}。请刷新资源核对续费或续签结果。",
                if days_left <= 0 {
                    "已到期".into()
                } else {
                    format!("剩余 {days_left} 天")
                },
                source
            ),
            section,
            if section == "certificates" { "emergency" } else { severity },
        ));
    }
}

async fn inspect(app: &tauri::AppHandle, settings: &Settings) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp();
    let mut candidates = vec![];
    let mut observed = vec![];
    let mut state = snapshot()?;
    if !settings.certificates {
        retire_missing(&mut state.alerts, "cert:", &[], now);
        retire_missing(&mut state.alerts, "site:", &[], now);
    }
    if !settings.servers {
        retire_missing(&mut state.alerts, "asset:", &[], now);
    }
    if !settings.panels || !settings.panel_access {
        let retired: Vec<String> = state.alerts.iter().filter(|a| a.key.starts_with("panel:") &&
            if a.key.ends_with(":connection") { !settings.panel_access } else { !settings.panels }
        ).map(|a| a.key.clone()).collect();
        for key in retired { retire_missing(&mut state.alerts, &key, &[], now); }
        app.state::<PetStore>().failures.lock().map_err(|_| "巡检状态不可用")?.retain(|key, _| {
            if key.ends_with(":connection") { settings.panel_access } else { settings.panels }
        });
    }
    if settings.certificates {
        let rows = certificates::list(&open_db()?, None)?;
        retire_missing(
            &mut state.alerts,
            "cert:",
            &rows
                .iter()
                .map(|c| format!("cert:{}", c.id))
                .collect::<Vec<_>>(),
            now,
        );
        for c in rows {
            if let Some(at) = c.not_after.filter(|at| *at > 0) {
                observed.push(format!("cert:{}", c.id));
                expiry(
                    &mut candidates,
                    format!("cert:{}", c.id),
                    &c.primary_domain,
                    at,
                    now,
                    settings.expiry_days,
                    "certificates",
                    "本地证书有效期",
                );
            }
        }
        if let Ok(sites) = super::baota_certificates::list_baota_site_certificates_inner(None) {
            retire_missing(
                &mut state.alerts,
                "site:",
                &sites
                    .iter()
                    .map(|c| format!("site:{}", c.id))
                    .collect::<Vec<_>>(),
                now,
            );
            for site in sites {
                if !site.enabled {
                    observed.push(format!("site:{}", site.id));
                }
                if site.enabled {
                    if let Some(at) = site.not_after.filter(|at| *at > 0) {
                        observed.push(format!("site:{}", site.id));
                        expiry(
                            &mut candidates,
                            format!("site:{}", site.id),
                            &site.site_name,
                            at,
                            now,
                            settings.expiry_days,
                            "certificates",
                            "宝塔已同步证书，可能存在缓存",
                        );
                    }
                }
            }
        }
    }
    if settings.servers {
        let rows = assets::list(&open_db()?, None, None)?;
        retire_missing(
            &mut state.alerts,
            "asset:",
            &rows
                .iter()
                .map(|a| format!("asset:{}:{}:{}", a.account_id, a.resource_type, a.asset_key))
                .collect::<Vec<_>>(),
            now,
        );
        for a in rows {
            if !["ecs", "cvm", "lighthouse", "swas", "server", "instance"]
                .contains(&a.resource_type.as_str())
            {
                continue;
            }
            let at = [
                "ExpiredTime",
                "ExpirationTime",
                "ExpirationDate",
                "ExpireTime",
                "ExpireDate",
                "EndTime",
            ]
            .iter()
            .find_map(|k| a.payload.get(*k).and_then(date));
            if let Some(at) = at {
                observed.push(format!(
                    "asset:{}:{}:{}",
                    a.account_id, a.resource_type, a.asset_key
                ));
                let name = a
                    .payload
                    .get("InstanceName")
                    .and_then(Value::as_str)
                    .unwrap_or(&a.asset_key);
                expiry(
                    &mut candidates,
                    format!("asset:{}:{}:{}", a.account_id, a.resource_type, a.asset_key),
                    name,
                    at,
                    now,
                    settings.expiry_days,
                    "resources",
                    &format!(
                        "云资源缓存更新于 {}",
                        chrono::DateTime::from_timestamp_millis(a.fetched_at)
                            .map(|d| d.format("%Y-%m-%d %H:%M UTC").to_string())
                            .unwrap_or_else(|| "未知".into())
                    ),
                );
            }
        }
    }
    if settings.panels || settings.panel_access {
        let panels = panel_connections::list(&open_db()?)?;
        retire_missing(
            &mut state.alerts,
            "panel:",
            &panels
                .iter()
                .map(|p| format!("panel:{}:", p.id))
                .collect::<Vec<_>>(),
            now,
        );
        let store = app.state::<PetStore>();
        for panel in panels {
            if !read_settings()?.monitoring {
                return Ok(());
            }
            let result = super::panel_connections::monitor_panel(panel.id).await;
            let connection = format!("panel:{}:connection", panel.id);
            match result {
                Err(()) => {
                    if !settings.panel_access { continue; }
                    let count = {
                        let mut counts = store.failures.lock().map_err(|_| "巡检状态不可用")?;
                        let n = counts.entry(connection.clone()).or_default();
                        *n = n.saturating_add(1);
                        *n
                    };
                    if let Some(alert) = panel_access_alert(panel.id, &panel.name, count) { candidates.push(alert); }
                }
                Ok((metrics, services)) => {
                    if settings.panel_access { observed.push(connection.clone()); }
                    store
                        .failures
                        .lock()
                        .map_err(|_| "巡检状态不可用")?
                        .remove(&connection);
                    if !settings.panels { continue; }
                    for (metric, limit) in [
                        ("cpu", settings.cpu_threshold),
                        ("disk", settings.disk_threshold),
                    ] {
                        let key = format!("panel:{}:metric:{metric}", panel.id);
                        let value = metrics
                            .get(metric)
                            .and_then(|m| m.get("used_percent"))
                            .and_then(Value::as_f64);
                        if let Some(value) = value.filter(|v| (0.0..=100.0).contains(v)) {
                            if value < limit {
                                observed.push(key.clone());
                            }
                            let count = {
                                let mut counts =
                                    store.failures.lock().map_err(|_| "巡检状态不可用")?;
                                let n = counts.entry(key.clone()).or_default();
                                *n = if value >= limit {
                                    n.saturating_add(1)
                                } else {
                                    0
                                };
                                *n
                            };
                            if let Some(alert) = panel_metric_alert(panel.id, &panel.name, metric, value, limit, count) { candidates.push(alert); }
                        }
                    }
                    if let Some(services) = services {
                        for (name, running) in services {
                            let key = format!("panel:{}:service:{name}", panel.id);
                            if running {
                                observed.push(key.clone());
                            }
                            let count = {
                                let mut counts =
                                    store.failures.lock().map_err(|_| "巡检状态不可用")?;
                                let n = counts.entry(key.clone()).or_default();
                                *n = if running { 0 } else { n.saturating_add(1) };
                                *n
                            };
                            if count >= 2 {
                                candidates.push(Alert::candidate(
                                    key,
                                    format!(
                                        "{} · {name} 服务停止",
                                        panel.name.chars().take(90).collect::<String>()
                                    ),
                                    "面板连续两次报告已安装服务停止；请进入面板核对。".into(),
                                    "panels",
                                    "critical",
                                ));
                            }
                        }
                    }
                }
            }
        }
    }
    if !read_settings()?.monitoring {
        return Ok(());
    }
    let notifications = reconcile(&mut state.alerts, candidates, &observed, now);
    state.checked_at = now;
    state.last_error = None;
    save_json(HISTORY, &state)?;
    let _ = app.emit("pet-alerts-changed", &state);
    if !read_settings()?.quiet {
        if let Some(notification) = notifications
            .into_iter()
            .min_by_key(|a| (!a.active, std::cmp::Reverse(severity_rank(&a.severity))))
        {
            notify(app, notification)?;
        }
    }
    Ok(())
}
async fn check(app: tauri::AppHandle) -> Result<(), String> {
    let settings = read_settings()?;
    if !settings.monitoring {
        return Err("请先开启运维预警".into());
    }
    let store = app.state::<PetStore>();
    if store
        .checking
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("巡检正在执行，请稍后重试".into());
    }
    let result = inspect(&app, &settings).await;
    store.checking.store(false, Ordering::SeqCst);
    if result.is_err() {
        if let Ok(mut state) = snapshot() {
            state.last_error = Some("巡检未完成，请稍后重试；旧状态未视为恢复".into());
            let _ = save_json(HISTORY, &state);
            let _ = app.emit("pet-alerts-changed", state);
        }
    }
    result
}
#[tauri::command]
pub async fn pet_check(window: tauri::WebviewWindow, app: tauri::AppHandle) -> PlatformResult<()> {
    caller(&window)?;
    {
        let store = app.state::<PetStore>();
        let mut at = store.last_manual.lock().map_err(|_| "巡检状态不可用")?;
        let now = chrono::Utc::now().timestamp();
        if now - *at < 60 {
            return Err("手动巡检间隔至少一分钟".into());
        }
        *at = now;
    }
    check(app).await?;
    Ok(())
}
pub fn initialize(app: &tauri::AppHandle) {
    if let Ok(all) = open_db().and_then(|db| preferences::list(&db)) {
        if let Some(state) = all.get(LIFE_HISTORY).and_then(|v| serde_json::from_str(v).ok()) {
            if let Ok(mut guard) = app.state::<PetStore>().life.lock() { *guard = state; }
        }
    }
    let life_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            life_tick(&life_handle).await;
            tokio::time::sleep(Duration::from_secs(20)).await;
        }
    });
    let tray = (|| -> tauri::Result<()> {
        use tauri::{
            menu::{Menu, MenuItem},
            tray::TrayIconBuilder,
        };
        let open = MenuItem::with_id(app, "pet-main", "打开云枢工具箱", true, None::<&str>)?;
        let show = MenuItem::with_id(app, "pet-show", "显示宠物", true, None::<&str>)?;
        let exit = MenuItem::with_id(app, "pet-exit", "退出应用", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&open, &show, &exit])?;
        let mut builder = TrayIconBuilder::with_id("cloudhub-pet")
            .tooltip("云枢工具箱 · 宠物与运维预警")
            .menu(&menu)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "pet-main" => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                    }
                }
                "pet-show" => {
                    let handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = sync_window(&handle);
                    });
                }
                "pet-exit" => {
                    app.exit(0);
                }
                _ => {}
            });
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
        builder.build(app)?;
        Ok(())
    })();
    app.state::<PetStore>()
        .tray_ready
        .store(tray.is_ok(), Ordering::SeqCst);
    if tray.is_err() {
        if let Ok(mut settings) = read_settings() {
            settings.keep_in_tray = false;
            let _ = save_json(CONFIG, &settings);
        }
    }
    let _ = sync_window(app);
    // Native cursor polling restores pointer events even when the transparent region is click-through.
    // Hit testing uses the same alpha pixels and sprite frame as the UI, not the window rectangle.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut masks = [None, None, None, None];
        loop {
            tokio::time::sleep(Duration::from_millis(65)).await;
            let Some(w) = handle.get_webview_window(LABEL) else {
                masks = [None, None, None, None];
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            };
            if !w.is_visible().unwrap_or(false) {
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
            for (index, bytes) in [
                (0, include_bytes!("../../../src/features/desktop-pet/assets/alpaca-sprites.png").as_slice()),
                (1, include_bytes!("../../../src/features/desktop-pet/assets/dog-sprites.png").as_slice()),
                (2, include_bytes!("../../../src/features/desktop-pet/assets/penguin-sprites.png").as_slice()),
                (3, include_bytes!("../../../src/features/desktop-pet/assets/fish-sprites.png").as_slice()),
            ] {
                if masks[index].is_none() {
                    masks[index] = image::load_from_memory(bytes).ok().map(|im| im.to_rgba8());
                }
            }
            let store = handle.state::<PetStore>();
            let hit = (|| -> Option<bool> {
                let p = w.cursor_position().ok()?;
                let origin = w.inner_position().ok()?;
                let scale = w.scale_factor().ok()?;
                let height = w.inner_size().ok()?.height as f64 / scale;
                let cx = (p.x - origin.x as f64) / scale;
                let cy = (p.y - origin.y as f64) / scale;
                if store
                    .regions
                    .lock()
                    .ok()?
                    .iter()
                    .any(|r| cx >= r[0] && cy >= r[1] && cx <= r[2] && cy <= r[3])
                {
                    return Some(true);
                }
                if store.docked.lock().ok()?.is_some() {
                    let (_,_,_,appearance) = *store.sprite.lock().ok()?;
                    let [left,top,width,height] = head_rect(appearance);
                    let bounds = w.inner_size().ok()?;
                    let (width_px,height_px) = (bounds.width as f64/scale,bounds.height as f64/scale);
                    if cx < 0. || cy < 0. || cx >= width_px || cy >= height_px { return Some(false); }
                    let sx = ((cx/width_px)*width as f64) as u32;
                    let sy = ((cy/height_px)*height as f64) as u32;
                    return Some(masks[appearance].as_ref()?.get_pixel(left+sx.min(width-1),top+sy.min(height-1))[3]>32);
                }
                let size = store.size.load(Ordering::SeqCst).max(1) as f64;
                let x = (p.x - origin.x as f64) / scale - 40.;
                let y = (p.y - origin.y as f64) / scale - (height - size - 12.);
                if x < 0. || y < 0. || x >= size || y >= size {
                    return Some(false);
                }
                let (col, row, flipped, appearance) = *store.sprite.lock().ok()?;
                let mask = masks[appearance].as_ref()?;
                let (left, top, cell_w, cell_h) = sprite_rect(appearance, col, row);
                let sx = ((x / size) * cell_w as f64) as u32;
                let sy = ((y / size) * cell_h as f64) as u32;
                let sx = if flipped {
                    cell_w - 1 - sx.min(cell_w - 1)
                } else {
                    sx.min(cell_w - 1)
                };
                Some(
                    mask.get_pixel(left + sx, top + sy.min(cell_h - 1))
                        .0[3]
                        > 32,
                )
            })()
            .unwrap_or(true);
            let _ = w.set_ignore_cursor_events(!hit);
        }
    });
    crate::commands::notes::start_reminder_loop(app);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut last = 0;
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            if let Ok(settings) = read_settings() {
                let now = chrono::Utc::now().timestamp();
                if settings.monitoring && now - last >= settings.interval_seconds as i64 {
                    last = now;
                    let _ = check(handle.clone()).await;
                }
            }
        }
    });
}

// Both renderers read the same frame bounds, including character-specific gutters.
fn sprite_rect(appearance: usize, column: u32, row: u32) -> (u32, u32, u32, u32) {
    static DOG: std::sync::OnceLock<[[u32; 4]; 24]> = std::sync::OnceLock::new();
    static FISH: std::sync::OnceLock<[[u32;4];24]> = std::sync::OnceLock::new();
    static PENGUIN: std::sync::OnceLock<[[u32; 4]; 24]> = std::sync::OnceLock::new();
    let frames = match appearance {
        1 => DOG.get_or_init(|| serde_json::from_str(include_str!("../../../src/features/desktop-pet/assets/dog-frames.json")).expect("bundled corgi frame metadata")),
        2 => PENGUIN.get_or_init(|| serde_json::from_str(include_str!("../../../src/features/desktop-pet/assets/penguin-frames.json")).expect("bundled penguin frame metadata")),
        3 => FISH.get_or_init(|| serde_json::from_str(include_str!("../../../src/features/desktop-pet/assets/fish-frames.json")).expect("bundled fish frame metadata")),
        _ => return (column * 256, row * 256, 256, 256),
    };
    let [left, top, width, height] = frames[(row * 6 + column) as usize];
    (left, top, width, height)
}

#[cfg(test)]
mod tests {
    #[test]
    fn all_head_crops_stay_inside_the_standing_frame() {
        for appearance in 0..4 {
            let [x,y,width,height] = super::head_rect(appearance);
            assert!(width>0 && height>0 && x+width<=256 && y+height<=256);
        }
    }
    #[test]
    fn pet_appearance_defaults_and_validation_round_trip() {
        let settings: super::Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings.appearance, "alpaca");
        let dog: super::Settings = serde_json::from_str(r#"{"appearance":"dog"}"#).unwrap();
        assert!(dog.validate().is_ok());
        let saved = serde_json::to_string(&dog).unwrap();
        assert_eq!(serde_json::from_str::<super::Settings>(&saved).unwrap().appearance, "dog");
        let penguin: super::Settings = serde_json::from_str(r#"{"appearance":"penguin"}"#).unwrap();
        assert!(penguin.validate().is_ok());
        let saved = serde_json::to_string(&penguin).unwrap();
        assert_eq!(serde_json::from_str::<super::Settings>(&saved).unwrap().appearance, "penguin");
        let invalid: super::Settings = serde_json::from_str(r#"{"appearance":"../file.png"}"#).unwrap();
        let fish: super::Settings = serde_json::from_str(r#"{"appearance":"fish"}"#).unwrap();
        assert!(fish.validate().is_ok());
        assert_eq!(serde_json::from_str::<super::Settings>(&serde_json::to_string(&fish).unwrap()).unwrap().appearance,"fish");
        assert!(invalid.validate().is_err());
    }
    #[test]
    fn all_pet_atlases_have_valid_frames_and_transparent_borders() {
        for (index, bytes) in [
            include_bytes!("../../../src/features/desktop-pet/assets/alpaca-sprites.png").as_slice(),
            include_bytes!("../../../src/features/desktop-pet/assets/dog-sprites.png").as_slice(),
            include_bytes!("../../../src/features/desktop-pet/assets/penguin-sprites.png").as_slice(),
            include_bytes!("../../../src/features/desktop-pet/assets/fish-sprites.png").as_slice(),
        ].into_iter().enumerate() {
            let atlas = image::load_from_memory(bytes).unwrap().to_rgba8();
            assert_eq!(atlas.dimensions(), (1536, 1024));
            assert!(atlas.get_pixel(0, 0)[3] < 10);
            assert!(atlas.get_pixel(1535, 1023)[3] < 10);
            for row in 0..4 { for col in 0..6 {
                let (left, top, width, height) = super::sprite_rect(index, col, row);
                assert!(left + width <= atlas.width() && top + height <= atlas.height());
                assert!((0..height).any(|y| (0..width).any(|x| atlas.get_pixel(left+x, top+y)[3] > 32)));
                if index > 0 {
                    assert!((0..width).all(|x| atlas.get_pixel(left+x, top)[3] <= 32 && atlas.get_pixel(left+x, top+height-1)[3] <= 32), "pet frame touches another row");
                    assert!((0..height).all(|y| atlas.get_pixel(left, top+y)[3] <= 32 && atlas.get_pixel(left+width-1, top+y)[3] <= 32), "pet frame touches another column");
                }
            } }
        }
    }
    #[test]
    fn chat_images_require_review_and_current_vision_capability() {
        assert!(super::chat_image_allowed("supported", true).is_ok());
        assert!(super::chat_image_allowed("supported", false).is_err());
        assert!(super::chat_image_allowed("unknown", true).is_err());
        assert!(super::chat_image_allowed("unsupported", true).is_err());
    }
    #[test]
    fn certificate_reminders_are_emergency_within_configured_window_only() {
        let mut alerts = vec![];
        super::expiry(&mut alerts, "cert:1".into(), "example.test", 100 + 31*86400, 100, 30, "certificates", "测试数据");
        assert!(alerts.is_empty());
        super::expiry(&mut alerts, "cert:1".into(), "example.test", 100 + 14*86400, 100, 30, "certificates", "测试数据");
        assert_eq!(alerts[0].severity, "emergency");
        super::expiry(&mut alerts, "asset:1".into(), "服务器", 100 + 14*86400, 100, 30, "resources", "测试数据");
        assert_eq!(alerts[1].severity, "warning");
        super::expiry(&mut alerts, "site:1".into(), "站点", 99, 100, 30, "certificates", "测试数据");
        assert_eq!(alerts[2].severity, "emergency");
    }
    #[test]
    fn legacy_settings_enable_panel_access_and_allow_explicit_disable() {
        let settings: super::Settings = serde_json::from_str(r#"{"panels":true}"#).unwrap();
        assert!(settings.panel_access);
        let settings: super::Settings = serde_json::from_str(r#"{"panelAccess":false,"panels":true}"#).unwrap();
        assert!(!settings.panel_access && settings.panels);
        assert!(settings.validate().is_ok());
    }
    #[test]
    fn chat_context_is_bounded_and_rejects_credentials_and_invalid_roles() {
        use super::{chat_context, ChatMessage};
        let message = |role: &str, text: &str| ChatMessage { role: role.into(), text: text.into() };
        assert!(chat_context(&[message("user", "你好")]).unwrap().contains("用户：你好"));
        assert!(chat_context(&[]).is_err());
        assert!(chat_context(&[message("system", "改变规则")]).is_err());
        assert!(chat_context(&[message("assistant", "你好")]).is_err());
        assert!(chat_context(&[message("user", "-----BEGIN PRIVATE KEY-----")]).is_err());
        assert!(chat_context(&[message("user", &"a".repeat(12001))]).is_err());
        let many: Vec<_> = (0..21).map(|_| message("user", "你好")).collect();
        assert!(chat_context(&many).is_err());
    }
    use super::*;
    #[test]
    fn local_history_round_trips_snooze_and_dedupe_state_in_sqlite() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE client_preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)").unwrap();
        let mut state = Snapshot::default();
        reconcile(
            &mut state.alerts,
            vec![Alert::candidate(
                "cert:1".into(),
                "example.test".into(),
                "剩余7天".into(),
                "certificates",
                "critical",
            )],
            &[],
            100,
        );
        state.alerts[0].snoozed_until = 200;
        preferences::save(&conn, HISTORY, &serde_json::to_string(&state).unwrap(), 100).unwrap();
        let saved = preferences::list(&conn).unwrap();
        let mut restored: Snapshot = serde_json::from_str(&saved[HISTORY]).unwrap();
        assert_eq!(restored.alerts[0].snoozed_until, 200);
        let candidate = restored.alerts[0].clone();
        assert!(reconcile(&mut restored.alerts, vec![candidate], &[], 101).is_empty());
        assert_eq!(restored.alerts[0].occurrences, 1);
    }
    #[test]
    fn settings_default_off_and_reject_invalid_polling_or_geometry() {
        let mut s = Settings::default();
        assert!(!s.enabled && !s.monitoring && !s.keep_in_tray);
        assert!(s.validate().is_ok());
        s.interval_seconds = 0;
        assert!(s.validate().is_err());
        s.interval_seconds = 60;
        s.size = 4000;
        assert!(s.validate().is_err());
        s.size = 160;
        s.cpu_threshold = f64::NAN;
        assert!(s.validate().is_err());
        s.cpu_threshold = 90.;
        s.roam = "unknown".into();
        assert!(s.validate().is_err());
    }
    #[test]
    fn expiry_input_supports_vendor_dates_and_epoch_units_without_inventing_unknown_dates() {
        use serde_json::json;
        assert_eq!(
            date(&json!("2026-10-15T08:00:00+08:00")),
            date(&json!("2026-10-15T00:00:00Z"))
        );
        assert_eq!(
            date(&json!("2026-10-15")),
            date(&json!("2026-10-15 00:00:00"))
        );
        assert_eq!(date(&json!(1792022400000_i64)), Some(1792022400));
        assert_eq!(date(&json!("1792022400")), Some(1792022400));
        assert_eq!(date(&json!(0)), None);
        assert_eq!(date(&Value::Null), None);
        assert_eq!(date(&json!("unknown")), None);
    }
}
