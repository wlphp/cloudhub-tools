use std::collections::BTreeMap;
use rusqlite::{params, Connection};

pub fn list(conn: &Connection) -> Result<BTreeMap<String, String>, String> {
    let mut statement = conn.prepare("SELECT key, value FROM client_preferences").map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).map_err(|error| error.to_string())?;
    rows.map(|row| row.map_err(|error| error.to_string())).collect()
}

pub fn save(conn: &Connection, key: &str, value: &str, now: i64) -> Result<(), String> {
    conn.execute("INSERT INTO client_preferences(key, value, updated_at) VALUES(?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", params![key, value, now])
        .map(|_| ()).map_err(|error| error.to_string())
}
