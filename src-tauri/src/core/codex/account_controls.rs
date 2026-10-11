use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;

pub const SCHEMA: &str = crate::core::database::CODEX_ACCOUNT_CONTROLS_SCHEMA;
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all="camelCase", default)]
pub struct Benefits {
    pub expires_at: Option<i64>,
    pub reset_credits: Option<u64>,
    pub reset_expires_at: Option<i64>,
    pub fetched_at: Option<i64>,
    pub subscription_error: Option<String>,
    pub credits_error: Option<String>,
}
pub fn proxy(conn: &Connection,id:i64)->Result<Option<String>,String> {
    conn.query_row("SELECT proxy_url FROM codex_account_controls WHERE account_id=?1",[id],|r|r.get(0)).optional().map(|v|v.flatten()).map_err(|_|"读取账号代理失败".into())
}
pub fn validate_proxy(raw:&str)->Result<Option<String>,String> {
    if raw.chars().any(char::is_control) { return Err("代理地址无效".into()); }
    let raw=raw.trim(); if raw.is_empty() { return Ok(None); }
    if raw.len()>512 || raw.chars().any(char::is_control) { return Err("代理地址无效".into()); }
    let url=reqwest::Url::parse(raw).map_err(|_|"代理地址无效")?;
    if !matches!(url.scheme(),"http"|"https") || url.host_str().is_none() || url.port()==Some(0) || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() || url.path()!="/" {
        return Err("请填写无账号密码的 HTTP/HTTPS 代理地址，例如 http://127.0.0.1:7890".into());
    }
    Ok(Some(url.to_string()))
}
pub fn save_proxy(conn:&Connection,id:i64,raw:&str)->Result<(),String> {
    let url=validate_proxy(raw)?;
    conn.execute("INSERT INTO codex_account_controls(account_id,proxy_url) VALUES(?1,?2) ON CONFLICT(account_id) DO UPDATE SET proxy_url=excluded.proxy_url",params![id,url]).map_err(|_|"保存账号代理失败")?; Ok(())
}
pub fn client(proxy: Option<&str>)->Result<reqwest::Client,String> {
    let mut builder=reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(180)).redirect(reqwest::redirect::Policy::none());
    if let Some(url)=proxy { let url=validate_proxy(url)?.ok_or("代理地址无效")?; builder=builder.proxy(reqwest::Proxy::all(url).map_err(|_|"代理地址无效")?); }
    builder.build().map_err(|_|"创建账号连接失败".into())
}
pub fn apply_proxy(command:&mut std::process::Command,proxy:Option<&str>)->Result<(),String> {
    if let Some(url)=proxy { let url=validate_proxy(url)?.ok_or("代理地址无效")?;
        for key in ["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","http_proxy","https_proxy","all_proxy"] { command.env(key,&url); }
        command.env("NO_PROXY","127.0.0.1,localhost,::1").env("no_proxy","127.0.0.1,localhost,::1");
    }
    Ok(())
}
fn timestamp(value:Option<&Value>)->Option<i64> {
    let value=value?;
    let time=value.as_i64().or_else(||value.as_str().and_then(|s|s.parse().ok())).or_else(||value.as_str().and_then(|s|chrono::DateTime::parse_from_rfc3339(s).ok().map(|v|v.timestamp())))?;
    let time=if time>10_000_000_000 {time/1000}else{time};
    (time>0 && time<32_503_680_000).then_some(time)
}
pub fn parse_subscription(value:&Value,account_id:&str)->Option<i64> {
    // Never infer a selected workspace's entitlement from another account.
    if let Some(accounts)=value.get("accounts").and_then(Value::as_object) {
        let record=accounts.get(account_id)?;
        return timestamp(record.pointer("/entitlement/expires_at").or_else(||record.pointer("/account/expires_at")).or_else(||record.get("expires_at")));
    }
    timestamp(value.get("active_until").or_else(||value.get("expires_at")))
}
pub fn parse_credits(value:&Value,now:i64)->Result<(u64,Option<i64>),String> {
    let value=value.get("data").filter(|v|v.is_object()).unwrap_or(value);
    let records=value.get("credits").and_then(Value::as_array);
    if records.is_some_and(|v|v.len()>1000) { return Err("重置次数响应过大".into()); }
    let available=|v:&Value| { let status=v.get("status").or_else(||v.get("state")).and_then(Value::as_str); matches!(status,Some("available"|"active"|"unused")) && timestamp(v.get("expires_at")).is_none_or(|time|time>now) };
    let count=value.get("available_count").or_else(||value.get("availableCount")).and_then(Value::as_u64).filter(|v|*v<=10000).or_else(||records.map(|items|items.iter().filter(|v|available(v)).count() as u64)).ok_or("上游未返回有效的重置次数")?;
    let expiry=records.into_iter().flatten().filter(|v|available(v)).filter_map(|v|timestamp(v.get("expires_at"))).min();
    Ok((count,expiry))
}
pub fn save_benefits(conn:&Connection,id:i64,benefits:&Benefits)->Result<(),String> {
    let raw=serde_json::to_string(benefits).map_err(|_|"账号权益格式无效")?;
    conn.execute("INSERT INTO codex_account_controls(account_id,benefits_json) VALUES(?1,?2) ON CONFLICT(account_id) DO UPDATE SET benefits_json=excluded.benefits_json",params![id,raw]).map_err(|_|"保存账号权益失败")?; Ok(())
}
pub async fn request(client:&reqwest::Client,token:&str,account:&str,path:&str,redeem:Option<&str>)->Result<Value,String> {
    let url=format!("https://chatgpt.com/backend-api/{path}");
    let mut request=if let Some(id)=redeem {client.post(url).json(&json!({"redeem_request_id":id}))}else{client.get(url)};
    request=request.bearer_auth(token).header("ChatGPT-Account-Id",account).header("Accept","application/json").header("Referer","https://chatgpt.com/").header("User-Agent","CloudHub-Tools/0.1").header("x-openai-target-path",format!("/backend-api/{path}")).header("x-openai-target-route",format!("/backend-api/{path}")).timeout(Duration::from_secs(30));
    let mut response=request.send().await.map_err(|_|if redeem.is_some(){"重置结果未确认，请先刷新次数；再次操作将沿用同一请求标识"}else{"查询账号信息失败，请检查网络或代理"})?;
    let status=response.status();
    if !status.is_success() { return Err(match status.as_u16() {401|403=>"账号认证失效或无权限，请刷新认证后重试".into(),429=>"请求频率受限，请稍后重试".into(),code=>format!("账号信息接口返回 HTTP {code}")}); }
    if redeem.is_some() {return Ok(Value::Null);}
    let mut bytes=zeroize::Zeroizing::new(Vec::new());
    while let Some(chunk)=response.chunk().await.map_err(|_|"账号信息响应中断")? {if bytes.len()+chunk.len()>1024*1024 {return Err("账号信息响应过大".into());} bytes.extend_from_slice(&chunk);}
    serde_json::from_slice(&bytes).map_err(|_|"账号信息响应格式无效".into())
}
#[cfg(test)] mod tests {
 use super::*;
 #[test] fn proxies_reject_credentials_paths_and_shell_data() {
  assert_eq!(validate_proxy(" http://127.0.0.1:7890 ").unwrap(),Some("http://127.0.0.1:7890/".into()));
  for value in ["http://user:fake@host:80","file:///x","socks5://host:9","http://host/path","http://host/?token=fake","http://host/\n"] { assert!(validate_proxy(value).is_err()); }
 }
 #[test] fn preferences_survive_reopen_and_refresh_preserves_proxy() {
  let temp=std::env::temp_dir().join(format!("cloudhub-controls-{}.db",uuid::Uuid::new_v4()));
  { let conn=Connection::open(&temp).unwrap(); conn.execute_batch(crate::core::database::CODEX_SCHEMA).unwrap(); conn.execute("INSERT INTO codex_accounts(identity,label,auth_mode,auth_ciphertext,updated_at) VALUES('test','test','chatgpt','fixture',0)",[]).unwrap();
    save_proxy(&conn,1,"http://127.0.0.1:7890").unwrap(); save_benefits(&conn,1,&Benefits {reset_credits:Some(3),..Default::default()}).unwrap();
    assert!(save_proxy(&conn,1,"http://user:fake@host").is_err()); }
  { let conn=Connection::open(&temp).unwrap(); assert_eq!(proxy(&conn,1).unwrap(),Some("http://127.0.0.1:7890/".into())); let summary=crate::core::repositories::codex_accounts::get(&conn,1).unwrap(); assert_eq!(summary.benefits.reset_credits,Some(3)); save_proxy(&conn,1,"").unwrap(); assert_eq!(proxy(&conn,1).unwrap(),None); }
  let _=std::fs::remove_file(temp);
 }
 #[test] fn configured_proxy_is_passed_as_environment_data() {
  let mut command=std::process::Command::new("fixture"); apply_proxy(&mut command,Some("http://127.0.0.1:7890")).unwrap();
  let environment=command.get_envs().filter_map(|(key,value)|value.map(|value|(key.to_string_lossy().to_string(),value.to_string_lossy().to_string()))).collect::<std::collections::HashMap<_,_>>();
  assert_eq!(environment["HTTPS_PROXY"],"http://127.0.0.1:7890/"); assert!(environment["NO_PROXY"].contains("127.0.0.1")); assert!(command.get_args().next().is_none());
 }
 #[tokio::test] async fn http_client_routes_through_selected_proxy() {
  use tokio::io::{AsyncReadExt,AsyncWriteExt};
  let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(); let address=listener.local_addr().unwrap();
  let server=tokio::spawn(async move { let (mut socket,_)=listener.accept().await.unwrap(); let mut bytes=[0u8;4096]; let size=socket.read(&mut bytes).await.unwrap(); let request=std::str::from_utf8(&bytes[..size]).unwrap(); assert!(request.starts_with("GET http://proxy-fixture.invalid/test")); socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK").await.unwrap(); });
  let client=client(Some(&format!("http://{address}"))).unwrap(); let response=client.get("http://proxy-fixture.invalid/test").send().await.unwrap(); assert_eq!(response.text().await.unwrap(),"OK"); server.await.unwrap();
 }
 #[test] fn missing_and_foreign_entitlements_are_not_fabricated() {
  assert_eq!(parse_subscription(&json!({"accounts":{"other":{"entitlement":{"expires_at":2000000000}}}}),"selected"),None);
  assert_eq!(parse_subscription(&json!({"accounts":{"selected":{"entitlement":{"expires_at":"2030-01-01T00:00:00Z"}}}}),"selected"),Some(1893456000));
  assert!(parse_credits(&json!({}),1).is_err());
  assert_eq!(parse_credits(&json!({"credits":[{"status":"available","expires_at":100},{"status":"redeemed","expires_at":100},{"status":"available","expires_at":1}]}),10).unwrap(),(1,Some(100)));
 }
}
