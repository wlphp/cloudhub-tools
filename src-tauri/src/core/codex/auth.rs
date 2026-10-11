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
            label: "API Key 账号".into(),
            email: None,
            account_id: None,
            auth_mode: "apikey".into(),
            plan: None,
            auth_json,
        });
    }
    let tokens = value.get("tokens").unwrap_or(value);
    let access = text(tokens, "access_token", 32_768).ok_or("Codex 文件缺少有效的登录凭据")?;
    let id_token =
        text(tokens, "id_token", 32_768).ok_or("Codex 文件缺少账号身份信息，请重新登录后导入")?;
    let refresh = text(tokens, "refresh_token", 16_384)
        .ok_or("Codex 文件缺少可续期的登录凭据，请重新登录后导入")?;
    let id_claims = claims(&id_token);
    let access_claims = claims(&access);
    let auth_claims = id_claims
        .get("https://api.openai.com/auth")
        .or_else(|| access_claims.get("https://api.openai.com/auth"))
        .unwrap_or(&Value::Null);
    let account_id = text(tokens, "account_id", 512)
        .or_else(|| text(auth_claims, "chatgpt_account_id", 512))
        .ok_or("Codex 文件缺少账号标识")?;
    let user_id = text(auth_claims, "chatgpt_user_id", 512)
        .or_else(|| text(&id_claims, "sub", 512))
        .ok_or("Codex 文件缺少用户标识")?;
    let email = text(&id_claims, "email", 254).or_else(|| {
        id_claims
            .get("https://api.openai.com/profile")
            .and_then(|v| text(v, "email", 254))
    });
    let plan = text(auth_claims, "chatgpt_plan_type", 80);
    let identity = hex::encode(Sha256::digest(
        format!("chatgpt:{account_id}:{user_id}").as_bytes(),
    ));
    let mut auth = json!({"auth_mode":"chatgpt", "OPENAI_API_KEY":null, "tokens": {"access_token":access,"id_token":id_token,"refresh_token":refresh,"account_id":account_id}});
    if let Some(refreshed) = value.get("last_refresh").filter(|v| v.is_string()) {
        auth["last_refresh"] = refreshed.clone();
    }
    Ok(ImportedAccount {
        identity,
        label: email.clone().unwrap_or_else(|| "ChatGPT 账号".into()),
        email,
        account_id: Some(account_id),
        auth_mode: "chatgpt".into(),
        plan,
        auth_json: Zeroizing::new(auth.to_string()),
    })
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
    values.iter().map(parse_account).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
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
    fn rejects_partial_batches_and_oversize_without_echoing_input() {
        assert!(parse_import(&json!([oauth("a", "u"), {}]).to_string()).is_err());
        assert!(parse_import(&"x".repeat(2 * 1024 * 1024 + 1)).is_err());
        let error = parse_import("sensitive-invalid-json").err().unwrap();
        assert!(!error.contains("sensitive-invalid-json"));
    }
}
