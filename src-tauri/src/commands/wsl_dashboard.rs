//! Local WSL distribution management. Arguments are passed directly to wsl.exe;
//! no user input is interpolated into a shell command.
use crate::core::{error::PlatformResult, repositories::preferences as preferences_repository, storage::open_db};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::{Path, PathBuf}, process::{Command, Output, Stdio}, sync::{Arc, atomic::{AtomicU64, Ordering}}, time::{Duration, Instant}};
use tauri::ipc::Channel;

const SETTINGS_KEY: &str = "wsl.dashboard.settings";
const LOGS_KEY: &str = "wsl.dashboard.logs";
const MAX_LOG_ENTRIES: usize = 200;
const MIN_SUPPORTED_WSL_VERSION: &str = "2.6.3";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WslRuntimeComponent {
    name: String,
    version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WslRuntimeInfo {
    current_version: Option<String>,
    minimum_supported_version: String,
    compatible: Option<bool>,
    components: Vec<WslRuntimeComponent>,
    message: Option<String>,
}

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
pub(crate) struct WslDistributionDetails {
    name: String,
    state: String,
    version: Option<u8>,
    is_default: bool,
    ip_address: Option<String>,
    root_used_bytes: Option<u64>,
    installed_at: Option<i64>,
    last_started_at: Option<i64>,
    remark: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WslDistroConfig {
    automount_enabled: bool,
    mount_fstab: bool,
    mount_root: String,
    mount_options: String,
    generate_hosts: bool,
    generate_resolv_conf: bool,
    hostname: String,
    interop_enabled: bool,
    append_windows_path: bool,
    default_user: String,
    systemd: bool,
    boot_command: String,
    protect_binfmt: bool,
    init_timeout: u32,
    use_windows_timezone: bool,
    gpu_enabled: bool,
    append_gpu_lib_path: bool,
}

impl Default for WslDistroConfig {
    fn default() -> Self {
        Self {
            automount_enabled: true, mount_fstab: false, mount_root: "/mnt/".into(), mount_options: String::new(),
            generate_hosts: true, generate_resolv_conf: true, hostname: String::new(),
            interop_enabled: true, append_windows_path: true, default_user: String::new(),
            systemd: false, boot_command: String::new(), protect_binfmt: true, init_timeout: 10_000,
            use_windows_timezone: true, gpu_enabled: true, append_gpu_lib_path: true,
        }
    }
}

fn parse_wsl_bool(value: Option<&String>, default: bool) -> bool {
    match value.map(|value| value.trim().to_ascii_lowercase()).as_deref() {
        Some("true" | "1" | "yes" | "on") => true,
        Some("false" | "0" | "no" | "off") => false,
        _ => default,
    }
}

fn parse_wsl_distro_config(text: &str) -> WslDistroConfig {
    let mut values = BTreeMap::<(String, String), String>::new();
    let mut section = String::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') { continue; }
        if line.starts_with('[') && line.ends_with(']') {
            section = line[1..line.len() - 1].trim().to_ascii_lowercase();
        } else if let Some((key, value)) = line.split_once('=') {
            values.insert((section.clone(), key.trim().to_ascii_lowercase()), value.trim().to_owned());
        }
    }
    let get = |section: &str, key: &str| values.get(&(section.to_owned(), key.to_owned()));
    let defaults = WslDistroConfig::default();
    WslDistroConfig {
        automount_enabled: parse_wsl_bool(get("automount", "enabled"), defaults.automount_enabled),
        mount_fstab: parse_wsl_bool(get("automount", "mountfstab"), defaults.mount_fstab),
        mount_root: get("automount", "root").cloned().unwrap_or(defaults.mount_root),
        mount_options: get("automount", "options").cloned().unwrap_or_default(),
        generate_hosts: parse_wsl_bool(get("network", "generatehosts"), defaults.generate_hosts),
        generate_resolv_conf: parse_wsl_bool(get("network", "generateresolvconf"), defaults.generate_resolv_conf),
        hostname: get("network", "hostname").cloned().unwrap_or_default(),
        interop_enabled: parse_wsl_bool(get("interop", "enabled"), defaults.interop_enabled),
        append_windows_path: parse_wsl_bool(get("interop", "appendwindowspath"), defaults.append_windows_path),
        default_user: get("user", "default").cloned().unwrap_or_default(),
        systemd: parse_wsl_bool(get("boot", "systemd"), defaults.systemd),
        boot_command: get("boot", "command").cloned().unwrap_or_default(),
        protect_binfmt: parse_wsl_bool(get("boot", "protectbinfmt"), defaults.protect_binfmt),
        init_timeout: get("boot", "inittimeout").and_then(|value| value.parse().ok()).unwrap_or(defaults.init_timeout),
        use_windows_timezone: parse_wsl_bool(get("time", "usewindowstimezone"), defaults.use_windows_timezone),
        gpu_enabled: parse_wsl_bool(get("gpu", "enabled"), defaults.gpu_enabled),
        append_gpu_lib_path: parse_wsl_bool(get("gpu", "appendlibpath"), defaults.append_gpu_lib_path),
    }
}

fn config_bool(value: bool) -> String { if value { "true" } else { "false" }.to_owned() }

fn wsl_config_entries(config: &WslDistroConfig) -> Vec<(&'static str, &'static str, String)> {
    vec![
        ("automount", "enabled", config_bool(config.automount_enabled)), ("automount", "mountFsTab", config_bool(config.mount_fstab)),
        ("automount", "root", config.mount_root.clone()), ("automount", "options", config.mount_options.clone()),
        ("network", "generateHosts", config_bool(config.generate_hosts)), ("network", "generateResolvConf", config_bool(config.generate_resolv_conf)),
        ("network", "hostname", config.hostname.clone()),
        ("interop", "enabled", config_bool(config.interop_enabled)), ("interop", "appendWindowsPath", config_bool(config.append_windows_path)),
        ("user", "default", config.default_user.clone()),
        ("boot", "systemd", config_bool(config.systemd)), ("boot", "command", config.boot_command.clone()),
        ("boot", "protectBinfmt", config_bool(config.protect_binfmt)), ("boot", "initTimeout", config.init_timeout.to_string()),
        ("time", "useWindowsTimezone", config_bool(config.use_windows_timezone)),
        ("gpu", "enabled", config_bool(config.gpu_enabled)), ("gpu", "appendLibPath", config_bool(config.append_gpu_lib_path)),
    ]
}

fn merge_wsl_distro_config(existing: &str, config: &WslDistroConfig) -> String {
    let entries = wsl_config_entries(config);
    let mut lines = existing.lines().map(str::to_owned).collect::<Vec<_>>();
    let mut section = String::new();
    let mut written = Vec::<(String, String)>::new();
    for line in &mut lines {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            section = trimmed[1..trimmed.len() - 1].trim().to_ascii_lowercase();
            continue;
        }
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') { continue; }
        let Some((key, _)) = trimmed.split_once('=') else { continue; };
        let key = key.trim().to_ascii_lowercase();
        let Some((_, _, value)) = entries.iter().find(|(target_section, target_key, _)| *target_section == section && target_key.to_ascii_lowercase() == key) else { continue; };
        let pair = (section.clone(), key.clone());
        if written.contains(&pair) { *line = String::new(); }
        else { *line = format!("{} = {}", entries.iter().find(|(target_section, target_key, _)| *target_section == section && target_key.to_ascii_lowercase() == key).map(|(_, target_key, _)| *target_key).unwrap_or(""), value); written.push(pair); }
    }
    for target_section in ["automount", "network", "interop", "user", "boot", "time", "gpu"] {
        let header = format!("[{target_section}]");
        if let Some(start) = lines.iter().position(|line| line.trim().eq_ignore_ascii_case(&header)) {
            let end = lines.iter().enumerate().skip(start + 1).find(|(_, line)| { let line = line.trim(); line.starts_with('[') && line.ends_with(']') }).map(|(index, _)| index).unwrap_or(lines.len());
            let missing = entries.iter().filter(|(section, key, _)| *section == target_section && !written.contains(&(target_section.to_owned(), key.to_ascii_lowercase())))
                .map(|(_, key, value)| format!("{key} = {value}")).collect::<Vec<_>>();
            lines.splice(end..end, missing);
        } else {
            let missing = entries.iter().filter(|(section, _, _)| *section == target_section)
                .map(|(_, key, value)| format!("{key} = {value}")).collect::<Vec<_>>();
            if !lines.is_empty() && !lines.last().is_some_and(String::is_empty) { lines.push(String::new()); }
            lines.push(header);
            lines.extend(missing);
        }
    }
    while lines.last().is_some_and(String::is_empty) { lines.pop(); }
    format!("{}\n", lines.join("\n"))
}

fn validate_wsl_distro_config(config: WslDistroConfig) -> PlatformResult<WslDistroConfig> {
    let config = WslDistroConfig {
        mount_root: config.mount_root.trim().to_owned(), mount_options: config.mount_options.trim().to_owned(),
        hostname: config.hostname.trim().to_owned(), default_user: config.default_user.trim().to_owned(),
        boot_command: config.boot_command.trim().to_owned(), ..config
    };
    for (label, value, limit) in [
        ("自动挂载根目录", config.mount_root.as_str(), 1024), ("挂载参数", config.mount_options.as_str(), 2048),
        ("主机名", config.hostname.as_str(), 253), ("默认用户", config.default_user.as_str(), 64),
        ("启动命令", config.boot_command.as_str(), 2048),
    ] {
        if value.len() > limit || value.chars().any(char::is_control) { return Err(format!("{label}格式无效或长度超限").into()); }
    }
    if !config.mount_root.starts_with('/') { return Err("自动挂载根目录必须是 Linux 绝对路径".into()); }
    if !config.hostname.is_empty() && !config.hostname.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-')) { return Err("主机名仅支持字母、数字、点和连字符".into()); }
    if !config.default_user.is_empty() && (!config.default_user.as_bytes()[0].is_ascii_alphabetic() && config.default_user.as_bytes()[0] != b'_' || !config.default_user.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))) { return Err("默认用户名格式无效".into()); }
    if config.init_timeout > 600_000 { return Err("systemd 初始化超时不能超过 600000 毫秒".into()); }
    Ok(config)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WslOnlineDistribution {
    name: String,
    friendly_name: String,
}

#[derive(Clone, Deserialize)]
struct MirrorSource {
    url: String,
    mirror: String,
    format: String,
}

#[derive(Clone, Deserialize)]
struct MirrorDistroRecord {
    name: String,
    version: String,
    #[serde(default)]
    sources: Vec<MirrorSource>,
}

#[derive(Deserialize)]
struct MirrorCatalogData {
    #[serde(default)]
    distros: Vec<MirrorDistroRecord>,
    #[serde(default)]
    mirrors: Vec<MirrorDistroRecord>,
}

#[derive(Deserialize)]
struct MirrorCatalogResponse {
    err: i64,
    data: Option<MirrorCatalogData>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WslMirrorDistro {
    id: String,
    name: String,
    version: String,
    source_count: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WslMirrorInstallProgress {
    stage: &'static str,
    mirror: Option<String>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    bytes_per_second: u64,
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

#[tauri::command]
pub(crate) fn wsl_dashboard_runtime_info() -> PlatformResult<WslRuntimeInfo> {
    #[cfg(windows)] {
        Ok(invoke_wsl(&["--version"])
            .map(|output| parse_wsl_runtime_info(&output_text(&output.stdout)))
            .unwrap_or_else(|_| unavailable_wsl_runtime_info()))
    }
    #[cfg(not(windows))] { unsupported() }
}

fn now_millis() -> i64 { chrono::Utc::now().timestamp_millis() }

fn numeric_version(value: &str) -> Option<Vec<u64>> {
    let parts = value.split('.').map(str::parse::<u64>).collect::<Result<Vec<_>, _>>().ok()?;
    (parts.len() >= 3).then_some(parts)
}

fn version_meets_minimum(current: &str, minimum: &str) -> Option<bool> {
    let current = numeric_version(current)?;
    let minimum = numeric_version(minimum)?;
    let width = current.len().max(minimum.len());
    for index in 0..width {
        match current.get(index).copied().unwrap_or(0).cmp(&minimum.get(index).copied().unwrap_or(0)) {
            std::cmp::Ordering::Greater => return Some(true),
            std::cmp::Ordering::Less => return Some(false),
            std::cmp::Ordering::Equal => {}
        }
    }
    Some(true)
}

fn parse_wsl_runtime_info(text: &str) -> WslRuntimeInfo {
    let mut current_version = None;
    let mut components = Vec::new();
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let Some(version) = line.split(|character: char| !(character.is_ascii_digit() || character == '.'))
            .find(|candidate| candidate.matches('.').count() >= 2 && numeric_version(candidate).is_some()) else { continue; };
        let version = version.to_owned();
        let label = line.find(&version).map(|index| line[..index].trim_matches(|character: char| character.is_whitespace() || matches!(character, ':' | '：' | '-' | '—'))).unwrap_or("");
        let safe_label = label.chars().filter(|character| !character.is_control()).take(48).collect::<String>();
        let normalized_label = safe_label.to_ascii_lowercase();
        if normalized_label == "wsl" || normalized_label.starts_with("wsl ") || normalized_label.starts_with("wsl:") {
            current_version.get_or_insert_with(|| version.clone());
        }
        if !safe_label.is_empty() {
            components.push(WslRuntimeComponent { name: safe_label, version });
        }
    }
    let compatible = current_version.as_deref().and_then(|version| version_meets_minimum(version, MIN_SUPPORTED_WSL_VERSION));
    let message = if current_version.is_none() {
        Some("当前 WSL 未提供可识别的版本信息，可尝试升级后重新检查。".to_owned())
    } else {
        None
    };
    WslRuntimeInfo {
        current_version,
        minimum_supported_version: MIN_SUPPORTED_WSL_VERSION.to_owned(),
        compatible,
        components,
        message,
    }
}

fn unavailable_wsl_runtime_info() -> WslRuntimeInfo {
    WslRuntimeInfo {
        current_version: None,
        minimum_supported_version: MIN_SUPPORTED_WSL_VERSION.to_owned(),
        compatible: None,
        components: Vec::new(),
        message: Some("无法读取 WSL 版本信息；旧版 WSL 可能不支持此查询。仍可尝试升级。".to_owned()),
    }
}

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

#[tauri::command]
pub(crate) async fn wsl_dashboard_details(name: String) -> PlatformResult<WslDistributionDetails> {
    let name = validate_name(&name)?.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)] {
            let distribution = wsl_dashboard_list()?.into_iter().find(|item| item.name == name)
                .ok_or("该发行版已不存在，请刷新列表")?;
            let mut ip_address = None;
            let mut root_used_bytes = None;
            if distribution.state.eq_ignore_ascii_case("running") {
                // Arguments are passed directly to wsl.exe; the shell script is constant and contains no user input.
                if let Ok(output) = invoke_wsl(&["--distribution", &name, "--exec", "/bin/sh", "-c", "hostname -I; df -Pk /"]) {
                    let text = output_text(&output.stdout);
                    let mut lines = text.lines();
                    ip_address = lines.next().and_then(|line| line.split_whitespace().find_map(|value| value.parse::<std::net::IpAddr>().ok()))
                        .map(|value| value.to_string());
                    root_used_bytes = lines.skip(1).find_map(|line| {
                        let columns = line.split_whitespace().collect::<Vec<_>>();
                        columns.get(2)?.parse::<u64>().ok().map(|kib| kib.saturating_mul(1024))
                    });
                }
            }
            Ok(WslDistributionDetails {
                name: distribution.name, state: distribution.state, version: distribution.version,
                is_default: distribution.is_default, ip_address, root_used_bytes,
                installed_at: distribution.installed_at, last_started_at: distribution.last_started_at,
                remark: distribution.remark,
            })
        }
        #[cfg(not(windows))] { let _ = name; unsupported() }
    }).await.map_err(|_| "读取发行版详细信息任务失败，请重试")?
}

#[tauri::command]
pub(crate) async fn wsl_dashboard_config_get(name: String) -> PlatformResult<WslDistroConfig> {
    let name = validate_name(&name)?.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)] {
            ensure_registered_distribution(&name)?;
            let was_running = wsl_dashboard_list()?.iter().find(|item| item.name == name).is_some_and(|item| item.state.eq_ignore_ascii_case("running"));
            let output = invoke_wsl(&["--distribution", &name, "--user", "root", "--exec", "/bin/sh", "-c", "if [ -f /etc/wsl.conf ]; then cat /etc/wsl.conf; fi"]);
            if !was_running { let _ = invoke_wsl(&["--terminate", &name]); }
            let output = output?;
            Ok(parse_wsl_distro_config(&output_text(&output.stdout)))
        }
        #[cfg(not(windows))] { let _ = name; unsupported() }
    }).await.map_err(|_| "读取发行版配置任务失败，请重试")?
}

#[cfg(windows)]
fn write_wsl_distro_config(name: &str, content: &str) -> PlatformResult<()> {
    use std::io::Write;
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let script = "umask 022; cat > /etc/.wsl.conf.cloudhub.tmp && chmod 644 /etc/.wsl.conf.cloudhub.tmp && mv /etc/.wsl.conf.cloudhub.tmp /etc/wsl.conf";
    let mut child = Command::new("wsl.exe")
        .args(["--distribution", name, "--user", "root", "--exec", "/bin/sh", "-c", script])
        .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW).spawn()
        .map_err(|_| "无法启动 WSL 配置写入任务")?;
    let write_result = child.stdin.take().ok_or("无法打开 WSL 配置写入通道")?.write_all(content.as_bytes());
    if write_result.is_err() { let _ = child.kill(); let _ = child.wait(); return Err("写入发行版配置失败，请检查发行版状态和磁盘空间".into()); }
    let result = child.wait().map_err(|_| "无法确认发行版配置写入结果")?;
    if result.success() { Ok(()) } else { Err("无法写入 /etc/wsl.conf，请检查发行版文件系统状态".into()) }
}

#[tauri::command]
pub(crate) async fn wsl_dashboard_config_save(name: String, config: WslDistroConfig, restart: bool) -> PlatformResult<()> {
    let name = validate_name(&name)?.to_owned();
    let config = validate_wsl_distro_config(config)?;
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)] {
            ensure_registered_distribution(&name)?;
            let was_running = wsl_dashboard_list()?.iter().find(|item| item.name == name).is_some_and(|item| item.state.eq_ignore_ascii_case("running"));
            let save_result = (|| {
                let current = invoke_wsl(&["--distribution", &name, "--user", "root", "--exec", "/bin/sh", "-c", "if [ -f /etc/wsl.conf ]; then cat /etc/wsl.conf; fi"])?;
                let content = merge_wsl_distro_config(&output_text(&current.stdout), &config);
                write_wsl_distro_config(&name, &content)?;
                Ok(())
            })();
            if let Err(error) = save_result {
                if !was_running { let _ = invoke_wsl(&["--terminate", &name]); }
                record_operation("保存发行版配置", Some(&name), false);
                return Err(error);
            }
            let result: PlatformResult<()> = if restart {
                let _ = invoke_wsl(&["--terminate", &name]);
                start_distribution(&name).map_err(|_| "配置已保存，但发行版未能重新启动；请从列表手动启动".into())
            } else {
                if !was_running { let _ = invoke_wsl(&["--terminate", &name]); }
                Ok(())
            };
            record_operation(if restart { "保存并重启发行版配置" } else { "保存发行版配置" }, Some(&name), result.is_ok());
            result
        }
        #[cfg(not(windows))] { let _ = (name, config, restart); unsupported() }
    }).await.map_err(|_| "保存发行版配置任务失败，请重试")?
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

#[cfg(windows)]
const MIRROR_CATALOG_URL: &str = "https://api2.wslui.com/co-creation/api/online-distros";

#[cfg(windows)]
fn is_allowed_mirror_host(host: &str) -> bool {
    matches!(host.to_ascii_lowercase().as_str(),
        "mirrors.aliyun.com" | "mirrors.bfsu.edu.cn" | "mirrors.cloud.tencent.com" |
        "mirrors.hit.edu.cn" | "mirrors.huaweicloud.com" | "mirrors.hust.edu.cn" |
        "mirrors.nju.edu.cn" | "mirrors.sohu.com" | "mirrors.tuna.tsinghua.edu.cn" |
        "mirrors.volces.com")
}

#[cfg(windows)]
fn mirror_url_is_allowed(url: &reqwest::Url) -> bool {
    url.scheme() == "https" && url.username().is_empty() && url.password().is_none()
        && url.port().is_none_or(|port| port == 443) && url.query().is_none() && url.fragment().is_none()
        && url.host_str().is_some_and(is_allowed_mirror_host)
}

#[cfg(windows)]
fn mirror_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().connect_timeout(Duration::from_secs(8)).timeout(Duration::from_secs(1800))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 4 || !mirror_url_is_allowed(attempt.url()) { attempt.stop() } else { attempt.follow() }
        }))
        .build().map_err(|_| "创建镜像下载连接失败".into())
}

#[cfg(windows)]
async fn fetch_mirror_catalog() -> PlatformResult<Vec<MirrorDistroRecord>> {
    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(8)).timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 4 || attempt.url().scheme() != "https" || attempt.url().host_str() != Some("api2.wslui.com") { attempt.stop() } else { attempt.follow() }
        })).build().map_err(|_| "创建镜像目录连接失败")?;
    let mut response = client.get(MIRROR_CATALOG_URL).header(reqwest::header::USER_AGENT, "CloudHubTools")
        .send().await.map_err(|_| "读取镜像目录失败，请检查网络连接")?.error_for_status()
        .map_err(|_| "镜像目录暂不可用，请稍后重试")?;
    if response.content_length().is_some_and(|length| length > 8 * 1024 * 1024) {
        return Err("镜像目录数据超过安全限制".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取镜像目录失败，请稍后重试")? {
        if bytes.len().saturating_add(chunk.len()) > 8 * 1024 * 1024 { return Err("镜像目录数据超过安全限制".into()); }
        bytes.extend_from_slice(&chunk);
    }
    let catalog: MirrorCatalogResponse = serde_json::from_slice(&bytes).map_err(|_| "镜像目录格式无效，请稍后重试")?;
    if catalog.err != 0 { return Err("镜像目录暂不可用，请稍后重试".into()); }
    let data = catalog.data.ok_or("镜像目录缺少数据")?;
    let mut records = if std::env::consts::ARCH == "aarch64" { data.mirrors } else { data.distros };
    records.truncate(500);
    records.retain(|record| {
        !record.name.is_empty() && record.name.len() <= 64 && record.name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.'))
            && !record.version.is_empty() && record.version.len() <= 48 && record.version.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    });
    for record in &mut records {
        record.sources.retain(|source| {
            if source.mirror.len() > 48 || !source.mirror.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) { return false; }
            if !matches!(source.format.as_str(), "wsl" | "tar.gz" | "tar.xz") { return false; }
            reqwest::Url::parse(&source.url).is_ok_and(|url| mirror_url_is_allowed(&url) && url.path().to_ascii_lowercase().ends_with(&format!(".{}", source.format)))
        });
        record.sources.truncate(32);
    }
    records.retain(|record| !record.sources.is_empty());
    Ok(records)
}

#[tauri::command]
pub(crate) async fn wsl_dashboard_mirror_list() -> PlatformResult<Vec<WslMirrorDistro>> {
    #[cfg(windows)] {
        let records = fetch_mirror_catalog().await?;
        Ok(records.into_iter().map(|record| WslMirrorDistro {
            id: format!("{} {}", record.name, record.version), name: record.name, version: record.version,
            source_count: record.sources.len(),
        }).collect())
    }
    #[cfg(not(windows))] { unsupported() }
}

#[cfg(windows)]
fn send_mirror_progress(channel: &Channel<WslMirrorInstallProgress>, stage: &'static str, mirror: Option<&str>, downloaded: u64, total: Option<u64>, speed: u64) {
    let _ = channel.send(WslMirrorInstallProgress {
        stage, mirror: mirror.map(|value| value.chars().filter(|c| !c.is_control()).take(48).collect()),
        downloaded_bytes: downloaded, total_bytes: total, bytes_per_second: speed,
    });
}

#[cfg(windows)]
async fn probe_mirror(client: &reqwest::Client, source: &MirrorSource) -> u64 {
    let start = Instant::now();
    let outcome = tokio::time::timeout(Duration::from_secs(6), async {
        let mut response = client.get(&source.url).header(reqwest::header::RANGE, "bytes=0-1048575").send().await.ok()?;
        if !response.status().is_success() && response.status() != reqwest::StatusCode::PARTIAL_CONTENT { return None; }
        let mut size = 0u64;
        while let Some(chunk) = response.chunk().await.ok()? {
            size = size.saturating_add(chunk.len() as u64);
            if size >= 1024 * 1024 { break; }
        }
        (size > 0).then_some(size)
    }).await;
    match outcome { Ok(Some(bytes)) => (bytes as f64 / start.elapsed().as_secs_f64().max(0.001)) as u64, _ => 0 }
}

#[cfg(windows)]
async fn download_mirror_range(client: reqwest::Client, url: String, path: PathBuf, start: u64, end: u64, downloaded: Arc<AtomicU64>) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let mut response = client.get(url).header(reqwest::header::RANGE, format!("bytes={start}-{end}"))
        .send().await.map_err(|_| "镜像分块下载连接失败")?;
    if response.status() != reqwest::StatusCode::PARTIAL_CONTENT { return Err("镜像不支持可靠的分块下载".into()); }
    if !response.headers().get(reqwest::header::CONTENT_RANGE).and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with(&format!("bytes {start}-{end}/"))) { return Err("镜像分块范围响应无效".into()); }
    let mut file = tokio::fs::File::create(path).await.map_err(|_| "无法创建镜像临时文件")?;
    let expected = end.saturating_sub(start).saturating_add(1);
    let mut written = 0u64;
    while let Some(chunk) = response.chunk().await.map_err(|_| "镜像下载中断")? {
        written = written.saturating_add(chunk.len() as u64);
        if written > expected { return Err("镜像返回的数据长度异常".into()); }
        file.write_all(&chunk).await.map_err(|_| "写入镜像临时文件失败")?;
        downloaded.fetch_add(chunk.len() as u64, Ordering::Relaxed);
    }
    if written != expected { return Err("镜像分块数据不完整".into()); }
    file.flush().await.map_err(|_| "写入镜像临时文件失败")?;
    Ok(())
}

#[cfg(windows)]
async fn download_from_mirror(client: &reqwest::Client, source: &MirrorSource, destination: &Path, channel: &Channel<WslMirrorInstallProgress>) -> Result<u64, String> {
    use tokio::io::AsyncWriteExt;
    const MAX_ARCHIVE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
    const CHUNK_SIZE: u64 = 8 * 1024 * 1024;
    const PARALLEL_CHUNKS: usize = 4;
    let head = client.head(&source.url).send().await.ok();
    let total = head.as_ref().and_then(|response| response.content_length()).filter(|size| *size > 0);
    if total.is_some_and(|size| size > MAX_ARCHIVE_BYTES) { return Err("镜像文件超过 8 GB 安全限制".into()); }
    let supports_ranges = head.as_ref().is_some_and(|response| response.headers().get(reqwest::header::ACCEPT_RANGES)
        .and_then(|value| value.to_str().ok()).is_some_and(|value| value.to_ascii_lowercase().contains("bytes")));

    if let (Some(total), true) = (total, supports_ranges) {
        if total >= 10 * 1024 * 1024 {
            let count = ((total + CHUNK_SIZE - 1) / CHUNK_SIZE).min(PARALLEL_CHUNKS as u64) as usize;
            let size_per_chunk = (total + count as u64 - 1) / count as u64;
            let downloaded = Arc::new(AtomicU64::new(0));
            let mut tasks = tokio::task::JoinSet::new();
            for index in 0..count {
                let start = index as u64 * size_per_chunk;
                let end = ((index as u64 + 1) * size_per_chunk).min(total) - 1;
                if start > end { continue; }
                let path = destination.with_extension(format!("{}.part{index}", source.format.replace('.', "_")));
                tasks.spawn(download_mirror_range(client.clone(), source.url.clone(), path, start, end, downloaded.clone()));
            }
            let began = Instant::now();
            let mut last_bytes = 0;
            let mut last_time = Instant::now();
            let mut failure = None;
            let mut interval = tokio::time::interval(Duration::from_millis(250));
            while !tasks.is_empty() {
                tokio::select! {
                    _ = interval.tick() => {
                        let bytes = downloaded.load(Ordering::Relaxed);
                        let elapsed = last_time.elapsed().as_secs_f64().max(0.001);
                        send_mirror_progress(channel, "downloading", Some(&source.mirror), bytes, Some(total), ((bytes.saturating_sub(last_bytes)) as f64 / elapsed) as u64);
                        last_bytes = bytes; last_time = Instant::now();
                    }
                    result = tasks.join_next() => match result {
                        Some(Ok(Ok(()))) => {},
                        Some(Ok(Err(reason))) => { failure = Some(reason); tasks.abort_all(); },
                        Some(Err(_)) => { failure = Some("镜像分块下载任务异常结束".to_string()); tasks.abort_all(); },
                        None => break,
                    }
                }
            }
            while tasks.join_next().await.is_some() {}
            if let Some(reason) = failure {
                for index in 0..count { let _ = tokio::fs::remove_file(destination.with_extension(format!("{}.part{index}", source.format.replace('.', "_")))).await; }
                return Err(reason);
            }
            let mut output = tokio::fs::File::create(destination).await.map_err(|_| "无法创建镜像归档文件")?;
            for index in 0..count {
                let part = destination.with_extension(format!("{}.part{index}", source.format.replace('.', "_")));
                let mut input = tokio::fs::File::open(&part).await.map_err(|_| "镜像分块文件缺失")?;
                tokio::io::copy(&mut input, &mut output).await.map_err(|_| "合并镜像分块失败")?;
                let _ = tokio::fs::remove_file(part).await;
            }
            output.flush().await.map_err(|_| "写入镜像归档失败")?;
            send_mirror_progress(channel, "downloading", Some(&source.mirror), total, Some(total), (total as f64 / began.elapsed().as_secs_f64().max(0.001)) as u64);
            return Ok(total);
        }
    }

    let mut response = client.get(&source.url).send().await.map_err(|_| "镜像下载连接失败")?.error_for_status().map_err(|_| "镜像返回了 HTTP 错误")?;
    let total = response.content_length().filter(|size| *size > 0);
    if total.is_some_and(|size| size > MAX_ARCHIVE_BYTES) { return Err("镜像文件超过 8 GB 安全限制".into()); }
    let mut file = tokio::fs::File::create(destination).await.map_err(|_| "无法创建镜像归档文件")?;
    let mut downloaded = 0u64;
    let mut last_bytes = 0u64;
    let mut last_time = Instant::now();
    let mut last_emit = Instant::now();
    let began = Instant::now();
    while let Some(chunk) = response.chunk().await.map_err(|_| "镜像下载中断")? {
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > MAX_ARCHIVE_BYTES || total.is_some_and(|expected| downloaded > expected) { return Err("镜像返回的数据大小异常".into()); }
        file.write_all(&chunk).await.map_err(|_| "写入镜像归档失败")?;
        if last_emit.elapsed() >= Duration::from_millis(250) {
            let elapsed = last_time.elapsed().as_secs_f64().max(0.001);
            send_mirror_progress(channel, "downloading", Some(&source.mirror), downloaded, total, ((downloaded.saturating_sub(last_bytes)) as f64 / elapsed) as u64);
            last_bytes = downloaded; last_time = Instant::now(); last_emit = Instant::now();
        }
    }
    if total.is_some_and(|expected| downloaded != expected) { return Err("镜像文件下载不完整".into()); }
    file.flush().await.map_err(|_| "写入镜像归档失败")?;
    send_mirror_progress(channel, "downloading", Some(&source.mirror), downloaded, total, (downloaded as f64 / began.elapsed().as_secs_f64().max(0.001)) as u64);
    Ok(downloaded)
}

#[cfg(windows)]
async fn validate_mirror_archive(path: &Path, format: &str) -> Result<(), String> {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path).await.map_err(|_| "镜像归档文件不可读取")?;
    let mut header = [0u8; 6];
    let bytes = file.read(&mut header).await.map_err(|_| "读取镜像归档头失败")?;
    let valid = match format {
        "wsl" => bytes >= 2 && (&header[..2] == [0x1f, 0x8b] || &header[..2] == [0x50, 0x4b]),
        "tar.gz" => bytes >= 2 && &header[..2] == [0x1f, 0x8b],
        "tar.xz" => bytes >= 6 && header == [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
        _ => false,
    };
    if valid { Ok(()) } else { Err("镜像下载文件格式校验失败".into()) }
}

#[tauri::command]
pub(crate) async fn wsl_dashboard_mirror_install(
    distribution: String,
    version: String,
    instance_name: String,
    install_location: String,
    on_progress: Channel<WslMirrorInstallProgress>,
) -> PlatformResult<()> {
    #[cfg(windows)] {
        let distribution = distribution.trim().to_owned();
        let version = version.trim().to_owned();
        let instance_name = validate_name(&instance_name)?.to_owned();
        if instance_name.len() > 64 || instance_name.starts_with('-') || !instance_name.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')) {
            return Err("实例名称无效，请使用字母、数字、点、下划线或连字符".into());
        }
        let install_location = validate_install_location(&install_location)?.to_owned();
        if install_location.is_empty() || Path::new(&install_location).file_name().is_none() { return Err("请选择发行版专用的安装目录".into()); }
        if wsl_dashboard_list()?.iter().any(|item| item.name.eq_ignore_ascii_case(&instance_name)) { return Err("该实例名称已存在，请更换名称".into()); }
        let records = fetch_mirror_catalog().await?;
        let record = records.into_iter().find(|item| item.name == distribution && item.version == version).ok_or("所选发行版镜像已过期，请刷新镜像目录")?;
        if record.sources.is_empty() { return Err("该发行版暂无可用镜像".into()); }
        let target = Path::new(&install_location);
        if target.exists() && !target.is_dir() { return Err("安装目录已存在且不是文件夹".into()); }
        if target.exists() && std::fs::read_dir(target).map_err(|_| "无法读取发行版安装目录")?.next().is_some() { return Err("发行版安装目录必须为空，请选择新的空目录".into()); }

        let client = mirror_http_client()?;
        send_mirror_progress(&on_progress, "probing", None, 0, None, 0);
        let mut tasks = tokio::task::JoinSet::new();
        for source in record.sources.iter().cloned() {
            let client = client.clone();
            tasks.spawn(async move { let speed = probe_mirror(&client, &source).await; (source, speed) });
        }
        let mut ranked = Vec::new();
        while let Some(result) = tasks.join_next().await {
            if let Ok(value) = result { ranked.push(value); }
        }
        ranked.sort_by(|left, right| right.1.cmp(&left.1));
        let archive_path = std::env::temp_dir().join(format!("cloudhub-wsl-{}.download", uuid::Uuid::new_v4()));
        let mut downloaded_from = None;
        let mut last_failure = "所有镜像下载失败";
        for (source, _) in ranked {
            send_mirror_progress(&on_progress, "downloading", Some(&source.mirror), 0, None, 0);
            match download_from_mirror(&client, &source, &archive_path, &on_progress).await {
                Ok(_) => {
                    send_mirror_progress(&on_progress, "verifying", Some(&source.mirror), 0, None, 0);
                    match validate_mirror_archive(&archive_path, &source.format).await {
                        Ok(()) => { downloaded_from = Some(source); break; }
                        Err(_) => { last_failure = "镜像文件格式校验失败，正在尝试其他镜像"; let _ = tokio::fs::remove_file(&archive_path).await; }
                    }
                }
                Err(reason) => { last_failure = if reason.contains("8 GB") { "镜像文件超过安全大小限制" } else { "镜像下载失败，正在尝试其他镜像" }; let _ = tokio::fs::remove_file(&archive_path).await; }
            }
        }
        let Some(source) = downloaded_from else { let _ = tokio::fs::remove_file(&archive_path).await; return Err(last_failure.into()); };
        std::fs::create_dir_all(target).map_err(|_| { let _ = std::fs::remove_file(&archive_path); "无法创建发行版安装目录，请检查路径权限和磁盘空间" })?;
        if std::fs::read_dir(target).map_err(|_| "无法读取发行版安装目录")?.next().is_some() { let _ = tokio::fs::remove_file(&archive_path).await; return Err("发行版安装目录必须为空，请选择新的空目录".into()); }
        send_mirror_progress(&on_progress, "importing", Some(&source.mirror), 0, None, 0);
        let name_for_log = instance_name.clone();
        let install_path = install_location.clone();
        let archive_for_import = archive_path.to_string_lossy().to_string();
        let import_result = tauri::async_runtime::spawn_blocking(move || {
            invoke_wsl(&["--import", &instance_name, &install_path, &archive_for_import, "--version", "2"]).map(|_| ())
        }).await.map_err(|_| "WSL 镜像导入任务异常结束，请重试")?;
        let _ = tokio::fs::remove_file(&archive_path).await;
        record_operation("镜像安装发行版", Some(&name_for_log), import_result.is_ok());
        import_result?;
        let _ = on_progress.send(WslMirrorInstallProgress { stage: "complete", mirror: Some(source.mirror), downloaded_bytes: 0, total_bytes: None, bytes_per_second: 0 });
        Ok(())
    }
    #[cfg(not(windows))] { let _ = (distribution, version, instance_name, install_location, on_progress); unsupported() }
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
            let Some(folder) = app.dialog().file().set_title("选择 WSL 发行版安装目录").blocking_pick_folder() else { return Ok(None); };
            let path = folder.into_path().map_err(|_| "请选择本机安装目录")?;
            let path = path.to_str().ok_or("请选择有效的 Windows 安装目录")?;
            validate_install_location(path)?;
            Ok(Some(path.to_owned()))
        }).await.map_err(|_| "选择 WSL 安装目录失败")?;
    }
    #[cfg(not(windows))] { let _ = app; unsupported() }
}

#[tauri::command]
pub(crate) async fn wsl_dashboard_select_move_location(app: tauri::AppHandle) -> PlatformResult<Option<String>> {
    #[cfg(windows)] {
        return tauri::async_runtime::spawn_blocking(move || {
            use tauri_plugin_dialog::DialogExt;
            let Some(folder) = app.dialog().file().set_title("选择发行版移动目标目录").blocking_pick_folder() else { return Ok(None); };
            let path = folder.into_path().map_err(|_| "请选择本机目标目录")?;
            let path = path.to_str().ok_or("请选择有效的 Windows 目标目录")?;
            validate_install_location(path)?;
            Ok(Some(path.to_owned()))
        }).await.map_err(|_| "选择 WSL 移动目录失败")?;
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

#[cfg(windows)]
fn invoke_wsl_move(name: &str, location: &str) -> PlatformResult<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    for attempt in 0..5 {
        let output = Command::new("wsl.exe")
            .args(["--manage", name, "--move", location])
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|_| "未能启动 WSL 移动操作，请确认 Windows 已启用 WSL")?;
        if output.status.success() { return Ok(()); }
        let diagnostic = format!("{}\n{}", output_text(&output.stdout), output_text(&output.stderr));
        let normalized = diagnostic.to_ascii_uppercase();
        if normalized.contains("ERROR_SHARING_VIOLATION") || normalized.contains("0X80070020") {
            if attempt < 4 {
                std::thread::sleep(Duration::from_secs(3));
                continue;
            }
            return Err("WSL 仍在占用发行版磁盘，请关闭相关程序后重试".into());
        }
        if diagnostic.contains("WSL_E_DISTRO_NOT_FOUND") {
            return Err("该发行版已不存在，请刷新列表".into());
        }
        return Err("WSL 移动未完成，请检查 WSL 版本、目标目录权限和磁盘空间".into());
    }
    Err("WSL 移动未完成，请关闭相关程序后重试".into())
}

fn move_distribution(name: String, location: String) -> PlatformResult<()> {
    let name = validate_name(&name)?;
    let location = validate_install_location(&location)?;
    if location.is_empty() || Path::new(location).file_name().is_none() {
        return Err("请选择新的发行版目标目录".into());
    }
    let distribution = wsl_dashboard_list()?.into_iter().find(|item| item.name == name)
        .ok_or("该发行版已不存在，请刷新列表")?;
    if distribution.version != Some(2) {
        return Err("移动功能目前仅支持 WSL 2 发行版".into());
    }
    #[cfg(windows)] {
        let result = (|| {
            invoke_wsl(&["--shutdown"])?;
            std::thread::sleep(Duration::from_secs(3));
            invoke_wsl_move(name, location)?;
            if wsl_dashboard_list()?.iter().any(|item| item.name == name) { Ok(()) }
            else { Err("WSL 移动后未能确认发行版仍已注册，请刷新列表并检查目标目录".into()) }
        })();
        record_operation("移动发行版", Some(name), result.is_ok());
        result
    }
    #[cfg(not(windows))] { let _ = (name, location); unsupported() }
}

#[tauri::command]
pub(crate) async fn wsl_dashboard_move(name: String, location: String) -> PlatformResult<()> {
    tauri::async_runtime::spawn_blocking(move || move_distribution(name, location))
        .await.map_err(|_| "WSL 移动任务失败，请重试")?
}

#[tauri::command]
pub(crate) fn wsl_dashboard_open_terminal(name: String) -> PlatformResult<()> {
    let name = validate_name(&name)?;
    ensure_registered_distribution(name)?;
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let title = format!("WSL: {}", name);
        let result = Command::new("cmd")
            .args(["/c", "start", &title, "wsl.exe", "-d", name, "--cd", "~"])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map(|_| ())
            .map_err(|_| "无法启动 WSL 终端，请检查发行版和 Windows WSL 安装。".into());
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
pub(crate) async fn wsl_dashboard_update(proxy_url: Option<String>) -> PlatformResult<()> {
    #[cfg(windows)] {
        let proxy_url = proxy_url.map(|value| crate::core::codex::account_controls::validate_proxy(&value)
            .map_err(|_| "代理地址无效，请使用无账号密码的 HTTP/HTTPS 地址"))
            .transpose()?.flatten();
        tauri::async_runtime::spawn_blocking(move || {
            let result = invoke_wsl_update(proxy_url.as_deref()).map(|_| ());
            record_operation("更新 WSL", None, result.is_ok());
            result
        }).await.map_err(|_| "WSL 更新任务异常结束，请重试")?
    }
    #[cfg(not(windows))] { unsupported() }
}

#[cfg(windows)]
fn invoke_wsl_update(proxy_url: Option<&str>) -> PlatformResult<Output> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut command = Command::new("wsl.exe");
    command.args(["--update", "--web-download"])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);
    if let Some(proxy) = proxy_url {
        command.env("HTTP_PROXY", proxy).env("HTTPS_PROXY", proxy);
    }
    let output = command.output().map_err(|_| "未能启动 WSL 更新，请确认 Windows 已启用 WSL 并重试")?;
    if output.status.success() { Ok(output) }
    else { Err("WSL 更新未完成，请检查网络、代理连接和 WSL 状态".into()) }
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
        if !location.is_empty() {
            let target = Path::new(location);
            if target.exists() && !target.is_dir() { return Err("安装目录已存在且不是文件夹".into()); }
            std::fs::create_dir_all(target).map_err(|_| "无法创建发行版安装目录，请检查路径权限和磁盘空间")?;
            if std::fs::read_dir(target).map_err(|_| "无法读取发行版安装目录")?.next().is_some() {
                return Err("发行版安装目录必须为空，请选择新的空目录".into());
            }
        }
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
            let source_version = registered.iter().find(|item| item.name.eq_ignore_ascii_case(source))
                .ok_or("源发行版不存在，请刷新列表")?.version.unwrap_or(2).to_string();
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
            invoke_wsl(&["--import", distribution, install_location, archive, "--version", &source_version])?;
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

#[cfg(test)]
mod tests {
    use super::{parse_wsl_runtime_info, version_meets_minimum};

    #[test]
    fn compares_wsl_versions_numerically() {
        assert_eq!(version_meets_minimum("2.6.2.0", "2.6.3"), Some(false));
        assert_eq!(version_meets_minimum("2.6.3.0", "2.6.3"), Some(true));
        assert_eq!(version_meets_minimum("2.6.10.0", "2.6.3"), Some(true));
        assert_eq!(version_meets_minimum("unknown", "2.6.3"), None);
    }

    #[test]
    fn parses_wsl_and_component_versions() {
        let info = parse_wsl_runtime_info("WSL 版本: 2.4.12.0\n内核版本: 5.15.167.4-1\nWSLg 版本: 1.0.65");
        assert_eq!(info.current_version.as_deref(), Some("2.4.12.0"));
        assert_eq!(info.compatible, Some(false));
        assert_eq!(info.components.len(), 3);
        assert_eq!(info.components[1].version, "5.15.167.4");
    }
}
