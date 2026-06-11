"use client";

import dynamic from "next/dynamic";

import { AuthProvider } from "@/lib/AuthContext";
import { LoginGate } from "@/components/LoginGate";
import { useDeviceMode } from "@/lib/useDeviceMode";

/**
 * Top-level shell with mode-based code splitting.
 *
 * The desktop ``ChatWindow`` pulls in Three.js, React-Three-Fiber,
 * Leaflet/MapLibre, MediaPipe, and ~5 MB of JS. The mobile shell is
 * < 80 KB. If we import both eagerly, every phone visit downloads the
 * entire desktop bundle before its UI can render — over Tailscale on
 * a phone this took 30+ s. Splitting via ``next/dynamic({ ssr:false })``
 * means each device downloads ONLY the bundle it needs.
 *
 * ``useDeviceMode`` returns ``null`` server-side and on the first
 * render — that's the "BOOTING…" splash. As soon as it picks a mode,
 * we dynamic-import the matching shell (one network round-trip per
 * shell, fully cached after first load).
 */

const DesktopShell = dynamic(
  () => import("@/components/ChatWindow").then((mod) => mod.ChatWindow),
  {
    ssr: false,
    loading: () => <BootSplash label="STARTING HUD…" />,
  },
);

const MobileShell = dynamic(
  () => import("@/components/MobileChat").then((mod) => mod.MobileChat),
  {
    ssr: false,
    loading: () => <BootSplash label="LOADING…" />,
  },
);

export default function HomePage() {
  return (
    <AuthProvider>
      <LoginGate>
        <DeviceShell />
      </LoginGate>
    </AuthProvider>
  );
}

function DeviceShell() {
  const mode = useDeviceMode();
  if (mode === null) return <BootSplash label="BOOTING…" />;
  return mode === "mobile" ? <MobileShell /> : <DesktopShell />;
}

function BootSplash({ label }: { label: string }) {
  return (
    <div
      data-testid="device-shell-loading"
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
        color: "var(--orb)",
        letterSpacing: 4,
        fontSize: 11,
        fontFamily: "monospace",
        gap: 16,
      }}
    >
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: "50%",
          border: "2px solid var(--border)",
          borderTopColor: "var(--orb)",
          animation: "spin 800ms linear infinite",
          boxShadow: "0 0 16px var(--orb-glow)",
        }}
      />
      {label}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
