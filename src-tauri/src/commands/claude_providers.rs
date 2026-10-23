//! Claude Code 供应商管理命令。
//!
//! 切换供应商时先把现有 `settings.json` 备份，再做地板字段差量合并写回；用户的
//! hooks、enabledPlugins 等配置不在地板范围内，因此原样保留。
use crate::core::{
    claude_providers::{self as model},
    database::open_db,
    error::PlatformResult,
    repositories::claude_providers as repository,
};
use serde::Serialize;

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

async fn work<T: Send + 'static, F: FnOnce() -> Result<T, String> + Send + 'static>(f: F) -> PlatformResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| "供应商任务执行失败".to_string())
        .and_then(|result| result)
        .map_err(Into::into)
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeProviderSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub website_url: String,
    pub base_url: String,
    /// 是否已经填写密钥；密钥本身永远不随列表返回。
    pub key_configured: bool,
    pub api_key_field: model::ApiKeyField,
    pub api_format: model::ApiFormat,
    pub is_full_url: bool,
    pub models: serde_json::Map<String, serde_json::Value>,
    pub extra_env: serde_json::Map<String, serde_json::Value>,
    pub is_current: bool,
    pub official_login: bool,
    pub model_catalog: Vec<model::ModelMapping>,
    pub user_agent: String,
    pub proxy_header_override: String,
    pub proxy_body_override: String,
    pub fallback_model: Option<model::ModelMapping>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeProviderList {
    pub providers: Vec<ClaudeProviderSummary>,
    pub current_id: Option<String>,
    /// live 配置里是否存在当前供应商写入的字段。
    pub settings_path: String,
    pub settings_exists: bool,
    pub has_backup: bool,
    /// 只返回状态，不返回配置差异或凭据。无已选供应商时为空。
    pub configuration_status: Option<ConfigurationStatus>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ConfigurationStatus { Matched, Changed, Missing, Unreadable }

fn configuration_status(path: &std::path::Path, provider: &model::ClaudeProvider) -> ConfigurationStatus {
    // try_exists 区分缺失与无权限，不能把不可读取当成空文件。
    match path.try_exists() {
        Ok(false) => return ConfigurationStatus::Missing,
        Err(_) => return ConfigurationStatus::Unreadable,
        Ok(true) => {}
    }
    let Ok(live) = repository::read_settings_at(path) else { return ConfigurationStatus::Unreadable; };
    let mut target = provider.clone();
    target.extra_env.remove(repository::IS_CURRENT_MARKER);
    if model::settings_match_provider(&live, &target) { ConfigurationStatus::Matched } else { ConfigurationStatus::Changed }
}

#[cfg(test)]
mod configuration_tests {
    use super::*;

    #[test]
    fn configuration_status_handles_missing_invalid_and_changed_files() {
        let root = std::env::temp_dir().join(format!("cloudhub-configuration-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("settings.json");
        let provider: model::ClaudeProvider = serde_json::from_value(serde_json::json!({"id":"fixture","name":"fixture","apiKey":"","officialLogin":true})).unwrap();
        assert_eq!(configuration_status(&path, &provider), ConfigurationStatus::Missing);
        std::fs::write(&path, "invalid JSON").unwrap();
        assert_eq!(configuration_status(&path, &provider), ConfigurationStatus::Unreadable);
        std::fs::write(&path, r#"{"env":{}}"#).unwrap();
        assert_eq!(configuration_status(&path, &provider), ConfigurationStatus::Matched);
        std::fs::write(&path, r#"{"env":{"ANTHROPIC_BASE_URL":"https://example.test"}}"#).unwrap();
        assert_eq!(configuration_status(&path, &provider), ConfigurationStatus::Changed);
        assert_eq!(serde_json::to_value(configuration_status(&path, &provider)).unwrap(), "changed");
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&root).unwrap();
    }
}

fn to_summary(provider: &model::ClaudeProvider) -> ClaudeProviderSummary {
    let mut extra = provider.extra_env.clone();
    let is_current = extra.remove(repository::IS_CURRENT_MARKER).is_some();
    ClaudeProviderSummary {
        id: provider.id.clone(),
        name: provider.name.clone(),
        description: provider.description.clone(),
        website_url: provider.website_url.clone(),
        base_url: provider.base_url.clone(),
        key_configured: !provider.api_key.is_empty(),
        api_key_field: provider.api_key_field,
        api_format: provider.api_format,
        is_full_url: provider.is_full_url,
        models: provider.models.clone(),
        extra_env: extra,
        is_current,
        official_login: provider.official_login,
        model_catalog: provider.model_catalog.clone(),
        user_agent: provider.user_agent.clone(),
        // 内部是 `Value` 兼容老数据 Map；给前端的是 textarea 编辑的字符串。
        // String 形态直接给，Object 形态序列化成可读的 JSON 文本，Null 给空串。
        proxy_header_override: proxy_override_to_text(&provider.proxy_header_override),
        proxy_body_override: proxy_override_to_text(&provider.proxy_body_override),
        fallback_model: provider.fallback_model.clone(),
    }
}

/// `Value::String` 透传，`Value::Object` 序列化成可读 JSON，其余（Null / 数字 / 数组）压成空串。
/// 不在此处做合法性校验——前端 Editor 自带 JSON 校验，存盘时再由 save 路径把关。
fn proxy_override_to_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(s) => s.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// 列出全部供应商，并报告 live 文件与备份状态。
#[tauri::command]
pub(crate) async fn claude_provider_list() -> PlatformResult<ClaudeProviderList> {
    work(|| {
        let conn = open_db()?;
        repository::seed(&conn, now())?;
        #[cfg(desktop)]
        let current_id=crate::core::claude_workspace::current_provider(&conn)?;
        #[cfg(not(desktop))]
        let current_id=repository::current_provider_id(&conn)?;
        let stored = repository::list_providers(&conn)?;
        let providers = stored.iter().map(|p|{let mut summary=to_summary(p);summary.is_current=current_id.as_deref()==Some(&p.id);summary}).collect();
        let path = repository::settings_path()?;
        let configuration_status = stored.iter().find(|p| current_id.as_deref() == Some(&p.id)).map(|p| configuration_status(&path, p));
        Ok(ClaudeProviderList {
            providers,
            current_id,
            settings_path: path.to_string_lossy().to_string(),
            settings_exists: path.exists(),
            has_backup: repository::latest_backup(&conn)?.is_some(),
            configuration_status,
        })
    })
    .await
}

/// 保存供应商。`apiKey` 传空字符串表示保持已保存的密钥不变，避免列表接口因为
/// 不回传密钥而把密钥抹掉。
#[tauri::command]
pub(crate) async fn claude_provider_save(provider: model::ClaudeProvider) -> PlatformResult<()> {
    work(move || {
        let conn = open_db()?;
        let mut target = provider;
        if target.api_key.trim().is_empty() {
            if let Some(existing) = repository::list_providers(&conn)?.into_iter().find(|item| item.id == target.id) {
                target.api_key = existing.api_key;
            }
        }
        repository::save_provider(&conn, &target, now())
    })
    .await?;
    #[cfg(desktop)]
    crate::core::claude_gateway::refresh_providers().await?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn claude_provider_delete(id: String) -> PlatformResult<u64> {
    #[cfg(desktop)]
    if crate::core::claude_gateway::in_use(&id).await {return Err("该供应商仍在路由或聚合名单中，请先移除".into());}
    work(move || {
        let conn=open_db()?;
        #[cfg(desktop)]
        if crate::core::claude_workspace::current_provider(&conn)?.as_deref()==Some(&id){return Err("当前直连供应商不能删除，请先切换".into());}
        repository::delete_provider(&conn, &id)
    }).await
}

/// 切换当前供应商：备份 → 合并写入 → 标记生效。
#[tauri::command]
pub(crate) async fn claude_provider_switch(id: String) -> PlatformResult<()> {
    let validation_id=id.clone();
    work(move || {
        let provider=repository::list_providers(&open_db()?)?.into_iter().find(|p|p.id==validation_id).ok_or("供应商不存在")?;
        if provider.api_format!=model::ApiFormat::Anthropic&&!provider.official_login{return Err("此供应商需要协议转换，请使用路由或聚合".into());}
        if provider.api_key.trim().is_empty()&&!provider.official_login{return Err("该供应商尚未填写 API Key".into());}
        Ok(())
    }).await?;
    #[cfg(desktop)]
    crate::core::claude_gateway::activate(crate::core::claude_gateway::Mode::Direct).await?;
    work(move || {
        #[cfg(desktop)]
        let _writer=crate::core::claude_gateway::CONFIG_WRITER.lock().map_err(|_|"配置正在使用")?;
        let conn = open_db()?;
        let provider = repository::list_providers(&conn)?
            .into_iter()
            .find(|item| item.id == id)
            .ok_or_else(|| "供应商不存在".to_string())?;
        if provider.api_format != model::ApiFormat::Anthropic && !provider.official_login {
            return Err("此供应商需要协议转换，请在路由或聚合模式中使用".into());
        }
        if provider.api_key.trim().is_empty() && !provider.official_login {
            return Err("该供应商尚未填写 API Key，无法切换".into());
        }
        let mut live = repository::read_settings()?;
        #[cfg(desktop)]
        if let Some(previous_id)=crate::core::claude_workspace::current_provider(&conn)?{
            if let Some(previous)=repository::list_providers(&conn)?.into_iter().find(|p|p.id==previous_id){
                let env=model::provider_env(&previous);
                if let Some(current)=live["env"].as_object_mut(){
                    for key in model::EXCLUSIVE_ENV{if env.get(*key).is_some_and(|v|current.get(*key)==Some(v)){current.remove(*key);}}
                }
            }
        }
        repository::backup(&conn, now())?;
        let merged = model::apply_provider(&live, &provider);
        repository::write_settings(&merged.document)?;
        #[cfg(desktop)]
        return crate::core::claude_workspace::set_current_provider(&conn,Some(&id));
        #[cfg(not(desktop))]
        repository::set_current(&conn, &id)
    })
    .await
}

/// 把最近一次备份写回 live 配置。
///
/// 先取走最近备份再备份当前内容，否则「当前内容」会占掉刚取出的那一份，用户无法
/// 再次回到同一状态。
#[tauri::command]
pub(crate) async fn claude_provider_restore_backup() -> PlatformResult<()> {
    #[cfg(desktop)]
    crate::core::claude_gateway::activate(crate::core::claude_gateway::Mode::Direct).await?;
    work(|| {
        #[cfg(desktop)]
        let _writer=crate::core::claude_gateway::CONFIG_WRITER.lock().map_err(|_|"配置正在使用")?;
        let conn = open_db()?;
        let (backup_id, content) = repository::latest_backup(&conn)?.ok_or_else(|| "没有可恢复的备份".to_string())?;
        let parsed: serde_json::Value = serde_json::from_str(&content).map_err(|_| "备份内容不是合法 JSON".to_string())?;
        if !parsed.is_object()||parsed.get("env").is_some_and(|v|!v.is_object()){return Err("备份配置格式无效，未恢复".into());}
        let path=repository::settings_path()?;
        let tx=conn.unchecked_transaction().map_err(|_|"无法开始恢复")?;
        repository::backup(&tx, now())?;
        repository::write_settings_at(&path,&parsed)?;
        tx.execute("DELETE FROM claude_provider_backups WHERE id=?1",[backup_id]).map_err(|_|"更新恢复记录失败")?;
        #[cfg(desktop)]
        crate::core::claude_workspace::set_current_provider(&tx,None)?;
        #[cfg(not(desktop))]
        tx.execute("UPDATE claude_providers SET is_current=0",[]).map_err(|_|"更新当前供应商失败")?;
        tx.commit().map_err(|_|"保存恢复记录失败".into())
    })
    .await
}

/// 读取 live 配置里当前的连接信息，用于界面回显当前实际生效的供应商。
#[tauri::command]
pub(crate) async fn claude_provider_current_settings(preview: Option<bool>) -> PlatformResult<serde_json::Value> {
    work(move || {
        let settings=repository::read_settings()?;
        if preview == Some(true) {
            // 用户主动打开的本地只读预览显示完整配置；不得记录此返回值。
            return Ok(serde_json::json!({"path":repository::settings_path()?.to_string_lossy(),"document":settings}));
        }
        let env=settings["env"].as_object();
        Ok(serde_json::json!({"baseUrl":env.and_then(|e|e.get("ANTHROPIC_BASE_URL")).and_then(|v|v.as_str()).unwrap_or(""),
            "models":env.map(model::models_from_env).unwrap_or_default()}))
    }).await
}

/// 单独解密某家供应商的 API Key。仅桌面端暴露，移动端 `nativeOnly` 会直接返回错误，
/// 列表接口永远不携带密钥——这个端点只在用户主动点眼睛按钮时按需调用。
#[cfg(desktop)]
#[tauri::command]
pub(crate) async fn claude_provider_reveal(id: String) -> PlatformResult<String> {
    work(move || repository::reveal_api_key(&open_db()?, &id)).await
}
