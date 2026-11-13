use super::*;

const SOURCE: &str = include_str!("../../../worker-templates/vless/worker.mjs");

fn hostname(value: &str) -> Result<&str, String> {
    if value.len() > 253 || !value.contains('.') || !value.split('.').all(|label| !label.is_empty() && label.len() <= 63 && !label.starts_with('-') && !label.ends_with('-') && label.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')) {
        return Err("完整子域名无效".into());
    }
    Ok(value)
}

pub(super) async fn deploy(id: i64, account: &str, input: &Value) -> Result<Value, String> {
    if text(input, "template") != "vless" { return Err("不支持的 Worker 模板".into()); }
    let worker_input_value = json!({"name": text(input, "name"), "code": SOURCE});
    let worker = worker_input(&worker_input_value)?;
    let zone = identifier(text(input, "zoneId"))?;
    let host = hostname(text(input, "hostname"))?;
    let third_party = input["thirdParty"].as_bool().ok_or("第三方地址选项无效")?;
    let detail = request(id, Method::GET, &format!("zones/{zone}"), &[], None).await?;
    let zone_name = text(&detail["result"], "name");
    if detail.pointer("/result/account/id").and_then(Value::as_str) != Some(account) || text(&detail["result"], "status") != "active" || zone_name.is_empty() || !host.ends_with(&format!(".{zone_name}")) { return Err("请选择当前账号已激活域名下的子域名".into()); }
    let base = format!("accounts/{account}/workers/scripts");
    let workers = pages(id, &base, vec![], true, false).await?;
    if workers.iter().any(|row| text(row, "id") == worker) { return Err("同名 Worker 已存在，请更换名称".into()); }
    let records = request(id, Method::GET, &format!("zones/{zone}/dns_records"), &[("name".into(), host.into()), ("per_page".into(), "1".into())], None).await?;
    if !records["result"].as_array().ok_or("DNS 列表格式无效")?.is_empty() { return Err("该子域名已有 DNS 记录，请更换一个未使用的子域名".into()); }
    let domains = pages(id, &format!("accounts/{account}/workers/domains"), vec![], false, false).await?;
    if domains.iter().any(|row| text(row, "hostname") == host) { return Err("子域名已经绑定 Worker，请更换子域名".into()); }
    let sub_token = uuid::Uuid::new_v4().simple().to_string();
    let bindings = json!([
        {"type": "secret_text", "name": "UUID", "text": uuid::Uuid::new_v4().to_string()},
        {"type": "secret_text", "name": "SUB_TOKEN", "text": sub_token},
        {"type": "plain_text", "name": "THIRD_PARTY", "text": third_party.to_string()},
    ]);
    let upload = worker_upload_with_bindings(SOURCE, bindings);
    request_payload(id, Method::PUT, &format!("{base}/{worker}"), &[], None, Some(upload)).await?;
    let subscription_path = format!("/sub/{sub_token}");
    match request(id, Method::PUT, &format!("accounts/{account}/workers/domains"), &[], Some(json!({"hostname": host, "service": worker, "zone_id": zone, "enabled": true, "previews_enabled": false}))).await {
        Ok(_) => Ok(json!({"success": true, "name": worker, "url": format!("https://{host}"), "subscriptionUrl": format!("https://{host}{subscription_path}")})),
        Err(_) => Ok(json!({"success": true, "name": worker, "subscriptionPath": subscription_path, "warning": "Worker 代码已部署，但域名绑定未完成。请在控制台为此 Worker 绑定所选域名，并保存下面的订阅路径；不要重复创建。"})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_complete_hostnames() {
        assert!(hostname("node.example.test").is_ok());
        for host in ["example", "x/../example.test", "https://example.test", "-a.example.test", "a..test", "A.example.test"] { assert!(hostname(host).is_err()); }
    }
    #[test]
    fn template_uses_bindings_and_has_no_legacy_auth_fallback() {
        assert!(SOURCE.contains("env.UUID"));
        assert!(SOURCE.contains("env.SUB_TOKEN"));
        assert!(!SOURCE.contains("parseShadow"));
        assert!(!SOURCE.contains("passWordSha224"));
    }
}
