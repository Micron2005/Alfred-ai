"""Parse ``[GENERATE_IMAGE] ... [/GENERATE_IMAGE]`` markers (Phase 17).

Marker format::

    [GENERATE_IMAGE]
    A long, descriptive text-to-image prompt — possibly multi-line, may
    include style directives, references, and so on.
    [/GENERATE_IMAGE]

The chat handler extracts each marker, calls the image-generation
backend (Pollinations, free), and replaces the marker in the visible
reply with a short confirmation line. The generated PNGs are attached
to the assistant message's ``metadata_json["images"]`` so they
survive a page reload via the conversation history endpoint.

Single-line shorthand is also accepted for one-shot prompts::

    [GENERATE_IMAGE: a corgi wearing a tweed waistcoat, oil painting]

The block form is preferred for long prompts because the LLM tends to
break short single-line markers across lines and we'd lose half of
them. The single-line form exists so a quick "draw me X" doesn't
require ceremony.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Block form: ``[GENERATE_IMAGE]\n<prompt>\n[/GENERATE_IMAGE]``.
# Multi-line, lazy match so successive markers don't merge.
_BLOCK_RE = re.compile(
    r"\[GENERATE_IMAGE\](.*?)\[/GENERATE_IMAGE\]",
    re.DOTALL | re.IGNORECASE,
)
# Single-line form: ``[GENERATE_IMAGE: <prompt>]``.
# The closing bracket terminates the prompt; literal ``]`` is rare in
# image prompts, and an LLM that wants one can use the block form.
_INLINE_RE = re.compile(
    r"\[GENERATE_IMAGE\s*:\s*([^\]]+)\]",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ImageRequest:
    """One image-generation marker extracted from an LLM reply."""

    prompt: str
    # The full matched marker text including delimiters, so the chat
    # handler can ``str.replace`` it for a confirmation line in the
    # visible reply without disturbing the rest of the text.
    raw_match: str


class ImageMarkerError(ValueError):
    """Marker is malformed (empty prompt)."""


def extract_requests(reply: str) -> list[ImageRequest]:
    """Return every well-formed image-generation marker inside ``reply``.

    Both block and inline forms are extracted in document order. Empty
    prompts (e.g. ``[GENERATE_IMAGE: ]``) are silently skipped — they'd
    just produce a useless image.
    """

    # We collect (start_position, ImageRequest) pairs from each pass and
    # sort at the end so the returned list is in **document order**.
    # That matters because the chat handler iterates this list and only
    # honours the first ``_MAX_IMAGES_PER_TURN`` (2) requests — without
    # this sort, a later block marker could be honoured while an
    # earlier inline one is refused.
    found: list[tuple[int, ImageRequest]] = []
    block_spans: list[tuple[int, int]] = []

    def _is_inside_block(start: int, end: int) -> bool:
        return any(s <= start and end <= e for s, e in block_spans)

    # Block form first because it's anchored on tags — running it first
    # lets us safely exclude its inner text from the inline pass below
    # (otherwise an inline-looking sequence inside a block prompt would
    # be matched twice).
    for m in _BLOCK_RE.finditer(reply):
        prompt = m.group(1).strip()
        block_spans.append((m.start(), m.end()))
        if not prompt:
            continue
        found.append(
            (m.start(), ImageRequest(prompt=prompt, raw_match=m.group(0)))
        )

    for m in _INLINE_RE.finditer(reply):
        if _is_inside_block(m.start(), m.end()):
            continue
        prompt = m.group(1).strip()
        if not prompt:
            continue
        found.append(
            (m.start(), ImageRequest(prompt=prompt, raw_match=m.group(0)))
        )

    found.sort(key=lambda pair: pair[0])
    return [request for _, request in found]


def replace_marker(reply: str, request: ImageRequest, replacement: str) -> str:
    """Substitute a single marker with a confirmation/error line."""

    return reply.replace(request.raw_match, replacement, 1)


def strip_markers(reply: str) -> str:
    """Strip every image marker from ``reply``, leaving the prose."""

    stripped = _BLOCK_RE.sub("", reply)
    stripped = _INLINE_RE.sub("", stripped)
    return stripped.strip()
