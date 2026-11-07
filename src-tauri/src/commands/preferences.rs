use std::collections::BTreeMap;

use crate::core::{repositories::preferences as preferences_repository, storage::open_db};

use crate::core::error::PlatformResult;

#[tauri::command]
pub(crate) fn list_client_preferences() -> PlatformResult<BTreeMap<String, String>> {
    Ok(preferences_repository::list(&open_db()?)?)
}

#[tauri::command]
pub(crate) fn save_client_preference(key: String, value: String) -> PlatformResult<()> {
    let key = key.trim();
    if key.is_empty() || key.starts_with("cloud.sync.") || key.starts_with("cloud.drive.") || key.len() > 120 || value.len() > 100_000 { return Err("客户端设置数据无效".into()); }
    let conn = open_db()?;
    preferences_repository::save_detailed(&conn, key, &value, chrono::Utc::now().timestamp_millis()).map_err(|error| {
        match error {
            // The connection opened read-write, so SQLITE_READONLY here comes from the
            // filesystem refusing the write (permissions, sandbox or a read-only mount).
            rusqlite::Error::SqliteFailure(code, _) if code.code == rusqlite::ErrorCode::ReadOnly => {
                // 同一文件在其他受信进程（如脚本）里可写时，安全软件可能只拦截本进程；
                // 用目录新建文件和打开数据库文件两个探针区分失败层，附原始系统错误码。
                let directory = crate::core::paths::data_dir().ok();
                let probe = directory.as_ref().map(|directory| {
                    let create_probe = std::fs::write(directory.join(".write-probe.tmp"), b"probe")
                        .map(|_| ()).map_err(|error| error.to_string());
                    let _ = std::fs::remove_file(directory.join(".write-probe.tmp"));
                    let open_database = std::fs::OpenOptions::new().write(true).open(directory.join("cloudhub_tools.sqlite3"))
                        .map(|_| ()).map_err(|error| error.to_string());
                    format!("新建文件探针={create_probe:?}; 打开数据库文件探针={open_database:?}; 用户={}; LOCALAPPDATA={}",
                        std::env::var("USERNAME").unwrap_or_default(), std::env::var("LOCALAPPDATA").unwrap_or_default())
                });
                format!("本地数据库当前不可写，设置未保存；请检查数据目录权限、安全软件或沙箱限制后重启应用［诊断: {:?}］", probe)
            }
            other => format!("保存设置失败：{other}"),
        }.into()
    })
}
