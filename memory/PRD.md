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

### Spotify 3D View — REAL Spotify library (Feb 2026 — NEW, this session)
- ✅ **`Spotify3DView.tsx` rebuilt from scratch.** The old local-file uploader + 3-band EQ has been retired (DRM blocks EQ on streamed audio anyway, and the user explicitly didn't want to download/upload songs). The view is now a full Spotify browser:
  - LEFT half: pulsing JARVIS orb visualiser with album art at its heart, now-playing caption beneath, transport controls (⏮ ⏯ ⏭) floating below the orb
  - RIGHT half: tabbed browser — PLAYLISTS (50 newest, click → tracks slide in) + SEARCH (debounced 350 ms, catalog-wide). Click any track → plays via `/api/spotify/play` on the active device
  - OAuth Connect button when not linked, distinct messaging for unconfigured / not-linked states
  - Premium-required errors caught and shown as a friendly hint instead of a stack trace
- ✅ **3 new backend endpoints** (`alfred-core/src/alfred_core/api/spotify.py`):
  - `GET /api/spotify/playlists?limit=&offset=` — user's playlists (id, name, image, track_count, owner)
  - `GET /api/spotify/playlists/{id}/tracks?limit=&offset=` — track list inside a playlist (slim `fields=` projection so payloads stay <50 KB)
  - `GET /api/spotify/search?q=&limit=` — multi-result catalog search (existing `search_track` was 1-result for the chat tool; this is the multi-result UI counterpart)
- ✅ **3 new SpotifyClient methods** (`alfred-core/src/alfred_core/tools/spotify.py`): `list_playlists`, `list_playlist_tracks`, `search_tracks`. All use a shared `_compact_track` static helper that picks the smallest image (≈64 px so the SVG ring stays snappy), joins artist names, and marks local-file tracks `is_playable: false` so the UI greys them out instead of trying to play unplayable URIs
- ✅ **8 new pytest cases** (`tests/test_spotify_browser.py`): _compact_track image picking, local-file unplayability flag, missing-fields tolerance, non-dict tolerance, empty-query short-circuit, route registration. **Total backend tests: 235 passing.**
- ✅ **Frontend client helpers** in `lib/spotify.ts`: `listSpotifyPlaylists`, `listSpotifyPlaylistTracks`, `searchSpotifyTracks`, `playSpotifyUri`. The existing `SpotifyPlayer` HUD widget continues to handle the Web Playback SDK + transport controls; the 3D view delegates playback through the same `/api/spotify/play` so transport stays consistent across all surfaces (HUD widget, 3D view, voice command).

### Wake-word "swallow" bug fixed (Feb 2026 — NEW, this session)
- ✅ **Root cause**: `playWakeCue()` was called in `ChatWindow.tsx`'s `onWake` handler but **was never imported or defined**. Result: every wake-word fire threw a `ReferenceError` inside the openWakeWord engine's detect listener BEFORE the next line (`ref?.startVoice()`) could run. The wake word detected "hey alfred" successfully but the speech that followed was never recorded.
- ✅ **Fix**: created `alfred-web/src/lib/wakeCue.ts` — a proper Web Audio E5→A5 ping (one-shot, ≤350 ms, AudioContext closed immediately after to stay under the per-tab AC budget). Wired into `ChatWindow.tsx`. **Wrapped both `playWakeCue()` and `ref?.startVoice()` in independent try/catch blocks** so a future bug in one branch can never again kill the other — a missing-ref scenario now resumes the wake-word engine instead of leaving it paused forever.
- ✅ Bumped `silenceDetector.ts` warmup window 500 ms → 900 ms so the wake cue beep doesn't bleed into the start of the user's utterance.


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

### 3D Radial Menu (Feb 2026 — NEW, verified iteration_3 ~92%)
- ✅ **Click central JARVIS orb** → curved horizontal carousel overlay appears (Iron Man HUD aesthetic, full-screen)
- ✅ Three carousel orbs: SPOTIFY (audio console), CHAT (conversation), WORKOUT (form coach) — each with bespoke 3D-styled glyph (pulsing equaliser bars / speech bubble / rotating wireframe figure)
- ✅ ESC key + ✕ CLOSE button + backdrop-click all dismiss
- ✅ Voice intent: "Alfred, open the menu" / "show modules" pops the same overlay
- ✅ Selecting CHAT/WORKOUT routes to existing tabs; SPOTIFY opens dedicated 3D sub-view
- ✅ Sub-view takes full HUD space (z-index 8500, opaque radial-gradient backdrop) with its own ← BACK button
- ✅ **HudWidget.tsx fix**: zIndex prop is now applied in BOTH custom-edit and read-only render paths, so orb (z=12) sits above FloatingEarth (z=8) and is real-mouse-clickable (was the iteration_2 critical regression)

### Spotify 3D Audio Console (Feb 2026 — NEW)
- ✅ **`Spotify3DView.tsx`** — full-screen 3D-styled console with pulsing orb visualiser + 32-bar spectrum ring
- ✅ **Real Web Audio EQ** — 3-band (BASS lowshelf 200Hz, MID peaking 1kHz Q=1, TREBLE highshelf 3.5kHz), each ±12 dB
- ✅ Drag-drop / click-to-browse local audio file (mp3/wav/ogg/m4a/flac/aac) → BiquadFilter chain → AnalyserNode → destination
- ✅ PLAY/PAUSE/RESET transport; explicit copy explaining Spotify SDK streams are DRM-protected so EQ runs on local audio (per user choice 4a)

### Chat regex hardening (Feb 2026)
- ✅ `detectTabIntent` rewritten with strict whole-utterance match — "hello", "hi alfred", "what is the weather?", "tell me a joke" all return null and route to chat (verified via node script)
- ✅ NAV_VERB hard-required as the very first token — plain greetings can never be mis-classified as nav commands
- ✅ Trailing `setActiveTabPersisted` syntax bug fixed (function declaration was missing newline → minor parse-time hazard)

### LLM 502 ReadTimeout fix (Feb 2026 — NEW)
**Symptom:** "Alfred is unreachable: 502 — LLM backend failed: ReadTimeout" on every greeting ("hello"/"hello alfred") and every Nightfall message, even though other prompts worked. Root cause was the local Ollama (Llama 3.1 8B) looping forever on the long multi-tool persona prompt, never returning before the 120 s timeout.
- ✅ **`alfred-core/src/alfred_core/llm/local.py`** — added `num_predict: 1024` (hard cap on generated tokens) + `repeat_penalty: 1.15` (discourage exact-token loops). Lowered HTTP timeout 120 s → 90 s so failures fail fast.
- ✅ **`alfred-core/src/alfred_core/router.py`** — `Router.complete()` now catches `httpx.TimeoutException` / `HTTPError` / `HTTPStatusError` from the local backend and **transparently falls back to the cloud Anthropic backend** when one is configured. Logs the original failure as a warning so it shows up in `docker compose logs`.
- ✅ **`alfred-core/tests/test_router.py`** — 4 new tests pin: (a) read-timeout falls back to cloud, (b) 5xx falls back to cloud, (c) propagates when no cloud is wired, (d) doesn't loop back to local when cloud itself fails. All 117 LLM/router tests still pass.

## Backlog (P0 / P1 / P2)

### Feb 2026 — Self-care suite (NEW)

**Nightfall persistence fix**
- ✅ `PATCH /api/conversations/{id}/mode` endpoint persists mode flips done from the frontend's voice intent (canned ack path bypassed the chat handler before, so the next ordinary message would read the OLD persisted mode and silently flip the persona back — that's why every message in Nightfall mode was flipping it off).
- ✅ Brand-new conversations (no `convoId` yet) skip the canned ack and fall through to the chat handler, whose wake analyzer activates Nightfall and persists it as part of normal flow.
- ✅ `setConversationMode(id, mode)` client added to `lib/api.ts`.

**Uncensored local LLM swap**
- ✅ `config.py` default `local_model_chat` is now `dolphin-llama3:8b-v2.9-q4_K_M` (uncensored Llama derivative). User pulls with `ollama pull dolphin-llama3:8b-v2.9-q4_K_M` on the host. Same RAM footprint as the previous default.
- ✅ Persona prompt (both Standard and Nightfall) now contains an explicit **NO FILTER, NO NANNY** block: profanity, dark humour, edgy emails, disreputable-but-legal searches all permitted; only declines on real harm to real people.

**Vitals self-diagnostics**
- ✅ `GET /api/vitals` aggregates checks for: Local LLM (Ollama reachable + model pulled), Cloud LLM, Database, Web search (Tavily), Email (Gmail), Spotify, 3D printer.
- ✅ Each vital returns `{id, label, status (ok/warn/err/off), detail, fix}` so the UI can show the user a one-line repair instruction.
- ✅ `VitalsPanel.tsx` widget pinned top-right of HUD, polls every 30 s, click-to-expand for fix details.

**Workshop self-coding console**
- ✅ `GET /api/workshop/files` lists all source files in the allowlist (`alfred-core/src`, `alfred-core/tests`, `alfred-web/src`, `docs`, `scripts`).
- ✅ `GET /api/workshop/file?path=...` reads a single file (200 KB cap, UTF-8 only, path-traversal refused, allowlist enforced).
- ✅ `POST /api/workshop/diagnose` sends user problem + chosen file contents to the LLM (Claude when configured for code, else local fallback) → returns explanation + unified diff.
- ✅ `POST /api/workshop/apply` runs `git apply --check` then `git apply` on the diff, restricted to allowlisted paths and refusing to write `.env` / `.env.local`.
- ✅ 4th radial-menu orb **WORKSHOP** (cog glyph, animated) lands in the curved carousel.
- ✅ `WorkshopView.tsx` full-screen sub-view: file picker (left rail) + problem textarea + DIAGNOSE / APPLY PATCH buttons + scrollable diagnosis panel.

**Update script**
- ✅ `scripts/alfred-update.sh` — git pull → docker compose up -d --build → wait for backend → run vitals. One-liner for the user every time he wants to grab the latest fixes.

### Feb 2026 — Auth + Smarter search + Self-healing (NEW)

**Single-user password gate** (P1 done)
- ✅ `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`, `POST /api/auth/refresh`, `POST /api/auth/change`
- ✅ httpOnly cookies (`alfred_access` 60 min + `alfred_refresh` 30 days), HS256 JWT, brute-force lockout (5 fails → 15 min from same IP)
- ✅ Opt-in via `ALFRED_PASSWORD_HASH` in .env — when unset, gate is OFF and existing deployments keep working unchanged
- ✅ `Settings.has_auth` raises if hash is set but JWT secret is still the placeholder (footgun guard)
- ✅ All `/api/*` routers gated except `/api/health` and `/api/auth/*`
- ✅ CORS hardened — `ALFRED_FRONTEND_ORIGIN` env replaces the wildcard so credentialled cookies actually flow
- ✅ Frontend: `AuthProvider` + `LoginGate` JARVIS-styled login screen (auto-skipped when backend reports `auth_enabled: false`)
- ✅ `bcrypt` + `pyjwt` added to pyproject.toml dependencies
- ✅ 10 new auth tests (`tests/test_auth.py`) — 66 backend tests pass total

**Smarter web-search persona** (P1 done)
- ✅ Added "FIND ME X" block to `SEARCH_TOOL_PROMPT` — "find me X" / "look up X" / "any good X on Amazon" / "best YouTube tutorial for X" → ALWAYS emit a `[SEARCH:]` marker
- ✅ Reply must include actual links (YouTube `youtube.com/watch?v=` or `youtu.be/`, Amazon `amazon.com/dp/`) bulleted with one-line descriptions
- ✅ Top-3 ranking + offer to narrow further, no lectures about whether the user "really needs" it

**Self-healing Vitals → Workshop handoff** (P2 done)
- ✅ When a vital is `err` or `warn`, an "🔧 ASK ALFRED TO FIX" button appears in its expanded detail panel
- ✅ Clicking it routes to the Workshop sub-view with the problem statement + 2-3 candidate files (per-subsystem allowlist) pre-populated, ready to DIAGNOSE
- ✅ One-click handoff: red light → diagnose → patch → apply

**Vitals UX polish (Feb 2026)**
- ✅ Vitals is now a real `HudWidget` — registered in `hudLayout.ts` as `vitals` with default position `(1160, 280)` (under SystemStatus, top-right). User can drag/resize/hide it like any other widget via 🎛 CUSTOMIZE.
- ✅ When the backend is unreachable (preview, container down, network issue), the panel shows soft italic "backend offline · retrying every 30 s" instead of a harsh red 404 banner. Easier on the eyes when the backend is intentionally not running.

**Workshop end-to-end test coverage** (Feb 2026)
- ✅ `tests/test_workshop.py` (19 tests, all passing): list-files allowlist, file read with traversal/absolute/.env refusal, DIAGNOSE prompt construction, full APPLY → file-on-disk-changed roundtrip, refusal of out-of-allowlist diffs, refusal of `.env` writes, partial-write prevention.
- ✅ Plus the **commit-push test suite**: clean-tree status, dirty-files-outside-allowlist surfacing, full COMMIT → PUSH-to-bare-remote with Alfred authorship verified in remote's git log, .env left untouched in working tree, empty-message refusal, clean-tree refusal, skip_push local-only commit, push-failure-without-losing-local-commit.
- ✅ `tests/test_vitals.py` (5 tests): off-by-default state, ollama ok / missing-model warn / unreachable err, cloud-configured ok.
- ✅ Total backend tests: **96 passing**.

### Feb 2026 — Auto-commit + push, hands-free voice fix (NEW)

**Self-coding now ships to git** (P2 done)
- ✅ `GET /api/workshop/git-status` — branch, remote URL, ahead/behind, dirty files, dirty-files-outside-allowlist (so the UI can warn the user that .env / secrets are deliberately being skipped).
- ✅ `POST /api/workshop/commit-push` — body `{message, skip_push?, author_name?, author_email?}`. Stages ONLY allowlisted files (.env / secret.txt / out-of-tree changes are never swept up), commits as Alfred, pushes to `origin/HEAD`. On push failure: local commit is preserved + the response carries git's exact error so the user can fix auth (deploy key / PAT) and re-run.
- ✅ Frontend Workshop view: after a successful APPLY, a COMMIT + PUSH panel appears showing branch, remote URL, files-to-commit, files-being-skipped (highlighted in amber), commit-message input pre-seeded from the problem statement, and two buttons: ⇧ COMMIT + PUSH or ⇩ LOCAL ONLY.

**Hands-free voice fix** (the bug user reported)
- ✅ Root cause: the only `<Composer>` was mounted inside `chatPane`, which only renders on the CHAT tab. When the user said "hey Alfred, go to chat" / "go to workout" on the HUD tab, the wake-word hook fired `composerRef.current?.startVoice()` on a NULL ref. Result: hands-free worked only on the chat tab.
- ✅ Fix: `ChatTabView` now mounts always (`display: contents` when active, `display: none` otherwise) so its inline Composer survives tab switches. Plus a SECOND always-on off-screen Composer (`handsFreeComposerRef`) at the root for non-chat tabs so the user sees the recording UI on the HUD/Workout/Design too.
- ✅ Wake-word handler now picks the right ref based on `activeTab` so both Composers can coexist without fighting over the mic.
- ✅ New `<HandsFreeOverlay>` component pinned bottom-left of the HUD: shows live recording state (LISTENING / SPEAKING / THINKING / STANDING BY / WAKE ERROR with colour-coded pulse dot), the user's last utterance, and Alfred's last reply. Auto-fades after 8 s of silence so the HUD stays clean.
- ✅ Verified: wake-word fires from any tab → mic activates → STT lands → `handleSend` runs intent detection → "go to chat" / "go to workout" / "open the menu" route correctly.

### Feb 2026 — Self-fix loop complete (NEW)

**Dry-run before APPLY** (the safety net)
- ✅ `POST /api/workshop/dry-run` — applies the diff to a throwaway `git worktree` (clones HEAD's index, doesn't touch the real working tree), runs the configured test commands, returns pass/fail with truncated output. Default test command: `pytest alfred-core/tests`. The frontend's APPLY button glows GREEN when dry-run passed so the user has a visual cue that the fix is verified.
- ✅ Worktree teardown is idempotent (`git worktree remove --force` + `shutil.rmtree` belt-and-braces) so leaked worktrees can't accumulate.
- ✅ Same allowlist + .env block as APPLY — dry-run can't be tricked into running tests after touching `.env`.

**Branch strategy on commit-push**
- ✅ `branch_strategy: "alfred-pr"` (new default) creates a fresh `alfred/<8-char-id>` branch off HEAD before staging, so commits never land on `main` without review. Pushes the branch with `-u origin <branch>` so subsequent pushes need no flag.
- ✅ Best-effort GitHub PR-compose URL emitted in the response (`https://github.com/<owner>/<repo>/pull/new/<branch>`). Non-GitHub remotes get an empty `pr_url` and the frontend hides the link.
- ✅ `branch_strategy: "current"` retained for users who actually want to push to whatever branch they're on.
- ✅ Frontend Workshop view: radio toggle "new alfred/<id> branch" (default) vs "current branch", auto-clickable PR link after a successful push.

**Voice "Alfred, fix yourself"**
- ✅ `POST /api/workshop/self-fix-hint` — keyword matcher mapping the user's problem statement to a short list of candidate files. 10 topic registries: radial-menu, spotify, workout, chat, voice, vitals, workshop, vision (camera/face), hud-layout, auth. Falls back to a generic wide-angle set when nothing matches.
- ✅ Frontend `detectSelfFixIntent` regex catches "fix yourself", "fix the X", "the X is broken, fix it", "debug/repair/patch X". Plain greetings ("hello", "what's the weather") never false-match — verified.
- ✅ When matched, ChatWindow pops the Workshop sub-view with the problem and pre-selected file paths from the hint. User clicks DIAGNOSE → reads the proposed diff → DRY RUN → APPLY → COMMIT+PUSH-to-alfred-branch → opens the PR link. **Full self-fix loop, voice-driven.**

**11 new backend tests** covering: alfred-pr branch creation, GitHub URL emission for github.com remotes only, dry-run pass/fail, dry-run refuses .env, dry-run preserves real working tree, self-fix-hint keyword matching, self-fix-hint fallback, self-fix-hint empty-rejection. **Total backend tests: 101 passing.**

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
