"use client";

/**
 * faceBus — one-way state pipe from the main HUD window to the
 * detached "/face" window (the wire-mesh avatar on the embedded
 * touchscreen monitor).
 *
 * Transport is a same-origin ``BroadcastChannel`` — zero backend
 * involvement, works across windows/tabs of the same browser
 * profile, survives the face window being opened before OR after
 * the HUD.
 *
 * Protocol (all messages are plain JSON-serialisable objects):
 *   { type: "state", mode, level, t }  HUD → face. ~30 Hz while the
 *                                      orb is non-idle (so the mouth
 *                                      lip-syncs to TTS amplitude),
 *                                      1 Hz heartbeat while idle.
 *   { type: "hello" }                  face → HUD. Fired when the
 *                                      face window mounts; the HUD
 *                                      replies immediately with a
 *                                      state message so the avatar
 *                                      links up without waiting for
 *                                      the next heartbeat.
 *
 * The amplitude itself comes for free: ChatWindow's TTS pipeline
 * already routes every audio chunk through a Web Audio analyser and
 * pushes RMS samples into ``orbStore`` (for the orb heartbeat). The
 * publisher just samples that same store — no changes to the speech
 * path needed.
 */

import { orbStore, type OrbMode } from "@/lib/orbState";

export const FACE_BUS_CHANNEL = "alfred-face-bus";

export interface FaceBusState {
  mode: OrbMode;
  /** Smoothed audio level 0..1 (TTS amplitude while speaking, mic
   *  RMS while listening). */
  level: number;
  /** Sender wall-clock ms — receivers use this to detect a dead
   *  link (HUD window closed) and decay back to standby. */
  t: number;
}

interface StateMessage extends FaceBusState {
  type: "state";
}

interface HelloMessage {
  type: "hello";
}

type FaceBusMessage = StateMessage | HelloMessage;

/**
 * Start broadcasting orb state from THIS window. Call once from the
 * desktop shell. Returns a stop function.
 *
 * Uses ``setInterval`` rather than rAF deliberately: rAF freezes
 * completely when the HUD tab is backgrounded, which would strand
 * the face window mid-"SPEAKING". Background tabs throttle
 * intervals to ~1 Hz which gracefully degrades to heartbeat cadence
 * instead of going silent.
 */
export function startFaceBusPublisher(): () => void {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
    return () => {};
  }
  const ch = new BroadcastChannel(FACE_BUS_CHANNEL);
  let lastIdleSend = 0;

  const send = () => {
    const msg: StateMessage = {
      type: "state",
      mode: orbStore.getMode(),
      level: orbStore.getLevel(),
      t: Date.now(),
    };
    try {
      ch.postMessage(msg);
    } catch {
      /* channel closed mid-send — stop() races the interval */
    }
  };

  const id = window.setInterval(() => {
    if (orbStore.getMode() !== "idle") {
      send();
      lastIdleSend = 0;
      return;
    }
    const now = performance.now();
    if (now - lastIdleSend >= 1000) {
      lastIdleSend = now;
      send();
    }
  }, 33);

  ch.onmessage = (e: MessageEvent<FaceBusMessage>) => {
    if (e.data?.type === "hello") send();
  };

  return () => {
    window.clearInterval(id);
    ch.close();
  };
}

/**
 * Subscribe to HUD state from the face window. Posts a "hello" so
 * the publisher replies instantly. Returns an unsubscribe function.
 */
export function subscribeFaceBus(
  onState: (s: FaceBusState) => void,
): () => void {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
    return () => {};
  }
  const ch = new BroadcastChannel(FACE_BUS_CHANNEL);
  ch.onmessage = (e: MessageEvent<FaceBusMessage>) => {
    const d = e.data;
    if (d?.type === "state") {
      onState({ mode: d.mode, level: d.level, t: d.t });
    }
  };
  try {
    ch.postMessage({ type: "hello" } satisfies HelloMessage);
  } catch {
    /* ignore */
  }
  return () => ch.close();
}
