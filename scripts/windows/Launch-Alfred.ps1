# Alfred AI — boot-time launcher (Windows side).
#
# Runs hidden at logon (Startup shortcut created by
# Install-AlfredAutostart.ps1). It:
#   1. Boots the WSL distro and keeps it alive (a hidden
#      `sleep infinity` process — without one, WSL idles out and
#      takes the Docker containers down with it). systemd inside WSL
#      then auto-starts Docker + alfred.service.
#   2. Waits until the Alfred web UI answers on port 3000.
#   3. Opens Alfred in a Chrome APP WINDOW — its own taskbar icon,
#      no address bar, no tabs. You never see or type a URL.
#   4. Optionally opens the wire-mesh face directly on the desk
#      touchscreen as a second app window (faceDirect in config.json)
#      — otherwise the HUD's own FACE auto-launch handles it.
#
# Settings come from config.json next to this script (written by the
# installer); every field is optional.

$ErrorActionPreference = "SilentlyContinue"

# ── Defaults + config.json overrides ───────────────────────────────
$Distro = ""                      # "" = default WSL distro
$HudUrl = "http://localhost:3000"
$FaceDirect = $false              # open /face as a 2nd window at boot
$FacePosition = "1920,0"          # top-left px of the touchscreen
$FaceFullscreen = $true
$TimeoutSec = 600                 # first boot builds images = slow

$cfgPath = Join-Path $PSScriptRoot "config.json"
if (Test-Path $cfgPath) {
    $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
    if ($cfg.distro)        { $Distro = [string]$cfg.distro }
    if ($cfg.hudUrl)        { $HudUrl = [string]$cfg.hudUrl }
    if ($null -ne $cfg.faceDirect)     { $FaceDirect = [bool]$cfg.faceDirect }
    if ($cfg.facePosition)  { $FacePosition = [string]$cfg.facePosition }
    if ($null -ne $cfg.faceFullscreen) { $FaceFullscreen = [bool]$cfg.faceFullscreen }
    if ($cfg.timeoutSec)    { $TimeoutSec = [int]$cfg.timeoutSec }
}
$FaceUrl = "$HudUrl/face"

# ── 1. Boot WSL + keep it alive ────────────────────────────────────
$wslArgs = @()
if ($Distro) { $wslArgs += @("-d", $Distro) }
$wslArgs += @("--exec", "sleep", "infinity")
Start-Process -FilePath "wsl.exe" -ArgumentList $wslArgs -WindowStyle Hidden

# ── 2. Wait for the web UI ─────────────────────────────────────────
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$ready = $false
while ((Get-Date) -lt $deadline) {
    try {
        $resp = Invoke-WebRequest -Uri $HudUrl -UseBasicParsing -TimeoutSec 3
        if ($resp.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
    Start-Sleep -Seconds 3
}

# ── 3. Find Chrome ─────────────────────────────────────────────────
function Find-Chrome {
    $reg = Get-ItemProperty `
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" `
        -ErrorAction SilentlyContinue
    $candidates = @(
        $reg.'(default)',
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    return $null
}
$chrome = Find-Chrome

# ── 4. Open the windows ────────────────────────────────────────────
# Even if the wait timed out, open anyway — worst case the user sees
# a "still starting" page and refreshes.
if ($chrome) {
    Start-Process -FilePath $chrome -ArgumentList @(
        "--app=$HudUrl",
        "--start-maximized"
    )
    if ($FaceDirect) {
        Start-Sleep -Seconds 4   # let the HUD window claim its process first
        $faceArgs = @(
            "--app=$FaceUrl",
            "--window-position=$FacePosition"
        )
        if ($FaceFullscreen) { $faceArgs += "--start-fullscreen" }
        Start-Process -FilePath $chrome -ArgumentList $faceArgs
    }
} else {
    # No Chrome found — fall back to the default browser.
    Start-Process $HudUrl
}
