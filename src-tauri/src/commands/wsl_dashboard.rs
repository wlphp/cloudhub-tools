//! Local WSL distribution management. Arguments are passed directly to wsl.exe;
//! no user input is interpolated into a shell command.
use crate::core::{error::PlatformResult, repositories::preferences as preferences_repository, storage::open_db};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path, process::{Command, Output, Stdio}};

const SETTINGS_KEY: &str = "wsl.dashboard.settings";
const LOGS_KEY: &str = "wsl.dashboard.logs";
const MAX_LOG_ENTRIES: usize = 200;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DistroMetadata {
    installed_at: Option<i64>,
    last_started_at: Option<i64>,
    remark: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WslDashboardSettings {
    default_install_location: String,
    distributions: BTreeMap<String, DistroMetadata>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WslDistribution {
    name: String,
    state: String,
    version: Option<u8>,
    is_default: bool,
    installed_at: Option<i64>,
    last_started_at: Option<i64>,
    remark: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WslOnlineDistribution {
    name: String,
    friendly_name: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WslOperationLog {
    timestamp: i64,
    action: String,
    distribution: Option<String>,
    success: bool,
}

fn load_settings() -> PlatformResult<WslDashboardSettings> {
    let conn = open_db()?;
    let preferences = preferences_repository::list(&conn)?;
    Ok(preferences.get(SETTINGS_KEY)
        .and_then(|value| serde_json::from_str(value).ok())
        .unwrap_or_default())
}

fn save_settings(settings: &WslDashboardSettings) -> PlatformResult<()> {
    let value = serde_json::to_string(settings).map_err(|_| "无法保存 WSL 管理设置")?;
    preferences_repository::save(&open_db()?, SETTINGS_KEY, &value, chrono::Utc::now().timestamp_millis())?;
    Ok(())
}

fn load_logs() -> PlatformResult<Vec<WslOperationLog>> {
    let conn = open_db()?;
    let preferences = preferences_repository::list(&conn)?;
    Ok(preferences.get(LOGS_KEY)
        .and_then(|value| serde_json::from_str::<Vec<WslOperationLog>>(value).ok())
        .unwrap_or_default())
}

fn record_operation(action: &str, distribution: Option<&str>, success: bool) {
    let Ok(mut entries) = load_logs() else { return; };
    entries.insert(0, WslOperationLog {
        timestamp: now_millis(),
        action: action.chars().take(80).collect(),
        distribution: distribution.map(|name| name.chars().filter(|character| !character.is_control()).take(128).collect()),
        success,
    });
    entries.truncate(MAX_LOG_ENTRIES);
    let Ok(value) = serde_json::to_string(&entries) else { return; };
    if let Ok(conn) = open_db() {
        let _ = preferences_repository::save(&conn, LOGS_KEY, &value, now_millis());
    }
}

#[tauri::command]
pub(crate) fn wsl_dashboard_settings_get() -> PlatformResult<WslDashboardSettings> { load_settings() }

fn now_millis() -> i64 { chrono::Utc::now().timestamp_millis() }

#[cfg(not(windows))]
fn unsupported<T>() -> PlatformResult<T> {
    Err("WSL 管理插件仅支持安装了 WSL 的 Windows 桌面端".into())
}

#[cfg(windows)]
fn invoke_wsl(args: &[&str]) -> PlatformResult<Output> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let output = Command::new("wsl.exe")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|_| "未能启动 WSL。请确认 Windows 已启用 WSL 并重试")?;
    if output.status.success() { return Ok(output); }
    let diagnostic = format!("{}\n{}", output_text(&output.stdout), output_text(&output.stderr));
    if diagnostic.contains("WSL_E_DISTRO_NOT_FOUND") {
        return Err("该发行版已不存在，请刷新列表".into());
    }
    if diagnostic.contains("Wsl/Service/E_UNEXPECTED") {
        return Err("WSL 服务内部错误（E_UNEXPECTED）。请保存工作并停止全部 WSL 后重试；仍失败时重启 Windows".into());
    }
    Err("WSL 命令未完成，请检查发行版、安装目录和 WSL 状态".into())
}

#[cfg(windows)]
fn start_distribution(name: &str) -> PlatformResult<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    invoke_wsl(&["--distribution", name, "--cd", "/", "--exec", "/bin/sh", "-c", ":"])?;
    let mut child = Command::new("wsl.exe")
        .args(["--distribution", name, "--cd", "/", "--exec", "/bin/sleep", "infinity"])
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW).spawn().map_err(|_| "未能启动该发行版，请检查 WSL 安装和发行版环境")?;
    for _ in 0..10 {
        std::thread::sleep(std::time::Duration::from_millis(200));
        if child.try_wait().map_err(|_| "无法确认发行版运行状态，请刷新列表")?.is_some() {
            return Err("发行版启动进程已退出，请检查 Linux 环境后重试".into());
        }
        let output = match invoke_wsl(&["--list", "--verbose", "--all"]) {
            Ok(output) => output,
            Err(reason) => { let _ = child.kill(); let _ = child.wait(); return Err(reason); }
        };
        if parse_distributions(&output_text(&output.stdout), &WslDashboardSettings::default()).iter()
            .any(|item| item.name == name && item.state.eq_ignore_ascii_case("running")) { return Ok(()); }
    }
    let _ = child.kill();
    let _ = child.wait();
    Err("无法确认发行版运行状态，请刷新列表".into())
}

#[cfg(not(windows))]
fn invoke_wsl(_args: &[&str]) -> PlatformResult<Output> { unsupported() }

#[cfg(windows)]
fn output_text(bytes: &[u8]) -> String {
    if bytes.contains(&0) {
        let little_endian = bytes.chunks_exact(2).map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]])).collect::<Vec<_>>();
        return String::from_utf16_lossy(&little_endian).trim_matches('\0').trim_start_matches('\u{feff}').to_owned();
    }
    if let Ok(text) = std::str::from_utf8(bytes) { return text.trim_matches('\0').trim_start_matches('\u{feff}').to_owned(); }
    let little_endian = bytes.chunks_exact(2).map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]])).collect::<Vec<_>>();
    String::from_utf16_lossy(&little_endian).trim_matches('\0').trim_start_matches('\u{feff}').to_owned()
}

#[cfg(windows)]
fn parse_distributions(text: &str, settings: &WslDashboardSettings) -> Vec<WslDistribution> {
    text.lines().filter_map(|line| {
        let line = line.trim();
        if line.is_empty() { return None; }
        let is_default = line.starts_with('*');
        let line = line.strip_prefix('*').unwrap_or(line).trim_start();
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.len() < 3 { return None; }
        let version = fields[fields.len() - 1].parse::<u8>().ok();
        let state = fields[fields.len() - 2].to_owned();
        let name = fields[..fields.len() - 2].join(" ");
        if name.is_empty() || matches!(name.to_ascii_lowercase().as_str(), "name" | "windows") { return None; }
        let metadata = settings.distributions.get(&name).cloned().unwrap_or_default();
        Some(WslDistribution { name, state, version, is_default, installed_at: metadata.installed_at, last_started_at: metadata.last_started_at, remark: metadata.remark })
    }).collect()
}

#[cfg(windows)]
fn parse_online_distributions(text: &str) -> Vec<WslOnlineDistribution> {
    text.lines().filter_map(|line| {
        let line = line.trim();
        if line.is_empty() { return None; }
        let mut fields = line.split_whitespace();
        let name = fields.next()?;
        if name.eq_ignore_ascii_case("name") || name.chars().any(|c| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))) { return None; }
        let friendly_name = fields.collect::<Vec<_>>().join(" ");
        if friendly_name.is_empty() { return None; }
        Some(WslOnlineDistribution { name: name.to_owned(), friendly_name })
    }).collect()
}

fn validate_name(name: &str) -> PlatformResult<&str> {
    let name = name.trim();
    if name.is_empty() || name.len() > 128 || name.chars().any(|c| c.is_control()) {
        return Err("发行版名称无效，请刷新列表后重试".into());
    }
    Ok(name)
}

fn validate_install_location(location: &str) -> PlatformResult<&str> {
    let location = location.trim();
    if location.len() > 32_000 || location.chars().any(|c| c.is_control()) {
        return Err("安装目录无效，请重新选择目录".into());
    }
    #[cfg(windows)]
    if !location.is_empty() && !std::path::Path::new(location).is_absolute() {
        return Err("安装目录必须是 Windows 绝对路径".into());
    }
    Ok(location)
}

fn validate_rootfs_file(file_path: &str) -> PlatformResult<()> {
    let file_path = file_path.trim();
    let path = Path::new(file_path);
    if file_path.is_empty() || !path.is_absolute() || !path.is_file() {
        return Err("请选择存在的 RootFS 文件".into());
    }
    let name = path.file_name().map(|name| name.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    if ![".tar", ".tar.gz", ".tar.xz", ".wsl"].iter().any(|extension| name.ends_with(extension)) {
        return Err("RootFS 文件仅支持 .tar、.tar.gz、.tar.xz 或 .wsl".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn wsl_dashboard_list() -> PlatformResult<Vec<WslDistribution>> {
    #[cfg(windows)] {
        let output = invoke_wsl(&["--list", "--verbose", "--all"])?;
        let settings = load_settings()?;
        Ok(parse_distributions(&output_text(&output.stdout), &settings))
    }
    #[cfg(not(windows))] { unsupported() }
}

fn load_online_distributions() -> PlatformResult<Vec<WslOnlineDistribution>> {
    #[cfg(windows)] {
        let output = invoke_wsl(&["--list", "--online"]).map_err(|_| "无法读取 WSL 在线目录，请检查网络连接后重试")?;
        let catalog = parse_online_distributions(&output_text(&output.stdout));
        if catalog.is_empty() { return Err("WSL 在线目录为空，请重新加载目录".into()); }
        Ok(catalog)
    }
    #[cfg(not(windows))] { unsupported() }
}

#[tauri::command]
pub(crate) async fn wsl_dashboard_online_list() -> PlatformResult<Vec<WslOnlineDistribution>> {
    tauri::async_runtime::spawn_blocking(load_online_distributions).await.map_err(|_| "读取 WSL 在线目录任务失败，请重试")?
}

#[tauri::command]
pub(crate) fn wsl_dashboard_save_settings(default_install_location: String, name: Option<String>, remark: Option<String>) -> PlatformResult<()> {
    let location = validate_install_location(&default_install_location)?.to_owned();
    let mut settings = load_settings()?;
    settings.default_install_location = location;
    if let (Some(name), Some(remark)) = (name, remark) {
        let name = validate_name(&name)?.to_owned();
        if remark.len() > 500 || remark.chars().any(|c| c.is_control() && c != '\n' && c != '\t') {
            return Err("备注最多 500 个字符，且不能包含控制字符".into());
        }
        settings.distributions.entry(name).or_default().remark = remark;
    }
    save_settings(&settings)
}

#[tauri::command]
pub(crate) async fn wsl_dashboard_select_install_location(app: tauri::AppHandle) -> PlatformResult<Option<String>> {
    #[cfg(windows)] {
        return tauri::async_runtime::spawn_blocking(move || {
            use tauri_plugin_dialog::DialogExt;
            let Some(folder) = app.dialog().file().set_title("选择 WSL 发行版默认安装目录").blocking_pick_folder() else { return Ok(None); };
            let path = folder.into_path().map_err(|_| "请选择本机安装目录")?;
            let path = path.to_str().ok_or("请选择有效的 Windows 安装目录")?;
            validate_install_location(path)?;
            Ok(Some(path.to_owned()))
        }).await.map_err(|_| "选择 WSL 安装目录失败")?;
    }
    #[cfg(not(windows))] { let _ = app; unsupported() }
}

#[tauri::command]
pub(crate) async fn wsl_dashboard_select_rootfs_file(app: tauri::AppHandle) -> PlatformResult<Option<String>> {
    #[cfg(windows)] {
        return tauri::async_runtime::spawn_blocking(move || {
            use tauri_plugin_dialog::DialogExt;
            let Some(file) = app.dialog().file().set_title("选择 WSL RootFS 文件")
                .add_filter("RootFS 压缩包", &["tar", "tar.gz", "tar.xz", "wsl"])
                .blocking_pick_file() else { return Ok(None); };
            let path = file.into_path().map_err(|_| "请选择本机 RootFS 文件")?;
            let path = path.to_str().ok_or("RootFS 文件路径无效")?;
            validate_rootfs_file(path)?;
            Ok(Some(path.to_owned()))
        }).await.map_err(|_| "选择 RootFS 文件失败")?;
    }
    #[cfg(not(windows))] { let _ = app; unsupported() }
}

#[tauri::command]
pub(crate) fn wsl_dashboard_logs_get() -> PlatformResult<Vec<WslOperationLog>> { load_logs() }

#[tauri::command]
pub(crate) fn wsl_dashboard_logs_clear() -> PlatformResult<()> {
    let conn = open_db()?;
    preferences_repository::save(&conn, LOGS_KEY, "[]", now_millis())?;
    Ok(())
}

fn control_distribution(name: String, action: String, confirmation_name: Option<String>) -> PlatformResult<()> {
    let name = validate_name(&name)?;
    if action == "unregister" && confirmation_name.as_deref() != Some(name) {
        return Err("请输入完整发行版名称以确认删除".into());
    }
    let distributions = wsl_dashboard_list()?;
    if !distributions.iter().any(|item| item.name == name) { return Err("该发行版已不存在，请刷新列表".into()); }
    let mut wsl_action_completed = false;
    let result = (|| { match action.as_str() {
        "start" => {
            #[cfg(windows)] {
                start_distribution(name)?;
                wsl_action_completed = true;
                let mut settings = load_settings()?;
                settings.distributions.entry(name.to_owned()).or_default().last_started_at = Some(now_millis());
                save_settings(&settings)
            }
            #[cfg(not(windows))] { unsupported() }
        }
        "stop" => { #[cfg(windows)] { invoke_wsl(&["--terminate", name])?; Ok(()) } #[cfg(not(windows))] { unsupported() } }
        "default" => { #[cfg(windows)] { invoke_wsl(&["--set-default", name])?; Ok(()) } #[cfg(not(windows))] { unsupported() } }
        "unregister" => {
            #[cfg(windows)] {
                invoke_wsl(&["--unregister", name])?;
                wsl_action_completed = true;
                let mut settings = load_settings()?;
                settings.distributions.remove(name);
                save_settings(&settings)
            }
            #[cfg(not(windows))] { unsupported() }
        }
        _ => Err("不支持该 WSL 操作".into()),
    } })();
    record_operation(match action.as_str() { "start" => "启动", "stop" => "停止", "default" => "设为默认", "unregister" => "删除发行版", _ => "未知操作" }, Some(name), result.is_ok() || wsl_action_completed);
    result
}

#[tauri::command]
pub(crate) async fn wsl_dashboard_control(name: String, action: String, confirmation_name: Option<String>) -> PlatformResult<()> {
    tauri::async_runtime::spawn_blocking(move || control_distribution(name, action, confirmation_name))
        .await.map_err(|_| "WSL 操作任务失败，请重试")?
}

fn ensure_registered_distribution(name: &str) -> PlatformResult<()> {
    let distributions = wsl_dashboard_list()?;
    if distributions.iter().any(|item| item.name == name) { Ok(()) }
    else { Err("该发行版已不存在，请刷新列表".into()) }
}

#[tauri::command]
pub(crate) async fn wsl_dashboard_backup(app: tauri::AppHandle, name: String) -> PlatformResult<Option<String>> {
    let name = validate_name(&name)?.to_owned();
    #[cfg(windows)] {
        tauri::async_runtime::spawn_blocking(move || {
            use tauri_plugin_dialog::DialogExt;
            ensure_registered_distribution(&name)?;
            let safe_name: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')).collect();
            let filename = format!("{}-{}.tar", if safe_name.is_empty() { "wsl" } else { &safe_name }, chrono::Local::now().format("%Y%m%d-%H%M%S"));
            let Some(file) = app.dialog().file().set_title("备份 WSL 发行版").set_file_name(&filename)
                .add_filter("WSL 备份（TAR）", &["tar"]).blocking_save_file() else { return Ok(None); };
            let destination = file.into_path().map_err(|_| "请选择本机 TAR 备份文件位置")?;
            if !destination.is_absolute() || destination.is_dir()
                || !destination.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("tar")) {
                return Err("请选择本机 TAR 备份文件位置".into());
            }
            let destination_text = destination.to_str().ok_or("请选择本机 TAR 备份文件位置")?.to_owned();
            let parent = destination.parent().ok_or("请选择本机 TAR 备份文件位置")?;
            let staged = parent.join(format!(".cloudhub-wsl-backup-{}.tar", uuid::Uuid::new_v4()));
            let staged_text = staged.to_str().ok_or("请选择本机 TAR 备份文件位置")?;
            let result = (|| {
                invoke_wsl(&["--export", &name, staged_text])?;
                if std::fs::metadata(&staged).map_err(|_| "WSL 备份文件未生成，请重试")?.len() == 0 {
                    return Err("WSL 备份文件未生成，请重试".into());
                }
                std::fs::rename(&staged, &destination).map_err(|_| "无法保存 WSL 备份，请检查文件占用、目录权限和磁盘空间")?;
                Ok(Some(destination_text))
            })();
            let _ = std::fs::remove_file(&staged);
            record_operation("备份发行版", Some(&name), result.is_ok());
            result
        }).await.map_err(|_| "备份 WSL 发行版任务失败，请重试")?
    }
    #[cfg(not(windows))] { let _ = (app, name); unsupported() }
}

#[tauri::command]
pub(crate) fn wsl_dashboard_open_terminal(name: String) -> PlatformResult<()> {
    let name = validate_name(&name)?;
    ensure_registered_distribution(name)?;
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x00000010;
        let result = if Command::new("wt.exe").args(["new-tab", "--title", name, "wsl.exe", "--distribution", name, "--cd", "~"]).spawn().is_ok() { Ok(()) }
        else { Command::new("wsl.exe").args(["--distribution", name, "--cd", "~"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .creation_flags(CREATE_NEW_CONSOLE).spawn().map(|_| ())
            .map_err(|_| "无法打开 WSL 终端，请确认 Windows Terminal 或 WSL 可用".into()) };
        record_operation("打开终端", Some(name), result.is_ok());
        result
    }
    #[cfg(not(windows))] { unsupported() }
}

#[tauri::command]
pub(crate) fn wsl_dashboard_open_folder(name: String) -> PlatformResult<()> {
    let name = validate_name(&name)?;
    if name.chars().any(|character| matches!(character, '/' | '\\')) { return Err("发行版名称无效，无法安全打开文件夹".into()); }
    ensure_registered_distribution(name)?;
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let path = format!(r"\\wsl$\{name}");
        let result = Command::new("explorer.exe").arg(path).creation_flags(CREATE_NO_WINDOW).spawn().map(|_| ())
            .map_err(|_| "无法打开该发行版的文件夹".into());
        record_operation("打开文件夹", Some(name), result.is_ok());
        result
    }
    #[cfg(not(windows))] { unsupported() }
}

#[tauri::command]
pub(crate) fn wsl_dashboard_shutdown() -> PlatformResult<()> {
    #[cfg(windows)] { let result = invoke_wsl(&["--shutdown"]).map(|_| ()); record_operation("停止全部 WSL", None, result.is_ok()); result }
    #[cfg(not(windows))] { unsupported() }
}

#[tauri::command]
pub(crate) fn wsl_dashboard_install(distribution: String, location: String) -> PlatformResult<()> {
    let distribution = validate_name(&distribution)?;
    let location = validate_install_location(&location)?;
    #[cfg(windows)] {
        let mut install_completed = false;
        let result = (|| {
        let installed = wsl_dashboard_list()?;
        if installed.iter().any(|item| item.name.trim().eq_ignore_ascii_case(distribution)) {
            return Err("该发行版已安装，请从下方列表直接启动或管理".into());
        }
        let online = load_online_distributions()?;
        if !online.iter().any(|item| item.name == distribution) { return Err("请选择 WSL 在线列表中的发行版".into()); }
        let mut args = vec!["--install", "--distribution", distribution, "--no-launch"];
        let location_arg = if location.is_empty() { None } else { Some(location) };
        if let Some(location) = location_arg { args.extend(["--location", location]); }
        invoke_wsl(&args)?;
        install_completed = true;
        let mut settings = load_settings()?;
        settings.distributions.entry(distribution.to_owned()).or_default().installed_at = Some(now_millis());
        save_settings(&settings)
        })();
        record_operation("在线安装发行版", Some(distribution), result.is_ok() || install_completed);
        result
    }
    #[cfg(not(windows))] { let _ = (distribution, location); unsupported() }
}

#[tauri::command]
pub(crate) fn wsl_dashboard_clone(source: String, distribution: String, install_location: String) -> PlatformResult<()> {
    let source = validate_name(&source)?;
    let distribution = validate_name(&distribution)?;
    if distribution.starts_with('-') || distribution.chars().any(|character| !(character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'))) {
        return Err("发行版名称无效，请使用字母、数字、点、下划线或连字符".into());
    }
    let install_location = validate_install_location(&install_location)?;
    if install_location.is_empty() || Path::new(install_location).file_name().is_none() {
        return Err("请选择发行版专用的安装目录".into());
    }
    #[cfg(windows)] {
        let archive_path = std::env::temp_dir().join(format!("cloudhub-wsl-copy-{}.tar", uuid::Uuid::new_v4()));
        let archive = archive_path.to_str().ok_or("无法创建发行版临时导出文件")?;
        let mut clone_completed = false;
        let result = (|| {
            let registered = wsl_dashboard_list()?;
            if !registered.iter().any(|item| item.name.eq_ignore_ascii_case(source)) {
                return Err("源发行版不存在，请刷新列表".into());
            }
            if registered.iter().any(|item| item.name.eq_ignore_ascii_case(distribution)) {
                return Err("新实例名称已存在，请更换名称".into());
            }
            let target = Path::new(install_location);
            if target.exists() && !target.is_dir() { return Err("安装目录已存在且不是文件夹".into()); }
            std::fs::create_dir_all(target).map_err(|_| "无法创建发行版安装目录，请检查路径权限和磁盘空间")?;
            if std::fs::read_dir(target).map_err(|_| "无法读取发行版安装目录")?.next().is_some() {
                return Err("发行版安装目录必须为空，请选择新的空目录".into());
            }
            invoke_wsl(&["--export", source, archive])?;
            invoke_wsl(&["--import", distribution, install_location, archive, "--version", "2"])?;
            clone_completed = true;
            let mut settings = load_settings()?;
            settings.distributions.entry(distribution.to_owned()).or_default().installed_at = Some(now_millis());
            save_settings(&settings)
        })();
        let _ = std::fs::remove_file(&archive_path);
        record_operation("复制发行版", Some(distribution), result.is_ok() || clone_completed);
        result
    }
    #[cfg(not(windows))] { let _ = (source, distribution, install_location); unsupported() }
}

#[tauri::command]
pub(crate) fn wsl_dashboard_import_rootfs(distribution: String, install_location: String, file_path: String) -> PlatformResult<()> {
    let distribution = validate_name(&distribution)?;
    if distribution.starts_with('-') || distribution.chars().any(|character| !(character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'))) {
        return Err("发行版名称无效，请使用字母、数字、点、下划线或连字符".into());
    }
    let install_location = validate_install_location(&install_location)?;
    if install_location.is_empty() || Path::new(install_location).file_name().is_none() {
        return Err("请选择发行版专用的安装目录".into());
    }
    validate_rootfs_file(&file_path)?;
    #[cfg(windows)] {
        let mut import_completed = false;
        let result = (|| {
            if wsl_dashboard_list()?.iter().any(|item| item.name.trim().eq_ignore_ascii_case(distribution)) {
                return Err("该发行版已安装，请更换实例名称或从下方列表管理".into());
            }
            let target = Path::new(install_location);
            if target.exists() && !target.is_dir() { return Err("安装目录已存在且不是文件夹".into()); }
            std::fs::create_dir_all(target).map_err(|_| "无法创建发行版安装目录，请检查路径权限和磁盘空间")?;
            if std::fs::read_dir(target).map_err(|_| "无法读取发行版安装目录")?.next().is_some() {
                return Err("发行版安装目录必须为空，请选择新的空目录".into());
            }
            invoke_wsl(&["--import", distribution, install_location, file_path.trim(), "--version", "2"])?;
            import_completed = true;
            let mut settings = load_settings()?;
            settings.distributions.entry(distribution.to_owned()).or_default().installed_at = Some(now_millis());
            save_settings(&settings)
        })();
        record_operation("本地 RootFS 导入", Some(distribution), result.is_ok() || import_completed);
        result
    }
    #[cfg(not(windows))] { let _ = (distribution, install_location, file_path); unsupported() }
}
