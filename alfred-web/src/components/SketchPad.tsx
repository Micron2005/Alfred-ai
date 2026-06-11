"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  SKETCH_TOOLS,
  sketchStore,
  type SketchLayer,
  type SketchSnapshotState,
  type SketchTool,
} from "@/lib/sketchStore";

/**
 * The DESIGN PAD — a JARVIS-style drafting table overlay.
 *
 * Touch / stylus drawing surface with:
 *   - multiple layers (add / delete / rename / show-hide / opacity /
 *     reorder / select), each its own stacked <canvas>;
 *   - pressure-sensitive pencil, pen, marker, and eraser (Pointer
 *     Events ``pressure``, so a real stylus modulates width — mouse
 *     and finger fall back to a constant mid pressure);
 *   - colour swatches + a free colour picker + brush size;
 *   - undo / redo (per-stroke snapshots) and per-layer clear;
 *   - PNG export.
 *
 * The component stays MOUNTED at all times (hidden with display:none
 * when closed) so the canvas pixel data survives open/close cycles.
 * Alfred drives it remotely: chat replies carry ``sketch_commands``
 * that ChatWindow forwards to ``sketchStore.applyCommand``, and the
 * mounted pad registers imperative canvas ops (undo / redo / clear /
 * snapshot) on the store so those commands reach the bitmaps.
 *
 * Canvas coordinates are a fixed logical 1600×1000 space, CSS-scaled
 * to fit the window — resizing the browser never resamples or clears
 * the artwork.
 */

const LOGICAL_W = 1600;
const LOGICAL_H = 1000;
/** Vision-model snapshot width — keeps the analyze payload small. */
const SNAPSHOT_W = 1024;
const UNDO_LIMIT = 30;
/** Drafting-table surface — flattened into snapshots and exports. */
const CANVAS_BG = "#0a1424";

const SWATCHES = [
  "#6cd6ff", // HUD cyan
  "#e6ecf5", // chalk white
  "#d6a85a", // wayne gold
  "#ff5757", // red
  "#ff9d4d", // orange
  "#7dff9b", // green
  "#4d79ff", // blue
  "#c08bff", // violet
  "#ff6cd6", // pink
  "#8a96ad", // graphite
];

interface ToolConfig {
  glyph: string;
  label: string;
  /** Stroke alpha (ink translucency). */
  alpha: number;
  /** Multiplier on the user's brush size. */
  widthScale: number;
  /** Width factor at zero pressure… */
  minPressure: number;
  /** …plus this much × pressure on top. */
  pressureGain: number;
}

const TOOL_CONFIG: Record<SketchTool, ToolConfig> = {
  // Pencil: translucent, strongly pressure-driven — light touch gives
  // a faint thin line, pressing hard nearly doubles the width.
  pencil: {
    glyph: "✏",
    label: "Pencil",
    alpha: 0.72,
    widthScale: 1,
    minPressure: 0.25,
    pressureGain: 1.3,
  },
  // Pen: opaque ink, moderate pressure response.
  pen: {
    glyph: "🖊",
    label: "Pen",
    alpha: 1,
    widthScale: 1,
    minPressure: 0.45,
    pressureGain: 0.9,
  },
  // Marker: wide translucent chisel — overlapping strokes build up.
  marker: {
    glyph: "🖍",
    label: "Marker",
    alpha: 0.32,
    widthScale: 2.4,
    minPressure: 0.75,
    pressureGain: 0.4,
  },
  // Eraser: destination-out, wide.
  eraser: {
    glyph: "⌫",
    label: "Eraser",
    alpha: 1,
    widthScale: 2.6,
    minPressure: 0.8,
    pressureGain: 0.4,
  },
};

interface HistoryEntry {
  layerId: string;
  dataUrl: string;
}

function useSketchState(): SketchSnapshotState {
  return useSyncExternalStore(
    sketchStore.subscribe,
    sketchStore.getSnapshot,
    sketchStore.getSnapshot,
  );
}

export function SketchPad() {
  const state = useSketchState();
  // Imperative closures (registered ops, pointer handlers) need the
  // freshest state without re-registering — classic ref mirror.
  const stateRef = useRef(state);
  stateRef.current = state;

  const stackRef = useRef<HTMLDivElement>(null);
  const canvasesRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const historyRef = useRef<{ undo: HistoryEntry[]; redo: HistoryEntry[] }>({
    undo: [],
    redo: [],
  });
  const drawingRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    pressure: number;
  } | null>(null);
  // Timestamp of the last stylus event — used to reject palm touches
  // that land while (or just after) the pen is on the glass.
  const lastPenTimeRef = useRef(0);
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const [layerNameDraft, setLayerNameDraft] = useState("");

  // Purge canvases + history entries for layers that no longer exist.
  useEffect(() => {
    const alive = new Set(state.layers.map((l) => l.id));
    for (const id of Array.from(canvasesRef.current.keys())) {
      if (!alive.has(id)) canvasesRef.current.delete(id);
    }
    historyRef.current.undo = historyRef.current.undo.filter((e) =>
      alive.has(e.layerId),
    );
    historyRef.current.redo = historyRef.current.redo.filter((e) =>
      alive.has(e.layerId),
    );
  }, [state.layers]);

  const captureLayer = useCallback((layerId: string): HistoryEntry | null => {
    const canvas = canvasesRef.current.get(layerId);
    if (!canvas) return null;
    return { layerId, dataUrl: canvas.toDataURL("image/png") };
  }, []);

  const restoreLayer = useCallback((entry: HistoryEntry) => {
    const canvas = canvasesRef.current.get(entry.layerId);
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, LOGICAL_W, LOGICAL_H);
      ctx.drawImage(img, 0, 0);
    };
    img.src = entry.dataUrl;
  }, []);

  const pushUndo = useCallback(
    (layerId: string) => {
      const entry = captureLayer(layerId);
      if (!entry) return;
      historyRef.current.undo.push(entry);
      if (historyRef.current.undo.length > UNDO_LIMIT) {
        historyRef.current.undo.shift();
      }
      historyRef.current.redo = [];
    },
    [captureLayer],
  );

  const undo = useCallback(() => {
    const entry = historyRef.current.undo.pop();
    if (!entry) return;
    const current = captureLayer(entry.layerId);
    if (current) historyRef.current.redo.push(current);
    restoreLayer(entry);
  }, [captureLayer, restoreLayer]);

  const redo = useCallback(() => {
    const entry = historyRef.current.redo.pop();
    if (!entry) return;
    const current = captureLayer(entry.layerId);
    if (current) historyRef.current.undo.push(current);
    restoreLayer(entry);
  }, [captureLayer, restoreLayer]);

  const clearActiveLayer = useCallback(() => {
    const { activeLayerId } = stateRef.current;
    const canvas = canvasesRef.current.get(activeLayerId);
    if (!canvas) return;
    pushUndo(activeLayerId);
    canvas.getContext("2d")?.clearRect(0, 0, LOGICAL_W, LOGICAL_H);
  }, [pushUndo]);

  /** Flatten visible layers (bottom → top) onto the pad background. */
  const flatten = useCallback((targetWidth: number): HTMLCanvasElement => {
    const out = document.createElement("canvas");
    const scale = targetWidth / LOGICAL_W;
    out.width = targetWidth;
    out.height = Math.round(LOGICAL_H * scale);
    const ctx = out.getContext("2d");
    if (!ctx) return out;
    ctx.fillStyle = CANVAS_BG;
    ctx.fillRect(0, 0, out.width, out.height);
    const layers = stateRef.current.layers;
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      if (!layer.visible) continue;
      const canvas = canvasesRef.current.get(layer.id);
      if (!canvas) continue;
      ctx.globalAlpha = layer.opacity;
      ctx.drawImage(canvas, 0, 0, out.width, out.height);
    }
    ctx.globalAlpha = 1;
    return out;
  }, []);

  const captureSnapshot = useCallback(() => {
    if (canvasesRef.current.size === 0) return null;
    const flat = flatten(SNAPSHOT_W);
    const dataUrl = flat.toDataURL("image/png");
    const comma = dataUrl.indexOf(",");
    if (comma === -1) return null;
    return { data: dataUrl.slice(comma + 1), mime_type: "image/png" };
  }, [flatten]);

  const exportPng = useCallback(() => {
    const flat = flatten(LOGICAL_W);
    const link = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    link.download = `alfred-design-${stamp}.png`;
    link.href = flat.toDataURL("image/png");
    link.click();
  }, [flatten]);

  // Hand the imperative ops to the store so Alfred's chat commands
  // (undo / redo / clear) and ChatWindow's send-time snapshot reach
  // the actual bitmaps.
  useEffect(() => {
    sketchStore.registerCanvasOps({
      undo,
      redo,
      clearActiveLayer,
      captureSnapshot,
    });
    return () => sketchStore.registerCanvasOps(null);
  }, [undo, redo, clearActiveLayer, captureSnapshot]);

  // ── Drawing ──────────────────────────────────────────────────────

  const toLogical = useCallback((clientX: number, clientY: number) => {
    const el = stackRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * LOGICAL_W,
      y: ((clientY - rect.top) / rect.height) * LOGICAL_H,
    };
  }, []);

  const drawSegment = useCallback(
    (
      from: { x: number; y: number },
      to: { x: number; y: number },
      pressure: number,
    ) => {
      const { activeLayerId, tool, color, brushSize, layers } =
        stateRef.current;
      const layer = layers.find((l) => l.id === activeLayerId);
      // Drawing on a hidden layer is invisible-ink confusion — skip.
      if (!layer || !layer.visible) return;
      const canvas = canvasesRef.current.get(activeLayerId);
      const ctx = canvas?.getContext("2d");
      if (!ctx) return;
      const cfg = TOOL_CONFIG[tool];
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (tool === "eraser") {
        ctx.globalCompositeOperation = "destination-out";
        ctx.strokeStyle = "rgba(0,0,0,1)";
      } else {
        ctx.globalAlpha = cfg.alpha;
        ctx.strokeStyle = color;
      }
      ctx.lineWidth = Math.max(
        0.5,
        brushSize *
          cfg.widthScale *
          (cfg.minPressure + pressure * cfg.pressureGain),
      );
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.restore();
    },
    [],
  );

  /** 0 means "unsupported" on many touch screens — treat as mid. */
  const pressureOf = (raw: number) => (raw > 0 ? Math.min(1, raw) : 0.5);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Single-pointer drawing — a second finger mid-stroke is a palm
      // or an accidental touch, never a second brush.
      if (drawingRef.current) return;
      if (e.pointerType === "pen") lastPenTimeRef.current = performance.now();
      // Palm rejection: ignore finger touches that arrive while the
      // stylus has been active in the last 700 ms.
      if (
        e.pointerType === "touch" &&
        performance.now() - lastPenTimeRef.current < 700
      ) {
        return;
      }
      const { activeLayerId } = stateRef.current;
      pushUndo(activeLayerId);
      e.currentTarget.setPointerCapture(e.pointerId);
      const pt = toLogical(e.clientX, e.clientY);
      const pressure = pressureOf(e.pressure);
      drawingRef.current = { pointerId: e.pointerId, ...pt, pressure };
      // A dot for taps.
      drawSegment(pt, pt, pressure);
    },
    [pushUndo, toLogical, drawSegment],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drawing = drawingRef.current;
      if (!drawing || drawing.pointerId !== e.pointerId) return;
      if (e.pointerType === "pen") lastPenTimeRef.current = performance.now();
      // Coalesced events give the full-resolution stylus path on
      // 120 Hz+ digitisers instead of one point per frame.
      const native = e.nativeEvent;
      const events =
        typeof native.getCoalescedEvents === "function"
          ? native.getCoalescedEvents()
          : [native];
      for (const ev of events.length > 0 ? events : [native]) {
        const pt = toLogical(ev.clientX, ev.clientY);
        // Exponential smoothing keeps a jittery pressure sensor from
        // producing lumpy strokes.
        const pressure =
          drawing.pressure * 0.65 + pressureOf(ev.pressure) * 0.35;
        drawSegment({ x: drawing.x, y: drawing.y }, pt, pressure);
        drawing.x = pt.x;
        drawing.y = pt.y;
        drawing.pressure = pressure;
      }
    },
    [toLogical, drawSegment],
  );

  const handlePointerEnd = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drawing = drawingRef.current;
      if (!drawing || drawing.pointerId !== e.pointerId) return;
      drawingRef.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    },
    [],
  );

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

  return (
    <div
      data-testid="sketch-pad"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9000,
        display: state.open ? "flex" : "none",
        flexDirection: "column",
        background: "rgba(3, 6, 12, 0.96)",
        backdropFilter: "blur(6px)",
      }}
    >
      {/* ── Top bar ─────────────────────────────────────────────── */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 16px",
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
          {cfg.label.toUpperCase()} · {state.brushSize}px
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="hud-button"
          data-testid="sketch-undo-btn"
          onClick={undo}
          title="Undo last stroke (Alfred: 'undo that')"
        >
          ↶ UNDO
        </button>
        <button
          type="button"
          className="hud-button"
          data-testid="sketch-redo-btn"
          onClick={redo}
          title="Redo"
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
          title="Close the design pad (your sketch is kept)"
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

          {/* Brush size */}
          <label
            className="mono"
            style={{
              fontSize: 9,
              letterSpacing: 1.5,
              color: "var(--muted)",
              textAlign: "center",
            }}
          >
            SIZE {state.brushSize}
          </label>
          <input
            type="range"
            min={1}
            max={64}
            step={1}
            value={state.brushSize}
            data-testid="sketch-brush-slider"
            onChange={(e) =>
              sketchStore.setBrushSize(Number(e.target.value))
            }
            style={{ width: "100%", accentColor: "var(--hud)" }}
          />
          {/* Live brush preview dot */}
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              height: 40,
            }}
          >
            <div
              style={{
                width: Math.min(36, Math.max(3, state.brushSize)),
                height: Math.min(36, Math.max(3, state.brushSize)),
                borderRadius: "50%",
                background:
                  state.tool === "eraser" ? "transparent" : state.color,
                border:
                  state.tool === "eraser"
                    ? "1px dashed var(--muted)"
                    : "none",
                opacity: TOOL_CONFIG[state.tool].alpha,
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
            value={/^#[0-9a-fA-F]{6}$/.test(state.color) ? state.color : "#6cd6ff"}
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

        {/* Canvas area */}
        <main
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          <div
            ref={stackRef}
            data-testid="sketch-canvas-stack"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            style={{
              position: "relative",
              width: "100%",
              maxWidth: `calc((100vh - 140px) * ${LOGICAL_W / LOGICAL_H})`,
              aspectRatio: `${LOGICAL_W} / ${LOGICAL_H}`,
              touchAction: "none",
              cursor: "crosshair",
              border: "1px solid var(--border)",
              borderRadius: 4,
              boxShadow: "var(--shadow), inset 0 0 60px rgba(0,0,0,0.4)",
              background: CANVAS_BG,
              // Blueprint grid — drawn by CSS so it never pollutes the
              // exported/analyzed bitmap (flatten() fills plain BG).
              backgroundImage:
                "linear-gradient(rgba(108,214,255,0.06) 1px, transparent 1px)," +
                "linear-gradient(90deg, rgba(108,214,255,0.06) 1px, transparent 1px)",
              backgroundSize: "32px 32px",
              overflow: "hidden",
            }}
          >
            {/* Bottom layer first in the DOM so the stack paints in
                order; the panel lists them top-first. */}
            {[...state.layers].reverse().map((layer) => (
              <canvas
                key={layer.id}
                ref={(el) => {
                  if (el) canvasesRef.current.set(layer.id, el);
                }}
                width={LOGICAL_W}
                height={LOGICAL_H}
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  opacity: layer.opacity,
                  visibility: layer.visible ? "visible" : "hidden",
                  pointerEvents: "none",
                }}
              />
            ))}
          </div>
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
                    disabled={state.layers.length <= 1}
                    title="Delete layer"
                    style={{
                      background: "none",
                      border: "none",
                      cursor:
                        state.layers.length <= 1 ? "default" : "pointer",
                      color: "var(--danger)",
                      opacity: state.layers.length <= 1 ? 0.3 : 0.85,
                      fontSize: 12,
                      padding: 0,
                    }}
                  >
                    ✕
                  </button>
                </div>
                {/* Per-layer opacity */}
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
            Ask Alfred: &ldquo;analyze my sketch&rdquo;, &ldquo;new layer
            called shading&rdquo;, &ldquo;switch to the red pen&rdquo;,
            &ldquo;undo that&rdquo;.
          </p>
        </aside>
      </div>
    </div>
  );
}
