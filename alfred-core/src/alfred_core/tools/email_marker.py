"""Parse ``[SEND_EMAIL] ... [/SEND_EMAIL]`` markers out of an LLM reply.

Marker format::

    [SEND_EMAIL]
    to: recipient@example.com
    subject: Brief subject line
    body:
    Body content,
    which may span multiple lines.
    [/SEND_EMAIL]

Alfred is instructed (in the persona prompt) to emit one of these only
**after** the user has confirmed the draft. The chat handler extracts
each marker, sends the email, and replaces the marker with a short,
human-readable confirmation line in the visible reply.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_BLOCK = re.compile(
    r"\[SEND_EMAIL\](.*?)\[/SEND_EMAIL\]",
    re.DOTALL | re.IGNORECASE,
)
_FIELD = re.compile(r"^\s*(to|subject)\s*:\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
_BODY_MARKER = re.compile(r"^\s*body\s*:\s*$", re.IGNORECASE | re.MULTILINE)


@dataclass(frozen=True)
class EmailDraft:
    to: str
    subject: str
    body: str
    raw_match: str  # the full matched marker including delimiters


class EmailMarkerError(ValueError):
    """Marker is malformed (missing required field or empty)."""


def _parse_inner(inner: str) -> tuple[str, str, str]:
    # Split header section (before `body:`) from body section so a line
    # in the body that happens to start with `to:` or `subject:` cannot
    # silently override the real header values.
    body_match = _BODY_MARKER.search(inner)
    header_section = inner[: body_match.start()] if body_match else inner
    body = inner[body_match.end():].strip() if body_match else ""

    fields: dict[str, str] = {
        m.group(1).lower(): m.group(2).strip()
        for m in _FIELD.finditer(header_section)
    }
    to = fields.get("to", "")
    subject = fields.get("subject", "")
    if not to or not subject or not body:
        raise EmailMarkerError(
            "SEND_EMAIL marker missing one of: to, subject, body."
        )
    return to, subject, body


def extract_drafts(reply: str) -> list[EmailDraft]:
    """Return every well-formed email draft inside ``reply``."""
    drafts: list[EmailDraft] = []
    for match in _BLOCK.finditer(reply):
        try:
            to, subject, body = _parse_inner(match.group(1))
        except EmailMarkerError:
            # Skip malformed markers — they'll just be left in the visible
            # text so the user can see Alfred goofed.
            continue
        drafts.append(
            EmailDraft(to=to, subject=subject, body=body, raw_match=match.group(0))
        )
    return drafts


def replace_marker(reply: str, draft: EmailDraft, replacement: str) -> str:
    """Substitute a single marker with a confirmation line."""
    return reply.replace(draft.raw_match, replacement, 1)
