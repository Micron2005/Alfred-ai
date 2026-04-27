"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type SpotifyAudioAnalysis,
  type SpotifyPlaybackState,
  type SpotifyPlayer,
  type SpotifyStatus,
  type SpotifyTrack,
  disconnectSpotify,
  fetchAccessToken,
  fetchAudioAnalysis,
  getNowPlaying,
  getSpotifyStatus,
  loadSpotifySdk,
  nextSpotifyTrack,
  pauseSpotify,
  playSpotify,
  previousSpotifyTrack,
  startSpotifyAuth,
  transferPlayback,
} from "@/lib/spotify";

const POLL_MS = 5000;
// Number of frequency-style bars rendered. Twelve maps cleanly to
// Spotify's per-segment 12-band pitch envelope (one band per semitone
// in the chroma vector), so each bar represents a real spectral band.
const BAR_COUNT = 12;

type Bars = number[];

interface SpotifyPlayerProps {
  /** Whether the chat surface is currently in Nightfall mode. Used
   *  only for visualizer accent colour — the rest of the widget is
   *  driven by CSS variables. */
  nightfall: boolean;
}

/**
 * The Spotify HUD widget — connect button when not linked, now-playing
 * card + transport controls when playing, and the audio-analysis-driven
 * spectrum visualizer that sits beneath the orb.
 */
export function SpotifyPlayer({ nightfall }: SpotifyPlayerProps) {
  const [status, setStatus] = useState<SpotifyStatus | null>(null);
  const [track, setTrack] = useState<SpotifyTrack | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  // Live state from the Web Playback SDK when Alfred is the active
  // device. ``null`` means either Spotify is playing on a different
  // device (phone, desktop app) or nothing is playing at all.
  const [sdkState, setSdkState] = useState<SpotifyPlaybackState | null>(null);
  const playerRef = useRef<SpotifyPlayer | null>(null);
  // Cache the audio analysis for the current track so we don't re-hit
  // Spotify every time progress ticks. Keyed by track id so a track
  // change clears it implicitly via the cache miss.
  const analysisRef = useRef<{ trackId: string; data: SpotifyAudioAnalysis } | null>(
    null,
  );
  const [bars, setBars] = useState<Bars>(() => Array(BAR_COUNT).fill(0.05));
  // Local progress estimate that ticks once per RAF rather than once
  // per Spotify poll — without it the visualizer would freeze between
  // network responses since we wouldn't know which segment we're in.
  const progressRef = useRef<{ ms: number; capturedAt: number; isPlaying: boolean }>({
    ms: 0,
    capturedAt: performance.now(),
    isPlaying: false,
  });
  // Real-audio (tab-capture) state. ``liveAnalyserRef`` is read by the
  // RAF loop without a dep change, so storing the analyser in a ref
  // keeps the RAF effect stable. ``liveAudioState`` is just for UI.
  const liveAnalyserRef = useRef<AnalyserNode | null>(null);
  const liveStreamRef = useRef<MediaStream | null>(null);
  const liveContextRef = useRef<AudioContext | null>(null);
  const [liveAudioState, setLiveAudioState] = useState<
    "off" | "starting" | "live" | "denied"
  >("off");

  // ─── Status + post-OAuth refresh ──────────────────────────────────

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await getSpotifyStatus());
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    // After a successful callback the backend bounces us back with
    // ``?spotify_linked=1``. Detect that, refresh status (so the UI
    // jumps from Connect → Connected), and clean the URL so a manual
    // refresh later doesn't keep showing the flag.
    const params = new URLSearchParams(window.location.search);
    if (params.get("spotify_linked") === "1") {
      params.delete("spotify_linked");
      const search = params.toString();
      const next = `${window.location.pathname}${search ? `?${search}` : ""}`;
      window.history.replaceState({}, "", next);
      void refreshStatus();
    }
    if (params.get("spotify_error")) {
      setError(`Spotify auth failed (${params.get("spotify_error")}).`);
      params.delete("spotify_error");
      const search = params.toString();
      const next = `${window.location.pathname}${search ? `?${search}` : ""}`;
      window.history.replaceState({}, "", next);
    }
  }, [refreshStatus]);

  // ─── Web Playback SDK + Connect device registration ──────────────

  useEffect(() => {
    if (!status?.linked) return;
    let cancelled = false;
    let player: SpotifyPlayer | null = null;
    void (async () => {
      try {
        await loadSpotifySdk();
      } catch (exc) {
        if (cancelled) return;
        const message = exc instanceof Error ? exc.message : String(exc);
        setError(`Couldn't load Spotify SDK: ${message}`);
        return;
      }
      if (cancelled || !window.Spotify) return;
      player = new window.Spotify.Player({
        name: "Alfred",
        getOAuthToken: (cb) => {
          // Each call goes through the backend so the refresh token
          // never reaches the browser. The backend handles the
          // refresh dance.
          fetchAccessToken()
            .then((t) => cb(t.access_token))
            .catch((exc) => {
              const message = exc instanceof Error ? exc.message : String(exc);
              setError(`Spotify token refresh failed: ${message}`);
            });
        },
        volume: 0.7,
      });
      playerRef.current = player;
      player.addListener("ready", ({ device_id }) => {
        if (cancelled) return;
        setDeviceId(device_id);
      });
      player.addListener("not_ready", () => {
        if (cancelled) return;
        setDeviceId(null);
      });
      player.addListener("player_state_changed", (state) => {
        if (cancelled) return;
        setSdkState(state);
        if (state) {
          progressRef.current = {
            ms: state.position,
            capturedAt: performance.now(),
            isPlaying: !state.paused,
          };
        }
      });
      player.addListener("authentication_error", ({ message }) => {
        if (cancelled) return;
        setError(`Spotify auth error: ${message}`);
      });
      player.addListener("account_error", ({ message }) => {
        if (cancelled) return;
        setError(`Spotify account error (Premium required?): ${message}`);
      });
      player.addListener("initialization_error", ({ message }) => {
        if (cancelled) return;
        setError(`Spotify SDK init error: ${message}`);
      });
      const ok = await player.connect();
      if (!ok && !cancelled) {
        setError("Spotify SDK refused to connect. Check Premium status.");
      }
    })();
    return () => {
      cancelled = true;
      if (player) {
        player.disconnect();
      }
      playerRef.current = null;
      setDeviceId(null);
      setSdkState(null);
    };
  }, [status?.linked]);

  // ─── Now-playing polling fallback ────────────────────────────────
  //
  // Whatever device is actually playing (Alfred-the-Connect-device,
  // a phone, the desktop app), the now-playing endpoint reflects it.
  // We poll at a relaxed cadence so the HUD widget still works when
  // the user is playing on a different device.

  useEffect(() => {
    if (!status?.linked) {
      setTrack(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const result = await getNowPlaying();
        if (cancelled) return;
        setTrack(result);
        if (result) {
          progressRef.current = {
            ms: result.progress_ms,
            capturedAt: performance.now(),
            isPlaying: result.is_playing,
          };
        }
      } catch (exc) {
        // Don't spam an error toast every 5 s — surface the most
        // recent and let it overwrite quietly.
        if (!cancelled) {
          const message = exc instanceof Error ? exc.message : String(exc);
          setError(message);
        }
      }
    };
    void tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [status?.linked]);

  // ─── Audio-analysis fetch on track change ────────────────────────

  const trackId = sdkState?.track_window.current_track?.id ?? track?.track_id ?? null;
  useEffect(() => {
    if (!trackId) {
      analysisRef.current = null;
      return;
    }
    if (analysisRef.current?.trackId === trackId) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchAudioAnalysis(trackId);
        if (cancelled) return;
        analysisRef.current = { trackId, data };
      } catch {
        // Audio analysis isn't available for every track (e.g.
        // user-uploaded local files). Silent fallback — the
        // visualizer will just show idle bars.
        if (!cancelled) {
          analysisRef.current = null;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [trackId]);

  // ─── Visualizer RAF loop ─────────────────────────────────────────
  //
  // Renders 12 bars from one of three sources, in priority order:
  //
  //   1. ``liveAnalyserRef`` — a real Web Audio analyser fed by tab-
  //      capture. Genuinely tracks whatever Spotify is playing.
  //   2. ``analysisRef`` — Spotify's audio-analysis API. Spotify
  //      deprecated this endpoint for new dev apps in Nov 2024, so
  //      this branch only fires for grandfathered apps.
  //   3. A synthetic per-band sine envelope keyed to the current
  //      playhead. Not actually reactive, but moves in a believably
  //      musical shape so the widget doesn't sit dead.
  //
  // All three pass through the same low-pass smoother before being
  // committed to React state.

  useEffect(() => {
    let raf = 0;
    let prev: Bars = Array(BAR_COUNT).fill(0.05);
    const idleFloor = 0.04;
    const smoothing = 0.6; // higher = smoother, less reactive
    // Backed by an explicit ArrayBuffer (rather than the default
    // ArrayBufferLike) so TS accepts it as the parameter to
    // ``getByteFrequencyData`` under recent DOM lib types.
    const liveBuffer = new Uint8Array(new ArrayBuffer(BAR_COUNT * 4));
    const tick = () => {
      const analysis = analysisRef.current?.data;
      const liveAnalyser = liveAnalyserRef.current;
      const { ms, capturedAt, isPlaying } = progressRef.current;
      // Estimate current track position in seconds: snapshot ms +
      // wall-clock delta since the snapshot, but only while playing.
      const elapsed = isPlaying
        ? (ms + (performance.now() - capturedAt)) / 1000
        : ms / 1000;
      let target: Bars;
      if (liveAnalyser && isPlaying) {
        target = sampleAnalyser(liveAnalyser, liveBuffer);
      } else if (analysis && analysis.segments.length > 0 && isPlaying) {
        const seg = findSegment(analysis.segments, elapsed);
        target = pitchesToBars(seg.pitches, seg.loudness_max);
      } else if (isPlaying) {
        // Synthetic fallback — looks musical even though it isn't.
        target = syntheticBars(elapsed);
      } else {
        target = Array(BAR_COUNT).fill(idleFloor);
      }
      const next = prev.map((p, i) => {
        const t = target[i] ?? idleFloor;
        return p * smoothing + t * (1 - smoothing);
      });
      prev = next;
      setBars(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ─── Action handlers ─────────────────────────────────────────────

  const onConnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await startSpotifyAuth();
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
      setBusy(false);
    }
  };

  const onDisconnect = async () => {
    setBusy(true);
    try {
      await disconnectSpotify();
      await refreshStatus();
      setTrack(null);
      setSdkState(null);
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const onPlayHere = async () => {
    if (!deviceId) return;
    setBusy(true);
    try {
      await transferPlayback(deviceId, true);
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  // Manual transport controls. We always go through the backend so
  // these work regardless of which Spotify Connect device is currently
  // active (Alfred-in-browser, phone, desktop app, etc).
  //
  // Optimistic-update the SDK state when Alfred is the active device
  // so the play/pause icon flips immediately rather than waiting for
  // the SDK's player_state_changed event to fire.
  const runTransport = useCallback(
    async (action: () => Promise<unknown>, optimistic?: () => void) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      optimistic?.();
      try {
        await action();
      } catch (exc) {
        const message = exc instanceof Error ? exc.message : String(exc);
        setError(message);
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const isPlaying = sdkState ? !sdkState.paused : !!track?.is_playing;

  const onTogglePlay = () =>
    runTransport(
      () => (isPlaying ? pauseSpotify() : playSpotify()),
      () => {
        if (sdkState) {
          setSdkState({ ...sdkState, paused: isPlaying });
        }
      },
    );

  const onNext = () => runTransport(() => nextSpotifyTrack());

  const onPrevious = () => runTransport(() => previousSpotifyTrack());

  // Stop tab-capture and tear down the analyser graph. Idempotent.
  const stopLiveAudio = useCallback(() => {
    if (liveStreamRef.current) {
      for (const t of liveStreamRef.current.getTracks()) t.stop();
      liveStreamRef.current = null;
    }
    if (liveContextRef.current) {
      void liveContextRef.current.close().catch(() => {});
      liveContextRef.current = null;
    }
    liveAnalyserRef.current = null;
    setLiveAudioState("off");
  }, []);

  // Request tab-audio capture and wire it into a Web Audio analyser.
  // The user picks the tab; if they pick one without audio (or click
  // Cancel) we surface a hint instead of an error toast.
  const startLiveAudio = useCallback(async () => {
    if (liveAudioState === "starting" || liveAudioState === "live") return;
    setLiveAudioState("starting");
    try {
      // ``getDisplayMedia`` always asks for video too; we discard the
      // video track immediately and keep only the audio one.
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        for (const t of stream.getTracks()) t.stop();
        setLiveAudioState("off");
        setError(
          "Tab capture started without audio — when the picker pops up, " +
            "tick the 'Share tab audio' box.",
        );
        return;
      }
      // Drop video tracks to free GPU + reduce permission scope.
      for (const t of stream.getVideoTracks()) t.stop();
      const audioOnly = new MediaStream(audioTracks);
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(audioOnly);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64; // 32 frequency bins, plenty for 12 bars
      analyser.smoothingTimeConstant = 0.7;
      source.connect(analyser);
      // Important: we deliberately do NOT connect the analyser to
      // ``ctx.destination`` — that would re-emit the captured tab
      // audio through the default output, causing a feedback echo
      // for the user.
      liveStreamRef.current = audioOnly;
      liveContextRef.current = ctx;
      liveAnalyserRef.current = analyser;
      setLiveAudioState("live");
      // If the user revokes tab-capture from the browser's "Stop
      // sharing" bar, the audio track ends — clean up so the bars
      // fall back to synthetic.
      audioTracks[0].addEventListener("ended", stopLiveAudio);
    } catch (exc) {
      // ``NotAllowedError`` (denied) and ``AbortError`` (cancel) both
      // land here. Keep this quiet — the user just declined.
      const name =
        exc instanceof Error && exc.name ? exc.name : String(exc);
      if (name === "NotAllowedError" || name === "AbortError") {
        setLiveAudioState("off");
      } else {
        setLiveAudioState("denied");
        const message = exc instanceof Error ? exc.message : String(exc);
        setError(`Couldn't capture tab audio: ${message}`);
      }
    }
  }, [liveAudioState, stopLiveAudio]);

  // Tear down on unmount so the analyser graph + tab-capture sharing
  // banner don't outlive the widget.
  useEffect(() => stopLiveAudio, [stopLiveAudio]);

  // ─── Render ──────────────────────────────────────────────────────

  if (!status) {
    return null; // initial load: don't flash a Connect button before status resolves
  }

  if (!status.configured) {
    // No dev-app credentials on the server — quiet, single-line note
    // rather than a Connect button that won't work.
    return (
      <div className="hud-spotify hud-spotify--unconfigured">
        <span className="hud-spotify__label">SPOTIFY · NOT CONFIGURED</span>
      </div>
    );
  }

  return (
    <div className="hud-spotify" data-nightfall={nightfall ? "true" : "false"}>
      <SpectrumBars bars={bars} nightfall={nightfall} />
      <div className="hud-spotify__row">
        {!status.linked ? (
          <button
            type="button"
            className="hud-button hud-button--primary"
            onClick={onConnect}
            disabled={busy}
          >
            {busy ? "Connecting…" : "🎵 Connect Spotify"}
          </button>
        ) : (
          <NowPlaying
            track={track}
            sdkState={sdkState}
            isAlfredDevice={deviceId !== null}
            onPlayHere={onPlayHere}
            onDisconnect={onDisconnect}
            displayName={status.display_name}
            busy={busy}
            isPlaying={isPlaying}
            onTogglePlay={onTogglePlay}
            onNext={onNext}
            onPrevious={onPrevious}
            liveAudioState={liveAudioState}
            onStartLiveAudio={() => void startLiveAudio()}
            onStopLiveAudio={stopLiveAudio}
          />
        )}
      </div>
      {error && <div className="hud-spotify__error">{error}</div>}
    </div>
  );
}

/** Pure SVG spectrum bars — no canvas, no extra deps. */
function SpectrumBars({ bars, nightfall }: { bars: Bars; nightfall: boolean }) {
  const width = 320;
  const height = 56;
  const gap = 4;
  const barWidth = (width - gap * (bars.length - 1)) / bars.length;
  // Live elements use the ``--accent-live`` colour from the theme.
  // The data attribute on the parent wires the right palette.
  return (
    <svg
      className="hud-spotify__bars"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="presentation"
      aria-hidden="true"
    >
      {bars.map((b, i) => {
        const h = Math.max(2, b * height);
        const x = i * (barWidth + gap);
        const y = (height - h) / 2;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barWidth}
            height={h}
            rx={1.5}
            className={
              nightfall
                ? "hud-spotify__bar hud-spotify__bar--nightfall"
                : "hud-spotify__bar"
            }
          />
        );
      })}
    </svg>
  );
}

interface NowPlayingProps {
  track: SpotifyTrack | null;
  sdkState: SpotifyPlaybackState | null;
  isAlfredDevice: boolean;
  onPlayHere: () => void;
  onDisconnect: () => void;
  displayName: string;
  busy: boolean;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onNext: () => void;
  onPrevious: () => void;
  liveAudioState: "off" | "starting" | "live" | "denied";
  onStartLiveAudio: () => void;
  onStopLiveAudio: () => void;
}

function NowPlaying({
  track,
  sdkState,
  isAlfredDevice,
  onPlayHere,
  onDisconnect,
  displayName,
  busy,
  isPlaying,
  onTogglePlay,
  onNext,
  onPrevious,
  liveAudioState,
  onStartLiveAudio,
  onStopLiveAudio,
}: NowPlayingProps) {
  // Prefer SDK state when Alfred is active (it updates in real time);
  // fall back to the polled now-playing for cross-device awareness.
  const sdkTrack = sdkState?.track_window.current_track;
  const visible = sdkTrack
    ? {
        title: sdkTrack.name,
        artists: sdkTrack.artists.map((a) => a.name).join(", "),
        album: sdkTrack.album.name,
        image_url: sdkTrack.album.images[0]?.url ?? "",
      }
    : track
      ? {
          title: track.title,
          artists: track.artists,
          album: track.album,
          image_url: track.image_url,
        }
      : null;
  return (
    <div className="hud-spotify__now">
      {visible ? (
        <>
          {visible.image_url && (
            // Album art is loaded from Spotify's CDN (i.scdn.co), which
            // isn't an allowed remote pattern in the Next image config —
            // and adding it would require a config change for ~50px of
            // art. A plain <img> is fine here. eslint-disable-next-line
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={visible.image_url}
              alt=""
              className="hud-spotify__art"
              width={48}
              height={48}
            />
          )}
          <div className="hud-spotify__meta">
            <div className="hud-spotify__title">{visible.title || "—"}</div>
            <div className="hud-spotify__artist">{visible.artists}</div>
          </div>
        </>
      ) : (
        <div className="hud-spotify__meta">
          <div className="hud-spotify__title">SPOTIFY · IDLE</div>
          <div className="hud-spotify__artist">
            Connected as {displayName || "you"}
          </div>
        </div>
      )}
      <div className="hud-spotify__controls">
        <button
          type="button"
          className="hud-button hud-button--icon"
          onClick={onPrevious}
          disabled={busy}
          title="Previous track"
          aria-label="Previous track"
        >
          ⏮
        </button>
        <button
          type="button"
          className="hud-button hud-button--icon hud-button--primary"
          onClick={onTogglePlay}
          disabled={busy}
          title={isPlaying ? "Pause" : "Play"}
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? "⏸" : "▶"}
        </button>
        <button
          type="button"
          className="hud-button hud-button--icon"
          onClick={onNext}
          disabled={busy}
          title="Next track"
          aria-label="Next track"
        >
          ⏭
        </button>
        <button
          type="button"
          className={
            liveAudioState === "live"
              ? "hud-button hud-button--icon is-active"
              : "hud-button hud-button--icon"
          }
          onClick={
            liveAudioState === "live" ? onStopLiveAudio : onStartLiveAudio
          }
          disabled={liveAudioState === "starting"}
          title={
            liveAudioState === "live"
              ? "Real-audio visualizer on. Click to stop."
              : "Make the bars react to actual sound. " +
                "Asks to share a tab — pick this one and tick 'Share tab audio'."
          }
          aria-pressed={liveAudioState === "live"}
          aria-label="Toggle live audio visualizer"
        >
          {liveAudioState === "live" ? "🎚 LIVE" : "🎚"}
        </button>
        {!isAlfredDevice ? (
          <button
            type="button"
            className="hud-button"
            onClick={onPlayHere}
            disabled={busy}
            title="Play through Alfred's in-browser device"
          >
            HERE
          </button>
        ) : null}
        <button
          type="button"
          className="hud-button hud-button--icon"
          onClick={onDisconnect}
          disabled={busy}
          title="Forget this Spotify account"
          aria-label="Disconnect Spotify"
        >
          ⨯
        </button>
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Binary-search the segment that contains a given track-time in seconds.
 * Spotify's segments are sorted by ``start`` and have a ``duration``,
 * so the right segment is the one where start <= t < start + duration.
 */
function findSegment(
  segments: SpotifyAudioAnalysis["segments"],
  t: number,
): SpotifyAudioAnalysis["segments"][number] {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (segments[mid].start <= t) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return segments[lo] ?? segments[0];
}

// Per-bar phase + tempo offsets for the synthetic envelope. Picked
// once at module-load so each instance of the widget breathes in the
// same pattern — keeps the visualizer consistent without storing this
// in state.
const SYNTH_PHASES: number[] = Array.from(
  { length: BAR_COUNT },
  (_, i) => i * 0.71,
);
const SYNTH_TEMPOS: number[] = Array.from(
  { length: BAR_COUNT },
  // Bass on the left (slow), treble on the right (fast). The 1.4
  // ratio gives a roughly logarithmic spread.
  (_, i) => 1.2 + (i / (BAR_COUNT - 1)) * 4.5,
);
const SYNTH_AMPS: number[] = Array.from(
  { length: BAR_COUNT },
  // Bass bars get more headroom than treble — same shape as a real
  // EQ readout for typical music.
  (_, i) => 0.55 + 0.35 * (1 - i / (BAR_COUNT - 1)),
);

/**
 * Synthesize 12 plausibly-musical bar heights from the current track
 * playhead. Two layered sines per bar produce a non-repeating,
 * non-uniform envelope that *looks* like a real spectrum without ever
 * touching audio. Used as the fallback when neither tab-capture nor
 * Spotify's deprecated audio-analysis are available.
 */
function syntheticBars(elapsed: number): Bars {
  const out: Bars = [];
  // Slow global modulation so the whole bank breathes in unison once
  // every ~6 seconds — keeps the eye moving even when individual
  // bars are mid-sway.
  const breath = 0.7 + 0.3 * Math.sin(elapsed * 0.45);
  for (let i = 0; i < BAR_COUNT; i += 1) {
    const t = SYNTH_TEMPOS[i];
    const phase = SYNTH_PHASES[i];
    const a = SYNTH_AMPS[i];
    const slow = 0.5 + 0.5 * Math.sin(elapsed * t + phase);
    const fast = 0.5 + 0.5 * Math.sin(elapsed * t * 2.3 + phase * 1.7);
    const v = a * slow * (0.55 + 0.45 * fast) * breath;
    out.push(Math.max(0.06, Math.min(1, v)));
  }
  return out;
}

/**
 * Sample a Web Audio AnalyserNode into 12 bar heights. We average
 * adjacent FFT bins so each bar covers a roughly equal frequency
 * range; the AnalyserNode returns 0..255 byte amplitudes which we
 * normalize to 0..1.
 */
function sampleAnalyser(
  analyser: AnalyserNode,
  scratch: Uint8Array<ArrayBuffer>,
): Bars {
  const binCount = analyser.frequencyBinCount;
  if (scratch.length !== binCount) {
    // Reallocate the scratch buffer if the analyser was reconfigured.
    scratch = new Uint8Array(new ArrayBuffer(binCount));
  }
  analyser.getByteFrequencyData(scratch);
  const out: Bars = [];
  const perBar = Math.max(1, Math.floor(binCount / BAR_COUNT));
  for (let i = 0; i < BAR_COUNT; i += 1) {
    let sum = 0;
    let count = 0;
    for (let j = 0; j < perBar; j += 1) {
      const idx = i * perBar + j;
      if (idx >= binCount) break;
      sum += scratch[idx];
      count += 1;
    }
    const avg = count === 0 ? 0 : sum / count / 255;
    // Scale up because typical music produces 0.1..0.4 byte amplitudes
    // — multiplying by ~2.2 gives a satisfying full-range readout
    // without clipping at 1.
    out.push(Math.max(0.04, Math.min(1, avg * 2.2)));
  }
  return out;
}

/**
 * Convert a 12-band pitch envelope into normalized 0..1 bar heights,
 * scaled by the segment's peak loudness so quiet parts read as quiet.
 *
 * Pitch values come back as 0..1 already (Spotify normalizes them to
 * the strongest pitch in that segment), but loudness_max is in dB
 * (typically -60..0), so we convert to a rough 0..1 amplitude.
 */
function pitchesToBars(pitches: number[], loudnessMaxDb: number): Bars {
  const loudness = Math.max(0, Math.min(1, (loudnessMaxDb + 60) / 60));
  // Scale the bars by loudness so quiet segments produce shorter bars
  // even when the pitch envelope is fully populated (quiet chord).
  // Add a small floor so bars don't collapse entirely on near-silent
  // segments, which looks dead.
  const scale = Math.max(0.08, loudness);
  const out: Bars = [];
  for (let i = 0; i < BAR_COUNT; i += 1) {
    const p = pitches[i] ?? 0;
    out.push(Math.max(0.04, Math.min(1, p * scale)));
  }
  return out;
}
