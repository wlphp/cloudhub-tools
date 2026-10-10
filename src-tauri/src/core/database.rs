use rusqlite::{Connection, OptionalExtension};
use std::sync::Mutex;

use super::paths::data_dir;

const CURRENT_SCHEMA_VERSION: i64 = 21;

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
        transaction.pragma_update(None, "user_version", 3).map_err(|error| error.to_string())?;
    }
    if version < 4 {
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS certificates (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, provider TEXT NOT NULL, primary_domain TEXT NOT NULL, domains_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'issued', order_url TEXT, certificate_url TEXT, certificate_pem_ciphertext TEXT, private_key_ciphertext TEXT, serial_number TEXT, issuer TEXT, not_before INTEGER, not_after INTEGER, dns_zone TEXT NOT NULL, dns_record_ids_json TEXT NOT NULL DEFAULT '[]', last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, FOREIGN KEY(account_id) REFERENCES cloud_accounts(id) ON DELETE CASCADE); CREATE INDEX IF NOT EXISTS idx_certificates_account ON certificates(account_id, updated_at DESC); CREATE INDEX IF NOT EXISTS idx_certificates_expiry ON certificates(not_after);")
            .map_err(|error| error.to_string())?;
        transaction.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION).map_err(|error| error.to_string())?;
    }
    if version < 5 {
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS flow_connections (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, edition TEXT NOT NULL, organization_id TEXT, domain TEXT NOT NULL, token_ciphertext TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);")
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
    transaction.commit().map_err(|error| format!("提交 SQLite 迁移失败: {error}"))?;

    Ok(())
}

pub fn open_db() -> Result<Connection, String> {
    let _guard = DATABASE_OPEN_LOCK
        .lock()
        .map_err(|_| "SQLite 初始化锁不可用".to_string())?;
    let conn = Connection::open(data_dir()?.join("cloudhub_tools.sqlite3"))
        .map_err(|error| format!("打开 SQLite 失败: {error}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| format!("配置 SQLite 锁等待失败: {error}"))?;
    conn.execute_batch("PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS cloud_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, account_name TEXT NOT NULL, cloud_type TEXT NOT NULL DEFAULT 'aliyun', group_name TEXT, access_key_id TEXT NOT NULL, secret_ciphertext TEXT NOT NULL, region_id TEXT, sort_order INTEGER NOT NULL DEFAULT 0, credential_meta TEXT, enabled INTEGER NOT NULL DEFAULT 1, remark TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_assets (account_id INTEGER NOT NULL, resource_type TEXT NOT NULL, asset_key TEXT NOT NULL, region_id TEXT, payload_json TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY(account_id, resource_type, asset_key), FOREIGN KEY(account_id) REFERENCES cloud_accounts(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS ssh_connections (account_id INTEGER NOT NULL, asset_key TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 22, username TEXT NOT NULL, password_ciphertext TEXT, host_key_fingerprint TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(account_id, asset_key), FOREIGN KEY(account_id) REFERENCES cloud_accounts(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS rdp_connections (target_key TEXT PRIMARY KEY, host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 3389, username TEXT NOT NULL, password_ciphertext TEXT, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS managed_hosts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 22, username TEXT NOT NULL, password_ciphertext TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT 'linux', auth_method TEXT NOT NULL DEFAULT 'password', private_key_ciphertext TEXT, key_passphrase_ciphertext TEXT, group_name TEXT, tags TEXT, source_account_id INTEGER, source_asset_key TEXT, host_key_fingerprint TEXT, status TEXT NOT NULL DEFAULT 'unknown', last_latency_ms INTEGER, metrics_json TEXT NOT NULL DEFAULT '{}', last_checked_at INTEGER, last_error TEXT, remark TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS panel_connections (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, panel_url TEXT NOT NULL UNIQUE, api_key_ciphertext TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, allow_insecure_tls INTEGER NOT NULL DEFAULT 0, group_name TEXT, source_account_id INTEGER, source_asset_key TEXT, status TEXT NOT NULL DEFAULT 'unknown', summary_json TEXT NOT NULL DEFAULT '{}', last_checked_at INTEGER, last_error TEXT, remark TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS operation_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, action TEXT NOT NULL, result TEXT NOT NULL, message TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS client_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS certificates (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, provider TEXT NOT NULL, primary_domain TEXT NOT NULL, domains_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'issued', order_url TEXT, certificate_url TEXT, certificate_pem_ciphertext TEXT, private_key_ciphertext TEXT, serial_number TEXT, issuer TEXT, not_before INTEGER, not_after INTEGER, dns_zone TEXT NOT NULL, dns_record_ids_json TEXT NOT NULL DEFAULT '[]', last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, FOREIGN KEY(account_id) REFERENCES cloud_accounts(id) ON DELETE CASCADE); CREATE INDEX IF NOT EXISTS idx_certificates_account ON certificates(account_id, updated_at DESC); CREATE INDEX IF NOT EXISTS idx_certificates_expiry ON certificates(not_after);")
      .map_err(|error| format!("初始化 SQLite 表失败: {error}"))?;

    let mut conn = conn;
    migrate_connection(&mut conn)?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::{migrate_connection, CURRENT_SCHEMA_VERSION};
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
