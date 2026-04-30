/**
 * Tiny synthetic "I'm listening" cue played the instant the wake
 * word fires.
 *
 * Why a beep and not TTS?
 *   - TTS round-trips to the backend and can take 600 ms+ to start
 *     playing. By that point the user has already started talking
 *     to Alfred and the first half of their utterance gets eaten by
 *     the cue.
 *   - A pre-defined oscillator chord is instant (≤ 1 audio frame)
 *     and gives an unambiguous "go ahead, I'm hot" signal that's
 *     consistent with the JARVIS HUD aesthetic.
 *
 * Implementation notes:
 *   - Uses a fresh, short-lived AudioContext each call. Browsers
 *     limit how many AudioContexts can stay open simultaneously,
 *     and we already hold one for the silence detector during
 *     recording, so we close this one as soon as the cue finishes.
 *   - The cue is a two-note ping (E5 → A5) shaped by an exponential
 *     gain ramp so it sounds clean rather than clicky.
 *   - All errors are swallowed — the beep is a nice-to-have, not a
 *     blocker. If audio output is unavailable the wake-word flow
 *     must still proceed to startVoice().
 */

export async function playWakeCue(): Promise<void> {
  if (typeof window === "undefined") return;
  const Ctor =
    typeof AudioContext !== "undefined"
      ? AudioContext
      : (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
  if (!Ctor) return;

  let ctx: AudioContext;
  try {
    ctx = new Ctor();
  } catch {
    return;
  }

  try {
    // Some browsers (Safari, recent Chrome with autoplay policy) start
    // the AudioContext suspended until a user gesture. The wake-word
    // detection itself counts as user-initiated audio, but resuming is
    // cheap belt-and-braces.
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        /* ignore — we'll try to schedule anyway */
      }
    }

    const now = ctx.currentTime;
    const master = ctx.createGain();
    // Keep this WELL below 1.0 — the wake cue should be a soft
    // confirmation, not a startle. 0.18 is a comfortable indoor
    // level on stock laptop speakers.
    master.gain.value = 0.0;
    master.connect(ctx.destination);

    // Note 1 — E5 (659.25 Hz)
    const osc1 = ctx.createOscillator();
    osc1.type = "sine";
    osc1.frequency.value = 659.25;
    osc1.connect(master);
    osc1.start(now);
    osc1.stop(now + 0.18);

    // Note 2 — A5 (880 Hz), starts halfway through note 1
    const osc2 = ctx.createOscillator();
    osc2.type = "sine";
    osc2.frequency.value = 880;
    osc2.connect(master);
    osc2.start(now + 0.09);
    osc2.stop(now + 0.28);

    // Envelope: instant attack to 0.18, exponential decay to silence.
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.18, now + 0.01);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);

    // Close the context once the cue is done playing so we don't
    // accumulate AudioContexts on rapid wake-word retries. Browsers
    // cap at 4-6 simultaneous contexts.
    window.setTimeout(() => {
      void ctx.close().catch(() => {
        /* already closed */
      });
    }, 350);
  } catch {
    void ctx.close().catch(() => {});
  }
}
