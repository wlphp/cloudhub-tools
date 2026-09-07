use serde::Serialize;

#[derive(Debug, Serialize)]
pub(crate) struct PlatformError {
    pub kind: &'static str,
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

pub(crate) type PlatformResult<T> = Result<T, PlatformError>;

impl From<String> for PlatformError {
    fn from(message: String) -> Self { Self::from_message(message) }
}

impl From<&str> for PlatformError {
    fn from(message: &str) -> Self { Self::from_message(message.to_string()) }
}

impl PlatformError {
    fn from_message(message: String) -> Self {
        let normalized = message.to_ascii_lowercase();
        let (code, retryable) = if normalized.contains("取消") || normalized.contains("cancel") {
            ("cancelled", false)
        } else if normalized.contains("不存在") || normalized.contains("not found") {
            ("not-found", false)
        } else if normalized.contains("冲突") || normalized.contains("已存在") || normalized.contains("已在运行") || normalized.contains("conflict") {
            ("conflict", false)
        } else if normalized.contains("权限") || normalized.contains("无权") || normalized.contains("forbidden") || normalized.contains("permission") || normalized.contains("http 403") || normalized.contains("status 403") {
            ("permission", false)
        } else if normalized.contains("密钥") || normalized.contains("凭据") || normalized.contains("认证") || normalized.contains("签名") || normalized.contains("access key") || normalized.contains("authentication") || normalized.contains("unauthorized") || normalized.contains("token") || normalized.contains("http 401") || normalized.contains("status 401") {
            ("authentication", false)
        } else if normalized.contains("参数") || normalized.contains("格式") || normalized.contains("不能为空") || normalized.contains("无效") || normalized.contains("invalid") || normalized.contains("must be") {
            ("validation", false)
        } else if normalized.contains("超时") || normalized.contains("网络") || normalized.contains("连接") || normalized.contains("请求失败") || normalized.contains("timeout") || normalized.contains("network") || normalized.contains("connection") || normalized.contains("http 429") || normalized.contains("http 502") || normalized.contains("http 503") || normalized.contains("http 504") || normalized.contains("status 429") || normalized.contains("status 502") || normalized.contains("status 503") || normalized.contains("status 504") {
            ("network", true)
        } else {
            ("unknown", false)
        };
        let public_message = match code {
            "authentication" => "认证失败，请检查凭据或登录状态",
            "permission" => "权限不足，请检查当前账号权限",
            "network" => "网络或云服务暂时不可用，请稍后重试",
            "not-found" => "目标资源不存在或已被移除",
            "conflict" => "操作冲突，请刷新后重试",
            "cancelled" => "操作已取消",
            "validation" => "输入参数无效，请检查后重试",
            _ => "操作失败，请稍后重试",
        };
        Self { kind: "platform-error", code, message: public_message.to_string(), retryable }
    }
}

pub(crate) fn sanitize_resource_error(message: &str) -> String {
    let normalized = message.to_ascii_lowercase();
    if normalized.contains("authorization failed or requested resource not found") {
        "Authorization failed or requested resource not found".to_string()
    } else if normalized.contains("401") || normalized.contains("unauthorized") || normalized.contains("invalid token") || normalized.contains("authentication") || normalized.contains("access key") || normalized.contains("secret") {
        "云厂商认证失败，请检查账号凭据".to_string()
    } else if normalized.contains("403") || normalized.contains("forbidden") || normalized.contains("accessdenied") || normalized.contains("permission") {
        "云厂商权限不足，请检查账号权限".to_string()
    } else if normalized.contains("429") || normalized.contains("too many requests") || normalized.contains("rate limit") {
        "云厂商请求过于频繁，请稍后重试".to_string()
    } else if normalized.contains("502") || normalized.contains("503") || normalized.contains("504") || normalized.contains("timeout") || normalized.contains("network") || normalized.contains("connection") || normalized.contains("请求失败") || normalized.contains("网络") || normalized.contains("连接") || normalized.contains("超时") {
        "云厂商或网络暂时不可用，请稍后重试".to_string()
    } else {
        "云厂商返回了无法公开的错误信息".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{sanitize_resource_error, PlatformError};

    #[test]
    fn classifies_network_errors_as_retryable() {
        let error = PlatformError::from("连接超时".to_string());
        assert_eq!(error.code, "network");
        assert!(error.retryable);
    }

    #[test]
    fn keeps_authentication_errors_non_retryable() {
        let error = PlatformError::from("AccessKey 凭据无效".to_string());
        assert_eq!(error.code, "authentication");
        assert!(!error.retryable);
    }

    #[test]
    fn classifies_duplicate_operations_as_conflicts() {
        let error = PlatformError::from("同步任务已在运行".to_string());
        assert_eq!(error.code, "conflict");
        assert!(!error.retryable);
    }

    #[test]
    fn classifies_http_rate_limits_as_retryable() {
        let error = PlatformError::from("Vultr API 返回 HTTP 429".to_string());
        assert_eq!(error.code, "network");
        assert!(error.retryable);
    }

    #[test]
    fn classifies_http_authentication_and_permission_failures() {
        assert_eq!(PlatformError::from("HTTP 401 Unauthorized".to_string()).code, "authentication");
        assert_eq!(PlatformError::from("HTTP 403 Forbidden".to_string()).code, "permission");
    }

    #[test]
    fn never_returns_provider_error_text_to_the_command_boundary() {
        let error = PlatformError::from("provider failed secret=TOP_SECRET token=TOP_TOKEN".to_string());
        assert_eq!(error.code, "authentication");
        assert!(!error.message.contains("TOP_SECRET"));
        assert!(!error.message.contains("TOP_TOKEN"));
    }

    #[test]
    fn sanitizes_resource_error_payloads() {
        let message = sanitize_resource_error("request failed secret=TOP_SECRET token=TOP_TOKEN");
        assert_eq!(message, "云厂商认证失败，请检查账号凭据");
        assert!(!message.contains("TOP_SECRET"));
        assert!(!message.contains("TOP_TOKEN"));
    }
}
