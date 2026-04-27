"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { orbStore, type OrbMode } from "@/lib/orbState";

/**
 * The JARVIS-style center orb.
 *
 * Visual: three concentric SVG rings (outer slow, middle fast,
 * counter-rotating inner) around a glowing core, with two "tick" arcs
 * floating off opposite sides for the HUD instrument feel.
 *
 * Animation strategy:
 *   - Ring rotations + tick orbits are pure CSS animations. They run
 *     forever and never cause React re-renders.
 *   - The core scale (the "heartbeat") is driven by the orbStore's
 *     level value, sampled in a requestAnimationFrame loop and applied
 *     via direct DOM transform mutation. This avoids re-rendering on
 *     every frame, which would tank the rest of the UI on slower CPUs.
 *   - In ``idle`` mode there's no audio level to follow, so we apply
 *     a sine-wave breathing pulse instead (computed in the same RAF
 *     loop so there's only one frame loop active).
 *
 * Sizes are passed as a prop because the same component is reused in
 * the chat header (small) and could be reused later as a full-screen
 * "ambient" mode.
 */
export interface OrbProps {
  size?: number;
  /** Optional status caption rendered below the orb. */
  caption?: string;
}

function useOrbMode(): OrbMode {
  const snapshot = useSyncExternalStore(
    orbStore.subscribe,
    orbStore.getSnapshot,
    orbStore.getSnapshot,
  );
  return snapshot.mode;
}

export function Orb({ size = 220, caption }: OrbProps) {
  const mode = useOrbMode();
  const coreRef = useRef<SVGCircleElement>(null);
  const glowRef = useRef<SVGCircleElement>(null);
  const startRef = useRef<number>(performance.now());
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = (now: number) => {
      if (cancelled) return;
      const elapsedMs = now - startRef.current;
      const liveLevel = orbStore.getLevel();
      // Idle: synthesize a gentle 1500ms breath. The animation isn't
      // perfectly sinusoidal — eased a touch so the "exhale" is softer.
      const breath =
        0.5 + 0.5 * Math.sin((elapsedMs / 1500) * Math.PI * 2 - Math.PI / 2);
      let amplitude: number;
      switch (mode) {
        case "speaking":
          // Heartbeat from Alfred's voice. Floor it slightly so the orb
          // never goes completely still mid-sentence on a soft phoneme.
          amplitude = 0.35 + Math.min(1, liveLevel * 1.4) * 0.65;
          break;
        case "listening":
          // Same idea but with mic input. Slightly tamer ceiling so a
          // shouted word doesn't blow out the orb visually.
          amplitude = 0.3 + Math.min(1, liveLevel * 1.6) * 0.55;
          break;
        case "thinking":
          // Faster, smaller pulse — the rings are doing the heavy
          // lifting visually here.
          amplitude =
            0.55 +
            0.15 *
              Math.sin((elapsedMs / 350) * Math.PI * 2 - Math.PI / 2);
          break;
        case "idle":
        default:
          // 0.55..0.7 range — visible but subtle.
          amplitude = 0.55 + breath * 0.15;
          break;
      }
      const core = coreRef.current;
      const glow = glowRef.current;
      if (core) {
        // Map 0..1 -> 0.6..1.15 scale.
        const scale = 0.6 + amplitude * 0.55;
        core.setAttribute(
          "transform",
          `translate(0,0) scale(${scale.toFixed(3)})`,
        );
      }
      if (glow) {
        const opacity = 0.25 + amplitude * 0.55;
        glow.setAttribute("opacity", opacity.toFixed(3));
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [mode]);

  const accent = "var(--orb)";
  const accentSoft = "var(--orb-soft)";
  const ringWidth = 1.5;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        userSelect: "none",
      }}
      aria-hidden
    >
      <div
        style={{
          width: size,
          height: size,
          position: "relative",
        }}
      >
        <svg
          viewBox="-100 -100 200 200"
          width={size}
          height={size}
          style={{
            position: "absolute",
            inset: 0,
            overflow: "visible",
            filter: "drop-shadow(0 0 12px var(--orb-glow))",
          }}
        >
          <defs>
            <radialGradient id="orb-core-gradient" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="var(--orb)" stopOpacity="1" />
              <stop offset="55%" stopColor="var(--orb)" stopOpacity="0.55" />
              <stop offset="100%" stopColor="var(--orb)" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="orb-halo-gradient" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="var(--orb)" stopOpacity="0.5" />
              <stop offset="100%" stopColor="var(--orb)" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* Halo glow behind everything */}
          <circle
            ref={glowRef}
            cx={0}
            cy={0}
            r={70}
            fill="url(#orb-halo-gradient)"
            opacity={0.4}
          />

          {/* Outer ring — slow rotation, tick marks built into the dasharray */}
          <g className="orb-ring orb-ring--outer">
            <circle
              cx={0}
              cy={0}
              r={86}
              fill="none"
              stroke={accent}
              strokeWidth={ringWidth}
              strokeOpacity={0.5}
              strokeDasharray="2 6"
            />
            <circle
              cx={0}
              cy={0}
              r={82}
              fill="none"
              stroke={accent}
              strokeWidth={ringWidth}
              strokeOpacity={0.85}
              strokeDasharray="40 220"
            />
          </g>

          {/* Middle ring — counter-rotates */}
          <g className="orb-ring orb-ring--middle">
            <circle
              cx={0}
              cy={0}
              r={64}
              fill="none"
              stroke={accent}
              strokeWidth={ringWidth}
              strokeOpacity={0.7}
              strokeDasharray="80 60 20 60"
            />
            <circle
              cx={0}
              cy={0}
              r={58}
              fill="none"
              stroke={accentSoft}
              strokeWidth={ringWidth * 0.7}
              strokeOpacity={0.4}
              strokeDasharray="4 4"
            />
          </g>

          {/* Inner ring — slow, full circle reference line */}
          <g className="orb-ring orb-ring--inner">
            <circle
              cx={0}
              cy={0}
              r={44}
              fill="none"
              stroke={accent}
              strokeWidth={ringWidth}
              strokeOpacity={0.55}
            />
            <circle
              cx={0}
              cy={0}
              r={44}
              fill="none"
              stroke={accent}
              strokeWidth={ringWidth * 1.6}
              strokeOpacity={0.9}
              strokeDasharray="14 264"
            />
          </g>

          {/* Tick markers floating off opposite sides — orbit slowly */}
          <g className="orb-ticks">
            <g transform="translate(-92, 0)">
              <circle
                cx={0}
                cy={0}
                r={3}
                fill={accent}
                opacity={0.85}
              />
              <line
                x1={-8}
                y1={0}
                x2={-2}
                y2={0}
                stroke={accent}
                strokeWidth={ringWidth}
                opacity={0.7}
              />
            </g>
            <g transform="translate(92, 0)">
              <circle
                cx={0}
                cy={0}
                r={3}
                fill={accent}
                opacity={0.85}
              />
              <line
                x1={2}
                y1={0}
                x2={8}
                y2={0}
                stroke={accent}
                strokeWidth={ringWidth}
                opacity={0.7}
              />
            </g>
          </g>

          {/* Core — scale animated from RAF loop above */}
          <g ref={coreRef} style={{ transformOrigin: "0 0" }}>
            <circle cx={0} cy={0} r={28} fill="url(#orb-core-gradient)" />
            <circle
              cx={0}
              cy={0}
              r={10}
              fill="var(--orb)"
              opacity={0.95}
            />
          </g>
        </svg>
      </div>
      {caption ? (
        <div
          style={{
            fontFamily:
              'ui-monospace, SFMono-Regular, "JetBrains Mono", "Fira Code", monospace',
            fontSize: 11,
            letterSpacing: 2,
            textTransform: "uppercase",
            color: "var(--muted)",
            opacity: 0.85,
          }}
        >
          {caption}
        </div>
      ) : null}
    </div>
  );
}
