export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

/**
 * Default fetch options shared by every API client call.
 *
 * ``credentials: "include"`` is essential — Alfred's password gate
 * issues HTTP-only cookies and the browser will only send them on
 * cross-origin requests when the call explicitly opts in. (When the
 * gate is disabled the cookies just aren't there, so this is a
 * harmless no-op.)
 */
export const FETCH_DEFAULTS: RequestInit = {
  credentials: "include",
};

export type Mode = "standard" | "nightfall";

export interface ChatImage {
  /** Base-64 encoded bytes (no `data:` prefix). */
  data: string;
  /** IANA mime type, e.g. `image/png`. */
  mime_type: string;
}

export interface ChatSource {
  /** Human-readable title of the page (or "Search summary" for Tavily's
   * synthetic top entry). */
  title: string;
  /** Empty string for synthetic entries; otherwise a real http(s) URL. */
  url: string;
  /** Short snippet rendered beneath the title in the UI. */
  snippet: string;
}

export interface ChatMessageOut {
  id: string;
  role: "user" | "assistant";
  content: string;
  backend?: string | null;
  model?: string | null;
  images?: ChatImage[];
  /** Web pages Alfred consulted while answering this turn, if any. */
  sources?: ChatSource[];
  created_at?: string;
}

export interface ChatReply {
  conversation_id: string;
  mode: Mode;
  mode_changed: boolean;
  assistant: ChatMessageOut;
}

export interface ConversationSummary {
  id: string;
  title: string;
  mode: Mode;
  created_at: string;
  last_message_at: string | null;
  message_count: number;
}

export interface ConversationDetail {
  id: string;
  title: string;
  mode: Mode;
  created_at: string;
  messages: ChatMessageOut[];
}

export interface PresenceSignal {
  /** How many faces are visible in the camera at send time. */
  faces_visible: number;
}

export async function sendMessage(
  message: string,
  conversationId: string | null,
  images: ChatImage[] = [],
  presence: PresenceSignal | null = null,
): Promise<ChatReply> {
  const resp = await fetch(`${API_BASE}/chat`, {
    ...FETCH_DEFAULTS,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      conversation_id: conversationId,
      images,
      // Omit the field entirely (rather than sending null) when the
      // camera is off, so the backend's `PresenceSignal | None`
      // serializer treats it as "no observation" rather than
      // "observation: nothing".
      ...(presence ? { presence } : {}),
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    // Backend returns FastAPI's {detail: "..."} JSON shape on errors;
    // parse it for a clean error message rather than dumping the whole
    // body. Fall back to the raw text if it's not JSON.
    let cleanDetail = detail;
    try {
      const parsed = JSON.parse(detail) as { detail?: string };
      if (parsed.detail) cleanDetail = parsed.detail;
    } catch {
      /* leave detail as-is */
    }
    throw new Error(`Alfred is unreachable: ${resp.status} — ${cleanDetail}`);
  }
  return resp.json() as Promise<ChatReply>;
}

/** Read a File as base64 (no data: prefix) and return it alongside the mime. */
export async function readFileAsChatImage(file: File): Promise<ChatImage> {
  const data: string = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Could not read image"));
        return;
      }
      // FileReader.readAsDataURL gives "data:<mime>;base64,<payload>";
      // strip the prefix so the backend receives clean base64.
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image"));
    reader.readAsDataURL(file);
  });
  return { data, mime_type: file.type || "image/png" };
}

export async function listConversations(): Promise<ConversationSummary[]> {
  const resp = await fetch(`${API_BASE}/conversations`, FETCH_DEFAULTS);
  if (!resp.ok) throw new Error("Could not list conversations");
  const data = (await resp.json()) as { conversations: ConversationSummary[] };
  return data.conversations;
}

export async function getConversation(id: string): Promise<ConversationDetail> {
  const resp = await fetch(`${API_BASE}/conversations/${id}`, FETCH_DEFAULTS);
  if (!resp.ok) throw new Error("Could not load conversation");
  return resp.json() as Promise<ConversationDetail>;
}

export async function deleteConversation(id: string): Promise<void> {
  const resp = await fetch(`${API_BASE}/conversations/${id}`, {
    ...FETCH_DEFAULTS,
    method: "DELETE",
  });
  if (!resp.ok) throw new Error("Could not delete conversation");
}

/**
 * Persist the conversation's mode column. Used by the frontend's
 * "activate / deactivate nightfall protocol" intent handler — the
 * canned acknowledgement path bypasses the chat handler, so without
 * this the next ordinary message would re-read the conversation in
 * its OLD mode and silently flip the persona back. Best-effort:
 * surfaces failures via the returned promise but the caller can
 * decide whether to abort the local mode change on a failure.
 */
export async function setConversationMode(
  id: string,
  mode: Mode,
): Promise<void> {
  const resp = await fetch(`${API_BASE}/conversations/${id}/mode`, {
    ...FETCH_DEFAULTS,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Could not set conversation mode: ${resp.status} — ${detail}`);
  }
}

// ─── Long-term memory archive (Phase 12b) ──────────────────────────────

export interface MemoryNote {
  id: string;
  title: string;
  summary: string;
  key_facts: string[];
  decisions: string[];
  follow_ups: string[];
  source: string;
  source_conversation_id: string | null;
  markdown_filename: string;
  created_at: string;
  updated_at: string;
  /** Cosine similarity (0..1) when returned from a search. Absent for list/get. */
  similarity?: number | null;
}

export interface MemoryNoteList {
  notes: MemoryNote[];
  /** Container-side path where Markdown mirrors are written. The host
   * mount point is configured by ALFRED_MEMORY_HOST_PATH in the
   * compose file — surfaced here so the UI can show the user where
   * their notes live. */
  storage_path: string;
}

export async function listMemoryNotes(query?: string): Promise<MemoryNoteList> {
  const url = new URL(`${API_BASE}/memory`);
  if (query && query.trim()) url.searchParams.set("q", query.trim());
  const resp = await fetch(url.toString(), FETCH_DEFAULTS);
  if (!resp.ok) throw new Error("Could not list memory notes");
  return resp.json() as Promise<MemoryNoteList>;
}

export async function getMemoryNote(id: string): Promise<MemoryNote> {
  const resp = await fetch(`${API_BASE}/memory/${id}`, FETCH_DEFAULTS);
  if (!resp.ok) throw new Error("Could not load memory note");
  return resp.json() as Promise<MemoryNote>;
}

export interface MemoryNotePatch {
  title?: string;
  summary?: string;
  key_facts?: string[];
  decisions?: string[];
  follow_ups?: string[];
}

export async function updateMemoryNote(
  id: string,
  patch: MemoryNotePatch,
): Promise<MemoryNote> {
  const resp = await fetch(`${API_BASE}/memory/${id}`, {
    ...FETCH_DEFAULTS,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!resp.ok) throw new Error("Could not update memory note");
  return resp.json() as Promise<MemoryNote>;
}

export async function deleteMemoryNote(id: string): Promise<void> {
  const resp = await fetch(`${API_BASE}/memory/${id}`, {
    ...FETCH_DEFAULTS,
    method: "DELETE",
  });
  if (!resp.ok) throw new Error("Could not delete memory note");
}

export async function summarizeConversationToMemory(
  conversationId: string,
  title?: string,
): Promise<MemoryNote> {
  const resp = await fetch(`${API_BASE}/memory/summarize`, {
    ...FETCH_DEFAULTS,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_id: conversationId, title }),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    let cleanDetail = detail;
    try {
      const parsed = JSON.parse(detail) as { detail?: string };
      if (parsed.detail) cleanDetail = parsed.detail;
    } catch {
      /* leave as-is */
    }
    throw new Error(`Could not archive conversation: ${cleanDetail}`);
  }
  return resp.json() as Promise<MemoryNote>;
}

export async function transcribeAudio(blob: Blob): Promise<string> {
  const form = new FormData();
  const ext = blob.type.includes("ogg") ? "ogg" : "webm";
  form.append("audio", blob, `clip.${ext}`);
  const resp = await fetch(`${API_BASE}/voice/stt`, {
    ...FETCH_DEFAULTS,
    method: "POST",
    body: form,
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Transcription failed: ${resp.status} — ${detail}`);
  }
  const data = (await resp.json()) as { text: string };
  return data.text;
}

export async function synthesizeSpeech(text: string): Promise<Blob> {
  const resp = await fetch(`${API_BASE}/voice/tts`, {
    ...FETCH_DEFAULTS,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Speech synthesis failed: ${resp.status} — ${detail}`);
  }
  return resp.blob();
}
