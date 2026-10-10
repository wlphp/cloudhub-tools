use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;
use zeroize::Zeroize;

/// Credentials and cache plaintext stay inside the native encrypted transfer.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncFlowRecord {
    pub sync_id: String,
    pub name: String,
    pub edition: String,
    pub organization_id: Option<String>,
    pub domain: String,
    pub token: String,
    pub caches: Vec<SyncFlowCache>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncFlowCache {
    pub query_key: String,
    pub payload_json: String,
    pub updated_at: i64,
}

impl Zeroize for SyncFlowRecord {
    fn zeroize(&mut self) {
        self.sync_id.zeroize(); self.name.zeroize(); self.edition.zeroize(); self.organization_id.zeroize();
        self.domain.zeroize(); self.token.zeroize(); self.caches.zeroize();
    }
}
impl Zeroize for SyncFlowCache {
    fn zeroize(&mut self) { self.query_key.zeroize(); self.payload_json.zeroize(); self.updated_at.zeroize(); }
}

pub fn validate(records: &[SyncFlowRecord]) -> Result<(), String> {
    let mut ids = HashSet::new();
    let mut endpoints = HashSet::new();
    let mut bytes = 0usize;
    if records.len() > 100 { return Err("云效连接选择超过 100 条".into()); }
    for record in records {
        if Uuid::parse_str(&record.sync_id).is_err() || !ids.insert(&record.sync_id) {
            return Err("同步包包含无效或重复的云效连接 ID".into());
        }
        let input = crate::FlowConnectionInput { id: None, name: record.name.clone(), edition: record.edition.clone(),
            organization_id: record.organization_id.clone(), domain: Some(record.domain.clone()), token: None };
        let (name, edition, org, domain) = super::flow_connections::validate_connection(&input)?;
        if name != record.name || org != record.organization_id || domain != record.domain || record.token.trim().is_empty() || record.token.len() > 8192 || record.token.chars().any(char::is_control) {
            return Err("同步包中的云效连接或令牌格式无效".into());
        }
        if !endpoints.insert((edition, org, domain)) || record.caches.len() > 100 {
            return Err("同步包包含重复云效组织或过多缓存页".into());
        }
        let mut keys = HashSet::new();
        for cache in &record.caches {
            bytes = bytes.saturating_add(cache.payload_json.len());
            if bytes > 8 * 1024 * 1024 || cache.query_key.len() > 512 || cache.updated_at < 0 || !keys.insert(&cache.query_key) {
                return Err("同步流水线缓存大小或页标识无效".into());
            }
            let (page, per_page, keyword, group): (u32, u32, String, String) = serde_json::from_str(&cache.query_key).map_err(|_| "流水线缓存分页格式无效")?;
            if super::flow_connections::pipeline_cache_key(page, per_page, Some(&keyword), Some(&group))? != cache.query_key {
                return Err("流水线缓存分页格式无效".into());
            }
            let pipelines: Vec<crate::FlowPipeline> = serde_json::from_str(&cache.payload_json).map_err(|_| "流水线缓存内容无效")?;
            if pipelines.len() > per_page as usize || pipelines.iter().any(|item| item.pipeline_id.is_empty() || item.pipeline_id.len() > 128 || item.pipeline_name.len() > 1024) {
                return Err("流水线缓存内容无效".into());
            }
        }
    }
    Ok(())
}

pub fn build(conn: &mut Connection, ids: &[i64]) -> Result<Vec<SyncFlowRecord>, String> {
    build_with_decryptor(conn, ids, crate::decrypt_secret)
}

fn build_with_decryptor<F>(conn: &mut Connection, ids: &[i64], decrypt: F) -> Result<Vec<SyncFlowRecord>, String>
where F: Fn(&str) -> Result<String, String> {
    let mut unique = HashSet::new();
    if ids.len() > 100 || ids.iter().any(|id| *id <= 0 || !unique.insert(id)) { return Err("云效连接选择无效或重复".into()); }
    let transaction = conn.transaction().map_err(|_| "无法读取云效同步配置")?;
    let mut output = zeroize::Zeroizing::new(Vec::new());
    for id in ids {
        let connection = super::flow_connections::get(&transaction, *id)?;
        let sync_id = transaction.query_row("SELECT sync_id FROM flow_sync_identity WHERE connection_id=?1", [id], |row| row.get::<_, String>(0))
            .optional().map_err(|_| "无法读取云效同步身份")?.unwrap_or_else(|| Uuid::new_v4().to_string());
        transaction.execute("INSERT OR IGNORE INTO flow_sync_identity(connection_id,sync_id) VALUES(?1,?2)", params![id,sync_id]).map_err(|_| "无法保存云效同步身份")?;
        let (_, ciphertext) = super::flow_connections::load_token(&transaction, *id)?;
        let mut record = zeroize::Zeroizing::new(SyncFlowRecord { sync_id, name: connection.name, edition: connection.edition,
            organization_id: connection.organization_id, domain: connection.domain, token: decrypt(&ciphertext)?, caches: vec![] });
        let mut statement = transaction.prepare("SELECT query_key,payload_ciphertext,updated_at FROM flow_pipeline_cache WHERE connection_id=?1 ORDER BY query_key LIMIT 101").map_err(|_| "无法读取流水线同步缓存")?;
        let pages = statement.query_map([id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)))
            .map_err(|_| "无法读取流水线同步缓存")?;
        for page in pages {
            let (query_key, ciphertext, updated_at) = page.map_err(|_| "无法读取流水线同步缓存")?;
            let plaintext = zeroize::Zeroizing::new(decrypt(&ciphertext)?);
            let pipelines: Vec<crate::FlowPipeline> = serde_json::from_str(&plaintext).map_err(|_| "流水线缓存内容无效")?;
            record.caches.push(SyncFlowCache { query_key, payload_json: serde_json::to_string(&pipelines).map_err(|_| "流水线缓存内容无效")?, updated_at });
        }
        output.push((*record).clone());
    }
    validate(&output)?;
    transaction.commit().map_err(|_| "无法保存云效同步身份")?;
    Ok(std::mem::take(&mut *output))
}

pub fn conflicts(conn: &Connection, records: &[SyncFlowRecord]) -> Result<Vec<super::sync::SyncBundleConflict>, String> {
    let mut conflicts = vec![];
    for record in records {
        let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM flow_connections f LEFT JOIN flow_sync_identity s ON s.connection_id=f.id
            WHERE f.edition=?1 AND COALESCE(f.organization_id,'')=COALESCE(?2,'') AND f.domain=?3 AND COALESCE(s.sync_id,'')<>?4)",
            params![record.edition,record.organization_id,record.domain,record.sync_id], |row| row.get(0)).map_err(|_| "无法检查云效同步冲突")?;
        if exists { conflicts.push(super::sync::SyncBundleConflict { entity_type: "flowConnection".into(), sync_id: record.sync_id.clone(), name: record.name.clone(), reason: "相同云效组织属于另一条本机连接，请先处理重复连接".into(), resolvable: false }); }
    }
    Ok(conflicts)
}

pub fn import<F>(conn: &Connection, records: &[SyncFlowRecord], now: i64, encrypt: F) -> Result<(usize, usize), String>
where F: Fn(&str) -> Result<String, String> {
    validate(records)?;
    if !conflicts(conn, records)?.is_empty() { return Err("本机存在重复云效组织，请先处理连接冲突".into()); }
    let (mut added, mut updated) = (0, 0);
    for record in records {
        let id: Option<i64> = conn.query_row("SELECT connection_id FROM flow_sync_identity WHERE sync_id=?1", [&record.sync_id], |row| row.get(0)).optional().map_err(|_| "无法读取云效同步身份")?;
        let token = encrypt(&record.token)?;
        let id = if let Some(id) = id {
            conn.execute("UPDATE flow_connections SET name=?1,edition=?2,organization_id=?3,domain=?4,token_ciphertext=?5,updated_at=MAX(?6,updated_at+1) WHERE id=?7", params![record.name,record.edition,record.organization_id,record.domain,token,now,id]).map_err(|_| "导入云效连接失败")?;
            updated += 1; id
        } else {
            conn.execute("INSERT INTO flow_connections(name,edition,organization_id,domain,token_ciphertext,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6)", params![record.name,record.edition,record.organization_id,record.domain,token,now]).map_err(|_| "导入云效连接失败")?;
            let id = conn.last_insert_rowid();
            conn.execute("INSERT INTO flow_sync_identity(connection_id,sync_id) VALUES(?1,?2)", params![id,record.sync_id]).map_err(|_| "导入云效同步身份失败")?;
            added += 1; id
        };
        conn.execute("DELETE FROM flow_pipeline_cache WHERE connection_id=?1", [id]).map_err(|_| "清理旧流水线缓存失败")?;
        for cache in &record.caches {
            // Normalize to the display-only pipeline model before persisting.
            let pipelines: Vec<crate::FlowPipeline> = serde_json::from_str(&cache.payload_json).map_err(|_| "流水线缓存内容无效")?;
            let payload = zeroize::Zeroizing::new(serde_json::to_string(&pipelines).map_err(|_| "流水线缓存内容无效")?);
            let ciphertext = encrypt(&payload)?;
            conn.execute("INSERT INTO flow_pipeline_cache(connection_id,query_key,payload_ciphertext,updated_at) VALUES(?1,?2,?3,?4)", params![id,cache.query_key,ciphertext,cache.updated_at]).map_err(|_| "导入流水线缓存失败")?;
        }
    }
    Ok((added, updated))
}

pub fn pipeline_count(record: &SyncFlowRecord) -> usize {
    record.caches.iter().filter_map(|cache| serde_json::from_str::<Vec<crate::FlowPipeline>>(&cache.payload_json).ok())
        .flatten().map(|item| item.pipeline_id).collect::<HashSet<_>>().len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;
            CREATE TABLE flow_connections(id INTEGER PRIMARY KEY,name TEXT,edition TEXT,organization_id TEXT,domain TEXT,token_ciphertext TEXT,created_at INTEGER,updated_at INTEGER);
            CREATE TABLE flow_sync_identity(connection_id INTEGER PRIMARY KEY,sync_id TEXT UNIQUE,FOREIGN KEY(connection_id) REFERENCES flow_connections(id) ON DELETE CASCADE);
            CREATE TABLE flow_pipeline_cache(connection_id INTEGER,query_key TEXT,payload_ciphertext TEXT,updated_at INTEGER,PRIMARY KEY(connection_id,query_key),FOREIGN KEY(connection_id) REFERENCES flow_connections(id) ON DELETE CASCADE);").unwrap();
        conn
    }

    fn record() -> SyncFlowRecord {
        SyncFlowRecord { sync_id: Uuid::new_v4().to_string(), name: "流水线测试连接".into(), edition: "central".into(),
            organization_id: Some("fixture-org".into()), domain: "https://openapi-rdc.aliyuncs.com".into(), token: Uuid::new_v4().to_string(),
            caches: vec![SyncFlowCache { query_key: "[1,12,\"\",\"\"]".into(), payload_json: r#"[{"pipelineId":"123","pipelineName":"测试构建","createTime":null,"latestStatus":"SUCCESS"}]"#.into(), updated_at: 10 }] }
    }

    #[test]
    fn round_trip_remaps_local_ids_reencrypts_and_keeps_stable_identity() {
        let mut source = fixture();
        let target = fixture();
        let incoming = record();
        let source_seal = |value: &str| Ok(format!("source:{value}"));
        let source_open = |value: &str| value.strip_prefix("source:").map(str::to_string).ok_or("cannot decrypt".into());
        import(&source, &[incoming.clone()], 20, source_seal).unwrap();
        // The same local numeric ID on another device belongs to an unrelated organization.
        let mut unrelated = record(); unrelated.organization_id = Some("other-org".into());
        import(&target, &[unrelated], 20, |value| Ok(format!("target:{value}"))).unwrap();
        let first = build_with_decryptor(&mut source, &[1], source_open).unwrap();
        let second = build_with_decryptor(&mut source, &[1], source_open).unwrap();
        assert_eq!(first[0].sync_id, second[0].sync_id);
        assert_eq!(pipeline_count(&first[0]), 1);
        assert_eq!(import(&target, &first, 30, |value| Ok(format!("target:{value}"))).unwrap(), (1,0));
        let (id, cipher): (i64, String) = target.query_row("SELECT f.id,token_ciphertext FROM flow_connections f JOIN flow_sync_identity s ON s.connection_id=f.id WHERE sync_id=?1", [&incoming.sync_id], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(id, 2);
        assert_eq!(cipher, format!("target:{}", incoming.token));
        let cached: String = target.query_row("SELECT payload_ciphertext FROM flow_pipeline_cache WHERE connection_id=?1", [id], |row| row.get(0)).unwrap();
        assert!(cached.starts_with("target:"));
        assert_eq!(import(&target, &first, 30, |value| Ok(format!("target:{value}"))).unwrap(), (0,1));
        assert_eq!(target.query_row("SELECT COUNT(*) FROM flow_connections", [], |row| row.get::<_, i64>(0)).unwrap(), 2);
        super::super::flow_connections::delete(&target, id).unwrap();
        assert_eq!(target.query_row("SELECT COUNT(*) FROM flow_sync_identity WHERE connection_id=?1", [id], |row| row.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn rejects_duplicate_org_invalid_domain_and_bad_cache_before_import() {
        let conn = fixture();
        let incoming = record();
        import(&conn, &[incoming.clone()], 1, |value| Ok(format!("sealed:{value}"))).unwrap();
        let mut duplicate = incoming.clone(); duplicate.sync_id = Uuid::new_v4().to_string();
        let preview = conflicts(&conn, &[duplicate.clone()]).unwrap();
        assert_eq!(preview.len(), 1);
        assert!(!serde_json::to_string(&preview).unwrap().contains(&duplicate.token));
        assert!(import(&conn, &[duplicate], 2, |value| Ok(format!("sealed:{value}"))).is_err());
        let mut bad = incoming.clone(); bad.domain = "https://example.test".into(); assert!(validate(&[bad]).is_err());
        let mut bad = incoming.clone(); bad.caches[0].query_key = "[0,12,\"\",\"\"]".into(); assert!(validate(&[bad]).is_err());
        let mut bad = incoming; bad.caches[0].payload_json = "{}".into(); assert!(validate(&[bad]).is_err());
    }
}
