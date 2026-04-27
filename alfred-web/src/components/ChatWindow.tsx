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
import { orbStore } from "@/lib/orbState";

const ACTIVE_CONVO_KEY = "alfred.activeConversationId";
const VOICE_OUT_KEY = "alfred.voiceOutEnabled";
const HANDS_FREE_KEY = "alfred.handsFreeEnabled";
const CAMERA_KEY = "alfred.cameraEnabled";
const FULL_HUD_KEY = "alfred.fullHudEnabled";

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
    setFullHud(localStorage.getItem(FULL_HUD_KEY) === "1");
  }, []);

  const wake = useWakeWord({
    enabled: handsFree,
    keyword: WAKE_KEYWORD,
    onWake: () => composerRef.current?.startVoice(),
  });

  const camera = useCamera({ enabled: cameraOn });

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
          maxWidth: 920,
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
            <ModeIndicator mode={mode} />
          </div>
        </header>

        {/*
          Full-HUD telemetry pane. Holds the monospace clock (top-left)
          and the current-weather card (top-right). Only mounted when
          the user has flipped the HUD toggle on, so the polling and
          interval timers in those widgets don't run otherwise.
        */}
        {fullHud ? (
          <div className="hud-telemetry">
            <Clock />
            <WeatherWidget variant="current" />
          </div>
        ) : null}

        {/*
          Centerpiece: the JARVIS orb. Reacts to mode (idle / listening
          / thinking / speaking) and amplitude (mic RMS or TTS amplitude).
        */}
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            padding: "18px 0 8px",
          }}
        >
          <Orb size={180} caption={orbCaption} />
        </div>

        {/*
          7-day forecast strip — only in full-HUD mode. Sits between the
          orb and the Spotify widget so the JARVIS-style telemetry runs
          continuously down the page.
        */}
        {fullHud ? <WeatherWidget variant="strip" /> : null}

        {/*
          Spotify HUD widget: spectrum visualizer + now-playing card +
          connect/disconnect controls. Renders nothing when Spotify
          isn't configured server-side.
        */}
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            padding: "0 12px 8px",
          }}
        >
          <SpotifyPlayer nightfall={mode === "nightfall"} />
        </div>

        <main
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "12px 4px 20px",
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
              margin: "0 0 8px 0",
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
              margin: "0 0 8px 0",
            }}
          >
            {camera.error}
          </p>
        ) : null}

        <Composer
          ref={composerRef}
          onSend={handleSend}
          disabled={busy || loadingConvo}
          onMicStateChange={setRecording}
        />

        {/*
          Hidden <video> for the camera feed. We don't render the live
          preview to the user — the chat header's face count is enough
          ambient feedback. Keep ``playsInline`` + ``muted`` so iOS
          Safari and Chrome let it autoplay without user gesture once the
          stream is attached. ``aria-hidden`` so screen readers ignore it.
        */}
        <video
          // useRef<T>(null) yields RefObject<T | null>, which the
          // installed @types/react (v18 against a v19-rc react) refuses
          // to accept as a video element ref. The runtime contract is
          // identical — a current that may be null until mount — so
          // cast it through the type the JSX prop expects.
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
