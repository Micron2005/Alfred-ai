#!/usr/bin/env bash
# Run the Windows-side Ollama enablement WITHOUT leaving your WSL
# terminal. Launches an elevated PowerShell (you'll get a UAC prompt)
# that executes scripts/windows/Enable-OllamaForWSL.ps1:
#   - sets OLLAMA_HOST=0.0.0.0:11434 (user scope)
#   - adds a firewall rule for 11434, private ranges only
#
# Usage, from the repo root inside WSL:
#   ./scripts/windows/setup-ollama-from-wsl.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

grep -qi microsoft /proc/version 2>/dev/null \
    || { echo "ERROR: not WSL — run this inside your Ubuntu distro." >&2; exit 1; }
command -v powershell.exe >/dev/null 2>&1 \
    || { echo "ERROR: powershell.exe not reachable (WSL interop disabled?)." >&2; exit 1; }

SCRIPT_WIN="$(wslpath -w "$REPO_ROOT/scripts/windows/Enable-OllamaForWSL.ps1")"

powershell.exe -NoProfile -Command \
    "Start-Process powershell -Verb RunAs -ArgumentList '-NoExit -ExecutionPolicy Bypass -File \"$SCRIPT_WIN\"'"

cat <<'EOF'

→ Approve the UAC prompt that just appeared on Windows.
→ A blue admin PowerShell window runs the setup (leave it, read it, close it).
→ Then QUIT Ollama from the system tray and start it again.
→ Verify from right here:

    curl http://localhost:11434/api/tags

EOF
