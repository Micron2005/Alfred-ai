# Alfred AI — make Windows Ollama reachable from WSL containers.
#
# Without Docker Desktop, containers inside WSL can't see services
# bound to 127.0.0.1 on the Windows side. The WSL half of the fix is
# the "ollama bridge" (installed by install-wsl-engine.sh); this is
# the Windows half:
#   1. Tells Ollama to listen on all interfaces (OLLAMA_HOST env var,
#      user scope — that's where the Ollama tray app reads it).
#   2. Adds a Windows Defender Firewall rule allowing inbound 11434
#      ONLY from private/loopback ranges (the WSL NAT subnet lives in
#      172.16.0.0/12), so nothing on the internet can reach Ollama.
#
# Run ONCE in an elevated (Run as administrator) PowerShell:
#   powershell -ExecutionPolicy Bypass -File \\wsl$\Ubuntu\home\YOU\alfred-ai\scripts\windows\Enable-OllamaForWSL.ps1
#
# Then quit Ollama from the tray and start it again so it picks up
# the new OLLAMA_HOST.

#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

# ── 1. OLLAMA_HOST=0.0.0.0 (user scope) ────────────────────────────
[Environment]::SetEnvironmentVariable("OLLAMA_HOST", "0.0.0.0:11434", "User")
Write-Host "OLLAMA_HOST set to 0.0.0.0:11434 (user scope)" -ForegroundColor Green

# ── 2. Firewall rule, restricted to private ranges ─────────────────
$ruleName = "Ollama (Alfred WSL bridge)"
if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $ruleName `
        -Direction Inbound -Action Allow -Protocol TCP -LocalPort 11434 `
        -RemoteAddress @("172.16.0.0/12", "192.168.0.0/16", "10.0.0.0/8", "127.0.0.1") `
        -Profile Any | Out-Null
    Write-Host "Firewall rule '$ruleName' created (private ranges only)" -ForegroundColor Green
} else {
    Write-Host "Firewall rule '$ruleName' already exists" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Now QUIT Ollama from the system tray and start it again." -ForegroundColor Yellow
Write-Host "Verify from inside WSL:   curl http://localhost:11434/api/tags" -ForegroundColor Yellow
