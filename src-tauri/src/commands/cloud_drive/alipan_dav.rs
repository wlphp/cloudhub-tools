//! Authenticated loopback-only adapter; the provider token never reaches rclone.
use super::{alipan::{self, Authorization}, model};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::{Arc, Mutex, OnceLock}, time::Duration};
use tokio::{io::{AsyncReadExt, AsyncWriteExt, BufReader}, net::{TcpListener,TcpStream}, sync::Semaphore};

#[derive(Clone, Serialize, Deserialize)]
pub struct Bridge {pub port:u16,pub token:String}
impl Drop for Bridge {fn drop(&mut self){use zeroize::Zeroize;self.token.zeroize();}}
struct Server {config:Bridge, task:tokio::task::JoinHandle<()>}
static SERVERS:OnceLock<Mutex<HashMap<String,Server>>>=OnceLock::new();
static START:tokio::sync::Mutex<()>=tokio::sync::Mutex::const_new(());
fn servers()->&'static Mutex<HashMap<String,Server>> {SERVERS.get_or_init(||Mutex::new(HashMap::new()))}
pub fn stop(id:&str) {
    if let Ok(mut all)=servers().lock() {if let Some(server)=all.remove(id) {server.task.abort();}}
}
pub fn endpoint(id:&str)->Result<Bridge,String> {
    servers().lock().map_err(|_|alipan::API_ERROR)?.get(id).filter(|s|!s.task.is_finished()).map(|s|s.config.clone()).ok_or(alipan::API_ERROR.into())
}
pub async fn ensure(id:&str,previous:Option<&Bridge>)->Result<Bridge,String> {
    let _start=START.lock().await;
    if let Ok(current)=endpoint(id) {
        if previous.is_none_or(|old|old.port==current.port&&old.token==current.token) {return Ok(current);}
        return Err(alipan::API_ERROR.into());
    }
    let listener=TcpListener::bind((std::net::Ipv4Addr::LOCALHOST,previous.map(|b|b.port).unwrap_or(0)))
        .await.map_err(|_|"无法启动阿里云盘本机文件接口")?;
    let config=Bridge{port:listener.local_addr().map_err(|_|alipan::API_ERROR)?.port(),
        token:previous.map(|b|b.token.clone()).unwrap_or_else(||format!("{}{}",uuid::Uuid::new_v4().simple(),uuid::Uuid::new_v4().simple()))};
    let id_owned=id.to_owned();let secret=config.token.clone();
    let task=tokio::spawn(async move {
        let slots=Arc::new(Semaphore::new(8));
        let downloads=Arc::new(Semaphore::new(2));
        let mutations=Arc::new(tokio::sync::Mutex::new(()));
        let mut requests=tokio::task::JoinSet::new();
        loop {tokio::select! {
        accepted=listener.accept()=>{
            let Ok((stream,_))=accepted else {break;};
            let Ok(slot)=slots.clone().try_acquire_owned() else {drop(stream);continue;};
            let id=id_owned.clone();let secret=secret.clone();let downloads=downloads.clone();let mutations=mutations.clone();
            requests.spawn(async move {
                let _slot=slot;
                let _=serve(stream,&id,&secret,downloads,mutations).await;
            });
        },
        Some(_)=requests.join_next()=>{},
        }}
    });
    let mut all=servers().lock().map_err(|_|alipan::API_ERROR)?;
    if let Some(old)=all.insert(id.to_owned(),Server{config:config.clone(),task}) {old.task.abort();}
    Ok(config)
}

#[derive(Clone,Deserialize)]
struct File {
    file_id:String,name:String,
    #[serde(rename="type")] kind:String,
    #[serde(default, deserialize_with="null_default")] size:u64,
    #[serde(default, deserialize_with="null_default")] updated_at:String,
    #[serde(default, deserialize_with="null_default")] content_hash:String,
}
// Official folder entries explicitly return null for size/hash. Serde's
// `default` alone covers absent fields, but rejects these valid null values.
// Non-null values must retain the correct type; children() still requires a
// real numeric size and valid timestamp for ordinary files.
fn null_default<'de,D,T>(deserializer:D)->Result<T,D::Error>
where D:serde::Deserializer<'de>, T:Deserialize<'de>+Default {
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}
impl File {
    fn folder(&self)->bool {self.kind=="folder"}
    fn root(id:&str)->Self {Self{file_id:id.into(),name:String::new(),kind:"folder".into(),size:0,updated_at:String::new(),content_hash:String::new()}}
}
type DavResult<T>=Result<T,u16>;
fn api_error(e:String)->u16 {if e==alipan::AUTH_ERROR {401}else{503}}
fn valid_name(s:&str)->bool {!s.is_empty()&&s.len()<=1024&&!s.contains(['/', '\\'])&&!s.chars().any(char::is_control)&&s!="."&&s!=".."}
fn path(raw:&str)->DavResult<Vec<String>> {
    if !raw.starts_with('/') || raw.contains(['?', '#']) {return Err(400);}
    let decoded=percent_encoding::percent_decode_str(raw).decode_utf8().map_err(|_|400u16)?;
    let parts:Vec<_>=decoded.trim_matches('/').split('/').filter(|s|!s.is_empty()).map(str::to_owned).collect();
    if parts.len()>64||!parts.iter().all(|s|valid_name(s)) {return Err(400);}
    Ok(parts)
}
async fn call(auth:&Authorization,method:&str,mut args:Value)->DavResult<Value> {
    args["drive_id"]=json!(auth.drive_id);
    alipan::post(auth,&format!("/adrive/v1.0/openFile/{method}"),args).await.map_err(api_error)
}
async fn children(auth:&Authorization,id:&str)->DavResult<Vec<File>> {
    let mut files=Vec::new();let mut marker=String::new();let mut seen=std::collections::HashSet::new();
    for _ in 0..1000 {
        let v=call(auth,"list",json!({"parent_file_id":id,"limit":100,"marker":marker})).await?;
        let items=v["items"].as_array().ok_or(502u16)?;
        for item in items {
            let f:File=serde_json::from_value(item.clone()).map_err(|_|502u16)?;
            if !valid_name(&f.name)||f.file_id.is_empty()||f.file_id.len()>4096||!["file","folder"].contains(&f.kind.as_str()) {return Err(502);}
            if !f.folder() && (item["size"].as_u64().is_none() || chrono::DateTime::parse_from_rfc3339(&f.updated_at).is_err()) {return Err(502);}
            files.push(f);
        }
        marker=v["next_marker"].as_str().unwrap_or_default().to_owned();
        if marker.is_empty() {return Ok(files);}
        if !seen.insert(marker.clone()) {return Err(502);}
    }
    Err(507)
}
async fn child(auth:&Authorization,parent:&str,name:&str)->DavResult<Option<File>> {
    let matches:Vec<_>=children(auth,parent).await?.into_iter().filter(|f|f.name==name).collect();
    if matches.len()>1 {return Err(409);}
    Ok(matches.into_iter().next())
}
async fn resolve(auth:&Authorization,parts:&[String])->DavResult<File> {
    let mut file=File::root(&auth.root_id);
    for part in parts {
        if !file.folder() {return Err(409);}
        file=child(auth,&file.file_id,part).await?.ok_or(404u16)?;
    }
    Ok(file)
}
async fn wait_task(auth:&Authorization,v:&Value)->DavResult<()> {
    if let Some(task)=v["async_task_id"].as_str().filter(|s|!s.is_empty()) {
        for _ in 0..30 {
            let state=call(auth,"async_task/get",json!({"async_task_id":task})).await?;
            match state["state"].as_str() {Some("Succeed")=>return Ok(()),Some("Running")=>{},_=>return Err(503)}
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        return Err(503);
    }
    Ok(())
}
async fn trash(auth:&Authorization,id:&str)->DavResult<()> {
    let v=call(auth,"recyclebin/trash",json!({"file_id":id})).await?;wait_task(auth,&v).await
}
fn xml(s:&str)->String {s.replace('&',"&amp;").replace('<',"&lt;").replace('>',"&gt;").replace('"',"&quot;").replace('\'',"&apos;")}
fn href(parts:&[String],folder:bool)->String {
    let mut s=String::from("/");
    s.push_str(&parts.iter().map(|s|percent_encoding::utf8_percent_encode(s,percent_encoding::NON_ALPHANUMERIC).to_string()).collect::<Vec<_>>().join("/"));
    if folder&&!s.ends_with('/') {s.push('/');}s
}
fn properties(file:&File,parts:&[String])->String {
    let kind=if file.folder(){"<d:collection/>"}else{""};
    let modified=chrono::DateTime::parse_from_rfc3339(&file.updated_at).map(|t|t.with_timezone(&chrono::Utc).format("%a, %d %b %Y %H:%M:%S GMT").to_string()).unwrap_or_else(|_|"Thu, 01 Jan 1970 00:00:00 GMT".into());
    let etag=xml(&format!("\"{}-{}\"",file.file_id,file.content_hash));
    format!("<d:response><d:href>{}</d:href><d:propstat><d:prop><d:displayname>{}</d:displayname><d:resourcetype>{kind}</d:resourcetype><d:getcontentlength>{}</d:getcontentlength><d:getlastmodified>{modified}</d:getlastmodified><d:getetag>{etag}</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>",xml(&href(parts,file.folder())),xml(&file.name),file.size)
}
fn transfer_url(value:&str)->DavResult<reqwest::Url> {
    let u=reqwest::Url::parse(value).map_err(|_|502u16)?;
    let h=u.host_str().ok_or(502u16)?;
    // Never forward provider-controlled URLs to localhost or arbitrary services.
    if u.scheme()!="https"||!u.username().is_empty()||u.password().is_some()||u.port().is_some()
        || !["aliyundrive.net","aliyundrive.com","alicloudccp.com","aliyuncs.com","alipan.com"].iter().any(|d|h==*d||h.ends_with(&format!(".{d}"))) {return Err(502);}
    Ok(u)
}
async fn headers(stream:&mut TcpStream,status:u16,length:u64,extra:&str)->Result<(),()> {
    let reason=match status {200=>"OK",201=>"Created",204=>"No Content",206=>"Partial Content",207=>"Multi-Status",400=>"Bad Request",401=>"Unauthorized",403=>"Forbidden",404=>"Not Found",405=>"Method Not Allowed",409=>"Conflict",411=>"Length Required",412=>"Precondition Failed",416=>"Range Not Satisfiable",423=>"Locked",507=>"Insufficient Storage",_=>"Service Unavailable"};
    stream.write_all(format!("HTTP/1.1 {status} {reason}\r\nContent-Length: {length}\r\nConnection: close\r\n{extra}\r\n").as_bytes()).await.map_err(|_|())
}
async fn reply(stream:&mut TcpStream,status:u16,body:&str,extra:&str)->Result<(),()> {
    headers(stream,status,body.len() as u64,extra).await?;
    stream.write_all(body.as_bytes()).await.map_err(|_|())
}
struct Request {method:String,target:String,headers:HashMap<String,String>,length:u64}
async fn request(reader:&mut BufReader<TcpStream>)->DavResult<Request> {
    let mut head=Vec::new();
    // A bounded byte reader avoids unbounded allocation on an unterminated header.
    while head.len()<32768 {
        head.push(reader.read_u8().await.map_err(|_|400u16)?);
        if head.ends_with(b"\r\n\r\n") {break;}
    }
    if !head.ends_with(b"\r\n\r\n") {return Err(400);}
    let head=std::str::from_utf8(&head).map_err(|_|400u16)?;
    let mut lines=head.split("\r\n");let first:Vec<_>=lines.next().unwrap_or_default().split_whitespace().collect();
    if first.len()!=3||first[2]!="HTTP/1.1" {return Err(400);}
    let mut headers=HashMap::new();
    for line in lines.filter(|s|!s.is_empty()) {
        let (k,v)=line.split_once(':').ok_or(400u16)?;
        if headers.insert(k.to_ascii_lowercase(),v.trim().to_owned()).is_some() {return Err(400);}
    }
    if headers.contains_key("transfer-encoding") {return Err(411);}
    let length=headers.get("content-length").map(|v|v.parse::<u64>().map_err(|_|400u16)).transpose()?.unwrap_or(0);
    Ok(Request{method:first[0].into(),target:first[1].into(),headers,length})
}
async fn upload(reader:&mut BufReader<TcpStream>,auth:&Authorization,parent:&File,name:&str,length:u64,old:Option<&File>)->DavResult<()> {
    const PART:u64=16*1024*1024;
    let count=length.div_ceil(PART).max(1);
    if count>10000 {return Err(507);}
    let temporary=format!(".cloudhub-upload-{}",uuid::Uuid::new_v4());
    let v=call(auth,"create",json!({"parent_file_id":parent.file_id,"name":temporary,"type":"file","check_name_mode":"refuse","size":length,
        "part_info_list":(1..=count).map(|n|json!({"part_number":n})).collect::<Vec<_>>()})).await?;
    let file_id=alipan::text(&v,"file_id").map_err(api_error)?;
    // The service can create an empty file immediately. Never skip incoming nonempty data.
    if v["rapid_upload"].as_bool()==Some(true) && length!=0 {return Err(502);}
    if v["rapid_upload"].as_bool()!=Some(true) {
    let upload_id=alipan::text(&v,"upload_id").map_err(api_error)?;
    let parts=v["part_info_list"].as_array().ok_or(502u16)?;
    if parts.len()!=count as usize {return Err(502);}
    let client=alipan::client().map_err(api_error)?;
    let mut remaining=length;
    for (i,part) in parts.iter().enumerate() {
        if part["part_number"].as_u64()!=Some(i as u64+1) {return Err(502);}
        let url=transfer_url(part["upload_url"].as_str().ok_or(502u16)?)?;
        let mut data=vec![0;remaining.min(PART) as usize];
        tokio::time::timeout(Duration::from_secs(90),reader.read_exact(&mut data)).await.map_err(|_|503u16)?.map_err(|_|503u16)?;
        remaining-=data.len() as u64;
        let sent=client.put(url).body(data).timeout(Duration::from_secs(300)).send().await.map_err(|_|503u16)?;
        if !sent.status().is_success() {return Err(503);}
    }
    call(auth,"complete",json!({"file_id":file_id,"upload_id":upload_id})).await?;
    }
    let current=child(auth,&parent.file_id,name).await?;
    match (old,current.as_ref()) {
        (Some(a),Some(b)) if a.file_id==b.file_id&&a.size==b.size&&a.updated_at==b.updated_at&&a.content_hash==b.content_hash=>trash(auth,&a.file_id).await?,
        (None,None)=>{},
        _=>return Err(409),
    }
    // Keep the completed staging file if rename fails; never acknowledge an incomplete upload.
    call(auth,"update",json!({"file_id":file_id,"name":name,"check_name_mode":"refuse"})).await?;
    Ok(())
}
async fn serve(stream:TcpStream,id:&str,secret:&str,downloads:Arc<Semaphore>,mutations:Arc<tokio::sync::Mutex<()>>)->Result<(),()> {
    let mut reader=BufReader::new(stream);
    let req=match tokio::time::timeout(Duration::from_secs(30),request(&mut reader)).await {
        Ok(Ok(v))=>v,Ok(Err(s))=>return reply(reader.get_mut(),s,"","").await,Err(_)=>return Ok(()),
    };
    let expected=format!("Basic {}",STANDARD.encode(format!("cloudhub:{secret}")));
    let bearer=format!("Bearer {secret}");
    if !req.headers.get("authorization").is_some_and(|v|v==&expected||v==&bearer) {return reply(reader.get_mut(),401,"","WWW-Authenticate: Basic realm=\"CloudHub\"\r\n").await;}
    if req.method=="OPTIONS" {return reply(reader.get_mut(),200,"","DAV: 1\r\nAllow: OPTIONS, PROPFIND, GET, HEAD, PUT, MKCOL, DELETE, MOVE\r\n").await;}
    let c=match model::find(id) {Ok(c)=>c,Err(_)=>return reply(reader.get_mut(),503,"","").await};
    let auth=match alipan::credentials(&c) {Ok(a)=>a,Err(_)=>return reply(reader.get_mut(),401,"","").await};
    let parts=match path(&req.target) {Ok(v)=>v,Err(s)=>return reply(reader.get_mut(),s,"","").await};
    let writing=!["GET","HEAD","PROPFIND"].contains(&req.method.as_str());
    // Enforce both the mount setting and the authorization's granted write capability.
    if writing&&(c.read_only||!auth.writable) {return reply(reader.get_mut(),403,"","").await;}
    let _mutation=if writing {Some(mutations.lock().await)}else{None};
    if req.method=="PUT"&&req.length>0&&req.headers.get("expect").is_some_and(|s|s.eq_ignore_ascii_case("100-continue")) {
        reader.get_mut().write_all(b"HTTP/1.1 100 Continue\r\n\r\n").await.map_err(|_|())?;
    }
    if req.method!="PUT" {
        if req.length>65536 {return reply(reader.get_mut(),400,"","").await;}
        let mut body=vec![0;req.length as usize];tokio::time::timeout(Duration::from_secs(30),reader.read_exact(&mut body)).await.map_err(|_|())?.map_err(|_|())?;
    }
    let result:Result<(),u16>=async {
        match req.method.as_str() {
            "PROPFIND"=>{
                if !["0","1"].contains(&req.headers.get("depth").map(String::as_str).unwrap_or("1")) {return Err(403);}
                let f=resolve(auth,&parts).await?;
                let mut body=format!("<?xml version=\"1.0\" encoding=\"utf-8\"?><d:multistatus xmlns:d=\"DAV:\">{}",properties(&f,&parts));
                if f.folder()&&req.headers.get("depth").is_none_or(|s|s!="0") {
                    let mut names=std::collections::HashSet::new();
                    for file in children(auth,&f.file_id).await? {
                        if !names.insert(file.name.clone()) {return Err(409);}
                        let mut sub=parts.clone();sub.push(file.name.clone());body.push_str(&properties(&file,&sub));
                        if body.len()>32*1024*1024 {return Err(507);}
                    }
                }
                body.push_str("</d:multistatus>");
                reply(reader.get_mut(),207,&body,"Content-Type: application/xml; charset=utf-8\r\n").await.map_err(|_|500u16)?;
            },
            "GET"|"HEAD"=>{
                let f=resolve(auth,&parts).await?;if f.folder(){return Err(405);}
                if req.method=="HEAD" {headers(reader.get_mut(),200,f.size,"Accept-Ranges: bytes\r\n").await.map_err(|_|500u16)?;return Ok(());}
                if f.size==0 {
                    if req.headers.contains_key("range") {return Err(416);}
                    reply(reader.get_mut(),200,"","Accept-Ranges: bytes\r\n").await.map_err(|_|500u16)?;return Ok(());
                }
                let _slot=downloads.acquire().await.map_err(|_|503u16)?;
                let v=call(auth,"getDownloadUrl",json!({"file_id":f.file_id})).await?;
                let url=transfer_url(v["url"].as_str().ok_or(502u16)?)?;
                let range=req.headers.get("range").cloned().unwrap_or_else(||format!("bytes=0-{}",f.size.saturating_sub(1)));
                if !valid_range(&range) {return Err(416);}
                let (start,end)=range_bounds(&range,f.size)?;
                let range=format!("bytes={start}-{end}");
                let mut response=alipan::client().map_err(api_error)?.get(url).header("Range",range).timeout(Duration::from_secs(600)).send().await.map_err(|_|503u16)?;
                let upstream=response.status().as_u16();
                if upstream!=206 {return Err(if upstream==416{416}else{502});}
                let length=response.content_length().ok_or(502u16)?;
                let expected=format!("bytes {start}-{end}/{}",f.size);
                if length!=end-start+1 || response.headers().get("content-range").and_then(|s|s.to_str().ok())!=Some(expected.as_str()) {return Err(502);}
                let partial=req.headers.contains_key("range");
                let status=if partial{206}else{200};
                let extra=if partial{format!("Content-Range: {expected}\r\nAccept-Ranges: bytes\r\n")}else{"Accept-Ranges: bytes\r\n".into()};
                headers(reader.get_mut(),status,length,&extra).await.map_err(|_|500u16)?;
                // After headers, streaming failures close the connection; never append a second HTTP response.
                let mut remaining=length;
                while let Some(chunk)=match response.chunk().await {Ok(c)=>c,Err(_)=>return Ok(())} {
                    if chunk.len() as u64>remaining {return Ok(());}
                    remaining-=chunk.len() as u64;
                    if reader.get_mut().write_all(&chunk).await.is_err() {return Ok(());}
                }
            },
            "PUT"=>{
                if !req.headers.contains_key("content-length") {return Err(411);}
                let name=parts.last().ok_or(403u16)?;
                let parent=resolve(auth,&parts[..parts.len()-1]).await?;if !parent.folder(){return Err(409);}
                let old=child(auth,&parent.file_id,name).await?;if old.as_ref().is_some_and(File::folder){return Err(405);}
                upload(&mut reader,auth,&parent,name,req.length,old.as_ref()).await?;
                reply(reader.get_mut(),201,"","").await.map_err(|_|500u16)?;
            },
            "MKCOL"=>{
                let name=parts.last().ok_or(403u16)?;
                let parent=resolve(auth,&parts[..parts.len()-1]).await?;if !parent.folder(){return Err(409);}
                call(auth,"create",json!({"parent_file_id":parent.file_id,"name":name,"type":"folder","check_name_mode":"refuse"})).await?;
                reply(reader.get_mut(),201,"","").await.map_err(|_|500u16)?;
            },
            "DELETE"=>{
                if parts.is_empty(){return Err(403);}
                let f=resolve(auth,&parts).await?;trash(auth,&f.file_id).await?;
                reply(reader.get_mut(),204,"","").await.map_err(|_|500u16)?;
            },
            "MOVE"=>{
                if parts.is_empty(){return Err(403);}
                let destination=req.headers.get("destination").ok_or(400u16)?;
                let url=reqwest::Url::parse(destination).map_err(|_|400u16)?;
                let bridge=endpoint(id).map_err(api_error)?;
                if url.scheme()!="http"||url.host_str()!=Some("127.0.0.1")||url.port()!=Some(bridge.port)||url.query().is_some()||url.fragment().is_some() {return Err(403);}
                let target=path(url.path())?;let name=target.last().ok_or(403u16)?;
                if target==parts {reply(reader.get_mut(),204,"","").await.map_err(|_|500u16)?;return Ok(());}
                let f=resolve(auth,&parts).await?;let parent=resolve(auth,&target[..target.len()-1]).await?;
                if !parent.folder() {return Err(409);}
                // Refuse ambiguous overwrite moves; preserve the source and surface the failure.
                if child(auth,&parent.file_id,name).await?.is_some() {return Err(412);}
                let v=call(auth,"move",json!({"file_id":f.file_id,"to_parent_file_id":parent.file_id,"new_name":name,"check_name_mode":"refuse"})).await?;
                wait_task(auth,&v).await?;
                reply(reader.get_mut(),201,"","").await.map_err(|_|500u16)?;
            },
            _=>return Err(405),
        }
        Ok(())
    }.await;
    if let Err(status)=result {reply(reader.get_mut(),status,"","").await?;}
    Ok(())
}
fn valid_range(s:&str)->bool {
    s.strip_prefix("bytes=").is_some_and(|v|v.len()<=64&&v.split_once('-').is_some_and(|(a,b)|
        (!a.is_empty()||!b.is_empty())&&a.bytes().all(|b|b.is_ascii_digit())&&b.bytes().all(|b|b.is_ascii_digit())))
}
fn range_bounds(s:&str,size:u64)->DavResult<(u64,u64)> {
    if size==0 || !valid_range(s) {return Err(416);}
    let (a,b)=s[6..].split_once('-').ok_or(416u16)?;
    if a.is_empty() {
        let suffix=b.parse::<u64>().map_err(|_|416u16)?;
        if suffix==0 {return Err(416);}
        return Ok((size.saturating_sub(suffix),size-1));
    }
    let start=a.parse::<u64>().map_err(|_|416u16)?;
    let end=if b.is_empty(){size-1}else{b.parse::<u64>().map_err(|_|416u16)?.min(size-1)};
    if start>end {return Err(416);}
    Ok((start,end))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn listing_accepts_nullable_folder_metadata_but_rejects_invalid_file_metadata() {
        for (item,valid) in [
            (json!({"file_id":"folder","name":"资料","type":"folder","size":null,"content_hash":null,"updated_at":"2026-01-01T00:00:00Z"}),true),
            (json!({"file_id":"folder","name":"资料","type":"folder","size":null,"content_hash":null,"updated_at":null}),true),
            (json!({"file_id":"file","name":"empty.txt","type":"file","size":0,"content_hash":null,"updated_at":"2026-01-01T00:00:00Z"}),true),
            (json!({"file_id":"file","name":"bad.txt","type":"file","size":null,"content_hash":null,"updated_at":"2026-01-01T00:00:00Z"}),false),
            (json!({"file_id":"file","name":"bad.txt","type":"file","size":0,"content_hash":null,"updated_at":null}),false),
            (json!({"file_id":"folder","name":"资料","type":"folder","size":"invalid","content_hash":null}),false),
        ] {
            let mock:Box<dyn FnMut(&str,Value)->Result<Value,String>+Send>=Box::new(move |method,_| {
                assert!(method.ends_with("/openFile/list"));
                Ok(json!({"items":[item],"next_marker":""}))
            });
            alipan::MOCK.scope(Mutex::new(mock),async {
                let auth=Authorization{access_token:uuid::Uuid::new_v4().to_string(),expires_at:i64::MAX,user_id:"user".into(),drive_id:"drive".into(),root_id:"root".into(),writable:false};
                let result=children(&auth,"root").await;
                if valid {
                    let files=result.unwrap();
                    assert_eq!(files.len(),1);
                    assert_eq!(files[0].size,0);
                    assert!(files[0].content_hash.is_empty());
                    assert!(properties(&files[0],&[files[0].name.clone()]).contains("HTTP/1.1 200 OK"));
                } else {assert!(matches!(result,Err(502)));}
            }).await;
        }
    }
    #[test]
    fn ranges_handle_suffixes_and_reject_out_of_bounds() {
        assert_eq!(range_bounds("bytes=-3",10),Ok((7,9)));
        assert_eq!(range_bounds("bytes=8-999",10),Ok((8,9)));
        assert_eq!(range_bounds("bytes=0-",10),Ok((0,9)));
        for range in ["bytes=-0","bytes=10-","bytes=8-3","bytes=18446744073709551616-","bytes=0-1,3-4"] {assert!(range_bounds(range,10).is_err());}
        assert!(range_bounds("bytes=0-",0).is_err());
    }
    #[tokio::test]
    async fn staging_reports_success_only_after_rename_and_preserves_changed_targets() {
        for (changed,rename_fails) in [(false,false),(true,false),(false,true)] {
            let calls=Arc::new(Mutex::new(Vec::new()));let observed=calls.clone();
            let mock:Box<dyn FnMut(&str,Value)->Result<Value,String> + Send>=Box::new(move |method,args| {
                let method=method.rsplit('/').next().unwrap();observed.lock().unwrap().push(method.to_owned());
                match method {
                    "create"=>{assert_eq!(args["check_name_mode"],"refuse");assert!(args["name"].as_str().unwrap().starts_with(".cloudhub-upload-"));Ok(json!({"file_id":"staged","rapid_upload":true}))},
                    "list"=>Ok(json!({"items":[{"file_id":if changed{"other-device"}else{"original"},"name":"target.txt","type":"file","size":0,"updated_at":"2026-01-01T00:00:00Z","content_hash":"before"}]})),
                    "trash"=>{assert_eq!(args["file_id"],"original");Ok(json!({}))},
                    "update"=>if rename_fails {Err(alipan::API_ERROR.into())}else{Ok(json!({}))},
                    _=>panic!("unexpected API operation"),
                }
            });
            alipan::MOCK.scope(Mutex::new(mock),async {
                let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
                let socket=TcpStream::connect(listener.local_addr().unwrap()).await.unwrap();
                let (_peer,_)=listener.accept().await.unwrap();
                let auth=Authorization{access_token:uuid::Uuid::new_v4().to_string(),expires_at:i64::MAX,user_id:"user".into(),drive_id:"drive".into(),root_id:"root".into(),writable:true};
                let old=File{file_id:"original".into(),name:"target.txt".into(),kind:"file".into(),size:0,updated_at:"2026-01-01T00:00:00Z".into(),content_hash:"before".into()};
                let result=upload(&mut BufReader::new(socket),&auth,&File::root("root"),"target.txt",0,Some(&old)).await;
                assert_eq!(result,if changed{Err(409)}else if rename_fails{Err(503)}else{Ok(())});
            }).await;
            let observed=calls.lock().unwrap();
            if changed {assert_eq!(*observed,vec!["create","list"]);}else{assert_eq!(*observed,vec!["create","list","trash","update"]);}
        }
    }
    #[test]
    fn dav_paths_and_signed_urls_cannot_escape() {
        for s in ["/../a","/%2e%2e/a","/a%5cb","/a%00","https://example.test/"] {assert!(path(s).is_err(),"{s}");}
        assert_eq!(path("/%E8%B5%84%E6%96%99/a%20b").unwrap(),vec!["资料","a b"]);
        for s in ["http://data.aliyundrive.net/x","https://127.0.0.1/x","https://aliyundrive.net.example.test/x","https://data.aliyundrive.net:8443/x"] {assert!(transfer_url(s).is_err());}
        assert!(transfer_url("https://cn-beijing-data.aliyundrive.net/object?signature=test").is_ok());
        assert!(!valid_range("bytes=0-1,3-4"));assert!(valid_range("bytes=10-"));
    }
    #[tokio::test]
    async fn loopback_adapter_requires_authentication_before_loading_credentials() {
        let id=uuid::Uuid::new_v4().to_string();let config=ensure(&id,None).await.unwrap();
        let client=reqwest::Client::builder().no_proxy().build().unwrap();
        let url=format!("http://127.0.0.1:{}/",config.port);
        assert_eq!(client.get(&url).send().await.unwrap().status(),401);
        assert_eq!(client.request(reqwest::Method::OPTIONS,&url).basic_auth("cloudhub",Some(&config.token)).send().await.unwrap().status(),200);
        servers().lock().unwrap().remove(&id).unwrap().task.abort();
    }
}
