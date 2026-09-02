use crate::core::{repositories::managed_hosts as managed_host_repository, storage::open_db};
use crate::ManagedHost;

#[tauri::command]
pub(crate) fn list_managed_hosts() -> Result<Vec<ManagedHost>, String> { managed_host_repository::list(&open_db()?) }

#[tauri::command]
pub(crate) fn delete_managed_host(id: i64) -> Result<(), String> { managed_host_repository::delete(&open_db()?, id) }
