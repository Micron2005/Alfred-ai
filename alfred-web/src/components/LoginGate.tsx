"use client";

/**
 * LoginGate — wraps the HUD in an auth wall.
 *
 * Three render paths:
 *   "checking"     → centred "INITIALISING" pulse, no flicker on the
 *                    main HUD while we figure out auth state.
 *   "disabled"     → render children directly, no chrome, no overhead.
 *                    This is the legacy path for Tailscale-only
 *                    deployments that don't enable the password gate.
 *   "needs-login"  → the actual HUD-style login form; on success
 *                    flips to "authed" and renders children.
 *   "authed"       → render children.
 *
 * The form is intentionally very small — one password field, one
 * submit button. Single-user, no email, no "forgot" flow (the user
 * has access to the host's .env if they need to reset).
 */

import { type FormEvent, useState, type ReactNode } from "react";
import { useAuth } from "@/lib/AuthContext";

export function LoginGate({ children }: { children: ReactNode }) {
  const { state } = useAuth();

  if (state === "disabled" || state === "authed") {
    return <>{children}</>;
  }

  if (state === "checking") {
    return <CheckingScreen />;
  }

  return <LoginScreen />;
}

function CheckingScreen() {
  return (
    <div
      data-testid="auth-checking"
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background:
          "radial-gradient(circle at 50% 40%, rgba(20,40,70,0.4) 0%, rgba(0,0,0,1) 70%)",
        color: "var(--orb)",
        fontFamily:
          'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
        letterSpacing: 4,
        fontSize: 11,
        textShadow: "0 0 12px var(--orb-glow)",
        animation: "auth-pulse 1500ms ease-in-out infinite",
      }}
    >
      INITIALISING…
      <style jsx>{`
        @keyframes auth-pulse {
          0%,
          100% {
            opacity: 0.55;
          }
          50% {
            opacity: 1;
          }
        }
      `}</style>
    </div>
  );
}

function LoginScreen() {
  const { login } = useAuth();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      await login(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
    } finally {
      setBusy(false);
      setPassword("");
    }
  }

  return (
    <div
      data-testid="login-screen"
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background:
          "radial-gradient(circle at 50% 40%, rgba(20,40,70,0.55) 0%, rgba(0,0,0,1) 70%)",
        fontFamily:
          'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
        color: "var(--muted)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Decorative ring — same family as the HUD orb so the login
          screen feels like part of Alfred, not a separate page. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          width: 540,
          height: 540,
          borderRadius: "50%",
          border: "1px dashed rgba(108,214,255,0.18)",
          animation: "auth-spin 22s linear infinite",
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          width: 380,
          height: 380,
          borderRadius: "50%",
          border: "1px dashed rgba(108,214,255,0.22)",
          animation: "auth-spin 14s linear infinite reverse",
        }}
      />

      <form
        onSubmit={onSubmit}
        style={{
          position: "relative",
          width: 340,
          padding: 28,
          background: "rgba(8,14,24,0.7)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          backdropFilter: "blur(10px)",
          boxShadow: "0 0 40px rgba(108,214,255,0.12)",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div
          style={{
            fontSize: 11,
            letterSpacing: 6,
            color: "var(--orb)",
            textShadow: "0 0 8px var(--orb-glow)",
          }}
        >
          ALFRED · LOCKED
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--muted)",
            lineHeight: 1.55,
          }}
        >
          Identify yourself, sir.
        </div>
        <input
          data-testid="login-password"
          type="password"
          value={password}
          autoFocus
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          aria-label="Master password"
          style={{
            padding: "10px 12px",
            background: "rgba(0,0,0,0.45)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            color: "var(--orb)",
            fontFamily: "inherit",
            fontSize: 13,
            letterSpacing: 2,
            outline: "none",
          }}
        />
        {error ? (
          <div
            data-testid="login-error"
            style={{
              fontSize: 11,
              color: "rgb(255,110,110)",
              background: "rgba(255,80,80,0.06)",
              border: "1px solid rgba(255,80,80,0.3)",
              padding: "8px 10px",
              borderRadius: 3,
            }}
          >
            {error}
          </div>
        ) : null}
        <button
          type="submit"
          data-testid="login-submit"
          className="hud-button"
          disabled={busy || !password}
          style={{
            padding: "10px 16px",
            fontSize: 11,
            letterSpacing: 4,
          }}
        >
          {busy ? "AUTHENTICATING…" : "▶ ENGAGE"}
        </button>
      </form>

      <style jsx global>{`
        @keyframes auth-spin {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </div>
  );
}
