"use client";

/**
 * HandsFreeOverlay — a small floating panel pinned to the bottom of
 * the HUD that surfaces voice-mode state on non-chat tabs.
 *
 * The user explicitly asked for this: in hands-free mode, voice
 * navigation ("Alfred, go to chat", "go to workout") and conversation
 * still work, but without an overlay the only feedback was the TTS
 * reply. With this panel, the user sees:
 *   - LISTENING — the live red dot + "Listening, sir." while the mic
 *     is hot
 *   - TRANSCRIPT — the last thing the user said (after STT lands)
 *   - REPLY — the last thing Alfred said back
 *
 * The panel is intentionally compact and self-dismissing — it only
 * shows when there's something to show, and fades after 8 s of
 * silence so the HUD stays clean.
 */

import { useEffect, useRef, useState } from "react";
import type { ChatMessageOut } from "@/lib/api";
import type { WakeStatus } from "@/lib/useWakeWord";

interface Props {
  recording: boolean;
  speaking: boolean;
  busy: boolean;
  wakeStatus: WakeStatus;
  wakeError: string | null;
  messages: ReadonlyArray<ChatMessageOut>;
  /**
   * Continuous-conversation mode is engaged. While true, Alfred
   * automatically re-opens the mic after each reply so the user
   * can keep talking without saying "hey alfred" again. Surfaces
   * as a small green "ENGAGED" pip next to the status row.
   */
  conversationMode?: boolean;
  /** Click-handler to manually end the conversation loop. */
  onEndConversation?: () => void;
}

const FADE_AFTER_MS = 8_000;

export function HandsFreeOverlay({
  recording,
  speaking,
  busy,
  wakeStatus,
  wakeError,
  messages,
  conversationMode = false,
  onEndConversation,
}: Props) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant");

  // Track when the last activity happened so we can fade the panel
  // out during long stretches of silence. Activity = recording flips
  // on, speaking flips on, busy flips on, OR a new user/assistant
  // message arrived. We don't fade WHILE any of those are true —
  // only after they all finish.
  const [visible, setVisible] = useState(true);
  const lastActivityRef = useRef<number>(Date.now());

  useEffect(() => {
    if (recording || speaking || busy) {
      lastActivityRef.current = Date.now();
      setVisible(true);
    }
  }, [recording, speaking, busy]);

  useEffect(() => {
    lastActivityRef.current = Date.now();
    setVisible(true);
  }, [lastUser?.id, lastAssistant?.id]);

  useEffect(() => {
    const id = window.setInterval(() => {
      const idle = Date.now() - lastActivityRef.current > FADE_AFTER_MS;
      if (idle && !recording && !speaking && !busy) setVisible(false);
    }, 2000);
    return () => clearInterval(id);
  }, [recording, speaking, busy]);

  // If wake-word is mid-error and the user just enabled hands-free,
  // we want to show the error even on first paint — visible defaults
  // to true so this happens automatically.

  if (!visible && !wakeError) return null;

  // Live status pill colour. Recording trumps everything else
  // visually because it means the mic is hot and what the user says
  // next will land in the conversation.
  const status: "listening" | "speaking" | "thinking" | "wake" | "error" =
    wakeError
      ? "error"
      : recording
        ? "listening"
        : speaking
          ? "speaking"
          : busy
            ? "thinking"
            : "wake";

  const STATUS_DOT: Record<typeof status, string> = {
    listening: "rgb(255, 110, 110)",
    speaking: "rgb(108, 214, 255)",
    thinking: "rgb(240, 200, 100)",
    wake: "rgb(110, 230, 160)",
    error: "rgb(255, 110, 110)",
  };

  const STATUS_LABEL: Record<typeof status, string> = {
    listening: "LISTENING",
    speaking: "SPEAKING",
    thinking: "THINKING",
    wake: wakeStatus === "listening" ? "STANDING BY" : "WAKE OFFLINE",
    error: "WAKE ERROR",
  };

  return (
    <div
      data-testid="hands-free-overlay"
      style={{
        position: "fixed",
        bottom: 78,
        left: 18,
        zIndex: 4,
        maxWidth: 460,
        background: "rgba(8,14,24,0.78)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: "10px 14px",
        backdropFilter: "blur(10px)",
        boxShadow: "0 0 24px rgba(108,214,255,0.1)",
        fontFamily:
          'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
        fontSize: 11,
        color: "var(--muted)",
        transition: "opacity 360ms ease",
        opacity: visible || wakeError ? 1 : 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          letterSpacing: 2,
          color: "var(--orb)",
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: STATUS_DOT[status],
            boxShadow: `0 0 8px ${STATUS_DOT[status]}`,
            animation:
              status === "listening" || status === "thinking"
                ? "hf-pulse 900ms ease-in-out infinite"
                : undefined,
          }}
        />
        <span data-testid="hands-free-status">{STATUS_LABEL[status]}</span>
        {conversationMode ? (
          <button
            type="button"
            data-testid="hands-free-engaged-pip"
            onClick={() => onEndConversation?.()}
            title="Conversation engaged — click to end. Say 'that's it for now' / 'thanks alfred' for the same effect."
            style={{
              marginLeft: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "2px 8px",
              fontSize: 9,
              letterSpacing: 1.5,
              border: "1px solid rgba(110, 230, 160, 0.5)",
              borderRadius: 999,
              background: "rgba(110, 230, 160, 0.08)",
              color: "rgb(110, 230, 160)",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "rgb(110, 230, 160)",
                boxShadow: "0 0 6px rgb(110, 230, 160)",
                animation: "hf-pulse 1400ms ease-in-out infinite",
              }}
            />
            ENGAGED
          </button>
        ) : null}
      </div>
      {wakeError ? (
        <div
          style={{
            marginTop: 6,
            color: "rgb(255,110,110)",
            fontSize: 10,
            lineHeight: 1.5,
          }}
        >
          {wakeError}
        </div>
      ) : null}
      {lastUser?.content ? (
        <div
          style={{
            marginTop: 8,
            color: "var(--muted)",
            fontSize: 11,
            lineHeight: 1.5,
            opacity: 0.85,
          }}
        >
          <span style={{ color: "var(--orb)", letterSpacing: 1.5 }}>
            YOU ·{" "}
          </span>
          <span data-testid="hands-free-last-user">
            {truncate(lastUser.content, 140)}
          </span>
        </div>
      ) : null}
      {lastAssistant?.content ? (
        <div
          style={{
            marginTop: 4,
            color: "var(--muted)",
            fontSize: 11,
            lineHeight: 1.5,
          }}
        >
          <span style={{ color: "var(--orb)", letterSpacing: 1.5 }}>
            ALFRED ·{" "}
          </span>
          <span data-testid="hands-free-last-assistant">
            {truncate(lastAssistant.content, 220)}
          </span>
        </div>
      ) : null}

      <style jsx>{`
        @keyframes hf-pulse {
          0%,
          100% {
            transform: scale(1);
            opacity: 1;
          }
          50% {
            transform: scale(1.4);
            opacity: 0.5;
          }
        }
      `}</style>
    </div>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}
