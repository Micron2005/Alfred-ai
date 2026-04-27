"use client";

import type { ChatMessageOut, ChatSource } from "@/lib/api";

export function Message({ msg }: { msg: ChatMessageOut }) {
  const isUser = msg.role === "user";
  const images = msg.images ?? [];
  // Sources only appear on assistant turns, and only when Alfred
  // actually consulted the web for this reply. Drop the synthetic
  // "Search summary" entry from the visible list — it has no URL,
  // so a footer chip would be confusing.
  const sources: ChatSource[] = (msg.sources ?? []).filter((s) => !!s.url);
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
          display: "flex",
          flexDirection: "column",
          gap: images.length > 0 && msg.content ? 8 : 0,
        }}
      >
        {images.length > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              maxWidth: "100%",
            }}
          >
            {images.map((img, idx) => {
              const src = `data:${img.mime_type};base64,${img.data}`;
              return (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={idx}
                  src={src}
                  alt="attached"
                  style={{
                    maxWidth: 240,
                    maxHeight: 240,
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                    objectFit: "contain",
                  }}
                />
              );
            })}
          </div>
        )}
        {msg.content && <span>{msg.content}</span>}
        {sources.length > 0 && (
          <div
            style={{
              marginTop: 8,
              paddingTop: 8,
              borderTop: "1px dashed var(--border)",
              display: "flex",
              flexDirection: "column",
              gap: 4,
              fontSize: 12,
              opacity: 0.85,
            }}
          >
            <div style={{ fontWeight: 600, opacity: 0.7 }}>
              🔎 Sources
            </div>
            {sources.map((s, idx) => (
              <a
                key={`${s.url}-${idx}`}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                title={s.snippet}
                style={{
                  color: "var(--accent)",
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  maxWidth: "100%",
                }}
              >
                {s.title || s.url}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
