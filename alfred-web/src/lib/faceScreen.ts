"use client";

/**
 * faceScreen — multi-monitor detection + face-window lifecycle for
 * the embedded 15" touchscreen in the desk.
 *
 * Built on the Window Management API (Chrome 100+):
 *   - ``window.getScreenDetails()`` enumerates every connected
 *     display (position, resolution, primary/internal flags, label).
 *     Requires the "window-management" permission — the prompt only
 *     fires from a user gesture, which is why the FACE panel has an
 *     explicit "SCAN DISPLAYS" button.
 *   - ``screenschange`` events fire when a monitor is plugged or
 *     unplugged — that's the auto-detect hook: desk screen comes
 *     online → face window opens on it automatically.
 *
 * Browsers cannot tell WHICH display is the touchscreen (touch is
 * reported globally, not per-monitor), so matching is done by
 * resolution: the user configures e.g. "1920x1080" (or "any" to take
 * the first secondary display).
 *
 * Note on popups: auto-launch fires ``window.open`` without a user
 * gesture, so Chrome's popup blocker must be set to allow popups for
 * this origin (one-time site setting — fine for a personal kiosk).
 * The FACE panel surfaces this in its help copy.
 */

// ── Minimal Window Management API typings ──────────────────────────
// (Not yet in the bundled TS lib; declared locally and cast.)

export interface ScreenInfo {
  left: number;
  top: number;
  width: number;
  height: number;
  availLeft: number;
  availTop: number;
  availWidth: number;
  availHeight: number;
  isPrimary: boolean;
  isInternal: boolean;
  label: string;
  devicePixelRatio: number;
}

interface ScreenDetailsLike extends EventTarget {
  screens: ScreenInfo[];
  currentScreen: ScreenInfo;
}

interface WindowWithScreenDetails extends Window {
  getScreenDetails: () => Promise<ScreenDetailsLike>;
}

// ── Config persistence ─────────────────────────────────────────────

export interface FaceScreenConfig {
  /** Auto-open the face window when a matching display connects. */
  autoLaunch: boolean;
  /** "any" = first secondary display, else "WIDTHxHEIGHT" match
   *  (orientation-agnostic, so 1080x1920 matches 1920x1080). */
  resolution: string;
}

const CONFIG_KEY = "alfred.faceScreen";

/** Fired on window whenever the config changes or a scan grants the
 *  window-management permission — the auto-launch watcher re-arms. */
export const FACE_CONFIG_EVENT = "alfred:face-config-changed";

export function loadFaceScreenConfig(): FaceScreenConfig {
  if (typeof window === "undefined") return { autoLaunch: false, resolution: "any" };
  try {
    const raw = window.localStorage.getItem(CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<FaceScreenConfig>;
      return {
        autoLaunch: parsed.autoLaunch === true,
        resolution:
          typeof parsed.resolution === "string" && parsed.resolution.trim()
            ? parsed.resolution.trim().toLowerCase()
            : "any",
      };
    }
  } catch {
    /* corrupt entry → defaults */
  }
  return { autoLaunch: false, resolution: "any" };
}

export function saveFaceScreenConfig(cfg: FaceScreenConfig): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  window.dispatchEvent(new Event(FACE_CONFIG_EVENT));
}

// ── Window Management API access ───────────────────────────────────

export function supportsWindowManagement(): boolean {
  return typeof window !== "undefined" && "getScreenDetails" in window;
}

export type WmPermissionState = PermissionState | "unsupported";

export async function queryWindowManagementPermission(): Promise<WmPermissionState> {
  if (!supportsWindowManagement() || !navigator.permissions?.query) {
    return "unsupported";
  }
  // Chrome renamed "window-placement" → "window-management"; try both.
  for (const name of ["window-management", "window-placement"]) {
    try {
      const res = await navigator.permissions.query({
        name: name as PermissionName,
      });
      return res.state;
    } catch {
      /* name not recognised in this browser — try the next */
    }
  }
  return "unsupported";
}

/** Raw ScreenDetails handle — keep it if you need ``screenschange``. */
async function getScreenDetailsRaw(): Promise<ScreenDetailsLike> {
  return (window as unknown as WindowWithScreenDetails).getScreenDetails();
}

/**
 * Enumerate connected displays. From a user gesture this triggers
 * the permission prompt on first use; afterwards it resolves
 * silently. Throws if unsupported or the permission was denied.
 */
export async function scanScreens(): Promise<ScreenInfo[]> {
  if (!supportsWindowManagement()) {
    throw new Error("Window Management API unavailable in this browser.");
  }
  const details = await getScreenDetailsRaw();
  window.dispatchEvent(new Event(FACE_CONFIG_EVENT));
  return details.screens.map(cloneScreenInfo);
}

function cloneScreenInfo(s: ScreenInfo): ScreenInfo {
  return {
    left: s.left,
    top: s.top,
    width: s.width,
    height: s.height,
    availLeft: s.availLeft,
    availTop: s.availTop,
    availWidth: s.availWidth,
    availHeight: s.availHeight,
    isPrimary: s.isPrimary,
    isInternal: s.isInternal,
    label: s.label,
    devicePixelRatio: s.devicePixelRatio,
  };
}

export function parseResolution(
  spec: string,
): { w: number; h: number } | null {
  const m = /^(\d{3,5})\s*[x×]\s*(\d{3,5})$/.exec(spec.trim().toLowerCase());
  if (!m) return null;
  return { w: Number(m[1]), h: Number(m[2]) };
}

/**
 * Pick the display the face window should live on. Only secondary
 * (non-primary) screens are considered — the HUD owns the primary.
 */
export function matchFaceScreen(
  screens: ScreenInfo[],
  resolution: string,
): ScreenInfo | null {
  const secondary = screens.filter((s) => !s.isPrimary);
  if (secondary.length === 0) return null;
  if (resolution === "any") return secondary[0];
  const want = parseResolution(resolution);
  if (!want) return secondary[0];
  return (
    secondary.find(
      (s) =>
        (s.width === want.w && s.height === want.h) ||
        (s.width === want.h && s.height === want.w),
    ) ?? null
  );
}

// ── Face window lifecycle ──────────────────────────────────────────

let faceWin: Window | null = null;
let autoOpened = false;

/**
 * Open (or focus) the face window. With a target screen, the popup
 * is positioned to fill that display — the window itself offers
 * tap-to-fullscreen for the borderless kiosk look.
 */
export function openFaceWindow(screen?: ScreenInfo | null): Window | null {
  if (faceWin && !faceWin.closed) {
    faceWin.focus();
    return faceWin;
  }
  let features = "popup=yes,width=1280,height=800";
  if (screen) {
    features = [
      "popup=yes",
      `left=${screen.availLeft}`,
      `top=${screen.availTop}`,
      `width=${screen.availWidth}`,
      `height=${screen.availHeight}`,
    ].join(",");
  }
  faceWin = window.open("/face", "alfred-face", features);
  autoOpened = false;
  return faceWin;
}

export function closeFaceWindow(): void {
  if (faceWin && !faceWin.closed) {
    try {
      faceWin.close();
    } catch {
      /* ignore */
    }
  }
  faceWin = null;
  autoOpened = false;
}

export function isFaceWindowOpen(): boolean {
  return !!(faceWin && !faceWin.closed);
}

// ── Auto-launch watcher ────────────────────────────────────────────

/**
 * Arm monitor auto-detection. Call once from the desktop shell;
 * returns a stop function.
 *
 * Lifecycle:
 *   1. If the window-management permission is already granted,
 *      grab ScreenDetails and listen for ``screenschange``.
 *   2. On every change (and once at start): if auto-launch is
 *      enabled and a matching secondary display is present, open
 *      the face window on it; if the display vanished and WE opened
 *      the window, close it again.
 *   3. ``FACE_CONFIG_EVENT`` re-runs init — covers "user just
 *      granted permission / toggled auto-launch in the FACE panel"
 *      without a page reload.
 */
export function startFaceAutoLaunch(): () => void {
  if (typeof window === "undefined") return () => {};
  let stopped = false;
  let details: ScreenDetailsLike | null = null;

  const evaluate = () => {
    if (stopped || !details) return;
    const cfg = loadFaceScreenConfig();
    if (!cfg.autoLaunch) return;
    const screens = details.screens.map(cloneScreenInfo);
    const match = matchFaceScreen(screens, cfg.resolution);
    if (match && !isFaceWindowOpen()) {
      const w = openFaceWindow(match);
      if (w) autoOpened = true;
    } else if (!match && isFaceWindowOpen() && autoOpened) {
      // The desk screen went away — retire the avatar with it.
      closeFaceWindow();
    }
  };

  const init = async () => {
    if (stopped) return;
    if (!details) {
      if (!supportsWindowManagement()) return;
      const perm = await queryWindowManagementPermission();
      if (perm !== "granted" || stopped) return;
      try {
        details = await getScreenDetailsRaw();
      } catch {
        return;
      }
      if (stopped) return;
      details.addEventListener("screenschange", evaluate);
    }
    evaluate();
  };

  const onConfig = () => {
    void init();
  };
  window.addEventListener(FACE_CONFIG_EVENT, onConfig);
  void init();

  return () => {
    stopped = true;
    window.removeEventListener(FACE_CONFIG_EVENT, onConfig);
    details?.removeEventListener("screenschange", evaluate);
  };
}
