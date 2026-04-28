/**
 * Phase 14 — Alfred service worker.
 *
 * Three jobs:
 *
 * 1. **App-shell cache.** On install, pre-cache a tiny set of static
 *    assets (the manifest, icons, the offline splash) so the
 *    installed PWA opens instantly even on a cold network.
 *
 * 2. **Smart fetch routing.**
 *    - `/api/*` and `/_next/data/*` → network-first, no cache
 *      fallback. Alfred's chat / voice / vision / Spotify endpoints
 *      MUST always hit the live backend; a cached reply would be
 *      catastrophically wrong (stale weather, fake LLM responses).
 *    - `/_next/static/*` (immutable, hashed JS/CSS bundles) →
 *      stale-while-revalidate. First load is a network fetch +
 *      cache write; subsequent loads return cached bytes
 *      immediately and silently refresh in the background.
 *    - HTML navigation requests → network-first with a fallback to
 *      the cached `/offline.html` splash if the network is down.
 *
 * 3. **Cache hygiene.** When the worker activates, drop any old
 *    cache buckets keyed under previous versions so we don't carry
 *    stale Next.js bundles forever. Update `CACHE_VERSION` whenever
 *    a deploy ships breaking changes to the cached set.
 */

const CACHE_VERSION = "alfred-v1";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const SHELL_ASSETS = [
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-192.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/favicon-32.png",
  "/offline.html",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) =>
        // `cache.addAll` is atomic: a single 404 (e.g. an icon
        // renamed mid-deploy) rejects the whole batch and leaves
        // the cache empty — which would lose `/offline.html` and
        // defeat the entire app-shell cache. Add each asset
        // individually with `Promise.allSettled` so failures are
        // isolated to the specific asset that 404'd.
        Promise.allSettled(SHELL_ASSETS.map((asset) => cache.add(asset))),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((key) => !key.startsWith(CACHE_VERSION))
            .map((key) => caches.delete(key)),
        ),
      ),
      self.clients.claim(),
    ]),
  );
});

function isApiRequest(url) {
  return (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/_next/data/")
  );
}

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/manifest.webmanifest"
  );
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => {
      if (response && response.status === 200 && response.type === "basic") {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);
  // Await the network promise on cache miss — `networkPromise` itself is
  // always truthy (it's a Promise), so a naive `cached || networkPromise`
  // would resolve to `null` on a cache-miss + network-error and reach
  // `event.respondWith(Promise<null>)`, which TypeErrors. Fall through to
  // the pre-cached SHELL_CACHE for icons/manifest before retrying the
  // network so the app shell still works on a cold runtime cache.
  if (cached) return cached;
  const fresh = await networkPromise;
  if (fresh) return fresh;
  const shell = await caches.open(SHELL_CACHE);
  const shellCached = await shell.match(request);
  if (shellCached) return shellCached;
  return fetch(request);
}

async function networkFirstWithOfflineFallback(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch (err) {
    const cache = await caches.open(SHELL_CACHE);
    const offline = await cache.match("/offline.html");
    if (offline) return offline;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Only handle same-origin requests; let cross-origin (Spotify, fonts,
  // analytics) hit the network normally.
  if (url.origin !== self.location.origin) return;

  if (isApiRequest(url)) {
    // Always live for API calls — never serve cached LLM/voice/vision data.
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirstWithOfflineFallback(request));
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
});

// Listen for an explicit "skip waiting" message from the page so the
// user can take a fresh deploy without a hard reload if we ever need
// it. Defensive — currently the registrar doesn't post this.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
