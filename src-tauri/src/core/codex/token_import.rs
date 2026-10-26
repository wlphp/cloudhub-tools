use super::auth::{self, ImportedAccount};
use serde_json::{json, Value};
use zeroize::Zeroizing;

pub fn public_error(message: &str) -> &str {
    if ["请输入不超过 2 MB 的 Token 或 JSON", "输入的 JSON 格式无效，请检查后重试", "请输入单个 Token 或有效的账号 JSON",
        "请输入 Token 或有效的账号 JSON", "JSON 中未找到有效的 Token 凭据", "每次可导入 1 至 100 个账号",
        "仅有 Refresh Token 的账号请逐个导入，避免批量换取凭据时部分失败", "无法连接官方认证服务，请检查网络后重试",
        "Refresh Token 换取登录凭据失败，请确认 Token 有效或重新登录", "官方认证结果格式无效",
        "Codex 文件缺少有效的登录凭据", "Codex 文件缺少账号标识", "Codex 文件缺少用户标识",
        "API Key 凭据无效", "Codex 账号操作不可用", "查询 Codex 账号失败", "读取 Codex 账号失败",
        "加密 Codex 账号失败", "保存 Codex 账号失败", "保存 Codex 账号日志失败",
        "初始化官方认证连接失败", "读取官方认证结果失败", "官方认证结果超出大小限制",
        "强制导入仍需至少一个有效的 Token 字段",
        "Codex 实例状态不可用", "Codex 服务状态不可用", "Codex 唤醒状态不可用",
        "读取供应商 OAuth 归属失败",
        "无法打开本地账号数据库，请检查数据目录权限、数据库占用或客户端版本",
        "账号凭据已保存，但刷新账号列表失败，请重新打开账号页面查看",
        "导入账号正在被实例、API 服务或供应商使用，普通导入已取消；可停止相关服务后重试，或选择强制导入",
        "导入包含运行中实例的账号，请先停止实例，未保存任何账号"].contains(&message) { message }
    else { "导入失败，请检查凭据、网络或账号运行状态后重试" }
}

fn field(value: &Value, names: &[&str], max: usize) -> Option<String> {
    names.iter().find_map(|name| value.get(*name).and_then(Value::as_str)
        .map(str::trim).filter(|v| !v.is_empty() && v.len() <= max && !v.chars().any(char::is_control)).map(str::to_owned))
}

fn session_hint(value: &Value, keys: &[&str], max: usize) -> Option<String> {
    let session = value.get("session").unwrap_or(&Value::Null);
    let user = value.get("user").or_else(|| session.get("user")).unwrap_or(&Value::Null);
    let account = value.get("account").or_else(|| session.get("account")).unwrap_or(&Value::Null);
    [value, session, user, account].into_iter().find_map(|source| field(source, keys, max))
}

pub(super) fn normalize(value: &Value) -> Result<Value, String> {
    if let Some(raw) = value.as_str() {
        let raw = raw.trim().strip_prefix("Bearer ").unwrap_or(raw.trim());
        if raw.starts_with("rt-") || raw.starts_with("rt_") { return Ok(json!({"tokens":{"refresh_token":raw}})); }
        if raw.starts_with("sk-") { return Ok(json!({"OPENAI_API_KEY":raw})); }
        return Ok(json!({"tokens":{"access_token":raw}}));
    }
    if !value.is_object() { return Err("请输入 Token 或有效的账号 JSON".into()); }
    if value.get("OPENAI_API_KEY").is_some_and(Value::is_string) || value.get("openai_api_key").is_some_and(Value::is_string) {
        return Ok(value.clone());
    }
    let tokens = value.get("tokens").or_else(|| value.get("credentials")).or_else(|| value.get("session")).unwrap_or(value);
    if value.get("type").and_then(Value::as_str) == Some("apikey") {
        return Ok(json!({"OPENAI_API_KEY":field(tokens, &["api_key"], 16_384).ok_or("API Key 凭据无效")?}));
    }
    let session = value.get("session").unwrap_or(&Value::Null);
    let user = value.get("user").or_else(|| session.get("user")).unwrap_or(&Value::Null);
    let account = value.get("account").or_else(|| session.get("account")).unwrap_or(&Value::Null);
    let mut output = json!({"tokens":{}});
    for name in ["last_refresh", "account_name", "email", "note", "tags"] {
        if let Some(value) = value.get(name) { output[name] = value.clone(); }
    }
    let sources = [value, session, user, account];
    for (name, aliases, max) in [
        ("email", &["email", "emailAddress"][..], 254),
        ("account_name", &["account_name", "accountName", "alias"][..], 160),
    ] {
        if output.get(name).is_none_or(|current| !current.is_string() || current.as_str().is_none_or(str::is_empty)) {
            if let Some(hint) = sources.into_iter().find_map(|source| field(source, aliases, max)) { output[name] = Value::String(hint); }
        }
    }
    if let Some(user_name) = sources.into_iter().find_map(|source| field(source, &["name", "displayName", "username"], 160)) {
        output["session_user_name"] = Value::String(user_name);
    }
    if let Some(user_id) = user.get("id").and_then(Value::as_str)
        .or_else(|| user.get("user_id").and_then(Value::as_str))
        .or_else(|| user.get("userId").and_then(Value::as_str))
        .map(str::to_owned)
        .or_else(|| field(value, &["chatgpt_user_id", "user_id", "userId"], 512))
    {
        output["session_user_id"] = Value::String(user_id);
    }
    if let Some(account_id) = account.get("id").and_then(Value::as_str)
        .or_else(|| account.get("account_id").and_then(Value::as_str))
        .or_else(|| account.get("accountId").and_then(Value::as_str))
        .map(str::to_owned)
        .or_else(|| field(value, &["chatgpt_account_id", "account_id", "accountId"], 512))
        .filter(|v| !v.starts_with("user-"))
    {
        output["session_account_id"] = Value::String(account_id);
    }
    if let Some(provider) = sources.into_iter().find_map(|source| field(source, &["auth_provider", "authProvider", "login_provider", "loginProvider"], 80)) {
        output["session_auth_provider"] = Value::String(provider);
    }
    if let Some(plan) = sources.into_iter().find_map(|source| field(source, &["chatgpt_plan_type", "plan_type", "planType", "plan"], 80)) {
        output["session_plan"] = Value::String(plan);
    }
    if let Some(workspace) = sources.into_iter().find_map(|source| field(source, &["workspace_name", "workspaceName", "organization_name", "organizationName"], 160)) {
        output["session_workspace_name"] = Value::String(workspace);
    }
    if value.get("token_source_mode").and_then(Value::as_str) == Some("chatgpt_web_session")
        || value.get("user").is_some() || value.get("account").is_some() || value.get("session").is_some()
        || ((value.get("accessToken").is_some() || value.get("access_token").is_some())
            && ["user", "account", "expires", "sessionToken", "authProvider"].iter().any(|key| value.get(key).is_some())) {
        output["token_source_mode"] = json!("chatgpt_web_session");
    }
    let session_account_id = output.get("session_account_id").and_then(Value::as_str).filter(|v| !v.starts_with("user-")).map(str::to_owned);
    for (target, names, max) in [
        ("access_token", vec!["access_token", "accessToken"], 32_768),
        ("id_token", vec!["id_token", "idToken"], 32_768),
        ("refresh_token", vec!["refresh_token", "refreshToken"], 16_384),
        ("account_id", vec!["account_id", "accountId", "chatgpt_account_id"], 512),
    ] {
        let found = field(tokens, &names, max).or_else(|| {
            if target == "account_id" {
                account.get("id").and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty() && !v.starts_with("user-")).map(str::to_owned)
                    .or_else(|| field(account, &["account_id", "accountId", "chatgpt_account_id"], max).filter(|v| !v.starts_with("user-")))
                    .or_else(|| field(value, &["account_id", "accountId", "chatgpt_account_id"], max).filter(|v| !v.starts_with("user-")))
            } else {
                sources.into_iter().find_map(|source| field(source, &names, max))
            }
        });
        if let Some(text) = found {
            if target != "account_id" || !text.starts_with("user-") {
                output["tokens"][target] = Value::String(text);
            }
        }
    }
    if output.pointer("/tokens/account_id").is_none() {
        if let Some(account_id) = session_account_id.as_ref() { output["tokens"]["account_id"] = Value::String(account_id.clone()); }
    }
    if let Some(user_id) = output.get("session_user_id").and_then(Value::as_str) {
        output["tokens"]["session_user_id"] = Value::String(user_id.into());
    }
    if let Some(provider) = output.get("session_auth_provider").and_then(Value::as_str) {
        output["tokens"]["session_auth_provider"] = Value::String(provider.into());
    }
    if let Some(plan) = output.get("session_plan").and_then(Value::as_str) {
        output["tokens"]["session_plan"] = Value::String(plan.into());
    }
    if let Some(workspace) = output.get("session_workspace_name").and_then(Value::as_str) {
        output["tokens"]["session_workspace_name"] = Value::String(workspace.into());
    }
    if output["tokens"].as_object().is_none_or(|v| v.is_empty()) { return Err("JSON 中未找到有效的 Token 凭据".into()); }
    Ok(output)
}

fn refresh(value: &mut Value) -> Result<(), String> {
    if value.pointer("/tokens/access_token").is_some() { return Ok(()); }
    let Some(token) = field(&value["tokens"], &["refresh_token"], 16_384) else { return Ok(()); };
    let token = Zeroizing::new(token);
    let response = tauri::async_runtime::block_on(async {
        use std::time::Duration;
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(30)).build()
            .map_err(|_| "初始化官方认证连接失败")?;
        let mut response = client.post("https://auth.openai.com/oauth/token")
            .json(&json!({"client_id":"app_EMoamEEZ73f0CkXaXp7hrann","grant_type":"refresh_token","refresh_token":token.as_str()}))
            .send().await.map_err(|_| "无法连接官方认证服务，请检查网络后重试")?;
        if !response.status().is_success() { return Err("Refresh Token 换取登录凭据失败，请确认 Token 有效或重新登录"); }
        let mut bytes = Zeroizing::new(Vec::new());
        while let Some(chunk) = response.chunk().await.map_err(|_| "读取官方认证结果失败")? {
            if bytes.len() + chunk.len() > 128 * 1024 { return Err("官方认证结果超出大小限制"); }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice::<Value>(&bytes).map_err(|_| "官方认证结果格式无效")
    })?;
    for name in ["access_token", "id_token", "refresh_token"] {
        if let Some(token) = field(&response, &[name], 32_768) { value["tokens"][name] = Value::String(token); }
    }
    Ok(())
}

pub fn parse(content: &str) -> Result<Vec<ImportedAccount>, String> {
    parse_with_force(content, false)
}

pub fn parse_with_force(content: &str, force: bool) -> Result<Vec<ImportedAccount>, String> {
    if content.trim().is_empty() || content.len() > 2 * 1024 * 1024 { return Err("请输入不超过 2 MB 的 Token 或 JSON".into()); }
    let content = content.trim().trim_start_matches('﻿');
    let value: Value = if content.starts_with(['{', '[', '"']) {
        serde_json::from_str(content).map_err(|_| "输入的 JSON 格式无效，请检查后重试")?
    } else {
        if content.len() > 32_768 || content.chars().any(char::is_whitespace) && !content.starts_with("Bearer ") {
            return Err("请输入单个 Token 或有效的账号 JSON".into());
        }
        Value::String(content.into())
    };
    let values = value.as_array().or_else(|| value.get("accounts").and_then(Value::as_array));
    let values = values.map(Vec::as_slice).unwrap_or(std::slice::from_ref(&value));
    if values.is_empty() || values.len() > 100 { return Err("每次可导入 1 至 100 个账号".into()); }
    let mut normalized = values.iter().map(normalize).collect::<Result<Vec<_>, _>>()?;
    if !force && normalized.len() > 1 && normalized.iter().any(|v| v.pointer("/tokens/access_token").is_none() && v.pointer("/tokens/refresh_token").is_some()) {
        return Err("仅有 Refresh Token 的账号请逐个导入，避免批量换取凭据时部分失败".into());
    }
    let mut accounts = Vec::new();
    for value in &mut normalized {
        if !force { refresh(value)?; }
        accounts.push(match auth::parse_account(value) {
            Ok(account) => account,
            Err(_) if force => force_account(value)?,
            Err(message) => return Err(message),
        });
    }
    Ok(accounts)
}

// Preserve incomplete credentials without inventing claims used by the official runtime.
fn force_account(value: &Value) -> Result<ImportedAccount, String> {
    use sha2::{Digest, Sha256};
    let tokens = &value["tokens"];
    let credential = field(tokens, &["access_token", "refresh_token", "id_token"], 32_768)
        .ok_or("强制导入仍需至少一个有效的 Token 字段")?;
    let identity = format!("unverified:{}", hex::encode(Sha256::digest(credential.as_bytes())));
    let account_id = field(tokens, &["account_id"], 512);
    let email = field(value, &["email"], 254);
    Ok(ImportedAccount {
        identity, label: field(value, &["account_name"], 160)
            .or_else(|| email.clone()).unwrap_or_else(|| "待验证的导入账号".into()),
        email, account_id, auth_mode: "chatgpt".into(), plan: None,
        note: "强制导入：身份信息不完整，凭据是否可用需实际验证".into(), tags: vec![],
        auth_json: Zeroizing::new(value.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    fn access() -> String {
        format!("invalid.{}.invalid", URL_SAFE_NO_PAD.encode(json!({"sub":"test-user","exp":4102444800i64,"https://api.openai.com/auth":{"chatgpt_account_id":"test-account","chatgpt_user_id":"test-user"}}).to_string()))
    }
    #[test]
    fn imports_web_session_metadata_from_nested_objects() {
        let token = format!("invalid.{}.invalid", URL_SAFE_NO_PAD.encode(json!({
            "aud":"https://api.openai.com/v1", "scope":"model.request", "exp":4102444800i64,
        }).to_string()));
        let input = json!({
            "accessToken":token,
            "user":{"id":"fixture-user-id","email":"fixture@example.test","authProvider":"google"},
            "account":{"id":"fixture-account-id","planType":"plus","workspaceName":"Personal"},
        });
        let normalized = normalize(&input).unwrap();
        let account = auth::parse_account(&normalized).unwrap();
        assert_eq!(account.label, "fixture@example.test");
        assert_eq!(account.email.as_deref(), Some("fixture@example.test"));
        assert_eq!(account.account_id.as_deref(), Some("fixture-account-id"));
        assert_eq!(account.plan.as_deref(), Some("plus"));
        let metadata = auth::metadata(&account.auth_json).unwrap();
        assert!(metadata.is_web_session);
        assert_eq!(metadata.user_id.as_deref(), Some("fixture-user-id"));
        assert_eq!(metadata.login_provider.as_deref(), Some("google"));
        assert_eq!(metadata.workspace_name.as_deref(), Some("Personal"));
        let stored: Value = serde_json::from_str(&account.auth_json).unwrap();
        assert!(stored.get("user").is_none());
        assert!(stored.get("account").is_none());
    }
    #[test]
    fn prefers_email_over_personal_user_name_and_extracts_chatgpt_account_id() {
        let token = format!("invalid.{}.invalid", URL_SAFE_NO_PAD.encode(json!({
            "aud":"https://api.openai.com/v1",
            "scope":"model.request",
            "exp":4102444800i64,
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "fixture-org-uuid",
                "chatgpt_user_id": "user-fixture-user-id"
            },
            "https://api.openai.com/profile": {
                "email": "kenneth@example.test",
                "name": "Kenneth Wilson"
            }
        }).to_string()));
        let input = json!({
            "accessToken": token,
            "user": {
                "id": "user-fixture-user-id",
                "name": "Kenneth Wilson",
                "email": "kenneth@example.test",
                "authProvider": "openai"
            }
        });
        let normalized = normalize(&input).unwrap();
        let account = auth::parse_account(&normalized).unwrap();
        assert_eq!(account.label, "kenneth@example.test");
        assert_eq!(account.email.as_deref(), Some("kenneth@example.test"));
        assert_eq!(account.account_id.as_deref(), Some("fixture-org-uuid"));
    }
    #[test]
    fn accepts_access_session_and_nested_exports_with_stable_identity() {
        let token = access();
        let raw = parse(&token).unwrap().remove(0);
        for value in [json!({"accessToken":token}), json!({"accounts":[{"credentials":{"access_token":token}}]}), json!({"tokens":{"access_token":token,"refresh_token":"invalid","id_token":token}})] {
            assert_eq!(parse(&value.to_string()).unwrap()[0].identity, raw.identity);
        }
    }
    #[test]
    fn rejects_bad_batches_and_never_echoes_credentials() {
        for content in ["{private-invalid", "private-invalid", "[]"] {
            assert!(!parse(content).err().unwrap().contains("private-invalid"));
        }
        assert!(parse(&json!([{"accessToken":access()}, {}]).to_string()).is_err());
        assert!(parse(&"x".repeat(2 * 1024 * 1024 + 1)).is_err());
    }
    #[test]
    fn recognizes_refresh_token_prefixes_without_network_access() {
        for value in ["rt-invalid-fixture", "rt_invalid-fixture", "Bearer rt_invalid-fixture"] {
            let normalized = normalize(&Value::String(value.into())).unwrap();
            assert!(normalized.pointer("/tokens/refresh_token").is_some());
            assert!(normalized.pointer("/tokens/access_token").is_none());
        }
    }
    #[test]
    fn accepts_cpa_array_with_empty_refresh_and_profile_claims() {
        let token = format!("invalid.{}.invalid", URL_SAFE_NO_PAD.encode(json!({
            "aud":["https://api.openai.com/v1"], "scp":["model.request"],
            "sub":"fixture-subject", "exp":4102444800i64,
            "https://api.openai.com/auth":{"chatgpt_account_id":"fixture-account","chatgpt_user_id":"fixture-user","chatgpt_plan_type":"plus"},
            "https://api.openai.com/profile":{"email":"fixture@example.test"}
        }).to_string()));
        let input = json!([{"id_token":token,"access_token":token,"refresh_token":"",
            "account_id":"fixture-account","last_refresh":"2026-10-22T08:25:39.000Z","type":"codex"}]);
        for force in [false, true] {
            let accounts = parse_with_force(&input.to_string(), force).unwrap();
            assert_eq!(accounts[0].email.as_deref(), Some("fixture@example.test"));
            assert_eq!(accounts[0].plan.as_deref(), Some("plus"));
            assert!(accounts[0].auth_json.contains("last_refresh"));
        }
    }
    #[test]
    fn force_preserves_incomplete_tokens_without_network_or_fabricated_claims() {
        let input = json!({"access_token":"invalid-fixture","account_id":"fixture-account"}).to_string();
        assert_eq!(parse(&input).err().unwrap(), "Codex 文件缺少用户标识");
        let account = parse_with_force(&input, true).unwrap().remove(0);
        assert!(account.identity.starts_with("unverified:"));
        assert!(!account.auth_json.contains("chatgpt_user_id"));
        assert_eq!(account.identity, parse_with_force(&input, true).unwrap()[0].identity);
        let refresh_only = json!([{"refresh_token":"rt-invalid-fixture-a"},{"refresh_token":"rt-invalid-fixture-b"}]);
        assert_eq!(parse_with_force(&refresh_only.to_string(), true).unwrap().len(), 2);
        for input in ["{invalid", "[]", "{}", r#"{"account_id":"fixture-account"}"#] {
            assert!(parse_with_force(input, true).is_err());
        }
        assert!(!public_error("untrusted upstream credential").contains("untrusted"));
        assert_eq!(public_error("保存 Codex 账号失败"), "保存 Codex 账号失败");
    }
}
