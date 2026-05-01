# Alfred AI

> *"I've sewn you up, I've set your broken bones — but I will not bury you. I've buried enough members of the Wayne family."*

A self-hosted personal AI assistant in the spirit of Alfred Pennyworth: dry, loyal, quietly competent. Inspired by JARVIS in capability, but with a butler's manners and a sarcastic streak.

This is a personal assistant AI inspired by jarvis, but made to be your butler like alfred and will treat you like Batman for **Your_Name**

## Current status: Phase 1 — Core chat scaffold

- [x] FastAPI backend (`alfred-core`) with Alfred persona
- [x] Next.js chat UI (`alfred-web`)
- [x] Standard Mode + **Nightfall Protocol** persona switching
- [x] Pluggable LLM backends: local (Ollama) + cloud (Anthropic Claude for coding)
- [x] Postgres + pgvector for memory and feedback
- [x] Docker Compose for one-command local run
- [ ] Smart-home control via Home Assistant (Phase 2)
- [ ] Creality K1 Max printer control + CAD generation (Phase 3)
- [x] Voice in/out with Whisper + Piper (Phase 4)
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

See [docs/SETUP_WINDOWS_WSL.md](docs/SETUP_WINDOWS_WSL.md) for the detailed step-by-step.

## The persona

Alfred has two modes:

### Standard Mode (default)
Dry, witty, sarcastic British butler. Calls you **"sir"**. Knows your name is **Your_Name**. Helpful and loyal, but will happily puncture your ego when you deserve it.

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
