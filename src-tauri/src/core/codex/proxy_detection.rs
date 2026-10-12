use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyCandidate {
    pub url: String,
    pub source: String,
    pub enabled: bool,
}

fn add(rows: &mut Vec<ProxyCandidate>, raw: &str, source: &str, enabled: bool) {
    // Configuration only: never probe ports, return credentials or guess a protocol.
    if raw.len() > 512 || raw.chars().any(char::is_control) { return; }
    let address = if raw.contains("://") { raw.to_string() } else { format!("http://{}", raw.trim()) };
    if let Ok(Some(url)) = super::account_controls::validate_proxy(&address) {
        if !rows.iter().any(|row| row.url == url && row.source == source) {
            rows.push(ProxyCandidate { url, source: source.into(), enabled });
        }
    }
}

#[derive(Deserialize)]
struct WindowsProxy { server: String, enabled: bool }

fn windows_candidates(bytes: &[u8], rows: &mut Vec<ProxyCandidate>) -> Result<(), String> {
    if bytes.len() > 4096 { return Err("本机代理配置超过读取限制".into()); }
    let settings: WindowsProxy = serde_json::from_slice(bytes).map_err(|_| "读取本机代理配置失败，请手动填写代理地址")?;
    for item in settings.server.split(';') {
        let address = match item.split_once('=') {
            Some(("http" | "https", value)) => value,
            Some(_) => continue,
            None => item,
        };
        if !address.trim().is_empty() { add(rows, address, "Windows 系统代理", settings.enabled); }
    }
    Ok(())
}

#[cfg(windows)]
fn read_windows(rows: &mut Vec<ProxyCandidate>) -> Result<(), String> {
    use std::{io::Read, os::windows::process::CommandExt, process::{Command, Stdio}, time::{Duration, Instant}};
    const SCRIPT: &str = r#"$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $s=Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue; ConvertTo-Json -Compress -InputObject @{server=[string]$s.ProxyServer;enabled=($s.ProxyEnable -eq 1)}"#;
    let mut child = Command::new("powershell.exe").args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .creation_flags(0x08000000).stdin(Stdio::null()).stderr(Stdio::null()).stdout(Stdio::piped()).spawn()
        .map_err(|_| "读取本机代理配置失败，请手动填写代理地址")?;
    let stdout = child.stdout.take().ok_or("读取本机代理配置失败，请手动填写代理地址")?;
    let reader = std::thread::spawn(move || { let mut bytes = zeroize::Zeroizing::new(Vec::new()); stdout.take(4097).read_to_end(&mut bytes).map(|_| bytes) });
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => { let _ = child.kill(); let _ = child.wait(); break None; }
        }
    };
    let bytes = reader.join().map_err(|_| "读取本机代理配置失败，请手动填写代理地址")?
        .map_err(|_| "读取本机代理配置失败，请手动填写代理地址")?;
    if !status.is_some_and(|status| status.success()) { return Err("读取本机代理配置失败，请手动填写代理地址".into()); }
    windows_candidates(&bytes, rows)
}

pub fn detect() -> Result<Vec<ProxyCandidate>, String> {
    let mut rows = Vec::new();
    for name in ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"] {
        if let Ok(raw) = std::env::var(name) { add(&mut rows, &raw, &format!("环境变量 {name}"), true); }
    }
    #[cfg(windows)]
    read_windows(&mut rows)?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn system_candidates_keep_disabled_settings_and_reject_secrets() {
        let mut rows = Vec::new();
        windows_candidates(br#"{"server":"http=127.0.0.1:10808;https=127.0.0.1:10808;socks=127.0.0.1:10809","enabled":false}"#, &mut rows).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].url, "http://127.0.0.1:10808/");
        assert!(!rows[0].enabled);
        for raw in ["http://user:test@localhost:9", "socks5://localhost:9", "http://localhost:9/?token=test", "localhost:99999", "localhost:9\n"] { add(&mut rows, raw, "test", true); }
        assert_eq!(rows.len(), 1);
    }
    #[cfg(windows)]
    #[test]
    fn actual_windows_detection_returns_only_valid_addresses() {
        let rows = detect().unwrap();
        assert!(rows.iter().all(|row| super::super::account_controls::validate_proxy(&row.url).is_ok()));
    }
}
