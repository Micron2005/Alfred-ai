# Alfred AI — PRD

## Original problem statement
> "Are you able to go through this repo and fix any bugs you see? I want to be able to have this as an app I can download on my phone or a Raspberry Pi 5. I dont have a pi 5 right now but eventually I will. I want the hand tracking improved. I want it to be able to track my facial expressions as well. I will also want it to track my body movement so I can have it help me practice martial arts, or help fix my form for any workout I need help on. and can give me workouts based on anything I ask it or for what my form is and to better it. I also want it to have facial recognition. I also want the main hud display to be more 3 dimensional"
> Repo: https://github.com/Micron2005/Alfred-ai

Subsequent feature requests:
- 3D glass-translucent orb on the HUD.
- 3-tab layout (HUD / CHAT / DESIGN) with two-hand swipe gesture.
- Built-from-scratch CAD studio for 3D-printer modelling (Creality K1 Max).
- Smoother voice + hands-free voice by default.
- **(Feb 2026)** JARVIS-style HUD polish (title block, ops log, system status, greeting card).
- **(Feb 2026)** Full-screen Chat tab — no HUD bleed-through.
- **(Feb 2026)** Holographic Earth on the HUD — click a point and zoom into a Google-Maps-style detail view; pinch-zoom + finger drag.

## Architecture
- **alfred-core** (FastAPI + SQLAlchemy + pgvector + Postgres) — chat, memory, voice, Spotify, weather, vision
- **alfred-web** (Next.js 15 + React 19) — JARVIS HUD with hand tracking, face tracking, pose tracking, 3D orb, holographic Earth, CAD studio
- **External**: Ollama (local LLM), Anthropic API (cloud fallback), MediaPipe (browser-side CV), OpenStreetMap (map tiles)
- Container: Docker Compose, deployable behind Tailscale

## Persona
Single user — Mukarram Mohammad Alam. Alfred is a dry, witty British butler with strength-and-conditioning expertise.

## Core requirements (static)
- Self-hosted; runs on home PC (eventually Raspberry Pi 5)
- Privacy-respecting (CV happens client-side; LLM can be local)
- Persona-consistent across all surfaces (chat, voice, vision)

## What's been implemented (Feb 2026 session — fork)

### JARVIS HUD polish
- ✅ **TitleBlock** — bordered ALFRED wordmark with corner notches, replaces flat header on HUD tab
- ✅ **GreetingCard** — framed "At your service, sir." card under the orb
- ✅ **SystemStatus pill** (top-right) — vertical indicator stack: System / Wake / Voice / Camera / Hands / Memory with green/amber/red/grey dots
- ✅ **OperationsLog** (bottom-left) — timestamped activity feed (BOOT, STANDBY, LISTENING, PROCESSING, TRANSMITTING, CAMERA ONLINE, etc.) with auto-deduping
- ✅ **HudFrame corner brackets** still pinned to viewport corners, tightened to match new title-block stroke

### Chat tab — fixed
- ✅ Created `ChatTabView` with **dedicated full-screen layout**: narrow conversation-list rail (CHAT / ARCHIVES / MEMORY tabs + new conversation button + list) + chat pane filling remaining width
- ✅ HUD pane is hidden via `display:none` on chat tab — no more "chat squeezed into 440px sidebar with HUD bleeding to the right"
- ✅ Memory tab still works inside the rail

### Holographic Earth (NEW)
- ✅ **HolographicEarth.tsx** — R3F 3D globe: wireframe sphere, latitude rings (equator + tropics + arctic/antarctic), glow halo, starfield, drag-rotate, scroll/pinch zoom, click-to-pick coordinates, auto-rotate when idle
- ✅ **HoloMapView.tsx** — full-screen Leaflet + OpenStreetMap detail view with cyan-tinted hologram CSS filter, pan/pinch zoom (native), Nominatim place search, click-to-drop-pin, coords readout, CLOSE button
- ✅ **EarthHologramWidget.tsx** — JARVIS-framed container; both heavy bundles (three.js, leaflet) lazy-loaded
- ✅ Globe click → map opens centered on that lat/lon with marker

### Facial recognition — anti-glitch
- ✅ Pose normalization (rotates landmarks to canonical horizontal eye-line) → match invariant to head roll
- ✅ Stable-landmark subset (skull bony points; dropped mouth corners + cheek soft tissue that move with expressions)
- ✅ Temporal EMA smoothing (alpha=0.7) on the 96-D identity vector → reduces frame-to-frame jitter
- ✅ Sticky matching in `FaceRecognitionWidget` — requires 2 consecutive identify polls to agree before switching the displayed identity (kills single-frame flicker)
- ✅ Identify polling tightened from 2.5s → 1.5s (smoother feel; sticky vote prevents new noise)

## Implementation lives on branch
`feature/holistic-tracking-3d-hud` + uncommitted Feb 2026 changes (HUD polish, full-screen chat, hologram earth).
User runs locally via `docker compose up --build`. Push to GitHub via the **Save to GitHub** button.

## Prioritized backlog (P0 / P1 / P2)

### P0 — for next session
- ⏳ Verify `docker compose up --build` succeeds on user's home PC with Feb 2026 changes (Leaflet + new components)
- ⏳ User-test the holographic Earth pinch-zoom on touch devices
- ⏳ Tune the form-coach heuristics with real footage
- ⏳ Adjust face-identity threshold once 2-3 family members are enrolled (likely 0.94-0.96)

### P1 — feature follow-ups
- ⏳ **Hand-driven gestures for the holographic Earth** — one-finger drag to rotate, two-hand pinch to zoom (existing MediaPipe hand state needs a global bridge to reach the lazy R3F component)
- ⏳ Replace 96-D geometric identity vector with a learned face embedding (`@vladmandic/face-api` 128-D or backend `insightface` 512-D ArcFace) — DB migration required (`FACE_IDENTITY_DIM` change)
- ⏳ **CAD Studio Phase A** — 2D sketch → extrude + Boolean ops (union/subtract/intersect) via `three-bvh-csg`
- ⏳ Hand-driven CAD object manipulation (existing pinch gesture)
- ⏳ Reference image background for CAD viewport (drop image, model against it)
- ⏳ Direct .gcode upload to Creality K1 Max from Design tab
- ⏳ Martial-arts move library (jab, cross, hook, kick) with target joint sequences for rep-counting
- ⏳ Pose-driven gesture controls (T-pose to take a screenshot, hands-up to pause)
- ⏳ Voice synthesis of form cues (Alfred speaks corrections)

### P2 — bigger
- ⏳ Continent outlines / geo data overlay on the holographic Earth (NaturalEarth low-res GeoJSON)
- ⏳ Live ISS / satellite tracking arcs on the holographic Earth
- ⏳ Persistent pin annotations on the map (Alfred remembers places you've asked about)
- ⏳ Subdivision surface modifier + sculpt brushes (push/pull/inflate)
- ⏳ Chat-driven CAD ("add a 50mm cube")
- ⏳ Pen pressure support (PointerEvent.pressure)
- ⏳ PWA install (separate `devin/1777334990-pwa-install` branch — merge when ready)
- ⏳ Raspberry Pi 5 deployment guide (ARM64 Docker images, ONNX-runtime CV models)
- ⏳ Native mobile app (Capacitor wrapper)
- ⏳ Workout history & progress tracking (new DB table, weekly summary widget)

## Next tasks
1. **Run testing agent** to validate the full Feb 2026 frontend flow.
2. User pulls + rebuilds locally, validates the holographic Earth on touch / desktop.
3. Wire hand-gesture control into the Earth (P1).
4. Push to GitHub via Save-to-GitHub.

## Key files (Feb 2026 additions)
- `/app/alfred-web/src/components/TitleBlock.tsx`
- `/app/alfred-web/src/components/GreetingCard.tsx`
- `/app/alfred-web/src/components/SystemStatus.tsx`
- `/app/alfred-web/src/components/OperationsLog.tsx`
- `/app/alfred-web/src/components/ChatTabView.tsx`
- `/app/alfred-web/src/components/HolographicEarth.tsx`
- `/app/alfred-web/src/components/HoloMapView.tsx`
- `/app/alfred-web/src/components/EarthHologramWidget.tsx`
- `/app/alfred-web/src/lib/useFaceTracking.ts` (pose-normalisation + EMA smoothing)
- `/app/alfred-web/src/components/FaceRecognitionWidget.tsx` (sticky matching)
