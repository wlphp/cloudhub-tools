use crate::{account_cloud_type, account_credentials, aliyun_rpc, array_at, rpc_encode, string_params, tencent_request};
use crate::cloud::jdcloud::{jdcloud_firewall_mutation, jdcloud_request};
use serde_json::{json, Value};
use uuid::Uuid;

fn rule_input(ip_protocol: String, port_range: String, source_cidr_ip: String, description: Option<String>) -> Result<(String, String, String, String), String> {
    let protocol = ip_protocol.trim().to_ascii_lowercase();
    let port_range = port_range.trim().to_string();
    let source_cidr_ip = source_cidr_ip.trim().to_string();
    let parts = port_range.split('/').collect::<Vec<_>>();
    if !matches!(protocol.as_str(), "tcp" | "udp") { return Err("轻量服务器仅支持 TCP 或 UDP 端口规则".into()); }
    if parts.len() != 2 { return Err("端口范围格式无效，请使用 80/80 或 8000/9000".into()); }
    let start = parts[0].parse::<u16>().ok();
    let end = parts[1].parse::<u16>().ok();
    if start.is_none() || end.is_none() || start.unwrap() == 0 || end.unwrap() < start.unwrap() { return Err("端口范围必须在 1 到 65535 之间".into()); }
    if source_cidr_ip.is_empty() || !source_cidr_ip.contains('/') { return Err("来源地址必须是 CIDR，例如 0.0.0.0/0".into()); }
    Ok((protocol, port_range, source_cidr_ip, description.unwrap_or_default().trim().to_string()))
}

fn tencent_port(port: &str) -> String {
    let port = port.trim();
    if port.eq_ignore_ascii_case("all") { return "-1/-1".into(); }
    let parts = port.split('-').collect::<Vec<_>>();
    if parts.len() == 2 { format!("{}/{}", parts[0], parts[1]) } else { format!("{port}/{port}") }
}

#[tauri::command]
pub(crate) async fn list_light_firewall_rules(id: i64, region_id: String, instance_id: String) -> Result<Value, String> {
    if region_id.is_empty() || instance_id.is_empty() { return Err("缺少轻量服务器地域或实例 ID".into()); }
    let cloud_type = account_cloud_type(id)?;
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    if cloud_type == "aliyun" {
        let result = aliyun_rpc(&format!("swas.{region_id}.aliyuncs.com"), "2020-06-01", "ListFirewallRules", string_params(&[("RegionId", region_id), ("InstanceId", instance_id), ("PageNumber", "1".into()), ("PageSize", "100".into())]), &access_key_id, &access_key_secret).await?;
        let rules = array_at(&result, &["FirewallRules"]).into_iter()
            .filter(|rule| rule.get("Policy").and_then(Value::as_str).unwrap_or("accept").eq_ignore_ascii_case("accept"))
            .map(|rule| json!({"RuleId": rule.get("RuleId").cloned().unwrap_or(json!("")), "IpProtocol": rule.get("RuleProtocol").cloned().unwrap_or(json!("")), "PortRange": rule.get("Port").cloned().unwrap_or(json!("")), "SourceCidrIp": rule.get("SourceCidrIp").cloned().unwrap_or(json!("")), "Policy": rule.get("Policy").cloned().unwrap_or(json!("accept")), "Description": rule.get("Remark").cloned().unwrap_or(json!(""))})).collect::<Vec<_>>();
        return Ok(json!({"rules": rules}));
    }
    if cloud_type == "tencent" {
        let result = tencent_request("lighthouse", "2020-03-24", "DescribeFirewallRules", json!({"InstanceId": instance_id, "Limit": 100}), Some(&region_id), &access_key_id, &access_key_secret).await?;
        let rules = array_at(&result, &["FirewallRuleSet"]).into_iter()
            .filter(|rule| rule.get("Action").and_then(Value::as_str).unwrap_or("ACCEPT").eq_ignore_ascii_case("ACCEPT"))
            .map(|rule| {
                let firewall_rule = json!({"Protocol": rule.get("Protocol").cloned().unwrap_or(json!("")), "Port": rule.get("Port").cloned().unwrap_or(json!("")), "CidrBlock": rule.get("CidrBlock").cloned().unwrap_or(json!("")), "Action": rule.get("Action").cloned().unwrap_or(json!("ACCEPT")), "FirewallRuleDescription": rule.get("FirewallRuleDescription").cloned().unwrap_or(json!(""))});
                json!({"RuleId": "", "IpProtocol": rule.get("Protocol").cloned().unwrap_or(json!("")), "PortRange": tencent_port(rule.get("Port").and_then(Value::as_str).unwrap_or("")), "SourceCidrIp": rule.get("CidrBlock").cloned().unwrap_or(json!("")), "Policy": rule.get("Action").cloned().unwrap_or(json!("ACCEPT")), "Description": rule.get("FirewallRuleDescription").cloned().unwrap_or(json!("")), "FirewallRule": firewall_rule})
            }).collect::<Vec<_>>();
        return Ok(json!({"rules": rules, "firewallVersion": result.get("FirewallVersion").cloned().unwrap_or(Value::Null)}));
    }
    if cloud_type == "jdcloud" {
        let result = jdcloud_request(id, "lavm", &region_id, &format!("/v1/regions/{}/firewallRule", rpc_encode(&region_id)), string_params(&[("instanceId", instance_id), ("pageSize", "100".into()), ("pageNumber", "1".into())])).await?;
        let rules = array_at(&result, &["result", "firewallRules"]).into_iter().map(|rule| json!({"RuleId": rule.get("ruleId").cloned().unwrap_or(json!("")), "IpProtocol": rule.get("ruleProtocol").cloned().unwrap_or(json!("")), "PortRange": rule.get("port").cloned().unwrap_or(json!("")), "SourceCidrIp": rule.get("sourceAddress").cloned().unwrap_or(json!("")), "Policy": "accept", "Description": rule.get("remark").cloned().unwrap_or(json!(""))})).collect::<Vec<_>>();
        return Ok(json!({"rules": rules}));
    }
    Err("当前云类型暂不支持轻量服务器防火墙管理".into())
}

#[tauri::command]
pub(crate) async fn create_light_firewall_rule(id: i64, region_id: String, instance_id: String, ip_protocol: String, port_range: String, source_cidr_ip: String, description: Option<String>, firewall_version: Option<i64>) -> Result<String, String> {
    if region_id.is_empty() || instance_id.is_empty() { return Err("缺少轻量服务器地域或实例 ID".into()); }
    let (protocol, port_range, source_cidr_ip, description) = rule_input(ip_protocol, port_range, source_cidr_ip, description)?;
    let cloud_type = account_cloud_type(id)?;
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let result = if cloud_type == "aliyun" {
        let rule = json!({"Port": port_range, "RuleProtocol": protocol.to_ascii_uppercase(), "SourceCidrIp": source_cidr_ip, "Remark": description});
        aliyun_rpc(&format!("swas.{region_id}.aliyuncs.com"), "2020-06-01", "CreateFirewallRules", string_params(&[("RegionId", region_id), ("InstanceId", instance_id), ("FirewallRules", json!([rule]).to_string())]), &access_key_id, &access_key_secret).await?
    } else if cloud_type == "tencent" {
        let parts = port_range.split('/').collect::<Vec<_>>();
        let port = if parts[0] == parts[1] { parts[0].to_string() } else { format!("{}-{}", parts[0], parts[1]) };
        let mut rule = json!({"Protocol": protocol.to_ascii_uppercase(), "Port": port, "CidrBlock": source_cidr_ip, "Action": "ACCEPT"});
        if !description.is_empty() { rule["FirewallRuleDescription"] = json!(description); }
        let mut payload = json!({"InstanceId": instance_id, "FirewallRules": [rule]});
        if let Some(version) = firewall_version { payload["FirewallVersion"] = json!(version); }
        tencent_request("lighthouse", "2020-03-24", "CreateFirewallRules", payload, Some(&region_id), &access_key_id, &access_key_secret).await?
    } else if cloud_type == "jdcloud" {
        jdcloud_firewall_mutation(id, &region_id, reqwest::Method::POST, &format!("/v1/regions/{}/firewallRule", rpc_encode(&region_id)), json!({"instanceId": instance_id, "sourceAddress": source_cidr_ip, "ruleProtocol": protocol.to_ascii_uppercase(), "port": port_range, "remark": description, "clientToken": Uuid::new_v4().to_string(), "regionId": region_id})).await?
    } else { return Err("当前云类型暂不支持轻量服务器防火墙管理".into()); };
    Ok(result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}

#[tauri::command]
pub(crate) async fn delete_light_firewall_rule(id: i64, region_id: String, instance_id: String, rule_id: Option<String>, firewall_rule: Option<Value>, firewall_version: Option<i64>) -> Result<String, String> {
    if region_id.is_empty() || instance_id.is_empty() { return Err("缺少轻量服务器地域或实例 ID".into()); }
    let cloud_type = account_cloud_type(id)?;
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let result = if cloud_type == "aliyun" {
        let rule_id = rule_id.filter(|value| !value.trim().is_empty()).ok_or("缺少阿里云防火墙规则 ID")?;
        aliyun_rpc(&format!("swas.{region_id}.aliyuncs.com"), "2020-06-01", "DeleteFirewallRules", string_params(&[("RegionId", region_id), ("InstanceId", instance_id), ("RuleIds", rule_id)]), &access_key_id, &access_key_secret).await?
    } else if cloud_type == "tencent" {
        let firewall_rule = firewall_rule.filter(Value::is_object).ok_or("缺少腾讯云防火墙规则内容")?;
        let mut payload = json!({"InstanceId": instance_id, "FirewallRules": [firewall_rule]});
        if let Some(version) = firewall_version { payload["FirewallVersion"] = json!(version); }
        tencent_request("lighthouse", "2020-03-24", "DeleteFirewallRules", payload, Some(&region_id), &access_key_id, &access_key_secret).await?
    } else if cloud_type == "jdcloud" {
        let rule_id = rule_id.filter(|value| !value.trim().is_empty()).ok_or("缺少京东云防火墙规则 ID")?;
        jdcloud_firewall_mutation(id, &region_id, reqwest::Method::DELETE, &format!("/v1/regions/{}/firewallRule", rpc_encode(&region_id)), json!({"instanceId": instance_id, "ruleId": rule_id, "regionId": region_id})).await?
    } else { return Err("当前云类型暂不支持轻量服务器防火墙管理".into()); };
    Ok(result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}
