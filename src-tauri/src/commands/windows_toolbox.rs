//! Safe, fixed-target shortcuts for common Windows settings and maintenance.
use crate::core::error::PlatformResult;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const CREDSSP_REG_KEY: &str = r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System\CredSSP\Parameters";
const CREDSSP_VALUE_NAME: &str = "AllowEncryptionOracle";
const EXPLORER_ADVANCED_REG_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExplorerPreferences {
    show_file_extensions: bool,
    show_hidden_files: bool,
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
fn explorer_preferences() -> Result<ExplorerPreferences, String> {
    let hide_file_ext = read_explorer_dword("HideFileExt")?.unwrap_or(1);
    let hidden = read_explorer_dword("Hidden")?.unwrap_or(2);
    if hide_file_ext > 1 || !(1..=2).contains(&hidden) {
        return Err("Windows 文件资源管理器设置值超出支持范围；请先通过 Windows 设置检查。".into());
    }
    Ok(ExplorerPreferences {
        show_file_extensions: hide_file_ext == 0,
        show_hidden_files: hidden == 1,
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
    let section: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced\0"
        .encode_utf16()
        .collect();
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
    let (name, value) = match setting.as_str() {
        "file-extensions" => ("HideFileExt", if enabled { 0 } else { 1 }),
        "hidden-files" => ("Hidden", if enabled { 1 } else { 2 }),
        _ => return Err("不支持的文件资源管理器显示设置。".into()),
    };
    let windows_dir = std::env::var_os("SystemRoot").map(PathBuf::from)
        .ok_or_else(|| "无法定位 Windows 系统目录；设置未更改。".to_string())?;
    let status = Command::new(windows_dir.join("System32").join("reg.exe"))
        .args(["add", EXPLORER_ADVANCED_REG_KEY, "/v", name, "/t", "REG_DWORD", "/d"])
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
