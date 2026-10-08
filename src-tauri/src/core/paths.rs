use std::{fs, path::PathBuf};

#[cfg(mobile)]
static APP_LOCAL_DATA_BASE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

#[cfg(mobile)]
pub fn initialize_app_local_data_base(base: PathBuf) -> Result<(), String> {
    APP_LOCAL_DATA_BASE
        .set(base)
        .map_err(|_| "本机应用数据目录已初始化".to_string())
}

pub fn data_dir() -> Result<PathBuf, String> {
    #[cfg(mobile)]
    let base = APP_LOCAL_DATA_BASE
        .get()
        .cloned()
        .ok_or_else(|| "本机应用数据目录尚未初始化".to_string())?;
    #[cfg(not(mobile))]
    let base = dirs::data_local_dir().ok_or_else(|| "无法获取本机应用数据目录".to_string())?;
    let path = base.join("CloudHubTools");
    let legacy_path = base.join("AliyunTools");
    fs::create_dir_all(&path).map_err(|error| format!("创建数据目录失败: {error}"))?;
    if legacy_path.exists() {
        for (legacy_name, current_name) in [("aliyun_tools.sqlite3", "cloudhub_tools.sqlite3"), (".key", ".key")] {
            let source = legacy_path.join(legacy_name);
            let destination = path.join(current_name);
            if source.exists() && !destination.exists() {
                fs::copy(&source, destination).map_err(|error| format!("迁移本地数据失败: {error}"))?;
            }
        }
    }
    Ok(path)
}
