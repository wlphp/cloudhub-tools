//! Claude Code 供应商配置与 `settings.json` 差量合并。
//!
//! 借鉴 cc-switch 的「地板字段」模型，回答三个问题：请求发到哪、凭什么鉴权、用哪个
//! 模型、说哪种协议。这些字段完全归供应商所有，切换时一律先清再写；供应商独有字段
//! 切入时写入、切走时只删本次带进来的；其余键归用户和 Claude Code，本模块不写不删。
//!
//! 失败方向刻意选成安全的一侧：白名单漏掉的键会被当作用户键原样保留，绝不会把用户的
//! hooks、enabledPlugins 等配置误删。

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Claude Code `settings.json` 顶层归供应商所有的键。
pub const FLOOR_TOP: &[&str] = &[
    "apiKeyHelper",
    "apiBaseUrl",
    "primaryModel",
    "smallFastModel",
    // 旧 Bedrock 预设写在顶层的真实 Key。
    "apiKey",
    // `/model` 保存的选择，属于当时所在的那一家。
    "model",
    // 备用模型链：模型 ID → 供应商专属 ID（如 Bedrock ARN）。
    "fallbackModel",
    "modelOverrides",
    "modelPicker",
    "advisorModel",
    "awsAuthRefresh",
    "awsCredentialExport",
    "gcpAuthRefresh",
];

/// `env` 里整个前缀都属于连接和鉴权的键。
pub const FLOOR_ENV_PREFIXES: &[&str] = &["ANTHROPIC_", "AWS_", "VERTEX_REGION_"];

/// Claude Code 的协议选择器。不能按 `CLAUDE_CODE_USE_` 前缀匹配：同一前缀下还有
/// `USE_POWERSHELL_TOOL`、`USE_NATIVE_FILE_SEARCH` 这类与供应商无关的功能开关。
pub const PROTOCOL_SELECTORS: &[&str] = &[
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_GATEWAY",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
];

/// `env` 里按名字列出的关键字段（协议选择器之外）。
pub const FLOOR_ENV_KEYS: &[&str] = &[
    "CLAUDE_CODE_SUBAGENT_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL_FORCE",
    "CLOUD_ML_REGION",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_OAUTH_SCOPES",
    "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
];

/// 供应商独有字段：上游的兼容开关和窗口值。切入时写入，切走时只删本次带进来、而且
/// 值没被用户改过的。它们不是关键字段，因为用户也可能把它们设成全局。
pub const EXCLUSIVE_ENV: &[&str] = &[
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
    "CLAUDE_CODE_DISABLE_ARTIFACT",
    "ENABLE_TOOL_SEARCH",
    "CLAUDE_CODE_DISABLE_THINKING",
    "DISABLE_INTERLEAVED_THINKING",
    "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
    "CLAUDE_CODE_EXTRA_BODY",
    "CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING",
    "CLAUDE_CODE_AUTO_MODE_SERVER",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
    "CLAUDE_CODE_DISABLE_1M_CONTEXT",
    "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
];

/// Claude Code 支持的上游协议格式。默认原生 Anthropic：绝大多数供应商都支持它。
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApiFormat {
    /// 原生 Anthropic Messages API，直接透传。
    #[default]
    Anthropic,
    /// OpenAI Chat Completions，需要转换。
    OpenaiChat,
    /// OpenAI Responses API，需要转换。
    OpenaiResponses,
    Gemini,
}

/// Claude Code 读取的凭据字段名。
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApiKeyField {
    AuthToken,
    ApiKey,
}

impl Default for ApiKeyField {
    fn default() -> Self {
        Self::AuthToken
    }
}

impl ApiKeyField {
    pub fn env_key(self) -> &'static str {
        match self {
            Self::AuthToken => "ANTHROPIC_AUTH_TOKEN",
            Self::ApiKey => "ANTHROPIC_API_KEY",
        }
    }
}

/// 模型档位。Claude Code 用别名请求，上游实际模型由供应商映射决定。
pub const MODEL_ROLES: [&str; 5] = ["sonnet", "opus", "haiku", "fable", "subagent"];

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelMapping {
    /// 上游真实模型名，如 `MiniMax-M3`。
    #[serde(default)]
    pub model: String,
    /// Claude Code 菜单里显示的名字，为空则显示模型名。
    #[serde(default)]
    pub display_name: String,
    /// 上游支持 1M 上下文，写 `[1M]` 后缀。
    #[serde(default)]
    pub supports_1m: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeProvider {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// 官网地址，仅用于展示和打开。
    #[serde(default)]
    pub website_url: String,
    #[serde(default)]
    pub base_url: String,
    /// 运行时凭据；存储层加密，列表接口只返回配置状态。
    pub api_key: String,
    #[serde(default)]
    pub api_key_field: ApiKeyField,
    #[serde(default)]
    pub api_format: ApiFormat,
    /// base_url 是否已经是完整端点，不再拼接 `/v1/messages`。
    #[serde(default)]
    pub is_full_url: bool,
    /// 按档位的模型映射。
    #[serde(default)]
    pub models: Map<String, Value>,
    /// 其他要写进 `env` 的键。
    #[serde(default)]
    pub extra_env: Map<String, Value>,
    #[serde(default)]
    pub official_login: bool,
    #[serde(default)]
    pub model_catalog: Vec<ModelMapping>,
    /// 自定义 User-Agent，用于覆盖上游识别字段；只有路由 / 聚合生效。
    #[serde(default)]
    pub user_agent: String,
    /// 本地代理请求 Header 覆盖（仅路由 / 聚合生效）。
    ///
    /// 存为 `serde_json::Value` 而不是 `String` 是为了兼容老数据：旧 schema 这一字段
    /// 直接是 `Map<String, Value>`，新 schema 是 String。改 schema 后若不兼容读老
    /// `settings_json`，整条记录反序列化失败 → `list_providers` 整体抛错 → 前端把
    /// 这家供应商连同「获取模型列表」按钮一起置灰。`provider_env` 与 `to_summary`
    /// 在使用时再做 String / Object 归一化。
    #[serde(default)]
    pub proxy_header_override: Value,
    /// 本地代理请求 Body 覆盖（仅路由 / 聚合生效），兼容方式同上。
    #[serde(default)]
    pub proxy_body_override: Value,
    /// 默认兜底模型（仅路由 / 聚合生效）。
    #[serde(default)]
    pub fallback_model: Option<ModelMapping>,
}

fn env_of(doc: &Value) -> Map<String, Value> {
    doc.get("env").and_then(Value::as_object).cloned().unwrap_or_default()
}

/// `env` 里这个键是否完全归供应商所有。
pub fn is_floor_env(key: &str) -> bool {
    FLOOR_ENV_PREFIXES.iter().any(|prefix| key.starts_with(prefix))
        || PROTOCOL_SELECTORS.contains(&key)
        || FLOOR_ENV_KEYS.contains(&key)
        || (key.starts_with("CLAUDE_CODE_SKIP_") && key.ends_with("_AUTH"))
}

pub fn is_floor_top(key: &str) -> bool {
    FLOOR_TOP.contains(&key)
}

/// 把 `proxy_header_override` / `proxy_body_override` 字段（兼容老数据可能已经是
/// `Map`，新数据是 JSON 字符串）归一化成 env 可序列化的 `Map<String, Value>`。
/// 返回 `None` 表示内容不是合法 JSON 对象；上层 `provider_env` 静默跳过非法值，
/// 避免一个编辑中的输入把整次切换阻塞。
fn parse_proxy_override(value: &Value) -> Option<Map<String, Value>> {
    if value.is_null() { return None; }
    if let Some(text) = value.as_str() {
        if text.trim().is_empty() { return None; }
        return serde_json::from_str::<Value>(text).ok()?.as_object().cloned();
    }
    value.as_object().cloned()
}

/// 合并结果：最终文档，以及被清掉的独有字段（供切回时精确删除）。
#[derive(Clone, Debug, PartialEq)]
pub struct MergeOutcome {
    pub document: Value,
    /// 本次切入带进来的独占字段，切走时按 key+value 精确删。
    pub written_exclusive: Vec<String>,
}

/// 把供应商配置应用到 live 文档上。
///
/// 地板字段先整体清除再写入目标供应商的值，因此从 A 切到 B 时不会残留 A 的模型别名
/// 或密钥；独占字段先删除「上一家带进来且用户没改过」的，再写入本家的；其余键原样保留。
pub fn apply_provider(live: &Value, provider: &ClaudeProvider) -> MergeOutcome {
    let mut doc = live.clone();
    if !doc.is_object() {
        doc = Value::Object(Map::new());
    }

    // 1) 地板字段：先清后写。顶层与 env 分开处理。
    let incoming = provider_env(provider);
    let mut env = env_of(&doc);
    env.retain(|key, _| !is_floor_env(key));

    // 2) 独占字段：记录本次带进来的，供切走时按 key+value 精确删除。
    let mut written_exclusive = Vec::new();
    for key in EXCLUSIVE_ENV {
        if incoming.contains_key(*key) {
            written_exclusive.push((*key).to_string());
        }
    }

    env.extend(incoming);

    // 顶层模型选择属于当前供应商。
    let primary_model = provider
        .models
        .get("sonnet")
        .and_then(|value| value.get("model"))
        .and_then(Value::as_str)
        .map(str::to_string);

    let root = doc.as_object_mut().expect("object after normalisation");
    root.retain(|key, _| !is_floor_top(key));
    if env.is_empty() {
        root.remove("env");
    } else {
        root.insert("env".to_string(), Value::Object(env));
    }
    if let Some(model) = primary_model.filter(|_| !provider.official_login) {
        root.insert("model".to_string(), Value::String("sonnet".to_string()));
        root.insert("primaryModel".to_string(), Value::String(model));
    }
    MergeOutcome { document: doc, written_exclusive }
}

/// 从供应商配置生成要写入 `env` 的键值。
///
/// `ANTHROPIC_DEFAULT_<ROLE>_MODEL` 写上游真实模型名，`_MODEL_NAME` 写菜单显示名——
/// 这正是 Claude Code 把 `/model` 里的别名翻译成实际模型的方式。
pub fn provider_env(provider: &ClaudeProvider) -> Map<String, Value> {
    let mut env = Map::new();
    if provider.official_login { return env; }
    if !provider.api_key.is_empty() {
        env.insert(provider.api_key_field.env_key().to_string(), Value::String(provider.api_key.clone()));
    }
    if !provider.base_url.is_empty() {
        env.insert("ANTHROPIC_BASE_URL".to_string(), Value::String(provider.base_url.clone()));
    }
    for role in MODEL_ROLES {
        let Some(Value::Object(mapping)) = provider.models.get(role) else { continue };
        let Some(model) = mapping.get("model").and_then(Value::as_str).filter(|value| !value.is_empty()) else { continue };
        let mut id = model.to_string();
        if mapping.get("supports1m").and_then(Value::as_bool).unwrap_or(false) {
            id.push_str("[1M]");
        }
        let prefix = match role {
            "subagent" => "CLAUDE_CODE_SUBAGENT_MODEL".to_string(),
            other => format!("ANTHROPIC_DEFAULT_{}_MODEL", other.to_uppercase()),
        };
        env.insert(prefix, Value::String(id));
        if let Some(name) = mapping.get("displayName").or(mapping.get("display_name")).and_then(Value::as_str).filter(|value| !value.is_empty()) {
            let name_key = match role {
                "subagent" => "CLAUDE_CODE_SUBAGENT_MODEL_NAME".to_string(),
                other => format!("ANTHROPIC_DEFAULT_{}_MODEL_NAME", other.to_uppercase()),
            };
            env.insert(name_key, Value::String(name.to_string()));
        }
    }
    for (key, value) in &provider.extra_env {
        env.insert(key.clone(), value.clone());
    }
    if !provider.user_agent.trim().is_empty() {
        env.insert("ANTHROPIC_CUSTOM_USER_AGENT".to_string(), Value::String(provider.user_agent.clone()));
    }
    if !provider.proxy_header_override.is_null() {
        if let Some(map) = parse_proxy_override(&provider.proxy_header_override) {
            env.insert("ANTHROPIC_CUSTOM_HEADERS".to_string(), Value::Object(map));
        }
    }
    if !provider.proxy_body_override.is_null() {
        if let Some(map) = parse_proxy_override(&provider.proxy_body_override) {
            env.insert("ANTHROPIC_CUSTOM_BODY".to_string(), Value::Object(map));
        }
    }
    if let Some(fallback) = &provider.fallback_model {
        if !fallback.model.trim().is_empty() {
            let mut id = fallback.model.clone();
            if fallback.supports_1m { id.push_str("[1M]"); }
            env.insert("ANTHROPIC_DEFAULT_FALLBACK_MODEL".to_string(), Value::String(id));
        }
    }
    env
}

/// 从供应商行反序列化模型映射，供前端编辑。
pub fn models_from_env(env: &Map<String, Value>) -> Map<String, Value> {
    let mut models = Map::new();
    for role in MODEL_ROLES {
        let key = match role {
            "subagent" => "CLAUDE_CODE_SUBAGENT_MODEL".to_string(),
            other => format!("ANTHROPIC_DEFAULT_{}_MODEL", other.to_uppercase()),
        };
        let name_key = match role {
            "subagent" => "CLAUDE_CODE_SUBAGENT_MODEL_NAME".to_string(),
            other => format!("ANTHROPIC_DEFAULT_{}_MODEL_NAME", other.to_uppercase()),
        };
        let Some(model) = env.get(&key).and_then(Value::as_str) else { continue };
        let mut mapping = Map::new();
        mapping.insert("model".to_string(), Value::String(model.trim_end_matches("[1M]").trim_end_matches("[1m]").to_string()));
        if let Some(name) = env.get(&name_key).and_then(Value::as_str) {
            mapping.insert("displayName".to_string(), Value::String(name.to_string()));
        }
        models.insert(role.to_string(), Value::Object(mapping));
        if model.to_ascii_lowercase().ends_with("[1m]") {
            models.get_mut(role).unwrap()["supports1m"] = Value::Bool(true);
        }
    }
    models
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn provider() -> ClaudeProvider {
        ClaudeProvider {
            id: "minimax".into(),
            name: "MiniMax".into(),
            description: String::new(),
            website_url: String::new(),
            base_url: "https://api.minimaxi.com/anthropic".into(),
            api_key: "sk-test".into(),
            api_key_field: ApiKeyField::AuthToken,
            api_format: ApiFormat::Anthropic,
            is_full_url: false,
            models: Map::from_iter([
                ("sonnet".to_string(), json!({ "model": "MiniMax-M3", "displayName": "MiniMax-M3" })),
                ("haiku".to_string(), json!({ "model": "MiniMax-M2.7" })),
            ]),
            extra_env: Map::from_iter([("DISABLE_INSTALLATION_CHECKS".to_string(), json!("1"))]),
            official_login: false,
            model_catalog: Vec::new(),
            user_agent: String::new(),
            proxy_header_override: Value::Null,
            proxy_body_override: Value::Null,
            fallback_model: None,
        }
    }

    #[test]
    fn floor_covers_connection_keys() {
        for key in ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_DEFAULT_SONNET_MODEL", "AWS_REGION", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_SUBAGENT_MODEL"] {
            assert!(is_floor_env(key), "{key} 应当是地板字段");
        }
        for key in ["apiKey", "model", "primaryModel"] {
            assert!(is_floor_top(key), "{key} 应当是地板字段");
        }
    }

    #[test]
    fn floor_leaves_feature_switches_and_user_keys_alone() {
        // 同前缀下的功能开关不属于供应商。
        for key in ["CLAUDE_CODE_USE_POWERSHELL_TOOL", "CLAUDE_CODE_USE_NATIVE_FILE_SEARCH"] {
            assert!(!is_floor_env(key), "{key} 是功能开关，不该被清理");
        }
        // 用户自定义的 env 原样保留。
        for key in ["MY_COMPANY_TOKEN", "HTTP_PROXY"] {
            assert!(!is_floor_env(key), "{key} 是用户键，不该被清理");
        }
    }

    #[test]
    fn merging_preserves_hooks_and_plugins() {
        let live = json!({
            "env": { "ANTHROPIC_BASE_URL": "http://old", "HTTP_PROXY": "http://proxy" },
            "hooks": { "Stop": [{ "hooks": [{ "type": "command" }] }] },
            "enabledPlugins": { "rust-analyzer@claude-plugins-official": true },
            "language": "简体中文"
        });
        let out = apply_provider(&live, &provider());
        // 用户的配置一个都没少。
        assert!(out.document["hooks"]["Stop"].is_array());
        assert_eq!(out.document["enabledPlugins"]["rust-analyzer@claude-plugins-official"], json!(true));
        assert_eq!(out.document["language"], json!("简体中文"));
        assert_eq!(out.document["env"]["HTTP_PROXY"], json!("http://proxy"));
        // 旧的地址被换掉，不残留。
        assert_eq!(out.document["env"]["ANTHROPIC_BASE_URL"], json!("https://api.minimaxi.com/anthropic"));
    }

    #[test]
    fn switching_between_providers_leaves_no_stale_keys() {
        let mut first = provider();
        first.models.insert("opus".to_string(), json!({ "model": "first-opus" }));
        let live = json!({ "env": {} });
        let after_first = apply_provider(&live, &first);

        let mut second = provider();
        second.api_key = "sk-second".into();
        second.models = Map::from_iter([("sonnet".to_string(), json!({ "model": "second-sonnet" }))]);
        let after_second = apply_provider(&after_first.document, &second);

        let env = after_second.document["env"].as_object().unwrap();
        // 第一家的 opus 映射必须消失，而不是和第二家并存。
        assert!(!env.contains_key("ANTHROPIC_DEFAULT_OPUS_MODEL"));
        assert!(!env.contains_key("ANTHROPIC_DEFAULT_HAIKU_MODEL"));
        assert_eq!(env["ANTHROPIC_DEFAULT_SONNET_MODEL"], json!("second-sonnet"));
        assert_eq!(env["ANTHROPIC_AUTH_TOKEN"], json!("sk-second"));
    }

    #[test]
    fn model_name_and_1m_suffix_are_written() {
        let mut target = provider();
        target.models.insert("opus".to_string(), json!({ "model": "big-model", "displayName": "大模型", "supports1m": true }));
        let env = provider_env(&target);
        assert_eq!(env["ANTHROPIC_DEFAULT_OPUS_MODEL"], json!("big-model[1M]"));
        assert_eq!(env["ANTHROPIC_DEFAULT_OPUS_MODEL_NAME"], json!("大模型"));
    }

    #[test]
    fn subagent_role_uses_its_own_key() {
        let mut target = provider();
        target.models.insert("subagent".to_string(), json!({ "model": "MiniMax-M3" }));
        let env = provider_env(&target);
        assert_eq!(env["CLAUDE_CODE_SUBAGENT_MODEL"], json!("MiniMax-M3"));
    }

    #[test]
    fn api_key_field_choice_is_respected() {
        let mut target = provider();
        target.api_key_field = ApiKeyField::ApiKey;
        let env = provider_env(&target);
        assert!(env.contains_key("ANTHROPIC_API_KEY"));
        assert!(!env.contains_key("ANTHROPIC_AUTH_TOKEN"));
    }

    #[test]
    fn models_round_trip_through_env() {
        let mut target = provider();
        target.models.insert("opus".to_string(), json!({ "model": "big-model", "displayName": "大模型", "supports1m": true }));
        let env = provider_env(&target);
        let parsed = models_from_env(&env);
        // 1M 后缀是传输标记，不属于模型名本身。
        assert_eq!(parsed["opus"]["model"], json!("big-model"));
        assert_eq!(parsed["opus"]["displayName"], json!("大模型"));
        assert_eq!(parsed["sonnet"]["model"], json!("MiniMax-M3"));
    }

    #[test]
    fn empty_env_is_not_written() {
        let live = json!({ "hooks": {} });
        let mut bare = provider();
        bare.api_key = String::new();
        bare.base_url = String::new();
        bare.models = Map::new();
        bare.extra_env = Map::new();
        let out = apply_provider(&live, &bare);
        assert!(out.document.get("env").is_none());
        assert!(out.document["hooks"].is_object());
    }

    #[test]
    fn a_non_object_live_document_is_replaced_safely() {
        let out = apply_provider(&json!("not-an-object"), &provider());
        assert_eq!(out.document["env"]["ANTHROPIC_BASE_URL"], json!("https://api.minimaxi.com/anthropic"));
    }

    #[test]
    fn user_agent_and_proxy_overrides_and_fallback_are_written() {
        let mut target = provider();
        target.user_agent = "Mozilla/5.0 Custom".into();
        target.proxy_header_override = json!(r#"{"X-Trace":"on"}"#);
        target.proxy_body_override = json!(r#"{"temperature":0.1}"#);
        target.fallback_model = Some(ModelMapping { model: "big-fallback".into(), display_name: "兜底".into(), supports_1m: true });
        let env = provider_env(&target);
        assert_eq!(env["ANTHROPIC_CUSTOM_USER_AGENT"], json!("Mozilla/5.0 Custom"));
        assert_eq!(env["ANTHROPIC_CUSTOM_HEADERS"], json!({ "X-Trace": "on" }));
        assert_eq!(env["ANTHROPIC_CUSTOM_BODY"], json!({ "temperature": 0.1 }));
        assert_eq!(env["ANTHROPIC_DEFAULT_FALLBACK_MODEL"], json!("big-fallback[1M]"));
    }

    #[test]
    fn proxy_overrides_drop_invalid_json_silently() {
        // 编辑中的草稿可能瞬时不是合法 JSON；provider_env 解析失败时静默跳过，
        // 不让一次失败的解析阻塞整次 env 写入。
        let mut target = provider();
        target.proxy_header_override = json!("{not valid json");
        target.proxy_body_override = json!(r#"["array-not-object"]"#);
        let env = provider_env(&target);
        assert!(!env.contains_key("ANTHROPIC_CUSTOM_HEADERS"));
        assert!(!env.contains_key("ANTHROPIC_CUSTOM_BODY"));
    }

    #[test]
    fn proxy_overrides_accept_legacy_object_payload() {
        // 老 settings_json 里这两个字段是直接 Map；list_providers 解析时不能
        // 因为字段类型不匹配而让整条 supplier 解析失败，否则「获取模型列表」
        // 按钮会随整个列表一起失能。
        let mut target = provider();
        target.proxy_header_override = json!({ "X-Trace": "legacy" });
        target.proxy_body_override = json!({ "temperature": 0.2 });
        let env = provider_env(&target);
        assert_eq!(env["ANTHROPIC_CUSTOM_HEADERS"], json!({ "X-Trace": "legacy" }));
        assert_eq!(env["ANTHROPIC_CUSTOM_BODY"], json!({ "temperature": 0.2 }));
    }

    #[test]
    fn empty_optional_env_keys_are_skipped() {
        let target = provider();
        let env = provider_env(&target);
        assert!(!env.contains_key("ANTHROPIC_CUSTOM_USER_AGENT"));
        assert!(!env.contains_key("ANTHROPIC_CUSTOM_HEADERS"));
        assert!(!env.contains_key("ANTHROPIC_CUSTOM_BODY"));
        assert!(!env.contains_key("ANTHROPIC_DEFAULT_FALLBACK_MODEL"));
    }
}
