use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use uuid::Uuid;
use zeroize::Zeroize;

#[derive(Debug, Clone, Default)]
pub struct SyncSelection {
    pub account_sync_ids: Vec<String>,
    pub managed_host_sync_ids: Vec<String>,
    pub panel_sync_ids: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfigSnapshot {
    pub protocol_version: u16,
    pub accounts: Vec<AccountConfig>,
    pub managed_hosts: Vec<ManagedHostConfig>,
    pub panels: Vec<PanelConfig>,
}

/// Plaintext form exists only inside the native process and must be sealed
/// before a command returns it to the UI or a transport adapter.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncAccountBundle {
    pub protocol_version: u16,
    pub accounts: Vec<SyncAccountRecord>,
    #[serde(default)]
    pub managed_hosts: Vec<SyncManagedHostRecord>,
    #[serde(default)]
    pub panels: Vec<SyncPanelRecord>,
    #[serde(default)]
    pub deletions: Vec<SyncDeletionRecord>,
}

/// A native-only snapshot of scoped outbox changes. The metadata remains
/// paired with the credential-bearing snapshot inside the encrypted envelope.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncDeltaBundle {
    pub protocol_version: u16,
    pub source_device_id: String,
    pub target_device_id: String,
    pub from_sequence: i64,
    pub through_sequence: i64,
    #[serde(default)]
    pub signature: Option<String>,
    pub changes: Vec<SyncDeltaChange>,
    pub snapshot: SyncAccountBundle,
}

impl Zeroize for SyncDeltaBundle {
    fn zeroize(&mut self) {
        self.protocol_version.zeroize(); self.source_device_id.zeroize(); self.target_device_id.zeroize();
        self.from_sequence.zeroize(); self.through_sequence.zeroize(); self.signature.zeroize(); self.changes.zeroize(); self.snapshot.zeroize();
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncDeltaChange {
    pub sequence: i64,
    pub message_id: String,
    pub entity_type: String,
    pub entity_sync_id: String,
    pub operation: String,
    pub version_json: String,
    pub created_at: i64,
}

/// Stable ordered bytes authenticated by the source device key. The signature
/// itself is excluded to avoid a self-referential payload.
pub fn sync_delta_signing_bytes(delta: &SyncDeltaBundle) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&(
        delta.protocol_version, &delta.source_device_id, &delta.target_device_id,
        delta.from_sequence, delta.through_sequence, &delta.changes, &delta.snapshot,
    )).map_err(|_| "无法规范化增量同步批次".to_string())
}

impl Zeroize for SyncDeltaChange {
    fn zeroize(&mut self) {
        self.sequence.zeroize(); self.message_id.zeroize(); self.entity_type.zeroize(); self.entity_sync_id.zeroize();
        self.operation.zeroize(); self.version_json.zeroize(); self.created_at.zeroize();
    }
}

impl Zeroize for SyncAccountBundle {
    fn zeroize(&mut self) {
        self.protocol_version.zeroize();
        self.accounts.zeroize();
        self.managed_hosts.zeroize();
        self.panels.zeroize();
        self.deletions.zeroize();
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncDeletionRecord {
    pub entity_type: String,
    pub sync_id: String,
    pub version_json: String,
    pub deleted_at: i64,
}

impl Zeroize for SyncDeletionRecord {
    fn zeroize(&mut self) {
        self.entity_type.zeroize();
        self.sync_id.zeroize();
        self.version_json.zeroize();
        self.deleted_at.zeroize();
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncAccountRecord {
    pub sync_id: String,
    pub account_name: String,
    pub cloud_type: String,
    pub group_name: Option<String>,
    pub access_key_id: String,
    pub access_key_secret: String,
    /// Some providers keep credential components such as OCI private keys or
    /// cloud client secrets in this JSON field, so it is sealed as a whole.
    pub credential_meta: Option<String>,
    pub region_id: Option<String>,
    pub sort_order: i64,
    pub enabled: bool,
    pub remark: Option<String>,
}

impl Zeroize for SyncAccountRecord {
    fn zeroize(&mut self) {
        self.sync_id.zeroize(); self.account_name.zeroize(); self.cloud_type.zeroize(); self.group_name.zeroize();
        self.access_key_id.zeroize(); self.access_key_secret.zeroize(); self.credential_meta.zeroize(); self.region_id.zeroize();
        self.sort_order.zeroize(); self.enabled.zeroize(); self.remark.zeroize();
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncManagedHostRecord {
    pub sync_id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub platform: String,
    pub auth_method: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub key_passphrase: Option<String>,
    pub group_name: Option<String>,
    pub tags: Option<String>,
    pub source_account_sync_id: Option<String>,
    pub source_asset_key: Option<String>,
    pub remark: Option<String>,
}

impl Zeroize for SyncManagedHostRecord {
    fn zeroize(&mut self) {
        self.sync_id.zeroize(); self.name.zeroize(); self.host.zeroize(); self.port.zeroize(); self.username.zeroize();
        self.platform.zeroize(); self.auth_method.zeroize(); self.password.zeroize(); self.private_key.zeroize();
        self.key_passphrase.zeroize(); self.group_name.zeroize(); self.tags.zeroize(); self.source_account_sync_id.zeroize();
        self.source_asset_key.zeroize(); self.remark.zeroize();
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncPanelRecord {
    pub sync_id: String,
    pub name: String,
    pub panel_url: String,
    pub sort_order: i64,
    pub api_key: String,
    pub allow_insecure_tls: bool,
    pub group_name: Option<String>,
    pub source_account_sync_id: Option<String>,
    pub source_asset_key: Option<String>,
    pub remark: Option<String>,
}

impl Zeroize for SyncPanelRecord {
    fn zeroize(&mut self) {
        self.sync_id.zeroize(); self.name.zeroize(); self.panel_url.zeroize(); self.sort_order.zeroize(); self.api_key.zeroize();
        self.allow_insecure_tls.zeroize(); self.group_name.zeroize(); self.source_account_sync_id.zeroize();
        self.source_asset_key.zeroize(); self.remark.zeroize();
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncBundleConflict {
    pub entity_type: String,
    pub sync_id: String,
    pub name: String,
    pub reason: String,
    pub resolvable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncDeltaConflictResolution {
    pub entity_type: String,
    pub sync_id: String,
    pub choice: String,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct SyncImportCounts {
    pub added: usize,
    pub updated: usize,
    pub deleted: usize,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncDeletionPreview {
    pub entity_type: String,
    pub sync_id: String,
    pub name: String,
    pub will_delete: bool,
}

pub fn preview_bundle_deletions(conn: &Connection, deletions: &[SyncDeletionRecord]) -> Result<Vec<SyncDeletionPreview>, String> {
    let mut output = Vec::with_capacity(deletions.len());
    for deletion in deletions {
        validate_deletion_record(deletion)?;
        let (label, query) = match deletion.entity_type.as_str() {
            "cloud_account" => ("云账号", "SELECT account_name FROM cloud_accounts WHERE sync_id=?1"),
            "managed_host" => ("托管主机", "SELECT name FROM managed_hosts WHERE sync_id=?1"),
            "panel_connection" => ("面板", "SELECT name FROM panel_connections WHERE sync_id=?1"),
            _ => return Err("同步包包含不支持的删除类型".into()),
        };
        let name: Option<String> = conn.query_row(query, [&deletion.sync_id], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
        let will_delete = name.is_some();
        output.push(SyncDeletionPreview {
            entity_type: deletion.entity_type.clone(), sync_id: deletion.sync_id.clone(),
            name: name.unwrap_or_else(|| format!("{label}（目标设备已不存在）")), will_delete,
        });
    }
    Ok(output)
}

fn validate_deletion_record(deletion: &SyncDeletionRecord) -> Result<(), String> {
    if !matches!(deletion.entity_type.as_str(), "cloud_account" | "managed_host" | "panel_connection")
        || Uuid::parse_str(&deletion.sync_id).is_err() || deletion.deleted_at <= 0 || deletion.version_json.len() > 2048 {
        return Err("同步包包含无效的删除记录".into());
    }
    let version: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&deletion.version_json)
        .map_err(|_| "同步包删除版本格式无效".to_string())?;
    if version.is_empty() || version.iter().any(|(device_id, counter)| Uuid::parse_str(device_id).is_err() || !counter.as_u64().is_some_and(|value| value > 0)) {
        return Err("同步包删除版本格式无效".into());
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionRelation { Dominates, Equal, Dominated, Concurrent }

pub fn parse_version_vector(json: &str) -> Result<BTreeMap<String, u64>, String> {
    if json.len() > 2048 { return Err("同步版本向量过大".into()); }
    let parsed: BTreeMap<String, serde_json::Value> = serde_json::from_str(json).map_err(|_| "同步版本向量格式无效".to_string())?;
    let mut vector = BTreeMap::new();
    for (device_id, counter) in parsed {
        let counter = counter.as_u64().filter(|counter| *counter > 0).ok_or("同步版本向量计数无效")?;
        if Uuid::parse_str(&device_id).is_err() { return Err("同步版本向量设备 ID 无效".into()); }
        vector.insert(device_id, counter);
    }
    Ok(vector)
}

pub fn compare_version_vectors(incoming: &BTreeMap<String, u64>, current: &BTreeMap<String, u64>) -> VersionRelation {
    let mut greater = false;
    let mut less = false;
    for device_id in incoming.keys().chain(current.keys()) {
        let incoming_count = incoming.get(device_id).copied().unwrap_or(0);
        let current_count = current.get(device_id).copied().unwrap_or(0);
        greater |= incoming_count > current_count;
        less |= incoming_count < current_count;
    }
    match (greater, less) {
        (true, false) => VersionRelation::Dominates,
        (false, true) => VersionRelation::Dominated,
        (true, true) => VersionRelation::Concurrent,
        (false, false) => VersionRelation::Equal,
    }
}

/// Compares each entity's newest incoming version with the last merged vector
/// and local edits. Concurrent or stale updates are surfaced for user review.
pub fn preview_delta_version_conflicts(conn: &Connection, delta: &SyncDeltaBundle) -> Result<Vec<SyncBundleConflict>, String> {
    if delta.protocol_version != 1 || Uuid::parse_str(&delta.source_device_id).is_err() || Uuid::parse_str(&delta.target_device_id).is_err()
        || delta.changes.is_empty() || delta.changes.len() > 100 {
        return Err("增量同步批次头部无效".into());
    }
    let local_device_id: String = conn.query_row("SELECT device_id FROM sync_local_device WHERE id=1", [], |row| row.get(0)).map_err(|_| "无法读取本机同步身份")?;
    if delta.target_device_id != local_device_id { return Err("增量同步批次不是发给本机的".into()); }
    let trusted: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sync_devices WHERE device_id=?1 AND status='trusted')", [&delta.source_device_id], |row| row.get(0)).map_err(|error| error.to_string())?;
    if !trusted { return Err("增量同步来源设备未获信任".into()); }
    let mut last_sequence = 0;
    let mut seen_messages = HashSet::new();
    let mut newest_by_entity = BTreeMap::new();
    for change in &delta.changes {
        if change.sequence <= last_sequence || Uuid::parse_str(&change.message_id).is_err() || !seen_messages.insert(&change.message_id)
            || Uuid::parse_str(&change.entity_sync_id).is_err() || !matches!(change.entity_type.as_str(), "cloud_account" | "managed_host" | "panel_connection")
            || !matches!(change.operation.as_str(), "upsert" | "delete") || change.created_at <= 0 {
            return Err("增量同步变更记录无效或顺序错误".into());
        }
        parse_version_vector(&change.version_json)?;
        last_sequence = change.sequence;
        newest_by_entity.insert((change.entity_type.as_str(), change.entity_sync_id.as_str()), change);
    }
    if delta.from_sequence != delta.changes.first().map(|change| change.sequence).unwrap_or_default() || delta.through_sequence != last_sequence {
        return Err("增量同步序号范围与变更不匹配".into());
    }
    let mut conflicts = Vec::new();
    for ((entity_type, sync_id), change) in newest_by_entity {
        let incoming = parse_version_vector(&change.version_json)?;
        let stored: Option<String> = conn.query_row(
            "SELECT current_version_json FROM sync_entity_versions WHERE peer_device_id=?1 AND entity_type=?2 AND entity_sync_id=?3",
            params![delta.source_device_id,entity_type,sync_id], |row| row.get(0),
        ).optional().map_err(|error| error.to_string())?;
        let mut current = stored.as_deref().map(parse_version_vector).transpose()?.unwrap_or_default();
        let local_counter: Option<i64> = conn.query_row(
            "SELECT counter FROM sync_local_versions WHERE entity_type=?1 AND entity_sync_id=?2", params![entity_type,sync_id], |row| row.get(0),
        ).optional().map_err(|error| error.to_string())?;
        if let Some(counter) = local_counter {
            if counter <= 0 { return Err("本地同步版本无效".into()); }
            current.entry(local_device_id.clone()).and_modify(|value| *value = (*value).max(counter as u64)).or_insert(counter as u64);
        }
        let relation = compare_version_vectors(&incoming, &current);
        let reason = match relation {
            VersionRelation::Dominates | VersionRelation::Equal => continue,
            VersionRelation::Dominated => "收到的配置版本已过期".to_string(),
            VersionRelation::Concurrent => "两台设备都修改了此配置，需要人工选择".to_string(),
        };
        let name = match entity_type {
            "cloud_account" => delta.snapshot.accounts.iter().find(|item| item.sync_id == sync_id).map(|item| item.account_name.clone()),
            "managed_host" => delta.snapshot.managed_hosts.iter().find(|item| item.sync_id == sync_id).map(|item| item.name.clone()),
            "panel_connection" => delta.snapshot.panels.iter().find(|item| item.sync_id == sync_id).map(|item| item.name.clone()),
            _ => None,
        }.or_else(|| delta.snapshot.deletions.iter().find(|item| item.entity_type == entity_type && item.sync_id == sync_id).map(|_| format!("已删除配置 {sync_id}")))
            .unwrap_or_else(|| format!("配置 {sync_id}"));
        conflicts.push(SyncBundleConflict { entity_type: entity_type.to_string(), sync_id: sync_id.to_string(), name, reason, resolvable: true });
    }
    Ok(conflicts)
}

pub fn apply_sync_delta(conn: &mut Connection, delta: &SyncDeltaBundle, resolutions: &[SyncDeltaConflictResolution], now: i64) -> Result<SyncImportCounts, String> {
    apply_sync_delta_with_encryptor(conn, delta, resolutions, now, crate::core::crypto::encrypt_secret)
}

fn apply_sync_delta_with_encryptor<F>(conn: &mut Connection, delta: &SyncDeltaBundle, resolutions: &[SyncDeltaConflictResolution], now: i64, encrypt: F) -> Result<SyncImportCounts, String>
where F: Fn(&str) -> Result<String, String> {
    let conflicts = preview_delta_version_conflicts(conn, delta)?;
    let mut decisions = BTreeMap::new();
    for resolution in resolutions {
        let key = (resolution.entity_type.as_str(), resolution.sync_id.as_str());
        if !matches!(resolution.choice.as_str(), "incoming" | "local") || decisions.insert(key, resolution.choice.as_str()).is_some() {
            return Err("增量冲突选择包含无效或重复项".into());
        }
    }
    if conflicts.len() != decisions.len() || conflicts.iter().any(|conflict| !decisions.contains_key(&(conflict.entity_type.as_str(), conflict.sync_id.as_str()))) {
        return Err("增量冲突选择与当前版本不匹配，请重新预览".into());
    }
    let mut filtered_snapshot = delta.snapshot.clone();
    let keep_incoming = |kind: &str, sync_id: &str| decisions.get(&(kind, sync_id)).copied() != Some("local");
    filtered_snapshot.accounts.retain(|record| keep_incoming("cloud_account", &record.sync_id));
    filtered_snapshot.managed_hosts.retain(|record| keep_incoming("managed_host", &record.sync_id));
    filtered_snapshot.panels.retain(|record| keep_incoming("panel_connection", &record.sync_id));
    filtered_snapshot.deletions.retain(|record| keep_incoming(&record.entity_type, &record.sync_id));
    let mut latest = BTreeMap::new();
    for change in &delta.changes { latest.insert((change.entity_type.as_str(), change.entity_sync_id.as_str()), change); }
    let mut snapshot_keys = HashSet::new();
    for record in &delta.snapshot.accounts { snapshot_keys.insert(("cloud_account", record.sync_id.as_str(), "upsert")); }
    for record in &delta.snapshot.managed_hosts { snapshot_keys.insert(("managed_host", record.sync_id.as_str(), "upsert")); }
    for record in &delta.snapshot.panels { snapshot_keys.insert(("panel_connection", record.sync_id.as_str(), "upsert")); }
    for record in &delta.snapshot.deletions { snapshot_keys.insert((record.entity_type.as_str(), record.sync_id.as_str(), "delete")); }
    if latest.iter().any(|((kind, id), change)| !snapshot_keys.contains(&(kind, *id, change.operation.as_str())))
        || snapshot_keys.iter().any(|(kind, id, op)| latest.get(&(*kind, *id)).is_none_or(|change| change.operation != *op)) {
        return Err("增量变更与配置快照不一致".into());
    }
    let source = delta.source_device_id.clone();
    let changes = delta.changes.clone();
    let signature = delta.signature.clone().ok_or("增量同步批次缺少设备签名")?;
    let signed_bytes = zeroize::Zeroizing::new(sync_delta_signing_bytes(delta)?);
    let target = delta.target_device_id.clone();
    import_account_bundle_with_encryptor_and_hook(conn, &filtered_snapshot, now, encrypt, true, move |transaction| {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        use rusqlite::OptionalExtension;
        let local_id: String = transaction.query_row("SELECT device_id FROM sync_local_device WHERE id=1", [], |row| row.get(0)).map_err(|_| "无法读取本机同步身份")?;
        if local_id != target { return Err("增量同步批次不是发给本机的".into()); }
        let peer: Option<(Vec<u8>, String)> = transaction.query_row("SELECT public_key,status FROM sync_devices WHERE device_id=?1", [&source], |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(|_| "无法读取增量来源设备授权")?;
        let Some((peer_key, status)) = peer else { return Err("增量同步来源设备未获信任".into()) };
        if status != "trusted" { return Err("增量同步来源设备授权已撤销".into()); }
        let peer_key: [u8; 32] = peer_key.try_into().map_err(|_| "增量同步来源公钥格式无效")?;
        let signature: [u8; 64] = STANDARD.decode(&signature).map_err(|_| "增量同步签名格式无效")?.try_into().map_err(|_| "增量同步签名长度无效")?;
        if !crate::core::sync_identity::verify_sync_delta(&peer_key, &signature, &source, &target, &signed_bytes) {
            return Err("增量同步来源签名验证失败".into());
        }
        let current_conflicts = preview_delta_version_conflicts(transaction, delta)?;
        if current_conflicts.len() != decisions.len() || current_conflicts.iter().any(|conflict| !decisions.contains_key(&(conflict.entity_type.as_str(), conflict.sync_id.as_str()))) {
            return Err("预览后同步版本已变化，请重新预览并处理冲突".into());
        }
        for change in &changes {
            let previous: Option<(i64, String, String, String, String)> = transaction.query_row(
                "SELECT sequence,entity_type,entity_sync_id,operation,version_json FROM sync_inbox WHERE peer_device_id=?1 AND message_id=?2",
                params![source, change.message_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
            ).optional().map_err(|error| error.to_string())?;
            if let Some((sequence, entity_type, entity_sync_id, operation, version_json)) = previous {
                if (sequence, entity_type, entity_sync_id, operation, version_json) != (change.sequence, change.entity_type.clone(), change.entity_sync_id.clone(), change.operation.clone(), change.version_json.clone()) {
                    return Err("增量消息 ID 被重复用于不同内容".into());
                }
            }
            transaction.execute("INSERT OR IGNORE INTO sync_inbox(peer_device_id,message_id,sequence,entity_type,entity_sync_id,operation,version_json,received_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)", params![source,change.message_id,change.sequence,change.entity_type,change.entity_sync_id,change.operation,change.version_json,now]).map_err(|error| error.to_string())?;
        }
        let mut newest = BTreeMap::new();
        for change in &changes { newest.insert((change.entity_type.as_str(),change.entity_sync_id.as_str()),change); }
        for ((entity_type, entity_sync_id), change) in newest {
            let stored: Option<String> = transaction.query_row("SELECT current_version_json FROM sync_entity_versions WHERE peer_device_id=?1 AND entity_type=?2 AND entity_sync_id=?3", params![source,entity_type,entity_sync_id], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
            let mut merged = stored.as_deref().map(parse_version_vector).transpose()?.unwrap_or_default();
            for (device_id, counter) in parse_version_vector(&change.version_json)? {
                merged.entry(device_id).and_modify(|current| *current = (*current).max(counter)).or_insert(counter);
            }
            if decisions.get(&(entity_type, entity_sync_id)).copied() == Some("local") {
                let local_counter: i64 = transaction.query_row("SELECT counter FROM sync_local_versions WHERE entity_type=?1 AND entity_sync_id=?2", params![entity_type,entity_sync_id], |row| row.get(0)).optional().map_err(|error| error.to_string())?.unwrap_or(0);
                let next_counter = local_counter.checked_add(1).filter(|counter| *counter > 0).ok_or("本机同步版本计数溢出")?;
                transaction.execute("INSERT INTO sync_local_versions(entity_type,entity_sync_id,counter) VALUES(?1,?2,?3) ON CONFLICT(entity_type,entity_sync_id) DO UPDATE SET counter=excluded.counter", params![entity_type,entity_sync_id,next_counter]).map_err(|error| error.to_string())?;
                merged.insert(local_id.clone(), next_counter as u64);
                let local_exists_query = match entity_type {
                    "cloud_account" => "SELECT EXISTS(SELECT 1 FROM cloud_accounts WHERE sync_id=?1)",
                    "managed_host" => "SELECT EXISTS(SELECT 1 FROM managed_hosts WHERE sync_id=?1)",
                    "panel_connection" => "SELECT EXISTS(SELECT 1 FROM panel_connections WHERE sync_id=?1)",
                    _ => return Err("不支持的冲突实体类型".into()),
                };
                let operation = if transaction.query_row(local_exists_query, [entity_sync_id], |row| row.get::<_, bool>(0)).map_err(|error| error.to_string())? { "upsert" } else { "delete" };
                let version_json = serde_json::to_string(&merged).map_err(|_| "无法序列化冲突解决版本".to_string())?;
                if operation == "delete" {
                    transaction.execute("INSERT INTO sync_tombstones(entity_type,entity_sync_id,deleted_by_device_id,version_json,deleted_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(entity_type,entity_sync_id) DO UPDATE SET deleted_by_device_id=excluded.deleted_by_device_id,version_json=excluded.version_json,deleted_at=excluded.deleted_at", params![entity_type,entity_sync_id,local_id,version_json,now]).map_err(|error| error.to_string())?;
                }
                transaction.execute("INSERT INTO sync_outbox(message_id,entity_type,entity_sync_id,operation,version_json,created_at) VALUES(?1,?2,?3,?4,?5,?6)", params![Uuid::new_v4().to_string(),entity_type,entity_sync_id,operation,version_json,now]).map_err(|error| error.to_string())?;
            }
            let version_json = serde_json::to_string(&merged).map_err(|_| "无法保存合并后的同步版本".to_string())?;
            transaction.execute("INSERT INTO sync_entity_versions(peer_device_id,entity_type,entity_sync_id,base_version_json,current_version_json,updated_at) VALUES(?1,?2,?3,'{}',?4,?5) ON CONFLICT(peer_device_id,entity_type,entity_sync_id) DO UPDATE SET current_version_json=excluded.current_version_json,updated_at=excluded.updated_at", params![source,entity_type,entity_sync_id,version_json,now]).map_err(|error| error.to_string())?;
        }
        Ok(())
    })
}

/// Reports target-side collisions before the user confirms import. This is a
/// preview only; import_account_bundle repeats every check inside its write
/// transaction to handle changes made after preview.
pub fn find_bundle_conflicts(conn: &Connection, bundle: &SyncAccountBundle) -> Result<Vec<SyncBundleConflict>, String> {
    let mut conflicts = Vec::new();
    for account in &bundle.accounts {
        let collision: Option<String> = conn.query_row(
            "SELECT '相同的云凭据 ID 属于另一条配置' FROM cloud_accounts WHERE access_key_id=?1 AND sync_id<>?2 LIMIT 1",
            params![account.access_key_id, account.sync_id], |row| row.get(0),
        ).optional().map_err(|error| error.to_string())?;
        if let Some(reason) = collision {
            conflicts.push(SyncBundleConflict { entity_type: "cloudAccount".into(), sync_id: account.sync_id.clone(), name: account.account_name.clone(), reason, resolvable: false });
        }
    }
    for host in &bundle.managed_hosts {
        let collision: Option<String> = conn.query_row(
            "SELECT '相同的主机地址、端口和用户名属于另一条配置' FROM managed_hosts WHERE lower(host)=lower(?1) AND port=?2 AND username=?3 AND sync_id<>?4 LIMIT 1",
            params![host.host.trim(), host.port, host.username.trim(), host.sync_id], |row| row.get(0),
        ).optional().map_err(|error| error.to_string())?;
        if let Some(reason) = collision {
            conflicts.push(SyncBundleConflict { entity_type: "managedHost".into(), sync_id: host.sync_id.clone(), name: host.name.clone(), reason, resolvable: false });
        }
    }
    for panel in &bundle.panels {
        let collision: Option<String> = conn.query_row(
            "SELECT '相同的面板地址属于另一条配置' FROM panel_connections WHERE lower(panel_url)=lower(?1) AND sync_id<>?2 LIMIT 1",
            params![panel.panel_url.trim().trim_end_matches('/'), panel.sync_id], |row| row.get(0),
        ).optional().map_err(|error| error.to_string())?;
        if let Some(reason) = collision {
            conflicts.push(SyncBundleConflict { entity_type: "panel".into(), sync_id: panel.sync_id.clone(), name: panel.name.clone(), reason, resolvable: false });
        }
    }
    Ok(conflicts)
}

pub fn build_account_bundle(conn: &mut Connection, account_sync_ids: &[String], managed_host_sync_ids: &[String], panel_sync_ids: &[String], include_deletions: bool) -> Result<SyncAccountBundle, String> {
    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    let bundle = build_account_bundle_from(&transaction, account_sync_ids, managed_host_sync_ids, panel_sync_ids, include_deletions)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(bundle)
}

fn build_account_bundle_from(conn: &Connection, account_sync_ids: &[String], managed_host_sync_ids: &[String], panel_sync_ids: &[String], include_deletions: bool) -> Result<SyncAccountBundle, String> {
    validate_selection(account_sync_ids, "云账号")?;
    validate_selection(managed_host_sync_ids, "托管主机")?;
    validate_selection(panel_sync_ids, "面板")?;
    if account_sync_ids.len() + managed_host_sync_ids.len() + panel_sync_ids.len() > 100 { return Err("同步选择总数不能超过 100 条".into()); }
    let accounts = if account_sync_ids.is_empty() { Vec::new() } else {
        let sql = format!("SELECT sync_id,account_name,cloud_type,group_name,access_key_id,secret_ciphertext,credential_meta,region_id,sort_order,enabled,remark FROM cloud_accounts WHERE sync_id IN ({}) ORDER BY sync_id", placeholders(account_sync_ids.len()));
        let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = statement.query_map(params_from_iter(account_sync_ids.iter()), |row| Ok(SyncAccountRecord {
            sync_id: row.get(0)?, account_name: row.get(1)?, cloud_type: row.get(2)?, group_name: row.get(3)?, access_key_id: row.get(4)?,
            access_key_secret: row.get(5)?, credential_meta: row.get(6)?, region_id: row.get(7)?, sort_order: row.get(8)?,
            enabled: row.get::<_, i64>(9)? == 1, remark: row.get(10)?,
        })).map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?
    };
    if accounts.len() != account_sync_ids.len() { return Err("所选云账号有记录已不存在".into()); }
    let managed_hosts = if managed_host_sync_ids.is_empty() { Vec::new() } else {
        let sql = format!("SELECT h.sync_id,h.name,h.host,h.port,h.username,h.platform,h.auth_method,h.password_ciphertext,h.private_key_ciphertext,h.key_passphrase_ciphertext,h.group_name,h.tags,a.sync_id,h.source_asset_key,h.remark FROM managed_hosts h LEFT JOIN cloud_accounts a ON a.id=h.source_account_id WHERE h.sync_id IN ({}) ORDER BY h.sync_id", placeholders(managed_host_sync_ids.len()));
        let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = statement.query_map(params_from_iter(managed_host_sync_ids.iter()), |row| Ok(SyncManagedHostRecord {
            sync_id: row.get(0)?, name: row.get(1)?, host: row.get(2)?, port: row.get(3)?, username: row.get(4)?,
            platform: row.get(5)?, auth_method: row.get(6)?, password: row.get(7)?, private_key: row.get(8)?, key_passphrase: row.get(9)?,
            group_name: row.get(10)?, tags: row.get(11)?, source_account_sync_id: row.get(12)?, source_asset_key: row.get(13)?, remark: row.get(14)?,
        })).map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?
    };
    if managed_hosts.len() != managed_host_sync_ids.len() { return Err("所选托管主机有记录已不存在".into()); }
    let panels = if panel_sync_ids.is_empty() { Vec::new() } else {
        let sql = format!("SELECT p.sync_id,p.name,p.panel_url,p.sort_order,p.api_key_ciphertext,p.allow_insecure_tls,p.group_name,a.sync_id,p.source_asset_key,p.remark FROM panel_connections p LEFT JOIN cloud_accounts a ON a.id=p.source_account_id WHERE p.sync_id IN ({}) ORDER BY p.sync_id", placeholders(panel_sync_ids.len()));
        let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = statement.query_map(params_from_iter(panel_sync_ids.iter()), |row| Ok(SyncPanelRecord {
            sync_id: row.get(0)?, name: row.get(1)?, panel_url: row.get(2)?, sort_order: row.get(3)?, api_key: row.get(4)?,
            allow_insecure_tls: row.get::<_, i64>(5)? == 1, group_name: row.get(6)?, source_account_sync_id: row.get(7)?,
            source_asset_key: row.get(8)?, remark: row.get(9)?,
        })).map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?
    };
    if panels.len() != panel_sync_ids.len() { return Err("所选面板有记录已不存在".into()); }
    let deletions = if include_deletions {
        let remaining = 100usize.saturating_sub(accounts.len() + managed_hosts.len() + panels.len());
        let mut statement = conn.prepare("SELECT entity_type,entity_sync_id,version_json,deleted_at FROM sync_tombstones WHERE entity_type IN ('cloud_account','managed_host','panel_connection') ORDER BY deleted_at,entity_type,entity_sync_id LIMIT ?1")
            .map_err(|error| error.to_string())?;
        let rows = statement.query_map([remaining as i64 + 1], |row| Ok(SyncDeletionRecord {
            entity_type: row.get(0)?, sync_id: row.get(1)?, version_json: row.get(2)?, deleted_at: row.get(3)?,
        })).map_err(|error| error.to_string())?;
        let records = rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        if records.len() > remaining { return Err("待同步删除记录与所选配置总数超过 100 条，请减少本次选择".into()); }
        for record in &records { validate_deletion_record(record)?; }
        records
    } else { Vec::new() };
    if accounts.is_empty() && managed_hosts.is_empty() && panels.is_empty() && deletions.is_empty() {
        return Err("请至少选择一个配置，或勾选并包含源设备的删除记录".into());
    }
    Ok(SyncAccountBundle { protocol_version: 1, accounts, managed_hosts, panels, deletions })
}

pub fn managed_host_sync_ids_by_local_ids(conn: &mut Connection, host_ids: &[i64]) -> Result<Vec<String>, String> {
    if host_ids.is_empty() { return Ok(Vec::new()); }
    if host_ids.len() > 100 { return Err("请选择不超过 100 台托管主机".into()); }
    let mut unique = HashSet::with_capacity(host_ids.len());
    if host_ids.iter().any(|id| *id <= 0 || !unique.insert(id)) { return Err("托管主机选择包含无效或重复项".into()); }
    let sql = format!("SELECT id,sync_id FROM managed_hosts WHERE id IN ({})", placeholders(host_ids.len()));
    let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let pairs = statement.query_map(params_from_iter(host_ids.iter()), |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    if pairs.len() != host_ids.len() { return Err("所选托管主机有记录已不存在".into()); }
    let by_id = pairs.into_iter().collect::<std::collections::HashMap<_, _>>();
    host_ids.iter().map(|id| by_id.get(id).cloned().ok_or_else(|| "所选托管主机有记录已不存在".to_string())).collect()
}

pub fn panel_sync_ids_by_local_ids(conn: &Connection, panel_ids: &[i64]) -> Result<Vec<String>, String> {
    if panel_ids.is_empty() { return Ok(Vec::new()); }
    if panel_ids.len() > 100 { return Err("请选择不超过 100 个面板".into()); }
    let mut unique = HashSet::with_capacity(panel_ids.len());
    if panel_ids.iter().any(|id| *id <= 0 || !unique.insert(id)) { return Err("面板选择包含无效或重复项".into()); }
    let sql = format!("SELECT id,sync_id FROM panel_connections WHERE id IN ({})", placeholders(panel_ids.len()));
    let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let pairs = statement.query_map(params_from_iter(panel_ids.iter()), |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    if pairs.len() != panel_ids.len() { return Err("所选面板有记录已不存在".into()); }
    let by_id = pairs.into_iter().collect::<std::collections::HashMap<_, _>>();
    panel_ids.iter().map(|id| by_id.get(id).cloned().ok_or_else(|| "所选面板有记录已不存在".to_string())).collect()
}

pub fn account_sync_ids_by_local_ids(conn: &mut Connection, account_ids: &[i64]) -> Result<Vec<String>, String> {
    if account_ids.is_empty() || account_ids.len() > 100 { return Err("请选择 1 到 100 个云账号".into()); }
    let mut unique = HashSet::with_capacity(account_ids.len());
    if account_ids.iter().any(|id| *id <= 0 || !unique.insert(*id)) { return Err("云账号选择包含无效或重复项".into()); }
    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    let sql = format!("SELECT id,sync_id FROM cloud_accounts WHERE id IN ({})", placeholders(account_ids.len()));
    let mut statement = transaction.prepare(&sql).map_err(|error| error.to_string())?;
    let pairs = statement.query_map(params_from_iter(account_ids.iter()), |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    if pairs.len() != account_ids.len() { return Err("所选云账号有记录已不存在".into()); }
    let by_id = pairs.into_iter().collect::<std::collections::HashMap<_, _>>();
    let sync_ids = account_ids.iter().map(|id| by_id.get(id).cloned().ok_or_else(|| "所选云账号有记录已不存在".to_string())).collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(sync_ids)
}

pub fn import_account_bundle(conn: &mut Connection, bundle: &SyncAccountBundle, now: i64) -> Result<SyncImportCounts, String> {
    import_account_bundle_with_encryptor(conn, bundle, now, crate::core::crypto::encrypt_secret)
}

fn import_account_bundle_with_encryptor<F>(conn: &mut Connection, bundle: &SyncAccountBundle, now: i64, encrypt: F) -> Result<SyncImportCounts, String>
where F: Fn(&str) -> Result<String, String> {
    import_account_bundle_with_encryptor_and_hook(conn, bundle, now, encrypt, false, |_| Ok(()))
}

fn import_account_bundle_with_encryptor_and_hook<F, H>(conn: &mut Connection, bundle: &SyncAccountBundle, now: i64, encrypt: F, allow_empty: bool, finalize: H) -> Result<SyncImportCounts, String>
where F: Fn(&str) -> Result<String, String>, H: FnOnce(&rusqlite::Transaction<'_>) -> Result<(), String> {
    let total = bundle.accounts.len() + bundle.managed_hosts.len() + bundle.panels.len() + bundle.deletions.len();
    if bundle.protocol_version != 1 || (!allow_empty && total == 0) || total > 100 {
        return Err("同步包版本或记录数量无效".into());
    }
    let mut entity_keys = HashSet::new();
    for account in &bundle.accounts { entity_keys.insert(("cloud_account", account.sync_id.as_str())); }
    for host in &bundle.managed_hosts { entity_keys.insert(("managed_host", host.sync_id.as_str())); }
    for panel in &bundle.panels { entity_keys.insert(("panel_connection", panel.sync_id.as_str())); }
    let mut deleted_keys = HashSet::with_capacity(bundle.deletions.len());
    for deletion in &bundle.deletions {
        validate_deletion_record(deletion)?;
        let key = (deletion.entity_type.as_str(), deletion.sync_id.as_str());
        if entity_keys.contains(&key) || !deleted_keys.insert(key) { return Err("同步包包含重复或相互冲突的配置与删除记录".into()); }
    }
    let mut sync_ids = HashSet::with_capacity(bundle.accounts.len());
    let mut access_keys = HashSet::with_capacity(bundle.accounts.len());
    for account in &bundle.accounts {
        if Uuid::parse_str(&account.sync_id).is_err() || !sync_ids.insert(&account.sync_id) {
            return Err("同步账号包包含无效或重复的账号 ID".into());
        }
        if account.account_name.trim().is_empty() || account.account_name.len() > 512 || account.cloud_type.trim().is_empty()
            || account.access_key_id.trim().is_empty() || account.access_key_id.len() > 2048
            || account.access_key_secret.trim().is_empty() || account.access_key_secret.len() > 1024 * 1024 {
            return Err("同步账号包包含字段无效或缺失的账号".into());
        }
        if !access_keys.insert(&account.access_key_id) { return Err("同步账号包包含重复的云凭据 ID".into()); }
        if let Some(meta) = &account.credential_meta {
            let parsed: serde_json::Value = serde_json::from_str(meta).map_err(|_| "同步账号凭据格式无效".to_string())?;
            if !parsed.is_object() || meta.len() > 1024 * 1024 { return Err("同步账号凭据格式或大小无效".into()); }
        }
    }

    let mut host_sync_ids = HashSet::with_capacity(bundle.managed_hosts.len());
    let mut host_endpoints = HashSet::with_capacity(bundle.managed_hosts.len());
    for host in &bundle.managed_hosts {
        if Uuid::parse_str(&host.sync_id).is_err() || !host_sync_ids.insert(&host.sync_id) {
            return Err("同步包包含无效或重复的托管主机 ID".into());
        }
        if host.name.trim().is_empty() || host.name.len() > 512 || host.host.trim().is_empty() || host.host.len() > 253
            || host.port == 0 || host.username.trim().is_empty() || host.username.len() > 128
            || !matches!(host.platform.as_str(), "linux" | "windows") || !matches!(host.auth_method.as_str(), "password" | "private_key") {
            return Err("同步包包含字段无效或缺失的托管主机".into());
        }
        if host.auth_method == "password" && host.password.as_deref().is_none_or(|value| value.is_empty() || value.len() > 8192) {
            return Err("同步包中的托管主机缺少有效密码".into());
        }
        if host.auth_method == "private_key" && host.private_key.as_deref().is_none_or(|value| value.trim().is_empty() || value.len() > 32 * 1024) {
            return Err("同步包中的托管主机缺少有效私钥".into());
        }
        if host.key_passphrase.as_ref().is_some_and(|value| value.len() > 8192) { return Err("同步包中的 SSH 私钥口令过长".into()); }
        let endpoint = (host.host.trim().to_ascii_lowercase(), host.port, host.username.trim().to_string());
        if !host_endpoints.insert(endpoint) { return Err("同步包包含重复的托管主机地址".into()); }
    }

    let mut panel_sync_ids = HashSet::with_capacity(bundle.panels.len());
    let mut panel_urls = HashSet::with_capacity(bundle.panels.len());
    for panel in &bundle.panels {
        if Uuid::parse_str(&panel.sync_id).is_err() || !panel_sync_ids.insert(&panel.sync_id) {
            return Err("同步包包含无效或重复的面板 ID".into());
        }
        if panel.name.trim().is_empty() || panel.name.len() > 512 || panel.panel_url.trim().len() > 2048 || !valid_panel_root_url(&panel.panel_url)
            || panel.api_key.trim().is_empty() || panel.api_key.len() > 8192 {
            return Err("同步包包含字段无效或缺失的面板配置".into());
        }
        if !panel_urls.insert(panel.panel_url.trim().trim_end_matches('/').to_ascii_lowercase()) {
            return Err("同步包包含重复的面板地址".into());
        }
    }
    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    transaction.execute_batch("CREATE TABLE IF NOT EXISTS sync_apply_guard (id INTEGER PRIMARY KEY CHECK(id=1), applying INTEGER NOT NULL DEFAULT 0 CHECK(applying IN (0,1))); INSERT OR IGNORE INTO sync_apply_guard(id,applying) VALUES(1,0); UPDATE sync_apply_guard SET applying=1 WHERE id=1;")
        .map_err(|error| format!("开启同步导入保护失败: {error}"))?;
    for account in &bundle.accounts {
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM cloud_accounts WHERE access_key_id=?1 AND sync_id<>?2)",
            params![account.access_key_id, account.sync_id], |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        if exists { return Err("目标设备已有同一账号或凭据 ID；为避免覆盖，请先在手机上处理冲突".into()); }
    }
    for host in &bundle.managed_hosts {
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM managed_hosts WHERE lower(host)=lower(?1) AND port=?2 AND username=?3 AND sync_id<>?4)",
            params![host.host.trim(), host.port, host.username.trim(), host.sync_id], |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        if exists { return Err("目标设备已有相同托管主机；为避免覆盖，请先在手机上处理冲突".into()); }
    }
    for panel in &bundle.panels {
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM panel_connections WHERE lower(panel_url)=lower(?1) AND sync_id<>?2)",
            params![panel.panel_url.trim().trim_end_matches('/'), panel.sync_id], |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        if exists { return Err("目标设备已有相同面板 ID 或地址；为避免覆盖，请先在手机上处理冲突".into()); }
    }
    let mut counts = SyncImportCounts::default();
    for account in &bundle.accounts {
        let exists: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM cloud_accounts WHERE sync_id=?1)", [&account.sync_id], |row| row.get(0)).map_err(|error| error.to_string())?;
        if exists { counts.updated += 1; } else { counts.added += 1; }
        let secret_ciphertext = encrypt(&account.access_key_secret)?;
        transaction.execute(
            "INSERT INTO cloud_accounts(sync_id,account_name,cloud_type,group_name,access_key_id,secret_ciphertext,credential_meta,region_id,sort_order,enabled,remark,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12) ON CONFLICT(sync_id) DO UPDATE SET account_name=excluded.account_name,cloud_type=excluded.cloud_type,group_name=excluded.group_name,access_key_id=excluded.access_key_id,secret_ciphertext=excluded.secret_ciphertext,credential_meta=excluded.credential_meta,region_id=excluded.region_id,sort_order=excluded.sort_order,enabled=excluded.enabled,remark=excluded.remark,updated_at=excluded.updated_at",
            params![account.sync_id, account.account_name.trim(), account.cloud_type, account.group_name, account.access_key_id.trim(), secret_ciphertext, account.credential_meta, account.region_id, account.sort_order, account.enabled as i64, account.remark, now],
        ).map_err(|error| format!("导入同步账号失败: {error}"))?;
    }
    for host in &bundle.managed_hosts {
        let exists: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM managed_hosts WHERE sync_id=?1)", [&host.sync_id], |row| row.get(0)).map_err(|error| error.to_string())?;
        if exists { counts.updated += 1; } else { counts.added += 1; }
        let source_account_id = match &host.source_account_sync_id {
            Some(sync_id) => transaction.query_row("SELECT id FROM cloud_accounts WHERE sync_id=?1", [sync_id], |row| row.get::<_, i64>(0))
                .optional().map_err(|error| error.to_string())?,
            None => None,
        };
        let password_ciphertext = host.password.as_deref().map(&encrypt).transpose()?.unwrap_or_default();
        let private_key_ciphertext = host.private_key.as_deref().map(&encrypt).transpose()?;
        let key_passphrase_ciphertext = host.key_passphrase.as_deref().filter(|value| !value.is_empty()).map(&encrypt).transpose()?;
        transaction.execute(
            "INSERT INTO managed_hosts(sync_id,name,host,port,username,password_ciphertext,platform,auth_method,private_key_ciphertext,key_passphrase_ciphertext,group_name,tags,source_account_id,source_asset_key,host_key_fingerprint,status,last_latency_ms,metrics_json,last_checked_at,last_error,remark,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,NULL,'unknown',NULL,'{}',NULL,NULL,?15,?16,?16) ON CONFLICT(sync_id) DO UPDATE SET name=excluded.name,host=excluded.host,port=excluded.port,username=excluded.username,password_ciphertext=excluded.password_ciphertext,platform=excluded.platform,auth_method=excluded.auth_method,private_key_ciphertext=excluded.private_key_ciphertext,key_passphrase_ciphertext=excluded.key_passphrase_ciphertext,group_name=excluded.group_name,tags=excluded.tags,source_account_id=excluded.source_account_id,source_asset_key=excluded.source_asset_key,host_key_fingerprint=CASE WHEN lower(managed_hosts.host)=lower(excluded.host) AND managed_hosts.port=excluded.port AND managed_hosts.username=excluded.username THEN managed_hosts.host_key_fingerprint ELSE NULL END,status='unknown',last_latency_ms=NULL,metrics_json='{}',last_checked_at=NULL,last_error=NULL,remark=excluded.remark,updated_at=excluded.updated_at",
            params![host.sync_id, host.name.trim(), host.host.trim(), host.port, host.username.trim(), password_ciphertext, host.platform, host.auth_method, private_key_ciphertext, key_passphrase_ciphertext, host.group_name, host.tags, source_account_id, source_account_id.and(host.source_asset_key.as_deref()), host.remark, now],
        ).map_err(|error| format!("导入同步主机失败: {error}"))?;
    }
    for panel in &bundle.panels {
        let exists: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM panel_connections WHERE sync_id=?1)", [&panel.sync_id], |row| row.get(0)).map_err(|error| error.to_string())?;
        if exists { counts.updated += 1; } else { counts.added += 1; }
        let source_account_id = match &panel.source_account_sync_id {
            Some(sync_id) => transaction.query_row("SELECT id FROM cloud_accounts WHERE sync_id=?1", [sync_id], |row| row.get::<_, i64>(0))
                .optional().map_err(|error| error.to_string())?,
            None => None,
        };
        let ciphertext = encrypt(&panel.api_key)?;
        transaction.execute(
            "INSERT INTO panel_connections(sync_id,name,panel_url,api_key_ciphertext,sort_order,allow_insecure_tls,group_name,source_account_id,source_asset_key,status,summary_json,remark,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'unknown','{}',?10,?11,?11) ON CONFLICT(sync_id) DO UPDATE SET name=excluded.name,panel_url=excluded.panel_url,api_key_ciphertext=excluded.api_key_ciphertext,sort_order=excluded.sort_order,allow_insecure_tls=excluded.allow_insecure_tls,group_name=excluded.group_name,source_account_id=excluded.source_account_id,source_asset_key=excluded.source_asset_key,status='unknown',summary_json='{}',last_checked_at=NULL,last_error=NULL,remark=excluded.remark,updated_at=excluded.updated_at",
            params![panel.sync_id, panel.name.trim(), panel.panel_url.trim().trim_end_matches('/'), ciphertext, panel.sort_order.max(0), panel.allow_insecure_tls as i64, panel.group_name, source_account_id, source_account_id.and(panel.source_asset_key.as_deref()), panel.remark, now],
        ).map_err(|error| format!("导入面板配置失败: {error}"))?;
    }
    for (entity_type, ids) in [
        ("cloud_account", bundle.accounts.iter().map(|record| record.sync_id.as_str()).collect::<Vec<_>>()),
        ("managed_host", bundle.managed_hosts.iter().map(|record| record.sync_id.as_str()).collect::<Vec<_>>()),
        ("panel_connection", bundle.panels.iter().map(|record| record.sync_id.as_str()).collect::<Vec<_>>()),
    ] {
        for sync_id in ids {
            transaction.execute("DELETE FROM sync_tombstones WHERE entity_type=?1 AND entity_sync_id=?2", params![entity_type, sync_id]).map_err(|error| error.to_string())?;
        }
    }
    for deletion in &bundle.deletions {
        match deletion.entity_type.as_str() {
            "cloud_account" => {
                let account_id: Option<i64> = transaction.query_row("SELECT id FROM cloud_accounts WHERE sync_id=?1", [&deletion.sync_id], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
                if let Some(id) = account_id {
                    transaction.execute("UPDATE managed_hosts SET source_account_id=NULL,source_asset_key=NULL,updated_at=?1 WHERE source_account_id=?2", params![now, id]).map_err(|error| error.to_string())?;
                    transaction.execute("UPDATE panel_connections SET source_account_id=NULL,source_asset_key=NULL,updated_at=?1 WHERE source_account_id=?2", params![now, id]).map_err(|error| error.to_string())?;
                    counts.deleted += transaction.execute("DELETE FROM cloud_accounts WHERE id=?1", [id]).map_err(|error| error.to_string())?;
                }
            }
            "managed_host" => counts.deleted += transaction.execute("DELETE FROM managed_hosts WHERE sync_id=?1", [&deletion.sync_id]).map_err(|error| error.to_string())?,
            "panel_connection" => counts.deleted += transaction.execute("DELETE FROM panel_connections WHERE sync_id=?1", [&deletion.sync_id]).map_err(|error| error.to_string())?,
            _ => return Err("同步包包含不支持的删除类型".into()),
        }
    }
    finalize(&transaction)?;
    transaction.execute("UPDATE sync_apply_guard SET applying=0 WHERE id=1", []).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(counts)
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountConfig {
    pub sync_id: String,
    pub account_name: String,
    pub cloud_type: String,
    pub group_name: Option<String>,
    pub region_id: Option<String>,
    pub sort_order: i64,
    pub enabled: bool,
    pub remark: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedHostConfig {
    pub sync_id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub platform: String,
    pub auth_method: String,
    pub group_name: Option<String>,
    pub tags: Option<String>,
    pub source_account_sync_id: Option<String>,
    pub source_asset_key: Option<String>,
    pub host_key_fingerprint: Option<String>,
    pub remark: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PanelConfig {
    pub sync_id: String,
    pub name: String,
    pub panel_url: String,
    pub sort_order: i64,
    pub allow_insecure_tls: bool,
    pub group_name: Option<String>,
    pub source_account_sync_id: Option<String>,
    pub source_asset_key: Option<String>,
    pub remark: Option<String>,
}

fn validate_selection(ids: &[String], kind: &str) -> Result<(), String> {
    if ids.len() > 100 { return Err(format!("{kind}同步选择超过 100 条限制")); }
    let mut seen = HashSet::with_capacity(ids.len());
    for id in ids {
        if Uuid::parse_str(id).is_err() { return Err(format!("{kind}同步 ID 格式无效")); }
        if !seen.insert(id) { return Err(format!("{kind}同步选择包含重复项")); }
    }
    Ok(())
}

fn placeholders(count: usize) -> String { std::iter::repeat("?").take(count).collect::<Vec<_>>().join(",") }

fn valid_panel_root_url(value: &str) -> bool {
    let Some((scheme, authority)) = value.trim().trim_end_matches('/').split_once("://") else { return false; };
    matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https")
        && !authority.is_empty()
        && !authority.contains('/')
        && !authority.contains('?')
        && !authority.contains('#')
        && !authority.contains('@')
        && !authority.chars().any(char::is_whitespace)
}

/// Builds only user-shareable configuration metadata. Credential columns,
/// private keys, API keys, and cached runtime state are intentionally excluded.
/// Account references are translated from local integer IDs to stable sync IDs
/// while all rows are read in one SQLite snapshot.
pub fn build_config_snapshot(conn: &mut Connection, selection: &SyncSelection) -> Result<SyncConfigSnapshot, String> {
    validate_selection(&selection.account_sync_ids, "云账号")?;
    validate_selection(&selection.managed_host_sync_ids, "托管主机")?;
    validate_selection(&selection.panel_sync_ids, "面板")?;
    if selection.account_sync_ids.is_empty() && selection.managed_host_sync_ids.is_empty() && selection.panel_sync_ids.is_empty() {
        return Err("请至少选择一类配置进行同步".into());
    }

    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    let mut accounts = Vec::new();
    if !selection.account_sync_ids.is_empty() {
        let sql = format!("SELECT sync_id,account_name,cloud_type,group_name,region_id,sort_order,enabled,remark FROM cloud_accounts WHERE sync_id IN ({}) ORDER BY sync_id", placeholders(selection.account_sync_ids.len()));
        let mut statement = transaction.prepare(&sql).map_err(|error| error.to_string())?;
        accounts = statement.query_map(params_from_iter(selection.account_sync_ids.iter()), |row| Ok(AccountConfig {
            sync_id: row.get(0)?, account_name: row.get(1)?, cloud_type: row.get(2)?, group_name: row.get(3)?, region_id: row.get(4)?,
            sort_order: row.get(5)?, enabled: row.get::<_, i64>(6)? == 1, remark: row.get(7)?,
        })).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        if accounts.len() != selection.account_sync_ids.len() { return Err("所选云账号有记录已不存在".into()); }
    }

    let mut managed_hosts = Vec::new();
    if !selection.managed_host_sync_ids.is_empty() {
        let sql = format!("SELECT h.sync_id,h.name,h.host,h.port,h.username,h.platform,h.auth_method,h.group_name,h.tags,a.sync_id,h.source_account_id,h.source_asset_key,h.host_key_fingerprint,h.remark FROM managed_hosts h LEFT JOIN cloud_accounts a ON a.id=h.source_account_id WHERE h.sync_id IN ({}) ORDER BY h.sync_id", placeholders(selection.managed_host_sync_ids.len()));
        let mut statement = transaction.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = statement.query_map(params_from_iter(selection.managed_host_sync_ids.iter()), |row| Ok((ManagedHostConfig {
            sync_id: row.get(0)?, name: row.get(1)?, host: row.get(2)?, port: row.get(3)?, username: row.get(4)?, platform: row.get(5)?,
            auth_method: row.get(6)?, group_name: row.get(7)?, tags: row.get(8)?, source_account_sync_id: row.get(9)?,
            source_asset_key: row.get(11)?, host_key_fingerprint: row.get(12)?, remark: row.get(13)?,
        }, row.get::<_, Option<i64>>(10)?))).map_err(|error| error.to_string())?;
        for row in rows {
            let (config, local_account_id) = row.map_err(|error| error.to_string())?;
            if local_account_id.is_some() && config.source_account_sync_id.is_none() { return Err("托管主机关联的云账号不存在，无法安全转换跨设备引用".into()); }
            managed_hosts.push(config);
        }
        if managed_hosts.len() != selection.managed_host_sync_ids.len() { return Err("所选托管主机有记录已不存在".into()); }
    }

    let mut panels = Vec::new();
    if !selection.panel_sync_ids.is_empty() {
        let sql = format!("SELECT p.sync_id,p.name,p.panel_url,p.sort_order,p.allow_insecure_tls,p.group_name,a.sync_id,p.source_account_id,p.source_asset_key,p.remark FROM panel_connections p LEFT JOIN cloud_accounts a ON a.id=p.source_account_id WHERE p.sync_id IN ({}) ORDER BY p.sync_id", placeholders(selection.panel_sync_ids.len()));
        let mut statement = transaction.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = statement.query_map(params_from_iter(selection.panel_sync_ids.iter()), |row| Ok((PanelConfig {
            sync_id: row.get(0)?, name: row.get(1)?, panel_url: row.get(2)?, sort_order: row.get(3)?, allow_insecure_tls: row.get::<_, i64>(4)? == 1,
            group_name: row.get(5)?, source_account_sync_id: row.get(6)?, source_asset_key: row.get(8)?, remark: row.get(9)?,
        }, row.get::<_, Option<i64>>(7)?))).map_err(|error| error.to_string())?;
        for row in rows {
            let (config, local_account_id) = row.map_err(|error| error.to_string())?;
            if local_account_id.is_some() && config.source_account_sync_id.is_none() { return Err("面板关联的云账号不存在，无法安全转换跨设备引用".into()); }
            panels.push(config);
        }
        if panels.len() != selection.panel_sync_ids.len() { return Err("所选面板有记录已不存在".into()); }
    }

    transaction.commit().map_err(|error| error.to_string())?;
    Ok(SyncConfigSnapshot { protocol_version: 1, accounts, managed_hosts, panels })
}

#[derive(Debug, PartialEq, Eq)]
pub struct OutboxChange {
    pub sequence: i64,
    pub message_id: String,
    pub entity_type: String,
    pub entity_sync_id: String,
    pub operation: String,
    pub version_json: String,
    pub created_at: i64,
}

/// Reads only event metadata. Callers must independently enforce the selected
/// share scope before loading an entity snapshot or decrypting any credential.
pub fn list_pending(conn: &Connection, peer_device_id: &str, after_sequence: i64, limit: usize) -> Result<Vec<OutboxChange>, String> {
    if after_sequence < 0 { return Err("同步游标无效".into()); }
    if !(1..=100).contains(&limit) { return Err("同步批次大小必须在 1 到 100 之间".into()); }
    let trusted: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sync_devices WHERE device_id=?1 AND status='trusted')", [peer_device_id], |row| row.get(0)).map_err(|error| error.to_string())?;
    if !trusted { return Err("目标设备未获同步授权".into()); }
    let mut statement = conn.prepare("SELECT o.sequence,o.message_id,o.entity_type,o.entity_sync_id,o.operation,o.version_json,o.created_at FROM sync_outbox o WHERE o.sequence>?2 AND EXISTS(SELECT 1 FROM sync_device_scope s WHERE s.peer_device_id=?1 AND s.entity_type=o.entity_type AND s.entity_sync_id=o.entity_sync_id) AND NOT EXISTS(SELECT 1 FROM sync_outbox_acknowledgements a WHERE a.message_id=o.message_id AND a.peer_device_id=?1) ORDER BY o.sequence LIMIT ?3").map_err(|error| error.to_string())?;
    let rows = statement.query_map(params![peer_device_id, after_sequence, limit as i64], |row| Ok(OutboxChange {
        sequence: row.get(0)?, message_id: row.get(1)?, entity_type: row.get(2)?, entity_sync_id: row.get(3)?,
        operation: row.get(4)?, version_json: row.get(5)?, created_at: row.get(6)?,
    })).map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

/// Builds a device-scoped delta snapshot. The caller must decrypt local
/// credential columns and seal the complete result before crossing Tauri's
/// command boundary.
pub fn build_pending_delta(conn: &mut Connection, peer_device_id: &str, after_sequence: i64, limit: usize) -> Result<SyncDeltaBundle, String> {
    if Uuid::parse_str(peer_device_id).is_err() { return Err("目标设备 ID 格式无效".into()); }
    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    let source_device_id: String = transaction.query_row("SELECT device_id FROM sync_local_device WHERE id=1", [], |row| row.get(0)).map_err(|_| "无法读取本机同步身份")?;
    let events = list_pending(&transaction, peer_device_id, after_sequence, limit)?;
    if events.is_empty() { return Err("当前没有待同步变更".into()); }
    let mut account_ids = Vec::new();
    let mut host_ids = Vec::new();
    let mut panel_ids = Vec::new();
    let mut deletions = Vec::new();
    let mut latest_by_entity = BTreeMap::new();
    for event in &events { latest_by_entity.insert((event.entity_type.as_str(), event.entity_sync_id.as_str()), event); }
    for event in latest_by_entity.values() {
        match (event.entity_type.as_str(), event.operation.as_str()) {
            ("cloud_account", "upsert") => account_ids.push(event.entity_sync_id.clone()),
            ("managed_host", "upsert") => host_ids.push(event.entity_sync_id.clone()),
            ("panel_connection", "upsert") => panel_ids.push(event.entity_sync_id.clone()),
            ("cloud_account" | "managed_host" | "panel_connection", "delete") => deletions.push(SyncDeletionRecord {
                entity_type: event.entity_type.clone(), sync_id: event.entity_sync_id.clone(), version_json: event.version_json.clone(), deleted_at: event.created_at,
            }),
            _ => return Err("待同步队列包含不支持的变更".into()),
        }
    }
    let mut snapshot = build_account_bundle_from(&transaction, &account_ids, &host_ids, &panel_ids, false)?;
    snapshot.deletions = deletions;
    let from_sequence = events.first().map(|event| event.sequence).unwrap_or(after_sequence);
    let through_sequence = events.last().map(|event| event.sequence).unwrap_or(after_sequence);
    let changes = events.into_iter().map(|event| SyncDeltaChange {
        sequence: event.sequence, message_id: event.message_id, entity_type: event.entity_type,
        entity_sync_id: event.entity_sync_id, operation: event.operation,
        version_json: event.version_json, created_at: event.created_at,
    }).collect();
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(SyncDeltaBundle { protocol_version: 1, source_device_id, target_device_id: peer_device_id.to_string(), from_sequence, through_sequence, signature: None, changes, snapshot })
}

/// Mark messages as delivered only after the transport has verified an
/// authenticated acknowledgement from the authorized receiving device.
pub fn acknowledge(conn: &mut Connection, peer_device_id: &str, message_ids: &[String], acknowledged_at: i64) -> Result<usize, String> {
    if message_ids.is_empty() || message_ids.len() > 100 { return Err("同步确认批次大小无效".into()); }
    for message_id in message_ids {
        if Uuid::parse_str(message_id).is_err() { return Err("同步消息 ID 格式无效".into()); }
    }
    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    let trusted: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM sync_devices WHERE device_id=?1 AND status='trusted')", [peer_device_id], |row| row.get(0)).map_err(|error| error.to_string())?;
    if !trusted { return Err("目标设备未获同步授权".into()); }
    let mut updated = 0;
    for message_id in message_ids {
        let in_scope: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM sync_outbox o JOIN sync_device_scope s ON s.entity_type=o.entity_type AND s.entity_sync_id=o.entity_sync_id WHERE o.message_id=?1 AND s.peer_device_id=?2)", params![message_id,peer_device_id], |row| row.get(0)).map_err(|error| error.to_string())?;
        if !in_scope { return Err("同步消息不存在或不属于该设备的共享范围".into()); }
        updated += transaction.execute("INSERT OR IGNORE INTO sync_outbox_acknowledgements(message_id,peer_device_id,acknowledged_at) VALUES(?1,?2,?3)", params![message_id,peer_device_id,acknowledged_at]).map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::{account_sync_ids_by_local_ids, acknowledge, build_account_bundle, build_config_snapshot, compare_version_vectors, import_account_bundle, list_pending, managed_host_sync_ids_by_local_ids, panel_sync_ids_by_local_ids, parse_version_vector, preview_delta_version_conflicts, OutboxChange, SyncAccountBundle, SyncDeltaBundle, SyncDeltaChange, SyncManagedHostRecord, SyncAccountRecord, SyncPanelRecord, SyncSelection, VersionRelation};
    use rusqlite::Connection;
    use uuid::Uuid;

    #[test]
    fn version_vector_comparison_identifies_all_relations_and_rejects_malformed_vectors() {
        let local = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let remote = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        let current = parse_version_vector(&format!(r#"{{"{local}":2}}"#)).unwrap();
        assert_eq!(compare_version_vectors(&parse_version_vector(&format!(r#"{{"{local}":3}}"#)).unwrap(), &current), VersionRelation::Dominates);
        assert_eq!(compare_version_vectors(&current, &current), VersionRelation::Equal);
        assert_eq!(compare_version_vectors(&parse_version_vector(&format!(r#"{{"{local}":1}}"#)).unwrap(), &current), VersionRelation::Dominated);
        let concurrent = parse_version_vector(&format!(r#"{{"{local}":1,"{remote}":1}}"#)).unwrap();
        assert_eq!(compare_version_vectors(&concurrent, &current), VersionRelation::Concurrent);
        assert!(parse_version_vector(r#"{"not-a-device-id":1}"#).is_err());
        assert!(parse_version_vector(&format!(r#"{{"{local}":0}}"#)).is_err());
        assert!(parse_version_vector("[]").is_err());
    }

    #[test]
    fn signed_delta_apply_commits_config_inbox_and_version_idempotently() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let local = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let remote = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        let entity = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        let message_id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
        let seed = [21u8; 32];
        let mut conn = config_fixture();
        conn.execute_batch("CREATE TABLE sync_local_device(id INTEGER PRIMARY KEY,device_id TEXT); CREATE TABLE sync_devices(device_id TEXT PRIMARY KEY,status TEXT,public_key BLOB); CREATE TABLE sync_local_versions(entity_type TEXT,entity_sync_id TEXT,counter INTEGER,PRIMARY KEY(entity_type,entity_sync_id)); CREATE TABLE sync_entity_versions(peer_device_id TEXT,entity_type TEXT,entity_sync_id TEXT,base_version_json TEXT,current_version_json TEXT,updated_at INTEGER,PRIMARY KEY(peer_device_id,entity_type,entity_sync_id)); CREATE TABLE sync_inbox(peer_device_id TEXT,message_id TEXT,sequence INTEGER,entity_type TEXT,entity_sync_id TEXT,operation TEXT,version_json TEXT,received_at INTEGER,PRIMARY KEY(peer_device_id,message_id)); CREATE TABLE sync_outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT UNIQUE,entity_type TEXT,entity_sync_id TEXT,operation TEXT,version_json TEXT,created_at INTEGER); CREATE TABLE sync_apply_guard(id INTEGER PRIMARY KEY,applying INTEGER); INSERT INTO sync_apply_guard VALUES(1,0);").unwrap();
        conn.execute("INSERT INTO sync_local_device VALUES(1,?1)", [local]).unwrap();
        conn.execute("INSERT INTO sync_devices VALUES(?1,'trusted',?2)", rusqlite::params![remote, crate::core::sync_identity::public_key(&seed).to_vec()]).unwrap();
        let mut delta = SyncDeltaBundle {
            protocol_version: 1, source_device_id: remote.into(), target_device_id: local.into(), from_sequence: 7, through_sequence: 7, signature: None,
            changes: vec![SyncDeltaChange { sequence: 7, message_id: message_id.into(), entity_type: "cloud_account".into(), entity_sync_id: entity.into(), operation: "upsert".into(), version_json: format!(r#"{{"{remote}":1}}"#), created_at: 100 }],
            snapshot: SyncAccountBundle { protocol_version: 1, accounts: vec![SyncAccountRecord { sync_id: entity.into(), account_name: "mobile test".into(), cloud_type: "aliyun".into(), group_name: None, access_key_id: "unique-mobile-test".into(), access_key_secret: "test-secret-value".into(), credential_meta: None, region_id: None, sort_order: 0, enabled: true, remark: None }], managed_hosts: vec![], panels: vec![], deletions: vec![] },
        };
        let bytes = super::sync_delta_signing_bytes(&delta).unwrap();
        // A source signature binds source -> target.
        delta.signature = Some(STANDARD.encode(crate::core::sync_identity::sign_sync_delta(&seed, remote, local, &bytes).unwrap()));
        let counts = super::apply_sync_delta_with_encryptor(&mut conn, &delta, &[], 200, |value| Ok(format!("cipher:{value}"))).unwrap();
        assert_eq!((counts.added, counts.updated, counts.deleted), (1, 0, 0));
        let applied: i64 = conn.query_row("SELECT COUNT(*) FROM sync_inbox WHERE peer_device_id=?1 AND message_id=?2", rusqlite::params![remote,message_id], |row| row.get(0)).unwrap();
        assert_eq!(applied, 1);
        let version: String = conn.query_row("SELECT current_version_json FROM sync_entity_versions WHERE peer_device_id=?1 AND entity_type='cloud_account' AND entity_sync_id=?2", rusqlite::params![remote,entity], |row| row.get(0)).unwrap();
        assert_eq!(parse_version_vector(&version).unwrap().get(remote), Some(&1));
        assert_eq!(conn.query_row::<i64,_,_>("SELECT COUNT(*) FROM cloud_accounts WHERE sync_id=?1", [entity], |row| row.get(0)).unwrap(), 1);
        super::apply_sync_delta_with_encryptor(&mut conn, &delta, &[], 201, |value| Ok(format!("cipher:{value}"))).unwrap();
        assert_eq!(conn.query_row::<i64,_,_>("SELECT COUNT(*) FROM sync_inbox", [], |row| row.get(0)).unwrap(), 1);
        delta.snapshot.accounts[0].account_name = "tampered name".into();
        assert!(super::apply_sync_delta_with_encryptor(&mut conn, &delta, &[], 202, |value| Ok(format!("cipher:{value}"))).unwrap_err().contains("签名验证"));
        let persisted_name: String = conn.query_row("SELECT account_name FROM cloud_accounts WHERE sync_id=?1", [entity], |row| row.get(0)).unwrap();
        assert_eq!(persisted_name, "mobile test");
    }

    #[test]
    fn signed_delta_local_conflict_choice_keeps_local_entity_but_commits_receipt_and_remote_version() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let local = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let remote = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        let entity = "11111111-1111-4111-8111-111111111111";
        let message_id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
        let seed = [22u8; 32];
        let mut conn = config_fixture();
        conn.execute_batch("CREATE TABLE sync_local_device(id INTEGER PRIMARY KEY,device_id TEXT); CREATE TABLE sync_devices(device_id TEXT PRIMARY KEY,status TEXT,public_key BLOB); CREATE TABLE sync_local_versions(entity_type TEXT,entity_sync_id TEXT,counter INTEGER,PRIMARY KEY(entity_type,entity_sync_id)); CREATE TABLE sync_entity_versions(peer_device_id TEXT,entity_type TEXT,entity_sync_id TEXT,base_version_json TEXT,current_version_json TEXT,updated_at INTEGER,PRIMARY KEY(peer_device_id,entity_type,entity_sync_id)); CREATE TABLE sync_inbox(peer_device_id TEXT,message_id TEXT,sequence INTEGER,entity_type TEXT,entity_sync_id TEXT,operation TEXT,version_json TEXT,received_at INTEGER,PRIMARY KEY(peer_device_id,message_id)); CREATE TABLE sync_outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT UNIQUE,entity_type TEXT,entity_sync_id TEXT,operation TEXT,version_json TEXT,created_at INTEGER); CREATE TABLE sync_apply_guard(id INTEGER PRIMARY KEY,applying INTEGER); INSERT INTO sync_apply_guard VALUES(1,0);").unwrap();
        conn.execute("INSERT INTO sync_local_device VALUES(1,?1)", [local]).unwrap();
        conn.execute("INSERT INTO sync_devices VALUES(?1,'trusted',?2)", rusqlite::params![remote, crate::core::sync_identity::public_key(&seed).to_vec()]).unwrap();
        conn.execute("INSERT INTO sync_local_versions VALUES('cloud_account',?1,1)", [entity]).unwrap();
        let mut delta = SyncDeltaBundle {
            protocol_version: 1, source_device_id: remote.into(), target_device_id: local.into(), from_sequence: 3, through_sequence: 3, signature: None,
            changes: vec![SyncDeltaChange { sequence: 3, message_id: message_id.into(), entity_type: "cloud_account".into(), entity_sync_id: entity.into(), operation: "upsert".into(), version_json: format!(r#"{{"{remote}":1}}"#), created_at: 100 }],
            snapshot: SyncAccountBundle { protocol_version: 1, accounts: vec![SyncAccountRecord { sync_id: entity.into(), account_name: "incoming name".into(), cloud_type: "aliyun".into(), group_name: None, access_key_id: "new-access-id".into(), access_key_secret: "incoming-secret".into(), credential_meta: None, region_id: None, sort_order: 0, enabled: true, remark: None }], managed_hosts: vec![], panels: vec![], deletions: vec![] },
        };
        let bytes = super::sync_delta_signing_bytes(&delta).unwrap();
        delta.signature = Some(STANDARD.encode(crate::core::sync_identity::sign_sync_delta(&seed, remote, local, &bytes).unwrap()));
        assert!(super::apply_sync_delta_with_encryptor(&mut conn, &delta, &[], 200, |value| Ok(format!("cipher:{value}"))).unwrap_err().contains("冲突选择"));
        let resolution = super::SyncDeltaConflictResolution { entity_type: "cloud_account".into(), sync_id: entity.into(), choice: "local".into() };
        let counts = super::apply_sync_delta_with_encryptor(&mut conn, &delta, &[resolution], 201, |value| Ok(format!("cipher:{value}"))).unwrap();
        assert_eq!((counts.added, counts.updated, counts.deleted), (0, 0, 0));
        let name: String = conn.query_row("SELECT account_name FROM cloud_accounts WHERE sync_id=?1", [entity], |row| row.get(0)).unwrap();
        assert_eq!(name, "prod");
        assert_eq!(conn.query_row::<i64,_,_>("SELECT COUNT(*) FROM sync_inbox WHERE peer_device_id=?1 AND message_id=?2", rusqlite::params![remote,message_id], |row| row.get(0)).unwrap(), 1);
        let version: String = conn.query_row("SELECT current_version_json FROM sync_entity_versions WHERE peer_device_id=?1 AND entity_type='cloud_account' AND entity_sync_id=?2", rusqlite::params![remote,entity], |row| row.get(0)).unwrap();
        assert_eq!(parse_version_vector(&version).unwrap().get(remote), Some(&1));
        assert_eq!(conn.query_row::<i64,_,_>("SELECT COUNT(*) FROM sync_outbox WHERE entity_type='cloud_account' AND entity_sync_id=?1 AND operation='upsert'", [entity], |row| row.get(0)).unwrap(), 1);
    }

    #[test]
    fn delta_preview_requires_trusted_source_and_surfaces_concurrent_edits() {
        let local = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let remote = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        let entity = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE sync_local_device(id INTEGER PRIMARY KEY,device_id TEXT); CREATE TABLE sync_devices(device_id TEXT PRIMARY KEY,status TEXT); CREATE TABLE sync_entity_versions(peer_device_id TEXT,entity_type TEXT,entity_sync_id TEXT,current_version_json TEXT); CREATE TABLE sync_local_versions(entity_type TEXT,entity_sync_id TEXT,counter INTEGER);").unwrap();
        conn.execute("INSERT INTO sync_local_device VALUES(1,?1)", [local]).unwrap();
        conn.execute("INSERT INTO sync_devices VALUES(?1,'trusted')", [remote]).unwrap();
        conn.execute("INSERT INTO sync_entity_versions VALUES(?1,'cloud_account',?2,?3)", rusqlite::params![remote, entity, format!(r#"{{"{local}":1,"{remote}":1}}"#)]).unwrap();
        conn.execute("INSERT INTO sync_local_versions VALUES('cloud_account',?1,2)", [entity]).unwrap();
        let delta = SyncDeltaBundle {
            protocol_version: 1, source_device_id: remote.into(), target_device_id: local.into(), from_sequence: 1, through_sequence: 1, signature: None,
            changes: vec![SyncDeltaChange { sequence: 1, message_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd".into(), entity_type: "cloud_account".into(), entity_sync_id: entity.into(), operation: "delete".into(), version_json: format!(r#"{{"{remote}":2}}"#), created_at: 10 }],
            snapshot: SyncAccountBundle { protocol_version: 1, accounts: vec![], managed_hosts: vec![], panels: vec![], deletions: vec![super::SyncDeletionRecord { entity_type: "cloud_account".into(), sync_id: entity.into(), version_json: format!(r#"{{"{remote}":2}}"#), deleted_at: 10 }] },
        };
        let conflicts = preview_delta_version_conflicts(&conn, &delta).unwrap();
        assert_eq!(conflicts.len(), 1);
        assert!(conflicts[0].reason.contains("人工选择"));
        assert!(!conflicts[0].name.contains("secret"));
    }

    fn config_fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE cloud_accounts(id INTEGER PRIMARY KEY,sync_id TEXT,account_name TEXT,cloud_type TEXT,group_name TEXT,access_key_id TEXT,secret_ciphertext TEXT,credential_meta TEXT,region_id TEXT,sort_order INTEGER,enabled INTEGER,remark TEXT,created_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0); CREATE UNIQUE INDEX idx_test_account_sync_id ON cloud_accounts(sync_id); CREATE TABLE managed_hosts(id INTEGER PRIMARY KEY,sync_id TEXT,name TEXT,host TEXT,port INTEGER,username TEXT,password_ciphertext TEXT,platform TEXT,auth_method TEXT,private_key_ciphertext TEXT,key_passphrase_ciphertext TEXT,group_name TEXT,tags TEXT,source_account_id INTEGER,source_asset_key TEXT,host_key_fingerprint TEXT,remark TEXT,status TEXT,last_latency_ms INTEGER,metrics_json TEXT,last_checked_at INTEGER,last_error TEXT,created_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0); CREATE UNIQUE INDEX idx_test_host_sync_id ON managed_hosts(sync_id); CREATE TABLE panel_connections(id INTEGER PRIMARY KEY,sync_id TEXT,name TEXT,panel_url TEXT,api_key_ciphertext TEXT,sort_order INTEGER,allow_insecure_tls INTEGER,group_name TEXT,source_account_id INTEGER,source_asset_key TEXT,remark TEXT,status TEXT,summary_json TEXT,last_checked_at INTEGER,last_error TEXT,created_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0); CREATE UNIQUE INDEX idx_test_panel_sync_id ON panel_connections(sync_id); CREATE TABLE sync_tombstones(entity_type TEXT,entity_sync_id TEXT,version_json TEXT,deleted_at INTEGER,PRIMARY KEY(entity_type,entity_sync_id));
          INSERT INTO cloud_accounts(id,sync_id,account_name,cloud_type,group_name,access_key_id,secret_ciphertext,credential_meta,region_id,sort_order,enabled,remark) VALUES(42,'11111111-1111-4111-8111-111111111111','prod','aliyun','primary','ACCESS-ID-SECRETLIKE','CLOUD-SECRET-MUST-NOT-LEAK','{\"private_key\":\"OCI-KEY-MUST-NOT-LEAK\"}','cn-hangzhou',0,1,'production account');
          INSERT INTO managed_hosts(id,sync_id,name,host,port,username,password_ciphertext,platform,auth_method,private_key_ciphertext,key_passphrase_ciphertext,group_name,tags,source_account_id,source_asset_key,host_key_fingerprint,remark,status,last_latency_ms,metrics_json,last_checked_at,last_error) VALUES(7,'22222222-2222-4222-8222-222222222222','web-1','web.example.test',22,'root','SSH-PASSWORD-MUST-NOT-LEAK','linux','password','SSH-KEY-MUST-NOT-LEAK','SSH-PASSPHRASE-MUST-NOT-LEAK','prod','web',42,'i-abc','SHA256:fingerprint','managed host','online',7,'{\"cpu\":1}',10,'runtime error');
          INSERT INTO panel_connections(id,sync_id,name,panel_url,api_key_ciphertext,sort_order,allow_insecure_tls,group_name,source_account_id,source_asset_key,remark,status,summary_json,last_checked_at,last_error) VALUES(9,'33333333-3333-4333-8333-333333333333','panel','https://panel.example.test','PANEL-API-KEY-MUST-NOT-LEAK',2,0,'ops',42,'server-1','panel config','online','{\"secret\":\"runtime\"}',10,'runtime error');").unwrap();
        conn
    }

    #[test]
    fn bundle_conflict_preview_reports_only_non_secret_names_and_reasons() {
        let conn = config_fixture();
        let bundle = SyncAccountBundle {
            protocol_version: 1,
            accounts: vec![SyncAccountRecord {
                sync_id: "11111111-1111-4111-8111-111111111111".into(), account_name: "prod-copy".into(),
                cloud_type: "aliyun".into(), group_name: None, access_key_id: "ACCESS-ID-SECRETLIKE".into(),
                access_key_secret: "DO-NOT-RETURN-SECRET".into(), credential_meta: None, region_id: None,
                sort_order: 0, enabled: true, remark: None,
            }],
            managed_hosts: vec![SyncManagedHostRecord {
                sync_id: "44444444-4444-4444-8444-444444444444".into(), name: "web-copy".into(),
                host: "WEB.EXAMPLE.TEST".into(), port: 22, username: "root".into(), platform: "linux".into(),
                auth_method: "password".into(), password: Some("DO-NOT-RETURN-PASSWORD".into()), private_key: None,
                key_passphrase: None, group_name: None, tags: None, source_account_sync_id: None,
                source_asset_key: None, remark: None,
            }],
            panels: vec![SyncPanelRecord {
                sync_id: "33333333-3333-4333-8333-333333333333".into(), name: "panel-copy".into(),
                panel_url: "https://panel.example.test".into(), sort_order: 0, api_key: "DO-NOT-RETURN-PANEL-KEY".into(),
                allow_insecure_tls: false, group_name: None, source_account_sync_id: None, source_asset_key: None, remark: None,
            }], deletions: vec![],
        };
        let conflicts = super::find_bundle_conflicts(&conn, &bundle).unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].entity_type, "managedHost");
        assert_eq!(conflicts[0].reason, "相同的主机地址、端口和用户名属于另一条配置");
        let serialized = serde_json::to_string(&conflicts).unwrap();
        assert!(!serialized.contains("DO-NOT-RETURN"));
        assert!(!serialized.contains("ACCESS-ID-SECRETLIKE"));
    }

    #[test]
    fn repeated_sync_updates_stable_entities_and_resets_changed_host_trust_state() {
        let mut conn = config_fixture();
        conn.execute("INSERT INTO sync_tombstones(entity_type,entity_sync_id,version_json,deleted_at) VALUES('cloud_account','11111111-1111-4111-8111-111111111111','{\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\":1}',1)", []).unwrap();
        let bundle = SyncAccountBundle {
            protocol_version: 1,
            accounts: vec![SyncAccountRecord {
                sync_id: "11111111-1111-4111-8111-111111111111".into(), account_name: "prod-updated".into(),
                cloud_type: "aliyun".into(), group_name: Some("production".into()), access_key_id: "ACCESS-ID-SECRETLIKE".into(),
                access_key_secret: "new-cloud-secret".into(), credential_meta: None, region_id: Some("cn-shanghai".into()),
                sort_order: 3, enabled: true, remark: Some("updated".into()),
            }],
            managed_hosts: vec![SyncManagedHostRecord {
                sync_id: "22222222-2222-4222-8222-222222222222".into(), name: "web-updated".into(), host: "new.example.test".into(),
                port: 22, username: "root".into(), platform: "linux".into(), auth_method: "password".into(),
                password: Some("new-host-password".into()), private_key: None, key_passphrase: None, group_name: None, tags: None,
                source_account_sync_id: Some("11111111-1111-4111-8111-111111111111".into()), source_asset_key: None, remark: None,
            }],
            panels: vec![SyncPanelRecord {
                sync_id: "33333333-3333-4333-8333-333333333333".into(), name: "panel-updated".into(),
                panel_url: "https://new-panel.example.test".into(), sort_order: 0, api_key: "new-panel-key".into(),
                allow_insecure_tls: false, group_name: None, source_account_sync_id: None, source_asset_key: None, remark: None,
            }], deletions: vec![],
        };
        assert!(super::find_bundle_conflicts(&conn, &bundle).unwrap().is_empty());
        let counts = super::import_account_bundle_with_encryptor(&mut conn, &bundle, 99, |value| Ok(format!("cipher:{value}"))).unwrap();
        assert_eq!(counts, super::SyncImportCounts { added: 0, updated: 3, deleted: 0 });
        let stale_tombstone: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sync_tombstones WHERE entity_sync_id='11111111-1111-4111-8111-111111111111')", [], |row| row.get(0)).unwrap();
        assert!(!stale_tombstone, "a confirmed upsert must clear its older deletion marker");

        let account: (i64, String, String, String) = conn.query_row(
            "SELECT id,account_name,secret_ciphertext,region_id FROM cloud_accounts WHERE sync_id=?1", [&bundle.accounts[0].sync_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).unwrap();
        assert_eq!(account, (42, "prod-updated".into(), "cipher:new-cloud-secret".into(), "cn-shanghai".into()));

        let host: (i64, String, Option<String>, String, Option<i64>, String) = conn.query_row(
            "SELECT id,host,host_key_fingerprint,status,last_latency_ms,metrics_json FROM managed_hosts WHERE sync_id=?1", [&bundle.managed_hosts[0].sync_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        ).unwrap();
        assert_eq!(host, (7, "new.example.test".into(), None, "unknown".into(), None, "{}".into()));

        let panel: (i64, String, String, String) = conn.query_row(
            "SELECT id,panel_url,api_key_ciphertext,status FROM panel_connections WHERE sync_id=?1", [&bundle.panels[0].sync_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).unwrap();
        assert_eq!(panel, (9, "https://new-panel.example.test".into(), "cipher:new-panel-key".into(), "unknown".into()));
    }

    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE sync_devices(device_id TEXT PRIMARY KEY,status TEXT NOT NULL); CREATE TABLE sync_device_scope(peer_device_id TEXT,entity_type TEXT,entity_sync_id TEXT,granted_at INTEGER,PRIMARY KEY(peer_device_id,entity_type,entity_sync_id)); CREATE TABLE sync_outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT NOT NULL UNIQUE,entity_type TEXT NOT NULL,entity_sync_id TEXT NOT NULL,operation TEXT NOT NULL,version_json TEXT NOT NULL,created_at INTEGER NOT NULL,acknowledged_at INTEGER); CREATE TABLE sync_outbox_acknowledgements(message_id TEXT,peer_device_id TEXT,acknowledged_at INTEGER,PRIMARY KEY(message_id,peer_device_id)); INSERT INTO sync_devices VALUES('peer-1','trusted'),('peer-2','trusted'),('revoked-peer','revoked');").unwrap();
        for index in 0..3 {
            conn.execute("INSERT INTO sync_outbox(message_id,entity_type,entity_sync_id,operation,version_json,created_at) VALUES(?1,'cloud_account',?2,'upsert','{}',?3)", rusqlite::params![Uuid::new_v4().to_string(), format!("entity-{index}"), index]).unwrap();
            conn.execute("INSERT INTO sync_device_scope(peer_device_id,entity_type,entity_sync_id,granted_at) VALUES('peer-2','cloud_account',?1,1)", [format!("entity-{index}")]).unwrap();
        }
        conn.execute("INSERT INTO sync_device_scope(peer_device_id,entity_type,entity_sync_id,granted_at) VALUES('peer-1','cloud_account','entity-0',1),('peer-1','cloud_account','entity-1',1)", []).unwrap();
        conn
    }

    #[test]
    fn lists_bounded_pending_metadata_in_sequence_order() {
        let conn = fixture();
        let batch = list_pending(&conn, "peer-1", 1, 1).unwrap();
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].sequence, 2);
        assert_eq!(batch[0].entity_sync_id, "entity-1");
        assert!(list_pending(&conn, "peer-1", 0, 101).is_err());
        assert!(list_pending(&conn, "peer-1", -1, 10).is_err());
        assert!(list_pending(&conn, "revoked-peer", 0, 10).is_err());
        assert!(list_pending(&conn, "unknown-peer", 0, 10).is_err());
    }

    #[test]
    fn acknowledges_only_existing_ids_and_is_idempotent() {
        let mut conn = fixture();
        let pending = list_pending(&conn, "peer-1", 0, 2).unwrap();
        let ids = pending.iter().map(|entry| entry.message_id.clone()).collect::<Vec<_>>();
        assert_eq!(acknowledge(&mut conn, "peer-1", &ids, 100).unwrap(), 2);
        assert_eq!(acknowledge(&mut conn, "peer-1", &ids, 101).unwrap(), 0);
        assert_eq!(list_pending(&conn, "peer-1", 0, 10).unwrap().len(), 0);
        assert_eq!(list_pending(&conn, "peer-2", 0, 10).unwrap().len(), 3);
        assert!(acknowledge(&mut conn, "peer-1", &["unknown".into()], 102).is_err());
        assert!(acknowledge(&mut conn, "peer-1", &[Uuid::new_v4().to_string()], 102).is_err());
        let outside_scope: String = conn.query_row("SELECT message_id FROM sync_outbox WHERE entity_sync_id='entity-2'", [], |row| row.get(0)).unwrap();
        assert!(acknowledge(&mut conn, "peer-1", &[outside_scope], 103).unwrap_err().contains("共享范围"));
        assert!(acknowledge(&mut conn, "revoked-peer", &ids, 102).is_err());
    }

    #[test]
    fn outbox_change_contract_contains_no_payload_field() {
        let conn = fixture();
        let item = list_pending(&conn, "peer-1", 0, 1).unwrap().remove(0);
        let _: OutboxChange = item;
        let columns: Vec<String> = conn.prepare("PRAGMA table_info(sync_outbox)").unwrap().query_map([], |row| row.get(1)).unwrap().collect::<Result<_, _>>().unwrap();
        assert!(!columns.iter().any(|column| column.contains("payload") || column.contains("secret")));
    }

    #[test]
    fn pending_delta_contains_only_scoped_snapshots_and_keeps_change_receipt_metadata() {
        let mut conn = config_fixture();
        let source = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let peer = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        conn.execute_batch("CREATE TABLE sync_local_device(id INTEGER PRIMARY KEY,device_id TEXT); CREATE TABLE sync_devices(device_id TEXT PRIMARY KEY,status TEXT); CREATE TABLE sync_device_scope(peer_device_id TEXT,entity_type TEXT,entity_sync_id TEXT,granted_at INTEGER,PRIMARY KEY(peer_device_id,entity_type,entity_sync_id)); CREATE TABLE sync_outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT NOT NULL UNIQUE,entity_type TEXT NOT NULL,entity_sync_id TEXT NOT NULL,operation TEXT NOT NULL,version_json TEXT NOT NULL,created_at INTEGER NOT NULL); CREATE TABLE sync_outbox_acknowledgements(message_id TEXT NOT NULL,peer_device_id TEXT NOT NULL,acknowledged_at INTEGER NOT NULL,PRIMARY KEY(message_id,peer_device_id));").unwrap();
        conn.execute("INSERT INTO sync_local_device VALUES(1,?1)", [source]).unwrap();
        conn.execute("INSERT INTO sync_devices VALUES(?1,'trusted')", [peer]).unwrap();
        conn.execute("INSERT INTO sync_device_scope VALUES(?1,'cloud_account','11111111-1111-4111-8111-111111111111',1)", [peer]).unwrap();
        conn.execute("INSERT INTO sync_device_scope VALUES(?1,'managed_host','22222222-2222-4222-8222-222222222222',1)", [peer]).unwrap();
        conn.execute("INSERT INTO sync_outbox(message_id,entity_type,entity_sync_id,operation,version_json,created_at) VALUES('cccccccc-cccc-4ccc-8ccc-cccccccccccc','cloud_account','11111111-1111-4111-8111-111111111111','upsert','{\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\":2}',10)", []).unwrap();
        conn.execute("INSERT INTO sync_outbox(message_id,entity_type,entity_sync_id,operation,version_json,created_at) VALUES('dddddddd-dddd-4ddd-8ddd-dddddddddddd','managed_host','22222222-2222-4222-8222-222222222222','delete','{\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\":3}',11)", []).unwrap();

        let batch = super::build_pending_delta(&mut conn, peer, 0, 10).unwrap();
        assert_eq!(batch.source_device_id, source);
        assert_eq!(batch.target_device_id, peer);
        assert_eq!((batch.from_sequence, batch.through_sequence), (1, 2));
        assert_eq!(batch.changes.len(), 2);
        assert_eq!(batch.snapshot.accounts.len(), 1);
        assert!(batch.snapshot.managed_hosts.is_empty());
        assert_eq!(batch.snapshot.deletions.len(), 1);
        assert_eq!(batch.snapshot.deletions[0].sync_id, "22222222-2222-4222-8222-222222222222");
    }

    #[test]
    fn config_snapshot_maps_local_account_ids_and_excludes_every_credential() {
        let mut conn = config_fixture();
        let snapshot = build_config_snapshot(&mut conn, &SyncSelection {
            account_sync_ids: vec!["11111111-1111-4111-8111-111111111111".into()],
            managed_host_sync_ids: vec!["22222222-2222-4222-8222-222222222222".into()],
            panel_sync_ids: vec!["33333333-3333-4333-8333-333333333333".into()],
        }).unwrap();
        assert_eq!(snapshot.managed_hosts[0].source_account_sync_id.as_deref(), Some("11111111-1111-4111-8111-111111111111"));
        assert_eq!(snapshot.panels[0].source_account_sync_id.as_deref(), Some("11111111-1111-4111-8111-111111111111"));
        let json = serde_json::to_string(&snapshot).unwrap();
        for secret in ["ACCESS-ID-SECRETLIKE", "CLOUD-SECRET-MUST-NOT-LEAK", "OCI-KEY-MUST-NOT-LEAK", "SSH-PASSWORD-MUST-NOT-LEAK", "SSH-KEY-MUST-NOT-LEAK", "SSH-PASSPHRASE-MUST-NOT-LEAK", "PANEL-API-KEY-MUST-NOT-LEAK", "runtime error", "cpu"] {
            assert!(!json.contains(secret), "snapshot unexpectedly includes {secret}");
        }
        assert!(!json.contains("\"sourceAccountId\""));
        assert!(json.contains("sourceAccountSyncId"));
    }

    #[test]
    fn config_snapshot_rejects_missing_selection_and_dangling_local_account_reference() {
        let mut conn = config_fixture();
        assert!(build_config_snapshot(&mut conn, &SyncSelection::default()).is_err());
        conn.execute("DELETE FROM cloud_accounts WHERE id=42", []).unwrap();
        let error = build_config_snapshot(&mut conn, &SyncSelection { managed_host_sync_ids: vec!["22222222-2222-4222-8222-222222222222".into()], ..SyncSelection::default() }).unwrap_err();
        assert!(error.contains("关联的云账号不存在"));
    }

    #[test]
    fn config_snapshot_rejects_duplicate_and_unknown_entity_ids() {
        let mut conn = config_fixture();
        let duplicate = SyncSelection { account_sync_ids: vec!["11111111-1111-4111-8111-111111111111".into(); 2], ..SyncSelection::default() };
        assert!(build_config_snapshot(&mut conn, &duplicate).unwrap_err().contains("重复项"));
        let unknown = SyncSelection { account_sync_ids: vec![Uuid::new_v4().to_string()], ..SyncSelection::default() };
        assert!(build_config_snapshot(&mut conn, &unknown).unwrap_err().contains("已不存在"));
    }

    #[test]
    fn account_package_selection_maps_local_ids_to_stable_ids() {
        let mut conn = config_fixture();
        assert_eq!(account_sync_ids_by_local_ids(&mut conn, &[42]).unwrap(), vec!["11111111-1111-4111-8111-111111111111"]);
        assert!(account_sync_ids_by_local_ids(&mut conn, &[42, 42]).unwrap_err().contains("重复"));
        assert!(account_sync_ids_by_local_ids(&mut conn, &[999]).unwrap_err().contains("不存在"));
    }

    #[test]
    fn migration_package_selects_hosts_by_local_id_and_omits_host_trust_state() {
        let mut conn = config_fixture();
        assert_eq!(managed_host_sync_ids_by_local_ids(&mut conn, &[7]).unwrap(), vec!["22222222-2222-4222-8222-222222222222"]);
        let bundle = build_account_bundle(&mut conn, &[], &["22222222-2222-4222-8222-222222222222".into()], &[], false).unwrap();
        assert!(bundle.accounts.is_empty());
        assert_eq!(bundle.managed_hosts.len(), 1);
        assert!(bundle.panels.is_empty());
        assert_eq!(bundle.managed_hosts[0].host, "web.example.test");
        assert_eq!(bundle.managed_hosts[0].source_account_sync_id.as_deref(), Some("11111111-1111-4111-8111-111111111111"));
        let encoded = serde_json::to_string(&bundle).unwrap();
        assert!(!encoded.contains("SHA256:fingerprint"), "SSH trust must be confirmed on the receiving device");
        assert!(managed_host_sync_ids_by_local_ids(&mut conn, &[7, 7]).is_err());
        assert!(managed_host_sync_ids_by_local_ids(&mut conn, &[999]).is_err());
        assert_eq!(panel_sync_ids_by_local_ids(&conn, &[9]).unwrap(), vec!["33333333-3333-4333-8333-333333333333"]);
        assert!(panel_sync_ids_by_local_ids(&conn, &[9, 9]).unwrap_err().contains("重复"));
    }

    #[test]
    fn migration_package_selects_panel_and_keeps_secret_as_source_ciphertext() {
        let mut conn = config_fixture();
        let panel_id = panel_sync_ids_by_local_ids(&conn, &[9]).unwrap();
        let bundle = build_account_bundle(&mut conn, &[], &[], &panel_id, false).unwrap();
        assert_eq!(bundle.panels.len(), 1);
        assert_eq!(bundle.panels[0].name, "panel");
        assert_eq!(bundle.panels[0].source_account_sync_id.as_deref(), Some("11111111-1111-4111-8111-111111111111"));
        let encoded = serde_json::to_string(&bundle).unwrap();
        assert!(encoded.contains("PANEL-API-KEY-MUST-NOT-LEAK"));
        assert!(!encoded.contains("runtime error"));
        assert!(!encoded.contains("summary"));
    }

    #[test]
    fn deletion_bundle_previews_and_deletes_only_the_stable_target_id() {
        let mut conn = config_fixture();
        conn.execute("INSERT INTO sync_tombstones(entity_type,entity_sync_id,version_json,deleted_at) VALUES('panel_connection','44444444-4444-4444-8444-444444444444','{\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\":1}',100)", []).unwrap();
        let omitted = build_account_bundle(&mut conn, &[], &[], &[], false).err().unwrap();
        assert!(omitted.contains("至少选择"));
        let deletion_only = build_account_bundle(&mut conn, &[], &[], &[], true).unwrap();
        assert_eq!(deletion_only.deletions.len(), 1);
        assert_eq!(deletion_only.deletions[0].entity_type, "panel_connection");
        let deletion = super::SyncDeletionRecord {
            entity_type: "managed_host".into(),
            sync_id: "22222222-2222-4222-8222-222222222222".into(),
            version_json: r#"{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa":1}"#.into(),
            deleted_at: 100,
        };
        let preview = super::preview_bundle_deletions(&conn, std::slice::from_ref(&deletion)).unwrap();
        assert_eq!(preview.len(), 1);
        assert_eq!(preview[0].name, "web-1");
        assert!(preview[0].will_delete);
        let bundle = SyncAccountBundle { protocol_version: 1, accounts: vec![], managed_hosts: vec![], panels: vec![], deletions: vec![deletion] };
        let counts = super::import_account_bundle_with_encryptor(&mut conn, &bundle, 101, |value| Ok(format!("cipher:{value}"))).unwrap();
        assert_eq!(counts.deleted, 1);
        let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM managed_hosts WHERE sync_id='22222222-2222-4222-8222-222222222222')", [], |row| row.get(0)).unwrap();
        assert!(!exists);
        let mut invalid = bundle;
        invalid.deletions[0].version_json = "{}".into();
        assert!(super::import_account_bundle_with_encryptor(&mut conn, &invalid, 102, |value| Ok(value.into())).unwrap_err().contains("版本"));
    }

    #[test]
    fn rejects_non_root_or_non_http_panel_urls_in_migration_packages() {
        assert!(super::valid_panel_root_url("https://panel.example.test:8888"));
        assert!(super::valid_panel_root_url("http://192.168.1.10:8888/"));
        for invalid in ["file:///tmp/panel", "javascript:alert(1)", "https://user@panel.example.test", "https://panel.example.test/path"] {
            assert!(!super::valid_panel_root_url(invalid), "unexpectedly accepted {invalid}");
        }
    }

    #[test]
    fn import_rejects_invalid_or_duplicate_host_records_before_database_writes() {
        let mut conn = Connection::open_in_memory().unwrap();
        let host = super::SyncManagedHostRecord {
            sync_id: "22222222-2222-4222-8222-222222222222".into(), name: "host".into(), host: "host.example.test".into(),
            port: 22, username: "root".into(), platform: "linux".into(), auth_method: "password".into(),
            password: Some("encrypted-in-envelope".into()), private_key: None, key_passphrase: None, group_name: None, tags: None,
            source_account_sync_id: None, source_asset_key: None, remark: None,
        };
        let invalid = SyncAccountBundle { protocol_version: 1, accounts: vec![], managed_hosts: vec![host.clone(), host], panels: vec![], deletions: vec![] };
        assert!(import_account_bundle(&mut conn, &invalid, 1).unwrap_err().contains("重复"));
        let legacy: SyncAccountBundle = serde_json::from_str(r#"{"protocolVersion":1,"accounts":[]}"#).unwrap();
        assert!(legacy.managed_hosts.is_empty());
        assert!(legacy.panels.is_empty());
    }
}
