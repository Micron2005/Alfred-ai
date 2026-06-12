#!/usr/bin/env bash
# Alfred AI — WSL2 engine installer (NO Docker Desktop required).
#
# Sets up everything inside your existing WSL2 Ubuntu distro so the
# full Alfred stack runs natively in WSL with the free, open-source
# Docker Engine (docker-ce) — Docker Desktop is NOT used or needed.
#
# What it does (all idempotent — safe to re-run):
#   1. Enables systemd in WSL (/etc/wsl.conf) so services start at
#      distro boot. Requires ONE `wsl --shutdown` from Windows the
#      first time — the script tells you when.
#   2. Installs Docker Engine (docker-ce) + compose plugin inside WSL
#      and adds your user to the docker group.
#   3. Installs the "ollama bridge": a tiny socat relay that forwards
#      WSL port 11434 to the Ollama server on the WINDOWS side, so
#      the existing OLLAMA_HOST="http://host.docker.internal:11434"
#      in .env keeps working exactly as it did under Docker Desktop.
#      (Without Docker Desktop, host.docker.internal points at the
#      WSL VM, not Windows — the relay closes that gap. Handles both
#      NAT and mirrored WSL networking modes automatically.)
#   4. Installs alfred.service (boot-time `docker compose up`) via
#      the existing scripts/install-systemd.sh.
#
# Usage, from inside WSL, in the repo root:
#   ./scripts/windows/install-wsl-engine.sh
#
# Pair with the Windows-side scripts:
#   scripts/windows/Enable-OllamaForWSL.ps1   (admin, one-time)
#   scripts/windows/Install-AlfredAutostart.ps1
# Full walkthrough: docs/SETUP_WINDOWS_NO_DOCKER_DESKTOP.md

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ME="${SUDO_USER:-$(id -un)}"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERROR\033[0m %s\n' "$*" >&2; exit 1; }

# ── Sanity: are we inside WSL? ─────────────────────────────────────
grep -qi microsoft /proc/version 2>/dev/null \
    || die "This doesn't look like WSL. Run this inside your Ubuntu distro."

# ── 1. systemd in WSL ──────────────────────────────────────────────
if [[ "$(ps -p 1 -o comm= 2>/dev/null)" != "systemd" ]]; then
    say "Enabling systemd in /etc/wsl.conf"
    if [[ ! -f /etc/wsl.conf ]] || ! grep -q '^\[boot\]' /etc/wsl.conf; then
        printf '\n[boot]\nsystemd=true\n' | sudo tee -a /etc/wsl.conf >/dev/null
    elif ! grep -Eq '^\s*systemd\s*=\s*true' /etc/wsl.conf; then
        sudo sed -i '/^\[boot\]/a systemd=true' /etc/wsl.conf
    fi
    cat <<'EOF'

  systemd is now enabled but WSL must restart to pick it up.

  1. Open PowerShell on Windows and run:   wsl --shutdown
  2. Reopen your Ubuntu terminal
  3. Re-run this script — it will continue from here.

EOF
    exit 0
fi
say "systemd is running (PID 1) ✓"

# ── 2. Docker Engine (docker-ce) ───────────────────────────────────
# Check for the systemd unit, not the CLI: Docker Desktop's WSL
# integration leaves a `docker` CLI behind with no engine attached.
if [[ -f /lib/systemd/system/docker.service || -f /etc/systemd/system/docker.service ]]; then
    say "Docker Engine already installed ✓"
else
    say "Installing Docker Engine (docker-ce) via get.docker.com"
    curl -fsSL https://get.docker.com | sudo sh
fi
sudo systemctl enable --now docker
# Point the CLI at the local engine in case a stale Docker Desktop
# context is still selected.
docker context use default >/dev/null 2>&1 || true
if ! id -nG "$ME" | tr ' ' '\n' | grep -qx docker; then
    say "Adding $ME to the docker group"
    sudo usermod -aG docker "$ME"
    NEED_RELOGIN=1
fi

# ── 3. Ollama bridge (WSL :11434 → Windows Ollama) ─────────────────
if ss -ltn 2>/dev/null | grep -q ':11434 '; then
    warn "Port 11434 is already in use inside WSL (native Ollama in WSL?)."
    warn "Skipping the ollama bridge — containers will reach whatever is"
    warn "listening there via host.docker.internal."
else
    say "Installing ollama bridge (socat relay to Windows)"
    sudo apt-get update -qq && sudo apt-get install -y -qq socat >/dev/null

    sudo tee /usr/local/bin/alfred-ollama-bridge >/dev/null <<'BRIDGE'
#!/bin/sh
# Forward WSL :11434 to the Ollama server on the Windows host so
# containers reach it via host.docker.internal (host-gateway).
#
#  - NAT mode (WSL default): the Windows host is the default gateway.
#  - Mirrored mode: Windows loopback is shared with WSL, so the
#    target is 127.0.0.1 — but then we must NOT bind on loopback
#    ourselves (it's already taken by mirrored Ollama); bind only on
#    the docker bridge so containers can reach it.
MODE="$(wslinfo --networking-mode 2>/dev/null || echo nat)"
if [ "$MODE" = "mirrored" ]; then
    TARGET="127.0.0.1"
    BIND="172.17.0.1"
else
    TARGET="$(ip route show default | awk '{print $3; exit}')"
    BIND="0.0.0.0"
fi
[ -n "$TARGET" ] || { echo "no route to Windows host"; exit 1; }
echo "ollama bridge: ${BIND}:11434 -> ${TARGET}:11434 (mode: ${MODE})"
exec socat "TCP-LISTEN:11434,fork,reuseaddr,bind=${BIND}" "TCP:${TARGET}:11434"
BRIDGE
    sudo chmod +x /usr/local/bin/alfred-ollama-bridge

    sudo tee /etc/systemd/system/alfred-ollama-bridge.service >/dev/null <<'UNIT'
[Unit]
Description=Alfred — bridge WSL:11434 to Windows Ollama
After=network-online.target docker.service
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/alfred-ollama-bridge
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
    sudo systemctl daemon-reload
    sudo systemctl enable --now alfred-ollama-bridge.service
    say "ollama bridge installed ✓ (logs: journalctl -u alfred-ollama-bridge -f)"
fi

# ── 4. alfred.service (compose up at boot) ─────────────────────────
if [[ "${NEED_RELOGIN:-0}" == "1" ]]; then
    cat <<EOF

  Almost done. Your docker group membership needs a fresh login:

  1. Close this terminal, open a new Ubuntu terminal
     (or run: newgrp docker)
  2. Re-run this script to install alfred.service.

EOF
    exit 0
fi

say "Installing alfred.service (starts Alfred at WSL boot)"
"$REPO_ROOT/scripts/install-systemd.sh"

cat <<'EOF'

──────────────────────────────────────────────────────────────────
All set inside WSL. Next:

  1. Start Alfred now:        sudo systemctl start alfred.service
     (first build takes a few minutes; watch with
      docker compose logs -f)
  2. Verify:                  ./scripts/smoke-test.sh
  3. On WINDOWS, finish the desk setup:
       - Enable-OllamaForWSL.ps1     (run once as admin)
       - Install-AlfredAutostart.ps1 (boot-time app window)
     See docs/SETUP_WINDOWS_NO_DOCKER_DESKTOP.md
──────────────────────────────────────────────────────────────────
EOF
