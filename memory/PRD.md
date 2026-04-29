# Alfred AI — PRD

## Original problem statement
> "Are you able to go through this repo and fix any bugs you see? I want to be able to have this as an app I can download on my phone or a Raspberry Pi 5… I want hand tracking improved, facial expression tracking, body movement tracking for martial arts / workout coaching, facial recognition, and the main HUD display to be more 3 dimensional."
> Repo: https://github.com/Micron2005/Alfred-ai

Subsequent feature requests:
- 3D glass-translucent orb on the HUD.
- Multi-tab layout (HUD / CHAT / WORKOUT / DESIGN) with two-hand swipe gesture.
- Built-from-scratch CAD studio for 3D-printer modelling (Creality K1 Max).
- Smoother voice + hands-free voice by default.
- **(Feb 2026)** JARVIS-style HUD polish (title block, ops log, system status, greeting card).
- **(Feb 2026)** Full-screen Chat tab — no HUD bleed-through.
- **(Feb 2026 v1)** Holographic Earth on the HUD — click a point and zoom into a detail view; pinch-zoom + finger drag.
- **(Feb 2026 v2)** Earth = Google-Earth-style: real continents, holographic; satellite imagery in the zoom-in detail view; Earth floats frameless like the main orb. Dedicated **WORKOUT** tab. Face-recognition only when camera is on AND a face is seen. Voice apologises ("I didn't catch that, sir.") instead of showing raw errors / hallucinated transcripts.

## Architecture
- **alfred-core** (FastAPI + SQLAlchemy + pgvector + Postgres) — chat, memory, voice, Spotify, weather, vision
- **alfred-web** (Next.js 15 + React 19) — JARVIS HUD with hand/face/pose tracking, 3D orb, holographic Earth, CAD studio
- **External**: Ollama (local LLM), Anthropic API (cloud fallback), MediaPipe (browser-side CV), Esri World Imagery + Nominatim (map tiles + geocoding)
- Container: Docker Compose, deployable behind Tailscale

## Persona
Single user — Mukarram Mohammad Alam. Alfred is a dry, witty British butler with strength-and-conditioning expertise.

## Core requirements (static)
- Self-hosted; runs on home PC (eventually Raspberry Pi 5)
- Privacy-respecting (CV happens client-side; LLM can be local)
- Persona-consistent across all surfaces (chat, voice, vision)

## What's been implemented (Feb 2026 fork — combined sessions)

### JARVIS HUD polish
- ✅ **TitleBlock** — bordered ALFRED wordmark with corner notches
- ✅ **GreetingCard** — framed "At your service, sir." card under the orb
- ✅ **SystemStatus pill** (top-right) — System / Wake / Voice / Camera / Hands / Memory rows with colour-coded dots
- ✅ **OperationsLog** (bottom-left) — timestamped activity feed (BOOT / STANDBY / LISTENING / PROCESSING / TRANSMITTING / CAMERA ONLINE / etc.) with auto-deduping
- ✅ HudFrame corner brackets

### Tabs (4-tab layout)
- ✅ **HUD** — orb + title + greeting + Earth + Spotify + clock + weather + camera/face widgets when relevant
- ✅ **CHAT** — full-screen `ChatTabView` with narrow left rail (CHAT/ARCHIVES/MEMORY) + flex:1 chat pane. No HUD bleed.
- ✅ **WORKOUT** — dedicated `WorkoutTabView`: header + camera preview (or "CAMERA OFFLINE" placeholder) + form-coach widget. Camera toggle right in the header.
- ✅ **DESIGN** — existing CAD studio (unchanged this session)
- ✅ Two-hand-swipe gesture wraps across all 4 tabs

### Holographic Earth (Google-Earth-style)
- ✅ **HolographicEarth.tsx** — R3F sphere with NASA Blue Marble texture, custom hologram shader (cyan-tinted luminance ramp + fresnel rim glow + scanlines), atmosphere halo, starfield, drag-rotate, pinch/scroll zoom, click-to-pick-coords. Initial rotation set to face Africa/Europe so the user sees a continent-rich hemisphere on first paint.
- ✅ **Frame-less** — globe floats like the main orb; header is just text, no card panel
- ✅ **HoloMapView.tsx** — full-screen Leaflet detail view using **Esri World Imagery** (satellite) + Esri reference labels overlay. CSS `hue-rotate(165deg) saturate(1.6) brightness(0.78) contrast(1.18)` gives the satellite imagery a JARVIS-cyan hologram look. Native pan/pinch zoom + click-to-drop-pin + Nominatim place search + CLOSE button.
- ✅ **EarthHologramWidget.tsx** lazy-loads three.js + leaflet so they don't bloat the initial bundle.

### Face recognition — anti-glitch + conditional rendering
- ✅ Pose normalization (rotates landmarks to canonical horizontal eye-line) → match invariant to head roll
- ✅ Stable-landmark subset (skull bony points; mouth corners/cheeks dropped)
- ✅ Temporal EMA smoothing (alpha=0.7) on the 96-D identity vector
- ✅ Sticky matching — requires 2 consecutive identify polls to agree before switching identity
- ✅ Identify polling tightened from 2.5s → 1.5s
- ✅ **Only renders on the HUD when camera is on AND a live face is detected** (no more empty face panel pinned to the bottom of the screen)

### Voice — friendly apology
- ✅ Composer detects Whisper hallucinations (regex match against known stock phrases: "Thanks for watching", "Please subscribe", "[Music]", standalone punctuation, ≤2-char transcripts) and treats them as "didn't catch that"
- ✅ All transcription failures (no audio / no words / hallucination / network error) bubble up via new `onUnclear` callback
- ✅ ChatWindow wires `onUnclear` to Alfred's TTS — when voice-out is on, Alfred verbally says "Apologies, sir — I didn't quite catch that. Could you say it again?" instead of showing a raw error banner or letting fabricated text reach the chat
- ✅ Dedupe: at most one apology per 4 seconds

## Implementation lives on branch
`feature/holistic-tracking-3d-hud` (committed locally; user pushes via **Save to GitHub**, then `git pull` on home PC and `docker compose up --build`).

## Prioritized backlog (P0 / P1 / P2)

### P0 — for next session
- ⏳ User pulls Feb 2026 changes locally and tests on real hardware (camera + mic + Docker stack)
- ⏳ Validate the holographic Earth pinch-zoom on touch devices
- ⏳ Tune form-coach heuristics with real footage (workout tab now ready)

### P1 — feature follow-ups
- ⏳ **Hand-driven gestures for the holographic Earth** — one-finger pinch+drag to rotate, two-hand pinch to zoom in/out (existing MediaPipe state needs a global bridge to reach the lazy R3F component)
- ⏳ **3D fly-down on click**: instead of opening the 2D Leaflet map, animate the camera down toward the picked lat/lon on the same R3F globe, switching to high-res tile imagery as it gets closer (true Google-Earth flyover)
- ⏳ Replace 96-D geometric face vector with a learned face embedding (face-api.js 128-D or backend `insightface` 512-D ArcFace) — DB migration required
- ⏳ Continue **CAD Studio Phase A** — 2D sketch → extrude + Boolean ops via `three-bvh-csg`
- ⏳ Hand-driven CAD object manipulation
- ⏳ Direct .gcode upload to Creality K1 Max from Design tab
- ⏳ Martial-arts move library (jab, cross, hook, kick) with rep-counting
- ⏳ Pose-driven gesture controls (T-pose to take a screenshot, etc.)

### P2 — bigger
- ⏳ Continent outline / GeoJSON overlay on the Earth surface (CC-licensed NaturalEarth)
- ⏳ Live ISS / satellite tracking arcs
- ⏳ Persistent pin annotations on the map (Alfred remembers places)
- ⏳ Subdivision + sculpt brushes (CAD)
- ⏳ Chat-driven CAD ("add a 50mm cube")
- ⏳ Pen pressure (PointerEvent.pressure)
- ⏳ PWA install (separate `devin/1777334990-pwa-install` branch)
- ⏳ Raspberry Pi 5 deployment guide
- ⏳ Native mobile app (Capacitor)
- ⏳ Workout history & progress tracking

## Key files (Feb 2026 additions)
- `/app/alfred-web/src/components/TitleBlock.tsx`
- `/app/alfred-web/src/components/GreetingCard.tsx`
- `/app/alfred-web/src/components/SystemStatus.tsx`
- `/app/alfred-web/src/components/OperationsLog.tsx`
- `/app/alfred-web/src/components/ChatTabView.tsx`
- `/app/alfred-web/src/components/WorkoutTabView.tsx`
- `/app/alfred-web/src/components/HolographicEarth.tsx` (textured Earth + hologram shader)
- `/app/alfred-web/src/components/HoloMapView.tsx` (Esri satellite + cyan tint)
- `/app/alfred-web/src/components/EarthHologramWidget.tsx` (frame-less)
- `/app/alfred-web/src/components/Composer.tsx` (hallucination filter, onUnclear)
- `/app/alfred-web/src/components/ChatWindow.tsx` (orchestration, conditional widgets, voice apology)
- `/app/alfred-web/src/lib/tabs.ts` (4-tab union type)
- `/app/alfred-web/src/lib/useFaceTracking.ts` (pose-normalisation + EMA smoothing)
