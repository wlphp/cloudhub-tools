//! 本机电脑信息采集。刻意不读取序列号、MAC 地址或用户文件；IP 与代理由用户选择复制/导出。
use crate::core::error::{PlatformError, PlatformResult};
use serde::Serialize;
use std::process::{Command, Stdio};
#[cfg(windows)]
use std::path::PathBuf;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::time::{SystemTime, UNIX_EPOCH};

fn error(message: &'static str) -> PlatformError {
    PlatformError { kind: "platform-error", code: "hardware-info", message: message.into(), retryable: false }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HardwareInfo {
    model: String,
    os: String,
    uptime: String,
    updated_at: String,
    wifi_password_supported: bool,
    sections: Vec<HardwareSection>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WifiPasswordReveal { ssid: String, password: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HardwareSection { title: String, rows: Vec<HardwareRow> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HardwareRow { label: String, value: String }

fn section(title: &str, pairs: &[(&str, String)]) -> HardwareSection {
    HardwareSection { title: title.into(), rows: pairs.iter().map(|(label, value)| HardwareRow {
        label: (*label).into(),
        value: if value.trim().is_empty() { "未检测到".into() } else { value.trim().to_owned() },
    }).collect() }
}
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn format_uptime(seconds: u64) -> String {
    format!("{} 天 {} 小时 {} 分钟", seconds / 86_400, (seconds % 86_400) / 3_600, (seconds % 3_600) / 60)
}
fn updated_at() -> String { chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string() }
fn fallback(value: impl Into<String>) -> String {
    let value = value.into();
    if value.trim().is_empty() { "未检测到".into() } else { value.trim().to_owned() }
}

#[cfg(windows)]
fn collect() -> PlatformResult<HardwareInfo> {
    use std::os::windows::process::CommandExt;
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$cs = Get-CimInstance Win32_ComputerSystem
$os = Get-CimInstance Win32_OperatingSystem
$release = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name DisplayVersion -ErrorAction SilentlyContinue).DisplayVersion
$osCaption = $os.Caption -replace '^Microsoft\s+', ''
$osArchitecture = $os.OSArchitecture -replace '64-bit', '64位' -replace '32-bit', '32位' -replace '\s+', ''
$osText = if ($release) { "$osCaption $release $osArchitecture" } else { "$osCaption $osArchitecture（版本 $($os.Version)）" }
$cpu = (Get-CimInstance Win32_Processor | ForEach-Object { "$($_.Name)（$($_.NumberOfCores) 核 / $($_.NumberOfLogicalProcessors) 线程）" }) -join '；'
$board = (Get-CimInstance Win32_BaseBoard | ForEach-Object { "$($_.Manufacturer) $($_.Product)".Trim() }) -join '；'
$chipsetDevice = Get-CimInstance Win32_PnPEntity | Where-Object {
  $_.DeviceID -match '^PCI\\VEN_8086&DEV_([0-9A-Fa-f]{4})' -and $_.Name -match '(?i)LPC Controller|eSPI Controller|SMBus Controller'
} | Select-Object -First 1
$chipsetId = if ($chipsetDevice -and $chipsetDevice.DeviceID -match '&DEV_([0-9A-Fa-f]{4})') { $matches[1].ToUpperInvariant() } else { '' }
$chipset = switch ($chipsetId) {
  '7A0C' { 'Intel HM770' }
  '7A05' { 'Intel H770' }
  '7A06' { 'Intel B760' }
  '7A04' { 'Intel Z790' }
  '7A0D' { 'Intel WM790' }
  default { if ($chipsetDevice) { $chipsetDevice.Name.Trim() } else { '' } }
}
$memoryDevices = @(Get-CimInstance Win32_PhysicalMemory)
$memoryBytes = ($memoryDevices | Measure-Object -Property Capacity -Sum).Sum
$memoryTotal = if ($memoryBytes) { "{0:N1} GB" -f ($memoryBytes / 1GB) } else { '未检测到' }
$memoryModules = @($memoryDevices | ForEach-Object {
  $capacityGb = [math]::Round($_.Capacity / 1GB, 1).ToString([Globalization.CultureInfo]::InvariantCulture)
  $memoryType = switch ([int]$_.SMBIOSMemoryType) { 24 { 'DDR3' } 26 { 'DDR4' } 34 { 'DDR5' } default { '' } }
  $memorySpeed = if ($_.ConfiguredClockSpeed) { $_.ConfiguredClockSpeed } else { $_.Speed }
  $details = @("$capacityGb GB")
  if ($memoryType) { $details += $memoryType }
  if ($memorySpeed) { $details += "$memorySpeed MHz" }
  $details -join ' '
})
$memory = if ($memoryModules.Count -gt 0) { ((@("$memoryTotal（$($memoryModules.Count) 条）") + $memoryModules) -join '；') } else { $memoryTotal }
$nvidiaMemory = @{}
$nvidiaSmiCandidates = @((Join-Path $env:SystemRoot 'System32\nvidia-smi.exe'), (Join-Path $env:ProgramW6432 'NVIDIA Corporation\NVSMI\nvidia-smi.exe'))
foreach ($nvidiaSmi in $nvidiaSmiCandidates) {
  if (Test-Path -LiteralPath $nvidiaSmi -PathType Leaf) {
    try {
      & $nvidiaSmi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>$null | ForEach-Object {
        if ("$_" -match '^\s*(.+?),\s*(\d+)\s*$') { $nvidiaMemory[$matches[1].Trim()] = [double]$matches[2] }
      }
    } catch { }
    if ($nvidiaMemory.Count -gt 0) { break }
  }
}
$gpu = (Get-CimInstance Win32_VideoController | Where-Object {
  $_.Name -and $_.PNPDeviceID -notmatch '^(ROOT|SWD|VMBUS)\\' -and $_.Name -notmatch '(?i)virtual|indirect|remote|oray|gameviewer'
} | ForEach-Object {
  $name = $_.Name.Trim()
  if ($nvidiaMemory.ContainsKey($name)) { "$name（{0:N1}GB）" -f ($nvidiaMemory[$name] / 1024) } else { $name }
}) -join '；'
$display = try {
  $displaySizes = @{}
  Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorBasicDisplayParams -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.MaxHorizontalImageSize -gt 0 -and $_.MaxVerticalImageSize -gt 0) {
      $diagonalInches = [math]::Sqrt([math]::Pow($_.MaxHorizontalImageSize, 2) + [math]::Pow($_.MaxVerticalImageSize, 2)) / 2.54
      $displaySizes[$_.InstanceName] = "{0:N1} 英寸" -f $diagonalInches
    }
  }
  Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID -ErrorAction SilentlyContinue | ForEach-Object {
    $manufacturerBytes = [byte[]]@($_.ManufacturerName | Where-Object { $null -ne $_ -and $_ -ne 0 })
    $productBytes = [byte[]]@($_.ProductCodeID | Where-Object { $null -ne $_ -and $_ -ne 0 })
    $nameBytes = [byte[]]@($_.UserFriendlyName | Where-Object { $null -ne $_ -and $_ -ne 0 })
    $manufacturerCode = if ($manufacturerBytes.Length -gt 0) { [Text.Encoding]::ASCII.GetString($manufacturerBytes).Trim() } else { '' }
    $productCode = if ($productBytes.Length -gt 0) { [Text.Encoding]::ASCII.GetString($productBytes).Trim() } else { '' }
    $friendlyName = if ($nameBytes.Length -gt 0) { [Text.Encoding]::ASCII.GetString($nameBytes).Trim() } else { '' }
    $manufacturerName = switch ($manufacturerCode) { 'PHL' { '飞利浦' } 'BOE' { '京东方' } default { $manufacturerCode } }
    $hardwareCode = "$manufacturerCode$productCode"
    # BOE0A1F is a known EDID product-code alias; other panels keep their reported EDID name/code.
    $knownPanelModels = @{ 'BOE0A1F' = 'NE160QDM-NY1' }
    $panelModel = $knownPanelModels[$hardwareCode]
    $label = if ($panelModel) { $panelModel } elseif ($friendlyName) { $friendlyName } elseif ($manufacturerName -and $productCode) { "$manufacturerName $productCode" } elseif ($hardwareCode) { $hardwareCode } else { '显示器' }
    $metadata = @()
    if ($manufacturerName -and ($friendlyName -or $panelModel)) { $metadata += "$manufacturerName $hardwareCode" }
    if ($displaySizes.ContainsKey($_.InstanceName)) { $metadata += $displaySizes[$_.InstanceName] }
    if ($metadata.Count -gt 0) { "$label（$($metadata -join '，')）" } else { $label }
  } | Where-Object { $_ }
} catch { @() }
$display = @($display) -join '；'
$disk = (Get-CimInstance Win32_DiskDrive | ForEach-Object { $sizeGb = [math]::Round($_.Size / 1000000000).ToString([Globalization.CultureInfo]::InvariantCulture); "$($_.Model)（${sizeGb}GB）" }) -join '；'
$audio = (Get-CimInstance Win32_SoundDevice | Where-Object {
  $_.Name -and $_.PNPDeviceID -notmatch '^(ROOT|SWD)\\' -and $_.Name -notmatch '(?i)virtual|mirroring|loopback|intel.*(智音技术|smart sound)|英特尔.*智音技术'
} | ForEach-Object { $_.Name.Trim() }) -join '；'
$networkNames = Get-CimInstance Win32_NetworkAdapter -Filter 'PhysicalAdapter=True' | Where-Object {
  $_.Name -and $_.PNPDeviceID -notmatch '^(ROOT|SWD|VMBUS|BTH)\\' -and $_.Name -notmatch '(?i)virtual|tunnel|loopback|tap|wintun|hyper-v|vmware|virtualbox|vpn|bluetooth'
} | ForEach-Object { ($_.Name.Trim() -replace '\s+#\d+$', '') } | Select-Object -Unique
$network = @($networkNames) -join '；'
$physicalAdapters = @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.Name -and $_.Name -notmatch '(?i)virtual|tunnel|loopback|tap|wintun|hyper-v|vmware|virtualbox|vpn|bluetooth' })
$interfaceDetails = @($physicalAdapters | ForEach-Object { "$($_.Name)（$($_.Status)，$($_.LinkSpeed)）" }) -join '；'
$wifiAdapter = $physicalAdapters | Where-Object { $_.NdisPhysicalMedium -eq 9 -and $_.Status -eq 'Up' } | Select-Object -First 1
$wifiProfile = if ($wifiAdapter) { Get-NetConnectionProfile -InterfaceIndex $wifiAdapter.ifIndex -ErrorAction SilentlyContinue | Select-Object -First 1 } else { $null }
$wifi = if ($wifiProfile) { "$($wifiProfile.Name)（已连接，$($wifiAdapter.LinkSpeed)）" } elseif ($physicalAdapters | Where-Object { $_.NdisPhysicalMedium -eq 9 }) { 'Wi-Fi 未连接' } else { '未检测到无线网卡' }
$physicalAliases = @($physicalAdapters.Name)
$networkConfigurations = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object { $physicalAliases -contains $_.InterfaceAlias })
$ipv4Addresses = @($networkConfigurations | ForEach-Object { $_.IPv4Address | ForEach-Object { $_.IPAddress } } | Where-Object { $_ -and $_ -notmatch '^169\.254\.' } | Select-Object -Unique) -join '；'
$gateways = @($networkConfigurations | ForEach-Object { $_.IPv4DefaultGateway | ForEach-Object { $_.NextHop } } | Where-Object { $_ } | Select-Object -Unique) -join '；'
$dnsServers = @($networkConfigurations | ForEach-Object { $_.DNSServer.ServerAddresses } | Where-Object { $_ } | Select-Object -Unique) -join '；'
$internetSettings = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
$proxyDetails = @()
if ($internetSettings.ProxyEnable -eq 1) {
  $proxyServer = [string]$internetSettings.ProxyServer
  $proxyServer = $proxyServer -replace '(?i)(https?://)[^/@;]+@', '$1[凭据已隐藏]@' -replace '(?i)(^|[=;])[^=;:@/]+:[^=;@/]+@', '$1[凭据已隐藏]@'
  $proxyDetails += if ($proxyServer) { "手动代理已启用：$proxyServer" } else { '手动代理已启用' }
} else { $proxyDetails += '手动代理未启用' }
if ($internetSettings.AutoConfigURL) { $proxyDetails += 'PAC 自动配置已设置' }
if ($internetSettings.AutoDetect -eq 1) { $proxyDetails += '自动发现已启用' }
$proxy = $proxyDetails -join '；'
$cameras = @(Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue | Where-Object { $_.PNPClass -in @('Camera', 'Image') -and $_.Status -eq 'OK' -and $_.Name -notmatch '(?i)virtual|virtual camera' } | ForEach-Object { $_.Name.Trim() } | Select-Object -Unique) -join '；'
$batteryDevices = @(Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | ForEach-Object {
  $batteryStatus = switch ([int]$_.BatteryStatus) { 3 { '已充满' } 4 { '电量低' } 5 { '电量严重不足' } 6 { '正在充电' } 7 { '正在充电' } 8 { '正在充电' } 9 { '正在充电' } 11 { '部分充电' } default { '状态未知' } }
  $charge = if ($null -ne $_.EstimatedChargeRemaining) { "$($_.EstimatedChargeRemaining)%" } else { '' }
  $batteryParts = @($_.Name, $charge, $batteryStatus) | Where-Object { $_ }
  $batteryParts -join '，'
})
$battery = if ($batteryDevices.Count -gt 0) { $batteryDevices -join '；' } else { '未检测到电池' }
$span = (Get-Date) - $os.LastBootUpTime
$uptime = '{0} 天 {1} 小时 {2} 分钟' -f [int]$span.TotalDays, $span.Hours, $span.Minutes
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[pscustomobject]@{
  model = "$($cs.Manufacturer) $($cs.Model)".Trim()
  os = $osText
  uptime = $uptime
  cpu = $cpu
  board = $board
  chipset = $chipset
  memory = $memory
  gpu = $gpu
  display = $display
  disk = $disk
  audio = $audio
  network = $network
  interfaceDetails = $interfaceDetails
  wifi = $wifi
  ipv4Addresses = $ipv4Addresses
  gateways = $gateways
  dnsServers = $dnsServers
  proxy = $proxy
  cameras = $cameras
  battery = $battery
} | ConvertTo-Json -Compress
"#;
    let root = std::env::var_os("SystemRoot").ok_or_else(|| error("无法读取本机硬件信息"))?;
    let powershell = PathBuf::from(root).join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe");
    let output = Command::new(powershell).args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .creation_flags(0x08000000).stdin(Stdio::null()).stderr(Stdio::null()).output()
        .map_err(|_| error("读取本机硬件信息失败"))?;
    if !output.status.success() || output.stdout.len() > 1024 * 1024 { return Err(error("读取本机硬件信息失败")); }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|_| error("本机硬件信息格式无效"))?;
    let field = |name: &str| value.get(name).and_then(serde_json::Value::as_str).unwrap_or("").to_owned();
    let model = fallback(field("model"));
    let os = fallback(field("os"));
    let uptime = fallback(field("uptime"));
    Ok(HardwareInfo {
        model, os, uptime, updated_at: updated_at(), wifi_password_supported: cfg!(windows),
        sections: vec![
            section("处理器与主板", &[("处理器", field("cpu")), ("主板", field("board")), ("芯片组", field("chipset"))]),
            section("内存与显卡", &[("内存", field("memory")), ("显卡", field("gpu"))]),
            section("显示与存储", &[("显示器", field("display")), ("磁盘", field("disk"))]),
            section("网络与代理", &[("网卡", field("network")), ("接口状态", field("interfaceDetails")), ("当前 Wi-Fi", field("wifi")), ("局域网 IPv4", field("ipv4Addresses")), ("默认网关", field("gateways")), ("DNS 服务器", field("dnsServers")), ("系统代理", field("proxy"))]),
            section("音频、摄像头与电源", &[("声卡", field("audio")), ("摄像头", field("cameras")), ("电池", field("battery"))]),
        ],
    })
}

#[cfg(target_os = "macos")]
fn collect() -> PlatformResult<HardwareInfo> {
    fn first_text(value: &serde_json::Value, keys: &[&str]) -> String {
        if let Some(object) = value.as_object() {
            for key in keys {
                if let Some(text) = object.get(*key).and_then(serde_json::Value::as_str) {
                    if !text.trim().is_empty() { return text.trim().to_owned(); }
                }
            }
            for child in object.values() { let text = first_text(child, keys); if !text.is_empty() { return text; } }
        } else if let Some(array) = value.as_array() {
            for child in array { let text = first_text(child, keys); if !text.is_empty() { return text; } }
        }
        String::new()
    }
    fn names(value: &serde_json::Value, key: &str, result: &mut Vec<String>) {
        if let Some(object) = value.as_object() {
            if let Some(text) = object.get(key).and_then(serde_json::Value::as_str) {
                let text = text.trim();
                if !text.is_empty() && !result.iter().any(|item| item == text) { result.push(text.into()); }
            }
            for child in object.values() { names(child, key, result); }
        } else if let Some(array) = value.as_array() {
            for child in array { names(child, key, result); }
        }
    }
    fn run(program: &str, args: &[&str]) -> String {
        Command::new(program).args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()
            .filter(|output| output.status.success() && output.stdout.len() <= 8 * 1024 * 1024)
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned()).unwrap_or_default()
    }
    let output = Command::new("system_profiler")
        .args(["-json", "SPHardwareDataType", "SPDisplaysDataType", "SPMemoryDataType", "SPStorageDataType", "SPAudioDataType", "SPNetworkDataType"])
        .stdin(Stdio::null()).stderr(Stdio::null()).output().map_err(|_| error("无法读取本机硬件信息"))?;
    if !output.status.success() || output.stdout.len() > 8 * 1024 * 1024 { return Err(error("读取本机硬件信息失败")); }
    let data: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|_| error("本机硬件信息格式无效"))?;
    let hardware = &data["SPHardwareDataType"];
    let graphics = &data["SPDisplaysDataType"];
    let model = first_text(hardware, &["machine_name", "machine_model", "model_number"]);
    let chip = first_text(hardware, &["chip_type", "processor_name"]);
    let memory = first_text(hardware, &["physical_memory"]);
    let gpu = first_text(graphics, &["sppci_model"]);
    let resolution = first_text(graphics, &["spdisplays_resolution"]);
    let mut displays = Vec::new(); names(graphics, "_name", &mut displays);
    if !resolution.is_empty() { displays.push(resolution); }
    let mut disks = Vec::new(); names(&data["SPStorageDataType"], "_name", &mut disks);
    let mut audio = Vec::new(); names(&data["SPAudioDataType"], "_name", &mut audio);
    let mut network = Vec::new(); names(&data["SPNetworkDataType"], "_name", &mut network);
    let boot = run("sysctl", &["-n", "kern.boottime"]);
    let boot_seconds = boot.split("sec =").nth(1).and_then(|tail| tail.split(',').next()).and_then(|value| value.trim().parse::<u64>().ok()).unwrap_or(0);
    let uptime = format_uptime(SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs().saturating_sub(boot_seconds));
    let os = format!("{} {}", run("sw_vers", &["-productName"]), run("sw_vers", &["-productVersion"]));
    Ok(HardwareInfo {
        model: fallback(model), os: fallback(os), uptime, updated_at: updated_at(), wifi_password_supported: false,
        sections: vec![
            section("处理器与主板", &[("处理器", chip), ("主板", "Apple 集成式平台".into())]),
            section("内存与显卡", &[("内存", memory), ("显卡", gpu)]),
            section("显示与存储", &[("显示器", displays.join("；")), ("磁盘", disks.join("；"))]),
            section("音频与网络", &[("声卡", audio.join("；")), ("网卡", network.join("；"))]),
        ],
    })
}

#[cfg(target_os = "linux")]
fn collect() -> PlatformResult<HardwareInfo> {
    fn read(path: &str) -> String { std::fs::read_to_string(path).unwrap_or_default().trim().to_owned() }
    fn run(program: &str, args: &[&str]) -> String {
        Command::new(program).args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()
            .filter(|output| output.status.success() && output.stdout.len() <= 1024 * 1024)
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned()).unwrap_or_default()
    }
    let cpu = read("/proc/cpuinfo").lines().find_map(|line| line.strip_prefix("model name\t:").map(str::trim).map(str::to_owned)).unwrap_or_default();
    let total_kb = read("/proc/meminfo").lines().find_map(|line| line.strip_prefix("MemTotal:").and_then(|value| value.split_whitespace().next()).and_then(|value| value.parse::<u64>().ok())).unwrap_or(0);
    let model = [read("/sys/class/dmi/id/sys_vendor"), read("/sys/class/dmi/id/product_name")].into_iter().filter(|value| !value.is_empty()).collect::<Vec<_>>().join(" ");
    let board = [read("/sys/class/dmi/id/board_vendor"), read("/sys/class/dmi/id/board_name")].into_iter().filter(|value| !value.is_empty()).collect::<Vec<_>>().join(" ");
    let uptime_seconds = read("/proc/uptime").split_whitespace().next().and_then(|value| value.parse::<f64>().ok()).map(|value| value as u64).unwrap_or(0);
    let devices = run("lspci", &[]);
    let gpu = devices.lines().filter(|line| { let value = line.to_ascii_lowercase(); value.contains("vga compatible controller") || value.contains("3d controller") || value.contains("display controller") }).map(str::trim).collect::<Vec<_>>().join("；");
    let audio = devices.lines().filter(|line| line.to_ascii_lowercase().contains("audio device")).map(str::trim).collect::<Vec<_>>().join("；");
    let network = std::fs::read_dir("/sys/class/net").ok().into_iter().flatten().filter_map(Result::ok).filter_map(|entry| entry.file_name().into_string().ok()).filter(|name| name != "lo").collect::<Vec<_>>().join("；");
    let os = read("/etc/os-release").lines().find_map(|line| line.strip_prefix("PRETTY_NAME=").map(|value| value.trim_matches('"').to_owned())).unwrap_or_else(|| run("uname", &["-sr"]));
    let disk = run("lsblk", &["-dn", "-o", "NAME,MODEL,SIZE"]);
    let display = run("xrandr", &["--current"]);
    Ok(HardwareInfo {
        model: fallback(model), os: fallback(os), uptime: format_uptime(uptime_seconds), updated_at: updated_at(), wifi_password_supported: false,
        sections: vec![
            section("处理器与主板", &[("处理器", cpu), ("主板", board)]),
            section("内存与显卡", &[("内存", if total_kb > 0 { format!("{:.1} GB", total_kb as f64 / 1024.0 / 1024.0) } else { String::new() }), ("显卡", gpu)]),
            section("显示与存储", &[("显示器", display), ("磁盘", disk)]),
            section("音频与网络", &[("声卡", audio), ("网卡", network)]),
        ],
    })
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn collect() -> PlatformResult<HardwareInfo> { Err(error("硬件信息插件当前不支持此桌面平台")) }

#[tauri::command]
pub(crate) async fn hardware_info_get() -> PlatformResult<HardwareInfo> {
    tauri::async_runtime::spawn_blocking(collect).await.map_err(|_| error("读取本机硬件信息失败"))?
}

#[cfg(windows)]
fn reveal_wifi_password() -> PlatformResult<WifiPasswordReveal> {
    use std::os::windows::process::CommandExt;
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$netsh = Join-Path $env:SystemRoot 'System32\netsh.exe'
$profileName = ''
try {
  $wifiAdapter = Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.NdisPhysicalMedium -eq 9 -and $_.Status -eq 'Up' } | Select-Object -First 1
  if ($wifiAdapter) {
    $wifiProfile = Get-NetConnectionProfile -InterfaceIndex $wifiAdapter.ifIndex -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($wifiProfile -and $wifiProfile.Name) { $profileName = [string]$wifiProfile.Name }
  }
} catch { }
if (-not $profileName) {
  $interfaces = @(& $netsh wlan show interfaces 2>$null)
  $interfaceText = $interfaces -join "`n"
  if ($interfaceText -match '(?i)Network shell commands need location permission|WlanQueryInterface returns error 5|需要位置权限|需要位置服务') {
    [pscustomobject]@{ error = 'location-permission' } | ConvertTo-Json -Compress
    exit 0
  }
  foreach ($block in (($interfaceText) -split "(?:\r?\n){2,}")) {
    $state = [regex]::Match($block, '(?im)^\s*(?:State|状态)\s*:\s*(.+?)\s*$')
    $ssidMatch = [regex]::Match($block, '(?im)^\s*SSID\s*:\s*(.+?)\s*$')
    if ($state.Success -and $state.Groups[1].Value -match '(?i)connected|已连接|已連線' -and $ssidMatch.Success) {
      $profileName = $ssidMatch.Groups[1].Value.Trim()
      break
    }
  }
}
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if (-not $profileName) { [pscustomobject]@{ error = 'not-connected' } | ConvertTo-Json -Compress; exit 0 }
$result = @(& $netsh wlan show profile "name=$profileName" key=clear 2>$null)
$keyLine = $result | Where-Object { $_ -match '^\s*(?:Key Content|关键内容|密钥内容)\s*:\s*(.+?)\s*$' } | Select-Object -First 1
if (-not $keyLine) { [pscustomobject]@{ error = 'password-unavailable' } | ConvertTo-Json -Compress; exit 0 }
$null = $keyLine -match '^\s*(?:Key Content|关键内容|密钥内容)\s*:\s*(.+?)\s*$'
[pscustomobject]@{ ssid = $profileName; password = $matches[1] } | ConvertTo-Json -Compress
"#;
    let root = std::env::var_os("SystemRoot").ok_or_else(|| error("无法读取当前 Wi-Fi 密码"))?;
    let powershell = PathBuf::from(root).join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe");
    let output = Command::new(powershell).args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .creation_flags(0x08000000).stdin(Stdio::null()).stderr(Stdio::null()).output()
        .map_err(|_| error("无法读取当前 Wi-Fi 密码"))?;
    if !output.status.success() || output.stdout.len() > 64 * 1024 { return Err(error("读取当前 Wi-Fi 配置失败，请检查无线网络状态后重试")); }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|_| error("无法读取当前 Wi-Fi 密码"))?;
    match value.get("error").and_then(serde_json::Value::as_str) {
        Some("not-connected") => return Err(error("未检测到已连接的 Wi-Fi 网络")),
        Some("location-permission") => return Err(error("请在 Windows 设置 > 隐私和安全性 > 位置中开启位置服务，并允许桌面应用访问位置后重试")),
        Some("password-unavailable") => return Err(error("当前 Wi-Fi 没有可读取的已保存密码；企业认证网络可能不使用共享密码")),
        _ => {}
    }
    let ssid = value.get("ssid").and_then(serde_json::Value::as_str).unwrap_or("");
    let password = value.get("password").and_then(serde_json::Value::as_str).unwrap_or("");
    if ssid.trim().is_empty() || ssid.len() > 256 || password.is_empty() || password.len() > 1024 || password.contains('\0') {
        return Err(error("当前 Wi-Fi 没有可显示的已保存密码"));
    }
    Ok(WifiPasswordReveal { ssid: ssid.to_owned(), password: password.to_owned() })
}

#[cfg(not(windows))]
fn reveal_wifi_password() -> PlatformResult<WifiPasswordReveal> {
    Err(error("此平台暂不支持读取已保存的 Wi-Fi 密码"))
}

#[tauri::command]
pub(crate) async fn hardware_wifi_password_reveal() -> PlatformResult<WifiPasswordReveal> {
    tauri::async_runtime::spawn_blocking(reveal_wifi_password).await.map_err(|_| error("无法读取当前 Wi-Fi 密码"))?
}

#[tauri::command]
pub(crate) async fn hardware_info_export_png(app: tauri::AppHandle, data_url: String) -> PlatformResult<Option<String>> {
    use base64::Engine;
    use tauri_plugin_dialog::DialogExt;
    if data_url.len() > 12 * 1024 * 1024 { return Err(error("导出的图片超过大小限制")); }
    let encoded = data_url.strip_prefix("data:image/png;base64,").ok_or_else(|| error("图片格式无效，请重新导出"))?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| error("图片格式无效，请重新导出"))?;
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" { return Err(error("图片格式无效，请重新导出")); }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap_or_default());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap_or_default());
    if width == 0 || height == 0 || width > 4096 || height > 4096 || width as u64 * height as u64 > 16_000_000 {
        return Err(error("图片尺寸超过限制，请缩小后重试"));
    }
    let Some(selected) = app.dialog().file().set_title("导出电脑信息图片").set_file_name("电脑信息.png").add_filter("PNG 图片", &["png"]).blocking_save_file() else {
        return Ok(None);
    };
    let mut path = selected.into_path().map_err(|_| error("保存位置无效"))?;
    if path.extension().and_then(|value| value.to_str()).is_none() { path.set_extension("png"); }
    else if !path.extension().is_some_and(|value| value.eq_ignore_ascii_case("png")) { return Err(error("请使用 PNG 图片格式")); }
    std::fs::write(&path, bytes).map_err(|_| error("图片保存失败，请检查目录权限和磁盘空间"))?;
    Ok(path.to_str().map(str::to_owned))
}
