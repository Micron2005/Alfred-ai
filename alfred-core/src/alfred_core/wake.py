"""Wake-phrase and mode-phrase matching.

In Phase 1 we only look at typed text. In Phase 4, the same rules will run on
speech-to-text output so voice commands feel identical to typed commands.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from alfred_core.persona import Mode

_ALFRED_NAME = re.compile(r"\balfred\b", re.IGNORECASE)

_ACTIVATE_NIGHTFALL = re.compile(
    r"\b(activate|engage|enable|initiate|begin)\b.{0,40}\bnightfall\s+protocol\b",
    re.IGNORECASE | re.DOTALL,
)
_DEACTIVATE_NIGHTFALL = re.compile(
    r"\b(deactivate|disable|end|stop|cancel|stand\s+down|exit)\b"
    r"(?:.{0,40}\bnightfall\s+protocol\b)?",
    re.IGNORECASE | re.DOTALL,
)


@dataclass
class WakeResult:
    """Outcome of checking a user message against Alfred's wake rules."""

    addressed: bool
    """True if the message contained the name 'Alfred' (any position)."""

    mode_change: Mode | None
    """A new mode if the user asked for one, else None."""


def analyze(text: str) -> WakeResult:
    """Inspect a raw user message for wake triggers and mode changes."""
    addressed = bool(_ALFRED_NAME.search(text))

    mode_change: Mode | None = None
    if _ACTIVATE_NIGHTFALL.search(text):
        mode_change = Mode.NIGHTFALL
    elif _DEACTIVATE_NIGHTFALL.search(text) and (
        "nightfall" in text.lower() or "stand down" in text.lower()
    ):
        mode_change = Mode.STANDARD

    return WakeResult(addressed=addressed, mode_change=mode_change)
