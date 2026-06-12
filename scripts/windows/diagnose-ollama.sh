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
HOP3_OK=0
if curl -s --max-time 3 "http://$TARGET:11434/api/tags" >/dev/null 2>&1; then
    echo -e "  $PASS http://$TARGET:11434 reachable from WSL"
    HOP3_OK=1
else
    echo -e "  $FAIL can't reach http://$TARGET:11434 from WSL"
    # Disambiguate: what is Windows :11434 actually bound to?
    BIND="$(timeout 10 powershell.exe -NoProfile -Command \
        "(Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalAddress | Sort-Object -Unique) -join ','" \
        2>/dev/null | tr -d '\r' | tail -1)"
    echo "      Windows :11434 listening on: ${BIND:-<unknown>}"
    if [[ "$BIND" == *"0.0.0.0"* || "$BIND" == *"::"* ]]; then
        RULE_ON="$(timeout 10 powershell.exe -NoProfile -Command \
            "(Get-NetFirewallRule -DisplayName 'Ollama (Alfred WSL bridge)' -ErrorAction SilentlyContinue).Enabled" \
            2>/dev/null | tr -d '\r' | tail -1)"
        echo "      firewall rule 'Ollama (Alfred WSL bridge)' enabled: ${RULE_ON:-NOT FOUND}"
        APP_RULES="$(timeout 10 powershell.exe -NoProfile -Command \
            "Get-NetFirewallApplicationFilter -Program '*ollama*' -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue | ForEach-Object { \$_.Action.ToString() + ' ' + \$_.Direction.ToString() + ' ' + \$_.DisplayName }" \
            2>/dev/null | tr -d '\r')"
        if [[ -n "$APP_RULES" ]]; then
            echo "      ollama.exe app firewall rules:"
            echo "$APP_RULES" | sed 's/^/        /'
        fi
        if echo "$APP_RULES" | grep -qi "^Block.*Inbound"; then
            verdicts+=("Windows has an inbound BLOCK rule for ollama.exe (a firewall popup was cancelled at some point) — Block overrides Allow. Re-run ./scripts/windows/setup-ollama-from-wsl.sh (it now removes the block rule), then re-run this diagnostic.")
        else
            verdicts+=("Ollama listens on all interfaces but WSL still can't reach it — firewall. Re-run ./scripts/windows/setup-ollama-from-wsl.sh (approve UAC). If it persists, look for third-party antivirus/firewall software blocking port 11434.")
        fi
    else
        verdicts+=("Ollama is still bound to 127.0.0.1 — the env var isn't being picked up. Easiest fix on newer Ollama versions: open the Ollama app on Windows → Settings (gear icon) → enable 'Expose Ollama to the network' — it rebinds immediately. Otherwise: right-click the tray icon → Quit Ollama, close any 'ollama serve' consoles, start Ollama again, re-run this diagnostic.")
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
elif [[ "$HOP3_OK" == "0" ]]; then
    echo -e "  $FAIL localhost:11434 dead inside WSL (expected — downstream of hop 3)"
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
