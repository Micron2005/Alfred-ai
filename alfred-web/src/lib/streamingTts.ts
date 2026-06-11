/**
 * streamingTts — split a long reply into sentences, fire TTS requests
 * in parallel, and queue the resulting audio for sequential playback.
 *
 * Why bother?
 *   - Today's flow: synthesizeSpeech(fullText) → wait for all of it to
 *     synthesize → start playing. For a 4-sentence reply that's
 *     ~2-3s of "Alfred is silent" before he starts talking.
 *   - Streaming flow: split into sentences, fire TTS requests in
 *     parallel, start playing the FIRST sentence the instant its
 *     audio lands (~300-500 ms). Later sentences are still
 *     synthesizing in the background; by the time the first sentence
 *     finishes, the second is usually already done.
 *
 * This is independent of LLM streaming — Alfred could already have a
 * full reply and we'd still benefit from the parallel TTS pipelining.
 * If we later add LLM streaming we'd feed sentences into this as they
 * arrive instead of all at once.
 *
 * Returned controller:
 *   - ``play()`` resolves when the LAST chunk finishes.
 *   - ``stop()`` aborts everything (cancels in-flight TTS, stops
 *     the currently-playing audio, drops the queue).
 *   - ``onChunkPlay(audio)`` fires once per chunk, the moment that
 *     chunk's audio element starts playing. Caller uses this to
 *     hook the analyser for the orb pulse — the analyser is created
 *     fresh per chunk because connecting an HTMLAudioElement to one
 *     analyser only works once per element.
 */

import { synthesizeSpeech } from "@/lib/api";

interface StreamingTtsOpts {
  text: string;
  /** Hooks the AudioContext + analyser to each chunk's audio element
   *  so the orb pulses while THIS chunk plays. Returns a teardown
   *  the controller will call before the next chunk starts. */
  onChunkPlay?: (audio: HTMLAudioElement) => () => void;
  /** Called once after the LAST chunk's onended fires. */
  onAllDone?: () => void;
  /** Called if a chunk errors during playback. The remaining queue
   *  is drained — the user gets a partial reply rather than complete
   *  silence. */
  onChunkError?: (e: unknown) => void;
}

export interface StreamingTtsController {
  /** Start playback. Resolves when the last chunk ends or a fatal
   *  error stops the pipeline. */
  play: () => Promise<void>;
  /** Abort everything in flight + currently playing. Idempotent. */
  stop: () => void;
}

/**
 * Split text into sentence-shaped chunks at ., !, ? boundaries,
 * preserving the trailing punctuation so each chunk reads naturally
 * when synthesised in isolation.
 *
 * Edge cases:
 *   - Decimal numbers ("3.14") shouldn't split. The regex demands a
 *     space (or end-of-string) after the punctuation.
 *   - Ellipses ("…" or "...") count as one boundary, not three.
 *   - Very short trailing fragments (< 6 chars, e.g. "Sir.") get
 *     merged onto the previous chunk so we don't bother synthesizing
 *     a single-word audio file.
 */
export function splitIntoSentences(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  // Split BEFORE consuming whitespace, so the punctuation stays with
  // the preceding chunk.
  const raw = trimmed.split(/(?<=[.!?…])\s+(?=[A-Z(\["'])/);
  const out: string[] = [];
  for (const piece of raw) {
    const clean = piece.trim();
    if (!clean) continue;
    // Merge tiny tail fragments onto the previous chunk.
    if (clean.length < 6 && out.length > 0) {
      out[out.length - 1] = `${out[out.length - 1]} ${clean}`;
      continue;
    }
    out.push(clean);
  }
  return out;
}

export function streamingSpeak(opts: StreamingTtsOpts): StreamingTtsController {
  let stopped = false;
  let currentAudio: HTMLAudioElement | null = null;
  let currentTeardown: (() => void) | null = null;
  let resolveOuter: (() => void) | null = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (currentTeardown) {
      try {
        currentTeardown();
      } catch {
        /* ignore */
      }
      currentTeardown = null;
    }
    if (currentAudio) {
      try {
        currentAudio.pause();
        currentAudio.src = "";
      } catch {
        /* ignore */
      }
      currentAudio = null;
    }
    resolveOuter?.();
  };

  const play = async () => {
    return new Promise<void>((resolve) => {
      resolveOuter = resolve;
      const sentences = splitIntoSentences(opts.text);
      if (sentences.length === 0) {
        resolve();
        return;
      }

      // Fire ALL TTS requests in parallel — each one returns a
      // promise we'll await in order during playback. The async
      // gap between "received" and "played" is what saves us
      // perceived latency. Each blob is synthesised independently
      // so a slow one doesn't stall the queue beyond its own play
      // duration.
      const blobPromises: Promise<Blob>[] = sentences.map((s) =>
        synthesizeSpeech(s),
      );

      const playNext = async (index: number): Promise<void> => {
        if (stopped) return;
        if (index >= blobPromises.length) {
          opts.onAllDone?.();
          resolve();
          return;
        }
        let blob: Blob;
        try {
          blob = await blobPromises[index];
        } catch (e) {
          // One sentence failed to synthesize. Skip it; play the
          // rest. The user gets a slightly choppy reply instead of
          // total silence.
          opts.onChunkError?.(e);
          return playNext(index + 1);
        }
        if (stopped) return;

        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        // Hook the analyser before play() so the orb's first frame
        // already has signal. Caller's teardown is called when this
        // chunk ends so the next chunk can take ownership of the
        // AudioContext cleanly.
        const teardown = opts.onChunkPlay?.(audio);
        currentAudio = audio;
        currentTeardown = teardown ?? null;

        const cleanup = () => {
          URL.revokeObjectURL(url);
          if (teardown) {
            try {
              teardown();
            } catch {
              /* ignore */
            }
          }
          currentAudio = null;
          currentTeardown = null;
        };

        audio.onended = () => {
          cleanup();
          void playNext(index + 1);
        };
        audio.onerror = () => {
          cleanup();
          opts.onChunkError?.(new Error("audio playback error"));
          void playNext(index + 1);
        };
        try {
          await audio.play();
        } catch (e) {
          // Autoplay can be blocked the first time on iOS Safari.
          cleanup();
          opts.onChunkError?.(e);
          void playNext(index + 1);
        }
      };

      void playNext(0);
    });
  };

  return { play, stop };
}
