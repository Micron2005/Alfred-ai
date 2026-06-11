/**
 * Onshape API helpers for the Design3DView.
 *
 * All requests go through the backend proxy at ``/api/design/*`` —
 * we never sign Onshape requests in the browser because that would
 * leak the secret key. Same ``credentials: include`` pattern as the
 * Spotify lib so the auth cookie rides along.
 */

import { API_BASE } from "@/lib/api";

export interface OnshapeStatus {
  configured: boolean;
  api_base: string;
}

export interface OnshapeDocument {
  id: string;
  name: string;
  owner: string;
  modified_at: string;
  created_at: string;
  default_workspace_id: string;
  has_thumbnail: boolean;
}

export interface OnshapeElement {
  id: string;
  name: string;
  type: string;
  document_id: string;
  workspace_id: string;
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const merged: RequestInit = {
    credentials: "include",
    ...(init ?? {}),
  };
  const resp = await fetch(`${API_BASE}${path}`, merged);
  if (!resp.ok) {
    const detail = await resp.text();
    let message = `Onshape API ${resp.status}`;
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

export function getOnshapeStatus(): Promise<OnshapeStatus> {
  return jsonFetch<OnshapeStatus>("/api/design/status");
}

export function listOnshapeDocuments(
  query?: string,
  limit = 20,
  offset = 0,
): Promise<{ items: OnshapeDocument[] }> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (query && query.trim()) params.set("q", query.trim());
  return jsonFetch<{ items: OnshapeDocument[] }>(
    `/api/design/documents?${params.toString()}`,
  );
}

export function listOnshapeElements(
  documentId: string,
): Promise<{ items: OnshapeElement[] }> {
  return jsonFetch<{ items: OnshapeElement[] }>(
    `/api/design/documents/${encodeURIComponent(documentId)}`,
  );
}

/**
 * Returns a backend-proxied PNG URL the browser can drop straight
 * into ``<img src>``. The proxy keeps the Onshape secret server-side
 * and slaps a 5-min cache header so the same thumbnail isn't
 * re-fetched on every render.
 */
export function getOnshapeThumbnailUrl(
  documentId: string,
  size = "300x300",
): string {
  return `${API_BASE}/api/design/documents/${encodeURIComponent(
    documentId,
  )}/thumbnail?size=${encodeURIComponent(size)}`;
}

export function createOnshapeDocument(
  name: string,
): Promise<OnshapeDocument> {
  return jsonFetch<OnshapeDocument>("/api/design/documents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

/**
 * Build the Onshape web-app URL for a given document or element so
 * the user can click "Open in Onshape" and edit in the real CAD
 * app. We use the document's default workspace for now (the
 * elements view requires a workspace context anyway).
 */
export function buildOnshapeUrl(
  apiBase: string,
  documentId: string,
  workspaceId: string,
  elementId?: string,
): string {
  // ``apiBase`` is the API host (e.g. https://cad.onshape.com); the
  // browser host shares the same origin for the public Onshape
  // tenant. Enterprise tenants use the same host for both.
  const base = apiBase.replace(/\/+$/, "");
  let url = `${base}/documents/${documentId}/w/${workspaceId}`;
  if (elementId) url += `/e/${elementId}`;
  return url;
}
