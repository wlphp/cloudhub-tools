use crate::core::{claude_providers::ClaudeProvider, error::{PlatformError,PlatformResult}, repositories::claude_providers as repo};
use rusqlite::Connection;
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use std::sync::Mutex;
use tauri_plugin_dialog::DialogExt;

static PENDING: Mutex<Option<(String,Vec<ClaudeProvider>)>> = Mutex::new(None);

pub(super) fn cancel()->PlatformResult<Value>{
    *PENDING.lock().map_err(|_|error("导入状态不可用"))?=None;
    Ok(Value::Null)
}

pub(super) fn error(message: &str)->PlatformError {
    PlatformError {kind:"platform-error",code:"claude-provider-transfer",message:message.into(),retryable:false}
}

#[derive(Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
struct Package { format:String, version:u32, providers:Vec<ClaudeProvider> }

pub(super) fn prepare(app:&tauri::AppHandle)->PlatformResult<Value>{
    *PENDING.lock().map_err(|_|error("导入状态不可用"))?=None;
    let Some(file)=app.dialog().file().add_filter("供应商 JSON", &["json"]).blocking_pick_file() else {return Ok(Value::Null)};
    let path=file.into_path().map_err(|_|error("文件路径无效"))?;
    let metadata=std::fs::symlink_metadata(&path).map_err(|_|error("无法读取导入文件"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len()>8*1024*1024 {return Err(error("请选择不超过 8 MB 的普通 JSON 文件"))}
    use std::io::Read;
    let mut bytes=zeroize::Zeroizing::new(Vec::new());
    std::fs::File::open(&path).map_err(|_|error("无法读取导入文件"))?.take(8*1024*1024+1).read_to_end(&mut bytes).map_err(|_|error("无法读取导入文件"))?;
    if bytes.len()>8*1024*1024{return Err(error("导入文件超过 8 MB"))}
    let package:Package=serde_json::from_slice(&bytes).map_err(|_|error("文件格式无效，请选择 CloudHub 供应商导出文件"))?;
    if package.format!="cloudhub-claude-providers" || package.version!=1 || package.providers.is_empty() || package.providers.len()>500 {return Err(error("文件版本或供应商数量无效（支持 1–500 条）"))}
    if package.providers.iter().any(|p|p.api_key.starts_with("cloudhub-encrypted:")){return Err(error("导入文件包含设备加密密钥，请使用明文 JSON 导出文件"))}
    let token=uuid::Uuid::new_v4().to_string();
    let summaries:Vec<Value>=package.providers.iter().enumerate().map(|(index,p)|json!({"index":index,"name":p.name,"baseUrl":p.base_url})).collect();
    *PENDING.lock().map_err(|_|error("导入状态不可用"))?=Some((token.clone(),package.providers));
    Ok(json!({"token":token,"providers":summaries}))
}

pub(super) fn import(conn:&Connection,token:&str,indices:&[usize])->PlatformResult<Value>{
    if indices.is_empty() || indices.len()>500 {return Err(error("请选择要导入的供应商"))}
    let mut pending=PENDING.lock().map_err(|_|error("导入状态不可用"))?;
    let (saved_token,providers)=pending.as_ref().ok_or_else(||error("导入预览已失效，请重新选择文件"))?;
    if saved_token!=token {return Err(error("导入预览已失效，请重新选择文件"))}
    let mut seen=std::collections::HashSet::new();
    let mut existing=repo::list_providers(conn)?;
    let tx=conn.unchecked_transaction().map_err(|_|error("无法开始导入"))?;
    let mut count=0;
    for index in indices {
        if !seen.insert(index){return Err(error("导入选择包含重复项"))}
        let mut provider=providers.get(*index).ok_or_else(||error("导入选择已失效"))?.clone();
        if existing.iter().any(|p| p.base_url==provider.base_url && p.api_key==provider.api_key && p.models==provider.models && p.api_format==provider.api_format && p.api_key_field==provider.api_key_field && p.official_login==provider.official_login && p.model_catalog==provider.model_catalog && p.extra_env==provider.extra_env && p.user_agent==provider.user_agent && p.proxy_header_override==provider.proxy_header_override && p.proxy_body_override==provider.proxy_body_override && p.fallback_model==provider.fallback_model && p.is_full_url==provider.is_full_url){continue}
        provider.id=format!("imported-{}",uuid::Uuid::new_v4());
        repo::save_provider(&tx,&provider,chrono::Utc::now().timestamp_millis())?;
        existing.push(provider); count+=1;
    }
    tx.commit().map_err(|_|error("导入保存失败，未修改记录"))?;
    *pending=None;
    Ok(json!({"imported":count,"skipped":indices.len()-count}))
}

pub(super) fn export(app:&tauri::AppHandle,providers:&[ClaudeProvider],ids:&[String])->PlatformResult<Value>{
    if ids.is_empty() || ids.len()>500 {return Err(error("请选择 1–500 条供应商记录"))}
    let mut selected=Vec::new();
    let mut seen=std::collections::HashSet::new();
    for id in ids {
        if !seen.insert(id){return Err(error("选择包含重复记录"))}
        let mut p=providers.iter().find(|p|&p.id==id).ok_or_else(||error("所选记录不存在，请刷新后重试"))?.clone();
        p.extra_env.remove(repo::IS_CURRENT_MARKER);selected.push(p);
    }
    let Some(file)=app.dialog().file().set_file_name("cloudhub-claude-providers.json").add_filter("供应商 JSON（含明文 Key）", &["json"]).blocking_save_file() else {return Ok(json!(false))};
    let path=file.into_path().map_err(|_|error("导出路径无效"))?;
    let bytes=zeroize::Zeroizing::new(serde_json::to_vec_pretty(&Package{format:"cloudhub-claude-providers".into(),version:1,providers:selected}).map_err(|_|error("导出失败"))?);
    if bytes.len()>8*1024*1024 {return Err(error("导出内容超过 8 MB，请分批导出"))}
    std::fs::write(path,bytes.as_slice()).map_err(|_|error("无法保存导出文件"))?;
    Ok(json!(true))
}

pub(super) fn delete(conn:&Connection,providers:&[ClaudeProvider],ids:&[String])->PlatformResult<Value>{
    if ids.is_empty() || ids.len()>500 {return Err(error("请选择 1–500 条供应商记录"))}
    let current=crate::core::claude_workspace::current_provider(conn)?;
    let mut seen=std::collections::HashSet::new();
    for id in ids {
        if !seen.insert(id){return Err(error("选择包含重复记录"))}
        let p=providers.iter().find(|p|&p.id==id).ok_or_else(||error("所选记录不存在，请刷新后重试"))?;
        if current.as_ref()==Some(id) || p.extra_env.contains_key(repo::IS_CURRENT_MARKER){return Err(error(&format!("无法批量删除：「{}」是当前供应商，请先切换；未删除任何记录",p.name)))}
    }
    let tx=conn.unchecked_transaction().map_err(|_|error("无法开始批量删除"))?;
    for id in ids {repo::delete_provider(&tx,id)?;}
    tx.commit().map_err(|_|error("批量删除失败，未删除任何记录"))?;
    Ok(json!({"deleted":ids.len()}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plaintext_package_round_trip_keeps_provider_settings() {
        let mut provider=repo::presets().remove(1);
        provider.api_key="test-only-transfer-key".into();
        provider.model_catalog.push(crate::core::claude_providers::ModelMapping {model:"test-model".into(),display_name:"测试模型".into(),supports_1m:true});
        let package=Package {format:"cloudhub-claude-providers".into(),version:1,providers:vec![provider.clone()]};
        let bytes=serde_json::to_vec(&package).unwrap();
        let document:Value=serde_json::from_slice(&bytes).unwrap();
        assert_eq!(document["providers"][0]["apiKey"],"test-only-transfer-key");
        let decoded:Package=serde_json::from_slice(&bytes).unwrap();
        assert_eq!(decoded.providers[0],provider);
    }
    #[test]
    fn rejects_malformed_packages() {
        assert!(serde_json::from_str::<Package>(r#"{"format":"cloudhub-claude-providers","version":1}"#).is_err());
        assert!(serde_json::from_str::<Package>(r#"{"format":"cloudhub-claude-providers","version":1,"providers":[],"unexpected":true}"#).is_err());
    }
}
