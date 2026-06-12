"use client";

/**
 * FaceWindow — the standalone page shown on the embedded desk
 * touchscreen (route ``/face``, opened as a popup by the HUD or
 * navigated to directly on the secondary display).
 *
 * Composition:
 *   - WireframeFace fills the viewport (the wire-mesh avatar).
 *   - faceBus subscription feeds it live mode + TTS amplitude from
 *     the HUD window → lip-sync. A stale bus (no heartbeat for 4 s)
 *     degrades gracefully to STANDBY.
 *   - useFaceTracking (MediaPipe, this window's own camera grab)
 *     turns the user's face position into a gaze target so the head
 *     looks directly at them. No camera → ambient idle drift.
 *   - Tap anywhere → toggle fullscreen (kiosk look on the touchscreen).
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { subscribeFaceBus } from "@/lib/faceBus";
import type { OrbMode } from "@/lib/orbState";
import { useFaceTracking } from "@/lib/useFaceTracking";
import { WireframeFace, type GazeTarget } from "@/components/WireframeFace";

const MODE_LABEL: Record<OrbMode, string> = {
  idle: "STANDBY",
  listening: "LISTENING",
  thinking: "PROCESSING",
  speaking: "SPEAKING",
};

const LINK_STALE_MS = 4000;
const LEVEL_STALE_MS = 400;

export function FaceWindow() {
  const busRef = useRef<{ mode: OrbMode; level: number; at: number }>({
    mode: "idle",
    level: 0,
    at: 0,
  });
  const gazeRef = useRef<GazeTarget>({ x: 0, y: 0, active: false });

  const [linked, setLinked] = useState(false);
  const [modeLabel, setModeLabel] = useState("AWAITING HUD LINK");
  const [camEnabled, setCamEnabled] = useState(true);
  const [hintVisible, setHintVisible] = useState(true);

  const {
    status: camStatus,
    face,
    videoRef,
  } = useFaceTracking({ enabled: camEnabled, detectionIntervalMs: 66 });

  useEffect(() => {
    document.title = "Alfred — Face";
  }, []);

  useEffect(
    () =>
      subscribeFaceBus((s) => {
        busRef.current = { mode: s.mode, level: s.level, at: Date.now() };
      }),
    [],
  );

  // Low-frequency chrome refresh — the 3D loop reads refs directly,
  // so React only needs to repaint the text indicators twice a second.
  useEffect(() => {
    const id = window.setInterval(() => {
      const b = busRef.current;
      const fresh = Date.now() - b.at < LINK_STALE_MS;
      setLinked(fresh);
      setModeLabel(fresh ? MODE_LABEL[b.mode] : "AWAITING HUD LINK");
    }, 500);
    return () => window.clearInterval(id);
  }, []);

  // Webcam face → normalized gaze target. The landmarks are already
  // mirrored (selfie view), so "where your image appears" IS the
  // direction you are relative to the screen — the head just looks
  // at that point.
  useEffect(() => {
    if (!face) {
      gazeRef.current = { ...gazeRef.current, active: false };
      return;
    }
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    const cx = face.bbox.x + face.bbox.w / 2;
    const cy = face.bbox.y + face.bbox.h / 2;
    gazeRef.current = {
      x: (cx / vw) * 2 - 1,
      y: (cy / vh) * 2 - 1,
      active: true,
    };
  }, [face]);

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

  const gazeLabel = !camEnabled
    ? "CAM OFF"
    : camStatus === "error"
      ? "CAM OFFLINE"
      : face
        ? "GAZE LOCK"
        : camStatus === "ready"
          ? "SCANNING"
          : "CAM INIT";
  const gazeLocked = camEnabled && !!face;

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

      {/* Hidden camera element required by useFaceTracking. */}
      <video
        ref={videoRef as React.RefObject<HTMLVideoElement>}
        muted
        playsInline
        style={{ display: "none" }}
      />

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
        <button
          data-testid="face-window-camera-toggle"
          onClick={(e) => {
            e.stopPropagation();
            setCamEnabled((v) => !v);
          }}
          style={{
            marginTop: 4,
            background: "transparent",
            border: "1px solid var(--border)",
            color: camEnabled ? "var(--hud)" : "var(--muted)",
            fontFamily: "inherit",
            fontSize: 10,
            letterSpacing: 3,
            padding: "7px 14px",
            cursor: "pointer",
          }}
        >
          CAM {camEnabled ? "ON" : "OFF"}
        </button>
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
