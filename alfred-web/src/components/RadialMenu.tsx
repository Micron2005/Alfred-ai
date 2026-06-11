"use client";

/**
 * RadialMenu — curved horizontal carousel of 3D-styled orbs that
 * appears when the user clicks the central JARVIS orb. The user
 * picked "curved horizontal carousel" (Iron Man HUD style) and
 * "disappear, sub-view takes full HUD space" so this overlay
 * mounts on top of everything when ``open`` is true and dismisses
 * on item-select / outside-click / Escape.
 *
 * Each carousel item is a small 3D-feeling glass orb:
 *   - SPOTIFY (sphere with pulsing equalizer wedges)
 *   - CHAT (translucent speech bubble)
 *   - WORKOUT (rotating wireframe human silhouette)
 *
 * No three.js dependency — everything is CSS 3D + SVG, matching
 * the Orb3D approach so the bundle stays small and the menu
 * runs on a Pi 5 without WebGL.
 */

import { useEffect, useRef } from "react";

export type RadialMenuItem =
  | "spotify"
  | "chat"
  | "workout"
  | "workshop"
  | "design";

interface RadialMenuProps {
  open: boolean;
  onSelect: (item: RadialMenuItem) => void;
  onClose: () => void;
}

interface MenuEntry {
  id: RadialMenuItem;
  label: string;
  caption: string;
  testId: string;
}

const ENTRIES: ReadonlyArray<MenuEntry> = [
  {
    id: "spotify",
    label: "SPOTIFY",
    caption: "Audio Console",
    testId: "radial-menu-spotify",
  },
  {
    id: "chat",
    label: "CHAT",
    caption: "Conversation",
    testId: "radial-menu-chat",
  },
  {
    id: "design",
    label: "DESIGN",
    caption: "Sketch Pad",
    testId: "radial-menu-design",
  },
  {
    id: "workout",
    label: "WORKOUT",
    caption: "Form Coach",
    testId: "radial-menu-workout",
  },
  {
    id: "workshop",
    label: "WORKSHOP",
    caption: "Self-Coding",
    testId: "radial-menu-workshop",
  },
];

export function RadialMenu({ open, onSelect, onClose }: RadialMenuProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on Escape key — keyboard parity with the click-outside
  // dismiss path below.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={containerRef}
      data-testid="radial-menu"
      role="dialog"
      aria-modal="true"
      aria-label="JARVIS radial menu"
      onClick={(e) => {
        // Only dismiss when the click landed on the backdrop, not
        // on a carousel item — items handle selection themselves.
        if (e.target === containerRef.current) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background:
          "radial-gradient(circle at 50% 55%, rgba(8,14,24,0.92) 0%, rgba(0,0,0,0.98) 60%)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        animation: "radial-menu-fade-in 220ms ease-out",
      }}
    >
      {/* Close pill — top-right, kept small so it doesn't
          compete with the carousel for attention. */}
      <button
        type="button"
        data-testid="radial-menu-close"
        onClick={onClose}
        className="hud-button"
        style={{
          position: "absolute",
          top: 18,
          right: 22,
          padding: "6px 14px",
          fontSize: 11,
          letterSpacing: 2,
        }}
        aria-label="Close menu"
      >
        ✕ CLOSE
      </button>

      {/* Hint strip below the carousel */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          bottom: 48,
          left: "50%",
          transform: "translateX(-50%)",
          fontFamily:
            'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
          fontSize: 10,
          letterSpacing: 3,
          color: "rgba(108,214,255,0.55)",
          textTransform: "uppercase",
          textShadow: "0 0 12px rgba(108,214,255,0.5)",
        }}
      >
        SELECT A MODULE · ESC TO RETURN
      </div>

      {/* The curved carousel — three slots evenly arranged on a
          shallow arc. We position absolutely so the visual is
          deterministic regardless of viewport size. */}
      <div
        style={{
          position: "relative",
          width: "min(900px, 90vw)",
          height: 420,
          perspective: 1200,
          perspectiveOrigin: "50% 60%",
        }}
      >
        {ENTRIES.map((entry, i) => {
          // Center the carousel: positions are evenly spaced around 0.
          // For 3 entries that's [-1, 0, 1]; for 4 entries [-1.5,
          // -0.5, 0.5, 1.5]. Spacing tightens with item count so 4
          // orbs don't run off the side of the carousel.
          const offset = i - (ENTRIES.length - 1) / 2;
          const spread = ENTRIES.length <= 3 ? 30 : 22;
          const xPercent = 50 + offset * spread;
          const yPercent = 50 + Math.abs(offset) * 5;
          const rotY = -offset * 18;
          const scale = 1 - Math.abs(offset) * 0.07;
          return (
            <RadialItem
              key={entry.id}
              entry={entry}
              xPercent={xPercent}
              yPercent={yPercent}
              rotY={rotY}
              scale={scale}
              onSelect={() => onSelect(entry.id)}
              animDelayMs={120 + i * 90}
            />
          );
        })}
      </div>

      <style jsx global>{`
        @keyframes radial-menu-fade-in {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        @keyframes radial-item-enter {
          from {
            opacity: 0;
            transform: translate(-50%, calc(-50% + 40px))
              rotateY(var(--rotY, 0deg)) scale(0.8);
          }
          to {
            opacity: 1;
            transform: translate(-50%, -50%) rotateY(var(--rotY, 0deg))
              scale(var(--scale, 1));
          }
        }
        @keyframes radial-item-float {
          0%,
          100% {
            transform: translate(-50%, -50%) rotateY(var(--rotY, 0deg))
              scale(var(--scale, 1)) translateZ(0);
          }
          50% {
            transform: translate(-50%, calc(-50% - 4px))
              rotateY(var(--rotY, 0deg)) scale(var(--scale, 1)) translateZ(2px);
          }
        }
        @keyframes radial-orbit {
          from {
            transform: rotateZ(0deg);
          }
          to {
            transform: rotateZ(360deg);
          }
        }
        @keyframes radial-spin-y {
          from {
            transform: rotateY(0deg);
          }
          to {
            transform: rotateY(360deg);
          }
        }
        @keyframes radial-eq-bar {
          0%,
          100% {
            transform: scaleY(0.4);
          }
          50% {
            transform: scaleY(1);
          }
        }
      `}</style>
    </div>
  );
}

interface RadialItemProps {
  entry: MenuEntry;
  xPercent: number;
  yPercent: number;
  rotY: number;
  scale: number;
  animDelayMs: number;
  onSelect: () => void;
}

function RadialItem({
  entry,
  xPercent,
  yPercent,
  rotY,
  scale,
  animDelayMs,
  onSelect,
}: RadialItemProps) {
  return (
    <button
      type="button"
      data-testid={entry.testId}
      onClick={onSelect}
      aria-label={`${entry.label} — ${entry.caption}`}
      style={
        {
          position: "absolute",
          left: `${xPercent}%`,
          top: `${yPercent}%`,
          // Translate -50% so the item is centered on its anchor
          // point. The float keyframe overrides this on every
          // tick so we set an inline base via CSS variables that
          // the keyframe interpolates against.
          transform: `translate(-50%, -50%) rotateY(${rotY}deg) scale(${scale})`,
          width: 220,
          height: 260,
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          color: "var(--orb)",
          fontFamily:
            'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
          // Animations: enter (slide up + fade in), then idle float.
          // The float is what gives the carousel its "alive" feel.
          animation:
            `radial-item-enter 420ms ${animDelayMs}ms cubic-bezier(0.16,1,0.3,1) both, ` +
            `radial-item-float 6500ms ${animDelayMs + 420}ms ease-in-out infinite`,
          // Keyframes read these via var() so the float keyframe
          // preserves the per-item rotation + scale.
          ["--rotY" as string]: `${rotY}deg`,
          ["--scale" as string]: `${scale}`,
          transformStyle: "preserve-3d",
          // Don't let buttons get a focus ring inside the dialog —
          // we provide our own glow on hover/focus.
          outline: "none",
        } as React.CSSProperties
      }
      onMouseEnter={(e) => {
        e.currentTarget.style.filter =
          "drop-shadow(0 0 22px var(--orb-glow)) brightness(1.15)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.filter = "";
      }}
      onFocus={(e) => {
        e.currentTarget.style.filter =
          "drop-shadow(0 0 22px var(--orb-glow)) brightness(1.15)";
      }}
      onBlur={(e) => {
        e.currentTarget.style.filter = "";
      }}
    >
      {/* The 3D-styled orb visual */}
      <div
        style={{
          position: "relative",
          width: 200,
          height: 200,
          margin: "0 auto",
          borderRadius: "50%",
          // Glass sphere base — thin cyan rim, transparent center.
          background:
            "radial-gradient(circle at 50% 50%, rgba(108,214,255,0.0) 0%, rgba(108,214,255,0.05) 40%, rgba(108,214,255,0.18) 75%, rgba(108,214,255,0.45) 95%, rgba(108,214,255,0) 100%)",
          boxShadow:
            "inset 0 0 24px rgba(108,214,255,0.4), inset 6px 8px 22px rgba(255,255,255,0.15), inset -6px -8px 22px rgba(0,0,0,0.4), 0 0 32px var(--orb-glow), 0 0 80px var(--orb-soft)",
          backdropFilter: "blur(2px)",
          WebkitBackdropFilter: "blur(2px)",
          transformStyle: "preserve-3d",
        }}
      >
        {/* Glyph — different per item. */}
        {entry.id === "spotify" ? (
          <SpotifyGlyph />
        ) : entry.id === "chat" ? (
          <ChatGlyph />
        ) : entry.id === "workshop" ? (
          <WorkshopGlyph />
        ) : entry.id === "design" ? (
          <DesignGlyph />
        ) : (
          <WorkoutGlyph />
        )}

        {/* Outer rotating ring — gives the orb 3D depth motion. */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: -6,
            borderRadius: "50%",
            border: "1px dashed rgba(108,214,255,0.45)",
            animation: "radial-spin-y 9000ms linear infinite",
            transformStyle: "preserve-3d",
            pointerEvents: "none",
          }}
        />
      </div>

      <div
        style={{
          marginTop: 14,
          textAlign: "center",
          letterSpacing: 4,
          fontSize: 13,
          fontWeight: 500,
          color: "var(--orb)",
          textShadow: "0 0 12px var(--orb-glow)",
        }}
      >
        {entry.label}
      </div>
      <div
        style={{
          marginTop: 4,
          textAlign: "center",
          letterSpacing: 2,
          fontSize: 10,
          color: "var(--muted)",
          textTransform: "uppercase",
        }}
      >
        {entry.caption}
      </div>
    </button>
  );
}

/** Spotify glyph — pulsing 3-bar equaliser inside the orb. */
function SpotifyGlyph() {
  const bars = [0, 1, 2, 3, 4];
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
      }}
    >
      {bars.map((i) => (
        <div
          key={i}
          style={{
            width: 6,
            height: 70,
            background:
              "linear-gradient(180deg, var(--orb) 0%, var(--orb-soft) 100%)",
            borderRadius: 3,
            transformOrigin: "center",
            boxShadow: "0 0 10px var(--orb-glow)",
            animation: `radial-eq-bar ${600 + i * 110}ms ease-in-out infinite`,
            animationDelay: `${i * 80}ms`,
          }}
        />
      ))}
    </div>
  );
}

/** Chat glyph — speech bubble outline inside the orb. */
function ChatGlyph() {
  return (
    <svg
      viewBox="0 0 100 100"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        filter: "drop-shadow(0 0 10px var(--orb-glow))",
      }}
      aria-hidden
    >
      <path
        d="M 25 32 Q 25 22 35 22 L 65 22 Q 75 22 75 32 L 75 56 Q 75 66 65 66 L 50 66 L 38 78 L 38 66 L 35 66 Q 25 66 25 56 Z"
        fill="none"
        stroke="var(--orb)"
        strokeWidth={2.5}
        strokeLinejoin="round"
      />
      <circle cx={40} cy={44} r={3} fill="var(--orb)" />
      <circle cx={50} cy={44} r={3} fill="var(--orb)" />
      <circle cx={60} cy={44} r={3} fill="var(--orb)" />
    </svg>
  );
}

/** Workout glyph — rotating wireframe figure (T-pose) inside the orb. */
function WorkoutGlyph() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        animation: "radial-spin-y 7500ms linear infinite",
        transformStyle: "preserve-3d",
      }}
    >
      <svg
        viewBox="0 0 100 120"
        width={100}
        height={120}
        style={{ filter: "drop-shadow(0 0 8px var(--orb-glow))" }}
        aria-hidden
      >
        <circle cx={50} cy={20} r={9} fill="none" stroke="var(--orb)" strokeWidth={2} />
        <line x1={50} y1={29} x2={50} y2={70} stroke="var(--orb)" strokeWidth={2} />
        <line x1={20} y1={45} x2={80} y2={45} stroke="var(--orb)" strokeWidth={2} />
        <circle cx={20} cy={45} r={3} fill="var(--orb)" />
        <circle cx={80} cy={45} r={3} fill="var(--orb)" />
        <line x1={50} y1={70} x2={32} y2={108} stroke="var(--orb)" strokeWidth={2} />
        <line x1={50} y1={70} x2={68} y2={108} stroke="var(--orb)" strokeWidth={2} />
        <circle cx={32} cy={108} r={3} fill="var(--orb)" />
        <circle cx={68} cy={108} r={3} fill="var(--orb)" />
      </svg>
    </div>
  );
}

/** Workshop glyph — gear / cog turning slowly. */
function WorkshopGlyph() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        animation: "radial-orbit 9000ms linear infinite",
      }}
    >
      <svg
        viewBox="0 0 100 100"
        width={100}
        height={100}
        style={{ filter: "drop-shadow(0 0 8px var(--orb-glow))" }}
        aria-hidden
      >
        {/* Cog teeth — 8 evenly spaced rectangles */}
        {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
          <rect
            key={deg}
            x={47}
            y={8}
            width={6}
            height={14}
            fill="var(--orb)"
            transform={`rotate(${deg} 50 50)`}
          />
        ))}
        <circle
          cx={50}
          cy={50}
          r={26}
          fill="none"
          stroke="var(--orb)"
          strokeWidth={3}
        />
        <circle
          cx={50}
          cy={50}
          r={9}
          fill="none"
          stroke="var(--orb)"
          strokeWidth={2.5}
        />
      </svg>
    </div>
  );
}


/** Design glyph — wireframe cube rotating, evoking parametric CAD. */
function DesignGlyph() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        animation: "radial-spin-y 12000ms linear infinite",
      }}
    >
      <svg
        viewBox="0 0 100 100"
        width={100}
        height={100}
        style={{ filter: "drop-shadow(0 0 8px var(--orb-glow))" }}
        aria-hidden
      >
        {/* Front face */}
        <polygon
          points="22,32 64,32 64,74 22,74"
          fill="none"
          stroke="var(--orb)"
          strokeWidth={2.4}
        />
        {/* Back face (offset up-right) */}
        <polygon
          points="36,18 78,18 78,60 36,60"
          fill="none"
          stroke="var(--orb)"
          strokeWidth={2}
          opacity={0.65}
        />
        {/* Connecting edges */}
        <line x1={22} y1={32} x2={36} y2={18} stroke="var(--orb)" strokeWidth={1.6} opacity={0.65} />
        <line x1={64} y1={32} x2={78} y2={18} stroke="var(--orb)" strokeWidth={1.6} opacity={0.65} />
        <line x1={64} y1={74} x2={78} y2={60} stroke="var(--orb)" strokeWidth={1.6} opacity={0.65} />
        <line x1={22} y1={74} x2={36} y2={60} stroke="var(--orb)" strokeWidth={1.6} opacity={0.65} />
        {/* Vertex dots — visual emphasis on parametric points */}
        {[
          [22, 32], [64, 32], [64, 74], [22, 74],
          [36, 18], [78, 18], [78, 60], [36, 60],
        ].map(([cx, cy]) => (
          <circle
            key={`${cx}-${cy}`}
            cx={cx}
            cy={cy}
            r={1.8}
            fill="var(--orb)"
          />
        ))}
      </svg>
    </div>
  );
}
