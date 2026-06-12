"use client";

/**
 * FaceModeView — the FACE module control panel, launched from the
 * radial menu (same fullscreen sub-view pattern as Spotify/Workshop).
 *
 * Jobs:
 *   - Manual launch/close of the wire-mesh face window (the user's
 *     requested fallback toggle).
 *   - "SCAN DISPLAYS" → Window Management permission prompt + a list
 *     of every connected monitor, with the auto-launch match flagged.
 *   - Auto-launch config: arm/disarm + the resolution that identifies
 *     the embedded desk touchscreen (browsers can't see which display
 *     is touch-capable, so resolution is the discriminator).
 */

import { useCallback, useEffect, useState } from "react";

import {
  type FaceScreenConfig,
  type ScreenInfo,
  type WmPermissionState,
  closeFaceWindow,
  isFaceWindowOpen,
  loadFaceScreenConfig,
  matchFaceScreen,
  openFaceWindow,
  parseResolution,
  queryWindowManagementPermission,
  saveFaceScreenConfig,
  scanScreens,
  supportsWindowManagement,
} from "@/lib/faceScreen";

interface FaceModeViewProps {
  onBack: () => void;
}

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

export function FaceModeView({ onBack }: FaceModeViewProps) {
  const [cfg, setCfg] = useState<FaceScreenConfig>(() => loadFaceScreenConfig());
  const [resolutionDraft, setResolutionDraft] = useState(
    () => loadFaceScreenConfig().resolution,
  );
  const [screens, setScreens] = useState<ScreenInfo[] | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [perm, setPerm] = useState<WmPermissionState>("unsupported");
  const [winOpen, setWinOpen] = useState(() => isFaceWindowOpen());

  // Permission probe on mount; if already granted, enumerate displays
  // silently (no gesture needed once granted).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const p = await queryWindowManagementPermission();
      if (cancelled) return;
      setPerm(p);
      if (p === "granted") {
        try {
          const s = await scanScreens();
          if (!cancelled) setScreens(s);
        } catch {
          /* ignore — user can scan manually */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll the popup handle so OPEN/CLOSE state stays honest even when
  // the user closes the face window from its own titlebar.
  useEffect(() => {
    const id = window.setInterval(() => setWinOpen(isFaceWindowOpen()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const persist = useCallback((next: FaceScreenConfig) => {
    setCfg(next);
    saveFaceScreenConfig(next);
  }, []);

  const handleScan = useCallback(async () => {
    setScanError(null);
    try {
      const s = await scanScreens();
      setScreens(s);
      setPerm(await queryWindowManagementPermission());
    } catch (e) {
      setScanError(
        e instanceof Error ? e.message : "Display scan failed — permission denied?",
      );
    }
  }, []);

  const matched = screens ? matchFaceScreen(screens, cfg.resolution) : null;

  const handleLaunch = useCallback(() => {
    openFaceWindow(matched);
    setWinOpen(isFaceWindowOpen());
  }, [matched]);

  const handleClose = useCallback(() => {
    closeFaceWindow();
    setWinOpen(false);
  }, []);

  const commitResolution = useCallback(() => {
    const v = resolutionDraft.trim().toLowerCase();
    const valid = v === "any" || parseResolution(v) !== null;
    const next = valid ? v : "any";
    setResolutionDraft(next);
    persist({ ...cfg, resolution: next });
  }, [resolutionDraft, cfg, persist]);

  return (
    <div
      data-testid="face-mode-view"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 8500,
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
        fontFamily: MONO,
        overflowY: "auto",
      }}
    >
      {/* ── Header ─────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 18,
          padding: "18px 28px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <button
          data-testid="face-mode-back-btn"
          onClick={onBack}
          style={{
            background: "transparent",
            border: "1px solid var(--border)",
            color: "var(--hud)",
            fontFamily: MONO,
            fontSize: 11,
            letterSpacing: 3,
            padding: "8px 16px",
            cursor: "pointer",
          }}
        >
          ← BACK
        </button>
        <div>
          <div style={{ fontSize: 13, letterSpacing: 5, color: "var(--hud)" }}>
            FACE · WIRE MESH INTERFACE
          </div>
          <div
            style={{
              fontSize: 10,
              letterSpacing: 2,
              color: "var(--muted)",
              marginTop: 4,
            }}
          >
            Avatar output for the embedded desk touchscreen
          </div>
        </div>
      </div>

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          gap: 22,
          padding: 28,
          maxWidth: 760,
        }}
      >
        {/* ── Launch / close ───────────────────────────────────── */}
        <Section title="OUTPUT">
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <button
              data-testid="face-launch-btn"
              onClick={handleLaunch}
              style={{
                background: "rgba(108, 214, 255, 0.08)",
                border: "1px solid var(--hud-soft)",
                color: "var(--hud)",
                fontFamily: MONO,
                fontSize: 12,
                letterSpacing: 3,
                padding: "14px 26px",
                cursor: "pointer",
                textShadow: "0 0 12px var(--orb-glow)",
              }}
            >
              {winOpen
                ? "FOCUS FACE WINDOW"
                : matched
                  ? `LAUNCH ON ${matched.width}×${matched.height}`
                  : "LAUNCH FACE WINDOW"}
            </button>
            {winOpen ? (
              <button
                data-testid="face-close-btn"
                onClick={handleClose}
                style={{
                  background: "transparent",
                  border: "1px solid var(--border-warm)",
                  color: "var(--accent)",
                  fontFamily: MONO,
                  fontSize: 11,
                  letterSpacing: 3,
                  padding: "14px 22px",
                  cursor: "pointer",
                }}
              >
                CLOSE
              </button>
            ) : null}
            <span
              data-testid="face-window-open-status"
              style={{
                fontSize: 10,
                letterSpacing: 3,
                color: winOpen ? "var(--hud)" : "var(--muted)",
              }}
            >
              {winOpen ? "● WINDOW ACTIVE" : "○ WINDOW CLOSED"}
            </span>
          </div>
          <Hint>
            The window opens on the matched display when one is detected,
            otherwise on this one — drag it over and tap to go fullscreen.
            You can also browse to <span style={{ color: "var(--hud)" }}>/face</span>{" "}
            directly on any device.
          </Hint>
        </Section>

        {/* ── Displays ─────────────────────────────────────────── */}
        <Section title="DISPLAYS">
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <button
              data-testid="face-scan-displays-btn"
              onClick={() => void handleScan()}
              disabled={!supportsWindowManagement()}
              style={{
                background: "transparent",
                border: "1px solid var(--border)",
                color: supportsWindowManagement() ? "var(--hud)" : "var(--muted)",
                fontFamily: MONO,
                fontSize: 11,
                letterSpacing: 3,
                padding: "12px 22px",
                cursor: supportsWindowManagement() ? "pointer" : "not-allowed",
              }}
            >
              SCAN DISPLAYS
            </button>
            <span
              data-testid="face-permission-status"
              style={{ fontSize: 10, letterSpacing: 2, color: "var(--muted)" }}
            >
              {!supportsWindowManagement()
                ? "MULTI-SCREEN API UNAVAILABLE (Chrome/Edge required)"
                : `PERMISSION: ${perm.toUpperCase()}`}
            </span>
          </div>
          {scanError ? (
            <div
              data-testid="face-scan-error"
              style={{ fontSize: 11, color: "var(--danger)", letterSpacing: 1 }}
            >
              {scanError}
            </div>
          ) : null}
          {screens ? (
            <div
              data-testid="face-screen-list"
              style={{ display: "flex", flexDirection: "column", gap: 8 }}
            >
              {screens.map((s, i) => {
                const isMatch =
                  matched !== null &&
                  s.left === matched.left &&
                  s.top === matched.top &&
                  s.width === matched.width;
                return (
                  <div
                    key={`${s.left}:${s.top}:${i}`}
                    data-testid={`face-screen-row-${i}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "10px 14px",
                      border: `1px solid ${isMatch ? "var(--hud-soft)" : "var(--border)"}`,
                      background: isMatch ? "rgba(108,214,255,0.06)" : "transparent",
                      fontSize: 11,
                      letterSpacing: 1,
                    }}
                  >
                    <span style={{ color: "var(--fg)" }}>
                      {s.label || `Display ${i + 1}`}
                    </span>
                    <span style={{ color: "var(--muted)" }}>
                      {s.width}×{s.height}
                    </span>
                    {s.isPrimary ? <Badge>PRIMARY</Badge> : null}
                    {s.isInternal ? <Badge>INTERNAL</Badge> : null}
                    {isMatch ? <Badge hot>FACE TARGET</Badge> : null}
                  </div>
                );
              })}
              {screens.filter((s) => !s.isPrimary).length === 0 ? (
                <Hint>
                  Only one display detected — connect the desk touchscreen
                  and rescan (or it will auto-detect if armed below).
                </Hint>
              ) : null}
            </div>
          ) : (
            <Hint>
              Scan grants the browser&apos;s window-management permission and
              lists every connected monitor.
            </Hint>
          )}
        </Section>

        {/* ── Auto-launch ──────────────────────────────────────── */}
        <Section title="AUTO-DETECT">
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              cursor: "pointer",
              fontSize: 11,
              letterSpacing: 2,
              color: "var(--fg)",
            }}
          >
            <input
              data-testid="face-auto-launch-toggle"
              type="checkbox"
              checked={cfg.autoLaunch}
              onChange={(e) => persist({ ...cfg, autoLaunch: e.target.checked })}
              style={{ width: 16, height: 16, accentColor: "#6cd6ff" }}
            />
            AUTO-LAUNCH WHEN THE DESK SCREEN CONNECTS
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, letterSpacing: 2, color: "var(--muted)" }}>
              MATCH RESOLUTION
            </span>
            <input
              data-testid="face-resolution-input"
              value={resolutionDraft}
              onChange={(e) => setResolutionDraft(e.target.value)}
              onBlur={commitResolution}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitResolution();
              }}
              placeholder="any  ·  1920x1080"
              style={{
                background: "var(--bg-elev)",
                border: "1px solid var(--border)",
                color: "var(--hud)",
                fontFamily: MONO,
                fontSize: 12,
                letterSpacing: 2,
                padding: "10px 14px",
                width: 180,
                outline: "none",
              }}
            />
            <span style={{ fontSize: 10, color: "var(--muted)", letterSpacing: 1 }}>
              &quot;any&quot; = first secondary display
            </span>
          </div>
          <Hint>
            Touch capability isn&apos;t reported per-monitor by browsers, so the
            touchscreen is identified by resolution. Auto-launch opens a
            popup without a click — allow pop-ups for this site in Chrome
            (site settings) the first time it triggers.
          </Hint>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        background: "var(--bg-elev)",
        padding: "18px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div style={{ fontSize: 10, letterSpacing: 4, color: "var(--accent)" }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Badge({ children, hot }: { children: React.ReactNode; hot?: boolean }) {
  return (
    <span
      style={{
        fontSize: 9,
        letterSpacing: 2,
        padding: "3px 8px",
        border: `1px solid ${hot ? "var(--hud-soft)" : "var(--border)"}`,
        color: hot ? "var(--hud)" : "var(--muted)",
      }}
    >
      {children}
    </span>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, lineHeight: 1.7, color: "var(--muted)", letterSpacing: 0.5 }}>
      {children}
    </div>
  );
}
