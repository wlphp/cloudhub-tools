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
    if adapter=="minimax" {
        let origin=match base_url.host_str() {
            Some("api.minimaxi.com"|"www.minimaxi.com")=>"https://www.minimaxi.com",
            Some("api.minimax.io"|"www.minimax.io")=>"https://www.minimax.io",
            _=>return Err("MiniMax 额度查询仅支持官方地址".into()),
        };
        return reqwest::Url::parse(&format!("{origin}{}",endpoint_path(adapter))).map(|url|vec![url]).map_err(|_| "额度接口地址无效".into());
    }
    if adapter=="new_api" {
        let mut root=base_url.clone();root.set_path("/api/usage/token/");
        let mut relative=base_url.clone();
        // The probe endpoint appends "/models"; the relative usage path keeps
        // the configured base path instead.
        let path=relative.path();
        let base_path=path.strip_suffix("/models").unwrap_or(path);
        relative.set_path(&format!("{}/usage",base_path.trim_end_matches('/')));
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
        "new_api"=>{
            // Only explicit display amounts are supported; raw quota units have
            // deployment-specific conversion factors and must not become currency.
            let p=payload(body);
            if let Some(row)=p.get("display") {
                let remaining=nonnegative(&row["remaining"]).ok_or_else(unknown)?;
                let unit=row["unit"].as_str().filter(|v|matches!(*v,"USD"|"CNY"|"tokens"|"TOKEN"|"TOKENS")).ok_or_else(unknown)?;
                let total=nonnegative(&row["total"]);
                if total.is_some_and(|total|total<remaining){return Err(unknown());}
                windows.push(UsageWindow{name:"额度余额",remaining,total,unit:unit.into(),resets_at:None});
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
        _=>return (Err("此供应商暂不支持额度查询".into()),exchanges),
    };
    let urls=match quota_urls(base,adapter) {Ok(value)=>value,Err(error)=>return (Err(error),exchanges)};
    let authorization=match authorization_value(adapter,key) {Ok(value)=>value,Err(error)=>return (Err(error),exchanges)};
    let client=match provider_probe::client() {Ok(value)=>value,Err(error)=>return (Err(error),exchanges)};
    let mut failure:Option<String>=None;
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
        exchange.status=Some(response.status().as_u16());
        let text=match provider_probe::bounded_text(response).await {Ok(value)=>value,Err(_)=>String::new()};
        exchange.response_body=text.clone();
        exchange.elapsed_ms=start.elapsed().as_millis() as u64;
        exchanges.push(exchange);
        if !success{failure=Some("额度接口拒绝请求，请检查密钥与适配类型".into());continue;}
        let body=match serde_json::from_str::<Value>(&text) {Ok(value)=>value,Err(_)=>{failure=Some("额度响应无法识别，当前额度未知".into());continue;}};
        match parse(adapter,&body) {
            Ok(windows)=>return (Ok(Usage{adapter:adapter.into(),fetched_at:chrono::Utc::now().timestamp_millis(),windows}),exchanges),
            Err(error)=>failure=Some(error),
        }
    }
    (Err(failure.unwrap_or_else(|| "额度接口地址无效".into())),exchanges)
}

#[cfg(test)]
mod tests {
    use super::*;use serde_json::json;
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
