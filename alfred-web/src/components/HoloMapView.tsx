"use client";

/**
 * HoloMapView — full-screen 3D fly-over view shown when the user
 * clicks a point on the holographic Earth (or searches for a place).
 *
 * Engine: **MapLibre GL** with a vector-tile source from
 * **OpenFreeMap** (free, no API key) plus a fill-extrusion layer
 * fed from OpenMapTiles' building heights — so buildings render as
 * actual 3D blocks rather than flat shapes. Camera is tilted to
 * 60° pitch so the city reads like Google-Earth fly-over instead
 * of a flat top-down map. Drag rotates / tilts; scroll or pinch
 * zooms in & out.
 *
 * The whole map is run through a CSS `hue-rotate` filter so the
 * imagery comes out cyan, matching Alfred's JARVIS hologram
 * aesthetic. (For photorealistic Google-Earth-grade tiles with
 * actual building textures, plug a Cesium ion token in — see the
 * P1 follow-up note in PRD.md.)
 *
 * Lazy-loaded by ``EarthHologramWidget`` so the ~700 KB MapLibre
 * bundle isn't paid by users who never open the globe.
 */

import { useEffect, useRef, useState } from "react";
import maplibregl, { type Map as MlMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

interface Props {
  /** Center coords. ``null`` shows a global view. */
  center: { lat: number; lon: number } | null;
  /** Initial zoom — 0 (whole world) to 22 (very close). Default 14
   *  so buildings extrude visibly on first paint. */
  initialZoom?: number;
  onClose: () => void;
}

interface Suggestion {
  display_name: string;
  lat: string;
  lon: string;
}

const NOMINATIM = "https://nominatim.openstreetmap.org/search";

// OpenFreeMap is a free, no-API-key vector-tile host. Their
// "dark" style ships a building layer with ``height`` /
// ``min_height`` properties — and the dark background pairs
// beautifully with the cyan hologram CSS filter so the city
// reads as a true Tony-Stark fly-over hologram. We override
// the default styling to extrude buildings into 3D blocks.
const OFM_STYLE = "https://tiles.openfreemap.org/styles/dark";

export function HoloMapView({ center, onClose, initialZoom = 14 }: Props) {
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(
    center,
  );

  // Mount the map exactly once. Subsequent center changes apply via
  // map.flyTo, NOT by re-mounting.
  useEffect(() => {
    if (!mapDivRef.current || mapRef.current) return;
    const startCenter: [number, number] = center
      ? [center.lon, center.lat]
      : [0, 20];

    const map = new maplibregl.Map({
      container: mapDivRef.current,
      style: OFM_STYLE,
      center: startCenter,
      zoom: center ? initialZoom : 2,
      // 3D fly-over feel — pitch tilts the camera, bearing rotates it.
      pitch: center ? 60 : 0,
      bearing: -20,
    });

    // ``canvasContextAttributes`` is the public way to ask for
    // antialiasing — passing ``antialias`` directly into the
    // constructor was removed in MapLibre v5.
    void map;

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }));
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

    map.on("load", () => {
      // Try to add a 3D building extrusion layer. The OFM/OMT
      // schema uses a source-layer named "building" with a
      // numeric "render_height" / "render_min_height". We push
      // it just before the topmost label layer so labels stay
      // legible above the buildings.
      try {
        const layers = map.getStyle().layers ?? [];
        let labelLayerId: string | undefined;
        for (const l of layers) {
          if (l.type === "symbol" && (l.layout as { "text-field"?: unknown })?.["text-field"]) {
            labelLayerId = l.id;
            break;
          }
        }
        if (!map.getLayer("alfred-3d-buildings")) {
          map.addLayer(
            {
              id: "alfred-3d-buildings",
              source: "openmaptiles",
              "source-layer": "building",
              type: "fill-extrusion",
              minzoom: 13,
              paint: {
                "fill-extrusion-color": "#6cd6ff",
                "fill-extrusion-height": [
                  "interpolate",
                  ["linear"],
                  ["zoom"],
                  13,
                  0,
                  15.05,
                  ["coalesce", ["get", "render_height"], ["get", "height"], 0],
                ],
                "fill-extrusion-base": [
                  "interpolate",
                  ["linear"],
                  ["zoom"],
                  13,
                  0,
                  15.05,
                  [
                    "coalesce",
                    ["get", "render_min_height"],
                    ["get", "min_height"],
                    0,
                  ],
                ],
                "fill-extrusion-opacity": 0.85,
              },
            },
            labelLayerId,
          );
        }
      } catch {
        // Source layer name may differ — tolerate; flat map still works.
      }
    });

    if (center) {
      markerRef.current = new maplibregl.Marker({ color: "#6cd6ff" })
        .setLngLat(startCenter)
        .addTo(map);
    }

    map.on("click", (e) => {
      setCoords({ lat: e.lngLat.lat, lon: e.lngLat.lng });
      const lngLat: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      if (markerRef.current) {
        markerRef.current.setLngLat(lngLat);
      } else {
        markerRef.current = new maplibregl.Marker({ color: "#6cd6ff" })
          .setLngLat(lngLat)
          .addTo(map);
      }
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // We *deliberately* only mount once — see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fly-to on subsequent center prop changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !center) return;
    map.flyTo({
      center: [center.lon, center.lat],
      zoom: initialZoom,
      pitch: 60,
      bearing: -20,
      duration: 1400,
      essential: true,
    });
    const lngLat: [number, number] = [center.lon, center.lat];
    if (markerRef.current) {
      markerRef.current.setLngLat(lngLat);
    } else {
      markerRef.current = new maplibregl.Marker({ color: "#6cd6ff" })
        .setLngLat(lngLat)
        .addTo(map);
    }
    setCoords(center);
  }, [center, initialZoom]);

  async function handleSearch(q: string) {
    if (!q.trim()) {
      setSuggestions([]);
      return;
    }
    setSearching(true);
    try {
      const url = `${NOMINATIM}?q=${encodeURIComponent(q)}&format=json&limit=5`;
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error("search failed");
      const data: Suggestion[] = await res.json();
      setSuggestions(data);
    } catch {
      setSuggestions([]);
    } finally {
      setSearching(false);
    }
  }

  function applySuggestion(s: Suggestion) {
    const lat = parseFloat(s.lat);
    const lon = parseFloat(s.lon);
    if (Number.isNaN(lat) || Number.isNaN(lon)) return;
    const map = mapRef.current;
    if (map) {
      map.flyTo({
        center: [lon, lat],
        zoom: 16,
        pitch: 60,
        bearing: -20,
        duration: 1800,
        essential: true,
      });
      const lngLat: [number, number] = [lon, lat];
      if (markerRef.current) {
        markerRef.current.setLngLat(lngLat);
      } else {
        markerRef.current = new maplibregl.Marker({ color: "#6cd6ff" })
          .setLngLat(lngLat)
          .addTo(map);
      }
    }
    setCoords({ lat, lon });
    setSuggestions([]);
    setQuery(s.display_name);
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleSearch(query);
    }
  }

  function handleResetView() {
    const map = mapRef.current;
    if (!map || !coords) return;
    map.flyTo({
      center: [coords.lon, coords.lat],
      zoom: 16,
      pitch: 60,
      bearing: -20,
      duration: 800,
      essential: true,
    });
  }

  return (
    <div
      data-testid="holo-map-view"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background: "rgba(4, 8, 16, 0.92)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 18px",
          borderBottom: "1px solid var(--border)",
          background:
            "linear-gradient(180deg, rgba(108,214,255,0.05), rgba(108,214,255,0.01))",
          flexWrap: "wrap",
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 12,
            letterSpacing: 4,
            color: "var(--hud)",
            textShadow: "0 0 8px var(--orb-glow)",
          }}
        >
          HOLOMAP · 3D
        </span>
        <span
          className="mono"
          style={{
            fontSize: 9,
            letterSpacing: 1.5,
            color: "var(--muted)",
          }}
        >
          {coords
            ? `${coords.lat.toFixed(4)}°, ${coords.lon.toFixed(4)}°`
            : "—"}
        </span>

        <div
          style={{
            position: "relative",
            flex: 1,
            minWidth: 240,
            maxWidth: 480,
          }}
        >
          <input
            data-testid="holo-map-search"
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!e.target.value.trim()) setSuggestions([]);
            }}
            onKeyDown={handleKey}
            placeholder="Fly to — e.g. 'Tokyo Tower' or '350 5th Ave, NYC'"
            style={{
              width: "100%",
              padding: "8px 12px",
              fontSize: 13,
              fontFamily: "inherit",
              background: "rgba(0,0,0,0.4)",
              color: "var(--fg)",
              border: "1px solid var(--border)",
              borderRadius: 3,
              outline: "none",
            }}
          />
          {suggestions.length > 0 ? (
            <ul
              data-testid="holo-map-suggestions"
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                right: 0,
                marginTop: 4,
                padding: 0,
                listStyle: "none",
                background: "rgba(8,12,22,0.95)",
                border: "1px solid var(--border)",
                borderRadius: 3,
                maxHeight: 240,
                overflowY: "auto",
                zIndex: 10,
              }}
            >
              {suggestions.map((s, i) => (
                <li
                  key={`${s.lat}-${s.lon}-${i}`}
                  onClick={() => applySuggestion(s)}
                  style={{
                    padding: "6px 10px",
                    fontSize: 12,
                    color: "var(--fg)",
                    cursor: "pointer",
                    borderBottom:
                      i < suggestions.length - 1
                        ? "1px solid var(--border)"
                        : "none",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLLIElement).style.background =
                      "rgba(108,214,255,0.08)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLLIElement).style.background =
                      "transparent";
                  }}
                >
                  {s.display_name}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {searching ? (
          <span
            className="mono"
            style={{ fontSize: 9, color: "var(--hud)", opacity: 0.7 }}
          >
            SEARCHING…
          </span>
        ) : null}

        <span style={{ flex: 1 }} />

        <button
          type="button"
          data-testid="holo-map-reset"
          className="hud-button"
          onClick={handleResetView}
          title="Recenter on the picked location with full 3D tilt"
          style={{ padding: "4px 10px", fontSize: 10 }}
        >
          ↻ RECENTRE
        </button>
        <button
          type="button"
          data-testid="holo-map-close"
          className="hud-button"
          onClick={onClose}
          title="Return to the holographic Earth"
        >
          × CLOSE
        </button>
      </div>

      {/* The map fills the rest of the viewport. The CSS filter
          tints the vector imagery + 3D buildings toward a JARVIS-cyan
          hologram. Hue-rotate centres the colour spectrum on cyan,
          saturate boosts colour density, contrast separates buildings
          from the ground plane. */}
      <div
        ref={mapDivRef}
        data-testid="holo-map-leaflet"
        style={{
          flex: 1,
          minHeight: 0,
          filter:
            "hue-rotate(170deg) saturate(1.3) brightness(0.85) contrast(1.15)",
          background: "#02060d",
        }}
      />

      <div
        style={{
          position: "absolute",
          left: 22,
          bottom: 30,
          padding: "6px 10px",
          background: "rgba(8,12,22,0.78)",
          border: "1px solid var(--border)",
          backdropFilter: "blur(10px)",
          fontSize: 9,
          letterSpacing: 1.4,
          color: "var(--hud)",
          opacity: 0.8,
          pointerEvents: "none",
        }}
        className="mono"
      >
        DRAG · PAN   RIGHT-DRAG · ROTATE / TILT   PINCH · ZOOM
      </div>
    </div>
  );
}
