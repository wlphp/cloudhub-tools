//! Cookie values never cross the renderer, logs or error messages. File actions
//! use native pickers and a bounded allowlist before sending data to Chromium.
use super::error;
use crate::core::error::PlatformResult;
use serde_json::{json,Value};

pub fn parse(bytes: &[u8]) -> PlatformResult<Value> {
    if bytes.len() > 5 * 1024 * 1024 { return Err(error("Cookie 文件超过 5 MiB 限制")); }
    let text = std::str::from_utf8(bytes).map_err(|_| error("Cookie 文件必须使用 UTF-8 编码"))?.trim_start_matches('\u{feff}');
    let raw: Vec<Value> = if text.trim_start().starts_with(['[','{']) {
        let value: Value = serde_json::from_str(text).map_err(|_| error("Cookie JSON 格式无效"))?;
        value.as_array().or_else(|| value["cookies"].as_array()).ok_or(error("Cookie JSON 必须包含数组"))?.clone()
    } else {
        let mut cookies = Vec::new();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') && !line.starts_with("#HttpOnly_") { continue; }
            let http_only = line.starts_with("#HttpOnly_");
            let line = line.strip_prefix("#HttpOnly_").unwrap_or(line);
            let parts: Vec<_> = line.split('\t').collect();
            if parts.len() != 7 { return Err(error("Cookie Netscape 格式无效，请使用 JSON 或标准七列文件")); }
            let expires = parts[4].parse::<i64>().map_err(|_| error("Cookie 有效期无效"))?;
            let mut value = json!({"domain":parts[0],"path":parts[2],"secure":parts[3].eq_ignore_ascii_case("TRUE"),"httpOnly":http_only,"name":parts[5],"value":parts[6]});
            if expires > 0 { value["expires"] = json!(expires); }
            cookies.push(value);
        }
        cookies
    };
    if raw.is_empty() || raw.len() > 10000 { return Err(error("Cookie 数量必须为 1～10000 条")); }
    let mut result = Vec::new();
    for source in raw {
        let name = source["name"].as_str().ok_or(error("Cookie 缺少名称"))?;
        let value = source["value"].as_str().ok_or(error("Cookie 缺少值"))?;
        if name.is_empty() || name.len() > 4096 || value.len() > 16384 || name.chars().any(|c| c.is_control() || "=;".contains(c)) || value.chars().any(char::is_control) {
            return Err(error("Cookie 名称或值格式无效"));
        }
        let mut cookie = json!({"name":name,"value":value});
        if let Some(domain) = source["domain"].as_str() {
            if domain.is_empty() || domain.len() > 253 || domain.chars().any(|c| !c.is_ascii_alphanumeric() && !".-:[]".contains(c)) { return Err(error("Cookie 域名无效")); }
            cookie["domain"] = json!(domain);
        } else if let Some(url) = source["url"].as_str() {
            let parsed = reqwest::Url::parse(url).map_err(|_| error("Cookie 网址无效"))?;
            if !matches!(parsed.scheme(),"http"|"https") || parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() { return Err(error("Cookie 网址无效")); }
            cookie["url"] = json!(url);
        } else { return Err(error("Cookie 必须指定域名或网址")); }
        let path = source["path"].as_str().unwrap_or("/");
        if !path.starts_with('/') || path.len() > 4096 || path.chars().any(char::is_control) { return Err(error("Cookie 路径无效")); }
        cookie["path"] = json!(path);
        for field in ["secure","httpOnly"] { if let Some(value) = source[field].as_bool() { cookie[field] = json!(value); } }
        if let Some(expires) = source.get("expires").or_else(|| source.get("expirationDate")).and_then(Value::as_f64) {
            if !expires.is_finite() || expires < -1.0 { return Err(error("Cookie 有效期无效")); }
            if expires > 0.0 { cookie["expires"] = json!(expires); }
        }
        if let Some(same_site) = source["sameSite"].as_str() {
            match same_site.to_ascii_lowercase().as_str() {
                "strict" => cookie["sameSite"] = json!("Strict"),
                "lax" => cookie["sameSite"] = json!("Lax"),
                "none" | "no_restriction" => cookie["sameSite"] = json!("None"),
                "unspecified" | "" => {},
                _ => return Err(error("Cookie SameSite 属性无效")),
            }
        }
        result.push(cookie);
    }
    Ok(Value::Array(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn allows_only_browser_cookie_fields() {
        let parsed = parse(br#"[{"name":"layout","value":"compact","domain":"example.test","command":"not-forwarded","sameSite":"lax"}]"#).unwrap();
        assert!(parsed[0].get("command").is_none()); assert_eq!(parsed[0]["sameSite"],json!("Lax"));
        let parsed = parse(b"# Netscape HTTP Cookie File\nexample.test\tFALSE\t/\tFALSE\t0\tlayout\tcompact").unwrap();
        assert_eq!(parsed[0]["name"],json!("layout"));
        assert!(parse(br#"[{"name":"layout","value":"compact","url":"file:///etc/passwd"}]"#).is_err());
    }
}
