use super::{profile, rpc};
use crate::core::storage::{decrypt_secret, encrypt_secret};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{fs, path::Path, time::Duration};
use zeroize::{Zeroize,Zeroizing};

#[derive(Serialize, Deserialize)]
struct Snapshot { config: Option<String>, auth: Option<String> }
impl Drop for Snapshot {fn drop(&mut self){self.config.zeroize();self.auth.zeroize();}}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct ConfigPreview { pub version: String, pub path: String, pub has_backup: bool }

fn read_optional(home:&Path,name:&str)->Result<Option<Zeroizing<String>>,String> {
    match fs::symlink_metadata(home.join(name)) {
        Ok(_)=>profile::read_auth(&home.join(name)).map(Some),
        Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(None),
        Err(_)=>Err("读取供应商目标配置失败".into()),
    }
}
fn fingerprints(home:&Path)->Result<(String,String),String> {
    Ok((profile::fingerprint(read_optional(home,"config.toml")?.as_deref().map(|s|s.as_str())),profile::fingerprint(read_optional(home,"auth.json")?.as_deref().map(|s|s.as_str()))))
}
pub fn preview(conn:&Connection,home:&Path)->Result<ConfigPreview,String> {
    let (config,auth)=fingerprints(home)?;
    let has_backup=conn.query_row("SELECT EXISTS(SELECT 1 FROM codex_provider_config_backups WHERE home=?1)",[home.to_string_lossy().as_ref()],|r|r.get(0)).map_err(|_| "读取供应商备份失败")?;
    Ok(ConfigPreview{version:format!("{config}:{auth}"),path:home.to_string_lossy().into_owned(),has_backup})
}

pub fn build_config(home:&Path,base_url:&str,model:&str,settings:&super::providers::ModelSettings,bearer:&str,oauth:bool)->Result<Zeroizing<String>,String> {
    let isolated=profile::TemporaryProfile::new("{}")?;
    if let Some(config)=read_optional(home,"config.toml")? {profile::write_private(&isolated.path.join("config.toml"),&config)?;}
    let mut server=rpc::AppServer::start(&isolated.path).map_err(|_| "无法启动官方 CLI 读取供应商配置")?;
    let edits=[("model",json!(model)),("model_context_window",json!(settings.context_window)),("model_auto_compact_token_limit",json!(settings.compact_limit)),("model_provider",json!("cloudhub_provider")),("model_providers.cloudhub_provider",json!({"name":"CloudHub Provider","base_url":base_url,"wire_api":"responses","requires_openai_auth":oauth,"experimental_bearer_token":bearer})),("cli_auth_credentials_store",json!("file"))]
        .into_iter().map(|(key,value)|json!({"keyPath":key,"value":value,"mergeStrategy":"replace"})).collect::<Vec<_>>();
    server.request("config/batchWrite",json!({"edits":edits,"reloadUserConfig":false}),Duration::from_secs(20)).map_err(|_| "官方 CLI 无法生成供应商配置")?;
    profile::read_auth(&isolated.path.join("config.toml"))
}

fn write_optional(home:&Path,name:&str,value:Option<&str>)->Result<(),String> {
    if let Some(value)=value {profile::write_private(&home.join(name),value)}
    else {match fs::symlink_metadata(home.join(name)) {Ok(m) if m.is_file() && !m.file_type().is_symlink()=>fs::remove_file(home.join(name)).map_err(|_| "恢复供应商配置失败".into()),Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(()),_=>Err("恢复供应商配置失败".into())}}
}

pub fn install(conn:&Connection,home:&Path,version:&str,config:&str,auth:&str)->Result<(),String> {
    install_encrypted(conn,home,version,config,auth,encrypt_secret)
}
fn install_encrypted(conn:&Connection,home:&Path,version:&str,config:&str,auth:&str,encrypt:impl Fn(&str)->Result<String,String>)->Result<(),String> {
    install_with_writer(conn,home,version,config,auth,encrypt,profile::write_private)
}
fn install_with_writer(conn:&Connection,home:&Path,version:&str,config:&str,auth:&str,encrypt:impl Fn(&str)->Result<String,String>,write:impl Fn(&Path,&str)->Result<(),String>)->Result<(),String> {
    if preview(conn,home)?.version!=version {return Err("目标配置已变更，请重新预览".into());}
    if preview(conn,home)?.has_backup {return Err("请先恢复上次供应商配置，再切换供应商".into());}
    let snapshot=Snapshot{config:read_optional(home,"config.toml")?.map(|s|s.to_string()),auth:read_optional(home,"auth.json")?.map(|s|s.to_string())};
    let snapshot_version=format!("{}:{}",profile::fingerprint(snapshot.config.as_deref()),profile::fingerprint(snapshot.auth.as_deref()));
    if snapshot_version!=version {return Err("目标配置已变更，请重新预览".into());}
    let encoded=Zeroizing::new(serde_json::to_string(&snapshot).map_err(|_| "保存供应商备份失败")?);
    let cipher=encrypt(&encoded).map_err(|_| "加密供应商备份失败")?;
    if preview(conn,home)?.version!=version {return Err("目标配置已变更，请重新预览".into());}
    conn.execute("INSERT INTO codex_provider_config_backups VALUES(?1,?2,?3,?4)",params![home.to_string_lossy(),cipher,profile::fingerprint(Some(config)),profile::fingerprint(Some(auth))]).map_err(|_| "保存供应商备份失败")?;
    if !home.exists() {fs::create_dir_all(home).map_err(|_| "创建供应商配置目录失败")?;profile::private_permissions(home,true)?;}
    if let Err(error)=write(&home.join("config.toml"),config).and_then(|_|write(&home.join("auth.json"),auth)) {
        // The encrypted recovery point remains if compensation cannot complete.
        if write_optional(home,"config.toml",snapshot.config.as_deref()).and_then(|_|write_optional(home,"auth.json",snapshot.auth.as_deref())).is_ok() {
            conn.execute("DELETE FROM codex_provider_config_backups WHERE home=?1",[home.to_string_lossy().as_ref()]).map_err(|_| "清理供应商恢复记录失败")?;
        }
        return Err(error);
    }
    Ok(())
}

pub fn restore(conn:&Connection,home:&Path)->Result<(),String> {
    restore_files(conn,home)?;
    conn.execute("DELETE FROM codex_provider_config_backups WHERE home=?1",[home.to_string_lossy().as_ref()]).map_err(|_| "清理供应商恢复记录失败")?;
    Ok(())
}

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
    let row:Option<(String,String,String)>=conn.query_row("SELECT content_ciphertext,installed_config,installed_auth FROM codex_provider_config_backups WHERE home=?1",[home.to_string_lossy().as_ref()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|_| "读取供应商备份失败")?;
    let (cipher,config,auth)=row.ok_or("没有供应商配置备份")?;
    let text=Zeroizing::new(decrypt(&cipher).map_err(|_| "解密供应商备份失败")?);
    let snapshot:Snapshot=serde_json::from_str(&text).map_err(|_| "供应商备份损坏")?;
    let current=fingerprints(home)?;
    let old=(profile::fingerprint(snapshot.config.as_deref()),profile::fingerprint(snapshot.auth.as_deref()));
    // Accept either half of an interrupted install/restore, but never an external edit.
    if (current.0!=config && current.0!=old.0) || (current.1!=auth && current.1!=old.1) {return Err("目标配置已被外部修改，未恢复".into());}
    write_optional(home,"config.toml",snapshot.config.as_deref())?;
    write_optional(home,"auth.json",snapshot.auth.as_deref())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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
    fn encrypted_recovery_handles_conflicts_and_partial_restores() {
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
        assert!(restore_decrypted(&db,&temp.path,decrypt).is_err());
        profile::write_private(&temp.path.join("config.toml"),"model = \"old\"\n").unwrap();
        restore_decrypted(&db,&temp.path,decrypt).unwrap();
        assert_eq!(preview(&db,&temp.path).unwrap().version,previous.version);
        restore_decrypted(&db,&temp.path,decrypt).unwrap();
    }
    #[test]
    #[ignore="requires installed official CLI; temporary credential-free directory only"]
    fn installed_cli_generates_provider_and_preserves_other_config() {
        let temp=profile::TemporaryProfile::new("{} ").unwrap();
        profile::write_private(&temp.path.join("config.toml"),"model = \"previous\"\n[features]\nunified_exec = true\n").unwrap();
        let output=build_config(&temp.path,"https://example.com/v1","model-test",&super::super::providers::ModelSettings::default(),&uuid::Uuid::new_v4().to_string(),false).unwrap();
        assert!(output.contains("cloudhub_provider")); assert!(output.contains("unified_exec = true")); assert!(output.contains("https://example.com/v1"));
    }
}
