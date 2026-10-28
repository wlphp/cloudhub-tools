use super::provider_probe;
use serde::Serialize;
use serde_json::Value;
use zeroize::Zeroizing;

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct UsageWindow { pub name:&'static str,pub remaining:f64,pub total:Option<f64>,pub unit:String,pub resets_at:Option<i64> }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Usage {pub adapter:String,pub fetched_at:i64,pub windows:Vec<UsageWindow>}

fn number(value:&Value)->Option<f64> {value.as_f64().or_else(||value.as_str()?.parse().ok()).filter(|v|v.is_finite())}
fn nonnegative(value:&Value)->Option<f64> {number(value).filter(|v|*v>=0.0)}
fn reset(value:&Value)->Option<i64> {let n=number(value)?;let n=if n>10_000_000_000.0{n/1000.0}else{n};(n>0.0 && n<=253402300799.0).then_some(n as i64)}
fn reset_after_ms(value:&Value)->Option<i64> {
    let seconds=(nonnegative(value)?/1000.0).ceil() as i64;
    (seconds>0).then(||chrono::Utc::now().timestamp().checked_add(seconds)).flatten()
}
fn payload(value:&Value)->&Value {value.get("data").filter(|v|v.is_object()).unwrap_or(value)}
fn http_failure(status:u16)->String {
    match status {
        401=>"额度接口鉴权失败（HTTP 401），请检查所选密钥是否有效或已禁用".into(),
        403=>"额度接口禁止访问（HTTP 403），请检查令牌权限、IP 白名单或站点访问限制".into(),
        404|405=>format!("站点未提供此额度接口（HTTP {status}）"),
        429=>"额度查询过于频繁（HTTP 429），请稍后重试".into(),
        _=>format!("额度接口请求失败（HTTP {status}）"),
    }
}
/// Only convert raw New API quota using the site's public display settings.
/// No deployment-independent conversion factor or currency is assumed.
fn convert_new_api_quota(windows:&mut [UsageWindow],body:&Value) {
    if body["success"]==false{return;}
    let p=payload(body);
    let Some(per_unit)=number(&p["quota_per_unit"]).filter(|v|*v>0.0) else{return;};
    let (rate,unit)=match p["quota_display_type"].as_str() {
        Some("USD")=>(1.0,"USD"),
        Some("CNY")=>{let Some(rate)=number(&p["usd_exchange_rate"]).filter(|v|*v>0.0) else{return;};(rate,"CNY")},
        Some("CUSTOM")=>{
            let Some(rate)=number(&p["custom_currency_exchange_rate"]).filter(|v|*v>0.0) else{return;};
            let Some(symbol)=p["custom_currency_symbol"].as_str().filter(|s|!s.trim().is_empty()&&s.chars().count()<=12&&!s.chars().any(char::is_control)) else{return;};
            (rate,symbol)
        },
        // Older New API deployments only expose the legacy display flag.
        None if p["display_in_currency"]==true=>(1.0,"USD"),
        _=>return,
    };
    for row in windows.iter_mut().filter(|row|row.unit=="额度单位") {
        let remaining=row.remaining/per_unit*rate;
        let total=row.total.map(|v|v/per_unit*rate);
        if !remaining.is_finite()||total.is_some_and(|v|!v.is_finite()){continue;}
        row.remaining=remaining;row.total=total;row.unit=unit.into();
    }
}

async fn new_api_display_settings(client:&reqwest::Client,base:&str,windows:&mut [UsageWindow],exchanges:&mut Vec<super::provider_logs::Exchange>) {
    if !windows.iter().any(|v|v.unit=="额度单位"){return;}
    let Ok(mut url)=provider_probe::endpoint(base,"models") else{return;};
    url.set_path("/api/status");
    let start=std::time::Instant::now();
    let mut exchange=super::provider_logs::Exchange{method:"GET".into(),url:url.to_string(),..Default::default()};
    // Public metadata: never send the model credential to this endpoint.
    match client.get(url).timeout(std::time::Duration::from_secs(5)).send().await {
        Ok(response)=>{
            exchange.status=Some(response.status().as_u16());
            if response.status().is_success(){
                if let Ok(body)=provider_probe::bounded_json(response).await {convert_new_api_quota(windows,&body);}
            }
        },
        Err(_)=>exchange.error=Some("未获取站点额度显示配置，保留原始额度单位".into()),
    }
    exchange.elapsed_ms=start.elapsed().as_millis() as u64;
    exchanges.push(exchange);
}
fn authorization_value(adapter:&str,key:&str)->Result<reqwest::header::HeaderValue,String> {
    let value=Zeroizing::new(if adapter=="zhipu"{key.to_owned()}else{format!("Bearer {key}")});
    reqwest::header::HeaderValue::from_str(&value).map_err(|_| "供应商密钥格式无效".into())
}
fn endpoint_path(adapter:&str)->&'static str {
    match adapter {"deepseek"=>"/user/balance","minimax"=>"/v1/token_plan/remains","zhipu"=>"/api/monitor/usage/quota/limit",_=>"/api/usage/token/"}
}
/// 额度接口候选地址。新版中转部署同时存在站点根路径与相对 base 两种形态，
/// 依次尝试直到有一个返回可解析的额度。
fn quota_urls(base:&str,adapter:&str)->Result<Vec<reqwest::Url>,String> {
    let base_url=provider_probe::endpoint(base,"models")?;
    if adapter=="one_api" {
        return Ok(["/dashboard/billing/subscription","/dashboard/billing/usage"].iter().map(|path|{let mut url=base_url.clone();url.set_path(path);url}).collect());
    }
    if adapter=="minimax" {
        let origin=match base_url.host_str() {
            Some("api.minimaxi.com"|"www.minimaxi.com")=>"https://www.minimaxi.com",
            Some("api.minimax.io"|"www.minimax.io")=>"https://www.minimax.io",
            _=>return Err("MiniMax 额度查询仅支持官方地址".into()),
        };
        return reqwest::Url::parse(&format!("{origin}{}",endpoint_path(adapter))).map(|url|vec![url]).map_err(|_| "额度接口地址无效".into());
    }
    if matches!(adapter,"new_api"|"one_api"|"sub2api") {
        let mut root=base_url.clone();root.set_path("/api/usage/token/");
        let mut relative=base_url.clone();
        // The probe endpoint appends "/models"; the relative usage path keeps
        // the configured base path instead.
        let path=relative.path();
        let base_path=path.strip_suffix("/models").unwrap_or(path);
        relative.set_path(&format!("{}/usage",base_path.trim_end_matches('/')));
        if adapter=="sub2api" {
            let mut standard=base_url.clone();standard.set_path("/v1/usage");
            return Ok(if standard==relative{vec![relative]}else{vec![relative,standard]});
        }
        return Ok(vec![root,relative]);
    }
    let mut url=base_url;url.set_path(endpoint_path(adapter));
    Ok(vec![url])
}
fn quota_url(base:&str,adapter:&str)->Result<reqwest::Url,String> {
    quota_urls(base,adapter)?.into_iter().next().ok_or_else(|| "额度接口地址无效".into())
}

fn parse(adapter:&str,body:&Value)->Result<Vec<UsageWindow>,String> {
    let unknown=||"额度响应无法识别，当前额度未知".to_string();
    let mut windows=Vec::new();
    if body["success"]==false || body["code"]==false || body["isValid"]==false || body.get("error").is_some_and(|v|!v.is_null()) {return Err(unknown());}
    let p=payload(body);
    if p["success"]==false || p["isValid"]==false {return Err(unknown());}
    match adapter {
        "deepseek"=>{
            let available=body["is_available"].as_bool().ok_or_else(unknown)?;
            for row in body["balance_infos"].as_array().ok_or_else(unknown)?.iter().take(10) {
                let currency=row["currency"].as_str().filter(|v|matches!(*v,"CNY"|"USD")).ok_or_else(unknown)?;
                windows.push(UsageWindow{name:if available{"余额"}else{"余额（当前不可用）"},remaining:nonnegative(&row["total_balance"]).ok_or_else(unknown)?,total:None,unit:currency.into(),resets_at:None});
            }
        }
        "minimax"=>{
            let p=payload(body);
            if body.get("base_resp").or_else(||p.get("base_resp")).and_then(|v|v.get("status_code")).is_some_and(|v|number(v)!=Some(0.0)) {return Err(unknown());}
            let rows=p["model_remains"].as_array().ok_or_else(unknown)?;
            let row=rows.iter().find(|r|r["model_name"].as_str()==Some("general")).ok_or_else(unknown)?;
            for (name,remaining_percent,remaining_count,total_count,status,relative,absolute) in [
                ("当前周期","current_interval_remaining_percent","current_interval_usage_count","current_interval_total_count","current_interval_status","remains_time","end_time"),
                ("每周周期","current_weekly_remaining_percent","current_weekly_usage_count","current_weekly_total_count","current_weekly_status","weekly_remains_time","weekly_end_time")
            ] {
                if name=="每周周期"&&number(&row[status])!=Some(1.0){continue;}
                let total=nonnegative(&row[total_count]);
                let remaining=nonnegative(&row[remaining_count]);
                let resets_at=reset_after_ms(&row[relative]).or_else(||reset(&row[absolute]));
                if let Some(value)=row.get(remaining_percent).filter(|value|!value.is_null()) {
                    let remaining=number(value).filter(|value|(0.0..=100.0).contains(value)).ok_or_else(unknown)?;
                    windows.push(UsageWindow{name,remaining,total:None,unit:"% 剩余".into(),resets_at});
                } else if let (Some(remaining),Some(total))=(remaining,total.filter(|total|*total>0.0)) {
                    if remaining>total{return Err(unknown());}
                    windows.push(UsageWindow{name,remaining,total:Some(total),unit:"次剩余".into(),resets_at});
                }
            }
        }
        "zhipu"=>{
            let p=payload(body);
            if p["success"]==false||body.get("code").or_else(||p.get("code")).is_some_and(|v|v.as_i64()!=Some(200)) {return Err(unknown());}
            for row in p["limits"].as_array().ok_or_else(unknown)?.iter().filter(|v|v["type"].as_str().is_some_and(|kind|kind.eq_ignore_ascii_case("TOKENS_LIMIT")||kind.eq_ignore_ascii_case("CREDIT_LIMIT"))).take(10) {
                let period=match row["unit"].as_i64(){Some(3)=>"5 小时",Some(6)=>"每周",_=>"套餐"};
                let resets_at=reset(&row["nextResetTime"]);
                let used=number(&row["percentage"]).filter(|v|(0.0..=100.0).contains(v)).ok_or_else(unknown)?;
                windows.push(UsageWindow{name:period,remaining:100.0-used,total:Some(100.0),unit:"%".into(),resets_at});
            }
        }
        "sub2api"=>{
            let p=payload(body);
            let quota=&p["quota"];
            let (remaining,total)=if quota.is_object() {
                (number(&quota["remaining"]).ok_or_else(unknown)?,nonnegative(&quota["limit"]))
            } else {
                (number(&p["remaining"]).or_else(||number(&p["balance"])).ok_or_else(unknown)?,None)
            };
            if total.is_some_and(|total|total<remaining){return Err(unknown());}
            let unit=quota["unit"].as_str().or_else(||p["unit"].as_str()).filter(|v|matches!(*v,"USD"|"CNY")).unwrap_or("余额");
            windows.push(UsageWindow{name:if quota.is_object(){"密钥剩余额度"}else if p.get("subscription").is_some(){"订阅剩余额度"}else{"账户余额"},remaining,total,unit:unit.into(),resets_at:None});
        }
        "new_api"|"one_api"=>{
            // Only explicit display amounts are supported; raw quota units have
            // deployment-specific conversion factors and must not become currency.
            let p=payload(body);
            if let Some(row)=p.get("display") {
                let remaining=nonnegative(&row["remaining"]).ok_or_else(unknown)?;
                let unit=row["unit"].as_str().filter(|v|matches!(*v,"USD"|"CNY"|"tokens"|"TOKEN"|"TOKENS")).ok_or_else(unknown)?;
                let total=nonnegative(&row["total"]);
                if total.is_some_and(|total|total<remaining){return Err(unknown());}
                windows.push(UsageWindow{name:"额度余额",remaining,total,unit:unit.into(),resets_at:None});
            } else if p["user_quota"].is_object() {
                windows.push(UsageWindow{name:"账户剩余额度",remaining:number(&p["user_quota"]["total_available"]).ok_or_else(unknown)?,total:None,unit:"额度单位".into(),resets_at:None});
            } else if p["unlimited_quota"]==true {
                return Err("此令牌未设额度上限，接口未返回账户余额；请在站点令牌设置中开启“允许查询账户额度”（如支持）后重试".into());
            } else if p.get("total_available").is_some() {
                let remaining=number(&p["total_available"]).ok_or_else(unknown)?;
                let total=nonnegative(&p["total_granted"]);
                if total.is_some_and(|total|total<remaining){return Err(unknown());}
                windows.push(UsageWindow{name:"密钥剩余额度",remaining,total,unit:"额度单位".into(),resets_at:None});
            } else {
                // Deployments that report the account balance without an explicit
                // currency keep a neutral unit instead of claiming a currency.
                let remaining=nonnegative(&p["balance"]).ok_or_else(unknown)?;
                let total=nonnegative(&p["total"]);
                if total.is_some_and(|total|total<remaining){return Err(unknown());}
                let unit=p["unit"].as_str().or_else(||p["currency"].as_str())
                    .filter(|v|matches!(*v,"USD"|"CNY"|"EUR"|"JPY"|"tokens"|"TOKEN"|"TOKENS")).unwrap_or("余额");
                windows.push(UsageWindow{name:"账户余额",remaining,total,unit:unit.into(),resets_at:None});
            }
        }
        _=>return Err("此供应商暂不支持额度查询".into()),
    }
    if windows.is_empty(){return Err(unknown());}
    Ok(windows)
}

pub async fn query(base:&str,key:&str,requested:&str)->Result<Usage,String> {
    query_logged(base,key,requested).await.0
}

/// 查询额度，并返回每次上游请求的明文快照，供请求日志记录。
pub async fn query_logged(base:&str,key:&str,requested:&str)->(Result<Usage,String>,Vec<super::provider_logs::Exchange>) {
    let mut exchanges=Vec::new();
    let validated=match provider_probe::endpoint(base,"models") {Ok(value)=>value,Err(error)=>return (Err(error),exchanges)};
    let host=validated.host_str().unwrap_or("");
    let adapter=match (requested,host) {
        ("auto","api.deepseek.com")=>"deepseek",
        ("auto","api.minimaxi.com"|"www.minimaxi.com"|"api.minimax.io"|"www.minimax.io")=>"minimax",
        ("auto","open.bigmodel.cn"|"api.z.ai")=>"zhipu",
        ("new_api",_)=>"new_api",
        ("one_api",_)=>"one_api",
        ("sub2api",_)=>"sub2api",
        _=>return (Err("此供应商暂不支持额度查询".into()),exchanges),
    };
    let urls=match quota_urls(base,adapter) {Ok(value)=>value,Err(error)=>return (Err(error),exchanges)};
    let authorization=match authorization_value(adapter,key) {Ok(value)=>value,Err(error)=>return (Err(error),exchanges)};
    let client=match provider_probe::client() {Ok(value)=>value,Err(error)=>return (Err(error),exchanges)};
    let mut failure:Option<String>=None;
    let mut billing_total:Option<f64>=None;
    for url in urls {
        let start=std::time::Instant::now();
        let mut exchange=super::provider_logs::Exchange{method:"GET".into(),url:url.to_string(),..Default::default()};
        let response=match client.get(url.clone()).header(reqwest::header::AUTHORIZATION,authorization.clone()).send().await {
            Ok(value)=>value,
            Err(_)=>{
                exchange.error=Some("额度查询网络失败或超时".into());
                exchange.elapsed_ms=start.elapsed().as_millis() as u64;
                exchanges.push(exchange);
                failure=Some("额度查询网络失败或超时".into());
                continue;
            }
        };
        let success=response.status().is_success();
        let status=response.status().as_u16();
        exchange.status=Some(status);
        let text=match provider_probe::bounded_text(response).await {Ok(value)=>value,Err(_)=>String::new()};
        exchange.response_body=text.clone();
        exchange.elapsed_ms=start.elapsed().as_millis() as u64;
        exchanges.push(exchange);
        if !success{
            let error=http_failure(status);
            if let Some(exchange)=exchanges.last_mut(){exchange.error=Some(error.clone());}
            // New API only falls back when the endpoint is absent. Auth,
            // rate-limit and upstream errors must retain their actual cause.
            if adapter=="new_api" && !matches!(status,404|405){return (Err(error),exchanges);}
            failure=Some(error);continue;
        }
        let body=match serde_json::from_str::<Value>(&text) {Ok(value)=>value,Err(_)=>{
            let error="额度接口返回的内容不是有效 JSON，当前额度未知".to_string();
            if let Some(exchange)=exchanges.last_mut(){exchange.error=Some(error.clone());}
            if adapter=="new_api"{return (Err(error),exchanges);}
            failure=Some(error);continue;
        }};
        if adapter=="one_api" {
            if body.get("error").is_some() || body["success"]==false {failure=Some("额度响应无法识别，当前额度未知".into());continue;}
            if url.path().ends_with("/subscription") {
                billing_total=nonnegative(&body["hard_limit_usd"]).filter(|v|*v<100_000_000.0);
                failure=Some("计费接口未提供有限额度，当前额度未知".into());
                continue;
            }
            if let (Some(total),Some(used))=(billing_total,nonnegative(&body["total_usage"]).map(|v|v/100.0)) {
                return (Ok(Usage{adapter:adapter.into(),fetched_at:chrono::Utc::now().timestamp_millis(),windows:vec![UsageWindow{name:"剩余额度",remaining:total-used,total:Some(total),unit:"平台额度".into(),resets_at:None}]}),exchanges);
            }
            continue;
        }
        match parse(adapter,&body) {
            Ok(mut windows)=>{
                if adapter=="new_api"{new_api_display_settings(&client,base,&mut windows,&mut exchanges).await;}
                return (Ok(Usage{adapter:adapter.into(),fetched_at:chrono::Utc::now().timestamp_millis(),windows}),exchanges);
            },
            Err(error)=>{
                if let Some(exchange)=exchanges.last_mut(){exchange.error=Some(error.clone());}
                // A valid HTTP response with a semantic error must not be
                // overwritten by an unrelated fallback 404 or timeout.
                if adapter=="new_api"{return (Err(error),exchanges);}
                failure=Some(error);
            },
        }
    }
    (Err(failure.unwrap_or_else(|| "额度接口地址无效".into())),exchanges)
}

#[cfg(test)]
mod tests {
    use super::*;use serde_json::json;
    #[test]
    fn new_api_uses_site_conversion_and_preserves_unknown_units() {
        let raw=json!({"code":true,"data":{"total_available":500000000,"total_granted":1100000000}});
        for (settings,remaining,unit) in [
            (json!({"quota_per_unit":500000,"quota_display_type":"CUSTOM","custom_currency_symbol":"⚝","custom_currency_exchange_rate":1}),1000.0,"⚝"),
            (json!({"quota_per_unit":1000000,"quota_display_type":"USD"}),500.0,"USD"),
            (json!({"quota_per_unit":500000,"quota_display_type":"CNY","usd_exchange_rate":7.3}),7300.0,"CNY"),
            (json!({"quota_per_unit":500000,"quota_display_type":"TOKENS"}),500000000.0,"额度单位"),
            (json!({"quota_per_unit":0,"quota_display_type":"USD"}),500000000.0,"额度单位"),
            (json!({"quota_per_unit":500000,"quota_display_type":"CUSTOM"}),500000000.0,"额度单位"),
            (json!({}),500000000.0,"额度单位"),
        ] {
            let mut rows=parse("new_api",&raw).unwrap();
            convert_new_api_quota(&mut rows,&json!({"success":true,"data":settings}));
            assert_eq!(rows[0].remaining,remaining);assert_eq!(rows[0].unit,unit);
            assert!((rows[0].total.unwrap()-remaining*2.2).abs()<0.01);
        }
        let mut rows=parse("new_api",&json!({"display":{"remaining":12,"unit":"USD"}})).unwrap();
        convert_new_api_quota(&mut rows,&json!({"quota_per_unit":500000,"quota_display_type":"USD"}));
        assert_eq!(rows[0].remaining,12.0);
    }

    #[tokio::test]
    async fn new_api_fetches_public_conversion_without_credentials() {
        use tokio::{io::{AsyncReadExt,AsyncWriteExt},net::TcpListener};
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address=listener.local_addr().unwrap();
        let server=tokio::spawn(async move {
            for (path,body) in [
                ("/api/usage/token/",r#"{"code":true,"data":{"total_available":500000000,"total_granted":1100000000}}"#),
                ("/api/status",r#"{"success":true,"data":{"quota_per_unit":500000,"quota_display_type":"CUSTOM","custom_currency_symbol":"credits","custom_currency_exchange_rate":1}}"#),
            ] {
                let (mut stream,_)=listener.accept().await.unwrap();
                let mut request=Vec::new();let mut buffer=[0u8;2048];
                loop {let n=stream.read(&mut buffer).await.unwrap();assert_ne!(n,0);request.extend_from_slice(&buffer[..n]);if request.windows(4).any(|v|v==b"\r\n\r\n"){break;}}
                let request=String::from_utf8(request).unwrap();
                assert_eq!(request.lines().next().unwrap(),format!("GET {path} HTTP/1.1"));
                if path=="/api/status"{assert!(!request.to_ascii_lowercase().contains("authorization:"));}
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            }
        });
        let result=query(&format!("http://{address}/v1"),"fixture-key","new_api").await.unwrap();
        assert_eq!(result.windows[0].remaining,1000.0);assert_eq!(result.windows[0].total,Some(2200.0));assert_eq!(result.windows[0].unit,"credits");
        server.await.unwrap();
    }
    #[test]
    fn new_api_distinguishes_account_balance_from_unlimited_token_counters() {
        let body=json!({"code":true,"data":{"total_available":-1200,"total_granted":800,"total_used":2000,"unlimited_quota":true}});
        assert!(parse("new_api",&body).err().unwrap().contains("允许查询账户额度"));
        for unlimited in [false,true] {
            let body=json!({"code":true,"data":{"total_available":-1200,"unlimited_quota":unlimited,"user_quota":{"total_available":300}}});
            let rows=parse("new_api",&body).unwrap();
            assert_eq!(rows[0].name,"账户剩余额度");assert_eq!(rows[0].remaining,300.0);
        }
        assert!(parse("new_api",&json!({"data":{"user_quota":{"total_available":"NaN"}}})).is_err());
    }

    #[tokio::test]
    async fn new_api_keeps_semantic_and_http_errors_without_querying_fallback() {
        use tokio::{io::{AsyncReadExt,AsyncWriteExt},net::TcpListener};
        for (status,body,expected) in [
            (200,r#"{"code":true,"data":{"total_available":-1200,"unlimited_quota":true}}"#,"允许查询账户额度"),
            (200,r#"{"code":true,"data":{"unexpected":1}}"#,"额度响应无法识别"),
            (200,"<html>upstream page</html>","不是有效 JSON"),
            (401,r#"{"message":"untrusted fixture-key"}"#,"HTTP 401"),
            (403,r#"{"message":"untrusted fixture-key"}"#,"HTTP 403"),
            (429,r#"{}"#,"HTTP 429"),
            (500,r#"{}"#,"HTTP 500"),
        ] {
            let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address=listener.local_addr().unwrap();
            let server=tokio::spawn(async move {
                let (mut stream,_)=listener.accept().await.unwrap();
                let mut request=[0u8;2048];stream.read(&mut request).await.unwrap();
                stream.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            });
            let (result,exchanges)=query_logged(&format!("http://{address}/v1"),"fixture-key","new_api").await;
            let error=result.err().unwrap();
            assert!(error.contains(expected),"{error}");assert!(!error.contains("fixture-key"));
            assert_eq!(exchanges.len(),1);assert_eq!(exchanges[0].error.as_deref(),Some(error.as_str()));
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn new_api_still_uses_fallback_when_primary_endpoint_is_missing() {
        use tokio::{io::{AsyncReadExt,AsyncWriteExt},net::TcpListener};
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address=listener.local_addr().unwrap();
        let server=tokio::spawn(async move {
            for (path,status,body) in [("/api/usage/token/",404,r#"{}"#),("/v1/usage",200,r#"{"balance":12,"currency":"USD"}"#)] {
                let (mut stream,_)=listener.accept().await.unwrap();
                let mut request=Vec::new();let mut buffer=[0u8;2048];
                loop {let n=stream.read(&mut buffer).await.unwrap();assert_ne!(n,0);request.extend_from_slice(&buffer[..n]);if request.windows(4).any(|v|v==b"\r\n\r\n"){break;}}
                assert_eq!(String::from_utf8(request).unwrap().lines().next().unwrap(),format!("GET {path} HTTP/1.1"));
                stream.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            }
        });
        let result=query(&format!("http://{address}/v1"),"fixture-key","new_api").await.unwrap();
        assert_eq!(result.windows[0].remaining,12.0);server.await.unwrap();
    }
    #[test]
    fn relay_platform_quota_contracts() {
        let sub=parse("sub2api",&json!({"isValid":true,"remaining":12.5,"balance":12.5,"unit":"USD"})).unwrap();
        assert_eq!(sub[0].remaining,12.5);assert_eq!(sub[0].unit,"USD");
        let sub=parse("sub2api",&json!({"quota":{"remaining":3,"limit":10,"unit":"USD"},"remaining":3})).unwrap();
        assert_eq!(sub[0].total,Some(10.0));assert_eq!(sub[0].name,"密钥剩余额度");
        assert!(parse("sub2api",&json!({"isValid":false,"remaining":99})).is_err());
        assert!(parse("sub2api",&json!({"remaining":"NaN"})).is_err());
        let raw=parse("new_api",&json!({"code":true,"data":{"total_available":500000,"total_granted":1000000,"unlimited_quota":false}})).unwrap();
        assert_eq!(raw[0].remaining,500000.0);assert_eq!(raw[0].unit,"额度单位");
        assert!(parse("new_api",&json!({"code":false,"data":{"total_available":12}})).is_err());
        assert!(parse("new_api",&json!({"data":{"total_available":0,"unlimited_quota":true}})).is_err());
        let account=parse("new_api",&json!({"data":{"total_available":0,"unlimited_quota":true,"user_quota":{"total_available":12345}}})).unwrap();
        assert_eq!(account[0].remaining,12345.0);assert_eq!(account[0].name,"账户剩余额度");
        assert_eq!(quota_urls("https://example.com/v1","sub2api").unwrap()[0].path(),"/v1/usage");
        assert_eq!(quota_urls("https://example.com","sub2api").unwrap()[1].path(),"/v1/usage");
        assert_eq!(quota_urls("https://example.com/v1","one_api").unwrap()[0].path(),"/dashboard/billing/subscription");
    }

    #[tokio::test]
    async fn one_api_queries_both_billing_endpoints_before_reporting_remaining() {
        use tokio::{io::{AsyncReadExt,AsyncWriteExt},net::TcpListener};
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address=listener.local_addr().unwrap();
        let server=tokio::spawn(async move {
            for (path,body) in [("/dashboard/billing/subscription",r#"{"hard_limit_usd":30}"#),("/dashboard/billing/usage",r#"{"total_usage":1750}"#)] {
                let (mut stream,_)=listener.accept().await.unwrap();
                let mut request=Vec::new();let mut buffer=[0u8;2048];
                loop {
                    let count=stream.read(&mut buffer).await.unwrap();
                    assert_ne!(count,0);request.extend_from_slice(&buffer[..count]);
                    if request.windows(4).any(|part|part==b"\r\n\r\n"){break;}
                }
                let request=String::from_utf8(request).unwrap();
                assert_eq!(request.lines().next().unwrap(),format!("GET {path} HTTP/1.1"));
                assert!(request.to_ascii_lowercase().contains("authorization: bearer fixture-key\r\n"));
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            }
        });
        let result=query(&format!("http://{address}/v1"),"fixture-key","one_api").await.unwrap();
        assert_eq!(result.windows[0].remaining,12.5);assert_eq!(result.windows[0].unit,"平台额度");
        server.await.unwrap();
    }
    #[test]
    fn missing_fields_are_unknown_and_raw_quota_is_not_money() {
        assert!(parse("deepseek",&json!({"balance_infos":[]})).is_err());
        assert!(parse("new_api",&json!({"quota":1000000})).is_err());
        assert!(parse("new_api",&json!({"display":{"remaining":-1,"unit":"USD"}})).is_err());
        assert!(parse("new_api",&json!({"display":{"remaining":11,"total":10,"unit":"USD"}})).is_err());
        assert!(parse("deepseek",&json!({"is_available":true,"balance_infos":[]})).is_err());
        let deep=parse("deepseek",&json!({"is_available":false,"balance_infos":[{"currency":"CNY","total_balance":"12.3"}]})).unwrap();assert_eq!(deep[0].remaining,12.3);assert_eq!(deep[0].name,"余额（当前不可用）");
        let mini=parse("minimax",&json!({"base_resp":{"status_code":0},"model_remains":[{"model_name":"video","current_interval_total_count":0,"current_interval_status":3,"current_weekly_total_count":0,"current_weekly_status":3,"current_interval_remaining_percent":100,"current_weekly_remaining_percent":100},{"model_name":"general","current_interval_total_count":0,"current_interval_status":3,"current_interval_usage_count":0,"current_interval_remaining_percent":97,"current_weekly_total_count":0,"current_weekly_status":1,"current_weekly_usage_count":0,"current_weekly_remaining_percent":83,"remains_time":3600000,"weekly_remains_time":172800000}]})).unwrap();
        assert_eq!(mini.len(),2);assert_eq!(mini[0].remaining,97.0);assert_eq!(mini[0].unit,"% 剩余");assert_eq!(mini[1].remaining,83.0);
        assert!((mini[0].resets_at.unwrap()-chrono::Utc::now().timestamp()-3600).abs()<=1);
        assert!((mini[1].resets_at.unwrap()-chrono::Utc::now().timestamp()-172800).abs()<=1);
        let count_plan=parse("minimax",&json!({"model_remains":[{"model_name":"general","current_interval_total_count":100,"current_interval_usage_count":73,"current_weekly_status":1,"current_weekly_total_count":400,"current_weekly_usage_count":251}]})).unwrap();
        assert_eq!(count_plan[0].remaining,73.0);assert_eq!(count_plan[0].total,Some(100.0));assert_eq!(count_plan[0].unit,"次剩余");
        let no_weekly=parse("minimax",&json!({"model_remains":[{"model_name":"general","current_interval_remaining_percent":90,"current_weekly_status":3,"current_weekly_remaining_percent":100}]})).unwrap();
        assert_eq!(no_weekly.len(),1);assert_eq!(no_weekly[0].name,"当前周期");
        assert!(parse("minimax",&json!({"base_resp":{"status_code":1004},"model_remains":[{"model_name":"general","current_interval_remaining_percent":100}]})).is_err());
        assert!(parse("minimax",&json!({"base_resp":{"status_code":2062,"status_msg":"untrusted"},"model_remains":[{"model_name":"general","current_interval_remaining_percent":100}]})).is_err());
        let zhipu=parse("zhipu",&json!({"data":{"success":true,"limits":[{"type":"TOKENS_LIMIT","unit":3,"percentage":25}]}})).unwrap();assert_eq!(zhipu[0].remaining,75.0);assert_eq!(zhipu[0].name,"5 小时");
        let zhipu=parse("zhipu",&json!({"code":200,"data":{"limits":[{"type":"CREDIT_LIMIT","unit":6,"usage":140000,"currentValue":58386,"remaining":81613,"percentage":41,"nextResetTime":"1786692650981"}]}})).unwrap();assert_eq!(zhipu[0].remaining,59.0);assert_eq!(zhipu[0].total,Some(100.0));assert_eq!(zhipu[0].name,"每周");
        assert!(parse("zhipu",&json!({"data":{"success":false,"limits":[{"type":"TOKENS_LIMIT","percentage":0}]}})).is_err());
        assert!(parse("zhipu",&json!({"code":500,"data":{"limits":[{"type":"TOKENS_LIMIT","percentage":0}]}})).is_err());
        assert!(parse("zhipu",&json!({"data":{"limits":[{"type":"TOKENS_LIMIT","percentage":200}]}})).is_err());
    }

    #[test]
    fn minimax_percentages_reject_invalid_values_without_count_fallback() {
        for field in ["current_interval_remaining_percent","current_weekly_remaining_percent"] {
            for value in [json!(-1),json!(101),json!("NaN"),json!("Infinity"),json!(true)] {
                let mut row=json!({"model_name":"general","current_interval_remaining_percent":50,"current_interval_total_count":100,"current_interval_usage_count":50,"current_weekly_status":1,"current_weekly_total_count":100,"current_weekly_usage_count":50});
                row[field]=value;
                assert!(parse("minimax",&json!({"model_remains":[row]})).is_err());
            }
            for value in [json!(0),json!(100),json!("25.5")] {
                let mut row=json!({"model_name":"general","current_interval_remaining_percent":50,"current_weekly_status":1});
                row[field]=value.clone();
                let windows=parse("minimax",&json!({"model_remains":[row]})).unwrap();
                let index=if field=="current_interval_remaining_percent"{0}else{1};
                assert_eq!(windows[index].remaining,number(&value).unwrap());
            }
        }
        let windows=parse("minimax",&json!({"model_remains":[{"model_name":"general","current_interval_remaining_percent":null,"current_interval_total_count":100,"current_interval_usage_count":50}]})).unwrap();
        assert_eq!(windows[0].remaining,50.0);
        assert_eq!(windows[0].unit,"次剩余");
    }

    #[test]
    fn quota_authentication_matches_vendor_header_contracts() {
        assert!(quota_url("http://example.com/v1","new_api").is_ok());
        assert!(quota_url("http://127.0.0.1:3300/v1","new_api").is_ok());
        assert_eq!(authorization_value("zhipu","fixture-key").unwrap().to_str().unwrap(),"fixture-key");
        assert_eq!(authorization_value("deepseek","fixture-key").unwrap().to_str().unwrap(),"Bearer fixture-key");
        assert!(authorization_value("zhipu","fixture-key\nInjected: yes").is_err());
        assert_eq!(endpoint_path("minimax"),"/v1/token_plan/remains");
        assert_eq!(endpoint_path("zhipu"),"/api/monitor/usage/quota/limit");
        assert_eq!(quota_url("https://api.minimaxi.com/v1","minimax").unwrap().as_str(),"https://www.minimaxi.com/v1/token_plan/remains");
        assert_eq!(quota_url("https://api.minimax.io/v1","minimax").unwrap().as_str(),"https://www.minimax.io/v1/token_plan/remains");
        assert!(quota_url("https://custom.example/v1","minimax").is_err());
    }

    #[test]
    fn new_api_accepts_deployment_balance_without_claiming_a_currency() {
        let windows=parse("new_api",&json!({"balance":1825.73498247,"daily_usage":[]})).unwrap();
        assert_eq!(windows[0].remaining,1825.73498247);assert_eq!(windows[0].unit,"余额");assert_eq!(windows[0].name,"账户余额");
        let windows=parse("new_api",&json!({"balance":12,"total":20,"currency":"USD"})).unwrap();
        assert_eq!(windows[0].unit,"USD");assert_eq!(windows[0].total,Some(20.0));
        assert!(parse("new_api",&json!({"balance":-1})).is_err());
        assert!(parse("new_api",&json!({"balance":5,"total":1})).is_err());
        assert!(parse("new_api",&json!({"daily_usage":[]})).is_err());
    }

    #[test]
    fn new_api_tries_the_site_root_and_the_relative_usage_endpoint() {
        let urls=quota_urls("http://127.0.0.1:3300/v1","new_api").unwrap();
        assert_eq!(urls[0].as_str(),"http://127.0.0.1:3300/api/usage/token/");
        assert_eq!(urls[1].as_str(),"http://127.0.0.1:3300/v1/usage");
    }

    #[tokio::test]
    async fn local_new_api_quota_uses_the_explicit_display_endpoint() {
        use tokio::{io::{AsyncReadExt,AsyncWriteExt},net::TcpListener};
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address=listener.local_addr().unwrap();
        let server=tokio::spawn(async move {
            let (mut stream,_)=listener.accept().await.unwrap();
            let mut request=Vec::new();let mut buffer=[0u8;2048];
            loop {
                let count=stream.read(&mut buffer).await.unwrap();
                assert_ne!(count,0);request.extend_from_slice(&buffer[..count]);
                if request.windows(4).any(|part|part==b"\r\n\r\n"){break;}
            }
            let request=String::from_utf8(request).unwrap();
            assert_eq!(request.lines().next().unwrap(),"GET /api/usage/token/ HTTP/1.1");
            let request=request.to_ascii_lowercase();
            assert!(request.contains("authorization: bearer fixture-key\r\n"));
            let body=r#"{"display":{"remaining":12.5,"total":30,"unit":"USD"}}"#;
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        });
        let result=query(&format!("http://{address}/v1"),"fixture-key","new_api").await.unwrap();
        assert_eq!(result.windows[0].remaining,12.5);assert_eq!(result.windows[0].total,Some(30.0));
        server.await.unwrap();
    }
}
