use std::collections::BTreeMap;
use rusqlite::{params, Connection};

pub fn list(conn: &Connection) -> Result<BTreeMap<String, String>, String> {
    let mut statement = conn.prepare("SELECT key, value FROM client_preferences WHERE key NOT LIKE 'cloud.sync.%' AND key NOT LIKE 'cloud.drive.%'").map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).map_err(|error| error.to_string())?;
    rows.map(|row| row.map_err(|error| error.to_string())).collect()
}

pub fn save(conn: &Connection, key: &str, value: &str, now: i64) -> Result<(), String> {
    conn.execute("INSERT INTO client_preferences(key, value, updated_at) VALUES(?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", params![key, value, now])
        .map(|_| ()).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn encrypted_drive_configuration_never_enters_generic_preferences() {
        let db=Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE client_preferences(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)").unwrap();
        for key in ["cloud.drive.connections","cloud.drive.sessions","cloud.sync.config","theme"] {save(&db,key,"opaque",1).unwrap();}
        let values=list(&db).unwrap();assert_eq!(values.len(),1);assert_eq!(values["theme"],"opaque");
        assert!(!crate::core::data_transfer::portable_preference("cloud.drive.connections"));
        assert!(!crate::core::data_transfer::portable_preference("cloud.drive.sessions"));
    }
}
