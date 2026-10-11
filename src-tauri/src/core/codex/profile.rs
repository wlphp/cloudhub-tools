use crate::core::paths::data_dir;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
};
use zeroize::Zeroizing;

pub const MAX_AUTH_BYTES: u64 = 2 * 1024 * 1024;

pub fn default_home() -> Result<PathBuf, String> {
    let path = std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or(
        dirs::home_dir()
            .ok_or("无法确定 Codex 用户目录")?
            .join(".codex"),
    );
    if !path.is_absolute() {
        return Err("CODEX_HOME 必须为绝对路径".into());
    }
    Ok(path)
}

pub fn ensure_file_storage(home: &Path) -> Result<(), String> {
    let config = home.join("config.toml");
    if config.exists() {
        let content = read_auth(&config)?;
        for line in content.lines() {
            let line = line.split('#').next().unwrap_or("");
            if let Some((key, value)) = line.split_once('=') {
                if key.trim() == "cli_auth_credentials_store"
                    && value.trim().trim_matches(['\"', '\'']) != "file"
                {
                    return Err("Codex 使用系统凭据库或内存认证，不支持文件切号与认证回写".into());
                }
            }
        }
    }
    Ok(())
}

pub fn ensure_default_idle() -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Only a boolean leaves PowerShell. No command line, environment or process path is read.
        let output=Command::new("powershell.exe").args(["-NoLogo","-NoProfile","-NonInteractive","-Command","if (@(Get-Process -Name codex -ErrorAction SilentlyContinue).Count -gt 0 -or @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*OpenAI.Codex_*\\app\\ChatGPT.exe' }).Count -gt 0) { 'busy' } else { 'idle' }"]).creation_flags(0x08000000).output().map_err(|_|"无法确认 Codex 客户端运行状态")?;
        if !output.status.success() {
            return Err("无法确认 Codex 客户端运行状态".into());
        }
        if output.stdout != b"idle\r\n" && output.stdout != b"idle\n" {
            return Err("检测到 Codex 客户端或 CLI 正在运行，请关闭后再切换或恢复默认登录".into());
        }
    }
    #[cfg(unix)]
    {
        let status = Command::new("pgrep")
            .args(["-x", "codex|Codex"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|_| "无法确认 Codex 客户端运行状态")?;
        match status.code() {
            Some(1) => {}
            Some(0) => {
                return Err(
                    "检测到 Codex 客户端或 CLI 正在运行，请关闭后再切换或恢复默认登录".into(),
                )
            }
            _ => return Err("无法确认 Codex 客户端运行状态".into()),
        }
    }
    Ok(())
}

pub fn read_auth(path: &Path) -> Result<Zeroizing<String>, String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|_| "Codex 认证文件不存在；系统凭据库模式请在受管实例中重新登录")?;
    if !meta.is_file()
        || meta.file_type().is_symlink()
        || meta.len() == 0
        || meta.len() > MAX_AUTH_BYTES
    {
        return Err("Codex 认证文件类型或大小无效".into());
    }
    let mut content = Zeroizing::new(String::new());
    fs::File::open(path)
        .map_err(|_| "没有权限读取 Codex 认证文件")?
        .take(MAX_AUTH_BYTES + 1)
        .read_to_string(&mut content)
        .map_err(|_| "读取 Codex 认证文件失败")?;
    if content.len() as u64 > MAX_AUTH_BYTES {
        return Err("Codex 认证文件过大".into());
    }
    Ok(content)
}

pub fn fingerprint(content: Option<&str>) -> String {
    content
        .map(|v| hex::encode(Sha256::digest(v.as_bytes())))
        .unwrap_or_else(|| "absent".into())
}

pub fn private_permissions(path: &Path, directory: bool) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            path,
            fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }),
        )
        .map_err(|_| "限制 Codex 文件权限失败")?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let user = std::env::var("USERNAME").map_err(|_| "无法确定当前 Windows 用户")?;
        let domain = std::env::var("USERDOMAIN").map_err(|_| "无法确定当前 Windows 用户域")?;
        if [user.as_str(), domain.as_str()].iter().any(|s| {
            s.is_empty()
                || s.chars()
                    .any(|c| c.is_control() || matches!(c, ':' | '(' | ')' | '/' | '"'))
        }) {
            return Err("Windows 用户标识无效".into());
        }
        let grant = format!(
            "{domain}\\{user}:{}F",
            if directory { "(OI)(CI)" } else { "" }
        );
        let status = Command::new("icacls.exe")
            .arg(path)
            .args(["/inheritance:r", "/grant:r", &grant])
            .creation_flags(0x08000000)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|_| "限制 Codex 文件权限失败")?;
        if !status.success() {
            return Err("限制 Codex 文件权限失败".into());
        }
    }
    Ok(())
}

pub fn write_private(path: &Path, content: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("Codex 文件路径无效")?;
    if fs::symlink_metadata(path).is_ok_and(|v| v.file_type().is_symlink() || !v.is_file()) {
        return Err("Codex 文件路径不能是链接或目录".into());
    }
    let temp = parent.join(format!(".cloudhub-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|_| "创建 Codex 临时文件失败")?;
        private_permissions(&temp, false)?;
        file.write_all(content.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|_| "写入 Codex 认证文件失败")?;
        drop(file);
        fs::rename(&temp, path)
            .map_err(|_| "替换 Codex 认证文件失败，请检查客户端占用与权限".into())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

pub struct TemporaryProfile {
    pub path: PathBuf,
}
impl TemporaryProfile {
    pub fn new(auth: &str) -> Result<Self, String> {
        let root = data_dir()?.join("codex-runtime");
        fs::create_dir_all(&root).map_err(|_| "创建 Codex 运行目录失败")?;
        if fs::symlink_metadata(&root)
            .map_err(|_| "检查 Codex 运行目录失败")?
            .file_type()
            .is_symlink()
        {
            return Err("Codex 运行目录不能是链接".into());
        }
        private_permissions(&root, true)?;
        let path = root.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&path).map_err(|_| "创建 Codex 隔离目录失败")?;
        let profile = Self { path };
        private_permissions(&profile.path, true)?;
        write_private(&profile.path.join("auth.json"), auth)?;
        write_private(
            &profile.path.join("config.toml"),
            "cli_auth_credentials_store = \"file\"\n[analytics]\nenabled = false\n",
        )?;
        Ok(profile)
    }
}
impl Drop for TemporaryProfile {
    fn drop(&mut self) {
        // Only the UUID directory created by this object; never a user-supplied path.
        if self
            .path
            .file_name()
            .and_then(|v| v.to_str())
            .is_some_and(|v| uuid::Uuid::parse_str(v).is_ok())
        {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

pub fn cli_path() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["codex.exe"]
    } else {
        &["codex"]
    };
    let on_path = std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
            .find(|path| path.is_file())
    });
    if on_path.is_some() {
        return on_path;
    }
    #[cfg(windows)]
    {
        return super::desktop::installed().and_then(|app| bundled_cli(&app));
    }
    #[cfg(not(windows))]
    None
}

/// Use the installed desktop client's real version for its model catalog; never
/// invent a newer version to bypass upstream model visibility.
pub fn catalog_client_version() -> Result<String, String> {
    use std::{io::Read, process::{Command, Stdio}, time::{Duration, Instant}};
    #[cfg(windows)]
    let executable = super::desktop::installed().and_then(|app| bundled_cli(&app)).or_else(cli_path);
    #[cfg(not(windows))]
    let executable = cli_path();
    let mut command = Command::new(executable.ok_or("未找到官方 Codex 客户端，无法查询模型目录")?);
    command.arg("--version").stdin(Stdio::null()).stderr(Stdio::null()).stdout(Stdio::piped());
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = command.spawn().map_err(|_| "读取 Codex 客户端版本失败")?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => return Err("读取 Codex 客户端版本失败".into()),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => { let _ = child.kill(); let _ = child.wait(); return Err("读取 Codex 客户端版本超时".into()); }
        }
    }
    let mut bytes = Vec::new();
    child.stdout.take().ok_or("Codex 客户端版本无效")?.take(4097).read_to_end(&mut bytes).map_err(|_| "Codex 客户端版本无效")?;
    let output = std::str::from_utf8(&bytes).map_err(|_| "Codex 客户端版本无效")?;
    let version = output.trim().strip_prefix("codex-cli ").ok_or("Codex 客户端版本无效")?.split('-').next().ok_or("Codex 客户端版本无效")?;
    if version.len() > 32 || version.split('.').count() != 3 || version.split('.').any(|part| part.is_empty() || !part.bytes().all(|v| v.is_ascii_digit())) { return Err("Codex 客户端版本无效".into()); }
    Ok(version.to_string())
}

#[cfg(windows)]
fn bundled_cli(desktop_executable: &Path) -> Option<PathBuf> {
    // The verified Store package contains a native executable beside app.asar.
    // Execute it directly, rather than evaluating npm or PowerShell launchers.
    let cli = desktop_executable
        .parent()?
        .join("resources")
        .join("codex.exe");
    cli.is_file().then_some(cli)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires an installed official Codex client; reads only its version"]
    fn model_catalog_uses_installed_client_version_without_credentials() {
        let version = catalog_client_version().unwrap();
        assert_eq!(version.split('.').count(), 3);
        assert!(!version.contains('-'));
    }
    #[cfg(windows)]
    #[test]
    fn discovers_bundled_native_cli_and_rejects_missing_or_directory_targets() {
        let root =
            std::env::temp_dir().join(format!("cloudhub-codex-discovery-{}", uuid::Uuid::new_v4()));
        let resources = root.join("resources");
        fs::create_dir_all(&resources).unwrap();
        let app = root.join("ChatGPT.exe");
        assert!(bundled_cli(&app).is_none());
        let cli = resources.join("codex.exe");
        fs::create_dir(&cli).unwrap();
        assert!(bundled_cli(&app).is_none());
        fs::remove_dir(&cli).unwrap();
        fs::write(&cli, b"fixture discovery only; never executed").unwrap();
        assert_eq!(bundled_cli(&app), Some(cli));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn atomic_write_and_read_are_bounded() {
        let root =
            std::env::temp_dir().join(format!("cloudhub-codex-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        private_permissions(&root, true).unwrap();
        let path = root.join("auth.json");
        write_private(&path, "{\"fixture\":1}").unwrap();
        write_private(&path, "{\"fixture\":2}").unwrap();
        assert_eq!(&*read_auth(&path).unwrap(), "{\"fixture\":2}");
        assert_ne!(fingerprint(Some("one")), fingerprint(Some("two")));
        assert_ne!(fingerprint(None), fingerprint(Some("")));
        fs::remove_dir_all(root).unwrap();
    }
}
