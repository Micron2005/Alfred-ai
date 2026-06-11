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
}

export interface SketchSnapshotState {
  open: boolean;
  tool: SketchTool;
  color: string;
  brushSize: number;
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
    };
    this.state = {
      open: false,
      tool: "pen",
      color: "#6cd6ff",
      brushSize: 6,
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

  setBrushSize(size: number) {
    if (!Number.isFinite(size)) return;
    this.commit({
      brushSize: Math.max(MIN_BRUSH, Math.min(MAX_BRUSH, size)),
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
   * Select a layer the way Alfred refers to it: exact name first
   * (case-insensitive), then prefix/substring, then a 1-based index
   * counted from the top of the layers panel ("layer 2").
   */
  selectLayerByName(query: string) {
    const q = query.trim().toLowerCase();
    if (!q) return;
    const layers = this.state.layers;
    const exact = layers.find((l) => l.name.toLowerCase() === q);
    if (exact) return this.selectLayer(exact.id);
    const partial = layers.find((l) => l.name.toLowerCase().includes(q));
    if (partial) return this.selectLayer(partial.id);
    const num = Number.parseInt(q.replace(/^layer\s+/i, ""), 10);
    if (Number.isFinite(num) && num >= 1 && num <= layers.length) {
      this.selectLayer(layers[num - 1].id);
    }
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
      case "layer_add":
        this.addLayer(value || undefined);
        return;
      case "layer_select":
        this.selectLayerByName(value);
        return;
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
