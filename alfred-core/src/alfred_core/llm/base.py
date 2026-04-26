"""Common types and protocol for LLM backends."""

from __future__ import annotations

from typing import Literal, Protocol

from pydantic import BaseModel, Field

Role = Literal["system", "user", "assistant"]


class ChatImage(BaseModel):
    """A single image attached to a user turn.

    ``data`` is the raw bytes of the image, base64-encoded with no
    ``data:`` prefix. ``mime_type`` is the IANA media type
    (e.g. ``image/png``). Backends that support vision lift these
    into their own multimodal request format; backends that don't
    are free to ignore them, but the chat router should not be
    handing them an image-bearing turn in the first place.
    """

    data: str
    mime_type: str


class ChatMessage(BaseModel):
    role: Role
    content: str
    images: list[ChatImage] = Field(default_factory=list)


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
