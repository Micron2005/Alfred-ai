"use client";

/**
 * HandCursor — visualizes the hand-tracking cursor and synthesizes
 * real DOM pointer events so existing widget interactions (drag,
 * click, slider) work without per-component plumbing.
 *
 * Events fired on the element under the cursor:
 *   - ``pointerdown`` when a pinch starts
 *   - ``pointermove`` every frame while the cursor moves (whether
 *     pinching or not — same as a real mouse hovering or dragging)
 *   - ``pointerup`` + ``click`` when a pinch releases (the click
 *     is dispatched on the element under the cursor at release
 *     time, not the original pinch-down target, matching browser
 *     mouse behavior when the user drags off the original target)
 *
 * Synthetic events use a dedicated ``pointerId`` of ``9999`` so
 * they don't collide with real touch / pen / mouse pointers if
 * the user is mixing input modes.
 *
 * The visual cursor is a glowing cyan dot that swells slightly
 * when pinching, so the user has positive feedback that the gesture
 * was detected. Both the cursor and the events live behind a
 * single ``enabled`` prop — flipping it off cleans up any in-flight
 * pinch gesture so we never leak a stuck "pointer-down" state.
 */

import { useEffect, useRef } from "react";
import type { CursorPoint } from "@/lib/useHandTracking";

interface Props {
  enabled: boolean;
  cursor: CursorPoint | null;
  /**
   * All 21 viewport-pixel landmark positions, in MediaPipe's
   * hand-landmark order. When provided, the component renders the
   * full hand skeleton rather than just a fingertip dot. Pass
   * ``null`` (or omit) to fall back to the dot-only mode.
   */
  landmarks?: CursorPoint[] | null;
  isPinching: boolean;
}

// MediaPipe's official HAND_CONNECTIONS list. Each pair is two
// landmark indices that should be joined by a bone-segment line
// when rendering a skeleton.
// Reference:
// https://developers.google.com/mediapipe/solutions/vision/hand_landmarker#models
const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  // Thumb
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  // Index
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  // Middle
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  // Ring
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  // Pinky
  [13, 17],
  [17, 18],
  [18, 19],
  [19, 20],
  // Wrist ↔ pinky base (closes the palm)
  [0, 17],
];

// Indices of the five fingertips. Rendered with a slightly bigger
// dot so the user can see where each finger ends.
const FINGERTIPS = [4, 8, 12, 16, 20] as const;

const SYNTHETIC_POINTER_ID = 9999;

function elementAt(x: number, y: number): Element | null {
  if (typeof document === "undefined") return null;
  return document.elementFromPoint(x, y);
}

function buildPointerInit(
  x: number,
  y: number,
  buttons: number,
): PointerEventInit {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: SYNTHETIC_POINTER_ID,
    pointerType: "mouse",
    isPrimary: true,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    button: 0,
    buttons,
    view: typeof window !== "undefined" ? window : undefined,
  };
}

export function HandCursor({
  enabled,
  cursor,
  landmarks,
  isPinching,
}: Props) {
  // Track the previous pinch state and last cursor position so the
  // effect can decide whether each frame is a pointermove, a
  // pointerdown, or a pointerup.
  const prevPinchRef = useRef(false);
  const lastPosRef = useRef<CursorPoint | null>(null);
  // The element the pinch *started* on. Used so the click event at
  // pointerup goes to the right place if the cursor strayed off the
  // original target during the gesture.
  const downTargetRef = useRef<Element | null>(null);

  // Fire a clean (pointerup, pointercancel) pair on the captured
  // down target if a pinch is currently active. Used by both
  // teardown paths (tracking toggled off, hand left the frame).
  // Routing to ``downTargetRef`` rather than ``elementAt(x, y)`` is
  // critical: during a drag the cursor may have moved off the
  // original widget, so events sent to the current hover target
  // would never reach the HudWidget that owns the gesture, leaving
  // its drag state stuck.
  function releasePinch() {
    if (!prevPinchRef.current) return;
    const last = lastPosRef.current;
    const target = downTargetRef.current;
    if (!target || !last) return;
    target.dispatchEvent(
      new PointerEvent("pointerup", buildPointerInit(last.x, last.y, 0)),
    );
    target.dispatchEvent(
      new PointerEvent("pointercancel", buildPointerInit(last.x, last.y, 0)),
    );
  }

  useEffect(() => {
    if (!enabled) {
      // If hand tracking gets toggled off mid-pinch, fire a
      // synthetic pointerup on the *down target* (not whatever's
      // under the cursor right now) so the widget that owns the
      // drag sees a matched up event and cleans up its
      // setPointerCapture / drag state. Otherwise dragRef stays
      // non-null and isDragging never clears, leaving the widget
      // stuck "grabbing" until reload.
      releasePinch();
      prevPinchRef.current = false;
      lastPosRef.current = null;
      downTargetRef.current = null;
      return;
    }

    if (!cursor) {
      // Hand left the frame — same release path as toggle-off.
      releasePinch();
      prevPinchRef.current = false;
      lastPosRef.current = null;
      downTargetRef.current = null;
      return;
    }

    const { x, y } = cursor;
    const last = lastPosRef.current;
    const buttons = isPinching ? 1 : 0;
    const hover = elementAt(x, y);

    // pointerdown — pinch just started.
    if (isPinching && !prevPinchRef.current) {
      if (hover) {
        downTargetRef.current = hover;
        hover.dispatchEvent(
          new PointerEvent("pointerdown", buildPointerInit(x, y, 1)),
        );
      }
    }

    // While pinching, route pointermove + pointerup to the element
    // the gesture started on, NOT to whatever's currently under the
    // cursor. This emulates the browser's native pointer capture
    // behavior: synthetic events bypass setPointerCapture (the
    // browser only tracks real hardware pointers), so the widget
    // would lose move events the moment the cursor strayed off its
    // bounds during a fast drag. Manual capture here makes the
    // gesture stick to the original target until release.
    const moveTarget = isPinching
      ? (downTargetRef.current ?? hover)
      : hover;

    // pointermove — fire whenever the cursor actually changed
    // position. This covers both hovering and dragging.
    if (last && (last.x !== x || last.y !== y) && moveTarget) {
      moveTarget.dispatchEvent(
        new PointerEvent("pointermove", buildPointerInit(x, y, buttons)),
      );
    }

    // pointerup + click — pinch just released. The pointerup goes
    // to the captured down target so a widget that owns the drag
    // sees a matched up event; the click goes to the element under
    // the cursor at release time so a button hit-test works the way
    // a mouse click does (drag off → no click; release on target →
    // click).
    if (!isPinching && prevPinchRef.current) {
      const downTarget = downTargetRef.current;
      if (downTarget) {
        downTarget.dispatchEvent(
          new PointerEvent("pointerup", buildPointerInit(x, y, 0)),
        );
      }
      const clickTarget = hover ?? downTarget;
      if (clickTarget && clickTarget === downTarget) {
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
      downTargetRef.current = null;
    }

    prevPinchRef.current = isPinching;
    lastPosRef.current = { x, y };
  }, [enabled, cursor, isPinching]);

  if (!enabled) return null;
  // No hand visible — nothing to draw, but stay mounted so the
  // gesture-cleanup effect above keeps running.
  if (!cursor && (!landmarks || landmarks.length === 0)) return null;

  const cursorSize = isPinching ? 28 : 22;
  const cursorRing = isPinching ? 3 : 2;
  const stroke = isPinching ? 3.5 : 2.5;
  const cyan = "rgba(0, 229, 255, 0.95)";
  const cyanFill = "rgba(0, 229, 255, 0.18)";
  const gold = "rgba(255, 200, 60, 0.95)";

  return (
    <>
      {/*
        Skeleton overlay — renders the full 21-point hand mesh
        whenever landmarks are available. SVG sized to the viewport
        so coordinates can be used directly without per-frame
        re-projection. ``pointer-events: none`` is critical: the
        synthetic-event dispatcher relies on ``elementFromPoint``
        seeing widgets *under* the overlay, not the overlay itself.
      */}
      {landmarks && landmarks.length === 21 ? (
        <svg
          aria-hidden
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
            <filter id="hand-cursor-glow">
              <feGaussianBlur stdDeviation="2.5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <g filter="url(#hand-cursor-glow)">
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
                  stroke={cyan}
                  strokeWidth={stroke}
                  strokeLinecap="round"
                />
              );
            })}
            {landmarks.map((p, i) => {
              const isTip = (FINGERTIPS as readonly number[]).includes(i);
              const isThumbOrIndexTip = i === 4 || i === 8;
              const r = isTip ? (isPinching && isThumbOrIndexTip ? 7 : 5) : 3;
              const fill =
                isPinching && isThumbOrIndexTip ? gold : cyanFill;
              const stroke2 =
                isPinching && isThumbOrIndexTip ? gold : cyan;
              return (
                <circle
                  key={i}
                  cx={p.x}
                  cy={p.y}
                  r={r}
                  fill={fill}
                  stroke={stroke2}
                  strokeWidth={1.5}
                />
              );
            })}
          </g>
        </svg>
      ) : null}

      {/*
        Cursor dot — the index-fingertip indicator. Even with the
        full skeleton drawn, a dedicated dot helps the user track
        exactly where their click/grab will land (the index-tip
        landmark in the skeleton is the same point but smaller and
        easier to lose at a glance).
      */}
      {cursor ? (
        <div
          aria-hidden
          style={{
            position: "fixed",
            left: cursor.x - cursorSize / 2,
            top: cursor.y - cursorSize / 2,
            width: cursorSize,
            height: cursorSize,
            borderRadius: "50%",
            border: `${cursorRing}px solid ${cyan}`,
            boxShadow: isPinching
              ? "0 0 18px 4px rgba(0, 229, 255, 0.55), 0 0 38px 12px rgba(255, 200, 60, 0.35)"
              : "0 0 14px 3px rgba(0, 229, 255, 0.45)",
            background: isPinching
              ? "rgba(255, 200, 60, 0.30)"
              : "rgba(0, 229, 255, 0.10)",
            // The cursor must NOT eat the events it dispatches —
            // ``pointer-events: none`` ensures elementFromPoint sees
            // the widget below, not the cursor itself.
            pointerEvents: "none",
            zIndex: 99999,
            transition: "width 80ms ease, height 80ms ease",
          }}
        />
      ) : null}
    </>
  );
}
