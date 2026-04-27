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
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: "var(--accent)",
          boxShadow: isNight
            ? "0 0 10px var(--accent), 0 0 4px var(--accent)"
            : "0 0 6px var(--accent-soft)",
          // Subtle "alive" pulse on the dot in Nightfall.
          animation: isNight
            ? "hud-recording-pulse 1.6s ease-in-out infinite"
            : "none",
        }}
      />
      PROTOCOL · {isNight ? "NIGHTFALL" : "STANDARD"}
    </div>
  );
}
