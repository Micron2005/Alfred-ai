"use client";

import { useEffect, useState } from "react";
import { type WeatherForecast, fetchForecast } from "@/lib/weather";

// Module-level shared state. Every <WeatherWidget> instance
// subscribes to the same payload and the same polling interval, so we
// hit the backend exactly once per refresh cycle no matter how many
// widgets are on the page.
//
// This replaces an earlier per-instance ``useEffect``-with-fetch
// pattern that was making N HTTP requests (one per WeatherWidget
// variant). It also guarantees the "current" pane and the "strip"
// pane always render the same payload — they can never disagree
// because they read from the same cache.

const REFRESH_MS = 60_000;

interface ForecastCache {
  data: WeatherForecast | null;
  error: Error | null;
}

// Mutable singletons. We store the listeners in a Set so unmounted
// instances don't keep getting updates.
let _cache: ForecastCache = { data: null, error: null };
let _intervalId: ReturnType<typeof setInterval> | null = null;
let _inFlight: Promise<void> | null = null;
const _listeners: Set<(c: ForecastCache) => void> = new Set();

function notifyAll(): void {
  for (const listener of _listeners) listener(_cache);
}

async function refresh(): Promise<void> {
  // Deduplicate concurrent refresh attempts (e.g. multiple widgets
  // mount in the same tick) so we don't fire two requests for one
  // refresh cycle.
  if (_inFlight) return _inFlight;
  _inFlight = (async () => {
    try {
      const data = await fetchForecast();
      _cache = { data, error: null };
      notifyAll();
    } catch (exc) {
      const err = exc instanceof Error ? exc : new Error(String(exc));
      // Keep the last-good ``data`` so a transient blip doesn't blank
      // the widget. Error is only surfaced when there's no data.
      _cache = { data: _cache.data, error: err };
      notifyAll();
    } finally {
      _inFlight = null;
    }
  })();
  return _inFlight;
}

/**
 * Subscribe a component to the shared forecast cache. The first
 * subscriber kicks off the polling interval; the last unsubscribe
 * tears it down so we don't leak a timer when the widget is
 * unmounted.
 */
export function useForecast(): ForecastCache {
  const [state, setState] = useState<ForecastCache>(_cache);

  useEffect(() => {
    _listeners.add(setState);
    // Kick off polling on first subscriber; subsequent subscribers
    // attach to the existing interval and immediately receive the
    // current cache value via setState below.
    if (_listeners.size === 1) {
      void refresh();
      _intervalId = setInterval(() => void refresh(), REFRESH_MS);
    } else if (_cache.data || _cache.error) {
      // Already-running poll: hand the new subscriber the latest
      // value rather than make them wait for the next refresh.
      setState(_cache);
    }
    return () => {
      _listeners.delete(setState);
      if (_listeners.size === 0 && _intervalId !== null) {
        clearInterval(_intervalId);
        _intervalId = null;
      }
    };
  }, []);

  return state;
}
