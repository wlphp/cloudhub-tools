//! Claude Code 供应商的本地存储，以及 `~/.claude/settings.json` 的读写与备份。
//!
//! 供应商按行存 JSON，凭据和配置备份使用现有本地加密工具保护。
//! 写入 live 文件前先备份，因为 Claude Code 自己也会改这个文件。
use crate::core::{claude_providers as model, claude_providers::ClaudeProvider};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use std::fs;
use std::path::{Path, PathBuf};

pub const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS claude_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    settings_json TEXT NOT NULL,
    website_url TEXT NOT NULL DEFAULT '',
    sort_index INTEGER NOT NULL DEFAULT 0,
    is_current INTEGER NOT NULL DEFAULT 0 CHECK(is_current IN (0,1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS claude_provider_backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    content TEXT NOT NULL
);";

pub fn claude_home() -> Result<PathBuf, String> {
    #[cfg(desktop)]
    return claude_home_in(&crate::core::database::open_db()?);
    #[cfg(not(desktop))]
    default_claude_home()
}

pub const CONFIG_DIRECTORY: &str = "claude.workbench.config_directory";
pub fn claude_home_in(conn: &Connection) -> Result<PathBuf, String> {
    let value: Option<String> = conn.query_row("SELECT value FROM client_preferences WHERE key=?1", [CONFIG_DIRECTORY], |r| r.get(0)).optional().map_err(|_| "读取 Claude 配置目录失败")?;
    match value.filter(|v| !v.is_empty() && !foreign_path(v)) {
        Some(value) => {
            let path = PathBuf::from(value);
            if !path.is_absolute() || !path.is_dir() { return Err("Claude 配置目录不可用，请重新选择或恢复默认".into()); }
            Ok(path)
        }
        None => default_claude_home(),
    }
}

pub fn default_claude_home() -> Result<PathBuf, String> {
    resolve_claude_home(std::env::var_os("CLAUDE_CONFIG_DIR"), dirs::home_dir())
}

pub fn standard_claude_home() -> Result<PathBuf, String> {
    resolve_claude_home(None, dirs::home_dir())
}

fn resolve_claude_home(config: Option<std::ffi::OsString>, home: Option<PathBuf>) -> Result<PathBuf, String> {
    if let Some(value) = config.filter(|value| !value.is_empty()) {
        let path = PathBuf::from(value);
        if !path.is_absolute() || foreign_path(&path.to_string_lossy()) {
            return Err("CLAUDE_CONFIG_DIR 必须为本机绝对路径，请修正环境变量".into());
        }
        return Ok(path);
    }
    let home = home.filter(|path| path.is_absolute() && !foreign_path(&path.to_string_lossy()))
        .ok_or("无法确定本机用户主目录")?;
    Ok(home.join(".claude"))
}

/// Database preferences can come from another OS. Do not interpret Windows
/// drive paths as relative Unix filenames, or Unix roots as Windows paths.
pub(crate) fn foreign_path(value: &str) -> bool {
    if cfg!(windows) {
        value.starts_with('/') && !value.starts_with("//")
    } else {
        let bytes = value.as_bytes();
        (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
            || value.starts_with("\\\\")
    }
}

pub fn settings_path() -> Result<PathBuf, String> {
    #[cfg(desktop)]
    return crate::core::claude_workspace::settings_path();
    #[cfg(not(desktop))]
    Ok(claude_home()?.join("settings.json"))
}

/// 首次使用返回空对象；损坏配置拒绝覆盖。
pub fn read_settings() -> Result<Value, String> {
    read_settings_at(&settings_path()?)
}

pub fn read_settings_at(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let meta = fs::symlink_metadata(path).map_err(|_|"读取 Claude Code 配置失败")?;
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len()>8*1024*1024 {
        return Err("Claude 配置是链接或超过大小限制，未读取".into());
    }
    let raw = fs::read_to_string(path).map_err(|_| "读取 Claude Code 配置失败".to_string())?;
    if raw.trim().is_empty() {
        return Ok(json!({}));
    }
    let parsed: Value = serde_json::from_str(&raw).map_err(|_| "Claude Code 配置不是合法 JSON，无法解析".to_string())?;
    if !parsed.is_object() || parsed.get("env").is_some_and(|v| !v.is_object()) {
        return Err("Claude Code 配置或 env 不是对象，配置未改写".into());
    }
    Ok(parsed)
}

/// 写入前先把当前内容存进备份表。返回是否真的做了备份。
pub fn backup(conn: &Connection, now: i64) -> Result<bool, String> {
    backup_at(conn, now, &settings_path()?)
}

fn backup_at(conn: &Connection, now: i64, path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    let content = fs::read_to_string(&path).map_err(|_| "读取 Claude Code 配置失败".to_string())?;
    let scoped=json!({"cloudhubBackup":1,"path":path.to_string_lossy(),"content":content});
    let encrypted = format!("cloudhub-encrypted:{}",crate::core::crypto::encrypt_secret(&scoped.to_string())?);
    conn.execute("INSERT INTO claude_provider_backups(created_at,content) VALUES(?1,?2)", params![now, encrypted])
        .map_err(|_| "备份 Claude Code 配置失败")?;
    Ok(true)
}

/// 原子写入：先写临时文件再改名，避免中途失败留下半个 JSON。
pub fn write_settings(document: &Value) -> Result<(), String> {
    write_settings_at(&settings_path()?, document)
}

pub fn write_settings_at(path: &Path, document: &Value) -> Result<(), String> {
    if !document.is_object() || document.get("env").is_some_and(|v|!v.is_object()) {
        return Err("Claude 配置或 env 必须是对象，配置未改写".into());
    }
    if path.symlink_metadata().is_ok_and(|m|m.file_type().is_symlink()) {
        return Err("不能改写链接配置文件".into());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| "创建 Claude 配置目录失败".to_string())?;
    }
    let serialised = serde_json::to_string_pretty(document).map_err(|_| "序列化 Claude Code 配置失败".to_string())?;
    let temporary = path.with_extension(format!("{}.tmp",uuid::Uuid::new_v4()));
    fs::write(&temporary, serialised).map_err(|_| "写入 Claude Code 配置失败".to_string())?;
    fs::rename(&temporary, path).map_err(|_| "保存 Claude Code 配置失败".to_string())
}

/// 最近一次备份的内容，供界面上的「恢复上一份」使用。
pub fn latest_backup(conn: &Connection) -> Result<Option<(i64, String)>, String> {
    let path=settings_path()?;
    let mut statement=conn.prepare("SELECT id,content FROM claude_provider_backups ORDER BY id DESC").map_err(|_|"读取备份失败")?;
    let rows=statement.query_map([],|row|Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?))).map_err(|_|"读取备份失败")?;
    for row in rows{
        let (id,content)=row.map_err(|_|"读取备份失败")?;
        let plain=if let Some(cipher)=content.strip_prefix("cloudhub-encrypted:"){crate::core::crypto::decrypt_secret(cipher)?}else{content};
        if let Ok(wrapper)=serde_json::from_str::<Value>(&plain){
            if wrapper["cloudhubBackup"]==1{
                if wrapper["path"].as_str()==Some(path.to_string_lossy().as_ref()){
                    return Ok(Some((id,wrapper["content"].as_str().ok_or("备份内容无效")?.into())));
                }
                continue;
            }
        }
        if path==claude_home()?.join("settings.json"){return Ok(Some((id,plain)));}
    }
    Ok(None)
}

/// 返回当前 Claude 配置目录对应的备份编号和时间，不解密或返回配置内容。
pub fn list_backups(conn: &Connection) -> Result<Vec<(i64, i64)>, String> {
    let path = settings_path()?;
    let mut statement = conn.prepare("SELECT id,created_at,content FROM claude_provider_backups ORDER BY id DESC")
        .map_err(|_| "读取备份失败")?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?)) )
        .map_err(|_| "读取备份失败")?;
    let mut backups = Vec::new();
    for row in rows {
        let (id, created_at, content) = row.map_err(|_| "读取备份失败")?;
        let plain = if let Some(cipher) = content.strip_prefix("cloudhub-encrypted:") { crate::core::crypto::decrypt_secret(cipher)? } else { content };
        if let Ok(wrapper) = serde_json::from_str::<Value>(&plain) {
            if wrapper["cloudhubBackup"] == 1 {
                if wrapper["path"].as_str() == Some(path.to_string_lossy().as_ref()) { backups.push((id, created_at)); }
                continue;
            }
        }
        if path == claude_home()?.join("settings.json") { backups.push((id, created_at)); }
    }
    Ok(backups)
}

/// 读取指定备份，并确认它属于当前配置目录。
pub fn backup_by_id(conn: &Connection, backup_id: i64) -> Result<Option<String>, String> {
    let path = settings_path()?;
    let content: Option<String> = conn.query_row("SELECT content FROM claude_provider_backups WHERE id=?1", [backup_id], |row| row.get(0))
        .optional().map_err(|_| "读取备份失败")?;
    let Some(content) = content else { return Ok(None); };
    let plain = if let Some(cipher) = content.strip_prefix("cloudhub-encrypted:") { crate::core::crypto::decrypt_secret(cipher)? } else { content };
    if let Ok(wrapper) = serde_json::from_str::<Value>(&plain) {
        if wrapper["cloudhubBackup"] == 1 {
            if wrapper["path"].as_str() != Some(path.to_string_lossy().as_ref()) { return Ok(None); }
            return Ok(Some(wrapper["content"].as_str().ok_or("备份内容无效")?.into()));
        }
    }
    if path == claude_home()?.join("settings.json") { Ok(Some(plain)) } else { Ok(None) }
}

pub fn list_providers(conn: &Connection) -> Result<Vec<ClaudeProvider>, String> {
    let mut statement = conn
        .prepare("SELECT settings_json,is_current FROM claude_providers ORDER BY sort_index,name COLLATE NOCASE")
        .map_err(|_| "读取供应商失败".to_string())?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? == 1)))
        .map_err(|_| "读取供应商失败".to_string())?;
    let mut providers = Vec::new();
    for row in rows {
        let (raw, current) = row.map_err(|_| "读取供应商失败".to_string())?;
        let mut value: ClaudeProvider = serde_json::from_str(&raw).map_err(|_| "供应商配置损坏".to_string())?;
        if let Some(cipher) = value.api_key.strip_prefix("cloudhub-encrypted:") {
            value.api_key = crate::core::crypto::decrypt_secret(cipher)?;
        }
        // 当前生效的那家在库里单独标记，读出时一并带上。
        value.extra_env.remove(IS_CURRENT_MARKER);
        providers.push(if current { mark_current(value) } else { value });
    }
    Ok(providers)
}

/// 运行时标记，不落库到 `extra_env`。
pub const IS_CURRENT_MARKER: &str = "__cloudhub_current";

fn mark_current(mut provider: ClaudeProvider) -> ClaudeProvider {
    provider.extra_env.insert(IS_CURRENT_MARKER.to_string(), json!(true));
    provider
}

pub fn current_provider_id(conn: &Connection) -> Result<Option<String>, String> {
    conn.query_row("SELECT id FROM claude_providers WHERE is_current=1", [], |row| row.get(0))
        .optional()
        .map_err(|_| "读取当前供应商失败".to_string())
}

/// 单独解密某家供应商的 API Key；只允许原生桌面端调用，移动端不暴露。
pub fn reveal_api_key(conn: &Connection, id: &str) -> Result<String, String> {
    let raw: String = conn
        .query_row("SELECT settings_json FROM claude_providers WHERE id=?1", [id], |row| row.get(0))
        .map_err(|_| "供应商不存在")?;
    let mut value: ClaudeProvider = serde_json::from_str(&raw).map_err(|_| "供应商配置损坏")?;
    if let Some(cipher) = value.api_key.strip_prefix("cloudhub-encrypted:") {
        value.api_key = crate::core::crypto::decrypt_secret(cipher)?;
    }
    Ok(value.api_key)
}

fn strip_marker(provider: &ClaudeProvider) -> ClaudeProvider {
    let mut clean = provider.clone();
    clean.extra_env.remove(IS_CURRENT_MARKER);
    clean
}

pub fn save_provider(conn: &Connection, provider: &ClaudeProvider, now: i64) -> Result<(), String> {
    let clean_input = strip_marker(provider);
    let provider = &clean_input;
    if provider.name.trim().is_empty() {
        return Err("供应商名称不能为空".into());
    }
    if provider.id.trim().is_empty() {
        return Err("供应商标识不能为空".into());
    }
    if provider.id.len() > 128 || provider.name.len() > 240 || provider.api_key.len() > 16384
        || provider.description.len() > 4000 || provider.model_catalog.len() > 200
        || provider.id.chars().any(|c| !c.is_ascii_alphanumeric() && !"-_.".contains(c)) {
        return Err("供应商名称、标识、密钥或模型列表无效".into());
    }
    #[cfg(desktop)]
    {
        if !provider.official_login { crate::core::claude_gateway::validate_url(&provider.base_url)?; }
        if !provider.website_url.is_empty() { crate::core::claude_gateway::validate_url(&provider.website_url)?; }
    }
    if provider.extra_env.len()>100 || provider.extra_env.iter().any(|(k,v)| {
        k.len()>128 || !k.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b==b'_')
            || !v.is_string() || v.as_str().is_some_and(|s|s.len()>4000)
            || model::is_floor_env(k) || k.contains("TOKEN") || k.contains("KEY") || k.contains("SECRET") || k.contains("PASSWORD")
    }) { return Err("扩展环境变量只接受非敏感字符串，请使用专用认证字段保存密钥".into()); }
    let mut model_ids = std::collections::HashSet::new();
    if provider.models.len()>model::MODEL_ROLES.len()||provider.models.iter().any(|(role,value)|{
        !model::MODEL_ROLES.contains(&role.as_str())
            || value.as_object().is_none_or(|m|m.keys().any(|k|!["model","displayName","supports1m"].contains(&k.as_str())))
            || serde_json::from_value::<model::ModelMapping>(value.clone()).is_err()
            || value["model"].as_str().is_some_and(|s|s.len()>240||s.chars().any(char::is_control))
            || value["displayName"].as_str().is_some_and(|s|s.len()>240)
    }){return Err("供应商模型映射无效".into());}
    if provider.model_catalog.iter().any(|m|m.model.trim().is_empty() || m.model.len()>240
        || m.model.chars().any(char::is_control) || m.display_name.len()>240 || !model_ids.insert(m.model.as_str())) {
        return Err("聚合模型 ID 不能为空、重复或超过长度限制".into());
    }
    let mut clean = strip_marker(provider);
    if !clean.api_key.is_empty() {
        clean.api_key = format!("cloudhub-encrypted:{}",crate::core::crypto::encrypt_secret(&clean.api_key)?);
    }
    let raw = serde_json::to_string(&clean).map_err(|_| "序列化供应商失败".to_string())?;
    let next_index: i64 = conn
        .query_row("SELECT COALESCE(MAX(sort_index),0)+1 FROM claude_providers", [], |row| row.get(0))
        .map_err(|_| "读取供应商失败".to_string())?;
    conn.execute(
        "INSERT INTO claude_providers(id,name,settings_json,website_url,sort_index,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?6)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name,settings_json=excluded.settings_json,website_url=excluded.website_url,updated_at=excluded.updated_at",
        params![clean.id, clean.name, raw, clean.website_url, next_index, now],
    )
    .map_err(|_| "保存供应商失败")?;
    Ok(())
}

pub fn delete_provider(conn: &Connection, id: &str) -> Result<u64, String> {
    let removed = conn.execute("DELETE FROM claude_providers WHERE id=?1", [id]).map_err(|_| "删除供应商失败")?;
    if removed > 0 {
        conn.execute("DELETE FROM claude_providers WHERE is_current=0 AND id=?1", [id]).ok();
    }
    Ok(removed as u64)
}

/// 标记当前生效的供应商，同时清掉旧的标记。
pub fn set_current(conn: &Connection, id: &str) -> Result<(), String> {
    let exists: i64 = conn
        .query_row("SELECT COUNT(*) FROM claude_providers WHERE id=?1", [id], |row| row.get(0))
        .map_err(|_| "读取供应商失败")?;
    if exists == 0 {
        return Err("供应商不存在".into());
    }
    let tx = conn.unchecked_transaction().map_err(|_| "无法开始切换供应商")?;
    tx.execute("UPDATE claude_providers SET is_current=0", []).map_err(|_| "切换供应商失败")?;
    tx.execute("UPDATE claude_providers SET is_current=1 WHERE id=?1", [id]).map_err(|_| "切换供应商失败")?;
    tx.commit().map_err(|_| "提交切换失败".to_string())
}

/// 预置供应商。base_url 取自 cc-switch 同名预设，模型映射是各家的公开别名。
fn provider(id: &str, name: &str, website: &str, base_url: &str, models: &[(&str, &str)]) -> ClaudeProvider {
    let mut map = Map::new();
    for (role, model_name) in models {
        map.insert((*role).to_string(), json!({ "model": model_name }));
    }
    ClaudeProvider {
        id: id.into(),
        name: name.into(),
        description: String::new(),
        website_url: website.into(),
        base_url: base_url.into(),
        // 预置不带密钥，用户首次使用时填写。
        api_key: String::new(),
        api_key_field: model::ApiKeyField::AuthToken,
        api_format: model::ApiFormat::Anthropic,
        is_full_url: true,
        models: map,
        extra_env: Map::new(),
        official_login: id == "claude-official",
        model_catalog: Vec::new(),
        user_agent: String::new(),
        proxy_header_override: serde_json::Value::Null,
        proxy_body_override: serde_json::Value::Null,
        fallback_model: None,
    }
}

/// 预置清单。`is_full_url` 表示 base_url 已是完整端点，切换时不再拼接路径。
pub fn presets() -> Vec<ClaudeProvider> {
    vec![
        provider("claude-official", "Claude 官方", "https://console.anthropic.com", "https://api.anthropic.com", &[
            ("sonnet", "claude-sonnet-4-5"), ("opus", "claude-opus-4-1"), ("haiku", "claude-haiku-4-5"),
        ]),
        provider("deepseek", "DeepSeek", "https://platform.deepseek.com", "https://api.deepseek.com/anthropic", &[
            ("sonnet", "deepseek-chat"), ("opus", "deepseek-reasoner"), ("haiku", "deepseek-chat"),
        ]),
        provider("minimax", "MiniMax", "https://platform.minimaxi.com", "https://api.minimaxi.com/anthropic", &[
            ("sonnet", "MiniMax-M3"), ("opus", "MiniMax-M3.1-Flash-Preview"), ("haiku", "MiniMax-M2.7"),
        ]),
        provider("siliconflow", "SiliconFlow", "https://siliconflow.cn", "https://api.siliconflow.cn/anthropic", &[
            ("sonnet", "deepseek-ai/DeepSeek-V3"), ("haiku", "Qwen/Qwen2.5-7B-Instruct"),
        ]),
        provider("openrouter", "OpenRouter", "https://openrouter.ai", "https://openrouter.ai/api/v1", &[
            ("sonnet", "anthropic/claude-sonnet-4.5"), ("opus", "anthropic/claude-opus-4.1"), ("haiku", "anthropic/claude-haiku-4.5"),
        ]),
        provider("nvidia", "NVIDIA NIM", "https://build.nvidia.com", "https://integrate.api.nvidia.com/v1", &[
            ("sonnet", "moonshotai/kimi-k2-instruct"),
        ]),
        provider("sensenova", "商汤日日新", "https://platform.sensenova.cn", "https://api.sensenova.cn/compatible-mode/v1", &[
            ("sonnet", "DeepSeek-V3"),
        ]),
        provider("agnes", "agens", "https://apihub.agnes-ai.com", "https://apihub.agnes-ai.com", &[
            ("sonnet", "claude-sonnet-4-5"),
        ]),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_paths_follow_native_home_and_config_environment() {
        let home = std::env::temp_dir().join("cloudhub-home-fixture");
        assert_eq!(resolve_claude_home(None, Some(home.clone())).unwrap(), home.join(".claude"));
        let custom = home.join("custom-claude");
        assert_eq!(resolve_claude_home(Some(custom.clone().into_os_string()), Some(home.clone())).unwrap(), custom);
        assert_eq!(resolve_claude_home(Some("".into()), Some(home.clone())).unwrap(), home.join(".claude"));
        assert!(resolve_claude_home(Some("relative/config".into()), Some(home)).is_err());
        assert!(resolve_claude_home(None, Some(PathBuf::from("relative-home"))).is_err());
        assert!(resolve_claude_home(None, None).is_err());
    }

    #[test]
    fn claude_migrated_config_path_falls_back_without_changing_preference() {
        let conn = db();
        conn.execute_batch("CREATE TABLE client_preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL);").unwrap();
        let foreign = if cfg!(windows) { "/Users/fixture/.claude" } else { r"C:\Users\fixture\.claude" };
        assert!(foreign_path(foreign));
        conn.execute("INSERT INTO client_preferences(key,value) VALUES(?1,?2)", params![CONFIG_DIRECTORY, foreign]).unwrap();
        assert_eq!(claude_home_in(&conn).unwrap(), default_claude_home().unwrap());
        let saved: String = conn.query_row("SELECT value FROM client_preferences WHERE key=?1", [CONFIG_DIRECTORY], |r| r.get(0)).unwrap();
        assert_eq!(saved, foreign);
        assert!(resolve_claude_home(Some(foreign.into()), dirs::home_dir()).is_err());
    }

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn
    }

    #[test]
    fn saving_and_listing_round_trips() {
        let conn = db();
        let mut target = provider("demo", "示例", "https://example.test", "https://api.example.test/anthropic", &[("sonnet", "m1")]);
        target.api_key = "sk-1".into();
        save_provider(&conn, &target, 10).unwrap();
        let listed = list_providers(&conn).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].api_key, "sk-1");
        assert_eq!(listed[0].models["sonnet"]["model"], json!("m1"));
    }

    #[test]
    fn the_current_marker_never_reaches_storage() {
        let conn = db();
        let target = mark_current(provider("demo", "示例", "", "https://x", &[]));
        save_provider(&conn, &target, 10).unwrap();
        set_current(&conn, "demo").unwrap();
        let raw: String = conn.query_row("SELECT settings_json FROM claude_providers WHERE id='demo'", [], |row| row.get(0)).unwrap();
        assert!(!raw.contains(IS_CURRENT_MARKER), "运行时标记不应写进数据库");
        // 但读出来时当前状态是带上的。
        assert!(list_providers(&conn).unwrap()[0].extra_env.contains_key(IS_CURRENT_MARKER));
    }

    #[test]
    fn only_one_provider_is_current() {
        let conn = db();
        save_provider(&conn, &provider("a", "A", "", "https://a", &[]), 10).unwrap();
        save_provider(&conn, &provider("b", "B", "", "https://b", &[]), 10).unwrap();
        set_current(&conn, "a").unwrap();
        assert_eq!(current_provider_id(&conn).unwrap().as_deref(), Some("a"));
        set_current(&conn, "b").unwrap();
        assert_eq!(current_provider_id(&conn).unwrap().as_deref(), Some("b"));
    }

    #[test]
    fn setting_a_missing_provider_current_fails() {
        let conn = db();
        assert!(set_current(&conn, "nope").is_err());
    }

    #[test]
    fn blank_names_are_rejected() {
        let conn = db();
        let blank = provider("", "  ", "", "https://x", &[]);
        assert!(save_provider(&conn, &blank, 10).is_err());
    }

    #[test]
    fn presets_carry_no_keys() {
        for item in presets() {
            assert!(item.api_key.is_empty(), "{} 预置不应携带密钥", item.name);
            assert!(!item.base_url.is_empty());
        }
    }

    #[test]
    fn backups_are_retained_without_a_count_limit() {
        let conn = db();
        for index in 0..25 {
            conn.execute("INSERT INTO claude_provider_backups(created_at,content) VALUES(?1,?2)", params![index, format!("{{\"n\":{index}}}")]).unwrap();
        }
        let root = std::env::temp_dir().join(format!("cloudhub-backup-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("settings.json");
        fs::write(&path, "{}").unwrap();
        assert!(backup_at(&conn, 100, &path).unwrap());
        fs::remove_dir_all(root).unwrap();
        let kept: i64 = conn.query_row("SELECT COUNT(*) FROM claude_provider_backups", [], |row| row.get(0)).unwrap();
        assert_eq!(kept, 26);
    }

    #[test]
    fn reading_a_missing_settings_file_yields_an_empty_object() {
        let path = std::env::temp_dir().join(format!("cloudhub-missing-{}", uuid::Uuid::new_v4())).join("settings.json");
        assert_eq!(read_settings_at(&path).unwrap(), json!({}));
    }
}
