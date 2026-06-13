"""Phase 12b — Alfred's long-term Memory archive.

Three jobs live in this module:

1. **Summarise** a conversation (or a segment of one) into a structured
   ``MemoryNote`` — title, paragraph summary, and JSON of key facts /
   decisions / follow-ups. The summarisation is itself an LLM call,
   produced through the existing Router so it uses whatever backend is
   configured (local Ollama or Claude).

2. **Embed** the note (title + summary) into a 768-dim vector via
   Ollama's ``/api/embed`` endpoint, so future chats can semantically
   recall the right note. Embedding is best-effort — if Ollama's
   embedding model isn't pulled, the note still persists; it just
   won't surface from vector search until it is re-embedded.

3. **Mirror** the note to a Markdown file under
   ``settings.alfred_memory_dir``. The directory is volume-mounted to
   the user's host (e.g.  ``C:\\Users\\mukar\\Documents\\Alfred
   Memory``), so the notes are first-class files he can browse, grep,
   or edit by hand outside Alfred.

The retrieval side (used by ``api/chat`` at the start of every turn)
lives at the bottom of this file: ``search_relevant_notes`` runs
cosine-distance similarity against the embeddings and returns the
top-K notes above a configurable similarity floor.

Token-pressure rollup — when an active conversation gets too long to
keep entirely in the live LLM context — calls
``rollup_oldest_messages``: it summarises the oldest half of the
conversation into a memory note and returns the survivors so the
chat handler can swap them in.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from alfred_core.config import Settings
from alfred_core.db.models import (
    MEMORY_EMBEDDING_DIM,
    Conversation,
    MemoryNote,
    Message,
)
from alfred_core.llm.base import ChatMessage
from alfred_core.router import Router

log = logging.getLogger("alfred.memory")


# ─── Summarisation ──────────────────────────────────────────────────────

# Marker the LLM is allowed to emit anywhere in a reply to ask the
# system to commit the *current* conversation to long-term memory. The
# chat handler extracts and strips it the same way it does
# ``[REMEMBER: ...]`` for facts.
_REMEMBER_CONVERSATION_PATTERN = re.compile(
    r"\[REMEMBER_CONVERSATION(?:\s*:\s*(.+?))?\]",
    re.IGNORECASE | re.DOTALL,
)


def extract_remember_conversation(reply: str) -> tuple[str, list[str]]:
    """Pull ``[REMEMBER_CONVERSATION]`` markers out of an assistant reply.

    Returns ``(visible_reply, titles)`` where ``titles`` has one entry
    per matched marker — the inline title if the model emitted one
    (``[REMEMBER_CONVERSATION: Spotify setup]``), otherwise an empty
    string for a bare ``[REMEMBER_CONVERSATION]``. The caller can use
    ``if titles:`` as a "was the marker present at all?" check, and
    pull the first non-empty entry as a suggested title.
    """
    titles: list[str] = []
    for match in _REMEMBER_CONVERSATION_PATTERN.finditer(reply):
        raw = match.group(1)
        titles.append(raw.strip() if raw else "")
    cleaned = _REMEMBER_CONVERSATION_PATTERN.sub("", reply)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return cleaned, titles


_SUMMARISATION_INSTRUCTIONS = """\
You are summarising a past chat between Alfred (an AI butler) and his \
user, so Alfred can recall it weeks from now.

Reply with **exactly one** JSON object and nothing else — no \
preamble, no commentary, no Markdown fences. Required shape:

{
  "title": "A short headline (5-8 words). E.g. 'Spotify Premium setup'.",
  "summary": "A single paragraph (3-6 sentences) capturing what was \
discussed. Refer to the user in the third person.",
  "key_facts": ["Concrete fact 1.", "Concrete fact 2.", ...],
  "decisions": ["Decision or commitment 1.", ...],
  "follow_ups": ["Open thread 1.", ...]
}

Empty arrays are fine. Do not invent details that aren't in the \
transcript. Avoid trivia (greetings, small talk). Lean toward facts \
that will help Alfred answer 'remember when we…' questions later.
"""


@dataclass(frozen=True)
class StructuredSummary:
    title: str
    summary: str
    key_facts: list[str]
    decisions: list[str]
    follow_ups: list[str]

    def as_structured(self) -> dict[str, object]:
        return {
            "key_facts": list(self.key_facts),
            "decisions": list(self.decisions),
            "follow_ups": list(self.follow_ups),
        }


def _format_transcript(messages: list[Message]) -> str:
    """Render messages as a plain transcript for the summariser."""
    lines: list[str] = []
    for m in messages:
        if m.role not in ("user", "assistant"):
            continue
        speaker = "User" if m.role == "user" else "Alfred"
        # Trim very long messages so the transcript fits in a sane
        # context window. Summarisation rarely needs the full body of
        # a 10k-character paste.
        body = (m.content or "").strip()
        if len(body) > 2000:
            body = body[:2000] + " …"
        lines.append(f"{speaker}: {body}")
    return "\n\n".join(lines)


def _coerce_string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        if isinstance(item, str):
            stripped = item.strip()
            if stripped:
                out.append(stripped)
    return out


def _extract_json_payload(text: str) -> dict[str, object] | None:
    """Pull the first balanced ``{...}`` block out of an LLM reply."""
    text = text.strip()
    # Trim Markdown fences if the model wrapped the JSON.
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```\s*$", text, re.DOTALL)
    if fence:
        text = fence.group(1)
    # Find the first balanced JSON object.
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    for i, ch in enumerate(text[start:], start=start):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                blob = text[start : i + 1]
                try:
                    parsed = json.loads(blob)
                except json.JSONDecodeError:
                    return None
                return parsed if isinstance(parsed, dict) else None
    return None


async def summarise_messages(
    messages: list[Message],
    *,
    llm_router: Router,
    suggested_title: str | None = None,
) -> StructuredSummary | None:
    """LLM-summarise the given message list. ``None`` on failure."""
    transcript = _format_transcript(messages)
    if not transcript:
        return None

    user_prompt = (
        f"Transcript follows. Produce the JSON summary now.\n\n{transcript}"
    )
    if suggested_title:
        user_prompt += (
            f"\n\nThe user suggested the title: {suggested_title!r}. "
            "Use it verbatim if it's accurate, otherwise pick your own."
        )

    summarisation_messages: list[ChatMessage] = [
        ChatMessage(role="system", content=_SUMMARISATION_INSTRUCTIONS),
        ChatMessage(role="user", content=user_prompt),
    ]

    try:
        response = await llm_router.complete(summarisation_messages)
    except Exception as exc:
        # LLM backends raise heterogeneous errors (httpx, anthropic SDK,
        # JSON decode, etc.); we log and skip rather than 500 the chat.
        log.warning("Memory summariser LLM call failed: %s", exc)
        return None

    payload = _extract_json_payload(response.content)
    if payload is None:
        log.warning(
            "Memory summariser returned non-JSON content: %r",
            response.content[:200],
        )
        return None

    title_raw = payload.get("title")
    summary_raw = payload.get("summary")
    title = (title_raw or suggested_title or "Untitled memory").strip() if isinstance(
        title_raw, str
    ) else (suggested_title or "Untitled memory")
    summary = summary_raw.strip() if isinstance(summary_raw, str) else ""
    if not summary:
        # No usable summary means nothing for retrieval to anchor on.
        return None

    return StructuredSummary(
        title=title[:200] or "Untitled memory",
        summary=summary,
        key_facts=_coerce_string_list(payload.get("key_facts")),
        decisions=_coerce_string_list(payload.get("decisions")),
        follow_ups=_coerce_string_list(payload.get("follow_ups")),
    )


# ─── Embedding ──────────────────────────────────────────────────────────


async def _ollama_embed(
    text: str, *, host: str, model: str, timeout: float = 30.0
) -> list[float] | None:
    """Best-effort embedding via Ollama's ``/api/embed`` endpoint.

    Returns ``None`` on any failure — caller should treat the embedding
    column as nullable.
    """
    body = {"model": model, "input": text}
    url = f"{host.rstrip('/')}/api/embed"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
            resp = await client.post(url, json=body)
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as exc:
        log.info("Memory embedding skipped (Ollama unreachable): %s", exc)
        return None
    except Exception as exc:
        # Any failure path here just means "no embedding for this note";
        # the DB column is nullable and retrieval has a graceful fallback.
        log.warning("Memory embedding failed: %s", exc)
        return None

    # Ollama's /api/embed returns ``{"embeddings": [[...]]}`` for a list
    # of inputs; legacy ``/api/embeddings`` returned ``{"embedding":
    # [...]}``. Accept both.
    embeddings = data.get("embeddings")
    if isinstance(embeddings, list) and embeddings:
        first = embeddings[0]
        if isinstance(first, list) and all(isinstance(x, int | float) for x in first):
            return [float(x) for x in first]
    embedding = data.get("embedding")
    if isinstance(embedding, list) and all(isinstance(x, int | float) for x in embedding):
        return [float(x) for x in embedding]
    log.warning("Memory embedding response shape unrecognised: keys=%s", list(data))
    return None


async def embed_note_text(
    title: str, summary: str, *, settings: Settings
) -> list[float] | None:
    """Embed ``title + summary`` for retrieval. None on failure."""
    text = f"{title}\n\n{summary}".strip()
    if not text:
        return None
    vec = await _ollama_embed(
        text,
        host=settings.ollama_host,
        model=settings.alfred_memory_embedding_model,
    )
    if vec is None:
        return None
    if len(vec) != MEMORY_EMBEDDING_DIM:
        log.warning(
            "Embedding dim mismatch (%d != %d) — dropping vector",
            len(vec),
            MEMORY_EMBEDDING_DIM,
        )
        return None
    return vec


# ─── Markdown mirror ────────────────────────────────────────────────────


_FILENAME_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify(value: str, *, max_length: int = 60) -> str:
    slug = _FILENAME_SLUG_RE.sub("-", value.lower()).strip("-")
    return slug[:max_length] or "memory"


def _build_filename(note: MemoryNote) -> str:
    stamp = (note.created_at or datetime.now(UTC)).strftime("%Y-%m-%d")
    return f"{stamp}_{_slugify(note.title)}.md"


def render_markdown(note: MemoryNote) -> str:
    """Render a memory note to Markdown for the host-side mirror."""
    lines: list[str] = []
    lines.append(f"# {note.title}")
    lines.append("")
    lines.append(f"_id_: `{note.id}`  ")
    lines.append(f"_source_: `{note.source}`  ")
    if note.created_at is not None:
        lines.append(f"_created_: `{note.created_at.isoformat()}`  ")
    if note.source_conversation_id is not None:
        lines.append(f"_conversation_: `{note.source_conversation_id}`  ")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append(note.summary or "_(no summary)_")
    lines.append("")
    structured = note.structured or {}

    def section(name: str, key: str) -> None:
        items = structured.get(key) if isinstance(structured, dict) else None
        if not isinstance(items, list) or not items:
            return
        lines.append(f"## {name}")
        lines.append("")
        for item in items:
            if isinstance(item, str):
                lines.append(f"- {item}")
        lines.append("")

    section("Key facts", "key_facts")
    section("Decisions", "decisions")
    section("Follow-ups", "follow_ups")
    return "\n".join(lines).rstrip() + "\n"


def write_markdown_mirror(note: MemoryNote, *, settings: Settings) -> str:
    """Write the note to disk under ``settings.alfred_memory_dir``.

    Returns the bare filename (relative to the dir). Empty string on
    failure — the DB row is the source of truth, the file mirror is a
    convenience.
    """
    directory = Path(settings.alfred_memory_dir)
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        log.warning("Memory mirror dir not writable (%s): %s", directory, exc)
        return ""
    filename = note.markdown_filename or _build_filename(note)
    path = directory / filename
    try:
        path.write_text(render_markdown(note), encoding="utf-8")
    except OSError as exc:
        log.warning("Could not write memory mirror %s: %s", path, exc)
        return ""
    return filename


def delete_markdown_mirror(filename: str, *, settings: Settings) -> None:
    if not filename:
        return
    path = Path(settings.alfred_memory_dir) / filename
    try:
        if path.exists():
            os.remove(path)
    except OSError as exc:
        log.warning("Could not delete memory mirror %s: %s", path, exc)


# ─── Disaster-recovery: re-hydrate the DB from the markdown mirror ─────

# Pattern for the metadata lines ``render_markdown`` emits, e.g.
#   _id_: `9444ea30-8833-4b65-a43d-5128c2b1b71a`
# The trailing two spaces ``render_markdown`` adds for a hard line
# break aren't required by the parser — we strip whitespace.
_MD_META_RE = re.compile(r"^_(\w+)_:\s*`([^`]*)`", re.MULTILINE)
_MD_TITLE_RE = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)
_MD_SECTION_RE = re.compile(r"^##\s+(.+?)\s*$")
_SECTION_KEY_MAP = {
    "Key facts": "key_facts",
    "Decisions": "decisions",
    "Follow-ups": "follow_ups",
}


@dataclass
class ParsedMarkdownNote:
    """A ``MemoryNote`` parsed back out of its markdown mirror file.

    Empty/optional fields default sensibly so a hand-edited file that
    drops, say, the ``_conversation_:`` line or the Follow-ups section
    still imports cleanly. ``id`` is ``None`` if the file is missing
    its ``_id_:`` line — restore then mints a fresh UUID.
    """

    id: UUID | None
    title: str
    summary: str
    source: str
    created_at: datetime | None
    source_conversation_id: UUID | None
    structured: dict[str, list[str]]


def parse_markdown_mirror(text: str) -> ParsedMarkdownNote:
    """Reverse of ``render_markdown()``.

    Tolerant of missing optional fields, hand-edited summaries, and
    extra whitespace. Returns ``ParsedMarkdownNote``; the caller
    decides how to persist (see ``restore_from_mirror``).
    """

    title_match = _MD_TITLE_RE.search(text)
    title = title_match.group(1).strip() if title_match else "Untitled memory"

    meta = {key: value for key, value in _MD_META_RE.findall(text)}

    def _as_uuid(raw: str | None) -> UUID | None:
        if not raw:
            return None
        try:
            return UUID(raw)
        except ValueError:
            return None

    created_at: datetime | None = None
    if raw_created := meta.get("created"):
        try:
            created_at = datetime.fromisoformat(raw_created)
        except ValueError:
            created_at = None

    # Walk lines, splitting body into ``## SectionName`` chunks.
    sections: dict[str, str] = {}
    current: str | None = None
    buffer: list[str] = []
    for line in text.splitlines():
        match = _MD_SECTION_RE.match(line)
        if match:
            if current is not None:
                sections[current] = "\n".join(buffer).strip()
            current = match.group(1).strip()
            buffer = []
            continue
        if current is not None:
            buffer.append(line)
    if current is not None:
        sections[current] = "\n".join(buffer).strip()

    summary = sections.get("Summary", "").strip()
    # ``render_markdown`` writes this placeholder when summary is empty.
    if summary == "_(no summary)_":
        summary = ""

    structured: dict[str, list[str]] = {}
    for header, key in _SECTION_KEY_MAP.items():
        body = sections.get(header, "")
        if not body:
            continue
        items = [
            line.strip()[2:].strip()
            for line in body.splitlines()
            if line.strip().startswith("- ")
        ]
        if items:
            structured[key] = items

    return ParsedMarkdownNote(
        id=_as_uuid(meta.get("id")),
        title=title,
        summary=summary,
        source=meta.get("source") or "conversation_summary",
        created_at=created_at,
        source_conversation_id=_as_uuid(meta.get("conversation")),
        structured=structured,
    )


@dataclass
class MirrorRestoreReport:
    """Summary of a ``restore_from_mirror`` call."""

    imported: int = 0
    skipped: int = 0
    failed: int = 0
    embedded: int = 0
    errors: list[str] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.errors is None:
            self.errors = []


async def restore_from_mirror(
    *,
    session: AsyncSession,
    settings: Settings,
) -> MirrorRestoreReport:
    """Rehydrate ``memory_notes`` from the markdown mirror directory.

    Idempotent: a note whose ``_id_`` already exists in the DB is
    skipped. A note whose ``_id_`` is missing or unparseable is
    imported with a fresh UUID (treated as "user dropped a hand-
    written note in").

    Embedding is best-effort — if Ollama is unreachable the column
    stays NULL and the note is still saved (semantic search just
    won't find it until a future re-embed).

    The caller owns the transaction: this function only ``flush()``-es
    so we can detect insert failures per-file and continue. Commit on
    the way out.
    """

    report = MirrorRestoreReport()
    directory = Path(settings.alfred_memory_dir)
    if not directory.exists():
        report.errors.append(f"Memory directory not found: {directory}")
        return report

    md_files = sorted(directory.glob("*.md"))
    for path in md_files:
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError as exc:
            report.failed += 1
            report.errors.append(f"{path.name}: read error: {exc}")
            continue

        try:
            parsed = parse_markdown_mirror(raw)
        except Exception as exc:  # noqa: BLE001 — restore must be best-effort
            report.failed += 1
            report.errors.append(f"{path.name}: parse error: {exc}")
            continue

        # Idempotency: skip rows already in the DB by their original UUID.
        if parsed.id is not None:
            existing = await session.get(MemoryNote, parsed.id)
            if existing is not None:
                report.skipped += 1
                continue

        # Resolve the source conversation FK. If the referenced
        # conversation no longer exists (typical after a volume wipe —
        # the .md mirror survives but the conversations table is
        # empty), set the column to NULL. The schema already declares
        # ``ON DELETE SET NULL`` for this exact case, so "orphan note
        # pointing at a deleted conversation" is the correct
        # representation. Without this, every restore attempt would
        # 23503 FK-violate and the savepoint would roll the row back.
        source_conv_id = parsed.source_conversation_id
        if source_conv_id is not None:
            conv_row = await session.execute(
                select(Conversation.id).where(Conversation.id == source_conv_id)
            )
            if conv_row.scalar_one_or_none() is None:
                source_conv_id = None

        note = MemoryNote(
            title=parsed.title[:200] or "Untitled memory",
            summary=parsed.summary,
            structured=parsed.structured or None,
            source=parsed.source[:32] or "conversation_summary",
            markdown_filename=path.name,
            source_conversation_id=source_conv_id,
        )
        if parsed.id is not None:
            note.id = parsed.id
        if parsed.created_at is not None:
            note.created_at = parsed.created_at
            note.updated_at = parsed.created_at

        # Wrap each row in a SAVEPOINT. Without this, a single failed
        # ``flush()`` poisons the outer transaction and every
        # subsequent row in the loop fails too — which is exactly
        # what was happening with the FK error (imported=0,
        # failed=22 instead of 20/2).
        try:
            async with session.begin_nested():
                session.add(note)
                await session.flush()
        except Exception as exc:  # noqa: BLE001 — keep going on bad rows
            report.failed += 1
            report.errors.append(f"{path.name}: insert failed: {exc}")
            continue

        # Re-embed AFTER the insert savepoint succeeds; failure stays
        # best-effort (the row already exists with embedding=NULL).
        embedding = await embed_note_text(
            note.title, note.summary, settings=settings
        )
        if embedding is not None:
            try:
                async with session.begin_nested():
                    note.embedding = embedding
                    await session.flush()
                report.embedded += 1
            except Exception as exc:  # noqa: BLE001
                report.errors.append(
                    f"{path.name}: embed write failed: {exc}"
                )
        report.imported += 1

    return report


# ─── Persistence ────────────────────────────────────────────────────────


async def persist_summary(
    *,
    session: AsyncSession,
    settings: Settings,
    summary: StructuredSummary,
    source_conversation_id: UUID | None,
    source: str,
) -> MemoryNote:
    """Persist a structured summary as a MemoryNote (DB + Markdown)."""
    note = MemoryNote(
        source_conversation_id=source_conversation_id,
        title=summary.title,
        summary=summary.summary,
        structured=summary.as_structured(),
        source=source,
    )
    session.add(note)
    # Embedding is best-effort — failure leaves the column NULL.
    embedding = await embed_note_text(summary.title, summary.summary, settings=settings)
    if embedding is not None:
        note.embedding = embedding
    # Flush so ``note.id`` and ``created_at`` are available before we
    # render the Markdown mirror (we want the real id in the file).
    await session.flush()
    filename = write_markdown_mirror(note, settings=settings)
    if filename:
        note.markdown_filename = filename
    return note


async def summarise_and_persist_conversation(
    *,
    session: AsyncSession,
    settings: Settings,
    llm_router: Router,
    conversation_id: UUID,
    suggested_title: str | None = None,
) -> MemoryNote | None:
    """Summarise a whole conversation and persist the result.

    Returns the new ``MemoryNote`` on success, ``None`` if the
    conversation is empty or the LLM couldn't produce a usable summary.
    """
    convo = await session.get(Conversation, conversation_id)
    if convo is None:
        return None
    msgs_result = await session.execute(
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.created_at.asc())
    )
    messages = list(msgs_result.scalars().all())
    if not messages:
        return None

    summary = await summarise_messages(
        messages, llm_router=llm_router, suggested_title=suggested_title
    )
    if summary is None:
        return None
    return await persist_summary(
        session=session,
        settings=settings,
        summary=summary,
        source_conversation_id=conversation_id,
        source="conversation_summary",
    )


# ─── Token-pressure rollup ──────────────────────────────────────────────


_ROLLUP_COVERED_KEY = "last_covered_message_at"


def _rollup_covered_until(note: MemoryNote) -> datetime | None:
    """Read the high-water mark of messages already archived by a rollup.

    Stored as an ISO-8601 string in ``MemoryNote.structured`` so we can
    skip past it next time and avoid re-archiving the same prefix.

    Returned naive (UTC). The ``messages.created_at`` column is
    ``TIMESTAMP WITHOUT TIME ZONE``, so psycopg3 hands us naive
    datetimes when we read messages back from the DB. Comparing those
    against an aware datetime would raise ``TypeError: can't compare
    offset-naive and offset-aware datetimes`` and crash the chat
    handler on every turn after a rollup. We strip tzinfo here so the
    comparison in ``rollup_if_pressured`` is always naive-vs-naive.
    """
    structured = note.structured or {}
    if not isinstance(structured, dict):
        return None
    raw = structured.get(_ROLLUP_COVERED_KEY)
    if not isinstance(raw, str):
        return None
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(UTC).replace(tzinfo=None)
    return parsed


async def _latest_rollup_covered_until(
    session: AsyncSession, conversation_id: UUID
) -> datetime | None:
    """Return the latest ``last_covered_message_at`` across all rollup
    notes for a conversation, or ``None`` if no rollup exists yet."""
    result = await session.execute(
        select(MemoryNote)
        .where(
            MemoryNote.source_conversation_id == conversation_id,
            MemoryNote.source == "rolling_context",
        )
        .order_by(MemoryNote.created_at.desc())
        .limit(8)
    )
    notes = list(result.scalars().all())
    high_water: datetime | None = None
    for note in notes:
        covered = _rollup_covered_until(note)
        if covered is None:
            continue
        if high_water is None or covered > high_water:
            high_water = covered
    return high_water


async def rollup_if_pressured(
    *,
    session: AsyncSession,
    settings: Settings,
    llm_router: Router,
    conversation_id: UUID,
    history: list[Message],
) -> list[Message]:
    """Archive the oldest portion of a long conversation into a memory
    note and return only the messages that should remain in active LLM
    context.

    Idempotence: any prior rollup writes its coverage high-water mark
    (``last_covered_message_at``) into the note's ``structured`` JSON.
    On subsequent turns we slice ``history`` to messages strictly
    after that timestamp, and only re-fire the rollup if the *new
    uncovered window* exceeds the threshold. Without this guard, a
    conversation past the threshold would create a near-duplicate
    rollup note on every turn (the DB messages aren't deleted, so a
    naive length-check sees the same overflow each time).

    The DB ``messages`` table is intentionally untouched — the full
    transcript still reads in the sidebar; only the live LLM context
    is shrunk.
    """
    threshold = max(20, settings.alfred_memory_token_pressure_messages)
    covered_until = await _latest_rollup_covered_until(
        session, conversation_id
    )
    if covered_until is not None:
        uncovered = [
            m for m in history if m.created_at > covered_until
        ]
    else:
        uncovered = list(history)

    if len(uncovered) <= threshold:
        # Either nothing to roll up, or a previous rollup already
        # trimmed enough that the live window is back under the
        # threshold. Either way, return only the uncovered window so
        # already-archived messages stop being re-fed to the LLM.
        return uncovered

    half = len(uncovered) // 2
    older = uncovered[:half]
    survivors = uncovered[half:]
    if not older:
        return uncovered
    summary = await summarise_messages(older, llm_router=llm_router)
    if summary is None:
        # Summariser failed — keep the uncovered window intact rather
        # than silently dropping context. Next turn will retry.
        return uncovered
    note = await persist_summary(
        session=session,
        settings=settings,
        summary=summary,
        source_conversation_id=conversation_id,
        source="rolling_context",
    )
    # Stamp the high-water mark so the next call skips this prefix.
    last_covered = older[-1].created_at
    structured = dict(note.structured or {})
    structured[_ROLLUP_COVERED_KEY] = last_covered.isoformat()
    note.structured = structured
    return survivors


# ─── Retrieval ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class MemoryHit:
    note: MemoryNote
    similarity: float


async def search_relevant_notes(
    session: AsyncSession,
    *,
    settings: Settings,
    query_text: str,
    top_k: int | None = None,
    min_similarity: float | None = None,
) -> list[MemoryHit]:
    """Vector-search the memory archive for notes relevant to ``query_text``.

    Returns ``[]`` whenever a real similarity can't be computed (no
    embedding service, no embedded notes, empty query, etc.). Earlier
    versions returned the most-recent notes as a "weak fallback", but
    that injected 0%-relevant notes into the chat system prompt every
    turn the embedder happened to be unreachable, polluting context
    with arbitrary memories. Manual browsing of the archive uses
    ``GET /memory`` instead — semantic search is strictly opt-in.
    """
    k = top_k if top_k is not None else settings.alfred_memory_retrieval_top_k
    floor = (
        min_similarity
        if min_similarity is not None
        else settings.alfred_memory_retrieval_min_similarity
    )

    if k <= 0 or not query_text.strip():
        return []

    query_embedding = await embed_note_text(
        title=query_text, summary="", settings=settings
    )
    if query_embedding is None:
        return []

    # Cosine distance — pgvector's ``cosine_distance`` returns a value
    # in [0, 2] where 0 means identical. Convert to similarity = 1 - d.
    distance = MemoryNote.embedding.cosine_distance(query_embedding)
    stmt = (
        select(MemoryNote, distance.label("distance"))
        .where(MemoryNote.embedding.isnot(None))
        .order_by(distance.asc())
        .limit(k)
    )
    rows = (await session.execute(stmt)).all()
    hits: list[MemoryHit] = []
    for note, dist in rows:
        if dist is None:
            continue
        similarity = max(0.0, 1.0 - float(dist))
        if floor > 0 and similarity < floor:
            continue
        hits.append(MemoryHit(note=note, similarity=similarity))
    return hits


def format_notes_for_prompt(hits: list[MemoryHit]) -> str:
    """Render retrieved notes as a system-prompt snippet.

    Returns empty string when there are no hits, so the caller can
    concatenate unconditionally without risking a stray header.
    """
    if not hits:
        return ""
    blocks: list[str] = []
    for hit in hits:
        note = hit.note
        block = [f"• {note.title} ({hit.similarity * 100:.0f}% relevant)"]
        if note.summary:
            block.append(f"  {note.summary}")
        structured = note.structured or {}
        facts = (
            structured.get("key_facts")
            if isinstance(structured, dict)
            else None
        )
        if isinstance(facts, list):
            for fact in facts[:3]:
                if isinstance(fact, str) and fact.strip():
                    block.append(f"    - {fact.strip()}")
        blocks.append("\n".join(block))
    return (
        "\n\nRELEVANT MEMORIES (from past conversations — recall them if "
        "the user refers to anything below):\n" + "\n".join(blocks) + "\n"
    )
