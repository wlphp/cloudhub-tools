use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rand::RngCore;
use rusqlite::Connection;
use std::{fs, path::PathBuf};

pub fn data_dir() -> Result<PathBuf, String> {
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
        let values = conn.prepare(&format!("PRAGMA table_info({table})")).map_err(|error| error.to_string())?
            .query_map([], |row| row.get::<_, String>(1)).map_err(|error| error.to_string())?
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

fn crypto_key() -> Result<[u8; 32], String> {
    let path = data_dir()?.join(".key");
    if path.exists() {
        let bytes = fs::read(&path).map_err(|error| error.to_string())?;
        return bytes.try_into().map_err(|_| "本地密钥无效".to_string());
    }
    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    fs::write(path, key).map_err(|error| error.to_string())?;
    Ok(key)
}

pub fn encrypt_secret(secret: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&crypto_key()?));
    let mut nonce = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce);
    let encrypted = cipher.encrypt(Nonce::from_slice(&nonce), secret.as_bytes()).map_err(|_| "加密 Secret 失败".to_string())?;
    let mut packed = nonce.to_vec();
    packed.extend(encrypted);
    Ok(B64.encode(packed))
}

pub fn decrypt_secret(ciphertext: &str) -> Result<String, String> {
    let packed = B64.decode(ciphertext).map_err(|error| format!("读取 Secret 失败: {error}"))?;
    if packed.len() < 12 { return Err("本地 Secret 数据损坏".into()); }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&crypto_key()?));
    let value = cipher.decrypt(Nonce::from_slice(&packed[..12]), &packed[12..]).map_err(|_| "解密 Secret 失败".to_string())?;
    String::from_utf8(value).map_err(|_| "Secret 编码无效".into())
}
