use super::{error, require_supported, root};
use crate::core::error::PlatformResult;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use tokio::io::AsyncWriteExt;

// Catalog is reviewed and shipped with the application. No remote manifest may
// supply a new executable URL or checksum. Update pins with an application update.
// Source: Google Chrome for Testing Stable, downloaded over HTTPS on 2026-10-16.
pub const VERSION: &str = "155.0.8059.84";
pub const ARCHIVE_SIZE: u64 = 206_114_888;
pub const EXPERIMENTAL_VERSION: &str = "clearcote-150.0.7871.114";
struct KernelSpec { version: &'static str, label: &'static str, size: u64, sha256: &'static str, url: &'static str }
const CATALOG: &[KernelSpec] = &[
    KernelSpec { version: VERSION, label: "推荐版本", size: ARCHIVE_SIZE, sha256: "507f2a031441d10c62b5e3d4e863f09ac1198a571c1419976cbd8387f639afde", url: "https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.84/win64/chrome-win64.zip" },
    KernelSpec { version: "155.0.8059.79", label: "兼容测试版本", size: 207_516_446, sha256: "4966d9df2c8ed9be606ff0fc8877b2e800def164fbad63fed6a1d93222ad9dbf", url: "https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.79/win64/chrome-win64.zip" },
    KernelSpec { version: EXPERIMENTAL_VERSION, label: "Clearcote 150 · 实验版", size: 245_936_073, sha256: "93fc03c45b931d8d82f714814318892929f44dd671b0993788332071d53f3135", url: "https://github.com/clearcotelabs/clearcote-browser/releases/download/v0.1.0-pre.23/clearcote-150.0.7871.114-windows-x64.zip" },
];
pub fn experimental(version: &str) -> bool { version == EXPERIMENTAL_VERSION }
fn executable_relative(version: &str) -> &'static str { if experimental(version) { "chrome.exe" } else { "chrome-win64/chrome.exe" } }
pub fn known_version(value: &str) -> bool { CATALOG.iter().any(|spec|spec.version==value) }
fn spec(version: &str) -> PlatformResult<&'static KernelSpec> { CATALOG.iter().find(|spec|spec.version==version).ok_or(error("请选择审核目录内的浏览器版本")) }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelStatus {
    pub version: String,
    pub label: String,
    pub recommended: bool,
    pub experimental: bool,
    pub installed: bool,
    pub phase: String,
    pub downloaded: u64,
    pub total: u64,
    pub error: Option<String>,
}
impl Default for KernelStatus {
    fn default() -> Self { Self::for_spec(&CATALOG[0]) }
}
impl KernelStatus {
    fn for_spec(spec: &KernelSpec) -> Self { Self { version: spec.version.into(), label: spec.label.into(), recommended: spec.version==VERSION, experimental: experimental(spec.version), installed: false, phase: "idle".into(), downloaded: 0, total: spec.size, error: None } }
}
#[derive(Default)]
pub struct KernelState {
    pub status: Mutex<KernelStatus>,
    pub cancel: AtomicBool,
    pub active: AtomicBool,
}
pub fn installed_dir(version: &str) -> PlatformResult<PathBuf> { let spec=spec(version)?;Ok(root()?.join("kernels").join(format!("{}-win64",spec.version))) }
pub fn executable(version: &str) -> PlatformResult<PathBuf> { Ok(installed_dir(version)?.join(executable_relative(version))) }
pub fn installed(version: &str) -> bool {
    let Ok(spec)=spec(version) else {return false;};
    installed_dir(version).ok().is_some_and(|p| p.join(executable_relative(version)).is_file()
        && fs::read_to_string(p.join("cloudhub-verified.sha256")).is_ok_and(|s| s == spec.sha256))
}

/// Chrome for Testing embeds a dependency on a versioned private assembly. The
/// archive's external manifest omits its processor architecture, so Windows SxS
/// cannot resolve it and CreateProcess fails before Chrome starts. Normalize only
/// the known, pinned CfT manifest after archive SHA-256 verification.
fn repair_cft_manifest(directory: &Path, version: &str) -> PlatformResult<()> {
    let manifest = directory.join(format!("{version}.manifest"));
    let contents = fs::read_to_string(&manifest).map_err(|_| error("浏览器内核清单缺失或无法读取"))?;
    let expected_name = format!("name='{version}'");
    let expected_version = format!("version='{version}'");
    if !contents.contains(&expected_name) || !contents.contains(&expected_version)
        || !contents.contains("file name='chrome_elf.dll'")
    {
        return Err(error("浏览器内核清单校验失败"));
    }
    // Chromium's dependency reference intentionally omits processorArchitecture;
    // Windows treats a pinned "amd64" private manifest as a different identity.
    let normalized = contents.replace(" processorArchitecture='amd64'", "");
    if normalized == contents {
        if contents.matches("type='win32'/>").count() != 1 {
            return Err(error("浏览器内核清单格式不受支持"));
        }
        return Ok(());
    }
    if normalized.matches("type='win32'/>").count() != 1 {
        return Err(error("浏览器内核清单格式不受支持"));
    }
    let temporary = directory.join(format!("{version}.manifest.{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temporary, normalized).map_err(|_| error("无法修复浏览器内核清单"))?;
    if fs::rename(&temporary, &manifest).is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(error("无法保存浏览器内核清单修复"));
    }
    Ok(())
}

/// Migrate already-installed kernels only when their marker matches the pinned
/// archive digest; new installs are normalized during extraction below.
pub fn prepare_for_launch(version: &str) -> PlatformResult<()> {
    if experimental(version) { return Ok(()); }
    let selected = spec(version)?;
    let directory = installed_dir(version)?;
    let marker = fs::read_to_string(directory.join("cloudhub-verified.sha256"))
        .map_err(|_| error("浏览器内核校验记录无效，请重新安装内核"))?;
    if marker != selected.sha256 { return Err(error("浏览器内核校验记录无效，请重新安装内核")); }
    repair_cft_manifest(&directory.join("chrome-win64"), version)
}
pub fn status(state: &KernelState, version: &str) -> PlatformResult<KernelStatus> {
    let selected=spec(version)?;
    let current=state.status.lock().map_err(|_|error("内核状态不可用"))?;
    let mut result=if current.version==version {current.clone()} else {KernelStatus::for_spec(selected)};
    result.installed = installed(version);
    Ok(result)
}
pub fn catalog(state: &KernelState) -> PlatformResult<Vec<KernelStatus>> { CATALOG.iter().map(|spec|status(state,spec.version)).collect() }
pub fn uninstall(state: Arc<KernelState>, version: &str) -> PlatformResult<()> {
    require_supported()?;
    let selected=spec(version)?;
    if state.active.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() { return Err(error("请等待内核安装完成或取消安装")); }
    let _guard = ActiveGuard(state.clone());
    let _lease = super::kernel_lease(true,version)?;
    super::remove_owned_directory(&installed_dir(version)?)?;
    *state.status.lock().map_err(|_| error("内核状态不可用"))? = KernelStatus::for_spec(selected);
    Ok(())
}
fn phase(state: &KernelState, value: &str) -> PlatformResult<()> {
    state.status.lock().map_err(|_| error("内核状态不可用"))?.phase = value.into(); Ok(())
}
fn cancelled(state: &KernelState) -> PlatformResult<()> {
    if state.cancel.load(Ordering::SeqCst) { return Err(error("内核安装已取消")); } Ok(())
}
async fn wait_cancelled(state: &KernelState) { while !state.cancel.load(Ordering::SeqCst) { tokio::time::sleep(Duration::from_millis(100)).await; } }
struct ActiveGuard(Arc<KernelState>);
impl Drop for ActiveGuard { fn drop(&mut self) { self.0.active.store(false, Ordering::SeqCst); } }

/// A unique staging directory makes retries atomic; only this operation's files
/// are removed. Never overwrite an installed executable or a running version.
pub async fn install(state: Arc<KernelState>, version: &str, offline_path: Option<PathBuf>) -> PlatformResult<()> {
    require_supported()?;
    let selected=spec(version)?;
    if state.active.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() { return Err(error("内核安装正在执行")); }
    let _guard = ActiveGuard(state.clone());
    let _lease = super::kernel_lease(true,version)?;
    if installed(version) { return Ok(()); }
    state.cancel.store(false, Ordering::SeqCst);
    *state.status.lock().map_err(|_| error("内核状态不可用"))? = KernelStatus::for_spec(selected);
    let base = root()?.join("kernels");
    fs::create_dir_all(&base).map_err(|_| error("无法创建内核目录"))?;
    let staging = base.join(format!(".install-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&staging).map_err(|_| error("无法准备内核安装"))?;
    let result = install_inner(&state, selected, &staging, offline_path).await;
    // staging is a generated child of our application directory, never user input.
    let cleanup = fs::remove_dir_all(&staging);
    if let Err(ref e) = result {
        let mut s = state.status.lock().map_err(|_| error("内核状态不可用"))?;
        s.phase = if state.cancel.load(Ordering::SeqCst) { "cancelled" } else { "failed" }.into();
        s.error = Some(e.message.clone());
    } else if cleanup.is_err() && staging.exists() {
        return Err(error("内核已安装，但临时文件清理失败"));
    }
    result
}
async fn install_inner(state: &Arc<KernelState>, spec: &'static KernelSpec, staging: &Path, offline_path: Option<PathBuf>) -> PlatformResult<()> {
    let archive = staging.join("kernel.zip");
    phase(state, "downloading")?;
    if let Some(path) = offline_path {
        if fs::metadata(&path).map_err(|_| error("无法读取离线内核包"))?.len() != spec.size { return Err(error("离线内核包大小与受信版本不符")); }
        let mut source = tokio::fs::File::open(path).await.map_err(|_| error("无法读取离线内核包"))?;
        let mut output = tokio::fs::File::create(&archive).await.map_err(|_| error("无法保存内核包"))?;
        use tokio::io::AsyncReadExt;
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            cancelled(state)?;
            let n = source.read(&mut buffer).await.map_err(|_| error("无法读取离线内核包"))?;
            if n == 0 { break; }
            output.write_all(&buffer[..n]).await.map_err(|_| error("无法保存内核包，请检查磁盘空间"))?;
            state.status.lock().map_err(|_| error("内核状态不可用"))?.downloaded += n as u64;
        }
        output.flush().await.map_err(|_| error("无法保存内核包"))?;
    } else {
        let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).timeout(Duration::from_secs(1800))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() <= 3 && trusted_download_redirect(attempt.url()) { attempt.follow() }
                else { attempt.stop() }
            })).build().map_err(|_| error("无法初始化内核下载"))?;
        let mut response = tokio::select! {
            result=client.get(spec.url).send()=>result.map_err(|_|error("内核下载失败，请检查网络或导入官方离线包"))?,
            _=wait_cancelled(state)=>return Err(error("内核安装已取消")),
        };
        if !response.status().is_success() || response.content_length().is_some_and(|v| v != spec.size) { return Err(error("内核下载响应无效")); }
        let mut file = tokio::fs::File::create(&archive).await.map_err(|_| error("无法保存内核包"))?;
        loop {
            cancelled(state)?;
            let chunk = tokio::select! {
                result = response.chunk() => result.map_err(|_| error("内核下载中断，请重试"))?,
                _ = wait_cancelled(state) => return Err(error("内核安装已取消")),
            };
            let Some(chunk) = chunk else { break; };
            {
                let mut s = state.status.lock().map_err(|_| error("内核状态不可用"))?;
                s.downloaded += chunk.len() as u64;
                if s.downloaded > spec.size { return Err(error("内核包超过受信大小")); }
            }
            file.write_all(&chunk).await.map_err(|_| error("无法保存内核包，请检查磁盘空间"))?;
        }
        file.flush().await.map_err(|_| error("无法保存内核包"))?;
    }
    phase(state, "verifying")?;
    let state_copy = state.clone(); let staging_copy = staging.to_path_buf();
    tokio::task::spawn_blocking(move || verify_extract(&state_copy, spec, &staging_copy)).await.map_err(|_| error("内核安装任务失败"))??;
    cancelled(state)?;
    let destination = installed_dir(spec.version)?;
    if destination.exists() { return Err(error("内核目录已存在但校验记录无效，请先清理该内核")); }
    fs::rename(staging.join("unpacked"), &destination).map_err(|_| error("无法完成内核安装，请检查目录占用"))?;
    phase(state, "ready")?;
    Ok(())
}
fn verify_extract(state: &KernelState, spec: &KernelSpec, staging: &Path) -> PlatformResult<()> {
    let mut file = fs::File::open(staging.join("kernel.zip")).map_err(|_| error("无法读取内核包"))?;
    let mut hash = Sha256::new(); let mut buffer = [0; 64 * 1024]; let mut length = 0;
    loop {
        cancelled(state)?;
        let n = file.read(&mut buffer).map_err(|_| error("无法校验内核包"))?;
        if n == 0 { break; } hash.update(&buffer[..n]); length += n as u64;
    }
    if length != spec.size || hex::encode(hash.finalize()) != spec.sha256 { return Err(error("内核 SHA-256 校验失败，未安装任何程序")); }
    phase(state, "extracting")?;
    let target = staging.join("unpacked");
    fs::create_dir(&target).map_err(|_| error("无法解压内核"))?;
    let mut zip = zip::ZipArchive::new(fs::File::open(staging.join("kernel.zip")).map_err(|_| error("无法读取内核包"))?)
        .map_err(|_| error("内核压缩包无效"))?;
    if zip.len() > 10000 { return Err(error("内核压缩包文件过多")); }
    let mut total = 0u64;
    for i in 0..zip.len() {
        cancelled(state)?;
        let mut entry = zip.by_index(i).map_err(|_| error("内核压缩包无效"))?;
        let relative = entry.enclosed_name().ok_or(error("内核包包含不安全路径"))?;
        if entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) { return Err(error("内核包不能包含符号链接")); }
        total = total.checked_add(entry.size()).ok_or(error("内核解压大小无效"))?;
        if total > 2 * 1024 * 1024 * 1024 { return Err(error("内核解压大小超过限制")); }
        let out = target.join(relative);
        if entry.is_dir() { fs::create_dir_all(out).map_err(|_| error("无法解压内核"))?; continue; }
        if let Some(parent) = out.parent() { fs::create_dir_all(parent).map_err(|_| error("无法解压内核"))?; }
        let mut output = fs::OpenOptions::new().write(true).create_new(true).open(out).map_err(|_| error("无法解压内核"))?;
        loop {
            cancelled(state)?;
            let n = entry.read(&mut buffer).map_err(|_| error("内核文件解压失败"))?;
            if n == 0 { break; }
            output.write_all(&buffer[..n]).map_err(|_| error("无法解压内核，请检查磁盘空间"))?;
        }
    }
    let executable = target.join(executable_relative(spec.version));
    if !executable.is_file() { return Err(error("内核包缺少浏览器程序")); }
    if !experimental(spec.version) { repair_cft_manifest(&target.join("chrome-win64"), spec.version)?; }
    if experimental(spec.version) {
        let bytes = fs::read(&executable).map_err(|_|error("无法校验实验内核程序"))?;
        if hex::encode(Sha256::digest(bytes)) != "f49b0d6bc5a08857e34f951ddc456abc643283ae45ff330ee7c2c39cd75b4869" { return Err(error("实验内核程序校验失败")); }
        fs::write(target.join("CLOUDHUB-THIRD-PARTY-NOTICES.txt"),include_str!("licenses/clearcote-notices.txt")).map_err(|_|error("无法保存实验内核许可说明"))?;
    }
    fs::write(target.join("cloudhub-verified.sha256"), spec.sha256).map_err(|_| error("无法保存内核校验记录"))?;
    Ok(())
}

fn trusted_download_redirect(url: &reqwest::Url) -> bool {
    url.scheme()=="https" && url.port_or_known_default()==Some(443) && url.username().is_empty() && url.password().is_none()
        && matches!(url.host_str(),Some("github.com" | "release-assets.githubusercontent.com" | "storage.googleapis.com"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chrome_for_testing_manifest_matches_dependency_identity() {
        let directory = std::env::temp_dir().join(format!("cloudhub-manifest-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let version = VERSION;
        fs::write(directory.join(format!("{version}.manifest")), format!(
            "<assembly>\n  <assemblyIdentity name='{version}' version='{version}' type='win32'/>\n  <file name='chrome_elf.dll'/>\n</assembly>"
        )).unwrap();
        repair_cft_manifest(&directory, version).unwrap();
        let manifest = fs::read_to_string(directory.join(format!("{version}.manifest"))).unwrap();
        assert!(manifest.contains("type='win32'/"));
        assert!(!manifest.contains("processorArchitecture"));
        repair_cft_manifest(&directory, version).unwrap();
        assert_eq!(fs::read_to_string(directory.join(format!("{version}.manifest"))).unwrap(), manifest);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn corrupt_archive_never_extracts() {
        let dir = std::env::temp_dir().join(format!("cloudhub-kernel-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap(); fs::write(dir.join("kernel.zip"), b"invalid archive").unwrap();
        assert!(verify_extract(&KernelState::default(), &CATALOG[0], &dir).is_err());
        assert!(!dir.join("unpacked").exists()); fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    #[ignore = "Requires CLOUDHUB_BROWSER_TEST_ARCHIVE pointing to the pinned official ZIP"]
    fn pinned_archive_verifies_and_extracts() {
        for (spec, variable) in CATALOG.iter().zip(["CLOUDHUB_BROWSER_TEST_ARCHIVE","CLOUDHUB_BROWSER_TEST_COMPAT_ARCHIVE","CLOUDHUB_BROWSER_FINGERPRINT_TEST_ARCHIVE"]) {
        let source = PathBuf::from(std::env::var_os(variable).expect("set both reviewed archive paths"));
        let dir = std::env::temp_dir().join(format!("cloudhub-kernel-test-{}",uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap(); fs::copy(source, dir.join("kernel.zip")).unwrap();
        let state = KernelState::default();
        verify_extract(&state,spec,&dir).unwrap();
        assert_eq!(fs::read_to_string(dir.join("unpacked/cloudhub-verified.sha256")).unwrap(),spec.sha256);
        assert!(dir.join("unpacked").join(executable_relative(spec.version)).is_file());
        if experimental(spec.version) { assert!(dir.join("unpacked/CLOUDHUB-THIRD-PARTY-NOTICES.txt").is_file()); }
        fs::remove_dir_all(dir).unwrap();
        }
    }
    #[test]
    fn cancelled_install_does_not_unpack_and_catalog_rejects_unknown_versions() {
        assert!(!known_version("../../outside"));assert!(!known_version("155.0.8059.85"));
        for spec in CATALOG {
            assert!(trusted_download_redirect(&reqwest::Url::parse(spec.url).unwrap()));
            assert_eq!(spec.sha256.len(),64);assert!(spec.sha256.bytes().all(|b|b.is_ascii_hexdigit()));
        }
        let dir=std::env::temp_dir().join(format!("cloudhub-cancel-test-{}",uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();fs::write(dir.join("kernel.zip"),b"not read").unwrap();
        let state=KernelState::default();state.cancel.store(true,Ordering::SeqCst);
        assert_eq!(verify_extract(&state,&CATALOG[0],&dir).unwrap_err().message,"内核安装已取消");
        assert!(!dir.join("unpacked").exists());fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn executable_download_rejects_untrusted_redirects() {
        for url in ["http://github.com/file","https://github.com.evil.test/file","https://user@github.com/file","https://github.com:444/file","https://127.0.0.1/file"] {
            assert!(!trusted_download_redirect(&reqwest::Url::parse(url).unwrap()));
        }
        assert!(trusted_download_redirect(&reqwest::Url::parse("https://release-assets.githubusercontent.com/asset?signature=synthetic").unwrap()));
    }
}
