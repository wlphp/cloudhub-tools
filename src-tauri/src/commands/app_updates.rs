use crate::core::error::PlatformResult;
use tauri_plugin_cloudhub_mobile_updater::transport::{self, Source};

#[tauri::command]
pub async fn app_update_probe(route: Source) -> PlatformResult<transport::Probe> {
    Ok(transport::probe(route).await)
}
#[derive(serde::Serialize)]
pub struct ReleaseInfo { version: String, notes: String, route: Source }
#[tauri::command]
pub async fn app_update_info(source: Source) -> PlatformResult<ReleaseInfo> {
    let mut errors = Vec::new();
    for &route in source.routes() {
        let result = async {
            let value = transport::json(transport::API, route).await?;
            let tag = value["tag_name"].as_str().ok_or("版本信息无效")?;
            let version = tag.strip_prefix('v').unwrap_or(tag);
            if version.split('.').count() != 3 || version.split('.').any(|v| v.is_empty() || v.parse::<u64>().is_err())
                || value["draft"] != false || value["prerelease"] != false { return Err("不是有效的稳定版本".to_string()); }
            Ok(ReleaseInfo { version: version.into(), notes: value["body"].as_str().unwrap_or("").chars().take(8000).collect(), route })
        }.await;
        match result { Ok(info) => return Ok(info), Err(error) => errors.push(format!("{}：{error}", route.label())) }
    }
    Err(errors.join("；").into())
}
#[cfg(desktop)]
pub(crate) mod desktop {
    use super::*;
    use std::time::Duration;
    use tauri::ipc::Channel;
    use tauri_plugin_updater::{Update, UpdaterExt};
    static UPDATE: tokio::sync::Mutex<Option<Update>> = tokio::sync::Mutex::const_new(None);
    #[derive(Clone, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Progress { downloaded: usize, total: Option<u64>, route: Source, message: String }
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Info { version: String, notes: Option<String>, route: Source }
    fn development() -> Result<(), String> {
        if crate::core::paths::desktop_development() { Err("开发版不安装正式版更新".into()) } else { Ok(()) }
    }
    #[tauri::command]
    pub async fn app_update_check(app: tauri::AppHandle, source: Source, on_progress: Channel<Progress>) -> PlatformResult<Option<Info>> {
        development()?;
        let mut current = UPDATE.try_lock().map_err(|_| "已有更新任务正在进行")?;
        *current = None;
        let mut errors = Vec::new();
        for &route in source.routes() {
            let message = if errors.is_empty() { format!("正在连接 {}", route.label()) } else { format!("上一线路不可用，正在尝试 {}", route.label()) };
            let _ = on_progress.send(Progress { downloaded: 0, total: None, route, message });
            let result = async {
                let updater = app.updater_builder().endpoints(vec![transport::routed_url(transport::MANIFEST, route)?])
                    .map_err(|_| "更新入口无效")?.timeout(Duration::from_secs(12))
                    .configure_client(|client| client.https_only(true).connect_timeout(Duration::from_secs(8)).read_timeout(Duration::from_secs(20)))
                    .build().map_err(|_| "无法初始化更新器")?;
                updater.check().await.map_err(|_| "无法读取有效更新信息".to_string())
            }.await;
            match result {
                Ok(Some(update)) => {
                    if let Err(error) = transport::public_url(update.download_url.as_str()) {
                        errors.push(format!("{}：{error}", route.label()));
                        continue;
                    }
                    let info = Info { version: update.version.clone(), notes: update.body.clone(), route };
                    *current = Some(update);
                    return Ok(Some(info));
                },
                Ok(None) => return Ok(None),
                Err(error) => errors.push(format!("{}：{error}", route.label())),
            }
        }
        Err(errors.join("；").into())
    }
    #[tauri::command]
    pub async fn app_update_install(source: Source, expected_version: String, on_progress: Channel<Progress>) -> PlatformResult<()> {
        development()?;
        let mut current = UPDATE.try_lock().map_err(|_| "已有更新任务正在进行")?;
        let update = current.as_ref().ok_or("请先重新检查更新")?;
        if update.version != expected_version { return Err("版本已变化，请重新检查更新".into()); }
        let original = update.download_url.to_string();
        let mut errors = Vec::new();
        for &route in source.routes() {
            let mut candidate = update.clone();
            candidate.download_url = transport::routed_url(&original, route)?;
            candidate.timeout = Some(Duration::from_secs(1800));
            let message = if errors.is_empty() { format!("正在通过 {} 下载", route.label()) } else { format!("上一线路下载失败，正在通过 {} 重新下载同一版本", route.label()) };
            let _ = on_progress.send(Progress { downloaded: 0, total: None, route, message });
            let mut downloaded = 0;
            let result = candidate.download(|chunk, total| {
                downloaded += chunk;
                let _ = on_progress.send(Progress { downloaded, total, route, message: String::new() });
            }, || {}).await;
            match result {
                Ok(bytes) => {
                    // Tauri verifies the original signature in download(); install exactly once.
                    candidate.install(bytes).map_err(|_| "安装失败，请关闭其他应用窗口后重试")?;
                    *current = None;
                    return Ok(());
                },
                Err(_) => errors.push(format!("{}：下载中断、超时或签名校验失败", route.label())),
            }
        }
        Err(errors.join("；").into())
    }
}
