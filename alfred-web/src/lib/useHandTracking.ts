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

// Adaptive smoothing for the cursor. The classic exponential
// moving average is a single trade-off: high alpha = snappy but
// jittery, low alpha = smooth but laggy. Real fingertip motion
// is bimodal — you want low jitter when the hand is mostly still
// (so the cursor doesn't tremble), and snappy response when the
// hand is actually moving (so dragging doesn't feel like wading).
//
// We approximate a One-Euro filter: at low instantaneous speed
// the alpha is small (heavy smoothing), at high speed it ramps
// up toward 1.0 (almost no smoothing). The transition is
// continuous so users don't feel a stair-step.
const ALPHA_MIN = 0.18; // when fingertip is barely moving
const ALPHA_MAX = 0.85; // when fingertip is whipping across the screen
// Speed (in viewport pixels per frame) at which the smoother is
// fully responsive. Empirically ~25 px/frame is a fast purposeful
// hand swipe; below ~3 px/frame is just twitchy noise.
const SPEED_FOR_FULL_RESPONSE = 25;

// Dead-zone radius in viewport pixels. Smoothed deltas smaller
// than this are treated as noise and don't move the cursor at
// all. Stops the cursor from drifting when the user holds their
// hand still and the inference jitters from frame to frame.
const DEAD_ZONE_PX = 1.5;

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
  /**
   * All 21 hand-landmark positions in viewport-pixel coordinates,
   * mirrored to match the user-facing camera so the rendered hand
   * tracks naturally with what the user sees on screen. ``null``
   * when no hand is visible. The order matches MediaPipe's hand
   * landmark spec (0=wrist, 4=thumb tip, 8=index tip, etc.).
   */
  landmarks: CursorPoint[] | null;
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
  const [landmarks, setLandmarks] = useState<CursorPoint[] | null>(null);
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
    setLandmarks(null);
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
                const vw = window.innerWidth;
                const vh = window.innerHeight;
                const targetX = (1 - index.x) * vw;
                const targetY = index.y * vh;

                // Adaptive smoothing: pick an alpha based on how
                // fast the raw fingertip is moving. Heavy smoothing
                // when still, almost no smoothing when fast.
                const prev = smoothedRef.current;
                let sx: number;
                let sy: number;
                if (prev) {
                  const speed = Math.hypot(
                    targetX - prev.x,
                    targetY - prev.y,
                  );
                  const t = Math.min(1, speed / SPEED_FOR_FULL_RESPONSE);
                  const alpha = ALPHA_MIN + (ALPHA_MAX - ALPHA_MIN) * t;
                  const candidateX = prev.x + (targetX - prev.x) * alpha;
                  const candidateY = prev.y + (targetY - prev.y) * alpha;
                  // Dead-zone: if the smoothed step is smaller
                  // than DEAD_ZONE_PX, freeze. Stops noise-driven
                  // drift while the user holds their hand still.
                  const dx = candidateX - prev.x;
                  const dy = candidateY - prev.y;
                  if (Math.hypot(dx, dy) < DEAD_ZONE_PX) {
                    sx = prev.x;
                    sy = prev.y;
                  } else {
                    sx = candidateX;
                    sy = candidateY;
                  }
                } else {
                  sx = targetX;
                  sy = targetY;
                }
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

                // Project all 21 landmarks into viewport pixels
                // so the visual layer can render the whole hand,
                // not just the cursor. Same mirror as the cursor
                // so the rendered hand matches what the user sees.
                const projected: CursorPoint[] = landmarks.map((lm) => ({
                  x: (1 - lm.x) * vw,
                  y: lm.y * vh,
                }));
                setLandmarks(projected);
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
                  setLandmarks(null);
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
    () => ({
      status,
      error,
      cursor,
      landmarks,
      isPinching,
      videoRef,
      streamRef,
    }),
    [status, error, cursor, landmarks, isPinching],
  );
}
