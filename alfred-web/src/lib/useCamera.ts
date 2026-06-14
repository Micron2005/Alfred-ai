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
   * The active ``MediaStream`` (or ``null`` if the camera isn't on).
   * Exposed so a visible preview ``<video>`` can attach the same
   * stream as ``srcObject`` without disturbing the hidden detection
   * pipeline. Multiple ``<video>`` elements can render the same
   * stream simultaneously.
   *
   * Kept around for backwards compat with CameraPreview, which
   * reads ``streamRef.current`` inside a status-gated effect.
   */
  streamRef: React.RefObject<MediaStream | null>;
  /**
   * Same stream, but exposed as React state — when it changes,
   * downstream hooks (useFaceTracking, usePoseTracking,
   * useHandTracking) re-render and can attach themselves to the
   * shared stream instead of grabbing the camera themselves.
   * Prefer this over ``streamRef.current`` for any consumer that
   * needs to *react* to the stream arriving.
   */
  stream: MediaStream | null;
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
  // ``stream`` is exposed as React state (not just a ref) so
  // downstream hooks — useFaceTracking, usePoseTracking — re-render
  // when it actually arrives. Before this, those hooks read
  // ``streamRef.current`` at first paint (always null) and went on
  // to claim the camera themselves, racing useCamera's getUserMedia
  // call and ending up with 3 separate MediaStreams fighting for
  // one device. The visible symptom was a black/blank camera tile
  // with no error banner — the user reported "camera light is on
  // in OS but Alfred shows nothing".
  const [stream, setStream] = useState<MediaStream | null>(null);

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
    setStream(null);
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
      let acquired: MediaStream | null = null;
      try {
        // Step 1 — acquire the camera. This is the only step that
        // can legitimately fail with a user-fixable error (permission,
        // device-in-use, missing camera). Everything past this point
        // (MediaPipe init, RAF detection loop, video.play()) is
        // best-effort and MUST NOT tear down the stream if it fails —
        // the user can still see themselves in the preview tile even
        // if face counting / GPU acceleration is broken.
        acquired = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: 640, height: 480 },
          audio: false,
        });
        if (cancelled) {
          for (const track of acquired.getTracks()) track.stop();
          return;
        }
        streamRef.current = acquired;
        setStream(acquired);

        // Step 2 — wire the stream to the hidden <video> the rest of
        // the app reads frames from. This MUST succeed for the visible
        // preview to render; if it fails, surface a real error.
        const video = videoRef.current;
        if (!video) {
          throw new Error(
            "Camera video element missing. Mount the hidden <video> element from videoRef.",
          );
        }
        video.srcObject = acquired;
        video.muted = true;
        try {
          await video.play();
        } catch (playErr) {
          // ``play()`` can reject with NotAllowedError if there hasn't
          // been a user gesture yet (rare in our flow — the user
          // clicked the CAM toggle, which counts), or AbortError if
          // the page navigates away mid-play. Neither is fatal for
          // the visible preview component (which has its own
          // ``play()`` call on srcObject change), so just log and
          // continue to ready.
          // eslint-disable-next-line no-console
          console.warn("[useCamera] hidden video.play() failed:", playErr);
        }

        // We're already showing the user themselves at this point —
        // flip to ready BEFORE the optional MediaPipe init, so the
        // tile is responsive even if the rest of the pipeline is
        // slow or fails.
        setStatus("ready");

        // Step 3 — MediaPipe FaceDetector for the face-count badge.
        // Best-effort: if WebGL is blocklisted (common in WSL /
        // remote desktop / older GPUs), CDN-hosted WASM can't load
        // (offline / firewall), or the model file is missing, we
        // simply skip the badge and leave faceCount at 0. The
        // camera itself stays online. Previously this whole block
        // was inside the outer try and a failure here tore down the
        // entire stream — same surface symptom as the camera
        // permission being denied, which is what the user was
        // hitting on the post-rebuild Windows install.
        try {
          const { FaceDetector, FilesetResolver } = await import(
            "@mediapipe/tasks-vision"
          );
          const fileset = await FilesetResolver.forVisionTasks(WASM_BASE_URL);
          let detector: FaceDetector;
          try {
            detector = await FaceDetector.createFromOptions(fileset, {
              baseOptions: {
                modelAssetPath: FACE_MODEL_URL,
                delegate: "GPU",
              },
              runningMode: "VIDEO",
              minDetectionConfidence: 0.5,
            });
          } catch (gpuErr) {
            // Fall back to CPU if GPU init blew up — Chromium
            // blocklists WebGL on a surprisingly long list of
            // driver/GPU combos, and the face count is too cheap
            // to be worth losing entirely over a delegate choice.
            // eslint-disable-next-line no-console
            console.warn(
              "[useCamera] FaceDetector GPU init failed, retrying on CPU:",
              gpuErr,
            );
            detector = await FaceDetector.createFromOptions(fileset, {
              baseOptions: {
                modelAssetPath: FACE_MODEL_URL,
                delegate: "CPU",
              },
              runningMode: "VIDEO",
              minDetectionConfidence: 0.5,
            });
          }
          if (cancelled) {
            detector.close();
            return;
          }
          detectorRef.current = detector;

          // RAF-driven detection loop. Throttle to detectionIntervalMs
          // so we don't burn battery on a CPU-only laptop. The
          // detector's ``detectForVideo`` is cheap (under 5 ms per
          // call on a modern CPU for the small face model).
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
                // Single-frame failure (e.g. video pipe stutter) is
                // not fatal; just skip the frame.
              }
            }
            rafRef.current = requestAnimationFrame(tick);
          };
          rafRef.current = requestAnimationFrame(tick);
        } catch (mpErr) {
          // eslint-disable-next-line no-console
          console.warn(
            "[useCamera] MediaPipe FaceDetector init failed — face count badge disabled, but the camera preview still works:",
            mpErr,
          );
          // Leave faceCount at 0; do NOT teardown.
        }
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setStatus("error");
        const lower = msg.toLowerCase();
        if (
          lower.includes("permission") ||
          lower.includes("notallowed") ||
          lower.includes("denied")
        ) {
          setError(
            "Camera permission denied. Allow camera access in your browser, then toggle the camera off and on.",
          );
        } else if (lower.includes("notfound") || lower.includes("not found")) {
          setError(
            "No camera found. Plug one in (or ensure your laptop's built-in webcam isn't disabled), then toggle the camera off and on.",
          );
        } else if (
          lower.includes("notreadable") ||
          lower.includes("could not start video source") ||
          lower.includes("in use")
        ) {
          setError(
            "Camera is in use by another app (Zoom, Teams, OBS, browser tab…). Close that app then toggle the camera off and on.",
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
    () => ({ status, error, faceCount, videoRef, streamRef, stream, captureFrame }),
    [status, error, faceCount, stream, captureFrame],
  );
}
