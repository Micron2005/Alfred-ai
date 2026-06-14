# Alfred Desktop — the native shell

A real Windows application around the Alfred web HUD: `Alfred.exe`
with its own icon, taskbar identity, boot splash, tray icon, and
native multi-monitor handling for the wire-mesh face. No visible
browser, no URLs — the web stack running in WSL is an implementation
detail this shell manages for you.

What the main process does on launch:

1. Boots WSL (hidden `wsl --exec sleep infinity`, which doubles as
   the keep-alive so WSL never idles out under the Docker stack).
2. Shows a splash while polling the web UI, then opens the HUD
   maximized.
3. Detects the desk touchscreen natively (Electron reports
   per-display **touch support** — no browser permission prompts)
   and opens `/face` on it frameless + fullscreen. Reacts live when
   monitors are plugged/unplugged. The **Sketch Pad** has its own
   pop-out: clicking POP TO TOUCHSCREEN in the HUD (or the tray
   "Open Sketch Window" entry) lands `/sketch` on the configured
   sketch monitor — by default the *other* touchscreen, so face and
   sketch can co-exist on three-monitor setups.
4. Auto-grants camera/mic/fullscreen permissions, registers itself
   as a Windows login item, and lives in the tray (closing the HUD
   window hides it; quit from the tray).

## Build the installer

**From WSL (recommended — one command, nothing installed on Windows):**

```bash
./scripts/windows/build-desktop-app.sh    # from the repo root
```

Installs Node 22 and Wine in WSL if needed (exe icon/metadata is
edited with pure-JS `resedit` and `signExecutable: false` skips code
signing, but NSIS builds the uninstaller by executing a 32-bit
Windows stub — that one step runs under Wine), then copies
**Alfred Setup 1.0.0.exe** to the Windows desktop and runs it.

**Or natively on Windows** (needs [Node.js LTS](https://nodejs.org)
22+, e.g. `winget install OpenJS.NodeJS.LTS`):

```powershell
# Copy this folder somewhere Windows-local (npm dislikes \\wsl$ paths)
robocopy \\wsl$\Ubuntu\home\YOU\alfred-ai\alfred-desktop $env:USERPROFILE\alfred-desktop /E /XD node_modules dist
# (robocopy exit code 1 just means "files copied" — that's success)
cd $env:USERPROFILE\alfred-desktop
npm install
npm run dist
& ".\dist\Alfred Setup 1.0.0.exe"
```

## Configuration

`%APPDATA%\Alfred\config.json` (tray → **Open Config File**). Edit +
restart Alfred to apply:

| Key | Default | Meaning |
|---|---|---|
| `appUrl` | `http://localhost:3000` | Where the stack serves the UI (internal only). Point at a Tailscale address to drive a remote Alfred. |
| `distro` | `""` | WSL distro to boot; empty = default distro |
| `bootWsl` | `true` | Boot + keep WSL alive on launch. Disable for remote `appUrl`. |
| `face` | `"auto"` | `auto` = open the face on the detected touchscreen, track plug/unplug. `off` = tray menu only. |
| `faceResolution` | `"any"` | `any` = first secondary display (touch-capable preferred), or pin by physical resolution, e.g. `"1920x1080"` |
| `sketchResolution` | `"auto"` | Where the **POP TO TOUCHSCREEN** button (and tray entry) sends the Sketch Pad. `auto` = the *other* touch-capable monitor (so the face window keeps one touchscreen and sketch lands on the second). `any` = any secondary. `"primary"` / explicit resolution like `"1920x1080"` pin a specific monitor. `off` = let the browser pick (a normal popup window). |
| `sketchFullscreen` | `true` | Open the sketch window borderless + fullscreen on its display (Procreate-on-touchscreen mode). `false` = a normal resizable window. |
| `openAtLogin` | `true` | Start Alfred at Windows logon (also a tray checkbox) |
| `startupTimeoutSec` | `600` | How long the splash waits for the stack |

## Development

```bash
npm install
npm start          # runs against appUrl from your config / defaults
```

On Linux/CI run with `--no-sandbox` when root. Lifecycle logs are
printed to stdout (`[alfred-desktop] …`).
