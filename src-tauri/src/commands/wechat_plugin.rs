//! CloudHub 官方内置插件：启动用户已安装的微信；账号配置管理见 wechat_sessions。
use crate::core::error::{PlatformError, PlatformResult};
use serde::Serialize;

pub(super) fn plugin_error(message: &'static str) -> PlatformError {
    PlatformError {
        kind: "platform-error",
        code: "local-plugin",
        message: message.into(),
        retryable: false,
    }
}

fn validate_count(count: u8) -> PlatformResult<()> {
    if !(2..=5).contains(&count) {
        return Err(plugin_error("请选择 2～5 个启动窗口"));
    }
    Ok(())
}

fn is_wechat_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("Weixin.exe") || name.eq_ignore_ascii_case("WeChat.exe")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WechatStatus {
    supported: bool,
    detected_path: Option<String>,
    running_processes: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LaunchResult {
    requested: u8,
    started: usize,
    failed: usize,
}

#[cfg(windows)]
pub(super) mod windows {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::{
        path::{Component, Path, PathBuf},
        process::{Command, Stdio},
        sync::{Barrier, Mutex},
    };

    pub(crate) static LAUNCH_LOCK: Mutex<()> = Mutex::new(());

    pub(crate) fn validate_path(value: &str) -> PlatformResult<PathBuf> {
        let path = Path::new(value);
        // 只接受本地盘上的绝对路径，避免 UNC、设备路径及附带命令参数。
        let bytes = value.as_bytes();
        if bytes.len() < 4
            || !bytes[0].is_ascii_alphabetic()
            || bytes[1] != b':'
            || !matches!(bytes[2], b'\\' | b'/')
            || value.chars().any(char::is_control)
            || !path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(is_wechat_name)
        {
            return Err(plugin_error("请选择本地安装的 Weixin.exe 或 WeChat.exe"));
        }
        let resolved = path
            .canonicalize()
            .map_err(|_| plugin_error("微信客户端路径不可用，请重新选择"))?;
        if !matches!(resolved.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)))
            || !resolved.is_file()
            || !resolved
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(is_wechat_name)
        {
            return Err(plugin_error("请选择本地安装的 Weixin.exe 或 WeChat.exe"));
        }
        Ok(resolved)
    }

    fn system_tool(name: &str) -> PlatformResult<PathBuf> {
        let root = std::env::var_os("SystemRoot")
            .ok_or_else(|| plugin_error("无法检查微信进程，请稍后重试"))?;
        Ok(PathBuf::from(root).join("System32").join(name))
    }

    pub(crate) fn running_processes() -> PlatformResult<usize> {
        Ok(process_ids()?.len())
    }

    pub(crate) fn process_ids() -> PlatformResult<std::collections::HashSet<u32>> {
        let output = Command::new(system_tool("tasklist.exe")?)
            .args(["/FO", "CSV", "/NH"])
            .creation_flags(0x08000000)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map_err(|_| plugin_error("无法检查微信进程，请稍后重试"))?;
        if !output.status.success() {
            return Err(plugin_error("无法检查微信进程，请稍后重试"));
        }
        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                let mut fields = line.split(',');
                if !fields
                    .next()
                    .is_some_and(|name| is_wechat_name(name.trim_matches('"')))
                {
                    return None;
                }
                fields.next()?.trim_matches('"').parse().ok()
            })
            .collect())
    }

    pub(super) fn detect() -> Option<String> {
        let mut candidates = Vec::new();
        for key in [
            r"HKCU\Software\Tencent\Weixin",
            r"HKCU\Software\Tencent\WeChat",
            r"HKLM\SOFTWARE\Tencent\Weixin",
            r"HKLM\SOFTWARE\Tencent\WeChat",
            r"HKLM\SOFTWARE\WOW6432Node\Tencent\Weixin",
            r"HKLM\SOFTWARE\WOW6432Node\Tencent\WeChat",
        ] {
            if let Ok(output) = Command::new(system_tool("reg.exe").ok()?)
                .args(["query", key, "/v", "InstallPath"])
                .creation_flags(0x08000000)
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output()
            {
                if output.status.success() {
                    for line in String::from_utf8_lossy(&output.stdout).lines() {
                        if let Some((_, value)) = line.split_once("REG_SZ") {
                            let root = PathBuf::from(value.trim().trim_matches('"'));
                            candidates.push(root.join("Weixin.exe"));
                            candidates.push(root.join("WeChat.exe"));
                        }
                    }
                }
            }
        }
        for variable in [
            "ProgramW6432",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "LOCALAPPDATA",
        ] {
            if let Some(root) = std::env::var_os(variable) {
                for suffix in [
                    r"Tencent\Weixin\Weixin.exe",
                    r"Tencent\WeChat\WeChat.exe",
                    r"Programs\Tencent\Weixin\Weixin.exe",
                ] {
                    candidates.push(PathBuf::from(&root).join(suffix));
                }
            }
        }
        candidates.into_iter().find_map(|p| {
            let value = p.to_str()?;
            validate_path(value).ok().map(|_| value.to_owned())
        })
    }

    pub(super) fn launch(path: String, count: u8) -> PlatformResult<LaunchResult> {
        validate_count(count)?;
        let _guard = LAUNCH_LOCK
            .try_lock()
            .map_err(|_| plugin_error("微信启动任务正在执行，请稍后重试"))?;
        let executable = validate_path(&path)?;
        if running_processes()? > 0 {
            return Err(plugin_error("请先从微信托盘菜单退出所有微信，再批量启动"));
        }
        let barrier = Barrier::new(count as usize);
        let started = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..count)
                .map(|_| {
                    let executable = &executable;
                    let barrier = &barrier;
                    scope.spawn(move || {
                        barrier.wait();
                        Command::new(executable)
                            .current_dir(executable.parent().unwrap())
                            .stdin(Stdio::null())
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .spawn()
                            .is_ok()
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap_or(false))
                .filter(|started| *started)
                .count()
        });
        // 这里只统计系统接受的启动请求；客户端可能自行合并窗口。
        Ok(LaunchResult {
            requested: count,
            started,
            failed: count as usize - started,
        })
    }
}

#[tauri::command]
pub(crate) async fn wechat_plugin_status() -> PlatformResult<WechatStatus> {
    #[cfg(windows)]
    {
        return tauri::async_runtime::spawn_blocking(|| {
            Ok(WechatStatus {
                supported: true,
                detected_path: windows::detect(),
                running_processes: windows::running_processes()?,
            })
        })
        .await
        .map_err(|_| plugin_error("读取微信状态失败，请重试"))?;
    }
    #[cfg(not(windows))]
    {
        Ok(WechatStatus {
            supported: false,
            detected_path: None,
            running_processes: 0,
        })
    }
}

#[tauri::command]
pub(crate) async fn wechat_plugin_select(app: tauri::AppHandle) -> PlatformResult<Option<String>> {
    #[cfg(windows)]
    {
        return tauri::async_runtime::spawn_blocking(move || {
            use tauri_plugin_dialog::DialogExt;
            let Some(file) = app
                .dialog()
                .file()
                .set_title("选择已安装的微信客户端")
                .add_filter("微信客户端", &["exe"])
                .blocking_pick_file()
            else {
                return Ok(None);
            };
            let path = file
                .into_path()
                .map_err(|_| plugin_error("微信客户端路径不可用，请重新选择"))?;
            let value = path
                .to_str()
                .ok_or_else(|| plugin_error("微信客户端路径不可用，请重新选择"))?;
            windows::validate_path(value)?;
            Ok(Some(value.to_owned()))
        })
        .await
        .map_err(|_| plugin_error("选择微信客户端失败，请重试"))?;
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err(plugin_error("微信多开插件仅支持 Windows 桌面端"))
    }
}

#[tauri::command]
pub(crate) async fn wechat_plugin_launch(path: String, count: u8) -> PlatformResult<LaunchResult> {
    validate_count(count)?;
    #[cfg(windows)]
    {
        return tauri::async_runtime::spawn_blocking(move || windows::launch(path, count))
            .await
            .map_err(|_| plugin_error("启动微信任务失败，请重试"))?;
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err(plugin_error("微信多开插件仅支持 Windows 桌面端"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    #[ignore = "需要已安装微信并会打开两个客户端，仅手动运行"]
    fn launch_installed_client_manually() {
        let path = windows::detect().expect("未检测到微信客户端");
        let result = windows::launch(path, 2).expect("请先手动退出所有微信");
        assert_eq!(result.started, 2);
        assert_eq!(result.failed, 0);
        println!("已提交两个启动请求，请检查实际微信登录窗口数量");
    }
    #[test]
    fn restrict_launch_count_and_client_names() {
        for count in [0, 1, 6, 255] {
            assert!(validate_count(count).is_err());
        }
        for count in 2..=5 {
            assert!(validate_count(count).is_ok());
        }
        assert!(is_wechat_name("WEIXIN.EXE"));
        assert!(is_wechat_name("WeChat.exe"));
        for name in ["cmd.exe", "WeChat.exe --foo", "WeChat.exe.bat"] {
            assert!(!is_wechat_name(name));
        }
    }
    #[cfg(windows)]
    #[test]
    fn rejects_busy_launch_without_starting_a_process() {
        let _guard = windows::LAUNCH_LOCK.lock().unwrap();
        let error = windows::launch(String::new(), 2).err().unwrap();
        assert_eq!(error.message, "微信启动任务正在执行，请稍后重试");
    }
    #[cfg(windows)]
    #[test]
    fn reject_network_relative_device_and_argument_paths() {
        for path in [
            r"\\server\share\Weixin.exe",
            r"\\?\C:\Weixin.exe",
            r"C:Weixin.exe",
            r"WeChat.exe",
            r"C:\WeChat.exe --foo",
            r"C:\Windows\cmd.exe",
            "C:\\WeChat.exe\n",
        ] {
            assert!(windows::validate_path(path).is_err());
        }
    }
}
