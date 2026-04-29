"use client";

/**
 * useTwoHandSwipe — detects a two-handed sliding-door gesture
 * for swiping between tabs.
 *
 * The user described it as: "use both hands and kinda pull it
 * to the side with my fingers slightly bent like im moving a
 * sliding door". So we look for:
 *
 *   1. Both hands present in frame, simultaneously, for at least
 *      ``MIN_DUAL_FRAMES`` consecutive frames.
 *   2. Both hands "slightly bent" — i.e. neither pinching tight
 *      nor making a fist (we exclude the existing pinch / fist
 *      gestures so the existing pointer-cursor flows aren't
 *      hijacked).
 *   3. Both hands moving in the SAME horizontal direction with a
 *      meaningful velocity (>= ``MIN_VEL_PX_PER_FRAME``) for at
 *      least ``MIN_SWIPE_FRAMES`` consecutive frames.
 *   4. Net horizontal travel >= ``MIN_SWIPE_PX`` since gesture
 *      start.
 *
 * On detection, fires the supplied ``onSwipe`` callback with a
 * direction ("left" or "right") then enters a 700ms cooldown so a
 * single sliding motion doesn't double-trigger.
 *
 * Designed to read directly from the existing ``useHandTracking``
 * hook's two-hand output — no extra camera stream, no extra cost.
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
}

const MIN_DUAL_FRAMES = 4;
const MIN_VEL_PX_PER_FRAME = 6;
const MIN_SWIPE_FRAMES = 5;
const MIN_SWIPE_PX = 180;
const COOLDOWN_MS = 700;

interface SwipeState {
  startX_left: number;
  startX_right: number;
  framesAlive: number;
  framesMoving: number;
  direction: 1 | -1 | 0;
  prevX_left: number;
  prevX_right: number;
}

export function useTwoHandSwipe(opts: UseTwoHandSwipeOptions) {
  const { enabled, leftHand, rightHand, onSwipe } = opts;
  const stateRef = useRef<SwipeState | null>(null);
  const cooldownUntilRef = useRef(0);
  const onSwipeRef = useRef(onSwipe);
  onSwipeRef.current = onSwipe;

  useEffect(() => {
    if (!enabled) {
      stateRef.current = null;
      return;
    }

    const now = performance.now();
    if (now < cooldownUntilRef.current) return;

    const bothPresent =
      leftHand &&
      rightHand &&
      !leftHand.isCommitted &&
      !rightHand.isCommitted;

    if (!bothPresent || !leftHand || !rightHand) {
      // Reset if we lose either hand — partial detections shouldn't
      // partially commit a swipe.
      stateRef.current = null;
      return;
    }

    const s = stateRef.current;
    if (!s) {
      stateRef.current = {
        startX_left: leftHand.x,
        startX_right: rightHand.x,
        framesAlive: 1,
        framesMoving: 0,
        direction: 0,
        prevX_left: leftHand.x,
        prevX_right: rightHand.x,
      };
      return;
    }

    s.framesAlive++;
    const dxL = leftHand.x - s.prevX_left;
    const dxR = rightHand.x - s.prevX_right;

    // Both hands have to be moving in the same direction with
    // enough speed to count as a swipe frame.
    const sameDirection =
      Math.sign(dxL) === Math.sign(dxR) && Math.sign(dxL) !== 0;
    const fastEnough =
      Math.abs(dxL) >= MIN_VEL_PX_PER_FRAME &&
      Math.abs(dxR) >= MIN_VEL_PX_PER_FRAME;

    if (sameDirection && fastEnough) {
      s.framesMoving++;
      s.direction = Math.sign(dxL) as 1 | -1;
    } else {
      // Don't reset on a single slow frame — give the user the
      // benefit of natural deceleration mid-swipe. But more than
      // a couple of "still" frames means they probably stopped.
      if (s.framesMoving > 0) s.framesMoving--;
    }

    s.prevX_left = leftHand.x;
    s.prevX_right = rightHand.x;

    if (
      s.framesAlive >= MIN_DUAL_FRAMES &&
      s.framesMoving >= MIN_SWIPE_FRAMES &&
      s.direction !== 0
    ) {
      const travelL = leftHand.x - s.startX_left;
      const travelR = rightHand.x - s.startX_right;
      const avgTravel = (travelL + travelR) / 2;
      if (Math.abs(avgTravel) >= MIN_SWIPE_PX) {
        // Note the inversion: hand-mirror means moving hands to
        // the right (positive x in viewport) feels like pulling a
        // sliding door TO THE RIGHT, which is the natural gesture
        // for "previous tab" (move content rightwards = move
        // viewport leftwards = previous). Confirm with users; flip
        // if it feels backwards.
        const direction: "left" | "right" = avgTravel > 0 ? "right" : "left";
        onSwipeRef.current(direction);
        stateRef.current = null;
        cooldownUntilRef.current = performance.now() + COOLDOWN_MS;
      }
    }
  }, [enabled, leftHand, rightHand]);
}
