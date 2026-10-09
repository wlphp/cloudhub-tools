use crate::core::{repositories::{connections as connection_repository, managed_hosts as managed_host_repository}, storage::{decrypt_secret, open_db}};
use crate::core::error::PlatformResult;
use crate::{SavedRdpConnection, SavedSshConnection};

#[tauri::command]
pub(crate) fn reveal_managed_host_credential(id: i64, kind: String) -> PlatformResult<String> {
    if id <= 0 { return Err("无效的主机标识".into()); }
    if kind != "private_key" && kind != "key_passphrase" { return Err("不支持的凭据类型".into()); }
    let (_, private_key, passphrase) = managed_host_repository::existing_secrets(&open_db()?, id)
        .map_err(|_| "读取主机凭据失败")?.ok_or("主机不存在")?;
    let ciphertext = if kind == "private_key" { private_key } else { passphrase };
    let Some(ciphertext) = ciphertext.filter(|value| !value.is_empty()) else { return Ok(String::new()); };
    decrypt_secret(&ciphertext).map_err(|_| "解密主机凭据失败".into())
}

#[tauri::command]
pub(crate) fn get_ssh_connection(account_id: i64, asset_key: String) -> PlatformResult<Option<SavedSshConnection>> {
    Ok(crate::ssh_saved_connection(account_id, &asset_key)?.map(|saved| SavedSshConnection { host: saved.host, port: saved.port, username: saved.username, password_saved: saved.password_ciphertext.is_some_and(|value| !value.is_empty()) }))
}

#[tauri::command]
pub(crate) fn delete_ssh_connection(account_id: i64, asset_key: String) -> PlatformResult<()> { connection_repository::delete_ssh(&open_db()?, account_id, &asset_key).map_err(Into::into) }

#[tauri::command]
pub(crate) fn get_rdp_connection(target_key: String) -> PlatformResult<Option<SavedRdpConnection>> { connection_repository::rdp_saved(&open_db()?, &target_key).map_err(Into::into) }

#[tauri::command]
pub(crate) fn delete_rdp_connection(target_key: String) -> PlatformResult<()> { connection_repository::delete_rdp(&open_db()?, &target_key).map_err(Into::into) }

#[tauri::command]
pub(crate) fn reveal_ssh_password(account_id: Option<i64>, asset_key: Option<String>, managed_host_id: Option<i64>) -> PlatformResult<String> {
    let ciphertext = if let Some(id) = managed_host_id {
        managed_host_repository::password_ciphertext(&open_db()?, id)?
    } else {
        let account_id = account_id.ok_or("缺少云账号标识")?;
        let asset_key = asset_key.filter(|value| !value.trim().is_empty()).ok_or("缺少服务器标识")?;
        connection_repository::ssh_password_ciphertext(&open_db()?, account_id, &asset_key)?
    };
    let ciphertext = ciphertext.ok_or("当前没有保存 SSH 密码")?;
    Ok(decrypt_secret(&ciphertext)?)
}

#[tauri::command]
pub(crate) fn reveal_rdp_password(target_key: String) -> PlatformResult<String> {
    let ciphertext = connection_repository::rdp_password_ciphertext(&open_db()?, &target_key)?.ok_or("未保存 RDP 密码")?;
    Ok(decrypt_secret(&ciphertext)?)
}
