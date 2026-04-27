/**
 * Silence-based auto-stop for the chat composer's microphone recorder.
 *
 * The wake-word flow already lets the user start a message hands-free,
 * but until now they still had to click the red "stop" button to end
 * recording. This module monitors the live audio level via an
 * ``AnalyserNode`` and signals the caller when the mic has gone quiet
 * for long enough that we should stop recording on its behalf.
 *
 * Design notes:
 *   - We share the ``MediaStream`` the caller already opened — no second
 *     ``getUserMedia`` call, so there's no second permission prompt and
 *     no chance of grabbing a different device than the one MediaRecorder
 *     is reading from.
 *   - We use ``AnalyserNode.getFloatTimeDomainData`` for RMS so the
 *     threshold is measured against actual sample amplitude rather than
 *     the FFT-bin "loudness" you get from getByteFrequencyData. This
 *     makes the threshold predictable across browsers.
 *   - We keep a small state machine: we ignore silence in the first
 *     ``warmupMs`` so a wake-word firing immediately followed by a beat
 *     of dead air doesn't cause an instant stop, then we require having
 *     heard *some* speech (peak above threshold) before treating any
 *     trailing silence as "user is done". A hard ``maxDurationMs`` cap
 *     guarantees the recorder always terminates even if the mic is
 *     stuck.
 */

export interface SilenceDetectorOptions {
  /**
   * The live ``MediaStream`` from ``getUserMedia``. Must contain at
   * least one audio track. The detector creates an ``AudioContext``
   * and a ``MediaStreamAudioSourceNode`` against this stream; it does
   * NOT close the stream itself — the recorder owns that lifecycle.
   */
  stream: MediaStream;
  /** Called once when silence has been detected long enough to stop. */
  onSilence: (reason: SilenceReason) => void;
  /**
   * Optional: called every poll interval with the current RMS level
   * (0..1). Lets a UI component (e.g. the JARVIS orb) react to mic
   * amplitude without standing up its own AnalyserNode and racing
   * for the same MediaStream. Cheap — just a function call per poll.
   */
  onLevel?: (rms: number) => void;
  /**
   * RMS amplitude (0..1) below which a frame is considered silent.
   * Empirically ~0.012-0.020 for built-in laptop mics in a quiet room;
   * default 0.015 works well across the laptops we've tested on.
   */
  silenceThreshold?: number;
  /**
   * Initial grace window during which we never auto-stop, regardless
   * of audio level. Gives the user time to start speaking after the
   * wake word fires.
   */
  warmupMs?: number;
  /**
   * After we've heard speech, how long of continuous silence is needed
   * before we declare the user done.
   */
  trailingSilenceMs?: number;
  /**
   * If we never hear any speech at all, give up after this long and
   * stop with reason ``"no_speech"``. Generous so a slow-to-start
   * user isn't cut off, but bounded so a muted mic doesn't waste 30s.
   */
  noSpeechTimeoutMs?: number;
  /**
   * Hard ceiling on total recording duration. Always wins.
   */
  maxDurationMs?: number;
  /** How often we sample the analyser. 50 ms is plenty; default is fine. */
  pollIntervalMs?: number;
}

export type SilenceReason =
  | "trailing_silence" // user spoke, then stopped
  | "no_speech" //       user never spoke, gave up waiting
  | "max_duration"; //   hit the safety cap

export interface SilenceDetectorHandle {
  /** Tear down the AudioContext + interval and stop monitoring. */
  stop: () => void;
}

/**
 * Begin monitoring the given stream for silence. Returns a handle the
 * caller MUST call ``stop()`` on once recording ends, otherwise the
 * AudioContext leaks across recordings.
 */
export function startSilenceDetector(
  opts: SilenceDetectorOptions,
): SilenceDetectorHandle {
  const {
    stream,
    onSilence,
    onLevel,
    silenceThreshold = 0.015,
    warmupMs = 500,
    trailingSilenceMs = 1500,
    noSpeechTimeoutMs = 10000,
    maxDurationMs = 30000,
    pollIntervalMs = 50,
  } = opts;

  // Some older Safari builds expose ``webkitAudioContext`` instead of
  // the standardised ``AudioContext``. We don't bother with a polyfill;
  // the rest of this app uses modern Web APIs anyway.
  const ctxCtor =
    typeof AudioContext !== "undefined" ? AudioContext : undefined;
  if (!ctxCtor) {
    // Fail open — if the browser can't measure audio levels, the user
    // simply has to click stop manually as before.
    return { stop: () => {} };
  }
  const ctx = new ctxCtor();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);
  // Note: we deliberately do NOT connect the analyser to ctx.destination
  // — that would echo the user's mic back through the speakers.

  const buf = new Float32Array(analyser.fftSize);
  const startedAt = performance.now();
  let lastSpeechAt: number | null = null;
  let stopped = false;

  function teardown() {
    if (stopped) return;
    stopped = true;
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    try {
      source.disconnect();
    } catch {
      /* already disconnected */
    }
    void ctx.close().catch(() => {
      /* already closed */
    });
  }

  function fire(reason: SilenceReason) {
    if (stopped) return;
    teardown();
    onSilence(reason);
  }

  let intervalId: ReturnType<typeof setInterval> | null = setInterval(() => {
    if (stopped) return;

    analyser.getFloatTimeDomainData(buf);
    let sumSquares = 0;
    for (let i = 0; i < buf.length; i++) {
      sumSquares += buf[i] * buf[i];
    }
    const rms = Math.sqrt(sumSquares / buf.length);
    if (onLevel) onLevel(rms);
    const elapsed = performance.now() - startedAt;

    // Hard cap always wins.
    if (elapsed >= maxDurationMs) {
      fire("max_duration");
      return;
    }

    // Warmup: ignore silence (and don't reset speech tracker either —
    // we just don't act on it yet).
    if (elapsed < warmupMs) return;

    if (rms > silenceThreshold) {
      lastSpeechAt = performance.now();
      return;
    }

    if (lastSpeechAt === null) {
      // Never heard speech yet — only give up after the no-speech timeout.
      if (elapsed >= noSpeechTimeoutMs) fire("no_speech");
      return;
    }

    // We've heard speech; check trailing silence.
    if (performance.now() - lastSpeechAt >= trailingSilenceMs) {
      fire("trailing_silence");
    }
  }, pollIntervalMs);

  return { stop: teardown };
}
