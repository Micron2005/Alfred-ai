"use client";

/**
 * Pose-form heuristics — small, dependency-free rules that turn
 * raw joint-angle data from ``usePoseTracking`` into actionable
 * coaching cues for common bodyweight movements and martial-arts
 * stances. Used by the ``WorkoutCoachWidget`` to give immediate
 * feedback in between LLM-driven critiques (which are slower and
 * cost API budget).
 *
 * Each analyzer returns a list of ``Cue`` objects. ``severity``:
 *   - "ok"    : you're in a good rep / position
 *   - "info"  : tip or transition observation
 *   - "warn"  : minor form drift, easy to fix
 *   - "alert" : injury risk or significant form break
 *
 * Tips deliberately mirror the language a real coach would use:
 * short, specific, body-part + action.
 */

import type { JointAngles } from "@/lib/usePoseTracking";

export type CueSeverity = "ok" | "info" | "warn" | "alert";

export interface Cue {
  severity: CueSeverity;
  text: string;
}

export type ExerciseId =
  | "squat"
  | "pushup"
  | "plank"
  | "lunge"
  | "stance-fighting"
  | "stance-horse";

export const EXERCISE_LABELS: Record<ExerciseId, string> = {
  squat: "Squat",
  pushup: "Push-up",
  plank: "Plank",
  lunge: "Lunge",
  "stance-fighting": "Fighting stance",
  "stance-horse": "Horse stance",
};

export interface FormAnalysis {
  exercise: ExerciseId;
  cues: Cue[];
  /** 0..100. Composite score derived from all cues. */
  formScore: number;
  /** Phase, if the exercise has reps (e.g. "down" / "up"). */
  phase?: string;
}

function score(cues: Cue[]): number {
  let s = 100;
  for (const c of cues) {
    if (c.severity === "warn") s -= 10;
    else if (c.severity === "alert") s -= 25;
  }
  return Math.max(0, Math.min(100, s));
}

export function analyzeSquat(a: JointAngles): FormAnalysis {
  const cues: Cue[] = [];
  const knee = (a.leftKnee + a.rightKnee) / 2;
  const hip = (a.leftHip + a.rightHip) / 2;
  let phase = "stand";
  if (knee < 110) phase = "bottom";
  else if (knee < 150) phase = "descent";
  if (knee >= 150 && hip >= 150) {
    cues.push({
      severity: "info",
      text: "Standing — drop into the squat when ready.",
    });
  }
  if (phase === "bottom") {
    cues.push({
      severity: "ok",
      text: "Depth looks good — knees bent past 90°.",
    });
    if (a.torsoLean > 35) {
      cues.push({
        severity: "warn",
        text: "Chest is tipping forward. Brace your core and keep your torso taller.",
      });
    }
  }
  if (a.stanceRatio < 0.9) {
    cues.push({
      severity: "warn",
      text: "Stance is narrow. Step a little wider — feet at shoulder width.",
    });
  } else if (a.stanceRatio > 1.7) {
    cues.push({
      severity: "info",
      text: "Wide stance — works the inner thighs, but watch the knees track over the toes.",
    });
  }
  if (knee < 60) {
    cues.push({
      severity: "alert",
      text: "Very deep — only go this low if you have the mobility for it.",
    });
  }
  return { exercise: "squat", cues, formScore: score(cues), phase };
}

export function analyzePushup(a: JointAngles): FormAnalysis {
  const cues: Cue[] = [];
  const elbow = (a.leftElbow + a.rightElbow) / 2;
  let phase = "top";
  if (elbow < 100) phase = "bottom";
  else if (elbow < 150) phase = "descent";
  if (a.torsoLean > 25 && phase !== "top") {
    cues.push({
      severity: "warn",
      text: "Hips sagging or piking — keep a straight line from head to heels.",
    });
  } else {
    cues.push({ severity: "ok", text: "Body line is tight — good plank position." });
  }
  if (phase === "bottom") {
    if (elbow > 95) {
      cues.push({
        severity: "info",
        text: "Go a touch deeper — get the elbows past 90°.",
      });
    } else if (elbow < 70) {
      cues.push({
        severity: "ok",
        text: "Full range — chest near the floor.",
      });
    }
  }
  return { exercise: "pushup", cues, formScore: score(cues), phase };
}

export function analyzePlank(a: JointAngles): FormAnalysis {
  const cues: Cue[] = [];
  if (a.torsoLean > 30) {
    cues.push({
      severity: "warn",
      text: "Hips are dropping. Squeeze the glutes and lift the hips into a straight line.",
    });
  } else if (a.torsoLean < 5) {
    cues.push({
      severity: "info",
      text: "Body is very flat — make sure hips aren't piking up.",
    });
  } else {
    cues.push({ severity: "ok", text: "Solid plank — hold that line." });
  }
  const elbow = (a.leftElbow + a.rightElbow) / 2;
  if (elbow > 100 && elbow < 170) {
    cues.push({
      severity: "info",
      text: "If high plank, lock the elbows under the shoulders.",
    });
  }
  return { exercise: "plank", cues, formScore: score(cues) };
}

export function analyzeLunge(a: JointAngles): FormAnalysis {
  const cues: Cue[] = [];
  const front = Math.min(a.leftKnee, a.rightKnee);
  const back = Math.max(a.leftKnee, a.rightKnee);
  let phase = "stand";
  if (front < 110) phase = "bottom";
  if (phase === "bottom") {
    if (front < 80) {
      cues.push({
        severity: "warn",
        text: "Front knee is past 90° — keep it stacked over the ankle.",
      });
    } else {
      cues.push({
        severity: "ok",
        text: "Front knee looks solid at ~90°.",
      });
    }
    if (back > 110) {
      cues.push({
        severity: "info",
        text: "Drop the back knee a little lower for a deeper lunge.",
      });
    }
    if (a.torsoLean > 20) {
      cues.push({
        severity: "warn",
        text: "Torso is leaning. Stay tall through the spine.",
      });
    }
  }
  return { exercise: "lunge", cues, formScore: score(cues), phase };
}

export function analyzeFightingStance(a: JointAngles): FormAnalysis {
  const cues: Cue[] = [];
  const knee = (a.leftKnee + a.rightKnee) / 2;
  if (knee > 170) {
    cues.push({
      severity: "warn",
      text: "Stand legs are locked out. Soften the knees — stay loaded and ready to move.",
    });
  } else if (knee < 130) {
    cues.push({
      severity: "info",
      text: "Knees nicely bent — good athletic loading.",
    });
  }
  if (a.stanceRatio < 0.8) {
    cues.push({
      severity: "warn",
      text: "Feet too narrow — stagger them at least shoulder width for balance.",
    });
  } else if (a.stanceRatio > 1.5) {
    cues.push({
      severity: "info",
      text: "Wide base — sacrifices mobility for stability.",
    });
  }
  const hands = (a.leftElbow + a.rightElbow) / 2;
  if (hands > 150) {
    cues.push({
      severity: "alert",
      text: "Hands are down. Keep your guard up — chin tucked behind both fists.",
    });
  } else {
    cues.push({ severity: "ok", text: "Hands up — guard is in position." });
  }
  return { exercise: "stance-fighting", cues, formScore: score(cues) };
}

export function analyzeHorseStance(a: JointAngles): FormAnalysis {
  const cues: Cue[] = [];
  const knee = (a.leftKnee + a.rightKnee) / 2;
  if (knee > 150) {
    cues.push({
      severity: "warn",
      text: "Sink lower — thighs should approach parallel to the floor.",
    });
  } else if (knee < 80) {
    cues.push({
      severity: "info",
      text: "Very deep stance — good if your hips can take it.",
    });
  } else {
    cues.push({
      severity: "ok",
      text: "Good depth — thighs roughly parallel.",
    });
  }
  if (a.stanceRatio < 1.4) {
    cues.push({
      severity: "warn",
      text: "Feet too close — widen the stance to about double shoulder width.",
    });
  }
  if (a.torsoLean > 12) {
    cues.push({
      severity: "warn",
      text: "Lean back to upright — spine stacked over the hips.",
    });
  }
  return { exercise: "stance-horse", cues, formScore: score(cues) };
}

export function analyzeForm(
  exercise: ExerciseId,
  angles: JointAngles,
): FormAnalysis {
  switch (exercise) {
    case "squat":
      return analyzeSquat(angles);
    case "pushup":
      return analyzePushup(angles);
    case "plank":
      return analyzePlank(angles);
    case "lunge":
      return analyzeLunge(angles);
    case "stance-fighting":
      return analyzeFightingStance(angles);
    case "stance-horse":
      return analyzeHorseStance(angles);
  }
}
