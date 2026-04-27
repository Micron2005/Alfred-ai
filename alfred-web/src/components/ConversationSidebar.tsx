"use client";

import type { ConversationSummary } from "@/lib/api";

interface Props {
  conversations: ConversationSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onDelete: (id: string) => void;
  busy?: boolean;
  /** When ``true`` the sidebar collapses to a thin rail with just an
   * expand button — gives the chat the full window width. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
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
  collapsed = false,
  onToggleCollapsed,
}: Props) {
  if (collapsed) {
    // Thin rail mode — only the expand chevron + a quick "+ NEW"
    // shortcut so the user can still start a new conversation
    // without first re-opening the panel. Designed to be ~32 px wide
    // so the chat reclaims essentially the whole window.
    return (
      <aside
        style={{
          width: 32,
          borderRight: "1px solid var(--border)",
          background: "var(--bg-elev)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          height: "100vh",
          position: "sticky",
          top: 0,
          padding: "12px 0",
          gap: 8,
          boxShadow: "inset -1px 0 0 rgba(108, 214, 255, 0.04)",
        }}
      >
        <button
          type="button"
          className="hud-button hud-button--icon"
          onClick={onToggleCollapsed}
          title="Show conversation archive"
          aria-label="Show conversation archive"
          style={{ minWidth: 24, padding: "4px 6px", fontSize: 12 }}
        >
          ☰
        </button>
        <button
          type="button"
          className="hud-button hud-button--icon"
          onClick={onNewChat}
          disabled={busy}
          title="Start a new conversation"
          aria-label="Start a new conversation"
          style={{ minWidth: 24, padding: "4px 6px", fontSize: 12 }}
        >
          +
        </button>
      </aside>
    );
  }
  return (
    <aside
      style={{
        width: 260,
        borderRight: "1px solid var(--border)",
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.015) 0%, transparent 30%), var(--bg-elev)",
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        position: "sticky",
        top: 0,
        boxShadow: "inset -1px 0 0 rgba(108, 214, 255, 0.04)",
      }}
    >
      <div
        style={{
          padding: "16px 16px 12px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 10,
            color: "var(--muted)",
            opacity: 0.85,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {onToggleCollapsed ? (
            <button
              type="button"
              className="hud-button hud-button--icon"
              onClick={onToggleCollapsed}
              title="Hide conversation archive"
              aria-label="Hide conversation archive"
              style={{ minWidth: 22, padding: "2px 5px", fontSize: 11 }}
            >
              ◀
            </button>
          ) : null}
          ⟢ ARCHIVES
        </span>
        <button
          type="button"
          className="hud-button hud-button--primary"
          onClick={onNewChat}
          disabled={busy}
          title="Start a new conversation"
          style={{
            padding: "4px 10px",
            fontSize: 10,
          }}
        >
          + NEW
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
                  padding: "10px 12px 10px 14px",
                  margin: "2px 8px",
                  borderRadius: 3,
                  cursor: "pointer",
                  background: isActive
                    ? "rgba(108, 214, 255, 0.08)"
                    : "transparent",
                  border: `1px solid ${
                    isActive ? "var(--hud)" : "transparent"
                  }`,
                  boxShadow: isActive
                    ? "0 0 0 1px var(--hud), 0 0 14px var(--orb-glow)"
                    : "none",
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  position: "relative",
                  transition: "background 160ms ease, border-color 160ms ease",
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: isActive ? 600 : 500,
                    color: isActive ? "var(--fg)" : "var(--fg)",
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
                    fontSize: 10,
                    color: "var(--muted)",
                    display: "flex",
                    justifyContent: "space-between",
                    fontFamily:
                      'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
                    letterSpacing: 1,
                  }}
                >
                  <span>{formatWhen(c.last_message_at ?? c.created_at)}</span>
                  {c.mode === "nightfall" ? (
                    <span
                      style={{
                        color: "var(--accent)",
                        letterSpacing: 1.5,
                        textShadow: "0 0 6px var(--accent-soft)",
                      }}
                    >
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
                    right: 4,
                    top: 4,
                    background: "transparent",
                    border: "none",
                    color: "var(--muted)",
                    cursor: "pointer",
                    fontSize: 14,
                    lineHeight: 1,
                    padding: "2px 6px",
                    borderRadius: 3,
                    transition: "color 160ms ease",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = "var(--danger)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = "var(--muted)";
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
