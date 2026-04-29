"use client";

/**
 * WorkoutTabView — full-screen layout for the WORKOUT tab.
 *
 * Hosts:
 *   - A camera preview (so the user sees their pose).
 *   - The PoseSkeleton overlay (rendered in ChatWindow at top level
 *     so it stays world-positioned across tabs).
 *   - The full WorkoutCoachWidget (form analysis + AI coach panel).
 *
 * Replaces the previous "workout coach lives as a small card on the
 * HUD even with the camera off" behaviour — the form coach now has
 * its own dedicated room.
 */

import { CameraPreview } from "./CameraPreview";
import { WorkoutCoachWidget } from "./WorkoutCoachWidget";
import { ExpressionReadout } from "./ExpressionReadout";
import type { PoseState } from "@/lib/usePoseTracking";
import type { FaceState } from "@/lib/useFaceTracking";

interface Props {
  cameraOn: boolean;
  cameraStatus: "off" | "starting" | "ready" | "error";
  faceCount: number;
  cameraStreamRef: React.MutableRefObject<MediaStream | null>;
  pose: PoseState | null;
  poseStatus: "off" | "starting" | "ready" | "error";
  face: FaceState | null;
  faceStatus: "off" | "starting" | "ready" | "error";
  /** Recognised name overlay info (derived in ChatWindow from
   *  ``useFaceIdentity``). */
  recognizedName?: string | null;
  isAdmin?: boolean;
  /** Toggle camera on/off — the workout flow is useless without it. */
  onToggleCamera: () => void;
}

export function WorkoutTabView({
  cameraOn,
  cameraStatus,
  faceCount,
  cameraStreamRef,
  pose,
  poseStatus,
  face,
  faceStatus,
  recognizedName,
  isAdmin,
  onToggleCamera,
}: Props) {
  return (
    <div
      data-testid="workout-tab-view"
      style={{
        display: "flex",
        flex: 1,
        minHeight: 0,
        height: "calc(100vh - 56px)",
        gap: 16,
        padding: "16px 22px 22px",
        flexWrap: "wrap",
        alignContent: "flex-start",
      }}
    >
      {/* Top header */}
      <div
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          paddingBottom: 8,
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div>
          <h2
            className="mono"
            style={{
              margin: 0,
              fontSize: 18,
              letterSpacing: 5,
              color: "var(--hud)",
              textShadow: "0 0 10px var(--orb-glow)",
              fontWeight: 500,
            }}
          >
            FORM COACH
          </h2>
          <p
            style={{
              margin: 0,
              color: "var(--muted)",
              fontSize: 12,
              fontStyle: "italic",
            }}
          >
            Step in front of the camera and pick an exercise — I&apos;ll watch your form, sir.
          </p>
        </div>
        <button
          type="button"
          data-testid="workout-toggle-camera"
          className="hud-button"
          onClick={onToggleCamera}
          aria-pressed={cameraOn}
          title={cameraOn ? "Turn the camera off" : "Turn the camera on"}
        >
          {cameraOn
            ? cameraStatus === "ready"
              ? `📷 CAM · ${faceCount}`
              : cameraStatus === "starting"
                ? "📷 STARTING…"
                : cameraStatus === "error"
                  ? "📷 CAM ERR"
                  : "📷 CAM"
            : "📷 ENABLE CAMERA"}
        </button>
      </div>

      {/* Left column — camera preview + expression readout */}
      <section
        style={{
          flex: "1 1 480px",
          minWidth: 320,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {cameraOn ? (
          <div
            style={{
              width: "100%",
              aspectRatio: "16 / 9",
              border: "1px solid var(--border)",
              background: "var(--bg-elev)",
            }}
          >
            <CameraPreview
              status={cameraStatus}
              faceCount={faceCount}
              streamRef={cameraStreamRef}
              recognizedName={recognizedName}
              faceBbox={face?.bbox ?? null}
              isAdmin={isAdmin}
            />
          </div>
        ) : (
          <div
            data-testid="workout-camera-empty"
            style={{
              width: "100%",
              aspectRatio: "16 / 9",
              border: "1px dashed var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "column",
              gap: 8,
              background: "rgba(108,214,255,0.02)",
            }}
          >
            <span
              className="mono"
              style={{
                fontSize: 11,
                letterSpacing: 2,
                color: "var(--muted)",
              }}
            >
              CAMERA OFFLINE
            </span>
            <span
              style={{
                fontSize: 12,
                color: "var(--muted)",
                fontStyle: "italic",
              }}
            >
              Turn on the camera to begin form analysis.
            </span>
          </div>
        )}

        {/* Inline expression readout — only meaningful while the
            camera is active; stays out of the way otherwise. */}
        {cameraOn && faceStatus === "ready" && face ? (
          <ExpressionReadout enabled face={face} />
        ) : null}
      </section>

      {/* Right column — the existing form-coach widget. */}
      <section
        style={{
          flex: "1 1 360px",
          minWidth: 320,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <WorkoutCoachWidget pose={pose} poseStatus={poseStatus} />
      </section>
    </div>
  );
}
