"use client";

import { useEffect } from "react";

/**
 * Registers the Phase 14 service worker on the client.
 *
 * Mounted once in the root layout. Returns nothing visible — the
 * registration is a side-effect. Skips registration in development
 * (`NODE_ENV === "development"`) so HMR isn't competing with the
 * worker's caching layer, and skips entirely on browsers without
 * service-worker support (older Safari, Firefox in private mode,
 * etc).
 */
export function ServiceWorkerRegistrar(): null {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV === "development") return;

    let cancelled = false;
    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
        });
        if (cancelled) return;
        // If the page is currently controlled by an older worker and
        // a new one is waiting, log it. We don't auto-skip-waiting —
        // letting the next reload pick it up keeps state predictable.
        if (registration.waiting) {
          console.info("[alfred] service worker update waiting");
        }
      } catch (err) {
        console.warn("[alfred] service worker registration failed:", err);
      }
    };

    void register();
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
