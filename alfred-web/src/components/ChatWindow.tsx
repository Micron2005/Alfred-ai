"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ModeIndicator } from "@/components/ModeIndicator";
import { Message } from "@/components/Message";
import { Composer, type ComposerHandle } from "@/components/Composer";
import { ConversationSidebar } from "@/components/ConversationSidebar";
import { Clock } from "@/components/Clock";
import { WeatherWidget } from "@/components/WeatherWidget";
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
import { useCamera } from "@/lib/useCamera";
import { Orb } from "@/components/Orb";
import { SpotifyPlayer } from "@/components/SpotifyPlayer";
import { CameraPreview } from "@/components/CameraPreview";
import { HudWidget } from "@/components/HudWidget";
import { InstallPwaButton } from "@/components/InstallPwaButton";
import {
  useHudLayout,
  WIDGET_LABELS,
  type HudWidgetId,
} from "@/lib/hudLayout";
import { orbStore } from "@/lib/orbState";

const ACTIVE_CONVO_KEY = "alfred.activeConversationId";
const VOICE_OUT_KEY = "alfred.voiceOutEnabled";
const HANDS_FREE_KEY = "alfred.handsFreeEnabled";
const CAMERA_KEY = "alfred.cameraEnabled";
const FULL_HUD_KEY = "alfred.fullHudEnabled";
// v2: the sidebar's role changed (it now hosts the active chat, not
// just the archive list). Old "collapsed=1" values from v1 would
// hide the conversation from existing users post-upgrade, so we use
// a new key to start everyone fresh on the new default (expanded).
const SIDEBAR_COLLAPSED_KEY = "alfred.sidebarCollapsed.v2";

// Use ``||`` (not ``??``) so an empty-string value from Docker Compose
// — which is what `${NEXT_PUBLIC_WAKE_KEYWORD}` expands to when the
// user upgrades from a pre-PR `.env` that lacks the var — falls back to
// the default instead of being inlined as `""` into the bundle.
const WAKE_KEYWORD = process.env.NEXT_PUBLIC_WAKE_KEYWORD || "hey_alfred";

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
  const [cameraOn, setCameraOn] = useState(false);
  const [fullHud, setFullHud] = useState(false);
  // Default ``false`` (expanded) — the sidebar now hosts the active
  // conversation (CONVERSATION tab) so collapsing it by default
  // would hide the chat entirely. Users can collapse it manually
  // when they want the HUD full-screen.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [recording, setRecording] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Cleanup hook for the in-flight TTS pipeline (analyser timer +
  // AudioContext). ``stopCurrentAudio`` invokes it so a "voice off"
  // toggle mid-reply also tears down the analyser graph and clears the
  // orb's "speaking" hold — pause() alone doesn't fire onended, so
  // without this the orb would stay pulsing forever on a silent track.
  const audioCleanupRef = useRef<(() => void) | null>(null);
  const composerRef = useRef<ComposerHandle>(null);

  // Restore the user's voice-out + hands-free + camera preferences. All
  // default to off so a fresh install doesn't surprise the user with
  // audio or a permission prompt.
  useEffect(() => {
    if (typeof window === "undefined") return;
    setVoiceOut(localStorage.getItem(VOICE_OUT_KEY) === "1");
    setHandsFree(localStorage.getItem(HANDS_FREE_KEY) === "1");
    setCameraOn(localStorage.getItem(CAMERA_KEY) === "1");
    // Now that the chat lives in the sidebar, the main pane would
    // be nearly empty without the HUD widgets — default the full HUD
    // *on* for users who haven't explicitly turned it off. Existing
    // "0" values are still respected.
    const fullHudStored = localStorage.getItem(FULL_HUD_KEY);
    setFullHud(fullHudStored === null ? true : fullHudStored === "1");
    // Sidebar default = expanded (chat lives there). Persisted value
    // overrides the default if present.
    const stored = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    if (stored !== null) setSidebarCollapsed(stored === "1");
  }, []);

  const wake = useWakeWord({
    enabled: handsFree,
    keyword: WAKE_KEYWORD,
    onWake: () => composerRef.current?.startVoice(),
  });

  const camera = useCamera({ enabled: cameraOn });

  // Customizable-HUD state. ``customEnabled`` is the user-facing
  // "is the HUD freely arrangeable?" switch (off by default — most
  // users will use the default layout). ``editMode`` controls
  // whether widget drag/resize/hide handles are shown. See
  // ``lib/hudLayout.ts`` for the localStorage shape.
  const hud = useHudLayout();

  // Tears down the in-flight TTS pipeline (paused audio, analyser
  // graph, object URL, RAF timer) but deliberately does NOT clear
  // the ``speaking`` state — that's the caller's responsibility,
  // because there are two distinct call patterns:
  //
  //   1. ``speak()`` calls this right before kicking off a new TTS
  //      (replacing an in-flight one). ``speaking`` must stay true
  //      across the swap so the wake-word effect doesn't briefly
  //      resume the mic and self-trigger off Alfred's own voice.
  //   2. ``setVoiceOutPersisted(false)`` calls this to fully halt
  //      playback. ``speaking`` should drop to false; the caller
  //      handles that explicitly below.
  //
  // The natural end-of-playback path doesn't go through here at all
  // — ``audio.onended`` runs the resource cleanup and clears
  // ``speaking`` directly.
  function stopCurrentAudio() {
    const prev = audioRef.current;
    if (!prev) return;
    // Detach handlers so a delayed ``ended`` from pause() on some
    // browsers doesn't double-fire the cleanup we're about to run
    // manually.
    prev.onended = null;
    prev.onerror = null;
    prev.pause();
    // Resource cleanup only — does not touch ``speaking`` or the
    // orb store. See the contract comment above.
    const cleanup = audioCleanupRef.current;
    audioCleanupRef.current = null;
    audioRef.current = null;
    if (cleanup) cleanup();
  }

  function setVoiceOutPersisted(enabled: boolean) {
    setVoiceOut(enabled);
    if (typeof window !== "undefined") {
      localStorage.setItem(VOICE_OUT_KEY, enabled ? "1" : "0");
    }
    if (!enabled) {
      stopCurrentAudio();
      // ``stopCurrentAudio`` deliberately leaves ``speaking`` alone
      // (see its contract). Clear it here so the orb returns to idle
      // and the wake-word effect resumes listening.
      setSpeaking(false);
      orbStore.setHold("speaking", false);
    }
  }

  function setHandsFreePersisted(enabled: boolean) {
    setHandsFree(enabled);
    if (typeof window !== "undefined") {
      localStorage.setItem(HANDS_FREE_KEY, enabled ? "1" : "0");
    }
  }

  function setCameraPersisted(enabled: boolean) {
    setCameraOn(enabled);
    if (typeof window !== "undefined") {
      localStorage.setItem(CAMERA_KEY, enabled ? "1" : "0");
    }
  }

  function setFullHudPersisted(enabled: boolean) {
    setFullHud(enabled);
    if (typeof window !== "undefined") {
      localStorage.setItem(FULL_HUD_KEY, enabled ? "1" : "0");
    }
  }

  function toggleSidebar() {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      }
      return next;
    });
  }

  // Capture the current frame and slot it into the composer's pending
  // attachments so the user can ask a question about it.
  async function handleLook() {
    setError(null);
    try {
      const frame = await camera.captureFrame();
      if (!frame) {
        setError(
          "Couldn't capture a frame — give the camera a moment to warm up and try again.",
        );
        return;
      }
      composerRef.current?.attachImage({
        data: frame.data,
        mime_type: frame.mimeType,
        label: "Webcam snapshot",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't capture a frame.");
    }
  }

  // Pause wake-word detection while the user is actually dictating
  // (so we don't pick up his own voice as another wake), while the
  // assistant is composing a reply, AND while Alfred's TTS is still
  // playing through the speakers (so Alfred saying "sir" doesn't
  // reflexively re-trigger him via the laptop mic). All three signals
  // collapse into a single effect — having multiple effects
  // independently call pause/resume creates a child-vs-parent ordering
  // race where one overrides the other.
  const { pause: wakePause, resume: wakeResume } = wake;
  useEffect(() => {
    if (recording || busy || speaking) wakePause();
    else wakeResume();
  }, [recording, busy, speaking, wakePause, wakeResume]);

  // Mirror ``busy`` onto the orb store as the "thinking" hold so the
  // JARVIS orb spins faster while Alfred composes a reply. Listening
  // and speaking holds are managed by Composer + ``speak`` directly.
  useEffect(() => {
    orbStore.setHold("thinking", busy);
    return () => orbStore.setHold("thinking", false);
  }, [busy]);

  async function speak(text: string) {
    // Set ``speaking`` synchronously, BEFORE the synthesizeSpeech await,
    // so React batches it with the setBusy(false) that handleSend's
    // finally block runs in the same microtask. Otherwise the wake-word
    // pause/resume effect would briefly see all three signals false
    // during the TTS network round-trip and resume listening.
    setSpeaking(true);
    orbStore.setHold("speaking", true);
    let url: string | null = null;
    let audioCtx: AudioContext | null = null;
    let levelTimer: number | null = null;
    try {
      const blob = await synthesizeSpeech(text);
      url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      // Route TTS through a Web Audio analyser so the JARVIS orb can
      // heartbeat in sync with Alfred's voice. ``createMediaElementSource``
      // takes ownership of the audio output, so we still have to connect
      // back to ``destination`` for the user to actually hear it.
      // AudioContexts are heavyweight but we tear it down on the same
      // ``cleanup`` path as the audio element so we don't leak.
      const ctxCtor =
        typeof AudioContext !== "undefined" ? AudioContext : undefined;
      let analyser: AnalyserNode | null = null;
      // Backed by a plain ArrayBuffer (not ArrayBufferLike) so the
      // strict typing of getFloatTimeDomainData on newer lib.dom.d.ts
      // accepts it. ``new Float32Array(N)`` already gives ArrayBuffer
      // backing, but we have to spell it out for the type checker.
      let analyserBuf: Float32Array<ArrayBuffer> | null = null;
      if (ctxCtor) {
        audioCtx = new ctxCtor();
        const src = audioCtx.createMediaElementSource(audio);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.4;
        analyserBuf = new Float32Array(
          new ArrayBuffer(analyser.fftSize * 4),
        ) as Float32Array<ArrayBuffer>;
        src.connect(analyser);
        analyser.connect(audioCtx.destination);
      }
      stopCurrentAudio();
      audioRef.current = audio;
      const objectUrl = url;
      // ``speaking`` is what gates the wake-word resume; clear it the
      // moment playback ends or errors so the next idle window resumes.
      // Guard the setter so a stale ended/error from a previous play
      // doesn't clobber the flag for a newer one already in flight.
      // Resource cleanup only — does NOT clear ``speaking`` state.
      // The end-of-playback handlers (and ``setVoiceOutPersisted``)
      // clear ``speaking`` themselves; ``stopCurrentAudio`` calls
      // this when chaining a new TTS and must not clear it.
      const cleanup = () => {
        URL.revokeObjectURL(objectUrl);
        if (levelTimer !== null) {
          clearInterval(levelTimer);
          levelTimer = null;
        }
        if (audioCtx) {
          void audioCtx.close().catch(() => {
            /* already closed */
          });
          audioCtx = null;
        }
      };
      // End-of-playback: free resources, then drop the speaking
      // state. Guarded against a stale event from a replaced audio
      // by checking ``audioRef.current === audio`` — if a newer
      // TTS already took over, leave its state alone.
      const finishPlayback = () => {
        cleanup();
        if (audioRef.current === audio) {
          audioRef.current = null;
          setSpeaking(false);
          orbStore.setHold("speaking", false);
        }
      };
      audio.onended = finishPlayback;
      audio.onerror = finishPlayback;
      // Expose the cleanup hook so ``stopCurrentAudio`` (e.g. user
      // toggles voice off mid-reply) tears down the analyser graph
      // even though pause() doesn't fire ``ended``.
      audioCleanupRef.current = cleanup;
      // Start sampling amplitude at ~30 fps so the orb has fresh data.
      // Cheaper than RAF here because we don't need per-frame precision —
      // the orb's own RAF loop smooths the values further.
      if (analyser && analyserBuf) {
        const a = analyser;
        const b = analyserBuf;
        levelTimer = window.setInterval(() => {
          a.getFloatTimeDomainData(b);
          let sumSquares = 0;
          for (let i = 0; i < b.length; i++) sumSquares += b[i] * b[i];
          const rms = Math.sqrt(sumSquares / b.length);
          orbStore.pushLevel(rms);
        }, 33);
      }
      await audio.play();
      url = null; // ownership transferred to the audio element + cleanup callbacks
    } catch {
      // TTS is best-effort; if anything went wrong (network, autoplay
      // policy, decode error) free the URL we never managed to attach.
      if (url) URL.revokeObjectURL(url);
      if (levelTimer !== null) clearInterval(levelTimer);
      if (audioCtx) {
        void audioCtx.close().catch(() => {
          /* already closed */
        });
      }
      setSpeaking(false);
      orbStore.setHold("speaking", false);
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
    // Snapshot presence at send time. Only forward when the camera is
    // actually ready — "starting" / "error" states would mislead Alfred
    // into thinking he saw zero people when he saw nothing at all.
    const presence =
      cameraOn && camera.status === "ready"
        ? { faces_visible: camera.faceCount }
        : null;
    try {
      const reply = await sendMessage(text, convoId, images, presence);
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
  // Status caption beneath the orb — reflects what Alfred is currently
  // doing so the user always knows the system state at a glance.
  const orbCaption = busy
    ? "Composing…"
    : speaking
      ? "Transmitting"
      : recording
        ? "Listening"
        : handsFree && wake.status === "listening"
          ? `Standing by · ${WAKE_LABEL}`
          : "Standing by";

  // The active conversation lives in the sidebar's CONVERSATION tab
  // — extract it as a JSX block so we can pass it to the sidebar
  // without ChatWindow's render becoming unreadable. This used to
  // sit in the main pane, which meant a long chat would push the
  // HUD off-screen and the user couldn't reach the camera/voice
  // toggles without scrolling all the way back up.
  const chatPane = (
    <>
      <main
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "12px 14px 16px",
        }}
      >
        {loadingConvo ? (
          <p
            className="mono"
            style={{
              color: "var(--muted)",
              textAlign: "center",
              marginTop: 40,
              fontSize: 11,
            }}
          >
            · RETRIEVING CONVERSATION ·
          </p>
        ) : messages.length === 0 ? (
          <p
            style={{
              color: "var(--muted)",
              textAlign: "center",
              marginTop: 40,
              fontStyle: "italic",
              fontSize: 13,
              padding: "0 8px",
            }}
          >
            Say &ldquo;Hello Alfred&rdquo; to begin.
          </p>
        ) : (
          messages.map((m) => <Message key={m.id} msg={m} />)
        )}
        {busy ? (
          <p
            className="mono"
            style={{
              color: "var(--hud)",
              fontSize: 11,
              opacity: 0.85,
              margin: "12px 0",
              textAlign: "center",
            }}
          >
            · ALFRED IS COMPOSING A REPLY ·
          </p>
        ) : null}
        {error ? (
          <p
            style={{
              color: "var(--danger)",
              fontSize: 13,
              background: "rgba(255, 80, 80, 0.06)",
              border: "1px solid rgba(255, 80, 80, 0.3)",
              padding: 10,
              borderRadius: 3,
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
            color: "var(--danger)",
            fontSize: 12,
            background: "rgba(255, 80, 80, 0.06)",
            border: "1px solid rgba(255, 80, 80, 0.3)",
            padding: 8,
            borderRadius: 3,
            margin: "0 12px 8px",
          }}
        >
          {wake.error}
        </p>
      ) : null}

      {cameraOn && camera.error ? (
        <p
          style={{
            color: "var(--danger)",
            fontSize: 12,
            background: "rgba(255, 80, 80, 0.06)",
            border: "1px solid rgba(255, 80, 80, 0.3)",
            padding: 8,
            borderRadius: 3,
            margin: "0 12px 8px",
          }}
        >
          {camera.error}
        </p>
      ) : null}

      <div style={{ padding: "0 12px 12px" }}>
        <Composer
          ref={composerRef}
          onSend={handleSend}
          disabled={busy || loadingConvo}
          onMicStateChange={setRecording}
        />
      </div>
    </>
  );

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
        collapsed={sidebarCollapsed}
        onToggleCollapsed={toggleSidebar}
        chatPane={chatPane}
      />

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          // Main pane is now pure HUD (no chat) — let it use the
          // available width up to a generous ceiling so the JARVIS
          // widgets aren't squished into a narrow column.
          maxWidth: 1200,
          margin: "0 auto",
          padding: "0 24px 16px",
          width: "100%",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 0 12px",
            borderBottom: "1px solid var(--border)",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <h1
              className="mono"
              style={{
                margin: 0,
                fontSize: 22,
                letterSpacing: 6,
                color: "var(--hud)",
                textShadow: "0 0 12px var(--orb-glow)",
                fontWeight: 500,
              }}
            >
              ALFRED
            </h1>
            <p
              style={{
                margin: 0,
                color: "var(--muted)",
                fontSize: 13,
                fontStyle: "italic",
              }}
            >
              {greeting}
            </p>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              className="hud-button"
              onClick={() => setHandsFreePersisted(!handsFree)}
              aria-pressed={handsFree}
              title={
                handsFree
                  ? `Hands-free is on — say "${WAKE_LABEL}" to start a message`
                  : `Turn on hands-free (wake word: "${WAKE_LABEL}")`
              }
            >
              {handsFree
                ? wake.status === "listening"
                  ? `🎙 ${WAKE_LABEL} · LIVE`
                  : wake.status === "paused"
                    ? `🎙 ${WAKE_LABEL} · PAUSED`
                    : wake.status === "starting"
                      ? "🎙 STARTING…"
                      : wake.status === "error"
                        ? "🎙 WAKE ERR"
                        : "🎙 HANDS-FREE"
                : "🎙 HANDS-FREE"}
            </button>
            <button
              type="button"
              className="hud-button"
              onClick={() => setVoiceOutPersisted(!voiceOut)}
              aria-pressed={voiceOut}
              title={voiceOut ? "Mute Alfred's voice" : "Unmute Alfred's voice"}
            >
              {voiceOut ? "🔊 VOICE" : "🔇 VOICE"}
            </button>
            <button
              type="button"
              className="hud-button"
              onClick={() => setCameraPersisted(!cameraOn)}
              aria-pressed={cameraOn}
              title={
                cameraOn
                  ? `Camera is on — Alfred can see ${
                      camera.faceCount === 1
                        ? "1 face"
                        : `${camera.faceCount} faces`
                    }`
                  : "Turn on the camera so Alfred can see who's in the room"
              }
            >
              {cameraOn
                ? camera.status === "ready"
                  ? `📷 CAM · ${camera.faceCount}`
                  : camera.status === "starting"
                    ? "📷 STARTING…"
                    : camera.status === "error"
                      ? "📷 CAM ERR"
                      : "📷 CAM"
                : "📷 CAM"}
            </button>
            {cameraOn && camera.status === "ready" ? (
              <button
                type="button"
                className="hud-button"
                onClick={() => void handleLook()}
                disabled={busy}
                title="Capture the current frame and attach it to your next message so Alfred can see what you're looking at."
              >
                👁 LOOK
              </button>
            ) : null}
            <button
              type="button"
              className="hud-button"
              onClick={() => setFullHudPersisted(!fullHud)}
              aria-pressed={fullHud}
              title={
                fullHud
                  ? "Switch to compact view"
                  : "Switch to the full JARVIS HUD with clock + weather"
              }
            >
              {fullHud ? "🛰 HUD · FULL" : "🛰 HUD · COMPACT"}
            </button>
            <button
              type="button"
              className="hud-button"
              onClick={() => hud.setCustomEnabled(!hud.customEnabled)}
              aria-pressed={hud.customEnabled}
              title={
                hud.customEnabled
                  ? "Lock the HUD layout and return to the default flow"
                  : "Free the HUD widgets so you can drag, resize, or hide them"
              }
            >
              {hud.customEnabled ? "🎛 CUSTOM · ON" : "🎛 CUSTOMIZE"}
            </button>
            <InstallPwaButton />
            <ModeIndicator mode={mode} />
          </div>
        </header>

        {/*
          ============================================================
          HUD WIDGET CANVAS
          ============================================================
          Two layout modes share the same widget set:
            - Default flow: stacked top-to-bottom (header → telemetry
              row → orb → forecast strip → camera preview → Spotify).
              Used by every user out of the box.
            - Custom (absolute): each widget is a draggable, resizable,
              hide-able card the user has placed wherever they like.
              Activated via the "🎛 CUSTOMIZE" header button.
          The widget contents (Clock, WeatherWidget, Orb, etc.) are
          identical in both modes — only the surrounding container and
          positioning differ. Each widget is wrapped in
          ``<HudWidget>`` so individual remounts (e.g. layout
          changes) don't tear down the inner state (audio analyser
          handles in Spotify, MediaPipe detectors in CameraPreview,
          etc.).
        */}
        {hud.customEnabled ? (
          <HudCustomizeToolbar
            layout={hud.layout}
            showWidget={hud.showWidget}
            resetLayout={hud.resetLayout}
            disableCustom={() => hud.setCustomEnabled(false)}
          />
        ) : null}

        {hud.customEnabled ? (
          <ResponsiveHudCanvas>
            {(scale) => (
              <>
                <HudWidget
                  id="clock"
                  label={WIDGET_LABELS.clock}
                  layout={hud.layout.clock}
                  customEnabled
                  scale={scale}
                  onMove={(p) => hud.updateWidget("clock", p)}
                  onHide={() => hud.hideWidget("clock")}
                  hidden={!hud.layout.clock.visible}
                >
                  <Clock />
                </HudWidget>
                <HudWidget
                  id="weather-current"
                  label={WIDGET_LABELS["weather-current"]}
                  layout={hud.layout["weather-current"]}
                  customEnabled
                  scale={scale}
                  onMove={(p) => hud.updateWidget("weather-current", p)}
                  onHide={() => hud.hideWidget("weather-current")}
                  hidden={!hud.layout["weather-current"].visible}
                >
                  <WeatherWidget variant="current" />
                </HudWidget>
                <HudWidget
                  id="weather-strip"
                  label={WIDGET_LABELS["weather-strip"]}
                  layout={hud.layout["weather-strip"]}
                  customEnabled
                  scale={scale}
                  onMove={(p) => hud.updateWidget("weather-strip", p)}
                  onHide={() => hud.hideWidget("weather-strip")}
                  hidden={!hud.layout["weather-strip"].visible}
                >
                  <WeatherWidget variant="strip" />
                </HudWidget>
                <HudWidget
                  id="orb"
                  label={WIDGET_LABELS.orb}
                  layout={hud.layout.orb}
                  customEnabled
                  scale={scale}
                  onMove={(p) => hud.updateWidget("orb", p)}
                  onHide={() => hud.hideWidget("orb")}
                  hidden={!hud.layout.orb.visible}
                >
                  <div
                    style={{
                      width: "100%",
                      height: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Orb
                      size={Math.max(
                        80,
                        Math.min(
                          typeof hud.layout.orb.w === "number"
                            ? hud.layout.orb.w
                            : 360,
                          typeof hud.layout.orb.h === "number"
                            ? hud.layout.orb.h
                            : 200,
                        ) - 20,
                      )}
                      caption={orbCaption}
                    />
                  </div>
                </HudWidget>
                <HudWidget
                  id="spotify"
                  label={WIDGET_LABELS.spotify}
                  layout={hud.layout.spotify}
                  customEnabled
                  scale={scale}
                  onMove={(p) => hud.updateWidget("spotify", p)}
                  onHide={() => hud.hideWidget("spotify")}
                  hidden={!hud.layout.spotify.visible}
                >
                  <SpotifyPlayer nightfall={mode === "nightfall"} />
                </HudWidget>
                <HudWidget
                  id="camera"
                  label={WIDGET_LABELS.camera}
                  layout={hud.layout.camera}
                  customEnabled
                  scale={scale}
                  onMove={(p) => hud.updateWidget("camera", p)}
                  onHide={() => hud.hideWidget("camera")}
                  hidden={!hud.layout.camera.visible || !cameraOn}
                >
                  <CameraPreview
                    status={camera.status}
                    faceCount={camera.faceCount}
                    streamRef={camera.streamRef}
                  />
                </HudWidget>
              </>
            )}
          </ResponsiveHudCanvas>
        ) : (
          // Default flow layout — the original out-of-the-box JARVIS
          // arrangement. Untouched except that the camera preview is
          // now part of the flow whenever the camera is on.
          <>
            {fullHud ? (
              <div className="hud-telemetry">
                <Clock />
                <WeatherWidget variant="current" />
              </div>
            ) : null}

            <div
              style={{
                display: "flex",
                justifyContent: "center",
                padding: "18px 0 8px",
              }}
            >
              <Orb size={180} caption={orbCaption} />
            </div>

            {fullHud ? <WeatherWidget variant="strip" /> : null}

            {/*
              Live camera preview — visible whenever the camera is on,
              so the user can see what Alfred sees without opening a
              separate window. Uses a sibling ``<video>`` that shares
              the existing MediaStream (see CameraPreview.tsx) — the
              hidden detection ``<video>`` below is unaffected.
            */}
            {cameraOn ? (
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  padding: "0 12px 12px",
                }}
              >
                <div
                  style={{
                    width: "min(480px, 100%)",
                    aspectRatio: "16 / 9",
                  }}
                >
                  <CameraPreview
                    status={camera.status}
                    faceCount={camera.faceCount}
                    streamRef={camera.streamRef}
                  />
                </div>
              </div>
            ) : null}

            <div
              style={{
                display: "flex",
                justifyContent: "center",
                padding: "0 12px 8px",
              }}
            >
              <SpotifyPlayer nightfall={mode === "nightfall"} />
            </div>
          </>
        )}

        {/*
          Hidden <video> for the camera feed. Kept in the main pane
          (always rendered) rather than inside ``chatPane`` so that
          collapsing the sidebar or switching to the ARCHIVES tab
          doesn't unmount the element — that would null out
          ``camera.videoRef.current`` and silently break face
          detection without re-running ``useCamera``'s setup effect.
          ``display:none`` + ``aria-hidden`` keep it out of the
          layout and out of the accessibility tree.
        */}
        <video
          // useRef<T>(null) yields RefObject<T | null>, which the
          // installed @types/react (v18 against a v19-rc react)
          // refuses to accept as a video element ref. The runtime
          // contract is identical — a current that may be null until
          // mount — so cast it through the type the JSX prop expects.
          ref={camera.videoRef as React.RefObject<HTMLVideoElement>}
          playsInline
          muted
          aria-hidden
          style={{ display: "none" }}
        />
      </div>
    </div>
  );
}

/**
 * Toolbar that appears above the HUD canvas when the user enters
 * customize mode. Lists hidden widgets as clickable "show" chips,
 * provides a reset-to-defaults button, and a "lock layout & exit
 * custom mode" escape hatch.
 */
function HudCustomizeToolbar({
  layout,
  showWidget,
  resetLayout,
  disableCustom,
}: {
  layout: ReturnType<typeof useHudLayout>["layout"];
  showWidget: (id: HudWidgetId) => void;
  resetLayout: () => void;
  disableCustom: () => void;
}) {
  const hidden = (Object.keys(layout) as HudWidgetId[]).filter(
    (id) => !layout[id].visible,
  );
  return (
    <div
      style={{
        margin: "12px 0 0",
        padding: "8px 12px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        background: "rgba(108, 214, 255, 0.04)",
        border: "1px solid var(--border)",
        borderRadius: 4,
      }}
    >
      <span
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: 1.5,
          color: "var(--hud)",
          textShadow: "0 0 6px var(--orb-glow)",
        }}
      >
        🎛 CUSTOMIZING HUD
      </span>
      <span style={{ color: "var(--muted)", fontSize: 11 }}>
        Drag widgets to move. Drag the corner to resize. × to hide.
      </span>
      <span style={{ flex: 1 }} />
      {hidden.length > 0 ? (
        <>
          <span
            className="mono"
            style={{
              fontSize: 9,
              letterSpacing: 1.5,
              color: "var(--muted)",
            }}
          >
            SHOW:
          </span>
          {hidden.map((id) => (
            <button
              key={id}
              type="button"
              className="hud-button"
              onClick={() => showWidget(id)}
              title={`Show ${WIDGET_LABELS[id]}`}
              style={{ padding: "3px 8px", fontSize: 10 }}
            >
              + {WIDGET_LABELS[id].toUpperCase()}
            </button>
          ))}
        </>
      ) : null}
      <button
        type="button"
        className="hud-button"
        onClick={() => {
          if (
            window.confirm(
              "Reset HUD layout to default positions and visibility?",
            )
          ) {
            resetLayout();
          }
        }}
        title="Reset all widgets to default positions, sizes, and visibility"
        style={{ padding: "3px 10px", fontSize: 10 }}
      >
        ↺ RESET
      </button>
      <button
        type="button"
        className="hud-button"
        onClick={() => {
          if (
            window.confirm(
              "Turn off custom layout? Widgets will return to the default flow layout. (Your custom positions are saved and will be restored if you turn it back on.)",
            )
          ) {
            disableCustom();
          }
        }}
        title="Disable custom layout and return to the default flow layout"
        style={{ padding: "3px 10px", fontSize: 10 }}
      >
        ⏏ EXIT
      </button>
    </div>
  );
}

/**
 * Responsive wrapper for the absolute-positioned HUD canvas.
 *
 * The canvas has a logical baseline width (1100 px) — every widget's
 * saved ``{x, y, w, h}`` is in that coordinate system. When the
 * sidebar is open the actual pane width drops below 1100, so we
 * apply a CSS ``transform: scale()`` to the canvas to make
 * everything shrink proportionally rather than overflow / clip on
 * the right edge (the user's complaint after v1).
 *
 * The wrapper measures its own width with a ResizeObserver and
 * computes the scale factor on every resize. The scale is passed to
 * each ``HudWidget`` via the render-prop so its drag/resize handlers
 * can divide pointer-event deltas by the scale (otherwise widgets
 * would lag behind the user's finger).
 *
 * Outer-wrapper height is locked to ``BASELINE_HEIGHT * scale`` so
 * the rest of the page (composer slot, sidebar) doesn't end up with
 * a giant unscaled void below the canvas.
 */
const HUD_CANVAS_BASELINE_WIDTH = 1100;
const HUD_CANVAS_BASELINE_HEIGHT = 720;

function ResponsiveHudCanvas({
  children,
}: {
  children: (scale: number) => React.ReactNode;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      // Cap at 1.0 — we never *upscale* beyond the design size,
      // because the widget contents (text, icons) lose crispness
      // when CSS-scaled larger than 1×. Floor at 0.45 so widgets
      // are still readable on extremely narrow viewports.
      setScale(Math.max(0.45, Math.min(1, w / HUD_CANVAS_BASELINE_WIDTH)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={wrapperRef}
      style={{
        position: "relative",
        flex: 1,
        marginTop: 16,
        // The outer box reserves the *scaled* height so layout below
        // (anything after the HUD canvas) sits at the right Y.
        height: HUD_CANVAS_BASELINE_HEIGHT * scale,
        // A scaled child can over-paint its parent on the right
        // edge; ``overflow: hidden`` keeps the hud-canvas sub-pixel
        // precise within the visible pane.
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: HUD_CANVAS_BASELINE_WIDTH,
          height: HUD_CANVAS_BASELINE_HEIGHT,
          position: "absolute",
          top: 0,
          left: 0,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        {children(scale)}
      </div>
    </div>
  );
}
