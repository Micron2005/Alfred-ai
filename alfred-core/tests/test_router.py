"""Router logic: pick the right backend for the request."""

from __future__ import annotations

import pytest

from alfred_core.llm.base import ChatImage, ChatMessage, ChatResponse, LLMBackend
from alfred_core.router import Router, VisionUnavailableError


class _StubBackend(LLMBackend):
    def __init__(self, name: str) -> None:
        self.name = name

    async def complete(
        self, messages: list[ChatMessage], *, model: str | None = None
    ) -> ChatResponse:
        return ChatResponse(content="stub", model="stub", backend=self.name)


def _router(*, with_cloud: bool, use_cloud_for_coding: bool = True) -> Router:
    return Router(
        local=_StubBackend("local"),
        cloud=_StubBackend("cloud") if with_cloud else None,
        use_cloud_for_coding=use_cloud_for_coding,
    )


def test_non_coding_goes_local_when_cloud_available() -> None:
    r = _router(with_cloud=True)
    assert r.pick("what's the weather today, Alfred?").name == "local"


def test_coding_goes_cloud_when_enabled() -> None:
    r = _router(with_cloud=True)
    assert r.pick("refactor this Python function to use async").name == "cloud"
    assert r.pick("debug this stack trace").name == "cloud"
    assert r.pick("here's some code:\n```py\nprint(1)\n```").name == "cloud"


def test_coding_stays_local_when_cloud_disabled() -> None:
    r = _router(with_cloud=False)
    assert r.pick("refactor this Python function").name == "local"


def test_coding_stays_local_when_toggle_off() -> None:
    r = _router(with_cloud=True, use_cloud_for_coding=False)
    assert r.pick("refactor this Python function").name == "local"


def test_image_turn_routes_to_cloud_even_if_text_is_chatty() -> None:
    """Non-coding text would normally go local, but the presence of an image
    forces cloud routing — local Ollama chat models can't see images and we
    don't want to silently drop the attachment."""
    r = _router(with_cloud=True)
    assert r.pick("what's in this picture?", has_images=True).name == "cloud"


def test_image_turn_routes_to_cloud_even_if_coding_toggle_off() -> None:
    """The coding toggle controls coding routing, not vision routing."""
    r = _router(with_cloud=True, use_cloud_for_coding=False)
    assert r.pick("what's in this?", has_images=True).name == "cloud"


def test_image_turn_without_cloud_raises() -> None:
    """If there's no cloud backend, we'd rather fail loudly than pretend we
    can see the image. The chat endpoint maps this to a 503 with a helpful
    message about ANTHROPIC_API_KEY."""
    r = _router(with_cloud=False)
    with pytest.raises(VisionUnavailableError):
        r.pick("describe this", has_images=True)


@pytest.mark.asyncio
async def test_complete_inspects_last_user_message_for_images() -> None:
    """``complete`` should pull image-presence from the most recent user
    message, not from older messages or from assistant turns."""
    r = _router(with_cloud=True)
    history = [
        ChatMessage(role="user", content="here's a thing", images=[
            ChatImage(data="fake", mime_type="image/png"),
        ]),
        ChatMessage(role="assistant", content="I see a thing"),
        ChatMessage(role="user", content="now just tell me the time"),
    ]
    resp = await r.complete(history)
    # Last user message has no images, so should route local.
    assert resp.backend == "local"

    history.append(
        ChatMessage(role="user", content="and this one?", images=[
            ChatImage(data="fake2", mime_type="image/png"),
        ])
    )
    resp = await r.complete(history)
    assert resp.backend == "cloud"
