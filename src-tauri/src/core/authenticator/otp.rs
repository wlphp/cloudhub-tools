use super::Entry;
use data_encoding::BASE32_NOPAD;
use hmac::{Hmac, Mac};
use sha1::Sha1;
use sha2::{Sha256, Sha512};
use zeroize::Zeroizing;

pub fn normalize_secret(value: &str) -> Result<String, String> {
    if value.len() > 1024 {
        return Err("OTP 密钥长度无效".into());
    }
    let normalized = Zeroizing::new(
        value
            .chars()
            .filter(|c| !c.is_ascii_whitespace() && *c != '-')
            .collect::<String>()
            .to_ascii_uppercase()
            .trim_end_matches('=')
            .to_string(),
    );
    let bytes = Zeroizing::new(
        BASE32_NOPAD
            .decode(normalized.as_bytes())
            .map_err(|_| "OTP 密钥必须是有效的 Base32".to_string())?,
    );
    if bytes.is_empty() || bytes.len() > 128 {
        return Err("OTP 密钥长度应为 1 至 128 字节".into());
    }
    Ok(normalized.to_string())
}

pub fn generate(entry: &Entry, counter: u64) -> Result<String, String> {
    let key = Zeroizing::new(
        BASE32_NOPAD
            .decode(entry.secret.as_bytes())
            .map_err(|_| "OTP 密钥格式无效".to_string())?,
    );
    macro_rules! digest {
        ($hash:ty) => {{
            let mut mac = <Hmac<$hash> as Mac>::new_from_slice(&key)
                .map_err(|_| "OTP 初始化失败".to_string())?;
            mac.update(&counter.to_be_bytes());
            mac.finalize().into_bytes().to_vec()
        }};
    }
    let digest = Zeroizing::new(match entry.algorithm.as_str() {
        "SHA1" => digest!(Sha1),
        "SHA256" => digest!(Sha256),
        "SHA512" => digest!(Sha512),
        _ => return Err("OTP 算法不受支持".into()),
    });
    let offset = (digest[digest.len() - 1] & 15) as usize;
    let mut value = u32::from_be_bytes(
        digest[offset..offset + 4]
            .try_into()
            .map_err(|_| "OTP 计算失败")?,
    ) & 0x7fffffff;
    if entry.kind == "steam" {
        const ALPHABET: &[u8] = b"23456789BCDFGHJKMNPQRTVWXY";
        let mut code = String::new();
        for _ in 0..5 {
            code.push(ALPHABET[value as usize % ALPHABET.len()] as char);
            value /= ALPHABET.len() as u32;
        }
        Ok(code)
    } else {
        Ok(format!(
            "{:0width$}",
            value % 10u32.pow(entry.digits),
            width = entry.digits as usize
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::authenticator::formats::parse_uri;
    #[test]
    fn rfc4226_vectors() {
        let entry =
            parse_uri("otpauth://hotp/Test:demo?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&counter=0")
                .unwrap();
        for (counter, expected) in [
            "755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583",
            "399871", "520489",
        ]
        .iter()
        .enumerate()
        {
            assert_eq!(generate(&entry, counter as u64).unwrap(), *expected);
        }
    }
    #[test]
    fn rfc6238_all_algorithms_and_boundaries() {
        let times = [
            59,
            1111111109,
            1111111111,
            1234567890,
            2000000000,
            20000000000u64,
        ];
        let cases = [
            (
                "SHA1",
                b"12345678901234567890".as_slice(),
                [
                    "94287082", "07081804", "14050471", "89005924", "69279037", "65353130",
                ],
            ),
            (
                "SHA256",
                b"12345678901234567890123456789012".as_slice(),
                [
                    "46119246", "68084774", "67062674", "91819424", "90698825", "77737706",
                ],
            ),
            (
                "SHA512",
                b"1234567890123456789012345678901234567890123456789012345678901234".as_slice(),
                [
                    "90693936", "25091201", "99943326", "93441116", "38618901", "47863826",
                ],
            ),
        ];
        for (algorithm, key, expected) in cases {
            let uri = format!(
                "otpauth://totp/Test:demo?secret={}&algorithm={algorithm}&digits=8",
                BASE32_NOPAD.encode(key)
            );
            let entry = parse_uri(&uri).unwrap();
            for (time, code) in times.iter().zip(expected) {
                assert_eq!(generate(&entry, time / 30).unwrap(), code);
            }
        }
        let mut entry =
            parse_uri("otpauth://totp/Test:demo?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&period=60")
                .unwrap();
        assert_ne!(
            generate(&entry, 59 / entry.period).unwrap(),
            generate(&entry, 60 / entry.period).unwrap()
        );
        entry.kind = "steam".into();
        entry.digits = 5;
        assert_eq!(generate(&entry, 1).unwrap(), "PV9M4");
    }
}
