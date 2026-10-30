//! WebDAV (RFC 4918) and S3 Signature V4 transports. Never follow credential redirects.
use super::Config;
use chrono::Utc;
use hmac::{Hmac, Mac};
use reqwest::{Client, Method, Response, StatusCode, Url};
use sha2::{Digest, Sha256};
use std::time::Duration;
use zeroize::Zeroizing;
use std::{
    pin::Pin,
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, ReadBuf};
use tokio_util::io::ReaderStream;

// Counts bytes consumed by the HTTP client. Server acknowledgement is a
// separate phase: consuming the last chunk does not mean upload succeeded.
struct UploadReader {
    inner: std::io::Cursor<Vec<u8>>,
    total: u64,
}
impl AsyncRead for UploadReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let result = Pin::new(&mut self.inner).poll_read(cx, buf);
        let sent = self.inner.position();
        super::progress(
            if sent == self.total { "confirming" } else { "uploading" },
            sent,
            Some(self.total),
        );
        result
    }
}

pub(super) const MAX_BYTES: usize = 256 * 1024 * 1024;

pub(super) fn client() -> Result<Client, String> {
    let builder = Client::builder();
    // Honor an explicitly enabled application proxy. Inherited system proxies
    // can reject WebDAV methods even when a connection test succeeds.
    let builder = if crate::core::network::current_route().mode == "global" {
        builder
    } else {
        builder.no_proxy()
    };
    builder
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| "无法初始化云同步连接".into())
}

pub(super) fn base(config: &Config) -> Result<Url, String> {
    let url = Url::parse(&config.endpoint).map_err(|_| "请输入有效的服务地址")?;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("服务地址不能包含账号、密码、查询参数或片段".into());
    }
    if url.scheme() != "https" && !(url.scheme() == "http" && config.allow_insecure) {
        return Err("请使用 HTTPS；内网 HTTP 服务需明确勾选允许 HTTP".into());
    }
    Ok(url)
}

pub(super) fn url(config: &Config, artifact: bool) -> Result<Url, String> {
    let mut url = base(config)?;
    if config.method == "s3" && !config.path_style {
        let host = format!(
            "{}.{}",
            config.bucket,
            url.host_str().ok_or("服务地址无效")?
        );
        url.set_host(Some(&host)).map_err(|_| "S3 地址无效")?;
    }
    {
        let mut path = url.path_segments_mut().map_err(|_| "服务地址无效")?;
        path.pop_if_empty();
        if config.method == "s3" && config.path_style {
            path.push(&config.bucket);
        }
        if artifact {
            for segment in config.remote_root.split('/') {
                path.push(segment);
            }
            path.push("v1").push(&config.profile).push("database.chdb");
        }
    }
    Ok(url)
}

pub(super) fn named_url(config: &Config, name: &str) -> Result<Url, String> {
    let mut target = url(config, true)?;
    target.path_segments_mut().map_err(|_| "服务地址无效")?.pop().push(name);
    Ok(target)
}

fn hmac(key: &[u8], value: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).map_err(|_| "云同步签名失败")?;
    mac.update(value.as_bytes());
    Ok(Zeroizing::new(mac.finalize().into_bytes().to_vec()))
}

fn canonical_uri(url: &Url) -> String {
    url.path()
        .split('/')
        .map(|segment| {
            percent_encoding::percent_decode_str(segment)
                .map(|byte| {
                    if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
                        (byte as char).to_string()
                    } else {
                        format!("%{byte:02X}")
                    }
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn signature(
    config: &Config,
    method: &Method,
    url: &Url,
    body: &[u8],
    time: &str,
) -> Result<(String, String), String> {
    let date = &time[..8];
    let host = match url.port() {
        Some(port) => format!("{}:{port}", url.host_str().ok_or("服务地址无效")?),
        None => url.host_str().ok_or("服务地址无效")?.to_string(),
    };
    let hash = hex::encode(Sha256::digest(body));
    let headers = format!("host:{host}\nx-amz-content-sha256:{hash}\nx-amz-date:{time}\n");
    let signed = "host;x-amz-content-sha256;x-amz-date";
    let canonical = format!(
        "{}\n{}\n\n{headers}\n{signed}\n{hash}",
        method.as_str(),
        canonical_uri(url)
    );
    let scope = format!("{date}/{}/s3/aws4_request", config.region);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{time}\n{scope}\n{}",
        hex::encode(Sha256::digest(canonical.as_bytes()))
    );
    let seed = Zeroizing::new(format!("AWS4{}", config.secret_key));
    let date_key = hmac(seed.as_bytes(), date)?;
    let region_key = hmac(&date_key, &config.region)?;
    let service_key = hmac(&region_key, "s3")?;
    let signing_key = hmac(&service_key, "aws4_request")?;
    let auth = format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed}, Signature={}",
        config.access_key_id,
        hex::encode(hmac(&signing_key, &string_to_sign)?)
    );
    Ok((auth, hash))
}

pub(super) async fn request(
    client: &Client,
    config: &Config,
    method: Method,
    url: Url,
    body: Vec<u8>,
    condition: Option<(&str, &str)>,
) -> Result<Response, String> {
    let mut request = client.request(method.clone(), url.clone());
    if config.method == "webdav" {
        request = request.basic_auth(&config.username, Some(&config.password));
    } else {
        let time = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        let (auth, hash) = signature(config, &method, &url, &body, &time)?;
        request = request
            .header("Authorization", auth)
            .header("x-amz-date", time)
            .header("x-amz-content-sha256", hash);
    }
    if let Some((name, value)) = condition {
        request = request.header(name, value);
    }
    if method.as_str() == "PROPFIND" {
        request = request.header("Depth", "0");
    }
    if method == Method::PUT {
        let total = body.len() as u64;
        if url.path().ends_with("/versions.json") {
            request = request.header("Content-Type", "application/json")
                .header("Content-Length", total).body(body);
        } else {
            super::progress("uploading", 0, Some(total));
            request = request
                .header("Content-Type", "application/octet-stream")
                .header("Content-Length", total)
                .body(reqwest::Body::wrap_stream(ReaderStream::with_capacity(
                    UploadReader {
                        inner: std::io::Cursor::new(body),
                        total,
                    },
                    64 * 1024,
                )));
        }
    }
    let diagnostic_stage = match method.as_str() {
        "MKCOL" => "创建目录",
        "PUT" if url.path().ends_with("/versions.json") => "登记版本",
        "PUT" => "上传文件",
        "GET" => "读取版本或备份",
        "PROPFIND" => "检查访问权限",
        _ => "检查备份",
    };
    request.send().await.map_err(|error| {
        // Emit only fixed classifications, never raw errors, URLs or credentials.
        let mut categories = Vec::new();
        let mut source: Option<&(dyn std::error::Error + 'static)> = Some(&error);
        while let Some(cause) = source {
            if let Some(io) = cause.downcast_ref::<std::io::Error>() {
                categories.push(format!("IO:{:?}/OS:{:?}", io.kind(), io.raw_os_error()));
            }
            let description = cause.to_string().to_ascii_lowercase();
            for (needle, label) in [
                ("connection closed before message completed", "响应未完整返回即断开"),
                ("connection reset", "连接被重置"),
                ("broken pipe", "写入连接已关闭"),
                ("unexpected eof", "响应意外结束"),
                ("invalid header", "响应头无效"),
                ("invalid http", "HTTP响应无效"),
                ("connection error", "连接错误"),
            ] {
                if description.contains(needle) && !categories.iter().any(|v| v == label) {
                    categories.push(label.to_string());
                }
            }
            source = cause.source();
        }
        if categories.is_empty() { categories.push("未分类传输错误".to_string()); }
        let detail = format!("（{}：{}）", diagnostic_stage, categories.join("，"));
        if error.is_timeout() {
            format!("云同步连接超时，请稍后重试{detail}")
        } else if error.is_connect() {
            format!("无法建立云存储连接，请检查网络、服务端口和证书{detail}")
        } else {
            format!("云存储连接在请求过程中中断{detail}")
        }
    })
}

pub(super) fn check(status: StatusCode) -> Result<(), String> {
    if status.is_success() {
        return Ok(());
    }
    Err(match status.as_u16() {
        401 | 403 => "认证失败或权限不足，请检查账号、应用密码或存储策略",
        404 => "远端目录、存储桶或备份不存在",
        409 => "远端目录冲突，请检查远程根目录",
        412 => "云端备份已发生变化，请先下载检查后再上传",
        429 => "远端请求过于频繁，请稍后重试",
        300..=399 => "服务器要求重定向，请填写最终服务地址（不会转发凭据）",
        _ => "云同步请求失败，请检查服务状态与配置",
    }
    .into())
}

pub(super) fn etag(response: &Response) -> Option<String> {
    response
        .headers()
        .get("ETag")
        .and_then(|value| value.to_str().ok())
        .filter(|value| {
            value.starts_with('"')
                && value.ends_with('"')
                && value.len() <= 256
                && !value.chars().any(char::is_control)
        })
        .map(str::to_string)
}

pub(super) async fn head(
    client: &Client,
    config: &Config,
) -> Result<(bool, Option<String>), String> {
    let response = request(
        client,
        config,
        Method::HEAD,
        url(config, true)?,
        vec![],
        None,
    )
    .await?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok((false, None));
    }
    check(response.status())?;
    Ok((true, etag(&response)))
}

pub(super) async fn ensure_directories(client: &Client, config: &Config) -> Result<(), String> {
    if config.method != "webdav" {
        return Ok(());
    }
    let mut directory = base(config)?;
    let segments = config
        .remote_root
        .split('/')
        .chain(["v1", config.profile.as_str()]);
    for segment in segments {
        directory
            .path_segments_mut()
            .map_err(|_| "服务地址无效")?
            .pop_if_empty()
            .push(segment)
            .push("");
        let response = request(
            client,
            config,
            Method::from_bytes(b"MKCOL").map_err(|_| "请求初始化失败")?,
            directory.clone(),
            vec![],
            None,
        )
        .await?;
        if response.status() != StatusCode::METHOD_NOT_ALLOWED {
            check(response.status())?;
        }
    }
    Ok(())
}

pub(super) async fn read(mut response: Response) -> Result<Vec<u8>, String> {
    check(response.status())?;
    let total = response.content_length();
    super::progress("downloading", 0, total);
    if response
        .content_length()
        .is_some_and(|size| size > MAX_BYTES as u64)
    {
        return Err("云端备份超过 256 MB 限制".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取云端备份失败")? {
        if bytes.len().saturating_add(chunk.len()) > MAX_BYTES {
            return Err("云端备份超过 256 MB 限制".into());
        }
        bytes.extend_from_slice(&chunk);
        super::progress("downloading", bytes.len() as u64, total);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn s3_signature_matches_independent_sha256_hmac_fixture() {
        assert_eq!(
            canonical_uri(&Url::parse("https://storage.example/a!+@/%2f/%e4%b8%ad").unwrap()),
            "/a%21%2B%40/%2F/%E4%B8%AD"
        );
        let mut config = Config::default();
        config.region = "test-region".into();
        config.access_key_id = "fixture-access".into();
        config.secret_key = "fixture-signing".into();
        let url =
            Url::parse("https://storage.example:9443/bucket/folder%20name/database.chdb").unwrap();
        let (auth, hash) = signature(
            &config,
            &Method::PUT,
            &url,
            b"fixture-backup",
            "20261026T120000Z",
        )
        .unwrap();
        assert_eq!(hash, hex::encode(Sha256::digest(b"fixture-backup")));
        assert!(auth.ends_with(
            "Signature=c63e054765ada4c911fc1a2ec1dd5eaf79e55a3aee0d13681f942abad53044ce"
        ));
        assert!(auth.contains("Credential=fixture-access/20261026/test-region/s3/aws4_request"));
    }

    #[tokio::test]
    async fn webdav_conditional_upload_and_download_use_real_http() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut captured = Vec::new();
            for (code, body) in [
                ("201 Created", ""),
                ("200 OK", "fixture-backup"),
                ("412 Precondition Failed", ""),
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                loop {
                    let mut buffer = [0; 1024];
                    let count = stream.read(&mut buffer).unwrap();
                    if count == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..count]);
                    if let Some(end) = request.windows(4).position(|v| v == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&request[..end]).to_lowercase();
                        let length = header
                            .lines()
                            .find_map(|line| {
                                line.strip_prefix("content-length: ")
                                    .and_then(|v| v.parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                captured.push(String::from_utf8(request).unwrap());
                write!(stream, "HTTP/1.1 {code}\r\nContent-Length: {}\r\nETag: \"fixture-version\"\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
            captured
        });
        let mut config = Config::default();
        config.endpoint = endpoint;
        config.allow_insecure = true;
        config.username = "fixture".into();
        config.password = "fixture".into();
        let client = client().unwrap();
        let target = url(&config, true).unwrap();
        let response = request(
            &client,
            &config,
            Method::PUT,
            target.clone(),
            b"fixture-backup".to_vec(),
            Some(("If-None-Match", "*")),
        )
        .await
        .unwrap();
        check(response.status()).unwrap();
        assert_eq!(etag(&response).as_deref(), Some("\"fixture-version\""));
        assert_eq!(
            read(
                request(&client, &config, Method::GET, target.clone(), vec![], None)
                    .await
                    .unwrap()
            )
            .await
            .unwrap(),
            b"fixture-backup"
        );
        let response = request(
            &client,
            &config,
            Method::PUT,
            target,
            vec![],
            Some(("If-Match", "\"stale\"")),
        )
        .await
        .unwrap();
        assert!(check(response.status()).unwrap_err().contains("已发生变化"));
        let captured = server.join().unwrap();
        assert!(captured[0].to_lowercase().contains("if-none-match: *"));
        assert!(captured[0].to_lowercase().contains("authorization: basic "));
        assert!(captured[2].to_lowercase().contains("if-match: \"stale\""));
    }

    #[test]
    fn safe_errors_never_include_remote_payloads() {
        for code in [301, 401, 403, 404, 409, 412, 429, 500] {
            assert!(check(StatusCode::from_u16(code).unwrap()).is_err());
        }
        let mut config = Config::default();
        config.endpoint = "https://storage.example".into();
        config.remote_root = "folder with spaces".into();
        assert!(url(&config, true)
            .unwrap()
            .path()
            .contains("folder%20with%20spaces"));
    }
    #[test]
    fn paths_and_validation_keep_credentials_on_configured_origin() {
        let mut config = Config::default();
        config.endpoint = "https://storage.example/dav/".into();
        assert_eq!(
            url(&config, true).unwrap().as_str(),
            "https://storage.example/dav/cloudhub-sync/v1/default/database.chdb"
        );
        config.method = "s3".into();
        config.bucket = "fixture-bucket".into();
        assert_eq!(
            url(&config, true).unwrap().as_str(),
            "https://storage.example/dav/fixture-bucket/cloudhub-sync/v1/default/database.chdb"
        );
        config.path_style = false;
        assert_eq!(
            url(&config, true).unwrap().host_str(),
            Some("fixture-bucket.storage.example")
        );
        for endpoint in [
            "https://fixture:fixture@storage.example/",
            "file:///tmp",
            "https://storage.example/?token=fixture",
            "http://storage.example/",
        ] {
            config.endpoint = endpoint.into();
            assert!(base(&config).is_err());
        }
    }
}
