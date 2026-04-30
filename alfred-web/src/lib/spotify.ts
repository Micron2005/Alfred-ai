/**
 * Spotify integration — backend client + Web Playback SDK loader.
 *
 * The browser-side flow is:
 *
 *   1. ``getStatus()`` tells us whether Spotify is configured on the
 *      backend and whether the user has linked their account.
 *   2. ``startAuth()`` redirects the browser to Spotify's authorize URL
 *      (or just returns it if you'd rather click a link).
 *   3. After auth completes, the backend bounces back here with
 *      ``?spotify_linked=1`` so the SPA can refresh its status.
 *   4. ``loadWebPlayback()`` lazily loads the Spotify Web Playback SDK
 *      and registers Alfred as a Connect device.  The SDK calls back
 *      to the server for fresh access tokens whenever needed; the
 *      refresh token never leaves the server.
 */

import { API_BASE } from "@/lib/api";

export interface SpotifyStatus {
  /** Are server-side dev-app credentials present? */
  configured: boolean;
  /** Has the user completed the OAuth flow on this Alfred install? */
  linked: boolean;
  display_name: string;
  user_id: string;
}

export interface SpotifyTrack {
  track_id: string;
  title: string;
  artists: string;
  album: string;
  duration_ms: number;
  progress_ms: number;
  is_playing: boolean;
  track_url: string;
  image_url: string;
}

export interface SpotifyAudioAnalysisSegment {
  start: number;
  duration: number;
  /** 12-band spectral envelope, one value per pitch class (-100..0 dB-ish). */
  pitches: number[];
  /** Loudness peak of this segment (dB, typically -60..0). */
  loudness_max: number;
  /** Average loudness across the segment. */
  loudness_start: number;
}

export interface SpotifyAudioAnalysis {
  segments: SpotifyAudioAnalysisSegment[];
  beats: { start: number; duration: number; confidence: number }[];
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  // Always send the auth cookie. The frontend's password gate uses
  // an httpOnly cookie that browsers won't include on cross-origin
  // requests unless the call explicitly opts in. Without this flag,
  // every Spotify API call would be rejected with 401 the moment the
  // user enables auth — even though the existing SpotifyPlayer HUD
  // widget happens to work because it routes its calls through other
  // helpers that already include credentials. (The Spotify3DView
  // browse + search calls go through THIS helper, so they need it.)
  const merged: RequestInit = {
    credentials: "include",
    ...(init ?? {}),
  };
  const resp = await fetch(`${API_BASE}${path}`, merged);
  if (!resp.ok) {
    let detail = resp.statusText;
    try {
      const body = (await resp.json()) as { detail?: string };
      if (body?.detail) detail = body.detail;
    } catch {
      /* non-JSON body — keep the statusText */
    }
    throw new Error(`Spotify API ${resp.status}: ${detail}`);
  }
  // The now-playing endpoint returns ``null`` (raw JSON null) when
  // nothing is playing; the response is technically empty in that case,
  // so guard against undefined parses.
  const text = await resp.text();
  if (!text) return null as T;
  return JSON.parse(text) as T;
}

export function getSpotifyStatus(): Promise<SpotifyStatus> {
  return jsonFetch<SpotifyStatus>("/api/spotify/status");
}

/**
 * Kick off the OAuth flow.  Sends the browser to Spotify's authorize
 * URL; after the user accepts, Spotify bounces them to the backend
 * which then redirects back to ``returnTo`` with ``?spotify_linked=1``.
 */
export async function startSpotifyAuth(returnTo?: string): Promise<void> {
  const here = returnTo ?? window.location.href;
  const params = new URLSearchParams({ return_to: here });
  const resp = await jsonFetch<{ authorize_url: string }>(
    `/api/spotify/auth/start?${params.toString()}`,
  );
  window.location.href = resp.authorize_url;
}

export function disconnectSpotify(): Promise<{ deleted: boolean }> {
  return jsonFetch<{ deleted: boolean }>("/api/spotify/disconnect", {
    method: "DELETE",
  });
}

export function getNowPlaying(): Promise<SpotifyTrack | null> {
  return jsonFetch<SpotifyTrack | null>("/api/spotify/now-playing");
}

export function fetchAccessToken(): Promise<{ access_token: string }> {
  return jsonFetch<{ access_token: string }>("/api/spotify/access-token");
}

export function fetchAudioAnalysis(
  trackId: string,
): Promise<SpotifyAudioAnalysis> {
  return jsonFetch<SpotifyAudioAnalysis>(
    `/api/spotify/audio-analysis/${encodeURIComponent(trackId)}`,
  );
}

// ─── Library / playlist browsing (used by Spotify3DView) ─────────────

export interface SpotifyPlaylistSummary {
  id: string;
  name: string;
  uri: string;
  image_url: string;
  track_count: number;
  owner: string;
}

export interface SpotifyTrackSummary {
  track_id: string;
  uri: string;
  title: string;
  artists: string;
  album: string;
  duration_ms: number;
  image_url: string;
  is_playable: boolean;
}

export function listSpotifyPlaylists(
  limit = 50,
  offset = 0,
): Promise<{ items: SpotifyPlaylistSummary[] }> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  return jsonFetch<{ items: SpotifyPlaylistSummary[] }>(
    `/api/spotify/playlists?${params.toString()}`,
  );
}

export function listSpotifyPlaylistTracks(
  playlistId: string,
  limit = 100,
  offset = 0,
): Promise<{ items: SpotifyTrackSummary[] }> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  return jsonFetch<{ items: SpotifyTrackSummary[] }>(
    `/api/spotify/playlists/${encodeURIComponent(playlistId)}/tracks?${params.toString()}`,
  );
}

export function searchSpotifyTracks(
  query: string,
  limit = 20,
): Promise<{ items: SpotifyTrackSummary[] }> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return jsonFetch<{ items: SpotifyTrackSummary[] }>(
    `/api/spotify/search?${params.toString()}`,
  );
}

/**
 * Play a specific Spotify track URI on the user's active device
 * (or the in-browser SDK device when Alfred is HERE). Mirrors the
 * shape of the existing ``/api/spotify/play`` endpoint.
 */
export function playSpotifyUri(
  uri: string,
  deviceId?: string,
): Promise<{ played_uri: string | null }> {
  return jsonFetch<{ played_uri: string | null }>("/api/spotify/play", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uri, device_id: deviceId ?? null }),
  });
}

export function transferPlayback(
  deviceId: string,
  play = true,
): Promise<{ ok: boolean }> {
  return jsonFetch<{ ok: boolean }>("/api/spotify/transfer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_id: deviceId, play }),
  });
}

// ─── Manual transport controls ────────────────────────────────────────
//
// These mirror the chat-driven [SPOTIFY_PLAY] / [SPOTIFY_PAUSE] / …
// markers but go straight from the UI buttons to the backend. We hit
// the backend (rather than the Web Playback SDK directly) so the same
// transport works for tracks playing on a non-Alfred device — e.g.
// the user's phone.

export function playSpotify(): Promise<{ played_uri: string | null }> {
  return jsonFetch<{ played_uri: string | null }>("/api/spotify/play", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

export function pauseSpotify(): Promise<{ ok: boolean }> {
  return jsonFetch<{ ok: boolean }>("/api/spotify/pause", { method: "POST" });
}

export function nextSpotifyTrack(): Promise<{ ok: boolean }> {
  return jsonFetch<{ ok: boolean }>("/api/spotify/next", { method: "POST" });
}

export function previousSpotifyTrack(): Promise<{ ok: boolean }> {
  return jsonFetch<{ ok: boolean }>("/api/spotify/previous", {
    method: "POST",
  });
}

// ─── Web Playback SDK loader ─────────────────────────────────────────
//
// The SDK script is hosted on Spotify's CDN. We load it on demand so
// users who don't link Spotify never pay the bundle cost.

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: {
      Player: new (opts: SpotifyPlayerInit) => SpotifyPlayer;
    };
  }
}

interface SpotifyPlayerInit {
  name: string;
  getOAuthToken: (cb: (token: string) => void) => void;
  /** 0..1 starting volume. */
  volume?: number;
}

export interface SpotifyPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(event: "ready", cb: (state: { device_id: string }) => void): void;
  addListener(event: "not_ready", cb: (state: { device_id: string }) => void): void;
  addListener(event: "player_state_changed", cb: (state: SpotifyPlaybackState | null) => void): void;
  addListener(event: "initialization_error" | "authentication_error" | "account_error" | "playback_error", cb: (state: { message: string }) => void): void;
  removeListener(event: string): void;
  getCurrentState(): Promise<SpotifyPlaybackState | null>;
  setVolume(volume: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
}

export interface SpotifyPlaybackState {
  paused: boolean;
  position: number;
  duration: number;
  track_window: {
    current_track: {
      id: string;
      uri: string;
      name: string;
      album: { name: string; images: { url: string }[] };
      artists: { name: string }[];
    } | null;
  };
}

let sdkPromise: Promise<void> | null = null;

/**
 * Load the Spotify Web Playback SDK script exactly once and resolve
 * when the SDK has signalled it's ready. Subsequent calls reuse the
 * same promise.
 */
export function loadSpotifySdk(): Promise<void> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<void>((resolve, reject) => {
    if (window.Spotify) {
      resolve();
      return;
    }
    window.onSpotifyWebPlaybackSDKReady = () => {
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    script.onerror = () => {
      sdkPromise = null;
      reject(new Error("Failed to load Spotify Web Playback SDK"));
    };
    document.head.appendChild(script);
  });
  return sdkPromise;
}
