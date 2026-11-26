use crate::core::error::PlatformResult;
use serde_json::Value;

/// Pi coding agent 本机配置。文件读写放到阻塞线程池，避免占用异步运行时。
#[tauri::command]
pub async fn pi_config_action(action: crate::core::pi_config::Action) -> PlatformResult<Value> {
    if let crate::core::pi_config::Action::ModelCatalog { provider, base_url, api, api_key } = action {
        let (profile, key) = tauri::async_runtime::spawn_blocking(move || {
            crate::core::pi_config::catalog_configuration(provider, base_url, api, api_key)
        }).await.map_err(|_| "Pi 模型目录任务失败")??;
        let models = crate::core::ai_models::query(&profile, &key).await?;
        return Ok(serde_json::json!(models));
    }
    tauri::async_runtime::spawn_blocking(move || crate::core::pi_config::action(action))
        .await
        .map_err(|_| "Pi 配置任务失败")?
        .map_err(Into::into)
}
