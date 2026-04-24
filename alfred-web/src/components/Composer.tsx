"use client";

import { useState, type FormEvent, type KeyboardEvent } from "react";

interface ComposerProps {
  onSend: (text: string) => Promise<void> | void;
  disabled?: boolean;
}

export function Composer({ onSend, disabled }: ComposerProps) {
  const [text, setText] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    setText("");
    await onSend(trimmed);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit(e as unknown as FormEvent);
    }
  }

  return (
    <form
      onSubmit={submit}
      style={{
        display: "flex",
        gap: 8,
        padding: 12,
        borderTop: "1px solid var(--border)",
        background: "var(--bg)",
      }}
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder='Say "Hello Alfred" to begin…'
        rows={2}
        disabled={disabled}
        style={{
          flex: 1,
          resize: "none",
          padding: 10,
          borderRadius: 8,
          border: "1px solid var(--border)",
          background: "var(--bubble-assistant)",
          color: "var(--fg)",
          fontSize: 15,
        }}
      />
      <button
        type="submit"
        disabled={disabled || !text.trim()}
        style={{
          padding: "10px 18px",
          borderRadius: 8,
          border: "1px solid var(--border)",
          background: "var(--accent)",
          color: "#fff",
          cursor: disabled ? "wait" : "pointer",
          fontSize: 14,
          letterSpacing: 0.3,
        }}
      >
        Send
      </button>
    </form>
  );
}
