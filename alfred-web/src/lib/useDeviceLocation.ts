"use client";

/**
 * Device location helpers.
 *
 * - ``useDeviceLocation`` watches the browser's GPS via the
 *   Geolocation API and POSTs each fix to ``/api/location/me``.
 *   Auto-pauses when the page is hidden so we don't drain the
 *   phone battery while the screen's off.
 *
 * - ``useAllDeviceLocations`` polls ``/api/location/all`` so the
 *   FloatingEarth can drop a pin per device.
 */

import { useEffect, useRef, useState } from "react";
import { API_BASE } from "@/lib/api";

const DEVICE_ID_KEY = "alfred.device.id";
const DEVICE_LABEL_KEY = "alfred.device.label";

export interface DeviceLocation {
  device_id: string;
  lat: number;
  lon: number;
  accuracy_m: number | null;
  label: string | null;
  ts: number;
}

/** Pick or generate a stable device ID for this browser. */
function ensureDeviceId(prefix: "phone" | "desktop"): string {
  if (typeof window === "undefined") return `${prefix}-ssr`;
  let id = window.localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
    window.localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

/** Get the user-friendly device label, defaulting per platform. */
function ensureLabel(prefix: "phone" | "desktop"): string {
  if (typeof window === "undefined") return prefix;
  const stored = window.localStorage.getItem(DEVICE_LABEL_KEY);
  if (stored) return stored;
  return prefix === "phone" ? "iPhone" : "Computer";
}

export function setDeviceLabel(label: string) {
  window.localStorage.setItem(DEVICE_LABEL_KEY, label);
}

interface UseDeviceLocationOpts {
  /** ``"phone"`` or ``"desktop"``; controls the device-id prefix. */
  kind: "phone" | "desktop";
  /** Whether to actually request GPS. Caller controls this so the
   *  user can opt in/out from the UI. */
  enabled: boolean;
}

interface DeviceLocationState {
  ready: boolean;
  permission: "unknown" | "granted" | "denied" | "prompt";
  lastFix: DeviceLocation | null;
  error: string | null;
}

export function useDeviceLocation({
  kind,
  enabled,
}: UseDeviceLocationOpts): DeviceLocationState {
  const [state, setState] = useState<DeviceLocationState>({
    ready: false,
    permission: "unknown",
    lastFix: null,
    error: null,
  });
  const lastPostRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setState((s) => ({ ...s, ready: false }));
      return;
    }
    if (typeof window === "undefined") return;
    if (!("geolocation" in navigator)) {
      setState((s) => ({
        ...s,
        ready: true,
        error: "Geolocation isn't supported in this browser.",
      }));
      return;
    }
    const deviceId = ensureDeviceId(kind);
    const label = ensureLabel(kind);

    const post = async (
      lat: number,
      lon: number,
      accuracy: number | null,
    ) => {
      // Throttle to one POST per 25 s — the Geolocation watcher
      // can fire multiple updates per second on a moving device,
      // and we don't need that resolution for an Earth pin.
      const now = Date.now();
      if (now - lastPostRef.current < 25_000) return;
      lastPostRef.current = now;
      try {
        const resp = await fetch(`${API_BASE}/api/location/me`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            device_id: deviceId,
            lat,
            lon,
            accuracy_m: accuracy,
            label,
          }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const fix = (await resp.json()) as DeviceLocation;
        setState((s) => ({ ...s, lastFix: fix, error: null, ready: true }));
      } catch (exc) {
        const message = exc instanceof Error ? exc.message : String(exc);
        setState((s) => ({ ...s, error: message }));
      }
    };

    // Single fix first (gives a near-instant pin) — then a watcher
    // for follow-up updates while the user moves around.
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setState((s) => ({ ...s, permission: "granted" }));
        void post(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
      },
      (err) => {
        setState((s) => ({
          ...s,
          ready: true,
          permission: err.code === 1 ? "denied" : "prompt",
          error:
            err.code === 1
              ? "Location permission denied."
              : err.message,
        }));
      },
      { enableHighAccuracy: kind === "phone", timeout: 15_000, maximumAge: 60_000 },
    );

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        // Forced post on every watcher fire — but throttled inside post().
        void post(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
      },
      (err) => {
        setState((s) => ({ ...s, error: err.message }));
      },
      { enableHighAccuracy: kind === "phone", timeout: 30_000, maximumAge: 30_000 },
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  }, [kind, enabled]);

  return state;
}

export function useAllDeviceLocations(pollMs = 15_000): {
  items: DeviceLocation[];
  error: string | null;
} {
  const [items, setItems] = useState<DeviceLocation[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const resp = await fetch(`${API_BASE}/api/location/all`, {
          credentials: "include",
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const body = (await resp.json()) as { items: DeviceLocation[] };
        if (cancelled) return;
        setItems(body.items);
        setError(null);
      } catch (exc) {
        if (cancelled) return;
        const message = exc instanceof Error ? exc.message : String(exc);
        setError(message);
      }
    };
    void fetchOnce();
    const id = window.setInterval(fetchOnce, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pollMs]);

  return { items, error };
}
