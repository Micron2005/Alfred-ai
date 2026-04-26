"use client";

import type { ChatMessageOut } from "@/lib/api";

export function Message({ msg }: { msg: ChatMessageOut }) {
  const isUser = msg.role === "user";
  const images = msg.images ?? [];
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
      </div>
    </div>
  );
}
