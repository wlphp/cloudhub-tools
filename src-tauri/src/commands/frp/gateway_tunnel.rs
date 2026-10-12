use super::*;
use crate::commands::codex_runtime::CodexRuntimeStore;
use tauri::Manager;

// Reserved process key: database FRP connection IDs are positive.
const INSTANCE: i64 = -1;
pub(crate) static WRITER: Mutex<()> = Mutex::new(());
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

fn public_error(message: &str) -> String {
    match message {
        "请选择 frps 连接"
        | "frps 连接已不存在"
        | "请先配置 frps 连接 Token"
        | "公网域名或 HTTPS 端口无效"
        | "公网域名或端口无效"
        | "TCP 公网地址或远端端口无效"
        | "TLS 服务端名称无效"
        | "证书文件不存在或超过大小限制"
        | "证书文件超过大小限制"
        | "读取证书文件失败"
        | "证书与私钥不匹配或内容无效"
        | "请选择 HTTPS 证书和私钥文件"
        | "HTTPS 证书未生效或已过期"
        | "HTTPS 证书未覆盖公网域名"
        | "请在内网穿透模块安装 frpc"
        | "穿透配置未通过 frpc 校验"
        | "验证穿透配置超时或失败"
        | "验证穿透配置失败"
        | "启动穿透失败"
        | "保存穿透运行配置失败"
        | "设置穿透目录权限失败" => message.to_string(),
        _ => "穿透操作失败，请检查连接配置与本机日志".into(),
    }
}

#[derive(Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TunnelMode {
    #[default]
    Https,
    Http,
    Tcp,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub(crate) struct TunnelConfig {
    pub enabled: bool,
    pub mode: TunnelMode,
    pub server_id: Option<i64>,
    pub domain: String,
    pub public_port: u16,
    pub certificate_path: String,
    pub private_key_path: String,
    pub trusted_ca_path: String,
    pub tls_server_name: String,
    pub rule_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TunnelState {
    config: TunnelConfig,
    installed: bool,
    running: bool,
    connected: bool,
    local_port: Option<u16>,
    public_url: Option<String>,
    error: Option<String>,
    logs: Vec<String>,
}

pub(super) fn load() -> Result<TunnelConfig, String> {
    let json: Option<String> = open_db()?
        .query_row(
            "SELECT json FROM codex_gateway_tunnel WHERE id=1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "读取网关穿透配置失败")?;
    json.map(|json| serde_json::from_str(&json).map_err(|_| "网关穿透配置无效".into()))
        .unwrap_or_else(|| {
            Ok(TunnelConfig {
                public_port: 443,
                ..Default::default()
            })
        })
}
fn local_port(app: &tauri::AppHandle) -> Result<Option<u16>, String> {
    let runtime = app.state::<CodexRuntimeStore>();
    if runtime.closing.load(std::sync::atomic::Ordering::SeqCst) {
        return Ok(None);
    }
    let slot = runtime.gateway.lock().map_err(|_| "网关状态不可用")?;
    slot.as_ref()
        .map(|server| {
            server.summary().and_then(|summary| {
                if summary.running {
                    server.port().map(Some)
                } else {
                    Ok(None)
                }
            })
        })
        .unwrap_or(Ok(None))
}
fn read_pem(path: &str) -> Result<zeroize::Zeroizing<String>, String> {
    if !valid_plugin_path(path)
        || !fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() <= 1048576)
    {
        return Err("证书文件不存在或超过大小限制".into());
    }
    let file = fs::File::open(path).map_err(|_| "读取证书文件失败")?;
    let mut content = zeroize::Zeroizing::new(String::new());
    file.take(1048577)
        .read_to_string(&mut content)
        .map_err(|_| "读取证书文件失败")?;
    if content.len() > 1048576 {
        return Err("证书文件超过大小限制".into());
    }
    Ok(content)
}
fn validate(config: &TunnelConfig) -> Result<(), String> {
    if config.domain.len() > 253
        || config.tls_server_name.len() > 253
        || [
            &config.certificate_path,
            &config.private_key_path,
            &config.trusted_ca_path,
        ]
        .iter()
        .any(|path| path.len() > 4096 || path.chars().any(char::is_control))
    {
        return Err("穿透配置内容过长或包含无效字符".into());
    }
    if !config.enabled {
        return Ok(());
    }
    let server = load_server(
        config
            .server_id
            .filter(|id| *id > 0)
            .ok_or("请选择 frps 连接")?,
    )?
    .ok_or("frps 连接已不存在")?;
    if server.token_ciphertext.is_none() {
        return Err("请先配置 frps 连接 Token".into());
    }
    validate_endpoint(config)?;
    if !config.tls_server_name.is_empty() && !valid_hostname(&config.tls_server_name) {
        return Err("TLS 服务端名称无效".into());
    }
    if !config.trusted_ca_path.is_empty() {
        read_pem(&config.trusted_ca_path)?;
    }
    if config.mode == TunnelMode::Https {
        if config.certificate_path.is_empty() || config.private_key_path.is_empty() {
            return Err("请选择 HTTPS 证书和私钥文件".into());
        }
        let material = crate::commands::certificate_import::parse_material(
            &read_pem(&config.certificate_path)?,
            &read_pem(&config.private_key_path)?,
        )
        .map_err(|_| "证书与私钥不匹配或内容无效")?;
        validate_certificate(&material.metadata, &config.domain, Utc::now().timestamp())?;
    }
    if config.rule_name.is_empty()
        || config.rule_name.len() > 64
        || !config
            .rule_name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    {
        return Err("托管规则名称无效".into());
    }
    Ok(())
}
fn validate_endpoint(config: &TunnelConfig) -> Result<(), String> {
    if config.mode == TunnelMode::Tcp {
        if config.public_port == 0 || (!config.domain.is_empty() && !valid_address(&config.domain))
        {
            return Err("TCP 公网地址或远端端口无效".into());
        }
    } else if config.public_port == 0 || !valid_hostname(&config.domain) {
        return Err("公网域名或端口无效".into());
    }
    Ok(())
}
fn proxy(config: &TunnelConfig, port: u16) -> FrpProxy {
    let tcp = config.mode == TunnelMode::Tcp;
    FrpProxy {
        id: None,
        server_id: INSTANCE,
        name: config.rule_name.clone(),
        kind: match config.mode {
            TunnelMode::Https => "https",
            TunnelMode::Http => "http",
            TunnelMode::Tcp => "tcp",
        }
        .into(),
        local_ip: "127.0.0.1".into(),
        local_port: port,
        remote_port: if tcp { Some(config.public_port) } else { None },
        custom_domain: None,
        custom_domains: if tcp {
            vec![]
        } else {
            vec![config.domain.clone()]
        },
        enabled: true,
        plugin: if config.mode == TunnelMode::Https {
            Some(FrpHttps2HttpPlugin {
                kind: "https2http".into(),
                local_addr: format!("127.0.0.1:{port}"),
                crt_path: config.certificate_path.clone(),
                key_path: config.private_key_path.clone(),
            })
        } else {
            None
        },
    }
}
fn public_url(config: &TunnelConfig, server_address: Option<&str>) -> Option<String> {
    if !config.enabled {
        return None;
    }
    let host = if config.mode == TunnelMode::Tcp && config.domain.is_empty() {
        server_address?
    } else {
        &config.domain
    };
    if host.is_empty() {
        return None;
    }
    let host = if host.parse::<std::net::Ipv6Addr>().is_ok() {
        format!("[{host}]")
    } else {
        host.into()
    };
    let https = config.mode == TunnelMode::Https;
    let default_port = if https { 443 } else { 80 };
    Some(format!(
        "{}://{}{}/v1",
        if https { "https" } else { "http" },
        host,
        if config.public_port == default_port {
            String::new()
        } else {
            format!(":{}", config.public_port)
        }
    ))
}
fn validate_certificate(
    metadata: &crate::commands::certificate_import::ImportCandidate,
    domain: &str,
    now: i64,
) -> Result<(), String> {
    if metadata.not_before > now || metadata.not_after <= now {
        return Err("HTTPS 证书未生效或已过期".into());
    }
    let domain = domain.to_ascii_lowercase();
    if !metadata.domains.iter().any(|name| {
        name.eq_ignore_ascii_case(&domain)
            || name.strip_prefix("*.").is_some_and(|suffix| {
                domain
                    .split_once('.')
                    .is_some_and(|(_, parent)| parent.eq_ignore_ascii_case(suffix))
            })
    }) {
        return Err("HTTPS 证书未覆盖公网域名".into());
    }
    Ok(())
}
fn state(app: &tauri::AppHandle) -> Result<TunnelState, String> {
    let config = load()?;
    let store = app.state::<FrpProcessStore>();
    let installed = binary_path()?.is_file();
    let running = is_running(&store, INSTANCE)?;
    let connected = running
        && proxy_statuses(&binary_path()?, &config_path(INSTANCE)?)
            .iter()
            .any(|proxy| proxy.name == config.rule_name && proxy.status == "running");
    let logs = store
        .1
        .lock()
        .map_err(|_| "穿透日志不可用")?
        .get(&INSTANCE)
        .and_then(|buffer| {
            buffer
                .lock()
                .ok()
                .map(|lines| lines.iter().cloned().collect())
        })
        .unwrap_or_default();
    let server = config.server_id.map(load_server).transpose()?.flatten();
    let public_url = public_url(
        &config,
        server.as_ref().map(|server| server.server_addr.as_str()),
    );
    Ok(TunnelState {
        config,
        installed,
        running,
        connected,
        local_port: local_port(app)?,
        public_url,
        error: LAST_ERROR.lock().map_err(|_| "穿透状态不可用")?.clone(),
        logs,
    })
}
pub(crate) fn pause(app: &tauri::AppHandle) -> Result<(), String> {
    stop_process(&app.state::<FrpProcessStore>(), INSTANCE)?;
    let _ = fs::remove_file(config_path(INSTANCE)?);
    Ok(())
}
pub(crate) fn reconcile(app: &tauri::AppHandle) {
    let result = (|| -> Result<(), String> {
        pause(app)?;
        let config = load()?;
        if !config.enabled {
            return Ok(());
        }
        let Some(port) = local_port(app)? else {
            return Ok(());
        };
        validate(&config)?;
        let mut server =
            load_server(config.server_id.ok_or("请选择 frps 连接")?)?.ok_or("frps 连接已不存在")?;
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|_| "无法分配穿透管理端口")?;
        server.admin_port = listener
            .local_addr()
            .map_err(|_| "无法读取穿透管理端口")?
            .port();
        server.proxies = vec![proxy(&config, port)];
        let global = SavedGlobalSettings {
            admin_user: "cloudhub-api".into(),
            admin_password_ciphertext: encrypt_secret(&uuid::Uuid::new_v4().to_string())?,
        };
        let mut content = zeroize::Zeroizing::new(render_config(&server, &global)?);
        if !config.trusted_ca_path.is_empty() {
            *content = content.replacen(
                "transport.tls.enable = true\n",
                &format!(
                    "transport.tls.enable = true\ntransport.tls.trustedCaFile = {}\n",
                    toml_string(&config.trusted_ca_path)?
                ),
                1,
            );
        }
        if !config.tls_server_name.is_empty() {
            *content = content.replacen(
                "transport.tls.enable = true\n",
                &format!(
                    "transport.tls.enable = true\ntransport.tls.serverName = {}\n",
                    toml_string(&config.tls_server_name)?
                ),
                1,
            );
        }
        let path = config_path(INSTANCE)?;
        crate::core::codex::profile::private_permissions(
            path.parent().ok_or("穿透目录无效")?,
            true,
        )
        .map_err(|_| "设置穿透目录权限失败")?;
        crate::core::codex::profile::write_private(&path, &content)
            .map_err(|_| "保存穿透运行配置失败")?;
        let binary = binary_path()?;
        if !binary.is_file() {
            return Err("请在内网穿透模块安装 frpc".into());
        }
        let mut check = hidden_command(&binary)
            .arg("verify")
            .arg("-c")
            .arg(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "验证穿透配置失败")?;
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match check.try_wait() {
                Ok(Some(status)) if status.success() => break,
                Ok(Some(_)) => return Err("穿透配置未通过 frpc 校验".into()),
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50))
                }
                _ => {
                    let _ = check.kill();
                    let _ = check.wait();
                    return Err("验证穿透配置超时或失败".into());
                }
            }
        }
        let secrets = Arc::new(frp_log_secrets(&path, &server)?);
        let buffer = Arc::new(Mutex::new(VecDeque::new()));
        drop(listener);
        let store = app.state::<FrpProcessStore>();
        let mut processes = store.0.lock().map_err(|_| "穿透进程不可用")?;
        let mut child = hidden_command(binary)
            .arg("-c")
            .arg(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| "启动穿透失败")?;
        if let Some(stdout) = child.stdout.take() {
            read_frp_output(stdout, buffer.clone(), "输出", secrets.clone());
        }
        if let Some(stderr) = child.stderr.take() {
            read_frp_output(stderr, buffer.clone(), "错误", secrets);
        }
        store
            .1
            .lock()
            .map_err(|_| "穿透日志不可用")?
            .insert(INSTANCE, buffer);
        processes.insert(INSTANCE, child);
        Ok(())
    })();
    if result.is_err() {
        let _ = pause(app);
    }
    if let Ok(mut error) = LAST_ERROR.lock() {
        *error = result.err().map(|message| public_error(&message));
    }
}

#[tauri::command]
pub(crate) async fn codex_tunnel_state(app: tauri::AppHandle) -> PlatformResult<TunnelState> {
    tauri::async_runtime::spawn_blocking(move || {
        let _writer = WRITER.lock().map_err(|_| "穿透状态不可用")?;
        state(&app)
    })
    .await
    .map_err(|_| "读取穿透状态失败")?
    .map_err(|message| crate::core::error::PlatformError {
        kind: "platform-error",
        code: "certificate",
        message: public_error(&message),
        retryable: false,
    })
}
#[tauri::command]
pub(crate) async fn codex_tunnel_save(
    app: tauri::AppHandle,
    mut config: TunnelConfig,
) -> PlatformResult<TunnelState> {
    tauri::async_runtime::spawn_blocking(move || {
        let _writer = WRITER.lock().map_err(|_| "穿透配置不可用")?;
        config.rule_name = load()?.rule_name;
        if config.rule_name.is_empty() { config.rule_name = format!("cloudhub-api-{}", uuid::Uuid::new_v4().simple()); }
        validate(&config)?;
        open_db()?.execute("INSERT INTO codex_gateway_tunnel(id,json) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET json=excluded.json", [serde_json::to_string(&config).map_err(|_| "穿透配置无效")?]).map_err(|_| "保存穿透配置失败")?;
        reconcile(&app);
        state(&app)
    }).await.map_err(|_| "保存穿透任务失败")?.map_err(|message| crate::core::error::PlatformError { kind: "platform-error", code: "certificate", message: public_error(&message), retryable: false })
}
#[tauri::command]
pub(crate) async fn codex_tunnel_retry(app: tauri::AppHandle) -> PlatformResult<TunnelState> {
    tauri::async_runtime::spawn_blocking(move || {
        let _writer = WRITER.lock().map_err(|_| "穿透配置不可用")?;
        reconcile(&app);
        state(&app)
    })
    .await
    .map_err(|_| "重试穿透任务失败")?
    .map_err(|message| crate::core::error::PlatformError {
        kind: "platform-error",
        code: "certificate",
        message: public_error(&message),
        retryable: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn modes_render_correct_routes_and_public_addresses() {
        let mut config = TunnelConfig {
            enabled: true,
            mode: TunnelMode::Http,
            domain: "api.example.test".into(),
            public_port: 8080,
            rule_name: "fixture-api".into(),
            ..Default::default()
        };
        assert!(validate_endpoint(&config).is_ok());
        let http = render_proxy_config(&proxy(&config, 58169)).unwrap();
        assert!(http.contains("type = \"http\""));
        assert!(http.contains("customDomains = [\"api.example.test\"]"));
        assert!(!http.contains("plugin"));
        assert!(!http.contains("remotePort"));
        assert_eq!(
            public_url(&config, None).as_deref(),
            Some("http://api.example.test:8080/v1")
        );
        config.mode = TunnelMode::Tcp;
        config.domain.clear();
        config.public_port = 6000;
        assert!(validate_endpoint(&config).is_ok());
        let tcp = render_proxy_config(&proxy(&config, 58170)).unwrap();
        assert!(tcp.contains("type = \"tcp\""));
        assert!(tcp.contains("remotePort = 6000"));
        assert!(tcp.contains("localPort = 58170"));
        assert!(!tcp.contains("customDomains"));
        assert!(!tcp.contains("plugin"));
        assert_eq!(
            public_url(&config, Some("2001:db8::1")).as_deref(),
            Some("http://[2001:db8::1]:6000/v1")
        );
        config.mode = TunnelMode::Https;
        config.domain = "api.example.test".into();
        config.public_port = 443;
        assert_eq!(
            public_url(&config, None).as_deref(),
            Some("https://api.example.test/v1")
        );
        assert!(proxy(&config, 58171).plugin.is_some());
        config.mode = TunnelMode::Http;
        config.domain.clear();
        assert!(validate_endpoint(&config).is_err());
        config.mode = TunnelMode::Tcp;
        config.public_port = 0;
        assert!(validate_endpoint(&config).is_err());
        config.public_port = 6000;
        config.domain = "http://invalid.test".into();
        assert!(validate_endpoint(&config).is_err());
    }
    #[test]
    fn disabled_defaults_require_no_connection_or_certificate() {
        let config: TunnelConfig = serde_json::from_str("{}").unwrap();
        assert!(!config.enabled);
        assert!(config.mode == TunnelMode::Https);
        assert!(validate(&config).is_ok());
        assert!(serde_json::from_str::<TunnelConfig>("{\"token\":\"fixture\"}").is_err());
        assert!(INSTANCE < 0);
    }
    #[test]
    fn certificate_validity_and_single_level_wildcards() {
        let pair = rcgen::generate_simple_self_signed(vec!["*.example.test".into()]).unwrap();
        let mut material = crate::commands::certificate_import::parse_material(
            &pair.cert.pem(),
            &pair.key_pair.serialize_pem(),
        )
        .unwrap();
        material.metadata.not_before = 100;
        material.metadata.not_after = 200;
        assert!(validate_certificate(&material.metadata, "API.EXAMPLE.TEST", 150).is_ok());
        assert!(validate_certificate(&material.metadata, "example.test", 150).is_err());
        assert!(validate_certificate(&material.metadata, "nested.api.example.test", 150).is_err());
        assert!(validate_certificate(&material.metadata, "api.example.test", 200).is_err());
        assert!(validate_certificate(&material.metadata, "api.example.test", 99).is_err());
    }
}
