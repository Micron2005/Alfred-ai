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
 *   { type: "state", mode, level, gaze, t } HUD → face. ~30 Hz
 *                                      while the orb is non-idle
 *                                      (so the mouth lip-syncs to
 *                                      TTS amplitude AND the head
 *                                      tracks the user's face),
 *                                      1 Hz heartbeat while idle.
 *                                      ``gaze`` is optional — only
 *                                      set when the HUD's face
 *                                      tracker has a face this
 *                                      frame; the receiver decays
 *                                      to ambient drift after
 *                                      ``LEVEL_STALE_MS`` of no
 *                                      gaze updates.
 *   { type: "hello" }                  face → HUD. Fired when the
 *                                      face window mounts; the HUD
 *                                      replies immediately with a
 *                                      state message so the avatar
 *                                      links up without waiting for
 *                                      the next heartbeat.
 *
 * Gaze ownership note: BEFORE 2026-02 the /face window grabbed its
 * own ``getUserMedia`` to drive the wireframe head's gaze direction.
 * That worked when /face was the only window with a camera tile,
 * but the moment the user toggled CAM ON in the HUD, both windows
 * raced for the device and the HUD's ``useCamera`` lost (the OS
 * camera was already locked by /face). Now the HUD's face tracker
 * is the single source of truth and broadcasts gaze to /face —
 * one camera grab, two consumers.
 *
 * The amplitude itself comes for free: ChatWindow's TTS pipeline
 * already routes every audio chunk through a Web Audio analyser and
 * pushes RMS samples into ``orbStore`` (for the orb heartbeat). The
 * publisher just samples that same store — no changes to the speech
 * path needed. Same pattern for gaze: HUD's useFaceTracking writes
 * into ``faceBusGaze`` and the publisher samples it.
 */

import { orbStore, type OrbMode } from "@/lib/orbState";

export const FACE_BUS_CHANNEL = "alfred-face-bus";

/** Normalised gaze direction in viewport coordinates: -1..+1 on
 *  each axis, with (0, 0) being dead-centre. ``active`` is false
 *  when no face is detected this frame. */
export interface FaceBusGaze {
  x: number;
  y: number;
  active: boolean;
}

/** Module-local mailbox the HUD writes into and the publisher
 *  reads. Kept outside React state because the publisher runs on
 *  ``setInterval`` and needs the freshest value, not a snapshot
 *  from when an effect re-ran. */
let currentGaze: FaceBusGaze = { x: 0, y: 0, active: false };

/** Called by HUD's face-tracking subscriber whenever a new face
 *  position is available. Pass ``active: false`` when the face is
 *  lost so /face decays to ambient drift instead of locking on a
 *  stale target. */
export function publishGaze(gaze: FaceBusGaze): void {
  currentGaze = gaze;
}

export interface FaceBusState {
  mode: OrbMode;
  /** Smoothed audio level 0..1 (TTS amplitude while speaking, mic
   *  RMS while listening). */
  level: number;
  /** Optional gaze direction from the HUD's face tracker. ``null``
   *  when the HUD has no camera, no face, or gaze hasn't been
   *  refreshed in over ``LEVEL_STALE_MS`` ms — receivers should
   *  treat ``null`` and ``{ active: false }`` the same way. */
  gaze: FaceBusGaze | null;
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
      // Snapshot the latest gaze the HUD's face tracker wrote into
      // ``currentGaze``. Null when never published (HUD has no
      // camera/face-tracking running) so /face decays to ambient
      // drift instead of pointing at (0,0).
      gaze: currentGaze.active ? { ...currentGaze } : null,
      t: Date.now(),
    };
    try {
      ch.postMessage(msg);
    } catch {
      /* channel closed mid-send — stop() races the interval */
    }
  };

  const id = window.setInterval(() => {
    // Send at full cadence whenever the orb is doing something
    // visible (the lip-sync amplitude needs to be fresh) OR the
    // user's face is being tracked (so /face's head tracks the
    // user smoothly even while Alfred is idle and quiet). Falling
    // back to 1 Hz only when both conditions are dormant keeps
    // background-tab CPU sane.
    if (orbStore.getMode() !== "idle" || currentGaze.active) {
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
      onState({ mode: d.mode, level: d.level, gaze: d.gaze, t: d.t });
    }
  };
  try {
    ch.postMessage({ type: "hello" } satisfies HelloMessage);
  } catch {
    /* ignore */
  }
  return () => ch.close();
}
