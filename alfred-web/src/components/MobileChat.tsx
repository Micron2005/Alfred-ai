"use client";

/**
 * MobileChat — phone-optimised Alfred shell.
 *
 * Strips the JARVIS HUD (orb, radial menu, holographic earth, hand
 * tracking, vitals) and renders a clean text-message-style UI:
 *   • Conversation history in the centre
 *   • Bottom toolbar: text input, mic-hold-to-talk, camera button
 *   • Optional one-line location indicator at the top so the user
 *     knows whether GPS is being shared
 *
 * The same backend endpoints as the desktop UI:
 *   - POST /chat                 → text reply
 *   - POST /voice/stt            → speech-to-text
 *   - POST /voice/tts            → text-to-speech
 *   - POST /api/location/me      → GPS sharing
 *
 * Because the mobile UI is a different React tree from ChatWindow,
 * conversation state is local — switching between phone and desktop
 * doesn't share an in-progress message but the persisted conversation
 * (kept in Postgres by the backend) is shared via the conversation_id.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ChatImage,
  readFileAsChatImage,
  sendMessage,
  synthesizeSpeech,
  transcribeAudio,
} from "@/lib/api";
import { useDeviceLocation } from "@/lib/useDeviceLocation";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  imagePreview?: string;
  ts: number;
}

const CONVO_KEY = "alfred.mobile.convoId.v1";

export function MobileChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [locationEnabled, setLocationEnabled] = useState<boolean>(true);
  const [voiceOut, setVoiceOut] = useState(true);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-share GPS for the holographic Earth. The user can turn
  // this off via the small toggle at the top of the screen.
  const loc = useDeviceLocation({ kind: "phone", enabled: locationEnabled });

  // Persist conversationId across reloads so the phone keeps its
  // chat thread when you swipe back to Alfred.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(CONVO_KEY);
    if (stored) setConversationId(stored);
  }, []);
  useEffect(() => {
    if (!conversationId) return;
    window.localStorage.setItem(CONVO_KEY, conversationId);
  }, [conversationId]);

  // Always keep the message rail scrolled to the latest message.
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  // ─── Speak (TTS) ─────────────────────────────────────────────────
  const speak = useCallback(async (text: string) => {
    try {
      const blob = await synthesizeSpeech(text);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      audioRef.current?.pause();
      audioRef.current = audio;
      await audio.play().catch(() => {
        /* iOS Safari blocks autoplay until first user gesture; fail silently */
      });
    } catch {
      /* TTS failures aren't worth surfacing to the user — the text is on screen */
    }
  }, []);

  // ─── Send (text + optional images) ───────────────────────────────
  const send = useCallback(
    async (text: string, images: ChatImage[] = [], imagePreview?: string) => {
      const cleaned = text.trim();
      if (!cleaned && images.length === 0) return;
      if (sending) return;
      setError(null);
      setSending(true);
      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: cleaned || "(image)",
        imagePreview,
        ts: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setInput("");
      try {
        const reply = await sendMessage(
          cleaned || "What's in this image?",
          conversationId,
          images,
          null,
        );
        if (reply.conversation_id) setConversationId(reply.conversation_id);
        const assistantMsg: Message = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: reply.assistant.content,
          ts: Date.now(),
        };
        setMessages((prev) => [...prev, assistantMsg]);
        if (voiceOut) void speak(reply.assistant.content);
      } catch (exc) {
        const message = exc instanceof Error ? exc.message : String(exc);
        setError(message);
      } finally {
        setSending(false);
      }
    },
    [conversationId, sending, speak, voiceOut],
  );

  // ─── Voice — push-to-talk recorder ───────────────────────────────
  const startRecording = useCallback(async () => {
    if (recording || sending) return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        if (blob.size === 0) {
          setError("No audio captured. Hold the mic for at least a second.");
          return;
        }
        try {
          const text = await transcribeAudio(blob);
          if (text.trim()) await send(text);
          else setError("Couldn't make out what you said.");
        } catch (exc) {
          const message = exc instanceof Error ? exc.message : String(exc);
          setError(message);
        }
      };
      mr.start();
      recorderRef.current = mr;
      setRecording(true);
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(`Mic blocked: ${message}`);
    }
  }, [recording, sending, send]);

  const stopRecording = useCallback(() => {
    if (!recorderRef.current) return;
    if (recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    recorderRef.current = null;
    setRecording(false);
  }, []);

  // ─── Camera / photo upload ───────────────────────────────────────
  const onFilePicked = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setError(null);
      try {
        const image = await readFileAsChatImage(file);
        // Build a small data URL for the in-thread preview thumb.
        const preview = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.onerror = () => reject(reader.error ?? new Error("preview failed"));
          reader.readAsDataURL(file);
        });
        await send(input || "What's in this image?", [image], preview);
      } catch (exc) {
        const message = exc instanceof Error ? exc.message : String(exc);
        setError(message);
      }
    },
    [input, send],
  );

  return (
    <div
      data-testid="mobile-chat"
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        color: "var(--fg)",
        // Lock the view so iOS rubber-banding doesn't lift the header.
        overflow: "hidden",
        // Make sure padding-bottom respects the iPhone home-indicator.
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "12px 16px calc(8px + env(safe-area-inset-top))",
          paddingTop: "calc(12px + env(safe-area-inset-top))",
          borderBottom: "1px solid var(--border)",
          background: "rgba(8,12,22,0.85)",
          backdropFilter: "blur(8px)",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            flex: 1,
            minWidth: 0,
          }}
        >
          <div
            className="mono"
            style={{
              fontSize: 11,
              letterSpacing: 3,
              color: "var(--orb)",
              textShadow: "0 0 6px var(--orb-glow)",
            }}
          >
            ALFRED
          </div>
          <div
            style={{
              fontSize: 10,
              color: "var(--muted)",
              letterSpacing: 0.5,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {loc.lastFix
              ? `📍 ${loc.lastFix.lat.toFixed(2)}, ${loc.lastFix.lon.toFixed(2)}${
                  loc.lastFix.accuracy_m != null
                    ? ` · ±${Math.round(loc.lastFix.accuracy_m)}m`
                    : ""
                }`
              : loc.permission === "denied"
                ? "📍 Location off"
                : locationEnabled
                  ? "📍 Locating…"
                  : "📍 Sharing paused"}
          </div>
        </div>
        <button
          type="button"
          data-testid="mobile-toggle-location"
          onClick={() => setLocationEnabled((v) => !v)}
          className="hud-button"
          style={{ fontSize: 9, letterSpacing: 1.5 }}
          title="Toggle GPS sharing"
        >
          {locationEnabled ? "GPS" : "OFF"}
        </button>
        <button
          type="button"
          data-testid="mobile-toggle-voice"
          onClick={() => setVoiceOut((v) => !v)}
          className="hud-button"
          style={{ fontSize: 9, letterSpacing: 1.5 }}
          title="Toggle voice replies"
        >
          {voiceOut ? "🔊" : "🔇"}
        </button>
      </div>

      {/* Message rail */}
      <div
        ref={scrollRef}
        data-testid="mobile-chat-messages"
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          // ``-webkit-overflow-scrolling`` makes iOS scrolling smooth.
          WebkitOverflowScrolling: "touch",
        }}
      >
        {messages.length === 0 ? (
          <div
            style={{
              margin: "auto",
              textAlign: "center",
              maxWidth: 280,
              color: "var(--muted)",
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            <div
              style={{
                fontSize: 36,
                marginBottom: 8,
                color: "var(--orb)",
                filter: "drop-shadow(0 0 8px var(--orb-glow))",
              }}
            >
              ◯
            </div>
            At your service, sir. Type a message, hold the mic, or
            send a photo.
          </div>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} msg={m} />)
        )}
        {sending ? (
          <div
            data-testid="mobile-chat-thinking"
            style={{
              alignSelf: "flex-start",
              fontSize: 11,
              color: "var(--muted)",
              letterSpacing: 1.5,
            }}
          >
            ALFRED IS THINKING…
          </div>
        ) : null}
      </div>

      {error ? (
        <div
          data-testid="mobile-chat-error"
          style={{
            margin: "0 12px 8px",
            color: "var(--danger)",
            background: "rgba(255,80,80,0.06)",
            border: "1px solid rgba(255,80,80,0.3)",
            padding: 8,
            borderRadius: 4,
            fontSize: 12,
          }}
        >
          {error}
        </div>
      ) : null}

      {/* Composer */}
      <div
        style={{
          display: "flex",
          gap: 6,
          padding: "8px 12px 12px",
          borderTop: "1px solid var(--border)",
          background: "rgba(8,12,22,0.92)",
          alignItems: "flex-end",
        }}
      >
        <button
          type="button"
          data-testid="mobile-chat-photo"
          className="hud-button"
          onClick={() => fileRef.current?.click()}
          style={{
            flexShrink: 0,
            width: 40,
            height: 40,
            padding: 0,
            fontSize: 18,
          }}
          title="Send a photo"
        >
          📷
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            void onFilePicked(file);
            // Reset so the same file can be re-picked.
            e.target.value = "";
          }}
        />
        <textarea
          data-testid="mobile-chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message Alfred…"
          rows={1}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
          style={{
            flex: 1,
            padding: "10px 12px",
            background: "rgba(8,14,24,0.7)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            color: "var(--fg)",
            fontSize: 16, // prevents iOS auto-zoom on focus
            outline: "none",
            resize: "none",
            maxHeight: 120,
            minHeight: 40,
            fontFamily: "inherit",
          }}
        />
        {/* Mic — push-to-talk. Hold to record, release to send. */}
        <button
          type="button"
          data-testid="mobile-chat-mic"
          className={recording ? "hud-button hud-button--primary" : "hud-button"}
          onPointerDown={(e) => {
            e.preventDefault();
            void startRecording();
          }}
          onPointerUp={() => stopRecording()}
          onPointerCancel={() => stopRecording()}
          onPointerLeave={() => recording && stopRecording()}
          style={{
            flexShrink: 0,
            width: 40,
            height: 40,
            padding: 0,
            fontSize: 18,
            touchAction: "none",
          }}
          title={recording ? "Recording — release to send" : "Hold to talk"}
        >
          {recording ? "⏺" : "🎤"}
        </button>
      </div>
    </div>
  );
}

function MessageBubble({ msg }: { msg: Message }) {
  const mine = msg.role === "user";
  return (
    <div
      data-testid={`mobile-msg-${msg.role}`}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: mine ? "flex-end" : "flex-start",
        gap: 4,
      }}
    >
      <div
        style={{
          maxWidth: "82%",
          padding: "10px 14px",
          borderRadius: 14,
          background: mine
            ? "rgba(108,214,255,0.15)"
            : "rgba(255,255,255,0.04)",
          border: mine
            ? "1px solid rgba(108,214,255,0.4)"
            : "1px solid var(--border)",
          fontSize: 14,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {msg.imagePreview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={msg.imagePreview}
            alt=""
            style={{
              maxWidth: "100%",
              borderRadius: 8,
              marginBottom: msg.content && msg.content !== "(image)" ? 8 : 0,
            }}
          />
        ) : null}
        {msg.content !== "(image)" || !msg.imagePreview ? msg.content : ""}
      </div>
      <div
        style={{
          fontSize: 9,
          color: "var(--muted)",
          letterSpacing: 1,
          padding: "0 4px",
        }}
      >
        {new Date(msg.ts).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </div>
    </div>
  );
}
