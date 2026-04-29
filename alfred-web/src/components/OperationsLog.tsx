"use client";

import { useEffect, useRef, useState } from "react";

/**
 * OperationsLog — bottom-left timestamped activity feed.
 *
 * Surfaces what Alfred is doing in plain language. Entries are
 * pushed via the parent (whenever a meaningful state change happens);
 * we keep the most recent N and timestamp them as HH:MM:SS.
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

export function OperationsLog({ entries, limit = 6 }: Props) {
  const visible = entries.slice(-limit).reverse();
  return (
    <div
      data-testid="operations-log"
      style={{
        position: "fixed",
        left: 22,
        bottom: 26,
        zIndex: 30,
        minWidth: 230,
        maxWidth: 320,
        padding: "10px 14px 12px",
        background:
          "linear-gradient(180deg, rgba(8,12,22,0.78), rgba(8,12,22,0.55))",
        border: "1px solid var(--border)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        pointerEvents: "none",
      }}
    >
      <p
        className="mono"
        style={{
          margin: "0 0 6px",
          fontSize: 9,
          letterSpacing: 2.5,
          color: "var(--hud)",
          textShadow: "0 0 6px var(--orb-glow)",
          opacity: 0.9,
        }}
      >
        OPERATIONS LOG
      </p>
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
