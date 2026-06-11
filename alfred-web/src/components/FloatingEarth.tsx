"use client";

/**
 * FloatingEarth — chrome-less holographic globe.
 *
 * Visual:
 *   - Just the globe canvas. No bordered frame, no header bar, no
 *     hint text strip — exactly the minimal "floating planet" look
 *     the user asked for (their reference: the Iron-Man-style
 *     orbital hologram).
 *   - A tiny drag handle (six dots) appears at the top-left only on
 *     hover, so the chrome stays out of the way until you want it.
 *   - The EXPAND button is in the top-right, also hover-only.
 *
 * Interaction:
 *   - Drag the small handle to move the whole thing.
 *   - The globe inside is fully interactive at all times — drag-to-
 *     rotate, scroll/pinch zoom, click-to-pick.
 *   - EXPAND opens the MapLibre 3D fly-over (portal-rendered).
 */

import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  useAllDeviceLocations,
  useDeviceLocation,
} from "@/lib/useDeviceLocation";
import { subscribeEarthBus } from "@/lib/earthBus";

const HolographicEarth = lazy(() =>
  import("./HolographicEarth").then((m) => ({ default: m.HolographicEarth })),
);
const HoloMapView = lazy(() =>
  import("./HoloMapView").then((m) => ({ default: m.HoloMapView })),
);

const STORAGE_KEY = "alfred.floatingEarth.v3";
const DEFAULT_POS = { x: 360, y: 320, w: 480, h: 480 };

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
    /* ignore */
  }
}

interface Props {
  scale?: number;
}

export function FloatingEarth({ scale = 1 }: Props) {
  const [pos, setPos] = useState<SavedPos>(DEFAULT_POS);
  const [hydrated, setHydrated] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [picked, setPicked] = useState<{ lat: number; lon: number } | null>(
    null,
  );
  const [mapOpen, setMapOpen] = useState(false);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  // Desktop self-share: send this computer's coarse location once
  // so the user sees their own home pin even if their phone hasn't
  // checked in yet. Coarse-only (we pass enableHighAccuracy: false
  // via kind "desktop") and the watcher updates only every ~25s, so
  // it's a quiet background ping not a battery drain.
  useDeviceLocation({ kind: "desktop", enabled: true });
  // Pull every device's most-recent fix from the backend so the
  // globe can drop a pin per device. Polled every 15s — that's
  // plenty for a hologram refresh rate.
  const { items: deviceLocations } = useAllDeviceLocations(15_000);
  const pins = deviceLocations.map((d) => ({
    lat: d.lat,
    lon: d.lon,
    label: d.label,
  }));

  useEffect(() => {
    setPos(readPos());
    setHydrated(true);
    if (typeof document !== "undefined") setPortalTarget(document.body);
  }, []);

  // Listen for voice-driven open/close events from the chat handler.
  // The bus carries already-resolved lat/lon (geocoded upstream) or
  // ``null`` to open with no destination set.
  useEffect(() => {
    return subscribeEarthBus((ev) => {
      if (ev.type === "close") {
        setMapOpen(false);
        return;
      }
      if (ev.type === "open") {
        if (ev.payload) {
          setPicked(ev.payload);
        }
        setMapOpen(true);
      }
    });
  }, []);

  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  function startDrag(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origX: pos.x,
      origY: pos.y,
    };
  }

  function moveDrag(e: React.PointerEvent<HTMLDivElement>) {
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

  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    dragRef.current = null;
  }

  function openMapAt(coords: { lat: number; lon: number }) {
    setPicked(coords);
    setMapOpen(true);
  }

  if (!hydrated) return null;

  return (
    <div
      data-testid="floating-earth"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "absolute",
        left: pos.x,
        top: pos.y,
        width: pos.w,
        height: pos.h,
        pointerEvents: "auto",
        zIndex: 8,
      }}
    >
      {/* Drag handle — six-dot icon, top-left, hover-only. Only this
          tiny zone moves the widget; everything else passes through
          to the globe so OrbitControls keeps working. */}
      <div
        data-testid="floating-earth-handle"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        title="Drag to move"
        style={{
          position: "absolute",
          top: 6,
          left: 6,
          width: 22,
          height: 22,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "grab",
          touchAction: "none",
          userSelect: "none",
          color: "var(--hud)",
          opacity: hovered ? 0.85 : 0,
          transition: "opacity 180ms ease",
          fontSize: 14,
          zIndex: 2,
          textShadow: "0 0 6px var(--orb-glow)",
        }}
      >
        ⠿
      </div>

      {/* EXPAND — top-right, hover-only. */}
      <button
        type="button"
        data-testid="floating-earth-expand"
        onClick={(e) => {
          e.stopPropagation();
          openMapAt(picked ?? { lat: 20, lon: 0 });
        }}
        title="Open the 3D fly-over"
        style={{
          position: "absolute",
          top: 6,
          right: 6,
          padding: "2px 8px",
          fontSize: 9,
          letterSpacing: 1.5,
          fontFamily: "var(--font-mono, monospace)",
          background: "rgba(8, 12, 22, 0.55)",
          border: "1px solid var(--border)",
          color: "var(--hud)",
          cursor: "pointer",
          opacity: hovered ? 0.9 : 0,
          transition: "opacity 180ms ease",
          zIndex: 2,
          textShadow: "0 0 6px var(--orb-glow)",
        }}
      >
        ⤢ EXPAND
      </button>

      {/* The globe fills the entire box — no border, no chrome. */}
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
        <HolographicEarth onPick={openMapAt} height="100%" pins={pins} />
      </Suspense>

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
