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

import { Suspense, lazy, useState } from "react";

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
        maxWidth: 520,
        width: "100%",
        padding: 0,
        border: "1px solid var(--border)",
        background:
          "linear-gradient(180deg, rgba(108,214,255,0.04), rgba(108,214,255,0.01))",
      }}
    >
      <div
        style={{
          padding: "8px 14px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: 2.5,
            color: "var(--hud)",
            textShadow: "0 0 6px var(--orb-glow)",
          }}
        >
          EARTH · HOLOGRAM
        </span>
        <div style={{ display: "flex", gap: 6 }}>
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
            onClick={() =>
              openMapAt(picked ?? { lat: 20, lon: 0 })
            }
            title="Open the detailed map view"
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
              height: 320,
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
        <HolographicEarth onPick={openMapAt} height={320} />
      </Suspense>

      {mapOpen ? (
        <Suspense fallback={null}>
          <HoloMapView
            center={picked}
            onClose={() => setMapOpen(false)}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
