"""Anthropic Claude backend for hard coding / reasoning tasks.

This is the only part of Alfred that leaves your home. You can disable it
entirely by leaving ANTHROPIC_API_KEY blank or setting USE_CLOUD_FOR_CODING
to false.
"""

from __future__ import annotations

from anthropic import AsyncAnthropic
from anthropic.types import MessageParam

from alfred_core.llm.base import ChatMessage, ChatResponse, LLMBackend


class AnthropicBackend(LLMBackend):
    name = "anthropic"

    def __init__(self, api_key: str, default_model: str) -> None:
        self._client = AsyncAnthropic(api_key=api_key)
        self._default_model = default_model

    async def complete(
        self, messages: list[ChatMessage], *, model: str | None = None
    ) -> ChatResponse:
        chosen = model or self._default_model

        system_parts = [m.content for m in messages if m.role == "system"]
        convo: list[MessageParam] = [
            {"role": m.role, "content": m.content}
            for m in messages
            if m.role in ("user", "assistant")
        ]

        response = await self._client.messages.create(
            model=chosen,
            max_tokens=2048,
            system="\n\n".join(system_parts) if system_parts else "",
            messages=convo,
        )

        content_parts = [block.text for block in response.content if block.type == "text"]
        return ChatResponse(
            content="".join(content_parts).strip(),
            model=chosen,
            backend=self.name,
        )
