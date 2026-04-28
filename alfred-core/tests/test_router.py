"""Router logic: pick the right backend for the request."""

from __future__ import annotations

import pytest

from alfred_core.llm.base import ChatImage, ChatMessage, ChatResponse, LLMBackend
from alfred_core.router import LLMUnavailableError, Router, VisionUnavailableError


class _StubBackend(LLMBackend):
    def __init__(self, name: str) -> None:
        self.name = name

    async def complete(
        self, messages: list[ChatMessage], *, model: str | None = None
    ) -> ChatResponse:
        return ChatResponse(content="stub", model="stub", backend=self.name)


def _router(
    *,
    with_cloud: bool,
    with_local: bool = True,
    with_local_vision: bool = False,
    use_cloud_for_coding: bool = True,
) -> Router:
    return Router(
        local=_StubBackend("local") if with_local else None,
        cloud=_StubBackend("cloud") if with_cloud else None,
        local_vision=_StubBackend("local-vision") if with_local_vision else None,
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


def test_image_turn_without_any_vision_backend_raises() -> None:
    """If neither local vision nor cloud is configured, fail loudly rather
    than silently dropping the attached image. Chat endpoint maps this to a
    503 with instructions to pull a local vision model OR set the
    Anthropic key."""
    r = _router(with_cloud=False, with_local_vision=False)
    with pytest.raises(VisionUnavailableError):
        r.pick("describe this", has_images=True)


def test_image_turn_prefers_local_vision_over_cloud() -> None:
    """When BOTH local vision and cloud are wired, prefer local — it's
    free, runs on the user's GPU, and doesn't leak the image to a
    third party. The user's stated preference is 'I'd rather not pay'."""
    r = _router(with_cloud=True, with_local_vision=True)
    assert (
        r.pick("what's in this picture?", has_images=True).name == "local-vision"
    )


def test_image_turn_uses_local_vision_when_no_cloud() -> None:
    """The whole point of Phase 17.5: vision works without an Anthropic key."""
    r = _router(with_cloud=False, with_local_vision=True)
    assert r.pick("describe this", has_images=True).name == "local-vision"


def test_image_turn_falls_back_to_cloud_when_no_local_vision() -> None:
    """Backward-compat path: if a user has the cloud key but never
    ``ollama pull``'d a vision model, vision still works via cloud."""
    r = _router(with_cloud=True, with_local_vision=False)
    assert r.pick("what's in this?", has_images=True).name == "cloud"


def test_local_vision_does_not_steal_text_only_turns() -> None:
    """A vision-capable backend shouldn't be picked for a plain-text turn
    — local chat model handles those (faster, no vision overhead)."""
    r = _router(with_cloud=True, with_local_vision=True)
    assert r.pick("what's the weather like?").name == "local"


def test_text_turn_falls_back_to_cloud_when_local_disabled() -> None:
    """``LOCAL_MODEL_CHAT=""`` disables local chat. With the cloud key
    set, every plain-text turn should now go to cloud rather than
    crashing or 404ing on a missing local model."""

    r = _router(with_cloud=True, with_local=False)
    assert r.pick("what's the weather like?").name == "cloud"
    assert r.pick("draw me a sunset").name == "cloud"


def test_coding_turn_uses_cloud_when_local_disabled() -> None:
    """Coding-flagged turns already prefer cloud; this just confirms we
    don't try to instantiate a local backend on the way through."""

    r = _router(with_cloud=True, with_local=False)
    assert r.pick("refactor this Python function").name == "cloud"


def test_text_turn_with_neither_local_nor_cloud_raises() -> None:
    """If neither local chat nor cloud is wired, fail loudly with a
    clear ``LLMUnavailableError`` rather than crashing on a None
    backend in the chat handler."""

    r = _router(with_cloud=False, with_local=False)
    with pytest.raises(LLMUnavailableError):
        r.pick("hello")


def test_image_turn_still_works_when_local_chat_disabled() -> None:
    """Disabling local chat must not affect vision routing — vision is
    its own independent backend."""

    r = _router(with_cloud=False, with_local=False, with_local_vision=True)
    assert r.pick("describe this", has_images=True).name == "local-vision"


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
