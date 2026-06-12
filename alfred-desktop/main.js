/**
 * Alfred Desktop — the native shell.
 *
 * Wraps the Alfred web HUD in a real Windows application: its own
 * Alfred.exe, its own icon and taskbar identity, a boot splash, a
 * tray icon, and native multi-monitor control for the wire-mesh
 * face on the embedded desk touchscreen. No browser is ever visible
 * and no URL is ever shown — the web stack (running in WSL) is an
 * implementation detail.
 *
 * Responsibilities of this main process:
 *   1. Boot WSL at launch (hidden `wsl --exec sleep infinity` — the
 *      process doubles as the keep-alive so WSL never idles out and
 *      takes the Docker stack down). systemd inside WSL starts
 *      Docker + alfred.service on distro boot.
 *   2. Show a splash while polling the web UI, then open the HUD
 *      window maximized.
 *   3. Face window: enumerate displays natively (Electron's screen
 *      API even reports per-display touch support — better than any
 *      browser can do), pick the touchscreen, and open /face on it
 *      frameless + fullscreen. Reacts live to monitors being
 *      plugged/unplugged. Both windows share one session, so the
 *      BroadcastChannel lip-sync link works exactly as in a browser.
 *   4. Auto-grant camera/mic/fullscreen permissions (no prompts),
 *      tray menu (show HUD, face toggle, start-with-Windows, quit),
 *      and the Windows login item for boot-time start.
 *
 * Config lives at %APPDATA%/Alfred/config.json (tray → Open Config
 * File). Defaults below; edit + restart to apply.
 */

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  screen,
  session,
  shell,
} = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const DEFAULTS = {
  /** Where the Alfred web stack is served from (inside this app only —
   *  never user-visible). */
  appUrl: "http://localhost:3000",
  /** WSL distro name; "" = the default distro. */
  distro: "",
  /** Boot + keep-alive WSL on launch. Turn off if Alfred runs on
   *  another machine (set appUrl to its Tailscale address). */
  bootWsl: true,
  /** Face window: "auto" = open on the detected touchscreen and track
   *  plug/unplug; "off" = only via the tray menu. */
  face: "auto",
  /** "any" = first secondary display (touch-capable preferred), or a
   *  physical resolution like "1920x1080" to pin a specific monitor. */
  faceResolution: "any",
  /** Register as a Windows login item so Alfred starts at logon. */
  openAtLogin: true,
  /** How long to wait for the stack before giving up (first boot
   *  builds Docker images and can take minutes). */
  startupTimeoutSec: 600,
};

let config = { ...DEFAULTS };
let splashWin = null;
let hudWin = null;
let faceWin = null;
let faceAutoOpened = false;
let tray = null;
let quitting = false;

// ── Config ─────────────────────────────────────────────────────────

function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}

function loadConfig() {
  try {
    config = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(configPath(), "utf8")) };
  } catch {
    config = { ...DEFAULTS };
  }
}

function saveConfig() {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

// ── Assets ─────────────────────────────────────────────────────────

function appIcon() {
  const file = process.platform === "win32" ? "icon.ico" : "icon.png";
  return nativeImage.createFromPath(path.join(__dirname, "build", file));
}

// ── WSL boot + keep-alive ──────────────────────────────────────────

function bootWsl() {
  if (process.platform !== "win32" || !config.bootWsl) return;
  const args = [];
  if (config.distro) args.push("-d", config.distro);
  args.push("--exec", "sleep", "infinity");
  try {
    const child = spawn("wsl.exe", args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {
    /* No WSL (remote appUrl setup) — the wait loop decides. */
  }
}

// ── Wait for the web stack ─────────────────────────────────────────

function probe(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      // Anything the server answers means it's up (even a 404).
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function setSplashStatus(text) {
  if (!splashWin || splashWin.isDestroyed()) return;
  void splashWin.webContents
    .executeJavaScript(
      `document.getElementById("status").textContent = ${JSON.stringify(text)};`,
    )
    .catch(() => {});
}

async function waitForServer() {
  const deadline = Date.now() + config.startupTimeoutSec * 1000;
  let attempts = 0;
  while (Date.now() < deadline) {
    if (await probe(config.appUrl)) return true;
    attempts += 1;
    if (attempts === 8) {
      setSplashStatus("BUILDING THE STACK — FIRST BOOT TAKES A FEW MINUTES");
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  return false;
}

// ── Windows ────────────────────────────────────────────────────────

function createSplash() {
  splashWin = new BrowserWindow({
    width: 480,
    height: 300,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    backgroundColor: "#060912",
    icon: appIcon(),
  });
  void splashWin.loadFile(path.join(__dirname, "splash.html"));
  splashWin.on("closed", () => {
    splashWin = null;
  });
}

function createHud() {
  hudWin = new BrowserWindow({
    width: 1600,
    height: 900,
    show: false,
    backgroundColor: "#060912",
    title: "Alfred",
    icon: appIcon(),
    autoHideMenuBar: true,
  });
  void hudWin.loadURL(config.appUrl);
  hudWin.once("ready-to-show", () => {
    if (splashWin) splashWin.close();
    hudWin.show();
    hudWin.maximize();
  });
  // In-app window.open (e.g. the FACE panel's manual LAUNCH button)
  // → real frameless child windows for same-origin pages; anything
  // external (Spotify auth, source links) → the system browser.
  hudWin.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(config.appUrl)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          backgroundColor: "#060912",
          icon: appIcon(),
        },
      };
    }
    void shell.openExternal(url);
    return { action: "deny" };
  });
  // Closing the HUD hides to tray — Alfred (and the face) stay alive.
  hudWin.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      hudWin.hide();
    }
  });
  hudWin.on("closed", () => {
    hudWin = null;
  });
}

// ── Face window on the desk touchscreen ────────────────────────────

function parseResolution(spec) {
  const m = /^(\d{3,5})\s*[x×]\s*(\d{3,5})$/.exec(String(spec).trim().toLowerCase());
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/** display.size is in DIPs — multiply by scaleFactor to compare
 *  against the physical resolution the user configures. */
function physicalSize(d) {
  return {
    w: Math.round(d.size.width * d.scaleFactor),
    h: Math.round(d.size.height * d.scaleFactor),
  };
}

function pickFaceDisplay() {
  const primary = screen.getPrimaryDisplay();
  const secondaries = screen.getAllDisplays().filter((d) => d.id !== primary.id);
  if (secondaries.length === 0) return null;
  const want = config.faceResolution !== "any" ? parseResolution(config.faceResolution) : null;
  const pool = want
    ? secondaries.filter((d) => {
        const p = physicalSize(d);
        return (p.w === want.w && p.h === want.h) || (p.w === want.h && p.h === want.w);
      })
    : secondaries;
  if (pool.length === 0) return null;
  // Electron reports per-display touch capability — the actual
  // touchscreen wins over plain monitors.
  return pool.find((d) => d.touchSupport === "available") ?? pool[0];
}

function openFaceOn(display) {
  if (faceWin) {
    faceWin.setBounds(display.bounds);
    return;
  }
  faceWin = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    fullscreen: true,
    backgroundColor: "#060912",
    title: "Alfred — Face",
    icon: appIcon(),
    autoHideMenuBar: true,
  });
  void faceWin.loadURL(`${config.appUrl}/face`);
  faceWin.on("closed", () => {
    faceWin = null;
    faceAutoOpened = false;
    updateTrayMenu();
  });
  updateTrayMenu();
}

/** Auto mode: keep the face window in sync with connected displays.
 *  Only closes windows it opened itself, so a manual tray launch on
 *  the primary screen is never yanked away. */
function syncFaceWindow() {
  if (config.face !== "auto") return;
  const display = pickFaceDisplay();
  if (display) {
    if (!faceWin) faceAutoOpened = true;
    openFaceOn(display);
  } else if (faceWin && faceAutoOpened) {
    faceWin.close();
  }
}

let displayTimer = null;
function scheduleFaceSync() {
  clearTimeout(displayTimer);
  displayTimer = setTimeout(syncFaceWindow, 800);
}

// ── Permissions: no prompts, ever ──────────────────────────────────

function setupPermissions() {
  const allowed = new Set([
    "media",
    "fullscreen",
    "window-management",
    "window-placement",
    "clipboard-sanitized-write",
    "pointerLock",
  ]);
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowed.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
}

// ── Tray ───────────────────────────────────────────────────────────

function applyLoginItem() {
  if (!app.isPackaged) return; // dev runs shouldn't register login items
  app.setLoginItemSettings({ openAtLogin: !!config.openAtLogin });
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Show HUD",
        click: () => {
          if (hudWin) {
            hudWin.show();
            hudWin.focus();
          }
        },
      },
      {
        label: faceWin ? "Close Face Window" : "Open Face Window",
        click: () => {
          if (faceWin) {
            faceWin.close();
          } else {
            faceAutoOpened = false;
            openFaceOn(pickFaceDisplay() ?? screen.getPrimaryDisplay());
          }
        },
      },
      { type: "separator" },
      {
        label: "Start with Windows",
        type: "checkbox",
        checked: !!config.openAtLogin,
        click: (item) => {
          config.openAtLogin = item.checked;
          saveConfig();
          applyLoginItem();
        },
      },
      {
        label: "Open Config File",
        click: () => {
          saveConfig();
          void shell.openPath(configPath());
        },
      },
      { type: "separator" },
      {
        label: "Quit Alfred",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createTray() {
  try {
    tray = new Tray(appIcon().resize({ width: 16, height: 16 }));
    tray.setToolTip("Alfred");
    tray.on("click", () => {
      if (hudWin) {
        hudWin.show();
        hudWin.focus();
      }
    });
    updateTrayMenu();
  } catch {
    tray = null; // headless/dev environments without a system tray
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────

async function main() {
  loadConfig();
  saveConfig(); // materialise the file so "Open Config File" always works
  app.setAppUserModelId("ai.alfred.desktop");
  Menu.setApplicationMenu(null);
  setupPermissions();
  createTray();
  applyLoginItem();
  createSplash();
  bootWsl();

  console.log(`[alfred-desktop] waiting for ${config.appUrl}`);
  const ready = await waitForServer();
  if (!ready) {
    console.error("[alfred-desktop] stack unreachable — leaving splash up");
    setSplashStatus(
      "BACKEND UNREACHABLE — check WSL: docker compose logs -f",
    );
    return;
  }
  console.log("[alfred-desktop] stack ready — opening HUD");
  createHud();
  syncFaceWindow();
  console.log(
    `[alfred-desktop] displays=${screen.getAllDisplays().length} faceWindow=${faceWin ? "open" : "none"}`,
  );
  screen.on("display-added", scheduleFaceSync);
  screen.on("display-removed", scheduleFaceSync);
  screen.on("display-metrics-changed", scheduleFaceSync);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (hudWin) {
      hudWin.show();
      hudWin.focus();
    }
  });
  app.on("before-quit", () => {
    quitting = true;
  });
  // Keep running in the tray when all windows are closed/hidden.
  app.on("window-all-closed", () => {
    if (quitting) app.quit();
  });
  void app.whenReady().then(main);
}
