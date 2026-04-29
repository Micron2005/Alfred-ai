"use client";

/**
 * ExpressionReadout — small JARVIS-style HUD strip that shows the
 * **dominant facial expression** Alfred currently detects.
 *
 * Replaces the older ``FaceMesh`` overlay. The user explicitly
 * asked for "no face mesh on top of me" but still wants Alfred to
 * be aware of expressions, so we draw nothing on the face itself
 * — just a tiny readout pinned to the bottom-right corner of the
 * viewport.
 *
 * Auto-hides when no face is in frame so the strip doesn't sit
 * there showing stale data when the room is empty.
 */

import { useEffect, useRef, useState } from "react";

import type { FaceState } from "@/lib/useFaceTracking";

interface Props {
  enabled: boolean;
  face: FaceState | null;
}

/**
 * MediaPipe blendshape category names like ``"mouthSmileLeft"``
 * are turned into compact, human-readable labels here. Showing
 * just the side-stripped action (e.g. "Smile") reads better than
 * the raw category for a HUD strip.
 */
function humanizeBlendshape(name: string): string {
  // Strip directional suffixes ("Left" / "Right") so left/right
  // halves of the same expression collapse to a single label —
  // "mouthSmileLeft" → "mouthSmile" → "Mouth smile".
  let cleaned = name.replace(/(Left|Right)$/, "");
  // Strip the redundant "mouth" / "brow" / "eye" prefix the user
  // doesn't need to see — keep the expressive verb only.
  cleaned = cleaned.replace(/^(mouth|brow|eye|cheek|nose|jaw)/, "").trim();
  if (!cleaned) cleaned = name;
  // Insert a space before each capital, lower-case the rest, then
  // capitalise the first letter.
  const titled = cleaned
    .replace(/([A-Z])/g, " $1")
    .trim()
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
  return titled || name;
}

/**
 * Map a blendshape name to a colour so the strip reads more like
 * a control-panel indicator and less like a debug log. Smiles /
 * pleasant categories go warm; frowns / surprise go cool.
 */
function colourFor(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("smile") || n.includes("cheekup")) return "rgba(102, 240, 160, 0.95)";
  if (n.includes("frown") || n.includes("sad") || n.includes("anger"))
    return "rgba(255, 120, 120, 0.95)";
  if (n.includes("brow") || n.includes("surprise")) return "rgba(255, 200, 60, 0.95)";
  if (n.includes("eye") || n.includes("blink")) return "rgba(108, 214, 255, 0.92)";
  return "rgba(108, 214, 255, 0.92)";
}

export function ExpressionReadout({ enabled, face }: Props) {
  // Hold the last seen expression for a beat after the face leaves
  // frame so quick blinks / head turns don't make the strip jitter
  // off and back on.
  const [lastSeen, setLastSeen] = useState<{
    name: string;
    score: number;
    at: number;
  } | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      setLastSeen(null);
      return;
    }
    if (face?.dominantExpression) {
      setLastSeen({
        name: face.dominantExpression.name,
        score: face.dominantExpression.score,
        at: performance.now(),
      });
    }
  }, [enabled, face]);

  // Fade the strip out 1.5 s after the last detection so it
  // doesn't linger forever showing a stale read.
  useEffect(() => {
    if (!lastSeen) return;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      setLastSeen(null);
      timerRef.current = null;
    }, 1500);
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [lastSeen]);

  if (!enabled || !lastSeen) return null;

  // Don't show very weak detections — saves the user from seeing
  // "neutral-ish micro-expression" noise.
  if (lastSeen.score < 0.15) return null;

  const label = humanizeBlendshape(lastSeen.name);
  const colour = colourFor(lastSeen.name);

  return (
    <div
      data-testid="expression-readout"
      aria-hidden
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        padding: "5px 10px",
        background: "rgba(8, 14, 24, 0.78)",
        border: `1px solid ${colour}`,
        borderRadius: 999,
        backdropFilter: "blur(8px)",
        boxShadow: `0 0 10px ${colour}`,
        fontFamily:
          'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
        fontSize: 10,
        color: colour,
        pointerEvents: "none",
        zIndex: 99996,
        display: "flex",
        alignItems: "center",
        gap: 6,
        textTransform: "uppercase",
        letterSpacing: 1.2,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: colour,
          boxShadow: `0 0 6px ${colour}`,
        }}
      />
      <span>{label}</span>
      <span style={{ opacity: 0.6 }}>
        {(lastSeen.score * 100).toFixed(0)}%
      </span>
    </div>
  );
}
