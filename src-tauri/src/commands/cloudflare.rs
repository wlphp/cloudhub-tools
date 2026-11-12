use crate::core::error::PlatformResult;
use serde_json::Value;

#[tauri::command]
pub(crate) async fn cloudflare_manage(id: i64, action: String, input: Value) -> PlatformResult<Value> {
    if id <= 0 || !input.is_object() { return Err("Cloudflare 请求参数无效".into()); }
    crate::cloud::cloudflare::manage(id, &action, input).await.map_err(Into::into)
}
