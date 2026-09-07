use crate::core::{repositories::assets as asset_repository, storage::open_db};
use crate::LocalAsset;

use crate::core::error::PlatformResult;

#[tauri::command]
pub(crate) fn list_local_assets(account_id: Option<i64>, resource_type: Option<String>) -> PlatformResult<Vec<LocalAsset>> {
    Ok(asset_repository::list(&open_db()?, account_id, resource_type.as_deref())?)
}

#[tauri::command]
pub(crate) fn delete_local_asset(account_id: i64, resource_type: String, asset_key: String) -> PlatformResult<()> {
    if account_id <= 0 || resource_type.trim().is_empty() || asset_key.trim().is_empty() { return Err("缺少本地资产标识".into()); }
    Ok(asset_repository::delete(&open_db()?, account_id, &resource_type, &asset_key)?)
}
