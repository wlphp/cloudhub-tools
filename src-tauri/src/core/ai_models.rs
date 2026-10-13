use crate::core::repositories::ai::{endpoint, Profile};
use serde_json::Value;

pub fn catalog_url(profile: &Profile) -> Result<reqwest::Url, String> {
    let mut url = endpoint(
        &profile.base_url,
        &profile.protocol,
        &profile.model,
        profile.allow_loopback_http,
    )?;
    let prefix = match profile.protocol.as_str() {
        "openai_chat" => url.path().strip_suffix("/chat/completions"),
        "openai_responses" => url.path().strip_suffix("/responses"),
        "claude" => url.path().strip_suffix("/messages"),
        _ => url.path().rsplit_once("/models/").map(|(prefix, _)| prefix),
    }
    .ok_or("AI服务地址无效")?
    .to_string();
    url.set_path(&format!("{prefix}/models"));
    if profile.protocol == "gemini" {
        url.set_query(Some("pageSize=100"));
    }
    Ok(url)
}
pub fn parse(protocol: &str, value: &Value, key: &str) -> Result<Vec<String>, String> {
    let rows = value
        .get(if protocol == "gemini" {
            "models"
        } else {
            "data"
        })
        .and_then(Value::as_array)
        .ok_or("服务模型目录格式不兼容，可直接填写模型名称")?;
    let mut models = Vec::new();
    for row in rows.iter().take(2000) {
        if protocol == "gemini"
            && row
                .get("supportedGenerationMethods")
                .and_then(Value::as_array)
                .is_some_and(|methods| {
                    !methods
                        .iter()
                        .any(|v| v.as_str() == Some("generateContent"))
                })
        {
            continue;
        }
        let name = row
            .get(if protocol == "gemini" { "name" } else { "id" })
            .and_then(Value::as_str)
            .unwrap_or_default();
        let name = if protocol == "gemini" {
            name.strip_prefix("models/").unwrap_or(name)
        } else {
            name
        };
        if name.is_empty()
            || name.len() > 160
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.:/".contains(c))
            || name.split('/').any(|part|part.is_empty() || part=="." || part=="..")
            || (protocol=="gemini" && name.contains('/'))
            || (!key.is_empty() && name.contains(key))
        {
            continue;
        }
        models.push(name.to_string());
    }
    models.sort();
    models.dedup();
    models.truncate(200);
    if models.is_empty() {
        return Err("服务未返回可用模型名称，可直接填写".into());
    }
    Ok(models)
}
pub async fn query(profile: &Profile, key: &str) -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(profile.timeout_seconds))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "初始化AI连接失败")?;
    let builder = client.get(catalog_url(profile)?);
    let builder = match profile.protocol.as_str() {
        "claude" => builder
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01"),
        "gemini" => builder.header("x-goog-api-key", key),
        _ => builder.bearer_auth(key),
    };
    let mut response = builder
        .send()
        .await
        .map_err(|_| "查询AI模型失败，请检查服务和网络")?;
    if !response.status().is_success() {
        return Err("服务不支持模型查询或认证失败，可直接填写模型名称".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取AI模型目录失败")? {
        if bytes.len() + chunk.len() > 1_048_576 {
            return Err("AI模型目录超过大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "服务模型目录格式不兼容，可直接填写模型名称")?;
    parse(&profile.protocol, &value, key)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn catalog_filters_non_generation_models_and_secrets() {
        assert_eq!(parse("gemini",&json!({"models":[{"name":"models/fixture-chat","supportedGenerationMethods":["generateContent"]},{"name":"models/fixture-embedding","supportedGenerationMethods":["embedContent"]}]}),"").unwrap(),vec!["fixture-chat"]);
        assert_eq!(parse("openai_chat",&json!({"data":[{"id":"fixture-chat"},{"id":"fixture-chat"},{"id":"test-only-echoed-key"},{"id":"../invalid"}]}),"test-only-echoed-key").unwrap(),vec!["fixture-chat"]);
    }
}
