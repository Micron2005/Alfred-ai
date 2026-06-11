"use client";

/**
 * AuthContext — single-user password gate for Alfred.
 *
 * Polls ``/api/auth/me`` once on mount to learn:
 *   - is auth enabled at all? (driven by ALFRED_PASSWORD_HASH on the
 *     backend — when unset the gate is off and we render the HUD
 *     unconditionally)
 *   - if yes, do we have a valid session cookie?
 *
 * State machine:
 *   "checking" → ("disabled" | "authed" | "needs-login")
 *   "needs-login" → "authed" via login()
 *   "authed" → "needs-login" via logout()
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { API_BASE } from "@/lib/api";

export type AuthState = "checking" | "disabled" | "authed" | "needs-login";

interface AuthContextValue {
  state: AuthState;
  /** Send password to /api/auth/login. Throws on failure with a
   *  user-facing message. */
  login: (password: string) => Promise<void>;
  /** Best-effort logout — clears server cookies + flips state. */
  logout: () => Promise<void>;
  /** Re-probe /api/auth/me — used after refresh-token retry. */
  recheck: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface MeResponse {
  authed: boolean;
  user?: string | null;
  auth_enabled: boolean;
}

async function probeMe(): Promise<MeResponse> {
  const resp = await fetch(`${API_BASE}/auth/me`, {
    credentials: "include",
  });
  if (!resp.ok) {
    // /auth/me being unreachable is treated as "auth disabled" so a
    // backend that hasn't yet shipped the auth router doesn't trap
    // the user behind a login screen they can't get past. Once the
    // backend updates, the next reload will see real data.
    return { authed: true, auth_enabled: false };
  }
  return (await resp.json()) as MeResponse;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>("checking");

  const recheck = useCallback(async () => {
    try {
      const me = await probeMe();
      if (!me.auth_enabled) {
        setState("disabled");
      } else if (me.authed) {
        setState("authed");
      } else {
        setState("needs-login");
      }
    } catch {
      // Network error — assume auth not yet reachable, let the user
      // through. Better than a permanent loading screen on a slow
      // first boot.
      setState("disabled");
    }
  }, []);

  useEffect(() => {
    void recheck();
  }, [recheck]);

  const login = useCallback(
    async (password: string) => {
      const resp = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password }),
      });
      if (!resp.ok) {
        let detail = "Login failed.";
        try {
          const body = await resp.json();
          if (typeof body?.detail === "string") detail = body.detail;
        } catch {
          /* ignore JSON parse errors — keep generic message */
        }
        throw new Error(detail);
      }
      setState("authed");
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await fetch(`${API_BASE}/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
    } catch {
      /* even if the server call fails, flip state — the cookie will
       * eventually expire on the client side regardless. */
    }
    setState("needs-login");
  }, []);

  const value: AuthContextValue = { state, login, logout, recheck };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
