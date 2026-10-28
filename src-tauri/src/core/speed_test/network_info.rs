use super::{client, public_ip};
use reqwest::Url;
use serde::Serialize;
use std::{
    net::{IpAddr, UdpSocket},
    time::Duration,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInfo {
    pub public_ip: Option<String>,
    pub local_ip: Option<String>,
    pub location: Option<String>,
    pub source: String,
    pub checked_at: i64,
    pub warning: Option<String>,
}
fn parse_ipip(text: &str) -> Result<(String, String), String> {
    let (prefix, location) = text
        .trim()
        .split_once("来自于：")
        .ok_or("IP 查询返回格式无效")?;
    let raw = prefix
        .strip_prefix("当前 IP：")
        .ok_or("IP 查询返回格式无效")?
        .trim();
    let ip: IpAddr = raw.parse().map_err(|_| "IP 查询返回地址无效")?;
    let location = location.split_whitespace().collect::<Vec<_>>().join(" ");
    if !public_ip(ip)
        || location.is_empty()
        || location.len() > 256
        || location.chars().any(char::is_control)
    {
        return Err("IP 查询返回内容无效".into());
    }
    Ok((ip.to_string(), location))
}
fn local_ip() -> Option<String> {
    // UDP connect selects a route without sending a packet. This is the selected IPv4 interface.
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("1.1.1.1:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_unspecified() && !ip.is_loopback()).then(|| ip.to_string())
}
async fn public_info() -> Result<(String, String), String> {
    let url = Url::parse("https://myip.ipip.net/").map_err(|_| "IP 查询地址无效")?;
    let client = client(&url).await?;
    let mut response = client
        .get(url)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|_| "公网 IP 查询连接失败或超时，请刷新重试")?;
    if !response.status().is_success() {
        return Err("公网 IP 查询服务暂不可用，请刷新重试".into());
    }
    let mut body = vec![];
    while let Some(chunk) = response.chunk().await.map_err(|_| "公网 IP 查询响应中断")? {
        if body.len() + chunk.len() > 4096 {
            return Err("公网 IP 查询响应超过限制".into());
        }
        body.extend_from_slice(&chunk);
    }
    parse_ipip(std::str::from_utf8(&body).map_err(|_| "IP 查询返回格式无效")?)
}
pub async fn query() -> NetworkInfo {
    let mut result = NetworkInfo {
        public_ip: None,
        local_ip: local_ip(),
        location: None,
        source: "IPIP.NET".into(),
        checked_at: chrono::Utc::now().timestamp_millis(),
        warning: None,
    };
    match public_info().await {
        Ok((ip, location)) => {
            result.public_ip = Some(ip);
            result.location = Some(location);
        }
        Err(error) => result.warning = Some(error),
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_public_ip_and_location_without_exposing_raw_responses() {
        let (ip, location) =
            parse_ipip("当前 IP：1.1.1.1  来自于：中国 示例省 示例市  示例运营商\n").unwrap();
        assert_eq!(ip, "1.1.1.1");
        assert_eq!(location, "中国 示例省 示例市 示例运营商");
        for text in [
            "<html>blocked</html>",
            "当前 IP：127.0.0.1 来自于：内网",
            "当前 IP：1.1.1.1 来自于：",
            "当前 IP：invalid 来自于：中国",
        ] {
            assert!(parse_ipip(text).is_err());
        }
        assert!(parse_ipip("当前 IP：2606:4700:4700::1111 来自于：示例地区").is_ok());
    }
    #[tokio::test]
    #[ignore = "Live IP service: asserts shape without printing the actual address or location"]
    async fn public_ip_lookup_smoke() {
        let (ip, location) = public_info().await.unwrap();
        assert!(ip.parse::<IpAddr>().is_ok());
        assert!(!location.is_empty());
    }
}
