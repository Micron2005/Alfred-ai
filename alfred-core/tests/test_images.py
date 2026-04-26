"""Image attachment validation + Anthropic multimodal payload conversion."""

from __future__ import annotations

import base64

import pytest

from alfred_core.llm.anthropic_backend import _to_anthropic_message
from alfred_core.llm.base import ChatImage, ChatMessage
from alfred_core.tools.images import (
    MAX_IMAGE_BYTES,
    MAX_IMAGES_PER_TURN,
    ImagePayload,
    ImageValidationError,
    validate_images,
)

# A minimal valid PNG header (not a complete PNG, but enough bytes to
# not be rejected as empty and small enough not to trip the size limit).
_TINY_PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 16).decode("ascii")


def _payload(data: str, mime: str = "image/png") -> ImagePayload:
    return ImagePayload(data=data, mime_type=mime)


def test_validate_passes_through_clean_payload() -> None:
    out = validate_images([_payload(_TINY_PNG)])
    assert len(out) == 1
    assert out[0].mime_type == "image/png"
    assert out[0].data == _TINY_PNG


def test_validate_lowercases_mime_type() -> None:
    """Some clients send ``Image/PNG`` or similar; we accept and normalise."""
    out = validate_images([_payload(_TINY_PNG, "Image/PNG")])
    assert out[0].mime_type == "image/png"


def test_validate_strips_data_url_prefix() -> None:
    """Browsers' ``FileReader.readAsDataURL`` includes a ``data:…;base64,``
    prefix. We tolerate it rather than forcing the frontend to slice it."""
    prefixed = f"data:image/png;base64,{_TINY_PNG}"
    out = validate_images([_payload(prefixed)])
    assert out[0].data == _TINY_PNG


def test_validate_rejects_unsupported_mime() -> None:
    with pytest.raises(ImageValidationError) as exc_info:
        validate_images([_payload(_TINY_PNG, "image/bmp")])
    assert "unsupported type" in str(exc_info.value)


def test_validate_rejects_invalid_base64() -> None:
    with pytest.raises(ImageValidationError):
        validate_images([_payload("not!!!base64!!!")])


def test_validate_rejects_empty_decoded_payload() -> None:
    with pytest.raises(ImageValidationError):
        validate_images([_payload("")])


def test_validate_rejects_oversize_image() -> None:
    big = base64.b64encode(b"\x00" * (MAX_IMAGE_BYTES + 1)).decode("ascii")
    with pytest.raises(ImageValidationError) as exc_info:
        validate_images([_payload(big)])
    assert "limit" in str(exc_info.value)


def test_validate_rejects_too_many_images_per_turn() -> None:
    payloads = [_payload(_TINY_PNG)] * (MAX_IMAGES_PER_TURN + 1)
    with pytest.raises(ImageValidationError) as exc_info:
        validate_images(payloads)
    assert "Too many images" in str(exc_info.value)


def test_anthropic_text_only_message_stays_compact() -> None:
    """Plain text turns should round-trip as ``content: <str>`` to keep
    payloads small. We only switch to block form when images appear."""
    msg = ChatMessage(role="user", content="hello")
    out = _to_anthropic_message(msg)
    assert out["role"] == "user"
    assert out["content"] == "hello"


def test_anthropic_multimodal_puts_images_before_text() -> None:
    """Anthropic's docs recommend image-before-text ordering for best
    comprehension. The conversion mirrors that."""
    msg = ChatMessage(
        role="user",
        content="describe these",
        images=[
            ChatImage(data="aaa", mime_type="image/png"),
            ChatImage(data="bbb", mime_type="image/jpeg"),
        ],
    )
    out = _to_anthropic_message(msg)
    blocks = out["content"]
    assert isinstance(blocks, list)
    assert len(blocks) == 3  # 2 images + 1 text
    assert blocks[0]["type"] == "image"
    assert blocks[0]["source"]["media_type"] == "image/png"
    assert blocks[0]["source"]["data"] == "aaa"
    assert blocks[1]["type"] == "image"
    assert blocks[1]["source"]["media_type"] == "image/jpeg"
    assert blocks[2]["type"] == "text"
    assert blocks[2]["text"] == "describe these"


def test_anthropic_multimodal_keeps_empty_text_block() -> None:
    """Even if the user attached an image with no caption, we must keep a
    text block — Anthropic rejects messages whose final content is just
    images with no accompanying text intent."""
    msg = ChatMessage(
        role="user",
        content="",
        images=[ChatImage(data="aaa", mime_type="image/png")],
    )
    out = _to_anthropic_message(msg)
    blocks = out["content"]
    assert isinstance(blocks, list)
    assert blocks[-1] == {"type": "text", "text": ""}
