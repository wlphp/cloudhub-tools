use crate::{account_cloud_type, account_credentials, write_api_log, ResourceResponse};
use serde_json::{json, Value};
use reqwest::Method;

fn text<'a>(v: &'a Value, key: &str) -> &'a str { v.get(key).and_then(Value::as_str).unwrap_or("") }
fn identifier(value: &str) -> Result<&str, String> {
    if value.len() == 32 && value.bytes().all(|c| c.is_ascii_hexdigit()) { Ok(value) }
    else { Err("Cloudflare ID 必须为 32 位十六进制字符".into()) }
}
fn name(value: &str) -> Result<&str, String> {
    if !value.is_empty() && value.len() <= 63 && value.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') { Ok(value) }
    else { Err("资源名称仅支持 1–63 位字母、数字、连字符或下划线".into()) }
}
fn project(v: &Value, fields: &[&str]) -> Value {
    let mut result = serde_json::Map::new();
    for field in fields { if let Some(value) = v.get(*field) { if value.is_string() || value.is_boolean() || value.is_number() || value.is_null() { result.insert((*field).into(), value.clone()); } } }
    Value::Object(result)
}

async fn request(id: i64, method: Method, path: &str, query: &[(String, String)], body: Option<Value>) -> Result<Value, String> {
    if account_cloud_type(id)? != "cloudflare" { return Err("当前账号不是 Cloudflare 账号".into()); }
    let (account, token) = account_credentials(id)?;
    let action = format!("{} {}", method, path);
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(std::time::Duration::from_secs(30)).build().map_err(|_| "无法初始化 Cloudflare 请求")?;
    let mut req = client.request(method, format!("https://api.cloudflare.com/client/v4/{path}")).bearer_auth(token).query(query);
    if let Some(body) = body { req = req.json(&body); }
    let response = req.send().await.map_err(|_| "Cloudflare 网络请求失败或超时")?;
    let status = response.status();
    let data: Value = response.json().await.map_err(|_| "Cloudflare 返回格式无效")?;
    if !status.is_success() || data["success"] != true {
        // 厂商消息可能回显请求内容，仅返回状态和数字错误码。
        let codes: Vec<String> = data["errors"].as_array().into_iter().flatten().filter_map(|e| e["code"].as_i64()).map(|c| c.to_string()).collect();
        let message = format!("Cloudflare HTTP {}（错误码 {}）；请检查 Token 权限、Account ID、资源状态或请求参数", status.as_u16(), codes.join(","));
        write_api_log(&account, "api.cloudflare.com", &action, &json!({}), None, "失败", Some(&message));
        return Err(message);
    }
    write_api_log(&account, "api.cloudflare.com", &action, &json!({}), Some(&json!({"success": true})), "成功", None);
    Ok(data)
}

async fn pages(id: i64, path: &str, extra: Vec<(String, String)>, single: bool, buckets: bool) -> Result<Vec<Value>, String> {
    let mut items = Vec::new();
    let mut cursor = String::new();
    for page in 1..=1000 {
        let mut query = extra.clone();
        if buckets { if !cursor.is_empty() { query.push(("cursor".into(), cursor.clone())); } }
        else if !single { query.extend([("page".into(), page.to_string()), ("per_page".into(), "50".into())]); }
        let data = request(id, Method::GET, path, &query, None).await?;
        let rows = if buckets { data.pointer("/result/buckets") } else { data.get("result") }.and_then(Value::as_array).ok_or("Cloudflare 资源列表格式无效")?;
        items.extend(rows.iter().cloned());
        if buckets {
            let next = data.pointer("/result_info/cursor").and_then(Value::as_str).unwrap_or("");
            if next.is_empty() { return Ok(items); }
            if next == cursor { return Err("Cloudflare 分页游标未推进".into()); }
            cursor = next.into();
        } else {
            let total = data.pointer("/result_info/total_pages").and_then(Value::as_u64);
            if single || rows.is_empty() || total.is_some_and(|n| page >= n) || (total.is_none() && rows.len() < 50) { return Ok(items); }
        }
    }
    Err("Cloudflare 资源超过分页上限，请缩小 Token 的资源范围".into())
}

pub(crate) async fn resource_items(id: i64, resource_type: &str) -> ResourceResponse {
    let result = async {
        let (account, _) = account_credentials(id)?;
        identifier(&account)?;
        let (path, extra, single, buckets) = match resource_type {
            "domain" => ("zones".into(), vec![("account.id".into(), account.clone())], false, false),
            "workers" => (format!("accounts/{account}/workers/scripts"), vec![], true, false),
            "oss" => (format!("accounts/{account}/r2/buckets"), vec![], false, true),
            "pages" => (format!("accounts/{account}/pages/projects"), vec![], false, false),
            "tunnel" => (format!("accounts/{account}/cfd_tunnel"), vec![("is_deleted".into(), "false".into())], false, false),
            _ => return Err("Cloudflare 不支持该资源类型".into()),
        };
        let rows = pages(id, &path, extra, single, buckets).await?;
        let fields: &[&str] = match resource_type {
            "domain" => &["id", "name", "status", "paused", "type", "created_on", "modified_on"],
            "workers" => &["id", "created_on", "modified_on", "compatibility_date", "usage_model"],
            "oss" => &["name", "creation_date", "location", "jurisdiction", "storage_class"],
            "pages" => &["id", "name", "subdomain", "created_on", "production_branch"],
            _ => &["id", "name", "status", "created_at", "deleted_at", "remote_config"],
        };
        Ok::<Vec<Value>, String>(rows.iter().map(|row| {
            let mut item = project(row, fields);
            let resource_id = if resource_type == "oss" { text(row, "name") } else { text(row, "id") };
            item["Id"] = json!(resource_id);
            item["Name"] = json!(if text(row, "name").is_empty() { resource_id } else { text(row, "name") });
            if resource_type == "domain" { item["DomainName"] = row["name"].clone(); }
            item["Status"] = row["status"].clone();
            item["_region_id"] = json!("global");
            item
        }).collect())
    }.await;
    let (items, errors) = match result { Ok(items) => (items, vec![]), Err(e) => (vec![], vec![e]) };
    ResourceResponse { resource_type: resource_type.into(), items, errors, fetched_at: chrono::Utc::now().timestamp_millis() }
}

pub(crate) async fn manage(id: i64, action: &str, input: Value) -> Result<Value, String> {
    let (account, _) = account_credentials(id)?;
    identifier(&account)?;
    if action == "verify" {
        request(id, Method::GET, &format!("accounts/{account}"), &[], None).await?;
        return Ok(json!({"verified": true}));
    }
    if action.starts_with("dns_") || action == "purge_cache" || action == "ssl_set" || action == "ssl_get" {
        let zone = identifier(text(&input, "zoneId"))?;
        // 验证该站点属于已保存的 Account ID，防止跨账户写入。
        let detail = request(id, Method::GET, &format!("zones/{zone}"), &[], None).await?;
        if detail.pointer("/result/account/id").and_then(Value::as_str) != Some(account.as_str()) { return Err("站点不属于当前 Cloudflare Account ID".into()); }
        if action == "ssl_get" {
            let settings = request(id, Method::GET, &format!("zones/{zone}/settings/ssl"), &[], None).await?;
            let mode = settings.pointer("/result/value").and_then(Value::as_str).ok_or("SSL 设置格式无效")?;
            if !["off", "flexible", "full", "strict"].contains(&mode) { return Err("SSL 模式无效".into()); }
            return Ok(json!({"mode": mode}));
        }
        let base = format!("zones/{zone}/dns_records");
        if action == "dns_list" {
            let rows = pages(id, &base, vec![], false, false).await?;
            return Ok(json!({"items": rows.iter().map(|r| project(r, &["id", "name", "type", "content", "ttl", "priority", "proxied", "proxiable", "comment"])).collect::<Vec<_>>()}));
        }
        let (method, path, body) = match action {
            "purge_cache" => (Method::POST, format!("zones/{zone}/purge_cache"), json!({"purge_everything": true})),
            "ssl_set" => {
                let mode = text(&input, "mode");
                if !["off", "flexible", "full", "strict"].contains(&mode) { return Err("SSL 模式无效".into()); }
                (Method::PATCH, format!("zones/{zone}/settings/ssl"), json!({"value": mode}))
            },
            "dns_delete" => (Method::DELETE, format!("{base}/{}", identifier(text(&input, "recordId"))?), Value::Null),
            "dns_proxy" => {
                let enabled = input["proxied"].as_bool().ok_or("代理状态无效")?;
                (Method::PATCH, format!("{base}/{}", identifier(text(&input, "recordId"))?), json!({"proxied": enabled}))
            },
            "dns_save" => {
                let body = dns_body(&input)?;
                if text(&input, "recordId").is_empty() { (Method::POST, base, body) }
                else { (Method::PATCH, format!("{base}/{}", identifier(text(&input, "recordId"))?), body) }
            },
            _ => return Err("不支持的 Cloudflare 操作".into()),
        };
        request(id, method, &path, &[], if body.is_null() { None } else { Some(body) }).await?;
    } else if action == "r2_create" {
        let bucket = text(&input, "name");
        if bucket.len() < 3 || bucket.len() > 63 || !bucket.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-') || bucket.starts_with('-') || bucket.ends_with('-') { return Err("R2 桶名称须为 3–63 位小写字母、数字或连字符，且首尾不能为连字符".into()); }
        request(id, Method::POST, &format!("accounts/{account}/r2/buckets"), &[], Some(json!({"name": bucket}))).await?;
    } else if action == "delete_resource" {
        let kind = text(&input, "kind");
        let resource = text(&input, "resourceId");
        let suffix = match kind {
            "workers" => format!("workers/scripts/{}", name(resource)?),
            "pages" => format!("pages/projects/{}", name(resource)?),
            "oss" => format!("r2/buckets/{}", name(resource)?),
            "tunnel" => { if uuid::Uuid::parse_str(resource).is_err() { return Err("Tunnel ID 无效".into()); } format!("cfd_tunnel/{resource}") },
            _ => return Err("不支持删除此类资源".into()),
        };
        request(id, Method::DELETE, &format!("accounts/{account}/{suffix}"), &[], None).await?;
    } else { return Err("不支持的 Cloudflare 操作".into()); }
    Ok(json!({"success": true}))
}

fn dns_body(input: &Value) -> Result<Value, String> {
    let kind = text(input, "type");
    if !["A", "AAAA", "CNAME", "TXT", "MX", "NS"].contains(&kind) { return Err("该记录类型请在 Cloudflare 控制台管理".into()); }
    let host = text(input, "name");
    if host.is_empty() || host.len() > 253 || !host.bytes().all(|c| c.is_ascii_alphanumeric() || b"-._*".contains(&c)) { return Err("DNS 名称无效，请填写完整域名".into()); }
    let content = text(input, "content");
    if content.is_empty() || content.len() > 4096 || content.chars().any(|c| c == '\0' || c == '\r' || c == '\n') { return Err("DNS 内容无效".into()); }
    if kind == "A" && content.parse::<std::net::Ipv4Addr>().is_err() { return Err("IPv4 地址无效".into()); }
    if kind == "AAAA" && content.parse::<std::net::Ipv6Addr>().is_err() { return Err("IPv6 地址无效".into()); }
    let ttl = input["ttl"].as_u64().ok_or("TTL 无效")?;
    if ttl != 1 && !(60..=86400).contains(&ttl) { return Err("TTL 必须为 1（自动）或 60–86400 秒".into()); }
    let proxied = input["proxied"].as_bool().ok_or("代理状态无效")?;
    if proxied && !["A", "AAAA", "CNAME"].contains(&kind) { return Err("此记录类型不支持代理".into()); }
    let mut body = json!({"type": kind, "name": host, "content": content, "ttl": if proxied { 1 } else { ttl }, "proxied": proxied});
    if kind == "MX" { let priority = input["priority"].as_u64().filter(|n| *n <= 65535).ok_or("MX 优先级无效")?; body["priority"] = json!(priority); }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validation_rejects_path_injection_and_invalid_dns() {
        assert!(identifier("../zones").is_err());
        assert!(name("x/y").is_err());
        assert!(dns_body(&json!({"type":"A","name":"example.test","content":"invalid","ttl":1,"proxied":false})).is_err());
        assert!(dns_body(&json!({"type":"TXT","name":"example.test","content":"text","ttl":1,"proxied":true})).is_err());
    }
    #[test]
    fn projection_excludes_nested_secrets_and_proxy_forces_auto_ttl() {
        assert_eq!(project(&json!({"name":"demo","env_vars": {"PRIVATE": "hidden"}}), &["name"]), json!({"name":"demo"}));
        assert_eq!(dns_body(&json!({"type":"A","name":"example.test","content":"192.0.2.1","ttl":300,"proxied":true})).unwrap()["ttl"], 1);
    }
}
