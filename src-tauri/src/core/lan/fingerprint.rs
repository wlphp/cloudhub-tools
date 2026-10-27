//! Best-effort, unauthenticated identification; remote declarations are hints,
//! never authoritative OS fingerprints. All sockets bind the selected source IP.
use super::{clean, Device};
use std::{net::Ipv4Addr, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn stream(ip: Ipv4Addr, source: Ipv4Addr, port: u16, http: bool) -> Option<String> {
    tokio::time::timeout(Duration::from_millis(750), async {
        let socket = tokio::net::TcpSocket::new_v4().ok()?;
        socket.bind((source, 0).into()).ok()?;
        let mut socket = socket.connect((ip, port).into()).await.ok()?;
        if http {
            let request =
                format!("HEAD / HTTP/1.0\r\nHost: {ip}:{port}\r\nConnection: close\r\n\r\n");
            socket.write_all(request.as_bytes()).await.ok()?;
        }
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 512];
        while bytes.len() < 4096 {
            let remaining = (4096 - bytes.len()).min(buffer.len());
            let size = socket.read(&mut buffer[..remaining]).await.ok()?;
            if size == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..size]);
            if http && bytes.windows(4).any(|s| s == b"\r\n\r\n") || !http && bytes.contains(&b'\n')
            {
                break;
            }
        }
        Some(String::from_utf8_lossy(&bytes).into_owned())
    })
    .await
    .ok()
    .flatten()
}

async fn datagram(ip: Ipv4Addr, source: Ipv4Addr, port: u16, query: &[u8]) -> Option<Vec<u8>> {
    tokio::time::timeout(Duration::from_millis(650), async {
        let socket = tokio::net::UdpSocket::bind((source, 0)).await.ok()?;
        // Connected UDP restricts responses to the address/port being identified.
        socket.connect((ip, port)).await.ok()?;
        socket.send(query).await.ok()?;
        let mut bytes = vec![0; 8192];
        let size = socket.recv(&mut bytes).await.ok()?;
        bytes.truncate(size);
        Some(bytes)
    })
    .await
    .ok()
    .flatten()
}

fn server_header(text: &str) -> Option<String> {
    if !text.starts_with("HTTP/1.") {
        return None;
    }
    text.split("\r\n\r\n")
        .next()?
        .lines()
        .skip(1)
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("server")
                .then(|| clean(value.trim(), 160))
        })
}

fn os_hint(value: &str) -> Option<&'static str> {
    let text = value.to_ascii_lowercase();
    if text.contains("android") {
        Some("Android")
    } else if text.contains("windows") || text.contains("microsoft-iis") {
        Some("Windows")
    } else if text.contains("darwin") || text.contains("mac os x") || text.contains("macos") {
        Some("macOS")
    } else if text.contains("ubuntu") {
        Some("Linux / Ubuntu")
    } else if text.contains("debian") {
        Some("Linux / Debian")
    } else if text.contains("freebsd") {
        Some("FreeBSD")
    } else if text.contains("linux") {
        Some("Linux")
    } else {
        None
    }
}

// Decode DNS names with bounded compression traversal; malformed or cyclic
// pointers and truncated records are rejected rather than indexing blindly.
fn name(packet: &[u8], cursor: &mut usize) -> Option<String> {
    let mut pos = *cursor;
    let mut jumped = false;
    let mut labels = Vec::new();
    for _ in 0..64 {
        let len = *packet.get(pos)?;
        if len & 0xc0 == 0xc0 {
            let next = *packet.get(pos + 1)?;
            if !jumped {
                *cursor = pos + 2;
            }
            pos = (((len & 0x3f) as usize) << 8) | next as usize;
            jumped = true;
        } else if len == 0 {
            if !jumped {
                *cursor = pos + 1;
            }
            return Some(labels.join("."));
        } else {
            if len > 63 {
                return None;
            }
            pos += 1;
            labels.push(
                String::from_utf8_lossy(packet.get(pos..pos + len as usize)?).to_ascii_lowercase(),
            );
            pos += len as usize;
            if !jumped {
                *cursor = pos;
            }
        }
    }
    None
}

fn mdns_model(packet: &[u8]) -> Option<String> {
    if packet.len() < 12 || packet[2] & 0x80 == 0 {
        return None;
    }
    let count = |offset| u16::from_be_bytes([packet[offset], packet[offset + 1]]) as usize;
    let questions = count(4);
    let records = count(6) + count(8) + count(10);
    if questions > 32 || records > 128 {
        return None;
    }
    let mut cursor = 12;
    for _ in 0..questions {
        name(packet, &mut cursor)?;
        cursor += 4;
        if cursor > packet.len() {
            return None;
        }
    }
    for _ in 0..records {
        let owner = name(packet, &mut cursor)?;
        let header = packet.get(cursor..cursor + 10)?;
        let kind = u16::from_be_bytes([header[0], header[1]]);
        let class = u16::from_be_bytes([header[2], header[3]]) & 0x7fff;
        let length = u16::from_be_bytes([header[8], header[9]]) as usize;
        cursor += 10;
        let data = packet.get(cursor..cursor + length)?;
        cursor += length;
        if kind != 16 || class != 1 || !owner.ends_with("._device-info._tcp.local") {
            continue;
        }
        let mut offset = 0;
        while offset < data.len() {
            let size = data[offset] as usize;
            offset += 1;
            let text = std::str::from_utf8(data.get(offset..offset + size)?).ok()?;
            offset += size;
            if let Some(model) = text.strip_prefix("model=") {
                let model = clean(model, 80);
                if !model.is_empty() {
                    return Some(model);
                }
            }
        }
    }
    None
}

fn model_os(model: &str) -> Option<&'static str> {
    let model = model.to_ascii_lowercase();
    if ["macbook", "macmini", "macpro", "imac", "macstudio"]
        .iter()
        .any(|p| model.starts_with(p))
    {
        Some("macOS")
    } else if model.starts_with("iphone") {
        Some("iOS")
    } else if model.starts_with("ipad") {
        Some("iPadOS")
    } else if model.starts_with("appletv") {
        Some("tvOS")
    } else {
        None
    }
}

fn apply_hints(d: &mut Device, hints: Vec<(String, String)>) {
    let mut systems = Vec::new();
    for (system, evidence) in hints {
        d.evidence.push(evidence);
        systems.push(system);
    }
    systems.sort();
    systems.dedup();
    // A distro declaration refines a generic Linux declaration.
    if systems.iter().any(|s| s.starts_with("Linux /")) {
        systems.retain(|s| s != "Linux");
    }
    if systems.len() == 1 {
        d.os = systems.remove(0);
        d.os_status = "inferred".into();
    } else if systems.len() > 1 {
        d.os.clear();
        d.os_status = "unknown".into();
        d.evidence.push("系统标识存在冲突，保留未识别".into());
    }
}

pub async fn identify(d: &mut Device, source: Ipv4Addr) {
    let Ok(ip) = d.ip.parse::<Ipv4Addr>() else {
        return;
    };
    if ip == source {
        d.os = match std::env::consts::OS {
            "windows" => "Windows",
            "macos" => "macOS",
            "linux" => "Linux",
            other => other,
        }
        .into();
        d.os_status = "identified".into();
        d.evidence.push("本机运行平台信息（非端口推测）".into());
        return;
    }
    let ssh = async {
        if d.ports.contains(&22) {
            stream(ip, source, 22, false).await
        } else {
            None
        }
    };
    let http = async {
        let mut servers = Vec::new();
        for port in [80, 8080] {
            if d.ports.contains(&port) {
                if let Some(text) = stream(ip, source, port, true).await {
                    if let Some(server) = server_header(&text) {
                        servers.push((port, server));
                    }
                }
            }
        }
        servers
    };
    let mdns = async {
        // DNS-SD PTR query with the unicast-response bit, from an ephemeral port.
        let query = b"\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x0c_device-info\x04_tcp\x05local\x00\x00\x0c\x80\x01";
        mdns_model(&datagram(ip, source, 5353, query).await?)
    };
    let ssdp = datagram(ip, source, 1900, b"M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: ssdp:all\r\n\r\n");
    let (ssh, http, model, ssdp) = tokio::join!(ssh, http, mdns, ssdp);
    let mut hints = Vec::new();
    if let Some(banner) = ssh {
        if let Some(line) = banner
            .lines()
            .find(|line| line.starts_with("SSH-2.0-") || line.starts_with("SSH-1.99-"))
        {
            let line = clean(line, 160);
            d.evidence.push(format!("SSH 服务标识：{line}"));
            if let Some(os) = os_hint(&line) {
                hints.push((os.into(), "系统依据：SSH 服务声明".into()));
            }
        }
    }
    for (port, server) in http {
        d.evidence.push(format!("HTTP {port} Server：{server}"));
        if let Some(os) = os_hint(&server) {
            hints.push((
                os.into(),
                "系统依据：HTTP Server 声明（可能为容器或代理）".into(),
            ));
        }
    }
    if let Some(bytes) = ssdp {
        if let Some(server) = server_header(&String::from_utf8_lossy(&bytes)) {
            d.evidence.push(format!("SSDP Server：{server}"));
            if let Some(os) = os_hint(&server) {
                hints.push((os.into(), "系统依据：SSDP 服务声明".into()));
            }
        }
    }
    if let Some(model) = model {
        d.evidence.push(format!("Bonjour 设备型号：{model}"));
        if let Some(os) = model_os(&model) {
            hints.push((os.into(), "系统依据：Bonjour 设备型号（推测）".into()));
        }
        d.model = model;
    }
    apply_hints(d, hints);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn systems_require_explicit_signals_and_conflicts_remain_unknown() {
        for generic in ["OpenSSH_9.6", "nginx/1.24", "Apache", "Apple", "Samba"] {
            assert_eq!(os_hint(generic), None);
        }
        assert_eq!(os_hint("SSH-2.0-OpenSSH_for_Windows_9.5"), Some("Windows"));
        assert_eq!(os_hint("OpenSSH_8.9p1 Ubuntu-3"), Some("Linux / Ubuntu"));
        assert_eq!(model_os("MacBookPro18,3"), Some("macOS"));
        assert_eq!(model_os("iPhone15,2"), Some("iOS"));
        let mut d = Device::default();
        apply_hints(
            &mut d,
            vec![("Windows".into(), "a".into()), ("Linux".into(), "b".into())],
        );
        assert!(d.os.is_empty());
        assert_eq!(d.os_status, "unknown");
        assert_eq!(
            server_header(
                "HTTP/1.1 200 OK\r\nServer: Microsoft-IIS/10.0\r\nSet-Cookie: private\r\n\r\nbody"
            ),
            Some("Microsoft-IIS/10.0".into())
        );
    }
    #[test]
    fn dns_parser_rejects_cycles_truncation_and_unrelated_txt() {
        let mut position = 0;
        assert!(name(&[0xc0, 0], &mut position).is_none());
        for size in 0..12 {
            assert!(mdns_model(&vec![0; size]).is_none());
        }
        let mut packet = vec![0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0];
        for label in ["workstation", "_device-info", "_tcp", "local"] {
            packet.push(label.len() as u8);
            packet.extend_from_slice(label.as_bytes());
        }
        packet.push(0);
        let value = b"model=MacBookPro18,3";
        packet.extend_from_slice(&[
            0,
            16,
            0x80,
            1,
            0,
            0,
            0,
            60,
            0,
            (value.len() + 1) as u8,
            value.len() as u8,
        ]);
        packet.extend_from_slice(value);
        assert_eq!(mdns_model(&packet), Some("MacBookPro18,3".into()));
        packet.pop();
        assert!(mdns_model(&packet).is_none());
    }
    #[tokio::test]
    async fn local_system_is_identified_without_network_io() {
        let mut d = Device {
            ip: "127.0.0.1".into(),
            ..Device::default()
        };
        identify(&mut d, Ipv4Addr::LOCALHOST).await;
        assert!(!d.os.is_empty());
        assert_eq!(d.os_status, "identified");
    }
    #[tokio::test]
    async fn ssh_banner_is_read_over_bound_socket() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let worker = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            socket
                .write_all(b"SSH-2.0-OpenSSH_9.6 Ubuntu-1\r\n")
                .await
                .unwrap();
        });
        let text = stream(Ipv4Addr::LOCALHOST, Ipv4Addr::LOCALHOST, port, false)
            .await
            .unwrap();
        assert_eq!(os_hint(&text), Some("Linux / Ubuntu"));
        worker.await.unwrap();
    }
    #[tokio::test]
    async fn slow_service_is_bounded_and_header_request_contains_no_credentials() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (sent, received) = tokio::sync::oneshot::channel();
        let worker = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 512];
            let size = socket.read(&mut request).await.unwrap();
            sent.send(String::from_utf8_lossy(&request[..size]).into_owned())
                .unwrap();
            tokio::time::sleep(Duration::from_secs(2)).await;
        });
        assert!(tokio::time::timeout(
            Duration::from_millis(1100),
            stream(Ipv4Addr::LOCALHOST, Ipv4Addr::LOCALHOST, port, true)
        )
        .await
        .unwrap()
        .is_none());
        let request = received.await.unwrap();
        assert!(request.starts_with("HEAD / HTTP/1.0\r\nHost: 127.0.0.1:"));
        assert!(!request.contains("Authorization"));
        worker.abort();
    }
}
