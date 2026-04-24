"""Auto-title generation for new conversations."""

from __future__ import annotations

from alfred_core.api.chat import _derive_title


def test_short_message_becomes_full_title() -> None:
    assert _derive_title("Hello Alfred") == "Hello Alfred"


def test_first_sentence_is_used_when_present() -> None:
    text = "What's the weather today? Also, remind me about my meeting."
    assert _derive_title(text) == "What's the weather today?"


def test_long_run_on_is_truncated_with_ellipsis() -> None:
    text = (
        "this is an extremely long opening message with no punctuation that "
        "keeps going well past any reasonable title length"
    )
    result = _derive_title(text)
    assert result.endswith("…")
    assert len(result) <= 80


def test_newlines_are_flattened() -> None:
    text = "Hi Alfred,\nI have a question about my calendar."
    result = _derive_title(text)
    assert "\n" not in result
    assert result.startswith("Hi Alfred,")


def test_empty_falls_back_to_default() -> None:
    assert _derive_title("   ") == "New conversation"
