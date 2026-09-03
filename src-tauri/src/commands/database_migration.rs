use crate::core::storage::{data_dir, open_db};
use crate::core::crypto::crypto_key_bytes;
use chrono::Utc;
use rusqlite::Connection;
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs, path::{Path, PathBuf}, sync::Mutex};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

const MAGIC: &[u8; 8] = b"CHDBMIG1";
const FORMAT_VERSION: u32 = 1;
const MAX_PACKAGE_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct DatabaseImportStore { sessions: Mutex<HashMap<String, PreparedImport>> }

struct PreparedImport { database_path: PathBuf, key: Vec<u8> }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportPreview { pub(crate) token: String, pub(crate) package_name: String, pub(crate) exported_at: String, pub(crate) total_records: u64, pub(crate) categories: Vec<ImportCategory>, pub(crate) details: Vec<String>, pub(crate) conflicts: Vec<String> }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportCategory { pub(crate) label: String, pub(crate) count: u64 }

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn snapshot_database(target: &Path) -> Result<(), String> {
    let conn = open_db()?;
    let escaped = target.to_string_lossy().replace('\'', "''");
    conn.execute_batch(&format!("VACUUM INTO '{}';", escaped))
        .map_err(|error| format!("创建 SQLite 快照失败: {error}"))
}

fn write_u32(output: &mut Vec<u8>, value: u32) { output.extend_from_slice(&value.to_le_bytes()); }
fn write_u64(output: &mut Vec<u8>, value: u64) { output.extend_from_slice(&value.to_le_bytes()); }

fn read_u32(input: &[u8], offset: &mut usize) -> Result<u32, String> {
    if input.len().saturating_sub(*offset) < 4 { return Err("迁移包头损坏".into()); }
    let value = u32::from_le_bytes(input[*offset..*offset + 4].try_into().unwrap());
    *offset += 4;
    Ok(value)
}

fn read_u64(input: &[u8], offset: &mut usize) -> Result<u64, String> {
    if input.len().saturating_sub(*offset) < 8 { return Err("迁移包头损坏".into()); }
    let value = u64::from_le_bytes(input[*offset..*offset + 8].try_into().unwrap());
    *offset += 8;
    Ok(value)
}

fn read_bytes<'a>(input: &'a [u8], offset: &mut usize, length: u64) -> Result<&'a [u8], String> {
    let length = usize::try_from(length).map_err(|_| "迁移包过大".to_string())?;
    let end = offset.checked_add(length).ok_or_else(|| "迁移包长度无效".to_string())?;
    if end > input.len() { return Err(format!("迁移包内容不完整（偏移 {}，需要 {} 字节，文件共 {} 字节）", *offset, length, input.len())); }
    let value = &input[*offset..end];
    *offset = end;
    Ok(value)
}

fn validate_database(path: &Path) -> Result<(), String> {
    let conn = Connection::open(path).map_err(|error| format!("导入数据库无法打开: {error}"))?;
    let result: String = conn.query_row("PRAGMA integrity_check", [], |row| row.get(0)).map_err(|error| format!("校验数据库失败: {error}"))?;
    if result != "ok" { return Err("导入数据库完整性校验失败".into()); }
    for table in ["cloud_accounts", "cloud_assets", "ssh_connections", "rdp_connections", "managed_hosts", "panel_connections", "operation_logs", "api_logs", "client_preferences"] {
        let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)", [table], |row| row.get(0)).map_err(|error| format!("校验数据库表失败: {error}"))?;
        if !exists { return Err(format!("导入数据库缺少必要数据表: {table}")); }
    }
    Ok(())
}

fn parse_package(package_path: &Path) -> Result<(Vec<u8>, Vec<u8>, serde_json::Value), String> {
    let package = fs::read(package_path).map_err(|error| format!("读取迁移包失败: {error}"))?;
    if package.len() as u64 > MAX_PACKAGE_BYTES { return Err("迁移包超过 4 GB 限制".into()); }
    if package.starts_with(b"SQLite format 3\0") {
        let key_path = package_path.parent().unwrap_or_else(|| Path::new(".")).join(".key");
        let key = fs::read(&key_path).map_err(|_| "检测到直接 SQLite 文件，但同目录缺少 .key 密钥文件".to_string())?;
        if key.len() != 32 { return Err("同目录 .key 密钥文件无效，无法导入直接 SQLite 文件".into()); }
        return Ok((package, key, json!({ "format": "cloudhub-tools-database-migration", "version": FORMAT_VERSION, "exported_at": "直接 SQLite 文件" })));
    }
    if package.len() < 20 || &package[..8] != MAGIC { return Err("迁移包格式无效，请选择 .chdb 导出包或与 .key 同目录的 SQLite 文件".into()); }
    let mut offset = 8;
    let manifest_len = read_u32(&package, &mut offset)? as u64;
    let manifest_bytes = read_bytes(&package, &mut offset, manifest_len)?;
    let manifest: serde_json::Value = serde_json::from_slice(manifest_bytes).map_err(|_| "迁移包信息无效".to_string())?;
    if manifest.get("format").and_then(|value| value.as_str()) != Some("cloudhub-tools-database-migration") || manifest.get("version").and_then(|value| value.as_u64()) != Some(FORMAT_VERSION as u64) { return Err("不支持的迁移包版本".into()); }
    let database_len = read_u64(&package, &mut offset)?;
    let key_len = read_u32(&package, &mut offset)? as u64;
    let database = read_bytes(&package, &mut offset, database_len)?.to_vec();
    let key = read_bytes(&package, &mut offset, key_len)?.to_vec();
    let database_hash = digest(&database);
    let key_hash = digest(&key);
    if offset != package.len() || key.len() != 32 || manifest.get("database_sha256").and_then(|value| value.as_str()) != Some(database_hash.as_str()) || manifest.get("key_sha256").and_then(|value| value.as_str()) != Some(key_hash.as_str()) { return Err("迁移包校验失败，文件可能已损坏或被篡改".into()); }
    Ok((database, key, manifest))
}

fn table_count(conn: &Connection, table: &str) -> Result<u64, String> {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get::<_, i64>(0)).map(|value| value.max(0) as u64).map_err(|error| format!("读取导入统计失败: {error}"))
}

fn build_preview(database_path: &Path, current_db: &Path, token: String, package_name: String, exported_at: String) -> Result<ImportPreview, String> {
    let imported = Connection::open(database_path).map_err(|error| format!("打开导入数据库失败: {error}"))?;
    let labels = [("cloud_accounts", "云账号"), ("cloud_assets", "云资产"), ("ssh_connections", "SSH 连接"), ("rdp_connections", "RDP 连接"), ("managed_hosts", "托管主机"), ("panel_connections", "面板连接"), ("operation_logs", "操作日志"), ("api_logs", "API 日志"), ("client_preferences", "客户端设置")];
    let mut categories = Vec::new(); let mut total_records = 0;
    for (table, label) in labels { let count = table_count(&imported, table)?; total_records += count; categories.push(ImportCategory { label: label.into(), count }); }
    let mut details = Vec::new(); let mut incoming_keys = HashMap::new();
    let mut stmt = imported.prepare("SELECT account_name, cloud_type, region_id, enabled, access_key_id FROM cloud_accounts ORDER BY id LIMIT 200").map_err(|error| format!("读取账号明细失败: {error}"))?;
    for row in stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, i64>(3)?, row.get::<_, String>(4)?))).map_err(|error| format!("读取账号明细失败: {error}"))?.flatten() { let (name, cloud, region, enabled, key) = row; incoming_keys.insert(key, name.clone()); details.push(format!("云账号：{} · {} · {} · {}", name, cloud, region.unwrap_or_else(|| "未设置地域".into()), if enabled == 1 { "启用" } else { "停用" })); }
    let mut stmt = imported.prepare("SELECT name, host, port, platform, auth_method FROM managed_hosts ORDER BY id LIMIT 200").map_err(|error| format!("读取托管主机明细失败: {error}"))?;
    for row in stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?))).map_err(|error| format!("读取托管主机明细失败: {error}"))?.flatten() { details.push(format!("托管主机：{} · {}:{} · {} · {}", row.0, row.1, row.2, row.3, row.4)); }
    let mut stmt = imported.prepare("SELECT name, panel_url, status FROM panel_connections ORDER BY id LIMIT 200").map_err(|error| format!("读取面板明细失败: {error}"))?;
    for row in stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))).map_err(|error| format!("读取面板明细失败: {error}"))?.flatten() { details.push(format!("面板连接：{} · {} · {}", row.0, row.1, row.2)); }
    let mut conflicts = Vec::new();
    if let Ok(current) = Connection::open(current_db) {
        let mut stmt = current.prepare("SELECT access_key_id, account_name FROM cloud_accounts").map_err(|error| format!("读取现有账号失败: {error}"))?;
        let existing = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).map_err(|error| format!("读取现有账号失败: {error}"))?.flatten().collect::<HashMap<_, _>>();
        for (key, name) in incoming_keys { if let Some(existing_name) = existing.get(&key) { conflicts.push(format!("云账号重复：导入“{}”与当前“{}”使用相同 AccessKey ID", name, existing_name)); } }
        let mut stmt = current.prepare("SELECT panel_url, name FROM panel_connections").map_err(|error| format!("读取现有面板失败: {error}"))?;
        let existing = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).map_err(|error| format!("读取现有面板失败: {error}"))?.flatten().collect::<HashMap<_, _>>();
        let mut stmt = imported.prepare("SELECT panel_url, name FROM panel_connections").map_err(|error| format!("读取导入面板失败: {error}"))?;
        for row in stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).map_err(|error| format!("读取导入面板失败: {error}"))?.flatten() { if let Some(existing_name) = existing.get(&row.0) { conflicts.push(format!("面板连接重复：导入“{}”与当前“{}”地址相同", row.1, existing_name)); } }
        let mut stmt = current.prepare("SELECT host, port, name FROM managed_hosts").map_err(|error| format!("读取现有托管主机失败: {error}"))?;
        let existing = stmt.query_map([], |row| Ok((format!("{}:{}", row.get::<_, String>(0)?, row.get::<_, i64>(1)?), row.get::<_, String>(2)?))).map_err(|error| format!("读取现有托管主机失败: {error}"))?.flatten().collect::<HashMap<_, _>>();
        let mut stmt = imported.prepare("SELECT host, port, name FROM managed_hosts").map_err(|error| format!("读取导入托管主机失败: {error}"))?;
        for row in stmt.query_map([], |row| Ok((format!("{}:{}", row.get::<_, String>(0)?, row.get::<_, i64>(1)?), row.get::<_, String>(2)?))).map_err(|error| format!("读取导入托管主机失败: {error}"))?.flatten() { if let Some(existing_name) = existing.get(&row.0) { conflicts.push(format!("托管主机重复：导入“{}”与当前“{}”地址和端口相同", row.1, existing_name)); } }
    }
    Ok(ImportPreview { token, package_name, exported_at, total_records, categories, details, conflicts })
}

#[tauri::command]
pub(crate) fn export_database_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let data = data_dir()?;
    let key = crypto_key_bytes()?;
    let snapshot = data.join(format!(".cloudhub-export-{}.sqlite3", Uuid::new_v4()));
    let result = (|| {
        snapshot_database(&snapshot)?;
        let database = fs::read(&snapshot).map_err(|error| format!("读取 SQLite 快照失败: {error}"))?;
        let manifest = serde_json::to_vec(&json!({
            "format": "cloudhub-tools-database-migration",
            "version": FORMAT_VERSION,
            "exported_at": Utc::now().to_rfc3339(),
            "database_sha256": digest(&database),
            "key_sha256": digest(&key),
        })).map_err(|error| format!("生成迁移包信息失败: {error}"))?;
        let Some(selected) = app.dialog().file().set_file_name(format!("cloudhub-tools-backup-{}.chdb", Utc::now().format("%Y%m%d-%H%M%S"))).blocking_save_file() else { return Ok(None) };
        let path = selected.into_path().map_err(|_| "当前平台返回了不支持的导出路径".to_string())?;
        let mut package = Vec::with_capacity(8 + 4 + manifest.len() + 8 + 4 + database.len() + key.len());
        package.extend_from_slice(MAGIC);
        write_u32(&mut package, manifest.len().try_into().map_err(|_| "迁移包信息过大")?);
        package.extend_from_slice(&manifest);
        write_u64(&mut package, database.len().try_into().map_err(|_| "数据库过大")?);
        write_u32(&mut package, key.len().try_into().map_err(|_| "密钥文件无效")?);
        package.extend_from_slice(&database);
        package.extend_from_slice(&key);
        if package.len() as u64 > MAX_PACKAGE_BYTES { return Err("迁移包超过 4 GB 限制".into()); }
        fs::write(&path, package).map_err(|error| format!("写入迁移包失败: {error}"))?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })();
    let _ = fs::remove_file(&snapshot);
    result
}

#[tauri::command]
pub(crate) fn import_database_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let Some(selected) = app.dialog().file().blocking_pick_file() else { return Ok(None) };
    let package_path = selected.into_path().map_err(|_| "当前平台返回了不支持的导入路径".to_string())?;
    let package = fs::read(&package_path).map_err(|error| format!("读取迁移包失败: {error}"))?;
    if package.len() as u64 > MAX_PACKAGE_BYTES || package.len() < 20 || &package[..8] != MAGIC { return Err("迁移包格式无效或超过大小限制".into()); }
    let mut offset = 8;
    let manifest_len = read_u32(&package, &mut offset)? as u64;
    let manifest_bytes = read_bytes(&package, &mut offset, manifest_len)?;
    let manifest: serde_json::Value = serde_json::from_slice(manifest_bytes).map_err(|_| "迁移包信息无效".to_string())?;
    if manifest.get("format").and_then(|value| value.as_str()) != Some("cloudhub-tools-database-migration") || manifest.get("version").and_then(|value| value.as_u64()) != Some(FORMAT_VERSION as u64) { return Err("不支持的迁移包版本".into()); }
    let database_len = read_u64(&package, &mut offset)?;
    let key_len = read_u32(&package, &mut offset)? as u64;
    let database = read_bytes(&package, &mut offset, database_len)?;
    let key = read_bytes(&package, &mut offset, key_len)?;
    let database_hash = digest(database);
    let key_hash = digest(key);
    if offset != package.len() || key.len() != 32 || manifest.get("database_sha256").and_then(|value| value.as_str()) != Some(database_hash.as_str()) || manifest.get("key_sha256").and_then(|value| value.as_str()) != Some(key_hash.as_str()) { return Err("迁移包校验失败，文件可能已损坏或被篡改".into()); }
    let data = data_dir()?;
    let import_db = data.join(format!(".cloudhub-import-{}.sqlite3", Uuid::new_v4()));
    fs::write(&import_db, database).map_err(|error| format!("准备导入数据库失败: {error}"))?;
    let result = (|| {
        validate_database(&import_db)?;
        let current_db = data.join("cloudhub_tools.sqlite3");
        let current_key = data.join(".key");
        let stamp = Utc::now().format("%Y%m%d-%H%M%S");
        let backup_db = data.join(format!("cloudhub_tools.sqlite3.before-import-{stamp}-{}", &Uuid::new_v4().to_string()[..8]));
        let backup_key = data.join(format!(".key.before-import-{stamp}-{}", &Uuid::new_v4().to_string()[..8]));
        let import_key = data.join(format!(".cloudhub-import-key-{}", Uuid::new_v4()));
        fs::write(&import_key, key).map_err(|error| format!("准备导入密钥失败: {error}"))?;
        if current_db.exists() { fs::rename(&current_db, &backup_db).map_err(|error| format!("备份当前数据库失败: {error}"))?; }
        if let Err(error) = fs::rename(&import_db, &current_db) {
            if backup_db.exists() { let _ = fs::rename(&backup_db, &current_db); }
            let _ = fs::remove_file(&import_key);
            return Err(format!("替换数据库失败: {error}"));
        }
        if current_key.exists() { fs::rename(&current_key, &backup_key).map_err(|error| { let _ = fs::rename(&current_db, &import_db); let _ = fs::rename(&backup_db, &current_db); let _ = fs::remove_file(&import_key); format!("备份当前密钥失败: {error}") })?; }
        if let Err(error) = fs::rename(&import_key, &current_key) {
            let _ = fs::remove_file(&current_db);
            if backup_db.exists() { let _ = fs::rename(&backup_db, &current_db); }
            if backup_key.exists() { let _ = fs::rename(&backup_key, &current_key); }
            return Err(format!("替换密钥失败: {error}"));
        }
        Ok(format!("已导入数据库，并保留导入前备份：{}", backup_db.to_string_lossy()))
    })();
    let _ = fs::remove_file(&import_db);
    result.map(Some)
}

fn replace_prepared_database(import_db: &Path, key: &[u8]) -> Result<String, String> {
    let data = data_dir()?;
    validate_database(import_db)?;
    let current_db = data.join("cloudhub_tools.sqlite3");
    let current_key = data.join(".key");
    let stamp = Utc::now().format("%Y%m%d-%H%M%S");
    let backup_db = data.join(format!("cloudhub_tools.sqlite3.before-import-{stamp}-{}", &Uuid::new_v4().to_string()[..8]));
    let backup_key = data.join(format!(".key.before-import-{stamp}-{}", &Uuid::new_v4().to_string()[..8]));
    let import_key = data.join(format!(".cloudhub-import-key-{}", Uuid::new_v4()));
    fs::write(&import_key, key).map_err(|error| format!("准备导入密钥失败: {error}"))?;
    if current_db.exists() { fs::rename(&current_db, &backup_db).map_err(|error| format!("备份当前数据库失败: {error}"))?; }
    if let Err(error) = fs::rename(import_db, &current_db) {
        if backup_db.exists() { let _ = fs::rename(&backup_db, &current_db); }
        let _ = fs::remove_file(&import_key);
        return Err(format!("替换数据库失败: {error}"));
    }
    if current_key.exists() { fs::rename(&current_key, &backup_key).map_err(|error| { let _ = fs::rename(&current_db, import_db); let _ = fs::rename(&backup_db, &current_db); let _ = fs::remove_file(&import_key); format!("备份当前密钥失败: {error}") })?; }
    if let Err(error) = fs::rename(&import_key, &current_key) {
        let _ = fs::remove_file(&current_db);
        if backup_db.exists() { let _ = fs::rename(&backup_db, &current_db); }
        if backup_key.exists() { let _ = fs::rename(&backup_key, &current_key); }
        return Err(format!("替换密钥失败: {error}"));
    }
    Ok(format!("已导入数据库，并保留导入前备份：{}", backup_db.to_string_lossy()))
}

#[tauri::command]
pub(crate) fn prepare_database_import(app: tauri::AppHandle, state: tauri::State<'_, DatabaseImportStore>) -> Result<Option<ImportPreview>, String> {
    let Some(selected) = app.dialog().file().blocking_pick_file() else { return Ok(None) };
    let package_path = selected.into_path().map_err(|_| "当前平台返回了不支持的导入路径".to_string())?;
    let (database, key, manifest) = parse_package(&package_path)?;
    let data = data_dir()?;
    let token = Uuid::new_v4().to_string();
    let database_path = data.join(format!(".cloudhub-import-preview-{token}.sqlite3"));
    fs::write(&database_path, database).map_err(|error| format!("准备导入预览失败: {error}"))?;
    validate_database(&database_path)?;
    let package_name = package_path.file_name().and_then(|value| value.to_str()).unwrap_or("迁移包").to_string();
    let preview = build_preview(&database_path, &data.join("cloudhub_tools.sqlite3"), token.clone(), package_name.clone(), manifest.get("exported_at").and_then(|value| value.as_str()).unwrap_or("未知").to_string())?;
    state.sessions.lock().map_err(|_| "导入预览状态不可用".to_string())?.insert(token, PreparedImport { database_path, key });
    Ok(Some(preview))
}

#[tauri::command]
pub(crate) fn confirm_database_import(state: tauri::State<'_, DatabaseImportStore>, token: String) -> Result<String, String> {
    let prepared = state.sessions.lock().map_err(|_| "导入预览状态不可用".to_string())?.remove(&token).ok_or_else(|| "导入预览已失效，请重新选择文件".to_string())?;
    let result = replace_prepared_database(&prepared.database_path, &prepared.key);
    let _ = fs::remove_file(&prepared.database_path);
    result
}

#[tauri::command]
pub(crate) fn cancel_database_import(state: tauri::State<'_, DatabaseImportStore>, token: String) -> Result<(), String> {
    let prepared = state.sessions.lock().map_err(|_| "导入预览状态不可用".to_string())?.remove(&token).ok_or_else(|| "导入预览已失效".to_string())?;
    fs::remove_file(&prepared.database_path).map_err(|error| format!("清理导入预览失败: {error}"))
}
