#!/usr/bin/env bash
# Build Alfred.exe — entirely from the WSL terminal.
#
# electron-builder ≥ 24 edits the exe icon/metadata with pure-JS
# resedit (no Wine), and code signing is disabled in package.json
# ("signExecutable": false), so the full Windows NSIS installer
# builds natively inside WSL. The script then drops the installer on
# your Windows desktop and launches it.
#
# Usage, from the repo root inside WSL:
#   ./scripts/windows/build-desktop-app.sh
#
# Re-run any time you want to rebuild/update the desktop shell.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERROR\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$(uname -m)" == "x86_64" ]] \
    || die "This builds a Windows x64 app and needs an x86_64 distro (got $(uname -m))."

# ── Node >= 22 (electron 42's engine requirement) ──────────────────
need_node=1
if command -v node >/dev/null 2>&1; then
    major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
    [[ "$major" -ge 22 ]] && need_node=0
fi
if [[ "$need_node" == "1" ]]; then
    say "Installing Node.js 22 LTS inside WSL (NodeSource)"
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi
say "Node $(node -v) ✓"

# ── Build the installer ────────────────────────────────────────────
cd "$REPO_ROOT/alfred-desktop"
say "Installing build dependencies"
npm install
say "Building the Windows installer (downloads the Electron Windows runtime on first run)"
npm run dist

INSTALLER="$(find dist -maxdepth 1 -name 'Alfred Setup *.exe' | head -1)"
[[ -n "$INSTALLER" ]] || die "Build finished but no installer found in alfred-desktop/dist/."
say "Built: $INSTALLER"

# ── Hand off to Windows ────────────────────────────────────────────
if grep -qi microsoft /proc/version 2>/dev/null && command -v powershell.exe >/dev/null 2>&1; then
    DESKTOP_WIN="$(powershell.exe -NoProfile -Command "[Environment]::GetFolderPath('Desktop')" | tr -d '\r')"
    DESKTOP_WSL="$(wslpath -u "$DESKTOP_WIN")"
    BASE="$(basename "$INSTALLER")"
    cp "$INSTALLER" "$DESKTOP_WSL/"
    say "Installer copied to your Windows desktop: $BASE"
    say "Launching it now — it installs silently and starts Alfred when done."
    powershell.exe -NoProfile -Command "Start-Process '${DESKTOP_WIN}\\${BASE}'" \
        || warn "Couldn't auto-launch — just double-click '$BASE' on your desktop."
else
    warn "Not WSL (or interop disabled) — copy '$INSTALLER' to Windows and run it."
fi
