"""Common types and protocol for LLM backends."""

from __future__ import annotations

from typing import Literal, Protocol

from pydantic import BaseModel

Role = Literal["system", "user", "assistant"]


class ChatMessage(BaseModel):
    role: Role
    content: str


class ChatResponse(BaseModel):
    content: str
    model: str
    backend: str
    """Which backend produced this response, e.g. 'ollama' or 'anthropic'."""


class LLMBackend(Protocol):
    """Anything that can take a list of messages and return a reply."""

    name: str

    async def complete(self, messages: list[ChatMessage], *, model: str | None = None) -> ChatResponse:
        ...
