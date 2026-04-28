"""Anthropic Claude backend for hard coding / reasoning / vision tasks.

This is the only part of Alfred that leaves your home. You can disable it
entirely by leaving ANTHROPIC_API_KEY blank or setting USE_CLOUD_FOR_CODING
to false.

Vision lives here too: when a user message has images attached, we ship
them as Anthropic ``image`` content blocks alongside the text. This is
the only path Alfred has to actually *see* something today — local Ollama
chat models are text-only.
"""

from __future__ import annotations

from typing import Any, cast

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
            _to_anthropic_message(m)
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


def _to_anthropic_message(m: ChatMessage) -> MessageParam:
    """Convert one ChatMessage into Anthropic's MessageParam shape.

    Plain text messages stay as a string for compactness. Messages with
    images become a list of content blocks: every image first (Anthropic
    recommends image-before-text for best comprehension), then the text
    — but ONLY if the user actually typed something. Anthropic now
    400s on empty text blocks (``messages: text content blocks must
    be non-empty``), so for an image-only paste we just omit the text
    block entirely; the image alone is a valid Anthropic message.
    """
    if not m.images:
        return cast(MessageParam, {"role": m.role, "content": m.content})

    blocks: list[dict[str, Any]] = []
    for img in m.images:
        blocks.append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": img.mime_type,
                    "data": img.data,
                },
            }
        )
    text = (m.content or "").strip()
    if text:
        blocks.append({"type": "text", "text": text})
    return cast(MessageParam, {"role": m.role, "content": blocks})
