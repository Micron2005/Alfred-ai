export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

export type Mode = "standard" | "nightfall";

export interface ChatImage {
  /** Base-64 encoded bytes (no `data:` prefix). */
  data: string;
  /** IANA mime type, e.g. `image/png`. */
  mime_type: string;
}

export interface ChatMessageOut {
  id: string;
  role: "user" | "assistant";
  content: string;
  backend?: string | null;
  model?: string | null;
  images?: ChatImage[];
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
  const resp = await fetch(`${API_BASE}/conversations`);
  if (!resp.ok) throw new Error("Could not list conversations");
  const data = (await resp.json()) as { conversations: ConversationSummary[] };
  return data.conversations;
}

export async function getConversation(id: string): Promise<ConversationDetail> {
  const resp = await fetch(`${API_BASE}/conversations/${id}`);
  if (!resp.ok) throw new Error("Could not load conversation");
  return resp.json() as Promise<ConversationDetail>;
}

export async function deleteConversation(id: string): Promise<void> {
  const resp = await fetch(`${API_BASE}/conversations/${id}`, {
    method: "DELETE",
  });
  if (!resp.ok) throw new Error("Could not delete conversation");
}

export async function transcribeAudio(blob: Blob): Promise<string> {
  const form = new FormData();
  const ext = blob.type.includes("ogg") ? "ogg" : "webm";
  form.append("audio", blob, `clip.${ext}`);
  const resp = await fetch(`${API_BASE}/voice/stt`, {
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
