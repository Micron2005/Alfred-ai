"""Parse ``[SEARCH: query]`` markers out of an LLM reply.

Marker format::

    [SEARCH: <free-text query>]

Alfred is instructed (in the persona prompt) to emit one of these the
moment he realises the user is asking about live information he
doesn't reliably know — current events, prices, sports scores, "what's
the latest on X". The chat handler extracts every marker, runs the
search, feeds results back into the conversation as a synthetic
``[SEARCH_RESULTS]`` block, and re-prompts Alfred with the augmented
history. The visible reply only ever contains Alfred's *final*
answer (with sources cited); the marker itself is stripped.

Kept deliberately separate from ``email_marker.py`` because the two
markers have different shapes (single line vs multi-line block) and
different lifecycles (email is one-shot, search loops back to the
LLM with results in hand).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Single-line marker: ``[SEARCH: ...]`` up to and including the closing
# bracket. The query may contain anything except a literal ``]`` so we
# can match on a single line; multi-line queries are rejected (it's a
# search query, not a paragraph).
_MARKER = re.compile(r"\[SEARCH:\s*([^\]\n]+?)\s*\]", re.IGNORECASE)


@dataclass(frozen=True)
class SearchInvocation:
    """One ``[SEARCH: …]`` marker located in an LLM reply."""

    query: str
    raw_match: str  # the full ``[SEARCH: ...]`` substring, for replacement


def extract_invocations(reply: str) -> list[SearchInvocation]:
    """Return every well-formed search marker found in ``reply``.

    Markers are returned in the order they appear so the caller can
    surface them to the user in chronological order if needed.
    Duplicate queries (same query string, multiple markers) are
    preserved — if the model genuinely emitted two, run two; the
    caller is responsible for deduping if it cares.
    """
    invocations: list[SearchInvocation] = []
    for match in _MARKER.finditer(reply):
        query = match.group(1).strip()
        if not query:
            continue
        invocations.append(
            SearchInvocation(query=query, raw_match=match.group(0))
        )
    return invocations


def strip_markers(reply: str) -> str:
    """Remove every ``[SEARCH: ...]`` marker from a reply for display.

    Used when we want to surface intermediate "I'm searching now"
    output to the user without showing the literal tool-call syntax,
    or when stripping markers from a stored assistant turn before
    persisting it to the database.
    """
    return _MARKER.sub("", reply).rstrip()
