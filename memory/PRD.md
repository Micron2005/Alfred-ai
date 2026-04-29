# Alfred AI — PRD

## Original problem statement
Local-first JARVIS-style personal assistant. User wants improved hand/face/body tracking, facial recognition, a 3D HUD, runs locally in Docker (eventually on Pi 5).
Repo: https://github.com/Micron2005/Alfred-ai

## Architecture
- **alfred-core** (FastAPI + Postgres + pgvector)
- **alfred-web** (Next.js 15 + React 19) — JARVIS HUD with hand/face/pose tracking, 3D orb, holographic Earth, CAD studio
- **External**: Ollama, Anthropic, MediaPipe, MapLibre GL + OpenFreeMap (3D vector tiles)
- Docker Compose, deployable behind Tailscale

## Persona
Single user — Mukarram Mohammad Alam. Alfred is a dry, witty British butler.

## What's been implemented (Feb 2026 fork — all sessions, current state)

### HUD layout
- ✅ 4 tabs (HUD / CHAT / WORKOUT / DESIGN)
- ✅ **No ALFRED title block / "At your service" card** — minimal HUD per user request
- ✅ JARVIS HudFrame corner brackets, Operations Log (bottom-left), System Status pill (top-right, now a moveable HudWidget)
- ✅ HUD canvas always mounted; `customEnabled` only toggles drag/resize/hide handles → customizations persist when CUSTOMIZE is off
- ✅ Canvas `overflow: visible` + baseline height 880 → camera widget reachable (was getting clipped before)
- ✅ Default widget positions tightened so they don't overlap on first paint

### Holographic Earth — standalone (NOT a HudWidget)
- ✅ **`FloatingEarth.tsx`** — own free-floating component with a "⠿ EARTH · HOLOGRAM" drag handle at top, **always draggable** regardless of customize mode
- ✅ Position persisted to its own `localStorage` key (`alfred.floatingEarth.v2`)
- ✅ Inside the box: globe is fully interactive at all times (rotate, zoom, click-to-pick) — drag handle is the only move surface so the globe's gesture doesn't fight the move gesture
- ✅ Globe = NASA Blue Marble + custom GLSL hologram shader (cyan luminance ramp, fresnel, scanlines), no starfield
- ✅ EXPAND opens MapLibre 3D fly-over (rendered via `createPortal` to escape canvas transform stacking context — fixes black-screen bug)
- ✅ MapLibre `dark` style + OSM `fill-extrusion` 3D buildings + cyan CSS hologram filter; loading overlay; place search via Nominatim

### Voice — tab switching + speech UX
- ✅ **Voice tab switching** — say "Alfred, go to the workout tab" / "switch to chat" / "open design" / "back to the HUD" and Alfred navigates immediately, bypassing the LLM
- ✅ Lenient natural-language matcher: navigation verb (`go / take me / switch / open / show / navigate / head / jump / move / bring / pull up`) + tab noun (`hud / home / chat / workout / form coach / design / cad / etc.`)
- ✅ Echoed in chat history + spoken acknowledgement ("Switching to the Workout tab, sir.") when voice-out is on
- ✅ Whisper hallucination filter; friendly verbal apology ("Apologies, sir — I didn't quite catch that.") on STT failure with 4 s dedupe

### Tab-swipe gesture — deferred per user
- 🟡 Increased cooldown 900 → 1600 ms + post-swipe band-exit latch wired in, but user requested we move on; voice command is the new primary tab-switch mechanic.

### Face recognition
- ✅ Pose normalisation + EMA smoothing + sticky matching
- ✅ Only renders when camera is on AND face is live

### Workout
- ✅ Dedicated WORKOUT tab with camera preview + form coach (so the HUD stays clean)

### 3D Radial Menu (Feb 2026 — NEW)
- ✅ **Click central JARVIS orb** → curved horizontal carousel overlay appears (Iron Man HUD aesthetic, full-screen)
- ✅ Three carousel orbs: SPOTIFY (audio console), CHAT (conversation), WORKOUT (form coach) — each with bespoke 3D-styled glyph (pulsing equaliser bars / speech bubble / rotating wireframe figure)
- ✅ ESC key + ✕ CLOSE button + backdrop-click all dismiss
- ✅ Voice intent: "Alfred, open the menu" / "show modules" pops the same overlay
- ✅ Selecting CHAT/WORKOUT routes to existing tabs; SPOTIFY opens dedicated 3D sub-view
- ✅ Sub-view takes full HUD space (z-index 8500, opaque radial-gradient backdrop) with its own ← BACK button

### Spotify 3D Audio Console (Feb 2026 — NEW)
- ✅ **`Spotify3DView.tsx`** — full-screen 3D-styled console with pulsing orb visualiser + 32-bar spectrum ring
- ✅ **Real Web Audio EQ** — 3-band (BASS lowshelf 200Hz, MID peaking 1kHz Q=1, TREBLE highshelf 3.5kHz), each ±12 dB
- ✅ Drag-drop / click-to-browse local audio file (mp3/wav/ogg/m4a/flac/aac) → BiquadFilter chain → AnalyserNode → destination
- ✅ PLAY/PAUSE/RESET transport; explicit copy explaining Spotify SDK streams are DRM-protected so EQ runs on local audio (per user choice 4a)

### Chat regex hardening (Feb 2026)
- ✅ `detectTabIntent` rewritten with strict whole-utterance match — "hello", "hi alfred", "what is the weather?", "tell me a joke" all return null and route to chat (verified via node script)
- ✅ NAV_VERB hard-required as the very first token — plain greetings can never be mis-classified as nav commands
- ✅ Trailing `setActiveTabPersisted` syntax bug fixed (function declaration was missing newline → minor parse-time hazard)

## Backlog (P0 / P1 / P2)

### P0 — for next session
- ⏳ User pulls Feb 2026 changes locally (`git pull && docker compose up --build`) and validates HUD layout persistence + Earth dragging + voice tab switching + Earth → 3D map flow on real hardware
- ⏳ Tune the form-coach heuristics with real footage

### P1 — feature follow-ups (carried over)
- ⏳ **Hand-gesture control for the Earth** — one-hand pinch+drag to rotate, two-hand pinch to zoom (existing MediaPipe state needs a global bridge to reach the lazy R3F component); Tony-Stark gesture vibe
- ⏳ **Voice command "Alfred, activate customization"** — wire wake-phrase intent to `hud.setCustomEnabled(true)`
- ⏳ **Both-hand drag/resize gestures** in customize mode (currently mouse/touch only; needs hand-cursor → pointer-event bridge)
- ⏳ **Nightfall protocol auth via face** — admin-face enrollment that gates Nightfall mode; "Alfred, remember my face as admin for nightfall protocol"
- ⏳ **Photorealistic Google-Earth tiles** in `HoloMapView` — Cesium ion (free token) or Google Maps Photorealistic 3D Tiles (API key); plug into the existing tile-source point in `HoloMapView.tsx`
- ⏳ **3D fly-down on click** — animate the R3F camera down toward picked lat/lon on the same canvas instead of opening a separate modal
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
- ⏳ Native mobile app (Capacitor)
- ⏳ Workout history

## Key files (Feb 2026 — current state)
- `/app/alfred-web/src/components/FloatingEarth.tsx` (NEW — standalone draggable Earth)
- `/app/alfred-web/src/components/HolographicEarth.tsx` · `HoloMapView.tsx` · `EarthHologramWidget.tsx`
- `/app/alfred-web/src/components/HudWidget.tsx` (always renders absolute; customEnabled toggles handles only)
- `/app/alfred-web/src/components/SystemStatus.tsx` (now a widget; no fixed position)
- `/app/alfred-web/src/components/Composer.tsx` (hallucination filter, onUnclear)
- `/app/alfred-web/src/components/ChatWindow.tsx` (always-on canvas, voice tab-switch intent matcher in `detectTabIntent`, voice apology, conditional widget visibility, no TitleBlock/GreetingCard)
- `/app/alfred-web/src/components/ChatTabView.tsx` · `WorkoutTabView.tsx`
- `/app/alfred-web/src/lib/tabs.ts` (4-tab union)
- `/app/alfred-web/src/lib/hudLayout.ts` (camera + workout-coach + face-recognition repositioned to top-right; system-status widget; earth-hologram still registered for legacy support but unused)
- `/app/alfred-web/src/lib/useTwoHandSwipe.ts` (cooldown + band-exit latch; deferred per user)
- `/app/alfred-web/src/lib/useFaceTracking.ts` (pose normalise + EMA)
- `/app/alfred-web/package.json` (added `maplibre-gl`)
