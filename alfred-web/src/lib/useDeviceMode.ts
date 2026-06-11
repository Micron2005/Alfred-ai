"use client";

/**
 * useDeviceMode — central detector for "is the user on a phone?".
 *
 * Returns ``"mobile"`` when:
 *   - ``window.matchMedia("(pointer: coarse) and (max-width: 768px)")`` matches; OR
 *   - the user-agent string clearly identifies a phone OS;
 * else ``"desktop"``.
 *
 * Purposely client-only (returns ``null`` server-side) — Next.js
 * SSR can't know the user's pointer type, and rendering the wrong
 * shell on first paint causes a visible "desktop layout flash"
 * before the client takes over. ``null`` lets the parent render a
 * tiny boot splash instead.
 */

import { useEffect, useState } from "react";

export type DeviceMode = "mobile" | "desktop";

const PHONE_UA =
  /(iphone|ipod|android.*mobile|windows phone|mobile.*firefox)/i;

export function useDeviceMode(): DeviceMode | null {
  const [mode, setMode] = useState<DeviceMode | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(pointer: coarse) and (max-width: 768px)");
    const compute = (): DeviceMode => {
      if (mq.matches) return "mobile";
      if (PHONE_UA.test(navigator.userAgent || "")) return "mobile";
      return "desktop";
    };
    setMode(compute());
    const onChange = () => setMode(compute());
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return mode;
}
