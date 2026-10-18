use crate::core::storage::{data_dir, open_db};
use crate::core::crypto::crypto_key_bytes;
use crate::core::error::PlatformResult;
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

fn ensure_database_file_migration_supported() -> Result<(), String> {
    #[cfg(mobile)]
    { return Err("手机端不支持整库文件迁移；请使用口令加密的配置迁移包".into()); }
    #[cfg(not(mobile))]
    { Ok(()) }
}

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

fn backups_dir() -> Result<PathBuf, String> {
    let path = data_dir()?.join("backups");
    fs::create_dir_all(&path).map_err(|error| format!("创建备份目录失败: {error}"))?;
    Ok(path)
}

fn backup_path(id: &str) -> Result<PathBuf, String> {
    let parsed = Uuid::parse_str(id).map_err(|_| "备份记录无效".to_string())?;
    Ok(backups_dir()?.join(format!("{parsed}.chdb")))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DatabaseBackupRecord { pub(crate) id: String, pub(crate) file_name: String, pub(crate) created_at: String, pub(crate) size_bytes: u64 }

fn package_bytes(database: &[u8], key: &[u8]) -> Result<Vec<u8>, String> {
    let manifest = serde_json::to_vec(&json!({
        "format": "cloudhub-tools-database-migration", "version": FORMAT_VERSION,
        "exported_at": Utc::now().to_rfc3339(), "database_sha256": digest(database), "key_sha256": digest(key),
    })).map_err(|error| format!("生成迁移包信息失败: {error}"))?;
    let mut package = Vec::with_capacity(8 + 4 + manifest.len() + 8 + 4 + database.len() + key.len());
    package.extend_from_slice(MAGIC);
    write_u32(&mut package, manifest.len().try_into().map_err(|_| "迁移包信息过大")?);
    package.extend_from_slice(&manifest);
    write_u64(&mut package, database.len().try_into().map_err(|_| "数据库过大")?);
    write_u32(&mut package, key.len().try_into().map_err(|_| "密钥文件无效")?);
    package.extend_from_slice(database);
    package.extend_from_slice(key);
    if package.len() as u64 > MAX_PACKAGE_BYTES { return Err("迁移包超过 4 GB 限制".into()); }
    Ok(package)
}

fn create_package_file(target: &Path) -> Result<(), String> {
    let data = data_dir()?;
    let snapshot = data.join(format!(".cloudhub-export-{}.sqlite3", Uuid::new_v4()));
    let result = (|| {
        snapshot_database(&snapshot)?;
        let database = fs::read(&snapshot).map_err(|error| format!("读取 SQLite 快照失败: {error}"))?;
        let package = package_bytes(&database, &crypto_key_bytes()?)?;
        fs::write(target, package).map_err(|error| format!("写入备份失败: {error}"))
    })();
    let _ = fs::remove_file(snapshot);
    result
}

fn backup_record(path: &Path) -> Result<DatabaseBackupRecord, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("读取备份信息失败: {error}"))?;
    let id = path.file_stem().and_then(|value| value.to_str()).ok_or("备份记录无效")?.to_string();
    let modified = metadata.modified().map(chrono::DateTime::<Utc>::from).ok();
    let created_at = modified.map(|time| time.to_rfc3339()).unwrap_or_else(|| "未知".into());
    let fallback_name = modified.map(|time| format!("cloudhub-tools-backup-{}.chdb", time.format("%Y%m%d-%H%M%S"))).unwrap_or_else(|| "cloudhub-tools-backup.chdb".into());
    let file_name = fs::read_to_string(path.with_extension("name")).ok().filter(|name| !name.trim().is_empty()).unwrap_or(fallback_name);
    Ok(DatabaseBackupRecord { id, file_name, created_at, size_bytes: metadata.len() })
}

fn save_backup_display_name(path: &Path, file_name: &str) -> Result<(), String> {
    fs::write(path.with_extension("name"), file_name).map_err(|error| format!("保存备份文件名失败: {error}"))
}

fn snapshot_database(target: &Path) -> Result<(), String> {
    let conn = open_db()?;
    let escaped = target.to_string_lossy().replace('\'', "''");
    conn.execute_batch(&format!("VACUUM INTO '{}';", escaped))
        .map_err(|error| format!("创建 SQLite 快照失败: {error}"))
}

fn preserve_local_codex(incoming: &Path, current: &Path, current_key: &[u8], incoming_key: &[u8]) -> Result<(), String> {
    use crate::core::crypto::{decrypt_secret_with_key, encrypt_secret_with_key};
    let mut destination = Connection::open(incoming).map_err(|_| "无法准备本机 Codex 数据保留")?;
    let source = if current.exists() { Some(Connection::open(current).map_err(|_| "无法读取本机 Codex 数据")?) } else { None };
    let tx = destination.transaction().map_err(|_| "无法准备 Codex 数据事务")?;
    // Only the staged incoming copy is rebuilt. Incoming Codex data is never authoritative,
    // and its older profile schema must not prevent preserving newer local profile columns.
    tx.execute_batch("DROP TABLE IF EXISTS codex_profiles; DROP TABLE IF EXISTS codex_accounts; DROP TABLE IF EXISTS codex_profile_backups; DROP TABLE IF EXISTS codex_gateway_config; DROP TABLE IF EXISTS codex_gateway_pool; DROP TABLE IF EXISTS codex_gateway_network;").map_err(|_|"隔离迁移包 Codex 数据失败")?;
    tx.execute_batch(crate::core::database::CODEX_SCHEMA).map_err(|_|"无法准备 Codex 数据表")?;
    tx.execute_batch("DROP TABLE IF EXISTS codex_gateway_tunnel; CREATE TABLE codex_gateway_tunnel(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);").map_err(|_| "隔离穿透配置失败")?;
    for (table, columns, secret_index) in [
        ("codex_accounts", "id,identity,label,email,account_id,auth_mode,plan,note,tags_json,auth_ciphertext,quota_json,last_error,updated_at", Some(9usize)),
        ("codex_profile_backups", "profile_home,auth_ciphertext,installed_fingerprint,previous_fingerprint", Some(1usize)),
        ("codex_profiles", "id,account_id,name,work_dir,created_at,auth_fingerprint,kind", None),
        ("codex_gateway_config", "id,port,key_ciphertext,auto_start,account_ids_json", Some(2usize)),
        ("codex_gateway_pool", "id,account_ids_json", None),
        ("codex_gateway_network", "id,allow_lan", None),
    ] {
        tx.execute(&format!("DELETE FROM {table}"), []).map_err(|_| "隔离迁移包 Codex 数据失败")?;
        let Some(ref source) = source else { continue; };
        if !table_exists(source, table)? || table_count(source, table)? == 0 { continue; }
        let count = columns.split(',').count();
        let selection=if table=="codex_profiles" {
            let mut schema=source.prepare("PRAGMA table_info(codex_profiles)").map_err(|_|"读取本机 Codex 实例结构失败")?;
            let present=schema.query_map([],|row|row.get::<_,String>(1)).map_err(|_|"读取本机 Codex 实例结构失败")?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_|"读取本机 Codex 实例结构失败")?;
            columns.split(',').map(|column|if !present.iter().any(|v|v==column)&&column=="kind"{"'cli'"}else if !present.iter().any(|v|v==column)&&column=="auth_fingerprint"{"NULL"}else{column}).collect::<Vec<_>>().join(",")
        }else{columns.to_string()};
        let mut statement = source.prepare(&format!("SELECT {selection} FROM {table}")).map_err(|_| "读取本机 Codex 数据失败")?;
        let rows = statement.query_map([], |row| (0..count).map(|index| row.get::<_, rusqlite::types::Value>(index)).collect::<rusqlite::Result<Vec<_>>>()).map_err(|_| "读取本机 Codex 数据失败")?;
        let placeholders = (1..=count).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",");
        for row in rows {
            let mut values = row.map_err(|_| "读取本机 Codex 数据失败")?;
            if let Some(secret_index) = secret_index {
                if let rusqlite::types::Value::Text(ref ciphertext) = values[secret_index] {
                    let secret = zeroize::Zeroizing::new(decrypt_secret_with_key(ciphertext, current_key).map_err(|_| "解密本机 Codex 数据失败")?);
                    values[secret_index] = rusqlite::types::Value::Text(encrypt_secret_with_key(&secret, incoming_key).map_err(|_| "重新加密本机 Codex 数据失败")?);
                }
            }
            tx.execute(&format!("INSERT INTO {table}({columns}) VALUES({placeholders})"), rusqlite::params_from_iter(values)).map_err(|_| "保留本机 Codex 数据失败")?;
        }
    }
    tx.commit().map_err(|_| "提交本机 Codex 数据失败".into())
}

fn preserve_local_authenticator(incoming: &Path, current: &Path) -> Result<(), String> {
    use crate::core::repositories::authenticator::{self, SCHEMA};
    let mut destination = Connection::open(incoming).map_err(|_| "无法准备本机验证器保留")?;
    destination.execute_batch(SCHEMA).map_err(|_| "无法准备验证器数据表")?;
    let transaction = destination.transaction().map_err(|_| "无法开始验证器保留事务")?;
    transaction.execute_batch("DELETE FROM authenticator_entries; DELETE FROM authenticator_vault;").map_err(|_| "无法隔离迁移包验证器")?;
    if current.exists() {
        let source = Connection::open(current).map_err(|_| "无法读取本机验证器")?;
        let exists: bool = source.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='authenticator_vault' AND type='table')", [], |row| row.get(0)).map_err(|_| "无法检查本机验证器")?;
        if exists {
            if let Some(header) = authenticator::header(&source)? {
                transaction.execute("INSERT INTO authenticator_vault(id,envelope_json) VALUES(1,?1)", [header]).map_err(|_| "无法保留验证器密码库")?;
                let mut statement = source.prepare("SELECT id,ciphertext FROM authenticator_entries").map_err(|_| "无法读取本机验证码")?;
                let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).map_err(|_| "无法读取本机验证码")?;
                for row in rows {
                    let (id, ciphertext) = row.map_err(|_| "无法读取本机验证码")?;
                    transaction.execute("INSERT INTO authenticator_entries(id,name,ciphertext) VALUES(?1,'',?2)", rusqlite::params![id,ciphertext]).map_err(|_| "无法保留本机验证码")?;
                }
            }
        }
    }
    transaction.commit().map_err(|_| "无法提交验证器保留事务".into())
}

fn lock_authenticator_for_migration(app: &tauri::AppHandle) {
    #[cfg(desktop)]
    { use tauri::Manager; app.state::<crate::core::authenticator::vault::VaultStore>().lock(); }
    #[cfg(mobile)]
    let _ = app;
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

fn reset_imported_sync_identity(path: &Path) -> Result<(), String> {
    let mut conn = Connection::open(path).map_err(|error| format!("打开导入数据库失败: {error}"))?;
    let has_local_device: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_local_device')", [], |row| row.get(0)).map_err(|error| error.to_string())?;
    if !has_local_device { return Ok(()); }
    let has_acknowledgements: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_outbox_acknowledgements')", [], |row| row.get(0)).map_err(|error| error.to_string())?;
    let has_inbox: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_inbox')", [], |row| row.get(0)).map_err(|error| error.to_string())?;
    let has_local_public_key: bool = conn.prepare("PRAGMA table_info(sync_local_device)").map_err(|error| error.to_string())?
        .query_map([], |row| row.get::<_, String>(1)).map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?.iter().any(|column| column == "public_key");

    let transaction = conn.transaction().map_err(|error| format!("开启设备授权重置事务失败: {error}"))?;
    transaction.execute("DELETE FROM sync_entity_versions", []).map_err(|error| error.to_string())?;
    if has_inbox { transaction.execute("DELETE FROM sync_inbox", []).map_err(|error| error.to_string())?; }
    if has_acknowledgements { transaction.execute("DELETE FROM sync_outbox_acknowledgements", []).map_err(|error| error.to_string())?; }
    transaction.execute("DELETE FROM sync_devices", []).map_err(|error| error.to_string())?;
    transaction.execute("DELETE FROM sync_outbox", []).map_err(|error| error.to_string())?;
    transaction.execute("DELETE FROM sync_tombstones", []).map_err(|error| error.to_string())?;
    transaction.execute("DELETE FROM sync_local_versions", []).map_err(|error| error.to_string())?;
    if has_local_public_key {
        transaction.execute("UPDATE sync_local_device SET device_id=?1,device_name='本机',created_at=?2,public_key=NULL WHERE id=1", rusqlite::params![Uuid::new_v4().to_string(), Utc::now().timestamp_millis()]).map_err(|error| error.to_string())?;
    } else {
        transaction.execute("UPDATE sync_local_device SET device_id=?1,device_name='本机',created_at=?2 WHERE id=1", rusqlite::params![Uuid::new_v4().to_string(), Utc::now().timestamp_millis()]).map_err(|error| error.to_string())?;
    }
    transaction.execute("DELETE FROM client_preferences WHERE key='sync.identity.signing_seed'", []).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| format!("提交设备授权重置失败: {error}"))
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

fn table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)", [table], |row| row.get(0)).map_err(|_| "检查迁移包数据表失败".into())
}

fn build_preview(database_path: &Path, current_db: &Path, token: String, package_name: String, exported_at: String) -> Result<ImportPreview, String> {
    let imported = Connection::open(database_path).map_err(|error| format!("打开导入数据库失败: {error}"))?;
    let labels = [("cloud_accounts", "云账号"), ("cloud_assets", "云资产"), ("ssh_connections", "SSH 连接"), ("rdp_connections", "RDP 连接"), ("managed_hosts", "托管主机"), ("panel_connections", "面板连接"), ("operation_logs", "操作日志"), ("api_logs", "API 日志"), ("client_preferences", "客户端设置")];
    let mut categories = Vec::new(); let mut total_records = 0;
    for (table, label) in labels { let count = table_count(&imported, table)?; total_records += count; categories.push(ImportCategory { label: label.into(), count }); }
    let mut details = vec!["验证器由独立备份管理：整库导入保留本机验证器，请在验证器页面迁移验证码。".into()]; let mut incoming_keys = HashMap::new();
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
pub(crate) fn export_database_file(app: tauri::AppHandle) -> PlatformResult<Option<String>> {
    ensure_database_file_migration_supported()?;
    let result = (|| {
        let Some(selected) = app.dialog().file().set_file_name(format!("cloudhub-tools-backup-{}.chdb", Utc::now().format("%Y%m%d-%H%M%S"))).blocking_save_file() else { return Ok(None) };
        let path = selected.into_path().map_err(|_| "当前平台返回了不支持的导出路径".to_string())?;
        create_package_file(&path)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })();
    result
}

#[tauri::command]
pub(crate) fn list_database_backups() -> PlatformResult<Vec<DatabaseBackupRecord>> {
    ensure_database_file_migration_supported()?;
    let mut records = Vec::new();
    for entry in fs::read_dir(backups_dir()?).map_err(|error| format!("读取备份列表失败: {error}"))? {
        let path = entry.map_err(|error| format!("读取备份列表失败: {error}"))?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("chdb") { continue; }
        if Uuid::parse_str(path.file_stem().and_then(|value| value.to_str()).unwrap_or_default()).is_ok() {
            if let Ok(record) = backup_record(&path) { records.push(record); }
        }
    }
    records.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(records)
}

#[tauri::command]
pub(crate) fn create_database_backup() -> PlatformResult<DatabaseBackupRecord> {
    ensure_database_file_migration_supported()?;
    let id = Uuid::new_v4().to_string();
    let path = backups_dir()?.join(format!("{id}.chdb"));
    create_package_file(&path)?;
    save_backup_display_name(&path, &format!("cloudhub-tools-backup-{}.chdb", Utc::now().format("%Y%m%d-%H%M%S")))?;
    Ok(backup_record(&path)?)
}

#[tauri::command]
pub(crate) fn download_database_backup(app: tauri::AppHandle, id: String) -> PlatformResult<Option<String>> {
    ensure_database_file_migration_supported()?;
    let source = backup_path(&id)?;
    if !source.is_file() { return Err("找不到这条备份记录".into()); }
    let Some(selected) = app.dialog().file().set_file_name(format!("cloudhub-tools-backup-{}.chdb", Utc::now().format("%Y%m%d-%H%M%S"))).blocking_save_file() else { return Ok(None) };
    let target = selected.into_path().map_err(|_| "当前平台返回了不支持的导出路径".to_string())?;
    fs::copy(source, &target).map_err(|error| format!("下载备份失败: {error}"))?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

#[tauri::command]
pub(crate) fn delete_database_backup(id: String) -> PlatformResult<()> {
    ensure_database_file_migration_supported()?;
    let path = backup_path(&id)?;
    if path.exists() { fs::remove_file(&path).map_err(|error| format!("删除备份失败: {error}"))?; }
    let _ = fs::remove_file(path.with_extension("name"));
    Ok(())
}

#[tauri::command]
pub(crate) fn import_database_backup(app: tauri::AppHandle) -> PlatformResult<Option<DatabaseBackupRecord>> {
    ensure_database_file_migration_supported()?;
    let Some(selected) = app.dialog().file().blocking_pick_file() else { return Ok(None) };
    let source = selected.into_path().map_err(|_| "当前平台返回了不支持的导入路径".to_string())?;
    let mut signature = [0u8; 8];
    use std::io::Read;
    fs::File::open(&source).and_then(|mut file| file.read_exact(&mut signature)).map_err(|_| "无法读取备份文件".to_string())?;
    if &signature != MAGIC { return Err("请选择 CloudHub 完整备份文件（.chdb）".into()); }
    let (database, _, manifest) = parse_package(&source)?;
    if manifest.get("format").and_then(|value| value.as_str()) != Some("cloudhub-tools-database-migration") { return Err("请选择 CloudHub 完整备份文件（.chdb）".into()); }
    let temp = data_dir()?.join(format!(".cloudhub-backup-validate-{}.sqlite3", Uuid::new_v4()));
    let validation = (|| { fs::write(&temp, database).map_err(|error| format!("校验备份失败: {error}"))?; validate_database(&temp) })();
    let _ = fs::remove_file(temp);
    validation?;
    let target = backups_dir()?.join(format!("{}.chdb", Uuid::new_v4()));
    fs::copy(&source, &target).map_err(|error| format!("导入备份文件失败: {error}"))?;
    let file_name = source.file_name().and_then(|name| name.to_str()).filter(|name| !name.trim().is_empty()).unwrap_or("导入备份.chdb");
    save_backup_display_name(&target, file_name)?;
    Ok(Some(backup_record(&target)?))
}

#[tauri::command]
pub(crate) fn import_database_file(app: tauri::AppHandle) -> PlatformResult<Option<String>> {
    ensure_database_file_migration_supported()?;
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
        #[cfg(desktop)]
        let _codex_writer = super::codex::AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        #[cfg(desktop)]
        { use tauri::Manager; super::codex_instances::ensure_idle(&app.state::<super::codex_runtime::CodexRuntimeStore>())?; }
        validate_database(&import_db)?;
        let current_db = data.join("cloudhub_tools.sqlite3");
        lock_authenticator_for_migration(&app);
        preserve_local_authenticator(&import_db, &current_db)?;
        preserve_local_codex(&import_db, &current_db, &crypto_key_bytes()?, key)?;
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
    Ok(result.map(Some)?)
}

fn replace_prepared_database(import_db: &Path, key: &[u8]) -> Result<String, String> {
    let data = data_dir()?;
    validate_database(import_db)?;
    let current_db = data.join("cloudhub_tools.sqlite3");
    preserve_local_authenticator(import_db, &current_db)?;
    preserve_local_codex(import_db, &current_db, &crypto_key_bytes()?, key)?;
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
pub(crate) fn prepare_database_import(app: tauri::AppHandle, state: tauri::State<'_, DatabaseImportStore>) -> PlatformResult<Option<ImportPreview>> {
    ensure_database_file_migration_supported()?;
    let Some(selected) = app.dialog().file().blocking_pick_file() else { return Ok(None) };
    let package_path = selected.into_path().map_err(|_| "当前平台返回了不支持的导入路径".to_string())?;
    let (database, key, manifest) = parse_package(&package_path)?;
    let data = data_dir()?;
    let token = Uuid::new_v4().to_string();
    let database_path = data.join(format!(".cloudhub-import-preview-{token}.sqlite3"));
    fs::write(&database_path, database).map_err(|error| format!("准备导入预览失败: {error}"))?;
    validate_database(&database_path)?;
    reset_imported_sync_identity(&database_path)?;
    let package_name = package_path.file_name().and_then(|value| value.to_str()).unwrap_or("迁移包").to_string();
    let preview = build_preview(&database_path, &data.join("cloudhub_tools.sqlite3"), token.clone(), package_name.clone(), manifest.get("exported_at").and_then(|value| value.as_str()).unwrap_or("未知").to_string())?;
    state.sessions.lock().map_err(|_| "导入预览状态不可用".to_string())?.insert(token, PreparedImport { database_path, key });
    Ok(Some(preview))
}

#[tauri::command]
pub(crate) fn prepare_database_backup_restore(id: String, state: tauri::State<'_, DatabaseImportStore>) -> PlatformResult<Option<ImportPreview>> {
    ensure_database_file_migration_supported()?;
    let package_path = backup_path(&id)?;
    if !package_path.is_file() { return Err("找不到这条备份记录".into()); }
    let (database, key, manifest) = parse_package(&package_path)?;
    let data = data_dir()?;
    let token = Uuid::new_v4().to_string();
    let database_path = data.join(format!(".cloudhub-import-preview-{token}.sqlite3"));
    fs::write(&database_path, database).map_err(|error| format!("准备导入预览失败: {error}"))?;
    validate_database(&database_path)?;
    reset_imported_sync_identity(&database_path)?;
    let preview = build_preview(&database_path, &data.join("cloudhub_tools.sqlite3"), token.clone(), "本机备份".into(), manifest.get("exported_at").and_then(|value| value.as_str()).unwrap_or("未知").to_string())?;
    state.sessions.lock().map_err(|_| "导入预览状态不可用".to_string())?.insert(token, PreparedImport { database_path, key });
    Ok(Some(preview))
}

#[cfg(test)]
mod tests {
    use super::{reset_imported_sync_identity, preserve_local_authenticator, preserve_local_codex};

    #[test]
    fn codex_stays_local_and_is_reencrypted_when_database_key_changes() {
        use crate::core::crypto::{encrypt_secret_with_key, decrypt_secret_with_key};
        let root = std::env::temp_dir().join(format!("cloudhub-codex-migration-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let current = root.join("current.sqlite3");
        let incoming = root.join("incoming.sqlite3");
        let old_key = [11u8;32];
        let new_key = [12u8;32];
        for (path, label, key) in [(&current,"local",&old_key),(&incoming,"incoming",&new_key)] {
            let conn = Connection::open(path).unwrap();
            conn.execute_batch(crate::core::database::CODEX_SCHEMA).unwrap();
            conn.execute_batch(crate::core::repositories::authenticator::SCHEMA).unwrap();
            let cipher = encrypt_secret_with_key("invalid-test-only", key).unwrap();
            conn.execute("INSERT INTO codex_accounts(identity,label,auth_mode,auth_ciphertext,updated_at) VALUES('id',?1,'chatgpt',?2,1)", rusqlite::params![label,cipher]).unwrap();
            conn.execute("INSERT INTO codex_profile_backups VALUES('test-home',?1,'after','before')", [&cipher]).unwrap();
            conn.execute("INSERT INTO codex_gateway_config(id,port,key_ciphertext) VALUES(1,58169,?1)", [&cipher]).unwrap();
            conn.execute_batch("CREATE TABLE IF NOT EXISTS codex_gateway_tunnel(id INTEGER PRIMARY KEY,json TEXT NOT NULL); INSERT INTO codex_gateway_tunnel VALUES(1,'{\"enabled\":true}');").unwrap();
            conn.execute("INSERT INTO codex_profiles(id,account_id,name,work_dir,created_at,auth_fingerprint,kind) VALUES('test-profile',1,'fixture','fixture-project',1,'projection','desktop')", []).unwrap();
            if path == &incoming {
                conn.execute_batch("ALTER TABLE codex_profiles DROP COLUMN kind; ALTER TABLE codex_profiles DROP COLUMN auth_fingerprint;").unwrap();
            }
        }
        preserve_local_codex(&incoming, &current, &old_key, &new_key).unwrap();
        let conn = Connection::open(&incoming).unwrap();
        let (label, cipher): (String,String) = conn.query_row("SELECT label,auth_ciphertext FROM codex_accounts", [], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(label,"local");
        assert_eq!(conn.query_row("SELECT count(*) FROM codex_gateway_tunnel", [], |row| row.get::<_,i64>(0)).unwrap(), 0);
        let (port, gateway_cipher): (u16,String) = conn.query_row("SELECT port,key_ciphertext FROM codex_gateway_config", [], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(port,58169);
        assert_eq!(decrypt_secret_with_key(&gateway_cipher,&new_key).unwrap(),"invalid-test-only");
        assert!(decrypt_secret_with_key(&gateway_cipher,&old_key).is_err());
        assert_eq!(decrypt_secret_with_key(&cipher,&new_key).unwrap(),"invalid-test-only");
        assert!(decrypt_secret_with_key(&cipher,&old_key).is_err());
        let profile: (String,Option<String>) = conn.query_row("SELECT kind,auth_fingerprint FROM codex_profiles", [], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(profile,("desktop".into(),Some("projection".into())));
        drop(conn);
        // Local profiles created before either column existed still survive a key migration.
        Connection::open(&current).unwrap().execute_batch("ALTER TABLE codex_profiles DROP COLUMN kind; ALTER TABLE codex_profiles DROP COLUMN auth_fingerprint;").unwrap();
        preserve_local_codex(&incoming, &current, &old_key, &new_key).unwrap();
        let profile: (String,Option<String>) = Connection::open(&incoming).unwrap().query_row("SELECT kind,auth_fingerprint FROM codex_profiles", [], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(profile,("cli".into(),None));
        assert_eq!(Connection::open(&current).unwrap().query_row("SELECT COUNT(*) FROM codex_accounts", [], |row| row.get::<_,i64>(0)).unwrap(),1);
        fs::remove_dir_all(root).unwrap();
    }
    use rusqlite::Connection;
    use std::{fs, path::PathBuf};
    use uuid::Uuid;

    #[test]
    fn authenticator_from_current_device_is_preserved_when_importing() {
        let current = std::env::temp_dir().join(format!("auth-current-{}.sqlite3", Uuid::new_v4()));
        let incoming = std::env::temp_dir().join(format!("auth-incoming-{}.sqlite3", Uuid::new_v4()));
        for (path, header, ciphertext) in [(&current, "local-encrypted-header", "local-encrypted-entry"), (&incoming, "incoming-encrypted-header", "incoming-encrypted-entry")] {
            let connection = Connection::open(path).unwrap();
            connection.execute_batch(crate::core::repositories::authenticator::SCHEMA).unwrap();
            connection.execute("INSERT INTO authenticator_vault VALUES(1,?1)", [header]).unwrap();
            connection.execute("INSERT INTO authenticator_entries(id,ciphertext) VALUES('example',?1)", [ciphertext]).unwrap();
        }
        preserve_local_authenticator(&incoming, &current).unwrap();
        let connection = Connection::open(&incoming).unwrap();
        assert_eq!(connection.query_row("SELECT envelope_json FROM authenticator_vault", [], |row| row.get::<_, String>(0)).unwrap(), "local-encrypted-header");
        assert_eq!(connection.query_row("SELECT ciphertext FROM authenticator_entries", [], |row| row.get::<_, String>(0)).unwrap(), "local-encrypted-entry");
        drop(connection);
        fs::remove_file(current).unwrap();
        fs::remove_file(incoming).unwrap();
    }

    #[test]
    fn database_import_rotates_device_identity_and_drops_old_trust() {
        let path: PathBuf = std::env::temp_dir().join(format!("cloudhub-sync-import-{}.sqlite3", Uuid::new_v4()));
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE sync_local_device(id INTEGER PRIMARY KEY,device_id TEXT,device_name TEXT,created_at INTEGER,public_key BLOB); CREATE TABLE sync_devices(device_id TEXT PRIMARY KEY); CREATE TABLE sync_entity_versions(peer_device_id TEXT,entity_type TEXT,entity_sync_id TEXT); CREATE TABLE sync_outbox(message_id TEXT); CREATE TABLE sync_outbox_acknowledgements(message_id TEXT,peer_device_id TEXT); CREATE TABLE sync_inbox(peer_device_id TEXT,message_id TEXT); CREATE TABLE sync_tombstones(entity_type TEXT,entity_sync_id TEXT); CREATE TABLE sync_local_versions(entity_type TEXT,entity_sync_id TEXT,counter INTEGER); CREATE TABLE cloud_accounts(id INTEGER PRIMARY KEY,sync_id TEXT); CREATE TABLE client_preferences(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER); INSERT INTO sync_local_device VALUES(1,'old-local','old-device',1,X'01'); INSERT INTO sync_devices VALUES('old-peer'); INSERT INTO sync_entity_versions VALUES('old-peer','cloud_account','account-1'); INSERT INTO sync_outbox VALUES('queued'); INSERT INTO sync_outbox_acknowledgements VALUES('queued','old-peer'); INSERT INTO sync_inbox VALUES('old-peer','received'); INSERT INTO sync_tombstones VALUES('cloud_account','deleted-account'); INSERT INTO sync_local_versions VALUES('cloud_account','account-1',4); INSERT INTO client_preferences VALUES('sync.identity.signing_seed','encrypted-seed',1); INSERT INTO cloud_accounts VALUES(1,'account-1');").unwrap();
        drop(conn);

        reset_imported_sync_identity(&path).unwrap();
        let conn = Connection::open(&path).unwrap();
        let (device_id, name): (String, String) = conn.query_row("SELECT device_id,device_name FROM sync_local_device WHERE id=1", [], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_ne!(device_id, "old-local");
        assert_eq!(name, "本机");
        let public_key: Option<Vec<u8>> = conn.query_row("SELECT public_key FROM sync_local_device WHERE id=1", [], |row| row.get(0)).unwrap();
        assert!(public_key.is_none());
        let seed_pref: i64 = conn.query_row("SELECT COUNT(*) FROM client_preferences WHERE key='sync.identity.signing_seed'", [], |row| row.get(0)).unwrap();
        assert_eq!(seed_pref, 0);
        for table in ["sync_devices","sync_entity_versions","sync_outbox","sync_outbox_acknowledgements","sync_inbox","sync_tombstones","sync_local_versions"] {
            let count: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0)).unwrap();
            assert_eq!(count, 0, "{table} should not be cloned to the importing device");
        }
        let account_sync_id: String = conn.query_row("SELECT sync_id FROM cloud_accounts WHERE id=1", [], |row| row.get(0)).unwrap();
        assert_eq!(account_sync_id, "account-1");
        drop(conn);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn legacy_database_without_sync_schema_is_unchanged() {
        let path: PathBuf = std::env::temp_dir().join(format!("cloudhub-legacy-import-{}.sqlite3", Uuid::new_v4()));
        Connection::open(&path).unwrap().execute_batch("CREATE TABLE cloud_accounts(id INTEGER PRIMARY KEY); INSERT INTO cloud_accounts VALUES(1);").unwrap();
        reset_imported_sync_identity(&path).unwrap();
        let count: i64 = Connection::open(&path).unwrap().query_row("SELECT COUNT(*) FROM cloud_accounts", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 1);
        fs::remove_file(path).unwrap();
    }
}

#[tauri::command]
pub(crate) fn confirm_database_import(app: tauri::AppHandle, state: tauri::State<'_, DatabaseImportStore>, token: String) -> PlatformResult<String> {
    ensure_database_file_migration_supported()?;
    #[cfg(desktop)]
    let _codex_writer = super::codex::AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
    #[cfg(desktop)]
    { use tauri::Manager; super::codex_instances::ensure_idle(&app.state::<super::codex_runtime::CodexRuntimeStore>())?; }
    let prepared = state.sessions.lock().map_err(|_| "导入预览状态不可用".to_string())?.remove(&token).ok_or_else(|| "导入预览已失效，请重新选择文件".to_string())?;
    lock_authenticator_for_migration(&app);
    let result = replace_prepared_database(&prepared.database_path, &prepared.key);
    let _ = fs::remove_file(&prepared.database_path);
    Ok(result?)
}

#[tauri::command]
pub(crate) fn cancel_database_import(state: tauri::State<'_, DatabaseImportStore>, token: String) -> PlatformResult<()> {
    ensure_database_file_migration_supported()?;
    let prepared = state.sessions.lock().map_err(|_| "导入预览状态不可用".to_string())?.remove(&token).ok_or_else(|| "导入预览已失效".to_string())?;
    Ok(fs::remove_file(&prepared.database_path).map_err(|error| format!("清理导入预览失败: {error}"))?)
}
