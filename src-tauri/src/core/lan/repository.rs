use super::{Device, Scan};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

// Local-only tables, intentionally absent from sync triggers and cloud exports.
const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS lan_devices(network_key TEXT NOT NULL,device_key TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(network_key,device_key)); CREATE TABLE IF NOT EXISTS lan_scans(id TEXT PRIMARY KEY,network_key TEXT NOT NULL,started_at INTEGER NOT NULL,json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS lan_scans_network ON lan_scans(network_key,started_at DESC);";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub network_key: String,
    pub device_key: String,
    pub alias: String,
    pub note: String,
    pub tags: String,
    pub favorite: bool,
    pub manual_kind: String,
    #[serde(default)]
    pub manual_os: String,
}

pub fn validate_network(key: &str) -> Result<(), String> {
    if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("网络档案标识无效".into());
    }
    Ok(())
}
pub fn device_key(d: &Device) -> String {
    if d.mac.is_empty() {
        format!("ip:{}", d.ip)
    } else {
        format!("mac:{}", d.mac)
    }
}
fn ensure(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(SCHEMA)
        .map_err(|_| "初始化局域网台账失败".into())
}

pub fn devices(conn: &Connection, network: &str) -> Result<Vec<Device>, String> {
    validate_network(network)?;
    ensure(conn)?;
    let mut statement = conn
        .prepare("SELECT json FROM lan_devices WHERE network_key=?1 LIMIT 4096")
        .map_err(|_| "读取设备台账失败")?;
    let rows = statement
        .query_map([network], |r| r.get::<_, String>(0))
        .map_err(|_| "读取设备台账失败")?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(|_| "读取设备台账失败")?)
            .map_err(|_| "设备台账内容无效".into())
    })
    .collect()
}
pub fn history(conn: &Connection, network: &str) -> Result<Vec<Scan>, String> {
    validate_network(network)?;
    ensure(conn)?;
    let mut statement = conn
        .prepare(
            "SELECT json FROM lan_scans WHERE network_key=?1 ORDER BY started_at DESC LIMIT 20",
        )
        .map_err(|_| "读取扫描历史失败")?;
    let rows = statement
        .query_map([network], |r| r.get::<_, String>(0))
        .map_err(|_| "读取扫描历史失败")?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(|_| "读取扫描历史失败")?)
            .map_err(|_| "扫描历史内容无效".into())
    })
    .collect()
}
pub fn save_scan(conn: &mut Connection, scan: &Scan) -> Result<(), String> {
    validate_network(&scan.network_key)?;
    ensure(conn)?;
    let tx = conn.transaction().map_err(|_| "保存扫描事务失败")?;
    let existing = devices(&tx, &scan.network_key)?;
    for found in &scan.devices {
        let mut d = found.clone();
        if let Some(previous) = existing.iter().find(|p| device_key(p) == device_key(&d)) {
            d.alias = previous.alias.clone();
            d.note = previous.note.clone();
            d.tags = previous.tags.clone();
            d.favorite = previous.favorite;
            d.manual_kind = previous.manual_kind.clone();
            d.manual_os = previous.manual_os.clone();
        }
        tx.execute("INSERT INTO lan_devices(network_key,device_key,json) VALUES(?1,?2,?3) ON CONFLICT(network_key,device_key) DO UPDATE SET json=excluded.json", params![scan.network_key, device_key(&d), serde_json::to_string(&d).map_err(|_| "设备序列化失败")?]).map_err(|_| "保存设备台账失败")?;
    }
    tx.execute(
        "INSERT INTO lan_scans(id,network_key,started_at,json) VALUES(?1,?2,?3,?4)",
        params![
            scan.id,
            scan.network_key,
            scan.started_at,
            serde_json::to_string(scan).map_err(|_| "扫描记录序列化失败")?
        ],
    )
    .map_err(|_| "保存扫描历史失败")?;
    tx.execute("DELETE FROM lan_scans WHERE network_key=?1 AND id NOT IN (SELECT id FROM lan_scans WHERE network_key=?1 ORDER BY started_at DESC LIMIT 20)", [&scan.network_key]).map_err(|_| "整理扫描历史失败")?;
    tx.execute("DELETE FROM lan_devices WHERE network_key=?1 AND device_key NOT IN (SELECT device_key FROM lan_devices WHERE network_key=?1 ORDER BY json_extract(json,'$.favorite') DESC,json_extract(json,'$.lastSeen') DESC LIMIT 4096)", [&scan.network_key]).map_err(|_| "整理设备台账失败")?;
    tx.commit().map_err(|_| "提交扫描记录失败".into())
}
pub fn annotate(conn: &Connection, input: &Annotation) -> Result<(), String> {
    validate_network(&input.network_key)?;
    if input.alias.chars().count() > 80
        || input.note.chars().count() > 1000
        || input.tags.chars().count() > 160
        || input.manual_kind.chars().count() > 40
        || input.manual_os.chars().count() > 80
        || [
            &input.alias,
            &input.note,
            &input.tags,
            &input.manual_kind,
            &input.manual_os,
        ]
        .iter()
        .any(|s| s.contains('\0'))
    {
        return Err("别名、备注、标签或类型超过长度限制".into());
    }
    let mut d = devices(conn, &input.network_key)?
        .into_iter()
        .find(|d| device_key(d) == input.device_key)
        .ok_or("设备记录不存在，请等待扫描保存后重试")?;
    d.alias = input.alias.trim().into();
    d.note = input.note.trim().into();
    d.tags = input.tags.trim().into();
    d.favorite = input.favorite;
    d.manual_kind = input.manual_kind.trim().into();
    d.manual_os = input.manual_os.trim().into();
    conn.execute(
        "UPDATE lan_devices SET json=?3 WHERE network_key=?1 AND device_key=?2",
        params![
            input.network_key,
            input.device_key,
            serde_json::to_string(&d).map_err(|_| "设备序列化失败")?
        ],
    )
    .map_err(|_| "保存设备备注失败")?;
    Ok(())
}

pub fn csv_cell(value: &str) -> String {
    // Neutralize spreadsheet formula injection even after leading whitespace.
    let prefix = if value.trim_start().starts_with(['=', '+', '-', '@'])
        || value.starts_with(['\t', '\r', '\n'])
    {
        "'"
    } else {
        ""
    };
    format!("\"{prefix}{}\"", value.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scan(network: &str, id: &str, mac: &str) -> Scan {
        Scan {
            id: id.into(),
            network_key: network.into(),
            interface_id: "1".into(),
            range: "192.168.1.7".into(),
            status: "completed".into(),
            completed: 1,
            total: 1,
            started_at: 1,
            finished_at: Some(2),
            devices: vec![Device {
                ip: "192.168.1.7".into(),
                mac: mac.into(),
                last_seen: 2,
                ..Device::default()
            }],
            warnings: vec![],
        }
    }
    #[test]
    fn network_isolation_annotations_history_and_mac_replacement() {
        let mut conn = Connection::open_in_memory().unwrap();
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        save_scan(&mut conn, &scan(&a, "1", "00:11:22:33:44:55")).unwrap();
        annotate(
            &conn,
            &Annotation {
                network_key: a.clone(),
                device_key: "mac:00:11:22:33:44:55".into(),
                alias: "NAS".into(),
                note: "保留".into(),
                tags: "办公".into(),
                favorite: true,
                manual_kind: "NAS".into(),
                manual_os: "Linux".into(),
            },
        )
        .unwrap();
        save_scan(&mut conn, &scan(&a, "2", "00:11:22:33:44:55")).unwrap();
        assert_eq!(devices(&conn, &a).unwrap()[0].alias, "NAS");
        assert_eq!(devices(&conn, &a).unwrap()[0].manual_os, "Linux");
        save_scan(&mut conn, &scan(&b, "3", "00:11:22:33:44:55")).unwrap();
        assert!(devices(&conn, &b).unwrap()[0].alias.is_empty());
        save_scan(&mut conn, &scan(&a, "4", "00:11:22:33:44:66")).unwrap();
        assert_eq!(devices(&conn, &a).unwrap().len(), 2);
        for n in 5..30 {
            save_scan(&mut conn, &scan(&a, &n.to_string(), "00:11:22:33:44:55")).unwrap();
        }
        assert_eq!(history(&conn, &a).unwrap().len(), 20);
        assert_eq!(history(&conn, &b).unwrap().len(), 1);
    }
    #[test]
    fn spreadsheet_cells_are_safe() {
        assert_eq!(csv_cell(" =1+1"), "\"' =1+1\"");
        assert_eq!(csv_cell("a\"b"), "\"a\"\"b\"");
    }
    #[test]
    fn legacy_records_load_without_fingerprint_fields() {
        let mut json = serde_json::to_value(Device::default()).unwrap();
        for field in ["os", "osStatus", "model", "macKind", "manualOs"] {
            json.as_object_mut().unwrap().remove(field);
        }
        let old: Device = serde_json::from_value(json).unwrap();
        assert!(old.os.is_empty());
        assert!(old.manual_os.is_empty());
    }
}
