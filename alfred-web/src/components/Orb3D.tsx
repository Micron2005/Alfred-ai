"use client";

/**
 * Orb3D — a 3D-feeling upgrade of the original 2D Orb. Uses pure
 * CSS 3D transforms (no Three.js / react-three-fiber dependency)
 * so the bundle stays small and the orb still works on a Pi 5
 * without a WebGL hardware accelerator.
 *
 * Visual breakdown:
 *   - 4 concentric rings rotating in 3D about different axes
 *     (X, Y, Z, and a tilted Y) — gives proper depth parallax
 *     when the user moves their head.
 *   - A central glowing core with two layered halos that pulse
 *     to the orbStore audio level (same heartbeat contract as
 *     the original Orb component).
 *   - Floating orbital "satellites" that orbit independently.
 *
 * Drop-in replacement for ``<Orb>`` — accepts the same ``size``
 * and ``caption`` props.
 */

import { useEffect, useRef, useSyncExternalStore } from "react";

import { orbStore, type OrbMode } from "@/lib/orbState";

export interface Orb3DProps {
  size?: number;
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

export function Orb3D({ size = 240, caption }: Orb3DProps) {
  const mode = useOrbMode();
  const coreRef = useRef<HTMLDivElement>(null);
  const haloRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<number>(performance.now());
  const rafRef = useRef<number | null>(null);

  // Heartbeat / audio-reactive pulse loop, identical contract to
  // the original 2D Orb so any swap is transparent.
  useEffect(() => {
    let cancelled = false;
    const tick = (now: number) => {
      if (cancelled) return;
      const elapsedMs = now - startRef.current;
      const liveLevel = orbStore.getLevel();
      const breath =
        0.5 +
        0.5 * Math.sin((elapsedMs / 1500) * Math.PI * 2 - Math.PI / 2);
      let amplitude: number;
      switch (mode) {
        case "speaking":
          amplitude = 0.35 + Math.min(1, liveLevel * 1.4) * 0.65;
          break;
        case "listening":
          amplitude = 0.3 + Math.min(1, liveLevel * 1.6) * 0.55;
          break;
        case "thinking":
          amplitude =
            0.55 +
            0.15 * Math.sin((elapsedMs / 350) * Math.PI * 2 - Math.PI / 2);
          break;
        case "idle":
        default:
          amplitude = 0.55 + breath * 0.15;
          break;
      }
      const core = coreRef.current;
      const halo = haloRef.current;
      if (core) {
        const scale = 0.6 + amplitude * 0.55;
        core.style.transform = `translate3d(-50%, -50%, 30px) scale(${scale.toFixed(3)})`;
      }
      if (halo) {
        halo.style.opacity = (0.25 + amplitude * 0.6).toFixed(3);
      }
      // Subtle scene rotation tied to the breath — gives the
      // entire orb a slow head-tilt parallax even when idle.
      const scene = sceneRef.current;
      if (scene) {
        const tiltX = Math.sin(elapsedMs / 4500) * 4;
        const tiltY = Math.cos(elapsedMs / 5300) * 6;
        scene.style.transform = `rotateX(${tiltX.toFixed(2)}deg) rotateY(${tiltY.toFixed(2)}deg)`;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [mode]);

  return (
    <div
      data-testid="orb-3d"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 10,
        userSelect: "none",
      }}
      aria-hidden
    >
      <div
        style={{
          width: size,
          height: size,
          position: "relative",
          perspective: `${size * 4}px`,
          perspectiveOrigin: "50% 50%",
          // Allow rings to draw outside their parent without being
          // clipped — the outer ring is intentionally larger than
          // the bounding box for a "leaks beyond" feel.
          overflow: "visible",
        }}
      >
        {/* Background atmospheric glow — non-rotating, intentionally
            subtle so the see-through orb keeps its glass look. */}
        <div
          ref={haloRef}
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            background:
              "radial-gradient(circle at 50% 50%, var(--orb-soft) 0%, transparent 60%)",
            filter: "blur(28px)",
            opacity: 0.4,
            transition: "opacity 80ms linear",
            pointerEvents: "none",
          }}
        />
        <div
          ref={sceneRef}
          style={{
            position: "absolute",
            inset: 0,
            transformStyle: "preserve-3d",
            transition: "transform 320ms ease-out",
          }}
        >
          {/* 4 concentric rings rotating in 3D about different axes */}
          <Ring
            size={size * 1.05}
            thickness={1.5}
            colorVar="--orb"
            opacity={0.55}
            axis="x"
            durationMs={9000}
            dashArray="2 6"
          />
          <Ring
            size={size * 0.92}
            thickness={2}
            colorVar="--orb"
            opacity={0.85}
            axis="y"
            durationMs={6500}
            dashArray="40 220"
          />
          <Ring
            size={size * 0.75}
            thickness={1.5}
            colorVar="--orb-soft"
            opacity={0.6}
            axis="tilted-y"
            durationMs={4500}
            dashArray="8 14"
            counterRotate
          />
          <Ring
            size={size * 0.58}
            thickness={1.8}
            colorVar="--orb"
            opacity={0.7}
            axis="z"
            durationMs={3500}
            dashArray="4 4"
          />

          {/* Orbital satellites - small dots circling at different radii/speeds */}
          <Satellite
            radius={size * 0.45}
            durationMs={7000}
            tiltDeg={20}
            sizePx={4}
          />
          <Satellite
            radius={size * 0.36}
            durationMs={5200}
            tiltDeg={-30}
            sizePx={3}
            phaseDeg={120}
          />
          <Satellite
            radius={size * 0.5}
            durationMs={9000}
            tiltDeg={70}
            sizePx={5}
            phaseDeg={240}
          />

          {/* Glass core — translucent sphere that refracts the
              rings behind it instead of being a solid ball. The
              user asked for "more see-through, like a 4D sphere"
              — we get that effect by using radial gradients with
              alpha falloff rather than a solid fill, plus a thin
              high-contrast rim where the gradient meets the edge,
              plus inset highlights to suggest curvature without
              opaqueness. */}
          <div
            ref={coreRef}
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: size * 0.42,
              height: size * 0.42,
              marginLeft: 0,
              marginTop: 0,
              transform: "translate3d(-50%, -50%, 30px)",
              borderRadius: "50%",
              background:
                // Outer rim glow + faint volumetric haze, no solid centre.
                "radial-gradient(circle at 50% 50%, " +
                "rgba(255,255,255,0.0) 0%, " +
                "rgba(108,214,255,0.04) 30%, " +
                "rgba(108,214,255,0.10) 55%, " +
                "rgba(108,214,255,0.32) 80%, " +
                "rgba(108,214,255,0.55) 96%, " +
                "rgba(108,214,255,0.0) 100%)",
              boxShadow:
                // Inner rim catch-light + outer halo
                "inset 0 0 18px rgba(108,214,255,0.45), " +
                "inset 6px 8px 22px rgba(255,255,255,0.18), " +
                "inset -6px -8px 22px rgba(0,0,0,0.35), " +
                "0 0 28px var(--orb-glow), " +
                "0 0 70px var(--orb-soft)",
              backdropFilter: "blur(2px)",
              WebkitBackdropFilter: "blur(2px)",
              transition: "transform 80ms linear",
              pointerEvents: "none",
            }}
          />
          {/* Specular highlight — the "wet glass" sheen that sells
              the see-through-sphere illusion. */}
          <div
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: size * 0.16,
              height: size * 0.10,
              transform: "translate3d(-90%, -130%, 36px) rotate(-25deg)",
              borderRadius: "50%",
              background:
                "radial-gradient(circle, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0.0) 70%)",
              filter: "blur(1.5px)",
              opacity: 0.85,
              pointerEvents: "none",
            }}
          />

          {/* Inner sparkle accents */}
          <div
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: 4,
              height: size * 0.6,
              transform: "translate3d(-50%, -50%, 35px)",
              background:
                "linear-gradient(transparent, var(--orb) 50%, transparent)",
              opacity: 0.18,
              filter: "blur(1.5px)",
              pointerEvents: "none",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: size * 0.6,
              height: 4,
              transform: "translate3d(-50%, -50%, 35px)",
              background:
                "linear-gradient(90deg, transparent, var(--orb) 50%, transparent)",
              opacity: 0.18,
              filter: "blur(1.5px)",
              pointerEvents: "none",
            }}
          />
        </div>
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

      <style jsx global>{`
        @keyframes orb3d-spin-x {
          from { transform: rotateX(0deg); }
          to { transform: rotateX(360deg); }
        }
        @keyframes orb3d-spin-y {
          from { transform: rotateY(0deg); }
          to { transform: rotateY(360deg); }
        }
        @keyframes orb3d-spin-z {
          from { transform: rotateZ(0deg); }
          to { transform: rotateZ(360deg); }
        }
        @keyframes orb3d-spin-tilted {
          from { transform: rotateX(60deg) rotateY(0deg); }
          to   { transform: rotateX(60deg) rotateY(360deg); }
        }
        @keyframes orb3d-spin-tilted-rev {
          from { transform: rotateX(60deg) rotateY(360deg); }
          to   { transform: rotateX(60deg) rotateY(0deg); }
        }
        @keyframes orb3d-orbit {
          from { transform: rotateZ(0deg); }
          to { transform: rotateZ(360deg); }
        }
      `}</style>
    </div>
  );
}

interface RingProps {
  size: number;
  thickness: number;
  colorVar: string;
  opacity: number;
  axis: "x" | "y" | "z" | "tilted-y";
  durationMs: number;
  dashArray?: string;
  counterRotate?: boolean;
}

function Ring({
  size,
  thickness,
  colorVar,
  opacity,
  axis,
  durationMs,
  dashArray,
  counterRotate,
}: RingProps) {
  const animation =
    axis === "x"
      ? "orb3d-spin-x"
      : axis === "y"
        ? "orb3d-spin-y"
        : axis === "z"
          ? "orb3d-spin-z"
          : counterRotate
            ? "orb3d-spin-tilted-rev"
            : "orb3d-spin-tilted";
  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        width: size,
        height: size,
        marginLeft: -size / 2,
        marginTop: -size / 2,
        transformStyle: "preserve-3d",
        animation: `${animation} ${durationMs}ms linear infinite`,
        pointerEvents: "none",
      }}
    >
      <svg
        viewBox={`-${size / 2} -${size / 2} ${size} ${size}`}
        width={size}
        height={size}
        style={{ overflow: "visible" }}
      >
        <circle
          cx={0}
          cy={0}
          r={size / 2 - thickness}
          fill="none"
          stroke={`var(${colorVar})`}
          strokeWidth={thickness}
          strokeOpacity={opacity}
          strokeDasharray={dashArray}
          style={{
            filter: `drop-shadow(0 0 6px var(${colorVar}))`,
          }}
        />
      </svg>
    </div>
  );
}

interface SatelliteProps {
  radius: number;
  durationMs: number;
  tiltDeg: number;
  sizePx: number;
  phaseDeg?: number;
}

function Satellite({
  radius,
  durationMs,
  tiltDeg,
  sizePx,
  phaseDeg = 0,
}: SatelliteProps) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        transform: `rotateX(${tiltDeg}deg)`,
        transformStyle: "preserve-3d",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: 0,
          height: 0,
          animation: `orb3d-orbit ${durationMs}ms linear infinite`,
          animationDelay: `${-(durationMs * phaseDeg) / 360}ms`,
          transformStyle: "preserve-3d",
        }}
      >
        <div
          style={{
            position: "absolute",
            width: sizePx,
            height: sizePx,
            left: radius,
            top: -sizePx / 2,
            borderRadius: "50%",
            background: "var(--orb)",
            boxShadow:
              "0 0 8px var(--orb), 0 0 16px var(--orb-soft)",
          }}
        />
      </div>
    </div>
  );
}
