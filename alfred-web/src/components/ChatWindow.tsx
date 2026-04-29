"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ModeIndicator } from "@/components/ModeIndicator";
import { Message } from "@/components/Message";
import { Composer, type ComposerHandle } from "@/components/Composer";
import { ChatTabView } from "@/components/ChatTabView";
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
import { useHandTracking } from "@/lib/useHandTracking";
import { useFaceTracking } from "@/lib/useFaceTracking";
import { usePoseTracking } from "@/lib/usePoseTracking";
import { useTwoHandSwipe } from "@/lib/useTwoHandSwipe";
import { loadTab, neighbourTab, persistTab, type TabId } from "@/lib/tabs";
import { TabBar } from "@/components/TabBar";
import { HudFrame } from "@/components/HudFrame";
import { DesignView } from "@/components/DesignView";
import { HandCursor } from "@/components/HandCursor";
import { ExpressionReadout } from "@/components/ExpressionReadout";
import { PoseSkeleton } from "@/components/PoseSkeleton";
import { QuickToolsMenu } from "@/components/QuickToolsMenu";
import { Orb3D } from "@/components/Orb3D";
import { SystemStatus, type Indicator } from "@/components/SystemStatus";
import { OperationsLog, useOperationsLog } from "@/components/OperationsLog";
import { FloatingEarth } from "@/components/FloatingEarth";
import { SpotifyPlayer } from "@/components/SpotifyPlayer";
import { CameraPreview } from "@/components/CameraPreview";
import { HudWidget } from "@/components/HudWidget";
import { WorkoutCoachWidget } from "@/components/WorkoutCoachWidget";
import { FaceRecognitionWidget } from "@/components/FaceRecognitionWidget";
import { WorkoutTabView } from "@/components/WorkoutTabView";
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

/**
 * Voice / text intent — "Alfred, take me to the workout tab".
 *
 * Strict matcher: the WHOLE message must be a navigation command,
 * not just contain navigation-ish words anywhere in a sentence.
 * Earlier loose version was hijacking normal chat messages like
 * "talk to me about X" (verb absent + tab noun "talk") or "show me
 * the home repair guide" (verb "show" + tab noun "home"), making
 * Alfred silently switch tabs instead of replying.
 *
 * The whole utterance, after stripping a leading "alfred,?", must
 * match: ``[verb] (to|over to|into)? (the)? <tab-noun> (tab|screen|view|page)?``
 * with at most a few filler words. Anything longer than ~10 words
 * is treated as conversation.
 */
type TabIntent = { tab: TabId; label: string };
const TAB_NOUNS: ReadonlyArray<{ noun: RegExp; tab: TabId; label: string }> = [
  { noun: /workout|form\s*coach|exercise|fitness|gym/, tab: "workout", label: "the Workout tab" },
  { noun: /design|cad(?:\s*studio)?|3d\s*print(?:er|ing)?|model(?:l?ing|ler)?/, tab: "design", label: "the Design tab" },
  { noun: /chat|messages?|conversation|inbox/, tab: "chat", label: "the Chat tab" },
  { noun: /hud|home|standby|main|dashboard|overview/, tab: "hud", label: "the HUD" },
];
const NAV_VERB =
  /^(?:go(?:\s+back)?|take\s+me|switch|open|show\s+me|navigate|jump|bring\s+me|pull\s+up|head\s+(?:to|over)|move\s+to)/;
function detectTabIntent(raw: string): TabIntent | null {
  const trimmed = raw.trim().toLowerCase().replace(/[.?!]+$/, "");
  if (!trimmed) return null;
  // Strip an optional leading "alfred," / "alfred " — wake-word
  // style lead-ins are common when the user is dictating.
  const stripped = trimmed.replace(/^(?:hey\s+|ok\s+)?alfred[,\s]+/, "").trim();
  // Reject anything that's clearly a conversation, not a command.
  // Tab-switch commands are short — rarely more than 7 words.
  const wordCount = stripped.split(/\s+/).length;
  if (wordCount > 8) return null;
  if (!NAV_VERB.test(stripped)) return null;
  for (const { noun, tab, label } of TAB_NOUNS) {
    // Build a strict tail pattern for this tab: verb-prefix +
    // optional connector + optional "the" + the noun + optional
    // suffix word. Must consume the whole stripped utterance.
    const full = new RegExp(
      `^(?:go(?:\\s+back)?|take\\s+me|switch|open|show\\s+me|navigate|jump|bring\\s+me|pull\\s+up|head\\s+(?:to|over)|move\\s+to)\\s+(?:to\\s+|over\\s+to\\s+|into\\s+|me\\s+to\\s+|on\\s+to\\s+|back\\s+to\\s+)?(?:the\\s+)?(?:${noun.source})(?:\\s+(?:tab|screen|view|page|section))?$`,
      "i",
    );
    if (full.test(stripped)) return { tab, label };
  }
  return null;
}

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
  // Top-level tab — HUD / CHAT / DESIGN. Loaded from localStorage
  // so a refresh keeps you on the tab you were last using.
  const [activeTab, setActiveTab] = useState<TabId>("hud");
  // Separate conversation thread for the design-tab chat overlay,
  // so design back-and-forth doesn't pollute general chat.
  const [designConversationId, setDesignConversationId] = useState<
    string | null
  >(null);
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
    // Default hands-free ON unless the user has explicitly turned
    // it off. Per the user's request: "i want to be able to talk
    // to him like he is just a normal person and not have to press
    // any buttons to talk to him." The wake-word + voice-loop
    // pipeline is already in place; we just flip its default.
    const handsFreeStored = localStorage.getItem(HANDS_FREE_KEY);
    setHandsFree(handsFreeStored === null ? true : handsFreeStored === "1");
    setCameraOn(localStorage.getItem(CAMERA_KEY) === "1");
    setActiveTab(loadTab());
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
  // Hand / face / pose tracking all auto-start — no opt-in toggles.
  // Each hook requests its own getUserMedia stream; if the browser
  // denies the camera permission, ``status`` lands at ``"error"``
  // and the corresponding overlay simply renders nothing. No noisy
  // UI. Face tracking runs silently (its data feeds the expression
  // detector + recognition vector — we deliberately do NOT draw the
  // face mesh on top of the user). Pose tracking renders the body
  // skeleton overlay just like the hand cursor does.
  const hand = useHandTracking({ enabled: true });
  const face = useFaceTracking({
    enabled: true,
    sharedStream: camera.streamRef.current ?? null,
  });
  const pose = usePoseTracking({
    enabled: true,
    sharedStream: camera.streamRef.current ?? null,
  });

  // Two-hand "sliding-door" gesture switches between the HUD,
  // CHAT, and DESIGN tabs. We feed it the same hand state the
  // HandCursor uses; the gesture handler is gated on hand
  // tracking being ready so we don't fire on noisy startup
  // frames.
  useTwoHandSwipe({
    enabled: hand.status === "ready",
    leftHand: hand.left
      ? {
          x: hand.left.cursor.x,
          y: hand.left.cursor.y,
          isCommitted: hand.left.isPinching || hand.left.isFist,
        }
      : null,
    rightHand: hand.right
      ? {
          x: hand.right.cursor.x,
          y: hand.right.cursor.y,
          isCommitted: hand.right.isPinching || hand.right.isFist,
        }
      : null,
    onSwipe: (direction) => {
      setActiveTabPersisted(neighbourTab(activeTab, direction));
    },
  });

  // Customizable-HUD state. ``customEnabled`` is the user-facing
  // "is the HUD freely arrangeable?" switch (off by default — most
  // users will use the default layout). ``editMode`` controls
  // whether widget drag/resize/hide handles are shown. See
  // ``lib/hudLayout.ts`` for the localStorage shape.
  const hud = useHudLayout();

  // Quick-Tools radial menu. Triggered when the LEFT hand closes
  // into a fist (Phase 12c.3). Items are activated by right-hand
  // pinch. State lives here (not in a hook of its own) because
  // the menu items depend on the same handlers (voice / camera /
  // mode / composer) that ChatWindow already exposes.
  const [quickToolsVisible, setQuickToolsVisible] = useState(false);
  const [quickToolsAnchor, setQuickToolsAnchor] = useState<
    { x: number; y: number } | null
  >(null);
  const quickTools = {
    visible: quickToolsVisible,
    anchor: quickToolsAnchor,
    dismiss: useCallback(() => {
      setQuickToolsVisible(false);
      setQuickToolsAnchor(null);
    }, []),
  };

  // Open the menu the moment the left fist latches; close on
  // un-fist. Anchor freezes at the *right* cursor's current
  // position so the user only has to make a small motion to
  // click an item. Falls back to the viewport center if the
  // right hand isn't visible (rare but possible if the user
  // fists their left hand before bringing their right into frame).
  const leftFist = hand.left?.isFist ?? false;
  const prevLeftFistRef = useRef(false);
  const rightCursorRef = useRef(hand.right?.cursor ?? null);
  rightCursorRef.current = hand.right?.cursor ?? null;
  useEffect(() => {
    if (leftFist && !prevLeftFistRef.current) {
      const anchor =
        rightCursorRef.current ??
        (typeof window !== "undefined"
          ? { x: window.innerWidth / 2, y: window.innerHeight / 2 }
          : { x: 600, y: 400 });
      setQuickToolsAnchor(anchor);
      setQuickToolsVisible(true);
    } else if (!leftFist && prevLeftFistRef.current) {
      setQuickToolsVisible(false);
      setQuickToolsAnchor(null);
    }
    prevLeftFistRef.current = leftFist;
  }, [leftFist]);

  // Two-hand pinch resize. While both hands are pinching, scale
  // the widget under the right cursor proportional to how much
  // the user spreads or squeezes the two pinch points.
  //
  // Lifecycle:
  //   - active flips false → true: capture target widget id +
  //     its initial w/h (resolving ``"auto"`` from the rendered
  //     element's bounding box) + the initial pinch distance.
  //   - while active: read the current distance and apply
  //     ``newSize = initialSize * (currentDistance / initialDistance)``
  //     to both width and height. Floored at 80 px so a tight
  //     pinch can't shrink a widget into invisibility.
  //   - active flips true → false: clear the captured target.
  //     The last ``updateWidget`` call already committed the
  //     final size — no extra commit needed.
  //
  // Only kicks in when the customizable HUD is enabled
  // (``hud.customEnabled``) — otherwise widgets render in the
  // default flow layout where width/height aren't user-driven.
  const twoHandActive = hand.twoHandPinch.active;
  const twoHandInitial = hand.twoHandPinch.initialDistancePx;
  const twoHandDist = hand.twoHandPinch.distancePx;
  const resizeTargetRef = useRef<{
    id: HudWidgetId;
    initialW: number;
    initialH: number;
  } | null>(null);
  // Stable references for callbacks the effect depends on. The
  // effect must NOT depend on ``hud.layout`` or it would re-run
  // every frame the widget resizes (which dirties layout).
  const updateWidgetRef = useRef(hud.updateWidget);
  updateWidgetRef.current = hud.updateWidget;
  const layoutRef = useRef(hud.layout);
  layoutRef.current = hud.layout;
  const customEnabledRef = useRef(hud.customEnabled);
  customEnabledRef.current = hud.customEnabled;
  useEffect(() => {
    if (!twoHandActive) {
      resizeTargetRef.current = null;
      return;
    }
    // Capture target on first frame of the gesture.
    if (!resizeTargetRef.current && customEnabledRef.current) {
      const cursor = rightCursorRef.current;
      if (!cursor) return;
      const el = document.elementFromPoint(cursor.x, cursor.y);
      const widgetEl = el?.closest("[data-hud-widget]") as HTMLElement | null;
      const id = widgetEl?.dataset.hudWidget as HudWidgetId | undefined;
      if (!id) return;
      const layout = layoutRef.current[id];
      if (!layout) return;
      const rect = widgetEl?.getBoundingClientRect();
      const initialW = layout.w === "auto" ? (rect?.width ?? 240) : layout.w;
      const initialH = layout.h === "auto" ? (rect?.height ?? 180) : layout.h;
      resizeTargetRef.current = { id, initialW, initialH };
    }
    // Apply the scale.
    const target = resizeTargetRef.current;
    if (!target || !twoHandInitial || twoHandInitial <= 0) return;
    const ratio = twoHandDist / twoHandInitial;
    const w = Math.max(80, Math.round(target.initialW * ratio));
    const h = Math.max(80, Math.round(target.initialH * ratio));
    updateWidgetRef.current(target.id, { w, h });
  }, [twoHandActive, twoHandDist, twoHandInitial]);

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

  function setActiveTabPersisted(tab: TabId) {
    setActiveTab(tab);
    persistTab(tab);
  }

  // Items rendered inside the QuickToolsMenu when the left fist
  // is held. Each maps to an existing toolbar handler so behavior
  // stays consistent with the on-screen buttons. ⌨ "Keyboard"
  // simply focuses the composer text input — your physical
  // keyboard takes over from there. A full air-pinch virtual
  // keyboard is a follow-up phase if the gesture sticks.
  const quickToolsItems = [
    {
      id: "voice",
      glyph: "🔊",
      label: "Voice",
      active: voiceOut,
      onActivate: () => setVoiceOutPersisted(!voiceOut),
    },
    {
      id: "wake",
      glyph: "🎙",
      label: "Wake",
      active: handsFree,
      onActivate: () => setHandsFreePersisted(!handsFree),
    },
    {
      id: "camera",
      glyph: "📷",
      label: "Camera",
      active: cameraOn,
      onActivate: () => setCameraPersisted(!cameraOn),
    },
    {
      id: "keyboard",
      glyph: "⌨",
      label: "Keyboard",
      active: false,
      onActivate: () => composerRef.current?.focus(),
    },
    {
      id: "hud",
      glyph: "🌗",
      label: "HUD",
      active: fullHud,
      onActivate: () => setFullHudPersisted(!fullHud),
    },
  ];

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

  // Operations log feed for the JARVIS HUD bottom-left panel.
  // We push events whenever a meaningful state transition happens —
  // the hook itself de-dupes consecutive identical tags so rapid
  // toggles don't flood the feed.
  const opsLog = useOperationsLog();
  const { log: pushOp } = opsLog;
  useEffect(() => {
    if (busy) pushOp("PROCESSING", "composing reply", "live");
    else if (speaking) pushOp("TRANSMITTING", "speaking", "live");
    else if (recording) pushOp("LISTENING", "mic open", "live");
    else if (handsFree && wake.status === "listening")
      pushOp("STANDBY", `wake: ${WAKE_LABEL}`);
    else pushOp("STANDBY");
  }, [busy, speaking, recording, handsFree, wake.status, pushOp]);

  useEffect(() => {
    if (camera.status === "error" && cameraOn) {
      pushOp("CAMERA ERR", camera.error ?? undefined, "warn");
    } else if (camera.status === "ready" && cameraOn) {
      pushOp("CAMERA ONLINE", `${camera.faceCount} face(s)`, "info");
    }
  }, [camera.status, camera.faceCount, camera.error, cameraOn, pushOp]);

  useEffect(() => {
    if (hand.status === "ready") pushOp("HANDS LOCKED", "tracking", "info");
  }, [hand.status, pushOp]);

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

  // Have Alfred verbally apologise when speech recognition couldn't
  // make sense of the user's audio, instead of letting a raw error
  // banner appear or a hallucinated transcript reach the chat
  // history. Dedupes rapid-fire calls (e.g. wake-word retries) so
  // Alfred doesn't apologise five times in three seconds.
  const lastUnclearAtRef = useRef(0);
  const handleSpeechUnclear = useCallback(
    (reason: "no_audio" | "no_words" | "hallucination" | "error") => {
      void reason; // currently uniform response; keep arg for future tailoring
      const now = Date.now();
      if (now - lastUnclearAtRef.current < 4000) return;
      lastUnclearAtRef.current = now;
      // Prefer voice if it's enabled — otherwise leave the inline
      // mic-error banner as the only feedback.
      if (voiceOut) {
        void speak("Apologies, sir — I didn't quite catch that. Could you say it again?");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [voiceOut],
  );

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

    // Intercept tab-switch voice/text intents BEFORE sending to the
    // LLM. Lets the user say "Alfred, go to the workout tab" / "open
    // chat" / "switch to design" and Alfred actually navigates
    // instead of responding with chat. Bypasses LLM round-trip
    // entirely so it feels instant.
    if (images.length === 0) {
      const intent = detectTabIntent(text);
      if (intent) {
        setActiveTabPersisted(intent.tab);
        // Echo the action into the chat history so the user sees
        // what Alfred did (and so it shows up in Operations Log).
        const ack = `Switching to ${intent.label}, sir.`;
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: "user", content: text },
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: ack,
          },
        ]);
        if (voiceOut) {
          void speak(ack);
        }
        return;
      }
    }

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

  // Build the JARVIS top-right system-status pill. Each indicator is
  // derived from existing component state so this is just a view
  // projection — no additional plumbing needed.
  const systemIndicators: Indicator[] = [
    {
      id: "system",
      label: "System",
      state: error ? "err" : "ok",
      hint: error ?? "Alfred is online",
    },
    {
      id: "wake",
      label: "Wake",
      state: !handsFree
        ? "off"
        : wake.status === "listening"
          ? "ok"
          : wake.status === "paused" || wake.status === "starting"
            ? "warn"
            : wake.status === "error"
              ? "err"
              : "off",
      hint: handsFree
        ? `Wake word: ${WAKE_LABEL} · ${wake.status}`
        : "Hands-free is off",
    },
    {
      id: "voice",
      label: "Voice",
      state: voiceOut ? (speaking ? "ok" : "warn") : "off",
      hint: voiceOut ? "Alfred can speak replies" : "TTS is muted",
    },
    {
      id: "camera",
      label: "Camera",
      state: !cameraOn
        ? "off"
        : camera.status === "ready"
          ? "ok"
          : camera.status === "starting"
            ? "warn"
            : "err",
      hint: cameraOn ? `Camera ${camera.status}` : "Camera is off",
    },
    {
      id: "hands",
      label: "Hands",
      state: hand.status === "ready" ? "ok" : "off",
      hint: `Hand tracking: ${hand.status}`,
    },
    {
      id: "memory",
      label: "Memory",
      state: convoId ? "ok" : "warn",
      hint: convoId
        ? "Conversation thread active"
        : "No active conversation thread",
    },
  ];

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
          onUnclear={handleSpeechUnclear}
        />
      </div>
    </>
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: "100vh",
      }}
    >
      <TabBar active={activeTab} onChange={setActiveTabPersisted} />
      <HudFrame enabled={activeTab === "hud"} />
      {activeTab === "hud" ? (
        <>
          {/* System status pill — wrapped in a HudWidget so the user
              can move/resize/hide it just like every other widget on
              the HUD. */}
          {hud.layout["system-status"].visible ? (
            <HudWidget
              id="system-status"
              label={WIDGET_LABELS["system-status"]}
              layout={hud.layout["system-status"]}
              customEnabled={hud.customEnabled}
              onMove={(p) => hud.updateWidget("system-status", p)}
              onHide={() => hud.hideWidget("system-status")}
            >
              <SystemStatus indicators={systemIndicators} />
            </HudWidget>
          ) : null}
          <OperationsLog entries={opsLog.entries} />
        </>
      ) : null}
      {activeTab === "design" ? (
        <DesignView
          conversationId={designConversationId}
          onConversationCreated={setDesignConversationId}
        />
      ) : activeTab === "workout" ? (
        <WorkoutTabView
          cameraOn={cameraOn}
          cameraStatus={camera.status}
          faceCount={camera.faceCount}
          cameraStreamRef={camera.streamRef}
          pose={pose.pose}
          poseStatus={pose.status}
          face={face.face}
          faceStatus={face.status}
          onToggleCamera={() => setCameraPersisted(!cameraOn)}
        />
      ) : (
        <div
          style={{
            display: "flex",
            flex: 1,
            minHeight: 0,
          }}
          data-active-tab={activeTab}
        >
          {/* Chat tab gets its own dedicated full-screen layout
              (narrow conversation list rail + flex:1 chat pane).
              The legacy ConversationSidebar's collapse/HUD-overlap
              behaviour was confusing — replaced by ChatTabView. */}
          {activeTab === "chat" ? (
            <ChatTabView
              conversations={conversations}
              activeId={convoId}
              onSelect={(id) => {
                if (id !== convoId) void loadConversation(id);
              }}
              onNewChat={handleNewChat}
              onDelete={(id) => void handleDelete(id)}
              busy={busy || loadingConvo}
              chatPane={chatPane}
            />
          ) : null}

      <div
        style={{
          flex: 1,
          // Hide the HUD main pane visually when the chat tab is
          // active so the sidebar+chat take the whole window — but
          // keep the pane mounted (display:none, not removed) so the
          // hidden <video> elements + tracking refs survive tab
          // switches without re-permission-prompting the camera.
          display: activeTab === "chat" ? "none" : "flex",
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
            {activeTab === "hud" ? (
              // On the HUD tab, the JARVIS TitleBlock above the orb
              // is the canonical wordmark — hide the flat header h1
              // so we don't render ALFRED twice.
              <span aria-hidden style={{ display: "none" }} />
            ) : (
              <>
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
              </>
            )}
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

        {/* The HUD canvas is now ALWAYS rendered, regardless of
            whether ``customEnabled`` is on. That way widgets stay
            where the user dragged them — even after they toggle
            customize off. ``customEnabled`` only controls whether
            drag/resize/hide handles are visible, not whether the
            canvas is mounted. (The previous behaviour was that
            disabling customize reverted the layout to the default
            flow, which the user reported as "I can move things
            around but they don't stay".) */}
        <ResponsiveHudCanvas>
          {(scale) => (
            <>
                <HudWidget
                  id="clock"
                  label={WIDGET_LABELS.clock}
                  layout={hud.layout.clock}
                  customEnabled={hud.customEnabled}
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
                  customEnabled={hud.customEnabled}
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
                  customEnabled={hud.customEnabled}
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
                  customEnabled={hud.customEnabled}
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
                    {(() => {
                      const orbSize = Math.max(
                        80,
                        Math.min(
                          typeof hud.layout.orb.w === "number"
                            ? hud.layout.orb.w
                            : 360,
                          typeof hud.layout.orb.h === "number"
                            ? hud.layout.orb.h
                            : 200,
                        ) - 20,
                      );
                      return <Orb3D size={orbSize} caption={orbCaption} />;
                    })()}
                  </div>
                </HudWidget>
                <HudWidget
                  id="spotify"
                  label={WIDGET_LABELS.spotify}
                  layout={hud.layout.spotify}
                  customEnabled={hud.customEnabled}
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
                  customEnabled={hud.customEnabled}
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
                <HudWidget
                  id="workout-coach"
                  label={WIDGET_LABELS["workout-coach"]}
                  layout={hud.layout["workout-coach"]}
                  customEnabled={hud.customEnabled}
                  scale={scale}
                  onMove={(p) => hud.updateWidget("workout-coach", p)}
                  onHide={() => hud.hideWidget("workout-coach")}
                  hidden={
                    !hud.layout["workout-coach"].visible ||
                    !cameraOn ||
                    !pose.pose
                  }
                >
                  <WorkoutCoachWidget
                    pose={pose.pose}
                    poseStatus={pose.status}
                  />
                </HudWidget>
                <HudWidget
                  id="face-recognition"
                  label={WIDGET_LABELS["face-recognition"]}
                  layout={hud.layout["face-recognition"]}
                  customEnabled={hud.customEnabled}
                  scale={scale}
                  onMove={(p) => hud.updateWidget("face-recognition", p)}
                  onHide={() => hud.hideWidget("face-recognition")}
                  hidden={
                    !hud.layout["face-recognition"].visible ||
                    !cameraOn ||
                    !face.face ||
                    face.status !== "ready"
                  }
                >
                  <FaceRecognitionWidget
                    face={face.face}
                    faceStatus={face.status}
                  />
                </HudWidget>
                {/* The holographic Earth is its own free-floating
                    element (always-draggable from its handle bar,
                    independent of customize mode) — see
                    ``FloatingEarth.tsx``. Not wrapped in HudWidget. */}
                <FloatingEarth scale={scale} />
              </>
            )}
          </ResponsiveHudCanvas>

        {/* TitleBlock + GreetingCard removed per user preference —
            the JARVIS HUD now reads as the orb + widgets without a
            wordmark / greeting banner. */}

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
        {/*
          Hidden <video> for the hand-tracking feed. Same lifecycle
          rules as the camera one above — keep it always mounted so
          ``hand.videoRef.current`` doesn't null out across tab /
          sidebar transitions and silently break the detection loop.
        */}
        <video
          ref={hand.videoRef as React.RefObject<HTMLVideoElement>}
          playsInline
          muted
          aria-hidden
          style={{ display: "none" }}
        />
        {/* Hidden videos for face + pose tracking — same lifecycle
            as the camera + hand videos above. */}
        <video
          ref={face.videoRef as React.RefObject<HTMLVideoElement>}
          playsInline
          muted
          aria-hidden
          style={{ display: "none" }}
        />
        <video
          ref={pose.videoRef as React.RefObject<HTMLVideoElement>}
          playsInline
          muted
          aria-hidden
          style={{ display: "none" }}
        />
        <HandCursor
          enabled={hand.status === "ready"}
          rightHand={hand.right}
          leftHand={hand.left}
        />
        <PoseSkeleton
          enabled={pose.status === "ready"}
          pose={pose.pose}
        />
        {/* Expression readout — small fixed-position HUD strip showing
            the dominant facial expression. NOT a face mesh — Alfred
            sees the expression but doesn't draw on top of the user. */}
        <ExpressionReadout
          enabled={face.status === "ready"}
          face={face.face}
        />
        <QuickToolsMenu
          visible={quickTools.visible}
          anchor={quickTools.anchor}
          items={quickToolsItems}
          onActivated={quickTools.dismiss}
        />
      </div>
        </div>
      )}
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
// Bumped from 720 → 880 so widgets placed in the bottom third
// (camera, face-recognition, weather-strip) stay fully on-screen
// instead of getting clipped under the canvas's overflow boundary.
const HUD_CANVAS_BASELINE_HEIGHT = 880;

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
        // ``overflow: visible`` so the camera + face-recognition
        // widgets (which sit in the bottom third of the canvas)
        // don't get clipped on shorter viewports — the user
        // reported camera was "unreachable" with overflow hidden.
        overflow: "visible",
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
