"use client";

/**
 * WorkoutCoachWidget — HUD-style widget that turns the live pose
 * stream into form feedback and on-demand AI workouts.
 *
 * Two complementary surfaces:
 *
 *  1. Live form readout (top): exercise selector + real-time cues
 *     from ``poseAnalyzer`` + a 0..100 form score. Updates ~10
 *     times per second from the local pose state — no LLM cost.
 *
 *  2. AI coach panel (bottom): free-form input + "Ask coach" button
 *     that calls ``/vision/coach`` with the current pose snapshot
 *     and any user goal. Useful for "what should I work on?",
 *     "fix my squat", or "give me a 15 min HIIT".
 *
 * Designed to drop into the existing HUD widget framework (renders
 * inside ``<HudWidget id="workout-coach">``) so it inherits the
 * drag/resize/hide behaviour from the user's customise mode.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  EXERCISE_LABELS,
  type ExerciseId,
  type FormAnalysis,
  analyzeForm,
} from "@/lib/poseAnalyzer";
import type { PoseState } from "@/lib/usePoseTracking";
import {
  type WorkoutCoachResponse,
  workoutCoach,
} from "@/lib/visionApi";

interface Props {
  pose: PoseState | null;
  poseStatus: "off" | "starting" | "ready" | "error";
}

const SEVERITY_COLOR: Record<string, string> = {
  ok: "rgba(102, 240, 160, 0.95)",
  info: "rgba(108, 214, 255, 0.92)",
  warn: "rgba(255, 200, 60, 0.95)",
  alert: "rgba(255, 120, 120, 0.95)",
};

export function WorkoutCoachWidget({ pose, poseStatus }: Props) {
  const [exercise, setExercise] = useState<ExerciseId>("squat");
  const [analysis, setAnalysis] = useState<FormAnalysis | null>(null);
  const [goal, setGoal] = useState("");
  const [coachBusy, setCoachBusy] = useState(false);
  const [coachReply, setCoachReply] = useState<WorkoutCoachResponse | null>(
    null,
  );
  const [coachError, setCoachError] = useState<string | null>(null);

  // Throttle the heuristic analyzer to ~10 Hz so the readout
  // doesn't strobe with the 30 fps pose stream.
  const lastAnalyzeAt = useRef(0);
  useEffect(() => {
    if (!pose) {
      setAnalysis(null);
      return;
    }
    const now = performance.now();
    if (now - lastAnalyzeAt.current < 100) return;
    lastAnalyzeAt.current = now;
    setAnalysis(analyzeForm(exercise, pose.angles));
  }, [pose, exercise]);

  const handleAskCoach = useCallback(async () => {
    if (coachBusy) return;
    setCoachBusy(true);
    setCoachError(null);
    try {
      const reply = await workoutCoach({
        goal: goal.trim() || `Help me with my ${EXERCISE_LABELS[exercise].toLowerCase()} form.`,
        pose:
          pose && analysis
            ? {
                exercise,
                angles: pose.angles as unknown as Record<string, number>,
                formScore: analysis.formScore,
                cues: analysis.cues,
              }
            : null,
      });
      setCoachReply(reply);
    } catch (e) {
      setCoachError(e instanceof Error ? e.message : "Coach unavailable");
    } finally {
      setCoachBusy(false);
    }
  }, [coachBusy, goal, exercise, pose, analysis]);

  const scoreColor = useMemo(() => {
    if (!analysis) return "var(--muted)";
    if (analysis.formScore >= 85) return SEVERITY_COLOR.ok;
    if (analysis.formScore >= 65) return SEVERITY_COLOR.info;
    if (analysis.formScore >= 45) return SEVERITY_COLOR.warn;
    return SEVERITY_COLOR.alert;
  }, [analysis]);

  return (
    <div
      data-testid="workout-coach-widget"
      style={{
        background: "rgba(8, 14, 24, 0.78)",
        border: "1px solid var(--hud)",
        borderRadius: 6,
        padding: "10px 12px",
        backdropFilter: "blur(12px)",
        boxShadow: "0 0 14px var(--orb-glow)",
        fontFamily:
          'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
        fontSize: 11,
        color: "var(--hud)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minWidth: 280,
        height: "100%",
        boxSizing: "border-box",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div
          style={{
            textTransform: "uppercase",
            letterSpacing: 2,
            opacity: 0.8,
          }}
        >
          🥋 FORM COACH
        </div>
        <div
          data-testid="form-score"
          style={{
            fontSize: 16,
            fontWeight: 700,
            color: scoreColor,
            textShadow: `0 0 8px ${scoreColor}`,
          }}
        >
          {analysis ? `${analysis.formScore}` : "—"}
          <span style={{ fontSize: 9, opacity: 0.7, marginLeft: 4 }}>
            / 100
          </span>
        </div>
      </div>

      {/* Exercise selector */}
      <select
        data-testid="exercise-select"
        value={exercise}
        onChange={(e) => setExercise(e.target.value as ExerciseId)}
        style={{
          background: "rgba(0, 0, 0, 0.4)",
          color: "var(--hud)",
          border: "1px solid var(--border)",
          borderRadius: 3,
          padding: "4px 8px",
          fontSize: 11,
          fontFamily: "inherit",
        }}
      >
        {(Object.keys(EXERCISE_LABELS) as ExerciseId[]).map((id) => (
          <option key={id} value={id} style={{ background: "#0b1320" }}>
            {EXERCISE_LABELS[id]}
          </option>
        ))}
      </select>

      {/* Live cues */}
      <div
        style={{
          minHeight: 60,
          maxHeight: 140,
          overflowY: "auto",
          padding: "4px 6px",
          background: "rgba(0,0,0,0.25)",
          border: "1px solid var(--border)",
          borderRadius: 3,
          display: "flex",
          flexDirection: "column",
          gap: 5,
        }}
      >
        {poseStatus !== "ready" ? (
          <div style={{ opacity: 0.65, fontStyle: "italic" }}>
            {poseStatus === "off"
              ? "Turn on the body tracker (camera + 🦴 POSE) to start coaching."
              : poseStatus === "starting"
                ? "Pose tracker warming up…"
                : "Pose tracker error — check the camera permission."}
          </div>
        ) : !pose ? (
          <div style={{ opacity: 0.65, fontStyle: "italic" }}>
            Step into frame — Alfred is looking for you.
          </div>
        ) : analysis && analysis.cues.length > 0 ? (
          analysis.cues.map((c, i) => (
            <div
              key={i}
              data-testid={`cue-${c.severity}`}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 6,
                color: SEVERITY_COLOR[c.severity] ?? "var(--hud)",
              }}
            >
              <span style={{ flexShrink: 0, opacity: 0.85 }}>
                {c.severity === "ok"
                  ? "✓"
                  : c.severity === "warn"
                    ? "!"
                    : c.severity === "alert"
                      ? "✕"
                      : "·"}
              </span>
              <span style={{ flex: 1, lineHeight: 1.45 }}>{c.text}</span>
            </div>
          ))
        ) : (
          <div style={{ opacity: 0.65, fontStyle: "italic" }}>
            Hold the position — analyzing…
          </div>
        )}
      </div>

      {/* Coach prompt */}
      <div style={{ display: "flex", gap: 6 }}>
        <input
          data-testid="coach-goal-input"
          type="text"
          placeholder="Ask the coach… e.g. 20-min HIIT"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleAskCoach();
          }}
          style={{
            flex: 1,
            background: "rgba(0,0,0,0.4)",
            color: "var(--hud)",
            border: "1px solid var(--border)",
            borderRadius: 3,
            padding: "4px 8px",
            fontSize: 11,
            fontFamily: "inherit",
          }}
        />
        <button
          type="button"
          data-testid="coach-ask-button"
          className="hud-button"
          onClick={() => void handleAskCoach()}
          disabled={coachBusy}
          style={{ padding: "4px 10px", fontSize: 10 }}
        >
          {coachBusy ? "…" : "ASK"}
        </button>
      </div>

      {/* Coach reply */}
      {coachError ? (
        <div
          data-testid="coach-error"
          style={{
            color: SEVERITY_COLOR.alert,
            fontSize: 10,
            fontStyle: "italic",
          }}
        >
          {coachError}
        </div>
      ) : coachReply ? (
        <div
          data-testid="coach-reply"
          style={{
            padding: "6px 8px",
            background: "rgba(108, 214, 255, 0.08)",
            border: "1px solid var(--border)",
            borderRadius: 3,
            fontSize: 11,
            lineHeight: 1.5,
            maxHeight: 220,
            overflowY: "auto",
            whiteSpace: "pre-wrap",
          }}
        >
          {coachReply.reply}
          {coachReply.plan ? (
            <div
              style={{
                marginTop: 8,
                paddingTop: 6,
                borderTop: "1px solid var(--border)",
              }}
            >
              <div
                style={{
                  textTransform: "uppercase",
                  letterSpacing: 1.5,
                  fontSize: 9,
                  opacity: 0.7,
                  marginBottom: 4,
                }}
              >
                {coachReply.plan.title} · {coachReply.plan.duration_minutes}m
              </div>
              {coachReply.plan.exercises.map((ex, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                    fontSize: 11,
                  }}
                >
                  <span>{ex.name}</span>
                  <span style={{ opacity: 0.7 }}>
                    {ex.sets && ex.reps
                      ? `${ex.sets}×${ex.reps}`
                      : ex.duration_seconds
                        ? `${ex.duration_seconds}s`
                        : ""}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
