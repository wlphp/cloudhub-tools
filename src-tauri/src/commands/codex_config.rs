use crate::core::{codex::{profile, rpc}, error::{PlatformError, PlatformResult}};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, time::Duration};
use tauri_plugin_dialog::DialogExt;
use zeroize::{Zeroize, Zeroizing};

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ConfigAction { State, SelectProject, OpenDirectory, Preview, PreviewConfig, RevealConfig, PreviewAuth, RevealAuth, PreviewCatalog, RevealCatalog }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigSource {
    path: String,
    workspace: Option<String>,
    exists: bool,
    auth_exists: bool,
    preview: Option<Value>,
    config_preview: Option<Value>,
    auth_path: String,
    auth_preview: Option<Value>,
    catalog_path: String,
    catalog_preview: Option<Value>,
}

#[tauri::command]
pub(crate) async fn codex_config_source(
    app: tauri::AppHandle,
    action: ConfigAction,
    workspace: Option<String>,
) -> PlatformResult<Option<ConfigSource>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<ConfigSource>, String> {
        let workspace = if matches!(action, ConfigAction::SelectProject) {
            let Some(selected) = app.dialog().file().set_title("选择 Codex 项目目录").blocking_pick_folder() else { return Ok(None); };
            Some(selected.into_path().map_err(|_| "项目目录路径无效")?)
        } else { workspace.map(PathBuf::from) };
        let workspace = workspace.map(|path| {
            if !path.is_absolute() { return Err("项目目录必须为绝对路径".to_string()); }
            let path = path.canonicalize().map_err(|_| "项目目录不存在")?;
            if !path.is_dir() || path.to_str().is_none() { return Err("请选择有效的项目目录".into()); }
            Ok(path)
        }).transpose()?;
        let home = profile::default_home()?;
        let directory = workspace.as_ref().map(|path| path.join(".codex")).unwrap_or_else(|| home.clone());
        let path = directory.join("config.toml");
        // Authentication always belongs to CODEX_HOME, including project views.
        let auth_path = home.join("auth.json");
        let catalog_path = home.join(crate::core::codex::provider_config::CATALOG_FILE);
        let auth_exists = fs::symlink_metadata(&auth_path).is_ok();
        if matches!(action, ConfigAction::OpenDirectory) {
            // Opening a missing config directory must not create project files.
            let target = if directory.is_dir() { &directory } else { workspace.as_ref().unwrap_or(&home) };
            if !target.is_dir() { return Err("Codex 配置目录尚不存在".into()); }
            tauri_plugin_opener::open_path(target, None::<&str>).map_err(|_| "无法打开 Codex 配置目录")?;
        }
        let mut config_preview = None;
        let preview = if matches!(action, ConfigAction::Preview | ConfigAction::PreviewConfig | ConfigAction::RevealConfig) {
            let _writer = super::codex::AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
            // Config layers can refer to assets inside CODEX_HOME. Read them in
            // place; config/read does not request login or credential refresh.
            let mut server = rpc::AppServer::start(&home).map_err(|_| "无法读取配置，请确认官方 Codex CLI 已安装且配置有效")?;
            let response = server.request("config/read", json!({
                "includeLayers": false,
                "cwd": workspace.as_ref().unwrap_or(&home).to_string_lossy()
            }), Duration::from_secs(20)).map_err(|_| "官方 CLI 无法读取配置，请检查配置格式或 CLI 版本")?;
            let config = response.get("config").and_then(Value::as_object).ok_or("CLI 未返回有效配置")?;
            if matches!(action, ConfigAction::PreviewConfig | ConfigAction::RevealConfig) {
                let mut full = Value::Object(config.clone());
                if !matches!(action, ConfigAction::RevealConfig) { mask_config(&mut full, false); }
                config_preview = Some(full);
            }
            // Only known, non-secret scalar settings cross the native boundary.
            // Provider maps, MCP environments and arbitrary config may contain credentials.
            let mut safe = serde_json::Map::new();
            for key in ["model", "model_provider", "model_reasoning_effort", "model_verbosity", "approval_policy", "sandbox_mode", "service_tier", "web_search", "model_context_window", "model_auto_compact_token_limit"] {
                if let Some(value) = config.get(key).filter(|v| v.is_null() || v.is_string() || v.is_number() || v.is_boolean()) {
                    safe.insert(key.into(), value.clone());
                }
            }
            Some(Value::Object(safe))
        } else { None };
        let auth_preview = if matches!(action, ConfigAction::PreviewAuth | ConfigAction::RevealAuth) {
            let reveal = matches!(action, ConfigAction::RevealAuth);
            let _writer = super::codex::AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
            match fs::symlink_metadata(&auth_path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(_) => return Err("无法读取 auth.json 文件状态".into()),
                Ok(_) => {
                    let content = profile::read_auth(&auth_path).map_err(|_| "无法安全读取 auth.json，请检查文件权限、类型及大小")?;
                    let value: Value = serde_json::from_str(&content).map_err(|_| "auth.json 格式无效，无法预览")?;
                    value.as_object().ok_or("auth.json 必须为 JSON 对象")?;
                    let mut full = value;
                    if !reveal {
                        if let Some(object) = full.as_object_mut() {
                            for (key, value) in object {
                                if !matches!(key.as_str(), "auth_mode" | "last_refresh") { mask_config(value, true); }
                            }
                        }
                    }
                    Some(full)
                }
            }
        } else { None };
        let catalog_preview = if matches!(action, ConfigAction::PreviewCatalog | ConfigAction::RevealCatalog) {
            let _writer = super::codex::AUTH_WRITER.lock().map_err(|_| "Codex 配置操作不可用")?;
            match fs::symlink_metadata(&catalog_path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(_) => return Err("无法读取模型目录文件状态".into()),
                Ok(_) => {
                    let content = profile::read_auth(&catalog_path).map_err(|_| "无法安全读取模型目录，请检查文件权限、类型及大小")?;
                    let mut value: Value = serde_json::from_str(&content).map_err(|_| "模型目录 JSON 格式无效，无法预览")?;
                    value.as_object().ok_or("模型目录必须为 JSON 对象")?;
                    if !matches!(action, ConfigAction::RevealCatalog) { mask_config(&mut value, false); }
                    Some(value)
                }
            }
        } else { None };
        Ok(Some(ConfigSource {
            path: path.to_string_lossy().into_owned(),
            workspace: workspace.map(|path| path.to_string_lossy().into_owned()),
            exists: fs::metadata(&path).is_ok_and(|meta| meta.is_file()),
            auth_exists,
            preview,
            config_preview,
            auth_path: auth_path.to_string_lossy().into_owned(),
            auth_preview,
            catalog_path: catalog_path.to_string_lossy().into_owned(),
            catalog_preview,
        }))
    }).await.map_err(|_| config_error("读取 Codex 配置任务失败".into()))?.map_err(config_error)
}

/// Rebuild the user-level Codex model catalog from the active OpenAI-compatible
/// provider. Credentials remain in the native process and are never returned.
#[tauri::command]
pub(crate) async fn codex_refresh_model_catalog(workspace: Option<String>) -> PlatformResult<usize> {
    let (home, base_url, credential, context_window, compact_limit) = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        let _writer = super::codex::AUTH_WRITER.lock().map_err(|_| "Codex 配置操作不可用")?;
        let home = profile::default_home()?;
        let workspace = workspace.map(PathBuf::from).map(|path| {
            if !path.is_absolute() { return Err("项目目录必须为绝对路径".to_string()); }
            let path = path.canonicalize().map_err(|_| "项目目录不存在")?;
            if !path.is_dir() { return Err("请选择有效的项目目录".into()); }
            Ok(path)
        }).transpose()?;
        let cwd = workspace.as_ref().unwrap_or(&home);
        let mut server = rpc::AppServer::start(&home).map_err(|_| "无法读取当前 Codex 配置，请确认官方 CLI 已安装且配置有效")?;
        let response = server.request("config/read", json!({"includeLayers": false, "cwd": cwd.to_string_lossy()}), Duration::from_secs(20))
            .map_err(|_| "官方 CLI 无法读取当前配置")?;
        let config = response.get("config").ok_or("当前配置无效")?;
        let provider_id = config.get("model_provider").and_then(Value::as_str).filter(|value| !value.trim().is_empty()).ok_or("当前配置没有选择模型供应商")?;
        let provider = config.get("model_providers").and_then(|value| value.get(provider_id)).ok_or("当前模型供应商配置不完整")?;
        let base_url = provider.get("base_url").and_then(Value::as_str).filter(|value| !value.trim().is_empty()).ok_or("当前模型供应商没有 API 地址")?.trim().to_owned();
        crate::core::codex::provider_probe::endpoint(&base_url, "models")?;

        let inline = provider.get("experimental_bearer_token").or_else(|| provider.get("api_key")).and_then(Value::as_str).filter(|value| !value.trim().is_empty());
        let env_key = provider.get("env_key").and_then(Value::as_str).filter(|value| !value.trim().is_empty());
        let credential = if let Some(value) = inline {
            Zeroizing::new(value.to_owned())
        } else if let Some(name) = env_key {
            if !name.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_') { return Err("当前供应商的凭据配置不受支持".into()); }
            Zeroizing::new(std::env::var(name).map_err(|_| "当前供应商所需的环境变量未设置")?)
        } else {
            let auth_path = home.join("auth.json");
            let auth_text = profile::read_auth(&auth_path).map_err(|_| "当前配置没有可读取的 API Key 凭据")?;
            let auth: Value = serde_json::from_str(&auth_text).map_err(|_| "auth.json 格式无效")?;
            let key = auth.get("OPENAI_API_KEY").or_else(|| auth.get("openai_api_key")).and_then(Value::as_str).filter(|value| !value.trim().is_empty()).ok_or("当前配置没有可用于查询模型的 API Key")?;
            Zeroizing::new(key.to_owned())
        };
        if credential.is_empty() || credential.len() > 16_384 || credential.chars().any(char::is_control) { return Err("当前供应商凭据格式无效".into()); }
        let context_window = config.get("model_context_window").and_then(Value::as_i64).filter(|value| (4_096..=10_000_000).contains(value));
        let compact_limit = config.get("model_auto_compact_token_limit").and_then(Value::as_i64).filter(|value| (1_024..=10_000_000).contains(value) && context_window.is_none_or(|context| *value <= context));
        Ok((home, base_url, credential, context_window, compact_limit))
    }).await.map_err(|_| config_error("准备模型目录刷新失败".into()))?.map_err(config_error)?;

    let result = crate::core::codex::provider_probe::run(&base_url, "responses", &credential, None).await
        .map_err(|_| config_error("连接当前模型供应商失败，请检查网络和配置".into()))?;
    if result.error.is_some() { return Err(config_error("当前模型供应商未能返回有效模型列表，请检查 API Key、地址或接口兼容性".into())); }
    let count = result.models.len();
    if count == 0 { return Err(config_error("当前模型供应商返回了空列表，现有目录未更改".into())); }

    let mut settings = crate::core::codex::providers::ModelSettings {
        models: result.models,
        models_scoped: true,
        default_model: None,
        context_window,
        compact_limit,
    };
    let catalog = crate::core::codex::provider_config::build_catalog(&settings, None);
    crate::core::codex::model_catalog::validate(&catalog).map_err(|_| config_error("模型目录校验失败，现有目录未更改".into()))?;
    let content = serde_json::to_string(&catalog).map_err(|_| config_error("生成模型目录失败".into()))?;
    settings.models.zeroize();

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let _writer = super::codex::AUTH_WRITER.lock().map_err(|_| "Codex 配置操作不可用")?;
        let path = home.join(crate::core::codex::provider_config::CATALOG_FILE);
        profile::write_private(&path, &content)?;
        crate::core::codex::model_catalog::write_meta(&path, &content);
        Ok(())
    }).await.map_err(|_| config_error("保存模型目录失败".into()))?.map_err(config_error)?;
    Ok(count)
}

// Preserve the complete structure while masking credential values in native code.
fn mask_config(value: &mut Value, sensitive: bool) {
    match value {
        Value::Object(object) => for (key, value) in object {
            let name = key.to_ascii_lowercase().replace('-', "_");
            let secret = sensitive || ["secret", "password", "api_key", "apikey", "authorization", "credential", "private_key", "account_id"].iter().any(|part| name.contains(part))
                || name.ends_with("_token") || name.ends_with("_tokens")
                || matches!(name.as_str(), "token" | "tokens" | "env" | "http_headers" | "headers");
            mask_config(value, secret);
        },
        Value::Array(values) => for value in values { mask_config(value, sensitive); },
        Value::Null => {},
        _ if sensitive => *value = json!("[已隐藏]"),
        _ => {},
    }
}

// All messages in this command are fixed local text; never forward CLI errors,
// which can contain arbitrary configuration values.
fn config_error(message: String) -> PlatformError {
    PlatformError { kind: "platform-error", code: "codex-config", message, retryable: false }
}
