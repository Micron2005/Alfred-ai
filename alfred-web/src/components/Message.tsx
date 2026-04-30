"use client";

import { useEffect, useMemo } from "react";

import type { ChatMessageOut, ChatModel, ChatSource } from "@/lib/api";

/** Decode a base-64 string into a ``Blob`` of the given MIME type.
 *
 * Used to materialise STL bytes for the "Download" link without
 * keeping them as a giant data: URL (Chrome caps anchor href length
 * around ~2 MB). The blob: URL approach handles arbitrary sizes. */
function base64ToBlob(b64: string, mime: string): Blob {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

export function Message({ msg }: { msg: ChatMessageOut }) {
  const isUser = msg.role === "user";
  const images = msg.images ?? [];
  // Memoise so the ``useMemo``/``useEffect`` cleanup below see a
  // stable reference rather than a brand-new array on every render.
  // Without this the blob: URLs would be revoked + recreated each
  // tick, causing the download link to break mid-click.
  const models: ChatModel[] = useMemo(() => msg.models ?? [], [msg.models]);
  // Sources only appear on assistant turns, and only when Alfred
  // actually consulted the web for this reply. Drop the synthetic
  // "Search summary" entry from the visible list — it has no URL,
  // so a footer chip would be confusing.
  const sources: ChatSource[] = (msg.sources ?? []).filter((s) => !!s.url);

  // Materialise STL bytes into stable blob: URLs once per mount.
  // Recomputing on every render would leak a URL each time; revoking
  // on unmount keeps memory bounded as the user scrolls back through
  // long histories with many models.
  const stlUrls = useMemo(
    () =>
      models.map((mdl) => {
        const blob = base64ToBlob(mdl.stl_data, "model/stl");
        return URL.createObjectURL(blob);
      }),
    // We deliberately key on the models reference, not their content.
    // Messages are immutable after they land, so the ref change only
    // happens when a new message arrives, which is the correct moment
    // to recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [models],
  );
  useEffect(() => {
    return () => {
      stlUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [stlUrls]);

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
            gap:
              (images.length > 0 || models.length > 0) && msg.content
                ? 8
                : 0,
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
          {models.length > 0 && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                maxWidth: "100%",
              }}
            >
              {models.map((mdl, idx) => {
                const previewSrc = mdl.preview_data
                  ? `data:image/png;base64,${mdl.preview_data}`
                  : null;
                const stlHref = stlUrls[idx];
                const filename = `${mdl.name || "model"}.stl`;
                return (
                  <div
                    key={idx}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      padding: 8,
                      background: "rgba(0,0,0,0.2)",
                      border: "1px solid var(--border-warm)",
                      borderRadius: 3,
                    }}
                  >
                    {previewSrc && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={previewSrc}
                        alt={mdl.name || "model preview"}
                        style={{
                          maxWidth: 480,
                          width: "100%",
                          borderRadius: 3,
                          background: "rgba(0,0,0,0.4)",
                        }}
                      />
                    )}
                    <div
                      style={{
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
                          color: "var(--accent)",
                          opacity: 0.85,
                          letterSpacing: 1.5,
                        }}
                      >
                        ⌬ {filename}
                      </span>
                      <div style={{ display: "flex", gap: 6 }}>
                        {mdl.document_url && (
                          <a
                            href={mdl.document_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mono"
                            style={{
                              fontSize: 11,
                              color: "var(--accent)",
                              textDecoration: "none",
                              padding: "3px 10px",
                              border: "1px solid var(--border-warm)",
                              borderRadius: 2,
                              letterSpacing: 1,
                            }}
                          >
                            OPEN IN ONSHAPE
                          </a>
                        )}
                        <a
                          href={stlHref}
                          download={filename}
                          className="mono"
                          style={{
                            fontSize: 11,
                            color: "var(--accent)",
                            textDecoration: "none",
                            padding: "3px 10px",
                            border: "1px solid var(--border-warm)",
                            borderRadius: 2,
                            letterSpacing: 1,
                          }}
                        >
                          DOWNLOAD STL
                        </a>
                      </div>
                    </div>
                  </div>
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
