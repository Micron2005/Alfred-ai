"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * In-browser camera + face detection.
 *
 * When ``enabled`` is true we ask for the user's webcam, attach the
 * stream to a hidden ``<video>`` and run MediaPipe's lightweight
 * ``FaceDetector`` on each animation frame. We expose:
 *   - the live ``faceCount`` (0, 1, 2…) for the chat header,
 *   - the current ``status`` so the UI can render a meaningful label,
 *   - a ``captureFrame`` fn that returns a JPEG snapshot the caller can
 *     attach to the next chat message (handed to the existing image
 *     vision pipeline).
 *
 * Detection runs entirely client-side via MediaPipe's WASM build. The
 * ``.task`` model file is bundled under
 * ``/public/mediapipe/models/blaze_face_short_range.tflite``; the WASM
 * runtime is loaded once from the official MediaPipe CDN — same blob
 * everyone uses, no user data ever crosses the wire.
 */

import type { FaceDetector } from "@mediapipe/tasks-vision";

// MediaPipe pins JS↔WASM offsets per release — the CDN URL must match the
// installed npm package exactly. Bumping the package without bumping this
// constant (or vice versa) will surface as nonsense detection results or
// cryptic ``Aborted()`` failures inside the WASM module.
const WASM_BASE_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm";
const FACE_MODEL_URL = "/mediapipe/models/blaze_face_short_range.tflite";

export type CameraStatus =
  | "off"
  | "starting"
  | "ready"
  | "error";

export interface CapturedFrame {
  /** JPEG bytes, base-64 encoded (no ``data:`` prefix). */
  data: string;
  /** Always ``image/jpeg`` for now — that's what the canvas exports. */
  mimeType: string;
  /** Number of faces visible in this frame. */
  faceCount: number;
}

export interface UseCameraOptions {
  enabled: boolean;
  /**
   * Hard cap on the inference frequency. MediaPipe is happy at 30 fps
   * but face count doesn't change that fast and we'd rather give the
   * CPU a break. ``200`` ms (5 fps) is plenty for presence-awareness.
   */
  detectionIntervalMs?: number;
}

export interface UseCameraReturn {
  status: CameraStatus;
  error: string | null;
  /** 0 if no faces, ``n`` if N faces are currently visible. */
  faceCount: number;
  /**
   * Refers to the hidden ``<video>`` the hook drives. Mount it offscreen
   * so React keeps it alive; do NOT add ``autoPlay`` — the hook calls
   * ``play()`` itself once the stream is attached.
   */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /**
   * Capture the most recent frame as a JPEG. Returns ``null`` if the
   * camera isn't ready (e.g. the user hasn't toggled it on yet).
   */
  captureFrame: () => Promise<CapturedFrame | null>;
}

export function useCamera(opts: UseCameraOptions): UseCameraReturn {
  const { enabled, detectionIntervalMs = 200 } = opts;

  const [status, setStatus] = useState<CameraStatus>("off");
  const [error, setError] = useState<string | null>(null);
  const [faceCount, setFaceCount] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<FaceDetector | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastInferAtRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

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
    setFaceCount(0);
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
        // Lazy-load MediaPipe so the ~1 MB JS bundle stays out of the
        // initial page load. Same pattern as ``useWakeWord``.
        const { FaceDetector, FilesetResolver } = await import(
          "@mediapipe/tasks-vision"
        );
        const fileset = await FilesetResolver.forVisionTasks(WASM_BASE_URL);
        const detector = await FaceDetector.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: FACE_MODEL_URL,
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          minDetectionConfidence: 0.5,
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
            "Camera video element missing. Mount the hidden <video> element from videoRef.",
          );
        }
        video.srcObject = stream;
        video.muted = true;
        await video.play();

        setStatus("ready");

        // RAF-driven detection loop. Throttle to detectionIntervalMs so
        // we don't burn battery on a CPU-only laptop. The detector's
        // ``detectForVideo`` is synchronous but cheap on the small face
        // model — under 5ms per call on a modern CPU.
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
              const n = res.detections?.length ?? 0;
              setFaceCount((prev) => (prev === n ? prev : n));
            } catch {
              // Single-frame failure (e.g. video pipe stutter) is not
              // fatal; just skip the frame.
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
            "Camera permission denied. Allow camera access in your browser, then toggle the camera off and on.",
          );
        } else if (lower.includes("notfound") || lower.includes("not found")) {
          setError(
            "No camera found. Plug one in (or ensure your laptop's built-in webcam isn't disabled), then toggle the camera off and on.",
          );
        } else {
          setError(`Camera setup failed: ${msg}`);
        }
        teardown();
      }
    })();

    return () => {
      cancelled = true;
      teardown();
    };
  }, [enabled, detectionIntervalMs, teardown]);

  const captureFrame = useCallback(async (): Promise<CapturedFrame | null> => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return null;
    let canvas = canvasRef.current;
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvasRef.current = canvas;
    }
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob: Blob | null = await new Promise((resolve) => {
      canvas!.toBlob((b) => resolve(b), "image/jpeg", 0.85);
    });
    if (!blob) return null;
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    // Build the base-64 input in 32-KB chunks; passing a giant Uint8Array
    // through ``String.fromCharCode(...arr)`` overflows the call-stack on
    // larger frames.
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    const data = btoa(binary);
    return {
      data,
      mimeType: "image/jpeg",
      faceCount,
    };
  }, [faceCount]);

  return useMemo(
    () => ({ status, error, faceCount, videoRef, captureFrame }),
    [status, error, faceCount, captureFrame],
  );
}
