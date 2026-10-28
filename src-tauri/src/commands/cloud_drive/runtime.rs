use super::{dependency, model::Connection};
use crate::core::{crypto::{decrypt_secret,encrypt_secret}, storage::open_db};
use rusqlite::OptionalExtension;
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use std::{fs,io::Read,path::{Path,PathBuf},process::{Child,Command,Stdio},time::{Duration,Instant}};
use zeroize::Zeroizing;

const JOURNAL:&str="cloud.drive.sessions";
#[derive(Clone,Serialize,Deserialize)]
pub struct Session {pub id:String,pub port:u16,pub token:String,pub pid:u32,pub mount_point:String,pub cache_dir:PathBuf}
#[derive(Clone,Default,Serialize)]
#[serde(rename_all="camelCase")]
pub struct MountStatus {
    pub id:String,pub phase:String,pub queued:u64,pub uploading:u64,pub errors:u64,pub bytes_used:u64,
    pub out_of_space:bool,pub dirty:bool,pub message:String,
}
pub fn sessions()->Result<Vec<Session>,String> {
    let raw:Option<String>=open_db()?.query_row("SELECT value FROM client_preferences WHERE key=?1",[JOURNAL],|r|r.get(0))
        .optional().map_err(|_|"读取云盘恢复记录失败")?;
    raw.map(|s|serde_json::from_str(&Zeroizing::new(decrypt_secret(&s).map_err(|_|"无法解密云盘恢复记录")?))
        .map_err(|_|"云盘恢复记录损坏，已保留缓存，请勿删除缓存目录".into())).unwrap_or(Ok(vec![]))
}
pub fn save_sessions(items:&[Session])->Result<(),String> {
    let raw=Zeroizing::new(serde_json::to_string(items).map_err(|_|"无法保存云盘恢复记录")?);
    crate::core::repositories::preferences::save(&open_db()?,JOURNAL,&encrypt_secret(&raw)?,chrono::Utc::now().timestamp_millis())
        .map_err(|_|"无法保存云盘恢复记录".into())
}
pub fn configured_command(c:&Connection)->Result<Command,String> {
    let mut cmd=dependency::command(dependency::executable()?);
    cmd.args(["--config","NUL","--log-level","OFF","--contimeout","10s","--timeout","30s","--retries","1"]);
    for (key,value) in [("TYPE","s3"),("PROVIDER",&c.provider),("ENDPOINT",&c.endpoint),("REGION",&c.region),
        ("ACCESS_KEY_ID",&c.access_key_id),("SECRET_ACCESS_KEY",&c.secret_key),("SESSION_TOKEN",&c.session_token),
        ("ENV_AUTH","false"),("FORCE_PATH_STYLE",if c.path_style {"true"} else {"false"})] {
        cmd.env(format!("RCLONE_CONFIG_DRIVE_{key}"),value);
    }
    Ok(cmd)
}
pub fn wait_child(child:&mut Child,timeout:Duration)->Result<bool,String> {
    let start=Instant::now();
    loop {
        if let Some(status)=child.try_wait().map_err(|_|"无法读取引擎进程状态")? {return Ok(status.success());}
        if start.elapsed()>timeout {let _=child.kill();let _=child.wait();return Err("操作超时，请检查地址、权限和网络".into());}
        std::thread::sleep(Duration::from_millis(50));
    }
}
pub fn probe(c:&Connection, list_root:bool)->Result<Vec<String>,String> {
    let mut cmd=configured_command(c)?;
    cmd.arg("lsf").arg(if list_root {"drive:".to_owned()} else {c.remote()})
        .args(["--dirs-only","--max-depth","1","--max-duration","30s","--low-level-retries","1"]);
    cmd.stdout(Stdio::piped());
    let mut child=cmd.spawn().map_err(|_|"无法启动挂载引擎")?;
    let stdout=child.stdout.take().ok_or("无法读取连接检查结果")?;
    let reader=std::thread::spawn(move || {
        let mut bytes=Vec::new(); let result=stdout.take(1024*1024+1).read_to_end(&mut bytes); (result,bytes)
    });
    let result=wait_child(&mut child,Duration::from_secs(40));
    let (read,bytes)=reader.join().map_err(|_|"无法读取目录列表")?;
    if !result? {return Err(if list_root {"读取存储桶失败：请检查 Endpoint、区域、凭据有效期和列桶权限，也可手动填写已授权桶名"} else {"连接检查失败：请检查 Endpoint、区域、凭据有效期和列举权限"}.into());}
    if read.is_err() || bytes.len()>1024*1024 {return Err("目录列表过大，请直接填写桶名或目录".into());}
    Ok(String::from_utf8(bytes).map_err(|_|"目录名称编码无效")?.lines().take(2000).map(|s|s.trim_end_matches('/').to_owned()).collect())
}
fn client()->Result<reqwest::Client,String> {
    reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(5))
        .build().map_err(|_|"无法初始化挂载控制连接".into())
}
pub async fn rc(s:&Session,method:&str,args:Value)->Result<Value,String> {
    let mut response=client()?.post(format!("http://127.0.0.1:{}/{method}",s.port)).basic_auth("cloudhub",Some(&s.token))
        .timeout(Duration::from_secs(if method=="mount/mount" {45}else{5}))
        .json(&args).send().await.map_err(|error|control_request_error(method,error.is_timeout()))?
        .error_for_status().map_err(|_|"挂载引擎拒绝操作，请检查驱动、存储权限和网络")?;
    let mut bytes=Vec::new();
    while let Some(chunk)=response.chunk().await.map_err(|_|"读取挂载状态失败")? {
        if bytes.len()+chunk.len()>1024*1024 {return Err("挂载状态响应超出限制".into());} bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_|"挂载引擎返回无效状态".into())
}
fn control_request_error(method:&str,timed_out:bool)->&'static str {
    if timed_out {
        if method=="mount/mount" {"挂载请求超时，结果尚未确认；请刷新状态，勿重复挂载，缓存已保留"}
        else {"挂载控制请求超时，进程可能仍在运行；缓存已保留"}
    } else {"挂载进程暂不可达，缓存已保留"}
}
pub async fn alive(s:&Session)->bool {rc(s,"core/pid",json!({})).await.ok().and_then(|v|v["pid"].as_u64())==Some(s.pid as u64)}
pub fn cache_dir(c:&Connection)->Result<PathBuf,String> {
    Ok(if c.cache_dir.is_empty(){dependency::root()?.join("cache").join(&c.id)}else{PathBuf::from(&c.cache_dir).join(&c.id)})
}
pub fn has_dirty_cache(dir:&Path)->Result<bool,String> {
    let root=dir.join("vfsMeta");
    // exists() hides access errors and follows broken links. Neither proves
    // that there are no pending writes.
    match fs::symlink_metadata(&root) {
        Ok(_)=>{},
        Err(error) if error.kind()==std::io::ErrorKind::NotFound=>return Ok(false),
        Err(_)=>return Err("无法检查缓存，请保留目录并重试".into()),
    }
    let mut stack=vec![root];let mut count=0;
    while let Some(path)=stack.pop() {
        let meta=fs::symlink_metadata(&path).map_err(|_|"无法检查缓存，请保留目录并重试")?;
        if meta.file_type().is_symlink(){return Err("缓存目录包含链接，无法安全卸载".into());}
        if meta.is_dir() {
            for entry in fs::read_dir(path).map_err(|_|"无法检查缓存目录")? {stack.push(entry.map_err(|_|"无法读取缓存目录")?.path());}
        } else {
            count+=1;if count>100000 {return Err("缓存文件过多，无法确认卸载状态".into());}
            if meta.len()>8*1024*1024 {return Err("缓存元数据无效，已保留缓存".into());}
            let data=fs::read(path).map_err(|_|"无法读取缓存元数据")?;
            let value:Value=serde_json::from_slice(&data).map_err(|_|"缓存元数据无法确认，已保留缓存")?;
            match value["Dirty"].as_bool() {Some(true)=>return Ok(true),Some(false)=>{},None=>return Err("缓存状态无法确认".into())}
        }
    }
    Ok(false)
}
pub fn parse_stats(id:&str,v:&Value)->Result<MountStatus,String> {
    let d=&v["diskCache"];
    // Cache statistics alone cannot prove that a filesystem is mounted.
    Ok(MountStatus{id:id.into(),phase:"recovery".into(),queued:d["uploadsQueued"].as_u64().ok_or("缺少上传队列状态")?,
        uploading:d["uploadsInProgress"].as_u64().ok_or("缺少上传状态")?,errors:d["erroredFiles"].as_u64().ok_or("缺少失败状态")?,
        bytes_used:d["bytesUsed"].as_u64().ok_or("缺少缓存状态")?,out_of_space:d["outOfSpace"].as_bool().ok_or("缺少缓存空间状态")?,
        dirty:false,message:String::new()})
}
pub(super) async fn cache_status(s:&Session)->Result<MountStatus,String> {
    let mut status=parse_stats(&s.id,&rc(s,"vfs/stats",json!({})).await?)?;
    // inUse is a VFS reference count, NOT a count of open files.
    status.dirty=has_dirty_cache(&s.cache_dir)?;
    Ok(status)
}
fn registered_mount(value:&Value,target:&str)->Result<bool,String> {
    let points=value["mountPoints"].as_array().ok_or("无法确认已挂载磁盘，未停止进程")?;
    let normalize=|p:&str|p.replace('/',"\\").trim_end_matches('\\').to_ascii_lowercase();
    let target=normalize(target);
    let mut found=false;
    for point in points {
        let path=point["MountPoint"].as_str().filter(|p|!p.is_empty()).ok_or("无法确认已挂载磁盘，未停止进程")?;
        found|=normalize(path)==target;
    }
    Ok(found)
}
pub async fn status(s:&Session)->MountStatus {
    let result=async {
        if !alive(s).await {return Err("进程未响应；若进程已退出，点击恢复挂载重新上传缓存".to_owned());}
        if !registered_mount(&rc(s,"mount/listmounts",json!({})).await?,&s.mount_point)? {
            return Err("磁盘已不在引擎挂载列表中；缓存和恢复记录已保留，请恢复挂载或保留缓存停止".into());
        }
        let mut status=cache_status(s).await?;
        status.phase="mounted".into();
        Ok::<_,String>(status)
    }.await;
    result.unwrap_or_else(|message|MountStatus{id:s.id.clone(),phase:"recovery".into(),message,..Default::default()})
}
pub(super) fn cache_clean(s:&MountStatus)->bool {s.queued==0 && s.uploading==0 && s.errors==0 && !s.out_of_space && !s.dirty}
pub fn quiescent(s:&MountStatus)->bool {s.phase=="mounted" && cache_clean(s)}

fn daemon_command(c:&Connection,cache:&Path,port:u16,token:&str)->Result<Command,String> {
    let mut cmd=configured_command(c)?;
    // rcd accepts global flags, but does not register the mount command's VFS flags.
    cmd.args(["rcd","--rc-addr",&format!("127.0.0.1:{port}"),"--cache-dir"]).arg(cache)
        .env("RCLONE_RC_USER","cloudhub").env("RCLONE_RC_PASS",token);
    Ok(cmd)
}
fn mount_request(c:&Connection)->Value {
    // RC uses Go duration values in nanoseconds and CacheMode enum 3 = full.
    json!({"fs":c.remote(),"mountPoint":c.mount_point,"mountType":"cmount",
        "vfsOpt":{"ReadOnly":c.read_only,"CacheMode":3,"CacheMaxSize":u64::from(c.cache_gib)*1024*1024*1024,
            "CacheMinFreeSpace":1024_u64*1024*1024,"WriteBack":5_000_000_000_u64,"DirCacheTime":30_000_000_000_u64},
        "mountOpt":{"VolName":c.name}})
}
fn startup_exit_message(status:std::process::ExitStatus)->&'static str {
    match status.code().map(|code|code as u32) {
        Some(2)=>"挂载引擎启动失败（退出码 2），请检查启动参数；恢复记录和缓存已保留",
        Some(0xc0000135)=>"挂载引擎缺少运行所需的 DLL；恢复记录和缓存已保留",
        Some(0xc0000142)=>"挂载引擎运行库初始化失败；恢复记录和缓存已保留",
        _=>"挂载引擎启动后提前退出；恢复记录和缓存已保留",
    }
}

pub async fn mount(c:&Connection)->Result<(),String> {
    dependency::require()?;
    if !dependency::winfsp(){return Err("请先安装 WinFsp；安装后可能需要重启电脑".into());}
    let mut items=sessions()?;
    if let Some(old)=items.iter().find(|s|s.id==c.id) {
        if alive(old).await {
            if registered_mount(&rc(old,"mount/listmounts",json!({})).await?,&old.mount_point)? {return Err("此连接已有挂载，请刷新状态".into());}
            check_mount_available(&c.mount_point).await?;
            rc(old,"mount/mount",mount_request(c)).await?;
            return if status(old).await.phase=="mounted" {Ok(())} else {Err("挂载状态尚未确认，请刷新；恢复记录和缓存已保留".into())};
        }
        // A live process with an unresponsive RC endpoint must never be duplicated.
        if pid_exists(old.pid){return Err("旧挂载进程仍存在但无法联系，请恢复网络或检查进程后重试".into());}
    }
    check_mount_available(&c.mount_point).await?;
    let cache=cache_dir(c)?;
    fs::create_dir_all(&cache).map_err(|_|"无法创建缓存目录")?;
    let listener=std::net::TcpListener::bind("127.0.0.1:0").map_err(|_|"无法分配本地控制端口")?;
    let port=listener.local_addr().map_err(|_|"无法读取控制端口")?.port();drop(listener);
    let token=format!("{}{}",uuid::Uuid::new_v4().simple(),uuid::Uuid::new_v4().simple());
    let mut cmd=daemon_command(c,&cache,port,&token)?;
    let mut child=cmd.spawn().map_err(|_|"无法启动挂载引擎")?;
    let s=Session{id:c.id.clone(),port,token,pid:child.id(),mount_point:c.mount_point.clone(),cache_dir:cache};
    items.retain(|s|s.id!=c.id);items.push(s.clone());
    if let Err(error)=save_sessions(&items){let _=child.kill();let _=child.wait();return Err(error);}
    let mut ready=false;
    for _ in 0..40 {
        if let Some(status)=child.try_wait().map_err(|_|"无法检查进程")? {return Err(startup_exit_message(status).into());}
        if alive(&s).await{ready=true;break;}
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    if !ready {let _=child.kill();let _=child.wait();return Err("挂载引擎本地控制接口未响应；恢复记录和缓存已保留".into());}
    // Once mount is requested, even a timeout is ambiguous. Preserve the process and journal.
    rc(&s,"mount/mount",mount_request(c)).await?;
    let status=status(&s).await;
    if status.phase!="mounted" {return Err("挂载状态尚未确认，请刷新；恢复记录和缓存已保留".into());}
    Ok(())
}
pub async fn unmount(id:&str)->Result<(),String> {
    let mut items=sessions()?;
    let s=items.iter().find(|s|s.id==id).ok_or("没有需要卸载的挂载")?.clone();
    if !quiescent(&status(&s).await) {return Err("尚有写入、上传失败或无法确认的缓存；请关闭使用云盘的程序并等待上传完成".into());}
    tokio::time::sleep(Duration::from_secs(1)).await;
    if !quiescent(&status(&s).await) {return Err("缓存仍在变化，请关闭使用云盘的程序后重试".into());}
    rc(&s,"mount/unmount",json!({"mountPoint":s.mount_point})).await?;
    if has_dirty_cache(&s.cache_dir)? {return Err("卸载期间出现新的缓存修改，已保留恢复记录，请点击恢复挂载".into());}
    let _=rc(&s,"core/quit",json!({"exitCode":0})).await;
    for _ in 0..20 {
        if !pid_exists(s.pid){items.retain(|v|v.id!=id);return save_sessions(&items);}
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err("磁盘已卸载，但引擎尚未退出，已保留恢复记录".into())
}
/// Explicit recovery operation: detach filesystem, then stop the authenticated
/// engine gracefully. Never remove its journal or any cached file.
pub async fn suspend(id:&str)->Result<(),String> {
    let s=sessions()?.into_iter().find(|s|s.id==id).ok_or("没有需要停止的挂载")?;
    if !pid_exists(s.pid){return Ok(());}
    if !alive(&s).await {return Err("无法确认旧进程身份，未停止进程；请检查本机进程状态".into());}
    // Require readable metadata before changing the mount lifecycle.
    has_dirty_cache(&s.cache_dir)?;
    let mounts=rc(&s,"mount/listmounts",json!({})).await?;
    if registered_mount(&mounts,&s.mount_point)? {
        rc(&s,"mount/unmount",json!({"mountPoint":s.mount_point})).await?;
    }
    let remaining=rc(&s,"mount/listmounts",json!({})).await?;
    if !remaining["mountPoints"].as_array().is_some_and(|points|points.is_empty()) {
        return Err("仍有挂载或状态不明，未停止进程，缓存已保留".into());
    }
    // A failed quit response is ambiguous; only process exit proves completion.
    let _=rc(&s,"core/quit",json!({"exitCode":0})).await;
    for _ in 0..20 {
        if !pid_exists(s.pid){return Ok(());}
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err("引擎尚未退出，恢复记录和缓存已保留，请稍后重试".into())
}
pub fn pid_exists(pid:u32)->bool {
    #[cfg(windows)] {
        use windows_sys::Win32::{Foundation::CloseHandle,System::Threading::{OpenProcess,GetExitCodeProcess,PROCESS_QUERY_LIMITED_INFORMATION}};
        // Only ERROR_INVALID_PARAMETER proves a missing PID; access denied or
        // other lookup errors must not authorize a duplicate engine or cleanup.
        unsafe {let h=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,0,pid);if h.is_null(){return std::io::Error::last_os_error().raw_os_error()!=Some(87);}let mut code=0;let ok=GetExitCodeProcess(h,&mut code);CloseHandle(h);ok==0||code==259}
    }
    #[cfg(not(windows))] {let _=pid;false}
}
async fn check_mount_available(value:&str)->Result<(),String> {
    let value=value.to_owned();
    // Directory metadata can block inside a filesystem driver. Keep it off
    // async workers; this check has no side effects and is safe to time out.
    tokio::time::timeout(Duration::from_secs(5),tauri::async_runtime::spawn_blocking(move ||validate_mount_available(&value)))
        .await.map_err(|_|"检查挂载目标超时，请检查该盘符或父目录是否失联；缓存已保留")?
        .map_err(|_|"无法检查挂载目标")?
}
fn validate_mount_available(value:&str)->Result<(),String> {
    super::model::validate_mount_point(value)?;
    #[cfg(windows)]
    if value.len()==2 {
        // Query the drive-letter namespace without opening an unresponsive
        // WinFsp volume. Metadata on O:\ can otherwise wait indefinitely.
        let mask=unsafe {windows_sys::Win32::Storage::FileSystem::GetLogicalDrives()};
        if mask==0 {return Err("无法检查挂载目标".into());}
        return drive_letter_available(mask,value.as_bytes()[0]);
    }
    let path=if value.len()==2{PathBuf::from(format!("{value}\\"))}else{PathBuf::from(value)};
    if path.try_exists().map_err(|_|"无法检查挂载目标")? {return Err("盘符已占用，或挂载目录已存在；请选择空闲盘符或尚未创建的目录".into());}
    if value.len()>2 {
        let parent=path.parent().ok_or("挂载目录无效")?;
        if !parent.is_dir(){return Err("挂载目录的父目录必须已存在".into());}
        let canonical=parent.canonicalize().map_err(|_|"无法确认挂载父目录")?;
        if canonical.to_string_lossy().starts_with(r"\\?\UNC\"){return Err("不能挂载到网络目录".into());}
    }
    Ok(())
}
#[cfg(any(windows,test))]
fn drive_letter_available(mask:u32,letter:u8)->Result<(),String> {
    if mask & (1_u32 << (letter-b'A')) != 0 {
        Err("盘符已占用，或挂载目录已存在；请选择空闲盘符或尚未创建的目录".into())
    } else {Ok(())}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drive_letter_check_rejects_registered_volumes_without_opening_them() {
        let mask=(1_u32 << (b'C'-b'A')) | (1_u32 << (b'O'-b'A'));
        assert!(drive_letter_available(mask,b'O').is_err());
        assert!(drive_letter_available(mask,b'P').is_ok());
        #[cfg(windows)]
        assert!(validate_mount_available("C:").is_err());
    }
    #[test]
    fn control_timeouts_preserve_ambiguous_mount_results() {
        assert!(control_request_error("mount/mount",true).contains("勿重复挂载"));
        assert!(control_request_error("core/pid",true).contains("可能仍在运行"));
        assert_eq!(control_request_error("mount/mount",false),"挂载进程暂不可达，缓存已保留");
    }
    #[test]
    #[ignore = "需要已校验 rclone；仅连接本机无响应 TLS 测试端口"]
    fn real_probe_returns_when_tls_peer_stalls() {
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port=listener.local_addr().unwrap().port();listener.set_nonblocking(true).unwrap();
        let (stop,done)=std::sync::mpsc::channel();
        let peer=std::thread::spawn(move || {
            let start=Instant::now();let mut sockets=Vec::new();
            while done.try_recv().is_err() && start.elapsed()<Duration::from_secs(45) {
                if let Ok((socket,_))=listener.accept(){sockets.push(socket);}
                std::thread::sleep(Duration::from_millis(20));
            }
            sockets.len()
        });
        let c:Connection=serde_json::from_value(json!({"id":uuid::Uuid::new_v4().to_string(),"name":"timeout-test",
            "provider":"Other","endpoint":format!("https://127.0.0.1:{port}"),"region":"us-east-1","bucket":"sample-bucket","prefix":"",
            "accessKeyId":uuid::Uuid::new_v4().to_string(),"secretKey":uuid::Uuid::new_v4().to_string(),
            "pathStyle":true,"mountPoint":"Z:","readOnly":true,"autoMount":false,"cacheDir":"","cacheGib":1})).unwrap();
        let start=Instant::now();let result=probe(&c,false);let elapsed=start.elapsed();
        let _=stop.send(());let accepted=peer.join().unwrap();
        assert!(accepted>0,"测试必须实际进入无响应连接");
        assert!(result.is_err());
        assert!(elapsed<Duration::from_secs(25),"单次连接超时后不应继续低层重试至总时限");
    }
    #[tokio::test]
    #[ignore = "需要已校验 rclone 与已安装 WinFsp；仅挂载临时本地测试目录，显式运行"]
    async fn real_rcd_and_native_mount_roundtrip() {
        assert!(dependency::winfsp(),"需要先安装 WinFsp");
        let directory=std::env::temp_dir().join(format!("cloudhub-native-mount-{}",uuid::Uuid::new_v4()));
        let remote=directory.join("remote");let cache=directory.join("cache");let target=directory.join("mounted");
        fs::create_dir_all(&remote).unwrap();
        fs::write(remote.join("资料.txt"),b"native mount readback").unwrap();
        let mut c:Connection=serde_json::from_value(json!({"id":uuid::Uuid::new_v4().to_string(),"name":"cloud-drive@example.test",
            "provider":"Alibaba","endpoint":"https://oss-cn-cn-invalid.aliyuncs.com","region":"cn-beijing","bucket":"sample-bucket","prefix":"",
            "accessKeyId":uuid::Uuid::new_v4().to_string(),"secretKey":uuid::Uuid::new_v4().to_string(),
            "pathStyle":false,"mountPoint":target.to_string_lossy(),"readOnly":false,"autoMount":false,"cacheDir":"","cacheGib":1})).unwrap();
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let port=listener.local_addr().unwrap().port();drop(listener);
        let token=format!("{}{}",uuid::Uuid::new_v4().simple(),uuid::Uuid::new_v4().simple());
        let child=daemon_command(&c,&cache,port,&token).unwrap().spawn().unwrap();
        struct Guard {child:Child,directory:PathBuf}
        impl Drop for Guard {fn drop(&mut self){
            let _=self.child.kill();let _=self.child.wait();
            // Never recurse through a mount target, even on a failed test.
            let _=fs::remove_dir(self.directory.join("mounted"));
            let _=fs::remove_dir_all(self.directory.join("remote"));
            let _=fs::remove_dir_all(self.directory.join("cache"));
            let _=fs::remove_dir(&self.directory);
        }}
        let mut guard=Guard{child,directory};
        let s=Session{id:c.id.clone(),port,token,pid:guard.child.id(),mount_point:c.mount_point.clone(),cache_dir:cache};
        let mut ready=false;
        for _ in 0..50 {
            assert!(guard.child.try_wait().unwrap().is_none(),"生产启动参数使 rcd 提前退出");
            if alive(&s).await {ready=true;break;}
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(ready,"生产 rcd 启动流程未能提供控制接口");
        let mut request=mount_request(&c);request["fs"]=json!(remote.to_string_lossy());
        rc(&s,"mount/mount",request).await.unwrap();
        assert_eq!(status(&s).await.phase,"mounted");
        assert_eq!(fs::read(target.join("资料.txt")).unwrap(),b"native mount readback");
        fs::write(target.join("上传.txt"),b"native writeback").unwrap();
        let initial=cache_status(&s).await.unwrap();
        assert!(!cache_clean(&initial),"full 缓存应保留延迟上传状态");
        let mut uploaded=false;
        for _ in 0..80 {
            tokio::time::sleep(Duration::from_millis(250)).await;
            if fs::read(remote.join("上传.txt")).is_ok_and(|v|v==b"native writeback") && cache_clean(&cache_status(&s).await.unwrap()) {uploaded=true;break;}
        }
        assert!(uploaded,"原生挂载写入未完成回写");
        rc(&s,"mount/unmount",json!({"mountPoint":s.mount_point})).await.unwrap();
        assert!(!registered_mount(&rc(&s,"mount/listmounts",json!({})).await.unwrap(),&s.mount_point).unwrap());
        c.read_only=true;let mut request=mount_request(&c);request["fs"]=json!(remote.to_string_lossy());
        rc(&s,"mount/mount",request).await.unwrap();
        assert!(fs::write(target.join("refused.txt"),b"readonly").is_err(),"只读挂载必须拒绝写入");
        rc(&s,"mount/unmount",json!({"mountPoint":s.mount_point})).await.unwrap();
        let _=rc(&s,"core/quit",json!({"exitCode":0})).await;
        let mut stopped=false;
        for _ in 0..50 {if guard.child.try_wait().unwrap().is_some(){stopped=true;break;}tokio::time::sleep(Duration::from_millis(100)).await;}
        assert!(stopped,"测试引擎未正常退出");
    }
    #[test] fn incomplete_stats_never_allow_unmount() {
        assert!(parse_stats("sample",&json!({"inUse":1})).is_err());
        let mut s=parse_stats("sample",&json!({"diskCache":{"uploadsQueued":0,"uploadsInProgress":0,"erroredFiles":0,"bytesUsed":0,"outOfSpace":false}})).unwrap();
        assert!(cache_clean(&s));assert!(!quiescent(&s));s.phase="mounted".into();
        assert!(quiescent(&s));s.dirty=true;assert!(!quiescent(&s));s.dirty=false;s.queued=1;assert!(!quiescent(&s));
        s.queued=0;s.phase="recovery".into();assert!(!quiescent(&s));
    }
    #[test] fn stale_vfs_cannot_prove_a_registered_mount() {
        assert!(!registered_mount(&json!({"mountPoints":[]}),"O:").unwrap());
        assert!(!registered_mount(&json!({"mountPoints":[{"MountPoint":"P:"}]}),"O:").unwrap());
        assert!(registered_mount(&json!({"mountPoints":[{"MountPoint":"o:\\"}]}),"O:").unwrap());
        assert!(registered_mount(&json!({"mountPoints":[{"MountPoint":"D:/CloudDrive"}]}),r"D:\CloudDrive").unwrap());
        for value in [json!({}),json!({"mountPoints":null}),json!({"mountPoints":[{}]}),json!({"mountPoints":[{"MountPoint":""}]})] {
            assert!(registered_mount(&value,"O:").is_err());
        }
    }
    #[test] fn dirty_cache_is_detected_before_upload_is_queued() {
        let path=std::env::temp_dir().join(format!("cloudhub-drive-test-{}",uuid::Uuid::new_v4()));
        fs::create_dir_all(path.join("vfsMeta/drive/bucket")).unwrap();
        fs::write(path.join("vfsMeta/drive/bucket/file"),br#"{"Dirty":true}"#).unwrap();
        assert!(has_dirty_cache(&path).unwrap());
        fs::write(path.join("vfsMeta/drive/bucket/file"),br#"{"Dirty":false}"#).unwrap();
        assert!(!has_dirty_cache(&path).unwrap());
        fs::write(path.join("vfsMeta/drive/bucket/file"),br#"{"Dirty":null}"#).unwrap();
        assert!(has_dirty_cache(&path).is_err());
        fs::write(path.join("vfsMeta/drive/bucket/file"),b"incomplete").unwrap();
        assert!(has_dirty_cache(&path).is_err());
        fs::remove_dir_all(path).unwrap();
    }
}
