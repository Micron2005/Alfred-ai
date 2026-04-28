"""Local LLM backend: talks to an Ollama server over HTTP.

Ollama is the easiest path to a local model on Windows/WSL with an AMD GPU,
thanks to its Vulkan and ROCm builds. If you prefer a raw llama.cpp server,
its OpenAI-compatible endpoint works the same way — just point OLLAMA_HOST
at it.

A single ``OllamaBackend`` instance handles both text-only and
vision-capable models — the routing decision (which Ollama model to
talk to) is made by ``Router``, which constructs one backend per
configured model. We just translate ``ChatMessage`` (Pydantic, with
attached ``ChatImage``s) into Ollama's wire format, which expects
``images`` as a flat list of base64 strings on each message.
"""

from __future__ import annotations

from typing import Any

import httpx

from alfred_core.llm.base import ChatMessage, ChatResponse, LLMBackend


def _to_ollama_message(message: ChatMessage) -> dict[str, Any]:
    """Translate one ``ChatMessage`` into Ollama's ``/api/chat`` shape.

    Ollama expects each message to be ``{"role", "content", "images"?}``
    where ``images`` (when present) is a list of base64 strings —
    NOT data URIs and NOT objects. Our ``ChatMessage`` carries the
    base64 bytes inside ``ChatImage.data`` already (matches what the
    front end uploads), so we just project it down to the bare list.
    """

    out: dict[str, Any] = {
        "role": message.role,
        "content": message.content,
    }
    if message.images:
        out["images"] = [img.data for img in message.images]
    return out


class OllamaBackend(LLMBackend):
    name = "ollama"

    def __init__(self, host: str, default_model: str) -> None:
        self._host = host.rstrip("/")
        self._default_model = default_model

    async def complete(
        self, messages: list[ChatMessage], *, model: str | None = None
    ) -> ChatResponse:
        chosen = model or self._default_model
        payload: dict[str, Any] = {
            "model": chosen,
            "messages": [_to_ollama_message(m) for m in messages],
            "stream": False,
            "options": {
                # Sensible defaults for a chat assistant. Tunable later.
                "temperature": 0.7,
                "num_ctx": 8192,
            },
        }
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
            resp = await client.post(f"{self._host}/api/chat", json=payload)
            resp.raise_for_status()
            data = resp.json()

        content = data.get("message", {}).get("content", "").strip()
        return ChatResponse(content=content, model=chosen, backend=self.name)
