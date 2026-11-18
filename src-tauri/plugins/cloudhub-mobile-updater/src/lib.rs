use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{sync::atomic::{AtomicBool, Ordering}, time::Duration};
use tauri::{ipc::Channel, plugin::{Builder, TauriPlugin}, AppHandle, Manager, Runtime, State};
use tokio::io::AsyncWriteExt;

pub mod transport;
use transport::{Source, API};
const MAX_APK: u64 = 300 * 1024 * 1024;

struct UpdateState {
    busy: tokio::sync::Mutex<()>,
    cancelled: AtomicBool,
    cancellation: tokio::sync::Notify,
    ready: std::sync::Mutex<Option<String>>,
}
#[cfg(target_os = "android")]
struct Installer<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[derive(Deserialize)]
struct Asset { name: String, browser_download_url: String, size: u64, digest: Option<String> }
#[derive(Deserialize)]
struct Release { tag_name: String, draft: bool, prerelease: bool, body: Option<String>, assets: Vec<Asset> }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo { version: String, available: bool, notes: String, size: u64, downloadable: bool, route: Source }
#[derive(Clone, Serialize)]
struct Progress { downloaded: u64, total: u64, route: Source, message: String }

fn version(value: &str) -> Result<[u64; 3], String> {
    let parts: Vec<_> = value.strip_prefix('v').unwrap_or(value).split('.').collect();
    if parts.len() != 3 { return Err("版本信息无效".into()); }
    let mut result = [0; 3];
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() || !part.bytes().all(|c| c.is_ascii_digit()) { return Err("版本信息无效".into()); }
        result[i] = part.parse().map_err(|_| "版本信息无效")?;
    }
    Ok(result)
}
fn apk_asset(release: &Release) -> Option<&Asset> {
    let v = release.tag_name.strip_prefix('v')?;
    let name = format!("CloudHub.Tools_{v}_android_arm64.apk");
    let expected = format!("https://github.com/wlphp/cloudhub-tools/releases/download/v{v}/{name}");
    release.assets.iter().find(|a| a.name == name && a.browser_download_url == expected
        && a.size > 0 && a.size <= MAX_APK
        && a.digest.as_deref().and_then(|d| d.strip_prefix("sha256:"))
            .is_some_and(|d| d.len() == 64 && d.bytes().all(|c| c.is_ascii_hexdigit())))
}
async fn release(source: Source, progress: Option<&Channel<Progress>>) -> Result<(Release, Source), String> {
    let mut errors = Vec::new();
    for &route in source.routes() {
        if let Some(progress) = progress { let _ = progress.send(Progress { downloaded: 0, total: 0, route, message: if errors.is_empty() { format!("正在连接 {}", route.label()) } else { format!("上一线路不可用，正在尝试 {}", route.label()) } }); }
        let result = async {
            let value = transport::json_metadata(API, route).await?;
            let release: Release = serde_json::from_value(value).map_err(|_| "版本信息无效")?;
            version(&release.tag_name)?;
            if release.draft || release.prerelease { return Err("尚未发布稳定版本".to_string()); }
            Ok(release)
        }.await;
        match result { Ok(release) => return Ok((release, route)), Err(error) => errors.push(format!("{}：{error}", route.label())) }
    }
    Err(errors.join("；"))
}
#[tauri::command]
async fn check<R: Runtime>(app: AppHandle<R>, source: Option<Source>, on_progress: Channel<Progress>) -> Result<UpdateInfo, String> {
    let (release, route) = release(source.unwrap_or_default(), Some(&on_progress)).await?;
    let asset = apk_asset(&release);
    Ok(UpdateInfo { version: release.tag_name.trim_start_matches('v').into(),
        available: version(&release.tag_name)? > version(&app.package_info().version.to_string())?,
        notes: release.body.as_deref().unwrap_or("").chars().take(8000).collect(),
        size: asset.map(|a| a.size).unwrap_or(0), downloadable: asset.is_some() && cfg!(target_arch = "aarch64"), route })
}
#[tauri::command]
fn cancel(state: State<'_, UpdateState>) {
    state.cancelled.store(true, Ordering::Relaxed);
    state.cancellation.notify_waiters();
}

#[tauri::command]
async fn download<R: Runtime>(app: AppHandle<R>, state: State<'_, UpdateState>, expected_version: String, source: Option<Source>, on_progress: Channel<Progress>) -> Result<(), String> {
    let _guard = state.busy.try_lock().map_err(|_| "已有更新任务正在进行")?;
    state.cancelled.store(false, Ordering::Relaxed);
    *state.ready.lock().map_err(|_| "更新状态不可用")? = None;
    let dir = app.path().app_cache_dir().map_err(|_| "更新缓存不可用")?.join("cloudhub-updates");
    tokio::fs::create_dir_all(&dir).await.map_err(|_| "无法创建更新缓存")?;
    let partial = dir.join("update.part");
    let target = dir.join("update.apk");
    let _ = tokio::fs::remove_file(&target).await;
    let operation = async {
        if !cfg!(target_os = "android") || !cfg!(target_arch = "aarch64") { return Err("当前平台不支持 APK 更新".into()); }
        let (release, _) = release(source.unwrap_or_default(), Some(&on_progress)).await?;
        if release.tag_name.trim_start_matches('v') != expected_version
            || version(&release.tag_name)? <= version(&app.package_info().version.to_string())? {
            return Err("版本已变化，请重新检查更新".into());
        }
        let asset = apk_asset(&release).ok_or("Android 安装包尚未就绪，请稍后重试")?;
        let mut errors = Vec::new();
        let mut succeeded = false;
        for &route in source.unwrap_or_default().routes() {
            if state.cancelled.load(Ordering::Relaxed) { return Err("下载已取消".into()); }
            on_progress.send(Progress { downloaded: 0, total: asset.size, route, message: if errors.is_empty() { format!("正在通过 {} 下载", route.label()) } else { format!("上一线路下载失败，正在通过 {} 重新下载同一版本", route.label()) } }).map_err(|_| "更新页面已关闭")?;
            let attempt: Result<(), String> = async {
        let mut response = transport::client()?.get(transport::routed_url(&asset.browser_download_url, route)?).send().await.map_err(|_| "下载失败，请检查网络后重试")?;
        if !response.status().is_success() { return Err("无法下载安装包，请稍后重试".into()); }
        let mut file = tokio::fs::File::create(&partial).await.map_err(|_| "无法保存安装包")?;
        let mut hash = Sha256::new();
        let mut downloaded = 0u64;
        on_progress.send(Progress { downloaded, total: asset.size, route, message: String::new() }).map_err(|_| "更新页面已关闭")?;
        loop {
            if state.cancelled.load(Ordering::Relaxed) { return Err("下载已取消".into()); }
            let chunk = tokio::time::timeout(Duration::from_secs(30), response.chunk()).await
                .map_err(|_| "下载超时，请重试")?.map_err(|_| "下载中断，请重试")?;
            let Some(chunk) = chunk else { break; };
            downloaded += chunk.len() as u64;
            if downloaded > asset.size { return Err("安装包大小校验失败".into()); }
            hash.update(&chunk);
            file.write_all(&chunk).await.map_err(|_| "保存失败，请检查剩余空间")?;
            on_progress.send(Progress { downloaded, total: asset.size, route, message: String::new() }).map_err(|_| "更新页面已关闭")?;
        }
        if state.cancelled.load(Ordering::Relaxed) { return Err("下载已取消".into()); }
        if downloaded != asset.size || format!("sha256:{}", hex::encode(hash.finalize())) != asset.digest.as_deref().unwrap_or("") {
            return Err("安装包校验失败，请重新下载".into());
        }
        file.sync_all().await.map_err(|_| "保存安装包失败")?;
        drop(file);
                Ok(())
            }.await;
            match attempt {
                Ok(()) => { succeeded = true; break; },
                Err(error) => {
                    let _ = tokio::fs::remove_file(&partial).await;
                    if state.cancelled.load(Ordering::Relaxed) { return Err("下载已取消".into()); }
                    errors.push(format!("{}：{error}", route.label()));
                }
            }
        }
        if !succeeded { return Err(errors.join("；")); }
        tokio::fs::rename(&partial, &target).await.map_err(|_| "保存安装包失败")?;
        *state.ready.lock().map_err(|_| "更新状态不可用")? = Some(expected_version);
        Ok(())
    };
    let result = tokio::select! {
        result = operation => result,
        _ = state.cancellation.notified() => Err("下载已取消".into()),
    };
    if result.is_err() { let _ = tokio::fs::remove_file(&partial).await; }
    result
}
#[tauri::command]
async fn install<R: Runtime>(app: AppHandle<R>, state: State<'_, UpdateState>) -> Result<String, String> {
    let _guard = state.busy.try_lock().map_err(|_| "下载仍在进行")?;
    let expected = state.ready.lock().map_err(|_| "更新状态不可用")?.clone().ok_or("请先下载更新")?;
    #[cfg(target_os = "android")]
    {
        let path = app.path().app_cache_dir().map_err(|_| "更新缓存不可用")?.join("cloudhub-updates/update.apk");
        let result: serde_json::Value = app.state::<Installer<R>>().0.run_mobile_plugin("installApk", serde_json::json!({ "path": path, "version": expected }))
            .map_err(|_| "安装包验证或安装启动失败，请重新下载；确认签名与当前应用一致")?;
        return Ok(result["status"].as_str().unwrap_or("error").to_string());
    }
    #[cfg(not(target_os = "android"))]
    { let _ = (app, expected); Err("当前平台不支持 APK 安装".into()) }
}
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("cloudhub-mobile-updater")
        .invoke_handler(tauri::generate_handler![check, download, cancel, install])
        .setup(|app, _api| {
            #[cfg(target_os = "android")]
            app.manage(Installer(_api.register_android_plugin("com.cloudhub.updater", "UpdaterPlugin")?));
            app.manage(UpdateState { busy: tokio::sync::Mutex::new(()), cancelled: AtomicBool::new(false), cancellation: tokio::sync::Notify::new(), ready: std::sync::Mutex::new(None) });
            Ok(())
        }).build()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn stable_versions_only() {
        assert!(version("v0.1.42").unwrap() > version("0.1.41").unwrap());
        for value in ["1.2", "1.2.3-beta", "1.2.x", "1.2.3/evil"] { assert!(version(value).is_err()); }
    }
    #[test] fn assets_are_pinned_and_require_digest() {
        let mut r = Release { tag_name: "v0.1.42".into(), draft: false, prerelease: false, body: None, assets: vec![Asset {
            name: "CloudHub.Tools_0.1.42_android_arm64.apk".into(), browser_download_url: "https://github.com/wlphp/cloudhub-tools/releases/download/v0.1.42/CloudHub.Tools_0.1.42_android_arm64.apk".into(), size: 100, digest: Some(format!("sha256:{}", "a".repeat(64))) }] };
        assert!(apk_asset(&r).is_some());
        r.assets[0].browser_download_url.push_str("?other"); assert!(apk_asset(&r).is_none());
        r.assets[0].browser_download_url = r.assets[0].browser_download_url.replace("?other", "");
        r.assets[0].size = MAX_APK + 1; assert!(apk_asset(&r).is_none());
        r.assets[0].size = 100; r.assets[0].digest = None; assert!(apk_asset(&r).is_none());
        r.assets[0].digest = Some(format!("sha256:{}", "g".repeat(64))); assert!(apk_asset(&r).is_none());
    }
}
