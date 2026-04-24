"use client";

import type { Mode } from "@/lib/api";

export function ModeIndicator({ mode }: { mode: Mode }) {
  const isNight = mode === "nightfall";
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 10px",
        border: "1px solid var(--border)",
        borderRadius: 999,
        fontSize: 12,
        letterSpacing: 0.5,
        textTransform: "uppercase",
        color: isNight ? "var(--accent)" : "var(--muted)",
        background: "transparent",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: isNight ? "var(--accent)" : "var(--muted)",
          boxShadow: isNight ? "0 0 8px var(--accent)" : "none",
        }}
      />
      {isNight ? "Nightfall Protocol" : "Standard"}
    </div>
  );
}
