"use client";

/**
 * ChatTabView — full-screen layout for the CHAT tab.
 *
 * Two columns:
 *   - Left rail (narrow): conversation list + new-chat button.
 *   - Main pane (flex:1): the live chat pane (messages + composer).
 *
 * Replaces the previous behaviour where the entire chat (list +
 * pane) was crammed inside the 440 px ConversationSidebar while the
 * HUD continued to render alongside. Now the CHAT tab is a proper
 * full-window chat experience — the JARVIS HUD only shows up on
 * the HUD tab.
 */

import type { ConversationSummary } from "@/lib/api";
import { MemoryPanel } from "./MemoryPanel";
import { useState, useEffect } from "react";

type Tab = "conversation" | "archives" | "memory";
const TAB_KEY = "alfred.chatTabView.tab.v1";

interface Props {
  conversations: ConversationSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onDelete: (id: string) => void;
  busy?: boolean;
  /** Live chat pane (messages + composer). Always rendered; only its
   *  visibility flips when the user clicks ARCHIVES or MEMORY. */
  chatPane: React.ReactNode;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  const withinWeek = now.getTime() - d.getTime() < 7 * 24 * 60 * 60 * 1000;
  if (withinWeek) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function ChatTabView({
  conversations,
  activeId,
  onSelect,
  onNewChat,
  onDelete,
  busy,
  chatPane,
}: Props) {
  const [tab, setTabState] = useState<Tab>("conversation");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(TAB_KEY);
    if (stored === "conversation" || stored === "archives" || stored === "memory") {
      setTabState(stored);
    }
  }, []);
  const setTab = (next: Tab) => {
    setTabState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(TAB_KEY, next);
    }
  };

  return (
    <div
      data-testid="chat-tab-view"
      style={{
        display: "flex",
        flex: 1,
        minHeight: 0,
        height: "calc(100vh - 56px)",
      }}
    >
      {/* Left rail — narrow conversation list */}
      <aside
        style={{
          width: 280,
          flexShrink: 0,
          borderRight: "1px solid var(--border)",
          background: "var(--bg-elev)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        {/* Tab strip */}
        <div
          style={{
            display: "flex",
            gap: 4,
            padding: "10px 10px 8px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <RailTab
            active={tab === "conversation"}
            onClick={() => setTab("conversation")}
            label="CHAT"
          />
          <RailTab
            active={tab === "archives"}
            onClick={() => setTab("archives")}
            label="ARCHIVES"
          />
          <RailTab
            active={tab === "memory"}
            onClick={() => setTab("memory")}
            label="MEMORY"
          />
        </div>

        {/* New chat button — always visible at top */}
        <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
          <button
            type="button"
            data-testid="chat-tab-new-conversation"
            className="hud-button hud-button--primary"
            onClick={onNewChat}
            disabled={busy}
            title="Start a new conversation"
            style={{ width: "100%", padding: "6px 10px", fontSize: 11 }}
          >
            + NEW CONVERSATION
          </button>
        </div>

        {/* Rail body — depends on the active tab */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            minHeight: 0,
            padding: tab === "memory" ? 0 : "8px 6px",
          }}
        >
          {tab === "memory" ? (
            <MemoryPanel activeConversationId={activeId} />
          ) : conversations.length === 0 ? (
            <p
              className="mono"
              style={{
                color: "var(--muted)",
                textAlign: "center",
                fontSize: 10,
                padding: "20px 8px",
                fontStyle: "italic",
                opacity: 0.7,
              }}
            >
              No conversations yet.
            </p>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {conversations.map((c) => {
                const isActive = c.id === activeId;
                return (
                  <li
                    key={c.id}
                    data-testid={`chat-tab-conv-${c.id}`}
                    style={{
                      padding: "8px 10px",
                      marginBottom: 4,
                      borderRadius: 3,
                      border: isActive
                        ? "1px solid var(--hud)"
                        : "1px solid transparent",
                      background: isActive
                        ? "rgba(108, 214, 255, 0.06)"
                        : "transparent",
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                      transition: "background 120ms ease",
                    }}
                    onClick={() => onSelect(c.id)}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "baseline",
                        gap: 6,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 12,
                          color: "var(--fg)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          flex: 1,
                        }}
                      >
                        {c.title || "Untitled"}
                      </span>
                      <span
                        className="mono"
                        style={{
                          fontSize: 9,
                          color: "var(--muted)",
                          flexShrink: 0,
                        }}
                      >
                        {formatWhen(c.last_message_at)}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <span
                        className="mono"
                        style={{
                          fontSize: 9,
                          color: "var(--hud-soft)",
                          letterSpacing: 1,
                          textTransform: "uppercase",
                        }}
                      >
                        {c.mode}
                      </span>
                      <button
                        type="button"
                        data-testid={`chat-tab-delete-${c.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(`Delete "${c.title || "Untitled"}"?`)) {
                            onDelete(c.id);
                          }
                        }}
                        title="Delete conversation"
                        style={{
                          background: "transparent",
                          border: "none",
                          color: "var(--muted)",
                          cursor: "pointer",
                          fontSize: 12,
                          padding: "0 4px",
                          opacity: 0.6,
                        }}
                      >
                        ×
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* Main chat pane — fills remaining width */}
      <section
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          background:
            "radial-gradient(ellipse at top, rgba(108,214,255,0.02), transparent 60%)",
        }}
      >
        {chatPane}
      </section>
    </div>
  );
}

function RailTab({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`chat-tab-rail-${label.toLowerCase()}`}
      className="mono"
      style={{
        flex: 1,
        padding: "5px 4px",
        fontSize: 9,
        letterSpacing: 1.2,
        background: active ? "rgba(108, 214, 255, 0.08)" : "transparent",
        color: active ? "var(--hud)" : "var(--muted)",
        border: active ? "1px solid var(--hud)" : "1px solid transparent",
        cursor: "pointer",
        textShadow: active ? "0 0 6px var(--orb-glow)" : "none",
        transition: "all 120ms ease",
      }}
    >
      {label}
    </button>
  );
}
