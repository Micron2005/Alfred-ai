"use client";

import { useEffect, useState } from "react";
import type { ConversationSummary } from "@/lib/api";

const TAB_KEY = "alfred.sidebarTab";
type Tab = "conversation" | "archives";

interface Props {
  conversations: ConversationSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onDelete: (id: string) => void;
  busy?: boolean;
  /** When ``true`` the sidebar collapses to a thin rail with just an
   * expand button — gives the HUD the full window width. The chat
   * pane is still mounted (hidden via CSS) so that
   * ``composerRef``/``cameraRef`` and any in-flight recording stay
   * alive across collapse/expand cycles. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** The active conversation pane (messages + composer + error
   * banners). The sidebar mounts this in the "CONVERSATION" tab so
   * the chat lives in the side panel and the main pane is left to
   * the JARVIS HUD. The element is **always** rendered (just hidden
   * with off-screen positioning when not in the conversation tab or
   * when the sidebar is collapsed) so refs into the Composer /
   * wake-word pipeline don't get nulled out by tab switches or
   * collapses. */
  chatPane: React.ReactNode;
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
  chatPane,
}: Props) {
  // Tab persistence — once you've picked a tab the choice sticks.
  // Default ``conversation`` so first paint shows the active chat
  // (the user almost always wants the chat, not the archive list).
  const [tab, setTabState] = useState<Tab>("conversation");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(TAB_KEY);
    if (
      stored === "archives" ||
      stored === "conversation"
    ) {
      setTabState(stored);
    }
  }, []);
  const setTab = (next: Tab) => {
    setTabState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(TAB_KEY, next);
    }
  };

  // The chat pane (Composer, message list, etc.) must stay mounted
  // across collapse-toggle and tab-switch transitions — otherwise
  // ``composerRef.current`` gets nulled out, in-flight recordings
  // are torn down, and any typed-but-not-sent text or attached
  // images are lost.
  //
  // **The structural rule** is that this slot has to occupy the
  // *same JSX position with the same key* in every render of
  // ``ConversationSidebar``, regardless of ``collapsed`` /
  // ``tab``. React reconciles children by index, so swapping
  // wholesale return branches (early ``return`` for the collapsed
  // case, etc.) breaks the invariant and remounts the slot. We
  // therefore render a single ``<aside>`` shell with one stable
  // child layout: a top-row ``<div>`` (rail buttons or tab strip)
  // + the chat pane slot + the optional archives list.
  const chatVisible = !collapsed && tab === "conversation";

  return (
    <aside
      // ``key`` on the aside isn't strictly required (it's already
      // at a stable position in ChatWindow's tree), but width is
      // styled inline so the element keeps the same identity across
      // collapse toggles — no remount.
      style={{
        // Three tabs (CHAT / ARCHIVES / MEMORY) need a touch more
        // horizontal room than the original two so the labels don't
        // wrap. The HUD scales to fit the remaining width via the
        // responsive ``HudCanvas`` (Phase 12a tweaks PR #21).
        width: collapsed ? 32 : 440,
        borderRight: "1px solid var(--border)",
        background: collapsed
          ? "var(--bg-elev)"
          : "linear-gradient(180deg, rgba(255,255,255,0.015) 0%, transparent 30%), var(--bg-elev)",
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        position: "sticky",
        top: 0,
        boxShadow: "inset -1px 0 0 rgba(108, 214, 255, 0.04)",
        // Important: ``relative`` so the off-screen chat-pane slot
        // (``position:absolute; left:-99999px``) is anchored to the
        // sidebar rather than the document.
        // ``position:sticky`` already establishes a containing
        // block — making it explicit here for readers.
      }}
    >
      {/*
        Top row — rail buttons when collapsed, tab strip + new-chat
        when expanded. Same JSX position in both modes so its
        children reconcile cleanly.
      */}
      {collapsed ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            padding: "12px 0",
            gap: 8,
          }}
        >
          <button
            type="button"
            className="hud-button hud-button--icon"
            onClick={onToggleCollapsed}
            title="Show conversation panel"
            aria-label="Show conversation panel"
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
        </div>
      ) : (
        <div
          style={{
            padding: "10px 12px",
            borderBottom: "1px solid var(--border)",
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
              title="Hide conversation panel"
              aria-label="Hide conversation panel"
              style={{ minWidth: 22, padding: "3px 6px", fontSize: 11 }}
            >
              ◀
            </button>
          ) : null}
          <SidebarTab
            active={tab === "conversation"}
            onClick={() => setTab("conversation")}
            label="◇ CHAT"
            title="Active conversation"
          />
          <SidebarTab
            active={tab === "archives"}
            onClick={() => setTab("archives")}
            label="⟢ ARCHIVES"
            title="Saved conversations"
          />
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="hud-button hud-button--primary"
            onClick={onNewChat}
            disabled={busy}
            title="Start a new conversation"
            style={{ padding: "4px 10px", fontSize: 10 }}
          >
            + NEW
          </button>
        </div>
      )}

      {/*
        STABLE chat-pane slot. Always at this position in the JSX
        tree, with the same key, so React never unmounts it on
        collapse-toggle / tab-switch — the Composer's ref +
        recording state + typed text + attached images all survive.
        ``visibility``/positioning swaps in & out without affecting
        identity.
      */}
      <div
        key="chat-pane-slot"
        aria-hidden={!chatVisible}
        style={
          chatVisible
            ? {
                flex: 1,
                display: "flex",
                flexDirection: "column",
                minHeight: 0, // critical so inner ``overflow:auto`` works
              }
            : {
                position: "absolute",
                left: -99999,
                top: 0,
                width: 1,
                height: 1,
                overflow: "hidden",
                pointerEvents: "none",
              }
        }
      >
        {chatPane}
      </div>

      {/*
        Archives list — only mounted when expanded + on the archives
        tab. Conditional placement here is fine because (unlike the
        chat pane) the archives panel has no refs / recordings that
        need to survive remounts.
      */}
      {!collapsed && tab === "archives" ? (
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
                  onClick={() => {
                    onSelect(c.id);
                    setTab("conversation");
                  }}
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
                      color: "var(--fg)",
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
                        window.confirm(
                          `Delete "${c.title}"? This cannot be undone.`,
                        )
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
      ) : null}

      {/*
        Memory panel removed (user-facing UI gone). Long-term memory
        archive still works behind the scenes — chat retrieval injects
        relevant past notes, [REMEMBER_CONVERSATION] markers still
        archive transcripts to alfred-memory/, the API endpoints stay
        exposed for power-user curl access — but no in-HUD browser.
      */}
    </aside>
  );
}

function SidebarTab({
  active,
  onClick,
  label,
  title,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="mono"
      style={{
        background: active ? "rgba(108, 214, 255, 0.08)" : "transparent",
        color: active ? "var(--hud)" : "var(--muted)",
        border: `1px solid ${active ? "var(--hud)" : "transparent"}`,
        boxShadow: active ? "0 0 10px var(--orb-glow)" : "none",
        borderRadius: 3,
        padding: "4px 8px",
        fontSize: 10,
        letterSpacing: 1.5,
        cursor: "pointer",
        transition: "background 160ms ease, color 160ms ease",
      }}
    >
      {label}
    </button>
  );
}
