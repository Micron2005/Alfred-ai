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
/**
 * Gaze decay window. Set high enough that brief detection
 * dropouts (MediaPipe occasionally misses a frame or two when
 * the user blinks, looks down, or briefly leaves the frame
 * edge) don't cause the wireframe head to snap to centre and
 * back — that bounce was the user-reported "constantly
 * rescanning where I am and thinks I'm moving around" issue.
 *
 * 2.5 s is long enough to ride out short MediaPipe stalls but
 * short enough that the head DOES recentre if the user actually
 * walks away (any longer feels uncanny — the head keeps staring
 * at the empty chair).
 */
const GAZE_STALE_MS = 2500;
/**
 * Per-frame EMA blend weight for incoming gaze samples. New
 * sample contributes ``GAZE_SMOOTH`` of its value, the running
 * smoothed value contributes ``1 - GAZE_SMOOTH``. Low values =
 * heavy smoothing (laggy but rock-steady); high values =
 * snappy (responsive but noisier). 0.18 lands in the sweet
 * spot where micro-jitter from MediaPipe's per-frame
 * bounding-box noise is filtered out but real head movement
 * still tracks within ~150 ms.
 */
const GAZE_SMOOTH = 0.18;

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
      // Refresh the 3D head's gaze ref with EMA smoothing. The
      // raw per-frame samples from MediaPipe shake a few pixels
      // each frame even when the user is still — without
      // smoothing the head jitters around them. When the gaze
      // goes stale we hand WireframeFace an inactive target so
      // it falls back to its built-in ambient idle drift instead
      // of locking on whatever the last reported (x, y) was.
      if (gazeFresh && b.gaze && b.gaze.active) {
        const prev = gazeRef.current;
        const w = GAZE_SMOOTH;
        // If the previous sample was inactive (user just walked
        // back in), snap to the new value rather than easing in
        // from (0,0) — that ease-in reads as the head "scanning"
        // the room before finding you, which feels weirder than
        // an instant lock.
        const x = prev.active ? prev.x * (1 - w) + b.gaze.x * w : b.gaze.x;
        const y = prev.active ? prev.y * (1 - w) + b.gaze.y * w : b.gaze.y;
        gazeRef.current = { x, y, active: true };
      } else {
        gazeRef.current = { ...gazeRef.current, active: false };
      }
    }, 50);
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
