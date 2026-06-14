"use client";

/**
 * FaceWindow — the standalone page shown on the embedded desk
 * touchscreen (route ``/face``, opened as a popup by the HUD or
 * navigated to directly on the secondary display).
 *
 * Composition:
 *   - WireframeFace fills the viewport (the wire-mesh avatar).
 *   - faceBus subscription feeds it live mode + TTS amplitude +
 *     gaze direction from the HUD window. A stale bus (no
 *     heartbeat for 4 s) degrades gracefully to STANDBY + ambient
 *     idle drift.
 *   - Tap anywhere → toggle fullscreen (kiosk look on the touchscreen).
 *
 * Camera ownership: BEFORE 2026-02 this window ran its own
 * ``useFaceTracking`` (a second ``getUserMedia`` call) to drive
 * gaze. That worked in isolation but collided with the HUD's
 * ``useCamera`` the moment the user toggled CAM ON in the HUD —
 * the OS device was already locked by /face, so useCamera failed
 * with NotReadableError and the HUD's camera preview tile sat at
 * ``ERROR``. The user's exact report: "the wire mesh face still
 * follows me but the camera picture just says error on it".
 *
 * Fix: the HUD's face tracker is now the single source of truth.
 * It republishes gaze direction (x, y, active) into the same
 * BroadcastChannel that already carries mode/level for lip-sync.
 * /face just subscribes — no camera grab here. The OS camera
 * light comes on exactly once (when the user toggles CAM ON in
 * the HUD), and both the HUD's preview tile AND this window's
 * wireframe head see the same face data.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { subscribeFaceBus } from "@/lib/faceBus";
import type { OrbMode } from "@/lib/orbState";
import { WireframeFace, type GazeTarget } from "@/components/WireframeFace";

const MODE_LABEL: Record<OrbMode, string> = {
  idle: "STANDBY",
  listening: "LISTENING",
  thinking: "PROCESSING",
  speaking: "SPEAKING",
};

const LINK_STALE_MS = 4000;
const LEVEL_STALE_MS = 400;
/** Gaze decays slightly faster than level — when the HUD's face
 *  tracker loses the user, /face should stop pointing at the old
 *  position within ~600 ms (one slow head turn). The HUD publisher
 *  emits ``gaze: null`` immediately when the face is lost so this
 *  upper bound is only hit if the HUD itself crashes mid-track. */
const GAZE_STALE_MS = 600;

export function FaceWindow() {
  const busRef = useRef<{
    mode: OrbMode;
    level: number;
    /** Last gaze update from the HUD. ``null`` = no face right now;
     *  ``at`` is a separate timestamp because gaze can go stale
     *  faster than the overall HUD link does (a stuck HUD link is
     *  silence; a stale gaze means the user walked away). */
    gaze: GazeTarget | null;
    gazeAt: number;
    at: number;
  }>({
    mode: "idle",
    level: 0,
    gaze: null,
    gazeAt: 0,
    at: 0,
  });
  const gazeRef = useRef<GazeTarget>({ x: 0, y: 0, active: false });

  const [linked, setLinked] = useState(false);
  const [modeLabel, setModeLabel] = useState("AWAITING HUD LINK");
  const [hudHasFace, setHudHasFace] = useState(false);
  const [hintVisible, setHintVisible] = useState(true);

  useEffect(() => {
    document.title = "Alfred — Face";
  }, []);

  useEffect(
    () =>
      subscribeFaceBus((s) => {
        const now = Date.now();
        const prev = busRef.current;
        busRef.current = {
          mode: s.mode,
          level: s.level,
          // Only refresh the gaze timestamp when the HUD actually
          // sent a fresh sample — heartbeat messages with no face
          // arrive with ``gaze: null`` and shouldn't reset
          // gazeAt (we'd never time out otherwise).
          gaze: s.gaze
            ? { x: s.gaze.x, y: s.gaze.y, active: s.gaze.active }
            : prev.gaze,
          gazeAt: s.gaze ? now : prev.gazeAt,
          at: now,
        };
      }),
    [],
  );

  // Low-frequency chrome refresh — the 3D loop reads refs directly,
  // so React only needs to repaint the text indicators twice a
  // second. We also re-derive the freshness of the gaze ref here
  // so the visible indicator and the 3D head agree on whether the
  // HUD currently sees a face.
  useEffect(() => {
    const id = window.setInterval(() => {
      const b = busRef.current;
      const now = Date.now();
      const linkFresh = now - b.at < LINK_STALE_MS;
      const gazeFresh =
        linkFresh && b.gaze !== null && now - b.gazeAt < GAZE_STALE_MS;
      setLinked(linkFresh);
      setModeLabel(linkFresh ? MODE_LABEL[b.mode] : "AWAITING HUD LINK");
      setHudHasFace(gazeFresh && b.gaze?.active === true);
      // Refresh the 3D head's gaze ref. When the gaze goes stale we
      // hand WireframeFace an inactive target — it then falls back
      // to its built-in ambient idle drift instead of locking on
      // whatever the last reported (x, y) was.
      if (gazeFresh && b.gaze && b.gaze.active) {
        gazeRef.current = { x: b.gaze.x, y: b.gaze.y, active: true };
      } else {
        gazeRef.current = { ...gazeRef.current, active: false };
      }
    }, 250);
    return () => window.clearInterval(id);
  }, []);

  // Fade the fullscreen hint after a few seconds.
  useEffect(() => {
    const id = window.setTimeout(() => setHintVisible(false), 8000);
    return () => window.clearTimeout(id);
  }, []);

  const getMode = useCallback((): OrbMode => {
    const b = busRef.current;
    return Date.now() - b.at < LINK_STALE_MS ? b.mode : "idle";
  }, []);
  const getLevel = useCallback((): number => {
    const b = busRef.current;
    return Date.now() - b.at < LEVEL_STALE_MS ? b.level : 0;
  }, []);
  const getGaze = useCallback((): GazeTarget => gazeRef.current, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void document.documentElement.requestFullscreen().catch(() => {});
    }
  }, []);

  // Gaze indicator now reflects what the HUD's face tracker is
  // doing, not a /face-local camera state. Three states map
  // cleanly: no HUD link → "NO HUD"; HUD linked but no face this
  // frame → "SCANNING"; HUD linked AND face present → "GAZE LOCK".
  const gazeLabel = !linked
    ? "NO HUD"
    : hudHasFace
      ? "GAZE LOCK"
      : "SCANNING";
  const gazeLocked = hudHasFace;

  return (
    <div
      data-testid="face-window-root"
      onClick={toggleFullscreen}
      style={{
        position: "fixed",
        inset: 0,
        overflow: "hidden",
        background: "var(--bg)",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        userSelect: "none",
        WebkitUserSelect: "none",
        touchAction: "manipulation",
      }}
    >
      <WireframeFace getMode={getMode} getLevel={getLevel} getGaze={getGaze} />

      {/* ── Top-left: identity + mode ─────────────────────────── */}
      <div
        style={{
          position: "absolute",
          top: 22,
          left: 26,
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            fontSize: 11,
            letterSpacing: 5,
            color: "var(--accent)",
            opacity: 0.85,
          }}
        >
          ALFRED · FACE MODULE
        </div>
        <div
          data-testid="face-window-mode"
          style={{
            marginTop: 8,
            fontSize: 22,
            letterSpacing: 7,
            color: "var(--hud)",
            textShadow: "0 0 18px var(--orb-glow)",
          }}
        >
          {modeLabel}
        </div>
      </div>

      {/* ── Top-right: link + gaze indicators ─────────────────── */}
      <div
        style={{
          position: "absolute",
          top: 24,
          right: 26,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 10,
          fontSize: 10,
          letterSpacing: 3,
        }}
      >
        <div
          data-testid="face-window-link-indicator"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: linked ? "var(--hud)" : "var(--muted)",
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: linked ? "var(--hud)" : "var(--danger)",
              boxShadow: linked ? "0 0 8px var(--orb-glow)" : "none",
            }}
          />
          {linked ? "HUD LINKED" : "NO HUD LINK"}
        </div>
        <div
          data-testid="face-window-gaze-indicator"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: gazeLocked ? "var(--hud)" : "var(--muted)",
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: gazeLocked ? "var(--hud)" : "var(--hud-soft)",
              boxShadow: gazeLocked ? "0 0 8px var(--orb-glow)" : "none",
            }}
          />
          {gazeLabel}
        </div>
      </div>

      {/* ── Bottom: fullscreen hint ────────────────────────────── */}
      <div
        data-testid="face-window-fullscreen-hint"
        style={{
          position: "absolute",
          bottom: 26,
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: 10,
          letterSpacing: 4,
          color: "var(--muted)",
          opacity: hintVisible ? 0.8 : 0,
          transition: "opacity 1200ms ease",
          pointerEvents: "none",
        }}
      >
        TAP ANYWHERE TO TOGGLE FULLSCREEN
      </div>

      {/* Corner brackets — warm accent, matches the HUD frame. */}
      {(["tl", "tr", "bl", "br"] as const).map((c) => (
        <div
          key={c}
          style={{
            position: "absolute",
            width: 26,
            height: 26,
            pointerEvents: "none",
            opacity: 0.55,
            ...(c[0] === "t" ? { top: 10 } : { bottom: 10 }),
            ...(c[1] === "l" ? { left: 10 } : { right: 10 }),
            borderTop: c[0] === "t" ? "1px solid var(--border-warm)" : "none",
            borderBottom: c[0] === "b" ? "1px solid var(--border-warm)" : "none",
            borderLeft: c[1] === "l" ? "1px solid var(--border-warm)" : "none",
            borderRight: c[1] === "r" ? "1px solid var(--border-warm)" : "none",
          }}
        />
      ))}
    </div>
  );
}
