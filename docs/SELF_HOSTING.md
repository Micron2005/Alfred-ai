# Self-hosting Alfred AI

Alfred is built to run on hardware **you own**. This guide is the single
source of truth for getting it running on:

- 🖥️ A Linux desktop / WSL2 on Windows / macOS dev box (today)
- 🥧 A Raspberry Pi 5 with 8 GiB RAM (when you get one)

Both paths share the same `docker-compose.yml` — only the build
options and Ollama model choices change.

---

## Hardware needs

| Component | Minimum | Recommended |
|---|---|---|
| **CPU** | 2 cores x86_64 or ARM64 | 4+ cores |
| **RAM** | 4 GiB | 8 GiB+ (16 GiB if running Llama 3.1 8B locally) |
| **Disk** | 12 GiB free (Postgres + Whisper model + Piper voices + Docker images) | SSD strongly preferred |
| **GPU** | None — everything works on CPU | Any consumer GPU speeds up Ollama 5-20× |
| **Network** | Internet on first build only (model downloads); afterwards LAN-only is fine | Tailscale for remote access |

The Pi 5 8 GiB hits the recommended bar for everything *except* running
Llama 3.1 8B locally. On a Pi we recommend either:

- ✅ Cloud chat via Anthropic API (set `ANTHROPIC_API_KEY` in `.env`, leave `LOCAL_MODEL_CHAT=""`), OR
- ✅ A smaller local model like `phi3.5:3.8b-q4_K_M` or `llama3.2:3b-q4_K_M`

---

## Quick start

### 1. Prerequisites

```bash
# Linux / Pi OS
sudo apt update && sudo apt install -y docker.io docker-compose-plugin git curl
sudo usermod -aG docker $USER   # log out and back in

# Optional: Ollama for local chat (skip on a Pi 5 if using cloud)
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama3.1:8b-instruct-q4_K_M    # x86 / Mac
# OR (lighter, Pi-friendly):
ollama pull phi3.5:3.8b
```

On macOS use Docker Desktop instead. On Windows, install WSL2 + Ubuntu
+ Docker Desktop with WSL integration enabled, then follow the Linux
path inside Ubuntu.

### 2. Clone + configure

```bash
git clone https://github.com/Micron2005/Alfred-ai.git
cd Alfred-ai
cp .env.example .env
${EDITOR:-nano} .env
```

Minimum edits in `.env`:

- `POSTGRES_PASSWORD` — change from the default
- `ALFRED_LOCATION_LATITUDE`, `ALFRED_LOCATION_LONGITUDE`, `ALFRED_LOCATION_CITY` — set to your home
- One of:
  - `LOCAL_MODEL_CHAT` (e.g. `llama3.1:8b-instruct-q4_K_M`) for local chat, OR
  - `ANTHROPIC_API_KEY=sk-ant-…` for cloud chat
- `OLLAMA_HOST` — defaults to `http://host.docker.internal:11434`. Leave it alone if Ollama runs on the host.

### 3. Build and start

```bash
docker compose up --build -d
./scripts/smoke-test.sh
```

The smoke test runs **6 health checks** (compose, Postgres, pgvector,
backend, Ollama, frontend) and tells you the first thing that's
wrong with a one-line hint. Expected output:

```
✓ all 3 compose services present
✓ Postgres alive, pgvector extension enabled
✓ backend /health returned ok
✓ vision router live, face_enrollments table queryable
✓ Ollama reachable, 2 models available
✓ frontend serving the HUD

All systems nominal, sir.
  HUD:    http://localhost:3000
  API:    http://localhost:8000
  Ollama: http://localhost:11434
```

Open `http://localhost:3000` and say *"Hello, Alfred."*

### 4. Auto-start on boot (Linux only)

```bash
./scripts/install-systemd.sh
sudo systemctl start alfred.service
sudo systemctl status alfred.service     # verify
```

Now Alfred boots with the machine. To stop:

```bash
sudo systemctl stop alfred.service
# or, to disable on boot:
sudo systemctl disable alfred.service
```

### 5. Remote access via Tailscale (recommended)

See `docs/TAILSCALE.md`. tl;dr — install Tailscale on the host,
your phone, your laptop. Alfred is reachable at
`http://<host-tailscale-ip>:3000` from anywhere on your tailnet.
No port forwarding, no public URL, no DDNS dance.

---

## Raspberry Pi 5 path

The Pi 5 is fully supported as of this branch. The Dockerfiles
detect `TARGETARCH` and pull the correct ARM64 binaries (Piper TTS).

### Differences from the desktop path

1. **Set `ALFRED_SKIP_MODEL_PREFETCH=1`** in your `.env` to skip the
   Whisper model pre-warm during `docker build`. The Pi will
   download it on the first `/voice/stt` request instead, which
   avoids OOMing the build.

2. **Use a smaller LLM**:
   ```bash
   # On the Pi host (Ollama runs natively, not in Docker):
   ollama pull phi3.5:3.8b
   # Then in .env:
   LOCAL_MODEL_CHAT=phi3.5:3.8b
   ```
   Or skip local chat entirely and use Anthropic.

3. **Use an SSD** — the SD card will work but Postgres + faster-whisper
   will be painfully slow. A USB 3.0 SSD or NVMe HAT transforms the
   experience.

4. **Cooling matters** — Pi 5 with sustained inference load will
   thermally throttle without an active cooler. The official
   Raspberry Pi Active Cooler is enough.

5. **64-bit OS only** — Raspberry Pi OS Bookworm 64-bit. 32-bit
   armhf is *not* supported by the pgvector image.

### Building the images on the Pi itself

```bash
# Once the repo is cloned and .env is set:
docker compose build --build-arg ALFRED_SKIP_MODEL_PREFETCH=1
docker compose up -d
```

### Cross-compiling images on your desktop, deploying to Pi

Faster build, more disk in the staging area:

```bash
# On your desktop, with buildx + qemu-user-static:
docker buildx create --use --name alfred-builder
docker buildx build --platform linux/arm64 \
  -t localhost:5000/alfred-core:arm64 \
  --push ./alfred-core
docker buildx build --platform linux/arm64 \
  -t localhost:5000/alfred-web:arm64 \
  --push ./alfred-web
```

Then `docker compose pull` on the Pi.

---

## Common issues & fixes

### Smoke test step 2 fails: pgvector extension not enabled

The `pgvector/pgvector:pg16` image *should* enable the extension
automatically on first init. If it didn't (e.g. a stale volume from an
earlier `postgres:16` image):

```bash
docker compose down
docker volume rm alfred-ai_postgres-data    # data loss!
docker compose up --build -d
```

### Smoke test step 5 fails: Ollama not reachable

Ollama runs on the **host**, not in Compose, so the containers reach it
via `host.docker.internal`. If you're on Linux and `host.docker.internal`
isn't resolving, the compose file already adds:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

Make sure Ollama is bound to all interfaces (default is loopback only):

```bash
# /etc/systemd/system/ollama.service.d/override.conf:
[Service]
Environment="OLLAMA_HOST=0.0.0.0"
```

Or just set `OLLAMA_HOST=http://host.docker.internal:11434` in `.env`.

### Frontend builds but says "Alfred is unreachable" on first chat

`NEXT_PUBLIC_API_BASE` is **inlined at build time**. If you edit `.env`
to point at a different backend URL, you must rebuild:

```bash
docker compose up --build -d
```

### Pi 5 OOMs during build

Add `--build-arg ALFRED_SKIP_MODEL_PREFETCH=1` (skip Whisper download
in build) and consider building only one service at a time:

```bash
docker compose build --build-arg ALFRED_SKIP_MODEL_PREFETCH=1 alfred-core
docker compose build alfred-web
```

---

## What lives where

```
.
├── alfred-core/                  ← FastAPI backend (Python)
│   ├── Dockerfile                ← Multi-arch, downloads Piper + Whisper
│   └── src/alfred_core/
│       ├── api/vision.py         ← /vision/* endpoints (NEW)
│       ├── vision/               ← Face recognition + workout coach (NEW)
│       └── …
├── alfred-web/                   ← Next.js frontend (TypeScript)
│   ├── Dockerfile                ← Multi-arch, healthcheck
│   └── src/
│       ├── components/
│       │   ├── Orb3D.tsx         ← New 3D orb (NEW)
│       │   ├── FaceMesh.tsx      ← Face landmark overlay (NEW)
│       │   ├── PoseSkeleton.tsx  ← Body skeleton overlay (NEW)
│       │   ├── WorkoutCoachWidget.tsx (NEW)
│       │   └── FaceRecognitionWidget.tsx (NEW)
│       └── lib/
│           ├── useFaceTracking.ts (NEW)
│           ├── usePoseTracking.ts (NEW)
│           ├── poseAnalyzer.ts    ← Form heuristics (NEW)
│           └── visionApi.ts       (NEW)
├── docker-compose.yml            ← Healthchecks + service dependency chain
├── docs/
│   ├── ARCHITECTURE.md
│   ├── NIGHTFALL_PROTOCOL.md
│   ├── SELF_HOSTING.md           ← This file
│   ├── TAILSCALE.md
│   ├── VISION_HUD_UPGRADE.md     ← Walkthrough of the new vision features
│   └── SETUP_WINDOWS_WSL.md
└── scripts/
    ├── alfred.service            ← systemd template (NEW)
    ├── install-systemd.sh        ← One-command install (NEW)
    └── smoke-test.sh             ← 6-step readiness check (NEW)
```
