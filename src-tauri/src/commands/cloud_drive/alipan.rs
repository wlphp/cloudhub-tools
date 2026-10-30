//! Official Open API only. Public clients use PKCE and receive no refresh token.
use super::{model, runtime, service::DriveStore};
use base64::{engine::general_purpose::URL_SAFE, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use tauri::State;
use tauri_plugin_opener::OpenerExt;
use zeroize::{Zeroize, Zeroizing};

pub const ORIGIN: &str = "https://openapi.alipan.com";
pub const AUTH_ERROR: &str = "阿里云盘授权失败或已过期，请重新授权";
pub const API_ERROR: &str = "阿里云盘请求失败，请检查授权、权限、额度和网络";
pub const CLIENT_ERROR: &str = "阿里云盘网络客户端初始化失败，请检查系统代理和 TLS 配置";

// Fixed messages only: OAuth error bodies can contain credentials or user data.
pub(super) const AUTH_DIAGNOSTICS: &[&str] = &[
    "阿里云盘换取令牌失败（HTTP 400）：授权请求被拒绝，请关闭窗口后重新授权",
    "阿里云盘换取令牌失败（HTTP 401）：请检查应用 ID 和公开客户端配置",
    "阿里云盘换取令牌失败（HTTP 403）：请检查应用准入和授权权限",
    "阿里云盘换取令牌失败（HTTP 429）：请求过于频繁，请稍后重新授权",
    "阿里云盘换取令牌失败：服务返回异常，请稍后重新授权",
    "阿里云盘换取令牌失败：网络连接失败或超时，请检查网络后重新授权",
    "阿里云盘换取令牌失败：服务返回的数据无效，请重新授权",
    "阿里云盘读取云盘信息失败（HTTP 400）：请检查应用权限配置",
    "阿里云盘读取云盘信息失败（HTTP 401）：令牌无效，请重新授权",
    "阿里云盘读取云盘信息失败（HTTP 403）：请检查 user:base 权限和应用准入",
    "阿里云盘读取云盘信息失败（HTTP 429）：请求过于频繁，请稍后重新授权",
    "阿里云盘读取云盘信息失败：服务返回异常，请稍后重新授权",
    "阿里云盘读取云盘信息失败：网络连接失败或超时，请检查网络后重新授权",
    "阿里云盘读取云盘信息失败：服务返回的数据无效，请重新授权",
    "阿里云盘换取令牌失败（AppNotExists）：应用不存在，请核对 App ID",
    "阿里云盘换取令牌失败（InvalidClientSecret）：平台拒绝客户端认证，请核对公开客户端是否已启用；无需在本软件填写 App Secret",
    "阿里云盘换取令牌失败（InvalidCode）：平台未接受此授权码，请核对本次授权结果；授权码 10 分钟内有效且仅能使用一次",
    "阿里云盘换取令牌失败（InvalidClientId）：应用 ID 与生成授权码时不一致，请核对 App ID，并从本软件重新发起授权",
    "阿里云盘换取令牌失败（InvalidGrantType）：平台不接受当前授权类型，请检查客户端请求实现",
    "阿里云盘授权输入无效：请粘贴页面显示的授权码，或完整的官方授权结果页地址",
    "阿里云盘授权会话不匹配：此结果页来自另一次授权，请使用当前窗口打开的页面",
];
// Accept the browser result URL without sending the URL itself as an OAuth code.
// Validate its state before consuming the pending native PKCE session.
fn authorization_code(input: &str, ticket: &str) -> Result<Zeroizing<String>, String> {
    let input = input.trim();
    let invalid = || AUTH_DIAGNOSTICS[19].to_string();
    if input.is_empty() || input.len() > 2048 || !input.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(invalid());
    }
    if !input.contains("://") {
        if !input.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b)) {
            return Err(invalid());
        }
        return Ok(Zeroizing::new(input.into()));
    }
    let url = reqwest::Url::parse(input).map_err(|_| invalid())?;
    if url.scheme() != "https" || url.host_str() != Some("openapi.alipan.com")
        || url.path() != "/oauth/authorize/callback" || url.port().is_some()
        || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(invalid());
    }
    let mut code = None;
    let mut state = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" if code.is_none() => code = Some(Zeroizing::new(value.into_owned())),
            "state" if state.is_none() => state = Some(value.into_owned()),
            _ => return Err(invalid()),
        }
    }
    if state.as_deref() != Some(ticket) {
        return Err(AUTH_DIAGNOSTICS[20].into());
    }
    let code = code.ok_or_else(invalid)?;
    if code.is_empty() || !code.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b)) {
        return Err(invalid());
    }
    Ok(code)
}
fn authorization_error(drive_info: bool, index: usize) -> String {
    AUTH_DIAGNOSTICS[usize::from(drive_info) * 7 + index].into()
}
// Only exact documented codes may select a fixed message. Never expose upstream
// messages, unknown codes, or response bodies (including reflected credentials).
async fn token_error_diagnostic(mut response: reqwest::Response) -> Option<&'static str> {
    const MAX_ERROR_BYTES: usize = 16 * 1024;
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len().checked_add(chunk.len())? > MAX_ERROR_BYTES { return None; }
        bytes.extend_from_slice(&chunk);
    }
    #[derive(Deserialize)]
    struct OAuthError { code: String }
    let error: OAuthError = serde_json::from_slice(&bytes).ok()?;
    let index = match error.code.as_str() {
        "AppNotExists" => 14,
        "InvalidClientSecret" => 15,
        "InvalidCode" => 16,
        "InvalidClientId" => 17,
        "InvalidGrantType" => 18,
        _ => return None,
    };
    Some(AUTH_DIAGNOSTICS[index])
}
async fn authorization_response(response: reqwest::Response, drive_info: bool) -> Result<Value, String> {
    if !response.status().is_success() {
        let index = match response.status().as_u16() {
            400 => 0, 401 => 1, 403 => 2, 429 => 3, _ => 4,
        };
        if !drive_info && matches!(response.status().as_u16(), 400 | 401 | 403) {
            if let Some(diagnostic) = token_error_diagnostic(response).await {
                return Err(diagnostic.into());
            }
        }
        return Err(authorization_error(drive_info, index));
    }
    self::response(response).await.map_err(|_| authorization_error(drive_info, 6))
}

#[cfg(test)]
tokio::task_local! {
    pub static MOCK: std::sync::Mutex<Box<dyn FnMut(&str,Value)->Result<Value,String> + Send>>;
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct Authorization {
    pub access_token: String,
    pub expires_at: i64,
    pub user_id: String,
    pub drive_id: String,
    pub root_id: String,
    pub writable: bool,
}
impl Drop for Authorization { fn drop(&mut self) { self.access_token.zeroize(); } }
pub struct Pending {
    pub connection_id: String,
    pub app_id: String,
    pub drive: String,
    pub writable: bool,
    pub verifier: Zeroizing<String>,
    pub started: Instant,
}
pub fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(45))
        .build().map_err(|_| CLIENT_ERROR.into())
}
pub async fn response(mut response: reqwest::Response) -> Result<Value,String> {
    if response.status()==401 { return Err(AUTH_ERROR.into()); }
    if !response.status().is_success() { return Err(API_ERROR.into()); }
    let mut bytes=Zeroizing::new(Vec::new());
    while let Some(chunk)=response.chunk().await.map_err(|_|API_ERROR)? {
        if bytes.len()+chunk.len()>4*1024*1024 {return Err(API_ERROR.into());}
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() { return Ok(json!({})); }
    serde_json::from_slice(&bytes).map_err(|_|API_ERROR.into())
}
pub fn credentials(c:&model::Connection) -> Result<&Authorization,String> {
    let auth=c.alipan_auth.as_ref().ok_or(AUTH_ERROR)?;
    if auth.expires_at <= chrono::Utc::now().timestamp()+30 {return Err(AUTH_ERROR.into());}
    Ok(auth)
}
pub async fn post(auth:&Authorization,path:&str,body:Value)->Result<Value,String> {
    #[cfg(test)]
    if let Ok(result)=MOCK.try_with(|mock|mock.lock().unwrap()(path,body.clone())) {return result;}
    response(client()?.post(format!("{ORIGIN}{path}")).bearer_auth(&auth.access_token)
        .json(&body).send().await.map_err(|_|API_ERROR)?).await
}
pub fn text(value:&Value,key:&str)->Result<String,String> {
    let s=value[key].as_str().ok_or(API_ERROR)?;
    if s.is_empty() || s.len()>4096 || s.chars().any(char::is_control) {return Err(API_ERROR.into());}
    Ok(s.into())
}
fn pkce_challenge(verifier: &str) -> String {
    // Alipan's S256 verifier requires the trailing base64url padding. Live
    // exchanges reject RFC 7636's unpadded encoding with InvalidCode, while the
    // same flow with padding succeeds. Keep S256; do not downgrade to plain.
    URL_SAFE.encode(Sha256::digest(verifier.as_bytes()))
}
pub async fn begin(app:tauri::AppHandle,state:State<'_,DriveStore>,id:String)->Result<String,String> {
    super::dependency::require()?;
    let _lock=state.operations.lock().await;
    let c=model::find(&id)?;
    if c.provider!="Alipan" {return Err(AUTH_ERROR.into());}
    model::validate_service(&c)?;
    // Never transmit an app secret. Keep the verifier in native memory only.
    let verifier=Zeroizing::new(format!("{}{}",uuid::Uuid::new_v4().simple(),uuid::Uuid::new_v4().simple()));
    let challenge=pkce_challenge(&verifier);
    let ticket=uuid::Uuid::new_v4().to_string();
    let mut url=reqwest::Url::parse(&format!("{ORIGIN}/oauth/authorize")).map_err(|_|AUTH_ERROR)?;
    let scope=if c.read_only {"user:base,file:all:read"}else{"user:base,file:all:read,file:all:write"};
    url.query_pairs_mut().extend_pairs([("client_id",c.alipan_app_id.as_str()),("redirect_uri","oob"),
        ("scope",scope),("response_type","code"),("state",ticket.as_str()),
        ("code_challenge",challenge.as_str()),("code_challenge_method","S256")]);
    let mut pending=state.authorizations.lock().await;
    pending.retain(|_,p|p.started.elapsed()<Duration::from_secs(600)&&p.connection_id!=id);
    if pending.len()>=10 {return Err(AUTH_ERROR.into());}
    app.opener().open_url(url.as_str(),None::<&str>).map_err(|_|AUTH_ERROR)?;
    pending.insert(ticket.clone(),Pending{connection_id:id,app_id:c.alipan_app_id.clone(),drive:c.alipan_drive.clone(),
        writable:!c.read_only,verifier,started:Instant::now()});
    Ok(ticket)
}
pub async fn finish(state:State<'_,DriveStore>,ticket:String,code:String)->Result<(),String> {
    let input=Zeroizing::new(code);
    let code=authorization_code(&input,&ticket)?;
    let _lock=state.operations.lock().await;
    let p=state.authorizations.lock().await.remove(&ticket).ok_or(AUTH_ERROR)?;
    if p.started.elapsed()>Duration::from_secs(600) {return Err(AUTH_ERROR.into());}
    if runtime::sessions()?.iter().any(|s|s.id==p.connection_id&&runtime::pid_exists(s.pid)) {
        return Err("请先关闭使用云盘的程序，选择保留缓存停止，再更新凭据".into());
    }
    let mut all=model::load()?;
    let c=all.iter_mut().find(|c|c.id==p.connection_id).ok_or(AUTH_ERROR)?;
    if c.provider!="Alipan" || c.alipan_app_id!=p.app_id || c.alipan_drive!=p.drive || p.writable==c.read_only {return Err(AUTH_ERROR.into());}
    let http=client()?;
    let token_response=http.post(format!("{ORIGIN}/oauth/access_token")).json(&json!({
        "client_id":p.app_id,"grant_type":"authorization_code","code":code.as_str(),"code_verifier":p.verifier.as_str()
    })).send().await.map_err(|_|authorization_error(false, 5))?;
    let value=authorization_response(token_response,false).await?;
    let expires=value["expires_in"].as_i64().filter(|s|*s>60&&*s<=366*86400).ok_or_else(||authorization_error(false,6))?;
    let mut auth=Authorization{access_token:text(&value,"access_token").map_err(|_|authorization_error(false,6))?,expires_at:chrono::Utc::now().timestamp()+expires,
        user_id:String::new(),drive_id:String::new(),root_id:"root".into(),writable:p.writable};
    let drive_response=http.post(format!("{ORIGIN}/adrive/v1.0/user/getDriveInfo"))
        .bearer_auth(&auth.access_token).json(&json!({})).send().await
        .map_err(|_|authorization_error(true, 5))?;
    let info=authorization_response(drive_response,true).await?;
    auth.user_id=text(&info,"user_id").map_err(|_|authorization_error(true,6))?;
    auth.drive_id=text(&info,match p.drive.as_str(){"resource"=>"resource_drive_id","backup"=>"backup_drive_id",_=>"default_drive_id"}).map_err(|_|authorization_error(true,6))?;
    if info["folder_id"].as_str().is_some_and(|s|!s.is_empty()) {auth.root_id=text(&info,"folder_id").map_err(|_|authorization_error(true,6))?;}
    // A renewed token must never send dirty cached files into another account/drive.
    if let Some(old)=&c.alipan_auth {
        if old.user_id!=auth.user_id||old.drive_id!=auth.drive_id||old.root_id!=auth.root_id {
            return Err("重新授权必须选择原账户和原云盘，避免缓存写入其他位置".into());
        }
    }
    c.alipan_auth=Some(auth);
    model::persist(&all)
}
pub async fn cancel(state:State<'_,DriveStore>,ticket:String)->Result<(),String> {
    state.authorizations.lock().await.remove(&ticket);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_callback_extracts_code_and_rejects_other_sessions_without_reflecting_input() {
        let code = uuid::Uuid::new_v4().simple().to_string();
        let ticket = uuid::Uuid::new_v4().to_string();
        let callback = format!("{ORIGIN}/oauth/authorize/callback?code={code}&state={ticket}");
        assert_eq!(authorization_code(&format!(" {code} "), &ticket).unwrap().as_str(), code);
        assert_eq!(authorization_code(&callback, &ticket).unwrap().as_str(), code);
        assert_eq!(authorization_code(&callback, "other-session").unwrap_err(), AUTH_DIAGNOSTICS[20]);
        for input in [
            callback.replace("https:", "http:"),
            callback.replace("openapi.alipan.com", "openapi.alipan.com.example.invalid"),
            callback.replace("openapi.alipan.com", "user@openapi.alipan.com"),
            callback.replace("/oauth/authorize/callback", "/other"),
            format!("{callback}&code={code}"),
            format!("{callback}&state={ticket}"),
            format!("{callback}#fragment"),
            format!("{ORIGIN}/oauth/authorize/callback?code=&state={ticket}"),
            format!("{ORIGIN}/oauth/authorize/callback?code=%0A{code}&state={ticket}"),
            format!("code={code}"),
            String::new(),
        ] {
            let error = authorization_code(&input, &ticket).unwrap_err();
            assert_eq!(error, AUTH_DIAGNOSTICS[19]);
            assert!(!error.contains(&code));
            assert_eq!(super::super::error::public_error(error.clone()).message, error);
        }
    }
    #[test]
    fn native_network_client_initializes() {
        assert!(client().is_ok(), "network client initialization failed");
        assert_eq!(super::super::error::public_error(CLIENT_ERROR.into()).message,CLIENT_ERROR);
    }
    async fn fixture_response(status: u16, body: &str) -> reqwest::Response {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address=listener.local_addr().unwrap();
        let wire=format!("HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
        tokio::spawn(async move {
            let (mut socket,_)=listener.accept().await.unwrap();
            let mut request=[0u8;1024];
            socket.read(&mut request).await.unwrap();
            socket.write_all(wire.as_bytes()).await.unwrap();
        });
        reqwest::Client::builder().no_proxy().build().unwrap()
            .get(format!("http://{address}")).send().await.unwrap()
    }
    #[tokio::test]
    async fn authorization_failures_identify_stage_without_exposing_response_body() {
        let private_marker=uuid::Uuid::new_v4().to_string();
        for drive_info in [false,true] {
            for (status,index) in [(400,0),(401,1),(403,2),(429,3),(500,4)] {
                let response=fixture_response(status,&private_marker).await;
                let error=authorization_response(response,drive_info).await.unwrap_err();
                assert_eq!(error,authorization_error(drive_info,index));
                assert!(!error.contains(&private_marker));
                assert_eq!(super::super::error::public_error(error.clone()).message,error);
                assert_ne!(super::super::error::public_error(format!("{error} {private_marker}")).message,format!("{error} {private_marker}"));
            }
            let response=fixture_response(200,"invalid-json").await;
            assert_eq!(authorization_response(response,drive_info).await.unwrap_err(),authorization_error(drive_info,6));
            let response=fixture_response(200,r#"{"ok":true}"#).await;
            assert_eq!(authorization_response(response,drive_info).await.unwrap(),json!({"ok":true}));
        }
    }
    #[test]
    fn alipan_s256_retains_required_base64url_padding() {
        // RFC vector verifies SHA-256 and URL-safe '-' encoding; Alipan also
        // requires the final '=' (unlike RFC 7636's unpadded wire encoding).
        let challenge = pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
        assert_eq!(challenge,"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM=");
        let mut url = reqwest::Url::parse(&format!("{ORIGIN}/oauth/authorize")).unwrap();
        url.query_pairs_mut().append_pair("code_challenge", &challenge);
        assert!(url.as_str().ends_with("%3D"));
        assert_eq!(url.query_pairs().next().unwrap().1, challenge);
    }
    #[tokio::test]
    async fn token_errors_classify_only_documented_codes_without_reflecting_private_data() {
        let private_marker = uuid::Uuid::new_v4().to_string();
        for (code, index) in [("AppNotExists",14),("InvalidClientSecret",15),
            ("InvalidCode",16),("InvalidClientId",17),("InvalidGrantType",18)] {
            let body = json!({"code":code,"message":private_marker,"access_token":private_marker}).to_string();
            for status in [400,401,403] {
                let error = authorization_response(fixture_response(status,&body).await,false).await.unwrap_err();
                assert_eq!(error,AUTH_DIAGNOSTICS[index]);
                assert!(!error.contains(&private_marker));
                assert_eq!(super::super::error::public_error(error.clone()).message,error);
            }
            // Drive-info failures and rate limits retain their own stage/status.
            assert_eq!(authorization_response(fixture_response(400,&body).await,true).await.unwrap_err(),authorization_error(true,0));
            assert_eq!(authorization_response(fixture_response(429,&body).await,false).await.unwrap_err(),authorization_error(false,3));
        }
        for body in [
            json!({"code":private_marker,"message":"InvalidCode"}).to_string(),
            json!({"code":format!("InvalidCode{private_marker}")}).to_string(),
            json!({"code":null}).to_string(),
            "invalid-json".into(),
            format!("{{\"code\":\"InvalidCode\",\"message\":\"{}\"}}", "x".repeat(16*1024)),
        ] {
            let error = authorization_response(fixture_response(400,&body).await,false).await.unwrap_err();
            assert_eq!(error,authorization_error(false,0));
            assert!(!error.contains(&private_marker));
        }
    }
    #[test]
    fn expired_authorizations_are_rejected() {
        let mut c=super::super::model::tests::fixture();
        c.alipan_auth=Some(Authorization{access_token:uuid::Uuid::new_v4().to_string(),expires_at:0,user_id:"test".into(),drive_id:"test".into(),root_id:"root".into(),writable:false});
        assert!(credentials(&c).is_err());
        let view=c.view().to_string();
        assert!(!view.contains(&c.alipan_auth.as_ref().unwrap().access_token));
    }
}
