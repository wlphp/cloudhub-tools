use crate::core::{
    error::{PlatformError, PlatformResult},
    speed_test::{self, Config, Job, Run},
};
use std::sync::{atomic::Ordering, Arc, Mutex};
use tauri::State;

#[derive(Default)]
pub struct SpeedTestStore {
    job: Mutex<Option<Arc<Job>>>,
}
#[tauri::command]
pub(crate) async fn speed_test_network_info(
    window: tauri::WebviewWindow,
) -> PlatformResult<speed_test::network_info::NetworkInfo> {
    main_window(&window)?;
    Ok(speed_test::network_info::query().await)
}
fn main_window(window: &tauri::WebviewWindow) -> PlatformResult<()> {
    if window.label() != "main" {
        return Err("仅主窗口可以操作网络测速".into());
    }
    Ok(())
}
fn error(message: String) -> PlatformError {
    // All messages from the speed test core are authored, never upstream bodies/URLs.
    PlatformError {
        kind: "platform-error",
        code: "network-speed",
        message,
        retryable: false,
    }
}
#[tauri::command]
pub(crate) fn speed_test_status(
    window: tauri::WebviewWindow,
    state: State<'_, SpeedTestStore>,
) -> PlatformResult<Option<Run>> {
    main_window(&window)?;
    let guard = state.job.lock().map_err(|_| "测速状态不可用")?;
    guard
        .as_ref()
        .map(|job| job.snapshot())
        .transpose()
        .map_err(error)
}
#[tauri::command]
pub(crate) fn speed_test_start(
    window: tauri::WebviewWindow,
    state: State<'_, SpeedTestStore>,
    config: Config,
) -> PlatformResult<Run> {
    main_window(&window)?;
    let mut guard = state.job.lock().map_err(|_| "测速状态不可用")?;
    if let Some(job) = guard.as_ref() {
        if job.snapshot().map_err(error)?.status == "running" {
            return Err(error("已有测速正在运行，请先停止".into()));
        }
    }
    let job = Arc::new(Job::new(&config).map_err(error)?);
    let run = job.snapshot().map_err(error)?;
    *guard = Some(job.clone());
    tauri::async_runtime::spawn(speed_test::execute(job));
    Ok(run)
}
#[tauri::command]
pub(crate) fn speed_test_cancel(
    window: tauri::WebviewWindow,
    state: State<'_, SpeedTestStore>,
    id: String,
) -> PlatformResult<()> {
    main_window(&window)?;
    let guard = state.job.lock().map_err(|_| "测速状态不可用")?;
    if let Some(job) = guard.as_ref() {
        if job.snapshot().map_err(error)?.id == id {
            job.cancel.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn speed_test_history(window: tauri::WebviewWindow) -> PlatformResult<Vec<Run>> {
    main_window(&window)?;
    tauri::async_runtime::spawn_blocking(|| speed_test::history(&crate::core::database::open_db()?))
        .await
        .map_err(|_| error("读取测速历史失败".into()))?
        .map_err(error)
}
