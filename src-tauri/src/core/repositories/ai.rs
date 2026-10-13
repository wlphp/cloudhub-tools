use crate::core::crypto::{decrypt_secret, encrypt_secret};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

pub const CAPABILITIES_SCHEMA:&str="CREATE TABLE IF NOT EXISTS ai_capabilities(profile_id TEXT PRIMARY KEY REFERENCES ai_profiles(id) ON DELETE CASCADE,config_revision INTEGER NOT NULL,vision_status TEXT NOT NULL CHECK(vision_status IN ('supported','unsupported')),checked_at INTEGER NOT NULL);";
pub const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS ai_profiles(id TEXT PRIMARY KEY,name TEXT NOT NULL,protocol TEXT NOT NULL,base_url TEXT NOT NULL,model TEXT NOT NULL,key_ciphertext TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,is_default INTEGER NOT NULL DEFAULT 0,timeout_seconds INTEGER NOT NULL DEFAULT 60,max_output_tokens INTEGER NOT NULL DEFAULT 2048,allow_loopback_http INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS ai_one_default ON ai_profiles(is_default) WHERE is_default=1; CREATE TABLE IF NOT EXISTS ai_capabilities(profile_id TEXT PRIMARY KEY REFERENCES ai_profiles(id) ON DELETE CASCADE,config_revision INTEGER NOT NULL,vision_status TEXT NOT NULL CHECK(vision_status IN ('supported','unsupported')),checked_at INTEGER NOT NULL);";
fn unknown_vision() -> String {
    "unknown".into()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub base_url: String,
    pub model: String,
    pub enabled: bool,
    pub is_default: bool,
    pub timeout_seconds: u64,
    pub max_output_tokens: u32,
    pub allow_loopback_http: bool,
    pub has_key: bool,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default = "unknown_vision")]
    pub vision_status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveProfile {
    pub id: Option<String>,
    pub name: String,
    pub protocol: String,
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
    pub enabled: bool,
    pub is_default: bool,
    pub timeout_seconds: u64,
    pub max_output_tokens: u32,
    pub allow_loopback_http: bool,
}

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Profile> {
    Ok(Profile {
        id: row.get(0)?,
        name: row.get(1)?,
        protocol: row.get(2)?,
        base_url: row.get(3)?,
        model: row.get(4)?,
        enabled: row.get(5)?,
        is_default: row.get(6)?,
        timeout_seconds: row.get(7)?,
        max_output_tokens: row.get(8)?,
        allow_loopback_http: row.get(9)?,
        has_key: row.get(10)?,
        updated_at: row.get(11)?,
        vision_status: row.get(12)?,
    })
}

pub fn list(conn: &Connection) -> Result<Vec<Profile>, String> {
    let mut statement=conn.prepare("SELECT id,name,protocol,base_url,model,enabled,is_default,timeout_seconds,max_output_tokens,allow_loopback_http,length(key_ciphertext)>0,updated_at,COALESCE((SELECT CASE WHEN config_revision=ai_profiles.updated_at THEN vision_status ELSE 'unknown' END FROM ai_capabilities WHERE profile_id=ai_profiles.id),'unknown') FROM ai_profiles ORDER BY is_default DESC,updated_at DESC").map_err(|_|"读取AI配置失败")?;
    let result = statement
        .query_map([], row)
        .map_err(|_| "读取AI配置失败")?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| "读取AI配置失败".into());
    result
}

pub fn endpoint(
    base: &str,
    protocol: &str,
    model: &str,
    allow_http: bool,
) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(base.trim()).map_err(|_| "AI服务地址无效")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("AI服务地址不能包含账号、密码、查询参数或片段".into());
    }
    let loopback = url.host_str().is_some_and(|h| {
        h.eq_ignore_ascii_case("localhost")
            || h.trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback && allow_http) {
        return Err("AI服务须使用HTTPS；本地回环HTTP需明确开启".into());
    }
    let path = url.path().trim_end_matches('/');
    let suffix = match protocol {
        "openai_chat" => "chat/completions".to_string(),
        "openai_responses" => "responses".to_string(),
        "claude" => "messages".to_string(),
        "gemini" => format!("models/{model}:generateContent"),
        _ => return Err("AI协议无效".into()),
    };
    let model = model
        .strip_prefix("models/")
        .filter(|_| protocol == "gemini")
        .unwrap_or(model);
    if model.is_empty()
        || model.len() > 160
        || !model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.:/".contains(c))
        || model
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || (protocol == "gemini" && model.contains('/'))
    {
        return Err("模型名称格式无效；Gemini只接受单个模型标识".into());
    }
    let version = if protocol == "gemini" { "v1beta" } else { "v1" };
    let prefix = if path.ends_with("/v1") || path.ends_with("/v1beta") {
        path.to_string()
    } else {
        format!("{path}/{version}")
    };
    url.set_path(&format!("{prefix}/{suffix}"));
    Ok(url)
}

pub fn save(conn: &mut Connection, input: SaveProfile) -> Result<Profile, String> {
    save_with_encrypt(conn, input, encrypt_secret)
}

fn save_with_encrypt(
    conn: &mut Connection,
    mut input: SaveProfile,
    encrypt: impl Fn(&str) -> Result<String, String>,
) -> Result<Profile, String> {
    input.name = input.name.trim().to_string();
    input.model = input.model.trim().to_string();
    input.base_url = input.base_url.trim().trim_end_matches('/').to_string();
    if input.name.is_empty()
        || input.name.len() > 120
        || input.base_url.len() > 512
        || !(5..=180).contains(&input.timeout_seconds)
        || !(128..=8192).contains(&input.max_output_tokens)
    {
        return Err("AI配置字段或限额无效".into());
    }
    endpoint(
        &input.base_url,
        &input.protocol,
        &input.model,
        input.allow_loopback_http,
    )?;
    let supplied = Zeroizing::new(input.api_key.take().unwrap_or_default());
    if supplied.len() > 4096 || supplied.chars().any(char::is_control) {
        return Err("AI密钥格式无效".into());
    }
    let tx = conn.transaction().map_err(|_| "保存AI配置失败")?;
    let id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if uuid::Uuid::parse_str(&id).is_err() {
        return Err("AI配置标识无效".into());
    }
    let previous: Option<String> = tx
        .query_row(
            "SELECT key_ciphertext FROM ai_profiles WHERE id=?1",
            [&id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| "读取AI密钥失败")?;
    let previous_url: Option<String> = tx
        .query_row("SELECT base_url FROM ai_profiles WHERE id=?1", [&id], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|_| "读取AI配置失败")?;
    if supplied.trim().is_empty()
        && previous_url.as_ref().is_some_and(|url| {
            reqwest::Url::parse(url).ok().map(|u| u.origin())
                != reqwest::Url::parse(&input.base_url)
                    .ok()
                    .map(|u| u.origin())
        })
    {
        return Err("更改AI服务来源时须重新填写密钥".into());
    }
    let count: i64 = tx
        .query_row("SELECT count(*) FROM ai_profiles", [], |r| r.get(0))
        .map_err(|_| "读取AI配置失败")?;
    if previous.is_none() && count >= 20 {
        return Err("最多保存20个AI服务配置".into());
    }
    let cipher = if supplied.trim().is_empty() {
        previous.ok_or("首次添加须填写AI密钥")?
    } else {
        encrypt(supplied.trim())?
    };
    if cipher.is_empty() && input.enabled {
        return Err("启用AI服务须填写密钥".into());
    }
    let is_default = input.is_default || count == 0;
    if is_default {
        tx.execute("UPDATE ai_profiles SET is_default=0 WHERE is_default=1", [])
            .map_err(|_| "设置默认AI失败")?;
    }
    tx.execute("INSERT INTO ai_profiles(id,name,protocol,base_url,model,key_ciphertext,enabled,is_default,timeout_seconds,max_output_tokens,allow_loopback_http,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) ON CONFLICT(id) DO UPDATE SET name=excluded.name,protocol=excluded.protocol,base_url=excluded.base_url,model=excluded.model,key_ciphertext=excluded.key_ciphertext,enabled=excluded.enabled,is_default=excluded.is_default,timeout_seconds=excluded.timeout_seconds,max_output_tokens=excluded.max_output_tokens,allow_loopback_http=excluded.allow_loopback_http,updated_at=excluded.updated_at",params![id,input.name,input.protocol,input.base_url,input.model,cipher,input.enabled,is_default,input.timeout_seconds,input.max_output_tokens,input.allow_loopback_http,chrono::Utc::now().timestamp_millis()]).map_err(|_|"保存AI配置失败")?;
    tx.commit().map_err(|_| "保存AI配置失败")?;
    list(conn)?
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "保存AI配置失败".into())
}

pub fn remove(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM ai_profiles WHERE id=?1", [id])
        .map(|_| ())
        .map_err(|_| "删除AI配置失败".into())
}

pub fn record_vision(
    conn: &Connection,
    id: &str,
    revision: i64,
    supported: bool,
) -> Result<Profile, String> {
    let changed=conn.execute("INSERT INTO ai_capabilities(profile_id,config_revision,vision_status,checked_at) SELECT id,updated_at,?3,?4 FROM ai_profiles WHERE id=?1 AND updated_at=?2 AND enabled=1 ON CONFLICT(profile_id) DO UPDATE SET config_revision=excluded.config_revision,vision_status=excluded.vision_status,checked_at=excluded.checked_at",params![id,revision,if supported{"supported"}else{"unsupported"},chrono::Utc::now().timestamp_millis()]).map_err(|_|"保存图像测试结果失败")?;
    if changed != 1 {
        return Err("AI配置已变更，请关闭辅助面板后重新打开".into());
    }
    list(conn)?
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "读取AI配置失败".into())
}
pub fn load(conn: &Connection, id: &str) -> Result<(Profile, Zeroizing<String>), String> {
    let profile = list(conn)?
        .into_iter()
        .find(|p| p.id == id)
        .ok_or("AI配置不存在，请刷新设置")?;
    if !profile.enabled {
        return Err("AI服务已停用".into());
    }
    let cipher: String = conn
        .query_row(
            "SELECT key_ciphertext FROM ai_profiles WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(|_| "读取AI密钥失败")?;
    Ok((profile, Zeroizing::new(decrypt_secret(&cipher)?)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn vision_capability_is_bound_to_current_enabled_configuration() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute("INSERT INTO ai_profiles(id,name,protocol,base_url,model,key_ciphertext,enabled,updated_at) VALUES('fixture','fixture','claude','https://example.test','fixture','fixture-cipher',1,1)", []).unwrap();
        assert_eq!(list(&conn).unwrap()[0].vision_status, "unknown");
        assert_eq!(
            record_vision(&conn, "fixture", 1, true)
                .unwrap()
                .vision_status,
            "supported"
        );
        assert_eq!(list(&conn).unwrap()[0].vision_status, "supported");
        conn.execute("UPDATE ai_profiles SET updated_at=2 WHERE id='fixture'", [])
            .unwrap();
        assert_eq!(list(&conn).unwrap()[0].vision_status, "unknown");
        assert!(record_vision(&conn, "fixture", 1, true).is_err());
        assert_eq!(
            record_vision(&conn, "fixture", 2, false)
                .unwrap()
                .vision_status,
            "unsupported"
        );
        conn.execute("UPDATE ai_profiles SET enabled=0 WHERE id='fixture'", [])
            .unwrap();
        assert!(record_vision(&conn, "fixture", 2, true).is_err());
        assert_eq!(list(&conn).unwrap()[0].vision_status, "unsupported");
    }
    #[test]
    fn encrypted_key_reuse_and_origin_changes_are_transactional() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        let make = |id: Option<String>, base: &str, key: Option<String>| SaveProfile {
            id,
            name: "test-only-profile".into(),
            protocol: "openai_chat".into(),
            base_url: base.into(),
            model: "fixture".into(),
            api_key: key,
            enabled: true,
            is_default: true,
            timeout_seconds: 60,
            max_output_tokens: 1024,
            allow_loopback_http: false,
        };
        let key = [7u8; 32];
        let encrypt = |secret: &str| crate::core::crypto::encrypt_secret_with_key(secret, &key);
        let profile = save_with_encrypt(
            &mut conn,
            make(
                None,
                "https://example.test",
                Some("test-only-ai-secret".into()),
            ),
            encrypt,
        )
        .unwrap();
        let cipher: String = conn
            .query_row(
                "SELECT key_ciphertext FROM ai_profiles WHERE id=?1",
                [&profile.id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!cipher.contains("test-only-ai-secret"));
        assert_eq!(
            crate::core::crypto::decrypt_secret_with_key(&cipher, &key).unwrap(),
            "test-only-ai-secret"
        );
        save_with_encrypt(
            &mut conn,
            make(Some(profile.id.clone()), "https://example.test/v1", None),
            encrypt,
        )
        .unwrap();
        assert!(save_with_encrypt(
            &mut conn,
            make(Some(profile.id.clone()), "https://different.test", None),
            encrypt
        )
        .is_err());
        assert_eq!(list(&conn).unwrap()[0].base_url, "https://example.test/v1");
        let second = save_with_encrypt(
            &mut conn,
            make(
                None,
                "https://other.test",
                Some("test-only-other-secret".into()),
            ),
            encrypt,
        )
        .unwrap();
        let default_ids = list(&conn)
            .unwrap()
            .into_iter()
            .filter(|p| p.is_default)
            .map(|p| p.id)
            .collect::<Vec<_>>();
        assert_eq!(default_ids, vec![second.id]);
        let same: String = conn
            .query_row(
                "SELECT key_ciphertext FROM ai_profiles WHERE id=?1",
                [&profile.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(same, cipher);
    }
    #[test]
    fn endpoint_boundaries() {
        assert_eq!(
            endpoint(
                "https://example.test/proxy/v1/",
                "openai_chat",
                "fixture-model",
                false
            )
            .unwrap()
            .as_str(),
            "https://example.test/proxy/v1/chat/completions"
        );
        assert_eq!(
            endpoint("https://example.test", "gemini", "fixture-model", false)
                .unwrap()
                .path(),
            "/v1beta/models/fixture-model:generateContent"
        );
        for url in [
            "file:///tmp/test",
            "http://example.test",
            "https://user:pass@example.test",
            "https://example.test?key=example",
            "https://example.test/#example",
        ] {
            assert!(endpoint(url, "claude", "fixture", true).is_err());
        }
        assert!(endpoint("http://127.0.0.1:1234", "openai_chat", "fixture", false).is_err());
        assert!(endpoint("http://127.0.0.1:1234", "openai_chat", "fixture", true).is_ok());
        assert!(endpoint("https://example.test", "gemini", "../bad", false).is_err());
    }
    #[test]
    fn summary_never_returns_ciphertext() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute("INSERT INTO ai_profiles(id,name,protocol,base_url,model,key_ciphertext,updated_at) VALUES('example','name','claude','https://example.test','fixture','fixture-encrypted-value',1)",[]).unwrap();
        let json = serde_json::to_string(&list(&conn).unwrap()).unwrap();
        assert!(!json.contains("fixture-encrypted-value"));
        assert!(!json.contains("keyCiphertext"));
        assert!(json.contains("hasKey"));
    }
    #[test]
    fn encrypted_configuration_survives_reopen_and_missing_keys_cannot_be_enabled() {
        let path = std::env::temp_dir().join(format!(
            "cloudhub-ai-fixture-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        let key = [9u8; 32];
        let encrypt = |value: &str| crate::core::crypto::encrypt_secret_with_key(value, &key);
        let id;
        {
            let mut conn = Connection::open(&path).unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            let p = save_with_encrypt(
                &mut conn,
                SaveProfile {
                    id: None,
                    name: "test-only-reopen".into(),
                    protocol: "claude".into(),
                    base_url: "https://example.test".into(),
                    model: "fixture".into(),
                    api_key: Some("test-only-reopen-key".into()),
                    enabled: true,
                    is_default: true,
                    timeout_seconds: 60,
                    max_output_tokens: 512,
                    allow_loopback_http: false,
                },
                encrypt,
            )
            .unwrap();
            id = p.id;
        }
        {
            let mut conn = Connection::open(&path).unwrap();
            let p = list(&conn).unwrap().remove(0);
            assert_eq!(p.id, id);
            assert!(p.has_key);
            let cipher: String = conn
                .query_row(
                    "SELECT key_ciphertext FROM ai_profiles WHERE id=?1",
                    [&id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                crate::core::crypto::decrypt_secret_with_key(&cipher, &key).unwrap(),
                "test-only-reopen-key"
            );
            conn.execute("UPDATE ai_profiles SET key_ciphertext='',enabled=0", [])
                .unwrap();
            assert!(save_with_encrypt(
                &mut conn,
                SaveProfile {
                    id: Some(id),
                    name: p.name,
                    protocol: p.protocol,
                    base_url: p.base_url,
                    model: p.model,
                    api_key: None,
                    enabled: true,
                    is_default: true,
                    timeout_seconds: 60,
                    max_output_tokens: 512,
                    allow_loopback_http: false
                },
                encrypt
            )
            .is_err());
            assert!(!list(&conn).unwrap()[0].enabled);
        }
        std::fs::remove_file(path).unwrap();
    }
}
