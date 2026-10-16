use serde::Deserialize;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ComputerAction { Shutdown, Restart, TaskManager, Lock, Explorer }

impl ComputerAction {
    fn command(self) -> (&'static str, &'static [&'static str]) {
        match self {
            Self::Shutdown => ("shutdown.exe", &["/s", "/t", "0"]),
            Self::Restart => ("shutdown.exe", &["/r", "/t", "0"]),
            Self::TaskManager => ("Taskmgr.exe", &[]),
            Self::Lock => ("rundll32.exe", &["user32.dll,LockWorkStation"]),
            Self::Explorer => ("explorer.exe", &[]),
        }
    }
}

pub fn run(action: ComputerAction) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::{os::windows::process::CommandExt, path::PathBuf, process::{Command, Stdio}};
        let root = PathBuf::from(std::env::var_os("SystemRoot").ok_or("无法找到 Windows 系统目录")?);
        let (name, args) = action.command();
        let executable = if action == ComputerAction::Explorer { root.join(name) } else { root.join("System32").join(name) };
        let mut command = Command::new(executable);
        command.args(args).creation_flags(0x08000000).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        if matches!(action, ComputerAction::TaskManager | ComputerAction::Explorer) {
            let mut child = command.spawn().map_err(|_| "无法打开系统工具")?;
            std::thread::spawn(move || { let _ = child.wait(); });
        } else if !command.status().map_err(|_| "无法执行电脑操作")?.success() {
            return Err("系统未能执行此操作，请检查当前用户权限".into());
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = action; Err("电脑快捷操作目前仅支持 Windows 桌面端".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actions_are_fixed_and_do_not_force_close_applications() {
        for action in [ComputerAction::Shutdown,ComputerAction::Restart,ComputerAction::TaskManager,ComputerAction::Lock,ComputerAction::Explorer] {
            let (program,args)=action.command();
            assert!(program.ends_with(".exe"));
            assert!(!args.contains(&"/f"));
        }
        assert_eq!(ComputerAction::Shutdown.command(),("shutdown.exe", &["/s","/t","0"][..]));
        assert_eq!(ComputerAction::Restart.command(),("shutdown.exe", &["/r","/t","0"][..]));
        assert!(serde_json::from_str::<ComputerAction>("\"cmd.exe\"").is_err());
        assert!(serde_json::from_str::<ComputerAction>("\"shutdown /f\"").is_err());
    }
}
