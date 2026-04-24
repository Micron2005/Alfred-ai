"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ModeIndicator } from "@/components/ModeIndicator";
import { Message } from "@/components/Message";
import { Composer } from "@/components/Composer";
import { ConversationSidebar } from "@/components/ConversationSidebar";
import {
  type ChatMessageOut,
  type ConversationSummary,
  type Mode,
  deleteConversation,
  getConversation,
  listConversations,
  sendMessage,
} from "@/lib/api";

const ACTIVE_CONVO_KEY = "alfred.activeConversationId";

export function ChatWindow() {
  const [messages, setMessages] = useState<ChatMessageOut[]>([]);
  const [mode, setMode] = useState<Mode>("standard");
  const [convoId, setConvoId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingConvo, setLoadingConvo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Refresh the conversation list from the server.
  const refreshList = useCallback(async () => {
    try {
      const list = await listConversations();
      setConversations(list);
      return list;
    } catch {
      return [];
    }
  }, []);

  // Load a specific conversation's messages.
  const loadConversation = useCallback(async (id: string) => {
    setLoadingConvo(true);
    setError(null);
    try {
      const detail = await getConversation(id);
      setMessages(detail.messages);
      setConvoId(detail.id);
      setMode(detail.mode as Mode);
      localStorage.setItem(ACTIVE_CONVO_KEY, detail.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load conversation");
      localStorage.removeItem(ACTIVE_CONVO_KEY);
      setConvoId(null);
      setMessages([]);
    } finally {
      setLoadingConvo(false);
    }
  }, []);

  // On first mount: list conversations + restore last active conversation
  // (if any) so the user picks up where they left off. Mode is per-conversation
  // and defaults to standard; it gets set from the loaded conversation.
  useEffect(() => {
    void (async () => {
      const list = await refreshList();
      const saved =
        typeof window !== "undefined"
          ? localStorage.getItem(ACTIVE_CONVO_KEY)
          : null;
      const stillExists = saved && list.some((c) => c.id === saved);
      if (stillExists) {
        await loadConversation(saved);
      } else if (saved) {
        localStorage.removeItem(ACTIVE_CONVO_KEY);
      }
    })();
  }, [refreshList, loadConversation]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  useEffect(() => {
    if (mode === "nightfall") {
      document.body.classList.add("nightfall");
    } else {
      document.body.classList.remove("nightfall");
    }
  }, [mode]);

  async function handleSend(text: string) {
    setError(null);
    const userMsg: ChatMessageOut = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    };
    setMessages((prev) => [...prev, userMsg]);
    setBusy(true);
    try {
      const reply = await sendMessage(text, convoId);
      setConvoId(reply.conversation_id);
      localStorage.setItem(ACTIVE_CONVO_KEY, reply.conversation_id);
      setMode(reply.mode);
      setMessages((prev) => [...prev, reply.assistant]);
      await refreshList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  function handleNewChat() {
    setConvoId(null);
    setMessages([]);
    setMode("standard");
    setError(null);
    localStorage.removeItem(ACTIVE_CONVO_KEY);
  }

  async function handleDelete(id: string) {
    try {
      await deleteConversation(id);
      if (id === convoId) {
        handleNewChat();
      }
      await refreshList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete");
    }
  }

  const greeting =
    mode === "nightfall" ? "At your service, Batman." : "At your service, sir.";

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <ConversationSidebar
        conversations={conversations}
        activeId={convoId}
        onSelect={(id) => {
          if (id !== convoId) void loadConversation(id);
        }}
        onNewChat={handleNewChat}
        onDelete={(id) => void handleDelete(id)}
        busy={busy || loadingConvo}
      />

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          maxWidth: 820,
          margin: "0 auto",
          padding: "0 16px",
          width: "100%",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "20px 0",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontSize: 28, letterSpacing: 0.5 }}>Alfred</h1>
            <p style={{ margin: 0, color: "var(--muted)", fontSize: 13 }}>
              {greeting}
            </p>
          </div>
          <ModeIndicator mode={mode} />
        </header>

        <main
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "20px 0",
          }}
        >
          {loadingConvo ? (
            <p style={{ color: "var(--muted)", textAlign: "center", marginTop: 40 }}>
              Alfred is retrieving the conversation…
            </p>
          ) : messages.length === 0 ? (
            <p style={{ color: "var(--muted)", textAlign: "center", marginTop: 40 }}>
              Say &ldquo;Hello Alfred&rdquo; to begin.
            </p>
          ) : (
            messages.map((m) => <Message key={m.id} msg={m} />)
          )}
          {busy ? (
            <p style={{ color: "var(--muted)", fontStyle: "italic", fontSize: 13 }}>
              Alfred is composing a reply…
            </p>
          ) : null}
          {error ? (
            <p
              style={{
                color: "#b33",
                fontSize: 13,
                background: "rgba(179, 51, 51, 0.08)",
                padding: 10,
                borderRadius: 6,
              }}
            >
              {error}
            </p>
          ) : null}
          <div ref={endRef} />
        </main>

        <Composer onSend={handleSend} disabled={busy || loadingConvo} />
      </div>
    </div>
  );
}
