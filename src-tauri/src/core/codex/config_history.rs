//! Encrypted, local-only configuration history and durable file/SQLite compensation.
use super::{auth, profile, provider_config, target_lock::canonical_home};
use crate::core::repositories::codex_accounts as accounts;
#[cfg(not(test))]
use crate::core::storage::{decrypt_secret, encrypt_secret};
// Unit tests use an isolated fixture key and never open the user's vault.
#[cfg(test)]
fn encrypt_secret(value: &str) -> Result<String, String> { crate::core::crypto::encrypt_secret_with_key(value, &[43; 32]) }
#[cfg(test)]
fn decrypt_secret(value: &str) -> Result<String, String> { crate::core::crypto::decrypt_secret_with_key(value, &[43; 32]) }
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{fs, io::Read, path::Path};
use zeroize::{Zeroize, Zeroizing};

pub const FILES: [&str; 4] = ["config.toml", "auth.json", "cloudhub-model-catalog.json", "cloudhub-model-catalog.meta.json"];
const READ_ERROR: &str = "读取 Codex 备份状态失败";
const WRITE_ERROR: &str = "保存 Codex 备份状态失败";
pub const PENDING: &str = "上次配置操作未完成，请在备份与恢复中处理待恢复记录";

#[derive(Clone, Serialize, Deserialize)]
pub struct SavedFile { pub name: String, pub content: Option<String> }
impl Drop for SavedFile { fn drop(&mut self) { self.content.zeroize(); } }

#[derive(Clone, Serialize, Deserialize)]
struct Binding { provider: String, key: String, account: i64, previous: Option<i64>, instance: Option<String> }
#[derive(Clone, Serialize, Deserialize)]
struct OAuth { account: i64, fingerprint: String }
#[derive(Clone, Serialize, Deserialize)]
pub struct SavedGateway { pub port: u16, pub secret: String, pub provider: String, pub key: String, pub models: String }
impl Drop for SavedGateway { fn drop(&mut self) { self.secret.zeroize(); } }
#[derive(Clone, Serialize, Deserialize)]
struct ProviderBackup { content: String, config: String, auth: String }
impl Drop for ProviderBackup { fn drop(&mut self) { self.content.zeroize(); } }
#[derive(Clone, Serialize, Deserialize)]
struct Instance { id: String, account: i64, fingerprint: Option<String> }

#[derive(Clone, Serialize, Deserialize)]
pub struct Snapshot {
    version: u8,
    pub files: Vec<SavedFile>,
    binding: Option<Binding>, oauth: Option<OAuth>, pub gateway: Option<SavedGateway>,
    backup: Option<ProviderBackup>, instance: Option<Instance>,
    #[serde(default)]
    credential_account: Option<i64>,
    pub complete: bool,
    // Legacy partial records must never claim ownership of files they did not capture.
    legacy_auth_only: bool,
}
impl Snapshot {
    pub fn file(&self, name: &str) -> Option<&str> { self.files.iter().find(|f| f.name == name).and_then(|f| f.content.as_deref()) }
    pub fn set_file(&mut self, name: &str, content: Option<String>) {
        if let Some(file) = self.files.iter_mut().find(|f| f.name == name) { file.content = content; }
        else { self.files.push(SavedFile { name: name.into(), content }); }
    }
    pub fn oauth_account(&self) -> Option<i64> { self.oauth.as_ref().map(|o| o.account) }
    pub fn instance_account(&self) -> Option<i64> { self.instance.as_ref().map(|i| i.account) }
    pub fn referenced_accounts(&self) -> Vec<i64> { [self.oauth_account(), self.instance_account(), self.binding.as_ref().map(|b|b.account), self.credential_account].into_iter().flatten().collect() }
    pub fn use_gateway(&mut self, port:u16, secret:&str) -> Result<(),String> {
        let g=self.gateway.as_mut().ok_or(READ_ERROR)?;
        g.port=port;g.secret=secret.into();
        let mut doc=self.file("config.toml").ok_or(READ_ERROR)?.parse::<toml_edit::Document>().map_err(|_| "Codex 历史备份损坏")?;
        let provider=&mut doc["model_providers"]["cloudhub_provider"];
        provider["base_url"]=toml_edit::value(format!("http://127.0.0.1:{port}/v1"));
        provider["experimental_bearer_token"]=toml_edit::value(secret);
        self.set_file("config.toml",Some(doc.to_string()));
        if self.oauth.is_none() {self.set_file("auth.json",Some(serde_json::json!({"auth_mode":"apikey","OPENAI_API_KEY":secret}).to_string()));}
        self.refresh_fingerprints();
        Ok(())
    }
    fn refresh_fingerprints(&mut self) {
        let config=profile::fingerprint(self.file("config.toml").map(provider_config::normalize_config).as_deref());
        let auth=profile::fingerprint(self.file("auth.json"));
        if let Some(b)=&mut self.backup {b.config=config;b.auth=auth.clone();}
        if let Some(i)=&mut self.instance {i.fingerprint=Some(auth.clone());}
        if let Some(o)=&mut self.oauth {o.fingerprint=auth;}
    }
    pub fn provider_selection(&self) -> Result<Option<provider_config::AppliedSelection>, String> {
        let Some(backup) = &self.backup else { return Ok(None) };
        let value: serde_json::Value = serde_json::from_str(&backup.content).map_err(|_| READ_ERROR)?;
        value.get("selection").filter(|v| !v.is_null()).map(|v| serde_json::from_value(v.clone()).map_err(|_| READ_ERROR.into())).transpose()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String, pub home: String, pub instance_id: Option<String>,
    pub created_at: Option<i64>, pub migrated_at: Option<i64>, pub source: String,
    pub mode: String, pub summary: String, pub complete: bool, pub pinned: bool,
    pub pending: bool,
}

pub fn read_file(home: &Path, name: &str) -> Result<Option<String>, String> {
    if !FILES.contains(&name) { return Err(READ_ERROR.into()); }
    match fs::symlink_metadata(home.join(name)) {
        Ok(meta) => {
            if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > profile::MAX_AUTH_BYTES { return Err(READ_ERROR.into()); }
            let mut text=Zeroizing::new(String::new());
            fs::File::open(home.join(name)).map_err(|_| READ_ERROR)?.take(profile::MAX_AUTH_BYTES+1).read_to_string(&mut text).map_err(|_| READ_ERROR)?;
            if text.len() as u64 > profile::MAX_AUTH_BYTES {text.zeroize();return Err(READ_ERROR.into());}
            Ok(Some(text.to_string()))
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(READ_ERROR.into()),
    }
}
pub fn files(home: &Path) -> Result<Vec<SavedFile>, String> {
    FILES.into_iter().map(|name| Ok(SavedFile { name: name.into(), content: read_file(home, name)? })).collect()
}
fn file_hash(files: &[SavedFile]) -> String {
    let hashes = files.iter().map(|f| format!("{}:{}", f.name, profile::fingerprint(f.content.as_deref()))).collect::<Vec<_>>().join("|");
    profile::fingerprint(Some(&hashes))
}

pub fn capture(conn: &Connection, home: &Path, instance: Option<&str>) -> Result<Snapshot, String> {
    let saved_files = files(home)?;
    let path = home.to_string_lossy();
    let binding = conn.query_row("SELECT provider_id,key_id,account_id,previous_account_id,instance_id FROM codex_provider_bindings WHERE home=?1", [path.as_ref()], |r| Ok(Binding { provider: r.get(0)?, key: r.get(1)?, account: r.get(2)?, previous: r.get(3)?, instance: r.get(4)? })).optional().map_err(|_| READ_ERROR)?;
    let oauth = conn.query_row("SELECT account_id,auth_fingerprint FROM codex_provider_oauth WHERE home=?1", [path.as_ref()], |r| Ok(OAuth { account: r.get(0)?, fingerprint: r.get(1)? })).optional().map_err(|_| READ_ERROR)?;
    let mut gateway = conn.query_row("SELECT port,key_ciphertext,provider_id,key_id,models_json FROM codex_provider_gateways WHERE home=?1", [path.as_ref()], |r| Ok(SavedGateway { port: r.get(0)?, secret: r.get(1)?, provider: r.get(2)?, key: r.get(3)?, models: r.get(4)? })).optional().map_err(|_| READ_ERROR)?;
    if let Some(g) = &mut gateway { g.secret = decrypt_secret(&g.secret).map_err(|_| "解密 Codex 备份状态失败")?; }
    let mut backup = conn.query_row("SELECT content_ciphertext,installed_config,installed_auth FROM codex_provider_config_backups WHERE home=?1", [path.as_ref()], |r| Ok(ProviderBackup { content: r.get(0)?, config: r.get(1)?, auth: r.get(2)? })).optional().map_err(|_| READ_ERROR)?;
    if let Some(b) = &mut backup {
        b.content = decrypt_secret(&b.content).map_err(|_| "解密 Codex 备份状态失败")?;
        let value: serde_json::Value = serde_json::from_str(&b.content).map_err(|_| READ_ERROR)?;
        if value.get("pending").is_some_and(|v| !v.is_null()) { return Err("上次供应商切换未完成，请先恢复配置与登录".into()); }
    }
    let instance = instance.map(|id| conn.query_row("SELECT account_id,auth_fingerprint FROM codex_profiles WHERE id=?1", [id], |r| Ok(Instance { id: id.into(), account: r.get(0)?, fingerprint: r.get(1)? })).map_err(|_| READ_ERROR)).transpose()?;
    if file_hash(&saved_files) != file_hash(&files(home)?) { return Err("目标配置已变更，请重新预览".into()); }
    let credential_account = saved_files.iter().find(|f|f.name=="auth.json").and_then(|f|f.content.as_deref()).and_then(|s|auth::parse_import(s).ok()).and_then(|mut a|a.pop()).map(|a|conn.query_row("SELECT id FROM codex_accounts WHERE identity=?1 AND deleted_at IS NULL",[a.identity],|r|r.get(0)).optional().map_err(|_|READ_ERROR)).transpose()?.flatten();
    Ok(Snapshot { version: 1, files: saved_files, binding, oauth, gateway, backup, instance, credential_account, complete: true, legacy_auth_only: false })
}

pub fn version(conn: &Connection, home: &Path, instance: Option<&str>) -> Result<String, String> {
    let snapshot = capture(conn, home, instance)?;
    let text = Zeroizing::new(serde_json::to_string(&snapshot).map_err(|_| READ_ERROR)?);
    Ok(format!("{}:{}", canonical_home(home)?, profile::fingerprint(Some(&text))))
}

fn description(snapshot: &Snapshot) -> (String, String) {
    let provider = snapshot.file("config.toml").and_then(|s| s.parse::<toml_edit::Document>().ok()).and_then(|d| d.get("model_provider").and_then(|v| v.as_str()).map(str::to_owned));
    let foreign = provider.as_deref().is_some_and(|p| p != "openai");
    let mode = match snapshot.file("auth.json").and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok()) {
        None if snapshot.file("auth.json").is_none() => "未登录",
        Some(v) if v.get("auth_mode").and_then(|v| v.as_str()) == Some("apikey") => if foreign { "供应商 API Key" } else { "官方 API Key" },
        Some(v) if v.get("tokens").is_some() => if foreign { "供应商 + OAuth" } else { "官方 OAuth" },
        _ => "外部配置/无法识别",
    };
    // Do not derive labels from arbitrary auth/config fields: those can contain secrets.
    (mode.into(), if snapshot.complete { "配置、登录、模型目录与目标绑定" } else if snapshot.legacy_auth_only { "仅登录备份" } else { "旧版配置与登录（部分文件未捕获）" }.into())
}
fn encode(value: &impl Serialize) -> Result<String, String> {
    let text = Zeroizing::new(serde_json::to_string(value).map_err(|_| WRITE_ERROR)?);
    encrypt_secret(&text).map_err(|_| "加密 Codex 备份状态失败".into())
}
fn decode<T: serde::de::DeserializeOwned>(cipher: &str) -> Result<T, String> {
    let text = Zeroizing::new(decrypt_secret(cipher).map_err(|_| "解密 Codex 备份状态失败")?);
    serde_json::from_str(&text).map_err(|_| "Codex 历史备份损坏".into())
}
fn insert(conn: &Connection, home: &Path, instance: Option<&str>, source: &str, snapshot: &Snapshot, legacy: Option<&str>) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let (mode, mut summary) = description(snapshot);
    // A stale projection is captured for compensation, but must never label the
    // disk login as its previous owner. Only use associations matching the files.
    let auth = profile::fingerprint(snapshot.file("auth.json"));
    let account = snapshot.credential_account
        .or_else(||snapshot.oauth.as_ref().filter(|o|o.fingerprint==auth).map(|o|o.account))
        .or_else(||snapshot.instance.as_ref().filter(|i|i.fingerprint.as_deref()==Some(auth.as_str())).map(|i|i.account))
        .or_else(||snapshot.binding.as_ref().filter(|_|snapshot.backup.as_ref().is_some_and(|b|b.auth==auth && b.config==profile::fingerprint(snapshot.file("config.toml").map(provider_config::normalize_config).as_deref()))).map(|b|b.account));
    if let Some(id) = account {
        let label: Option<String> = conn.query_row("SELECT label FROM codex_accounts WHERE id=?1", [id], |r|r.get(0)).optional().map_err(|_|READ_ERROR)?;
        if let Some(label) = label { summary = format!("{label} · {summary}"); }
    }
    let first: bool = conn.query_row("SELECT NOT EXISTS(SELECT 1 FROM codex_config_history WHERE home=?1 AND complete=1)", [canonical_home(home)?], |r| r.get(0)).map_err(|_| READ_ERROR)?;
    conn.execute("INSERT OR IGNORE INTO codex_config_history VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)", params![id, canonical_home(home)?, instance, legacy.is_none().then_some(now), legacy.map(|_| now), source, mode, summary, snapshot.complete, source == "manual" || first || legacy.is_some(), legacy, encode(snapshot)?]).map_err(|_| WRITE_ERROR)?;
    Ok(id)
}
pub fn manual(conn: &Connection, home: &Path, instance: Option<&str>) -> Result<(), String> {
    ensure_ready(conn, home)?;
    insert(conn, home, instance, "manual", &capture(conn, home, instance)?, None)?;
    Ok(())
}
pub fn pending(conn: &Connection, home: &Path) -> Result<bool, String> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM codex_config_operations WHERE home=?1)", [canonical_home(home)?], |r| r.get(0)).map_err(|_| READ_ERROR.into())
}
pub fn ensure_ready(conn: &Connection, home: &Path) -> Result<(), String> { if pending(conn, home)? { Err(PENDING.into()) } else { Ok(()) } }

#[derive(Serialize, Deserialize)]
struct Operation { prior: Snapshot, intended: Vec<SavedFile> }
fn write_files(home: &Path, files: &[SavedFile]) -> Result<(), String> {
    fs::create_dir_all(home).map_err(|_| "创建 Codex 默认目录失败")?;
    profile::private_permissions(home, true)?;
    for file in files {
        if !FILES.contains(&file.name.as_str()) { return Err("Codex 历史备份损坏".into()); }
        if read_file(home, &file.name)?.as_deref() == file.content.as_deref() { continue; }
        match &file.content {
            Some(text) => profile::write_private(&home.join(&file.name), text)?,
            None => match fs::remove_file(home.join(&file.name)) {
                Ok(()) => (), Err(e) if e.kind() == std::io::ErrorKind::NotFound => (), Err(_) => return Err("恢复 Codex 备份文件失败".into()),
            },
        }
    }
    Ok(())
}
pub fn clear_bindings(conn: &Connection, home: &Path) -> Result<(), String> {
    for table in ["codex_provider_bindings", "codex_provider_oauth", "codex_provider_gateways", "codex_provider_config_backups"] {
        conn.execute(&format!("DELETE FROM {table} WHERE home=?1"), [home.to_string_lossy().as_ref()]).map_err(|_| WRITE_ERROR)?;
    }
    Ok(())
}
pub fn restore_bindings(conn: &Connection, home: &Path, snapshot: &Snapshot) -> Result<(), String> {
    clear_bindings(conn, home)?;
    let path = home.to_string_lossy();
    if let Some(b) = &snapshot.binding { conn.execute("INSERT INTO codex_provider_bindings VALUES(?1,?2,?3,?4,?5,?6)", params![path, b.provider, b.key, b.account, b.previous, b.instance]).map_err(|_| WRITE_ERROR)?; }
    if let Some(o) = &snapshot.oauth { conn.execute("INSERT INTO codex_provider_oauth VALUES(?1,?2,?3)", params![path, o.account, o.fingerprint]).map_err(|_| WRITE_ERROR)?; }
    if let Some(g) = &snapshot.gateway { conn.execute("INSERT INTO codex_provider_gateways VALUES(?1,?2,?3,?4,?5,?6)", params![path, g.port, encrypt_secret(&g.secret)?, g.provider, g.key, g.models]).map_err(|_| WRITE_ERROR)?; }
    if let Some(b) = &snapshot.backup { conn.execute("INSERT INTO codex_provider_config_backups VALUES(?1,?2,?3,?4)", params![path, encrypt_secret(&b.content)?, b.config, b.auth]).map_err(|_| WRITE_ERROR)?; }
    if let Some(i) = &snapshot.instance { conn.execute("UPDATE codex_profiles SET account_id=?1,auth_fingerprint=?2 WHERE id=?3", params![i.account, i.fingerprint, i.id]).map_err(|_| WRITE_ERROR)?; }
    Ok(())
}

pub fn restore_managed_account(conn:&Connection,snapshot:&Snapshot)->Result<(),String> {
    if snapshot.gateway.is_some() && snapshot.oauth.is_none() {
        if let (Some(binding),Some(auth))=(&snapshot.binding,snapshot.file("auth.json")) {
            conn.execute("UPDATE codex_accounts SET auth_ciphertext=?1,updated_at=MAX(updated_at+1,?2) WHERE id=?3",params![encrypt_secret(auth)?,chrono::Utc::now().timestamp_millis(),binding.account]).map_err(|_| WRITE_ERROR)?;
        }
    }
    Ok(())
}

/// Caller holds both AUTH_WRITER and the target OS lock, and has checked idle state.
#[cfg(test)]
pub fn execute<T>(conn: &mut Connection, home: &Path, instance: Option<&str>, source: &str, intended: Vec<SavedFile>, commit: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    execute_checked(conn, home, instance, source, None, intended, commit)
}
pub fn execute_checked<T>(conn: &mut Connection, home: &Path, instance: Option<&str>, source: &str, expected: Option<&str>, intended: Vec<SavedFile>, commit: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    ensure_ready(conn, home)?;
    let op = Operation { prior: capture(conn, home, instance)?, intended };
    if let Some(expected) = expected {
        let text=Zeroizing::new(serde_json::to_string(&op.prior).map_err(|_| READ_ERROR)?);
        if expected != format!("{}:{}",canonical_home(home)?,profile::fingerprint(Some(&text))) {return Err("目标配置已变更，请重新预览".into());}
    }
    let tx = conn.transaction().map_err(|_| WRITE_ERROR)?;
    let id = insert(&tx, home, instance, source, &op.prior, None)?;
    tx.execute("INSERT INTO codex_config_operations VALUES(?1,?2,?3)", params![canonical_home(home)?, id, encode(&op)?]).map_err(|_| WRITE_ERROR)?;
    tx.commit().map_err(|_| WRITE_ERROR)?;
    let result = (|| {
        // A client not participating in our lock can still have changed files.
        if file_hash(&files(home)?) != file_hash(&op.prior.files) { return Err("目标配置已变更，请重新预览".into()); }
        write_files(home, &op.intended)?;
        for f in &op.intended { if read_file(home, &f.name)?.as_deref() != f.content.as_deref() { return Err("目标配置已变更，请重新预览".into()); } }
        let tx = conn.transaction().map_err(|_| WRITE_ERROR)?;
        let result = commit(&tx)?;
        tx.execute("DELETE FROM codex_config_operations WHERE home=?1", [canonical_home(home)?]).map_err(|_| WRITE_ERROR)?;
        prune(&tx, home)?;
        tx.commit().map_err(|_| WRITE_ERROR)?;
        Ok(result)
    })();
    if result.is_err() { recover(conn, home)?; }
    result
}

pub fn recover(conn: &mut Connection, home: &Path) -> Result<(), String> {
    let cipher: String = conn.query_row("SELECT content_ciphertext FROM codex_config_operations WHERE home=?1", [canonical_home(home)?], |r| r.get(0)).map_err(|_| "Codex 待恢复记录不存在")?;
    let op: Operation = decode(&cipher)?;
    // Never compensate over an unrelated edit made by an official client or older build.
    for prior in &op.prior.files {
        let current = read_file(home, &prior.name)?;
        let intended = op.intended.iter().find(|f| f.name == prior.name).unwrap_or(prior);
        if current != prior.content && current != intended.content { return Err("恢复被外部修改阻止，已保留备份和待恢复记录".into()); }
    }
    write_files(home, &op.prior.files)?;
    let tx = conn.transaction().map_err(|_| WRITE_ERROR)?;
    restore_bindings(&tx, home, &op.prior)?;
    tx.execute("DELETE FROM codex_config_operations WHERE home=?1", [canonical_home(home)?]).map_err(|_| WRITE_ERROR)?;
    tx.commit().map_err(|_| WRITE_ERROR.into())
}
fn prune(conn: &Connection, home: &Path) -> Result<(), String> {
    conn.execute("DELETE FROM codex_config_history WHERE id IN (SELECT id FROM codex_config_history WHERE home=?1 AND pinned=0 AND source NOT IN ('manual','legacy_account','legacy_provider') AND id NOT IN (SELECT snapshot_id FROM codex_config_operations) ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET 50)", [canonical_home(home)?]).map_err(|_| WRITE_ERROR)?;
    Ok(())
}
pub fn list(conn: &Connection) -> Result<Vec<HistoryEntry>, String> {
    let mut statement = conn.prepare("SELECT h.id,h.home,h.instance_id,h.created_at,h.migrated_at,h.source,h.mode,h.summary,h.complete,h.pinned,EXISTS(SELECT 1 FROM codex_config_operations o WHERE o.snapshot_id=h.id) FROM codex_config_history h ORDER BY COALESCE(h.created_at,h.migrated_at) DESC,h.id DESC").map_err(|_| READ_ERROR)?;
    let rows = statement.query_map([], |r| Ok(HistoryEntry { id:r.get(0)?, home:r.get(1)?, instance_id:r.get(2)?, created_at:r.get(3)?, migrated_at:r.get(4)?, source:r.get(5)?, mode:r.get(6)?, summary:r.get(7)?, complete:r.get(8)?, pinned:r.get(9)?, pending:r.get(10)? })).map_err(|_| READ_ERROR)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| READ_ERROR.into())
}
pub fn load(conn: &Connection, id: &str, home: &Path) -> Result<Snapshot, String> {
    let cipher: String = conn.query_row("SELECT content_ciphertext FROM codex_config_history WHERE id=?1 AND home=?2", params![id, canonical_home(home)?], |r| r.get(0)).optional().map_err(|_| READ_ERROR)?.ok_or("此备份不属于当前目标或已被删除")?;
    let snapshot: Snapshot = decode(&cipher)?;
    if snapshot.version != 1 || snapshot.files.iter().any(|f| !FILES.contains(&f.name.as_str())) { return Err("Codex 历史备份损坏".into()); }
    Ok(snapshot)
}
pub fn update(conn: &Connection, id: &str, pinned: Option<bool>) -> Result<(), String> {
    let protected: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM codex_config_operations WHERE snapshot_id=?1)", [id], |r| r.get(0)).map_err(|_| READ_ERROR)?;
    if protected { return Err("待恢复记录不能删除或取消保留".into()); }
    let count = if let Some(pinned) = pinned { conn.execute("UPDATE codex_config_history SET pinned=?1 WHERE id=?2", params![pinned, id]) } else { conn.execute("DELETE FROM codex_config_history WHERE id=?1", [id]) }.map_err(|_| WRITE_ERROR)?;
    if count != 1 { return Err("Codex 历史备份不存在".into()); }
    Ok(())
}

/// Validate references before any write, and prefer the current stored grant of the same identity.
pub fn prepare_restore(conn: &Connection, home: &Path, instance: Option<&str>, snapshot: &mut Snapshot) -> Result<(), String> {
    if let Some(id) = snapshot.credential_account { accounts::get(conn,id).map_err(|_|"备份引用的账号已删除，请先恢复账号或重新配置")?; }
    if snapshot.instance.as_ref().map(|i| i.id.as_str()).is_some_and(|id| Some(id) != instance) {
        return Err("此备份不属于当前目标或已被删除".into());
    }
    if let Some(backup) = &snapshot.backup {
        let config = profile::fingerprint(snapshot.file("config.toml").map(provider_config::normalize_config).as_deref());
        if config != backup.config || profile::fingerprint(snapshot.file("auth.json")) != backup.auth {
            return Err("备份登录与目标绑定不一致，请重新应用所选配置".into());
        }
    }
    // Partial legacy snapshots did not save the instance binding. Reconstruct it
    // only from a known credential identity, never keep an unrelated current owner.
    if let Some(id) = instance {
        let _: i64 = conn.query_row("SELECT account_id FROM codex_profiles WHERE id=?1", [id], |r| r.get(0)).map_err(|_| "Codex 实例不存在")?;
        if snapshot.instance.is_none() {
            let identity = snapshot.file("auth.json").and_then(|s| auth::parse_import(s).ok()).and_then(|mut a| a.pop()).map(|a| a.identity).ok_or("旧版备份缺少实例账号归属，请重新切换账号")?;
            let account = conn.query_row("SELECT id FROM codex_accounts WHERE identity=?1 AND deleted_at IS NULL", [identity], |r| r.get(0)).map_err(|_| "旧版备份缺少实例账号归属，请重新切换账号")?;
            snapshot.instance = Some(Instance { id: id.into(), account, fingerprint: None });
        }
    }
    if snapshot.legacy_auth_only {
        let current = capture(conn, home, None)?;
        let foreign = description(&current).0.starts_with("供应商") || current.binding.is_some();
        if foreign { return Err("仅登录备份不能覆盖供应商配置，请选择完整备份或重新切换账号".into()); }
    }
    if let Some(b) = &snapshot.binding {
        accounts::get(conn, b.account).map_err(|_| "备份引用的账号已删除，请先恢复账号或重新配置")?;
        {
            let selection = snapshot.provider_selection()?.ok_or("备份引用的供应商已删除或修改，请重新配置")?;
            if selection.provider_id != b.provider || selection.key_id != b.key || selection.oauth_account_id != snapshot.oauth_account() {
                return Err("备份登录与目标绑定不一致，请重新应用所选配置".into());
            }
            if let Some(id) = b.provider.strip_prefix("aggregate:") {
                let aggregate = super::provider_aggregate::list(conn)?.into_iter().find(|v| v.id == id).ok_or("备份引用的供应商已删除或修改，请重新配置")?;
                if aggregate.version != selection.provider_version || !aggregate.models.contains(&selection.model) { return Err("备份引用的供应商已删除或修改，请重新配置".into()); }
            } else {
                let provider = super::providers::list(conn)?.into_iter().find(|v| v.id == b.provider).ok_or("备份引用的供应商已删除或修改，请重新配置")?;
                if provider.version != selection.provider_version || !provider.keys.iter().any(|k| k.id == b.key) { return Err("备份引用的供应商已删除或修改，请重新配置".into()); }
                super::providers::credential(conn, &b.provider, &b.key)?;
            }
        }
    }
    if let Some(i) = &snapshot.instance { accounts::get(conn, i.account).map_err(|_| "备份引用的账号已删除，请先恢复账号或重新配置")?; }
    if let Some(o) = &snapshot.oauth {
        let other: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM codex_provider_oauth WHERE account_id=?1 AND home!=?2)", params![o.account, home.to_string_lossy()], |r| r.get(0)).map_err(|_| READ_ERROR)?;
        if other { return Err("OAuth 账号已被其他实例、服务或供应商占用".into()); }
    }
    if let Some(previous) = snapshot.file("auth.json") {
        if snapshot.oauth.is_some() && super::provider_oauth::validate(previous).is_err() {
            return Err("备份登录与目标绑定不一致，请重新应用所选配置".into());
        }
        if let Ok(identity) = super::provider_oauth::validate(previous) {
            let id = snapshot.oauth_account().or(snapshot.instance_account()).or(snapshot.credential_account).map(Ok).unwrap_or_else(|| conn.query_row("SELECT id FROM codex_accounts WHERE identity=?1 AND deleted_at IS NULL", [&identity], |r| r.get(0)).map_err(|_| "历史 OAuth 登录需要重新授权后再恢复".to_string()))?;
            let current = accounts::credentials(conn, id)?;
            if super::provider_oauth::validate(&current)? != identity { return Err("历史 OAuth 登录需要重新授权后再恢复".into()); }
            auth::ensure_runtime_auth(&current)?;
            snapshot.set_file("auth.json", Some(current.to_string()));
            snapshot.credential_account=Some(id);
        }
    }
    snapshot.refresh_fingerprints();
    Ok(())
}

pub fn migrate_legacy(conn: &Connection) -> Result<(), String> {
    for (table, column, source) in [("codex_profile_backups", "profile_home", "legacy_account"), ("codex_provider_config_backups", "home", "legacy_provider")] {
        let mut query = conn.prepare(&format!("SELECT {column},{} FROM {table}", if source == "legacy_account" { "auth_ciphertext" } else { "content_ciphertext" })).map_err(|_| READ_ERROR)?;
        let rows = query.query_map([], |r| Ok((r.get::<_,String>(0)?, r.get::<_,Option<String>>(1)?))).map_err(|_| READ_ERROR)?;
        for row in rows {
            let (home, cipher) = row.map_err(|_| READ_ERROR)?;
            let key = format!("{source}:{home}");
            let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM codex_config_history WHERE legacy_key=?1)", [&key], |r| r.get(0)).map_err(|_| READ_ERROR)?;
            if exists { continue; }
            let mut snapshot = Snapshot { version:1, files:Vec::new(), binding:None, oauth:None, gateway:None, backup:None, instance:None, credential_account:None, complete:false, legacy_auth_only:source == "legacy_account" };
            let text = cipher.as_deref().map(decrypt_secret).transpose().map_err(|_| "解密 Codex 备份状态失败")?.map(Zeroizing::new);
            if source == "legacy_account" { snapshot.set_file("auth.json", text.as_deref().map(|s| s.to_string())); }
            else {
                let mut value: serde_json::Value = serde_json::from_str(text.as_deref().map(|s| s.as_str()).ok_or(READ_ERROR)?).map_err(|_| READ_ERROR)?;
                if value.get("pending").is_some_and(|p| !p.is_null()) { continue; }
                for name in ["config.toml", "auth.json"] { snapshot.set_file(name, value.get(if name == "auth.json" { "auth" } else { "config" }).and_then(|v| v.as_str()).map(str::to_owned)); }
                if let Some(catalog) = value.get("catalog") {
                    if catalog.get("exists").and_then(|v| v.as_bool()) == Some(false) { snapshot.set_file(FILES[2], None); }
                    else if let Some(text) = catalog.get("content").and_then(|v| v.as_str()) { snapshot.set_file(FILES[2], Some(text.into())); }
                }
                // JSON owns decrypted secrets; erase strings before releasing allocations.
                wipe_json(&mut value);
            }
            insert(conn, Path::new(&home), None, source, &snapshot, Some(&key))?;
        }
    }
    Ok(())
}
fn wipe_json(value: &mut serde_json::Value) {
    match value { serde_json::Value::String(s) => s.zeroize(), serde_json::Value::Array(v) => v.iter_mut().for_each(wipe_json), serde_json::Value::Object(v) => v.values_mut().for_each(wipe_json), _ => () }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (profile::TemporaryProfile, Connection) {
        let home=profile::TemporaryProfile::new("{}").unwrap();
        let conn=Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::core::database::CODEX_SCHEMA).unwrap();
        conn.execute_batch(crate::core::database::CODEX_CONFIG_HISTORY_SCHEMA).unwrap();
        conn.execute_batch(crate::core::database::CODEX_PROVIDER_BACKUPS_SCHEMA).unwrap();
        conn.execute_batch("CREATE TABLE codex_provider_bindings(home TEXT PRIMARY KEY,provider_id TEXT,key_id TEXT,account_id INTEGER,previous_account_id INTEGER,instance_id TEXT); CREATE TABLE codex_provider_oauth(home TEXT PRIMARY KEY,account_id INTEGER UNIQUE,auth_fingerprint TEXT); CREATE TABLE codex_provider_gateways(home TEXT PRIMARY KEY,port INTEGER,key_ciphertext TEXT,provider_id TEXT,key_id TEXT,models_json TEXT);").unwrap();
        (home,conn)
    }
    fn candidate(name:&str,content:Option<&str>)->Vec<SavedFile> { vec![SavedFile{name:name.into(),content:content.map(str::to_owned)}] }
    #[test]
    fn switching_and_restoring_keeps_selected_history_and_saves_current_state() {
        let (home,mut conn)=fixture();
        profile::write_private(&home.path.join(FILES[2]),"").unwrap();
        execute(&mut conn,&home.path,None,"provider",candidate("auth.json",Some("{\"fixture\":1}")),|_|Ok(())).unwrap();
        let rows=list(&conn).unwrap();
        assert_eq!(rows.len(),1);
        assert!(rows[0].created_at.is_some() && rows[0].pinned);
        let original=load(&conn,&rows[0].id,&home.path).unwrap();
        assert_eq!(original.file(FILES[2]),Some(""));
        assert_eq!(original.file(FILES[3]),None);
        execute(&mut conn,&home.path,None,"restore",original.files.clone(),|tx|restore_bindings(tx,&home.path,&original)).unwrap();
        assert_eq!(read_file(&home.path,"auth.json").unwrap().as_deref(),Some("{}"));
        assert_eq!(list(&conn).unwrap().len(),2);
        assert!(load(&conn,&rows[0].id,&home.path).is_ok());
        assert!(!pending(&conn,&home.path).unwrap());
        let cipher:String=conn.query_row("SELECT content_ciphertext FROM codex_config_history LIMIT 1",[],|r|r.get(0)).unwrap();
        assert!(serde_json::from_str::<serde_json::Value>(&cipher).is_err());
        let public=serde_json::to_string(&list(&conn).unwrap()).unwrap();
        assert!(!public.contains("ciphertext") && !public.contains("fixture"));
        assert!(load(&conn,&rows[0].id,&home.path.with_extension("other")).is_err());
    }
    #[test]
    fn empty_files_allow_preview_backup_and_recovery_without_accepting_empty_credentials() {
        let (home,mut conn)=fixture();
        profile::write_private(&home.path.join("config.toml"),"").unwrap();
        profile::write_private(&home.path.join("auth.json"),"").unwrap();
        profile::ensure_file_storage(&home.path).unwrap();
        assert!(profile::read_auth(&home.path.join("auth.json")).is_err());
        provider_config::managed_preview(&conn,&home.path).unwrap();
        manual(&conn,&home.path,None).unwrap();
        let snapshot=load(&conn,&list(&conn).unwrap()[0].id,&home.path).unwrap();
        assert_eq!(snapshot.file("auth.json"),Some(""));
        assert_eq!(snapshot.file("config.toml"),Some(""));
        execute(&mut conn,&home.path,None,"provider",candidate("auth.json",Some("fixture")),|_|Ok(())).unwrap();
        execute(&mut conn,&home.path,None,"restore",snapshot.files.clone(),|tx|restore_bindings(tx,&home.path,&snapshot)).unwrap();
        assert_eq!(read_file(&home.path,"auth.json").unwrap().as_deref(),Some(""));
    }
    #[test]
    fn database_failure_compensates_files_and_preserves_exact_original_binding() {
        let (home,mut conn)=fixture();
        conn.execute("INSERT INTO codex_provider_oauth VALUES(?1,7,'stale-fingerprint')",[home.path.to_string_lossy().as_ref()]).unwrap();
        let failure=execute(&mut conn,&home.path,None,"account",candidate("auth.json",Some("new-fixture")),|_|Err::<(),_>("fixture commit failed".into()));
        assert_eq!(failure.unwrap_err(),"fixture commit failed");
        assert_eq!(read_file(&home.path,"auth.json").unwrap().as_deref(),Some("{}"));
        assert_eq!(conn.query_row("SELECT auth_fingerprint FROM codex_provider_oauth",[],|r|r.get::<_,String>(0)).unwrap(),"stale-fingerprint");
        assert!(!pending(&conn,&home.path).unwrap());
        assert_eq!(list(&conn).unwrap().len(),1);
    }
    #[test]
    fn stale_projection_never_labels_a_backup_as_the_previous_credential_owner() {
        let (home,conn)=fixture();
        conn.execute("INSERT INTO codex_accounts(identity,label,auth_mode,auth_ciphertext,updated_at) VALUES('fixture-owner','previous-fixture-owner','chatgpt','fixture',1)",[]).unwrap();
        let owner=conn.last_insert_rowid();
        conn.execute("INSERT INTO codex_provider_oauth VALUES(?1,?2,'stale-fingerprint')",params![home.path.to_string_lossy(),owner]).unwrap();
        manual(&conn,&home.path,None).unwrap();
        assert!(!list(&conn).unwrap()[0].summary.contains("previous-fixture-owner"));
    }
    #[test]
    fn recovery_preserves_unrelated_external_edits_and_protects_pending_point() {
        let (home,mut conn)=fixture();
        let op=Operation{prior:capture(&conn,&home.path,None).unwrap(),intended:candidate("auth.json",Some("intended-fixture"))};
        let id=insert(&conn,&home.path,None,"account",&op.prior,None).unwrap();
        conn.execute("INSERT INTO codex_config_operations VALUES(?1,?2,?3)",params![canonical_home(&home.path).unwrap(),id,encode(&op).unwrap()]).unwrap();
        profile::write_private(&home.path.join("auth.json"),"external-fixture").unwrap();
        assert!(recover(&mut conn,&home.path).unwrap_err().contains("外部修改"));
        assert_eq!(read_file(&home.path,"auth.json").unwrap().as_deref(),Some("external-fixture"));
        assert!(update(&conn,&id,None).is_err());
        assert!(update(&conn,&id,Some(false)).is_err());
        assert!(ensure_ready(&conn,&home.path).is_err());
        profile::write_private(&home.path.join("auth.json"),"intended-fixture").unwrap();
        recover(&mut conn,&home.path).unwrap();
        assert!(!pending(&conn,&home.path).unwrap());
        assert_eq!(read_file(&home.path,"auth.json").unwrap().as_deref(),Some("{}"));
    }
    #[test]
    fn history_retention_excludes_manual_pinned_and_first_complete_records() {
        let (home,conn)=fixture();
        manual(&conn,&home.path,None).unwrap();
        let snapshot=capture(&conn,&home.path,None).unwrap();
        let retained=insert(&conn,&home.path,None,"provider",&snapshot,None).unwrap();
        update(&conn,&retained,Some(true)).unwrap();
        for _ in 0..55 {insert(&conn,&home.path,None,"provider",&snapshot,None).unwrap();}
        prune(&conn,&home.path).unwrap();
        let rows=list(&conn).unwrap();
        assert_eq!(rows.len(),52);
        assert_eq!(rows.iter().filter(|r|r.pinned).count(),2);
    }
    #[test]
    fn legacy_import_is_idempotent_and_never_fabricates_time_or_missing_files() {
        let (home,conn)=fixture();
        let cipher=encrypt_secret("{}").unwrap();
        conn.execute("INSERT INTO codex_profile_backups VALUES(?1,?2,'installed','prior')",params![home.path.to_string_lossy(),cipher]).unwrap();
        let legacy=encrypt_secret(&serde_json::json!({"config":"model = 'fixture'", "auth":null}).to_string()).unwrap();
        conn.execute("INSERT INTO codex_provider_config_backups VALUES(?1,?2,'installed','prior')",params![home.path.to_string_lossy(),legacy]).unwrap();
        migrate_legacy(&conn).unwrap();migrate_legacy(&conn).unwrap();
        let rows=list(&conn).unwrap();assert_eq!(rows.len(),2);
        for row in rows {
            assert!(row.created_at.is_none() && row.migrated_at.is_some() && !row.complete);
            let snapshot=load(&conn,&row.id,&home.path).unwrap();
            assert!(!snapshot.files.iter().any(|f|f.name==FILES[2]));
        }
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM codex_profile_backups",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    }
    #[test]
    fn preview_version_covers_catalog_and_binding_and_invalid_projection_is_not_restored() {
        let (home,conn)=fixture();
        let first=version(&conn,&home.path,None).unwrap();
        profile::write_private(&home.path.join(FILES[3]),"fixture-meta").unwrap();
        assert_ne!(first,version(&conn,&home.path,None).unwrap());
        conn.execute("INSERT INTO codex_provider_oauth VALUES(?1,7,'stale-fingerprint')",[home.path.to_string_lossy().as_ref()]).unwrap();
        let mut snapshot=capture(&conn,&home.path,None).unwrap();
        assert!(prepare_restore(&conn,&home.path,None,&mut snapshot).unwrap_err().contains("不一致"));
    }
    #[test]
    fn stale_confirmation_and_failed_history_persistence_never_write_target_files() {
        let (home,mut conn)=fixture();
        let version=version(&conn,&home.path,None).unwrap();
        profile::write_private(&home.path.join("auth.json"),"external-fixture").unwrap();
        assert!(execute_checked(&mut conn,&home.path,None,"account",Some(&version),candidate("auth.json",Some("candidate-fixture")),|_|Ok(())).is_err());
        assert!(list(&conn).unwrap().is_empty());
        assert_eq!(read_file(&home.path,"auth.json").unwrap().as_deref(),Some("external-fixture"));
        conn.execute_batch("CREATE TRIGGER reject_history BEFORE INSERT ON codex_config_operations BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
        assert!(execute(&mut conn,&home.path,None,"account",candidate("auth.json",Some("candidate-fixture")),|_|Ok(())).is_err());
        assert!(list(&conn).unwrap().is_empty());
        assert!(!pending(&conn,&home.path).unwrap());
        assert_eq!(read_file(&home.path,"auth.json").unwrap().as_deref(),Some("external-fixture"));
    }
}
