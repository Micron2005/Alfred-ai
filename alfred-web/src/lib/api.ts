export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

export type Mode = "standard" | "nightfall";

export interface ChatMessageOut {
  id: string;
  role: "user" | "assistant";
  content: string;
  backend?: string | null;
  model?: string | null;
}

export interface ChatReply {
  conversation_id: string;
  mode: Mode;
  mode_changed: boolean;
  assistant: ChatMessageOut;
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

export async function getMode(): Promise<Mode> {
  const resp = await fetch(`${API_BASE}/mode`);
  if (!resp.ok) throw new Error("Could not fetch mode");
  const data = (await resp.json()) as { mode: Mode };
  return data.mode;
}

export async function setMode(mode: Mode): Promise<Mode> {
  const resp = await fetch(`${API_BASE}/mode`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!resp.ok) throw new Error("Could not set mode");
  const data = (await resp.json()) as { mode: Mode };
  return data.mode;
}
