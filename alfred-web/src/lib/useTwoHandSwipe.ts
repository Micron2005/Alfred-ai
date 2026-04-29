"use client";

/**
 * useTwoHandSwipe — detects a two-handed sliding-door gesture
 * for swiping between tabs.
 *
 * Rewritten to be RAF-driven instead of effect-driven so React
 * doesn't re-run the whole detector every frame the hand state
 * object identity changes. The hands are read from a ``useRef``
 * that the caller updates on every render — the detector itself
 * runs at exactly the same cadence the hand tracker emits frames
 * (roughly 30 fps).
 *
 * Detection rules (tightened from the first pass to feel
 * predictable):
 *
 *   1. Both hands present, and BOTH have a clearly OPEN palm (no
 *      pinch, no fist). Pinches drive the existing pointer cursor;
 *      fists drive the existing scroll/zoom flows; we don't want
 *      to hijack either.
 *   2. Both hands inside the central horizontal band (top 25-75%
 *      of the viewport) so a "wave hello" with one hand near the
 *      head doesn't register as the start of a swipe.
 *   3. Total horizontal travel >= ``MIN_SWIPE_PX`` (250 px) within
 *      a 700 ms window since the gesture started.
 *   4. Both hands moving in the SAME horizontal direction the
 *      whole way through (no zig-zag).
 *   5. Average vertical drift < ``MAX_VERT_DRIFT_PX`` (140 px) so a
 *      diagonal motion doesn't trigger.
 *
 * On detection: fires ``onSwipe`` with "left" or "right", then
 * locks for 900 ms so the same continuous wave doesn't re-trigger.
 *
 * Direction convention: hands moving RIGHT in the viewport
 * (positive screen x) emits ``"right"`` — i.e. "next tab". This
 * matches a real sliding door where you'd push the right panel
 * outward to reveal the next room on the right.
 */

import { useEffect, useRef } from "react";

export interface SwipeHand {
  x: number;
  y: number;
  /** True if the hand is in pinch / fist state — excluded from
   *  the swipe so the existing cursor flows aren't hijacked. */
  isCommitted?: boolean;
}

export interface UseTwoHandSwipeOptions {
  enabled: boolean;
  leftHand: SwipeHand | null;
  rightHand: SwipeHand | null;
  onSwipe: (direction: "left" | "right") => void;
  /** Optional log callback for debugging — we wire this up to a
   *  small overlay in dev mode so the user can see why the
   *  gesture isn't firing if the timing is off. */
  onDebug?: (msg: string) => void;
}

const MIN_SWIPE_PX = 250;
const MAX_VERT_DRIFT_PX = 140;
const MAX_GESTURE_MS = 700;
const COOLDOWN_MS = 900;

interface SwipeState {
  startX_left: number;
  startX_right: number;
  startY_left: number;
  startY_right: number;
  startedAt: number;
  direction: 1 | -1 | 0;
}

export function useTwoHandSwipe(opts: UseTwoHandSwipeOptions) {
  const { enabled, onSwipe, onDebug } = opts;

  // Mirror the latest hand props into refs so the RAF loop can
  // read them without React re-running the effect.
  const leftRef = useRef<SwipeHand | null>(null);
  const rightRef = useRef<SwipeHand | null>(null);
  leftRef.current = opts.leftHand;
  rightRef.current = opts.rightHand;

  const stateRef = useRef<SwipeState | null>(null);
  const cooldownUntilRef = useRef(0);
  const onSwipeRef = useRef(onSwipe);
  const onDebugRef = useRef(onDebug);
  onSwipeRef.current = onSwipe;
  onDebugRef.current = onDebug;

  useEffect(() => {
    if (!enabled) {
      stateRef.current = null;
      return;
    }

    let raf = 0;
    const tick = () => {
      const now = performance.now();
      const left = leftRef.current;
      const right = rightRef.current;

      // Both hands have to be open palms. Either one missing or
      // committed (pinch/fist) clears the in-progress gesture.
      const bothOpen =
        left &&
        right &&
        !left.isCommitted &&
        !right.isCommitted;

      if (!bothOpen || !left || !right) {
        stateRef.current = null;
        raf = requestAnimationFrame(tick);
        return;
      }

      // Cooldown — accept new readings but don't act.
      if (now < cooldownUntilRef.current) {
        raf = requestAnimationFrame(tick);
        return;
      }

      // Reject if either hand is too high (above 25%) or too low
      // (below 75%) — this filters out wave-hello-near-the-face
      // motions and accidental low gestures.
      const vh = window.innerHeight;
      const lo = vh * 0.25;
      const hi = vh * 0.75;
      const inBand =
        left.y >= lo && left.y <= hi && right.y >= lo && right.y <= hi;
      if (!inBand) {
        stateRef.current = null;
        raf = requestAnimationFrame(tick);
        return;
      }

      let s = stateRef.current;
      if (!s) {
        s = {
          startX_left: left.x,
          startX_right: right.x,
          startY_left: left.y,
          startY_right: right.y,
          startedAt: now,
          direction: 0,
        };
        stateRef.current = s;
        raf = requestAnimationFrame(tick);
        return;
      }

      // Window expired without a swipe — restart.
      if (now - s.startedAt > MAX_GESTURE_MS) {
        stateRef.current = {
          startX_left: left.x,
          startX_right: right.x,
          startY_left: left.y,
          startY_right: right.y,
          startedAt: now,
          direction: 0,
        };
        raf = requestAnimationFrame(tick);
        return;
      }

      const travelL = left.x - s.startX_left;
      const travelR = right.x - s.startX_right;
      const driftL = Math.abs(left.y - s.startY_left);
      const driftR = Math.abs(right.y - s.startY_right);
      const avgDrift = (driftL + driftR) / 2;
      const sameDir =
        Math.sign(travelL) === Math.sign(travelR) && Math.sign(travelL) !== 0;
      const avgTravel = (travelL + travelR) / 2;

      if (
        sameDir &&
        Math.abs(avgTravel) >= MIN_SWIPE_PX &&
        avgDrift <= MAX_VERT_DRIFT_PX
      ) {
        const direction: "left" | "right" = avgTravel > 0 ? "right" : "left";
        if (onDebugRef.current) {
          onDebugRef.current(
            `swipe ${direction} (Δx=${avgTravel.toFixed(0)}, drift=${avgDrift.toFixed(0)})`,
          );
        }
        onSwipeRef.current(direction);
        stateRef.current = null;
        cooldownUntilRef.current = now + COOLDOWN_MS;
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [enabled]);
}
