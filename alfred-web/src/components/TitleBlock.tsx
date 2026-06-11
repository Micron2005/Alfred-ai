"use client";

/**
 * TitleBlock — JARVIS-style framed wordmark.
 *
 * A bordered rectangle around the "ALFRED" lettering with thin corner
 * notches. Used on the HUD tab as a header centerpiece. Pure CSS,
 * no external assets.
 */

interface Props {
  text?: string;
  subtitle?: string;
}

const NOTCH_LEN = 14;
const NOTCH_STROKE = 1.5;

export function TitleBlock({ text = "ALFRED", subtitle }: Props) {
  return (
    <div
      style={{
        position: "relative",
        padding: "14px 36px 12px",
        margin: "12px auto 0",
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        border: "1px solid var(--border)",
        background:
          "linear-gradient(180deg, rgba(108,214,255,0.06), rgba(108,214,255,0.02))",
        boxShadow: "inset 0 0 24px rgba(108,214,255,0.05)",
      }}
      aria-label={`${text} title block`}
    >
      {/* Corner notches — small L-shaped marks just outside each
          corner so the frame reads as a JARVIS title plate. */}
      <Notch position="tl" />
      <Notch position="tr" />
      <Notch position="bl" />
      <Notch position="br" />

      <h1
        className="mono"
        style={{
          margin: 0,
          fontSize: 24,
          letterSpacing: 10,
          color: "var(--hud)",
          textShadow: "0 0 14px var(--orb-glow)",
          fontWeight: 500,
          lineHeight: 1,
        }}
      >
        {text}
      </h1>
      {subtitle ? (
        <p
          className="mono"
          style={{
            margin: 0,
            fontSize: 9,
            letterSpacing: 3,
            color: "var(--muted)",
            textTransform: "uppercase",
          }}
        >
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}

function Notch({ position }: { position: "tl" | "tr" | "bl" | "br" }) {
  const colour = "var(--hud)";
  const isTop = position[0] === "t";
  const isLeft = position[1] === "l";
  return (
    <div
      aria-hidden
      data-testid={`title-block-notch-${position}`}
      style={{
        position: "absolute",
        width: NOTCH_LEN,
        height: NOTCH_LEN,
        [isTop ? "top" : "bottom"]: -1,
        [isLeft ? "left" : "right"]: -1,
        borderTop: isTop ? `${NOTCH_STROKE}px solid ${colour}` : undefined,
        borderBottom: !isTop ? `${NOTCH_STROKE}px solid ${colour}` : undefined,
        borderLeft: isLeft ? `${NOTCH_STROKE}px solid ${colour}` : undefined,
        borderRight: !isLeft ? `${NOTCH_STROKE}px solid ${colour}` : undefined,
        pointerEvents: "none",
      }}
    />
  );
}
