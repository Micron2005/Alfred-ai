"use client";

/**
 * HandCursor — synthetic pointer events from MediaPipe hand landmarks.
 *
 * Both hands are first-class cursors: each renders a glowing dot at
 * its index fingertip, each fires synthetic pointerdown / pointermove
 * / pointerup / click on pinch. They use distinct PointerEvent
 * ``pointerId`` values so widgets that track per-pointer state (e.g.
 * setPointerCapture) can keep them separate.
 *
 * Two-hand pinch (both hands pinching at the same time) suppresses
 * single-hand clicks — the user's intent is a resize, not a click.
 * Active drags release cleanly via pointerup with no following click.
 *
 * Skeleton overlay can be hidden via ``hideSkeleton`` (default
 * false). When hidden, only the cursor dot remains. Useful when the
 * HUD is projected onto a desk and the user can see their own hands
 * already.
 */

import { useEffect, useRef } from "react";
import type { CursorPoint, HandState } from "@/lib/useHandTracking";

// MediaPipe's official HAND_CONNECTIONS list. Each pair is two
// landmark indices that should be drawn as a bone segment. Kept
// inline (not imported) so HandCursor stays self-contained.
const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  // Thumb
  [0, 1], [1, 2], [2, 3], [3, 4],
  // Index finger
  [0, 5], [5, 6], [6, 7], [7, 8],
  // Middle finger
  [9, 10], [10, 11], [11, 12],
  // Ring finger
  [13, 14], [14, 15], [15, 16],
  // Pinky finger
  [0, 17], [17, 18], [18, 19], [19, 20],
  // Palm
  [5, 9], [9, 13], [13, 17],
];
const FINGERTIPS = [4, 8, 12, 16, 20] as const;

const CYAN_STROKE = "rgba(0, 229, 255, 0.95)";
const CYAN_FILL = "rgba(0, 229, 255, 0.65)";
const GOLD_STROKE = "rgba(255, 200, 60, 0.95)";
const GOLD_FILL = "rgba(255, 200, 60, 0.6)";
const PINCH_FLASH = "rgba(255, 240, 100, 0.95)";

interface Props {
  enabled: boolean;
  rightHand: HandState | null;
  leftHand: HandState | null;
  /** Hide the bone overlay + landmark dots while keeping the
   *  fingertip cursor visible. Persisted by the parent. */
  hideSkeleton?: boolean;
}

interface PointerInit {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  bubbles: boolean;
  cancelable: boolean;
  composed: boolean;
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
  button: number;
  buttons: number;
  view?: Window;
}

function buildPointerInit(
  x: number,
  y: number,
  buttons: number,
  pointerId: number,
): PointerInit {
  return {
    pointerId,
    pointerType: "pen", // "pen" matches stylus / fingertip semantics best
    isPrimary: pointerId === 9999, // right hand acts as the primary pointer
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    button: 0,
    buttons,
    view: typeof window !== "undefined" ? window : undefined,
  };
}

function elementAt(x: number, y: number): Element | null {
  if (typeof document === "undefined") return null;
  return document.elementFromPoint(x, y);
}

interface SkeletonProps {
  landmarks: CursorPoint[];
  stroke: string;
  fill: string;
  pinching: boolean;
  baseStroke: number;
  filterId: string;
}

function HandSkeleton({
  landmarks,
  stroke,
  fill,
  pinching,
  baseStroke,
  filterId,
}: SkeletonProps) {
  return (
    <g filter={`url(#${filterId})`}>
      {HAND_CONNECTIONS.map(([a, b], i) => {
        const pa = landmarks[a];
        const pb = landmarks[b];
        if (!pa || !pb) return null;
        return (
          <line
            key={i}
            x1={pa.x}
            y1={pa.y}
            x2={pb.x}
            y2={pb.y}
            stroke={stroke}
            strokeWidth={baseStroke}
            strokeLinecap="round"
          />
        );
      })}
      {landmarks.map((p, i) => {
        const isTip = (FINGERTIPS as readonly number[]).includes(i);
        const isThumbOrIndexTip = i === 4 || i === 8;
        const r = isTip ? (pinching && isThumbOrIndexTip ? 7 : 5) : 3;
        const tipFill = pinching && isThumbOrIndexTip ? PINCH_FLASH : fill;
        const tipStroke = pinching && isThumbOrIndexTip ? PINCH_FLASH : stroke;
        return (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={r}
            fill={tipFill}
            stroke={tipStroke}
            strokeWidth={1.5}
          />
        );
      })}
    </g>
  );
}

/**
 * Per-hand state used by the synthetic-pointer-event effect. Kept as
 * a single ref so the effect closure sees fresh values without re-
 * binding (each frame's effect re-mutates the ref in place).
 */
interface HandPointerState {
  prevPinch: boolean;
  synthDownActive: boolean;
  lastPos: CursorPoint | null;
  downTarget: Element | null;
}

function newState(): HandPointerState {
  return {
    prevPinch: false,
    synthDownActive: false,
    lastPos: null,
    downTarget: null,
  };
}

export function HandCursor({
  enabled,
  rightHand,
  leftHand,
  hideSkeleton = false,
}: Props) {
  // Independent state per hand. Right uses pointerId 9999 (primary),
  // left uses 8888 — keeps any setPointerCapture() handlers in
  // widgets cleanly separated.
  const rightStateRef = useRef<HandPointerState>(newState());
  const leftStateRef = useRef<HandPointerState>(newState());

  // Disabled / both hands gone → release any held pointers cleanly.
  useEffect(() => {
    if (enabled) return;
    teardown(rightStateRef.current, 9999);
    teardown(leftStateRef.current, 8888);
    rightStateRef.current = newState();
    leftStateRef.current = newState();
  }, [enabled]);

  // Per-frame dispatcher. Runs on every render because hand frames
  // come in via refs (the parent re-renders ChatWindow on each
  // MediaPipe tick). Independent for each hand.
  useEffect(() => {
    if (!enabled) return;
    const otherPinching = !!leftHand?.isPinching && !!rightHand?.isPinching;
    runHandFrame({
      hand: rightHand,
      state: rightStateRef.current,
      pointerId: 9999,
      otherPinching,
    });
    runHandFrame({
      hand: leftHand,
      state: leftStateRef.current,
      pointerId: 8888,
      otherPinching,
    });
  });

  if (!enabled) return null;
  if (!rightHand && !leftHand) return null;

  const rightStroke = rightHand?.isPinching ? 3.5 : 2.5;
  const leftStroke = leftHand?.isPinching ? 3.5 : 2.5;

  return (
    <>
      {!hideSkeleton ? (
        <svg
          aria-hidden
          data-testid="hand-skeleton-overlay"
          style={{
            position: "fixed",
            inset: 0,
            width: "100vw",
            height: "100vh",
            pointerEvents: "none",
            zIndex: 99998,
          }}
        >
          <defs>
            <filter id="hand-cursor-glow-right">
              <feGaussianBlur stdDeviation="2.5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id="hand-cursor-glow-left">
              <feGaussianBlur stdDeviation="2.5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          {leftHand && leftHand.landmarks.length === 21 ? (
            <HandSkeleton
              landmarks={leftHand.landmarks}
              stroke={GOLD_STROKE}
              fill={GOLD_FILL}
              pinching={leftHand.isPinching}
              baseStroke={leftStroke}
              filterId="hand-cursor-glow-left"
            />
          ) : null}
          {rightHand && rightHand.landmarks.length === 21 ? (
            <HandSkeleton
              landmarks={rightHand.landmarks}
              stroke={CYAN_STROKE}
              fill={CYAN_FILL}
              pinching={rightHand.isPinching}
              baseStroke={rightStroke}
              filterId="hand-cursor-glow-right"
            />
          ) : null}
        </svg>
      ) : null}

      {/* Both hands get a cursor dot now — they're equal cursors. The
          dots are color-coded so the user can tell which hand is
          which when projected onto a desk. */}
      <CursorDot
        hand={rightHand}
        stroke={CYAN_STROKE}
        rgbGlow="0, 229, 255"
        testId="hand-cursor-right"
      />
      <CursorDot
        hand={leftHand}
        stroke={GOLD_STROKE}
        rgbGlow="255, 200, 60"
        testId="hand-cursor-left"
      />
    </>
  );
}

function CursorDot({
  hand,
  stroke,
  rgbGlow,
  testId,
}: {
  hand: HandState | null;
  stroke: string;
  rgbGlow: string;
  testId: string;
}) {
  const cursor = hand?.cursor ?? null;
  if (!cursor) return null;
  const pinching = !!hand?.isPinching;
  const size = pinching ? 28 : 22;
  const ring = pinching ? 3 : 2;
  return (
    <div
      data-testid={testId}
      aria-hidden
      style={{
        position: "fixed",
        left: cursor.x - size / 2,
        top: cursor.y - size / 2,
        width: size,
        height: size,
        borderRadius: "50%",
        border: `${ring}px solid ${stroke}`,
        boxShadow: pinching
          ? `0 0 18px 4px rgba(${rgbGlow}, 0.55), 0 0 38px 12px rgba(255, 240, 100, 0.35)`
          : `0 0 14px 3px rgba(${rgbGlow}, 0.45)`,
        background: pinching
          ? "rgba(255, 240, 100, 0.30)"
          : `rgba(${rgbGlow}, 0.10)`,
        // Cursor must not intercept events it dispatches.
        pointerEvents: "none",
        zIndex: 99999,
        transition: "width 80ms ease, height 80ms ease",
      }}
    />
  );
}

/**
 * Per-hand frame processor. Mutates ``state`` in place and dispatches
 * synthetic pointer events.
 *
 * Behavior:
 *   - Pinch start (raw false → true), other hand NOT pinching: dispatch
 *     pointerdown on whatever's under the fingertip.
 *   - While pinching: dispatch pointermove to the original downTarget
 *     (manual pointer-capture emulation).
 *   - Pinch end (raw true → false): dispatch pointerup + click on the
 *     downTarget IF the cursor is still over it.
 *   - Other hand starts pinching mid-gesture: dispatch pointerup
 *     (no click) so any in-flight drag releases cleanly. The two-hand
 *     resize handler in the widget takes over from here.
 */
function runHandFrame({
  hand,
  state,
  pointerId,
  otherPinching,
}: {
  hand: HandState | null;
  state: HandPointerState;
  pointerId: number;
  otherPinching: boolean;
}): void {
  const cursor = hand?.cursor ?? null;
  if (!cursor) {
    // Hand left the frame — release any held pointer.
    teardown(state, pointerId);
    state.prevPinch = false;
    state.lastPos = null;
    return;
  }

  const { x, y } = cursor;
  const last = state.lastPos;
  const wasPinch = state.prevPinch;
  const rawPinch = !!hand?.isPinching;
  const wasSynthDownActive = state.synthDownActive;
  const buttons = wasSynthDownActive ? 1 : 0;
  const hover = elementAt(x, y);

  // pointerdown — on raw pinch start, but ONLY if the other hand
  // isn't already pinching (that's a resize gesture, not a click).
  const justStarted = rawPinch && !wasPinch;
  if (justStarted && !otherPinching && !wasSynthDownActive && hover) {
    state.downTarget = hover;
    state.synthDownActive = true;
    hover.dispatchEvent(
      new PointerEvent("pointerdown", buildPointerInit(x, y, 1, pointerId)),
    );
  }

  // pointermove — route to the original downTarget while a synthetic
  // pointerdown is held, so a fast drag that strays off the original
  // widget still reaches it.
  const moveTarget = state.synthDownActive
    ? (state.downTarget ?? hover)
    : hover;
  if (last && (last.x !== x || last.y !== y) && moveTarget) {
    moveTarget.dispatchEvent(
      new PointerEvent(
        "pointermove",
        buildPointerInit(x, y, buttons, pointerId),
      ),
    );
  }

  // Release path:
  //   - genuine release: rawPinch true → false → pointerup + click
  //   - resize takeover: other hand started pinching → pointerup, no click
  const justEnded = !rawPinch && wasPinch;
  const shouldRelease =
    wasSynthDownActive && (justEnded || otherPinching);
  if (shouldRelease) {
    const downTarget = state.downTarget;
    if (downTarget) {
      downTarget.dispatchEvent(
        new PointerEvent("pointerup", buildPointerInit(x, y, 0, pointerId)),
      );
    }
    const clickTarget = hover ?? downTarget;
    if (justEnded && clickTarget && clickTarget === downTarget) {
      clickTarget.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: x,
          clientY: y,
          button: 0,
          buttons: 0,
          view: typeof window !== "undefined" ? window : undefined,
        }),
      );
    }
    state.synthDownActive = false;
    state.downTarget = null;
  }

  state.prevPinch = rawPinch;
  state.lastPos = { x, y };
}

/**
 * Release any held synthetic pointer cleanly. Used on disable /
 * hand-left-frame. Routes events to the captured downTarget so the
 * widget that owns the gesture sees a matched up event.
 */
function teardown(state: HandPointerState, pointerId: number): void {
  if (!state.synthDownActive) return;
  const target = state.downTarget;
  const last = state.lastPos;
  if (!target || !last) return;
  target.dispatchEvent(
    new PointerEvent(
      "pointerup",
      buildPointerInit(last.x, last.y, 0, pointerId),
    ),
  );
  target.dispatchEvent(
    new PointerEvent(
      "pointercancel",
      buildPointerInit(last.x, last.y, 0, pointerId),
    ),
  );
  state.synthDownActive = false;
  state.downTarget = null;
}
