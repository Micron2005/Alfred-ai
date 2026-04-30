"use client";

/**
 * Spotify3DView — full-screen JARVIS-style Spotify browser.
 *
 * Two halves:
 *   - LEFT: a giant rotating orb visualiser that pulses to whatever
 *     is now-playing (synthetic spectrum derived from playhead since
 *     Web Playback SDK streams are DRM-locked from a real analyser).
 *   - RIGHT: a real Spotify browser:
 *       • Connect button if the account isn't linked yet
 *       • Search box (catalog-wide) + results list
 *       • The user's playlists in a scrollable rail
 *       • Click a playlist → its tracks load below
 *       • Click a track → it plays via the existing /api/spotify/play
 *         endpoint on the user's active device (transferable to the
 *         in-browser Web Playback SDK via the HUD widget if desired).
 *
 * The old local-file EQ has been retired — it didn't actually map to
 * "use my Spotify". Streamed audio is DRM-locked so EQ-on-stream is
 * impossible from the browser; the user just wants the 3D view to be
 * an extension of their Spotify library.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type SpotifyPlaylistSummary,
  type SpotifyStatus,
  type SpotifyTrack,
  type SpotifyTrackSummary,
  getNowPlaying,
  getSpotifyStatus,
  listSpotifyPlaylistTracks,
  listSpotifyPlaylists,
  nextSpotifyTrack,
  pauseSpotify,
  playSpotify,
  playSpotifyUri,
  previousSpotifyTrack,
  searchSpotifyTracks,
  startSpotifyAuth,
} from "@/lib/spotify";

interface Spotify3DViewProps {
  onBack: () => void;
}

const BAR_COUNT = 32;
const POLL_MS = 5000;

type Tab = "playlists" | "search";

export function Spotify3DView({ onBack }: Spotify3DViewProps) {
  // ─── Connection / now-playing state ─────────────────────────────
  const [status, setStatus] = useState<SpotifyStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [track, setTrack] = useState<SpotifyTrack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ─── Browser state ──────────────────────────────────────────────
  const [tab, setTab] = useState<Tab>("playlists");
  const [playlists, setPlaylists] = useState<SpotifyPlaylistSummary[] | null>(
    null,
  );
  const [activePlaylist, setActivePlaylist] =
    useState<SpotifyPlaylistSummary | null>(null);
  const [playlistTracks, setPlaylistTracks] = useState<
    SpotifyTrackSummary[] | null
  >(null);
  const [tracksLoading, setTracksLoading] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<
    SpotifyTrackSummary[] | null
  >(null);
  const [searching, setSearching] = useState(false);

  // ─── Status fetch + post-OAuth bounce handler ───────────────────
  const refreshStatus = useCallback(async () => {
    try {
      const next = await getSpotifyStatus();
      setStatus(next);
      setStatusError(null);
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setStatusError(message);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    const params = new URLSearchParams(window.location.search);
    if (params.get("spotify_linked") === "1") {
      params.delete("spotify_linked");
      const search = params.toString();
      const next = `${window.location.pathname}${search ? `?${search}` : ""}`;
      window.history.replaceState({}, "", next);
      void refreshStatus();
    }
  }, [refreshStatus]);

  // ─── Playlist + now-playing fetching once linked ────────────────
  useEffect(() => {
    if (!status?.linked) return;
    let cancelled = false;
    void (async () => {
      try {
        const resp = await listSpotifyPlaylists(50, 0);
        if (cancelled) return;
        setPlaylists(resp.items);
        // eslint-disable-next-line no-console
        console.info(
          `[spotify3d] loaded ${resp.items.length} playlists`,
        );
      } catch (exc) {
        if (cancelled) return;
        const message = exc instanceof Error ? exc.message : String(exc);
        // eslint-disable-next-line no-console
        console.error("[spotify3d] listPlaylists failed:", exc);
        setError(`Couldn't load playlists: ${message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status?.linked]);

  useEffect(() => {
    if (!status?.linked) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const result = await getNowPlaying();
        if (cancelled) return;
        setTrack(result);
      } catch {
        // Silent — surfaces via the connect-state error if anything's
        // genuinely wrong, otherwise it's just transient.
      }
    };
    void tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [status?.linked]);

  // ─── Actions ────────────────────────────────────────────────────
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

  const openPlaylist = useCallback(async (pl: SpotifyPlaylistSummary) => {
    setActivePlaylist(pl);
    setPlaylistTracks(null);
    setTracksLoading(true);
    setError(null);
    try {
      const resp = await listSpotifyPlaylistTracks(pl.id, 100, 0);
      setPlaylistTracks(resp.items);
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(`Couldn't load playlist tracks: ${message}`);
    } finally {
      setTracksLoading(false);
    }
  }, []);

  // Debounced search — the user can type freely without spamming
  // Spotify on every keystroke.
  useEffect(() => {
    const q = searchQuery.trim();
    if (tab !== "search") return;
    if (!q) {
      setSearchResults(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const id = window.setTimeout(async () => {
      try {
        const resp = await searchSpotifyTracks(q, 30);
        if (cancelled) return;
        setSearchResults(resp.items);
        // eslint-disable-next-line no-console
        console.info(
          `[spotify3d] search "${q}" returned ${resp.items.length} tracks`,
        );
      } catch (exc) {
        if (cancelled) return;
        const message = exc instanceof Error ? exc.message : String(exc);
        // eslint-disable-next-line no-console
        console.error("[spotify3d] searchTracks failed:", exc);
        setError(`Search failed: ${message}`);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [searchQuery, tab]);

  const handlePlay = useCallback(
    async (uri: string) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await playSpotifyUri(uri);
        // Eager refresh so the orb caption updates without waiting
        // for the 5 s now-playing poll.
        try {
          const live = await getNowPlaying();
          setTrack(live);
        } catch {
          /* non-fatal */
        }
      } catch (exc) {
        const message = exc instanceof Error ? exc.message : String(exc);
        setError(
          message.toLowerCase().includes("premium")
            ? "Spotify Premium is required for playback. Browsing still works."
            : message,
        );
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const onTogglePlay = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (track?.is_playing) {
        await pauseSpotify();
        setTrack({ ...track, is_playing: false });
      } else {
        await playSpotify();
      }
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
    } finally {
      setBusy(false);
    }
  }, [busy, track]);

  const onNext = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await nextSpotifyTrack();
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const onPrev = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await previousSpotifyTrack();
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
    } finally {
      setBusy(false);
    }
  }, [busy]);

  // ─── Synthetic visualiser bars ──────────────────────────────────
  // DRM blocks any real analyser tap on Web Playback SDK output, so
  // we synthesise a believable spectrum keyed to the track playhead.
  // Looks alive; doesn't lie about being reactive.
  const bars = useSyntheticBars(track);
  const avgEnergy =
    bars.length > 0 ? bars.reduce((s, v) => s + v, 0) / bars.length : 0;

  // ─── Render ─────────────────────────────────────────────────────

  return (
    <div
      data-testid="spotify-3d-view"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 8500,
        background:
          "radial-gradient(circle at 30% 40%, rgba(20,40,70,1) 0%, rgba(0,0,0,1) 70%)",
        display: "flex",
        flexDirection: "column",
        color: "var(--fg)",
      }}
    >
      <BackBar onBack={onBack} title="SPOTIFY · LIBRARY" />

      <div
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "1fr 480px",
          gap: 24,
          padding: "24px 36px 36px",
          minHeight: 0,
        }}
      >
        {/* LEFT — pulsing orb + now-playing caption */}
        <div
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          }}
        >
          <PulsingOrb energy={avgEnergy} track={track} />
          <SpectrumRing bars={bars} />
          {status?.linked ? (
            <TransportBar
              track={track}
              busy={busy}
              onTogglePlay={onTogglePlay}
              onNext={onNext}
              onPrev={onPrev}
            />
          ) : null}
        </div>

        {/* RIGHT — Spotify browser */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: 16,
            background: "rgba(8,14,24,0.55)",
            backdropFilter: "blur(8px)",
            boxShadow: "0 0 28px rgba(108,214,255,0.08)",
            minHeight: 0,
          }}
        >
          <div
            className="mono"
            style={{
              fontSize: 11,
              letterSpacing: 3,
              color: "var(--orb)",
              textShadow: "0 0 8px var(--orb-glow)",
            }}
          >
            {status?.linked
              ? `LIBRARY · ${status.display_name || "CONNECTED"}`
              : "LIBRARY"}
          </div>

          {/* Diagnostics pill — always shows the exact state of the
              Spotify integration so it's obvious why the library
              isn't loading. Pre-Feb-2026 the pane silently went
              blank when configured=false / linked=false, leaving
              the user guessing. */}
          <div
            data-testid="spotify-3d-debug"
            style={{
              fontSize: 10,
              color: "var(--muted)",
              letterSpacing: 1.2,
              fontFamily:
                'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
              padding: "4px 8px",
              border: "1px dashed var(--border)",
              borderRadius: 3,
              background: "rgba(108,214,255,0.04)",
            }}
          >
            STATE · configured:
            <span
              style={{
                color: status?.configured ? "rgb(110,230,160)" : "rgb(255,160,80)",
                fontWeight: 600,
              }}
            >
              {status === null ? "?" : status.configured ? "Y" : "N"}
            </span>{" "}
            linked:
            <span
              style={{
                color: status?.linked ? "rgb(110,230,160)" : "rgb(255,160,80)",
                fontWeight: 600,
              }}
            >
              {status === null ? "?" : status.linked ? "Y" : "N"}
            </span>
            {status?.user_id ? (
              <>
                {" "}
                user:<span style={{ color: "var(--orb)" }}>{status.user_id}</span>
              </>
            ) : null}
          </div>

          {!status && !statusError ? (
            <Hint text="Connecting to Spotify…" />
          ) : statusError ? (
            <Hint text={`Spotify status error: ${statusError}`} kind="error" />
          ) : !status?.configured ? (
            <Hint
              text="Spotify isn't configured on the backend. Set ALFRED_SPOTIFY_CLIENT_ID + ALFRED_SPOTIFY_CLIENT_SECRET in .env."
              kind="error"
            />
          ) : !status.linked ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 12,
                alignItems: "stretch",
              }}
            >
              <Hint text="No account linked yet. Connect your Spotify and your playlists, search, and transport will land here." />
              <button
                type="button"
                data-testid="spotify-3d-connect"
                className="hud-button hud-button--primary"
                onClick={onConnect}
                disabled={busy}
              >
                {busy ? "OPENING SPOTIFY…" : "🎵 CONNECT SPOTIFY"}
              </button>
            </div>
          ) : (
            <>
              <TabBar tab={tab} setTab={setTab} />
              {tab === "playlists" ? (
                <PlaylistsPane
                  playlists={playlists}
                  active={activePlaylist}
                  tracks={playlistTracks}
                  tracksLoading={tracksLoading}
                  onOpenPlaylist={openPlaylist}
                  onPlayTrack={handlePlay}
                  onBackToList={() => {
                    setActivePlaylist(null);
                    setPlaylistTracks(null);
                  }}
                  busy={busy}
                />
              ) : (
                <SearchPane
                  query={searchQuery}
                  onQueryChange={setSearchQuery}
                  searching={searching}
                  results={searchResults}
                  onPlayTrack={handlePlay}
                  busy={busy}
                />
              )}
            </>
          )}

          {error ? (
            <div
              data-testid="spotify-3d-error"
              style={{
                color: "var(--danger)",
                fontSize: 12,
                background: "rgba(255,80,80,0.06)",
                border: "1px solid rgba(255,80,80,0.3)",
                padding: 10,
                borderRadius: 3,
              }}
            >
              {error}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────

function BackBar({ onBack, title }: { onBack: () => void; title: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "12px 18px",
        borderBottom: "1px solid var(--border)",
        background: "rgba(8,14,24,0.85)",
        backdropFilter: "blur(10px)",
      }}
    >
      <button
        type="button"
        data-testid="subview-back"
        onClick={onBack}
        className="hud-button"
        aria-label="Back to JARVIS HUD"
      >
        ← BACK
      </button>
      <div
        className="mono"
        style={{
          fontSize: 12,
          letterSpacing: 4,
          color: "var(--orb)",
          textShadow: "0 0 8px var(--orb-glow)",
        }}
      >
        {title}
      </div>
    </div>
  );
}

function TabBar({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      <TabButton active={tab === "playlists"} onClick={() => setTab("playlists")} testId="spotify-3d-tab-playlists">
        PLAYLISTS
      </TabButton>
      <TabButton active={tab === "search"} onClick={() => setTab("search")} testId="spotify-3d-tab-search">
        SEARCH
      </TabButton>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={active ? "hud-button hud-button--primary" : "hud-button"}
      style={{ flex: 1, fontSize: 11, letterSpacing: 2 }}
    >
      {children}
    </button>
  );
}

function PlaylistsPane({
  playlists,
  active,
  tracks,
  tracksLoading,
  onOpenPlaylist,
  onPlayTrack,
  onBackToList,
  busy,
}: {
  playlists: SpotifyPlaylistSummary[] | null;
  active: SpotifyPlaylistSummary | null;
  tracks: SpotifyTrackSummary[] | null;
  tracksLoading: boolean;
  onOpenPlaylist: (pl: SpotifyPlaylistSummary) => void;
  onPlayTrack: (uri: string) => void;
  onBackToList: () => void;
  busy: boolean;
}) {
  if (active) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          minHeight: 0,
          flex: 1,
        }}
      >
        <button
          type="button"
          data-testid="spotify-3d-playlist-back"
          className="hud-button"
          onClick={onBackToList}
          style={{ alignSelf: "flex-start", fontSize: 10, letterSpacing: 2 }}
        >
          ← {active.name.toUpperCase()}
        </button>
        {tracksLoading ? (
          <Hint text="Loading tracks…" />
        ) : !tracks || tracks.length === 0 ? (
          <Hint text="This playlist is empty." />
        ) : (
          <ScrollList testId="spotify-3d-playlist-tracks">
            {tracks.map((t) => (
              <TrackRow
                key={`${t.uri}`}
                track={t}
                onPlay={() => onPlayTrack(t.uri)}
                disabled={busy || !t.is_playable}
              />
            ))}
          </ScrollList>
        )}
      </div>
    );
  }

  if (playlists === null) {
    return <Hint text="Loading your playlists…" />;
  }
  if (playlists.length === 0) {
    return <Hint text="You don't have any playlists yet." />;
  }
  return (
    <ScrollList testId="spotify-3d-playlists">
      {playlists.map((pl) => (
        <button
          key={pl.id}
          type="button"
          data-testid={`spotify-3d-playlist-${pl.id}`}
          onClick={() => onOpenPlaylist(pl)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "8px 10px",
            background: "transparent",
            border: "1px solid var(--border)",
            borderRadius: 4,
            cursor: "pointer",
            color: "var(--fg)",
            textAlign: "left",
            transition: "background 140ms ease, border-color 140ms ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(108,214,255,0.07)";
            e.currentTarget.style.borderColor = "var(--orb)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.borderColor = "var(--border)";
          }}
        >
          {pl.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={pl.image_url}
              alt=""
              width={44}
              height={44}
              style={{ borderRadius: 3, objectFit: "cover", flexShrink: 0 }}
            />
          ) : (
            <div
              style={{
                width: 44,
                height: 44,
                background: "rgba(108,214,255,0.08)",
                border: "1px solid var(--border)",
                borderRadius: 3,
                flexShrink: 0,
              }}
            />
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: 13,
                color: "var(--fg)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {pl.name}
            </div>
            <div
              style={{
                fontSize: 10,
                color: "var(--muted)",
                letterSpacing: 1,
                marginTop: 2,
              }}
            >
              {pl.track_count} TRACKS · {pl.owner}
            </div>
          </div>
        </button>
      ))}
    </ScrollList>
  );
}

function SearchPane({
  query,
  onQueryChange,
  searching,
  results,
  onPlayTrack,
  busy,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  searching: boolean;
  results: SpotifyTrackSummary[] | null;
  onPlayTrack: (uri: string) => void;
  busy: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minHeight: 0,
        flex: 1,
      }}
    >
      <input
        type="search"
        data-testid="spotify-3d-search-input"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search Spotify…"
        autoFocus
        style={{
          padding: "10px 12px",
          background: "rgba(8,14,24,0.7)",
          border: "1px solid var(--border)",
          borderRadius: 4,
          color: "var(--fg)",
          fontSize: 14,
          outline: "none",
          transition: "border-color 140ms ease, box-shadow 140ms ease",
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = "var(--orb)";
          e.currentTarget.style.boxShadow = "0 0 0 1px var(--orb), 0 0 14px var(--orb-glow)";
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = "var(--border)";
          e.currentTarget.style.boxShadow = "none";
        }}
      />
      {!query.trim() ? (
        <Hint text="Type a song, artist, album — anything in Spotify's catalog." />
      ) : searching ? (
        <Hint text="Searching…" />
      ) : !results || results.length === 0 ? (
        <Hint text="No tracks matched." />
      ) : (
        <ScrollList testId="spotify-3d-search-results">
          {results.map((t) => (
            <TrackRow
              key={t.uri}
              track={t}
              onPlay={() => onPlayTrack(t.uri)}
              disabled={busy || !t.is_playable}
            />
          ))}
        </ScrollList>
      )}
    </div>
  );
}

function TrackRow({
  track,
  onPlay,
  disabled,
}: {
  track: SpotifyTrackSummary;
  onPlay: () => void;
  disabled: boolean;
}) {
  const minutes = Math.floor(track.duration_ms / 60000);
  const seconds = Math.floor((track.duration_ms % 60000) / 1000)
    .toString()
    .padStart(2, "0");
  return (
    <button
      type="button"
      data-testid={`spotify-3d-track-${track.track_id || track.uri}`}
      onClick={onPlay}
      disabled={disabled}
      title={
        track.is_playable
          ? `Play ${track.title} — ${track.artists}`
          : "Local-file tracks can't be played from the Web API."
      }
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "6px 10px",
        background: "transparent",
        border: "1px solid var(--border)",
        borderRadius: 4,
        cursor: disabled ? "not-allowed" : "pointer",
        color: track.is_playable ? "var(--fg)" : "var(--muted)",
        opacity: track.is_playable ? 1 : 0.55,
        textAlign: "left",
        transition: "background 140ms ease, border-color 140ms ease",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = "rgba(108,214,255,0.07)";
        e.currentTarget.style.borderColor = "var(--orb)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.borderColor = "var(--border)";
      }}
    >
      {track.image_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={track.image_url}
          alt=""
          width={36}
          height={36}
          style={{ borderRadius: 2, objectFit: "cover", flexShrink: 0 }}
        />
      ) : (
        <div
          style={{
            width: 36,
            height: 36,
            background: "rgba(108,214,255,0.08)",
            borderRadius: 2,
            flexShrink: 0,
          }}
        />
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: 12,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {track.title || "—"}
        </div>
        <div
          style={{
            fontSize: 10,
            color: "var(--muted)",
            letterSpacing: 0.5,
            marginTop: 2,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {track.artists}
          {track.album ? ` · ${track.album}` : ""}
        </div>
      </div>
      <div
        style={{
          fontSize: 10,
          color: "var(--muted)",
          letterSpacing: 1,
          flexShrink: 0,
        }}
      >
        {minutes}:{seconds}
      </div>
    </button>
  );
}

function ScrollList({
  children,
  testId,
}: {
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        overflowY: "auto",
        flex: 1,
        paddingRight: 4,
      }}
    >
      {children}
    </div>
  );
}

function Hint({
  text,
  kind = "muted",
}: {
  text: string;
  kind?: "muted" | "error";
}) {
  return (
    <div
      style={{
        fontSize: 11,
        letterSpacing: 0.5,
        lineHeight: 1.6,
        color: kind === "error" ? "var(--danger)" : "var(--muted)",
        background:
          kind === "error" ? "rgba(255,80,80,0.06)" : "transparent",
        border:
          kind === "error" ? "1px solid rgba(255,80,80,0.3)" : "none",
        padding: kind === "error" ? "10px" : "8px 2px",
        borderRadius: 3,
      }}
    >
      {text}
    </div>
  );
}

interface PulsingOrbProps {
  energy: number;
  track: SpotifyTrack | null;
}

function PulsingOrb({ energy, track }: PulsingOrbProps) {
  const scale = 1 + energy * 0.18;
  const glow = 30 + energy * 80;
  const caption = track
    ? `${track.is_playing ? "▶ NOW PLAYING" : "❚❚ PAUSED"} · ${track.title} — ${track.artists}`
    : "NOTHING PLAYING — PICK A TRACK FROM THE LIBRARY";
  return (
    <div
      data-testid="spotify-3d-orb"
      style={{ position: "relative", width: 360, height: 360 }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          transform: `scale(${scale.toFixed(3)})`,
          background:
            "radial-gradient(circle at 50% 50%, rgba(108,214,255,0.0) 0%, rgba(108,214,255,0.08) 35%, rgba(108,214,255,0.22) 70%, rgba(108,214,255,0.55) 95%, rgba(108,214,255,0) 100%)",
          boxShadow: `inset 0 0 36px rgba(108,214,255,0.5), inset 8px 12px 28px rgba(255,255,255,0.18), inset -8px -12px 28px rgba(0,0,0,0.45), 0 0 ${glow}px var(--orb-glow), 0 0 ${glow * 2.4}px var(--orb-soft)`,
          transition: "transform 90ms ease-out, box-shadow 120ms ease-out",
          backdropFilter: "blur(2px)",
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: -40,
          borderRadius: "50%",
          border: "1px dashed rgba(108,214,255,0.4)",
          animation: "radial-spin-y 11000ms linear infinite",
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: -10,
          borderRadius: "50%",
          border: "1px dashed rgba(108,214,255,0.35)",
          transform: "rotateX(72deg)",
          animation: "radial-orbit 7000ms linear infinite",
        }}
      />
      {track?.image_url ? (
        // Album art at the orb's heart, dimmed so the glow still
        // dominates. Pulled from i.scdn.co; plain <img> is fine here.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={track.image_url}
          alt=""
          style={{
            position: "absolute",
            inset: "30%",
            width: "40%",
            height: "40%",
            borderRadius: "50%",
            objectFit: "cover",
            opacity: 0.7,
            filter: "saturate(0.85) blur(0.5px)",
            mixBlendMode: "screen",
          }}
        />
      ) : null}
      <div
        style={{
          position: "absolute",
          bottom: -54,
          left: "50%",
          transform: "translateX(-50%)",
          textAlign: "center",
          fontFamily:
            'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
          letterSpacing: 2,
          fontSize: 11,
          color: "var(--muted)",
          textTransform: "uppercase",
          whiteSpace: "nowrap",
          maxWidth: 720,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {caption}
      </div>
    </div>
  );
}

function SpectrumRing({ bars }: { bars: number[] }) {
  return (
    <div
      data-testid="spotify-3d-spectrum"
      aria-hidden
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
    >
      {bars.map((v, i) => {
        const angle = (i / bars.length) * 360;
        const len = 12 + v * 80;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: 4,
              height: len,
              transform: `translate(-50%, -100%) rotate(${angle}deg) translateY(-220px)`,
              transformOrigin: "center bottom",
              background:
                "linear-gradient(180deg, var(--orb) 0%, transparent 100%)",
              borderRadius: 2,
              opacity: 0.55 + v * 0.45,
              filter: "drop-shadow(0 0 6px var(--orb-glow))",
            }}
          />
        );
      })}
    </div>
  );
}

function TransportBar({
  track,
  busy,
  onTogglePlay,
  onNext,
  onPrev,
}: {
  track: SpotifyTrack | null;
  busy: boolean;
  onTogglePlay: () => void;
  onNext: () => void;
  onPrev: () => void;
}) {
  const isPlaying = !!track?.is_playing;
  return (
    <div
      style={{
        position: "absolute",
        bottom: 24,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        gap: 8,
        background: "rgba(8,14,24,0.7)",
        border: "1px solid var(--border)",
        borderRadius: 999,
        padding: "6px 10px",
        backdropFilter: "blur(8px)",
      }}
    >
      <button
        type="button"
        className="hud-button hud-button--icon"
        data-testid="spotify-3d-prev"
        onClick={onPrev}
        disabled={busy}
        aria-label="Previous track"
      >
        ⏮
      </button>
      <button
        type="button"
        className="hud-button hud-button--icon hud-button--primary"
        data-testid="spotify-3d-play-pause"
        onClick={onTogglePlay}
        disabled={busy}
        aria-label={isPlaying ? "Pause" : "Play"}
      >
        {isPlaying ? "⏸" : "▶"}
      </button>
      <button
        type="button"
        className="hud-button hud-button--icon"
        data-testid="spotify-3d-next"
        onClick={onNext}
        disabled={busy}
        aria-label="Next track"
      >
        ⏭
      </button>
    </div>
  );
}

// ─── Visualizer helpers ─────────────────────────────────────────────

/**
 * Synthesize a believable 32-bar spectrum keyed off the now-playing
 * playhead. We can't tap the SDK's audio (DRM), so this is purely a
 * visual flourish — but it stays in sync with playing/paused state
 * so the orb goes calm when the user pauses.
 */
function useSyntheticBars(track: SpotifyTrack | null): number[] {
  const [bars, setBars] = useState<number[]>(() =>
    Array(BAR_COUNT).fill(0.04),
  );
  // Stash the most recent track in a ref so the RAF loop reads live
  // play state without re-binding on every track tick.
  const trackRef = useRef<SpotifyTrack | null>(track);
  trackRef.current = track;

  // Persist a per-bar phase so the bank breathes consistently.
  const params = useMemo(() => {
    const phases: number[] = [];
    const tempos: number[] = [];
    const amps: number[] = [];
    for (let i = 0; i < BAR_COUNT; i++) {
      phases.push(i * 0.71);
      tempos.push(1.2 + (i / (BAR_COUNT - 1)) * 4.5);
      amps.push(0.55 + 0.35 * (1 - i / (BAR_COUNT - 1)));
    }
    return { phases, tempos, amps };
  }, []);

  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const loop = () => {
      const t = trackRef.current;
      const playing = !!t?.is_playing;
      if (!playing) {
        setBars(Array(BAR_COUNT).fill(0.04));
      } else {
        const elapsed = (performance.now() - start) / 1000;
        const breath = 0.7 + 0.3 * Math.sin(elapsed * 0.45);
        const next: number[] = [];
        for (let i = 0; i < BAR_COUNT; i++) {
          const tempo = params.tempos[i % params.tempos.length];
          const phase = params.phases[i % params.phases.length];
          const amp = params.amps[i % params.amps.length];
          const slow = 0.5 + 0.5 * Math.sin(elapsed * tempo + phase);
          const fast =
            0.5 + 0.5 * Math.sin(elapsed * tempo * 2.3 + phase * 1.7);
          const v = amp * slow * (0.55 + 0.45 * fast) * breath;
          next.push(Math.max(0.06, Math.min(1, v)));
        }
        setBars(next);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [params]);

  return bars;
}
