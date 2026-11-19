use chrono::Utc;
use serde_json::{json, Value};

/// 本轮已接入真实财务接口的厂商。
pub(crate) const BALANCE_SUPPORTED: &[&str] = &["aliyun", "tencent", "volcengine", "jdcloud", "baidu", "vultr", "cloudflare"];

pub(crate) fn supports_balance(cloud_type: &str) -> bool {
    BALANCE_SUPPORTED.contains(&cloud_type)
}

pub(crate) fn default_currency(cloud_type: &str) -> Value {
    match cloud_type {
        "vultr" | "cloudflare" | "aws" | "gcp" => json!("USD"),
        "aliyun" | "tencent" | "volcengine" | "jdcloud" | "baidu" | "ctyun" | "huawei" | "ucloud"
        | "qingcloud" | "ksyun" | "qiniu" => json!("CNY"),
        _ => Value::Null,
    }
}

/// 所有厂商共用的财务 payload。金额保持 null 表示“没有取得”，绝不以 0 冒充。
pub(crate) fn base(cloud_type: &str) -> Value {
    json!({
        "local_account_id": Value::Null,
        "cloud_account_id": Value::Null,
        "cloud_type": cloud_type,
        "account_type": Value::Null,
        "balance_status": "unfetched",
        "consume_status": "unfetched",
        "balance_message": Value::Null,
        "consume_message": Value::Null,
        "available_amount": Value::Null,
        "available_cash_amount": Value::Null,
        "credit_amount": Value::Null,
        "month_consume": Value::Null,
        "month_bill": Value::Null,
        "currency": default_currency(cloud_type),
        "notes": [],
        "fetched_at": Utc::now().timestamp_millis(),
    })
}

pub(crate) fn with_local_account(mut payload: Value, id: i64) -> Value {
    payload["local_account_id"] = json!(id);
    payload
}

/// 构造没有网络请求的静态状态（不支持 / 待接入）。
pub(crate) fn unavailable(cloud_type: &str, balance_status: &str, consume_status: &str, balance_message: &str, consume_message: &str) -> Value {
    let mut payload = base(cloud_type);
    payload["balance_status"] = json!(balance_status);
    payload["consume_status"] = json!(consume_status);
    if !balance_message.is_empty() {
        payload["balance_message"] = json!(balance_message);
    }
    if !consume_message.is_empty() {
        payload["consume_message"] = json!(consume_message);
    }
    payload
}

/// 厂商消息只保留本项目编写的安全文案，并归类为 UI 可展示的状态。
pub(crate) fn safe_message(message: &str) -> String {
    if message.contains("Unauthorized IP address") {
        return "API Key 未授权当前出口 IP，请在厂商控制台允许该 IP 后重试".into();
    }
    crate::core::error::sanitize_resource_error(message)
}

pub(crate) fn status_from_error(message: &str) -> &'static str {
    if message.contains("Unauthorized IP address") {
        return "permission";
    }
    let message = safe_message(message);
    if message.contains("权限不足") {
        "permission"
    } else if message.contains("认证失败") {
        "auth"
    } else if message.contains("频繁") || message.contains("网络暂时不可用") {
        "network"
    } else {
        "error"
    }
}

pub(crate) fn number(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    value
        .as_f64()
        .or_else(|| value.as_i64().map(|number| number as f64))
        .or_else(|| value.as_u64().map(|number| number as f64))
        .or_else(|| {
            value.as_str().and_then(|text| {
                let normalized = text.trim().replace([',', '，'], "");
                normalized.parse::<f64>().ok()
            })
        })
        .filter(|number| number.is_finite())
}

pub(crate) fn number_field(value: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| number(value.get(*key)))
}

pub(crate) fn set_balance_ok(payload: &mut Value, available: Option<f64>, cash: Option<f64>, credit: Option<f64>) {
    payload["balance_status"] = json!("ok");
    payload["balance_message"] = Value::Null;
    if let Some(value) = available {
        payload["available_amount"] = json!(value);
    }
    if let Some(value) = cash {
        payload["available_cash_amount"] = json!(value);
    }
    if let Some(value) = credit {
        payload["credit_amount"] = json!(value);
    }
}

pub(crate) fn set_balance_error(payload: &mut Value, error: &str) {
    payload["balance_status"] = json!(status_from_error(error));
    payload["balance_message"] = json!(safe_message(error));
}

/// 厂商明确不提供该账号类型的余额（例如免费计划没有计费资料）。
pub(crate) fn set_balance_unsupported(payload: &mut Value, message: &str) {
    payload["balance_status"] = json!("unsupported");
    payload["balance_message"] = json!(message);
}

pub(crate) fn set_consume_ok(payload: &mut Value, consume: Option<f64>, bill: Option<f64>) {
    payload["consume_status"] = json!("ok");
    payload["consume_message"] = Value::Null;
    if let Some(value) = consume {
        payload["month_consume"] = json!(value);
    }
    if let Some(value) = bill {
        payload["month_bill"] = json!(value);
    }
}

pub(crate) fn set_consume_error(payload: &mut Value, error: &str) {
    payload["consume_status"] = json!(status_from_error(error));
    payload["consume_message"] = json!(safe_message(error));
}

pub(crate) fn set_consume_pending(payload: &mut Value, message: &str) {
    payload["consume_status"] = json!("pending");
    payload["consume_message"] = json!(message);
}

pub(crate) fn add_note(payload: &mut Value, note: &str) {
    if let Some(notes) = payload.get_mut("notes").and_then(Value::as_array_mut) {
        notes.push(json!(note));
    }
}

pub(crate) fn set_cloud_identity(payload: &mut Value, cloud_account_id: Option<String>, account_type: Option<&str>) {
    if let Some(value) = cloud_account_id.filter(|value| !value.trim().is_empty()) {
        payload["cloud_account_id"] = json!(value);
    }
    if let Some(value) = account_type.filter(|value| !value.trim().is_empty()) {
        payload["account_type"] = json!(value);
    }
}

/// 凭据/账号类型错误发生在真正调用厂商接口之前，统一给出可操作的提示。
pub(crate) fn credential_error(cloud_type: &str, id: i64, error: &str) -> Value {
    let mut payload = with_local_account(base(cloud_type), id);
    let message = if error.contains("已停用") {
        "账号已停用，启用后可刷新余额"
    } else if error.contains("凭据") || error.contains("Secret") || error.contains("解密") {
        "读取账号凭据失败，请检查账号 Secret 是否完整"
    } else if error.contains("地域") {
        "账号地域配置无效，请检查账号设置中的默认地域"
    } else {
        "读取账号信息失败，请重新保存账号后重试"
    };
    let status = if error.contains("已停用") { "disabled" } else { "auth" };
    payload["balance_status"] = json!(status);
    payload["consume_status"] = json!(status);
    payload["balance_message"] = json!(message);
    payload["consume_message"] = json!(message);
    payload
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_accept_json_and_formatted_strings() {
        assert_eq!(number(Some(&json!(12.5))), Some(12.5));
        assert_eq!(number(Some(&json!("1,234.50"))), Some(1234.5));
        assert_eq!(number(Some(&json!("  "))), None);
        assert_eq!(number(Some(&json!("not-a-number"))), None);
    }

    #[test]
    fn errors_are_classified_after_sanitizing() {
        assert_eq!(status_from_error("Forbidden 403"), "permission");
        assert_eq!(status_from_error("invalid secret token"), "auth");
        assert_eq!(status_from_error("request timeout"), "network");
        assert_eq!(status_from_error("unexpected upstream failure"), "error");
    }

    #[test]
    fn base_payload_never_uses_zero_for_missing_money() {
        let payload = base("aliyun");
        assert_eq!(payload["available_amount"], Value::Null);
        assert_eq!(payload["month_consume"], Value::Null);
        assert_eq!(payload["currency"], json!("CNY"));
    }
}
