//! Desktop import: only metadata and expiring handles cross back to the UI.
use super::certificates::CertificateListItem;
use crate::core::{
    error::{PlatformError, PlatformResult},
    repositories::certificates as repository,
};
use crate::{encrypt_secret, open_db};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{Cursor, Read},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use uuid::Uuid;
use x509_parser::{extensions::GeneralName, prelude::*};
use zeroize::Zeroizing;

pub(crate) type CertificateResult<T> = Result<T, CertificateError>;
#[derive(Debug, Serialize)]
#[serde(transparent)]
pub(crate) struct CertificateError(PlatformError);
impl From<String> for CertificateError {
    fn from(message: String) -> Self {
        Self(PlatformError {
            kind: "platform-error",
            code: "certificate",
            message,
            retryable: false,
        })
    }
}
impl From<CertificateError> for PlatformError {
    fn from(error: CertificateError) -> Self {
        error.0
    }
}
impl From<&str> for CertificateError {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

const MAX_INPUT: u64 = 10 * 1024 * 1024;
const MAX_EXPANDED: u64 = 20 * 1024 * 1024;
const MAX_FILES: usize = 100;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportCandidate {
    pub id: String,
    pub primary_domain: String,
    pub domains: Vec<String>,
    pub issuer: String,
    pub serial_number: String,
    pub not_before: i64,
    pub not_after: i64,
    pub fingerprint: String,
    pub warnings: Vec<String>,
}

pub(crate) struct Material {
    pub metadata: ImportCandidate,
    pub certificate: Zeroizing<String>,
    pub key: Zeroizing<String>,
}

struct Pending {
    created: Instant,
    materials: Vec<Material>,
}
static PENDING: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportPreview {
    pub token: String,
    pub candidates: Vec<ImportCandidate>,
}

fn pem(der: &[u8]) -> String {
    pem_block("CERTIFICATE", der)
}
fn pem_block(label: &str, der: &[u8]) -> String {
    let encoded = STANDARD.encode(der);
    format!(
        "-----BEGIN {label}-----\n{}\n-----END {label}-----\n",
        encoded
            .as_bytes()
            .chunks(64)
            .map(|part| std::str::from_utf8(part).unwrap_or_default())
            .collect::<Vec<_>>()
            .join("\n")
    )
}

pub(crate) fn parse_material(certificate: &str, key: &str) -> Result<Material, String> {
    if certificate.len() as u64 > MAX_INPUT || key.len() as u64 > MAX_INPUT {
        return Err("证书材料超过大小限制".into());
    }
    let certs = rustls_pemfile::certs(&mut Cursor::new(certificate))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "证书 PEM 格式无效")?;
    if certs.is_empty() || certs.len() > MAX_FILES {
        return Err("没有找到有效证书".into());
    }
    let key_der = rustls_pemfile::private_key(&mut Cursor::new(key))
        .map_err(|_| "私钥格式无效")?
        .ok_or("没有找到未加密的有效私钥")?;
    let signing_key = rustls::crypto::ring::sign::any_supported_type(&key_der)
        .map_err(|_| "私钥类型不受支持或格式无效")?;
    let leaf_index = certs
        .iter()
        .position(|cert| {
            rustls::sign::CertifiedKey::new(vec![cert.clone()], signing_key.clone())
                .keys_match()
                .is_ok()
        })
        .ok_or("证书与私钥不匹配")?;
    let (_, leaf) =
        X509Certificate::from_der(certs[leaf_index].as_ref()).map_err(|_| "证书结构无效")?;
    if leaf.is_ca() {
        return Err("请选择网站证书，不能导入 CA 私钥".into());
    }
    let mut domains = Vec::new();
    if let Some(san) = leaf
        .subject_alternative_name()
        .map_err(|_| "证书域名扩展无效")?
    {
        for name in &san.value.general_names {
            match name {
                GeneralName::DNSName(name) => domains.push(name.to_ascii_lowercase()),
                GeneralName::IPAddress(bytes) if bytes.len() == 4 => domains.push(
                    std::net::Ipv4Addr::new(bytes[0], bytes[1], bytes[2], bytes[3]).to_string(),
                ),
                GeneralName::IPAddress(bytes) if bytes.len() == 16 => {
                    let mut address = [0; 16];
                    address.copy_from_slice(bytes);
                    domains.push(std::net::Ipv6Addr::from(address).to_string());
                }
                _ => (),
            }
        }
    }
    if domains.is_empty() {
        if let Some(name) = leaf
            .subject()
            .iter_common_name()
            .next()
            .and_then(|value| value.as_str().ok())
        {
            domains.push(name.to_ascii_lowercase());
        }
    }
    domains.sort();
    domains.dedup();
    if domains.is_empty()
        || domains.iter().any(|name| {
            !super::certificates::validate_domain(name) && name.parse::<std::net::IpAddr>().is_err()
        })
    {
        return Err("证书没有有效网站域名或 IP 地址".into());
    }
    let mut warnings = Vec::new();
    let now = Utc::now().timestamp();
    let not_before = leaf.validity().not_before.timestamp();
    let not_after = leaf.validity().not_after.timestamp();
    if not_after <= now {
        warnings.push("证书已过期，仅用于归档；部署前需替换".into());
    }
    if not_before > now {
        warnings.push("证书尚未生效".into());
    }
    let metadata = ImportCandidate {
        id: Uuid::new_v4().to_string(),
        primary_domain: domains[0].clone(),
        domains,
        issuer: leaf.issuer().to_string(),
        serial_number: leaf.raw_serial_as_string(),
        not_before,
        not_after,
        fingerprint: hex::encode(Sha256::digest(certs[leaf_index].as_ref())),
        warnings: vec![],
    };
    let mut ordered = vec![leaf_index];
    loop {
        let current = *ordered.last().ok_or("证书链为空")?;
        let (_, child) =
            X509Certificate::from_der(certs[current].as_ref()).map_err(|_| "证书链结构无效")?;
        if child.issuer() == child.subject() {
            child
                .verify_signature(None)
                .map_err(|_| "自签名证书签名无效")?;
            warnings.push("证书链包含自签名证书，信任状态由部署目标决定".into());
            break;
        }
        let parent = certs.iter().enumerate().find_map(|(index, cert)| {
            if ordered.contains(&index) {
                return None;
            }
            X509Certificate::from_der(cert.as_ref())
                .ok()
                .filter(|(_, candidate)| candidate.subject() == child.issuer())
                .map(|_| index)
        });
        match parent {
            Some(index) => {
                let (_, parent) = X509Certificate::from_der(certs[index].as_ref())
                    .map_err(|_| "证书链结构无效")?;
                if !parent.is_ca() {
                    return Err("证书链包含非 CA 签发证书".into());
                }
                child
                    .verify_signature(Some(parent.public_key()))
                    .map_err(|_| "证书链签名验证失败")?;
                ordered.push(index);
            }
            None => {
                warnings.push("未找到完整签发链，请确认中间证书齐全".into());
                break;
            }
        }
    }
    Ok(Material {
        metadata: ImportCandidate {
            warnings,
            ..metadata
        },
        certificate: Zeroizing::new(
            ordered
                .into_iter()
                .map(|index| pem(certs[index].as_ref()))
                .collect::<String>(),
        ),
        key: Zeroizing::new(key.to_string()),
    })
}

fn archive_inputs(bytes: Vec<u8>) -> Result<Vec<Zeroizing<String>>, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(Zeroizing::new(bytes)))
        .map_err(|_| "ZIP 压缩包无效或不受支持")?;
    if archive.len() > MAX_FILES {
        return Err("压缩包文件数量超过限制".into());
    }
    let mut total = 0u64;
    let mut result = Vec::new();
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|_| "无法读取压缩包文件")?;
        let name = file.name().replace('\\', "/");
        if file.enclosed_name().is_none()
            || name.starts_with('/')
            || name.contains(':')
            || name.split('/').any(|part| part == "..")
            || file
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("压缩包包含不安全路径或链接".into());
        }
        total = total
            .checked_add(file.size())
            .ok_or("压缩包超过解压大小限制")?;
        if total > MAX_EXPANDED || file.size() > MAX_INPUT {
            return Err("压缩包超过解压大小限制".into());
        }
        if file.is_dir() {
            continue;
        }
        let extension = std::path::Path::new(&name)
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(extension.as_str(), "zip" | "rar" | "7z") {
            return Err("不支持嵌套压缩包".into());
        }
        if !matches!(extension.as_str(), "pem" | "crt" | "cer" | "key") {
            continue;
        }
        let mut bytes = Zeroizing::new(Vec::new());
        (&mut file)
            .take(MAX_INPUT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "读取证书文件失败")?;
        if bytes.len() as u64 > MAX_INPUT {
            return Err("证书文件超过大小限制".into());
        }
        result.push(decode_input(&bytes)?);
    }
    Ok(result)
}

fn decode_input(bytes: &[u8]) -> Result<Zeroizing<String>, String> {
    if let Ok(text) = std::str::from_utf8(bytes) {
        if text.contains("-----BEGIN ") {
            return Ok(Zeroizing::new(text.to_string()));
        }
    }
    X509Certificate::from_der(bytes).map_err(|_| "证书文件不是有效 PEM 或 DER 格式")?;
    Ok(Zeroizing::new(pem(bytes)))
}

fn stage(inputs: Vec<Zeroizing<String>>) -> Result<ImportPreview, String> {
    if inputs.len() > MAX_FILES
        || inputs.iter().map(|input| input.len() as u64).sum::<u64>() > MAX_EXPANDED
    {
        return Err("导入文件数量或总大小超过限制".into());
    }
    let mut certs = Vec::new();
    let mut keys = Vec::new();
    for input in inputs {
        for item in rustls_pemfile::read_all(&mut Cursor::new(input.as_bytes())) {
            match item.map_err(|_| "证书或私钥格式无效")? {
                rustls_pemfile::Item::X509Certificate(cert) => certs.push(pem(cert.as_ref())),
                rustls_pemfile::Item::Pkcs1Key(key) => keys.push(Zeroizing::new(pem_block(
                    "RSA PRIVATE KEY",
                    key.secret_pkcs1_der(),
                ))),
                rustls_pemfile::Item::Pkcs8Key(key) => keys.push(Zeroizing::new(pem_block(
                    "PRIVATE KEY",
                    key.secret_pkcs8_der(),
                ))),
                rustls_pemfile::Item::Sec1Key(key) => keys.push(Zeroizing::new(pem_block(
                    "EC PRIVATE KEY",
                    key.secret_sec1_der(),
                ))),
                _ => (),
            }
        }
    }
    if keys.is_empty() {
        return Err("未找到私钥，请同时提供证书和私钥")?;
    }
    let chain = certs.join("");
    let mut materials = Vec::new();
    let mut last_error = "没有找到匹配的证书和私钥".to_string();
    for key in keys {
        match parse_material(&chain, &key) {
            Ok(material)
                if !materials.iter().any(|existing: &Material| {
                    existing.metadata.fingerprint == material.metadata.fingerprint
                }) =>
            {
                materials.push(material)
            }
            Ok(_) => (),
            Err(error) => last_error = error,
        }
    }
    if materials.is_empty() {
        return Err(last_error);
    }
    let preview = ImportPreview {
        token: Uuid::new_v4().to_string(),
        candidates: materials
            .iter()
            .map(|material| material.metadata.clone())
            .collect(),
    };
    let mut pending = PENDING
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "导入缓存暂不可用")?;
    pending.retain(|_, item| item.created.elapsed() < Duration::from_secs(600));
    if pending.len() >= 8 {
        return Err("待确认导入过多，请关闭已有导入窗口")?;
    }
    pending.insert(
        preview.token.clone(),
        Pending {
            created: Instant::now(),
            materials,
        },
    );
    Ok(preview)
}

pub(crate) fn prepare_certificate_import_text_inner(
    certificate: String,
    private_key: String,
) -> CertificateResult<ImportPreview> {
    let certificate = Zeroizing::new(certificate);
    let key = Zeroizing::new(private_key);
    stage(vec![certificate, key]).map_err(Into::into)
}

pub(crate) fn prepare_certificate_import_files_inner(
    paths: Vec<String>,
) -> CertificateResult<ImportPreview> {
    if paths.is_empty() || paths.len() > MAX_FILES {
        return Err("请选择证书文件或 ZIP 压缩包".into());
    }
    let mut inputs = Vec::new();
    let mut total = 0u64;
    for path in paths {
        let path = std::path::Path::new(&path);
        let metadata = std::fs::metadata(path).map_err(|_| "无法读取所选文件")?;
        total = total
            .checked_add(metadata.len())
            .ok_or("所选文件超过大小限制")?;
        if !metadata.is_file() || metadata.len() > MAX_INPUT || total > MAX_EXPANDED {
            return Err("所选文件类型无效或超过大小限制".into());
        }
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .map_err(|_| "无法打开所选文件")?
            .take(MAX_INPUT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "读取所选文件失败")?;
        if bytes.len() as u64 > MAX_INPUT {
            return Err("所选文件超过大小限制".into());
        }
        if path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
        {
            inputs.extend(archive_inputs(bytes)?);
        } else {
            let bytes = Zeroizing::new(bytes);
            inputs.push(decode_input(&bytes)?);
        }
        if inputs.len() > MAX_FILES
            || inputs.iter().map(|input| input.len() as u64).sum::<u64>() > MAX_EXPANDED
        {
            return Err("导入文件数量或总大小超过限制".into());
        }
    }
    stage(inputs).map_err(Into::into)
}

pub(crate) fn select_certificate_import_files_inner(
    app: tauri::AppHandle,
) -> CertificateResult<Option<ImportPreview>> {
    use tauri_plugin_dialog::DialogExt;
    let paths = app
        .dialog()
        .file()
        .add_filter("证书、私钥或 ZIP", &["pem", "crt", "cer", "key", "zip"])
        .blocking_pick_files();
    let Some(paths) = paths else {
        return Ok(None);
    };
    prepare_certificate_import_files_inner(paths.into_iter().map(|path| path.to_string()).collect())
        .map(Some)
}

pub(crate) fn save_material(
    material: &Material,
    source_kind: &str,
) -> Result<CertificateListItem, String> {
    let mut conn = open_db()?;
    let tx = conn.transaction().map_err(|_| "开启证书保存失败")?;
    let existing: Option<i64> = tx
        .query_row(
            "SELECT id FROM certificates WHERE fingerprint=?1",
            [&material.metadata.fingerprint],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "查找重复证书失败")?;
    if let Some(id) = existing {
        return Ok(repository::get(&tx, id)?.into());
    }
    let cert = encrypt_secret(&material.certificate)?;
    let key = encrypt_secret(&material.key)?;
    let now = Utc::now().timestamp_millis();
    let m = &material.metadata;
    tx.execute("INSERT INTO certificates(account_id,provider,primary_domain,domains_json,status,certificate_pem_ciphertext,private_key_ciphertext,serial_number,issuer,not_before,not_after,dns_zone,created_at,updated_at,source_kind,fingerprint) VALUES(NULL,?1,?2,?3,'issued',?4,?5,?6,?7,?8,?9,'',?10,?10,?1,?11)", params![source_kind,m.primary_domain,serde_json::to_string(&m.domains).map_err(|_| "证书域名保存失败")?,cert,key,m.serial_number,m.issuer,m.not_before,m.not_after,now,m.fingerprint]).map_err(|_| "保存导入证书失败")?;
    let id = tx.last_insert_rowid();
    tx.execute("INSERT INTO certificate_versions(certificate_id,fingerprint,certificate_pem_ciphertext,private_key_ciphertext,not_before,not_after,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![id,m.fingerprint,cert,key,m.not_before,m.not_after,now]).map_err(|_| "保存证书版本失败")?;
    tx.commit().map_err(|_| "提交证书保存失败")?;
    Ok(repository::get(&conn, id)?.into())
}

pub(crate) fn confirm_certificate_import_inner(
    token: String,
    candidate_id: String,
) -> CertificateResult<CertificateListItem> {
    let pending = PENDING
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "导入缓存暂不可用")?;
    let entry = pending
        .get(&token)
        .filter(|entry| entry.created.elapsed() < Duration::from_secs(600))
        .ok_or("导入预览已过期，请重新选择文件")?;
    let material = entry
        .materials
        .iter()
        .find(|item| item.metadata.id == candidate_id)
        .ok_or("请选择有效证书")?;
    let saved = save_material(material, "manual")?;
    drop(pending);
    cancel_certificate_import_inner(token)?;
    Ok(saved)
}

pub(crate) fn cancel_certificate_import_inner(token: String) -> CertificateResult<()> {
    PENDING
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "导入缓存暂不可用")?
        .remove(&token);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn matches_rsa_certificate_and_rejects_the_other_key() {
        use rsa::pkcs8::EncodePrivateKey;
        let key = rsa::RsaPrivateKey::new(&mut rsa::rand_core::OsRng, 2048).unwrap();
        let encoded = key.to_pkcs8_der().unwrap();
        let pair = rcgen::KeyPair::from_pkcs8_der_and_sign_algo(
            &rustls::pki_types::PrivatePkcs8KeyDer::from(encoded.as_bytes()),
            &rcgen::PKCS_RSA_SHA256,
        )
        .unwrap();
        let cert = rcgen::CertificateParams::new(vec!["rsa.test".into()])
            .unwrap()
            .self_signed(&pair)
            .unwrap();
        assert_eq!(
            parse_material(&cert.pem(), &pair.serialize_pem())
                .unwrap()
                .metadata
                .primary_domain,
            "rsa.test"
        );
    }

    #[test]
    fn discovers_multiple_key_pairs_in_a_single_bundle() {
        let first = rcgen::generate_simple_self_signed(vec!["first.test".into()]).unwrap();
        let second = rcgen::generate_simple_self_signed(vec!["second.test".into()]).unwrap();
        let input = format!(
            "{}{}{}{}",
            first.key_pair.serialize_pem(),
            first.cert.pem(),
            second.key_pair.serialize_pem(),
            second.cert.pem()
        );
        let preview = stage(vec![Zeroizing::new(input)]).unwrap();
        assert_eq!(preview.candidates.len(), 2);
        cancel_certificate_import(preview.token).unwrap();
    }

    #[test]
    fn matches_ecc_keys_and_returns_metadata_without_materials() {
        let generated = rcgen::generate_simple_self_signed(vec!["example.test".into()]).unwrap();
        let key = generated.key_pair.serialize_pem();
        let material = parse_material(&generated.cert.pem(), &key).unwrap();
        assert_eq!(material.metadata.domains, vec!["example.test"]);
        assert_eq!(material.metadata.fingerprint.len(), 64);
        let preview = stage(vec![
            Zeroizing::new(generated.cert.pem()),
            Zeroizing::new(key.clone()),
        ])
        .unwrap();
        let json = serde_json::to_string(&preview).unwrap();
        assert!(!json.contains("PRIVATE KEY"));
        assert!(!json.contains(&key));
        cancel_certificate_import(preview.token).unwrap();
    }

    #[test]
    fn rejects_mismatched_keys_without_disclosing_input() {
        let first = rcgen::generate_simple_self_signed(vec!["first.test".into()]).unwrap();
        let second = rcgen::generate_simple_self_signed(vec!["second.test".into()]).unwrap();
        let error = parse_material(&first.cert.pem(), &second.key_pair.serialize_pem())
            .err()
            .unwrap();
        assert_eq!(error, "证书与私钥不匹配");
    }

    #[test]
    fn zip_import_reads_materials_without_extracting_to_disk() {
        let generated = rcgen::generate_simple_self_signed(vec!["zip.test".into()]).unwrap();
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file(
                "nginx/fullchain.pem",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        writer.write_all(generated.cert.pem().as_bytes()).unwrap();
        writer
            .start_file(
                "nginx/private.key",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        writer
            .write_all(generated.key_pair.serialize_pem().as_bytes())
            .unwrap();
        let preview =
            stage(archive_inputs(writer.finish().unwrap().into_inner()).unwrap()).unwrap();
        assert_eq!(preview.candidates[0].primary_domain, "zip.test");
        cancel_certificate_import(preview.token).unwrap();
    }

    #[test]
    fn rejects_zip_traversal_and_oversized_inputs() {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("../private.key", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"invalid").unwrap();
        assert!(archive_inputs(writer.finish().unwrap().into_inner()).is_err());
        assert!(stage(vec![Zeroizing::new("x".repeat(MAX_EXPANDED as usize + 1))]).is_err());
    }
}

#[tauri::command]
pub(crate) fn prepare_certificate_import_text(
    certificate: String,
    private_key: String,
) -> PlatformResult<ImportPreview> {
    prepare_certificate_import_text_inner(certificate, private_key).map_err(Into::into)
}
#[tauri::command]
pub(crate) fn prepare_certificate_import_files(
    paths: Vec<String>,
) -> PlatformResult<ImportPreview> {
    prepare_certificate_import_files_inner(paths).map_err(Into::into)
}
#[tauri::command]
pub(crate) fn select_certificate_import_files(
    app: tauri::AppHandle,
) -> PlatformResult<Option<ImportPreview>> {
    select_certificate_import_files_inner(app).map_err(Into::into)
}
#[tauri::command]
pub(crate) fn confirm_certificate_import(
    token: String,
    candidate_id: String,
) -> PlatformResult<CertificateListItem> {
    confirm_certificate_import_inner(token, candidate_id).map_err(Into::into)
}
#[tauri::command]
pub(crate) fn cancel_certificate_import(token: String) -> PlatformResult<()> {
    cancel_certificate_import_inner(token).map_err(Into::into)
}
