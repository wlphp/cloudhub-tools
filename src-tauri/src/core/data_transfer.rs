//! Shared policy for SQL, local/cloud backups and one-shot device migration.
use rusqlite::{Connection, types::Value};
use crate::core::crypto::{decrypt_secret_with_key, encrypt_secret_with_key};

pub const POLICY_VERSION: u16 = 2;
pub const BUILD_SUFFIX: &str = if cfg!(debug_assertions) { "-dev" } else { "" };
// Parent tables precede children. Unknown tables are never portable by default.
pub const TABLES: &[(&str, &str)] = &[
    ("cloud_accounts", "云账号"), ("ssh_connections", "云主机 SSH"),
    ("managed_hosts", "托管主机"), ("rdp_connections", "RDP 连接"),
    ("panel_connections", "宝塔面板连接"), ("certificates", "HTTPS 证书与私钥"),
    ("certificate_versions", "证书历史版本"), ("certificate_source_links", "宝塔站点证书关联"),
    ("esa_certificate_deployments", "ESA 证书关联"),
    ("flow_connections", "流水线连接"), ("frp_local_settings", "FRP 面板设置"),
    ("frp_local_servers", "FRP 服务端"), ("frp_local_proxies", "FRP 规则"),
    ("frp_clients", "远程 FRP 客户端"), ("frp_local_client", "本地 FRP 客户端"),
    ("claude_providers", "Claude 供应商"),
    ("codex_model_providers", "Codex 模型供应商"), ("codex_provider_keys", "供应商密钥"),
    ("codex_provider_aggregates", "供应商聚合"), ("codex_provider_aggregate_members", "聚合成员"),
    ("ai_profiles", "AI 配置"), ("memo_groups", "备忘录分组"), ("memo_notes", "备忘录"),
    ("browser_environments", "指纹浏览器配置"),
    ("authenticator_entries", "验证器（含种子）"),
    ("transfer_cloud_drive", "云盘连接配置"), ("transfer_asset_metadata", "资产自定义信息"),
    ("client_preferences", "外观与使用偏好"),
];
pub fn allowed(table: &str) -> bool { TABLES.iter().any(|(name, _)| *name == table) }
/// Explicitly excluded persistence. Adding a database table requires a scope decision.
pub const LOCAL_TABLES: &[&str] = &[
    "api_logs","operation_logs","cloud_assets","flow_pipeline_cache","network_speed_history",
    "certificate_snapshots","certificate_sync_identity","flow_sync_identity",
    "authenticator_vault","memo_reminders","ai_capabilities","claude_provider_backups",
    "codex_accounts","codex_profiles","codex_profile_backups","codex_account_controls","codex_account_events",
    "codex_config_history","codex_config_operations","codex_gateway_config","codex_gateway_network",
    "codex_gateway_pool","codex_gateway_preferences","codex_gateway_tunnel",
    "codex_provider_accounts","codex_provider_bindings","codex_provider_config_backups",
    "codex_provider_gateways","codex_provider_oauth","codex_provider_request_logs",
    "sync_apply_guard","sync_device_scope","sync_devices","sync_entity_versions","sync_inbox",
    "sync_local_device","sync_local_versions","sync_outbox","sync_outbox_acknowledgements",
    "sync_pending_acknowledgements","sync_tombstones","lan_devices","lan_scans","mail_accounts",
    "data_transfer_identity","cloudhub_transfer_ids","cloudhub_transfer_scope","cloudhub_transfer_policy",
];
pub fn ident(name: &str) -> String { format!("\"{}\"", name.replace('"', "\"\"")) }
pub fn exists(db: &Connection, table: &str) -> Result<bool, String> {
    db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)", [table], |r| r.get(0)).map_err(|_| "检查迁移数据结构失败".into())
}
pub fn columns(db: &Connection, table: &str) -> Result<Vec<String>, String> {
    let mut stmt = db.prepare(&format!("PRAGMA table_info({})", ident(table))).map_err(|_| "读取迁移字段失败")?;
    let rows = stmt.query_map([], |r| r.get(1)).map_err(|_| "读取迁移字段失败")?;
    rows.collect::<rusqlite::Result<_>>().map_err(|_| "读取迁移字段失败".into())
}
pub fn portable_preference(key: &str) -> bool {
    preference_module(key).is_some()
}
pub fn preference_module(key: &str) -> Option<&'static str> {
    match key {
        "cloud.drive.connections" => Some("transfer_cloud_drive"),
        "cloudhub-tools-favorite-assets" | "cloudhub-tools-favorite-asset-order" |
        "cloudhub-tools-asset-notes" | "cloudhub-tools-asset-order" |
        "cloudhub-tools-asset-display-names" | "cloudhub-tools-managed-host-order" => Some("transfer_asset_metadata"),
        "theme" | "language" | "locale" | "app.theme" | "app.language" |
        "cloudhub-tools-ui-theme" | "cloudhub-tools-ui-language" | "cloudhub-tools-terminal-theme" |
        "cloudhub.application-navigation" | "codex.providers.order" | "cloudhub-terminal-quick-commands" => Some("client_preferences"),
        _ => None,
    }
}
pub fn virtual_table(table: &str) -> bool { matches!(table, "transfer_cloud_drive" | "transfer_asset_metadata") }
pub fn target_table(table: &str) -> &str { if virtual_table(table) { "client_preferences" } else { table } }
/// Transfer-only projections; these tables never become application persistence.
pub fn project_preferences(db: &Connection) -> Result<(), String> {
    for table in ["transfer_cloud_drive", "transfer_asset_metadata"] {
        db.execute_batch(&format!("CREATE TABLE IF NOT EXISTS {table}(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL DEFAULT 0)")).map_err(|_| "创建偏好投影失败")?;
    }
    let mut stmt = db.prepare("SELECT key,value,updated_at FROM client_preferences").map_err(|_| "读取偏好投影失败")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?))).map_err(|_| "读取偏好投影失败")?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| "读取偏好投影失败")?;
    drop(stmt);
    for (key,value,updated) in rows {
        if let Some(table) = preference_module(&key).filter(|table| virtual_table(table)) {
            db.execute(&format!("INSERT OR IGNORE INTO {table}(key,value,updated_at) VALUES(?1,?2,?3)"),rusqlite::params![key,value,updated]).map_err(|_| "写入偏好投影失败")?;
            db.execute("DELETE FROM client_preferences WHERE key=?1",[key]).map_err(|_| "清理偏好投影失败")?;
        }
    }
    Ok(())
}
pub fn secret(table: &str, column: &str) -> bool {
    column.ends_with("_ciphertext") || (matches!(table, "codex_provider_keys" | "authenticator_entries") && column == "ciphertext")
}
pub fn clean_value(table: &str, column: &str, value: Value) -> Value {
    match (table, column) {
        ("managed_hosts" | "panel_connections", "status") => Value::Text("unknown".into()),
        ("managed_hosts", "metrics_json") | ("panel_connections", "summary_json") => Value::Text("{}".into()),
        (_, "last_error" | "last_checked_at" | "last_latency_ms" | "last_opened_at") => Value::Null,
        ("claude_providers", "is_current") => Value::Integer(0),
        (_, "auto_start" | "auto_mount") => Value::Integer(0),
        (_, "host_key_fingerprint" | "trusted_fingerprint") => Value::Null,
        ("certificates", "dns_record_ids_json") => Value::Text("[]".into()),
        ("certificates", "order_url" | "certificate_url") => Value::Null,
        _ => value,
    }
}
// None denotes the portable/plaintext representation.
pub fn convert(table: &str, column: &str, value: Value, from: Option<&[u8]>, to: Option<&[u8]>) -> Result<Value, String> {
    let Value::Text(text) = value else { return Ok(value); };
    let convert_secret = |text: &str| -> Result<String, String> {
        if text.is_empty() { return Ok(String::new()); }
        let plain = zeroize::Zeroizing::new(match from { Some(key) => decrypt_secret_with_key(text, key)?, None => text.to_string() });
        match to { Some(key) => encrypt_secret_with_key(&plain, key), None => Ok(plain.to_string()) }
    };
    if table == "transfer_cloud_drive" && column == "value" {
        let plain = zeroize::Zeroizing::new(match from { Some(key) => decrypt_secret_with_key(&text,key).map_err(|_| "云盘凭据转换失败")?, None => text });
        let mut connections: serde_json::Value = serde_json::from_str(&plain).map_err(|_| "云盘连接格式无效")?;
        for connection in connections.as_array_mut().ok_or("云盘连接格式无效")? {
            let object = connection.as_object_mut().ok_or("云盘连接格式无效")?;
            object.insert("autoMount".into(), false.into());
            object.insert("mountPoint".into(), "".into());
            object.insert("cacheDir".into(), "".into());
        }
        let plain = zeroize::Zeroizing::new(serde_json::to_string(&connections).map_err(|_| "云盘连接格式无效")?);
        return Ok(Value::Text(match to { Some(key) => encrypt_secret_with_key(&plain,key)?, None => plain.to_string() }));
    }
    if secret(table, column) { return convert_secret(&text).map(Value::Text).map_err(|_| "迁移凭据转换失败".into()); }
    if table == "claude_providers" && column == "settings_json" {
        let mut settings: serde_json::Value = serde_json::from_str(&text).map_err(|_| "Claude 供应商格式无效")?;
        if let Some(key) = settings.get_mut("apiKey") {
            if let Some(text) = key.as_str() {
                let input = text.strip_prefix("cloudhub-encrypted:");
                let converted = if from.is_some() && input.is_none() {
                    convert("codex_provider_keys", "ciphertext", Value::Text(text.into()), None, to)?
                } else { Value::Text(convert_secret(input.unwrap_or(text))?) };
                if let Value::Text(value) = converted { *key = serde_json::Value::String(if to.is_some() && !value.is_empty() { format!("cloudhub-encrypted:{value}") } else { value }); }
            }
        }
        return serde_json::to_string(&settings).map(Value::Text).map_err(|_| "Claude 供应商格式无效".into());
    }
    Ok(Value::Text(text))
}
/// Rewrap independently encrypted OTP entries with the package root key.
pub fn export_authenticator(db: &Connection, root_key: &[u8]) -> Result<(), String> {
    use crate::core::{authenticator::vault, repositories::authenticator};
    if !exists(db, "authenticator_entries")? { return Ok(()); }
    let count: i64 = db.query_row("SELECT count(*) FROM authenticator_entries", [], |r| r.get(0)).map_err(|_| "读取验证码数量失败")?;
    if count == 0 { return Ok(()); }
    if authenticator::header(db)?.as_deref() != Some(vault::DEVICE_HEADER) { return Err("请先打开验证器完成旧密码库迁移，再备份或导出".into()); }
    let key = vault::read_device_key(&vault::device_key_path()?)?;
    export_authenticator_with_key(db, root_key, &key)
}

pub(crate) fn export_authenticator_with_key(db: &Connection, root_key: &[u8], key: &[u8;32]) -> Result<(), String> {
    let mut stmt = db.prepare("SELECT id,ciphertext FROM authenticator_entries").map_err(|_| "读取验证码失败")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|_| "读取验证码失败")?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| "读取验证码失败")?;
    for (id, cipher) in rows {
        let entry = crate::core::authenticator::vault::decrypt_entry(key, &id, &cipher)?;
        let plain = zeroize::Zeroizing::new(serde_json::to_string(&entry).map_err(|_| "转换验证码失败")?);
        let cipher = encrypt_secret_with_key(&plain, root_key)?;
        db.execute("UPDATE authenticator_entries SET ciphertext=?2 WHERE id=?1", rusqlite::params![id,cipher]).map_err(|_| "转换验证码失败")?;
    }
    Ok(())
}
pub fn import_authenticator(db: &Connection, root_key: &[u8], device_key: &[u8;32]) -> Result<(), String> {
    let mut stmt = db.prepare("SELECT id,ciphertext FROM authenticator_entries").map_err(|_| "读取验证码失败")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|_| "读取验证码失败")?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| "读取验证码失败")?;
    for (id, cipher) in rows {
        let plain = zeroize::Zeroizing::new(decrypt_secret_with_key(&cipher, root_key)?);
        let mut entry: crate::core::authenticator::Entry = serde_json::from_str(&plain).map_err(|_| "验证码格式无效")?;
        entry.validate()?;
        if entry.id != id { return Err("验证码标识无效".into()); }
        let cipher = crate::core::authenticator::vault::encrypt_entry(device_key, &entry)?;
        db.execute("UPDATE authenticator_entries SET ciphertext=?2 WHERE id=?1", rusqlite::params![id,cipher]).map_err(|_| "保存验证码失败")?;
    }
    Ok(())
}

pub fn reconcile_authenticator(target: &Connection, stage: &Connection, key: &[u8;32], merge: bool) -> Result<(), String> {
    use crate::core::authenticator::vault;
    let read = |db: &Connection| -> Result<Vec<crate::core::authenticator::Entry>, String> {
        let mut stmt = db.prepare("SELECT id,ciphertext FROM authenticator_entries").map_err(|_| "读取验证码失败")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|_| "读取验证码失败")?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| "读取验证码失败")?;
        rows.into_iter().map(|(id,cipher)| vault::decrypt_entry(key,&id,&cipher)).collect()
    };
    let local = read(target)?;
    let incoming = read(stage)?;
    let mut seen: Vec<crate::core::authenticator::Entry> = vec![];
    for mut entry in incoming {
        if seen.iter().any(|old| old.same_seed(&entry)) { return Err("迁移包包含重复验证码种子".into()); }
        seen.push(entry.clone());
        if let Some(old) = local.iter().find(|old| old.same_seed(&entry)) {
            let original_id = entry.id.clone();
            entry.id = old.id.clone();
            if entry.kind == "hotp" { entry.counter = entry.counter.max(old.counter); }
            if merge && entry.kind == "hotp" && entry.counter > old.counter {
                let mut preserved = old.clone(); preserved.counter = entry.counter;
                target.execute("UPDATE authenticator_entries SET ciphertext=?2 WHERE id=?1",rusqlite::params![old.id,vault::encrypt_entry(key,&preserved)?]).map_err(|_| "保存验证码失败")?;
            }
            stage.execute("UPDATE authenticator_entries SET id=?2,ciphertext=?3 WHERE id=?1",rusqlite::params![original_id,entry.id,vault::encrypt_entry(key,&entry)?]).map_err(|_| "验证码标识冲突")?;
        } else if local.iter().any(|old| old.id == entry.id) { return Err("同一验证码标识的种子已变化，已取消导入".into()); }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn otp_merge_reuses_seed_identity_and_never_rewinds_hotp() {
        use crate::core::{authenticator::{formats::parse_uri,vault},repositories::authenticator};
        let target=Connection::open_in_memory().unwrap(); let stage=Connection::open_in_memory().unwrap();
        target.execute_batch(authenticator::SCHEMA).unwrap(); stage.execute_batch(authenticator::SCHEMA).unwrap();
        let mut old=parse_uri("otpauth://hotp/Fixture:demo?secret=JBSWY3DPEHPK3PXP&counter=17").unwrap();
        authenticator::write(&target,&[1;32],&old).unwrap();
        let mut incoming=old.clone(); incoming.id=uuid::Uuid::new_v4().to_string(); incoming.counter=8;
        authenticator::write(&stage,&[1;32],&incoming).unwrap();
        reconcile_authenticator(&target,&stage,&[1;32],false).unwrap();
        let (id,cipher):(String,String)=stage.query_row("SELECT id,ciphertext FROM authenticator_entries",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(id,old.id); assert_eq!(vault::decrypt_entry(&[1;32],&id,&cipher).unwrap().counter,17);
        stage.execute("DELETE FROM authenticator_entries",[]).unwrap();
        incoming.counter=23; authenticator::write(&stage,&[1;32],&incoming).unwrap();
        reconcile_authenticator(&target,&stage,&[1;32],true).unwrap();
        old.counter=23; assert_eq!(authenticator::load(&target,&[1;32]).unwrap()[0].counter,old.counter);
    }
    #[test]
    fn otp_seed_and_trash_recover_on_another_device_key() {
        use crate::core::{authenticator::{formats::parse_uri, vault}, repositories::authenticator};
        let db=Connection::open_in_memory().unwrap(); db.execute_batch(authenticator::SCHEMA).unwrap();
        let entry=parse_uri("otpauth://hotp/Fixture:demo?secret=JBSWY3DPEHPK3PXP&counter=17").unwrap();
        authenticator::write(&db,&[1;32],&entry).unwrap();
        db.execute("UPDATE authenticator_entries SET deleted_at=5",[]).unwrap();
        export_authenticator_with_key(&db,&[2;32],&[1;32]).unwrap();
        let cipher:String=db.query_row("SELECT ciphertext FROM authenticator_entries",[],|r|r.get(0)).unwrap();
        assert!(vault::decrypt_entry(&[1;32],&entry.id,&cipher).is_err());
        assert!(import_authenticator(&db,&[9;32],&[3;32]).is_err());
        import_authenticator(&db,&[2;32],&[3;32]).unwrap();
        let cipher:String=db.query_row("SELECT ciphertext FROM authenticator_entries",[],|r|r.get(0)).unwrap();
        let recovered=vault::decrypt_entry(&[3;32],&entry.id,&cipher).unwrap();
        assert!(entry.same_seed(&recovered)); assert_eq!(recovered.counter,17);
        assert_eq!(db.query_row("SELECT deleted_at FROM authenticator_entries",[],|r|r.get::<_,i64>(0)).unwrap(),5);
    }
}
