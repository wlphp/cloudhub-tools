use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanInterface {
    pub ip: String,
    pub adapter: String,
    pub network: String,
}

fn parse(bytes: &[u8]) -> Result<Vec<LanInterface>, String> {
    if bytes.len() > 65536 { return Err("网络列表超过限制".into()); }
    let rows: Vec<LanInterface> = serde_json::from_slice(bytes).map_err(|_| "读取网络列表失败")?;
    let mut result=Vec::new();
    for mut row in rows.into_iter().take(128) {
        let Ok(ip)=row.ip.parse::<std::net::Ipv4Addr>() else { continue; };
        if !ip.is_private() || result.iter().any(|v: &LanInterface|v.ip==row.ip) {continue;}
        row.adapter=row.adapter.chars().filter(|c|!c.is_control()).take(160).collect();
        row.network=row.network.chars().filter(|c|!c.is_control()).take(160).collect();
        result.push(row);
    }
    result.sort_by(|a,b|a.adapter.cmp(&b.adapter).then(a.ip.cmp(&b.ip)));
    Ok(result)
}

#[cfg(windows)]
pub fn interfaces() -> Result<Vec<LanInterface>, String> {
    use std::{io::Read, os::windows::process::CommandExt, process::{Command,Stdio}, time::{Duration,Instant}};
    // Fixed read-only script; no user data or credentials are interpolated.
    const SCRIPT: &str = r#"$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $profiles=@(Get-NetConnectionProfile -ErrorAction SilentlyContinue); $adapters=@(Get-NetAdapter -IncludeHidden); $rows=@(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.AddressState -eq 'Preferred' } | Select-Object -First 128 | ForEach-Object { $ip=$_; $adapter=$adapters | Where-Object { $_.ifIndex -eq $ip.InterfaceIndex -and $_.Status -eq 'Up' } | Select-Object -First 1; if($adapter){ $profile=$profiles | Where-Object { $_.InterfaceIndex -eq $ip.InterfaceIndex } | Select-Object -First 1; [pscustomobject]@{ip=$ip.IPAddress;adapter=$ip.InterfaceAlias;network=$(if($profile){$profile.Name}else{$adapter.InterfaceDescription})} } }); ConvertTo-Json -InputObject $rows -Compress"#;
    let mut child=Command::new("powershell.exe").args(["-NoLogo","-NoProfile","-NonInteractive","-Command",SCRIPT]).creation_flags(0x08000000).stdin(Stdio::null()).stderr(Stdio::null()).stdout(Stdio::piped()).spawn().map_err(|_| "无法读取本机网络")?;
    let stdout=child.stdout.take().ok_or("无法读取本机网络")?;
    let reader=std::thread::spawn(move || {let mut bytes=Vec::new();stdout.take(65537).read_to_end(&mut bytes).map(|_|bytes)});
    let deadline=Instant::now()+Duration::from_secs(8);
    let status=loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now()<deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {let _=child.kill();let _=child.wait();break None;}
        }
    };
    let bytes=reader.join().map_err(|_| "读取网络列表失败")?.map_err(|_| "读取网络列表失败")?;
    if !status.is_some_and(|s|s.success()) {return Err("读取网络列表失败或超时，请重试".into());}
    parse(&bytes)
}

#[cfg(not(windows))]
pub fn interfaces() -> Result<Vec<LanInterface>, String> {
    let Some(url)=super::gateway::lan_address(1) else { return Ok(Vec::new()); };
    let ip=url.strip_prefix("http://").and_then(|s|s.split(':').next()).ok_or("读取网络列表失败")?;
    Ok(vec![LanInterface{ip:ip.into(),adapter:"默认路由".into(),network:"当前网络".into()}])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn network_list_preserves_names_and_filters_non_lan_addresses() {
        let rows=parse(br#"[{"ip":"192.168.1.23","adapter":"Wi-Fi","network":"Home"},{"ip":"10.8.0.2","adapter":"VPN","network":"Tunnel"},{"ip":"127.0.0.1","adapter":"Loopback","network":"Local"},{"ip":"8.8.8.8","adapter":"Public","network":"Public"}]"#).unwrap();
        assert_eq!(rows.len(),2);assert!(rows.iter().any(|v|v.adapter=="Wi-Fi"&&v.network=="Home"));
        assert!(parse(b"not json").is_err());
    }
    #[cfg(windows)]
    #[test]
    fn windows_network_interfaces_are_private_and_named() {
        let rows=interfaces().unwrap();
        assert!(rows.len()<=128);
        assert!(rows.iter().all(|row|row.ip.parse::<std::net::Ipv4Addr>().unwrap().is_private()&&!row.adapter.is_empty()));
    }
}
