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
use zeroize::Zeroizing;

#[path = "database_backup_crypto.rs"]
mod backup_crypto;
#[cfg(desktop)]
#[path = "database_browser.rs"]
pub(crate) mod browser;
#[path = "database_sql.rs"]
pub(crate) mod sql;

const MAGIC: &[u8; 8] = b"CHDBMIG1";
const FORMAT_VERSION: u32 = 1;
const MAX_PACKAGE_BYTES: u64 = backup_crypto::MAX_BYTES;
static TRANSFER_LOCK: Mutex<()> = Mutex::new(());

fn lock_transfer() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    TRANSFER_LOCK.lock().map_err(|_| "数据迁移状态不可用，请重启客户端".into())
}

fn ensure_database_file_migration_supported() -> Result<(), String> {
    // Imports now write portable rows using this device's key on every platform.
    Ok(())
}

#[derive(Default)]
pub(crate) struct DatabaseImportStore { sessions: Mutex<HashMap<String, PreparedImport>> }

struct PreparedImport { database_path: PathBuf, key: Zeroizing<Vec<u8>>, sql_mode: Option<String> }

impl Drop for PreparedImport {
    fn drop(&mut self) { let _ = fs::remove_file(&self.database_path); }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportPreview { pub(crate) token: String, pub(crate) package_name: String, pub(crate) exported_at: String, pub(crate) total_records: u64, pub(crate) categories: Vec<ImportCategory>, pub(crate) details: Vec<String>, pub(crate) conflicts: Vec<String>, pub(crate) import_mode: String }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportCategory { pub(crate) table: String, pub(crate) label: String, pub(crate) count: u64 }

#[tauri::command]
pub(crate) fn database_transfer_catalog() -> PlatformResult<Vec<ImportCategory>> {
    Ok(crate::core::data_transfer::TABLES.iter().map(|(table,label)| ImportCategory { table: (*table).into(), label: (*label).into(), count: 0 }).collect())
}

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
pub(crate) struct DatabaseBackupRecord { pub(crate) id: String, pub(crate) file_name: String, pub(crate) created_at: String, pub(crate) size_bytes: u64, pub(crate) encrypted: bool }

fn package_bytes(database: &[u8], key: &[u8]) -> Result<Vec<u8>, String> {
    let manifest = serde_json::to_vec(&json!({
        "format": "cloudhub-tools-database-migration", "version": FORMAT_VERSION,
        "exported_at": Utc::now().to_rfc3339(), "database_sha256": digest(database), "key_sha256": digest(key),
        "policy_version": crate::core::data_transfer::POLICY_VERSION,
        "tables": crate::core::data_transfer::TABLES.iter().map(|(table,_)| *table).collect::<Vec<_>>(),
    })).map_err(|error| format!("生成迁移包信息失败: {error}"))?;
    let mut package = Vec::with_capacity(8 + 4 + manifest.len() + 8 + 4 + database.len() + key.len());
    package.extend_from_slice(MAGIC);
    write_u32(&mut package, manifest.len().try_into().map_err(|_| "迁移包信息过大")?);
    package.extend_from_slice(&manifest);
    write_u64(&mut package, database.len().try_into().map_err(|_| "数据库过大")?);
    write_u32(&mut package, key.len().try_into().map_err(|_| "密钥文件无效")?);
    package.extend_from_slice(database);
    package.extend_from_slice(key);
    if package.len() as u64 > MAX_PACKAGE_BYTES { return Err("迁移包超过 256 MB 限制".into()); }
    Ok(package)
}

fn create_package_file(target: &Path, password: Option<&str>) -> Result<(), String> {
    if let Some(password) = password { backup_crypto::validate_password(password)?; }
    let data = data_dir()?;
    let snapshot = data.join(format!(".cloudhub-export-{}.sqlite3", Uuid::new_v4()));
    let result = (|| {
        snapshot_database(&snapshot)?;
        sanitize_snapshot(&snapshot)?;
        let database = Zeroizing::new(fs::read(&snapshot).map_err(|_| "读取 SQLite 快照失败")?);
        let key = Zeroizing::new(crypto_key_bytes()?);
        let package = Zeroizing::new(package_bytes(&database, &key)?);
        // Keep credential ciphertext unchanged and carry its recovery key in the package.
        match password {
            Some(password) => write_new_or_replace(target, &backup_crypto::seal(&package, password)?),
            None => write_new_or_replace(target, &package),
        }
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
    use std::io::Read;
    let mut signature = [0u8; 8];
    fs::File::open(path).and_then(|mut file| file.read_exact(&mut signature)).map_err(|_| "读取备份格式失败")?;
    Ok(DatabaseBackupRecord { id, file_name, created_at, size_bytes: metadata.len(), encrypted: &signature == backup_crypto::MAGIC })
}

fn write_new_or_replace(target: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let parent = target.parent().ok_or("保存位置无效")?;
    let temp = parent.join(format!(".cloudhub-write-{}", Uuid::new_v4()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(&temp).map_err(|_| "无法创建导出文件")?;
        file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|_| "无法写入导出文件")?;
        drop(file);
        // Keep an existing destination intact if Windows cannot replace it.
        fs::rename(&temp, target).map_err(|_| "无法保存文件，请选择新的文件名或检查权限")
    })();
    let _ = fs::remove_file(temp);
    Ok(result?)
}

fn save_backup_display_name(path: &Path, file_name: &str) -> Result<(), String> {
    fs::write(path.with_extension("name"), file_name).map_err(|error| format!("保存备份文件名失败: {error}"))
}

fn snapshot_database(target: &Path) -> Result<(), String> {
    snapshot_database_at(&data_dir()?.join("cloudhub_tools.sqlite3"), target)
}

pub(super) fn validate_cloud_password(password: &str) -> Result<(), String> {
    backup_crypto::validate_password(password)
}

pub(super) fn cloud_snapshot(password: Option<String>) -> Result<Vec<u8>, String> {
    let _transfer = lock_transfer()?;
    let password = password.map(Zeroizing::new);
    let snapshot = data_dir()?.join(format!(".cloudhub-cloud-{}.sqlite3", Uuid::new_v4()));
    let result = (|| {
        snapshot_database(&snapshot)?;
        sanitize_snapshot(&snapshot)?;
        {
            let conn = Connection::open(&snapshot).map_err(|_| "打开云备份快照失败")?;
            conn.execute_batch("PRAGMA secure_delete=ON; DELETE FROM client_preferences WHERE key LIKE 'cloud.sync.%'; VACUUM;")
                .map_err(|_| "清理云备份连接配置失败")?;
        }
        let database = Zeroizing::new(fs::read(&snapshot).map_err(|_| "读取云备份快照失败")?);
        let key = Zeroizing::new(crypto_key_bytes()?);
        let package = Zeroizing::new(package_bytes(&database, &key)?);
        match password.as_ref() {
            Some(password) => backup_crypto::seal(&package, password),
            None => Ok(package.to_vec()),
        }
    })();
    let _ = fs::remove_file(snapshot);
    result
}

pub(super) fn prepare_cloud_snapshot(bytes: &[u8], password: Option<String>, state: &DatabaseImportStore) -> Result<ImportPreview, String> {
    let _transfer = lock_transfer()?;
    let password = Zeroizing::new(password.unwrap_or_default());
    let package = if bytes.starts_with(backup_crypto::MAGIC) { backup_crypto::open(bytes, &password)? } else { Zeroizing::new(bytes.to_vec()) };
    // A remote raw SQLite file must never cause us to load a local sidecar key.
    if !package.starts_with(MAGIC) { return Err("云备份格式无效，请上传 CloudHub .chdb 备份".into()); }
    let (database, key, manifest) = parse_package_bytes(&package, Path::new("database.chdb"))?;
    let database = Zeroizing::new(database);
    let key = Zeroizing::new(key);
    let data = data_dir()?;
    let token = Uuid::new_v4().to_string();
    let database_path = data.join(format!(".cloudhub-import-preview-{token}.sqlite3"));
    let result = (|| {
        write_new_or_replace(&database_path, &database)?;
        validate_database(&database_path)?;
        reset_imported_sync_identity(&database_path)?;
        let preview = build_preview(&database_path, &data.join("cloudhub_tools.sqlite3"), token.clone(), "云端备份".into(), manifest.get("exported_at").and_then(|value| value.as_str()).unwrap_or("未知").into())?;
        state.sessions.lock().map_err(|_| "导入预览状态不可用")?.insert(token, PreparedImport { database_path: database_path.clone(), key, sql_mode: None });
        Ok(preview)
    })();
    if result.is_err() { let _ = fs::remove_file(database_path); }
    result
}

fn preserve_local_cloud_config(incoming: &Path, current: &Path, current_key: &[u8], incoming_key: &[u8]) -> Result<(), String> {
    use crate::core::crypto::{decrypt_secret_with_key, encrypt_secret_with_key};
    use rusqlite::OptionalExtension;
    let source = Connection::open(current).map_err(|_| "读取本机云同步配置失败")?;
    let value: Option<String> = source.query_row("SELECT value FROM client_preferences WHERE key=?1", [super::cloud_sync::CONFIG_KEY], |row| row.get(0)).optional().map_err(|_| "读取本机云同步配置失败")?;
    let target = Connection::open(incoming).map_err(|_| "准备本机云同步配置失败")?;
    target.execute("DELETE FROM client_preferences WHERE key LIKE 'cloud.sync.%'", []).map_err(|_| "清理导入云同步配置失败")?;
    if let Some(value) = value {
        let plaintext = Zeroizing::new(decrypt_secret_with_key(&value, current_key).map_err(|_| "解密本机云同步配置失败")?);
        let mut config: super::cloud_sync::Config = serde_json::from_str(&plaintext).map_err(|_| "本机云同步配置格式无效")?;
        config.auto_sync = false;
        let serialized = Zeroizing::new(serde_json::to_string(&config).map_err(|_| "准备本机云同步配置失败")?);
        let encrypted = encrypt_secret_with_key(&serialized, incoming_key).map_err(|_| "保留本机云同步配置失败")?;
        crate::core::repositories::preferences::save(&target, super::cloud_sync::CONFIG_KEY, &encrypted, Utc::now().timestamp_millis())?;
    }
    Ok(())
}

fn snapshot_database_at(source: &Path, target: &Path) -> Result<(), String> {
    // Do not run schema initialization while SQL confirmation holds a write lock.
    let conn = Connection::open_with_flags(source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "读取 SQLite 快照源失败")?;
    conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(|_| "配置快照失败")?;
    let escaped = target.to_string_lossy().replace('\'', "''");
    conn.execute_batch(&format!("VACUUM INTO '{}';", escaped))
        .map_err(|error| format!("创建 SQLite 快照失败: {error}"))
}

fn sanitize_snapshot(path: &Path) -> Result<(), String> {
    sanitize_snapshot_with_key(path, &crypto_key_bytes()?)
}

fn sanitize_snapshot_with_key(path: &Path, key: &[u8]) -> Result<(), String> {
    use crate::core::data_transfer as policy;
    let db = Connection::open(path).map_err(|_| "打开备份快照失败")?;
    db.execute_batch("PRAGMA foreign_keys=OFF; PRAGMA secure_delete=ON;").map_err(|_| "准备备份过滤失败")?;
    let mut stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").map_err(|_| "读取快照触发器失败")?;
    let triggers = stmt.query_map([], |r| r.get::<_,String>(0)).map_err(|_| "读取快照触发器失败")?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| "读取快照触发器失败")?;
    for trigger in triggers { db.execute_batch(&format!("DROP TRIGGER {}", policy::ident(&trigger))).map_err(|_| "清理快照触发器失败")?; }
    policy::export_authenticator(&db, key)?;
    let mut stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map_err(|_| "读取快照数据范围失败")?;
    let tables = stmt.query_map([], |r| r.get::<_,String>(0)).map_err(|_| "读取快照数据范围失败")?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| "读取快照数据范围失败")?;
    drop(stmt);
    for table in tables {
        if !policy::allowed(&table) { db.execute(&format!("DELETE FROM {}", policy::ident(&table)), []).map_err(|_| "过滤备份数据失败")?; continue; }
        if table == "client_preferences" {
            let mut stmt = db.prepare("SELECT key FROM client_preferences").map_err(|_| "过滤本机设置失败")?;
            let keys = stmt.query_map([], |r| r.get::<_,String>(0)).map_err(|_| "过滤本机设置失败")?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| "过滤本机设置失败")?;
            for key in keys.into_iter().filter(|key| !policy::portable_preference(key)) { db.execute("DELETE FROM client_preferences WHERE key=?1", [key]).map_err(|_| "过滤本机设置失败")?; }
        }
        let fields = policy::columns(&db, &table)?;
        let mut stmt = db.prepare(&format!("SELECT rowid,* FROM {}", policy::ident(&table))).map_err(|_| "读取备份配置失败")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_,i64>(0)?, (0..fields.len()).map(|i| r.get::<_,rusqlite::types::Value>(i+1)).collect::<rusqlite::Result<Vec<_>>>()?))).map_err(|_| "读取备份配置失败")?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| "读取备份配置失败")?;
        drop(stmt);
        for (id, values) in rows {
            for (name, value) in fields.iter().zip(values) {
                let cleaned = policy::clean_value(&table, name, value.clone());
                if cleaned != value { db.execute(&format!("UPDATE {} SET {}=?1 WHERE rowid=?2",policy::ident(&table),policy::ident(name)), rusqlite::params![cleaned,id]).map_err(|_| "过滤备份运行状态失败")?; }
            }
        }
    }
    db.execute_batch("VACUUM").map_err(|_| "整理备份失败")?;
    db.execute_batch("CREATE TABLE cloudhub_transfer_policy(version INTEGER NOT NULL); INSERT INTO cloudhub_transfer_policy VALUES(1);").map_err(|_| "写入备份范围版本失败")?;
    Ok(())
}

fn preserve_local_codex(incoming: &Path, current: &Path, current_key: &[u8], incoming_key: &[u8]) -> Result<(), String> {
    use crate::core::crypto::{decrypt_secret_with_key, encrypt_secret_with_key};
    let mut destination = Connection::open(incoming).map_err(|_| "无法准备本机 Codex 数据保留")?;
    let source = if current.exists() { Some(Connection::open(current).map_err(|_| "无法读取本机 Codex 数据")?) } else { None };
    let tx = destination.transaction().map_err(|_| "无法准备 Codex 数据事务")?;
    // Only the staged incoming copy is rebuilt. Incoming Codex data is never authoritative,
    // and its older profile schema must not prevent preserving newer local profile columns.
    tx.execute_batch("DROP TABLE IF EXISTS codex_profiles; DROP TABLE IF EXISTS codex_accounts; DROP TABLE IF EXISTS codex_profile_backups; DROP TABLE IF EXISTS codex_gateway_config; DROP TABLE IF EXISTS codex_gateway_pool; DROP TABLE IF EXISTS codex_gateway_network; DROP TABLE IF EXISTS codex_config_operations; DROP TABLE IF EXISTS codex_config_history;").map_err(|_|"隔离迁移包 Codex 数据失败")?;
    tx.execute_batch(crate::core::database::CODEX_SCHEMA).map_err(|_|"无法准备 Codex 数据表")?;
    tx.execute_batch(crate::core::database::CODEX_CONFIG_HISTORY_SCHEMA).map_err(|_|"无法准备 Codex 备份历史")?;
    tx.execute_batch("DROP TABLE IF EXISTS codex_gateway_tunnel; CREATE TABLE codex_gateway_tunnel(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);").map_err(|_| "隔离穿透配置失败")?;
    for (table, columns, secret_index) in [
        ("codex_accounts", "id,identity,label,email,account_id,auth_mode,plan,note,tags_json,auth_ciphertext,quota_json,last_error,updated_at", Some(9usize)),
        ("codex_profile_backups", "profile_home,auth_ciphertext,installed_fingerprint,previous_fingerprint", Some(1usize)),
        ("codex_profiles", "id,account_id,name,work_dir,created_at,auth_fingerprint,kind", None),
        ("codex_gateway_config", "id,port,key_ciphertext,auto_start,account_ids_json", Some(2usize)),
        ("codex_gateway_pool", "id,account_ids_json", None),
        ("codex_gateway_network", "id,allow_lan", None),
        ("codex_config_history", "id,home,instance_id,created_at,migrated_at,source,mode,summary,complete,pinned,legacy_key,content_ciphertext", Some(11usize)),
        ("codex_config_operations", "home,snapshot_id,content_ciphertext", Some(2usize)),
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

fn preserve_local_codex_providers(
    incoming: &Path,
    current: &Path,
    current_key: &[u8],
    incoming_key: &[u8],
) -> Result<(), String> {
    use crate::core::crypto::{decrypt_secret_with_key, encrypt_secret_with_key};
    let mut destination = Connection::open(incoming).map_err(|_| "无法准备本机供应商数据保留")?;
    let source = if current.exists() {
        Some(Connection::open(current).map_err(|_| "无法读取本机供应商数据")?)
    } else {
        None
    };
    let tx = destination
        .transaction()
        .map_err(|_| "无法准备供应商数据事务")?;
    tx.execute_batch(crate::core::database::CODEX_PROVIDERS_SCHEMA)
        .map_err(|_| "无法准备供应商数据表")?;
    tx.execute_batch(crate::core::database::CODEX_PROVIDER_AGGREGATES_SCHEMA)
        .map_err(|_| "无法准备供应商聚合数据表")?;
    for (table, column, definition) in [
        (
            "codex_model_providers",
            "settings_json",
            "TEXT NOT NULL DEFAULT '{}'",
        ),
        (
            "codex_provider_keys",
            "settings_json",
            "TEXT NOT NULL DEFAULT '{}'",
        ),
    ] {
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)",
                rusqlite::params![table, column],
                |row| row.get(0),
            )
            .map_err(|_| "检查供应商数据结构失败")?;
        if !exists {
            tx.execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {definition}"
            ))
            .map_err(|_| "升级供应商数据结构失败")?;
        }
    }
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS codex_provider_config_backups(home TEXT PRIMARY KEY,content_ciphertext TEXT NOT NULL,installed_config TEXT NOT NULL,installed_auth TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS codex_provider_bindings(home TEXT PRIMARY KEY,provider_id TEXT NOT NULL,key_id TEXT NOT NULL,account_id INTEGER NOT NULL,previous_account_id INTEGER,instance_id TEXT);
         CREATE TABLE IF NOT EXISTS codex_provider_accounts(account_id INTEGER PRIMARY KEY,provider_id TEXT NOT NULL,key_id TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS codex_provider_gateways(home TEXT PRIMARY KEY,port INTEGER NOT NULL,key_ciphertext TEXT NOT NULL,provider_id TEXT NOT NULL,key_id TEXT NOT NULL,models_json TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS codex_provider_oauth(home TEXT PRIMARY KEY,account_id INTEGER NOT NULL UNIQUE,auth_fingerprint TEXT NOT NULL);",
    ).map_err(|_| "无法准备供应商运行状态表")?;

    for table in [
        "codex_provider_bindings",
        "codex_provider_accounts",
        "codex_provider_gateways",
        "codex_provider_oauth",
        "codex_provider_config_backups",
        "codex_provider_aggregate_members",
        "codex_provider_aggregates",
        "codex_provider_keys",
        "codex_model_providers",
    ] {
        tx.execute(&format!("DELETE FROM {table}"), [])
            .map_err(|_| "隔离迁移包供应商数据失败")?;
    }
    let tables = [
        (
            "codex_model_providers",
            "id,name,base_url,wire_api,models_json,note,version,settings_json",
            None,
        ),
        (
            "codex_provider_keys",
            "id,provider_id,name,ciphertext,settings_json",
            Some(3usize),
        ),
        ("codex_provider_aggregates", "id,name,strategy,version", None),
        (
            "codex_provider_aggregate_members",
            "aggregate_id,position,provider_id,key_id,weight",
            None,
        ),
        (
            "codex_provider_config_backups",
            "home,content_ciphertext,installed_config,installed_auth",
            Some(1usize),
        ),
        (
            "codex_provider_gateways",
            "home,port,key_ciphertext,provider_id,key_id,models_json",
            Some(2usize),
        ),
        (
            "codex_provider_bindings",
            "home,provider_id,key_id,account_id,previous_account_id,instance_id",
            None,
        ),
        (
            "codex_provider_accounts",
            "account_id,provider_id,key_id",
            None,
        ),
        (
            "codex_provider_oauth",
            "home,account_id,auth_fingerprint",
            None,
        ),
    ];
    for (table, columns, secret_index) in tables {
        let Some(ref source) = source else { continue };
        if !table_exists(source, table)? || table_count(source, table)? == 0 {
            continue;
        }
        let count = columns.split(',').count();
        let mut statement = source
            .prepare(&format!("SELECT {columns} FROM {table}"))
            .map_err(|_| "读取本机供应商数据失败")?;
        let rows = statement
            .query_map([], |row| {
                (0..count)
                    .map(|index| row.get::<_, rusqlite::types::Value>(index))
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .map_err(|_| "读取本机供应商数据失败")?;
        let placeholders = (1..=count)
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(",");
        for row in rows {
            let mut values = row.map_err(|_| "读取本机供应商数据失败")?;
            if let Some(index) = secret_index {
                if let rusqlite::types::Value::Text(ciphertext) = &values[index] {
                    let secret = zeroize::Zeroizing::new(
                        decrypt_secret_with_key(ciphertext, current_key)
                            .map_err(|_| "解密本机供应商数据失败")?,
                    );
                    values[index] = rusqlite::types::Value::Text(
                        encrypt_secret_with_key(&secret, incoming_key)
                            .map_err(|_| "重新加密本机供应商数据失败")?,
                    );
                }
            }
            tx.execute(
                &format!("INSERT INTO {table}({columns}) VALUES({placeholders})"),
                rusqlite::params_from_iter(values),
            )
            .map_err(|_| "保留本机供应商数据失败")?;
        }
    }
    tx.commit().map_err(|_| "提交本机供应商数据失败".into())
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

fn parse_package_password(package_path: &Path, password: Option<&str>) -> Result<(Vec<u8>, Vec<u8>, serde_json::Value), String> {
    if fs::metadata(package_path).map_err(|_| "无法读取备份文件")?.len() > MAX_PACKAGE_BYTES { return Err("备份超过 256 MB 限制".into()); }
    let mut package = Zeroizing::new(fs::read(package_path).map_err(|_| "读取备份失败")?);
    if package.starts_with(backup_crypto::MAGIC) {
        package = backup_crypto::open(&package, password.ok_or("请输入备份密码")?)?;
    }
    parse_package_bytes(&package, package_path)
}

fn parse_package_bytes(package: &[u8], package_path: &Path) -> Result<(Vec<u8>, Vec<u8>, serde_json::Value), String> {
    if package.len() as u64 > MAX_PACKAGE_BYTES { return Err("备份超过 256 MB 限制".into()); }
    if package.starts_with(b"SQLite format 3\0") {
        let key_path = package_path.parent().unwrap_or_else(|| Path::new(".")).join(".key");
        let key = fs::read(&key_path).map_err(|_| "检测到直接 SQLite 文件，但同目录缺少 .key 密钥文件".to_string())?;
        if key.len() != 32 { return Err("同目录 .key 密钥文件无效，无法导入直接 SQLite 文件".into()); }
        return Ok((package.to_vec(), key, json!({ "format": "cloudhub-tools-database-migration", "version": FORMAT_VERSION, "exported_at": "直接 SQLite 文件" })));
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
    let labels = crate::core::data_transfer::TABLES;
    let mut categories = Vec::new(); let mut total_records = 0;
    for &(table, label) in labels {
        if table == "authenticator_entries" && !table_exists(&imported, "cloudhub_transfer_policy")? { continue; }
        let count = if table == "client_preferences" && table_exists(&imported, table)? {
            let mut stmt=imported.prepare("SELECT key FROM client_preferences").map_err(|_| "读取偏好范围失败")?;
            let keys=stmt.query_map([],|r|r.get::<_,String>(0)).map_err(|_| "读取偏好范围失败")?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| "读取偏好范围失败")?;
            keys.into_iter().filter(|key|crate::core::data_transfer::portable_preference(key)).count() as u64
        } else if table_exists(&imported, table)? { table_count(&imported, table)? } else { 0 };
        total_records += count; categories.push(ImportCategory { table: table.into(), label: label.into(), count });
    }
    let mut details = vec!["统一业务备份包含供应商、备忘录、浏览器配置及验证码种子；保留本机 Codex 登录账号、日志和设备身份。".into()]; let mut incoming_keys = HashMap::new();
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
    details.push("恢复仅写入统一目录中的业务数据；不接管本机 Claude/Codex 配置文件，不启动进程。旧版备份不含可恢复的验证码种子，将保留本机验证器。".into());
    Ok(ImportPreview { token, package_name, exported_at, total_records, categories, details, conflicts, import_mode: "backup".into() })
}

#[tauri::command]
pub(crate) async fn export_database_file(app: tauri::AppHandle, format: Option<String>, tables: Option<Vec<String>>, include_trash: Option<bool>) -> PlatformResult<Option<String>> {
    ensure_database_file_migration_supported()?;
    let _transfer = lock_transfer()?;
    if format.as_deref() == Some("sql") { return Ok(sql::export_file(&app, tables, include_trash.unwrap_or(false))?); }
    if format.as_deref().is_some_and(|value| value != "backup") { return Err("不支持的导出格式".into()); }
    let result = (|| {
        let Some(selected) = app.dialog().file().set_file_name(format!("cloudhub-tools-backup-{}.chdb", Utc::now().format("%Y%m%d-%H%M%S"))).blocking_save_file() else { return Ok(None) };
        let path = selected.into_path().map_err(|_| "当前平台返回了不支持的导出路径".to_string())?;
        create_package_file(&path, None)?;
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
pub(crate) async fn create_database_backup(password: Option<String>) -> PlatformResult<DatabaseBackupRecord> {
    ensure_database_file_migration_supported()?;
    let _transfer = lock_transfer()?;
    let password = password.map(Zeroizing::new);
    let id = Uuid::new_v4().to_string();
    let path = backups_dir()?.join(format!("{id}.chdb"));
    create_package_file(&path, password.as_ref().map(|value| value.as_str()))?;
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
pub(crate) async fn import_database_backup(app: tauri::AppHandle, password: Option<String>) -> PlatformResult<Option<DatabaseBackupRecord>> {
    ensure_database_file_migration_supported()?;
    let _transfer = lock_transfer()?;
    let password = Zeroizing::new(password.unwrap_or_default());
    let Some(selected) = app.dialog().file().blocking_pick_file() else { return Ok(None) };
    let source = selected.into_path().map_err(|_| "当前平台返回了不支持的导入路径".to_string())?;
    let mut signature = [0u8; 8];
    use std::io::Read;
    fs::File::open(&source).and_then(|mut file| file.read_exact(&mut signature)).map_err(|_| "无法读取备份文件".to_string())?;
    if &signature != MAGIC && &signature != backup_crypto::MAGIC { return Err("请选择 CloudHub 完整备份文件（.chdb）".into()); }
    let (database, key, manifest) = parse_package_password(&source, Some(&password))?;
    let _key = Zeroizing::new(key);
    let database = Zeroizing::new(database);
    if manifest.get("format").and_then(|value| value.as_str()) != Some("cloudhub-tools-database-migration") { return Err("请选择 CloudHub 完整备份文件（.chdb）".into()); }
    let temp = data_dir()?.join(format!(".cloudhub-backup-validate-{}.sqlite3", Uuid::new_v4()));
    let validation = (|| { fs::write(&temp, &*database).map_err(|_| "校验备份失败")?; validate_database(&temp) })();
    let _ = fs::remove_file(temp);
    validation?;
    let target = backups_dir()?.join(format!("{}.chdb", Uuid::new_v4()));
    // Preserve the original format, including any existing password protection.
    fs::copy(&source, &target).map_err(|_| "导入备份文件失败")?;
    let file_name = source.file_name().and_then(|name| name.to_str()).filter(|name| !name.trim().is_empty()).unwrap_or("导入备份.chdb");
    save_backup_display_name(&target, file_name)?;
    Ok(Some(backup_record(&target)?))
}

#[tauri::command]
pub(crate) fn import_database_file(app: tauri::AppHandle) -> PlatformResult<Option<String>> {
    ensure_database_file_migration_supported()?;
    let _transfer = lock_transfer()?;
    let _cloud_guard = super::cloud_sync::restore_guard()?;
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
        lock_authenticator_for_migration(&app);
        restore_portable_database(&import_db, key)
    })();
    let _ = fs::remove_file(&import_db);
    Ok(result.map(Some)?)
}

fn restore_portable_database(import_db: &Path, key: &[u8]) -> Result<String, String> {
    restore_portable_selection(import_db, key, None, "replace")
}

fn restore_portable_selection(import_db: &Path, key: &[u8], tables: Option<Vec<String>>, mode: &str) -> Result<String, String> {
    if !matches!(mode, "replace" | "merge" | "overwrite") { return Err("恢复方式无效".into()); }
    let _cloud_guard = super::cloud_sync::restore_guard()?;
    validate_database(import_db)?;
    crate::core::database::upgrade_transfer_database(import_db)?;
    let source = Connection::open(import_db).map_err(|_| "打开恢复副本失败")?;
    let has_policy = crate::core::data_transfer::exists(&source, "cloudhub_transfer_policy")?;
    let tables = sql::selected(tables)?.into_iter().filter(|table| has_policy || table != "authenticator_entries").collect::<Vec<_>>();
    // Legacy files cannot carry a usable OTP device key; retain the local vault.
    let input = sql::dump(&source, key, &tables)?;
    let mut current = open_db()?;
    let recovery = data_dir()?.join(format!("cloudhub_tools.sqlite3.before-import-{}", Uuid::new_v4()));
    snapshot_database(&recovery)?;
    if has_policy && table_count(&source, "authenticator_entries")? > 0 { crate::core::repositories::authenticator_sync::prepare_key(&mut current)?; }
    let current_key = Zeroizing::new(crypto_key_bytes()?);
    let tx = current.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|_| "数据库正在使用，请重试")?;
    let (added, changed, skipped) = sql::import_portable(&tx, &input, &current_key, mode)?;
    rebuild_memo_reminders(&tx)?;
    tx.commit().map_err(|_| "恢复未提交，原有数据保持不变")?;
    Ok(format!("恢复完成：新增 {added} 条、更新 {changed} 条、跳过 {skipped} 条；保留本机登录账号、日志和设备身份，恢复前快照已保存"))
}

pub(crate) fn rebuild_memo_reminders(db: &Connection) -> Result<(), String> {
    db.execute_batch("DELETE FROM memo_reminders WHERE NOT EXISTS (SELECT 1 FROM memo_notes n WHERE n.id=memo_reminders.note_id AND n.deleted_at IS NULL AND n.remind_at=memo_reminders.fire_at AND (n.remind_done_at IS NULL OR n.remind_done_at<n.remind_at)); INSERT INTO memo_reminders(note_id,fire_at) SELECT n.id,n.remind_at FROM memo_notes n WHERE n.deleted_at IS NULL AND n.remind_at IS NOT NULL AND (n.remind_done_at IS NULL OR n.remind_done_at<n.remind_at) AND NOT EXISTS (SELECT 1 FROM memo_reminders r WHERE r.note_id=n.id AND r.fire_at=n.remind_at);").map_err(|_| "重建备忘录提醒失败".into())
}

#[tauri::command]
pub(crate) async fn prepare_database_import(app: tauri::AppHandle, state: tauri::State<'_, DatabaseImportStore>, format: Option<String>, password: Option<String>, mode: Option<String>) -> PlatformResult<Option<ImportPreview>> {
    ensure_database_file_migration_supported()?;
    let _transfer = lock_transfer()?;
    if format.as_deref() == Some("sql") { return Ok(sql::prepare(&app, &state, mode.as_deref().unwrap_or("merge"))?); }
    if format.as_deref().is_some_and(|value| value != "backup") { return Err("不支持的导入格式".into()); }
    let password = Zeroizing::new(password.unwrap_or_default());
    let Some(selected) = app.dialog().file().blocking_pick_file() else { return Ok(None) };
    let package_path = selected.into_path().map_err(|_| "当前平台返回了不支持的导入路径".to_string())?;
    let (database, key, manifest) = parse_package_password(&package_path, Some(&password))?;
    let database = Zeroizing::new(database); let key = Zeroizing::new(key);
    let data = data_dir()?;
    let token = Uuid::new_v4().to_string();
    let database_path = data.join(format!(".cloudhub-import-preview-{token}.sqlite3"));
    let result: Result<Option<ImportPreview>, String> = (|| {
        fs::write(&database_path, &*database).map_err(|_| "准备导入预览失败")?;
        validate_database(&database_path)?;
        reset_imported_sync_identity(&database_path)?;
        let package_name = package_path.file_name().and_then(|value| value.to_str()).unwrap_or("迁移包").to_string();
        let preview = build_preview(&database_path, &data.join("cloudhub_tools.sqlite3"), token.clone(), package_name, manifest.get("exported_at").and_then(|value| value.as_str()).unwrap_or("未知").to_string())?;
        state.sessions.lock().map_err(|_| "导入预览状态不可用")?.insert(token, PreparedImport { database_path: database_path.clone(), key, sql_mode: None });
        Ok(Some(preview))
    })();
    if result.is_err() { let _ = fs::remove_file(&database_path); }
    result.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn prepare_database_backup_restore(id: String, password: Option<String>, state: tauri::State<'_, DatabaseImportStore>) -> PlatformResult<Option<ImportPreview>> {
    ensure_database_file_migration_supported()?;
    let _transfer = lock_transfer()?;
    let package_path = backup_path(&id)?;
    if !package_path.is_file() { return Err("找不到这条备份记录".into()); }
    let password = Zeroizing::new(password.unwrap_or_default());
    let (database, key, manifest) = parse_package_password(&package_path, Some(&password))?;
    let database = Zeroizing::new(database); let key = Zeroizing::new(key);
    let data = data_dir()?;
    let token = Uuid::new_v4().to_string();
    let database_path = data.join(format!(".cloudhub-import-preview-{token}.sqlite3"));
    let result: Result<Option<ImportPreview>, String> = (|| {
        fs::write(&database_path, &*database).map_err(|_| "准备导入预览失败")?;
        validate_database(&database_path)?;
        reset_imported_sync_identity(&database_path)?;
        let preview = build_preview(&database_path, &data.join("cloudhub_tools.sqlite3"), token.clone(), "本机备份".into(), manifest.get("exported_at").and_then(|value| value.as_str()).unwrap_or("未知").to_string())?;
        state.sessions.lock().map_err(|_| "导入预览状态不可用")?.insert(token, PreparedImport { database_path: database_path.clone(), key, sql_mode: None });
        Ok(Some(preview))
    })();
    if result.is_err() { let _ = fs::remove_file(&database_path); }
    result.map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::{
        preserve_local_authenticator, preserve_local_codex, preserve_local_codex_providers,
        reset_imported_sync_identity,
    };
    use rusqlite::Connection;
    use std::{fs, path::PathBuf};
    use uuid::Uuid;

    #[test]
    fn snapshot_contains_business_and_trash_but_no_login_logs_or_device_identity() {
        let root=std::env::temp_dir().join(format!("cloudhub-policy-{}",Uuid::new_v4())); fs::create_dir(&root).unwrap();
        let path=root.join("snapshot.sqlite3");
        let db=crate::core::database::open_transfer_test_db(&path).unwrap();
        db.execute_batch("INSERT INTO operation_logs(action,result,message,created_at) VALUES('fixture','ok','forbidden-log-marker',1); INSERT INTO codex_accounts(identity,label,auth_mode,auth_ciphertext,updated_at) VALUES('fixture','fixture','oauth','forbidden-account-marker',1); INSERT INTO client_preferences VALUES('cloud.sync.config','forbidden-config-marker',1); INSERT INTO memo_groups VALUES('fixture',0,1); INSERT INTO memo_notes(title,body,group_name,created_at,updated_at,deleted_at) VALUES('fixture','portable-note-marker','fixture',1,1,5);").unwrap();
        drop(db);
        super::sanitize_snapshot_with_key(&path,&[1;32]).unwrap();
        let db=Connection::open(&path).unwrap();
        for table in ["operation_logs","api_logs","codex_accounts","sync_local_device","cloud_assets","authenticator_vault"] {
            assert_eq!(super::table_count(&db,table).unwrap(),0);
        }
        assert_eq!(super::table_count(&db,"memo_notes").unwrap(),1);
        assert_eq!(super::table_count(&db,"cloudhub_transfer_policy").unwrap(),1);
        drop(db);
        let bytes=fs::read(&path).unwrap(); let text=String::from_utf8_lossy(&bytes);
        assert!(!text.contains("forbidden-log-marker")); assert!(!text.contains("forbidden-account-marker")); assert!(!text.contains("forbidden-config-marker"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cloud_config_stays_local_and_is_reencrypted_with_incoming_key() {
        use crate::core::crypto::{encrypt_secret_with_key, decrypt_secret_with_key};
        let root = std::env::temp_dir().join(format!("cloudhub-cloud-config-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let current = root.join("current.sqlite3");
        let incoming = root.join("incoming.sqlite3");
        let old_key = [21u8; 32]; let new_key = [22u8; 32];
        for path in [&current, &incoming] {
            let conn = Connection::open(path).unwrap();
            conn.execute_batch("CREATE TABLE client_preferences(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)").unwrap();
            let mut config = crate::commands::cloud_sync::Config::default();
            config.auto_sync = true; config.endpoint = "fixture".into();
            let value = if path == &current { encrypt_secret_with_key(&serde_json::to_string(&config).unwrap(), &old_key).unwrap() } else { "untrusted-incoming-config".into() };
            conn.execute("INSERT INTO client_preferences VALUES('cloud.sync.config',?1,1)", [value]).unwrap();
        }
        super::preserve_local_cloud_config(&incoming, &current, &old_key, &new_key).unwrap();
        let conn = Connection::open(&incoming).unwrap();
        let ciphertext: String = conn.query_row("SELECT value FROM client_preferences", [], |row| row.get(0)).unwrap();
        let preserved: serde_json::Value = serde_json::from_str(&decrypt_secret_with_key(&ciphertext, &new_key).unwrap()).unwrap();
        assert_eq!(preserved["endpoint"], "fixture");
        assert_eq!(preserved["autoSync"], false);
        assert!(decrypt_secret_with_key(&ciphertext, &old_key).is_err());
        assert!(crate::core::repositories::preferences::list(&conn).unwrap().is_empty());
        drop(conn);
        Connection::open(&current).unwrap().execute("DELETE FROM client_preferences", []).unwrap();
        super::preserve_local_cloud_config(&incoming, &current, &old_key, &new_key).unwrap();
        assert_eq!(Connection::open(&incoming).unwrap().query_row("SELECT COUNT(*) FROM client_preferences", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        fs::remove_dir_all(root).unwrap();
    }

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
            conn.execute_batch(crate::core::database::CODEX_CONFIG_HISTORY_SCHEMA).unwrap();
            conn.execute_batch(crate::core::repositories::authenticator::SCHEMA).unwrap();
            let cipher = encrypt_secret_with_key("invalid-test-only", key).unwrap();
            conn.execute("INSERT INTO codex_config_history VALUES(?1,'fixture-home',NULL,123,NULL,'manual','fixture','fixture',1,1,NULL,?2)",rusqlite::params![label,cipher]).unwrap();
            conn.execute("INSERT INTO codex_config_operations VALUES('fixture-home',?1,?2)",rusqlite::params![label,cipher]).unwrap();
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
        for table in ["codex_config_history", "codex_config_operations"] {
            let cipher:String=conn.query_row(&format!("SELECT content_ciphertext FROM {table}"),[],|r|r.get(0)).unwrap();
            assert_eq!(decrypt_secret_with_key(&cipher,&new_key).unwrap(),"invalid-test-only");
            assert!(decrypt_secret_with_key(&cipher,&old_key).is_err());
        }
        assert_eq!(conn.query_row("SELECT id FROM codex_config_history",[],|r|r.get::<_,String>(0)).unwrap(),"local");
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
    #[test]
    fn provider_credentials_and_local_runtime_state_survive_database_import() {
        use crate::core::crypto::{decrypt_secret_with_key, encrypt_secret_with_key};
        let root =
            std::env::temp_dir().join(format!("cloudhub-provider-migration-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let current = root.join("current.sqlite3");
        let incoming = root.join("incoming.sqlite3");
        let old_key = [31u8; 32];
        let new_key = [32u8; 32];
        for (path, id, name, secret, key) in [
            (
                &current,
                "local-provider",
                "本机供应商",
                "local-secret",
                &old_key,
            ),
            (
                &incoming,
                "incoming-provider",
                "迁移包供应商",
                "incoming-secret",
                &new_key,
            ),
        ] {
            let conn = Connection::open(path).unwrap();
            conn.execute_batch(crate::core::database::CODEX_PROVIDERS_SCHEMA)
                .unwrap();
            conn.execute_batch(crate::core::database::CODEX_PROVIDER_AGGREGATES_SCHEMA)
                .unwrap();
            conn.execute_batch("ALTER TABLE codex_model_providers ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'; ALTER TABLE codex_provider_keys ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}';").unwrap();
            conn.execute_batch("CREATE TABLE codex_provider_config_backups(home TEXT PRIMARY KEY,content_ciphertext TEXT NOT NULL,installed_config TEXT NOT NULL,installed_auth TEXT NOT NULL); CREATE TABLE codex_provider_bindings(home TEXT PRIMARY KEY,provider_id TEXT NOT NULL,key_id TEXT NOT NULL,account_id INTEGER NOT NULL,previous_account_id INTEGER,instance_id TEXT); CREATE TABLE codex_provider_accounts(account_id INTEGER PRIMARY KEY,provider_id TEXT NOT NULL,key_id TEXT NOT NULL); CREATE TABLE codex_provider_gateways(home TEXT PRIMARY KEY,port INTEGER NOT NULL,key_ciphertext TEXT NOT NULL,provider_id TEXT NOT NULL,key_id TEXT NOT NULL,models_json TEXT NOT NULL); CREATE TABLE codex_provider_oauth(home TEXT PRIMARY KEY,account_id INTEGER NOT NULL UNIQUE,auth_fingerprint TEXT NOT NULL);").unwrap();
            conn.execute("INSERT INTO codex_model_providers VALUES(?1,?2,'https://example.com/v1','responses','[\"model-a\"]','',1,'{}')", rusqlite::params![id, name]).unwrap();
            let aggregate_id = if id == "local-provider" {
                "local-aggregate"
            } else {
                "incoming-aggregate"
            };
            conn.execute(
                "INSERT INTO codex_provider_aggregates VALUES(?1,?2,'failover',1)",
                rusqlite::params![aggregate_id, format!("{name} 聚合")],
            )
            .unwrap();
            let key_cipher = encrypt_secret_with_key(secret, key).unwrap();
            conn.execute(
                "INSERT INTO codex_provider_keys VALUES('key-a',?1,'primary',?2,'{}')",
                rusqlite::params![id, key_cipher],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO codex_provider_aggregate_members VALUES(?1,0,?2,'key-a',3)",
                rusqlite::params![aggregate_id, id],
            )
            .unwrap();
            let backup_cipher = encrypt_secret_with_key("recovery-snapshot", key).unwrap();
            conn.execute("INSERT INTO codex_provider_config_backups VALUES('fixture-home',?1,'config-fingerprint','auth-fingerprint')", [&backup_cipher]).unwrap();
            let gateway_cipher = encrypt_secret_with_key("loopback-client-key", key).unwrap();
            conn.execute("INSERT INTO codex_provider_gateways VALUES('fixture-home',58169,?1,?2,'key-a','[\"model-a\"]')", rusqlite::params![gateway_cipher,id]).unwrap();
            conn.execute("INSERT INTO codex_provider_bindings VALUES('fixture-home',?1,'key-a',7,6,'instance-a')", [id]).unwrap();
            conn.execute(
                "INSERT INTO codex_provider_accounts VALUES(7,?1,'key-a')",
                [id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO codex_provider_oauth VALUES('fixture-home',8,'oauth-fingerprint')",
                [],
            )
            .unwrap();
        }

        preserve_local_codex_providers(&incoming, &current, &old_key, &new_key).unwrap();
        let conn = Connection::open(&incoming).unwrap();
        assert_eq!(
            conn.query_row("SELECT id FROM codex_model_providers", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            "local-provider"
        );
        assert_eq!(
            conn.query_row("SELECT name FROM codex_model_providers", [], |row| row
                .get::<_, String>(
                0
            ))
            .unwrap(),
            "本机供应商"
        );
        assert_eq!(
            conn.query_row(
                "SELECT id FROM codex_provider_aggregates",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "local-aggregate"
        );
        assert_eq!(
            conn.query_row(
                "SELECT provider_id || ':' || key_id || ':' || weight FROM codex_provider_aggregate_members",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "local-provider:key-a:3"
        );
        for (query, expected) in [
            ("SELECT ciphertext FROM codex_provider_keys", "local-secret"),
            (
                "SELECT content_ciphertext FROM codex_provider_config_backups",
                "recovery-snapshot",
            ),
            (
                "SELECT key_ciphertext FROM codex_provider_gateways",
                "loopback-client-key",
            ),
        ] {
            let cipher: String = conn.query_row(query, [], |row| row.get(0)).unwrap();
            assert_eq!(
                decrypt_secret_with_key(&cipher, &new_key).unwrap(),
                expected
            );
            assert!(decrypt_secret_with_key(&cipher, &old_key).is_err());
        }
        assert_eq!(
            conn.query_row(
                "SELECT provider_id FROM codex_provider_bindings",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "local-provider"
        );
        assert_eq!(
            conn.query_row("SELECT account_id FROM codex_provider_oauth", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            8
        );
        drop(conn);
        fs::remove_dir_all(root).unwrap();
    }
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
pub(crate) async fn confirm_database_import(app: tauri::AppHandle, state: tauri::State<'_, DatabaseImportStore>, token: String, tables: Option<Vec<String>>, mode: Option<String>, force_restore: Option<bool>) -> PlatformResult<String> {
    ensure_database_file_migration_supported()?;
    let _transfer = lock_transfer()?;
    #[cfg(desktop)]
    let _codex_writer = super::codex::AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
    #[cfg(desktop)]
    // Portable business-data restores do not replace Codex provider config files.
    // Require runtime processes to be idle, but do not let unrelated pending
    // provider-config recovery block restoring selected database categories.
    { use tauri::Manager; if state.sessions.lock().map_err(|_| "导入预览状态不可用")?.get(&token).is_some_and(|prepared| prepared.sql_mode.is_none()) { super::codex_instances::ensure_runtime_idle(&app.state::<super::codex_runtime::CodexRuntimeStore>())?; } }
    let should_save_recovery_backup = state.sessions.lock().map_err(|_| "导入预览状态不可用".to_string())?.get(&token).ok_or_else(|| "导入预览已失效，请重新选择文件".to_string())?.sql_mode.is_none() && force_restore.unwrap_or(false);
    if should_save_recovery_backup {
        let path = backups_dir()?.join(format!("{}.chdb", Uuid::new_v4()));
        let name = format!("强制恢复前备份-{}.chdb", Utc::now().format("%Y%m%d-%H%M%S"));
        if let Err(error) = create_package_file(&path, None).and_then(|()| save_backup_display_name(&path, &name)) {
            let _ = fs::remove_file(&path);
            let _ = fs::remove_file(path.with_extension("name"));
            return Err(error.into());
        }
    }
    let prepared = state.sessions.lock().map_err(|_| "导入预览状态不可用".to_string())?.remove(&token).ok_or_else(|| "导入预览已失效，请重新选择文件".to_string())?;
    let result = if let Some(mode) = prepared.sql_mode.as_deref() {
        let current_key = Zeroizing::new(crypto_key_bytes()?);
        if *prepared.key != *current_key { Err("本机密钥已改变，请重新导入 SQL".into()) }
        else { sql::confirm(&prepared.database_path, mode) }
    } else {
        lock_authenticator_for_migration(&app);
        restore_portable_selection(&prepared.database_path, &prepared.key, tables, mode.as_deref().unwrap_or("replace"))
    };
    let _ = fs::remove_file(&prepared.database_path);
    Ok(result?)
}

#[tauri::command]
pub(crate) fn cancel_database_import(state: tauri::State<'_, DatabaseImportStore>, token: String) -> PlatformResult<()> {
    ensure_database_file_migration_supported()?;
    let prepared = state.sessions.lock().map_err(|_| "导入预览状态不可用".to_string())?.remove(&token).ok_or_else(|| "导入预览已失效".to_string())?;
    Ok(fs::remove_file(&prepared.database_path).map_err(|error| format!("清理导入预览失败: {error}"))?)
}
