"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * In-browser hand tracking via MediaPipe HandLandmarker.
 *
 * Detects 21 keypoints per hand at ~30 fps using the same
 * ``@mediapipe/tasks-vision`` package the face detector uses, so
 * there's no new dependency to bundle. Inference is done entirely
 * client-side in the browser's WASM runtime — no audio/video ever
 * leaves the machine.
 *
 * What the hook exposes:
 *   - ``cursor`` — viewport-pixel coordinates of the user's
 *     dominant index fingertip, mapped from the (mirrored) camera
 *     frame. ``null`` until the first hand is detected.
 *   - ``isPinching`` — true while the thumb tip and index fingertip
 *     are close enough to count as a pinch. Computed in normalized
 *     image-space distance so it scales correctly across resolutions.
 *   - ``status`` / ``error`` — same shape as ``useCamera`` so the
 *     UI can render a "starting / ready / error" indicator.
 *
 * The hook opens its own ``getUserMedia`` stream rather than sharing
 * with ``useCamera``. Browsers happily multiplex one physical
 * webcam across multiple ``MediaStream`` instances, and keeping
 * the hooks decoupled means hand-tracking can be enabled without
 * the camera-presence feature being on (or vice versa). We
 * revisit stream-sharing once both features ship and we're sure
 * the duplicate inference cost matters.
 *
 * Smoothing: a short exponential moving average is applied to the
 * cursor position so a steady fingertip doesn't jitter pixel-by-
 * pixel. The smoothing is intentionally light (alpha=0.55) — the
 * cursor needs to feel responsive, not floaty.
 */

import type { HandLandmarker } from "@mediapipe/tasks-vision";

// MediaPipe pins JS↔WASM offsets per release. Must match the
// installed npm package version (see useCamera for the same
// pattern).
const WASM_BASE_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm";
const HAND_MODEL_URL = "/mediapipe/models/hand_landmarker.task";

// Thumb-tip and index-fingertip landmark indices in MediaPipe's
// 21-point hand model. See:
// https://developers.google.com/mediapipe/solutions/vision/hand_landmarker
const THUMB_TIP = 4;
const INDEX_TIP = 8;

// Pinch threshold in normalized image-space units (the landmarks
// come back as 0..1 ratios of the input frame). Empirically tuned
// against a 640x480 webcam feed at sit-down distance: pinches
// below this cleanly trigger, deliberate-finger-apart sits well
// above. Tighten if you get false-positives, loosen if you get
// false-negatives.
const PINCH_DOWN = 0.05;
// Hysteresis: once you're in a pinch, stay in until the gap grows
// past PINCH_UP. Stops the cursor flickering between pinch-on and
// pinch-off when fingers hover right at the threshold.
const PINCH_UP = 0.07;

// Cursor smoothing alpha for the EMA. Higher = snappier but
// jitterier. 0.55 keeps the cursor "alive" without trembling.
const SMOOTHING_ALPHA = 0.55;

export type HandTrackingStatus =
  | "off"
  | "starting"
  | "ready"
  | "error";

export interface CursorPoint {
  /** Viewport pixels (clientX). */
  x: number;
  /** Viewport pixels (clientY). */
  y: number;
}

export interface UseHandTrackingOptions {
  enabled: boolean;
  /**
   * Hard cap on inference frequency. The model is happy at 30 fps
   * but we throttle to give the CPU a break — 16 ms (~60 fps) feels
   * fluid; tighter than that is wasted on cursor responsiveness.
   */
  detectionIntervalMs?: number;
}

export interface UseHandTrackingReturn {
  status: HandTrackingStatus;
  error: string | null;
  cursor: CursorPoint | null;
  isPinching: boolean;
  /**
   * Hidden ``<video>`` ref the hook drives. Mount it offscreen so
   * the browser keeps the element alive (don't add ``autoPlay`` —
   * the hook calls ``play()`` itself).
   */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Active stream ref, exposed for debugging / future sharing. */
  streamRef: React.RefObject<MediaStream | null>;
}

export function useHandTracking(
  opts: UseHandTrackingOptions,
): UseHandTrackingReturn {
  const { enabled, detectionIntervalMs = 16 } = opts;

  const [status, setStatus] = useState<HandTrackingStatus>("off");
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<CursorPoint | null>(null);
  const [isPinching, setIsPinching] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<HandLandmarker | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastInferAtRef = useRef(0);

  // Smoothed cursor tracked in a ref so the RAF loop can update it
  // without forcing a re-render every frame. We commit to React
  // state when the value actually changes by a meaningful amount.
  const smoothedRef = useRef<CursorPoint | null>(null);
  // Latched pinch state with hysteresis so flicker doesn't drop /
  // recreate the pinch every other frame.
  const pinchLatchedRef = useRef(false);

  const teardown = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    const v = videoRef.current;
    if (v) {
      try {
        v.pause();
      } catch {
        /* ignore — page tear-down */
      }
      v.srcObject = null;
    }
    if (detectorRef.current) {
      try {
        detectorRef.current.close();
      } catch {
        /* ignore */
      }
      detectorRef.current = null;
    }
    smoothedRef.current = null;
    pinchLatchedRef.current = false;
    setCursor(null);
    setIsPinching(false);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus("off");
      setError(null);
      teardown();
      return;
    }

    let cancelled = false;
    setStatus("starting");
    setError(null);

    void (async () => {
      try {
        const { HandLandmarker, FilesetResolver } = await import(
          "@mediapipe/tasks-vision"
        );
        const fileset = await FilesetResolver.forVisionTasks(WASM_BASE_URL);
        const detector = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: HAND_MODEL_URL,
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          // One hand for v1 — single-cursor model. Two-hand
          // gestures (zoom / spread) come in a follow-up.
          numHands: 1,
          minHandDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
        });
        if (cancelled) {
          detector.close();
          return;
        }
        detectorRef.current = detector;

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: 640, height: 480 },
          audio: false,
        });
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        streamRef.current = stream;

        const video = videoRef.current;
        if (!video) {
          for (const track of stream.getTracks()) track.stop();
          throw new Error(
            "Hand-tracking video element missing. Mount the hidden <video> from videoRef.",
          );
        }
        video.srcObject = stream;
        video.muted = true;
        await video.play();

        setStatus("ready");

        const tick = (now: number) => {
          if (cancelled) return;
          const det = detectorRef.current;
          const v = videoRef.current;
          if (
            det &&
            v &&
            v.readyState >= 2 &&
            now - lastInferAtRef.current >= detectionIntervalMs
          ) {
            lastInferAtRef.current = now;
            try {
              const res = det.detectForVideo(v, now);
              const landmarks = res.landmarks?.[0];
              if (landmarks && landmarks.length > Math.max(THUMB_TIP, INDEX_TIP)) {
                const thumb = landmarks[THUMB_TIP];
                const index = landmarks[INDEX_TIP];

                // Pinch = small Euclidean distance between thumb
                // tip and index fingertip in normalized 2D space.
                // Z is ignored — in practice it's noisy and not
                // needed for clean pinch detection at sit-down
                // distance.
                const dx = thumb.x - index.x;
                const dy = thumb.y - index.y;
                const dist = Math.hypot(dx, dy);
                const wasPinching = pinchLatchedRef.current;
                const nowPinching = wasPinching
                  ? dist < PINCH_UP
                  : dist < PINCH_DOWN;
                if (nowPinching !== wasPinching) {
                  pinchLatchedRef.current = nowPinching;
                  setIsPinching(nowPinching);
                }

                // Mirror X because the camera is the user-facing
                // one — the user moves their hand right, the
                // mirrored video shows the hand on the user's
                // right (which is the screen's right when they're
                // looking at it). Without the flip the cursor
                // moves opposite to the user's intent.
                const targetX = (1 - index.x) * window.innerWidth;
                const targetY = index.y * window.innerHeight;

                const prev = smoothedRef.current;
                const sx = prev
                  ? prev.x + (targetX - prev.x) * SMOOTHING_ALPHA
                  : targetX;
                const sy = prev
                  ? prev.y + (targetY - prev.y) * SMOOTHING_ALPHA
                  : targetY;
                smoothedRef.current = { x: sx, y: sy };
                // Only push the cursor through React state when
                // it shifts at least a quarter-pixel — sub-pixel
                // updates trigger needless re-renders without
                // visibly moving the overlay.
                setCursor((curr) => {
                  if (
                    curr &&
                    Math.abs(curr.x - sx) < 0.25 &&
                    Math.abs(curr.y - sy) < 0.25
                  ) {
                    return curr;
                  }
                  return { x: sx, y: sy };
                });
              } else {
                // No hand visible. Stop holding pinch (drops a
                // drag gesture if one was active) and clear the
                // cursor so the overlay disappears.
                if (pinchLatchedRef.current) {
                  pinchLatchedRef.current = false;
                  setIsPinching(false);
                }
                if (smoothedRef.current !== null) {
                  smoothedRef.current = null;
                  setCursor(null);
                }
              }
            } catch {
              // Single-frame failure isn't fatal — skip and try
              // again on the next tick.
            }
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setStatus("error");
        const lower = msg.toLowerCase();
        if (lower.includes("permission") || lower.includes("notallowed")) {
          setError(
            "Camera permission denied. Allow camera access in your browser, then toggle hand tracking off and on.",
          );
        } else if (lower.includes("notfound") || lower.includes("not found")) {
          setError(
            "No camera found. Plug one in (or ensure your laptop's built-in webcam isn't disabled), then toggle hand tracking off and on.",
          );
        } else {
          setError(`Hand tracking setup failed: ${msg}`);
        }
        teardown();
      }
    })();

    return () => {
      cancelled = true;
      teardown();
    };
  }, [enabled, detectionIntervalMs, teardown]);

  return useMemo(
    () => ({ status, error, cursor, isPinching, videoRef, streamRef }),
    [status, error, cursor, isPinching],
  );
}
