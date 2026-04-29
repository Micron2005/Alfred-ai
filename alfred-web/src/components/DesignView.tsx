"use client";

/**
 * DesignView — the third tab. Embeds OnShape's web app in an
 * iframe so the user can do real CAD work, with a small Alfred
 * chat overlay docked to the right side for assistance and a
 * printer-status strip docked to the bottom showing live K1 Max
 * status from Moonraker.
 *
 * OnShape requires the user to sign in inside the iframe. Their
 * docs/CAD work persists in their OnShape account — Alfred never
 * touches it, only sits alongside.
 *
 * The chat overlay calls the same ``/chat`` endpoint as the main
 * Chat tab but uses a **separate conversation thread** named
 * "Design Studio" so design-related back-and-forth doesn't
 * pollute the user's general chat history.
 *
 * If OnShape's iframe X-Frame-Options policy ever rejects the
 * embed (some users see this depending on their corporate
 * account), we fall back to a simple "Open OnShape in a new tab"
 * button — the chat overlay still works.
 */

import { useEffect, useRef, useState } from "react";

import { PrinterWidget } from "@/components/PrinterWidget";
import { sendMessage, type ChatMessageOut } from "@/lib/api";

interface Props {
  /** The conversation id to use for design-tab chat. The parent
   *  component owns this so it can persist alongside other
   *  conversation IDs in localStorage. */
  conversationId: string | null;
  onConversationCreated: (id: string) => void;
}

const ONSHAPE_URL = "https://cad.onshape.com/documents";

export function DesignView({ conversationId, onConversationCreated }: Props) {
  const [iframeBlocked, setIframeBlocked] = useState(false);
  const [chatExpanded, setChatExpanded] = useState(true);
  const [input, setInput] = useState("");
  // Local message log — design-chat is intentionally lightweight
  // and ephemeral (the persistent record lives in the backend
  // conversation row keyed by conversationId; this state only
  // covers the visible scrollback in the overlay).
  const [messages, setMessages] = useState<
    Array<{ role: "user" | "assistant"; content: string }>
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // OnShape sometimes refuses iframe embedding for certain
  // accounts — detect by waiting 6s for a load event and showing
  // the fallback if nothing happened. (Pure heuristic; X-Frame
  // rejection doesn't fire onerror in modern browsers.)
  const iframeLoadedRef = useRef(false);
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (!iframeLoadedRef.current) setIframeBlocked(true);
    }, 6000);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function handleSend() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setError(null);
    setMessages((m) => [...m, { role: "user", content: text }]);
    setBusy(true);
    try {
      const resp = await sendMessage(text, conversationId);
      if (resp.conversation_id && resp.conversation_id !== conversationId) {
        onConversationCreated(resp.conversation_id);
      }
      const reply: ChatMessageOut = resp.assistant;
      setMessages((m) => [
        ...m,
        { role: "assistant", content: reply.content ?? "" },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="design-view"
      style={{
        position: "relative",
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      {iframeBlocked ? (
        <BlockedFallback />
      ) : (
        <iframe
          data-testid="onshape-iframe"
          src={ONSHAPE_URL}
          title="OnShape CAD"
          onLoad={() => {
            iframeLoadedRef.current = true;
          }}
          // ``allow`` covers the bits OnShape actually uses inside
          // their iframe (file pickers, clipboard, fullscreen, the
          // device's GPU for WebGL CAD rendering).
          allow="clipboard-read; clipboard-write; fullscreen; web-share"
          style={{
            flex: 1,
            width: "100%",
            border: "none",
            background: "#1a1f2c",
          }}
        />
      )}

      {/* Bottom strip — printer status. Always visible across the
          design view since 3D-printing is the natural endpoint for
          most things designed here. */}
      <PrinterWidget />

      {/* Right-docked chat overlay — collapsed when not in use to
          give the CAD canvas maximum room. */}
      <div
        data-testid="design-chat-overlay"
        style={{
          position: "absolute",
          right: 12,
          top: 12,
          bottom: 96,
          width: chatExpanded ? 320 : 44,
          background: "rgba(8, 14, 24, 0.85)",
          border: "1px solid var(--hud)",
          borderRadius: 6,
          backdropFilter: "blur(14px)",
          WebkitBackdropFilter: "blur(14px)",
          boxShadow: "0 0 16px var(--orb-glow)",
          display: "flex",
          flexDirection: "column",
          color: "var(--hud)",
          fontFamily:
            'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
          fontSize: 11,
          transition: "width 220ms ease",
          zIndex: 10,
          overflow: "hidden",
        }}
      >
        <button
          type="button"
          onClick={() => setChatExpanded((e) => !e)}
          aria-pressed={chatExpanded}
          aria-label={chatExpanded ? "Collapse design chat" : "Expand design chat"}
          style={{
            background: "rgba(108, 214, 255, 0.08)",
            border: "none",
            borderBottom: "1px solid var(--border)",
            color: "var(--hud)",
            padding: "8px 10px",
            textAlign: "left",
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: 11,
            letterSpacing: 1.4,
            textTransform: "uppercase",
          }}
        >
          {chatExpanded ? "▾ ALFRED · DESIGN ASSIST" : "▸"}
        </button>
        {chatExpanded ? (
          <>
            <div
              ref={scrollRef}
              style={{
                flex: 1,
                overflowY: "auto",
                padding: "8px 10px",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {messages.length === 0 ? (
                <div style={{ opacity: 0.6, fontStyle: "italic" }}>
                  Describe what you want to build, sir. I can help with
                  proportions, sketch-out, or finding existing designs to
                  remix. Show me a photo via the camera if it&rsquo;s easier.
                </div>
              ) : (
                messages.map((m, i) => (
                  <div
                    key={i}
                    style={{
                      padding: "6px 8px",
                      borderRadius: 4,
                      background:
                        m.role === "user"
                          ? "rgba(255,255,255,0.04)"
                          : "rgba(108,214,255,0.10)",
                      border:
                        m.role === "user"
                          ? "1px solid var(--border)"
                          : "1px solid rgba(108,214,255,0.35)",
                      color: m.role === "user" ? "var(--text)" : "var(--hud)",
                      whiteSpace: "pre-wrap",
                      lineHeight: 1.5,
                    }}
                  >
                    <div
                      style={{
                        opacity: 0.55,
                        fontSize: 9,
                        textTransform: "uppercase",
                        letterSpacing: 1.5,
                        marginBottom: 2,
                      }}
                    >
                      {m.role === "user" ? "You" : "Alfred"}
                    </div>
                    {m.content}
                  </div>
                ))
              )}
              {error ? (
                <div style={{ color: "rgba(255,120,120,0.95)", fontSize: 10 }}>
                  {error}
                </div>
              ) : null}
            </div>
            <div
              style={{
                padding: 8,
                borderTop: "1px solid var(--border)",
                display: "flex",
                gap: 6,
              }}
            >
              <input
                data-testid="design-chat-input"
                type="text"
                placeholder='e.g. "design a phone stand 90mm tall"'
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSend();
                }}
                disabled={busy}
                style={{
                  flex: 1,
                  background: "rgba(0,0,0,0.4)",
                  color: "var(--hud)",
                  border: "1px solid var(--border)",
                  borderRadius: 3,
                  padding: "5px 8px",
                  fontSize: 11,
                  fontFamily: "inherit",
                }}
              />
              <button
                type="button"
                data-testid="design-chat-send"
                className="hud-button"
                onClick={() => void handleSend()}
                disabled={busy || !input.trim()}
                style={{ padding: "5px 10px", fontSize: 10 }}
              >
                {busy ? "…" : "SEND"}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function BlockedFallback() {
  return (
    <div
      data-testid="onshape-blocked"
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        color: "var(--muted)",
        fontFamily:
          'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
        textAlign: "center",
        padding: 32,
      }}
    >
      <div style={{ fontSize: 13, letterSpacing: 2, textTransform: "uppercase" }}>
        OnShape blocked the embed
      </div>
      <div style={{ fontSize: 12, maxWidth: 480, lineHeight: 1.6 }}>
        Some OnShape accounts (notably enterprise ones) refuse iframe
        embedding via X-Frame-Options. Open OnShape in its own tab and
        I&rsquo;ll keep helping from over here.
      </div>
      <a
        href={ONSHAPE_URL}
        target="_blank"
        rel="noreferrer"
        className="hud-button"
        style={{
          textDecoration: "none",
          padding: "8px 16px",
          letterSpacing: 1.5,
        }}
      >
        OPEN ONSHAPE ↗
      </a>
    </div>
  );
}
