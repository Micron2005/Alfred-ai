"""Image attachment validation for vision-capable chat turns.

The frontend hands us a list of base64-encoded images. We need to make
sure each one is actually an image (right mime type), actually decodable
(real bytes, not garbage), and not so big that it'll get us rate-limited
or rejected by Claude. Anything that fails one of those checks gets
rejected with a clear message — we never silently strip an image.
"""

from __future__ import annotations

import base64
import binascii

from pydantic import BaseModel

from alfred_core.llm.base import ChatImage

# Anthropic supports JPEG, PNG, GIF, WebP for vision input.
ALLOWED_MIME_TYPES: frozenset[str] = frozenset(
    {"image/jpeg", "image/png", "image/gif", "image/webp"}
)

# 5 MB per image (decoded). Generous for screenshots / phone photos,
# small enough to keep our request payloads reasonable.
MAX_IMAGE_BYTES: int = 5 * 1024 * 1024

# A handful per turn is plenty. Stops a runaway client from posting
# fifty images at us.
MAX_IMAGES_PER_TURN: int = 6


class ImageValidationError(ValueError):
    """Raised when an inbound image fails one of our sanity checks."""


class ImagePayload(BaseModel):
    """The wire shape clients send. Mirrors ``ChatImage`` but kept as a
    distinct type so the chat schema can validate inbound payloads
    without coupling its public API to the internal LLM contract."""

    data: str
    mime_type: str


def validate_images(payloads: list[ImagePayload]) -> list[ChatImage]:
    """Validate a list of inbound image payloads, returning normalised
    ``ChatImage`` objects ready for the LLM backend.

    Raises ``ImageValidationError`` on the first problem encountered —
    the caller is expected to map that to a 400 for the client.
    """
    if len(payloads) > MAX_IMAGES_PER_TURN:
        raise ImageValidationError(
            f"Too many images on one turn ({len(payloads)}); "
            f"the limit is {MAX_IMAGES_PER_TURN}."
        )
    cleaned: list[ChatImage] = []
    for index, payload in enumerate(payloads, start=1):
        cleaned.append(_validate_one(index, payload))
    return cleaned


def _validate_one(index: int, payload: ImagePayload) -> ChatImage:
    mime = payload.mime_type.strip().lower()
    if mime not in ALLOWED_MIME_TYPES:
        raise ImageValidationError(
            f"Image #{index} has unsupported type {payload.mime_type!r}. "
            f"Send one of: {sorted(ALLOWED_MIME_TYPES)}."
        )

    raw_data = payload.data.strip()
    # Some clients accidentally send the full data: URL prefix; tolerate
    # that gracefully so the user doesn't see a confusing rejection.
    if raw_data.startswith("data:"):
        _, _, after_comma = raw_data.partition(",")
        raw_data = after_comma

    try:
        decoded = base64.b64decode(raw_data, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ImageValidationError(
            f"Image #{index} isn't valid base64 ({exc})."
        ) from exc

    if not decoded:
        raise ImageValidationError(f"Image #{index} is empty after decoding.")

    if len(decoded) > MAX_IMAGE_BYTES:
        size_mb = len(decoded) / (1024 * 1024)
        max_mb = MAX_IMAGE_BYTES / (1024 * 1024)
        raise ImageValidationError(
            f"Image #{index} is {size_mb:.1f} MB; the limit is {max_mb:.0f} MB."
        )

    return ChatImage(data=raw_data, mime_type=mime)
