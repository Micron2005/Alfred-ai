"""Wake-phrase and mode-change detection tests."""

from __future__ import annotations

import pytest

from alfred_core.persona import Mode
from alfred_core.wake import analyze


@pytest.mark.parametrize(
    "text",
    [
        "Alfred",
        "Hey Alfred",
        "hi alfred",
        "Hello Alfred, what's the weather?",
        "What you up to, Alfred?",
        "alfred please dim the lights",
    ],
)
def test_name_is_detected_in_any_position(text: str) -> None:
    assert analyze(text).addressed is True


@pytest.mark.parametrize(
    "text",
    [
        "turn on the lights",
        "what's the weather",
        "play some music",
    ],
)
def test_name_absent(text: str) -> None:
    assert analyze(text).addressed is False


@pytest.mark.parametrize(
    "text",
    [
        "Alfred, activate Nightfall Protocol",
        "activate nightfall protocol",
        "Engage Nightfall Protocol, Alfred.",
        "Alfred, initiate Nightfall Protocol.",
        "begin Nightfall Protocol",
    ],
)
def test_activate_nightfall(text: str) -> None:
    assert analyze(text).mode_change is Mode.NIGHTFALL


@pytest.mark.parametrize(
    "text",
    [
        "Alfred, deactivate Nightfall Protocol",
        "deactivate nightfall protocol",
        "Alfred, stand down.",
        "stand down",
        "end Nightfall Protocol",
    ],
)
def test_deactivate_nightfall(text: str) -> None:
    assert analyze(text).mode_change is Mode.STANDARD


def test_unrelated_message_has_no_mode_change() -> None:
    assert analyze("Alfred, what time is it?").mode_change is None
