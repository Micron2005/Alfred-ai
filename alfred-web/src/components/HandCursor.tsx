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
  isPinching: boolean;
}

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

export function HandCursor({ enabled, cursor, isPinching }: Props) {
  // Track the previous pinch state and last cursor position so the
  // effect can decide whether each frame is a pointermove, a
  // pointerdown, or a pointerup.
  const prevPinchRef = useRef(false);
  const lastPosRef = useRef<CursorPoint | null>(null);
  // The element the pinch *started* on. Used so the click event at
  // pointerup goes to the right place if the cursor strayed off the
  // original target during the gesture.
  const downTargetRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!enabled) {
      // If hand tracking gets toggled off mid-pinch, fire a
      // synthetic pointerup so the widget cleans up its
      // setPointerCapture / drag state.
      if (prevPinchRef.current && lastPosRef.current) {
        const { x, y } = lastPosRef.current;
        const target = elementAt(x, y);
        if (target) {
          target.dispatchEvent(
            new PointerEvent("pointerup", buildPointerInit(x, y, 0)),
          );
          target.dispatchEvent(
            new PointerEvent("pointercancel", buildPointerInit(x, y, 0)),
          );
        }
      }
      prevPinchRef.current = false;
      lastPosRef.current = null;
      downTargetRef.current = null;
      return;
    }

    if (!cursor) {
      // Hand left the frame — drop any active pinch the same way.
      if (prevPinchRef.current && lastPosRef.current) {
        const { x, y } = lastPosRef.current;
        const target = elementAt(x, y);
        if (target) {
          target.dispatchEvent(
            new PointerEvent("pointerup", buildPointerInit(x, y, 0)),
          );
          target.dispatchEvent(
            new PointerEvent("pointercancel", buildPointerInit(x, y, 0)),
          );
        }
      }
      prevPinchRef.current = false;
      lastPosRef.current = null;
      downTargetRef.current = null;
      return;
    }

    const { x, y } = cursor;
    const last = lastPosRef.current;
    const buttons = isPinching ? 1 : 0;
    const target = elementAt(x, y);

    // pointerdown — pinch just started.
    if (isPinching && !prevPinchRef.current) {
      if (target) {
        downTargetRef.current = target;
        target.dispatchEvent(
          new PointerEvent("pointerdown", buildPointerInit(x, y, 1)),
        );
      }
    }

    // pointermove — fire whenever the cursor actually changed
    // position. This covers both hovering and dragging.
    if (last && (last.x !== x || last.y !== y) && target) {
      target.dispatchEvent(
        new PointerEvent("pointermove", buildPointerInit(x, y, buttons)),
      );
    }

    // pointerup + click — pinch just released.
    if (!isPinching && prevPinchRef.current) {
      const upTarget = target ?? downTargetRef.current;
      if (upTarget) {
        upTarget.dispatchEvent(
          new PointerEvent("pointerup", buildPointerInit(x, y, 0)),
        );
        upTarget.dispatchEvent(
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

  if (!enabled || !cursor) return null;

  const size = isPinching ? 28 : 22;
  const ring = isPinching ? 3 : 2;
  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        left: cursor.x - size / 2,
        top: cursor.y - size / 2,
        width: size,
        height: size,
        borderRadius: "50%",
        border: `${ring}px solid rgba(0, 229, 255, 0.95)`,
        boxShadow: isPinching
          ? "0 0 18px 4px rgba(0, 229, 255, 0.55), 0 0 38px 12px rgba(255, 200, 60, 0.18)"
          : "0 0 14px 3px rgba(0, 229, 255, 0.45)",
        background: isPinching
          ? "rgba(0, 229, 255, 0.25)"
          : "rgba(0, 229, 255, 0.08)",
        // The cursor must NOT eat the events it dispatches —
        // ``pointer-events: none`` ensures elementFromPoint sees the
        // widget below, not the cursor itself.
        pointerEvents: "none",
        zIndex: 99999,
        transition: "width 80ms ease, height 80ms ease",
      }}
    />
  );
}
