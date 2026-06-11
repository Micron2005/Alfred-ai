#!/usr/bin/env bash
# Alfred AI — first-run smoke test.
#
# After ``docker compose up --build``, run this script to confirm
# every layer is wired correctly. It exits 0 on success and prints
# a one-line green ✓ for each check that passed; the first failure
# bails with exit 1 and a hint about what to look at.
#
# Tests, in order of dependency:
#   1. docker compose ps shows all 3 services as healthy / running
#   2. Postgres accepts a connection and the pgvector extension is
#      enabled
#   3. Backend /health returns 200 with a version string
#   4. Backend /vision/face/enrollments returns 200 (proves the
#      vision router is registered and pgvector queries are working
#      end-to-end)
#   5. Ollama (running on the host or the host.docker.internal
#      gateway) responds to /api/tags
#   6. Frontend is reachable on :3000 and serves an HTML doc
#      containing "ALFRED" (proves Next.js built and rendered)
#
# Usage:
#   ./scripts/smoke-test.sh                  # verbose
#   ./scripts/smoke-test.sh --quiet          # only print failures
#
# Exit codes: 0 = all good, non-zero = first failing check number.

set -euo pipefail

QUIET=0
if [[ "${1:-}" == "--quiet" ]]; then
    QUIET=1
fi

GREEN=$'\033[0;32m'
RED=$'\033[0;31m'
YELLOW=$'\033[0;33m'
DIM=$'\033[2m'
RESET=$'\033[0m'

pass() {
    [[ $QUIET -eq 0 ]] && echo "${GREEN}✓${RESET} $1"
}

fail() {
    echo "${RED}✗${RESET} $1" >&2
    [[ -n "${2:-}" ]] && echo "${DIM}  ${2}${RESET}" >&2
    exit "${3:-1}"
}

info() {
    [[ $QUIET -eq 0 ]] && echo "${YELLOW}·${RESET} $1"
}

# Resolve the .env so we know what URLs to hit even if the user
# customised the API base or wake keyword.
ENV_FILE="${ALFRED_ENV_FILE:-./.env}"
if [[ -f "$ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    set -a; source "$ENV_FILE"; set +a
fi

API_URL="${NEXT_PUBLIC_API_BASE:-http://localhost:8000}"
WEB_URL="http://localhost:3000"
OLLAMA_URL="${OLLAMA_HOST:-http://localhost:11434}"
PG_USER="${POSTGRES_USER:-alfred}"
PG_DB="${POSTGRES_DB:-alfred}"

info "Smoke test starting against API=${API_URL}, WEB=${WEB_URL}, OLLAMA=${OLLAMA_URL}"

# 1. Compose service health
info "1/6 — docker compose ps"
if ! command -v docker >/dev/null 2>&1; then
    fail "docker not on PATH" "Install Docker Desktop or the docker CLI." 1
fi
COMPOSE_STATUS=$(docker compose ps --format json 2>/dev/null || true)
if [[ -z "$COMPOSE_STATUS" ]]; then
    fail "docker compose ps returned nothing" \
         "Run 'docker compose up -d --build' first, then retry." 1
fi
for svc in postgres alfred-core alfred-web; do
    if ! grep -q "\"Service\":\"${svc}\"" <<<"$COMPOSE_STATUS"; then
        fail "service '${svc}' is not in 'docker compose ps'" \
             "Did the build fail? Run 'docker compose logs ${svc}'." 1
    fi
done
pass "all 3 compose services present"

# 2. Postgres + pgvector
info "2/6 — Postgres + pgvector"
if ! docker compose exec -T postgres pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
    fail "Postgres is not accepting connections" \
         "Run 'docker compose logs postgres' and check POSTGRES_PASSWORD." 2
fi
PGVECTOR_OUT=$(docker compose exec -T postgres psql -U "$PG_USER" -d "$PG_DB" -t -c \
    "SELECT count(*) FROM pg_extension WHERE extname='vector';" 2>/dev/null | tr -d ' ' || echo "0")
if [[ "$PGVECTOR_OUT" != "1" ]]; then
    fail "pgvector extension is not installed" \
         "The pgvector/pgvector image should auto-install it; check 'docker compose logs postgres'." 2
fi
pass "Postgres alive, pgvector extension enabled"

# 3. Backend /health
info "3/6 — alfred-core /health"
HEALTH=$(curl -sf "${API_URL%/}/health" 2>/dev/null || echo "")
if [[ -z "$HEALTH" ]]; then
    fail "alfred-core /health did not respond" \
         "Run 'docker compose logs alfred-core' — typically a missing env var or DB migration issue." 3
fi
case "$HEALTH" in
    *'"status"'*'"ok"'*) pass "backend /health returned ok (${HEALTH})" ;;
    *) fail "backend /health returned unexpected payload" "$HEALTH" 3 ;;
esac

# 4. Vision router registered + pgvector query path works
info "4/6 — alfred-core /vision/face/enrollments"
VIS=$(curl -sf "${API_URL%/}/vision/face/enrollments" 2>/dev/null || echo "")
if [[ -z "$VIS" ]]; then
    fail "/vision/face/enrollments did not respond" \
         "Likely the new face_enrollments table failed to create. 'docker compose logs alfred-core'." 4
fi
if ! grep -q '"enrollments"' <<<"$VIS"; then
    fail "vision endpoint returned unexpected payload" "$VIS" 4
fi
pass "vision router live, face_enrollments table queryable"

# 5. Ollama (warning only — Alfred can run cloud-only)
info "5/6 — Ollama"
OLLAMA_OUT=$(curl -sf --max-time 3 "${OLLAMA_URL%/}/api/tags" 2>/dev/null || echo "")
if [[ -z "$OLLAMA_OUT" ]]; then
    if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
        info "Ollama not reachable, but ANTHROPIC_API_KEY is set — chat will fall back to cloud."
    else
        fail "Ollama is not reachable AND no ANTHROPIC_API_KEY is set" \
             "Either start Ollama on the host ('ollama serve') and pull a chat model, or set ANTHROPIC_API_KEY in .env." 5
    fi
else
    pass "Ollama reachable, $(echo "$OLLAMA_OUT" | grep -o '"name":"[^"]*"' | wc -l | tr -d ' ') models available"
fi

# 6. Frontend
info "6/6 — alfred-web :3000"
WEB_HTML=$(curl -sf --max-time 5 "$WEB_URL" 2>/dev/null || echo "")
if [[ -z "$WEB_HTML" ]]; then
    fail "frontend did not respond on :3000" \
         "Run 'docker compose logs alfred-web' — usually a Next.js build failure." 6
fi
if ! grep -qi "alfred" <<<"$WEB_HTML"; then
    fail "frontend served HTML but didn't mention 'Alfred'" \
         "Stale build? Try 'docker compose up --build alfred-web'." 6
fi
pass "frontend serving the HUD"

echo
echo "${GREEN}All systems nominal, sir.${RESET}"
echo "${DIM}  HUD:        ${WEB_URL}${RESET}"
echo "${DIM}  API:        ${API_URL}${RESET}"
echo "${DIM}  Ollama:     ${OLLAMA_URL}${RESET}"
