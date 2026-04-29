"use client";

/**
 * VitalsPanel — Alfred's self-diagnostics readout.
 *
 * Polls ``/api/vitals`` every 30 s and renders one row per subsystem
 * with its status (ok/warn/err/off), a one-line FIX hint, and —
 * when something is actually broken — a "ASK ALFRED TO FIX" button
 * that opens the Workshop with the problem statement and the most
 * likely candidate files pre-selected. That button is the
 * "self-healing" hook the user asked for: one click and Alfred
 * starts diagnosing himself.
 */

import { useEffect, useState } from "react";
import { fetchVitals, type Vital } from "@/lib/workshopApi";

const POLL_MS = 30_000;

/** Map a Vital ID to the files Alfred should self-load when the user
 *  asks him to diagnose that subsystem. Tightly scoped — picking
 *  good defaults beats dumping the entire repo into the LLM. */
const SELF_HEAL_FILES: Record<string, string[]> = {
  ollama: [
    "alfred-core/src/alfred_core/llm/local.py",
    "alfred-core/src/alfred_core/router.py",
    "alfred-core/src/alfred_core/config.py",
  ],
  cloud: [
    "alfred-core/src/alfred_core/llm/anthropic_backend.py",
    "alfred-core/src/alfred_core/router.py",
    "alfred-core/src/alfred_core/config.py",
  ],
  db: [
    "alfred-core/src/alfred_core/db/session.py",
    "alfred-core/src/alfred_core/db/models.py",
  ],
  tavily: [
    "alfred-core/src/alfred_core/tools/web_search.py",
    "alfred-core/src/alfred_core/api/chat.py",
  ],
  gmail: [
    "alfred-core/src/alfred_core/api/email.py",
    "alfred-core/src/alfred_core/config.py",
  ],
  spotify: [
    "alfred-core/src/alfred_core/api/spotify.py",
    "alfred-core/src/alfred_core/config.py",
  ],
  printer: [
    "alfred-core/src/alfred_core/api/printer.py",
    "alfred-core/src/alfred_core/config.py",
  ],
};

interface VitalsPanelProps {
  /** Called when the user clicks "ASK ALFRED TO FIX" on a red vital.
   *  Receives the prompt + suggested files so the parent can route
   *  to the Workshop sub-view with state pre-populated. */
  onSelfHeal?: (problem: string, paths: string[]) => void;
}

export function VitalsPanel({ onSelfHeal }: VitalsPanelProps = {}) {
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
          {vitals.map((v) => {
            // Only attach a self-heal callback when the subsystem is
            // actually misbehaving (err/warn). Healthy / off-by-design
            // rows don't need a "fix me" button — clicking it would
            // just have Alfred chase a phantom.
            const canSelfHeal =
              !!onSelfHeal && (v.status === "err" || v.status === "warn");
            return (
              <VitalRow
                key={v.id}
                vital={v}
                expanded={expandedId === v.id}
                onToggle={() =>
                  setExpandedId(expandedId === v.id ? null : v.id)
                }
                onSelfHeal={
                  canSelfHeal && onSelfHeal
                    ? () => {
                        const files = SELF_HEAL_FILES[v.id] ?? [];
                        const problem =
                          `Vitals reports ${v.label} as ${v.status.toUpperCase()}: ` +
                          `${v.detail}` +
                          (v.fix ? `\n\nSuggested fix: ${v.fix}` : "") +
                          `\n\nRead the attached files and propose a code change ` +
                          `that addresses the root cause (not just a workaround).`;
                        onSelfHeal(problem, files);
                      }
                    : undefined
                }
              />
            );
          })}
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
  onSelfHeal,
}: {
  vital: Vital;
  expanded: boolean;
  onToggle: () => void;
  onSelfHeal?: () => void;
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
          {onSelfHeal ? (
            <button
              type="button"
              data-testid={`vital-self-heal-${vital.id}`}
              onClick={(e) => {
                e.stopPropagation();
                onSelfHeal();
              }}
              className="hud-button"
              style={{
                marginTop: 6,
                fontSize: 9,
                padding: "3px 8px",
                letterSpacing: 1.5,
              }}
            >
              🔧 ASK ALFRED TO FIX
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
