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
        marginBottom: 14,
      }}
    >
      {/*
        Wrapper holds the bubble + the four HUD corner brackets that
        only appear on assistant turns (a touch of the Wayne Manor
        warmth — drawn in the gold/amber accent). User turns get a
        plainer cyan border to keep them visually subordinate.
      */}
      <div
        className={isUser ? undefined : "hud-corners"}
        style={{
          maxWidth: "80%",
          position: "relative",
        }}
      >
        {/* Two extra spans for the bottom corners — ::before/::after
            already cover the top two via .hud-corners. */}
        {!isUser && (
          <>
            <span className="hud-corner-bl" />
            <span className="hud-corner-br" />
          </>
        )}
        <div
          style={{
            padding: "12px 16px",
            borderRadius: 3,
            background: isUser
              ? "var(--bubble-user)"
              : "var(--bubble-assistant)",
            border: `1px solid ${
              isUser ? "var(--border)" : "var(--border-warm)"
            }`,
            boxShadow: "var(--shadow)",
            whiteSpace: "pre-wrap",
            lineHeight: 1.55,
            display: "flex",
            flexDirection: "column",
            gap: images.length > 0 && msg.content ? 8 : 0,
            color: "var(--fg)",
          }}
        >
          {/* Tiny role label in monospace */}
          <div
            className="mono"
            style={{
              fontSize: 9,
              color: isUser ? "var(--hud)" : "var(--accent)",
              opacity: 0.7,
              marginBottom: 4,
              letterSpacing: 2,
            }}
          >
            {isUser ? "▸ YOU" : "◂ ALFRED"}
          </div>
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
                // Assistant-generated images are the centerpiece of
                // the reply, so they get a roomier max size; user
                // attachments stay compact since they're usually
                // reference material the model is being asked about.
                const maxSide = isUser ? 240 : 480;
                return (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={idx}
                    src={src}
                    alt={isUser ? "attached" : "generated"}
                    style={{
                      maxWidth: maxSide,
                      maxHeight: maxSide,
                      borderRadius: 3,
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
                marginTop: 10,
                paddingTop: 8,
                borderTop: "1px dashed var(--border-warm)",
                display: "flex",
                flexDirection: "column",
                gap: 4,
                fontSize: 12,
              }}
            >
              <div
                className="mono"
                style={{
                  fontSize: 10,
                  color: "var(--accent)",
                  opacity: 0.85,
                }}
              >
                ⟢ SOURCES
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
                    transition: "color 160ms ease, text-shadow 160ms ease",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.textShadow =
                      "0 0 8px var(--accent-soft)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.textShadow = "none";
                  }}
                >
                  {s.title || s.url}
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
