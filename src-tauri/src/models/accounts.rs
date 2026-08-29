use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct CloudAccount {
    pub id: i64,
    pub account_name: String,
    pub cloud_type: String,
    pub group_name: Option<String>,
    pub access_key_id: String,
    pub credential_meta: Option<String>,
    pub region_id: Option<String>,
    pub sort_order: i64,
    pub enabled: bool,
    pub remark: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
pub(crate) struct AccountInput {
    pub id: Option<i64>,
    pub account_name: String,
    pub cloud_type: String,
    pub group_name: Option<String>,
    pub access_key_id: String,
    pub access_key_secret: Option<String>,
    pub region_id: Option<String>,
    pub sort_order: Option<i64>,
    pub credential_meta: Option<String>,
    pub enabled: bool,
    pub remark: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ExportAccount {
    pub account_name: String,
    pub cloud_type: String,
    pub group_name: Option<String>,
    pub access_key_id: String,
    pub access_key_secret: String,
    pub credential_meta: Option<String>,
    pub region_id: Option<String>,
    pub sort_order: i64,
    pub enabled: bool,
    pub remark: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ImportAccount {
    pub account_name: String,
    pub cloud_type: Option<String>,
    pub group_name: Option<String>,
    pub access_key_id: String,
    pub access_key_secret: String,
    pub credential_meta: Option<String>,
    pub region_id: Option<String>,
    pub sort_order: Option<i64>,
    pub enabled: Option<bool>,
    pub remark: Option<String>,
}
