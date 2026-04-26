"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ModeIndicator } from "@/components/ModeIndicator";
import { Message } from "@/components/Message";
import { Composer, type ComposerHandle } from "@/components/Composer";
import { ConversationSidebar } from "@/components/ConversationSidebar";
import {
  type ChatImage,
  type ChatMessageOut,
  type ConversationSummary,
  type Mode,
  deleteConversation,
  getConversation,
  listConversations,
  sendMessage,
  synthesizeSpeech,
} from "@/lib/api";
import { useWakeWord } from "@/lib/useWakeWord";

const ACTIVE_CONVO_KEY = "alfred.activeConversationId";
const VOICE_OUT_KEY = "alfred.voiceOutEnabled";
const HANDS_FREE_KEY = "alfred.handsFreeEnabled";

const WAKE_KEYWORD = process.env.NEXT_PUBLIC_WAKE_KEYWORD ?? "hey_jarvis";

// Pretty label for status text — "hey_jarvis" → "Hey Jarvis".
const WAKE_LABEL = WAKE_KEYWORD.replace(/_/g, " ").replace(
  /\b\w/g,
  (c) => c.toUpperCase(),
);

export function ChatWindow() {
  const [messages, setMessages] = useState<ChatMessageOut[]>([]);
  const [mode, setMode] = useState<Mode>("standard");
  const [convoId, setConvoId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingConvo, setLoadingConvo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiceOut, setVoiceOut] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const [recording, setRecording] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const composerRef = useRef<ComposerHandle>(null);

  // Restore the user's voice-out + hands-free preferences. Both default to
  // off so a fresh install doesn't surprise the user with audio or a mic
  // permission prompt.
  useEffect(() => {
    if (typeof window === "undefined") return;
    setVoiceOut(localStorage.getItem(VOICE_OUT_KEY) === "1");
    setHandsFree(localStorage.getItem(HANDS_FREE_KEY) === "1");
  }, []);

  const wake = useWakeWord({
    enabled: handsFree,
    keyword: WAKE_KEYWORD,
    onWake: () => composerRef.current?.startVoice(),
  });

  function stopCurrentAudio() {
    const prev = audioRef.current;
    if (!prev) return;
    prev.pause();
    if (prev.src) URL.revokeObjectURL(prev.src);
    audioRef.current = null;
  }

  function setVoiceOutPersisted(enabled: boolean) {
    setVoiceOut(enabled);
    if (typeof window !== "undefined") {
      localStorage.setItem(VOICE_OUT_KEY, enabled ? "1" : "0");
    }
    if (!enabled) stopCurrentAudio();
  }

  function setHandsFreePersisted(enabled: boolean) {
    setHandsFree(enabled);
    if (typeof window !== "undefined") {
      localStorage.setItem(HANDS_FREE_KEY, enabled ? "1" : "0");
    }
  }

  // Pause wake-word detection while the user is actually dictating
  // (so we don't pick up his own voice as another wake) AND while the
  // assistant is composing a reply (so Alfred saying "sir" doesn't
  // reflexively re-trigger him). Both signals collapse into a single
  // effect — having two effects independently call pause/resume creates
  // a child-vs-parent ordering race where one overrides the other.
  const { pause: wakePause, resume: wakeResume } = wake;
  useEffect(() => {
    if (recording || busy) wakePause();
    else wakeResume();
  }, [recording, busy, wakePause, wakeResume]);

  async function speak(text: string) {
    let url: string | null = null;
    try {
      const blob = await synthesizeSpeech(text);
      url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      stopCurrentAudio();
      audioRef.current = audio;
      const objectUrl = url;
      const cleanup = () => {
        URL.revokeObjectURL(objectUrl);
        if (audioRef.current === audio) audioRef.current = null;
      };
      audio.onended = cleanup;
      audio.onerror = cleanup;
      await audio.play();
      url = null; // ownership transferred to the audio element + cleanup callbacks
    } catch {
      // TTS is best-effort; if anything went wrong (network, autoplay
      // policy, decode error) free the URL we never managed to attach.
      if (url) URL.revokeObjectURL(url);
    }
  }

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

  async function handleSend(text: string, images: ChatImage[] = []) {
    setError(null);
    const userMsg: ChatMessageOut = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      images: images.length > 0 ? images : undefined,
    };
    setMessages((prev) => [...prev, userMsg]);
    setBusy(true);
    try {
      const reply = await sendMessage(text, convoId, images);
      setConvoId(reply.conversation_id);
      localStorage.setItem(ACTIVE_CONVO_KEY, reply.conversation_id);
      setMode(reply.mode);
      setMessages((prev) => [...prev, reply.assistant]);
      await refreshList();
      if (voiceOut && reply.assistant.content.trim()) {
        void speak(reply.assistant.content);
      }
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
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              type="button"
              onClick={() => setHandsFreePersisted(!handsFree)}
              aria-pressed={handsFree}
              title={
                handsFree
                  ? `Hands-free is on — say "${WAKE_LABEL}" to start a message`
                  : `Turn on hands-free (wake word: "${WAKE_LABEL}")`
              }
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: handsFree ? "var(--accent)" : "transparent",
                color: handsFree ? "#fff" : "var(--muted)",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              {handsFree
                ? wake.status === "listening"
                  ? `🎙️ "${WAKE_LABEL}" — listening`
                  : wake.status === "paused"
                    ? `🎙️ "${WAKE_LABEL}" — paused`
                    : wake.status === "starting"
                      ? "🎙️ Starting…"
                      : wake.status === "error"
                        ? "🎙️ Wake-word error"
                        : `🎙️ Hands-free on`
                : "🎙️ Hands-free off"}
            </button>
            <button
              type="button"
              onClick={() => setVoiceOutPersisted(!voiceOut)}
              aria-pressed={voiceOut}
              title={voiceOut ? "Mute Alfred's voice" : "Unmute Alfred's voice"}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: voiceOut ? "var(--accent)" : "transparent",
                color: voiceOut ? "#fff" : "var(--muted)",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              {voiceOut ? "🔊 Voice on" : "🔇 Voice off"}
            </button>
            <ModeIndicator mode={mode} />
          </div>
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

        {handsFree && wake.error ? (
          <p
            style={{
              color: "#b33",
              fontSize: 12,
              background: "rgba(179, 51, 51, 0.08)",
              padding: 8,
              borderRadius: 6,
              margin: "0 0 8px 0",
            }}
          >
            {wake.error}
          </p>
        ) : null}

        <Composer
          ref={composerRef}
          onSend={handleSend}
          disabled={busy || loadingConvo}
          onMicStateChange={setRecording}
        />
      </div>
    </div>
  );
}
