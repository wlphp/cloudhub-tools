use crate::{
    account_cloud_type, account_credentials, array_at, string_params, write_api_log,
    ResourceResponse,
};
use chrono::Utc;
use serde_json::{json, Value};
use std::{collections::BTreeMap, net::Ipv4Addr};

pub(crate) async fn vultr_request(id: i64, path: &str, query: &BTreeMap<String, String>) -> Result<Value, String> {
    if account_cloud_type(id)? != "vultr" { return Err("当前账号不是 Vultr 账号".into()); }
    let (access_key_id, api_key) = account_credentials(id)?;
    let mut url = reqwest::Url::parse(&format!("https://api.vultr.com/v2/{path}"))
        .map_err(|error| format!("Vultr URL 无效: {error}"))?;
    url.query_pairs_mut().extend_pairs(query.iter().map(|(key, value)| (key.as_str(), value.as_str())));
    let response = reqwest::Client::new()
        .get(url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(30))
        .send().await.map_err(|error| format!("Vultr 请求失败: {error}"))?;
    let status = response.status();
    let data: Value = response.json().await.map_err(|error| format!("Vultr 返回解析失败: {error}"))?;
    let action = format!("GET /v2/{}", path.split('?').next().unwrap_or(path));
    if !status.is_success() {
        let message = data.get("error").and_then(Value::as_str)
            .or_else(|| data.get("message").and_then(Value::as_str))
            .or_else(|| data.pointer("/error/message").and_then(Value::as_str))
            .map(str::to_string).unwrap_or_else(|| format!("Vultr API 返回 HTTP {status}"));
        write_api_log(&access_key_id, "api.vultr.com", &action, &json!(query), Some(&data), "失败", Some(&message));
        return Err(message);
    }
    write_api_log(&access_key_id, "api.vultr.com", &action, &json!(query), Some(&data), "成功", None);
    Ok(data)
}

pub(crate) async fn vultr_mutation(id: i64, method: reqwest::Method, path: String, payload: Value) -> Result<Value, String> {
    if account_cloud_type(id)? != "vultr" { return Err("当前账号不是 Vultr 账号".into()); }
    let (access_key_id, api_key) = account_credentials(id)?;
    let action_label = format!("{} /v2/{path}", method.as_str());
    let response = reqwest::Client::new()
        .request(method, format!("https://api.vultr.com/v2/{path}"))
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .json(&payload)
        .timeout(std::time::Duration::from_secs(30))
        .send().await.map_err(|error| format!("Vultr 请求失败: {error}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|error| format!("Vultr 返回读取失败: {error}"))?;
    let data: Value = serde_json::from_str(&body).unwrap_or_else(|_| json!({"body": body}));
    if !status.is_success() {
        let message = data.get("error").and_then(Value::as_str)
            .or_else(|| data.get("message").and_then(Value::as_str))
            .or_else(|| data.pointer("/error/message").and_then(Value::as_str))
            .map(str::to_string).unwrap_or_else(|| format!("Vultr API 返回 HTTP {status}"));
        write_api_log(&access_key_id, "api.vultr.com", &action_label, &payload, Some(&data), "失败", Some(&message));
        return Err(message);
    }
    write_api_log(&access_key_id, "api.vultr.com", &action_label, &payload, Some(&data), "成功", None);
    Ok(data)
}

#[tauri::command]
pub(crate) async fn vultr_instance_action(id: i64, instance_id: String, action: String) -> Result<Value, String> {
    if instance_id.trim().is_empty() { return Err("缺少 Vultr 实例 ID".into()); }
    let endpoint = match action.as_str() {
        "start" => "start",
        "stop" => "halt",
        "reboot" => "reboot",
        _ => return Err("不支持的 Vultr 服务器操作".into()),
    };
    if account_cloud_type(id)? != "vultr" { return Err("当前账号不是 Vultr 账号".into()); }
    let (access_key_id, api_key) = account_credentials(id)?;
    let path = format!("instances/{instance_id}/{endpoint}");
    let payload = json!({});
    let response = reqwest::Client::new()
        .post(format!("https://api.vultr.com/v2/{path}"))
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .json(&payload)
        .timeout(std::time::Duration::from_secs(30))
        .send().await.map_err(|error| format!("Vultr 请求失败: {error}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|error| format!("Vultr 返回读取失败: {error}"))?;
    let data: Value = serde_json::from_str(&body).unwrap_or_else(|_| json!({"body": body}));
    let log_action = format!("POST /v2/{path}");
    if !status.is_success() {
        let message = data.get("error").and_then(Value::as_str)
            .or_else(|| data.get("message").and_then(Value::as_str))
            .or_else(|| data.pointer("/error/message").and_then(Value::as_str))
            .map(str::to_string).unwrap_or_else(|| format!("Vultr API 返回 HTTP {status}"));
        write_api_log(&access_key_id, "api.vultr.com", &log_action, &payload, Some(&data), "失败", Some(&message));
        return Err(message);
    }
    write_api_log(&access_key_id, "api.vultr.com", &log_action, &payload, Some(&data), "成功", None);
    Ok(data)
}

#[tauri::command]
pub(crate) async fn vultr_instance_manage(id: i64, instance_id: String, action: String, value: Option<String>) -> Result<Value, String> {
    if instance_id.trim().is_empty() { return Err("缺少 Vultr 实例 ID".into()); }
    if account_cloud_type(id)? != "vultr" { return Err("当前账号不是 Vultr 账号".into()); }
    let instance_id = instance_id.trim();
    let value = value.unwrap_or_default().trim().to_string();
    let (method, path, payload) = match action.as_str() {
        "snapshot" => (reqwest::Method::POST, "snapshots".to_string(), json!({"instance_id": instance_id, "description": value})),
        "label" if !value.is_empty() => (reqwest::Method::PATCH, format!("instances/{instance_id}"), json!({"label": value})),
        "tags" => (reqwest::Method::PATCH, format!("instances/{instance_id}"), json!({"tags": value.split(',').map(str::trim).filter(|tag| !tag.is_empty()).collect::<Vec<_>>() })),
        "enable_backups" => (reqwest::Method::PATCH, format!("instances/{instance_id}"), json!({"backups": "enabled"})),
        "disable_backups" => (reqwest::Method::PATCH, format!("instances/{instance_id}"), json!({"backups": "disabled"})),
        "enable_ddos" => (reqwest::Method::PATCH, format!("instances/{instance_id}"), json!({"ddos_protection": true})),
        "disable_ddos" => (reqwest::Method::PATCH, format!("instances/{instance_id}"), json!({"ddos_protection": false})),
        "enable_ipv6" => (reqwest::Method::PATCH, format!("instances/{instance_id}"), json!({"enable_ipv6": true})),
        "firewall" if !value.is_empty() => (reqwest::Method::PATCH, format!("instances/{instance_id}"), json!({"firewall_group_id": value})),
        _ => return Err("不支持的 Vultr 实例管理操作，或缺少必要参数".into()),
    };
    let (access_key_id, api_key) = account_credentials(id)?;
    let action_label = format!("{} /v2/{path}", method.as_str());
    let response = reqwest::Client::new()
        .request(method, format!("https://api.vultr.com/v2/{path}"))
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .json(&payload)
        .timeout(std::time::Duration::from_secs(30))
        .send().await.map_err(|error| format!("Vultr 请求失败: {error}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|error| format!("Vultr 返回读取失败: {error}"))?;
    let data: Value = serde_json::from_str(&body).unwrap_or_else(|_| json!({"body": body}));
    if !status.is_success() {
        let message = data.get("error").and_then(Value::as_str)
            .or_else(|| data.get("message").and_then(Value::as_str))
            .or_else(|| data.pointer("/error/message").and_then(Value::as_str))
            .map(str::to_string).unwrap_or_else(|| format!("Vultr API 返回 HTTP {status}"));
        write_api_log(&access_key_id, "api.vultr.com", &action_label, &payload, Some(&data), "失败", Some(&message));
        return Err(message);
    }
    write_api_log(&access_key_id, "api.vultr.com", &action_label, &payload, Some(&data), "成功", None);
    Ok(data)
}

pub(crate) fn vultr_firewall_rule_input(ip_protocol: String, port: String, source_cidr_ip: String, description: Option<String>) -> Result<Value, String> {
    let protocol = ip_protocol.trim().to_ascii_lowercase();
    if !matches!(protocol.as_str(), "tcp" | "udp") { return Err("Vultr 防火墙端口仅支持 TCP 或 UDP".into()); }
    let port = port.trim().to_string();
    let (start, end) = match port.split_once('-') {
        Some((start, end)) => (start.parse::<u16>(), end.parse::<u16>()),
        None => (port.parse::<u16>(), port.parse::<u16>()),
    };
    let (Ok(start), Ok(end)) = (start, end) else { return Err("端口格式无效，请使用 80 或 8000-9000".into()); };
    if start == 0 || end < start { return Err("端口范围必须在 1 到 65535 之间".into()); }
    let source = source_cidr_ip.trim();
    let Some((subnet, subnet_size)) = source.split_once('/') else { return Err("来源地址必须是 IPv4 CIDR，例如 0.0.0.0/0".into()); };
    subnet.parse::<Ipv4Addr>().map_err(|_| "来源地址必须是有效 IPv4 CIDR，例如 0.0.0.0/0".to_string())?;
    let subnet_size = subnet_size.parse::<u8>().map_err(|_| "来源地址必须是有效 IPv4 CIDR，例如 0.0.0.0/0".to_string())?;
    if subnet_size > 32 { return Err("IPv4 CIDR 掩码必须在 0 到 32 之间".into()); }
    let mut payload = json!({"ip_type": "v4", "protocol": protocol, "subnet": subnet, "subnet_size": subnet_size, "port": port});
    if let Some(notes) = description.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) {
        payload["notes"] = json!(notes);
    }
    Ok(payload)
}

pub(crate) fn vultr_firewall_rules(data: &Value) -> Vec<Value> {
    array_at(data, &["firewall_rules"]).into_iter().filter_map(|rule| {
        if rule.get("ip_type").and_then(Value::as_str).is_some_and(|ip_type| ip_type != "v4") { return None; }
        let subnet = rule.get("subnet").and_then(Value::as_str).unwrap_or("");
        let subnet_size = rule.get("subnet_size").and_then(Value::as_i64);
        let source = rule.get("source").and_then(Value::as_str).filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| subnet_size.map(|size| format!("{subnet}/{size}")).unwrap_or_else(|| subnet.to_string()));
        Some(json!({
            "RuleId": vultr_value(rule, &["id"]),
            "IpProtocol": vultr_value(rule, &["protocol"]),
            "PortRange": vultr_value(rule, &["port"]),
            "SourceCidrIp": source,
            "Description": vultr_value(rule, &["notes"]),
        }))
    }).collect()
}

#[tauri::command]
pub async fn list_vultr_firewall_rules(id: i64, firewall_group_id: String) -> Result<Value, String> {
    let firewall_group_id = firewall_group_id.trim();
    if firewall_group_id.is_empty() { return Err("缺少 Vultr 防火墙组 ID".into()); }
    let data = vultr_request(id, &format!("firewalls/{firewall_group_id}/rules"), &BTreeMap::new()).await?;
    Ok(json!({"rules": vultr_firewall_rules(&data)}))
}

#[tauri::command]
pub async fn create_vultr_firewall_rule(id: i64, firewall_group_id: String, ip_protocol: String, port: String, source_cidr_ip: String, description: Option<String>) -> Result<Value, String> {
    let firewall_group_id = firewall_group_id.trim();
    if firewall_group_id.is_empty() { return Err("缺少 Vultr 防火墙组 ID".into()); }
    let payload = vultr_firewall_rule_input(ip_protocol, port, source_cidr_ip, description)?;
    vultr_mutation(id, reqwest::Method::POST, format!("firewalls/{firewall_group_id}/rules"), payload).await
}

#[tauri::command]
pub async fn delete_vultr_firewall_rule(id: i64, firewall_group_id: String, rule_id: String) -> Result<Value, String> {
    let firewall_group_id = firewall_group_id.trim();
    let rule_id = rule_id.trim();
    if firewall_group_id.is_empty() || rule_id.is_empty() { return Err("缺少 Vultr 防火墙组 ID 或规则 ID".into()); }
    vultr_mutation(id, reqwest::Method::DELETE, format!("firewalls/{firewall_group_id}/rules/{rule_id}"), json!({})).await
}

pub(crate) fn vultr_cursor(next: &str) -> Option<String> {
    next.split('?').nth(1)?.split('&').find_map(|entry| {
        let (key, value) = entry.split_once('=')?;
        (key == "cursor" && !value.is_empty()).then(|| value.to_string())
    })
}

pub(crate) async fn vultr_pages(id: i64, path: &str, item_key: &str) -> Result<Vec<Value>, String> {
    let mut query = string_params(&[("per_page", "100".into())]);
    let mut items = Vec::new();
    for _ in 0..100 {
        let data = vultr_request(id, path, &query).await?;
        let page = array_at(&data, &[item_key]);
        let count = page.len();
        items.extend(page.into_iter().cloned());
        let next = data.pointer("/meta/links/next").and_then(Value::as_str).unwrap_or("");
        let Some(cursor) = vultr_cursor(next) else { break };
        if count == 0 { break; }
        query.insert("cursor".into(), cursor);
    }
    Ok(items)
}

pub(crate) fn vultr_value(item: &Value, keys: &[&str]) -> Value {
    keys.iter().find_map(|key| item.get(*key).filter(|value| !value.is_null()).cloned()).unwrap_or(json!(""))
}

pub(crate) fn vultr_instance(item: &Value) -> Value {
    json!({
        "InstanceId": vultr_value(item, &["id"]),
        "InstanceName": vultr_value(item, &["label", "hostname", "id"]),
        "Status": vultr_value(item, &["status"]),
        "InstanceStatus": vultr_value(item, &["status"]),
        "PublicIpAddress": vultr_value(item, &["main_ip"]),
        "PrivateIpAddress": vultr_value(item, &["internal_ip"]),
        "InstanceType": vultr_value(item, &["plan"]),
        "Cpu": vultr_value(item, &["vcpu_count"]),
        "Memory": vultr_value(item, &["ram"]),
        "Disk": vultr_value(item, &["disk"]),
        "OSName": vultr_value(item, &["os"]),
        "Hostname": vultr_value(item, &["hostname"]),
        "Region": vultr_value(item, &["region"]),
        "AllowedBandwidth": vultr_value(item, &["allowed_bandwidth"]),
        "NetmaskV4": vultr_value(item, &["netmask_v4"]),
        "GatewayV4": vultr_value(item, &["gateway_v4"]),
        "V6MainIp": vultr_value(item, &["v6_main_ip"]),
        "PowerStatus": vultr_value(item, &["power_status"]),
        "ServerStatus": vultr_value(item, &["server_status"]),
        "Backups": vultr_value(item, &["backups"]),
        "DdosProtection": vultr_value(item, &["ddos_protection"]),
        "VpcIds": vultr_value(item, &["vpc2_ids"]),
        "FirewallGroupId": vultr_value(item, &["firewall_group_id"]),
        "Tags": vultr_value(item, &["tags"]),
        "CreationTime": vultr_value(item, &["date_created"]),
        "_region_id": vultr_value(item, &["region"]),
        "_raw": item,
    })
}

pub(crate) fn vultr_domain(item: &Value) -> Value {
    json!({
        "DomainName": vultr_value(item, &["domain"]), "DomainStatus": "ACTIVE",
        "RecordCount": 0, "RegistrationDate": vultr_value(item, &["date_created"]),
        "DnsSec": vultr_value(item, &["dns_sec"]), "ZoneId": vultr_value(item, &["domain"]),
        "_region_id": "global", "_raw": item,
    })
}

pub(crate) fn vultr_object_storage(item: &Value) -> Value {
    json!({
        "AssetId": vultr_value(item, &["id", "cluster_id"]), "Name": vultr_value(item, &["label", "cluster_id", "id"]),
        "BucketName": vultr_value(item, &["label", "cluster_id", "id"]), "Status": vultr_value(item, &["status"]),
        "Location": vultr_value(item, &["region"]), "CreationDate": vultr_value(item, &["date_created"]),
        "StorageClass": vultr_value(item, &["plan"]), "_region_id": vultr_value(item, &["region"]), "_raw": item,
    })
}

pub(crate) fn vultr_database(item: &Value) -> Value {
    json!({
        "DBInstanceId": vultr_value(item, &["id"]), "DBInstanceDescription": vultr_value(item, &["label", "id"]),
        "DBInstanceStatus": vultr_value(item, &["status"]), "DBInstanceClass": vultr_value(item, &["plan"]),
        "ConnectionString": vultr_value(item, &["host"]), "Port": vultr_value(item, &["port"]),
        "Engine": vultr_value(item, &["database_engine"]), "EngineVersion": vultr_value(item, &["database_engine_version"]),
        "CreateTime": vultr_value(item, &["date_created"]), "VpcId": vultr_value(item, &["vpc_id"]),
        "_region_id": vultr_value(item, &["region"]), "_raw": item,
    })
}

pub(crate) fn vultr_inventory_item(item: &Value, resource_type: &str) -> Value {
    let (name, region, status) = match resource_type {
        "block" => (vultr_value(item, &["label", "id"]), vultr_value(item, &["region"]), vultr_value(item, &["status"])),
        "network" => (vultr_value(item, &["description", "id"]), vultr_value(item, &["region"]), json!("active")),
        "firewall" => (vultr_value(item, &["description", "id"]), json!("global"), json!("active")),
        "ip" => (vultr_value(item, &["label", "subnet", "id"]), vultr_value(item, &["region"]), json!("active")),
        "loadbalancer" => (vultr_value(item, &["label", "id"]), vultr_value(item, &["region"]), vultr_value(item, &["status"])),
        "snapshot" => (vultr_value(item, &["description", "id"]), vultr_value(item, &["region"]), vultr_value(item, &["status"])),
        "kubernetes" => (vultr_value(item, &["label", "id"]), vultr_value(item, &["region"]), vultr_value(item, &["status"])),
        _ => (vultr_value(item, &["label", "description", "id"]), vultr_value(item, &["region"]), vultr_value(item, &["status"])),
    };
    json!({
        "AssetId": vultr_value(item, &["id"]), "Name": name, "Status": status, "RegionId": region,
        "IpAddress": vultr_value(item, &["ip", "instance_ip"]), "SizeGb": vultr_value(item, &["size_gb"]),
        "AttachedTo": vultr_value(item, &["attached_to_instance", "instance_id"]), "VpcId": vultr_value(item, &["vpc2_id", "vpc_id"]),
        "CreatedAt": vultr_value(item, &["date_created"]), "Tags": vultr_value(item, &["tags"]),
        "_region_id": vultr_value(item, &["region"]), "_raw": item,
    })
}

pub(crate) fn vultr_block(item: &Value) -> Value { vultr_inventory_item(item, "block") }
pub(crate) fn vultr_network(item: &Value) -> Value { vultr_inventory_item(item, "network") }
pub(crate) fn vultr_firewall(item: &Value) -> Value { vultr_inventory_item(item, "firewall") }
pub(crate) fn vultr_ip(item: &Value) -> Value { vultr_inventory_item(item, "ip") }
pub(crate) fn vultr_loadbalancer(item: &Value) -> Value { vultr_inventory_item(item, "loadbalancer") }
pub(crate) fn vultr_snapshot(item: &Value) -> Value { vultr_inventory_item(item, "snapshot") }
pub(crate) fn vultr_kubernetes(item: &Value) -> Value { vultr_inventory_item(item, "kubernetes") }

pub(crate) async fn vultr_resource_items(id: i64, resource_type: &str) -> ResourceResponse {
    let now = Utc::now().timestamp_millis();
    let definition = match resource_type {
        "ecs" => Some(("instances", "instances", vultr_instance as fn(&Value) -> Value)),
        "domain" => Some(("domains", "domains", vultr_domain as fn(&Value) -> Value)),
        "oss" => Some(("object-storage", "object_storages", vultr_object_storage as fn(&Value) -> Value)),
        "rds" => Some(("databases", "databases", vultr_database as fn(&Value) -> Value)),
        "block" => Some(("blocks", "blocks", vultr_block as fn(&Value) -> Value)),
        "network" => Some(("vpc2", "vpc2", vultr_network as fn(&Value) -> Value)),
        "firewall" => Some(("firewalls", "firewall_groups", vultr_firewall as fn(&Value) -> Value)),
        "ip" => Some(("reserved-ips", "reserved_ips", vultr_ip as fn(&Value) -> Value)),
        "loadbalancer" => Some(("load-balancers", "load_balancers", vultr_loadbalancer as fn(&Value) -> Value)),
        "snapshot" => Some(("snapshots", "snapshots", vultr_snapshot as fn(&Value) -> Value)),
        "kubernetes" => Some(("kubernetes/clusters", "vke_clusters", vultr_kubernetes as fn(&Value) -> Value)),
        _ => None,
    };
    let Some((path, key, normalize)) = definition else {
        return ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![format!("Vultr 暂未接入 {resource_type} 资源")], fetched_at: now };
    };
    match vultr_pages(id, path, key).await {
        Ok(items) => ResourceResponse { resource_type: resource_type.into(), items: items.iter().map(normalize).collect(), errors: vec![], fetched_at: now },
        Err(error) => ResourceResponse { resource_type: resource_type.into(), items: vec![], errors: vec![error], fetched_at: now },
    }
}

#[tauri::command]
pub async fn verify_vultr_account(id: i64) -> Result<Value, String> {
    let account = vultr_request(id, "account", &BTreeMap::new()).await?;
    let regions = vultr_pages(id, "regions", "regions").await?;
    let region_ids = regions.iter().filter_map(|item| item.get("id").and_then(Value::as_str).map(String::from)).collect::<Vec<_>>();
    Ok(json!({
        "provider": "vultr", "verified": true, "region_count": region_ids.len(), "regions": region_ids,
        "default_region": regions.first().and_then(|item| item.get("id")).cloned().unwrap_or(json!("ewr")),
        "account": account.get("account").cloned().unwrap_or(account),
    }))
}
