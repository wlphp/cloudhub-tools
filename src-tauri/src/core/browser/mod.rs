//! Native-only isolated browser environments. Executables are never bundled.
pub mod model;
pub mod kernel;
pub mod runtime;
mod process;
mod cdp;
pub(crate) mod proxy;
pub mod cookies;
pub mod cookies_offline;

use crate::core::error::{PlatformError, PlatformResult};
use std::path::PathBuf;

pub fn error(message: &'static str) -> PlatformError {
    PlatformError { kind: "platform-error", code: "browser", message: message.into(), retryable: false }
}

/// Diagnostic variant for messages that carry runtime detail such as a CDP
/// method name or Chromium error code. Callers must only pass browser-reported
/// identifiers: never user input, page content, URLs or credentials.
pub fn error_detail(message: &str) -> PlatformError {
    PlatformError { kind: "platform-error", code: "browser", message: message.into(), retryable: false }
}

pub fn supported() -> bool { cfg!(all(target_os = "windows", target_arch = "x86_64")) }
pub fn require_supported() -> PlatformResult<()> {
    if !supported() { return Err(error("浏览器环境暂仅支持 Windows x64 桌面端")); }
    Ok(())
}
pub fn root() -> PlatformResult<PathBuf> {
    Ok(crate::core::paths::data_dir().map_err(|_| error("浏览器数据目录不可用"))?.join("browser"))
}

/// Accept generated IDs only; never derive filesystem paths from names or URLs.
pub fn validate_id(id: &str) -> PlatformResult<()> {
    if uuid::Uuid::parse_str(id).is_err() || id.len() != 36 { return Err(error("浏览器环境标识无效")); }
    Ok(())
}

fn open_profile_lease(id: &str) -> std::io::Result<std::fs::File> {
    let directory = root().map_err(|_| std::io::Error::other("browser directory unavailable"))?.join("locks");
    std::fs::create_dir_all(&directory)?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; options.share_mode(0); }
    options.open(directory.join(format!("{id}.lock")))
}
pub fn profile_lease(id: &str) -> PlatformResult<std::fs::File> {
    validate_id(id)?;
    open_profile_lease(id).map_err(|_| error("环境正在其他 CloudHub 窗口中使用，或资料目录不可写"))
}
pub fn profile_in_use(id: &str) -> PlatformResult<bool> {
    validate_id(id)?;
    match open_profile_lease(id) {
        Ok(_) => Ok(false),
        Err(e) if matches!(e.raw_os_error(), Some(32 | 33)) => Ok(true),
        Err(_) => Err(error("环境资料目录不可用，无法确认运行状态")),
    }
}
pub fn kernel_lease(exclusive: bool, version: &str) -> PlatformResult<std::fs::File> {
    let directory = root()?.join("locks");
    std::fs::create_dir_all(&directory).map_err(|_| error("无法准备内核锁"))?;
    if !kernel::known_version(version) {return Err(error("内核版本无效"));}
    let path = directory.join(format!("kernel-{version}-win64.lock"));
    if !exclusive && !path.exists() { std::fs::write(&path, []).map_err(|_| error("无法准备内核锁"))?; }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    if exclusive { options.write(true).create(true).truncate(false); }
    #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; options.share_mode(if exclusive { 0 } else { 1 }); }
    options.open(path).map_err(|_| error("内核正在被其他窗口安装或使用，请关闭相关环境后重试"))
}

/// Destructive operations must stay beneath the canonical application directory.
pub fn remove_owned_directory(path: &std::path::Path) -> PlatformResult<()> {
    if !path.exists() { return Ok(()); }
    let base = root()?.canonicalize().map_err(|_| error("无法校验浏览器数据目录"))?;
    let target = path.canonicalize().map_err(|_| error("无法校验待删除目录"))?;
    if target == base || !target.starts_with(&base) || std::fs::symlink_metadata(path).map_err(|_| error("无法校验待删除目录"))?.file_type().is_symlink() {
        return Err(error("拒绝删除浏览器数据目录之外的路径"));
    }
    std::fs::remove_dir_all(path).map_err(|_| error("无法删除目录，请确认浏览器已关闭"))
}
