"use client";

/**
 * Valhalla routing client — talks to the ``alfred-core`` backend's
 * ``/api/routing/*`` proxy, which in turn calls Stadia Maps' hosted
 * Valhalla (or a self-hosted ``gisops/valhalla`` instance, if the
 * user has ``VALHALLA_BASE_URL`` set on the backend).
 *
 * Why the round-trip instead of calling Stadia directly from the
 * browser? Stadia enforces an origin whitelist on hosted keys, and
 * ``localhost`` can't be whitelisted as a root domain on a Stadia
 * property page. Routing through the backend bypasses that check
 * (server-to-server calls aren't origin-gated), keeps the API key
 * out of the JS bundle, and means accessing Alfred from another
 * device on the LAN / Tailscale ALSO "just works" without per-device
 * Stadia config.
 *
 * Configure on the BACKEND, not the frontend — set ``STADIA_API_KEY``
 * (or ``VALHALLA_BASE_URL`` for self-host) in your ``.env`` and
 * ``docker compose restart alfred-core``.
 */

import { API_BASE, FETCH_DEFAULTS } from "@/lib/api";

// ─── Types ────────────────────────────────────────────────────────

export type Costing =
  | "auto"
  | "bicycle"
  | "pedestrian"
  | "motorcycle"
  | "truck"
  | "multimodal";

export interface LatLon {
  lat: number;
  lon: number;
}

export interface RouteLeg {
  /** polyline6-encoded geometry */
  shape: string;
  summary: { length: number; time: number };
}

export interface RouteResponse {
  trip: {
    legs: RouteLeg[];
    summary: { length: number; time: number };
    status: number;
    status_message: string;
    units: string;
  };
}

export interface IsochroneResponse {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: "Polygon" | "MultiPolygon"; coordinates: unknown };
    properties: {
      contour: number;
      metric: "time" | "distance";
      color?: string;
      opacity?: number;
      fill?: string;
      [k: string]: unknown;
    };
  }>;
}

// ─── Status probe ─────────────────────────────────────────────────

interface RoutingStatus {
  configured: boolean;
  backend: "stadia" | "self_hosted" | null;
  base_url?: string;
  fix_hint?: string;
}

/**
 * Cheap one-call probe — chat handler uses this on failure to give
 * the user actionable hints (e.g. "you forgot STADIA_API_KEY").
 */
export async function routingStatus(): Promise<RoutingStatus> {
  const resp = await fetch(`${API_BASE}/api/routing/status`, FETCH_DEFAULTS);
  if (!resp.ok) {
    return { configured: false, backend: null, fix_hint: `HTTP ${resp.status}` };
  }
  return (await resp.json()) as RoutingStatus;
}

// ─── Polyline6 decoder ────────────────────────────────────────────

/**
 * Decode Valhalla's polyline6 string into ``[lon, lat]`` pairs ready
 * for Mapbox GL JS. Polyline6 = Google polyline with 1e6 precision.
 */
export function decodePolyline6(encoded: string): [number, number][] {
  let index = 0;
  let lat = 0;
  let lon = 0;
  const coords: [number, number][] = [];
  const len = encoded.length;
  while (index < len) {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;
    coords.push([lon / 1e6, lat / 1e6]);
  }
  return coords;
}

export function routeShapeToLineString(
  r: RouteResponse,
): [number, number][] {
  const coords: [number, number][] = [];
  for (const leg of r.trip?.legs ?? []) {
    if (!leg?.shape) continue;
    const decoded = decodePolyline6(leg.shape);
    if (coords.length > 0 && decoded.length > 0) {
      const prev = coords[coords.length - 1];
      const next = decoded[0];
      if (prev[0] === next[0] && prev[1] === next[1]) decoded.shift();
    }
    coords.push(...decoded);
  }
  return coords;
}

// ─── HTTP helper ──────────────────────────────────────────────────

async function call<T>(endpoint: string, payload: unknown): Promise<T> {
  const resp = await fetch(`${API_BASE}/api/routing/${endpoint}`, {
    ...FETCH_DEFAULTS,
    method: "POST",
    headers: {
      ...(FETCH_DEFAULTS.headers ?? {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const body = await resp.text();
      try {
        const parsed = JSON.parse(body) as { error?: string; detail?: string };
        if (parsed?.error) detail = parsed.error;
        else if (parsed?.detail) detail = parsed.detail;
      } catch {
        if (body) detail = body.slice(0, 240);
      }
    } catch {
      /* keep default */
    }
    throw new Error(detail);
  }
  return (await resp.json()) as T;
}

// ─── Endpoints ────────────────────────────────────────────────────

export async function valhallaRoute(opts: {
  locations: LatLon[];
  costing: Costing;
  units?: "kilometers" | "miles";
}): Promise<RouteResponse> {
  return call<RouteResponse>("route", {
    locations: opts.locations.map((p) => ({ ...p, type: "break" })),
    costing: opts.costing,
    directions_options: { units: opts.units ?? "miles" },
  });
}

export async function valhallaIsochrone(opts: {
  location: LatLon;
  costing: Costing;
  contoursMinutes: number[];
}): Promise<IsochroneResponse> {
  const palette = ["6cd6ff", "9eaaff", "ff6cb0"];
  return call<IsochroneResponse>("isochrone", {
    locations: [opts.location],
    costing: opts.costing,
    contours: opts.contoursMinutes.map((m, i) => ({
      time: m,
      color: palette[i % palette.length],
    })),
    polygons: true,
    denoise: 0.4,
    generalize: 50,
  });
}

export async function valhallaTraceRoute(opts: {
  shape: Array<LatLon & { time?: number }>;
  costing: Costing;
}): Promise<RouteResponse> {
  return call<RouteResponse>("trace_route", {
    shape: opts.shape,
    costing: opts.costing,
    shape_match: "map_snap",
  });
}

export async function valhallaMatrix(opts: {
  sources: LatLon[];
  targets: LatLon[];
  costing: Costing;
}): Promise<unknown> {
  return call("sources_to_targets", {
    sources: opts.sources,
    targets: opts.targets,
    costing: opts.costing,
  });
}

export async function valhallaOptimizedRoute(opts: {
  locations: LatLon[];
  costing: Costing;
}): Promise<RouteResponse> {
  return call<RouteResponse>("optimized_route", {
    locations: opts.locations.map((p) => ({ ...p, type: "break" })),
    costing: opts.costing,
    directions_options: { units: "miles" },
  });
}

export async function valhallaHeight(opts: {
  shape: LatLon[];
  samples?: number;
}): Promise<{ height: number[]; shape: LatLon[] }> {
  return call("height", {
    shape: opts.shape,
    range: false,
    sample_distance: opts.samples ? undefined : 25,
  });
}

// ─── Helpers for the chat handler ─────────────────────────────────

export function humanDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60));
  if (total >= 60) {
    const hrs = Math.floor(total / 60);
    const mins = total % 60;
    if (mins === 0) return `${hrs} hour${hrs === 1 ? "" : "s"}`;
    return `${hrs} hr ${mins} min`;
  }
  if (total === 0) return "less than a minute";
  return `${total} minute${total === 1 ? "" : "s"}`;
}

export function humanDistance(length: number, units = "miles"): string {
  const unit = units === "kilometers" ? "km" : "mi";
  if (length < 0.1) return `${Math.round(length * 5280)} ft`;
  return `${length.toFixed(length < 10 ? 1 : 0)} ${unit}`;
}

/**
 * Legacy alias kept so existing call sites don't break. The backend
 * does the real configured-or-not check now via ``routingStatus``;
 * the frontend just optimistically calls the proxy and lets it
 * return a 503 with the actionable hint on a misconfigured backend.
 */
export function isValhallaConfigured(): boolean {
  return true;
}
