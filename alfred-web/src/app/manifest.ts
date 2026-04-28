import type { MetadataRoute } from "next";

/**
 * Phase 14 — Web App Manifest.
 *
 * Tells Chromium-based browsers (Chrome / Edge / Brave / Vivaldi /
 * Arc) and modern Safari that Alfred is installable as a standalone
 * app. When the user accepts the install prompt:
 *
 *   - the app gets its own taskbar / dock / launcher icon;
 *   - it opens in a frameless window without browser chrome;
 *   - camera + mic permissions are scoped to the installed app, not
 *     "yet another browser tab";
 *   - the wake-word listener survives even if the user closes the
 *     last Chrome window, so Alfred is reachable from anywhere on
 *     the OS.
 *
 * The manifest stays valid even if the install prompt isn't taken —
 * Alfred still works as a normal browser tab with no behaviour
 * change. Install is strictly opt-in.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/?source=pwa",
    name: "Alfred",
    short_name: "Alfred",
    description:
      "At your service. A multi-modal personal assistant with a JARVIS-style HUD.",
    start_url: "/?source=pwa",
    scope: "/",
    display: "standalone",
    display_override: ["window-controls-overlay", "standalone"],
    orientation: "any",
    background_color: "#060912",
    theme_color: "#060912",
    categories: ["productivity", "utilities", "lifestyle"],
    lang: "en",
    dir: "ltr",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      {
        name: "New conversation",
        short_name: "New chat",
        description: "Start a fresh conversation with Alfred.",
        url: "/?new=1&source=pwa-shortcut",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
    ],
  };
}
