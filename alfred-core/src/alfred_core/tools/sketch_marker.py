"""Parse ``[SKETCH_…]`` markers out of an LLM reply.

The design pad (sketch pad) lives entirely in the browser, so unlike
Spotify or email these markers are not executed server-side. The chat
handler extracts them, swaps each for a short confirmation line in the
visible reply, and returns the parsed commands to the frontend inside
the ``ChatReply`` so the React side can apply them to the canvas.

Marker forms (one per line; the marker itself is invisible to the user
once the chat handler strips it):

    [SKETCH_OPEN]                      open the design pad
    [SKETCH_CLOSE]                     close it
    [SKETCH_TOOL: pen]                 pencil | pen | marker | eraser
    [SKETCH_COLOR: #ff4d4d]            hex or a simple CSS colour name
    [SKETCH_BRUSH: 12]                 brush size, 1-64
    [SKETCH_LAYER_ADD: Shading]        add a layer (name optional)
    [SKETCH_LAYER_SELECT: Shading]     make a layer active (by name)
    [SKETCH_UNDO]
    [SKETCH_REDO]
    [SKETCH_CLEAR]                     clear the ACTIVE layer only
    [SKETCH_ANALYZE]                   look at the sketch (vision turn)

``[SKETCH_ANALYZE]`` is the odd one out: it is handled inside the LLM
loop (the system re-prompts the model with a snapshot image of the
pad), not forwarded to the frontend.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum

# One regex matches every marker shape and captures both the action
# keyword and the optional argument, mirroring the Spotify parser —
# a single source of truth means the prompt side and the parser can't
# drift apart silently.
_MARKER_RE = re.compile(
    r"\[SKETCH_"
    r"(OPEN|CLOSE|TOOL|COLOR|BRUSH|LAYER_ADD|LAYER_SELECT|UNDO|REDO|CLEAR|ANALYZE)"
    r"(?:\s*:\s*([^\]]*))?\]",
    re.IGNORECASE,
)

# The only tools the canvas implements. Anything else the model dreams
# up ("crayon", "airbrush") gets a polite refusal instead of a command.
VALID_TOOLS: frozenset[str] = frozenset({"pencil", "pen", "marker", "eraser"})

# Brush size bounds, mirrored in the frontend slider.
MIN_BRUSH = 1
MAX_BRUSH = 64


class SketchAction(StrEnum):
    """All actions the LLM can request via a sketch marker."""

    OPEN = "open"
    CLOSE = "close"
    TOOL = "tool"
    COLOR = "color"
    BRUSH = "brush"
    LAYER_ADD = "layer_add"
    LAYER_SELECT = "layer_select"
    UNDO = "undo"
    REDO = "redo"
    CLEAR = "clear"
    ANALYZE = "analyze"


@dataclass(frozen=True)
class SketchInvocation:
    """One marker the LLM emitted, with its argument (if any)."""

    action: SketchAction
    # Meaningful for TOOL / COLOR / BRUSH / LAYER_ADD / LAYER_SELECT.
    # Empty string for the argument-less actions.
    value: str
    # Full matched marker text including brackets so the chat handler
    # can swap it for a confirmation with an exact ``str.replace``.
    raw_match: str


def extract_invocations(reply: str) -> list[SketchInvocation]:
    """Return every well-formed sketch marker inside ``reply``."""
    out: list[SketchInvocation] = []
    for match in _MARKER_RE.finditer(reply):
        keyword = match.group(1).lower()
        arg = (match.group(2) or "").strip()
        try:
            action = SketchAction(keyword)
        except ValueError:
            # Defensive — the regex only captures known keywords.
            continue
        out.append(
            SketchInvocation(action=action, value=arg, raw_match=match.group(0))
        )
    return out


def replace_marker(
    reply: str, invocation: SketchInvocation, replacement: str
) -> str:
    """Substitute a single marker with a confirmation/error line."""
    return reply.replace(invocation.raw_match, replacement, 1)


def strip_markers(reply: str) -> str:
    """Strip every sketch marker from ``reply``, leaving the prose."""
    return _MARKER_RE.sub("", reply).strip()


def confirmation_for(invocation: SketchInvocation) -> str:
    """The inline ``_( ... )_`` confirmation shown where the marker was.

    Only meaningful for actions that become frontend commands —
    ANALYZE is replaced by the chat handler with either nothing (the
    analysis itself is the reply) or an error line.
    """
    action = invocation.action
    value = invocation.value
    if action is SketchAction.OPEN:
        return "_(Design pad open.)_"
    if action is SketchAction.CLOSE:
        return "_(Design pad closed.)_"
    if action is SketchAction.TOOL:
        return f"_(Switched to the {value.lower()}.)_"
    if action is SketchAction.COLOR:
        return f"_(Colour set to {value}.)_"
    if action is SketchAction.BRUSH:
        return f"_(Brush size set to {value}.)_"
    if action is SketchAction.LAYER_ADD:
        if value:
            return f"_(Added layer \u201c{value}\u201d.)_"
        return "_(Added a new layer.)_"
    if action is SketchAction.LAYER_SELECT:
        return f"_(Layer \u201c{value}\u201d selected.)_"
    if action is SketchAction.UNDO:
        return "_(Undone.)_"
    if action is SketchAction.REDO:
        return "_(Redone.)_"
    if action is SketchAction.CLEAR:
        return "_(Active layer cleared.)_"
    return ""
