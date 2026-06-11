"use client";

/**
 * MediaPipeNoiseFilter — silences a single class of false-positive
 * "errors" that the Next.js dev overlay flags when MediaPipe's
 * TensorFlow-Lite backend boots up.
 *
 * Background: MediaPipe's WASM bundle routes its bootstrap INFO
 * lines (e.g. "INFO: Created TensorFlow Lite XNNPACK delegate for
 * CPU.") through ``console.error`` regardless of severity. This is
 * harmless — XNNPACK starts up fine and tracking works — but
 * Next.js's intercept-console-error machinery counts every
 * console.error call as an error and pops the red "N error" pill
 * in the corner, scaring the user.
 *
 * The filter:
 *   - Only patches ``console.error`` once
 *   - Only swallows messages that match the known MediaPipe INFO
 *     prefixes; anything else flows through untouched
 *   - Re-emits the message via ``console.info`` so it still shows
 *     in DevTools when you actually want to see it
 *
 * Mounted from ``layout.tsx`` so the patch is in place before any
 * tracking hook fires up the WASM runtime.
 */

import { useEffect } from "react";

// Substrings whose presence in the first console.error argument
// downgrades the call to console.info. Conservative on purpose —
// we ONLY swallow MediaPipe / TF-Lite bootstrap chatter that comes
// in through console.error despite being informational.
const MEDIAPIPE_INFO_NEEDLES = [
  "INFO: Created TensorFlow Lite",
  "INFO: Initialized TensorFlow Lite",
  "Sets FaceBlendshapesGraph",
  "Sets PoseLandmarksDetectorGraph",
];

declare global {
  interface Window {
    __alfredMediaPipeNoiseFiltered?: boolean;
  }
}

export function MediaPipeNoiseFilter() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.__alfredMediaPipeNoiseFiltered) return;
    window.__alfredMediaPipeNoiseFiltered = true;
    const original = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      const first = args[0];
      const text =
        typeof first === "string"
          ? first
          : first instanceof Error
            ? first.message
            : "";
      if (text && MEDIAPIPE_INFO_NEEDLES.some((n) => text.includes(n))) {
        console.info("[mediapipe]", ...args);
        return;
      }
      original(...args);
    };
  }, []);
  return null;
}
