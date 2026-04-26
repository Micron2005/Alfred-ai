"""Direct tests for ``_run_search_loop``.

Goal: prove that ``[REMEMBER:]`` markers emitted in *intermediate*
tool-call replies don't get silently dropped (regression caught by
Devin Review on PR #13). We mock the LLM and the Tavily client and
drive the loop end-to-end.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import httpx
import pytest

from alfred_core.api import chat as chat_module
from alfred_core.config import Settings
from alfred_core.llm.base import ChatMessage, ChatResponse
from alfred_core.tools import web_search as ws


class _ScriptedRouter:
    """Returns canned replies in order, so we can play out a tool loop."""

    def __init__(self, replies: list[str]) -> None:
        self._replies = list(replies)
        self.calls: list[list[ChatMessage]] = []

    async def complete(self, msgs: list[ChatMessage]) -> ChatResponse:
        # Deep-enough copy: we only inspect roles/contents in tests.
        self.calls.append([ChatMessage(role=m.role, content=m.content) for m in msgs])
        if not self._replies:
            raise AssertionError("router ran out of scripted replies")
        return ChatResponse(
            content=self._replies.pop(0),
            backend="local",
            model="test-model",
        )


@pytest.fixture
def patched_router(monkeypatch: pytest.MonkeyPatch) -> Callable[[list[str]], _ScriptedRouter]:
    def _install(replies: list[str]) -> _ScriptedRouter:
        scripted = _ScriptedRouter(replies)
        monkeypatch.setattr(chat_module, "_llm_router", scripted)
        return scripted

    return _install


@pytest.fixture
def stub_tavily(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make every Tavily call return a single canned result."""

    def _handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "answer": "Swift 6.1 is the latest release as of 2026.",
                "results": [
                    {
                        "title": "Swift Releases",
                        "url": "https://swift.org/releases",
                        "content": "Swift 6.1 was released on…",
                    }
                ],
            },
        )

    real_async_client = httpx.AsyncClient

    class _PatchedAsyncClient(real_async_client):  # type: ignore[misc, valid-type]
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            kwargs["transport"] = httpx.MockTransport(_handler)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(ws.httpx, "AsyncClient", _PatchedAsyncClient)


@pytest.mark.asyncio
async def test_remember_in_intermediate_reply_survives(
    patched_router: Callable[[list[str]], _ScriptedRouter],
    stub_tavily: None,
) -> None:
    """A [REMEMBER:] alongside [SEARCH:] in the *first* reply must persist."""
    patched_router(
        [
            # First turn: model decides to search AND records a fact.
            "Let me check, sir.\n"
            "[REMEMBER: He is switching from Python to Swift.]\n"
            "[SEARCH: latest Swift version 2026]",
            # Second turn (after results fed back): final answer, no markers.
            "Swift 6.1 is the latest, sir (swift.org/releases).",
        ]
    )

    settings = Settings(alfred_tavily_api_key="test")
    msgs = [
        ChatMessage(role="system", content="persona"),
        ChatMessage(role="user", content="I'm switching to Swift — what's the latest version?"),
    ]

    outcome = await chat_module._run_search_loop(msgs, settings)

    # The fact would otherwise have been silently dropped.
    assert outcome.collected_facts == [
        "He is switching from Python to Swift."
    ]
    # The visible reply is the final one, with markers stripped.
    assert "Swift 6.1 is the latest" in outcome.visible_reply
    assert "[SEARCH:" not in outcome.visible_reply
    assert "[REMEMBER:" not in outcome.visible_reply
    # Sources from the search are surfaced.
    assert any(s.url == "https://swift.org/releases" for s in outcome.sources)


@pytest.mark.asyncio
async def test_intermediate_reply_in_history_is_clean(
    patched_router: Callable[[list[str]], _ScriptedRouter],
    stub_tavily: None,
) -> None:
    """The cleaned intermediate reply (no markers) is what's fed back to the model."""
    scripted = patched_router(
        [
            "Standby.\n[REMEMBER: prefers concise replies]\n[SEARCH: weather NYC today]",
            "Sunny and 72, sir.",
        ]
    )

    settings = Settings(alfred_tavily_api_key="test")
    msgs = [
        ChatMessage(role="system", content="persona"),
        ChatMessage(role="user", content="What's the weather in NYC?"),
    ]

    await chat_module._run_search_loop(msgs, settings)

    # Two LLM calls: initial + post-search.
    assert len(scripted.calls) == 2
    # The history seen by the second call should contain the *cleaned*
    # intermediate assistant turn (no [REMEMBER:], no [SEARCH:]) plus
    # the synthetic search-results user turn.
    second_history = scripted.calls[1]
    assistant_turns = [m for m in second_history if m.role == "assistant"]
    assert len(assistant_turns) == 1
    assert "[REMEMBER:" not in assistant_turns[0].content
    assert "[SEARCH:" not in assistant_turns[0].content
    assert "Standby." in assistant_turns[0].content
    # The last user turn should be the synthetic search-results block.
    last_user = [m for m in second_history if m.role == "user"][-1]
    assert "[SEARCH_RESULTS for 'weather NYC today']" in last_user.content


@pytest.mark.asyncio
async def test_loop_caps_iterations(
    patched_router: Callable[[list[str]], _ScriptedRouter],
    stub_tavily: None,
) -> None:
    """A model that endlessly emits [SEARCH:] is force-stopped at the cap."""
    patched_router(
        [
            "[SEARCH: query 1]",
            "[SEARCH: query 2]",
            "[SEARCH: query 3]",  # would be a 3rd search; cap stops us before this runs
        ]
    )

    settings = Settings(alfred_tavily_api_key="test")
    msgs = [
        ChatMessage(role="system", content="persona"),
        ChatMessage(role="user", content="loop forever please"),
    ]

    outcome = await chat_module._run_search_loop(msgs, settings)

    # Loop ran twice (the cap), then returned the third reply as-is
    # with markers stripped — even though the model still wanted to
    # search again.
    assert outcome.visible_reply == ""  # only [SEARCH:] in it; everything stripped
    # Two searches ran (the cap); both return the same canned result so
    # dedup collapses them. The synthetic "Search summary" entry and
    # the real Swift Releases entry are both kept.
    assert {s.url for s in outcome.sources} == {"", "https://swift.org/releases"}
