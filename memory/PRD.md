# Alfred AI — PRD / Memory

## Original problem statement
Self-hosted personal AI assistant ("Alfred", butler persona inspired by
Alfred Pennyworth / JARVIS) for **Mukarram Mohammad Alam**. Runs on his
home PC (Windows 11 + WSL2 + Docker Compose), reachable via Tailscale.
Stack: FastAPI backend (`alfred-core`, port 8000) + Next.js 15 web UI
(`alfred-web`, port 3000) + Postgres/pgvector + Ollama local LLM with
Anthropic Claude cloud fallback.

NOTE: This repo does NOT follow the standard /app/backend + /app/frontend
pod layout. Supervisor's backend/frontend services are expected to be
FATAL in this pod — the app runs on the user's PC via `docker compose
up --build`. Develop here, user tests locally. Frontend can be smoke-
tested in the pod with `cd /app/alfred-web && npm run dev` (port 3000).
Backend unit tests: `cd /app/alfred-core && pip install -e ".[dev]" &&
python3 -m pytest tests/`.

## Existing features (built in earlier sessions)
- Persona system: Standard Mode + Nightfall Protocol (wake phrases)
- Chat with marker-based tools: [REMEMBER], [SEARCH] (Tavily),
  [SEND_EMAIL] (Gmail SMTP), [SPOTIFY_*], [GENERATE_IMAGE]
  (Pollinations), [REMEMBER_CONVERSATION]
- Long-term memory archive (pgvector embeddings + Markdown mirror)
- Voice: faster-whisper STT, edge-tts/Piper TTS, openWakeWord
  hands-free wake word ("hey alfred")
- Camera presence (face count), hand tracking (MediaPipe) with
  quick-tools radial menu + two-hand pinch HUD resize
- JARVIS HUD: orb, clock, weather, Spotify player, customizable layout
- Conversations sidebar, image attachments (vision via
  llama3.2-vision or Claude), PWA install

## Current session (June 2026): touchscreen Design Pad + wire-mesh face
User request: a 15" touchscreen monitor installed in his desk.
1. Alfred detects the monitor and shows a wire-mesh face that talks
   and looks at him (Phase B — NOT started yet).
2. "Pull up the design tab" → sketch pad on the touchscreen with
   multiple layers, pressure-sensitive pencil/pens, multi-colour, and
   Alfred can analyze the sketch, create layers, change colour and
   the active tool by voice (Phase A — DONE this session).
User chose: "do what you think is best, but start with the sketch pad".
Agent's recommended approach for Phase B (approved implicitly): both
auto-detect (Window Management API, Chrome/Edge) + manual fallback
route; 3D wireframe head (Three.js) lip-synced to TTS audio level,
webcam face tracking so it looks at the user.

### MAJOR DISCOVERY + MERGE (2026-06-11, after Phase A)
The user's LOCAL Alfred was months ahead of GitHub — ~29k lines of
uncommitted features: tabbed UI (hud/chat/workout/design via tabs.ts +
TabBar), LoginGate/auth (password gate, brute-force lockout), mobile
shell (useDeviceMode + MobileChat), streaming TTS, holographic earth
(three.js/R3F + maplibre/leaflet/valhalla routing), CadStudio/Onshape
(DESIGN tab = CAD; persona has DESIGN_ONSHAPE_PROMPT), workshop
(self-fix), vitals, face recognition, workout coach (pose tracking),
RadialMenu (replaced QuickToolsMenu — deleted), printer/moonraker,
desktop tools, location tracking, Router gained local_fast backend.
He committed it all and pushed to branch `alfred-complete`; the agent
fetched + merged it into the workspace, then:
- Resolved 3 leftover conflict regions in ChatWindow.tsx (kept both
  import sets; kept HIS radial-menu code, dropped old quickToolsItems;
  kept <SketchPad /> + his PoseSkeleton/ExpressionReadout renders).
- Re-added sketch prompts to HIS persona.py (renamed user-facing term
  to "freehand sketch pad" to avoid clashing with his Onshape CAD
  "design tab"; context line now "The freehand sketch pad is OPEN").
- Fixed his test_workshop.py Router(local_fast=None) arg; ruff --fix.
- Verified: 312 backend tests pass, tsc clean, eslint clean (1
  pre-existing warning), next build clean, Playwright smoke test of
  sketch pad inside his full HUD passed (open/draw/layers/close).
NOTE: his app uses npm --legacy-peer-deps (Dockerfile), package.json
has three/R3F/leaflet/mapbox/maplibre. LoginGate auto-disables when
ALFRED_PASSWORD_HASH unset or /auth/me unreachable.
NEXT STEP for user: Save to GitHub → branch alfred-complete, then
locally `git checkout alfred-complete && git pull && docker compose
up --build`.

### Design tab takeover + radial module (2026-06-11, later)
User: "i dont want the design tab to be there i want it [sketch pad]
to take over the old one thats next to workout and chat. i also want
it in the select module" (select module = RadialMenu, hint text
"SELECT A MODULE").
Implemented:
- DESIGN tab now renders SketchPad (DesignView/CAD unwired from tabs;
  CadStudio/DesignView/Design3DView components remain in repo unused).
- SketchPad.tsx rewritten: layer <canvas> elements + undo history +
  canvas ops moved to MODULE level (registered with sketchStore at
  module load) so bitmaps/commands survive tab unmounts. Root layout
  is now in-flow flex (no fixed overlay) under the TabBar.
- ChatWindow: sketchOpen ↔ activeTab sync effects (open → design tab,
  close → chat tab); DesignView import + designConversationId removed;
  TAB_NOUNS gained design/sketch/drawing nouns for instant voice nav;
  handleRadialSelect handles "design".
- RadialMenu: added DESIGN — Sketch Pad entry (5 orbs now) using the
  previously-unused DesignGlyph wireframe cube.
- Verified via Playwright: tab opens pad, stroke pixel-count survives
  tab round-trip exactly, CLOSE returns to chat, radial DESIGN module
  opens the pad. tsc/eslint/next build clean.

### Procreate-style pad rework (2026-06-12)
User: "no grid, the pad itself is white, zoom in/out and move it
around like Apple's Procreate, and remove the DESIGN button next to
the CAM button."
Implemented in SketchPad.tsx (+ sketchStore default color #16181d):
- White paper (#ffffff), grid removed; flatten/export/analyze fill
  white. New swatch palette tuned for white paper (ink black first).
- Zoom/pan: viewRef {scale,tx,ty} applied as CSS transform (origin
  0 0) on the canvas stack; toLogical uses getBoundingClientRect so
  strokes stay aligned at any zoom. Two-finger pinch = zoom+pan
  (anchored at gesture midpoint), wheel zoom at cursor (ctrl+wheel =
  trackpad pinch), middle-mouse drag pan, −/%/+ controls bottom-right
  (% resets view). Zoom clamps 0.3x–12x of fit.
- Procreate gestures: two-finger TAP undo, three-finger TAP redo;
  second finger mid-stroke cancels the stroke (pops the undo entry
  just pushed); leftover finger after pinch can't draw until all lift.
- Removed design-pad-toggle-btn from chat header (HUD toggle btn got
  testid hud-toggle-btn). Tab/radial/voice remain the entry points.
- Verified via Playwright: button gone, white bg + no grid, wheel
  zoom 100→197%, +/reset buttons, stroke lands at correct logical
  coords after zoom round-trip. tsc/eslint/build clean.

### Pinch-rotate + eyedropper (2026-06-12, later)
User approved both suggested gestures.
- ViewState gained rotation (radians); transform = translate/rotate/
  scale with transformOrigin 50% 50% (centred origin makes the
  bbox centre the invariant anchor — all gesture math + toLogical
  inverse mapping use it). Pinch now zooms+pans+rotates with the
  midpoint anchored; snaps to quarter turns within ~4°. Wheel zoom
  and middle-drag pan preserve rotation. Reset clears rotation too.
- toLogical rewritten with inverse rotation (offsetWidth = layout
  size), so strokes land correctly while rotated.
- Eyedropper: hold still ~550ms → stroke dot cancelled, loupe
  (sketch-eyedropper-loupe/-hex) follows pointer live-sampling via
  sampleColorAt (composites visible layers over white at 1px);
  release applies colour. KEY FIX: restoreLayer is async (Image
  decode) — sample must run in its onDone callback or it picks up
  the just-drawn dot. Guard: skip if pointer already lifted.
- setPointerCapture wrapped in try/catch (synthetic touch events).
- Verified via Playwright: synthetic two-finger rotate → rotate(0.349
  rad) in transform + reset clears; eyedropper picked #e03c3c off a
  red stroke and #ffffff off blank paper; no stray dots remain.

### Phase A — Design Pad (DONE 2026-06-11, all tests pass)
- `alfred-core/src/alfred_core/tools/sketch_marker.py` — [SKETCH_*]
  marker parser (OPEN/CLOSE/TOOL/COLOR/BRUSH/LAYER_ADD/LAYER_SELECT/
  UNDO/REDO/CLEAR/ANALYZE) + confirmations.
- `chat.py`: ChatRequest.sketch (SketchSignal: open/tool/color/
  brush_size/layers/snapshot PNG), ChatReply.sketch_commands;
  [SKETCH_ANALYZE] handled in _run_search_loop by re-prompting with
  the snapshot as an image turn (auto-routes to vision backend);
  non-analyze markers in intermediate replies are carried so commands
  aren't lost; _process_sketch_markers validates tool/brush args.
- `persona.py`: SKETCH_TOOL_PROMPT (always), SKETCH_ANALYZE_PROMPT
  (gated on settings.has_vision), design-pad line in CURRENT CONTEXT
  (ContextBundle.sketch_summary).
- `alfred-web/src/lib/sketchStore.ts` — external store (orbState
  pattern): open/tool/color/brushSize/layers/activeLayerId +
  applyCommand() + registered canvas ops (undo/redo/clear/snapshot).
- `alfred-web/src/components/SketchPad.tsx` — fullscreen overlay,
  always mounted (display:none when closed so bitmaps survive);
  per-layer 1600×1000 canvases; pressure via Pointer Events
  (+coalesced events, palm rejection); pencil/pen/marker/eraser;
  swatches + colour picker; layers panel (add/delete/rename/reorder/
  visibility/opacity); undo/redo (30 dataURL snapshots); PNG export;
  blueprint-grid background (CSS only, not in exports).
- ChatWindow: ✏ DESIGN header button (data-testid
  design-pad-toggle-btn), quick-tools "Design" item, sketch signal +
  snapshot sent with each message while pad open, sketch_commands
  applied on reply.
- Docs: docs/DESIGN_PAD.md, README feature line.
- Tests: tests/test_sketch_marker.py (12), tests/test_sketch_chat.py
  (12). Full suite: 211 passed. ruff clean, tsc clean, eslint clean,
  next build clean. Playwright smoke test passed (draw, tools,
  layers, undo verified visually).

GOTCHA learned this session: parallel search_replace edits to the SAME
file can race and silently drop edits — apply same-file edits
sequentially and verify with grep afterwards.

## Backlog / roadmap
- P0 (next): Phase B — wire-mesh talking face for the touchscreen:
  - Three.js wireframe head component, lip-sync from orbStore TTS
    level, idle micro-motion; "looks at" user via existing camera
    face-tracking (MediaPipe) gaze offset.
  - Monitor detection: Window Management API (getScreenDetails +
    screenschange) to auto-open/move a companion fullscreen window
    on the new screen; manual /face route fallback; Alfred announces
    "monitor connected".
- P1: sketch persistence (save/load named sketches, maybe Postgres or
  memory archive), Alfred drawing ON the pad (generated overlays).
- Earlier project phases still open: Home Assistant (P2), Creality K1
  Max printer control (P3), LoRA fine-tuning (P5), self-improvement
  mode (P6), mobile app (P7).

## Credentials
None required for dev. User-specific keys live in his local .env
(Anthropic, Tavily, Gmail, Spotify) — never in the repo.
