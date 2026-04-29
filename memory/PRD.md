# Alfred AI — PRD

## Original problem statement
> Alfred AI: local-first JARVIS-style personal assistant. User wants improved hand/face/body tracking for martial arts coaching, facial recognition, a more 3D HUD, runs locally in Docker (eventually on Pi 5).
> Repo: https://github.com/Micron2005/Alfred-ai

## Latest user feedback (Feb 2026 — late session)
> "internal view when I click into the earth is still more so 2d, I want it like how it is on google earth where you can see the building, you can move around the street… kinda like how tony stark handles jarvis from the iron man… holographic earth to be stand alone and moveable in the customization area… don't care much for the stars around it… globe that I can spin and put anywhere on the hud I want… speech recognition better, runs smoother, if he can't understand he says he didn't understand rather than showing an error or making something up"

## Architecture
- **alfred-core** (FastAPI + SQLAlchemy + pgvector + Postgres) — chat, memory, voice, Spotify, weather, vision
- **alfred-web** (Next.js 15 + React 19) — JARVIS HUD with hand/face/pose tracking, 3D orb, holographic Earth, CAD studio
- **External**: Ollama (local LLM), Anthropic API (cloud fallback), MediaPipe (browser-side CV), **MapLibre GL + OpenFreeMap** (3D vector tiles, no API key)
- Container: Docker Compose, deployable behind Tailscale

## Persona
Single user — Mukarram Mohammad Alam. Alfred is a dry, witty British butler.

## What's been implemented (Feb 2026 fork — combined sessions)

### JARVIS HUD polish
- ✅ TitleBlock (bordered ALFRED wordmark with corner notches)
- ✅ GreetingCard ("At your service, sir." / "Batman" in nightfall mode)
- ✅ SystemStatus pill (top-right) — System / Wake / Voice / Camera / Hands / Memory
- ✅ OperationsLog (bottom-left) — timestamped activity feed with auto-deduping
- ✅ HudFrame corner brackets

### Tabs (4-tab layout: HUD / CHAT / WORKOUT / DESIGN)
- ✅ **HUD** — orb + title + greeting + Earth + Spotify + clock + weather. Face/workout widgets only when camera is on AND face/pose detected
- ✅ **CHAT** — full-screen `ChatTabView` (narrow rail + flex:1 chat pane); no HUD bleed
- ✅ **WORKOUT** — dedicated `WorkoutTabView`: camera preview + form coach
- ✅ **DESIGN** — existing CAD studio
- ✅ Two-hand-swipe gesture wraps across all 4 tabs

### Holographic Earth (final state)
- ✅ **Real Earth surface** — NASA Blue Marble texture sampled in custom GLSL shader with cyan luminance ramp + fresnel rim glow + subtle scanlines + atmosphere halo. Continents fully visible.
- ✅ **No starfield** — clean floating globe per user's preference
- ✅ **Frame-less** — globe floats like the main orb, header is just floating text
- ✅ **Customizable HUD widget** — `earth-hologram` is now registered in `hudLayout.ts`, so the user can move/resize/hide it via CUSTOMIZE mode like Clock, Spotify, etc.
- ✅ Initial Africa/Europe-facing rotation; gentle auto-rotate when idle; drag to rotate; scroll/pinch to zoom; click-to-pick coords
- ✅ **3D fly-over detail view** — clicking a point or pressing EXPAND opens `HoloMapView`, now powered by **MapLibre GL** with OpenFreeMap's free vector tiles (`dark` style) plus a `fill-extrusion` layer that turns OSM building heights into actual 3D blocks. Camera tilted to 60° pitch + cyan CSS hologram filter so the city reads as a Tony-Stark fly-over.
- ✅ Map controls: drag pan, right-drag rotate/tilt, scroll/pinch zoom, NavigationControl, ScaleControl
- ✅ Place search via Nominatim → fly-to with high-zoom + 60° pitch
- ✅ RECENTRE button (snap back to picked spot with full tilt) + CLOSE
- ⏳ For TRUE photorealistic Google-Earth tiles (real building photos), need either Cesium ion token or Google Maps Platform Photorealistic 3D Tiles key — wired-in path described below in P1

### Face recognition — anti-glitch + conditional rendering
- ✅ Pose normalisation (canonical eye-line) — match invariant to head roll
- ✅ Stable-landmark subset (skull bones; mouth/cheeks dropped)
- ✅ EMA smoothing (alpha=0.7) on the 96-D identity vector
- ✅ Sticky matching — needs 2 consecutive identify polls to agree
- ✅ Identify polling tightened 2.5s → 1.5s
- ✅ Only renders when camera ON AND a live face is detected

### Voice — friendly apology
- ✅ Hallucination filter in `Composer` — regex match against known Whisper stock phrases ("Thanks for watching", "[Music]", ≤2-char transcripts, etc.)
- ✅ All STT failures bubble through `onUnclear` callback
- ✅ When voice-out is on, Alfred verbally says "Apologies, sir — I didn't quite catch that. Could you say it again?" instead of raw error banners or fabricated text in chat history
- ✅ Dedupe: at most one apology per 4 seconds

## Prioritized backlog (P0 / P1 / P2)

### P0 — for next session
- ⏳ User pulls Feb 2026 changes locally and tests on real hardware (camera + mic + Docker stack, MapLibre 3D buildings)
- ⏳ Validate the 3D map fly-over on touch devices

### P1 — feature follow-ups
- ⏳ **Photorealistic Google-Earth tiles** in the detail view — swap MapLibre source to Cesium ion's Google Photorealistic 3D Tiles (free Cesium ion token) OR Google Maps Platform's Photorealistic 3D Tiles (Google Maps API key). HoloMapView is structured so we can swap the tile provider in one place.
- ⏳ **Hand-gesture control for the Earth** — one-hand pinch+drag to rotate the globe, two-hand pinch to zoom (existing MediaPipe state needs a global bridge to reach the lazy-loaded R3F component); Tony-Stark gesture vibe
- ⏳ **3D fly-down on click** — animate the R3F camera down toward the picked lat/lon on the same canvas (instead of opening a separate modal), seamless transition into the 3D city view
- ⏳ Replace 96-D geometric face vector with face-api.js 128-D for true robustness
- ⏳ Continue **CAD Studio Phase A** — 2D sketch → extrude + Boolean ops via `three-bvh-csg` (deferred per user)
- ⏳ Hand-driven CAD object manipulation
- ⏳ Direct .gcode upload to Creality K1 Max
- ⏳ Martial-arts move library (jab/cross/hook/kick) with rep counting
- ⏳ Pose-driven gesture controls (T-pose to take a screenshot, etc.)

### P2 — bigger
- ⏳ Continent outline / GeoJSON overlay on the globe
- ⏳ Live ISS / satellite tracking arcs on the globe
- ⏳ Persistent pin annotations on the map
- ⏳ Subdivision + sculpt brushes (CAD)
- ⏳ Chat-driven CAD ("add a 50mm cube")
- ⏳ Pen pressure
- ⏳ PWA install
- ⏳ Pi 5 deployment guide
- ⏳ Native mobile app (Capacitor)
- ⏳ Workout history & progress tracking

## Key files (Feb 2026 additions / changes)
- `/app/alfred-web/src/components/TitleBlock.tsx`
- `/app/alfred-web/src/components/GreetingCard.tsx`
- `/app/alfred-web/src/components/SystemStatus.tsx`
- `/app/alfred-web/src/components/OperationsLog.tsx`
- `/app/alfred-web/src/components/ChatTabView.tsx`
- `/app/alfred-web/src/components/WorkoutTabView.tsx`
- `/app/alfred-web/src/components/HolographicEarth.tsx` — NASA Blue Marble + hologram shader, no stars
- `/app/alfred-web/src/components/HoloMapView.tsx` — MapLibre 3D building extrusions, dark style + cyan filter
- `/app/alfred-web/src/components/EarthHologramWidget.tsx` — frame-less; registered as a moveable HUD widget
- `/app/alfred-web/src/components/Composer.tsx` — Whisper hallucination filter, onUnclear callback
- `/app/alfred-web/src/components/ChatWindow.tsx` — orchestration, conditional widgets, 4-tab routing, voice apology
- `/app/alfred-web/src/lib/tabs.ts` — 4-tab union type
- `/app/alfred-web/src/lib/hudLayout.ts` — `earth-hologram` widget registered (default visible, draggable in CUSTOMIZE mode)
- `/app/alfred-web/src/lib/useFaceTracking.ts` — pose-normalisation + EMA smoothing
- `/app/alfred-web/package.json` — added `maplibre-gl`, removed unused `leaflet`/`react-leaflet`
