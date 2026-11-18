//! Shared, bounded transport for public CloudHub release resources only.
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

pub const API: &str = "https://api.github.com/repos/wlphp/cloudhub-tools/releases/latest";
pub const MANIFEST: &str = "https://github.com/wlphp/cloudhub-tools/releases/latest/download/latest.json";
/// tauri-action 会把 latest.json 里的下载地址写成 GitHub 官方 release asset API 地址。
/// 这里只放行本项目、纯数字资源 ID、无查询串/片段的地址，避免放宽成任意 URL。
fn release_asset_api_url(url: &reqwest::Url) -> bool {
    if url.host_str() != Some("api.github.com") { return false; }
    let Some(id) = url.path().strip_prefix("/repos/wlphp/cloudhub-tools/releases/assets/") else { return false; };
    !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit())
}
#[derive(Clone, Copy, Default, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Source { #[default] Auto, Accelerated, Mirror705810, Direct }
impl Source {
    pub fn routes(self) -> &'static [Source] {
        match self { Self::Auto => &[Self::Accelerated, Self::Mirror705810, Self::Direct], Self::Accelerated => &[Self::Accelerated], Self::Mirror705810 => &[Self::Mirror705810], Self::Direct => &[Self::Direct] }
    }
    pub fn label(self) -> &'static str { match self { Self::Accelerated => "gh-proxy.com", Self::Mirror705810 => "github.705810.xyz", Self::Direct => "GitHub 官方直连", Self::Auto => "自动选择" } }
}
pub fn public_url(original: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(original).map_err(|_| "更新地址无效")?;
    if url.scheme() != "https" || url.port().is_some() || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some()
        || !(original == API || release_asset_api_url(&url) || (url.host_str() == Some("github.com") && url.path().starts_with("/wlphp/cloudhub-tools/releases/")
            && (url.path().contains("/download/") || url.path() == "/wlphp/cloudhub-tools/releases/latest/download/latest.json"))) {
        return Err("仅允许下载本项目的公开更新资源".into());
    }
    Ok(url)
}
pub fn routed_url(original: &str, route: Source) -> Result<reqwest::Url, String> {
    let original = public_url(original)?;
    let prefix = match route { Source::Accelerated => Some("https://gh-proxy.com/"), Source::Mirror705810 => Some("https://github.705810.xyz/"), _ => None };
    if let Some(prefix) = prefix { reqwest::Url::parse(&format!("{prefix}{original}")).map_err(|_| "加速地址无效".into()) }
    else { Ok(original) }
}
pub fn client() -> Result<reqwest::Client, String> {
    configure(reqwest::Client::builder()).build().map_err(|_| "无法初始化更新连接".into())
}
pub fn configure(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    builder.user_agent("CloudHub-Updater").connect_timeout(Duration::from_secs(8)).read_timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let u = attempt.url();
            if attempt.previous().len() >= 5 || u.scheme() != "https" || !u.username().is_empty() || u.password().is_some()
                || !matches!(u.host_str(), Some("github.com" | "api.github.com" | "release-assets.githubusercontent.com" | "objects.githubusercontent.com" | "gh-proxy.com" | "github.705810.xyz")) {
                attempt.stop()
            } else { attempt.follow() }
        }))
}
pub async fn json(original: &str, route: Source) -> Result<serde_json::Value, String> {
    let mut response = client()?.get(routed_url(original, route)?).header("Accept", "application/json")
        .timeout(Duration::from_secs(12)).send().await.map_err(|_| "连接超时或网络不可用")?;
    if !response.status().is_success() { return Err(format!("版本请求失败（HTTP {}）", response.status().as_u16())); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "版本信息读取中断")? {
        if bytes.len() + chunk.len() > 1024 * 1024 { return Err("版本信息超过大小限制".into()); }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "版本信息无效，节点可能返回了网页".into())
}

/// 部分第三方镜像（如 github.705810.xyz）无法代理 api.github.com，返回 404 HTML。
/// 版本元数据体积很小，失败后回退官方直连获取；安装包下载仍由调用方按所选线路进行，
/// 因此不影响镜像对大文件的加速作用。
fn metadata_fallback(route: Source) -> Option<Source> {
    match route { Source::Accelerated | Source::Mirror705810 => Some(Source::Direct), Source::Direct | Source::Auto => None }
}

pub async fn json_metadata(original: &str, route: Source) -> Result<serde_json::Value, String> {
    match json(original, route).await {
        Ok(value) => Ok(value),
        Err(primary) => match metadata_fallback(route) {
            Some(fallback) => json(original, fallback).await,
            None => Err(primary),
        },
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe { pub route: Source, pub available: bool, pub response_ms: u64, pub bytes_per_second: u64, pub message: String }
pub async fn probe(route: Source) -> Probe {
    let start = Instant::now();
    let mut response_ms = 0;
    let result = async {
        if route == Source::Auto { return Err("请指定测速线路".to_string()); }
        let release = json_metadata(API, route).await?;
        let assets = release["assets"].as_array().ok_or("没有可测速的发布附件")?;
        let url = assets.iter().filter_map(|a| a["browser_download_url"].as_str())
            .find(|u| u.ends_with(".apk") || u.ends_with(".exe") || u.ends_with(".tar.gz")).ok_or("没有可测速的安装包")?;
        let send = Instant::now();
        let mut response = client()?.get(routed_url(url, route)?).header("Range", "bytes=0-262143")
            .timeout(Duration::from_secs(12)).send().await.map_err(|_| "测速连接失败或超时")?;
        response_ms = send.elapsed().as_millis() as u64;
        if !response.status().is_success() || response.headers().get("content-type").is_some_and(|v| v.to_str().unwrap_or("").contains("text/html")) {
            return Err("测速请求失败或返回了网页".into());
        }
        let read_start = Instant::now();
        let mut bytes = 0usize;
        while let Some(chunk) = response.chunk().await.map_err(|_| "测速读取失败")? {
            bytes += chunk.len().min(262144 - bytes);
            if bytes >= 262144 { break; } // Stop even if the server ignores Range.
        }
        if bytes == 0 { return Err("测速未收到数据".into()); }
        Ok((bytes as f64 / read_start.elapsed().as_secs_f64().max(0.001)) as u64)
    }.await;
    match result {
        Ok(speed) => Probe { route, available: true, response_ms, bytes_per_second: speed, message: "抽样测速完成".into() },
        Err(message) => Probe { route, available: false, response_ms: start.elapsed().as_millis() as u64, bytes_per_second: 0, message },
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn routes_are_explicit_and_restricted() {
        assert_eq!(Source::Auto.routes(), &[Source::Accelerated, Source::Mirror705810, Source::Direct]);
        assert_eq!(routed_url(MANIFEST, Source::Mirror705810).unwrap().as_str(), format!("https://github.705810.xyz/{MANIFEST}"));
        assert_eq!(serde_json::from_str::<Source>("\"mirror705810\"").unwrap(), Source::Mirror705810);
        assert_eq!(Source::Mirror705810.routes(), &[Source::Mirror705810]);
        assert_eq!(Source::Direct.routes(), &[Source::Direct]);
        assert_eq!(routed_url(MANIFEST, Source::Accelerated).unwrap().as_str(), format!("https://gh-proxy.com/{MANIFEST}"));
        for url in ["https://evil.test/a.apk", "http://github.com/wlphp/cloudhub-tools/releases/download/v1/a", "https://github.com/other/repo/releases/download/v1/a", "https://github.com/wlphp/cloudhub-tools/releases/download/v1/a?token=x", "https://user@github.com/wlphp/cloudhub-tools/releases/download/v1/a"] { assert!(public_url(url).is_err()); }
        assert!(serde_json::from_str::<Source>("\"unknown\"").is_err());
    }
    #[test] fn metadata_falls_back_only_from_mirrors() {
        assert_eq!(metadata_fallback(Source::Accelerated), Some(Source::Direct));
        assert_eq!(metadata_fallback(Source::Mirror705810), Some(Source::Direct));
        assert_eq!(metadata_fallback(Source::Direct), None);
        assert_eq!(metadata_fallback(Source::Auto), None);
    }
    #[test] fn release_asset_api_is_allowed_only_for_this_repo_numeric_id() {
        let ok = "https://api.github.com/repos/wlphp/cloudhub-tools/releases/assets/762567992";
        assert!(public_url(ok).is_ok());
        assert_eq!(routed_url(ok, Source::Direct).unwrap().as_str(), ok);
        for url in [
            "https://api.github.com/repos/other/repo/releases/assets/762567992",
            "https://api.github.com/repos/wlphp/cloudhub-tools/releases/assets/abc",
            "https://api.github.com/repos/wlphp/cloudhub-tools/releases/assets/762?token=x",
            "http://api.github.com/repos/wlphp/cloudhub-tools/releases/assets/762",
            "https://evil.test/repos/wlphp/cloudhub-tools/releases/assets/762",
        ] { assert!(public_url(url).is_err()); }
    }
}
