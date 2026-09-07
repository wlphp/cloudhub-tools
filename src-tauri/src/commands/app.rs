use crate::core::paths::data_dir;
use std::process::Command;

use crate::core::error::PlatformResult;

#[tauri::command]
pub(crate) fn app_data_path() -> PlatformResult<String> {
    Ok(data_dir()?.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) fn open_app_data_directory() -> PlatformResult<()> {
    let path = data_dir()?;

    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer.exe");
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = Command::new("xdg-open");

    Ok(command
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开数据目录: {error}"))?)
}
