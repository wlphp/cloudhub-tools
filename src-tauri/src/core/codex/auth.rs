use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

// Never serialize this internal credential-bearing type across the command boundary.
pub struct ImportedAccount {
    pub identity: String,
    pub label: String,
    pub email: Option<String>,
    pub account_id: Option<String>,
    pub auth_mode: String,
    pub plan: Option<String>,
    pub note: String,
    pub tags: Vec<String>,
    pub auth_json: Zeroizing<String>,
}

fn text(value: &Value, key: &str, max: usize) -> Option<String> {
    value
        .get(key)?
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= max && !v.chars().any(char::is_control))
        .map(str::to_owned)
}

fn claims(token: &str) -> Value {
    // Unverified JWT claims are display hints only; authentication is left to the official CLI.
    token
        .split('.')
        .nth(1)
        .filter(|s| s.len() <= 32_768)
        .and_then(|s| URL_SAFE_NO_PAD.decode(s).ok())
        .and_then(|s| serde_json::from_slice(&s).ok())
        .unwrap_or(Value::Null)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthMetadata {
    pub is_web_session: bool,
    pub login_provider: Option<String>,
    pub workspace_name: Option<String>,
    pub user_id: Option<String>,
    pub access_expires_at: Option<i64>,
    pub refresh_expires_at: Option<i64>,
    pub id_expires_at: Option<i64>,
    pub has_refresh_token: bool,
}

// JWT values are unverified display hints; this never returns credentials.
pub fn metadata(content: &str) -> Result<AuthMetadata, String> {
    let value: Value = serde_json::from_str(content).map_err(|_| "Codex 认证数据无效")?;
    let access = claims(value.pointer("/tokens/access_token").and_then(Value::as_str).unwrap_or(""));
    let refresh = claims(value.pointer("/tokens/refresh_token").and_then(Value::as_str).unwrap_or(""));
    let id = claims(value.pointer("/tokens/id_token").and_then(Value::as_str).unwrap_or(""));
    let expires = |value: &Value| value.get("exp").and_then(Value::as_i64).filter(|v| *v > 0 && *v <= 253402300799);
    let user_id = text(&value, "session_user_id", 512)
        .or_else(|| value.pointer("/tokens/session_user_id").and_then(Value::as_str).filter(|v| !v.is_empty() && v.len() <= 512 && !v.chars().any(char::is_control)).map(str::to_owned))
        .or_else(|| value.get("user").and_then(|item| text(item, "id", 512).or_else(|| text(item, "user_id", 512))))
        .or_else(|| [id.get("https://api.openai.com/auth"), access.get("https://api.openai.com/auth")]
            .into_iter().flatten().find_map(|v| text(v, "chatgpt_user_id", 512).or_else(|| text(v, "user_id", 512))))
        .or_else(|| text(&id, "sub", 512)).or_else(|| text(&access, "sub", 512));
    let login_provider = text(&value, "session_auth_provider", 80)
        .or_else(|| value.pointer("/tokens/session_auth_provider").and_then(Value::as_str).filter(|v| !v.is_empty() && v.len() <= 80 && !v.chars().any(char::is_control)).map(str::to_owned))
        .or_else(|| value.get("user").and_then(|item| text(item, "authProvider", 80).or_else(|| text(item, "auth_provider", 80))))
        .or_else(|| text(&id, "auth_provider", 80)).or_else(|| text(&access, "auth_provider", 80));
    let account_id = access.pointer("/https:~1~1api.openai.com~1auth/chatgpt_account_id").and_then(Value::as_str).map(str::to_owned)
        .or_else(|| id.pointer("/https:~1~1api.openai.com~1auth/chatgpt_account_id").and_then(Value::as_str).map(str::to_owned))
        .or_else(|| text(&value, "session_account_id", 512).filter(|v| !v.starts_with("user-")))
        .or_else(|| value.pointer("/tokens/session_account_id").and_then(Value::as_str).filter(|v| !v.is_empty() && v.len() <= 512 && !v.starts_with("user-") && !v.chars().any(char::is_control)).map(str::to_owned))
        .or_else(|| value.pointer("/tokens/account_id").and_then(Value::as_str).filter(|v| !v.is_empty() && v.len() <= 512 && !v.starts_with("user-") && !v.chars().any(char::is_control)).map(str::to_owned))
        .or_else(|| value.get("account").and_then(|item| text(item, "id", 512)).filter(|v| !v.starts_with("user-")));
    let workspace_name = text(&value, "session_workspace_name", 160)
        .or_else(|| value.pointer("/tokens/session_workspace_name").and_then(Value::as_str).filter(|v| !v.is_empty() && v.len() <= 160 && !v.chars().any(char::is_control)).map(str::to_owned))
        .or_else(|| value.get("account").and_then(|item| text(item, "workspaceName", 160).or_else(|| text(item, "workspace_name", 160))))
        .or_else(|| id.pointer("/https:~1~1api.openai.com~1auth/organizations").and_then(Value::as_array)
            .and_then(|items| items.iter().find(|item| account_id.as_ref().is_some_and(|account| item.get("id").and_then(Value::as_str) == Some(account.as_str())))
                .or_else(|| items.iter().find(|item| item.get("is_default").and_then(Value::as_bool) == Some(true))).or_else(|| items.first()))
            .and_then(|item| text(item, "title", 160).or_else(|| text(item, "name", 160))));
    let _email = text(&id, "email", 254)
        .or_else(|| text(&access, "email", 254))
        .or_else(|| id.get("https://api.openai.com/profile").and_then(|v| text(v, "email", 254)))
        .or_else(|| access.get("https://api.openai.com/profile").and_then(|v| text(v, "email", 254)))
        .or_else(|| value.pointer("/tokens/email").and_then(Value::as_str).filter(|v| !v.is_empty() && v.len() <= 254 && !v.chars().any(char::is_control)).map(str::to_owned))
        .or_else(|| value.get("email").and_then(Value::as_str).filter(|v| !v.is_empty() && v.len() <= 254 && !v.chars().any(char::is_control)).map(str::to_owned));
    let _plan = text(&value, "session_plan", 80)
        .or_else(|| value.pointer("/tokens/session_plan").and_then(Value::as_str).filter(|v| !v.is_empty() && v.len() <= 80 && !v.chars().any(char::is_control)).map(str::to_owned))
        .or_else(|| id.pointer("/https:~1~1api.openai.com~1auth/chatgpt_plan_type").and_then(Value::as_str).map(str::to_owned))
        .or_else(|| access.pointer("/https:~1~1api.openai.com~1auth/chatgpt_plan_type").and_then(Value::as_str).map(str::to_owned));
    Ok(AuthMetadata { is_web_session: web_session(&value), login_provider, workspace_name, user_id, access_expires_at: expires(&access), refresh_expires_at: expires(&refresh), id_expires_at: expires(&id),
        has_refresh_token: value.pointer("/tokens/refresh_token").and_then(Value::as_str).is_some_and(|v| !v.is_empty()) })
}

fn web_session(value: &Value) -> bool {
    if value.get("token_source_mode").and_then(Value::as_str) == Some("chatgpt_web_session") { return true; }
    if let Some(session)=value.get("session") {
        if session.is_object() && (session.get("accessToken").is_some() || session.get("access_token").is_some()
            || session.get("sessionToken").is_some() || session.get("user").is_some() || session.get("account").is_some()) { return true; }
    }
    let token = value.pointer("/tokens/access_token").or_else(|| value.get("accessToken")).or_else(|| value.get("access_token")).and_then(Value::as_str).unwrap_or("");
    let payload = claims(token);
    let scopes = payload.get("scope").and_then(Value::as_str).unwrap_or("");
    // Existing imports lost their session wrapper. Identify the web audience only,
    // never infer a web session merely from an absent refresh token.
    payload.get("aud").is_some_and(|aud| aud.as_str() == Some("https://api.openai.com/v1") || aud.as_array().is_some_and(|items| items.iter().any(|v| v.as_str() == Some("https://api.openai.com/v1"))))
        && scopes.split_whitespace().any(|scope| scope == "model.request")
}

pub fn ensure_runtime_auth(content: &str) -> Result<(), String> {
    if metadata(content)?.is_web_session { return Err("Web Session 账号仅支持查看额度，无法切换、启动或用于 API 服务，请重新授权".into()); }
    Ok(())
}

pub fn access_expiring(auth_json: &str) -> bool {
    let value: Value = match serde_json::from_str(auth_json) {
        Ok(value) => value,
        Err(_) => return true,
    };
    let Some(token) = value
        .pointer("/tokens/access_token")
        .and_then(Value::as_str)
    else {
        return true;
    };
    claims(token)
        .get("exp")
        .and_then(Value::as_i64)
        .is_none_or(|expiration| expiration <= chrono::Utc::now().timestamp() + 60)
}

pub fn parse_account(value: &Value) -> Result<ImportedAccount, String> {
    if !value.is_object() {
        return Err("Codex 认证文件格式无效".into());
    }
    if let Some(key) =
        text(value, "OPENAI_API_KEY", 16_384).or_else(|| text(value, "openai_api_key", 16_384))
    {
        let identity = format!("apikey:{}", hex::encode(Sha256::digest(key.as_bytes())));
        let auth_json =
            Zeroizing::new(json!({"auth_mode":"apikey", "OPENAI_API_KEY":key}).to_string());
        return Ok(ImportedAccount {
            identity,
            label: text(value, "account_name", 160).unwrap_or_else(|| "API Key 账号".into()),
            email: None,
            account_id: None,
            auth_mode: "apikey".into(),
            plan: None,
            note: text(value, "note", 4000).unwrap_or_default(),
            tags: import_tags(value),
            auth_json,
        });
    }
    let tokens = value.get("tokens").unwrap_or(value);
    let access = text(tokens, "access_token", 32_768).ok_or("Codex 文件缺少有效的登录凭据")?;
    let id_token = text(tokens, "id_token", 32_768).unwrap_or_default();
    let refresh = text(tokens, "refresh_token", 16_384).unwrap_or_default();
    let id_claims = claims(&id_token);
    let access_claims = claims(&access);
    let auth_claims = id_claims
        .get("https://api.openai.com/auth")
        .or_else(|| access_claims.get("https://api.openai.com/auth"))
        .unwrap_or(&Value::Null);
    let account_id = text(auth_claims, "chatgpt_account_id", 512)
        .or_else(|| text(tokens, "account_id", 512).filter(|id| !id.starts_with("user-")))
        .or_else(|| text(tokens, "session_account_id", 512).filter(|id| !id.starts_with("user-")))
        .or_else(|| text(value, "session_account_id", 512).filter(|id| !id.starts_with("user-")))
        .or_else(|| value.get("account").and_then(|account| text(account, "id", 512).or_else(|| text(account, "account_id", 512)).or_else(|| text(account, "accountId", 512))).filter(|id| !id.starts_with("user-")))
        .or_else(|| text(tokens, "account_id", 512))
        .ok_or("Codex 文件缺少账号标识")?;
    let user_id = text(auth_claims, "chatgpt_user_id", 512)
        .or_else(|| text(tokens, "session_user_id", 512))
        .or_else(|| text(value, "session_user_id", 512))
        .or_else(|| value.get("user").and_then(|user| text(user, "id", 512).or_else(|| text(user, "user_id", 512))))
        .or_else(|| text(&id_claims, "sub", 512))
        .or_else(|| text(&access_claims, "sub", 512))
        .ok_or("Codex 文件缺少用户标识")?;
    let email = text(&id_claims, "email", 254)
        .or_else(|| text(&access_claims, "email", 254))
        .or_else(|| id_claims.get("https://api.openai.com/profile").and_then(|v| text(v, "email", 254)))
        .or_else(|| access_claims.get("https://api.openai.com/profile").and_then(|v| text(v, "email", 254)))
        .or_else(|| text(value, "email", 254))
        .or_else(|| value.get("user").and_then(|user| text(user, "email", 254)))
        .or_else(|| value.get("account").and_then(|user| text(user, "email", 254)));
    let plan = text(auth_claims, "chatgpt_plan_type", 80)
        .or_else(|| text(value, "session_plan", 80))
        .or_else(|| text(tokens, "session_plan", 80))
        .or_else(|| value.get("account").and_then(|account| text(account, "plan", 80).or_else(|| text(account, "planType", 80))));
    let identity = hex::encode(Sha256::digest(
        format!("chatgpt:{account_id}:{user_id}").as_bytes(),
    ));
    let mut auth = json!({"auth_mode":"chatgpt", "OPENAI_API_KEY":null, "tokens": {"access_token":access,"id_token":id_token,"refresh_token":refresh,"account_id":account_id}});
    for name in ["session_user_id", "session_auth_provider", "session_workspace_name", "session_plan"] {
        let display_hint = value.get(name).or_else(|| tokens.get(name))
            .filter(|v| v.as_str().is_some_and(|text| !text.is_empty() && text.len() <= 512 && !text.chars().any(char::is_control)));
        if let Some(hint) = display_hint { auth[name] = hint.clone(); }
    }
    auth["session_account_id"] = json!(account_id);
    if web_session(value) { auth["token_source_mode"] = json!("chatgpt_web_session"); }
    if let Some(refreshed) = value.get("last_refresh").filter(|v| v.is_string()) {
        auth["last_refresh"] = refreshed.clone();
    }
    Ok(ImportedAccount {
        identity,
        label: text(value, "account_name", 160)
            .or_else(|| email.clone())
            .unwrap_or_else(|| "ChatGPT 账号".into()),
        email,
        account_id: Some(account_id),
        auth_mode: "chatgpt".into(),
        plan,
        note: text(value, "note", 4000).unwrap_or_default(),
        tags: import_tags(value),
        auth_json: Zeroizing::new(auth.to_string()),
    })
}

fn import_tags(value: &Value) -> Vec<String> {
    value.get("tags").and_then(Value::as_array).into_iter().flatten()
        .filter_map(Value::as_str)
        .filter(|tag| !tag.chars().any(char::is_control))
        .map(str::trim)
        .filter(|tag| !tag.is_empty() && tag.len() <= 80)
        .take(32).map(str::to_owned).collect()
}

pub fn parse_import(content: &str) -> Result<Vec<ImportedAccount>, String> {
    if content.is_empty() || content.len() > 2 * 1024 * 1024 {
        return Err("请选择不超过 2 MB 的非空 Codex JSON 文件".into());
    }
    let value: Value = serde_json::from_str(content).map_err(|_| "Codex 导入文件不是有效 JSON")?;
    let candidates = value
        .as_array()
        .or_else(|| value.get("accounts").and_then(Value::as_array));
    let values = candidates
        .map(|v| v.as_slice())
        .unwrap_or(std::slice::from_ref(&value));
    if values.is_empty() || values.len() > 100 {
        return Err("每次可导入 1 至 100 个 Codex 账号".into());
    }
    values.iter().map(|entry| {
        if entry.get("user").is_some() || entry.get("account").is_some() || entry.get("session").is_some() {
            let normalized = super::token_import::normalize(entry)?;
            parse_account(&normalized)
        } else {
            parse_account(entry)
        }
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_only_exposes_bounded_identity_and_expiry_hints() {
        let payload = URL_SAFE_NO_PAD.encode(json!({"sub":"user-display","exp":1893456000,"auth_provider":"google","https://api.openai.com/auth":{"organizations":[{"title":"测试工作区","is_default":true}]}}).to_string());
        let token = format!("invalid.{payload}.invalid");
        let output = metadata(&json!({"tokens":{"access_token":token,"id_token":token,"refresh_token":token}}).to_string()).unwrap();
        assert_eq!(output.user_id.as_deref(), Some("user-display"));
        assert_eq!(output.login_provider.as_deref(), Some("google"));
        assert_eq!(output.workspace_name.as_deref(), Some("测试工作区"));
        assert_eq!(output.access_expires_at, Some(1893456000));
        assert_eq!(output.refresh_expires_at, Some(1893456000));
        let serialized = serde_json::to_string(&output).unwrap();
        assert!(!serialized.contains(&token));
        assert!(!serialized.contains("invalid-fixture"));
        assert!(metadata("{}").unwrap().access_expires_at.is_none());
        assert!(metadata("{}").unwrap().refresh_expires_at.is_none());
        assert!(!metadata("{}").unwrap().has_refresh_token);
    }
    fn oauth(account: &str, user: &str) -> Value {
        let payload = URL_SAFE_NO_PAD.encode(json!({"sub":user,"email":"test@example.test","https://api.openai.com/auth":{"chatgpt_account_id":account,"chatgpt_user_id":user,"chatgpt_plan_type":"plus"}}).to_string());
        // Deliberately invalid synthetic credential assembled only for parser tests.
        let token = format!("invalid.{payload}.invalid");
        json!({"tokens":{"id_token":token,"access_token":"invalid", "refresh_token":"invalid", "account_id":account}})
    }
    #[test]
    fn distinguishes_organizations_and_users() {
        let a = parse_account(&oauth("org-a", "user-a")).unwrap();
        assert_ne!(
            a.identity,
            parse_account(&oauth("org-b", "user-a")).unwrap().identity
        );
        assert_ne!(
            a.identity,
            parse_account(&oauth("org-a", "user-b")).unwrap().identity
        );
        assert_eq!(a.email.as_deref(), Some("test@example.test"));
    }
    #[test]
    fn imports_cockpit_tools_display_metadata_with_safe_bounds() {
        let mut value = oauth("org-a", "user-a");
        value["account_name"] = json!("工作账号");
        value["note"] = json!("日常使用");
        value["tags"] = json!(["主力", "测试", "\nignored"]);
        let account = parse_account(&value).unwrap();
        assert_eq!(account.label, "工作账号");
        assert_eq!(account.note, "日常使用");
        assert_eq!(account.tags, vec!["主力", "测试"]);
    }
    #[test]
    fn rejects_partial_batches_and_oversize_without_echoing_input() {
        assert!(parse_import(&json!([oauth("a", "u"), {}]).to_string()).is_err());
        assert!(parse_import(&"x".repeat(2 * 1024 * 1024 + 1)).is_err());
        let error = parse_import("sensitive-invalid-json").err().unwrap();
        assert!(!error.contains("sensitive-invalid-json"));
    }
}
