"""Auto-title generation for new conversations."""

from __future__ import annotations

from alfred_core.api.chat import _derive_title


def test_short_message_becomes_full_title() -> None:
    assert _derive_title("Hello Alfred") == "Hello Alfred"


def test_first_sentence_is_used_when_present() -> None:
    text = "What's the weather today? Also, remind me about my meeting."
    assert _derive_title(text) == "What's the weather today?"


def test_earliest_punctuation_wins_across_types() -> None:
    # Bug-fix regression: an exclamation mark appearing earliest must win
    # even though "." is checked first in the code.
    text = "Help! I need to find this. Where is it?"
    assert _derive_title(text) == "Help!"


def test_leading_punctuation_does_not_hide_later_enders_of_same_type() -> None:
    # Bug-fix regression: ". " at index 0 must be skipped without
    # preventing discovery of later ". " boundaries in the same text.
    text = ". OK. Got it! Let me help."
    assert _derive_title(text) == ". OK."


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
