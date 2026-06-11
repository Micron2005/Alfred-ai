"use client";

/**
 * PrinterWidget — bottom strip in the Design tab showing live
 * Creality K1 Max status (via the existing Moonraker API exposed
 * at ``http://<printer-ip>:7125``). Polls every 3 s.
 *
 * Auto-hides when the backend reports the printer isn't
 * configured (no ``ALFRED_PRINTER_URL`` in ``.env``) — saves
 * surfacing an empty panel for users who haven't wired up a
 * printer yet.
 */

import { useCallback, useEffect, useState } from "react";

import {
  type PrinterState,
  type PrinterStatus,
  cancelPrint,
  getPrinterStatus,
  pausePrint,
  resumePrint,
} from "@/lib/printerApi";

const POLL_INTERVAL_MS = 3000;

const STATE_COLOUR: Record<PrinterState, string> = {
  ready: "rgba(108, 214, 255, 0.92)",
  printing: "rgba(102, 240, 160, 0.95)",
  paused: "rgba(255, 200, 60, 0.95)",
  error: "rgba(255, 120, 120, 0.95)",
  disconnected: "rgba(180, 180, 180, 0.7)",
  unknown: "rgba(180, 180, 180, 0.7)",
};

function fmtTime(sec: number | null | undefined): string {
  if (!sec || sec <= 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function PrinterWidget() {
  const [status, setStatus] = useState<PrinterStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [actBusy, setActBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await getPrinterStatus();
      setStatus(next);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Printer offline");
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  // If the backend hasn't been told about a printer at all, fold
  // the strip into a tiny "configure printer" hint instead of a
  // dead panel.
  if (status && !status.configured) {
    return (
      <div
        data-testid="printer-not-configured"
        style={{
          padding: "6px 14px",
          background: "rgba(8, 14, 24, 0.78)",
          borderTop: "1px solid var(--border)",
          backdropFilter: "blur(8px)",
          fontFamily:
            'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
          fontSize: 10,
          color: "var(--muted)",
          textAlign: "center",
          letterSpacing: 1.4,
          textTransform: "uppercase",
          opacity: 0.75,
        }}
      >
        Printer not configured · set <code>ALFRED_PRINTER_URL</code> in .env to
        connect your K1 Max
      </div>
    );
  }

  if (err && !status) {
    return (
      <div
        data-testid="printer-error"
        style={{
          padding: "8px 14px",
          background: "rgba(8, 14, 24, 0.78)",
          borderTop: "1px solid rgba(255,120,120,0.4)",
          backdropFilter: "blur(8px)",
          fontFamily:
            'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
          fontSize: 10,
          color: "rgba(255,120,120,0.95)",
          letterSpacing: 1.2,
        }}
      >
        Printer · {err}
      </div>
    );
  }

  if (!status) {
    return (
      <div
        style={{
          padding: "8px 14px",
          background: "rgba(8, 14, 24, 0.78)",
          borderTop: "1px solid var(--border)",
          fontSize: 10,
          color: "var(--muted)",
          fontFamily:
            'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
        }}
      >
        Connecting to printer…
      </div>
    );
  }

  const colour = STATE_COLOUR[status.state];
  const pct = Math.max(0, Math.min(1, status.progress));

  async function act(fn: () => Promise<void>) {
    if (actBusy) return;
    setActBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Action failed");
    } finally {
      setActBusy(false);
    }
  }

  return (
    <div
      data-testid="printer-widget"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "8px 14px",
        background: "rgba(8, 14, 24, 0.85)",
        borderTop: `1px solid ${colour}`,
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        fontFamily:
          'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
        fontSize: 10,
        color: "var(--hud)",
        letterSpacing: 1,
        flexWrap: "wrap",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: colour,
            boxShadow: `0 0 8px ${colour}`,
          }}
        />
        <span
          data-testid="printer-state"
          style={{
            color: colour,
            textTransform: "uppercase",
            letterSpacing: 1.6,
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          K1 MAX · {status.state}
        </span>
      </div>

      {status.filename ? (
        <div style={{ opacity: 0.85, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {status.filename}
        </div>
      ) : null}

      {status.state === "printing" || status.state === "paused" ? (
        <div style={{ flex: 1, minWidth: 120, display: "flex", alignItems: "center", gap: 8 }}>
          <div
            style={{
              flex: 1,
              height: 4,
              background: "rgba(255,255,255,0.08)",
              borderRadius: 2,
              overflow: "hidden",
            }}
          >
            <div
              data-testid="printer-progress"
              style={{
                width: `${(pct * 100).toFixed(1)}%`,
                height: "100%",
                background: colour,
                boxShadow: `0 0 8px ${colour}`,
                transition: "width 600ms ease",
              }}
            />
          </div>
          <span style={{ minWidth: 36, textAlign: "right", opacity: 0.85 }}>
            {(pct * 100).toFixed(0)}%
          </span>
          <span style={{ opacity: 0.7 }}>
            ETA {fmtTime(status.estimated_time_left_seconds)}
          </span>
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 12, opacity: 0.85 }}>
        <span>
          🌡 {status.temps.extruder.actual.toFixed(0)}/
          {status.temps.extruder.target.toFixed(0)}°
        </span>
        <span>
          🛏 {status.temps.bed.actual.toFixed(0)}/
          {status.temps.bed.target.toFixed(0)}°
        </span>
        {status.temps.chamber ? (
          <span>
            📦 {status.temps.chamber.actual.toFixed(0)}/
            {status.temps.chamber.target.toFixed(0)}°
          </span>
        ) : null}
      </div>

      {status.state === "printing" ? (
        <button
          type="button"
          data-testid="printer-pause"
          className="hud-button"
          onClick={() => void act(pausePrint)}
          disabled={actBusy}
          style={{ padding: "3px 10px", fontSize: 9 }}
        >
          PAUSE
        </button>
      ) : null}
      {status.state === "paused" ? (
        <button
          type="button"
          data-testid="printer-resume"
          className="hud-button"
          onClick={() => void act(resumePrint)}
          disabled={actBusy}
          style={{ padding: "3px 10px", fontSize: 9 }}
        >
          RESUME
        </button>
      ) : null}
      {status.state === "printing" || status.state === "paused" ? (
        <button
          type="button"
          data-testid="printer-cancel"
          className="hud-button"
          onClick={() => {
            if (window.confirm("Cancel the current print?")) {
              void act(cancelPrint);
            }
          }}
          disabled={actBusy}
          style={{
            padding: "3px 10px",
            fontSize: 9,
            color: "rgba(255,120,120,0.95)",
            borderColor: "rgba(255,120,120,0.5)",
          }}
        >
          CANCEL
        </button>
      ) : null}
    </div>
  );
}
