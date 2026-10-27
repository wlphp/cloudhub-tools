//! A projected OAuth grant has exactly one credential owner; never send it upstream.
use super::{auth,profile,provider_config};
use crate::core::{repositories::codex_accounts as repository,storage::open_db};
use rusqlite::{Connection,OptionalExtension,params};
use std::path::Path;
use zeroize::Zeroizing;

pub fn owner(conn:&Connection,home:&Path)->Result<Option<i64>,String> {
    conn.query_row("SELECT account_id FROM codex_provider_oauth WHERE home=?1",[home.to_string_lossy().as_ref()],|r|r.get(0)).optional().map_err(|_| "读取供应商 OAuth 归属失败".into())
}
pub fn bound(conn:&Connection,id:i64)->Result<bool,String> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM codex_provider_oauth WHERE account_id=?1)",[id],|r|r.get(0)).map_err(|_| "读取供应商 OAuth 归属失败".into())
}
pub fn validate(content:&str)->Result<String,String> {
    let account=auth::parse_import(content)?.remove(0);
    let metadata=auth::metadata(content)?;
    let value:serde_json::Value=serde_json::from_str(content).map_err(|_| "OAuth 认证无效")?;
    if account.auth_mode!="chatgpt" || metadata.is_web_session || !metadata.has_refresh_token
        || value.pointer("/tokens/id_token").and_then(serde_json::Value::as_str).is_none_or(str::is_empty) {
        return Err("只能绑定含 ID Token 和 Refresh Token 的官方 OAuth 账号".into());
    }
    Ok(account.identity)
}

pub fn credentials(conn:&Connection,home:&Path)->Result<Option<Zeroizing<String>>,String> {
    owner(conn,home)?.map(|id|repository::credentials(conn,id)).transpose()
}

fn should_save_refresh(prior:&str,disk:&str,saved:&str)->Result<bool,String> {
    if disk!=prior && disk!=saved && saved!=prior {
        return Err("OAuth 账号与实例凭据均已变更，未覆盖登录".into());
    }
    if disk!=saved && disk==prior {
        return Err("OAuth 账号已更新，请先恢复并重新应用供应商配置".into());
    }
    Ok(disk!=saved)
}

pub fn sync(home:&Path)->Result<bool,String> {
    let _target=super::target_lock::TargetLock::acquire(home)?;
    sync_locked(home)
}

pub const STALE_PROJECTION:&str="目标登录与旧 OAuth 绑定不一致，可重新应用所选配置或从备份历史恢复";

/// Read-only classification. Storage and decryption failures remain real errors.
pub fn projection_current(conn:&Connection,home:&Path)->Result<bool,String> {
    projection_with_store(conn,home,repository::credentials)
}
fn projection_with_store(conn:&Connection,home:&Path,load:impl Fn(&Connection,i64)->Result<Zeroizing<String>,String>)->Result<bool,String> {
    let Some(id)=owner(conn,home)? else{return Ok(true)};
    let saved=load(conn,id)?;
    let identity=validate(&saved)?;
    let disk=match std::fs::symlink_metadata(home.join("auth.json")) {
        Ok(_)=>profile::read_text(&home.join("auth.json"))?,
        Err(e) if e.kind()==std::io::ErrorKind::NotFound=>return Ok(false),
        Err(_)=>return Err("读取供应商 OAuth 投影失败".into()),
    };
    Ok(validate(&disk).ok().as_deref()==Some(identity.as_str()))
}

/// Explicit replacement may supersede a stale projection, but still reconciles
/// legitimate rotations of the same owner. Never suppress database/crypto errors.
pub fn sync_before_replace(conn:&Connection,home:&Path)->Result<(),String> {
    if projection_current(conn,home)? {sync_locked(home)?;}
    Ok(())
}

pub fn sync_locked(home:&Path)->Result<bool,String> {
    let mut conn=open_db()?;
    super::config_history::ensure_ready(&conn,home)?;
    if !projection_current(&conn,home)? {return Err(STALE_PROJECTION.into());}
    sync_with_store(&mut conn,home,
        |conn,id|Ok((repository::credentials(conn,id)?,repository::get(conn,id)?.updated_at)),
        |conn,id,version,auth|repository::save_refresh(conn,id,version,auth,None,None,None),
        provider_config::record_oauth_rotation)
}

fn sync_with_store(
    conn:&mut Connection,
    home:&Path,
    load:impl Fn(&Connection,i64)->Result<(Zeroizing<String>,i64),String>,
    save:impl Fn(&Connection,i64,i64,&str)->Result<(),String>,
    rotate:impl Fn(&Connection,&Path,&str,&str)->Result<(),String>,
)->Result<bool,String> {
    // Read ownership, credentials and their version from one database snapshot.
    let tx=conn.transaction().map_err(|_| "保存供应商 OAuth 续期失败")?;
    let Some(id)=owner(&tx,home)? else{return Ok(false);};
    let disk=profile::read_auth(&home.join("auth.json"))?;
    let (saved,version)=load(&tx,id)?;
    if validate(&disk)?!=validate(&saved)? {return Err("供应商实例已登录不同 OAuth 账号，未覆盖凭据".into());}
    let prior:String=tx.query_row("SELECT auth_fingerprint FROM codex_provider_oauth WHERE home=?1",[home.to_string_lossy().as_ref()],|r|r.get(0)).map_err(|_| "读取供应商 OAuth 投影失败")?;
    let disk_hash=profile::fingerprint(Some(&disk));let saved_hash=profile::fingerprint(Some(&saved));
    let save_refresh=should_save_refresh(&prior,&disk_hash,&saved_hash)?;
    if save_refresh {save(&tx,id,version,&disk)?;}
    rotate(&tx,home,&prior,&disk)?;
    tx.execute("UPDATE codex_provider_oauth SET auth_fingerprint=?1 WHERE home=?2",params![disk_hash,home.to_string_lossy()]).map_err(|_| "保存供应商 OAuth 投影失败")?;
    tx.commit().map_err(|_| "保存供应商 OAuth 续期失败")?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;use serde_json::json;use base64::{engine::general_purpose::URL_SAFE_NO_PAD,Engine};

    fn encrypt(value:&str)->Result<String,String> {
        crate::core::crypto::encrypt_secret_with_key(value,&[29;32])
    }
    fn decrypt(value:&str)->Result<String,String> {
        crate::core::crypto::decrypt_secret_with_key(value,&[29;32])
    }
    fn fixture_auth(owner:&str)->String {
        let claims=URL_SAFE_NO_PAD.encode(json!({"sub":owner,"https://api.openai.com/auth":{"chatgpt_account_id":owner,"chatgpt_user_id":owner}}).to_string());
        json!({"auth_mode":"chatgpt","tokens":{"access_token":uuid::Uuid::new_v4().to_string(),"refresh_token":uuid::Uuid::new_v4().to_string(),"id_token":format!("invalid.{claims}.invalid"),"account_id":owner}}).to_string()
    }
    fn fixture()->(profile::TemporaryProfile,Connection,String) {
        let original=fixture_auth("fixture-owner");
        let rotated=fixture_auth("fixture-owner");
        let temp=profile::TemporaryProfile::new(&rotated).unwrap();
        let conn=Connection::open(temp.path.join("oauth-test.sqlite")).unwrap();
        conn.pragma_update(None,"journal_mode","WAL").unwrap();
        conn.execute_batch("CREATE TABLE fixture_accounts(id INTEGER PRIMARY KEY,auth_ciphertext TEXT,updated_at INTEGER); CREATE TABLE codex_provider_oauth(home TEXT PRIMARY KEY,account_id INTEGER,auth_fingerprint TEXT);").unwrap();
        conn.execute_batch(crate::core::database::CODEX_PROVIDER_BACKUPS_SCHEMA).unwrap();
        conn.execute("INSERT INTO fixture_accounts VALUES(1,?1,1)",[encrypt(&original).unwrap()]).unwrap();
        let prior=profile::fingerprint(Some(&original));
        conn.execute("INSERT INTO codex_provider_oauth VALUES(?1,1,?2)",params![temp.path.to_string_lossy(),prior]).unwrap();
        let snapshot=json!({"config":"model = \"original\"\n","auth":original}).to_string();
        conn.execute("INSERT INTO codex_provider_config_backups VALUES(?1,?2,'config',?3)",params![temp.path.to_string_lossy(),encrypt(&snapshot).unwrap(),prior]).unwrap();
        (temp,conn,rotated)
    }
    fn load(conn:&Connection,id:i64)->Result<(Zeroizing<String>,i64),String> {
        let (cipher,version):(String,i64)=conn.query_row("SELECT auth_ciphertext,updated_at FROM fixture_accounts WHERE id=?1",[id],|row|Ok((row.get(0)?,row.get(1)?))).map_err(|_|"fixture read failure")?;
        Ok((Zeroizing::new(decrypt(&cipher)?),version))
    }
    fn save(conn:&Connection,id:i64,version:i64,auth:&str)->Result<(),String> {
        let count=conn.execute("UPDATE fixture_accounts SET auth_ciphertext=?1,updated_at=updated_at+1 WHERE id=?2 AND updated_at=?3",params![encrypt(auth)?,id,version]).map_err(|_|"fixture write conflict")?;
        if count!=1 {return Err("fixture stale version".into());}
        Ok(())
    }
    fn rotate(conn:&Connection,home:&Path,prior:&str,auth:&str)->Result<(),String> {
        provider_config::record_oauth_rotation_encrypted(conn,home,prior,auth,decrypt,encrypt)
    }
    fn state(conn:&Connection)->(String,i64,String,String,String) {
        conn.query_row("SELECT a.auth_ciphertext,a.updated_at,o.auth_fingerprint,b.content_ciphertext,b.installed_auth FROM fixture_accounts a CROSS JOIN codex_provider_oauth o CROSS JOIN codex_provider_config_backups b",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).unwrap()
    }

    #[test]
    fn stale_oauth_projection_allows_explicit_api_replacement_without_saving_old_owner() {
        let (temp,conn,_)=fixture();
        let before=state(&conn);
        profile::write_private(&temp.path.join("auth.json"), &json!({"auth_mode":"apikey","OPENAI_API_KEY":uuid::Uuid::new_v4().to_string()}).to_string()).unwrap();
        assert!(!projection_with_store(&conn,&temp.path,|c,id|load(c,id).map(|v|v.0)).unwrap());
        assert_eq!(state(&conn),before);
        let failure=projection_with_store(&conn,&temp.path,|_,_|Err("fixture decrypt failed".into()));
        assert_eq!(failure.unwrap_err(),"fixture decrypt failed");
        profile::write_private(&temp.path.join("auth.json"),&fixture_auth("different-fixture-owner")).unwrap();
        assert!(!projection_with_store(&conn,&temp.path,|c,id|load(c,id).map(|v|v.0)).unwrap());
        profile::write_private(&temp.path.join("auth.json"),"").unwrap();
        assert!(!projection_with_store(&conn,&temp.path,|c,id|load(c,id).map(|v|v.0)).unwrap());
        assert_eq!(state(&conn),before);
    }

    #[test]
    fn sync_commits_credentials_projection_and_recovery_together() {
        let (temp,mut conn,rotated)=fixture();
        assert!(sync_with_store(&mut conn,&temp.path,load,save,rotate).unwrap());
        let current=state(&conn);
        assert!(decrypt(&current.0).unwrap()==rotated);
        assert_eq!(current.1,2);
        assert_eq!(current.2,profile::fingerprint(Some(&rotated)));
        assert_eq!(current.4,current.2);
        let snapshot:serde_json::Value=serde_json::from_str(&decrypt(&current.3).unwrap()).unwrap();
        assert!(snapshot["auth"].as_str()==Some(rotated.as_str()));
        assert_eq!(snapshot["config"],"model = \"original\"\n");
        assert!(sync_with_store(&mut conn,&temp.path,load,save,rotate).unwrap());
        assert_eq!(state(&conn).1,2);
    }

    #[test]
    fn sync_rolls_back_all_state_when_projection_write_fails() {
        let (temp,mut conn,_)=fixture();
        let before=state(&conn);
        conn.execute_batch("CREATE TRIGGER reject_projection BEFORE UPDATE ON codex_provider_oauth BEGIN SELECT RAISE(ABORT,'fixture projection failure'); END;").unwrap();
        assert!(sync_with_store(&mut conn,&temp.path,load,save,rotate).is_err());
        assert_eq!(state(&conn),before);
    }

    #[test]
    fn sync_keeps_credentials_unchanged_when_recovery_cannot_be_updated() {
        for corrupt in [true,false] {
            let (temp,mut conn,_)=fixture();
            if corrupt {
                conn.execute("UPDATE codex_provider_config_backups SET content_ciphertext='invalid-fixture-cipher'",[]).unwrap();
            } else {
                conn.execute("DELETE FROM codex_provider_config_backups",[]).unwrap();
            }
            let before=load(&conn,1).unwrap();
            let prior:String=conn.query_row("SELECT auth_fingerprint FROM codex_provider_oauth",[],|row|row.get(0)).unwrap();
            assert!(sync_with_store(&mut conn,&temp.path,load,save,rotate).is_err());
            let after=load(&conn,1).unwrap();
            assert!(after.0.as_str()==before.0.as_str());
            assert_eq!(after.1,before.1);
            let current:String=conn.query_row("SELECT auth_fingerprint FROM codex_provider_oauth",[],|row|row.get(0)).unwrap();
            assert_eq!(current,prior);
        }
    }

    #[test]
    fn unbound_home_does_not_read_credentials_or_write_state() {
        let (temp,mut conn,_)=fixture();
        let other_home=temp.path.join("unbound");
        let before=state(&conn);
        assert!(!sync_with_store(&mut conn,&other_home,
            |_,_|panic!("unbound home must not load credentials"),
            |_,_,_,_|panic!("unbound home must not save credentials"),
            |_,_,_,_|panic!("unbound home must not update recovery")).unwrap());
        assert_eq!(state(&conn),before);
    }

    #[test]
    fn sync_does_not_overwrite_a_concurrent_account_refresh() {
        let (temp,mut conn,_)=fixture();
        let before=state(&conn);
        let other=Connection::open(temp.path.join("oauth-test.sqlite")).unwrap();
        let external=fixture_auth("fixture-owner");
        let external_cipher=encrypt(&external).unwrap();
        let concurrent_load=|conn:&Connection,id| {
            let saved=load(conn,id)?;
            other.execute("UPDATE fixture_accounts SET auth_ciphertext=?1,updated_at=updated_at+1 WHERE id=?2",params![external_cipher,id]).unwrap();
            Ok(saved)
        };
        assert!(sync_with_store(&mut conn,&temp.path,concurrent_load,save,rotate).is_err());
        let after=state(&conn);
        assert!(decrypt(&after.0).unwrap()==external);
        assert_eq!(after.1,2);
        assert_eq!((after.2,after.3,after.4),(before.2,before.3,before.4));
    }

    #[test]
    fn sync_rejects_identity_changes_and_ambiguous_rotations_without_mutation() {
        for changed_identity in [false,true] {
            let (temp,mut conn,_)=fixture();
            if changed_identity {
                profile::write_private(&temp.path.join("auth.json"),&fixture_auth("different-owner")).unwrap();
            } else {
                conn.execute("UPDATE fixture_accounts SET auth_ciphertext=?1,updated_at=2",[encrypt(&fixture_auth("fixture-owner")).unwrap()]).unwrap();
            }
            let before=state(&conn);
            assert!(sync_with_store(&mut conn,&temp.path,load,save,rotate).is_err());
            assert_eq!(state(&conn),before);
        }
    }

    #[test]
    fn refresh_projection_reconciles_only_unambiguous_fingerprint_transitions() {
        assert_eq!(should_save_refresh("old","old","old").unwrap(),false);
        assert_eq!(should_save_refresh("old","rotated","old").unwrap(),true);
        assert_eq!(should_save_refresh("old","rotated","rotated").unwrap(),false);
        assert!(should_save_refresh("old","old","account-updated").is_err());
        assert!(should_save_refresh("old","instance-updated","account-updated").is_err());
    }

    #[test]
    fn only_refreshable_official_oauth_can_be_a_credential_owner() {
        let claims=URL_SAFE_NO_PAD.encode(json!({"sub":"fixture-user","https://api.openai.com/auth":{"chatgpt_account_id":"fixture-account","chatgpt_user_id":"fixture-user"}}).to_string());
        let token=format!("invalid.{claims}.invalid");
        let mut oauth=json!({"auth_mode":"chatgpt","tokens":{"access_token":uuid::Uuid::new_v4().to_string(),"id_token":token,"refresh_token":uuid::Uuid::new_v4().to_string(),"account_id":"fixture-account"}});
        assert!(validate(&oauth.to_string()).is_ok());
        oauth["tokens"]["refresh_token"]=json!("");assert!(validate(&oauth.to_string()).is_err());
        oauth["tokens"]["refresh_token"]=json!(uuid::Uuid::new_v4().to_string());oauth["token_source_mode"]=json!("chatgpt_web_session");assert!(validate(&oauth.to_string()).is_err());
        assert!(validate(&json!({"OPENAI_API_KEY":uuid::Uuid::new_v4().to_string()}).to_string()).is_err());
    }
}
