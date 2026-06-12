"use client";

/**
 * /face — the wire-mesh avatar window for the embedded desk
 * touchscreen. Opened as a popup by the HUD's FACE module (or
 * navigated to directly). Client-only: Three.js + MediaPipe have no
 * SSR story, and this page renders nothing useful on the server.
 */

import dynamic from "next/dynamic";

const FaceWindow = dynamic(
  () => import("@/components/FaceWindow").then((m) => m.FaceWindow),
  {
    ssr: false,
    loading: () => (
      <div
        data-testid="face-window-loading"
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--bg)",
          color: "var(--orb)",
          fontFamily: "monospace",
          fontSize: 11,
          letterSpacing: 4,
        }}
      >
        INITIALISING FACE MODULE…
      </div>
    ),
  },
);

export default function FacePage() {
  return <FaceWindow />;
}
