use rusqlite::Connection;

use super::paths::data_dir;

const CURRENT_SCHEMA_VERSION: i64 = 3;

fn migrate_connection(conn: &mut Connection) -> Result<(), String> {
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| format!("读取 SQLite schema 版本失败: {error}"))?;
    if version > CURRENT_SCHEMA_VERSION {
        return Err(format!("SQLite schema 版本 {version} 高于当前客户端支持的版本 {CURRENT_SCHEMA_VERSION}"));
    }

    let transaction = conn.transaction().map_err(|error| format!("开启 SQLite 迁移事务失败: {error}"))?;
    let columns = |table: &str| -> Result<Vec<String>, String> {
        let mut statement = transaction.prepare(&format!("PRAGMA table_info({table})")).map_err(|error| error.to_string())?;
        let result = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string());
        result
    };
    let ensure_column = |table: &str, column: &str, definition: &str| -> Result<(), String> {
        if !columns(table)?.iter().any(|name| name == column) {
            transaction.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"), []).map_err(|error| error.to_string())?;
        }
        Ok(())
    };

    if version < 1 {
        ensure_column("cloud_accounts", "sort_order", "INTEGER NOT NULL DEFAULT 0")?;
        ensure_column("cloud_accounts", "credential_meta", "TEXT")?;
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS api_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, endpoint TEXT NOT NULL, action TEXT NOT NULL, request_params TEXT NOT NULL, response_params TEXT, status TEXT NOT NULL, message TEXT, created_at INTEGER NOT NULL);")
            .map_err(|error| error.to_string())?;
        transaction.pragma_update(None, "user_version", 1).map_err(|error| error.to_string())?;
    }
    if version < 2 {
        ensure_column("panel_connections", "allow_insecure_tls", "INTEGER NOT NULL DEFAULT 0")?;
        ensure_column("panel_connections", "sort_order", "INTEGER NOT NULL DEFAULT 0")?;
        ensure_column("managed_hosts", "platform", "TEXT NOT NULL DEFAULT 'linux'")?;
        ensure_column("managed_hosts", "auth_method", "TEXT NOT NULL DEFAULT 'password'")?;
        ensure_column("managed_hosts", "private_key_ciphertext", "TEXT")?;
        ensure_column("managed_hosts", "key_passphrase_ciphertext", "TEXT")?;
        ensure_column("managed_hosts", "group_name", "TEXT")?;
        ensure_column("managed_hosts", "tags", "TEXT")?;
        ensure_column("managed_hosts", "source_account_id", "INTEGER")?;
        ensure_column("managed_hosts", "source_asset_key", "TEXT")?;
        transaction.pragma_update(None, "user_version", 2).map_err(|error| error.to_string())?;
    }
    if version < 3 {
        transaction.execute_batch("CREATE INDEX IF NOT EXISTS idx_cloud_assets_account_type ON cloud_assets(account_id, resource_type);
          CREATE INDEX IF NOT EXISTS idx_api_logs_created_at ON api_logs(created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_operation_logs_created_at ON operation_logs(created_at DESC);")
            .map_err(|error| error.to_string())?;
        transaction.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION).map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| format!("提交 SQLite 迁移失败: {error}"))?;

    Ok(())
}

pub fn open_db() -> Result<Connection, String> {
    let conn = Connection::open(data_dir()?.join("cloudhub_tools.sqlite3"))
        .map_err(|error| format!("打开 SQLite 失败: {error}"))?;
    conn.execute_batch("PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS cloud_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, account_name TEXT NOT NULL, cloud_type TEXT NOT NULL DEFAULT 'aliyun', group_name TEXT, access_key_id TEXT NOT NULL, secret_ciphertext TEXT NOT NULL, region_id TEXT, sort_order INTEGER NOT NULL DEFAULT 0, credential_meta TEXT, enabled INTEGER NOT NULL DEFAULT 1, remark TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_assets (account_id INTEGER NOT NULL, resource_type TEXT NOT NULL, asset_key TEXT NOT NULL, region_id TEXT, payload_json TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY(account_id, resource_type, asset_key), FOREIGN KEY(account_id) REFERENCES cloud_accounts(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS ssh_connections (account_id INTEGER NOT NULL, asset_key TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 22, username TEXT NOT NULL, password_ciphertext TEXT, host_key_fingerprint TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(account_id, asset_key), FOREIGN KEY(account_id) REFERENCES cloud_accounts(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS rdp_connections (target_key TEXT PRIMARY KEY, host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 3389, username TEXT NOT NULL, password_ciphertext TEXT, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS managed_hosts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 22, username TEXT NOT NULL, password_ciphertext TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT 'linux', auth_method TEXT NOT NULL DEFAULT 'password', private_key_ciphertext TEXT, key_passphrase_ciphertext TEXT, group_name TEXT, tags TEXT, source_account_id INTEGER, source_asset_key TEXT, host_key_fingerprint TEXT, status TEXT NOT NULL DEFAULT 'unknown', last_latency_ms INTEGER, metrics_json TEXT NOT NULL DEFAULT '{}', last_checked_at INTEGER, last_error TEXT, remark TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS panel_connections (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, panel_url TEXT NOT NULL UNIQUE, api_key_ciphertext TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, allow_insecure_tls INTEGER NOT NULL DEFAULT 0, group_name TEXT, source_account_id INTEGER, source_asset_key TEXT, status TEXT NOT NULL DEFAULT 'unknown', summary_json TEXT NOT NULL DEFAULT '{}', last_checked_at INTEGER, last_error TEXT, remark TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS operation_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, action TEXT NOT NULL, result TEXT NOT NULL, message TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS client_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);")
      .map_err(|error| format!("初始化 SQLite 表失败: {error}"))?;

    let mut conn = conn;
    migrate_connection(&mut conn)?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::migrate_connection;
    use rusqlite::Connection;

    #[test]
    fn migrates_legacy_schema_and_records_current_version() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE cloud_accounts (id INTEGER PRIMARY KEY, account_name TEXT NOT NULL, cloud_type TEXT NOT NULL, access_key_id TEXT NOT NULL, secret_ciphertext TEXT NOT NULL, enabled INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
          CREATE TABLE cloud_assets (account_id INTEGER NOT NULL, resource_type TEXT NOT NULL, asset_key TEXT NOT NULL, region_id TEXT, payload_json TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY(account_id, resource_type, asset_key));
          CREATE TABLE ssh_connections (account_id INTEGER NOT NULL, asset_key TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, username TEXT NOT NULL, password_ciphertext TEXT, host_key_fingerprint TEXT, updated_at INTEGER NOT NULL);
          CREATE TABLE rdp_connections (target_key TEXT PRIMARY KEY, host TEXT NOT NULL, port INTEGER NOT NULL, username TEXT NOT NULL, password_ciphertext TEXT, updated_at INTEGER NOT NULL);
          CREATE TABLE managed_hosts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, username TEXT NOT NULL, password_ciphertext TEXT NOT NULL, host_key_fingerprint TEXT, status TEXT NOT NULL, last_latency_ms INTEGER, metrics_json TEXT NOT NULL, last_checked_at INTEGER, last_error TEXT, remark TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
          CREATE TABLE panel_connections (id INTEGER PRIMARY KEY, name TEXT NOT NULL, panel_url TEXT NOT NULL UNIQUE, api_key_ciphertext TEXT NOT NULL, group_name TEXT, source_account_id INTEGER, source_asset_key TEXT, status TEXT NOT NULL, summary_json TEXT NOT NULL, last_checked_at INTEGER, last_error TEXT, remark TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
          CREATE TABLE operation_logs (id INTEGER PRIMARY KEY, account_id INTEGER, action TEXT NOT NULL, result TEXT NOT NULL, message TEXT, created_at INTEGER NOT NULL);
          CREATE TABLE client_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);").unwrap();
        let mut conn = conn;
        migrate_connection(&mut conn).unwrap();
        let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
        assert_eq!(version, 3);
        let managed_columns: Vec<String> = conn.prepare("PRAGMA table_info(managed_hosts)").unwrap().query_map([], |row| row.get(1)).unwrap().collect::<Result<_, _>>().unwrap();
        for column in ["platform", "auth_method", "private_key_ciphertext", "key_passphrase_ciphertext", "group_name", "tags", "source_account_id", "source_asset_key"] {
            assert!(managed_columns.iter().any(|value| value == column), "missing migrated column {column}");
        }
        let index_count: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN ('idx_cloud_assets_account_type', 'idx_api_logs_created_at', 'idx_operation_logs_created_at')", [], |row| row.get(0)).unwrap();
        assert_eq!(index_count, 3);
    }

    #[test]
    fn rejects_a_newer_schema_version() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", 99).unwrap();
        let mut conn = conn;
        let error = migrate_connection(&mut conn).unwrap_err();
        assert!(error.contains("高于当前客户端支持的版本"));
    }

    #[test]
    fn rolls_back_schema_changes_when_a_required_table_is_missing() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE cloud_accounts (id INTEGER PRIMARY KEY, account_name TEXT NOT NULL, cloud_type TEXT NOT NULL, access_key_id TEXT NOT NULL, secret_ciphertext TEXT NOT NULL, enabled INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);").unwrap();
        let mut conn = conn;
        let error = migrate_connection(&mut conn).unwrap_err();
        assert!(error.contains("no such table") || error.contains("不存在"));
        let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
        assert_eq!(version, 0);
        let columns: Vec<String> = conn.prepare("PRAGMA table_info(cloud_accounts)").unwrap().query_map([], |row| row.get(1)).unwrap().collect::<Result<_, _>>().unwrap();
        assert!(!columns.iter().any(|column| column == "sort_order"));
    }
}
