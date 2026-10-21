//! Explicit provider requests. Never return upstream text, headers or credentials.
use reqwest::{Client, Url};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

const LIMIT: usize = 2 * 1024 * 1024;
static REQUESTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub models: Vec<String>,
    pub generated: bool,
    pub elapsed_ms: u64,
    pub status: Option<u16>,
    pub error: Option<&'static str>,
}

pub fn model_valid(value: &str) -> bool {
    !value.is_empty() && value.len() <= 160
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._/:".contains(&b))
}

pub fn endpoint(base: &str, path: &str) -> Result<Url, String> {
    let mut url = Url::parse(base).map_err(|_| "供应商地址无效")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err("供应商地址无效".into());
    }
    if url.scheme() == "http" && !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")) {
        return Err("非本机供应商必须使用 HTTPS".into());
    }
    url.set_path(&format!("{}/{}", url.path().trim_end_matches('/'), path));
    Ok(url)
}

pub fn client() -> Result<Client, String> {
    Client::builder().redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8)).timeout(Duration::from_secs(30))
        .build().map_err(|_| "创建供应商请求失败".into())
}

pub async fn bounded_json(mut response: reqwest::Response) -> Result<Value, &'static str> {
    if response.content_length().is_some_and(|n| n > LIMIT as u64) { return Err("response_too_large"); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "network")? {
        if bytes.len() + chunk.len() > LIMIT { return Err("response_too_large"); }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "invalid_response")
}

fn parse_models(body: &Value, credential: &str) -> Result<Vec<String>, &'static str> {
    let rows = body.get("data").and_then(Value::as_array).ok_or("invalid_response")?;
    if rows.len() > 10000 { return Err("response_too_large"); }
    let mut result: Vec<String> = rows.iter().filter_map(|v| v.get("id").and_then(Value::as_str))
        .filter(|v| model_valid(v) && !v.contains(credential)).map(str::to_owned).collect();
    result.sort(); result.dedup(); result.truncate(200);
    Ok(result)
}

pub async fn run(base: &str, wire_api: &str, credential: &str, model: Option<&str>) -> Result<ProbeResult, String> {
    let _permit = REQUESTS.try_acquire().map_err(|_| "供应商请求繁忙，请稍后重试")?;
    let start = Instant::now();
    let client = client()?;
    let request = if let Some(model) = model {
        if !model_valid(model) { return Err("模型 ID 无效".into()); }
        match wire_api {
            "responses" => client.post(endpoint(base, "responses")?).json(&json!({"model":model,"input":"Reply OK.","stream":false,"store":false,"max_output_tokens":16})),
            "chat_completions" => client.post(endpoint(base, "chat/completions")?).json(&json!({"model":model,"messages":[{"role":"user","content":"Reply OK."}],"stream":false,"max_tokens":16})),
            _ => return Err("供应商协议无效".into()),
        }
    } else { client.get(endpoint(base, "models")?) };
    let mut result = ProbeResult { models: vec![], generated: false, elapsed_ms: 0, status: None, error: None };
    match request.bearer_auth(credential).send().await {
        Err(_) => result.error = Some("network"),
        Ok(response) => {
            result.status = Some(response.status().as_u16());
            if !response.status().is_success() { result.error = Some("http"); }
            else {
                match bounded_json(response).await {
                    Err(error) => result.error = Some(error),
                    Ok(body) if model.is_none() => match parse_models(&body, credential) { Ok(models) => result.models = models, Err(error) => result.error = Some(error) },
                    Ok(body) => {
                        let output_limited = if wire_api == "responses" {
                            body["status"] == "incomplete" && body["incomplete_details"]["reason"] == "max_output_tokens"
                        } else {
                            body["choices"].as_array().is_some_and(|rows| rows.iter().any(|row| row["finish_reason"] == "length"))
                        };
                        if output_limited {
                            result.error = Some("output_limit");
                            result.elapsed_ms = start.elapsed().as_millis() as u64;
                            return Ok(result);
                        }
                        result.generated = if wire_api == "responses" {
                            body["status"] == "completed" && body["output"].as_array().is_some_and(|items| items.iter().any(|item|
                                item["type"] == "message" && item["content"].as_array().is_some_and(|parts| parts.iter().any(|part|
                                    part["type"] == "output_text" && part["text"].as_str().is_some_and(|text| !text.trim().is_empty())))))
                        } else { body["choices"].as_array().is_some_and(|rows| rows.iter().any(|row| row["message"]["content"].as_str().is_some_and(|v| !v.trim().is_empty()) || row["message"]["tool_calls"].as_array().is_some_and(|calls| calls.iter().any(|call|call["function"]["name"].as_str().is_some_and(|name|!name.trim().is_empty()) && call["function"]["arguments"].as_str().is_some())))) };
                        if !result.generated { result.error = Some("invalid_response"); }
                    }
                }
            }
        }
    }
    result.elapsed_ms = start.elapsed().as_millis() as u64;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_endpoints_and_untrusted_catalogs() {
        assert!(endpoint("http://example.com/v1", "models").is_err());
        assert!(endpoint("https://user:pass@example.com/v1", "models").is_err());
        assert_eq!(endpoint("http://127.0.0.1:1234/v1/", "models").unwrap().path(), "/v1/models");
        let secret = uuid::Uuid::new_v4().to_string();
        let catalog = json!({"data":[{"id":"model-a"},{"id":"model-a"},{"id":"bad\nvalue"},{"id":secret}]});
        assert_eq!(parse_models(&catalog, &secret).unwrap(), vec!["model-a"]);
        assert!(parse_models(&json!({"error":{"message":"sensitive"}}), &secret).is_err());
    }

    #[tokio::test]
    async fn generation_probes_require_content_and_use_the_requested_protocol() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address=listener.local_addr().unwrap();
        let secret=uuid::Uuid::new_v4().to_string();
        let expected_secret=secret.clone();
        let server=tokio::spawn(async move {
            for (path,response) in [
                ("responses",json!({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"OK"}]}]})),
                ("responses",json!({"status":"completed","output":[{}]})),
                ("chat/completions",json!({"choices":[{"message":{"role":"assistant","content":"OK"}}]})),
                ("chat/completions",json!({"choices":[{"message":{"content":"  ","tool_calls":[{}]}}]})),
                ("responses",json!({"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[]})),
                ("chat/completions",json!({"choices":[{"finish_reason":"length","message":{"content":"<think>partial"}}]})),
            ] {
                let (mut socket,_)=listener.accept().await.unwrap();
                let mut bytes=Vec::new();
                let mut block=[0u8;2048];
                let end=loop {
                    let count=socket.read(&mut block).await.unwrap();
                    assert_ne!(count,0);
                    bytes.extend_from_slice(&block[..count]);
                    assert!(bytes.len()<16384);
                    if let Some(end)=bytes.windows(4).position(|v|v==b"\r\n\r\n").map(|v|v+4) {
                        let headers=String::from_utf8_lossy(&bytes[..end]);
                        let length=headers.lines().find_map(|line|line.to_ascii_lowercase().strip_prefix("content-length:").map(|value|value.trim().parse::<usize>().unwrap())).unwrap();
                        if bytes.len()>=end+length {break end;}
                    }
                };
                let headers=String::from_utf8_lossy(&bytes[..end]);
                assert!(headers.starts_with(&format!("POST /v1/{path} HTTP/1.1\r\n")));
                assert!(headers.lines().any(|line|line.eq_ignore_ascii_case(&format!("authorization: Bearer {expected_secret}"))));
                let request:Value=serde_json::from_slice(&bytes[end..]).unwrap();
                assert_eq!(request["model"],"model-a");
                assert_eq!(request["stream"],false);
                if path=="responses" {assert_eq!(request["store"],false);assert_eq!(request["max_output_tokens"],16);}
                else {assert_eq!(request["max_tokens"],16);}
                let response=response.to_string();
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).as_bytes()).await.unwrap();
            }
        });
        for (protocol,expected,error) in [("responses",true,None),("responses",false,Some("invalid_response")),("chat_completions",true,None),("chat_completions",false,Some("invalid_response")),("responses",false,Some("output_limit")),("chat_completions",false,Some("output_limit"))] {
            let result=run(&format!("http://{address}/v1"),protocol,&secret,Some("model-a")).await.unwrap();
            assert_eq!(result.status,Some(200));
            assert_eq!(result.generated,expected);
            assert_eq!(result.error,error);
            let summary=serde_json::to_string(&result).unwrap();
            assert!(!summary.contains(&secret));
            assert!(!summary.contains("OK"));
        }
        server.await.unwrap();
    }

    #[tokio::test]
    async fn local_probe_does_not_follow_redirect_or_return_error_body() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url=format!("http://{}/v1",listener.local_addr().unwrap());
        let secret=uuid::Uuid::new_v4().to_string();
        let server=tokio::spawn(async move {
            for response in ["HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/steal\r\nContent-Length: 0\r\n\r\n", "HTTP/1.1 401 Unauthorized\r\nContent-Length: 9\r\n\r\nsensitive"] {
                let (mut socket,_)=listener.accept().await.unwrap();
                let mut buffer=[0;4096]; socket.read(&mut buffer).await.unwrap();
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let redirect=run(&url,"responses",&secret,None).await.unwrap(); assert_eq!(redirect.status,Some(302));
        let error=run(&url,"responses",&secret,Some("model-a")).await.unwrap(); assert_eq!(error.status,Some(401));
        let serialized=serde_json::to_string(&error).unwrap(); assert!(!serialized.contains("sensitive")); assert!(!serialized.contains(&secret));
        server.await.unwrap();
    }
}
