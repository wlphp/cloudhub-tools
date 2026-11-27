use crate::core::{claude_gateway as gateway,claude_providers as model,database::open_db,error::PlatformResult,repositories::claude_providers as repo};
use serde::{Deserialize,Serialize};
use serde_json::Value;
#[path = "claude_provider_transfer.rs"]
mod transfer;
#[path = "claude_provider_balance.rs"]
mod balance;
#[path = "claude_provider_quota.rs"]
mod quota;

#[tauri::command]
pub async fn claude_desktop_action(action: crate::core::claude_desktop::Action) -> PlatformResult<Value> {
    crate::core::claude_desktop::action(action).await.map_err(Into::into)
}

#[tauri::command]
pub async fn claude_routing_state()->PlatformResult<gateway::Snapshot>{gateway::snapshot().await.map_err(Into::into)}
#[tauri::command]
pub async fn claude_routing_save(config:gateway::Config)->PlatformResult<()>{gateway::save_config(config).await.map_err(Into::into)}
#[tauri::command]
pub async fn claude_routing_activate(mode:gateway::Mode)->PlatformResult<()>{gateway::activate(mode).await.map_err(Into::into)}
#[tauri::command]
pub async fn claude_routing_clear_logs()->PlatformResult<()>{gateway::clear_logs().await.map_err(Into::into)}

#[derive(Deserialize)]
#[serde(tag="type",rename_all="snake_case",deny_unknown_fields)]
pub enum ProviderAction{
    Usage{id:String,adapter:String},
    Quota{id:String},
    Balance{id:String},
    Duplicate{id:String},
    Move{id:String,offset:i64},
    ImportCurrent,
    OpenConfigDirectory,
    PrepareImport,
    CancelImport,
    ImportSelected { token: String, indices: Vec<usize> },
    ExportSelected { ids: Vec<String> },
    DeleteSelected { ids: Vec<String> },
}
#[tauri::command]
pub async fn claude_provider_action(app:tauri::AppHandle,action:ProviderAction)->PlatformResult<Value>{
    // Import preview/cancel must not depend on decrypting the existing provider
    // list; otherwise one unreadable key prevents the file picker from opening.
    if matches!(&action, ProviderAction::PrepareImport | ProviderAction::CancelImport) {
        return tauri::async_runtime::spawn_blocking(move || match action {
            ProviderAction::PrepareImport => transfer::prepare(&app),
            ProviderAction::CancelImport => transfer::cancel(),
            _ => unreachable!(),
        }).await.map_err(|_|crate::core::error::PlatformError::from("供应商任务失败"))?;
    }
    if let ProviderAction::Usage { id, adapter } = &action {
        let id = id.clone();
        let p = tauri::async_runtime::spawn_blocking(move || provider(&id))
            .await.map_err(|_| "读取供应商额度参数失败")??;
        if p.official_login || p.api_key.trim().is_empty() {
            return Err("请先配置供应商 API Key；官方登录不支持此额度接口".into());
        }
        let key = zeroize::Zeroizing::new(p.api_key);
        let usage = crate::core::codex::provider_usage::query(&p.base_url, &key, adapter).await?;
        return serde_json::to_value(usage).map_err(|_| "额度结果不可用".into());
    }
    if let ProviderAction::Quota { id } = &action {
        return quota::query(provider(id)?).await;
    }
    if let ProviderAction::Balance { id } = &action {
        return balance::query(provider(id)?).await;
    }
    if let ProviderAction::DeleteSelected { ids } = &action {
        for id in ids {
            if gateway::in_use(id).await {
                return Err(transfer::error("无法批量删除：所选供应商仍在路由或聚合名单中，请先移除；未删除任何记录"));
            }
        }
    }
    tauri::async_runtime::spawn_blocking(move||->PlatformResult<Value>{
        let _writer=gateway::CONFIG_WRITER.lock().map_err(|_|"配置正在使用")?;
        let conn=open_db()?;
        if let ProviderAction::DeleteSelected{ids}=&action {
            return transfer::delete(&conn,ids);
        }
        let providers=repo::list_providers(&conn)?;
        match action{
            ProviderAction::Usage{..}|ProviderAction::Balance{..}|ProviderAction::Quota{..}=>return Err("额度请求不可用".into()),
            ProviderAction::PrepareImport=>return transfer::prepare(&app),
            ProviderAction::CancelImport=>return transfer::cancel(),
            ProviderAction::ImportSelected{token,indices}=>return transfer::import(&conn,&token,&indices),
            ProviderAction::ExportSelected{ids}=>return transfer::export(&app,&providers,&ids),
            ProviderAction::DeleteSelected{..}=>unreachable!(),
            ProviderAction::OpenConfigDirectory=>{
                let path=repo::settings_path()?;
                let directory=path.parent().ok_or("无法确定配置目录")?;
                std::fs::create_dir_all(directory).map_err(|_|"无法创建配置目录")?;
                tauri_plugin_opener::open_path(directory, None::<&str>).map_err(|_|"无法打开配置目录")?;
            }
            ProviderAction::Duplicate{id}=>{
                let mut p=providers.into_iter().find(|p|p.id==id).ok_or("供应商不存在")?;
                p.id=format!("custom-{}",uuid::Uuid::new_v4());p.name=format!("{} 副本",p.name);
                repo::save_provider(&conn,&p,chrono::Utc::now().timestamp_millis())?;
            }
            ProviderAction::Move{id,offset}=>{
                if !matches!(offset,-1|1){return Err("排序方向无效".into());}
                let pos=providers.iter().position(|p|p.id==id).ok_or("供应商不存在")?;
                let target=pos as i64+offset;
                if target<0||target>=providers.len() as i64{return Ok(Value::Null);}
                let mut ids=providers.iter().map(|p|p.id.clone()).collect::<Vec<_>>();ids.swap(pos,target as usize);
                let tx=conn.unchecked_transaction().map_err(|_|"无法保存排序")?;
                for (index,id) in ids.iter().enumerate(){tx.execute("UPDATE claude_providers SET sort_index=?1 WHERE id=?2",rusqlite::params![index as i64,id]).map_err(|_|"保存排序失败")?;}
                tx.commit().map_err(|_|"保存排序失败")?;
            }
            ProviderAction::ImportCurrent=>{
                let path=repo::settings_path()?;
                if !path.is_file(){return Err("尚未找到本机 Claude Code 配置，请先登录 Claude Code 或选择正确的配置目录".into());}
                let live=repo::read_settings_at(&path)?;let env=live["env"].as_object().cloned().unwrap_or_default();
                let base=env.get("ANTHROPIC_BASE_URL").and_then(Value::as_str).unwrap_or("");
                if base.starts_with("http://127.0.0.1:")&&["ANTHROPIC_AUTH_TOKEN","ANTHROPIC_API_KEY"].iter().any(|key|env.get(*key).and_then(Value::as_str).is_some_and(|s|s=="PROXY_MANAGED"||s.starts_with("cloudhub-local-"))){return Err("请先回到直连再导入配置".into());}
                let key=env.get("ANTHROPIC_API_KEY").or_else(||env.get("ANTHROPIC_AUTH_TOKEN")).and_then(Value::as_str).unwrap_or("");
                let p=model::ClaudeProvider{id:format!("imported-{}",uuid::Uuid::new_v4()),name:"当前 Claude Code 配置".into(),description:String::new(),website_url:String::new(),base_url:if base.is_empty(){"https://api.anthropic.com".into()}else{base.into()},api_key:key.into(),api_key_field:if env.contains_key("ANTHROPIC_API_KEY"){model::ApiKeyField::ApiKey}else{model::ApiKeyField::AuthToken},api_format:model::ApiFormat::Anthropic,is_full_url:false,models:model::models_from_env(&env),extra_env:serde_json::Map::new(),official_login:key.is_empty()&&base.is_empty(),model_catalog:Vec::new(),user_agent:String::new(),proxy_header_override:serde_json::Value::Null,proxy_body_override:serde_json::Value::Null,fallback_model:None};
                if let Some(existing)=providers.iter().find(|existing|
                    existing.base_url.trim_end_matches('/') == p.base_url.trim_end_matches('/')
                    && existing.api_key == p.api_key
                    && existing.api_key_field == p.api_key_field
                    && existing.api_format == p.api_format
                    && existing.official_login == p.official_login
                    && existing.models == p.models
                ) {
                    return Err(crate::core::error::PlatformError {
                        kind: "platform-error",
                        code: "claude-provider-duplicate",
                        message: format!("无法重复导入：与已保存的供应商「{}」（ID：{}）配置相同，请直接使用或编辑该记录。相同项：请求地址、API Key、认证方式、协议、官方登录状态和模型映射。", existing.name, existing.id),
                        retryable: false,
                    });
                }
                repo::save_provider(&conn,&p,chrono::Utc::now().timestamp_millis())?;
            }
        }Ok(Value::Null)
    }).await.map_err(|_|crate::core::error::PlatformError::from("供应商任务失败"))?
}
fn provider(id:&str)->Result<model::ClaudeProvider,String>{repo::list_providers(&open_db()?)?.into_iter().find(|p|p.id==id).ok_or("供应商不存在".into())}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Probe{pub reachable:bool,pub status:Option<u16>,pub latency_ms:u64}
#[tauri::command]
pub async fn claude_provider_probe(id:String)->PlatformResult<Probe>{
    let p=provider(&id)?;let url=gateway::validate_url(&p.base_url)?;
    let client=reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(std::time::Duration::from_secs(15)).build().map_err(|_|"无法初始化连接检测")?;
    let started=std::time::Instant::now();
    // Connectivity only: never send credentials or billable inference in a probe.
    let result=client.head(url).send().await;
    Ok(Probe{reachable:result.is_ok(),status:result.ok().map(|r|r.status().as_u16()),latency_ms:started.elapsed().as_millis() as u64})
}
#[tauri::command]
pub async fn claude_provider_models(id:String,draft:Option<model::ClaudeProvider>)->PlatformResult<Vec<model::ModelMapping>>{
    let p=if let Some(mut draft)=draft {
        if draft.api_key.trim().is_empty() && !id.is_empty() {
            let saved = provider(&id)?;
            if draft.base_url.trim().trim_end_matches('/') != saved.base_url.trim().trim_end_matches('/')
                || draft.api_format != saved.api_format
            {
                return Err("修改地址或协议后，请重新填写 API Key 再查询".into());
            }
            draft.api_key=saved.api_key;
        }
        draft
    } else { provider(&id)? };
    crate::core::claude_desktop::query_provider_models(&p).await.map_err(Into::into)
}

#[tauri::command]
pub async fn claude_workspace_state()->PlatformResult<crate::core::claude_workspace::Snapshot>{
    tauri::async_runtime::spawn_blocking(||{
        let _writer=gateway::CONFIG_WRITER.lock().map_err(|_|"配置正在使用")?;
        crate::core::claude_workspace::snapshot()
    }).await.map_err(|_|"读取 Claude 工作区失败".to_string())?.map_err(Into::into)
}
#[tauri::command]
pub async fn claude_workspace_action(action:crate::core::claude_workspace::Action)->PlatformResult<()>{
    tauri::async_runtime::spawn_blocking(move||{
        let _writer=gateway::CONFIG_WRITER.lock().map_err(|_|"配置正在使用")?;
        crate::core::claude_workspace::act(action)
    }).await.map_err(|_|"Claude 工作区操作失败".to_string())?.map_err(Into::into)
}
#[tauri::command]
pub async fn claude_workspace_project(app:tauri::AppHandle,clear:bool,config_directory:Option<bool>)->PlatformResult<Option<String>>{
    let config_directory=config_directory.unwrap_or(false);
    if gateway::snapshot().await?.running{return Err(if config_directory{"请先回到直连再切换配置目录"}else{"请先回到直连再切换项目"}.into());}
    let selection=tauri::async_runtime::spawn_blocking(move||->Result<Option<Option<std::path::PathBuf>>,String>{
        use tauri_plugin_dialog::DialogExt;
        let path=if clear{None}else{
            let Some(selected)=app.dialog().file().set_title(if config_directory{"选择 Claude Code 配置目录"}else{"选择 Claude Code 项目目录"}).blocking_pick_folder()else{return Ok(None);};
            Some(selected.into_path().map_err(|_|"项目目录无效")?)
        };
        Ok(Some(path))
    }).await.map_err(|_|"选择项目失败".to_string())??;
    let Some(path)=selection else{return Ok(None);};
    if config_directory{gateway::change_config_directory(path.clone()).await?;}else{gateway::change_project(path.clone()).await?;}
    Ok(path.map(|p|p.to_string_lossy().to_string()))
}
#[tauri::command]
pub async fn claude_skill_install(app:tauri::AppHandle)->PlatformResult<bool>{
    tauri::async_runtime::spawn_blocking(move||->Result<bool,String>{
        use tauri_plugin_dialog::DialogExt;
        let Some(selected)=app.dialog().file().set_title("选择包含 SKILL.md 的技能文件夹").blocking_pick_folder()else{return Ok(false);};
        let _writer=gateway::CONFIG_WRITER.lock().map_err(|_|"配置正在使用")?;
        crate::core::claude_workspace::install_skill(selected.into_path().map_err(|_|"技能目录无效")?)?;Ok(true)
    }).await.map_err(|_|"安装技能失败".to_string())?.map_err(Into::into)
}
#[tauri::command]
pub async fn claude_session_preview(key:String)->PlatformResult<String>{
    tauri::async_runtime::spawn_blocking(move||crate::core::claude_workspace::session_preview(&key)).await.map_err(|_|"读取会话失败".to_string())?.map_err(Into::into)
}

/// 把指定供应商切换为当前直连（备份 → 合并写入 → 标记生效），再启动 Claude Code CLI。
///
/// 桌面端专用，浏览器端直接返回错误；`claude` 命令由 PATH 解析，找不到就把报错抛出。
#[tauri::command]
pub async fn claude_launch_cli(id:String)->PlatformResult<()>{
    #[cfg(not(desktop))]
    {
        let _=id;
        return Err("启动 Claude Code 只能在桌面端进行".into());
    }
    #[cfg(desktop)]
    {
        // 先把目标供应商写入 settings.json（会备份原文件并标记为当前）。
        crate::commands::claude_providers::claude_provider_switch(id.clone()).await?;
        // 不在路由/聚合模式下启动：避免 settings.json 被回环接管覆盖。
        if gateway::snapshot().await?.running{return Err("本地路由或聚合已接管设置，请先回到直连再启动 Claude Code".into());}
        tauri::async_runtime::spawn_blocking(move||->Result<(),String>{
            use std::process::Command;
            // Windows 下若装了 `.cmd`（npm 全局包常见），优先尝试 `claude.cmd`。
            let mut cmd=Command::new("claude");
            cmd.env("CLAUDE_CONFIG_DIR",repo::claude_home()?);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                // 与现有 desktop_pet / wsl_dashboard 等一致：隐藏子进程自身控制台。
                cmd.creation_flags(0x08000000);
            }
            match cmd.spawn(){
                Ok(_child)=>Ok(()),
                Err(_)=>Err("找不到 claude 命令。请确认 Claude Code CLI 已安装并加入 PATH（可参考 npm i -g @anthropic-ai/claude-code 或官方安装说明）".into()),
            }
        }).await.map_err(|_|"启动 Claude Code 失败".to_string())??;
        Ok(())
    }
}
