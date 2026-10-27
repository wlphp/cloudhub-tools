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
        let content = read_text(&config)?;
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
        let targets = default_process_target_paths()?;
        let output = Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$paths = @(ConvertFrom-Json -InputObject $env:CLOUDHUB_CODEX_TARGET_PATHS); $found = @(Get-CimInstance Win32_Process -Filter \"Name='codex.exe' OR Name='ChatGPT.exe'\" | Where-Object { $_.ExecutablePath -and ($paths -contains $_.ExecutablePath) }); if ($found.Count -gt 0) { 'busy' } else { 'idle' }",
            ])
            .env(
                "CLOUDHUB_CODEX_TARGET_PATHS",
                serde_json::to_string(&targets).map_err(|_| "无法确认 Codex 客户端运行状态")?,
            )
            .creation_flags(0x08000000)
            .output()
            .map_err(|_| "无法确认 Codex 客户端运行状态")?;
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

#[cfg(windows)]
fn default_process_target_paths() -> Result<Vec<String>, String> {
    let current = std::env::current_exe()
        .and_then(fs::canonicalize)
        .map_err(|_| "无法确认云枢应用路径")?;
    let mut paths = Vec::new();
    for path in [cli_path(), super::desktop::installed()].into_iter().flatten() {
        let Ok(path) = fs::canonicalize(path) else {
            continue;
        };
        if path != current {
            let path = path.to_string_lossy().into_owned();
            if !paths.iter().any(|item: &String| item.eq_ignore_ascii_case(&path)) {
                paths.push(path);
            }
        }
    }
    if paths.is_empty() {
        return Err("未找到可安全识别的 Codex 客户端或 CLI 路径".into());
    }
    Ok(paths)
}

pub fn close_default_processes() -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let targets = default_process_target_paths()?;
        let script = "$paths = @(ConvertFrom-Json -InputObject $env:CLOUDHUB_CODEX_TARGET_PATHS); $all = @(Get-CimInstance Win32_Process); $byId = @{}; foreach ($process in $all) { $byId[[int]$process.ProcessId] = $process }; $protected = @{}; $parent = [int]$env:CLOUDHUB_CODEX_CALLER_PID; while ($parent -gt 0 -and $byId.ContainsKey($parent)) { $protected[$parent] = $true; $parent = [int]$byId[$parent].ParentProcessId }; $targets = @($all | Where-Object { $_.ExecutablePath -and ($paths -contains $_.ExecutablePath) }); if (@($targets | Where-Object { $protected.ContainsKey([int]$_.ProcessId) }).Count -gt 0) { 'protected'; exit 0 }; try { foreach ($target in $targets) { Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop }; Start-Sleep -Milliseconds 400; $remaining = @(Get-CimInstance Win32_Process -Filter \"Name='codex.exe' OR Name='ChatGPT.exe'\" | Where-Object { $_.ExecutablePath -and ($paths -contains $_.ExecutablePath) }); if ($remaining.Count -gt 0) { 'busy' } else { 'idle' } } catch { 'failed'; exit 2 }";
        let output = Command::new("powershell.exe")
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script])
            .env(
                "CLOUDHUB_CODEX_TARGET_PATHS",
                serde_json::to_string(&targets).map_err(|_| "无法关闭 Codex 客户端或 CLI")?,
            )
            .env("CLOUDHUB_CODEX_CALLER_PID", std::process::id().to_string())
            .creation_flags(0x08000000)
            .output()
            .map_err(|_| "无法关闭 Codex 客户端或 CLI")?;
        if !output.status.success() {
            return Err("关闭 Codex 客户端或 CLI 失败，请手动关闭后重试".into());
        }
        if output.stdout == b"protected\r\n" || output.stdout == b"protected\n" {
            return Err("当前云枢由 Codex 启动，关闭 Codex 会同时退出云枢。请先从开始菜单单独启动云枢，再使用“关闭并重试”".into());
        }
        if output.stdout != b"idle\r\n" && output.stdout != b"idle\n" {
            return Err("Codex 客户端仍在运行，请手动关闭后重试".into());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("自动关闭 Codex 客户端或 CLI 目前仅支持 Windows，请手动关闭后重试".into())
    }
}

pub fn read_auth(path: &Path) -> Result<Zeroizing<String>, String> {
    let content = read_text(path)?;
    if content.is_empty() {
        return Err("Codex 认证文件类型或大小无效".into());
    }
    Ok(content)
}

/// Configuration and recovery must preserve an existing empty file as distinct
/// from an absent file. Credential consumers still use the stricter read_auth.
pub fn read_text(path: &Path) -> Result<Zeroizing<String>, String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|_| "Codex 认证文件不存在；系统凭据库模式请在受管实例中重新登录")?;
    if !meta.is_file()
        || meta.file_type().is_symlink()
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
    write_private_bytes(path, content.as_bytes())
}

pub fn write_private_bytes(path: &Path, content: &[u8]) -> Result<(), String> {
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
        file.write_all(content)
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
    // Finder-launched apps do not inherit the terminal's Homebrew/npm PATH.
    // Prefer the desktop client's native binary, which also needs no Node runtime.
    #[cfg(target_os = "macos")]
    if let Some(cli) = super::desktop::installed().and_then(|app| macos_bundled_cli(&app)) {
        return Some(cli);
    }
    let names: &[&str] = if cfg!(windows) {
        &["codex.exe"]
    } else {
        &["codex"]
    };
    let on_path = std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
            .find(|path| executable_file(path))
    });
    if on_path.is_some() {
        #[cfg(target_os = "macos")]
        return on_path.map(macos_native_cli);
        #[cfg(not(target_os = "macos"))]
        return on_path;
    }
    #[cfg(windows)]
    {
        return super::desktop::installed().and_then(|app| bundled_cli(&app));
    }
    #[cfg(target_os = "macos")]
    {
        macos_cli_candidates(dirs::home_dir().as_deref())
            .into_iter().find(|path| executable_file(path)).map(macos_native_cli)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    None
}

fn executable_file(path: &Path) -> bool {
    if !path.is_file() { return false; }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return fs::metadata(path).is_ok_and(|meta| meta.permissions().mode() & 0o111 != 0);
    }
    #[cfg(not(unix))]
    true
}

#[cfg(any(target_os = "macos", test))]
fn macos_bundled_cli(app: &Path) -> Option<PathBuf> {
    let cli = app.parent()?.parent()?.join("Resources/codex");
    executable_file(&cli).then_some(cli)
}

#[cfg(any(target_os = "macos", test))]
fn macos_cli_candidates(home: Option<&Path>) -> Vec<PathBuf> {
    let mut paths = vec![PathBuf::from("/opt/homebrew/bin/codex"), PathBuf::from("/usr/local/bin/codex")];
    if let Some(home) = home {
        for directory in [".local/bin", ".cargo/bin", ".volta/bin", ".npm-global/bin", ".nvm/current/bin", ".local/share/mise/shims", ".asdf/shims"] {
            paths.push(home.join(directory).join("codex"));
        }
        // Discover nvm installations without executing shell startup scripts.
        if let Ok(entries) = fs::read_dir(home.join(".nvm/versions/node")) {
            let mut versions: Vec<_> = entries.take(64).filter_map(Result::ok).map(|entry| entry.path()).collect();
            versions.sort();
            versions.reverse();
            paths.extend(versions.into_iter().map(|version| version.join("bin/codex")));
        }
    }
    paths
}

#[cfg(any(target_os = "macos", test))]
fn macos_native_cli(launcher: PathBuf) -> PathBuf {
    // npm's launcher uses /usr/bin/env node, which is also absent from Finder's
    // PATH. Use its packaged native binary for both old and optional-dep layouts.
    let Some(package) = fs::canonicalize(&launcher).ok().and_then(|path| path.parent()?.parent().map(Path::to_path_buf)) else { return launcher; };
    for (target, dependency) in [("aarch64-apple-darwin", "codex-darwin-arm64"), ("x86_64-apple-darwin", "codex-darwin-x64")] {
        if (cfg!(target_arch = "aarch64") && target != "aarch64-apple-darwin") || (cfg!(target_arch = "x86_64") && target != "x86_64-apple-darwin") { continue; }
        let relative = PathBuf::from("vendor").join(target).join("codex/codex");
        for root in [Some(package.clone()), Some(package.join("node_modules/@openai").join(dependency)), package.parent().map(|parent| parent.join(dependency))].into_iter().flatten() {
            let binary = root.join(&relative);
            if executable_file(&binary) { return binary; }
        }
    }
    launcher
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
    struct DiscoveryFixture(PathBuf);
    impl DiscoveryFixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("cloudhub-macos-cli-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn executable(&self, relative: &str) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, b"discovery fixture only; never executed").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            }
            path
        }
    }
    impl Drop for DiscoveryFixture {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }
    #[test]
    fn macos_discovers_app_bundle_outside_terminal_path() {
        let f = DiscoveryFixture::new();
        let app = f.0.join("Codex.app/Contents/MacOS/Codex");
        assert!(macos_bundled_cli(&app).is_none());
        fs::create_dir_all(f.0.join("Codex.app/Contents/Resources/codex")).unwrap();
        assert!(macos_bundled_cli(&app).is_none());
        fs::remove_dir(f.0.join("Codex.app/Contents/Resources/codex")).unwrap();
        let cli = f.executable("Codex.app/Contents/Resources/codex");
        assert_eq!(macos_bundled_cli(&app), Some(cli));
    }
    #[test]
    fn macos_discovers_homebrew_user_and_nvm_installations() {
        let f = DiscoveryFixture::new();
        let cli = f.executable(".nvm/versions/node/v22.0.0/bin/codex");
        let paths = macos_cli_candidates(Some(&f.0));
        assert!(paths.contains(&PathBuf::from("/opt/homebrew/bin/codex")));
        assert!(paths.contains(&PathBuf::from("/usr/local/bin/codex")));
        assert!(paths.contains(&f.0.join(".local/bin/codex")));
        assert!(paths.contains(&cli));
    }
    #[test]
    fn macos_npm_uses_native_binary_without_node_on_path() {
        let f = DiscoveryFixture::new();
        let launcher = f.executable("node_modules/@openai/codex/bin/codex.js");
        let target = if cfg!(target_arch = "aarch64") { "aarch64-apple-darwin" } else { "x86_64-apple-darwin" };
        let binary = f.executable(&format!("node_modules/@openai/codex/vendor/{target}/codex/codex"));
        assert_eq!(macos_native_cli(launcher.clone()), fs::canonicalize(binary).unwrap());
        let dependency = if cfg!(target_arch = "aarch64") { "codex-darwin-arm64" } else { "codex-darwin-x64" };
        fs::remove_dir_all(f.0.join("node_modules/@openai/codex/vendor")).unwrap();
        let binary = f.executable(&format!("node_modules/@openai/{dependency}/vendor/{target}/codex/codex"));
        assert_eq!(macos_native_cli(launcher), fs::canonicalize(binary).unwrap());
    }
    #[cfg(unix)]
    #[test]
    fn macos_rejects_non_executable_cli() {
        let f = DiscoveryFixture::new();
        let cli = f.0.join("codex");
        fs::write(&cli, b"not executable").unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(!executable_file(&cli));
    }
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
