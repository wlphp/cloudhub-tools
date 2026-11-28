//! 桌面端 Codex 供应商额度适配封装，核心查询与解析逻辑由跨平台 `core::provider_usage` 统一提供。
pub use crate::core::provider_usage::{query, Usage};

pub async fn query_logged(
    base: &str,
    key: &str,
    requested: &str,
) -> (Result<Usage, String>, Vec<super::provider_logs::Exchange>) {
    let (result, exchanges) = crate::core::provider_usage::query_logged(base, key, requested).await;
    let mapped = exchanges
        .into_iter()
        .map(|item| super::provider_logs::Exchange {
            method: item.method,
            url: item.url,
            request_body: item.request_body,
            client_request_body: item.client_request_body,
            status: item.status,
            response_body: item.response_body,
            error: item.error,
            elapsed_ms: item.elapsed_ms,
        })
        .collect();
    (result, mapped)
}
