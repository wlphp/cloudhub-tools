//! Desktop-only companion, bounded background monitoring and local preferences.
use crate::core::{
    error::PlatformResult,
    pet_alerts::{expiry_severity, reconcile, retire_missing, Alert},
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

const CONFIG: &str = "desktop-pet-config-v1";
const HISTORY: &str = "desktop-pet-alerts-v1";
const POSITION: &str = "desktop-pet-position-v1";
const LABEL: &str = "desktop-pet";
const NOTICE_LABEL: &str = "desktop-pet-alert";

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub enabled: bool,
    pub monitoring: bool,
    pub panels: bool,
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
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            monitoring: false,
            panels: false,
            certificates: true,
            servers: true,
            size: 160,
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
        }
    }
}
impl Settings {
    fn validate(&self) -> Result<(), String> {
        if !(100..=240).contains(&self.size)
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
    pub tray_ready: AtomicBool,
    pub size: AtomicU32,
    pub sprite: Mutex<(u32, u32, bool)>,
    pub regions: Mutex<Vec<[f64; 4]>>,
    pub notice: Mutex<Option<Alert>>,
    pub failures: Mutex<HashMap<String, u32>>,
    pub last_manual: Mutex<i64>,
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
                "pet_snooze",
                "pet_check",
                "pet_sprite",
                "pet_regions",
                "pet_notice",
                "pet_dismiss",
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

fn notify(app: &tauri::AppHandle, alert: Alert) -> Result<(), String> {
    *app.state::<PetStore>()
        .notice
        .lock()
        .map_err(|_| "提醒状态不可用")? = Some(alert.clone());
    if app
        .get_webview_window(LABEL)
        .is_some_and(|w| w.is_visible().unwrap_or(false))
    {
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

pub fn wants_tray(app: &tauri::AppHandle) -> bool {
    app.state::<PetStore>().tray_ready.load(Ordering::SeqCst)
        && read_settings().map(|s| s.keep_in_tray).unwrap_or(false)
}

fn position(window: &tauri::WebviewWindow, x: Option<i32>, y: Option<i32>) -> Result<(), String> {
    let monitors = window.available_monitors().map_err(|_| "无法读取显示器")?;
    let selected = monitors
        .iter()
        .find(|m| {
            let a = m.work_area();
            x.zip(y).is_some_and(|(x, y)| {
                x >= a.position.x
                    && y >= a.position.y
                    && x < a.position.x + a.size.width as i32
                    && y < a.position.y + a.size.height as i32
            })
        })
        .or_else(|| monitors.first())
        .ok_or("未找到显示器")?;
    let area = selected.work_area();
    let size = window.outer_size().map_err(|_| "无法读取桌宠窗口")?;
    let right = (area.position.x + area.size.width as i32 - size.width as i32).max(area.position.x);
    let bottom =
        (area.position.y + area.size.height as i32 - size.height as i32).max(area.position.y);
    let x = x.unwrap_or(right - 40).clamp(area.position.x, right);
    let y = y.unwrap_or(bottom).clamp(area.position.y, bottom);
    window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|_| "无法移动桌宠".into())
}
pub fn sync_window(app: &tauri::AppHandle) -> Result<(), String> {
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
        .title("CloudHub 羊驼")
        .inner_size(settings.size as f64 + 80., settings.size as f64 + 40.)
        .transparent(true)
        .background_color(tauri::webview::Color(0, 0, 0, 0))
        .decorations(false)
        .shadow(false)
        .resizable(false)
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
) -> PlatformResult<()> {
    caller(&window)?;
    if column > 5 || row > 3 {
        return Err("桌宠动画帧无效".into());
    }
    *app.state::<PetStore>()
        .sprite
        .lock()
        .map_err(|_| "桌宠状态不可用")? = (column, row, flipped);
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
) -> PlatformResult<()> {
    caller(&window)?;
    let state = app.state::<PetStore>();
    state.expanded.store(expanded, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window(LABEL) {
        let s = read_settings()?;
        let old = w.outer_size().map_err(|_| "无法读取桌宠大小")?;
        let p = w.outer_position().map_err(|_| "无法读取桌宠位置")?;
        w.set_size(tauri::LogicalSize::new(
            if expanded { 360. } else { s.size as f64 + 80. },
            if expanded { 480. } else { s.size as f64 + 40. },
        ))
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
pub fn pet_move(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    dx: i32,
    dy: i32,
    reset: bool,
    remember: bool,
) -> PlatformResult<()> {
    caller(&window)?;
    if !(-100..=100).contains(&dx) || !(-100..=100).contains(&dy) {
        return Err("桌宠移动距离无效".into());
    }
    if let Some(w) = app.get_webview_window(LABEL) {
        if reset {
            position(&w, None, None)?;
        } else {
            let p = w.outer_position().map_err(|_| "无法读取桌宠位置")?;
            position(&w, Some(p.x + dx), Some(p.y + dy))?;
        }
        if remember {
            let p = w.outer_position().map_err(|_| "无法读取桌宠位置")?;
            save_json(POSITION, &(p.x, p.y))?;
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
    if !["panels", "resources", "certificates", "settings"].contains(&section.as_str()) {
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
            severity,
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
    if !settings.panels {
        retire_missing(&mut state.alerts, "panel:", &[], now);
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
    if settings.panels {
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
                    let count = {
                        let mut counts = store.failures.lock().map_err(|_| "巡检状态不可用")?;
                        let n = counts.entry(connection.clone()).or_default();
                        *n = n.saturating_add(1);
                        *n
                    };
                    if count >= 2 {
                        candidates.push(Alert::candidate(connection,format!("{} 暂时无法检查",panel.name.chars().take(90).collect::<String>()),"连续连接失败；请检查本机网络、面板地址、权限与 API 白名单。尚不能判断服务器服务是否停止。".into(),"panels","warning"));
                    }
                }
                Ok((metrics, services)) => {
                    observed.push(connection.clone());
                    store
                        .failures
                        .lock()
                        .map_err(|_| "巡检状态不可用")?
                        .remove(&connection);
                    for (metric, limit, label) in [
                        ("cpu", settings.cpu_threshold, "CPU"),
                        ("disk", settings.disk_threshold, "磁盘"),
                    ] {
                        let key = format!("panel:{}:metric:{metric}", panel.id);
                        let value = metrics
                            .get(metric)
                            .and_then(|m| m.get("used_percent"))
                            .and_then(Value::as_f64);
                        if let Some(value) = value.filter(|v| v.is_finite()) {
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
                            if count >= 2 {
                                candidates.push(Alert::candidate(
                                    key,
                                    format!(
                                        "{} {label} 持续偏高",
                                        panel.name.chars().take(90).collect::<String>()
                                    ),
                                    format!(
                                        "当前 {value:.1}%，阈值 {limit:.0}%；连续两次巡检超限。"
                                    ),
                                    "panels",
                                    "warning",
                                ));
                            }
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
            .min_by_key(|a| (!a.active, a.severity != "critical"))
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
    let tray = (|| -> tauri::Result<()> {
        use tauri::{
            menu::{Menu, MenuItem},
            tray::TrayIconBuilder,
        };
        let open = MenuItem::with_id(app, "pet-main", "打开 CloudHub", true, None::<&str>)?;
        let show = MenuItem::with_id(app, "pet-show", "显示羊驼", true, None::<&str>)?;
        let exit = MenuItem::with_id(app, "pet-exit", "退出应用", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&open, &show, &exit])?;
        let mut builder = TrayIconBuilder::with_id("cloudhub-pet")
            .tooltip("CloudHub Tools · 羊驼与运维预警")
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
        let mut mask = None;
        loop {
            tokio::time::sleep(Duration::from_millis(65)).await;
            let Some(w) = handle.get_webview_window(LABEL) else {
                mask = None;
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            };
            if !w.is_visible().unwrap_or(false) {
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
            if mask.is_none() {
                mask = image::load_from_memory(include_bytes!(
                    "../../../src/features/desktop-pet/assets/alpaca-sprites.png"
                ))
                .ok()
                .map(|im| im.to_rgba8());
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
                let size = store.size.load(Ordering::SeqCst).max(1) as f64;
                let x = (p.x - origin.x as f64) / scale - 40.;
                let y = (p.y - origin.y as f64) / scale - (height - size - 12.);
                if x < 0. || y < 0. || x >= size || y >= size {
                    return Some(false);
                }
                let (col, row, flipped) = *store.sprite.lock().ok()?;
                let mask = mask.as_ref()?;
                let cell_w = mask.width() / 6;
                let cell_h = mask.height() / 4;
                let sx = ((x / size) * cell_w as f64) as u32;
                let sy = ((y / size) * cell_h as f64) as u32;
                let sx = if flipped {
                    cell_w - 1 - sx.min(cell_w - 1)
                } else {
                    sx.min(cell_w - 1)
                };
                Some(
                    mask.get_pixel(col * cell_w + sx, row * cell_h + sy.min(cell_h - 1))
                        .0[3]
                        > 32,
                )
            })()
            .unwrap_or(true);
            let _ = w.set_ignore_cursor_events(!hit);
        }
    });
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

#[cfg(test)]
mod tests {
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
