"use client";

/**
 * HudWidget — a wrapper that gives every HUD widget the ability to
 * be repositioned, resized, and hidden once the user has switched
 * the HUD into custom-layout mode.
 *
 * Interaction model (designed for a touchscreen laptop):
 *   - Drag-from-anywhere: pressing the widget body and either
 *     dragging past 8 px **or** holding for 250 ms commits to a
 *     drag. Anything shorter falls through as a regular click so
 *     buttons / sliders inside the widget (Spotify play, weather
 *     refresh, etc.) still work normally.
 *   - Resize: a small triangle at the bottom-right corner is
 *     **always visible** in custom mode. Drag it to scale.
 *   - Hide: a × in the top-right is **always visible** in custom
 *     mode. Click to take the widget off the canvas (it'll show up
 *     as a "+ NAME" chip in the customize toolbar so you can bring
 *     it back).
 *
 * Pointer capture (``setPointerCapture``) keeps the gesture going
 * even if the cursor briefly leaves the handle (common when
 * dragging fast or with a finger).
 *
 * In default flow mode (``customEnabled=false``) the wrapper
 * disappears entirely and renders ``children`` inline so the
 * out-of-the-box layout is unaffected for users who never opt in.
 */

import { useRef, useState } from "react";
import type { HudWidgetId, WidgetLayout } from "@/lib/hudLayout";

interface Props {
  id: HudWidgetId;
  label: string;
  layout: WidgetLayout;
  customEnabled: boolean;
  onMove: (patch: Partial<WidgetLayout>) => void;
  onHide: () => void;
  /** When ``true``, the widget renders nothing (still mounted for
   *  ref stability — but ``display:none`` so it doesn't affect
   *  layout). The hidden state is owned by the parent so it can
   *  show a "show" chip in its customize toolbar. */
  hidden?: boolean;
  /** CSS scale factor of the parent canvas. Pointer-event deltas
   *  are reported in viewport pixels, but ``layout.{x,y,w,h}`` are
   *  in unscaled canvas pixels — divide by this to keep the widget
   *  pinned to the user's finger when the canvas has been shrunk
   *  to fit a narrower viewport (e.g. when the sidebar is open). */
  scale?: number;
  /** Optional override z-index for the widget container. Default 1
   *  (or 20 while dragging). The orb wrapper bumps this so its
   *  click handler isn't blocked by the floating-Earth widget which
   *  sits at z=8. */
  zIndex?: number;
  children: React.ReactNode;
}

const DRAG_DISTANCE_THRESHOLD_PX = 8;
const DRAG_HOLD_THRESHOLD_MS = 250;

/** Selectors for elements inside a widget that should never start a
 *  drag (they handle their own clicks). Anything matched by this
 *  selector list gets ``preventDefault: false`` from
 *  ``HudWidget`` — touches/clicks pass straight through. */
const NO_DRAG_SELECTOR =
  "button, a, input, select, textarea, [role=button], [role=slider], [data-no-drag]";

export function HudWidget({
  id,
  label,
  layout,
  customEnabled,
  onMove,
  onHide,
  hidden,
  scale = 1,
  zIndex,
  children,
}: Props) {
  const safeScale = scale > 0 ? scale : 1;
  const containerRef = useRef<HTMLDivElement>(null);
  // While we're holding before committing to a drag, this state
  // tracks the gesture so move/up handlers know what to do. Stored
  // in a ref because we don't want the in-progress drag to trigger
  // a React re-render until commit.
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    holdTimer: ReturnType<typeof setTimeout> | null;
    committed: boolean;
  } | null>(null);
  const resizeRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origW: number;
    origH: number;
  } | null>(null);
  // ``isDragging`` mirrors ``dragRef.committed`` for CSS — we want
  // a different cursor + faint scale while dragging, but only after
  // the gesture commits (otherwise short clicks would briefly look
  // like drags).
  const [isDragging, setIsDragging] = useState(false);

  if (hidden) {
    return (
      <div
        data-hud-widget={id}
        aria-hidden
        style={{ display: "none" }}
      />
    );
  }

  const widthVal: string | number =
    layout.w === "auto" ? "auto" : `${layout.w}px`;
  const heightVal: string | number =
    layout.h === "auto" ? "auto" : `${layout.h}px`;

  // Read-only mode (customize off) — render at the saved position
  // but without drag/resize/hide handles. Positions persist between
  // customize on/off so widgets stay where the user put them.
  if (!customEnabled) {
    return (
      <div
        data-hud-widget={id}
        style={{
          position: "absolute",
          left: layout.x,
          top: layout.y,
          width: widthVal,
          height: heightVal,
          boxSizing: "border-box",
          // Apply ``zIndex`` even in read-only mode so orb (z=12)
          // sits above floating-Earth (z=8) and stays clickable.
          // Without this, the prop only affected custom-edit mode
          // and the orb-vs-Earth click interception persisted.
          zIndex: zIndex,
        }}
      >
        {children}
      </div>
    );
  }

  function commitDrag() {
    const s = dragRef.current;
    if (!s || s.committed) return;
    s.committed = true;
    if (s.holdTimer) {
      clearTimeout(s.holdTimer);
      s.holdTimer = null;
    }
    setIsDragging(true);
  }

  function startBodyPress(e: React.PointerEvent<HTMLDivElement>) {
    // Don't start a drag if the user pressed on an interactive
    // child (button, slider, etc.) — let the click pass through.
    const target = e.target as HTMLElement | null;
    if (target?.closest(NO_DRAG_SELECTOR)) return;
    // Ignore right/middle clicks; only primary pointer should drag.
    if (e.button !== 0 && e.pointerType === "mouse") return;

    const holdTimer = setTimeout(() => {
      // Promote to drag after the hold threshold (so a long-press
      // on touch starts a drag without requiring movement).
      commitDrag();
    }, DRAG_HOLD_THRESHOLD_MS);

    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origX: layout.x,
      origY: layout.y,
      holdTimer,
      committed: false,
    };
    // Capture so we keep getting move/up events even if the pointer
    // leaves the widget (common with fast drags). Synthetic pointer
    // events (e.g. from hand-tracking) carry pointerIds the browser
    // hasn't registered as active hardware pointers; setPointerCapture
    // throws NotFoundError on those. Swallow it — HandCursor's manual
    // capture keeps the gesture going for synthetic streams.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic-pointer / unregistered pointerId — safe to ignore */
    }
  }

  function moveBodyPress(e: React.PointerEvent<HTMLDivElement>) {
    const s = dragRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    // Promote to drag once we've moved past the distance threshold,
    // even if the hold timer hasn't fired yet — this is the
    // mouse-flick path.
    if (
      !s.committed &&
      Math.hypot(dx, dy) >= DRAG_DISTANCE_THRESHOLD_PX
    ) {
      commitDrag();
    }
    if (s.committed) {
      onMove({
        x: Math.max(0, s.origX + dx / safeScale),
        y: Math.max(0, s.origY + dy / safeScale),
      });
      // Prevent text selection / scroll while dragging on touch.
      e.preventDefault();
    }
  }

  function endBodyPress(e: React.PointerEvent<HTMLDivElement>) {
    const s = dragRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    if (s.holdTimer) clearTimeout(s.holdTimer);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Browser may have already released — safe to ignore.
    }
    dragRef.current = null;
    if (s.committed) {
      // Suppress the click that would otherwise fire after pointerup
      // on most browsers. We do this by stopping propagation here
      // and relying on the click event happening on whichever
      // element pointer-up fires (the body wrapper, which has no
      // click handler).
      e.preventDefault();
      e.stopPropagation();
    }
    setIsDragging(false);
  }

  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer — see startBodyPress for context */
    }
    const rect = containerRef.current?.getBoundingClientRect();
    resizeRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origW: typeof layout.w === "number" ? layout.w : (rect?.width ?? 240),
      origH: typeof layout.h === "number" ? layout.h : (rect?.height ?? 120),
    };
  }

  function moveResize(e: React.PointerEvent<HTMLDivElement>) {
    const s = resizeRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    onMove({
      w: Math.max(80, s.origW + dx / safeScale),
      h: Math.max(60, s.origH + dy / safeScale),
    });
    e.preventDefault();
  }

  function endResize(e: React.PointerEvent<HTMLDivElement>) {
    const s = resizeRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Same as drag — already released, safe to ignore.
    }
    resizeRef.current = null;
  }

  return (
    <div
      ref={containerRef}
      data-hud-widget={id}
      onPointerDown={startBodyPress}
      onPointerMove={moveBodyPress}
      onPointerUp={endBodyPress}
      onPointerCancel={endBodyPress}
      onClickCapture={(e) => {
        // If we just finished a drag, swallow the synthesized click
        // so children don't see it as a user action.
        if (isDragging) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      style={{
        position: "absolute",
        left: layout.x,
        top: layout.y,
        width: widthVal,
        height: heightVal,
        // ``touch-action: none`` so dragging with a finger doesn't
        // also scroll the page. Critical for the touch-screen UX.
        touchAction: "none",
        // Subtle outline + grab cursor advertise that the widget is
        // movable, without the noisy "edit mode" dashed border the
        // previous version had (the user found that visually loud).
        outline: "1px solid rgba(108, 214, 255, 0.18)",
        outlineOffset: 2,
        boxSizing: "border-box",
        cursor: isDragging ? "grabbing" : "grab",
        transform: isDragging ? "scale(1.02)" : "none",
        transition: isDragging ? "none" : "transform 120ms ease",
        zIndex: isDragging ? 20 : (zIndex ?? 1),
      }}
    >
      {children}

      {/* Resize handle — bottom-right, always visible in custom mode */}
      <div
        role="button"
        tabIndex={-1}
        aria-label={`Resize ${label}`}
        title={`Drag to resize ${label}`}
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        // Stop the body's drag handler from also seeing this
        // pointer down — the resize gesture owns it exclusively.
        data-no-drag
        style={{
          position: "absolute",
          bottom: -6,
          right: -6,
          width: 18,
          height: 18,
          borderRadius: 3,
          background: "rgba(8, 14, 24, 0.9)",
          border: "1px solid var(--hud)",
          boxShadow: "0 0 6px var(--orb-glow)",
          color: "var(--hud)",
          fontSize: 11,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "nwse-resize",
          userSelect: "none",
          touchAction: "none",
          zIndex: 11,
          opacity: 0.85,
        }}
      >
        ⌟
      </div>

      {/* Hide button — top-right, always visible in custom mode */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onHide();
        }}
        aria-label={`Hide ${label}`}
        title={`Hide ${label}`}
        data-no-drag
        style={{
          position: "absolute",
          top: -8,
          right: -8,
          width: 20,
          height: 20,
          borderRadius: "50%",
          background: "rgba(8, 14, 24, 0.9)",
          border: "1px solid var(--accent)",
          boxShadow: "0 0 6px var(--accent-soft)",
          color: "var(--accent)",
          fontSize: 11,
          cursor: "pointer",
          padding: 0,
          lineHeight: 1,
          zIndex: 11,
          opacity: 0.85,
        }}
      >
        ×
      </button>

      {/* Drag-grip hint — top-left, decorative. Doesn't actually
          handle pointer events differently from the rest of the
          widget body (the body itself is the drag target), but
          gives the user a clear visual anchor on touch. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: -8,
          left: -8,
          width: 20,
          height: 20,
          borderRadius: "50%",
          background: "rgba(8, 14, 24, 0.9)",
          border: "1px solid var(--hud)",
          boxShadow: "0 0 6px var(--orb-glow)",
          color: "var(--hud)",
          fontSize: 12,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          pointerEvents: "none",
          zIndex: 11,
          opacity: 0.85,
        }}
      >
        ⠿
      </div>
    </div>
  );
}
