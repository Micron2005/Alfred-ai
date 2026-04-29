"use client";

/**
 * PoseSkeleton — full-screen SVG overlay drawing the BlazePose
 * 33-point body skeleton with bone connections + joint dots.
 *
 * Pure visualization. ``pointer-events: none``. Sits at z-index
 * 99997, beneath HandCursor.
 */

import { useMemo } from "react";

import { POSE_LM, type PoseState } from "@/lib/usePoseTracking";

interface Props {
  enabled: boolean;
  pose: PoseState | null;
  /** When ``true``, also render the joint-angle readouts. */
  showAnglePanel?: boolean;
}

// Bone connections — pairs of landmark indices joined by a line.
const POSE_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  // Torso
  [POSE_LM.LEFT_SHOULDER, POSE_LM.RIGHT_SHOULDER],
  [POSE_LM.LEFT_SHOULDER, POSE_LM.LEFT_HIP],
  [POSE_LM.RIGHT_SHOULDER, POSE_LM.RIGHT_HIP],
  [POSE_LM.LEFT_HIP, POSE_LM.RIGHT_HIP],
  // Left arm
  [POSE_LM.LEFT_SHOULDER, POSE_LM.LEFT_ELBOW],
  [POSE_LM.LEFT_ELBOW, POSE_LM.LEFT_WRIST],
  // Right arm
  [POSE_LM.RIGHT_SHOULDER, POSE_LM.RIGHT_ELBOW],
  [POSE_LM.RIGHT_ELBOW, POSE_LM.RIGHT_WRIST],
  // Left leg
  [POSE_LM.LEFT_HIP, POSE_LM.LEFT_KNEE],
  [POSE_LM.LEFT_KNEE, POSE_LM.LEFT_ANKLE],
  [POSE_LM.LEFT_ANKLE, POSE_LM.LEFT_FOOT],
  // Right leg
  [POSE_LM.RIGHT_HIP, POSE_LM.RIGHT_KNEE],
  [POSE_LM.RIGHT_KNEE, POSE_LM.RIGHT_ANKLE],
  [POSE_LM.RIGHT_ANKLE, POSE_LM.RIGHT_FOOT],
  // Head
  [POSE_LM.NOSE, POSE_LM.LEFT_EYE],
  [POSE_LM.NOSE, POSE_LM.RIGHT_EYE],
  [POSE_LM.LEFT_EAR, POSE_LM.LEFT_EYE],
  [POSE_LM.RIGHT_EAR, POSE_LM.RIGHT_EYE],
];

const KEY_JOINTS: ReadonlyArray<number> = [
  POSE_LM.LEFT_SHOULDER, POSE_LM.RIGHT_SHOULDER,
  POSE_LM.LEFT_ELBOW, POSE_LM.RIGHT_ELBOW,
  POSE_LM.LEFT_WRIST, POSE_LM.RIGHT_WRIST,
  POSE_LM.LEFT_HIP, POSE_LM.RIGHT_HIP,
  POSE_LM.LEFT_KNEE, POSE_LM.RIGHT_KNEE,
  POSE_LM.LEFT_ANKLE, POSE_LM.RIGHT_ANKLE,
  POSE_LM.NOSE,
];

const ACCENT = "rgba(255, 200, 60, 0.95)";
const ACCENT_FILL = "rgba(255, 200, 60, 0.30)";

export function PoseSkeleton({
  enabled,
  pose,
  showAnglePanel = true,
}: Props) {
  const lines = useMemo(() => {
    if (!pose) return [];
    return POSE_CONNECTIONS.map(([a, b], i) => {
      const pa = pose.landmarks[a];
      const pb = pose.landmarks[b];
      if (!pa || !pb) return null;
      // Visibility-aware fade: faint segment if a joint isn't
      // confident.
      const visA = pa.visibility ?? 1;
      const visB = pb.visibility ?? 1;
      const opacity = Math.min(visA, visB);
      if (opacity < 0.3) return null;
      return {
        key: i,
        x1: pa.x,
        y1: pa.y,
        x2: pb.x,
        y2: pb.y,
        opacity,
      };
    }).filter(
      (
        l,
      ): l is {
        key: number;
        x1: number;
        y1: number;
        x2: number;
        y2: number;
        opacity: number;
      } => l !== null,
    );
  }, [pose]);

  if (!enabled || !pose) return null;

  return (
    <>
      <svg
        aria-hidden
        style={{
          position: "fixed",
          inset: 0,
          width: "100vw",
          height: "100vh",
          pointerEvents: "none",
          zIndex: 99997,
        }}
      >
        <defs>
          <filter id="pose-skeleton-glow">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g filter="url(#pose-skeleton-glow)">
          {lines.map((l) => (
            <line
              key={l.key}
              x1={l.x1}
              y1={l.y1}
              x2={l.x2}
              y2={l.y2}
              stroke={ACCENT}
              strokeOpacity={l.opacity}
              strokeWidth={3}
              strokeLinecap="round"
            />
          ))}
          {KEY_JOINTS.map((idx) => {
            const p = pose.landmarks[idx];
            if (!p) return null;
            const vis = p.visibility ?? 1;
            if (vis < 0.3) return null;
            return (
              <circle
                key={idx}
                cx={p.x}
                cy={p.y}
                r={5}
                fill={ACCENT_FILL}
                stroke={ACCENT}
                strokeWidth={2}
                opacity={vis}
              />
            );
          })}
        </g>
      </svg>

      {showAnglePanel ? <AnglePanel pose={pose} /> : null}
    </>
  );
}

function AnglePanel({ pose }: { pose: PoseState }) {
  const a = pose.angles;
  const rows: Array<[string, string]> = [
    ["L Elbow", `${a.leftElbow.toFixed(0)}°`],
    ["R Elbow", `${a.rightElbow.toFixed(0)}°`],
    ["L Knee", `${a.leftKnee.toFixed(0)}°`],
    ["R Knee", `${a.rightKnee.toFixed(0)}°`],
    ["L Hip", `${a.leftHip.toFixed(0)}°`],
    ["R Hip", `${a.rightHip.toFixed(0)}°`],
    ["Stance", a.stanceRatio.toFixed(2)],
    ["Lean", `${a.torsoLean.toFixed(0)}°`],
  ];
  return (
    <div
      data-testid="pose-angle-panel"
      style={{
        position: "fixed",
        left: 16,
        bottom: 16,
        width: 180,
        padding: "8px 10px",
        background: "rgba(8, 14, 24, 0.78)",
        border: "1px solid var(--accent)",
        borderRadius: 4,
        backdropFilter: "blur(8px)",
        boxShadow: "0 0 12px rgba(255,200,60,0.35)",
        fontFamily:
          'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
        fontSize: 10,
        color: "var(--accent, #ffc83c)",
        pointerEvents: "none",
        zIndex: 99996,
        lineHeight: 1.7,
      }}
    >
      <div
        style={{
          textTransform: "uppercase",
          letterSpacing: 1.5,
          opacity: 0.7,
          marginBottom: 4,
        }}
      >
        BIOMECHANICS
      </div>
      {rows.map(([k, v]) => (
        <div
          key={k}
          style={{ display: "flex", justifyContent: "space-between", gap: 8 }}
        >
          <span style={{ opacity: 0.75 }}>{k}</span>
          <span style={{ opacity: 0.95 }}>{v}</span>
        </div>
      ))}
    </div>
  );
}
