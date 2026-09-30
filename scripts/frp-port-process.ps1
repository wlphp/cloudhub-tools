$ErrorActionPreference = 'Stop'
try {
    $port = [UInt16]$env:CLOUDHUB_FRP_PORT
    $ownerIds = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
    $owners = @()
    foreach ($ownerId in $ownerIds) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerId"
        if (!$process) { continue }
        $startedAt = $process.CreationDate.ToUniversalTime().ToString('o')
        $configPattern = '(?:^|\s)-c\s+(?:"' + [regex]::Escape($env:CLOUDHUB_FRP_CONFIG) + '"|' + [regex]::Escape($env:CLOUDHUB_FRP_CONFIG) + ')(?:\s|$)'
        $parent = Get-Process -Id $process.ParentProcessId -ErrorAction SilentlyContinue
        $canTerminate = ($process.ExecutablePath -ieq $env:CLOUDHUB_FRP_BINARY) -and ($process.CommandLine -match $configPattern) -and !$parent
        if ($env:CLOUDHUB_FRP_MODE -eq 'terminate' -and $ownerId -eq [UInt32]$env:CLOUDHUB_FRP_PID) {
            if (!$canTerminate -or $startedAt -cne $env:CLOUDHUB_FRP_STARTED_AT) { exit 2 }
            # Revalidate identity immediately before ending this exact process.
            $handle = Get-Process -Id $ownerId
            if ($handle.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ') -cne $process.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ')) { exit 2 }
            $handle.Kill()
            if (!$handle.WaitForExit(5000)) { exit 3 }
            Write-Output '{"terminated":true}'
            exit 0
        }
        $owners += @{ pid = [UInt32]$ownerId; canTerminate = [bool]$canTerminate; startedAt = $startedAt }
    }
    if ($env:CLOUDHUB_FRP_MODE -eq 'terminate') { exit 2 }
    ConvertTo-Json -InputObject $owners -Compress
} catch {
    # Never return process command lines, configuration, or PowerShell exceptions.
    exit 1
}
