"""Unit tests for the ``[SPOTIFY_…]`` marker parser."""

from __future__ import annotations

from alfred_core.tools.spotify_marker import (
    SpotifyAction,
    extract_invocations,
    replace_marker,
    strip_markers,
)


def test_play_marker_with_query() -> None:
    reply = "Very good, sir. [SPOTIFY_PLAY: Bohemian Rhapsody by Queen]"
    invs = extract_invocations(reply)
    assert len(invs) == 1
    assert invs[0].action is SpotifyAction.PLAY
    assert invs[0].query == "Bohemian Rhapsody by Queen"
    assert invs[0].raw_match == "[SPOTIFY_PLAY: Bohemian Rhapsody by Queen]"


def test_pause_next_prev_now() -> None:
    reply = (
        "[SPOTIFY_PAUSE]\n"
        "[SPOTIFY_NEXT]\n"
        "[SPOTIFY_PREV]\n"
        "[SPOTIFY_NOW]"
    )
    invs = extract_invocations(reply)
    assert [i.action for i in invs] == [
        SpotifyAction.PAUSE,
        SpotifyAction.NEXT,
        SpotifyAction.PREV,
        SpotifyAction.NOW,
    ]


def test_argless_play_collapses_to_resume() -> None:
    """A bare ``[SPOTIFY_PLAY]`` is treated as resume."""
    invs = extract_invocations("[SPOTIFY_PLAY]")
    assert len(invs) == 1
    assert invs[0].action is SpotifyAction.RESUME


def test_resume_marker() -> None:
    invs = extract_invocations("[SPOTIFY_RESUME]")
    assert [i.action for i in invs] == [SpotifyAction.RESUME]


def test_case_insensitive() -> None:
    invs = extract_invocations("[spotify_play: foals]")
    assert len(invs) == 1
    assert invs[0].action is SpotifyAction.PLAY
    assert invs[0].query == "foals"


def test_no_markers() -> None:
    assert extract_invocations("Cricket is on tonight, sir.") == []


def test_replace_marker_swaps_to_confirmation() -> None:
    reply = "Very good. [SPOTIFY_PAUSE]"
    invs = extract_invocations(reply)
    out = replace_marker(reply, invs[0], "_(Paused.)_")
    assert "[SPOTIFY_" not in out
    assert "_(Paused.)_" in out


def test_strip_markers_keeps_prose() -> None:
    reply = "Skipping. [SPOTIFY_NEXT] Done."
    cleaned = strip_markers(reply)
    assert "[SPOTIFY_" not in cleaned
    assert "Skipping." in cleaned
    assert "Done." in cleaned
