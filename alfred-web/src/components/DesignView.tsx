"use client";

/**
 * DesignView — third tab. OnShape blocks iframe embedding via
 * ``X-Frame-Options: SAMEORIGIN``, so we don't try; instead we
 * present a launcher card that opens OnShape in a new tab and
 * keep Alfred's chat assist + printer strip alongside it.
 *
 * The launcher card is large + central so the tab feels
 * intentional, not like a placeholder. As soon as the user
 * clicks "Open OnShape", the new tab takes them to cad.onshape.com
 * and they keep this tab open for Alfred chat / printer status.
 *
 * The chat overlay calls the backend ``/chat`` endpoint with a
 * separate conversation thread so design back-and-forth doesn't
 * pollute the main chat.
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

/**
 * Useful third-party launchers we surface alongside OnShape, so
 * the Design tab is a hub for "find or build a model to print"
 * not just a single-app launcher. All open in a new tab.
 */
const LAUNCHERS: ReadonlyArray<{
  id: string;
  name: string;
  blurb: string;
  url: string;
  icon: string;
}> = [
  {
    id: "onshape",
    name: "OnShape",
    blurb:
      "Full parametric CAD in the browser. Sign in once and your designs sync to every device on your account.",
    url: ONSHAPE_URL,
    icon: "📐",
  },
  {
    id: "thingiverse",
    name: "Thingiverse",
    blurb:
      "Largest free library of printable models. Search what you need, download the .stl, drop it in your slicer.",
    url: "https://www.thingiverse.com/search",
    icon: "🔎",
  },
  {
    id: "printables",
    name: "Printables",
    blurb:
      "Prusa-curated model library. Often higher print-quality than Thingiverse.",
    url: "https://www.printables.com/search/models",
    icon: "🧩",
  },
  {
    id: "makerworld",
    name: "MakerWorld",
    blurb:
      "Bambu's library — heavy on optimised, multi-colour-ready prints.",
    url: "https://makerworld.com/en/3d-models",
    icon: "🌐",
  },
];

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
        background:
          "radial-gradient(1200px 600px at 50% 30%, rgba(108,214,255,0.06) 0%, transparent 70%), #06090f",
      }}
    >
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "32px 24px 96px",
          // Leave room on the right for the fixed chat overlay.
          paddingRight: chatExpanded ? 360 : 80,
        }}
      >
        <div style={{ maxWidth: 980, margin: "0 auto" }}>
          <h2
            className="mono"
            style={{
              fontSize: 22,
              letterSpacing: 6,
              color: "var(--hud)",
              textShadow: "0 0 12px var(--orb-glow)",
              fontWeight: 500,
              margin: 0,
            }}
          >
            DESIGN STUDIO
          </h2>
          <p
            style={{
              color: "var(--muted)",
              fontStyle: "italic",
              fontSize: 13,
              margin: "4px 0 28px",
            }}
          >
            For the things you&rsquo;d like to print, sir.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              gap: 14,
            }}
          >
            {LAUNCHERS.map((l) => (
              <a
                key={l.id}
                href={l.url}
                target="_blank"
                rel="noreferrer"
                data-testid={`launcher-${l.id}`}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  padding: 16,
                  background:
                    "linear-gradient(135deg, rgba(108,214,255,0.06) 0%, rgba(8,14,24,0.85) 100%)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  color: "var(--hud)",
                  textDecoration: "none",
                  cursor: "pointer",
                  transition: "transform 200ms ease, box-shadow 200ms ease, border-color 200ms ease",
                  position: "relative",
                  overflow: "hidden",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = "translateY(-3px)";
                  e.currentTarget.style.boxShadow =
                    "0 8px 24px rgba(108,214,255,0.18), 0 0 0 1px var(--orb)";
                  e.currentTarget.style.borderColor = "var(--orb)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = "translateY(0)";
                  e.currentTarget.style.boxShadow = "none";
                  e.currentTarget.style.borderColor = "var(--border)";
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 28 }}>{l.icon}</span>
                  <span
                    style={{
                      fontFamily:
                        'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
                      fontSize: 14,
                      letterSpacing: 2.5,
                      textTransform: "uppercase",
                      fontWeight: 600,
                      color: "var(--hud)",
                    }}
                  >
                    {l.name}
                  </span>
                </div>
                <p
                  style={{
                    margin: 0,
                    color: "var(--muted)",
                    fontSize: 12,
                    lineHeight: 1.55,
                  }}
                >
                  {l.blurb}
                </p>
                <span
                  style={{
                    position: "absolute",
                    top: 12,
                    right: 12,
                    fontSize: 11,
                    color: "var(--muted)",
                    opacity: 0.7,
                  }}
                >
                  ↗
                </span>
              </a>
            ))}
          </div>

          <div
            style={{
              marginTop: 32,
              padding: 14,
              borderLeft: "2px solid var(--orb-soft)",
              background: "rgba(108,214,255,0.04)",
              fontFamily:
                'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
              fontSize: 11,
              lineHeight: 1.7,
              color: "var(--muted)",
            }}
          >
            <strong style={{ color: "var(--hud)", letterSpacing: 1.5 }}>
              TIP
            </strong>
            <span style={{ marginLeft: 8 }}>
              Describe what you want in the chat panel and I&rsquo;ll suggest
              dimensions, search queries, or remix ideas. Show me a photo with
              the camera and I&rsquo;ll talk you through what to model.
            </span>
          </div>
        </div>
      </div>

      <PrinterWidget />

      {/* Right-docked chat overlay */}
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
