use crate::core::{codex::providers::{self, Provider, ProviderInput}, error::PlatformResult, storage::open_db};
use crate::core::codex::{profile, provider_config::{self, ConfigPreview}};
use tauri::Manager;
use rusqlite::OptionalExtension;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub(crate) async fn codex_provider_import(app:tauri::AppHandle,action:String,token:Option<String>)->PlatformResult<Option<crate::core::codex::provider_import::ImportSummary>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<_,String> {
        use crate::core::codex::provider_import;
        let store=app.state::<super::codex_runtime::CodexRuntimeStore>();store.cleanup_expired();
        if action=="cancel" {
            let mut slot=store.provider_import.lock().map_err(|_| "导入状态不可用")?;
            if slot.as_ref().is_some_and(|v|Some(&v.token)==token.as_ref()){*slot=None;}return Ok(None);
        }
        if action=="confirm" {
            let _writer=super::codex::AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
            let draft={
                let mut slot=store.provider_import.lock().map_err(|_| "导入状态不可用")?;
                provider_import::take_draft(&mut slot,token.as_deref())?
            };
            provider_import::confirm(&mut open_db()?,&draft)?;return Ok(None);
        }
        if action!="prepare" {return Err("供应商导入操作无效".into());}
        let Some(file)=app.dialog().file().add_filter("供应商 JSON",&["json"]).blocking_pick_file() else{return Ok(None);};
        let path=file.into_path().map_err(|_| "导入文件路径无效")?;
        let metadata=std::fs::symlink_metadata(&path).map_err(|_| "读取导入文件失败")?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len()>2*1024*1024{return Err("供应商导入文件须为不超过 2 MB 的 JSON".into());}
        use std::io::Read;
        let mut text=zeroize::Zeroizing::new(String::new());std::fs::File::open(path).map_err(|_| "读取导入文件失败")?.take(2*1024*1024+1).read_to_string(&mut text).map_err(|_| "读取导入文件失败")?;
        let (draft,summary)=provider_import::prepare(&open_db()?,&text)?;
        *store.provider_import.lock().map_err(|_| "导入状态不可用")?=Some(draft);Ok(Some(summary))
    }).await.map_err(|_| "供应商导入任务失败")?.map_err(Into::into)
}

#[derive(serde::Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub(crate) struct ApplyProvider { provider_id:String, key_id:String, provider_version:Option<i64>, model:String, version:String, oauth_account_id:Option<i64> }

struct ApplyRoute {
    provider: Option<Provider>,
    owner_id: String,
    key_id: String,
    label: String,
    settings: crate::core::codex::providers::ModelSettings,
    base_url: String,
    auth_key: zeroize::Zeroizing<String>,
    gateway: Option<crate::core::codex::provider_gateway::ProviderGateway>,
    models_json: String,
}

fn resolve_apply_route(conn:&rusqlite::Connection,input:&ApplyProvider)->Result<ApplyRoute,String> {
    let local_key=zeroize::Zeroizing::new(uuid::Uuid::new_v4().to_string()+&uuid::Uuid::new_v4().to_string());
    if let Some(aggregate_id)=input.provider_id.strip_prefix("aggregate:") {
        if input.key_id!="aggregate" || input.oauth_account_id.is_some() {
            return Err("聚合配置暂不支持 OAuth 绑定".into());
        }
        let aggregate=crate::core::codex::provider_aggregate::list(conn)?.into_iter()
            .find(|v|v.id==aggregate_id && Some(v.version)==input.provider_version).ok_or("聚合供应商已被修改，请刷新后重试")?;
        if !aggregate.models.iter().any(|model|model==&input.model) {
            return Err("模型不在供应商目录中".into());
        }
        let providers=providers::list(conn)?;
        let mut members=Vec::new();
        for member in &aggregate.members {
            let provider=providers.iter().find(|v|v.id==member.provider_id).ok_or("聚合成员供应商不存在")?;
            let credential=providers::credential(conn,&member.provider_id,&member.key_id)?;
            members.push((member.key_id.clone(),provider.base_url.clone(),credential,member.models.clone(),member.weight));
        }
        let gateway=tauri::async_runtime::block_on(crate::core::codex::provider_gateway::ProviderGateway::start_aggregate(
            0,members,local_key.clone(),aggregate.strategy,
        ))?;
        return Ok(ApplyRoute {
            provider:None,
            owner_id:format!("aggregate:{aggregate_id}"),
            key_id:"aggregate".into(),
            label:aggregate.name,
            settings:crate::core::codex::providers::ModelSettings{models:aggregate.models.clone(),..Default::default()},
            base_url:format!("http://127.0.0.1:{}/v1",gateway.port),
            auth_key:local_key,
            gateway:Some(gateway),
            models_json:serde_json::to_string(&aggregate.models).map_err(|_| "聚合模型目录无效")?,
        });
    }
    let provider=providers::list(conn)?.into_iter()
        .find(|v|v.id==input.provider_id && Some(v.version)==input.provider_version)
        .ok_or("供应商已被修改，请刷新后重试")?;
    let key=provider.keys.iter().find(|v|v.id==input.key_id).ok_or("供应商密钥不存在")?;
    let settings=providers::effective_settings(&provider,key);
    if !settings.models.iter().any(|model|model==&input.model) {
        return Err("模型不在供应商目录中".into());
    }
    let upstream=providers::credential(conn,&provider.id,&input.key_id)?;
    let gateway=if provider.wire_api=="chat_completions" {
        Some(tauri::async_runtime::block_on(crate::core::codex::provider_gateway::ProviderGateway::start(
            0,provider.base_url.clone(),upstream.clone(),local_key.clone(),settings.models.clone(),
        ))?)
    } else {None};
    let (base_url,auth_key)=if let Some(gateway)=&gateway {
        (format!("http://127.0.0.1:{}/v1",gateway.port),local_key)
    } else {(provider.base_url.clone(),upstream)};
    Ok(ApplyRoute {
        label:format!("{} · {}",provider.name,key.name),
        owner_id:provider.id.clone(),
        key_id:input.key_id.clone(),
        models_json:serde_json::to_string(&settings.models).map_err(|_| "供应商模型目录无效")?,
        provider:Some(provider),
        settings,
        base_url,
        auth_key,
        gateway,
    })
}

#[tauri::command]
pub(crate) async fn codex_provider_usage(provider_id:String,key_id:String,version:i64,adapter:String)->PlatformResult<crate::core::codex::provider_usage::Usage> {
    let (provider,key)=tauri::async_runtime::spawn_blocking(move || -> Result<_,String> {
        let conn=open_db()?;
        let provider=providers::list(&conn)?.into_iter().find(|v|v.id==provider_id&&v.version==version).ok_or("供应商已被修改，请刷新后重试")?;
        let key=providers::credential(&conn,&provider_id,&key_id)?;Ok((provider,key))
    }).await.map_err(|_| "读取供应商额度参数失败")??;
    crate::core::codex::provider_usage::query(&provider.base_url,&key,&adapter).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_provider_models(input: ModelCatalogInput) -> PlatformResult<crate::core::codex::provider_probe::ProbeResult> {
    let (base,key)=tauri::async_runtime::spawn_blocking(move || resolve_model_catalog(input,|provider_id,key_id,version| {
        let conn=open_db()?;
        let provider=providers::list(&conn)?.into_iter().find(|v|v.id==provider_id && v.version==version).ok_or("供应商已被修改，请刷新后重试")?;
        if !provider.keys.iter().any(|key|key.id==key_id) {return Err("密钥已被修改，请刷新后重试".into());}
        providers::credential(&conn,provider_id,key_id)
    })).await.map_err(|_| "读取供应商请求参数失败")??;
    crate::core::codex::provider_probe::run(&base,"responses",&key,None).await.map_err(Into::into)
}

#[derive(serde::Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct ModelCatalogInput {
    base_url:String,
    provider_id:Option<String>,
    key_id:Option<String>,
    version:Option<i64>,
    secret:Option<String>,
}
impl Drop for ModelCatalogInput {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.secret.zeroize();
    }
}
fn resolve_model_catalog(
    input:ModelCatalogInput,
    load:impl FnOnce(&str,&str,i64)->Result<zeroize::Zeroizing<String>,String>,
)->Result<(String,zeroize::Zeroizing<String>),String> {
    if input.base_url.len()>2048 {return Err("供应商地址无效".into());}
    crate::core::codex::provider_probe::endpoint(&input.base_url,"models")?;
    let key=if let Some(secret)=&input.secret {
        if secret.trim().is_empty() || secret.len()>8192 || secret.chars().any(char::is_control) {
            return Err("供应商密钥格式无效".into());
        }
        zeroize::Zeroizing::new(secret.clone())
    } else {
        let (Some(provider_id),Some(key_id),Some(version))=(&input.provider_id,&input.key_id,input.version) else {
            return Err("请先填写 API Key 或选择已保存密钥".into());
        };
        if uuid::Uuid::parse_str(provider_id).is_err() || uuid::Uuid::parse_str(key_id).is_err() || version<1 {
            return Err("供应商标识无效".into());
        }
        load(provider_id,key_id,version)?
    };
    Ok((input.base_url.clone(),key))
}

#[tauri::command]
pub(crate) async fn codex_provider_probe(provider_id:String,key_id:String,version:i64,model:Option<String>) -> PlatformResult<crate::core::codex::provider_probe::ProbeResult> {
    let requested_model=model.clone();
    let (provider,key)=tauri::async_runtime::spawn_blocking(move || -> Result<_,String> {
        let conn=open_db()?;
        let provider=providers::list(&conn)?.into_iter().find(|v|v.id==provider_id && v.version==version).ok_or("供应商已被修改，请刷新后重试")?;
        let settings=providers::effective_settings(&provider,provider.keys.iter().find(|v|v.id==key_id).ok_or("供应商密钥不存在")?);
        if model.as_ref().is_some_and(|v|!settings.models.contains(v)) {return Err("模型不在供应商目录中".into());}
        let key=providers::credential(&conn,&provider_id,&key_id)?;
        Ok((provider,key))
    }).await.map_err(|_| "读取供应商请求参数失败")??;
    crate::core::codex::provider_probe::run(&provider.base_url,&provider.wire_api,&key,requested_model.as_deref()).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_provider_preview(app:tauri::AppHandle,id:Option<String>)->PlatformResult<ConfigPreview> {
    tauri::async_runtime::spawn_blocking(move || -> Result<ConfigPreview,String> {
        let _writer=super::codex::AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        let store=app.state::<super::codex_runtime::CodexRuntimeStore>();
        let home=super::codex_instances::config_home(&store,id.as_deref(),false)?;
        provider_config::preview(&open_db()?,&home)
    }).await.map_err(|_| "读取供应商配置任务失败")?.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_provider_apply(app:tauri::AppHandle,id:Option<String>,input:ApplyProvider)->PlatformResult<ConfigPreview> {
    tauri::async_runtime::spawn_blocking(move || -> Result<ConfigPreview,String> {
        let _writer=super::codex::AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        let store=app.state::<super::codex_runtime::CodexRuntimeStore>();
        let home=super::codex_instances::config_home(&store,id.as_deref(),true)?;
        profile::ensure_file_storage(&home)?;
        let mut conn=open_db()?;
        let preview=provider_config::preview(&conn,&home)?;
        if preview.version!=input.version {return Err("目标配置已变更，请重新预览".into());}
        if preview.has_backup {return Err("请先恢复上次供应商配置，再切换供应商".into());}
        let route=resolve_apply_route(&conn,&input)?;
        let api_auth=zeroize::Zeroizing::new(serde_json::json!({"auth_mode":"apikey","OPENAI_API_KEY":route.auth_key.as_str()}).to_string());
        let oauth_auth=if let Some(oauth_id)=input.oauth_account_id {
            if route.provider.is_none() {return Err("聚合配置暂不支持 OAuth 绑定".into());}
            if super::codex_instances::account_running(&store,oauth_id)? {return Err("OAuth 账号已被其他实例、服务或供应商占用".into());}
            let content=crate::core::repositories::codex_accounts::credentials(&conn,oauth_id)?;
            let identity=crate::core::codex::provider_oauth::validate(&content)?;
            if id.is_some() && profile::default_home().ok().and_then(|home|profile::read_auth(&home.join("auth.json")).ok()).and_then(|s|crate::core::codex::provider_oauth::validate(&s).ok()).is_some_and(|v|v==identity) {
                return Err("此 OAuth 账号由默认客户端管理，请先切换默认登录或选择默认目标".into());
            }
            if home.join("auth.json").exists() {
                let disk=profile::read_auth(&home.join("auth.json"))?;
                if crate::core::codex::provider_oauth::validate(&disk).ok()==Some(identity) && profile::fingerprint(Some(&disk))!=profile::fingerprint(Some(&content)) {
                    return Err("目标 OAuth 登录已更新，请先导入最新登录后重试".into());
                }
            }
            Some(content)
        } else {None};
        let auth=oauth_auth.as_ref().unwrap_or(&api_auth);
        let config=provider_config::build_config(&home,&route.base_url,&input.model,&route.settings,&route.auth_key,oauth_auth.is_some())?;
        let label=route.label.clone();
        // Different endpoints can deliberately use the same key; do not reclassify
        // an existing official API account or another provider's managed identity.
        let identity=format!("provider:{}:{}:{}",route.owner_id,route.key_id,profile::fingerprint(Some(home.to_string_lossy().as_ref())));
        if let Ok(account_id)=conn.query_row("SELECT id FROM codex_accounts WHERE identity=?1",[&identity],|r|r.get::<_,i64>(0)) {
            if super::codex_instances::account_running(&store,account_id)? {return Err("供应商账号正在使用，请先停止关联实例或服务".into());}
        }
        let previous_account_id=if let Some(id)=&id {Some(conn.query_row("SELECT account_id FROM codex_profiles WHERE id=?1",[id],|r|r.get::<_,i64>(0)).map_err(|_| "Codex 实例不存在")?)} else {None};
        if provider_config::preview(&conn,&home)?.version!=input.version {return Err("目标配置已变更，请重新预览".into());}
        let cipher=crate::core::storage::encrypt_secret(&api_auth).map_err(|_| "加密供应商账号失败")?;
        provider_config::install(&conn,&home,&input.version,&config,&auth)?;
        let bound=(|| -> Result<(),String> {
            let tx=conn.transaction().map_err(|_| "保存供应商绑定失败")?;
            tx.execute("INSERT INTO codex_accounts(identity,label,auth_mode,auth_ciphertext,updated_at) VALUES(?1,?2,'apikey',?3,?4) ON CONFLICT(identity) DO UPDATE SET label=excluded.label,auth_ciphertext=excluded.auth_ciphertext,deleted_at=NULL,last_error=NULL,updated_at=MAX(codex_accounts.updated_at+1,excluded.updated_at)",rusqlite::params![identity,label,cipher,chrono::Utc::now().timestamp_millis()]).map_err(|_| "保存供应商账号失败")?;
            let account_id:i64=tx.query_row("SELECT id FROM codex_accounts WHERE identity=?1",[&identity],|r|r.get(0)).map_err(|_| "供应商账号不可用")?;
            tx.execute("INSERT INTO codex_provider_accounts VALUES(?1,?2,?3) ON CONFLICT(account_id) DO UPDATE SET provider_id=excluded.provider_id,key_id=excluded.key_id",rusqlite::params![account_id,route.owner_id,route.key_id]).map_err(|_| "保存供应商账号关联失败")?;
            tx.execute("INSERT INTO codex_provider_bindings VALUES(?1,?2,?3,?4,?5,?6)",rusqlite::params![home.to_string_lossy(),route.owner_id,route.key_id,account_id,previous_account_id,id]).map_err(|_| "保存供应商绑定失败")?;
            if let Some(oauth_id)=input.oauth_account_id {
                tx.execute("INSERT INTO codex_provider_oauth VALUES(?1,?2,?3)",rusqlite::params![home.to_string_lossy(),oauth_id,profile::fingerprint(Some(auth))]).map_err(|_| "保存供应商 OAuth 归属失败")?;
            }
            if let Some(gateway)=&route.gateway {
                let cipher=crate::core::storage::encrypt_secret(&route.auth_key).map_err(|_| "加密供应商网关凭据失败")?;
                tx.execute("INSERT INTO codex_provider_gateways VALUES(?1,?2,?3,?4,?5,?6)",rusqlite::params![home.to_string_lossy(),gateway.port,cipher,route.owner_id,route.key_id,route.models_json]).map_err(|_| "保存供应商网关失败")?;
            }
            if let Some(id)=&id { tx.execute("UPDATE codex_profiles SET account_id=?1,auth_fingerprint=?2 WHERE id=?3",rusqlite::params![account_id,profile::fingerprint(Some(&auth)),id]).map_err(|_| "保存供应商实例绑定失败")?; }
            tx.commit().map_err(|_| "保存供应商绑定失败".to_string())
        })();
        if let Err(error)=bound { provider_config::restore(&conn,&home)?;return Err(error); }
        if let Some(gateway)=route.gateway {store.provider_gateways.lock().map_err(|_| "供应商网关状态不可用")?.insert(home.to_string_lossy().into_owned(),gateway);}
        provider_config::preview(&conn,&home)
    }).await.map_err(|_| "应用供应商配置任务失败")?.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_provider_restore(app:tauri::AppHandle,id:Option<String>)->PlatformResult<ConfigPreview> {
    tauri::async_runtime::spawn_blocking(move || -> Result<ConfigPreview,String> {
        let _writer=super::codex::AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        let store=app.state::<super::codex_runtime::CodexRuntimeStore>();
        let home=super::codex_instances::config_home(&store,id.as_deref(),true)?;
        let mut conn=open_db()?;
        if !provider_config::original_auth_restored(&conn,&home)? {crate::core::codex::provider_oauth::sync(&home)?;}
        provider_config::restore_files(&conn,&home)?;
        let tx=conn.transaction().map_err(|_| "恢复实例账号失败")?;
        if let Some(id)=&id {
            let old:Option<i64>=tx.query_row("SELECT previous_account_id FROM codex_provider_bindings WHERE home=?1",[home.to_string_lossy().as_ref()],|r|r.get(0)).optional().map_err(|_| "读取供应商绑定失败")?.flatten();
            if let Some(old)=old {
                let restored=match std::fs::symlink_metadata(home.join("auth.json")) {Ok(_)=>Some(profile::read_auth(&home.join("auth.json"))?),Err(e) if e.kind()==std::io::ErrorKind::NotFound=>None,Err(_)=>return Err("读取恢复认证失败".into())};
                tx.execute("UPDATE codex_profiles SET account_id=?1,auth_fingerprint=?2 WHERE id=?3",rusqlite::params![old,restored.as_ref().map(|s|profile::fingerprint(Some(s))),id]).map_err(|_| "恢复实例账号失败")?;
            }
        }
        tx.execute("DELETE FROM codex_provider_bindings WHERE home=?1",[home.to_string_lossy().as_ref()]).map_err(|_| "清理供应商绑定失败")?;
        tx.execute("DELETE FROM codex_provider_config_backups WHERE home=?1",[home.to_string_lossy().as_ref()]).map_err(|_| "清理供应商恢复记录失败")?;
        tx.execute("DELETE FROM codex_provider_gateways WHERE home=?1",[home.to_string_lossy().as_ref()]).map_err(|_| "清理供应商网关设置失败")?;
        tx.execute("DELETE FROM codex_provider_oauth WHERE home=?1",[home.to_string_lossy().as_ref()]).map_err(|_| "清理供应商 OAuth 归属失败")?;
        tx.commit().map_err(|_| "保存供应商恢复结果失败")?;
        store.provider_gateways.lock().map_err(|_| "供应商网关状态不可用")?.remove(home.to_string_lossy().as_ref());
        provider_config::preview(&conn,&home)
    }).await.map_err(|_| "恢复供应商配置任务失败")?.map_err(Into::into)
}

pub(crate) fn ensure_gateway(store:&super::codex_runtime::CodexRuntimeStore,home:&std::path::Path)->Result<(),String> {
    if store.closing.load(std::sync::atomic::Ordering::SeqCst) {return Err("应用正在退出，未启动供应商网关".into());}
    let conn=open_db()?;
    let row:Option<(u16,String,String,String,String)>=conn.query_row("SELECT port,key_ciphertext,provider_id,key_id,models_json FROM codex_provider_gateways WHERE home=?1",[home.to_string_lossy().as_ref()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(|_| "读取供应商网关设置失败")?;
    let Some((port,cipher,provider_id,key_id,models))=row else{return Ok(());};
    let mut gateways=store.provider_gateways.lock().map_err(|_| "供应商网关状态不可用")?;
    if gateways.contains_key(home.to_string_lossy().as_ref()){return Ok(());}
    let local=zeroize::Zeroizing::new(crate::core::storage::decrypt_secret(&cipher).map_err(|_| "解密供应商网关凭据失败")?);
    if let Some(aggregate_id)=provider_id.strip_prefix("aggregate:") {
        let aggregate=crate::core::codex::provider_aggregate::list(&conn)?.into_iter().find(|v|v.id==aggregate_id).ok_or("聚合网关配置失效，请恢复配置后重新应用")?;
        if key_id!="aggregate" {return Err("聚合网关配置失效，请恢复配置后重新应用".into());}
        let providers=providers::list(&conn)?;
        let mut members=Vec::new();
        for member in &aggregate.members {
            let provider=providers.iter().find(|v|v.id==member.provider_id).ok_or("聚合成员供应商不存在")?;
            let key=providers::credential(&conn,&member.provider_id,&member.key_id)?;
            members.push((member.key_id.clone(),provider.base_url.clone(),key,member.models.clone(),member.weight));
        }
        if serde_json::from_str::<Vec<String>>(&models).map_err(|_| "聚合网关模型目录无效")?!=aggregate.models {
            return Err("聚合网关模型目录已变更，请恢复配置后重新应用".into());
        }
        let gateway=tauri::async_runtime::block_on(crate::core::codex::provider_gateway::ProviderGateway::start_aggregate(port,members,local,aggregate.strategy))?;
        gateways.insert(home.to_string_lossy().into_owned(),gateway);
        return Ok(());
    }
    let provider=providers::list(&conn)?.into_iter().find(|v|v.id==provider_id && v.wire_api=="chat_completions").ok_or("供应商网关配置失效，请恢复配置后重新应用")?;
    let key=providers::credential(&conn,&provider_id,&key_id)?;
    let models:Vec<String>=serde_json::from_str(&models).map_err(|_| "供应商网关模型无效")?;
    let gateway=tauri::async_runtime::block_on(crate::core::codex::provider_gateway::ProviderGateway::start(port,provider.base_url,key,local,models))?;
    gateways.insert(home.to_string_lossy().into_owned(),gateway);
    Ok(())
}

pub(crate) fn resume_gateways(app:tauri::AppHandle) {
    let result=(|| -> Result<(),String> {
        let _writer=super::codex::AUTH_WRITER.lock().map_err(|_| "供应商网关操作不可用")?;
        let conn=open_db()?;
        let mut stmt=conn.prepare("SELECT home FROM codex_provider_gateways").map_err(|_| "读取供应商网关失败")?;
        let homes=stmt.query_map([],|r|r.get::<_,String>(0)).map_err(|_| "读取供应商网关失败")?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| "读取供应商网关失败")?;
        let store=app.state::<super::codex_runtime::CodexRuntimeStore>();
        for home in homes {let _=ensure_gateway(&store,std::path::Path::new(&home));}
        Ok(())
    })();
    // Launch and preview retry explicitly and surface errors; no sensitive details logged.
    let _=result;
}

#[tauri::command]
pub(crate) async fn codex_provider_list() -> PlatformResult<Vec<Provider>> {
    tauri::async_runtime::spawn_blocking(|| providers::list(&open_db()?)).await.map_err(|_| "读取供应商任务失败")?.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_provider_save(input: ProviderInput) -> PlatformResult<Vec<Provider>> {
    tauri::async_runtime::spawn_blocking(move || { let _writer=super::codex::AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?; providers::save(&mut open_db()?, input) }).await.map_err(|_| "保存供应商任务失败")?.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_provider_duplicate(id: String, version: i64) -> PlatformResult<Vec<Provider>> {
    tauri::async_runtime::spawn_blocking(move || {
        let _writer = super::codex::AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        providers::duplicate(&mut open_db()?, &id, version)
    }).await.map_err(|_| "复制供应商任务失败")?.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_provider_remove(id: String, version: i64) -> PlatformResult<Vec<Provider>> {
    tauri::async_runtime::spawn_blocking(move || { let _writer=super::codex::AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?; providers::remove(&open_db()?, &id, version) }).await.map_err(|_| "删除供应商任务失败")?.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_provider_aggregate_list() -> PlatformResult<Vec<crate::core::codex::provider_aggregate::Aggregate>> {
    tauri::async_runtime::spawn_blocking(|| crate::core::codex::provider_aggregate::list(&open_db()?))
        .await.map_err(|_| "读取聚合供应商任务失败")?.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_provider_aggregate_save(input: crate::core::codex::provider_aggregate::AggregateInput) -> PlatformResult<Vec<crate::core::codex::provider_aggregate::Aggregate>> {
    tauri::async_runtime::spawn_blocking(move || {
        let _writer=super::codex::AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        crate::core::codex::provider_aggregate::save(&mut open_db()?,input)
    }).await.map_err(|_| "保存聚合供应商任务失败")?.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_provider_aggregate_remove(id: String, version: i64) -> PlatformResult<Vec<crate::core::codex::provider_aggregate::Aggregate>> {
    tauri::async_runtime::spawn_blocking(move || {
        let _writer=super::codex::AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        crate::core::codex::provider_aggregate::remove(&open_db()?,&id,version)
    }).await.map_err(|_| "删除聚合供应商任务失败")?.map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_catalog_accepts_unsaved_credentials_without_reading_storage() {
        let input=ModelCatalogInput{base_url:"https://example.com/v1".into(),provider_id:None,key_id:None,version:None,secret:Some("invalid-fixture-key".into())};
        let (base,key)=resolve_model_catalog(input,|_,_,_|panic!("draft must not read saved credentials")).unwrap();
        assert_eq!(base,"https://example.com/v1");
        assert!(key.as_str()=="invalid-fixture-key");
    }

    #[test]
    fn model_catalog_resolves_the_selected_saved_key_and_propagates_conflicts() {
        let provider_id=uuid::Uuid::new_v4().to_string();
        let key_id=uuid::Uuid::new_v4().to_string();
        let input=||ModelCatalogInput{base_url:"https://example.com/v1".into(),provider_id:Some(provider_id.clone()),key_id:Some(key_id.clone()),version:Some(3),secret:None};
        let (_,key)=resolve_model_catalog(input(),|provider,key,version| {
            assert_eq!(provider,provider_id);assert_eq!(key,key_id);assert_eq!(version,3);
            Ok(zeroize::Zeroizing::new("invalid-saved-fixture".into()))
        }).unwrap();
        assert!(key.as_str()=="invalid-saved-fixture");
        assert!(resolve_model_catalog(input(),|_,_,_|Err("供应商已被修改，请刷新后重试".into())).is_err());
    }

    #[test]
    fn model_catalog_rejects_invalid_addresses_and_credentials_before_loading() {
        for (base,secret) in [
            ("http://example.com/v1",Some("fixture")),
            ("https://user:pass@example.com/v1",Some("fixture")),
            ("https://example.com/v1?token=fixture",Some("fixture")),
            ("https://example.com/v1",Some("fixture\nheader")),
            ("https://example.com/v1",Some(" ")),
            ("https://example.com/v1",None),
        ] {
            let input=ModelCatalogInput{base_url:base.into(),provider_id:None,key_id:None,version:None,secret:secret.map(str::to_owned)};
            assert!(resolve_model_catalog(input,|_,_,_|panic!("invalid input must not load credentials")).is_err());
        }
    }

    #[test]
    fn aggregate_apply_rejects_a_preview_from_before_a_configuration_change() {
        let conn=rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::core::database::CODEX_PROVIDERS_SCHEMA).unwrap();
        conn.execute_batch(crate::core::database::CODEX_PROVIDER_AGGREGATES_SCHEMA).unwrap();
        conn.execute_batch("ALTER TABLE codex_model_providers ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'; ALTER TABLE codex_provider_keys ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'; INSERT INTO codex_provider_aggregates VALUES('fixture','Fixture','failover',1);").unwrap();
        let mut input=ApplyProvider{provider_id:"aggregate:fixture".into(),key_id:"aggregate".into(),provider_version:Some(1),model:"model-test".into(),version:String::new(),oauth_account_id:None};
        conn.execute("UPDATE codex_provider_aggregates SET strategy='roundRobin',version=version+1 WHERE id='fixture'",[]).unwrap();
        let error=match resolve_apply_route(&conn,&input) {Err(error)=>error,Ok(_)=>panic!("stale aggregate preview was applied")};
        assert_eq!(error,"聚合供应商已被修改，请刷新后重试");
        input.provider_version=None;
        let error=match resolve_apply_route(&conn,&input) {Err(error)=>error,Ok(_)=>panic!("unversioned aggregate preview was applied")};
        assert_eq!(error,"聚合供应商已被修改，请刷新后重试");
        input.provider_version=Some(2);
        let error=match resolve_apply_route(&conn,&input) {Err(error)=>error,Ok(_)=>panic!("empty aggregate accepted a model")};
        assert_eq!(error,"模型不在供应商目录中");
    }
}
