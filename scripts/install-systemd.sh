#!/usr/bin/env bash
# Install the alfred.service systemd unit so Alfred starts at boot.
#
# Usage (run as your normal user; the script `sudo`s where needed):
#   ./scripts/install-systemd.sh
#
# To uninstall:
#   ./scripts/install-systemd.sh --uninstall

set -euo pipefail

UNIT_NAME="alfred.service"
UNIT_PATH="/etc/systemd/system/${UNIT_NAME}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_AS_USER="${SUDO_USER:-$(id -un)}"

if [[ "${1:-}" == "--uninstall" ]]; then
    echo "Stopping and removing $UNIT_NAME"
    sudo systemctl disable --now "$UNIT_NAME" 2>/dev/null || true
    sudo rm -f "$UNIT_PATH"
    sudo systemctl daemon-reload
    echo "Done."
    exit 0
fi

if [[ ! -f "${REPO_ROOT}/docker-compose.yml" ]]; then
    echo "ERROR: docker-compose.yml not found at ${REPO_ROOT}." >&2
    echo "       Run this script from inside the Alfred-AI repo." >&2
    exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
    echo "ERROR: systemctl not found. This installer only works on systemd-based" >&2
    echo "       Linux distros (Debian, Ubuntu, Raspberry Pi OS, Arch, Fedora, etc.)." >&2
    exit 1
fi

if ! id -nG "$RUN_AS_USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
    cat >&2 <<EOF
WARNING: user '$RUN_AS_USER' is not in the 'docker' group. The unit will
fail to start because compose can't reach the docker socket.

Fix it with:
    sudo usermod -aG docker $RUN_AS_USER
    # log out + log back in (or 'newgrp docker') for it to take effect

Then re-run this installer.
EOF
    exit 1
fi

echo "Installing $UNIT_NAME"
echo "  Repo root:  $REPO_ROOT"
echo "  Run as:     $RUN_AS_USER"

TMP_UNIT=$(mktemp)
sed \
    -e "s|%REPO_ROOT%|${REPO_ROOT}|g" \
    -e "s|%RUN_AS_USER%|${RUN_AS_USER}|g" \
    "${REPO_ROOT}/scripts/alfred.service" >"$TMP_UNIT"

sudo install -m 0644 "$TMP_UNIT" "$UNIT_PATH"
rm -f "$TMP_UNIT"

sudo systemctl daemon-reload
sudo systemctl enable "$UNIT_NAME"

cat <<EOF

Installed. Start Alfred now with:
    sudo systemctl start alfred.service

Check status:
    sudo systemctl status alfred.service

Follow logs:
    sudo journalctl -u alfred.service -f

Alfred will now start automatically on every boot.
EOF
