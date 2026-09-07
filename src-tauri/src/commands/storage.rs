use crate::account_cloud_type;
use crate::core::error::PlatformResult;
use crate::{OssUploadSelection, OssUploadSelectionStore, validate_object_key};
use std::path::PathBuf;
use serde_json::Value;
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

#[tauri::command]
pub(crate) async fn list_oss_objects(id: i64, bucket: String, location: String, prefix: String, marker: String) -> PlatformResult<Value> {
    if account_cloud_type(id)? == "tencent" { return crate::cloud::tencent::list_objects(id, &bucket, &location, &prefix, &marker).await.map_err(Into::into); }
    crate::cloud::aliyun::list_objects(id, &bucket, &location, &prefix, &marker).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) fn get_oss_object_url(id: i64, bucket: String, location: String, object_key: String) -> PlatformResult<String> {
    Ok(crate::cloud::aliyun::signed_object_url(id, &bucket, &location, &object_key)?)
}

#[tauri::command]
pub(crate) async fn set_oss_public_read(id: i64, bucket: String, location: String) -> PlatformResult<()> {
    crate::cloud::aliyun::set_public_read(id, &bucket, &location).await.map_err(Into::into)
}

fn stage_oss_upload_path(store: tauri::State<'_, OssUploadSelectionStore>, path: PathBuf) -> Result<OssUploadSelection, String> {
    let canonical = path.canonicalize().map_err(|error| format!("读取所选文件失败: {error}"))?;
    let metadata = canonical.metadata().map_err(|error| format!("读取所选文件信息失败: {error}"))?;
    if !metadata.is_file() { return Err("请选择一个本机文件".into()); }
    if metadata.len() > 5 * 1024 * 1024 * 1024 { return Err("单文件上传不能超过 5 GB".into()); }
    let name = canonical.file_name().and_then(|value| value.to_str()).filter(|value| !value.is_empty()).ok_or_else(|| "无法识别文件名".to_string())?.to_string();
    let token = Uuid::new_v4().to_string();
    store.files.lock().map_err(|_| "上传文件选择状态不可用".to_string())?.insert(token.clone(), canonical);
    Ok(OssUploadSelection { token, name, size: metadata.len() })
}

#[tauri::command]
pub(crate) fn select_oss_upload_file(app: tauri::AppHandle, store: tauri::State<'_, OssUploadSelectionStore>) -> PlatformResult<Option<OssUploadSelection>> {
    let Some(selected) = app.dialog().file().blocking_pick_file() else { return Ok(None) };
    let path = selected.into_path().map_err(|_| "当前平台返回了不支持的文件地址".to_string())?;
    stage_oss_upload_path(store, path).map(Some).map_err(Into::into)
}

#[tauri::command]
pub(crate) fn stage_oss_upload_file(store: tauri::State<'_, OssUploadSelectionStore>, source_path: String) -> PlatformResult<OssUploadSelection> {
    stage_oss_upload_path(store, PathBuf::from(source_path)).map_err(Into::into)
}

#[tauri::command]
pub(crate) fn discard_oss_upload_selection(store: tauri::State<'_, OssUploadSelectionStore>, selection_token: String) -> PlatformResult<()> {
    store.files.lock().map_err(|_| "上传文件选择状态不可用".to_string())?.remove(&selection_token);
    Ok(())
}

#[tauri::command]
pub(crate) async fn upload_oss_object(store: tauri::State<'_, OssUploadSelectionStore>, id: i64, bucket: String, location: String, object_key: String, selection_token: String, overwrite: bool) -> PlatformResult<()> {
    validate_object_key(&object_key)?;
    let source_path = store.files.lock().map_err(|_| "上传文件选择状态不可用".to_string())?.remove(&selection_token).ok_or_else(|| "上传文件选择已失效，请重新选择文件".to_string())?;
    if account_cloud_type(id)? != "aliyun" { return Err("当前仅支持阿里云 OSS 文件上传".into()); }
    crate::cloud::aliyun::upload_object(id, &bucket, &location, &object_key, &source_path, overwrite).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn download_oss_object(app: tauri::AppHandle, id: i64, bucket: String, location: String, object_key: String) -> PlatformResult<Option<String>> {
    validate_object_key(&object_key)?;
    if account_cloud_type(id)? != "aliyun" { return Err("当前仅支持阿里云 OSS 文件下载".into()); }
    let suggested_name = object_key.rsplit('/').find(|value| !value.is_empty()).unwrap_or("download").replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_");
    let Some(selected) = app.dialog().file().set_file_name(suggested_name).blocking_save_file() else { return Ok(None) };
    let target_path = selected.into_path().map_err(|_| "当前平台返回了不支持的下载地址".to_string())?;
    crate::cloud::aliyun::download_object(id, &bucket, &location, &object_key, &target_path).await?;
    Ok(Some(target_path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub(crate) async fn download_oss_objects(app: tauri::AppHandle, id: i64, bucket: String, location: String, object_keys: Vec<String>) -> PlatformResult<Option<Vec<String>>> {
    if account_cloud_type(id)? != "aliyun" { return Err("当前仅支持阿里云 OSS 文件下载".into()); }
    if object_keys.is_empty() { return Err("请至少选择一个文件".into()); }
    if object_keys.len() > 50 { return Err("单次最多下载 50 个文件".into()); }
    let mut names = std::collections::HashSet::new();
    for key in &object_keys {
        validate_object_key(key)?;
        let name = key.rsplit('/').find(|value| !value.is_empty()).unwrap_or("download").replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_");
        if !names.insert(name.to_ascii_lowercase()) { return Err("所选文件存在同名目标，无法安全批量下载".into()); }
    }
    let Some(folder) = app.dialog().file().blocking_pick_folder() else { return Ok(None) };
    let folder_path = folder.into_path().map_err(|_| "当前平台返回了不支持的下载目录".to_string())?;
    let mut paths = Vec::with_capacity(object_keys.len());
    for key in object_keys {
        let filename = key.rsplit('/').find(|value| !value.is_empty()).unwrap_or("download").replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_");
        let target = folder_path.join(filename);
        crate::cloud::aliyun::download_object(id, &bucket, &location, &key, &target).await?;
        paths.push(target.to_string_lossy().into_owned());
    }
    Ok(Some(paths))
}

#[tauri::command]
pub(crate) async fn get_oss_acl(id: i64, bucket: String, location: String) -> PlatformResult<String> {
    if account_cloud_type(id)? == "tencent" { return crate::cloud::tencent::get_acl(id, &bucket, &location).await.map_err(Into::into); }
    crate::cloud::aliyun::get_acl(id, &bucket, &location).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn set_oss_cors(id: i64, bucket: String, location: String, origins: String) -> PlatformResult<()> {
    crate::cloud::aliyun::set_cors(id, &bucket, &location, &origins).await.map_err(Into::into)
}
