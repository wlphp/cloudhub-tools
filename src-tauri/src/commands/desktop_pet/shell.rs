//! 桌宠受控 CMD 执行器：AI 只能提议命令，本地校验 + 用户确认后由桌宠窗口触发执行。
//! 执行固定为"单条命令"：禁止命令链、管道与重定向；高危命令黑名单直接拒绝。
use serde::Serialize;
use std::io::Write;
use std::time::{Duration, Instant};

const MAX_COMMAND_CHARS: usize = 300;
const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_OUTPUT_CHARS: usize = 8_192;

/// 高危命令黑名单：破坏性系统操作、引导/服务/账户修改、脚本执行逃逸与下载器。
/// 采用保守子串匹配（大小写不敏感），宁可误拦也不放行；需要时由用户手动执行。
const BLOCKED_TOKENS: &[&str] = &[
    "format", "diskpart", "cipher", "bcdedit", "vssadmin", "mountvol", "shutdown", "logoff",
    "reg delete", "reg add", "regedit", "regsvr32", "rundll32", "wmic", "powershell", "pwsh",
    "iex", "invoke-expression", "invoke-webrequest", "invoke-restmethod", "start-process",
    "mshta", "certutil", "bitsadmin", "curl", "wget", "ftp", "tftp", "psexec", "schtasks",
    "net user", "net localgroup", "net stop", "sc delete", "sc config", "sc stop",
    "takeown", "icacls", "cacls", "del /s", "rd /s", "rmdir /s", "deltree",
    "taskkill /f", "tskill", "wevtutil cl",
];

/// 校验并规范用户（经 AI 提议、弹窗确认）的命令：返回 trim 后的命令或拒绝原因。
pub fn validate(command: &str) -> Result<&str, String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("电脑指令为空".into());
    }
    if trimmed.chars().count() > MAX_COMMAND_CHARS {
        return Err("电脑指令过长，请缩短到 300 字符内".into());
    }
    if trimmed
        .chars()
        .any(|character| matches!(character, '\n' | '\r' | '&' | '|' | '>' | '<' | '`' | '^' | '%'))
    {
        return Err("仅允许单条命令：不能包含命令链、管道、重定向或换行".into());
    }
    let lowered = trimmed.to_lowercase();
    if let Some(token) = BLOCKED_TOKENS.iter().find(|token| lowered.contains(&token[..])) {
        return Err(format!("已拒绝高危命令（{token}），如确需执行请手动操作"));
    }
    Ok(trimmed)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellResult {
    pub output: String,
    pub exit_code: i32,
    pub timed_out: bool,
    pub duration_ms: u64,
}

pub fn run(command: &str) -> Result<ShellResult, String> {
    #[cfg(target_os = "windows")]
    {
        execute_windows(command)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = command;
        Err("电脑指令目前仅支持 Windows 桌面端".into())
    }
}

/// 输出写入临时文件而非管道： grandchildren 继承管道句柄会让读取线程悬挂，文件则随 cmd 退出即完成。
#[cfg(target_os = "windows")]
fn execute_windows(command: &str) -> Result<ShellResult, String> {
    use std::{os::windows::process::CommandExt, path::PathBuf, process::{Command, Stdio}};
    let command = validate(command)?;
    let root = PathBuf::from(std::env::var_os("SystemRoot").ok_or("无法找到 Windows 系统目录")?);
    let temp = std::env::temp_dir().join(format!(
        "cloudhub-pet-shell-{}-{}.out",
        std::process::id(),
        Instant::now().elapsed().as_nanos()
    ));
    // 外壳前缀自拼：切 UTF-8 代码页保证中文输出可读；命令本体已验证不含 & 与重定向字符。
    let script = format!("chcp 65001>nul & {command} >\"{}\" 2>&1", temp.display());
    let mut command_line = Command::new(root.join("System32").join("cmd.exe"));
    command_line
        .raw_arg("/d")
        .raw_arg("/c")
        .raw_arg(script);
    command_line
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Ok(profile) = std::env::var("USERPROFILE") {
        command_line.current_dir(profile);
    }
    let started = Instant::now();
    let mut child = command_line.spawn().map_err(|_| "无法启动命令解释器".to_string())?;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(_) => break None,
        }
        if started.elapsed() >= TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            timed_out = true;
            break None;
        }
        std::thread::sleep(Duration::from_millis(60));
    };
    let output_bytes = std::fs::read(&temp).unwrap_or_default();
    let _ = std::fs::remove_file(&temp);
    let exit_code = status.and_then(|status| status.code()).unwrap_or(-1);
    let text: String = String::from_utf8_lossy(&output_bytes)
        .chars()
        .take(MAX_OUTPUT_CHARS)
        .collect();
    let duration_ms = started.elapsed().as_millis() as u64;
    log_event(
        command,
        &format!("exit={exit_code} timed_out={timed_out} ms={duration_ms} output_chars={}", text.chars().count()),
    );
    Ok(ShellResult { output: text, exit_code, timed_out, duration_ms })
}

/// 审计日志：记录命令、退出码、耗时与输出规模；不记录输出内容，避免日志携带敏感数据。
#[cfg(target_os = "windows")]
fn log_event(command: &str, summary: &str) {
    let Ok(dir) = crate::core::paths::data_dir() else { return };
    let path = dir.join("pet-shell.log");
    let open = || std::fs::OpenOptions::new().append(true).create(true).open(&path);
    let mut file = match open() {
        Ok(file) => file,
        Err(_) => return,
    };
    if file.metadata().map(|meta| meta.len() > 256 * 1024).unwrap_or(false) {
        drop(file);
        let _ = std::fs::remove_file(&path);
        file = match open() {
            Ok(file) => file,
            Err(_) => return,
        };
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let _ = writeln!(file, "[{stamp}] command={command} {summary}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_rejects_chains_redirects_and_blocked_programs() {
        assert!(validate("").is_err());
        assert!(validate("   ").is_err());
        assert!(validate("dir & del x").is_err());
        assert!(validate("ipconfig | findstr IP").is_err());
        assert!(validate("dir > out.txt").is_err());
        assert!(validate("dir < in.txt").is_err());
        assert!(validate("echo a%PATH%b").is_err());
        assert!(validate("format c:").is_err());
        assert!(validate("FORMAT C:").is_err());
        assert!(validate("powershell -c iex").is_err());
        assert!(validate("shutdown /s").is_err());
        assert!(validate("reg delete HKLM\\Software").is_err());
        assert!(validate("del /s /q C:\\data").is_err());
        assert!(validate("taskkill /f /im explorer.exe").is_err());
        assert!(validate(&"dir ".repeat(400)).is_err());
        assert_eq!(validate("ipconfig /all").unwrap(), "ipconfig /all");
        assert_eq!(validate("  systeminfo  ").unwrap(), "systeminfo");
        assert_eq!(validate("git status").unwrap(), "git status");
        assert_eq!(validate("tasklist").unwrap(), "tasklist");
    }
}
