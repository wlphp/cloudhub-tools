param(
    [string]$AndroidSdk = $env:ANDROID_HOME,
    [string]$AndroidBuildTools
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$generatedAndroid = Join-Path $repoRoot 'src-tauri\gen\android'
$signingScript = Join-Path $repoRoot 'local-signing\sign-android-release.ps1'
$releaseOutput = Join-Path $repoRoot 'release\debug-signed'

if (-not $AndroidSdk) {
    $AndroidSdk = $env:ANDROID_SDK_ROOT
}
if (-not $AndroidSdk -or -not (Test-Path -LiteralPath $AndroidSdk -PathType Container)) {
    throw 'Android SDK not found. Set ANDROID_HOME or pass -AndroidSdk.'
}
if (-not (Test-Path -LiteralPath $signingScript -PathType Leaf)) {
    throw 'Local Android release-signing script is missing.'
}

$buildTools = $null
if ($AndroidBuildTools) {
    $buildTools = Get-Item -LiteralPath $AndroidBuildTools -ErrorAction Stop
}
else {
    $sdkBuildTools = Join-Path $AndroidSdk 'build-tools'
    if (Test-Path -LiteralPath $sdkBuildTools -PathType Container) {
        $buildTools = Get-ChildItem -LiteralPath $sdkBuildTools -Directory |
            Sort-Object { [version]$_.Name } -Descending |
            Where-Object {
                (Test-Path -LiteralPath (Join-Path $_.FullName 'apksigner.bat')) -and
                (Test-Path -LiteralPath (Join-Path $_.FullName 'aapt.exe')) -and
                (Test-Path -LiteralPath (Join-Path $_.FullName 'zipalign.exe'))
            } |
            Select-Object -First 1
    }
}
if ($buildTools -and @('apksigner.bat', 'aapt.exe', 'zipalign.exe') | Where-Object {
        -not (Test-Path -LiteralPath (Join-Path $buildTools.FullName $_))
    }) {
    throw 'Selected Android build-tools directory must contain apksigner.bat, aapt.exe, and zipalign.exe.'
}
if (-not $buildTools) {
    throw 'Android build-tools with apksigner, aapt, and zipalign are required.'
}

Push-Location $repoRoot
try {
    & npx tauri android build --debug --apk --target aarch64 --ci
    if ($LASTEXITCODE -ne 0) {
        throw 'Tauri Android debug APK build failed.'
    }
}
finally {
    Pop-Location
}

$appVersion = (Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version
$metadataFiles = Get-ChildItem -LiteralPath (Join-Path $generatedAndroid 'app\build\outputs\apk') -Filter 'output-metadata.json' -File -Recurse |
    Sort-Object LastWriteTimeUtc -Descending
$candidate = $null
foreach ($metadataFile in $metadataFiles) {
    $metadata = Get-Content -LiteralPath $metadataFile.FullName -Raw | ConvertFrom-Json
    if ($metadata.variantName -notmatch '(?i)debug$' -or $metadata.versionName -ne $appVersion) {
        continue
    }
    foreach ($element in $metadata.elements) {
        $apkPath = Join-Path $metadataFile.DirectoryName $element.outputFile
        if (Test-Path -LiteralPath $apkPath -PathType Leaf) {
            $candidate = Get-Item -LiteralPath $apkPath
            break
        }
    }
    if ($candidate) { break }
}
if (-not $candidate) {
    throw "Could not locate a debug APK for version $appVersion."
}

$badging = & (Join-Path $buildTools.FullName 'aapt.exe') dump badging $candidate.FullName
if ($LASTEXITCODE -ne 0 -or ($badging -join "`n") -notmatch "versionName='$([regex]::Escape($appVersion))'") {
    throw 'Built APK version does not match package.json.'
}
if (($badging -join "`n") -notmatch '(?m)^application-debuggable$' -or ($badging -join "`n") -notmatch "native-code: 'arm64-v8a'") {
    throw 'Built APK must be debuggable and contain ARM64 native libraries.'
}

New-Item -ItemType Directory -Path $releaseOutput -Force | Out-Null
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$signedApk = Join-Path $releaseOutput "CloudHub.Tools_${appVersion}_android_arm64_release-signed-debug_${timestamp}.apk"
& $signingScript -Action Sign -InputApk $candidate.FullName -OutputApk $signedApk -ApkSigner (Join-Path $buildTools.FullName 'apksigner.bat')
if ($LASTEXITCODE -ne 0) {
    throw 'Release-signed debug APK signing failed.'
}

$verifiedSignatures = & (Join-Path $buildTools.FullName 'apksigner.bat') verify --verbose --print-certs $signedApk
if ($LASTEXITCODE -ne 0) {
    throw 'Release-signed debug APK verification failed.'
}
if (($verifiedSignatures -join "`n") -notmatch 'Verified using v2 scheme \(APK Signature Scheme v2\): true' -or
    ($verifiedSignatures -join "`n") -notmatch 'Verified using v3 scheme \(APK Signature Scheme v3\): true') {
    throw 'Release-signed debug APK must have valid v2 and v3 signatures.'
}
$certificate = ($verifiedSignatures | Select-String 'Signer #1 certificate SHA-256 digest:').ToString().Split(':')[-1].Trim().ToLowerInvariant()
$zipalign = Join-Path $buildTools.FullName 'zipalign.exe'
& $zipalign -c -P 16 -v 4 $signedApk *> $null
if ($LASTEXITCODE -ne 0) {
    throw 'Release-signed debug APK failed 16 KB zip alignment verification.'
}

Write-Output "Built a debuggable ARM64 APK signed with the local Android release certificate: $signedApk"
Write-Output "versionName=$appVersion; certificateSha256=$certificate"
Write-Output 'Ordinary Debug and Release build signing configurations were not changed.'
