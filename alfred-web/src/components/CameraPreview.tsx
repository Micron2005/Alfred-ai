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
  /** Optional name label drawn just above the detected face, like
   *  Iron Man's HUD callouts. Pass ``null`` when no face is
   *  recognised; the component then renders nothing. */
  recognizedName?: string | null;
  /** Bounding box of the recognised face in *viewport pixels*, as
   *  returned by ``useFaceTracking``. The component reprojects it
   *  into the preview's local coordinate system + flips horizontally
   *  to match the mirrored ``transform: scaleX(-1)`` video. */
  faceBbox?: { x: number; y: number; w: number; h: number } | null;
  /** Whether the recognised face is the registered admin. Drawn as
   *  a small "ADMIN" sub-label so the user knows Nightfall is
   *  unlocked by their face right now. */
  isAdmin?: boolean;
}

export function CameraPreview({
  status,
  faceCount,
  streamRef,
  hidden,
  recognizedName,
  faceBbox,
  isAdmin,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

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

  // Project ``faceBbox`` (in viewport pixels, same coord space as
  // the on-page MediaPipe overlay) into the preview's local
  // coordinate system. Two transforms in play:
  //   1. Translate from the container's bounding-rect origin so
  //      0,0 is the top-left of *this* preview, not the page.
  //   2. The video is rendered mirrored (``scaleX(-1)``) so the X
  //      axis is flipped — we mirror our label's X position too.
  function localFaceRect():
    | { left: number; top: number; width: number; height: number }
    | null {
    if (!faceBbox || !containerRef.current) return null;
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    // The MediaPipe bbox is relative to the *page*; we need it
    // relative to the preview. Most of the time the bbox is for
    // the hidden detection video, which renders at its own size,
    // so we approximate by treating the bbox as a fraction of
    // window viewport, then re-scaling onto the preview rect.
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    const fx = faceBbox.x / vw;
    const fy = faceBbox.y / vh;
    const fw = faceBbox.w / vw;
    const fh = faceBbox.h / vh;
    // Mirror horizontally so the label sticks to the same face the
    // user sees in the (mirrored) preview, not the inverted side.
    const left = (1 - fx - fw) * rect.width;
    const top = fy * rect.height;
    return {
      left,
      top,
      width: fw * rect.width,
      height: fh * rect.height,
    };
  }
  const faceRect = recognizedName ? localFaceRect() : null;

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
      ref={containerRef}
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

      {/* Name label floating above the recognised face, JARVIS
          style — small bordered pill with the enrollment name and
          (optionally) an ADMIN sub-line. Falls back to a top-centre
          banner when the face's bbox isn't available yet so the
          label still appears the moment Alfred recognises someone. */}
      {recognizedName ? (
        faceRect ? (
          <div
            data-testid="face-name-label"
            style={{
              position: "absolute",
              left: faceRect.left + faceRect.width / 2,
              top: Math.max(4, faceRect.top - 26),
              transform: "translateX(-50%)",
              padding: "2px 10px",
              background: "rgba(8, 14, 24, 0.85)",
              border: `1px solid ${isAdmin ? "var(--accent)" : "var(--hud)"}`,
              color: isAdmin ? "var(--accent)" : "var(--hud)",
              fontSize: 11,
              letterSpacing: 1.2,
              fontFamily: "var(--font-mono, monospace)",
              textShadow: "0 0 6px rgba(108,214,255,0.6)",
              pointerEvents: "none",
              whiteSpace: "nowrap",
              maxWidth: "80%",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {recognizedName}
            {isAdmin ? (
              <span
                style={{
                  marginLeft: 6,
                  fontSize: 8,
                  letterSpacing: 1.5,
                  opacity: 0.85,
                }}
              >
                · ADMIN
              </span>
            ) : null}
          </div>
        ) : (
          <div
            data-testid="face-name-label-fallback"
            style={{
              position: "absolute",
              top: 6,
              left: "50%",
              transform: "translateX(-50%)",
              padding: "2px 10px",
              background: "rgba(8, 14, 24, 0.7)",
              border: `1px solid ${isAdmin ? "var(--accent)" : "var(--hud)"}`,
              color: isAdmin ? "var(--accent)" : "var(--hud)",
              fontSize: 10,
              letterSpacing: 1.2,
              fontFamily: "var(--font-mono, monospace)",
              pointerEvents: "none",
            }}
          >
            {recognizedName}
            {isAdmin ? " · ADMIN" : ""}
          </div>
        )
      ) : null}

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
