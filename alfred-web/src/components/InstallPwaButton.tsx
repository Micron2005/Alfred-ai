"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * The shape of `BeforeInstallPromptEvent` that Chromium browsers
 * fire when a page meets the PWA install criteria. Not in the
 * built-in lib types yet, so declared locally.
 */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
  prompt(): Promise<void>;
}

/**
 * Phase 14 — "Install Alfred" button.
 *
 * Listens for the `beforeinstallprompt` event Chromium fires when
 * the manifest, icons, and service worker pass install criteria.
 * When fired:
 *
 *   - the browser's default mini-infobar is suppressed (`preventDefault`);
 *   - the event is stashed so we can call `.prompt()` later in
 *     response to a real user gesture (the Install button click).
 *
 * The button is invisible until the event fires, and disappears
 * after a successful install (`appinstalled` event) or when the app
 * is already running standalone. Safari / Firefox-on-desktop never
 * fire `beforeinstallprompt`; on those, this component renders
 * nothing — no degraded experience, the rest of the app is
 * unaffected.
 */
export function InstallPwaButton(): React.ReactNode {
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Already running as an installed app — never offer install again.
    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      // iOS-specific: Apple uses a non-standard `navigator.standalone`.
      ((window.navigator as unknown as { standalone?: boolean }).standalone ??
        false);
    if (standalone) {
      setInstalled(true);
      return;
    }

    const handleBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    const handleInstalled = () => {
      setInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstall);
    window.addEventListener("appinstalled", handleInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstall);
      window.removeEventListener("appinstalled", handleInstalled);
    };
  }, []);

  const handleClick = useCallback(async () => {
    if (!deferredPrompt) return;
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === "accepted") {
        setInstalled(true);
      }
    } catch (err) {
      console.warn("[alfred] install prompt failed:", err);
    } finally {
      // Per the spec, a deferred prompt can only be used once.
      setDeferredPrompt(null);
    }
  }, [deferredPrompt]);

  if (installed || !deferredPrompt) return null;

  return (
    <button
      type="button"
      className="hud-button"
      onClick={() => void handleClick()}
      title="Install Alfred as a standalone app"
    >
      ⤓ INSTALL
    </button>
  );
}
