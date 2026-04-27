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
  // Renders 12 bars driven by the current segment's pitch envelope,
  // smoothed against the previous frame so they don't pop. When no
  // analysis is available (or nothing is playing) the bars decay to
  // an idle floor.

  useEffect(() => {
    let raf = 0;
    let prev: Bars = Array(BAR_COUNT).fill(0.05);
    const idleFloor = 0.04;
    const smoothing = 0.6; // higher = smoother, less reactive
    const tick = () => {
      const analysis = analysisRef.current?.data;
      const { ms, capturedAt, isPlaying } = progressRef.current;
      // Estimate current track position in seconds: snapshot ms +
      // wall-clock delta since the snapshot, but only while playing.
      const elapsed = isPlaying
        ? (ms + (performance.now() - capturedAt)) / 1000
        : ms / 1000;
      let target: Bars;
      if (analysis && analysis.segments.length > 0 && isPlaying) {
        const seg = findSegment(analysis.segments, elapsed);
        target = pitchesToBars(seg.pitches, seg.loudness_max);
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
}

function NowPlaying({
  track,
  sdkState,
  isAlfredDevice,
  onPlayHere,
  onDisconnect,
  displayName,
  busy,
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
        {!isAlfredDevice ? (
          <button
            type="button"
            className="hud-button"
            onClick={onPlayHere}
            disabled={busy}
            title="Play through Alfred's in-browser device"
          >
            ▶ Here
          </button>
        ) : null}
        <button
          type="button"
          className="hud-button"
          onClick={onDisconnect}
          disabled={busy}
          title="Forget this Spotify account"
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
