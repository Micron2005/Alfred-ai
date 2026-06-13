"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  SKETCH_TOOLS,
  sketchStore,
  type SketchLayer,
  type SketchSnapshotState,
  type SketchTool,
} from "@/lib/sketchStore";

/**
 * The DESIGN tab — a Procreate-style freehand sketch pad.
 *
 * Drawing surface:
 *   - white paper canvas (no grid), fixed logical 1600×1000 space;
 *   - multiple layers (add / delete / rename / show-hide / opacity /
 *     reorder / select), each its own stacked <canvas>;
 *   - pressure-sensitive pencil, pen, marker, and eraser (Pointer
 *     Events ``pressure``, so a real stylus modulates width — mouse
 *     and finger fall back to a constant mid pressure);
 *   - undo / redo and per-layer clear, PNG export.
 *
 * Procreate-style navigation:
 *   - two-finger pinch → zoom, pan, AND rotate the paper (snaps to
 *     quarter turns when close);
 *   - two-finger TAP → undo, three-finger TAP → redo;
 *   - touch & hold still → eyedropper loupe samples the colour under
 *     the pointer; release to make it the active colour;
 *   - a second finger landing mid-stroke CANCELS that stroke (palm
 *     and gesture safety, like Procreate);
 *   - mouse: scroll wheel zooms at the cursor (trackpad pinch works
 *     via ctrl+wheel), middle-button drag pans, hold-still with the
 *     button down triggers the eyedropper too;
 *   - − / % / + controls bottom-right; tapping the % resets the view.
 *
 * Mount/unmount survival: this component renders INSIDE the DESIGN
 * tab, so it unmounts whenever the user switches tabs. The layer
 * bitmaps must NOT die with it — so the actual <canvas> elements
 * live in a module-level map and are re-attached to the DOM on every
 * mount (a detached canvas keeps its pixels). Undo history and the
 * canvas ops Alfred's chat commands call (undo / redo / clear /
 * snapshot) are module-level too, so they work even mid tab-switch.
 */

const LOGICAL_W = 1600;
const LOGICAL_H = 1000;
/** Vision-model snapshot width — keeps the analyze payload small. */
const SNAPSHOT_W = 1024;
const UNDO_LIMIT = 30;
/** The paper — flattened into snapshots and exports. */
const CANVAS_BG = "#ffffff";
/** Zoom limits relative to the fitted base size. */
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 12;

const SWATCHES = [
  "#16181d", // ink black
  "#5b6472", // graphite
  "#b3833a", // gold
  "#e03c3c", // red
  "#e8842c", // orange
  "#1f9d55", // green
  "#2563eb", // blue
  "#7c3aed", // violet
  "#e44fb7", // pink
  "#1f9ec9", // cyan
];

interface ToolConfig {
  glyph: string;
  label: string;
  /** Width factor at zero pressure… */
  minPressure: number;
  /** …plus this much × pressure on top. */
  pressureGain: number;
}

// Size and opacity now live in the store (per-tool, user-adjustable,
// Procreate-style) — this config only keeps each tool's glyph and
// pressure character.
const TOOL_CONFIG: Record<SketchTool, ToolConfig> = {
  // Pencil: strongly pressure-driven — light touch gives a faint
  // thin line, pressing hard nearly doubles the width.
  pencil: {
    glyph: "✏",
    label: "Pencil",
    minPressure: 0.25,
    pressureGain: 1.3,
  },
  // Pen: moderate pressure response.
  pen: {
    glyph: "🖊",
    label: "Pen",
    minPressure: 0.45,
    pressureGain: 0.9,
  },
  // Marker: wide chisel, mild pressure response.
  marker: {
    glyph: "🖍",
    label: "Marker",
    minPressure: 0.75,
    pressureGain: 0.4,
  },
  // Eraser: destination-out, wide.
  eraser: {
    glyph: "⌫",
    label: "Eraser",
    minPressure: 0.8,
    pressureGain: 0.4,
  },
};

// ─── Module-level canvas + history state (survives tab switches) ────

interface HistoryEntry {
  layerId: string;
  dataUrl: string;
}

const layerCanvases = new Map<string, HTMLCanvasElement>();
const history: { undo: HistoryEntry[]; redo: HistoryEntry[] } = {
  undo: [],
  redo: [],
};

function getLayerCanvas(layerId: string): HTMLCanvasElement {
  let canvas = layerCanvases.get(layerId);
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.width = LOGICAL_W;
    canvas.height = LOGICAL_H;
    layerCanvases.set(layerId, canvas);
  }
  return canvas;
}

// In-progress stroke buffer. Translucent tools draw each segment at
// FULL alpha in here (so overlapping segment joints don't stack and
// darken), and the whole stroke is composited onto the layer ONCE at
// the tool's opacity when the pointer lifts — the same trick
// Procreate uses. While stroking, this canvas sits in the DOM right
// above the active layer with CSS opacity as the live preview.
let strokeBufferEl: HTMLCanvasElement | null = null;

function getStrokeBuffer(): HTMLCanvasElement {
  if (!strokeBufferEl) {
    strokeBufferEl = document.createElement("canvas");
    strokeBufferEl.width = LOGICAL_W;
    strokeBufferEl.height = LOGICAL_H;
    strokeBufferEl.style.position = "absolute";
    strokeBufferEl.style.inset = "0";
    strokeBufferEl.style.width = "100%";
    strokeBufferEl.style.height = "100%";
    strokeBufferEl.style.pointerEvents = "none";
  }
  return strokeBufferEl;
}

function detachStrokeBuffer() {
  if (!strokeBufferEl) return;
  strokeBufferEl.getContext("2d")?.clearRect(0, 0, LOGICAL_W, LOGICAL_H);
  strokeBufferEl.remove();
}

// ── QuickShape: pause-to-snap helpers ────────────────────────────────
//
// Classify a hand-drawn point cloud as one of {line, rect, ellipse},
// or return null if it doesn't look enough like any of them. Used
// when the pen has been still for ~350 ms mid-stroke (Procreate's
// "draw a circle, pause, watch it snap" gesture).
//
// The math is intentionally cheap — three signals, no fitting:
//   1. ``openness`` = distance(start, end) / path-length. Near 1 →
//      open path → snap to LINE. Near 0 → closed shape.
//   2. For closed shapes, the coefficient-of-variation of distance
//      from the centroid: low CV → ellipse (equidistant), high CV
//      → rect (corners poke out further than edge midpoints).
//   3. Bbox aspect ratio close to 1 → snap circle/square instead of
//      ellipse/rectangle.

interface QuickShape {
  kind: "line" | "rect" | "ellipse" | "triangle";
  start?: { x: number; y: number };
  end?: { x: number; y: number };
  bbox?: { x: number; y: number; w: number; h: number };
  // For triangles: the three vertices, ordered around the shape.
  vertices?: Array<{ x: number; y: number }>;
}

function classifyShape(
  pts: ReadonlyArray<{ x: number; y: number }>,
): QuickShape | null {
  if (pts.length < 8) return null;

  let length = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i > 0) {
      length += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
    }
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (length < 30 || (w < 10 && h < 10)) return null;

  const start = pts[0];
  const end = pts[pts.length - 1];
  const openness = Math.hypot(start.x - end.x, start.y - end.y) / length;

  // Open path → LINE. Looser thresholds than the first version
  // because hand-drawn lines have natural wobble — the previous
  // 0.6 openness + 0.15 perp budget rejected too many "obviously
  // straight" strokes.
  if (openness > 0.55) {
    const lineLen = Math.hypot(end.x - start.x, end.y - start.y);
    if (lineLen < 20) return null;
    const nx = -(end.y - start.y) / lineLen;
    const ny = (end.x - start.x) / lineLen;
    let maxPerp = 0;
    for (const p of pts) {
      const d = Math.abs((p.x - start.x) * nx + (p.y - start.y) * ny);
      if (d > maxPerp) maxPerp = d;
    }
    if (maxPerp / lineLen > 0.22) return null;
    return { kind: "line", start, end };
  }

  if (openness < 0.25) {
    // Closed shape — disambiguate rect / ellipse / triangle.
    //
    // Fill ratio (shape area / bounding box area, via the shoelace
    // formula) is the cleanest tiebreaker because the three look
    // very different on this axis:
    //   • triangle  ≈ 0.45 (half of bbox, modulo shape skew)
    //   • ellipse   ≈ 0.78 (π/4)
    //   • rectangle ≈ 0.95 (close to whole bbox)
    let signedArea = 0;
    for (let i = 0; i < pts.length; i++) {
      const p1 = pts[i];
      const p2 = pts[(i + 1) % pts.length];
      signedArea += p1.x * p2.y - p2.x * p1.y;
    }
    const fillRatio = Math.abs(signedArea / 2) / Math.max(w * h, 1);
    const bbox = { x: minX, y: minY, w, h };

    if (fillRatio < 0.6) {
      // Triangle candidate — pick the 3 vertices by running the
      // classic "highest perpendicular distance from a baseline"
      // recursion (a 2-pass simplification of Douglas-Peucker).
      const tri = findTriangleVertices(pts, start);
      if (tri) return { kind: "triangle", vertices: tri };
      return null;
    }

    // CV of radial distance from centroid: tight for ellipse,
    // loose for rectangle (corners further out than edge midpoints).
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    let sumD = 0;
    for (const p of pts) sumD += Math.hypot(p.x - cx, p.y - cy);
    const meanD = sumD / pts.length;
    let sumVar = 0;
    for (const p of pts) {
      const d = Math.hypot(p.x - cx, p.y - cy);
      sumVar += (d - meanD) * (d - meanD);
    }
    const cv = Math.sqrt(sumVar / pts.length) / Math.max(meanD, 1);
    if (cv < 0.12) return { kind: "ellipse", bbox };
    if (cv > 0.18) return { kind: "rect", bbox };
    return null;
  }

  return null;
}

/**
 * Find 3 vertices of a hand-drawn triangle. The point furthest
 * from the line joining ``start`` ↔ farthest-point gives us the
 * third corner; together with start and the farthest-from-start
 * that's a triangle. Returns null if the geometry is too degenerate
 * to bother snapping.
 */
function findTriangleVertices(
  pts: ReadonlyArray<{ x: number; y: number }>,
  start: { x: number; y: number },
): Array<{ x: number; y: number }> | null {
  // Vertex A is the user's start point (which is also the end, ~ish,
  // since the shape is closed).
  // Vertex B is the point farthest from A.
  let bIdx = 0;
  let bDist = 0;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - start.x, pts[i].y - start.y);
    if (d > bDist) {
      bDist = d;
      bIdx = i;
    }
  }
  if (bDist < 30) return null;
  const b = pts[bIdx];

  // Vertex C is the point farthest from the line A-B (perpendicular
  // distance).
  const lineLen = Math.hypot(b.x - start.x, b.y - start.y);
  if (lineLen < 1) return null;
  const nx = -(b.y - start.y) / lineLen;
  const ny = (b.x - start.x) / lineLen;
  let cDist = 0;
  let c = pts[0];
  for (const p of pts) {
    const d = Math.abs((p.x - start.x) * nx + (p.y - start.y) * ny);
    if (d > cDist) {
      cDist = d;
      c = p;
    }
  }
  // Reject if it's basically a line (too thin to be a triangle).
  if (cDist < lineLen * 0.2) return null;
  return [start, b, c];
}

/**
 * Replace the in-progress stroke on ``strokeBufferEl`` with the
 * perfect geometric version of ``shape``. The layer composite on
 * pen-lift then applies the tool's opacity — same path as a freehand
 * stroke, so QuickShape works with the same per-tool ink settings.
 */
function renderQuickShape(
  shape: QuickShape,
  color: string,
  size: number,
): void {
  const buf = strokeBufferEl;
  if (!buf) return;
  const ctx = buf.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, LOGICAL_W, LOGICAL_H);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (shape.kind === "line" && shape.start && shape.end) {
    ctx.moveTo(shape.start.x, shape.start.y);
    ctx.lineTo(shape.end.x, shape.end.y);
  } else if (shape.kind === "rect" && shape.bbox) {
    let { x, y, w, h } = shape.bbox;
    // Snap to a perfect square when the user clearly meant one.
    const aspect = w / Math.max(h, 1);
    if (aspect > 0.85 && aspect < 1.18) {
      const s = Math.max(w, h);
      x = x + w / 2 - s / 2;
      y = y + h / 2 - s / 2;
      w = h = s;
    }
    ctx.rect(x, y, w, h);
  } else if (shape.kind === "ellipse" && shape.bbox) {
    let { x, y, w, h } = shape.bbox;
    const aspect = w / Math.max(h, 1);
    if (aspect > 0.85 && aspect < 1.18) {
      // Snap to a perfect circle when the user clearly meant one.
      const s = Math.max(w, h);
      x = x + w / 2 - s / 2;
      y = y + h / 2 - s / 2;
      w = h = s;
    }
    ctx.ellipse(
      x + w / 2,
      y + h / 2,
      w / 2,
      h / 2,
      0,
      0,
      Math.PI * 2,
    );
  } else if (shape.kind === "triangle" && shape.vertices) {
    const [a, b, c] = shape.vertices;
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.closePath();
  }
  ctx.stroke();
  ctx.restore();
}

function captureLayer(layerId: string): HistoryEntry | null {
  const canvas = layerCanvases.get(layerId);
  if (!canvas) return null;
  return { layerId, dataUrl: canvas.toDataURL("image/png") };
}

function restoreLayer(entry: HistoryEntry, onDone?: () => void) {
  const canvas = layerCanvases.get(entry.layerId);
  const ctx = canvas?.getContext("2d");
  if (!ctx) {
    onDone?.();
    return;
  }
  const img = new Image();
  img.onload = () => {
    ctx.clearRect(0, 0, LOGICAL_W, LOGICAL_H);
    ctx.drawImage(img, 0, 0);
    onDone?.();
  };
  img.src = entry.dataUrl;
}

function pushUndo(layerId: string) {
  const entry = captureLayer(layerId);
  if (!entry) return;
  history.undo.push(entry);
  if (history.undo.length > UNDO_LIMIT) history.undo.shift();
  history.redo = [];
}

function undoStroke() {
  const entry = history.undo.pop();
  if (!entry) return;
  const current = captureLayer(entry.layerId);
  if (current) history.redo.push(current);
  restoreLayer(entry);
}

function redoStroke() {
  const entry = history.redo.pop();
  if (!entry) return;
  const current = captureLayer(entry.layerId);
  if (current) history.undo.push(current);
  restoreLayer(entry);
}

function clearActiveLayer() {
  const { activeLayerId, layers } = sketchStore.getSnapshot();
  const layer = layers.find((l) => l.id === activeLayerId);
  if (!layer || layer.locked) return;
  const canvas = layerCanvases.get(activeLayerId);
  if (!canvas) return;
  pushUndo(activeLayerId);
  canvas.getContext("2d")?.clearRect(0, 0, LOGICAL_W, LOGICAL_H);
}

/**
 * Merge a layer's pixels into the layer directly below it (with the
 * upper layer's opacity baked in), then remove the upper layer —
 * Procreate's "merge down". Refused when either layer is locked.
 * The lower layer's pre-merge pixels go on the undo stack.
 */
function mergeDownLayer(layerId: string) {
  const { layers } = sketchStore.getSnapshot();
  const idx = layers.findIndex((l) => l.id === layerId);
  if (idx === -1 || idx >= layers.length - 1) return;
  const upper = layers[idx];
  const lower = layers[idx + 1];
  if (upper.locked || lower.locked) return;
  const upperCanvas = layerCanvases.get(upper.id);
  const lowerCtx = getLayerCanvas(lower.id).getContext("2d");
  if (!lowerCtx) return;
  pushUndo(lower.id);
  if (upperCanvas) {
    lowerCtx.save();
    lowerCtx.globalAlpha = upper.opacity;
    lowerCtx.drawImage(upperCanvas, 0, 0);
    lowerCtx.restore();
  }
  sketchStore.removeLayer(upper.id);
  sketchStore.selectLayer(lower.id);
}

/** Flatten visible layers (bottom → top) onto the white paper. */
function flatten(targetWidth: number): HTMLCanvasElement {
  const out = document.createElement("canvas");
  const scale = targetWidth / LOGICAL_W;
  out.width = targetWidth;
  out.height = Math.round(LOGICAL_H * scale);
  const ctx = out.getContext("2d");
  if (!ctx) return out;
  ctx.fillStyle = CANVAS_BG;
  ctx.fillRect(0, 0, out.width, out.height);
  const layers = sketchStore.getSnapshot().layers;
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (!layer.visible) continue;
    const canvas = layerCanvases.get(layer.id);
    if (!canvas) continue;
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(canvas, 0, 0, out.width, out.height);
  }
  ctx.globalAlpha = 1;
  return out;
}

function captureSnapshot(): { data: string; mime_type: string } | null {
  if (typeof document === "undefined") return null;
  if (layerCanvases.size === 0) return null;
  const flat = flatten(SNAPSHOT_W);
  const dataUrl = flat.toDataURL("image/png");
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return null;
  return { data: dataUrl.slice(comma + 1), mime_type: "image/png" };
}

function exportPng() {
  const flat = flatten(LOGICAL_W);
  const link = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  link.download = `alfred-design-${stamp}.png`;
  link.href = flat.toDataURL("image/png");
  link.click();
}

function rgbToHex(r: number, g: number, b: number): string {
  const to = (n: number) => n.toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/**
 * Eyedropper sample: composite the visible layers over the white
 * paper at a single logical pixel and return the hex colour.
 */
function sampleColorAt(lx: number, ly: number): string {
  const sx = Math.min(LOGICAL_W - 1, Math.max(0, Math.round(lx)));
  const sy = Math.min(LOGICAL_H - 1, Math.max(0, Math.round(ly)));
  const c = document.createElement("canvas");
  c.width = 1;
  c.height = 1;
  const ctx = c.getContext("2d");
  if (!ctx) return CANVAS_BG;
  ctx.fillStyle = CANVAS_BG;
  ctx.fillRect(0, 0, 1, 1);
  const layers = sketchStore.getSnapshot().layers;
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (!layer.visible) continue;
    const canvas = layerCanvases.get(layer.id);
    if (!canvas) continue;
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(canvas, sx, sy, 1, 1, 0, 0, 1, 1);
  }
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return rgbToHex(d[0], d[1], d[2]);
}

// Register the canvas ops once at module load. Module-level (not in
// a component effect) so Alfred's chat commands — "undo that",
// "clear the layer" — and the send-time snapshot keep working even
// while the DESIGN tab is unmounted.
sketchStore.registerCanvasOps({
  undo: undoStroke,
  redo: redoStroke,
  clearActiveLayer,
  mergeDown: mergeDownLayer,
  captureSnapshot,
});

function useSketchState(): SketchSnapshotState {
  return useSyncExternalStore(
    sketchStore.subscribe,
    sketchStore.getSnapshot,
    sketchStore.getSnapshot,
  );
}

// ─── View (zoom / pan) types ─────────────────────────────────────────

interface ViewState {
  scale: number;
  tx: number;
  ty: number;
  /** Radians — two-finger twist rotates the paper, Procreate-style. */
  rotation: number;
}

interface PointerInfo {
  x: number;
  y: number;
}

type Gesture =
  | {
      mode: "pinch";
      dist0: number;
      /** Angle of the two-finger line at gesture start (radians). */
      angle0: number;
      /** Bounding-box centre of the paper at gesture start. */
      c0: { x: number; y: number };
      /** Vector from the paper centre to the pinch midpoint at start. */
      v0: { x: number; y: number };
      mid0: { x: number; y: number };
      view0: ViewState;
      t0: number;
      moved: boolean;
      maxPointers: number;
    }
  | {
      mode: "pan";
      pointerId: number;
      start: { x: number; y: number };
      view0: ViewState;
    };

export function SketchPad() {
  const state = useSketchState();
  // Pointer handlers need the freshest state without re-binding.
  const stateRef = useRef(state);
  stateRef.current = state;

  const viewportRef = useRef<HTMLElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const drawingRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    pressure: number;
    /** The layer this stroke targets (frozen at stroke start). */
    layerId: string;
    /**
     * True for draw tools: segments go into the stroke buffer at
     * full alpha and composite onto the layer once on pointer-up.
     * The eraser draws directly (destination-out can't be buffered).
     */
    buffered: boolean;
    /**
     * True when the active layer is locked/hidden: the pointer is
     * tracked (so the hold-eyedropper still works) but paints
     * nothing and pushed no undo entry.
     */
    inert: boolean;
    /**
     * Raw stroke point cloud, used by QuickShape's pause-to-snap.
     * Updated from the actual pointer event, NOT the streamlined
     * position — shape recognition wants the user's true path.
     */
    points: Array<{ x: number; y: number }>;
    /**
     * Once QuickShape has classified + snapped this stroke, further
     * pointer moves don't paint to the buffer (the snapped shape
     * stays locked until lift). null = no snap yet.
     */
    snap: QuickShape | null;
  } | null>(null);
  // Timestamp of the last stylus event — used to reject palm touches
  // that land while (or just after) the pen is on the glass.
  const lastPenTimeRef = useRef(0);
  // All live pointers on the viewport, by id (client coords).
  const pointersRef = useRef<Map<number, PointerInfo>>(new Map());
  // Active two-finger pinch or middle-mouse pan, if any.
  const gestureRef = useRef<Gesture | null>(null);
  // After a pinch ends, a leftover finger must NOT start drawing
  // (classic Procreate behaviour) — suppressed until all fingers lift.
  const suppressDrawRef = useRef(false);
  const viewRef = useRef<ViewState>({ scale: 1, tx: 0, ty: 0, rotation: 0 });
  const [zoomPct, setZoomPct] = useState(100);
  // Touch & hold eyedropper (Procreate-style): hold still on the
  // canvas for ~half a second and a loupe appears sampling the
  // colour under the pointer; release to make it the active colour.
  const holdTimerRef = useRef<number | null>(null);
  const strokeOriginRef = useRef<{ x: number; y: number } | null>(null);
  // QuickShape: armed when the pen has gone still mid-stroke for the
  // brief window we'll wait before trying to snap to a shape.
  const snapTimerRef = useRef<number | null>(null);
  function clearSnapTimer() {
    if (snapTimerRef.current !== null) {
      window.clearTimeout(snapTimerRef.current);
      snapTimerRef.current = null;
    }
  }
  const [eyedropper, setEyedropper] = useState<{
    pointerId: number;
    x: number;
    y: number;
    color: string;
  } | null>(null);
  const eyedropperRef = useRef<typeof eyedropper>(null);
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const [layerNameDraft, setLayerNameDraft] = useState("");

  // Attach the persistent layer canvases to the DOM (bottom → top so
  // the stack paints in order; the panel lists them top-first), apply
  // per-layer visibility/opacity, and purge canvases + history for
  // layers that no longer exist.
  useEffect(() => {
    const container = stackRef.current;
    if (!container) return;
    const ordered: HTMLCanvasElement[] = [];
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const layer = state.layers[i];
      const canvas = getLayerCanvas(layer.id);
      canvas.style.position = "absolute";
      canvas.style.inset = "0";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.pointerEvents = "none";
      canvas.style.opacity = String(layer.opacity);
      canvas.style.visibility = layer.visible ? "visible" : "hidden";
      ordered.push(canvas);
    }
    container.replaceChildren(...ordered);

    const alive = new Set(state.layers.map((l) => l.id));
    for (const id of Array.from(layerCanvases.keys())) {
      if (!alive.has(id)) layerCanvases.delete(id);
    }
    history.undo = history.undo.filter((e) => alive.has(e.layerId));
    history.redo = history.redo.filter((e) => alive.has(e.layerId));
  }, [state.layers]);

  // ── View (zoom / pan) ────────────────────────────────────────────

  function applyView(next: ViewState) {
    viewRef.current = next;
    const stack = stackRef.current;
    if (stack) {
      stack.style.transform = `translate(${next.tx}px, ${next.ty}px) rotate(${next.rotation}rad) scale(${next.scale})`;
    }
    setZoomPct(Math.round(next.scale * 100));
  }

  function resetView() {
    applyView({ scale: 1, tx: 0, ty: 0, rotation: 0 });
  }

  /** Zoom by ``factor`` keeping the client point (mx, my) fixed. */
  function zoomAt(mx: number, my: number, factor: number) {
    const stack = stackRef.current;
    if (!stack) return;
    const view = viewRef.current;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.scale * factor));
    if (next === view.scale) return;
    const rect = stack.getBoundingClientRect();
    // With a centred transform origin the bounding-box centre IS the
    // transform anchor, so it pins the maths down even when the
    // paper is rotated: to keep the cursor fixed, the centre slides
    // along the cursor→centre line as the scale changes.
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const ratio = next / view.scale;
    applyView({
      scale: next,
      rotation: view.rotation,
      tx: view.tx + (mx - cx) * (1 - ratio),
      ty: view.ty + (my - cy) * (1 - ratio),
    });
  }

  function zoomAtCenter(factor: number) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  // Wheel zoom needs a NATIVE non-passive listener — React's
  // synthetic onWheel can't preventDefault page scrolling reliably.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Trackpad pinch arrives as ctrl+wheel with fine deltas;
      // a mouse wheel zooms in comfortable 12% steps.
      const factor = e.ctrlKey
        ? Math.exp(-e.deltaY * 0.01)
        : e.deltaY < 0
          ? 1.12
          : 1 / 1.12;
      zoomAt(e.clientX, e.clientY, factor);
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Drawing ──────────────────────────────────────────────────────

  function toLogical(clientX: number, clientY: number) {
    const el = stackRef.current;
    if (!el) return { x: 0, y: 0 };
    // The bounding-box centre is invariant under the centred
    // rotate/scale transform, so it anchors the inverse mapping even
    // while the paper is rotated. offsetWidth/Height give the
    // untransformed layout size.
    const rect = el.getBoundingClientRect();
    const view = viewRef.current;
    const dx = clientX - (rect.left + rect.width / 2);
    const dy = clientY - (rect.top + rect.height / 2);
    const cos = Math.cos(-view.rotation);
    const sin = Math.sin(-view.rotation);
    const lx = (dx * cos - dy * sin) / view.scale + el.offsetWidth / 2;
    const ly = (dx * sin + dy * cos) / view.scale + el.offsetHeight / 2;
    return {
      x: (lx / el.offsetWidth) * LOGICAL_W,
      y: (ly / el.offsetHeight) * LOGICAL_H,
    };
  }

  function drawSegment(
    from: { x: number; y: number },
    to: { x: number; y: number },
    pressure: number,
  ) {
    const drawing = drawingRef.current;
    const { tool, color, toolSettings, layers } = stateRef.current;
    const layerId = drawing?.layerId ?? stateRef.current.activeLayerId;
    const layer = layers.find((l) => l.id === layerId);
    // Hidden = invisible-ink confusion; locked = protected. Skip both.
    if (!layer || !layer.visible || layer.locked) return;
    const cfg = TOOL_CONFIG[tool];
    const settings = toolSettings[tool];
    const buffered = drawing?.buffered ?? false;
    const ctx = buffered
      ? getStrokeBuffer().getContext("2d")
      : layerCanvases.get(layerId)?.getContext("2d");
    if (!ctx) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (buffered) {
      // Full alpha into the buffer — the tool's opacity is applied
      // ONCE when the finished stroke composites onto the layer, so
      // overlapping segment joints never stack and darken.
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
    } else if (tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
      // Partial opacity on the eraser = soft, gradual erasing.
      ctx.globalAlpha = settings.opacity;
    } else {
      ctx.globalAlpha = settings.opacity;
      ctx.strokeStyle = color;
    }
    ctx.lineWidth = Math.max(
      0.5,
      settings.size * (cfg.minPressure + pressure * cfg.pressureGain),
    );
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.restore();
  }

  /** 0 means "unsupported" on many touch screens — treat as mid. */
  const pressureOf = (raw: number) => (raw > 0 ? Math.min(1, raw) : 0.5);

  function clearHoldTimer() {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }

  function dismissEyedropper() {
    if (eyedropperRef.current) {
      eyedropperRef.current = null;
      setEyedropper(null);
    }
  }

  /**
   * A second finger landed mid-stroke: erase the partial stroke
   * (its pre-stroke snapshot is the newest undo entry), exactly
   * like Procreate treats a stray mark before a pinch.
   */
  function cancelActiveStroke(onDone?: () => void) {
    clearHoldTimer();
    const drawing = drawingRef.current;
    if (!drawing) {
      onDone?.();
      return;
    }
    drawingRef.current = null;
    clearSnapTimer();
    // Inert "strokes" (locked/hidden layer) never pushed an undo
    // entry and painted nothing — nothing to roll back.
    if (drawing.inert) {
      onDone?.();
      return;
    }
    if (drawing.buffered) {
      // The layer was never touched — the partial stroke only lives
      // in the buffer. Toss the buffer and the pre-stroke snapshot.
      detachStrokeBuffer();
      history.undo.pop();
      onDone?.();
      return;
    }
    const entry = history.undo.pop();
    if (entry) restoreLayer(entry, onDone);
    else onDone?.();
  }

  function beginPinch() {
    const pts = Array.from(pointersRef.current.values());
    const stack = stackRef.current;
    if (pts.length < 2 || !stack) return;
    const [a, b] = pts;
    const rect = stack.getBoundingClientRect();
    const c0 = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
    const mid0 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    gestureRef.current = {
      mode: "pinch",
      dist0: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
      angle0: Math.atan2(b.y - a.y, b.x - a.x),
      c0,
      v0: { x: mid0.x - c0.x, y: mid0.y - c0.y },
      mid0,
      view0: { ...viewRef.current },
      t0: performance.now(),
      moved: false,
      maxPointers: pointersRef.current.size,
    };
  }

  function pinchMove() {
    const gesture = gestureRef.current;
    if (!gesture || gesture.mode !== "pinch") return;
    const pts = Array.from(pointersRef.current.values());
    if (pts.length < 2) return;
    const [a, b] = pts;
    const dist = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dTheta = angle - gesture.angle0;
    if (
      Math.abs(dist / gesture.dist0 - 1) > 0.04 ||
      Math.hypot(mid.x - gesture.mid0.x, mid.y - gesture.mid0.y) > 10 ||
      Math.abs(dTheta) > 0.06
    ) {
      gesture.moved = true;
    }
    const scale = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, gesture.view0.scale * (dist / gesture.dist0)),
    );
    let rotation = gesture.view0.rotation + dTheta;
    // Procreate-style snap: settle on the nearest quarter turn when
    // within ~4° of it, so getting back to straight is effortless.
    const quarter = Math.PI / 2;
    const nearestQuarter = Math.round(rotation / quarter) * quarter;
    if (Math.abs(rotation - nearestQuarter) < 0.07) {
      rotation = nearestQuarter;
    }
    // Keep the pinch midpoint anchored to the same spot on the paper
    // while it zooms, rotates, and slides: the paper centre moves so
    // the (rotated, rescaled) start-vector still ends on the current
    // midpoint.
    const ratio = scale / gesture.view0.scale;
    const dRot = rotation - gesture.view0.rotation;
    const cos = Math.cos(dRot);
    const sin = Math.sin(dRot);
    const vx = gesture.v0.x * ratio;
    const vy = gesture.v0.y * ratio;
    const newCx = mid.x - (vx * cos - vy * sin);
    const newCy = mid.y - (vx * sin + vy * cos);
    applyView({
      scale,
      rotation,
      tx: gesture.view0.tx + (newCx - gesture.c0.x),
      ty: gesture.view0.ty + (newCy - gesture.c0.y),
    });
  }

  function handlePointerDown(e: React.PointerEvent<HTMLElement>) {
    if (e.pointerType === "pen") lastPenTimeRef.current = performance.now();
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already-lifted pointer */
    }

    // Second touch → stop drawing, start pinch navigation.
    if (pointersRef.current.size === 2) {
      cancelActiveStroke();
      dismissEyedropper();
      suppressDrawRef.current = true;
      beginPinch();
      return;
    }
    if (pointersRef.current.size > 2) {
      // Third finger joins: remember it for the three-finger-tap redo.
      const gesture = gestureRef.current;
      if (gesture?.mode === "pinch") {
        gesture.maxPointers = Math.max(
          gesture.maxPointers,
          pointersRef.current.size,
        );
      }
      return;
    }

    // Single pointer from here on.
    if (suppressDrawRef.current) return;
    if (e.pointerType === "mouse" && e.button === 1) {
      // Middle-mouse drag pans the paper.
      e.preventDefault();
      gestureRef.current = {
        mode: "pan",
        pointerId: e.pointerId,
        start: { x: e.clientX, y: e.clientY },
        view0: { ...viewRef.current },
      };
      return;
    }
    // Palm rejection: ignore finger touches that arrive while the
    // stylus has been active in the last 700 ms.
    if (
      e.pointerType === "touch" &&
      performance.now() - lastPenTimeRef.current < 700
    ) {
      return;
    }
    const { activeLayerId, layers, tool, toolSettings } = stateRef.current;
    const activeLayer = layers.find((l) => l.id === activeLayerId);
    // Locked or hidden layer: track the pointer (the hold-eyedropper
    // must still work) but don't paint or burn an undo slot.
    const inert = !activeLayer || !activeLayer.visible || activeLayer.locked;
    const buffered = !inert && tool !== "eraser";
    if (!inert) {
      pushUndo(activeLayerId);
      if (buffered) {
        // Stage the stroke buffer in the DOM directly above the
        // active layer's canvas, previewing at the tool's opacity.
        const buffer = getStrokeBuffer();
        buffer.getContext("2d")?.clearRect(0, 0, LOGICAL_W, LOGICAL_H);
        buffer.style.opacity = String(toolSettings[tool].opacity);
        const container = stackRef.current;
        const activeCanvas = layerCanvases.get(activeLayerId);
        if (
          container &&
          activeCanvas &&
          activeCanvas.parentElement === container
        ) {
          container.insertBefore(buffer, activeCanvas.nextSibling);
        } else if (container) {
          container.appendChild(buffer);
        }
      }
    }
    const pt = toLogical(e.clientX, e.clientY);
    const pressure = pressureOf(e.pressure);
    drawingRef.current = {
      pointerId: e.pointerId,
      ...pt,
      pressure,
      layerId: activeLayerId,
      buffered,
      inert,
      points: [pt],
      snap: null,
    };
    // A dot for taps.
    if (!inert) drawSegment(pt, pt, pressure);
    // Arm the touch-&-hold eyedropper: if this pointer stays nearly
    // still for ~half a second, the stroke dot is cancelled and a
    // colour-sampling loupe appears instead (Procreate behaviour).
    strokeOriginRef.current = { x: e.clientX, y: e.clientY };
    clearHoldTimer();
    const downId = e.pointerId;
    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null;
      const drawing = drawingRef.current;
      const origin = strokeOriginRef.current;
      if (!drawing || drawing.pointerId !== downId || !origin) return;
      // Sample only AFTER the cancelled stroke-dot has been wiped
      // from the canvas — the restore decodes an image async, and
      // sampling too early would just pick up the dot we drew.
      cancelActiveStroke(() => {
        // The finger may have lifted while the restore decoded.
        if (eyedropperRef.current || !pointersRef.current.has(downId)) return;
        const at = toLogical(origin.x, origin.y);
        const picked = {
          pointerId: downId,
          x: origin.x,
          y: origin.y,
          color: sampleColorAt(at.x, at.y),
        };
        eyedropperRef.current = picked;
        setEyedropper(picked);
      });
    }, 550);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLElement>) {
    const tracked = pointersRef.current.get(e.pointerId);
    if (tracked) {
      tracked.x = e.clientX;
      tracked.y = e.clientY;
    }
    const gesture = gestureRef.current;
    if (gesture?.mode === "pinch") {
      pinchMove();
      return;
    }
    if (gesture?.mode === "pan" && gesture.pointerId === e.pointerId) {
      applyView({
        scale: gesture.view0.scale,
        rotation: gesture.view0.rotation,
        tx: gesture.view0.tx + (e.clientX - gesture.start.x),
        ty: gesture.view0.ty + (e.clientY - gesture.start.y),
      });
      return;
    }

    // Eyedropper drag: follow the pointer, live-sampling the colour.
    const picker = eyedropperRef.current;
    if (picker && picker.pointerId === e.pointerId) {
      const at = toLogical(e.clientX, e.clientY);
      const next = {
        ...picker,
        x: e.clientX,
        y: e.clientY,
        color: sampleColorAt(at.x, at.y),
      };
      eyedropperRef.current = next;
      setEyedropper(next);
      return;
    }

    const drawing = drawingRef.current;
    if (!drawing || drawing.pointerId !== e.pointerId) return;
    // Real movement means it's a stroke, not a colour-sampling hold.
    if (holdTimerRef.current !== null && strokeOriginRef.current) {
      const travelled = Math.hypot(
        e.clientX - strokeOriginRef.current.x,
        e.clientY - strokeOriginRef.current.y,
      );
      if (travelled > 8) clearHoldTimer();
    }
    if (e.pointerType === "pen") lastPenTimeRef.current = performance.now();
    if (drawing.inert) return;
    // QuickShape: once a snap is locked in mid-stroke, additional
    // movement just keeps the snapped shape on screen — it doesn't
    // paint over it. User can release to commit, or undo to retry.
    if (drawing.snap) return;
    // Streamline (Procreate): exponentially blend the drawn position
    // toward the raw pointer position. ``streamline=0`` → ``alpha=1``
    // (raw passthrough, every micro-jitter shows); ``streamline=1`` →
    // ``alpha=0.05`` (silky-clean lines, cursor visibly "lags"). The
    // 0.95 cap keeps even the max setting from going so slow strokes
    // stop following the pen — that floor matches how Procreate feels
    // at 100%.
    const streamline =
      sketchStore.getSnapshot().toolSettings[sketchStore.getSnapshot().tool]
        ?.streamline ?? 0;
    const alpha = 1 - streamline * 0.95;
    // Coalesced events give the full-resolution stylus path on
    // 120 Hz+ digitisers instead of one point per frame.
    const native = e.nativeEvent;
    const events =
      typeof native.getCoalescedEvents === "function"
        ? native.getCoalescedEvents()
        : [native];
    // Track how much the pen has moved in this batch — used to arm
    // (or cancel) the QuickShape snap timer below.
    let batchMovedSq = 0;
    for (const ev of events.length > 0 ? events : [native]) {
      const raw = toLogical(ev.clientX, ev.clientY);
      const lastPoint = drawing.points[drawing.points.length - 1];
      if (lastPoint) {
        const dx = raw.x - lastPoint.x;
        const dy = raw.y - lastPoint.y;
        batchMovedSq += dx * dx + dy * dy;
      }
      drawing.points.push(raw);
      // Exponential smoothing keeps a jittery pressure sensor from
      // producing lumpy strokes.
      const pressure =
        drawing.pressure * 0.65 + pressureOf(ev.pressure) * 0.35;
      // Streamlined "next" position — blends prev output toward raw.
      const nextX = drawing.x + (raw.x - drawing.x) * alpha;
      const nextY = drawing.y + (raw.y - drawing.y) * alpha;
      drawSegment({ x: drawing.x, y: drawing.y }, { x: nextX, y: nextY }, pressure);
      drawing.x = nextX;
      drawing.y = nextY;
      drawing.pressure = pressure;
    }
    // ── QuickShape arm/disarm ─────────────────────────────────────
    // If the pen barely moved this batch AND we've gathered enough
    // points to make a shape, arm the snap timer. Any meaningful
    // movement cancels it — so dragging a tail off the shape resumes
    // freehand drawing.
    if (drawing.buffered && drawing.points.length >= 8) {
      if (batchMovedSq < 4 /* px² */) {
        if (snapTimerRef.current === null) {
          snapTimerRef.current = window.setTimeout(() => {
            snapTimerRef.current = null;
            const d = drawingRef.current;
            if (!d || !d.buffered || d.inert || d.snap) return;
            const shape = classifyShape(d.points);
            if (!shape) return;
            const snap = sketchStore.getSnapshot();
            const toolSet = snap.toolSettings[snap.tool];
            renderQuickShape(shape, snap.color, toolSet.size);
            d.snap = shape;
          }, 350);
        }
      } else {
        clearSnapTimer();
      }
    }
  }

  function handlePointerEnd(e: React.PointerEvent<HTMLElement>) {
    pointersRef.current.delete(e.pointerId);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }

    // Releasing the eyedropper commits the sampled colour.
    const picker = eyedropperRef.current;
    if (picker && picker.pointerId === e.pointerId) {
      sketchStore.setColor(picker.color);
      dismissEyedropper();
      if (pointersRef.current.size === 0) suppressDrawRef.current = false;
      return;
    }

    const gesture = gestureRef.current;
    if (gesture?.mode === "pinch" && pointersRef.current.size < 2) {
      gestureRef.current = null;
      // Quick still touch = Procreate tap shortcuts:
      // two fingers → undo, three fingers → redo.
      if (!gesture.moved && performance.now() - gesture.t0 < 300) {
        if (gesture.maxPointers >= 3) redoStroke();
        else undoStroke();
      }
    } else if (gesture?.mode === "pan" && gesture.pointerId === e.pointerId) {
      gestureRef.current = null;
    }

    if (pointersRef.current.size === 0) suppressDrawRef.current = false;

    const drawing = drawingRef.current;
    if (drawing && drawing.pointerId === e.pointerId) {
      clearHoldTimer();
      clearSnapTimer();
      // High-streamline strokes leave the smoothed position trailing
      // behind the lift point. Draw a final short segment from the
      // smoothed position to the actual lift point so the line ends
      // where the user actually lifted the pen — Procreate does this
      // implicitly because its "end-of-stroke" interpolation runs to
      // completion before commit. Skip when a QuickShape snap is
      // locked in (the buffer already holds the perfect geometry).
      if (!drawing.inert && !drawing.snap) {
        const lift = toLogical(e.clientX, e.clientY);
        const dx = lift.x - drawing.x;
        const dy = lift.y - drawing.y;
        if (dx * dx + dy * dy > 0.25) {
          drawSegment(
            { x: drawing.x, y: drawing.y },
            lift,
            drawing.pressure,
          );
        }
      }
      drawingRef.current = null;
      // Finished buffered stroke: composite it onto the layer ONCE
      // at the tool's opacity, then clear the preview buffer.
      if (drawing.buffered && strokeBufferEl) {
        const { tool, toolSettings } = stateRef.current;
        const ctx = layerCanvases.get(drawing.layerId)?.getContext("2d");
        if (ctx) {
          ctx.save();
          ctx.globalAlpha = toolSettings[tool].opacity;
          ctx.drawImage(strokeBufferEl, 0, 0);
          ctx.restore();
        }
        detachStrokeBuffer();
      }
    }
  }

  // ── Layer rename helpers ─────────────────────────────────────────

  function startRename(layer: SketchLayer) {
    setEditingLayerId(layer.id);
    setLayerNameDraft(layer.name);
  }

  function commitRename() {
    if (editingLayerId) {
      sketchStore.renameLayer(editingLayerId, layerNameDraft);
    }
    setEditingLayerId(null);
  }

  // ── Render ───────────────────────────────────────────────────────

  const cfg = TOOL_CONFIG[state.tool];
  const toolSet = state.toolSettings[state.tool];

  return (
    <div
      data-testid="sketch-pad"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "rgba(3, 6, 12, 0.85)",
      }}
    >
      {/* ── Top bar ─────────────────────────────────────────────── */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 16px",
          borderBottom: "1px solid var(--border)",
          flexWrap: "wrap",
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 14,
            letterSpacing: 4,
            color: "var(--hud)",
            textShadow: "0 0 10px var(--orb-glow)",
          }}
        >
          ✏ DESIGN PAD
        </span>
        <span
          className="mono"
          style={{ fontSize: 10, color: "var(--muted)", letterSpacing: 1 }}
        >
          {cfg.label.toUpperCase()} · {toolSet.size}px ·{" "}
          {Math.round(toolSet.opacity * 100)}%
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="hud-button"
          data-testid="sketch-undo-btn"
          onClick={undoStroke}
          title="Undo — or two-finger tap the canvas"
        >
          ↶ UNDO
        </button>
        <button
          type="button"
          className="hud-button"
          data-testid="sketch-redo-btn"
          onClick={redoStroke}
          title="Redo — or three-finger tap the canvas"
        >
          ↷ REDO
        </button>
        <button
          type="button"
          className="hud-button"
          data-testid="sketch-clear-btn"
          onClick={clearActiveLayer}
          title="Clear the active layer (undoable)"
        >
          ⌧ CLEAR LAYER
        </button>
        <button
          type="button"
          className="hud-button"
          data-testid="sketch-export-btn"
          onClick={exportPng}
          title="Download the flattened sketch as a PNG"
        >
          ⤓ EXPORT
        </button>
        <button
          type="button"
          className="hud-button"
          data-testid="sketch-close-btn"
          onClick={() => sketchStore.setOpen(false)}
          title="Back to chat (your sketch is kept)"
        >
          ✕ CLOSE
        </button>
      </header>

      {/* ── Body: tool rail / canvas / layers panel ─────────────── */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* Tool rail */}
        <aside
          style={{
            width: 92,
            padding: "12px 10px",
            borderRight: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            alignItems: "stretch",
            gap: 8,
            overflowY: "auto",
          }}
        >
          {SKETCH_TOOLS.map((tool) => (
            <button
              key={tool}
              type="button"
              className="hud-button"
              data-testid={`sketch-tool-${tool}`}
              aria-pressed={state.tool === tool}
              onClick={() => sketchStore.setTool(tool)}
              title={`${TOOL_CONFIG[tool].label} — say "Alfred, switch to the ${tool}"`}
              style={{ padding: "8px 4px", fontSize: 11 }}
            >
              {TOOL_CONFIG[tool].glyph}
              <br />
              {TOOL_CONFIG[tool].label.toUpperCase()}
            </button>
          ))}

          <div
            style={{
              borderTop: "1px solid var(--border)",
              margin: "4px 0",
            }}
          />

          {/* Brush size — per tool, like Procreate */}
          <label
            className="mono"
            style={{
              fontSize: 9,
              letterSpacing: 1.5,
              color: "var(--muted)",
              textAlign: "center",
            }}
          >
            SIZE {toolSet.size}
          </label>
          <input
            type="range"
            min={1}
            max={64}
            step={1}
            value={toolSet.size}
            data-testid="sketch-brush-slider"
            onChange={(e) => sketchStore.setBrushSize(Number(e.target.value))}
            style={{ width: "100%", accentColor: "var(--hud)" }}
          />
          {/* Tool opacity — also per tool */}
          <label
            className="mono"
            style={{
              fontSize: 9,
              letterSpacing: 1.5,
              color: "var(--muted)",
              textAlign: "center",
            }}
          >
            OPACITY {Math.round(toolSet.opacity * 100)}%
          </label>
          <input
            type="range"
            min={1}
            max={100}
            step={1}
            value={Math.round(toolSet.opacity * 100)}
            data-testid="sketch-tool-opacity-slider"
            onChange={(e) =>
              sketchStore.setBrushOpacity(Number(e.target.value) / 100)
            }
            style={{ width: "100%", accentColor: "var(--hud)" }}
          />
          {/* Streamline — exponential stroke smoothing, per tool.
              Procreate's first-impression "wow that feels good" knob. */}
          <label
            className="mono"
            style={{
              fontSize: 9,
              letterSpacing: 1.5,
              color: "var(--muted)",
              textAlign: "center",
            }}
          >
            STREAMLINE {Math.round(toolSet.streamline * 100)}%
          </label>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(toolSet.streamline * 100)}
            data-testid="sketch-streamline-slider"
            onChange={(e) =>
              sketchStore.setBrushStreamline(Number(e.target.value) / 100)
            }
            style={{ width: "100%", accentColor: "var(--hud)" }}
          />
          {/* Live brush preview dot on a paper-white chip */}
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              height: 44,
              background: CANVAS_BG,
              borderRadius: 4,
              border: "1px solid var(--border)",
            }}
          >
            <div
              style={{
                width: Math.min(36, Math.max(3, toolSet.size)),
                height: Math.min(36, Math.max(3, toolSet.size)),
                borderRadius: "50%",
                background:
                  state.tool === "eraser" ? "transparent" : state.color,
                border:
                  state.tool === "eraser" ? "1px dashed #8a96ad" : "none",
                opacity: toolSet.opacity,
              }}
            />
          </div>

          <div
            style={{
              borderTop: "1px solid var(--border)",
              margin: "4px 0",
            }}
          />

          {/* Colour swatches */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 6,
            }}
          >
            {SWATCHES.map((swatch, i) => (
              <button
                key={swatch}
                type="button"
                data-testid={`sketch-color-swatch-${i}`}
                aria-pressed={
                  state.color.toLowerCase() === swatch.toLowerCase()
                }
                onClick={() => sketchStore.setColor(swatch)}
                title={swatch}
                style={{
                  width: "100%",
                  aspectRatio: "1",
                  borderRadius: 3,
                  background: swatch,
                  cursor: "pointer",
                  border:
                    state.color.toLowerCase() === swatch.toLowerCase()
                      ? "2px solid var(--fg)"
                      : "1px solid var(--border)",
                  boxShadow:
                    state.color.toLowerCase() === swatch.toLowerCase()
                      ? `0 0 8px ${swatch}`
                      : "none",
                }}
              />
            ))}
          </div>
          {/* Free colour picker */}
          <input
            type="color"
            data-testid="sketch-color-picker"
            value={
              /^#[0-9a-fA-F]{6}$/.test(state.color) ? state.color : "#16181d"
            }
            onChange={(e) => sketchStore.setColor(e.target.value)}
            title="Pick any colour"
            style={{
              width: "100%",
              height: 28,
              padding: 0,
              border: "1px solid var(--border)",
              borderRadius: 3,
              background: "transparent",
              cursor: "pointer",
            }}
          />
        </aside>

        {/* Canvas viewport — pinch/wheel zoom + pan happens here */}
        <main
          ref={viewportRef}
          data-testid="sketch-viewport"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          style={{
            flex: 1,
            position: "relative",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            minWidth: 0,
            overflow: "hidden",
            touchAction: "none",
          }}
        >
          <div
            ref={stackRef}
            data-testid="sketch-canvas-stack"
            style={{
              position: "relative",
              width: `min(100%, calc((100vh - 260px) * ${LOGICAL_W / LOGICAL_H}))`,
              aspectRatio: `${LOGICAL_W} / ${LOGICAL_H}`,
              transformOrigin: "50% 50%",
              willChange: "transform",
              cursor: "crosshair",
              borderRadius: 2,
              // White paper, floating over the dark desk.
              background: CANVAS_BG,
              boxShadow:
                "0 8px 40px rgba(0, 0, 0, 0.55), 0 2px 10px rgba(0, 0, 0, 0.4)",
              overflow: "hidden",
            }}
          />

          {/* Zoom controls */}
          <div
            style={{
              position: "absolute",
              right: 14,
              bottom: 14,
              display: "flex",
              gap: 6,
              zIndex: 2,
            }}
          >
            <button
              type="button"
              className="hud-button"
              data-testid="sketch-zoom-out-btn"
              onClick={() => zoomAtCenter(1 / 1.25)}
              title="Zoom out (pinch or scroll wheel works too)"
            >
              −
            </button>
            <button
              type="button"
              className="hud-button"
              data-testid="sketch-zoom-reset-btn"
              onClick={resetView}
              title="Reset zoom, rotation & position"
              style={{ minWidth: 58 }}
            >
              {zoomPct}%
            </button>
            <button
              type="button"
              className="hud-button"
              data-testid="sketch-zoom-in-btn"
              onClick={() => zoomAtCenter(1.25)}
              title="Zoom in (pinch or scroll wheel works too)"
            >
              +
            </button>
          </div>

          {/* Touch & hold eyedropper loupe */}
          {eyedropper ? (
            <div
              data-testid="sketch-eyedropper-loupe"
              style={{
                position: "fixed",
                left: eyedropper.x - 32,
                top: eyedropper.y - 100,
                width: 64,
                height: 64,
                borderRadius: "50%",
                background: eyedropper.color,
                border: "3px solid #ffffff",
                boxShadow:
                  "0 4px 16px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(0, 0, 0, 0.35)",
                pointerEvents: "none",
                zIndex: 50,
              }}
            >
              <span
                className="mono"
                data-testid="sketch-eyedropper-hex"
                style={{
                  position: "absolute",
                  top: 68,
                  left: "50%",
                  transform: "translateX(-50%)",
                  fontSize: 10,
                  letterSpacing: 1,
                  color: "var(--fg)",
                  background: "rgba(3, 6, 12, 0.85)",
                  padding: "1px 6px",
                  borderRadius: 3,
                  whiteSpace: "nowrap",
                }}
              >
                {eyedropper.color.toUpperCase()}
              </span>
            </div>
          ) : null}
        </main>

        {/* Layers panel */}
        <aside
          data-testid="sketch-layers-panel"
          style={{
            width: 232,
            padding: "12px 10px",
            borderLeft: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            overflowY: "auto",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span
              className="mono"
              style={{
                fontSize: 10,
                letterSpacing: 2,
                color: "var(--hud)",
              }}
            >
              LAYERS
            </span>
            <button
              type="button"
              className="hud-button"
              data-testid="sketch-layer-add-btn"
              onClick={() => sketchStore.addLayer()}
              title='Add a layer (or say "Alfred, new layer")'
              style={{ padding: "2px 8px", fontSize: 11 }}
            >
              + ADD
            </button>
          </div>

          {state.layers.map((layer, idx) => {
            const active = layer.id === state.activeLayerId;
            return (
              <div
                key={layer.id}
                data-testid="sketch-layer-row"
                onClick={() => sketchStore.selectLayer(layer.id)}
                style={{
                  border: active
                    ? "1px solid var(--hud)"
                    : "1px solid var(--border)",
                  boxShadow: active ? "0 0 10px var(--orb-glow)" : "none",
                  borderRadius: 4,
                  padding: "6px 8px",
                  background: active
                    ? "rgba(108, 214, 255, 0.07)"
                    : "transparent",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <div
                  style={{ display: "flex", alignItems: "center", gap: 6 }}
                >
                  <button
                    type="button"
                    data-testid="sketch-layer-visibility-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      sketchStore.toggleLayerVisible(layer.id);
                    }}
                    title={layer.visible ? "Hide layer" : "Show layer"}
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      fontSize: 13,
                      padding: 0,
                      opacity: layer.visible ? 1 : 0.35,
                      color: "var(--fg)",
                    }}
                  >
                    {layer.visible ? "👁" : "🚫"}
                  </button>
                  {editingLayerId === layer.id ? (
                    <input
                      autoFocus
                      data-testid="sketch-layer-rename-input"
                      value={layerNameDraft}
                      onChange={(e) => setLayerNameDraft(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setEditingLayerId(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        background: "var(--bg-elev)",
                        border: "1px solid var(--hud-soft)",
                        borderRadius: 2,
                        color: "var(--fg)",
                        fontSize: 12,
                        padding: "1px 4px",
                      }}
                    />
                  ) : (
                    <span
                      data-testid="sketch-layer-name"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        startRename(layer);
                      }}
                      title="Double-click to rename"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 12,
                        color: active ? "var(--fg)" : "var(--muted)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {layer.name}
                    </span>
                  )}
                  <button
                    type="button"
                    data-testid="sketch-layer-lock-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      sketchStore.toggleLayerLock(layer.id);
                    }}
                    title={
                      layer.locked
                        ? "Unlock layer"
                        : "Lock layer (protects it from drawing & deletion)"
                    }
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      fontSize: 12,
                      padding: 0,
                      opacity: layer.locked ? 1 : 0.35,
                      color: layer.locked ? "var(--hud)" : "var(--fg)",
                    }}
                  >
                    {layer.locked ? "🔒" : "🔓"}
                  </button>
                  <button
                    type="button"
                    data-testid="sketch-layer-up-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      sketchStore.moveLayer(layer.id, "up");
                    }}
                    disabled={idx === 0}
                    title="Move layer up"
                    style={{
                      background: "none",
                      border: "none",
                      cursor: idx === 0 ? "default" : "pointer",
                      color: "var(--muted)",
                      opacity: idx === 0 ? 0.3 : 1,
                      fontSize: 11,
                      padding: 0,
                    }}
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    data-testid="sketch-layer-down-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      sketchStore.moveLayer(layer.id, "down");
                    }}
                    disabled={idx === state.layers.length - 1}
                    title="Move layer down"
                    style={{
                      background: "none",
                      border: "none",
                      cursor:
                        idx === state.layers.length - 1
                          ? "default"
                          : "pointer",
                      color: "var(--muted)",
                      opacity: idx === state.layers.length - 1 ? 0.3 : 1,
                      fontSize: 11,
                      padding: 0,
                    }}
                  >
                    ▼
                  </button>
                  <button
                    type="button"
                    data-testid="sketch-layer-delete-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (
                        window.confirm(
                          `Delete layer “${layer.name}”? Its strokes are lost.`,
                        )
                      ) {
                        sketchStore.removeLayer(layer.id);
                      }
                    }}
                    disabled={state.layers.length <= 1 || layer.locked}
                    title={
                      layer.locked ? "Unlock the layer first" : "Delete layer"
                    }
                    style={{
                      background: "none",
                      border: "none",
                      cursor:
                        state.layers.length <= 1 || layer.locked
                          ? "default"
                          : "pointer",
                      color: "var(--danger)",
                      opacity:
                        state.layers.length <= 1 || layer.locked ? 0.3 : 0.85,
                      fontSize: 12,
                      padding: 0,
                    }}
                  >
                    ✕
                  </button>
                </div>
                {/* Per-layer opacity + merge down */}
                <div
                  style={{ display: "flex", alignItems: "center", gap: 6 }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <span
                    className="mono"
                    style={{
                      fontSize: 8,
                      letterSpacing: 1,
                      color: "var(--muted)",
                    }}
                  >
                    OPACITY
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(layer.opacity * 100)}
                    data-testid="sketch-layer-opacity-slider"
                    onChange={(e) =>
                      sketchStore.setLayerOpacity(
                        layer.id,
                        Number(e.target.value) / 100,
                      )
                    }
                    style={{
                      flex: 1,
                      accentColor: "var(--hud)",
                      height: 12,
                    }}
                  />
                  <button
                    type="button"
                    data-testid="sketch-layer-merge-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      mergeDownLayer(layer.id);
                    }}
                    disabled={
                      idx === state.layers.length - 1 ||
                      layer.locked ||
                      state.layers[idx + 1]?.locked
                    }
                    title={
                      idx === state.layers.length - 1
                        ? "No layer below to merge into"
                        : layer.locked || state.layers[idx + 1]?.locked
                          ? "Unlock both layers first"
                          : "Merge down into the layer below"
                    }
                    style={{
                      background: "none",
                      border: "none",
                      cursor:
                        idx === state.layers.length - 1 ||
                        layer.locked ||
                        state.layers[idx + 1]?.locked
                          ? "default"
                          : "pointer",
                      color: "var(--muted)",
                      opacity:
                        idx === state.layers.length - 1 ||
                        layer.locked ||
                        state.layers[idx + 1]?.locked
                          ? 0.3
                          : 1,
                      fontSize: 13,
                      padding: 0,
                    }}
                  >
                    ⤵
                  </button>
                </div>
              </div>
            );
          })}

          <p
            style={{
              margin: "4px 0 0",
              fontSize: 10,
              color: "var(--muted)",
              fontStyle: "italic",
              lineHeight: 1.5,
            }}
          >
            Pinch to zoom, move &amp; rotate the paper. Two-finger tap =
            undo, three-finger tap = redo. Hold a finger still to sample
            a colour. Ask Alfred: &ldquo;analyze my sketch&rdquo;,
            &ldquo;new layer called shading&rdquo;.
          </p>
        </aside>
      </div>
    </div>
  );
}
