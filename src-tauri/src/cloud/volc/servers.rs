use serde_json::{json, Value};
use std::collections::BTreeMap;
use super::{request, json_request, valid_region};

fn validate_target(region: &str, id: &str, prefix: &str) -> Result<(), String> {
    if !valid_region(region) || !id.starts_with(prefix) || id.len() <= prefix.len() || id.len() > 128
        || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
        return Err("火山引擎地域或资源 ID 参数无效".into());
    }
    Ok(())
}

fn credentials(id: i64) -> Result<(String, String), String> {
    if crate::account_cloud_type(id)? != "volcengine" { return Err("当前账号不是火山引擎账号".into()); }
    crate::account_credentials(id)
}

fn power_params(region: &str, instance: &str, action: &str, force: bool) -> Result<(&'static str, BTreeMap<String, String>), String> {
    validate_target(region, instance, "i-")?;
    let api = match action { "start" => "StartInstance", "stop" => "StopInstance", "reboot" => "RebootInstance", _ => return Err("不支持的火山服务器操作".into()) };
    let mut params = crate::string_params(&[("InstanceId", instance.into())]);
    if action != "start" { params.insert("ForceStop".into(), force.to_string()); }
    Ok((api, params))
}

pub(crate) async fn instance_action(id: i64, region: &str, instance: &str, action: &str, force: bool) -> Result<Value, String> {
    let (api, params) = power_params(region, instance, action, force)?;
    let (ak, sk) = credentials(id)?;
    request("ecs", "2020-04-01", api, params, region, &ak, &sk).await
}

pub(crate) async fn enrich_bandwidth(item: &mut Value, ak: &str, sk: &str) {
    let region = item.get("_region_id").and_then(Value::as_str).unwrap_or("").to_string();
    let allocation = item.pointer("/EipAddress/AllocationId").and_then(Value::as_str).unwrap_or("");
    if allocation.is_empty() { return; }
    if validate_target(&region, allocation, "eip-").is_err() { return; }
    let params = crate::string_params(&[("AllocationIds.1", allocation.into())]);
    match request("vpc", "2020-04-01", "DescribeEipAddresses", params, &region, ak, sk).await {
        Ok(data) => if let Some(eip) = crate::array_at(&data, &["EipAddresses"]).first() {
            if let Some(bandwidth) = eip.get("Bandwidth") { item["InternetMaxBandwidthOut"] = bandwidth.clone(); }
        },
        Err(_) => item["_bandwidth_error"] = json!("公网带宽未获取，请检查 EIP 读取权限或稍后重试"),
    }
}

pub(crate) async fn instance_disks(id: i64, region: &str, instance: &str) -> Result<Vec<Value>, String> {
    validate_target(region, instance, "i-")?;
    let (ak, sk) = credentials(id)?;
    let mut values = Vec::new();
    for page in 1..=1000 {
        let data = json_request("storage_ebs", "2020-04-01", "DescribeVolumes", json!({"InstanceId": instance, "PageSize": 100, "PageNumber": page}), region, &ak, &sk).await?;
        let volumes = data.get("Volumes").and_then(Value::as_array).ok_or("火山引擎云盘响应格式不兼容")?;
        values.extend(volumes.iter().map(|disk| json!({
            "DiskId": disk.get("VolumeId"), "DiskName": disk.get("VolumeName").filter(|name| name.as_str().is_some_and(|name| !name.is_empty())).cloned().unwrap_or_else(|| json!(if disk.get("Kind").and_then(Value::as_str) == Some("system") { "系统盘" } else { "数据盘" })),
            "Category": disk.get("VolumeType"), "Size": disk.get("Size"), "Status": disk.get("VolumeStatus"),
        })));
        if volumes.len() < 100 || data.get("TotalCount").and_then(Value::as_u64).is_some_and(|total| values.len() as u64 >= total) { return Ok(values); }
    }
    Err("火山引擎云盘分页异常，查询未完成".into())
}

async fn bound_groups(id: i64, region: &str, instance: &str) -> Result<(String, String, Vec<String>), String> {
    validate_target(region, instance, "i-")?;
    let (ak, sk) = credentials(id)?;
    let data = request("ecs", "2020-04-01", "DescribeInstances", crate::string_params(&[("InstanceIds.1", instance.into())]), region, &ak, &sk).await?;
    let item = crate::array_at(&data, &["Instances"]).into_iter().find(|item| item.get("InstanceId").and_then(Value::as_str) == Some(instance)).ok_or("服务器不存在，请刷新后重试")?;
    let mut groups = std::collections::BTreeSet::new();
    for nic in crate::array_at(item, &["NetworkInterfaces"]) {
        for group in crate::array_at(nic, &["SecurityGroupIds"]).into_iter().filter_map(Value::as_str) {
            validate_target(region, group, "sg-")?;
            groups.insert(group.to_string());
        }
    }
    Ok((ak, sk, groups.into_iter().collect()))
}

fn traditional_rule(rule: &Value) -> bool {
    ["LocalCidrIp"].iter().all(|key| rule.get(*key).and_then(Value::as_str).unwrap_or("").is_empty())
        && ["SourcePortStart", "SourcePortEnd"].iter().all(|key| rule.get(*key).and_then(Value::as_i64).is_none_or(|port| port <= 0))
}

fn normalize_rule(rule: &Value) -> Value {
    json!({"SecurityGroupRuleId": rule.get("SecurityGroupRuleId"), "Direction": rule.get("Direction"), "IpProtocol": rule.get("Protocol").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase(),
        "PortRange": format!("{}/{}", rule.get("PortStart").and_then(Value::as_i64).unwrap_or(-1), rule.get("PortEnd").and_then(Value::as_i64).unwrap_or(-1)),
        "SourceCidrIp": rule.get("CidrIp"), "SourceGroupId": rule.get("SourceGroupId").filter(|v| v.as_str().is_some_and(|s| !s.is_empty())).or_else(|| rule.get("PrefixListId")),
        "Policy": rule.get("Policy"), "Priority": rule.get("Priority"), "Description": rule.get("Description"), "ReadOnly": !traditional_rule(rule)})
}

#[derive(Clone, serde::Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct RuleFields {
    pub protocol: String,
    pub ports: String,
    pub source: String,
    pub description: String,
    pub policy: String,
    pub priority: i32,
}

fn current_fields(rule: &Value) -> Result<RuleFields, String> {
    let normalized = normalize_rule(rule);
    Ok(RuleFields {
        protocol: normalized["IpProtocol"].as_str().ok_or("安全组规则格式无效")?.into(),
        ports: normalized["PortRange"].as_str().ok_or("安全组规则格式无效")?.into(),
        source: normalized["SourceCidrIp"].as_str().filter(|s| !s.is_empty()).or_else(|| normalized["SourceGroupId"].as_str()).ok_or("安全组规则格式无效")?.into(),
        description: normalized["Description"].as_str().unwrap_or("").into(),
        policy: normalized["Policy"].as_str().ok_or("安全组规则格式无效")?.to_ascii_lowercase(),
        priority: normalized["Priority"].as_i64().and_then(|value| i32::try_from(value).ok()).ok_or("安全组规则格式无效")?,
    })
}

fn edit_params(region: &str, group: &str, rule_id: &str, fields: &RuleFields) -> Result<BTreeMap<String, String>, String> {
    validate_target(region, rule_id, "sgr-")?;
    // The batch modification API documents IPv4 CIDR and these protocols.
    if fields.source.contains(':') || !matches!(fields.protocol.as_str(), "tcp" | "udp" | "icmp" | "gre" | "all") {
        return Err("当前修改接口仅支持 IPv4 来源及 TCP、UDP、ICMP、GRE、ALL 协议".into());
    }
    if fields.description.chars().count() > 80 || fields.description.chars().any(char::is_control) { return Err("安全组说明参数无效".into()); }
    let values = rule_params(region, group, &fields.protocol, &fields.ports, &fields.source, &fields.policy, fields.priority)?;
    let mut params = crate::string_params(&[("SecurityGroupId", group.into()), ("Permissions.1.SecurityGroupRuleId", rule_id.into()), ("Permissions.1.Description", fields.description.clone())]);
    for (key, value) in values {
        if key != "SecurityGroupId" { params.insert(format!("Permissions.1.{key}"), value); }
    }
    Ok(params)
}

fn ensure_unchanged<'a>(rules: &'a [Value], rule_id: &str, original: &RuleFields) -> Result<&'a Value, String> {
    let rule = rules.iter().find(|rule| rule.get("SecurityGroupRuleId").and_then(Value::as_str) == Some(rule_id)).ok_or("安全组规则不存在，请刷新后重试")?;
    if !traditional_rule(rule) || rule.get("Direction").and_then(Value::as_str) != Some("ingress") { return Err("当前规则含五元组扩展字段，请使用云控制台修改".into()); }
    if current_fields(rule)? != *original { return Err("安全组规则已被修改，请刷新后重试".into()); }
    Ok(rule)
}

pub(crate) async fn update_rule(id: i64, region: &str, instance: &str, group: &str, rule_id: &str, original: RuleFields, updated: RuleFields) -> Result<Value, String> {
    validate_target(region, rule_id, "sgr-")?;
    let mut replacement = replacement_params(region, group, &updated)?;
    let original_params = replacement_params(region, group, &original)?;
    let (ak, sk, groups) = bound_groups(id, region, instance).await?;
    if !groups.iter().any(|value| value == group) { return Err("安全组未绑定当前服务器，请刷新后重试".into()); }
    let data = request("vpc", "2020-04-01", "DescribeSecurityGroupAttributes", crate::string_params(&[("SecurityGroupId", group.into())]), region, &ak, &sk).await?;
    let rules = data.get("Permissions").and_then(Value::as_array).ok_or("火山引擎安全组响应格式不兼容")?;
    ensure_unchanged(rules, rule_id, &original)?;
    if original == updated { return Ok(json!({"Unchanged": true})); }
    if original.source.contains(':') || updated.source.contains(':') || original.protocol == "icmpv6" || updated.protocol == "icmpv6" {
        replacement.insert("ClientToken".into(), uuid::Uuid::new_v4().to_string());
        let call = |action, params| request("vpc", "2020-04-01", action, params, region, &ak, &sk);
        replace_with_restore(original_params, replacement, call).await?;
        return Ok(json!({"Replaced": true}));
    }
    let mut params = edit_params(region, group, rule_id, &updated)?;
    params.insert("ClientToken".into(), uuid::Uuid::new_v4().to_string());
    request("vpc", "2020-04-01", "ModifySecurityGroupIngressBatch", params, region, &ak, &sk).await
}

fn replacement_params(region: &str, group: &str, fields: &RuleFields) -> Result<BTreeMap<String, String>, String> {
    if fields.description.chars().count() > 80 || fields.description.chars().any(char::is_control) { return Err("安全组说明参数无效".into()); }
    let mut params = rule_params(region, group, &fields.protocol, &fields.ports, &fields.source, &fields.policy, fields.priority)?;
    params.insert("Description".into(), fields.description.clone());
    Ok(params)
}

async fn replace_with_restore<F, Fut>(original: BTreeMap<String, String>, updated: BTreeMap<String, String>, mut call: F) -> Result<(), String>
where F: FnMut(&'static str, BTreeMap<String, String>) -> Fut, Fut: std::future::Future<Output = Result<Value, String>> {
    call("RevokeSecurityGroupIngress", original.clone()).await?;
    if call("AuthorizeSecurityGroupIngress", updated).await.is_err() {
        let mut restore = original;
        restore.insert("ClientToken".into(), uuid::Uuid::new_v4().to_string());
        return if call("AuthorizeSecurityGroupIngress", restore).await.is_ok() {
            Err("修改未完成，已提交原规则恢复请求，请刷新核实；请求超时时也请检查是否存在新规则".into())
        } else {
            Err("修改未完成且原规则恢复失败，请立即在云控制台核实并恢复规则".into())
        };
    }
    Ok(())
}

pub(crate) async fn list_security_groups(id: i64, region: &str, instance: &str, selected: Option<String>) -> Result<Value, String> {
    let (ak, sk, ids) = bound_groups(id, region, instance).await?;
    if ids.is_empty() { return Ok(json!({"groups": [], "selectedSecurityGroupId": "", "rules": []})); }
    if selected.as_ref().is_some_and(|group| !ids.contains(group)) { return Err("安全组未绑定当前服务器，请刷新后重试".into()); }
    let selected = selected.unwrap_or_else(|| ids[0].clone());
    let mut groups = Vec::new();
    for group in ids {
        let data = request("vpc", "2020-04-01", "DescribeSecurityGroupAttributes", crate::string_params(&[("SecurityGroupId", group.clone())]), region, &ak, &sk).await?;
        groups.push(json!({"SecurityGroupId": group, "SecurityGroupName": data.get("SecurityGroupName"), "Description": data.get("Description"), "VpcId": data.get("VpcId"), "NicType": "intranet", "_permissions": data.get("Permissions")}));
    }
    let rules = groups.iter().find(|group| group["SecurityGroupId"] == selected).and_then(|group| group.get("_permissions")).and_then(Value::as_array).ok_or("火山引擎安全组响应格式不兼容")?.iter().map(normalize_rule).collect::<Vec<_>>();
    for group in &mut groups { group.as_object_mut().unwrap().remove("_permissions"); }
    Ok(json!({"groups": groups, "selectedSecurityGroupId": selected, "rules": rules}))
}

fn rule_params(region: &str, group: &str, protocol: &str, ports: &str, cidr: &str, policy: &str, priority: i32) -> Result<BTreeMap<String, String>, String> {
    validate_target(region, group, "sg-")?;
    let protocol = protocol.to_ascii_lowercase();
    if !matches!(protocol.as_str(), "tcp" | "udp" | "icmp" | "icmpv6" | "gre" | "all") { return Err("不支持的安全组协议".into()); }
    let (start, end) = ports.split_once('/').and_then(|(a, b)| Some((a.parse::<i32>().ok()?, b.parse::<i32>().ok()?))).ok_or("端口范围格式无效")?;
    if if matches!(protocol.as_str(), "tcp" | "udp") { start < 1 || end < start || end > 65535 } else { start != -1 || end != -1 } { return Err("端口范围与协议不匹配".into()); }
    let source_key = if cidr.starts_with("sg-") { validate_target(region, cidr, "sg-")?; "SourceGroupId" }
        else if cidr.starts_with("pl-") { validate_target(region, cidr, "pl-")?; "PrefixListId" }
        else {
            let (ip, mask) = cidr.split_once('/').ok_or("来源地址必须是有效 CIDR")?;
            let ip = ip.parse::<std::net::IpAddr>().map_err(|_| "来源地址必须是有效 CIDR")?;
            let mask = mask.parse::<u8>().map_err(|_| "来源地址必须是有效 CIDR")?;
            if mask > if ip.is_ipv4() { 32 } else { 128 } { return Err("来源地址必须是有效 CIDR".into()); }
            "CidrIp"
        };
    if !(1..=100).contains(&priority) || !matches!(policy, "accept" | "drop") { return Err("安全组规则参数无效".into()); }
    Ok(crate::string_params(&[("SecurityGroupId", group.into()), ("Protocol", protocol), ("PortStart", start.to_string()), ("PortEnd", end.to_string()), (source_key, cidr.into()), ("Policy", policy.into()), ("Priority", priority.to_string())]))
}

pub(crate) async fn mutate_rule(id: i64, region: &str, instance: &str, group: &str, protocol: &str, ports: &str, cidr: &str, policy: &str, priority: i32, description: Option<String>, revoke: bool) -> Result<(), String> {
    let mut params = rule_params(region, group, protocol, ports, cidr, policy, priority)?;
    let description = description.unwrap_or_default();
    if description.chars().count() > 80 || description.chars().any(char::is_control) { return Err("安全组说明参数无效".into()); }
    let (ak, sk, groups) = bound_groups(id, region, instance).await?;
    if !groups.iter().any(|value| value == group) { return Err("安全组未绑定当前服务器，请刷新后重试".into()); }
    let data = request("vpc", "2020-04-01", "DescribeSecurityGroupAttributes", crate::string_params(&[("SecurityGroupId", group.into())]), region, &ak, &sk).await?;
    let rules = data.get("Permissions").and_then(Value::as_array).ok_or("火山引擎安全组响应格式不兼容")?;
    let matching = rules.iter().any(|rule| traditional_rule(rule) && rule.get("Direction").and_then(Value::as_str) == Some("ingress") && {
        let rule = normalize_rule(rule);
        rule["IpProtocol"] == protocol.to_ascii_lowercase() && rule["PortRange"] == ports && (rule["SourceCidrIp"] == cidr || rule["SourceGroupId"] == cidr) && rule["Policy"] == policy && rule["Priority"] == priority
    });
    if revoke && !matching { return Err("安全组规则已变更或不支持删除，请刷新后重试".into()); }
    if !revoke && matching { return Err("安全组规则已存在，请刷新后重试".into()); }
    if !description.is_empty() { params.insert("Description".into(), description); }
    if !revoke { params.insert("ClientToken".into(), uuid::Uuid::new_v4().to_string()); }
    request("vpc", "2020-04-01", if revoke { "RevokeSecurityGroupIngress" } else { "AuthorizeSecurityGroupIngress" }, params, region, &ak, &sk).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_request_targets_rule_id_and_preserves_explicit_fields() {
        let fields = RuleFields { protocol: "tcp".into(), ports: "8080/8080".into(), source: "192.0.2.0/24".into(), policy: "drop".into(), priority: 42, description: "Web".into() };
        let params = edit_params("cn-guangzhou", "sg-example", "sgr-example", &fields).unwrap();
        assert_eq!(params["Permissions.1.SecurityGroupRuleId"], "sgr-example");
        assert_eq!(params["Permissions.1.Priority"], "42");
        assert_eq!(params["Permissions.1.Policy"], "drop");
        assert_eq!(params["Permissions.1.PortStart"], "8080");
        assert_eq!(params["SecurityGroupId"], "sg-example");
        assert!(!params.contains_key("Protocol"));
        let mut invalid = fields.clone(); invalid.priority = 101;
        assert!(edit_params("cn-guangzhou", "sg-example", "sgr-example", &invalid).is_err());
        invalid = fields.clone(); invalid.source = "2001:db8::/64".into();
        assert!(edit_params("cn-guangzhou", "sg-example", "sgr-example", &invalid).is_err());
        assert!(edit_params("cn-guangzhou", "sg-example", "wrong-id", &fields).is_err());
    }

    #[test]
    fn edit_rejects_stale_missing_and_complex_rules() {
        let mut rule = json!({"SecurityGroupRuleId": "sgr-example", "Direction": "ingress", "Protocol": "tcp", "PortStart": 22, "PortEnd": 22, "CidrIp": "192.0.2.0/24", "Policy": "accept", "Priority": 5, "Description": "SSH"});
        let expected = current_fields(&rule).unwrap();
        assert!(ensure_unchanged(&[rule.clone()], "sgr-example", &expected).is_ok());
        rule["Priority"] = json!(10);
        assert!(ensure_unchanged(&[rule.clone()], "sgr-example", &expected).is_err());
        let expected = current_fields(&rule).unwrap();
        rule["SourcePortStart"] = json!(1000);
        assert!(ensure_unchanged(&[rule], "sgr-example", &expected).is_err());
        assert!(ensure_unchanged(&[], "sgr-example", &expected).is_err());
    }

    #[test]
    fn reference_and_ipv6_rules_preserve_source_kind() {
        for (source, key) in [("sg-other", "SourceGroupId"), ("pl-example", "PrefixListId"), ("2001:db8::/64", "CidrIp")] {
            let fields = RuleFields { protocol: "tcp".into(), ports: "8888/8888".into(), source: source.into(), description: "Example".into(), policy: "accept".into(), priority: 100 };
            let params = replacement_params("cn-guangzhou", "sg-example", &fields).unwrap();
            assert_eq!(params[key], source);
            assert_eq!(params.keys().filter(|k| ["SourceGroupId", "PrefixListId", "CidrIp"].contains(&k.as_str())).count(), 1);
            if key != "CidrIp" {
                assert_eq!(edit_params("cn-guangzhou", "sg-example", "sgr-example", &fields).unwrap()[&format!("Permissions.1.{key}")], source);
            }
        }
        let group = json!({"SecurityGroupRuleId":"sgr-example", "Direction":"ingress", "Protocol":"all", "PortStart":-1, "PortEnd":-1, "SourceGroupId":"sg-other", "Policy":"accept", "Priority":100});
        let fields = current_fields(&group).unwrap();
        assert_eq!(fields.source, "sg-other");
        assert!(ensure_unchanged(&[group.clone()], "sgr-example", &fields).is_ok());
        assert_eq!(normalize_rule(&group)["ReadOnly"], false);
        assert!(rule_params("cn-guangzhou", "sg-example", "all", "-1/-1", "sg-invalid/other", "accept", 1).is_err());
    }

    #[tokio::test]
    async fn replacement_orders_calls_and_restores_on_failure() {
        for fail_at in [None, Some(0), Some(1), Some(2)] {
            let original = crate::string_params(&[("CidrIp", "::/0".into()), ("PortStart", "22".into())]);
            let updated = crate::string_params(&[("CidrIp", "::/0".into()), ("PortStart", "80".into())]);
            let mut calls = Vec::new();
            let result = replace_with_restore(original.clone(), updated.clone(), |action, params| {
                let index = calls.len(); calls.push((action, params));
                std::future::ready(if fail_at == Some(index) || fail_at == Some(2) && index == 1 { Err("mock failure".into()) } else { Ok(json!({})) })
            }).await;
            assert_eq!(result.is_ok(), fail_at.is_none());
            assert_eq!(calls[0], ("RevokeSecurityGroupIngress", original.clone()));
            if fail_at != Some(0) { assert_eq!(calls[1], ("AuthorizeSecurityGroupIngress", updated)); }
            if matches!(fail_at, Some(1) | Some(2)) {
                assert_eq!(calls[2].0, "AuthorizeSecurityGroupIngress");
                assert_eq!(calls[2].1["PortStart"], original["PortStart"]);
                assert!(result.unwrap_err().contains(if fail_at == Some(1) { "已提交原规则恢复" } else { "恢复失败" }));
            }
        }
    }

    #[test]
    fn validates_power_actions_before_network_access() {
        let (action, params) = power_params("cn-guangzhou", "i-example", "reboot", true).unwrap();
        assert_eq!(action, "RebootInstance");
        assert_eq!(params["ForceStop"], "true");
        assert_eq!(params["InstanceId"], "i-example");
        assert_eq!(power_params("cn-guangzhou", "i-example", "start", false).unwrap().0, "StartInstance");
        assert!(power_params("bad/region", "i-example", "stop", false).is_err());
        assert!(power_params("cn-guangzhou", "i-example", "delete", false).is_err());
    }

    #[test]
    fn validates_rule_ports_cidr_and_priority() {
        let params = rule_params("cn-guangzhou", "sg-example", "tcp", "80/443", "192.0.2.0/24", "accept", 7).unwrap();
        assert_eq!(params["PortStart"], "80");
        assert_eq!(params["PortEnd"], "443");
        assert_eq!(params["Priority"], "7");
        assert_eq!(rule_params("cn-guangzhou", "sg-example", "tcp", "80/80", "192.0.2.0/24", "drop", 1).unwrap()["Policy"], "drop");
        assert!(rule_params("cn-guangzhou", "sg-example", "tcp", "80/80", "192.0.2.0/24", "invalid", 1).is_err());
        for (ports, cidr, priority) in [("0/80", "192.0.2.0/24", 1), ("443/80", "192.0.2.0/24", 1), ("80/80", "192.0.2.0/33", 1), ("80/80", "invalid/24", 1), ("80/80", "192.0.2.0/24", 101)] {
            assert!(rule_params("cn-guangzhou", "sg-example", "tcp", ports, cidr, "accept", priority).is_err());
        }
        assert!(rule_params("cn-guangzhou", "sg-example", "all", "-1/-1", "2001:db8::/64", "accept", 1).is_ok());
    }

    #[test]
    fn complex_security_rules_remain_read_only() {
        let rule = json!({"Direction": "ingress", "Protocol": "TCP", "PortStart": 80, "PortEnd": 80, "CidrIp": "192.0.2.0/24", "Policy": "accept", "Priority": 5});
        let simple = normalize_rule(&rule);
        assert_eq!(simple["PortRange"], "80/80");
        assert_eq!(simple["IpProtocol"], "tcp");
        assert_eq!(simple["ReadOnly"], false);
        let mut complex = rule;
        complex["SourcePortStart"] = json!(1000);
        assert_eq!(normalize_rule(&complex)["ReadOnly"], true);
    }
}
