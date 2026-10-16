use super::{error, validate_id};
use crate::core::{crypto::{encrypt_secret, decrypt_secret}, database::open_db, error::PlatformResult};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentConfig {
    pub name: String,
    pub group: String,
    pub tags: String,
    pub note: String,
    pub kernel_version: String,
    pub start_urls: Vec<String>,
    pub proxy: ProxyConfig,
    pub language: String,
    pub timezone: String,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub geolocation: Option<Geolocation>,
    #[serde(default)]
    pub fingerprint: Option<Fingerprint>,
    #[serde(default)]
    pub identity: BrowserIdentity,
}
#[derive(Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub enum BrowserIdentity { #[default] Native, Windows10, Windows11 }
impl BrowserIdentity {
    pub fn platform_version(self) -> Option<&'static str> {
        match self { Self::Native=>None, Self::Windows10=>Some("10.0.0"), Self::Windows11=>Some("19.0.0") }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fingerprint {
    pub seed: u32,
    pub canvas_noise: bool,
    pub hardware_concurrency: u32,
    pub device_memory: u32,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Geolocation { pub latitude: f64, pub longitude: f64, pub accuracy: f64 }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProxyConfig {
    pub kind: String,
    pub host: String,
    pub port: u16,
    pub username: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveEnvironment {
    pub id: Option<String>,
    pub config: EnvironmentConfig,
    /// None retains the stored secret; an empty value explicitly clears it.
    pub proxy_password: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub id: String,
    pub config: EnvironmentConfig,
    pub password_saved: bool,
    pub created_at: i64,
    pub last_opened_at: Option<i64>,
    pub deleted_at: Option<i64>,
    pub running: bool,
    pub recovery_required: bool,
}

pub fn validate(config: &EnvironmentConfig) -> PlatformResult<()> {
    match (&config.fingerprint,super::kernel::experimental(&config.kernel_version)) {
        (Some(fp),true) if fp.seed > 0 && (1..=64).contains(&fp.hardware_concurrency) && [2,4,8,16,32].contains(&fp.device_memory) => {},
        (None,false) => {},
        _ => return Err(error("实验内核需要有效的指纹种子、CPU 核数与内存；普通内核不支持深层参数")),
    }
    if config.name.trim().is_empty() || config.name.len() > 200 || config.group.len() > 120
        || config.tags.len() > 500 || config.note.len() > 4000
        || !super::kernel::known_version(&config.kernel_version)
        || !(640..=7680).contains(&config.width) || !(480..=4320).contains(&config.height)
        || config.start_urls.len() > 20 {
        return Err(error("浏览器环境名称、内核版本或窗口尺寸无效"));
    }
    for url in &config.start_urls {
        let parsed = reqwest::Url::parse(url).map_err(|_| error("启动网址必须是 HTTP 或 HTTPS 地址"))?;
        if url.len() > 4096 || url.chars().any(char::is_control) || !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none()
            || !parsed.username().is_empty() || parsed.password().is_some() {
            return Err(error("启动网址必须是无账号密码的 HTTP 或 HTTPS 地址"));
        }
    }
    let p = &config.proxy;
    if !matches!(p.kind.as_str(), "direct" | "http" | "https" | "socks5") {
        return Err(error("代理类型无效"));
    }
    if p.kind != "direct" {
        if p.port == 0 || p.host.is_empty() || p.host.len() > 253 || p.host.chars().any(|c| !c.is_ascii_alphanumeric() && !".-:[]".contains(c))
            || p.username.len() > 255 || p.username.chars().any(char::is_control) {
            return Err(error("代理主机、端口或账号无效"));
        }
        if matches!(p.kind.as_str(), "http" | "https") && p.username.contains(':') { return Err(error("HTTP 代理账号不能包含冒号")); }
        // URL parser additionally checks malformed IPv6 / host syntax.
        let host = if p.host.contains(':') && !p.host.starts_with('[') { format!("[{}]", p.host) } else { p.host.clone() };
        if reqwest::Url::parse(&format!("{}://{}:{}", p.kind, host, p.port)).is_err() {
            return Err(error("代理主机无效"));
        }
    }
    if config.language.len() > 35 || config.language.is_empty() || config.language.split('-').any(|s| s.is_empty() || !s.bytes().all(|b| b.is_ascii_alphanumeric())) {
        return Err(error("语言代码无效，例如 zh-CN 或 en-US"));
    }
    // Timezone is validated against the browser's ICU database before navigation.
    if config.timezone.len() > 80 || !config.timezone.bytes().all(|b| b.is_ascii_alphanumeric() || b"/_+-".contains(&b)) {
        return Err(error("时区标识无效"));
    }
    if let Some(location) = &config.geolocation {
        if !location.latitude.is_finite() || !location.longitude.is_finite() || !location.accuracy.is_finite()
            || !(-90.0..=90.0).contains(&location.latitude) || !(-180.0..=180.0).contains(&location.longitude) || !(0.0..=10000.0).contains(&location.accuracy) {
            return Err(error("地理位置坐标或精度无效"));
        }
    }
    Ok(())
}

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Environment> {
    let json: String = row.get(1)?;
    let config = serde_json::from_str(&json).map_err(|e| rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Text, Box::new(e)))?;
    Ok(Environment { id: row.get(0)?, config, password_saved: row.get::<_, Option<String>>(2)?.is_some(),
        created_at: row.get(3)?, last_opened_at: row.get(4)?, deleted_at: row.get(5)?, running: false, recovery_required: false })
}
const COLUMNS: &str = "id,config_json,proxy_secret_ciphertext,created_at,last_opened_at,deleted_at";

pub fn list() -> PlatformResult<Vec<Environment>> {
    let db = open_db().map_err(|_| error("无法读取浏览器环境"))?;
    let mut statement = db.prepare(&format!("SELECT {COLUMNS} FROM browser_environments ORDER BY created_at DESC"))
        .map_err(|_| error("无法读取浏览器环境"))?;
    let rows = statement.query_map([], row).map_err(|_| error("无法读取浏览器环境"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|_| error("浏览器环境数据无效"))
}
pub fn get(id: &str) -> PlatformResult<Environment> {
    validate_id(id)?;
    let db = open_db().map_err(|_| error("无法读取浏览器环境"))?;
    db.query_row(&format!("SELECT {COLUMNS} FROM browser_environments WHERE id=?1"), [id], row)
        .optional().map_err(|_| error("无法读取浏览器环境"))?.ok_or(error("浏览器环境不存在"))
}
pub fn password(id: &str) -> PlatformResult<Option<String>> {
    validate_id(id)?;
    let db = open_db().map_err(|_| error("无法读取代理配置"))?;
    let cipher: Option<String> = db.query_row("SELECT proxy_secret_ciphertext FROM browser_environments WHERE id=?1", [id], |r| r.get(0))
        .map_err(|_| error("无法读取代理配置"))?;
    cipher.map(|v| decrypt_secret(&v).map_err(|_| error("无法解密代理配置"))).transpose()
}
pub fn save(mut input: SaveEnvironment) -> PlatformResult<Environment> {
    input.config.name = input.config.name.trim().to_string();
    validate(&input.config)?;
    let id = input.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    validate_id(&id)?;
    let old = if input.id.is_some() { Some(get(&id)?) } else { None };
    if old.as_ref().is_some_and(|o| o.deleted_at.is_some()) { return Err(error("请先从回收站恢复环境")); }
    if let Some(old) = &old {
        check_kernel_change(old,&input.config.kernel_version,&super::root()?.join("environments").join(&id))?;
    }
    let secret_changed = old.as_ref().is_none_or(|old| old.config.proxy.kind != input.config.proxy.kind
        || old.config.proxy.host != input.config.proxy.host || old.config.proxy.port != input.config.proxy.port
        || old.config.proxy.username != input.config.proxy.username);
    let password = input.proxy_password;
    if password.as_ref().is_some_and(|v| v.len() > 1024 || v.chars().any(char::is_control)) { return Err(error("代理密码长度或格式无效")); }
    let cipher = match password {
        Some(value) if !value.is_empty() && input.config.proxy.kind != "direct" => Some(encrypt_secret(&value).map_err(|_| error("代理密码加密失败"))?),
        Some(_) => None,
        None if secret_changed || input.config.proxy.kind == "direct" => None,
        None => {
            let db = open_db().map_err(|_| error("无法保存浏览器环境"))?;
            db.query_row("SELECT proxy_secret_ciphertext FROM browser_environments WHERE id=?1", [&id], |r| r.get::<_, Option<String>>(0))
                .optional().map_err(|_| error("无法保存浏览器环境"))?.flatten()
        }
    };
    let json = serde_json::to_string(&input.config).map_err(|_| error("浏览器环境配置无效"))?;
    let db = open_db().map_err(|_| error("无法保存浏览器环境"))?;
    let now = chrono::Utc::now().timestamp_millis();
    db.execute("INSERT INTO browser_environments(id,config_json,proxy_secret_ciphertext,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)
        ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,proxy_secret_ciphertext=excluded.proxy_secret_ciphertext,updated_at=excluded.updated_at",
        params![id,json,cipher,now]).map_err(|_| error("无法保存浏览器环境"))?;
    get(&id)
}
fn check_kernel_change(old: &Environment, next: &str, profile: &std::path::Path) -> PlatformResult<()> {
    if old.config.kernel_version==next {return Ok(());}
    // A failed startup may already have migrated Chromium files before the
    // successful-open timestamp could be written. Never downgrade those files.
    let initialized=profile.join("Local State").try_exists().map_err(|_|error("无法确认浏览器资料版本"))?
        || profile.join("cloudhub-process.json").try_exists().map_err(|_|error("无法确认浏览器资料版本"))?;
    if old.last_opened_at.is_some() || initialized {return Err(error("已使用或初始化过的环境不能更换内核，请新建环境以避免资料迁移损坏"));}
    Ok(())
}
pub fn set_deleted(id: &str, deleted: bool) -> PlatformResult<()> {
    get(id)?;
    let db = open_db().map_err(|_| error("无法更新浏览器环境"))?;
    let now = chrono::Utc::now().timestamp_millis();
    db.execute("UPDATE browser_environments SET deleted_at=?2,updated_at=?3 WHERE id=?1", params![id, if deleted { Some(now) } else { None }, now])
        .map_err(|_| error("无法更新浏览器环境"))?;
    Ok(())
}
pub fn record_open(id: &str) -> PlatformResult<()> {
    let db = open_db().map_err(|_| error("无法更新浏览器环境"))?;
    db.execute("UPDATE browser_environments SET last_opened_at=?2 WHERE id=?1", params![id,chrono::Utc::now().timestamp_millis()])
        .map_err(|_| error("无法更新浏览器环境"))?;
    Ok(())
}
pub fn remove(id: &str, confirmation_name: &str) -> PlatformResult<()> {
    let environment = get(id)?;
    if environment.deleted_at.is_none() || confirmation_name != environment.config.name { return Err(error("请在回收站输入完整环境名称确认永久删除")); }
    super::remove_owned_directory(&super::root()?.join("environments").join(id))?;
    open_db().map_err(|_| error("无法删除环境记录"))?.execute("DELETE FROM browser_environments WHERE id=?1", [id])
        .map_err(|_| error("资料已删除，但环境记录清理失败，请重试"))?;
    Ok(())
}
pub fn move_group(ids: &[String], group: &str) -> PlatformResult<()> {
    if ids.is_empty() || ids.len() > 1000 || group.len() > 120 || group.chars().any(char::is_control) { return Err(error("分组名称或环境数量无效")); }
    let mut db = open_db().map_err(|_| error("无法移动环境分组"))?;
    let transaction = db.transaction().map_err(|_| error("无法移动环境分组"))?;
    for id in ids {
        validate_id(id)?;
        let mut environment = transaction.query_row(&format!("SELECT {COLUMNS} FROM browser_environments WHERE id=?1 AND deleted_at IS NULL"), [id], row)
            .map_err(|_| error("选中的环境不存在或已在回收站，未移动任何环境"))?;
        environment.config.group = group.trim().into();
        let json = serde_json::to_string(&environment.config).map_err(|_| error("环境配置无效"))?;
        transaction.execute("UPDATE browser_environments SET config_json=?2,updated_at=?3 WHERE id=?1", params![id,json,chrono::Utc::now().timestamp_millis()])
            .map_err(|_| error("分组移动失败，未移动任何环境"))?;
    }
    transaction.commit().map_err(|_| error("分组移动失败，未移动任何环境"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> EnvironmentConfig { EnvironmentConfig { name: "环境测试".into(), group: String::new(), tags: String::new(), note: String::new(), kernel_version: super::super::kernel::VERSION.into(), start_urls: vec!["https://example.test".into()], proxy: ProxyConfig { kind: "direct".into(), host: String::new(), port: 0, username: String::new() }, language: "zh-CN".into(), timezone: "Asia/Shanghai".into(), width: 1280, height: 900, geolocation: None, fingerprint: None, identity: BrowserIdentity::Native } }
    #[test]
    fn rejects_executable_urls_and_argument_injection() {
        let mut c = config(); assert!(validate(&c).is_ok());
        for url in ["file:///C:/Windows", "javascript:alert(1)", "--no-sandbox", "https://name:password@example.test"] {
            c.start_urls = vec![url.into()]; assert!(validate(&c).is_err());
        }
        c = config(); c.proxy.kind = "http".into(); c.proxy.host = "localhost --flag".into(); c.proxy.port = 8080;
        assert!(validate(&c).is_err());
        c = config(); c.kernel_version = "../../escape".into(); assert!(validate(&c).is_err());
        assert!(validate_id("../../escape").is_err());
    }
    #[test]
    fn partially_initialized_profiles_cannot_change_kernel_after_a_failed_launch() {
        let profile=std::env::temp_dir().join(format!("cloudhub-version-guard-{}",uuid::Uuid::new_v4()));
        std::fs::create_dir(&profile).unwrap();
        let old=Environment {id:uuid::Uuid::new_v4().to_string(),config:config(),password_saved:false,created_at:0,last_opened_at:None,deleted_at:None,running:false,recovery_required:false};
        assert!(check_kernel_change(&old,"155.0.8059.79",&profile).is_ok());
        std::fs::write(profile.join("Local State"),b"{}").unwrap();
        assert!(check_kernel_change(&old,"155.0.8059.79",&profile).is_err());
        assert!(check_kernel_change(&old,&old.config.kernel_version,&profile).is_ok());
        std::fs::remove_dir_all(profile).unwrap();
    }
    #[test]
    fn fingerprint_settings_require_experimental_kernel_and_survive_serialization() {
        let mut c=config();
        let mut legacy=serde_json::to_value(&c).unwrap();legacy.as_object_mut().unwrap().remove("fingerprint");legacy.as_object_mut().unwrap().remove("identity");
        let restored=serde_json::from_value::<EnvironmentConfig>(legacy).unwrap();
        assert!(restored.fingerprint.is_none());assert!(restored.identity.platform_version().is_none());
        let mut invalid=serde_json::to_value(&c).unwrap();invalid["identity"]=serde_json::json!("macos");
        assert!(serde_json::from_value::<EnvironmentConfig>(invalid).is_err());
        c.fingerprint=Some(Fingerprint {seed:172904001,canvas_noise:true,hardware_concurrency:4,device_memory:8});
        assert!(validate(&c).is_err());
        c.kernel_version=super::super::kernel::EXPERIMENTAL_VERSION.into();
        assert!(validate(&c).is_ok());
        let saved=serde_json::to_string(&c).unwrap();
        let restored: EnvironmentConfig=serde_json::from_str(&saved).unwrap();
        assert_eq!(restored.fingerprint.unwrap().seed,172904001);
        for (seed,cores,memory) in [(0,4,8),(1,65,8),(1,4,3)] {
            c.fingerprint=Some(Fingerprint {seed,canvas_noise:true,hardware_concurrency:cores,device_memory:memory});
            assert!(validate(&c).is_err());
        }
    }
}
