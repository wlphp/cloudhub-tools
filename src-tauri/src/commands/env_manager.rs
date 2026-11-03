//! Windows environment variable manager. Values are intentionally returned to
//! the local UI in plaintext because this feature is an explicit system editor.
use crate::core::error::PlatformResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnvironmentVariable {
    name: String,
    value: String,
    scope: String,
    value_kind: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnvironmentSnapshot {
    is_admin: bool,
    variables: Vec<EnvironmentVariable>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnvironmentWrite {
    name: String,
    value: String,
    scope: String,
    value_kind: String,
    delete: bool,
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name.len() > 1024 || name.contains('=') || name.contains('\0') {
        return Err("变量名称不能为空，且不能包含等号或空字符。".into());
    }
    Ok(())
}

#[cfg(windows)]
fn powershell(script: &str, input: Option<&str>) -> Result<String, String> {
    use std::{io::Write, os::windows::process::CommandExt, process::{Command, Stdio}};
    let mut child = Command::new("powershell.exe")
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
        .creation_flags(0x08000000)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn().map_err(|_| "无法启动 Windows 环境变量管理器。请检查 PowerShell 是否可用。".to_string())?;
    if let Some(input) = input {
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(input.as_bytes()).map_err(|_| "无法提交环境变量修改请求。".to_string())?;
        }
    }
    let output = child.wait_with_output().map_err(|_| "读取环境变量操作结果失败。".to_string())?;
    if !output.status.success() {
        return Err("环境变量操作失败。系统变量需要以管理员身份运行；请确认权限后重试。".into());
    }
    String::from_utf8(output.stdout).map_err(|_| "Windows 返回的数据不是有效的 UTF-8；请重启应用后重试。".into())
}

#[cfg(windows)]
#[tauri::command]
pub(crate) fn env_manager_list() -> PlatformResult<EnvironmentSnapshot> {
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$userKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
$machineKey = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment')
$items = @()
foreach ($entry in @(@{Key=$userKey; Scope='user'}, @{Key=$machineKey; Scope='system'})) {
  if ($null -eq $entry.Key) { continue }
  foreach ($name in $entry.Key.GetValueNames()) {
    $kind = $entry.Key.GetValueKind($name).ToString()
    if ($kind -notin @('String','ExpandString')) { continue }
    $value = $entry.Key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $items += [pscustomobject]@{name=$name; value=[string]$value; scope=$entry.Scope; valueKind=$kind}
  }
}
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
$result = [pscustomobject]@{isAdmin=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); variables=@($items | Sort-Object scope,name)}
$result | ConvertTo-Json -Depth 5 -Compress
"#;
    // Windows PowerShell 5.1 otherwise writes redirected stdout using the active
    // console code page. Environment values can contain arbitrary Unicode, so
    // force UTF-8 before emitting JSON for Rust to parse.
    let script = format!("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n{SCRIPT}");
    let output = powershell(&script, None)?;
    Ok(serde_json::from_str(&output).map_err(|error| format!("解析 Windows 环境变量列表失败（JSON 第{}行第{}列）。", error.line(), error.column()))?)
}

#[cfg(windows)]
#[tauri::command]
pub(crate) fn env_manager_write(request: EnvironmentWrite) -> PlatformResult<()> {
    validate_name(&request.name)?;
    if !matches!(request.scope.as_str(), "user" | "system") {
        return Err("变量范围无效。".into());
    }
    if !matches!(request.value_kind.as_str(), "String" | "ExpandString") {
        return Err("变量类型仅支持普通文本和可展开文本。".into());
    }
    if request.value.len() > 32767 || request.value.contains('\0') {
        return Err("变量值超过 Windows 支持的长度或包含无效字符。".into());
    }
    let payload = serde_json::to_string(&request).map_err(|_| "环境变量修改请求无效。".to_string())?;
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$raw = [Console]::In.ReadToEnd()
$item = ConvertFrom-Json -InputObject $raw
if ($item.scope -eq 'user') { $path = 'Environment'; $hive = [Microsoft.Win32.RegistryHive]::CurrentUser }
elseif ($item.scope -eq 'system') { $path = 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment'; $hive = [Microsoft.Win32.RegistryHive]::LocalMachine }
else { throw 'invalid scope' }
$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, [Microsoft.Win32.RegistryView]::Default)
$key = $base.OpenSubKey($path, $true)
if ($null -eq $key) { throw 'access denied' }
if ($item.delete) { $key.DeleteValue($item.name, $false) }
else {
  $kind = if ($item.valueKind -eq 'ExpandString') { [Microsoft.Win32.RegistryValueKind]::ExpandString } else { [Microsoft.Win32.RegistryValueKind]::String }
  $key.SetValue($item.name, [string]$item.value, $kind)
}
$key.Dispose(); $base.Dispose()
[Console]::Write('ok')
"#;
    powershell(SCRIPT, Some(&payload))?;
    #[cfg(windows)]
    unsafe {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE};
        let setting: Vec<u16> = std::ffi::OsStr::new("Environment").encode_wide().chain(Some(0)).collect();
        let mut result = 0usize;
        SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, setting.as_ptr() as isize, SMTO_ABORTIFHUNG, 5000, &mut result);
    }
    Ok(())
}

#[cfg(windows)]
#[tauri::command]
pub(crate) fn env_manager_relaunch_elevated() -> PlatformResult<()> {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    let executable = std::env::current_exe().map_err(|_| "无法定位当前应用程序。".to_string())?;
    let file: Vec<u16> = executable.as_os_str().encode_wide().chain(Some(0)).collect();
    let verb: Vec<u16> = OsStr::new("runas").encode_wide().chain(Some(0)).collect();
    let result = unsafe { ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), 1) };
    if (result as isize) <= 32 { return Err("未能启动管理员窗口；你可以取消授权，或稍后重试。".into()); }
    Ok(())
}

#[cfg(not(windows))]
#[tauri::command]
pub(crate) fn env_manager_list() -> PlatformResult<EnvironmentSnapshot> {
    Err("环境变量管理仅支持 Windows 桌面端。".into())
}

#[cfg(not(windows))]
#[tauri::command]
pub(crate) fn env_manager_write(_request: EnvironmentWrite) -> PlatformResult<()> {
    Err("环境变量管理仅支持 Windows 桌面端。".into())
}

#[cfg(not(windows))]
#[tauri::command]
pub(crate) fn env_manager_relaunch_elevated() -> PlatformResult<()> {
    Err("环境变量管理仅支持 Windows 桌面端。".into())
}

#[cfg(test)]
mod tests {
    use super::validate_name;
    #[test] fn validates_names_without_excluding_common_variable_names() {
        assert!(validate_name("JAVA_HOME").is_ok());
        assert!(validate_name("Path").is_ok());
        assert!(validate_name("").is_err());
        assert!(validate_name("A=B").is_err());
    }
}
