export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

export type Mode = "standard" | "nightfall";

export interface ChatMessageOut {
  id: string;
  role: "user" | "assistant";
  content: string;
  backend?: string | null;
  model?: string | null;
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

export async function sendMessage(
  message: string,
  conversationId: string | null,
): Promise<ChatReply> {
  const resp = await fetch(`${API_BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      conversation_id: conversationId,
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Alfred is unreachable: ${resp.status} — ${detail}`);
  }
  return resp.json() as Promise<ChatReply>;
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
