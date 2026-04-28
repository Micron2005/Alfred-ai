"""Tests for the history-scrub helper.

Covers the placeholder shapes Alfred's chat tools actually emit
(image-gen, email, Spotify, archive rollup) plus a few defensive
edges (empty content, no placeholders, multi-line placeholders).
"""

from __future__ import annotations

from alfred_core.tools.history_scrub import scrub_assistant_content


def test_strips_image_gen_success_placeholder() -> None:
    raw = "_(Generated.)_\n\nTony Stark, in his finest tin suit."
    assert (
        scrub_assistant_content(raw)
        == "Tony Stark, in his finest tin suit."
    )


def test_strips_image_gen_failure_placeholder() -> None:
    raw = (
        "_(I couldn't draw that — couldn't reach the image-generation "
        "service (ConnectError))_\n\nApologies, sir."
    )
    assert scrub_assistant_content(raw) == "Apologies, sir."


def test_strips_image_gen_skip_placeholder() -> None:
    raw = (
        "Right away, sir.\n\n"
        "_(I drew the first couple, sir, but skipped the rest — "
        "let's not flood the page.)_"
    )
    assert scrub_assistant_content(raw) == "Right away, sir."


def test_strips_email_placeholder() -> None:
    raw = (
        "_(Email sent to alice@example.com — subject: \"Lunch\")_\n\n"
        "Off it goes."
    )
    assert scrub_assistant_content(raw) == "Off it goes."


def test_strips_spotify_placeholder() -> None:
    raw = "_(Now playing: Bohemian Rhapsody — Queen)_\n\nA classic."
    assert scrub_assistant_content(raw) == "A classic."


def test_strips_inline_placeholder_collapses_spaces() -> None:
    raw = "Right away, sir _(Generated.)_ — there you are."
    assert scrub_assistant_content(raw) == "Right away, sir — there you are."


def test_strips_multiple_placeholders_in_one_message() -> None:
    raw = (
        "_(Generated.)_\n\nFirst image up.\n\n"
        "_(Generated.)_\n\nAnd the second."
    )
    assert (
        scrub_assistant_content(raw)
        == "First image up.\n\nAnd the second."
    )


def test_returns_empty_string_when_message_is_only_placeholder() -> None:
    """An assistant turn whose entire body was the status line —
    rare but possible. Caller is expected to fall back to a
    structural placeholder like ``[no reply]``."""

    raw = "_(Generated.)_"
    assert scrub_assistant_content(raw) == ""


def test_passes_through_normal_prose_unchanged() -> None:
    raw = (
        "There you are, sir. The Tony Stark portrait is rendered in "
        "the style of an oil painting; should I queue another?"
    )
    assert scrub_assistant_content(raw) == raw


def test_passes_through_empty_string() -> None:
    assert scrub_assistant_content("") == ""


def test_does_not_strip_non_italic_parens() -> None:
    """Real prose with parens (no italic underscores) must survive."""

    raw = "Tony Stark (also known as Iron Man) is the man, sir."
    assert scrub_assistant_content(raw) == raw


def test_strips_archive_rollup_multi_line_placeholder() -> None:
    """Archive rollup uses a placeholder that wraps over a newline.
    The scrubber must still match it."""

    raw = (
        "There you are, sir.\n\n"
        "_(Archived this conversation to memory:\nEvening with Stark.)_"
    )
    assert scrub_assistant_content(raw) == "There you are, sir."
