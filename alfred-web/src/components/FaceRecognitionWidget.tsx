"use client";

/**
 * FaceRecognitionWidget — small HUD panel for enrolling and
 * identifying faces using the identity vector from
 * ``useFaceTracking``.
 *
 * Workflow:
 *   1. Step into frame → the panel runs ``/vision/face/identify``
 *      every few seconds. If a known person matches, the panel
 *      shows their name + similarity score.
 *   2. If unknown, the user can type a name and click "Enroll
 *      this face" — the current 96-D identity vector is saved.
 *
 * Identity-vector caveat: the vector is a normalised pairwise-
 * distance signature, not a learned face embedding. It's good
 * enough to distinguish a few household members at similar pose
 * / lighting; expect higher false negatives across very different
 * angles. For production identity, swap the backend
 * ``alfred_core/vision/face_recognition.py`` implementation for a
 * proper FaceNet / ArcFace embedding model — the API shape
 * doesn't change.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { FaceState } from "@/lib/useFaceTracking";
import {
  type FaceEnrollment,
  type FaceIdentifyResponse,
  enrollFace,
  identifyFace,
  listFaceEnrollments,
} from "@/lib/visionApi";

interface Props {
  face: FaceState | null;
  faceStatus: "off" | "starting" | "ready" | "error";
}

/** ms between automatic identify polls — slow enough to not spam
 *  the backend, fast enough that "I just walked in" feels live. */
const IDENTIFY_INTERVAL_MS = 2500;

export function FaceRecognitionWidget({ face, faceStatus }: Props) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<FaceIdentifyResponse | null>(null);
  const [enrollments, setEnrollments] = useState<FaceEnrollment[]>([]);
  const lastIdentifyAt = useRef(0);

  // Refresh the enrollment list once on mount.
  useEffect(() => {
    void (async () => {
      try {
        setEnrollments(await listFaceEnrollments());
      } catch {
        /* backend may not be running yet */
      }
    })();
  }, []);

  // Poll identify whenever a face is visible.
  useEffect(() => {
    if (!face || faceStatus !== "ready") return;
    const now = performance.now();
    if (now - lastIdentifyAt.current < IDENTIFY_INTERVAL_MS) return;
    lastIdentifyAt.current = now;
    void (async () => {
      try {
        const res = await identifyFace(face.identityVector);
        setIdentity(res);
      } catch {
        /* don't surface — likely backend offline */
      }
    })();
  }, [face, faceStatus]);

  const handleEnroll = useCallback(async () => {
    if (!face || !name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await enrollFace(name.trim(), face.identityVector);
      setName("");
      setEnrollments(await listFaceEnrollments());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Enroll failed");
    } finally {
      setBusy(false);
    }
  }, [face, name, busy]);

  const match = identity?.match;
  return (
    <div
      data-testid="face-recognition-widget"
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
        minWidth: 240,
      }}
    >
      <div
        style={{
          textTransform: "uppercase",
          letterSpacing: 2,
          opacity: 0.8,
        }}
      >
        👤 RECOGNITION
      </div>

      {faceStatus !== "ready" ? (
        <div style={{ opacity: 0.65, fontStyle: "italic" }}>
          {faceStatus === "off"
            ? "Turn on the face tracker (camera + 🙂 FACE) to identify people."
            : faceStatus === "starting"
              ? "Face tracker warming up…"
              : "Face tracker error — check the camera permission."}
        </div>
      ) : !face ? (
        <div style={{ opacity: 0.65, fontStyle: "italic" }}>
          No face in frame.
        </div>
      ) : match ? (
        <div
          data-testid="face-identity-known"
          style={{
            padding: "6px 8px",
            background: "rgba(102, 240, 160, 0.08)",
            border: "1px solid rgba(102, 240, 160, 0.4)",
            borderRadius: 3,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: "rgba(102, 240, 160, 0.95)" }}>
            {match.enrollment.name}
          </div>
          <div style={{ opacity: 0.7, fontSize: 9 }}>
            confidence {(match.similarity * 100).toFixed(1)}%
          </div>
        </div>
      ) : (
        <div
          data-testid="face-identity-unknown"
          style={{
            padding: "6px 8px",
            background: "rgba(255, 200, 60, 0.06)",
            border: "1px solid rgba(255, 200, 60, 0.3)",
            borderRadius: 3,
          }}
        >
          <div style={{ fontSize: 12, color: "rgba(255, 200, 60, 0.95)" }}>
            Unknown face
          </div>
          <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
            <input
              data-testid="enroll-name-input"
              type="text"
              placeholder="Name…"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleEnroll();
              }}
              style={{
                flex: 1,
                background: "rgba(0,0,0,0.4)",
                color: "var(--hud)",
                border: "1px solid var(--border)",
                borderRadius: 3,
                padding: "3px 6px",
                fontSize: 11,
                fontFamily: "inherit",
              }}
            />
            <button
              type="button"
              data-testid="enroll-button"
              className="hud-button"
              onClick={() => void handleEnroll()}
              disabled={busy || !name.trim()}
              style={{ padding: "3px 8px", fontSize: 10 }}
            >
              {busy ? "…" : "ENROLL"}
            </button>
          </div>
          {error ? (
            <div
              style={{
                color: "rgba(255, 120, 120, 0.95)",
                fontSize: 9,
                marginTop: 4,
              }}
            >
              {error}
            </div>
          ) : null}
        </div>
      )}

      {enrollments.length > 0 ? (
        <div
          style={{
            paddingTop: 4,
            borderTop: "1px solid var(--border)",
            opacity: 0.85,
          }}
        >
          <div
            style={{
              fontSize: 9,
              letterSpacing: 1.5,
              opacity: 0.7,
              marginBottom: 2,
            }}
          >
            ENROLLED ({enrollments.length})
          </div>
          <div style={{ fontSize: 11, lineHeight: 1.5 }}>
            {enrollments.map((e) => e.name).join(" · ")}
          </div>
        </div>
      ) : null}
    </div>
  );
}
