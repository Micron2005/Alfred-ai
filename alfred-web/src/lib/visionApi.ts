/**
 * Vision API — wraps the alfred-core ``/vision/*`` endpoints for
 * face recognition (identity) and the workout-coach LLM helpers.
 *
 * Kept in a separate module from ``api.ts`` so the existing
 * chat / memory / voice surface isn't bloated with new types
 * the user can opt out of by simply not enabling the camera.
 */

import { API_BASE } from "@/lib/api";

// ─── Face recognition ──────────────────────────────────────────────────

export interface FaceEnrollment {
  id: string;
  name: string;
  enrolled_at: string;
  /** Optional metadata. */
  notes?: string | null;
  /** Marks this enrollment as a privileged "admin" face. Only
   *  admins can flip Alfred into Nightfall protocol via voice. */
  is_admin?: boolean;
}

export interface FaceMatch {
  enrollment: FaceEnrollment;
  /** Cosine similarity, 0..1. */
  similarity: number;
}

export interface FaceIdentifyResponse {
  /** Best match, if any was above the configured threshold. */
  match: FaceMatch | null;
  /** All candidates ranked by similarity (top 5). */
  candidates: FaceMatch[];
}

export async function enrollFace(
  name: string,
  identityVector: number[],
  notes?: string,
  isAdmin: boolean = false,
): Promise<FaceEnrollment> {
  const resp = await fetch(`${API_BASE}/vision/face/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      identity_vector: identityVector,
      notes: notes ?? null,
      is_admin: isAdmin,
    }),
  });
  if (!resp.ok) throw new Error(`Enroll failed: ${resp.status}`);
  return resp.json() as Promise<FaceEnrollment>;
}

export async function identifyFace(
  identityVector: number[],
): Promise<FaceIdentifyResponse> {
  const resp = await fetch(`${API_BASE}/vision/face/identify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity_vector: identityVector }),
  });
  if (!resp.ok) throw new Error(`Identify failed: ${resp.status}`);
  return resp.json() as Promise<FaceIdentifyResponse>;
}

export async function listFaceEnrollments(): Promise<FaceEnrollment[]> {
  const resp = await fetch(`${API_BASE}/vision/face/enrollments`);
  if (!resp.ok) throw new Error("Could not list enrollments");
  const data = (await resp.json()) as { enrollments: FaceEnrollment[] };
  return data.enrollments;
}

export async function deleteFaceEnrollment(id: string): Promise<void> {
  const resp = await fetch(`${API_BASE}/vision/face/enrollments/${id}`, {
    method: "DELETE",
  });
  if (!resp.ok) throw new Error("Could not delete enrollment");
}

// ─── Workout coach ─────────────────────────────────────────────────────

export interface WorkoutCoachRequest {
  /** What the user wants help with — free-form (e.g. "fix my squat
   *  depth", "give me a 20 min full-body workout"). */
  goal: string;
  /** Current pose snapshot, if available. Joint angles in degrees. */
  pose?: {
    exercise: string;
    angles: Record<string, number>;
    formScore: number;
    cues: Array<{ severity: string; text: string }>;
  } | null;
  /** Previous workouts in this session for continuity. */
  history?: string[];
}

export interface WorkoutCoachResponse {
  /** Markdown-formatted reply from Alfred. */
  reply: string;
  /** Structured workout plan, if Alfred generated one. */
  plan?: {
    title: string;
    duration_minutes: number;
    exercises: Array<{
      name: string;
      sets?: number;
      reps?: string;
      duration_seconds?: number;
      notes?: string;
    }>;
  } | null;
}

export async function workoutCoach(
  req: WorkoutCoachRequest,
): Promise<WorkoutCoachResponse> {
  const resp = await fetch(`${API_BASE}/vision/coach`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Coach failed: ${resp.status} — ${detail}`);
  }
  return resp.json() as Promise<WorkoutCoachResponse>;
}
