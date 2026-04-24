"use client";

import { useEffect, useRef, useState } from "react";
import { ModeIndicator } from "@/components/ModeIndicator";
import { Message } from "@/components/Message";
import { Composer } from "@/components/Composer";
import { type ChatMessageOut, type Mode, getMode, sendMessage } from "@/lib/api";

export function ChatWindow() {
  const [messages, setMessages] = useState<ChatMessageOut[]>([]);
  const [mode, setMode] = useState<Mode>("standard");
  const [convoId, setConvoId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void getMode()
      .then(setMode)
      .catch(() => {
        // backend may not be up yet; stay on standard
      });
  }, []);

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
      setMode(reply.mode);
      setMessages((prev) => [...prev, reply.assistant]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        maxWidth: 820,
        margin: "0 auto",
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        padding: "0 16px",
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
            {mode === "nightfall" ? "At your service, Batman." : "At your service, sir."}
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
        {messages.length === 0 ? (
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

      <Composer onSend={handleSend} disabled={busy} />
    </div>
  );
}
