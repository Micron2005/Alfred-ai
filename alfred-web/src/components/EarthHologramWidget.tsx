"use client";

/**
 * EarthHologramWidget — JARVIS-style HUD card containing the
 * holographic Earth globe.
 *
 * The globe is always visible inline. Clicking a point on the globe
 * (or pressing the EXPAND button) opens a full-screen Leaflet map
 * centered on that lat/lon — pan, pinch-zoom, search by place name.
 *
 * Heavy bundles (three.js for the globe, Leaflet for the map) are
 * lazy-loaded so users who never open the HUD pay nothing for them.
 */

import { Suspense, lazy, useEffect, useState } from "react";
import { createPortal } from "react-dom";

const HolographicEarth = lazy(() =>
  import("./HolographicEarth").then((m) => ({ default: m.HolographicEarth })),
);
const HoloMapView = lazy(() =>
  import("./HoloMapView").then((m) => ({ default: m.HoloMapView })),
);

export function EarthHologramWidget() {
  const [picked, setPicked] = useState<{ lat: number; lon: number } | null>(
    null,
  );
  const [mapOpen, setMapOpen] = useState(false);
  // Portal target — has to be the document body so the modal
  // escapes the HudWidget canvas's CSS ``transform`` (which would
  // otherwise create a new stacking context that traps even
  // ``position: fixed`` elements). Resolved on mount so SSR
  // doesn't choke on ``document``.
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (typeof document !== "undefined") {
      setPortalTarget(document.body);
    }
  }, []);

  function openMapAt(coords: { lat: number; lon: number }) {
    setPicked(coords);
    setMapOpen(true);
  }

  return (
    <div
      data-testid="earth-hologram-widget"
      style={{
        position: "relative",
        margin: "0 auto",
        maxWidth: 560,
        width: "100%",
        // Frame-less — the globe floats like Alfred's main orb,
        // no border or background panel.
        padding: 0,
      }}
    >
      {/* Floating header — purely text, no card. */}
      <div
        style={{
          padding: "0 4px 6px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: 2.5,
            color: "var(--hud)",
            textShadow: "0 0 6px var(--orb-glow)",
            opacity: 0.85,
          }}
        >
          EARTH · HOLOGRAM
        </span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {picked ? (
            <span
              className="mono"
              data-testid="earth-hologram-coords"
              style={{
                fontSize: 9,
                color: "var(--muted)",
              }}
            >
              {picked.lat.toFixed(2)}°, {picked.lon.toFixed(2)}°
            </span>
          ) : null}
          <button
            type="button"
            data-testid="earth-hologram-expand"
            className="hud-button"
            onClick={() => openMapAt(picked ?? { lat: 20, lon: 0 })}
            title="Open the detailed holographic flyover view"
            style={{ padding: "2px 8px", fontSize: 9 }}
          >
            ⤢ EXPAND
          </button>
        </div>
      </div>

      <Suspense
        fallback={
          <div
            style={{
              height: 360,
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
        <HolographicEarth onPick={openMapAt} height={360} />
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
