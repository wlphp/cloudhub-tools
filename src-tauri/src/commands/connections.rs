use crate::core::{repositories::connections as connection_repository, storage::open_db};
use crate::{SavedRdpConnection, SavedSshConnection};

#[tauri::command]
pub(crate) fn get_ssh_connection(account_id: i64, asset_key: String) -> Result<Option<SavedSshConnection>, String> {
    Ok(crate::ssh_saved_connection(account_id, &asset_key)?.map(|saved| SavedSshConnection { host: saved.host, port: saved.port, username: saved.username, password_saved: saved.password_ciphertext.is_some_and(|value| !value.is_empty()) }))
}

#[tauri::command]
pub(crate) fn delete_ssh_connection(account_id: i64, asset_key: String) -> Result<(), String> { connection_repository::delete_ssh(&open_db()?, account_id, &asset_key) }

#[tauri::command]
pub(crate) fn get_rdp_connection(target_key: String) -> Result<Option<SavedRdpConnection>, String> { connection_repository::rdp_saved(&open_db()?, &target_key) }

#[tauri::command]
pub(crate) fn delete_rdp_connection(target_key: String) -> Result<(), String> { connection_repository::delete_rdp(&open_db()?, &target_key) }
