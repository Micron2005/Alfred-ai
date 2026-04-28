"""Unit tests for the Pollinations image-generation client.

Network is mocked via ``httpx.MockTransport``. We verify:
- happy path returns image bytes
- transient network failures retry until a later attempt succeeds
- non-retryable HTTP status (400 — caller error) does NOT retry
- retryable HTTP status (5xx, 429) DOES retry
- empty exception messages get a non-empty class-name fallback
- backoff sleep is short / mockable so the suite stays fast
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import httpx
import pytest

from alfred_core.tools import image_gen


def _patched_async_client(
    monkeypatch: pytest.MonkeyPatch,
    handler: Callable[[httpx.Request], httpx.Response],
) -> None:
    """Swap ``httpx.AsyncClient`` for one that uses a MockTransport.

    ``image_gen`` instantiates a fresh ``httpx.AsyncClient`` per
    request, so we patch the symbol it imports and keep the rest
    of the call shape untouched.
    """

    real = httpx.AsyncClient

    class _Patched(real):  # type: ignore[misc, valid-type]
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            kwargs["transport"] = httpx.MockTransport(handler)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(
        "alfred_core.tools.image_gen.httpx.AsyncClient", _Patched
    )


@pytest.fixture(autouse=True)
def _no_real_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stub out the inter-attempt backoff so retry tests run fast."""

    async def _sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr("alfred_core.tools.image_gen.asyncio.sleep", _sleep)


@pytest.mark.asyncio
async def test_happy_path_returns_image_bytes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        # Sanity: prompt is URL-encoded into the path.
        assert "red%20apple" in str(request.url)
        return httpx.Response(
            200,
            content=b"\x89PNGfake",
            headers={"content-type": "image/png"},
        )

    _patched_async_client(monkeypatch, handler)
    image = await image_gen.generate_image("red apple")
    assert image.data == b"\x89PNGfake"
    assert image.mime_type == "image/png"
    assert image.prompt == "red apple"


@pytest.mark.asyncio
async def test_retries_on_transient_network_error_then_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.ConnectError("")
        return httpx.Response(
            200,
            content=b"\x89PNGok",
            headers={"content-type": "image/png"},
        )

    _patched_async_client(monkeypatch, handler)
    image = await image_gen.generate_image("a sunset")
    assert image.data == b"\x89PNGok"
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_gives_up_after_max_attempts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        raise httpx.ConnectError("connection reset")

    _patched_async_client(monkeypatch, handler)
    with pytest.raises(image_gen.ImageGenError) as excinfo:
        await image_gen.generate_image("a sunset")
    assert calls["n"] == image_gen._MAX_ATTEMPTS
    # The error message must not have empty parens.
    assert "()" not in str(excinfo.value)
    assert "connection reset" in str(excinfo.value)


@pytest.mark.asyncio
async def test_empty_exception_message_falls_back_to_class_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Bare httpx errors with no message used to surface as ``()`` in
    Alfred's apology. The diagnostic should now include the class
    name as a fallback."""

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.RemoteProtocolError("")

    _patched_async_client(monkeypatch, handler)
    with pytest.raises(image_gen.ImageGenError) as excinfo:
        await image_gen.generate_image("a tree")
    msg = str(excinfo.value)
    assert "()" not in msg
    assert "RemoteProtocolError" in msg


@pytest.mark.asyncio
async def test_5xx_is_retried(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] < 3:
            return httpx.Response(503, text="upstream busy")
        return httpx.Response(
            200,
            content=b"\x89PNGok",
            headers={"content-type": "image/png"},
        )

    _patched_async_client(monkeypatch, handler)
    image = await image_gen.generate_image("a tree")
    assert image.data == b"\x89PNGok"
    assert calls["n"] == 3


@pytest.mark.asyncio
async def test_429_is_retried(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, text="rate limit")
        return httpx.Response(
            200,
            content=b"\x89PNGok",
            headers={"content-type": "image/png"},
        )

    _patched_async_client(monkeypatch, handler)
    image = await image_gen.generate_image("a tree")
    assert image.data == b"\x89PNGok"
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_4xx_is_not_retried(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A 400 means the upstream rejected the prompt itself — retrying
    will never help. We surface immediately rather than waiting out
    two backoff sleeps for nothing."""

    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(400, text="content rejected")

    _patched_async_client(monkeypatch, handler)
    with pytest.raises(image_gen.ImageGenError) as excinfo:
        await image_gen.generate_image("forbidden prompt")
    assert calls["n"] == 1
    assert "HTTP 400" in str(excinfo.value)
    assert "content rejected" in str(excinfo.value)


@pytest.mark.asyncio
async def test_non_image_body_is_retried_then_surfaces(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Pollinations sometimes returns a JSON error body with a 200 —
    treat that as transient and retry. After max attempts surface a
    clear message."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=b'{"error": "queue full"}',
            headers={"content-type": "application/json"},
        )

    _patched_async_client(monkeypatch, handler)
    with pytest.raises(image_gen.ImageGenError) as excinfo:
        await image_gen.generate_image("anything")
    assert "non-image response" in str(excinfo.value)


@pytest.mark.asyncio
async def test_empty_prompt_raises_immediately(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(image_gen.ImageGenError) as excinfo:
        await image_gen.generate_image("   ")
    assert "empty" in str(excinfo.value).lower()
