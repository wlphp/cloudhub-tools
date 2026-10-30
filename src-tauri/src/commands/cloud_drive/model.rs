use crate::core::{crypto::{decrypt_secret, encrypt_secret}, storage::open_db};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

pub const KEY: &str = "cloud.drive.connections";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connection {
    #[serde(default)] pub id: String,
    pub name: String,
    pub provider: String,
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub prefix: String,
    pub access_key_id: String,
    #[serde(default)] pub secret_key: String,
    #[serde(default)] pub session_token: String,
    pub path_style: bool,
    pub mount_point: String,
    pub read_only: bool,
    pub auto_mount: bool,
    pub cache_dir: String,
    pub cache_gib: u32,
    #[serde(default)] pub alipan_app_id: String,
    #[serde(default)] pub alipan_drive: String,
    #[serde(default)] pub alipan_auth: Option<super::alipan::Authorization>,
}
impl Drop for Connection {
    fn drop(&mut self) { self.access_key_id.zeroize(); self.secret_key.zeroize(); self.session_token.zeroize(); }
}
impl Connection {
    pub fn view(&self) -> serde_json::Value {
        serde_json::json!({"id":self.id,"name":self.name,"provider":self.provider,"endpoint":self.endpoint,
            "region":self.region,"bucket":self.bucket,"prefix":self.prefix,"pathStyle":self.path_style,
            "mountPoint":self.mount_point,"readOnly":self.read_only,"autoMount":self.auto_mount,
            "cacheDir":self.cache_dir,"cacheGib":self.cache_gib,"accessKeyId":self.access_key_id,"hasCredentials":!self.secret_key.is_empty(),
            "hasSessionToken":!self.session_token.is_empty(),"alipanAppId":self.alipan_app_id,
            "alipanDrive":self.alipan_drive,"authorized":self.alipan_auth.is_some(),
            "authorizationExpiresAt":self.alipan_auth.as_ref().map(|a|a.expires_at)})
    }
    pub fn remote(&self) -> String {
        if self.provider == "Alipan" { return format!("drive:{}", self.prefix); }
        format!("drive:{}/{}", self.bucket, self.prefix)
    }
}

pub fn load() -> Result<Vec<Connection>, String> {
    let raw: Option<String> = open_db()?.query_row("SELECT value FROM client_preferences WHERE key=?1", [KEY], |r|r.get(0))
        .optional().map_err(|_|"读取云盘配置失败")?;
    match raw {
        None => Ok(vec![]),
        Some(raw) => serde_json::from_str(&Zeroizing::new(decrypt_secret(&raw).map_err(|_|"无法解密云盘配置")?))
            .map_err(|_|"云盘配置格式无效".into()),
    }
}
pub fn persist(items: &[Connection]) -> Result<(), String> {
    let raw = Zeroizing::new(serde_json::to_string(items).map_err(|_|"无法序列化云盘配置")?);
    let encrypted = encrypt_secret(&raw)?;
    crate::core::repositories::preferences::save(&open_db()?, KEY, &encrypted, chrono::Utc::now().timestamp_millis())
        .map_err(|_|"无法保存云盘配置".into())
}
pub fn find(id: &str) -> Result<Connection, String> {
    load()?.into_iter().find(|c|c.id == id).ok_or("云盘连接不存在".into())
}
pub fn valid_id(id: &str) -> bool { uuid::Uuid::parse_str(id).is_ok_and(|u|u.to_string() == id) }

pub fn validate_service(c: &Connection) -> Result<(), String> {
    if c.provider == "Alipan" {
        if c.endpoint != super::alipan::ORIGIN || c.alipan_app_id.len() < 8 || c.alipan_app_id.len() > 128
            || !c.alipan_app_id.bytes().all(|b|b.is_ascii_alphanumeric())
            || !["default", "resource", "backup"].contains(&c.alipan_drive.as_str()) {
            return Err("阿里云盘应用 ID 或云盘类型无效".into());
        }
        return Ok(());
    }
    if !["Alibaba", "AWS", "Other", "Minio", "Cloudflare", "TencentCOS", "HuaweiOBS"].contains(&c.provider.as_str()) {
        return Err("连接名称或服务商无效".into());
    }
    let url = reqwest::Url::parse(&c.endpoint).map_err(|_|"请输入 HTTPS 服务地址")?;
    if c.endpoint.len()>2048 || url.scheme()!="https" || url.host_str().is_none() || !url.username().is_empty()
        || url.password().is_some() || url.query().is_some() || url.fragment().is_some() || url.path()!="/" {
        return Err("Endpoint 必须为无用户名、查询参数和路径的 HTTPS 地址".into());
    }
    if c.region.len()>100 || !c.region.chars().all(|v|v.is_ascii_alphanumeric() || v=='-') {
        return Err("区域、存储桶或目录前缀无效（不支持路径跳转）".into());
    }
    if [&c.access_key_id,&c.secret_key,&c.session_token].iter().any(|s|s.len()>8192 || s.chars().any(char::is_control))
        || c.access_key_id.trim().is_empty() || c.secret_key.trim().is_empty() {
        return Err("请填写有效的访问凭据".into());
    }
    Ok(())
}
pub fn validate(c: &Connection) -> Result<(), String> {
    validate_service(c)?;
    if !valid_id(&c.id) || c.name.trim().is_empty() || c.name.len()>100 || c.name.chars().any(char::is_control) {
        return Err("连接名称或服务商无效".into());
    }
    if (c.provider!="Alipan" && (c.bucket.len()<3 || c.bucket.len()>63 || !c.bucket.bytes().all(|b|b.is_ascii_lowercase()||b.is_ascii_digit()||b".-".contains(&b))
        || !c.bucket.as_bytes()[0].is_ascii_alphanumeric() || !c.bucket.as_bytes()[c.bucket.len()-1].is_ascii_alphanumeric()
        || c.bucket.contains(".."))) || c.prefix.len()>512 || c.prefix.starts_with('/') || c.prefix.contains('\\')
        || c.prefix.chars().any(char::is_control) || c.prefix.split('/').any(|s|s=="."||s=="..") {
        return Err("区域、存储桶或目录前缀无效（不支持路径跳转）".into());
    }
    validate_mount_point(&c.mount_point)?;
    if c.cache_gib<1 || c.cache_gib>1024 { return Err("缓存空间目标必须为 1–1024 GiB".into()); }
    if !c.cache_dir.is_empty() { validate_local_dir(&c.cache_dir)?; }
    Ok(())
}
pub fn validate_local_dir(path: &str) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        use std::path::{Component, Path};
        if !Path::new(path).is_absolute() || path == "/" || path.starts_with("//")
            || path.chars().any(char::is_control) || path.contains('\\')
            || Path::new(path).components().any(|c|matches!(c, Component::ParentDir | Component::CurDir))
            || path.split('/').any(|s| s=="." || s=="..") {
            return Err("请选择本地磁盘上的绝对目录，不能使用网络路径或路径跳转".into());
        }
        return Ok(());
    }
    #[cfg(windows)]
    {
    // Only local Windows drive paths; reject UNC, device namespaces, ADS and traversal.
    let b=path.as_bytes();
    if b.len()<4 || !b[0].is_ascii_alphabetic() || b[1]!=b':' || ![b'\\',b'/'].contains(&b[2])
        || path[2..].contains(':') || path.chars().any(|c|c.is_control()||"<>\"|?*".contains(c))
        || path[3..].split(['\\','/']).any(|s| {
            let stem=s.split('.').next().unwrap_or("").to_ascii_lowercase();
            s=="."||s==".."||s.ends_with(' ')||s.ends_with('.')
                || ["con","prn","aux","nul"].contains(&stem.as_str())
                || (stem.len()==4 && (stem.starts_with("com")||stem.starts_with("lpt")) && (b'1'..=b'9').contains(&stem.as_bytes()[3]))
        }) {
        return Err("请选择本地磁盘上的绝对目录，不能使用网络路径或路径跳转".into());
    }
    Ok(())
    }
}
pub fn validate_mount_point(path: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
    let b=path.as_bytes();
    if b.len()==2 && (b'D'..=b'Z').contains(&b[0]) && b[1]==b':' { return Ok(()); }
    }
    validate_local_dir(path)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    pub(crate) fn fixture() -> Connection {
        Connection{id:uuid::Uuid::new_v4().to_string(),name:"测试资料盘".into(),provider:"Alibaba".into(),
            endpoint:"https://oss-cn-hangzhou.aliyuncs.com".into(),region:"cn-hangzhou".into(),bucket:"sample-bucket".into(),prefix:"资料/项目".into(),
            access_key_id:uuid::Uuid::new_v4().to_string(),secret_key:uuid::Uuid::new_v4().to_string(),session_token:String::new(),
            path_style:false,mount_point:if cfg!(windows){"O:"}else{"/tmp/cloudhub-drive"}.into(),read_only:true,auto_mount:false,cache_dir:String::new(),cache_gib:10,
            alipan_app_id:String::new(),alipan_drive:String::new(),alipan_auth:None}
    }
    #[test] fn endpoint_and_object_path_inputs_are_validated() {
        let mut c=fixture();assert!(validate(&c).is_ok());
        for url in ["http://storage.example.test","https://user:password@storage.example.test","https://storage.example.test/path","https://storage.example.test?token=x"] {
            c.endpoint=url.into();assert!(validate(&c).is_err());
        }
        c.endpoint="https://storage.example.test".into();
        for path in ["../escape","a/../b","/absolute",r"a\b"] {c.prefix=path.into();assert!(validate(&c).is_err());}
        c.prefix="资料/项目".into();c.cache_gib=0;assert!(validate(&c).is_err());
    }
    #[test] fn snapshot_exposes_key_id_but_never_secrets() {
        let c=fixture();let view=c.view();let text=view.to_string();
        assert_eq!(view["accessKeyId"],c.access_key_id);assert!(view.get("secretKey").is_none());assert!(view.get("sessionToken").is_none());
        assert!(!text.contains(&c.secret_key));assert_eq!(view["hasCredentials"],true);
    }
    #[test] fn listing_validates_service_without_requiring_saved_connection_or_bucket() {
        let mut c=fixture();
        c.id.clear();c.name.clear();c.bucket.clear();c.mount_point.clear();c.cache_gib=0;
        assert!(validate_service(&c).is_ok());assert!(validate(&c).is_err());
        c.endpoint="https://storage.example.test/path".into();assert!(validate_service(&c).is_err());
        c.endpoint="https://storage.example.test".into();
        c.provider="unsupported".into();assert!(validate_service(&c).is_err());
        c.provider="Other".into();c.region="../invalid".into();assert!(validate_service(&c).is_err());
        c.region.clear();c.secret_key.clear();assert!(validate_service(&c).is_err());
    }
    #[test] #[cfg(windows)] fn local_paths_reject_devices_shares_and_traversal() {
        for p in [r"\\server\share",r"\\?\C:\data",r"C:\data\..\etc",r"C:\data:stream",r"C:\",r"C:\data\bad.",r"D:\cache\CON",r"D:\NUL.txt",r"D:\com1",r"D:\LPT9.log"] {
            assert!(validate_local_dir(p).is_err(),"{p}");
        }
        assert!(validate_mount_point("O:").is_ok());
        assert!(validate_local_dir(r"D:\CloudHubCache").is_ok());
        assert!(validate_mount_point("C:").is_err());
    }
    #[test] #[cfg(unix)] fn unix_mount_paths_require_safe_absolute_directories() {
        for p in ["/", "//server/share", "/tmp/../data", "/tmp/./data", "relative", "C:\\data"] {assert!(validate_local_dir(p).is_err());}
        assert!(validate_mount_point("/tmp/资料盘").is_ok());
    }
}
