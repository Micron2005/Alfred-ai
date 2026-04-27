"use client";

/**
 * Customizable HUD layout state.
 *
 * The JARVIS HUD widgets (clock, weather, forecast strip, orb,
 * Spotify, camera preview) can be repositioned, resized, or hidden
 * by the user via the "🎛 CUSTOMIZE" mode in the header. This module
 * is the single source of truth for that layout state — it owns the
 * shape, the localStorage persistence, and the React hook that
 * components subscribe to.
 *
 * Two-tier model:
 * 1. ``customEnabled`` — when ``false`` (the default for everyone
 *    until they click 🎛 CUSTOMIZE), widgets render in their
 *    out-of-the-box flow positions. This keeps the HUD looking
 *    correct for users who never touch the customize feature.
 * 2. ``customEnabled = true`` — widgets render absolutely positioned
 *    at ``layout[id].{x, y, w, h}``, and ``editMode`` controls
 *    whether the drag/resize/hide handles are visible.
 *
 * Hidden widgets (``visible: false``) reappear as small "show" chips
 * in the customize toolbar so users can re-add them without
 * resetting the whole layout.
 */

import { useEffect, useState, useSyncExternalStore } from "react";

const STORAGE_KEY = "alfred.hudLayout.v1";
const ENABLED_KEY = "alfred.hudCustomEnabled";

export type HudWidgetId =
  | "clock"
  | "weather-current"
  | "weather-strip"
  | "orb"
  | "spotify"
  | "camera";

export interface WidgetLayout {
  /** Top-left X position (px) inside the main pane. */
  x: number;
  /** Top-left Y position (px) inside the main pane. */
  y: number;
  /** Width in px. ``"auto"`` lets the widget size to its content. */
  w: number | "auto";
  /** Height in px. ``"auto"`` lets the widget size to its content. */
  h: number | "auto";
  /** ``false`` hides the widget entirely (still mounted, see
   *  HudWidget — ``display:none``). Default visibility is set per
   *  widget via {@link DEFAULT_VISIBILITY}. */
  visible: boolean;
}

export type HudLayoutState = Record<HudWidgetId, WidgetLayout>;

/** Sensible starting positions when a user first enables custom
 *  mode. Widgets are arranged top-to-bottom on the right half of
 *  the main pane so they don't overlap the orb (which sits centred
 *  by default). The user can drag them anywhere from there. */
export const DEFAULT_LAYOUT: HudLayoutState = {
  clock: { x: 24, y: 16, w: 280, h: "auto", visible: true },
  "weather-current": { x: 320, y: 16, w: 320, h: "auto", visible: true },
  "weather-strip": { x: 24, y: 240, w: 720, h: "auto", visible: true },
  orb: { x: 220, y: 60, w: 360, h: 200, visible: true },
  spotify: { x: 24, y: 320, w: 480, h: "auto", visible: true },
  camera: { x: 660, y: 16, w: 240, h: 180, visible: true },
};

const ALL_IDS: HudWidgetId[] = [
  "clock",
  "weather-current",
  "weather-strip",
  "orb",
  "spotify",
  "camera",
];

export const WIDGET_LABELS: Record<HudWidgetId, string> = {
  clock: "Clock",
  "weather-current": "Weather",
  "weather-strip": "Forecast",
  orb: "Orb",
  spotify: "Spotify",
  camera: "Camera",
};

function cloneDefault(): HudLayoutState {
  // Structured clone so consumers can safely mutate their copy
  // without leaking changes back into ``DEFAULT_LAYOUT``.
  return JSON.parse(JSON.stringify(DEFAULT_LAYOUT)) as HudLayoutState;
}

function readLayout(): HudLayoutState {
  if (typeof window === "undefined") return cloneDefault();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneDefault();
    const parsed = JSON.parse(raw) as Partial<HudLayoutState>;
    // Merge with defaults so newly-added widgets get reasonable
    // starting positions for users with an old saved layout.
    const merged = cloneDefault();
    for (const id of ALL_IDS) {
      const saved = parsed[id];
      if (saved && typeof saved === "object") {
        merged[id] = { ...merged[id], ...saved };
      }
    }
    return merged;
  } catch {
    return cloneDefault();
  }
}

function writeLayout(layout: HudLayoutState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // localStorage can throw in private windows — silent fail is
    // fine, the layout will revert to default on next load.
  }
}

function readEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(ENABLED_KEY) === "1";
}

function writeEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ENABLED_KEY, enabled ? "1" : "0");
}

/* ------------------------------------------------------------------ */
/* External store so unrelated components (Composer, sidebar) can     */
/* update the layout without prop-drilling, and so resizes during a   */
/* drag don't have to round-trip through React reducer batching.     */
/* ------------------------------------------------------------------ */

let _layout: HudLayoutState = cloneDefault();
let _hydrated = false;
const _listeners = new Set<() => void>();

function emit() {
  for (const l of _listeners) l();
}

function ensureHydrated() {
  if (_hydrated || typeof window === "undefined") return;
  _layout = readLayout();
  _hydrated = true;
}

function subscribe(listener: () => void): () => void {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

function getSnapshot(): HudLayoutState {
  ensureHydrated();
  return _layout;
}

function getServerSnapshot(): HudLayoutState {
  return DEFAULT_LAYOUT;
}

export interface HudLayoutAPI {
  /** ``true`` means widgets render at their saved {x,y,w,h}
   *  positions; ``false`` means default flow layout. */
  customEnabled: boolean;
  setCustomEnabled: (enabled: boolean) => void;
  /** ``true`` shows the per-widget drag/resize/hide handles. Only
   *  meaningful when ``customEnabled`` is also ``true``. */
  editMode: boolean;
  setEditMode: (on: boolean) => void;
  layout: HudLayoutState;
  /** Patch a single widget's layout (e.g. during a drag). */
  updateWidget: (id: HudWidgetId, patch: Partial<WidgetLayout>) => void;
  /** Set ``visible: false`` for a widget. */
  hideWidget: (id: HudWidgetId) => void;
  /** Set ``visible: true`` for a widget (used by the show-all chip
   *  row in the customize toolbar). */
  showWidget: (id: HudWidgetId) => void;
  /** Reset all positions, sizes, and visibility back to the
   *  defaults defined in this module. */
  resetLayout: () => void;
}

export function useHudLayout(): HudLayoutAPI {
  const layout = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // ``customEnabled`` and ``editMode`` are component-local React
  // state because they're cheap and don't need cross-component
  // synchronisation. (Edit mode in particular is meant to be opened
  // from the header button only.)
  const [customEnabled, setCustomEnabledState] = useState(false);
  const [editMode, setEditMode] = useState(false);
  useEffect(() => {
    setCustomEnabledState(readEnabled());
  }, []);

  function setCustomEnabled(enabled: boolean) {
    setCustomEnabledState(enabled);
    writeEnabled(enabled);
    if (!enabled) setEditMode(false);
  }

  function updateWidget(id: HudWidgetId, patch: Partial<WidgetLayout>) {
    ensureHydrated();
    _layout = { ..._layout, [id]: { ..._layout[id], ...patch } };
    writeLayout(_layout);
    emit();
  }

  function hideWidget(id: HudWidgetId) {
    updateWidget(id, { visible: false });
  }

  function showWidget(id: HudWidgetId) {
    updateWidget(id, { visible: true });
  }

  function resetLayout() {
    _layout = cloneDefault();
    writeLayout(_layout);
    emit();
  }

  return {
    customEnabled,
    setCustomEnabled,
    editMode,
    setEditMode,
    layout,
    updateWidget,
    hideWidget,
    showWidget,
    resetLayout,
  };
}
