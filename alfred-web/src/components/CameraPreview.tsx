"use client";

/**
 * CameraPreview — visible live feed of the camera stream while
 * ``cameraOn`` is true. Sits in the JARVIS HUD so the user can see
 * what Alfred is looking at without needing to open a separate
 * window or trust the face-count badge alone.
 *
 * Implementation note: the existing camera pipeline drives a hidden
 * ``<video>`` for face detection (kept off-screen so React doesn't
 * unmount it on tab/sidebar changes — see ``useCamera``). Rather
 * than un-hide that element (which would change the layout
 * containment of the detection pipeline), this component renders
 * its own ``<video>`` and attaches the same ``MediaStream`` via
 * ``srcObject``. Multiple ``<video>``s can render the same stream
 * simultaneously without conflict.
 */

import { useEffect, useRef } from "react";
import type { CameraStatus } from "@/lib/useCamera";

interface Props {
  status: CameraStatus;
  faceCount: number;
  streamRef: React.RefObject<MediaStream | null>;
  /** When ``true``, the parent has hidden the widget via the
   *  customize toolbar (or the camera is simply off). The component
   *  still mounts but renders nothing visible — keeps the preview
   *  ``<video>`` alive so re-enabling is instant. */
  hidden?: boolean;
}

export function CameraPreview({
  status,
  faceCount,
  streamRef,
  hidden,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Whenever the camera status flips to ``ready``, attach the
  // shared stream to our visible <video>. We re-run on every
  // status change so a teardown-and-restart cycle re-attaches
  // properly. ``streamRef`` is a stable ref, hence not in deps.
  useEffect(() => {
    const v = videoRef.current;
    const stream = streamRef.current;
    if (!v) return;
    if (status === "ready" && stream) {
      if (v.srcObject !== stream) {
        v.srcObject = stream;
        // ``play()`` may reject if the user hasn't interacted yet;
        // since we only attach after they've clicked the camera
        // toggle this is safe in practice. Catch defensively.
        void v.play().catch(() => {
          /* ignored — autoplay restriction or remount race */
        });
      }
    } else {
      v.srcObject = null;
    }
  }, [status, streamRef]);

  if (hidden || status === "off") {
    return (
      <div data-camera-preview="hidden" style={{ display: "none" }} />
    );
  }

  const statusLabel =
    status === "starting"
      ? "STARTING…"
      : status === "error"
        ? "ERROR"
        : status === "ready"
          ? `FACES · ${faceCount}`
          : "OFF";

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: 140,
        background: "rgba(8, 14, 24, 0.85)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        boxShadow: "0 0 18px rgba(108, 214, 255, 0.08)",
        overflow: "hidden",
      }}
    >
      {/*
        ``transform: scaleX(-1)`` mirrors the feed left-to-right so
        the user sees themselves the way they'd expect (matches the
        mental model of a mirror, like webcam apps do).
      */}
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        aria-label="Live camera preview"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: "scaleX(-1)",
          background: "#000",
        }}
      />

      {/* Top-left status badge — face count or live state */}
      <div
        className="mono"
        style={{
          position: "absolute",
          top: 6,
          left: 6,
          padding: "2px 8px",
          background: "rgba(8, 14, 24, 0.7)",
          border: "1px solid var(--hud)",
          borderRadius: 2,
          color: "var(--hud)",
          fontSize: 10,
          letterSpacing: 1.5,
          textShadow: "0 0 6px var(--orb-glow)",
          pointerEvents: "none",
        }}
      >
        📷 {statusLabel}
      </div>

      {/* JARVIS-style corner brackets so the preview reads as part
          of the HUD rather than a generic webcam window. */}
      <div aria-hidden style={cornerStyle("topLeft")} />
      <div aria-hidden style={cornerStyle("topRight")} />
      <div aria-hidden style={cornerStyle("bottomLeft")} />
      <div aria-hidden style={cornerStyle("bottomRight")} />
    </div>
  );
}

function cornerStyle(
  pos: "topLeft" | "topRight" | "bottomLeft" | "bottomRight",
): React.CSSProperties {
  const len = 14;
  const thick = 1;
  const color = "var(--accent)";
  const base: React.CSSProperties = {
    position: "absolute",
    width: len,
    height: len,
    pointerEvents: "none",
    opacity: 0.6,
  };
  switch (pos) {
    case "topLeft":
      return {
        ...base,
        top: 0,
        left: 0,
        borderTop: `${thick}px solid ${color}`,
        borderLeft: `${thick}px solid ${color}`,
      };
    case "topRight":
      return {
        ...base,
        top: 0,
        right: 0,
        borderTop: `${thick}px solid ${color}`,
        borderRight: `${thick}px solid ${color}`,
      };
    case "bottomLeft":
      return {
        ...base,
        bottom: 0,
        left: 0,
        borderBottom: `${thick}px solid ${color}`,
        borderLeft: `${thick}px solid ${color}`,
      };
    case "bottomRight":
      return {
        ...base,
        bottom: 0,
        right: 0,
        borderBottom: `${thick}px solid ${color}`,
        borderRight: `${thick}px solid ${color}`,
      };
  }
}
