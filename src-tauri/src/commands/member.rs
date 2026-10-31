//! Public membership identity is separate from local cloud credentials and database transfer.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::Mutex;
use crate::core::{crypto::{decrypt_secret, encrypt_secret}, paths::data_dir};
use crate::core::error::PlatformResult;

const API: &str = "https://yun.wlphp.com/php/api.php";
static SESSION_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Member {
    pub id: u64,
    pub email: String,
    #[serde(default)]
    pub nickname: String,
    pub avatar_key: u8,
    pub is_vip: bool,
    pub is_admin: bool,
    pub status: String,
    pub created_at: String,
    pub last_login_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct MemberLoginRecord {
    pub event: String,
    pub result: String,
    pub ip: String,
    pub client_type: String,
    pub created_at: String,
}

fn session_path() -> Result<std::path::PathBuf, String> { Ok(data_dir()?.join("member-session.enc")) }
fn token() -> Result<Option<zeroize::Zeroizing<String>>, String> {
    let path = session_path()?;
    match std::fs::read_to_string(path) {
        Ok(cipher) => {
            let plain = zeroize::Zeroizing::new(decrypt_secret(&cipher).map_err(|_| "会员会话无法读取，请重新登录")?);
            if plain.len() != 64 || !plain.bytes().all(|c| c.is_ascii_hexdigit()) { return Err("会员会话无效，请重新登录".into()); }
            Ok(Some(plain))
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("会员会话无法读取".into()),
    }
}
fn clear() -> Result<(), String> {
    match std::fs::remove_file(session_path()?) {
        Ok(()) => Ok(()), Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()), Err(_) => Err("清除本机会员会话失败".into()),
    }
}
fn valid_email(value: &str) -> bool {
    let parts: Vec<_> = value.split('@').collect();
    value.len() <= 254 && value.is_ascii() && !value.bytes().any(|c| c <= 32 || c == 127)
        && parts.len() == 2 && !parts[0].is_empty() && parts[1].contains('.')
}
fn api_error(status: u16, action: &str) -> &'static str {
    match (status, action) {
        (422, "member.nickname") => "昵称需为1到20个字符，且不能包含控制字符",
        (422, _) => "邮箱或验证码无效、过期，请检查后重新获取",
        (429, _) => "操作太频繁，请稍后再试",
        (403, _) => "该会员不可用，请联系管理员",
        (404, _) => "会员服务接口版本不匹配，请更新会员服务",
        (500..=599, _) => "会员服务发生内部错误，请稍后重试",
        _ => "会员服务请求失败，请稍后重试",
    }
}
async fn request(action: &str, payload: Option<Value>, secret: Option<&str>) -> Result<Value, String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(35)).connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|_| "会员服务网络初始化失败")?;
    let query_payload = action == "member.login_logs";
    let mut builder = if payload.is_some() && !query_payload { client.post(API) } else { client.get(API) };
    builder = builder.query(&[("action", action)]).header("X-CloudHub-Client", "native");
    if let Some(secret) = secret { builder = builder.bearer_auth(secret); }
    if let Some(payload) = payload {
        if query_payload {
            let page = payload["page"].as_u64().ok_or("登录记录页码无效")?;
            builder = builder.query(&[("page", page)]);
        } else {
            builder = builder.json(&payload);
        }
    }
    let response = builder.send().await.map_err(|_| "会员服务连接失败，请检查网络后重试")?;
    let status = response.status();
    if status.as_u16() == 401 { clear()?; return Err("登录已失效，请重新登录".into()); }
    // Do not surface remote bodies, URLs, request headers or credential-shaped errors.
    if status.is_redirection() { return Err("会员服务地址发生跳转，请更新客户端".into()); }
    if response.content_length().is_some_and(|length| length > 64 * 1024) { return Err("会员服务响应无效".into()); }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "会员服务响应读取失败")? {
        if bytes.len() + chunk.len() > 64 * 1024 { return Err("会员服务响应无效".into()); }
        bytes.extend_from_slice(&chunk);
    }
    let mut value: Value = serde_json::from_slice(&bytes).map_err(|_| "会员服务尚未就绪，请稍后重试")?;
    use zeroize::Zeroize;
    bytes.zeroize();
    if !status.is_success() || value["ok"] != true {
        return Err(api_error(status.as_u16(), action).into());
    }
    Ok(value["data"].take())
}
fn member(value: &Value) -> Result<Member, String> {
    let mut result: Member = serde_json::from_value(value["member"].clone()).map_err(|_| "会员资料格式无效")?;
    if result.nickname.trim().is_empty() { result.nickname = "匿名用户".into(); }
    if result.id == 0 || !valid_email(&result.email) || result.nickname.trim().is_empty() || result.nickname.chars().count() > 20 || result.nickname.chars().any(char::is_control) || !(1..=12).contains(&result.avatar_key) || result.status != "active" || result.is_admin != (result.id == 1) {
        return Err("会员资料格式无效".into());
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn member_me() -> PlatformResult<Option<Member>> {
    let _guard = SESSION_LOCK.lock().await;
    let Some(secret) = token()? else { return Ok(None); };
    let data = request("member.me", None, Some(&secret)).await?;
    Ok(Some(member(&data)?))
}
#[tauri::command]
pub(crate) async fn member_web_handoff() -> PlatformResult<String> {
    let _guard = SESSION_LOCK.lock().await;
    let secret = token()?.ok_or("请先登录")?;
    let data = request("member.web_handoff", Some(json!({})), Some(&secret)).await?;
    let ticket = data["ticket"].as_str().ok_or("会员中心登录链接生成失败")?;
    if ticket.len() != 64 || !ticket.bytes().all(|c| c.is_ascii_hexdigit()) { return Err("会员中心登录链接格式无效".into()); }
    Ok(ticket.to_owned())
}
#[tauri::command]
pub(crate) async fn member_send_code(email: String) -> PlatformResult<u32> {
    let email = email.trim().to_ascii_lowercase();
    if !valid_email(&email) { return Err("请输入有效邮箱".into()); }
    let data = request("auth.send_code", Some(json!({"email":email})), None).await?;
    Ok(data["retry_after"].as_u64().unwrap_or(60).clamp(1, 300) as u32)
}
#[tauri::command]
pub(crate) async fn member_login(email: String, code: String) -> PlatformResult<Member> {
    let _guard = SESSION_LOCK.lock().await;
    let email = email.trim().to_ascii_lowercase();
    if !valid_email(&email) || code.len() != 6 || !code.bytes().all(|c| c.is_ascii_digit()) { return Err("请填写有效邮箱和6位验证码".into()); }
    let mut data = request("auth.login", Some(json!({"email":email,"code":code,"device_label":format!("CloudHub {}",std::env::consts::OS)})), None).await?;
    let result = member(&data)?;
    let Value::String(secret) = data["token"].take() else { return Err("登录响应无效".into()); };
    let secret = zeroize::Zeroizing::new(secret);
    if secret.len() != 64 || !secret.bytes().all(|c| c.is_ascii_hexdigit()) { return Err("登录响应无效".into()); }
    let cipher = encrypt_secret(&secret).map_err(|_| "保存会员会话失败")?;
    std::fs::write(session_path()?, cipher).map_err(|_| "保存会员会话失败")?;
    Ok(result)
}
#[tauri::command]
pub(crate) async fn member_avatar(avatar_key: u8) -> PlatformResult<Member> {
    if !(1..=12).contains(&avatar_key) { return Err("请选择有效头像".into()); }
    let _guard = SESSION_LOCK.lock().await;
    let secret = token()?.ok_or("请先登录")?;
    let data = request("member.avatar", Some(json!({"avatar_key":avatar_key})), Some(&secret)).await?;
    Ok(member(&data)?)
}

#[tauri::command]
pub(crate) async fn member_nickname(nickname: String) -> PlatformResult<Member> {
    let nickname = nickname.trim().to_owned();
    if nickname.is_empty() || nickname.chars().count() > 20 || nickname.chars().any(char::is_control) { return Err("昵称需为1到20个字符，且不能包含控制字符".into()); }
    let _guard = SESSION_LOCK.lock().await;
    let secret = token()?.ok_or("请先登录")?;
    let data = request("member.nickname", Some(json!({"nickname":nickname})), Some(&secret)).await?;
    Ok(member(&data)?)
}

#[tauri::command]
pub(crate) async fn member_login_logs(page: u32) -> PlatformResult<Vec<MemberLoginRecord>> {
    if page == 0 || page > 100_000 { return Err("登录记录页码无效".into()); }
    let _guard = SESSION_LOCK.lock().await;
    let secret = token()?.ok_or("请先登录")?;
    let data = request("member.login_logs", Some(json!({"page":page})), Some(&secret)).await?;
    let records: Vec<MemberLoginRecord> = serde_json::from_value(data["items"].clone()).map_err(|_| "登录记录格式无效")?;
    if records.len() > 20 || records.iter().any(|record| {
        !matches!(record.event.as_str(), "login" | "register" | "logout" | "send_code")
            || !matches!(record.result.as_str(), "success" | "failed")
            || !matches!(record.client_type.as_str(), "native" | "web")
            || record.ip.len() > 45 || record.created_at.len() > 32
            || record.ip.chars().any(char::is_control) || record.created_at.chars().any(char::is_control)
    }) { return Err("登录记录格式无效".into()); }
    Ok(records)
}
#[tauri::command]
pub(crate) async fn member_logout() -> PlatformResult<bool> {
    let _guard = SESSION_LOCK.lock().await;
    let secret = token().ok().flatten();
    clear()?;
    let revoked = if let Some(secret) = secret { request("auth.logout", Some(json!({})), Some(&secret)).await.is_ok() } else { true };
    Ok(revoked)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn membership_contract_rejects_invalid_identity() {
        let good = json!({"member":{"id":2,"email":"user@example.invalid","nickname":"星河小熊猫123","avatar_key":1,"is_vip":false,"is_admin":false,"status":"active","created_at":"2026-10-31 00:00:00","last_login_at":null}});
        assert!(member(&good).is_ok());
        let mut unnamed = good.clone(); unnamed["member"]["nickname"] = json!("  ");
        assert_eq!(member(&unnamed).unwrap().nickname, "匿名用户");
        let mut old_api = good.clone(); old_api["member"].as_object_mut().unwrap().remove("nickname");
        assert_eq!(member(&old_api).unwrap().nickname, "匿名用户");
        for (field,value) in [("avatar_key",json!(0)),("is_admin",json!(true)),("status",json!("disabled")),("email",json!("bad\r\nmail"))] {
            let mut bad=good.clone();bad["member"][field]=value;assert!(member(&bad).is_err());
        }
        assert!(!valid_email("a@b@c.example"));
    }
    #[test]
    fn api_errors_distinguish_missing_or_failing_service_without_leaking_body() {
        assert_eq!(api_error(404, "member.nickname"), "会员服务接口版本不匹配，请更新会员服务");
        assert_eq!(api_error(500, "member.nickname"), "会员服务发生内部错误，请稍后重试");
        assert_eq!(api_error(422, "member.nickname"), "昵称需为1到20个字符，且不能包含控制字符");
    }
}
