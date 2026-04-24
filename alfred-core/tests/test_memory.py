"""Tests for the 'facts about the user' memory extractor."""

from __future__ import annotations

from alfred_core.memory import extract_and_strip


def test_single_remember_marker_is_extracted_and_stripped() -> None:
    reply = (
        "Very good, sir. I'll make a note of that.\n"
        "[REMEMBER: His favourite tea is Earl Grey.]"
    )
    visible, facts = extract_and_strip(reply)
    assert facts == ["His favourite tea is Earl Grey."]
    assert "[REMEMBER" not in visible
    assert visible == "Very good, sir. I'll make a note of that."


def test_multiple_remember_markers_are_all_extracted() -> None:
    reply = (
        "Noted, sir.\n"
        "[REMEMBER: His sister is named Amira.]\n"
        "I shall remember both.\n"
        "[REMEMBER: He considers Daniel a rival.]"
    )
    visible, facts = extract_and_strip(reply)
    assert facts == [
        "His sister is named Amira.",
        "He considers Daniel a rival.",
    ]
    assert "[REMEMBER" not in visible
    assert "Noted, sir." in visible
    assert "I shall remember both." in visible


def test_reply_with_no_markers_passes_through() -> None:
    reply = "A perfectly ordinary reply, sir."
    visible, facts = extract_and_strip(reply)
    assert facts == []
    assert visible == reply


def test_marker_is_case_insensitive() -> None:
    reply = "Fine. [remember: He prefers coffee to tea.]"
    visible, facts = extract_and_strip(reply)
    assert facts == ["He prefers coffee to tea."]
    assert "[remember" not in visible.lower()


def test_blank_lines_after_stripping_are_collapsed() -> None:
    reply = (
        "First line.\n\n"
        "[REMEMBER: X.]\n\n"
        "Second line."
    )
    visible, facts = extract_and_strip(reply)
    assert facts == ["X."]
    assert "\n\n\n" not in visible
