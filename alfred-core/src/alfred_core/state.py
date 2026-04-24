"""In-process state: current persona mode.

Persisted to the database per-conversation in later phases. For Phase 1 we
keep a single global mode so the UI has something to bind to.
"""

from __future__ import annotations

from alfred_core.config import Settings, get_settings
from alfred_core.persona import Mode


class ModeState:
    def __init__(self, default: Mode) -> None:
        self._mode = default

    @property
    def mode(self) -> Mode:
        return self._mode

    def set(self, mode: Mode) -> None:
        self._mode = mode


def _default_mode(settings: Settings) -> Mode:
    try:
        return Mode(settings.alfred_default_mode.lower())
    except ValueError:
        return Mode.STANDARD


mode_state = ModeState(_default_mode(get_settings()))
