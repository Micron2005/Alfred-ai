"use client";

/**
 * HoloMapView — full-screen 3D fly-over view shown when the user
 * clicks a point on the holographic Earth (or searches for a place).
 *
 * Engine: **Mapbox GL JS** with the **Mapbox Standard 3D** style.
 * Standard ships built-in 3D buildings, photoreal terrain, and
 * dynamic atmospheric lighting — no need for our own
 * fill-extrusion layer. Camera is tilted to 60° pitch on a placed
 * pin so the city reads like an Iron-Man holographic fly-over
 * rather than a flat top-down map. Drag rotates / tilts; scroll
 * or pinch zooms in & out.
 *
 * The whole map is run through a light CSS hue/saturation tweak so
 * imagery comes out cyan-tinged, matching Alfred's JARVIS hologram
 * aesthetic — but we keep brightness near 1.0 because Mapbox
 * Standard is already richly lit.
 *
 * Requires ``NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN`` in ``.env``. Without
 * a token Mapbox tile requests 401 and the user sees a clear
 * "configure Mapbox" hint instead of an indefinite black canvas.
 *
 * Lazy-loaded by ``EarthHologramWidget`` so the ~700 KB Mapbox
 * bundle isn't paid by users who never open the globe.
 */

import { useEffect, useRef, useState } from "react";
import mapboxgl, { type Map as MbMap } from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import {
  subscribeRouteBus,
  type IsochroneCollection,
  type RouteFeature,
} from "@/lib/routeBus";

interface Props {
  /** Center coords. ``null`` shows a global view. */
  center: { lat: number; lon: number } | null;
  /** Initial zoom — 0 (whole world) to 22 (very close). Default 16
   *  so individual buildings are clearly visible on first paint. */
  initialZoom?: number;
  onClose: () => void;
}

interface Suggestion {
  display_name: string;
  lat: string;
  lon: string;
}

const NOMINATIM = "https://nominatim.openstreetmap.org/search";

// Mapbox Standard 3D — photoreal buildings, terrain, atmospheric
// lighting. Way better looking than the previous OpenFreeMap raster
// stack for the JARVIS hologram aesthetic.
const MB_STYLE = "mapbox://styles/mapbox/standard";

// Public token from .env. Compiled into the client bundle by Next.js
// because the prefix is ``NEXT_PUBLIC_``. The token is scope-locked
// to the public read-only "styles:tiles" scopes by Mapbox; safe to
// ship to the browser.
const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN ?? "";

export function HoloMapView({ center, onClose, initialZoom = 16 }: Props) {
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MbMap | null>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(
    center,
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Active route summary — surfaced as a HUD chip top-right so the
  // user has a visual readout of the spoken ack.
  const [routeLabel, setRouteLabel] = useState<string | null>(null);

  // Mount the map exactly once. Subsequent center changes apply via
  // map.flyTo, NOT by re-mounting.
  useEffect(() => {
    if (!mapDivRef.current || mapRef.current) return;
    if (!MAPBOX_TOKEN) {
      setLoadError(
        "Mapbox token missing. Add NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN=… to your .env then rebuild.",
      );
      setLoading(false);
      return;
    }
    mapboxgl.accessToken = MAPBOX_TOKEN;

    const startCenter: [number, number] = center
      ? [center.lon, center.lat]
      : [0, 20];

    const map = new mapboxgl.Map({
      container: mapDivRef.current,
      style: MB_STYLE,
      center: startCenter,
      zoom: center ? initialZoom : 2,
      // 3D fly-over feel — pitch tilts the camera, bearing rotates it.
      pitch: center ? 60 : 0,
      bearing: -20,
      // Mapbox Standard supports config presets; "dusk" gives the
      // most JARVIS-friendly lighting (long shadows, blue-purple
      // sky, lit windows on tall buildings).
      antialias: true,
    });

    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }));
    map.addControl(
      new mapboxgl.ScaleControl({ unit: "metric" }),
      "bottom-left",
    );

    // The container can momentarily mount at 0×0 inside a flexbox
    // overlay before the browser has computed its final size; map
    // would render a single black tile. Force a resize on the next
    // animation frame and again 200 ms later to handle slow layout.
    requestAnimationFrame(() => map.resize());
    const resizeTimer = setTimeout(() => map.resize(), 200);

    map.on("idle", () => {
      setLoading(false);
    });
    map.on("error", (e) => {
      setLoadError(
        e.error?.message ??
          "Could not load 3D map tiles. Check your internet connection or your Mapbox token.",
      );
      // eslint-disable-next-line no-console
      console.warn("[holomap] map error", e);
    });

    map.on("style.load", () => {
      // Mapbox Standard exposes a "config" API on the style — we
      // can swap the lighting preset between "dawn" / "day" /
      // "dusk" / "night". "dusk" gives long shadows and lit
      // windows, the most cinematic JARVIS look.
      try {
        // ``setConfigProperty`` ships in mapbox-gl-js v3+.
        (map as unknown as {
          setConfigProperty: (
            scope: string,
            name: string,
            value: unknown,
          ) => void;
        }).setConfigProperty?.("basemap", "lightPreset", "dusk");
        (map as unknown as {
          setConfigProperty: (
            scope: string,
            name: string,
            value: unknown,
          ) => void;
        }).setConfigProperty?.("basemap", "show3dObjects", true);
      } catch {
        // Older mapbox-gl-js or non-standard style — fall through;
        // 3D buildings still render with the default config.
      }

      // ─── Valhalla layers ─────────────────────────────────────
      // Empty sources for the route line + isochrone fills, plus
      // the layers that consume them. We seed them on style.load
      // so the routeBus listener below can call setData() at any
      // time without worrying about whether the style finished
      // loading.
      if (!map.getSource("alfred-route")) {
        map.addSource("alfred-route", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      }
      if (!map.getLayer("alfred-route-glow")) {
        map.addLayer({
          id: "alfred-route-glow",
          type: "line",
          source: "alfred-route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": "#6cd6ff",
            "line-width": 14,
            "line-opacity": 0.25,
            "line-blur": 8,
          },
        });
      }
      if (!map.getLayer("alfred-route-line")) {
        map.addLayer({
          id: "alfred-route-line",
          type: "line",
          source: "alfred-route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": "#6cd6ff",
            "line-width": 4,
            "line-opacity": 0.95,
          },
        });
      }
      if (!map.getSource("alfred-isochrone")) {
        map.addSource("alfred-isochrone", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      }
      if (!map.getLayer("alfred-isochrone-fill")) {
        map.addLayer({
          id: "alfred-isochrone-fill",
          type: "fill",
          source: "alfred-isochrone",
          // ``contour`` is the minute value Valhalla stamps onto each
          // polygon — smaller contour = closer to origin = brighter.
          paint: {
            "fill-color": [
              "interpolate",
              ["linear"],
              ["coalesce", ["get", "contour"], 0],
              0,
              "#6cd6ff",
              30,
              "#9eaaff",
              60,
              "#ff6cb0",
            ],
            "fill-opacity": 0.18,
          },
        });
      }
      if (!map.getLayer("alfred-isochrone-outline")) {
        map.addLayer({
          id: "alfred-isochrone-outline",
          type: "line",
          source: "alfred-isochrone",
          paint: {
            "line-color": "#6cd6ff",
            "line-width": 1.5,
            "line-opacity": 0.7,
          },
        });
      }
    });

    if (center) {
      markerRef.current = new mapboxgl.Marker({ color: "#6cd6ff" })
        .setLngLat(startCenter)
        .addTo(map);
    }

    map.on("click", (e) => {
      setCoords({ lat: e.lngLat.lat, lon: e.lngLat.lng });
      const lngLat: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      if (markerRef.current) {
        markerRef.current.setLngLat(lngLat);
      } else {
        markerRef.current = new mapboxgl.Marker({ color: "#6cd6ff" })
          .setLngLat(lngLat)
          .addTo(map);
      }
    });

    mapRef.current = map;
    return () => {
      clearTimeout(resizeTimer);
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
      markerRef.current = new mapboxgl.Marker({ color: "#6cd6ff" })
        .setLngLat(lngLat)
        .addTo(map);
    }
    setCoords(center);
  }, [center, initialZoom]);

  // ─── Valhalla route / isochrone bus subscription ─────────────────
  // The chat handler fires ``setRoute()`` / ``setIsochrone()`` once
  // Valhalla returns its response; we update the map source data
  // here and fit the camera to the new geometry's bounds.
  useEffect(() => {
    return subscribeRouteBus((ev) => {
      const map = mapRef.current;
      if (!map) return;
      const applyRoute = (route: RouteFeature | null) => {
        const src = map.getSource("alfred-route") as
          | mapboxgl.GeoJSONSource
          | undefined;
        if (!src) return;
        if (!route) {
          src.setData({ type: "FeatureCollection", features: [] });
          setRouteLabel(null);
          return;
        }
        src.setData({ type: "FeatureCollection", features: [route] });
        setRouteLabel(route.properties?.label ?? null);
        // Fit the camera to the route bounds with comfortable padding.
        const coords = route.geometry.coordinates;
        if (coords.length >= 2) {
          let minX = coords[0][0];
          let minY = coords[0][1];
          let maxX = coords[0][0];
          let maxY = coords[0][1];
          for (const [x, y] of coords) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
          try {
            map.fitBounds(
              [
                [minX, minY],
                [maxX, maxY],
              ],
              { padding: 100, pitch: 55, duration: 1400 },
            );
          } catch {
            /* fitBounds throws on degenerate bounds — ignore */
          }
        }
      };
      const applyIsochrone = (collection: IsochroneCollection | null) => {
        const src = map.getSource("alfred-isochrone") as
          | mapboxgl.GeoJSONSource
          | undefined;
        if (!src) return;
        src.setData(
          collection ?? { type: "FeatureCollection", features: [] },
        );
      };
      if (ev.type === "route") applyRoute(ev.route);
      else if (ev.type === "isochrone") applyIsochrone(ev.collection);
      else if (ev.type === "clear") {
        applyRoute(null);
        applyIsochrone(null);
      }
    });
  }, []);

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
        markerRef.current = new mapboxgl.Marker({ color: "#6cd6ff" })
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

        {routeLabel ? (
          <span
            data-testid="holo-map-route-label"
            className="mono"
            style={{
              fontSize: 10,
              letterSpacing: 2,
              padding: "4px 10px",
              border: "1px solid #6cd6ff",
              background: "rgba(108,214,255,0.08)",
              color: "#6cd6ff",
              textShadow: "0 0 6px rgba(108,214,255,0.6)",
              borderRadius: 3,
            }}
          >
            ROUTE · {routeLabel.toUpperCase()}
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

      {/* Mapbox Standard 3D already paints rich, photorealistic
          city imagery with dynamic lighting (we set "dusk" preset
          on style.load above). A heavy hue-rotate filter would hide
          the photoreal look. Just a subtle cyan tint via slight
          hue-shift + saturation; brightness stays at 1.0. */}
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        <div
          ref={mapDivRef}
          data-testid="holo-map-leaflet"
          style={{
            position: "absolute",
            inset: 0,
            filter: "hue-rotate(-20deg) saturate(1.15)",
            background: "#02060d",
          }}
        />

        {/* Loading overlay — shown until the first ``idle`` event.
            Pulse animation reuses the global ``hud-pulse`` keyframes
            from globals.css (already used by the orb). */}
        {loading && !loadError ? (
          <div
            data-testid="holo-map-loading"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 14,
              pointerEvents: "none",
              background: "rgba(2, 6, 13, 0.4)",
            }}
          >
            <span
              className="mono"
              style={{
                fontSize: 12,
                letterSpacing: 4,
                color: "var(--hud)",
                textShadow: "0 0 10px var(--orb-glow)",
                animation: "hud-pulse 1.6s ease-in-out infinite",
              }}
            >
              INITIALISING 3D MAP …
            </span>
            <span
              className="mono"
              style={{
                fontSize: 9,
                letterSpacing: 1.5,
                color: "var(--muted)",
                opacity: 0.7,
              }}
            >
              FETCHING TERRAIN · STREETS · BUILDINGS
            </span>
          </div>
        ) : null}

        {loadError ? (
          <div
            data-testid="holo-map-error"
            style={{
              position: "absolute",
              top: 12,
              left: "50%",
              transform: "translateX(-50%)",
              padding: "8px 14px",
              border: "1px solid var(--accent)",
              background: "rgba(40, 8, 8, 0.85)",
              color: "var(--accent)",
              fontSize: 12,
              letterSpacing: 0.5,
              maxWidth: 480,
              textAlign: "center",
            }}
            className="mono"
          >
            {loadError}
          </div>
        ) : null}

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
    </div>
  );
}
