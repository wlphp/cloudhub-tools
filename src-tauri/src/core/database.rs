use rusqlite::Connection;

use super::paths::data_dir;

pub fn open_db() -> Result<Connection, String> {
    let conn = Connection::open(data_dir()?.join("cloudhub_tools.sqlite3")).map_err(|error| format!("打开 SQLite 失败: {error}"))?;
    conn.execute_batch("PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS cloud_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, account_name TEXT NOT NULL, cloud_type TEXT NOT NULL DEFAULT 'aliyun', group_name TEXT, access_key_id TEXT NOT NULL, secret_ciphertext TEXT NOT NULL, region_id TEXT, enabled INTEGER NOT NULL DEFAULT 1, remark TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_assets (account_id INTEGER NOT NULL, resource_type TEXT NOT NULL, asset_key TEXT NOT NULL, region_id TEXT, payload_json TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY(account_id, resource_type, asset_key), FOREIGN KEY(account_id) REFERENCES cloud_accounts(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS ssh_connections (account_id INTEGER NOT NULL, asset_key TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 22, username TEXT NOT NULL, password_ciphertext TEXT, host_key_fingerprint TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(account_id, asset_key), FOREIGN KEY(account_id) REFERENCES cloud_accounts(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS rdp_connections (target_key TEXT PRIMARY KEY, host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 3389, username TEXT NOT NULL, password_ciphertext TEXT, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS managed_hosts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 22, username TEXT NOT NULL, password_ciphertext TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT 'linux', auth_method TEXT NOT NULL DEFAULT 'password', private_key_ciphertext TEXT, key_passphrase_ciphertext TEXT, group_name TEXT, tags TEXT, source_account_id INTEGER, source_asset_key TEXT, host_key_fingerprint TEXT, status TEXT NOT NULL DEFAULT 'unknown', last_latency_ms INTEGER, metrics_json TEXT NOT NULL DEFAULT '{}', last_checked_at INTEGER, last_error TEXT, remark TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS panel_connections (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, panel_url TEXT NOT NULL UNIQUE, api_key_ciphertext TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, allow_insecure_tls INTEGER NOT NULL DEFAULT 0, group_name TEXT, source_account_id INTEGER, source_asset_key TEXT, status TEXT NOT NULL DEFAULT 'unknown', summary_json TEXT NOT NULL DEFAULT '{}', last_checked_at INTEGER, last_error TEXT, remark TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS operation_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, action TEXT NOT NULL, result TEXT NOT NULL, message TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS client_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);")
      .map_err(|error| format!("初始化 SQLite 表失败: {error}"))?;
    let columns = |table: &str| -> Result<Vec<String>, String> {
        let mut statement = conn.prepare(&format!("PRAGMA table_info({table})")).map_err(|error| error.to_string())?;
        let values = statement.query_map([], |row| row.get::<_, String>(1)).map_err(|error| error.to_string())?
            .filter_map(Result::ok).collect::<Vec<_>>();
        Ok(values)
    };
    let account_columns = columns("cloud_accounts")?;
    if !account_columns.iter().any(|name| name == "sort_order") { conn.execute("ALTER TABLE cloud_accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0", []).map_err(|error| error.to_string())?; }
    if !account_columns.iter().any(|name| name == "credential_meta") { conn.execute("ALTER TABLE cloud_accounts ADD COLUMN credential_meta TEXT", []).map_err(|error| error.to_string())?; }
    let panel_columns = columns("panel_connections")?;
    if !panel_columns.iter().any(|name| name == "allow_insecure_tls") { conn.execute("ALTER TABLE panel_connections ADD COLUMN allow_insecure_tls INTEGER NOT NULL DEFAULT 0", []).map_err(|error| error.to_string())?; }
    if !panel_columns.iter().any(|name| name == "sort_order") { conn.execute("ALTER TABLE panel_connections ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0", []).map_err(|error| error.to_string())?; }
    let managed_columns = columns("managed_hosts")?;
    if !managed_columns.iter().any(|name| name == "platform") { conn.execute("ALTER TABLE managed_hosts ADD COLUMN platform TEXT NOT NULL DEFAULT 'linux'", []).map_err(|error| error.to_string())?; }
    if !managed_columns.iter().any(|name| name == "auth_method") { conn.execute("ALTER TABLE managed_hosts ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password'", []).map_err(|error| error.to_string())?; }
    if !managed_columns.iter().any(|name| name == "private_key_ciphertext") { conn.execute("ALTER TABLE managed_hosts ADD COLUMN private_key_ciphertext TEXT", []).map_err(|error| error.to_string())?; }
    if !managed_columns.iter().any(|name| name == "key_passphrase_ciphertext") { conn.execute("ALTER TABLE managed_hosts ADD COLUMN key_passphrase_ciphertext TEXT", []).map_err(|error| error.to_string())?; }
    conn.execute("CREATE TABLE IF NOT EXISTS api_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, endpoint TEXT NOT NULL, action TEXT NOT NULL, request_params TEXT NOT NULL, response_params TEXT, status TEXT NOT NULL, message TEXT, created_at INTEGER NOT NULL)", []).map_err(|error| error.to_string())?;
    Ok(conn)
}
