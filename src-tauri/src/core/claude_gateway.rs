//! Claude-only local routing. No prompts, headers, bodies or credentials enter logs.
use super::{claude_providers::{self as model, ApiFormat, ClaudeProvider}, claude_protocol as protocol,
    crypto::{encrypt_secret,decrypt_secret}, database::open_db, repositories::claude_providers as repo};
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use rusqlite::{params,OptionalExtension};
use std::{collections::{HashMap,VecDeque},sync::{Arc,Mutex,OnceLock},time::{Duration,Instant}};
use tokio::{io::{AsyncReadExt,AsyncWriteExt},net::{TcpListener,TcpStream},sync::Semaphore,task::{JoinHandle,JoinSet}};
use zeroize::Zeroizing;

const CONFIG_KEY:&str="claude.workbench.routing";
const RECOVERY_KEY:&str="claude.workbench.recovery";
const LOG_KEY:&str="claude.workbench.requests";
const MAX_BODY:usize=16*1024*1024;
static RUNTIME:OnceLock<tokio::sync::Mutex<Option<Running>>>=OnceLock::new();
pub static CONFIG_WRITER:Mutex<()>=Mutex::new(());
fn runtime()->&'static tokio::sync::Mutex<Option<Running>>{RUNTIME.get_or_init(||tokio::sync::Mutex::new(None))}

#[derive(Clone,Copy,Default,Serialize,Deserialize,PartialEq,Eq)]
#[serde(rename_all="snake_case")]
pub enum Mode{#[default] Direct,Route,Aggregate}
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",default,deny_unknown_fields)]
pub struct Config{
    pub port:u16,pub route_provider:String,pub default_provider:String,pub members:Vec<String>,
    pub failover:bool,pub queue:Vec<String>,pub retries:usize,pub timeout_secs:u64,
    pub first_byte_secs:u64,pub idle_secs:u64,pub failure_threshold:u32,pub cooldown_secs:u64,pub logging:bool,
}
impl Default for Config{
    fn default()->Self{Self{port:15721,route_provider:String::new(),default_provider:String::new(),members:Vec::new(),failover:false,queue:Vec::new(),retries:2,timeout_secs:600,first_byte_secs:90,idle_secs:180,failure_threshold:8,cooldown_secs:90,logging:true}}
}
impl Config{
    pub fn validate(&self)->Result<(),String>{
        if self.port<1024||self.retries>10||!(10..=1200).contains(&self.timeout_secs)||!(1..=120).contains(&self.first_byte_secs)
            ||self.idle_secs>600||!(1..=20).contains(&self.failure_threshold)||self.cooldown_secs>300||self.members.len()>100||self.queue.len()>100 {
            return Err("路由端口、超时、重试或熔断参数无效".into());
        }
        for ids in [&self.members,&self.queue]{
            let unique:std::collections::HashSet<_>=ids.iter().collect();
            if unique.len()!=ids.len()||ids.iter().any(|id|id.len()>128||id.is_empty()){return Err("供应商名单包含重复或无效标识".into());}
        }
        Ok(())
    }
}
fn preference(key:&str)->Result<Option<String>,String>{
    open_db()?.query_row("SELECT value FROM client_preferences WHERE key=?1",[key],|r|r.get(0)).optional().map_err(|_|"读取 Claude 工作台设置失败".into())
}
fn save_preference(key:&str,value:&str)->Result<(),String>{
    open_db()?.execute("INSERT INTO client_preferences(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
        params![key,value,chrono::Utc::now().timestamp_millis()]).map_err(|_|"保存 Claude 工作台设置失败".to_string())?;Ok(())
}
pub fn config()->Result<Config,String>{
    preference(CONFIG_KEY)?.map(|s|serde_json::from_str(&s).map_err(|_|"路由配置损坏".into())).unwrap_or_else(||Ok(Config::default()))
}
#[derive(Clone,Default,Serialize)]
#[serde(rename_all="camelCase")]
pub struct Health{pub failures:u32,pub open_until:Option<i64>}
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Log{
    #[serde(default)]
    pub mode:Option<Mode>,
    pub id:String,pub timestamp:i64,pub provider_id:String,pub model:String,pub actual_model:String,
    pub status:u16,pub duration_ms:u64,pub input_tokens:u64,pub output_tokens:u64,pub cache_read_tokens:u64,
}
struct Shared{config:Config,mode:Mode,providers:Vec<ClaudeProvider>,health:HashMap<String,Health>,logs:VecDeque<Log>,active_provider:String,auth:Zeroizing<String>,persist_logs:bool}
fn saved_logs()->Result<VecDeque<Log>,String>{
    preference(LOG_KEY)?.map(|raw|serde_json::from_str(&raw).map_err(|_|"请求记录损坏".into())).unwrap_or_else(||Ok(VecDeque::new()))
}
struct Running{shared:Arc<Mutex<Shared>>,task:JoinHandle<()>,port:u16}
impl Drop for Running{fn drop(&mut self){self.task.abort();}}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Snapshot{pub mode:Mode,pub running:bool,pub address:Option<String>,pub config:Config,pub health:HashMap<String,Health>,pub logs:Vec<Log>,pub active_provider:String,pub recovery_available:bool}
pub async fn snapshot()->Result<Snapshot,String>{
    let guard=runtime().lock().await;
    if let Some(r)=guard.as_ref(){
        let s=r.shared.lock().map_err(|_|"路由状态不可用")?;
        return Ok(Snapshot{mode:s.mode,running:!r.task.is_finished(),address:Some(format!("http://127.0.0.1:{}",r.port)),config:s.config.clone(),health:s.health.clone(),logs:s.logs.iter().rev().cloned().collect(),active_provider:s.active_provider.clone(),recovery_available:preference(RECOVERY_KEY)?.is_some()});
    }
    Ok(Snapshot{mode:Mode::Direct,running:false,address:None,config:config()?,health:HashMap::new(),logs:saved_logs()?.into_iter().rev().collect(),active_provider:String::new(),recovery_available:preference(RECOVERY_KEY)?.is_some()})
}
pub async fn save_config(next:Config)->Result<(),String>{
    next.validate()?;
    let guard=runtime().lock().await;
    if let Some(r)=guard.as_ref(){
        if next.port!=r.port{return Err("请先回到直连，再修改监听端口".into());}
        let providers=repo::list_providers(&open_db()?)?;
        let mode=r.shared.lock().map_err(|_|"路由状态不可用")?.mode;
        validate_selection(mode,&next,&providers)?;
        let _writer=CONFIG_WRITER.lock().map_err(|_|"配置正在使用")?;
        let auth=r.shared.lock().map_err(|_|"路由状态不可用")?.auth.clone();
        let previous=config()?;
        save_preference(CONFIG_KEY,&serde_json::to_string(&next).map_err(|_|"路由配置无效")?)?;
        if let Err(error)=update_proxy(&next,mode,&providers,r.port,&auth){
            save_preference(CONFIG_KEY,&serde_json::to_string(&previous).map_err(|_|"路由配置无效")?)?;
            return Err(error);
        }
        let mut s=r.shared.lock().map_err(|_|"路由状态不可用")?;
        s.config=next.clone();s.providers=providers;
        return Ok(());
    }
    save_preference(CONFIG_KEY,&serde_json::to_string(&next).map_err(|_|"路由配置无效")?)
}
fn find<'a>(providers:&'a[ClaudeProvider],id:&str)->Result<&'a ClaudeProvider,String>{
    providers.iter().find(|p|p.id==id).ok_or_else(||"请选择已保存的供应商".into())
}
fn validate_selection(mode:Mode,c:&Config,providers:&[ClaudeProvider])->Result<(),String>{
    c.validate()?;
    let ids:Vec<&str>=match mode{
        Mode::Route=>{let mut ids=vec![c.route_provider.as_str()];if c.failover{ids.extend(c.queue.iter().map(String::as_str));}ids},
        Mode::Aggregate=>{let mut ids=vec![c.default_provider.as_str()];ids.extend(c.members.iter().map(String::as_str));ids},
        Mode::Direct=>Vec::new(),
    };
    for id in ids{let p=find(providers,id)?;if p.official_login||p.api_key.is_empty(){return Err("路由与聚合需要已填写密钥的供应商，官方订阅请使用直连".into());}validate_url(&p.base_url)?;}
    if mode==Mode::Aggregate&&models(find(providers,&c.default_provider)?).is_empty(){return Err("聚合默认供应商至少需要一个已配置的模型".into());}
    Ok(())
}
pub fn validate_url(value:&str)->Result<reqwest::Url,String>{
    let url=reqwest::Url::parse(value).map_err(|_|"供应商请求地址无效")?;
    if !matches!(url.scheme(),"http"|"https")||url.host_str().is_none()||!url.username().is_empty()||url.password().is_some()||url.fragment().is_some()||url.query().is_some(){
        return Err("请求地址必须为不含凭据、查询参数及片段的 HTTP(S) 地址".into());
    }
    Ok(url)
}
pub fn models(p:&ClaudeProvider)->Vec<model::ModelMapping>{
    if !p.model_catalog.is_empty(){return p.model_catalog.clone();}
    let mut result=Vec::new();
    for role in model::MODEL_ROLES{
        if let Some(m)=p.models.get(role).and_then(|v|serde_json::from_value::<model::ModelMapping>(v.clone()).ok()){
            if !m.model.is_empty()&&!result.iter().any(|x:&model::ModelMapping|x.model==m.model){result.push(m);}
        }
    }result
}
pub fn aggregate_id(p:&str,m:&str)->String{format!("ccs-claude-{}--{}",hex::encode(p.as_bytes()),m)}
fn catalog(c:&Config,providers:&[ClaudeProvider])->Vec<Value>{
    let mut result=Vec::new();
    for p in providers.iter().filter(|p|p.id==c.default_provider||c.members.contains(&p.id)){
        for m in models(p){
            let id=format!("{}{}",if p.id==c.default_provider{m.model.clone()}else{aggregate_id(&p.id,&m.model)},if m.supports_1m{"[1M]"}else{""});
            result.push(json!({"id":id,"display_name":if m.display_name.is_empty(){format!("{} · {}",p.name,m.model)}else{format!("{} · {}",p.name,m.display_name)},"type":"model","created_at":"2026-01-01T00:00:00Z"}));
        }
    }result
}
fn project_proxy(live:&Value,c:&Config,mode:Mode,providers:&[ClaudeProvider],port:u16,auth:&str)->Result<Value,String>{
    let target=find(providers,if mode==Mode::Aggregate{&c.default_provider}else{&c.route_provider})?;
    let mut shell=target.clone();shell.api_key=auth.into();shell.base_url=format!("http://127.0.0.1:{port}");
    shell.models.clear();shell.extra_env.retain(|k,_|model::EXCLUSIVE_ENV.contains(&k.as_str()));
    for role in ["sonnet","opus","haiku","fable"]{
        let mapping=target.models.get(role).cloned().unwrap_or(json!({}));
        let real=mapping["model"].as_str().unwrap_or(role);
        shell.models.insert(role.into(),json!({"model":if mode==Mode::Aggregate{models(target).first().map(|m|m.model.clone()).unwrap_or(real.into())}else{format!("claude-{role}-5")},"displayName":mapping["displayName"].as_str().unwrap_or(real),"supports1m":if mode==Mode::Aggregate{models(target).first().is_some_and(|m|m.supports_1m)}else{mapping["supports1m"]==true}}));
    }
    let mut doc=model::apply_provider(live,&shell).document;
    if mode==Mode::Aggregate{
        let entries=catalog(c,providers);
        if entries.is_empty(){return Err("聚合模式至少需要一个已配置的模型".into());}
        doc["modelPicker"]=json!({"replaceBuiltInOptions":true,"options":entries.iter().map(|m|json!({"model":m["id"],"label":m["display_name"],"description":m["id"]})).collect::<Vec<_>>()});
    }
    Ok(doc)
}
fn update_proxy(c:&Config,mode:Mode,providers:&[ClaudeProvider],port:u16,auth:&str)->Result<(),String>{
    let previous=preference(RECOVERY_KEY)?.ok_or("缺少接管恢复记录，配置未改写")?;
    let mut recovery:Value=serde_json::from_str(&decrypt_secret(&previous)?).map_err(|_|"接管备份损坏，配置未改写")?;
    let mut live=repo::read_settings()?;
    if let Some(written)=recovery["writtenExclusive"].as_object(){
        for (key,value) in written{
            if live["env"].get(key)==Some(value){
                if let Some(old)=recovery["document"]["env"].get(key){live["env"][key]=old.clone();}
                else if let Some(env)=live["env"].as_object_mut(){env.remove(key);}
            }
        }
    }
    let doc=project_proxy(&live,c,mode,providers,port,auth)?;
    recovery["writtenExclusive"]=Value::Object(doc["env"].as_object().into_iter().flatten().filter(|(k,_)|model::EXCLUSIVE_ENV.contains(&k.as_str())).map(|(k,v)|(k.clone(),v.clone())).collect());
    save_preference(RECOVERY_KEY,&encrypt_secret(&recovery.to_string())?)?;
    if let Err(error)=repo::write_settings(&doc){save_preference(RECOVERY_KEY,&previous)?;return Err(error);}
    Ok(())
}
fn restore_locked()->Result<(),String>{
    let Some(encrypted)=preference(RECOVERY_KEY)? else{return Ok(());};
    let original:Value=serde_json::from_str(&decrypt_secret(&encrypted)?).map_err(|_|"接管备份损坏，配置未改写")?;
    let path=original["path"].as_str().map(std::path::PathBuf::from).map(Ok).unwrap_or_else(repo::settings_path)?;
    if !path.is_absolute(){return Err("接管备份路径无效".into());}
    let mut live=repo::read_settings_at(&path)?;
    restore_document(&mut live,&original)?;
    if original["existed"]==false&&live.as_object().is_some_and(|m|m.is_empty()){
        if path.exists(){std::fs::remove_file(&path).map_err(|_|"恢复原始配置文件状态失败")?;}
    }else{repo::write_settings_at(&path,&live)?;}
    open_db()?.execute("DELETE FROM client_preferences WHERE key=?1",[RECOVERY_KEY]).map_err(|_|"清理恢复记录失败")?;
    Ok(())
}
fn restore_document(live:&mut Value,original:&Value)->Result<(),String>{
    let root=live.as_object_mut().ok_or("当前配置不是对象，无法恢复")?;
    root.retain(|k,_|!model::is_floor_top(k));
    if let Some(old)=original["document"].as_object(){
        for (k,v) in old.iter().filter(|(k,_)|model::is_floor_top(k)){root.insert(k.clone(),v.clone());}
    }
    let env=root.entry("env").or_insert(json!({})).as_object_mut().ok_or("当前 env 不是对象，无法恢复")?;
    env.retain(|k,_|!model::is_floor_env(k));
    if let Some(old)=original["document"]["env"].as_object(){
        for (k,v) in old.iter().filter(|(k,_)|model::is_floor_env(k)){env.insert(k.clone(),v.clone());}
    }
    // Only remove compatibility values that still equal those written by the gateway.
    if let Some(written)=original["writtenExclusive"].as_object(){
        for (k,v) in written{if env.get(k)==Some(v){if let Some(old)=original["document"]["env"].get(k){env.insert(k.clone(),old.clone());}else{env.remove(k);}}}
    }
    if env.is_empty()&&original["document"].get("env").is_none(){root.remove("env");}
    Ok(())
}
pub fn recover()->Result<(),String>{
    let _writer=CONFIG_WRITER.lock().map_err(|_|"配置正在使用")?;restore_locked()
}
pub fn shutdown(){
    if let Ok(mut guard)=runtime().try_lock(){if recover().is_ok(){guard.take();}}
}
pub async fn activate(mode:Mode)->Result<(),String>{
    let mut guard=runtime().lock().await;
    if mode==Mode::Direct{
        recover()?;guard.take();return Ok(());
    }
    let c=config()?;let providers=repo::list_providers(&open_db()?)?;validate_selection(mode,&c,&providers)?;
    if let Some(r)=guard.as_ref(){
        let _writer=CONFIG_WRITER.lock().map_err(|_|"配置正在使用")?;
        let auth=r.shared.lock().map_err(|_|"路由状态不可用")?.auth.clone();
        update_proxy(&c,mode,&providers,r.port,&auth)?;
        let mut s=r.shared.lock().map_err(|_|"路由状态不可用")?;
        s.config=c;s.mode=mode;s.providers=providers;return Ok(());
    }
    // Bind before changing any client file. On failure the direct setup remains usable.
    let listener=TcpListener::bind((std::net::Ipv4Addr::LOCALHOST,c.port)).await.map_err(|_|"路由端口被占用，请修改端口后重试")?;
    let auth=Zeroizing::new(format!("cloudhub-local-{}",uuid::Uuid::new_v4()));
    let shared=Arc::new(Mutex::new(Shared{config:c.clone(),mode,providers:providers.clone(),health:HashMap::new(),logs:saved_logs()?,active_provider:String::new(),auth:auth.clone(),persist_logs:true}));
    {
        let _writer=CONFIG_WRITER.lock().map_err(|_|"配置正在使用")?;
        restore_locked()?;
        let live=repo::read_settings()?;
        let doc=project_proxy(&live,&c,mode,&providers,c.port,&auth)?;
        let exclusive:serde_json::Map<String,Value>=doc["env"].as_object().into_iter().flatten().filter(|(k,_)|model::EXCLUSIVE_ENV.contains(&k.as_str())).map(|(k,v)|(k.clone(),v.clone())).collect();
        let path=repo::settings_path()?;
        let recovery=json!({"document":live,"writtenExclusive":exclusive,"path":path.to_string_lossy(),"existed":path.exists()});
        save_preference(RECOVERY_KEY,&encrypt_secret(&recovery.to_string())?)?;
        if let Err(e)=repo::write_settings(&doc){let _=restore_locked();return Err(e);}
    }
    let state=shared.clone();
    let task=tokio::spawn(async move{
        let slots=Arc::new(Semaphore::new(16));let mut workers=JoinSet::new();
        loop{tokio::select!{
            accept=listener.accept()=>{
                let Ok((mut socket,peer))=accept else{break;};
                if !peer.ip().is_loopback(){continue;}
                let Ok(permit)=slots.clone().try_acquire_owned()else{continue;};
                let s=state.clone();
                workers.spawn(async move{let _permit=permit;let _=tokio::time::timeout(Duration::from_secs(1210),serve(&mut socket,s)).await;});
            }
            _=workers.join_next(),if !workers.is_empty()=>{}
        }}
    });
    *guard=Some(Running{shared,task,port:c.port});Ok(())
}
pub async fn clear_logs()->Result<(),String>{
    save_preference(LOG_KEY,"[]")?;
    if let Some(r)=runtime().lock().await.as_ref(){r.shared.lock().map_err(|_|"路由状态不可用")?.logs.clear();}
    Ok(())
}
pub async fn refresh_providers()->Result<(),String>{
    if let Some(r)=runtime().lock().await.as_ref(){
        let providers=repo::list_providers(&open_db()?)?;
        let mut s=r.shared.lock().map_err(|_|"路由状态不可用")?;
        validate_selection(s.mode,&s.config,&providers)?;
        let _writer=CONFIG_WRITER.lock().map_err(|_|"配置正在使用")?;
        update_proxy(&s.config,s.mode,&providers,r.port,&s.auth)?;
        s.providers=providers;
    }Ok(())
}
pub async fn change_project(path:Option<std::path::PathBuf>)->Result<(),String>{
    let guard=runtime().lock().await;
    if guard.is_some(){return Err("请先回到直连再切换项目".into());}
    let _writer=CONFIG_WRITER.lock().map_err(|_|"配置正在使用")?;
    restore_locked()?;
    super::claude_workspace::set_project(path)
}
pub async fn change_config_directory(path:Option<std::path::PathBuf>)->Result<(),String>{
    let guard=runtime().lock().await;
    if guard.is_some(){return Err("请先回到直连再切换配置目录".into());}
    let _writer=CONFIG_WRITER.lock().map_err(|_|"配置正在使用")?;
    restore_locked()?;
    super::claude_workspace::set_config_directory(path)
}
pub async fn in_use(id:&str)->bool{
    runtime().lock().await.as_ref().is_some_and(|r|r.shared.lock().is_ok_and(|s|s.config.route_provider==id||s.config.default_provider==id||s.config.members.iter().any(|p|p==id)||s.config.queue.iter().any(|p|p==id)))
}
struct Request{path:String,body:Zeroizing<Vec<u8>>,beta:Option<String>}
async fn read_request(s:&mut TcpStream,token:&str)->Result<Request,u16>{
    let mut bytes=Zeroizing::new(Vec::new());
    let end=loop{
        if let Some(i)=bytes.windows(4).position(|b|b==b"\r\n\r\n"){break i+4;}
        if bytes.len()>16384{return Err(431);}
        let mut buf=[0u8;4096];let n=tokio::time::timeout(Duration::from_secs(10),s.read(&mut buf)).await.map_err(|_|408u16)?.map_err(|_|400u16)?;
        if n==0{return Err(400);}bytes.extend_from_slice(&buf[..n]);
    };
    if end>16384{return Err(431);}
    let header=std::str::from_utf8(&bytes[..end]).map_err(|_|400u16)?;
    let mut lines=header.split("\r\n");let start:Vec<_>=lines.next().unwrap_or("").split(' ').collect();
    if start.len()!=3||start[2]!="HTTP/1.1"{return Err(400);}
    let path=start[1].split('?').next().unwrap_or("");
    let listing=start[0]=="GET"&&path=="/v1/models";
    if !listing&&!(start[0]=="POST"&&matches!(path,"/v1/messages"|"/v1/messages/count_tokens")){return Err(404);}
    let mut headers=HashMap::new();
    for line in lines.filter(|s|!s.is_empty()){
        let(k,v)=line.split_once(':').ok_or(400u16)?;
        if k.is_empty()||!k.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-')||headers.insert(k.to_ascii_lowercase(),v.trim()).is_some(){return Err(400);}
    }
    let host=s.local_addr().map_err(|_|400u16)?.to_string();
    if headers.get("host").copied()!=Some(host.as_str())||headers.contains_key("origin")||headers.contains_key("transfer-encoding"){return Err(403);}
    let auth=headers.get("authorization").and_then(|s|s.strip_prefix("Bearer ")).or_else(||headers.get("x-api-key").copied());
    if auth!=Some(token){return Err(401);}
    let length=headers.get("content-length").map(|s|s.parse::<usize>()).transpose().map_err(|_|400u16)?.unwrap_or(0);
    if length>MAX_BODY||bytes.len()-end>length{return Err(413);}
    if !listing&&(length==0||headers.get("content-type").is_none_or(|s|s.split(';').next()!=Some("application/json"))){return Err(415);}
    let beta=headers.get("anthropic-beta").filter(|s|s.len()<2048).map(|s|s.to_string());
    let path=path.to_string();
    let mut body=Zeroizing::new(bytes[end..].to_vec());let n=body.len();body.resize(length,0);
    tokio::time::timeout(Duration::from_secs(30),s.read_exact(&mut body[n..])).await.map_err(|_|408u16)?.map_err(|_|400u16)?;
    Ok(Request{path,body,beta})
}
async fn reply(s:&mut TcpStream,status:u16,body:&Value)->std::io::Result<()>{
    let bytes=body.to_string();s.write_all(format!("HTTP/1.1 {status} Result\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{bytes}",bytes.len()).as_bytes()).await
}
fn error(message:&str)->Value{json!({"type":"error","error":{"type":"api_error","message":message}})}
fn resolve<'a>(s:&'a Shared,model:&str)->Result<Vec<&'a ClaudeProvider>,String>{
    if s.mode==Mode::Aggregate{
        if let Some(tail)=model.strip_prefix("ccs-claude-"){
            let (id,_)=tail.split_once("--").ok_or("聚合模型标识无效")?;
            let id=String::from_utf8(hex::decode(id).map_err(|_|"聚合供应商标识无效")?).map_err(|_|"聚合供应商标识无效")?;
            if id!=s.config.default_provider&&!s.config.members.contains(&id){return Err("供应商不在聚合名单".into());}
            let p=find(&s.providers,&id)?;
            if !models(p).iter().any(|m|aggregate_id(&p.id,&m.model)==model.trim_end_matches("[1M]").trim_end_matches("[1m]")){return Err("模型不在发布目录".into());}
            return Ok(vec![p]);
        }
        return Ok(vec![find(&s.providers,&s.config.default_provider)?]);
    }
    let mut ids=vec![s.config.route_provider.as_str()];
    if s.config.failover&&!s.config.queue.is_empty(){ids=s.config.queue.iter().map(String::as_str).collect();}
    let now=chrono::Utc::now().timestamp_millis();
    Ok(ids.into_iter().filter(|id|!s.health.get(*id).is_some_and(|h|h.open_until.is_some_and(|t|t>now))).filter_map(|id|find(&s.providers,id).ok()).collect())
}
pub fn mapped_model(p:&ClaudeProvider,requested:&str)->String{
    if let Some((_,m))=requested.strip_prefix("ccs-claude-").and_then(|s|s.split_once("--")){return m.trim_end_matches("[1M]").trim_end_matches("[1m]").into();}
    let role=model::MODEL_ROLES.into_iter().find(|role|requested==*role||requested.starts_with(&format!("claude-{role}-")));
    role.and_then(|r|p.models.get(r)).and_then(|m|m["model"].as_str()).filter(|m|!m.is_empty()).unwrap_or(requested).trim_end_matches("[1M]").into()
}
pub fn endpoint(p:&ClaudeProvider,model:&str,stream:bool,count:bool)->Result<reqwest::Url,String>{
    let mut url=validate_url(&p.base_url)?;
    let path=url.path().trim_end_matches('/').to_string();
    let suffix=match p.api_format{ApiFormat::Anthropic=>if count{"messages/count_tokens"}else{"messages"},ApiFormat::OpenaiChat=>"chat/completions",ApiFormat::OpenaiResponses=>"responses",ApiFormat::Gemini=>""};
    let next=if p.api_format==ApiFormat::Gemini{
        if model.chars().any(|c|!(c.is_ascii_alphanumeric()||"._-/".contains(c))) {return Err("Gemini 模型标识无效".into());}
        let base=path.split("/models/").next().unwrap_or(&path);
        let base=if base.ends_with("/v1beta")||base.ends_with("/v1"){base.to_string()}else{format!("{base}/v1beta")};
        format!("{base}/models/{model}:{}",if stream{"streamGenerateContent"}else{"generateContent"})
    }else{
        let known=["/messages/count_tokens","/messages","/chat/completions","/responses"];
        if let Some(tail)=known.iter().find(|tail|path.ends_with(**tail)){format!("{}/{suffix}",path.trim_end_matches(tail))}
        else if path.ends_with("/v1"){format!("{path}/{suffix}")}
        else{format!("{path}/v1/{suffix}")}
    };
    url.set_path(&next);
    if p.api_format==ApiFormat::Gemini&&stream{url.set_query(Some("alt=sse"));}
    Ok(url)
}
async fn serve(socket:&mut TcpStream,state:Arc<Mutex<Shared>>)->std::io::Result<()>{
    let auth={state.lock().unwrap_or_else(|e|e.into_inner()).auth.clone()};
    let request=match read_request(socket,&auth).await{Ok(r)=>r,Err(status)=>return reply(socket,status,&error("本地路由请求无效或未授权")).await};
    if request.path=="/v1/models"{
        let entries={let s=state.lock().unwrap_or_else(|e|e.into_inner());catalog(&s.config,&s.providers)};
        return reply(socket,200,&json!({"data":entries,"has_more":false,"first_id":entries.first().map(|v|&v["id"]),"last_id":entries.last().map(|v|&v["id"])})).await;
    }
    let source:Value=match serde_json::from_slice(&request.body){Ok(v)=>v,Err(_)=>return reply(socket,400,&error("请求 JSON 无效")).await};
    let (c,mode,providers)={
        let s=state.lock().unwrap_or_else(|e|e.into_inner());
        let requested=source["model"].as_str().unwrap_or("");
        let providers=resolve(&s,requested).unwrap_or_default().into_iter().cloned().collect::<Vec<_>>();
        (s.config.clone(),s.mode,providers)
    };
    let requested=source["model"].as_str().unwrap_or("");
    if requested.is_empty()||requested.len()>512||requested.chars().any(char::is_control){return reply(socket,400,&error("模型标识无效")).await;}
    let streaming=source["stream"].as_bool().unwrap_or(false);
    let count=request.path.ends_with("/count_tokens");
    let client=match reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(c.timeout_secs)).build(){
        Ok(v)=>v,Err(_)=>return reply(socket,500,&error("初始化上游连接失败")).await};
    let mut final_status=503;
    for p in providers.iter().take(if mode==Mode::Route&&c.failover{c.retries+1}else{1}){
        let start=Instant::now();let actual=mapped_model(p,requested);
        let mut body=source.clone();body["model"]=json!(actual);
        if count&&p.api_format!=ApiFormat::Anthropic{return reply(socket,501,&error("该上游不提供精确 token 计数")).await;}
        let payload=match protocol::request(&body,p.api_format){Ok(v)=>v,Err(e)=>return reply(socket,400,&error(&e)).await};
        let url=match endpoint(p,&actual,streaming,count){Ok(v)=>v,Err(e)=>return reply(socket,400,&error(&e)).await};
        let mut req=client.post(url).json(&payload);
        if p.api_format==ApiFormat::Anthropic{
            req=req.header("anthropic-version","2023-06-01");
            req=if p.api_key_field==model::ApiKeyField::ApiKey{req.header("x-api-key",&p.api_key)}else{req.bearer_auth(&p.api_key)};
            if let Some(beta)=request.beta.as_ref(){req=req.header("anthropic-beta",beta);}
        }else if p.api_format==ApiFormat::Gemini{req=req.header("x-goog-api-key",&p.api_key);}else{req=req.bearer_auth(&p.api_key);}
        let result=tokio::time::timeout(Duration::from_secs(c.first_byte_secs),req.send()).await;
        let mut log=Log{mode:Some(mode),id:uuid::Uuid::new_v4().to_string(),timestamp:chrono::Utc::now().timestamp_millis(),provider_id:p.id.clone(),model:requested.into(),actual_model:actual.clone(),status:502,duration_ms:0,input_tokens:0,output_tokens:0,cache_read_tokens:0};
        let response=match result{
            Ok(Ok(r)) if r.status().is_success()=>r,
            other=>{
                let status=match other{Ok(Ok(r))=>r.status().as_u16(),Err(_)=>504,_=>502};
                final_status=status;log.status=status;log.duration_ms=start.elapsed().as_millis() as u64;record(&state,log,true);
                if !matches!(status,401|403|408|429|500..=599){break;}continue;
            }
        };
        let mut headers_sent=false;
        let outcome=forward(socket,response,p.api_format,requested,streaming,c.idle_secs,&mut headers_sent).await;
        log.duration_ms=start.elapsed().as_millis() as u64;
        match outcome{
            Ok(tokens)=>{log.status=200;log.input_tokens=tokens["input_tokens"].as_u64().unwrap_or(0);log.output_tokens=tokens["output_tokens"].as_u64().unwrap_or(0);log.cache_read_tokens=tokens["cache_read_input_tokens"].as_u64().unwrap_or(0);record(&state,log,false);return Ok(());}
            Err(_)=>{
                log.status=502;record(&state,log,true);
                if !headers_sent{return reply(socket,502,&error("上游响应无效或读取失败，请检查协议格式")).await;}
                if streaming{let _=socket.write_all(&protocol::sse(&error("上游事件流中断，请重试"))).await;}
                return Ok(());
            }
        }
    }
    reply(socket,if final_status==429{429}else{502},&error("供应商请求失败或全部处于熔断状态，请检查密钥、模型和健康状态")).await
}
fn record(state:&Arc<Mutex<Shared>>,log:Log,failed:bool){
    if let Ok(mut s)=state.lock(){
        let threshold=s.config.failure_threshold;let cooldown=s.config.cooldown_secs;
        let h=s.health.entry(log.provider_id.clone()).or_default();
        if failed{h.failures=h.failures.saturating_add(1);if h.failures>=threshold{h.open_until=Some(chrono::Utc::now().timestamp_millis()+cooldown as i64*1000);}}
        else{h.failures=0;h.open_until=None;s.active_provider=log.provider_id.clone();}
        if s.config.logging{
            s.logs.push_back(log);while s.logs.len()>500{s.logs.pop_front();}
            if s.persist_logs{if let Ok(raw)=serde_json::to_string(&s.logs){let _=save_preference(LOG_KEY,&raw);}}
        }
    }
}
async fn forward(socket:&mut TcpStream,mut response:reqwest::Response,format:ApiFormat,model:&str,stream:bool,idle:u64,headers_sent:&mut bool)->Result<Value,String>{
    if !stream{
        let mut bytes=Zeroizing::new(Vec::new());
        while let Some(chunk)=response.chunk().await.map_err(|_|"上游响应读取失败")?{if bytes.len()+chunk.len()>32*1024*1024{return Err("上游响应过大".into());}bytes.extend_from_slice(&chunk);}
        let value:Value=serde_json::from_slice(&bytes).map_err(|_|"上游响应不是有效 JSON")?;
        let converted=protocol::response(&value,format,model)?;
        let usage=converted["usage"].clone();*headers_sent=true;reply(socket,200,&converted).await.map_err(|_|"客户端已断开")?;return Ok(usage);
    }
    if !response.headers().get("content-type").and_then(|v|v.to_str().ok()).is_some_and(|v|v.contains("text/event-stream")){return Err("上游未返回事件流".into());}
    *headers_sent=true;
    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n").await.map_err(|_|"客户端已断开")?;
    let mut buffer=Zeroizing::new(Vec::new());let mut adapter=protocol::Stream::new(model);let mut tokens=json!({});
    let mut complete=false;
    'read: loop{
        let chunk=tokio::time::timeout(Duration::from_secs(if idle==0{1200}else{idle}),response.chunk()).await.map_err(|_|"上游流静默超时")?.map_err(|_|"上游流中断")?;
        let Some(chunk)=chunk else{break;};
        buffer.extend_from_slice(&chunk);if buffer.len()>2*1024*1024{return Err("上游事件过大".into());}
        while let Some(end)=match (buffer.windows(2).position(|v|v==b"\n\n").map(|i|i+2),buffer.windows(4).position(|v|v==b"\r\n\r\n").map(|i|i+4)){
            (Some(a),Some(b))=>Some(a.min(b)),(a,b)=>a.or(b),
        }{
            let frame=buffer.drain(..end).collect::<Vec<_>>();
            let text=std::str::from_utf8(&frame).map_err(|_|"上游事件编码无效")?;
            let data=text.lines().filter_map(|l|l.strip_prefix("data:").map(str::trim_start)).collect::<Vec<_>>().join("\n");
            if data=="[DONE]"{complete=true;break 'read;}
            if data.is_empty(){continue;}
            let v:Value=serde_json::from_str(&data).map_err(|_|"上游事件 JSON 无效")?;
            if format==ApiFormat::Anthropic{
                if v["type"]=="error"{return Err("上游流返回错误".into());}
                if v["type"]=="message_stop"{complete=true;}
                let u=if v["type"]=="message_start"{&v["message"]["usage"]}else{&v["usage"]};
                for k in ["input_tokens","output_tokens","cache_read_input_tokens"]{if let Some(n)=u.get(k){tokens[k]=n.clone();}}
                socket.write_all(&protocol::sse(&v)).await.map_err(|_|"客户端已断开")?;
            }else{
                if v["type"]=="response.completed"||v["type"]=="response.incomplete"||v["choices"][0]["finish_reason"].is_string()||v["candidates"][0]["finishReason"].is_string(){complete=true;}
                for event in adapter.feed(&v,format)?{socket.write_all(&protocol::sse(&event)).await.map_err(|_|"客户端已断开")?;}
            }
            if v["type"]=="message_stop"||v["type"]=="response.completed"||v["type"]=="response.incomplete"||v["candidates"][0]["finishReason"].is_string(){break 'read;}
        }
    }
    if !complete{
        return Err("上游流未完成".into());
    }
    if format!=ApiFormat::Anthropic{
        for event in adapter.finish(){socket.write_all(&protocol::sse(&event)).await.map_err(|_|"客户端已断开")?;}
        tokens=adapter.tokens;
    }
    Ok(tokens)
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn request_log_mode_preserves_history_and_legacy_unknown(){
        let old=json!({"id":"example","timestamp":1,"providerId":"p","model":"m","actualModel":"m","status":200,"durationMs":1,"inputTokens":1,"outputTokens":1,"cacheReadTokens":0});
        let mut log:Log=serde_json::from_value(old).unwrap();
        assert!(log.mode.is_none());
        for mode in [Mode::Route,Mode::Aggregate]{
            log.mode=Some(mode);
            let saved=serde_json::to_string(&log).unwrap();
            let restored:Log=serde_json::from_str(&saved).unwrap();
            assert!(restored.mode==Some(mode));
        }
    }
    fn provider()->ClaudeProvider{serde_json::from_value(json!({"id":"p","name":"Example","baseUrl":"https://example.test/v1","apiKey":"fixture","models":{"sonnet":{"model":"real-model"}}})).unwrap()}
    #[test]
    fn endpoint_does_not_duplicate_v1_or_messages(){
        let mut p=provider();assert_eq!(endpoint(&p,"m",false,false).unwrap().as_str(),"https://example.test/v1/messages");
        p.base_url="https://example.test/anthropic".into();assert_eq!(endpoint(&p,"m",false,false).unwrap().path(),"/anthropic/v1/messages");
        p.base_url="https://example.test/v1/messages".into();assert_eq!(endpoint(&p,"m",false,true).unwrap().path(),"/v1/messages/count_tokens");
        assert!(validate_url("https://name:secret@example.test").is_err());
    }
    #[test]
    fn aggregate_ids_cannot_select_an_unpublished_model(){
        let p=provider();let c=Config{default_provider:"p".into(),..Config::default()};
        let s=Shared{config:c,mode:Mode::Aggregate,providers:vec![p.clone()],health:HashMap::new(),logs:VecDeque::new(),active_provider:String::new(),auth:Zeroizing::new("fixture".into()),persist_logs:false};
        assert_eq!(resolve(&s,&aggregate_id("p","real-model")).unwrap()[0].id,"p");
        assert!(resolve(&s,&aggregate_id("p","missing")).is_err());
        assert_eq!(mapped_model(&p,"claude-sonnet-5"),"real-model");
    }
    #[test]
    fn aggregate_catalog_keeps_default_plain_and_members_prefixed(){
        let p=provider();let mut member=provider();member.id="other".into();
        let c=Config{default_provider:"p".into(),members:vec!["other".into()],failover:true,queue:vec!["other".into()],..Config::default()};
        let entries=catalog(&c,&[p.clone(),member.clone()]);
        assert_eq!(entries.len(),2);assert_eq!(entries[0]["id"],"real-model");
        assert_eq!(entries[1]["id"],aggregate_id("other","real-model"));
        let s=Shared{config:c,mode:Mode::Aggregate,providers:vec![p,member],health:HashMap::new(),logs:VecDeque::new(),active_provider:String::new(),auth:Zeroizing::new("fixture".into()),persist_logs:false};
        assert_eq!(resolve(&s,"real-model").unwrap()[0].id,"p");
        assert_eq!(resolve(&s,&aggregate_id("other","real-model")).unwrap()[0].id,"other");
        assert_eq!(resolve(&s,"real-model").unwrap().len(),1);
    }
    #[tokio::test]
    async fn browser_requests_are_rejected(){
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let addr=listener.local_addr().unwrap();
        let caller=tokio::spawn(async move{let mut s=TcpStream::connect(addr).await.unwrap();s.write_all(format!("GET /v1/models HTTP/1.1\r\nHost: {addr}\r\nOrigin: https://example.test\r\nAuthorization: Bearer PROXY_MANAGED\r\n\r\n").as_bytes()).await.unwrap();});
        let(mut socket,_)=listener.accept().await.unwrap();assert_eq!(read_request(&mut socket,"fixture").await.err(),Some(403));caller.await.unwrap();
    }

    async fn upstream(status:u16,content_type:&str,body:String)->(String,JoinHandle<Value>){
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr=listener.local_addr().unwrap();
        let content_type=content_type.to_string();
        let task=tokio::spawn(async move{
            let (mut socket,_)=listener.accept().await.unwrap();
            let mut data=Vec::new();
            let end=loop{
                let mut chunk=[0;4096];let n=socket.read(&mut chunk).await.unwrap();assert!(n>0);
                data.extend_from_slice(&chunk[..n]);
                if let Some(i)=data.windows(4).position(|b|b==b"\r\n\r\n"){break i+4;}
            };
            let header=std::str::from_utf8(&data[..end]).unwrap();
            let len=header.lines().find_map(|l|l.to_ascii_lowercase().strip_prefix("content-length:").map(|v|v.trim().parse::<usize>().unwrap())).unwrap();
            while data.len()<end+len{let mut chunk=[0;4096];let n=socket.read(&mut chunk).await.unwrap();assert!(n>0);data.extend_from_slice(&chunk[..n]);}
            let request:Value=serde_json::from_slice(&data[end..end+len]).unwrap();
            socket.write_all(format!("HTTP/1.1 {status} Result\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            request
        });
        (format!("http://{addr}/v1"),task)
    }
    fn state(providers:Vec<ClaudeProvider>,mode:Mode,config:Config)->Arc<Mutex<Shared>>{
        Arc::new(Mutex::new(Shared{config,mode,providers,health:HashMap::new(),logs:VecDeque::new(),active_provider:String::new(),auth:Zeroizing::new("fixture".into()),persist_logs:false}))
    }
    async fn call(state:Arc<Mutex<Shared>>,body:Value,token:&str)->(u16,String){
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr=listener.local_addr().unwrap();
        let task=tokio::spawn(async move{
            let (mut socket,_)=listener.accept().await.unwrap();
            serve(&mut socket,state).await.unwrap();
        });
        let result=reqwest::Client::new().post(format!("http://{addr}/v1/messages")).bearer_auth(token).json(&body).send().await.unwrap();
        let status=result.status().as_u16();let text=result.text().await.unwrap();task.await.unwrap();(status,text)
    }
    #[tokio::test]
    async fn live_route_failover_maps_models_and_records_metadata_only(){
        let (bad,first)=upstream(503,"application/json","{}".into()).await;
        let (good,second)=upstream(200,"application/json",json!({"id":"msg_fixture","type":"message","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":3,"output_tokens":1}}).to_string()).await;
        let mut p=provider();p.id="bad".into();p.base_url=bad;
        let mut q=provider();q.id="good".into();q.base_url=good;
        let c=Config{route_provider:"bad".into(),queue:vec!["bad".into(),"good".into()],failover:true,..Config::default()};
        let shared=state(vec![p,q],Mode::Route,c);
        let (status,text)=call(shared.clone(),json!({"model":"claude-sonnet-5","max_tokens":20,"messages":[{"role":"user","content":"private prompt fixture"}]}),"fixture").await;
        assert_eq!(status,200);assert!(text.contains("ok"));
        assert_eq!(first.await.unwrap()["model"],"real-model");
        assert_eq!(second.await.unwrap()["model"],"real-model");
        let guard=shared.lock().unwrap();assert_eq!(guard.logs.len(),2);assert_eq!(guard.active_provider,"good");
        let logs=serde_json::to_string(&guard.logs).unwrap();assert!(!logs.contains("private prompt"));assert!(!logs.contains("fixture"));
    }
    #[tokio::test]
    async fn live_openai_stream_translates_tools_and_usage(){
        let frames=[
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tool_fixture","function":{"name":"read","arguments":"{"}}]}}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]},"finish_reason":"tool_calls"}]}),
            json!({"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}),
        ];
        let body=frames.iter().map(|v|format!("data: {v}\n\n")).collect::<String>()+"data: [DONE]\n\n";
        let (url,upstream)=upstream(200,"text/event-stream",body).await;
        let mut p=provider();p.base_url=url;p.api_format=ApiFormat::OpenaiChat;
        let shared=state(vec![p],Mode::Route,Config{route_provider:"p".into(),..Config::default()});
        let (status,text)=call(shared.clone(),json!({"model":"claude-sonnet-5","stream":true,"max_tokens":20,"messages":[{"role":"user","content":"hello"}]}),"fixture").await;
        assert_eq!(status,200);assert!(text.contains("message_start"));assert!(text.contains("tool_use"));assert!(text.contains("message_stop"));
        assert_eq!(text.matches("event: content_block_start").count(),1);
        assert_eq!(upstream.await.unwrap()["model"],"real-model");
        assert_eq!(shared.lock().unwrap().logs[0].input_tokens,4);
    }
    #[tokio::test]
    async fn unauthorized_and_invalid_upstream_return_structured_errors(){
        let shared=state(vec![provider()],Mode::Route,Config{route_provider:"p".into(),..Config::default()});
        assert_eq!(call(shared,json!({"model":"m"}),"incorrect").await.0,401);
        let (url,upstream)=upstream(200,"application/json","not-json".into()).await;
        let mut p=provider();p.base_url=url;
        let shared=state(vec![p],Mode::Route,Config{route_provider:"p".into(),..Config::default()});
        let (status,body)=call(shared,json!({"model":"m","messages":[]}),"fixture").await;
        assert_eq!(status,502);assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["type"],"error");upstream.await.unwrap();
    }
    #[test]
    fn aggregate_projection_preserves_user_fields_and_publishes_prefixed_models(){
        let p=provider();
        let c=Config{default_provider:"p".into(),..Config::default()};
        let doc=project_proxy(&json!({"hooks":{"Stop":[]},"enabledPlugins":{"demo":true},"env":{"USER_OPTION":"yes"}}),&c,Mode::Aggregate,&[p],15721,"fixture").unwrap();
        assert!(doc["hooks"].is_object());assert_eq!(doc["enabledPlugins"]["demo"],true);assert_eq!(doc["env"]["USER_OPTION"],"yes");
        assert_eq!(doc["modelPicker"]["replaceBuiltInOptions"],true);
        assert_eq!(doc["modelPicker"]["options"][0]["model"],"real-model");
        assert_eq!(doc["env"]["ANTHROPIC_AUTH_TOKEN"],"fixture");
    }
    #[test]
    fn recovery_restores_only_owned_fields_and_preserves_user_edits(){
        let original=json!({"document":{"hooks":{"Stop":[]},"env":{"ANTHROPIC_BASE_URL":"https://original.test","USER_VALUE":"old","ENABLE_TOOL_SEARCH":"auto"}},"writtenExclusive":{"ENABLE_TOOL_SEARCH":"false"}});
        let mut live=json!({"hooks":{"Stop":[{"updated":true}]},"enabledPlugins":{"new":true},"modelPicker":{"options":[]},"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:15721","USER_VALUE":"changed","ENABLE_TOOL_SEARCH":"false"}});
        restore_document(&mut live,&original).unwrap();
        assert_eq!(live["env"]["ANTHROPIC_BASE_URL"],"https://original.test");
        assert_eq!(live["env"]["USER_VALUE"],"changed");assert_eq!(live["env"]["ENABLE_TOOL_SEARCH"],"auto");
        assert_eq!(live["hooks"]["Stop"][0]["updated"],true);assert_eq!(live["enabledPlugins"]["new"],true);assert!(live.get("modelPicker").is_none());
        let mut empty=json!({"env":{"ANTHROPIC_AUTH_TOKEN":"fixture"}});
        restore_document(&mut empty,&json!({"document":{}})).unwrap();assert_eq!(empty,json!({}));
    }
}
