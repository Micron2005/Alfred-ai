# Architecture

## The shape of things

Alfred is a small number of well-defined services that talk to each other over HTTP. That keeps each piece replaceable — you can swap the local LLM, change the frontend, or move the smart-home layer without tearing the rest apart.

```
┌──────────────────────────────────────────────────────────────────┐
│  Your PC (Windows 11 + WSL2 + Docker Desktop)                    │
│                                                                  │
│  ┌──────────────┐  HTTP   ┌─────────────────┐  HTTP  ┌────────┐  │
│  │  alfred-web  │ ──────► │  alfred-core    │ ─────► │ Ollama │  │
│  │  Next.js 15  │ ◄────── │  FastAPI        │ ◄───── │ (local │  │
│  │  Chat UI     │         │                 │        │  LLM)  │  │
│  └──────────────┘         │  Router decides │        └────────┘  │
│                           │  local vs cloud │                    │
│                           │                 │        ┌────────┐  │
│                           │                 │ ─────► │ Claude │  │
│                           │                 │ ◄───── │  API   │  │
│                           │                 │        │ (opt.) │  │
│                           └────────┬────────┘        └────────┘  │
│                                    │                             │
│                                    ▼                             │
│                           ┌─────────────────┐                    │
│                           │  Postgres 16    │                    │
│                           │  + pgvector     │                    │
│                           │  (memory, logs) │                    │
│                           └─────────────────┘                    │
└──────────────────────────────────────────────────────────────────┘
```

## Services

### `alfred-core` — the brain
Python 3.11 + FastAPI. Responsibilities:

- **Persona** (`persona.py`): assembles the system prompt for Standard Mode or Nightfall Protocol.
- **Wake detection** (`wake.py`): looks at each user message for the name "Alfred" and for mode-change phrases like "activate Nightfall Protocol" or "stand down".
- **Router** (`router.py`): picks an LLM backend. Coding-flavoured requests → Claude (if enabled). Everything else → local Ollama.
- **LLM backends** (`llm/local.py`, `llm/anthropic_backend.py`): thin HTTP wrappers implementing a common `LLMBackend` protocol. Adding a new backend = adding one file.
- **API** (`api/*.py`): three small routers — `/health`, `/mode`, `/chat`.
- **DB** (`db/*.py`): SQLAlchemy async models for `Conversation`, `Message`, `Feedback`. pgvector extension wired up for later memory work.

### `alfred-web` — the face
Next.js 15 + React. A minimal, un-chatty UI. Standard Mode uses a warm parchment palette (butler). Nightfall Protocol swaps to a dark palette with a gold accent (cave). Theme switches automatically when the backend tells it the mode has changed.

### Postgres + pgvector — the memory
- Stores every conversation and message.
- Stores thumbs-up / thumbs-down feedback (UI arrives with Phase 5) — that data powers periodic LoRA fine-tuning later.
- `pgvector` extension available for semantic memory once we start embedding conversation chunks.

## How a message flows

1. You type in the browser (`Composer.tsx`) → POST `/chat` with `{message, conversation_id}`.
2. `alfred-core` parses the message with `wake.analyze()`:
   - Was Alfred addressed by name? (for Phase 4 voice gating)
   - Did you ask for a mode change? If so, flip the global mode.
3. Build the persona for the current mode (`build_persona`).
4. Load the conversation history from Postgres; prepend the system prompt.
5. Router decides: local or cloud?
6. Selected backend does the completion.
7. Persist the user message + assistant message to Postgres.
8. Return `{conversation_id, mode, assistant}` to the UI.
9. UI appends the reply and, if mode changed, retones the theme.

## What lives outside this repo

- **Ollama** runs on the Windows host (easier AMD GPU access) and is reached at `host.docker.internal:11434` from inside Docker.
- **Home Assistant** (Phase 2) will also live in this `docker-compose.yml` as its own service.
- **Moonraker** (Phase 3) runs on the Creality K1 Max itself, over the local network.

## Extension points

Everything is hooked up so that:

- **Adding a new tool** (e.g. `control_lights`, `slice_gcode`) = drop a module under `alfred_core/tools/`, register it in the router, expose it as a function the LLM can call.
- **Adding a new backend** (e.g. a self-hosted vLLM server, a Groq API account) = implement `LLMBackend`, wire it into `Router.from_settings`.
- **Adding a new persona mode** (e.g. a "focus" mode) = add an enum value and a template in `persona.py`, register a wake phrase in `wake.py`.
