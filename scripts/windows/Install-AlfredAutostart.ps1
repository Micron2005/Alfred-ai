# Alfred AI — Windows autostart installer.
#
# One-time setup so Alfred behaves like a native desktop app:
#   - Copies Launch-Alfred.ps1 (+ config.json) to a Windows-local
#     folder (%LOCALAPPDATA%\AlfredAI). The Startup shortcut can't
#     point into \\wsl$\... because WSL isn't booted yet at logon.
#   - Creates a Startup shortcut so Alfred boots WSL, waits for the
#     stack, and opens the app window every time you log in.
#   - Creates a desktop shortcut ("Alfred AI") for manual relaunch.
#
# Run from PowerShell (no admin needed), with WSL running, e.g.:
#   powershell -ExecutionPolicy Bypass -File \\wsl$\Ubuntu\home\YOU\alfred-ai\scripts\windows\Install-AlfredAutostart.ps1
#
# Options:
#   -Distro "Ubuntu-22.04"   target a specific WSL distro (default: default distro)
#   -FaceDirect              ALSO open /face as a second app window at boot
#   -FacePosition "1920,0"   top-left pixel of the desk touchscreen
#                            (Settings > System > Display tells you the layout)
#   -NoFaceFullscreen        don't force the face window fullscreen
#   -Uninstall               remove the shortcuts + local folder
#
# Pair with: install-wsl-engine.sh (inside WSL) and
# Enable-OllamaForWSL.ps1 (admin, once). Full guide:
# docs/SETUP_WINDOWS_NO_DOCKER_DESKTOP.md

param(
    [string]$Distro = "",
    [switch]$FaceDirect,
    [string]$FacePosition = "1920,0",
    [switch]$NoFaceFullscreen,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$destDir = Join-Path $env:LOCALAPPDATA "AlfredAI"
$launcher = Join-Path $destDir "Launch-Alfred.ps1"
$startupLnk = Join-Path ([Environment]::GetFolderPath("Startup")) "Alfred AI.lnk"
$desktopLnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "Alfred AI.lnk"

if ($Uninstall) {
    Remove-Item -Path $startupLnk, $desktopLnk -ErrorAction SilentlyContinue
    Remove-Item -Path $destDir -Recurse -ErrorAction SilentlyContinue
    Write-Host "Alfred autostart removed." -ForegroundColor Green
    exit 0
}

# ── Copy the launcher next to a generated config.json ──────────────
New-Item -ItemType Directory -Path $destDir -Force | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot "Launch-Alfred.ps1") `
          -Destination $launcher -Force

$config = [ordered]@{
    distro         = $Distro
    hudUrl         = "http://localhost:3000"
    faceDirect     = [bool]$FaceDirect
    facePosition   = $FacePosition
    faceFullscreen = -not $NoFaceFullscreen
    timeoutSec     = 600
}
$config | ConvertTo-Json | Set-Content -Path (Join-Path $destDir "config.json") -Encoding UTF8

# ── Find Chrome for the shortcut icon ──────────────────────────────
$chrome = $null
$reg = Get-ItemProperty `
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" `
    -ErrorAction SilentlyContinue
foreach ($c in @(
    $reg.'(default)',
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)) {
    if ($c -and (Test-Path $c)) { $chrome = $c; break }
}
if (-not $chrome) {
    Write-Warning "Chrome not found — Alfred will open in the default browser instead of an app window."
}

# ── Shortcuts (Startup + Desktop) ──────────────────────────────────
$psExe = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
$shell = New-Object -ComObject WScript.Shell
foreach ($lnkPath in @($startupLnk, $desktopLnk)) {
    $lnk = $shell.CreateShortcut($lnkPath)
    $lnk.TargetPath = $psExe
    $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
    $lnk.WorkingDirectory = $destDir
    $lnk.Description = "Alfred AI — boots the stack and opens the HUD"
    if ($chrome) { $lnk.IconLocation = "$chrome,0" }
    $lnk.Save()
}

Write-Host ""
Write-Host "Installed:" -ForegroundColor Green
Write-Host "  Launcher   $launcher"
Write-Host "  Startup    $startupLnk  (runs at every logon)"
Write-Host "  Desktop    $desktopLnk  (manual relaunch)"
if ($FaceDirect) {
    Write-Host "  Face       direct window on touchscreen at $FacePosition" -ForegroundColor Cyan
} else {
    Write-Host "  Face       via in-app auto-launch (FACE module in the radial menu)" -ForegroundColor Cyan
}
Write-Host ""
Write-Host "Test it now by double-clicking the desktop shortcut." -ForegroundColor Yellow
