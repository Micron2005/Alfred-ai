# Alfred AI

> *"I've sewn you up, I've set your broken bones — but I will not bury you. I've buried enough members of the Wayne family."*

A self-hosted personal AI assistant in the spirit of Alfred Pennyworth: dry, loyal, quietly competent. Inspired by JARVIS in capability, but with a butler's manners and a sarcastic streak.

This is a hobby project for **Mukarram Mohammad Alam**, built to run on a home PC and be reachable from anywhere via Tailscale.

## Current status: Phase 1 — Core chat scaffold

- [x] FastAPI backend (`alfred-core`) with Alfred persona
- [x] Next.js chat UI (`alfred-web`)
- [x] Standard Mode + **Nightfall Protocol** persona switching
- [x] Pluggable LLM backends: local (Ollama) + cloud (Anthropic Claude for coding)
- [x] Postgres + pgvector for memory and feedback
- [x] Docker Compose for one-command local run
- [x] **Design pad** — touch/stylus sketch pad with layers, pressure-sensitive tools, and Alfred voice control ("pull up the design tab", "analyze my sketch") — see [docs/DESIGN_PAD.md](docs/DESIGN_PAD.md)
- [ ] Smart-home control via Home Assistant (Phase 2)
- [ ] Creality K1 Max printer control + CAD generation (Phase 3)
- [ ] Voice in/out with Whisper + Piper (Phase 4)
- [ ] Feedback-driven LoRA fine-tuning (Phase 5)
- [ ] Self-improvement / developer mode (Phase 6)
- [ ] Mobile app (Phase 7)

## Quick start (WSL2 on Windows 11)

**Prerequisites:**
- Windows 11 with [WSL2 + Ubuntu](https://learn.microsoft.com/en-us/windows/wsl/install) installed
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) with WSL2 integration enabled
- [Ollama](https://ollama.com/) running on the Windows host (or inside WSL) with a model pulled:
  ```bash
  ollama pull llama3.1:8b-instruct-q4_K_M
  ```
- (Optional) Anthropic API key if you want the coding fallback

```bash
git clone https://github.com/<your-username>/alfred-ai.git
cd alfred-ai
cp .env.example .env
# edit .env to add your ANTHROPIC_API_KEY (optional) and confirm OLLAMA_HOST
docker compose up --build
```

Then open http://localhost:3000 and say hello.

After the stack is up, run the smoke test to verify every layer:

```bash
./scripts/smoke-test.sh
```

For an auto-start-on-boot install (Linux / Raspberry Pi 5):

```bash
./scripts/install-systemd.sh
```

See [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) for the full
self-hosting guide — covers x86 desktops, WSL2, and the Raspberry
Pi 5 path — and [docs/SETUP_WINDOWS_WSL.md](docs/SETUP_WINDOWS_WSL.md)
for the detailed Windows step-by-step. Running Windows **without
Docker Desktop** and want Alfred to start at boot in its own app
window? See
[docs/SETUP_WINDOWS_NO_DOCKER_DESKTOP.md](docs/SETUP_WINDOWS_NO_DOCKER_DESKTOP.md).

## The persona

Alfred has two modes:

### Standard Mode (default)
Dry, witty, sarcastic British butler. Calls you **"sir"**. Knows your name is **Mukarram Mohammad Alam**. Helpful and loyal, but will happily puncture your ego when you deserve it.

### Nightfall Protocol
Triggered by saying **"Alfred, activate Nightfall Protocol"**. Alfred becomes more clipped, serious, and brooding. Still calls you "sir" but also addresses you as **"Batman"**. Web UI dims to a dark cape-and-cowl theme. Deactivated with **"Alfred, deactivate Nightfall Protocol"** or **"stand down"**.

See [docs/NIGHTFALL_PROTOCOL.md](docs/NIGHTFALL_PROTOCOL.md) for details on how the mode system works under the hood.

## Wake phrases

Whether you're typing or (eventually) speaking, Alfred responds to:

- "Alfred"
- "Hey Alfred"
- "Hi Alfred"
- "Hello Alfred"
- "What you up to, Alfred?"

…and any sentence containing his name. When voice is enabled (Phase 4), openWakeWord will listen for the name in any position rather than requiring a specific exact phrase.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
Web UI (Next.js) ──► Alfred Core (FastAPI) ──► Local LLM (Ollama, Llama 3.1 8B)
                         │                 └─► Cloud LLM (Claude, coding only)
                         ├─► Postgres + pgvector (memory)
                         ├─► Home Assistant (lights)    [Phase 2]
                         └─► Moonraker on K1 Max        [Phase 3]
```

## Remote access

Install [Tailscale](https://tailscale.com) on your home PC, your laptop, and your phone — all on the same free tailnet. Alfred becomes reachable from anywhere you go, without port forwarding. See [docs/TAILSCALE.md](docs/TAILSCALE.md).

## License

MIT — do what you want with it.
