use super::{clean, Device, Interface};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Read,
    net::Ipv4Addr,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn private(ip: Ipv4Addr) -> bool {
    ip.is_private()
}

pub fn subnet(ip: Ipv4Addr, prefix: u8) -> Result<(u32, u32), String> {
    if prefix > 32 {
        return Err("网卡子网前缀无效".into());
    }
    let mask = u32::MAX.checked_shl(32 - prefix as u32).unwrap_or(0);
    let network = u32::from(ip) & mask;
    Ok((network, network | !mask))
}

/// Only explicit IPs, CIDR or a pair of full IPs; never hostnames or shell syntax.
pub fn targets(range: &str, interface: &Interface) -> Result<Vec<Ipv4Addr>, String> {
    let source: Ipv4Addr = interface.ip.parse().map_err(|_| "网卡地址无效")?;
    let (network, broadcast) = subnet(source, interface.prefix)?;
    let parse = |s: &str| {
        s.trim()
            .parse::<Ipv4Addr>()
            .map(u32::from)
            .map_err(|_| "请输入 IPv4、CIDR 或完整起止 IP".to_string())
    };
    if range.len() > 100 {
        return Err("扫描范围过长".into());
    }
    let (start, end) = if let Some((ip, prefix)) = range.split_once('/') {
        let prefix: u8 = prefix.parse().map_err(|_| "CIDR 前缀无效")?;
        let (a, b) = subnet(Ipv4Addr::from(parse(ip)?), prefix)?;
        if prefix < 31 {
            (a.saturating_add(1), b.saturating_sub(1))
        } else {
            (a, b)
        }
    } else if let Some((start, end)) = range.split_once('-') {
        (parse(start)?, parse(end)?)
    } else {
        let ip = parse(range)?;
        (ip, ip)
    };
    if start > end || end as u64 - start as u64 + 1 > 1024 {
        return Err("每次扫描须为 1–1024 个地址，请缩小范围".into());
    }
    if start < network
        || end > broadcast
        || !private(Ipv4Addr::from(start))
        || !private(Ipv4Addr::from(end))
    {
        return Err("扫描范围必须位于所选网卡的私有 IPv4 子网内".into());
    }
    if interface.prefix < 31 && (start == network || end == broadcast) {
        return Err("请排除网络地址和广播地址".into());
    }
    Ok((start..=end).map(Ipv4Addr::from).collect())
}

/// Bounded child execution, including output. Scripts are constants, arguments typed.
pub fn output(mut command: Command, timeout: Duration) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|_| "无法运行本机网络检测工具")?;
    let stdout = child.stdout.take().ok_or("无法读取网络检测结果")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.take(262145).read_to_end(&mut bytes).map(|_| bytes)
    });
    let deadline = Instant::now() + timeout;
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let bytes = reader
        .join()
        .map_err(|_| "网络检测读取失败")?
        .map_err(|_| "网络检测读取失败")?;
    if !success || bytes.len() > 262144 {
        return Err("网络检测失败、超时或结果过大".into());
    }
    Ok(bytes)
}

#[cfg(windows)]
fn powershell(script: &str) -> Result<Vec<u8>, String> {
    let root = std::env::var_os("SystemRoot").ok_or("无法定位系统网络工具")?;
    let mut command = Command::new(
        std::path::PathBuf::from(root).join("System32/WindowsPowerShell/v1.0/powershell.exe"),
    );
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
    ]);
    output(command, Duration::from_secs(12))
}

pub fn interfaces() -> Result<Vec<Interface>, String> {
    #[cfg(windows)]
    let mut rows: Vec<Interface> = {
        // Adapter/profile/gateway/subnet provide a best-effort local network identity.
        const SCRIPT: &str = r#"$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$rows=@(Get-NetIPConfiguration | ForEach-Object { $c=$_;foreach($a in $c.IPv4Address){if($c.NetAdapter.Status -eq 'Up'){[pscustomobject]@{id=[string]$c.InterfaceIndex;name=[string]$c.InterfaceAlias;ip=[string]$a.IPAddress;prefix=[int]$a.PrefixLength;gateway=(''+($c.IPv4DefaultGateway.NextHop | Select-Object -First 1));network=([string]$c.NetAdapter.InterfaceGuid+'|'+[string]$c.NetProfile.Name);networkKey='';suggestedRange=''}}}});ConvertTo-Json -InputObject $rows -Compress -Depth 3"#;
        serde_json::from_slice(&powershell(SCRIPT)?).map_err(|_| "读取网卡信息失败")?
    };
    #[cfg(target_os = "macos")]
    let mut rows = mac_interfaces()?;
    #[cfg(not(any(windows, target_os = "macos")))]
    let mut rows: Vec<Interface> = Vec::new();
    rows.retain(|row| row.ip.parse::<Ipv4Addr>().is_ok_and(private) && row.prefix <= 32);
    for row in &mut rows {
        row.name = clean(&row.name, 120);
        let ip: Ipv4Addr = row.ip.parse().map_err(|_| "网卡地址无效")?;
        let (network, _) = subnet(ip, row.prefix)?;
        row.network_key = format!(
            "{:x}",
            Sha256::digest(
                format!("{}|{}|{}|{}", row.network, row.gateway, network, row.prefix).as_bytes()
            )
        );
        row.network = clean(&row.network.split('|').next_back().unwrap_or_default(), 120);
        row.suggested_range = format!("{}/{}", Ipv4Addr::from(network), row.prefix);
    }
    Ok(rows)
}

#[cfg(target_os = "macos")]
fn mac_interfaces() -> Result<Vec<Interface>, String> {
    let mut command = Command::new("/sbin/ifconfig");
    command.arg("-a");
    let bytes = output(command, Duration::from_secs(5))?;
    let mut rows = Vec::new();
    let mut name = String::new();
    let mut active = false;
    for line in String::from_utf8_lossy(&bytes).lines() {
        if !line.starts_with(char::is_whitespace) {
            name = line.split(':').next().unwrap_or_default().to_string();
            active = line.contains("UP,") || line.contains(",UP,");
        }
        let parts: Vec<_> = line.split_whitespace().collect();
        if active && parts.first() == Some(&"inet") && parts.len() >= 4 && parts[2] == "netmask" {
            let Ok(mask) = u32::from_str_radix(parts[3].trim_start_matches("0x"), 16) else {
                continue;
            };
            let prefix = mask.leading_ones() as u8;
            if mask != u32::MAX.checked_shl(32 - prefix as u32).unwrap_or(0) {
                continue;
            }
            let mut route = Command::new("/sbin/route");
            route.args(["-n", "get", "-ifscope", &name, "default"]);
            let gateway = output(route, Duration::from_secs(2))
                .ok()
                .and_then(|b| {
                    String::from_utf8_lossy(&b).lines().find_map(|line| {
                        line.trim()
                            .strip_prefix("gateway:")
                            .map(|v| v.trim().to_string())
                    })
                })
                .unwrap_or_default();
            // Never use the transient ARP cache in identity: scanning populates it.
            rows.push(Interface {
                id: name.clone(),
                name: name.clone(),
                ip: parts[1].into(),
                prefix,
                gateway: gateway.clone(),
                network: name.clone(),
                network_key: String::new(),
                suggested_range: String::new(),
            });
        }
    }
    Ok(rows)
}

pub fn normalize_mac(value: &str) -> Option<String> {
    let parts: Vec<_> = value.split([':', '-']).collect();
    if parts.len() != 6 {
        return None;
    }
    let bytes: Vec<u8> = parts
        .iter()
        .map(|p| u8::from_str_radix(p, 16))
        .collect::<Result<_, _>>()
        .ok()?;
    if bytes[0] & 1 != 0 || bytes.iter().all(|v| *v == 0) {
        return None;
    }
    Some(
        bytes
            .iter()
            .map(|v| format!("{v:02x}"))
            .collect::<Vec<_>>()
            .join(":"),
    )
}

#[cfg(any(target_os = "macos", test))]
pub fn parse_arp(text: &str) -> HashMap<String, (String, String)> {
    let mut rows = HashMap::new();
    for line in text.lines().take(4096) {
        let parts: Vec<_> = line.split_whitespace().collect();
        if parts.len() < 4 {
            continue;
        }
        let ip = parts[1].trim_matches(['(', ')']);
        if ip.parse::<Ipv4Addr>().is_err() {
            continue;
        }
        if let Some(mac) = normalize_mac(parts[3]) {
            rows.insert(
                ip.to_string(),
                (
                    mac,
                    if parts[0] == "?" {
                        String::new()
                    } else {
                        clean(parts[0], 160)
                    },
                ),
            );
        }
    }
    rows
}

pub fn neighbors(interface: &Interface) -> Result<HashMap<String, (String, String)>, String> {
    #[cfg(windows)]
    {
        // ID parsed before interpolation; only an integer reaches the constant script.
        let id: u32 = interface.id.parse().map_err(|_| "网卡编号无效")?;
        let script = format!("[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$r=@(Get-NetNeighbor -AddressFamily IPv4 -InterfaceIndex {id} -ErrorAction Stop | Where-Object {{$_.State -in @('Reachable','Stale','Delay','Probe','Permanent')}} | Select-Object IPAddress,LinkLayerAddress);ConvertTo-Json -InputObject $r -Compress");
        let rows: Vec<serde_json::Value> =
            serde_json::from_slice(&powershell(&script)?).map_err(|_| "读取邻居表失败")?;
        return Ok(rows
            .iter()
            .filter_map(|row| {
                Some((
                    row.get("IPAddress")?.as_str()?.to_string(),
                    (
                        normalize_mac(row.get("LinkLayerAddress")?.as_str()?)?,
                        String::new(),
                    ),
                ))
            })
            .collect());
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("/usr/sbin/arp");
        command.args(["-an", "-i", &interface.id]);
        return Ok(parse_arp(&String::from_utf8_lossy(&output(
            command,
            Duration::from_secs(3),
        )?)));
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = interface;
        Ok(HashMap::new())
    }
}

/// Windows ARP contains no names. Resolve responding IPs only, with a shared
/// two-second budget and at most 16 outstanding OS resolver requests.
#[cfg(windows)]
pub fn hostnames(ips: &[Ipv4Addr]) -> HashMap<String, String> {
    if ips.is_empty() {
        return HashMap::new();
    }
    let addresses = ips
        .iter()
        .take(1024)
        .map(|ip| format!("'{ip}'"))
        .collect::<Vec<_>>()
        .join(",");
    let script = format!(
        r#"[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$pending=@{{}};$names=@{{}};$queue=[Collections.Generic.Queue[string]]::new();@({addresses}) | ForEach-Object {{$queue.Enqueue($_)}};$clock=[Diagnostics.Stopwatch]::StartNew();while(($queue.Count -gt 0 -or $pending.Count -gt 0) -and $clock.ElapsedMilliseconds -lt 2000){{while($pending.Count -lt 16 -and $queue.Count -gt 0){{$ip=$queue.Dequeue();try{{$pending[$ip]=[Net.Dns]::GetHostEntryAsync($ip)}}catch{{}}}};foreach($ip in @($pending.Keys)){{$task=$pending[$ip];if($task.IsCompleted){{if($task.Status -eq 'RanToCompletion' -and $task.Result.HostName -ne $ip){{$names[$ip]=$task.Result.HostName}};$pending.Remove($ip)}}}};Start-Sleep -Milliseconds 20}};ConvertTo-Json -InputObject $names -Compress"#
    );
    powershell(&script)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<HashMap<String, String>>(&bytes).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|(ip, name)| (ip, clean(&name, 160)))
        .collect()
}

pub fn ping(ip: Ipv4Addr, source: Ipv4Addr) -> bool {
    #[cfg(windows)]
    let command = {
        let mut c = Command::new(
            std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_default())
                .join("System32/ping.exe"),
        );
        c.args([
            "-4",
            "-n",
            "1",
            "-w",
            "450",
            "-S",
            &source.to_string(),
            &ip.to_string(),
        ]);
        c
    };
    #[cfg(target_os = "macos")]
    let command = {
        let mut c = Command::new("/sbin/ping");
        c.args([
            "-n",
            "-c",
            "1",
            "-W",
            "450",
            "-S",
            &source.to_string(),
            &ip.to_string(),
        ]);
        c
    };
    #[cfg(not(any(windows, target_os = "macos")))]
    let command = {
        let mut c = Command::new("ping");
        c.args([
            "-c",
            "1",
            "-W",
            "1",
            "-I",
            &source.to_string(),
            &ip.to_string(),
        ]);
        c
    };
    output(command, Duration::from_secs(2)).is_ok_and(|bytes| {
        String::from_utf8_lossy(&bytes)
            .to_lowercase()
            .contains("ttl=")
    })
}

pub async fn tcp(ip: Ipv4Addr, source: Ipv4Addr, port: u16) -> (bool, bool, u64) {
    let start = Instant::now();
    let result = async {
        let socket = tokio::net::TcpSocket::new_v4()?;
        socket.bind((source, 0).into())?;
        socket.connect((ip, port).into()).await
    };
    match tokio::time::timeout(Duration::from_millis(450), result).await {
        Ok(Ok(_)) => (true, true, start.elapsed().as_millis() as u64),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionRefused => {
            (true, false, start.elapsed().as_millis() as u64)
        }
        _ => (false, false, 0),
    }
}

pub fn classify(device: &mut Device, gateway: &str, local_ip: &str) {
    if device.ip == local_ip {
        device.kind = "本机".into();
        device.evidence.push("所选网卡地址".into());
    } else if device.ip == gateway {
        device.kind = "路由器".into();
        device.evidence.push("所选网卡的默认网关".into());
    } else if device.ports.contains(&9100) || device.ports.contains(&631) {
        device.kind = "打印设备（推测）".into();
    } else if device.ports.contains(&554) {
        device.kind = "摄像/媒体设备（推测）".into();
    } else if device.ports.contains(&3389) {
        device.kind = "电脑/远程桌面设备（推测）".into();
    } else if device.ports.contains(&445) {
        device.kind = "电脑/NAS（推测）".into();
    } else if device.ports.contains(&22) {
        device.kind = "服务器/网络设备（推测）".into();
    } else {
        device.kind = "未知".into();
    }
    if device.ip != local_ip && device.ip != gateway {
        if ["macOS", "Windows"].contains(&device.os.as_str()) {
            device.kind = "电脑（推测）".into();
        } else if ["iOS", "Android", "iPadOS"].contains(&device.os.as_str()) {
            device.kind = "手机/平板（推测）".into();
        } else if device.os == "tvOS" {
            device.kind = "电视/媒体设备（推测）".into();
        }
    }
    device.vendor.clear();
    device.mac_kind = if device.mac.is_empty() {
        "unknown"
    } else if device
        .mac
        .get(..2)
        .and_then(|p| u8::from_str_radix(p, 16).ok())
        .is_some_and(|b| b & 2 != 0)
    {
        "local"
    } else {
        "global"
    }
    .into();
    if device.mac_kind == "local" {
        device
            .evidence
            .push("本地管理 MAC（可能为随机地址或虚拟网卡），不据此判断厂商".into());
        return;
    }
    // A deliberately small, offline IEEE OUI subset; no claim of exhaustive coverage.
    if let Some(prefix) = device.mac.get(..8) {
        device.vendor = match prefix {
            "b8:27:eb" => "Raspberry Pi Foundation",
            "dc:a6:32" | "e4:5f:01" => "Raspberry Pi Trading",
            "00:0c:29" | "00:50:56" => "VMware",
            "08:00:27" => "PCS Systemtechnik / VirtualBox",
            "00:1c:b3" | "00:1b:63" | "00:1e:52" | "f0:d1:a9" => "Apple",
            "00:11:32" => "Synology",
            "00:1a:11" => "Google",
            "00:1a:79" => "TELE System Communications",
            "00:17:c8" => "Kyocera",
            "00:10:18" => "Broadcom",
            _ => "",
        }
        .into();
    }
    if !device.vendor.is_empty() {
        device
            .evidence
            .push("厂商依据：离线 MAC 前缀表；网卡厂商不代表设备品牌或系统".into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn interface() -> Interface {
        Interface {
            id: "1".into(),
            name: "fixture".into(),
            ip: "192.168.1.2".into(),
            prefix: 24,
            gateway: "192.168.1.1".into(),
            network: "fixture".into(),
            network_key: "a".repeat(64),
            suggested_range: String::new(),
        }
    }
    #[test]
    fn bounds_reject_external_large_broadcast_and_shell_input() {
        let i = interface();
        assert_eq!(targets("192.168.1.0/24", &i).unwrap().len(), 254);
        for r in [
            "8.8.8.8",
            "192.168.2.1",
            "192.168.1.0",
            "192.168.1.255",
            "192.168.1.1;whoami",
            "192.168.1.0/16",
            "192.168.1.0/33",
            "192.168.1.5-192.168.1.1",
        ] {
            assert!(targets(r, &i).is_err(), "{r}");
        }
    }
    #[test]
    fn arp_normalization_and_type_evidence() {
        let rows = parse_arp("printer.local (192.168.1.7) at b8:27:eb:1:2:3 on en0 ifscope [ethernet]\n? (192.168.1.8) at (incomplete) on en0");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows["192.168.1.7"].0, "b8:27:eb:01:02:03");
        assert!(normalize_mac("ff:ff:ff:ff:ff:ff").is_none());
        let mut d = Device {
            ip: "192.168.1.7".into(),
            ports: vec![631],
            mac: rows["192.168.1.7"].0.clone(),
            ..Device::default()
        };
        classify(&mut d, "192.168.1.1", "192.168.1.2");
        assert!(d.kind.contains("推测"));
        assert!(d.vendor.contains("Raspberry"));
    }
    #[test]
    fn ports_and_vendor_do_not_prove_os_and_local_macs_do_not_prove_vendor() {
        let mut d = Device {
            ip: "192.168.1.9".into(),
            ports: vec![22, 445, 3389],
            mac: "00:1c:b3:01:02:03".into(),
            ..Device::default()
        };
        classify(&mut d, "192.168.1.1", "192.168.1.2");
        assert!(d.os.is_empty());
        assert_eq!(d.vendor, "Apple");
        d.mac = "02:1c:b3:01:02:03".into();
        classify(&mut d, "192.168.1.1", "192.168.1.2");
        assert_eq!(d.mac_kind, "local");
        assert!(d.vendor.is_empty());
    }
    #[tokio::test]
    async fn tcp_detects_open_and_never_advertises_closed_without_proxy() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        assert_eq!(
            (tcp(Ipv4Addr::LOCALHOST, Ipv4Addr::LOCALHOST, port).await).0,
            true
        );
        drop(listener);
        let result = tcp(Ipv4Addr::LOCALHOST, Ipv4Addr::LOCALHOST, port).await;
        assert!(!result.1);
    }
    #[test]
    #[ignore = "uses native read-only network tools and pings this computer only"]
    fn native_interface_and_self_ping_smoke() {
        let rows = interfaces().expect("native interface discovery");
        let interface = rows.first().expect("a private IPv4 interface is required");
        assert_eq!(interface.network_key.len(), 64);
        assert_eq!(targets(&interface.ip, interface).unwrap().len(), 1);
        let ip = interface.ip.parse().unwrap();
        assert!(
            ping(ip, ip),
            "self ICMP must respond through the selected source address"
        );
        neighbors(interface).expect("native neighbor table");
    }
}
