use base64::{engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD}, Engine as _};
use chrono::Utc;
use rsa::{pkcs1::EncodeRsaPrivateKey, pkcs1::EncodeRsaPublicKey, pkcs1v15::Pkcs1v15Sign, rand_core::OsRng, RsaPrivateKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, process::Command, time::Duration};
use tauri::Emitter;
use tauri_plugin_dialog::DialogExt;

use crate::{decrypt_secret, encrypt_secret, open_db, CertificateRequestStore};
use crate::core::error::{PlatformError, PlatformResult};
use crate::core::repositories::{accounts as account_repository, certificates as certificate_repository};

const LETS_ENCRYPT_DIRECTORY: &str = "https://acme-v02.api.letsencrypt.org/directory";
const LITESSL_DIRECTORY: &str = "https://acme.litessl.com/acme/v2/directory";
const DNS_PROPAGATION_ATTEMPTS: usize = 18;
const DNS_PROPAGATION_INTERVAL_SECONDS: u64 = 10;
const DNS_FALLBACK_SETTLE_SECONDS: u64 = 60;
const DNS_UNAVAILABLE_RETRY_ATTEMPTS: usize = 3;
const ORDER_STATUS_ATTEMPTS: usize = 120;
const ORDER_STATUS_INTERVAL_SECONDS: u64 = 5;
const FINALIZE_STATUS_ATTEMPTS: usize = 120;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CertificateRequestInput {
    pub account_id: i64,
    pub provider: String,
    pub primary_domain: String,
    pub domains: Vec<String>,
    pub dns_zone: String,
    pub eab_kid: Option<String>,
    pub eab_hmac_key: Option<String>,
    pub operation_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CertificateMaterial {
    pub certificate_pem: String,
    pub private_key_pem: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CertificateChainItem {
    pub level: usize,
    pub name: String,
    pub issuer: String,
    pub not_before: Option<i64>,
    pub not_after: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CertificatePreview {
    pub certificate_pem: String,
    pub private_key_available: bool,
    pub chain: Vec<CertificateChainItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[derive(Clone)]
struct CertificateRequestProgress {
    operation_id: String,
    stage: String,
    level: String,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CertificateListItem {
    pub id: i64,
    pub account_id: i64,
    pub provider: String,
    pub primary_domain: String,
    pub domains: Vec<String>,
    pub status: String,
    pub certificate_url: Option<String>,
    pub serial_number: Option<String>,
    pub issuer: Option<String>,
    pub not_before: Option<i64>,
    pub not_after: Option<i64>,
    pub dns_zone: String,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl From<certificate_repository::CertificateRecord> for CertificateListItem {
    fn from(value: certificate_repository::CertificateRecord) -> Self {
        Self { id: value.id, account_id: value.account_id, provider: value.provider, primary_domain: value.primary_domain, domains: value.domains, status: value.status, certificate_url: value.certificate_url, serial_number: value.serial_number, issuer: value.issuer, not_before: value.not_before, not_after: value.not_after, dns_zone: value.dns_zone, last_error: value.last_error, created_at: value.created_at, updated_at: value.updated_at }
    }
}

fn validate_domain(value: &str) -> bool {
    let value = value.trim().trim_start_matches("*.");
    value.len() <= 253 && value.contains('.') && value.split('.').all(|label| !label.is_empty() && label.len() <= 63 && label.as_bytes().first().is_some_and(|c| c.is_ascii_alphanumeric()) && label.as_bytes().last().is_some_and(|c| c.is_ascii_alphanumeric()) && label.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'))
}

fn domain_belongs_to_zone(domain: &str, dns_zone: &str) -> bool {
    let domain = domain.trim().trim_end_matches('.').trim_start_matches("*.");
    let dns_zone = dns_zone.trim().trim_end_matches('.');
    domain == dns_zone || domain.ends_with(&format!(".{dns_zone}"))
}

fn directory_url(provider: &str) -> Result<&'static str, String> {
    match provider { "letsencrypt" => Ok(LETS_ENCRYPT_DIRECTORY), "litessl" => Ok(LITESSL_DIRECTORY), _ => Err("证书品牌不受支持".into()) }
}

fn certificate_error_message(error: &str) -> &'static str {
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("取消") || normalized.contains("cancel") {
        "证书申请已取消，正在清理本次 DNS-01 TXT 记录"
    } else if normalized.contains("csr") || normalized.contains("证书签名请求") {
        "证书签名请求无效，正在检查证书域名与签名请求格式"
    } else if normalized.contains("订单尚未进入可签发") {
        "证书订单尚未进入可签发状态，请稍后重试"
    } else if normalized.contains("acme malformed") || normalized.contains("请求参数") {
        "证书服务拒绝了签发请求格式（ACME malformed）；CSR 已通过本地标准校验，请更换证书品牌或稍后重试"
    } else if normalized.contains("certificate public key") || normalized.contains("证书公钥") || normalized.contains("account key") {
        "证书私钥不能与 ACME 账号密钥相同，已自动使用独立证书密钥，请重新申请"
    } else if normalized.contains("nonce") {
        "证书服务会话已失效，请重新申请"
    } else if normalized.contains("权威 dns") {
        "证书服务未从权威 DNS 查询到本次 TXT 记录，请检查域名 NS 是否指向当前 DNS 服务商"
    } else if normalized.contains("txt 值不匹配") {
        "证书服务查询到的 TXT 值与本次申请不匹配，请勿修改或覆盖本次验证记录"
    } else if normalized.contains("caa") {
        "CAA 记录不允许当前证书服务签发，请调整 CAA 配置后重试"
    } else if normalized.contains("证书服务限流") {
        "证书服务请求过于频繁，请稍后再试"
    } else if normalized.contains("eab") {
        "证书品牌要求 EAB 配置，请检查 EAB KID 和 HMAC 密钥"
    } else if normalized.contains("当前账号") || normalized.contains("dns 区域不属于") {
        "DNS 区域不属于当前账号，或域名资产尚未同步"
    } else if normalized.contains("dns 验证") || normalized.contains("dns-01") {
        "DNS-01 验证未通过，请检查 TXT 记录传播和 DNS 账号权限"
    } else if normalized.contains("http 401") || normalized.contains("http 403") {
        "证书服务认证或权限不足，请检查品牌配置"
    } else if normalized.contains("http 400") || normalized.contains("http 404") {
        "证书服务拒绝了请求，请检查证书品牌和域名配置"
    } else if normalized.contains("请求失败") || normalized.contains("nonce") || normalized.contains("网络") || normalized.contains("连接") || normalized.contains("超时") {
        "无法连接证书服务，请检查网络后重试"
    } else if normalized.contains("阿里云") {
        "阿里云 DNS 操作失败，请检查账号权限和 DNS 区域"
    } else {
        "证书申请未完成，请检查申请参数后重试"
    }
}

fn certificate_platform_error(error: &str) -> PlatformError {
    let message = certificate_error_message(error).to_string();
    let retryable = error.to_ascii_lowercase().contains("限流") || error.contains("网络") || error.contains("超时");
    PlatformError { kind: "platform-error", code: "certificate", message, retryable }
}

fn emit_progress(app: &tauri::AppHandle, operation_id: &str, stage: &str, level: &str, message: &str) {
    let _ = app.emit("certificate-request-progress", CertificateRequestProgress {
        operation_id: operation_id.to_string(),
        stage: stage.to_string(),
        level: level.to_string(),
        message: message.to_string(),
    });
}

fn cancelled(store: &CertificateRequestStore, operation_id: &str) -> Result<bool, String> {
    store.cancelled_operations.lock().map(|operations| operations.contains(operation_id)).map_err(|_| "证书申请取消状态不可用".to_string())
}

fn ensure_not_cancelled(store: &CertificateRequestStore, operation_id: &str) -> Result<(), String> {
    if cancelled(store, operation_id)? { Err("证书申请已取消".into()) } else { Ok(()) }
}

async fn wait_with_cancellation(store: &CertificateRequestStore, operation_id: &str, seconds: u64) -> Result<(), String> {
    for _ in 0..seconds {
        ensure_not_cancelled(store, operation_id)?;
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    ensure_not_cancelled(store, operation_id)
}

fn der_len(length: usize) -> Vec<u8> {
    if length < 128 { return vec![length as u8]; }
    let mut bytes = Vec::new(); let mut value = length;
    while value > 0 { bytes.push((value & 0xff) as u8); value >>= 8; }
    bytes.reverse(); let mut result = vec![0x80 | bytes.len() as u8]; result.extend(bytes); result
}
fn der(tag: u8, body: &[u8]) -> Vec<u8> { let mut result = vec![tag]; result.extend(der_len(body.len())); result.extend(body); result }
fn der_seq(parts: &[Vec<u8>]) -> Vec<u8> { der(0x30, &parts.iter().flat_map(|part| part.clone()).collect::<Vec<_>>()) }
fn der_set(parts: &[Vec<u8>]) -> Vec<u8> { der(0x31, &parts.iter().flat_map(|part| part.clone()).collect::<Vec<_>>()) }
fn der_oid(bytes: &[u8]) -> Vec<u8> { der(0x06, bytes) }
fn der_null() -> Vec<u8> { vec![0x05, 0x00] }
fn der_integer(value: &[u8]) -> Vec<u8> { let mut value = value.to_vec(); while value.len() > 1 && value[0] == 0 { value.remove(0); } if value.first().is_some_and(|byte| byte & 0x80 != 0) { value.insert(0, 0); } der(0x02, &value) }

fn make_csr(key: &RsaPrivateKey, domains: &[String]) -> Result<Vec<u8>, String> {
    let public_key = key.to_public_key().to_pkcs1_der().map_err(|error| format!("生成证书公钥失败: {error}"))?.as_bytes().to_vec();
    let algorithm = der_seq(&[der_oid(&[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]), der_null()]);
    let mut public_key_bit_string = vec![0]; public_key_bit_string.extend(public_key); let spki = der_seq(&[algorithm, der(0x03, &public_key_bit_string)]);
    let common_name = domains.first().ok_or("证书域名不能为空")?;
    let subject = der_seq(&[der_set(&[der_seq(&[der_oid(&[0x55, 0x04, 0x03]), der(0x0c, common_name.as_bytes())])])]);
    let san_body = der_seq(&domains.iter().map(|domain| der(0x82, domain.trim_start_matches("*.").as_bytes())).collect::<Vec<_>>());
    let extension = der_seq(&[der_oid(&[0x55, 0x1d, 0x11]), der(0x04, &san_body)]);
    let extensions = der_seq(&[extension]);
    let extension_request = der_seq(&[der_oid(&[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x0e]), der_set(&[extensions])]);
    let attributes = der(0xa0, &extension_request);
    let request_info = der_seq(&[der_integer(&[0]), subject, spki, attributes]);
    let digest = Sha256::digest(&request_info);
    let signature = key.sign(Pkcs1v15Sign::new::<Sha256>(), &digest).map_err(|error| format!("签名证书请求失败: {error}"))?;
    let mut signature_bit_string = vec![0]; signature_bit_string.extend(signature); Ok(der_seq(&[request_info, der_seq(&[der_oid(&[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]), der_null()]), der(0x03, &signature_bit_string)]))
}

fn key_pem(key: &RsaPrivateKey) -> Result<String, String> {
    let der = key.to_pkcs1_der().map_err(|error| format!("导出证书私钥失败: {error}"))?;
    let body = STANDARD.encode(der.as_bytes());
    Ok(format!("-----BEGIN RSA PRIVATE KEY-----\n{}\n-----END RSA PRIVATE KEY-----", body.as_bytes().chunks(64).map(|chunk| String::from_utf8_lossy(chunk)).collect::<Vec<_>>().join("\n")))
}

fn jwk(key: &RsaPrivateKey) -> Result<Value, String> {
    use rsa::traits::PublicKeyParts;
    Ok(json!({ "e": URL_SAFE_NO_PAD.encode(key.e().to_bytes_be()), "kty": "RSA", "n": URL_SAFE_NO_PAD.encode(key.n().to_bytes_be()) }))
}

fn protected_jwk(key: &RsaPrivateKey) -> Result<String, String> { Ok(serde_json::to_string(&jwk(key)?).map_err(|error| error.to_string())?) }
fn thumbprint(key: &RsaPrivateKey) -> Result<String, String> { Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(protected_jwk(key)?.as_bytes()))) }

fn external_account_binding(key: &RsaPrivateKey, account_url: &str, kid: &str, hmac_key: &str) -> Result<Value, String> {
    let protected = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({"alg":"HS256","kid":kid,"url":account_url})).map_err(|error| error.to_string())?);
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&jwk(key)?).map_err(|error| error.to_string())?);
    let key_bytes = URL_SAFE_NO_PAD.decode(hmac_key.trim()).map_err(|_| "LiteSSL EAB HMAC 密钥格式无效，请填写 Base64URL 密钥".to_string())?;
    let mut mac: Hmac<Sha256> = Hmac::new_from_slice(&key_bytes).map_err(|_| "LiteSSL EAB HMAC 密钥格式无效".to_string())?;
    mac.update(format!("{protected}.{payload}").as_bytes());
    Ok(json!({"protected":protected,"payload":payload,"signature":URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())}))
}

fn jws_envelope(url: &str, payload: Value, key: &RsaPrivateKey, kid: Option<&str>, nonce: &str) -> Result<Vec<u8>, String> {
    let protected = if let Some(kid) = kid { json!({"alg":"RS256","kid":kid,"nonce":nonce,"url":url}) } else { json!({"alg":"RS256","jwk":jwk(key)?,"nonce":nonce,"url":url}) };
    let encoded_protected = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&protected).map_err(|error| error.to_string())?);
    let encoded_payload = if payload.is_null() { String::new() } else { URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).map_err(|error| error.to_string())?) };
    let digest = Sha256::digest(format!("{encoded_protected}.{encoded_payload}").as_bytes());
    let signature = key.sign(Pkcs1v15Sign::new::<Sha256>(), &digest).map_err(|error| format!("ACME 签名失败: {error}"))?;
    serde_json::to_vec(&json!({"protected":encoded_protected,"payload":encoded_payload,"signature":URL_SAFE_NO_PAD.encode(signature)})).map_err(|error| error.to_string())
}

async fn jws(client: &reqwest::Client, url: &str, payload: Value, key: &RsaPrivateKey, kid: Option<&str>, nonce: &str) -> Result<(reqwest::StatusCode, reqwest::header::HeaderMap, Value), String> {
    let envelope = jws_envelope(url, payload, key, kid, nonce)?;
    let response = client.post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/jose+json")
        .header(reqwest::header::ACCEPT, "application/json")
        .body(envelope)
        .send().await
        .map_err(|error| format!("证书服务请求失败: {error}"))?;
    let status = response.status(); let headers = response.headers().clone(); let body = response.text().await.map_err(|error| format!("读取证书服务响应失败: {error}"))?;
    let value = serde_json::from_str(&body).unwrap_or_else(|_| json!({"raw": body}));
    if !status.is_success() { return Err(acme_request_error(status, &value)); }
    Ok((status, headers, value))
}

async fn get_nonce(client: &reqwest::Client, url: &str) -> Result<String, String> {
    client.head(url).send().await.map_err(|error| format!("获取证书服务 nonce 失败: {error}"))?.headers().get("Replay-Nonce").and_then(|value| value.to_str().ok()).map(str::to_string).ok_or_else(|| "证书服务未返回 nonce".into())
}

fn header_url(headers: &reqwest::header::HeaderMap, name: &str) -> Result<String, String> { headers.get(name).and_then(|value| value.to_str().ok()).map(str::to_string).ok_or_else(|| format!("证书服务未返回 {name}")) }
fn record_id(value: &Value) -> Option<String> { value.get("RecordId").or_else(|| value.get("recordId")).and_then(Value::as_str).map(str::to_string).or_else(|| value.get("data").and_then(record_id)) }

fn normalize_txt_value(value: &str) -> String {
    value.trim().trim_matches('"').replace("\" \"", "")
}

fn dns01_record_name(domain: &str, dns_zone: &str) -> Result<(String, String), String> {
    let domain = domain.trim().trim_end_matches('.').trim_start_matches("*.").to_ascii_lowercase();
    let dns_zone = dns_zone.trim().trim_end_matches('.').to_ascii_lowercase();
    if domain == dns_zone {
        return Ok((format!("_acme-challenge.{dns_zone}"), "_acme-challenge".to_string()));
    }
    let suffix = format!(".{dns_zone}");
    let relative_domain = domain.strip_suffix(&suffix).filter(|value| !value.is_empty()).ok_or("申请域名不属于所选 DNS 区域")?;
    Ok((format!("_acme-challenge.{domain}"), format!("_acme-challenge.{relative_domain}")))
}

fn dns_record_was_written(records: &Value, rr: &str, value: &str) -> bool {
    records.get("items").and_then(Value::as_array).into_iter().flatten().any(|record| {
        record.get("RR").or_else(|| record.get("rr")).and_then(Value::as_str) == Some(rr)
            && record.get("Value").or_else(|| record.get("value")).and_then(Value::as_str).is_some_and(|actual| normalize_txt_value(actual) == value)
    })
}

enum TxtVisibility { Visible, Missing, Unavailable }

fn should_submit_after_unavailable_probe(attempt: usize) -> bool {
    attempt >= DNS_UNAVAILABLE_RETRY_ATTEMPTS
}

fn acme_problem_message(problem: &Value) -> &'static str {
    let problem_type = problem.get("type").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    let detail = problem.get("detail").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    let text = format!("{problem_type} {detail}");
    if text.contains("caa") {
        "CAA 记录不允许当前证书服务签发，请调整 CAA 配置后重试"
    } else if text.contains("ratelimit") || text.contains("rate limit") || text.contains("too many requests") {
        "证书服务限流，请稍后再试"
    } else if text.contains("incorrect") || text.contains("did not match") || text.contains("mismatch") {
        "TXT 值不匹配；请勿修改或覆盖本次验证记录"
    } else if text.contains("dns") || text.contains("txt") || text.contains("nxdomain") {
        "权威 DNS 未返回本次 TXT 记录；请检查域名 NS 是否指向当前 DNS 服务商"
    } else {
        "证书服务拒绝了 DNS-01 验证，请检查权威 DNS 中的 TXT 记录"
    }
}

fn acme_request_error(status: reqwest::StatusCode, problem: &Value) -> String {
    let problem_type = problem.get("type").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    let detail = problem.get("detail").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    if problem_type.contains("badcsr") {
        "证书签名请求（CSR）无效".to_string()
    } else if problem_type.contains("ordernotready") {
        "证书订单尚未进入可签发状态".to_string()
    } else if problem_type.contains("badnonce") {
        "证书服务 nonce 已失效".to_string()
    } else if problem_type.contains("rate") {
        "证书服务限流，请稍后再试".to_string()
    } else if problem_type.contains("malformed") {
        if detail.contains("public key") && detail.contains("account key") {
            "证书公钥不能与 ACME 账号密钥相同".to_string()
        } else if detail.contains("unmarshal") || detail.contains("parse") {
            "ACME malformed: 证书服务无法解析签发请求".to_string()
        } else {
            "ACME malformed: 证书服务拒绝了签发请求格式".to_string()
        }
    } else {
        format!("证书服务返回 HTTP {status}")
    }
}

async fn authorization_failure_message(
    client: &reqwest::Client,
    new_nonce: &str,
    key: &RsaPrivateKey,
    kid: &str,
    authorization_urls: &[String],
) -> Result<String, String> {
    for authorization_url in authorization_urls {
        let nonce = get_nonce(client, new_nonce).await?;
        let (_, _, authorization) = jws(client, authorization_url, Value::Null, key, Some(kid), &nonce).await?;
        let challenge_error = authorization.get("challenges").and_then(Value::as_array).and_then(|challenges| {
            challenges.iter().find(|challenge| challenge.get("status").and_then(Value::as_str) == Some("invalid"))
                .and_then(|challenge| challenge.get("error"))
        });
        if let Some(problem) = challenge_error {
            return Ok(acme_problem_message(problem).to_string());
        }
    }
    Ok("证书服务拒绝了 DNS-01 验证，请检查权威 DNS 中的 TXT 记录".to_string())
}

async fn txt_records_visibility(client: &reqwest::Client, name: &str, expected_values: &[String]) -> TxtVisibility {
    let mut resolver_responded = false;
    for endpoint in [
        format!("https://dns.alidns.com/resolve?name={name}&type=TXT"),
        format!("https://dns.google/resolve?name={name}&type=TXT"),
        format!("https://cloudflare-dns.com/dns-query?name={name}&type=TXT"),
    ] {
        let response = match client.get(endpoint).timeout(Duration::from_secs(4)).header("accept", "application/dns-json").send().await {
            Ok(response) if response.status().is_success() => response,
            _ => continue,
        };
        let payload = match response.json::<Value>().await { Ok(payload) => payload, Err(_) => continue };
        resolver_responded = true;
        let values = payload.get("Answer").and_then(Value::as_array).into_iter().flatten()
            .filter(|answer| answer.get("type").and_then(Value::as_i64) == Some(16))
            .filter_map(|answer| answer.get("data").and_then(Value::as_str))
            .map(normalize_txt_value)
            .collect::<Vec<_>>();
        if expected_values.iter().all(|expected| values.iter().any(|value| value == expected)) { return TxtVisibility::Visible; }
    }
    if resolver_responded { TxtVisibility::Missing } else { TxtVisibility::Unavailable }
}

fn der_tlv(data: &[u8], offset: usize) -> Option<(u8, usize, usize)> {
    let tag = *data.get(offset)?;
    let first_length = *data.get(offset + 1)?;
    let (length, header_length) = if first_length & 0x80 == 0 {
        (first_length as usize, 2)
    } else {
        let octets = (first_length & 0x7f) as usize;
        if octets == 0 || octets > 4 { return None; }
        let mut length = 0usize;
        for byte in data.get(offset + 2..offset + 2 + octets)? {
            length = length.checked_shl(8)?.checked_add(*byte as usize)?;
        }
        (length, 2 + octets)
    };
    let content_start = offset.checked_add(header_length)?;
    let content_end = content_start.checked_add(length)?;
    if content_end > data.len() { return None; }
    Some((tag, content_start, content_end))
}

fn parse_der_time(data: &[u8], tag: u8, start: usize, end: usize) -> Option<i64> {
    let value = std::str::from_utf8(data.get(start..end)?).ok()?;
    let format = match tag {
        0x17 => "%y%m%d%H%M%SZ",
        0x18 => "%Y%m%d%H%M%SZ",
        _ => return None,
    };
    chrono::NaiveDateTime::parse_from_str(value, format).ok().map(|date| date.and_utc().timestamp())
}

fn find_der_validity(data: &[u8]) -> Option<(i64, i64)> {
    let (certificate_tag, certificate_start, certificate_end) = der_tlv(data, 0)?;
    if certificate_tag != 0x30 { return None; }
    let (tbs_tag, tbs_start, tbs_end) = der_tlv(data, certificate_start)?;
    if tbs_tag != 0x30 || tbs_end > certificate_end { return None; }

    let mut offset = tbs_start;
    if let Some((tag, _, end)) = der_tlv(data, offset) {
        if tag == 0xa0 { offset = end; }
    }
    for expected_tag in [0x02, 0x30, 0x30] {
        let (tag, _, end) = der_tlv(data, offset)?;
        if tag != expected_tag { return None; }
        offset = end;
    }
    let (validity_tag, validity_start, validity_end) = der_tlv(data, offset)?;
    if validity_tag != 0x30 { return None; }
    let (not_before_tag, not_before_start, not_before_end) = der_tlv(data, validity_start)?;
    let (not_after_tag, not_after_start, not_after_end) = der_tlv(data, not_before_end)?;
    if not_after_end > validity_end { return None; }
    Some((
        parse_der_time(data, not_before_tag, not_before_start, not_before_end)?,
        parse_der_time(data, not_after_tag, not_after_start, not_after_end)?,
    ))
}

fn find_times(pem: &str) -> (Option<i64>, Option<i64>) {
    let first_block = pem.split("-----END CERTIFICATE-----").next().unwrap_or_default();
    let raw = first_block
        .split("-----BEGIN CERTIFICATE-----")
        .nth(1)
        .and_then(|encoded| STANDARD.decode(encoded.lines().collect::<String>()).ok())
        .unwrap_or_default();
    if let Some((not_before, not_after)) = find_der_validity(&raw) {
        return (Some(not_before), Some(not_after));
    }
    let mut found = Vec::new();
    for window in raw.windows(13) {
        if window[..12].iter().all(u8::is_ascii_digit) && window[12] == b'Z' {
            let value = String::from_utf8_lossy(window);
            if let Ok(date) = chrono::NaiveDateTime::parse_from_str(&value, "%y%m%d%H%M%SZ") {
                let timestamp = date.and_utc().timestamp();
                if !found.contains(&timestamp) { found.push(timestamp); }
            }
        }
    }
    for window in raw.windows(15) {
        if window[..14].iter().all(u8::is_ascii_digit) && window[14] == b'Z' {
            let value = String::from_utf8_lossy(window);
            if let Ok(date) = chrono::NaiveDateTime::parse_from_str(&value, "%Y%m%d%H%M%SZ") {
                let timestamp = date.and_utc().timestamp();
                if !found.contains(&timestamp) { found.push(timestamp); }
            }
        }
    }
    found.sort_unstable();
    (found.first().copied(), found.get(1).copied())
}

fn certificate_chain(pem: &str, primary_domain: &str, issuer: &str) -> Vec<CertificateChainItem> {
    pem.split("-----END CERTIFICATE-----")
        .enumerate()
        .filter_map(|(level, block)| {
            let encoded = block.split("-----BEGIN CERTIFICATE-----").nth(1)?;
            if encoded.lines().all(|line| line.trim().is_empty()) { return None; }
            let certificate_pem = format!("-----BEGIN CERTIFICATE-----\n{}-----END CERTIFICATE-----", encoded.trim());
            let (not_before, not_after) = find_times(&certificate_pem);
            Some(CertificateChainItem {
                level,
                name: if level == 0 { primary_domain.to_string() } else { format!("证书链证书 {level}") },
                issuer: issuer.to_string(),
                not_before,
                not_after,
            })
        })
        .collect()
}

#[tauri::command]
pub(crate) fn list_certificates(account_id: Option<i64>) -> PlatformResult<Vec<CertificateListItem>> {
    let conn = open_db()?;
    let rows = certificate_repository::list(&conn, account_id)?;
    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        let mut item: CertificateListItem = row.into();
        if item.not_before.is_none() || item.not_after.is_none() {
            if let Ok((certificate, _, _)) = certificate_repository::secret_material(&conn, item.id) {
                if let Ok(pem) = decrypt_secret(&certificate) {
                    let (not_before, not_after) = find_times(&pem);
                    if not_before.is_some() || not_after.is_some() {
                        item.not_before = item.not_before.or(not_before);
                        item.not_after = item.not_after.or(not_after);
                        let _ = certificate_repository::update_validity(&conn, item.id, item.not_before, item.not_after);
                    }
                }
            }
        }
        items.push(item);
    }
    Ok(items)
}

#[tauri::command]
pub(crate) async fn request_certificate(app: tauri::AppHandle, state: tauri::State<'_, CertificateRequestStore>, input: CertificateRequestInput) -> PlatformResult<CertificateListItem> {
    let operation_id = input.operation_id.as_deref().filter(|value| !value.trim().is_empty()).unwrap_or("certificate-request");
    state.cancelled_operations.lock().map_err(|_| "证书申请取消状态不可用")?.remove(operation_id);
    emit_progress(&app, operation_id, "started", "info", "已开始创建证书申请");
    let result = match request_certificate_inner(&app, &state, operation_id, &input).await {
        Ok(certificate) => {
            emit_progress(&app, operation_id, "completed", "success", "证书已签发并加密保存到本地");
            Ok(certificate)
        }
        Err(error) => {
            emit_progress(&app, operation_id, "failed", "error", certificate_error_message(&error));
            Err(certificate_platform_error(&error))
        }
    };
    let _ = state.cancelled_operations.lock().map(|mut operations| operations.remove(operation_id));
    result
}

#[tauri::command]
pub(crate) fn cancel_certificate_request(state: tauri::State<'_, CertificateRequestStore>, operation_id: String) -> PlatformResult<()> {
    let operation_id = operation_id.trim();
    if operation_id.is_empty() || operation_id.len() > 128 { return Err("证书申请标识无效".into()); }
    state.cancelled_operations.lock().map_err(|_| "证书申请取消状态不可用")?.insert(operation_id.to_string());
    Ok(())
}

async fn request_certificate_inner(app: &tauri::AppHandle, state: &CertificateRequestStore, operation_id: &str, input: &CertificateRequestInput) -> Result<CertificateListItem, String> {
    ensure_not_cancelled(state, operation_id)?;
    let provider = input.provider.trim().to_ascii_lowercase(); let directory = directory_url(&provider)?;
    let selected_domain = input.primary_domain.trim().to_ascii_lowercase(); let dns_zone = input.dns_zone.trim().trim_end_matches('.').to_ascii_lowercase();
    let mut domains = input.domains.iter().map(|value| value.trim().trim_end_matches('.').to_ascii_lowercase()).filter(|value| !value.is_empty()).collect::<Vec<_>>();
    if domains.is_empty() { domains.push(selected_domain.clone()); }
    if !validate_domain(&selected_domain) || !validate_domain(&dns_zone) || domains.iter().any(|domain| !validate_domain(domain)) || domains.iter().any(|domain| !domain_belongs_to_zone(domain, &dns_zone)) || domains.len() > 100 { return Err("证书域名或 DNS 区域格式无效".into()); }
    let primary_domain = domains.first().cloned().ok_or("证书域名不能为空")?;
    let cloud_type = {
        let conn = open_db()?;
        let cloud_type = account_repository::cloud_type(&conn, input.account_id)?;
        if !certificate_repository::has_domain_zone(&conn, input.account_id, &dns_zone)? { return Err("该 DNS 区域不属于当前账号，或当前账号尚未同步该域名资产".into()); }
        cloud_type
    };
    if cloud_type != "aliyun" { return Err("当前仅支持使用阿里云 DNS 自动写入验证记录；其他 DNS 可先手动配置后再接入".into()); }
    emit_progress(app, operation_id, "preflight", "info", "账号与 DNS 区域校验通过");
    let client = reqwest::Client::builder().user_agent("CloudHub-Tools/0.1 ACME client").timeout(Duration::from_secs(30)).build().map_err(|error| error.to_string())?;
    emit_progress(app, operation_id, "directory", "info", "正在连接证书服务");
    let directory_value: Value = client.get(directory).send().await.map_err(|error| format!("读取证书目录失败: {error}"))?.json().await.map_err(|error| format!("解析证书目录失败: {error}"))?;
    let new_nonce = directory_value.get("newNonce").and_then(Value::as_str).ok_or("证书服务目录缺少 nonce 地址")?;
    let new_account = directory_value.get("newAccount").and_then(Value::as_str).ok_or("证书服务目录缺少 account 地址")?;
    let new_order = directory_value.get("newOrder").and_then(Value::as_str).ok_or("证书服务目录缺少 order 地址")?;
    let account_key = RsaPrivateKey::new(&mut OsRng, 2048).map_err(|error| format!("生成 ACME 账号密钥失败: {error}"))?;
    let certificate_key = RsaPrivateKey::new(&mut OsRng, 2048).map_err(|error| format!("生成证书私钥失败: {error}"))?;
    let account_payload = if directory_value.get("meta").and_then(|meta| meta.get("externalAccountRequired")).and_then(Value::as_bool).unwrap_or(false) {
        emit_progress(app, operation_id, "eab", "info", "证书服务要求 EAB，正在校验配置");
        let kid = input.eab_kid.as_deref().filter(|value| !value.trim().is_empty()).ok_or("该证书品牌要求 EAB，请填写 EAB KID")?;
        let hmac_key = input.eab_hmac_key.as_deref().filter(|value| !value.trim().is_empty()).ok_or("该证书品牌要求 EAB，请填写 EAB HMAC 密钥")?;
        json!({"termsOfServiceAgreed":true,"externalAccountBinding":external_account_binding(&account_key, new_account, kid, hmac_key)?})
    } else { json!({"termsOfServiceAgreed":true}) };
    emit_progress(app, operation_id, "account", "info", "正在创建证书服务账号");
    let nonce = get_nonce(&client, new_nonce).await?; let (_, account_headers, _) = jws(&client, new_account, account_payload, &account_key, None, &nonce).await?;
    let kid = header_url(&account_headers, "location")?; let nonce = get_nonce(&client, new_nonce).await?;
    let identifiers = domains.iter().map(|domain| json!({"type":"dns","value":domain})).collect::<Vec<_>>();
    emit_progress(app, operation_id, "order", "info", "正在创建证书订单");
    let (_, order_headers, order) = jws(&client, new_order, json!({"identifiers":identifiers}), &account_key, Some(&kid), &nonce).await?;
    let order_url = header_url(&order_headers, "location").ok(); let finalize_url = order.get("finalize").and_then(Value::as_str).ok_or("证书订单缺少 finalize 地址")?.to_string(); let authorization_urls = order.get("authorizations").and_then(Value::as_array).ok_or("证书服务未返回域名验证地址")?.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>();
    if authorization_urls.is_empty() { return Err("证书服务未返回域名验证地址".into()); }
    let mut records = Vec::new(); let mut dns_values = BTreeMap::<String, Vec<String>>::new(); let mut challenge_urls = Vec::new(); let thumbprint = thumbprint(&account_key)?;
    let issue_result = async {
    emit_progress(app, operation_id, "dns", "info", "正在写入 DNS-01 TXT 验证记录");
    for authorization_url in &authorization_urls {
        ensure_not_cancelled(state, operation_id)?;
        let nonce = get_nonce(&client, new_nonce).await?; let (_, _, authorization) = jws(&client, authorization_url, Value::Null, &account_key, Some(&kid), &nonce).await?;
        let challenge = authorization.get("challenges").and_then(Value::as_array).and_then(|items| items.iter().find(|item| item.get("type").and_then(Value::as_str) == Some("dns-01"))).ok_or("证书服务未提供 DNS-01 验证")?;
        let identifier = authorization.get("identifier").and_then(|identifier| identifier.get("value")).and_then(Value::as_str).ok_or("证书服务未返回 DNS 验证域名")?;
        let token = challenge.get("token").and_then(Value::as_str).ok_or("DNS 验证缺少 token")?; let challenge_url = challenge.get("url").and_then(Value::as_str).ok_or("DNS 验证缺少地址")?;
        let value = URL_SAFE_NO_PAD.encode(Sha256::digest(format!("{token}.{thumbprint}").as_bytes()));
        let (dns_name, dns_rr) = dns01_record_name(identifier, &dns_zone)?;
        emit_progress(app, operation_id, "dns", "info", &format!("正在写入 DNS-01 TXT 记录：{dns_name}"));
        let response = crate::cloud::aliyun::add_dns_record(input.account_id, &dns_zone, "TXT", &dns_rr, &value, Some(600), None, None).await?;
        let provider_records = crate::cloud::aliyun::list_dns_records(input.account_id, &dns_zone, Some("TXT".to_string()), Some(dns_rr.clone())).await?;
        if !dns_record_was_written(&provider_records, &dns_rr, &value) { return Err("阿里云 DNS 未确认写入本次挑战记录".into()); }
        if let Some(id) = record_id(&response) { records.push(id); }
        dns_values.entry(dns_name).or_default().push(value);
        challenge_urls.push(challenge_url.to_string());
    }
    let mut propagated = false;
    let mut unavailable_probe_attempts = 0;
    for attempt in 1..=DNS_PROPAGATION_ATTEMPTS {
        ensure_not_cancelled(state, operation_id)?;
        emit_progress(app, operation_id, "dns-propagation", "info", &format!("正在检查 TXT 记录传播（第 {attempt}/{DNS_PROPAGATION_ATTEMPTS} 次）"));
        let mut all_visible = true;
        let mut all_unavailable = true;
        for (dns_name, values) in &dns_values {
            match txt_records_visibility(&client, dns_name, values).await {
                TxtVisibility::Visible => { all_unavailable = false; }
                TxtVisibility::Missing => { all_visible = false; all_unavailable = false; }
                TxtVisibility::Unavailable => { all_visible = false; }
            }
        }
        if all_visible {
            propagated = true;
            break;
        }
        if all_unavailable {
            unavailable_probe_attempts += 1;
            if !should_submit_after_unavailable_probe(unavailable_probe_attempts) {
                emit_progress(app, operation_id, "dns-propagation", "info", &format!("公共 DNS 探测服务不可达，等待 60 秒后重新探测（第 {unavailable_probe_attempts}/{DNS_UNAVAILABLE_RETRY_ATTEMPTS} 次）"));
                wait_with_cancellation(state, operation_id, DNS_FALLBACK_SETTLE_SECONDS).await?;
                continue;
            }
            emit_progress(app, operation_id, "dns-propagation", "info", "公共 DNS 探测连续不可达，已完成 3 次等待；再等待 60 秒后交由证书服务验证");
            wait_with_cancellation(state, operation_id, DNS_FALLBACK_SETTLE_SECONDS).await?;
            propagated = true;
            break;
        }
        if attempt < DNS_PROPAGATION_ATTEMPTS { wait_with_cancellation(state, operation_id, DNS_PROPAGATION_INTERVAL_SECONDS).await?; }
    }
    if !propagated {
        return Err("DNS 验证记录尚未传播到公共 DNS，请稍后重试".into());
    }
    emit_progress(app, operation_id, "dns-propagation", "success", "DNS 等待阶段完成，正在通知证书服务验证");
    for challenge_url in challenge_urls {
        ensure_not_cancelled(state, operation_id)?;
        let nonce = get_nonce(&client, new_nonce).await?;
        let _ = jws(&client, &challenge_url, json!({}), &account_key, Some(&kid), &nonce).await?;
    }
    emit_progress(app, operation_id, "dns", "info", "证书服务已开始 DNS-01 验证");
    let mut valid = false;
    let mut validation_failure = None;
    for attempt in 1..=ORDER_STATUS_ATTEMPTS {
        wait_with_cancellation(state, operation_id, ORDER_STATUS_INTERVAL_SECONDS).await?;
        let mut all_authorizations_valid = true;
        for authorization_url in &authorization_urls {
            let nonce = get_nonce(&client, new_nonce).await?;
            let (_, _, authorization) = jws(&client, authorization_url, Value::Null, &account_key, Some(&kid), &nonce).await?;
            match authorization.get("status").and_then(Value::as_str) {
                Some("valid") => {}
                Some("invalid") => {
                    validation_failure = Some(authorization_failure_message(&client, new_nonce, &account_key, &kid, &authorization_urls).await?);
                    break;
                }
                _ => all_authorizations_valid = false,
            }
        }
        if validation_failure.is_some() { break; }
        if all_authorizations_valid { valid = true; break; }
        emit_progress(app, operation_id, "dns", "info", &format!("证书服务正在验证 DNS（第 {attempt}/{ORDER_STATUS_ATTEMPTS} 次检查）"));
    }
    if !valid { return Err(validation_failure.unwrap_or_else(|| "证书服务未在限定时间完成 DNS-01 验证，请稍后重试".to_string())); }
    emit_progress(app, operation_id, "dns", "success", "DNS-01 验证通过");
    let mut order_ready = false;
    let mut certificate_url = None;
    for _ in 0..12 {
        let url = order_url.as_deref().ok_or("证书订单地址缺失")?;
        let nonce = get_nonce(&client, new_nonce).await?;
        let (_, _, current) = jws(&client, url, Value::Null, &account_key, Some(&kid), &nonce).await?;
        match current.get("status").and_then(Value::as_str) {
            Some("ready") => { order_ready = true; break; }
            Some("valid") => {
                certificate_url = current.get("certificate").and_then(Value::as_str).map(str::to_string);
                break;
            }
            Some("invalid") => return Err(acme_problem_message(current.get("error").unwrap_or(&Value::Null)).to_string()),
            _ => wait_with_cancellation(state, operation_id, ORDER_STATUS_INTERVAL_SECONDS).await?,
        }
    }
    if certificate_url.is_none() && !order_ready { return Err("证书订单未进入可签发状态，请稍后重新申请".into()); }
    if certificate_url.is_none() {
        emit_progress(app, operation_id, "finalize", "info", "正在生成并提交证书签名请求");
        let csr = make_csr(&certificate_key, &domains)?;
        let nonce = get_nonce(&client, new_nonce).await?;
        let (_, _, finalized_order) = jws(&client, &finalize_url, json!({"csr":URL_SAFE_NO_PAD.encode(csr)}), &account_key, Some(&kid), &nonce).await?;
        certificate_url = finalized_order.get("certificate").and_then(Value::as_str).map(str::to_string);
    }
    if certificate_url.is_none() { for _ in 0..FINALIZE_STATUS_ATTEMPTS { wait_with_cancellation(state, operation_id, ORDER_STATUS_INTERVAL_SECONDS).await?; let url = order_url.as_deref().ok_or("证书订单地址缺失")?; let nonce = get_nonce(&client, new_nonce).await?; let (_, _, current) = jws(&client, url, Value::Null, &account_key, Some(&kid), &nonce).await?; certificate_url = current.get("certificate").and_then(Value::as_str).map(str::to_string); if certificate_url.is_some() { break; } if current.get("status").and_then(Value::as_str) == Some("invalid") { return Err(acme_problem_message(current.get("error").unwrap_or(&Value::Null)).to_string()); } } }
    let certificate_url = certificate_url.ok_or("证书订单未返回下载地址")?; emit_progress(app, operation_id, "download", "info", "正在下载已签发证书"); let nonce = get_nonce(&client, new_nonce).await?; let (_, _, certificate_value) = jws(&client, &certificate_url, Value::Null, &account_key, Some(&kid), &nonce).await?;
    let certificate_pem = certificate_value.get("raw").and_then(Value::as_str).ok_or("证书服务返回内容格式无效")?.to_string();
    let private_key_pem = key_pem(&certificate_key)?; let (not_before, not_after) = find_times(&certificate_pem); let now = Utc::now().timestamp_millis();
    emit_progress(app, operation_id, "store", "info", "正在加密保存证书材料");
    let conn = open_db()?;
    let saved = certificate_repository::insert(&conn, input.account_id, &provider, &primary_domain, &domains, "issued", order_url.as_deref(), Some(&certificate_url), Some(&encrypt_secret(&certificate_pem)?), Some(&encrypt_secret(&private_key_pem)?), None, Some(&provider), not_before, not_after, &dns_zone, &records, None, now)?;
    Ok(saved.into())
    }.await;
    for id in records.iter() { let _ = crate::cloud::aliyun::delete_dns_record(input.account_id, id).await; }
    issue_result
}

#[tauri::command]
pub(crate) fn get_certificate_material(id: i64) -> PlatformResult<CertificateMaterial> {
    let (certificate, private_key, _) = certificate_repository::secret_material(&open_db()?, id)?;
    Ok(CertificateMaterial { certificate_pem: decrypt_secret(&certificate)?, private_key_pem: decrypt_secret(&private_key)? })
}

#[tauri::command]
pub(crate) fn get_certificate_preview(id: i64) -> PlatformResult<CertificatePreview> {
    let conn = open_db()?;
    let (certificate, private_key, _) = certificate_repository::secret_material(&conn, id)?;
    let record = certificate_repository::list(&conn, None)?.into_iter().find(|item| item.id == id).ok_or("证书不存在")?;
    let certificate_pem = decrypt_secret(&certificate)?;
    Ok(CertificatePreview {
        chain: certificate_chain(&certificate_pem, &record.primary_domain, record.issuer.as_deref().unwrap_or("未解析")),
        certificate_pem,
        private_key_available: !private_key.trim().is_empty(),
    })
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 { crc = if crc & 1 == 1 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 }; }
    }
    !crc
}

fn push_u16(target: &mut Vec<u8>, value: u16) { target.extend_from_slice(&value.to_le_bytes()); }
fn push_u32(target: &mut Vec<u8>, value: u32) { target.extend_from_slice(&value.to_le_bytes()); }

fn certificate_zip(certificate: &str, private_key: &str, extras: Vec<(String, Vec<u8>)>) -> Vec<u8> {
    let mut entries = vec![
        ("certificate.pem".to_string(), certificate.as_bytes().to_vec()),
        ("fullchain.pem".to_string(), certificate.as_bytes().to_vec()),
        ("private.key".to_string(), private_key.as_bytes().to_vec()),
        ("nginx/fullchain.pem".to_string(), certificate.as_bytes().to_vec()),
        ("nginx/privkey.pem".to_string(), private_key.as_bytes().to_vec()),
        ("apache/certificate.crt".to_string(), certificate.as_bytes().to_vec()),
        ("apache/private.key".to_string(), private_key.as_bytes().to_vec()),
        ("iis/certificate.pem".to_string(), certificate.as_bytes().to_vec()),
        ("iis/private.key".to_string(), private_key.as_bytes().to_vec()),
        ("tomcat/certificate.pem".to_string(), certificate.as_bytes().to_vec()),
        ("tomcat/private.key".to_string(), private_key.as_bytes().to_vec()),
        ("README.txt".to_string(), "证书包说明\r\n\r\n通用文件：certificate.pem、fullchain.pem、private.key。\r\nNginx：使用 nginx/fullchain.pem 和 nginx/privkey.pem。\r\nApache：使用 apache/certificate.crt 和 apache/private.key。\r\nIIS：优先使用 iis/certificate.pfx；也可以导入 iis/certificate.pem 和 iis/private.key。\r\nTomcat：优先使用 tomcat/keystore.p12；也可以使用 PEM 文件自行转换。\r\nPFX/PKCS#12 默认不设置密码；如果压缩包中没有对应文件，说明本机未安装 OpenSSL。\r\n".as_bytes().to_vec()),
    ];
    entries.extend(extras);
    let mut archive = Vec::new();
    let mut central = Vec::new();
    for (name, content) in entries.iter() {
        let name_bytes = name.as_bytes();
        let offset = archive.len() as u32;
        let checksum = crc32(content);
        push_u32(&mut archive, 0x0403_4b50); push_u16(&mut archive, 20); push_u16(&mut archive, 0); push_u16(&mut archive, 0); push_u16(&mut archive, 0); push_u16(&mut archive, 0); push_u32(&mut archive, checksum); push_u32(&mut archive, content.len() as u32); push_u32(&mut archive, content.len() as u32); push_u16(&mut archive, name_bytes.len() as u16); push_u16(&mut archive, 0); archive.extend_from_slice(name_bytes); archive.extend_from_slice(content);
        push_u32(&mut central, 0x0201_4b50); push_u16(&mut central, 20); push_u16(&mut central, 20); push_u16(&mut central, 0); push_u16(&mut central, 0); push_u16(&mut central, 0); push_u16(&mut central, 0); push_u32(&mut central, checksum); push_u32(&mut central, content.len() as u32); push_u32(&mut central, content.len() as u32); push_u16(&mut central, name_bytes.len() as u16); push_u16(&mut central, 0); push_u16(&mut central, 0); push_u16(&mut central, 0); push_u16(&mut central, 0); push_u32(&mut central, 0); push_u32(&mut central, offset); central.extend_from_slice(name_bytes);
    }
    let central_offset = archive.len() as u32;
    archive.extend_from_slice(&central);
    push_u32(&mut archive, 0x0605_4b50); push_u16(&mut archive, 0); push_u16(&mut archive, 0); push_u16(&mut archive, 2); push_u16(&mut archive, 2); push_u32(&mut archive, central.len() as u32); push_u32(&mut archive, central_offset); push_u16(&mut archive, 0);
    archive
}

fn pkcs12_exports(certificate: &str, private_key: &str) -> Vec<(String, Vec<u8>)> {
    let directory = std::env::temp_dir().join(format!("cloudhub-certificate-{}", uuid::Uuid::new_v4()));
    if fs::create_dir(&directory).is_err() { return Vec::new(); }
    let certificate_path = directory.join("certificate.pem");
    let key_path = directory.join("private.key");
    let p12_path = directory.join("certificate.p12");
    let result = (|| {
        fs::write(&certificate_path, certificate).ok()?;
        fs::write(&key_path, private_key).ok()?;
        let status = Command::new("openssl")
            .args(["pkcs12", "-export", "-out"])
            .arg(&p12_path)
            .args(["-inkey"])
            .arg(&key_path)
            .args(["-in"])
            .arg(&certificate_path)
            .args(["-passout", "pass:"])
            .output()
            .ok()?;
        if !status.status.success() { return None; }
        let bytes = fs::read(&p12_path).ok()?;
        Some(vec![("iis/certificate.pfx".to_string(), bytes.clone()), ("tomcat/keystore.p12".to_string(), bytes)])
    })();
    let _ = fs::remove_dir_all(&directory);
    result.unwrap_or_default()
}

#[tauri::command]
pub(crate) fn export_certificate_material(app: tauri::AppHandle, id: i64, primary_domain: String) -> PlatformResult<Option<String>> {
    let (certificate_ciphertext, private_key_ciphertext, _) = certificate_repository::secret_material(&open_db()?, id)?;
    let certificate = decrypt_secret(&certificate_ciphertext)?;
    let private_key = decrypt_secret(&private_key_ciphertext)?;
    let domain = primary_domain.trim().trim_start_matches("*.").replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_");
    let filename = format!("{}_{}.zip", if domain.is_empty() { "certificate" } else { &domain }, Utc::now().timestamp());
    let Some(selected) = app.dialog().file().set_file_name(filename).blocking_save_file() else { return Ok(None) };
    let target = selected.into_path().map_err(|_| "当前平台返回了不支持的保存地址".to_string())?;
    fs::write(&target, certificate_zip(&certificate, &private_key, pkcs12_exports(&certificate, &private_key))).map_err(|error| format!("保存证书压缩包失败: {error}"))?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

#[tauri::command]
pub(crate) fn delete_certificate(id: i64) -> PlatformResult<()> { certificate_repository::delete(&open_db()?, id).map_err(Into::into) }

#[cfg(test)]
mod tests {
    use super::{acme_problem_message, acme_request_error, certificate_error_message, certificate_zip, directory_url, dns01_record_name, dns_record_was_written, domain_belongs_to_zone, find_times, jws_envelope, make_csr, normalize_txt_value, should_submit_after_unavailable_probe, validate_domain};
    use base64::{engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD}, Engine as _};
    use rsa::{rand_core::OsRng, RsaPrivateKey};

    #[test]
    fn accepts_dns_names_and_rejects_unsafe_values() {
        assert!(validate_domain("example.com"));
        assert!(validate_domain("*.example.com"));
        assert!(!validate_domain("example"));
        assert!(!validate_domain("example.com/path"));
    }

    #[test]
    fn keeps_the_dns_root_out_of_a_subdomain_certificate() {
        assert!(domain_belongs_to_zone("api.example.com", "example.com"));
        assert!(domain_belongs_to_zone("*.api.example.com", "example.com"));
        assert!(!domain_belongs_to_zone("example.net", "example.com"));
    }

    #[test]
    fn selects_the_two_supported_acme_directories() {
        assert!(directory_url("letsencrypt").unwrap().contains("letsencrypt.org"));
        assert!(directory_url("litessl").unwrap().contains("litessl.com"));
        assert!(directory_url("other").is_err());
    }

    #[test]
    fn creates_a_csr_without_exposing_key_material() {
        let key = RsaPrivateKey::new(&mut OsRng, 2048).unwrap();
        let csr = make_csr(&key, &["example.com".into(), "www.example.com".into()]).unwrap();
        assert!(csr.starts_with(&[0x30]));
        assert!(String::from_utf8_lossy(&csr).contains("example.com"));
        assert!(!String::from_utf8_lossy(&csr).contains("BEGIN RSA PRIVATE KEY"));
    }

    #[test]
    fn reduces_certificate_failures_to_safe_log_messages() {
        assert_eq!(certificate_error_message("该证书品牌要求 EAB，请填写 EAB HMAC 密钥"), "证书品牌要求 EAB 配置，请检查 EAB KID 和 HMAC 密钥");
        let message = certificate_error_message("provider failed secret=TOP_SECRET token=TOP_TOKEN");
        assert!(!message.contains("TOP_SECRET"));
        assert!(!message.contains("TOP_TOKEN"));
    }

    #[test]
    fn normalizes_dns_over_https_txt_values() {
        assert_eq!(normalize_txt_value("\"challenge-token\""), "challenge-token");
        assert_eq!(normalize_txt_value("\"part-one\" \"part-two\""), "part-onepart-two");
    }

    #[test]
    fn parses_certificate_validity_times() {
        let encoded = STANDARD.encode(b"240101000000Z250101000000Z");
        let pem = format!("-----BEGIN CERTIFICATE-----\n{encoded}\n-----END CERTIFICATE-----");
        let (not_before, not_after) = find_times(&pem);
        assert_eq!(not_before, Some(chrono::NaiveDate::from_ymd_opt(2024, 1, 1).unwrap().and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp()));
        assert_eq!(not_after, Some(chrono::NaiveDate::from_ymd_opt(2025, 1, 1).unwrap().and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp()));
    }

    #[test]
    fn creates_a_zip_with_both_certificate_materials() {
        let archive = certificate_zip("CERTIFICATE", "PRIVATE KEY", Vec::new());
        assert_eq!(&archive[..4], &[0x50, 0x4b, 0x03, 0x04]);
        assert!(String::from_utf8_lossy(&archive).contains("certificate.pem"));
        assert!(String::from_utf8_lossy(&archive).contains("private.key"));
        assert_eq!(&archive[archive.len() - 22..archive.len() - 18], &[0x50, 0x4b, 0x05, 0x06]);
    }

    #[test]
    fn puts_dns01_txt_records_on_the_authorized_domain() {
        assert_eq!(dns01_record_name("example.com", "example.com").unwrap(), ("_acme-challenge.example.com".to_string(), "_acme-challenge".to_string()));
        assert_eq!(dns01_record_name("api.example.com", "example.com").unwrap(), ("_acme-challenge.api.example.com".to_string(), "_acme-challenge.api".to_string()));
        assert_eq!(dns01_record_name("*.api.example.com", "example.com").unwrap(), ("_acme-challenge.api.example.com".to_string(), "_acme-challenge.api".to_string()));
        assert!(dns01_record_name("other.example.net", "example.com").is_err());
    }

    #[test]
    fn retries_unavailable_public_dns_probes_before_submitting_the_challenge() {
        assert!(!should_submit_after_unavailable_probe(1));
        assert!(!should_submit_after_unavailable_probe(2));
        assert!(should_submit_after_unavailable_probe(3));
    }

    #[test]
    fn confirms_the_exact_aliyun_txt_record_without_exposing_its_value() {
        let records = serde_json::json!({"items":[{"RR":"_acme-challenge.api","Value":"challenge-value"}]});
        assert!(dns_record_was_written(&records, "_acme-challenge.api", "challenge-value"));
        assert!(!dns_record_was_written(&records, "_acme-challenge", "challenge-value"));
    }

    #[test]
    fn maps_acme_problem_documents_without_exposing_ca_details() {
        assert_eq!(acme_problem_message(&serde_json::json!({"type":"urn:ietf:params:acme:error:dns", "detail":"No TXT record found"})), "权威 DNS 未返回本次 TXT 记录；请检查域名 NS 是否指向当前 DNS 服务商");
        assert_eq!(acme_problem_message(&serde_json::json!({"type":"urn:ietf:params:acme:error:caa", "detail":"CAA forbids issuance"})), "CAA 记录不允许当前证书服务签发，请调整 CAA 配置后重试");
        assert_eq!(acme_problem_message(&serde_json::json!({"detail":"challenge did not match"})), "TXT 值不匹配；请勿修改或覆盖本次验证记录");
    }

    #[test]
    fn maps_finalize_problem_types_without_exposing_ca_details() {
        assert_eq!(acme_request_error(reqwest::StatusCode::BAD_REQUEST, &serde_json::json!({"type":"urn:ietf:params:acme:error:badCSR"})), "证书签名请求（CSR）无效");
        assert_eq!(acme_request_error(reqwest::StatusCode::BAD_REQUEST, &serde_json::json!({"type":"urn:ietf:params:acme:error:orderNotReady"})), "证书订单尚未进入可签发状态");
        assert_eq!(acme_request_error(reqwest::StatusCode::BAD_REQUEST, &serde_json::json!({"type":"urn:ietf:params:acme:error:malformed"})), "ACME malformed: 证书服务拒绝了签发请求格式");
        assert_eq!(certificate_error_message("ACME malformed: 证书服务拒绝了签发请求格式"), "证书服务拒绝了签发请求格式（ACME malformed）；CSR 已通过本地标准校验，请更换证书品牌或稍后重试");
        assert_eq!(acme_request_error(reqwest::StatusCode::BAD_REQUEST, &serde_json::json!({"type":"urn:ietf:params:acme:error:malformed", "detail":"Error finalizing order :: certificate public key must be different than account key"})), "证书公钥不能与 ACME 账号密钥相同");
        assert_eq!(certificate_error_message("证书公钥不能与 ACME 账号密钥相同"), "证书私钥不能与 ACME 账号密钥相同，已自动使用独立证书密钥，请重新申请");
    }

    #[test]
    fn encodes_finalize_as_a_flattened_jws_with_a_base64url_der_payload() {
        let key = RsaPrivateKey::new(&mut OsRng, 2048).unwrap();
        let csr = make_csr(&key, &["api.example.com".into()]).unwrap();
        let request = jws_envelope("https://ca.example.test/order/1/finalize", serde_json::json!({"csr": URL_SAFE_NO_PAD.encode(csr)}), &key, Some("https://ca.example.test/acct/1"), "nonce-value").unwrap();
        let envelope: serde_json::Value = serde_json::from_slice(&request).unwrap();
        let protected: serde_json::Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(envelope["protected"].as_str().unwrap()).unwrap()).unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(envelope["payload"].as_str().unwrap()).unwrap()).unwrap();
        assert_eq!(protected["url"], "https://ca.example.test/order/1/finalize");
        assert_eq!(protected["kid"], "https://ca.example.test/acct/1");
        assert!(payload["csr"].as_str().is_some_and(|value| !value.contains('=')));
        assert!(envelope["signature"].as_str().is_some_and(|value| !value.is_empty()));
    }
}
