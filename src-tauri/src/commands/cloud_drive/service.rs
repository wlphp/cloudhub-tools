use super::{dependency, model, runtime};

use serde::Serialize;
use std::{collections::HashMap,sync::Mutex};
use tauri::{Manager,State};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_dialog::DialogExt;

const MAX_TRANSFER: usize = 8 * 1024 * 1024;
static PENDING_IMPORT: Mutex<Option<(String, Vec<model::Connection>)>> = Mutex::new(None);
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct TransferPackage { format: String, version: u32, connections: Vec<model::Connection> }

#[derive(Default)]
pub struct DriveStore {
    pub(super) operations:tokio::sync::Mutex<()>,
    pub(super) authorizations:tokio::sync::Mutex<HashMap<String,super::alipan::Pending>>,
    progress:Mutex<dependency::Progress>,
    errors:Mutex<HashMap<String,String>>,
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Snapshot {dependency:dependency::Dependency,connections:Vec<serde_json::Value>,mounts:Vec<runtime::MountStatus>}

pub async fn cloud_drive_snapshot(state:State<'_,DriveStore>)->Result<Snapshot,String> {
    let connections=model::load()?;
    let mut mounts=Vec::new();
    for session in runtime::sessions()? {mounts.push(runtime::status(&session).await);}
    let errors=state.errors.lock().map_err(|_|"云盘状态不可用")?;
    for c in &connections {
        if !mounts.iter().any(|s|s.id==c.id) {
            mounts.push(runtime::MountStatus{id:c.id.clone(),phase:"idle".into(),message:errors.get(&c.id).cloned().unwrap_or_default(),..Default::default()});
        }
    }
    Ok(Snapshot{dependency:dependency::status(state.progress.lock().map_err(|_|"下载状态不可用")?.clone()),
        connections:connections.iter().map(model::Connection::view).collect(),mounts})
}
pub async fn cloud_drive_install(state:State<'_,DriveStore>)->Result<(),String> {
    let _lock=state.operations.lock().await;
    if !runtime::sessions()?.is_empty(){return Err("请先安全卸载云盘并处理恢复记录，再安装引擎".into());}
    dependency::install(&state.progress).await
}
fn merge_saved_credentials(input:&mut model::Connection,old:&model::Connection,clear_session_token:bool,reuse_saved_credentials:bool)->Result<(),String> {
    if input.provider=="Alipan" {
        input.alipan_auth=if old.provider=="Alipan"&&old.alipan_app_id==input.alipan_app_id&&old.alipan_drive==input.alipan_drive {old.alipan_auth.clone()}else{None};
        input.access_key_id.clear();input.secret_key.clear();input.session_token.clear();
        return Ok(());
    }
    input.alipan_auth=None;
    let destination_same=old.endpoint==input.endpoint && old.provider==input.provider;
    let key_same=old.access_key_id==input.access_key_id;
    if input.secret_key.is_empty() {
        if !key_same {return Err("Access Key ID 已变更，请填写配套的 Secret Access Key".into());}
        if !destination_same && !reuse_saved_credentials {return Err("服务地址或服务商已变更，请确认沿用已保存凭据或填写新密钥".into());}
        input.secret_key=old.secret_key.clone();
    }
    if clear_session_token {input.session_token.clear();}
    else if input.session_token.is_empty() && key_same && (destination_same || reuse_saved_credentials) {
        input.session_token=old.session_token.clone();
    }
    Ok(())
}
pub async fn cloud_drive_save(state:State<'_,DriveStore>,mut input:model::Connection,clear_session_token:bool,reuse_saved_credentials:bool)->Result<(),String> {
    dependency::require()?;
    let _lock=state.operations.lock().await;
    let mut all=model::load()?;
    input.alipan_auth=None; // Never accept an access token from the configuration editor.
    let previous_id=input.id.clone();
    if input.id.is_empty(){input.id=uuid::Uuid::new_v4().to_string();}
    if runtime::sessions()?.iter().any(|s|s.id==input.id){return Err("请先安全卸载并处理恢复记录，再修改配置".into());}
    if let Some(old)=all.iter().find(|c|c.id==input.id) {
        merge_saved_credentials(&mut input,old,clear_session_token,reuse_saved_credentials)?;
        if runtime::has_dirty_cache(&runtime::cache_dir(old)?)? {return Err("旧缓存有未上传修改，请先用原配置恢复挂载".into());}
        // A new storage identity must never reuse cached objects from a previous endpoint.
        if old.endpoint!=input.endpoint || old.provider!=input.provider || old.bucket!=input.bucket || old.prefix!=input.prefix
            || old.alipan_app_id!=input.alipan_app_id || old.alipan_drive!=input.alipan_drive {
            let previous=input.id.clone();
            input.id=uuid::Uuid::new_v4().to_string();
            all.retain(|c|c.id!=previous);
        }
    } else if all.len()>=50 {return Err("最多保存 50 个云盘连接".into());}
    model::validate(&input)?;
    if all.iter().any(|c|c.id!=input.id && c.mount_point.eq_ignore_ascii_case(&input.mount_point)) {
        return Err("此挂载目标已分配给其他连接".into());
    }
    all.retain(|c|c.id!=input.id);all.push(input);model::persist(&all)?;
    if !previous_id.is_empty() {super::alipan_dav::stop(&previous_id);}
    Ok(())
}
pub async fn cloud_drive_remove(state:State<'_,DriveStore>,id:String)->Result<(),String> {
    let _lock=state.operations.lock().await;
    let c=model::find(&id)?;
    if runtime::sessions()?.iter().any(|s|s.id==id) || runtime::has_dirty_cache(&runtime::cache_dir(&c)?)? {
        return Err("请先安全卸载并完成缓存恢复，不能删除此配置".into());
    }
    let mut all=model::load()?;all.retain(|c|c.id!=id);model::persist(&all)?;
    super::alipan_dav::stop(&id);Ok(())
    // Intentionally retain cached files; removing a connection never deletes local or remote data.
}
pub async fn cloud_drive_probe(_state:State<'_,DriveStore>,id:String,kind:String)->Result<Vec<String>,String> {
    dependency::require()?;
    // Read an atomic persisted snapshot. A read-only diagnostic must not queue
    // behind a stalled filesystem mount or prevent a recovery operation.
    if !["test","buckets","directories"].contains(&kind.as_str()){return Err("无效的连接检查类型".into());}
    let c=model::find(&id)?;
    if c.provider=="Alipan" {
        super::alipan::credentials(&c)?;
        super::alipan_dav::ensure(&c.id,runtime::sessions()?.iter().find(|s|s.id==c.id).and_then(|s|s.bridge.as_ref())).await?;
    }
    tauri::async_runtime::spawn_blocking(move ||runtime::probe(&c,kind=="buckets")).await.map_err(|_|"连接检查任务失败")?
}
pub async fn cloud_drive_list_buckets(mut input:model::Connection,clear_session_token:bool,reuse_saved_credentials:bool)->Result<Vec<String>,String> {
    dependency::require()?;
    if !input.id.is_empty() {
        let old=model::find(&input.id)?;
        merge_saved_credentials(&mut input,&old,clear_session_token,reuse_saved_credentials)?;
    } else if clear_session_token {input.session_token.clear();}
    // Listing uses only service settings, without saving or requiring a bucket/mount target.
    model::validate_service(&input)?;
    tauri::async_runtime::spawn_blocking(move ||runtime::probe(&input,true)).await.map_err(|_|"连接检查任务失败")?
}
pub async fn cloud_drive_mount(state:State<'_,DriveStore>,id:String)->Result<(),String> {
    let _lock=state.operations.lock().await;
    let c=model::find(&id)?;model::validate(&c)?;
    let result=runtime::mount(&c).await;
    let mut errors=state.errors.lock().map_err(|_|"云盘状态不可用")?;
    if let Err(error)=&result{errors.insert(id,error.clone());}else{errors.remove(&id);}
    result
}
pub async fn cloud_drive_unmount(state:State<'_,DriveStore>,id:String)->Result<(),String> {
    let _lock=state.operations.lock().await;
    runtime::unmount(&id).await
}
pub async fn cloud_drive_suspend(state:State<'_,DriveStore>,id:String)->Result<(),String> {
    let _lock=state.operations.lock().await;
    runtime::suspend(&id).await
}
/// Credential repair keeps storage identity and cached objects unchanged.
pub async fn cloud_drive_credentials(state:State<'_,DriveStore>,id:String,access_key_id:String,secret_key:String,session_token:String)->Result<(),String> {
    let access_key_id=zeroize::Zeroizing::new(access_key_id);
    let secret_key=zeroize::Zeroizing::new(secret_key);
    let session_token=zeroize::Zeroizing::new(session_token);
    dependency::require()?;
    let _lock=state.operations.lock().await;
    if runtime::sessions()?.iter().any(|s|s.id==id && runtime::pid_exists(s.pid)) {
        return Err("请先关闭使用云盘的程序，选择保留缓存停止，再更新凭据".into());
    }
    let mut all=model::load()?;
    let c=all.iter_mut().find(|c|c.id==id).ok_or("云盘连接不存在")?;
    if c.provider=="Alipan" {return Err(super::alipan::AUTH_ERROR.into());}
    c.access_key_id=access_key_id.to_string();c.secret_key=secret_key.to_string();c.session_token=session_token.to_string();
    model::validate(c)?;
    model::persist(&all)
}
/// Explicit native-only reveal; never include the secret in periodic snapshots.
pub async fn cloud_drive_reveal_secret(state:State<'_,DriveStore>,id:String)->Result<String,String> {
    dependency::require()?;
    let _lock=state.operations.lock().await;
    Ok(model::find(&id)?.secret_key.clone())
}
/// Clear only a dead and clean session, never a process with an ambiguous RC response.
pub async fn cloud_drive_clear_recovery(state:State<'_,DriveStore>,id:String)->Result<(),String> {
    let _lock=state.operations.lock().await;
    let mut sessions=runtime::sessions()?;
    let s=sessions.iter().find(|s|s.id==id).ok_or("恢复记录不存在")?;
    if runtime::pid_exists(s.pid)||runtime::has_dirty_cache(&s.cache_dir)? {return Err("进程仍存在或缓存尚未上传，请先恢复挂载并安全卸载".into());}
    sessions.retain(|s|s.id!=id);runtime::save_sessions(&sessions)?;
    state.errors.lock().map_err(|_|"云盘状态不可用")?.remove(&id);
    Ok(())
}
pub async fn cloud_drive_open(app:tauri::AppHandle,state:State<'_,DriveStore>,id:String)->Result<(),String> {
    let _lock=state.operations.lock().await;
    let session=runtime::sessions()?.into_iter().find(|s|s.id==id).ok_or("请先挂载云盘")?;
    if runtime::status(&session).await.phase!="mounted" {return Err("挂载状态不可确认，不能打开磁盘".into());}
    app.opener().open_path(format!("{}{}",session.mount_point,if session.mount_point.len()==2 {"\\"}else{""}),None::<&str>)
        .map_err(|_|"无法打开挂载目录".into())
}
pub fn cloud_drive_winfsp(app:tauri::AppHandle)->Result<(),String> {
    dependency::require()?;
    let url=if cfg!(target_os="macos"){"https://macfuse.github.io/"}else if cfg!(target_os="linux"){"https://rclone.org/commands/rclone_mount/#mounting-on-linux"}else{"https://winfsp.dev/rel/"};
    app.opener().open_url(url,None::<&str>).map_err(|_|"无法打开挂载驱动安装说明".into())
}
pub async fn cloud_drive_select_cache(app:tauri::AppHandle)->Result<Option<String>,String> {
    use tauri_plugin_dialog::DialogExt;
    dependency::require()?;
    tauri::async_runtime::spawn_blocking(move ||app.dialog().file().blocking_pick_folder().map(|p|p.into_path()
        .map(|p|p.to_string_lossy().into_owned()).map_err(|_|"请选择本机目录".to_owned())).transpose())
        .await.map_err(|_|"目录选择失败")?
}
pub fn prepare_import(app: &tauri::AppHandle) -> Result<serde_json::Value,String> {
    *PENDING_IMPORT.lock().map_err(|_| "导入状态不可用")?=None;
    let Some(file)=app.dialog().file().add_filter("云盘 JSON", &["json"]).blocking_pick_file() else {return Ok(serde_json::Value::Null)};
    let path=file.into_path().map_err(|_| "导入路径无效")?;
    let metadata=std::fs::symlink_metadata(&path).map_err(|_| "无法读取导入文件")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() as usize > MAX_TRANSFER {return Err("请选择不超过 8 MB 的普通 JSON 文件".into())}
    let bytes=std::fs::read(&path).map_err(|_| "无法读取导入文件")?;
    let mut package:TransferPackage=serde_json::from_slice(&bytes).map_err(|_| "文件格式无效，请选择 CloudHub 云盘导出文件")?;
    if package.format!="cloudhub-cloud-drive" || package.version!=1 || package.connections.is_empty() || package.connections.len()>500 {return Err("文件版本或连接数量无效（支持 1–500 条）".into())}
    for c in &mut package.connections {c.alipan_auth=None;model::validate(c)?;}
    let token=uuid::Uuid::new_v4().to_string();
    let summaries=package.connections.iter().enumerate().map(|(index,c)|serde_json::json!({"index":index,"name":c.name,"provider":c.provider,"endpoint":c.endpoint,"bucket":c.bucket,"mountPoint":c.mount_point})).collect::<Vec<_>>();
    *PENDING_IMPORT.lock().map_err(|_| "导入状态不可用")?=Some((token.clone(),package.connections));
    Ok(serde_json::json!({"token":token,"connections":summaries}))
}
pub fn import_selected(token:&str,indices:&[usize])->Result<serde_json::Value,String> {
    if indices.is_empty() || indices.len()>500 {return Err("请选择要导入的云盘连接".into())}
    let mut pending=PENDING_IMPORT.lock().map_err(|_| "导入状态不可用")?;
    let (saved_token,incoming)=pending.as_ref().ok_or("导入预览已失效，请重新选择文件")?;
    if saved_token!=token {return Err("导入预览已失效，请重新选择文件".into())}
    let mut all=model::load()?; let mut seen=std::collections::HashSet::new(); let mut imported=0usize;
    for index in indices {
        if !seen.insert(index){return Err("导入选择包含重复项".into())}
        let mut c=incoming.get(*index).ok_or("导入选择已失效")?.clone();
        if all.iter().any(|old|old.provider==c.provider && old.endpoint==c.endpoint && old.bucket==c.bucket && old.prefix==c.prefix && old.access_key_id==c.access_key_id
            && old.alipan_app_id==c.alipan_app_id && old.alipan_drive==c.alipan_drive){continue}
        c.id=uuid::Uuid::new_v4().to_string();
        if all.iter().any(|old|old.mount_point.eq_ignore_ascii_case(&c.mount_point)){return Err("导入连接的挂载目标与现有配置冲突，请先调整挂载目标后再导入".into())}
        model::validate(&c)?; all.push(c); imported+=1;
    }
    if all.len()>50{return Err("导入后云盘连接不能超过 50 个".into())}
    model::persist(&all)?; *pending=None;
    Ok(serde_json::json!({"imported":imported,"skipped":indices.len()-imported}))
}
pub fn export_selected(app:&tauri::AppHandle,ids:&[String],acknowledge_plain:bool)->Result<bool,String> {
    if !acknowledge_plain{return Err("导出明文云盘密钥前必须确认风险".into())}
    if ids.is_empty() || ids.len()>500{return Err("请选择 1–500 个云盘连接导出".into())}
    let all=model::load()?; let mut selected=Vec::new(); let mut seen=std::collections::HashSet::new();
    for id in ids {if !seen.insert(id){return Err("选择包含重复记录".into())} let c=all.iter().find(|c|&c.id==id).ok_or("所选云盘连接不存在，请刷新后重试")?; selected.push(c.clone());}
    // Public-client OAuth grants stay on this device; imported profiles must authorize afresh.
    for c in &mut selected {c.alipan_auth=None;}
    let Some(file)=app.dialog().file().set_file_name("cloudhub-cloud-drive.json").add_filter("云盘 JSON（含明文密钥）", &["json"]).blocking_save_file() else {return Ok(false)};
    let path=file.into_path().map_err(|_| "导出路径无效")?; let bytes=zeroize::Zeroizing::new(serde_json::to_vec_pretty(&TransferPackage{format:"cloudhub-cloud-drive".into(),version:1,connections:selected}).map_err(|_| "导出失败")?);
    if bytes.len()>MAX_TRANSFER{return Err("导出内容超过 8 MB，请分批导出".into())} std::fs::write(path,bytes.as_slice()).map_err(|_| "无法保存导出文件")?; Ok(true)
}
pub fn must_keep_running(app:&tauri::AppHandle)->bool {
    let state=app.state::<DriveStore>();
    state.operations.try_lock().is_err() || runtime::sessions().map(|s|!s.is_empty()).unwrap_or(true)
}
pub fn explain_exit(app:&tauri::AppHandle) {
    use tauri_plugin_dialog::DialogExt;
    app.dialog().message("云盘仍有挂载、操作或恢复记录。请在软件商店的“云盘挂载”中关闭使用云盘的程序，等待上传完成后安全卸载；缓存状态不明时不要强制退出。").title("请先安全卸载云盘").show(|_|{});
}
pub fn initialize(app:tauri::AppHandle) {
    if !dependency::supported(){return;}
    tauri::async_runtime::spawn(async move {
        let state=app.state::<DriveStore>();let _lock=state.operations.lock().await;
        // Restore the authenticated loopback endpoint before an orphaned rclone can resume its cache.
        if let Ok(sessions)=runtime::sessions() {
            for session in sessions {
                if let Some(bridge)=&session.bridge {
                    if let Err(error)=super::alipan_dav::ensure(&session.id,Some(bridge)).await {if let Ok(mut errors)=state.errors.lock(){errors.insert(session.id,error);}}
                }
            }
        }
        let Ok(connections)=model::load()else{return;};
        for c in connections.into_iter().filter(|c|c.auto_mount) {
            // Existing journal entries are shown for explicit recovery, not silently duplicated.
            if runtime::sessions().map(|s|s.iter().any(|s|s.id==c.id)).unwrap_or(true){continue;}
            if let Err(error)=runtime::mount(&c).await {if let Ok(mut errors)=state.errors.lock(){errors.insert(c.id.clone(),error);}}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture()->model::Connection {
        model::Connection {id:uuid::Uuid::new_v4().to_string(),name:"测试".into(),provider:"Alibaba".into(),
            endpoint:"https://storage.example.test".into(),region:String::new(),bucket:"sample-bucket".into(),prefix:String::new(),
            access_key_id:uuid::Uuid::new_v4().to_string(),secret_key:uuid::Uuid::new_v4().to_string(),session_token:uuid::Uuid::new_v4().to_string(),
            path_style:false,mount_point:"O:".into(),read_only:true,auto_mount:false,cache_dir:String::new(),cache_gib:10,
            alipan_app_id:String::new(),alipan_drive:String::new(),alipan_auth:None}
    }
    #[test]
    fn saved_credentials_require_confirmation_for_destination_changes() {
        let old=fixture();
        for change_provider in [false,true] {
            let mut input=old.clone();input.secret_key.clear();input.session_token.clear();
            if change_provider {input.provider="Other".into();} else {input.endpoint="https://new.example.test".into();}
            assert!(merge_saved_credentials(&mut input,&old,false,false).is_err());
            assert!(input.secret_key.is_empty());
            assert!(merge_saved_credentials(&mut input,&old,false,true).is_ok());
            assert!(input.secret_key==old.secret_key && input.session_token==old.session_token);
        }
    }
    #[test]
    fn saved_credentials_preserve_unchanged_inputs_and_honor_token_clear() {
        let old=fixture();let mut input=old.clone();input.secret_key.clear();input.session_token.clear();
        assert!(merge_saved_credentials(&mut input,&old,false,false).is_ok());
        assert!(input.secret_key==old.secret_key && input.session_token==old.session_token);
        assert!(merge_saved_credentials(&mut input,&old,true,false).is_ok());
        assert!(input.session_token.is_empty());
    }
    #[test]
    fn changed_key_id_never_inherits_old_secret_or_session_token() {
        let old=fixture();let mut input=old.clone();input.access_key_id=uuid::Uuid::new_v4().to_string();
        input.secret_key.clear();input.session_token.clear();
        assert!(merge_saved_credentials(&mut input,&old,false,true).is_err());
        input.secret_key=uuid::Uuid::new_v4().to_string();
        assert!(merge_saved_credentials(&mut input,&old,false,true).is_ok());
        assert!(input.secret_key!=old.secret_key && input.session_token.is_empty());
    }
}
