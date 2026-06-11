"use client";

/**
 * routeBus — tiny event bus the chat handler uses to push a fresh
 * Valhalla route or isochrone collection onto whichever map view is
 * currently mounted (HoloMapView when the user has opened the
 * earth's full-screen 3D view).
 *
 * Mirrors the shape + intent of ``earthBus.ts``. Single-channel,
 * fire-and-forget, no replay — listeners only see events that fire
 * AFTER they subscribe. The chat handler always fires ``openEarth``
 * first (so HoloMapView mounts), then ``setRoute`` once the
 * geometry lands; the mount-effect inside HoloMapView calls
 * ``subscribeRouteBus`` synchronously so the second event isn't
 * missed.
 */

import type { FeatureCollection, LineString, Polygon, MultiPolygon } from "geojson";

export type RouteFeature = {
  type: "Feature";
  geometry: LineString;
  properties: {
    /** Spoken-friendly summary, e.g. "23 min · 12.4 mi". */
    label?: string;
    [k: string]: unknown;
  };
};

export type IsochroneCollection = FeatureCollection<Polygon | MultiPolygon>;

export type RouteBusEvent =
  | { type: "route"; route: RouteFeature | null }
  | { type: "isochrone"; collection: IsochroneCollection | null }
  | { type: "clear" };

const listeners = new Set<(ev: RouteBusEvent) => void>();

export function subscribeRouteBus(fn: (ev: RouteBusEvent) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(ev: RouteBusEvent) {
  listeners.forEach((fn) => {
    try {
      fn(ev);
    } catch {
      /* a buggy listener mustn't kill the others */
    }
  });
}

export function setRoute(route: RouteFeature | null) {
  emit({ type: "route", route });
}

export function setIsochrone(collection: IsochroneCollection | null) {
  emit({ type: "isochrone", collection });
}

export function clearRoute() {
  emit({ type: "clear" });
}
