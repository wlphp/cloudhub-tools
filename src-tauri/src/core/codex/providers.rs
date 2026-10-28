use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use crate::core::storage::{encrypt_secret, decrypt_secret};
use zeroize::{Zeroize, Zeroizing};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct ModelSettings {
    #[serde(default)] pub models: Vec<String>,
    #[serde(default)] pub models_scoped: bool,
    pub default_model: Option<String>,
    pub context_window: Option<i64>,
    pub compact_limit: Option<i64>,
}

pub fn effective_settings(provider:&Provider,key:&KeySummary)->ModelSettings {
    let models=if key.settings.models_scoped || !key.settings.models.is_empty(){key.settings.models.clone()}else{provider.models.clone()};
    let default_model=key.settings.default_model.clone()
        .filter(|model|models.contains(model))
        .or_else(||provider.settings.default_model.clone().filter(|model|models.contains(model)));
    ModelSettings {
        models,
        models_scoped:true,
        default_model,
        context_window:key.settings.context_window.or(provider.settings.context_window),
        compact_limit:key.settings.compact_limit.or(provider.settings.compact_limit),
    }
}

fn validate_settings(settings:&ModelSettings,models:&[String])->Result<(),String> {
    if settings.default_model.as_ref().is_some_and(|v|!models.contains(v))
        || settings.context_window.is_some_and(|v|!(1024..=10_000_000).contains(&v))
        || settings.compact_limit.is_some_and(|v|v<1024 || v>settings.context_window.unwrap_or(10_000_000)) {
        return Err("默认模型或上下文参数无效".into());
    }
    Ok(())
}

#[cfg(test)]
pub const SCHEMA: &str = crate::core::database::CODEX_PROVIDERS_SCHEMA;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct ProviderKeyInput { pub id: Option<String>, pub name: String, pub secret: Option<String>, #[serde(default)] pub settings: ModelSettings }
impl Drop for ProviderKeyInput {
    fn drop(&mut self) {
        if let Some(secret)=&mut self.secret {secret.zeroize();}
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct ProviderInput {
    pub id: Option<String>, pub version: Option<i64>, pub name: String, pub base_url: String,
    pub wire_api: String, pub models: Vec<String>, pub note: String, pub keys: Vec<ProviderKeyInput>,
    #[serde(default)] pub settings: ModelSettings,
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct KeySummary { pub id: String, pub name: String, pub settings: ModelSettings }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Provider {
    pub id: String, pub version: i64, pub name: String, pub base_url: String,
    pub wire_api: String, pub models: Vec<String>, pub note: String, pub keys: Vec<KeySummary>,
    pub settings: ModelSettings,
}

pub fn validate(input: &ProviderInput) -> Result<(), String> {
    let url = reqwest::Url::parse(&input.base_url).map_err(|_| "供应商地址无效")?;
    // 与探测层保持一致：http 与 https 都允许填写，不对上游协议做限制。
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some()
        || input.base_url.len()>2048 { return Err("供应商地址无效".into()); }
    if input.name.trim().is_empty() || input.name.len()>100 || input.name.chars().any(char::is_control) || input.note.len()>2000
        || !matches!(input.wire_api.as_str(), "responses" | "chat_completions")
        || input.models.len()>200 || input.keys.is_empty() || input.keys.len()>50
        || input.models.iter().any(|v| v.is_empty() || v.len()>160 || !v.chars().all(|c| c.is_ascii_alphanumeric() || "-._/:".contains(c))) {
        return Err("供应商名称、协议、模型或密钥数量无效".into());
    }
    let mut names=std::collections::HashSet::new();
    if !input.settings.models.is_empty() {return Err("供应商模型请使用模型目录字段".into());}
    validate_settings(&input.settings,&input.models)?;
    let mut ids=std::collections::HashSet::new();
    for key in &input.keys {
        let models=if key.settings.models_scoped || !key.settings.models.is_empty(){&key.settings.models}else{&input.models};
        if models.len()>200 || models.iter().any(|v|!super::provider_probe::model_valid(v)) {return Err("密钥模型目录无效".into());}
        let inherited=ModelSettings { models:vec![],models_scoped:true,default_model:key.settings.default_model.clone().or_else(||input.settings.default_model.clone().filter(|model|models.contains(model))),context_window:key.settings.context_window.or(input.settings.context_window),compact_limit:key.settings.compact_limit.or(input.settings.compact_limit) };
        validate_settings(&inherited,models)?;
        if key.name.trim().is_empty() || key.name.len()>100 || key.name.chars().any(char::is_control) || !names.insert(key.name.trim())
            || key.id.as_ref().is_some_and(|id| uuid::Uuid::parse_str(id).is_err() || !ids.insert(id))
            || key.secret.as_ref().is_some_and(|s| s.trim().is_empty() || s.len()>8192 || s.chars().any(char::is_control)) {
            return Err("密钥名称重复或参数无效".into());
        }
    }
    if input.id.as_ref().is_some_and(|id| uuid::Uuid::parse_str(id).is_err()) { return Err("供应商标识无效".into()); }
    Ok(())
}

pub fn list(conn: &Connection) -> Result<Vec<Provider>, String> {
    let mut stmt=conn.prepare("SELECT id,name,base_url,wire_api,models_json,note,version,settings_json FROM codex_model_providers ORDER BY name COLLATE NOCASE,id").map_err(|_| "读取供应商失败")?;
    let rows=stmt.query_map([], |r| Ok(Provider { id:r.get(0)?,name:r.get(1)?,base_url:r.get(2)?,wire_api:r.get(3)?,models:serde_json::from_str(&r.get::<_,String>(4)?).unwrap_or_default(),note:r.get(5)?,version:r.get(6)?,keys:vec![],settings:serde_json::from_str(&r.get::<_,String>(7)?).unwrap_or_default() })).map_err(|_| "读取供应商失败")?;
    let mut values=rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| "读取供应商失败")?;
    for value in &mut values {
        let mut keys=conn.prepare("SELECT id,name,settings_json FROM codex_provider_keys WHERE provider_id=?1 ORDER BY name,id").map_err(|_| "读取供应商密钥失败")?;
        value.keys=keys.query_map([&value.id], |r| Ok(KeySummary{id:r.get(0)?,name:r.get(1)?,settings:serde_json::from_str(&r.get::<_,String>(2)?).unwrap_or_default()})).map_err(|_| "读取供应商密钥失败")?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| "读取供应商密钥失败")?;
    }
    Ok(values)
}

pub fn save(conn: &mut Connection, input: ProviderInput) -> Result<Vec<Provider>, String> {
    save_encrypted(conn,input, encrypt_secret)
}

pub fn duplicate(conn: &mut Connection, source_id: &str, version: i64) -> Result<Vec<Provider>, String> {
    if uuid::Uuid::parse_str(source_id).is_err() { return Err("供应商标识无效".into()); }
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|_| "复制供应商失败")?;
    let original: String = tx.query_row(
        "SELECT name FROM codex_model_providers WHERE id=?1 AND version=?2",
        params![source_id, version], |row| row.get(0),
    ).map_err(|_| "供应商已被修改，请刷新后重试")?;
    let mut index = 1;
    let name = loop {
        let suffix = if index == 1 { "（副本）".to_owned() } else { format!("（副本 {}）", index) };
        let mut base = original.clone();
        while base.len() + suffix.len() > 100 { base.pop(); }
        let name = format!("{}{}", base.trim_end(), suffix);
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM codex_model_providers WHERE name=?1)", [&name], |row| row.get(0)).map_err(|_| "复制供应商失败")?;
        if !exists { break name; }
        index += 1;
    };
    let id = uuid::Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO codex_model_providers(id,name,base_url,wire_api,models_json,note,version,settings_json) SELECT ?1,?2,base_url,wire_api,models_json,note,1,settings_json FROM codex_model_providers WHERE id=?3 AND version=?4",
        params![id, name, source_id, version],
    ).map_err(|_| "复制供应商失败")?;
    let key_ids = {
        let mut stmt = tx.prepare("SELECT id FROM codex_provider_keys WHERE provider_id=?1").map_err(|_| "复制供应商失败")?;
        let rows = stmt.query_map([source_id], |row| row.get::<_, String>(0)).map_err(|_| "复制供应商失败")?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| "复制供应商失败")?
    };
    if key_ids.is_empty() { return Err("复制供应商失败".into()); }
    // Copy encrypted values inside SQLite. Each copy owns independent IDs;
    // credentials and runtime/account bindings never cross the UI boundary.
    for key_id in key_ids {
        tx.execute(
            "INSERT INTO codex_provider_keys(id,provider_id,name,ciphertext,settings_json) SELECT ?1,?2,name,ciphertext,settings_json FROM codex_provider_keys WHERE id=?3 AND provider_id=?4",
            params![uuid::Uuid::new_v4().to_string(), id, key_id, source_id],
        ).map_err(|_| "复制供应商失败")?;
    }
    tx.commit().map_err(|_| "复制供应商失败")?;
    list(conn)
}

pub fn is_provider_account(conn:&Connection,id:i64)->Result<bool,String> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM codex_provider_accounts WHERE account_id=?1)",[id],|r|r.get(0)).map_err(|_| "读取供应商账号关联失败".into())
}

pub fn ensure_home_unbound(conn:&Connection,home:&std::path::Path)->Result<(),String> {
    let bound:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM codex_provider_config_backups WHERE home=?1)",[home.to_string_lossy().as_ref()],|r|r.get(0)).map_err(|_| "读取供应商配置状态失败")?;
    if bound {Err("请先在模型供应商中恢复此目标的配置与登录".into())} else {Ok(())}
}

pub fn ensure_account_unbound(conn:&Connection,id:i64)->Result<(),String> {
    if super::provider_oauth::bound(conn,id)? {return Err("请先恢复关联实例的供应商配置，再删除账号".into());}
    let bound:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM codex_provider_bindings WHERE account_id=?1 OR previous_account_id=?1) OR (EXISTS(SELECT 1 FROM codex_provider_config_backups) AND EXISTS(SELECT 1 FROM codex_profiles WHERE account_id=?1))",[id],|r|r.get(0)).map_err(|_| "读取供应商绑定失败")?;
    if bound {Err("请先恢复关联实例的供应商配置，再删除账号".into())} else {Ok(())}
}

fn save_encrypted(conn: &mut Connection,input:ProviderInput,encrypt:impl Fn(&str)->Result<String,String>) -> Result<Vec<Provider>,String> {
    validate(&input)?;
    let id=input.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let tx=conn.transaction().map_err(|_| "保存供应商失败")?;
    let mut keys=Vec::new();
    for key in &input.keys {
        let key_id=key.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let old=if key.id.is_some() {
            Some(tx.query_row("SELECT ciphertext FROM codex_provider_keys WHERE id=?1 AND provider_id=?2",params![key_id,id],|r|r.get::<_,String>(0)).map_err(|_| "密钥已被修改，请刷新后重试")?)
        } else { None };
        let cipher=match &key.secret { Some(secret)=>encrypt(secret.trim()).map_err(|_| "加密供应商密钥失败")?,None=>old.ok_or("新密钥不能为空")? };
        keys.push((key_id,key.name.trim().to_owned(),cipher,serde_json::to_string(&key.settings).map_err(|_| "模型参数无效")?));
    }
    ensure_aggregate_keys_kept(&tx,&id,&keys)?;
    let models=serde_json::to_string(&input.models).map_err(|_| "模型参数无效")?;
    let settings=serde_json::to_string(&input.settings).map_err(|_| "模型参数无效")?;
    if input.id.is_some() {
        if tx.execute("UPDATE codex_model_providers SET name=?1,base_url=?2,wire_api=?3,models_json=?4,note=?5,version=version+1 WHERE id=?6 AND version=?7",params![input.name.trim(),input.base_url.trim_end_matches('/'),input.wire_api,models,input.note,id,input.version]).map_err(|_| "保存供应商失败")? !=1 { return Err("供应商已被修改，请刷新后重试".into()); }
    } else {
        tx.execute("INSERT INTO codex_model_providers(id,name,base_url,wire_api,models_json,note,version) VALUES(?1,?2,?3,?4,?5,?6,1)",params![id,input.name.trim(),input.base_url.trim_end_matches('/'),input.wire_api,models,input.note]).map_err(|_| "保存供应商失败")?;
    }
    tx.execute("DELETE FROM codex_provider_keys WHERE provider_id=?1",[&id]).map_err(|_| "保存供应商密钥失败")?;
    tx.execute("UPDATE codex_model_providers SET settings_json=?1 WHERE id=?2",params![settings,id]).map_err(|_| "保存供应商模型设置失败")?;
    for (key_id,name,cipher,settings) in keys { tx.execute("INSERT INTO codex_provider_keys(id,provider_id,name,ciphertext,settings_json) VALUES(?1,?2,?3,?4,?5)",params![key_id,id,name,cipher,settings]).map_err(|_| "保存供应商密钥失败")?; }
    // 上面的守卫已保证被引用的成员行不会被本次保存删掉，这里只清理历史遗留的悬空行。
    tx.execute("DELETE FROM codex_provider_aggregate_members WHERE provider_id=?1 AND key_id NOT IN (SELECT id FROM codex_provider_keys WHERE provider_id=?1)",[&id]).map_err(|_| "同步聚合供应商成员失败")?;
    tx.commit().map_err(|_| "保存供应商失败")?;
    list(conn)
}

pub fn remove(conn:&Connection,id:&str,version:i64)->Result<Vec<Provider>,String> {
    let tx=conn.unchecked_transaction().map_err(|_| "删除供应商失败")?;
    let mut affected=tx.prepare("SELECT DISTINCT aggregate_id FROM codex_provider_aggregate_members WHERE provider_id=?1").map_err(|_| "读取聚合供应商成员失败")?;
    let aggregate_ids=affected.query_map([id],|row|row.get::<_,String>(0)).map_err(|_| "读取聚合供应商成员失败")?.collect::<Result<Vec<_>,_>>().map_err(|_| "读取聚合供应商成员失败")?;
    drop(affected);
    tx.execute("DELETE FROM codex_provider_aggregate_members WHERE provider_id=?1",[id]).map_err(|_| "清理聚合供应商成员失败")?;
    for aggregate_id in aggregate_ids {
        let member_count:i64=tx.query_row("SELECT COUNT(*) FROM codex_provider_aggregate_members WHERE aggregate_id=?1",[&aggregate_id],|row|row.get(0)).map_err(|_| "检查聚合供应商成员失败")?;
        if member_count<2 {
            tx.execute("DELETE FROM codex_provider_aggregate_members WHERE aggregate_id=?1",[&aggregate_id]).map_err(|_| "清理无效聚合成员失败")?;
            tx.execute("DELETE FROM codex_provider_aggregates WHERE id=?1",[&aggregate_id]).map_err(|_| "清理无效聚合供应商失败")?;
        }
    }
    clear_managed_accounts(&tx,id)?;
    tx.execute("DELETE FROM codex_provider_bindings WHERE provider_id=?1",[&id]).map_err(|_| "清理供应商绑定失败")?;
    // 请求日志包含该供应商的明文参数与响应，随供应商一起删除。
    tx.execute("DELETE FROM codex_provider_request_logs WHERE provider_id=?1",[&id]).map_err(|_| "清理供应商请求日志失败")?;
    if tx.execute("DELETE FROM codex_model_providers WHERE id=?1 AND version=?2",params![id,version]).map_err(|_| "删除供应商失败")? !=1 {return Err("供应商已被修改，请刷新后重试".into());}
    tx.commit().map_err(|_| "删除供应商失败")?;
    list(conn)
}

/// 保存会整表重写该供应商的密钥。被聚合供应商引用的密钥若在本次保存中被移除，
/// 成员行与权重就会跟着消失，因此与删除整家供应商时一样，必须由用户先解绑。
fn ensure_aggregate_keys_kept(conn:&Connection,id:&str,kept:&[(String,String,String,String)])->Result<(),String> {
    let mut stmt=conn.prepare("SELECT key_id FROM codex_provider_aggregate_members WHERE provider_id=?1").map_err(|_| "读取聚合供应商成员失败")?;
    let referenced=stmt.query_map([id],|row|row.get::<_,String>(0)).map_err(|_| "读取聚合供应商成员失败")?.collect::<Result<Vec<_>,_>>().map_err(|_| "读取聚合供应商成员失败")?;
    drop(stmt);
    if referenced.iter().any(|key_id|!kept.iter().any(|(kept_id,..)|kept_id==key_id)) {
        return Err("该密钥仍被聚合供应商引用，请先从聚合供应商中移除此密钥".into());
    }
    Ok(())
}

fn clear_managed_accounts(conn:&Connection,id:&str)->Result<(),String> {
    let referenced:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM codex_profiles p JOIN codex_provider_accounts a ON a.account_id=p.account_id WHERE a.provider_id=?1)",[id],|r|r.get(0)).map_err(|_| "读取供应商账号关联失败")?;
    if referenced {return Err("供应商账号仍被实例引用，请先恢复或解绑实例".into());}
    conn.execute("DELETE FROM codex_accounts WHERE id IN (SELECT account_id FROM codex_provider_accounts WHERE provider_id=?1)",[id]).map_err(|_| "清理供应商旧凭据失败")?;
    conn.execute("DELETE FROM codex_provider_accounts WHERE provider_id=?1",[id]).map_err(|_| "清理供应商账号关联失败")?;
    Ok(())
}

pub fn credential(conn:&Connection,provider_id:&str,key_id:&str)->Result<Zeroizing<String>,String> {
    let cipher=conn.query_row("SELECT ciphertext FROM codex_provider_keys WHERE provider_id=?1 AND id=?2",params![provider_id,key_id],|r|r.get::<_,String>(0)).map_err(|_| "供应商密钥不存在")?;
    decrypt_secret(&cipher).map(Zeroizing::new).map_err(|_| "解密供应商密钥失败".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input()->ProviderInput { ProviderInput{id:None,version:None,name:"Test".into(),base_url:"https://example.com/v1".into(),wire_api:"responses".into(),models:vec!["model-test".into()],note:String::new(),settings:ModelSettings::default(),keys:vec![ProviderKeyInput{id:None,name:"Primary".into(),secret:Some(uuid::Uuid::new_v4().to_string()),settings:ModelSettings::default()}]} }
    #[test]
    fn validates_addresses_models_and_duplicate_keys() {
        let mut v=input(); assert!(validate(&v).is_ok());
        v.base_url="https://example.com/v1?credential=value".into(); assert!(validate(&v).is_err());
        v=input(); v.keys.push(v.keys[0].clone()); assert!(validate(&v).is_err());
        v=input(); v.models=vec!["bad\nmodel".into()]; assert!(validate(&v).is_err());
        v=input(); v.settings.context_window=Some(4096); v.settings.compact_limit=Some(8192); assert!(validate(&v).is_err());
        v=input(); v.settings.default_model=Some("missing".into()); assert!(validate(&v).is_err());
        v=input(); v.models=vec![]; assert!(validate(&v).is_ok());
        v=input(); v.base_url="http://example.com/v1".into(); assert!(validate(&v).is_ok());
        v=input(); v.base_url="http://127.0.0.1:8080/v1".into(); assert!(validate(&v).is_ok());
        v=input(); v.keys[0].settings.models=vec!["key-model".into()]; v.keys[0].settings.default_model=Some("key-model".into()); assert!(validate(&v).is_ok());
        v.settings.default_model=Some("model-test".into()); v.keys[0].settings.default_model=None;
        assert!(validate(&v).is_ok());
    }
    #[test]
    fn accepts_disjoint_key_scoped_catalogs_with_shared_default_when_available() {
        let mut v=input();
        v.models=vec!["model-a".into(),"model-b".into()];
        v.settings.default_model=Some("model-a".into());
        v.keys[0].settings=ModelSettings{models:vec!["model-a".into()],models_scoped:true,..Default::default()};
        v.keys.push(ProviderKeyInput {
            id:None,name:"Secondary".into(),secret:Some(uuid::Uuid::new_v4().to_string()),
            settings:ModelSettings{models:vec!["model-b".into()],models_scoped:true,..Default::default()},
        });
        assert!(validate(&v).is_ok());
        let provider=Provider {
            id:"provider".into(),version:1,name:v.name.clone(),base_url:v.base_url.clone(),wire_api:v.wire_api.clone(),
            models:v.models.clone(),note:String::new(),settings:v.settings.clone(),
            keys:vec![
                KeySummary{id:"key-a".into(),name:"Primary".into(),settings:v.keys[0].settings.clone()},
                KeySummary{id:"key-b".into(),name:"Secondary".into(),settings:v.keys[1].settings.clone()},
            ],
        };
        assert_eq!(effective_settings(&provider,&provider.keys[0]).default_model.as_deref(),Some("model-a"));
        assert_eq!(effective_settings(&provider,&provider.keys[1]).default_model,None);
    }
    #[test]
    fn encrypted_atomic_updates_keep_secrets_out_of_summary() {
        let mut db=Connection::open_in_memory().unwrap(); db.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE codex_provider_bindings(provider_id TEXT); CREATE TABLE codex_provider_accounts(account_id INTEGER,provider_id TEXT); CREATE TABLE codex_profiles(account_id INTEGER); CREATE TABLE codex_accounts(id INTEGER);").unwrap(); db.execute_batch(SCHEMA).unwrap(); db.execute_batch(crate::core::database::CODEX_PROVIDER_AGGREGATES_SCHEMA).unwrap(); db.execute_batch(crate::core::database::CODEX_PROVIDER_LOGS_SCHEMA).unwrap();
        db.execute_batch("ALTER TABLE codex_model_providers ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'; ALTER TABLE codex_provider_keys ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}';").unwrap();
        let source=input(); let secret=source.keys[0].secret.clone().unwrap();
        let encrypt=|v:&str|crate::core::crypto::encrypt_secret_with_key(v,&[19;32]);
        let saved=save_encrypted(&mut db,source,encrypt).unwrap().remove(0);
        assert!(!serde_json::to_string(&saved).unwrap().contains(&secret));
        let cipher:String=db.query_row("SELECT ciphertext FROM codex_provider_keys",[],|r|r.get(0)).unwrap(); assert!(!cipher.contains(&secret));
        let mut update=input(); update.id=Some(saved.id.clone()); update.version=Some(saved.version); update.keys[0].id=Some(saved.keys[0].id.clone()); update.keys[0].secret=None;
        save_encrypted(&mut db,update.clone(),encrypt).unwrap(); assert!(save_encrypted(&mut db,update,encrypt).is_err());
        remove(&db,&saved.id,2).unwrap(); assert!(list(&db).unwrap().is_empty());
        assert_eq!(db.query_row("SELECT COUNT(*) FROM codex_provider_keys",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }

    #[test]
    fn deleting_aggregate_member_cleans_database_references_and_invalid_aggregate() {
        let temp=super::super::profile::TemporaryProfile::new("{}").unwrap();
        let path=temp.path.join("providers.sqlite");
        let mut db=Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE codex_provider_bindings(provider_id TEXT); CREATE TABLE codex_provider_accounts(account_id INTEGER,provider_id TEXT); CREATE TABLE codex_profiles(account_id INTEGER); CREATE TABLE codex_accounts(id INTEGER);").unwrap();
        db.execute_batch(SCHEMA).unwrap();
        db.execute_batch(crate::core::database::CODEX_PROVIDER_AGGREGATES_SCHEMA).unwrap();
        db.execute_batch(crate::core::database::CODEX_PROVIDER_LOGS_SCHEMA).unwrap();
        db.execute_batch("ALTER TABLE codex_model_providers ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'; ALTER TABLE codex_provider_keys ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}';").unwrap();
        let mut source=input();
        source.settings.default_model=Some("model-test".into());
        source.settings.context_window=Some(8192);
        source.keys.push(ProviderKeyInput{id:None,name:"Secondary".into(),secret:Some(uuid::Uuid::new_v4().to_string()),settings:ModelSettings{models:vec!["key-model".into()],models_scoped:true,default_model:Some("key-model".into()),context_window:Some(16384),compact_limit:Some(8192),..Default::default()}});
        let saved=save_encrypted(&mut db,source,|v|crate::core::crypto::encrypt_secret_with_key(v,&[19;32])).unwrap().remove(0);
        drop(db);
        let mut db=Connection::open(path).unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        let persisted=list(&db).unwrap().remove(0);
        assert_eq!(serde_json::to_value(&saved).unwrap(),serde_json::to_value(&persisted).unwrap());
        assert_eq!(effective_settings(&persisted,&persisted.keys[0]).context_window,Some(8192));
        let secondary=effective_settings(&persisted,&persisted.keys[1]);
        assert_eq!(secondary.models,vec!["key-model"]);
        assert_eq!(secondary.default_model.as_deref(),Some("key-model"));
        assert_eq!(secondary.context_window,Some(16384));
        assert_eq!(secondary.compact_limit,Some(8192));
        db.execute("INSERT INTO codex_provider_bindings VALUES(?1)",[&persisted.id]).unwrap();
        db.execute("INSERT INTO codex_provider_aggregates(id,name,strategy,version) VALUES('fixture','Fixture','round_robin',1)",[]).unwrap();
        db.execute("INSERT INTO codex_provider_aggregate_members(aggregate_id,provider_id,key_id,weight,position) VALUES('fixture',?1,?2,1,0)",params![persisted.id,persisted.keys[0].id]).unwrap();
        let mut update=input(); update.id=Some(persisted.id.clone()); update.version=Some(persisted.version); update.keys[0].id=Some(persisted.keys[1].id.clone()); update.keys[0].secret=None;
        // 被聚合引用的密钥不能随保存一起消失，成员行与权重必须由用户显式移除。
        assert!(save_encrypted(&mut db,update.clone(),|v|crate::core::crypto::encrypt_secret_with_key(v,&[19;32])).is_err());
        assert_eq!(db.query_row("SELECT COUNT(*) FROM codex_provider_aggregate_members WHERE provider_id=?1",[&persisted.id],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(db.query_row("SELECT COUNT(*) FROM codex_provider_keys WHERE provider_id=?1",[&persisted.id],|r|r.get::<_,i64>(0)).unwrap(),2);
        db.execute("DELETE FROM codex_provider_aggregate_members",[]).unwrap();
        save_encrypted(&mut db,update,|v|crate::core::crypto::encrypt_secret_with_key(v,&[19;32])).unwrap();
        let current_version:i64=db.query_row("SELECT version FROM codex_model_providers WHERE id=?1",[&persisted.id],|r|r.get(0)).unwrap();
        let current_key:String=db.query_row("SELECT id FROM codex_provider_keys WHERE provider_id=?1 LIMIT 1",[&persisted.id],|r|r.get(0)).unwrap();
        db.execute("INSERT INTO codex_provider_aggregate_members(aggregate_id,provider_id,key_id,weight,position) VALUES('fixture',?1,?2,1,0)",params![persisted.id,current_key]).unwrap();
        remove(&db,&persisted.id,current_version).unwrap();
        assert!(list(&db).unwrap().is_empty());
        assert_eq!(db.query_row("SELECT COUNT(*) FROM codex_provider_aggregate_members",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(db.query_row("SELECT COUNT(*) FROM codex_provider_aggregates",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }
    #[test]
    fn scoped_key_catalogs_are_independent_and_empty_catalog_does_not_inherit() {
        let provider=Provider {
            id:"provider".into(),version:1,name:"Fixture".into(),base_url:"https://example.com/v1".into(),wire_api:"responses".into(),
            models:vec!["legacy-model".into(),"shared-model".into()],note:String::new(),settings:ModelSettings::default(),
            keys:vec![
                KeySummary{id:"key-a".into(),name:"A".into(),settings:ModelSettings{models:vec!["model-a".into(),"shared-model".into()],models_scoped:true,..Default::default()}},
                KeySummary{id:"key-b".into(),name:"B".into(),settings:ModelSettings{models:vec!["model-b".into(),"shared-model".into()],models_scoped:true,..Default::default()}},
                KeySummary{id:"key-empty".into(),name:"Empty".into(),settings:ModelSettings{models:vec![],models_scoped:true,..Default::default()}},
            ],
        };
        let first=effective_settings(&provider,&provider.keys[0]);
        let second=effective_settings(&provider,&provider.keys[1]);
        let empty=effective_settings(&provider,&provider.keys[2]);
        assert_eq!(first.models,vec!["model-a","shared-model"]);
        assert_eq!(second.models,vec!["model-b","shared-model"]);
        assert!(empty.models.is_empty());
        assert_eq!(first.default_model,None);
        assert!(!first.models.contains(&"model-b".to_owned()));
    }
    #[test]
    fn account_deletion_protects_live_bindings_and_recovery_references() {
        let db=Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE codex_provider_bindings(account_id INTEGER,previous_account_id INTEGER); CREATE TABLE codex_provider_config_backups(home TEXT); CREATE TABLE codex_profiles(account_id INTEGER); CREATE TABLE codex_provider_oauth(account_id INTEGER); INSERT INTO codex_provider_bindings VALUES(1,2);").unwrap();
        assert!(ensure_account_unbound(&db,1).is_err()); assert!(ensure_account_unbound(&db,2).is_err()); assert!(ensure_account_unbound(&db,3).is_ok());
        db.execute_batch("DELETE FROM codex_provider_bindings; INSERT INTO codex_provider_config_backups VALUES('fixture'); INSERT INTO codex_profiles VALUES(2);").unwrap();
        assert!(ensure_account_unbound(&db,2).is_err());
        db.execute("DELETE FROM codex_provider_config_backups",[]).unwrap(); assert!(ensure_account_unbound(&db,2).is_ok());
    }
}
