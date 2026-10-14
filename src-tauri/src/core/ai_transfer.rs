use crate::core::repositories::ai::{self, Profile};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
    time::{Duration, Instant},
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub profile: Profile,
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
    let selected = ids.iter().collect::<HashSet<_>>();
    if ids.is_empty() || ids.len() > 20 || selected.len() != ids.len() {
        return Err("请选择1～20个AI配置".into());
    }
    let mut records = Vec::new();
    for mut profile in ai::list(conn)?
        .into_iter()
        .filter(|p| selected.contains(&p.id))
    {
        profile.has_key = false;
        records.push(Record { profile });
    }
    if records.len() != ids.len() {
        return Err("所选AI配置已变化，请刷新后重试".into());
    }
    Ok(Payload {
        kind: "cloudhub-ai-config".into(),
        version: 2,
        records,
    })
}
pub fn validate(payload: &Payload) -> Result<(), String> {
    if payload.kind != "cloudhub-ai-config"
        || payload.version != 2
        || payload.records.is_empty()
        || payload.records.len() > 20
    {
        return Err("AI迁移包类型、版本或数量无效".into());
    }
    let mut ids = HashSet::new();
    for record in &payload.records {
        let p = &record.profile;
        if !ids.insert(&p.id)
            || uuid::Uuid::parse_str(&p.id).is_err()
            || p.name.trim().is_empty()
            || p.name.len() > 120
            || p.base_url.len() > 512
            || p.has_key
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
    let tx = conn
        .transaction()
        .map_err(|_| "导入AI配置失败，未写入任何配置")?;
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
        // Imported endpoints are always disabled until the user reviews and enables them.
        let id = uuid::Uuid::new_v4().to_string();
        tx.execute("INSERT INTO ai_profiles(id,name,protocol,base_url,model,key_ciphertext,enabled,is_default,timeout_seconds,max_output_tokens,allow_loopback_http,updated_at) VALUES(?1,?2,?3,?4,?5,'',0,0,?6,?7,?8,?9)",params![id,name,p.protocol,p.base_url,p.model,p.timeout_seconds,p.max_output_tokens,p.allow_loopback_http,chrono::Utc::now().timestamp_millis()]).map_err(|_|"导入AI配置失败，未写入任何配置")?;
        let models = ai::normalize_models(&p.base_url, &p.protocol, &p.model, &p.models, p.allow_loopback_http)?;
        tx.execute("UPDATE ai_profiles SET models_json=?2 WHERE id=?1", params![id, serde_json::to_string(&models).map_err(|_| "模型配置无效")?]).map_err(|_| "导入AI配置失败，未写入任何配置")?;
    }
    tx.commit().map_err(|_| "导入AI配置失败，未写入任何配置")?;
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
            } }
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
