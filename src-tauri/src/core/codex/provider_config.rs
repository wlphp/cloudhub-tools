use super::profile;
use crate::core::storage::{decrypt_secret, encrypt_secret};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{fs, path::Path};
use toml_edit::{Document, Item, Table, value};
use zeroize::{Zeroize,Zeroizing};

/// 安装前模型目录的归属。恢复时按此还原，避免删除用户原有文件。
#[derive(Serialize, Deserialize)]
struct CatalogBackup { exists: bool, content: Option<String> }
impl Drop for CatalogBackup {fn drop(&mut self){if let Some(text)=&mut self.content {text.zeroize();}}}
#[derive(Serialize, Deserialize)]
struct Snapshot {
    config: Option<String>,
    auth: Option<String>,
    /// 旧版本备份没有该字段。缺失时恢复不触碰模型目录，宁可残留也不删除用户文件。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    catalog: Option<CatalogBackup>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    selection: Option<AppliedSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending: Option<Box<SwitchRecovery>>,
}
impl Drop for Snapshot {fn drop(&mut self){self.config.zeroize();self.auth.zeroize();}}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct ConfigPreview { pub version: String, pub path: String, pub has_backup: bool, pub catalog_stale: bool, pub applied: Option<AppliedSelection>, pub recovery_pending: bool }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct AppliedSelection { pub provider_id:String, pub key_id:String, pub provider_version:i64, pub model:String, pub oauth_account_id:Option<i64> }

#[derive(Serialize, Deserialize)]
struct BackupRow { cipher:String, config:String, auth:String }

#[derive(Serialize, Deserialize)]
pub struct SwitchRecovery { prior:Snapshot, backup:Option<BackupRow>, #[serde(default)] catalog_meta:Option<String> }

fn read_optional(home:&Path,name:&str)->Result<Option<Zeroizing<String>>,String> {
    match fs::symlink_metadata(home.join(name)) {
        Ok(_)=>profile::read_auth(&home.join(name)).map(Some),
        Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(None),
        Err(_)=>Err("读取供应商目标配置失败".into()),
    }
}
/// 客户端每次启动都会重写命名管道等运行时字段，这些值不属于用户配置。
/// 指纹比较必须忽略它们，否则恢复原配置会被误判为外部修改。
pub fn normalize_config(text:&str)->String {
    text.lines().filter(|line| !line.contains("\\\\.\\pipe\\")).collect::<Vec<_>>().join("\n")
}
fn config_fingerprint(text:Option<&str>)->String {
    profile::fingerprint(text.map(normalize_config).as_deref())
}
fn fingerprints(home:&Path)->Result<(String,String),String> {
    Ok((config_fingerprint(read_optional(home,"config.toml")?.as_deref().map(|s|s.as_str())),profile::fingerprint(read_optional(home,"auth.json")?.as_deref().map(|s|s.as_str()))))
}
pub fn preview(conn:&Connection,home:&Path)->Result<ConfigPreview,String> {
    let (config,auth)=fingerprints(home)?;
    let backup=backup_row(conn,home)?;
    let catalog_stale=super::model_catalog::needs_rebuild(&home.join(CATALOG_FILE));
    Ok(ConfigPreview{version:format!("{config}:{auth}"),path:home.to_string_lossy().into_owned(),has_backup:backup.is_some(),catalog_stale,applied:None,recovery_pending:false})
}

pub fn managed_preview(conn:&Connection,home:&Path)->Result<ConfigPreview,String> {
    managed_preview_with(conn,home,decrypt_secret)
}
fn managed_preview_with(conn:&Connection,home:&Path,decrypt:impl Fn(&str)->Result<String,String>)->Result<ConfigPreview,String> {
    let mut result=preview(conn,home)?;
    let mut applied=None;let mut recovery_pending=false;
    if let Some(row)=backup_row(conn,home)? {
        let snapshot=decode_snapshot(&row.cipher,decrypt)?;
        recovery_pending=snapshot.pending.is_some();
        // OAuth rotation is reconciled by the command before returning preview.
        if !recovery_pending && home.join(CATALOG_FILE).is_file() && !result.catalog_stale && result.version==format!("{}:{}",row.config,row.auth) {applied=snapshot.selection.clone();}
    }
    result.applied=applied;result.recovery_pending=recovery_pending;Ok(result)
}

fn backup_row(conn:&Connection,home:&Path)->Result<Option<BackupRow>,String> {
    conn.query_row("SELECT content_ciphertext,installed_config,installed_auth FROM codex_provider_config_backups WHERE home=?1",[home.to_string_lossy().as_ref()],|r|Ok(BackupRow{cipher:r.get(0)?,config:r.get(1)?,auth:r.get(2)?})).optional().map_err(|_| "读取供应商备份失败".into())
}
fn decode_snapshot(cipher:&str,decrypt:impl Fn(&str)->Result<String,String>)->Result<Snapshot,String> {
    let text=Zeroizing::new(decrypt(cipher).map_err(|_| "解密供应商备份失败")?);
    serde_json::from_str(&text).map_err(|_| "供应商备份损坏".into())
}
fn snapshot(home:&Path)->Result<Snapshot,String> {
    Ok(Snapshot{config:read_optional(home,"config.toml")?.map(|s|s.to_string()),auth:read_optional(home,"auth.json")?.map(|s|s.to_string()),catalog:Some(catalog_snapshot(home)),selection:None,pending:None})
}

/// 供应商模型目录文件。客户端的模型选择器只展示该文件中的模型，因此应用
/// 供应商配置时必须同时写入它，否则界面仍然显示内置的 GPT 模型。
pub const CATALOG_FILE:&str="cloudhub-model-catalog.json";

/// 复制现有目录中的一条模型作为模板，保证客户端需要的字段保持完整。
fn catalog_template(home:&Path)->Option<serde_json::Value> {
    for name in ["cockpit-model-catalog.json","model-catalog.json",CATALOG_FILE] {
        let Ok(Some(text))=read_optional(home,name) else {continue};
        let Ok(value)=serde_json::from_str::<serde_json::Value>(text.as_str()) else {continue};
        if let Some(entry)=value.get("models").and_then(serde_json::Value::as_array).and_then(|rows|rows.first()) {
            return Some(entry.clone());
        }
    }
    None
}

/// 生成供应商模型目录，条目与供应商的模型一致。
pub fn build_catalog(settings:&super::providers::ModelSettings,overlay:Option<serde_json::Value>)->serde_json::Value {
    let context=settings.context_window.unwrap_or(200_000).max(4_096);
    let compact=settings.compact_limit.unwrap_or_else(||context.saturating_mul(4)/5);
    let models=settings.models.iter().enumerate().map(|(index,id)|{
        let (mut entry,official)=super::model_catalog::template(id);
        if let Some(overlay)=overlay.as_ref() {
            entry=super::model_catalog::merge_defaults(&entry,overlay);
        }
        if !official {super::model_catalog::strip_official_capabilities(&mut entry)}
        entry["slug"]=json!(id);
        entry["display_name"]=json!(id);
        entry["description"]=json!(id);
        entry["context_window"]=json!(context);
        entry["max_context_window"]=json!(context);
        entry["auto_compact_token_limit"]=json!(compact);
        entry["priority"]=json!(1000+index as i64);
        entry
    }).collect::<Vec<_>>();
    json!({"models":models})
}

/// 写入供应商模型目录并让配置指向它。
pub fn install_catalog(home:&Path,settings:&super::providers::ModelSettings)->Result<(),String> {
    let catalog=build_catalog(settings,catalog_template(home));
    super::model_catalog::validate(&catalog)?;
    let text=serde_json::to_string(&catalog).map_err(|_| "生成供应商模型目录失败")?;
    let path=home.join(CATALOG_FILE);
    profile::write_private(&path,&text)?;
    super::model_catalog::write_meta(&path,&text);
    Ok(())
}

/// 恢复原配置时移除本应用写入的模型目录。
pub fn remove_catalog(home:&Path) {
    let path=home.join(CATALOG_FILE);
    if let Ok(meta)=fs::symlink_metadata(&path) {
        if meta.is_file() && !meta.file_type().is_symlink() {
            let _=fs::remove_file(&path);
        }
    }
    let _=fs::remove_file(home.join("cloudhub-model-catalog.meta.json"));
}

/// 记录安装前模型目录的归属。文件不存在、无法读取或不是普通文件时都不会被删除。
fn catalog_snapshot(home:&Path)->CatalogBackup {
    let path=home.join(CATALOG_FILE);
    match fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_file()&&!meta.file_type().is_symlink()=>match read_optional(home,CATALOG_FILE) {
            Ok(Some(text))=>CatalogBackup{exists:true,content:Some(text.to_string())},
            _=>CatalogBackup{exists:true,content:None},
        },
        Ok(_)=>CatalogBackup{exists:true,content:None},
        Err(e) if e.kind()==std::io::ErrorKind::NotFound=>CatalogBackup{exists:false,content:None},
        Err(_)=>CatalogBackup{exists:true,content:None},
    }
}

/// 把模型目录还原到安装前的状态。只删除本应用确实创建过的文件。
fn restore_catalog(home:&Path,catalog:Option<&CatalogBackup>)->Result<(),String> {
    match catalog {
        None=>Ok(()),
        Some(catalog) if catalog.exists=>match catalog.content.as_deref() {
            Some(text)=>{
                let restored=profile::write_private(&home.join(CATALOG_FILE),text);
                // 还原的是用户原文件，不再是本应用的产出，版本戳必须一并清掉。
                let _=fs::remove_file(home.join("cloudhub-model-catalog.meta.json"));
                restored
            }
            None=>Ok(()),
        },
        Some(_)=>{remove_catalog(home);Ok(())},
    }
}

/// 逐行扫描配置文本，返回该行以及它是否位于多行字符串内部。
/// 行级改写必须跳过多行字符串内容与注释，否则会把字符串或注释里的字面量当成
/// 键或表头改写。单行字符串内部不可能合法出现三引号，但注释里可以，因此注释必须
/// 在定界符查找之前截断。
#[cfg(test)]
fn scan_lines(config:&str)->Vec<(&str,bool)> {
    let mut rows=Vec::new();
    let mut open:Option<&'static str>=None;
    for line in config.lines() {
        rows.push((line,open.is_some()));
        let mut rest=line;
        loop {
            if let Some(token)=open {
                match rest.find(token) {Some(index)=>{rest=&rest[index+3..];open=None;},None=>break}
                continue;
            }
            // 注释里的三引号不是定界符，必须先截断。
            match rest.find('#') {Some(index)=>rest=&rest[..index],None=>{}}
            let next=["\"\"\"","'''"].into_iter().filter_map(|token|rest.find(token).map(|index|(index,token))).min_by_key(|(index,_)|*index);
            match next {Some((index,token))=>{rest=&rest[index+3..];open=Some(token);},None=>break}
        }
    }
    rows
}

/// 顶层键名必须完整匹配，`model_catalog_json_path` 这类无关键属于用户配置。
#[cfg(test)]
fn is_catalog_key(line:&str)->bool {
    let Some(rest)=line.trim_start().strip_prefix("model_catalog_json") else{return false};
    rest.trim_start().starts_with('=') || rest.trim_start().starts_with(' ')
}

/// 官方 CLI 的配置写入不接受该键，因此直接在生成的配置文本中设置顶层键。
#[cfg(test)]
fn set_catalog_key(config:&str)->String {
    let rows=scan_lines(config);
    // 顶层键只能出现在首个表头之前；表内的同名键属于用户配置，必须保留。
    let section=rows.iter().position(|(line,inside)|!*inside&&line.trim_start().starts_with('[')).unwrap_or(rows.len());
    let kept=rows.iter().enumerate()
        .filter(|(index,(line,inside))|*inside||*index>=section||!is_catalog_key(line))
        .map(|(_,row)|*row).collect::<Vec<_>>();
    let position=kept.iter().position(|(line,inside)|!*inside&&line.trim_start().starts_with('[')).unwrap_or(kept.len());
    let entry=format!("model_catalog_json = \"{CATALOG_FILE}\"");
    let mut lines=kept.into_iter().map(|(line,_)|line).collect::<Vec<_>>();
    lines.insert(position,&entry);
    let mut text=lines.join("\n");
    if !text.ends_with('\n') {text.push('\n');}
    text
}

pub fn build_config(home:&Path,base_url:&str,model:&str,settings:&super::providers::ModelSettings,bearer:&str,oauth:bool)->Result<Zeroizing<String>,String> {
    let source=read_optional(home,"config.toml")?;
    let mut document=source.as_deref().map(|s|s.as_str()).unwrap_or("").parse::<Document>().map_err(|_| "目标 TOML 配置格式无效，请修正后重试")?;
    for (key,next) in [("model",value(model)),("model_provider",value("cloudhub_provider")),("cli_auth_credentials_store",value("file")),("model_catalog_json",value(CATALOG_FILE))] {set_value(document.as_table_mut(),key,next)?;}
    for (key,next) in [("model_context_window",settings.context_window),("model_auto_compact_token_limit",settings.compact_limit)] {
        if document.get(key).is_some_and(|item|!item.is_value()) {return Err("供应商配置存在类型冲突".into());}
        if let Some(next)=next {set_value(document.as_table_mut(),key,value(next))?;} else {document.remove(key);}
    }
    if !document.contains_key("model_providers") {document["model_providers"]=Item::Table(Table::new());}
    let providers=document["model_providers"].as_table_like_mut().ok_or("供应商配置存在类型冲突")?;
    if !providers.contains_key("cloudhub_provider") {providers.insert("cloudhub_provider",Item::Table(Table::new()));}
    let provider=providers.get_mut("cloudhub_provider").and_then(Item::as_table_like_mut).ok_or("供应商配置存在类型冲突")?;
    for key in ["env_key","env_key_instructions","auth_command"] {provider.remove(key);}
    for key in ["http_headers","env_http_headers"] {
        if let Some(headers)=provider.get_mut(key) {
            let headers=headers.as_table_like_mut().ok_or("供应商请求头配置存在类型冲突")?;
            let remove=headers.iter().filter(|(key,_)|key.eq_ignore_ascii_case("authorization")||key.eq_ignore_ascii_case("chatgpt-account-id")).map(|(key,_)|key.to_owned()).collect::<Vec<_>>();
            for key in remove {headers.remove(&key);}
        }
    }
    for (key,next) in [("name",value("CloudHub Provider")),("base_url",value(base_url)),("wire_api",value("responses")),("requires_openai_auth",value(oauth)),("experimental_bearer_token",value(bearer))] {set_value(provider,key,next)?;}
    let output=Zeroizing::new(document.to_string());
    output.parse::<Document>().map_err(|_| "生成供应商 TOML 配置失败")?;
    Ok(output)
}

fn set_value(table:&mut dyn toml_edit::TableLike,key:&str,mut next:Item)->Result<(),String> {
    if let Some(previous)=table.get_mut(key) {
        let old=previous.as_value().ok_or("供应商配置存在类型冲突")?;
        *next.as_value_mut().ok_or("生成供应商配置失败")?.decor_mut()=old.decor().clone();
        *previous=next;
        return Ok(());
    }
    table.insert(key,next);Ok(())
}

fn write_optional(home:&Path,name:&str,value:Option<&str>)->Result<(),String> {
    if let Some(value)=value {profile::write_private(&home.join(name),value)}
    else {match fs::symlink_metadata(home.join(name)) {Ok(m) if m.is_file() && !m.file_type().is_symlink()=>fs::remove_file(home.join(name)).map_err(|_| "恢复供应商配置失败".into()),Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(()),_=>Err("恢复供应商配置失败".into())}}
}

/// 保留首次安装前的恢复点，同时持久化本次切换前状态以补偿失败。
pub fn begin_switch(conn:&Connection,home:&Path,version:&str,config:&str,auth:&str,selection:AppliedSelection)->Result<SwitchRecovery,String> {
    begin_switch_with(conn,home,version,config,auth,selection,decrypt_secret,encrypt_secret)
}
fn begin_switch_with(conn:&Connection,home:&Path,version:&str,config:&str,auth:&str,selection:AppliedSelection,decrypt:impl Fn(&str)->Result<String,String>,encrypt:impl Fn(&str)->Result<String,String>)->Result<SwitchRecovery,String> {
    if preview(conn,home)?.version!=version {return Err("目标配置已变更，请重新预览".into());}
    let backup=backup_row(conn,home)?;
    let mut original=if let Some(row)=&backup {
        let original=decode_snapshot(&row.cipher,&decrypt)?;
        if original.pending.is_some() {return Err("上次切换未完成，请先恢复配置与登录".into());}
        original
    } else {snapshot(home)?};
    let prior=snapshot(home)?;
    if version!=format!("{}:{}",config_fingerprint(prior.config.as_deref()),profile::fingerprint(prior.auth.as_deref())) {return Err("目标配置已变更，请重新预览".into());}
    original.selection=Some(selection);
    let catalog_meta=read_optional(home,"cloudhub-model-catalog.meta.json")?.map(|s|s.to_string());
    original.pending=Some(Box::new(SwitchRecovery{prior,backup,catalog_meta}));
    let encoded=Zeroizing::new(serde_json::to_string(&original).map_err(|_| "保存供应商恢复记录失败")?);
    let cipher=encrypt(&encoded).map_err(|_| "加密供应商恢复记录失败")?;
    if preview(conn,home)?.version!=version {return Err("目标配置已变更，请重新预览".into());}
    conn.execute("INSERT INTO codex_provider_config_backups VALUES(?1,?2,?3,?4) ON CONFLICT(home) DO UPDATE SET content_ciphertext=excluded.content_ciphertext,installed_config=excluded.installed_config,installed_auth=excluded.installed_auth",params![home.to_string_lossy(),cipher,config_fingerprint(Some(config)),profile::fingerprint(Some(auth))]).map_err(|_| "保存供应商恢复记录失败")?;
    Ok(*original.pending.take().ok_or("供应商恢复记录缺失")?)
}
pub fn write_switch(home:&Path,config:&str,auth:&str)->Result<(),String> {
    if !home.exists() {fs::create_dir_all(home).map_err(|_| "创建供应商配置目录失败")?;profile::private_permissions(home,true)?;}
    profile::write_private(&home.join("config.toml"),config)?;
    profile::write_private(&home.join("auth.json"),auth)
}
pub fn finish_switch(conn:&Connection,home:&Path)->Result<(),String> {
    finish_switch_with(conn,home,decrypt_secret,encrypt_secret)
}
fn finish_switch_with(conn:&Connection,home:&Path,decrypt:impl Fn(&str)->Result<String,String>,encrypt:impl Fn(&str)->Result<String,String>)->Result<(),String> {
    let row=backup_row(conn,home)?.ok_or("供应商恢复记录缺失")?;
    let mut original=decode_snapshot(&row.cipher,decrypt)?;
    original.pending=None;
    let encoded=Zeroizing::new(serde_json::to_string(&original).map_err(|_| "保存供应商恢复记录失败")?);
    let cipher=encrypt(&encoded).map_err(|_| "加密供应商恢复记录失败")?;
    conn.execute("UPDATE codex_provider_config_backups SET content_ciphertext=?1 WHERE home=?2",params![cipher,home.to_string_lossy()]).map_err(|_| "保存供应商恢复记录失败")?;Ok(())
}
pub fn rollback_switch(conn:&Connection,home:&Path,recovery:&SwitchRecovery)->Result<(),String> {
    let row=backup_row(conn,home)?.ok_or("供应商恢复记录缺失")?;
    let current=fingerprints(home)?;
    if (current.0!=row.config && current.0!=config_fingerprint(recovery.prior.config.as_deref())) || (current.1!=row.auth && current.1!=profile::fingerprint(recovery.prior.auth.as_deref())) {return Err("目标配置已被外部修改，保留恢复记录，请手动恢复".into());}
    write_optional(home,"config.toml",recovery.prior.config.as_deref())?;
    write_optional(home,"auth.json",recovery.prior.auth.as_deref())?;
    restore_catalog(home,recovery.prior.catalog.as_ref())?;
    write_optional(home,"cloudhub-model-catalog.meta.json",recovery.catalog_meta.as_deref())?;
    if let Some(row)=&recovery.backup {
        conn.execute("UPDATE codex_provider_config_backups SET content_ciphertext=?1,installed_config=?2,installed_auth=?3 WHERE home=?4",params![row.cipher,row.config,row.auth,home.to_string_lossy()]).map_err(|_| "保存供应商回退结果失败")?;
    } else {conn.execute("DELETE FROM codex_provider_config_backups WHERE home=?1",[home.to_string_lossy().as_ref()]).map_err(|_| "清理供应商恢复记录失败")?;}
    Ok(())
}

#[cfg(test)]
pub fn install(conn:&Connection,home:&Path,version:&str,config:&str,auth:&str)->Result<(),String> {
    install_encrypted(conn,home,version,config,auth,encrypt_secret)
}
#[cfg(test)]
fn install_encrypted(conn:&Connection,home:&Path,version:&str,config:&str,auth:&str,encrypt:impl Fn(&str)->Result<String,String>)->Result<(),String> {
    install_with_writer(conn,home,version,config,auth,encrypt,profile::write_private)
}
#[cfg(test)]
fn install_with_writer(conn:&Connection,home:&Path,version:&str,config:&str,auth:&str,encrypt:impl Fn(&str)->Result<String,String>,write:impl Fn(&Path,&str)->Result<(),String>)->Result<(),String> {
    if preview(conn,home)?.version!=version {return Err("目标配置已变更，请重新预览".into());}
    if preview(conn,home)?.has_backup {return Err("请先恢复上次供应商配置，再切换供应商".into());}
    let snapshot=snapshot(home)?;
    let snapshot_version=format!("{}:{}",config_fingerprint(snapshot.config.as_deref()),profile::fingerprint(snapshot.auth.as_deref()));
    if snapshot_version!=version {return Err("目标配置已变更，请重新预览".into());}
    let encoded=Zeroizing::new(serde_json::to_string(&snapshot).map_err(|_| "保存供应商备份失败")?);
    let cipher=encrypt(&encoded).map_err(|_| "加密供应商备份失败")?;
    if preview(conn,home)?.version!=version {return Err("目标配置已变更，请重新预览".into());}
    conn.execute("INSERT INTO codex_provider_config_backups VALUES(?1,?2,?3,?4)",params![home.to_string_lossy(),cipher,config_fingerprint(Some(config)),profile::fingerprint(Some(auth))]).map_err(|_| "保存供应商备份失败")?;
    if !home.exists() {fs::create_dir_all(home).map_err(|_| "创建供应商配置目录失败")?;profile::private_permissions(home,true)?;}
    if let Err(error)=write(&home.join("config.toml"),config).and_then(|_|write(&home.join("auth.json"),auth)) {
        // The encrypted recovery point remains if compensation cannot complete.
        if write_optional(home,"config.toml",snapshot.config.as_deref()).and_then(|_|write_optional(home,"auth.json",snapshot.auth.as_deref())).and_then(|_|restore_catalog(home,snapshot.catalog.as_ref())).is_ok() {
            conn.execute("DELETE FROM codex_provider_config_backups WHERE home=?1",[home.to_string_lossy().as_ref()]).map_err(|_| "清理供应商恢复记录失败")?;
        }
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
pub fn restore(conn:&Connection,home:&Path)->Result<(),String> {
    restore_files(conn,home)?;
    conn.execute("DELETE FROM codex_provider_config_backups WHERE home=?1",[home.to_string_lossy().as_ref()]).map_err(|_| "清理供应商恢复记录失败")?;
    Ok(())
}

/// 恢复总是以首次切换前的加密备份覆盖当前文件；期间的外部修改（包括官方客户端
/// 重写配置）不做保留。凭据轮换由 `provider_oauth::sync` 在恢复前并入备份。
pub fn restore_files(conn:&Connection,home:&Path)->Result<(),String> {
    restore_decrypted(conn,home,decrypt_secret)
}

pub fn original_auth_restored(conn:&Connection,home:&Path)->Result<bool,String> {
    let cipher:String=conn.query_row("SELECT content_ciphertext FROM codex_provider_config_backups WHERE home=?1",[home.to_string_lossy().as_ref()],|r|r.get(0)).map_err(|_| "没有供应商配置备份")?;
    let decoded=Zeroizing::new(decrypt_secret(&cipher).map_err(|_| "解密供应商备份失败")?);
    let snapshot:Snapshot=serde_json::from_str(&decoded).map_err(|_| "供应商备份损坏")?;
    Ok(fingerprints(home)?.1==profile::fingerprint(snapshot.auth.as_deref()))
}

pub fn record_oauth_rotation(conn:&Connection,home:&Path,previous:&str,auth:&str)->Result<(),String> {
    record_oauth_rotation_encrypted(conn,home,previous,auth,decrypt_secret,encrypt_secret)
}
pub(super) fn record_oauth_rotation_encrypted(conn:&Connection,home:&Path,previous:&str,auth:&str,decrypt:impl Fn(&str)->Result<String,String>,encrypt:impl Fn(&str)->Result<String,String>)->Result<(),String> {
    let (cipher,installed):(String,String)=conn.query_row("SELECT content_ciphertext,installed_auth FROM codex_provider_config_backups WHERE home=?1",[home.to_string_lossy().as_ref()],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_| "读取 OAuth 恢复记录失败")?;
    let hash=profile::fingerprint(Some(auth));
    if installed!=previous && installed!=hash {return Err("OAuth 恢复记录与投影不一致".into());}
    let decoded=Zeroizing::new(decrypt(&cipher).map_err(|_| "解密 OAuth 恢复记录失败")?);
    let mut snapshot:Snapshot=serde_json::from_str(&decoded).map_err(|_| "OAuth 恢复记录损坏")?;
    if snapshot.pending.is_some() {return Err("上次切换未完成，请先恢复配置与登录".into());}
    // If this profile already belonged to the same OAuth owner before applying,
    // restore the latest rotated grant, not a now-invalid pre-rotation token.
    let identity=super::provider_oauth::validate(auth)?;
    if snapshot.auth.as_deref().and_then(|old|super::provider_oauth::validate(old).ok()).as_ref()==Some(&identity) {
        snapshot.auth=Some(auth.to_owned());
    }
    let encoded=Zeroizing::new(serde_json::to_string(&snapshot).map_err(|_| "保存 OAuth 恢复记录失败")?);
    let cipher=encrypt(&encoded).map_err(|_| "加密 OAuth 恢复记录失败")?;
    conn.execute("UPDATE codex_provider_config_backups SET content_ciphertext=?1,installed_auth=?2 WHERE home=?3",params![cipher,hash,home.to_string_lossy()]).map_err(|_| "保存 OAuth 恢复记录失败")?;
    Ok(())
}
fn restore_decrypted(conn:&Connection,home:&Path,decrypt:impl Fn(&str)->Result<String,String>)->Result<(),String> {
    let cipher:String=conn.query_row("SELECT content_ciphertext FROM codex_provider_config_backups WHERE home=?1",[home.to_string_lossy().as_ref()],|r|r.get(0)).optional().map_err(|_| "读取供应商备份失败")?.ok_or("没有供应商配置备份")?;
    let text=Zeroizing::new(decrypt(&cipher).map_err(|_| "解密供应商备份失败")?);
    let snapshot:Snapshot=serde_json::from_str(&text).map_err(|_| "供应商备份损坏")?;
    write_optional(home,"config.toml",snapshot.config.as_deref())?;
    write_optional(home,"auth.json",snapshot.auth.as_deref())?;
    restore_catalog(home,snapshot.catalog.as_ref())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_selection(model:&str)->AppliedSelection {AppliedSelection{provider_id:"fixture".into(),key_id:"fixture".into(),provider_version:1,model:model.into(),oauth_account_id:None}}
    #[test]
    fn repeated_switch_failure_and_crash_preserve_original_restore_point() {
        let encrypt=|v:&str|crate::core::crypto::encrypt_secret_with_key(v,&[23;32]);
        let decrypt=|v:&str|crate::core::crypto::decrypt_secret_with_key(v,&[23;32]);
        let temp=profile::TemporaryProfile::new("{}").unwrap();
        let db=Connection::open_in_memory().unwrap();db.execute_batch(crate::core::database::CODEX_PROVIDER_BACKUPS_SCHEMA).unwrap();
        let original=preview(&db,&temp.path).unwrap().version;
        let a="model = \"a\"\n";let b="model = \"b\"\n";
        begin_switch_with(&db,&temp.path,&original,a,"{}",test_selection("a"),decrypt,encrypt).unwrap();
        write_switch(&temp.path,a,"{}").unwrap();finish_switch_with(&db,&temp.path,decrypt,encrypt).unwrap();
        let settings=super::super::providers::ModelSettings{models:vec!["a".into()],..Default::default()};
        install_catalog(&temp.path,&settings).unwrap();
        assert_eq!(managed_preview_with(&db,&temp.path,decrypt).unwrap().applied.unwrap().model,"a");
        let a_version=preview(&db,&temp.path).unwrap().version;
        let recovery=begin_switch_with(&db,&temp.path,&a_version,b,"{\"fixture\":true}",test_selection("b"),decrypt,encrypt).unwrap();
        assert!(managed_preview_with(&db,&temp.path,decrypt).unwrap().recovery_pending);
        profile::write_private(&temp.path.join("config.toml"),b).unwrap();
        // 部分写入失败，回退到 A，首次恢复点仍存在。
        rollback_switch(&db,&temp.path,&recovery).unwrap();
        assert_eq!(preview(&db,&temp.path).unwrap().version,a_version);
        assert_eq!(managed_preview_with(&db,&temp.path,decrypt).unwrap().applied.unwrap().model,"a");
        let row=backup_row(&db,&temp.path).unwrap().unwrap();
        assert_eq!(decode_snapshot(&row.cipher,decrypt).unwrap().selection.as_ref().unwrap().model,"a");
        // 模拟进程退出：丢弃内存补偿句柄，重启后只依赖加密记录恢复。
        begin_switch_with(&db,&temp.path,&a_version,b,"{\"fixture\":true}",test_selection("b"),decrypt,encrypt).unwrap();
        profile::write_private(&temp.path.join("config.toml"),b).unwrap();
        assert!(begin_switch_with(&db,&temp.path,&preview(&db,&temp.path).unwrap().version,b,"{}",test_selection("b"),decrypt,encrypt).is_err());
        restore_decrypted(&db,&temp.path,decrypt).unwrap();
        assert_eq!(preview(&db,&temp.path).unwrap().version,original);
    }
    #[test]
    fn switch_compensation_never_overwrites_external_edits() {
        let encrypt=|v:&str|crate::core::crypto::encrypt_secret_with_key(v,&[23;32]);
        let decrypt=|v:&str|crate::core::crypto::decrypt_secret_with_key(v,&[23;32]);
        let temp=profile::TemporaryProfile::new("{}").unwrap();
        let db=Connection::open_in_memory().unwrap();db.execute_batch(crate::core::database::CODEX_PROVIDER_BACKUPS_SCHEMA).unwrap();
        let before=preview(&db,&temp.path).unwrap().version;
        let recovery=begin_switch_with(&db,&temp.path,&before,"model = 'a'","{}",test_selection("a"),decrypt,encrypt).unwrap();
        profile::write_private(&temp.path.join("config.toml"),"model = 'external'").unwrap();
        // 回滚是故障路径的自动补偿，仍拒绝覆盖外部编辑。
        assert!(rollback_switch(&db,&temp.path,&recovery).is_err());
        let state=managed_preview_with(&db,&temp.path,decrypt).unwrap();assert!(state.recovery_pending);assert!(state.applied.is_none());
        // 显式恢复由用户发起，直接以首次切换前的备份覆盖外部编辑。
        restore_decrypted(&db,&temp.path,decrypt).unwrap();
        assert_eq!(preview(&db,&temp.path).unwrap().version,before);
    }
    #[test]
    fn committed_switches_keep_first_backup_and_transaction_failure_keeps_recovery() {
        let encrypt=|v:&str|crate::core::crypto::encrypt_secret_with_key(v,&[23;32]);
        let decrypt=|v:&str|crate::core::crypto::decrypt_secret_with_key(v,&[23;32]);
        let temp=profile::TemporaryProfile::new("{}").unwrap();
        let mut db=Connection::open_in_memory().unwrap();db.execute_batch(crate::core::database::CODEX_PROVIDER_BACKUPS_SCHEMA).unwrap();
        let original=preview(&db,&temp.path).unwrap().version;
        for model in ["a","b"] {
            let config=format!("model = '{model}'\n");
            let before=preview(&db,&temp.path).unwrap().version;
            begin_switch_with(&db,&temp.path,&before,&config,"{}",test_selection(model),decrypt,encrypt).unwrap();
            write_switch(&temp.path,&config,"{}").unwrap();
            // 后续绑定提交失败时，清除 pending 的操作必须随事务回滚。
            {let tx=db.transaction().unwrap();finish_switch_with(&tx,&temp.path,decrypt,encrypt).unwrap();}
            assert!(managed_preview_with(&db,&temp.path,decrypt).unwrap().recovery_pending);
            let tx=db.transaction().unwrap();finish_switch_with(&tx,&temp.path,decrypt,encrypt).unwrap();tx.commit().unwrap();
        }
        restore_decrypted(&db,&temp.path,decrypt).unwrap();
        assert_eq!(preview(&db,&temp.path).unwrap().version,original);
    }
    #[test]
    fn native_toml_preserves_unmanaged_fields_and_safely_replaces_credentials() {
        for inline in [false,true] {
            let temp=profile::TemporaryProfile::new("{}").unwrap();
            let provider=if inline {"model_providers = { cloudhub_provider = { base_url = 'old', env_key = 'OLD', custom = 'keep' }, other = { name = 'other' } }\n"} else {"[model_providers.cloudhub_provider]\nbase_url = 'old'\nenv_key = 'OLD'\ncustom = 'keep'\n[model_providers.other]\nname = 'other'\n"};
            let source=format!("# preserved\nmodel = 'old' # chosen model\nmodel_context_window = 12345\nmodel_auto_compact_token_limit = 1234\n{provider}[mcp_servers.fixture]\ncommand = 'fixture'\n");
            profile::write_private(&temp.path.join("config.toml"),&source).unwrap();
            let out=build_config(&temp.path,"https://example.com/v1","model-\"quoted",&super::super::providers::ModelSettings::default(),"fixture-\"token",false).unwrap();
            let parsed=out.parse::<Document>().unwrap();
            assert_eq!(parsed["model"].as_str(),Some("model-\"quoted"));
            assert!(!parsed.contains_key("model_context_window"));assert!(!parsed.contains_key("model_auto_compact_token_limit"));
            assert_eq!(parsed["model_providers"]["cloudhub_provider"]["custom"].as_str(),Some("keep"));
            assert_eq!(parsed["model_providers"]["other"]["name"].as_str(),Some("other"));
            assert_eq!(parsed["mcp_servers"]["fixture"]["command"].as_str(),Some("fixture"));
            assert!(out.contains("# preserved"));assert!(out.contains("# chosen model"));assert!(!out.contains("env_key"));
            assert!(profile::read_auth(&temp.path.join("config.toml")).unwrap().as_str()==source);
        }
    }
    #[test]
    fn invalid_or_conflicting_toml_never_leaks_source_or_changes_files() {
        let temp=profile::TemporaryProfile::new("{}").unwrap();
        for source in ["token = 'fixture-sensitive'\n[invalid", "model_providers = 42\n", "[model]\nsecret = 'fixture-sensitive'\n"] {
            profile::write_private(&temp.path.join("config.toml"),source).unwrap();
            let error=build_config(&temp.path,"https://example.com/v1","model",&super::super::providers::ModelSettings::default(),"fixture-token",false).unwrap_err();
            assert!(!error.contains("fixture-sensitive"));
            assert!(profile::read_auth(&temp.path.join("config.toml")).unwrap().as_str()==source);
        }
    }
    fn oauth_fixture(owner:&str)->String {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD,Engine};
        let claims=URL_SAFE_NO_PAD.encode(json!({"sub":owner,"https://api.openai.com/auth":{"chatgpt_account_id":owner,"chatgpt_user_id":owner}}).to_string());
        json!({"auth_mode":"chatgpt","tokens":{"access_token":uuid::Uuid::new_v4().to_string(),"refresh_token":uuid::Uuid::new_v4().to_string(),"id_token":format!("invalid.{claims}.invalid"),"account_id":owner}}).to_string()
    }
    #[test]
    fn oauth_rotation_preserves_the_correct_recovery_identity_and_rolls_back() {
        let encrypt=|v:&str|crate::core::crypto::encrypt_secret_with_key(v,&[23;32]);
        let decrypt=|v:&str|crate::core::crypto::decrypt_secret_with_key(v,&[23;32]);
        for same_owner in [true,false] {
            let original=oauth_fixture(if same_owner {"owner"} else {"other-owner"});
            let installed=oauth_fixture("owner");
            let rotated=oauth_fixture("owner");
            let temp=profile::TemporaryProfile::new(&original).unwrap();
            let original_config=profile::read_auth(&temp.path.join("config.toml")).unwrap();
            let mut db=Connection::open_in_memory().unwrap();
            db.execute_batch(crate::core::database::CODEX_PROVIDER_BACKUPS_SCHEMA).unwrap();
            let version=preview(&db,&temp.path).unwrap().version;
            install_encrypted(&db,&temp.path,&version,"model = \"provider\"\n",&installed,encrypt).unwrap();
            profile::write_private(&temp.path.join("auth.json"),&rotated).unwrap();
            let prior=profile::fingerprint(Some(&installed));
            let state=|db:&Connection|db.query_row("SELECT content_ciphertext,installed_auth FROM codex_provider_config_backups",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).unwrap();
            let before=state(&db);
            assert!(record_oauth_rotation_encrypted(&db,&temp.path,"stale",&rotated,decrypt,encrypt).is_err());
            assert!(record_oauth_rotation_encrypted(&db,&temp.path,&prior,&rotated,decrypt,|_|Err("fixture encryption failure".into())).is_err());
            assert_eq!(state(&db),before);
            {
                let tx=db.transaction().unwrap();
                record_oauth_rotation_encrypted(&tx,&temp.path,&prior,&rotated,decrypt,encrypt).unwrap();
                // Simulate a later failure in the encompassing OAuth sync transaction.
            }
            assert_eq!(state(&db),before);
            let tx=db.transaction().unwrap();
            record_oauth_rotation_encrypted(&tx,&temp.path,&prior,&rotated,decrypt,encrypt).unwrap();
            tx.commit().unwrap();
            assert_eq!(state(&db).1,profile::fingerprint(Some(&rotated)));
            restore_decrypted(&db,&temp.path,decrypt).unwrap();
            let restored=profile::read_auth(&temp.path.join("auth.json")).unwrap();
            assert!(restored.as_str()==if same_owner {rotated.as_str()} else {original.as_str()});
            assert!(profile::read_auth(&temp.path.join("config.toml")).unwrap().as_str()==original_config.as_str());
        }
    }
    #[test]
    fn interrupted_auth_write_keeps_a_recovery_point_when_compensation_is_blocked() {
        let temp=profile::TemporaryProfile::new("{}").unwrap();
        let db=Connection::open_in_memory().unwrap();
        db.execute_batch(crate::core::database::CODEX_PROVIDER_BACKUPS_SCHEMA).unwrap();
        fs::remove_file(temp.path.join("auth.json")).unwrap();
        let original_config=profile::read_auth(&temp.path.join("config.toml")).unwrap();
        let before=preview(&db,&temp.path).unwrap();
        let encrypt=|value:&str|crate::core::crypto::encrypt_secret_with_key(value,&[23;32]);
        let write=|path:&Path,value:&str| {
            profile::write_private(path,value)?;
            if path.file_name().is_some_and(|name|name=="config.toml") {
                // Block the second write and its compensation after installing config.
                fs::create_dir(temp.path.join("auth.json")).unwrap();
            }
            Ok(())
        };
        assert!(install_with_writer(&db,&temp.path,&before.version,"model = \"provider\"\n","{}",encrypt,write).is_err());
        assert_eq!(db.query_row("SELECT COUNT(*) FROM codex_provider_config_backups",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert!(profile::read_auth(&temp.path.join("config.toml")).unwrap().as_str()==original_config.as_str());
        fs::remove_dir(temp.path.join("auth.json")).unwrap();
        restore_decrypted(&db,&temp.path,|value|crate::core::crypto::decrypt_secret_with_key(value,&[23;32])).unwrap();
        assert_eq!(preview(&db,&temp.path).unwrap().version,before.version);
        assert!(!temp.path.join("auth.json").exists());
    }
    #[test]
    fn failed_second_write_compensates_and_clears_the_recovery_point() {
        for auth_exists in [true,false] {
            let temp=profile::TemporaryProfile::new("{}").unwrap();
            if !auth_exists {fs::remove_file(temp.path.join("auth.json")).unwrap();}
            let db=Connection::open_in_memory().unwrap();
            db.execute_batch(crate::core::database::CODEX_PROVIDER_BACKUPS_SCHEMA).unwrap();
            let before=preview(&db,&temp.path).unwrap();
            let encrypt=|value:&str|crate::core::crypto::encrypt_secret_with_key(value,&[23;32]);
            let write=|path:&Path,value:&str| {
                if path.file_name().is_some_and(|name|name=="auth.json") {return Err("fixture write failure".into());}
                profile::write_private(path,value)
            };
            assert!(install_with_writer(&db,&temp.path,&before.version,"model = \"provider\"\n","{}",encrypt,write).is_err());
            let after=preview(&db,&temp.path).unwrap();
            assert_eq!(after.version,before.version);
            assert!(!after.has_backup);
            assert_eq!(temp.path.join("auth.json").exists(),auth_exists);
        }
    }
    #[test]
    fn changes_during_backup_encryption_are_not_overwritten() {
        for file in ["config.toml","auth.json"] {
            let temp=profile::TemporaryProfile::new("{}").unwrap();
            let db=Connection::open_in_memory().unwrap();
            db.execute_batch(crate::core::database::CODEX_PROVIDER_BACKUPS_SCHEMA).unwrap();
            let before=preview(&db,&temp.path).unwrap();
            let external=if file=="config.toml" {"model = \"external\"\n"} else {"{\"external\":true}"};
            let encrypt=|value:&str| {
                profile::write_private(&temp.path.join(file),external).unwrap();
                crate::core::crypto::encrypt_secret_with_key(value,&[23;32])
            };
            assert!(install_encrypted(&db,&temp.path,&before.version,"model = \"provider\"\n","{}",encrypt).is_err());
            assert!(profile::read_auth(&temp.path.join(file)).unwrap().as_str()==external);
            assert!(!preview(&db,&temp.path).unwrap().has_backup);
        }
    }
    #[test]
    fn encrypted_recovery_restores_repeatedly_and_overwrites_external_edits() {
        let temp=profile::TemporaryProfile::new("{}").unwrap();
        let db=Connection::open_in_memory().unwrap(); db.execute_batch(crate::core::database::CODEX_PROVIDER_BACKUPS_SCHEMA).unwrap();
        profile::write_private(&temp.path.join("config.toml"),"model = \"old\"\n").unwrap();
        let previous=preview(&db,&temp.path).unwrap();
        let encrypt=|v:&str|crate::core::crypto::encrypt_secret_with_key(v,&[23;32]);
        let decrypt=|v:&str|crate::core::crypto::decrypt_secret_with_key(v,&[23;32]);
        assert!(install_encrypted(&db,&temp.path,"stale","model = \"new\"\n","{}",encrypt).is_err());
        install_encrypted(&db,&temp.path,&previous.version,"model = \"new\"\n","{}",encrypt).unwrap();
        let cipher:String=db.query_row("SELECT content_ciphertext FROM codex_provider_config_backups",[],|r|r.get(0)).unwrap(); assert!(!cipher.contains("old"));
        profile::write_private(&temp.path.join("config.toml"),"model = \"external\"\n").unwrap();
        restore_decrypted(&db,&temp.path,decrypt).unwrap();
        assert_eq!(preview(&db,&temp.path).unwrap().version,previous.version);
        restore_decrypted(&db,&temp.path,decrypt).unwrap();
    }
    #[test]
    fn provider_catalog_lists_provider_models_and_is_removed_on_restore() {
        let temp=profile::TemporaryProfile::new("{}").unwrap();
        let settings=super::super::providers::ModelSettings{models:vec!["model-a".into(),"model-b".into()],context_window:Some(65536),..Default::default()};
        install_catalog(&temp.path,&settings).unwrap();
        let text=profile::read_auth(&temp.path.join(CATALOG_FILE)).unwrap();
        let catalog:serde_json::Value=serde_json::from_str(text.as_str()).unwrap();
        let models=catalog["models"].as_array().unwrap();
        assert_eq!(models.len(),2);
        assert_eq!(models[0]["slug"],json!("model-a"));
        assert_eq!(models[0]["display_name"],json!("model-a"));
        assert_eq!(models[0]["context_window"],json!(65536));
        assert!(models[0].get("supported_reasoning_levels").is_some());
        assert_eq!(models[0]["truncation_policy"],json!({"limit":10000,"mode":"tokens"}));
        crate::core::codex::model_catalog::validate(&catalog).unwrap();
        assert!(!crate::core::codex::model_catalog::needs_rebuild(&temp.path.join(CATALOG_FILE)));
        remove_catalog(&temp.path);
        assert!(!temp.path.join(CATALOG_FILE).exists());
        assert!(!temp.path.join("cloudhub-model-catalog.meta.json").exists());
    }
    #[test]
    fn provider_catalog_keeps_every_field_of_an_existing_catalog() {
        let temp=profile::TemporaryProfile::new("{}").unwrap();
        profile::write_private(&temp.path.join("cockpit-model-catalog.json"),&json!({"models":[{"slug":"gpt-5.6-sol","display_name":"gpt-5.6-sol","context_window":272000,"base_instructions":"keep me","supported_reasoning_levels":[{"effort":"low"}]}]}).to_string()).unwrap();
        let settings=super::super::providers::ModelSettings{models:vec!["vendor-model".into()],..Default::default()};
        install_catalog(&temp.path,&settings).unwrap();
        let text=profile::read_auth(&temp.path.join(CATALOG_FILE)).unwrap();
        let catalog:serde_json::Value=serde_json::from_str(text.as_str()).unwrap();
        let entry=&catalog["models"][0];
        assert_eq!(entry["slug"],json!("vendor-model"));
        assert_eq!(entry["base_instructions"],json!("keep me"));
        assert_eq!(entry["supported_reasoning_levels"][0]["effort"],json!("low"));
    }
    #[test]
    fn provider_catalog_backfills_fields_missing_from_an_older_template() {
        let temp=profile::TemporaryProfile::new("{}").unwrap();
        profile::write_private(&temp.path.join("cockpit-model-catalog.json"),&json!({"models":[{"slug":"gpt-5.6-sol","context_window":272000}]}).to_string()).unwrap();
        let settings=super::super::providers::ModelSettings{models:vec!["vendor-model".into()],..Default::default()};
        install_catalog(&temp.path,&settings).unwrap();
        let text=profile::read_auth(&temp.path.join(CATALOG_FILE)).unwrap();
        let catalog:serde_json::Value=serde_json::from_str(text.as_str()).unwrap();
        let entry=&catalog["models"][0];
        assert_eq!(entry["truncation_policy"],json!({"limit":10000,"mode":"tokens"}));
        assert_eq!(entry["shell_type"],json!("shell_command"));
        assert_eq!(entry["context_window"],json!(200000));
    }
    #[test]
    fn provider_catalog_ignores_a_template_that_is_not_a_model_object() {
        let catalog=build_catalog(&super::super::providers::ModelSettings{models:vec!["model-a".into()],..Default::default()},Some(json!("gpt-5.6-sol")));
        assert_eq!(catalog["models"][0]["slug"],json!("model-a"));
        assert_eq!(catalog["models"][0]["truncation_policy"],json!({"limit":10000,"mode":"tokens"}));
    }
    #[test]
    fn restore_returns_a_user_owned_catalog_and_removes_only_ours() {
        for owned in [true,false] {
            let temp=profile::TemporaryProfile::new("{}").unwrap();
            if owned {profile::write_private(&temp.path.join(CATALOG_FILE),r#"{"models":[{"slug":"user-model"}]}"#).unwrap();}
            let db=Connection::open_in_memory().unwrap();
            db.execute_batch(crate::core::database::CODEX_PROVIDER_BACKUPS_SCHEMA).unwrap();
            let before=preview(&db,&temp.path).unwrap();
            let encrypt=|v:&str|crate::core::crypto::encrypt_secret_with_key(v,&[23;32]);
            let decrypt=|v:&str|crate::core::crypto::decrypt_secret_with_key(v,&[23;32]);
            install_encrypted(&db,&temp.path,&before.version,"model = \"provider\"\n","{}",encrypt).unwrap();
            install_catalog(&temp.path,&super::super::providers::ModelSettings{models:vec!["model-a".into()],..Default::default()}).unwrap();
            let written=profile::read_auth(&temp.path.join(CATALOG_FILE)).unwrap();
            assert_eq!(serde_json::from_str::<serde_json::Value>(written.as_str()).unwrap()["models"][0]["slug"],json!("model-a"));
            restore_decrypted(&db,&temp.path,decrypt).unwrap();
            if owned {
                let restored=profile::read_auth(&temp.path.join(CATALOG_FILE)).unwrap();
                assert_eq!(serde_json::from_str::<serde_json::Value>(restored.as_str()).unwrap()["models"][0]["slug"],json!("user-model"));
            } else {assert!(!temp.path.join(CATALOG_FILE).exists());}
        }
    }
    #[test]
    fn legacy_backups_without_catalog_ownership_never_delete_the_file() {
        let temp=profile::TemporaryProfile::new("{}").unwrap();
        profile::write_private(&temp.path.join(CATALOG_FILE),r#"{"models":[]}"#).unwrap();
        let original=profile::read_auth(&temp.path.join("config.toml")).unwrap().to_string();
        let db=Connection::open_in_memory().unwrap();
        db.execute_batch(crate::core::database::CODEX_PROVIDER_BACKUPS_SCHEMA).unwrap();
        let before=preview(&db,&temp.path).unwrap();
        let encrypt=|v:&str|crate::core::crypto::encrypt_secret_with_key(v,&[23;32]);
        let decrypt=|v:&str|crate::core::crypto::decrypt_secret_with_key(v,&[23;32]);
        install_encrypted(&db,&temp.path,&before.version,"model = \"provider\"\n","{}",encrypt).unwrap();
        // 旧版本备份没有 catalog 字段，恢复时不得据猜测删除用户文件。
        profile::write_private(&temp.path.join("config.toml"),&original).unwrap();
        let legacy=encrypt(&json!({"config":original,"auth":serde_json::Value::Null}).to_string()).unwrap();
        db.execute("UPDATE codex_provider_config_backups SET content_ciphertext=?1,installed_config=?2",[legacy,config_fingerprint(Some(&original))]).unwrap();
        install_catalog(&temp.path,&super::super::providers::ModelSettings{models:vec!["model-a".into()],..Default::default()}).unwrap();
        restore_decrypted(&db,&temp.path,decrypt).unwrap();
        assert!(temp.path.join(CATALOG_FILE).exists());
    }
    #[test]
    fn restore_overwrites_external_edits_with_the_backup() {
        let temp=profile::TemporaryProfile::new("{}").unwrap();
        let original=profile::read_auth(&temp.path.join("config.toml")).unwrap().to_string();
        let db=Connection::open_in_memory().unwrap();
        db.execute_batch(crate::core::database::CODEX_PROVIDER_BACKUPS_SCHEMA).unwrap();
        let before=preview(&db,&temp.path).unwrap();
        let encrypt=|v:&str|crate::core::crypto::encrypt_secret_with_key(v,&[23;32]);
        let decrypt=|v:&str|crate::core::crypto::decrypt_secret_with_key(v,&[23;32]);
        install_encrypted(&db,&temp.path,&before.version,"model = \"provider\"\n","{}",encrypt).unwrap();
        profile::write_private(&temp.path.join("config.toml"),"model = \"external\"\n").unwrap();
        // 恢复以首次切换前的备份为准，外部编辑不保留。
        restore_decrypted(&db,&temp.path,decrypt).unwrap();
        assert!(profile::read_auth(&temp.path.join("config.toml")).unwrap().as_str()==original.as_str());
        assert_eq!(preview(&db,&temp.path).unwrap().version,before.version);
    }
    #[test]
    fn catalog_key_ignores_multiline_strings_and_table_scoped_keys() {
        let text=set_catalog_key("model = \"previous\"\n[features]\nunified_exec = true\n[notes]\nmodel_catalog_json = \"keep\"\n");
        assert!(text.contains("[notes]\nmodel_catalog_json = \"keep\""));
        assert_eq!(text.matches(&format!("model_catalog_json = \"{CATALOG_FILE}\"")).count(),1);
        // 多行字符串里以该键或以方括号开头的行都是内容，不能被改写或当作表头。
        let multiline="model = \"previous\"\n[tui]\nnotice = \"\"\"\nmodel_catalog_json = \"literal\"\n[fake]\n\"\"\"\n";
        let text=set_catalog_key(multiline);
        assert!(text.contains("model_catalog_json = \"literal\""));
        assert!(text.contains("\n[fake]\n"));
        let key=text.find(&format!("model_catalog_json = \"{CATALOG_FILE}\"")).unwrap();
        assert!(key<text.find("[tui]").unwrap());
        // 注释里的三引号不是多行字符串定界符，否则后面的表头会被误判成字符串内容，
        // 顶层键会被追加到文件末尾落进表内而静默失效。
        let commented="model = \"previous\"\n# 提示：可用 \"\"\" 包裹长文本\n[features]\nunified_exec = true\n";
        let text=set_catalog_key(commented);
        assert!(text.contains("# 提示：可用 \"\"\" 包裹长文本\n"));
        assert!(text.find(&format!("model_catalog_json = \"{CATALOG_FILE}\"")).unwrap()<text.find("[features]").unwrap());
        // 前缀相同但不是同一个键的用户配置必须保留。
        let prefixed="model = \"previous\"\nmodel_catalog_json_path = \"user.json\"\n";
        let text=set_catalog_key(prefixed);
        assert!(text.contains("model_catalog_json_path = \"user.json\""));
        assert_eq!(text.matches(&format!("model_catalog_json = \"{CATALOG_FILE}\"")).count(),1);
    }
    #[test]
    fn catalog_key_is_written_before_any_section() {
        let config="model = \"previous\"\n[features]\nunified_exec = true\n";
        let text=set_catalog_key(config);
        let lines=text.lines().collect::<Vec<_>>();
        let key=lines.iter().position(|line|line.starts_with("model_catalog_json")).unwrap();
        let section=lines.iter().position(|line|line.starts_with('[')).unwrap();
        assert!(key<section);
        assert!(text.contains(&format!("model_catalog_json = \"{CATALOG_FILE}\"")));
        assert!(text.contains("unified_exec = true"));
        // 重复写入只保留一条，避免配置里出现多个顶层键。
        let again=set_catalog_key(&text);
        assert_eq!(again.matches("model_catalog_json").count(),1);
    }
    #[test]
    fn native_writer_generates_provider_and_preserves_other_config() {
        let temp=profile::TemporaryProfile::new("{} ").unwrap();
        profile::write_private(&temp.path.join("config.toml"),"model = \"previous\"\n[features]\nunified_exec = true\n").unwrap();
        let output=build_config(&temp.path,"https://example.com/v1","model-test",&super::super::providers::ModelSettings::default(),&uuid::Uuid::new_v4().to_string(),false).unwrap();
        assert!(output.contains("cloudhub_provider")); assert!(output.contains("unified_exec = true")); assert!(output.contains("https://example.com/v1"));
        assert!(output.contains(&format!("model_catalog_json = \"{CATALOG_FILE}\"")));
    }
}
