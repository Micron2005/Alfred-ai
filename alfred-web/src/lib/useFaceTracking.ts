"use client";

/**
 * In-browser face tracking via MediaPipe FaceLandmarker.
 *
 * Uses the same ``@mediapipe/tasks-vision`` package the hand
 * tracker uses, so no new dependency. Detects 478 face landmarks
 * AND a 52-dimensional blendshape vector (ARKit-compatible
 * facial-action coefficients — smile, frown, brow raise, eye
 * blink, mouth open, etc.) at ~30 fps entirely client-side.
 *
 * Returns:
 *   - landmarks: 478 (x, y) viewport-pixel points for drawing the face mesh
 *   - blendshapes: dictionary of named expression intensities (0..1)
 *   - dominantExpression: highest-intensity blendshape name + score
 *   - identityVector: 96-D normalized geometric signature, useful
 *     for cheap "same face" matching when paired with a backend
 *     enrollment store (pgvector). This is NOT a learned-model
 *     face embedding — for production identity work, swap in a
 *     proper FaceNet / ArcFace embedding via the backend's
 *     ``/vision/face_recognition`` endpoint instead.
 *
 * Designed to share the existing camera stream from ``useCamera``
 * when one is active — pass it via ``sharedStream`` so we don't
 * fight over the device. If no shared stream is provided the hook
 * grabs its own getUserMedia stream.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { FaceLandmarker } from "@mediapipe/tasks-vision";

const WASM_BASE_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm";
// Hosted by Google. Self-host into ``/public/mediapipe/models/`` if
// you want fully offline operation; the path below is the canonical
// CDN fallback used by every official MediaPipe demo.
const FACE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

export type FaceTrackingStatus = "off" | "starting" | "ready" | "error";

export interface FacePoint {
  x: number;
  y: number;
  z?: number;
}

/** A single named blendshape (e.g. "mouthSmileLeft") with its score (0..1). */
export interface BlendShape {
  name: string;
  score: number;
}

export interface FaceState {
  /** All 478 face landmarks projected to viewport pixels. */
  landmarks: FacePoint[];
  /** Per-blendshape score, keyed by category name. */
  blendshapes: Record<string, number>;
  /** Highest-intensity blendshape, or ``null`` if no face. */
  dominantExpression: BlendShape | null;
  /**
   * 96-D identity signature derived from normalized landmark
   * distances. Rough but useful as a "same face" hint when the
   * backend isn't configured with a real face-embedding model.
   * Cosine similarity > ~0.97 typically means same person at
   * similar pose; below ~0.92 is usually a different person.
   */
  identityVector: number[];
  /** Bounding box around the face in viewport pixels. */
  bbox: { x: number; y: number; w: number; h: number };
}

export interface UseFaceTrackingOptions {
  enabled: boolean;
  /** Optional pre-existing video stream to share. */
  sharedStream?: MediaStream | null;
  detectionIntervalMs?: number;
}

export interface UseFaceTrackingReturn {
  status: FaceTrackingStatus;
  error: string | null;
  face: FaceState | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

interface RawLm {
  x: number;
  y: number;
  z?: number;
}

// Small subset of MediaPipe face mesh indices used to compute the
// 96-D identity signature. Picked to span eyes, nose, brow, and
// jaw — deliberately *avoiding* the mouth corners (which move a
// lot when the user smiles or talks) and the cheek soft-tissue
// (which changes with expression). Stable bony / cartilage
// landmarks only, so the resulting distance vector is dominated
// by skull geometry rather than facial mood.
const KEYPOINTS = [
  // Eyes — lid corners + inner/outer corners + iris-adjacent points.
  // These shift with blinks but the lid corners are anchored to the
  // skull and stay stable.
  33, 133, 159, 145, // right eye corners + lid centers
  362, 263, 386, 374, // left eye corners + lid centers
  // Eyebrows (peaks + inner corners) — relatively stable across
  // expressions; only "brow raise" moves them noticeably.
  70, 105, 107, 296, 334, 336,
  // Nose — bridge + tip + sides. Bony, very stable.
  1, 4, 6, 168, 197, 195, 5, 217, 437,
  // Jaw / chin / temples — bony skull geometry. Anchors the
  // overall face shape against expression noise.
  152, // chin
  234, 454, // temples (left/right)
  132, 361, // ears (lobes)
  172, 397, // jawline mid
  127, 356, // jaw outer
  10, // forehead center
  148, 377, // chin sides
];

/** Project the eye-line to horizontal so the resulting distance
 *  vector is invariant to head roll. Returns landmarks rotated
 *  about the midpoint of the two eye outer corners. */
function poseNormalize(lm: RawLm[]): RawLm[] {
  const right = lm[33];
  const left = lm[263];
  if (!right || !left) return lm;
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  const angle = Math.atan2(dy, dx);
  // No appreciable roll? Skip the rotation cost.
  if (Math.abs(angle) < 0.02) return lm;
  const cx = (right.x + left.x) / 2;
  const cy = (right.y + left.y) / 2;
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  return lm.map((p) => {
    const x = p.x - cx;
    const y = p.y - cy;
    return {
      x: x * cos - y * sin + cx,
      y: x * sin + y * cos + cy,
      z: p.z,
    };
  });
}

function buildIdentityVector(rawLm: RawLm[]): number[] {
  // Step 1 — rotate to canonical orientation so a tilted head
  // produces the same vector as an upright one. Removes the
  // single biggest source of false negatives.
  const lm = poseNormalize(rawLm);
  // Normalize against inter-eye distance so the signature is
  // scale-invariant (face closer / farther from camera doesn't
  // shift the vector).
  const left = lm[33];
  const right = lm[263];
  if (!left || !right) return new Array(96).fill(0);
  const eyeDist = Math.hypot(left.x - right.x, left.y - right.y);
  const denom = eyeDist > 1e-6 ? eyeDist : 1;
  const out: number[] = [];
  for (let i = 0; i < KEYPOINTS.length && out.length < 96; i++) {
    const a = lm[KEYPOINTS[i]];
    if (!a) continue;
    for (let j = i + 1; j < KEYPOINTS.length && out.length < 96; j++) {
      const b = lm[KEYPOINTS[j]];
      if (!b) continue;
      out.push(Math.hypot(a.x - b.x, a.y - b.y) / denom);
    }
  }
  while (out.length < 96) out.push(0);
  return out.slice(0, 96);
}

/** Exponential-moving-average smoothing for the 96-D identity
 *  vector. Reduces frame-to-frame jitter dramatically — without
 *  this the cosine similarity to an enrollment can wiggle
 *  ±0.03 per frame which causes the "glitchy / flickering match"
 *  the user reported. ``alpha`` of 0.7 keeps 70% of the previous
 *  smoothed value, blending in 30% of the fresh sample. */
const IDENTITY_EMA_ALPHA = 0.7;
function smoothIdentity(prev: number[] | null, fresh: number[]): number[] {
  if (!prev || prev.length !== fresh.length) return fresh;
  const out = new Array<number>(fresh.length);
  for (let i = 0; i < fresh.length; i++) {
    out[i] = prev[i] * IDENTITY_EMA_ALPHA + fresh[i] * (1 - IDENTITY_EMA_ALPHA);
  }
  return out;
}

export function useFaceTracking(
  opts: UseFaceTrackingOptions,
): UseFaceTrackingReturn {
  const { enabled, sharedStream, detectionIntervalMs = 50 } = opts;
  const [status, setStatus] = useState<FaceTrackingStatus>("off");
  const [error, setError] = useState<string | null>(null);
  const [face, setFace] = useState<FaceState | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const detectorRef = useRef<FaceLandmarker | null>(null);
  const ownStreamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastInferAt = useRef(0);
  // Persists the smoothed identity vector across frames so the
  // EMA can blend the fresh sample with the running average.
  // Reset to ``null`` every time we lose the face (so a new
  // person walking in starts from a clean slate, not a smear of
  // the previous person's geometry).
  const smoothedIdentityRef = useRef<number[] | null>(null);

  const teardown = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (ownStreamRef.current) {
      for (const t of ownStreamRef.current.getTracks()) t.stop();
      ownStreamRef.current = null;
    }
    const v = videoRef.current;
    if (v) {
      try {
        v.pause();
      } catch {
        /* ignore */
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
    setFace(null);
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
        const { FaceLandmarker, FilesetResolver } = await import(
          "@mediapipe/tasks-vision"
        );
        const fileset = await FilesetResolver.forVisionTasks(WASM_BASE_URL);
        const detector = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: FACE_MODEL_URL,
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: false,
        });
        if (cancelled) {
          detector.close();
          return;
        }
        detectorRef.current = detector;

        let stream: MediaStream;
        if (sharedStream) {
          stream = sharedStream;
        } else {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "user", width: 640, height: 480 },
            audio: false,
          });
          ownStreamRef.current = stream;
        }
        if (cancelled) {
          if (ownStreamRef.current) {
            for (const t of ownStreamRef.current.getTracks()) t.stop();
            ownStreamRef.current = null;
          }
          return;
        }

        const video = videoRef.current;
        if (!video) {
          throw new Error(
            "Face-tracking video element missing. Mount the hidden <video> from videoRef.",
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
            now - lastInferAt.current >= detectionIntervalMs
          ) {
            lastInferAt.current = now;
            try {
              const res = det.detectForVideo(v, now);
              processFrame(res);
            } catch {
              /* skip frame on error */
            }
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setStatus("error");
        setError(`Face tracking setup failed: ${msg}`);
        teardown();
      }
    })();

    function processFrame(res: {
      faceLandmarks?: RawLm[][];
      faceBlendshapes?: Array<{
        categories?: Array<{ categoryName?: string; score?: number }>;
      }>;
    }) {
      const lms = res.faceLandmarks?.[0];
      if (!lms || lms.length < 200) {
        smoothedIdentityRef.current = null;
        setFace(null);
        return;
      }
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Mirror x for selfie-view (camera is non-mirrored at the
      // hardware level, but the user expects "their" right side
      // on the right of the screen).
      const projected: FacePoint[] = lms.map((p) => ({
        x: (1 - p.x) * vw,
        y: p.y * vh,
        z: p.z,
      }));

      // Bounding box from extreme landmark positions.
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of projected) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      const bbox = {
        x: minX,
        y: minY,
        w: maxX - minX,
        h: maxY - minY,
      };

      // Blendshapes -> dictionary.
      const blendshapes: Record<string, number> = {};
      let dominant: BlendShape | null = null;
      const cats = res.faceBlendshapes?.[0]?.categories ?? [];
      for (const c of cats) {
        if (!c.categoryName || c.score === undefined) continue;
        // Skip the no-op "_neutral" category — it's almost always
        // dominant which makes "dominant expression" useless.
        if (c.categoryName === "_neutral") continue;
        blendshapes[c.categoryName] = c.score;
        if (!dominant || c.score > dominant.score) {
          dominant = { name: c.categoryName, score: c.score };
        }
      }

      const freshIdentity = buildIdentityVector(lms);
      const identityVector = smoothIdentity(
        smoothedIdentityRef.current,
        freshIdentity,
      );
      smoothedIdentityRef.current = identityVector;

      setFace({
        landmarks: projected,
        blendshapes,
        dominantExpression: dominant,
        identityVector,
        bbox,
      });
    }

    return () => {
      cancelled = true;
      teardown();
    };
  }, [enabled, sharedStream, detectionIntervalMs, teardown]);

  return useMemo(
    () => ({ status, error, face, videoRef }),
    [status, error, face],
  );
}
