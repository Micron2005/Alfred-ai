/**
 * earthBus — tiny event bus the chat handler uses to ask the
 * FloatingEarth widget to open/close its full-screen Mapbox view.
 *
 * Why a bus and not props/refs? FloatingEarth owns its own
 * ``mapOpen`` state and the lat/lon picked by the user. The chat
 * handler in ChatWindow only needs to fire imperatives ("open the
 * earth at Tokyo", "close the earth") — passing a control prop
 * down + lifting state up would couple ChatWindow to FloatingEarth
 * unnecessarily. The bus stays opaque; either side can be moved
 * later without churn.
 *
 * Geocoding uses the same Nominatim endpoint as HoloMapView's
 * search box. Free, no key. Rate-limited; we throttle to one
 * lookup per 1500 ms which is well under their courtesy ceiling.
 */

type Listener =
  | { type: "open"; payload: { lat: number; lon: number } | null }
  | { type: "close" };

const listeners = new Set<(ev: Listener) => void>();
let lastGeocodeAt = 0;

export function subscribeEarthBus(fn: (ev: Listener) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(ev: Listener) {
  listeners.forEach((fn) => {
    try {
      fn(ev);
    } catch {
      /* listener error must not stop other listeners */
    }
  });
}

/**
 * Open the earth view. Pass ``null`` to open at the current
 * location; pass coords to fly there immediately.
 */
export function openEarth(payload: { lat: number; lon: number } | null) {
  emit({ type: "open", payload });
}

export function closeEarth() {
  emit({ type: "close" });
}

/**
 * Geocode a place name → (lat, lon) via Nominatim. Returns ``null``
 * if no match. Throws if Nominatim is unreachable. The throttle
 * exists so chained voice commands ("show me Tokyo… now Paris…
 * now London") don't spam Nominatim past their courtesy rate.
 */
export async function geocodePlace(
  query: string,
): Promise<{ lat: number; lon: number; display_name: string } | null> {
  const cleaned = query.trim();
  if (!cleaned) return null;
  const now = Date.now();
  const since = now - lastGeocodeAt;
  if (since < 1500) {
    await new Promise((r) => window.setTimeout(r, 1500 - since));
  }
  lastGeocodeAt = Date.now();
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(
    cleaned,
  )}`;
  // Nominatim's usage policy asks for a ``User-Agent`` identifying
  // the app. Browsers won't let us set it, so we send the more
  // courteous ``Accept-Language`` header instead — they accept
  // either as a sign of a legitimate caller.
  const resp = await fetch(url, {
    headers: { "Accept-Language": navigator.language || "en" },
  });
  if (!resp.ok) {
    throw new Error(`Geocoding failed: HTTP ${resp.status}`);
  }
  const body = (await resp.json()) as Array<{
    lat: string;
    lon: string;
    display_name: string;
  }>;
  if (!Array.isArray(body) || body.length === 0) return null;
  const top = body[0];
  const lat = Number.parseFloat(top.lat);
  const lon = Number.parseFloat(top.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, display_name: top.display_name };
}
