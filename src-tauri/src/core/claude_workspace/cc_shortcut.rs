//! Own only a marked shell block / dedicated batch file; never execute user profiles.
use super::{pref, read, set_pref};
#[cfg(windows)]
use super::write;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

const RECORD: &str = "claude.workbench.cc-shortcut.v1";
const BAT: &str = "@echo off\r\nrem CloudHub Tools managed cc shortcut\r\nclaude --dangerously-skip-permissions %*\r\n";
const BLOCK: &str = "# >>> CloudHub Tools cc >>>\nalias cc='claude --dangerously-skip-permissions'\n# <<< CloudHub Tools cc <<<";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub installed: bool,
    pub recovery_available: bool,
    pub paths: Vec<String>,
}
#[derive(Default, Serialize, Deserialize)]
struct Record {
    path_added: bool,
    // Record exact appended bytes, including any separator newline, for lossless removal.
    additions: Vec<(PathBuf, String, bool)>,
}
fn record() -> Result<Option<Record>, String> {
    pref(RECORD)?.filter(|v| !v.is_empty()).map(|v| serde_json::from_str(&v).map_err(|_| "快捷命令恢复记录无效".into())).transpose()
}
fn save(record: &Record) -> Result<(), String> {
    set_pref(RECORD, &serde_json::to_string(record).map_err(|_| "无法保存快捷命令恢复记录")?)
}
fn store(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    #[cfg(windows)]
    { write(path, bytes, false) }
    #[cfg(not(windows))]
    {
        use std::{io::Write, os::unix::fs::OpenOptionsExt};
        // Shell profiles may contain private environment values. Preserve their permissions.
        let permissions = match fs::symlink_metadata(path) {
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => return Err("不能改写链接或非普通文件".into()),
            Ok(meta) => Some(meta.permissions()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err("无法读取终端配置权限".into()),
        };
        fs::create_dir_all(path.parent().ok_or("终端配置目录无效")?).map_err(|_| "无法创建终端配置目录")?;
        let temporary = path.with_extension(format!("cloudhub-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut file = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temporary).map_err(|_| "无法写入终端配置")?;
            file.write_all(bytes).map_err(|_| "无法写入终端配置")?;
            if let Some(permissions) = permissions { file.set_permissions(permissions).map_err(|_| "无法保留终端配置权限")?; }
            fs::rename(&temporary, path).map_err(|_| "无法保存终端配置")
        })();
        if result.is_err() { let _ = fs::remove_file(&temporary); }
        result.map_err(|error| error.to_owned())
    }
}
fn targets() -> Result<Vec<PathBuf>, String> {
    let home = dirs::home_dir().ok_or("用户目录不可用")?;
    if cfg!(windows) { Ok(vec![home.join(".local/bin/cc.bat")]) }
    else {
        let zsh = std::env::var_os("ZDOTDIR").map(PathBuf::from).unwrap_or_else(|| home.clone());
        if !zsh.is_absolute() { return Err("ZDOTDIR 必须为绝对路径".into()); }
        Ok(vec![home.join(".bashrc"), zsh.join(".zshrc")])
    }
}
pub fn status() -> Result<Status, String> {
    let record = record()?;
    let paths = targets()?;
    let mut installed = paths.iter().all(|path| {
        read(path, 1024 * 1024).ok().flatten().is_some_and(|bytes| {
            if cfg!(windows) { bytes == BAT.as_bytes() }
            else { String::from_utf8_lossy(&bytes).contains(BLOCK) }
        })
    });
    if cfg!(windows) && installed { installed = user_path(paths[0].parent().unwrap(), "check")?; }
    Ok(Status { installed, recovery_available: record.is_some(), paths: paths.iter().map(|p| p.to_string_lossy().into()).collect() })
}

// Pass the path as an environment value, never interpolate it into shell source.
// Update only our entry in the current user PATH and preserve unrelated edits.
#[cfg(windows)]
fn user_path(path: &std::path::Path, action: &str) -> Result<bool, String> {
    use std::os::windows::process::CommandExt;
    const SCRIPT: &str = r#"$ErrorActionPreference='Stop'
$p=[Environment]::GetEnvironmentVariable('Path','User')
$entry=$env:CLOUDHUB_CC_BIN
$found=@($p -split ';' | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $entry.TrimEnd('\') }).Count -gt 0
if($env:CLOUDHUB_CC_ACTION -eq 'add' -and !$found) {
  $next=if([string]::IsNullOrEmpty($p)){$entry}else{$p+';'+$entry}
  [Environment]::SetEnvironmentVariable('Path',$next,'User')
}
if($env:CLOUDHUB_CC_ACTION -eq 'remove' -and $found) {
  $next=(@($p -split ';' | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ine $entry.TrimEnd('\') }) -join ';')
  [Environment]::SetEnvironmentVariable('Path',$next,'User')
}
if($found){'present'}else{'absent'}"#;
    let executable = std::env::var_os("SystemRoot").map(PathBuf::from).ok_or("Windows 系统目录不可用")?
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let result = std::process::Command::new(executable).args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .env("CLOUDHUB_CC_BIN", path).env("CLOUDHUB_CC_ACTION", action).creation_flags(0x08000000)
        .output().map_err(|_| "无法更新用户 PATH")?;
    if !result.status.success() { return Err("无法更新用户 PATH，请检查用户环境变量权限".into()); }
    Ok(String::from_utf8_lossy(&result.stdout).trim() == "present")
}
#[cfg(not(windows))]
fn user_path(_: &std::path::Path, _: &str) -> Result<bool, String> { Ok(true) }

pub fn set_enabled(enabled: bool) -> Result<(), String> {
    if !enabled { return restore(); }
    if record()?.is_some() {
        return if status()?.installed { Ok(()) } else { Err("存在未完成的快捷命令配置，请先恢复再重试".into()) };
    }
    let paths = targets()?;
    let mut record = Record::default();
    // Validate every destination before writing any of them.
    for path in &paths {
        let old = read(path, 1024 * 1024)?;
        if cfg!(windows) {
            if old.is_some() { return Err("cc.bat 已存在，未覆盖；请先检查原有快捷命令".into()); }
            record.additions.push((path.clone(), BAT.into(), false));
        } else {
            let text = String::from_utf8(old.clone().unwrap_or_default()).map_err(|_| "终端配置不是 UTF-8，未改写")?;
            if text.contains("CloudHub Tools cc") { return Err("终端配置已含快捷命令标记，请先检查原配置".into()); }
            let separator = if text.is_empty() || text.ends_with('\n') { "" } else { "\n" };
            record.additions.push((path.clone(), format!("{separator}{BLOCK}\n"), old.is_some()));
        }
    }
    if cfg!(windows) { record.path_added = !user_path(paths[0].parent().unwrap(), "check")?; }
    save(&record)?;
    for (path, addition, _) in &record.additions {
        let mut bytes = read(path, 1024 * 1024)?.unwrap_or_default();
        bytes.extend_from_slice(addition.as_bytes());
        store(path, &bytes)?;
    }
    if cfg!(windows) { user_path(paths[0].parent().unwrap(), "add")?; }
    Ok(())
}

fn remove_addition(text: &str, addition: &str) -> Result<String, String> {
    if !text.contains(addition) {
        if text.contains("CloudHub Tools cc") { return Err("快捷命令片段已被外部修改，未覆盖；请手动检查终端配置".into()); }
        return Ok(text.into()); // Already removed, or application interrupted before writing.
    }
    if text.matches(addition).count() != 1 { return Err("快捷命令片段重复，未改写终端配置".into()); }
    Ok(text.replacen(addition, "", 1))
}
fn restore() -> Result<(), String> {
    let Some(record) = record()? else { return Err("没有由本工具创建的快捷命令恢复记录".into()); };
    let mut changes = Vec::new();
    for (path, addition, existed) in &record.additions {
        let Some(bytes) = read(path, 1024 * 1024)? else { continue; };
        let text = String::from_utf8(bytes).map_err(|_| "终端配置不是 UTF-8，未改写")?;
        let restored = if cfg!(windows) {
            if text != BAT { return Err("cc.bat 已被外部修改，未删除；请先检查该文件".into()); }
            String::new()
        } else { remove_addition(&text, addition)? };
        changes.push((path, restored, *existed));
    }
    for (path, text, existed) in changes {
        if text.is_empty() && !existed { fs::remove_file(path).map_err(|_| "恢复快捷命令失败")?; }
        else { store(path, text.as_bytes())?; }
    }
    if record.path_added {
        if let Some((path, _, _)) = record.additions.first() { user_path(path.parent().ok_or("快捷命令目录无效")?, "remove")?; }
    }
    set_pref(RECORD, "")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restores_exact_original_and_keeps_later_edits() {
        for original in ["", "export EXISTING=1", "# config\n", "# config\r\n"] {
            let sep = if original.is_empty() || original.ends_with('\n') { "" } else { "\n" };
            let addition = format!("{sep}{BLOCK}\n");
            let installed = format!("{original}{addition}# later edit\n");
            assert_eq!(remove_addition(&installed, &addition).unwrap(), format!("{original}# later edit\n"));
        }
    }
    #[test]
    fn refuses_modified_or_duplicate_blocks() {
        let addition = format!("{BLOCK}\n");
        assert!(remove_addition(&addition.replace("alias cc=", "alias changed="), &addition).is_err());
        assert!(remove_addition(&addition.repeat(2), &addition).is_err());
        assert_eq!(remove_addition("# user removed block\n", &addition).unwrap(), "# user removed block\n");
    }
}
