"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * In-browser hand tracking via MediaPipe HandLandmarker.
 *
 * Detects up to two hands at ~30 fps using the same
 * ``@mediapipe/tasks-vision`` package the face detector uses, so
 * there's no new dependency to bundle. Inference is done entirely
 * client-side in the browser's WASM runtime — no audio/video ever
 * leaves the machine.
 *
 * Phase 12c.3 model: hands are split into "right" (cursor / dominant
 * pointer) and "left" (modifier / tool palette). Each hand reports
 * its own landmarks, pinch state, and fist state. The hook also
 * exposes ``twoHandPinch`` — a derived gesture that fires while
 * BOTH hands are pinching simultaneously, used for two-handed
 * resize. The pre-12c.3 single-hand fields (``cursor``,
 * ``landmarks``, ``isPinching``) are kept on the return type as
 * aliases for the right hand so existing consumers (HandCursor's
 * synthetic-event dispatcher) keep working without changes.
 *
 * Handedness mirroring: the user-facing webcam delivers a
 * non-mirrored image to the detector. From the camera's POV, the
 * user's right hand appears on the LEFT side of the image, which
 * MediaPipe labels as "Left". We swap the labels so the rest of the
 * app sees what the *user* would call their right hand. The visual
 * cursor X-axis is also flipped (1 - lm.x) for the same reason.
 */

import type { HandLandmarker } from "@mediapipe/tasks-vision";

// MediaPipe pins JS↔WASM offsets per release. Must match the
// installed npm package version (see useCamera for the same
// pattern).
const WASM_BASE_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm";
const HAND_MODEL_URL = "/mediapipe/models/hand_landmarker.task";

// MediaPipe 21-point hand landmark indices.
// https://developers.google.com/mediapipe/solutions/vision/hand_landmarker
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const INDEX_MCP = 5;
const MIDDLE_MCP = 9;
const MIDDLE_TIP = 12;
const RING_MCP = 13;
const RING_TIP = 16;
const PINKY_MCP = 17;
const PINKY_TIP = 20;

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

// Fist detection. A finger is "curled" only if its fingertip has
// folded back to be at or BEHIND the MCP knuckle, measured by
// distance to the wrist. When you make an actual fist, your
// fingertips come back toward your palm — the tip distance to
// wrist drops below the MCP distance to wrist. When fingers are
// merely bent (e.g. resting hand pose, half-curled), the
// fingertip is still farther from the wrist than the MCP, so
// this test correctly says "not curled". Compared to the previous
// "extended if tip > 1.6× MCP" heuristic, this is much stricter:
// slightly-bent fingers no longer count as curled, so the fist
// gesture only fires when you've actually closed your hand.
//
// The threshold uses a small slack (1.05×) so a perfectly straight
// finger doesn't waver around 1.0×.
const FIST_CURL_RATIO = 1.05;
// Hysteresis: enter a fist only when ALL FOUR non-thumb fingers
// are curled. Exit once 2+ uncurl. Stops the menu flickering
// open/closed when the user's hand transitions through a
// half-curled pose.
const FIST_FINGERS_FOR_FIST = 4;     // need this many curled to enter fist
const FIST_FINGERS_FOR_OPEN = 2;     // need this many uncurled to leave fist
// Default state when the hand isn't visible at all should still be
// "no fist" so the menu doesn't spuriously appear.

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

// Skeleton scale factor. The raw projection from normalized 0..1
// landmark coordinates to viewport pixels makes the rendered hand
// the same size as the camera frame stretched across the screen
// — far larger than the user's actual hand. Scaling each landmark
// toward the index-fingertip cursor (the anchor point) shrinks
// the visible skeleton without changing where the cursor itself
// lives. 0.45 ≈ "looks roughly like my actual hand at desk
// distance" while still being readable.
const SKELETON_SCALE = 0.45;

// Per-landmark dedup threshold (viewport pixels). MediaPipe's
// raw landmarks jitter slightly every frame even when the hand
// is still, so naively committing each frame's projection to
// React state forces ~60 re-renders/s of the whole ChatWindow
// tree. Skip the commit unless at least one landmark has
// actually moved by this much.
const LANDMARK_DEDUP_PX = 0.5;

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

/** Per-hand state. Shared shape between left and right hands. */
export interface HandState {
  /**
   * Index-fingertip position in viewport pixels, smoothed and
   * dead-zoned (right hand only — for the left hand this is the
   * raw projected fingertip without the cursor smoothing, since
   * the left hand isn't a pointer).
   */
  cursor: CursorPoint;
  /** All 21 landmarks projected to viewport pixels (mirrored). */
  landmarks: CursorPoint[];
  /** Thumb-tip ↔ index-fingertip pinch. Hysteresis applied. */
  isPinching: boolean;
  /** Closed-fist gesture (all 4 non-thumb fingers curled in). */
  isFist: boolean;
  /**
   * Midpoint between thumb tip and index fingertip in viewport
   * pixels. Anchor for pinch-driven gestures (e.g. two-hand
   * resize). Same value whether or not the hand is currently
   * pinching — useful for predicting where a future pinch will
   * land.
   */
  pinchPoint: CursorPoint;
}

export interface TwoHandPinch {
  /** True only while BOTH hands are pinching simultaneously. */
  active: boolean;
  /**
   * Pixel distance between left and right pinch points right
   * now. ``0`` when ``active`` is false.
   */
  distancePx: number;
  /**
   * Pixel distance captured at the instant ``active`` flipped
   * from false → true. ``null`` when ``active`` is false. Used
   * by consumers as the denominator for ratio-based scaling.
   */
  initialDistancePx: number | null;
  /**
   * Midpoint between the two pinches in viewport px, or ``null``
   * when not active.
   */
  midpoint: CursorPoint | null;
}

export interface UseHandTrackingOptions {
  enabled: boolean;
  /**
   * Pre-existing camera stream to share (typically the one
   * ``useCamera`` already owns). Strongly recommended — without it,
   * we'd open a second getUserMedia stream and race with the other
   * vision hooks, which on some hardware ends with the camera tile
   * blank while a different hook silently owns the device.
   */
  sharedStream?: MediaStream | null;
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
  /** Right-hand state, ``null`` when not visible. */
  right: HandState | null;
  /** Left-hand state, ``null`` when not visible. */
  left: HandState | null;
  /** Two-handed pinch combo state. */
  twoHandPinch: TwoHandPinch;
  /**
   * Backwards-compat alias for the right hand's smoothed cursor.
   * Pre-12c.3 callers (HandCursor synthetic-event dispatcher)
   * keep working unchanged.
   */
  cursor: CursorPoint | null;
  /** Backwards-compat alias for the right hand's landmarks. */
  landmarks: CursorPoint[] | null;
  /** Backwards-compat alias for the right hand's pinch state. */
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

interface RawLandmark {
  x: number;
  y: number;
  z?: number;
}

interface PerHandRefs {
  smoothed: CursorPoint | null;
  lastLandmarks: CursorPoint[] | null;
  pinchLatched: boolean;
  fistLatched: boolean;
}

function dist2d(a: RawLandmark, b: RawLandmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Count how many of the four non-thumb fingers are currently
 * curled (folded toward the palm). A finger is curled when its
 * fingertip is at or BEHIND its MCP knuckle measured by distance
 * to the wrist — i.e., the tip has folded back. A merely-bent
 * finger still has tip farther from wrist than MCP, so it
 * correctly does not count as curled.
 */
function countCurledFingers(lm: RawLandmark[]): number {
  if (!lm[WRIST]) return 0;
  const wrist = lm[WRIST];
  let curled = 0;
  const pairs: Array<readonly [number, number]> = [
    [INDEX_TIP, INDEX_MCP],
    [MIDDLE_TIP, MIDDLE_MCP],
    [RING_TIP, RING_MCP],
    [PINKY_TIP, PINKY_MCP],
  ];
  for (const [tipIdx, mcpIdx] of pairs) {
    const tip = lm[tipIdx];
    const mcp = lm[mcpIdx];
    if (!tip || !mcp) continue;
    const tipDist = dist2d(tip, wrist);
    const mcpDist = dist2d(mcp, wrist);
    if (mcpDist > 0 && tipDist <= mcpDist * FIST_CURL_RATIO) {
      curled++;
    }
  }
  return curled;
}

function landmarksDiffer(
  a: CursorPoint[] | null,
  b: CursorPoint[],
): boolean {
  if (!a || a.length !== b.length) return true;
  for (let i = 0; i < b.length; i++) {
    const aa = a[i];
    const bb = b[i];
    if (
      Math.abs(aa.x - bb.x) >= LANDMARK_DEDUP_PX ||
      Math.abs(aa.y - bb.y) >= LANDMARK_DEDUP_PX
    ) {
      return true;
    }
  }
  return false;
}

export function useHandTracking(
  opts: UseHandTrackingOptions,
): UseHandTrackingReturn {
  const { enabled, sharedStream, detectionIntervalMs = 16 } = opts;

  const [status, setStatus] = useState<HandTrackingStatus>("off");
  const [error, setError] = useState<string | null>(null);
  const [right, setRight] = useState<HandState | null>(null);
  const [left, setLeft] = useState<HandState | null>(null);
  const [twoHand, setTwoHand] = useState<TwoHandPinch>({
    active: false,
    distancePx: 0,
    initialDistancePx: null,
    midpoint: null,
  });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<HandLandmarker | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastInferAtRef = useRef(0);
  // Off-screen canvas used to pre-mirror each video frame before
  // handing it to MediaPipe. The classifier is documented as
  // "expects selfie-mirrored input" — feeding it a raw camera
  // stream causes its handedness labels to be flipped from the
  // user's perspective. By mirroring upstream, the labels and
  // landmark coordinates BOTH come back in user-perspective
  // and downstream code can stop second-guessing the camera
  // pipeline.
  const mirrorCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const mirrorCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  // Throttle for the optional handedness-debug log
  // (localStorage.alfred_hand_debug='1'). One line per second per
  // detected hand max; spammy console kills perf.
  const lastDebugLogAtRef = useRef(0);

  // Per-hand stateful refs so the RAF loop can update without
  // forcing a re-render every frame. We commit to React state
  // when the value actually changes by a meaningful amount.
  const rightRefs = useRef<PerHandRefs>({
    smoothed: null,
    lastLandmarks: null,
    pinchLatched: false,
    fistLatched: false,
  });
  const leftRefs = useRef<PerHandRefs>({
    smoothed: null,
    lastLandmarks: null,
    pinchLatched: false,
    fistLatched: false,
  });
  const twoHandRef = useRef<TwoHandPinch>({
    active: false,
    distancePx: 0,
    initialDistancePx: null,
    midpoint: null,
  });

  const teardown = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    // Don't stop tracks here — the shared stream is owned by
    // useCamera. Just drop the ref and detach our <video>.
    streamRef.current = null;
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
    rightRefs.current = {
      smoothed: null,
      lastLandmarks: null,
      pinchLatched: false,
      fistLatched: false,
    };
    leftRefs.current = {
      smoothed: null,
      lastLandmarks: null,
      pinchLatched: false,
      fistLatched: false,
    };
    twoHandRef.current = {
      active: false,
      distancePx: 0,
      initialDistancePx: null,
      midpoint: null,
    };
    setRight(null);
    setLeft(null);
    setTwoHand({
      active: false,
      distancePx: 0,
      initialDistancePx: null,
      midpoint: null,
    });
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
        // Hand tracking ALWAYS rides on the shared camera stream.
        // See the equivalent comment in ``useFaceTracking`` — three
        // parallel getUserMedia calls was the cause of the blank
        // camera tile bug.
        if (!sharedStream) {
          setStatus("off");
          return;
        }
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
          // Phase 12c.3: track up to two hands for left/right
          // asymmetry and two-handed combos. The model is happy at
          // ~30 fps even tracking both — adds about 4 ms per frame
          // on a mid-range laptop.
          numHands: 2,
          // Confidence thresholds tuned for two-hand simultaneous
          // detection. The default 0.5 is fine for a single hand
          // dead-centre in frame, but at sit-down distance with
          // both hands raised the second hand is often partially
          // out-of-frame or angled, and the per-frame confidence
          // dips below 0.5 intermittently. Dropping these to 0.3
          // keeps both hands tracked smoothly at the cost of
          // accepting a slightly larger "is this even a hand"
          // false-positive rate (rare in practice — the landmark
          // model still has to fit 21 points, which is its own
          // sanity check).
          minHandDetectionConfidence: 0.3,
          minTrackingConfidence: 0.3,
          minHandPresenceConfidence: 0.3,
        });
        if (cancelled) {
          detector.close();
          return;
        }
        detectorRef.current = detector;

        // Hand tracking shares the camera stream owned by
        // ``useCamera`` — see comment above. ``streamRef`` is kept
        // for backwards compat (some debug surfaces still read it),
        // but we DO NOT stop the tracks on teardown: the camera
        // hook owns the lifecycle and stopping its tracks here
        // would yank the entire shared pipeline.
        streamRef.current = sharedStream;

        const video = videoRef.current;
        if (!video) {
          throw new Error(
            "Hand-tracking video element missing. Mount the hidden <video> from videoRef.",
          );
        }
        video.srcObject = sharedStream;
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
              // Lazily build the mirror canvas matching the
              // current frame size. videoWidth/Height are 0
              // until metadata loads, hence the lazy init.
              const vw0 = v.videoWidth;
              const vh0 = v.videoHeight;
              if (!mirrorCanvasRef.current && vw0 > 0 && vh0 > 0) {
                const canvas = document.createElement("canvas");
                canvas.width = vw0;
                canvas.height = vh0;
                const ctx = canvas.getContext("2d", { alpha: false });
                if (ctx) {
                  mirrorCanvasRef.current = canvas;
                  mirrorCtxRef.current = ctx;
                }
              }
              const canvas = mirrorCanvasRef.current;
              const ctx = mirrorCtxRef.current;
              let target: HTMLVideoElement | HTMLCanvasElement = v;
              if (canvas && ctx && vw0 > 0 && vh0 > 0) {
                // Resize canvas if the source frame size changed
                // (e.g. webcam resolution renegotiated). Drawing
                // into a stale-sized canvas would crop or stretch.
                if (canvas.width !== vw0 || canvas.height !== vh0) {
                  canvas.width = vw0;
                  canvas.height = vh0;
                }
                // Mirror by translating then scaling x by -1.
                // Reset to identity each frame so transforms don't
                // accumulate across calls.
                ctx.setTransform(-1, 0, 0, 1, canvas.width, 0);
                ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
                target = canvas;
              }
              const res = det.detectForVideo(target, now);
              processFrame(res);
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
            "Camera permission denied. Allow camera access in your browser, then reload the page.",
          );
        } else if (lower.includes("notfound") || lower.includes("not found")) {
          setError(
            "No camera found. Plug one in (or ensure your laptop's built-in webcam isn't disabled), then reload the page.",
          );
        } else {
          setError(`Hand tracking setup failed: ${msg}`);
        }
        teardown();
      }
    })();

    /**
     * Process a single MediaPipe inference result: split into left
     * and right hands (with the camera-mirror swap), apply pinch /
     * fist detection per hand, smooth the right cursor, project
     * landmarks to viewport pixels, dedupe, and commit any state
     * changes to React.
     */
    function processFrame(res: {
      landmarks?: RawLandmark[][];
      handednesses?: Array<Array<{ categoryName?: string }>>;
    }) {
      const allHands = res.landmarks ?? [];
      const allLabels = res.handednesses ?? [];
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      let rawRight: RawLandmark[] | null = null;
      let rawLeft: RawLandmark[] | null = null;
      // The video frame is pre-mirrored on a canvas before being
      // handed to MediaPipe (see the tick loop above). That means
      // MediaPipe is receiving the selfie-style input it was
      // trained on, so its handedness labels and landmark
      // coordinates already match the user's perspective:
      //   - label "Right" => user's right hand
      //   - lm.x ≈ 0.8     => right side of user's view
      // No swap, no flip, no per-webcam guessing required.

      // First pass: collect every valid hand with its handedness
      // and wrist-x. We still need wristX as a tiebreaker because
      // MediaPipe's classifier is independent per hand and can
      // occasionally label both detections the same (e.g. both
      // "Right" when the user holds the same pose with both hands).
      type Detected = {
        lm: RawLandmark[];
        isUserRight: boolean;
        wristX: number;
        // Original index into allHands / allLabels so debug
        // logging (which iterates `detected`) can recover the
        // matching raw label even when some hands were filtered
        // out for malformed landmarks.
        origIdx: number;
      };
      const detected: Detected[] = [];
      for (let i = 0; i < allHands.length; i++) {
        const lm = allHands[i];
        if (!lm || lm.length < 21) continue;
        const label = allLabels[i]?.[0]?.categoryName ?? "Right";
        const isUserRight = label === "Right";
        const wristX = lm[WRIST]?.x ?? 0.5;
        detected.push({ lm, isUserRight, wristX, origIdx: i });
      }

      // Route detections to right/left slots. With pre-mirrored
      // input, MediaPipe's labels are already in user-perspective
      // and "user's right hand" sits at LARGER x. If both
      // detections come back with the same label, fall back to
      // wrist-x ordering (right hand = larger x) so we still get
      // both hands on screen.
      if (detected.length === 1) {
        const d = detected[0];
        if (d.isUserRight) rawRight = d.lm;
        else rawLeft = d.lm;
      } else if (detected.length >= 2) {
        const [a, b] = detected;
        if (a.isUserRight !== b.isUserRight) {
          if (a.isUserRight) {
            rawRight = a.lm;
            rawLeft = b.lm;
          } else {
            rawRight = b.lm;
            rawLeft = a.lm;
          }
        } else {
          if (a.wristX > b.wristX) {
            rawRight = a.lm;
            rawLeft = b.lm;
          } else {
            rawRight = b.lm;
            rawLeft = a.lm;
          }
        }
      }

      // Optional verbose debug for diagnosing handedness in
      // the wild. Enable from the browser console with:
      //   localStorage.alfred_hand_debug = '1'
      // Logs the raw MediaPipe label, the resolved user-side,
      // and the wrist x for every detected hand, throttled to
      // ~1 line per second per hand to avoid spamming.
      try {
        if (window.localStorage.getItem("alfred_hand_debug") === "1") {
          const now = performance.now();
          if (now - lastDebugLogAtRef.current > 1000) {
            lastDebugLogAtRef.current = now;
            for (const d of detected) {
              const rawLabel =
                allLabels[d.origIdx]?.[0]?.categoryName ?? "?";
              // eslint-disable-next-line no-console
              console.log(
                `[hand-debug] mediapipe=${rawLabel} userSide=${d.isUserRight ? "right" : "left"} wristX=${d.wristX.toFixed(3)}`,
              );
            }
          }
        }
      } catch {
        // ignore; localStorage may be unavailable
      }

      const nextRight = rawRight
        ? computeHandState(rawRight, rightRefs.current, vw, vh, true)
        : null;
      const nextLeft = rawLeft
        ? computeHandState(rawLeft, leftRefs.current, vw, vh, false)
        : null;

      // Reset per-hand refs when a hand leaves the frame so
      // re-entry starts from a clean baseline. Without this,
      // ``smoothed`` keeps the last position (the EMA blend then
      // drags the cursor in from the old spot for 2-3 frames),
      // and the pinch / fist latches stay set (a hand re-entering
      // mid-gesture in the hysteresis band would re-fire the
      // latched gesture without the user actually pinching).
      if (!rawRight) {
        rightRefs.current.smoothed = null;
        rightRefs.current.pinchLatched = false;
        rightRefs.current.fistLatched = false;
        rightRefs.current.lastLandmarks = null;
      }
      if (!rawLeft) {
        leftRefs.current.smoothed = null;
        leftRefs.current.pinchLatched = false;
        leftRefs.current.fistLatched = false;
        leftRefs.current.lastLandmarks = null;
      }

      // Commit per-hand state if it materially changed.
      setRight((curr) => (handStateEqual(curr, nextRight) ? curr : nextRight));
      setLeft((curr) => (handStateEqual(curr, nextLeft) ? curr : nextLeft));

      // Two-hand pinch derived gesture. Treat a fisted left hand
      // as NOT a deliberate pinch, even if the thumb-to-index
      // distance falls below threshold (a closed fist tucks the
      // thumb against the fingers, which incidentally trips the
      // pinch latch). Without this guard, a left-fist + right-
      // pinch would silently start scaling the widget under the
      // cursor while the user thinks they're just opening the
      // Quick Tools menu.
      const bothPinching =
        !!nextRight &&
        !!nextLeft &&
        nextRight.isPinching &&
        nextLeft.isPinching &&
        !nextLeft.isFist;
      const prevTwo = twoHandRef.current;
      let nextTwo: TwoHandPinch;
      if (bothPinching && nextRight && nextLeft) {
        const rp = nextRight.pinchPoint;
        const lp = nextLeft.pinchPoint;
        const distancePx = Math.hypot(rp.x - lp.x, rp.y - lp.y);
        const initial = prevTwo.active
          ? prevTwo.initialDistancePx
          : distancePx;
        nextTwo = {
          active: true,
          distancePx,
          initialDistancePx: initial,
          midpoint: { x: (rp.x + lp.x) / 2, y: (rp.y + lp.y) / 2 },
        };
      } else {
        nextTwo = {
          active: false,
          distancePx: 0,
          initialDistancePx: null,
          midpoint: null,
        };
      }
      twoHandRef.current = nextTwo;
      setTwoHand((curr) => (twoHandEqual(curr, nextTwo) ? curr : nextTwo));
    }

    /**
     * Build a HandState from a single set of raw MediaPipe
     * landmarks, applying per-hand smoothing / hysteresis /
     * landmark dedup. Mutates the ``refs`` object in place so the
     * next frame sees this frame's tail state.
     *
     * ``isRight`` controls cursor smoothing: only the right (cursor)
     * hand gets the full adaptive-EMA + dead-zone treatment. The
     * left hand's "cursor" is just the raw projected fingertip,
     * since it's not driving a pointer.
     */
    function computeHandState(
      lm: RawLandmark[],
      refs: PerHandRefs,
      vw: number,
      vh: number,
      isRight: boolean,
    ): HandState {
      const thumb = lm[THUMB_TIP];
      const index = lm[INDEX_TIP];
      const dx = thumb.x - index.x;
      const dy = thumb.y - index.y;
      const pinchDist = Math.hypot(dx, dy);
      const wasPinching = refs.pinchLatched;
      const nowPinching = wasPinching
        ? pinchDist < PINCH_UP
        : pinchDist < PINCH_DOWN;
      refs.pinchLatched = nowPinching;

      // Hysteresis on the strict curl count. Enter a fist when
      // ALL FOUR non-thumb fingers are curled (tips folded back
      // behind their MCPs). Exit once 2+ fingers uncurl, i.e.
      // curled count drops to 2 or fewer.
      const curled = countCurledFingers(lm);
      const wasFist = refs.fistLatched;
      const nowFist = wasFist
        ? curled > 4 - FIST_FINGERS_FOR_OPEN  // stay fist while >2 curled
        : curled >= FIST_FINGERS_FOR_FIST;     // enter fist at 4/4 curled
      refs.fistLatched = nowFist;

      // Project all landmarks into viewport pixels. The video
      // frame is pre-mirrored upstream, so MediaPipe's lm.x is
      // already in user-perspective: x=0 left of viewport, x=1
      // right of viewport. Y is never flipped — y=0 is top of
      // image and top of viewport.
      const rawProjected: CursorPoint[] = lm.map((p) => ({
        x: p.x * vw,
        y: p.y * vh,
      }));

      // Pinch midpoint in viewport space (using raw projection
      // since it's only used to drive the click point, not the
      // visible skeleton).
      const pthumb = rawProjected[THUMB_TIP];
      const pindex = rawProjected[INDEX_TIP];
      const pinchPoint: CursorPoint = {
        x: (pthumb.x + pindex.x) / 2,
        y: (pthumb.y + pindex.y) / 2,
      };

      // Cursor: raw target = projected index fingertip. For the
      // right hand we run it through adaptive EMA + dead-zone for
      // a smooth pointer feel; for the left hand we just snap to
      // the raw value (it's a hand-pose indicator, not a pointer).
      const targetX = pindex.x;
      const targetY = pindex.y;
      let cursorX = targetX;
      let cursorY = targetY;
      if (isRight) {
        const prev = refs.smoothed;
        if (prev) {
          const speed = Math.hypot(targetX - prev.x, targetY - prev.y);
          const t = Math.min(1, speed / SPEED_FOR_FULL_RESPONSE);
          const alpha = ALPHA_MIN + (ALPHA_MAX - ALPHA_MIN) * t;
          const candX = prev.x + (targetX - prev.x) * alpha;
          const candY = prev.y + (targetY - prev.y) * alpha;
          if (Math.hypot(candX - prev.x, candY - prev.y) < DEAD_ZONE_PX) {
            cursorX = prev.x;
            cursorY = prev.y;
          } else {
            cursorX = candX;
            cursorY = candY;
          }
        }
      }
      refs.smoothed = { x: cursorX, y: cursorY };

      // Scale the rendered skeleton toward the index-fingertip
      // anchor (which IS the cursor). This shrinks the visible
      // hand to a more natural size without moving the cursor.
      // For non-cursor (left) hands we use the raw fingertip
      // since smoothing isn't applied — same anchor either way.
      const anchorX = isRight ? cursorX : targetX;
      const anchorY = isRight ? cursorY : targetY;
      const projected: CursorPoint[] = rawProjected.map((p) => ({
        x: anchorX + (p.x - pindex.x) * SKELETON_SCALE,
        y: anchorY + (p.y - pindex.y) * SKELETON_SCALE,
      }));

      // Landmark dedup: reuse the previous projected array
      // identity if no landmark moved >= threshold. Critical
      // for re-render perf — see notes on LANDMARK_DEDUP_PX.
      let landmarksOut = projected;
      if (!landmarksDiffer(refs.lastLandmarks, projected)) {
        landmarksOut = refs.lastLandmarks ?? projected;
      } else {
        refs.lastLandmarks = projected;
      }

      return {
        cursor: { x: cursorX, y: cursorY },
        landmarks: landmarksOut,
        isPinching: nowPinching,
        isFist: nowFist,
        pinchPoint,
      };
    }

    return () => {
      cancelled = true;
      teardown();
    };
  }, [enabled, sharedStream, detectionIntervalMs, teardown]);

  // Backwards-compat aliases for pre-12c.3 callers (HandCursor's
  // synthetic-event dispatcher reads cursor / landmarks /
  // isPinching directly).
  const cursor = right?.cursor ?? null;
  const landmarks = right?.landmarks ?? null;
  const isPinching = right?.isPinching ?? false;

  return useMemo(
    () => ({
      status,
      error,
      right,
      left,
      twoHandPinch: twoHand,
      cursor,
      landmarks,
      isPinching,
      videoRef,
      streamRef,
    }),
    [status, error, right, left, twoHand, cursor, landmarks, isPinching],
  );
}

function handStateEqual(
  a: HandState | null,
  b: HandState | null,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  // Cursor: small tolerance, same as pre-12c.3 (sub-quarter-pixel
  // updates aren't visible and shouldn't trigger renders).
  if (
    Math.abs(a.cursor.x - b.cursor.x) >= 0.25 ||
    Math.abs(a.cursor.y - b.cursor.y) >= 0.25
  )
    return false;
  if (a.isPinching !== b.isPinching) return false;
  if (a.isFist !== b.isFist) return false;
  // Landmarks: identity check is enough because the hook reuses
  // the previous array reference when nothing moved past the
  // dedup threshold.
  if (a.landmarks !== b.landmarks) return false;
  // pinchPoint moves with the landmarks; if the array reference
  // is the same we can also skip this comparison.
  return true;
}

function twoHandEqual(a: TwoHandPinch, b: TwoHandPinch): boolean {
  if (a.active !== b.active) return false;
  if (!a.active && !b.active) return true;
  if (Math.abs(a.distancePx - b.distancePx) >= 0.5) return false;
  if (a.initialDistancePx !== b.initialDistancePx) return false;
  return true;
}
