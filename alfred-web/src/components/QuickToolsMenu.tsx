"use client";

/**
 * QuickToolsMenu — radial pop-up triggered by closing the left
 * hand into a fist. Hosts shortcuts to common HUD actions
 * (voice in/out, camera toggle, mode toggle, focus composer)
 * so the user doesn't have to hunt for buttons in the toolbar
 * while operating the HUD via hand gestures.
 *
 * Lifecycle (managed by ChatWindow):
 *   - Mount when ``visible`` flips true (left hand closed into fist)
 *   - Anchor position is captured at mount time and frozen — the
 *     menu does NOT follow either hand. This is intentional: a
 *     menu chasing the cursor would create a feedback loop where
 *     the user can never click an item.
 *   - Item activation: right-hand pinch over the item button.
 *     Synthetic pointer events from HandCursor route through the
 *     real ``onClick`` handlers on each <button>, so this
 *     component doesn't need to know anything about hand tracking
 *     directly.
 *   - Closes when the user un-fists (``visible`` → false) OR when
 *     an item is activated.
 */

import { useEffect, useRef } from "react";

interface QuickToolsItem {
  /** Stable id used as the React key. */
  id: string;
  /** Single-glyph label rendered inside the button. */
  glyph: string;
  /** Short caption rendered below the glyph. */
  label: string;
  /** ``true`` shows the button highlighted (e.g. feature is on). */
  active?: boolean;
  /**
   * Fired when the user clicks (or right-pinches over) the button.
   * The menu auto-closes after this — implementations don't need
   * to call any "close" function themselves.
   */
  onActivate: () => void;
}

interface Props {
  /** Whether the menu should be rendered at all. */
  visible: boolean;
  /**
   * Anchor center in viewport pixels. The menu positions its
   * items in a ring around this point. Captured at fist start so
   * the user can settle on a comfortable spot; the menu doesn't
   * track the hand once it's open.
   */
  anchor: { x: number; y: number } | null;
  /** Item buttons to render, in display order. */
  items: QuickToolsItem[];
  /**
   * Called when an item is activated, after the item's own
   * ``onActivate`` has fired. Intended for the parent to flip the
   * "menu visible" flag back to false.
   */
  onActivated: () => void;
}

const RADIUS_PX = 130;
const BUTTON_PX = 84;
const CYAN = "rgba(0, 229, 255, 0.95)";
const CYAN_DIM = "rgba(0, 229, 255, 0.55)";
const CYAN_BG = "rgba(0, 17, 28, 0.85)";
const GOLD = "rgba(255, 200, 60, 0.95)";

export function QuickToolsMenu({
  visible,
  anchor,
  items,
  onActivated,
}: Props) {
  // Anchor is frozen on first render after ``visible`` flips true,
  // so a moving left hand doesn't drag the menu around. Captured
  // here so the parent doesn't have to remember to do it.
  const frozenAnchor = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (visible && anchor && !frozenAnchor.current) {
      frozenAnchor.current = anchor;
    } else if (!visible) {
      frozenAnchor.current = null;
    }
  }, [visible, anchor]);

  if (!visible) return null;
  const center = frozenAnchor.current ?? anchor;
  if (!center) return null;

  // Clamp the center so all the buttons fit on-screen — the user
  // can be standing close to the edge of frame which would
  // otherwise put half the ring off the right viewport edge.
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const margin = RADIUS_PX + BUTTON_PX / 2 + 16;
  const cx = Math.min(Math.max(center.x, margin), vw - margin);
  const cy = Math.min(Math.max(center.y, margin), vh - margin);

  // Distribute buttons evenly around the ring, starting from the
  // top (-90°) and going clockwise so item order matches reading
  // order at a glance.
  const total = items.length;

  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 99997, // just below the cursor + skeleton overlay
      }}
    >
      {/* Subtle dimmer — visually de-emphasises the rest of the HUD
          while the menu is up. Doesn't block clicks; the cursor
          still reaches widgets underneath if the user pinches off
          the menu. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at center, rgba(0, 17, 28, 0.0) 0%, rgba(0, 17, 28, 0.45) 70%)",
          pointerEvents: "none",
        }}
      />

      {/* Anchor ring — gold loop around the central point so the
          user has a clear visual confirmation that their fist was
          recognised. */}
      <div
        style={{
          position: "absolute",
          left: cx - RADIUS_PX,
          top: cy - RADIUS_PX,
          width: RADIUS_PX * 2,
          height: RADIUS_PX * 2,
          borderRadius: "50%",
          border: `2px dashed ${GOLD}`,
          opacity: 0.55,
          pointerEvents: "none",
        }}
      />

      {items.map((item, i) => {
        const angle = -Math.PI / 2 + (i / total) * Math.PI * 2;
        const bx = cx + Math.cos(angle) * RADIUS_PX - BUTTON_PX / 2;
        const by = cy + Math.sin(angle) * RADIUS_PX - BUTTON_PX / 2;
        const stroke = item.active ? GOLD : CYAN;
        const glyphColor = item.active ? GOLD : CYAN;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              item.onActivate();
              onActivated();
            }}
            style={{
              position: "absolute",
              left: bx,
              top: by,
              width: BUTTON_PX,
              height: BUTTON_PX,
              borderRadius: 14,
              border: `1.5px solid ${stroke}`,
              background: CYAN_BG,
              color: glyphColor,
              fontFamily:
                "'Orbitron', 'Eurostile', 'Bank Gothic', system-ui, sans-serif",
              fontSize: 13,
              letterSpacing: 1.2,
              textTransform: "uppercase",
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              boxShadow: `0 0 18px ${item.active ? GOLD : CYAN_DIM}`,
              pointerEvents: "auto",
              padding: 0,
              transition: "transform 80ms ease, box-shadow 80ms ease",
            }}
          >
            <span
              style={{
                fontSize: 28,
                lineHeight: 1,
                fontFamily: "system-ui, 'Apple Color Emoji', sans-serif",
              }}
            >
              {item.glyph}
            </span>
            <span style={{ fontSize: 11 }}>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
