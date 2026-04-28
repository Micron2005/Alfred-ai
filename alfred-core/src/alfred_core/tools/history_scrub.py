"""Scrub user-facing tool placeholders from past assistant replies.

Several chat tools (image generation, email, Spotify, archive
rollup) work by replacing a marker that the LLM emits — e.g.
``[GENERATE_IMAGE]…[/GENERATE_IMAGE]`` — with a short italic
parenthetical confirmation in the visible reply (e.g.
``_(Generated.)_``). That keeps the chat clean for the human:
they see a status line where the marker used to be, and the
actual side-effect (an image, a sent email) is rendered or
already happened.

The trouble is that the *next* turn's history reconstruction
copies the assistant's persisted ``content`` straight back into
the conversation passed to the LLM. So Alfred sees lines like
``_(Generated.)_`` in his own past replies. Once that happens
enough times, the model learns to *type that placeholder as
prose* on a future turn — claiming an image was generated
without actually emitting the marker, leaving the user with no
image and a falsely-confident apology like "There you are, sir."

We mitigate it by stripping the placeholder substrings from
assistant content before replaying as history. The visible
reply persisted in the DB is unchanged — what the human saw on
that earlier turn still reads exactly as it did. We only scrub
the copy that goes back to the model on subsequent turns.

The pattern is narrow on purpose: ``_( ... )_`` (markdown italic
+ parens, no nested parens). Every status confirmation in the
codebase uses this shape, and it doesn't collide with normal
prose — Alfred's voice virtually never uses italicised
parenthetical asides.
"""

from __future__ import annotations

import re

# Match a single ``_( ... )_`` placeholder. The body uses lazy
# ``.*?`` so that two adjacent placeholders match separately
# rather than as one big span. We can't use ``[^)]*`` here
# because some real placeholders contain nested parens — e.g.
# ``_(I couldn't draw that — couldn't reach the service
# (ConnectError))_`` — and the cheap version would stop at the
# first inner ``)``, leaving the outer ``)_`` behind. Lazy
# matching with ``re.DOTALL`` handles both nesting and the rare
# multi-line placeholder (archive-rollup).
_STATUS_PLACEHOLDER = re.compile(r"_\(.*?\)_", re.DOTALL)


def scrub_assistant_content(content: str) -> str:
    """Remove tool-status placeholders from a stored assistant reply.

    The visible-reply text persisted in the DB is not modified;
    this returns a fresh string suitable for use as
    ``ChatMessage.content`` when rebuilding the conversation
    that gets sent to the LLM.

    Behaviour:
    - All ``_( ... )_`` italic-parenthetical placeholders are
      removed.
    - Adjacent whitespace from the removed segment is collapsed
      so we don't leave double-spaces or stranded blank lines.
    - The result is stripped of leading/trailing whitespace.
      If scrubbing leaves the message empty (e.g. the assistant
      reply was *only* a status placeholder), the empty string
      is returned. The caller is responsible for providing a
      structural fallback in that case (the chat handler
      substitutes ``[no reply]`` to keep the alternating-role
      structure valid).
    """

    without_markers = _STATUS_PLACEHOLDER.sub("", content)
    # Collapse runs of two or more newlines that the substitution
    # may have created (placeholder on its own line, nothing
    # left). Single newlines and other whitespace are left alone
    # so prose paragraphs still read naturally.
    collapsed = re.sub(r"\n{3,}", "\n\n", without_markers)
    # Collapse runs of two-or-more spaces left behind when an
    # inline placeholder was removed mid-sentence.
    collapsed = re.sub(r"[ \t]{2,}", " ", collapsed)
    return collapsed.strip()
