//! Local, bounded IPv4 discovery. No HTTP proxy, cloud lookup or privileged driver.
pub mod discovery;
pub mod fingerprint;
pub mod repository;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Interface {
    pub id: String,
    pub name: String,
    pub ip: String,
    pub prefix: u8,
    pub gateway: String,
    pub network: String,
    pub network_key: String,
    pub suggested_range: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub ip: String,
    pub mac: String,
    pub hostname: String,
    pub vendor: String,
    pub kind: String,
    pub evidence: Vec<String>,
    pub ports: Vec<u16>,
    pub latency_ms: Option<u64>,
    pub last_seen: i64,
    pub alias: String,
    pub note: String,
    pub tags: String,
    pub favorite: bool,
    pub manual_kind: String,
    #[serde(default)]
    pub os: String,
    #[serde(default)]
    pub os_status: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub mac_kind: String,
    #[serde(default)]
    pub manual_os: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    pub id: String,
    pub network_key: String,
    pub interface_id: String,
    pub range: String,
    pub status: String,
    pub completed: usize,
    pub total: usize,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub devices: Vec<Device>,
    pub warnings: Vec<String>,
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn clean(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|c| !c.is_control())
        .take(limit)
        .collect()
}
