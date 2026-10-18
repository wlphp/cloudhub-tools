use rusqlite::{params, Connection};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all="camelCase")]
pub struct CertificateSourceSite { pub id:i64,pub panel_name:String,pub site_name:String,pub site_domains:Vec<String> }

#[derive(Debug, Clone)]
pub struct CertificateRecord {
    pub id: i64,
    pub account_id: Option<i64>,
    pub provider: String,
    pub primary_domain: String,
    pub domains: Vec<String>,
    pub status: String,
    pub certificate_url: Option<String>,
    pub serial_number: Option<String>,
    pub issuer: Option<String>,
    pub not_before: Option<i64>,
    pub not_after: Option<i64>,
    pub dns_zone: String,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub source_kind: String,
    pub fingerprint: Option<String>,
    pub source_sites: Vec<CertificateSourceSite>,
}

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CertificateRecord> {
    let domains_json: String = row.get(4)?;
    Ok(CertificateRecord {
        id: row.get(0)?, account_id: row.get(1)?, provider: row.get(2)?, primary_domain: row.get(3)?,
        domains: serde_json::from_str(&domains_json).unwrap_or_default(), status: row.get(5)?, certificate_url: row.get(6)?,
        serial_number: row.get(7)?, issuer: row.get(8)?, not_before: row.get(9)?, not_after: row.get(10)?, dns_zone: row.get(11)?,
        last_error: row.get(12)?, created_at: row.get(13)?, updated_at: row.get(14)?,
        source_kind: row.get(15)?, fingerprint: row.get(16)?,
        source_sites: vec![],
    })
}

const SELECT: &str = "SELECT id,account_id,provider,primary_domain,domains_json,status,certificate_url,serial_number,issuer,not_before,not_after,dns_zone,last_error,created_at,updated_at,source_kind,fingerprint FROM certificates WHERE deleted_at IS NULL";

pub fn list(conn: &Connection, account_id: Option<i64>) -> Result<Vec<CertificateRecord>, String> {
    let sql = format!("{SELECT} AND (?1 IS NULL OR account_id=?1) ORDER BY updated_at DESC, id DESC");
    let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = statement.query_map([account_id], row).map_err(|error| error.to_string())?;
    let mut result=rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    for item in &mut result { item.source_sites=source_sites(conn,item.id)?; }
    Ok(result)
}

pub fn insert(
    conn: &Connection, account_id: i64, provider: &str, primary_domain: &str, domains: &[String], status: &str,
    order_url: Option<&str>, certificate_url: Option<&str>, certificate_pem_ciphertext: Option<&str>, private_key_ciphertext: Option<&str>,
    serial_number: Option<&str>, issuer: Option<&str>, not_before: Option<i64>, not_after: Option<i64>, dns_zone: &str,
    dns_record_ids: &[String], last_error: Option<&str>, now: i64,
) -> Result<CertificateRecord, String> {
    conn.execute("INSERT INTO certificates(account_id,provider,primary_domain,domains_json,status,order_url,certificate_url,certificate_pem_ciphertext,private_key_ciphertext,serial_number,issuer,not_before,not_after,dns_zone,dns_record_ids_json,last_error,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?17)", params![account_id, provider, primary_domain, serde_json::to_string(domains).map_err(|error| error.to_string())?, status, order_url, certificate_url, certificate_pem_ciphertext, private_key_ciphertext, serial_number, issuer, not_before, not_after, dns_zone, serde_json::to_string(dns_record_ids).map_err(|error| error.to_string())?, last_error, now]).map_err(|error| error.to_string())?;
    get(conn, conn.last_insert_rowid())
}

pub fn get(conn: &Connection, id: i64) -> Result<CertificateRecord, String> {
    let sql = format!("{SELECT} AND id=?1");
    let mut item=conn.query_row(&sql, [id], row).map_err(|error| format!("读取证书记录失败: {error}"))?;
    item.source_sites=source_sites(conn,id)?;Ok(item)
}

fn source_sites(conn:&Connection,id:i64)->Result<Vec<CertificateSourceSite>,String>{
    let mut stmt=conn.prepare("SELECT id,panel_name,site_name,site_domains_json FROM certificate_source_links WHERE certificate_id=?1 ORDER BY panel_name,site_name").map_err(|_|"读取证书来源站点失败")?;
    let rows=stmt.query_map([id],|row|Ok(CertificateSourceSite{id:row.get(0)?,panel_name:row.get(1)?,site_name:row.get(2)?,site_domains:serde_json::from_str(&row.get::<_,String>(3)?).unwrap_or_default()})).map_err(|_|"读取证书来源站点失败")?;
    rows.collect::<Result<Vec<_>,_>>().map_err(|_|"读取证书来源站点失败".into())
}

pub fn secret_material(conn: &Connection, id: i64) -> Result<(String, String, Vec<String>), String> {
    conn.query_row("SELECT certificate_pem_ciphertext,private_key_ciphertext,dns_record_ids_json FROM certificates WHERE id=?1 AND deleted_at IS NULL", [id], |row| Ok((row.get(0)?, row.get(1)?, serde_json::from_str::<Vec<String>>(&row.get::<_, String>(2)?).unwrap_or_default()))).map_err(|error| format!("读取证书密钥材料失败: {error}"))
}

pub fn has_domain_zone(conn: &Connection, account_id: i64, dns_zone: &str) -> Result<bool, String> {
    let mut statement = conn.prepare("SELECT asset_key,payload_json FROM cloud_assets WHERE account_id=?1 AND resource_type='domain'").map_err(|error| format!("读取账号域名资产失败: {error}"))?;
    let rows = statement.query_map([account_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).map_err(|error| error.to_string())?;
    for row in rows {
        let (asset_key, payload_json) = row.map_err(|error| error.to_string())?;
        if asset_key.eq_ignore_ascii_case(dns_zone) { return Ok(true); }
        if serde_json::from_str::<serde_json::Value>(&payload_json).ok().and_then(|value| value.get("DomainName").and_then(serde_json::Value::as_str).map(|value| value.eq_ignore_ascii_case(dns_zone))).unwrap_or(false) { return Ok(true); }
    }
    Ok(false)
}

/// Moves the certificate to the recycle bin. Deployments and versions stay
/// linked so restoring brings the whole certificate back.
pub fn delete(conn: &Connection, id: i64, now: i64) -> Result<(), String> {
    let changed = super::trash::soft_delete(conn, "certificates", &[rusqlite::types::Value::Integer(id)], now).map_err(|error| error.to_string())?;
    if changed == 0 { return Err("证书记录不存在".into()); }
    Ok(())
}

pub fn update_validity(conn: &Connection, id: i64, not_before: Option<i64>, not_after: Option<i64>) -> Result<(), String> {
    conn.execute("UPDATE certificates SET not_before=COALESCE(?2,not_before), not_after=COALESCE(?3,not_after), updated_at=?4 WHERE id=?1", params![id, not_before, not_after, chrono::Utc::now().timestamp_millis()]).map_err(|error| format!("更新证书有效期失败: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::has_domain_zone;
    use rusqlite::Connection;

    #[test]
    fn matches_domain_zone_only_inside_the_selected_account() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE cloud_assets (account_id INTEGER NOT NULL, resource_type TEXT NOT NULL, asset_key TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(account_id, resource_type, asset_key));").unwrap();
        conn.execute("INSERT INTO cloud_assets(account_id,resource_type,asset_key,payload_json) VALUES(1,'domain','example.com','{\"DomainName\":\"example.com\"}')", []).unwrap();
        assert!(has_domain_zone(&conn, 1, "example.com").unwrap());
        assert!(!has_domain_zone(&conn, 2, "example.com").unwrap());
        assert!(!has_domain_zone(&conn, 1, "other.com").unwrap());
    }
}
