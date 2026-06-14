"use client";

/**
 * In-browser body pose tracking via MediaPipe PoseLandmarker.
 *
 * Detects 33 body landmarks (head, shoulders, elbows, wrists,
 * hips, knees, ankles, hands) at ~30 fps client-side. Used for
 * the workout / martial-arts form coach.
 *
 * Beyond the raw landmarks, this hook computes named joint angles
 * (left/right elbow, knee, hip, shoulder) so the form-analysis
 * code doesn't have to re-derive them on every frame. Angles are
 * in DEGREES (0..180), where 180 = fully extended limb.
 *
 * Like ``useFaceTracking``, this hook can share an existing camera
 * stream (so we don't fight with ``useCamera`` over the device).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PoseLandmarker } from "@mediapipe/tasks-vision";

const WASM_BASE_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm";
const POSE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

export type PoseTrackingStatus = "off" | "starting" | "ready" | "error";

export interface PosePoint {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
}

// MediaPipe BlazePose landmark indices, named for legibility.
// Reference:
// https://developers.google.com/mediapipe/solutions/vision/pose_landmarker
export const POSE_LM = {
  NOSE: 0,
  LEFT_EYE: 2,
  RIGHT_EYE: 5,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_FOOT: 31,
  RIGHT_FOOT: 32,
} as const;

/** Map of joint name -> angle in degrees (0..180). */
export interface JointAngles {
  leftElbow: number;
  rightElbow: number;
  leftKnee: number;
  rightKnee: number;
  leftHip: number;
  rightHip: number;
  leftShoulder: number;
  rightShoulder: number;
  /** Stance width — pixel distance between ankles, normalized by
   *  shoulder width. >1.0 means feet wider than shoulders. */
  stanceRatio: number;
  /** Torso lean from vertical, in degrees. 0 = upright. */
  torsoLean: number;
}

export interface PoseState {
  /** All 33 landmarks projected to viewport pixels. */
  landmarks: PosePoint[];
  /** Pre-computed joint angles in degrees. */
  angles: JointAngles;
}

export interface UsePoseTrackingOptions {
  enabled: boolean;
  sharedStream?: MediaStream | null;
  detectionIntervalMs?: number;
}

export interface UsePoseTrackingReturn {
  status: PoseTrackingStatus;
  error: string | null;
  pose: PoseState | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

interface RawPoint {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
}

/**
 * Compute the angle ABC (vertex at B), in degrees, in 2D.
 * Returns 0..180. Returns 0 if any point is missing.
 */
function angleAt(a: RawPoint, b: RawPoint, c: RawPoint): number {
  const v1x = a.x - b.x;
  const v1y = a.y - b.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const dot = v1x * v2x + v1y * v2y;
  const m1 = Math.hypot(v1x, v1y);
  const m2 = Math.hypot(v2x, v2y);
  if (m1 < 1e-6 || m2 < 1e-6) return 0;
  const cos = Math.max(-1, Math.min(1, dot / (m1 * m2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

function computeAngles(lm: RawPoint[]): JointAngles {
  const get = (i: number) => lm[i];
  const ls = get(POSE_LM.LEFT_SHOULDER);
  const rs = get(POSE_LM.RIGHT_SHOULDER);
  const lh = get(POSE_LM.LEFT_HIP);
  const rh = get(POSE_LM.RIGHT_HIP);
  const lk = get(POSE_LM.LEFT_KNEE);
  const rk = get(POSE_LM.RIGHT_KNEE);
  const la = get(POSE_LM.LEFT_ANKLE);
  const ra = get(POSE_LM.RIGHT_ANKLE);
  const le = get(POSE_LM.LEFT_ELBOW);
  const re = get(POSE_LM.RIGHT_ELBOW);
  const lw = get(POSE_LM.LEFT_WRIST);
  const rw = get(POSE_LM.RIGHT_WRIST);

  const stanceRatio =
    la && ra && ls && rs
      ? Math.hypot(la.x - ra.x, la.y - ra.y) /
        Math.max(0.001, Math.hypot(ls.x - rs.x, ls.y - rs.y))
      : 0;

  // Torso lean: angle between the shoulder-midpoint -> hip-midpoint
  // line and vertical. 0 deg = upright, 90 deg = lying down.
  let torsoLean = 0;
  if (ls && rs && lh && rh) {
    const sx = (ls.x + rs.x) / 2;
    const sy = (ls.y + rs.y) / 2;
    const hx = (lh.x + rh.x) / 2;
    const hy = (lh.y + rh.y) / 2;
    const dx = sx - hx;
    const dy = sy - hy;
    // Up-vector is (0, -1) in screen space.
    const angle = Math.atan2(Math.abs(dx), Math.abs(dy)) * (180 / Math.PI);
    torsoLean = angle;
  }

  return {
    leftElbow: ls && le && lw ? angleAt(ls, le, lw) : 0,
    rightElbow: rs && re && rw ? angleAt(rs, re, rw) : 0,
    leftKnee: lh && lk && la ? angleAt(lh, lk, la) : 0,
    rightKnee: rh && rk && ra ? angleAt(rh, rk, ra) : 0,
    leftHip: ls && lh && lk ? angleAt(ls, lh, lk) : 0,
    rightHip: rs && rh && rk ? angleAt(rs, rh, rk) : 0,
    leftShoulder: lh && ls && le ? angleAt(lh, ls, le) : 0,
    rightShoulder: rh && rs && re ? angleAt(rh, rs, re) : 0,
    stanceRatio,
    torsoLean,
  };
}

export function usePoseTracking(
  opts: UsePoseTrackingOptions,
): UsePoseTrackingReturn {
  const { enabled, sharedStream, detectionIntervalMs = 50 } = opts;
  const [status, setStatus] = useState<PoseTrackingStatus>("off");
  const [error, setError] = useState<string | null>(null);
  const [pose, setPose] = useState<PoseState | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const detectorRef = useRef<PoseLandmarker | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastInferAt = useRef(0);

  const teardown = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
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
    setPose(null);
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
        // Pose tracking now ALWAYS rides on the shared camera stream
        // owned by useCamera — see the equivalent comment in
        // ``useFaceTracking`` for the rationale.
        if (!sharedStream) {
          setStatus("off");
          return;
        }
        const { PoseLandmarker, FilesetResolver } = await import(
          "@mediapipe/tasks-vision"
        );
        const fileset = await FilesetResolver.forVisionTasks(WASM_BASE_URL);
        const detector = await PoseLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: POSE_MODEL_URL,
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
        if (cancelled) {
          detector.close();
          return;
        }
        detectorRef.current = detector;

        const video = videoRef.current;
        if (!video) {
          throw new Error(
            "Pose-tracking video element missing. Mount the hidden <video> from videoRef.",
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
            now - lastInferAt.current >= detectionIntervalMs
          ) {
            lastInferAt.current = now;
            try {
              const res = det.detectForVideo(v, now);
              processFrame(res);
            } catch {
              /* skip frame */
            }
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setStatus("error");
        setError(`Pose tracking setup failed: ${msg}`);
        teardown();
      }
    })();

    function processFrame(res: { landmarks?: RawPoint[][] }) {
      const lms = res.landmarks?.[0];
      if (!lms || lms.length < 33) {
        setPose(null);
        return;
      }
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Mirror x to match selfie-view convention.
      const projected: PosePoint[] = lms.map((p) => ({
        x: (1 - p.x) * vw,
        y: p.y * vh,
        z: p.z,
        visibility: p.visibility,
      }));
      const angles = computeAngles(projected);
      setPose({ landmarks: projected, angles });
    }

    return () => {
      cancelled = true;
      teardown();
    };
  }, [enabled, sharedStream, detectionIntervalMs, teardown]);

  return useMemo(
    () => ({ status, error, pose, videoRef }),
    [status, error, pose],
  );
}
