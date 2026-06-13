"""Pure-logic tests for the markdown→DB restore path.

The disaster-recovery flow has two halves:
1. ``parse_markdown_mirror`` — string → ``ParsedMarkdownNote``.
2. ``restore_from_mirror`` — DB writes + Ollama embedding calls.

These tests cover (1) deterministically. (2) is exercised manually
against the user's real Postgres + Ollama on his machine (it needs
both to be alive, which isn't reproducible in CI).
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from alfred_core.db.models import MemoryNote
from alfred_core.memory_archive import (
    ParsedMarkdownNote,
    parse_markdown_mirror,
    render_markdown,
)


def _make_note() -> MemoryNote:
    note = MemoryNote(
        id=UUID("9444ea30-8833-4b65-a43d-5128c2b1b71a"),
        source_conversation_id=UUID("2e06e21d-87b9-42de-ae11-66c9a60f4240"),
        title="Nightfall Protocol: Activation Rules",
        summary=(
            "The user established strict security rules for "
            "'Nightfall Protocol,' a confidential operational mode."
        ),
        structured={
            "key_facts": [
                "User's full name is Mukarram Alam.",
                "User is designated as 'admin'.",
            ],
            "decisions": [
                "Nightfall activation is restricted to Mukarram Alam.",
            ],
            "follow_ups": [
                "Test compartmentalization in a fresh chat.",
            ],
        },
        source="conversation_summary",
    )
    # SQLAlchemy normally sets these on flush; set them by hand for the
    # render_markdown round-trip.
    note.created_at = datetime(2026, 5, 1, 21, 12, 46, 864292, tzinfo=UTC)
    return note


# ─── parse_markdown_mirror ──────────────────────────────────────────────


def test_parse_round_trips_a_rendered_note() -> None:
    """The end-to-end disaster-recovery test: render a note to markdown,
    parse it back, and check every restorable field round-trips."""
    note = _make_note()
    parsed = parse_markdown_mirror(render_markdown(note))

    assert isinstance(parsed, ParsedMarkdownNote)
    assert parsed.id == note.id
    assert parsed.title == note.title
    assert parsed.summary == note.summary
    assert parsed.source == note.source
    assert parsed.source_conversation_id == note.source_conversation_id
    assert parsed.created_at == note.created_at
    assert parsed.structured == note.structured


def test_parse_handles_real_user_file() -> None:
    """Verbatim from the user's ~/Alfred-ai/alfred-memory directory."""
    raw = (
        "# Nightfall Protocol: Activation Rules and Compartmentalization\n"
        "\n"
        "_id_: `9444ea30-8833-4b65-a43d-5128c2b1b71a`\n"
        "_source_: `conversation_summary`\n"
        "_created_: `2026-05-01T21:12:46.864292+00:00`\n"
        "_conversation_: `2e06e21d-87b9-42de-ae11-66c9a60f4240`\n"
        "\n"
        "## Summary\n"
        "\n"
        "The user established strict security rules.\n"
        "\n"
        "## Key facts\n"
        "\n"
        "- User's full name is Mukarram Alam.\n"
        "- User is designated as 'admin'.\n"
        "\n"
        "## Decisions\n"
        "\n"
        "- Nightfall activation is restricted to Mukarram Alam.\n"
        "\n"
        "## Follow-ups\n"
        "\n"
        "- Test compartmentalization in a fresh chat.\n"
    )
    parsed = parse_markdown_mirror(raw)
    assert parsed.id == UUID("9444ea30-8833-4b65-a43d-5128c2b1b71a")
    assert parsed.source_conversation_id == UUID(
        "2e06e21d-87b9-42de-ae11-66c9a60f4240"
    )
    assert parsed.title.startswith("Nightfall Protocol")
    assert "strict security rules" in parsed.summary
    assert parsed.structured["key_facts"] == [
        "User's full name is Mukarram Alam.",
        "User is designated as 'admin'.",
    ]
    assert parsed.structured["decisions"] == [
        "Nightfall activation is restricted to Mukarram Alam.",
    ]
    assert parsed.structured["follow_ups"] == [
        "Test compartmentalization in a fresh chat.",
    ]


def test_parse_tolerates_missing_optional_fields() -> None:
    """A hand-written note with no metadata or only a summary still
    imports — restore gives it a fresh UUID and defaults the source."""
    raw = (
        "# A note I wrote by hand\n"
        "\n"
        "## Summary\n"
        "\n"
        "Sometimes I just want to jot something down.\n"
    )
    parsed = parse_markdown_mirror(raw)
    assert parsed.id is None  # restore will mint a UUID
    assert parsed.title == "A note I wrote by hand"
    assert parsed.summary == "Sometimes I just want to jot something down."
    assert parsed.source == "conversation_summary"  # default
    assert parsed.source_conversation_id is None
    assert parsed.created_at is None
    assert parsed.structured == {}


def test_parse_handles_empty_summary_placeholder() -> None:
    """``render_markdown`` writes ``_(no summary)_`` for empty
    summaries — the parser should strip that back to an empty string,
    not store the placeholder verbatim."""
    raw = (
        "# Empty note\n"
        "\n"
        "_id_: `12345678-1234-1234-1234-123456789012`\n"
        "\n"
        "## Summary\n"
        "\n"
        "_(no summary)_\n"
    )
    parsed = parse_markdown_mirror(raw)
    assert parsed.summary == ""
    assert parsed.id == UUID("12345678-1234-1234-1234-123456789012")


def test_parse_rejects_malformed_uuid_silently() -> None:
    """A corrupted ``_id_`` line shouldn't crash the import — the note
    just gets a fresh UUID at restore time."""
    raw = (
        "# Corrupted id note\n"
        "\n"
        "_id_: `not-a-uuid`\n"
        "_source_: `manual`\n"
        "\n"
        "## Summary\n"
        "\n"
        "Body.\n"
    )
    parsed = parse_markdown_mirror(raw)
    assert parsed.id is None
    assert parsed.source == "manual"


def test_parse_ignores_section_order() -> None:
    """Sections can appear in any order in a hand-edited file."""
    raw = (
        "# Reordered sections\n"
        "\n"
        "## Follow-ups\n"
        "\n"
        "- one follow-up\n"
        "\n"
        "## Decisions\n"
        "\n"
        "- one decision\n"
        "\n"
        "## Summary\n"
        "\n"
        "Some summary.\n"
        "\n"
        "## Key facts\n"
        "\n"
        "- one fact\n"
    )
    parsed = parse_markdown_mirror(raw)
    assert parsed.summary == "Some summary."
    assert parsed.structured == {
        "key_facts": ["one fact"],
        "decisions": ["one decision"],
        "follow_ups": ["one follow-up"],
    }


def test_parse_ignores_non_bullet_lines_in_sections() -> None:
    """Free-form prose mixed into a structured section is dropped —
    we only collect ``- `` bullets, matching the renderer."""
    raw = (
        "# Mixed prose\n"
        "\n"
        "## Key facts\n"
        "\n"
        "Here are some facts about the conversation:\n"
        "\n"
        "- the first fact\n"
        "- the second fact\n"
        "\n"
        "(extra commentary)\n"
    )
    parsed = parse_markdown_mirror(raw)
    assert parsed.structured == {
        "key_facts": ["the first fact", "the second fact"],
    }
