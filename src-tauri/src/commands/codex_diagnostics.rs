//! Codex 连接诊断：读取当前生效的 config.toml / 模型目录，并对实际请求目标做
//! 本机探测，返回可实时采集的网络事实。
//!
//! 只做只读采集：不写配置、不刷新凭据、不发起模型请求。所有返回字段经过
//! 白名单筛选或 URL 脱敏，凭据（bearer token、请求头、auth.json）一律不读。

use crate::core::{codex::profile, error::PlatformResult};
use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    io::Read,
    net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use toml_edit::{Document, Item};

/// config.toml 与模型目录都按 2MB 上限读取，与 profile 的认证文件限制一致。
const FILE_LIMIT: u64 = 2 * 1024 * 1024;
/// 单次采集最多探测的地址数量，避免用户配置大量供应商时拖慢采集。
const MAX_ROUTES: usize = 8;
/// 每个模型来源最多展示的条目。
const MAX_MODELS: usize = 300;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticsReport {
    home: String,
    config_path: String,
    config_exists: bool,
    config_modified: Option<i64>,
    collected_at: i64,
    duration_ms: u64,
    settings: Vec<SettingRow>,
    routes: Vec<DiagnosticRoute>,
    model_sources: Vec<ModelSource>,
    network: NetworkFacts,
    warnings: Vec<String>,
    current_model: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingRow {
    key: String,
    value: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticRoute {
    key: String,
    label: String,
    url: String,
    note: Option<String>,
    effective: bool,
    host: Option<String>,
    port: Option<u16>,
    kind: String,
    status: String,
    latency_ms: Option<u64>,
    resolved: Vec<String>,
    listener_process: Option<String>,
    listener_pid: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelSource {
    name: String,
    path: String,
    exists: bool,
    count: usize,
    fetched_at: Option<String>,
    client_version: Option<String>,
    etag: Option<String>,
    models: Vec<ModelEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelEntry {
    id: String,
    name: Option<String>,
    context_window: Option<u64>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct NetworkFacts {
    available: bool,
    error: Option<String>,
    adapters: Vec<AdapterFact>,
    default_adapter: Option<String>,
    system_proxy_enabled: bool,
    system_proxy_server: Option<String>,
    env_proxies: Vec<EnvProxy>,
    hosts: Vec<HostEntry>,
    processes: Vec<ProcessFact>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdapterFact {
    name: String,
    description: String,
    ip: Option<String>,
    gateway: Option<String>,
    metric: Option<i64>,
    kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvProxy {
    name: String,
    value: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostEntry {
    host: String,
    ip: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessFact {
    pid: u32,
    name: String,
    count: u32,
}

struct RouteSpec {
    key: String,
    label: String,
    url: String,
    note: Option<String>,
    effective: bool,
}

/// 单个地址的 TCP 探测超时。弹层每 5 秒采集一次，候选项较多时也不能堆积。
const PROBE_TIMEOUT: Duration = Duration::from_millis(700);

#[tauri::command]
pub(crate) async fn codex_diagnostics() -> PlatformResult<DiagnosticsReport> {
    tauri::async_runtime::spawn_blocking(collect)
        .await
        .map_err(|_| "Codex 诊断任务失败")?
        .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn claude_connection_diagnostics() -> PlatformResult<DiagnosticsReport> {
    tauri::async_runtime::spawn_blocking(collect_claude)
        .await
        .map_err(|_| "Claude 诊断任务失败")?
        .map_err(Into::into)
}

fn collect_claude() -> Result<DiagnosticsReport, String> {
    use crate::core::repositories::claude_providers as repository;

    let started = Instant::now();
    let config_path = repository::settings_path()?;
    let document = repository::read_settings_at(&config_path)?;
    let read_env = |key: &str| {
        document["env"][key].as_str().map(str::trim).filter(|value| !value.is_empty())
    };
    let configured_url = read_env("ANTHROPIC_BASE_URL");
    let address_origin = |value: &str| parse_url(value).map(|url| url.origin().ascii_serialization());
    let mut warnings = Vec::new();
    let mut routes = Vec::new();
    let origin = configured_url.and_then(address_origin);
    let local_ports = origin.iter().filter_map(|value| {
        let url = parse_url(value)?;
        is_loopback_host(url.host_str()?).then(|| url.port_or_known_default()).flatten()
    }).collect::<Vec<_>>();
    let facts = probe_host(&local_ports);
    if let Some(url) = origin.clone() {
        routes.push(probe_route(RouteSpec {
            key: "ANTHROPIC_BASE_URL".into(),
            label: "Claude Code 配置目标".into(),
            url,
            note: None,
            effective: true,
        }, &facts));
    } else if configured_url.is_some() {
        warnings.push("ANTHROPIC_BASE_URL 不是有效的 HTTP(S) 地址。".into());
    } else {
        warnings.push("当前文件未设置 ANTHROPIC_BASE_URL。请求目标由 Claude Code 的其他配置或默认服务决定。".into());
    }

    let model_keys = [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_FABLE_MODEL",
        "ANTHROPIC_DEFAULT_FALLBACK_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
    ];
    let safe_model = |value: &str| {
        let value = value.trim();
        (!value.is_empty() && value.len() <= 160 &&
            value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"-_./:@[]".contains(&byte)))
            .then(|| value.to_owned())
    };
    let current_model = read_env("ANTHROPIC_MODEL")
        .or_else(|| document["model"].as_str())
        .and_then(safe_model);
    let mut settings = vec![
        SettingRow { key: "ANTHROPIC_BASE_URL".into(), value: origin },
        SettingRow { key: "model".into(), value: document["model"].as_str().and_then(safe_model) },
    ];
    settings.extend(model_keys.into_iter().map(|key| SettingRow {
        key: key.into(),
        value: read_env(key).and_then(safe_model),
    }));
    let config_metadata = fs::metadata(&config_path).ok();
    let config_modified = config_metadata.as_ref()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64);

    Ok(DiagnosticsReport {
        home: String::new(),
        config_path: config_path.to_string_lossy().into_owned(),
        config_exists: config_metadata.is_some_and(|meta| meta.is_file()),
        config_modified,
        collected_at: chrono::Utc::now().timestamp(),
        duration_ms: started.elapsed().as_millis() as u64,
        settings,
        routes,
        model_sources: Vec::new(),
        network: facts.network,
        warnings,
        current_model,
    })
}

fn collect() -> Result<DiagnosticsReport, String> {
    let started = Instant::now();
    let home = profile::default_home()?;
    let config_path = home.join("config.toml");
    let config_exists = fs::symlink_metadata(&config_path).is_ok_and(|meta| meta.is_file());
    let config_modified = fs::metadata(&config_path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64);
    let text = read_bounded(&config_path).unwrap_or_default();
    let document = text.parse::<Document>().ok();
    let read_key = |key: &str| {
        document
            .as_ref()
            .and_then(|document| document.get(key))
            .and_then(Item::as_str)
            .map(str::to_owned)
    };

    let current_model = read_key("model");
    let settings = [
        "model",
        "model_provider",
        "openai_base_url",
        "chatgpt_base_url",
        "model_catalog_json",
        "model_reasoning_effort",
        "service_tier",
        "cli_auth_credentials_store",
    ]
    .into_iter()
    .map(|key| SettingRow { key: key.to_owned(), value: read_key(key) })
    .collect::<Vec<_>>();

    let specs = route_specs(&document);
    let local_ports = specs
        .iter()
        .filter_map(|spec| parse_url(&spec.url).filter(|url| is_loopback_host(url.host_str().unwrap_or_default())).and_then(|url| url.port_or_known_default()))
        .collect::<Vec<u16>>();
    let facts = probe_host(&local_ports);
    let routes = specs
        .into_iter()
        .take(MAX_ROUTES)
        .map(|spec| probe_route(spec, &facts))
        .collect::<Vec<_>>();
    let model_sources = model_sources(&home, read_key("model_catalog_json"));
    let mut warnings = Vec::new();
    if let Some(url) = read_key("openai_base_url") {
        warnings.push(format!(
            "config.toml 设置了 openai_base_url = {url}：官方客户端的内置接口被重定向，切换账号不会改变实际请求出口"
        ));
        if let Some(route) = routes.iter().find(|route| route.key == "openai_base_url") {
            if route.kind == "loopback" && route.status == "refused" {
                warnings.push("重定向目标是本机地址但没有进程监听：客户端会报“由于目标计算机积极拒绝，无法连接 (os error 10061)”".into());
            }
            if route.kind == "loopback" && route.status == "listening" {
                if let Some(process) = &route.listener_process {
                    warnings.push(format!("重定向目标由本机 {process} 接管（默认实例的登录凭据不会直接发往官方接口）"));
                }
            }
        }
    }
    if let Some(provider) = read_key("model_provider").filter(|value| value != "openai") {
        warnings.push(format!("model_provider = {provider}：请求走第三方供应商地址，不是官方直连"));
    }
    if read_key("model_catalog_json").is_some() {
        warnings.push("model_catalog_json 已生效：模型选择器展示的是该目录文件，而不是官方目录".into());
    }
    if let Some(cache) = model_sources.iter().find(|source| source.name.contains("客户端模型缓存")) {
        if cache.etag.as_deref().is_some_and(|tag| tag.to_ascii_lowercase().contains("magpie")) {
            warnings.push("客户端模型缓存 etag 带有 magpie 标记：模型目录由 magpie 下发".into());
        }
    }
    if read_key("openai_base_url").is_some() && facts.network.processes.iter().any(|process| process.name.eq_ignore_ascii_case("magpie")) {
        warnings.push("magpie 正在运行：它会在启动时重写 config.toml 的接管项，重启客户端后可能再次被接管".into());
    }

    Ok(DiagnosticsReport {
        home: home.to_string_lossy().into_owned(),
        config_path: config_path.to_string_lossy().into_owned(),
        config_exists,
        config_modified,
        collected_at: chrono::Utc::now().timestamp(),
        duration_ms: started.elapsed().as_millis() as u64,
        settings,
        routes,
        model_sources,
        network: facts.network,
        warnings,
        current_model,
    })
}

fn route_specs(document: &Option<Document>) -> Vec<RouteSpec> {
    let provider = document
        .as_ref()
        .and_then(|document| document.get("model_provider"))
        .and_then(Item::as_str)
        .map(str::to_owned);
    let provider_foreign = provider.as_deref().is_some_and(|value| value != "openai");
    let openai_base = document
        .as_ref()
        .and_then(|document| document.get("openai_base_url"))
        .and_then(Item::as_str)
        .map(str::to_owned);
    let chatgpt_base = document
        .as_ref()
        .and_then(|document| document.get("chatgpt_base_url"))
        .and_then(Item::as_str)
        .map(str::to_owned);
    let mut routes = Vec::new();
    if provider_foreign {
        if let Some(name) = &provider {
            let base = provider_base(document, name);
            routes.push(RouteSpec {
                key: "model_provider".into(),
                label: format!("供应商 {name}（model_provider）"),
                url: base.clone().unwrap_or_default(),
                note: base.is_none().then(|| "配置缺少 base_url，客户端会退回官方地址".into()),
                effective: true,
            });
        }
    }
    if let Some(url) = openai_base {
        routes.push(RouteSpec {
            key: "openai_base_url".into(),
            label: "内置 OpenAI 接口（openai_base_url）".into(),
            url,
            note: Some("官方客户端优先使用该地址；model_provider = openai 时同样生效".into()),
            effective: !provider_foreign,
        });
    }
    if let Some(url) = chatgpt_base {
        routes.push(RouteSpec {
            key: "chatgpt_base_url".into(),
            label: "ChatGPT 后端接口（chatgpt_base_url）".into(),
            url,
            note: Some("登录、刷新和额度相关请求使用该地址".into()),
            effective: true,
        });
    }
    if !provider_foreign {
        // 只有 openai_base_url 会覆盖模型请求出口；chatgpt_base_url 只影响登录与额度。
        let redirected = routes.iter().any(|route| route.key == "openai_base_url");
        routes.push(RouteSpec {
            key: "official".into(),
            label: "官方 OpenAI 接口（默认）".into(),
            url: "https://api.openai.com/v1".into(),
            note: redirected.then(|| "已被 openai_base_url 覆盖，客户端不会使用该地址".to_string()),
            effective: !redirected,
        });
    }
    routes
}

fn provider_base(document: &Option<Document>, name: &str) -> Option<String> {
    document
        .as_ref()?
        .get("model_providers")?
        .as_table_like()?
        .get(name)?
        .as_table_like()?
        .get("base_url")?
        .as_str()
        .map(str::to_owned)
}

fn probe_route(spec: RouteSpec, facts: &HostFacts) -> DiagnosticRoute {
    let mut route = DiagnosticRoute {
        key: spec.key,
        label: spec.label,
        url: sanitize_url(&spec.url),
        note: spec.note,
        effective: spec.effective,
        host: None,
        port: None,
        kind: "unknown".into(),
        status: "missing".into(),
        latency_ms: None,
        resolved: Vec::new(),
        listener_process: None,
        listener_pid: None,
    };
    if spec.url.trim().is_empty() {
        return route;
    }
    let Some(url) = parse_url(&spec.url) else {
        route.status = "invalid".into();
        return route;
    };
    let host = url.host_str().unwrap_or_default().to_owned();
    let port = url.port_or_known_default();
    route.host = Some(host.clone());
    route.port = port;
    let loopback = is_loopback_host(&host);
    route.kind = if loopback {
        "loopback".into()
    } else if host.parse::<IpAddr>().is_ok_and(is_private_ip) {
        "lan".into()
    } else {
        "public".into()
    };
    let Some(port) = port else {
        route.status = "invalid".into();
        return route;
    };
    if let Some(listener) = facts.listeners.iter().find(|listener| listener.port == port) {
        route.listener_process = listener.process.clone();
        route.listener_pid = listener.pid;
    }
    if loopback {
        let started = Instant::now();
        match TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), PROBE_TIMEOUT) {
            Ok(stream) => {
                let _ = stream.set_nodelay(true);
                route.status = "listening".into();
                route.latency_ms = Some(started.elapsed().as_millis() as u64);
            }
            Err(_) => route.status = "refused".into(),
        }
        return route;
    }
    let resolved = resolve(&host, port);
    route.resolved = resolved.iter().map(ToString::to_string).take(4).collect();
    let started = Instant::now();
    let mut reachable = false;
    // 只探测前 2 个地址并共用超时预算，避免慢解析拖住整个弹层。
    let deadline = Instant::now() + PROBE_TIMEOUT;
    for address in resolved.iter().take(2) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        if TcpStream::connect_timeout(address, remaining).is_ok() {
            reachable = true;
            break;
        }
    }
    route.status = if reachable { "reachable".into() } else { "unreachable".into() };
    if reachable {
        route.latency_ms = Some(started.elapsed().as_millis() as u64);
    }
    route
}

/// 单次采集的解析超时。域名解析走阻塞系统调用，在 TUN/代理环境下可能长时间不返回，
/// 因此放到独立线程并用通道限时，超时就按“未解析”处理而不是拖住整个弹层。
fn resolve(host: &str, port: u16) -> Vec<SocketAddr> {
    let host = host.to_owned();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let addresses = (host.as_str(), port)
            .to_socket_addrs()
            .map(|addresses| addresses.take(6).collect::<Vec<_>>())
            .unwrap_or_default();
        let _ = sender.send(addresses);
    });
    receiver.recv_timeout(Duration::from_millis(1500)).unwrap_or_default()
}

fn parse_url(value: &str) -> Option<reqwest::Url> {
    let url = reqwest::Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }
    Some(url)
}

/// 展示用 URL：去掉账号、查询参数与片段，避免把密钥带进界面或复制内容。
fn sanitize_url(value: &str) -> String {
    let Some(mut url) = parse_url(value) else {
        return value.chars().filter(|c| !c.is_control()).take(2048).collect();
    };
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.set_fragment(None);
    url.to_string()
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']);
    host.eq_ignore_ascii_case("localhost")
        || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
        || host == "0.0.0.0"
}

fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_private() || ip.is_link_local(),
        IpAddr::V6(ip) => ip.is_unique_local() || ip.is_unicast_link_local(),
    }
}

fn read_bounded(path: &Path) -> Option<String> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > FILE_LIMIT {
        return None;
    }
    let mut text = String::new();
    fs::File::open(path).ok()?.take(FILE_LIMIT + 1).read_to_string(&mut text).ok()?;
    (text.len() as u64 <= FILE_LIMIT).then_some(text)
}

fn model_sources(home: &Path, configured: Option<String>) -> Vec<ModelSource> {
    let mut sources = Vec::new();
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut push = |name: &str, path: PathBuf| {
        if seen.iter().any(|item| item == &path) {
            return;
        }
        seen.push(path.clone());
        sources.push(read_model_source(name, &path));
    };
    push("CloudHub 生成的模型目录", home.join("cloudhub-model-catalog.json"));
    push("Codex 客户端模型缓存", home.join("models_cache.json"));
    if let Some(value) = configured {
        let path = if Path::new(&value).is_absolute() { PathBuf::from(&value) } else { home.join(&value) };
        push("config.toml 指定的模型目录", path);
    }
    sources
}

fn read_model_source(name: &str, path: &Path) -> ModelSource {
    let mut source = ModelSource {
        name: name.into(),
        path: path.to_string_lossy().into_owned(),
        exists: fs::metadata(path).is_ok_and(|meta| meta.is_file()),
        count: 0,
        fetched_at: None,
        client_version: None,
        etag: None,
        models: Vec::new(),
    };
    let Some(text) = read_bounded(path) else { return source };
    let Ok(value) = serde_json::from_str::<Value>(&text) else { return source };
    source.fetched_at = value
        .get("fetched_at")
        .and_then(Value::as_str)
        .filter(|text| text.len() <= 64 && !text.chars().any(char::is_control))
        .map(str::to_owned);
    source.client_version = value
        .get("client_version")
        .and_then(Value::as_str)
        .filter(|text| text.len() <= 64 && !text.chars().any(char::is_control))
        .map(str::to_owned);
    source.etag = value
        .get("etag")
        .and_then(Value::as_str)
        .filter(|text| text.len() <= 256 && !text.chars().any(char::is_control))
        .map(|text| text.chars().take(64).collect());
    let models = value
        .get("models")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let object = item.as_object()?;
                    let id = ["slug", "id", "model"].into_iter().find_map(|key| object.get(key).and_then(Value::as_str))?;
                    if id.is_empty() || id.len() > 200 || id.chars().any(char::is_control) {
                        return None;
                    }
                    Some(ModelEntry {
                        id: id.to_owned(),
                        name: ["display_name", "displayName", "name"]
                            .into_iter()
                            .find_map(|key| object.get(key).and_then(Value::as_str))
                            .filter(|name| name.len() <= 200 && !name.chars().any(char::is_control))
                            .map(str::to_owned),
                        context_window: ["context_window", "contextWindow", "max_context_window"]
                            .into_iter()
                            .find_map(|key| object.get(key).and_then(Value::as_u64))
                            .filter(|value| *value > 0),
                    })
                })
                .take(MAX_MODELS)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    source.count = models.len();
    source.models = models;
    source
}

struct ListenerFact {
    port: u16,
    process: Option<String>,
    pid: Option<u32>,
}

#[derive(Default)]
struct HostFacts {
    listeners: Vec<ListenerFact>,
    network: NetworkFacts,
}

#[cfg(windows)]
fn probe_host(local_ports: &[u16]) -> HostFacts {
    let mut facts = HostFacts::default();
    let ports = local_ports.iter().copied().filter(|port| *port > 0).take(32).collect::<Vec<u16>>();
    let script = format!(
        r#"$ErrorActionPreference='SilentlyContinue';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();$ports=@({});$listeners=@(Get-NetTCPConnection -State Listen | Where-Object {{ $ports -contains $_.LocalPort }} | ForEach-Object {{ $p=Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue;[pscustomobject]@{{port=[int]$_.LocalPort;address=[string]$_.LocalAddress;pid=[int]$_.OwningProcess;process=$(if($p){{$p.ProcessName}}else{{''}})}} }});$adapters=@(Get-NetAdapter -IncludeHidden | Where-Object {{ $_.Status -eq 'Up' }} | Select-Object ifIndex,Name,InterfaceDescription);$ips=@(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {{ $_.AddressState -eq 'Preferred' }} | Select-Object InterfaceIndex,IPAddress);$routes=@(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Select-Object ifIndex,NextHop,RouteMetric,InterfaceMetric);$proxy=Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings';$procs=@(Get-Process | Where-Object {{ $_.ProcessName -match 'magpie|sing-box|xray|v2ray|clash|mihomo|proxifier|verge|flclash' }} | Group-Object ProcessName | ForEach-Object {{ [pscustomobject]@{{Id=[int]$_.Group[0].Id;ProcessName=[string]$_.Name;count=[int]$_.Count}} }} | Select-Object -First 24);[pscustomobject]@{{listeners=$listeners;adapters=$adapters;ips=$ips;routes=$routes;proxy=@{{enabled=[int]$proxy.ProxyEnable;server=[string]$proxy.ProxyServer}};processes=$procs}} | ConvertTo-Json -Depth 6 -Compress"#,
        ports.iter().map(u16::to_string).collect::<Vec<_>>().join(",")
    );
    match run_powershell(&script) {
        Ok(bytes) => {
            facts.network.available = true;
            let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            for item in array_items(&value, "listeners") {
                let Some(port) = item.get("port").and_then(Value::as_u64).and_then(|port| u16::try_from(port).ok()) else { continue };
                facts.listeners.push(ListenerFact {
                    port,
                    process: item.get("process").and_then(Value::as_str).filter(|name| !name.is_empty()).map(str::to_owned),
                    pid: item.get("pid").and_then(Value::as_u64).and_then(|pid| u32::try_from(pid).ok()),
                });
            }
            for item in array_items(&value, "processes") {
                let Some(name) = item.get("ProcessName").and_then(Value::as_str) else { continue };
                let Some(pid) = item.get("Id").and_then(Value::as_u64).and_then(|pid| u32::try_from(pid).ok()) else { continue };
                let count = item.get("count").and_then(Value::as_u64).and_then(|count| u32::try_from(count).ok()).unwrap_or(1);
                facts.network.processes.push(ProcessFact { pid, name: name.chars().take(80).collect(), count });
            }
            let proxy = value.get("proxy");
            facts.network.system_proxy_enabled = proxy.and_then(|proxy| proxy.get("enabled")).and_then(Value::as_i64).is_some_and(|value| value != 0);
            facts.network.system_proxy_server = proxy
                .and_then(|proxy| proxy.get("server"))
                .and_then(Value::as_str)
                .filter(|server| !server.is_empty())
                .map(|server| server.chars().take(256).collect());
            facts.network.adapters = adapter_facts(&value);
            // 默认出口：先比接口 metric（sing-box TUN 常为 0/空），再比路由 metric。
            // 两者都空时按“已配置网关”的适配器中最靠前者兜底，避免把未知当作默认。
            facts.network.default_adapter = facts
                .network
                .adapters
                .iter()
                .filter(|adapter| adapter.metric.is_some() || adapter.gateway.is_some())
                .min_by_key(|adapter| (adapter.metric.is_none(), adapter.metric.unwrap_or(0)))
                .map(|adapter| adapter.name.clone());
        }
        Err(error) => facts.network.error = Some(error),
    }
    facts.network.env_proxies = env_proxies();
    facts.network.hosts = hosts_entries();
    facts
}

#[cfg(not(windows))]
fn probe_host(_local_ports: &[u16]) -> HostFacts {
    let facts = HostFacts {
        network: NetworkFacts {
            error: Some("当前平台不支持本机监听与网络适配器采集".into()),
            env_proxies: env_proxies(),
            ..NetworkFacts::default()
        },
        ..HostFacts::default()
    };
    facts
}

#[cfg(windows)]
fn adapter_facts(value: &Value) -> Vec<AdapterFact> {
    let adapters = array_items(value, "adapters");
    let ips = array_items(value, "ips");
    let routes = array_items(value, "routes");
    adapters
        .into_iter()
        .filter_map(|adapter| {
            let index = adapter.get("ifIndex").and_then(Value::as_i64)?;
            let name = adapter.get("Name").and_then(Value::as_str).unwrap_or("未知适配器");
            let description = adapter.get("InterfaceDescription").and_then(Value::as_str).unwrap_or("");
            let ip = ips.iter().find(|row| row.get("InterfaceIndex").and_then(Value::as_i64) == Some(index)).and_then(|row| row.get("IPAddress")).and_then(Value::as_str);
            let route = routes.iter().find(|row| row.get("ifIndex").and_then(Value::as_i64) == Some(index));
            let gateway = route.and_then(|row| row.get("NextHop")).and_then(Value::as_str).filter(|hop| !hop.is_empty());
            let metric = route.and_then(|row| row.get("RouteMetric")).and_then(Value::as_i64);
            let label = format!("{name} {description}").to_ascii_lowercase();
            let kind = if label.contains("tun") || label.contains("wintun") || label.contains("sing") {
                "tun"
            } else if label.contains("vethernet") || label.contains("wsl") {
                "wsl"
            } else if label.contains("wi-fi") || label.contains("wlan") || label.contains("wireless") {
                "wifi"
            } else {
                "ethernet"
            };
            Some(AdapterFact {
                name: name.chars().take(120).collect(),
                description: description.chars().take(160).collect(),
                ip: ip.map(|ip| ip.chars().take(64).collect()),
                gateway: gateway.map(|hop| hop.chars().take(64).collect()),
                metric,
                kind: kind.into(),
            })
        })
        .take(16)
        .collect()
}

#[cfg(not(windows))]
fn adapter_facts(_value: &Value) -> Vec<AdapterFact> {
    Vec::new()
}

fn array_items(value: &Value, key: &str) -> Vec<Value> {
    match value.get(key) {
        // ConvertTo-Json 会把单元素集合折叠成对象，这里统一还原为数组。
        Some(Value::Object(_)) => vec![value[key].clone()],
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    }
}

fn env_proxies() -> Vec<EnvProxy> {
    ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]
        .into_iter()
        .filter_map(|name| std::env::var(name).ok().filter(|value| !value.trim().is_empty()).map(|value| EnvProxy { name: name.into(), value: value.chars().take(256).collect() }))
        .collect()
}

fn hosts_entries() -> Vec<HostEntry> {
    #[cfg(windows)]
    let path = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\Windows")).join("System32\\drivers\\etc\\hosts");
    #[cfg(not(windows))]
    let path = PathBuf::from("/etc/hosts");
    let Some(text) = read_bounded(&path) else { return Vec::new() };
    let mut entries = Vec::new();
    for line in text.lines().take(2048) {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(ip) = parts.next() else { continue };
        if ip.parse::<IpAddr>().is_err() {
            continue;
        }
        for host in parts.take(4) {
            if host.len() > 160 || host.chars().any(char::is_control) {
                continue;
            }
            let default_local = host.eq_ignore_ascii_case("localhost") && (ip.starts_with("127.") || ip == "::1");
            if default_local {
                continue;
            }
            entries.push(HostEntry { host: host.to_owned(), ip: ip.to_owned() });
            if entries.len() >= 48 {
                return entries;
            }
        }
    }
    entries
}

#[cfg(windows)]
fn run_powershell(script: &str) -> Result<Vec<u8>, String> {
    use std::{os::windows::process::CommandExt, process::{Command, Stdio}};
    let mut child = Command::new("powershell.exe")
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|_| "无法启动本机网络采集")?;
    let stdout = child.stdout.take().ok_or("无法读取本机网络")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.take(512 * 1024 + 1).read_to_end(&mut bytes).map(|_| bytes)
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let bytes = reader.join().map_err(|_| "读取本机网络失败")?.map_err(|_| "读取本机网络失败")?;
    if bytes.len() > 512 * 1024 {
        return Err("本机网络信息超过限制".into());
    }
    if !status.is_some_and(|status| status.success()) {
        return Err("本机网络采集超时或被拒绝".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(text: &str) -> Option<Document> {
        text.parse::<Document>().ok()
    }

    #[test]
    fn openai_base_url_is_reported_as_effective_redirect() {
        let document = document("model_provider = \"openai\"\nopenai_base_url = \"http://127.0.0.1:3425/backend-api/codex?key=secret\"\n");
        let routes = route_specs(&document);
        let redirect = routes.iter().find(|route| route.key == "openai_base_url").unwrap();
        assert!(redirect.effective);
        let official = routes.iter().find(|route| route.key == "official").unwrap();
        assert!(!official.effective);
        // 展示与复制时不得带出查询参数里的凭据。
        assert_eq!(sanitize_url(&redirect.url), "http://127.0.0.1:3425/backend-api/codex");
    }

    #[test]
    fn provider_routes_win_over_builtin_redirect_for_effectiveness() {
        let document = document("model_provider = \"cloudhub_provider\"\n[model_providers.cloudhub_provider]\nbase_url = \"https://example.com/v1\"\n");
        let routes = route_specs(&document);
        let provider = routes.iter().find(|route| route.key == "model_provider").unwrap();
        assert_eq!(provider.url, "https://example.com/v1");
        assert!(provider.effective);
        assert!(routes.iter().all(|route| route.key != "official"));
    }

    #[test]
    fn model_sources_are_deduplicated_and_bounded() {
        let root = std::env::temp_dir().join(format!("cloudhub-diagnostics-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("cloudhub-model-catalog.json"), br#"{"models":[{"slug":"a","display_name":"A","context_window":1024},{"slug":"b"}]}"#).unwrap();
        let sources = model_sources(&root, Some("cloudhub-model-catalog.json".into()));
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].count, 2);
        assert_eq!(sources[0].models[0].id, "a");
        assert_eq!(sources[1].count, 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn loopback_and_private_addresses_are_classified() {
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("localhost"));
        assert!(is_loopback_host("[::1]"));
        assert!(is_private_ip("172.18.84.212".parse().unwrap()));
        assert!(!is_private_ip("8.8.8.8".parse().unwrap()));
    }

    /// 手动回归：`cargo test --lib -- --ignored collect_real_profile`。
    /// 只读取本机既有配置与网络事实，不修改文件、不发送请求。
    #[test]
    #[ignore = "requires a local Codex profile; reads config and network facts only"]
    fn collect_real_profile_reports_routes_without_secrets() {
        let report = collect().expect("本机应能完成诊断采集");
        assert!(!report.home.is_empty());
        assert!(report.duration_ms < 30_000, "采集应在可交互的时间内完成");
        for route in &report.routes {
            assert!(!route.url.contains('?'), "展示用 URL 必须去掉查询参数");
            assert!(!route.url.contains('@'), "展示用 URL 必须去掉凭据");
        }
        for source in &report.model_sources {
            assert!(source.count <= MAX_MODELS);
        }
    }
}
