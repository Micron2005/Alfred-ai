"""Unit tests for the ``[SEARCH:]`` marker parser."""

from __future__ import annotations

from alfred_core.tools.search_marker import (
    extract_invocations,
    strip_markers,
)


def test_extract_single_marker() -> None:
    reply = "Let me check, sir.\n[SEARCH: current bitcoin price USD]"
    invocations = extract_invocations(reply)
    assert len(invocations) == 1
    assert invocations[0].query == "current bitcoin price USD"
    assert invocations[0].raw_match == "[SEARCH: current bitcoin price USD]"


def test_extract_no_marker() -> None:
    reply = "Cricket is not my strong suit, sir, but I believe India won."
    assert extract_invocations(reply) == []


def test_extract_multiple_markers_in_order() -> None:
    reply = "[SEARCH: weather in NYC]\nthen [SEARCH: weather in LA]"
    invocations = extract_invocations(reply)
    assert [i.query for i in invocations] == [
        "weather in NYC",
        "weather in LA",
    ]


def test_extract_ignores_empty_query() -> None:
    """An empty ``[SEARCH:]`` marker is not a usable invocation."""
    reply = "[SEARCH:   ]\n[SEARCH: real query]"
    invocations = extract_invocations(reply)
    assert [i.query for i in invocations] == ["real query"]


def test_extract_is_case_insensitive() -> None:
    """Models occasionally lowercase keywords. Don't punish that."""
    reply = "[search: latest swift release]"
    invocations = extract_invocations(reply)
    assert len(invocations) == 1
    assert invocations[0].query == "latest swift release"


def test_extract_rejects_multiline_query() -> None:
    """The marker is single-line by design — a newline ends it."""
    reply = "[SEARCH: weather\nin NYC]"
    assert extract_invocations(reply) == []


def test_strip_removes_all_markers() -> None:
    reply = (
        "Let me check, sir.\n"
        "[SEARCH: weather in Fredericksburg VA]\n"
        "Standby."
    )
    cleaned = strip_markers(reply)
    assert "[SEARCH:" not in cleaned
    assert "Let me check, sir." in cleaned
    assert "Standby." in cleaned


def test_strip_preserves_other_brackets() -> None:
    """Non-search markers (e.g. [REMEMBER:]) must be left alone."""
    reply = "Got it. [REMEMBER: he prefers tea over coffee]"
    cleaned = strip_markers(reply)
    assert "[REMEMBER:" in cleaned
