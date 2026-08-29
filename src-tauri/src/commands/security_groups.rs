use crate::{account_cloud_type, account_credentials, aliyun_rpc, array_at, ensure_aliyun_account, ensure_tencent_account, string_params, tencent_request};
use crate::cloud::baidu::{baidu_request, baidu_request_with_options};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use uuid::Uuid;

fn valid_security_group_protocol(protocol: &str) -> bool { matches!(protocol, "tcp" | "udp" | "icmp" | "gre" | "all") }

fn valid_security_group_port_range(protocol: &str, port_range: &str) -> bool {
    let Some((start, end)) = port_range.split_once('/') else { return false; };
    let Ok(start) = start.parse::<i32>() else { return false; };
    let Ok(end) = end.parse::<i32>() else { return false; };
    if !matches!(protocol, "tcp" | "udp") { return start == -1 && end == -1; }
    (start == -1 && end == -1) || (start >= 1 && end >= start && end <= 65535)
}

fn security_group_rule_params(region_id: String, security_group_id: String, ip_protocol: String, port_range: String, source_cidr_ip: String, policy: String, priority: i32, nic_type: Option<String>) -> Result<BTreeMap<String, String>, String> {
    let protocol = ip_protocol.trim().to_ascii_lowercase();
    let range = port_range.trim().to_string();
    let source = source_cidr_ip.trim().to_string();
    if region_id.is_empty() || security_group_id.trim().is_empty() { return Err("缺少安全组地域或安全组 ID".into()); }
    if !valid_security_group_protocol(&protocol) { return Err("不支持的安全组协议".into()); }
    if !valid_security_group_port_range(&protocol, &range) { return Err("端口范围与协议不匹配，请使用 80/80、8000/9000 或 -1/-1".into()); }
    if source.is_empty() || !source.contains('/') { return Err("来源地址必须是 CIDR，例如 0.0.0.0/0".into()); }
    if !(1..=100).contains(&priority) { return Err("安全组规则优先级必须在 1 到 100 之间".into()); }
    let mut params = string_params(&[("RegionId", region_id), ("SecurityGroupId", security_group_id), ("IpProtocol", protocol), ("PortRange", range), ("SourceCidrIp", source), ("Policy", if policy.eq_ignore_ascii_case("drop") { "drop".into() } else { "accept".into() }), ("Priority", priority.to_string())]);
    if let Some(nic_type) = nic_type.map(|value| value.trim().to_ascii_lowercase()).filter(|value| matches!(value.as_str(), "internet" | "intranet")) { params.insert("NicType".into(), nic_type); }
    Ok(params)
}

#[tauri::command]
pub(crate) async fn list_aliyun_security_groups(id: i64, region_id: String, instance_id: String, security_group_id: Option<String>) -> Result<Value, String> {
    ensure_aliyun_account(id)?;
    if region_id.is_empty() || instance_id.is_empty() { return Err("缺少服务器地域或实例 ID".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let instance = aliyun_rpc(&format!("ecs.{region_id}.aliyuncs.com"), "2014-05-26", "DescribeInstanceAttribute", string_params(&[("RegionId", region_id.clone()), ("InstanceId", instance_id)]), &access_key_id, &access_key_secret).await?;
    let attached_group_ids = array_at(&instance, &["SecurityGroupIds", "SecurityGroupId"]).into_iter().filter_map(Value::as_str).collect::<Vec<_>>();
    let response = aliyun_rpc(&format!("ecs.{region_id}.aliyuncs.com"), "2014-05-26", "DescribeSecurityGroups", string_params(&[("RegionId", region_id.clone()), ("PageSize", "100".into())]), &access_key_id, &access_key_secret).await?;
    let groups = array_at(&response, &["SecurityGroups", "SecurityGroup"]).into_iter().map(|group| {
        let vpc_id = group.get("VpcId").and_then(Value::as_str).unwrap_or("");
        json!({"SecurityGroupId": group.get("SecurityGroupId").cloned().unwrap_or(json!("")), "SecurityGroupName": group.get("SecurityGroupName").cloned().unwrap_or(json!("")), "Description": group.get("Description").cloned().unwrap_or(json!("")), "VpcId": vpc_id, "NicType": if vpc_id.is_empty() { "internet" } else { "intranet" }})
    }).filter(|group| attached_group_ids.is_empty() || group.get("SecurityGroupId").and_then(Value::as_str).is_some_and(|id| attached_group_ids.contains(&id))).collect::<Vec<_>>();
    let selected_security_group_id = security_group_id.filter(|value| groups.iter().any(|group| group.get("SecurityGroupId").and_then(Value::as_str) == Some(value.as_str()))).or_else(|| groups.first().and_then(|group| group.get("SecurityGroupId")).and_then(Value::as_str).map(String::from)).unwrap_or_default();
    let rules = if selected_security_group_id.is_empty() { Vec::new() } else {
        let detail = aliyun_rpc(&format!("ecs.{region_id}.aliyuncs.com"), "2014-05-26", "DescribeSecurityGroupAttribute", string_params(&[("RegionId", region_id), ("SecurityGroupId", selected_security_group_id.clone())]), &access_key_id, &access_key_secret).await?;
        array_at(&detail, &["Permissions", "Permission"]).into_iter().filter(|rule| rule.get("Direction").and_then(Value::as_str).is_some_and(|direction| direction.eq_ignore_ascii_case("ingress"))).map(|rule| json!({"Direction": rule.get("Direction").cloned().unwrap_or(json!("")), "IpProtocol": rule.get("IpProtocol").cloned().unwrap_or(json!("")), "PortRange": rule.get("PortRange").cloned().unwrap_or(json!("")), "SourceCidrIp": rule.get("SourceCidrIp").cloned().unwrap_or(json!("")), "SourceGroupId": rule.get("SourceGroupId").cloned().unwrap_or(json!("")), "Policy": rule.get("Policy").cloned().unwrap_or(json!("accept")), "Priority": rule.get("Priority").cloned().unwrap_or(json!(1)), "Description": rule.get("Description").cloned().unwrap_or(json!("")), "NicType": rule.get("NicType").cloned().unwrap_or(json!(""))})).collect()
    };
    Ok(json!({"groups": groups, "selectedSecurityGroupId": selected_security_group_id, "rules": rules}))
}

#[tauri::command]
pub(crate) async fn authorize_aliyun_security_group_rule(id: i64, region_id: String, security_group_id: String, ip_protocol: String, port_range: String, source_cidr_ip: String, description: Option<String>, nic_type: Option<String>) -> Result<String, String> {
    ensure_aliyun_account(id)?;
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let mut params = security_group_rule_params(region_id.clone(), security_group_id, ip_protocol, port_range, source_cidr_ip, "accept".into(), 1, nic_type)?;
    if let Some(description) = description.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) { params.insert("Description".into(), description); }
    let result = aliyun_rpc(&format!("ecs.{region_id}.aliyuncs.com"), "2014-05-26", "AuthorizeSecurityGroup", params, &access_key_id, &access_key_secret).await?;
    Ok(result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}

#[tauri::command]
pub(crate) async fn revoke_aliyun_security_group_rule(id: i64, region_id: String, security_group_id: String, ip_protocol: String, port_range: String, source_cidr_ip: String, policy: String, priority: i32, nic_type: Option<String>) -> Result<String, String> {
    ensure_aliyun_account(id)?;
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let params = security_group_rule_params(region_id.clone(), security_group_id, ip_protocol, port_range, source_cidr_ip, policy, priority, nic_type)?;
    let result = aliyun_rpc(&format!("ecs.{region_id}.aliyuncs.com"), "2014-05-26", "RevokeSecurityGroup", params, &access_key_id, &access_key_secret).await?;
    Ok(result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}

fn tencent_security_group_policy(ip_protocol: String, port_range: String, source_cidr_ip: String, description: Option<String>) -> Result<Value, String> {
    let protocol = ip_protocol.trim().to_ascii_lowercase();
    let range = port_range.trim().to_string();
    let source = source_cidr_ip.trim().to_string();
    if !valid_security_group_protocol(&protocol) { return Err("不支持的安全组协议".into()); }
    if !valid_security_group_port_range(&protocol, &range) { return Err("端口范围与协议不匹配，请使用 80/80、8000/9000 或 -1/-1".into()); }
    if source.is_empty() || !source.contains('/') { return Err("来源地址必须是 CIDR，例如 0.0.0.0/0".into()); }
    let port = if protocol == "all" { "ALL".into() } else if let Some((start, end)) = range.split_once('/') { if start == end { start.into() } else { format!("{start}-{end}") } } else { range };
    let mut policy = json!({"Action": "ACCEPT", "CidrBlock": source, "Port": port, "Protocol": protocol.to_ascii_uppercase()});
    if let Some(description) = description.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) { policy["PolicyDescription"] = json!(description); }
    Ok(policy)
}

fn tencent_security_group_port(value: &Value) -> String {
    let port = value.as_str().unwrap_or("");
    if port.eq_ignore_ascii_case("all") { "-1/-1".into() }
    else if let Some((start, end)) = port.split_once('-') { format!("{start}/{end}") }
    else if port.is_empty() { "-1/-1".into() } else { format!("{port}/{port}") }
}

#[tauri::command]
pub(crate) async fn list_tencent_security_groups(id: i64, region_id: String, instance_id: String, security_group_id: Option<String>) -> Result<Value, String> {
    ensure_tencent_account(id)?;
    if region_id.is_empty() || instance_id.is_empty() { return Err("缺少服务器地域或实例 ID".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let instance_data = tencent_request("cvm", "2017-03-12", "DescribeInstances", json!({"InstanceIds": [instance_id]}), Some(&region_id), &access_key_id, &access_key_secret).await?;
    let attached_group_ids = array_at(&instance_data, &["InstanceSet"]).first().map(|instance| array_at(instance, &["SecurityGroupIds"]).into_iter().filter_map(Value::as_str).collect::<Vec<_>>()).unwrap_or_default();
    let groups_data = tencent_request("cvm", "2017-03-12", "DescribeSecurityGroups", json!({"Limit": 100}), Some(&region_id), &access_key_id, &access_key_secret).await?;
    let groups = array_at(&groups_data, &["SecurityGroupSet"]).into_iter().map(|group| json!({"SecurityGroupId": group.get("SecurityGroupId").cloned().unwrap_or(json!("")), "SecurityGroupName": group.get("SecurityGroupName").cloned().unwrap_or(json!("")), "Description": group.get("SecurityGroupDesc").cloned().unwrap_or(json!("")), "VpcId": group.get("VpcId").cloned().unwrap_or(json!("")), "NicType": ""})).filter(|group| attached_group_ids.is_empty() || group.get("SecurityGroupId").and_then(Value::as_str).is_some_and(|value| attached_group_ids.contains(&value))).collect::<Vec<_>>();
    let selected_security_group_id = security_group_id.filter(|value| groups.iter().any(|group| group.get("SecurityGroupId").and_then(Value::as_str) == Some(value.as_str()))).or_else(|| groups.first().and_then(|group| group.get("SecurityGroupId")).and_then(Value::as_str).map(String::from)).unwrap_or_default();
    let rules = if selected_security_group_id.is_empty() { Vec::new() } else {
        let policies = tencent_request("cvm", "2017-03-12", "DescribeSecurityGroupPolicies", json!({"SecurityGroupId": selected_security_group_id}), Some(&region_id), &access_key_id, &access_key_secret).await?;
        array_at(&policies, &["SecurityGroupPolicySet", "Ingress"]).into_iter().map(|rule| json!({"Direction": "ingress", "IpProtocol": rule.get("Protocol").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase(), "PortRange": tencent_security_group_port(rule.get("Port").unwrap_or(&Value::Null)), "SourceCidrIp": rule.get("CidrBlock").cloned().unwrap_or(json!("")), "SourceGroupId": rule.get("SecurityGroupId").cloned().unwrap_or(json!("")), "Policy": rule.get("Action").cloned().unwrap_or(json!("ACCEPT")), "Priority": rule.get("PolicyIndex").cloned().unwrap_or(json!(0)), "Description": rule.get("PolicyDescription").cloned().unwrap_or(json!("")), "NicType": ""})).collect()
    };
    Ok(json!({"groups": groups, "selectedSecurityGroupId": selected_security_group_id, "rules": rules}))
}

#[tauri::command]
pub(crate) async fn authorize_tencent_security_group_rule(id: i64, region_id: String, security_group_id: String, ip_protocol: String, port_range: String, source_cidr_ip: String, description: Option<String>, nic_type: Option<String>) -> Result<String, String> {
    let _ = nic_type;
    ensure_tencent_account(id)?;
    if region_id.is_empty() || security_group_id.is_empty() { return Err("缺少安全组地域或安全组 ID".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let result = tencent_request("cvm", "2017-03-12", "AuthorizeSecurityGroupIngress", json!({"SecurityGroupId": security_group_id, "SecurityGroupPolicySet": [tencent_security_group_policy(ip_protocol, port_range, source_cidr_ip, description)?]}), Some(&region_id), &access_key_id, &access_key_secret).await?;
    Ok(result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}

#[tauri::command]
pub(crate) async fn revoke_tencent_security_group_rule(id: i64, region_id: String, security_group_id: String, ip_protocol: String, port_range: String, source_cidr_ip: String, policy: String, priority: i32, nic_type: Option<String>) -> Result<String, String> {
    let _ = (ip_protocol, port_range, source_cidr_ip, policy, nic_type);
    ensure_tencent_account(id)?;
    if region_id.is_empty() || security_group_id.is_empty() || priority < 0 { return Err("缺少安全组地域、安全组 ID 或规则索引".into()); }
    let (access_key_id, access_key_secret) = account_credentials(id)?;
    let result = tencent_request("cvm", "2017-03-12", "RevokeSecurityGroupIngress", json!({"SecurityGroupId": security_group_id, "SecurityGroupPolicySet": [{"PolicyIndex": priority}]}), Some(&region_id), &access_key_id, &access_key_secret).await?;
    Ok(result.get("RequestId").and_then(Value::as_str).unwrap_or_default().to_string())
}

fn baidu_security_group_rule_input(ip_protocol: String, port_range: String, source_cidr_ip: String, description: Option<String>) -> Result<Value, String> {
    let protocol = ip_protocol.trim().to_ascii_lowercase();
    let port_range = port_range.trim();
    let source_ip = source_cidr_ip.trim();
    let Some((start, end)) = port_range.split_once('/') else { return Err("端口范围格式无效，请使用 80/80 或 8000/9000".into()); };
    let Ok(start) = start.parse::<u16>() else { return Err("端口范围格式无效，请使用 80/80 或 8000/9000".into()); };
    let Ok(end) = end.parse::<u16>() else { return Err("端口范围格式无效，请使用 80/80 或 8000/9000".into()); };
    if !matches!(protocol.as_str(), "tcp" | "udp") { return Err("百度云安全组端口仅支持 TCP 或 UDP".into()); }
    if start == 0 || end < start { return Err("端口范围必须在 1 到 65535 之间".into()); }
    if source_ip.is_empty() || !source_ip.contains('/') { return Err("来源地址必须是 CIDR，例如 0.0.0.0/0".into()); }
    let mut rule = json!({"direction": "ingress", "ethertype": "IPv4", "portRange": format!("{start}-{end}"), "protocol": protocol, "sourceIp": source_ip});
    if let Some(description) = description.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) { rule["remark"] = json!(description); }
    Ok(rule)
}

fn baidu_security_group_port(port_range: &str) -> String {
    let value = port_range.trim();
    if value.is_empty() { return "-1/-1".into(); }
    if let Some((start, end)) = value.split_once('-') { format!("{start}/{end}") } else { format!("{value}/{value}") }
}

#[tauri::command]
pub(crate) async fn list_baidu_security_groups(id: i64, region_id: String, instance_id: String, security_group_id: Option<String>) -> Result<Value, String> {
    if account_cloud_type(id)? != "baidu" { return Err("当前账号不是百度智能云账号".into()); }
    if region_id.trim().is_empty() || instance_id.trim().is_empty() { return Err("缺少服务器地域或实例 ID".into()); }
    let host = format!("bcc.{region_id}.baidubce.com");
    let (result, _) = baidu_request(id, &host, "/v2/securityGroup", string_params(&[("instanceId", instance_id), ("maxKeys", "1000".into())])).await?;
    let groups = array_at(&result, &["securityGroups"]).into_iter().map(|group| json!({"SecurityGroupId": group.get("id").cloned().unwrap_or(json!("")), "SecurityGroupName": group.get("name").cloned().unwrap_or(json!("")), "Description": group.get("desc").cloned().unwrap_or(json!("")), "VpcId": group.get("vpcId").cloned().unwrap_or(json!("")), "NicType": ""})).collect::<Vec<_>>();
    let selected_security_group_id = security_group_id.filter(|value| groups.iter().any(|group| group.get("SecurityGroupId").and_then(Value::as_str) == Some(value.as_str()))).or_else(|| groups.first().and_then(|group| group.get("SecurityGroupId")).and_then(Value::as_str).map(String::from)).unwrap_or_default();
    if selected_security_group_id.is_empty() { return Ok(json!({"groups": groups, "selectedSecurityGroupId": "", "rules": []})); }
    let (detail, _) = baidu_request(id, &host, &format!("/v2/securityGroup/{selected_security_group_id}"), BTreeMap::new()).await?;
    let rules = array_at(&detail, &["rules"]).into_iter().filter(|rule| rule.get("direction").and_then(Value::as_str).is_some_and(|direction| direction.eq_ignore_ascii_case("ingress"))).map(|rule| json!({"Direction": rule.get("direction").cloned().unwrap_or(json!("ingress")), "IpProtocol": rule.get("protocol").cloned().unwrap_or(json!("")), "PortRange": baidu_security_group_port(rule.get("portRange").and_then(Value::as_str).unwrap_or("")), "SourceCidrIp": rule.get("sourceIp").cloned().unwrap_or(json!("")), "SourceGroupId": rule.get("sourceGroupId").cloned().unwrap_or(json!("")), "Policy": "accept", "Priority": 0, "Description": rule.get("remark").cloned().unwrap_or(json!("")), "NicType": "", "SecurityGroupRuleId": rule.get("securityGroupRuleId").cloned().unwrap_or(json!(""))})).collect::<Vec<_>>();
    Ok(json!({"groups": groups, "selectedSecurityGroupId": selected_security_group_id, "rules": rules, "sgVersion": detail.get("sgVersion").cloned().unwrap_or(Value::Null)}))
}

#[tauri::command]
pub(crate) async fn authorize_baidu_security_group_rule(id: i64, region_id: String, security_group_id: String, ip_protocol: String, port_range: String, source_cidr_ip: String, description: Option<String>, nic_type: Option<String>, sg_version: Option<i64>) -> Result<String, String> {
    let _ = nic_type;
    if account_cloud_type(id)? != "baidu" { return Err("当前账号不是百度智能云账号".into()); }
    if region_id.trim().is_empty() || security_group_id.trim().is_empty() { return Err("缺少安全组地域或安全组 ID".into()); }
    let mut query = string_params(&[("authorizeRule", String::new()), ("clientToken", Uuid::new_v4().to_string())]);
    if let Some(version) = sg_version { query.insert("sgVersion".into(), version.to_string()); }
    let host = format!("bcc.{region_id}.baidubce.com");
    let (result, _) = baidu_request_with_options(id, &host, &format!("/v2/securityGroup/{security_group_id}"), query, "PUT", Some(json!({"rule": baidu_security_group_rule_input(ip_protocol, port_range, source_cidr_ip, description)?})), true).await?;
    Ok(result.get("requestId").or_else(|| result.get("RequestId")).and_then(Value::as_str).unwrap_or_default().to_string())
}

#[tauri::command]
pub(crate) async fn revoke_baidu_security_group_rule(id: i64, region_id: String, security_group_id: String, ip_protocol: String, port_range: String, source_cidr_ip: String, policy: String, priority: i32, nic_type: Option<String>, security_group_rule_id: Option<String>, sg_version: Option<i64>) -> Result<String, String> {
    let _ = (security_group_id, ip_protocol, port_range, source_cidr_ip, policy, priority, nic_type);
    if account_cloud_type(id)? != "baidu" { return Err("当前账号不是百度智能云账号".into()); }
    if region_id.trim().is_empty() { return Err("缺少安全组地域".into()); }
    let rule_id = security_group_rule_id.filter(|value| !value.trim().is_empty()).ok_or("缺少百度云安全组规则 ID")?;
    let mut query = string_params(&[("clientToken", Uuid::new_v4().to_string())]);
    if let Some(version) = sg_version { query.insert("sgVersion".into(), version.to_string()); }
    let host = format!("bcc.{region_id}.baidubce.com");
    let (result, _) = baidu_request_with_options(id, &host, &format!("/v2/securityGroup/rule/{rule_id}"), query, "DELETE", None, false).await?;
    Ok(result.get("requestId").or_else(|| result.get("RequestId")).and_then(Value::as_str).unwrap_or_default().to_string())
}
