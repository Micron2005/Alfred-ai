"""Image generation via Pollinations.ai (Phase 17).

Pollinations is a free, no-API-key, public image-generation service
that fronts community Stable Diffusion / FLUX runtimes. We use it as
the default cloud backend so Alfred can produce images without the
user adding a paid OpenAI / Stability API key.

Trade-offs we accept by going with the free service:
- **Latency**: Pollinations queues globally, so a single image can
  take 5-30 seconds. We cap the timeout at ``_TIMEOUT_S`` and surface
  a graceful failure when it's exceeded — Alfred apologises rather
  than the chat turn 500ing.
- **Throughput**: there's no published rate limit, but we don't pound
  the API. The chat handler caps how many images a single reply can
  generate (see ``_MAX_REQUESTS_PER_TURN`` in ``chat.py``).
- **Quality**: roughly on par with FLUX-schnell — good enough for
  concept-art, mood-boards, "draw me an X" prompts. For accurate
  blueprints / engineering drawings the user will eventually want a
  proper CAD pipeline (Phase 16); this isn't that.
- **Privacy**: prompts are sent to a public service. We do not send
  any of the user's personal facts; only the prompt text Alfred chose
  to generate.

When the user has a GPU and asks to run image gen locally, this
module will gain a sibling local backend (Stable Diffusion via
``diffusers`` or ComfyUI) and a router to pick between them. For now
it's cloud-only.
"""

from __future__ import annotations

import asyncio
import urllib.parse
from dataclasses import dataclass

import httpx

# We hit the ``image.pollinations.ai`` endpoint, which returns the
# generated PNG bytes directly (no JSON envelope, no async polling).
# That keeps the code minimal — one GET, one response, done.
_POLLINATIONS_BASE = "https://image.pollinations.ai/prompt/"
# 60 s is generous; Pollinations usually returns inside 15 s, but a
# global queue spike has been observed to hit ~45 s. Anything beyond
# 60 s and we'd rather apologise than make the chat feel hung.
_TIMEOUT_S = 60.0
# Default output size. Pollinations will happily go up to 2048², but
# 1024² is plenty for the chat bubble (we render at 480 px max), and
# the smaller size is dramatically faster.
_DEFAULT_WIDTH = 1024
_DEFAULT_HEIGHT = 1024
# We always pass ``nologo=true`` so Pollinations doesn't superimpose
# its watermark across the bottom-right of every image.
_DEFAULT_QUERY: dict[str, str] = {
    "width": str(_DEFAULT_WIDTH),
    "height": str(_DEFAULT_HEIGHT),
    "nologo": "true",
    # ``private=true`` opts us out of the public feed Pollinations
    # shows on its homepage. Belt-and-braces — without it, prompts
    # could in principle be browsed by strangers (though scraped from
    # a firehose of millions, not searchable). We set it to keep
    # personal prompts off any public surface.
    "private": "true",
}

# Pollinations occasionally returns a transient error (connection
# reset, 5xx from the upstream, brief queue-stall) that clears on
# the very next request. Retrying once or twice eliminates almost
# all of those user-visible failures without meaningfully delaying
# real failures. We backoff briefly between attempts so we don't
# stampede the upstream when it's already stressed.
_MAX_ATTEMPTS = 3
_BACKOFF_S = 2.0


@dataclass(frozen=True)
class GeneratedImage:
    """One image produced by the cloud backend.

    ``data`` is the raw PNG bytes; the chat handler base64-encodes
    them when persisting to ``Message.metadata_json`` and returning
    them in the chat response.
    """

    prompt: str
    data: bytes
    mime_type: str = "image/png"


class ImageGenError(RuntimeError):
    """Raised when the image-generation backend failed.

    Always include a human-readable message — the chat handler folds
    it directly into the visible reply so Alfred can apologise
    coherently rather than emitting a stack trace.
    """


def _describe_exc(exc: BaseException) -> str:
    """Return a non-empty single-line description of ``exc``.

    Some httpx exceptions (notably bare ``ConnectError`` /
    ``RemoteProtocolError`` from a reset) carry an empty
    ``str()``. Falling back to the class name gives the user
    something diagnostic to read instead of an empty pair of
    parens in Alfred's apology.
    """

    text = str(exc).strip()
    if text:
        return text
    return type(exc).__name__


async def _fetch_once(url: str) -> httpx.Response:
    """Single Pollinations request. Raises on network/HTTP failure."""

    # ``follow_redirects=True`` is essential — ``image.pollinations.ai``
    # is CDN-fronted and routinely answers with a 302 to the actual
    # PNG payload. httpx defaulted to NOT following redirects from
    # 0.23 onwards, so without this flag the chat handler would see
    # an empty redirect body and surface "non-image response. Try
    # again." every single time.
    async with httpx.AsyncClient(
        timeout=_TIMEOUT_S, follow_redirects=True
    ) as client:
        return await client.get(url, params=_DEFAULT_QUERY)


def _is_retryable(response: httpx.Response) -> bool:
    """Whether an HTTP-level failure should trigger another attempt.

    5xx responses and 429 (rate-limit) are inherently transient and
    almost always clear on a retry. 4xx other than 429 are caller
    errors (bad prompt, banned content, etc.) and won't clear no
    matter how many times we ask.
    """

    if response.status_code == 429:
        return True
    return 500 <= response.status_code < 600


async def generate_image(prompt: str) -> GeneratedImage:
    """Generate one image from ``prompt`` and return its bytes.

    Pollinations encodes the prompt in the URL path, so we URL-encode
    it carefully. They accept a few thousand characters — well past
    anything an LLM would normally emit. Transient network and
    server errors are retried up to ``_MAX_ATTEMPTS`` times with a
    short backoff; non-retryable failures (bad prompt, content
    rejected, malformed body) surface immediately.
    """

    cleaned = prompt.strip()
    if not cleaned:
        raise ImageGenError("Image prompt is empty.")

    encoded_prompt = urllib.parse.quote(cleaned, safe="")
    url = _POLLINATIONS_BASE + encoded_prompt

    last_error: str | None = None

    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            response = await _fetch_once(url)
        except httpx.HTTPError as exc:
            last_error = (
                f"couldn't reach the image-generation service "
                f"({_describe_exc(exc)})"
            )
            if attempt < _MAX_ATTEMPTS:
                await asyncio.sleep(_BACKOFF_S)
                continue
            raise ImageGenError(last_error) from exc

        if response.status_code >= 400:
            # Pollinations surfaces errors as plain-text bodies, often a
            # one-liner like "queue full" or "model busy". Truncate to
            # keep the reply readable but include enough to diagnose.
            last_error = (
                f"image service returned HTTP {response.status_code}: "
                f"{response.text[:200]}"
            )
            if attempt < _MAX_ATTEMPTS and _is_retryable(response):
                await asyncio.sleep(_BACKOFF_S)
                continue
            raise ImageGenError(last_error)

        content_type = response.headers.get("content-type", "")
        body = response.content
        if not body or not content_type.startswith("image/"):
            # Defensive — if the upstream falls back to a JSON error body
            # without an HTTP error code, ``response.content`` will be
            # bytes that aren't a real image. Treat as transient and
            # retry; on final attempt, surface the error.
            last_error = "image service returned a non-image response."
            if attempt < _MAX_ATTEMPTS:
                await asyncio.sleep(_BACKOFF_S)
                continue
            raise ImageGenError(f"{last_error} Try again.")

        return GeneratedImage(
            prompt=cleaned,
            data=body,
            mime_type=content_type.split(";", 1)[0].strip() or "image/png",
        )

    # Defensive — the loop above always either returns or raises. This
    # branch should be unreachable, but covers mypy / future edits.
    raise ImageGenError(last_error or "image generation failed")
