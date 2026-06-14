"use client";

/**
 * /sketch — full-screen Sketch Pad window for the embedded desk
 * touchscreen. Opened as a popup by the SketchPad's POP button (or
 * navigated to directly). State is independent from the main HUD's
 * DESIGN tab — when the user pops out, they're committing to draw
 * on the touchscreen.
 *
 * Same client-only rendering as /face: HTML5 Canvas + Pointer Events
 * have no useful SSR output.
 */

import dynamic from "next/dynamic";

const SketchPad = dynamic(
  () => import("@/components/SketchPad").then((m) => m.SketchPad),
  {
    ssr: false,
    loading: () => (
      <div
        data-testid="sketch-window-loading"
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--bg)",
          color: "var(--orb)",
          fontFamily: "monospace",
          fontSize: 11,
          letterSpacing: 4,
        }}
      >
        INITIALISING SKETCH PAD…
      </div>
    ),
  },
);

export default function SketchPage() {
  // The popped window has no HUD frame — fill the entire viewport
  // so touch input on the embedded touchscreen has the full surface.
  return (
    <main
      data-testid="sketch-window"
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--bg)",
        overflow: "hidden",
      }}
    >
      <SketchPad />
    </main>
  );
}
