//! Safe, fixed-target shortcuts for common Windows settings and maintenance.
use crate::core::error::PlatformResult;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const CREDSSP_REG_KEY: &str = r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System\CredSSP\Parameters";
const CREDSSP_VALUE_NAME: &str = "AllowEncryptionOracle";
const EXPLORER_ADVANCED_REG_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced";
const HIDE_DESKTOP_ICONS_NEW_START_PANEL_REG_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\HideDesktopIcons\NewStartPanel";
const SPOTLIGHT_DESKTOP_ICON_CLSID: &str = "{2cc5ca98-6485-489a-920e-b3e88a6ccce3}";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExplorerPreferences {
    show_file_extensions: bool,
    show_hidden_files: bool,
    show_spotlight_icon: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CredSspStatus {
    current_value: Option<u32>,
    backup_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredSspBackup {
    version: u8,
    original_value: Option<u32>,
}

fn parse_reg_dword_query(output: &str) -> Result<Option<u32>, String> {
    for line in output.lines() {
        let mut fields = line.split_whitespace();
        if fields.next().is_some_and(|name| name.eq_ignore_ascii_case(CREDSSP_VALUE_NAME)) {
            let value_type = fields.next().unwrap_or_default();
            let raw_value = fields.next().unwrap_or_default();
            if !value_type.eq_ignore_ascii_case("REG_DWORD") {
                return Err("CredSSP 策略类型不是 DWORD；为避免改写未知配置，已停止操作。".into());
            }
            let value = raw_value.strip_prefix("0x")
                .or_else(|| raw_value.strip_prefix("0X"))
                .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                .or_else(|| raw_value.parse::<u32>().ok())
                .ok_or_else(|| "无法识别当前 CredSSP 策略值；未执行更改。".to_string())?;
            return Ok(Some(value));
        }
    }
    Ok(None)
}

fn parse_named_reg_dword(output: &str, name: &str) -> Result<Option<u32>, String> {
    for line in output.lines() {
        let mut fields = line.split_whitespace();
        if fields.next().is_some_and(|field| field.eq_ignore_ascii_case(name)) {
            if !fields.next().is_some_and(|field| field.eq_ignore_ascii_case("REG_DWORD")) {
                return Err(format!("Windows Explorer 设置 {name} 不是 DWORD；未执行更改。"));
            }
            let raw_value = fields.next().unwrap_or_default();
            let value = raw_value.strip_prefix("0x").or_else(|| raw_value.strip_prefix("0X"))
                .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                .or_else(|| raw_value.parse::<u32>().ok())
                .ok_or_else(|| format!("无法识别 Windows Explorer 设置 {name}；未执行更改。"))?;
            return Ok(Some(value));
        }
    }
    Ok(None)
}

#[cfg(target_os = "windows")]
fn read_explorer_dword(name: &str) -> Result<Option<u32>, String> {
    use std::{os::windows::process::CommandExt, process::{Command, Stdio}};
    let windows_dir = std::env::var_os("SystemRoot").map(PathBuf::from)
        .ok_or_else(|| "无法定位 Windows 系统目录。".to_string())?;
    let output = Command::new(windows_dir.join("System32").join("reg.exe"))
        .args(["query", EXPLORER_ADVANCED_REG_KEY, "/v", name])
        .creation_flags(0x08000000).stdin(Stdio::null()).stderr(Stdio::null()).output()
        .map_err(|_| "无法读取 Windows 文件资源管理器设置。".to_string())?;
    if output.status.success() {
        parse_named_reg_dword(&String::from_utf8_lossy(&output.stdout), name)
    } else if output.status.code() == Some(1) {
        Ok(None)
    } else {
        Err("读取 Windows 文件资源管理器设置失败。".into())
    }
}

#[cfg(target_os = "windows")]
fn read_spotlight_icon_hidden() -> Result<Option<u32>, String> {
    use std::{os::windows::process::CommandExt, process::{Command, Stdio}};
    let windows_dir = std::env::var_os("SystemRoot").map(PathBuf::from)
        .ok_or_else(|| "无法定位 Windows 系统目录。".to_string())?;
    let output = Command::new(windows_dir.join("System32").join("reg.exe"))
        .args(["query", HIDE_DESKTOP_ICONS_NEW_START_PANEL_REG_KEY, "/v", SPOTLIGHT_DESKTOP_ICON_CLSID])
        .creation_flags(0x08000000).stdin(Stdio::null()).stderr(Stdio::null()).output()
        .map_err(|_| "无法读取 Windows 桌面图标设置。".to_string())?;
    if output.status.success() {
        parse_named_reg_dword(&String::from_utf8_lossy(&output.stdout), SPOTLIGHT_DESKTOP_ICON_CLSID)
    } else if output.status.code() == Some(1) {
        Ok(None)
    } else {
        Err("读取 Windows 桌面图标设置失败。".into())
    }
}

#[cfg(target_os = "windows")]
fn explorer_preferences() -> Result<ExplorerPreferences, String> {
    let hide_file_ext = read_explorer_dword("HideFileExt")?.unwrap_or(1);
    let hidden = read_explorer_dword("Hidden")?.unwrap_or(2);
    let spotlight_hidden = read_spotlight_icon_hidden()?.unwrap_or(0);
    if hide_file_ext > 1 || !(1..=2).contains(&hidden) || spotlight_hidden > 1 {
        return Err("Windows 文件资源管理器设置值超出支持范围；请先通过 Windows 设置检查。".into());
    }
    Ok(ExplorerPreferences {
        show_file_extensions: hide_file_ext == 0,
        show_hidden_files: hidden == 1,
        show_spotlight_icon: spotlight_hidden == 0,
    })
}

#[cfg(target_os = "windows")]
fn notify_explorer_preferences_changed() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
    };

    // Let Explorer and other shell windows know that the current user's
    // Explorer\Advanced preferences changed. A timeout is intentionally
    // non-fatal: the registry write and its read-back remain authoritative.
    for name in [
        "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced",
        "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\HideDesktopIcons\\NewStartPanel",
    ] {
        let section: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let mut result = 0usize;
        unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                section.as_ptr() as isize,
                SMTO_ABORTIFHUNG,
                2_000,
                &mut result,
            );
        }
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub(crate) fn windows_toolbox_explorer_preferences() -> PlatformResult<ExplorerPreferences> {
    explorer_preferences().map_err(Into::into)
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub(crate) fn windows_toolbox_explorer_preferences() -> PlatformResult<ExplorerPreferences> {
    Err("文件资源管理器显示设置仅支持 Windows 桌面端。".into())
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub(crate) fn windows_toolbox_set_explorer_preference(setting: String, enabled: bool) -> PlatformResult<ExplorerPreferences> {
    use std::{os::windows::process::CommandExt, process::{Command, Stdio}};
    let (key, name, value) = match setting.as_str() {
        "file-extensions" => (EXPLORER_ADVANCED_REG_KEY, "HideFileExt", if enabled { 0 } else { 1 }),
        "hidden-files" => (EXPLORER_ADVANCED_REG_KEY, "Hidden", if enabled { 1 } else { 2 }),
        "spotlight-icon" => (HIDE_DESKTOP_ICONS_NEW_START_PANEL_REG_KEY, SPOTLIGHT_DESKTOP_ICON_CLSID, if enabled { 0 } else { 1 }),
        _ => return Err("不支持的文件资源管理器显示设置。".into()),
    };
    let windows_dir = std::env::var_os("SystemRoot").map(PathBuf::from)
        .ok_or_else(|| "无法定位 Windows 系统目录；设置未更改。".to_string())?;
    let status = Command::new(windows_dir.join("System32").join("reg.exe"))
        .args(["add", key, "/v", name, "/t", "REG_DWORD", "/d"])
        .arg(value.to_string()).args(["/f"])
        .creation_flags(0x08000000).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .status().map_err(|_| "无法更新 Windows 文件资源管理器设置。".to_string())?;
    if !status.success() {
        return Err("Windows 未能更新文件资源管理器设置；请检查当前用户权限或组策略。".into());
    }
    notify_explorer_preferences_changed();
    let actual = explorer_preferences()?;
    let verified = match setting.as_str() {
        "file-extensions" => actual.show_file_extensions == enabled,
        "hidden-files" => actual.show_hidden_files == enabled,
        "spotlight-icon" => actual.show_spotlight_icon == enabled,
        _ => false,
    };
    if !verified {
        return Err("设置命令已返回，但复查值不一致；请检查 Windows 组策略。".into());
    }
    Ok(actual)
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub(crate) fn windows_toolbox_set_explorer_preference(_setting: String, _enabled: bool) -> PlatformResult<ExplorerPreferences> {
    Err("文件资源管理器显示设置仅支持 Windows 桌面端。".into())
}

#[cfg(target_os = "windows")]
fn credssp_backup_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path().app_local_data_dir()
        .map(|path| path.join("windows-toolbox").join("credssp-backup.json"))
        .map_err(|_| "无法定位应用本地数据目录，未更改 CredSSP 策略。".to_string())
}

#[cfg(target_os = "windows")]
fn load_credssp_backup(path: &std::path::Path) -> Result<Option<CredSspBackup>, String> {
    use std::fs;
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法读取 CredSSP 原始设置备份。".into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 1024 {
        return Err("CredSSP 原始设置备份格式无效；为避免覆盖备份，已停止操作。".into());
    }
    let bytes = fs::read(path).map_err(|_| "无法读取 CredSSP 原始设置备份。".to_string())?;
    let backup: CredSspBackup = serde_json::from_slice(&bytes)
        .map_err(|_| "CredSSP 原始设置备份损坏；为避免覆盖备份，已停止操作。".to_string())?;
    if backup.version != 1 {
        return Err("CredSSP 原始设置备份版本不受支持；未执行更改。".into());
    }
    Ok(Some(backup))
}

#[cfg(target_os = "windows")]
fn save_credssp_backup(path: &std::path::Path, backup: &CredSspBackup) -> Result<(), String> {
    use std::{fs::{self, OpenOptions}, io::Write};
    let parent = path.parent().ok_or_else(|| "无法创建 CredSSP 设置备份。".to_string())?;
    fs::create_dir_all(parent).map_err(|_| "无法创建 CredSSP 设置备份目录；未更改策略。".to_string())?;
    let mut file = match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return load_credssp_backup(path).map(|_| ());
        }
        Err(_) => return Err("无法保存 CredSSP 原始设置备份；未更改策略。".into()),
    };
    let result = serde_json::to_vec(backup)
        .map_err(|_| "无法序列化 CredSSP 原始设置备份。".to_string())
        .and_then(|bytes| file.write_all(&bytes).map_err(|_| "无法写入 CredSSP 原始设置备份。".to_string()))
        .and_then(|()| file.sync_all().map_err(|_| "无法完成 CredSSP 原始设置备份。".to_string()));
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}

#[cfg(target_os = "windows")]
fn read_credssp_value() -> Result<Option<u32>, String> {
    use std::{os::windows::process::CommandExt, process::{Command, Stdio}};
    let windows_dir = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .ok_or_else(|| "无法定位 Windows 系统目录。".to_string())?;
    let output = Command::new(windows_dir.join("System32").join("reg.exe"))
        .args(["query", CREDSSP_REG_KEY, "/v", CREDSSP_VALUE_NAME])
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| "无法读取 Windows CredSSP 策略。".to_string())?;
    if output.status.success() {
        return parse_reg_dword_query(&String::from_utf8_lossy(&output.stdout));
    }
    if output.status.code() == Some(1) {
        return Ok(None);
    }
    Err("读取 Windows CredSSP 策略失败。".into())
}

#[cfg(target_os = "windows")]
fn apply_credssp_value(value: Option<u32>) -> Result<(), String> {
    use std::{os::windows::process::CommandExt, process::{Command, Stdio}};

    let operation = match value {
        Some(value) => format!(r#"
$arguments = @('add', '{CREDSSP_REG_KEY}', '/v', '{CREDSSP_VALUE_NAME}', '/t', 'REG_DWORD', '/d', '{value}', '/f')
"#),
        None => format!(r#"
$arguments = @('delete', '{CREDSSP_REG_KEY}', '/v', '{CREDSSP_VALUE_NAME}', '/f')
"#),
    };
    let script = format!(r#"
$ErrorActionPreference = 'Stop'
try {{
  $reg = Join-Path $env:SystemRoot 'System32\reg.exe'
  {operation}
  $process = Start-Process -FilePath $reg -ArgumentList $arguments -Verb RunAs -Wait -PassThru -ErrorAction Stop
  exit $process.ExitCode
}} catch {{
  if ($_.Exception.HResult -eq -2147023673) {{ exit 1223 }}
  exit 1
}}
"#);
    let status = Command::new("powershell.exe")
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-Command", &script])
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| "无法启动 CredSSP 策略修改流程。".to_string())?;
    if status.success() {
        Ok(())
    } else if status.code() == Some(1223) {
        Err("你取消了 Windows 管理员授权，CredSSP 策略未更改。".into())
    } else {
        Err("Windows 未能修改 CredSSP 策略；原始设置备份仍保留。".into())
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub(crate) fn windows_toolbox_credssp_status(app: tauri::AppHandle) -> PlatformResult<CredSspStatus> {
    let current_value = read_credssp_value()?;
    let backup_available = load_credssp_backup(&credssp_backup_path(&app)?)?.is_some();
    Ok(CredSspStatus { current_value, backup_available })
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub(crate) fn windows_toolbox_credssp_status(_app: tauri::AppHandle) -> PlatformResult<CredSspStatus> {
    Err("远程桌面身份验证修复仅支持 Windows 桌面端。".into())
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub(crate) fn windows_toolbox_credssp_apply(restore: bool, app: tauri::AppHandle) -> PlatformResult<CredSspStatus> {
    let path = credssp_backup_path(&app)?;
    let current_value = read_credssp_value()?;
    let target_value = if restore {
        load_credssp_backup(&path)?
            .ok_or_else(|| "没有找到修复前的原始设置备份，无法自动恢复。".to_string())?
            .original_value
    } else {
        if current_value == Some(2) {
            return Ok(CredSspStatus {
                current_value,
                backup_available: load_credssp_backup(&path)?.is_some(),
            });
        }
        let backup = CredSspBackup { version: 1, original_value: current_value };
        save_credssp_backup(&path, &backup)?;
        Some(2)
    };

    if current_value != target_value {
        apply_credssp_value(target_value)?;
    }
    let verified_value = read_credssp_value()?;
    if verified_value != target_value {
        return Err("Windows 操作已返回，但复查到的 CredSSP 策略与目标不一致；原始设置备份仍保留。".into());
    }
    let backup_available = load_credssp_backup(&path)?.is_some();
    Ok(CredSspStatus { current_value: verified_value, backup_available })
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub(crate) fn windows_toolbox_credssp_apply(_restore: bool, _app: tauri::AppHandle) -> PlatformResult<CredSspStatus> {
    Err("远程桌面身份验证修复仅支持 Windows 桌面端。".into())
}

#[cfg(test)]
mod tests {
    use super::{parse_named_reg_dword, parse_reg_dword_query};

    #[test]
    fn parses_existing_credssp_dword() {
        assert_eq!(parse_reg_dword_query("HKEY_LOCAL_MACHINE\\...\n    AllowEncryptionOracle    REG_DWORD    0x2\n").unwrap(), Some(2));
    }

    #[test]
    fn recognizes_missing_credssp_value() {
        assert_eq!(parse_reg_dword_query("HKEY_LOCAL_MACHINE\\...\n").unwrap(), None);
    }

    #[test]
    fn rejects_unexpected_credssp_registry_type() {
        assert!(parse_reg_dword_query("    AllowEncryptionOracle    REG_SZ    2\n").is_err());
    }

    #[test]
    fn parses_explorer_preference_dword_and_missing_default() {
        assert_eq!(parse_named_reg_dword("    HideFileExt    REG_DWORD    0x0\n", "HideFileExt").unwrap(), Some(0));
        assert_eq!(parse_named_reg_dword("HKEY_CURRENT_USER\\...\n", "Hidden").unwrap(), None);
    }

    #[test]
    fn rejects_unexpected_explorer_preference_type() {
        assert!(parse_named_reg_dword("    Hidden    REG_SZ    1\n", "Hidden").is_err());
    }
}

#[cfg(target_os = "windows")]
fn flush_dns_cache() -> Result<String, String> {
    use std::{os::windows::process::CommandExt, process::{Command, Stdio}};

    const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
try {
  $ipconfig = Join-Path $env:SystemRoot 'System32\ipconfig.exe'
  $process = Start-Process -FilePath $ipconfig -ArgumentList '/flushdns' -Verb RunAs -Wait -PassThru -ErrorAction Stop
  exit $process.ExitCode
} catch {
  exit 1223
}

"#;

    let status = Command::new("powershell.exe")
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-Command", SCRIPT])
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| "无法启动 Windows DNS 缓存清理流程。".to_string())?;

    if status.success() {
        Ok("DNS 缓存清理完成。".into())
    } else if status.code() == Some(1223) {
        Err("管理员授权已取消，DNS 缓存未清理。".into())
    } else {
        Err(format!("DNS 缓存清理失败，Windows 返回退出码 {}。", status.code().unwrap_or(-1)))
    }
}

#[cfg(target_os = "windows")]
fn restart_windows_explorer() -> Result<String, String> {
    use std::{os::windows::process::CommandExt, process::{Command, Stdio}};

    let windows_dir = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .ok_or_else(|| "无法定位 Windows 系统目录，未重启资源管理器。".to_string())?;
    let system_dir = windows_dir.join("System32");
    let taskkill = system_dir.join("taskkill.exe");
    // explorer.exe lives at the Windows directory root, not in System32.
    let explorer = windows_dir.join("explorer.exe");
    let username = std::env::var("USERNAME")
        .ok()
        .filter(|value| !value.is_empty() && !value.chars().any(|character| matches!(character, '\"' | '\n' | '\r')))
        .ok_or_else(|| "无法确认当前 Windows 用户，未关闭资源管理器。".to_string())?;
    let account = std::env::var("USERDOMAIN")
        .ok()
        .filter(|value| !value.is_empty() && !value.chars().any(|character| matches!(character, '\"' | '\n' | '\r')))
        .map(|domain| format!("{domain}\\{username}"))
        .unwrap_or(username);
    if !explorer.is_file() || !taskkill.is_file() {
        return Err("找不到 Windows 资源管理器或系统进程管理工具；未执行重启。".into());
    }

    let stop = Command::new(taskkill)
        .args(["/f", "/im", "explorer.exe", "/fi"])
        .arg(format!("USERNAME eq {account}"))
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| "无法关闭当前 Windows 资源管理器进程。".to_string())?;

    Command::new(explorer)
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "资源管理器进程已停止，但重新启动失败；请在任务管理器中运行 explorer.exe。".to_string())?;

    if stop.success() {
        Ok("已请求重新启动 Windows 资源管理器；桌面和任务栏应很快恢复。".into())
    } else {
        Ok("已请求启动 Windows 资源管理器；Windows 未确认原进程正常退出，请检查桌面和任务栏。".into())
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub(crate) async fn windows_toolbox_open(action: String, app: tauri::AppHandle) -> PlatformResult<String> {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt, path::PathBuf};
    use tauri::Manager;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;

    if action == "flush-dns" {
        return Ok(tauri::async_runtime::spawn_blocking(flush_dns_cache)
            .await
            .map_err(|_| "DNS 缓存清理任务异常结束。".to_string())??);
    }
    if action == "restart-explorer" {
        return Ok(tauri::async_runtime::spawn_blocking(restart_windows_explorer)
            .await
            .map_err(|_| "资源管理器重启任务异常结束。".to_string())??);
    }

    fn wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    fn system_executable(name: &str) -> Result<PathBuf, String> {
        let windows_dir = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .ok_or_else(|| "无法定位 Windows 系统目录。".to_string())?;
        Ok(windows_dir.join("System32").join(name))
    }

    fn launch(verb: &str, target: &OsStr, arguments: Option<&OsStr>) -> Result<(), String> {
        let verb = wide(OsStr::new(verb));
        let target = wide(target);
        let arguments = arguments.map(wide);
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                target.as_ptr(),
                arguments.as_ref().map_or(std::ptr::null(), |value| value.as_ptr()),
                std::ptr::null(),
                1,
            )
        } as isize;
        if result <= 32 {
            return Err(if result == 5 || result == 1223 {
                "Windows 管理员授权或操作被取消。".into()
            } else {
                "Windows 无法打开此工具；请确认相关系统组件可用。".into()
            });
        }
        Ok(())
    }

    let (target, arguments, elevated) = match action.as_str() {
        "desktop-icons" => (system_executable("rundll32.exe")?, Some("shell32.dll,Control_RunDLL desk.cpl,,0"), false),
        "installed-apps" => (PathBuf::from("ms-settings:appsfeatures"), None, false),
        "system-proxy" => (PathBuf::from("ms-settings:network-proxy"), None, false),
        "network-connections" => (system_executable("control.exe")?, Some("ncpa.cpl"), false),
        "display" => (PathBuf::from("ms-settings:display"), None, false),
        "hosts-folder" => {
            let windows_dir = std::env::var_os("SystemRoot")
                .map(PathBuf::from)
                .ok_or_else(|| "无法定位 Windows 系统目录。".to_string())?;
            let hosts_dir = windows_dir.join("System32").join("drivers").join("etc");
            if !hosts_dir.is_dir() {
                return Err("Windows hosts 文件夹不存在。".into());
            }
            (hosts_dir, None, false)
        }
        "hosts" => {
            let windows_dir = std::env::var_os("SystemRoot")
                .map(PathBuf::from)
                .ok_or_else(|| "无法定位 Windows 系统目录。".to_string())?;
            let hosts = windows_dir.join("System32").join("drivers").join("etc").join("hosts");
            if !hosts.is_file() {
                return Err("Windows hosts 文件不存在。".into());
            }
            let backup_dir = app.path().app_local_data_dir()
                .map_err(|_| "无法定位应用本地数据目录，未打开 hosts 文件。".to_string())?
                .join("hosts-backups");
            std::fs::create_dir_all(&backup_dir)
                .map_err(|_| "无法创建 hosts 备份目录，未打开 hosts 文件。".to_string())?;
            let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S-%f");
            let backup = backup_dir.join(format!("hosts-{stamp}.bak"));
            std::fs::copy(&hosts, &backup)
                .map_err(|_| "备份 hosts 文件失败，未打开原文件。".to_string())?;
            let notepad = system_executable("notepad.exe")?;
            launch("runas", notepad.as_os_str(), Some(hosts.as_os_str()))?;
            return Ok(backup.display().to_string());
        }
        _ => return Err("不支持的 Windows 工具箱操作。".into()),
    };

    let verb = if elevated { "runas" } else { "open" };
    launch(verb, target.as_os_str(), arguments.map(OsStr::new))?;
    Ok(String::new())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub(crate) fn windows_toolbox_open(_action: String, _app: tauri::AppHandle) -> PlatformResult<String> {
    Err("Windows 工具箱仅支持 Windows 桌面端。".into())
}

// Monitor brightness (internal panels via the high-level API, external monitors
// via DDC/CI VCP 0x10) and turning the display off.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MonitorBrightnessStatus {
    index: usize,
    name: String,
    supported: bool,
    /// Brightness normalized to 0-100; `None` when the monitor exposes no control.
    current: Option<u32>,
}


#[cfg(target_os = "windows")]
fn percent_from_device_value(current: u32, minimum: u32, maximum: u32) -> u32 {
    if maximum <= minimum {
        return 0;
    }
    let span = maximum - minimum;
    (current.saturating_sub(minimum) * 100 + span / 2) / span
}

#[cfg(target_os = "windows")]
fn device_value_from_percent(percent: u32, minimum: u32, maximum: u32) -> u32 {
    if maximum <= minimum {
        return minimum;
    }
    let span = maximum - minimum;
    minimum + (span * percent.min(100) + 50) / 100
}

#[cfg(target_os = "windows")]
type MonitorHandle = windows_sys::Win32::Foundation::HANDLE;

#[cfg(target_os = "windows")]
unsafe extern "system" fn collect_monitor_handle(
    hmonitor: windows_sys::Win32::Graphics::Gdi::HMONITOR,
    _hdc: windows_sys::Win32::Graphics::Gdi::HDC,
    _rect: *mut windows_sys::Win32::Foundation::RECT,
    data: windows_sys::Win32::Foundation::LPARAM,
) -> windows_sys::Win32::Foundation::BOOL {
    let handles = &mut *(data as *mut Vec<windows_sys::Win32::Graphics::Gdi::HMONITOR>);
    handles.push(hmonitor);
    1
}

#[cfg(target_os = "windows")]
fn enum_display_monitors() -> Vec<windows_sys::Win32::Graphics::Gdi::HMONITOR> {
    use windows_sys::Win32::Foundation::LPARAM;
    use windows_sys::Win32::Graphics::Gdi::{EnumDisplayMonitors, HMONITOR};

    let mut handles: Vec<HMONITOR> = Vec::new();
    unsafe {
        EnumDisplayMonitors(
            std::ptr::null_mut(),
            std::ptr::null(),
            Some(collect_monitor_handle),
            &mut handles as *mut Vec<HMONITOR> as LPARAM,
        );
    }
    handles
}

#[cfg(target_os = "windows")]
fn utf16_text(value: &[u16]) -> String {
    let end = value.iter().position(|&character| character == 0).unwrap_or(value.len());
    String::from_utf16_lossy(&value[..end]).trim().to_string()
}

#[cfg(target_os = "windows")]
fn normalize_display_device_id(raw: &[u16]) -> Option<String> {
    let text = utf16_text(raw);
    if text.starts_with("DISPLAY\\") && text.len() > "DISPLAY\\".len() {
        return Some(text);
    }
    // Interface form: \\?\DISPLAY#BOE0A1F#5&31af514a&0&UID4357#{e6f07b5f-...}
    if let Some(rest) = text.strip_prefix("\\\\?\\DISPLAY#") {
        let mut parts = rest.split('#');
        let model = parts.next()?;
        let instance = parts.next()?;
        if !model.is_empty() && !instance.is_empty() {
            return Some(format!("DISPLAY\\{model}\\{instance}"));
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn monitor_device_id(hmonitor: windows_sys::Win32::Graphics::Gdi::HMONITOR) -> Option<String> {
    use windows_sys::Win32::Graphics::Gdi::{
        EnumDisplayDevicesW, GetMonitorInfoW, DISPLAY_DEVICEW, MONITORINFO, MONITORINFOEXW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::EDD_GET_DEVICE_INTERFACE_NAME;

    unsafe {
        let mut info: MONITORINFOEXW = std::mem::zeroed();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(hmonitor, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO) == 0 {
            return None;
        }
        let device_name = utf16_text(&info.szDevice);
        if device_name.is_empty() {
            return None;
        }
        let device_name: Vec<u16> = device_name.encode_utf16().chain(std::iter::once(0)).collect();
        for flags in [0u32, EDD_GET_DEVICE_INTERFACE_NAME] {
            let mut monitor_device: DISPLAY_DEVICEW = std::mem::zeroed();
            monitor_device.cb = std::mem::size_of::<DISPLAY_DEVICEW>() as u32;
            if EnumDisplayDevicesW(device_name.as_ptr(), 0, &mut monitor_device, flags) != 0 {
                if let Some(device_id) = normalize_display_device_id(&monitor_device.DeviceID) {
                    return Some(device_id);
                }
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn read_registry_friendly_name(device_id: &str) -> Option<String> {
    use std::{os::windows::process::CommandExt, process::{Command, Stdio}};
    let windows_dir = std::env::var_os("SystemRoot").map(PathBuf::from)?;
    let output = Command::new(windows_dir.join("System32").join("reg.exe"))
        .args(["query", &format!(r"HKLM\SYSTEM\CurrentControlSet\Enum\{device_id}"), "/v", "FriendlyName"])
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Some(position) = line.find("REG_SZ") {
            let name = line[position + "REG_SZ".len()..].trim();
            if !name.is_empty() {
                return Some(name.to_string());
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn monitor_friendly_name(
    wmi_name: Option<&str>,
    device_id: Option<&str>,
    description: &str,
    fallback_index: usize,
) -> String {
    if let Some(wmi_name) = wmi_name.map(str::trim).filter(|name| !name.is_empty()) {
        return wmi_name.to_string();
    }
    // The device id is an OS-provided registry path fragment; restrict it to the
    // characters such ids actually use before handing it to reg.exe.
    if let Some(device_id) = device_id {
        if device_id.len() <= 128
            && device_id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '\\' | '&' | '_' | '.' | '-')
            })
        {
            if let Some(name) = read_registry_friendly_name(device_id) {
                return name;
            }
        }
    }
    let description = description.trim();
    // dxva2 fills laptop panels with useful names ("Integrated Monitor") but some
    // DDC/CI paths leak graphics-kernel strings; only trust plausible names.
    let unusable = description.is_empty()
        || description.eq_ignore_ascii_case("Generic PnP Monitor")
        || description.starts_with('@')
        || description.contains("dxgkrnl");
    if !unusable {
        return description.to_string();
    }
    format!("显示器 {}", fallback_index + 1)
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Default)]
struct WmiMonitorInfo {
    name: Option<String>,
    current: Option<u32>,
    minimum: u32,
    maximum: u32,
}

#[cfg(target_os = "windows")]
fn run_powershell_script(script: &str) -> Result<String, String> {
    use std::{os::windows::process::CommandExt, process::{Command, Stdio}};
    let output = Command::new("powershell.exe")
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-Command", script])
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| "无法启动 Windows 亮度查询流程。".to_string())?;
    if !output.status.success() {
        return Err(format!("Windows 亮度操作执行失败（退出码 {}）。", output.status.code().unwrap_or(-1)));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Laptop panels expose brightness only through WMI, not through dxva2. One
/// PowerShell call gathers names (WmiMonitorID) and brightness ranges
/// (WmiMonitorBrightness), keyed by the PnP instance name that starts with the
/// display device id used elsewhere in this module.
#[cfg(target_os = "windows")]
fn query_wmi_monitors() -> std::collections::HashMap<String, WmiMonitorInfo> {
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorID | ForEach-Object {
    $name = ''
    foreach ($c in $_.UserFriendlyName) { if ($c -ne 0) { $name += [char]$c } }
    Write-Output ("N|" + $_.InstanceName + "|" + $name)
  }
  Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness | ForEach-Object {
    $levels = @($_.Level)
    $min = 0
    $max = 0
    if ($levels.Count -gt 0) { $min = $levels[0]; $max = $levels[$levels.Count - 1] }
    Write-Output ("B|" + $_.InstanceName + "|" + $_.CurrentBrightness + "|" + $min + "|" + $max)
  }
} catch { }
"#;
    let mut monitors = std::collections::HashMap::new();
    let Ok(output) = run_powershell_script(SCRIPT) else { return monitors };
    for line in output.lines() {
        let mut fields = line.split('|');
        match fields.next() {
            Some("N") => {
                let (Some(instance), Some(name)) = (fields.next(), fields.next()) else { continue };
                let name = name.trim();
                if !name.is_empty() {
                    monitors.entry(instance.trim().to_ascii_lowercase()).or_insert_with(WmiMonitorInfo::default).name = Some(name.to_string());
                }
            }
            Some("B") => {
                let (Some(instance), Some(current), Some(minimum), Some(maximum)) =
                    (fields.next(), fields.next(), fields.next(), fields.next())
                else { continue };
                if let (Ok(current), Ok(minimum), Ok(maximum)) = (
                    current.trim().parse::<u32>(),
                    minimum.trim().parse::<u32>(),
                    maximum.trim().parse::<u32>(),
                ) {
                    let entry = monitors.entry(instance.trim().to_ascii_lowercase()).or_insert_with(WmiMonitorInfo::default);
                    entry.current = Some(current);
                    entry.minimum = minimum;
                    entry.maximum = maximum;
                }
            }
            _ => {}
        }
    }
    monitors
}

#[cfg(target_os = "windows")]
fn find_wmi_monitor<'a>(
    monitors: &'a std::collections::HashMap<String, WmiMonitorInfo>,
    device_id: Option<&str>,
) -> Option<&'a WmiMonitorInfo> {
    let device_id = device_id?.to_ascii_lowercase();
    monitors
        .iter()
        .find(|(instance, _)| instance.starts_with(&device_id))
        .map(|(_, info)| info)
}

/// Set brightness through WMI for panels dxva2 cannot drive; returns the
/// verified raw value after the monitor reports back.
#[cfg(target_os = "windows")]
fn wmi_set_brightness(device_id: &str, raw_value: u32) -> Result<u32, String> {
    // CimInstance objects (Get-CimInstance) do not expose WMI methods as .NET
    // methods on Windows PowerShell 5.1 — `$instance.WmiSetBrightness(...)`
    // throws "不包含名为 WmiSetBrightness 的方法". Invoke-CimMethod is the only
    // supported invocation form. The WMI signature is
    // WmiSetBrightness(uint32 Timeout, uint8 Brightness), hence the byte cast.
    let raw_value = raw_value.min(255);
    let script = format!(r#"
$ErrorActionPreference = 'Stop'
try {{
  $target = '{device_id}'
  $value = {raw_value}
  $methods = Get-CimInstance -Namespace root/wmi -Class WmiMonitorBrightnessMethods | Where-Object {{ $_.InstanceName -like ($target + '*') }}
  if (-not $methods) {{ exit 1 }}
  foreach ($instance in @($methods)) {{
    Invoke-CimMethod -InputObject $instance -MethodName WmiSetBrightness -Arguments @{{ Timeout = [uint32]1; Brightness = [byte]$value }} | Out-Null
  }}
  Start-Sleep -Milliseconds 150
  $verified = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness | Where-Object {{ $_.InstanceName -like ($target + '*') }} | Select-Object -First 1
  if (-not $verified) {{ exit 2 }}
  Write-Output $verified.CurrentBrightness
}} catch {{
  exit 3
}}
"#);
    let output = run_powershell_script(&script)?;
    output
        .trim()
        .parse::<u32>()
        .map_err(|_| "内置显示器亮度设置后未能读取到确认值。".to_string())
}

#[cfg(target_os = "windows")]
fn read_brightness_range(handle: MonitorHandle) -> Option<(u32, u32, u32)> {
    if handle.is_null() { return None; }
    use windows_sys::Win32::Devices::Display::{GetMonitorBrightness, GetVCPFeatureAndVCPFeatureReply, MC_VCP_CODE_TYPE};
    unsafe {
        let (mut minimum, mut current, mut maximum) = (0u32, 0u32, 0u32);
        if GetMonitorBrightness(handle, &mut minimum, &mut current, &mut maximum) != 0 && maximum > minimum {
            return Some((current, minimum, maximum));
        }
        let mut value_type: MC_VCP_CODE_TYPE = 0;
        if GetVCPFeatureAndVCPFeatureReply(handle, 0x10, &mut value_type, &mut current, &mut maximum) != 0 && maximum > minimum {
            return Some((current, minimum, maximum));
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn set_brightness_value(
    handle: MonitorHandle,
    wmi_info: Option<&WmiMonitorInfo>,
    device_id: Option<&str>,
    percent: u32,
) -> Result<u32, String> {
    use windows_sys::Win32::Devices::Display::{SetMonitorBrightness, SetVCPFeature};
    // dxva2 covers external DDC/CI monitors (and any panel exposing the high-level API).
    if let Some((_, minimum, maximum)) = read_brightness_range(handle) {
        let value = device_value_from_percent(percent, minimum, maximum);
        unsafe {
            if SetMonitorBrightness(handle, value) != 0 || SetVCPFeature(handle, 0x10, value) != 0 {
                if let Some((current, _, _)) = read_brightness_range(handle) {
                    return Ok(percent_from_device_value(current, minimum, maximum));
                }
                return Err("已发送亮度设置，但无法读取显示器亮度来确认结果。".into());
            }
        }
    }
    // Laptop panels only answer to WMI.
    if let (Some(info), Some(device_id)) = (wmi_info, device_id) {
        if info.current.is_some() && info.maximum > info.minimum {
            let value = device_value_from_percent(percent, info.minimum, info.maximum);
            let verified = wmi_set_brightness(device_id, value)?;
            return Ok(percent_from_device_value(verified, info.minimum, info.maximum));
        }
    }
    Err("该显示器不支持亮度控制；外接显示器请先在其 OSD 菜单开启 DDC/CI。".into())
}

#[cfg(target_os = "windows")]
enum MonitorOperation {
    Read,
    Set { index: usize, percent: u32 },
}

#[cfg(target_os = "windows")]
fn run_monitor_operation(operation: MonitorOperation) -> Result<Vec<MonitorBrightnessStatus>, String> {
    use windows_sys::Win32::Devices::Display::{
        DestroyPhysicalMonitors, GetNumberOfPhysicalMonitorsFromHMONITOR, GetPhysicalMonitorsFromHMONITOR, PHYSICAL_MONITOR,
    };

    let mut statuses: Vec<MonitorBrightnessStatus> = Vec::new();
    // One WMI round-trip up front: names for every monitor plus the brightness
    // interface for laptop panels that dxva2 cannot drive.
    let wmi_monitors = query_wmi_monitors();
    for hmonitor in enum_display_monitors() {
        let mut count: u32 = 0;
        let has_count = unsafe { GetNumberOfPhysicalMonitorsFromHMONITOR(hmonitor, &mut count) != 0 } && count != 0;
        let mut monitors: Vec<PHYSICAL_MONITOR> = vec![unsafe { std::mem::zeroed() }; count as usize];
        let has_physical = has_count && unsafe { GetPhysicalMonitorsFromHMONITOR(hmonitor, count, monitors.as_mut_ptr()) != 0 };
        if !has_physical {
            // Keep logical displays visible even without a DDC/CI handle. WMI may still support them.
            monitors.clear();
            monitors.push(unsafe { std::mem::zeroed() });
        }
        let device_id = monitor_device_id(hmonitor);
        let wmi_info = find_wmi_monitor(&wmi_monitors, device_id.as_deref());
        for physical in &monitors {
            // PHYSICAL_MONITOR is packed; copy the field out before taking a reference.
            let description_buffer = physical.szPhysicalMonitorDescription;
            let description = utf16_text(&description_buffer);
            let mut status = MonitorBrightnessStatus {
                index: statuses.len(),
                name: monitor_friendly_name(
                    wmi_info.and_then(|info| info.name.as_deref()),
                    device_id.as_deref(),
                    &description,
                    statuses.len(),
                ),
                supported: false,
                current: None,
            };
            if let Some((current, minimum, maximum)) = read_brightness_range(physical.hPhysicalMonitor) {
                status.supported = true;
                status.current = Some(percent_from_device_value(current, minimum, maximum));
            } else if let Some(info) = wmi_info {
                if info.maximum > info.minimum {
                    if let Some(current) = info.current {
                        status.supported = true;
                        status.current = Some(percent_from_device_value(current, info.minimum, info.maximum));
                    }
                }
            }
            if let MonitorOperation::Set { index, percent } = operation {
                if status.index == index {
                    let updated = set_brightness_value(physical.hPhysicalMonitor, wmi_info, device_id.as_deref(), percent)
                        .map_err(|reason| {
                            if has_physical {
                                unsafe { DestroyPhysicalMonitors(count, monitors.as_ptr()); }
                            }
                            reason
                        })?;
                    status.supported = true;
                    status.current = Some(updated);
                }
            }
            statuses.push(status);
        }
        if has_physical {
            unsafe { DestroyPhysicalMonitors(count, monitors.as_ptr()); }
        }
    }
    if let MonitorOperation::Set { index, .. } = operation {
        if statuses.len() <= index {
            return Err(format!("显示器列表已变化（当前 {} 台），请刷新后重试。", statuses.len()));
        }
    }
    Ok(statuses)
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub(crate) async fn windows_toolbox_monitor_brightness() -> PlatformResult<Vec<MonitorBrightnessStatus>> {
    tauri::async_runtime::spawn_blocking(|| run_monitor_operation(MonitorOperation::Read))
        .await
        .map_err(|_| "显示器亮度读取任务异常结束。".to_string())?
        .map_err(Into::into)
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub(crate) async fn windows_toolbox_set_monitor_brightness(window: tauri::WebviewWindow, index: u32, percent: u32) -> PlatformResult<MonitorBrightnessStatus> {
    if percent > 100 { return Err("亮度须在 0 到 100 之间。".into()); }
    let started = std::time::Instant::now();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_monitor_operation(MonitorOperation::Set { index: index as usize, percent })
    })
    .await
    .map_err(|_| "显示器亮度设置任务异常结束。".to_string())
    .and_then(|result| result)
    .and_then(|statuses| statuses.into_iter().nth(index as usize)
        .ok_or_else(|| "显示器编号已失效，请刷新显示器列表。".into()));
    if window.label() == "desktop-pet" {
        use crate::commands::desktop_pet::activity::{record, Kind};
        use tauri::Manager;
        let title = format!("将屏幕 {} 的亮度调到 {percent}%", u64::from(index) + 1);
        let detail = match &result {
            Ok(status) => status.current.map(|current| format!("当前亮度 {current}%")),
            Err(error) => Some(error.clone()),
        };
        record(window.app_handle(), Kind::Operation, started, &title,
            if result.is_ok() { "成功" } else { "失败" }, detail.as_deref());
    }
    result.map_err(Into::into)
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub(crate) fn windows_toolbox_turn_off_display() -> PlatformResult<()> {
    use windows_sys::Win32::Foundation::{LPARAM, WPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{PostMessageW, HWND_BROADCAST, SC_MONITORPOWER, WM_SYSCOMMAND};
    let sent = unsafe {
        PostMessageW(HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER as WPARAM, 2 as LPARAM)
    };
    if sent == 0 {
        return Err("Windows 未接受关闭显示器的请求。".into());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub(crate) async fn windows_toolbox_monitor_brightness() -> PlatformResult<Vec<MonitorBrightnessStatus>> {
    Err("显示器亮度调节仅支持 Windows 桌面端。".into())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub(crate) async fn windows_toolbox_set_monitor_brightness(_index: u32, _percent: u32) -> PlatformResult<MonitorBrightnessStatus> {
    Err("显示器亮度调节仅支持 Windows 桌面端。".into())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub(crate) fn windows_toolbox_turn_off_display() -> PlatformResult<()> {
    Err("关闭显示器仅支持 Windows 桌面端。".into())
}

#[cfg(all(test, target_os = "windows"))]
mod monitor_value_tests {
    use super::{device_value_from_percent, percent_from_device_value};

    #[test]
    fn converts_device_values_to_percent() {
        assert_eq!(percent_from_device_value(0, 0, 100), 0);
        assert_eq!(percent_from_device_value(50, 0, 100), 50);
        assert_eq!(percent_from_device_value(100, 0, 100), 100);
        assert_eq!(percent_from_device_value(1, 1, 100), 0);
        assert_eq!(percent_from_device_value(100, 1, 100), 100);
    }

    #[test]
    fn converts_percent_to_device_values() {
        assert_eq!(device_value_from_percent(0, 0, 100), 0);
        assert_eq!(device_value_from_percent(50, 0, 100), 50);
        assert_eq!(device_value_from_percent(100, 0, 100), 100);
        assert_eq!(device_value_from_percent(100, 1, 100), 100);
        assert_eq!(device_value_from_percent(150, 0, 100), 100);
    }

    #[test]
    fn percent_round_trips_within_one_step() {
        for percent in [0u32, 1, 25, 50, 75, 99, 100] {
            let value = device_value_from_percent(percent, 0, 255);
            let rounded = percent_from_device_value(value, 0, 255);
            assert!(
                (rounded as i32 - percent as i32).abs() <= 1,
                "percent {percent} -> value {value} -> rounded {rounded}"
            );
        }
    }

    #[test]
    fn enumerates_local_monitors_readonly() {
        let statuses = super::run_monitor_operation(super::MonitorOperation::Read).expect("枚举显示器失败");
        assert!(!statuses.is_empty());
        for (position, status) in statuses.iter().enumerate() {
            assert_eq!(status.index, position);
            assert!(!status.name.is_empty());
            if let Some(current) = status.current {
                assert!(current <= 100);
            }
        }
    }
}
