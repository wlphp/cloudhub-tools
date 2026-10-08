use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::RngCore;
use rusqlite::{params, Connection};
use serde::Serialize;
use uuid::Uuid;
use zeroize::Zeroizing;

pub const IDENTITY_SEED_PREFERENCE: &str = "sync.identity.signing_seed";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalSyncIdentity {
    pub device_id: String,
    pub public_key: String,
}

pub fn new_signing_seed() -> Zeroizing<[u8; 32]> {
    let mut seed = Zeroizing::new([0u8; 32]);
    rand::thread_rng().fill_bytes(&mut seed[..]);
    seed
}

pub fn public_key(seed: &[u8; 32]) -> [u8; 32] {
    SigningKey::from_bytes(seed).verifying_key().to_bytes()
}

pub fn sign_pairing_request(seed: &[u8; 32], token: &str, device_id: &str, code: &str) -> [u8; 64] {
    let message = pairing_request_message(token, device_id, code);
    SigningKey::from_bytes(seed).sign(&message).to_bytes()
}

pub fn verify_pairing_request(public_key: &[u8; 32], signature: &[u8; 64], token: &str, device_id: &str, code: &str) -> bool {
    let Ok(key) = VerifyingKey::from_bytes(public_key) else { return false };
    key.verify(&pairing_request_message(token, device_id, code), &Signature::from_bytes(signature)).is_ok()
}

pub fn sign_sync_ack(seed: &[u8; 32], sender_device_id: &str, receiver_device_id: &str, message_ids: &[String]) -> Result<[u8; 64], String> {
    let message = sync_ack_message(sender_device_id, receiver_device_id, message_ids)?;
    Ok(SigningKey::from_bytes(seed).sign(&message).to_bytes())
}

pub fn verify_sync_ack(public_key: &[u8; 32], signature: &[u8; 64], sender_device_id: &str, receiver_device_id: &str, message_ids: &[String]) -> bool {
    let Ok(message) = sync_ack_message(sender_device_id, receiver_device_id, message_ids) else { return false };
    let Ok(key) = VerifyingKey::from_bytes(public_key) else { return false };
    key.verify(&message, &Signature::from_bytes(signature)).is_ok()
}

pub fn sign_sync_delta(seed: &[u8; 32], sender_device_id: &str, receiver_device_id: &str, payload: &[u8]) -> Result<[u8; 64], String> {
    let message = Zeroizing::new(sync_delta_message(sender_device_id, receiver_device_id, payload)?);
    Ok(SigningKey::from_bytes(seed).sign(&message).to_bytes())
}

pub fn verify_sync_delta(public_key: &[u8; 32], signature: &[u8; 64], sender_device_id: &str, receiver_device_id: &str, payload: &[u8]) -> bool {
    let Ok(message) = sync_delta_message(sender_device_id, receiver_device_id, payload).map(Zeroizing::new) else { return false };
    let Ok(key) = VerifyingKey::from_bytes(public_key) else { return false };
    key.verify(&message, &Signature::from_bytes(signature)).is_ok()
}

fn sync_delta_message(sender_device_id: &str, receiver_device_id: &str, payload: &[u8]) -> Result<Vec<u8>, String> {
    if Uuid::parse_str(sender_device_id).is_err() || Uuid::parse_str(receiver_device_id).is_err() || payload.is_empty() || payload.len() > 8 * 1024 * 1024 {
        return Err("增量同步签名参数无效".into());
    }
    let mut message = b"cloudhub-tools:sync-delta:v1\0".to_vec();
    message.extend_from_slice(sender_device_id.as_bytes());
    message.push(0);
    message.extend_from_slice(receiver_device_id.as_bytes());
    message.push(0);
    message.extend_from_slice(payload);
    Ok(message)
}

fn sync_ack_message(sender_device_id: &str, receiver_device_id: &str, message_ids: &[String]) -> Result<Vec<u8>, String> {
    if Uuid::parse_str(sender_device_id).is_err() || Uuid::parse_str(receiver_device_id).is_err()
        || message_ids.is_empty() || message_ids.len() > 100 {
        return Err("同步回执参数无效".into());
    }
    let mut canonical_ids = message_ids.to_vec();
    if canonical_ids.iter().any(|id| Uuid::parse_str(id).is_err()) { return Err("同步回执消息 ID 无效".into()); }
    canonical_ids.sort_unstable();
    if canonical_ids.windows(2).any(|pair| pair[0] == pair[1]) { return Err("同步回执包含重复消息".into()); }
    let mut message = format!("cloudhub-tools:sync-ack:v1\0{sender_device_id}\0{receiver_device_id}\0{}\0", canonical_ids.len()).into_bytes();
    for id in canonical_ids { message.extend_from_slice(id.as_bytes()); message.push(0); }
    Ok(message)
}

fn pairing_request_message(token: &str, device_id: &str, code: &str) -> Vec<u8> {
    format!("cloudhub-tools:lan-pairing:v1\0{token}\0{device_id}\0{code}").into_bytes()
}

/// Bind the platform-held signing seed to this database's local device row.
/// If the database remembers a public key but the OS key store lost its seed,
/// rotate the device identity and clear every old trust/sync cursor first.
pub fn bind_local_identity(conn: &mut Connection, seed: &[u8; 32], now: i64) -> Result<LocalSyncIdentity, String> {
    if now <= 0 { return Err("本机同步身份时间无效".into()); }
    let public_key = public_key(seed);
    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    let row: (String, Option<Vec<u8>>) = transaction.query_row(
        "SELECT device_id,public_key FROM sync_local_device WHERE id=1", [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(|error| format!("读取本机同步设备身份失败: {error}"))?;

    let device_id = match row.1 {
        Some(stored) if stored.len() == 32 && stored == public_key => row.0,
        Some(_) => return Err("本机同步身份密钥与数据库绑定不匹配；为避免误认设备，已拒绝继续".into()),
        None => {
            transaction.execute("UPDATE sync_local_device SET public_key=?1 WHERE id=1", [public_key.as_slice()]).map_err(|error| error.to_string())?;
            row.0
        }
    };
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(LocalSyncIdentity { device_id, public_key: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, public_key) })
}

pub fn reset_after_identity_loss(conn: &mut Connection, now: i64) -> Result<String, String> {
    if now <= 0 { return Err("本机同步身份时间无效".into()); }
    let next_device_id = Uuid::new_v4().to_string();
    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    transaction.execute("DELETE FROM sync_entity_versions", []).map_err(|error| error.to_string())?;
    transaction.execute("DELETE FROM sync_outbox_acknowledgements", []).map_err(|error| error.to_string())?;
    transaction.execute("DELETE FROM sync_inbox", []).map_err(|error| error.to_string())?;
    transaction.execute("DELETE FROM sync_pending_acknowledgements", []).map_err(|error| error.to_string())?;
    transaction.execute("DELETE FROM sync_devices", []).map_err(|error| error.to_string())?;
    transaction.execute("DELETE FROM sync_outbox", []).map_err(|error| error.to_string())?;
    transaction.execute("DELETE FROM sync_tombstones", []).map_err(|error| error.to_string())?;
    transaction.execute("DELETE FROM sync_local_versions", []).map_err(|error| error.to_string())?;
    transaction.execute("UPDATE sync_local_device SET device_id=?1,device_name='本机',created_at=?2,public_key=NULL WHERE id=1", params![next_device_id, now]).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(next_device_id)
}

#[cfg(test)]
mod tests {
    use super::{bind_local_identity, public_key, reset_after_identity_loss, sign_pairing_request, sign_sync_ack, sign_sync_delta, verify_pairing_request, verify_sync_ack, verify_sync_delta};
    use rusqlite::Connection;

    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE sync_local_device(id INTEGER PRIMARY KEY,device_id TEXT,device_name TEXT,created_at INTEGER,public_key BLOB); CREATE TABLE sync_devices(device_id TEXT PRIMARY KEY); CREATE TABLE sync_entity_versions(peer_device_id TEXT,entity_type TEXT,entity_sync_id TEXT); CREATE TABLE sync_outbox_acknowledgements(message_id TEXT,peer_device_id TEXT); CREATE TABLE sync_outbox(message_id TEXT); CREATE TABLE sync_inbox(peer_device_id TEXT,message_id TEXT); CREATE TABLE sync_pending_acknowledgements(peer_device_id TEXT,batch_key TEXT,acknowledgement_json TEXT,created_at INTEGER); CREATE TABLE sync_tombstones(entity_type TEXT,entity_sync_id TEXT); CREATE TABLE sync_local_versions(entity_type TEXT,entity_sync_id TEXT); INSERT INTO sync_local_device VALUES(1,'local-1','本机',1,NULL); INSERT INTO sync_devices VALUES('peer-1'); INSERT INTO sync_entity_versions VALUES('peer-1','cloud_account','item-1'); INSERT INTO sync_outbox_acknowledgements VALUES('message-1','peer-1'); INSERT INTO sync_outbox VALUES('message-1'); INSERT INTO sync_inbox VALUES('peer-1','received-message'); INSERT INTO sync_pending_acknowledgements VALUES('peer-1','batch','{}',1); INSERT INTO sync_tombstones VALUES('cloud_account','item-2'); INSERT INTO sync_local_versions VALUES('cloud_account','item-1');").unwrap();
        conn
    }

    #[test]
    fn public_identity_binding_never_returns_or_stores_the_seed() {
        let mut conn = fixture();
        let seed = [7u8; 32];
        let identity = bind_local_identity(&mut conn, &seed, 10).unwrap();
        assert_eq!(identity.device_id, "local-1");
        assert_eq!(identity.public_key, base64::Engine::encode(&base64::engine::general_purpose::STANDARD, public_key(&seed)));
        let stored: Vec<u8> = conn.query_row("SELECT public_key FROM sync_local_device WHERE id=1", [], |row| row.get(0)).unwrap();
        assert_eq!(stored, public_key(&seed));
        assert!(!identity.public_key.is_empty());
    }

    #[test]
    fn derives_the_rfc8032_ed25519_public_key_vector() {
        let seed: [u8; 32] = hex::decode("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60").unwrap().try_into().unwrap();
        assert_eq!(hex::encode(public_key(&seed)), "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
    }

    #[test]
    fn losing_a_bound_seed_rotates_identity_and_clears_old_trust_state() {
        let mut conn = fixture();
        bind_local_identity(&mut conn, &[8u8; 32], 10).unwrap();
        let old_id = "local-1";
        let new_id = reset_after_identity_loss(&mut conn, 20).unwrap();
        assert_ne!(new_id, old_id);
        let (stored_id, public_key): (String, Option<Vec<u8>>) = conn.query_row("SELECT device_id,public_key FROM sync_local_device WHERE id=1", [], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(stored_id, new_id);
        assert!(public_key.is_none());
        for table in ["sync_devices","sync_entity_versions","sync_outbox_acknowledgements","sync_outbox","sync_inbox","sync_pending_acknowledgements","sync_tombstones","sync_local_versions"] {
            let count: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0)).unwrap();
            assert_eq!(count, 0, "{table} must be cleared after key loss");
        }
    }

    #[test]
    fn database_public_key_mismatch_fails_closed() {
        let mut conn = fixture();
        bind_local_identity(&mut conn, &[1u8; 32], 10).unwrap();
        assert!(bind_local_identity(&mut conn, &[2u8; 32], 11).unwrap_err().contains("不匹配"));
    }

    #[test]
    fn lan_pairing_signature_proves_device_key_and_binds_token_and_code() {
        let seed = [3u8; 32];
        let key = public_key(&seed);
        let signature = sign_pairing_request(&seed, "token-a", "device-a", "123456");
        assert!(verify_pairing_request(&key, &signature, "token-a", "device-a", "123456"));
        assert!(!verify_pairing_request(&key, &signature, "token-b", "device-a", "123456"));
        assert!(!verify_pairing_request(&key, &signature, "token-a", "device-a", "654321"));
        assert!(!verify_pairing_request(&public_key(&[4u8; 32]), &signature, "token-a", "device-a", "123456"));
    }

    #[test]
    fn sync_ack_signature_is_device_and_message_bound_and_order_independent() {
        let seed = [9u8; 32];
        let key = public_key(&seed);
        let sender = "11111111-1111-4111-8111-111111111111";
        let receiver = "22222222-2222-4222-8222-222222222222";
        let first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string();
        let second = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string();
        let signature = sign_sync_ack(&seed, sender, receiver, &[first.clone(), second.clone()]).unwrap();
        assert!(verify_sync_ack(&key, &signature, sender, receiver, &[second.clone(), first.clone()]));
        assert!(!verify_sync_ack(&key, &signature, sender, "33333333-3333-4333-8333-333333333333", &[first.clone(), second.clone()]));
        assert!(!verify_sync_ack(&public_key(&[8u8; 32]), &signature, sender, receiver, &[first.clone(), second.clone()]));
        assert!(sign_sync_ack(&seed, sender, receiver, &[first.clone(), first]).is_err());
    }

    #[test]
    fn sync_delta_signature_authenticates_payload_and_both_device_ids() {
        let seed = [19u8; 32];
        let sender = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let receiver = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        let signature = sign_sync_delta(&seed, sender, receiver, b"canonical encrypted config metadata").unwrap();
        let public_key = public_key(&seed);
        assert!(verify_sync_delta(&public_key, &signature, sender, receiver, b"canonical encrypted config metadata"));
        assert!(!verify_sync_delta(&public_key, &signature, sender, receiver, b"tampered"));
        assert!(!verify_sync_delta(&public_key, &signature, receiver, sender, b"canonical encrypted config metadata"));
    }
}
