# Setup — Windows, NO Docker Desktop, desktop-app experience

This guide turns Alfred into something that feels like an installed
Windows program:

- ✅ **No Docker Desktop** — the free, open-source Docker Engine runs
  *inside* your existing WSL2 Ubuntu. Nothing extra is installed on
  Windows. (Windows activation status is irrelevant to any of this —
  WSL2 and Docker Engine are free regardless.)
- ✅ **Starts when you turn on the PC** — WSL boots at logon, systemd
  brings up Postgres/backend/web automatically.
- ✅ **Opens like an app** — its own window with no address bar, no
  tabs, its own taskbar icon. You never see or type `localhost:3000`.
- ✅ **The wire-mesh face appears on the desk touchscreen** at the
  same time.

Everything below assumes WSL2 + Ubuntu are already installed (they
are on your machine) and the repo is cloned inside WSL.

---

## 1. Inside WSL — engine + boot services (one time)

Open your Ubuntu terminal:

```bash
cd ~/alfred-ai          # wherever you cloned the repo
git pull
./scripts/windows/install-wsl-engine.sh
```

The script is idempotent and walks you through it. It will likely
stop twice on first run:

1. **After enabling systemd** → run `wsl --shutdown` in PowerShell,
   reopen Ubuntu, re-run the script.
2. **After adding you to the docker group** → open a fresh Ubuntu
   terminal (or `newgrp docker`), re-run the script.

When it finishes you have:

| Piece | What it does |
|---|---|
| `docker-ce` + compose plugin | The container engine, inside WSL only |
| `alfred-ollama-bridge.service` | Forwards WSL `:11434` → Ollama on Windows, so the existing `OLLAMA_HOST="http://host.docker.internal:11434"` in `.env` keeps working **unchanged** |
| `alfred.service` | `docker compose up` at every WSL boot |

First start (builds images, takes a few minutes):

```bash
sudo systemctl start alfred.service
docker compose logs -f        # watch until alfred-web is up
./scripts/smoke-test.sh       # all green = good
```

> Your `.env` needs no changes from the Docker Desktop setup. If this
> is a fresh clone: `cp .env.example .env` and fill it in as usual.

## 2. On Windows — let WSL containers reach Ollama (one time, admin)

Ollama stays on the Windows side (best GPU access). By default it
only listens on `127.0.0.1`, which WSL containers can't reach without
Docker Desktop. Fix it once, in an **elevated** PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File \\wsl$\Ubuntu\home\YOU\alfred-ai\scripts\windows\Enable-OllamaForWSL.ps1
```

(Adjust `Ubuntu`/`YOU` to your distro name and Linux username.) Then
**quit Ollama from the tray and start it again**. Verify from WSL:

```bash
curl http://localhost:11434/api/tags     # should list your models
```

The firewall rule it creates only allows private ranges — Ollama is
not exposed to the internet.

## 3. On Windows — autostart + the app window (one time, no admin)

```powershell
powershell -ExecutionPolicy Bypass -File \\wsl$\Ubuntu\home\YOU\alfred-ai\scripts\windows\Install-AlfredAutostart.ps1
```

This installs:

- a **Startup entry** — at every logon it silently boots WSL (and
  keeps it alive), waits for Alfred to come online, then opens the
  HUD in a **Chrome app window**: no address bar, no tabs, own
  taskbar icon. The URL exists only inside the launcher script — you
  never interact with it.
- a **desktop shortcut** ("Alfred AI") for manual relaunch — if you
  ever close the window, double-click that, exactly like a normal
  program.

Test it immediately by double-clicking the desktop shortcut.

> Tip: right-click the running Alfred taskbar icon → **Pin to
> taskbar** for one-click access forever after.

## 4. The wire-mesh face on the desk touchscreen

Two ways to get the face up at boot — pick one (A is recommended,
they can also coexist):

### A. In-app auto-launch (recommended — knows your monitors)

One-time, in the running Alfred window:

1. Click the orb → **FACE** module.
2. **SCAN DISPLAYS** → Chrome asks for the *window management*
   permission → **Allow**. Your monitors appear in the list.
3. Set **MATCH RESOLUTION** to the touchscreen's resolution (e.g.
   `1920x1080`) — or leave `any` to take the first secondary screen.
4. Tick **AUTO-LAUNCH WHEN THE DESK SCREEN CONNECTS**.
5. Allow pop-ups for the site: click the icon left of where the
   address bar would be → Site settings → Pop-ups → **Allow** (or
   just press LAUNCH once and approve the blocked-popup prompt).

From then on, whenever Alfred starts (or the touchscreen is plugged
in), the face window opens itself on the right display. Tap it once
to go fullscreen.

### B. Forced second window at boot (position-based)

If you prefer brute force, reinstall the autostart with the face
flags — it opens `/face` directly on given pixel coordinates:

```powershell
powershell -ExecutionPolicy Bypass -File ...\Install-AlfredAutostart.ps1 -FaceDirect -FacePosition "1920,0"
```

`-FacePosition` is the touchscreen's top-left corner in your Windows
display layout (Settings → System → Display; e.g. a 1080p primary
with the touchscreen to its right → `1920,0`; below it → `0,1080`).

## 5. Daily life

| Action | How |
|---|---|
| Turn on PC | Alfred + face appear by themselves after logon |
| Closed the window? | Desktop shortcut "Alfred AI" |
| Update Alfred | In WSL: `git pull && sudo systemctl restart alfred.service` |
| Stop everything | In WSL: `sudo systemctl stop alfred.service` (or PowerShell: `wsl --shutdown`) |
| Logs | `docker compose logs -f` / `journalctl -u alfred.service -f` |

## Troubleshooting

- **Window opens but says the site can't be reached** — the stack was
  still building. It waits up to 10 minutes on first boot; later
  boots are ~20-30 s. Refresh or relaunch from the desktop shortcut.
- **Alfred dies a minute after the window closes** — something ran
  `wsl --shutdown`, or the hidden keep-alive process was killed. Just
  relaunch from the desktop shortcut.
- **Chat says the model is unreachable** — check the bridge chain:
  `curl http://localhost:11434/api/tags` inside WSL. If that fails:
  is Ollama running on Windows? Did you restart it after
  `Enable-OllamaForWSL.ps1`? `journalctl -u alfred-ollama-bridge -f`
  shows the relay's view.
- **`docker: permission denied`** — you skipped the fresh-login step;
  run `newgrp docker` or open a new terminal.
- **Face window didn't auto-open** — pop-ups must be allowed for the
  site (step 4A.5), and the window-management permission granted. The
  FACE panel shows permission state and which display matched.
- **Slow boots from `docker compose pull`** — alfred.service pulls
  image updates before each start. Disable with a systemd override:
  `sudo systemctl edit alfred.service` →
  `[Service]` / `Environment=ALFRED_NO_PULL=1`.

## How the pieces fit

```
Windows logon
 └─ Startup shortcut → Launch-Alfred.ps1 (hidden)
     ├─ wsl --exec sleep infinity        ← boots WSL, keeps it alive
     │   └─ systemd (inside WSL)
     │       ├─ docker.service               (docker-ce, no Desktop)
     │       ├─ alfred-ollama-bridge.service (:11434 → Windows Ollama)
     │       └─ alfred.service               (docker compose up -d)
     ├─ wait for HTTP 200 on :3000
     ├─ chrome --app=…        ← HUD app window (no browser chrome)
     └─ (optional) chrome --app=…/face on the touchscreen
            — or the HUD's FACE auto-launch opens it itself
```
