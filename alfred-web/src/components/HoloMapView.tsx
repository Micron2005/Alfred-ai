"use client";

/**
 * HoloMapView — full-screen Leaflet map shown when the user clicks
 * a point on the holographic Earth (or searches for a place).
 *
 * Why Leaflet + OSM?
 *   - No API key required.
 *   - Lightweight (~40 KB).
 *   - Native pan + pinch-zoom + double-tap zoom.
 *   - Works offline once tiles are cached by the browser.
 *
 * Lazy-loaded by the parent so the ~150 KB Leaflet bundle (+ CSS)
 * isn't paid by users who never open the globe.
 */

import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Leaflet's default marker images are referenced from the CSS as
// relative URLs, which Webpack/Next can't resolve out of the box —
// the result is broken-image icons. Point Leaflet at the CDN copies
// once at module load. Done at module scope so we only do it
// once per page lifetime.
if (typeof window !== "undefined") {
  // ``_getIconUrl`` is the internal hook used by L.Icon.Default;
  // deleting it forces Leaflet to fall back to the static URLs
  // we set immediately after.
  delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })
    ._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconRetinaUrl:
      "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/images/marker-icon-2x.png",
    iconUrl:
      "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/images/marker-icon.png",
    shadowUrl:
      "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/images/marker-shadow.png",
  });
}

interface Props {
  /** Center coords. ``null`` shows the world view. */
  center: { lat: number; lon: number } | null;
  /** Initial zoom — 0 (whole world) to 18 (street). Default 6. */
  initialZoom?: number;
  onClose: () => void;
}

interface Suggestion {
  display_name: string;
  lat: string;
  lon: string;
}

// Public Nominatim endpoint — free, no API key, but rate-limited
// (1 req/sec). Use sparingly; fine for a manual search box.
const NOMINATIM = "https://nominatim.openstreetmap.org/search";

export function HoloMapView({ center, onClose, initialZoom = 6 }: Props) {
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(
    center,
  );

  // Initialize the map exactly once. Subsequent center changes are
  // applied via map.flyTo, NOT by re-mounting.
  useEffect(() => {
    if (!mapDivRef.current || mapRef.current) return;
    const startCenter: L.LatLngExpression = center
      ? [center.lat, center.lon]
      : [20, 0];
    const map = L.map(mapDivRef.current, {
      center: startCenter,
      zoom: center ? initialZoom : 2,
      worldCopyJump: true,
      // Pinch-zoom + scroll-zoom + double-tap zoom are all on by
      // default.
      zoomControl: true,
      attributionControl: true,
    });

    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      {
        attribution:
          "Imagery &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community",
        maxZoom: 19,
      },
    ).addTo(map);

    // Place / road labels overlay — keeps the satellite imagery
    // looking like Google Earth fly-over but with searchable
    // landmark + city labels on top.
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      {
        attribution: "Labels &copy; Esri",
        maxZoom: 19,
        opacity: 0.85,
      },
    ).addTo(map);

    if (center) {
      markerRef.current = L.marker(startCenter as L.LatLngTuple).addTo(map);
    }

    map.on("click", (e) => {
      setCoords({ lat: e.latlng.lat, lon: e.latlng.lng });
      if (markerRef.current) {
        markerRef.current.setLatLng(e.latlng);
      } else {
        markerRef.current = L.marker(e.latlng).addTo(map);
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

  // When the parent passes a new ``center`` prop, fly to it instead
  // of re-mounting the map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !center) return;
    map.flyTo([center.lat, center.lon], initialZoom, { duration: 0.8 });
    if (markerRef.current) {
      markerRef.current.setLatLng([center.lat, center.lon]);
    } else {
      markerRef.current = L.marker([center.lat, center.lon]).addTo(map);
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
      map.flyTo([lat, lon], 12, { duration: 1.0 });
      if (markerRef.current) {
        markerRef.current.setLatLng([lat, lon]);
      } else {
        markerRef.current = L.marker([lat, lon]).addTo(map);
      }
    }
    setCoords({ lat, lon });
    setSuggestions([]);
    setQuery(s.display_name);
  }

  // Submit search on Enter — debounced live search would be nicer
  // but Nominatim's strict rate limit (1 req/sec public) makes
  // explicit Enter the safer default.
  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleSearch(query);
    }
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
      {/* Top toolbar — title, search, coords readout, close. */}
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
          HOLOMAP
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

        <div style={{ position: "relative", flex: 1, minWidth: 240, maxWidth: 480 }}>
          <input
            data-testid="holo-map-search"
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!e.target.value.trim()) setSuggestions([]);
            }}
            onKeyDown={handleKey}
            placeholder="Search a place — e.g. 'Tokyo' or 'Wayne Manor, Gotham'"
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
            style={{
              fontSize: 9,
              color: "var(--hud)",
              opacity: 0.7,
            }}
          >
            SEARCHING…
          </span>
        ) : null}

        <span style={{ flex: 1 }} />

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
          tints satellite imagery toward a JARVIS-cyan hologram —
          hue-rotate pushes greens/browns toward blue/cyan, contrast
          boost separates land from sea, slight brightness drop
          gives the dark holographic look. */}
      <div
        ref={mapDivRef}
        data-testid="holo-map-leaflet"
        style={{
          flex: 1,
          minHeight: 0,
          filter:
            "hue-rotate(165deg) saturate(1.6) brightness(0.78) contrast(1.18)",
          background: "#02060d",
        }}
      />
    </div>
  );
}
