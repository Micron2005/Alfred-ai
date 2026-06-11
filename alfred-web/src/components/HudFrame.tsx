"use client";

/**
 * HudFrame — JARVIS-style corner brackets around the HUD tab.
 *
 * Pure CSS-decoration; ``pointer-events: none``. Visible only on
 * the HUD tab (parent gates with ``enabled``).
 */

interface Props {
  enabled: boolean;
}

const COLOUR = "rgba(108, 214, 255, 0.55)";
const LEN = 36;
const INSET = 12;
const STROKE = 1.5;

const cornerBase: React.CSSProperties = {
  position: "fixed",
  width: LEN,
  height: LEN,
  pointerEvents: "none",
  zIndex: 9990,
};

export function HudFrame({ enabled }: Props) {
  if (!enabled) return null;
  return (
    <>
      {/* Top-left */}
      <div
        aria-hidden
        style={{
          ...cornerBase,
          top: INSET,
          left: INSET,
          borderTop: `${STROKE}px solid ${COLOUR}`,
          borderLeft: `${STROKE}px solid ${COLOUR}`,
        }}
      />
      {/* Top-right */}
      <div
        aria-hidden
        style={{
          ...cornerBase,
          top: INSET,
          right: INSET,
          borderTop: `${STROKE}px solid ${COLOUR}`,
          borderRight: `${STROKE}px solid ${COLOUR}`,
        }}
      />
      {/* Bottom-left */}
      <div
        aria-hidden
        style={{
          ...cornerBase,
          bottom: INSET,
          left: INSET,
          borderBottom: `${STROKE}px solid ${COLOUR}`,
          borderLeft: `${STROKE}px solid ${COLOUR}`,
        }}
      />
      {/* Bottom-right */}
      <div
        aria-hidden
        style={{
          ...cornerBase,
          bottom: INSET,
          right: INSET,
          borderBottom: `${STROKE}px solid ${COLOUR}`,
          borderRight: `${STROKE}px solid ${COLOUR}`,
        }}
      />
    </>
  );
}
