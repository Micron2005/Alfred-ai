# Alfred AI — PRD

## Original problem statement
> Alfred AI: local-first JARVIS-style personal assistant. User wants improved hand/face/body tracking for martial arts coaching, facial recognition, a more 3D HUD, runs locally in Docker (eventually on Pi 5).
> Repo: https://github.com/Micron2005/Alfred-ai

## Architecture
- **alfred-core** (FastAPI + SQLAlchemy + pgvector + Postgres)
- **alfred-web** (Next.js 15 + React 19) — JARVIS HUD with hand/face/pose tracking, 3D orb, holographic Earth, CAD studio
- **External**: Ollama, Anthropic, MediaPipe, **MapLibre GL + OpenFreeMap** (3D vector tiles)
- Docker Compose, deployable behind Tailscale

## Persona
Single user — Mukarram Mohammad Alam. Alfred is a dry, witty British butler.

## What's been implemented (Feb 2026 fork — all sessions)

### JARVIS HUD polish
- ✅ TitleBlock, GreetingCard, OperationsLog, HudFrame corner brackets

### 4-tab layout
- ✅ HUD / CHAT / WORKOUT / DESIGN with two-hand swipe
- ✅ Full-screen Chat tab (no HUD bleed)
- ✅ Dedicated Workout tab (camera + form coach)
- ✅ Workout/face widgets only render when camera is on AND data is live

### Holographic Earth
- ✅ NASA Blue Marble texture + custom GLSL hologram shader (cyan luminance ramp + fresnel + scanlines)
- ✅ No starfield (clean floating globe)
- ✅ Frame-less, registered as a moveable HudWidget
- ✅ MapLibre GL detail view with OpenFreeMap dark vector tiles + 3D building extrusions; camera tilted 60°; place search via Nominatim; **rendered via React portal so the modal escapes the canvas's transform stacking context** (fixes "click into Earth shows black screen behind HUD overlays")
- ✅ Loading overlay ("INITIALISING 3D MAP …") + error banner

### HUD customization (Feb 2026 — late session)
- ✅ **Customizations now persist** when toggling CUSTOMIZE off — the canvas is always mounted; `customEnabled` only toggles drag/resize/hide handles
- ✅ **SystemStatus pill is now a moveable HudWidget** (`system-status` in `hudLayout`)
- ✅ Default layout positions tightened so widgets don't overlap on first paint
- ✅ All widgets (clock, weather, orb, spotify, camera, workout, face-recognition, earth, system-status) registered + persisted to localStorage

### Voice & speech
- ✅ Hallucination filter in Composer (regex match against Whisper stock phrases)
- ✅ Friendly apology — Alfred speaks "Apologies, sir — I didn't quite catch that. Could you say it again?" via TTS instead of raw error banners
- ✅ Dedupe: 4-second cooldown on apologies

### Face recognition
- ✅ Pose normalisation + EMA smoothing + sticky matching
- ✅ Only renders when camera is on AND face is live

### Tab swipe
- ✅ Cooldown bumped 900ms → 1600ms
- ✅ Post-swipe "exit band required" latch — both hands must leave the central detection band before a new swipe arms (prevents the return-swing from triggering a counter-swipe)

## Backlog (P0 / P1 / P2)

### P0 — for next session
- ⏳ User pulls Feb 2026 changes locally and tests on real hardware
- ⏳ Confirm HUD layout persistence + tab swipe + Earth → 3D map flow on user's local Docker build
- ⏳ Tune the form-coach heuristics with real footage

### P1 — feature follow-ups (user-requested, partially deferred)
- ⏳ **Hand-gesture control for the Earth** — one-hand pinch+drag to rotate, two-hand pinch to zoom (existing MediaPipe hand state needs a global bridge to reach the lazy R3F component); Tony-Stark gesture vibe
- ⏳ **Voice command "Alfred, activate customization"** — wire a wake-phrase intent to `hud.setCustomEnabled(true)` so the user can enter customize mode hands-free
- ⏳ **Both-hand drag/resize gestures** on widgets in customize mode (currently mouse/touch only; needs hand-cursor → pointer-event bridge)
- ⏳ **Nightfall protocol auth** — admin-face enrollment that gates Nightfall mode: only the registered admin face can flip the protocol; "Alfred, remember my face as admin for nightfall protocol" command
- ⏳ **Photorealistic Google-Earth tiles** in the detail view — Cesium ion (free token) or Google Maps Platform Photorealistic 3D Tiles (API key) — `HoloMapView.tsx` is set up so we can swap the tile provider in one place
- ⏳ **3D fly-down on click** — animate the R3F camera into the city view on the same canvas instead of opening a separate modal
- ⏳ Replace 96-D geometric face vector with face-api.js 128-D
- ⏳ CAD Studio Phase A (deferred per user)
- ⏳ Direct .gcode upload to Creality K1 Max
- ⏳ Martial-arts move library + rep counting

### P2 — bigger
- ⏳ Continent outlines / GeoJSON overlay on the Earth
- ⏳ Live ISS / satellite tracking arcs
- ⏳ Persistent pin annotations on the map
- ⏳ Subdivision + sculpt brushes (CAD)
- ⏳ Chat-driven CAD
- ⏳ PWA install
- ⏳ Pi 5 deployment guide
- ⏳ Native mobile app
- ⏳ Workout history & progress tracking

## Key files (Feb 2026 additions / changes)
- `/app/alfred-web/src/components/TitleBlock.tsx` · `GreetingCard.tsx` · `SystemStatus.tsx` (now widget) · `OperationsLog.tsx`
- `/app/alfred-web/src/components/ChatTabView.tsx` · `WorkoutTabView.tsx`
- `/app/alfred-web/src/components/HolographicEarth.tsx` (textured + shader, no stars)
- `/app/alfred-web/src/components/HoloMapView.tsx` (MapLibre 3D + loading overlay + portal-rendered)
- `/app/alfred-web/src/components/EarthHologramWidget.tsx` (uses `createPortal` so the modal escapes canvas transforms)
- `/app/alfred-web/src/components/HudWidget.tsx` (always renders absolute; customEnabled now only toggles handles)
- `/app/alfred-web/src/components/Composer.tsx` (hallucination filter, onUnclear)
- `/app/alfred-web/src/components/ChatWindow.tsx` (always-on canvas, voice apology, conditional widget visibility)
- `/app/alfred-web/src/lib/tabs.ts` (4-tab union)
- `/app/alfred-web/src/lib/hudLayout.ts` (`earth-hologram`, `system-status`, tightened defaults)
- `/app/alfred-web/src/lib/useTwoHandSwipe.ts` (longer cooldown, post-swipe band-exit latch)
- `/app/alfred-web/src/lib/useFaceTracking.ts` (pose normalise + EMA)
- `/app/alfred-web/package.json` (added `maplibre-gl`)
