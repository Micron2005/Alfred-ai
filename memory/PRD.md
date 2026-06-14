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

### Phase B — Wire-mesh talking face (DONE 2026-06-12, 9/9 e2e pass)
User choices: abstract 3D wireframe head; mouth syncs to TTS
amplitude; gaze via webcam face tracking; auto-trigger on a
user-specified resolution + manual radial toggle; face lives on a
secondary/tertiary video output (separate window).
- `alfred-web/public/models/canonical_face_model.obj` — MediaPipe
  canonical face mesh (468 verts IN LANDMARK ORDER, 898 tris). That
  ordering is the whole trick: lip/chin/eyelid landmark indices
  address real vertices, so the mouth/blinks animate without a rig.
- `components/WireframeFace.tsx` — plain Three.js (no R3F). Custom
  OBJ parse (OBJLoader would de-index and break the landmark
  mapping). One shared position BufferAttribute drives LineSegments
  (unique edges) + Points + faint additive fill. Per-frame: jaw-open
  weights (below-mouth falloff × frontness; extra inner-lower-lip
  weight), blink weights (radial falloff around eye centers),
  gaze yaw/pitch lerp (webcam target or idle drift), glowing iris
  rings that lead the gaze, HUD arc rings (4× spin when thinking),
  particle shell, mode palette (cyan idle/speaking, gold thinking).
- `lib/faceBus.ts` — BroadcastChannel "alfred-face-bus". HUD
  publishes {type:'state',mode,level,t} at 30 Hz when orb non-idle,
  1 Hz heartbeat idle; replies to {type:'hello'}. setInterval not
  rAF (rAF freezes in background tabs). TTS amplitude came FREE:
  ChatWindow already pushes analyser RMS into orbStore; publisher
  just samples the store.
- `lib/faceScreen.ts` — Window Management API. localStorage
  'alfred.faceScreen' {autoLaunch, resolution ('any'|'WxH',
  orientation-agnostic match)}. scanScreens() (permission prompt
  needs user gesture), matchFaceScreen (secondary screens only),
  openFaceWindow popup positioned on target screen,
  startFaceAutoLaunch(): screenschange listener auto-opens/closes
  (only closes windows IT opened); FACE_CONFIG_EVENT re-arms after
  permission grant/config change without reload.
- `app/face/page.tsx` + `components/FaceWindow.tsx` — /face route
  (ssr:false). Subscribes bus (link stale >4 s → STANDBY; level
  stale >400 ms → 0), runs useFaceTracking with OWN camera stream,
  gaze = mirrored bbox center → [-1,1] (mirror view means "where
  your image is" == your direction, so head looks AT you). Tap
  anywhere = fullscreen toggle; CAM ON/OFF button; HUD LINKED /
  GAZE LOCK indicators; corner brackets.
- `components/FaceModeView.tsx` — radial FACE module panel (subview
  pattern like Spotify/Workshop): launch/close + window status,
  SCAN DISPLAYS + screen list w/ PRIMARY/INTERNAL/FACE TARGET
  badges, auto-launch toggle, resolution input (garbage → 'any').
- RadialMenu: FACE entry + triangulated FaceGlyph. ChatWindow:
  subView 'face', voice nav ("pull up your face" — subview regex
  gained your\s+ and face/wire-mesh/avatar nouns),
  startFaceBusPublisher + startFaceAutoLaunch effects.
- Tests: testing agent 9/9 PASS (render, lip-sync via injected bus
  msgs + 4s decay, cam toggle, radial entry, panel, popup launch/
  close, persistence, validation, tab/subview regressions). tsc/
  eslint/next build clean; 316 backend tests pass (backend
  untouched).
- USER SETUP (his PC): allow pop-ups for the Alfred origin in
  Chrome; FACE panel → SCAN DISPLAYS (grants window-management
  permission) → set resolution → arm auto-launch. Browsers can't
  see which display is touch-capable → resolution is the
  discriminator. Direct nav to /face on any device also works.

### Windows deployment v1 — Chrome app window (2026-06-12, SUPERSEDED)
User rejected the Chrome `--app` window approach ("i dont want a
chrome app to open… i want it to run like its own app").
Launch-Alfred.ps1 + Install-AlfredAutostart.ps1 were DELETED. Still
in use from this phase: install-wsl-engine.sh (docker-ce in WSL +
systemd + ollama socat bridge) and Enable-OllamaForWSL.ps1 — see
next entry for details that survive:
User: can't install Docker Desktop on main PC ("no Windows license"),
wants Alfred running straight off the desktop, auto-starting at boot,
no browser/localhost:3000. Chrome; HUD + face at startup; WSL2
already installed; local Ollama on Windows.
Solution shipped (validated: bash -n, pwsh Parser, config round-trip;
NOT runnable in pod — user must execute on his PC):
- `scripts/windows/install-wsl-engine.sh` — idempotent, run inside
  WSL: enables systemd (wsl.conf, may need `wsl --shutdown` + rerun),
  installs docker-ce via get.docker.com + docker group (rerun after
  relogin), installs alfred-ollama-bridge.service (socat relay WSL
  :11434 → Windows Ollama; auto-handles NAT mode [target=default gw]
  vs mirrored mode [target=127.0.0.1, bind=172.17.0.1]; skips if
  11434 already bound), then runs existing install-systemd.sh.
  KEY: compose already has extra_hosts host.docker.internal:
  host-gateway, so .env OLLAMA_HOST stays UNCHANGED.
- `scripts/windows/Enable-OllamaForWSL.ps1` (admin, once): sets user
  env OLLAMA_HOST=0.0.0.0:11434 + firewall rule for 11434 restricted
  to private ranges; user must restart Ollama tray app.
- `scripts/windows/Launch-Alfred.ps1` — boot launcher: spawns hidden
  `wsl --exec sleep infinity` (keep-alive; WSL idles out otherwise),
  waits ≤600 s for HTTP 200 on :3000, opens Chrome
  `--app=http://localhost:3000 --start-maximized` (app window = no
  address bar; URL never visible), optional second `--app=/face
  --window-position=X,Y --start-fullscreen` (faceDirect). Reads
  config.json beside it. NOTE: face window must share the Chrome
  profile (NO --user-data-dir) or BroadcastChannel lip-sync breaks.
- `scripts/windows/Install-AlfredAutostart.ps1` — copies launcher +
  generated config.json to %LOCALAPPDATA%\AlfredAI (Startup shortcut
  can't point at \\wsl$ — not mounted at logon), creates Startup +
  Desktop shortcuts (powershell -WindowStyle Hidden), flags:
  -Distro -FaceDirect -FacePosition "1920,0" -NoFaceFullscreen
  -Uninstall.
- `docs/SETUP_WINDOWS_NO_DOCKER_DESKTOP.md` — full guide (face boot
  routes A: in-app auto-launch w/ permission+popup grant, B:
  -FaceDirect positioned window; troubleshooting; ALFRED_NO_PULL=1
  override for slow boots). README links it.
- USER VERIFICATION PENDING: must run steps 1-4 of the doc on his PC.

### Windows deployment v2 — native Electron app (2026-06-12, current)
`alfred-desktop/` — a real Alfred.exe (Electron 42.4.0 +
electron-builder 26.15.3, NSIS one-click installer). No browser, no
visible URLs. Smoke-tested LIVE in the pod (xvfb + --no-sandbox
against the dev server: splash → "stack ready — opening HUD" →
1 display → correctly no face window; config.json materialised).
- `main.js` (single file, logs as [alfred-desktop]):
  - boots WSL via hidden `wsl --exec sleep infinity` (= keep-alive;
    platform-guarded so dev on Linux skips it)
  - splash.html polls config.appUrl (default http://localhost:3000,
    600 s timeout — first boot builds images), then HUD
    BrowserWindow maximized; close = hide-to-tray; quit via tray
  - FACE: screen.getAllDisplays(), prefers secondary display with
    touchSupport==='available' (native per-display touch detection
    — better than any browser), optional faceResolution pin
    (physical px = size×scaleFactor, orientation-agnostic); opens
    /face frameless+fullscreen; display-added/removed listeners
    (800 ms debounce) auto open/close (only windows IT opened —
    faceAutoOpened flag); tray toggle for manual control
  - both windows share defaultSession → BroadcastChannel lip-sync
    bus works as in a browser
  - setPermissionRequestHandler auto-grants media/fullscreen/
    window-management → camera + FACE panel work with zero prompts
  - setWindowOpenHandler: same-origin → child window, external →
    shell.openExternal
  - tray: Show HUD / Open-Close Face / Start with Windows checkbox
    (app.setLoginItemSettings, only when isPackaged) / Open Config
    File / Quit; single-instance lock focuses HUD
  - config at %APPDATA%/Alfred/config.json: appUrl, distro,
    bootWsl, face auto|off, faceResolution, openAtLogin,
    startupTimeoutSec
- build/icon.ico+png generated from alfred-web icon-512.png
  (Pillow). GOTCHA: root .gitignore globally ignores build/ + dist/
  — added !alfred-desktop/build/** negations so icons commit;
  electron-builder dist/ stays ignored.
- electron 42 requires Node >= 22 to npm-install (pod has 20 →
  --ignore-engines for local test; user installs Node LTS on
  Windows). Build flow: copy folder to Windows-local path (npm vs
  \\wsl$ UNC), npm install, npm run dist, run "Alfred Setup
  1.0.0.exe".
- docs/SETUP_WINDOWS_NO_DOCKER_DESKTOP.md rewritten around the app;
  alfred-desktop/README.md added; root README link updated.
- USER VERIFICATION PENDING: run doc steps 1-3 on his PC (WSL
  engine script → Ollama script → build+install Alfred.exe).

### Windows setup friction fixes (2026-06-12, after user ran PS1/
winget commands inside bash)
User executed `Enable-OllamaForWSL.ps1` and `winget` in the Ubuntu
shell → "command not found". Reworked the flow so EVERY step runs
from the WSL terminal:
- `scripts/windows/setup-ollama-from-wsl.sh` — uses powershell.exe
  interop + Start-Process -Verb RunAs (UAC) to run
  Enable-OllamaForWSL.ps1 elevated; wslpath -w resolves the script
  path. Quoting verified by echo-simulation.
- `scripts/windows/build-desktop-app.sh` — builds Alfred.exe INSIDE
  WSL: installs Node 22 via NodeSource if missing, npm install +
  npm run dist, copies installer to the real Windows desktop
  ([Environment]::GetFolderPath('Desktop') → wslpath -u; handles
  OneDrive-redirected desktops) and launches it via powershell.exe.
- KEY FINDINGS (verified empirically in pod): electron-builder 26
  needs NO WINE — exe icon/metadata via pure-JS resedit
  (app-builder-lib/out/util/resEdit.js); set win.signExecutable:
  false to skip code signing (log: "file signing skipped via
  signExecutable configuration"). Pod build produced a complete
  211 MB Alfred.exe and failed ONLY at bundled linux/makensis
  (x86_64 binary, pod is arm64 — user's WSL is x86_64 so fine).
  Also: electron-builder defaults to HOST arch → pinned win target
  arch to ["x64"] in package.json.
- User context: repo at ~/Alfred-ai (capital A), Windows user
  `mukar`, distro presumably Ubuntu.
- Docs updated: sections 2-3 of SETUP_WINDOWS_NO_DOCKER_DESKTOP.md
  now use the two bash scripts (manual Windows-side paths kept as
  alternatives in alfred-desktop/README.md).

### Fixes from user's first real run (2026-06-12 evening)
User ran the scripts on his PC; two failures, both fixed:
1. install-wsl-engine.sh: "Unit file docker.service does not exist"
   — his distro had a leftover docker CLI (old Docker Desktop WSL
   integration) with NO engine, fooling the `command -v docker`
   check. Fix: detect /lib|/etc/systemd/system/docker.service
   instead; also `docker context use default` after install (stale
   desktop-linux context). NOTE: his first runs ABORTED before
   installing ollama-bridge + alfred.service (set -e) — rerun
   completes those.
2. build-desktop-app.sh: "spawn wine ENOENT" at the NSIS step.
   resedit handles exe icon/metadata wine-free (confirmed: packaging
   + "signing skipped" passed, Setup build started), BUT NSIS
   generates the UNINSTALLER by executing a 32-bit Windows stub →
   needs wine + wine32:i386 on Linux. Fix: script auto-installs
   `dpkg --add-architecture i386; apt install wine wine32:i386`
   (fallback plain wine). WSL2 kernel runs 32-bit ELF fine.
   His env: Ubuntu noble, Node 22.22.3 installed clean, npm install
   + electron win-x64 download + packaging all succeeded.
3. setup-ollama-from-wsl.sh ran without visible error (UAC path) —
   user has NOT yet confirmed `curl localhost:11434/api/tags`.
4. User then reported "local llm is not running" (HUD vital, from
   api/vitals.py _check_ollama → GET ${OLLAMA_HOST}/api/tags inside
   the container). Built scripts/windows/diagnose-ollama.sh —
   hop-by-hop chain test (Windows Ollama loopback via powershell.exe
   → OLLAMA_HOST user env → WSL→gateway direct → bridge service →
   WSL :11434 → docker compose exec alfred-core curl
   host.docker.internal) with ordered fix verdicts. Validated in pod
   (all hops fail gracefully, no crashes).
5. USER'S DIAGNOSTIC RESULTS: hop1 PASS (Ollama up on Windows
   loopback), hop2 PASS (OLLAMA_HOST=0.0.0.0:11434 set), hop3 FAIL
   (WSL → 172.20.160.1:11434 unreachable), hop4 PASS (bridge active
   — so the engine installer rerun worked), hop5 FAIL (downstream).
   ⇒ Root cause: Ollama still bound to 127.0.0.1 = NOT fully
   restarted after env change (or firewall). Upgraded diagnose hop3
   to disambiguate automatically via Get-NetTCPConnection (shows
   actual bind address) + Get-NetFirewallRule check; hop5 now labels
   downstream failures. Told user: tray → Quit Ollama → relaunch →
   re-run diagnostic. AWAITING RESULT.

### Local LLM blocker RESOLVED (2026-06-13)
After user restarted Ollama with OLLAMA_HOST=0.0.0.0:11434 and the
bridge live, all 5 upstream hops PASS. Hop 6 of diagnose-ollama.sh
was silently hanging — bug in the old version: ``CONTAINER_OUT=$(...
timeout 15 docker compose exec -T alfred-core ...)`` — docker-cli
doesn't propagate SIGTERM from outer ``timeout`` to the remote curl,
so the substitution wedges indefinitely with NO output written.
Manual probes from the user confirmed the container path is healthy:
``getent hosts host.docker.internal`` → 172.17.0.1; raw curl from
inside the container → HTTP 200 + ``{"models":[llama3.1:8b-instruct-
q4_K_M, nomic-embed-text:latest]}``. The HUD's old "Local LLM not
running" was stale state from BEFORE the firewall/env-var fix.

Fixed in this session:
- ``scripts/windows/diagnose-ollama.sh`` step 6 rewritten to never
  hang: backgrounded ``docker compose exec`` with
  ``timeout --kill-after=2 8``, output captured to ``mktemp`` then
  read back (no command substitution around exec), explicit container-
  running pre-check, and a model-mismatch warning that grepps the
  user's ``.env LOCAL_MODEL_CHAT`` against ``/api/tags`` and prints
  the exact ``ollama pull`` or ``sed`` fix command.
- User's ``.env`` was on default ``dolphin-llama3:8b-v2.9-q4_K_M``
  (not pulled). User chose to keep the model they already had —
  one-shot sed updated ``LOCAL_MODEL_CHAT="llama3.1:8b-instruct-
  q4_K_M"`` + ``docker compose restart alfred-core``.

VERIFIED end-to-end via ``curl http://localhost:8000/vitals``: EVERY
configured vital is now ``ok`` — Local LLM, Cloud LLM (Claude Sonnet
4.5), Database, Tavily Web Search, Gmail, Spotify; only 3D Printer
is ``off`` (intentional P3 backlog).

User decisions captured for the dolphin uncensored variant (Option B):
NOT pulled. If user later wants the uncensored persona, they can
``ollama pull dolphin-llama3:8b-v2.9-q4_K_M`` on Windows and flip the
.env line back — the wiring already supports it.

### Memory archive restore + Docker → native WSL2 migration (2026-06-13)
User reported memory empty in the app despite having all 22 markdown
files on disk. Diagnosis: Postgres volume was wiped during the WSL
Docker Engine migration earlier today; markdown files (host bind
mount) survived but the canonical ``memory_notes`` table was empty.
There was no rehydrate-from-disk path — render_markdown was one-way.

User then sharply pushed back: every fix I'd been proposing kept
landing in Docker (rebuild image, exec into container, etc.), but
he'd been asking since the first session to drop Docker entirely
because his main PC can't legally run Docker Desktop. Pivoted to
option (b) — native WSL2 + systemd, Docker gone.

Implemented (all tested at unit level, ready for user to run):

DISASTER-RECOVERY (memory rehydration)
- ``memory_archive.parse_markdown_mirror`` — reverse of
  ``render_markdown``. Tolerant of missing optional fields, hand-
  edited summaries, free-form prose mixed into bullet sections.
- ``memory_archive.restore_from_mirror`` — scans the mirror dir,
  upserts by original UUID (idempotent), re-embeds via Ollama.
  KEY FIXES from first user run (which failed 22/22):
  • FK violation when ``source_conversation_id`` referenced a
    conversation that no longer existed (whole DB had been wiped,
    not just memory_notes). Schema declares ON DELETE SET NULL for
    that FK exactly so orphan notes are valid — restore now
    pre-checks via ``select(Conversation.id).where(...)`` and sets
    the FK to NULL when the conversation is missing.
  • SQLAlchemy "transaction poisoned" cascade: one failed
    ``flush()`` aborted the rest of the loop. Wrapped each row
    insert + each embedding write in ``session.begin_nested()``
    so failures are SAVEPOINT-isolated.
- ``POST /memory/restore`` endpoint (idempotent, also handles
  hand-dropped .md files).
- ``scripts/restore-memory.py`` — standalone, runs OUTSIDE Docker
  via the alfred-core venv, reads .env, talks straight to native
  Postgres on localhost:5432, redacts the DB password when echoing.
- Tests: ``tests/test_memory_restore.py`` — 7 parser tests
  (round-trip, real user file, missing optionals, ``_(no summary)_``
  placeholder, malformed UUID, section reordering, prose-in-section
  rejection). All 26 memory tests pass.

DE-DOCKER MIGRATION
- ``scripts/native/go-native.sh`` — single command, idempotent, end-
  to-end: apt-installs postgresql-16 + pgvector + python3-venv +
  Node 20 (NodeSource) + ffmpeg + socat; creates ``alfred`` role
  and DB with a freshly-generated password; installs the ``vector``
  extension; rewrites ``.env`` (DATABASE_URL → native socket,
  OLLAMA_HOST → http://localhost:11434 — the existing socat bridge
  on WSL :11434 already relays to Windows Ollama, so no more
  host.docker.internal magic); builds the alfred-core venv at
  ``.venv-alfred-core`` (``pip install -e alfred-core``); downloads
  Piper voice + pre-warms Whisper into ``.alfred-deps/``; runs
  ``npm install --legacy-peer-deps`` + ``next build``; installs
  ``alfred-core.service`` + ``alfred-web.service`` systemd units;
  ``docker compose down`` (volumes preserved); restarts native
  services; runs restore-memory.py against the fresh native DB.
- ``scripts/native/alfred-core.service`` — uvicorn under the venv
  bin, ``PrivateTmp=yes``, Piper on PATH.
- ``scripts/native/alfred-web.service`` — ``npm run start`` from
  the prebuilt ``.next`` standalone bundle.
- ``scripts/native/uninstall-docker.sh`` — interactive teardown:
  containers/volumes/images first, then engine packages
  (docker-ce, containerd.io, buildx, compose-plugin), apt sources,
  /var/lib/docker. ``--containers-only`` flag keeps the engine
  installed if the user wants it around for unrelated work.

User runs ONE command on his PC to migrate + restore memory:
``bash ~/Alfred-ai/scripts/native/go-native.sh``

### Sketch pop-out + pen/pencil texture + camera fix (2026-02 fork)
User feedback after the Desktop migration:
1. "i dont like how the pen and pencil draw the same exact way" —
   they had different pressure curves but visually identical strokes.
2. "when i click pop to touch screen it just opens it as another
   tab instead of popping it up on the touch screen" — the SketchPad
   POP button used a plain ``window.open`` with ``popup=yes`` which
   Chrome ignores (lands as a tab next to the HUD).
3. Camera tile stays blank/black with NO error banner; OS camera
   light is on, so a hook IS holding the device — but the wrong
   one. Hand tracking was also broken (lower priority).

Fixed in this session:

POP TO TOUCHSCREEN now lands on the configured monitor
- `alfred-desktop/main.js` intercepts ``/sketch`` window.opens via
  ``setWindowOpenHandler``. Adds two config knobs:
  • ``sketchResolution`` (default ``"auto"``): picks the OTHER
    touch-capable secondary monitor (so face window stays on one,
    sketch on the other in three-monitor setups). Also accepts
    ``"any" | "primary" | "1920x1080" | "off"``.
  • ``sketchFullscreen`` (default ``true``): borderless +
    fullscreen on the target display (Procreate-on-touchscreen).
- ``pickSketchDisplay()`` uses Electron's per-display
  ``touchSupport`` reporting (no browser permission prompts) and
  avoids the display currently hosting the face window.
- Existing sketchWin tracked via ``did-create-window`` event;
  subsequent POP clicks refocus the existing window rather than
  spawning siblings. Tray gained ``Open Sketch Window`` /
  ``Close Sketch Window`` entry mirroring the face window UX.
- SketchPad's POP button updated with richer popup hints (left=0,
  top=0, menubar/toolbar/location/status=no) so browser-only mode
  also has a better chance of landing as a window rather than tab.

Pen vs Pencil — visible texture difference
- ``TOOL_CONFIG`` gains a ``texture: "smooth" | "grainy"`` field.
  Pencil is now ``grainy``: ``drawSegment`` keeps the smooth core
  at 60% width + 55% alpha, then stamps small Gaussian-jittered
  dots along each segment (~1 stamp per 0.6 × lineWidth px). Dot
  size + per-dot alpha vary so the graphite has a broken edge.
- Pen/marker/eraser stay ``smooth`` (single antialiased line).
- Pencil defaults bumped down (size 4, opacity 0.55) so even with
  the grain the line reads as graphite rather than a thick wash.
- New ``BrushPreviewChip`` component replaces the old solid-dot
  preview: a 180×44 canvas that draws a representative stroke
  using the same texture model, so the user sees pen vs pencil
  vs marker BEFORE drawing.

Camera tile blank/black — root cause + fix
- Root cause: ``useFaceTracking``, ``usePoseTracking``, and
  ``useHandTracking`` were hardcoded ``enabled: true`` and each
  called its own ``navigator.mediaDevices.getUserMedia``. The
  ``sharedStream`` they accepted was read from
  ``camera.streamRef.current`` at render time — a ref, not state,
  so its later mutation never triggered the hooks to re-init.
  Result on the user's hardware: three parallel getUserMedia
  races, one or more silently lose the device (camera light on,
  but ``useCamera``'s stream lands null) so ``CameraPreview`` has
  nothing to attach to.
- Fix: ``useCamera`` now publishes the stream as React **state**
  (``stream``) the moment it's acquired (BEFORE the MediaPipe
  ``FaceDetector`` init so the three other detectors can run
  their setup in parallel — also halves the wall-clock startup).
  All three downstream hooks (face/pose/hand) now REQUIRE a
  shared stream and drop their own ``getUserMedia`` fallback;
  if no shared stream they go ``"off"`` and render nothing. Their
  teardown no longer stops the shared MediaStream tracks (camera
  owns the lifecycle).
- ChatWindow gates ``face/pose/hand`` ``enabled`` on
  ``cameraOn && camera.stream != null`` so the three detectors
  spin up exactly when the user toggles the camera on, all
  feeding off the same MediaStreamTrack.
- Camera error banner now appears whenever ``camera.status ===
  "error"`` (not only when ``camera.error`` is also set), with a
  ``data-testid="camera-error-banner"`` for tests.
- Added a third error case to ``useCamera``: NotReadableError /
  "could not start video source" / "in use" now maps to a clear
  "Camera is in use by another app (Zoom, Teams, OBS, browser
  tab…)" message instead of the generic catch-all.

Verification:
- ``yarn build`` clean. ``yarn lint`` clean (1 pre-existing
  warning unrelated to this change). ``npx tsc --noEmit`` clean.
- ``node --check alfred-desktop/main.js`` passes.
- The user is rebuilding locally (Docker Compose + Alfred.exe).
  Manual verification flow he should run:
  1. Frontend: ``docker compose up -d --build alfred-web``
  2. Reload HUD; toggle CAM ON → tile should populate within
     2 s and the error banner should NOT appear.
  3. Pop the Sketch Pad from POP TO TOUCHSCREEN → lands on the
     other touch monitor (or whichever sketchResolution targets).
  4. In Sketch Pad, switch between pen and pencil → preview chip
     visibly changes and strokes have grain on paper.

## Backlog / roadmap
- P0 → DONE this fork: Camera tile blank fix (shared MediaStream
  across face/pose/hand hooks). Awaiting user verification on his
  Desktop after ``docker compose up -d --build alfred-web``.
- P1 (NEW from 2026-06-13 evening): Hand tracking regression. The
  shared-stream refactor in this fork likely also un-breaks hand
  tracking as a side-effect (it was racing the camera with face/
  pose), but user explicitly deprioritised this so verification
  is pending. Once they confirm the camera tile works, hand
  tracking is the next thing to test.
- P1: "Alfred runs natively on my desktop and can control things on
  my desktop" — the user wants more native multi-monitor awareness
  beyond the current Electron face+sketch window placement. Possible
  next steps:
  • IPC channel from Electron main → renderer exposing the display
    list (touch capability, refresh rate, physical resolution) so
    the HUD can self-route widgets to monitors;
  • An OS-control bridge (`scripts/windows/*`) for window switching,
    app launch, volume, brightness from the Alfred chat;
  • Replace the WSL Docker stack with the native systemd path
    long-term so Alfred can run when WSL is sleepy.
- P1: Face polish candidates (user feedback pending): Alfred
  announcing "monitor connected", brow/expression states tied to
  persona mood, mouth viseme shaping (vs amplitude-only jaw).
- P1: sketch persistence (save/load named sketches, maybe Postgres or
  memory archive), Alfred drawing ON the pad (generated overlays).
- Earlier project phases still open: Home Assistant (P2), Creality K1
  Max printer control (P3), LoRA fine-tuning (P5), self-improvement
  mode (P6), mobile app (P7).

## Credentials
None required for dev. User-specific keys live in his local .env
(Anthropic, Tavily, Gmail, Spotify) — never in the repo.
