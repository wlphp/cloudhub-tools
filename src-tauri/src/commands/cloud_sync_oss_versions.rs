//! OSS PutObject has no If-Match compare-and-swap. Keep one immutable JSON
//! record per backup instead of rewriting a shared versions.json across devices.
//! Existing versions.json is read by the parent for backwards compatibility.
use super::{selected_version, transport, BackupVersion, Config, MAX_VERSIONS};
use reqwest::{Client, Method, Response, StatusCode};

async fn read_small(mut response: Response, limit: usize) -> Result<Vec<u8>, String> {
    transport::check(response.status())?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取 OSS 版本信息失败")? {
        if bytes.len().saturating_add(chunk.len()) > limit { return Err("OSS 版本信息超过大小限制".into()); }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn field<'a>(xml: &'a str, tag: &str) -> Result<&'a str, String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let (_, rest) = xml.split_once(&open).ok_or("OSS 版本列表格式无效")?;
    let (value, _) = rest.split_once(&close).ok_or("OSS 版本列表格式无效")?;
    Ok(value)
}

fn decode_key(value: &str) -> Result<String, String> {
    // encoding-type=url makes keys plain percent-encoded text; no XML entities
    // or external entity resolution is needed or accepted.
    if value.len() > 3072 || value.contains(['<', '>', '&']) { return Err("OSS 版本路径无效".into()); }
    let decoded = percent_encoding::percent_decode_str(value).decode_utf8().map_err(|_| "OSS 版本路径无效")?;
    if decoded.len() > 1024 || decoded.chars().any(char::is_control) { return Err("OSS 版本路径无效".into()); }
    Ok(decoded.into_owned())
}

fn page(xml: &str, prefix: &str, marker: &str) -> Result<(Vec<String>, Option<String>, usize), String> {
    if !xml.contains("<ListBucketResult") || xml.contains("<!") || field(xml, "EncodingType")? != "url" {
        return Err("OSS 版本列表格式无效".into());
    }
    let mut names = Vec::new();
    let mut count = 0;
    let mut previous = marker.to_string();
    for block in xml.split("<Contents>").skip(1) {
        count += 1;
        if count > 1000 { return Err("OSS 版本列表过大".into()); }
        let (block, _) = block.split_once("</Contents>").ok_or("OSS 版本列表格式无效")?;
        let key = decode_key(field(block, "Key")?)?;
        if !key.starts_with(prefix) || key <= previous { return Err("OSS 版本路径或分页顺序无效".into()); }
        previous = key.clone();
        if let Some(id) = key.strip_suffix(".json") {
            let name = id.rsplit('/').next().ok_or("OSS 版本路径无效")?;
            selected_version(Some(name))?;
            // Only records directly beside this profile's backup files qualify.
            if key != format!("{}{}.json", prefix, name.strip_prefix("backup-").ok_or("OSS 版本路径无效")?) {
                return Err("OSS 版本路径无效".into());
            }
            names.push(name.to_string());
        }
    }
    let next = match field(xml, "IsTruncated")? {
        "false" => None,
        "true" => {
            let next = decode_key(field(xml, "NextMarker")?)?;
            if count == 0 || !next.starts_with(prefix) || next <= marker.to_string() || next < previous {
                return Err("OSS 版本分页无效".into());
            }
            Some(next)
        }
        _ => return Err("OSS 版本列表格式无效".into()),
    };
    Ok((names, next, count))
}

fn validate_record(version: &BackupVersion, id: &str) -> Result<(), String> {
    selected_version(Some(&version.id))?;
    if version.id != id || version.id == "database.chdb" || version.machine_name.len() > 400
        || version.machine_name.chars().any(char::is_control)
        || version.uploaded_at.as_ref().is_none_or(|s| chrono::DateTime::parse_from_rfc3339(s).is_err()) {
        return Err("OSS 备份版本信息无效".into());
    }
    Ok(())
}

pub(super) async fn versions(client: &Client, config: &Config, legacy: Vec<BackupVersion>) -> Result<Vec<BackupVersion>, String> {
    let target = transport::named_url(config, "backup-")?;
    let prefix = percent_encoding::percent_decode_str(target.path().trim_start_matches('/'))
        .decode_utf8().map_err(|_| "OSS 版本路径无效")?.into_owned();
    let mut result: std::collections::BTreeMap<String, BackupVersion> = legacy.into_iter().map(|v| (v.id.clone(), v)).collect();
    let mut marker = String::new();
    let mut discovered = std::collections::BTreeSet::new();
    let mut count = 0;
    loop {
        let mut url = transport::url(config, false)?;
        // ListObjects addresses the bucket root, even when Endpoint has a path.
        url.set_path("/");
        url.query_pairs_mut().append_pair("prefix", &prefix).append_pair("encoding-type", "url")
            .append_pair("max-keys", "1000").append_pair("marker", &marker);
        let response = transport::request(client, config, Method::GET, url, vec![], None).await?;
        let bytes = read_small(response, 2 * 1024 * 1024).await?;
        let xml = std::str::from_utf8(&bytes).map_err(|_| "OSS 版本列表格式无效")?;
        let (names, next, entries) = page(xml, &prefix, &marker)?;
        for block in xml.split("<Contents>").skip(1) {
            let key = decode_key(field(block, "Key")?)?;
            if key.ends_with(".chdb") {
                if let Some(name) = key.rsplit('/').next() { discovered.insert(name.to_string()); }
            }
        }
        count += entries;
        if count > MAX_VERSIONS * 2 { return Err("备份版本过多，请更换同步配置名".into()); }
        for id in names {
            let url = transport::named_url(config, &format!("{id}.json"))?;
            let response = transport::request(client, config, Method::GET, url, vec![], None).await?;
            // A record can disappear between listing and reading (external cleanup).
            if response.status() == StatusCode::NOT_FOUND { continue; }
            let record: BackupVersion = serde_json::from_slice(&read_small(response, 4096).await?)
                .map_err(|_| "OSS 备份版本信息无效")?;
            validate_record(&record, &id)?;
            discovered.insert(id.clone());
            result.insert(id, record);
            if result.len() > MAX_VERSIONS { return Err("备份版本过多，请更换同步配置名".into()); }
        }
        match next { Some(next) => marker = next, None => break }
    }
    // Legacy indexes cannot be safely rewritten on OSS; omit removed objects.
    Ok(result.into_values().filter(|v| discovered.contains(&v.id)).collect())
}

pub(super) async fn register(client: &Client, config: &Config, version: BackupVersion) -> Result<(), String> {
    validate_record(&version, &version.id)?;
    let target = transport::named_url(config, &format!("{}.json", version.id))?;
    let body = serde_json::to_vec(&version).map_err(|_| "生成 OSS 版本信息失败")?;
    let result = transport::request(client, config, Method::PUT, target.clone(), body.clone(), Some(("If-None-Match", "*"))).await;
    let error = match result {
        Ok(response) => match transport::check(response.status()) { Ok(()) => return Ok(()), Err(error) => error },
        Err(error) => error,
    };
    // A lost acknowledgement is success only if this exact record was committed.
    if let Ok(response) = transport::request(client, config, Method::GET, target, vec![], None).await {
        if let Ok(confirmed) = read_small(response, 4096).await {
            if confirmed == body { return Ok(()); }
        }
    }
    Err(error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use hmac::Mac;
    use std::io::{Read, Write};

    #[tokio::test]
    async fn native_http_uses_signed_oss_headers_and_reads_independent_paginated_records() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let mut config = Config::default();
        config.method = "oss".into(); config.allow_insecure = true;
        config.endpoint = format!("http://oss-cn-beijing.aliyuncs.com:{}", address.port());
        config.bucket = "fixture-bucket".into(); config.access_key_id = "fixture-access".into(); config.secret_key = "fixture-signing".into();
        let make_version = |id: &str| BackupVersion { id: format!("backup-{id}.chdb"), machine_name: "fixture-machine".into(), uploaded_at: Some("2026-10-30T02:00:00Z".into()), password_protected: Some(true) };
        let first = make_version("11111111-1111-4111-8111-111111111111");
        let second = make_version("22222222-2222-4222-8222-222222222222");
        let first_json = serde_json::to_string(&first).unwrap();
        let second_json = serde_json::to_string(&second).unwrap();
        let prefix = "cloudhub-sync/v1/default/backup-";
        let first_key = format!("cloudhub-sync/v1/default/{}.json", first.id);
        let second_key = format!("cloudhub-sync/v1/default/{}.json", second.id);
        let server = std::thread::spawn(move || {
            for step in 0..8 {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
                let mut bytes = Vec::new();
                let (header, body) = loop {
                    let mut buffer = [0; 4096];
                    let size = stream.read(&mut buffer).unwrap();
                    assert!(size > 0); bytes.extend_from_slice(&buffer[..size]);
                    if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                        let header = String::from_utf8(bytes[..end].to_vec()).unwrap();
                        let length = header.lines().find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length: ").and_then(|v| v.parse::<usize>().ok())).unwrap_or(0);
                        if bytes.len() >= end + 4 + length { break (header, bytes[end + 4..].to_vec()); }
                    }
                };
                let headers: std::collections::HashMap<_, _> = header.lines().skip(1).filter_map(|line| line.split_once(": ")).map(|(k, v)| (k.to_ascii_lowercase(), v)).collect();
                assert!(!headers.contains_key("if-match")); assert!(!headers.contains_key("if-none-match"));
                assert!(!headers.contains_key("transfer-encoding"));
                let line = header.lines().next().unwrap();
                if step < 2 {
                    assert!(line.starts_with("PUT "));
                    assert_eq!(headers.get("x-oss-forbid-overwrite"), Some(&"true"));
                    assert_eq!(headers.get("content-type"), Some(&"application/json"));
                    let path = line.split_whitespace().nth(1).unwrap();
                    let date = headers["date"];
                    let canonical = format!("PUT\n\napplication/json\n{date}\nx-oss-forbid-overwrite:true\n/fixture-bucket{path}");
                    let mut mac = <hmac::Hmac<sha1::Sha1> as Mac>::new_from_slice(b"fixture-signing").unwrap();
                    mac.update(canonical.as_bytes());
                    let signature = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
                    assert_eq!(headers["authorization"], format!("OSS fixture-access:{signature}"));
                    assert_eq!(body, if step == 0 { first_json.as_bytes() } else { second_json.as_bytes() });
                    // The second PUT commits, but its response is lost.
                    if step == 1 { continue; }
                }
                let (status, body) = match step {
                    0 => ("200 OK", String::new()),
                    2 | 7 => { assert!(line.contains(&second_key)); ("200 OK", second_json.clone()) },
                    3 => { assert!(line.contains("/versions.json")); ("404 Not Found", String::new()) },
                    4 | 6 => {
                        assert!(line.starts_with("GET /?"));
                        let path = line.split_whitespace().nth(1).unwrap();
                        let url = reqwest::Url::parse(&format!("http://fixture{path}")).unwrap();
                        let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
                        assert_eq!(query["prefix"], prefix); assert_eq!(query["encoding-type"], "url");
                        let (key, truncated) = if step == 4 { assert_eq!(query["marker"], ""); (&first_key, true) } else { assert_eq!(query["marker"], first_key); (&second_key, false) };
                        ("200 OK", format!("<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>{truncated}</IsTruncated><NextMarker>{key}</NextMarker><Contents><Key>{key}</Key></Contents></ListBucketResult>"))
                    }
                    5 => { assert!(line.contains(&first_key)); ("200 OK", first_json.clone()) },
                    _ => unreachable!(),
                };
                write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let client = Client::builder().no_proxy().resolve("fixture-bucket.oss-cn-beijing.aliyuncs.com", address).timeout(std::time::Duration::from_secs(5)).build().unwrap();
        register(&client, &config, first).await.unwrap();
        register(&client, &config, second).await.unwrap();
        let (versions, tag) = super::super::version_index(&client, &config).await.unwrap();
        assert_eq!(versions.len(), 2); assert!(tag.is_none());
        assert!(versions.iter().all(|v| v.machine_name == "fixture-machine"));
        server.join().unwrap();
    }

    #[test]
    fn encoded_pages_are_bounded_scoped_and_monotonic() {
        let id = "backup-11111111-1111-4111-8111-111111111111.chdb";
        let key = format!("folder%20name/v1/default/{id}.json");
        let xml = format!("<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>true</IsTruncated><NextMarker>{key}</NextMarker><Contents><Key>{key}</Key></Contents></ListBucketResult>");
        let (names, next, count) = page(&xml, "folder name/v1/default/backup-", "").unwrap();
        assert_eq!(names, vec![id]); assert_eq!(count, 1);
        assert!(next.is_some());
        assert!(page(&xml, "another/backup-", "").is_err());
        assert!(page(&xml, "folder name/v1/default/backup-", next.as_ref().unwrap()).is_err());
        assert!(page(&xml.replace(&key, "folder%20name/v1/default/backup-/../../private.json"), "folder name/v1/default/backup-", "").is_err());
        assert!(page(&xml.replace("<EncodingType>url", "<EncodingType>xml"), "folder name/v1/default/backup-", "").is_err());
        assert!(page(&xml.replace("<Key>", "<Key>&external;"), "folder name/v1/default/backup-", "").is_err());
    }
}
