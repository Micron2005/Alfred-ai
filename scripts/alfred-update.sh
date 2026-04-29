#!/usr/bin/env bash
# alfred-update.sh — pull latest code, rebuild, restart, run vitals
#
# Use this every time you pull new commits or rebuild from source.
# It's idempotent — running it twice in a row does nothing the
# second time if the tree hasn't changed.

set -euo pipefail

cd "$(dirname "$0")/.."

echo "▸ Fetching latest commits…"
git fetch --quiet
LOCAL=$(git rev-parse @)
REMOTE=$(git rev-parse @{u} 2>/dev/null || echo "$LOCAL")
if [[ "$LOCAL" != "$REMOTE" ]]; then
  echo "▸ Pulling…"
  git pull --ff-only
else
  echo "  ✓ already up to date"
fi

echo "▸ Building & restarting containers…"
docker compose up -d --build

echo "▸ Waiting for backend to come up…"
for i in {1..30}; do
  if curl -fsS http://localhost:8000/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "▸ Running vitals…"
if curl -fsS http://localhost:8000/vitals 2>/dev/null \
  | python3 -m json.tool 2>/dev/null \
  | grep -E '"(label|status|detail)"'; then
  :
else
  echo "  ✗ Vitals endpoint not reachable. Check 'docker compose logs alfred-core'."
fi

echo "▸ Done. Reload the HUD in your browser."
