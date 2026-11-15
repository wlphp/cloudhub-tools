//! 软件商店应用的 Windows 桌面快捷方式：创建带 `--open-app=` 直达参数的 .lnk，并处理单实例二次启动的聚焦与直达转发。
use crate::core::error::PlatformResult;

/// 直达参数前缀；创建 .lnk、主窗口启动直达与单实例转发共用同一格式。
const OPEN_APP_ARG_PREFIX: &str = "--open-app=";

/// 应用标识仅允许 `cloudhub.` 前缀加小写字母、数字与连字符，杜绝任意字符串进入启动参数。
fn is_valid_plugin_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("cloudhub.") else { return false; };
    !rest.is_empty() && rest.len() <= 64 && rest.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// 从启动参数中取出首个格式合法的 `--open-app=` 值；非法或缺失一律忽略，保持默认打开行为。
pub(crate) fn parse_open_app_arg(argv: &[String]) -> Option<String> {
    argv.iter().find_map(|argument| argument.strip_prefix(OPEN_APP_ARG_PREFIX)).filter(|id| is_valid_plugin_id(id)).map(str::to_owned)
}

/// 主进程自身的启动参数（用于首次启动直达）。
pub(crate) fn open_app_from_launch_args() -> Option<String> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    parse_open_app_arg(&argv)
}

/// 清洗应用显示名称用于文件名：过滤文件系统非法字符与控制字符，空结果视为无效。
fn sanitize_shortcut_name(raw: &str) -> Option<String> {
    let cleaned: String = raw.chars().filter(|character| !matches!(character, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') && !character.is_control()).collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() { return None; }
    Some(trimmed.chars().take(40).collect())
}

#[tauri::command]
pub fn desktop_shortcut_create(plugin_id: String, app_name: String) -> PlatformResult<String> {
    if !is_valid_plugin_id(&plugin_id) { return Err("应用标识无效，无法创建桌面快捷方式。".into()); }
    let Some(name) = sanitize_shortcut_name(&app_name) else { return Err("应用名称无效，无法创建桌面快捷方式。".into()); };
    #[cfg(target_os = "windows")]
    { create_windows_shortcut(&plugin_id, &name) }
    #[cfg(not(target_os = "windows"))]
    { let _ = (&plugin_id, &name); Err("桌面快捷方式目前仅支持 Windows 桌面端。".into()) }
}

/// 单实例回调：第二个实例启动时在首个实例内执行——聚焦主窗口，并转发合法的直达参数给前端。
pub(crate) fn handle_second_instance(app: &tauri::AppHandle, argv: Vec<String>) {
    use tauri::{Emitter, Manager};
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
    if let Some(plugin_id) = parse_open_app_arg(&argv) {
        let _ = app.emit_to("main", "cloudhub-open-app", plugin_id);
    }
}

#[cfg(target_os = "windows")]
fn create_windows_shortcut(plugin_id: &str, app_name: &str) -> PlatformResult<String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
try {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($env:CLOUDHUB_SHORTCUT_PATH)
  $shortcut.TargetPath = $env:CLOUDHUB_SHORTCUT_TARGET
  $shortcut.Arguments = $env:CLOUDHUB_SHORTCUT_ARGS
  $shortcut.WorkingDirectory = $env:CLOUDHUB_SHORTCUT_DIR
  $shortcut.IconLocation = $env:CLOUDHUB_SHORTCUT_ICON
  $shortcut.Description = $env:CLOUDHUB_SHORTCUT_DESC
  $shortcut.Save()
  exit 0
} catch {
  exit 1
}
"#;

    let target = std::env::current_exe().map_err(|_| "无法定位云枢工具箱主程序，未创建快捷方式。".to_string())?;
    if !target.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("exe")) {
        return Err("主程序不是可执行文件，未创建桌面快捷方式。".into());
    }
    let directory = dirs::desktop_dir().ok_or("无法定位桌面目录，未创建快捷方式。".to_string())?;
    let path = directory.join(format!("{app_name}.lnk"));
    let output = Command::new("powershell.exe")
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-Command", SCRIPT])
        .env("CLOUDHUB_SHORTCUT_PATH", &path)
        .env("CLOUDHUB_SHORTCUT_TARGET", &target)
        .env("CLOUDHUB_SHORTCUT_ARGS", format!("{OPEN_APP_ARG_PREFIX}{plugin_id}"))
        .env("CLOUDHUB_SHORTCUT_DIR", target.parent().unwrap_or(directory.as_path()))
        .env("CLOUDHUB_SHORTCUT_ICON", format!("{},0", target.display()))
        .env("CLOUDHUB_SHORTCUT_DESC", format!("云枢工具箱 · {app_name}"))
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|_| "无法启动 Windows 快捷方式创建接口。".to_string())?;
    if !output.status.success() {
        let detail: String = String::from_utf8_lossy(&output.stderr).trim().chars().take(200).collect();
        return Err(if detail.is_empty() { "创建桌面快捷方式失败，请重试。".to_string() } else { format!("创建桌面快捷方式失败：{detail}") }.into());
    }
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::{is_valid_plugin_id, parse_open_app_arg, sanitize_shortcut_name};

    #[test]
    fn accepts_well_formed_plugin_ids() {
        assert!(is_valid_plugin_id("cloudhub.hardware-info"));
        assert!(is_valid_plugin_id("cloudhub.model-suppliers"));
        assert!(is_valid_plugin_id("cloudhub.a1-2"));
    }

    #[test]
    fn rejects_malformed_plugin_ids() {
        assert!(!is_valid_plugin_id("notepad"));
        assert!(!is_valid_plugin_id("cloudhub."));
        assert!(!is_valid_plugin_id("cloudhub.Hardware"));
        assert!(!is_valid_plugin_id("cloudhub.a b"));
        assert!(!is_valid_plugin_id("cloudhub.a;b"));
        assert!(!is_valid_plugin_id("cloudhub.x/y"));
    }

    #[test]
    fn parses_direct_open_argument_only() {
        let argv = vec!["--open-app=cloudhub.notes".to_string(), "extra".to_string()];
        assert_eq!(parse_open_app_arg(&argv).as_deref(), Some("cloudhub.notes"));
    }

    #[test]
    fn ignores_invalid_or_missing_arguments() {
        assert_eq!(parse_open_app_arg(&[]), None);
        assert_eq!(parse_open_app_arg(&["--open-app=evil".to_string()]), None);
        assert_eq!(parse_open_app_arg(&["--open-app".to_string()]), None);
        assert_eq!(parse_open_app_arg(&["--browser-authenticator".to_string()]), None);
    }

    #[test]
    fn sanitizes_shortcut_names() {
        assert_eq!(sanitize_shortcut_name(" 电脑信息 ").as_deref(), Some("电脑信息"));
        assert_eq!(sanitize_shortcut_name("a:b/c|d?e").as_deref(), Some("abcde"));
        assert_eq!(sanitize_shortcut_name(" <>:\"/\\|?* "), None);
    }
}
