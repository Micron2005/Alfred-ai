"use client";

/**
 * GreetingCard — JARVIS-style framed greeting beneath the orb.
 *
 * Replaces the loose italic line under the ALFRED wordmark with a
 * proper bordered card. Persona attribution sits below the greeting
 * in muted monospace.
 */

interface Props {
  greeting: string;
  status?: string;
  attribution?: string;
}

export function GreetingCard({
  greeting,
  status,
  attribution = "Alfred · resident butler",
}: Props) {
  return (
    <div
      data-testid="greeting-card"
      style={{
        margin: "8px auto 0",
        padding: "10px 22px",
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        border: "1px solid var(--border)",
        background:
          "linear-gradient(180deg, rgba(108,214,255,0.04), rgba(108,214,255,0.01))",
        minWidth: 240,
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: 14,
          fontStyle: "italic",
          color: "var(--fg)",
          letterSpacing: 0.4,
        }}
      >
        {greeting}
      </p>
      {status ? (
        <p
          className="mono"
          style={{
            margin: 0,
            fontSize: 9,
            letterSpacing: 2.5,
            color: "var(--hud)",
            textTransform: "uppercase",
            opacity: 0.85,
          }}
        >
          · {status} ·
        </p>
      ) : null}
      <p
        className="mono"
        style={{
          margin: 0,
          fontSize: 8,
          letterSpacing: 2,
          color: "var(--muted)",
          textTransform: "uppercase",
        }}
      >
        {attribution}
      </p>
    </div>
  );
}
