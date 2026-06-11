/**
 * Desktop integration API helpers — voice-driven URL opening +
 * whitelisted file browsing.
 *
 * Mirrors the shape of other ``lib/*`` API helpers: each fn does a
 * single fetch + JSON-decode, throws Error on non-2xx with the
 * backend's ``detail`` message when present so the chat handler can
 * speak the failure aloud.
 */

import { API_BASE } from "@/lib/api";

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const merged: RequestInit = {
    credentials: "include",
    ...(init ?? {}),
  };
  const resp = await fetch(`${API_BASE}${path}`, merged);
  if (!resp.ok) {
    const detail = await resp.text();
    let message = `Desktop API ${resp.status}`;
    try {
      const parsed = JSON.parse(detail) as { detail?: string };
      if (parsed?.detail) message = parsed.detail;
    } catch {
      if (detail) message = detail.slice(0, 200);
    }
    throw new Error(message);
  }
  return (await resp.json()) as T;
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size_bytes: number;
  modified_ts: number;
}

export interface FileListResponse {
  path: string;
  entries: FileEntry[];
  truncated: boolean;
}

export interface FileReadResponse {
  path: string;
  content: string;
  truncated: boolean;
}

export function openUrlOnHost(url: string): Promise<{ opened: boolean }> {
  return jsonFetch<{ opened: boolean }>("/api/desktop/open-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

export function listDesktopFiles(path: string): Promise<FileListResponse> {
  return jsonFetch<FileListResponse>(
    `/api/desktop/files/list?path=${encodeURIComponent(path)}`,
  );
}

export function readDesktopFile(path: string): Promise<FileReadResponse> {
  return jsonFetch<FileReadResponse>(
    `/api/desktop/files/read?path=${encodeURIComponent(path)}`,
  );
}

export function getDesktopWhitelist(): Promise<string[]> {
  return jsonFetch<string[]>("/api/desktop/whitelist");
}

export interface DiagnosticEntry {
  path: string;
  exists: boolean;
  is_dir: boolean;
  readable: boolean;
}

export interface DiagnosticResponse {
  configured: boolean;
  in_container: boolean;
  entries: DiagnosticEntry[];
  fix_hint: string;
}

/**
 * Per-path readiness check for the desktop file-browser. The chat
 * handler calls this whenever a file request fails so the user
 * gets actionable feedback ("you need to mount ~/Documents into
 * docker-compose.yml") instead of a generic 404.
 */
export function getDesktopDiagnostics(): Promise<DiagnosticResponse> {
  return jsonFetch<DiagnosticResponse>("/api/desktop/diagnostics");
}

/**
 * Convert a free-form search query into a YouTube search URL. We
 * deliberately don't use the YouTube Data API — that requires a
 * key and quota tracking. The search results page works fine for
 * the "play me an Iron Man scene" intent.
 *
 * We tack on ``&autoplay=1`` so that when YouTube's UI honours it
 * (it does on some embeds + signed-in sessions with autoplay set),
 * the first result starts immediately. When YouTube ignores the
 * flag the user just sees a normal search-results page and clicks
 * the top video — graceful degradation.
 */
export function youtubeSearchUrl(query: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&autoplay=1`;
}

export function googleSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}
