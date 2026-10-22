//! Loopback-only, per-profile Responses bridge with independent client credentials.
use super::{gateway::{read_request, SseDecoder}, provider_aggregate::{self, Member, Selector, Strategy}, provider_logs, provider_probe, provider_protocol::{self, ChatStream}};
use serde_json::{json, Value};
use std::{sync::Arc, time::{Duration,Instant}};
use tokio::{io::{AsyncReadExt,AsyncWriteExt}, net::{TcpListener,TcpStream}, sync::Semaphore, task::{JoinHandle,JoinSet}};
use zeroize::Zeroizing;

pub struct ProviderGateway { task:JoinHandle<()>, pub port:u16 }
impl Drop for ProviderGateway {fn drop(&mut self){self.task.abort();}}
struct Upstream { base:String, credential:Zeroizing<String>, provider_id:Option<String> }
struct Route {host:String,upstreams:Vec<Upstream>,local:Zeroizing<String>,models:Vec<String>,selector:Selector,client:reqwest::Client}

/// 网关的单个上游成员。provider_id 用于把请求写入对应供应商的请求日志。
pub struct GatewayMember {pub key_id:String,pub provider_id:Option<String>,pub base:String,pub credential:Zeroizing<String>,pub models:Vec<String>,pub weight:u32}

async fn wait_for_client_disconnect(stream:&mut TcpStream) {
    let mut discarded=[0u8;1024];
    loop {
        match stream.read(&mut discarded).await {
            Ok(0)|Err(_)=>return,
            Ok(_)=>{}
        }
    }
}

async fn reply(stream:&mut TcpStream,status:u16,body:&Value)->Result<(),String> {
    let bytes=serde_json::to_vec(body).map_err(|_| "响应编码失败")?;
    stream.write_all(format!("HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",bytes.len()).as_bytes()).await.map_err(|_| "客户端已断开")?;
    stream.write_all(&bytes).await.map_err(|_| "客户端已断开".into())
}
async fn event(stream:&mut TcpStream,value:&Value)->Result<(),String> {
    stream.write_all(format!("event: {}\ndata: {}\n\n",value["type"].as_str().unwrap_or("error"),value).as_bytes()).await.map_err(|_| "客户端已断开".into())
}
async fn serve(stream:&mut TcpStream,route:&Route)->Result<(),String> {
    let request=match read_request(stream,&route.host,&route.local).await {
        Ok(v)=>v,Err(status)=>return reply(stream,status,&json!({"error":{"message":"本地供应商请求未通过校验","type":"invalid_request_error"}})).await,
    };
    if request.path=="/v1/models" {return reply(stream,200,&json!({"object":"list","data":route.models.iter().map(|id|json!({"id":id,"object":"model","owned_by":"provider"})).collect::<Vec<_>>()})).await;}
    if request.path!="/v1/responses" {return reply(stream,404,&json!({"error":{"message":"此端点仅支持 Responses 客户端"}})).await;}
    let (body,streaming)=match provider_protocol::request(&request.body,&route.models) {
        Ok(v)=>v,
        Err(error)=>{
            // Keep the client-facing response generic, but record the authored
            // validation reason and redacted request shape for local diagnosis.
            if let Some(upstream)=route.upstreams.first() {
                let upstream_url=provider_probe::endpoint(&upstream.base,"chat/completions").map(|url|url.to_string()).unwrap_or_else(|_|"[上游地址无效]".into());
                let exchange=provider_logs::Exchange {
                    method:"POST".into(),url:upstream_url,
                    client_request_body:String::from_utf8_lossy(request.body.as_slice()).into_owned(),
                    status:Some(400),
                    response_body:json!({"error":{"message":"请求包含不受支持的模型、内容或字段","type":"invalid_request_error"}}).to_string(),
                    error:Some(format!("未发送上游请求；本地校验失败：{error}")),..Default::default()
                };
                log_exchange(&upstream.provider_id,&upstream.credential,&exchange);
            }
            return reply(stream,400,&json!({"error":{"message":"请求包含不受支持的模型、内容或字段","type":"invalid_request_error"}})).await;
        },
    };
    let model=body["model"].as_str().ok_or("模型无效")?;
    let candidates=match route.selector.plan(model) {
        Ok(v)=>v,Err(_)=>return reply(stream,400,&json!({"error":{"message":"模型不在聚合成员目录中","type":"invalid_request_error"}})).await,
    };
    let mut response=None;
    let mut pending:Option<(Option<String>,Zeroizing<String>,provider_logs::Exchange)>=None;
    for (position,index) in candidates.iter().enumerate() {
        let upstream=&route.upstreams[*index];
        let url=provider_probe::endpoint(&upstream.base,"chat/completions")?;
        let started=Instant::now();
        let mut exchange=provider_logs::Exchange{method:"POST".into(),url:url.to_string(),request_body:body.to_string(),client_request_body:String::from_utf8_lossy(request.body.as_slice()).into_owned(),..Default::default()};
        let request=route.client.post(url).bearer_auth(upstream.credential.as_str()).json(&body).send();
        tokio::pin!(request);
        let result=tokio::select! {
            biased;
            _=wait_for_client_disconnect(stream)=>return Ok(()),
            result=&mut request=>result,
        };
        let current=match result {
            Ok(v)=>v,
            Err(_)=>{
                exchange.error=Some("供应商网络请求失败或超时".into());
                exchange.elapsed_ms=started.elapsed().as_millis() as u64;
                log_exchange(&upstream.provider_id,&upstream.credential,&exchange);
                return reply(stream,502,&json!({"error":{"message":"供应商网络请求失败或超时；未重放请求","type":"provider_error"}})).await;
            }
        };
        exchange.status=Some(current.status().as_u16());
        if provider_aggregate::safe_to_retry(current.status().as_u16(),false) && position+1<candidates.len() {
            exchange.response_body=provider_probe::bounded_text(current).await.unwrap_or_default();
            exchange.error=Some("上游限流，已切换到下一个成员".into());
            exchange.elapsed_ms=started.elapsed().as_millis() as u64;
            log_exchange(&upstream.provider_id,&upstream.credential,&exchange);
            route.selector.record_rate_limit(model,*index)?;
            continue;
        }
        if !current.status().is_success() {
            exchange.response_body=provider_probe::bounded_text(current).await.unwrap_or_default();
            exchange.error=Some("供应商拒绝请求".into());
            exchange.elapsed_ms=started.elapsed().as_millis() as u64;
            log_exchange(&upstream.provider_id,&upstream.credential,&exchange);
            let status=if exchange.status==Some(429) {429} else {502};
            let message=if status==429 {"聚合成员均明确返回限流，未重放其他错误"} else {"供应商拒绝请求；未重放请求"};
            return reply(stream,status,&json!({"error":{"message":message,"type":"provider_error"}})).await;
        }
        exchange.elapsed_ms=started.elapsed().as_millis() as u64;
        pending=Some((upstream.provider_id.clone(),upstream.credential.clone(),exchange));
        route.selector.record_success(model,*index)?;
        response=Some(current);
        break;
    }
    let mut response=response.ok_or("没有可用的聚合成员")?;
    let (provider_id,credential,mut exchange)=pending.ok_or("没有可用的聚合成员")?;
    if !streaming {
        let text=tokio::select! {
            biased;
            _=wait_for_client_disconnect(stream)=>return Ok(()),
            value=provider_probe::bounded_text(response)=>value,
        };
        let converted=match text {
            Ok(text)=>{
                exchange.response_body=text.clone();
                serde_json::from_str::<Value>(&text).ok().and_then(|value|ChatStream::from_completion(&value,model).ok())
            }
            Err(error)=>{
                exchange.error=Some(error.to_owned());
                None
            }
        };
        return match converted {
            Some(response)=>{log_exchange(&provider_id,&credential,&exchange);reply(stream,200,&response).await}
            None=>{
                exchange.error.get_or_insert_with(||"供应商响应无法转换为 Responses".into());
                log_exchange(&provider_id,&credential,&exchange);
                reply(stream,502,&json!({"error":{"message":"供应商响应无法转换为 Responses","type":"provider_error"}})).await
            }
        };
    }
    if response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v|v.to_str().ok()).is_none_or(|v|!v.starts_with("text/event-stream")) {
        exchange.error=Some("供应商没有返回流式响应".into());
        log_exchange(&provider_id,&credential,&exchange);
        return reply(stream,502,&json!({"error":{"message":"供应商没有返回流式响应"}})).await;
    }
    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n").await.map_err(|_| "客户端已断开")?;
    let mut decoder=SseDecoder::default();let mut adapter=ChatStream::new(model);
    for value in adapter.start(){event(stream,&value).await?;}
    let mut raw=String::new();
    let result=async {
        loop {
            let chunk=tokio::select! {
                biased;
                _=wait_for_client_disconnect(stream)=>return Ok::<_,String>(()),
                chunk=response.chunk()=>chunk.map_err(|_| "供应商流已中断")?,
            };
            let Some(chunk)=chunk else { break };
            if raw.len()<64*1024 {raw.push_str(&String::from_utf8_lossy(&chunk));}
            for value in decoder.feed(&chunk)? {
                for mapped in adapter.feed(&value)? {event(stream,&mapped).await?;}
            }
        }
        if !decoder.is_complete(){return Err("供应商流包含不完整事件".into());}
        for value in adapter.finish()? {event(stream,&value).await?;}
        Ok::<_,String>(())
    }.await;
    exchange.response_body=raw;
    if result.is_err(){
        exchange.error=Some("供应商流未正常完成".into());
        event(stream,&json!({"type":"response.failed","response":{"id":adapter.response("failed")["id"],"object":"response","status":"failed","error":{"code":"provider_stream_failed","message":"供应商流未正常完成；未重放请求"}}})).await?;
    }
    log_exchange(&provider_id,&credential,&exchange);
    Ok(())
}

/// 把上游请求写入对应供应商的请求日志。未关联供应商时不记录。
fn log_exchange(provider_id:&Option<String>,credential:&Zeroizing<String>,exchange:&provider_logs::Exchange) {
    let Some(provider_id)=provider_id.clone() else{return;};
    provider_logs::record_async(provider_id,"gateway",exchange.clone(),Some(credential.to_string()));
}

impl ProviderGateway {
    /// 启动单供应商网关。provider_id 关联到请求日志，未关联时不写入日志。
    pub async fn start(port:u16,provider_id:Option<String>,base:String,upstream:Zeroizing<String>,local:Zeroizing<String>,models:Vec<String>)->Result<Self,String> {
        Self::start_aggregate(port,vec![GatewayMember{key_id:uuid::Uuid::new_v4().to_string(),provider_id,base,credential:upstream,models,weight:1}],local,Strategy::Failover).await
    }

    pub async fn start_aggregate(port:u16,members:Vec<GatewayMember>,local:Zeroizing<String>,strategy:Strategy)->Result<Self,String> {
        if members.is_empty() || members.len()>50 || local.len()<24{return Err("供应商网关配置无效".into());}
        let mut models=Vec::new();
        let mut upstreams=Vec::new();
        let mut selectors=Vec::new();
        for member in members {
            let GatewayMember{key_id,provider_id,base,credential,models:catalog,weight}=member;
            provider_probe::endpoint(&base,"chat/completions")?;
            if catalog.is_empty() || catalog.len()>200 || catalog.iter().any(|v|!provider_probe::model_valid(v)){return Err("聚合供应商模型目录无效".into());}
            for model in &catalog {if !models.contains(model){models.push(model.clone());}}
            selectors.push(Member{key_id,models:catalog,weight});
            upstreams.push(Upstream{base,credential,provider_id});
        }
        if models.is_empty() || models.len()>200{return Err("聚合供应商模型数量无效".into());}
        let selector=Selector::new(strategy,selectors)?;
        let listener=TcpListener::bind((std::net::Ipv4Addr::LOCALHOST,port)).await.map_err(|_| "供应商网关端口被占用")?;
        let address=listener.local_addr().map_err(|_| "读取供应商网关端口失败")?;
        let route=Arc::new(Route{host:address.to_string(),upstreams,local,models,selector,client:reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(8)).timeout(Duration::from_secs(180)).build().map_err(|_| "创建供应商网关失败")?});
        let task=tokio::spawn(async move {
            let slots=Arc::new(Semaphore::new(4));let mut workers=JoinSet::new();
            loop {
                tokio::select! {
                    accepted=listener.accept()=>{
                        let Ok((mut socket,_))=accepted else{break;};
                        let Ok(permit)=slots.clone().try_acquire_owned() else{continue;};
                        let route=route.clone();
                        workers.spawn(async move {let _permit=permit;let _=tokio::time::timeout(Duration::from_secs(190),serve(&mut socket,&route)).await;});
                    }
                    _=workers.join_next(), if !workers.is_empty()=>{}
                }
            }
        });
        Ok(Self{task,port:address.port()})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use tokio::{io::{AsyncReadExt,AsyncWriteExt},net::TcpListener};

    async fn read_http_request(stream:&mut TcpStream)->Vec<u8> {
        let mut bytes=Vec::new();
        let mut block=[0u8;2048];
        loop {
            let count=stream.read(&mut block).await.unwrap();
            assert_ne!(count,0);
            bytes.extend_from_slice(&block[..count]);
            let Some(end)=bytes.windows(4).position(|value|value==b"\r\n\r\n").map(|value|value+4) else {continue};
            let headers=String::from_utf8_lossy(&bytes[..end]);
            let length=headers.lines().find_map(|line|line.to_ascii_lowercase().strip_prefix("content-length:").map(|v|v.trim().parse::<usize>().unwrap())).unwrap_or(0);
            if bytes.len()>=end+length {return bytes;}
        }
    }

    async fn mock_response(listener:TcpListener,status:u16,body:Value) {
        let (mut socket,_)=listener.accept().await.unwrap();
        let _=read_http_request(&mut socket).await;
        let body=body.to_string();
        socket.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
    }

    async fn mock_incomplete_stream(listener:TcpListener) {
        let (mut socket,_)=listener.accept().await.unwrap();
        let _=read_http_request(&mut socket).await;
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n").await.unwrap();
    }

    async fn aggregate_bridge(first:SocketAddr,second:SocketAddr,local:String)->ProviderGateway {
        ProviderGateway::start_aggregate(0,vec![
            GatewayMember{key_id:"key-a".into(),provider_id:None,base:format!("http://{first}/v1"),credential:Zeroizing::new("upstream-a".into()),models:vec!["model-a".into()],weight:1},
            GatewayMember{key_id:"key-b".into(),provider_id:None,base:format!("http://{second}/v1"),credential:Zeroizing::new("upstream-b".into()),models:vec!["model-a".into()],weight:1},
        ],Zeroizing::new(local),Strategy::Failover).await.unwrap()
    }

    #[tokio::test]
    async fn bridge_replaces_client_authorization_and_converts_completion() {
        let upstream=TcpListener::bind("127.0.0.1:0").await.unwrap();let address=upstream.local_addr().unwrap();
        let local=uuid::Uuid::new_v4().to_string();let upstream_key=uuid::Uuid::new_v4().to_string();
        let expected=upstream_key.clone();let forbidden=local.clone();
        let server=tokio::spawn(async move {
            let (mut socket,_)=upstream.accept().await.unwrap();let mut bytes=vec![0;16384];let count=socket.read(&mut bytes).await.unwrap();
            let request=String::from_utf8_lossy(&bytes[..count]);assert!(request.contains(&expected));assert!(!request.contains(&forbidden));assert!(request.starts_with("POST /v1/chat/completions"));
            let body=json!({"choices":[{"message":{"role":"assistant","content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}).to_string();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).as_bytes()).await.unwrap();
        });
        let bridge=ProviderGateway::start(0,None,format!("http://{address}/v1"),Zeroizing::new(upstream_key),Zeroizing::new(local.clone()),vec!["model-a".into()]).await.unwrap();
        let client=provider_probe::client().unwrap();let url=format!("http://127.0.0.1:{}/v1/responses",bridge.port);
        let denied=client.post(&url).bearer_auth("incorrect").json(&json!({"model":"model-a","input":"hello"})).send().await.unwrap();assert_eq!(denied.status(),401);
        let result:Value=client.post(&url).bearer_auth(local).json(&json!({"model":"model-a","input":"hello","stream":false,"store":false})).send().await.unwrap().json().await.unwrap();
        assert_eq!(result["status"],"completed");assert_eq!(result["output"][0]["content"][0]["text"],"OK");server.await.unwrap();
    }

    #[tokio::test]
    async fn bridge_accepts_codex_style_top_level_input_text() {
        // Codex 客户端首条消息是顶层 input_text 条目，中转必须能转换后发给上游。
        let upstream=TcpListener::bind("127.0.0.1:0").await.unwrap();let address=upstream.local_addr().unwrap();
        let server=tokio::spawn(async move {
            let (mut socket,_)=upstream.accept().await.unwrap();
            let mut bytes=vec![0;16384];let count=socket.read(&mut bytes).await.unwrap();
            let request=String::from_utf8_lossy(&bytes[..count]);
            assert!(request.contains("\"messages\""));
            assert!(!request.contains("input_text"));
            let body=json!({"choices":[{"message":{"role":"assistant","content":"OK"},"finish_reason":"stop"}]}).to_string();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).as_bytes()).await.unwrap();
        });
        let local=uuid::Uuid::new_v4().to_string();
        let bridge=ProviderGateway::start(0,None,format!("http://{address}/v1"),Zeroizing::new(uuid::Uuid::new_v4().to_string()),Zeroizing::new(local.clone()),vec!["model-a".into()]).await.unwrap();
        let client=provider_probe::client().unwrap();
        let result:Value=client.post(format!("http://127.0.0.1:{}/v1/responses",bridge.port)).bearer_auth(local)
            .json(&json!({"model":"model-a","input":[{"type":"input_text","text":"hello"}],"stream":false,"store":false})).send().await.unwrap().json().await.unwrap();
        assert_eq!(result["status"],"completed");assert_eq!(result["output"][0]["content"][0]["text"],"OK");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn completion_bridge_reports_malformed_tools_and_empty_truncation() {
        for (body,status,expected) in [
            (json!({"choices":[{"message":{"tool_calls":[17]},"finish_reason":"tool_calls"}]}),502,None),
            (json!({"choices":[{"message":{"content":null,"reasoning_content":"partial"},"finish_reason":"length"}]}),200,Some("incomplete")),
        ] {
            let upstream=TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address=upstream.local_addr().unwrap();
            let server=tokio::spawn(mock_response(upstream,200,body));
            let local=uuid::Uuid::new_v4().to_string();
            let bridge=ProviderGateway::start(0,None,format!("http://{address}/v1"),Zeroizing::new(uuid::Uuid::new_v4().to_string()),Zeroizing::new(local.clone()),vec!["model-a".into()]).await.unwrap();
            let response=provider_probe::client().unwrap().post(format!("http://127.0.0.1:{}/v1/responses",bridge.port)).bearer_auth(local)
                .json(&json!({"model":"model-a","input":"hello","stream":false,"store":false})).send().await.unwrap();
            assert_eq!(response.status().as_u16(),status);
            let response:Value=response.json().await.unwrap();
            if let Some(expected)=expected {
                assert_eq!(response["status"],expected);
                assert_eq!(response["incomplete_details"]["reason"],"max_output_tokens");
                assert_eq!(response["output"],json!([]));
            } else {
                assert_eq!(response["error"]["type"],"provider_error");
            }
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn streaming_bridge_preserves_fragmented_tools_and_reports_incomplete_streams() {
        let upstream=TcpListener::bind("127.0.0.1:0").await.unwrap();let address=upstream.local_addr().unwrap();
        let local=uuid::Uuid::new_v4().to_string();
        let server=tokio::spawn(async move {
            for complete in [true,false] {
                let (mut socket,_)=upstream.accept().await.unwrap();let mut bytes=vec![0;16384];socket.read(&mut bytes).await.unwrap();
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
                let chunks=if complete {vec![json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"read","arguments":"{"}}]}}]}),json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":2,"completion_tokens":3}})]} else {vec![json!({"choices":[{"delta":{"content":"partial"}}]})]};
                for chunk in chunks {
                    let event=format!("data: {chunk}\n\n");
                    for part in event.as_bytes().chunks(7){socket.write_all(part).await.unwrap();}
                }
            }
        });
        let bridge=ProviderGateway::start(0,None,format!("http://{address}/v1"),Zeroizing::new(uuid::Uuid::new_v4().to_string()),Zeroizing::new(local.clone()),vec!["model-a".into()]).await.unwrap();
        let url=format!("http://127.0.0.1:{}/v1/responses",bridge.port);
        let client=provider_probe::client().unwrap();
        let first=client.post(&url).bearer_auth(&local).json(&json!({"model":"model-a","input":"hello","stream":true,"store":false})).send().await.unwrap().text().await.unwrap();
        assert!(first.contains("response.function_call_arguments.delta"));assert!(first.contains("response.completed"));assert!(!first.contains("response.failed"));
        let second=client.post(&url).bearer_auth(&local).json(&json!({"model":"model-a","input":"hello","stream":true,"store":false})).send().await.unwrap().text().await.unwrap();
        assert!(second.contains("response.failed"));assert!(!second.contains("response.completed"));server.await.unwrap();
    }

    #[tokio::test]
    async fn aggregate_interleaved_models_preserve_round_robin_and_weighted_distribution() {
        for (strategy,expected,first_count) in [
            (Strategy::RoundRobin,vec!["a","b","a","b","a","b"],9),
            (Strategy::WeightedRoundRobin,vec!["a","a","b","a","a","b"],10),
        ] {
            let first=TcpListener::bind("127.0.0.1:0").await.unwrap();
            let first_address=first.local_addr().unwrap();
            let second=TcpListener::bind("127.0.0.1:0").await.unwrap();
            let second_address=second.local_addr().unwrap();
            let mut servers=Vec::new();
            for (listener,label,count) in [(first,"a",first_count),(second,"b",12-first_count)] {
                servers.push(tokio::spawn(async move {
                    for _ in 0..count {
                        let (mut socket,_)=tokio::time::timeout(Duration::from_secs(5),listener.accept()).await.unwrap().unwrap();
                        let request=read_http_request(&mut socket).await;
                        let end=request.windows(4).position(|part|part==b"\r\n\r\n").unwrap()+4;
                        let request:Value=serde_json::from_slice(&request[end..]).unwrap();
                        assert!(request["model"]=="shared"||(label=="a"&&request["model"]=="only-a"));
                        let body=json!({"choices":[{"message":{"role":"assistant","content":label},"finish_reason":"stop"}]}).to_string();
                        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
                    }
                }));
            }
            let local=uuid::Uuid::new_v4().to_string();
            let bridge=ProviderGateway::start_aggregate(0,vec![
                GatewayMember{key_id:"key-a".into(),provider_id:None,base:format!("http://{first_address}/v1"),credential:Zeroizing::new("upstream-a".into()),models:vec!["shared".into(),"only-a".into()],weight:2},
                GatewayMember{key_id:"key-b".into(),provider_id:None,base:format!("http://{second_address}/v1"),credential:Zeroizing::new("upstream-b".into()),models:vec!["shared".into()],weight:1},
            ],Zeroizing::new(local.clone()),strategy).await.unwrap();
            let client=provider_probe::client().unwrap();
            let mut selected=Vec::new();
            for _ in 0..6 {
                for model in ["shared","only-a"] {
                    let response=client.post(format!("http://127.0.0.1:{}/v1/responses",bridge.port)).bearer_auth(&local)
                        .json(&json!({"model":model,"input":"hello","store":false})).send().await.unwrap();
                    assert_eq!(response.status(),200);
                    let body:Value=response.json().await.unwrap();
                    let label=body["output"][0]["content"][0]["text"].as_str().unwrap();
                    if model=="shared" {selected.push(label.to_owned());} else {assert_eq!(label,"a");}
                }
            }
            assert_eq!(selected,expected);
            for server in servers {server.await.unwrap();}
        }
    }

    #[tokio::test]
    async fn aggregate_retries_explicit_429_but_not_server_errors() {
        let first=TcpListener::bind("127.0.0.1:0").await.unwrap();let first_address=first.local_addr().unwrap();
        let second=TcpListener::bind("127.0.0.1:0").await.unwrap();let second_address=second.local_addr().unwrap();
        let first_task=tokio::spawn(mock_response(first,429,json!({"error":{"message":"rate limited"}})));
        let body=json!({"choices":[{"message":{"role":"assistant","content":"OK"},"finish_reason":"stop"}]} );
        let second_task=tokio::spawn(mock_response(second,200,body));
        let local=uuid::Uuid::new_v4().to_string();
        let bridge=aggregate_bridge(first_address,second_address,local.clone()).await;
        let client=provider_probe::client().unwrap();
        let response=client.post(format!("http://127.0.0.1:{}/v1/responses",bridge.port)).bearer_auth(&local).json(&json!({"model":"model-a","input":"hello","store":false})).send().await.unwrap();
        assert_eq!(response.status(),200);
        assert_eq!(response.json::<Value>().await.unwrap()["status"],"completed");
        first_task.await.unwrap();second_task.await.unwrap();

        let first=TcpListener::bind("127.0.0.1:0").await.unwrap();let first_address=first.local_addr().unwrap();
        let second=TcpListener::bind("127.0.0.1:0").await.unwrap();let second_address=second.local_addr().unwrap();
        let first_task=tokio::spawn(mock_response(first,503,json!({"error":{"message":"unavailable"}})));
        let second_task=tokio::spawn(async move {tokio::time::timeout(Duration::from_millis(250),second.accept()).await.is_err()});
        let local=uuid::Uuid::new_v4().to_string();
        let bridge=aggregate_bridge(first_address,second_address,local.clone()).await;
        let response=client.post(format!("http://127.0.0.1:{}/v1/responses",bridge.port)).bearer_auth(&local).json(&json!({"model":"model-a","input":"hello","store":false})).send().await.unwrap();
        assert_eq!(response.status(),502);
        assert!(second_task.await.unwrap());
        first_task.await.unwrap();
    }

    #[tokio::test]
    async fn aggregate_does_not_failover_on_network_or_stream_failure() {
        let unavailable=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let unavailable_address=unavailable.local_addr().unwrap();
        drop(unavailable);
        let second=TcpListener::bind("127.0.0.1:0").await.unwrap();let second_address=second.local_addr().unwrap();
        let second_task=tokio::spawn(async move {tokio::time::timeout(Duration::from_millis(250),second.accept()).await.is_err()});
        let local=uuid::Uuid::new_v4().to_string();
        let bridge=aggregate_bridge(unavailable_address,second_address,local.clone()).await;
        let client=provider_probe::client().unwrap();
        let response=client.post(format!("http://127.0.0.1:{}/v1/responses",bridge.port)).bearer_auth(&local).json(&json!({"model":"model-a","input":"hello","store":false})).send().await.unwrap();
        assert_eq!(response.status(),502);
        assert!(second_task.await.unwrap());

        let first=TcpListener::bind("127.0.0.1:0").await.unwrap();let first_address=first.local_addr().unwrap();
        let second=TcpListener::bind("127.0.0.1:0").await.unwrap();let second_address=second.local_addr().unwrap();
        let first_task=tokio::spawn(mock_incomplete_stream(first));
        let second_task=tokio::spawn(async move {tokio::time::timeout(Duration::from_millis(250),second.accept()).await.is_err()});
        let local=uuid::Uuid::new_v4().to_string();
        let bridge=aggregate_bridge(first_address,second_address,local.clone()).await;
        let response=client.post(format!("http://127.0.0.1:{}/v1/responses",bridge.port)).bearer_auth(&local).json(&json!({"model":"model-a","input":"hello","stream":true,"store":false})).send().await.unwrap();
        let output=response.text().await.unwrap();
        assert!(output.contains("response.failed"));
        assert!(!output.contains("response.completed"));
        assert!(second_task.await.unwrap());
        first_task.await.unwrap();
    }

    #[tokio::test]
    async fn disconnect_cancels_pending_upstream_request() {
        let upstream=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_address=upstream.local_addr().unwrap();
        let (received_tx,received_rx)=tokio::sync::oneshot::channel();
        let server=tokio::spawn(async move {
            let (mut socket,_)=upstream.accept().await.unwrap();
            let _=read_http_request(&mut socket).await;
            let _=received_tx.send(());
            let mut byte=[0u8;1];
            tokio::time::timeout(Duration::from_secs(2),socket.read(&mut byte)).await.unwrap().unwrap()==0
        });
        let local=uuid::Uuid::new_v4().to_string();
        let bridge=ProviderGateway::start(0,None,format!("http://{upstream_address}/v1"),Zeroizing::new("upstream-key".into()),Zeroizing::new(local.clone()),vec!["model-a".into()]).await.unwrap();
        let mut client=TcpStream::connect(("127.0.0.1",bridge.port)).await.unwrap();
        let body=json!({"model":"model-a","input":"hello","store":false}).to_string();
        client.write_all(format!("POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {local}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",bridge.port,body.len()).as_bytes()).await.unwrap();
        received_rx.await.unwrap();
        drop(client);
        assert!(server.await.unwrap());
    }
}
