"use client";

/**
 * FloatingEarth — the holographic globe as a stand-alone, always-
 * draggable HUD element.
 *
 * Why not a ``HudWidget``? The user explicitly wants the Earth to
 * be its own thing — moveable + zoomable regardless of whether
 * customize mode is on. A HudWidget is read-only outside customize.
 *
 * Behaviour:
 *   - Position is persisted to ``localStorage`` so the globe stays
 *     wherever you last dragged it.
 *   - Drag the small handle bar at the top to move the whole thing.
 *   - The globe inside is fully interactive (drag-rotate, scroll/
 *     pinch zoom, click-to-pick) at all times — the *handle* is the
 *     only drag-to-move surface so the globe's own rotation gesture
 *     isn't fighting with the move gesture.
 *   - EXPAND opens the same MapLibre 3D fly-over as before
 *     (``HoloMapView``), rendered through a portal to escape any
 *     transformed ancestors.
 */

import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const HolographicEarth = lazy(() =>
  import("./HolographicEarth").then((m) => ({ default: m.HolographicEarth })),
);
const HoloMapView = lazy(() =>
  import("./HoloMapView").then((m) => ({ default: m.HoloMapView })),
);

const STORAGE_KEY = "alfred.floatingEarth.v2";
// Defaults — landed roughly under-and-right of the orb so first-paint
// looks intentional. The user can drag from there.
const DEFAULT_POS = { x: 360, y: 460, w: 480, h: 360 };

interface SavedPos {
  x: number;
  y: number;
  w: number;
  h: number;
}

function readPos(): SavedPos {
  if (typeof window === "undefined") return DEFAULT_POS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_POS;
    const parsed = JSON.parse(raw) as Partial<SavedPos>;
    return {
      x: typeof parsed.x === "number" ? parsed.x : DEFAULT_POS.x,
      y: typeof parsed.y === "number" ? parsed.y : DEFAULT_POS.y,
      w: typeof parsed.w === "number" ? parsed.w : DEFAULT_POS.w,
      h: typeof parsed.h === "number" ? parsed.h : DEFAULT_POS.h,
    };
  } catch {
    return DEFAULT_POS;
  }
}

function writePos(pos: SavedPos) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pos));
  } catch {
    /* localStorage full / disabled — ignore */
  }
}

interface Props {
  /** Visual size scale applied by the parent canvas (so drag deltas
   *  match the on-screen pixel motion). */
  scale?: number;
}

export function FloatingEarth({ scale = 1 }: Props) {
  const [pos, setPos] = useState<SavedPos>(DEFAULT_POS);
  const [hydrated, setHydrated] = useState(false);
  const [picked, setPicked] = useState<{ lat: number; lon: number } | null>(
    null,
  );
  const [mapOpen, setMapOpen] = useState(false);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  // Hydrate from localStorage on mount (avoids SSR / hydration
  // mismatch). After this, every state mutation also writes back.
  useEffect(() => {
    setPos(readPos());
    setHydrated(true);
    if (typeof document !== "undefined") setPortalTarget(document.body);
  }, []);

  // Drag-to-move state. We track ``dragRef`` instead of going through
  // React state so high-frequency pointer-move events don't trigger
  // a re-render per frame.
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origX: pos.x,
      origY: pos.y,
    };
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = (e.clientX - drag.startX) / scale;
    const dy = (e.clientY - drag.startY) / scale;
    setPos((prev) => {
      const next = { ...prev, x: drag.origX + dx, y: drag.origY + dy };
      writePos(next);
      return next;
    });
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    dragRef.current = null;
  }

  function openMapAt(coords: { lat: number; lon: number }) {
    setPicked(coords);
    setMapOpen(true);
  }

  // Don't render until hydrated — otherwise we'd flash the default
  // position before the saved one applies.
  if (!hydrated) return null;

  return (
    <div
      data-testid="floating-earth"
      style={{
        position: "absolute",
        left: pos.x,
        top: pos.y,
        width: pos.w,
        height: pos.h + 24, // +24 for the drag handle bar
        pointerEvents: "auto",
        zIndex: 8,
      }}
    >
      {/* Drag handle — the only surface that initiates a move,
          so dragging *inside* the globe still rotates the globe. */}
      <div
        data-testid="floating-earth-handle"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          height: 24,
          padding: "0 10px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          cursor: "grab",
          touchAction: "none",
          background:
            "linear-gradient(180deg, rgba(108,214,255,0.10), rgba(108,214,255,0.02))",
          border: "1px solid var(--border)",
          borderBottom: "none",
          userSelect: "none",
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 9,
            letterSpacing: 2.5,
            color: "var(--hud)",
            textShadow: "0 0 6px var(--orb-glow)",
            opacity: 0.85,
          }}
        >
          ⠿ EARTH · HOLOGRAM
        </span>
        <div
          style={{ display: "flex", gap: 6, alignItems: "center" }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {picked ? (
            <span
              className="mono"
              data-testid="floating-earth-coords"
              style={{ fontSize: 9, color: "var(--muted)" }}
            >
              {picked.lat.toFixed(2)}°, {picked.lon.toFixed(2)}°
            </span>
          ) : null}
          <button
            type="button"
            data-testid="floating-earth-expand"
            className="hud-button"
            onClick={() => openMapAt(picked ?? { lat: 20, lon: 0 })}
            title="Open the 3D fly-over"
            style={{ padding: "1px 8px", fontSize: 9 }}
          >
            ⤢ EXPAND
          </button>
        </div>
      </div>

      {/* The globe itself fills the rest of the box. */}
      <div
        style={{
          width: "100%",
          height: pos.h,
          // Subtle border so users can find the edge to drag from
          // when the globe rotates near the silhouette.
          border: "1px solid var(--border)",
          background: "transparent",
        }}
      >
        <Suspense
          fallback={
            <div
              style={{
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--muted)",
                fontSize: 11,
              }}
              className="mono"
            >
              INITIALISING ORBITAL VIEW…
            </div>
          }
        >
          <HolographicEarth onPick={openMapAt} height="100%" />
        </Suspense>
      </div>

      {/* Modal portal — body-rooted so it escapes the canvas's
          ``transform`` stacking context (which would otherwise trap
          ``position: fixed`` elements inside its bounds). */}
      {mapOpen && portalTarget
        ? createPortal(
            <Suspense fallback={null}>
              <HoloMapView
                center={picked}
                onClose={() => setMapOpen(false)}
              />
            </Suspense>,
            portalTarget,
          )
        : null}
    </div>
  );
}
