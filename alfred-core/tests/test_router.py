"""Router logic: pick the right backend for the request."""

from __future__ import annotations

from alfred_core.llm.base import ChatMessage, ChatResponse, LLMBackend
from alfred_core.router import Router


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
