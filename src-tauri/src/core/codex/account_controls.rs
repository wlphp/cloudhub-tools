use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;

pub const SCHEMA: &str = crate::core::database::CODEX_ACCOUNT_CONTROLS_SCHEMA;
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all="camelCase", default)]
pub struct ResetCard {
    pub id: Option<String>,
    pub status: Option<String>,
    pub reset_type: Option<String>,
    pub granted_at: Option<i64>,
    pub expires_at: Option<i64>,
    pub redeemed_at: Option<i64>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all="camelCase", default)]
pub struct Benefits {
    pub expires_at: Option<i64>,
    pub reset_credits: Option<u64>,
    pub reset_expires_at: Option<i64>,
    pub reset_cards: Vec<ResetCard>,
    pub fetched_at: Option<i64>,
    pub subscription_error: Option<String>,
    pub credits_error: Option<String>,
}
pub fn proxy(conn: &Connection,id:i64)->Result<Option<String>,String> {
    conn.query_row("SELECT proxy_url FROM codex_account_controls WHERE account_id=?1",[id],|r|r.get(0)).optional().map(|v|v.flatten()).map_err(|_|"读取账号代理失败".into())
}
pub fn validate_proxy(raw:&str)->Result<Option<String>,String> {
    if raw.chars().any(char::is_control) { return Err("代理地址不能包含换行或控制字符".into()); }
    let raw=raw.trim(); if raw.is_empty() { return Ok(None); }
    if raw.len()>512 { return Err("代理地址不能超过 512 个字符".into()); }
    if !raw.contains("://") { return Err("代理地址缺少协议，请填写 http://127.0.0.1:10808 这样的完整地址".into()); }
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
pub fn save_proxies(conn: &mut Connection, ids: &[i64], raw: &str) -> Result<Vec<super::CodexAccountSummary>, String> {
    validate_proxy(raw)?;
    if ids.is_empty() || ids.len() > 1000 || ids.iter().any(|id| *id <= 0) {
        return Err("请选择 1–1000 个有效账号后批量设置代理".into());
    }
    let ids = ids.iter().copied().collect::<std::collections::BTreeSet<_>>();
    let tx = conn.transaction().map_err(|_| "批量保存代理失败，未修改任何账号")?;
    let mut accounts = Vec::new();
    for id in ids {
        crate::core::repositories::codex_accounts::get(&tx, id).map_err(|_| "所选账号已不存在，请刷新列表后重试")?;
        save_proxy(&tx, id, raw).map_err(|_| "批量保存代理失败，未修改任何账号")?;
        accounts.push(crate::core::repositories::codex_accounts::get(&tx, id)?);
    }
    tx.commit().map_err(|_| "批量保存代理失败，未修改任何账号")?;
    Ok(accounts)
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
        let record=accounts.get(account_id).or_else(|| accounts.values().find(|record| {
            ["account_id", "id", "chatgpt_account_id", "workspace_id"].iter().any(|key|
                record.get("account").unwrap_or(record).get(*key).and_then(Value::as_str) == Some(account_id))
        }))?;
        return timestamp(record.pointer("/entitlement/expires_at").or_else(||record.pointer("/account/expires_at")).or_else(||record.get("expires_at")));
    }
    timestamp(value.get("active_until").or_else(||value.get("expires_at")))
}
pub fn parse_usage(value: &Value, account: &str) -> Result<super::QuotaSnapshot, String> {
    if value.get("account_id").and_then(Value::as_str).is_some_and(|id| id != account) {
        return Err("额度接口返回了不同工作区，未保存数据".into());
    }
    let limits = value.get("rate_limit").ok_or("额度接口未返回窗口数据")?;
    let mut windows = Vec::new();
    for (field, name) in [("primary_window", "主要窗口"), ("secondary_window", "次要窗口")] {
        let Some(window) = limits.get(field).filter(|v| !v.is_null()) else { continue; };
        let used = window.get("used_percent").and_then(Value::as_f64)
            .filter(|v| v.is_finite() && (0.0..=100.0).contains(v)).ok_or("额度接口百分比无效")?;
        windows.push(super::QuotaWindow { name: format!("codex · {name}"), used_percent: used,
            window_minutes: window.get("limit_window_seconds").and_then(Value::as_u64)
                .filter(|v| *v >= 60 && *v <= 31_536_000).map(|v| v / 60),
            resets_at: timestamp(window.get("reset_at")) });
    }
    if windows.is_empty() { return Err("额度接口未返回有效窗口".into()); }
    Ok(super::QuotaSnapshot { windows, fetched_at: Some(chrono::Utc::now().timestamp_millis()) })
}
pub fn parse_credits(value:&Value,now:i64)->Result<(u64,Option<i64>),String> {
    let value=value.get("data").filter(|v|v.is_object()).unwrap_or(value);
    let records=value.get("credits").and_then(Value::as_array);
    if records.is_some_and(|v|v.len()>1000) { return Err("重置次数响应过大".into()); }
    let available=|v:&Value| {
        let status=v.get("status").or_else(||v.get("state")).and_then(Value::as_str).map(str::trim);
        status.is_none_or(|status| ["available", "active", "unused"].iter().any(|valid| status.eq_ignore_ascii_case(valid)))
            && ["expires_at", "expire_at", "expiresAt"].iter().find_map(|key| timestamp(v.get(*key))).is_none_or(|time|time>now)
    };
    let count=value.get("available_count").or_else(||value.get("availableCount")).and_then(Value::as_u64).filter(|v|*v<=10000).or_else(||records.map(|items|items.iter().filter(|v|available(v)).count() as u64)).ok_or("上游未返回有效的重置次数")?;
    let expiry=records.into_iter().flatten().filter(|v|available(v)).filter_map(|v|timestamp(v.get("expires_at"))).min();
    Ok((count,expiry))
}
pub fn parse_reset_cards(value:&Value,now:i64)->Vec<ResetCard> {
    let root=value.get("data").filter(|v|v.is_object()).unwrap_or(value);
    root.get("credits").and_then(Value::as_array).into_iter().flatten().filter_map(|item| {
        if item.as_object().is_none_or(|obj| obj.len()>24) { return None; }
        let expires_at = ["expires_at", "expire_at", "expiresAt"].iter().find_map(|key| timestamp(item.get(*key)));
        let status=item.get("status").or_else(||item.get("state")).and_then(Value::as_str)
            .filter(|v|v.len()<=40 && !v.chars().any(char::is_control)).map(|v|v.trim().to_ascii_lowercase())
            .or_else(|| expires_at.filter(|expires| *expires <= now).map(|_| "expired".into()));
        let reset_type=item.get("reset_type").or_else(||item.get("resetType")).or_else(||item.get("type")).and_then(Value::as_str)
            .filter(|v|v.len()<=80 && !v.chars().any(char::is_control)).map(str::to_owned);
        let id=["id", "credit_id", "creditId"].iter().find_map(|key| item.get(*key).and_then(Value::as_str))
            .filter(|v|!v.is_empty() && v.len()<=160 && !v.chars().any(char::is_control)).map(str::to_owned);
        let field=|keys:&[&str]| keys.iter().find_map(|key| timestamp(item.get(*key)));
        let granted_at=field(&["granted_at", "created_at", "grantedAt"]);
        let redeemed_at=field(&["redeemed_at", "used_at", "consumed_at", "redeemedAt"]);
        Some(ResetCard { id, status, reset_type, granted_at, expires_at, redeemed_at })
    }).take(1000).filter(|card| card.status.as_deref().is_some_and(|s|matches!(s,"available"|"active"|"unused"|"redeemed"|"used"|"consumed"|"expired")) || card.expires_at.is_some_and(|v|v<now)).collect()
}
pub fn save_benefits(conn:&Connection,id:i64,benefits:&Benefits)->Result<(),String> {
    let raw=serde_json::to_string(benefits).map_err(|_|"账号权益格式无效")?;
    conn.execute("INSERT INTO codex_account_controls(account_id,benefits_json) VALUES(?1,?2) ON CONFLICT(account_id) DO UPDATE SET benefits_json=excluded.benefits_json",params![id,raw]).map_err(|_|"保存账号权益失败")?; Ok(())
}
pub async fn request(client:&reqwest::Client,token:&str,account:&str,id:i64,proxy:Option<&str>,path:&str,redeem:Option<&str>)->Result<Value,String> {
    let url=format!("https://chatgpt.com/backend-api/{path}");
    let mut request=if let Some(id)=redeem {client.post(url).json(&json!({"redeem_request_id":id}))}else{client.get(url)};
    request=request.bearer_auth(token).header("ChatGPT-Account-Id",account).header("Accept","application/json").header("Referer","https://chatgpt.com/").header("User-Agent","CloudHub-Tools/0.1").header("x-openai-target-path",format!("/backend-api/{path}")).header("x-openai-target-route",format!("/backend-api/{path}")).timeout(Duration::from_secs(30));
    let (mut response, mut log)=super::remote_logs::send(client,request,Some(id),proxy,token).await.map_err(|error|if redeem.is_some(){"重置结果未确认，请先刷新次数；再次操作将沿用同一请求标识"}else if error.is_timeout(){"账号信息请求超时，请检查网络或代理"}else if error.is_connect(){"无法连接账号信息接口，请检查代理、DNS或网络连接"}else{"账号信息请求发送失败，请检查网络或代理"})?;
    let status=response.status();
    if !status.is_success() {
        let mut bytes=zeroize::Zeroizing::new(Vec::new());
        while let Ok(Some(chunk))=response.chunk().await {if bytes.len()+chunk.len()>65536 {log.finish("http_error_body_truncated");break;} bytes.extend_from_slice(&chunk);}
        log.body(&bytes);
        let diagnostics = serde_json::from_slice::<Value>(&bytes).ok().map(|value| super::rpc::error_diagnostics(value.get("error").unwrap_or(&value))).unwrap_or_default();
        let message = match status.as_u16() {401|403=>"账号认证失效或无权限，请刷新认证后重试",429=>"请求频率受限，请稍后重试",_=>"账号信息接口请求失败"};
        return Err(format!("{message}；阶段：{path}；HTTP {}；body_len={}；{diagnostics}", status.as_u16(), bytes.len())); }
    if redeem.is_some() {
        if log.enabled() {
            let mut bytes=zeroize::Zeroizing::new(Vec::new());
            while let Ok(Some(chunk))=response.chunk().await {if bytes.len()+chunk.len()>65536 {break;}bytes.extend_from_slice(&chunk);}
            log.body(&bytes);
        }
        log.finish("completed");return Ok(Value::Null);
    }
    let mut bytes=zeroize::Zeroizing::new(Vec::new());
    while let Some(chunk)=response.chunk().await.map_err(|_|{log.finish("body_error");"账号信息响应中断"})? {if bytes.len()+chunk.len()>1024*1024 {log.finish("body_too_large");return Err("账号信息响应过大".into());} bytes.extend_from_slice(&chunk);}
    log.body(&bytes); log.finish("completed");
    serde_json::from_slice(&bytes).map_err(|_|{log.finish("invalid_json");"账号信息响应格式无效".into()})
}
#[cfg(test)] mod tests {
 use super::*;
 #[test] fn reset_card_parser_accepts_upstream_field_aliases_and_keeps_safe_details() {
  let now=1_800_000_000;
  let value=serde_json::json!({"data":{"credits":[
   {"creditId":"credit-1","state":"AVAILABLE","resetType":"weekly","created_at":1_700_000_000,"expiresAt":1_900_000_000,"redeemedAt":null},
   {"credit_id":"credit-2","status":"USED","used_at":1_750_000_000,"expires_at":1_900_000_000}
  ]}});
  let cards=parse_reset_cards(&value,now);
  assert_eq!(cards.len(),2);
  assert_eq!(cards[0].id.as_deref(),Some("credit-1"));
  assert_eq!(cards[0].status.as_deref(),Some("available"));
  assert_eq!(cards[0].reset_type.as_deref(),Some("weekly"));
  assert_eq!(cards[0].granted_at,Some(1_700_000_000));
  assert_eq!(cards[1].status.as_deref(),Some("used"));
  assert_eq!(cards[1].redeemed_at,Some(1_750_000_000));
 }
 #[test] fn batch_proxy_updates_are_atomic_and_can_clear() {
  let mut conn = Connection::open_in_memory().unwrap();
  conn.execute_batch(crate::core::database::CODEX_SCHEMA).unwrap();
  for id in [1,2] { conn.execute("INSERT INTO codex_accounts(id,identity,label,auth_mode,auth_ciphertext,updated_at) VALUES(?1,?2,'fixture','chatgpt','fixture',0)", params![id,format!("fixture-{id}")]).unwrap(); }
  let result = save_proxies(&mut conn, &[1,2,2], "http://127.0.0.1:10808").unwrap();
  assert_eq!(result.len(), 2);
  assert_eq!(proxy(&conn, 2).unwrap().as_deref(), Some("http://127.0.0.1:10808/"));
  assert!(save_proxies(&mut conn, &[1,999], "http://127.0.0.1:7890").is_err());
  assert_eq!(proxy(&conn, 1).unwrap().as_deref(), Some("http://127.0.0.1:10808/"));
  conn.execute_batch("CREATE TRIGGER reject_proxy BEFORE INSERT ON codex_account_controls WHEN NEW.account_id=2 BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
  assert!(save_proxies(&mut conn, &[1,2], "http://127.0.0.1:7890").is_err());
  assert_eq!(proxy(&conn, 1).unwrap().as_deref(), Some("http://127.0.0.1:10808/"));
  conn.execute_batch("DROP TRIGGER reject_proxy;").unwrap();
  assert!(save_proxies(&mut conn, &[], "").is_err());
  assert!(save_proxies(&mut conn, &[1,2], "127.0.0.1:7890").is_err());
  save_proxies(&mut conn, &[1,2], "").unwrap();
  assert_eq!(proxy(&conn, 1).unwrap(), None);
  assert_eq!(proxy(&conn, 2).unwrap(), None);
 }
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
  assert_eq!(parse_subscription(&json!({"accounts":{"organization":{"account":{"id":"selected"},"entitlement":{"expires_at":2000000000}}}}),"selected"),Some(2000000000));
  assert_eq!(parse_subscription(&json!({"accounts":{"other":{"entitlement":{"expires_at":2000000000}}}}),"selected"),None);
  assert_eq!(parse_subscription(&json!({"accounts":{"selected":{"entitlement":{"expires_at":"2030-01-01T00:00:00Z"}}}}),"selected"),Some(1893456000));
  assert!(parse_credits(&json!({}),1).is_err());
  assert_eq!(parse_credits(&json!({"credits":[{"status":"available","expires_at":100},{"status":"redeemed","expires_at":100},{"status":"available","expires_at":1}]}),10).unwrap(),(1,Some(100)));
 }
 #[test] fn direct_usage_validates_workspace_and_preserves_actual_windows() {
  let value=json!({"account_id":"selected","rate_limit":{"primary_window":{"used_percent":64,"limit_window_seconds":18000,"reset_at":2000000000},"secondary_window":{"used_percent":79,"limit_window_seconds":604800,"reset_at":2000010000}}});
  let quota=parse_usage(&value,"selected").unwrap();
  assert_eq!(quota.windows.len(),2);
  assert_eq!(quota.windows[0].used_percent,64.0);
  assert_eq!(quota.windows[0].window_minutes,Some(300));
  assert_eq!(quota.windows[1].window_minutes,Some(10080));
  assert!(parse_usage(&value,"foreign").is_err());
  assert!(parse_usage(&json!({"rate_limit":{"primary_window":{"used_percent":101}}}),"selected").is_err());
 }
}
