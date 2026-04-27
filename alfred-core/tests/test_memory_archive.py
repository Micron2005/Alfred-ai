"""Pure-logic tests for the long-term memory archive (Phase 12b).

The LLM-driven summariser, embedding service, and DB persistence all
need a live Ollama / Postgres to exercise end-to-end. These tests
cover the deterministic parts: marker extraction, JSON parsing,
markdown rendering, and prompt formatting.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from alfred_core.db.models import MemoryNote
from alfred_core.memory_archive import (
    MemoryHit,
    _extract_json_payload,
    extract_remember_conversation,
    format_notes_for_prompt,
    render_markdown,
)


# ─── extract_remember_conversation ───────────────────────────────────────


def test_remember_conversation_marker_is_extracted_and_stripped() -> None:
    reply = (
        "Of course, sir, I'll keep this one in the archive.\n"
        "[REMEMBER_CONVERSATION]"
    )
    visible, titles = extract_remember_conversation(reply)
    assert titles == []
    assert "[REMEMBER_CONVERSATION" not in visible
    assert visible == "Of course, sir, I'll keep this one in the archive."


def test_remember_conversation_marker_with_title() -> None:
    reply = "Filed. [REMEMBER_CONVERSATION: Spotify Premium setup]"
    visible, titles = extract_remember_conversation(reply)
    assert titles == ["Spotify Premium setup"]
    assert "[REMEMBER_CONVERSATION" not in visible


def test_remember_conversation_multiple_markers_collect_titles() -> None:
    reply = (
        "[REMEMBER_CONVERSATION: HUD layout decisions]\n"
        "[REMEMBER_CONVERSATION: Spotify wiring]"
    )
    visible, titles = extract_remember_conversation(reply)
    assert titles == ["HUD layout decisions", "Spotify wiring"]
    assert visible == ""


def test_remember_conversation_ignores_unrelated_markers() -> None:
    reply = "Noted. [REMEMBER: His favourite tea is Earl Grey.]"
    visible, titles = extract_remember_conversation(reply)
    assert titles == []
    assert visible == reply


# ─── _extract_json_payload ───────────────────────────────────────────────


def test_extract_json_payload_plain_object() -> None:
    raw = '{"title": "T", "summary": "S"}'
    parsed = _extract_json_payload(raw)
    assert parsed == {"title": "T", "summary": "S"}


def test_extract_json_payload_with_markdown_fence() -> None:
    raw = '```json\n{"title": "T", "summary": "S"}\n```'
    parsed = _extract_json_payload(raw)
    assert parsed == {"title": "T", "summary": "S"}


def test_extract_json_payload_with_preamble_and_trailing() -> None:
    raw = (
        "Sure, here is the summary you asked for:\n\n"
        '{"title": "T", "summary": "S", "key_facts": []}\n\n'
        "Let me know if you'd like me to refine it."
    )
    parsed = _extract_json_payload(raw)
    assert parsed is not None
    assert parsed["title"] == "T"
    assert parsed["key_facts"] == []


def test_extract_json_payload_returns_none_on_malformed() -> None:
    assert _extract_json_payload("not even close to JSON") is None
    assert _extract_json_payload('{"oops": "no closing brace"') is None


def test_extract_json_payload_handles_nested_braces() -> None:
    raw = (
        '{"title": "T", "summary": "S", '
        '"structured": {"a": 1, "b": {"c": 2}}, "ok": true}'
    )
    parsed = _extract_json_payload(raw)
    assert parsed is not None
    assert parsed["ok"] is True


# ─── render_markdown ─────────────────────────────────────────────────────


def _make_note(**overrides: object) -> MemoryNote:
    note = MemoryNote(
        id=uuid4(),
        title="Spotify Premium setup",
        summary="Mukarram linked his Spotify Premium account so Alfred can drive playback.",
        structured={
            "key_facts": [
                "Mukarram has Spotify Premium.",
                "Redirect URI must be 127.0.0.1, not localhost.",
            ],
            "decisions": ["Use Web Playback SDK in the browser."],
            "follow_ups": [],
        },
        source="conversation_summary",
        markdown_filename="2026-04-27_spotify-premium-setup.md",
        created_at=datetime(2026, 4, 27, 14, 30, tzinfo=UTC),
    )
    for k, v in overrides.items():
        setattr(note, k, v)
    return note


def test_render_markdown_includes_title_summary_and_facts() -> None:
    md = render_markdown(_make_note())
    assert md.startswith("# Spotify Premium setup")
    assert "## Summary" in md
    assert "Mukarram linked his Spotify Premium account" in md
    assert "## Key facts" in md
    assert "- Mukarram has Spotify Premium." in md
    assert "## Decisions" in md
    assert "- Use Web Playback SDK in the browser." in md
    # follow_ups was empty — should be omitted entirely, not "no items"
    assert "## Follow-ups" not in md


def test_render_markdown_handles_empty_structured() -> None:
    note = _make_note(structured=None, summary="")
    md = render_markdown(note)
    assert "_(no summary)_" in md
    assert "## Key facts" not in md


def test_render_markdown_metadata_block() -> None:
    note = _make_note()
    md = render_markdown(note)
    assert f"_id_: `{note.id}`" in md
    assert "_source_: `conversation_summary`" in md
    assert "_created_: `2026-04-27T14:30:00+00:00`" in md


# ─── format_notes_for_prompt ─────────────────────────────────────────────


def test_format_notes_for_prompt_empty_returns_empty_string() -> None:
    assert format_notes_for_prompt([]) == ""


def test_format_notes_for_prompt_renders_each_note() -> None:
    note = _make_note()
    text = format_notes_for_prompt([MemoryHit(note=note, similarity=0.82)])
    assert "RELEVANT MEMORIES" in text
    assert "Spotify Premium setup" in text
    assert "82% relevant" in text
    # Caps key_facts at three so a verbose past doesn't crowd the prompt.
    structured = note.structured
    assert isinstance(structured, dict)
    assert isinstance(structured.get("key_facts"), list)
    assert "Redirect URI must be 127.0.0.1" in text
