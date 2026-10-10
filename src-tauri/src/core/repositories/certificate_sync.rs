use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;
use zeroize::Zeroize;

/// Deliberately excludes account credentials, ACME URLs, PEMs and provider errors.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncCertificateRecord {
    pub sync_id: String,
    pub provider: String,
    pub primary_domain: String,
    pub domains: Vec<String>,
    pub status: String,
    pub issuer: Option<String>,
    pub serial_number: Option<String>,
    pub not_before: Option<i64>,
    pub not_after: Option<i64>,
    pub updated_at: i64,
}

impl Zeroize for SyncCertificateRecord {
    fn zeroize(&mut self) {
        self.sync_id.zeroize(); self.provider.zeroize(); self.primary_domain.zeroize();
        self.domains.zeroize(); self.status.zeroize(); self.issuer.zeroize();
        self.serial_number.zeroize(); self.not_before.zeroize(); self.not_after.zeroize(); self.updated_at.zeroize();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateSummary {
    pub id: i64,
    #[serde(flatten)]
    pub metadata: SyncCertificateRecord,
}

fn safe_text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}

pub fn validate(records: &[SyncCertificateRecord]) -> Result<(), String> {
    let mut ids = HashSet::new();
    if records.len() > 100 { return Err("证书同步数量超限".into()); }
    for item in records {
        let domain = |value: &str| safe_text(value, 253) && value.is_ascii() && value.bytes().all(|b| b.is_ascii_alphanumeric() || b".*-_".contains(&b));
        let time = |value: Option<i64>| value.is_none_or(|v| (0..=253402300799).contains(&v));
        if Uuid::parse_str(&item.sync_id).is_err() || !ids.insert(&item.sync_id)
            || !domain(&item.primary_domain) || item.domains.is_empty() || item.domains.len() > 100
            || !item.domains.iter().all(|v| domain(v)) || !item.domains.contains(&item.primary_domain)
            || !safe_text(&item.provider, 80) || !safe_text(&item.status, 40)
            || item.issuer.as_ref().is_some_and(|v| !safe_text(v, 512))
            || item.serial_number.as_ref().is_some_and(|v| !safe_text(v, 256))
            || !time(item.not_before) || !time(item.not_after)
            || matches!((item.not_before, item.not_after), (Some(a),Some(b)) if b <= a)
            || item.updated_at < 0 {
            return Err("证书同步信息无效".into());
        }
    }
    Ok(())
}

pub fn list(conn: &Connection) -> Result<Vec<CertificateSummary>, String> {
    let mut items = Vec::new();
    for item in super::certificates::list(conn, None)? {
        let sync_id: Option<String> = conn.query_row("SELECT sync_id FROM certificate_sync_identity WHERE certificate_id=?1", [item.id], |row| row.get(0)).optional().map_err(|_| "读取证书同步身份失败")?;
        items.push(CertificateSummary { id: item.id, metadata: SyncCertificateRecord {
            sync_id: sync_id.unwrap_or_default(), provider: item.provider, primary_domain: item.primary_domain,
            domains: item.domains, status: item.status, issuer: item.issuer, serial_number: item.serial_number,
            not_before: item.not_before, not_after: item.not_after, updated_at: item.updated_at,
        } });
    }
    let mut query = conn.prepare("SELECT rowid, metadata_json FROM certificate_snapshots WHERE sync_id NOT IN (SELECT sync_id FROM certificate_sync_identity)").map_err(|_| "读取同步证书失败")?;
    let rows = query.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))).map_err(|_| "读取同步证书失败")?;
    for row in rows {
        let (id, json) = row.map_err(|_| "读取同步证书失败")?;
        let metadata: SyncCertificateRecord = serde_json::from_str(&json).map_err(|_| "证书快照格式无效")?;
        validate(std::slice::from_ref(&metadata))?;
        items.push(CertificateSummary { id: -id, metadata });
    }
    items.sort_by(|a,b| b.metadata.updated_at.cmp(&a.metadata.updated_at));
    Ok(items)
}

use rusqlite::OptionalExtension;

pub fn build(conn: &mut Connection, selected: &[i64]) -> Result<Vec<SyncCertificateRecord>, String> {
    if selected.is_empty() { return Ok(Vec::new()); }
    if selected.len() > 100 || selected.iter().copied().collect::<HashSet<_>>().len() != selected.len() { return Err("证书选择无效".into()); }
    let transaction = conn.transaction().map_err(|_| "创建证书同步事务失败")?;
    let summaries = list(&transaction)?;
    let mut records = Vec::new();
    for id in selected {
        let mut item = summaries.iter().find(|v| v.id == *id).ok_or("所选证书不存在")?.metadata.clone();
        if item.sync_id.is_empty() {
            item.sync_id = Uuid::new_v4().to_string();
            transaction.execute("INSERT INTO certificate_sync_identity(certificate_id,sync_id) VALUES(?1,?2)", params![id,item.sync_id]).map_err(|_| "保存证书同步身份失败")?;
        }
        records.push(item);
    }
    validate(&records)?;
    transaction.commit().map_err(|_| "提交证书同步事务失败")?;
    Ok(records)
}

/// Called inside the configuration import transaction; no cloud account is required.
pub fn import(conn: &Connection, records: &[SyncCertificateRecord], now: i64) -> Result<(usize,usize), String> {
    validate(records)?;
    let (mut added, mut updated) = (0,0);
    for item in records {
        let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM certificate_snapshots WHERE sync_id=?1)", [&item.sync_id], |row| row.get(0)).map_err(|_| "读取同步证书失败")?;
        let json = serde_json::to_string(item).map_err(|_| "编码证书信息失败")?;
        conn.execute("INSERT INTO certificate_snapshots(sync_id,metadata_json,synced_at) VALUES(?1,?2,?3) ON CONFLICT(sync_id) DO UPDATE SET metadata_json=excluded.metadata_json,synced_at=excluded.synced_at", params![item.sync_id,json,now]).map_err(|_| "保存同步证书失败")?;
        if exists { updated += 1; } else { added += 1; }
    }
    Ok((added,updated))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE certificates(id INTEGER PRIMARY KEY,account_id INTEGER,provider TEXT,primary_domain TEXT,domains_json TEXT,status TEXT,certificate_url TEXT,serial_number TEXT,issuer TEXT,not_before INTEGER,not_after INTEGER,dns_zone TEXT,last_error TEXT,created_at INTEGER,updated_at INTEGER);
            CREATE TABLE certificate_sync_identity(certificate_id INTEGER PRIMARY KEY,sync_id TEXT UNIQUE);
            CREATE TABLE certificate_snapshots(sync_id TEXT UNIQUE,metadata_json TEXT,synced_at INTEGER);").unwrap();
        conn
    }
    #[test]
    fn source_identity_is_stable_and_snapshot_is_readable_on_empty_phone() {
        let mut source = fixture();
        source.execute("INSERT INTO certificates(id,account_id,provider,primary_domain,domains_json,status,not_before,not_after,dns_zone,created_at,updated_at) VALUES(7,99,'letsencrypt','example.com','[\"example.com\"]','issued',100,200,'example.com',1,2)",[]).unwrap();
        let first = build(&mut source,&[7]).unwrap();
        assert_eq!(first[0].sync_id,build(&mut source,&[7]).unwrap()[0].sync_id);
        let phone = fixture();
        import(&phone,&first,10).unwrap();
        let records = list(&phone).unwrap();
        assert_eq!(records.len(),1);
        assert!(records[0].id < 0);
        assert_eq!(records[0].metadata.not_after,Some(200));
        assert!(build(&mut source,&[999]).is_err());
        assert!(build(&mut source,&[7,7]).is_err());
        assert!(!serde_json::to_string(&first).unwrap().contains("account"));
    }
    #[test]
    fn metadata_sync_without_account_is_idempotent_and_rejects_private_material() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE certificate_snapshots(sync_id TEXT UNIQUE,metadata_json TEXT,synced_at INTEGER)").unwrap();
        let mut item = SyncCertificateRecord { sync_id: Uuid::new_v4().to_string(), provider:"letsencrypt".into(),primary_domain:"example.com".into(),domains:vec!["example.com".into()],status:"issued".into(),issuer:Some("Fixture CA".into()),serial_number:None,not_before:Some(100),not_after:Some(200),updated_at:1 };
        assert_eq!(import(&conn,&[item.clone()],1).unwrap(),(1,0));
        item.not_after = Some(300);
        assert_eq!(import(&conn,&[item.clone()],2).unwrap(),(0,1));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM certificate_snapshots",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        let mut json = serde_json::to_value(&item).unwrap();
        json["privateKeyPem"] = serde_json::json!("forbidden fixture");
        assert!(serde_json::from_value::<SyncCertificateRecord>(json).is_err());
        item.not_after = Some(99);
        assert!(validate(&[item]).is_err());
    }
}
