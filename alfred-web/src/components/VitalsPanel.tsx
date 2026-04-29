"use client";

/**
 * VitalsPanel — Alfred's self-diagnostics readout. A small card that
 * polls ``/api/vitals`` and shows each subsystem's status with a
 * one-line "FIX" hint when something is wrong.
 *
 * Mounted as a HudWidget so the user can move it / hide it like any
 * other panel.
 */

import { useEffect, useState } from "react";
import { fetchVitals, type Vital } from "@/lib/workshopApi";

const POLL_MS = 30_000;

export function VitalsPanel() {
  const [vitals, setVitals] = useState<Vital[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const r = await fetchVitals();
        if (!cancelled) {
          setVitals(r.vitals);
          setError(null);
        }
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Vitals unreachable");
      }
    }
    void tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div
      data-testid="vitals-panel"
      style={{
        background: "rgba(8,14,24,0.55)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        padding: "8px 10px",
        fontFamily:
          'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
        fontSize: 11,
        minWidth: 220,
        backdropFilter: "blur(6px)",
      }}
    >
      <div
        style={{
          letterSpacing: 2,
          color: "var(--orb)",
          textShadow: "0 0 6px var(--orb-glow)",
          marginBottom: 6,
        }}
      >
        VITALS
      </div>
      {error ? (
        <div style={{ color: "var(--danger)", fontSize: 10 }}>
          {error}
        </div>
      ) : vitals === null ? (
        <div style={{ color: "var(--muted)", fontSize: 10 }}>
          probing…
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {vitals.map((v) => (
            <VitalRow
              key={v.id}
              vital={v}
              expanded={expandedId === v.id}
              onToggle={() =>
                setExpandedId(expandedId === v.id ? null : v.id)
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

const STATUS_COLOR: Record<Vital["status"], string> = {
  ok: "rgb(110, 230, 160)",
  warn: "rgb(240, 200, 100)",
  err: "rgb(255, 110, 110)",
  off: "rgb(120, 130, 150)",
};

function VitalRow({
  vital,
  expanded,
  onToggle,
}: {
  vital: Vital;
  expanded: boolean;
  onToggle: () => void;
}) {
  const hasDetail = !!(vital.detail || vital.fix);
  return (
    <div
      data-testid={`vital-${vital.id}`}
      data-status={vital.status}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: "2px 0",
        cursor: hasDetail ? "pointer" : "default",
      }}
      onClick={hasDetail ? onToggle : undefined}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          color: "var(--muted)",
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: STATUS_COLOR[vital.status],
            boxShadow: `0 0 6px ${STATUS_COLOR[vital.status]}`,
            flexShrink: 0,
          }}
        />
        <span style={{ flex: 1 }}>{vital.label}</span>
        <span
          style={{
            fontSize: 9,
            color: STATUS_COLOR[vital.status],
            letterSpacing: 1.4,
          }}
        >
          {vital.status.toUpperCase()}
        </span>
      </div>
      {expanded && hasDetail ? (
        <div
          style={{
            fontSize: 10,
            color: "var(--muted)",
            lineHeight: 1.5,
            paddingLeft: 16,
          }}
        >
          <div>{vital.detail}</div>
          {vital.fix ? (
            <div
              style={{
                marginTop: 4,
                color: "var(--orb)",
                opacity: 0.85,
              }}
            >
              FIX: {vital.fix}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
