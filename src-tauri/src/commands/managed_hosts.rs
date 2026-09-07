use crate::core::{repositories::managed_hosts as managed_host_repository, storage::open_db};
use crate::core::error::PlatformResult;
use crate::{decrypt_secret, encrypt_secret, ExportManagedHost, ImportManagedHost, ManagedHost, ManagedHostInput};
use crate::{authenticate_ssh, managed_host_saved_connection, SshCredentials, SshHostKeyHandler};
use chrono::Utc;
use russh::{client, ChannelMsg};
use serde_json::json;
use std::{collections::HashMap, path::PathBuf, sync::{Arc, Mutex}, time::Instant};

#[tauri::command]
pub(crate) fn list_managed_hosts() -> PlatformResult<Vec<ManagedHost>> { managed_host_repository::list(&open_db()?).map_err(Into::into) }

#[tauri::command]
pub(crate) fn delete_managed_host(id: i64) -> PlatformResult<()> { managed_host_repository::delete(&open_db()?, id).map_err(Into::into) }


#[tauri::command]
pub(crate) fn export_managed_hosts_file() -> PlatformResult<String> {
    let conn = open_db()?;
    let rows = managed_host_repository::export_rows(&conn)?;
    let mut hosts = Vec::new();
    for row in rows {
        let decrypt_optional = |value: Option<String>| value.filter(|item| !item.is_empty()).map(|item| decrypt_secret(&item)).transpose();
        hosts.push(ExportManagedHost { name: row.name, host: row.host, port: row.port, username: row.username, platform: row.platform, auth_method: row.auth_method, password: decrypt_optional(row.password_ciphertext)?, private_key: decrypt_optional(row.private_key_ciphertext)?, key_passphrase: decrypt_optional(row.key_passphrase_ciphertext)?, group_name: row.group_name, tags: row.tags, source_account_id: row.source_account_id, source_asset_key: row.source_asset_key, remark: row.remark });
    }
    if hosts.is_empty() { return Err("没有可导出的服务器".into()); }
    let base = dirs::home_dir().unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let desktop = base.join("Desktop");
    let dir = if desktop.exists() { desktop } else { base };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("cloudhub-tools-terminal-hosts-{}.json", Utc::now().format("%Y%m%d-%H%M%S")));
    let payload = json!({
        "format": "cloudhub-tools-managed-host-export",
        "version": 1,
        "encryption": "plaintext",
        "credentials_exported": true,
        "exported_at": Utc::now().to_rfc3339(),
        "hosts": hosts,
    });
    std::fs::write(&path, serde_json::to_vec_pretty(&payload).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub(crate) fn import_managed_hosts(hosts: Vec<ImportManagedHost>) -> PlatformResult<usize> {
    if hosts.is_empty() { return Err("导入文件中没有服务器配置".into()); }
    let conn = open_db()?;
    let now = Utc::now().timestamp_millis();
    let mut imported = 0usize;
    for (index, host) in hosts.into_iter().enumerate() {
        let name = host.name.trim();
        let address = host.host.trim();
        let username = host.username.trim();
        let platform = host.platform.as_deref().unwrap_or("linux");
        if !matches!(platform, "linux" | "windows") { return Err(format!("第 {} 条服务器的操作系统类型不支持", index + 1).into()); }
        let auth_method = if platform == "linux" { host.auth_method.as_deref().unwrap_or("password") } else { "password" };
        if !matches!(auth_method, "password" | "private_key") { return Err(format!("第 {} 条服务器的 Linux 验证方式不支持", index + 1).into()); }
        if name.is_empty() || address.is_empty() || username.is_empty() { return Err(format!("第 {} 条服务器缺少名称、主机地址或用户名", index + 1).into()); }
        let port = host.port.unwrap_or(if platform == "windows" { 3389 } else { 22 }).max(1);
        let password = host.password.as_deref().map(str::trim).filter(|value| !value.is_empty());
        let private_key = host.private_key.as_deref().map(str::trim).filter(|value| !value.is_empty());
        if platform == "linux" && auth_method == "password" && password.is_none() { return Err(format!("第 {} 条 Linux 服务器缺少 SSH 密码", index + 1).into()); }
        if platform == "linux" && auth_method == "private_key" && private_key.is_none() { return Err(format!("第 {} 条 Linux 服务器缺少 SSH 私钥", index + 1).into()); }
        let password_ciphertext = if auth_method == "private_key" { String::new() } else { password.map(encrypt_secret).transpose()?.unwrap_or_default() };
        let private_key_ciphertext = if auth_method == "private_key" { private_key.map(encrypt_secret).transpose()? } else { None };
        let key_passphrase_ciphertext = if auth_method == "private_key" { host.key_passphrase.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(encrypt_secret).transpose()? } else { None };
        let existing_id = managed_host_repository::id_by_endpoint(&conn, address, port, username)?;
        match existing_id {
            Some(id) => managed_host_repository::import_update(&conn, id, name, platform, auth_method, &password_ciphertext, private_key_ciphertext.as_deref(), key_passphrase_ciphertext.as_deref(), host.group_name.as_deref(), host.tags.as_deref(), host.source_account_id, host.source_asset_key.as_deref(), host.remark.as_deref(), now)?,
            None => managed_host_repository::import_insert(&conn, name, address, port, username, platform, auth_method, &password_ciphertext, private_key_ciphertext.as_deref(), key_passphrase_ciphertext.as_deref(), host.group_name.as_deref(), host.tags.as_deref(), host.source_account_id, host.source_asset_key.as_deref(), host.remark.as_deref(), now)?,
        };
        imported += 1;
    }
    Ok(imported)
}

#[tauri::command]
pub(crate) fn save_managed_host(input: ManagedHostInput) -> PlatformResult<ManagedHost> {
    let name = input.name.trim(); let host = input.host.trim(); let username = input.username.trim();
    let platform = input.platform.as_deref().unwrap_or("linux");
    if !matches!(platform, "linux" | "windows") { return Err("不支持的操作系统类型".into()); }
    let auth_method = if platform == "linux" { input.auth_method.as_deref().unwrap_or("password") } else { "password" };
    if !matches!(auth_method, "password" | "private_key") { return Err("不支持的 Linux 验证方式".into()); }
    if name.is_empty() || host.is_empty() || username.is_empty() { return Err(format!("请填写服务器名称、主机地址和 {}用户名", if platform == "windows" { "RDP " } else { "SSH " }).into()); }
    let port = input.port.unwrap_or(if platform == "windows" { 3389 } else { 22 }).max(1);
    let conn = open_db()?; let now = Utc::now().timestamp_millis();
    let existing = input.id.map(|id| managed_host_repository::existing_secrets(&conn, id)).transpose()?.flatten();
    let password_secret = input.password.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(encrypt_secret).transpose()?.or_else(|| existing.as_ref().and_then(|value| value.0.clone()));
    let has_new_key = input.private_key.as_deref().is_some_and(|value| !value.trim().is_empty());
    let private_key_secret = if auth_method == "private_key" {
        input.private_key.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(encrypt_secret).transpose()?.or_else(|| existing.as_ref().and_then(|value| value.1.clone()))
    } else { None };
    let key_passphrase_secret = if auth_method == "private_key" {
        if has_new_key || input.key_passphrase.is_some() { input.key_passphrase.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(encrypt_secret).transpose()? } else { existing.as_ref().and_then(|value| value.2.clone()) }
    } else { None };
    if platform == "linux" && auth_method == "password" && password_secret.as_deref().is_none_or(str::is_empty) { return Err("首次添加 Linux 服务器需要填写 SSH 密码".into()); }
    if platform == "linux" && auth_method == "private_key" && private_key_secret.as_deref().is_none_or(str::is_empty) { return Err("首次添加 Linux 服务器需要粘贴 SSH 私钥".into()); }
    let password_value = if auth_method == "private_key" { String::new() } else { password_secret.unwrap_or_default() };
    Ok(managed_host_repository::save(&conn, &input, name, host, username, platform, auth_method, port, &password_value, private_key_secret.as_deref(), key_passphrase_secret.as_deref(), now)?)
}
#[tauri::command]
pub(crate) async fn probe_managed_host(id: i64) -> PlatformResult<ManagedHost> {
    let saved = managed_host_saved_connection(id)?.ok_or("服务器不存在")?;
    if saved.platform == "windows" { return Err("Windows 服务器请通过 RDP 打开，暂不支持 SSH 状态检测".into()); }
    let host = saved.host.clone(); let port = saved.port; let username = saved.username.clone(); let known_fingerprint = saved.host_key_fingerprint.clone();
    let credentials = if saved.auth_method == "private_key" {
        let key_ciphertext = saved.private_key_ciphertext.as_deref().filter(|value| !value.is_empty()).ok_or_else(|| "服务器未保存 SSH 私钥".to_string())?;
        let key = decrypt_secret(key_ciphertext)?;
        let passphrase = saved.key_passphrase_ciphertext.as_deref().filter(|value| !value.is_empty()).map(decrypt_secret).transpose()?;
        SshCredentials::PrivateKey { key, passphrase }
    } else { SshCredentials::Password(decrypt_secret(saved.password_ciphertext.as_deref().filter(|value| !value.is_empty()).ok_or("服务器未保存 SSH 密码")?)?) };
    let started = Instant::now(); let observed_fingerprint = Arc::new(Mutex::new(None));
    let handler = SshHostKeyHandler { expected_fingerprint: known_fingerprint, observed_fingerprint: observed_fingerprint.clone() };
    let attempt = async {
        let config = Arc::new(client::Config::default());
        let mut session = client::connect(config, (host.as_str(), port), handler).await.map_err(|error| format!("连接 SSH 主机失败: {error}"))?;
        let fingerprint = observed_fingerprint.lock().map_err(|_| "SSH 主机密钥状态不可用".to_string())?.clone().ok_or("无法读取 SSH 主机密钥")?;
        authenticate_ssh(&mut session, &username, &credentials, "探测").await?;
        let mut channel = session.channel_open_session().await.map_err(|error| format!("打开 SSH 会话失败: {error}"))?;
        let command = r#"net_bytes(){ awk 'NR>2 {gsub(\":\",\"\",$1); rx+=$2; tx+=$10} END {print tx+0\" \"rx+0}' /proc/net/dev; }; disk_stats(){ awk '$3 ~ /^[sv]d[a-z]+$/ || $3 ~ /^nvme[0-9]+n[0-9]+$/ {rb += $6*512; wb += $10*512; ri += $4; wi += $8; rt += $7; wt += $11} END {print rb+0\" \"wb+0\" \"ri+0\" \"wi+0\" \"rt+0\" \"wt+0}' /proc/diskstats; }; net1=$(net_bytes); disk1=$(disk_stats); printf '\n'; printf 'hostname='; hostname; printf '\n'; printf '\n'; printf '\n'; printf 'ip='; hostname -I 2>/dev/null | awk '{print $1}'; printf '\n'; printf '\n'; printf 'os_name='; if [ -r /etc/os-release ]; then . /etc/os-release 2>/dev/null; printf '%s' "${PRETTY_NAME:-}"; fi; printf '\n'; printf '\n'; printf '\n'; printf 'os='; uname -sr; printf '\n'; printf '\n'; printf '\n'; printf 'uptime='; uptime -p 2>/dev/null || uptime; printf '\n'; printf '\n'; printf '\n'; printf 'load='; awk '{print $1\" / \"$2\" / \"$3}' /proc/loadavg 2>/dev/null; printf '\n'; printf '\n'; printf '\n'; printf 'processes='; ps -e --no-headers 2>/dev/null | wc -l; printf '\n'; printf '\n'; printf '\n'; printf 'active_processes='; ps -eo stat= 2>/dev/null | awk '$1 ~ /^R/ {n++} END {print n+0}'; printf '\n'; printf '\n'; printf '\n'; printf 'cpu_cores='; nproc 2>/dev/null || grep -c processor /proc/cpuinfo 2>/dev/null; printf '\n'; printf '\n'; printf '\n'; printf 'cpu_model='; awk -F: '/model name|Hardware|Processor/{gsub(/^ +/,\"\",$2); print $2; exit}' /proc/cpuinfo 2>/dev/null; printf '\n'; printf '\n'; printf '\n'; printf 'cpu_usage='; vmstat 1 2 2>/dev/null | tail -1 | awk '{print 100-$15}'; printf '\n'; printf '\n'; printf '\n'; printf 'memory='; if command -v free >/dev/null 2>&1; then free -b | awk '/^Mem:/ {print $2 \",\" $3}'; else awk '/MemTotal:/{t=$2} /MemAvailable:/{a=$2} END{print t*1024 \",\" (t-a)*1024}' /proc/meminfo; fi; printf '\n'; printf '\n'; printf '\n'; printf 'swap='; if command -v free >/dev/null 2>&1; then free -b | awk '/^Swap:/ {print $2 \",\" $3}'; else awk '/SwapTotal:/{t=$2} /SwapFree:/{f=$2} END{print t*1024 \",\" (t-f)*1024}' /proc/meminfo; fi; printf '\n'; printf '\n'; printf '\n'; printf 'disk='; df -B1 / 2>/dev/null | awk 'NR==2 {print $2 \",\" $3}'; printf '\n'; net2=$(net_bytes); disk2=$(disk_stats); printf '\n'; printf '\n'; printf 'network_rate='; awk -v a=\"$net1\" -v b=\"$net2\" 'BEGIN {split(a,x); split(b,y); print int(y[1]-x[1])\",\"int(y[2]-x[2])}' ; printf '\n'; printf '\n'; printf 'network_total='; echo \"$net2\" | awk '{print $1\",\"$2}'; printf '\n'; printf '\n'; printf 'disk_io_rate='; awk -v a=\"$disk1\" -v b=\"$disk2\" 'BEGIN {split(a,x); split(b,y); print int(y[1]-x[1])\",\"int(y[2]-x[2])\",\"int(y[3]-x[3]+y[4]-x[4])}' ; printf '\n'; printf '\n'; printf 'disk_io_total='; echo \"$disk2\" | awk '{print $1\",\"$2}'"#;
        channel.exec(true, command).await.map_err(|error| format!("读取服务器状态失败: {error}"))?;
        let mut output = Vec::new();
        while let Some(message) = channel.wait().await { if let ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } = message { output.extend_from_slice(&data); } }
        let _ = session.disconnect(russh::Disconnect::ByApplication, "Host health probe complete", "en").await;
        Ok::<(String, String), String>((fingerprint, String::from_utf8_lossy(&output).to_string()))
    }.await;
    let conn = open_db()?; let now = Utc::now().timestamp_millis();
    match attempt {
        Ok((fingerprint, output)) => {
            let values = output.lines().filter_map(|line| line.split_once('=')).map(|(key, value)| (key.trim(), value.trim())).collect::<HashMap<_, _>>();
            let metric_pair = |key: &str| values.get(key).and_then(|value| value.split_once(',')).map(|(total, used)| { let total = total.trim().parse::<u64>().unwrap_or(0); let used = used.trim().parse::<u64>().unwrap_or(0); if total == 0 { json!(null) } else { json!({"total": total, "used": used}) } }).unwrap_or_else(|| json!(null));
            let metric_value = |key: &str| values.get(key).and_then(|value| value.parse::<u64>().ok()).unwrap_or(0);
            let metric_at = |key: &str, index: usize| values.get(key).and_then(|value| value.split(',').nth(index)).and_then(|value| value.trim().parse::<u64>().ok()).unwrap_or(0);
            let metrics = json!({"hostname": values.get("hostname").copied().unwrap_or(""), "ip": values.get("ip").copied().unwrap_or(""), "os": values.get("os_name").or_else(|| values.get("os")).copied().unwrap_or(""), "kernel": values.get("os").copied().unwrap_or(""), "uptime": values.get("uptime").copied().unwrap_or(""), "load": values.get("load").copied().unwrap_or(""), "processes": metric_value("processes"), "active_processes": metric_value("active_processes"), "cpu": {"cores": metric_value("cpu_cores"), "model": values.get("cpu_model").copied().unwrap_or(""), "usage": values.get("cpu_usage").and_then(|value| value.parse::<f64>().ok()).unwrap_or(0.0)}, "memory": metric_pair("memory"), "swap": metric_pair("swap"), "disk": metric_pair("disk"), "network": {"up_rate": metric_at("network_rate", 0), "down_rate": metric_at("network_rate", 1), "up_total": metric_at("network_total", 0), "down_total": metric_at("network_total", 1)}, "disk_io": {"read": metric_at("disk_io_total", 0), "write": metric_at("disk_io_total", 1), "read_rate": metric_at("disk_io_rate", 0), "write_rate": metric_at("disk_io_rate", 1), "iops": metric_at("disk_io_rate", 2), "latency": 0}});
            managed_host_repository::mark_probe_success(&conn, id, &fingerprint, started.elapsed().as_millis() as i64, &serde_json::to_string(&metrics).map_err(|e| e.to_string())?, now)?;
        }
        Err(error) => {
            managed_host_repository::mark_probe_failure(&conn, id, &error, now)?;
        }
    }
    Ok(managed_host_repository::get(&conn, id)?)
}
