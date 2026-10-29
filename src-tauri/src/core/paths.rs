use std::{fs, path::PathBuf};

// Only initialized by the private browser database pipe, never by the GUI.
#[cfg(desktop)]
static BROWSER_DATABASE_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
#[cfg(desktop)]
pub(crate) fn initialize_browser_database_dir() -> Result<(), String> {
    let path = PathBuf::from(std::env::var_os("CLOUDHUB_BROWSER_DATA_DIR").ok_or("缺少网页调试数据目录")?);
    if !path.is_absolute() || !path.is_dir() { return Err("网页调试数据目录无效".into()); }
    BROWSER_DATABASE_DIR.set(path.canonicalize().map_err(|_| "网页调试数据目录无效")?).map_err(|_| "网页调试数据目录已初始化".into())
}

#[cfg(mobile)]
static APP_LOCAL_DATA_BASE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

#[cfg(mobile)]
pub fn initialize_app_local_data_base(base: PathBuf) -> Result<(), String> {
    APP_LOCAL_DATA_BASE
        .set(base)
        .map_err(|_| "本机应用数据目录已初始化".to_string())
}

pub fn data_dir() -> Result<PathBuf, String> {
    #[cfg(desktop)]
    if let Some(path) = BROWSER_DATABASE_DIR.get() { return Ok(path.clone()); }
    #[cfg(mobile)]
    let base = APP_LOCAL_DATA_BASE
        .get()
        .cloned()
        .ok_or_else(|| "本机应用数据目录尚未初始化".to_string())?;
    #[cfg(not(mobile))]
    let base = dirs::data_local_dir().ok_or_else(|| "无法获取本机应用数据目录".to_string())?;
    prepare_data_dir(&base, desktop_development())
}

pub const fn desktop_development() -> bool {
    cfg!(all(not(mobile), debug_assertions))
}

fn prepare_data_dir(base: &std::path::Path, development: bool) -> Result<PathBuf, String> {
    let path = base.join(if development { "CloudHubTools-Dev" } else { "CloudHubTools" });
    let legacy_path = base.join("AliyunTools");
    fs::create_dir_all(&path).map_err(|error| format!("创建数据目录失败: {error}"))?;
    // A debug build must never inherit production data or its encryption key.
    if !development && legacy_path.exists() {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_does_not_copy_production_or_legacy_data() {
        let base = std::env::temp_dir().join(format!("cloudhub-paths-{}", uuid::Uuid::new_v4()));
        let legacy = base.join("AliyunTools");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("aliyun_tools.sqlite3"), b"fixture database").unwrap();
        fs::write(legacy.join(".key"), b"fixture key").unwrap();
        let production = prepare_data_dir(&base, false).unwrap();
        let development = prepare_data_dir(&base, true).unwrap();
        assert_eq!(production, base.join("CloudHubTools"));
        assert_eq!(development, base.join("CloudHubTools-Dev"));
        assert!(production.join("cloudhub_tools.sqlite3").exists());
        assert!(production.join(".key").exists());
        assert!(!development.join("cloudhub_tools.sqlite3").exists());
        assert!(!development.join(".key").exists());
        fs::write(development.join(".key"), b"independent fixture").unwrap();
        assert_eq!(fs::read(production.join(".key")).unwrap(), b"fixture key");
        fs::remove_dir_all(base).unwrap();
    }
}
