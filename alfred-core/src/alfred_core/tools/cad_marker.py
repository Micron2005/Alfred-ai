"""Parse ``[CAD] ... [/CAD]`` markers (Phase 18a).

Marker format::

    [CAD]
    name: bracket
    notes: 30mm wide L-bracket with two 5mm holes
    script:
    difference() {
        cube([30, 20, 4]);
        translate([7, 10, -1]) cylinder(d=5, h=6);
        translate([23, 10, -1]) cylinder(d=5, h=6);
    }
    [/CAD]

Both ``name`` and ``notes`` are optional. Everything after the
``script:`` marker (or the entire block if ``script:`` is absent) is
treated as raw OpenSCAD source. The chat handler calls
``render_openscad`` on it and replaces the marker with a confirmation
line; the rendered STL + preview PNG are attached to the assistant
message's ``metadata_json``.

We only support the block form here. There is no inline shorthand —
real OpenSCAD scripts are always multi-line, and a one-liner form
would just encourage the LLM to inline a script that doesn't render.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Block form: ``[CAD]\n<body>\n[/CAD]``. Lazy match so successive
# markers in a single reply don't merge.
_BLOCK_RE = re.compile(
    r"\[CAD\](.*?)\[/CAD\]",
    re.DOTALL | re.IGNORECASE,
)
_NAME_RE = re.compile(r"^\s*name\s*:\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
_NOTES_RE = re.compile(r"^\s*notes?\s*:\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
# We use ``script:`` as an explicit delimiter between the optional
# header fields and the OpenSCAD body, because OpenSCAD has its own
# ``$``-prefixed special variables that look superficially like header
# lines (``$fn = 50;``) — without an explicit delimiter we'd be at
# risk of stripping legitimate code.
_SCRIPT_RE = re.compile(r"^\s*script\s*:\s*$", re.IGNORECASE | re.MULTILINE)


@dataclass(frozen=True)
class CadRequest:
    """One CAD-generation marker extracted from an LLM reply."""

    script: str
    name: str | None
    notes: str | None
    raw_match: str  # full marker including delimiters, for replacement


class CadMarkerError(ValueError):
    """Marker is malformed (empty script)."""


def _parse_inner(inner: str) -> tuple[str, str | None, str | None]:
    """Split a marker body into (script, name, notes).

    If ``script:`` is present, the body after it is the script and
    everything before is the header. Otherwise the entire block is
    treated as the script (so the LLM can use the marker informally
    without ceremony).
    """
    script_match = _SCRIPT_RE.search(inner)
    if script_match:
        header_section = inner[: script_match.start()]
        script = inner[script_match.end():].strip()
    else:
        header_section = ""
        script = inner.strip()

    name_match = _NAME_RE.search(header_section)
    notes_match = _NOTES_RE.search(header_section)
    name = name_match.group(1).strip() if name_match else None
    notes = notes_match.group(1).strip() if notes_match else None

    if not script:
        raise CadMarkerError("CAD marker has empty script body.")
    return script, name, notes


def extract_requests(reply: str) -> list[CadRequest]:
    """Return every well-formed CAD marker inside ``reply``."""
    out: list[CadRequest] = []
    for m in _BLOCK_RE.finditer(reply):
        try:
            script, name, notes = _parse_inner(m.group(1))
        except CadMarkerError:
            # Skip malformed markers — they'll just be left in the
            # visible text so the user can see Alfred goofed.
            continue
        out.append(
            CadRequest(
                script=script,
                name=name,
                notes=notes,
                raw_match=m.group(0),
            )
        )
    return out


def replace_marker(reply: str, request: CadRequest, replacement: str) -> str:
    """Substitute a single marker with a confirmation/error line."""
    return reply.replace(request.raw_match, replacement, 1)


def strip_markers(reply: str) -> str:
    """Strip every CAD marker from ``reply``, leaving the prose."""
    return _BLOCK_RE.sub("", reply).strip()
