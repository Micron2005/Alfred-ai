# Alfred AI — PRD

## Original problem statement
> "Are you able to go through this repo and fix any bugs you see? I want to be able to have this as an app I can download on my phone or a Raspberry Pi 5. I dont have a pi 5 right now but eventually I will. I want the hand tracking improved. I want it to be able to track my facial expressions as well. I will also want it to track my body movement so I can have it help me practice martial arts, or help fix my form for any workout I need help on. and can give me workouts based on anything I ask it or for what my form is and to better it. I also want it to have facial recognition. I also want the main hud display to be more 3 dimensional"
> Repo: https://github.com/Micron2005/Alfred-ai (28+ unmerged `devin/*` branches)

## Architecture
- **alfred-core** (FastAPI + SQLAlchemy + pgvector + Postgres) — chat, memory, voice, Spotify, weather, vision
- **alfred-web** (Next.js 15 + React 19) — JARVIS HUD with hand tracking, face tracking, pose tracking, 3D orb
- **External**: Ollama (local LLM), Anthropic API (cloud fallback), MediaPipe (browser-side CV)
- Container: Docker Compose, deployable behind Tailscale

## Persona
Single user — Mukarram Mohammad Alam. Alfred is a dry, witty British butler with strength-and-conditioning expertise.

## Core requirements (static)
- Self-hosted; runs on home PC (eventually Raspberry Pi 5)
- Privacy-respecting (CV happens client-side; LLM can be local)
- Persona-consistent across all surfaces (chat, voice, vision)

## What's been implemented (this session — 2026-04-29)
- ✅ **Audited the latest devin branch** (`devin/1777434054-pre-mirror-frame-skeleton-scale`); confirmed existing hand tracking is well-engineered (no real bugs)
- ✅ **Facial expression tracking** — MediaPipe FaceLandmarker, 478 landmarks + 52 blendshapes, FaceMesh overlay, dominant-expression panel
- ✅ **Body pose tracking** — MediaPipe PoseLandmarker, 33-point skeleton, joint angles + biomechanics readout
- ✅ **3D orb upgrade** — Orb3D component using CSS 3D transforms (no extra deps), 4 rings rotating in 3D + orbital satellites + glowing core
- ✅ **Workout / form coach** — heuristic analyzers for 6 exercises (squat, push-up, plank, lunge, fighting/horse stance) + LLM-driven coach endpoint that returns prose + structured plan
- ✅ **Facial recognition** — pgvector-backed enrollment + cosine-similarity match (96-D geometric identity vectors)
- ✅ **Backend `/vision/*` API** — face enroll/identify/list/delete, coach
- ✅ **`FaceEnrollment` model** with `face_enrollments` table + Vector(96) column
- ✅ **Documented** in `docs/VISION_HUD_UPGRADE.md`

Static checks passed:
- `yarn typecheck` (TypeScript) ✅
- `yarn lint` (ESLint) ✅  
- `ruff` (Python) ✅
- AST parse on all new Python files ✅

**Not run end-to-end in Emergent** — the stack needs Postgres + Ollama (Docker Compose). User runs locally via `docker compose up --build` and validates there.

## Implementation lives on branch
`feature/holistic-tracking-3d-hud` (committed locally; user needs to push via Save-to-GitHub)

## Prioritized backlog (P0/P1/P2)

### P0 — for next session
- Verify `docker compose up --build` succeeds on user's home PC and the new toggles work end-to-end
- Tune the form-coach heuristics with real footage; calibrate stance thresholds for the user's body
- Adjust face-identity threshold after the user has enrolled 2-3 family members (likely 0.94-0.96)

### P1 — feature follow-ups
- Replace 96-D geometric identity vector with a learned face embedding (`@vladmandic/face-api` for 128-D, or backend `insightface` for 512-D ArcFace)
- Add martial-arts move library (jab, cross, hook, kick, etc.) with target joint sequences for rep-counting
- Pose-driven gesture controls (e.g. T-pose to take a screenshot, hands-up to pause)
- Voice synthesis of form cues (use existing TTS pipeline so Alfred speaks corrections)

### P2 — bigger
- PWA install (already on a separate `devin/1777334990-pwa-install` branch — merge when ready)
- Raspberry Pi 5 deployment guide (ARM64 Docker images, ONNX-runtime CV models, hardware acceleration)
- Native mobile app (Capacitor wrapper around the existing Next.js app)
- Workout history & progress tracking (new DB table, weekly summary widget)

## Next tasks
1. User validates with `docker compose up --build` on home PC
2. Push branch to GitHub via Save-to-GitHub feature  
3. (Optional) Open a PR on Micron2005/Alfred-ai for review
