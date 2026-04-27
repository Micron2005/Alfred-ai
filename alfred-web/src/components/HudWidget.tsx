"use client";

/**
 * HudWidget — wrapper that adds drag, resize, and hide affordances
 * to any HUD child element when the user enters customize mode.
 *
 * In default (non-custom) mode the widget renders its children
 * inline with no styling overhead, so the out-of-the-box HUD layout
 * is unaffected for users who never touch the customize feature.
 *
 * In custom mode the widget switches to absolute positioning at the
 * saved ``layout.{x,y,w,h}`` and (when ``editMode`` is on) shows
 * three handles:
 *   - Drag handle  (⠿) at the top-left — pointer-drag to reposition.
 *   - Resize handle (⌟) at the bottom-right — pointer-drag to resize.
 *   - Hide button   (×) at the top-right — click to hide the widget.
 *
 * Pointer capture (``setPointerCapture``) is used for both drag and
 * resize so the gesture continues even if the cursor briefly leaves
 * the handle (common when dragging fast).
 */

import { useRef } from "react";
import type { HudWidgetId, WidgetLayout } from "@/lib/hudLayout";

interface Props {
  id: HudWidgetId;
  label: string;
  layout: WidgetLayout;
  customEnabled: boolean;
  editMode: boolean;
  onMove: (patch: Partial<WidgetLayout>) => void;
  onHide: () => void;
  /** When ``true``, the widget renders nothing (still mounted for
   *  ref stability — but ``display:none`` so it doesn't affect
   *  layout). The hidden state is owned by the parent so it can
   *  show a "show" chip in its customize toolbar. */
  hidden?: boolean;
  children: React.ReactNode;
}

export function HudWidget({
  id,
  label,
  layout,
  customEnabled,
  editMode,
  onMove,
  onHide,
  hidden,
  children,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const resizeStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origW: number;
    origH: number;
  } | null>(null);

  if (hidden) {
    return (
      <div
        data-hud-widget={id}
        aria-hidden
        style={{ display: "none" }}
      />
    );
  }

  // Non-custom mode — pure pass-through. Children render in their
  // original flow position. This is the default for users who never
  // toggle customize mode.
  if (!customEnabled) {
    return <div data-hud-widget={id}>{children}</div>;
  }

  const widthVal: string | number =
    layout.w === "auto" ? "auto" : `${layout.w}px`;
  const heightVal: string | number =
    layout.h === "auto" ? "auto" : `${layout.h}px`;

  function startDrag(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStateRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origX: layout.x,
      origY: layout.y,
    };
  }

  function moveDrag(e: React.PointerEvent<HTMLDivElement>) {
    const s = dragStateRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    onMove({
      x: Math.max(0, s.origX + dx),
      y: Math.max(0, s.origY + dy),
    });
  }

  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    const s = dragStateRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Pointer capture may already be released by the browser if
      // the gesture ended outside the page; safe to ignore.
    }
    dragStateRef.current = null;
  }

  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = containerRef.current?.getBoundingClientRect();
    resizeStateRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origW: typeof layout.w === "number" ? layout.w : (rect?.width ?? 240),
      origH: typeof layout.h === "number" ? layout.h : (rect?.height ?? 120),
    };
  }

  function moveResize(e: React.PointerEvent<HTMLDivElement>) {
    const s = resizeStateRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    onMove({
      w: Math.max(80, s.origW + dx),
      h: Math.max(60, s.origH + dy),
    });
  }

  function endResize(e: React.PointerEvent<HTMLDivElement>) {
    const s = resizeStateRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Same as above — browser may already have released.
    }
    resizeStateRef.current = null;
  }

  return (
    <div
      ref={containerRef}
      data-hud-widget={id}
      style={{
        position: "absolute",
        left: layout.x,
        top: layout.y,
        width: widthVal,
        height: heightVal,
        // While editing, give the widget a faint outline so the user
        // can see what they're dragging; outside edit mode the
        // outline disappears so the HUD looks clean.
        outline: editMode
          ? "1px dashed rgba(108, 214, 255, 0.55)"
          : "none",
        outlineOffset: 2,
        // ``box-sizing: border-box`` so explicit width/height include
        // padding/border (matters when widgets have their own
        // padded card styling).
        boxSizing: "border-box",
        zIndex: editMode ? 10 : 1,
      }}
    >
      {children}

      {editMode ? (
        <>
          {/* Drag handle — top-left */}
          <div
            role="button"
            tabIndex={0}
            aria-label={`Move ${label}`}
            title={`Drag to move ${label}`}
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            style={{
              position: "absolute",
              top: -10,
              left: -10,
              width: 22,
              height: 22,
              borderRadius: "50%",
              background: "rgba(8, 14, 24, 0.92)",
              border: "1px solid var(--hud)",
              boxShadow: "0 0 8px var(--orb-glow)",
              color: "var(--hud)",
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "grab",
              userSelect: "none",
              touchAction: "none",
              zIndex: 11,
            }}
          >
            ⠿
          </div>

          {/* Hide button — top-right */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onHide();
            }}
            aria-label={`Hide ${label}`}
            title={`Hide ${label}`}
            style={{
              position: "absolute",
              top: -10,
              right: -10,
              width: 22,
              height: 22,
              borderRadius: "50%",
              background: "rgba(8, 14, 24, 0.92)",
              border: "1px solid var(--accent)",
              boxShadow: "0 0 8px var(--accent-soft)",
              color: "var(--accent)",
              fontSize: 12,
              cursor: "pointer",
              padding: 0,
              lineHeight: 1,
              zIndex: 11,
            }}
          >
            ×
          </button>

          {/* Resize handle — bottom-right */}
          <div
            role="button"
            tabIndex={0}
            aria-label={`Resize ${label}`}
            title={`Drag to resize ${label}`}
            onPointerDown={startResize}
            onPointerMove={moveResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            style={{
              position: "absolute",
              bottom: -8,
              right: -8,
              width: 18,
              height: 18,
              borderRadius: 3,
              background: "rgba(8, 14, 24, 0.92)",
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
            }}
          >
            ⌟
          </div>

          {/* Label badge — bottom-left, only while editing */}
          <div
            className="mono"
            aria-hidden
            style={{
              position: "absolute",
              left: 0,
              bottom: -22,
              fontSize: 9,
              letterSpacing: 1.2,
              color: "var(--muted)",
              background: "rgba(8, 14, 24, 0.7)",
              padding: "1px 6px",
              borderRadius: 2,
              pointerEvents: "none",
              whiteSpace: "nowrap",
            }}
          >
            {label.toUpperCase()}
          </div>
        </>
      ) : null}
    </div>
  );
}
