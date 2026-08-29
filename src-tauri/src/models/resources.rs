use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize)]
pub(crate) struct ResourceResponse {
    pub(crate) resource_type: String,
    pub(crate) items: Vec<Value>,
    pub(crate) errors: Vec<String>,
    pub(crate) fetched_at: i64,
}

#[derive(Debug, Serialize)]
pub(crate) struct LocalAsset {
    pub(crate) account_id: i64,
    pub(crate) resource_type: String,
    pub(crate) asset_key: String,
    pub(crate) region_id: Option<String>,
    pub(crate) payload: Value,
    pub(crate) fetched_at: i64,
}

#[derive(Debug, Serialize)]
pub(crate) struct AssetSyncResult {
    pub(crate) fetched: usize,
    pub(crate) counts: BTreeMap<String, usize>,
    pub(crate) errors: Vec<String>,
    pub(crate) fetched_at: i64,
}
