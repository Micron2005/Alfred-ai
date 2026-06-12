#!/usr/bin/env bash
# Diagnose the "Local LLM not running" chain, hop by hop:
#
#   alfred-core container ─→ host.docker.internal (docker bridge gw)
#        ─→ socat bridge on WSL :11434 ─→ Windows Ollama :11434
#
# Run from the repo root inside WSL and paste the output if you need
# help:
#   ./scripts/windows/diagnose-ollama.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PASS='\033[1;32mPASS\033[0m'
FAIL='\033[1;31mFAIL\033[0m'
INFO='\033[1;36m──\033[0m'

verdicts=()

echo ""
echo "ALFRED OLLAMA CHAIN DIAGNOSTIC"
echo "=============================="

# ── Hop 1: Is Ollama alive on Windows at all? ──────────────────────
echo ""
echo -e "$INFO [1/6] Ollama running on Windows (via Windows loopback)"
WIN_STATUS="$(timeout 10 powershell.exe -NoProfile -Command \
    "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://localhost:11434/api/tags).StatusCode } catch { 'DOWN' }" \
    2>/dev/null | tr -d '\r' | tail -1)"
if [[ "$WIN_STATUS" == "200" ]]; then
    echo -e "  $PASS Ollama answers on Windows localhost"
else
    echo -e "  $FAIL Ollama is NOT answering on Windows ($WIN_STATUS)"
    verdicts+=("Ollama itself isn't running on Windows. Start the Ollama app (check the system tray).")
fi

# ── Hop 2: OLLAMA_HOST env var on Windows ──────────────────────────
echo ""
echo -e "$INFO [2/6] OLLAMA_HOST environment variable (User scope)"
WIN_ENV="$(timeout 10 powershell.exe -NoProfile -Command \
    "[Environment]::GetEnvironmentVariable('OLLAMA_HOST','User')" \
    2>/dev/null | tr -d '\r' | tail -1)"
if [[ "$WIN_ENV" == *"0.0.0.0"* ]]; then
    echo -e "  $PASS OLLAMA_HOST=$WIN_ENV"
else
    echo -e "  $FAIL OLLAMA_HOST is '${WIN_ENV:-<empty>}' (need 0.0.0.0:11434)"
    verdicts+=("Run ./scripts/windows/setup-ollama-from-wsl.sh and APPROVE the UAC prompt, then restart Ollama from the tray.")
fi

# ── Hop 3: WSL → Windows Ollama directly ───────────────────────────
echo ""
echo -e "$INFO [3/6] WSL can reach Windows Ollama directly"
MODE="$(wslinfo --networking-mode 2>/dev/null || echo nat)"
if [[ "$MODE" == "mirrored" ]]; then TARGET="127.0.0.1"; else
    TARGET="$(ip route show default | awk '{print $3; exit}')"
fi
echo "      networking mode: $MODE — Windows host target: $TARGET"
if curl -s --max-time 3 "http://$TARGET:11434/api/tags" >/dev/null 2>&1; then
    echo -e "  $PASS http://$TARGET:11434 reachable from WSL"
else
    echo -e "  $FAIL can't reach http://$TARGET:11434 from WSL"
    if [[ "$WIN_STATUS" == "200" && "$WIN_ENV" == *"0.0.0.0"* ]]; then
        verdicts+=("Ollama runs and the env var is set, but it's still bound to 127.0.0.1 — it was NOT restarted after the change. Fully QUIT Ollama from the system tray (right-click → Quit), make sure no old 'ollama serve' console is open, then start Ollama again. If it still fails, the firewall rule may be missing: re-run ./scripts/windows/setup-ollama-from-wsl.sh.")
    fi
fi

# ── Hop 4: the socat bridge service ────────────────────────────────
echo ""
echo -e "$INFO [4/6] alfred-ollama-bridge service (WSL :11434 relay)"
BRIDGE_STATE="$(systemctl is-active alfred-ollama-bridge 2>/dev/null || true)"
if [[ "$BRIDGE_STATE" == "active" ]]; then
    echo -e "  $PASS bridge service active"
elif [[ "$MODE" == "mirrored" ]] && curl -s --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    echo -e "  $PASS mirrored networking — Windows Ollama is on WSL loopback (bridge state: ${BRIDGE_STATE:-missing})"
else
    echo -e "  $FAIL bridge service is '${BRIDGE_STATE:-missing}'"
    verdicts+=("The relay isn't installed/running — your earlier install runs aborted before this step. Run: git pull && ./scripts/windows/install-wsl-engine.sh (then: sudo systemctl restart alfred-ollama-bridge).")
fi

# ── Hop 5: WSL :11434 (what the bridge serves) ─────────────────────
echo ""
echo -e "$INFO [5/6] WSL-local :11434 answers"
if curl -s --max-time 3 http://localhost:11434/api/tags >/dev/null 2>&1; then
    echo -e "  $PASS localhost:11434 answers inside WSL"
else
    echo -e "  $FAIL localhost:11434 dead inside WSL"
fi

# ── Hop 6: from inside the alfred-core container ───────────────────
echo ""
echo -e "$INFO [6/6] alfred-core container → host.docker.internal:11434"
CONTAINER_OUT="$(cd "$REPO_ROOT" && timeout 15 docker compose exec -T alfred-core \
    curl -s --max-time 3 -o /dev/null -w '%{http_code}' \
    http://host.docker.internal:11434/api/tags 2>&1 | tail -1)"
if [[ "$CONTAINER_OUT" == "200" ]]; then
    echo -e "  $PASS the backend container reaches Ollama — vitals should go green within ~30s"
    echo ""
    echo "      Models visible to Alfred:"
    curl -s --max-time 3 http://localhost:11434/api/tags 2>/dev/null \
        | python3 -c "import sys,json;[print('        -', m['name']) for m in json.load(sys.stdin).get('models',[])]" 2>/dev/null \
        || true
    echo "      (If the HUD still warns, the model named in .env LOCAL_MODEL_CHAT"
    echo "       isn't in that list — pull it on Windows: ollama pull <model>)"
else
    echo -e "  $FAIL container got '$CONTAINER_OUT'"
    if [[ -z "${verdicts[*]:-}" ]]; then
        verdicts+=("Everything upstream works but the container can't reach the WSL host — restart the stack: sudo systemctl restart alfred.service")
    fi
fi

# ── Verdict ────────────────────────────────────────────────────────
echo ""
echo "=============================="
if [[ -z "${verdicts[*]:-}" ]]; then
    echo "All hops pass. Refresh the HUD — the Local LLM vital re-checks periodically."
else
    echo "FIX, in order:"
    i=1
    for v in "${verdicts[@]}"; do
        echo "  $i. $v"
        i=$((i + 1))
    done
fi
echo ""
