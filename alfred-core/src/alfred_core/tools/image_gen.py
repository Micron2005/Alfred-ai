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


async def generate_image(prompt: str) -> GeneratedImage:
    """Generate one image from ``prompt`` and return its bytes.

    Pollinations encodes the prompt in the URL path, so we URL-encode
    it carefully. They accept a few thousand characters — well past
    anything an LLM would normally emit.
    """

    cleaned = prompt.strip()
    if not cleaned:
        raise ImageGenError("Image prompt is empty.")

    encoded_prompt = urllib.parse.quote(cleaned, safe="")
    url = _POLLINATIONS_BASE + encoded_prompt

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            response = await client.get(url, params=_DEFAULT_QUERY)
    except httpx.HTTPError as exc:
        raise ImageGenError(
            f"couldn't reach the image-generation service ({exc})"
        ) from exc

    if response.status_code >= 400:
        # Pollinations surfaces errors as plain-text bodies, often a
        # one-liner like "queue full" or "model busy". Truncate to
        # keep the reply readable but include enough to diagnose.
        raise ImageGenError(
            f"image service returned HTTP {response.status_code}: "
            f"{response.text[:200]}"
        )

    content_type = response.headers.get("content-type", "")
    body = response.content
    if not body or not content_type.startswith("image/"):
        # Defensive — if the upstream falls back to a JSON error body
        # without an HTTP error code, ``response.content`` will be
        # bytes that aren't a real image. Don't store those.
        raise ImageGenError(
            "image service returned a non-image response. Try again."
        )

    return GeneratedImage(
        prompt=cleaned,
        data=body,
        mime_type=content_type.split(";", 1)[0].strip() or "image/png",
    )
