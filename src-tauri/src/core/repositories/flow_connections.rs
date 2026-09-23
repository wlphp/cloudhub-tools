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
    let saved_id = if let Some(id) = id {
        conn.execute("UPDATE flow_connections SET name=?1,edition=?2,organization_id=?3,domain=?4,token_ciphertext=?5,updated_at=?6 WHERE id=?7", params![name,edition,organization_id,domain,token_ciphertext,now,id]).map_err(|error| error.to_string())?;
        id
    } else {
        conn.execute("INSERT INTO flow_connections(name,edition,organization_id,domain,token_ciphertext,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6)", params![name,edition,organization_id,domain,token_ciphertext,now]).map_err(|error| error.to_string())?;
        conn.last_insert_rowid()
    };
    get(conn, saved_id)
}

pub fn delete(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM flow_connections WHERE id=?1", [id]).map(|_| ()).map_err(|error| error.to_string())
}
