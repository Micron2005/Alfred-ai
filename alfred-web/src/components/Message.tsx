"use client";

import type { ChatMessageOut } from "@/lib/api";

export function Message({ msg }: { msg: ChatMessageOut }) {
  const isUser = msg.role === "user";
  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        marginBottom: 12,
      }}
    >
      <div
        style={{
          maxWidth: "80%",
          padding: "10px 14px",
          borderRadius: 12,
          background: isUser ? "var(--bubble-user)" : "var(--bubble-assistant)",
          border: "1px solid var(--border)",
          boxShadow: "var(--shadow)",
          whiteSpace: "pre-wrap",
          lineHeight: 1.5,
        }}
      >
        {msg.content}
        {msg.backend && !isUser ? (
          <div
            style={{
              marginTop: 6,
              fontSize: 11,
              color: "var(--muted)",
              fontFamily: "ui-monospace, Menlo, monospace",
            }}
          >
            via {msg.backend}
            {msg.model ? ` · ${msg.model}` : ""}
          </div>
        ) : null}
      </div>
    </div>
  );
}
