use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chrono::Utc;
use hmac::{Hmac, Mac};
use md5::{Digest, Md5};
use serde_json::{json, Value};
use sha1::Sha1;

fn text(xml: &str, tag: &str) -> String {
    xml.split_once(&format!("<{tag}>"))
        .and_then(|(_, rest)| rest.split_once(&format!("</{tag}>")))
        .map(|(value, _)| value.to_string()).unwrap_or_default()
}

fn domain_input(domain: &str) -> Result<String, String> {
    let domain = domain.trim().to_ascii_lowercase();
    if domain.contains('*') { return Err("普通 OSS 存储桶请填写具体域名，例如 img.example.com，不能填写泛域名 *.example.com".into()); }
    if domain.len() > 253 || !domain.contains('.') || !domain.split('.').all(|part| {
        !part.is_empty() && part.len() <= 63 && !part.starts_with('-') && !part.ends_with('-')
            && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    }) { return Err("请输入有效的完整域名，例如 img.example.com".into()); }
    Ok(domain)
}

fn target_input(bucket: &str, location: &str) -> Result<(), String> {
    let label = |s: &str| !s.is_empty() && !s.starts_with('-') && !s.ends_with('-') && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if !(3..=63).contains(&bucket.len()) || !label(bucket) || !location.starts_with("oss-") || location.len() > 63 || !label(location) {
        return Err("OSS 存储桶名称或地域无效，请刷新存储桶列表".into());
    }
    Ok(())
}

fn failure(_status: reqwest::StatusCode, xml: &str) -> String {
    // Only known codes reach UI; provider messages may echo signed request material.
    let hint = match text(xml, "Code").as_str() {
        "NeedVerifyDomainOwnership" => "请先获取验证 Token，并配置 TXT 记录；等待 DNS 生效后重试绑定",
        "AccessDenied" => "权限不足，请检查账号的 OSS 自定义域名操作权限",
        "CnameAlreadyExists" => "此域名已绑定其他存储桶，请先解除原绑定",
        "InvalidArgument" | "InvalidDomainName" => "域名参数无效，请使用具体的完整域名",
        _ => "请求被拒绝，请检查域名、地域和账号权限后重试",
    };
    hint.to_string()
}

async fn request(id: i64, bucket: &str, location: &str, component: Option<&str>, body: String) -> Result<String, String> {
    target_input(bucket, location)?;
    if crate::account_cloud_type(id).map_err(|_| "OSS 账号读取失败".to_string())? != "aliyun" { return Err("当前账号不是阿里云账号".into()); }
    let (key, secret) = crate::account_credentials(id).map_err(|_| "OSS 账号凭据读取失败".to_string())?;
    let method = if component.is_some() { "POST" } else { "GET" };
    let query = component.map(|value| format!("cname&comp={value}")).unwrap_or_else(|| "cname".into());
    let host = format!("{bucket}.{location}.aliyuncs.com");
    let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    let content_type = if body.is_empty() { "" } else { "application/xml" };
    let md5 = if body.is_empty() { String::new() } else { B64.encode(Md5::digest(body.as_bytes())) };
    let mut mac = <Hmac<Sha1> as Mac>::new_from_slice(secret.as_bytes()).map_err(|_| "OSS 签名初始化失败".to_string())?;
    mac.update(format!("{method}\n{md5}\n{content_type}\n{date}\n/{bucket}/?{query}").as_bytes());
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().map_err(|_| "OSS 客户端初始化失败".to_string())?;
    let mut req = client.request(if component.is_some() { reqwest::Method::POST } else { reqwest::Method::GET }, format!("https://{host}/?{query}"))
        .header("Date", date).header("Authorization", format!("OSS {key}:{}", B64.encode(mac.finalize().into_bytes())))
        .timeout(std::time::Duration::from_secs(25));
    if !body.is_empty() { req = req.header("Content-Type", content_type).header("Content-MD5", md5).body(body); }
    let response = req.send().await.map_err(|_| "OSS 连接失败或超时，请检查网络后重试".to_string())?;
    let status = response.status();
    let xml = response.text().await.map_err(|_| "OSS 返回读取失败".to_string())?;
    if !status.is_success() { return Err(failure(status, &xml)); }
    Ok(xml)
}

pub(crate) async fn mutate(id: i64, bucket: &str, location: &str, operation: &str, domain: &str) -> Result<Value, String> {
    let domain = domain_input(domain)?;
    let component = match operation { "token" => "token", "bind" => "add", "delete" => "delete", _ => return Err("不支持的域名操作".into()) };
    let body = format!("<BucketCnameConfiguration><Cname><Domain>{domain}</Domain></Cname></BucketCnameConfiguration>");
    let xml = request(id, bucket, location, Some(component), body).await?;
    let token = text(&xml, "Token");
    if operation == "token" && token.is_empty() { return Err("OSS 未返回验证 Token，请重新获取".into()); }
    Ok(json!({"domain": domain, "token": token, "expireTime": text(&xml, "ExpireTime")}))
}

pub(crate) async fn list(id: i64, bucket: &str, location: &str) -> Result<Value, String> {
    let xml = request(id, bucket, location, None, String::new()).await?;
    if !xml.contains("<ListCnameResult") { return Err("OSS 自定义域名列表格式无效".into()); }
    let items: Vec<Value> = xml.split("<Cname>").skip(1).filter_map(|part| {
        let (part, _) = part.split_once("</Cname>")?;
        let domain = domain_input(&text(part, "Domain")).ok()?;
        Some(json!({"Domain": domain, "Status": text(part, "Status")}))
    }).collect();
    Ok(json!(items))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_cname_and_target() {
        assert_eq!(domain_input(" Img.Sub.Example.com ").unwrap(), "img.sub.example.com");
        for bad in ["*.example.com", "https://example.com", "a..com", "-a.com", "a.com/<x>", "localhost"] { assert!(domain_input(bad).is_err()); }
        assert!(target_input("fixture-bucket", "oss-cn-beijing").is_ok());
        assert!(target_input("fixture/x", "oss-cn-beijing").is_err());
        assert!(target_input("fixture-bucket", "oss-cn-beijing.attacker.test").is_err());
    }
    #[test]
    fn errors_do_not_echo_provider_content() {
        let xml = "<Code>NeedVerifyDomainOwnership</Code><Message>secret-material</Message>";
        let error = failure(reqwest::StatusCode::FORBIDDEN, xml);
        assert!(error.contains("TXT"));
        assert!(!error.contains("secret-material"));
        assert!(!failure(reqwest::StatusCode::BAD_REQUEST, "<Code>secret-material</Code>").contains("secret-material"));
    }
}
