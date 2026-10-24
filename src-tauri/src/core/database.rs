use rusqlite::{Connection, OptionalExtension};
use std::sync::Mutex;

use super::paths::data_dir;

const CURRENT_SCHEMA_VERSION: i64 = 56;
pub const CODEX_PROVIDER_LOGS_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS codex_provider_request_logs(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,source TEXT NOT NULL,method TEXT NOT NULL,url TEXT NOT NULL,request_body TEXT NOT NULL,status INTEGER,response_body TEXT NOT NULL,error TEXT,elapsed_ms INTEGER NOT NULL,created_at INTEGER NOT NULL,client_request_body TEXT NOT NULL DEFAULT ''); CREATE INDEX IF NOT EXISTS codex_provider_request_logs_provider ON codex_provider_request_logs(provider_id,created_at DESC);";
pub const CODEX_PROVIDERS_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS codex_model_providers(id TEXT PRIMARY KEY,name TEXT NOT NULL,base_url TEXT NOT NULL,wire_api TEXT NOT NULL,models_json TEXT NOT NULL,note TEXT NOT NULL,version INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS codex_provider_keys(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL REFERENCES codex_model_providers(id) ON DELETE CASCADE,name TEXT NOT NULL,ciphertext TEXT NOT NULL,UNIQUE(provider_id,name));";
pub const CODEX_PROVIDER_BACKUPS_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS codex_provider_config_backups(home TEXT PRIMARY KEY,content_ciphertext TEXT NOT NULL,installed_config TEXT NOT NULL,installed_auth TEXT NOT NULL);";
pub const CODEX_PROVIDER_AGGREGATES_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS codex_provider_aggregates(id TEXT PRIMARY KEY,name TEXT NOT NULL,strategy TEXT NOT NULL,version INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS codex_provider_aggregate_members(aggregate_id TEXT NOT NULL,position INTEGER NOT NULL,provider_id TEXT NOT NULL,key_id TEXT NOT NULL,weight INTEGER NOT NULL,PRIMARY KEY(aggregate_id,position),UNIQUE(aggregate_id,provider_id,key_id));";
// Migration 37 has already run on local databases. Keep its additive schema even
// when the browser feature is absent; removing a feature must not erase migration history.
const BROWSER_ENVIRONMENTS_V37_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS browser_environments (
    id TEXT PRIMARY KEY, config_json TEXT NOT NULL, proxy_secret_ciphertext TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    last_opened_at INTEGER, deleted_at INTEGER
);";
// Schema is shared by desktop and mobile; migrations must not depend on desktop modules.
pub const CODEX_GATEWAY_PREFERENCES_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS codex_gateway_preferences(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);";
pub const CODEX_ACCOUNT_CONTROLS_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS codex_account_controls(account_id INTEGER PRIMARY KEY REFERENCES codex_accounts(id) ON DELETE CASCADE,proxy_url TEXT,benefits_json TEXT,reset_request_id TEXT);";
pub const CODEX_ACCOUNT_EVENTS_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS codex_account_events(id INTEGER PRIMARY KEY AUTOINCREMENT,account_id INTEGER NOT NULL REFERENCES codex_accounts(id) ON DELETE CASCADE,event_type TEXT NOT NULL,message TEXT NOT NULL,details_json TEXT,created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_codex_account_events_account_time ON codex_account_events(account_id,created_at DESC,id DESC);";
pub const CODEX_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS codex_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL, email TEXT, account_id TEXT, auth_mode TEXT NOT NULL,
    plan TEXT, note TEXT NOT NULL DEFAULT '', tags_json TEXT NOT NULL DEFAULT '[]',
    auth_ciphertext TEXT NOT NULL, quota_json TEXT NOT NULL DEFAULT '{}',
    last_error TEXT, updated_at INTEGER NOT NULL, deleted_at INTEGER
); CREATE TABLE IF NOT EXISTS codex_profile_backups (
    profile_home TEXT PRIMARY KEY, auth_ciphertext TEXT, installed_fingerprint TEXT NOT NULL,
    previous_fingerprint TEXT NOT NULL
); CREATE TABLE IF NOT EXISTS codex_profiles (
    id TEXT PRIMARY KEY, account_id INTEGER NOT NULL, name TEXT NOT NULL,
    work_dir TEXT NOT NULL, created_at INTEGER NOT NULL, auth_fingerprint TEXT, kind TEXT NOT NULL DEFAULT 'cli',
    FOREIGN KEY(account_id) REFERENCES codex_accounts(id) ON DELETE CASCADE
); CREATE TABLE IF NOT EXISTS codex_gateway_config (
    id INTEGER PRIMARY KEY CHECK(id=1), port INTEGER NOT NULL CHECK(port BETWEEN 1024 AND 65535),
    key_ciphertext TEXT NOT NULL, auto_start INTEGER NOT NULL DEFAULT 0,
    account_ids_json TEXT NOT NULL DEFAULT '[]'
 );CREATE TABLE IF NOT EXISTS codex_gateway_network(id INTEGER PRIMARY KEY CHECK(id=1),allow_lan INTEGER NOT NULL DEFAULT 0 CHECK(allow_lan IN (0,1)));CREATE TABLE IF NOT EXISTS codex_gateway_pool(id INTEGER PRIMARY KEY CHECK(id=1),account_ids_json TEXT NOT NULL);CREATE TABLE IF NOT EXISTS codex_account_controls(account_id INTEGER PRIMARY KEY REFERENCES codex_accounts(id) ON DELETE CASCADE,proxy_url TEXT,benefits_json TEXT,reset_request_id TEXT);";

// Several desktop commands open the database concurrently during startup. Keep
// schema setup and migrations serialized so simultaneous `CREATE ... IF NOT
// EXISTS` / migration transactions do not fail with transient SQLite locks.
static DATABASE_OPEN_LOCK: Mutex<()> = Mutex::new(());

fn create_sync_triggers(transaction: &rusqlite::Transaction<'_>, table: &str, entity_type: &str, fields: &[&str]) -> Result<(), String> {
    let changed_fields = fields.iter().map(|field| format!("OLD.{field} IS NOT NEW.{field}")).collect::<Vec<_>>().join(" OR ");
    let sql = format!("CREATE TRIGGER IF NOT EXISTS {table}_sync_insert AFTER INSERT ON {table} WHEN NEW.sync_id IS NOT NULL AND NEW.sync_id!='' AND NOT EXISTS(SELECT 1 FROM sync_apply_guard WHERE id=1 AND applying=1) BEGIN
      INSERT INTO sync_local_versions(entity_type,entity_sync_id,counter) VALUES('{entity_type}',NEW.sync_id,1) ON CONFLICT(entity_type,entity_sync_id) DO UPDATE SET counter=counter+1;
      INSERT INTO sync_outbox(message_id,entity_type,entity_sync_id,operation,version_json,created_at) SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))),'{entity_type}',NEW.sync_id,'upsert',printf('{{\"%s\":%d}}',device_id,counter),CAST(strftime('%s','now') AS INTEGER)*1000 FROM sync_local_device,sync_local_versions WHERE sync_local_device.id=1 AND sync_local_versions.entity_type='{entity_type}' AND sync_local_versions.entity_sync_id=NEW.sync_id;
    END;
    CREATE TRIGGER IF NOT EXISTS {table}_sync_update AFTER UPDATE ON {table} WHEN ({changed_fields}) AND NOT EXISTS(SELECT 1 FROM sync_apply_guard WHERE id=1 AND applying=1) BEGIN
      INSERT INTO sync_local_versions(entity_type,entity_sync_id,counter) VALUES('{entity_type}',NEW.sync_id,1) ON CONFLICT(entity_type,entity_sync_id) DO UPDATE SET counter=counter+1;
      INSERT INTO sync_outbox(message_id,entity_type,entity_sync_id,operation,version_json,created_at) SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))),'{entity_type}',NEW.sync_id,'upsert',printf('{{\"%s\":%d}}',device_id,counter),CAST(strftime('%s','now') AS INTEGER)*1000 FROM sync_local_device,sync_local_versions WHERE sync_local_device.id=1 AND sync_local_versions.entity_type='{entity_type}' AND sync_local_versions.entity_sync_id=NEW.sync_id;
    END;
    CREATE TRIGGER IF NOT EXISTS {table}_sync_delete AFTER DELETE ON {table} WHEN OLD.sync_id IS NOT NULL AND OLD.sync_id!='' AND NOT EXISTS(SELECT 1 FROM sync_apply_guard WHERE id=1 AND applying=1) BEGIN
      INSERT INTO sync_local_versions(entity_type,entity_sync_id,counter) VALUES('{entity_type}',OLD.sync_id,1) ON CONFLICT(entity_type,entity_sync_id) DO UPDATE SET counter=counter+1;
      INSERT INTO sync_tombstones(entity_type,entity_sync_id,deleted_by_device_id,version_json,deleted_at) SELECT '{entity_type}',OLD.sync_id,device_id,printf('{{\"%s\":%d}}',device_id,counter),CAST(strftime('%s','now') AS INTEGER)*1000 FROM sync_local_device,sync_local_versions WHERE sync_local_device.id=1 AND sync_local_versions.entity_type='{entity_type}' AND sync_local_versions.entity_sync_id=OLD.sync_id ON CONFLICT(entity_type,entity_sync_id) DO UPDATE SET deleted_by_device_id=excluded.deleted_by_device_id,version_json=excluded.version_json,deleted_at=excluded.deleted_at;
      INSERT INTO sync_outbox(message_id,entity_type,entity_sync_id,operation,version_json,created_at) SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))),'{entity_type}',OLD.sync_id,'delete',printf('{{\"%s\":%d}}',device_id,counter),CAST(strftime('%s','now') AS INTEGER)*1000 FROM sync_local_device,sync_local_versions WHERE sync_local_device.id=1 AND sync_local_versions.entity_type='{entity_type}' AND sync_local_versions.entity_sync_id=OLD.sync_id;
    END;");
    transaction.execute_batch(&sql).map_err(|error| format!("创建 {entity_type} 同步变更触发器失败: {error}"))
}

fn migrate_connection(conn: &mut Connection) -> Result<(), String> {
    let foreign_keys: bool = conn.pragma_query_value(None, "foreign_keys", |row| row.get(0)).map_err(|_| "读取数据库约束失败")?;
    let legacy_alter: bool = conn.pragma_query_value(None, "legacy_alter_table", |row| row.get(0)).map_err(|_| "读取数据库迁移配置失败")?;
    // Rebuild certificates without cascading into sync identities or deployments.
    conn.pragma_update(None, "foreign_keys", false).map_err(|_| "准备证书迁移失败")?;
    conn.pragma_update(None, "legacy_alter_table", true).map_err(|_| "准备证书表重建失败")?;
    let result = migrate_connection_inner(conn);
    conn.pragma_update(None, "legacy_alter_table", legacy_alter).map_err(|_| "恢复数据库迁移配置失败")?;
    conn.pragma_update(None, "foreign_keys", foreign_keys).map_err(|_| "恢复数据库约束失败")?;
    result
}

fn migrate_connection_inner(conn: &mut Connection) -> Result<(), String> {
    let version = supported_schema_version(conn)?;

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
        transaction.pragma_update(None, "user_version", 3).map_err(|error| error.to_string())?;
    }
    if version < 4 {
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS certificates (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, provider TEXT NOT NULL, primary_domain TEXT NOT NULL, domains_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'issued', order_url TEXT, certificate_url TEXT, certificate_pem_ciphertext TEXT, private_key_ciphertext TEXT, serial_number TEXT, issuer TEXT, not_before INTEGER, not_after INTEGER, dns_zone TEXT NOT NULL, dns_record_ids_json TEXT NOT NULL DEFAULT '[]', last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, FOREIGN KEY(account_id) REFERENCES cloud_accounts(id) ON DELETE CASCADE); CREATE INDEX IF NOT EXISTS idx_certificates_account ON certificates(account_id, updated_at DESC); CREATE INDEX IF NOT EXISTS idx_certificates_expiry ON certificates(not_after);")
            .map_err(|error| error.to_string())?;
        transaction.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION).map_err(|error| error.to_string())?;
    }
    if version < 5 {
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS flow_connections (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, edition TEXT NOT NULL, organization_id TEXT, domain TEXT NOT NULL, token_ciphertext TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);")
            .map_err(|error| error.to_string())?;
        transaction.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION).map_err(|error| error.to_string())?;
    }
    if version < 6 {
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS frp_clients (managed_host_id INTEGER PRIMARY KEY, server_addr TEXT NOT NULL, server_port INTEGER NOT NULL, token_ciphertext TEXT, admin_user TEXT NOT NULL, admin_password_ciphertext TEXT NOT NULL, admin_port INTEGER NOT NULL, proxies_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, FOREIGN KEY(managed_host_id) REFERENCES managed_hosts(id) ON DELETE CASCADE);")
            .map_err(|error| error.to_string())?;
        transaction.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION).map_err(|error| error.to_string())?;
    }
    if version < 7 {
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS frp_local_client (id INTEGER PRIMARY KEY CHECK(id = 1), server_addr TEXT NOT NULL, server_port INTEGER NOT NULL, token_ciphertext TEXT, admin_user TEXT NOT NULL, admin_password_ciphertext TEXT NOT NULL, admin_port INTEGER NOT NULL, proxies_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); INSERT OR IGNORE INTO frp_local_client(id, server_addr, server_port, token_ciphertext, admin_user, admin_password_ciphertext, admin_port, proxies_json, created_at, updated_at) SELECT 1, server_addr, server_port, token_ciphertext, admin_user, admin_password_ciphertext, admin_port, proxies_json, created_at, updated_at FROM frp_clients ORDER BY updated_at DESC LIMIT 1;")
            .map_err(|error| error.to_string())?;
        transaction.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION).map_err(|error| error.to_string())?;
    }
    if version < 8 {
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS frp_local_settings (id INTEGER PRIMARY KEY CHECK(id = 1), admin_user TEXT NOT NULL, admin_password_ciphertext TEXT NOT NULL, updated_at INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS frp_local_servers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, server_addr TEXT NOT NULL, server_port INTEGER NOT NULL, token_ciphertext TEXT, admin_port INTEGER NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS frp_local_proxies (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, local_ip TEXT NOT NULL, local_port INTEGER NOT NULL, remote_port INTEGER, custom_domain TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, FOREIGN KEY(server_id) REFERENCES frp_local_servers(id) ON DELETE CASCADE, UNIQUE(server_id, name));
          CREATE INDEX IF NOT EXISTS idx_frp_local_proxies_server ON frp_local_proxies(server_id);
          INSERT OR IGNORE INTO frp_local_settings(id,admin_user,admin_password_ciphertext,updated_at) SELECT 1,admin_user,admin_password_ciphertext,updated_at FROM frp_local_client WHERE id=1;
          INSERT OR IGNORE INTO frp_local_servers(id,name,server_addr,server_port,token_ciphertext,admin_port,created_at,updated_at) SELECT 1,server_addr || ':' || server_port,server_addr,server_port,token_ciphertext,admin_port,created_at,updated_at FROM frp_local_client WHERE id=1;")
            .map_err(|error| error.to_string())?;
        let legacy: Option<(String, i64)> = transaction.query_row("SELECT proxies_json,updated_at FROM frp_local_client WHERE id=1", [], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(|error| error.to_string())?;
        if let Some((json, updated_at)) = legacy {
            let proxies: Vec<serde_json::Value> = serde_json::from_str(&json).map_err(|error| format!("迁移 FRP 规则失败: {error}"))?;
            for proxy in proxies {
                let name = proxy.get("name").and_then(|v| v.as_str()).ok_or("旧 FRP 规则缺少名称")?;
                let kind = proxy.get("kind").and_then(|v| v.as_str()).ok_or("旧 FRP 规则缺少类型")?;
                let local_ip = proxy.get("localIp").and_then(|v| v.as_str()).ok_or("旧 FRP 规则缺少本地地址")?;
                let local_port = proxy.get("localPort").and_then(|v| v.as_i64()).ok_or("旧 FRP 规则缺少本地端口")?;
                let remote_port = proxy.get("remotePort").and_then(|v| v.as_i64());
                let custom_domain = proxy.get("customDomain").and_then(|v| v.as_str());
                let enabled = proxy.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
                transaction.execute("INSERT OR IGNORE INTO frp_local_proxies(server_id,name,kind,local_ip,local_port,remote_port,custom_domain,enabled,created_at,updated_at) VALUES(1,?1,?2,?3,?4,?5,?6,?7,?8,?8)", rusqlite::params![name,kind,local_ip,local_port,remote_port,custom_domain,enabled,updated_at]).map_err(|error| error.to_string())?;
            }
        }
        transaction.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION).map_err(|error| error.to_string())?;
    }
    if version < 9 {
        ensure_column("frp_local_servers", "panel_url", "TEXT")?;
        ensure_column("frp_local_servers", "panel_username", "TEXT")?;
        ensure_column("frp_local_servers", "panel_password_ciphertext", "TEXT")?;
        transaction.pragma_update(None, "user_version", 9).map_err(|error| error.to_string())?;
    }
    if version < 10 {
        ensure_column("frp_local_proxies", "custom_domains_json", "TEXT NOT NULL DEFAULT '[]'")?;
        ensure_column("frp_local_proxies", "plugin_json", "TEXT")?;
        let legacy = {
            let mut statement = transaction.prepare("SELECT id,custom_domain FROM frp_local_proxies WHERE custom_domain IS NOT NULL AND custom_domain != ''").map_err(|error| error.to_string())?;
            let rows = statement.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))).map_err(|error| error.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?
        };
        for (id, domain) in legacy {
            let json = serde_json::to_string(&vec![domain]).map_err(|_| "迁移 FRP 域名失败")?;
            transaction.execute("UPDATE frp_local_proxies SET custom_domains_json=?1 WHERE id=?2", rusqlite::params![json, id]).map_err(|error| error.to_string())?;
        }
        transaction.pragma_update(None, "user_version", 10).map_err(|error| error.to_string())?;
    }
    if version < 11 {
        ensure_column("cloud_accounts", "sync_id", "TEXT")?;
        ensure_column("managed_hosts", "sync_id", "TEXT")?;
        ensure_column("panel_connections", "sync_id", "TEXT")?;

        for (table, id_column) in [("cloud_accounts", "id"), ("managed_hosts", "id"), ("panel_connections", "id")] {
            let missing_ids = {
                let mut statement = transaction.prepare(&format!("SELECT {id_column} FROM {table} WHERE sync_id IS NULL OR sync_id = ''")).map_err(|error| error.to_string())?;
                let rows = statement.query_map([], |row| row.get::<_, i64>(0)).map_err(|error| error.to_string())?;
                rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?
            };
            for local_id in missing_ids {
                transaction.execute(&format!("UPDATE {table} SET sync_id=?1 WHERE {id_column}=?2"), rusqlite::params![uuid::Uuid::new_v4().to_string(), local_id]).map_err(|error| error.to_string())?;
            }
        }

        transaction.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_accounts_sync_id ON cloud_accounts(sync_id);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_hosts_sync_id ON managed_hosts(sync_id);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_panel_connections_sync_id ON panel_connections(sync_id);
          CREATE TABLE IF NOT EXISTS sync_devices (device_id TEXT PRIMARY KEY, device_name TEXT NOT NULL, public_key BLOB NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','trusted','revoked')), created_at INTEGER NOT NULL, approved_at INTEGER, revoked_at INTEGER, last_seen_at INTEGER);
          CREATE TABLE IF NOT EXISTS sync_local_device (id INTEGER PRIMARY KEY CHECK(id=1), device_id TEXT NOT NULL UNIQUE, device_name TEXT NOT NULL, created_at INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS sync_local_versions (entity_type TEXT NOT NULL, entity_sync_id TEXT NOT NULL, counter INTEGER NOT NULL CHECK(counter>0), PRIMARY KEY(entity_type,entity_sync_id));
          CREATE TABLE IF NOT EXISTS sync_entity_versions (peer_device_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_sync_id TEXT NOT NULL, remote_id TEXT, base_version_json TEXT NOT NULL DEFAULT '{}', current_version_json TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL, PRIMARY KEY(peer_device_id,entity_type,entity_sync_id), FOREIGN KEY(peer_device_id) REFERENCES sync_devices(device_id) ON DELETE CASCADE);
          CREATE TABLE IF NOT EXISTS sync_tombstones (entity_type TEXT NOT NULL, entity_sync_id TEXT NOT NULL, deleted_by_device_id TEXT NOT NULL, version_json TEXT NOT NULL, deleted_at INTEGER NOT NULL, PRIMARY KEY(entity_type,entity_sync_id));
          CREATE TABLE IF NOT EXISTS sync_outbox (sequence INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE, entity_type TEXT NOT NULL, entity_sync_id TEXT NOT NULL, operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')), version_json TEXT NOT NULL, created_at INTEGER NOT NULL, acknowledged_at INTEGER);
          CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending ON sync_outbox(acknowledged_at,sequence);
          CREATE TRIGGER IF NOT EXISTS cloud_accounts_sync_id_after_insert AFTER INSERT ON cloud_accounts WHEN NEW.sync_id IS NULL OR NEW.sync_id='' BEGIN UPDATE cloud_accounts SET sync_id=lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))) WHERE id=NEW.id; END;
          CREATE TRIGGER IF NOT EXISTS managed_hosts_sync_id_after_insert AFTER INSERT ON managed_hosts WHEN NEW.sync_id IS NULL OR NEW.sync_id='' BEGIN UPDATE managed_hosts SET sync_id=lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))) WHERE id=NEW.id; END;
          CREATE TRIGGER IF NOT EXISTS panel_connections_sync_id_after_insert AFTER INSERT ON panel_connections WHEN NEW.sync_id IS NULL OR NEW.sync_id='' BEGIN UPDATE panel_connections SET sync_id=lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))) WHERE id=NEW.id; END;")
            .map_err(|error| error.to_string())?;
        transaction.execute("INSERT OR IGNORE INTO sync_local_device(id,device_id,device_name,created_at) VALUES(1,?1,'本机',CAST(strftime('%s','now') AS INTEGER)*1000)", [uuid::Uuid::new_v4().to_string()]).map_err(|error| error.to_string())?;

        create_sync_triggers(&transaction, "cloud_accounts", "cloud_account", &["account_name", "cloud_type", "group_name", "access_key_id", "secret_ciphertext", "credential_meta", "region_id", "sort_order", "enabled", "remark"])?;
        create_sync_triggers(&transaction, "managed_hosts", "managed_host", &["name", "host", "port", "username", "password_ciphertext", "platform", "auth_method", "private_key_ciphertext", "key_passphrase_ciphertext", "group_name", "tags", "source_account_id", "source_asset_key", "host_key_fingerprint", "remark"])?;
        create_sync_triggers(&transaction, "panel_connections", "panel_connection", &["name", "panel_url", "api_key_ciphertext", "sort_order", "allow_insecure_tls", "group_name", "source_account_id", "source_asset_key", "remark"])?;
        transaction.pragma_update(None, "user_version", 11).map_err(|error| error.to_string())?;
    }
    if version < 12 {
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS sync_outbox_acknowledgements (message_id TEXT NOT NULL, peer_device_id TEXT NOT NULL, acknowledged_at INTEGER NOT NULL, PRIMARY KEY(message_id,peer_device_id), FOREIGN KEY(message_id) REFERENCES sync_outbox(message_id) ON DELETE CASCADE, FOREIGN KEY(peer_device_id) REFERENCES sync_devices(device_id) ON DELETE CASCADE);
          CREATE INDEX IF NOT EXISTS idx_sync_outbox_ack_peer ON sync_outbox_acknowledgements(peer_device_id,acknowledged_at);")
            .map_err(|error| error.to_string())?;
        transaction.pragma_update(None, "user_version", 12).map_err(|error| error.to_string())?;
    }
    if version < 13 {
        ensure_column("sync_local_device", "public_key", "BLOB")?;
        transaction.pragma_update(None, "user_version", 13).map_err(|error| error.to_string())?;
    }
    if version < 14 {
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS sync_device_scope (peer_device_id TEXT NOT NULL, entity_type TEXT NOT NULL CHECK(entity_type IN ('cloud_account','managed_host','panel_connection')), entity_sync_id TEXT NOT NULL, granted_at INTEGER NOT NULL, PRIMARY KEY(peer_device_id,entity_type,entity_sync_id), FOREIGN KEY(peer_device_id) REFERENCES sync_devices(device_id) ON DELETE CASCADE);
          CREATE INDEX IF NOT EXISTS idx_sync_device_scope_entity ON sync_device_scope(entity_type,entity_sync_id);").map_err(|error| error.to_string())?;
        transaction.pragma_update(None, "user_version", 14).map_err(|error| error.to_string())?;
    }
    if version < 15 {
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS sync_apply_guard (id INTEGER PRIMARY KEY CHECK(id=1), applying INTEGER NOT NULL DEFAULT 0 CHECK(applying IN (0,1))); INSERT OR IGNORE INTO sync_apply_guard(id,applying) VALUES(1,0);
          DROP TRIGGER IF EXISTS cloud_accounts_sync_insert; DROP TRIGGER IF EXISTS cloud_accounts_sync_update; DROP TRIGGER IF EXISTS cloud_accounts_sync_delete;
          DROP TRIGGER IF EXISTS managed_hosts_sync_insert; DROP TRIGGER IF EXISTS managed_hosts_sync_update; DROP TRIGGER IF EXISTS managed_hosts_sync_delete;
          DROP TRIGGER IF EXISTS panel_connections_sync_insert; DROP TRIGGER IF EXISTS panel_connections_sync_update; DROP TRIGGER IF EXISTS panel_connections_sync_delete;").map_err(|error| error.to_string())?;
        create_sync_triggers(&transaction, "cloud_accounts", "cloud_account", &["account_name", "cloud_type", "group_name", "access_key_id", "secret_ciphertext", "credential_meta", "region_id", "sort_order", "enabled", "remark"])?;
        create_sync_triggers(&transaction, "managed_hosts", "managed_host", &["name", "host", "port", "username", "password_ciphertext", "platform", "auth_method", "private_key_ciphertext", "key_passphrase_ciphertext", "group_name", "tags", "source_account_id", "source_asset_key", "host_key_fingerprint", "remark"])?;
        create_sync_triggers(&transaction, "panel_connections", "panel_connection", &["name", "panel_url", "api_key_ciphertext", "sort_order", "allow_insecure_tls", "group_name", "source_account_id", "source_asset_key", "remark"])?;
        transaction.pragma_update(None, "user_version", 15).map_err(|error| error.to_string())?;
    }
    if version < 16 {
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS sync_inbox (peer_device_id TEXT NOT NULL, message_id TEXT NOT NULL, sequence INTEGER NOT NULL, entity_type TEXT NOT NULL CHECK(entity_type IN ('cloud_account','managed_host','panel_connection')), entity_sync_id TEXT NOT NULL, operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')), version_json TEXT NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY(peer_device_id,message_id), FOREIGN KEY(peer_device_id) REFERENCES sync_devices(device_id) ON DELETE CASCADE);
          CREATE INDEX IF NOT EXISTS idx_sync_inbox_entity ON sync_inbox(peer_device_id,entity_type,entity_sync_id,sequence);").map_err(|error| error.to_string())?;
        transaction.pragma_update(None, "user_version", 16).map_err(|error| error.to_string())?;
    }
    if version < 17 {
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS sync_pending_acknowledgements (
            peer_device_id TEXT NOT NULL,
            batch_key TEXT NOT NULL,
            acknowledgement_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY(peer_device_id,batch_key),
            FOREIGN KEY(peer_device_id) REFERENCES sync_devices(device_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_sync_pending_ack_created ON sync_pending_acknowledgements(created_at);").map_err(|error| error.to_string())?;
        transaction.pragma_update(None, "user_version", 17).map_err(|error| error.to_string())?;
    }
    if version < 18 {
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS flow_pipeline_cache (
            connection_id INTEGER NOT NULL, query_key TEXT NOT NULL,
            payload_ciphertext TEXT NOT NULL, updated_at INTEGER NOT NULL,
            PRIMARY KEY(connection_id,query_key),
            FOREIGN KEY(connection_id) REFERENCES flow_connections(id) ON DELETE CASCADE
        );").map_err(|error| error.to_string())?;
        transaction.pragma_update(None, "user_version", 18).map_err(|error| error.to_string())?;
    }
    if version < 19 {
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS flow_sync_identity (
            connection_id INTEGER PRIMARY KEY, sync_id TEXT NOT NULL UNIQUE,
            FOREIGN KEY(connection_id) REFERENCES flow_connections(id) ON DELETE CASCADE
        );").map_err(|_| "创建云效同步身份表失败")?;
        transaction.pragma_update(None, "user_version", 19).map_err(|error| error.to_string())?;
    }
    if version < 20 {
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS certificate_sync_identity (
            certificate_id INTEGER PRIMARY KEY, sync_id TEXT NOT NULL UNIQUE,
            FOREIGN KEY(certificate_id) REFERENCES certificates(id) ON DELETE CASCADE
        ); CREATE TABLE IF NOT EXISTS certificate_snapshots (
            sync_id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL, synced_at INTEGER NOT NULL
        );").map_err(|_| "创建证书同步表失败")?;
        transaction.pragma_update(None, "user_version", 20).map_err(|error| error.to_string())?;
    }
    if version < 21 {
        transaction.execute_batch(super::repositories::authenticator::SCHEMA).map_err(|_| "创建验证器密码库失败")?;
        transaction.pragma_update(None, "user_version", 21).map_err(|_| "更新验证器数据库版本失败")?;
    }
    if version < 22 {
        transaction.execute_batch(CODEX_SCHEMA).map_err(|_| "创建 Codex 账号表失败")?;
        transaction.pragma_update(None, "user_version", 22).map_err(|_| "更新 Codex 数据库版本失败")?;
    }
    if version < 23 {
        transaction.execute_batch(CODEX_SCHEMA).map_err(|_| "创建 Codex 实例表失败")?;
        ensure_column("codex_profiles", "auth_fingerprint", "TEXT")?;
        transaction.pragma_update(None, "user_version", 23).map_err(|_| "更新 Codex 实例数据库版本失败")?;
    }
    if version < 24 {
        transaction.execute_batch(CODEX_SCHEMA).map_err(|_| "创建 Codex 实例表失败")?;
        ensure_column("codex_profiles", "kind", "TEXT NOT NULL DEFAULT 'cli'")?;
        transaction.pragma_update(None,"user_version",24).map_err(|_|"更新 Codex 桌面实例数据库版本失败")?;
    }
    if version < 25 {
        transaction.execute_batch(CODEX_SCHEMA).map_err(|_| "创建 Codex API 配置表失败")?;
        transaction.pragma_update(None, "user_version", 25).map_err(|_| "更新 Codex API 配置数据库版本失败")?;
    }
    if version < 26 {
        transaction.execute_batch(CODEX_GATEWAY_PREFERENCES_SCHEMA).map_err(|_| "创建网关规则表失败")?;
        transaction.pragma_update(None, "user_version", 26).map_err(|_| "更新网关规则数据库版本失败")?;
    }
    if version < 27 {
        transaction.execute_batch(CODEX_ACCOUNT_CONTROLS_SCHEMA).map_err(|_|"创建账号权益表失败")?;
        transaction.pragma_update(None,"user_version",27).map_err(|_|"更新账号权益数据库版本失败")?;
    }
    if version < 28 {
        ensure_column("codex_gateway_config", "auto_start", "INTEGER NOT NULL DEFAULT 0")?;
        ensure_column("codex_gateway_config", "account_ids_json", "TEXT NOT NULL DEFAULT '[]'")?;
        transaction.pragma_update(None,"user_version",28).map_err(|_|"更新反代自动启动配置版本失败")?;
    }
    if version < 29 {
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS codex_gateway_pool(id INTEGER PRIMARY KEY CHECK(id=1),account_ids_json TEXT NOT NULL);").map_err(|_| "创建反代账号池配置失败")?;
        transaction.pragma_update(None,"user_version",29).map_err(|_| "更新反代账号池配置版本失败")?;
    }
    if version < 30 {
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS codex_gateway_network(id INTEGER PRIMARY KEY CHECK(id=1),allow_lan INTEGER NOT NULL DEFAULT 0 CHECK(allow_lan IN (0,1)));").map_err(|_| "创建服务访问范围配置失败")?;
        transaction.pragma_update(None,"user_version",30).map_err(|_| "更新服务访问范围版本失败")?;
    }
    if version < 31 {
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS esa_certificate_deployments(account_id INTEGER NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,site_id INTEGER NOT NULL,certificate_id INTEGER NOT NULL REFERENCES certificates(id) ON DELETE CASCADE,remote_id TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(account_id,site_id,certificate_id));").map_err(|_| "创建 ESA 证书部署关联失败")?;
        transaction.pragma_update(None,"user_version",31).map_err(|_| "更新 ESA 证书部署版本失败")?;
    }
    if version < 32 {
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS certificates(id INTEGER PRIMARY KEY AUTOINCREMENT);").map_err(|_| "准备旧证书表失败")?;
        let original_columns = columns("certificates")?;
        transaction.execute_batch("CREATE TABLE certificates_v32 (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER REFERENCES cloud_accounts(id) ON DELETE SET NULL, provider TEXT NOT NULL, primary_domain TEXT NOT NULL, domains_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'issued', order_url TEXT, certificate_url TEXT, certificate_pem_ciphertext TEXT, private_key_ciphertext TEXT, serial_number TEXT, issuer TEXT, not_before INTEGER, not_after INTEGER, dns_zone TEXT NOT NULL DEFAULT '', dns_record_ids_json TEXT NOT NULL DEFAULT '[]', last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source_kind TEXT NOT NULL DEFAULT 'acme' CHECK(source_kind IN ('acme','manual','baota')), fingerprint TEXT);").map_err(|_| "创建新证书存储失败")?;
        let fields = [("id", "NULL"), ("account_id", "NULL"), ("provider", "''"), ("primary_domain", "''"), ("domains_json", "'[]'"), ("status", "'issued'"), ("order_url", "NULL"), ("certificate_url", "NULL"), ("certificate_pem_ciphertext", "NULL"), ("private_key_ciphertext", "NULL"), ("serial_number", "NULL"), ("issuer", "NULL"), ("not_before", "NULL"), ("not_after", "NULL"), ("dns_zone", "''"), ("dns_record_ids_json", "'[]'"), ("last_error", "NULL"), ("created_at", "0"), ("updated_at", "0"), ("source_kind", "'acme'"), ("fingerprint", "NULL")];
        let names = fields.iter().map(|(name, _)| *name).collect::<Vec<_>>().join(",");
        let values = fields.iter().map(|(name, default)| if original_columns.iter().any(|column| column == name) { *name } else { *default }).collect::<Vec<_>>().join(",");
        transaction.execute_batch(&format!("INSERT INTO certificates_v32({names}) SELECT {values} FROM certificates; DROP TABLE certificates; ALTER TABLE certificates_v32 RENAME TO certificates; CREATE INDEX idx_certificates_account ON certificates(account_id,updated_at DESC); CREATE INDEX idx_certificates_expiry ON certificates(not_after); CREATE UNIQUE INDEX idx_certificates_fingerprint ON certificates(fingerprint) WHERE fingerprint IS NOT NULL;")).map_err(|error| format!("迁移现有证书失败: {error}"))?;
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS certificate_source_links(id INTEGER PRIMARY KEY AUTOINCREMENT,panel_id INTEGER REFERENCES panel_connections(id) ON DELETE SET NULL,site_id INTEGER NOT NULL,site_name TEXT NOT NULL,site_domains_json TEXT NOT NULL DEFAULT '[]',panel_name TEXT NOT NULL,certificate_id INTEGER REFERENCES certificates(id) ON DELETE SET NULL,order_index TEXT,ssl_hash TEXT,fingerprint TEXT,metadata_json TEXT NOT NULL DEFAULT '{}',last_checked_at INTEGER,last_error TEXT,UNIQUE(panel_id,site_id)); CREATE TABLE IF NOT EXISTS certificate_versions(id INTEGER PRIMARY KEY AUTOINCREMENT,certificate_id INTEGER NOT NULL REFERENCES certificates(id) ON DELETE CASCADE,fingerprint TEXT NOT NULL,certificate_pem_ciphertext TEXT NOT NULL,private_key_ciphertext TEXT NOT NULL,not_before INTEGER,not_after INTEGER,created_at INTEGER NOT NULL,UNIQUE(certificate_id,fingerprint));").map_err(|_| "创建证书来源与版本存储失败")?;
        transaction.pragma_update(None,"user_version",32).map_err(|_| "更新证书存储版本失败")?;
    }
    if version < 33 {
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS codex_gateway_tunnel(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);").map_err(|_| "创建网关穿透配置失败")?;
        transaction.pragma_update(None, "user_version", 33).map_err(|_| "更新网关穿透版本失败")?;
    }
    if version < 34 {
        transaction.execute_batch(super::repositories::ai::SCHEMA).map_err(|_| "创建AI配置表失败")?;
        transaction.pragma_update(None,"user_version",34).map_err(|_|"更新AI数据库版本失败")?;
    }
    if version < 35 {
        transaction.execute_batch(super::repositories::ai::CAPABILITIES_SCHEMA).map_err(|_|"创建AI能力状态表失败")?;
        transaction.pragma_update(None,"user_version",35).map_err(|_|"更新AI能力数据库版本失败")?;
    }
    if version < 36 {
        if !columns("ai_profiles")?.iter().any(|column| column == "models_json") {
            transaction.execute_batch("ALTER TABLE ai_profiles ADD COLUMN models_json TEXT NOT NULL DEFAULT '[]';").map_err(|_| "创建AI多模型配置失败")?;
        }
        transaction.pragma_update(None, "user_version", 36).map_err(|_| "更新AI多模型版本失败")?;
    }
    if version < 37 {
        transaction.execute_batch(BROWSER_ENVIRONMENTS_V37_SCHEMA).map_err(|_| "保留浏览器环境历史存储失败")?;
        transaction.pragma_update(None, "user_version", 37).map_err(|_| "更新历史数据库版本失败")?;
    }
    if version < 38 {
        transaction.execute_batch(super::repositories::notes::SCHEMA).map_err(|_| "创建备忘录存储失败")?;
        transaction.pragma_update(None, "user_version", 38).map_err(|_| "更新备忘录数据库版本失败")?;
    }
    if version < 39 {
        // Recycle bin: memo_notes gains a soft-delete column. ALTER TABLE has no
        // IF NOT EXISTS, so it is guarded on the current column list.
        if !columns("memo_notes")?.iter().any(|column| column == "deleted_at") {
            transaction.execute_batch(super::repositories::notes::TRASH_SCHEMA).map_err(|_| "创建备忘录回收站字段失败")?;
        }
        transaction.execute_batch(super::repositories::notes::TRASH_INDEX_SCHEMA).map_err(|_| "创建备忘录回收站索引失败")?;
        transaction.pragma_update(None, "user_version", 39).map_err(|_| "更新回收站数据库版本失败")?;
    }
    if version < 40 {
        // Recycle bin for panels, SSH hosts and pipelines. ALTER TABLE has no
        // IF NOT EXISTS, so each column is guarded on the current column list.
        // A table that does not exist yet in this database is created by its
        // own migration with the column already present, so it is skipped here.
        for (table, _, _, _) in super::repositories::trash::RECYCLABLE {
            let existing = columns(table)?;
            if existing.is_empty() { continue; }
            if !existing.iter().any(|column| column == "deleted_at") {
                transaction.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN deleted_at INTEGER")).map_err(|_| "创建回收站字段失败")?;
            }
            transaction.execute_batch(&format!("CREATE INDEX IF NOT EXISTS idx_{table}_trash ON {table}(deleted_at, id)")).map_err(|_| "创建回收站索引失败")?;
        }
        transaction.pragma_update(None, "user_version", 40).map_err(|_| "更新统一回收站数据库版本失败")?;
    }
    if version < 41 {
        // Extends the recycle bin to accounts, certificates, authenticator
        // entries and Codex accounts. Same guarded ALTER as v40.
        for (table, _, _, _) in super::repositories::trash::RECYCLABLE {
            let existing = columns(table)?;
            if existing.is_empty() { continue; }
            if !existing.iter().any(|column| column == "deleted_at") {
                transaction.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN deleted_at INTEGER")).map_err(|_| "创建回收站字段失败")?;
            }
            transaction.execute_batch(&format!("CREATE INDEX IF NOT EXISTS idx_{table}_trash ON {table}(deleted_at)")).map_err(|_| "创建回收站索引失败")?;
        }
        transaction.pragma_update(None, "user_version", 41).map_err(|_| "更新回收站覆盖范围版本失败")?;
    }
    if version < 42 {
        transaction.execute_batch(super::repositories::claude_providers::SCHEMA).map_err(|_| "创建Claude Code供应商存储失败")?;
        transaction.pragma_update(None, "user_version", 42).map_err(|_| "更新Claude供应商数据库版本失败")?;
    }
    if version < 43 {
        transaction.execute_batch(CODEX_SCHEMA).map_err(|_| "创建 Codex 账号存储失败")?;
        ensure_column("codex_accounts", "details_ciphertext", "TEXT")
            .map_err(|_| "创建账号资料存储失败")?;
        transaction.pragma_update(None, "user_version", 43).map_err(|_| "更新账号资料数据库版本失败")?;
    }
    if version < 44 {
        transaction.execute_batch(CODEX_ACCOUNT_EVENTS_SCHEMA).map_err(|_| "创建 Codex 账号日志失败")?;
        transaction.execute(
            "INSERT INTO codex_account_events(account_id,event_type,message,created_at) SELECT id,'history_start','账号日志从此版本启用，此前的导入和凭据变更记录不可用',?1 FROM codex_accounts",
            [chrono::Utc::now().timestamp_millis()],
        ).map_err(|_| "初始化 Codex 账号日志失败")?;
        transaction.pragma_update(None, "user_version", 44).map_err(|_| "更新 Codex 账号日志版本失败")?;
    }
    if version < 45 {
        ensure_column("codex_account_events", "details_json", "TEXT")?;
        transaction.pragma_update(None, "user_version", 45).map_err(|_| "更新 Codex 账号日志详情版本失败")?;
    }
    if version < 46 {
        transaction.execute_batch(CODEX_PROVIDERS_SCHEMA).map_err(|_| "创建 Codex 供应商数据表失败")?;
        transaction.pragma_update(None, "user_version", 46).map_err(|_| "保存 Codex 供应商迁移版本失败")?;
    }
    if version < 47 {
        transaction.execute_batch(CODEX_PROVIDER_BACKUPS_SCHEMA).map_err(|_| "创建 Codex 供应商恢复表失败")?;
        transaction.pragma_update(None, "user_version", 47).map_err(|_| "保存 Codex 供应商恢复版本失败")?;
    }
    if version < 48 {
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS codex_provider_bindings(home TEXT PRIMARY KEY,provider_id TEXT NOT NULL,key_id TEXT NOT NULL,account_id INTEGER NOT NULL,previous_account_id INTEGER,instance_id TEXT);").map_err(|_| "创建供应商绑定表失败")?;
        transaction.pragma_update(None, "user_version", 48).map_err(|_| "保存供应商绑定版本失败")?;
    }
    if version < 49 {
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS codex_provider_accounts(account_id INTEGER PRIMARY KEY,provider_id TEXT NOT NULL,key_id TEXT NOT NULL);").map_err(|_| "创建供应商账号关联表失败")?;
        transaction.pragma_update(None, "user_version", 49).map_err(|_| "保存供应商账号关联版本失败")?;
    }
    if version < 50 {
        ensure_column("codex_model_providers", "settings_json", "TEXT NOT NULL DEFAULT '{}'")?;
        ensure_column("codex_provider_keys", "settings_json", "TEXT NOT NULL DEFAULT '{}'")?;
        transaction.pragma_update(None, "user_version", 50).map_err(|_| "保存供应商模型设置版本失败")?;
    }
    if version < 51 {
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS codex_provider_gateways(home TEXT PRIMARY KEY,port INTEGER NOT NULL,key_ciphertext TEXT NOT NULL,provider_id TEXT NOT NULL,key_id TEXT NOT NULL,models_json TEXT NOT NULL);").map_err(|_| "创建供应商网关设置失败")?;
        transaction.pragma_update(None, "user_version", 51).map_err(|_| "保存供应商网关版本失败")?;
    }
    if version < 52 {
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS codex_provider_oauth(home TEXT PRIMARY KEY,account_id INTEGER NOT NULL UNIQUE,auth_fingerprint TEXT NOT NULL);").map_err(|_| "创建供应商 OAuth 绑定失败")?;
        transaction.pragma_update(None, "user_version", 52).map_err(|_| "保存供应商 OAuth 版本失败")?;
    }
    if version < 53 {
        transaction.execute_batch(CODEX_PROVIDER_AGGREGATES_SCHEMA).map_err(|_| "创建供应商聚合配置失败")?;
        transaction.pragma_update(None, "user_version", 53).map_err(|_| "保存供应商聚合版本失败")?;
    }
    if version < 54 {
        transaction.execute_batch(CODEX_PROVIDER_LOGS_SCHEMA).map_err(|_| "创建供应商请求日志表失败")?;
        transaction.pragma_update(None, "user_version", 54).map_err(|_| "保存供应商请求日志版本失败")?;
    }
    if version < 55 {
        ensure_column("codex_provider_request_logs", "client_request_body", "TEXT NOT NULL DEFAULT ''")?;
        transaction.pragma_update(None, "user_version", 55).map_err(|_| "保存供应商请求日志原始参数版本失败")?;
    }
    if version < 56 {
        // CREATE TABLE IF NOT EXISTS cannot add the recycle-bin label to older vaults.
        transaction.execute_batch(super::repositories::authenticator::SCHEMA)
            .map_err(|_| "创建验证器密码库失败")?;
        ensure_column("authenticator_entries", "name", "TEXT NOT NULL DEFAULT ''")
            .map_err(|_| "升级验证码名称字段失败")?;
        transaction.pragma_update(None, "user_version", 56)
            .map_err(|_| "更新验证器数据库版本失败")?;
    }
    transaction.commit().map_err(|error| format!("提交 SQLite 迁移失败: {error}"))?;

    Ok(())
}

pub fn open_db() -> Result<Connection, String> {
    let _guard = DATABASE_OPEN_LOCK
        .lock()
        .map_err(|_| "SQLite 初始化锁不可用".to_string())?;
    open_db_at(&data_dir()?.join("cloudhub_tools.sqlite3"))
}

fn supported_schema_version(conn: &Connection) -> Result<i64, String> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|_| "读取 SQLite schema 版本失败".to_string())?;
    if version > CURRENT_SCHEMA_VERSION {
        return Err(format!("SQLite schema 版本 {version} 高于当前客户端支持的版本 {CURRENT_SCHEMA_VERSION}；请使用支持该数据库的新版客户端，勿修改数据库版本号"));
    }
    Ok(version)
}

// Read and snapshot existing files before any initialization DDL can change them.
fn open_db_at(path: &std::path::Path) -> Result<Connection, String> {
    if path.exists() {
        let source = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| "无法检查已有数据库；本地数据保持不变".to_string())?;
        source.busy_timeout(std::time::Duration::from_secs(5)).map_err(|_| "配置数据库检查失败")?;
        let version = supported_schema_version(&source)?;
        #[cfg(not(mobile))]
        if version < CURRENT_SCHEMA_VERSION {
            snapshot_before_upgrade(&source, path, version)?;
        }
        #[cfg(mobile)]
        let _ = version;
    }
    let conn = Connection::open(path)
        .map_err(|error| format!("打开 SQLite 失败: {error}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| format!("配置 SQLite 锁等待失败: {error}"))?;
    conn.execute_batch("PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS cloud_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, account_name TEXT NOT NULL, cloud_type TEXT NOT NULL DEFAULT 'aliyun', group_name TEXT, access_key_id TEXT NOT NULL, secret_ciphertext TEXT NOT NULL, region_id TEXT, sort_order INTEGER NOT NULL DEFAULT 0, credential_meta TEXT, enabled INTEGER NOT NULL DEFAULT 1, remark TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
      CREATE TABLE IF NOT EXISTS cloud_assets (account_id INTEGER NOT NULL, resource_type TEXT NOT NULL, asset_key TEXT NOT NULL, region_id TEXT, payload_json TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY(account_id, resource_type, asset_key), FOREIGN KEY(account_id) REFERENCES cloud_accounts(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS ssh_connections (account_id INTEGER NOT NULL, asset_key TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 22, username TEXT NOT NULL, password_ciphertext TEXT, host_key_fingerprint TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(account_id, asset_key), FOREIGN KEY(account_id) REFERENCES cloud_accounts(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS rdp_connections (target_key TEXT PRIMARY KEY, host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 3389, username TEXT NOT NULL, password_ciphertext TEXT, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS managed_hosts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 22, username TEXT NOT NULL, password_ciphertext TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT 'linux', auth_method TEXT NOT NULL DEFAULT 'password', private_key_ciphertext TEXT, key_passphrase_ciphertext TEXT, group_name TEXT, tags TEXT, source_account_id INTEGER, source_asset_key TEXT, host_key_fingerprint TEXT, status TEXT NOT NULL DEFAULT 'unknown', last_latency_ms INTEGER, metrics_json TEXT NOT NULL DEFAULT '{}', last_checked_at INTEGER, last_error TEXT, remark TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
      CREATE TABLE IF NOT EXISTS panel_connections (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, panel_url TEXT NOT NULL UNIQUE, api_key_ciphertext TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, allow_insecure_tls INTEGER NOT NULL DEFAULT 0, group_name TEXT, source_account_id INTEGER, source_asset_key TEXT, status TEXT NOT NULL DEFAULT 'unknown', summary_json TEXT NOT NULL DEFAULT '{}', last_checked_at INTEGER, last_error TEXT, remark TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
      CREATE TABLE IF NOT EXISTS operation_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, action TEXT NOT NULL, result TEXT NOT NULL, message TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS client_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS certificates (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, provider TEXT NOT NULL, primary_domain TEXT NOT NULL, domains_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'issued', order_url TEXT, certificate_url TEXT, certificate_pem_ciphertext TEXT, private_key_ciphertext TEXT, serial_number TEXT, issuer TEXT, not_before INTEGER, not_after INTEGER, dns_zone TEXT NOT NULL, dns_record_ids_json TEXT NOT NULL DEFAULT '[]', last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, FOREIGN KEY(account_id) REFERENCES cloud_accounts(id) ON DELETE CASCADE); CREATE INDEX IF NOT EXISTS idx_certificates_account ON certificates(account_id, updated_at DESC); CREATE INDEX IF NOT EXISTS idx_certificates_expiry ON certificates(not_after);")
      .map_err(|error| format!("初始化 SQLite 表失败: {error}"))?;

    let mut conn = conn;
    migrate_connection(&mut conn)?;
    Ok(conn)
}

#[cfg(not(mobile))]
fn snapshot_before_upgrade(source: &Connection, path: &std::path::Path, version: i64) -> Result<(), String> {
    use std::fs;
    let data = path.parent().ok_or("数据库目录无效")?;
    let root = data.join("schema-backups");
    fs::create_dir_all(&root).map_err(|_| "无法准备升级备份目录；数据库尚未升级")?;
    let name = format!("schema-{version}-to-{CURRENT_SCHEMA_VERSION}-{}-{}", chrono::Utc::now().format("%Y%m%d-%H%M%S"), uuid::Uuid::new_v4());
    let staging = root.join(format!(".incomplete-{name}"));
    fs::create_dir(&staging).map_err(|_| "无法创建升级备份；数据库尚未升级")?;
    let result = (|| -> Result<(), String> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&staging, fs::Permissions::from_mode(0o700)).map_err(|_| "保护升级备份失败")?;
        }
        let snapshot = staging.join("cloudhub_tools.sqlite3");
        source.execute("VACUUM INTO ?1", [snapshot.to_str().ok_or("升级备份路径无效")?])
            .map_err(|_| "创建一致性数据库备份失败；数据库尚未升级")?;
        for filename in [".key", ".authenticator.key"] {
            let key = data.join(filename);
            if key.exists() {
                fs::copy(key, staging.join(filename)).map_err(|_| "备份本地密钥失败；数据库尚未升级")?;
            }
        }
        let metadata = serde_json::json!({ "clientVersion": env!("CARGO_PKG_VERSION"), "schemaVersion": version, "targetSchemaVersion": CURRENT_SCHEMA_VERSION, "development": super::paths::desktop_development() });
        fs::write(staging.join("metadata.json"), metadata.to_string()).map_err(|_| "写入升级备份信息失败")?;
        fs::rename(&staging, root.join(name)).map_err(|_| "完成升级备份失败；数据库尚未升级")?;
        Ok(())
    })();
    if result.is_err() {
        for filename in ["cloudhub_tools.sqlite3", ".key", ".authenticator.key", "metadata.json"] {
            let _ = fs::remove_file(staging.join(filename));
        }
        let _ = fs::remove_dir(&staging);
    }
    result
}

#[cfg(test)]
mod tests {
    #[test]
    fn upgrades_legacy_authenticator_and_allows_import() {
        use crate::core::authenticator::formats::parse_uri;
        use crate::core::repositories::authenticator as repository;

        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE authenticator_entries(id TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, deleted_at INTEGER); PRAGMA user_version=55;").unwrap();
        let key = [8u8; 32];
        let existing = parse_uri("otpauth://totp/Example:existing?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").unwrap();
        let ciphertext = crate::core::authenticator::vault::encrypt_entry(&key, &existing).unwrap();
        conn.execute("INSERT INTO authenticator_entries(id,ciphertext) VALUES(?1,?2)", rusqlite::params![existing.id, ciphertext]).unwrap();

        super::migrate_connection(&mut conn).unwrap();
        let imported = parse_uri("otpauth://totp/MSFT%3Ademo%40example.test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Microsoft&codeDisplay=%7B%22pinned%22%3Afalse%7D").unwrap();
        repository::write(&conn, &key, &imported).unwrap();
        super::migrate_connection(&mut conn).unwrap();
        assert_eq!(repository::load(&conn, &key).unwrap().len(), 2);
        let preserved: String = conn.query_row("SELECT ciphertext FROM authenticator_entries WHERE id=?1", [&existing.id], |row| row.get(0)).unwrap();
        assert_eq!(preserved, ciphertext);
        assert!(repository::load(&conn, &[9u8; 32]).is_err());
    }

    #[test]
    fn upgrades_codex_private_details_and_keeps_ciphertext_scrubbable() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(super::CODEX_SCHEMA).unwrap();
        conn.pragma_update(None, "user_version", 42).unwrap();
        super::migrate_connection(&mut conn).unwrap();
        let columns: Vec<String> = conn.prepare("PRAGMA table_info(codex_accounts)").unwrap().query_map([], |row| row.get(1)).unwrap().collect::<Result<_, _>>().unwrap();
        assert!(columns.contains(&"details_ciphertext".to_string()));
        assert!(!columns.contains(&"password".to_string()));
        conn.execute("INSERT INTO codex_accounts(identity,label,auth_mode,auth_ciphertext,details_ciphertext,updated_at,deleted_at) VALUES('details-fixture','fixture','apikey','cipher-fixture','cipher-details-fixture',1,1)", []).unwrap();
        super::migrate_connection(&mut conn).unwrap();
        crate::core::repositories::trash::scrub_expired(&conn, "codex_accounts", 2).unwrap();
        let details: Option<String> = conn.query_row("SELECT details_ciphertext FROM codex_accounts", [], |row| row.get(0)).unwrap();
        assert!(details.is_none() || details.as_deref() == Some(""));
    }

    #[test]
    fn v43_migration_creates_missing_codex_accounts_and_is_idempotent() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", 42).unwrap();

        super::migrate_connection(&mut conn).unwrap();
        super::migrate_connection(&mut conn).unwrap();

        let columns: Vec<String> = conn.prepare("PRAGMA table_info(codex_accounts)").unwrap()
            .query_map([], |row| row.get(1)).unwrap()
            .collect::<Result<_, _>>().unwrap();
        assert!(columns.contains(&"details_ciphertext".to_string()));
        assert_eq!(conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), CURRENT_SCHEMA_VERSION);
    }
    use super::{migrate_connection, CURRENT_SCHEMA_VERSION};
    use rusqlite::Connection;

    #[test]
    fn retained_v37_migration_upgrades_v36_and_preserves_existing_data() {
        let root = std::env::temp_dir().join(format!("cloudhub-retained-v37-{}",uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("cloudhub_tools.sqlite3");
        let original = super::open_db_at(&path).unwrap();
        original.execute_batch("CREATE TABLE migration_fixture(value TEXT); INSERT INTO migration_fixture VALUES('preserve'); DROP TABLE browser_environments; PRAGMA user_version=36;").unwrap();
        drop(original);
        let upgraded = super::open_db_at(&path).unwrap();
        assert_eq!(super::supported_schema_version(&upgraded).unwrap(),super::CURRENT_SCHEMA_VERSION);
        assert_eq!(upgraded.query_row("SELECT value FROM migration_fixture",[],|r| r.get::<_,String>(0)).unwrap(),"preserve");
        upgraded.execute("INSERT INTO browser_environments(id,config_json,created_at,updated_at) VALUES('fixture','{}',1,1)",[]).unwrap();
        drop(upgraded);
        let reopened = super::open_db_at(&path).unwrap();
        assert_eq!(super::supported_schema_version(&reopened).unwrap(),super::CURRENT_SCHEMA_VERSION);
        assert_eq!(reopened.query_row("SELECT config_json FROM browser_environments WHERE id='fixture'",[],|r| r.get::<_,String>(0)).unwrap(),"{}");
        drop(reopened);
        #[cfg(not(mobile))]
        {
            let backup = std::fs::read_dir(root.join("schema-backups")).unwrap().next().unwrap().unwrap().path();
            let saved = Connection::open(backup.join("cloudhub_tools.sqlite3")).unwrap();
            assert_eq!(super::supported_schema_version(&saved).unwrap(),36);
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn newer_database_is_rejected_before_initialization_writes() {
        let root = std::env::temp_dir().join(format!("cloudhub-future-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("cloudhub_tools.sqlite3");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE future_data(value TEXT); INSERT INTO future_data VALUES('fixture');").unwrap();
        conn.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION + 1).unwrap();
        drop(conn);
        let before = std::fs::read(&path).unwrap();
        assert!(super::open_db_at(&path).unwrap_err().contains("高于当前客户端"));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(!root.join("schema-backups").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(not(mobile))]
    #[test]
    fn upgrade_snapshot_preserves_wal_data_and_matching_keys() {
        let root = std::env::temp_dir().join(format!("cloudhub-snapshot-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("cloudhub_tools.sqlite3");
        let original = super::open_db_at(&path).unwrap();
        original.execute_batch("PRAGMA journal_mode=WAL; ALTER TABLE ai_profiles DROP COLUMN models_json; PRAGMA user_version=35; INSERT INTO ai_profiles(id,name,protocol,base_url,model,key_ciphertext,updated_at) VALUES('fixture','fixture','claude','https://example.test','fixture','fixture-cipher',1);").unwrap();
        std::fs::write(root.join(".key"), [7u8; 32]).unwrap();
        std::fs::write(root.join(".authenticator.key"), [8u8; 32]).unwrap();
        let upgraded = super::open_db_at(&path).unwrap();
        assert_eq!(super::supported_schema_version(&upgraded).unwrap(), CURRENT_SCHEMA_VERSION);
        let backup = std::fs::read_dir(root.join("schema-backups")).unwrap().next().unwrap().unwrap().path();
        let saved = Connection::open(backup.join("cloudhub_tools.sqlite3")).unwrap();
        assert_eq!(super::supported_schema_version(&saved).unwrap(), 35);
        let value: String = saved.query_row("SELECT key_ciphertext FROM ai_profiles WHERE id='fixture'", [], |r| r.get(0)).unwrap();
        assert_eq!(value, "fixture-cipher");
        assert!(saved.prepare("SELECT models_json FROM ai_profiles").is_err());
        assert_eq!(std::fs::read(backup.join(".key")).unwrap(), [7u8; 32]);
        assert_eq!(std::fs::read(backup.join(".authenticator.key")).unwrap(), [8u8; 32]);
        drop(saved);
        drop(upgraded);
        drop(original);
        let current = super::open_db_at(&path).unwrap();
        assert_eq!(std::fs::read_dir(root.join("schema-backups")).unwrap().count(), 1);
        drop(current);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(not(mobile))]
    #[test]
    fn backup_failure_leaves_database_unmodified() {
        let root = std::env::temp_dir().join(format!("cloudhub-backup-failure-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("cloudhub_tools.sqlite3");
        let conn = super::open_db_at(&path).unwrap();
        conn.execute_batch("ALTER TABLE ai_profiles DROP COLUMN models_json; PRAGMA user_version=35;").unwrap();
        drop(conn);
        std::fs::write(root.join("schema-backups"), b"fixture blocking file").unwrap();
        let before = std::fs::read(&path).unwrap();
        assert!(super::open_db_at(&path).unwrap_err().contains("数据库尚未升级"));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn v36_adds_models_without_changing_existing_credentials() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA user_version=33;").unwrap();
        migrate_connection(&mut conn).unwrap();
        conn.execute("INSERT INTO ai_profiles(id,name,protocol,base_url,model,key_ciphertext,updated_at) VALUES('fixture','fixture','claude','https://example.test','fixture','fixture-cipher',1)", []).unwrap();
        conn.execute_batch("ALTER TABLE ai_profiles DROP COLUMN models_json; PRAGMA user_version=35;").unwrap();
        migrate_connection(&mut conn).unwrap();
        migrate_connection(&mut conn).unwrap();
        let result: (String, String, String) = conn.query_row("SELECT model,key_ciphertext,models_json FROM ai_profiles WHERE id='fixture'", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap();
        assert_eq!(result, ("fixture".into(), "fixture-cipher".into(), "[]".into()));
    }
    #[test]
    fn v33_adds_ai_profiles_and_repeated_migration_preserves_ciphertext() {
        let mut conn=rusqlite::Connection::open_in_memory().unwrap();conn.execute_batch("PRAGMA user_version=33;").unwrap();
        migrate_connection(&mut conn).unwrap();
        conn.execute("INSERT INTO ai_profiles(id,name,protocol,base_url,model,key_ciphertext,updated_at) VALUES('fixture','fixture','claude','https://example.test','fixture','fixture-encrypted-key',1)",[]).unwrap();
        migrate_connection(&mut conn).unwrap();
        assert_eq!(conn.pragma_query_value(None,"user_version",|r|r.get::<_,i64>(0)).unwrap(),CURRENT_SCHEMA_VERSION);
        assert_eq!(conn.query_row("SELECT key_ciphertext FROM ai_profiles",[],|r|r.get::<_,String>(0)).unwrap(),"fixture-encrypted-key");
    }
    #[test]
    fn v32_adds_disabled_tunnel_without_changing_gateway_config() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(super::CODEX_SCHEMA).unwrap();
        conn.execute_batch("INSERT INTO codex_gateway_config(id,port,key_ciphertext) VALUES(1,58169,'fixture-encrypted'); PRAGMA user_version=32;").unwrap();
        migrate_connection(&mut conn).unwrap();
        assert_eq!(conn.query_row("SELECT count(*) FROM codex_gateway_tunnel", [], |row| row.get::<_,i64>(0)).unwrap(), 0);
        assert_eq!(crate::core::codex::gateway_config::summary(&conn).unwrap(), Some(58169));
    }
    #[test]
    fn v29_adds_network_scope_without_exposing_existing_service() {
        let mut conn=rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(super::CODEX_SCHEMA).unwrap();
        conn.execute_batch("DROP TABLE codex_gateway_network; INSERT INTO codex_gateway_config(id,port,key_ciphertext,auto_start,account_ids_json) VALUES(1,58169,'test-only-ciphertext',1,'[1]'); PRAGMA user_version=29;").unwrap();
        migrate_connection(&mut conn).unwrap();
        assert!(!crate::core::codex::gateway_config::allow_lan(&conn).unwrap());
        assert_eq!(crate::core::codex::gateway_config::startup(&conn).unwrap(),(true,vec![1]));
    }
    #[test]
    fn esa_deployment_links_survive_idempotent_migration() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE cloud_accounts(id INTEGER PRIMARY KEY); CREATE TABLE certificates(id INTEGER PRIMARY KEY); INSERT INTO cloud_accounts VALUES(7); INSERT INTO certificates VALUES(9); PRAGMA user_version=30;").unwrap();
        migrate_connection(&mut conn).unwrap();
        conn.execute("INSERT INTO esa_certificate_deployments(account_id,site_id,certificate_id,remote_id,updated_at) VALUES(7,123,9,'fixture-remote-id',1)", []).unwrap();
        migrate_connection(&mut conn).unwrap();
        assert_eq!(conn.query_row("SELECT remote_id FROM esa_certificate_deployments", [], |row| row.get::<_, String>(0)).unwrap(), "fixture-remote-id");
        assert_eq!(conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), super::CURRENT_SCHEMA_VERSION);
    }
    #[test]
    fn certificate_sources_preserve_materials_and_references_without_cloud_ownership() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE cloud_accounts(id INTEGER PRIMARY KEY); CREATE TABLE panel_connections(id INTEGER PRIMARY KEY); INSERT INTO cloud_accounts VALUES(7); CREATE TABLE certificates(id INTEGER PRIMARY KEY,account_id INTEGER NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,provider TEXT,primary_domain TEXT,domains_json TEXT,status TEXT,certificate_pem_ciphertext TEXT,private_key_ciphertext TEXT,dns_zone TEXT,created_at INTEGER,updated_at INTEGER); INSERT INTO certificates VALUES(9,7,'letsencrypt','example.test','[\"example.test\"]','issued','fixture-encrypted-cert','fixture-encrypted-key','example.test',1,2); CREATE TABLE certificate_sync_identity(certificate_id INTEGER PRIMARY KEY REFERENCES certificates(id) ON DELETE CASCADE,sync_id TEXT); INSERT INTO certificate_sync_identity VALUES(9,'fixture-sync-id'); CREATE TABLE esa_certificate_deployments(account_id INTEGER REFERENCES cloud_accounts(id),site_id INTEGER,certificate_id INTEGER REFERENCES certificates(id) ON DELETE CASCADE,remote_id TEXT,updated_at INTEGER); INSERT INTO esa_certificate_deployments VALUES(7,123,9,'fixture-remote-id',1); PRAGMA user_version=31;").unwrap();
        migrate_connection(&mut conn).unwrap();
        assert!(conn.pragma_query_value(None,"foreign_keys",|row| row.get::<_,bool>(0)).unwrap());
        assert_eq!(conn.query_row("SELECT private_key_ciphertext FROM certificates WHERE id=9",[],|row| row.get::<_,String>(0)).unwrap(),"fixture-encrypted-key");
        assert_eq!(conn.query_row("SELECT sync_id FROM certificate_sync_identity",[],|row| row.get::<_,String>(0)).unwrap(),"fixture-sync-id");
        assert_eq!(conn.query_row("SELECT remote_id FROM esa_certificate_deployments",[],|row| row.get::<_,String>(0)).unwrap(),"fixture-remote-id");
        conn.execute("INSERT INTO certificates(provider,primary_domain,domains_json,status,created_at,updated_at,source_kind) VALUES('manual','manual.test','[]','issued',1,1,'manual')",[]).unwrap();
        conn.execute("DELETE FROM esa_certificate_deployments",[]).unwrap();
        conn.execute("DELETE FROM cloud_accounts WHERE id=7",[]).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM certificates",[],|row| row.get::<_,i64>(0)).unwrap(),2);
        assert!(conn.query_row("SELECT account_id FROM certificates WHERE id=9",[],|row| row.get::<_,Option<i64>>(0)).unwrap().is_none());
        migrate_connection(&mut conn).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check",[],|row| row.get::<_,i64>(0)).unwrap(),0);
    }
    #[cfg(desktop)]
    #[test]
    fn upgrades_v27_without_enabling_gateway_autostart() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE codex_gateway_config(id INTEGER PRIMARY KEY,port INTEGER NOT NULL,key_ciphertext TEXT NOT NULL); INSERT INTO codex_gateway_config VALUES(1,58169,'test-only-ciphertext'); PRAGMA user_version=27;").unwrap();
        migrate_connection(&mut conn).unwrap();
        assert_eq!(crate::core::codex::gateway_config::startup(&conn).unwrap(), (false, vec![]));
        crate::core::codex::gateway_config::save_startup(&conn, true, &[1, 2]).unwrap();
        migrate_connection(&mut conn).unwrap();
        assert_eq!(crate::core::codex::gateway_config::startup(&conn).unwrap(), (true, vec![1, 2]));
        assert_eq!(crate::core::codex::gateway_config::summary(&conn).unwrap(), Some(58169));
        let cipher: String = conn.query_row("SELECT key_ciphertext FROM codex_gateway_config", [], |row| row.get(0)).unwrap();
        assert_eq!(cipher, "test-only-ciphertext");
    }
    #[cfg(desktop)]
    #[test]
    fn upgrades_v26_with_account_controls_and_preserves_existing_accounts() {
        let mut conn=Connection::open_in_memory().unwrap();
        conn.execute_batch(super::CODEX_SCHEMA).unwrap();
        conn.execute_batch("DROP TABLE codex_account_controls; INSERT INTO codex_accounts(identity,label,auth_mode,auth_ciphertext,updated_at) VALUES('fixture','fixture','chatgpt','fixture',0); PRAGMA user_version=26;").unwrap();
        migrate_connection(&mut conn).unwrap();
        crate::core::codex::account_controls::save_proxy(&conn,1,"http://127.0.0.1:7890").unwrap();
        migrate_connection(&mut conn).unwrap();
        let account=crate::core::repositories::codex_accounts::get(&conn,1).unwrap();
        assert_eq!(account.label,"fixture");
        assert_eq!(account.proxy_url.as_deref(),Some("http://127.0.0.1:7890/"));
        let version:i64=conn.pragma_query_value(None,"user_version",|r|r.get(0)).unwrap();
        assert_eq!(version,CURRENT_SCHEMA_VERSION);
    }

    #[cfg(desktop)]
    #[test]
    fn upgrades_v25_with_gateway_preferences_without_replacing_service_credentials() {
        let mut conn=Connection::open_in_memory().unwrap();
        conn.execute_batch(super::CODEX_SCHEMA).unwrap();
        conn.execute_batch("INSERT INTO codex_gateway_config(id,port,key_ciphertext) VALUES(1,58169,'test-only-ciphertext'); PRAGMA user_version=25;").unwrap();
        migrate_connection(&mut conn).unwrap();
        let settings=crate::core::codex::gateway_controls::GatewaySettings { logging_enabled:true, strategy:crate::core::codex::gateway_controls::RoutingStrategy::Ordered, cooldown_seconds:90 };
        crate::core::codex::gateway_controls::save(&conn,&settings).unwrap();
        migrate_connection(&mut conn).unwrap();
        assert_eq!(crate::core::codex::gateway_controls::load(&conn).unwrap().strategy,settings.strategy);
        assert_eq!(crate::core::codex::gateway_config::summary(&conn).unwrap(),Some(58169));
        let cipher:String=conn.query_row("SELECT key_ciphertext FROM codex_gateway_config",[],|r|r.get(0)).unwrap();
        assert_eq!(cipher,"test-only-ciphertext");
    }

    #[cfg(desktop)]
    #[test]
    fn upgrades_v24_without_gateway_config_and_preserves_saved_config() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(super::CODEX_SCHEMA).unwrap();
        conn.execute_batch("DROP TABLE codex_gateway_config; PRAGMA user_version=24;").unwrap();
        migrate_connection(&mut conn).unwrap();
        assert_eq!(crate::core::codex::gateway_config::summary(&conn).unwrap(), None);
        let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
        conn.execute("INSERT INTO codex_gateway_config(id,port,key_ciphertext) VALUES(1,58169,'test-only-ciphertext')", []).unwrap();
        // Existing installations with the table also upgrade without replacing it.
        conn.pragma_update(None, "user_version", 24).unwrap();
        migrate_connection(&mut conn).unwrap();
        migrate_connection(&mut conn).unwrap();
        let saved: (u16, String) = conn.query_row("SELECT port,key_ciphertext FROM codex_gateway_config WHERE id=1", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert_eq!(saved, (58169, "test-only-ciphertext".into()));
    }

    #[test]
    fn migrates_legacy_schema_and_records_current_version() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE cloud_accounts (id INTEGER PRIMARY KEY, account_name TEXT NOT NULL, cloud_type TEXT NOT NULL, access_key_id TEXT NOT NULL, secret_ciphertext TEXT NOT NULL, enabled INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
          CREATE TABLE cloud_assets (account_id INTEGER NOT NULL, resource_type TEXT NOT NULL, asset_key TEXT NOT NULL, region_id TEXT, payload_json TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY(account_id, resource_type, asset_key));
          CREATE TABLE ssh_connections (account_id INTEGER NOT NULL, asset_key TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, username TEXT NOT NULL, password_ciphertext TEXT, host_key_fingerprint TEXT, updated_at INTEGER NOT NULL);
          CREATE TABLE rdp_connections (target_key TEXT PRIMARY KEY, host TEXT NOT NULL, port INTEGER NOT NULL, username TEXT NOT NULL, password_ciphertext TEXT, updated_at INTEGER NOT NULL);
          CREATE TABLE managed_hosts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, username TEXT NOT NULL, password_ciphertext TEXT NOT NULL, host_key_fingerprint TEXT, status TEXT NOT NULL, last_latency_ms INTEGER, metrics_json TEXT NOT NULL, last_checked_at INTEGER, last_error TEXT, remark TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
          CREATE TABLE panel_connections (id INTEGER PRIMARY KEY, name TEXT NOT NULL, panel_url TEXT NOT NULL UNIQUE, api_key_ciphertext TEXT NOT NULL, group_name TEXT, source_account_id INTEGER, source_asset_key TEXT, status TEXT NOT NULL, summary_json TEXT NOT NULL, last_checked_at INTEGER, last_error TEXT, remark TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
          CREATE TABLE operation_logs (id INTEGER PRIMARY KEY, account_id INTEGER, action TEXT NOT NULL, result TEXT NOT NULL, message TEXT, created_at INTEGER NOT NULL);
          CREATE TABLE client_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);").unwrap();
        let mut conn = conn;
        migrate_connection(&mut conn).unwrap();
        let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
        let cache_table: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='flow_pipeline_cache'", [], |row| row.get(0)).unwrap();
        assert_eq!(cache_table, 1);
        let pending_ack_table: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sync_pending_acknowledgements'", [], |row| row.get(0)).unwrap();
        assert_eq!(pending_ack_table, 1, "schema migration must create durable pending acknowledgement storage");
        let identity_columns: Vec<String> = conn.prepare("PRAGMA table_info(sync_local_device)").unwrap().query_map([], |row| row.get(1)).unwrap().collect::<Result<_, _>>().unwrap();
        assert!(identity_columns.iter().any(|column| column == "public_key"));
        let frp_table: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='frp_clients'", [], |row| row.get(0)).unwrap();
        assert_eq!(frp_table, 1);
        let managed_columns: Vec<String> = conn.prepare("PRAGMA table_info(managed_hosts)").unwrap().query_map([], |row| row.get(1)).unwrap().collect::<Result<_, _>>().unwrap();
        for column in ["platform", "auth_method", "private_key_ciphertext", "key_passphrase_ciphertext", "group_name", "tags", "source_account_id", "source_asset_key"] {
            assert!(managed_columns.iter().any(|value| value == column), "missing migrated column {column}");
        }
        let index_count: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN ('idx_cloud_assets_account_type', 'idx_api_logs_created_at', 'idx_operation_logs_created_at')", [], |row| row.get(0)).unwrap();
        assert_eq!(index_count, 3);
    }

    #[test]
    fn upgrades_frp_server_notes_without_changing_existing_connection() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE cloud_accounts(id INTEGER PRIMARY KEY); CREATE TABLE managed_hosts(id INTEGER PRIMARY KEY); CREATE TABLE panel_connections(id INTEGER PRIMARY KEY); CREATE TABLE frp_local_servers(id INTEGER PRIMARY KEY, name TEXT, token_ciphertext TEXT, admin_port INTEGER); CREATE TABLE frp_local_proxies(id INTEGER PRIMARY KEY, custom_domain TEXT); INSERT INTO frp_local_servers VALUES(1,'fixture','encrypted-fixture',7400); PRAGMA user_version=8;").unwrap();
        migrate_connection(&mut conn).unwrap();
        let row: (String, i64, Option<String>, Option<String>, Option<String>) = conn.query_row("SELECT token_ciphertext,admin_port,panel_url,panel_username,panel_password_ciphertext FROM frp_local_servers WHERE id=1", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).unwrap();
        assert_eq!(row, ("encrypted-fixture".into(),7400,None,None,None));
        conn.execute("UPDATE frp_local_servers SET panel_url='https://example.test/',panel_username='fixture',panel_password_ciphertext='encrypted-fixture' WHERE id=1", []).unwrap();
        migrate_connection(&mut conn).unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM frp_local_servers WHERE panel_password_ciphertext='encrypted-fixture' AND panel_url='https://example.test/'", [], |row| row.get(0)).unwrap();
        assert_eq!(count,1);
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
    fn codex_migration_is_idempotent_and_has_no_sync_triggers() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", 21).unwrap();
        migrate_connection(&mut conn).unwrap();
        conn.execute("INSERT INTO codex_accounts(identity,label,auth_mode,auth_ciphertext,updated_at) VALUES('identity','fixture','chatgpt','encrypted-fixture',1)", []).unwrap();
        migrate_connection(&mut conn).unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM codex_accounts", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 1);
        let triggers: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND tbl_name LIKE 'codex_%'", [], |row| row.get(0)).unwrap();
        assert_eq!(triggers, 0);
        let columns: Vec<String> = conn.prepare("PRAGMA table_info(codex_accounts)").unwrap().query_map([], |row| row.get(1)).unwrap().collect::<Result<_, _>>().unwrap();
        assert!(columns.contains(&"auth_ciphertext".to_string()));
        assert!(!columns.contains(&"access_token".to_string()));
    }

    #[test]
    fn provider_migration_preserves_existing_accounts_and_encrypted_keys() {
        let mut conn=Connection::open_in_memory().unwrap();
        conn.execute_batch(super::CODEX_SCHEMA).unwrap();
        conn.execute_batch("PRAGMA user_version=45; INSERT INTO codex_accounts(identity,label,auth_mode,auth_ciphertext,updated_at) VALUES('existing','existing','apikey','opaque-cipher',1);").unwrap();
        migrate_connection(&mut conn).unwrap();
        conn.execute("INSERT INTO codex_model_providers(id,name,base_url,wire_api,models_json,note,version) VALUES('p','provider','https://example.com/v1','responses','[\"model\"]','',1)",[]).unwrap();
        conn.execute("INSERT INTO codex_provider_keys(id,provider_id,name,ciphertext) VALUES('k','p','primary','opaque-provider-cipher')",[]).unwrap();
        migrate_connection(&mut conn).unwrap();
        assert_eq!(conn.query_row("SELECT auth_ciphertext FROM codex_accounts",[],|r|r.get::<_,String>(0)).unwrap(),"opaque-cipher");
        assert_eq!(conn.query_row("SELECT ciphertext FROM codex_provider_keys",[],|r|r.get::<_,String>(0)).unwrap(),"opaque-provider-cipher");
        assert_eq!(conn.query_row("SELECT settings_json FROM codex_provider_keys",[],|r|r.get::<_,String>(0)).unwrap(),"{}");
        assert_eq!(conn.pragma_query_value(None,"user_version",|r|r.get::<_,i64>(0)).unwrap(),CURRENT_SCHEMA_VERSION);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM codex_provider_gateways",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }

    #[test]
    fn upgrades_codex_event_details_without_rewriting_existing_logs() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(super::CODEX_SCHEMA).unwrap();
        conn.execute("INSERT INTO codex_accounts(identity,label,auth_mode,auth_ciphertext,updated_at) VALUES('log-fixture','fixture','chatgpt','cipher',1)", []).unwrap();
        conn.execute_batch("CREATE TABLE codex_account_events(id INTEGER PRIMARY KEY AUTOINCREMENT,account_id INTEGER NOT NULL,event_type TEXT NOT NULL,message TEXT NOT NULL,created_at INTEGER NOT NULL); INSERT INTO codex_account_events(account_id,event_type,message,created_at) VALUES(1,'refresh','旧日志',10); PRAGMA user_version=44;").unwrap();

        super::migrate_connection(&mut conn).unwrap();

        let event: (String, Option<String>) = conn.query_row("SELECT message,details_json FROM codex_account_events WHERE id=1", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert_eq!(event, ("旧日志".into(), None));
        conn.execute("UPDATE codex_account_events SET details_json=?1 WHERE id=1", [r#"{"attempts":[]}"#]).unwrap();
        assert_eq!(super::supported_schema_version(&conn).unwrap(), super::CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn upgrades_frp_domains_and_plugin_fields_idempotently() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE cloud_accounts(id INTEGER PRIMARY KEY); CREATE TABLE managed_hosts(id INTEGER PRIMARY KEY); CREATE TABLE panel_connections(id INTEGER PRIMARY KEY); CREATE TABLE frp_local_proxies(id INTEGER PRIMARY KEY,custom_domain TEXT); INSERT INTO frp_local_proxies VALUES(1,'legacy.example.test'),(2,NULL); PRAGMA user_version=9;").unwrap();
        migrate_connection(&mut conn).unwrap();
        let values: (String, Option<String>) = conn.query_row("SELECT custom_domains_json,plugin_json FROM frp_local_proxies WHERE id=1", [], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(serde_json::from_str::<Vec<String>>(&values.0).unwrap(), vec!["legacy.example.test"]);
        assert!(values.1.is_none());
        conn.execute("UPDATE frp_local_proxies SET custom_domains_json=?1,plugin_json=?2 WHERE id=1", rusqlite::params!["[\"one.example.test\",\"two.example.test\"]", "{\"type\":\"https2http\"}"]).unwrap();
        migrate_connection(&mut conn).unwrap();
        let domains: String = conn.query_row("SELECT custom_domains_json FROM frp_local_proxies WHERE id=1", [], |row| row.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Vec<String>>(&domains).unwrap().len(),2);
        let empty: String = conn.query_row("SELECT custom_domains_json FROM frp_local_proxies WHERE id=2", [], |row| row.get(0)).unwrap();
        assert_eq!(empty,"[]");
    }

    #[test]
    fn adds_stable_sync_ids_and_device_sync_metadata() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE cloud_accounts (id INTEGER PRIMARY KEY, sync_id TEXT, account_name TEXT, cloud_type TEXT, group_name TEXT, access_key_id TEXT, secret_ciphertext TEXT, credential_meta TEXT, region_id TEXT, sort_order INTEGER, enabled INTEGER, remark TEXT); CREATE TABLE managed_hosts (id INTEGER PRIMARY KEY, sync_id TEXT, name TEXT, host TEXT, port INTEGER, username TEXT, password_ciphertext TEXT, platform TEXT, auth_method TEXT, private_key_ciphertext TEXT, key_passphrase_ciphertext TEXT, group_name TEXT, tags TEXT, source_account_id INTEGER, source_asset_key TEXT, host_key_fingerprint TEXT, remark TEXT, status TEXT, last_latency_ms INTEGER, metrics_json TEXT, last_checked_at INTEGER, last_error TEXT); CREATE TABLE panel_connections (id INTEGER PRIMARY KEY, sync_id TEXT, name TEXT, panel_url TEXT, api_key_ciphertext TEXT, sort_order INTEGER, allow_insecure_tls INTEGER, group_name TEXT, source_account_id INTEGER, source_asset_key TEXT, remark TEXT, status TEXT, summary_json TEXT, last_checked_at INTEGER, last_error TEXT); INSERT INTO cloud_accounts(id,account_name) VALUES(1,'first'); INSERT INTO managed_hosts(id) VALUES(1); INSERT INTO panel_connections(id) VALUES(1); PRAGMA user_version=10;").unwrap();

        conn.execute_batch("CREATE TABLE certificates(id INTEGER PRIMARY KEY);").unwrap();
        migrate_connection(&mut conn).unwrap();
        let old_ids: (String, String, String) = conn.query_row("SELECT (SELECT sync_id FROM cloud_accounts WHERE id=1),(SELECT sync_id FROM managed_hosts WHERE id=1),(SELECT sync_id FROM panel_connections WHERE id=1)", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap();
        assert!(old_ids.0.len() == 36 && old_ids.1.len() == 36 && old_ids.2.len() == 36);

        conn.execute("INSERT INTO cloud_accounts(id,sync_id,account_name) VALUES(2,'11111111-1111-4111-8111-111111111111','second')", []).unwrap();
        conn.execute("INSERT INTO managed_hosts(id,sync_id,name,host) VALUES(2,'22222222-2222-4222-8222-222222222222','host','host.example.test')", []).unwrap();
        conn.execute("INSERT INTO panel_connections(id,sync_id,name,panel_url,api_key_ciphertext) VALUES(2,'33333333-3333-4333-8333-333333333333','panel','https://panel.example.test','ciphertext')", []).unwrap();
        let new_ids: (String, String, String) = conn.query_row("SELECT (SELECT sync_id FROM cloud_accounts WHERE id=2),(SELECT sync_id FROM managed_hosts WHERE id=2),(SELECT sync_id FROM panel_connections WHERE id=2)", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap();
        assert!(new_ids.0.len() == 36 && new_ids.1.len() == 36 && new_ids.2.len() == 36);
        assert_ne!(old_ids.0, new_ids.0);
        assert_eq!(new_ids.0, "11111111-1111-4111-8111-111111111111");
        let initial_outbox: (i64, String) = conn.query_row("SELECT COUNT(*),MAX(version_json) FROM sync_outbox WHERE entity_type='cloud_account' AND entity_sync_id=?1", [&new_ids.0], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        let local_device_id: String = conn.query_row("SELECT device_id FROM sync_local_device WHERE id=1", [], |row| row.get(0)).unwrap();
        assert_eq!(initial_outbox, (1, format!(r#"{{"{local_device_id}":1}}"#)));
        let host_outbox: i64 = conn.query_row("SELECT COUNT(*) FROM sync_outbox WHERE entity_type='managed_host' AND entity_sync_id=?1", [&new_ids.1], |row| row.get(0)).unwrap();
        let panel_outbox: i64 = conn.query_row("SELECT COUNT(*) FROM sync_outbox WHERE entity_type='panel_connection' AND entity_sync_id=?1", [&new_ids.2], |row| row.get(0)).unwrap();
        assert_eq!((host_outbox, panel_outbox), (1, 1));

        conn.execute("UPDATE sync_apply_guard SET applying=1 WHERE id=1", []).unwrap();
        conn.execute("UPDATE cloud_accounts SET account_name='received-from-peer' WHERE id=2", []).unwrap();
        let guarded_outbox: i64 = conn.query_row("SELECT COUNT(*) FROM sync_outbox WHERE entity_type='cloud_account' AND entity_sync_id=?1", [&new_ids.0], |row| row.get(0)).unwrap();
        assert_eq!(guarded_outbox, 1, "remote apply must not echo a local outbox event");
        conn.execute("UPDATE sync_apply_guard SET applying=0 WHERE id=1", []).unwrap();

        conn.execute("UPDATE cloud_accounts SET account_name='changed' WHERE id=2", []).unwrap();
        let update_version: String = conn.query_row("SELECT version_json FROM sync_outbox WHERE entity_type='cloud_account' AND entity_sync_id=?1 ORDER BY sequence DESC LIMIT 1", [&new_ids.0], |row| row.get(0)).unwrap();
        assert!(update_version.ends_with(":2}"));
        conn.execute("DELETE FROM cloud_accounts WHERE id=2", []).unwrap();
        let tombstone_count: i64 = conn.query_row("SELECT COUNT(*) FROM sync_tombstones WHERE entity_type='cloud_account' AND entity_sync_id=?1", [&new_ids.0], |row| row.get(0)).unwrap();
        assert_eq!(tombstone_count, 1);

        conn.execute("UPDATE managed_hosts SET status='online',last_latency_ms=10 WHERE id=2", []).unwrap();
        let host_runtime_outbox: i64 = conn.query_row("SELECT COUNT(*) FROM sync_outbox WHERE entity_type='managed_host' AND entity_sync_id=?1", [&new_ids.1], |row| row.get(0)).unwrap();
        assert_eq!(host_runtime_outbox, 1);
        conn.execute("UPDATE managed_hosts SET host='new.example.test' WHERE id=2", []).unwrap();
        conn.execute("UPDATE panel_connections SET summary_json='{}',status='online' WHERE id=2", []).unwrap();
        let panel_runtime_outbox: i64 = conn.query_row("SELECT COUNT(*) FROM sync_outbox WHERE entity_type='panel_connection' AND entity_sync_id=?1", [&new_ids.2], |row| row.get(0)).unwrap();
        assert_eq!(panel_runtime_outbox, 1);
        conn.execute("UPDATE panel_connections SET api_key_ciphertext='new-ciphertext' WHERE id=2", []).unwrap();
        conn.execute("DELETE FROM managed_hosts WHERE id=2", []).unwrap();
        conn.execute("DELETE FROM panel_connections WHERE id=2", []).unwrap();
        let other_tombstones: i64 = conn.query_row("SELECT COUNT(*) FROM sync_tombstones WHERE entity_sync_id IN (?1,?2)", rusqlite::params![new_ids.1,new_ids.2], |row| row.get(0)).unwrap();
        assert_eq!(other_tombstones, 2);

        migrate_connection(&mut conn).unwrap();
        let stable_id: String = conn.query_row("SELECT sync_id FROM cloud_accounts WHERE id=1", [], |row| row.get(0)).unwrap();
        assert_eq!(stable_id, old_ids.0);
        let table_count: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('sync_devices','sync_entity_versions','sync_tombstones','sync_outbox','sync_device_scope')", [], |row| row.get(0)).unwrap();
        assert_eq!(table_count, 5);
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
