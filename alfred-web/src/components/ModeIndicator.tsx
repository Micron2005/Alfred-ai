"use client";

import type { Mode } from "@/lib/api";

export function ModeIndicator({ mode }: { mode: Mode }) {
  const isNight = mode === "nightfall";
  return (
    <div
      className="mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        border: `1px solid ${isNight ? "var(--accent)" : "var(--border-warm)"}`,
        borderRadius: 3,
        fontSize: 10,
        color: isNight ? "var(--accent)" : "var(--accent)",
        background: isNight
          ? "rgba(194, 69, 31, 0.12)"
          : "rgba(214, 168, 90, 0.06)",
        boxShadow: isNight
          ? "0 0 12px var(--accent-soft), inset 0 0 12px rgba(194, 69, 31, 0.15)"
          : "none",
        transition: "all 300ms ease",
      }}
      title={
        isNight
          ? "Nightfall Protocol — Batman-mode persona is active."
          : "Standard mode — Alfred persona is active."
      }
    >
      <span
        aria-hidden
        // Nightfall gets an accent-coloured "alive" pulse via a
        // dedicated keyframe (``hud-accent-pulse``). The previous
        // version reused ``hud-recording-pulse`` which hardcoded a
        // bright red box-shadow, painting over the dot's amber glow
        // through the animation.
        className={isNight ? "hud-pulse-accent" : undefined}
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: "var(--accent)",
          // Standard mode keeps a static soft glow; Nightfall's box
          // shadow is controlled by the keyframes, so leaving this
          // unset for nightfall avoids fighting the animation on
          // first render.
          boxShadow: isNight ? undefined : "0 0 6px var(--accent-soft)",
        }}
      />
      PROTOCOL · {isNight ? "NIGHTFALL" : "STANDARD"}
    </div>
  );
}
