"""Unit tests for the Tavily-backed web_search tool.

Network is mocked via ``httpx.MockTransport``. We verify:
- the tool refuses to run when no API key is set,
- HTTP failures and 4xx/5xx responses turn into the right exception types,
- a successful Tavily payload is parsed into ranked ``SearchResult``s,
- the prompt-formatter renders results in a shape the LLM can read.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from alfred_core.config import Settings
from alfred_core.tools import web_search as ws


def _settings_with_key(key: str = "test-key") -> Settings:
    return Settings(alfred_tavily_api_key=key)


def _settings_without_key() -> Settings:
    return Settings(alfred_tavily_api_key="")


def _patched_client(monkeypatch: pytest.MonkeyPatch, handler: Any) -> None:
    """Swap ``httpx.AsyncClient`` for one whose transport we control."""

    real_async_client = httpx.AsyncClient

    class _PatchedAsyncClient(real_async_client):  # type: ignore[misc, valid-type]
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            kwargs["transport"] = httpx.MockTransport(handler)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(ws.httpx, "AsyncClient", _PatchedAsyncClient)


@pytest.mark.asyncio
async def test_unconfigured_raises() -> None:
    with pytest.raises(ws.WebSearchUnconfiguredError):
        await ws.web_search("anything", _settings_without_key())


@pytest.mark.asyncio
async def test_successful_response_parsed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["query"] == "wwdc 2026 keynote date"
        assert body["api_key"] == "test-key"
        return httpx.Response(
            200,
            json={
                "answer": "Apple's WWDC 2026 keynote is on June 8.",
                "results": [
                    {
                        "title": "WWDC26 — Apple Developer",
                        "url": "https://developer.apple.com/wwdc26/",
                        "content": "Join us for WWDC26, our annual …",
                    },
                    {
                        "title": "Apple announces WWDC 2026",
                        "url": "https://www.apple.com/newsroom/wwdc26/",
                        "content": "Apple today announced …",
                    },
                ],
            },
        )

    _patched_client(monkeypatch, handler)
    results = await ws.web_search(
        "wwdc 2026 keynote date",
        _settings_with_key(),
    )

    # Tavily's bundled "answer" comes through as a synthetic top entry.
    assert len(results) == 3
    assert results[0].title == "Search summary"
    assert "WWDC 2026" in results[0].snippet
    assert results[1].url == "https://developer.apple.com/wwdc26/"


@pytest.mark.asyncio
async def test_401_treated_as_misconfigured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"detail": "invalid key"})

    _patched_client(monkeypatch, handler)
    with pytest.raises(ws.WebSearchUnconfiguredError):
        await ws.web_search("anything", _settings_with_key("bad"))


@pytest.mark.asyncio
async def test_5xx_becomes_search_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="upstream is down")

    _patched_client(monkeypatch, handler)
    with pytest.raises(ws.WebSearchError):
        await ws.web_search("anything", _settings_with_key())


@pytest.mark.asyncio
async def test_network_failure_becomes_search_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("dns failure")

    _patched_client(monkeypatch, handler)
    with pytest.raises(ws.WebSearchError):
        await ws.web_search("anything", _settings_with_key())


@pytest.mark.asyncio
async def test_empty_query_returns_empty_without_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A whitespace-only query is a no-op, not a wasted API call."""
    called = {"n": 0}

    def handler(_: httpx.Request) -> httpx.Response:
        called["n"] += 1
        return httpx.Response(200, json={"results": []})

    _patched_client(monkeypatch, handler)
    results = await ws.web_search("   ", _settings_with_key())
    assert results == []
    assert called["n"] == 0


def test_format_for_prompt_renders_results() -> None:
    out = ws.format_for_prompt(
        "wwdc 2026",
        [
            ws.SearchResult(
                title="WWDC26", url="https://example.com/x", snippet="Snippet."
            ),
        ],
    )
    assert "[SEARCH_RESULTS for 'wwdc 2026']" in out
    assert "1. WWDC26 — https://example.com/x" in out
    assert "Snippet." in out
    assert "[/SEARCH_RESULTS]" in out


def test_format_for_prompt_handles_empty_results() -> None:
    out = ws.format_for_prompt("nothing-found", [])
    assert "[SEARCH_RESULTS for 'nothing-found']" in out
    assert "No usable results" in out
