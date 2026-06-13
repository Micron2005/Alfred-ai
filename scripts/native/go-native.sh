#!/usr/bin/env bash
# Migrate Alfred from "Docker Compose" to "native WSL2 systemd
# services" — one command, end to end, idempotent. Run from the
# repo root:
#
#   ./scripts/native/go-native.sh
#
# What this does (each step is idempotent; rerun safely):
#   1. Sanity-check WSL2 + systemd.
#   2. apt-install the deps Alfred used to get from Docker:
#      postgresql-16 + pgvector, python3.11+ + venv, nodejs 20,
#      ffmpeg, build tools, socat (for the existing Ollama bridge).
#   3. Set up Postgres: create alfred role + alfred DB + the
#      ``vector`` extension. Update DATABASE_URL in .env to point at
#      the native socket / TCP port.
#   4. Build the alfred-core Python venv at .venv-alfred-core,
#      install -e ., download Piper voice, pre-warm Whisper.
#   5. Build the alfred-web bundle (npm install + next build).
#   6. Install systemd units alfred-core.service + alfred-web.service.
#   7. Stop and DISABLE the old docker-compose stack (containers stay
#      on disk so the user can ``docker compose down -v`` after they
#      confirm the native stack is working).
#   8. Start the native services, wait healthy, restore memory from
#      the markdown mirror.
#
# The script never deletes anything destructive. To completely wipe
# the old Docker setup (engine, images, volumes), run
# scripts/native/uninstall-docker.sh after a few days of confidence.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NATIVE_DIR="${REPO_ROOT}/scripts/native"
RUN_AS_USER="${SUDO_USER:-$(id -un)}"

# Colours and small helpers ──────────────────────────────────────
G='\033[1;32m'; Y='\033[1;33m'; R='\033[1;31m'; C='\033[1;36m'; N='\033[0m'
say()   { printf "${C}── %s${N}\n" "$*"; }
ok()    { printf "${G}   ✓ %s${N}\n" "$*"; }
warn()  { printf "${Y}   ⚠ %s${N}\n" "$*"; }
die()   { printf "${R}   ✗ %s${N}\n" "$*"; exit 1; }

cd "$REPO_ROOT"

# ── 1. Sanity checks ────────────────────────────────────────────
say "[1/8] Pre-flight"
if ! grep -qi microsoft /proc/version 2>/dev/null; then
    warn "This doesn't look like WSL2 — the script still works on a"
    warn "plain Ubuntu host, but Ollama bridging assumes WSL2/Windows."
fi
if ! command -v systemctl >/dev/null 2>&1; then
    die "systemctl missing — enable systemd in /etc/wsl.conf and \`wsl --shutdown\` first."
fi
if ! systemctl is-system-running --quiet 2>/dev/null && ! pgrep -x systemd >/dev/null; then
    die "systemd isn't running. Set [boot]\\nsystemd=true in /etc/wsl.conf, then \`wsl --shutdown\`."
fi
ok "WSL2 + systemd OK"

# ── 2. OS dependencies ──────────────────────────────────────────
say "[2/8] Installing OS dependencies"
sudo apt-get update -qq
# postgresql-16 + pgvector ship in Ubuntu 24.04. On 22.04 the user
# would need the PGDG repo — we surface a clear message if so.
if ! apt-cache show postgresql-16 >/dev/null 2>&1; then
    warn "postgresql-16 not in apt — adding the PGDG repository"
    sudo apt-get install -y -qq curl ca-certificates lsb-release gnupg
    sudo install -d /usr/share/postgresql-common/pgdg
    sudo curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
        | sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null
    sudo apt-get update -qq
fi
sudo apt-get install -y -qq \
    postgresql-16 postgresql-contrib-16 postgresql-16-pgvector \
    python3 python3-venv python3-dev \
    build-essential ca-certificates curl \
    ffmpeg socat
ok "apt deps installed"

# Node.js 20 from NodeSource (Ubuntu's nodejs is too old).
if ! command -v node >/dev/null 2>&1 || \
   [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
    say "    Installing Node.js 20 (NodeSource)"
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null
    sudo apt-get install -y -qq nodejs
fi
ok "Node $(node --version)"

# ── 3. Postgres role + DB + extension ───────────────────────────
say "[3/8] Configuring Postgres"
sudo systemctl enable --now postgresql

# Generate a stable password the first time, persist to .env.
DB_PASS="$(grep -E '^POSTGRES_PASSWORD=' .env 2>/dev/null | cut -d= -f2- | tr -d '"'\''')"
if [[ -z "$DB_PASS" || "$DB_PASS" == *"wayne"* ]]; then
    DB_PASS="$(openssl rand -hex 16 2>/dev/null || head -c 16 /dev/urandom | xxd -p)"
fi
DB_USER="alfred"
DB_NAME="alfred"

# Idempotent role + db + extension create (no DROP, ever).
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}') THEN
        CREATE ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASS}';
    ELSE
        ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASS}';
    END IF;
END
\$\$;
SQL
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
    sudo -u postgres createdb -O "${DB_USER}" "${DB_NAME}"
fi
sudo -u postgres psql -d "${DB_NAME}" -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null

# Update .env in-place: DATABASE_URL points at native, ALFRED_MEMORY_DIR
# points at the host folder (no more container path).
NEW_DB_URL="postgresql+psycopg://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}"
python3 - <<PY
import re
from pathlib import Path
env = Path("${REPO_ROOT}/.env")
text = env.read_text(encoding="utf-8") if env.exists() else ""
def upsert(src: str, key: str, value: str) -> str:
    line = f'{key}="{value}"'
    if re.search(rf'^{re.escape(key)}=', src, re.M):
        return re.sub(rf'^{re.escape(key)}=.*$', line, src, flags=re.M)
    return src.rstrip() + "\n" + line + "\n"
text = upsert(text, "DATABASE_URL", "${NEW_DB_URL}")
text = upsert(text, "POSTGRES_USER", "${DB_USER}")
text = upsert(text, "POSTGRES_PASSWORD", "${DB_PASS}")
text = upsert(text, "POSTGRES_DB", "${DB_NAME}")
# In native mode the container path doesn't exist; use the host one.
text = upsert(text, "ALFRED_MEMORY_DIR", "${REPO_ROOT}/alfred-memory")
# With native alfred-core + the alfred-ollama-bridge already on
# WSL :11434, plain localhost works.
text = upsert(text, "OLLAMA_HOST", "http://localhost:11434")
env.write_text(text, encoding="utf-8")
PY
ok "Postgres + .env wired up"

# ── 4. Python venv for alfred-core ──────────────────────────────
say "[4/8] Building alfred-core venv (.venv-alfred-core)"
VENV="${REPO_ROOT}/.venv-alfred-core"
if [[ ! -d "$VENV" ]]; then
    python3 -m venv "$VENV"
fi
"${VENV}/bin/pip" install --upgrade pip >/dev/null
"${VENV}/bin/pip" install -e "${REPO_ROOT}/alfred-core" >/dev/null
ok "alfred-core installed editable"

# Piper TTS binary + voice (replicate what the Dockerfile did).
say "    Installing Piper TTS"
PIPER_DIR="${REPO_ROOT}/.alfred-deps/piper"
PIPER_VOICE="en_GB-northern_english_male-medium"
PIPER_VOICE_PATH="en/en_GB/northern_english_male/medium"
PIPER_VERSION="2023.11.14-2"
if [[ ! -x "${PIPER_DIR}/piper" ]]; then
    mkdir -p "${PIPER_DIR}"
    ARCH="$(uname -m)"
    case "$ARCH" in
        x86_64)  PIPER_ARCH="linux_x86_64" ;;
        aarch64) PIPER_ARCH="linux_aarch64" ;;
        *) die "Unsupported arch for Piper: $ARCH" ;;
    esac
    curl -fsSL "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_${PIPER_ARCH}.tar.gz" \
        | tar -xz --strip-components=1 -C "${PIPER_DIR}"
fi
if [[ ! -f "${PIPER_DIR}/voices/${PIPER_VOICE}.onnx" ]]; then
    mkdir -p "${PIPER_DIR}/voices"
    curl -fsSL -o "${PIPER_DIR}/voices/${PIPER_VOICE}.onnx" \
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/${PIPER_VOICE_PATH}/${PIPER_VOICE}.onnx?download=true"
    curl -fsSL -o "${PIPER_DIR}/voices/${PIPER_VOICE}.onnx.json" \
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/${PIPER_VOICE_PATH}/${PIPER_VOICE}.onnx.json?download=true"
fi
ok "Piper ready"

# Pre-warm Whisper so the first /voice/stt call isn't a 60 s download.
say "    Pre-warming faster-whisper base.en"
"${VENV}/bin/python" -c "from faster_whisper import WhisperModel; \
WhisperModel('base.en', device='cpu', compute_type='int8', \
download_root='${REPO_ROOT}/.alfred-deps/whisper-models')" >/dev/null 2>&1 \
    || warn "Whisper pre-warm failed (will lazy-download on first STT call)"

# ── 5. Build the Next.js bundle ─────────────────────────────────
say "[5/8] Building alfred-web"
pushd "${REPO_ROOT}/alfred-web" >/dev/null
if [[ ! -d node_modules ]]; then
    npm install --legacy-peer-deps --no-audit --no-fund >/dev/null
fi
# Re-build on every install so .env-baked NEXT_PUBLIC_* values stay fresh.
NEXT_PUBLIC_API_BASE="${NEXT_PUBLIC_API_BASE:-http://localhost:8000}" \
NEXT_PUBLIC_WAKE_KEYWORD="${NEXT_PUBLIC_WAKE_KEYWORD:-hey_alfred}" \
NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN="${NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN:-}" \
    npm run build >/dev/null
popd >/dev/null
ok "alfred-web built"

# ── 6. systemd units ────────────────────────────────────────────
say "[6/8] Installing systemd units"
install_unit() {
    local src="$1" dst="$2"
    local tmp; tmp="$(mktemp)"
    sed \
        -e "s|%REPO_ROOT%|${REPO_ROOT}|g" \
        -e "s|%RUN_AS_USER%|${RUN_AS_USER}|g" \
        "$src" >"$tmp"
    sudo install -m 0644 "$tmp" "$dst"
    rm -f "$tmp"
}
install_unit "${NATIVE_DIR}/alfred-core.service" /etc/systemd/system/alfred-core.service
install_unit "${NATIVE_DIR}/alfred-web.service"  /etc/systemd/system/alfred-web.service
sudo systemctl daemon-reload
sudo systemctl enable alfred-core.service alfred-web.service >/dev/null 2>&1
ok "alfred-core + alfred-web installed (enabled at boot)"

# ── 7. Stop the old Docker stack ────────────────────────────────
say "[7/8] Standing down the Docker stack"
if command -v docker >/dev/null 2>&1 && [[ -f docker-compose.yml ]]; then
    # Stop the previous boot-time unit so it doesn't fight us.
    sudo systemctl disable --now alfred.service 2>/dev/null || true
    # Bring containers down but KEEP volumes — last-ditch recovery.
    docker compose down 2>/dev/null || true
    ok "Docker stack stopped (containers + volumes preserved on disk)"
else
    ok "No docker stack to stop"
fi

# ── 8. Boot native + restore memory ─────────────────────────────
say "[8/8] Starting native services + restoring memory"
sudo systemctl restart alfred-core.service
# Wait up to 60 s for /health to return 200.
for i in $(seq 1 30); do
    if curl -fsS --max-time 1 http://localhost:8000/health >/dev/null 2>&1; then
        ok "alfred-core healthy"
        break
    fi
    sleep 2
done

# Restore memory from the markdown mirror NOW (DB is freshly initialised).
say "    Restoring memory from ${REPO_ROOT}/alfred-memory"
"${VENV}/bin/python" "${REPO_ROOT}/scripts/restore-memory.py" || warn "restore-memory.py exited non-zero — check the output"

sudo systemctl restart alfred-web.service
for i in $(seq 1 30); do
    if curl -fsS --max-time 1 http://localhost:3000/ >/dev/null 2>&1; then
        ok "alfred-web healthy"
        break
    fi
    sleep 2
done

cat <<EOF

${G}NATIVE MIGRATION COMPLETE${N}

  alfred-core:  http://localhost:8000  (systemd: alfred-core.service)
  alfred-web:   http://localhost:3000  (systemd: alfred-web.service)
  postgres:     localhost:5432         (systemd: postgresql.service)
  ollama:       Windows host, via existing socat bridge on :11434

Useful commands:
  Logs:        sudo journalctl -u alfred-core.service -f
  Restart:     sudo systemctl restart alfred-core.service
  Stop all:    sudo systemctl stop alfred-core.service alfred-web.service
  Edit env:    \$EDITOR ${REPO_ROOT}/.env  (then restart alfred-core)
  Restore mem: ${VENV}/bin/python ${REPO_ROOT}/scripts/restore-memory.py

Docker is OFF but still installed. Once you've confirmed the native
stack is solid (give it a day of normal use), wipe Docker entirely:
  ./scripts/native/uninstall-docker.sh
EOF
