"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Hands-free wake-word detection via openWakeWord in the browser.
 *
 * Detection runs entirely client-side. We use the
 * `openwakeword-wasm-browser` package, which loads small ONNX models
 * (mel spectrogram + embedding + Silero VAD + a per-keyword classifier)
 * and runs them through `onnxruntime-web` against the live mic frames.
 * Audio never leaves the page; no API key, no signup, no remote calls.
 *
 * The hook:
 *  - keeps a single `WakeWordEngine` alive while ``enabled`` is true
 *  - calls ``onWake`` whenever the configured wake word fires
 *  - reports lifecycle errors via ``error``
 *  - exposes ``pause`` / ``resume`` so callers can stop listening while
 *    the existing voice-recording flow has the mic, then resume
 *
 * The engine is loaded dynamically the first time the hook starts so
 * onnxruntime-web's bundle stays out of SSR + initial page load.
 */

/**
 * Wake-word keyword → ONNX model filename map. Files live under
 * ``/public/openwakeword/models/`` and are served as static assets.
 *
 * - ``hey_alfred`` is a community-trained model from
 *   https://github.com/The-Blackstone/HeyAlfredWakeWord (originally a
 *   .tflite for Wyoming, converted to ONNX with `tf2onnx`). Same
 *   [1, 16, 96] embedding-window architecture as the official models.
 * - The other five are the official pre-trained models from
 *   https://github.com/dscripka/openWakeWord, bundled by the
 *   ``openwakeword-wasm-browser`` package.
 */
export const KEYWORD_MODEL_FILES = {
  hey_alfred: "hey_alfred_v0.1.onnx",
  hey_jarvis: "hey_jarvis_v0.1.onnx",
  alexa: "alexa_v0.1.onnx",
  hey_mycroft: "hey_mycroft_v0.1.onnx",
  hey_rhasspy: "hey_rhasspy_v0.1.onnx",
  timer: "timer_v0.1.onnx",
  weather: "weather_v0.1.onnx",
} as const;

export type BuiltInKeyword = keyof typeof KEYWORD_MODEL_FILES;

export interface UseWakeWordOptions {
  /** Whether the user has turned on hands-free mode. */
  enabled: boolean;
  /**
   * openWakeWord keyword to listen for. Defaults to ``"hey_alfred"``.
   * Must be a key of ``KEYWORD_MODEL_FILES`` (or any other entry the
   * caller provides via ``modelFiles``).
   */
  keyword?: BuiltInKeyword | string;
  /**
   * Optional override for the keyword → filename map. Useful when the
   * caller drops in a custom ``my_alfred.onnx`` and wants to reference
   * it as ``my_alfred``. Merged on top of ``KEYWORD_MODEL_FILES``.
   */
  modelFiles?: Record<string, string>;
  /** Callback fired on wake-word detection. */
  onWake: () => void;
  /**
   * Public URL prefix where the ONNX model files live. Defaults to
   * ``/openwakeword/models`` which is what ``alfred-web`` ships.
   */
  baseAssetUrl?: string;
  /**
   * Detection threshold (0–1). Higher = fewer false positives, more
   * misses. The library default of 0.5 works well for hey_jarvis.
   */
  detectionThreshold?: number;
}

export type WakeStatus = "off" | "starting" | "listening" | "paused" | "error";

export interface UseWakeWordReturn {
  status: WakeStatus;
  error: string | null;
  /** Stop processing audio (mic released) without unloading the engine. */
  pause: () => void;
  /** Resume processing audio after a pause. */
  resume: () => void;
}

// Minimal structural type for the engine — keeps us decoupled from the
// internal ``WakeWordEngine`` class while still type-safe at the call
// site. The real type comes from ``openwakeword-wasm-browser`` once the
// dynamic import resolves.
type DetectEvent = { keyword: string; score: number; at?: number };
interface WakeWordEngineLike {
  load(): Promise<void>;
  start(opts?: { deviceId?: string; gain?: number }): Promise<void>;
  stop(): Promise<void>;
  on(
    event: "detect" | "ready" | "speech-start" | "speech-end" | "error",
    handler: (payload: DetectEvent | unknown) => void,
  ): () => void;
}

export function useWakeWord(opts: UseWakeWordOptions): UseWakeWordReturn {
  const {
    enabled,
    keyword = "hey_alfred",
    onWake,
    baseAssetUrl = "/openwakeword/models",
    detectionThreshold = 0.5,
    modelFiles,
  } = opts;

  const [status, setStatus] = useState<WakeStatus>("off");
  const [error, setError] = useState<string | null>(null);

  // Mirror of onWake so the engine's detection callback always invokes
  // the latest version even though we set it up exactly once per
  // listening session.
  const onWakeRef = useRef(onWake);
  onWakeRef.current = onWake;

  // Live engine handle + paused flag. Held outside React state so we
  // can release them imperatively from cleanup paths.
  const engineRef = useRef<WakeWordEngineLike | null>(null);
  const pausedRef = useRef(false);
  const detachListenerRef = useRef<(() => void) | null>(null);

  const teardown = useCallback(async () => {
    const engine = engineRef.current;
    const detach = detachListenerRef.current;
    engineRef.current = null;
    detachListenerRef.current = null;
    pausedRef.current = false;
    if (detach) {
      try {
        detach();
      } catch {
        /* ignore — page tear-down */
      }
    }
    if (engine) {
      try {
        await engine.stop();
      } catch {
        /* same */
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus("off");
      setError(null);
      void teardown();
      return;
    }

    let cancelled = false;
    setStatus("starting");
    setError(null);

    void (async () => {
      try {
        // Lazy-load so onnxruntime-web doesn't end up in SSR or the
        // initial bundle.
        const mod = await import("openwakeword-wasm-browser");
        const WakeWordEngine = (
          mod as { default?: unknown; WakeWordEngine?: unknown }
        ).default ?? (mod as { WakeWordEngine?: unknown }).WakeWordEngine;
        if (typeof WakeWordEngine !== "function") {
          throw new Error("openwakeword-wasm-browser export shape changed");
        }
        const Engine = WakeWordEngine as new (
          opts: Record<string, unknown>,
        ) => WakeWordEngineLike;

        const engine = new Engine({
          baseAssetUrl,
          keywords: [keyword],
          // Merge the caller's overrides on top of the built-in map so
          // ``hey_alfred`` and any future custom keywords resolve to the
          // right ONNX file. The engine reads from this map when it
          // creates the per-keyword session.
          modelFiles: { ...KEYWORD_MODEL_FILES, ...(modelFiles ?? {}) },
          detectionThreshold,
          cooldownMs: 2000,
        });

        if (cancelled) {
          await engine.stop().catch(() => {});
          return;
        }

        const detach = engine.on("detect", (payload) => {
          if (pausedRef.current) return;
          const evt = payload as DetectEvent;
          if (evt && typeof evt.keyword === "string") {
            onWakeRef.current();
          }
        });

        await engine.load();
        if (cancelled) {
          detach();
          await engine.stop().catch(() => {});
          return;
        }

        await engine.start();
        if (cancelled) {
          detach();
          await engine.stop().catch(() => {});
          return;
        }

        engineRef.current = engine;
        detachListenerRef.current = detach;
        setStatus(pausedRef.current ? "paused" : "listening");
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setStatus("error");
        setError(
          msg.toLowerCase().includes("permission") ||
            msg.toLowerCase().includes("notallowed")
            ? "Microphone permission denied. Allow mic access in your browser, then toggle hands-free off and on."
            : `Wake-word setup failed: ${msg}`,
        );
      }
    })();

    return () => {
      cancelled = true;
      void teardown();
    };
    // ``modelFiles`` is intentionally omitted from deps: it's snapshotted
    // by the engine at construction and a re-mount is the wrong reaction
    // if the caller passes a fresh object literal each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, keyword, baseAssetUrl, detectionThreshold, teardown]);

  const pause = useCallback(() => {
    pausedRef.current = true;
    setStatus((s) => (s === "listening" ? "paused" : s));
  }, []);

  const resume = useCallback(() => {
    pausedRef.current = false;
    setStatus((s) => (s === "paused" ? "listening" : s));
  }, []);

  // Memoize the return so consumers can use it in effect dependency
  // arrays without re-firing on every render. ``pause`` and ``resume``
  // are already stable via ``useCallback([])`` so the identity here only
  // changes when ``status`` or ``error`` actually change.
  return useMemo(
    () => ({ status, error, pause, resume }),
    [status, error, pause, resume],
  );
}
