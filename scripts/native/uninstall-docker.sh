#!/usr/bin/env bash
# Completely remove Docker Engine from WSL2 after the native stack
# (alfred-core.service + alfred-web.service + postgresql) has been
# running smoothly for a day or two.
#
# This is DESTRUCTIVE — it deletes Docker images, volumes, and the
# engine itself. Only run it after you're sure the native stack is
# solid. The script confirms before each phase.
#
# Run as your normal user (sudos as needed):
#   ./scripts/native/uninstall-docker.sh
#
# Usage flags:
#   --containers-only   stop+remove containers/images/volumes, KEEP the
#                       Docker engine installed (useful if you want
#                       Docker around for unrelated projects)

set -euo pipefail

CONTAINERS_ONLY="${1:-}"

G='\033[1;32m'; Y='\033[1;33m'; R='\033[1;31m'; N='\033[0m'
ok()   { printf "${G}   ✓ %s${N}\n" "$*"; }
warn() { printf "${Y}   ⚠ %s${N}\n" "$*"; }
ask() {
    local prompt="$1"
    printf "${Y}? %s [y/N] ${N}" "$prompt"
    read -r ans
    [[ "$ans" =~ ^[Yy]$ ]]
}

# Sanity check the native stack is up first — don't let the user nuke
# Docker while still relying on it.
if ! systemctl is-active --quiet alfred-core.service 2>/dev/null; then
    warn "alfred-core.service is NOT active. Did you run go-native.sh?"
    ask "Continue anyway?" || exit 1
fi

# ── 1. Containers + images + volumes ───────────────────────────
if command -v docker >/dev/null 2>&1; then
    echo "Current docker state:"
    docker compose -f "$(dirname "$0")/../../docker-compose.yml" ps 2>/dev/null || true
    echo
    if ask "Tear down the docker-compose stack (containers + volumes)?"; then
        docker compose -f "$(dirname "$0")/../../docker-compose.yml" down -v 2>/dev/null || true
        # Also nuke dangling alfred-* images.
        docker images --format '{{.Repository}}:{{.Tag}}' \
            | grep -E '^alfred-ai-|^alfred-' \
            | xargs -r docker rmi -f 2>/dev/null || true
        # Clear the build cache.
        docker builder prune -af 2>/dev/null || true
        ok "Containers, volumes, images removed"
    else
        warn "Skipped container teardown"
    fi
else
    ok "Docker CLI not installed — nothing to tear down"
fi

if [[ "$CONTAINERS_ONLY" == "--containers-only" ]]; then
    echo
    ok "Done (engine kept)."
    exit 0
fi

# ── 2. Uninstall the engine itself ──────────────────────────────
if dpkg -l docker-ce docker-ce-cli containerd.io 2>/dev/null | grep -q ^ii; then
    if ask "Uninstall docker-ce + containerd packages?"; then
        sudo systemctl stop docker.socket docker.service 2>/dev/null || true
        sudo apt-get remove -y --purge \
            docker-ce docker-ce-cli containerd.io \
            docker-buildx-plugin docker-compose-plugin 2>/dev/null || true
        sudo apt-get autoremove -y --purge 2>/dev/null || true
        # Wipe leftover state.
        sudo rm -rf /var/lib/docker /var/lib/containerd /etc/docker
        # Drop the docker apt source (added by install-wsl-engine.sh).
        sudo rm -f /etc/apt/sources.list.d/docker.list
        sudo rm -f /etc/apt/keyrings/docker.asc /etc/apt/keyrings/docker.gpg
        ok "Docker engine removed"
    else
        warn "Skipped engine uninstall"
    fi
else
    ok "Docker engine not installed (or already removed)"
fi

cat <<EOF

${G}Docker cleanup complete.${N}

If you ever want to peek at what was using disk before:
  sudo du -sh /var/lib/docker 2>/dev/null  # (should now be 'No such file')

Native stack is the only thing running Alfred:
  systemctl status alfred-core.service alfred-web.service postgresql.service
EOF
