"""Tests for the Ollama-backed local LLM, with focus on image
(``ChatImage``) translation into Ollama's ``/api/chat`` shape.

The wire format for Ollama vision models is documented at
https://github.com/ollama/ollama/blob/main/docs/api.md#parameters-1 —
the relevant bit is that each message can carry an ``images`` array
of base64 strings (no ``data:`` prefix). We verify the translation
without actually hitting Ollama by patching ``httpx.AsyncClient.post``.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from alfred_core.llm.base import ChatImage, ChatMessage
from alfred_core.llm.local import OllamaBackend, _to_ollama_message


def test_to_ollama_message_text_only_omits_images() -> None:
    """Pure text turns must NOT carry an empty ``images: []`` —
    some Ollama versions reject that on text-only models."""

    out = _to_ollama_message(ChatMessage(role="user", content="hi"))
    assert out == {"role": "user", "content": "hi"}
    assert "images" not in out


def test_to_ollama_message_carries_image_data_through() -> None:
    msg = ChatMessage(
        role="user",
        content="what's this?",
        images=[
            ChatImage(data="AAAA", mime_type="image/png"),
            ChatImage(data="BBBB", mime_type="image/jpeg"),
        ],
    )
    out = _to_ollama_message(msg)
    assert out["role"] == "user"
    assert out["content"] == "what's this?"
    # Ollama wants a flat list of base64 strings, not the full
    # ``ChatImage`` objects with mime types.
    assert out["images"] == ["AAAA", "BBBB"]


@pytest.mark.asyncio
async def test_complete_sends_images_to_ollama(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End-to-end: a vision-bearing turn produces a request body
    Ollama would actually accept, with ``images`` populated."""

    captured: dict[str, Any] = {}

    class _StubResponse:
        def __init__(self) -> None:
            self.status_code = 200

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, Any]:
            return {"message": {"content": "I see a cat."}}

    class _StubClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        async def __aenter__(self) -> _StubClient:
            return self

        async def __aexit__(self, *args: Any) -> None:
            return None

        async def post(self, url: str, *, json: dict[str, Any]) -> _StubResponse:
            captured["url"] = url
            captured["body"] = json
            return _StubResponse()

    monkeypatch.setattr(httpx, "AsyncClient", _StubClient)

    backend = OllamaBackend(
        host="http://example:11434",
        default_model="llama3.2-vision:11b",
    )
    resp = await backend.complete(
        [
            ChatMessage(role="system", content="You are Alfred."),
            ChatMessage(
                role="user",
                content="describe this",
                images=[ChatImage(data="ZZZZ", mime_type="image/png")],
            ),
        ]
    )

    assert resp.content == "I see a cat."
    assert resp.model == "llama3.2-vision:11b"
    assert captured["url"] == "http://example:11434/api/chat"
    body = captured["body"]
    assert body["model"] == "llama3.2-vision:11b"
    # System message has no images and shouldn't get an ``images``
    # key (Ollama complains about empty arrays on text-only models).
    assert body["messages"][0] == {"role": "system", "content": "You are Alfred."}
    # User message must carry the image base64 through.
    assert body["messages"][1]["images"] == ["ZZZZ"]
