use crate::core::{codex::{config_history as history, profile, target_lock::{canonical_home,TargetLock}, AUTH_WRITER}, error::PlatformResult, storage::open_db};
use serde::{Deserialize,Serialize};
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct HistoryTarget { id:Option<String>, name:String, home:String, version:String, pending:bool }
#[derive(Serialize)]
pub(crate) struct HistoryState { entries:Vec<history::HistoryEntry>, targets:Vec<HistoryTarget> }

fn state(store:&super::codex_runtime::CodexRuntimeStore)->Result<HistoryState,String> {
    let conn=open_db()?;
    history::migrate_legacy(&conn)?;
    let mut targets=Vec::new();
    let home=super::codex_instances::config_home(store,None,false)?;
    let preview=super::codex_providers::history_preview(&conn,&home,None)?;
    targets.push(HistoryTarget{id:None,name:"默认 Codex 客户端".into(),home:canonical_home(&home)?,version:preview.version,pending:preview.recovery_pending});
    let mut stmt=conn.prepare("SELECT id,name FROM codex_profiles ORDER BY created_at,id").map_err(|_| "读取 Codex 备份目标失败")?;
    let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|_| "读取 Codex 备份目标失败")?;
    for row in rows {
        let (id,name)=row.map_err(|_| "读取 Codex 备份目标失败")?;
        let home=super::codex_instances::config_home(store,Some(&id),false)?;
        let preview=super::codex_providers::history_preview(&conn,&home,Some(&id))?;
        targets.push(HistoryTarget{id:Some(id),name,home:canonical_home(&home)?,version:preview.version,pending:preview.recovery_pending});
    }
    Ok(HistoryState{entries:history::list(&conn)?,targets})
}

#[tauri::command]
pub(crate) async fn codex_history_list(app:tauri::AppHandle)->PlatformResult<HistoryState> {
    tauri::async_runtime::spawn_blocking(move||{
        let _writer=AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        state(&app.state::<super::codex_runtime::CodexRuntimeStore>())
    }).await.map_err(|_| "读取 Codex 备份历史任务失败")?.map_err(Into::into)
}

#[derive(Deserialize)]
#[serde(rename_all="snake_case")]
pub(crate) enum HistoryAction { Manual, Restore, Recover, Pin, Delete }

#[tauri::command]
pub(crate) async fn codex_history_action(app:tauri::AppHandle,action:HistoryAction,target:Option<String>,snapshot_id:Option<String>,version:Option<String>,pinned:Option<bool>)->PlatformResult<HistoryState> {
    tauri::async_runtime::spawn_blocking(move||->Result<HistoryState,String>{
        let _writer=AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        let store=app.state::<super::codex_runtime::CodexRuntimeStore>();
        let mut conn=open_db()?;
        if matches!(action,HistoryAction::Pin|HistoryAction::Delete) {
            history::update(&conn,snapshot_id.as_deref().ok_or("请选择 Codex 历史备份")?,if matches!(action,HistoryAction::Pin){Some(pinned.ok_or("请选择 Codex 历史备份")?)}else{None})?;
            return state(&store);
        }
        let home=super::codex_instances::config_home(&store,target.as_deref(),true)?;
        let _target=TargetLock::acquire(&home)?;
        profile::ensure_file_storage(&home)?;
        let preview=super::codex_providers::history_preview(&conn,&home,target.as_deref())?;
        if version.as_deref()!=Some(preview.version.as_str()) {return Err("目标配置已变更，请重新预览".into());}
        history::migrate_legacy(&conn)?;
        match action {
            HistoryAction::Manual=>history::manual(&conn,&home,target.as_deref())?,
            HistoryAction::Recover=>{
                if history::pending(&conn,&home)? {history::recover(&mut conn,&home)?;}
                else {super::codex_providers::recover_legacy(&store,&home,target.as_deref())?;}
                store.provider_gateways.lock().map_err(|_| "供应商网关状态不可用")?.remove(home.to_string_lossy().as_ref());
            },
            HistoryAction::Restore=>{
                history::ensure_ready(&conn,&home)?;
                crate::core::codex::provider_oauth::sync_before_replace(&conn,&home)?;
                let operation_version=history::version(&conn,&home,target.as_deref())?;
                let mut snapshot=history::load(&conn,snapshot_id.as_deref().ok_or("请选择 Codex 历史备份")?,&home)?;
                history::prepare_restore(&conn,&home,target.as_deref(),&mut snapshot)?;
                for account in snapshot.referenced_accounts() {
                    if super::codex_instances::account_running_except_target(&store,account,&home)? {return Err("OAuth 账号已被其他实例、服务或供应商占用".into());}
                }
                if target.is_some() {
                    if let Ok(identity)=crate::core::codex::provider_oauth::validate(snapshot.file("auth.json").unwrap_or_default()) {
                        if profile::default_home().ok().and_then(|h|profile::read_auth(&h.join("auth.json")).ok()).and_then(|s|crate::core::codex::provider_oauth::validate(&s).ok()).is_some_and(|v|v==identity) {return Err("此 OAuth 账号由默认客户端管理，请先切换默认登录或选择默认目标".into());}
                    }
                }
                let gateway=super::codex_providers::rebuild_history_gateway(&conn,&mut snapshot)?;
                history::execute_checked(&mut conn,&home,target.as_deref(),"restore",Some(&operation_version),snapshot.files.clone(),|tx|{
                    history::restore_bindings(tx,&home,&snapshot)?;
                    history::restore_managed_account(tx,&snapshot)
                })?;
                let mut gateways=store.provider_gateways.lock().map_err(|_| "供应商网关状态不可用")?;
                gateways.remove(home.to_string_lossy().as_ref());
                if let Some(gateway)=gateway {gateways.insert(home.to_string_lossy().into_owned(),gateway);}
            },
            _=>unreachable!(),
        }
        state(&store)
    }).await.map_err(|_| "处理 Codex 备份历史任务失败")?.map_err(Into::into)
}
