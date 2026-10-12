//! Site certificates: secret material stays in Rust and is sent in a signed POST body.
use crate::core::{
    error::PlatformResult, repositories::certificates as repository, storage::open_db,
};
use chrono::Utc;
use hmac::{Hmac, Mac};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use zeroize::Zeroizing;

static DEPLOYMENT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Site {
    pub site_id: i64,
    pub site_name: String,
    pub access_type: String,
}

fn safe_error(code: &str) -> String {
    let known = match code {
        "CertificateDomainNotMatchSite" | "InvalidCertificate.NotFound" => {
            Some("证书域名与 ESA 站点不匹配")
        }
        "CertificateNotMatchPrivateKey" | "InvalidSSLPri" | "InvalidSSLPub" => {
            Some("证书与私钥不匹配或格式无效")
        }
        "CertQuotaCheckFailed" | "QuotaExceeded" | "QuotaNotExist" => {
            Some("ESA 自定义证书配额不足，请检查站点套餐")
        }
        "Certificate.Duplicated" => Some("ESA 证书名称已存在，请刷新站点证书后重试"),
        "Forbidden" | "Forbidden.RAM" | "AccessDenied" => Some("账号缺少 ESA 操作权限"),
        "LockFailed" | "Throttling" | "Throttling.User" => Some("ESA 正在处理请求或已限流，请稍后重试"),
        _ => None,
    };
    if let Some(message) = known {
        return format!("ESA：{message}");
    }

    // Provider codes are useful for diagnosis, but the rest of its response can
    // contain user-controlled or sensitive values. Only expose a short code token.
    if !code.is_empty()
        && code.len() <= 80
        && code.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        format!("ESA 返回错误代码 {code}，请检查账号权限、站点状态及证书格式后重试")
    } else {
        "ESA 请求失败，请检查账号权限、站点状态及请求参数后重试".to_string()
    }
}

fn encoded(values: &BTreeMap<String, String>) -> Zeroizing<String> {
    Zeroizing::new(
        values
            .iter()
            .map(|(key, value)| {
                format!(
                    "{}={}",
                    crate::cloud::aliyun::encode(key),
                    crate::cloud::aliyun::encode(value)
                )
            })
            .collect::<Vec<_>>()
            .join("&"),
    )
}

// Matches the official SDK: SetCertificate has form fields, other operations use query fields.
pub(crate) async fn api(
    account_id: i64,
    action: &str,
    values: BTreeMap<String, String>,
) -> Result<Value, String> {
    if !matches!(
        action,
        "SetCertificate"
            | "GetSite"
            | "GetCertificate"
            | "ListCertificates"
            | "CreateRecord"
            | "DeleteRecord"
    ) {
        return Err("不支持的 ESA 操作".into());
    }
    crate::ensure_aliyun_account(account_id)?;
    let (access_key, secret) = crate::account_credentials(account_id)?;
    let secret = Zeroizing::new(secret);
    let (client, request) = signed_request(action, values, &access_key, &secret)?;
    let mut response = client
        .execute(request)
        .await
        .map_err(|_| "ESA 网络请求失败或超时，请稍后刷新确认")?;
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "ESA 返回读取失败")? {
        if bytes.len() + chunk.len() > 512 * 1024 { return Err("ESA 返回超出大小限制".into()); }
        bytes.extend_from_slice(&chunk);
    }
    let data: Value = serde_json::from_slice(&bytes).map_err(|_| "ESA 返回格式无效")?;
    if !status.is_success() || data.get("Code").is_some() {
        let code = data.get("Code").and_then(Value::as_str).unwrap_or("");
        if !code.is_empty() {
            return Err(safe_error(code));
        }
        return Err(format!("ESA 请求返回 HTTP {}，请检查接口状态后重试", status.as_u16()));
    }
    // Never log request bodies or raw cloud responses from this path.
    Ok(data)
}

fn signed_request(
    action: &str,
    mut values: BTreeMap<String, String>,
    access_key: &str,
    secret: &str,
) -> Result<(reqwest::Client, reqwest::Request), String> {
    let host = "esa.cn-hangzhou.aliyuncs.com";
    let method = if action == "GetSite" { "GET" } else { "POST" };
    let body = if action == "SetCertificate" {
        encoded(&values)
    } else {
        Zeroizing::new(String::new())
    };
    let query = if action == "SetCertificate" {
        Zeroizing::new(String::new())
    } else {
        encoded(&values)
    };
    // Drop private-key and PEM map buffers before awaiting the network request.
    use zeroize::Zeroize;
    for value in values.values_mut() {
        value.zeroize();
    }
    values.clear();
    let hash = format!("{:x}", Sha256::digest(body.as_bytes()));
    let mut headers = BTreeMap::from([
        ("host", host.to_string()),
        ("x-acs-action", action.to_string()),
        ("x-acs-content-sha256", hash.clone()),
        (
            "x-acs-date",
            Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        ),
        ("x-acs-signature-nonce", uuid::Uuid::new_v4().to_string()),
        ("x-acs-version", "2024-09-10".to_string()),
    ]);
    if !body.is_empty() {
        headers.insert("content-type", "application/x-www-form-urlencoded".into());
    }
    let canonical_headers = headers
        .iter()
        .map(|(key, value)| format!("{key}:{value}\n"))
        .collect::<String>();
    let signed_headers = headers.keys().copied().collect::<Vec<_>>().join(";");
    let canonical = format!(
        "{method}\n/\n{}\n{canonical_headers}\n{signed_headers}\n{hash}",
        &*query
    );
    let string_to_sign = format!(
        "ACS3-HMAC-SHA256\n{:x}",
        Sha256::digest(canonical.as_bytes())
    );
    let mut mac: Hmac<Sha256> =
        <Hmac<Sha256> as Mac>::new_from_slice(secret.as_bytes()).map_err(|_| "ESA 签名失败")?;
    mac.update(string_to_sign.as_bytes());
    let authorization = format!(
        "ACS3-HMAC-SHA256 Credential={access_key},SignedHeaders={signed_headers},Signature={}",
        hex::encode(mac.finalize().into_bytes())
    );
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|_| "ESA 请求不可用")?;
    let url = if query.is_empty() {
        format!("https://{host}/")
    } else {
        format!("https://{host}/?{}", &*query)
    };
    let mut request = client.request(method.parse().map_err(|_| "ESA 请求方式无效")?, url);
    for (key, value) in headers {
        request = request.header(key, value);
    }
    request = request.header("authorization", authorization);
    if !body.is_empty() {
        request = request.body(body.as_bytes().to_vec());
    }
    let request = request.build().map_err(|_| "ESA 请求构建失败")?;
    Ok((client, request))
}

pub(crate) async fn site(account_id: i64, site_id: i64) -> Result<Site, String> {
    if account_id <= 0 || site_id <= 0 {
        return Err("ESA 账号或站点无效".into());
    }
    let data = api(
        account_id,
        "GetSite",
        BTreeMap::from([("SiteId".into(), site_id.to_string())]),
    )
    .await?;
    let model = data.get("SiteModel").ok_or("ESA 未返回站点信息")?;
    if model.get("SiteId").and_then(Value::as_i64) != Some(site_id) {
        return Err("ESA 返回的站点 ID 不匹配".into());
    }
    let name = model
        .get("SiteName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if !super::certificates::validate_domain(&name) || name.starts_with("*.") {
        return Err("ESA 站点域名无效".into());
    }
    Ok(Site {
        site_id,
        site_name: name,
        access_type: model
            .get("AccessType")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
    })
}

fn matches_site(domains: &[String], site: &str) -> bool {
    domains.iter().any(|domain| {
        let domain = domain.trim().to_ascii_lowercase();
        if let Some(base) = domain.strip_prefix("*.") {
            site.strip_suffix(&format!(".{base}"))
                .is_some_and(|label| !label.is_empty() && !label.contains('.'))
                || base == site
                || base.ends_with(&format!(".{site}"))
        } else {
            domain == site || domain.ends_with(&format!(".{site}"))
        }
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Candidate {
    id: i64,
    domains: Vec<String>,
    status: String,
    deployable: bool,
    matches_site: bool,
    reason: Option<String>,
    not_before: Option<i64>,
    not_after: Option<i64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteCertificate {
    id: String,
    name: String,
    status: String,
    domains: Vec<String>,
    not_after: String,
    kind: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Context {
    site: Site,
    candidates: Vec<Candidate>,
    remote: Vec<RemoteCertificate>,
}

#[tauri::command]
pub(crate) async fn esa_certificate_context(
    account_id: i64,
    site_id: i64,
) -> PlatformResult<Context> {
    let site = site(account_id, site_id).await?;
    let now = Utc::now().timestamp();
    let mut candidates = repository::list(&open_db()?, None)?
        .into_iter()
        .map(|cert| {
            let state_reason = if cert.status != "issued" {
                Some(format!("证书状态：{}", cert.status))
            } else if cert.not_before.is_some_and(|start| start > now) {
                Some("证书尚未生效".into())
            } else if cert.not_after.is_none() {
                Some("证书有效期未知".into())
            } else if cert.not_after.is_some_and(|end| end <= now) {
                Some("证书已过期".into())
            } else {
                None
            };
            let matches_site = matches_site(&cert.domains, &site.site_name);
            let deployable = state_reason.is_none();
            let reason = state_reason.or_else(|| {
                (!matches_site).then(|| "域名与当前 ESA 站点不匹配".into())
            });
            (
                cert.updated_at,
                Candidate {
                    id: cert.id,
                    domains: cert.domains,
                    status: cert.status,
                    deployable,
                    matches_site,
                    reason,
                    not_before: cert.not_before,
                    not_after: cert.not_after,
                },
            )
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|(left_updated, left), (right_updated, right)| {
        right
            .deployable
            .cmp(&left.deployable)
            .then_with(|| right.matches_site.cmp(&left.matches_site))
            .then_with(|| right_updated.cmp(left_updated))
            .then_with(|| right.id.cmp(&left.id))
    });
    let candidates = candidates.into_iter().map(|(_, candidate)| candidate).collect();
    let mut remote = Vec::new();
    for page in 1..=10 {
        let data = api(
            account_id,
            "ListCertificates",
            BTreeMap::from([
                ("SiteId".into(), site_id.to_string()),
                ("PageNumber".into(), page.to_string()),
                ("PageSize".into(), "100".into()),
            ]),
        )
        .await?;
        let rows = data
            .get("Result")
            .and_then(Value::as_array)
            .ok_or("ESA 证书列表格式无效")?;
        for row in rows {
            let text = |key| {
                row.get(key)
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            };
            let id = text("Id");
            if id.is_empty() || id.len() > 128 {
                continue;
            }
            remote.push(RemoteCertificate {
                id,
                name: text("Name"),
                status: text("Status"),
                domains: text("SAN")
                    .split(',')
                    .filter(|v| !v.is_empty())
                    .map(str::to_string)
                    .collect(),
                not_after: text("NotAfter"),
                kind: text("Type"),
            });
        }
        if remote.len() as u64
            >= data
                .get("TotalCount")
                .and_then(Value::as_u64)
                .unwrap_or(remote.len() as u64)
        {
            break;
        }
    }
    Ok(Context {
        site,
        candidates,
        remote,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Deployment {
    remote_id: String,
    status: String,
    verified: bool,
    message: String,
}

#[tauri::command]
pub(crate) async fn esa_deploy_certificate(
    account_id: i64,
    site_id: i64,
    certificate_id: i64,
) -> PlatformResult<Deployment> {
    let _guard = DEPLOYMENT_LOCK
        .try_lock()
        .map_err(|_| "已有证书部署正在进行，请稍候")?;
    let _site = site(account_id, site_id).await?;
    if certificate_id <= 0 {
        return Err("请选择本地证书".into());
    }
    let (cert, pem, key, previous) = {
        let conn = open_db()?;
        let cert = repository::get(&conn, certificate_id)?;
        if cert.status != "issued"
            || cert
                .not_after
                .is_none_or(|end| end <= Utc::now().timestamp())
            || cert
                .not_before
                .is_some_and(|start| start > Utc::now().timestamp())
        {
            return Err("证书尚未生效、已过期或有效期未知，请重新申请".into());
        }
        let (pem, key, _) = repository::secret_material(&conn, certificate_id)?;
        let previous: Option<String> = conn.query_row("SELECT remote_id FROM esa_certificate_deployments WHERE account_id=?1 AND site_id=?2 AND certificate_id=?3", params![account_id, site_id, certificate_id], |row| row.get(0)).optional().map_err(|_| "读取证书部署关联失败")?;
        (
            cert,
            Zeroizing::new(crate::decrypt_secret(&pem)?),
            Zeroizing::new(crate::decrypt_secret(&key)?),
            previous,
        )
    };
    if pem.len() > 256 * 1024
        || key.len() > 32 * 1024
        || !pem.contains("-----BEGIN CERTIFICATE-----")
        || !key.contains("PRIVATE KEY-----")
    {
        return Err("本地证书材料无效".into());
    }
    let name = format!("cloudhub-{account_id}-{site_id}-{}", cert.id);
    // Reuse the remote ID, including recovery after a lost upload response.
    let context = esa_certificate_context(account_id, site_id)
        .await
        .map_err(|_| "读取 ESA 证书失败，尚未上传")?;
    let previous = previous
        .filter(|id| {
            context
                .remote
                .iter()
                .any(|remote| &remote.id == id && remote.kind == "upload")
        })
        .or_else(|| {
            context
                .remote
                .iter()
                .find(|remote| remote.name == name && remote.kind == "upload")
                .map(|remote| remote.id.clone())
        });
    let mut fields = BTreeMap::from([
        ("SiteId".into(), site_id.to_string()),
        ("Type".into(), "upload".into()),
        ("Name".into(), name),
        ("Certificate".into(), pem.to_string()),
        ("PrivateKey".into(), key.to_string()),
    ]);
    if let Some(id) = previous {
        fields.insert("Id".into(), id);
    }
    let data = api(account_id, "SetCertificate", fields).await?;
    let remote_id: String = data
        .get("Id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 128)
        .ok_or("ESA 已接收上传但未返回证书 ID，请刷新确认后重试")?
        .into();
    open_db()?.execute("INSERT INTO esa_certificate_deployments(account_id,site_id,certificate_id,remote_id,updated_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(account_id,site_id,certificate_id) DO UPDATE SET remote_id=excluded.remote_id,updated_at=excluded.updated_at", params![account_id, site_id, certificate_id, remote_id, Utc::now().timestamp_millis()]).map_err(|_| "证书已上传，但本地部署关联保存失败，请刷新确认")?;
    let checked = api(
        account_id,
        "GetCertificate",
        BTreeMap::from([
            ("SiteId".into(), site_id.to_string()),
            ("Id".into(), remote_id.clone()),
        ]),
    )
    .await;
    let status = checked
        .as_ref()
        .ok()
        .and_then(|data| {
            data.get("Status")
                .or_else(|| data.get("Result").and_then(|row| row.get("Status")))
        })
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let verified = status == "OK";
    Ok(Deployment {
        remote_id,
        status,
        verified,
        message: if verified {
            "已上传到 ESA，证书状态正常；边缘节点生效可能需要等待，请确认站点已开启 SSL/TLS。"
        } else {
            "上传已完成，ESA 状态尚未确认；可刷新状态，无需重新申请证书。"
        }
        .into(),
    })
}

pub(crate) async fn create_txt(
    account_id: i64,
    site_id: i64,
    name: &str,
    value: &str,
) -> Result<String, String> {
    let data = api(
        account_id,
        "CreateRecord",
        BTreeMap::from([
            ("SiteId".into(), site_id.to_string()),
            ("Type".into(), "TXT".into()),
            ("RecordName".into(), name.into()),
            ("Ttl".into(), "60".into()),
            ("Data".into(), json!({"value": value}).to_string()),
            ("Proxied".into(), "false".into()),
        ]),
    )
    .await?;
    data.get("RecordId")
        .and_then(Value::as_i64)
        .filter(|id| *id > 0)
        .map(|id| id.to_string())
        .ok_or_else(|| "ESA 未返回挑战记录 ID，请检查站点 DNS 记录".into())
}
pub(crate) async fn delete_txt(account_id: i64, id: &str) -> Result<(), String> {
    api(
        account_id,
        "DeleteRecord",
        BTreeMap::from([("RecordId".into(), id.into())]),
    )
    .await
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signed_upload_keeps_material_in_body_and_hashes_actual_bytes() {
        let (_, request) = signed_request(
            "SetCertificate",
            BTreeMap::from([
                ("SiteId".into(), "123".into()),
                ("Type".into(), "upload".into()),
                ("Certificate".into(), "test-only-certificate\nline2".into()),
                ("PrivateKey".into(), "test-only-private-value".into()),
            ]),
            "test-only-access",
            "test-only-signing",
        )
        .unwrap();
        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(
            request.url().as_str(),
            "https://esa.cn-hangzhou.aliyuncs.com/"
        );
        let bytes = request.body().unwrap().as_bytes().unwrap();
        let body = std::str::from_utf8(bytes).unwrap();
        assert!(body.contains("PrivateKey=test-only-private-value"));
        assert!(body.contains("Certificate=test-only-certificate%0Aline2"));
        assert_eq!(
            request.headers()["x-acs-content-sha256"],
            format!("{:x}", Sha256::digest(bytes))
        );
        assert_eq!(
            request.headers()["content-type"],
            "application/x-www-form-urlencoded"
        );
    }
    #[test]
    fn site_matching_respects_label_boundaries_and_nested_wildcard_domains() {
        assert!(matches_site(&["*.example.com".into()], "www.example.com"));
        assert!(matches_site(
            &["*.frp.example.com".into()],
            "example.com"
        ));
        assert!(matches_site(&["*.example.com".into()], "example.com"));
        assert!(!matches_site(
            &["*.example.com".into()],
            "deep.www.example.com"
        ));
        assert!(!matches_site(&["badexample.com".into()], "example.com"));
        assert!(matches_site(&["www.example.com".into()], "example.com"));
        assert!(!matches_site(&["example.org".into()], "example.com"));
    }
    #[test]
    fn encoding_preserves_pem_newlines_and_error_codes_are_safely_filtered() {
        assert_eq!(
            &*encoded(&BTreeMap::from([(
                "Certificate".into(),
                "line1\nline2+=".into()
            )])),
            "Certificate=line1%0Aline2%2B%3D"
        );
        let message = safe_error("Certificate.BadFormat");
        assert!(message.contains("Certificate.BadFormat"));
        assert!(!safe_error("secret=TOP_SECRET").contains("TOP_SECRET"));
    }
}
