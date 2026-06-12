# Setup — Windows, NO Docker Desktop, native desktop app

This guide turns Alfred into an installed Windows program:

- ✅ **No Docker Desktop** — the free, open-source Docker Engine runs
  *inside* your existing WSL2 Ubuntu. Nothing Docker-related is
  installed on Windows. (Windows activation status is irrelevant —
  WSL2 and Docker Engine are free regardless.)
- ✅ **A real app** — `Alfred.exe`, installed like any program: its
  own icon, taskbar identity, splash screen, tray icon. No browser,
  no address bar, no URLs anywhere.
- ✅ **Starts when you turn on the PC** — the app registers itself as
  a login item and boots the WSL stack itself.
- ✅ **The wire-mesh face appears on the desk touchscreen
  automatically** — the app detects which display is the touchscreen
  natively (per-display touch detection, no browser permission
  prompts) and tracks plug/unplug live.

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

## 3. Build + install the Alfred desktop app (one time)

The native shell lives in `alfred-desktop/`. Building it needs
[Node.js LTS](https://nodejs.org) **22 or newer** on Windows:

```powershell
winget install OpenJS.NodeJS.LTS
```

Then (new PowerShell so `npm` is on PATH):

```powershell
# Copy the folder somewhere Windows-local — npm dislikes \\wsl$ paths.
robocopy \\wsl$\Ubuntu\home\YOU\alfred-ai\alfred-desktop $env:USERPROFILE\alfred-desktop /E /XD node_modules dist
# (robocopy exit code 1 just means "files copied" — that's success)

cd $env:USERPROFILE\alfred-desktop
npm install
npm run dist

# Installs Alfred and launches it when done:
& ".\dist\Alfred Setup 1.0.0.exe"
```

That's it. From now on **Alfred is a program**: Start Menu entry,
desktop shortcut, pin it to the taskbar. On first launch it:

- registers itself to **start at Windows logon**,
- boots WSL itself (and keeps it alive),
- shows its splash until the stack is up, then opens the HUD
  maximized,
- opens the **wire-mesh face** on the touchscreen (see below),
- parks an icon in the system tray.

Closing the HUD window hides it to the tray (the face stays up);
quit fully via tray → **Quit Alfred**.

## 4. The face on the desk touchscreen

Nothing to set up in the happy path: the app picks the first
**secondary display, preferring one that reports touch support**, and
opens `/face` on it frameless and fullscreen. Plug the touchscreen in
late and the face appears; unplug it and the window retires.

To pin it to a specific monitor, tray → **Open Config File** and set:

```json
"faceResolution": "1920x1080"
```

(physical resolution of the touchscreen; `"any"` = automatic). Set
`"face": "off"` to only open it manually from the tray menu.

> The FACE module in Alfred's radial menu still exists — handy if you
> ever run Alfred in a plain browser (e.g. on another machine via
> Tailscale) — but the desktop app makes its permission/popup dance
> unnecessary on this PC.

## 5. Daily life

| Action | How |
|---|---|
| Turn on PC | Alfred + face appear by themselves after logon |
| Closed the HUD? | Click the tray icon, or launch Alfred from the Start Menu |
| Update Alfred (web/backend) | In WSL: `git pull && sudo systemctl restart alfred.service` |
| Update the desktop shell | Re-copy `alfred-desktop/`, `npm run dist`, run the new installer |
| Stop everything | Tray → Quit Alfred, then in WSL: `sudo systemctl stop alfred.service` (or PowerShell: `wsl --shutdown`) |
| Logs | `docker compose logs -f` / `journalctl -u alfred.service -f` |

## Troubleshooting

- **Splash stuck on "BUILDING THE STACK"** — first boot builds Docker
  images (minutes). If it ends in "BACKEND UNREACHABLE": check inside
  WSL with `docker compose logs -f` and `systemctl status alfred`.
- **`npm install` complains about the Node engine** — your Node is
  older than 22; `winget upgrade OpenJS.NodeJS.LTS`.
- **Chat says the model is unreachable** — check the bridge chain:
  `curl http://localhost:11434/api/tags` inside WSL. If that fails:
  is Ollama running on Windows? Did you restart it after
  `Enable-OllamaForWSL.ps1`? `journalctl -u alfred-ollama-bridge -f`
  shows the relay's view.
- **`docker: permission denied`** — you skipped the fresh-login step;
  run `newgrp docker` or open a new terminal.
- **Face opened on the wrong monitor** — set `faceResolution` in the
  config to the touchscreen's physical resolution.
- **Alfred dies a minute after quitting the app** — the app's hidden
  keep-alive died with it and WSL idled out. That's by design; launch
  Alfred again, or keep WSL alive yourself (`wsl -e sleep infinity`).
- **Slow boots from `docker compose pull`** — alfred.service pulls
  image updates before each start. Disable with a systemd override:
  `sudo systemctl edit alfred.service` →
  `[Service]` / `Environment=ALFRED_NO_PULL=1`.

## How the pieces fit

```
Windows logon
 └─ Alfred.exe (login item, lives in the tray)
     ├─ wsl --exec sleep infinity        ← boots WSL, keeps it alive
     │   └─ systemd (inside WSL)
     │       ├─ docker.service               (docker-ce, no Desktop)
     │       ├─ alfred-ollama-bridge.service (:11434 → Windows Ollama)
     │       └─ alfred.service               (docker compose up -d)
     ├─ splash → wait for the web stack
     ├─ HUD window (maximized, no browser chrome)
     └─ face window → fullscreen on the detected touchscreen
            (re-opens/closes live as displays come and go)
```
