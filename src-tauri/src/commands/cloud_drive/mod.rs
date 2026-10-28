mod dependency;
mod model;
mod runtime;
mod service;
mod error;
use error::public_error;

use crate::core::error::PlatformResult;
use tauri::State;
pub use service::{DriveStore, Snapshot, initialize, must_keep_running, explain_exit};

#[tauri::command]
pub async fn cloud_drive_snapshot(state:State<'_,DriveStore>)->PlatformResult<Snapshot> {
    service::cloud_drive_snapshot(state).await.map_err(public_error)
}
#[tauri::command]
pub async fn cloud_drive_install(state:State<'_,DriveStore>)->PlatformResult<()> {
    service::cloud_drive_install(state).await.map_err(public_error)
}
#[tauri::command]
pub async fn cloud_drive_save(state:State<'_,DriveStore>, input:model::Connection, clear_session_token:bool, reuse_saved_credentials:Option<bool>)->PlatformResult<()> {
    service::cloud_drive_save(state,input,clear_session_token,reuse_saved_credentials.unwrap_or(false)).await.map_err(public_error)
}
#[tauri::command]
pub async fn cloud_drive_remove(state:State<'_,DriveStore>, id:String)->PlatformResult<()> {
    service::cloud_drive_remove(state,id).await.map_err(public_error)
}
#[tauri::command]
pub async fn cloud_drive_probe(state:State<'_,DriveStore>, id:String, kind:String)->PlatformResult<Vec<String>> {
    service::cloud_drive_probe(state,id,kind).await.map_err(public_error)
}
#[tauri::command]
pub async fn cloud_drive_list_buckets(input:model::Connection, clear_session_token:bool, reuse_saved_credentials:Option<bool>)->PlatformResult<Vec<String>> {
    service::cloud_drive_list_buckets(input,clear_session_token,reuse_saved_credentials.unwrap_or(false)).await.map_err(public_error)
}
#[tauri::command]
pub async fn cloud_drive_mount(state:State<'_,DriveStore>, id:String)->PlatformResult<()> {
    service::cloud_drive_mount(state,id).await.map_err(public_error)
}
#[tauri::command]
pub async fn cloud_drive_unmount(state:State<'_,DriveStore>, id:String)->PlatformResult<()> {
    service::cloud_drive_unmount(state,id).await.map_err(public_error)
}
#[tauri::command]
pub async fn cloud_drive_suspend(state:State<'_,DriveStore>, id:String)->PlatformResult<()> {
    service::cloud_drive_suspend(state,id).await.map_err(public_error)
}
#[tauri::command]
pub async fn cloud_drive_credentials(state:State<'_,DriveStore>, id:String, access_key_id:String, secret_key:String, session_token:String)->PlatformResult<()> {
    service::cloud_drive_credentials(state,id,access_key_id,secret_key,session_token).await.map_err(public_error)
}
#[tauri::command]
pub async fn cloud_drive_reveal_secret(state:State<'_,DriveStore>, id:String)->PlatformResult<String> {
    service::cloud_drive_reveal_secret(state,id).await.map_err(public_error)
}
#[tauri::command]
pub async fn cloud_drive_clear_recovery(state:State<'_,DriveStore>, id:String)->PlatformResult<()> {
    service::cloud_drive_clear_recovery(state,id).await.map_err(public_error)
}
#[tauri::command]
pub async fn cloud_drive_open(app:tauri::AppHandle, state:State<'_,DriveStore>, id:String)->PlatformResult<()> {
    service::cloud_drive_open(app,state,id).await.map_err(public_error)
}
#[tauri::command]
pub async fn cloud_drive_select_cache(app:tauri::AppHandle)->PlatformResult<Option<String>> {
    service::cloud_drive_select_cache(app).await.map_err(public_error)
}
#[tauri::command]
pub fn cloud_drive_winfsp(app:tauri::AppHandle)->PlatformResult<()> {
    service::cloud_drive_winfsp(app).map_err(public_error)
}
