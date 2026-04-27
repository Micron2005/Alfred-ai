"""Parse ``[SPOTIFY_…]`` markers out of an LLM reply.

Marker forms (one per line; the marker itself is invisible to the user
once the chat handler strips it):

    [SPOTIFY_PLAY: <free-text query, e.g. "Bohemian Rhapsody by Queen">]
    [SPOTIFY_RESUME]
    [SPOTIFY_PAUSE]
    [SPOTIFY_NEXT]
    [SPOTIFY_PREV]
    [SPOTIFY_NOW]

The chat handler executes the action and replaces each marker with a
short confirmation line in the visible reply (e.g. ``_(Now playing:
Bohemian Rhapsody — Queen)_``). Errors are also folded into the visible
reply so Alfred can apologise gracefully rather than the chat 500ing.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum

# A single regex matches every marker shape and captures both the
# action keyword and the optional argument. Keeping it in one place
# makes it impossible to add a new marker on the prompt side and forget
# to update the parser.
_MARKER_RE = re.compile(
    r"\[SPOTIFY_(PLAY|RESUME|PAUSE|NEXT|PREV|NOW)(?:\s*:\s*([^\]]+))?\]",
    re.IGNORECASE,
)


class SpotifyAction(StrEnum):
    """All actions the LLM can request via a marker."""

    PLAY = "play"
    RESUME = "resume"
    PAUSE = "pause"
    NEXT = "next"
    PREV = "prev"
    NOW = "now"


@dataclass(frozen=True)
class SpotifyInvocation:
    """One marker the LLM emitted, with its argument (if any)."""

    action: SpotifyAction
    # ``query`` is only meaningful for PLAY (free-text song/artist
    # description). For the other actions it's an empty string.
    query: str
    # The full matched marker text including the brackets, so the chat
    # handler can do an exact ``str.replace`` to swap it for a
    # confirmation line.
    raw_match: str


def extract_invocations(reply: str) -> list[SpotifyInvocation]:
    """Return every well-formed Spotify marker inside ``reply``."""
    out: list[SpotifyInvocation] = []
    for match in _MARKER_RE.finditer(reply):
        keyword = match.group(1).lower()
        arg = (match.group(2) or "").strip()
        try:
            action = SpotifyAction(keyword)
        except ValueError:
            # Defensive — the regex only captures known keywords, so
            # this branch shouldn't fire. Skipping is safer than
            # crashing if it ever does.
            continue
        # PLAY without a query is treated as RESUME — common LLM mistake
        # (the model emits ``[SPOTIFY_PLAY]`` thinking "press play"
        # rather than "play this song"). Map it transparently so the
        # user's intent is honoured.
        if action is SpotifyAction.PLAY and not arg:
            action = SpotifyAction.RESUME
        out.append(
            SpotifyInvocation(action=action, query=arg, raw_match=match.group(0))
        )
    return out


def replace_marker(reply: str, invocation: SpotifyInvocation, replacement: str) -> str:
    """Substitute a single marker with a confirmation/error line."""
    return reply.replace(invocation.raw_match, replacement, 1)


def strip_markers(reply: str) -> str:
    """Strip every Spotify marker from ``reply``, leaving the prose."""
    return _MARKER_RE.sub("", reply).strip()
