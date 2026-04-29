"use client";

/**
 * WorkshopView — Alfred's self-coding console.
 *
 * Workflow:
 *   1. User picks files he thinks are relevant from the file tree
 *      (left rail).
 *   2. Types the problem in plain English ("the radial menu Spotify
 *      icon doesn't pulse").
 *   3. Clicks DIAGNOSE — backend reads the chosen files, asks
 *      Anthropic Claude (or local fallback) for a unified-diff
 *      patch, returns it.
 *   4. User reads the explanation + diff. Clicks APPLY to commit
 *      the patch via ``git apply`` on the host. Clicks DISCARD to
 *      throw it away.
 *
 * Backend safety: file reads + writes are restricted to a hard-coded
 * allowlist of repo subtrees (no .env, no .git, no /etc). See
 * ``alfred-core/src/alfred_core/api/workshop.py``.
 */

import { useEffect, useState } from "react";
import {
  applyWorkshopPatch,
  diagnoseProblem,
  listWorkshopFiles,
  type WorkshopFile,
} from "@/lib/workshopApi";

interface WorkshopViewProps {
  onBack: () => void;
}

export function WorkshopView({ onBack }: WorkshopViewProps) {
  const [files, setFiles] = useState<WorkshopFile[]>([]);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [diagnosis, setDiagnosis] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listWorkshopFiles()
      .then((r) => setFiles(r.files))
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Could not list files"),
      );
  }, []);

  function togglePick(p: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  async function runDiagnose() {
    setBusy(true);
    setError(null);
    setDiagnosis(null);
    setDiff(null);
    setApplyResult(null);
    try {
      const r = await diagnoseProblem({
        problem,
        paths: Array.from(picked),
      });
      setDiagnosis(r.explanation);
      // Pull the first ```diff fenced block out of the explanation
      // for the dedicated diff view. The fence rule: ``` followed
      // by an optional language tag, then content, then closing ```.
      const m = r.explanation.match(/```diff\n([\s\S]*?)```/);
      if (m) setDiff(m[1].trimEnd() + "\n");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Diagnose failed");
    } finally {
      setBusy(false);
    }
  }

  async function runApply() {
    if (!diff) return;
    if (
      !window.confirm(
        "Apply this patch to your local repository? You can git diff to review afterwards.",
      )
    )
      return;
    setBusy(true);
    setApplyResult(null);
    setError(null);
    try {
      const r = await applyWorkshopPatch(diff);
      setApplyResult(
        r.applied
          ? `✓ Applied to ${r.files_touched.join(", ")}`
          : `✗ ${r.detail}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Apply failed");
    } finally {
      setBusy(false);
    }
  }

  const filteredFiles = filter.trim()
    ? files.filter((f) =>
        f.path.toLowerCase().includes(filter.trim().toLowerCase()),
      )
    : files;

  return (
    <div
      data-testid="workshop-view"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 8500,
        background:
          "radial-gradient(circle at 30% 30%, rgba(20,40,70,1) 0%, rgba(0,0,0,1) 70%)",
        display: "flex",
        flexDirection: "column",
        color: "var(--muted)",
        fontFamily:
          'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "12px 18px",
          borderBottom: "1px solid var(--border)",
          background: "rgba(8,14,24,0.85)",
        }}
      >
        <button
          type="button"
          data-testid="subview-back"
          onClick={onBack}
          className="hud-button"
        >
          ← BACK
        </button>
        <div
          style={{
            fontSize: 12,
            letterSpacing: 4,
            color: "var(--orb)",
            textShadow: "0 0 8px var(--orb-glow)",
          }}
        >
          WORKSHOP · SELF-CODING CONSOLE
        </div>
      </div>

      <div
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "320px 1fr",
          gap: 18,
          padding: 18,
          minHeight: 0,
        }}
      >
        {/* LEFT — file tree + filter */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: 12,
            background: "rgba(8,14,24,0.55)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              fontSize: 10,
              letterSpacing: 2,
              color: "var(--orb)",
            }}
          >
            FILES · {picked.size}/{files.length} PICKED
          </div>
          <input
            data-testid="workshop-filter"
            type="search"
            placeholder="filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{
              padding: "4px 8px",
              fontSize: 11,
              background: "rgba(0,0,0,0.4)",
              border: "1px solid var(--border)",
              color: "var(--orb)",
              borderRadius: 3,
            }}
          />
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              fontSize: 10,
              minHeight: 0,
            }}
          >
            {filteredFiles.map((f) => {
              const on = picked.has(f.path);
              return (
                <label
                  key={f.path}
                  data-testid={`workshop-file-${f.path}`}
                  style={{
                    display: "flex",
                    gap: 6,
                    padding: "2px 0",
                    cursor: "pointer",
                    color: on ? "var(--orb)" : "var(--muted)",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => togglePick(f.path)}
                    style={{ accentColor: "rgb(108,214,255)" }}
                  />
                  <span style={{ flex: 1, wordBreak: "break-all" }}>
                    {f.path}
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        {/* RIGHT — problem statement + diagnosis + diff */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            minHeight: 0,
          }}
        >
          <textarea
            data-testid="workshop-problem"
            value={problem}
            onChange={(e) => setProblem(e.target.value)}
            placeholder="Describe what's broken. Be specific. Alfred reads the files you picked and proposes a patch."
            rows={4}
            style={{
              padding: 10,
              fontSize: 12,
              fontFamily: "inherit",
              background: "rgba(0,0,0,0.4)",
              border: "1px solid var(--border)",
              color: "var(--orb)",
              borderRadius: 4,
              resize: "vertical",
            }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              data-testid="workshop-diagnose"
              className="hud-button"
              onClick={runDiagnose}
              disabled={busy || !problem.trim() || picked.size === 0}
            >
              {busy ? "…" : "🔧 DIAGNOSE"}
            </button>
            {diff ? (
              <button
                type="button"
                data-testid="workshop-apply"
                className="hud-button"
                onClick={runApply}
                disabled={busy}
              >
                ✓ APPLY PATCH
              </button>
            ) : null}
          </div>

          {error ? (
            <div
              style={{
                color: "var(--danger)",
                fontSize: 12,
                background: "rgba(255,80,80,0.06)",
                border: "1px solid rgba(255,80,80,0.3)",
                padding: 10,
                borderRadius: 3,
              }}
            >
              {error}
            </div>
          ) : null}

          {applyResult ? (
            <div
              data-testid="workshop-apply-result"
              style={{
                color: applyResult.startsWith("✓")
                  ? "rgb(110,230,160)"
                  : "rgb(255,110,110)",
                fontSize: 12,
                padding: 10,
                background: "rgba(0,0,0,0.4)",
                border: "1px solid var(--border)",
                borderRadius: 3,
              }}
            >
              {applyResult}
            </div>
          ) : null}

          {diagnosis ? (
            <div
              data-testid="workshop-diagnosis"
              style={{
                flex: 1,
                overflowY: "auto",
                background: "rgba(0,0,0,0.5)",
                border: "1px solid var(--border)",
                padding: 14,
                borderRadius: 4,
                color: "var(--muted)",
                fontSize: 12,
                lineHeight: 1.55,
                whiteSpace: "pre-wrap",
                minHeight: 0,
              }}
            >
              {diagnosis}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
