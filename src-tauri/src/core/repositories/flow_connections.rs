use rusqlite::{params, Connection, OptionalExtension};
use crate::FlowConnection;

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<FlowConnection> {
    Ok(FlowConnection { id: row.get(0)?, name: row.get(1)?, edition: row.get(2)?, organization_id: row.get(3)?, domain: row.get(4)?, token_saved: row.get::<_, Option<String>>(5)?.is_some(), created_at: row.get(6)?, updated_at: row.get(7)? })
}

pub fn list(conn: &Connection) -> Result<Vec<FlowConnection>, String> {
    let mut statement = conn.prepare("SELECT id,name,edition,organization_id,domain,token_ciphertext,created_at,updated_at FROM flow_connections ORDER BY name COLLATE NOCASE").map_err(|error| error.to_string())?;
    let rows = statement.query_map([], row).map_err(|error| error.to_string())?;
    rows.map(|item| item.map_err(|error| error.to_string())).collect()
}

pub fn get(conn: &Connection, id: i64) -> Result<FlowConnection, String> {
    conn.query_row("SELECT id,name,edition,organization_id,domain,token_ciphertext,created_at,updated_at FROM flow_connections WHERE id=?1", [id], row).map_err(|_| "云效连接不存在".to_string())
}

pub fn load_token(conn: &Connection, id: i64) -> Result<(FlowConnection, String), String> {
    let connection = get(conn, id)?;
    let ciphertext = conn.query_row("SELECT token_ciphertext FROM flow_connections WHERE id=?1", [id], |row| row.get(0)).map_err(|_| "云效连接不存在".to_string())?;
    Ok((connection, ciphertext))
}

pub fn existing_token(conn: &Connection, id: i64) -> Result<Option<String>, String> {
    conn.query_row("SELECT token_ciphertext FROM flow_connections WHERE id=?1", [id], |row| row.get(0)).optional().map_err(|error| error.to_string())
}

pub fn save(conn: &Connection, id: Option<i64>, name: &str, edition: &str, organization_id: Option<&str>, domain: &str, token_ciphertext: &str, now: i64) -> Result<FlowConnection, String> {
    let transaction = conn.unchecked_transaction().map_err(|_| "保存云效连接失败")?;
    let conn = &transaction;
    if let Some(id) = id { conn.execute("DELETE FROM flow_pipeline_cache WHERE connection_id=?1", [id]).map_err(|_| "清理流水线缓存失败")?; }
    let saved_id = if let Some(id) = id {
        conn.execute("UPDATE flow_connections SET name=?1,edition=?2,organization_id=?3,domain=?4,token_ciphertext=?5,updated_at=MAX(?6,updated_at+1) WHERE id=?7", params![name,edition,organization_id,domain,token_ciphertext,now,id]).map_err(|error| error.to_string())?;
        id
    } else {
        conn.execute("INSERT INTO flow_connections(name,edition,organization_id,domain,token_ciphertext,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6)", params![name,edition,organization_id,domain,token_ciphertext,now]).map_err(|error| error.to_string())?;
        conn.last_insert_rowid()
    };
    let saved = get(conn, saved_id)?;
    transaction.commit().map_err(|_| "保存云效连接失败")?;
    Ok(saved)
}

pub fn delete(conn: &Connection, id: i64) -> Result<(), String> {
    let transaction = conn.unchecked_transaction().map_err(|_| "删除云效连接失败")?;
    transaction.execute("DELETE FROM flow_pipeline_cache WHERE connection_id=?1", [id]).map_err(|_| "清理流水线缓存失败")?;
    transaction.execute("DELETE FROM flow_connections WHERE id=?1", [id]).map_err(|_| "删除云效连接失败")?;
    transaction.commit().map_err(|_| "删除云效连接失败".into())
}

pub fn load_pipeline_cache(conn: &Connection, id: i64, key: &str) -> Result<Option<(String, i64)>, String> {
    conn.query_row("SELECT payload_ciphertext,updated_at FROM flow_pipeline_cache WHERE connection_id=?1 AND query_key=?2", params![id,key], |row| Ok((row.get(0)?,row.get(1)?)))
        .optional().map_err(|_| "读取流水线缓存失败".into())
}

pub fn save_pipeline_cache(conn: &Connection, id: i64, key: &str, ciphertext: &str, expected_version: i64, now: i64) -> Result<(), String> {
    conn.execute("INSERT INTO flow_pipeline_cache(connection_id,query_key,payload_ciphertext,updated_at)
        SELECT ?1,?2,?3,?4 WHERE EXISTS(SELECT 1 FROM flow_connections WHERE id=?1 AND updated_at=?5)
        ON CONFLICT(connection_id,query_key) DO UPDATE SET payload_ciphertext=excluded.payload_ciphertext,updated_at=excluded.updated_at", params![id,key,ciphertext,now,expected_version])
        .map_err(|_| "保存流水线缓存失败")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_edits_invalidate_cache_and_advance_version_even_with_same_clock() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE flow_connections(id INTEGER PRIMARY KEY,name TEXT,edition TEXT,organization_id TEXT,domain TEXT,token_ciphertext TEXT,created_at INTEGER,updated_at INTEGER);
          CREATE TABLE flow_pipeline_cache(connection_id INTEGER,query_key TEXT,payload_ciphertext TEXT,updated_at INTEGER,PRIMARY KEY(connection_id,query_key));").unwrap();
        let saved = save(&conn, None, "fixture", "central", Some("org-test"), "https://openapi-rdc.aliyuncs.com", "opaque", 7).unwrap();
        save_pipeline_cache(&conn, saved.id, "page", "opaque-cache", 7, 10).unwrap();
        let edited = save(&conn, Some(saved.id), "renamed", "central", Some("org-new"), &saved.domain, "opaque", 7).unwrap();
        assert_eq!(edited.updated_at, 8);
        assert_eq!(load_pipeline_cache(&conn, saved.id, "page").unwrap(), None);
        save_pipeline_cache(&conn, saved.id, "page", "stale", 7, 11).unwrap();
        assert_eq!(load_pipeline_cache(&conn, saved.id, "page").unwrap(), None);
    }

    #[test]
    fn pipeline_cache_is_scoped_and_rejects_stale_connection_versions() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE flow_connections(id INTEGER PRIMARY KEY,updated_at INTEGER); INSERT INTO flow_connections VALUES(1,7),(2,9);
          CREATE TABLE flow_pipeline_cache(connection_id INTEGER,query_key TEXT,payload_ciphertext TEXT,updated_at INTEGER,PRIMARY KEY(connection_id,query_key));").unwrap();
        save_pipeline_cache(&conn, 1, "page-1", "opaque-cache", 7, 100).unwrap();
        assert_eq!(load_pipeline_cache(&conn, 1, "page-1").unwrap(), Some(("opaque-cache".into(),100)));
        assert_eq!(load_pipeline_cache(&conn, 2, "page-1").unwrap(), None);
        assert_eq!(load_pipeline_cache(&conn, 1, "page-2").unwrap(), None);
        save_pipeline_cache(&conn, 1, "page-1", "stale-cache", 6, 200).unwrap();
        assert_eq!(load_pipeline_cache(&conn, 1, "page-1").unwrap(), Some(("opaque-cache".into(),100)));
        delete(&conn, 1).unwrap();
        assert_eq!(load_pipeline_cache(&conn, 1, "page-1").unwrap(), None);
        save_pipeline_cache(&conn, 1, "page-1", "late-cache", 7, 300).unwrap();
        assert_eq!(load_pipeline_cache(&conn, 1, "page-1").unwrap(), None);
    }
}
