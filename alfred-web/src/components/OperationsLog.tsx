"use client";

import { useEffect, useRef, useState } from "react";

/**
 * OperationsLog — draggable timestamped activity feed.
 *
 * Surfaces what Alfred is doing in plain language. Entries are
 * pushed via the parent (whenever a meaningful state change happens);
 * we keep the most recent N and timestamp them as HH:MM:SS.
 *
 * Per user request (Feb 2026), the log is now draggable: a tiny
 * "⠿ OPS" handle at the top-left of the panel grabs it; drag
 * anywhere on screen and the position persists to localStorage.
 * The body of the panel stays ``pointer-events: none`` so it
 * never intercepts clicks meant for the orb / widgets behind it.
 *
 * Designed to be controlled from above so the parent can de-dupe
 * repeat states (e.g. multiple "LISTENING" toggles in 200ms).
 */

export interface OpsLogEntry {
  /** Stable identifier — usually `${timestamp}-${tag}` so React
   *  keys stay unique even when the tag repeats minutes later. */
  id: string;
  /** Short uppercase tag — e.g. "LISTENING", "STANDBY". */
  tag: string;
  /** Optional verbose detail rendered after the tag in muted text. */
  detail?: string;
  /** Epoch ms; rendered as HH:MM:SS in the local timezone. */
  ts: number;
  /** Visual variant. "live" highlights the most recent active state. */
  level?: "live" | "info" | "warn";
}

interface Props {
  entries: OpsLogEntry[];
  /** Keep at most this many on screen. Default 6. */
  limit?: number;
}

const STORAGE_KEY = "alfred.opsLog.pos.v1";
// Default lands bottom-left where the log lived before it was
// draggable — so existing users see no visual change until they
// move it.
const DEFAULT_POS = { x: 22, y: -1 }; // y = -1 means "bottom-anchored"

interface Pos {
  x: number;
  y: number;
}

function readPos(): Pos {
  if (typeof window === "undefined") return DEFAULT_POS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_POS;
    const parsed = JSON.parse(raw) as Partial<Pos>;
    return {
      x: typeof parsed.x === "number" ? parsed.x : DEFAULT_POS.x,
      y: typeof parsed.y === "number" ? parsed.y : DEFAULT_POS.y,
    };
  } catch {
    return DEFAULT_POS;
  }
}

function writePos(pos: Pos) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pos));
  } catch {
    /* ignore */
  }
}

export function OperationsLog({ entries, limit = 6 }: Props) {
  const visible = entries.slice(-limit).reverse();
  const [pos, setPos] = useState<Pos>(DEFAULT_POS);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setPos(readPos());
    setHydrated(true);
  }, []);

  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  function startDrag(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    // First-time drag: convert from "bottom-anchored" default to a
    // top-anchored absolute Y so dragging works as expected. Read
    // the current rendered position from the DOM so the panel
    // doesn't visually jump on the first drag pixel.
    const parent = e.currentTarget.parentElement;
    const rect = parent?.getBoundingClientRect();
    const origX = rect ? rect.left : pos.x;
    const origY = rect ? rect.top : pos.y >= 0 ? pos.y : 0;
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origX,
      origY,
    };
  }

  function moveDrag(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const next = {
      x: Math.max(0, drag.origX + dx),
      y: Math.max(0, drag.origY + dy),
    };
    setPos(next);
    writePos(next);
  }

  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    dragRef.current = null;
  }

  // Server-render & first-paint: stick with the legacy bottom-left
  // anchor so there's no layout flicker. After hydration we switch
  // to absolute top-anchored coordinates if the user has dragged it.
  const useBottomAnchor = !hydrated || pos.y < 0;

  return (
    <div
      data-testid="operations-log"
      style={{
        position: "fixed",
        ...(useBottomAnchor
          ? { left: pos.x, bottom: 26 }
          : { left: pos.x, top: pos.y }),
        zIndex: 30,
        minWidth: 230,
        maxWidth: 320,
        padding: "10px 14px 12px",
        background:
          "linear-gradient(180deg, rgba(8,12,22,0.78), rgba(8,12,22,0.55))",
        border: "1px solid var(--border)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        // Body itself doesn't intercept pointer events — only the
        // explicit drag handle does. This way the user can still
        // click through the log onto whatever's underneath it.
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          margin: "0 0 6px",
        }}
      >
        <div
          data-testid="operations-log-handle"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          title="Drag to move the operations log"
          aria-label="Drag operations log"
          style={{
            // Re-enable pointer events on JUST the handle so the
            // user can grab it. Cursor signals draggability.
            pointerEvents: "auto",
            cursor: "grab",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 14,
            height: 14,
            color: "var(--muted)",
            fontSize: 10,
            letterSpacing: 0,
            userSelect: "none",
            touchAction: "none",
          }}
        >
          ⠿
        </div>
        <p
          className="mono"
          style={{
            margin: 0,
            fontSize: 9,
            letterSpacing: 2.5,
            color: "var(--hud)",
            textShadow: "0 0 6px var(--orb-glow)",
            opacity: 0.9,
          }}
        >
          OPERATIONS LOG
        </p>
      </div>
      {visible.length === 0 ? (
        <p
          className="mono"
          style={{
            margin: 0,
            fontSize: 10,
            color: "var(--muted)",
            opacity: 0.7,
          }}
        >
          —
        </p>
      ) : (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "flex",
            flexDirection: "column",
            gap: 3,
          }}
        >
          {visible.map((e, idx) => (
            <li
              key={e.id}
              className="mono"
              data-testid={`ops-log-row-${idx}`}
              style={{
                fontSize: 10,
                letterSpacing: 1,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                opacity: idx === 0 ? 1 : 0.55 - idx * 0.06,
                color:
                  e.level === "live" && idx === 0
                    ? "var(--hud)"
                    : e.level === "warn"
                      ? "var(--accent)"
                      : "var(--fg)",
                textShadow:
                  idx === 0 && e.level === "live"
                    ? "0 0 8px var(--orb-glow)"
                    : "none",
              }}
            >
              <span style={{ color: "var(--muted)" }}>{formatTime(e.ts)}</span>{" "}
              <span style={{ letterSpacing: 1.5 }}>{e.tag}</span>
              {e.detail ? (
                <span style={{ color: "var(--muted)" }}> · {e.detail}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * useOperationsLog — append-only log keyed by ``tag``. When you
 * call ``log("LISTENING", "mic active")`` repeatedly with the same
 * tag in quick succession, only the first call adds an entry; the
 * tag has to change before another row is added. Keeps the feed
 * meaningful instead of noisy.
 */
export function useOperationsLog(maxEntries = 24) {
  const [entries, setEntries] = useState<OpsLogEntry[]>([]);
  const lastTagRef = useRef<string | null>(null);

  function log(tag: string, detail?: string, level: OpsLogEntry["level"] = "live") {
    if (lastTagRef.current === tag) return;
    lastTagRef.current = tag;
    const ts = Date.now();
    setEntries((prev) => {
      const next = [
        ...prev,
        { id: `${ts}-${tag}-${Math.random().toString(36).slice(2, 6)}`, tag, detail, ts, level },
      ];
      return next.length > maxEntries ? next.slice(-maxEntries) : next;
    });
  }

  // Seed on mount so the panel doesn't sit empty for the first few
  // seconds before any state transitions happen.
  useEffect(() => {
    if (entries.length === 0) {
      log("BOOT", "system online", "info");
      log("STANDBY");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { entries, log };
}
