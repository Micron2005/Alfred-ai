"use client";

/**
 * FaceMesh — full-screen SVG overlay drawing the MediaPipe face
 * mesh (478 landmarks + tessellation) and an HUD panel with the
 * dominant facial expression.
 *
 * Pure visualization; emits no events. Sits at z-index 99997 so
 * it's beneath HandCursor (99998) — pinches still work over a
 * face mesh.
 */

import { useMemo } from "react";

import type { FaceState } from "@/lib/useFaceTracking";

interface Props {
  enabled: boolean;
  face: FaceState | null;
  /** ``true`` to render the dominant-expression label panel. */
  showExpressionPanel?: boolean;
}

// Subset of MediaPipe Face Mesh tessellation — just the contours
// of eyes, brows, mouth, face oval. Drawing all 8000+ tessellation
// triangles is overkill for an overlay; this contour set looks
// just as JARVIS-y at a fraction of the SVG cost.
const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379,
  378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127,
  162, 21, 54, 103, 67, 109,
];
const LEFT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const RIGHT_EYE = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
const LIPS_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
const LEFT_BROW = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46];
const RIGHT_BROW = [336, 296, 334, 293, 300, 276, 283, 282, 295, 285];
const NOSE_BRIDGE = [168, 6, 197, 195, 5, 4, 1];

const CONTOURS: ReadonlyArray<{
  name: string;
  ids: ReadonlyArray<number>;
  closed: boolean;
}> = [
  { name: "oval", ids: FACE_OVAL, closed: true },
  { name: "leftEye", ids: LEFT_EYE, closed: true },
  { name: "rightEye", ids: RIGHT_EYE, closed: true },
  { name: "lipsOuter", ids: LIPS_OUTER, closed: true },
  { name: "leftBrow", ids: LEFT_BROW, closed: false },
  { name: "rightBrow", ids: RIGHT_BROW, closed: false },
  { name: "noseBridge", ids: NOSE_BRIDGE, closed: false },
];

const CYAN = "rgba(108, 214, 255, 0.7)";
const CYAN_SOFT = "rgba(108, 214, 255, 0.18)";

/** Convert a blendshape category name like ``"mouthSmileLeft"`` into a
 * human-readable label like ``"Smile (left)"``. */
function humanizeBlendshape(name: string): string {
  // Split camelCase, lowercase, then humanize a handful of
  // common categories. Fallback is a Title Case of the camelCase.
  const titled = name
    .replace(/([A-Z])/g, " $1")
    .trim()
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
  return titled;
}

export function FaceMesh({ enabled, face, showExpressionPanel = true }: Props) {
  const paths = useMemo(() => {
    if (!face) return [];
    return CONTOURS.map((c) => {
      const pts = c.ids.map((i) => face.landmarks[i]).filter(Boolean);
      if (pts.length < 2) return null;
      let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
      for (let i = 1; i < pts.length; i++) {
        d += ` L ${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)}`;
      }
      if (c.closed) d += " Z";
      return { name: c.name, d };
    }).filter((x): x is { name: string; d: string } => x !== null);
  }, [face]);

  if (!enabled || !face) return null;

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
          <filter id="face-mesh-glow">
            <feGaussianBlur stdDeviation="1.2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g filter="url(#face-mesh-glow)">
          {paths.map((p) => (
            <path
              key={p.name}
              d={p.d}
              stroke={CYAN}
              strokeWidth={1.2}
              fill="none"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
        </g>
        {/* Faint dot at every landmark — subtle "reading the face" feel */}
        <g opacity={0.5}>
          {face.landmarks.map((p, i) => (
            <circle
              key={i}
              cx={p.x}
              cy={p.y}
              r={0.6}
              fill={CYAN_SOFT}
            />
          ))}
        </g>
        {/* Bounding box corners — JARVIS targeting reticle */}
        <BBoxCorners bbox={face.bbox} />
      </svg>

      {showExpressionPanel && face.dominantExpression ? (
        <ExpressionPanel face={face} />
      ) : null}
    </>
  );
}

function BBoxCorners({
  bbox,
}: {
  bbox: { x: number; y: number; w: number; h: number };
}) {
  const { x, y, w, h } = bbox;
  const len = 14;
  const stroke = "rgba(108, 214, 255, 0.85)";
  const sw = 1.5;
  return (
    <g>
      {/* Top-left */}
      <line x1={x} y1={y} x2={x + len} y2={y} stroke={stroke} strokeWidth={sw} />
      <line x1={x} y1={y} x2={x} y2={y + len} stroke={stroke} strokeWidth={sw} />
      {/* Top-right */}
      <line x1={x + w - len} y1={y} x2={x + w} y2={y} stroke={stroke} strokeWidth={sw} />
      <line x1={x + w} y1={y} x2={x + w} y2={y + len} stroke={stroke} strokeWidth={sw} />
      {/* Bottom-left */}
      <line x1={x} y1={y + h - len} x2={x} y2={y + h} stroke={stroke} strokeWidth={sw} />
      <line x1={x} y1={y + h} x2={x + len} y2={y + h} stroke={stroke} strokeWidth={sw} />
      {/* Bottom-right */}
      <line x1={x + w - len} y1={y + h} x2={x + w} y2={y + h} stroke={stroke} strokeWidth={sw} />
      <line x1={x + w} y1={y + h - len} x2={x + w} y2={y + h} stroke={stroke} strokeWidth={sw} />
    </g>
  );
}

function ExpressionPanel({ face }: { face: FaceState }) {
  const dom = face.dominantExpression;
  if (!dom) return null;
  // Sort top 4 active blendshapes for the panel.
  const top = Object.entries(face.blendshapes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
  return (
    <div
      data-testid="face-expression-panel"
      style={{
        position: "fixed",
        right: 16,
        top: face.bbox.y + face.bbox.h + 8,
        width: 220,
        padding: "8px 10px",
        background: "rgba(8, 14, 24, 0.78)",
        border: "1px solid var(--hud)",
        borderRadius: 4,
        backdropFilter: "blur(8px)",
        boxShadow: "0 0 12px var(--orb-glow)",
        fontFamily:
          'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
        fontSize: 10,
        color: "var(--hud)",
        pointerEvents: "none",
        zIndex: 99996,
        lineHeight: 1.6,
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
        EXPRESSION
      </div>
      <div style={{ fontSize: 13, fontWeight: 600 }}>
        {humanizeBlendshape(dom.name)}
      </div>
      <div style={{ opacity: 0.6, marginBottom: 6 }}>
        intensity {(dom.score * 100).toFixed(0)}%
      </div>
      {top.map(([name, score]) => (
        <div
          key={name}
          style={{ display: "flex", justifyContent: "space-between", gap: 8 }}
        >
          <span style={{ opacity: 0.75 }}>{humanizeBlendshape(name)}</span>
          <span style={{ opacity: 0.55 }}>{(score * 100).toFixed(0)}%</span>
        </div>
      ))}
    </div>
  );
}
