//! Read documented provider JSON fields only. Never apply imported config/auth blobs.
use super::providers::{self,ModelSettings,ProviderInput,ProviderKeyInput};
use crate::core::storage::encrypt_secret;
use rusqlite::{Connection,params};
use serde::Serialize;
use serde_json::Value;
use std::{ops::Deref, time::{Duration,Instant}};
use zeroize::Zeroize;

pub struct ImportDraft {pub token:String,pub expires:Instant,pub rows:Vec<ProviderInput>}
impl Drop for ImportDraft {fn drop(&mut self){for row in &mut self.rows{for key in &mut row.keys{key.secret.zeroize();}}}}

pub fn take_draft(slot:&mut Option<ImportDraft>,token:Option<&str>)->Result<ImportDraft,String> {
    if slot.as_ref().is_some_and(|draft|draft.expires<=Instant::now()) {*slot=None;}
    if !slot.as_ref().is_some_and(|draft|Some(draft.token.as_str())==token) {
        return Err("导入预览已过期，请重新选择文件".into());
    }
    slot.take().ok_or_else(||"导入预览已过期，请重新选择文件".into())
}
struct SensitiveValue(Value);
impl Deref for SensitiveValue {type Target=Value;fn deref(&self)->&Self::Target{&self.0}}
impl Drop for SensitiveValue {
    fn drop(&mut self) {
        fn scrub(value:&mut Value) {
            match value {
                Value::String(text)=>text.zeroize(),
                Value::Array(values)=>for value in values{scrub(value);},
                Value::Object(values)=>for value in values.values_mut(){scrub(value);},
                _=>{},
            }
        }
        scrub(&mut self.0);
    }
}
struct SensitiveKeys(Vec<ProviderKeyInput>);
impl Drop for SensitiveKeys {fn drop(&mut self){for key in &mut self.0{key.secret.zeroize();}}}
struct SensitiveRows(Vec<ProviderInput>);
impl Drop for SensitiveRows {fn drop(&mut self){for row in &mut self.0{for key in &mut row.keys{key.secret.zeroize();}}}}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct ImportSummary {pub token:String,pub providers:Vec<ImportRow>,pub warnings:Vec<&'static str>}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct ImportRow {pub name:String,pub base_url:String,pub wire_api:String,pub models:Vec<String>,pub key_count:usize,pub duplicate:bool}

fn string(value:&Value,key:&str)->String {value[key].as_str().unwrap_or("").to_owned()}
fn strings(value:&Value)->Vec<String> {value.as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()}
/// 读取导出的模型设置，缺失的字段保持默认。
fn settings_of(value:&Value)->ModelSettings {
    ModelSettings{
        models:strings(&value["models"]),
        models_scoped:value["modelsScoped"].as_bool().unwrap_or(true),
        default_model:value["defaultModel"].as_str().map(str::to_owned),
        context_window:value["contextWindow"].as_i64(),
        compact_limit:value["compactLimit"].as_i64(),
    }
}

pub fn prepare(conn:&Connection,text:&str)->Result<(ImportDraft,ImportSummary),String> {
    if text.is_empty()||text.len()>2*1024*1024{return Err("供应商导入文件须为不超过 2 MB 的 JSON".into());}
    let root=SensitiveValue(serde_json::from_str(text).map_err(|_| "供应商导入文件不是有效 JSON")?);
    let cpp=root.get("relayProfiles").is_some();
    // 本应用导出的明文文件也支持导入，密钥按原值读取。
    let own=super::provider_export::providers_of(&root).is_some();
    let values=if cpp{root["relayProfiles"].as_array()}else if own{root["providers"].as_array()}else{root.as_array()}.ok_or("请选择 Cockpit 供应商数组、CodexPlusPlus 设置 JSON 或本应用导出的配置文件")?;
    if values.is_empty()||values.len()>100{return Err("每次可导入 1 至 100 个供应商".into());}
    let existing=providers::list(conn)?;
    let mut inputs=SensitiveRows(Vec::new());let mut summaries=Vec::new();let mut seen=std::collections::HashSet::new();
    let mut warnings=vec!["实例、OAuth 绑定及补丁设置不迁移；导入不会应用配置或启动客户端"];
    for (index,value) in values.iter().enumerate() {
        let wire=string(value,if cpp{"protocol"}else{"wireApi"});
        let wire=match wire.as_str(){"responses"=>"responses","chatCompletions"|"chat_completions"=>"chat_completions",_=>return Err("导入协议缺失或不支持，未导入任何供应商".into())};
        if cpp && matches!(value["relayMode"].as_str(),Some("official"|"aggregate")) {return Err("请仅导入第三方 API 配置；官方和聚合配置不能按普通供应商导入".into());}
        let models=if own{strings(&value["models"])}else if cpp{string(value,"modelList").split(|c|c=='\n'||c==','||c=='\r').map(str::trim).filter(|v|!v.is_empty()).map(str::to_owned).collect()}else{strings(&value["modelCatalog"])};
        let mut keys=SensitiveKeys(Vec::new());
        if own {
            for key in value["keys"].as_array().ok_or("导入供应商缺少密钥列表")? {
                let secret=string(key,"secret");
                if secret.is_empty(){return Err("导入配置缺少密钥内容，未导入任何供应商".into());}
                keys.0.push(ProviderKeyInput{id:None,name:string(key,"name"),secret:Some(secret),settings:settings_of(&key["settings"])});
            }
        } else {
            for key in value["apiKeys"].as_array().ok_or("导入供应商缺少密钥列表")? {
                let overrides=if cpp{vec![]}else{strings(&key["modelCatalog"])};
                keys.0.push(ProviderKeyInput{id:None,name:string(key,"name"),secret:Some(string(key,"apiKey")),settings:ModelSettings{models:overrides,..Default::default()}});
            }
        }
        let context=if cpp{value["contextWindow"].as_str().filter(|s|!s.trim().is_empty()).map(|s|s.parse::<i64>().map_err(|_| "导入上下文窗口无效")).transpose()?}else{None};
        let compact=if cpp{value["autoCompactLimit"].as_str().filter(|s|!s.trim().is_empty()).map(|s|s.parse::<i64>().map_err(|_| "导入压缩阈值无效")).transpose()?}else{None};
        let settings=if own{settings_of(&value["settings"])}else{ModelSettings{context_window:context,compact_limit:compact,..Default::default()}};
        if value.get("modelContextWindows").is_some() || value.get("modelWindows").is_some() || value.get("supportsVision").is_some() {
            if !warnings.contains(&"逐模型上下文和视觉能力元数据未迁移，请导入后核对") {warnings.push("逐模型上下文和视觉能力元数据未迁移，请导入后核对");}
        }
        let input=ProviderInput{id:None,version:None,name:string(value,"name"),base_url:string(value,if cpp{"upstreamBaseUrl"}else{"baseUrl"}).trim_end_matches('/').to_owned(),wire_api:wire.into(),models,note:String::new(),keys:std::mem::take(&mut keys.0),settings};
        if let Err(reason)=providers::validate(&input) {
            let label=if input.name.trim().is_empty(){format!("第 {} 个",index+1)}else{format!("「{}」",input.name.trim())};
            let mut input=input;
            for key in &mut input.keys {key.secret.zeroize();}
            return Err(format!("供应商{label}无法导入：{reason}。未导入任何供应商"));
        }
        let url=reqwest::Url::parse(&input.base_url).map_err(|_| "供应商地址无效")?;
        // 第三方配置里的回环地址通常意味着"本地代理"，不是真实上游，必须拒绝。
        // 本应用自己的导出文件则不同：本地供应商是用户在本机显式创建的合法配置，
        // 导出再导入属于正常往返，不能因此被拒。
        if !own&&super::provider_probe::loopback(&url) {
            let mut input=input;
            for key in &mut input.keys {key.secret.zeroize();}
            return Err("导入地址指向本地代理，请改为真实上游地址后导入".into());
        }
        // Any same-origin/path/protocol entry requires deliberate manual merging;
        // never silently overwrite existing encrypted keys based on a name.
        let identity=(input.base_url.clone(),input.wire_api.clone());
        let duplicate=existing.iter().any(|v|v.base_url==input.base_url&&v.wire_api==input.wire_api)||!seen.insert(identity);
        summaries.push(ImportRow{name:input.name.clone(),base_url:input.base_url.clone(),wire_api:input.wire_api.clone(),models:input.models.clone(),key_count:input.keys.len(),duplicate});
        if !duplicate {inputs.0.push(input);}
        else {
            let mut input=input;
            for key in &mut input.keys {key.secret.zeroize();}
        }
    }
    let token=uuid::Uuid::new_v4().to_string();
    Ok((ImportDraft{token:token.clone(),expires:Instant::now()+Duration::from_secs(300),rows:std::mem::take(&mut inputs.0)},ImportSummary{token,providers:summaries,warnings}))
}

pub fn confirm(conn:&mut Connection,draft:&ImportDraft)->Result<Vec<providers::Provider>,String> {
    confirm_encrypted(conn,draft,encrypt_secret)
}

fn confirm_encrypted(conn:&mut Connection,draft:&ImportDraft,encrypt:impl Fn(&str)->Result<String,String>)->Result<Vec<providers::Provider>,String> {
    if draft.expires<=Instant::now(){return Err("导入预览已过期，请重新选择文件".into());}
    let mut encrypted=Vec::new();
    for row in &draft.rows {
        let keys=row.keys.iter().map(|key|encrypt(key.secret.as_deref().ok_or("导入密钥缺失")?).map(|cipher|(key,cipher))).collect::<Result<Vec<_>,_>>()?;
        encrypted.push((row,keys));
    }
    let tx=conn.transaction().map_err(|_| "导入供应商失败")?;
    for (row,keys) in encrypted {
        let duplicate:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM codex_model_providers WHERE base_url=?1 AND wire_api=?2)",params![row.base_url,row.wire_api],|r|r.get(0)).map_err(|_| "检查导入重复项失败")?;
        if duplicate{return Err("供应商目录已变更，请重新预览导入".into());}
        let id=uuid::Uuid::new_v4().to_string();
        tx.execute("INSERT INTO codex_model_providers(id,name,base_url,wire_api,models_json,note,version,settings_json) VALUES(?1,?2,?3,?4,?5,?6,1,?7)",params![id,row.name,row.base_url,row.wire_api,serde_json::to_string(&row.models).map_err(|_| "导入模型无效")?,row.note,serde_json::to_string(&row.settings).map_err(|_| "导入模型设置无效")?]).map_err(|_| "导入供应商失败")?;
        for (key,cipher) in keys {tx.execute("INSERT INTO codex_provider_keys(id,provider_id,name,ciphertext,settings_json) VALUES(?1,?2,?3,?4,?5)",params![uuid::Uuid::new_v4().to_string(),id,key.name,cipher,serde_json::to_string(&key.settings).map_err(|_| "导入密钥设置无效")?]).map_err(|_| "导入供应商密钥失败")?;}
    }
    tx.commit().map_err(|_| "导入供应商失败")?;providers::list(conn)
}

#[cfg(test)]
mod tests {
    use super::*;use serde_json::json;
    #[test]
    fn stale_confirmation_does_not_consume_the_current_draft() {
        let mut slot=Some(ImportDraft{token:"current".into(),expires:Instant::now()+Duration::from_secs(300),rows:vec![]});
        for token in [None,Some("older")] {
            assert!(take_draft(&mut slot,token).is_err());
            assert_eq!(slot.as_ref().unwrap().token,"current");
        }
        assert_eq!(take_draft(&mut slot,Some("current")).unwrap().token,"current");
        assert!(slot.is_none());
        assert!(take_draft(&mut slot,Some("current")).is_err());
        slot=Some(ImportDraft{token:"expired".into(),expires:Instant::now()-Duration::from_secs(1),rows:vec![]});
        assert!(take_draft(&mut slot,Some("expired")).is_err());
        assert!(slot.is_none());
    }
    fn database()->Connection {
        let db=Connection::open_in_memory().unwrap();db.execute_batch(super::super::providers::SCHEMA).unwrap();
        db.execute_batch("ALTER TABLE codex_model_providers ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'; ALTER TABLE codex_provider_keys ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}';").unwrap();db
    }
    #[test]
    fn cockpit_and_cpp_previews_never_return_keys_or_apply_config() {
        let db=database();let secret=uuid::Uuid::new_v4().to_string();
        let cockpit=json!([{"name":"fixture","baseUrl":"https://example.com/v1","wireApi":"responses","modelCatalog":["model-a"],"apiKeys":[{"name":"primary","apiKey":secret}]}]);
        let (draft,summary)=prepare(&db,&cockpit.to_string()).unwrap();
        assert_eq!(draft.rows.len(),1);assert!(!serde_json::to_string(&summary).unwrap().contains(&secret));assert!(providers::list(&db).unwrap().is_empty());
        let cpp=json!({"relayProfiles":[{"name":"fixture","upstreamBaseUrl":"https://example.com/v1","protocol":"chatCompletions","relayMode":"pureApi","modelList":"model-a\nmodel-b","contextWindow":"65536","apiKeys":[{"name":"primary","apiKey":secret}]}]});
        let (draft,summary)=prepare(&db,&cpp.to_string()).unwrap();assert_eq!(draft.rows[0].models.len(),2);assert_eq!(summary.providers[0].wire_api,"chat_completions");
        assert_eq!(draft.rows[0].settings.context_window,Some(65536));
    }
    #[test]
    fn import_blocks_proxy_loops_unknown_protocol_and_duplicate_entries() {
        let db=database();let key=uuid::Uuid::new_v4().to_string();
        let mut row=json!({"name":"fixture","baseUrl":"http://127.0.0.1:58169/v1","wireApi":"responses","modelCatalog":["model-a"],"apiKeys":[{"name":"primary","apiKey":key}]});
        assert!(prepare(&db,&json!([row.clone()]).to_string()).is_err());
        row["baseUrl"]=json!("http://[::1]:58169/v1");
        assert!(prepare(&db,&json!([row.clone()]).to_string()).is_err());
        row["baseUrl"]=json!("https://localhost/v1");
        assert!(prepare(&db,&json!([row.clone()]).to_string()).is_err());
        row["baseUrl"]=json!("http://example.com/v1");
        // 公网明文 HTTP 不再拒绝：拒绝的是把第三方配置指向本机回环代理。
        assert!(prepare(&db,&json!([row.clone()]).to_string()).is_ok());
        row["baseUrl"]=json!("https://example.com/v1");
        let (draft,summary)=prepare(&db,&json!([row.clone(),row.clone()]).to_string()).unwrap();assert_eq!(draft.rows.len(),1);assert!(summary.providers[1].duplicate);
        row["wireApi"]=json!("anthropic_messages");assert!(prepare(&db,&json!([row]).to_string()).is_err());
    }

    #[test]
    fn own_exports_round_trip_local_providers_that_import_rejects_from_third_party_files() {
        use crate::core::crypto::encrypt_secret_with_key;
        let mut db=database();
        let secret=uuid::Uuid::new_v4().to_string();
        // 本机显式创建的回环供应商。第三方格式导入会拒绝它，本应用自己的导出必须能还原。
        let source=json!({
            "format":super::super::provider_export::FORMAT,"version":1,
            "providers":[{
                "name":"local","baseUrl":"http://127.0.0.1:58169/v1","wireApi":"responses",
                "models":["model-a"],"note":"","settings":{"models":[],"modelsScoped":true},
                "keys":[{"name":"primary","secret":secret,"settings":{"models":["model-a"],"modelsScoped":true}}]
            }]
        });
        let (draft,summary)=prepare(&db,&source.to_string()).unwrap();
        assert_eq!(draft.rows.len(),1);
        assert_eq!(draft.rows[0].base_url,"http://127.0.0.1:58169/v1");
        assert_eq!(draft.rows[0].keys.len(),1);
        assert_eq!(draft.rows[0].keys[0].secret.as_deref(),Some(secret.as_str()));
        assert!(!summary.providers[0].duplicate);
        confirm_encrypted(&mut db,&draft,|value|encrypt_secret_with_key(value,&[13;32])).unwrap();
        let stored=providers::list(&db).unwrap().remove(0);
        assert_eq!(stored.base_url,"http://127.0.0.1:58169/v1");
        assert_eq!(stored.keys.len(),1);
        assert_eq!(stored.keys[0].name,"primary");
        assert_eq!(stored.keys[0].settings.models,vec!["model-a"]);
    }

    #[test]
    fn own_export_round_trips_realistic_multi_provider_shapes() {
        use crate::core::crypto::encrypt_secret_with_key;
        let mut db=database();
        // Mirrors a real export: a provider with a default model and a key-scoped model list,
        // a second provider inheriting its models, and a copy that duplicates the first by
        // base_url+wire_api (must be folded into the file, not imported twice).
        let doc=json!({"format":super::super::provider_export::FORMAT,"version":1,"providers":[
            {"name":"nightcc","baseUrl":"https://cc.example.com/v1","wireApi":"responses",
             "models":["23","MiniMax-M3","glm-5.3"],"note":"","settings":{"models":[],"modelsScoped":false,"defaultModel":"MiniMax-M3","contextWindow":null,"compactLimit":null},
             "keys":[{"name":"默认密钥","secret":"sk-a","settings":{"models":["23","MiniMax-M3","glm-5.3"],"modelsScoped":true,"defaultModel":null,"contextWindow":null,"compactLimit":null}}]},
            {"name":"sensenova","baseUrl":"https://token.example.com/v1","wireApi":"responses",
             "models":["deepseek-v4.1-flash","kimi-k3"],"note":"","settings":{"models":[],"modelsScoped":false,"defaultModel":null,"contextWindow":null,"compactLimit":null},
             "keys":[{"name":"默认密钥","secret":"sk-b","settings":{"models":[],"modelsScoped":false,"defaultModel":null,"contextWindow":null,"compactLimit":null}}]},
            {"name":"nightcc（副本）","baseUrl":"https://cc.example.com/v1","wireApi":"responses",
             "models":["23","MiniMax-M3","glm-5.3"],"note":"","settings":{"models":[],"modelsScoped":false,"defaultModel":"MiniMax-M3","contextWindow":null,"compactLimit":null},
             "keys":[{"name":"默认密钥","secret":"sk-c","settings":{"models":["23","MiniMax-M3","glm-5.3"],"modelsScoped":true,"defaultModel":null,"contextWindow":null,"compactLimit":null}}]}
        ]});
        let (draft,summary)=prepare(&db,&doc.to_string()).unwrap();
        assert_eq!(summary.providers.len(),3);
        assert!(summary.providers[2].duplicate,"copy sharing base_url+wire_api must be folded as duplicate");
        assert_eq!(draft.rows.len(),2);
        let nightcc=draft.rows.iter().find(|r|r.name=="nightcc").unwrap();
        assert_eq!(nightcc.settings.default_model.as_deref(),Some("MiniMax-M3"));
        assert_eq!(nightcc.keys[0].settings.models.len(),3);
        confirm_encrypted(&mut db,&draft,|v|encrypt_secret_with_key(v,&[7;32])).unwrap();
        let stored=providers::list(&db).unwrap();
        assert_eq!(stored.len(),2);
        let nightcc=stored.iter().find(|p|p.name=="nightcc").unwrap();
        assert_eq!(nightcc.models,vec!["23","MiniMax-M3","glm-5.3"]);
        assert_eq!(nightcc.keys.len(),1);
    }
    #[test]
    fn import_error_names_the_offending_provider_and_reason() {
        let db=database();
        // defaultModel not present in the provider's model list must fail with a precise message.
        let doc=json!([{"name":"broken","baseUrl":"https://example.com/v1","wireApi":"responses","modelCatalog":["model-a"],"apiKeys":[{"name":"primary","apiKey":"sk-x"}]}]);
        // The Cockpit array shape carries models under modelCatalog; craft an own-format doc with a bad default model instead.
        let own=json!({"format":super::super::provider_export::FORMAT,"version":1,"providers":[
            {"name":"broken","baseUrl":"https://example.com/v1","wireApi":"responses","models":["model-a"],"note":"",
             "settings":{"models":[],"modelsScoped":false,"defaultModel":"not-a-model","contextWindow":null,"compactLimit":null},
             "keys":[{"name":"primary","secret":"sk-x","settings":{"models":[],"modelsScoped":false,"defaultModel":null,"contextWindow":null,"compactLimit":null}}]}
        ]});
        let _ = doc;
        let error=match prepare(&db,&own.to_string()){ Ok(_)=>panic!("broken default model must not import"),Err(e)=>e };
        assert!(error.contains("broken"),"error must name the provider: {error}");
        assert!(error.contains("默认模型")||error.contains("上下文"),"error must state the reason: {error}");
    }
    #[test]
    fn confirmed_import_encrypts_keys_and_rolls_back_the_entire_batch() {
        use crate::core::crypto::{decrypt_secret_with_key,encrypt_secret_with_key};
        let mut db=database();
        let first_secret=uuid::Uuid::new_v4().to_string();
        let second_secret=uuid::Uuid::new_v4().to_string();
        let data=json!([
            {"name":"first","baseUrl":"https://first.example/v1","wireApi":"responses","modelCatalog":["model-a"],"apiKeys":[{"name":"primary","apiKey":first_secret}]},
            {"name":"second","baseUrl":"https://second.example/v1","wireApi":"responses","modelCatalog":["model-b"],"apiKeys":[{"name":"primary","apiKey":second_secret}]}
        ]);
        let (draft,summary)=prepare(&db,&data.to_string()).unwrap();
        assert_eq!(providers::list(&db).unwrap().len(),0);
        assert!(!serde_json::to_string(&summary).unwrap().contains(&first_secret));
        assert!(!serde_json::to_string(&summary).unwrap().contains(&second_secret));
        let values=confirm_encrypted(&mut db,&draft,|value|encrypt_secret_with_key(value,&[41;32])).unwrap();
        assert_eq!(values.len(),2);
        let mut statement=db.prepare("SELECT ciphertext FROM codex_provider_keys ORDER BY rowid").unwrap();
        let ciphers=statement.query_map([],|row|row.get::<_,String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
        assert_eq!(ciphers.len(),2);
        assert_eq!(decrypt_secret_with_key(&ciphers[0],&[41;32]).unwrap(),first_secret);
        assert_eq!(decrypt_secret_with_key(&ciphers[1],&[41;32]).unwrap(),second_secret);
        assert!(ciphers.iter().all(|cipher|!cipher.contains(&first_secret)&&!cipher.contains(&second_secret)));

        let mut rollback_db=database();
        rollback_db.execute_batch("CREATE TRIGGER reject_second_provider_key BEFORE INSERT ON codex_provider_keys WHEN NEW.name='reject' BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
        let rollback=json!([
            {"name":"first","baseUrl":"https://first.example/v1","wireApi":"responses","modelCatalog":["model-a"],"apiKeys":[{"name":"primary","apiKey":first_secret}]},
            {"name":"second","baseUrl":"https://second.example/v1","wireApi":"responses","modelCatalog":["model-b"],"apiKeys":[{"name":"reject","apiKey":second_secret}]}
        ]);
        let (draft,_)=prepare(&rollback_db,&rollback.to_string()).unwrap();
        assert!(confirm_encrypted(&mut rollback_db,&draft,|value|encrypt_secret_with_key(value,&[41;32])).is_err());
        assert_eq!(providers::list(&rollback_db).unwrap().len(),0);
        assert_eq!(rollback_db.query_row("SELECT COUNT(*) FROM codex_provider_keys",[],|row|row.get::<_,i64>(0)).unwrap(),0);
    }
}
