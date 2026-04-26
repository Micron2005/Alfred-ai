"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PorcupineWorker } from "@picovoice/porcupine-web";
import type { WebVoiceProcessor } from "@picovoice/web-voice-processor";

/**
 * Hands-free wake-word detection via Picovoice Porcupine in the browser.
 *
 * Detection runs entirely client-side — Porcupine ships a WASM blob that
 * processes microphone frames locally, so audio never leaves the page.
 * Only the AccessKey itself is verified online (a one-time activation
 * check by Picovoice).
 *
 * The hook:
 *  - keeps a single PorcupineWorker + WebVoiceProcessor instance alive
 *    while ``enabled`` is true
 *  - calls ``onWake`` whenever the configured wake word fires
 *  - reports lifecycle errors via ``error``
 *  - exposes ``pause`` / ``resume`` so callers can stop listening while
 *    the existing voice-recording flow has the mic, then resume
 *
 * The Porcupine + WebVoiceProcessor packages are loaded dynamically the
 * first time the hook starts so they don't end up in the SSR bundle.
 */
export interface UseWakeWordOptions {
  /** Whether the user has turned on hands-free mode. */
  enabled: boolean;
  /**
   * Built-in Porcupine keyword to listen for (case-sensitive label).
   * Defaults to "Jarvis" — the closest built-in to "Hey Alfred".
   */
  keyword?: string;
  /** Callback fired on wake-word detection. */
  onWake: () => void;
  /**
   * Picovoice AccessKey from https://console.picovoice.ai/. Required.
   * Without it the hook reports an error and stays idle.
   */
  accessKey: string;
  /**
   * Public path to the Porcupine model parameters file. Defaults to
   * ``/porcupine_params.pv`` which is what ``alfred-web`` ships.
   */
  modelPath?: string;
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

type WebVoiceProcessorStatic = typeof WebVoiceProcessor;

export function useWakeWord(opts: UseWakeWordOptions): UseWakeWordReturn {
  const { enabled, keyword = "Jarvis", onWake, accessKey, modelPath = "/porcupine_params.pv" } = opts;

  const [status, setStatus] = useState<WakeStatus>("off");
  const [error, setError] = useState<string | null>(null);

  // Mirror of onWake so the engine's detection callback always invokes
  // the latest version even though we set it up exactly once per
  // listening session.
  const onWakeRef = useRef(onWake);
  onWakeRef.current = onWake;

  // Live engine + audio-pipeline handles. Held outside React state so
  // we can release them imperatively from cleanup paths.
  const porcupineRef = useRef<PorcupineWorker | null>(null);
  const wvpRef = useRef<WebVoiceProcessorStatic | null>(null);
  const pausedRef = useRef(false);

  const teardown = useCallback(async () => {
    const porcupine = porcupineRef.current;
    const wvp = wvpRef.current;
    porcupineRef.current = null;
    wvpRef.current = null;
    pausedRef.current = false;
    if (porcupine && wvp) {
      try {
        await wvp.unsubscribe(porcupine);
      } catch {
        /* the page may be tearing down — ignore */
      }
    }
    if (porcupine) {
      try {
        await porcupine.release();
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

    if (!accessKey || !accessKey.trim()) {
      setStatus("error");
      setError(
        "Wake-word requires a Picovoice AccessKey. Set NEXT_PUBLIC_PICOVOICE_ACCESS_KEY in .env (free at console.picovoice.ai) and rebuild alfred-web.",
      );
      return;
    }

    let cancelled = false;
    setStatus("starting");
    setError(null);

    void (async () => {
      try {
        // Lazy-load so SSR + initial bundle stay slim. The Porcupine
        // package ships its own Worker and WASM under the hood.
        const [{ PorcupineWorker, BuiltInKeyword }, wvpModule] = await Promise.all([
          import("@picovoice/porcupine-web"),
          import("@picovoice/web-voice-processor"),
        ]);
        const { WebVoiceProcessor } = wvpModule;

        // Map the user-friendly label to the BuiltInKeyword enum value.
        // Keys on the enum are PascalCase (e.g. "Jarvis", "HeyGoogle").
        type BuiltInKeywordEnum = typeof BuiltInKeyword;
        type BuiltInKey = keyof BuiltInKeywordEnum;
        const requested = keyword.replace(/\s+/g, "") as BuiltInKey;
        const builtin =
          BuiltInKeyword[requested] ??
          (Object.values(BuiltInKeyword).find((v) => v === keyword) as
            | BuiltInKeywordEnum[BuiltInKey]
            | undefined);
        if (!builtin) {
          throw new Error(
            `Unknown built-in wake word "${keyword}". Pick one of: ` +
              Object.values(BuiltInKeyword).join(", "),
          );
        }

        const porcupine = await PorcupineWorker.create(
          accessKey.trim(),
          [{ builtin, sensitivity: 0.5 }],
          () => {
            if (pausedRef.current) return;
            try {
              onWakeRef.current();
            } catch {
              /* swallow — caller mistakes shouldn't kill the engine */
            }
          },
          { publicPath: modelPath },
        );
        if (cancelled) {
          await porcupine.release();
          return;
        }

        await WebVoiceProcessor.subscribe(porcupine);
        if (cancelled) {
          await WebVoiceProcessor.unsubscribe(porcupine);
          await porcupine.release();
          return;
        }

        porcupineRef.current = porcupine;
        wvpRef.current = WebVoiceProcessor;
        setStatus("listening");
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error
            ? `Wake-word couldn't start: ${err.message}`
            : "Wake-word couldn't start.",
        );
        setStatus("error");
        await teardown();
      }
    })();

    return () => {
      cancelled = true;
      void teardown();
    };
  }, [enabled, accessKey, keyword, modelPath, teardown]);

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
