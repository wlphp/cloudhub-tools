use crate::core::repositories::ai::{self, Profile};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;
use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
    time::{Duration, Instant},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub profile: Profile,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}
impl Zeroize for Record {
    fn zeroize(&mut self) { if let Some(key) = self.api_key.as_mut() { key.zeroize(); } }
}
impl Drop for Record {
    fn drop(&mut self) {
        if let Some(key) = self.api_key.as_mut() { key.zeroize(); }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Payload {
    pub kind: String,
    pub version: u16,
    pub records: Vec<Record>,
}
pub struct Pending {
    pub created: Instant,
    pub payload: Payload,
}
#[derive(Default)]
pub struct ImportStore {
    pub pending: Mutex<HashMap<String, Pending>>,
}
impl ImportStore {
    pub fn prune(pending: &mut HashMap<String, Pending>) {
        pending.retain(|_, v| v.created.elapsed() < Duration::from_secs(600));
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub token: String,
    pub profiles: Vec<Profile>,
}

pub fn export(conn: &Connection, ids: &[String]) -> Result<Payload, String> {
    export_with(conn, ids, crate::core::crypto::decrypt_secret)
}
fn export_with(conn: &Connection, ids: &[String], decrypt: impl Fn(&str) -> Result<String, String>) -> Result<Payload, String> {
    let selected = ids.iter().collect::<HashSet<_>>();
    if ids.is_empty() || ids.len() > 20 || selected.len() != ids.len() {
        return Err("请选择1～20个AI配置".into());
    }
    let mut records = Vec::new();
    for profile in ai::list(conn)?
        .into_iter()
        .filter(|p| selected.contains(&p.id))
    {
        let api_key = if profile.has_key {
            let cipher: String = conn.query_row("SELECT key_ciphertext FROM ai_profiles WHERE id=?1", [&profile.id], |row| row.get(0)).map_err(|_| "读取AI密钥失败")?;
            Some(decrypt(&cipher).map_err(|_| "解密AI密钥失败")?)
        } else { None };
        records.push(Record { profile, api_key });
    }
    if records.len() != ids.len() {
        return Err("所选AI配置已变化，请刷新后重试".into());
    }
    Ok(Payload {
        kind: "cloudhub-ai-config".into(),
        version: 3,
        records,
    })
}
pub fn validate(payload: &Payload) -> Result<(), String> {
    if payload.kind != "cloudhub-ai-config"
        || !matches!(payload.version, 2 | 3)
        || payload.records.is_empty()
        || payload.records.len() > 20
    {
        return Err("AI迁移包类型、版本或数量无效".into());
    }
    let mut ids = HashSet::new();
    let mut defaults = 0;
    for record in &payload.records {
        let p = &record.profile;
        if payload.version == 3 && p.is_default { defaults += 1; }
        let key = record.api_key.as_deref().unwrap_or("");
        if !ids.insert(&p.id)
            || uuid::Uuid::parse_str(&p.id).is_err()
            || p.name.trim().is_empty()
            || p.name.len() > 120
            || p.base_url.len() > 512
            || (payload.version == 2 && (p.has_key || record.api_key.is_some()))
            || (payload.version == 3 && (p.has_key != !key.is_empty() || (p.enabled && key.is_empty())))
            || key.len() > 4096 || key.chars().any(char::is_control) || (!key.is_empty() && key.trim().is_empty())
            || !matches!(p.vision_status.as_str(), "unknown" | "supported" | "unsupported")
            || defaults > 1
            || !(5..=180).contains(&p.timeout_seconds)
            || !(128..=8192).contains(&p.max_output_tokens)
        {
            return Err("AI迁移配置字段无效".into());
        }
        ai::normalize_models(&p.base_url, &p.protocol, &p.model, &p.models, p.allow_loopback_http)?;
    }
    Ok(())
}
pub fn import(conn: &mut Connection, payload: &Payload, ids: &[String]) -> Result<usize, String> {
    import_with(conn, payload, ids, crate::core::crypto::encrypt_secret)
}
fn import_with(conn: &mut Connection, payload: &Payload, ids: &[String], encrypt: impl Fn(&str) -> Result<String, String>) -> Result<usize, String> {
    let tx = conn.transaction().map_err(|_| "导入AI配置失败，未写入任何配置")?;
    let count = import_into_with(&tx, payload, ids, encrypt)?;
    tx.commit().map_err(|_| "导入AI配置失败，未写入任何配置")?;
    Ok(count)
}
// The caller owns the transaction so mixed configuration imports remain atomic.
pub(crate) fn import_into_with(conn: &Connection, payload: &Payload, ids: &[String], encrypt: impl Fn(&str) -> Result<String, String>) -> Result<usize, String> {
    validate(payload)?;
    let selected = ids.iter().collect::<HashSet<_>>();
    let allowed = payload
        .records
        .iter()
        .map(|r| &r.profile.id)
        .collect::<HashSet<_>>();
    if selected.is_empty() || selected.len() != ids.len() || !selected.is_subset(&allowed) {
        return Err("请选择迁移预览中的有效AI配置".into());
    }
    let existing = ai::list(conn)?;
    if existing.len() + selected.len() > 20 {
        return Err("导入后AI配置将超过20个，请先整理配置".into());
    }
    let mut names = existing
        .iter()
        .map(|p| p.name.clone())
        .collect::<HashSet<_>>();
    let restore = payload.version == 3;
    if restore && payload.records.iter().any(|r| selected.contains(&r.profile.id) && r.profile.is_default) {
        conn.execute("UPDATE ai_profiles SET is_default=0 WHERE is_default=1", []).map_err(|_| "导入AI配置失败，未写入任何配置")?;
    }
    for record in payload
        .records
        .iter()
        .filter(|r| selected.contains(&r.profile.id))
    {
        let p = &record.profile;
        let mut name = p.name.clone();
        let mut suffix = 1;
        while names.contains(&name) {
            name = format!(
                "{}（导入{}）",
                p.name.chars().take(24).collect::<String>(),
                suffix
            );
            suffix += 1;
        }
        names.insert(name.clone());
        let cipher = match record.api_key.as_deref().filter(|key| !key.is_empty()) {
            Some(key) => encrypt(key).map_err(|_| "加密AI密钥失败，未写入任何配置")?,
            None => String::new(),
        };
        let id = uuid::Uuid::new_v4().to_string();
        let revision = chrono::Utc::now().timestamp_millis();
        conn.execute("INSERT INTO ai_profiles(id,name,protocol,base_url,model,key_ciphertext,enabled,is_default,timeout_seconds,max_output_tokens,allow_loopback_http,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",params![id,name,p.protocol,p.base_url,p.model,cipher,restore && p.enabled,restore && p.is_default,p.timeout_seconds,p.max_output_tokens,p.allow_loopback_http,revision]).map_err(|_|"导入AI配置失败，未写入任何配置")?;
        let models = ai::normalize_models(&p.base_url, &p.protocol, &p.model, &p.models, p.allow_loopback_http)?;
        conn.execute("UPDATE ai_profiles SET models_json=?2 WHERE id=?1", params![id, serde_json::to_string(&models).map_err(|_| "模型配置无效")?]).map_err(|_| "导入AI配置失败，未写入任何配置")?;
        if restore && p.vision_status != "unknown" {
            conn.execute("INSERT INTO ai_capabilities(profile_id,config_revision,vision_status,checked_at) VALUES(?1,?2,?3,?2)", params![id,revision,p.vision_status]).map_err(|_| "导入AI配置失败，未写入任何配置")?;
        }
    }
    Ok(selected.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(id: &str) -> Record {
        Record { profile: Profile {
                id: id.into(),
                name: "fixture".into(),
                protocol: "claude".into(),
                base_url: "https://example.test".into(),
                model: "fixture".into(),
                models: vec!["fixture".into(), "fixture-other".into()],
                enabled: true,
                is_default: true,
                timeout_seconds: 60,
                max_output_tokens: 512,
                allow_loopback_http: false,
                has_key: false,
                updated_at: 1,
                vision_status:"unknown".into(),
            }, api_key: None }
    }
    #[test]
    fn complete_transfer_restores_keys_models_and_state_with_local_encryption() {
        let mut source = Connection::open_in_memory().unwrap();
        source.execute_batch(ai::SCHEMA).unwrap();
        let mut original = record("11111111-1111-4111-8111-111111111111");
        original.profile.has_key = true;
        original.profile.vision_status = "supported".into();
        original.api_key = Some(uuid::Uuid::new_v4().to_string());
        let mut disabled = record("22222222-2222-4222-8222-222222222222");
        disabled.profile.enabled = false;
        disabled.profile.is_default = false;
        let packet = Payload { kind: "cloudhub-ai-config".into(), version: 3, records: vec![original, disabled] };
        let ids = packet.records.iter().map(|r| r.profile.id.clone()).collect::<Vec<_>>();
        let source_key = [1u8; 32];
        import_with(&mut source, &packet, &ids, |s| crate::core::crypto::encrypt_secret_with_key(s, &source_key)).unwrap();
        let source_ids = ai::list(&source).unwrap().iter().map(|p| p.id.clone()).collect::<Vec<_>>();
        let exported = export_with(&source, &source_ids, |s| crate::core::crypto::decrypt_secret_with_key(s, &source_key)).unwrap();
        let bytes = zeroize::Zeroizing::new(serde_json::to_vec(&exported).unwrap());
        let reopened: Payload = serde_json::from_slice(&bytes).unwrap();
        let mut target = Connection::open_in_memory().unwrap();
        target.execute_batch(ai::SCHEMA).unwrap();
        target.execute("INSERT INTO ai_profiles(id,name,protocol,base_url,model,key_ciphertext,is_default,updated_at) VALUES('existing','fixture','claude','https://example.test','fixture','',1,1)", []).unwrap();
        let target_key = [2u8; 32];
        let selected = reopened.records.iter().map(|r| r.profile.id.clone()).collect::<Vec<_>>();
        import_with(&mut target, &reopened, &selected, |s| crate::core::crypto::encrypt_secret_with_key(s, &target_key)).unwrap();
        let rows = ai::list(&target).unwrap();
        assert_eq!(rows.len(), 3);
        let restored = rows.iter().find(|p| p.is_default).unwrap();
        assert!(restored.enabled && restored.has_key);
        assert_eq!(restored.models, vec!["fixture", "fixture-other"]);
        assert_eq!(restored.vision_status, "supported");
        assert_ne!(restored.name, "fixture");
        assert!(rows.iter().any(|p| !p.enabled && !p.has_key));
        let cipher: String = target.query_row("SELECT key_ciphertext FROM ai_profiles WHERE id=?1", [&restored.id], |r| r.get(0)).unwrap();
        let plain = zeroize::Zeroizing::new(crate::core::crypto::decrypt_secret_with_key(&cipher, &target_key).unwrap());
        assert!(Some(plain.as_str()) == packet.records[0].api_key.as_deref());
        assert!(!serde_json::to_string(&rows).unwrap().contains(plain.as_str()));
        assert!(crate::core::crypto::decrypt_secret_with_key(&cipher, &source_key).is_err());
    }
    #[test]
    fn complete_transfer_rejects_invalid_state_and_rolls_back_default_on_failure() {
        let mut r = record("11111111-1111-4111-8111-111111111111");
        r.api_key = Some(uuid::Uuid::new_v4().to_string());
        r.profile.has_key = true;
        let mut packet = Payload { kind: "cloudhub-ai-config".into(), version: 3, records: vec![r] };
        let ids = vec![packet.records[0].profile.id.clone()];
        let mut conn = Connection::open_in_memory().unwrap(); conn.execute_batch(ai::SCHEMA).unwrap();
        conn.execute("INSERT INTO ai_profiles(id,name,protocol,base_url,model,key_ciphertext,is_default,updated_at) VALUES('existing','fixture','claude','https://example.test','fixture','',1,1)", []).unwrap();
        assert!(import_with(&mut conn, &packet, &ids, |_| Err("failure".into())).is_err());
        assert_eq!(ai::list(&conn).unwrap().len(), 1);
        assert!(ai::list(&conn).unwrap()[0].is_default);
        packet.records[0].api_key = None;
        assert!(validate(&packet).is_err());
        packet.records[0].profile.has_key = false;
        assert!(validate(&packet).is_err());
        packet.records[0].profile.enabled = false;
        assert!(validate(&packet).is_ok());
        packet.version = 99;
        assert!(validate(&packet).is_err());
    }
    #[test]
    fn config_transfer_excludes_keys_and_confirm_append_without_overwrite() {
        let payload = Payload {
            kind: "cloudhub-ai-config".into(),
            version: 2,
            records: vec![record("11111111-1111-4111-8111-111111111111"), record("22222222-2222-4222-8222-222222222222")],
        };
        let serialized = serde_json::to_string(&payload).unwrap();
        assert!(!serialized.contains("apiKey"));
        assert!(!serialized.contains("test-only-transferred-key"));
        let opened: Payload = serde_json::from_str(&serialized).unwrap();
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(ai::SCHEMA).unwrap();
        let ids = opened
            .records
            .iter()
            .map(|r| r.profile.id.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            import(&mut conn, &opened, &ids).unwrap(),
            2
        );
        let rows = ai::list(&conn).unwrap();
        assert!(rows.iter().all(|p| !p.enabled && !p.is_default));
        assert!(rows.iter().all(|p| p.models == vec!["fixture", "fixture-other"]));
        assert!(rows.iter().any(|p| !p.has_key));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM ai_profiles WHERE length(key_ciphertext)>0", [], |r| r.get::<_, usize>(0)).unwrap(), 0);
        assert_eq!(import(&mut conn, &opened, &ids).unwrap(), 2);
        assert_eq!(ai::list(&conn).unwrap().len(), 4);
        assert!(import(&mut conn, &opened, &["missing".into()]).is_err());
        assert_eq!(ai::list(&conn).unwrap().len(), 4);
    }
}

pub(crate) fn migration_payload(records: &[Record]) -> Payload {
    Payload { kind: "cloudhub-ai-config".into(), version: 3, records: records.to_vec() }
}
pub(crate) fn validate_migration(records: &[Record], protocol_version: u16) -> Result<(), String> {
    if records.is_empty() { return Ok(()); }
    if protocol_version < 4 { return Err("AI配置迁移需要第四版协议，请更新两端应用".into()); }
    validate(&migration_payload(records))
}
