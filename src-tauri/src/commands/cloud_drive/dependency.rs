use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::PathBuf, process::{Command, Stdio}, time::Duration};
use tokio::io::AsyncWriteExt;

pub const VERSION: &str = "1.75.2";
const ARCHIVE_SHA: &str = "8a9db2bad1dc79a65b3348fd857069598e2aab7cf4d118b77b1df23055aff818";
const URL: &str = "https://downloads.rclone.org/v1.75.2/rclone-v1.75.2-windows-amd64.zip";
pub fn root() -> Result<PathBuf,String> { Ok(crate::core::paths::data_dir()?.join("cloud-drives")) }
pub fn supported() -> bool { cfg!(all(target_os="windows",target_arch="x86_64")) }
pub fn require() -> Result<(),String> { if supported() {Ok(())} else {Err("云盘挂载当前仅支持 Windows x64 桌面客户端".into())} }
pub fn command(path: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut c=Command::new(path);
    #[cfg(windows)] { use std::os::windows::process::CommandExt; c.creation_flags(0x08000000); }
    // Do not inherit unrelated user rclone configuration, tracing or credential flags.
    for (key,_) in std::env::vars_os() { if key.to_string_lossy().to_ascii_uppercase().starts_with("RCLONE_") {c.env_remove(key);} }
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    c
}
fn managed() -> Result<PathBuf,String> { Ok(root()?.join(format!("rclone-{VERSION}")).join("rclone.exe")) }
fn digest(path:&std::path::Path)->Result<String,String> {
    let mut file=fs::File::open(path).map_err(|_|"无法读取挂载引擎")?;
    let mut hash=Sha256::new(); let mut buf=[0;65536];
    loop {let n=file.read(&mut buf).map_err(|_|"无法校验挂载引擎")?;if n==0 {break;} hash.update(&buf[..n]);}
    Ok(hex::encode(hash.finalize()))
}
pub fn executable()->Result<PathBuf,String> {
    require()?;
    let managed=managed()?;
    if managed.is_file() {
        let expected=fs::read_to_string(managed.with_extension("sha256")).map_err(|_|"引擎校验记录缺失，请重新下载")?;
        if expected.len()==64 && digest(&managed)?==expected {return Ok(managed);}
        return Err("挂载引擎校验失败，请重新下载".into());
    }
    // Search explicit PATH directories, never the current working directory.
    if let Some(paths)=std::env::var_os("PATH") {
        for p in std::env::split_paths(&paths).filter(|p|p.is_absolute()) {
            let exe=p.join("rclone.exe"); if exe.is_file() {return Ok(exe);}
        }
    }
    Err("尚未安装 rclone，请点击下载挂载引擎".into())
}
pub fn winfsp()->bool {
    ["ProgramFiles(x86)","ProgramFiles"].iter().filter_map(std::env::var_os)
        .any(|p|PathBuf::from(p).join("WinFsp/bin/winfsp-x64.dll").is_file())
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all="camelCase")]
pub struct Progress {pub phase:String,pub downloaded:u64,pub total:u64}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Dependency {pub supported:bool,pub installed:bool,pub winfsp:bool,pub version:&'static str,pub source:String,pub progress:Progress}
pub fn status(progress:Progress)->Dependency {
    // Hash the executable at launch, not on each UI status refresh.
    let exe=managed().ok().filter(|p|p.is_file()&&p.with_extension("sha256").is_file()).or_else(||
        std::env::var_os("PATH").and_then(|paths|std::env::split_paths(&paths).filter(|p|p.is_absolute()).map(|p|p.join("rclone.exe")).find(|p|p.is_file())));
    Dependency{supported:supported(),installed:exe.is_some(),winfsp:winfsp(),version:VERSION,
        source:if exe.as_ref().is_some_and(|p|Some(p)==managed().ok().as_ref()) {"CloudHub 已校验引擎"} else {"本机 PATH（需兼容 rclone 1.75.2 的挂载接口）"}.into(),progress}
}
pub async fn install(progress:&std::sync::Mutex<Progress>)->Result<(),String> {
    require()?;
    let client=reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(600)).build().map_err(|_|"无法初始化下载")?;
    let dir=root()?.join(format!("download-{}",uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).map_err(|_|"无法创建下载目录")?;
    let result=async {
        let mut response=client.get(URL).send().await.map_err(|_|"引擎下载失败，请检查网络后重试")?
            .error_for_status().map_err(|_|"官方下载服务暂不可用")?;
        let total=response.content_length().unwrap_or(0);
        if total>128*1024*1024 {return Err("引擎下载包超出大小限制".into());}
        *progress.lock().map_err(|_|"下载状态不可用")?=Progress{phase:"downloading".into(),downloaded:0,total};
        let archive=dir.join("rclone.zip");
        let mut file=tokio::fs::File::create(&archive).await.map_err(|_|"无法创建下载文件")?;
        let mut hash=Sha256::new(); let mut downloaded=0;
        while let Some(chunk)=response.chunk().await.map_err(|_|"下载中断，请重试")? {
            downloaded+=chunk.len() as u64;
            if downloaded>128*1024*1024 {return Err("引擎下载包超出大小限制".into());}
            hash.update(&chunk);
            file.write_all(&chunk).await.map_err(|_|"保存下载失败，请检查磁盘空间")?;
            progress.lock().map_err(|_|"下载状态不可用")?.downloaded=downloaded;
        }
        file.flush().await.map_err(|_|"保存下载失败")?; drop(file);
        if hex::encode(hash.finalize())!=ARCHIVE_SHA {return Err("官方下载包 SHA-256 校验失败，未安装".into());}
        progress.lock().map_err(|_|"下载状态不可用")?.phase="verifying".into();
        let mut zip=zip::ZipArchive::new(fs::File::open(&archive).map_err(|_|"无法读取下载包")?).map_err(|_|"下载包格式无效")?;
        let target=managed()?;
        let mut entry=zip.by_name("rclone-v1.75.2-windows-amd64/rclone.exe").map_err(|_|"下载包中缺少引擎")?;
        if entry.size()>256*1024*1024 {return Err("引擎文件超出限制".into());}
        let staging=dir.join("rclone.exe");
        let mut out=fs::File::create(&staging).map_err(|_|"无法保存引擎")?;
        std::io::copy(&mut entry,&mut out).map_err(|_|"无法解压引擎")?;out.sync_all().map_err(|_|"无法保存引擎")?;drop(out);
        fs::create_dir_all(target.parent().ok_or("引擎目录无效")?).map_err(|_|"无法创建引擎目录")?;
        // Never overwrite an executable currently used by a mounted drive.
        fs::copy(&staging,&target).map_err(|_|"无法安装引擎，请确认旧版本未被占用")?;
        fs::write(target.with_extension("sha256"),digest(&target)?).map_err(|_|"无法保存校验记录")?;
        Ok(())
    }.await;
    let _=fs::remove_dir_all(&dir); // UUID child created by this operation, no user content.
    progress.lock().map_err(|_|"下载状态不可用")?.phase=if result.is_ok(){"ready"}else{"failed"}.into();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "联网下载官方固定版本，不安装系统驱动；显式运行"]
    async fn cloud_drive_download_and_real_engine_cache_roundtrip() {
        install(&std::sync::Mutex::new(Progress::default())).await.unwrap();
        let executable=executable().unwrap();
        let output=command(&executable).arg("version").stdout(Stdio::piped()).output().unwrap();
        assert!(output.status.success());assert!(String::from_utf8_lossy(&output.stdout).contains("v1.75.2"));
        let directory=std::env::temp_dir().join(format!("cloudhub-drive-engine-{}",uuid::Uuid::new_v4()));
        fs::create_dir_all(directory.join("remote")).unwrap();
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let rc_port=listener.local_addr().unwrap().port();drop(listener);
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let dav_port=listener.local_addr().unwrap().port();drop(listener);
        let token=uuid::Uuid::new_v4().to_string();
        let start=||command(&executable).args(["serve","webdav"]).arg(directory.join("remote"))
            .args(["--addr",&format!("127.0.0.1:{dav_port}"),"--rc","--rc-addr",&format!("127.0.0.1:{rc_port}"),"--config","NUL",
                "--vfs-cache-mode","full","--vfs-write-back","5s","--cache-dir"]).arg(directory.join("cache"))
            .env("RCLONE_RC_USER","cloudhub").env("RCLONE_RC_PASS",&token).spawn().unwrap();
        struct Guard(std::process::Child,PathBuf);
        impl Drop for Guard {fn drop(&mut self){let _=self.0.kill();let _=self.0.wait();let _=fs::remove_dir_all(&self.1);}}
        let mut guard=Guard(start(),directory.clone());
        let mut session=super::super::runtime::Session{id:uuid::Uuid::new_v4().to_string(),port:rc_port,token:token.clone(),pid:guard.0.id(),mount_point:String::new(),cache_dir:directory.join("cache")};
        let mut ready=false;
        for _ in 0..50 {
            if super::super::runtime::alive(&session).await {ready=true;break;}
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(ready,"真实引擎 RC 未就绪");
        let http=reqwest::Client::builder().no_proxy().build().unwrap();
        let denied=http.post(format!("http://127.0.0.1:{rc_port}/core/pid")).send().await.unwrap();
        assert_eq!(denied.status(),401);
        let payload=vec![b'x';8*1024*1024];
        let target=format!("http://127.0.0.1:{dav_port}/%E8%B5%84%E6%96%99.bin");
        let response=http.put(&target).body(payload.clone()).send().await.unwrap();assert!(response.status().is_success());
        let pending=super::super::runtime::cache_status(&session).await.unwrap();
        assert!(!super::super::runtime::cache_clean(&pending),"保存后应仍有排队上传或未上传缓存");
        // A DAV VFS has no system mount. It must never appear as a mounted disk.
        assert_eq!(super::super::runtime::status(&session).await.phase,"recovery");
        let mut completed=false;
        for _ in 0..60 {
            tokio::time::sleep(Duration::from_millis(250)).await;
            if super::super::runtime::cache_clean(&super::super::runtime::cache_status(&session).await.unwrap()) {completed=true;break;}
        }
        assert!(completed,"缓存未能完成上传");
        assert_eq!(fs::read(directory.join("remote/资料.bin")).unwrap(),payload);
        let result=http.get(&target).send().await.unwrap().bytes().await.unwrap();assert_eq!(&result[..],&payload[..]);
        // Stop during write-back, retaining pending data; a fresh engine must
        // discover the same cache and upload it without another application write.
        let recovery_target=format!("http://127.0.0.1:{dav_port}/recovery.bin");
        assert!(http.put(&recovery_target).body(payload.clone()).send().await.unwrap().status().is_success());
        assert!(super::super::runtime::has_dirty_cache(&session.cache_dir).unwrap());
        let _=super::super::runtime::rc(&session,"core/quit",serde_json::json!({"exitCode":0})).await;
        let mut stopped=false;
        for _ in 0..50 {
            if guard.0.try_wait().unwrap().is_some(){stopped=true;break;}
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(stopped,"恢复测试进程未正常退出");
        assert!(super::super::runtime::has_dirty_cache(&session.cache_dir).unwrap(),"待上传缓存必须保留");
        guard.0=start();session.pid=guard.0.id();
        let mut recovered=false;
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(250)).await;
            if super::super::runtime::cache_status(&session).await.is_ok_and(|s|super::super::runtime::cache_clean(&s))
                && directory.join("remote/recovery.bin").is_file(){recovered=true;break;}
        }
        assert!(recovered,"重启后未能恢复待上传缓存");
        assert_eq!(fs::read(directory.join("remote/recovery.bin")).unwrap(),payload);
        let _=super::super::runtime::rc(&session,"core/quit",serde_json::json!({"exitCode":0})).await;
        drop(guard);
    }
}
