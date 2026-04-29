"use client";

/**
 * DesignView — third tab. Hosts the from-scratch CadStudio (a
 * react-three-fiber CAD viewport that the user owns end-to-end —
 * no external service iframe), an Alfred chat overlay docked
 * right, and the Creality K1 Max printer status strip docked
 * bottom.
 *
 * The CAD studio holds its own state (Zustand store in
 * cadStore.ts); DesignView is just the chrome that surrounds it.
 */

import { useEffect, useRef, useState } from "react";

import { CadStudio } from "@/components/CadStudio";
import { PrinterWidget } from "@/components/PrinterWidget";
import { sendMessage, type ChatMessageOut } from "@/lib/api";

interface Props {
  /** The conversation id to use for design-tab chat. The parent
   *  component owns this so it can persist alongside other
   *  conversation IDs in localStorage. */
  conversationId: string | null;
  onConversationCreated: (id: string) => void;
}

export function DesignView({ conversationId, onConversationCreated }: Props) {
  const [chatExpanded, setChatExpanded] = useState(true);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<
    Array<{ role: "user" | "assistant"; content: string }>
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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
      {/* The CAD studio fills the remaining space above the printer
          strip. The chat overlay floats to the right of the studio
          (absolutely positioned, not inside the studio's flex). */}
      <div style={{ position: "relative", flex: 1, display: "flex", minHeight: 0 }}>
        <CadStudio />

        {/* Right-docked chat overlay */}
        <div
          data-testid="design-chat-overlay"
          style={{
            position: "absolute",
            right: 12,
            top: 12,
            bottom: 12,
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
            aria-label={
              chatExpanded ? "Collapse design chat" : "Expand design chat"
            }
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
                    Tell me what you want to build, sir. I&rsquo;ll suggest
                    proportions, walk you through the geometry, or remix an
                    existing print idea. Voice/chat-driven scene editing
                    arrives in the next round.
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
                  <div
                    style={{ color: "rgba(255,120,120,0.95)", fontSize: 10 }}
                  >
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

      <PrinterWidget />
    </div>
  );
}
