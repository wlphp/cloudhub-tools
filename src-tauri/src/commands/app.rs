use crate::core::paths::data_dir;

use crate::core::error::PlatformResult;

#[tauri::command]
pub(crate) fn app_is_development() -> bool {
    crate::core::paths::desktop_development()
}

/// 彻底退出应用：绕过托盘驻留，直接结束进程。
#[tauri::command]
pub(crate) fn app_exit(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub(crate) fn app_data_path() -> PlatformResult<String> {
    Ok(resolved_data_directory()?.to_string_lossy().to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppDataEntry {
    name: String,
    directory: bool,
    size_bytes: u64,
}

// Only enumerate metadata inside the app's own data directory; never expose contents.
#[tauri::command]
pub(crate) fn list_app_data_directory(directory: Option<String>) -> PlatformResult<Vec<AppDataEntry>> {
    let base = resolved_data_directory()?;
    read_data_entries(&base, directory.as_deref().unwrap_or("")).map_err(Into::into)
}

fn read_data_entries(base: &std::path::Path, directory: &str) -> Result<Vec<AppDataEntry>, String> {
    use std::path::{Component, Path};
    if directory.len() > 2048 || directory.contains('\0') { return Err("目录路径无效".into()); }
    let mut target = base.to_path_buf();
    for component in Path::new(directory).components() {
        let Component::Normal(name) = component else { return Err("目录路径无效".into()); };
        target.push(name);
        let metadata = std::fs::symlink_metadata(&target).map_err(|_| "目录不存在或无法访问")?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() { return Err("不支持访问此目录".into()); }
    }
    let target = target.canonicalize().map_err(|_| "目录不存在或无法访问")?;
    if !target.starts_with(base) { return Err("不支持访问此目录".into()); }
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(target).map_err(|_| "读取目录失败，请重试")? {
        let entry = entry.map_err(|_| "读取目录失败，请重试")?;
        let kind = entry.file_type().map_err(|_| "读取文件信息失败")?;
        if kind.is_symlink() || (!kind.is_dir() && !kind.is_file()) { continue; }
        let name = entry.file_name().into_string().map_err(|_| "文件名编码不受支持")?;
        let size_bytes = if kind.is_file() { entry.metadata().map_err(|_| "读取文件信息失败")?.len() } else { 0 };
        entries.push(AppDataEntry { name, directory: kind.is_dir(), size_bytes });
        if entries.len() > 2000 { return Err("目录文件过多，请使用备份管理查看备份".into()); }
    }
    entries.sort_by(|a, b| b.directory.cmp(&a.directory).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

fn resolved_data_directory() -> Result<std::path::PathBuf, String> {
    let path = data_dir()?;
    // MSIX-launched child processes can see a virtual LocalAppData path that an
    // external Explorer process cannot access. Resolve the actual file handle
    // location before passing it across that process boundary.
    let path = std::fs::canonicalize(path).map_err(|_| "无法解析本地数据目录".to_string())?;
    #[cfg(target_os = "windows")]
    {
        Ok(shell_directory_path(&path))
    }
    #[cfg(not(target_os = "windows"))]
    { Ok(path) }
}

#[cfg(target_os = "windows")]
fn shell_directory_path(path: &std::path::Path) -> std::path::PathBuf {
    use std::path::{Component, PathBuf, Prefix};
    let mut components = path.components();
    match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::VerbatimDisk(drive) => {
                let mut result = PathBuf::from(format!("{}:\\", drive as char));
                // Skip the RootDir after the verbatim drive prefix.
                for component in components {
                    if !matches!(component, Component::RootDir) { result.push(component); }
                }
                result
            }
            Prefix::VerbatimUNC(server, share) => {
                let mut result = PathBuf::from("\\\\");
                result.push(server);
                result.push(share);
                for component in components {
                    if !matches!(component, Component::RootDir) { result.push(component); }
                }
                result
            }
            _ => path.to_path_buf(),
        },
        _ => path.to_path_buf(),
    }
}

#[tauri::command]
pub(crate) fn open_app_data_directory(directory: Option<String>) -> PlatformResult<()> {
    let mut path = resolved_data_directory()?;
    match directory.as_deref() {
        None => {},
        Some("backups") => {
            path.push("backups");
            std::fs::create_dir_all(&path).map_err(|_| "无法创建备份目录".to_string())?;
        },
        Some(_) => return Err("不支持打开此数据目录".into()),
    }
    if let Err(error) = tauri_plugin_opener::open_path(&path, None::<&str>) {
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("explorer")
                .arg(&path)
                .spawn()
                .map_err(|_| crate::core::error::PlatformError::from(format!("无法打开数据目录: {error}")))?;
            return Ok(());
        }
        #[cfg(not(target_os = "windows"))]
        return Err(crate::core::error::PlatformError::from(format!("无法打开数据目录: {error}")));
    }
    Ok(())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::shell_directory_path;
    use std::path::Path;

    #[test]
    fn resolved_paths_are_compatible_with_explorer() {
        assert_eq!(shell_directory_path(Path::new(r"\\?\C:\Users\fixture\Packages\app\LocalCache\Local\CloudHubTools-Dev")), Path::new(r"C:\Users\fixture\Packages\app\LocalCache\Local\CloudHubTools-Dev"));
        assert_eq!(shell_directory_path(Path::new(r"\\?\UNC\fixture-server\share\CloudHubTools")), Path::new(r"\\fixture-server\share\CloudHubTools"));
        assert_eq!(shell_directory_path(Path::new(r"C:\fixture\CloudHubTools")), Path::new(r"C:\fixture\CloudHubTools"));
    }
}
