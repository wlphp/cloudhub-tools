use super::{
    claude_gateway::{self as gateway, Mode},
    claude_providers::{ApiFormat, ApiKeyField, ClaudeProvider},
    crypto::{decrypt_secret, encrypt_secret},
    database::open_db,
    repositories::claude_providers as repo,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

const STATE: &str = "claude.desktop.state";
const BACKUP: &str = "claude.desktop.backup";
const PROFILE: &str = "3e8d7dc3-dfb6-495a-8ce1-542ac901a533";
const DEFAULT_PORT: u16 = 15722;

fn default_port() -> u16 {
    DEFAULT_PORT
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Selection {
    mode: Mode,
    provider: String,
    members: Vec<String>,
}

#[derive(Default, Deserialize, Serialize)]
struct Settings {
    selection: Selection,
    #[serde(default)]
    applied: bool,
    providers: Vec<ClaudeProvider>,
    token: String,
    #[serde(default)]
    gateway_settings: GatewaySettings,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewaySettings {
    #[serde(default = "default_port")]
    port: u16,
    timeout_secs: u64,
    first_byte_secs: u64,
    idle_secs: u64,
    logging: bool,
}

impl Default for GatewaySettings {
    fn default() -> Self {
        let config = gateway::Config::default();
        Self { port: DEFAULT_PORT, timeout_secs: config.timeout_secs, first_byte_secs: config.first_byte_secs, idle_secs: config.idle_secs, logging: config.logging }
    }
}

impl GatewaySettings {
    fn config(&self) -> gateway::Config {
        gateway::Config { port: self.port, timeout_secs: self.timeout_secs, first_byte_secs: self.first_byte_secs,
            idle_secs: self.idle_secs, logging: self.logging, ..gateway::Config::default() }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Action {
    State,
    RoutingState,
    DiagnoseConnection,
    SaveGatewaySettings { settings: GatewaySettings },
    OpenConfigDirectory,
    RevealConfigKey,
    Reorder { ids: Vec<String> },
    Save { provider: Value },
    Delete { id: String },
    Import { ids: Vec<String> },
    Apply { selection: Selection },
    Resume,
}

static RUNTIME: tokio::sync::Mutex<Option<gateway::Running>> = tokio::sync::Mutex::const_new(None);

fn settings() -> Result<Settings, String> {
    let Some(raw) = gateway::preference(STATE)? else {
        return Ok(Settings::default());
    };
    serde_json::from_str(&decrypt_secret(&raw)?).map_err(|_| "Claude Desktop 设置无法读取".into())
}

pub(super) fn configured_port() -> Result<u16, String> {
    Ok(settings()?.gateway_settings.port)
}

fn check_code_port(port: u16) -> Result<(), String> {
    if port == gateway::config()?.port {
        return Err("Claude Desktop 与 Claude Code 的监听端口必须不同".into());
    }
    Ok(())
}

fn save(state: &Settings) -> Result<(), String> {
    let content = serde_json::to_string(state).map_err(|_| "Claude Desktop 设置无效")?;
    gateway::save_preference(STATE, &encrypt_secret(&content)?)
}

fn paths() -> Result<[PathBuf; 4], String> {
    let root = match std::env::consts::OS {
        "windows" => std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
        "macos" => dirs::home_dir().map(|p| p.join("Library/Application Support")),
        _ => return Err("当前系统不支持应用 Claude Desktop 配置".into()),
    }
    .ok_or("无法定位 Claude Desktop 配置目录")?;
    let normal = root.join("Claude");
    let third_party = root.join("Claude-3p");
    let library = third_party.join("configLibrary");
    Ok([
        normal.join("claude_desktop_config.json"),
        third_party.join("claude_desktop_config.json"),
        library.join("_meta.json"),
        library.join(format!("{PROFILE}.json")),
    ])
}

fn read(path: &Path) -> Result<Option<Value>, String> {
    for ancestor in path.ancestors() {
        if let Ok(meta) = ancestor.symlink_metadata() {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    return Err("Claude Desktop 配置路径包含重解析点".into());
                }
            }
            if meta.file_type().is_symlink() {
                return Err("Claude Desktop 配置路径包含链接".into());
            }
        }
    }
    if !path
        .try_exists()
        .map_err(|_| "无法检查 Claude Desktop 配置")?
    {
        return Ok(None);
    }
    repo::read_settings_at(path).map(Some)
}

fn write(path: &Path, value: Option<&Value>) -> Result<(), String> {
    match value {
        Some(value) => {
            let parent = path.parent().ok_or("Desktop 配置路径无效")?;
            fs::create_dir_all(parent).map_err(|_| "无法创建 Claude Desktop 配置目录")?;
            let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(&temporary)
                .map_err(|_| "无法写入 Claude Desktop 临时配置")?;
            let result = (|| {
                serde_json::to_writer_pretty(&mut file, value)
                    .map_err(|_| "无法写入 Claude Desktop 配置")?;
                file.flush()
                    .and_then(|_| file.sync_all())
                    .map_err(|_| "无法保存 Claude Desktop 配置")
            })();
            drop(file);
            let result = result.and_then(|_| {
                fs::rename(&temporary, path).map_err(|_| "无法替换 Claude Desktop 配置")
            });
            if result.is_err() {
                let _ = fs::remove_file(temporary);
            }
            result.map_err(str::to_owned)
        }
        None => match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("无法移除 CloudHub 管理的 Claude Desktop 配置".into()),
        },
    }
}

fn apply_files(profile: Option<Value>, state: &Settings) -> Result<(), String> {
    let paths = paths()?;
    let before = paths
        .iter()
        .map(|p| read(p))
        .collect::<Result<Vec<_>, _>>()?;
    let mut after = before.clone();
    for doc in &mut after[..2] {
        let mut next = doc.clone().unwrap_or_else(|| json!({}));
        next["deploymentMode"] = json!(if profile.is_some() { "3p" } else { "1p" });
        *doc = Some(next);
    }
    if profile.is_some() || after[2].is_some() {
        let mut meta = after[2].clone().unwrap_or_else(|| json!({}));
        let object = meta.as_object_mut().ok_or("Claude Desktop 配置索引无效")?;
        let entries = object
            .entry("entries")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or("Claude Desktop 配置索引无效")?;
        entries.retain(|entry| entry["id"] != PROFILE);
        if profile.is_some() {
            entries.push(json!({"id": PROFILE, "name": "CloudHub Tools"}));
            object.insert("appliedId".into(), json!(PROFILE));
        } else if object.get("appliedId").is_some_and(|id| id == PROFILE) {
            object.remove("appliedId");
        }
        after[2] = Some(meta);
    }
    after[3] = profile;
    let order = [3, 2, 1, 0];
    gateway::save_preference(BACKUP, &encrypt_secret(&json!(before).to_string())?)?;
    let mut written = Vec::new();
    let result = (|| {
        for index in order {
            if before[index] != after[index] {
                if read(&paths[index])? != before[index] {
                    return Err(
                        "Claude Desktop 配置在应用期间发生变化，请关闭 Desktop 后重试".into(),
                    );
                }
                write(&paths[index], after[index].as_ref())?;
                written.push(index);
            }
        }
        save(state)
    })();
    if let Err(error) = result {
        let mut rollback_failed = false;
        for index in written.into_iter().rev() {
            if read(&paths[index]).is_ok_and(|current| current == after[index]) {
                rollback_failed |= write(&paths[index], before[index].as_ref()).is_err();
            } else {
                rollback_failed = true;
            }
        }
        return Err(if rollback_failed {
            "应用配置失败，且部分文件未能回滚，已保留加密备份".into()
        } else {
            error
        });
    }
    Ok(())
}

fn profile(url: &str, key: &str, scheme: &str, models: Vec<Value>) -> Value {
    json!({
        "disableDeploymentModeChooser": true,
        "inferenceProvider": "gateway",
        "inferenceGatewayBaseUrl": url,
        "inferenceGatewayApiKey": key,
        "inferenceGatewayAuthScheme": scheme,
        "inferenceModels": models,
    })
}

fn preview_model_id(name: &str) -> Option<&str> {
    let (family, suffix) = name.strip_prefix("claude-")?.split_once('-')?;
    if !matches!(family, "sonnet" | "opus" | "haiku" | "fable") {
        return None;
    }
    let id = suffix.strip_suffix("[1m]").unwrap_or(suffix);
    let conventional = id == "latest" || (id.len() <= 20 && id.split('-').all(|part| {
        !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())
    }));
    let gateway_alias = id.strip_prefix("cloudhub-").is_some_and(|hash| {
        hash.len() == 24 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
    });
    (conventional || gateway_alias).then_some(name)
}

fn config_preview(index: usize, doc: &Value) -> Value {
    // Project known fields and validate model IDs before exposing values from these files.
    match index {
        0 | 1 => json!({
            "deploymentMode": doc["deploymentMode"].as_str().filter(|mode| matches!(*mode, "1p" | "3p")),
        }),
        2 => json!({
            "cloudHubProfileRegistered": doc["entries"].as_array().is_some_and(|entries| entries.iter().any(|entry| entry["id"] == PROFILE)),
            "cloudHubProfileApplied": doc["appliedId"] == PROFILE,
            "profileCount": doc["entries"].as_array().map(Vec::len),
        }),
        _ => json!({
            "disableDeploymentModeChooser": doc["disableDeploymentModeChooser"].as_bool(),
            "inferenceProvider": doc["inferenceProvider"].as_str().filter(|provider| *provider == "gateway"),
            "inferenceGatewayBaseUrl": doc["inferenceGatewayBaseUrl"].as_str().map(|url| {
                match url.strip_prefix("http://127.0.0.1:").and_then(|port| port.parse::<u16>().ok()) {
                    Some(port) if url == format!("http://127.0.0.1:{port}") => url.to_owned(),
                    _ => "[地址已隐藏]".into(),
                }
            }),
            "inferenceGatewayApiKey": doc["inferenceGatewayApiKey"].as_str().map(|_| "[已隐藏]"),
            "inferenceGatewayAuthScheme": doc["inferenceGatewayAuthScheme"].as_str().filter(|scheme| matches!(*scheme, "bearer" | "x-api-key")),
            "inferenceModelCount": doc["inferenceModels"].as_array().map(Vec::len),
            "inferenceModels": doc["inferenceModels"].as_array().map(|models| models.iter().map(|model| json!({
                "name": model["name"].as_str().map(|name| preview_model_id(name).unwrap_or("[自定义模型 ID 已隐藏]")),
                "supports1m": model["supports1m"].as_bool(),
                "prefer1m": model["prefer1m"].as_bool(),
            })).collect::<Vec<_>>()),
            "modelDiscoveryEnabled": doc["modelDiscoveryEnabled"].as_bool(),
        }),
    }
}

fn get_provider<'a>(state: &'a Settings, id: &str) -> Result<&'a ClaudeProvider, String> {
    state
        .providers
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "请选择有效的供应商".into())
}

fn provider_models(p: &ClaudeProvider) -> Vec<super::claude_providers::ModelMapping> {
    let mut seen = HashSet::new();
    gateway::models(p)
        .into_iter()
        .filter_map(|mut model| {
            let plain = model
                .model
                .trim_end_matches("[1M]")
                .trim_end_matches("[1m]");
            model.supports_1m |= plain.len() != model.model.len();
            model.model = plain.trim_end().to_owned();
            seen.insert(model.model.clone()).then_some(model)
        })
        .collect()
}

fn desktop_model(name: &str, label: Option<&str>, supports_1m: bool) -> Value {
    let mut item = json!({ "name": name });
    if let Some(label) = label.filter(|label| !label.is_empty()) {
        item["labelOverride"] = json!(label);
    }
    if supports_1m {
        item["supports1m"] = json!(true);
        item["prefer1m"] = json!(true);
    }
    item
}

fn direct(p: &ClaudeProvider) -> Result<Value, String> {
    let url = gateway::validate_url(&p.base_url)?;
    if p.api_format != ApiFormat::Anthropic || p.is_full_url || url.scheme() != "https" {
        return Err("直连需要 HTTPS Anthropic Messages 基础地址，请改用路由".into());
    }
    let models = provider_models(p)
        .into_iter()
        .map(|m| {
            if ![
                "claude-sonnet-",
                "claude-opus-",
                "claude-haiku-",
                "claude-fable-",
            ]
            .iter()
            .any(|prefix| m.model.starts_with(prefix))
            {
                return Err("供应商包含 Desktop 无法直连的模型，请改用路由".into());
            }
            Ok(desktop_model(
                &m.model,
                Some(&m.display_name),
                m.supports_1m,
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    if models.is_empty() || models.len() > 200 {
        return Err("直连需要配置 1 至 200 个 Desktop 兼容模型".into());
    }
    let scheme = if p.api_key_field == ApiKeyField::ApiKey {
        "x-api-key"
    } else {
        "bearer"
    };
    Ok(profile(
        url.as_str().trim_end_matches('/'),
        &p.api_key,
        scheme,
        models,
    ))
}

fn routes(state: &Settings, selection: &Selection) -> Result<Vec<gateway::DesktopModel>, String> {
    let mut seen = HashSet::new();
    let mut output = Vec::new();
    for id in std::iter::once(&selection.provider).chain(selection.members.iter()) {
        if !seen.insert(id) {
            return Err("聚合名单包含重复供应商".into());
        }
        let p = get_provider(state, id)?;
        let upstream = gateway::validate_url(&p.base_url)?;
        if upstream.port_or_known_default() == Some(state.gateway_settings.port)
            && upstream
                .host_str()
                .is_some_and(|host| matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "0.0.0.0"))
        {
            return Err("供应商地址不能指向 Claude Desktop 本机网关".into());
        }
        let models = provider_models(p);
        if models.is_empty() {
            return Err("每个供应商至少需要配置一个模型".into());
        }
        let shared_provider = Arc::new(p.clone());
        for m in models {
            let digest =
                Sha256::digest(serde_json::to_vec(&(&p.id, &m.model)).map_err(|_| "模型标识无效")?);
            let name = if m.display_name.is_empty() {
                &m.model
            } else {
                &m.display_name
            };
            let label = if selection.mode == Mode::Aggregate {
                format!("{} / {name}", p.name)
            } else {
                name.clone()
            };
            output.push(gateway::DesktopModel {
                id: format!(
                    "claude-{}-cloudhub-{}",
                    if m.model.contains("opus") {
                        "opus"
                    } else if m.model.contains("haiku") {
                        "haiku"
                    } else if m.model.contains("fable") {
                        "fable"
                    } else {
                        "sonnet"
                    },
                    hex::encode(&digest[..12])
                ),
                label,
                provider: shared_provider.clone(),
                upstream: m.model,
                supports_1m: m.supports_1m,
            });
        }
    }
    if output.is_empty() || output.len() > 200 {
        return Err("Claude Desktop 支持 1 至 200 个模型".into());
    }
    Ok(output)
}

fn summary(p: &ClaudeProvider) -> Result<Value, String> {
    let mut data = serde_json::to_value(p).map_err(|_| "无法读取供应商")?;
    let fields = data.as_object_mut().ok_or("供应商格式无效")?;
    for key in [
        "apiKey",
        "extraEnv",
        "proxyHeaderOverride",
        "proxyBodyOverride",
    ] {
        fields.remove(key);
    }
    data["keyConfigured"] = json!(!p.api_key.is_empty());
    Ok(data)
}

fn active(state: &Settings, id: &str) -> bool {
    !id.is_empty()
        && (state.selection.provider == id
            || state.selection.members.iter().any(|member| member == id))
}

fn validate(p: &ClaudeProvider) -> Result<(), String> {
    if uuid::Uuid::parse_str(&p.id).is_err()
        || p.name.trim().is_empty()
        || p.name.len() > 240
        || p.official_login
        || p.api_key.trim().is_empty()
        || p.api_key.len() > 8192
        || reqwest::header::HeaderValue::from_str(&p.api_key).is_err()
        || p.model_catalog.len() > 200
    {
        return Err("供应商名称、API Key 或模型数量无效".into());
    }
    gateway::validate_url(&p.base_url)?;
    repo::validate_models(&p.models)?;
    if gateway::models(p)
        .iter()
        .any(|m| m.model.is_empty() || m.model.len() > 512 || m.model.chars().any(char::is_control))
    {
        return Err("模型 ID 无效".into());
    }
    Ok(())
}

async fn apply_selection(
    runtime: &mut Option<gateway::Running>,
    state: &mut Settings,
    selection: Selection,
) -> Result<(), String> {
    if selection.members.len() > 100
        || (selection.mode != Mode::Aggregate && !selection.members.is_empty())
    {
        return Err("供应商名单与模式不匹配".into());
    }
    let mut pending = None;
    let mut new_routes = None;
    let doc = if selection.mode == Mode::Direct {
        if selection.provider.is_empty() {
            None
        } else {
            Some(direct(get_provider(state, &selection.provider)?)?)
        }
    } else {
        let port = state.gateway_settings.port;
        check_code_port(port)?;
        let models = Arc::new(routes(state, &selection)?);
        if state.token.is_empty() {
            state.token = uuid::Uuid::new_v4().to_string();
        }
        if runtime.as_ref().is_none_or(|running| !running.is_running()) {
            pending = Some(gateway::start_desktop(port, &state.token, selection.mode, models.clone(), state.gateway_settings.config()).await?);
        }
        let items = models
            .iter()
            .map(|m| desktop_model(&m.id, Some(&m.label), m.supports_1m))
            .collect();
        new_routes = Some(models);
        let mut doc = profile(
            &format!("http://127.0.0.1:{port}"),
            &state.token,
            "bearer",
            items,
        );
        doc["modelDiscoveryEnabled"] = json!(true);
        Some(doc)
    };
    state.selection = selection;
    state.applied = true;
    apply_files(doc, state)?;
    if let Some(routes) = new_routes {
        if let Some(running) = pending {
            *runtime = Some(running);
        }
        if let Some(running) = runtime.as_ref() {
            running.update_desktop_routes(state.selection.mode, routes);
        }
    } else {
        runtime.take();
    }
    Ok(())
}

async fn diagnose_connection(state: &Settings, runtime: Option<&gateway::Running>) -> Result<Value, String> {
    use std::time::{Duration, Instant};

    let [normal, third_party, index, profile_path] = paths()?;
    let expects_profile = !state.selection.provider.is_empty();
    let expected_mode = if expects_profile { "3p" } else { "1p" };
    let mode_matches = |path: &Path| read(path).ok().flatten()
        .is_some_and(|doc| doc["deploymentMode"] == expected_mode);
    let normal_mode_matches = mode_matches(&normal);
    let third_party_mode_matches = mode_matches(&third_party);
    let selected = read(&index).ok().flatten().is_some_and(|doc| doc["appliedId"] == PROFILE
        && doc["entries"].as_array().is_some_and(|entries| entries.iter().any(|entry| entry["id"] == PROFILE)));
    let profile = read(&profile_path).ok().flatten().unwrap_or(Value::Null);
    let model_count = profile["inferenceModels"].as_array().map_or(0, Vec::len);
    let configured_url = profile["inferenceGatewayBaseUrl"].as_str();
    let local_url = format!("http://127.0.0.1:{}", state.gateway_settings.port);
    let running = runtime.is_some_and(gateway::Running::is_running);
    let started = Instant::now();
    let probe = if !expects_profile {
        "official"
    } else if !selected || !normal_mode_matches || !third_party_mode_matches || model_count == 0 {
        "config_mismatch"
    } else if state.selection.mode != Mode::Direct {
        if configured_url != Some(local_url.as_str()) || state.token.is_empty()
            || profile["inferenceGatewayAuthScheme"] != "bearer"
            || profile["inferenceGatewayApiKey"].as_str() != Some(state.token.as_str()) {
            "config_mismatch"
        } else if !running {
            "gateway_stopped"
        } else {
            let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(3)).build().map_err(|_| "无法初始化连接诊断")?;
            match client.get(format!("{local_url}/v1/models")).bearer_auth(&state.token).send().await {
                Ok(response) if response.status().is_success() => "models_available",
                _ => "models_unavailable",
            }
        }
    } else {
        let expected = direct(get_provider(state, &state.selection.provider)?)?;
        match configured_url.filter(|url| expected["inferenceGatewayBaseUrl"].as_str() == Some(*url)
            && profile["inferenceGatewayApiKey"] == expected["inferenceGatewayApiKey"]
            && profile["inferenceGatewayAuthScheme"] == expected["inferenceGatewayAuthScheme"])
            .and_then(|url| gateway::validate_url(url).ok())
        {
            Some(url) => {
                let host = url.host_str().ok_or("直连地址缺少主机名")?.trim_matches(['[', ']']);
                let port = url.port_or_known_default().ok_or("直连地址缺少端口")?;
                match tokio::time::timeout(Duration::from_secs(3), tokio::net::TcpStream::connect((host, port))).await {
                    Ok(Ok(_)) => "tcp_available",
                    _ => "tcp_unavailable",
                }
            }
            None => "config_mismatch",
        }
    };
    Ok(json!({
        "mode": state.selection.mode,
        "applied": state.applied,
        "normalModeMatches": normal_mode_matches,
        "thirdPartyModeMatches": third_party_mode_matches,
        "profileSelected": selected,
        "modelCount": model_count,
        "probe": probe,
        "durationMs": started.elapsed().as_millis() as u64,
    }))
}

pub async fn action(action: Action) -> Result<Value, String> {
    let mut runtime = RUNTIME.lock().await;
    if matches!(action, Action::RoutingState) {
        let snapshot = runtime.as_ref().map(gateway::Running::desktop_snapshot).transpose()?;
        return Ok(json!(snapshot));
    }
    let mut state = settings()?;
    match action {
        Action::State => {}
        Action::RoutingState => unreachable!(),
        Action::DiagnoseConnection => return diagnose_connection(&state, runtime.as_ref()).await,
        Action::SaveGatewaySettings { settings } => {
            let config = settings.config();
            config.validate()?;
            if config.port != state.gateway_settings.port && state.selection.mode != Mode::Direct {
                return Err("请先回到直连，再修改监听端口".into());
            }
            let _writer = gateway::CONFIG_WRITER.lock().map_err(|_| "配置正在使用")?;
            check_code_port(config.port)?;
            state.gateway_settings = settings;
            save(&state)?;
            if let Some(running) = runtime.as_ref() {
                running.update_desktop_config(config);
            }
        }
        Action::RevealConfigKey => {
            let [_, _, _, profile] = paths()?;
            let doc = read(&profile).map_err(|_| "无法读取 Claude Desktop 连接方案")?;
            let key = doc.as_ref()
                .and_then(|doc| doc["inferenceGatewayApiKey"].as_str())
                .filter(|key| !key.is_empty())
                .ok_or("连接方案中没有密钥")?;
            return Ok(json!({ "key": key }));
        }
        Action::Reorder { ids } => {
            let positions: HashMap<_, _> = ids
                .iter()
                .enumerate()
                .map(|(index, id)| (id.as_str(), index))
                .collect();
            if ids.len() != state.providers.len()
                || positions.len() != ids.len()
                || state.providers.iter().any(|provider| !positions.contains_key(provider.id.as_str()))
            {
                return Err("供应商列表已变化，请刷新后重新排序".into());
            }
            state.providers.sort_by_key(|provider| positions[provider.id.as_str()]);
            save(&state)?;
        }
        Action::OpenConfigDirectory => {
            let paths = paths()?;
            let index = if state.selection.provider.is_empty() { 0 } else { 1 };
            let directory = paths[index].parent().ok_or("无法确定配置目录")?;
            if !directory.is_dir() {
                return Err("Claude Desktop 配置目录尚未创建".into());
            }
            tauri_plugin_opener::open_path(directory, None::<&str>)
                .map_err(|_| "无法打开 Claude Desktop 配置目录")?;
        }
        Action::Save { mut provider } => {
            let old = state.providers.iter().position(|p| provider["id"] == p.id);
            if provider["apiKey"]
                .as_str()
                .is_none_or(|key| key.trim().is_empty())
            {
                provider["apiKey"] = json!(old
                    .map(|index| state.providers[index].api_key.as_str())
                    .unwrap_or(""));
            }
            let mut p: ClaudeProvider =
                serde_json::from_value(provider).map_err(|_| "供应商表单无效")?;
            p.extra_env.clear();
            p.proxy_header_override = Value::Null;
            p.proxy_body_override = Value::Null;
            validate(&p)?;
            let in_use = active(&state, &p.id);
            match old {
                Some(index) => state.providers[index] = p,
                None => state.providers.push(p),
            }
            if in_use {
                let selection = state.selection.clone();
                apply_selection(&mut runtime, &mut state, selection).await?;
            } else {
                save(&state)?;
            }
        }
        Action::Delete { id } => {
            let in_use = active(&state, &id);
            state.providers.retain(|p| p.id != id);
            if in_use {
                let mut selection = state.selection.clone();
                selection.members.retain(|member| member != &id);
                if selection.provider == id {
                    selection = if selection.members.is_empty() {
                        Selection::default()
                    } else {
                        selection.provider = selection.members.remove(0);
                        selection
                    };
                }
                apply_selection(&mut runtime, &mut state, selection).await?;
            } else {
                save(&state)?;
            }
        }
        Action::Import { ids } => {
            let providers = repo::list_providers(&open_db()?)?;
            for mut p in providers
                .into_iter()
                .filter(|p| ids.contains(&p.id) && !p.official_login)
            {
                p.extra_env.clear();
                p.proxy_header_override = Value::Null;
                p.proxy_body_override = Value::Null;
                if state.providers.iter().any(|old| {
                    old.name == p.name
                        && old.base_url == p.base_url
                        && old.api_format == p.api_format
                        && old.api_key == p.api_key
                }) {
                    continue;
                }
                p.id = uuid::Uuid::new_v4().to_string();
                validate(&p)?;
                state.providers.push(p);
            }
            save(&state)?;
        }
        Action::Resume => {
            if state.selection.mode != Mode::Direct
                && runtime.as_ref().is_none_or(|running| !running.is_running())
            {
                if state.token.is_empty() {
                    return Err("本机网关授权缺失，请重新应用 Desktop 配置".into());
                }
                let port = state.gateway_settings.port;
                check_code_port(port)?;
                *runtime = Some(
                    gateway::start_desktop(
                        port,
                        &state.token,
                        state.selection.mode,
                        Arc::new(routes(&state, &state.selection)?),
                        state.gateway_settings.config(),
                    )
                    .await?,
                );
            }
        }
        Action::Apply { selection } => {
            apply_selection(&mut runtime, &mut state, selection).await?;
        }
    }
    let providers = state
        .providers
        .iter()
        .map(summary)
        .collect::<Result<Vec<_>, _>>()?;
    let config_files = paths()
        .ok()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(index, path)| {
            let (status, preview) = match read(&path) {
                Ok(Some(doc)) => ("readable", Some(config_preview(index, &doc))),
                Ok(None) => ("missing", None),
                Err(_) => ("unreadable", None),
            };
            json!({ "path": path, "status": status, "preview": preview })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "selection": state.selection,
        "applied": state.applied,
        "running": runtime.as_ref().is_some_and(gateway::Running::is_running),
        "providers": providers,
        "gatewayConfig": state.gateway_settings.config(),
        "configFiles": config_files
    }))
}

pub async fn resume() {
    let _ = action(Action::Resume).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_desktop_gateway_settings_keep_their_own_default_port() {
        let legacy = json!({"timeoutSecs": 600, "firstByteSecs": 90, "idleSecs": 180, "logging": true});
        let settings: GatewaySettings = serde_json::from_value(legacy).unwrap();
        assert_eq!(settings.config().port, 15722);
        assert_ne!(settings.config().port, gateway::Config::default().port);

        let custom = GatewaySettings { port: 16722, ..settings };
        let restored: GatewaySettings = serde_json::from_value(json!(custom)).unwrap();
        assert_eq!(restored.config().port, 16722);
    }
}
