"""Unit tests for the ``[GENERATE_IMAGE]`` marker parser."""

from __future__ import annotations

from alfred_core.tools.image_marker import (
    extract_requests,
    replace_marker,
    strip_markers,
)


def test_block_marker() -> None:
    reply = (
        "Right away, sir.\n"
        "[GENERATE_IMAGE]\n"
        "A vintage British sports car, late afternoon light, oil painting\n"
        "[/GENERATE_IMAGE]"
    )
    reqs = extract_requests(reply)
    assert len(reqs) == 1
    assert (
        reqs[0].prompt
        == "A vintage British sports car, late afternoon light, oil painting"
    )
    assert reqs[0].raw_match.startswith("[GENERATE_IMAGE]")
    assert reqs[0].raw_match.endswith("[/GENERATE_IMAGE]")


def test_inline_marker() -> None:
    reply = "Right away, sir. [GENERATE_IMAGE: a corgi in a tweed waistcoat]"
    reqs = extract_requests(reply)
    assert len(reqs) == 1
    assert reqs[0].prompt == "a corgi in a tweed waistcoat"
    assert reqs[0].raw_match == "[GENERATE_IMAGE: a corgi in a tweed waistcoat]"


def test_multiline_block_preserved_as_single_prompt() -> None:
    reply = (
        "[GENERATE_IMAGE]\n"
        "Architectural blueprint of a treehouse,\n"
        "white lines on deep blue, dimensional callouts,\n"
        "top-down floor plan, technical drawing\n"
        "[/GENERATE_IMAGE]"
    )
    reqs = extract_requests(reply)
    assert len(reqs) == 1
    # Multi-line prompts come through with their original line breaks
    # — Pollinations URL-encodes them safely.
    assert "Architectural blueprint" in reqs[0].prompt
    assert "technical drawing" in reqs[0].prompt


def test_two_blocks_are_independent() -> None:
    reply = (
        "[GENERATE_IMAGE]\nfirst prompt\n[/GENERATE_IMAGE]\n"
        "and another:\n"
        "[GENERATE_IMAGE]\nsecond prompt\n[/GENERATE_IMAGE]"
    )
    reqs = extract_requests(reply)
    assert [r.prompt for r in reqs] == ["first prompt", "second prompt"]


def test_returns_results_in_document_order() -> None:
    """Both block and inline forms should be interleaved in the order
    they appear in the LLM reply — NOT block-first then inline-after.

    This matters because ``_process_image_requests`` iterates the list
    and only honours the first ``_MAX_IMAGES_PER_TURN`` (2) successful
    images. Without document order, a later block marker could be
    honoured while an earlier inline one is refused.
    """

    reply = (
        "First: [GENERATE_IMAGE: inline-A].\n"
        "Then a block:\n"
        "[GENERATE_IMAGE]\nblock-B\n[/GENERATE_IMAGE]\n"
        "Finally: [GENERATE_IMAGE: inline-C]."
    )
    reqs = extract_requests(reply)
    assert [r.prompt for r in reqs] == ["inline-A", "block-B", "inline-C"]


def test_inline_before_block_is_not_swapped() -> None:
    """The original bug: inline-then-block was returned as block-then-inline."""

    reply = (
        "[GENERATE_IMAGE: inline first] then "
        "[GENERATE_IMAGE]\nblock second\n[/GENERATE_IMAGE]"
    )
    reqs = extract_requests(reply)
    assert [r.prompt for r in reqs] == ["inline first", "block second"]


def test_inline_inside_block_is_not_double_counted() -> None:
    """An inline-shaped sequence inside a block prompt must not match twice."""

    reply = (
        "[GENERATE_IMAGE]\n"
        "This prompt mentions [GENERATE_IMAGE: nope] inside it.\n"
        "[/GENERATE_IMAGE]"
    )
    reqs = extract_requests(reply)
    assert len(reqs) == 1
    assert "[GENERATE_IMAGE: nope]" in reqs[0].prompt


def test_empty_prompts_are_skipped() -> None:
    assert extract_requests("[GENERATE_IMAGE]\n   \n[/GENERATE_IMAGE]") == []
    assert extract_requests("[GENERATE_IMAGE: ]") == []


def test_case_insensitive() -> None:
    reqs = extract_requests("[generate_image: a tabby cat]")
    assert len(reqs) == 1
    assert reqs[0].prompt == "a tabby cat"


def test_no_markers() -> None:
    assert extract_requests("Just chatting, no images, sir.") == []


def test_replace_marker_swaps_to_confirmation() -> None:
    reply = "Right away. [GENERATE_IMAGE: a quiet beach at dawn]"
    reqs = extract_requests(reply)
    out = replace_marker(reply, reqs[0], "_(Generated.)_")
    assert "[GENERATE_IMAGE" not in out
    assert "_(Generated.)_" in out


def test_strip_markers_keeps_prose() -> None:
    reply = (
        "Drawing it now. [GENERATE_IMAGE: a robot] Done."
    )
    cleaned = strip_markers(reply)
    assert "[GENERATE_IMAGE" not in cleaned
    assert "Drawing it now." in cleaned
    assert "Done." in cleaned
