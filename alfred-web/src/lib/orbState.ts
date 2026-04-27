/**
 * Shared "what is the orb doing right now" store.
 *
 * The JARVIS-style center orb in the chat UI reflects four states:
 *
 *   idle      — nothing is happening; orb breathes gently on its own.
 *   listening — the user is dictating; orb pulses with mic RMS.
 *   thinking  — the model is composing a reply; orb spins faster.
 *   speaking  — TTS is playing; orb heartbeats with Alfred's voice
 *               amplitude (this is the effect Mukarram asked for).
 *
 * Multiple sources push state into the store:
 *   - Composer's silence detector publishes ``listening`` + RMS samples
 *     (re-using its existing AnalyserNode — no extra mic permission).
 *   - ChatWindow.speak() routes the TTS audio through a Web Audio
 *     analyser graph and publishes ``speaking`` + amplitude samples.
 *   - ChatWindow's ``busy`` flag publishes ``thinking``.
 *
 * The Orb component subscribes via ``useOrbState`` (useSyncExternalStore
 * under the hood) and re-renders on every level update at ~30 fps. We
 * deliberately do NOT route the level through React state for every
 * frame — instead the component reads it from a ref inside its own
 * requestAnimationFrame loop, with React state used only for the
 * coarse-grained ``mode`` transitions. Keeps re-render cost flat.
 */

export type OrbMode = "idle" | "listening" | "thinking" | "speaking";

interface OrbSnapshot {
  /** Current high-level state. */
  mode: OrbMode;
  /** Smoothed audio level, 0..1. Only meaningful when mode is
   *  "listening" or "speaking"; ignored otherwise. */
  level: number;
  /** Bumped on every state change so subscribers using
   *  useSyncExternalStore are notified. The level changes faster than
   *  React can re-render, so consumers sample ``getLevel()`` from a
   *  RAF loop instead of subscribing to it. */
  version: number;
}

type Listener = () => void;

const SMOOTHING = 0.35; // 0 = instant jump, 1 = never moves

class OrbStore {
  private snapshot: OrbSnapshot = { mode: "idle", level: 0, version: 0 };
  private listeners = new Set<Listener>();
  // Stack-style holds: a "thinking" overlay shouldn't lose the
  // underlying "listening" or "speaking" state if both happen at once
  // (which they shouldn't in practice, but defensive). We just track
  // who currently owns each non-idle role and resolve on read.
  private holds: Partial<Record<Exclude<OrbMode, "idle">, boolean>> = {};

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): OrbSnapshot => this.snapshot;

  /** Read the current smoothed level without subscribing. Cheap. */
  getLevel = (): number => this.snapshot.level;

  /** Read the current mode without subscribing. */
  getMode = (): OrbMode => this.snapshot.mode;

  /**
   * Set whether a given role is currently active. The resolved mode
   * is the highest-priority active role: speaking > listening >
   * thinking > idle. (Speaking wins over listening because if both
   * are somehow on, hearing Alfred matters more than animating user
   * input.) When the resolved mode changes we bump the version so
   * subscribers re-render; level updates do NOT bump version.
   */
  setHold(role: Exclude<OrbMode, "idle">, active: boolean) {
    if (this.holds[role] === active) return;
    this.holds[role] = active;
    const resolved = this.resolveMode();
    if (resolved !== this.snapshot.mode) {
      this.snapshot = {
        mode: resolved,
        level: 0,
        version: this.snapshot.version + 1,
      };
      for (const l of this.listeners) l();
    }
  }

  /**
   * Push a new amplitude sample (0..1). Smoothed exponentially with
   * the previous value so the orb doesn't jitter frame-to-frame on
   * loud transient peaks. Does NOT trigger a React re-render — the
   * Orb's own RAF loop reads ``getLevel`` directly each frame.
   */
  pushLevel(raw: number) {
    const clamped = Math.max(0, Math.min(1, raw));
    const blended =
      this.snapshot.level * SMOOTHING + clamped * (1 - SMOOTHING);
    this.snapshot = { ...this.snapshot, level: blended };
  }

  private resolveMode(): OrbMode {
    if (this.holds.speaking) return "speaking";
    if (this.holds.listening) return "listening";
    if (this.holds.thinking) return "thinking";
    return "idle";
  }
}

export const orbStore = new OrbStore();
