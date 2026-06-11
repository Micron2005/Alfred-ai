"use client";

/**
 * SystemStatus — pill-style indicator stack pinned top-right of the
 * HUD tab. Each row is a label + small status dot:
 *   · green  — ok / live
 *   · amber  — starting / paused / partial
 *   · red    — error
 *   · grey   — idle / off
 *
 * Indicators are passed in as a list so the parent can plug whatever
 * signals it wants (wake word, camera, hand tracking, API, …).
 */

export type IndicatorState = "ok" | "warn" | "err" | "off";

export interface Indicator {
  id: string;
  label: string;
  state: IndicatorState;
  hint?: string;
}

const COLOURS: Record<IndicatorState, string> = {
  ok: "#5be38f",
  warn: "#e6c247",
  err: "#ff7b7b",
  off: "rgba(140, 150, 165, 0.55)",
};

interface Props {
  title?: string;
  indicators: Indicator[];
}

export function SystemStatus({ title = "SYSTEM STATUS", indicators }: Props) {
  return (
    <div
      data-testid="system-status-pill"
      style={{
        // Position is now controlled by the parent HudWidget wrapper —
        // SystemStatus is a regular block element. (Used to be
        // ``position: fixed`` pinned to the top-right corner; that
        // prevented it from being moved in customize mode.)
        padding: "10px 14px 12px",
        minWidth: 180,
        background:
          "linear-gradient(180deg, rgba(8,12,22,0.78), rgba(8,12,22,0.55))",
        border: "1px solid var(--border)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
      }}
    >
      <p
        className="mono"
        style={{
          margin: "0 0 8px",
          fontSize: 9,
          letterSpacing: 2.5,
          color: "var(--hud)",
          textShadow: "0 0 6px var(--orb-glow)",
          opacity: 0.9,
        }}
      >
        {title}
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {indicators.map((it) => (
          <Row key={it.id} indicator={it} />
        ))}
      </div>
    </div>
  );
}

function Row({ indicator }: { indicator: Indicator }) {
  const colour = COLOURS[indicator.state];
  return (
    <div
      data-testid={`status-row-${indicator.id}`}
      title={indicator.hint}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <span
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: 1.2,
          color: "var(--fg)",
          opacity: 0.85,
          textTransform: "uppercase",
        }}
      >
        {indicator.label}
      </span>
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: colour,
          boxShadow:
            indicator.state === "off"
              ? "none"
              : `0 0 8px ${colour}, 0 0 2px ${colour}`,
          transition: "background 200ms ease",
          flexShrink: 0,
        }}
      />
    </div>
  );
}
