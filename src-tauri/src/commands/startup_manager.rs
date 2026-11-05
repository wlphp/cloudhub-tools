use serde::{Deserialize, Serialize};
use std::process::{Command, Stdio};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupEntry {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub detail: String,
    pub source: String,
    pub status: String,
    pub recommendation: String,
    pub can_change: bool,
    #[serde(default)]
    pub icon_data: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupSnapshot {
    pub supported: bool,
    pub entries: Vec<StartupEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartupAction {
    pub kind: String,
    pub id: String,
    pub enabled: bool,
}

#[cfg(test)]
mod tests {
    use super::{startup_manager_set, StartupAction};

    #[test]
    fn rejects_unmatched_startup_identifier() {
        let result = startup_manager_set(StartupAction { kind: "startup".into(), id: "a".repeat(64), enabled: false });
        assert!(result.is_err());
    }

    #[test]
    fn rejects_malformed_identifiers_before_system_access() {
        let result = startup_manager_set(StartupAction { kind: "task".into(), id: "not-a-digest".into(), enabled: false });
        assert!(result.is_err());
    }
}

#[cfg(target_os = "windows")]
fn powershell(script: &str, kind: Option<&str>, id: Option<&str>, enabled: Option<bool>) -> Result<String, String> {
    let mut command = Command::new("powershell.exe");
    command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-Command", script])
        .stdin(Stdio::null()).stderr(Stdio::null()).stdout(Stdio::piped());
    if let Some(value) = kind { command.env("CLOUDHUB_ITEM_KIND", value); }
    if let Some(value) = id { command.env("CLOUDHUB_ITEM_ID", value); }
    if let Some(value) = enabled { command.env("CLOUDHUB_ITEM_ENABLED", if value { "1" } else { "0" }); }
    let output = command.output().map_err(|_| "无法启动 Windows 系统管理接口".to_string())?;
    if !output.status.success() { return Err("Windows 系统管理操作失败，请检查权限并刷新状态".into()); }
    String::from_utf8(output.stdout).map_err(|_| "Windows 系统管理结果编码无效".into())
}

#[tauri::command]
pub fn startup_manager_list() -> Result<StartupSnapshot, String> {
    #[cfg(target_os = "windows")]
    {
        const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
$items = [System.Collections.Generic.List[object]]::new()
function Get-CloudHubHash([string]$value) { $sha = [Security.Cryptography.SHA256]::Create(); try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($value))).Replace('-', '').ToLowerInvariant()) } finally { $sha.Dispose() } }
function Test-CloudHubLocalFile([string]$path) {
  if ($path -notmatch '^[A-Za-z]:\\') { return $false }
  try {
    $drive = New-Object System.IO.DriveInfo ([IO.Path]::GetPathRoot($path))
    if ($drive.DriveType -ne [IO.DriveType]::Fixed) { return $false }
    $file = Get-Item -LiteralPath $path -ErrorAction Stop
    return $file -is [IO.FileInfo] -and -not ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)
  } catch { return $false }
}
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$runPrefix = "HKU\$currentSid\SOFTWARE\Microsoft\Windows\CurrentVersion\"
$allowedRunLocations = @(); $allowedRunLocations += $runPrefix + 'Run'; $allowedRunLocations += $runPrefix + 'RunOnce'
function Get-CloudHubIconData([string]$command) {
  try {
    $rawCommand = [Environment]::ExpandEnvironmentVariables($command).Trim()
    $exePath = $null
    if ($rawCommand -match '^"([^"]+\.(?i:exe|lnk))"') { $exePath = $Matches[1] }
    elseif ($rawCommand -match '^(.+?\.(?i:exe|lnk))(?=\s|$)') { $exePath = $Matches[1].Trim('"') }
    if (-not $exePath -or -not (Test-CloudHubLocalFile $exePath)) { return $null }
    if ([IO.Path]::GetExtension($exePath) -ieq '.lnk') { $exePath = (New-Object -ComObject WScript.Shell).CreateShortcut($exePath).TargetPath }
    if (-not $exePath -or [IO.Path]::GetExtension($exePath) -ine '.exe' -or -not (Test-CloudHubLocalFile $exePath)) { return $null }
    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exePath)
    if (-not $icon) { return $null }
    $sourceBitmap = $icon.ToBitmap(); $bitmap = New-Object System.Drawing.Bitmap 32,32; $graphics = [System.Drawing.Graphics]::FromImage($bitmap); $stream = New-Object IO.MemoryStream
    try { $graphics.Clear([System.Drawing.Color]::Transparent); $graphics.DrawImage($sourceBitmap, 0, 0, 32, 32); $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png); return 'data:image/png;base64,' + [Convert]::ToBase64String($stream.ToArray()) }
    finally { $graphics.Dispose(); $bitmap.Dispose(); $sourceBitmap.Dispose(); $icon.Dispose(); $stream.Dispose() }
  } catch { return $null }
}
Get-CimInstance Win32_StartupCommand -ErrorAction SilentlyContinue | ForEach-Object {
  $identity = 'startup|' + $_.Name + '|' + $_.Location + '|' + $_.Command
  $hash = Get-CloudHubHash $identity
  $canChange = $false
  if ($allowedRunLocations -icontains [string]$_.Location) {
    $relativePath = 'SOFTWARE\Microsoft\Windows\CurrentVersion\' + $(if ([string]$_.Location -match '(?i)RunOnce$') { 'RunOnce' } else { 'Run' })
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($relativePath)
    if ($key) { try { if ($key.GetValueNames() -contains [string]$_.Name) { $canChange = $key.GetValueKind([string]$_.Name).ToString() -in @('String','ExpandString') } } finally { $key.Dispose() } }
  }
  $items.Add(@{ id=$hash; kind='startup'; name=[string]$_.Name; detail='登录 Windows 时运行'; source=[string]$_.Location; status='已启用'; recommendation=$(if ($canChange) {'可逐项启停，支持恢复'} else {'确认用途后再处理'}); canChange=$canChange; iconData=(Get-CloudHubIconData ([string]$_.Command)) })
}
$disabledRoot = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\CloudHubTools\StartupManager\Disabled')
if ($disabledRoot) {
  try { foreach ($disabledId in $disabledRoot.GetSubKeyNames()) {
    if ($disabledId -notmatch '^[a-fA-F0-9]{64}$') { continue }
    $backup = $disabledRoot.OpenSubKey($disabledId)
    if (-not $backup) { continue }
    try {
      $source = [string]$backup.GetValue('OriginalPath', '')
      $name = [string]$backup.GetValue('ValueName', '')
      $kind = [string]$backup.GetValue('ValueKind', '')
      $restored = [bool]$backup.GetValue('Restored', $false)
      $command = $backup.GetValue('ValueData', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if (-not $restored -and $source -in $allowedRunLocations -and $name -and $kind -in @('String','ExpandString') -and $null -ne $command) {
        $items.Add(@{ id=$disabledId.ToLowerInvariant(); kind='startup'; name=$name; detail='登录 Windows 时运行（已禁用）'; source=$source; status='已禁用'; recommendation='已保存原值，可恢复'; canChange=$true; iconData=(Get-CloudHubIconData ([string]$command)) })
      }
    } finally { $backup.Dispose() }
  } } finally { $disabledRoot.Dispose() }
}
Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object {
  $task = $_; $identity = 'task|' + $task.TaskPath + $task.TaskName
  $hash = Get-CloudHubHash $identity
  $state = [string]$task.State
  $protected = $task.TaskPath -like '\Microsoft\Windows\*'
  $items.Add(@{ id=$hash; kind='task'; name=[string]$task.TaskName; detail='Windows 计划任务'; source=[string]$task.TaskPath; status=$(if ($state -eq 'Disabled') {'已禁用'} else {'已启用'}); recommendation=$(if ($protected) {'Windows 系统任务，保持现状'} else {'确认用途后再调整'}); canChange=(-not $protected) })
}
Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | ForEach-Object {
  $service = $_; $identity = 'service|' + $service.Name
  $hash = Get-CloudHubHash $identity
  $state = if ($service.StartMode -eq 'Disabled') {'已禁用'} elseif ($service.StartMode -eq 'Auto') {'自动启动'} elseif ($service.StartMode -eq 'Manual') {'手动启动'} else {[string]$service.StartMode}
  $manageable = $service.PathName -match '(?i)\\Program Files\\|\\ProgramData\\|\\AppData\\' -and $service.PathName -notmatch '(?i)Microsoft|Windows Defender' -and $service.StartMode -notin @('Boot','System') -and $service.Name -notmatch '^(RpcSs|DcomLaunch|EventLog|PlugPlay|WinDefend|SecurityHealthService)$'
  $recommendation = if ($manageable) {'确认用途后再调整'} else {'系统组件或路径不明确，只读'}
  $items.Add(@{ id=$hash; kind='service'; name=[string]$service.DisplayName; detail=[string]$service.Description; source=[string]$service.Name; status=$state; recommendation=$recommendation; canChange=$manageable })
}
ConvertTo-Json -InputObject @($items) -Depth 4 -Compress
"#;
        let raw = powershell(SCRIPT, None, None, None)?;
        let entries: Vec<serde_json::Value> = if raw.trim().is_empty() { Vec::new() } else { serde_json::from_str(&raw).map_err(|_| "无法解析 Windows 启动管理结果".to_string())? };
        let entries = entries.into_iter().filter_map(|item| serde_json::from_value::<StartupEntry>(item).ok()).map(|mut entry| {
            if entry.icon_data.as_ref().is_some_and(|value| value.len() > 32_000 || !value.starts_with("data:image/png;base64,") || !value["data:image/png;base64,".len()..].bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/' || byte == b'=')) { entry.icon_data = None; }
            entry
        }).collect();
        Ok(StartupSnapshot { supported: true, entries })
    }
    #[cfg(not(target_os = "windows"))]
    { Ok(StartupSnapshot { supported: false, entries: Vec::new() }) }
}

#[tauri::command]
pub fn startup_manager_set(request: StartupAction) -> Result<(), String> {
    if request.id.len() != 64 || !request.id.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err("项目标识无效，请刷新列表后重试".into()); }
    if !matches!(request.kind.as_str(), "task" | "service" | "startup") { return Err("项目类型无效".into()); }
    #[cfg(target_os = "windows")]
    {
        const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$kind = $env:CLOUDHUB_ITEM_KIND; $id = $env:CLOUDHUB_ITEM_ID; $enabled = $env:CLOUDHUB_ITEM_ENABLED -eq '1'
function Get-CloudHubHash([string]$value) { $sha = [Security.Cryptography.SHA256]::Create(); try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($value))).Replace('-', '').ToLowerInvariant()) } finally { $sha.Dispose() } }
if ($kind -eq 'startup') {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $runPrefix = "HKU\$sid\SOFTWARE\Microsoft\Windows\CurrentVersion\"
  $allowedLocations = @(); $allowedLocations += $runPrefix + 'Run'; $allowedLocations += $runPrefix + 'RunOnce'
  $backupPath = "Software\CloudHubTools\StartupManager\Disabled\$id"
  if ($enabled) {
    $backup = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($backupPath, $true)
    if (-not $backup) { throw '未找到可恢复的启动项备份，请刷新列表后重试' }
    try {
      $source = [string]$backup.GetValue('OriginalPath', '')
      $name = [string]$backup.GetValue('ValueName', '')
      $kindName = [string]$backup.GetValue('ValueKind', '')
      $data = $backup.GetValue('ValueData', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if ($source -notin $allowedLocations -or -not $name -or $kindName -notin @('String','ExpandString') -or $null -eq $data) { throw '启动项备份无效或来源已变化，已拒绝恢复' }
      $relativePath = 'SOFTWARE\Microsoft\Windows\CurrentVersion\' + $(if ($source -match '(?i)RunOnce$') { 'RunOnce' } else { 'Run' })
      $targetKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($relativePath)
      try {
        if ($targetKey.GetValueNames() -contains $name) { throw '原启动项位置已有同名值；为避免覆盖，未执行恢复' }
        $valueKind = [Enum]::Parse([Microsoft.Win32.RegistryValueKind], $kindName)
        $targetKey.SetValue($name, $data, $valueKind)
      } finally { $targetKey.Dispose() }
      $backup.SetValue('Restored', [int]1, [Microsoft.Win32.RegistryValueKind]::DWord)
    } finally { $backup.Dispose() }
    $parent = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\CloudHubTools\StartupManager\Disabled', $true)
    if ($parent) { try { $parent.DeleteSubKeyTree($id, $false) } finally { $parent.Dispose() } }
  } else {
    $item = Get-CimInstance Win32_StartupCommand -ErrorAction Stop | Where-Object { $identity = 'startup|' + $_.Name + '|' + $_.Location + '|' + $_.Command; (Get-CloudHubHash $identity) -eq $id } | Select-Object -First 1
    if (-not $item -or $allowedLocations -inotcontains [string]$item.Location) { throw '此启动项不属于当前用户可管理的 Run/RunOnce 范围' }
    $relativePath = 'SOFTWARE\Microsoft\Windows\CurrentVersion\' + $(if ([string]$item.Location -match '(?i)RunOnce$') { 'RunOnce' } else { 'Run' })
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($relativePath, $true)
    if (-not $key) { throw '启动项注册表位置不可访问' }
    $backupParent = $null; $backup = $null
    try {
      $name = [string]$item.Name
      if (-not $name -or $key.GetValueNames() -inotcontains $name) { throw '启动项已变化，请刷新列表后重试' }
      $valueKind = $key.GetValueKind($name)
      if ($valueKind -notin @([Microsoft.Win32.RegistryValueKind]::String, [Microsoft.Win32.RegistryValueKind]::ExpandString)) { throw '此类注册表值不支持安全停用' }
      $data = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if ($null -eq $data) { throw '无法读取启动项原值，已取消操作' }
      $backupParent = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\CloudHubTools\StartupManager\Disabled')
      if ($backupParent.GetSubKeyNames() -contains $id) { throw '已存在此启动项的备份，请先刷新列表' }
      $backup = $backupParent.CreateSubKey($id)
      $backup.SetValue('OriginalPath', [string]$item.Location, [Microsoft.Win32.RegistryValueKind]::String)
      $backup.SetValue('ValueName', $name, [Microsoft.Win32.RegistryValueKind]::String)
      $backup.SetValue('ValueKind', $valueKind.ToString(), [Microsoft.Win32.RegistryValueKind]::String)
      $backup.SetValue('ValueData', $data, $valueKind)
      $backup.Dispose(); $backup = $null
      $key.DeleteValue($name, $false)
    } catch {
      if ($backup) { $backup.Dispose(); $backup = $null }
      if ($backupParent) { try { $backupParent.DeleteSubKeyTree($id, $false) } catch {} }
      throw
    } finally { if ($key) { $key.Dispose() }; if ($backupParent) { $backupParent.Dispose() } }
  }
} elseif ($kind -eq 'task') {
  $item = Get-ScheduledTask -ErrorAction Stop | Where-Object { $identity = 'task|' + $_.TaskPath + $_.TaskName; (Get-CloudHubHash $identity) -eq $id } | Select-Object -First 1
  if (-not $item -or $item.TaskPath -like '\Microsoft\Windows\*') { throw '项目不存在、已变化或属于受保护的 Windows 系统任务' }
  if ($enabled) { Enable-ScheduledTask -InputObject $item | Out-Null } else { Disable-ScheduledTask -InputObject $item | Out-Null }
} elseif ($kind -eq 'service') {
  $item = Get-CimInstance Win32_Service -ErrorAction Stop | Where-Object { $identity = 'service|' + $_.Name; (Get-CloudHubHash $identity) -eq $id } | Select-Object -First 1
  if (-not $item -or $item.PathName -notmatch '(?i)\\Program Files\\|\\ProgramData\\|\\AppData\\' -or $item.PathName -match '(?i)Microsoft|Windows Defender' -or $item.StartMode -in @('Boot','System') -or $item.Name -match '^(RpcSs|DcomLaunch|EventLog|PlugPlay|WinDefend|SecurityHealthService)$') { throw '服务不存在、路径不明确或属于受保护的系统服务' }
  Set-Service -Name $item.Name -StartupType $(if ($enabled) {'Automatic'} else {'Disabled'}) -ErrorAction Stop
} else { throw '不支持的操作' }
"#;
        powershell(SCRIPT, Some(&request.kind), Some(&request.id), Some(request.enabled))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = request; Err("系统启动管理仅支持 Windows 桌面端".into()) }
}
