"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { transcribeAudio } from "@/lib/api";

interface ComposerProps {
  onSend: (text: string) => Promise<void> | void;
  disabled?: boolean;
}

type MicState = "idle" | "recording" | "transcribing";

export function Composer({ onSend, disabled }: ComposerProps) {
  const [text, setText] = useState("");
  const [mic, setMic] = useState<MicState>("idle");
  const [micError, setMicError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    return () => {
      // Cleanup if the user navigates away mid-recording.
      const rec = recorderRef.current;
      if (rec && rec.state !== "inactive") rec.stop();
    };
  }, []);

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

  async function startRecording() {
    setMicError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        chunksRef.current = [];
        if (blob.size === 0) {
          setMic("idle");
          return;
        }
        setMic("transcribing");
        try {
          const transcript = await transcribeAudio(blob);
          if (transcript.trim()) {
            await onSend(transcript.trim());
          }
        } catch (err) {
          setMicError(err instanceof Error ? err.message : "Transcription failed");
        } finally {
          setMic("idle");
        }
      };
      recorderRef.current = recorder;
      recorder.start();
      setMic("recording");
    } catch (err) {
      setMicError(
        err instanceof Error
          ? `Microphone unavailable: ${err.message}`
          : "Microphone unavailable",
      );
      setMic("idle");
    }
  }

  function stopRecording() {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
  }

  function toggleMic() {
    if (mic === "recording") stopRecording();
    else if (mic === "idle") void startRecording();
  }

  const micBusy = mic !== "idle";
  const micLabel =
    mic === "recording"
      ? "Stop recording"
      : mic === "transcribing"
        ? "Transcribing…"
        : "Speak to Alfred";
  const micGlyph = mic === "recording" ? "■" : mic === "transcribing" ? "…" : "🎙";

  return (
    <form
      onSubmit={submit}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: 12,
        borderTop: "1px solid var(--border)",
        background: "var(--bg)",
      }}
    >
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={toggleMic}
          disabled={disabled || mic === "transcribing"}
          aria-label={micLabel}
          title={micLabel}
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background:
              mic === "recording" ? "#b91c1c" : "var(--bubble-assistant)",
            color: mic === "recording" ? "#fff" : "var(--fg)",
            cursor: disabled || mic === "transcribing" ? "wait" : "pointer",
            fontSize: 16,
            minWidth: 48,
          }}
        >
          {micGlyph}
        </button>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            mic === "recording"
              ? "Listening…"
              : mic === "transcribing"
                ? "Transcribing your message…"
                : 'Say "Hello Alfred" — or hit the mic to speak.'
          }
          rows={2}
          disabled={disabled || micBusy}
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
          disabled={disabled || micBusy || !text.trim()}
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
      </div>
      {micError && (
        <div style={{ color: "#b91c1c", fontSize: 12 }}>{micError}</div>
      )}
    </form>
  );
}
