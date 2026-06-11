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
  commitAndPush,
  diagnoseProblem,
  dryRunPatch,
  fetchGitStatus,
  listWorkshopFiles,
  type DryRunResult,
  type GitStatus,
  type WorkshopFile,
} from "@/lib/workshopApi";

interface WorkshopViewProps {
  onBack: () => void;
  /** Pre-populate the Workshop with a problem statement and a list of
   *  files to focus on. Used by the Vitals self-heal handoff so the
   *  user can go from "Ollama is err" → DIAGNOSE in one click. */
  initialProblem?: string;
  initialPaths?: string[];
}

export function WorkshopView({
  onBack,
  initialProblem = "",
  initialPaths = [],
}: WorkshopViewProps) {
  const [files, setFiles] = useState<WorkshopFile[]>([]);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(initialPaths),
  );
  const [problem, setProblem] = useState(initialProblem);
  const [busy, setBusy] = useState(false);
  const [diagnosis, setDiagnosis] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Commit + push state — populated after the user clicks APPLY,
  // hidden until then. ``gitStatus`` polls /git-status so the user
  // can see what branch they're on and whether the push will go to
  // the right remote BEFORE they click commit.
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [commitResult, setCommitResult] = useState<string | null>(null);
  // Dry-run state — when populated, the user has run a DRY RUN and
  // can see whether tests pass before clicking APPLY.
  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null);
  // Branch strategy for COMMIT + PUSH. ``alfred-pr`` puts the commit
  // on a fresh ``alfred/<id>`` branch the user can review on
  // GitHub; ``current`` legacy-pushes to the current branch.
  // Default to alfred-pr because that's the safer one for most
  // users — keeps main clean.
  const [branchStrategy, setBranchStrategy] = useState<
    "current" | "alfred-pr"
  >("alfred-pr");
  const [pushResult, setPushResult] = useState<{
    pr_url: string;
    branch: string;
  } | null>(null);

  // After APPLY succeeds, refresh git-status so the COMMIT panel
  // shows the dirty files. We deliberately don't poll on a timer —
  // git status calls subprocess and we don't want to hammer it.
  async function refreshGitStatus() {
    try {
      const s = await fetchGitStatus();
      setGitStatus(s);
    } catch (e) {
      // Soft-fail: surface in UI but don't block apply.
      setGitStatus(null);
      console.warn("git-status fetch failed", e);
    }
  }

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
    setCommitResult(null);
    setError(null);
    try {
      const r = await applyWorkshopPatch(diff);
      setApplyResult(
        r.applied
          ? `✓ Applied to ${r.files_touched.join(", ")}`
          : `✗ ${r.detail}`,
      );
      if (r.applied) {
        // Default the commit message to the first non-empty line of
        // the user's problem statement — saves a trip to the input
        // for the common "diagnose -> apply -> ship" flow.
        const seed =
          problem.trim().split("\n")[0]?.slice(0, 72) ?? "alfred: workshop patch";
        setCommitMessage(`alfred: ${seed}`);
        await refreshGitStatus();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Apply failed");
    } finally {
      setBusy(false);
    }
  }

  /**
   * DRY RUN — apply the diff to a throwaway worktree on the host,
   * run the configured test suite, and report pass/fail without
   * touching the real working tree. The point: the user can confirm
   * the fix doesn't break the test suite BEFORE clicking APPLY.
   */
  async function runDryRun() {
    if (!diff) return;
    setBusy(true);
    setDryRunResult(null);
    setError(null);
    try {
      const r = await dryRunPatch(diff);
      setDryRunResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Dry-run failed");
    } finally {
      setBusy(false);
    }
  }

  async function runCommitPush(skipPush: boolean) {
    if (!commitMessage.trim()) return;
    if (
      !window.confirm(
        skipPush
          ? "Commit locally without pushing?"
          : branchStrategy === "alfred-pr"
            ? "Commit + push to a new alfred/<id> branch (safe — won't touch main)?"
            : "Commit + push to the CURRENT branch? Make sure that's right.",
      )
    )
      return;
    setBusy(true);
    setCommitResult(null);
    setError(null);
    try {
      const r = await commitAndPush({
        message: commitMessage.trim(),
        skip_push: skipPush,
        branch_strategy: branchStrategy,
      });
      setCommitResult(
        r.pushed
          ? `✓ ${r.commit_sha.slice(0, 7)} pushed${r.branch ? ` to ${r.branch}` : ""}`
          : r.committed
            ? `⚠ Committed locally as ${r.commit_sha.slice(0, 7)}, but push failed:\n${r.detail}`
            : `✗ ${r.detail}`,
      );
      if (r.pushed) {
        setPushResult({
          pr_url: r.pr_url ?? "",
          branch: r.branch ?? "",
        });
      }
      if (r.committed) {
        await refreshGitStatus();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Commit + push failed");
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
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
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
              <>
                <button
                  type="button"
                  data-testid="workshop-dry-run"
                  className="hud-button"
                  onClick={runDryRun}
                  disabled={busy}
                  title="Apply the patch to a throwaway worktree, run the test suite, report pass/fail. Doesn't touch your real tree."
                >
                  {busy ? "…" : "🧪 DRY RUN"}
                </button>
                <button
                  type="button"
                  data-testid="workshop-apply"
                  className="hud-button"
                  onClick={runApply}
                  disabled={busy}
                  // Highlight green when dry-run passed — visual cue
                  // that this fix is verified safe to apply.
                  style={
                    dryRunResult?.all_passed
                      ? {
                          borderColor: "rgb(110,230,160)",
                          color: "rgb(110,230,160)",
                          textShadow: "0 0 6px rgba(110,230,160,0.6)",
                        }
                      : undefined
                  }
                >
                  ✓ APPLY PATCH
                </button>
              </>
            ) : null}
          </div>

          {dryRunResult ? (
            <div
              data-testid="workshop-dry-run-result"
              style={{
                background: "rgba(0,0,0,0.45)",
                border: `1px solid ${
                  dryRunResult.all_passed
                    ? "rgba(110,230,160,0.5)"
                    : "rgba(255,110,110,0.5)"
                }`,
                borderRadius: 4,
                padding: 12,
                fontSize: 11,
                color: "var(--muted)",
                lineHeight: 1.5,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              <div
                style={{
                  letterSpacing: 2,
                  color: dryRunResult.all_passed
                    ? "rgb(110,230,160)"
                    : "rgb(255,110,110)",
                }}
              >
                DRY RUN ·{" "}
                {dryRunResult.applied
                  ? dryRunResult.all_passed
                    ? "ALL TESTS PASSED"
                    : "TESTS FAILED"
                  : "PATCH DIDN'T APPLY"}
              </div>
              <div style={{ fontSize: 10, opacity: 0.75 }}>
                {dryRunResult.apply_detail}
              </div>
              {dryRunResult.command_results.map((cr, i) => (
                <details
                  key={i}
                  open={!cr.passed}
                  style={{
                    fontSize: 10,
                    border: "1px solid var(--border)",
                    borderRadius: 3,
                    padding: 6,
                  }}
                >
                  <summary
                    style={{
                      color: cr.passed
                        ? "rgb(110,230,160)"
                        : "rgb(255,110,110)",
                      cursor: "pointer",
                      letterSpacing: 1,
                    }}
                  >
                    {cr.passed ? "✓" : "✗"} {cr.command.join(" ")}
                  </summary>
                  <pre
                    style={{
                      margin: "6px 0 0",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      maxHeight: 240,
                      overflowY: "auto",
                      fontSize: 10,
                      color: "var(--muted)",
                    }}
                  >
                    {cr.output}
                  </pre>
                </details>
              ))}
            </div>
          ) : null}

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

          {/* Commit + push panel — visible after a successful APPLY.
              Shows the git branch / remote so the user knows where
              this is going BEFORE pushing, plus a list of files that
              would be committed. Files outside the allowlist (e.g.
              .env, secrets) are surfaced in red as "left behind" so
              the user knows we deliberately skipped them. */}
          {gitStatus && applyResult?.startsWith("✓") ? (
            <div
              data-testid="workshop-commit-panel"
              style={{
                background: "rgba(8,14,24,0.55)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                padding: 12,
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  letterSpacing: 2,
                  color: "var(--orb)",
                }}
              >
                COMMIT + PUSH
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: "var(--muted)",
                  lineHeight: 1.6,
                }}
              >
                <div>
                  branch:{" "}
                  <span style={{ color: "var(--orb)" }}>
                    {gitStatus.branch}
                  </span>{" "}
                  · ahead {gitStatus.ahead} · behind {gitStatus.behind}
                </div>
                <div style={{ wordBreak: "break-all" }}>
                  remote:{" "}
                  <span style={{ color: "var(--orb)" }}>
                    {gitStatus.remote || "(none — push will fail)"}
                  </span>
                </div>
                {gitStatus.dirty_files.length > 0 ? (
                  <div style={{ marginTop: 6 }}>
                    will commit:{" "}
                    {gitStatus.dirty_files
                      .filter(
                        (f) =>
                          !gitStatus.dirty_files_outside_allowlist.includes(f),
                      )
                      .join(", ") || "(nothing)"}
                  </div>
                ) : null}
                {gitStatus.dirty_files_outside_allowlist.length > 0 ? (
                  <div
                    style={{ color: "rgb(240,200,100)", marginTop: 4 }}
                    data-testid="workshop-commit-skipped"
                  >
                    skipping (outside allowlist / read-only):{" "}
                    {gitStatus.dirty_files_outside_allowlist.join(", ")}
                  </div>
                ) : null}
              </div>
              <input
                data-testid="workshop-commit-message"
                type="text"
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                placeholder='Commit message (e.g. "alfred: tighten greeting")'
                style={{
                  padding: "6px 10px",
                  fontSize: 12,
                  background: "rgba(0,0,0,0.4)",
                  border: "1px solid var(--border)",
                  color: "var(--orb)",
                  borderRadius: 3,
                  fontFamily: "inherit",
                }}
              />
              {/* Branch strategy toggle. Default ``alfred-pr`` is the
                  safer one — the commit lands on a fresh branch the
                  user can review on GitHub before merging. The
                  ``current`` option is for users who want to push
                  straight to whatever branch they're on (legacy). */}
              <div
                style={{
                  display: "flex",
                  gap: 14,
                  fontSize: 10,
                  color: "var(--muted)",
                  alignItems: "center",
                }}
              >
                <span style={{ letterSpacing: 1.5 }}>STRATEGY:</span>
                <label
                  style={{ display: "flex", gap: 4, cursor: "pointer" }}
                  data-testid="workshop-branch-alfred-pr"
                >
                  <input
                    type="radio"
                    name="branch-strategy"
                    checked={branchStrategy === "alfred-pr"}
                    onChange={() => setBranchStrategy("alfred-pr")}
                    style={{ accentColor: "rgb(108,214,255)" }}
                  />
                  <span
                    style={
                      branchStrategy === "alfred-pr"
                        ? { color: "var(--orb)" }
                        : undefined
                    }
                  >
                    new alfred/&lt;id&gt; branch
                  </span>
                </label>
                <label
                  style={{ display: "flex", gap: 4, cursor: "pointer" }}
                  data-testid="workshop-branch-current"
                >
                  <input
                    type="radio"
                    name="branch-strategy"
                    checked={branchStrategy === "current"}
                    onChange={() => setBranchStrategy("current")}
                    style={{ accentColor: "rgb(108,214,255)" }}
                  />
                  <span
                    style={
                      branchStrategy === "current"
                        ? { color: "var(--orb)" }
                        : undefined
                    }
                  >
                    current branch
                  </span>
                </label>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  data-testid="workshop-commit-push"
                  className="hud-button"
                  onClick={() => runCommitPush(false)}
                  disabled={busy || !commitMessage.trim()}
                  style={{ flex: 1 }}
                >
                  {busy ? "…" : "⇧ COMMIT + PUSH"}
                </button>
                <button
                  type="button"
                  data-testid="workshop-commit-only"
                  className="hud-button"
                  onClick={() => runCommitPush(true)}
                  disabled={busy || !commitMessage.trim()}
                  style={{ flex: 1 }}
                  title="Commit locally but skip pushing — useful when offline or when you want to review with git log first."
                >
                  ⇩ LOCAL ONLY
                </button>
              </div>
              {commitResult ? (
                <div
                  data-testid="workshop-commit-result"
                  style={{
                    fontSize: 11,
                    padding: 8,
                    borderRadius: 3,
                    border: "1px solid var(--border)",
                    background: "rgba(0,0,0,0.4)",
                    color: commitResult.startsWith("✓")
                      ? "rgb(110,230,160)"
                      : commitResult.startsWith("⚠")
                        ? "rgb(240,200,100)"
                        : "rgb(255,110,110)",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {commitResult}
                </div>
              ) : null}
              {pushResult?.pr_url ? (
                <a
                  data-testid="workshop-pr-url"
                  href={pushResult.pr_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontSize: 11,
                    color: "var(--orb)",
                    textDecoration: "underline",
                    letterSpacing: 1,
                  }}
                >
                  → Open pull request for {pushResult.branch}
                </a>
              ) : null}
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
