/**
 * Shared design-pad (sketch pad) state store.
 *
 * Same external-store pattern as ``orbState.ts``: a singleton class
 * with subscribe/getSnapshot for useSyncExternalStore consumers.
 *
 * Why a store and not component state? Three parties touch the pad:
 *   - SketchPad.tsx renders the canvas + chrome and owns the actual
 *     pixel data (per-layer <canvas> elements + undo history).
 *   - ChatWindow.tsx needs the live state at send-time (to build the
 *     sketch signal for the backend) and applies the sketch commands
 *     Alfred returns ("open the pad", "switch to pen", …).
 *   - The header DESIGN button toggles visibility.
 *
 * Pixel-level operations (undo / redo / clear / snapshot) can't live
 * here — they need the canvas elements — so the mounted SketchPad
 * registers an imperative ops object the store delegates to.
 */

export type SketchTool = "pencil" | "pen" | "marker" | "eraser";

export const SKETCH_TOOLS: SketchTool[] = [
  "pencil",
  "pen",
  "marker",
  "eraser",
];

export interface SketchLayer {
  id: string;
  name: string;
  visible: boolean;
  /** 0..1 — applied via CSS on the layer canvas and during flatten. */
  opacity: number;
  /** Locked layers can't be drawn on, cleared, merged, or deleted. */
  locked: boolean;
}

/** Per-tool brush settings — each tool remembers its own, Procreate-style. */
export interface ToolSettings {
  size: number;
  /** Ink opacity 0..1 (the tool's own translucency, not the layer's). */
  opacity: number;
  /**
   * Stroke smoothing, 0..1 (we surface it to the UI as 0–100%).
   *
   * 0 = raw input — every micro-jitter from the stylus comes through;
   * 1 = maximum smoothing — the cursor "lags" behind the pen but lines
   * come out silky-clean. Implemented as an exponential filter in
   * SketchPad: ``smoothed = lerp(smoothed, raw, 1 - streamline*0.95)``.
   *
   * Defaults are tool-appropriate — pen leans heavier than pencil,
   * which wants to feel raw and grippy. Procreate sets per-brush.
   */
  streamline: number;
}

export const DEFAULT_TOOL_SETTINGS: Record<SketchTool, ToolSettings> = {
  // Pencil — Procreate-style soft graphite. Slightly higher
  // default opacity than v1 because the new draw model (halo +
  // body + spine + grain) self-modulates alpha across the three
  // passes; a 0.55 base ends up reading like ~0.4 perceptually
  // which is too faint.
  pencil: { size: 5, opacity: 0.85, streamline: 0.25 },
  // Pen — confident, opaque ink, mid streamline for clean curves.
  pen: { size: 6, opacity: 1, streamline: 0.5 },
  marker: { size: 16, opacity: 0.32, streamline: 0.35 },
  eraser: { size: 20, opacity: 1, streamline: 0.2 },
};

export interface SketchSnapshotState {
  open: boolean;
  tool: SketchTool;
  color: string;
  /** Per-tool size + opacity; the active tool's entry is what draws. */
  toolSettings: Record<SketchTool, ToolSettings>;
  /** Index 0 = TOP of the stack (matches the layers panel ordering). */
  layers: SketchLayer[];
  activeLayerId: string;
  /** Bumped on every change so useSyncExternalStore re-renders. */
  version: number;
}

/** Imperative canvas operations the mounted SketchPad registers. */
export interface SketchCanvasOps {
  undo(): void;
  redo(): void;
  clearActiveLayer(): void;
  /** Composite a layer's pixels into the layer below and remove it. */
  mergeDown(layerId: string): void;
  /**
   * Flattened PNG of the visible layers (downscaled for the vision
   * model), base64 without the ``data:`` prefix. Null when no canvas
   * is mounted.
   */
  captureSnapshot(): { data: string; mime_type: string } | null;
}

type Listener = () => void;

const MIN_BRUSH = 1;
const MAX_BRUSH = 64;

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `layer-${Math.random().toString(36).slice(2)}`;
}

/** Accept any colour the browser itself can parse (hex, names, rgb()). */
function isValidCssColor(value: string): boolean {
  if (typeof document === "undefined") return true;
  const probe = new Option().style;
  probe.color = "";
  probe.color = value;
  return probe.color !== "";
}

class SketchStore {
  private state: SketchSnapshotState;
  private listeners = new Set<Listener>();
  private canvasOps: SketchCanvasOps | null = null;
  private layerCounter = 1;

  constructor() {
    const first: SketchLayer = {
      id: makeId(),
      name: "Layer 1",
      visible: true,
      opacity: 1,
      locked: false,
    };
    this.state = {
      open: false,
      tool: "pen",
      color: "#16181d",
      toolSettings: {
        pencil: { ...DEFAULT_TOOL_SETTINGS.pencil },
        pen: { ...DEFAULT_TOOL_SETTINGS.pen },
        marker: { ...DEFAULT_TOOL_SETTINGS.marker },
        eraser: { ...DEFAULT_TOOL_SETTINGS.eraser },
      },
      layers: [first],
      activeLayerId: first.id,
      version: 0,
    };
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): SketchSnapshotState => this.state;

  private commit(patch: Partial<SketchSnapshotState>) {
    this.state = { ...this.state, ...patch, version: this.state.version + 1 };
    for (const l of this.listeners) l();
  }

  registerCanvasOps(ops: SketchCanvasOps | null) {
    this.canvasOps = ops;
  }

  captureSnapshot(): { data: string; mime_type: string } | null {
    return this.canvasOps?.captureSnapshot() ?? null;
  }

  setOpen(open: boolean) {
    if (this.state.open === open) return;
    this.commit({ open });
  }

  setTool(tool: SketchTool) {
    if (!SKETCH_TOOLS.includes(tool)) return;
    this.commit({ tool });
  }

  setColor(color: string) {
    if (!isValidCssColor(color)) return;
    this.commit({ color });
  }

  /** Patch the ACTIVE tool's settings (each tool keeps its own). */
  private updateActiveTool(patch: Partial<ToolSettings>) {
    const tool = this.state.tool;
    this.commit({
      toolSettings: {
        ...this.state.toolSettings,
        [tool]: { ...this.state.toolSettings[tool], ...patch },
      },
    });
  }

  setBrushSize(size: number) {
    if (!Number.isFinite(size)) return;
    this.updateActiveTool({
      size: Math.max(MIN_BRUSH, Math.min(MAX_BRUSH, size)),
    });
  }

  /** Tool opacity, 0..1. */
  setBrushOpacity(opacity: number) {
    if (!Number.isFinite(opacity)) return;
    this.updateActiveTool({
      opacity: Math.max(0.01, Math.min(1, opacity)),
    });
  }

  /** Stroke smoothing, 0..1 — 0 raw, 1 maximally streamlined. */
  setBrushStreamline(streamline: number) {
    if (!Number.isFinite(streamline)) return;
    this.updateActiveTool({
      streamline: Math.max(0, Math.min(1, streamline)),
    });
  }

  /** New layers go on TOP of the stack and become active. */
  addLayer(name?: string) {
    this.layerCounter += 1;
    const base = (name ?? "").trim() || `Layer ${this.layerCounter}`;
    // De-dupe names so LAYER_SELECT-by-name stays unambiguous.
    let unique = base;
    let suffix = 2;
    while (this.state.layers.some((l) => l.name === unique)) {
      unique = `${base} (${suffix})`;
      suffix += 1;
    }
    const layer: SketchLayer = {
      id: makeId(),
      name: unique,
      visible: true,
      opacity: 1,
      locked: false,
    };
    this.commit({
      layers: [layer, ...this.state.layers],
      activeLayerId: layer.id,
    });
  }

  removeLayer(id: string) {
    if (this.state.layers.length <= 1) return;
    const idx = this.state.layers.findIndex((l) => l.id === id);
    if (idx === -1) return;
    // Locked layers are protected from deletion — unlock first.
    if (this.state.layers[idx].locked) return;
    const layers = this.state.layers.filter((l) => l.id !== id);
    let activeLayerId = this.state.activeLayerId;
    if (activeLayerId === id) {
      activeLayerId = layers[Math.min(idx, layers.length - 1)].id;
    }
    this.commit({ layers, activeLayerId });
  }

  selectLayer(id: string) {
    if (!this.state.layers.some((l) => l.id === id)) return;
    this.commit({ activeLayerId: id });
  }

  /**
   * Find a layer the way Alfred refers to it: exact name first
   * (case-insensitive), then substring, then a 1-based index counted
   * from the top of the layers panel ("layer 2").
   */
  findLayerByName(query: string): string | null {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const layers = this.state.layers;
    const exact = layers.find((l) => l.name.toLowerCase() === q);
    if (exact) return exact.id;
    const partial = layers.find((l) => l.name.toLowerCase().includes(q));
    if (partial) return partial.id;
    const num = Number.parseInt(q.replace(/^layer\s+/i, ""), 10);
    if (Number.isFinite(num) && num >= 1 && num <= layers.length) {
      return layers[num - 1].id;
    }
    return null;
  }

  selectLayerByName(query: string) {
    const id = this.findLayerByName(query);
    if (id) this.selectLayer(id);
  }

  toggleLayerVisible(id: string) {
    this.commit({
      layers: this.state.layers.map((l) =>
        l.id === id ? { ...l, visible: !l.visible } : l,
      ),
    });
  }

  setLayerOpacity(id: string, opacity: number) {
    const clamped = Math.max(0, Math.min(1, opacity));
    this.commit({
      layers: this.state.layers.map((l) =>
        l.id === id ? { ...l, opacity: clamped } : l,
      ),
    });
  }

  setLayerLocked(id: string, locked: boolean) {
    this.commit({
      layers: this.state.layers.map((l) =>
        l.id === id ? { ...l, locked } : l,
      ),
    });
  }

  toggleLayerLock(id: string) {
    const layer = this.state.layers.find((l) => l.id === id);
    if (layer) this.setLayerLocked(id, !layer.locked);
  }

  renameLayer(id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.commit({
      layers: this.state.layers.map((l) =>
        l.id === id ? { ...l, name: trimmed } : l,
      ),
    });
  }

  /** Move a layer one slot up (toward the top) or down in the stack. */
  moveLayer(id: string, direction: "up" | "down") {
    const layers = [...this.state.layers];
    const idx = layers.findIndex((l) => l.id === id);
    if (idx === -1) return;
    const target = direction === "up" ? idx - 1 : idx + 1;
    if (target < 0 || target >= layers.length) return;
    [layers[idx], layers[target]] = [layers[target], layers[idx]];
    this.commit({ layers });
  }

  /**
   * Apply one command from Alfred's reply (``ChatReply.sketch_commands``).
   * Any command other than open/close implies the pad should be on
   * screen, so they auto-open it — "grab the red pen" Just Works even
   * if the pad was closed.
   */
  applyCommand(action: string, value: string) {
    if (action === "open") return this.setOpen(true);
    if (action === "close") return this.setOpen(false);
    if (!this.state.open) this.setOpen(true);
    switch (action) {
      case "tool":
        this.setTool(value as SketchTool);
        return;
      case "color":
        this.setColor(value);
        return;
      case "brush": {
        const size = Number.parseFloat(value);
        if (Number.isFinite(size)) this.setBrushSize(size);
        return;
      }
      case "opacity": {
        // Alfred speaks percent (1-100); the store keeps 0..1.
        const pct = Number.parseFloat(value);
        if (Number.isFinite(pct)) this.setBrushOpacity(pct / 100);
        return;
      }
      case "layer_add":
        this.addLayer(value || undefined);
        return;
      case "layer_select":
        this.selectLayerByName(value);
        return;
      case "layer_merge": {
        const id = value
          ? this.findLayerByName(value)
          : this.state.activeLayerId;
        if (id) this.canvasOps?.mergeDown(id);
        return;
      }
      case "layer_lock":
      case "layer_unlock": {
        const id = value
          ? this.findLayerByName(value)
          : this.state.activeLayerId;
        if (id) this.setLayerLocked(id, action === "layer_lock");
        return;
      }
      case "undo":
        this.canvasOps?.undo();
        return;
      case "redo":
        this.canvasOps?.redo();
        return;
      case "clear":
        this.canvasOps?.clearActiveLayer();
        return;
      default:
        // Unknown action from a newer backend — ignore quietly.
        return;
    }
  }
}

export const sketchStore = new SketchStore();
