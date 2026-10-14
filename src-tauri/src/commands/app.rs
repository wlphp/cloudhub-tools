use crate::core::paths::data_dir;

use crate::core::error::PlatformResult;

#[tauri::command]
pub(crate) fn app_is_development() -> bool {
    crate::core::paths::desktop_development()
}

#[tauri::command]
pub(crate) fn app_data_path() -> PlatformResult<String> {
    Ok(resolved_data_directory()?.to_string_lossy().to_string())
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
pub(crate) fn open_app_data_directory() -> PlatformResult<()> {
    let path = resolved_data_directory()?;
    tauri_plugin_opener::open_path(&path, None::<&str>)
        .map_err(|_| "无法打开数据目录".to_string())?;
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
