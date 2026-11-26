//! Pi coding agent 的供应商与默认模型配置（默认目录 `~/.pi/agent`，可由 `PI_CODING_AGENT_DIR` 覆盖）。
//! 写入 `models.json`、`settings.json` 与 `mcp.json` 前保留对应文件的历史版本，
//! 未识别的字段（compat、headers、modelOverrides 等）原样保留；API Key 不回传界面。
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const APIS: &[&str] = &[
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
    "bedrock-converse-stream",
    "mistral-conversations",
];
const THINKING_LEVELS: &[&str] = &["off", "minimal", "low", "medium", "high", "xhigh", "max"];
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInput {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    reasoning: Option<bool>,
    #[serde(default)]
    context_window: Option<u64>,
    #[serde(default)]
    max_tokens: Option<u64>,
    /// 仅新建模型时采用（来自内置预设），编辑已有模型时保留文件中的 compat。
    #[serde(default)]
    compat: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInput {
    #[serde(default)]
    original_id: Option<String>,
    id: String,
    name: String,
    base_url: String,
    api: String,
    /// 为空时保留现有密钥。
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    compat: Option<Value>,
    models: Vec<ModelInput>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Action {
    State,
    Inspect { resource: Resource },
    AddMcp { name: String, url: String },
    AddPrompt { name: String, content: String },
    OpenSkillsDirectory,
    ModelCatalog {
        provider: Option<String>,
        #[serde(rename = "baseUrl")]
        base_url: String,
        api: String,
        #[serde(rename = "apiKey")]
        api_key: Option<String>,
    },
    Save { provider: ProviderInput },
    ImportProviders { providers: Vec<ProviderInput> },
    Delete { id: String },
    DeleteProviders { ids: Vec<String> },
    SetDefault {
        provider: String,
        model: String,
        #[serde(default)]
        thinking: Option<String>,
    },
    RestoreBackup { id: String },
    OpenConfigDirectory,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Resource {
    Usage,
    Mcp,
    Prompts,
    Skills,
    Sessions,
}

pub fn action(action: Action) -> Result<Value, String> {
    let _guard = LOCK.lock().map_err(|_| "Pi 配置状态不可用")?;
    match action {
        Action::State => {}
        Action::Inspect { resource } => return inspect(resource),
        Action::AddMcp { name, url } => {
            let name = name.trim();
            if name.is_empty() || name.len() > 64 || !name.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte)) {
                return Err("MCP 名称只能包含字母、数字、下划线和短横线".into());
            }
            let url = url.trim();
            if url.len() > 512 || !valid_url(url) {
                return Err("请填写无凭据、查询参数和片段的 HTTP(S) 地址".into());
            }
            let path = agent_dir()?.join("mcp.json");
            let mut config = read_object(&path)?.unwrap_or_default();
            let servers = config.entry("mcpServers").or_insert_with(|| json!({})).as_object_mut().ok_or("Pi 的 mcpServers 配置必须是对象")?;
            let normalized = name.replace('-', "_");
            if servers.keys().any(|key| key.replace('-', "_") == normalized) {
                return Err("同名 MCP 服务器已存在".into());
            }
            servers.insert(name.into(), json!({ "url": url, "enabled": false }));
            backup_current(&path)?;
            write_object(&path, &config)?;
            return inspect(Resource::Mcp);
        }
        Action::AddPrompt { name, content } => {
            let name = name.trim();
            if !valid_id(name) || name.ends_with('.') || content.trim().is_empty() || content.len() > 64 * 1024 {
                return Err("请填写有效的模板名称和正文，正文最多 64 KB".into());
            }
            let dir = ensure_resource_directory("prompts")?;
            let path = dir.join(format!("{name}.md"));
            let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&path)
                .map_err(|error| if error.kind() == std::io::ErrorKind::AlreadyExists { "同名提示词模板已存在" } else { "无法创建 Pi 提示词模板" })?;
            private_permissions(&path);
            if file.write_all(content.as_bytes()).and_then(|_| file.sync_all()).is_err() {
                drop(file);
                let _ = fs::remove_file(&path);
                return Err("写入 Pi 提示词模板失败".into());
            }
            return inspect(Resource::Prompts);
        }
        Action::OpenSkillsDirectory => {
            let dir = ensure_resource_directory("skills")?;
            tauri_plugin_opener::open_path(&dir, None::<&str>).map_err(|_| "无法打开 Pi 技能目录")?;
            return Ok(Value::Null);
        }
        Action::ModelCatalog { .. } => return Err("Pi 模型目录命令不可用".into()),
        Action::Save { provider } => save(provider)?,
        Action::ImportProviders { providers } => import_providers(providers)?,
        Action::Delete { id } => delete(&[id])?,
        Action::DeleteProviders { ids } => delete(&ids)?,
        Action::SetDefault { provider, model, thinking } => set_default(&provider, &model, thinking.as_deref())?,
        Action::RestoreBackup { id } => restore_backup(&id)?,
        Action::OpenConfigDirectory => {
            let dir = agent_dir()?;
            if !dir.is_dir() {
                return Err("Pi 配置目录尚未创建，请先运行一次 pi".into());
            }
            tauri_plugin_opener::open_path(&dir, None::<&str>).map_err(|_| "无法打开 Pi 配置目录")?;
        }
    }
    state()
}

fn ensure_resource_directory(name: &str) -> Result<PathBuf, String> {
    let dir = agent_dir()?.join(name);
    if !history_exists(&dir).map_err(|_| "Pi 资源目录不可用")? {
        fs::create_dir_all(&dir).map_err(|_| "无法创建 Pi 资源目录")?;
    }
    Ok(dir)
}

// These views return metadata only. Pi configuration and session bodies stay on disk.
fn resource_files(root: &Path, depth: usize, matches: impl Fn(&Path) -> bool) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut pending = vec![(root.to_path_buf(), depth)];
    let mut remaining = 4096;
    while let Some((dir, depth)) = pending.pop() {
        if remaining == 0 || !fs::symlink_metadata(&dir).is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink()) {
            continue;
        }
        let Ok(entries) = fs::read_dir(dir) else { continue };
        for entry in entries.take(remaining) {
            remaining -= 1;
            let Ok(entry) = entry else { continue };
            let Ok(kind) = entry.file_type() else { continue };
            let path = entry.path();
            if kind.is_dir() && depth > 0 {
                pending.push((path, depth - 1));
            } else if kind.is_file() && matches(&path) {
                files.push(path);
            }
        }
    }
    files
}

fn inspect(resource: Resource) -> Result<Value, String> {
    use std::io::Read;

    let dir = agent_dir()?;
    let mut rows = Vec::new();
    let mut skipped = 0;
    match resource {
        Resource::Mcp => {
            if let Some(config) = read_object(&dir.join("mcp.json"))? {
                if let Some(servers) = config.get("mcpServers") {
                    let servers = servers.as_object().ok_or("Pi 的 mcpServers 配置必须是对象")?;
                    for (name, server) in servers {
                        if !name.is_empty() && name.len() <= 120 && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte)) {
                            let transport = if server.get("url").is_some() { "HTTP" } else if server.get("command").is_some() { "stdio" } else { "未指定" };
                            rows.push(json!({ "name": name, "detail": transport, "enabled": server.get("enabled").and_then(Value::as_bool).unwrap_or(true) }));
                        }
                    }
                }
            }
        }
        Resource::Prompts | Resource::Skills => {
            let prompts = matches!(resource, Resource::Prompts);
            let folder = if prompts { "prompts" } else { "skills" };
            let mut locations = vec![(dir.join(folder), "Pi 用户目录", if prompts { 0 } else { 4 })];
            if !prompts {
                if let Some(home) = dirs::home_dir() {
                    locations.push((home.join(".agents").join("skills"), "用户共享技能", 4));
                }
            }
            let settings = read_object(&dir.join("settings.json"))?.unwrap_or_default();
            if let Some(entries) = settings.get(folder).and_then(Value::as_array) {
                for entry in entries.iter().take(100).filter_map(Value::as_str) {
                    let path = if let Some(rest) = entry.strip_prefix("~/").or_else(|| entry.strip_prefix("~\\")) {
                        let Some(home) = dirs::home_dir() else { continue };
                        home.join(rest)
                    } else if Path::new(entry).is_absolute() {
                        PathBuf::from(entry)
                    } else {
                        dir.join(entry)
                    };
                    locations.push((path, "settings.json", 4));
                }
            }
            let mut seen = HashSet::new();
            for (root, source, depth) in locations {
                let is_markdown = |path: &Path| path.extension().is_some_and(|ext| ext == "md");
                let files = if is_markdown(&root) && backup_time_unbounded(&root).is_some() {
                    vec![root.clone()]
                } else {
                    resource_files(&root, depth, |path| if prompts { is_markdown(path) } else { path.ends_with("SKILL.md") })
                };
                for path in files {
                    if !seen.insert(path.clone()) { continue; }
                    let name = if path.ends_with("SKILL.md") && !prompts { path.parent().and_then(Path::file_name) } else { path.file_stem() };
                    if let Some(name) = name {
                        rows.push(json!({ "name": name.to_string_lossy(), "detail": path.strip_prefix(&dir).unwrap_or(&path).to_string_lossy(), "source": source }));
                    }
                }
            }
            rows.sort_by(|a, b| a["detail"].as_str().cmp(&b["detail"].as_str()));
        }
        Resource::Sessions | Resource::Usage => {
            let usage = matches!(resource, Resource::Usage);
            let root = dir.join("sessions");
            let mut files: Vec<_> = resource_files(&root, 1, |path| path.extension().is_some_and(|ext| ext == "jsonl"))
                .into_iter().filter_map(|path| Some((backup_time_unbounded(&path)?, path))).collect();
            files.sort_unstable_by_key(|(time, _)| std::cmp::Reverse(*time));
            for (time, path) in files.into_iter().take(if usage { 30 } else { 100 }) {
                let Some(name) = path.file_name() else { continue };
                if !usage {
                    rows.push(json!({ "name": name.to_string_lossy(), "modifiedAt": time }));
                    continue;
                }
                let mut data = String::new();
                if fs::File::open(&path).and_then(|file| file.take(MAX_FILE_BYTES + 1).read_to_string(&mut data)).is_err()
                    || data.len() as u64 > MAX_FILE_BYTES
                {
                    skipped += 1;
                    continue;
                }
                let (mut calls, mut tokens) = (0u64, 0u64);
                for line in data.lines() {
                    let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
                    let metrics = match entry["type"].as_str() {
                        Some("message") if entry["message"]["role"] == "assistant" => &entry["message"]["usage"],
                        Some("usage" | "compaction" | "branch_summary") => &entry["usage"],
                        _ => continue,
                    };
                    if let Some(total) = metrics["totalTokens"].as_u64() {
                        calls += 1;
                        tokens = tokens.saturating_add(total);
                    }
                }
                rows.push(json!({ "name": name.to_string_lossy(), "modifiedAt": time, "calls": calls, "tokens": tokens }));
            }
        }
    }
    Ok(json!({ "rows": rows, "skipped": skipped }))
}

fn backup_time_unbounded(path: &Path) -> Option<u64> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.file_type().is_symlink() { return None; }
    Some(meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64)
}

pub fn catalog_configuration(provider: Option<String>, base_url: String, api: String, api_key: Option<String>)
    -> Result<(crate::core::repositories::ai::Profile, zeroize::Zeroizing<String>), String>
{
    use crate::core::repositories::ai::{query_configuration, ModelQueryConfig};
    let protocol = match api.as_str() {
        "openai-completions" | "mistral-conversations" => "openai_chat",
        "openai-responses" => "openai_responses",
        "anthropic-messages" => "claude",
        "google-generative-ai" => "gemini",
        _ => return Err("该协议请手动添加模型".into()),
    };
    let api_key = match api_key.filter(|key| !key.trim().is_empty()) {
        Some(key) => key,
        None => {
            let id = provider.filter(|id| valid_id(id)).ok_or("请填写 API Key")?;
            let (models_path, _) = paths()?;
            let root = read_object(&models_path)?.ok_or("请填写 API Key")?;
            let saved = root.get("providers").and_then(|providers| providers.get(id)).ok_or("请填写 API Key")?;
            if saved.get("baseUrl").and_then(Value::as_str).map(|url| url.trim_end_matches('/')) != Some(base_url.trim_end_matches('/'))
                || saved.get("api").and_then(Value::as_str) != Some(api.as_str())
            {
                return Err("修改地址或协议后，请重新填写 API Key 再查询".into());
            }
            let key = saved.get("apiKey");
            if key_kind(key) != "literal" {
                return Err("请填写用于查询的 API Key，或手动添加模型".into());
            }
            key.and_then(Value::as_str).unwrap_or_default().to_owned()
        }
    };
    if api_key.trim_start().starts_with(['!', '$']) {
        return Err("请填写用于查询的实际 API Key，或手动添加模型".into());
    }
    let conn = crate::core::database::open_db()?;
    query_configuration(&conn, None, None, ModelQueryConfig {
        protocol: protocol.into(), base_url, api_key: Some(api_key), allow_loopback_http: true, timeout_seconds: 15,
    })
}

fn agent_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir();
    if let Some(raw) = std::env::var_os("PI_CODING_AGENT_DIR").filter(|value| !value.is_empty()) {
        let text = raw.to_string_lossy();
        let path = match (text.strip_prefix("~/").or_else(|| text.strip_prefix("~\\")), home) {
            (Some(rest), Some(home)) => home.join(rest),
            _ => PathBuf::from(&raw),
        };
        return if path.is_absolute() { Ok(path) } else { Err("PI_CODING_AGENT_DIR 必须是绝对路径".into()) };
    }
    home.map(|home| home.join(".pi").join("agent")).ok_or_else(|| "无法确定 Pi 配置目录".into())
}

fn backup_path(path: &Path) -> PathBuf {
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    path.with_file_name(format!("{name}.cloudhub.bak"))
}

fn history_directory(path: &Path) -> PathBuf {
    path.with_file_name(".cloudhub-pi-backups")
}

fn backup_kind(path: &Path) -> &'static str {
    if path.ends_with("models.json") { "models" }
    else if path.ends_with("mcp.json") { "mcp" }
    else { "settings" }
}

fn history_exists(dir: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(dir) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        _ => Err("Pi 备份目录不可用".into()),
    }
}

fn backup_time(path: &Path) -> Option<u64> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    Some(meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64)
}

fn list_backups(models: &Path, settings: &Path, mcp: &Path) -> Result<Vec<Value>, String> {
    let mut records = Vec::new();
    let history = history_directory(models);
    if history_exists(&history)? {
        for entry in fs::read_dir(&history).map_err(|_| "读取 Pi 备份目录失败")?.flatten() {
            let name = entry.file_name();
            let Some(id) = name.to_str().and_then(|name| name.strip_suffix(".json")) else { continue };
            let Some((kind, version)) = id.split_once('-') else { continue };
            if !matches!(kind, "models" | "settings" | "mcp") || uuid::Uuid::parse_str(version).is_err() {
                continue;
            }
            if let Some(time) = backup_time(&entry.path()) {
                records.push((time, json!({ "id": id, "file": format!("{kind}.json"), "createdAt": time })));
            }
        }
    }
    for path in [models, settings, mcp] {
        if let Some(time) = backup_time(&backup_path(path)) {
            let kind = backup_kind(path);
            records.push((time, json!({ "id": format!("{kind}-legacy"), "file": format!("{kind}.json"), "createdAt": time, "legacy": true })));
        }
    }
    records.sort_unstable_by_key(|(time, _)| std::cmp::Reverse(*time));
    Ok(records.into_iter().map(|(_, record)| record).collect())
}

fn read_object(path: &Path) -> Result<Option<Map<String, Value>>, String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("读取 Pi 配置失败".into()),
    };
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return Err("Pi 配置是链接、目录或超过大小限制，未读取".into());
    }
    let text = fs::read_to_string(path).map_err(|_| "读取 Pi 配置失败")?;
    let text = text.trim_start_matches('\u{feff}');
    if text.trim().is_empty() {
        return Ok(Some(Map::new()));
    }
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) => Ok(Some(map)),
        Ok(_) => Err("Pi 配置必须是 JSON 对象，未改写".into()),
        Err(_) => Err("Pi 配置不是合法 JSON，未改写".into()),
    }
}

#[cfg(unix)]
fn private_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}
#[cfg(not(unix))]
fn private_permissions(_path: &Path) {}

/// 原子写入：同目录临时文件写完并落盘后再替换，失败时清理临时文件。
fn write_object(path: &Path, value: &Map<String, Value>) -> Result<(), String> {
    let mut text = serde_json::to_string_pretty(value).map_err(|_| "写入 Pi 配置失败")?;
    text.push('\n');
    write_bytes(path, text.as_bytes())
}

fn write_bytes(path: &Path, content: &[u8]) -> Result<(), String> {
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err("Pi 配置超过大小限制，未写入".into());
    }
    let dir = path.parent().ok_or("Pi 配置路径无效")?;
    fs::create_dir_all(dir).map_err(|_| "创建 Pi 配置目录失败")?;
    if fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink() || !meta.is_file()) {
        return Err("Pi 配置是链接、目录或超过大小限制，未读取".into());
    }
    let temp = dir.join(format!(".cloudhub-pi-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut file = fs::OpenOptions::new().create_new(true).write(true).open(&temp).map_err(|_| "写入 Pi 配置失败")?;
        private_permissions(&temp);
        file.write_all(content).map_err(|_| "写入 Pi 配置失败")?;
        file.sync_all().map_err(|_| "写入 Pi 配置失败")?;
        drop(file);
        fs::rename(&temp, path).map_err(|_| "写入 Pi 配置失败")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn backup_current(path: &Path) -> Result<(), String> {
    if read_object(path)?.is_some() {
        let history = history_directory(path);
        if !history_exists(&history)? {
            fs::create_dir(&history).map_err(|_| "创建 Pi 备份目录失败")?;
        }
        let backup = history.join(format!("{}-{}.json", backup_kind(path), uuid::Uuid::new_v4()));
        let current = fs::read(path).map_err(|_| "读取当前 Pi 配置失败")?;
        write_bytes(&backup, &current).map_err(|_| "备份 Pi 配置失败")?;
    }
    Ok(())
}

fn backup_and_write(path: &Path, value: &Map<String, Value>) -> Result<(), String> {
    backup_current(path)?;
    write_object(path, value)
}

fn clean_text(value: &str, max: usize) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.chars().count() <= max && !value.chars().any(char::is_control)).then(|| value.to_string())
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn valid_url(value: &str) -> bool {
    reqwest::Url::parse(value).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
    })
}

fn key_kind(value: Option<&Value>) -> &'static str {
    match value.and_then(Value::as_str).map(str::trim) {
        None | Some("") => "none",
        Some(key) if key.starts_with('$') => "env",
        Some(key) if key.starts_with('!') => "command",
        Some(_) => "literal",
    }
}

fn summary(id: &str, provider: &Value) -> Value {
    let text = |key: &str| provider.get(key).and_then(Value::as_str).map(str::to_string);
    let models: Vec<Value> = provider
        .get("models")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|model| {
                    let model_id = model.get("id")?.as_str()?;
                    Some(json!({
                        "id": model_id,
                        "name": model.get("name").and_then(Value::as_str),
                        "reasoning": model.get("reasoning").and_then(Value::as_bool).unwrap_or(false),
                        "contextWindow": model.get("contextWindow").and_then(Value::as_u64),
                        "maxTokens": model.get("maxTokens").and_then(Value::as_u64),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();
    let kind = key_kind(provider.get("apiKey"));
    // 环境变量名不是密钥，可以展示；字面量密钥与 !command 均不回传。
    let key_reference = (kind == "env").then(|| text("apiKey")).flatten();
    json!({
        "id": id,
        "name": text("name").unwrap_or_else(|| id.to_string()),
        "baseUrl": text("baseUrl"),
        "api": text("api"),
        "keyKind": kind,
        "keyReference": key_reference,
        "models": models,
    })
}

fn state() -> Result<Value, String> {
    let dir = agent_dir()?;
    let models_path = dir.join("models.json");
    let settings_path = dir.join("settings.json");
    let mcp_path = dir.join("mcp.json");
    let models = read_object(&models_path)?;
    let settings = read_object(&settings_path)?;
    let providers: Vec<Value> = models
        .as_ref()
        .and_then(|root| root.get("providers"))
        .and_then(Value::as_object)
        .map(|providers| providers.iter().map(|(id, provider)| summary(id, provider)).collect())
        .unwrap_or_default();
    let setting = |key: &str| settings.as_ref().and_then(|root| root.get(key)).and_then(Value::as_str).map(str::to_string);
    let backups = list_backups(&models_path, &settings_path, &mcp_path)?;
    Ok(json!({
        "agentDir": dir.display().to_string(),
        "modelsFile": models_path.display().to_string(),
        "settingsFile": settings_path.display().to_string(),
        "modelsExists": models.is_some(),
        "settingsExists": settings.is_some(),
        "providers": providers,
        "defaultProvider": setting("defaultProvider"),
        "defaultModel": setting("defaultModel"),
        "defaultThinkingLevel": setting("defaultThinkingLevel"),
        "backups": backups,
    }))
}

fn paths() -> Result<(PathBuf, PathBuf), String> {
    let dir = agent_dir()?;
    Ok((dir.join("models.json"), dir.join("settings.json")))
}

fn providers_mut(root: &mut Map<String, Value>) -> Result<&mut Map<String, Value>, String> {
    root.entry("providers")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| "Pi 配置中的 providers 必须是对象，未改写".into())
}

fn upsert_provider(providers: &mut Map<String, Value>, input: ProviderInput) -> Result<String, String> {
    let id = input.id.trim().to_string();
    if !valid_id(&id) {
        return Err("Pi 供应商标识只能包含字母、数字、点、下划线和短横线".into());
    }
    let name = clean_text(&input.name, 80).ok_or("Pi 供应商名称无效")?;
    let base_url = input.base_url.trim().trim_end_matches('/').to_string();
    if !valid_url(&base_url) {
        return Err("请求地址必须为不含凭据、查询参数及片段的 HTTP(S) 地址".into());
    }
    if !APIS.contains(&input.api.as_str()) {
        return Err("Pi 接口协议无效".into());
    }
    if input.models.is_empty() || input.models.len() > 200 {
        return Err("Pi 模型列表需要 1 至 200 个模型".into());
    }
    let api_key = match input.api_key.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(key) if key.len() <= 4096 && !key.chars().any(char::is_control) => Some(key.to_string()),
        Some(_) => return Err("API Key 格式无效".into()),
    };
    let original = input.original_id.as_deref().map(str::trim).filter(|value| !value.is_empty());

    if let Some(original) = original {
        if !providers.contains_key(original) {
            return Err("Pi 供应商不存在，请刷新后重试".into());
        }
    }
    if original != Some(id.as_str()) && providers.contains_key(&id) {
        return Err("Pi 供应商标识已存在".into());
    }
    let mut provider = original.and_then(|original| providers.get(original).cloned()).unwrap_or_else(|| json!({}));
    let fields = provider.as_object_mut().ok_or("Pi 供应商配置损坏")?;
    fields.insert("name".into(), json!(name));
    fields.insert("baseUrl".into(), json!(base_url));
    fields.insert("api".into(), json!(input.api));
    if let Some(key) = api_key {
        fields.insert("apiKey".into(), json!(key));
    }
    if let Some(Value::Object(compat)) = input.compat {
        fields.entry("compat").or_insert(Value::Object(compat));
    }
    let existing = fields.get("models").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut seen = HashSet::new();
    let mut models = Vec::with_capacity(input.models.len());
    for item in input.models {
        let model_id = clean_text(&item.id, 200).ok_or("Pi 模型 ID 无效")?;
        if !seen.insert(model_id.clone()) {
            return Err("Pi 模型 ID 不能重复".into());
        }
        let mut model = existing
            .iter()
            .find(|model| model.get("id").and_then(Value::as_str) == Some(model_id.as_str()))
            .filter(|model| model.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}));
        if let Some(entry) = model.as_object_mut() {
            entry.insert("id".into(), json!(model_id));
            match item.name.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
                Some(display) => {
                    let display = clean_text(display, 120).ok_or("Pi 模型名称无效")?;
                    entry.insert("name".into(), json!(display));
                }
                None => {
                    entry.remove("name");
                }
            }
            if let Some(reasoning) = item.reasoning {
                entry.insert("reasoning".into(), json!(reasoning));
            }
            for (field, value) in [("contextWindow", item.context_window), ("maxTokens", item.max_tokens)] {
                if let Some(value) = value {
                    if value == 0 || value > 100_000_000 {
                        return Err("Pi 模型上下文或输出上限无效".into());
                    }
                    entry.insert(field.into(), json!(value));
                }
            }
            if let Some(Value::Object(compat)) = item.compat {
                entry.entry("compat").or_insert(Value::Object(compat));
            }
        }
        models.push(model);
    }
    fields.insert("models".into(), Value::Array(models));
    if let Some(original) = original.filter(|original| *original != id) {
        providers.remove(original);
    }
    providers.insert(id.clone(), provider);
    Ok(id)
}

fn import_providers(inputs: Vec<ProviderInput>) -> Result<(), String> {
    if inputs.is_empty() {
        return Err("文件中没有供应商".into());
    }
    let (models_path, _) = paths()?;
    let mut root = read_object(&models_path)?.unwrap_or_default();
    let providers = providers_mut(&mut root)?;
    for mut input in inputs {
        input.original_id = None;
        input.api_key = None;
        input.compat = None;
        for model in &mut input.models {
            model.compat = None;
        }
        upsert_provider(providers, input)?;
    }
    if serde_json::to_vec_pretty(&root).map_err(|_| "无法生成 Pi 配置")?.len() as u64 > MAX_FILE_BYTES {
        return Err("导入后的 Pi 配置超过 2 MB".into());
    }
    backup_and_write(&models_path, &root)
}

fn save(input: ProviderInput) -> Result<(), String> {
    let original = input.original_id.clone();
    let original = original.as_deref().map(str::trim).filter(|value| !value.is_empty());
    let (models_path, settings_path) = paths()?;
    let mut root = read_object(&models_path)?.unwrap_or_default();
    let id = upsert_provider(providers_mut(&mut root)?, input)?;
    backup_and_write(&models_path, &root)?;

    // 改名时同步默认供应商，避免 Pi 启动后找不到原标识。
    if let Some(original) = original.filter(|original| *original != id) {
        if let Some(mut settings) = read_object(&settings_path)? {
            if settings.get("defaultProvider").and_then(Value::as_str) == Some(original) {
                settings.insert("defaultProvider".into(), json!(id));
                backup_and_write(&settings_path, &settings)?;
            }
        }
    }
    Ok(())
}

fn delete(ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Err("请先选择供应商".into());
    }
    let (models_path, settings_path) = paths()?;
    let default_provider = read_object(&settings_path)?
        .and_then(|settings| settings.get("defaultProvider").and_then(Value::as_str).map(str::to_string));
    if ids.iter().any(|id| default_provider.as_deref() == Some(id.as_str())) {
        return Err("该供应商是 Pi 默认供应商，请先切换默认模型".into());
    }
    let mut root = read_object(&models_path)?.ok_or("Pi 供应商不存在，请刷新后重试")?;
    let providers = providers_mut(&mut root)?;
    for id in ids {
        if providers.remove(id).is_none() {
            return Err("Pi 供应商不存在，请刷新后重试".into());
        }
    }
    backup_and_write(&models_path, &root)
}

fn set_default(provider: &str, model: &str, thinking: Option<&str>) -> Result<(), String> {
    let provider = provider.trim();
    let model = clean_text(model, 200).ok_or("Pi 默认模型无效")?;
    if !valid_id(provider) {
        return Err("Pi 默认模型无效".into());
    }
    let thinking = thinking.map(str::trim).filter(|value| !value.is_empty());
    if thinking.is_some_and(|level| !THINKING_LEVELS.contains(&level)) {
        return Err("Pi 思考级别无效".into());
    }
    let (_, settings_path) = paths()?;
    let mut settings = read_object(&settings_path)?.unwrap_or_default();
    settings.insert("defaultProvider".into(), json!(provider));
    settings.insert("defaultModel".into(), json!(model));
    if let Some(level) = thinking {
        settings.insert("defaultThinkingLevel".into(), json!(level));
    }
    backup_and_write(&settings_path, &settings)
}

fn restore_backup(id: &str) -> Result<(), String> {
    let (models_path, settings_path) = paths()?;
    let (kind, version) = id.split_once('-').ok_or("无效的 Pi 备份标识")?;
    let path = match kind {
        "models" => models_path,
        "settings" => settings_path,
        "mcp" => agent_dir()?.join("mcp.json"),
        _ => return Err("无效的 Pi 备份标识".into()),
    };
    let backup = if version == "legacy" {
        backup_path(&path)
    } else {
        let version = uuid::Uuid::parse_str(version).map_err(|_| "无效的 Pi 备份标识")?;
        let history = history_directory(&path);
        if !history_exists(&history)? {
            return Err("Pi 备份不存在，请刷新后重试".into());
        }
        history.join(format!("{kind}-{version}.json"))
    };
    read_object(&backup)?.ok_or("Pi 备份不存在，请刷新后重试")?;
    let content = fs::read(&backup).map_err(|_| "读取 Pi 备份失败")?;
    backup_current(&path)?;
    write_bytes(&path, &content)
}
