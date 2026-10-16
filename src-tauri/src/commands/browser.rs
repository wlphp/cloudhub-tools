use crate::core::{browser::{self, kernel, model::{self, Environment, SaveEnvironment}, runtime::{BrowserState, Snapshot}}, error::PlatformResult};
use tauri::State;

#[tauri::command]
pub(crate) fn browser_snapshot(state: State<'_, BrowserState>) -> PlatformResult<Snapshot> { state.snapshot() }

#[tauri::command]
pub(crate) async fn browser_save(state: State<'_, BrowserState>, input: SaveEnvironment) -> PlatformResult<Environment> {
    browser::require_supported()?;
    let _guard = state.operations.lock().await;
    if let Some(id) = &input.id { if state.is_running(id)? { return Err(browser::error("请先关闭环境再修改配置")); } }
    let _lease = input.id.as_deref().map(browser::profile_lease).transpose()?;
    model::save(input)
}
#[tauri::command]
pub(crate) async fn browser_set_deleted(state: State<'_, BrowserState>, id: String, deleted: bool) -> PlatformResult<()> {
    browser::require_supported()?;
    let _guard = state.operations.lock().await;
    if state.is_running(&id)? { return Err(browser::error("请先关闭环境再移入回收站")); }
    let _lease = browser::profile_lease(&id)?;
    model::set_deleted(&id, deleted)
}
#[tauri::command]
pub(crate) async fn browser_launch(state: State<'_, BrowserState>, id: String) -> PlatformResult<()> {
    let _guard = state.operations.lock().await;
    state.launch(&id).await
}
#[tauri::command]
pub(crate) async fn browser_stop(state: State<'_, BrowserState>, id: String) -> PlatformResult<()> {
    let _guard = state.operations.lock().await;
    state.stop(&id).await
}
#[tauri::command]
pub(crate) async fn browser_install_kernel(state: State<'_, BrowserState>, version: String) -> PlatformResult<()> {
    kernel::install(state.kernel.clone(), &version, None).await
}
#[tauri::command]
pub(crate) fn browser_cancel_install(state: State<'_, BrowserState>) {
    state.kernel.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
}
#[tauri::command]
pub(crate) async fn browser_uninstall_kernel(state: State<'_, BrowserState>, version: String) -> PlatformResult<()> {
    let _guard = state.operations.lock().await;
    if model::list()?.iter().any(|item| item.config.kernel_version==version && state.is_running(&item.id).unwrap_or(true)) { return Err(browser::error("请先关闭所有浏览器环境再卸载内核")); }
    kernel::uninstall(state.kernel.clone(),&version)
}
#[tauri::command]
pub(crate) async fn browser_remove(state: State<'_, BrowserState>, id: String, confirmation_name: String) -> PlatformResult<()> {
    browser::require_supported()?;
    let _guard = state.operations.lock().await;
    if state.is_running(&id)? { return Err(browser::error("请先关闭浏览器环境")); }
    let _lease = browser::profile_lease(&id)?;
    model::remove(&id, &confirmation_name)
}
#[tauri::command]
pub(crate) async fn browser_move_group(state: State<'_, BrowserState>, ids: Vec<String>, group: String) -> PlatformResult<()> {
    browser::require_supported()?;
    let _guard = state.operations.lock().await;
    for id in &ids { if state.is_running(id)? { return Err(browser::error("请先关闭选中的环境再移动分组")); } }
    let _leases = ids.iter().map(|id| browser::profile_lease(id)).collect::<PlatformResult<Vec<_>>>()?;
    model::move_group(&ids, &group)
}
#[tauri::command]
pub(crate) async fn browser_cookie_file(state: State<'_, BrowserState>, app: tauri::AppHandle, id: String, export: bool) -> PlatformResult<bool> {
    use tauri_plugin_dialog::DialogExt;
    browser::require_supported()?;
    let _guard = state.operations.lock().await;
    if !state.is_running(&id)? { return Err(browser::error("请先打开环境，再导入或导出 Cookie")); }
    if export {
        let target = app.dialog().file().set_file_name("browser-cookies.json").add_filter("Cookie JSON（包含登录资料）", &["json"]).blocking_save_file();
        let Some(target) = target else { return Ok(false); };
        let path = target.into_path().map_err(|_| browser::error("请选择本机文件位置"))?;
        let cookies = state.cookies(&id,None).await?;
        let bytes = serde_json::to_vec_pretty(&cookies["cookies"]).map_err(|_| browser::error("无法导出 Cookie"))?;
        if bytes.len() > 5 * 1024 * 1024 { return Err(browser::error("Cookie 导出超过 5 MiB 限制")); }
        std::fs::write(path,bytes).map_err(|_| browser::error("无法保存 Cookie 文件"))?;
    } else {
        let source = app.dialog().file().add_filter("Cookie JSON / Netscape", &["json","txt"]).blocking_pick_file();
        let Some(source) = source else { return Ok(false); };
        let path = source.into_path().map_err(|_| browser::error("请选择本机 Cookie 文件"))?;
        use std::io::Read;
        let mut bytes = Vec::new();
        std::fs::File::open(path).map_err(|_| browser::error("无法读取 Cookie 文件"))?.take(5 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|_| browser::error("无法读取 Cookie 文件"))?;
        state.cookies(&id,Some(browser::cookies::parse(&bytes)?)).await?;
    }
    Ok(true)
}
#[tauri::command]
pub(crate) async fn browser_check_proxy(state: State<'_, BrowserState>, id: String) -> PlatformResult<String> {
    browser::require_supported()?;
    let _guard = state.operations.lock().await;
    let environment = model::get(&id)?;
    model::validate(&environment.config)?;
    let relay = if environment.config.proxy.kind != "direct" { Some(browser::proxy::start(environment.config.proxy.clone(),model::password(&id)?).await?) } else { None };
    let mut builder = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(10)).timeout(std::time::Duration::from_secs(20));
    if let Some(relay) = &relay { builder = builder.proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{}",relay.port)).map_err(|_| browser::error("代理检测配置失败"))?); }
    let client = builder.build().map_err(|_| browser::error("代理检测配置失败"))?;
    // Explicit user action only. The fixed endpoint receives the selected exit IP.
    let mut response = client.get("https://api.ipify.org?format=json").send().await.map_err(|_| browser::error("出口 IP 检测失败，请检查代理地址、认证及网络连接"))?;
    if !response.status().is_success() { return Err(browser::error("出口 IP 服务暂不可用")); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| browser::error("出口 IP 响应读取失败"))? {
        if bytes.len() + chunk.len() > 4096 { return Err(browser::error("出口 IP 响应无效")); } bytes.extend_from_slice(&chunk);
    }
    let result: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| browser::error("出口 IP 响应无效"))?;
    let ip = result["ip"].as_str().ok_or(browser::error("出口 IP 响应无效"))?.parse::<std::net::IpAddr>().map_err(|_| browser::error("出口 IP 响应无效"))?;
    Ok(ip.to_string())
}
#[tauri::command]
pub(crate) async fn browser_import_kernel(state: State<'_, BrowserState>, app: tauri::AppHandle, version: String) -> PlatformResult<bool> {
    use tauri_plugin_dialog::DialogExt;
    browser::require_supported()?;
    let selection = app.dialog().file().add_filter("Chrome for Testing 官方 ZIP", &["zip"]).blocking_pick_file();
    let Some(path) = selection else { return Ok(false); };
    let path = path.into_path().map_err(|_| browser::error("请选择本机内核 ZIP 文件"))?;
    kernel::install(state.kernel.clone(), &version, Some(path)).await?;
    Ok(true)
}
