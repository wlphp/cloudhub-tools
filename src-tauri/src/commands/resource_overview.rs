use crate::{account_cloud_type, account_credentials, aliyun_rpc, array_at, ensure_aliyun_account, string_params};
use crate::cloud::{aliyun::{aliyun_esa, esa_field_details, esa_number, resource_items as aliyun_resource_items}, ctyun::resource_items as ctyun_resource_items, tencent::{resource_items as tencent_resource_items, tencent_number, tencent_request}, volcengine::resource_items as volc_resource_items};
use chrono::{Duration, Local, TimeZone, Utc};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[tauri::command]
pub(crate) async fn esa_overview(id: i64, range: String, site_id: Option<String>) -> Result<Value, String> {
    if account_cloud_type(id)? == "tencent" || account_cloud_type(id)? == "volcengine" {
        let (access_key_id, access_key_secret) = account_credentials(id)?;
        let zones = if account_cloud_type(id)? == "tencent" {
            tencent_resource_items(id, "esa", &access_key_id, &access_key_secret).await
        } else {
            volc_resource_items(id, "esa", &access_key_id, &access_key_secret).await
        };
        let label = match range.as_str() { "yesterday" => "昨日", "week" => "近 7 日", "month" => "近 30 日", _ => "今日" };
        return Ok(json!({
            "traffic": 0, "requests": 0, "defence_requests": 0,
            "site_count": zones.items.len(), "active_count": zones.items.iter().filter(|site| site.get("Status").and_then(Value::as_str).is_some_and(|status| status.eq_ignore_ascii_case("active"))).count(),
            "range_label": label, "trend": {"traffic": [], "requests": [], "page_view": []},
            "site_options": zones.items.iter().map(|site| json!({"id": site.get("SiteId").cloned().unwrap_or(json!("")), "name": site.get("SiteName").or_else(|| site.get("DomainName")).or_else(|| site.get("SiteId")).cloned().unwrap_or(json!(""))})).collect::<Vec<_>>(),
        }));
    }
    ensure_aliyun_account(id)?;
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let sites_result = aliyun_esa("ListSites", string_params(&[(
        "SiteSearchType", "fuzzy".into()), ("SiteName", "".into()),
        ("PageNumber", "1".into()), ("PageSize", "100".into()),
    ]), "GET", &access_key_id, &access_key_secret).await?;
    let sites = array_at(&sites_result, &["Sites"]);
    let now = Local::now();
    let today = Local.from_local_datetime(&now.date_naive().and_hms_opt(0, 0, 0).ok_or("无法计算今日起点")?).single().unwrap_or(now);
    let (start, end, label, interval) = match range.as_str() {
        "yesterday" => (today - Duration::days(1), today, "昨日", "3600"),
        "week" => (today - Duration::days(6), now, "近 7 日", "86400"),
        "month" => (today - Duration::days(29), now, "近 30 日", "86400"),
        _ => (today, now, "今日", "3600"),
    };
    let fields = json!([
        {"FieldName": "Requests", "Dimension": ["ALL"]},
        {"FieldName": "Traffic", "Dimension": ["ALL"]},
        {"FieldName": "PageView", "Dimension": ["ALL"]},
    ]).to_string();
    let mut base = string_params(&[
        ("StartTime", start.with_timezone(&Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string()),
        ("EndTime", end.with_timezone(&Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string()),
        ("Interval", interval.into()),
    ]);
    let selected_site = site_id.filter(|value| !value.is_empty());
    if let Some(ref value) = selected_site { base.insert("SiteId".into(), value.clone()); }
    let mut top_params = base.clone(); top_params.insert("AnalysisType".into(), "1".into()); top_params.insert("Fields".into(), fields.clone());
    let mut defence_params = base.clone();
    defence_params.insert("Fields".into(), json!([{"FieldName":"Requests", "Dimension":["ALL"]}]).to_string());
    defence_params.insert("Filter".into(), json!({"where":{"and":[[{"key":"MitigationType","operator":"in","value":["WafMitigated"]}]]}}).to_string());
    let mut trend_params = base; trend_params.insert("Fields".into(), fields);
    let (top, defence, trend) = tokio::try_join!(
        aliyun_esa("DescribeSiteTopData", top_params, "POST", &access_key_id, &access_key_secret),
        aliyun_esa("DescribeSiteStatisticsData", defence_params, "POST", &access_key_id, &access_key_secret),
        aliyun_esa("DescribeSiteStatisticsData", trend_params, "POST", &access_key_id, &access_key_secret),
    )?;
    let make_trend = |field_name: &str| esa_field_details(&trend, field_name).into_iter().map(|detail| json!({
        "time": detail.get("Time").or_else(|| detail.get("Timestamp")).or_else(|| detail.get("TimeStamp")).or_else(|| detail.get("Date")).cloned().unwrap_or(json!("")),
        "value": esa_number(detail.get("Value")),
    })).collect::<Vec<_>>();
    Ok(json!({
        "traffic": esa_number(esa_field_details(&top, "Traffic").first().and_then(|detail| detail.get("Value"))),
        "requests": esa_number(esa_field_details(&top, "Requests").first().and_then(|detail| detail.get("Value"))),
        "defence_requests": esa_number(esa_field_details(&defence, "Requests").first().and_then(|detail| detail.get("Value"))),
        "site_count": sites_result.get("TotalCount").and_then(Value::as_i64).unwrap_or(sites.len() as i64),
        "active_count": sites.iter().filter(|site| site.get("Status").and_then(Value::as_str).map(|status| status.eq_ignore_ascii_case("active")).unwrap_or(false)).count(),
        "range_label": label,
        "trend": {"traffic": make_trend("Traffic"), "requests": make_trend("Requests"), "page_view": make_trend("PageView")},
        "site_options": sites.iter().map(|site| json!({"id": site.get("SiteId").cloned().unwrap_or(json!("")), "name": site.get("SiteName").or_else(|| site.get("DomainName")).or_else(|| site.get("SiteId")).cloned().unwrap_or(json!(""))})).collect::<Vec<_>>(),
    }))
}

#[tauri::command]
pub(crate) async fn cloud_account_summary(id: i64) -> Result<Value, String> {
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    if account_cloud_type(id)? == "tencent" {
        let (cvm, domains, swas, rds, redis, oss, esa, identity, balance, bill) = tokio::join!(
            tencent_resource_items(id, "ecs", &access_key_id, &access_key_secret), tencent_resource_items(id, "domain", &access_key_id, &access_key_secret), tencent_resource_items(id, "swas", &access_key_id, &access_key_secret), tencent_resource_items(id, "rds", &access_key_id, &access_key_secret), tencent_resource_items(id, "redis", &access_key_id, &access_key_secret), tencent_resource_items(id, "oss", &access_key_id, &access_key_secret), tencent_resource_items(id, "esa", &access_key_id, &access_key_secret),
            tencent_request("cam", "2019-01-16", "GetUserAppId", json!({}), None, &access_key_id, &access_key_secret), tencent_request("billing", "2018-07-09", "DescribeAccountBalance", json!({}), None, &access_key_id, &access_key_secret), tencent_request("billing", "2018-07-09", "DescribeBillSummaryByPayMode", json!({"BeginTime": format!("{}-01", Utc::now().format("%Y-%m")), "EndTime": Utc::now().format("%Y-%m-%d").to_string()}), None, &access_key_id, &access_key_secret),
        );
        let identity = identity.unwrap_or_else(|_| json!({})); let balance = balance.unwrap_or_else(|_| json!({})); let bill = bill.unwrap_or_else(|_| json!({}));
        let overview = bill.get("SummaryOverview").or_else(|| bill.pointer("/SummarySet/0")).cloned().unwrap_or_else(|| json!({}));
        let monthly_total = tencent_number(overview.get("RealTotalCost").or_else(|| overview.get("TotalCost")).or_else(|| overview.get("CashPayAmount")));
        return Ok(json!({"account_id": identity.get("AppId").or_else(|| identity.get("UserAppId")).cloned().unwrap_or(json!(access_key_id)), "account_type": "腾讯云账号", "available_amount": tencent_number(balance.get("Balance").or_else(|| balance.get("RealBalance"))) / 100.0, "available_cash_amount": tencent_number(balance.get("CashAccountBalance")) / 100.0, "credit_amount": tencent_number(balance.get("PresentAccountBalance").or_else(|| balance.get("IncentiveAccountBalance")).or_else(|| balance.get("VoucherBalance"))) / 100.0, "month_consume": monthly_total, "month_bill": monthly_total, "ecs_count": cvm.items.len(), "domain_count": domains.items.len(), "dns_record_count": domains.items.iter().map(|item| tencent_number(item.get("RecordCount")) as usize).sum::<usize>(), "oss_count": oss.items.len(), "rds_count": rds.items.len(), "redis_count": redis.items.len(), "swas_count": swas.items.len(), "esa_count": esa.items.len()}));
    }
    if account_cloud_type(id)? == "volcengine" {
        let (ecs, domains, swas, oss, rds, redis, esa) = tokio::join!(volc_resource_items(id, "ecs", &access_key_id, &access_key_secret), volc_resource_items(id, "domain", &access_key_id, &access_key_secret), volc_resource_items(id, "swas", &access_key_id, &access_key_secret), volc_resource_items(id, "oss", &access_key_id, &access_key_secret), volc_resource_items(id, "rds", &access_key_id, &access_key_secret), volc_resource_items(id, "redis", &access_key_id, &access_key_secret), volc_resource_items(id, "esa", &access_key_id, &access_key_secret));
        return Ok(json!({"account_id": access_key_id, "account_type": "火山引擎账号", "available_amount": 0, "available_cash_amount": 0, "credit_amount": 0, "month_consume": 0, "month_bill": 0, "ecs_count": ecs.items.len(), "domain_count": domains.items.len(), "dns_record_count": 0, "oss_count": oss.items.len(), "rds_count": rds.items.len(), "redis_count": redis.items.len(), "swas_count": swas.items.len(), "esa_count": esa.items.len()}));
    }
    if account_cloud_type(id)? == "ctyun" {
        let (ecs, domains, rds, redis, oss) = tokio::join!(ctyun_resource_items(id, "ecs", &access_key_id, &access_key_secret), ctyun_resource_items(id, "domain", &access_key_id, &access_key_secret), ctyun_resource_items(id, "rds", &access_key_id, &access_key_secret), ctyun_resource_items(id, "redis", &access_key_id, &access_key_secret), ctyun_resource_items(id, "oss", &access_key_id, &access_key_secret));
        return Ok(json!({"account_id": access_key_id, "account_type": "天翼云账号", "available_amount": 0, "available_cash_amount": 0, "credit_amount": 0, "month_consume": 0, "month_bill": 0, "ecs_count": ecs.items.len(), "domain_count": domains.items.len(), "dns_record_count": domains.items.iter().map(|item| tencent_number(item.get("RecordCount")) as usize).sum::<usize>(), "oss_count": oss.items.len(), "rds_count": rds.items.len(), "redis_count": redis.items.len(), "swas_count": 0, "esa_count": 0}));
    }
    ensure_aliyun_account(id)?;
    let mut summary = json!({"account_id":"-","account_type":"-","available_amount":0,"available_cash_amount":0,"credit_amount":0,"month_consume":0,"month_bill":0,"ecs_count":0,"domain_count":0,"dns_record_count":0,"oss_count":0,"rds_count":0,"redis_count":0,"swas_count":0,"esa_count":0});
    if let Ok(identity) = aliyun_rpc("sts.aliyuncs.com", "2015-04-01", "GetCallerIdentity", BTreeMap::new(), &access_key_id, &access_key_secret).await { summary["account_id"] = identity.get("AccountId").cloned().unwrap_or(json!("-")); summary["account_type"] = json!(match identity.get("IdentityType").and_then(Value::as_str).unwrap_or("") { "Account" => "主账号", "RAMUser" => "RAM子用户", "AssumedRoleUser" => "角色用户", other if !other.is_empty() => other, _ => "-" }); }
    if let Ok(balance) = aliyun_rpc("business.aliyuncs.com", "2017-12-14", "QueryAccountBalance", BTreeMap::new(), &access_key_id, &access_key_secret).await { if let Some(data) = balance.get("Data") { for (source, target) in [("AvailableAmount", "available_amount"), ("AvailableCashAmount", "available_cash_amount"), ("CreditAmount", "credit_amount")] { summary[target] = data.get(source).cloned().unwrap_or(json!(0)); } } }
    let billing_cycle = Utc::now().format("%Y-%m").to_string();
    if let Ok(bill) = aliyun_rpc("business.aliyuncs.com", "2017-12-14", "QueryBill", string_params(&[("BillingCycle", billing_cycle)]), &access_key_id, &access_key_secret).await { let total: f64 = array_at(&bill, &["Data", "Items", "Item"]).into_iter().filter_map(|item| item.get("PretaxAmount").and_then(|v| v.as_f64().or_else(|| v.as_str()?.parse().ok()))).sum(); summary["month_bill"] = json!(total); }
    for resource_type in ["ecs", "domain", "oss", "rds", "redis", "swas", "esa"] { let result = aliyun_resource_items(resource_type, &access_key_id, &access_key_secret).await; summary[&format!("{resource_type}_count")] = json!(result.items.len()); }
    if let Ok(dns) = aliyun_rpc("alidns.aliyuncs.com", "2015-01-09", "DescribeDomains", string_params(&[("PageNumber", "1".into()), ("PageSize", "20".into())]), &access_key_id, &access_key_secret).await { summary["dns_record_count"] = json!(array_at(&dns, &["Domains", "Domain"]).into_iter().filter_map(|item| item.get("RecordCount").and_then(Value::as_i64)).sum::<i64>()); }
    Ok(summary)
}
