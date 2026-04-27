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
from datetime import datetime
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

    Returns ``(visible_reply, optional_titles)`` where ``optional_titles``
    is a list of suggested titles if the model emitted them inline (e.g.
    ``[REMEMBER_CONVERSATION: Spotify setup]``). Empty list if the user
    just wanted the conversation archived without a particular label —
    the summariser will pick a title from the content.
    """
    titles: list[str] = []
    for match in _REMEMBER_CONVERSATION_PATTERN.finditer(reply):
        if match.group(1):
            titles.append(match.group(1).strip())
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
    stamp = (note.created_at or datetime.utcnow()).strftime("%Y-%m-%d")
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


async def rollup_if_pressured(
    *,
    session: AsyncSession,
    settings: Settings,
    llm_router: Router,
    conversation_id: UUID,
    history: list[Message],
) -> list[Message]:
    """If the conversation is over the size threshold, archive the oldest
    half into a memory note and return the survivors. Otherwise return
    the input list unchanged.

    The dropped messages are only removed from the *active history*
    Alfred sees this turn — the underlying ``messages`` table is
    untouched, so the conversation transcript still reads in full when
    the user opens the past conversation in the sidebar. The summary
    is what enters Alfred's working memory; the raw rows stay as a
    record.
    """
    threshold = max(20, settings.alfred_memory_token_pressure_messages)
    if len(history) <= threshold:
        return history
    half = len(history) // 2
    older = history[:half]
    survivors = history[half:]
    summary = await summarise_messages(older, llm_router=llm_router)
    if summary is None:
        # Couldn't summarise — leave the history alone rather than silently
        # dropping context. We'll try again next turn.
        return history
    await persist_summary(
        session=session,
        settings=settings,
        summary=summary,
        source_conversation_id=conversation_id,
        source="rolling_context",
    )
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

    Falls back to recent-notes ordering if no embedding service is
    available (so retrieval is at least *something* rather than
    nothing). Returns an empty list if there are no notes at all or
    no embedding could be produced and there are no notes either.
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
        # Without an embedding we can't do similarity. Return the most
        # recent notes as a weak fallback so the panel/system prompt
        # still has *some* context.
        result = await session.execute(
            select(MemoryNote).order_by(MemoryNote.created_at.desc()).limit(k)
        )
        return [MemoryHit(note=n, similarity=0.0) for n in result.scalars().all()]

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
