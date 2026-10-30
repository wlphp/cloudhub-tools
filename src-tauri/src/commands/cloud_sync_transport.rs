//! WebDAV, S3 Signature V4 and native Aliyun OSS transports. Never follow credential redirects.
use super::Config;
use chrono::Utc;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use hmac::{Hmac, Mac};
use sha1::Sha1;
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
    #[cfg(desktop)]
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

// Match only official OSS regional hosts, never arbitrary lookalike suffixes.
pub(super) fn oss_endpoint(config: &Config) -> Result<bool, String> {
    let endpoint = base(config)?;
    let host = endpoint.host_str().unwrap_or_default();
    let Some(prefix) = host.strip_suffix(".aliyuncs.com") else { return Ok(false); };
    let region = prefix.rsplit('.').next().unwrap_or_default();
    Ok(["s3", "oss"].contains(&config.method.as_str()) && region.starts_with("oss-") && region.len() > 4
        && region.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))
}

pub(super) fn url(config: &Config, artifact: bool) -> Result<Url, String> {
    let mut url = base(config)?;
    let oss = oss_endpoint(config)?;
    let bucket_host = format!("{}.", config.bucket);
    let has_bucket = oss && url.host_str().is_some_and(|host| host.starts_with(&bucket_host));
    if (oss || (config.method == "s3" && !config.path_style)) && !has_bucket {
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
        if config.method == "s3" && config.path_style && !oss {
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

fn content_type(url: &Url) -> &'static str {
    if url.path().ends_with(".json") { "application/json" } else { "application/octet-stream" }
}

fn oss_signature(config: &Config, method: &Method, url: &Url, date: &str, forbid_overwrite: bool) -> Result<String, String> {
    let mime = if *method == Method::PUT { content_type(url) } else { "" };
    let path = percent_encoding::percent_decode_str(url.path()).decode_utf8().map_err(|_| "OSS 对象路径无效")?;
    let resource = format!("/{}{path}", config.bucket);
    let mut mac = <Hmac<Sha1> as Mac>::new_from_slice(config.secret_key.as_bytes()).map_err(|_| "云同步签名失败")?;
    let headers = if forbid_overwrite { "x-oss-forbid-overwrite:true\n" } else { "" };
    mac.update(format!("{method}\n\n{mime}\n{date}\n{headers}{resource}").as_bytes());
    Ok(format!("OSS {}:{}", config.access_key_id, B64.encode(mac.finalize().into_bytes())))
}

// Never forward Message, StringToSign, RequestId, URLs or unknown Code values:
// OSS error documents can contain credentials and signing material.
fn oss_error(status: StatusCode, stage: &str, bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let code = text.split_once("<Code>").and_then(|(_, rest)| rest.split_once("</Code>")).map(|(code, _)| code);
    let (code, hint) = match code {
        Some("SignatureDoesNotMatch") => ("SignatureDoesNotMatch", "请求签名不匹配"),
        Some("InvalidAccessKeyId") => ("InvalidAccessKeyId", "AccessKey ID 无效或已停用"),
        Some("AccessDenied") => ("AccessDenied", "存储桶策略或账号权限拒绝访问"),
        Some("RequestTimeTooSkewed") => ("RequestTimeTooSkewed", "本机时间与云端偏差过大，请同步系统时间"),
        Some("InvalidArgument") => ("InvalidArgument", "OSS 不接受当前请求参数"),
        Some("InvalidRequest") => ("InvalidRequest", "OSS 不接受当前请求格式或签名版本"),
        Some("SignatureVersionNotSupported") => ("SignatureVersionNotSupported", "存储桶不支持当前签名版本"),
        Some("UnsupportedSignatureVersion") => ("UnsupportedSignatureVersion", "存储桶不支持当前签名版本"),
        Some("AuthorizationHeaderMalformed") => ("AuthorizationHeaderMalformed", "认证头或区域配置不正确"),
        Some("PermanentRedirect") => ("PermanentRedirect", "Endpoint 与存储桶所在区域不一致"),
        Some("NoSuchBucket") => ("NoSuchBucket", "存储桶不存在，请核对 Bucket 和 Endpoint"),
        Some("InvalidBucketName") => ("InvalidBucketName", "存储桶名称无效"),
        Some("MissingContentLength") => ("MissingContentLength", "请求缺少有效的文件长度"),
        Some("NotImplemented") => ("NotImplemented", "OSS 不支持当前请求头或传输方式"),
        Some("FileAlreadyExists") => ("FileAlreadyExists", "同名备份已存在，已阻止覆盖"),
        Some("InvalidDigest") => ("InvalidDigest", "请求内容校验值无效"),
        Some("BadDigest") => ("BadDigest", "请求内容与校验值不一致"),
        Some("RequestTimeout") => ("RequestTimeout", "OSS 接收请求超时"),
        _ => ("Unknown", "未识别的 OSS 错误，请检查 Endpoint、签名与请求参数"),
    };
    format!("阿里云 OSS {stage}失败：{hint}（HTTP {}，OSS {code}）", status.as_u16())
}

pub(super) async fn request(
    client: &Client,
    config: &Config,
    method: Method,
    url: Url,
    body: Vec<u8>,
    condition: Option<(&str, &str)>,
) -> Result<Response, String> {
    let oss = oss_endpoint(config)?;
    let forbid_overwrite = oss && method == Method::PUT && condition == Some(("If-None-Match", "*"));
    if oss && method == Method::PUT && condition.is_some() && !forbid_overwrite {
        return Err("OSS 不支持条件更新版本目录，请使用独立版本记录".into());
    }
    let mut request = client.request(method.clone(), url.clone());
    if config.method == "webdav" {
        request = request.basic_auth(&config.username, Some(&config.password));
    } else if oss {
        let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
        request = request.header("Authorization", oss_signature(config, &method, &url, &date, forbid_overwrite)?)
            .header("Date", date);
        if forbid_overwrite { request = request.header("x-oss-forbid-overwrite", "true"); }
    } else {
        let time = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        let (auth, hash) = signature(config, &method, &url, &body, &time)?;
        request = request
            .header("Authorization", auth)
            .header("x-amz-date", time)
            .header("x-amz-content-sha256", hash);
    }
    if let Some((name, value)) = condition {
        if !oss { request = request.header(name, value); }
    }
    if method.as_str() == "PROPFIND" {
        request = request.header("Depth", "0");
    }
    if method == Method::PUT {
        let total = body.len() as u64;
        if content_type(&url) == "application/json" {
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
        "PUT" if content_type(&url) == "application/json" => "登记版本",
        "PUT" => "上传文件",
        "GET" => "读取版本或备份",
        "DELETE" => "删除备份",
        "PROPFIND" => "检查访问权限",
        _ => "检查备份",
    };
    let mut response = request.send().await.map_err(|error| {
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
    })?;
    let status = response.status();
    // Keep expected absence/conflict responses available to version handling.
    if oss && !status.is_success() && status != StatusCode::PRECONDITION_FAILED
        && !(status == StatusCode::NOT_FOUND && (method == Method::GET || method == Method::HEAD || method == Method::DELETE)) {
        let mut bytes = Vec::new();
        while bytes.len() < 16 * 1024 {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    let count = chunk.len().min(16 * 1024 - bytes.len());
                    bytes.extend_from_slice(&chunk[..count]);
                }
                _ => break,
            }
        }
        return Err(oss_error(status, diagnostic_stage, &bytes));
    }
    Ok(response)
}

pub(super) fn check(status: StatusCode) -> Result<(), String> {
    if status.is_success() {
        return Ok(());
    }
    let message = match status.as_u16() {
        401 | 403 => "认证失败或权限不足，请检查账号、应用密码或存储策略",
        404 => "远端目录、存储桶或备份不存在",
        409 => "远端目录冲突，请检查远程根目录",
        412 => "云端备份已发生变化，请先下载检查后再上传",
        429 => "远端请求过于频繁，请稍后重试",
        300..=399 => "服务器要求重定向，请填写最终服务地址（不会转发凭据）",
        _ => "云同步请求失败，请检查服务状态与配置",
    };
    Err(format!("{message}（HTTP {}）", status.as_u16()))
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
    fn oss_errors_only_expose_allowlisted_codes() {
        let message = oss_error(StatusCode::BAD_REQUEST, "上传文件", b"<Error><Code>InvalidRequest</Code><Message>private-fixture</Message><StringToSign>private-fixture</StringToSign></Error>");
        assert!(message.contains("OSS InvalidRequest"));
        assert!(message.contains("HTTP 400"));
        assert!(message.contains("上传文件"));
        assert!(!message.contains("private-fixture"));
        for body in ["<Code>private-fixture</Code>", "<Code>InvalidRequest", "<Code>InvalidRequest\nprivate-fixture</Code>", "<html>private-fixture</html>"] {
            let message = oss_error(StatusCode::BAD_REQUEST, "上传文件", body.as_bytes());
            assert!(message.contains("OSS Unknown"));
            assert!(!message.contains("private-fixture"));
        }
    }

    #[test]
    fn oss_bucket_urls_and_signatures_match_independent_fixture() {
        let mut config = Config::default();
        config.method = "s3".into();
        config.bucket = "fixture-bucket".into();
        config.access_key_id = "fixture-access".into();
        config.secret_key = "fixture-signing".into();
        config.remote_root = "folder with spaces".into();
        for endpoint in ["https://oss-cn-beijing.aliyuncs.com", "https://fixture-bucket.oss-cn-beijing.aliyuncs.com"] {
            config.endpoint = endpoint.into();
            for path_style in [true, false] {
                config.path_style = path_style;
                let target = url(&config, true).unwrap();
                assert_eq!(target.as_str(), "https://fixture-bucket.oss-cn-beijing.aliyuncs.com/folder%20with%20spaces/v1/default/database.chdb");
                assert_eq!(url(&config, false).unwrap().as_str(), "https://fixture-bucket.oss-cn-beijing.aliyuncs.com/");
                assert_eq!(oss_signature(&config, &Method::PUT, &target, "Fri, 30 Oct 2026 02:00:00 GMT", false).unwrap(),
                    "OSS fixture-access:77DFBf0D8JRsN04phrbXWl0DNcA=");
                assert_eq!(content_type(&named_url(&config, "versions.json").unwrap()), "application/json");
            }
        }
        config.endpoint = "https://oss-cn-beijing.aliyuncs.com.example.org".into();
        assert!(!oss_endpoint(&config).unwrap());
    }

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
