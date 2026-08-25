[CmdletBinding()]
param(
  [ValidateSet("patch", "minor", "major")]
  [string]$Bump = "patch",
  [switch]$Yes,
  [switch]$DryRun,
  [switch]$Help
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($Help) {
  Write-Host "CloudHub Tools release helper"
  Write-Host "Usage: release-new-version.bat [patch|minor|major] [-Yes] [-DryRun]"
  Write-Host ""
  Write-Host "Default: patch. The script validates, commits, tags, and pushes a new release."
  exit 0
}

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command was not found: $Name"
  }
}

function Replace-Text([string]$RelativePath, [string]$Pattern, [string]$Replacement, [int]$MaximumReplacements = 1) {
  $path = Join-Path $root $RelativePath
  $content = [System.IO.File]::ReadAllText($path)
  $regex = [regex]::new($Pattern)
  $updated = if ($MaximumReplacements -eq 0) { $regex.Replace($content, $Replacement) } else { $regex.Replace($content, $Replacement, $MaximumReplacements) }
  if ($updated -eq $content) {
    throw "Could not update the version in $RelativePath"
  }
  [System.IO.File]::WriteAllText($path, $updated, [System.Text.UTF8Encoding]::new($false))
}

Require-Command "git"
Require-Command "npm"
Require-Command "cargo"

$changes = @(git status --porcelain)
if ($changes.Count -gt 0) {
  throw "The working tree has uncommitted changes. Commit, stash, or discard them before releasing."
}

$packagePath = Join-Path $root "package.json"
$currentVersion = (Get-Content $packagePath -Raw | ConvertFrom-Json).version
if ($currentVersion -notmatch "^(\d+)\.(\d+)\.(\d+)$") {
  throw "Only stable semantic versions are supported. Current version: $currentVersion"
}

$major = [int]$Matches[1]
$minor = [int]$Matches[2]
$patch = [int]$Matches[3]
switch ($Bump) {
  "major" { $major++; $minor = 0; $patch = 0 }
  "minor" { $minor++; $patch = 0 }
  default { $patch++ }
}
$nextVersion = "$major.$minor.$patch"

Write-Host "Current version: $currentVersion"
Write-Host "Next version:    $nextVersion ($Bump)"

if ($DryRun) {
  Write-Host "Dry run only. No files or Git references were changed."
  exit 0
}

if (-not $Yes) {
  $answer = Read-Host "Publish v$nextVersion? Type Y to continue"
  if ($answer -notmatch "^(y|yes)$") {
    Write-Host "Release cancelled."
    exit 0
  }
}

$escapedCurrent = [regex]::Escape($currentVersion)
Replace-Text "package.json" ('"version"\s*:\s*"' + $escapedCurrent + '"') ('"version": "' + $nextVersion + '"')
Replace-Text "package-lock.json" ('"version"\s*:\s*"' + $escapedCurrent + '"') ('"version": "' + $nextVersion + '"') 0
Replace-Text "src-tauri\Cargo.toml" ('(?m)^version\s*=\s*"' + $escapedCurrent + '"\s*$') ('version = "' + $nextVersion + '"')
Replace-Text "src-tauri\Cargo.lock" ('(?ms)(name = "cloudhub-tools"\r?\nversion = "' + $escapedCurrent + '")') ('$1' + $nextVersion + '$2')
Replace-Text "src-tauri\tauri.conf.json" ('"version"\s*:\s*"' + $escapedCurrent + '"') ('"version": "' + $nextVersion + '"')
Replace-Text "src\App.tsx" ('const bundledVersion = "' + $escapedCurrent + '";') ('const bundledVersion = "' + $nextVersion + '";')

Write-Host "Running frontend build..."
npm run build
if ($LASTEXITCODE -ne 0) { throw "Frontend build failed." }

$checkTarget = Join-Path ([System.IO.Path]::GetTempPath()) "cloudhub-tools-release-check-$PID"
try {
  Write-Host "Running Rust check..."
  Push-Location (Join-Path $root "src-tauri")
  cargo check --target-dir $checkTarget
  if ($LASTEXITCODE -ne 0) { throw "Rust check failed." }
}
finally {
  Pop-Location
  if (Test-Path $checkTarget) { Remove-Item -LiteralPath $checkTarget -Recurse -Force }
}

$releaseFiles = @(
  "package.json",
  "package-lock.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "src-tauri/tauri.conf.json",
  "src/App.tsx",
  "src/local-assets.css"
)

git add -- $releaseFiles
if ($LASTEXITCODE -ne 0) { throw "Could not stage release files." }

git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw "Release files failed Git whitespace validation." }

git commit -m "Release v$nextVersion"
if ($LASTEXITCODE -ne 0) { throw "Could not create the release commit." }

git tag -a "v$nextVersion" -m "Release v$nextVersion"
if ($LASTEXITCODE -ne 0) { throw "Could not create the release tag." }

git push origin HEAD:main
if ($LASTEXITCODE -ne 0) { throw "Could not push main. The local tag v$nextVersion was kept for recovery." }

git push origin "v$nextVersion"
if ($LASTEXITCODE -ne 0) { throw "Could not push v$nextVersion. Push the tag manually after resolving the issue." }

Write-Host ""
Write-Host "v$nextVersion was pushed successfully. GitHub Actions will create the desktop release."
