use crate::{account_cloud_type, account_credentials, array_at, ensure_aliyun_account, tencent_number};
use crate::cloud;
use crate::core::error::PlatformResult;
use serde_json::{json, Value};
#[tauri::command]
pub(crate) async fn cloud_account_summary(id: i64) -> PlatformResult<Value> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    if account_cloud_type(id)? == "tencent" {
        let (identity, balance, bill) = cloud::tencent::finance_summary(id).await;
        let (cvm, domains, swas, rds, redis, oss, esa) = tokio::join!(
            cloud::tencent::resource_items(id, "ecs", &access_key_id, &access_key_secret),
            cloud::tencent::resource_items(id, "domain", &access_key_id, &access_key_secret),
            cloud::tencent::resource_items(id, "swas", &access_key_id, &access_key_secret),
            cloud::tencent::resource_items(id, "rds", &access_key_id, &access_key_secret),
            cloud::tencent::resource_items(id, "redis", &access_key_id, &access_key_secret),
            cloud::tencent::resource_items(id, "oss", &access_key_id, &access_key_secret),
            cloud::tencent::resource_items(id, "esa", &access_key_id, &access_key_secret),
        );
        let overview = bill.get("SummaryOverview").or_else(|| bill.pointer("/SummarySet/0")).cloned().unwrap_or_else(|| json!({}));
        let monthly_total = tencent_number(overview.get("RealTotalCost").or_else(|| overview.get("TotalCost")).or_else(|| overview.get("CashPayAmount")));
        return Ok(json!({
            "account_id": identity.get("AppId").or_else(|| identity.get("UserAppId")).cloned().unwrap_or(json!(access_key_id)), "account_type": "腾讯云账号",
            "available_amount": tencent_number(balance.get("Balance").or_else(|| balance.get("RealBalance"))) / 100.0,
            "available_cash_amount": tencent_number(balance.get("CashAccountBalance")) / 100.0,
            "credit_amount": tencent_number(balance.get("PresentAccountBalance").or_else(|| balance.get("IncentiveAccountBalance")).or_else(|| balance.get("VoucherBalance"))) / 100.0,
            "month_consume": monthly_total, "month_bill": monthly_total,
            "ecs_count": cvm.items.len(), "domain_count": domains.items.len(),
            "dns_record_count": domains.items.iter().map(|item| tencent_number(item.get("RecordCount")) as usize).sum::<usize>(),
            "oss_count": oss.items.len(), "rds_count": rds.items.len(), "redis_count": redis.items.len(), "swas_count": swas.items.len(), "esa_count": esa.items.len(),
        }));
    }
    if account_cloud_type(id)? == "volcengine" {
        let (ecs, domains, swas, oss, rds, redis, esa) = tokio::join!(
            cloud::volc::resource_items(id, "ecs", &access_key_id, &access_key_secret),
            cloud::volc::resource_items(id, "domain", &access_key_id, &access_key_secret),
            cloud::volc::resource_items(id, "swas", &access_key_id, &access_key_secret),
            cloud::volc::resource_items(id, "oss", &access_key_id, &access_key_secret),
            cloud::volc::resource_items(id, "rds", &access_key_id, &access_key_secret),
            cloud::volc::resource_items(id, "redis", &access_key_id, &access_key_secret),
            cloud::volc::resource_items(id, "esa", &access_key_id, &access_key_secret),
        );
        return Ok(json!({
            "account_id": access_key_id, "account_type": "火山引擎账号",
            "available_amount": 0, "available_cash_amount": 0, "credit_amount": 0,
            "month_consume": 0, "month_bill": 0,
            "ecs_count": ecs.items.len(), "domain_count": domains.items.len(), "dns_record_count": 0,
            "oss_count": oss.items.len(), "rds_count": rds.items.len(), "redis_count": redis.items.len(),
            "swas_count": swas.items.len(), "esa_count": esa.items.len(),
        }));
    }
    if account_cloud_type(id)? == "ctyun" {
        let (ecs, domains, rds, redis, oss) = tokio::join!(
            cloud::ctyun::resource_items(id, "ecs", &access_key_id, &access_key_secret), cloud::ctyun::resource_items(id, "domain", &access_key_id, &access_key_secret),
            cloud::ctyun::resource_items(id, "rds", &access_key_id, &access_key_secret), cloud::ctyun::resource_items(id, "redis", &access_key_id, &access_key_secret), cloud::ctyun::resource_items(id, "oss", &access_key_id, &access_key_secret),
        );
        return Ok(json!({
            "account_id": access_key_id, "account_type": "天翼云账号",
            "available_amount": 0, "available_cash_amount": 0, "credit_amount": 0,
            "month_consume": 0, "month_bill": 0,
            "ecs_count": ecs.items.len(), "domain_count": domains.items.len(), "dns_record_count": domains.items.iter().map(|item| tencent_number(item.get("RecordCount")) as usize).sum::<usize>(),
            "oss_count": oss.items.len(), "rds_count": rds.items.len(), "redis_count": redis.items.len(), "swas_count": 0, "esa_count": 0,
        }));
    }
    ensure_aliyun_account(id)?;
    let mut summary = json!({"account_id":"-","account_type":"-","available_amount":0,"available_cash_amount":0,"credit_amount":0,"month_consume":0,"month_bill":0,"ecs_count":0,"domain_count":0,"dns_record_count":0,"oss_count":0,"rds_count":0,"redis_count":0,"swas_count":0,"esa_count":0});
    let (identity, balance, bill, dns) = cloud::aliyun::finance_summary(id).await;
    if !identity.is_object() || identity.as_object().is_some_and(|value| value.is_empty()) { } else {
        summary["account_id"] = identity.get("AccountId").cloned().unwrap_or(json!("-"));
        summary["account_type"] = json!(match identity.get("IdentityType").and_then(Value::as_str).unwrap_or("") { "Account" => "主账号", "RAMUser" => "RAM子用户", "AssumedRoleUser" => "角色用户", other if !other.is_empty() => other, _ => "-" });
    }
    if let Some(data) = balance.get("Data") {
            for (source, target) in [("AvailableAmount", "available_amount"), ("AvailableCashAmount", "available_cash_amount"), ("CreditAmount", "credit_amount")] {
                summary[target] = data.get(source).cloned().unwrap_or(json!(0));
            }
    }
    let total: f64 = array_at(&bill, &["Data", "Items", "Item"]).into_iter().filter_map(|item| item.get("PretaxAmount").and_then(|v| v.as_f64().or_else(|| v.as_str()?.parse().ok()))).sum(); summary["month_bill"] = json!(total);
    for resource_type in ["ecs", "domain", "oss", "rds", "redis", "swas", "esa"] { let result = cloud::aliyun::resource_items(resource_type, &access_key_id, &access_key_secret).await; summary[&format!("{resource_type}_count")] = json!(result.items.len()); }
    summary["dns_record_count"] = json!(array_at(&dns, &["Domains", "Domain"]).into_iter().filter_map(|item| item.get("RecordCount").and_then(Value::as_i64)).sum::<i64>());
    Ok(summary)
}
