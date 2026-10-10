use super::{Entry, MAX_ENTRIES, MAX_FILE_BYTES};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use dryoc::classic::crypto_secretstream_xchacha20poly1305::*;
use dryoc::constants::{
    CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_ABYTES, CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL,
    CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_MESSAGE,
};
use rand::RngCore;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Kdf {
    pub mem_limit: u32,
    pub ops_limit: u32,
    pub salt: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Envelope {
    pub version: u32,
    pub kdf_params: Kdf,
    pub encrypted_data: String,
    pub encryption_nonce: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Backup {
    format: String,
    version: u32,
    items: Vec<Entry>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupEnvelope {
    format: String,
    envelope: Envelope,
}

pub fn derive(password: &str, kdf: &Kdf) -> Result<Zeroizing<[u8; 32]>, String> {
    // Serialize memory-hard work so concurrent imports cannot multiply the memory bound.
    static KDF_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = KDF_GATE.lock().map_err(|_| "密钥派生状态不可用")?;
    // Ente/libsodium memLimit is bytes, Argon2 Params memory is KiB; p=1, v=19, output=32.
    if password.is_empty()
        || password.len() > 1024
        || !(8192..=536870912).contains(&kdf.mem_limit)
        || !(1..=10).contains(&kdf.ops_limit)
    {
        return Err("密码或加密参数超出允许范围".into());
    }
    let salt = B64.decode(&kdf.salt).map_err(|_| "加密盐格式无效")?;
    if salt.len() != 16 {
        return Err("加密盐长度无效".into());
    }
    let params = Params::new(kdf.mem_limit / 1024, kdf.ops_limit, 1, Some(32))
        .map_err(|_| "加密参数无效")?;
    let mut key = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), &salt, &mut *key)
        .map_err(|_| "密钥派生失败")?;
    Ok(key)
}
pub fn seal(data: &[u8], password: &str) -> Result<Envelope, String> {
    if data.len() > MAX_FILE_BYTES {
        return Err("备份内容过大".into());
    }
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let kdf = Kdf {
        mem_limit: 67108864,
        ops_limit: 3,
        salt: B64.encode(salt),
    };
    let key = derive(password, &kdf)?;
    let mut state = State::new();
    let mut header = Header::default();
    crypto_secretstream_xchacha20poly1305_init_push(&mut state, &mut header, &key);
    let mut ciphertext = vec![0; data.len() + CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_ABYTES];
    crypto_secretstream_xchacha20poly1305_push(
        &mut state,
        &mut ciphertext,
        data,
        None,
        CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL,
    )
    .map_err(|_| "备份加密失败")?;
    Ok(Envelope {
        version: 1,
        kdf_params: kdf,
        encrypted_data: B64.encode(ciphertext),
        encryption_nonce: B64.encode(header),
    })
}
pub fn unseal(envelope: &Envelope, password: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    if envelope.version != 1 {
        return Err("加密文件版本不受支持".into());
    }
    if envelope.encrypted_data.len() > MAX_FILE_BYTES * 2 {
        return Err("加密文件过大".into());
    }
    let ciphertext = B64
        .decode(&envelope.encrypted_data)
        .map_err(|_| "加密内容格式无效")?;
    let header: Header = B64
        .decode(&envelope.encryption_nonce)
        .map_err(|_| "加密头格式无效")?
        .try_into()
        .map_err(|_| "加密头长度无效")?;
    if ciphertext.len() < CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_ABYTES
        || ciphertext.len() > MAX_FILE_BYTES + CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_ABYTES
    {
        return Err("加密内容长度无效".into());
    }
    let key = derive(password, &envelope.kdf_params)?;
    let mut state = State::new();
    crypto_secretstream_xchacha20poly1305_init_pull(&mut state, &header, &key);
    let mut data = Zeroizing::new(vec![
        0u8;
        ciphertext.len()
            - CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_ABYTES
    ]);
    let mut tag = 0;
    crypto_secretstream_xchacha20poly1305_pull(&mut state, &mut data, &mut tag, &ciphertext, None)
        .map_err(|_| "无法解密，请检查密码或文件完整性")?;
    if tag != CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL
        && tag != CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_MESSAGE
    {
        return Err("加密文件消息标记无效".into());
    }
    Ok(data)
}

pub fn parse_uri(raw: &str) -> Result<Entry, String> {
    if raw.len() > 8192 {
        return Err("OTP 地址过长".into());
    }
    let uri = Url::parse(raw.trim()).map_err(|_| "OTP 地址格式无效")?;
    if uri.scheme() != "otpauth"
        || uri.username() != ""
        || uri.password().is_some()
        || uri.port().is_some()
        || uri.fragment().is_some()
    {
        return Err("仅支持有效的 otpauth 地址".into());
    }
    let kind = uri.host_str().ok_or("OTP 地址缺少类型")?;
    let mut fields = std::collections::HashMap::new();
    for (key, value) in uri.query_pairs() {
        if fields.insert(key.to_string(), value.to_string()).is_some() {
            return Err("OTP 地址含重复参数".into());
        }
    }
    let label = percent_encoding::percent_decode_str(uri.path().trim_start_matches('/'))
        .decode_utf8()
        .map_err(|_| "OTP 名称编码无效")?;
    let (label_issuer, account) = label.split_once(':').unwrap_or(("", &label));
    let issuer = fields
        .get("issuer")
        .cloned()
        .unwrap_or_else(|| label_issuer.into());
    let numeric = |key: &str, default: u64| -> Result<u64, String> {
        fields
            .get(key)
            .map(|v| v.parse().map_err(|_| "OTP 数字参数无效".into()))
            .unwrap_or(Ok(default))
    };
    if kind == "hotp" && !fields.contains_key("counter") {
        return Err("HOTP 地址必须包含计数".into());
    }
    let mut entry = Entry {
        id: uuid::Uuid::new_v4().to_string(),
        issuer,
        account: account.into(),
        kind: kind.into(),
        algorithm: fields
            .get("algorithm")
            .map(|v| v.trim_start_matches("Algorithm.").to_ascii_uppercase())
            .unwrap_or_else(|| "SHA1".into()),
        digits: u32::try_from(numeric("digits", if kind == "steam" { 5 } else { 6 })?)
            .map_err(|_| "OTP 位数无效")?,
        period: numeric("period", 30)?,
        counter: numeric("counter", 0)?,
        secret: fields.remove("secret").ok_or("OTP 地址缺少密钥")?,
        group: String::new(),
        note: String::new(),
        pinned: false,
        order: 0,
    };
    entry.validate()?;
    Ok(entry)
}
pub fn uri(entry: &Entry) -> String {
    let encode = |v: &str| {
        percent_encoding::utf8_percent_encode(v, percent_encoding::NON_ALPHANUMERIC).to_string()
    };
    let mut result = format!(
        "otpauth://{}/{}:{}?secret={}&issuer={}&algorithm={}&digits={}&period={}",
        entry.kind,
        encode(&entry.issuer),
        encode(&entry.account),
        entry.secret,
        encode(&entry.issuer),
        entry.algorithm,
        entry.digits,
        entry.period
    );
    if entry.kind == "hotp" {
        result.push_str(&format!("&counter={}", entry.counter));
    }
    result
}

pub struct Parsed {
    pub entries: Vec<Entry>,
    pub errors: Vec<String>,
    pub format: String,
}
pub fn parse_file(content: &str, password: &str) -> Result<Parsed, String> {
    if content.len() > MAX_FILE_BYTES {
        return Err("导入文件不能超过 10 MiB".into());
    }
    let content = content.trim().trim_start_matches('\u{feff}');
    if content.starts_with('{') {
        let value: serde_json::Value =
            serde_json::from_str(content).map_err(|_| "JSON 文件格式无效")?;
        if value.get("format").and_then(|v| v.as_str()) == Some("cloudhub-authenticator-encrypted")
        {
            let wrapper: BackupEnvelope =
                serde_json::from_value(value).map_err(|_| "CloudHub 备份格式无效")?;
            let data = unseal(&wrapper.envelope, password)?;
            let backup: Backup =
                serde_json::from_slice(&data).map_err(|_| "CloudHub 备份内容无效")?;
            if backup.format != "cloudhub-authenticator" || backup.version != 1 {
                return Err("CloudHub 备份版本不受支持".into());
            }
            if backup.items.len() > MAX_ENTRIES {
                return Err("导入条数超过 10000".into());
            }
            let mut entries = backup.items;
            for entry in &mut entries {
                entry.validate()?;
            }
            return Ok(Parsed {
                entries,
                errors: vec![],
                format: "CloudHub 完整备份".into(),
            });
        }
        let envelope: Envelope =
            serde_json::from_value(value).map_err(|_| "不支持的导入文件格式".to_string())?;
        let data = unseal(&envelope, password)?;
        let text = std::str::from_utf8(&data).map_err(|_| "导入内容不是 UTF-8 文本")?;
        let mut parsed = parse_lines(text)?;
        parsed.format = "Ente 加密 v1".into();
        Ok(parsed)
    } else {
        parse_lines(content)
    }
}
pub fn parse_lines(text: &str) -> Result<Parsed, String> {
    // Older Ente versions used comma-separated records; escaped commas inside labels remain intact.
    let text = Zeroizing::new(
        text.replace(",otpauth://", "\notpauth://")
            .replace(", otpauth://", "\notpauth://"),
    );
    let mut entries = vec![];
    let mut errors = vec![];
    for (index, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        if entries.len() + errors.len() >= MAX_ENTRIES {
            return Err("导入条数超过 10000".into());
        }
        match parse_uri(line) {
            Ok(mut entry) => {
                entry.order = index as i64;
                entries.push(entry);
            }
            Err(reason) => errors.push(format!("第 {} 行：{}", index + 1, reason)),
        }
    }
    if entries.is_empty() && errors.is_empty() {
        return Err("导入文件没有验证码".into());
    }
    Ok(Parsed {
        entries,
        errors,
        format: "Ente / OTP 明文".into(),
    })
}
pub fn export(
    entries: &[Entry],
    format: &str,
    password: &str,
) -> Result<Zeroizing<Vec<u8>>, String> {
    if entries.is_empty() {
        return Err("请选择需要导出的验证码".into());
    }
    let data = if format == "cloudhub" {
        Zeroizing::new(
            serde_json::to_vec(&Backup {
                format: "cloudhub-authenticator".into(),
                version: 1,
                items: entries.to_vec(),
            })
            .map_err(|_| "备份序列化失败")?,
        )
    } else {
        let lines = Zeroizing::new(entries.iter().map(uri).collect::<Vec<_>>().join("\n") + "\n");
        Zeroizing::new(lines.as_bytes().to_vec())
    };
    if data.len() > MAX_FILE_BYTES {
        return Err("备份内容超过 10 MiB，请分批选择导出".into());
    }
    if format == "plain" {
        return Ok(data);
    }
    if !["cloudhub", "ente"].contains(&format) {
        return Err("导出格式不受支持".into());
    }
    if password.chars().count() < 8 {
        return Err("导出密码至少 8 个字符".into());
    }
    let envelope = seal(&data, password)?;
    let result = if format == "cloudhub" {
        serde_json::to_vec_pretty(&BackupEnvelope {
            format: "cloudhub-authenticator-encrypted".into(),
            envelope,
        })
    } else {
        serde_json::to_vec_pretty(&envelope)
    };
    let output = result.map_err(|_| "导出序列化失败")?;
    if output.len() > MAX_FILE_BYTES {
        return Err("备份文件超过 10 MiB，请分批选择导出".into());
    }
    Ok(Zeroizing::new(output))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn independent_libsodium_ente_vectors() {
        for file in [
            include_str!("../../../../tests/fixtures/authenticator/ente-libsodium-final.json"),
            include_str!("../../../../tests/fixtures/authenticator/ente-libsodium-message.json"),
        ] {
            let parsed = parse_file(file, "interop-test-passphrase").unwrap();
            assert_eq!(parsed.entries.len(), 1);
            assert_eq!(parsed.entries[0].account, "demo@example.test");
            assert_eq!(
                super::super::otp::generate(&parsed.entries[0], 1).unwrap(),
                "287082"
            );
        }
        // Optional path for a second implementation to decrypt the Rust-produced export.
        if let Ok(path) = std::env::var("CLOUDHUB_AUTH_INTEROP_OUTPUT") {
            let entry=parse_uri("otpauth://totp/Example:demo%40example.test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Example").unwrap();
            std::fs::write(
                path,
                &*export(&[entry], "ente", "interop-test-passphrase").unwrap(),
            )
            .unwrap();
        }
    }
    #[test]
    fn unicode_uri_roundtrip_and_invalid_inputs() {
        let entry=parse_uri("otpauth://totp/%E6%B5%8B%E8%AF%95:a%3Ab%25%2B%40example.test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&algorithm=SHA256&period=60&digits=8").unwrap();
        let restored = parse_uri(&uri(&entry)).unwrap();
        assert!(entry.same_seed(&restored));
        assert_eq!(entry.account, restored.account);
        assert_eq!(entry.issuer, restored.issuer);
        assert!(parse_uri("otpauth://hotp/Test:a?secret=INVALID").is_err());
        assert!(parse_uri("otpauth://totp/Test:a?secret=INVALID&secret=INVALID").is_err());
    }
    #[test]
    fn encrypted_roundtrip_tamper_and_metadata() {
        let mut entry = parse_uri(
            "otpauth://hotp/Test:demo?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&counter=17",
        )
        .unwrap();
        entry.group = "演示".into();
        entry.note = "示例备注".into();
        entry.pinned = true;
        for format in ["ente", "cloudhub", "plain"] {
            let data = export(&[entry.clone()], format, "test-passphrase").unwrap();
            let parsed =
                parse_file(std::str::from_utf8(&data).unwrap(), "test-passphrase").unwrap();
            assert!(entry.same_seed(&parsed.entries[0]));
            assert_eq!(parsed.entries[0].counter, 17);
            if format == "cloudhub" {
                assert_eq!(parsed.entries[0].group, entry.group);
                assert!(parsed.entries[0].pinned);
            }
            if format != "plain" {
                assert!(parse_file(std::str::from_utf8(&data).unwrap(), "incorrect").is_err());
            }
        }
        let mut envelope = seal(b"example", "test-passphrase").unwrap();
        envelope.encrypted_data.replace_range(..1, "A");
        assert!(unseal(&envelope, "test-passphrase").is_err());
        envelope.kdf_params.mem_limit = u32::MAX;
        assert!(unseal(&envelope, "test-passphrase").is_err());
    }
}
