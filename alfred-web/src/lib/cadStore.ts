"use client";

/**
 * CAD scene state — single Zustand store that owns every object
 * the user has placed in the design studio plus the currently
 * selected one and the active gizmo mode.
 *
 * Persisted to ``localStorage`` automatically so a page refresh
 * doesn't delete the user's work. The persisted shape is just
 * the JSON representation of the array of nodes; cameras, gizmo
 * state, and selection are intentionally not persisted (less
 * disorienting on reload).
 */

import { create } from "zustand";

export type CadPrimitive =
  | "cube"
  | "sphere"
  | "cylinder"
  | "cone"
  | "torus";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface CadNode {
  id: string;
  name: string;
  primitive: CadPrimitive;
  /** All sizes are in millimetres so they're directly meaningful
   *  for 3D printing. The Three.js scene scales them down by 1000
   *  (1 unit = 1 m in three.js) at render time. */
  size: Vec3;
  position: Vec3;
  rotation: Vec3;
  color: string;
  /** Sphere subdivisions / cylinder radial segments / etc. Stored
   *  per-node so the user can change quality on a per-object basis. */
  detail: number;
}

export type GizmoMode = "translate" | "rotate" | "scale";

interface CadState {
  nodes: CadNode[];
  selectedId: string | null;
  gizmoMode: GizmoMode;
  addPrimitive: (p: CadPrimitive) => void;
  remove: (id: string) => void;
  duplicate: (id: string) => void;
  select: (id: string | null) => void;
  setMode: (m: GizmoMode) => void;
  updateNode: (id: string, patch: Partial<CadNode>) => void;
  clear: () => void;
}

const STORAGE_KEY = "alfred.cad.scene.v1";

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function defaultsFor(p: CadPrimitive): Omit<CadNode, "id" | "name" | "primitive"> {
  switch (p) {
    case "cube":
      return base({ size: { x: 30, y: 30, z: 30 }, color: "#6cd6ff" });
    case "sphere":
      return base({ size: { x: 20, y: 20, z: 20 }, color: "#ffc83c", detail: 32 });
    case "cylinder":
      return base({ size: { x: 20, y: 40, z: 20 }, color: "#66f0a0", detail: 32 });
    case "cone":
      return base({ size: { x: 20, y: 40, z: 20 }, color: "#ff7878", detail: 32 });
    case "torus":
      return base({ size: { x: 30, y: 8, z: 30 }, color: "#c478ff", detail: 32 });
  }
}

function base(
  overrides: Partial<Omit<CadNode, "id" | "name" | "primitive">> = {},
): Omit<CadNode, "id" | "name" | "primitive"> {
  return {
    size: { x: 20, y: 20, z: 20 },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    color: "#6cd6ff",
    detail: 16,
    ...overrides,
  };
}

function nameFor(primitive: CadPrimitive, existing: CadNode[]): string {
  const same = existing.filter((n) => n.primitive === primitive).length + 1;
  return `${primitive[0].toUpperCase()}${primitive.slice(1)} ${same}`;
}

function loadInitial(): CadNode[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as CadNode[];
  } catch {
    return [];
  }
}

function persist(nodes: CadNode[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nodes));
  } catch {
    // localStorage full / disabled — just drop.
  }
}

export const useCadStore = create<CadState>((set) => ({
  nodes: loadInitial(),
  selectedId: null,
  gizmoMode: "translate",
  addPrimitive: (p) =>
    set((state) => {
      const node: CadNode = {
        id: uid(),
        name: nameFor(p, state.nodes),
        primitive: p,
        ...defaultsFor(p),
      };
      // New nodes are placed slightly above origin so they don't
      // ghost-overlap whatever's already at (0, 0, 0).
      node.position = {
        x: 0,
        y: node.size.y / 2,
        z: 0,
      };
      const nodes = [...state.nodes, node];
      persist(nodes);
      return { nodes, selectedId: node.id };
    }),
  remove: (id) =>
    set((state) => {
      const nodes = state.nodes.filter((n) => n.id !== id);
      persist(nodes);
      return {
        nodes,
        selectedId: state.selectedId === id ? null : state.selectedId,
      };
    }),
  duplicate: (id) =>
    set((state) => {
      const original = state.nodes.find((n) => n.id === id);
      if (!original) return state;
      const copy: CadNode = {
        ...original,
        id: uid(),
        name: `${original.name} copy`,
        position: {
          ...original.position,
          x: original.position.x + Math.max(5, original.size.x * 0.6),
        },
      };
      const nodes = [...state.nodes, copy];
      persist(nodes);
      return { nodes, selectedId: copy.id };
    }),
  select: (id) => set({ selectedId: id }),
  setMode: (m) => set({ gizmoMode: m }),
  updateNode: (id, patch) =>
    set((state) => {
      const nodes = state.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n));
      persist(nodes);
      return { nodes };
    }),
  clear: () =>
    set(() => {
      persist([]);
      return { nodes: [], selectedId: null };
    }),
}));
