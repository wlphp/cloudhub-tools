use std::{
    path::{Path, PathBuf},
    process::{Child, Command},
};

/// Store package discovery is metadata-only; it does not read any user's app data.
pub fn installed() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let output=Command::new("powershell.exe").args(["-NoLogo","-NoProfile","-NonInteractive","-Command","Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty InstallLocation"]).creation_flags(0x08000000).output().ok()?;
        if !output.status.success() || output.stdout.len() > 4096 {
            return None;
        }
        let root = PathBuf::from(std::str::from_utf8(&output.stdout).ok()?.trim());
        let name = root.file_name()?.to_str()?;
        if !root.is_absolute()
            || !name.starts_with("OpenAI.Codex_")
            || !name.ends_with("__2p2nqsd0c76g0")
        {
            return None;
        }
        let app = root.join("app");
        let exe = app.join("ChatGPT.exe");
        if exe.is_file() && app.join("resources/owl-app.ini").is_file() {
            return Some(exe);
        }
    }
    #[cfg(target_os = "macos")]
    {
        let app = PathBuf::from("/Applications/Codex.app/Contents/MacOS/Codex");
        if app.is_file() {
            return Some(app);
        }
    }
    None
}

fn command(executable: &Path, home: &Path, desktop_data: &Path, workspace: &Path) -> Command {
    let mut command = Command::new(executable);
    command
        .env("CODEX_HOME", home)
        .env("CODEX_ELECTRON_USER_DATA_PATH", desktop_data)
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY")
        .env_remove("CODEX_ACCESS_TOKEN")
        .arg(format!(
            "--user-data-dir={}",
            desktop_data.to_string_lossy()
        ))
        .current_dir(workspace);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
}

pub fn launch(home: &Path, workspace: &Path, proxy:Option<&str>) -> Result<Child, String> {
    let executable = installed().ok_or("未检测到支持隔离启动的 Codex 桌面客户端")?;
    let desktop_data = home.join("desktop-data");
    if desktop_data.exists() {
        let meta =
            std::fs::symlink_metadata(&desktop_data).map_err(|_| "检查 Codex 窗口数据目录失败")?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err("Codex 窗口数据目录类型无效".into());
        }
    } else {
        std::fs::create_dir(&desktop_data).map_err(|_| "创建 Codex 窗口数据目录失败")?;
    }
    super::profile::private_permissions(&desktop_data, true)?;
    let mut command=command(&executable, home, &desktop_data, workspace);
    super::account_controls::apply_proxy(&mut command,proxy)?;
    command.spawn()
        .map_err(|_| "启动独立 Codex 桌面实例失败".into())
}

fn default_command(executable: &Path, home: &Path) -> Command {
    let mut command = Command::new(executable);
    command
        .env("CODEX_HOME", home)
        .env_remove("CODEX_ELECTRON_USER_DATA_PATH")
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY")
        .env_remove("CODEX_ACCESS_TOKEN")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    command
}

pub fn launch_default() -> Result<(), String> {
    let executable = installed().ok_or("未检测到 Codex 桌面客户端，请先安装")?;
    let home = super::profile::default_home()?;
    // The default client belongs to the user and must outlive this management app.
    // Do not place it in a managed-instance job or replace its auth/configuration.
    default_command(&executable, &home)
        .spawn()
        .map_err(|_| "打开默认 Codex 桌面客户端失败")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_launch_does_not_inherit_an_isolated_window_or_api_credentials() {
        let home = std::env::temp_dir().join("fixture default home");
        let command = default_command(Path::new("fixture.exe"), &home);
        assert_eq!(command.get_args().count(), 0);
        let env: Vec<_> = command.get_envs().collect();
        assert!(env.iter().any(
            |(key, value)| *key == "CODEX_HOME" && value.is_some_and(|v| v == home.as_os_str())
        ));
        for removed in [
            "CODEX_ELECTRON_USER_DATA_PATH",
            "OPENAI_API_KEY",
            "CODEX_API_KEY",
            "CODEX_ACCESS_TOKEN",
        ] {
            assert!(env
                .iter()
                .any(|(key, value)| *key == removed && value.is_none()));
        }
    }
    #[test]
    fn desktop_launch_has_separate_auth_and_window_storage_without_shell_interpolation() {
        let home = std::env::temp_dir().join("fixture home");
        let data = home.join("desktop-data");
        let command = command(Path::new("fixture.exe"), &home, &data, &home);
        let args: Vec<_> = command
            .get_args()
            .map(|v| v.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec![format!("--user-data-dir={}", data.to_string_lossy())]
        );
        let env: Vec<_> = command.get_envs().collect();
        assert!(env.iter().any(|(key, value)| *key == "CODEX_HOME"
            && value.is_some_and(|value| value == home.as_os_str())));
        assert!(env
            .iter()
            .any(|(key, value)| *key == "CODEX_ELECTRON_USER_DATA_PATH"
                && value.is_some_and(|value| value == data.as_os_str())));
        assert!(env
            .iter()
            .any(|(key, value)| *key == "OPENAI_API_KEY" && value.is_none()));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "opens two empty isolated Codex desktop windows; requires the installed Store app"]
    fn windows_desktop_windows_are_isolated_and_stopping_one_keeps_the_other() {
        use super::super::{process::OwnedJob, profile::TemporaryProfile};
        use std::{
            process::Stdio,
            time::{Duration, Instant},
        };

        struct WindowCheck {
            pid: u32,
            found: bool,
        }
        #[repr(C)]
        struct Rect {
            left: i32,
            top: i32,
            right: i32,
            bottom: i32,
        }
        #[link(name = "user32")]
        unsafe extern "system" {
            fn EnumWindows(
                callback: unsafe extern "system" fn(isize, isize) -> i32,
                data: isize,
            ) -> i32;
            fn GetWindowThreadProcessId(window: isize, process: *mut u32) -> u32;
            fn IsWindowVisible(window: isize) -> i32;
            fn GetClientRect(window: isize, rect: *mut Rect) -> i32;
            fn GetWindow(window: isize, relation: u32) -> isize;
        }
        unsafe extern "system" fn check_window(window: isize, data: isize) -> i32 {
            let check = unsafe { &mut *(data as *mut WindowCheck) };
            let mut pid = 0;
            unsafe {
                GetWindowThreadProcessId(window, &mut pid);
            }
            let mut rect = Rect {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            if pid == check.pid
                && unsafe { IsWindowVisible(window) } != 0
                && unsafe { GetWindow(window, 4) } == 0
                && unsafe { GetClientRect(window, &mut rect) } != 0
                && rect.right - rect.left >= 640
                && rect.bottom - rect.top >= 400
            {
                check.found = true;
                return 0;
            }
            1
        }
        fn visible_window(pid: u32) -> bool {
            let mut check = WindowCheck { pid, found: false };
            unsafe {
                EnumWindows(check_window, &mut check as *mut _ as isize);
            }
            check.found
        }
        struct OwnedDesktop {
            child: Child,
            job: OwnedJob,
        }
        impl OwnedDesktop {
            fn start(home: &Path) -> Self {
                let app = installed().expect("official Codex desktop must be installed");
                let data = home.join("desktop-data");
                std::fs::create_dir(&data).unwrap();
                super::super::profile::private_permissions(&data, true).unwrap();
                let mut child = command(&app, home, &data, home)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap();
                let job = OwnedJob::attach(&child).unwrap_or_else(|error| {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("{error}");
                });
                Self { child, job }
            }
            fn stop(&mut self) {
                self.job.terminate();
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
        }
        impl Drop for OwnedDesktop {
            fn drop(&mut self) {
                self.stop();
            }
        }

        let first_profile = TemporaryProfile::new("{}").unwrap();
        let second_profile = TemporaryProfile::new("{}").unwrap();
        assert_ne!(first_profile.path, second_profile.path);
        let mut first = OwnedDesktop::start(&first_profile.path);
        let mut second = OwnedDesktop::start(&second_profile.path);
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(
                first.child.try_wait().unwrap().is_none(),
                "first isolated desktop exited during startup"
            );
            assert!(
                second.child.try_wait().unwrap().is_none(),
                "second isolated desktop exited during startup"
            );
            if visible_window(first.child.id()) && visible_window(second.child.id()) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "both isolated desktop windows must become visible"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
        // Both applications must create their own Electron storage, not just hold a process open.
        for home in [&first_profile.path, &second_profile.path] {
            assert!(home.join("desktop-data").is_dir());
            assert!(
                std::fs::read_dir(home.join("desktop-data"))
                    .unwrap()
                    .next()
                    .is_some(),
                "the desktop must populate its own window-data directory"
            );
            assert_eq!(
                super::super::profile::read_auth(&home.join("auth.json"))
                    .unwrap()
                    .as_str(),
                "{}"
            );
        }
        std::thread::sleep(Duration::from_secs(2));
        first.stop();
        assert!(
            !visible_window(first.child.id()),
            "stopped desktop window must be gone"
        );
        assert!(
            second.child.try_wait().unwrap().is_none(),
            "stopping first desktop must preserve the second"
        );
        assert!(
            visible_window(second.child.id()),
            "the second desktop window must remain visible"
        );
        second.stop();
        assert!(!visible_window(second.child.id()));
    }
}
