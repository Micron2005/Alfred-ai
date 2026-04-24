"use client";

import type { ConversationSummary } from "@/lib/api";

interface Props {
  conversations: ConversationSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onDelete: (id: string) => void;
  busy?: boolean;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  const withinWeek = now.getTime() - d.getTime() < 7 * 24 * 60 * 60 * 1000;
  if (withinWeek) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function ConversationSidebar({
  conversations,
  activeId,
  onSelect,
  onNewChat,
  onDelete,
  busy,
}: Props) {
  return (
    <aside
      style={{
        width: 260,
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        position: "sticky",
        top: 0,
      }}
    >
      <div
        style={{
          padding: 16,
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span
          style={{
            fontSize: 12,
            letterSpacing: 0.8,
            textTransform: "uppercase",
            color: "var(--muted)",
          }}
        >
          Conversations
        </span>
        <button
          onClick={onNewChat}
          disabled={busy}
          title="Start a new conversation"
          style={{
            border: "1px solid var(--border)",
            background: "var(--accent)",
            color: "#fff",
            padding: "4px 10px",
            borderRadius: 6,
            cursor: busy ? "wait" : "pointer",
            fontSize: 12,
            letterSpacing: 0.3,
          }}
        >
          + New
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
        {conversations.length === 0 ? (
          <p
            style={{
              color: "var(--muted)",
              textAlign: "center",
              fontSize: 13,
              padding: "20px 16px",
              fontStyle: "italic",
            }}
          >
            No past conversations yet.
          </p>
        ) : (
          conversations.map((c) => {
            const isActive = c.id === activeId;
            return (
              <div
                key={c.id}
                onClick={() => onSelect(c.id)}
                style={{
                  padding: "10px 14px",
                  margin: "2px 8px",
                  borderRadius: 6,
                  cursor: "pointer",
                  background: isActive ? "var(--bubble-user)" : "transparent",
                  border: `1px solid ${isActive ? "var(--border)" : "transparent"}`,
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  position: "relative",
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: isActive ? 600 : 500,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    paddingRight: 20,
                  }}
                >
                  {c.title}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--muted)",
                    display: "flex",
                    justifyContent: "space-between",
                  }}
                >
                  <span>{formatWhen(c.last_message_at ?? c.created_at)}</span>
                  {c.mode === "nightfall" ? (
                    <span style={{ color: "var(--accent)", letterSpacing: 0.5 }}>
                      NIGHTFALL
                    </span>
                  ) : null}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (
                      window.confirm(`Delete "${c.title}"? This cannot be undone.`)
                    ) {
                      onDelete(c.id);
                    }
                  }}
                  aria-label="Delete conversation"
                  title="Delete"
                  style={{
                    position: "absolute",
                    right: 6,
                    top: 6,
                    background: "transparent",
                    border: "none",
                    color: "var(--muted)",
                    cursor: "pointer",
                    fontSize: 14,
                    lineHeight: 1,
                    padding: "2px 6px",
                    borderRadius: 4,
                  }}
                >
                  ×
                </button>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
