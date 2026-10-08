use crate::{core::{error::PlatformResult, repositories::sync::{account_sync_ids_by_local_ids, managed_host_sync_ids_by_local_ids, panel_sync_ids_by_local_ids, acknowledge, apply_sync_delta, build_account_bundle, build_config_snapshot, build_pending_delta, find_bundle_conflicts, import_account_bundle, preview_bundle_deletions, preview_delta_version_conflicts, sync_delta_signing_bytes, SyncAccountBundle, SyncBundleConflict, SyncConfigSnapshot, SyncDeletionPreview, SyncDeltaBundle, SyncDeltaConflictResolution, SyncSelection}}, decrypt_secret};
use crate::core::crypto::{open_sync_payload, seal_sync_payload, SyncEnvelope};
use crate::core::sync_identity::{bind_local_identity, new_signing_seed, reset_after_identity_loss, sign_pairing_request, sign_sync_ack, sign_sync_delta, verify_pairing_request, verify_sync_ack, verify_sync_delta, LocalSyncIdentity};
#[cfg(not(mobile))]
use crate::core::sync_identity::IDENTITY_SEED_PREFERENCE;
use crate::core::storage::open_db;
use base64::{engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD}, Engine as _};
use chrono::Utc;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Digest;
use uuid::Uuid;
#[cfg(not(mobile))]
use std::fs;
#[cfg(mobile)]
use std::io::Write;
use std::{net::{Ipv4Addr, UdpSocket}, sync::{Arc, Mutex}, time::Duration};
use tauri::{AppHandle, Emitter, State};
use zeroize::Zeroizing;
use tauri_plugin_dialog::DialogExt;
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::{TcpListener, TcpStream}};
use tokio::sync::oneshot;
use tokio::time::Instant;

#[derive(Default)]
pub(crate) struct SyncTransferStore {
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    pending_approval: Arc<Mutex<Option<PendingSyncApproval>>>,
    pending_push_approval: Arc<Mutex<Option<oneshot::Sender<bool>>>>,
    pending_push_ack: Arc<Mutex<Option<PendingSyncPushAck>>>,
    received_delta: Arc<Mutex<Option<SyncEnvelope>>>,
    pending_qr_import: Mutex<Option<PendingQrImport>>,
}

struct PendingSyncApproval { sender: oneshot::Sender<bool>, client: VerifiedTransferClient, scope: Vec<(String, String)> }
struct PendingSyncPushAck { source_device_id: String, envelope_hash: [u8; 32], expected_message_ids: Option<Vec<String>>, sender: oneshot::Sender<SyncDeltaApplyResult> }
struct PendingQrImport { session_id: String, bundle: Zeroizing<SyncAccountBundle>, created_at: Instant }

#[tauri::command]
pub(crate) fn get_sync_device_identity(app: AppHandle) -> PlatformResult<LocalSyncIdentity> {
    let mut conn = open_db()?;
    let (device_id, public_key): (String, Option<Vec<u8>>) = conn.query_row(
        "SELECT device_id,public_key FROM sync_local_device WHERE id=1", [],
        |row| Ok((row.get(0)?,row.get(1)?)),
    ).map_err(|error| format!("读取本机同步设备身份失败: {error}"))?;
    let mut seed = load_sync_signing_seed(&app, &conn)?;
    if seed.is_none() {
        if public_key.is_some() { reset_after_identity_loss(&mut conn, Utc::now().timestamp_millis())?; }
        let generated = new_signing_seed();
        store_sync_signing_seed(&app, &mut conn, &generated)?;
        seed = load_sync_signing_seed(&app, &conn)?;
    }
    let seed = Zeroizing::new(seed.ok_or_else(|| "未能从本机安全存储读取同步身份密钥".to_string())?);
    let identity = bind_local_identity(&mut conn, &seed, Utc::now().timestamp_millis())?;
    if public_key.is_none() && identity.device_id != device_id {
        return Err("本机同步身份已轮换，请重新打开同步页面".into());
    }
    Ok(identity)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncTrustedDevice {
    device_id: String,
    device_name: String,
    status: String,
    public_key_fingerprint: String,
    shared_entities: Vec<SyncDeviceScopeEntry>,
    approved_at: Option<i64>,
    last_seen_at: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncDeviceScopeEntry {
    entity_type: String,
    entity_sync_id: String,
    display_name: String,
}

#[tauri::command]
pub(crate) fn list_sync_devices() -> PlatformResult<Vec<SyncTrustedDevice>> {
    let conn = open_db()?;
    list_sync_devices_from(&conn).map_err(Into::into)
}

/// Allows the current device to explicitly select which local configurations it
/// shares back with one already trusted peer.
#[tauri::command]
pub(crate) fn set_sync_device_share_scope(
    device_id: String, account_ids: Vec<i64>, managed_host_ids: Vec<i64>, panel_ids: Vec<i64>, include_deletions: bool,
) -> PlatformResult<usize> {
    let scope = resolve_device_share_scope(&account_ids, &managed_host_ids, &panel_ids, include_deletions)?;
    let mut conn = open_db()?;
    let transaction = conn.transaction().map_err(|_| "无法更新设备共享范围")?;
    let local_id: String = transaction.query_row("SELECT device_id FROM sync_local_device WHERE id=1", [], |row| row.get(0)).map_err(|_| "无法读取本机同步身份")?;
    if device_id == local_id { return Err("不能向本机设置同步共享范围".into()); }
    let trusted: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM sync_devices WHERE device_id=?1 AND status='trusted')", [&device_id], |row| row.get(0)).map_err(|_| "无法检查目标设备授权")?;
    if !trusted { return Err("目标设备未获同步授权".into()); }
    transaction.execute("DELETE FROM sync_device_scope WHERE peer_device_id=?1", [&device_id]).map_err(|_| "无法清理旧共享范围")?;
    let now = Utc::now().timestamp_millis();
    for (entity_type, sync_id) in &scope {
        transaction.execute("INSERT INTO sync_device_scope(peer_device_id,entity_type,entity_sync_id,granted_at) VALUES(?1,?2,?3,?4)", rusqlite::params![device_id,entity_type,sync_id,now]).map_err(|_| "无法保存设备共享范围")?;
    }
    transaction.commit().map_err(|_| "无法提交设备共享范围")?;
    Ok(scope.len())
}

fn list_sync_devices_from(conn: &rusqlite::Connection) -> Result<Vec<SyncTrustedDevice>, String> {
    let mut statement = conn.prepare("SELECT device_id,device_name,status,public_key,approved_at,last_seen_at FROM sync_devices ORDER BY CASE status WHEN 'trusted' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,device_name,device_id").map_err(|_| "无法读取已配对设备".to_string())?;
    let rows = statement.query_map([], |row| {
        let key: Vec<u8> = row.get(3)?;
        let fingerprint = hex::encode(&sha2::Sha256::digest(&key)[..8]);
        Ok(SyncTrustedDevice {
            device_id: row.get(0)?, device_name: row.get(1)?, status: row.get(2)?,
            public_key_fingerprint: fingerprint, shared_entities: Vec::new(), approved_at: row.get(4)?, last_seen_at: row.get(5)?,
        })
    }).map_err(|_| "无法读取已配对设备".to_string())?;
    let mut devices = rows.collect::<Result<Vec<_>, _>>().map_err(|_| "设备授权记录格式无效".to_string())?;
    drop(statement);
    for device in &mut devices {
        let mut scope_statement = conn.prepare("SELECT s.entity_type,s.entity_sync_id,CASE s.entity_type WHEN 'cloud_account' THEN COALESCE((SELECT account_name FROM cloud_accounts WHERE sync_id=s.entity_sync_id),'已删除配置') WHEN 'managed_host' THEN COALESCE((SELECT name FROM managed_hosts WHERE sync_id=s.entity_sync_id),'已删除配置') WHEN 'panel_connection' THEN COALESCE((SELECT name FROM panel_connections WHERE sync_id=s.entity_sync_id),'已删除配置') ELSE '未知配置' END FROM sync_device_scope s WHERE s.peer_device_id=?1 ORDER BY s.entity_type,s.entity_sync_id").map_err(|_| "无法读取设备共享范围".to_string())?;
        let scope_rows = scope_statement.query_map([&device.device_id], |row| Ok(SyncDeviceScopeEntry {
            entity_type: row.get(0)?, entity_sync_id: row.get(1)?, display_name: row.get(2)?,
        })).map_err(|_| "无法读取设备共享范围".to_string())?;
        device.shared_entities = scope_rows.collect::<Result<Vec<_>, _>>().map_err(|_| "设备共享范围格式无效".to_string())?;
    }
    Ok(devices)
}

#[tauri::command]
pub(crate) fn revoke_sync_device(device_id: String) -> PlatformResult<()> {
    if Uuid::parse_str(&device_id).is_err() { return Err("设备 ID 格式无效".into()); }
    let mut conn = open_db()?;
    revoke_sync_device_in(&mut conn, &device_id, Utc::now().timestamp_millis()).map_err(Into::into)
}

/// Accepts delivery acknowledgements only when signed by the currently trusted
/// destination device and bound to this sender's identity and message IDs.
#[tauri::command]
pub(crate) fn acknowledge_sync_delta(peer_device_id: String, message_ids: Vec<String>, signature: String) -> PlatformResult<usize> {
    acknowledge_sync_delta_for_peer(&peer_device_id, &message_ids, &signature).map_err(Into::into)
}

fn acknowledge_sync_delta_for_peer(peer_device_id: &str, message_ids: &[String], signature: &str) -> Result<usize, String> {
    use rusqlite::OptionalExtension;
    if Uuid::parse_str(peer_device_id).is_err() { return Err("设备 ID 格式无效".into()); }
    if message_ids.is_empty() || message_ids.len() > 100 || message_ids.iter().any(|id| Uuid::parse_str(id).is_err()) { return Err("同步回执批次大小或消息 ID 无效".into()); }
    let signature: [u8; 64] = STANDARD.decode(signature).map_err(|_| "同步回执签名格式无效")?.try_into().map_err(|_| "同步回执签名长度无效")?;
    let mut conn = open_db()?;
    let local_device_id: String = conn.query_row("SELECT device_id FROM sync_local_device WHERE id=1", [], |row| row.get(0)).map_err(|_| "无法读取本机同步身份")?;
    let peer: Option<(Vec<u8>, String)> = conn.query_row("SELECT public_key,status FROM sync_devices WHERE device_id=?1", [peer_device_id], |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(|_| "无法读取回执设备授权")?;
    let Some((public_key, status)) = peer else { return Err("回执设备未获同步授权".into()) };
    if status != "trusted" { return Err("回执设备授权已撤销".into()); }
    let public_key: [u8; 32] = public_key.try_into().map_err(|_| "回执设备公钥格式无效")?;
    if !verify_sync_ack(&public_key, &signature, &local_device_id, peer_device_id, message_ids) {
        return Err("同步回执签名验证失败".into());
    }
    acknowledge(&mut conn, peer_device_id, message_ids, Utc::now().timestamp_millis())
}

/// Returns a signed receipt through the short-lived LAN session that delivered
/// its delta. The sender still checks the live device grant and signature.
#[tauri::command]
pub(crate) async fn send_sync_delta_ack_lan(app: AppHandle, pairing_url: String, acknowledgement: SyncDeltaApplyResult) -> PlatformResult<usize> {
    if acknowledgement.message_ids.is_empty() || acknowledgement.message_ids.len() > 100
        || acknowledgement.message_ids.iter().any(|id| Uuid::parse_str(id).is_err()) {
        return Err("同步回执批次大小或消息 ID 无效".into());
    }
    let mut url = parse_pairing_url(&pairing_url)?;
    let (source_device_id, qr_public_key, _) = parse_pairing_source(&url)?;
    if acknowledgement.source_device_id != source_device_id { return Err("回执来源与本次局域网会话不匹配".into()); }
    let local_identity = get_sync_device_identity(app)?;
    if acknowledgement.receiver_device_id != local_identity.device_id { return Err("回执接收设备与本机身份不匹配".into()); }
    let signature: [u8; 64] = STANDARD.decode(&acknowledgement.signature).map_err(|_| "同步回执签名格式无效")?.try_into().map_err(|_| "同步回执签名长度无效")?;
    let conn = open_db()?;
    let (source_key, status): (Vec<u8>, String) = conn.query_row("SELECT public_key,status FROM sync_devices WHERE device_id=?1", [&source_device_id], |row| Ok((row.get(0)?,row.get(1)?))).map_err(|_| "本机尚未信任二维码中的电脑")?;
    if status != "trusted" || source_key.as_slice() != qr_public_key { return Err("二维码来源设备未获信任或身份已变化".into()); }
    let local_key: Vec<u8> = conn.query_row("SELECT public_key FROM sync_local_device WHERE id=1", [], |row| row.get(0)).map_err(|_| "无法读取本机同步公钥")?;
    let local_key: [u8; 32] = local_key.try_into().map_err(|_| "本机同步公钥格式无效")?;
    if !verify_sync_ack(&local_key, &signature, &source_device_id, &local_identity.device_id, &acknowledgement.message_ids) {
        return Err("回执签名与本机身份不匹配".into());
    }
    let token = url.path().strip_prefix("/v1/transfer/").ok_or("局域网会话路径无效")?;
    url.set_path(&format!("/v1/transfer/{token}/ack"));
    url.set_fragment(None);
    let ids = acknowledgement.message_ids.join(",");
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(15)).build().map_err(|_| "无法初始化局域网回执传输")?;
    let response = client.post(url)
        .header("x-cloudhub-device-id", &local_identity.device_id)
        .header("x-cloudhub-message-ids", ids)
        .header("x-cloudhub-ack-signature", acknowledgement.signature)
        .body(Vec::new()).send().await.map_err(|_| "电脑端局域网回执会话已关闭；可改用签名文件回传")?;
    if !response.status().is_success() { return Err("电脑拒绝了局域网回执；可改用签名文件回传".into()); }
    let conn = open_db()?;
    delete_pending_acknowledgement(&conn, &acknowledgement.source_device_id, &acknowledgement.message_ids)
        .map_err(|_| "电脑已确认回执，但无法清理本机待回传副本".to_string())?;
    Ok(acknowledgement.message_ids.len())
}

fn revoke_sync_device_in(conn: &mut rusqlite::Connection, device_id: &str, now: i64) -> Result<(), String> {
    if Uuid::parse_str(device_id).is_err() { return Err("设备 ID 格式无效".into()); }
    let transaction = conn.transaction().map_err(|_| "无法修改设备授权")?;
    let local_id: String = transaction.query_row("SELECT device_id FROM sync_local_device WHERE id=1", [], |row| row.get(0)).map_err(|_| "无法读取本机设备身份")?;
    if device_id == local_id { return Err("不能撤销本机设备自身".into()); }
    let changed = transaction.execute("UPDATE sync_devices SET status='revoked',revoked_at=?2 WHERE device_id=?1 AND status IN ('trusted','pending')", rusqlite::params![device_id,now]).map_err(|_| "无法撤销设备授权")?;
    if changed != 1 { return Err("设备不存在或已撤销".into()); }
    transaction.commit().map_err(|_| "无法提交设备撤销")?;
    Ok(())
}

#[cfg(mobile)]
fn load_sync_signing_seed<R: tauri::Runtime>(app: &AppHandle<R>, _conn: &rusqlite::Connection) -> PlatformResult<Option<[u8; 32]>> {
    Ok(tauri_plugin_cloudhub_keystore::load_sync_identity_seed(app)
        .map_err(|_| "无法访问手机系统中的同步身份密钥".to_string())?
        .map(|seed| seed.try_into().map_err(|_| "手机同步身份密钥长度无效".to_string()))
        .transpose()?)
}

#[cfg(not(mobile))]
fn load_sync_signing_seed<R: tauri::Runtime>(_app: &AppHandle<R>, conn: &rusqlite::Connection) -> PlatformResult<Option<[u8; 32]>> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use rusqlite::OptionalExtension;
    let ciphertext: Option<String> = conn.query_row("SELECT value FROM client_preferences WHERE key=?1", [IDENTITY_SEED_PREFERENCE], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
    Ok(ciphertext.map(|value| {
        let plaintext = decrypt_secret(&value)?;
        let bytes = STANDARD.decode(plaintext).map_err(|_| "桌面同步身份密钥格式无效".to_string())?;
        bytes.try_into().map_err(|_| "桌面同步身份密钥长度无效".to_string())
    }).transpose()?)
}

#[cfg(mobile)]
fn store_sync_signing_seed<R: tauri::Runtime>(app: &AppHandle<R>, _conn: &mut rusqlite::Connection, seed: &[u8; 32]) -> PlatformResult<()> {
    Ok(tauri_plugin_cloudhub_keystore::store_sync_identity_seed(app, seed).map_err(|_| "无法将同步身份密钥写入手机系统安全存储".to_string())?)
}

#[cfg(not(mobile))]
fn store_sync_signing_seed<R: tauri::Runtime>(_app: &AppHandle<R>, conn: &mut rusqlite::Connection, seed: &[u8; 32]) -> PlatformResult<()> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let ciphertext = crate::core::crypto::encrypt_secret(&STANDARD.encode(seed))?;
    conn.execute("INSERT INTO client_preferences(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO NOTHING", rusqlite::params![IDENTITY_SEED_PREFERENCE,ciphertext,Utc::now().timestamp_millis()]).map_err(|error| error.to_string())?;
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncTransferRequest {
    client_address: String,
    verification_code: String,
    device_id: String,
    public_key_fingerprint: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncTransferFetchResult {
    session_id: String,
    preview: SyncImportPreview,
    source_device_id: String,
    source_public_key_fingerprint: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncTransferStartResult {
    pairing_url: String,
    source_device_id: String,
    source_public_key_fingerprint: String,
}

#[derive(Clone)]
struct VerifiedTransferClient { verification_code: String, device_id: String, public_key: [u8; 32] }

fn build_encrypted_bundle(account_ids: Vec<i64>, managed_host_ids: Vec<i64>, panel_ids: Vec<i64>, passphrase: &str, include_deletions: bool) -> PlatformResult<SyncEnvelope> {
    let mut conn = open_db()?;
    let account_sync_ids = if account_ids.is_empty() { Vec::new() } else { account_sync_ids_by_local_ids(&mut conn, &account_ids)? };
    let managed_host_sync_ids = managed_host_sync_ids_by_local_ids(&mut conn, &managed_host_ids)?;
    let panel_sync_ids = panel_sync_ids_by_local_ids(&conn, &panel_ids)?;
    let mut bundle = Zeroizing::new(build_account_bundle(&mut conn, &account_sync_ids, &managed_host_sync_ids, &panel_sync_ids, include_deletions)?);
    if bundle.accounts.len() + bundle.managed_hosts.len() + bundle.panels.len() + bundle.deletions.len() > 100 {
        return Err("单次迁移最多支持 100 条配置".into());
    }
    for account in &mut bundle.accounts {
        account.access_key_secret = decrypt_secret(&account.access_key_secret)?;
    }
    for host in &mut bundle.managed_hosts {
        host.password = host.password.as_deref().filter(|value| !value.is_empty()).map(decrypt_secret).transpose()?;
        host.private_key = host.private_key.as_deref().filter(|value| !value.is_empty()).map(decrypt_secret).transpose()?;
        host.key_passphrase = host.key_passphrase.as_deref().filter(|value| !value.is_empty()).map(decrypt_secret).transpose()?;
    }
    for panel in &mut bundle.panels { panel.api_key = decrypt_secret(&panel.api_key)?; }
    seal_sync_payload(&*bundle, passphrase).map_err(Into::into)
}

/// Creates a target-device-scoped encrypted outbox batch. Credentials are
/// decrypted and serialized only in Rust; the command returns ciphertext.
#[tauri::command]
pub(crate) fn create_sync_delta_bundle(app: AppHandle, target_device_id: String, after_sequence: i64, limit: usize, passphrase: String) -> PlatformResult<SyncEnvelope> {
    if passphrase.is_empty() { return Err("请输入同步口令".into()); }
    let passphrase = Zeroizing::new(passphrase);
    get_sync_device_identity(app.clone())?;
    let mut conn = open_db()?;
    let mut delta = Zeroizing::new(build_pending_delta(&mut conn, &target_device_id, after_sequence, limit)?);
    for account in &mut delta.snapshot.accounts { account.access_key_secret = decrypt_secret(&account.access_key_secret)?; }
    for host in &mut delta.snapshot.managed_hosts {
        host.password = host.password.as_deref().filter(|value| !value.is_empty()).map(decrypt_secret).transpose()?;
        host.private_key = host.private_key.as_deref().filter(|value| !value.is_empty()).map(decrypt_secret).transpose()?;
        host.key_passphrase = host.key_passphrase.as_deref().filter(|value| !value.is_empty()).map(decrypt_secret).transpose()?;
    }
    for panel in &mut delta.snapshot.panels { panel.api_key = decrypt_secret(&panel.api_key)?; }
    let signing_seed = Zeroizing::new(load_sync_signing_seed(&app, &conn)?.ok_or("本机同步身份密钥不可用")?);
    let signed_bytes = Zeroizing::new(sync_delta_signing_bytes(&delta)?);
    delta.signature = Some(STANDARD.encode(sign_sync_delta(&signing_seed, &delta.source_device_id, &delta.target_device_id, &signed_bytes)?));
    seal_sync_payload(&*delta, passphrase.as_str()).map_err(Into::into)
}

#[tauri::command]
pub(crate) fn save_sync_delta_bundle_file(app: AppHandle, target_device_id: String, after_sequence: i64, limit: usize, passphrase: String) -> PlatformResult<bool> {
    let envelope = create_sync_delta_bundle(app.clone(), target_device_id, after_sequence, limit, passphrase)?;
    let filename = format!("cloudhub-delta-{}.chdelta.json", Utc::now().format("%Y%m%d-%H%M%S"));
    let Some(selected) = app.dialog().file().set_file_name(filename).add_filter("CloudHub 签名增量", &["json"]).blocking_save_file() else { return Ok(false) };
    let bytes = serde_json::to_vec(&envelope).map_err(|_| "签名增量文件序列化失败")?;
    #[cfg(mobile)]
    {
        use tauri_plugin_fs::FsExt;
        let mut options = tauri_plugin_fs::OpenOptions::new();
        options.read(false).write(true).create(true).truncate(true);
        let mut file = app.fs().open(selected, options).map_err(|_| "无法打开系统选择的增量文件位置")?;
        file.write_all(&bytes).map_err(|_| "无法保存增量文件，请检查设备存储空间")?;
    }
    #[cfg(not(mobile))]
    {
        let path = selected.into_path().map_err(|_| "当前平台返回了不支持的导出位置".to_string())?;
        fs::write(path, bytes).map_err(|_| "无法保存增量文件，请检查所选位置和设备存储空间")?;
    }
    Ok(true)
}

/// Saves a receiver-generated signed acknowledgement using the mobile system
/// document picker so the user can share it back to the sender.
#[tauri::command]
pub(crate) fn save_sync_acknowledgement_file(app: AppHandle, acknowledgement: SyncDeltaApplyResult) -> PlatformResult<bool> {
    if Uuid::parse_str(&acknowledgement.source_device_id).is_err() || Uuid::parse_str(&acknowledgement.receiver_device_id).is_err()
        || acknowledgement.message_ids.is_empty() || acknowledgement.message_ids.len() > 100 {
        return Err("同步回执字段无效".into());
    }
    let signature: [u8; 64] = STANDARD.decode(&acknowledgement.signature).map_err(|_| "同步回执签名格式无效")?.try_into().map_err(|_| "同步回执签名长度无效")?;
    let conn = open_db()?;
    let (local_id, public_key): (String, Vec<u8>) = conn.query_row("SELECT device_id,public_key FROM sync_local_device WHERE id=1", [], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|_| "无法读取本机同步身份")?;
    let public_key: [u8; 32] = public_key.try_into().map_err(|_| "本机同步公钥格式无效")?;
    if local_id != acknowledgement.receiver_device_id || !verify_sync_ack(&public_key, &signature, &acknowledgement.source_device_id, &local_id, &acknowledgement.message_ids) {
        return Err("同步回执签名与本机身份不匹配".into());
    }
    for message_id in &acknowledgement.message_ids { if Uuid::parse_str(message_id).is_err() { return Err("同步回执消息 ID 无效".into()); } }
    let filename = format!("cloudhub-ack-{}.chack.json", Utc::now().format("%Y%m%d-%H%M%S"));
    let Some(selected) = app.dialog().file().set_file_name(filename).add_filter("CloudHub 签名回执", &["json"]).blocking_save_file() else { return Ok(false) };
    let bytes = serde_json::to_vec(&acknowledgement).map_err(|_| "签名回执序列化失败")?;
    if bytes.len() > 1024 * 1024 { return Err("签名回执超过允许大小".into()); }
    #[cfg(mobile)]
    {
        use tauri_plugin_fs::FsExt;
        let mut options = tauri_plugin_fs::OpenOptions::new(); options.read(false).write(true).create(true).truncate(true);
        let mut file = app.fs().open(selected, options).map_err(|_| "无法打开系统选择的回执保存位置")?;
        file.write_all(&bytes).map_err(|_| "无法保存签名回执，请检查设备存储空间")?;
    }
    #[cfg(not(mobile))]
    {
        let path = selected.into_path().map_err(|_| "当前平台返回了不支持的回执保存位置".to_string())?;
        fs::write(path, bytes).map_err(|_| "无法保存签名回执，请检查所选位置和设备存储空间")?;
    }
    let conn = open_db()?;
    delete_pending_acknowledgement(&conn, &acknowledgement.source_device_id, &acknowledgement.message_ids).map_err(|_| "签名回执已保存，但无法清理本机待保存副本")?;
    Ok(true)
}

fn acknowledgement_batch_key(message_ids: &[String]) -> String {
    let mut ids = message_ids.to_vec(); ids.sort_unstable();
    hex::encode(sha2::Sha256::digest(ids.join("\0").as_bytes()))
}

fn delete_pending_acknowledgement(conn: &rusqlite::Connection, peer_device_id: &str, message_ids: &[String]) -> Result<(), String> {
    conn.execute("DELETE FROM sync_pending_acknowledgements WHERE peer_device_id=?1 AND batch_key=?2", rusqlite::params![peer_device_id, acknowledgement_batch_key(message_ids)]).map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(mobile)]
fn persist_pending_acknowledgement(acknowledgement: &SyncDeltaApplyResult) -> PlatformResult<()> {
    let serialized = serde_json::to_string(acknowledgement).map_err(|_| "无法序列化待保存同步回执")?;
    let conn = open_db()?;
    conn.execute("INSERT INTO sync_pending_acknowledgements(peer_device_id,batch_key,acknowledgement_json,created_at) VALUES(?1,?2,?3,?4) ON CONFLICT(peer_device_id,batch_key) DO UPDATE SET acknowledgement_json=excluded.acknowledgement_json,created_at=excluded.created_at", rusqlite::params![acknowledgement.source_device_id, acknowledgement_batch_key(&acknowledgement.message_ids), serialized, Utc::now().timestamp_millis()]).map_err(|_| "增量已应用，但无法保存待回传签名回执；可重新导入同一增量恢复")?;
    Ok(())
}

#[tauri::command]
pub(crate) fn list_pending_sync_acknowledgements() -> PlatformResult<Vec<SyncDeltaApplyResult>> {
    let conn = open_db()?;
    let mut statement = conn.prepare("SELECT acknowledgement_json FROM sync_pending_acknowledgements ORDER BY created_at DESC LIMIT 100").map_err(|_| "无法读取待回传同步回执")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|_| "无法读取待回传同步回执")?;
    rows.map(|row| serde_json::from_str(&row.map_err(|_| "待回传同步回执格式无效")?).map_err(|_| "待回传同步回执格式无效".into())).collect()
}

/// Previews only the selected configuration metadata. This command never reads
/// credential columns; transport authorization and secret sharing are separate.
#[tauri::command]
pub(crate) fn preview_sync_config(
    account_sync_ids: Vec<String>,
    managed_host_sync_ids: Vec<String>,
    panel_sync_ids: Vec<String>,
) -> PlatformResult<SyncConfigSnapshot> {
    let mut conn = open_db()?;
    build_config_snapshot(&mut conn, &SyncSelection { account_sync_ids, managed_host_sync_ids, panel_sync_ids }).map_err(Into::into)
}

/// Creates a portable encrypted account package. The plaintext credentials are
/// decrypted and re-encrypted entirely in Rust; only authenticated ciphertext
/// crosses the Tauri boundary.
#[tauri::command]
pub(crate) fn create_sync_account_bundle(account_ids: Vec<i64>, managed_host_ids: Vec<i64>, panel_ids: Vec<i64>, passphrase: String, include_deletions: bool) -> PlatformResult<SyncEnvelope> {
    let passphrase = Zeroizing::new(passphrase);
    build_encrypted_bundle(account_ids, managed_host_ids, panel_ids, passphrase.as_str(), include_deletions)
}

/// Saves a portable, passphrase-encrypted package through the native document
/// picker. The WebView receives only the completion status, never the path or
/// plaintext credentials.
#[tauri::command]
pub(crate) fn save_sync_account_bundle(
    app: AppHandle,
    account_ids: Vec<i64>,
    managed_host_ids: Vec<i64>,
    panel_ids: Vec<i64>,
    passphrase: String,
    include_deletions: bool,
) -> PlatformResult<bool> {
    if passphrase.is_empty() { return Err("请输入迁移口令".into()); }
    let passphrase = Zeroizing::new(passphrase);
    let envelope = build_encrypted_bundle(account_ids, managed_host_ids, panel_ids, passphrase.as_str(), include_deletions)?;
    let filename = format!("cloudhub-mobile-transfer-{}.chsync.json", Utc::now().format("%Y%m%d-%H%M%S"));
    let Some(selected) = app.dialog().file().set_file_name(filename).add_filter("CloudHub 加密迁移包", &["json"]).blocking_save_file() else { return Ok(false) };
    let bytes = serde_json::to_vec(&envelope).map_err(|_| "加密迁移包序列化失败")?;
    #[cfg(mobile)]
    {
        use tauri_plugin_fs::FsExt;
        let mut options = tauri_plugin_fs::OpenOptions::new();
        options.read(false).write(true).create(true).truncate(true);
        let mut file = app.fs().open(selected, options).map_err(|_| "无法打开系统选择的迁移文件位置")?;
        file.write_all(&bytes).map_err(|_| "无法保存加密迁移包，请检查设备存储空间")?;
    }
    #[cfg(not(mobile))]
    {
        let path = selected.into_path().map_err(|_| "当前平台返回了不支持的导出位置".to_string())?;
        fs::write(path, bytes).map_err(|_| "无法保存加密迁移包，请检查所选位置和设备存储空间")?;
    }
    Ok(true)
}

/// Starts an expiring, single-download LAN endpoint. Only the already encrypted
/// envelope is served; plaintext credentials and the migration passphrase stay
/// inside the native process and the user's two devices.
#[tauri::command]
pub(crate) async fn start_sync_transfer(
    account_ids: Vec<i64>, managed_host_ids: Vec<i64>, panel_ids: Vec<i64>,
    include_deletions: bool,
    store: State<'_, SyncTransferStore>,
    app: AppHandle,
) -> PlatformResult<SyncTransferStartResult> {
    if account_ids.len() + managed_host_ids.len() + panel_ids.len() == 0 && !include_deletions {
        return Err("至少选择一个配置后再开始传输".into());
    }
    let local_identity = get_sync_device_identity(app.clone())?;
    let share_scope = resolve_device_share_scope(&account_ids, &managed_host_ids, &panel_ids, include_deletions)?;
    let mut transfer_key_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut transfer_key_bytes);
    let transfer_key = Zeroizing::new(URL_SAFE_NO_PAD.encode(transfer_key_bytes));
    transfer_key_bytes.fill(0);
    let envelope = build_encrypted_bundle(account_ids, managed_host_ids, panel_ids, transfer_key.as_str(), include_deletions)?;
    let body = serde_json::to_vec(&envelope).map_err(|_| "同步包序列化失败")?;
    let ip = primary_lan_ipv4()?;
    let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).await.map_err(|_| "无法开启局域网迁移服务")?;
    let port = listener.local_addr().map_err(|_| "无法读取局域网迁移端口")?.port();
    let mut token_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut token_bytes);
    let token = URL_SAFE_NO_PAD.encode(token_bytes);

    let mut active = store.task.lock().map_err(|_| "局域网迁移服务状态不可用")?;
    if let Some(previous) = active.take() { previous.abort(); }
    if let Ok(mut pending) = store.pending_approval.lock() { pending.take(); }
    if let Ok(mut pending) = store.pending_push_approval.lock() { if let Some(sender) = pending.take() { let _ = sender.send(false); } }
    if let Ok(mut pending) = store.pending_push_ack.lock() { pending.take(); }
    let task_token = token.clone();
    let approval = store.pending_approval.clone();
    let app_handle = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        serve_sync_transfer(listener, task_token, body, approval, share_scope, None, move |request| app_handle.emit("sync-transfer-requested", request).is_ok(), |_, _| {}, |_, _, _| Err("此传输不接受增量回执".into())).await;
    });
    *active = Some(task);
    let public_key: [u8; 32] = STANDARD.decode(&local_identity.public_key).map_err(|_| "本机同步公钥格式无效")?.try_into().map_err(|_| "本机同步公钥长度无效")?;
    let source_public_key = URL_SAFE_NO_PAD.encode(public_key);
    Ok(SyncTransferStartResult {
        pairing_url: format!("http://{ip}:{port}/v1/transfer/{token}#{}.{}.{}", local_identity.device_id, source_public_key, transfer_key.as_str()),
        source_device_id: local_identity.device_id,
        source_public_key_fingerprint: hex::encode(&sha2::Sha256::digest(public_key)[..8]),
    })
}

/// Starts a short-lived, one-download LAN endpoint for the selected peer's
/// signed delta. The peer must still be trusted and already have an outbound
/// scope on this computer; approval remains required for every transfer.
#[tauri::command]
pub(crate) async fn start_sync_delta_transfer(
    target_device_id: String, passphrase: String, store: State<'_, SyncTransferStore>, app: AppHandle,
) -> PlatformResult<SyncTransferStartResult> {
    if Uuid::parse_str(&target_device_id).is_err() { return Err("目标设备 ID 格式无效".into()); }
    if passphrase.is_empty() { return Err("请输入增量同步口令".into()); }
    let envelope = create_sync_delta_bundle(app.clone(), target_device_id.clone(), 0, 100, passphrase)?;
    let body = serde_json::to_vec(&envelope).map_err(|_| "签名增量序列化失败")?;
    if body.len() > 15 * 1024 * 1024 { return Err("签名增量超过 15 MB 局域网传输上限".into()); }
    let local_identity = get_sync_device_identity(app.clone())?;
    let share_scope = {
        let conn = open_db()?;
        let status: String = conn.query_row("SELECT status FROM sync_devices WHERE device_id=?1", [&target_device_id], |row| row.get(0)).map_err(|_| "目标设备未获同步授权")?;
        if status != "trusted" { return Err("目标设备同步授权已撤销".into()); }
        let mut statement = conn.prepare("SELECT entity_type,entity_sync_id FROM sync_device_scope WHERE peer_device_id=?1 ORDER BY entity_type,entity_sync_id").map_err(|_| "无法读取目标设备共享范围")?;
        let rows = statement.query_map([&target_device_id], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|_| "无法读取目标设备共享范围")?;
        rows.collect::<Result<Vec<(String, String)>, _>>().map_err(|_| "目标设备共享范围格式无效")?
    };
    if share_scope.is_empty() { return Err("目标设备没有授权接收配置".into()); }
    let ip = primary_lan_ipv4()?;
    let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).await.map_err(|_| "无法开启局域网增量服务")?;
    let port = listener.local_addr().map_err(|_| "无法读取局域网增量端口")?.port();
    let mut token_bytes = [0u8; 32]; rand::thread_rng().fill_bytes(&mut token_bytes);
    let token = URL_SAFE_NO_PAD.encode(token_bytes);
    let mut active = store.task.lock().map_err(|_| "局域网传输服务状态不可用")?;
    if let Some(previous) = active.take() { previous.abort(); }
    if let Ok(mut pending) = store.pending_approval.lock() { pending.take(); }
    if let Ok(mut pending) = store.pending_push_approval.lock() { if let Some(sender) = pending.take() { let _ = sender.send(false); } }
    if let Ok(mut pending) = store.pending_push_ack.lock() { pending.take(); }
    let task_token = token.clone(); let approval = store.pending_approval.clone(); let app_handle = app.clone();
    let expected_device_id = target_device_id;
    let ack_event_app = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        serve_sync_transfer(listener, task_token, body, approval, share_scope, Some(expected_device_id), move |request| app_handle.emit("sync-transfer-requested", request).is_ok(), move |device_id, acknowledged| {
            let _ = ack_event_app.emit("sync-transfer-acknowledged", serde_json::json!({ "deviceId": device_id, "acknowledged": acknowledged }));
        }, |device_id, message_ids, signature| acknowledge_sync_delta_for_peer(device_id, message_ids, signature)).await;
    });
    *active = Some(task);
    let public_key: [u8; 32] = STANDARD.decode(&local_identity.public_key).map_err(|_| "本机同步公钥格式无效")?.try_into().map_err(|_| "本机同步公钥长度无效")?;
    Ok(SyncTransferStartResult {
        pairing_url: format!("http://{ip}:{port}/v1/transfer/{token}#{}.{}", local_identity.device_id, URL_SAFE_NO_PAD.encode(public_key)),
        source_device_id: local_identity.device_id,
        source_public_key_fingerprint: hex::encode(&sha2::Sha256::digest(public_key)[..8]),
    })
}

/// Opens a temporary desktop endpoint for an already trusted phone to push an
/// encrypted, signed delta. The desktop user must approve the individual
/// transfer before its body is accepted.
#[tauri::command]
pub(crate) async fn start_sync_delta_receiver(store: State<'_, SyncTransferStore>, app: AppHandle) -> PlatformResult<SyncTransferStartResult> {
    if store.received_delta.lock().map_err(|_| "无法检查待处理的局域网增量")?.is_some() { return Err("已有一份局域网增量等待预览或应用，请先处理后再开启接收服务".into()); }
    let local_identity = get_sync_device_identity(app.clone())?;
    let ip = primary_lan_ipv4()?;
    let listener = TcpListener::bind((ip, 0)).await.map_err(|_| "无法开启局域网增量接收服务")?;
    let port = listener.local_addr().map_err(|_| "无法读取局域网增量接收端口")?.port();
    let mut token_bytes = [0u8; 32]; rand::thread_rng().fill_bytes(&mut token_bytes);
    let token = URL_SAFE_NO_PAD.encode(token_bytes);
    let mut active = store.task.lock().map_err(|_| "局域网传输服务状态不可用")?;
    if let Some(previous) = active.take() { previous.abort(); }
    if let Ok(mut pending) = store.pending_approval.lock() { pending.take(); }
    if let Ok(mut pending) = store.pending_push_approval.lock() { if let Some(sender) = pending.take() { let _ = sender.send(false); } }
    if let Ok(mut pending) = store.pending_push_ack.lock() { pending.take(); }
    let task_token = token.clone();
    let push_approval = store.pending_push_approval.clone();
    let push_ack = store.pending_push_ack.clone();
    let received_delta = store.received_delta.clone();
    let app_handle = app.clone();
    let received_app = app.clone();
    let push_app = app.clone();
    let expected_device_id = local_identity.device_id.clone();
    let task = tauri::async_runtime::spawn(async move {
        serve_sync_delta_push(listener, task_token, expected_device_id, push_approval, push_ack, received_delta,
            move |request| app_handle.emit("sync-transfer-requested", request).is_ok(),
            move || received_app.emit("sync-delta-received", ()).is_ok(), push_app).await;
    });
    *active = Some(task);
    let public_key: [u8; 32] = STANDARD.decode(&local_identity.public_key).map_err(|_| "本机同步公钥格式无效")?.try_into().map_err(|_| "本机同步公钥长度无效")?;
    Ok(SyncTransferStartResult {
        pairing_url: format!("http://{ip}:{port}/v1/transfer/{token}#{}.{}", local_identity.device_id, URL_SAFE_NO_PAD.encode(public_key)),
        source_device_id: local_identity.device_id,
        source_public_key_fingerprint: hex::encode(&sha2::Sha256::digest(public_key)[..8]),
    })
}

/// Posts an encrypted delta from a mobile device to a trusted desktop receiver.
#[tauri::command]
pub(crate) async fn send_sync_delta_bundle_lan(app: AppHandle, pairing_url: String, client_code: String, passphrase: String, envelope: SyncEnvelope) -> PlatformResult<usize> {
    if client_code.len() != 6 || !client_code.bytes().all(|byte| byte.is_ascii_digit()) { return Err("本机校验码格式无效".into()); }
    let url = parse_pairing_url(&pairing_url)?;
    let (target_device_id, target_public_key, _) = parse_pairing_source(&url)?;
    let identity = get_sync_device_identity(app.clone())?;
    let passphrase = Zeroizing::new(passphrase);
    let conn = open_db()?;
    let (known_key, status): (Vec<u8>, String) = conn.query_row("SELECT public_key,status FROM sync_devices WHERE device_id=?1", [&target_device_id], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|_| "二维码中的电脑尚未获本机信任")?;
    if status != "trusted" || known_key.as_slice() != target_public_key { return Err("二维码中的电脑身份未获信任或密钥已变化".into()); }
    let delta = Zeroizing::new(open_sync_payload::<SyncDeltaBundle>(&envelope, passphrase.as_str())?);
    if delta.source_device_id != identity.device_id || delta.target_device_id != target_device_id { return Err("增量包发送方或接收方与本次局域网会话不匹配".into()); }
    let local_key: Vec<u8> = conn.query_row("SELECT public_key FROM sync_local_device WHERE id=1", [], |row| row.get(0)).map_err(|_| "无法读取本机同步公钥")?;
    let local_key: [u8; 32] = local_key.try_into().map_err(|_| "本机同步公钥格式无效")?;
    let delta_signature: [u8; 64] = STANDARD.decode(delta.signature.as_deref().ok_or("增量包缺少设备签名")?).map_err(|_| "增量包签名格式无效")?.try_into().map_err(|_| "增量包签名长度无效")?;
    let signed_bytes = Zeroizing::new(sync_delta_signing_bytes(&delta)?);
    if !verify_sync_delta(&local_key, &delta_signature, &delta.source_device_id, &delta.target_device_id, &signed_bytes) { return Err("增量包签名与本机身份不匹配".into()); }
    let mut expected_message_ids = delta.changes.iter().map(|change| change.message_id.clone()).collect::<Vec<_>>();
    expected_message_ids.sort();
    drop(conn);
    drop(signed_bytes);
    drop(delta);
    drop(passphrase);
    let body = serde_json::to_vec(&envelope).map_err(|_| "签名增量序列化失败")?;
    if body.is_empty() || body.len() > 15 * 1024 * 1024 { return Err("签名增量大小无效或超过 15 MB 上限".into()); }
    let token = url.path().strip_prefix("/v1/transfer/").ok_or("局域网会话路径无效")?;
    let seed = Zeroizing::new(load_sync_signing_seed(&app, &open_db()?)?.ok_or("本机同步身份密钥不可用")?);
    let signature = sign_pairing_request(&seed, token, &identity.device_id, &client_code);
    drop(seed);
    let mut push_url = url.clone();
    push_url.set_path(&format!("/v1/transfer/{token}/request"));
    push_url.set_fragment(None);
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(310)).build().map_err(|_| "无法初始化局域网增量传输")?;
    let authorized = client.post(push_url.clone())
        .header("x-cloudhub-device-code", &client_code)
        .header("x-cloudhub-device-id", &identity.device_id)
        .header("x-cloudhub-device-public-key", &identity.public_key)
        .header("x-cloudhub-device-signature", STANDARD.encode(signature))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::CONTENT_LENGTH, "0")
        .body(Vec::new()).send().await.map_err(|_| "无法连接电脑，请确认其仍在等待且两台设备处于同一局域网")?;
    if !authorized.status().is_success() { return Err("电脑拒绝或未批准本次局域网增量请求".into()); }
    let response_signature = authorized.headers().get("x-cloudhub-device-signature").ok_or("电脑未提供本次批准的身份签名")?.to_str().map_err(|_| "电脑批准签名格式无效")?;
    let response_signature: [u8; 64] = STANDARD.decode(response_signature).map_err(|_| "电脑批准签名格式无效")?.try_into().map_err(|_| "电脑批准签名长度无效")?;
    if !verify_pairing_request(&target_public_key, &response_signature, token, &target_device_id, &client_code) { return Err("电脑批准签名与二维码中的身份不匹配".into()); }
    push_url.set_path(&format!("/v1/transfer/{token}/delta"));
    let response = client.post(push_url)
        .header("x-cloudhub-device-code", &client_code)
        .header("x-cloudhub-device-id", &identity.device_id)
        .header("x-cloudhub-device-public-key", &identity.public_key)
        .header("x-cloudhub-device-signature", STANDARD.encode(signature))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body).send().await.map_err(|_| "电脑已批准请求，但局域网增量正文未能送达")?;
    if !response.status().is_success() { return Err("电脑已批准请求，但未能完成局域网增量应用或回执返回；请检查电脑端提示后重试".into()); }
    if response.content_length().is_some_and(|length| length > 1024 * 1024) { return Err("电脑返回的签名回执超过大小上限".into()); }
    let mut response = response;
    let mut ack_bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "增量已送达电脑，但读取签名回执失败；请检查电脑端应用状态")? {
        if ack_bytes.len().saturating_add(chunk.len()) > 1024 * 1024 { return Err("电脑返回的签名回执超过大小上限".into()); }
        ack_bytes.extend_from_slice(&chunk);
    }
    let acknowledgement: SyncDeltaApplyResult = serde_json::from_slice(&ack_bytes).map_err(|_| "电脑尚未返回有效签名回执；该批次仍保留在待同步列表")?;
    if acknowledgement.source_device_id != identity.device_id || acknowledgement.receiver_device_id != target_device_id || acknowledgement.message_ids != expected_message_ids {
        return Err("电脑签名回执与本次增量设备或消息范围不匹配；该批次仍保留在待同步列表".into());
    }
    acknowledge_sync_delta_for_peer(&target_device_id, &acknowledgement.message_ids, &acknowledgement.signature)
        .map_err(|_| "电脑回执未通过本机信任与签名校验；该批次仍保留在待同步列表".into())
}

#[tauri::command]
pub(crate) fn take_received_sync_delta(store: State<'_, SyncTransferStore>) -> PlatformResult<Option<SyncEnvelope>> {
    Ok(store.received_delta.lock().map_err(|_| "无法读取待处理的局域网增量")?.take())
}

/// Returns a desktop-signed apply receipt to the phone that uploaded this exact batch.
#[tauri::command]
pub(crate) fn complete_sync_delta_push(acknowledgement: SyncDeltaApplyResult, app: AppHandle, store: State<'_, SyncTransferStore>) -> PlatformResult<()> {
    let local_identity = get_sync_device_identity(app)?;
    if acknowledgement.receiver_device_id != local_identity.device_id { return Err("回执接收设备与本机身份不匹配".into()); }
    let mut expected_message_ids = acknowledgement.message_ids.clone();
    expected_message_ids.sort();
    let conn = open_db()?;
    let status: String = conn.query_row("SELECT status FROM sync_devices WHERE device_id=?1", [&acknowledgement.source_device_id], |row| row.get(0)).map_err(|_| "手机设备未获同步授权")?;
    if status != "trusted" { return Err("手机设备同步授权已撤销".into()); }
    let local_key: Vec<u8> = conn.query_row("SELECT public_key FROM sync_local_device WHERE id=1", [], |row| row.get(0)).map_err(|_| "无法读取本机同步公钥")?;
    let local_key: [u8; 32] = local_key.try_into().map_err(|_| "本机同步公钥格式无效")?;
    verify_push_ack_for_batch(&acknowledgement, &acknowledgement.source_device_id, &local_identity.device_id, &expected_message_ids, &local_key)?;
    ensure_sync_inbox_contains_batch(&conn, &acknowledgement.source_device_id, &expected_message_ids)?;
    drop(conn);
    let sender = {
        let mut pending = store.pending_push_ack.lock().map_err(|_| "局域网回执状态不可用")?;
        let pending_ref = pending.as_ref().ok_or("当前没有等待手机回执的局域网增量")?;
        if pending_ref.source_device_id != acknowledgement.source_device_id || pending_ref.expected_message_ids.as_deref() != Some(expected_message_ids.as_slice()) {
            return Err("回执与已预览的手机增量批次不匹配".into());
        }
        pending.take().ok_or("局域网回执状态已结束")?.sender
    };
    sender.send(acknowledgement).map_err(|_| "局域网手机会话已结束，仍可导出签名回执文件".into())
}

fn ensure_sync_inbox_contains_batch(conn: &rusqlite::Connection, source_device_id: &str, message_ids: &[String]) -> Result<(), String> {
    for message_id in message_ids {
        let applied: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_inbox WHERE peer_device_id=?1 AND message_id=?2)",
            rusqlite::params![source_device_id, message_id], |row| row.get(0),
        ).map_err(|_| "无法验证增量是否已提交")?;
        if !applied { return Err("桌面尚未提交本批增量，不能确认手机的待同步队列".into()); }
    }
    Ok(())
}

fn verify_push_ack_for_batch(acknowledgement: &SyncDeltaApplyResult, source_device_id: &str, receiver_device_id: &str, expected_message_ids: &[String], public_key: &[u8; 32]) -> Result<(), String> {
    if acknowledgement.source_device_id != source_device_id || acknowledgement.receiver_device_id != receiver_device_id
        || acknowledgement.message_ids != expected_message_ids {
        return Err("回执与已预览的手机增量批次不匹配".into());
    }
    if expected_message_ids.is_empty() || expected_message_ids.len() > 100
        || expected_message_ids.windows(2).any(|pair| pair[0] >= pair[1])
        || expected_message_ids.iter().any(|id| Uuid::parse_str(id).is_err()) {
        return Err("同步回执批次大小或消息 ID 无效".into());
    }
    let signature: [u8; 64] = STANDARD.decode(&acknowledgement.signature).map_err(|_| "同步回执签名格式无效")?.try_into().map_err(|_| "同步回执签名长度无效")?;
    if !verify_sync_ack(public_key, &signature, source_device_id, receiver_device_id, expected_message_ids) {
        return Err("桌面签名回执验证失败".into());
    }
    Ok(())
}

async fn serve_sync_delta_push<F>(
    listener: TcpListener,
    token: String,
    expected_device_id: String,
    pending_approval: Arc<Mutex<Option<oneshot::Sender<bool>>>>,
    pending_ack: Arc<Mutex<Option<PendingSyncPushAck>>>,
    received_delta: Arc<Mutex<Option<SyncEnvelope>>>,
    emit_request: F,
    emit_received: impl Fn() -> bool + Send + 'static,
    app: AppHandle,
) where F: Fn(SyncTransferRequest) -> bool + Send + 'static {
    let deadline = Instant::now() + Duration::from_secs(300);
    let mut attempts = 0;
    while Instant::now() < deadline && attempts < 20 {
        let Ok(Ok((mut stream, peer))) = tokio::time::timeout_at(deadline, listener.accept()).await else { break };
        attempts += 1;
        let Some((client, request_length)) = read_sync_delta_push_headers(&mut stream, &token, "request").await else {
            let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            continue;
        };
        if request_length != 0 || client.device_id == expected_device_id {
            let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            continue;
        }
        let trusted = open_db().is_ok_and(|conn| is_trusted_sync_peer_in(&conn, &client.device_id, &client.public_key).unwrap_or(false));
        if !trusted {
            let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            continue;
        }
        if received_delta.lock().map(|slot| slot.is_some()).unwrap_or(true) {
            let _ = stream.write_all(b"HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            break;
        }
        let (approve_sender, approve_receiver) = oneshot::channel();
        let approval_stored = match pending_approval.lock() { Ok(mut slot) => { *slot = Some(approve_sender); true }, Err(_) => false };
        if !approval_stored {
            let _ = stream.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            break;
        }
        let request = SyncTransferRequest {
            client_address: peer.ip().to_string(),
            verification_code: client.verification_code.clone(),
            device_id: client.device_id.clone(),
            public_key_fingerprint: hex::encode(&sha2::Sha256::digest(client.public_key)[..8]),
        };
        if !emit_request(request) {
            if let Ok(mut pending) = pending_approval.lock() { pending.take(); }
            let _ = stream.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            break;
        }
        let approved = matches!(tokio::time::timeout_at(deadline, approve_receiver).await, Ok(Ok(true)));
        if let Ok(mut pending) = pending_approval.lock() { pending.take(); }
        if !approved {
            let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            continue;
        }
        let signature = (|| -> PlatformResult<String> {
            let conn = open_db()?;
            let current_id: String = conn.query_row("SELECT device_id FROM sync_local_device WHERE id=1", [], |row| row.get(0)).map_err(|_| "无法读取本机同步身份")?;
            if current_id != expected_device_id { return Err("桌面同步身份已变化".into()); }
            let seed = Zeroizing::new(load_sync_signing_seed(&app, &conn)?.ok_or("本机同步身份密钥不可用")?);
            Ok(STANDARD.encode(sign_pairing_request(&seed, &token, &expected_device_id, &client.verification_code)))
        })();
        let Ok(signature) = signature else {
            let _ = stream.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            break;
        };
        let response = format!("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nCache-Control: no-store\r\nX-CloudHub-Device-Signature: {signature}\r\nConnection: close\r\n\r\n");
        let _ = stream.write_all(response.as_bytes()).await;
        let Ok(Ok((mut upload, upload_peer))) = tokio::time::timeout_at(deadline, listener.accept()).await else { break };
        attempts += 1;
        let Some((upload_client, content_length)) = read_sync_delta_push_headers(&mut upload, &token, "delta").await else {
            let _ = upload.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            continue;
        };
        if upload_client.device_id != client.device_id || upload_client.public_key != client.public_key || content_length == 0 || content_length > 15 * 1024 * 1024 {
            let _ = upload.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            continue;
        }
        let still_trusted = open_db().is_ok_and(|conn| is_trusted_sync_peer_in(&conn, &client.device_id, &client.public_key).unwrap_or(false));
        if !still_trusted {
            let _ = upload.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            break;
        }
        let mut body = vec![0u8; content_length];
        if !matches!(tokio::time::timeout_at(deadline, upload.read_exact(&mut body)).await, Ok(Ok(_))) {
            let _ = upload.write_all(b"HTTP/1.1 408 Request Timeout\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            continue;
        }
        let Ok(envelope) = serde_json::from_slice::<SyncEnvelope>(&body) else {
            let _ = upload.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            continue;
        };
        drop(body);
        let canonical_envelope = match serde_json::to_vec(&envelope) {
            Ok(serialized) => serialized,
            Err(_) => {
                let _ = upload.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                break;
            }
        };
        let envelope_hash: [u8; 32] = sha2::Sha256::digest(&canonical_envelope).into();
        let (ack_sender, ack_receiver) = oneshot::channel();
        let ack_stored = match pending_ack.lock() {
            Ok(mut pending) if pending.is_none() => { *pending = Some(PendingSyncPushAck { source_device_id: client.device_id.clone(), envelope_hash, expected_message_ids: None, sender: ack_sender }); true },
            _ => false,
        };
        if !ack_stored {
            let _ = upload.write_all(b"HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            break;
        }
        let delta_stored = match received_delta.lock() { Ok(mut pending) if pending.is_none() => { *pending = Some(envelope); true }, _ => false };
        if !delta_stored {
            if let Ok(mut pending) = pending_ack.lock() { pending.take(); }
            let _ = upload.write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            break;
        }
        let _ = emit_received();
        let acknowledgement = match tokio::time::timeout_at(deadline, ack_receiver).await {
            Ok(Ok(acknowledgement)) => acknowledgement,
            _ => {
                if let Ok(mut pending) = pending_ack.lock() { pending.take(); }
                let _ = upload.write_all(b"HTTP/1.1 408 Request Timeout\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n").await;
                break;
            }
        };
        if !open_db().is_ok_and(|conn| is_trusted_sync_peer_in(&conn, &client.device_id, &client.public_key).unwrap_or(false)) {
            if let Ok(mut pending) = pending_ack.lock() { pending.take(); }
            let _ = upload.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n").await;
            break;
        }
        let Ok(ack_body) = serde_json::to_vec(&acknowledgement) else {
            let _ = upload.write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            break;
        };
        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", ack_body.len());
        if upload.write_all(response.as_bytes()).await.is_err() || upload.write_all(&ack_body).await.is_err() { break; }
        if let Ok(mut pending) = pending_ack.lock() { pending.take(); }
        let _ = upload_peer;
        break;
    }
}

async fn read_sync_delta_push_headers(stream: &mut TcpStream, token: &str, route_suffix: &str) -> Option<(VerifiedTransferClient, usize)> {
    let mut header = Vec::with_capacity(1024);
    let mut byte = [0u8; 1];
    let complete = tokio::time::timeout(Duration::from_secs(5), async {
        while header.len() < 8192 && !header.ends_with(b"\r\n\r\n") {
            let read = stream.read(&mut byte).await.ok()?;
            if read == 0 { return None; }
            header.push(byte[0]);
        }
        Some(())
    }).await;
    if !matches!(complete, Ok(Some(()))) { return None; }
    if header.len() >= 8192 { return None; }
    let header = std::str::from_utf8(&header).ok()?;
    let mut lines = header.lines();
    if lines.next()? != format!("POST /v1/transfer/{token}/{route_suffix} HTTP/1.1") { return None; }
    let fields = lines.filter_map(|line| line.trim_end_matches('\r').split_once(':')).collect::<Vec<_>>();
    if fields.iter().any(|(name, _)| name.eq_ignore_ascii_case("transfer-encoding")) { return None; }
    let one = |header_name: &str| -> Option<&str> {
        let values = fields.iter().filter(|(name, _)| name.eq_ignore_ascii_case(header_name)).map(|(_, value)| value.trim()).collect::<Vec<_>>();
        (values.len() == 1).then(|| values[0])
    };
    if !one("content-type")?.eq_ignore_ascii_case("application/json") { return None; }
    let content_length = one("content-length")?.parse::<usize>().ok()?;
    let code = one("x-cloudhub-device-code")?;
    let device_id = one("x-cloudhub-device-id")?;
    let encoded_key = one("x-cloudhub-device-public-key")?;
    let encoded_signature = one("x-cloudhub-device-signature")?;
    if code.len() != 6 || !code.bytes().all(|value| value.is_ascii_digit()) || Uuid::parse_str(device_id).is_err() { return None; }
    let public_key: [u8; 32] = STANDARD.decode(encoded_key).ok()?.try_into().ok()?;
    let signature: [u8; 64] = STANDARD.decode(encoded_signature).ok()?.try_into().ok()?;
    if !verify_pairing_request(&public_key, &signature, token, device_id, code) { return None; }
    Some((VerifiedTransferClient { verification_code: code.to_string(), device_id: device_id.to_string(), public_key }, content_length))
}

fn is_trusted_sync_peer_in(conn: &rusqlite::Connection, device_id: &str, public_key: &[u8; 32]) -> Result<bool, String> {
    use rusqlite::OptionalExtension;
    let known: Option<(Vec<u8>, String)> = conn.query_row("SELECT public_key,status FROM sync_devices WHERE device_id=?1", [device_id], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(|_| "无法读取局域网发送设备授权")?;
    Ok(known.is_some_and(|(key, status)| status == "trusted" && key.as_slice() == public_key))
}

#[tauri::command]
pub(crate) fn cancel_sync_transfer(store: State<'_, SyncTransferStore>) -> PlatformResult<()> {
    if let Some(task) = store.task.lock().map_err(|_| "局域网迁移服务状态不可用")?.take() { task.abort(); }
    if let Ok(mut pending) = store.pending_approval.lock() { pending.take(); }
    if let Ok(mut pending) = store.pending_push_approval.lock() { if let Some(sender) = pending.take() { let _ = sender.send(false); } }
    if let Ok(mut pending) = store.pending_push_ack.lock() { pending.take(); }
    Ok(())
}

#[tauri::command]
pub(crate) fn approve_sync_transfer(approved: bool, store: State<'_, SyncTransferStore>) -> PlatformResult<()> {
    if let Some(sender) = store.pending_push_approval.lock().map_err(|_| "局域网增量授权状态不可用")?.take() {
        sender.send(approved).map_err(|_| "手机增量请求已结束")?;
        return Ok(());
    }
    let pending = store.pending_approval.lock().map_err(|_| "局域网迁移授权状态不可用")?.take()
        .ok_or("当前没有等待批准的手机迁移请求")?;
    if approved { record_approved_sync_device(&pending.client.device_id, &pending.client.public_key, &pending.scope, Utc::now().timestamp_millis())?; }
    pending.sender.send(approved).map_err(|_| "手机迁移请求已结束")?;
    Ok(())
}

fn primary_lan_ipv4() -> PlatformResult<Ipv4Addr> {
    // UDP connect selects the route without sending a packet. The endpoint is
    // exposed only when that route resolves to an RFC1918 LAN address.
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|_| "无法检测本机局域网地址")?;
    socket.connect((Ipv4Addr::new(192, 0, 2, 1), 9)).map_err(|_| "无法检测本机局域网地址")?;
    let ip = match socket.local_addr().map_err(|_| "无法检测本机局域网地址")?.ip() {
        std::net::IpAddr::V4(ip) => ip,
        _ => return Err("当前网络没有可用的 IPv4 局域网地址".into()),
    };
    if !is_private_lan_ipv4(ip) { return Err("当前网络没有可用的私有 IPv4 局域网地址".into()); }
    Ok(ip)
}

fn is_private_lan_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    a == 10 || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168)
}

fn store_pending_approval(
    approval: &Arc<Mutex<Option<PendingSyncApproval>>>,
    pending: PendingSyncApproval,
) -> bool {
    let Ok(mut slot) = approval.lock() else { return false };
    *slot = Some(pending);
    true
}

async fn serve_sync_transfer<F, A, H>(
    listener: TcpListener,
    token: String,
    body: Vec<u8>,
    approval: Arc<Mutex<Option<PendingSyncApproval>>>,
    share_scope: Vec<(String, String)>,
    expected_device_id: Option<String>,
    emit_request: F,
    emit_acknowledgement: A,
    handle_acknowledgement: H,
)
where F: Fn(SyncTransferRequest) -> bool + Send + 'static, A: Fn(String, usize) + Send + 'static,
      H: Fn(&str, &[String], &str) -> Result<usize, String> + Send + 'static {
    let deadline = Instant::now() + Duration::from_secs(300);
    let mut attempts = 0;
    let mut bundle_sent = false;
    while Instant::now() < deadline {
        if attempts >= 20 { break; }
        let accepted = tokio::time::timeout_at(deadline, listener.accept()).await;
        let Ok(Ok((mut stream, peer))) = accepted else { break };
        attempts += 1;
        let Some(request) = read_transfer_request(&mut stream, &token).await else {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            continue;
        };
        if let TransferRequest::Acknowledgement { ref device_id, ref message_ids, ref signature } = request {
            if !bundle_sent || expected_device_id.as_deref() != Some(device_id.as_str()) {
                let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                continue;
            }
            match handle_acknowledgement(device_id, message_ids, signature) {
                Ok(acknowledged) => {
                    let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                    emit_acknowledgement(device_id.clone(), acknowledged);
                    break;
                }
                Err(_) => {
                    let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                    continue;
                }
            }
        }
        let TransferRequest::Fetch(client) = request else { continue };
        if bundle_sent {
            let _ = stream.write_all(b"HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            continue;
        }
        if expected_device_id.as_deref().is_some_and(|expected| expected != client.device_id) {
            let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            continue;
        }
        let (approve_sender, approve_receiver) = oneshot::channel();
        if !store_pending_approval(&approval, PendingSyncApproval { sender: approve_sender, client: client.clone(), scope: share_scope.clone() }) {
            let _ = stream.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            break;
        }
        let fingerprint = hex::encode(&sha2::Sha256::digest(client.public_key)[..8]);
        let request = SyncTransferRequest {
            client_address: peer.ip().to_string(), verification_code: client.verification_code.clone(),
            device_id: client.device_id.clone(), public_key_fingerprint: fingerprint,
        };
        if !emit_request(request) {
            if let Ok(mut pending) = approval.lock() { pending.take(); }
            let _ = stream.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            break;
        }
        let approved = matches!(tokio::time::timeout_at(deadline, approve_receiver).await, Ok(Ok(true)));
        if let Ok(mut pending) = approval.lock() { pending.take(); }
        if !approved {
            let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            break;
        }
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
            body.len()
        );
        if stream.write_all(header.as_bytes()).await.is_ok() && stream.write_all(&body).await.is_ok() {
            let _ = stream.shutdown().await;
            if expected_device_id.is_none() { break; }
            bundle_sent = true;
        }
    }
}

enum TransferRequest {
    Fetch(VerifiedTransferClient),
    Acknowledgement { device_id: String, message_ids: Vec<String>, signature: String },
}

async fn read_transfer_request(stream: &mut TcpStream, token: &str) -> Option<TransferRequest> {
    let mut request = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let Ok(Ok(read)) = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut chunk)).await else { return None };
        if read == 0 || request.len() + read > 8192 { return None; }
        request.extend_from_slice(&chunk[..read]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") { break; }
    }
    let header_end = request.windows(4).position(|window| window == b"\r\n\r\n")?;
    if header_end + 4 != request.len() { return None; }
    let Ok(request) = std::str::from_utf8(&request[..header_end]) else { return None };
    let headers = request.to_ascii_lowercase();
    if headers.contains("transfer-encoding:") { return None; }
    let first_line = request.lines().next()?;
    let fields = request.lines().skip(1).filter_map(|line| line.split_once(':')).collect::<Vec<_>>();
    if first_line == format!("GET /v1/transfer/{token} HTTP/1.1") {
        if fields.iter().any(|(name, _)| name.eq_ignore_ascii_case("content-length")) { return None; }
        let codes: Vec<_> = fields.iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("x-cloudhub-device-code"))
        .map(|(_, value)| value.trim())
        .collect();
        let device_ids: Vec<_> = fields.iter().filter(|(name, _)| name.eq_ignore_ascii_case("x-cloudhub-device-id")).map(|(_, value)| value.trim()).collect();
        let public_keys: Vec<_> = fields.iter().filter(|(name, _)| name.eq_ignore_ascii_case("x-cloudhub-device-public-key")).map(|(_, value)| value.trim()).collect();
        let signatures: Vec<_> = fields.iter().filter(|(name, _)| name.eq_ignore_ascii_case("x-cloudhub-device-signature")).map(|(_, value)| value.trim()).collect();
        if codes.len() != 1 || codes[0].len() != 6 || !codes[0].bytes().all(|byte| byte.is_ascii_digit())
            || device_ids.len() != 1 || Uuid::parse_str(device_ids[0]).is_err() || public_keys.len() != 1 || signatures.len() != 1 { return None; }
        let public_key: [u8; 32] = STANDARD.decode(public_keys[0]).ok()?.try_into().ok()?;
        let signature: [u8; 64] = STANDARD.decode(signatures[0]).ok()?.try_into().ok()?;
        if !verify_pairing_request(&public_key, &signature, token, device_ids[0], codes[0]) { return None; }
        return Some(TransferRequest::Fetch(VerifiedTransferClient { verification_code: codes[0].to_string(), device_id: device_ids[0].to_string(), public_key }));
    }
    if first_line != format!("POST /v1/transfer/{token}/ack HTTP/1.1") { return None; }
    let content_lengths: Vec<_> = fields.iter().filter(|(name, _)| name.eq_ignore_ascii_case("content-length")).map(|(_, value)| value.trim()).collect();
    let device_ids: Vec<_> = fields.iter().filter(|(name, _)| name.eq_ignore_ascii_case("x-cloudhub-device-id")).map(|(_, value)| value.trim()).collect();
    let message_ids: Vec<_> = fields.iter().filter(|(name, _)| name.eq_ignore_ascii_case("x-cloudhub-message-ids")).map(|(_, value)| value.trim()).collect();
    let signatures: Vec<_> = fields.iter().filter(|(name, _)| name.eq_ignore_ascii_case("x-cloudhub-ack-signature")).map(|(_, value)| value.trim()).collect();
    if content_lengths.len() != 1 || content_lengths[0] != "0" || device_ids.len() != 1 || Uuid::parse_str(device_ids[0]).is_err() || message_ids.len() != 1 || signatures.len() != 1 { return None; }
    let ids = message_ids[0].split(',').map(str::to_string).collect::<Vec<_>>();
    if ids.is_empty() || ids.len() > 100 || ids.iter().any(|id| Uuid::parse_str(id).is_err()) { return None; }
    let sig: [u8; 64] = STANDARD.decode(signatures[0]).ok()?.try_into().ok()?;
    Some(TransferRequest::Acknowledgement { device_id: device_ids[0].to_string(), message_ids: ids, signature: STANDARD.encode(sig) })
}

fn resolve_device_share_scope(account_ids: &[i64], host_ids: &[i64], panel_ids: &[i64], include_deletions: bool) -> PlatformResult<Vec<(String, String)>> {
    let mut conn = open_db()?;
    resolve_device_share_scope_in(&mut conn, account_ids, host_ids, panel_ids, include_deletions).map_err(Into::into)
}

fn resolve_device_share_scope_in(conn: &mut rusqlite::Connection, account_ids: &[i64], host_ids: &[i64], panel_ids: &[i64], include_deletions: bool) -> Result<Vec<(String, String)>, String> {
    let mut scope = Vec::new();
    if !account_ids.is_empty() {
        scope.extend(account_sync_ids_by_local_ids(conn, account_ids)?.into_iter().map(|id| ("cloud_account".to_string(), id)));
    }
    scope.extend(managed_host_sync_ids_by_local_ids(conn, host_ids)?.into_iter().map(|id| ("managed_host".to_string(), id)));
    scope.extend(panel_sync_ids_by_local_ids(conn, panel_ids)?.into_iter().map(|id| ("panel_connection".to_string(), id)));
    if include_deletions {
        let mut statement = conn.prepare("SELECT entity_type,entity_sync_id FROM sync_tombstones WHERE entity_type IN ('cloud_account','managed_host','panel_connection')").map_err(|_| "无法读取待共享删除记录")?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).map_err(|_| "无法读取待共享删除记录")?;
        for row in rows { scope.push(row.map_err(|_| "无法读取待共享删除记录")?); }
    }
    validate_device_share_scope(&scope)?;
    Ok(scope)
}

fn validate_device_share_scope(scope: &[(String, String)]) -> Result<(), String> {
    if scope.len() > 100 { return Err("单台设备最多共享 100 个配置".into()); }
    let mut seen = std::collections::HashSet::new();
    for (entity_type, entity_sync_id) in scope {
        if !["cloud_account", "managed_host", "panel_connection"].contains(&entity_type.as_str()) || Uuid::parse_str(entity_sync_id).is_err() {
            return Err("设备共享范围包含无效配置身份".into());
        }
        if !seen.insert((entity_type, entity_sync_id)) { return Err("设备共享范围包含重复配置".into()); }
    }
    Ok(())
}

fn record_approved_sync_device(device_id: &str, public_key: &[u8; 32], scope: &[(String, String)], now: i64) -> PlatformResult<()> {
    let mut conn = open_db()?;
    record_approved_sync_device_in(&mut conn, device_id, public_key, scope, now).map_err(Into::into)
}

fn record_approved_sync_device_in(conn: &mut rusqlite::Connection, device_id: &str, public_key: &[u8; 32], scope: &[(String, String)], now: i64) -> Result<(), String> {
    validate_device_share_scope(scope)?;
    let transaction = conn.transaction().map_err(|_| "无法保存已授权设备".to_string())?;
    use rusqlite::OptionalExtension;
    let existing: Option<(Vec<u8>, String)> = transaction.query_row(
        "SELECT public_key,status FROM sync_devices WHERE device_id=?1", [device_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(|_| "无法读取设备授权状态".to_string())?;
    if let Some((known_key, status)) = existing {
        if known_key.as_slice() != public_key || status == "revoked" {
            return Err("此设备身份曾被撤销或密钥不匹配；请检查设备授权状态".into());
        }
        transaction.execute("UPDATE sync_devices SET status='trusted',approved_at=?2,last_seen_at=?2 WHERE device_id=?1", rusqlite::params![device_id, now]).map_err(|_| "无法更新设备授权".to_string())?;
    } else {
        let label = format!("手机·{}", &device_id[..8]);
        transaction.execute("INSERT INTO sync_devices(device_id,device_name,public_key,status,created_at,approved_at,last_seen_at) VALUES(?1,?2,?3,'trusted',?4,?4,?4)", rusqlite::params![device_id,label,public_key.as_slice(),now]).map_err(|_| "无法记录已授权设备".to_string())?;
    }
    transaction.execute("DELETE FROM sync_device_scope WHERE peer_device_id=?1", [device_id]).map_err(|_| "无法更新设备共享范围".to_string())?;
    for (entity_type, entity_sync_id) in scope {
        transaction.execute("INSERT INTO sync_device_scope(peer_device_id,entity_type,entity_sync_id,granted_at) VALUES(?1,?2,?3,?4)", rusqlite::params![device_id,entity_type,entity_sync_id,now]).map_err(|_| "无法保存设备共享范围".to_string())?;
    }
    transaction.commit().map_err(|_| "无法提交设备授权".to_string())?;
    Ok(())
}

/// Fetches one pairing URL scanned from the desktop. Restrict destinations to
/// RFC1918 IPv4, a high port and the fixed one-time route to prevent SSRF.
#[tauri::command]
pub(crate) async fn fetch_sync_transfer(app: AppHandle, pairing_url: String, client_code: String, store: State<'_, SyncTransferStore>) -> PlatformResult<SyncTransferFetchResult> {
    if client_code.len() != 6 || !client_code.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("本机校验码格式无效".into());
    }
    let url = parse_pairing_url(&pairing_url)?;
    let (source_device_id, source_public_key, transfer_key) = parse_pairing_source(&url)?;
    let transfer_key = transfer_key.ok_or("二维码缺少迁移密钥")?;
    let device_identity = get_sync_device_identity(app.clone())?;
    let seed = Zeroizing::new(load_sync_signing_seed(&app, &open_db()?)?.ok_or("本机同步身份密钥不可用")?);
    let token = url.path().strip_prefix("/v1/transfer/").ok_or("配对会话格式无效")?;
    let signature = sign_pairing_request(&seed, token, &device_identity.device_id, &client_code);
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(260)).build().map_err(|_| "无法初始化局域网传输")?;
    let mut response = client.get(url)
        .header("x-cloudhub-device-code", &client_code)
        .header("x-cloudhub-device-id", &device_identity.device_id)
        .header("x-cloudhub-device-public-key", &device_identity.public_key)
        .header("x-cloudhub-device-signature", STANDARD.encode(signature))
        .send().await.map_err(|error| {
            if error.is_timeout() {
                "连接电脑迁移服务超时。请确认电脑仍显示本次二维码，并检查路由器是否开启设备隔离。"
            } else if error.is_connect() {
                "无法连接电脑迁移服务。请确认二维码仍有效，并检查电脑防火墙是否允许 CloudHub Tools 接受局域网连接。"
            } else {
                "手机请求电脑迁移服务失败，请重新生成二维码后重试。"
            }
        })?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            403 => "电脑端拒绝了本次迁移请求".into(),
            404 => "二维码已过期或无效，请在电脑端重新生成".into(),
            503 => "电脑端未能显示授权请求，请关闭并重新打开迁移面板".into(),
            _ => "电脑端迁移服务未能完成请求，请重新生成二维码后重试".into(),
        });
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "接收迁移包失败")? {
        if bytes.len() + chunk.len() > 15 * 1024 * 1024 { return Err("迁移包超过允许大小".into()); }
        bytes.extend_from_slice(&chunk);
    }
    let envelope: SyncEnvelope = serde_json::from_slice(&bytes).map_err(|_| "接收到的迁移包格式无效")?;
    let transfer_key = Zeroizing::new(transfer_key);
    let bundle = Zeroizing::new(open_sync_payload::<SyncAccountBundle>(&envelope, transfer_key.as_str())?);
    let preview = preview_sync_bundle(&bundle)?;
    let mut session_bytes = [0u8; 32]; rand::thread_rng().fill_bytes(&mut session_bytes);
    let session_id = URL_SAFE_NO_PAD.encode(session_bytes); session_bytes.fill(0);
    let mut pending = store.pending_qr_import.lock().map_err(|_| "手机迁移预览状态不可用")?;
    *pending = Some(PendingQrImport { session_id: session_id.clone(), bundle, created_at: Instant::now() });
    record_trusted_sync_peer(&source_device_id, &source_public_key)?;
    Ok(SyncTransferFetchResult {
        session_id,
        preview,
        source_device_id,
        source_public_key_fingerprint: hex::encode(&sha2::Sha256::digest(source_public_key)[..8]),
    })
}

fn record_trusted_sync_peer(device_id: &str, public_key: &[u8; 32]) -> PlatformResult<()> {
    let mut conn = open_db()?;
    record_trusted_sync_peer_in(&mut conn, device_id, public_key, Utc::now().timestamp_millis()).map_err(Into::into)
}

fn record_trusted_sync_peer_in(conn: &mut rusqlite::Connection, device_id: &str, public_key: &[u8; 32], now: i64) -> Result<(), String> {
    if Uuid::parse_str(device_id).is_err() || now <= 0 { return Err("配对电脑设备身份无效".into()); }
    let transaction = conn.transaction().map_err(|_| "无法建立电脑设备信任记录".to_string())?;
    use rusqlite::OptionalExtension;
    let local_id: String = transaction.query_row("SELECT device_id FROM sync_local_device WHERE id=1", [], |row| row.get(0)).map_err(|_| "无法读取本机同步身份".to_string())?;
    if device_id == local_id { return Err("配对来源不能是本机设备".into()); }
    let existing: Option<(Vec<u8>, String)> = transaction.query_row("SELECT public_key,status FROM sync_devices WHERE device_id=?1", [device_id], |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(|_| "无法检查电脑设备信任状态".to_string())?;
    match existing {
        Some((known_key, status)) if known_key.as_slice() != public_key || status == "revoked" => return Err("此电脑身份已撤销或密钥不匹配，请重新核对二维码".into()),
        Some((_, status)) if status != "trusted" => return Err("配对电脑尚未获得信任授权".into()),
        Some(_) => { transaction.execute("UPDATE sync_devices SET last_seen_at=?2 WHERE device_id=?1", rusqlite::params![device_id,now]).map_err(|_| "无法更新电脑设备状态".to_string())?; }
        None => {
            let label = format!("配对电脑·{}", &device_id[..8]);
            transaction.execute("INSERT INTO sync_devices(device_id,device_name,public_key,status,created_at,approved_at,last_seen_at) VALUES(?1,?2,?3,'trusted',?4,?4,?4)", rusqlite::params![device_id,label,public_key.as_slice(),now]).map_err(|_| "无法登记配对电脑".to_string())?;
        }
    }
    transaction.commit().map_err(|_| "无法提交电脑设备信任记录".to_string())?;
    Ok(())
}

fn parse_pairing_url(pairing_url: &str) -> PlatformResult<reqwest::Url> {
    let url = reqwest::Url::parse(pairing_url).map_err(|_| "配对二维码格式无效")?;
    let host = url.host_str().ok_or("配对二维码格式无效")?;
    let ip = host.parse::<Ipv4Addr>().map_err(|_| "二维码地址必须是局域网 IPv4 地址")?;
    let port = url.port().ok_or("配对二维码缺少端口")?;
    let token = url.path().strip_prefix("/v1/transfer/").unwrap_or_default();
    let fragment = url.fragment().unwrap_or_default();
    if url.scheme() != "http" || url.username() != "" || url.password().is_some() || url.query().is_some()
        || !is_private_lan_ipv4(ip) || port < 1024 || token.len() != 43 || !token.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_') {
        return Err("配对地址、端口或会话校验无效".into());
    }
    if !fragment.contains('.') || fragment.len() > 180 { return Err("配对二维码缺少电脑设备身份".into()); }
    Ok(url)
}

fn parse_pairing_source(url: &reqwest::Url) -> PlatformResult<(String, [u8; 32], Option<String>)> {
    let mut parts = url.fragment().ok_or("二维码缺少电脑设备身份")?.split('.');
    let device_id = parts.next().ok_or("二维码缺少电脑设备身份")?;
    let encoded_key = parts.next().ok_or("二维码缺少电脑公钥")?;
    let encoded_transfer_key = parts.next();
    if parts.next().is_some() { return Err("二维码迁移参数无效".into()); }
    if Uuid::parse_str(device_id).is_err() { return Err("配对电脑设备 ID 格式无效".into()); }
    let public_key: [u8; 32] = URL_SAFE_NO_PAD.decode(encoded_key).map_err(|_| "配对电脑公钥格式无效")?.try_into().map_err(|_| "配对电脑公钥长度无效")?;
    let transfer_key = encoded_transfer_key.map(|value| {
        let key: [u8; 32] = URL_SAFE_NO_PAD.decode(value).map_err(|_| "二维码迁移密钥格式无效")?.try_into().map_err(|_| "二维码迁移密钥长度无效")?;
        Ok::<String, String>(URL_SAFE_NO_PAD.encode(key))
    }).transpose()?;
    Ok((device_id.to_string(), public_key, transfer_key))
}

#[cfg(test)]
mod transfer_tests {
    use super::*;

    const TOKEN: &str = "aBcDef0123456789_aBcDef0123456789-aBcDef012";

    fn signed_headers(token: &str, code: &str) -> String {
        let device_id = "11111111-1111-4111-8111-111111111111";
        let seed = [7u8; 32];
        let public_key = crate::core::sync_identity::public_key(&seed);
        let signature = sign_pairing_request(&seed, token, device_id, code);
        format!("X-CloudHub-Device-Code: {code}\r\nX-CloudHub-Device-Id: {device_id}\r\nX-CloudHub-Device-Public-Key: {}\r\nX-CloudHub-Device-Signature: {}\r\n", STANDARD.encode(public_key), STANDARD.encode(signature))
    }

    #[test]
    fn reverse_push_receipt_must_match_the_previewed_batch_and_desktop_signature() {
        let source_id = "11111111-1111-4111-8111-111111111111";
        let receiver_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let ids = vec!["22222222-2222-4222-8222-222222222222".to_string(), "33333333-3333-4333-8333-333333333333".to_string()];
        let seed = [9u8; 32];
        let public_key = crate::core::sync_identity::public_key(&seed);
        let mut acknowledgement = SyncDeltaApplyResult {
            source_device_id: source_id.to_string(), receiver_device_id: receiver_id.to_string(), message_ids: ids.clone(),
            signature: STANDARD.encode(sign_sync_ack(&seed, source_id, receiver_id, &ids).unwrap()), added: 1, updated: 1, deleted: 0,
        };
        assert!(verify_push_ack_for_batch(&acknowledgement, source_id, receiver_id, &ids, &public_key).is_ok());
        let truncated = &ids[..1];
        assert!(verify_push_ack_for_batch(&acknowledgement, source_id, receiver_id, truncated, &public_key).is_err());
        assert!(verify_push_ack_for_batch(&acknowledgement, "44444444-4444-4444-8444-444444444444", receiver_id, &ids, &public_key).is_err());
        acknowledgement.signature = STANDARD.encode(sign_sync_ack(&[8u8; 32], source_id, receiver_id, &ids).unwrap());
        assert!(verify_push_ack_for_batch(&acknowledgement, source_id, receiver_id, &ids, &public_key).is_err());
    }

    #[test]
    fn reverse_push_receipt_requires_every_message_to_be_committed_in_the_inbox() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE sync_inbox(peer_device_id TEXT,message_id TEXT,PRIMARY KEY(peer_device_id,message_id));").unwrap();
        let source = "11111111-1111-4111-8111-111111111111";
        let first = "22222222-2222-4222-8222-222222222222".to_string();
        let second = "33333333-3333-4333-8333-333333333333".to_string();
        conn.execute("INSERT INTO sync_inbox VALUES(?1,?2)", rusqlite::params![source, first]).unwrap();
        assert!(ensure_sync_inbox_contains_batch(&conn, source, &["22222222-2222-4222-8222-222222222222".to_string()]).is_ok());
        assert!(ensure_sync_inbox_contains_batch(&conn, source, &["22222222-2222-4222-8222-222222222222".to_string(), second]).is_err());
    }

    #[test]
    fn pairing_urls_are_restricted_to_private_ipv4_and_the_one_time_route() {
        let source_key = URL_SAFE_NO_PAD.encode([7u8; 32]);
        let transfer_key = URL_SAFE_NO_PAD.encode([9u8; 32]);
        let source_fragment = format!("#aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.{source_key}.{transfer_key}");
        let valid_url = format!("http://192.168.1.9:45678/v1/transfer/{TOKEN}{source_fragment}");
        assert!(parse_pairing_url(&valid_url).is_ok());
        let parsed = parse_pairing_url(&valid_url).unwrap();
        let (source_id, parsed_key, parsed_transfer_key) = parse_pairing_source(&parsed).unwrap();
        assert_eq!(source_id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        assert_eq!(parsed_key, [7u8; 32]);
        assert_eq!(parsed_transfer_key, Some(URL_SAFE_NO_PAD.encode([9u8; 32])));
        for unsafe_url in [
            format!("http://8.8.8.8:45678/v1/transfer/{TOKEN}"),
            format!("http://127.0.0.1:45678/v1/transfer/{TOKEN}"),
            format!("http://example.com:45678/v1/transfer/{TOKEN}"),
            format!("http://192.168.1.9:45678/v1/transfer/{TOKEN}?secret=x"),
            format!("http://192.168.1.9:45678/other/{TOKEN}"),
            "http://192.168.1.9:80/v1/transfer/short".to_string(),
        ] {
            assert!(parse_pairing_url(&unsafe_url).is_err(), "accepted {unsafe_url}");
        }
    }

    #[test]
    fn approved_phone_identity_is_persisted_but_revoked_or_replaced_keys_are_rejected() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE sync_devices(device_id TEXT PRIMARY KEY,device_name TEXT NOT NULL,public_key BLOB NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,approved_at INTEGER,last_seen_at INTEGER,revoked_at INTEGER);").unwrap();
        let device_id = "11111111-1111-4111-8111-111111111111";
        let key = crate::core::sync_identity::public_key(&[7u8; 32]);
        conn.execute_batch("CREATE TABLE sync_device_scope(peer_device_id TEXT,entity_type TEXT,entity_sync_id TEXT,granted_at INTEGER,PRIMARY KEY(peer_device_id,entity_type,entity_sync_id));").unwrap();
        let scope = vec![("cloud_account".to_string(), "22222222-2222-4222-8222-222222222222".to_string())];
        record_approved_sync_device_in(&mut conn, device_id, &key, &scope, 10).unwrap();
        let state: (String, Vec<u8>) = conn.query_row("SELECT status,public_key FROM sync_devices WHERE device_id=?1", [device_id], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(state, ("trusted".to_string(), key.to_vec()));
        let stored_scope: i64 = conn.query_row("SELECT COUNT(*) FROM sync_device_scope WHERE peer_device_id=?1", [device_id], |row| row.get(0)).unwrap();
        assert_eq!(stored_scope, 1);
        assert!(record_approved_sync_device_in(&mut conn, device_id, &crate::core::sync_identity::public_key(&[8u8; 32]), &scope, 11).is_err());
        let updated_scope = vec![("managed_host".to_string(), "33333333-3333-4333-8333-333333333333".to_string())];
        record_approved_sync_device_in(&mut conn, device_id, &key, &updated_scope, 12).unwrap();
        let replaced: (i64, i64) = conn.query_row("SELECT SUM(entity_type='cloud_account'),SUM(entity_type='managed_host') FROM sync_device_scope WHERE peer_device_id=?1", [device_id], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(replaced, (0, 1));
        conn.execute("UPDATE sync_devices SET status='revoked' WHERE device_id=?1", [device_id]).unwrap();
        assert!(record_approved_sync_device_in(&mut conn, device_id, &key, &scope, 13).is_err());
    }

    #[test]
    fn device_share_scope_rejects_invalid_and_duplicate_entities() {
        assert!(validate_device_share_scope(&[("cloud_account".to_string(), "not-a-uuid".to_string())]).is_err());
        assert!(validate_device_share_scope(&[("unknown".to_string(), "11111111-1111-4111-8111-111111111111".to_string())]).is_err());
        let duplicate = vec![("cloud_account".to_string(), "11111111-1111-4111-8111-111111111111".to_string()); 2];
        assert!(validate_device_share_scope(&duplicate).unwrap_err().contains("重复"));
    }

    #[test]
    fn scanned_computer_identity_becomes_trusted_only_for_the_exact_key() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE sync_local_device(id INTEGER PRIMARY KEY,device_id TEXT); CREATE TABLE sync_devices(device_id TEXT PRIMARY KEY,device_name TEXT,public_key BLOB,status TEXT,created_at INTEGER,approved_at INTEGER,last_seen_at INTEGER,revoked_at INTEGER); INSERT INTO sync_local_device VALUES(1,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');").unwrap();
        let computer_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let key = crate::core::sync_identity::public_key(&[5u8; 32]);
        record_trusted_sync_peer_in(&mut conn, computer_id, &key, 10).unwrap();
        let stored: (String, Vec<u8>) = conn.query_row("SELECT status,public_key FROM sync_devices WHERE device_id=?1", [computer_id], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(stored, ("trusted".into(), key.to_vec()));
        assert!(record_trusted_sync_peer_in(&mut conn, computer_id, &crate::core::sync_identity::public_key(&[6u8; 32]), 11).is_err());
        conn.execute("UPDATE sync_devices SET status='revoked' WHERE device_id=?1", [computer_id]).unwrap();
        assert!(record_trusted_sync_peer_in(&mut conn, computer_id, &key, 12).is_err());
    }

    #[test]
    fn share_scope_resolves_host_only_and_panel_only_transfers() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE cloud_accounts(id INTEGER PRIMARY KEY,sync_id TEXT); CREATE TABLE managed_hosts(id INTEGER PRIMARY KEY,sync_id TEXT); CREATE TABLE panel_connections(id INTEGER PRIMARY KEY,sync_id TEXT); CREATE TABLE sync_tombstones(entity_type TEXT,entity_sync_id TEXT); INSERT INTO managed_hosts VALUES(4,'33333333-3333-4333-8333-333333333333'); INSERT INTO panel_connections VALUES(8,'44444444-4444-4444-8444-444444444444');").unwrap();
        let host_scope = resolve_device_share_scope_in(&mut conn, &[], &[4], &[], false).unwrap();
        assert_eq!(host_scope, vec![("managed_host".to_string(), "33333333-3333-4333-8333-333333333333".to_string())]);
        let panel_scope = resolve_device_share_scope_in(&mut conn, &[], &[], &[8], false).unwrap();
        assert_eq!(panel_scope, vec![("panel_connection".to_string(), "44444444-4444-4444-8444-444444444444".to_string())]);
    }

    #[test]
    fn device_list_exposes_only_fingerprints_and_revocation_stops_future_authorization() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE sync_local_device(id INTEGER PRIMARY KEY,device_id TEXT); CREATE TABLE sync_device_scope(peer_device_id TEXT,entity_type TEXT,entity_sync_id TEXT,granted_at INTEGER); CREATE TABLE cloud_accounts(sync_id TEXT,account_name TEXT); CREATE TABLE managed_hosts(sync_id TEXT,name TEXT); CREATE TABLE panel_connections(sync_id TEXT,name TEXT); CREATE TABLE sync_devices(device_id TEXT PRIMARY KEY,device_name TEXT,public_key BLOB,status TEXT,created_at INTEGER,approved_at INTEGER,revoked_at INTEGER,last_seen_at INTEGER); INSERT INTO sync_local_device VALUES(1,'99999999-9999-4999-8999-999999999999');").unwrap();
        let phone_id = "11111111-1111-4111-8111-111111111111";
        let key = crate::core::sync_identity::public_key(&[2u8; 32]);
        conn.execute("INSERT INTO sync_devices VALUES(?1,'手机',?2,'trusted',1,2,NULL,3)", rusqlite::params![phone_id,key.as_slice()]).unwrap();
        conn.execute("INSERT INTO sync_device_scope VALUES(?1,'cloud_account','22222222-2222-4222-8222-222222222222',2)", [phone_id]).unwrap();
        conn.execute("INSERT INTO cloud_accounts VALUES('22222222-2222-4222-8222-222222222222','生产账号')", []).unwrap();
        let devices = list_sync_devices_from(&conn).unwrap();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].public_key_fingerprint, hex::encode(&sha2::Sha256::digest(key)[..8]));
        assert_eq!(devices[0].shared_entities.len(), 1);
        assert_eq!(devices[0].shared_entities[0].display_name, "生产账号");
        revoke_sync_device_in(&mut conn, phone_id, 10).unwrap();
        assert_eq!(list_sync_devices_from(&conn).unwrap()[0].status, "revoked");
        assert!(revoke_sync_device_in(&mut conn, phone_id, 11).is_err());
        assert!(revoke_sync_device_in(&mut conn, "99999999-9999-4999-8999-999999999999", 12).unwrap_err().contains("不能撤销本机"));
    }

    #[test]
    fn pending_receipt_cleanup_uses_the_remote_peer_and_exact_batch() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE sync_pending_acknowledgements(peer_device_id TEXT,batch_key TEXT,acknowledgement_json TEXT,created_at INTEGER,PRIMARY KEY(peer_device_id,batch_key));").unwrap();
        let peer = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let receiver = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        let ids = vec!["cccccccc-cccc-4ccc-8ccc-cccccccccccc".to_string()];
        let batch_key = acknowledgement_batch_key(&ids);
        conn.execute("INSERT INTO sync_pending_acknowledgements VALUES(?1,?2,'{}',1)", rusqlite::params![peer,batch_key]).unwrap();

        delete_pending_acknowledgement(&conn, receiver, &ids).unwrap();
        let count_after_wrong_peer: i64 = conn.query_row("SELECT COUNT(*) FROM sync_pending_acknowledgements", [], |row| row.get(0)).unwrap();
        assert_eq!(count_after_wrong_peer, 1, "a receipt must be indexed by its source peer, not the local receiver");
        delete_pending_acknowledgement(&conn, peer, &ids).unwrap();
        let count_after_match: i64 = conn.query_row("SELECT COUNT(*) FROM sync_pending_acknowledgements", [], |row| row.get(0)).unwrap();
        assert_eq!(count_after_match, 0);
    }

    #[tokio::test]
    async fn lan_transfer_requires_the_bearer_route_and_serves_only_once() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let approval = Arc::new(Mutex::new(None));
        let server = tokio::spawn(serve_sync_transfer(listener, TOKEN.to_string(), b"ciphertext-only".to_vec(), approval.clone(), Vec::new(), None, |_| true, |_, _| {}, |_, _, _| Err("unsupported".into())));
        let mut invalid = TcpStream::connect(address).await.unwrap();
        invalid.write_all(b"GET /v1/transfer/wrong HTTP/1.1\r\nHost: localhost\r\n\r\n").await.unwrap();
        let mut rejected = Vec::new();
        invalid.read_to_end(&mut rejected).await.unwrap();
        assert!(String::from_utf8_lossy(&rejected).starts_with("HTTP/1.1 404"));

        let mut body_request = TcpStream::connect(address).await.unwrap();
        body_request.write_all(format!("GET /v1/transfer/{TOKEN} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1\r\n\r\nx").as_bytes()).await.unwrap();
        let mut rejected_body = Vec::new();
        body_request.read_to_end(&mut rejected_body).await.unwrap();
        assert!(String::from_utf8_lossy(&rejected_body).starts_with("HTTP/1.1 404"));

        let mut unsigned = TcpStream::connect(address).await.unwrap();
        unsigned.write_all(format!("GET /v1/transfer/{TOKEN} HTTP/1.1\r\nHost: localhost\r\nX-CloudHub-Device-Code: 123456\r\n\r\n").as_bytes()).await.unwrap();
        let mut rejected_unsigned = Vec::new();
        unsigned.read_to_end(&mut rejected_unsigned).await.unwrap();
        assert!(String::from_utf8_lossy(&rejected_unsigned).starts_with("HTTP/1.1 404"));

        let mut valid = TcpStream::connect(address).await.unwrap();
        valid.write_all(format!("GET /v1/transfer/{TOKEN} HTTP/1.1\r\nHost: localhost\r\n{}\r\n", signed_headers(TOKEN, "123456")).as_bytes()).await.unwrap();
        let sender = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Some(pending) = approval.lock().unwrap().take() { break pending.sender; }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.unwrap();
        let mut first_byte = [0u8; 1];
        assert!(tokio::time::timeout(Duration::from_millis(20), valid.read(&mut first_byte)).await.is_err(), "desktop approval is required before any response");
        sender.send(true).unwrap();
        let mut received = Vec::new();
        valid.read_to_end(&mut received).await.unwrap();
        assert!(String::from_utf8_lossy(&received).starts_with("HTTP/1.1 200"));
        assert!(received.ends_with(b"ciphertext-only"));
        server.await.unwrap();
        assert!(TcpStream::connect(address).await.is_err());
    }

    #[tokio::test]
    async fn denying_a_phone_request_never_sends_the_encrypted_package() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let approval = Arc::new(Mutex::new(None));
        let server = tokio::spawn(serve_sync_transfer(listener, TOKEN.to_string(), b"ciphertext-only".to_vec(), approval.clone(), Vec::new(), None, |_| true, |_, _| {}, |_, _, _| Err("unsupported".into())));
        let mut client = TcpStream::connect(address).await.unwrap();
        client.write_all(format!("GET /v1/transfer/{TOKEN} HTTP/1.1\r\nHost: localhost\r\n{}\r\n", signed_headers(TOKEN, "123456")).as_bytes()).await.unwrap();
        let sender = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Some(pending) = approval.lock().unwrap().take() { break pending.sender; }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.unwrap();
        let mut first_byte = [0u8; 1];
        assert!(tokio::time::timeout(Duration::from_millis(20), client.read(&mut first_byte)).await.is_err());
        sender.send(false).unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 403"));
        assert!(!response.ends_with(b"ciphertext-only"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn delta_transfer_rejects_a_different_trusted_phone_before_approval() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let approval = Arc::new(Mutex::new(None));
        let server = tokio::spawn(serve_sync_transfer(listener, TOKEN.to_string(), b"ciphertext-only".to_vec(), approval.clone(), Vec::new(), Some("22222222-2222-4222-8222-222222222222".to_string()), |_| true, |_, _| {}, |_, _, _| Err("unsupported".into())));
        let mut client = TcpStream::connect(address).await.unwrap();
        client.write_all(format!("GET /v1/transfer/{TOKEN} HTTP/1.1\r\nHost: localhost\r\n{}\r\n", signed_headers(TOKEN, "123456")).as_bytes()).await.unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 403"));
        assert!(approval.lock().unwrap().is_none(), "mismatched device must never reach user approval");
        server.abort();
    }

    #[tokio::test]
    async fn approved_delta_session_returns_only_a_signed_ack_from_the_target_device() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let approval = Arc::new(Mutex::new(None));
        let ack_event = Arc::new(Mutex::new(None));
        let source_id = "22222222-2222-4222-8222-222222222222".to_string();
        let target_id = "11111111-1111-4111-8111-111111111111".to_string();
        let message_id = "33333333-3333-4333-8333-333333333333".to_string();
        let signing_seed = [7u8; 32];
        let public_key = crate::core::sync_identity::public_key(&signing_seed);
        let ids = vec![message_id.clone()];
        let signature = STANDARD.encode(sign_sync_ack(&signing_seed, &source_id, &target_id, &ids).unwrap());
        let event = ack_event.clone();
        let expected_source = source_id.clone();
        let expected_target = target_id.clone();
        let event_target = expected_target.clone();
        let expected_message = message_id.clone();
        let ack_signature = signature.clone();
        let server = tokio::spawn(serve_sync_transfer(
            listener, TOKEN.to_string(), b"signed-encrypted-delta".to_vec(), approval.clone(), Vec::new(), Some(target_id.clone()), |_| true,
            move |device_id, count| { assert_eq!(device_id, event_target); *event.lock().unwrap() = Some(count); },
            move |device_id, message_ids, signature| {
                if device_id != expected_target || message_ids.len() != 1 || message_ids[0] != expected_message || signature != ack_signature { return Err("ack does not match approved receiver".into()); }
                let signature: [u8; 64] = STANDARD.decode(signature).map_err(|_| "bad signature")?.try_into().map_err(|_| "bad signature")?;
                if !verify_sync_ack(&public_key, &signature, &expected_source, &expected_target, message_ids) { return Err("invalid signature".into()); }
                Ok(message_ids.len())
            },
        ));

        let mut receiver = TcpStream::connect(address).await.unwrap();
        receiver.write_all(format!("GET /v1/transfer/{TOKEN} HTTP/1.1\r\nHost: localhost\r\n{}\r\n", signed_headers(TOKEN, "123456")).as_bytes()).await.unwrap();
        let approval_sender = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Some(pending) = approval.lock().unwrap().take() { break pending.sender; }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.unwrap();
        approval_sender.send(true).unwrap();
        let mut bundle_response = Vec::new();
        receiver.read_to_end(&mut bundle_response).await.unwrap();
        assert!(String::from_utf8_lossy(&bundle_response).starts_with("HTTP/1.1 200"));
        assert!(bundle_response.ends_with(b"signed-encrypted-delta"));

        let mut receipt = TcpStream::connect(address).await.unwrap();
        receipt.write_all(format!(
            "POST /v1/transfer/{TOKEN}/ack HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nX-CloudHub-Device-Id: {target_id}\r\nX-CloudHub-Message-Ids: {message_id}\r\nX-CloudHub-Ack-Signature: {signature}\r\n\r\n"
        ).as_bytes()).await.unwrap();
        let mut ack_response = Vec::new();
        receipt.read_to_end(&mut ack_response).await.unwrap();
        assert!(String::from_utf8_lossy(&ack_response).starts_with("HTTP/1.1 204"));
        server.await.unwrap();
        assert_eq!(*ack_event.lock().unwrap(), Some(1));
    }

    #[tokio::test]
    async fn delta_push_request_is_signed_and_contains_no_configuration_body_before_approval() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let request = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let parsed = read_sync_delta_push_headers(&mut stream, TOKEN, "request").await.unwrap();
            assert_eq!(parsed.1, 0, "the approval request must not contain the delta body");
            parsed.0
        });
        let mut client = TcpStream::connect(address).await.unwrap();
        client.write_all(format!("POST /v1/transfer/{TOKEN}/request HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 0\r\n{}\r\n", signed_headers(TOKEN, "123456")).as_bytes()).await.unwrap();
        let verified = request.await.unwrap();
        assert_eq!(verified.device_id, "11111111-1111-4111-8111-111111111111");
        assert_eq!(verified.verification_code, "123456");
    }

    #[test]
    fn delta_push_accepts_only_the_exact_currently_trusted_device_key() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE sync_devices(device_id TEXT PRIMARY KEY,public_key BLOB,status TEXT);").unwrap();
        let device_id = "11111111-1111-4111-8111-111111111111";
        let key = crate::core::sync_identity::public_key(&[7u8; 32]);
        conn.execute("INSERT INTO sync_devices VALUES(?1,?2,'trusted')", rusqlite::params![device_id, key.as_slice()]).unwrap();
        assert!(is_trusted_sync_peer_in(&conn, device_id, &key).unwrap());
        assert!(!is_trusted_sync_peer_in(&conn, device_id, &crate::core::sync_identity::public_key(&[8u8; 32])).unwrap());
        conn.execute("UPDATE sync_devices SET status='revoked' WHERE device_id=?1", [device_id]).unwrap();
        assert!(!is_trusted_sync_peer_in(&conn, device_id, &key).unwrap());
    }

    #[test]
    fn desktop_approval_signature_proves_the_qr_target_accepted_this_code() {
        let desktop_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let seed = [9u8; 32];
        let key = crate::core::sync_identity::public_key(&seed);
        let signature = sign_pairing_request(&seed, TOKEN, desktop_id, "654321");
        assert!(verify_pairing_request(&key, &signature, TOKEN, desktop_id, "654321"));
        assert!(!verify_pairing_request(&key, &signature, TOKEN, desktop_id, "123456"));
        assert!(!verify_pairing_request(&key, &signature, TOKEN, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "654321"));
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncImportPreview {
    protocol_version: u16,
    accounts: Vec<SyncImportAccountPreview>,
    managed_hosts: Vec<SyncImportManagedHostPreview>,
    panels: Vec<SyncImportPanelPreview>,
    deletions: Vec<SyncDeletionPreview>,
    conflicts: Vec<SyncBundleConflict>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncDeltaReview {
    protocol_version: u16,
    source_device_id: String,
    target_device_id: String,
    from_sequence: i64,
    through_sequence: i64,
    change_count: usize,
    conflicts: Vec<SyncBundleConflict>,
    deletions: Vec<SyncDeletionPreview>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncDeltaApplyResult {
    source_device_id: String,
    receiver_device_id: String,
    message_ids: Vec<String>,
    signature: String,
    added: usize,
    updated: usize,
    deleted: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncImportSummary {
    accounts: usize,
    managed_hosts: usize,
    panels: usize,
    added: usize,
    updated: usize,
    deleted: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncImportAccountPreview {
    sync_id: String,
    account_name: String,
    cloud_type: String,
    region_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncImportManagedHostPreview {
    sync_id: String,
    name: String,
    host: String,
    port: u16,
    username: String,
    platform: String,
    auth_method: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncImportPanelPreview {
    sync_id: String,
    name: String,
    panel_url: String,
    allow_insecure_tls: bool,
}

/// Decrypts only inside Rust and returns non-secret review fields for consent UI.
#[tauri::command]
pub(crate) fn preview_sync_account_bundle(envelope: SyncEnvelope, passphrase: String) -> PlatformResult<SyncImportPreview> {
    let passphrase = Zeroizing::new(passphrase);
    let bundle = Zeroizing::new(open_sync_payload::<SyncAccountBundle>(&envelope, passphrase.as_str())?);
    preview_sync_bundle(&bundle)
}

fn preview_sync_bundle(bundle: &SyncAccountBundle) -> PlatformResult<SyncImportPreview> {
    let total = bundle.accounts.len() + bundle.managed_hosts.len() + bundle.panels.len() + bundle.deletions.len();
    if bundle.protocol_version != 1 || total == 0 || total > 100 { return Err("同步包版本或记录数量无效".into()); }
    let conn = open_db()?;
    let conflicts = find_bundle_conflicts(&conn, &bundle)?;
    let deletions = preview_bundle_deletions(&conn, &bundle.deletions)?;
    Ok(SyncImportPreview {
        protocol_version: bundle.protocol_version,
        accounts: bundle.accounts.iter().map(|account| SyncImportAccountPreview {
            sync_id: account.sync_id.clone(), account_name: account.account_name.clone(), cloud_type: account.cloud_type.clone(), region_id: account.region_id.clone(),
        }).collect(),
        managed_hosts: bundle.managed_hosts.iter().map(|host| SyncImportManagedHostPreview {
            sync_id: host.sync_id.clone(), name: host.name.clone(), host: host.host.clone(), port: host.port, username: host.username.clone(),
            platform: host.platform.clone(), auth_method: host.auth_method.clone(),
        }).collect(),
        panels: bundle.panels.iter().map(|panel| SyncImportPanelPreview {
            sync_id: panel.sync_id.clone(), name: panel.name.clone(), panel_url: panel.panel_url.clone(), allow_insecure_tls: panel.allow_insecure_tls,
        }).collect(),
        deletions,
        conflicts,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SyncTransferSelection {
    account_sync_ids: Vec<String>,
    managed_host_sync_ids: Vec<String>,
    panel_sync_ids: Vec<String>,
    include_deletions: bool,
}

#[tauri::command]
pub(crate) fn confirm_sync_transfer_import(
    session_id: String, selection: SyncTransferSelection, store: State<'_, SyncTransferStore>,
) -> PlatformResult<SyncImportSummary> {
    if session_id.len() != 43 || !session_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_') {
        return Err("手机迁移会话无效，请重新扫码".into());
    }
    let pending = store.pending_qr_import.lock().map_err(|_| "手机迁移预览状态不可用")?.take()
        .ok_or("手机迁移预览已失效，请重新扫码")?;
    if pending.session_id != session_id || pending.created_at.elapsed() > Duration::from_secs(600) {
        return Err("手机迁移预览已失效，请重新扫码".into());
    }
    let allowed_accounts = pending.bundle.accounts.iter().map(|item| item.sync_id.as_str()).collect::<std::collections::HashSet<_>>();
    let allowed_hosts = pending.bundle.managed_hosts.iter().map(|item| item.sync_id.as_str()).collect::<std::collections::HashSet<_>>();
    let allowed_panels = pending.bundle.panels.iter().map(|item| item.sync_id.as_str()).collect::<std::collections::HashSet<_>>();
    fn valid_selection<'a>(selected: &'a [String], allowed: &std::collections::HashSet<&str>) -> bool {
        let mut seen = std::collections::HashSet::new();
        selected.len() <= 100 && selected.iter().all(|id| allowed.contains(id.as_str()) && seen.insert(id.as_str()))
    }
    if !valid_selection(&selection.account_sync_ids, &allowed_accounts)
        || !valid_selection(&selection.managed_host_sync_ids, &allowed_hosts)
        || !valid_selection(&selection.panel_sync_ids, &allowed_panels) {
        return Err("手机选择了迁移包之外的配置".into());
    }
    let account_ids = selection.account_sync_ids.iter().map(String::as_str).collect::<std::collections::HashSet<_>>();
    let host_ids = selection.managed_host_sync_ids.iter().map(String::as_str).collect::<std::collections::HashSet<_>>();
    let panel_ids = selection.panel_sync_ids.iter().map(String::as_str).collect::<std::collections::HashSet<_>>();
    let bundle = Zeroizing::new(SyncAccountBundle {
        protocol_version: pending.bundle.protocol_version,
        accounts: pending.bundle.accounts.iter().filter(|item| account_ids.contains(item.sync_id.as_str())).cloned().collect(),
        managed_hosts: pending.bundle.managed_hosts.iter().filter(|item| host_ids.contains(item.sync_id.as_str())).cloned().collect(),
        panels: pending.bundle.panels.iter().filter(|item| panel_ids.contains(item.sync_id.as_str())).cloned().collect(),
        deletions: if selection.include_deletions { pending.bundle.deletions.clone() } else { Vec::new() },
    });
    let total = bundle.accounts.len() + bundle.managed_hosts.len() + bundle.panels.len() + bundle.deletions.len();
    if total == 0 { return Err("至少选择一项配置后再导入".into()); }
    let counts = import_account_bundle(&mut open_db()?, &bundle, Utc::now().timestamp_millis())?;
    Ok(SyncImportSummary { accounts: bundle.accounts.len(), managed_hosts: bundle.managed_hosts.len(), panels: bundle.panels.len(), added: counts.added, updated: counts.updated, deleted: counts.deleted })
}

#[tauri::command]
pub(crate) fn cancel_sync_transfer_import(session_id: String, store: State<'_, SyncTransferStore>) -> PlatformResult<()> {
    let mut pending = store.pending_qr_import.lock().map_err(|_| "手机迁移预览状态不可用")?;
    if pending.as_ref().is_some_and(|item| item.session_id == session_id) { pending.take(); }
    Ok(())
}

/// Reviews an encrypted delta without exposing credentials or applying changes.
#[tauri::command]
pub(crate) fn preview_sync_delta_bundle(envelope: SyncEnvelope, passphrase: String, store: State<'_, SyncTransferStore>) -> PlatformResult<SyncDeltaReview> {
    let passphrase = Zeroizing::new(passphrase);
    let delta = Zeroizing::new(open_sync_payload::<SyncDeltaBundle>(&envelope, passphrase.as_str())?);
    let total = delta.snapshot.accounts.len() + delta.snapshot.managed_hosts.len() + delta.snapshot.panels.len() + delta.snapshot.deletions.len();
    if delta.snapshot.protocol_version != 1 || total > 100 { return Err("增量同步包版本或记录数量无效".into()); }
    let conn = open_db()?;
    verify_delta_source_signature(&conn, &delta)?;
    let envelope_hash: [u8; 32] = sha2::Sha256::digest(serde_json::to_vec(&envelope).map_err(|_| "增量包校验失败")?).into();
    if let Ok(mut pending_slot) = store.pending_push_ack.lock() {
        if let Some(pending) = pending_slot.as_mut() {
            if pending.source_device_id == delta.source_device_id && pending.envelope_hash == envelope_hash {
                let mut ids = delta.changes.iter().map(|change| change.message_id.clone()).collect::<Vec<_>>();
                ids.sort();
                pending.expected_message_ids = Some(ids);
            }
        }
    }
    let mut conflicts = preview_delta_version_conflicts(&conn, &delta)?;
    conflicts.extend(find_bundle_conflicts(&conn, &delta.snapshot)?);
    let deletions = preview_bundle_deletions(&conn, &delta.snapshot.deletions)?;
    Ok(SyncDeltaReview {
        protocol_version: delta.protocol_version,
        source_device_id: delta.source_device_id.clone(),
        target_device_id: delta.target_device_id.clone(),
        from_sequence: delta.from_sequence,
        through_sequence: delta.through_sequence,
        change_count: delta.changes.len(),
        conflicts,
        deletions,
    })
}

fn verify_delta_source_signature(conn: &rusqlite::Connection, delta: &SyncDeltaBundle) -> PlatformResult<()> {
    use rusqlite::OptionalExtension;
    let local_id: String = conn.query_row("SELECT device_id FROM sync_local_device WHERE id=1", [], |row| row.get(0)).map_err(|_| "无法读取本机同步身份")?;
    if delta.target_device_id != local_id { return Err("增量同步批次不是发给本机的".into()); }
    let source_key: Option<(Vec<u8>, String)> = conn.query_row("SELECT public_key,status FROM sync_devices WHERE device_id=?1", [&delta.source_device_id], |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(|_| "无法读取增量同步来源设备")?;
    let Some((source_key, source_status)) = source_key else { return Err("增量同步来源设备未获信任".into()) };
    if source_status != "trusted" { return Err("增量同步来源设备授权已撤销".into()); }
    let source_key: [u8; 32] = source_key.try_into().map_err(|_| "增量同步来源公钥格式无效")?;
    let signature: [u8; 64] = STANDARD.decode(delta.signature.as_deref().ok_or("增量同步批次缺少设备签名")?).map_err(|_| "增量同步签名格式无效")?.try_into().map_err(|_| "增量同步签名长度无效")?;
    let signed_bytes = Zeroizing::new(sync_delta_signing_bytes(delta)?);
    if !verify_sync_delta(&source_key, &signature, &delta.source_device_id, &delta.target_device_id, &signed_bytes) {
        return Err("增量同步来源签名验证失败".into());
    }
    Ok(())
}

/// Applies only a signed batch from a currently trusted device. The repository
/// commits configuration, inbox deduplication, and version state atomically;
/// the response is signed only after that transaction commits.
#[tauri::command]
pub(crate) fn apply_sync_delta_bundle(app: AppHandle, envelope: SyncEnvelope, passphrase: String, resolutions: Vec<SyncDeltaConflictResolution>) -> PlatformResult<SyncDeltaApplyResult> {
    let passphrase = Zeroizing::new(passphrase);
    let delta = Zeroizing::new(open_sync_payload::<SyncDeltaBundle>(&envelope, passphrase.as_str())?);
    let conn = open_db()?;
    verify_delta_source_signature(&conn, &delta)?;
    let local_id: String = conn.query_row("SELECT device_id FROM sync_local_device WHERE id=1", [], |row| row.get(0)).map_err(|_| "无法读取本机同步身份")?;
    let identity = get_sync_device_identity(app.clone())?;
    if identity.device_id != local_id || delta.target_device_id != local_id { return Err("本机同步身份已变化，请重新同步".into()); }
    let seed = Zeroizing::new(load_sync_signing_seed(&app, &conn)?.ok_or("本机同步身份密钥不可用")?);
    drop(conn);
    let mut conn = open_db()?;
    let counts = apply_sync_delta(&mut conn, &delta, &resolutions, Utc::now().timestamp_millis())?;
    let mut message_ids = delta.changes.iter().map(|change| change.message_id.clone()).collect::<Vec<_>>();
    message_ids.sort();
    let signature = STANDARD.encode(sign_sync_ack(&seed, &delta.source_device_id, &local_id, &message_ids)?);
    let acknowledgement = SyncDeltaApplyResult { source_device_id: delta.source_device_id.clone(), receiver_device_id: local_id, message_ids, signature, added: counts.added, updated: counts.updated, deleted: counts.deleted };
    #[cfg(mobile)]
    persist_pending_acknowledgement(&acknowledgement)?;
    Ok(acknowledgement)
}

/// Imports only after the UI has shown the preview and the user explicitly confirms.
#[tauri::command]
pub(crate) fn import_sync_account_bundle(envelope: SyncEnvelope, passphrase: String) -> PlatformResult<SyncImportSummary> {
    let passphrase = Zeroizing::new(passphrase);
    let bundle = Zeroizing::new(open_sync_payload::<SyncAccountBundle>(&envelope, passphrase.as_str())?);
    let counts = import_account_bundle(&mut open_db()?, &bundle, Utc::now().timestamp_millis())?;
    Ok(SyncImportSummary {
        accounts: bundle.accounts.len(), managed_hosts: bundle.managed_hosts.len(), panels: bundle.panels.len(),
        added: counts.added, updated: counts.updated, deleted: counts.deleted,
    })
}
