"""Local LLM backend: talks to an Ollama server over HTTP.

Ollama is the easiest path to a local model on Windows/WSL with an AMD GPU,
thanks to its Vulkan and ROCm builds. If you prefer a raw llama.cpp server,
its OpenAI-compatible endpoint works the same way — just point OLLAMA_HOST
at it.
"""

from __future__ import annotations

import httpx

from alfred_core.llm.base import ChatMessage, ChatResponse, LLMBackend


class OllamaBackend(LLMBackend):
    name = "ollama"

    def __init__(self, host: str, default_model: str) -> None:
        self._host = host.rstrip("/")
        self._default_model = default_model

    async def complete(
        self, messages: list[ChatMessage], *, model: str | None = None
    ) -> ChatResponse:
        chosen = model or self._default_model
        payload = {
            "model": chosen,
            "messages": [m.model_dump() for m in messages],
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
