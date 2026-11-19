use crate::cloud::{self, finance};
use crate::core::error::PlatformResult;
use crate::core::repositories::{accounts as account_repository, balances as balance_repository};
use crate::open_db;
use chrono::Utc;
use serde_json::{json, Value};

async fn dispatched_snapshot(id: i64, cloud_type: &str) -> Result<Value, String> {
    match cloud_type {
        "aliyun" => cloud::aliyun::finance_snapshot(id).await,
        "tencent" => cloud::tencent::finance_snapshot(id).await,
        "volcengine" => cloud::volc::finance_snapshot(id).await,
        "jdcloud" => cloud::jdcloud::finance_snapshot(id).await,
        "baidu" => cloud::baidu::finance_snapshot(id).await,
        "vultr" => cloud::vultr::finance_snapshot(id).await,
        "cloudflare" => cloud::cloudflare::finance_snapshot(id).await,
        "oracle" => Ok(finance::unavailable(
            cloud_type,
            "unsupported",
            "pending",
            "OCI 未提供标准账户余额 API，控制台余额无法通过当前凭据读取",
            "OCI 消费需要 Usage API 及额外只读策略，当前版本尚未接入",
        )),
        "ctyun" => Ok(finance::unavailable(
            cloud_type,
            "unsupported",
            "pending",
            "天翼云未公开账户余额接口",
            "天翼云 EOP 账单接口存在，但当前版本尚未接入",
        )),
        "aws" => Ok(finance::unavailable(
            cloud_type,
            "unsupported",
            "pending",
            "AWS 没有账户余额 API；Cost Explorer 也不能读取预付余额",
            "AWS 消费需要启用 Cost Explorer 并授予 ce:GetCostAndUsage，当前版本尚未接入",
        )),
        "azure" => Ok(finance::unavailable(
            cloud_type,
            "unsupported",
            "pending",
            "Azure 仅 MCA 计费账户提供余额 API，当前订阅级凭据无法查询",
            "Azure 消费需要 Cost Management 权限，当前版本尚未接入",
        )),
        "gcp" => Ok(finance::unavailable(
            cloud_type,
            "unsupported",
            "unsupported",
            "GCP 没有账户余额 API",
            "GCP 消费仅能通过 BigQuery 账单导出或预算告警读取，暂不支持",
        )),
        "huawei" | "ucloud" | "ksyun" | "qiniu" => Ok(finance::unavailable(
            cloud_type,
            "pending",
            "pending",
            "该厂商余额接口已确认，当前版本尚未接入",
            "该厂商消费接口已确认，当前版本尚未接入",
        )),
        "qingcloud" => Ok(finance::unavailable(
            cloud_type,
            "pending",
            "unsupported",
            "青云 GetBalance 接口已确认，当前版本尚未接入",
            "青云没有账户级月账单 API，消费不支持",
        )),
        _ => Ok(finance::unavailable(
            cloud_type,
            "unsupported",
            "unsupported",
            "该云类型未接入余额查询",
            "该云类型未接入消费查询",
        )),
    }
}

#[tauri::command]
pub(crate) async fn list_account_balances() -> PlatformResult<Vec<Value>> {
    let conn = open_db()?;
    balance_repository::list(&conn).map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn refresh_account_balance(id: i64) -> PlatformResult<Value> {
    let (cloud_type, enabled) = {
        let conn = open_db()?;
        let cloud_type = account_repository::cloud_type(&conn, id)?;
        let enabled = account_repository::credential_record(&conn, id).map(|row| row.2 == 1).unwrap_or(false);
        (cloud_type, enabled)
    };
    let now = Utc::now().timestamp_millis();
    if !enabled {
        let mut payload = finance::with_local_account(
            finance::unavailable(&cloud_type, "disabled", "disabled", "账号已停用，启用后可刷新余额", "账号已停用，启用后可刷新余额"),
            id,
        );
        payload["fetched_at"] = json!(now);
        return Ok(payload);
    }
    let mut payload = match dispatched_snapshot(id, &cloud_type).await {
        Ok(payload) => payload,
        Err(error) => finance::credential_error(&cloud_type, id, &error),
    };
    payload["local_account_id"] = json!(id);
    payload["cloud_type"] = json!(cloud_type);
    payload["fetched_at"] = json!(now);
    if finance::supports_balance(&cloud_type) {
        let conn = open_db()?;
        balance_repository::upsert(&conn, id, &cloud_type, &payload, now)?;
    }
    Ok(payload)
}
