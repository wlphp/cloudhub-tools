use super::codex::AUTH_WRITER;
use crate::core::{
    codex::{auth, profile},
    error::PlatformResult,
    repositories::codex_accounts as repository,
    storage::open_db,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use std::io::Write;
use tauri_plugin_dialog::DialogExt;
use zeroize::{Zeroize, Zeroizing};
use zip::{write::SimpleFileOptions, ZipWriter};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CodexExportFormat {
    CockpitTools,
    AuthJson,
    Sub2Api,
    Cpa,
}

impl CodexExportFormat {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "cockpit_tools" => Ok(Self::CockpitTools),
            "auth_json" => Ok(Self::AuthJson),
            "sub2api" => Ok(Self::Sub2Api),
            "cpa" => Ok(Self::Cpa),
            _ => Err("Codex 导出格式无效".into()),
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::CockpitTools => "Cockpit Tools",
            Self::AuthJson => "官方 auth.json",
            Self::Sub2Api => "Sub2API",
            Self::Cpa => "CPA",
        }
    }
    fn multi_file(self) -> bool {
        matches!(self, Self::AuthJson | Self::Cpa)
    }
}

enum ExportFile {
    Json(Zeroizing<String>),
    Zip(Zeroizing<Vec<u8>>),
}

const SUB2API_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";

#[cfg(test)]
fn plain_accounts(auths: &[Zeroizing<String>]) -> Result<Zeroizing<String>, String> {
    if auths.is_empty() || auths.len() > 100 {
        return Err("请选择 1 至 100 个账号导出".into());
    }
    let mut encoded = Zeroizing::new(String::new());
    if auths.len() > 1 {
        encoded.push('[');
    }
    for (index, auth) in auths.iter().enumerate() {
        let parsed = auth::parse_import(auth)?;
        if parsed.len() != 1 {
            return Err("导出账号认证格式无效".into());
        }
        if index > 0 {
            encoded.push(',');
        }
        encoded.push_str(&parsed[0].auth_json);
        if encoded.len() > 2 * 1024 * 1024 {
            return Err("账号导出文件超出大小限制".into());
        }
    }
    if auths.len() > 1 {
        encoded.push(']');
    }
    if encoded.len() > 2 * 1024 * 1024 {
        return Err("账号导出文件超出大小限制".into());
    }
    Ok(encoded)
}

fn read_object(auth: &str) -> Result<serde_json::Value, String> {
    let parsed = auth::parse_import(auth)?;
    if parsed.len() != 1 {
        return Err("导出账号认证格式无效".into());
    }
    serde_json::from_str(&parsed[0].auth_json).map_err(|_| "导出账号认证格式无效".into())
}

fn iso_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn access_expiry(access_token: &str) -> Option<i64> {
    let payload = access_token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    value.get("exp")?.as_i64()
}

fn expiry_iso(access_token: &str) -> String {
    access_expiry(access_token)
        .and_then(|ts| chrono::DateTime::<chrono::Utc>::from_timestamp(ts, 0))
        .map(|date| date.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_default()
}

fn export_account(
    auth: &str,
    account: &crate::core::codex::CodexAccountSummary,
    format: CodexExportFormat,
) -> Result<serde_json::Value, String> {
    use serde_json::{json, Map, Value};
    let source = read_object(auth)?;
    let api_key = source.get("OPENAI_API_KEY").and_then(Value::as_str);
    let tokens = source.get("tokens").cloned().unwrap_or(Value::Null);
    let access = tokens
        .get("access_token")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let id_token = tokens
        .get("id_token")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let refresh = tokens
        .get("refresh_token")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let account_id = tokens
        .get("account_id")
        .and_then(Value::as_str)
        .or(account.account_id.as_deref())
        .unwrap_or_default();
    let last_refresh = source
        .get("last_refresh")
        .and_then(Value::as_str)
        .unwrap_or("");
    let email = account.email.as_deref().unwrap_or_default();
    let is_api_key = account.auth_mode == "apikey" || api_key.is_some();
    match format {
        CodexExportFormat::CockpitTools => {
            let mut result = if is_api_key {
                json!({"auth_mode":"apikey", "OPENAI_API_KEY":api_key.unwrap_or_default(), "email":email, "type":"codex"})
            } else {
                json!({"id_token":id_token, "access_token":access, "refresh_token":refresh, "account_id":account_id, "last_refresh":if last_refresh.is_empty(){iso_now()}else{last_refresh.to_owned()}, "email":email, "type":"codex", "expired":expiry_iso(access)})
            };
            if let Some(obj) = result.as_object_mut() {
                obj.insert("account_name".into(), Value::String(account.label.clone()));
                obj.insert("note".into(), Value::String(account.note.clone()));
                obj.insert(
                    "tags".into(),
                    serde_json::to_value(&account.tags).unwrap_or(Value::Array(vec![])),
                );
            }
            Ok(result)
        }
        CodexExportFormat::AuthJson => {
            if is_api_key {
                let key = api_key.ok_or("官方 auth.json 导出缺少 API Key")?;
                Ok(json!({"auth_mode":"apikey", "OPENAI_API_KEY":key}))
            } else {
                if access.is_empty() {
                    return Err("官方 auth.json 导出缺少 access_token".into());
                }
                Ok(
                    json!({"OPENAI_API_KEY":Value::Null, "tokens":{"id_token":id_token,"access_token":access,"refresh_token":refresh,"account_id":account_id},"last_refresh":if last_refresh.is_empty(){iso_now()}else{last_refresh.to_owned()},"type":"codex"}),
                )
            }
        }
        CodexExportFormat::Cpa => {
            if is_api_key {
                return Err("CPA 格式不支持 API Key 账号".into());
            }
            if access.is_empty() {
                return Err("CPA 格式导出缺少 access_token".into());
            }
            Ok(
                json!({"id_token":id_token,"access_token":access,"refresh_token":refresh,"account_id":account_id,"last_refresh":if last_refresh.is_empty(){iso_now()}else{last_refresh.to_owned()},"email":email,"type":"codex","expired":expiry_iso(access)}),
            )
        }
        CodexExportFormat::Sub2Api => {
            let credentials = if is_api_key {
                let key = api_key.ok_or("Sub2API 格式导出缺少 API Key")?;
                json!({"base_url":"https://api.openai.com","api_key":key})
            } else {
                if access.is_empty() {
                    return Err("Sub2API 格式导出缺少 access_token".into());
                }
                let mut credentials = Map::new();
                credentials.insert("access_token".into(), Value::String(access.into()));
                if !refresh.is_empty() {
                    credentials.insert("refresh_token".into(), Value::String(refresh.into()));
                    credentials.insert("client_id".into(), Value::String(SUB2API_CLIENT_ID.into()));
                }
                if !id_token.is_empty() {
                    credentials.insert("id_token".into(), Value::String(id_token.into()));
                }
                let expires_iso = expiry_iso(access);
                if !expires_iso.is_empty() {
                    credentials.insert("expires_at".into(), Value::String(expires_iso));
                }
                if !email.is_empty() {
                    credentials.insert("email".into(), Value::String(email.into()));
                }
                if !account_id.is_empty() {
                    credentials.insert(
                        "chatgpt_account_id".into(),
                        Value::String(account_id.into()),
                    );
                }
                Value::Object(credentials)
            };
            let mut item = json!({"name":if account.label.is_empty(){email}else{&account.label},"platform":"openai","type":if is_api_key{"apikey"}else{"oauth"},"credentials":credentials,"concurrency":3,"priority":50});
            if !is_api_key && refresh.is_empty() {
                let expires_at =
                    access_expiry(access).ok_or("Sub2API 导出缺少 access_token 有效期")?;
                item["expires_at"] = Value::from(expires_at);
                item["auto_pause_on_expired"] = Value::Bool(true);
            }
            Ok(item)
        }
    }
}

fn safe_file_part(value: &str, fallback: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|ch| {
            if ch.is_control() || "<>:\"/\\|?*".contains(ch) {
                '_'
            } else {
                ch
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim();
    if cleaned.is_empty() {
        fallback.into()
    } else {
        cleaned.chars().take(100).collect()
    }
}

fn build_export_file(
    auths: &[Zeroizing<String>],
    accounts: &[crate::core::codex::CodexAccountSummary],
    format: CodexExportFormat,
) -> Result<ExportFile, String> {
    if auths.is_empty() || auths.len() != accounts.len() || auths.len() > 100 {
        return Err("请选择 1 至 100 个有效账号导出".into());
    }
    let values = auths
        .iter()
        .zip(accounts)
        .map(|(auth, account)| export_account(auth, account, format))
        .collect::<Result<Vec<_>, _>>()?;
    if format == CodexExportFormat::Sub2Api {
        let payload = serde_json::json!({"exported_at":iso_now(),"proxies":[],"accounts":values,"type":"sub2api-data","version":1});
        let encoded = Zeroizing::new(
            serde_json::to_string_pretty(&payload).map_err(|_| "序列化 Sub2API 文件失败")?,
        );
        if encoded.len() > 2 * 1024 * 1024 {
            return Err("账号导出文件超出大小限制".into());
        }
        return Ok(ExportFile::Json(encoded));
    }
    if format.multi_file() && values.len() > 1 {
        let cursor = std::io::Cursor::new(Vec::new());
        let mut archive = ZipWriter::new(cursor);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (index, (value, account)) in values.iter().zip(accounts).enumerate() {
            let name = safe_file_part(
                account.email.as_deref().unwrap_or(&account.label),
                &format!("account_{}", index + 1),
            );
            let filename = format!("{:02}_{}.json", index + 1, name);
            archive
                .start_file(filename, options)
                .map_err(|_| "创建账号导出压缩包失败")?;
            archive
                .write_all(
                    serde_json::to_string_pretty(value)
                        .map_err(|_| "序列化账号导出失败")?
                        .as_bytes(),
                )
                .map_err(|_| "写入账号导出压缩包失败")?;
        }
        let mut bytes = archive
            .finish()
            .map_err(|_| "完成账号导出压缩包失败")?
            .into_inner();
        if bytes.len() > 4 * 1024 * 1024 {
            bytes.zeroize();
            return Err("账号导出文件超出大小限制".into());
        }
        return Ok(ExportFile::Zip(Zeroizing::new(bytes)));
    }
    let payload = if values.len() == 1 {
        values.into_iter().next().unwrap()
    } else {
        serde_json::Value::Array(values)
    };
    let encoded =
        Zeroizing::new(serde_json::to_string_pretty(&payload).map_err(|_| "序列化账号导出失败")?);
    if encoded.len() > 2 * 1024 * 1024 {
        return Err("账号导出文件超出大小限制".into());
    }
    Ok(ExportFile::Json(encoded))
}

#[tauri::command]
pub(crate) async fn codex_export_accounts_file(
    app: tauri::AppHandle,
    account_id: Option<i64>,
    account_ids: Option<Vec<i64>>,
    format: String,
) -> PlatformResult<bool> {
    let format = CodexExportFormat::parse(&format)?;
    if account_id.is_some_and(|id| id <= 0) {
        return Err("导出账号无效".into());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
        let multiple = account_id.is_none() && account_ids.as_ref().is_none_or(|ids| ids.len() > 1);
        let use_zip = format.multi_file() && multiple;
        let mut picker = app
            .dialog()
            .file()
            .set_title(format!(
                "导出 Codex 账号 — {}（包含登录凭据）",
                format.label()
            ))
            .set_file_name(if use_zip {
                format!(
                    "codex-accounts-{}.zip",
                    if format == CodexExportFormat::AuthJson {
                        "auth"
                    } else {
                        "cpa"
                    }
                )
            } else {
                format!(
                    "codex-accounts-{}.json",
                    match format {
                        CodexExportFormat::CockpitTools => "cockpit-tools",
                        CodexExportFormat::AuthJson => "auth",
                        CodexExportFormat::Sub2Api => "sub2api",
                        CodexExportFormat::Cpa => "cpa",
                    }
                )
            });
        picker = if use_zip {
            picker.add_filter("ZIP 压缩包", &["zip"])
        } else {
            picker.add_filter("JSON", &["json"])
        };
        let Some(selected) = picker.blocking_save_file() else {
            return Ok(false);
        };
        let path = selected.into_path().map_err(|_| "账号导出路径无效")?;
        let encoded = {
            let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
            // Export a consistent snapshot of stored credentials without changing live client state.
            let conn = open_db()?;
            let accounts = if let Some(ids) = &account_ids {
                if ids.is_empty() || ids.len() > 100 || ids.iter().any(|id| *id <= 0) {
                    return Err("请选择 1 至 100 个有效账号导出".into());
                }
                let mut unique = std::collections::HashSet::new();
                ids.iter()
                    .filter(|id| unique.insert(**id))
                    .map(|id| repository::get(&conn, *id))
                    .collect::<Result<Vec<_>, _>>()?
            } else if let Some(id) = account_id {
                vec![repository::get(&conn, id)?]
            } else {
                repository::list(&conn)?
            };
            let auths = accounts
                .iter()
                .map(|account| repository::credentials(&conn, account.id))
                .collect::<Result<Vec<_>, _>>()?;
            build_export_file(&auths, &accounts, format)?
        };
        match encoded {
            ExportFile::Json(encoded) => profile::write_private(&path, &encoded)?,
            ExportFile::Zip(encoded) => profile::write_private_bytes(&path, &encoded)?,
        }
        Ok(true)
    })
    .await
    .map_err(|_| "导出账号任务失败")?
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn codex_export_accounts_text(
    account_id: Option<i64>,
    account_ids: Option<Vec<i64>>,
    format: String,
) -> PlatformResult<String> {
    let format = CodexExportFormat::parse(&format)?;
    if account_id.is_some_and(|id| id <= 0) {
        return Err("导出账号无效".into());
    }
    if format.multi_file() && account_id.is_none() && account_ids.as_ref().is_none_or(|ids| ids.len() > 1) {
        return Err("此格式的多账号导出需要 ZIP 文件，请使用文件导出".into());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let _writer = AUTH_WRITER.lock().map_err(|_| "Codex 账号操作不可用")?;
        let conn = open_db()?;
        let accounts = if let Some(ids) = &account_ids {
            if ids.is_empty() || ids.len() > 100 || ids.iter().any(|id| *id <= 0) {
                return Err("请选择 1 至 100 个有效账号导出".into());
            }
            let mut unique = std::collections::HashSet::new();
            ids.iter().filter(|id| unique.insert(**id))
                .map(|id| repository::get(&conn, *id)).collect::<Result<Vec<_>, _>>()?
        } else if let Some(id) = account_id {
            vec![repository::get(&conn, id)?]
        } else {
            repository::list(&conn)?
        };
        let auths = accounts.iter().map(|account| repository::credentials(&conn, account.id))
            .collect::<Result<Vec<_>, _>>()?;
        match build_export_file(&auths, &accounts, format)? {
            ExportFile::Json(encoded) => Ok(encoded.to_string()),
            ExportFile::Zip(_) => Err("此格式的多账号导出需要 ZIP 文件，请使用文件导出".into()),
        }
    }).await.map_err(|_| "账号文本导出任务失败")?.map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn summary(auth_mode: &str) -> crate::core::codex::CodexAccountSummary {
        crate::core::codex::CodexAccountSummary {
            is_web_session: false,
            user_id: None, login_provider: None, workspace_name: None,
            access_expires_at: None,
            refresh_expires_at: None,
            id_expires_at: None,
            has_refresh_token: false,
            id: 1,
            label: "one@example.test".into(),
            email: Some("one@example.test".into()),
            account_id: Some("acct-1".into()),
            auth_mode: auth_mode.into(),
            plan: None,
            proxy_url: None,
            benefits: Default::default(),
            note: String::new(),
            tags: vec![],
            quota: Default::default(),
            last_error: None,
            updated_at: 0,
        }
    }
    #[test]
    fn plain_exports_round_trip_as_single_auth_or_account_array() {
        let auth = Zeroizing::new(r#"{"OPENAI_API_KEY":"test-only-api-key"}"#.to_string());
        let single = plain_accounts(&[auth.clone()]).unwrap();
        assert!(single.starts_with('{'));
        assert_eq!(auth::parse_import(&single).unwrap().len(), 1);
        let batch = plain_accounts(&[
            auth.clone(),
            Zeroizing::new(r#"{"OPENAI_API_KEY":"test-only-second-key"}"#.to_string()),
        ])
        .unwrap();
        assert!(batch.starts_with('['));
        assert_eq!(auth::parse_import(&batch).unwrap().len(), 2);
        assert!(plain_accounts(&[]).is_err());
        assert!(plain_accounts(&[Zeroizing::new("{}".into())]).is_err());
    }

    #[test]
    fn exports_supported_external_formats_with_expected_shapes() {
        let auth = Zeroizing::new(
            r#"{"auth_mode":"apikey","OPENAI_API_KEY":"test-only-key"}"#.to_string(),
        );
        let cockpit = build_export_file(
            &[auth.clone()],
            &[summary("apikey")],
            CodexExportFormat::CockpitTools,
        )
        .unwrap();
        let ExportFile::Json(cockpit) = cockpit else {
            panic!("expected JSON")
        };
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&cockpit).unwrap()["type"],
            "codex"
        );
        let sub2api = build_export_file(
            &[auth.clone()],
            &[summary("apikey")],
            CodexExportFormat::Sub2Api,
        )
        .unwrap();
        let ExportFile::Json(sub2api) = sub2api else {
            panic!("expected JSON")
        };
        let parsed: serde_json::Value = serde_json::from_str(&sub2api).unwrap();
        assert_eq!(parsed["type"], "sub2api-data");
        assert_eq!(
            parsed["accounts"][0]["credentials"]["api_key"],
            "test-only-key"
        );
        assert!(build_export_file(
            &[auth.clone()],
            &[summary("apikey")],
            CodexExportFormat::Cpa
        )
        .is_err());
        let payload = URL_SAFE_NO_PAD.encode(serde_json::json!({"sub":"user-1","email":"one@example.test","exp":1_800_000_000,"https://api.openai.com/auth":{"chatgpt_account_id":"acct-1","chatgpt_user_id":"user-1"}}).to_string());
        let id_token = format!("test.{payload}.test");
        let oauth = Zeroizing::new(serde_json::json!({"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"id_token":id_token,"access_token":format!("test.{payload}.test"),"refresh_token":"test-refresh","account_id":"acct-1"},"last_refresh":"2026-10-14T00:00:00Z"}).to_string());
        let official = build_export_file(
            &[oauth.clone()],
            &[summary("chatgpt")],
            CodexExportFormat::AuthJson,
        )
        .unwrap();
        let ExportFile::Json(official) = official else {
            panic!("expected JSON")
        };
        let official_value: serde_json::Value = serde_json::from_str(&official).unwrap();
        assert_eq!(official_value["type"], "codex");
        assert_eq!(official_value["tokens"]["account_id"], "acct-1");

        let sub2api = build_export_file(
            &[oauth.clone()],
            &[summary("chatgpt")],
            CodexExportFormat::Sub2Api,
        )
        .unwrap();
        let ExportFile::Json(sub2api) = sub2api else {
            panic!("expected JSON")
        };
        let sub2api_value: serde_json::Value = serde_json::from_str(&sub2api).unwrap();
        assert_eq!(sub2api_value["accounts"][0]["type"], "oauth");
        assert_eq!(
            sub2api_value["accounts"][0]["credentials"]["refresh_token"],
            "test-refresh"
        );

        let cpa = build_export_file(
            &[oauth.clone()],
            &[summary("chatgpt")],
            CodexExportFormat::Cpa,
        )
        .unwrap();
        let ExportFile::Json(cpa) = cpa else {
            panic!("expected JSON")
        };
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&cpa).unwrap()["type"],
            "codex"
        );

        assert!(matches!(
            build_export_file(
                &[oauth.clone(), oauth.clone()],
                &[summary("chatgpt"), summary("chatgpt")],
                CodexExportFormat::AuthJson
            )
            .unwrap(),
            ExportFile::Zip(_)
        ));
        assert!(matches!(
            build_export_file(
                &[oauth.clone(), oauth],
                &[summary("chatgpt"), summary("chatgpt")],
                CodexExportFormat::Cpa
            )
            .unwrap(),
            ExportFile::Zip(_)
        ));
    }
}
