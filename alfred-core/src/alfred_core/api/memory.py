"""Endpoints for browsing, searching, editing, and archiving Alfred's memory.

The companion service module is ``alfred_core.memory_archive``. This
file is the HTTP shell — list, get, search, edit, delete a single
note, plus an explicit ``POST /memory/summarize`` for the user to
archive a past conversation by hand from the UI.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import overload
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from alfred_core.config import get_settings
from alfred_core.db.models import MemoryNote
from alfred_core.db.session import get_session
from alfred_core.memory_archive import (
    delete_markdown_mirror,
    embed_note_text,
    search_relevant_notes,
    summarise_and_persist_conversation,
    write_markdown_mirror,
)
from alfred_core.router import Router

router = APIRouter(prefix="/memory", tags=["memory"])

_settings = get_settings()
_llm_router = Router.from_settings(_settings)


@overload
def _as_utc(dt: datetime) -> datetime: ...
@overload
def _as_utc(dt: None) -> None: ...
def _as_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


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


class MemoryNoteOut(BaseModel):
    id: UUID
    title: str
    summary: str
    key_facts: list[str] = []
    decisions: list[str] = []
    follow_ups: list[str] = []
    source: str
    source_conversation_id: UUID | None = None
    markdown_filename: str = ""
    created_at: datetime
    updated_at: datetime
    similarity: float | None = None

    @classmethod
    def from_model(
        cls, note: MemoryNote, *, similarity: float | None = None
    ) -> MemoryNoteOut:
        structured = note.structured or {}
        if not isinstance(structured, dict):
            structured = {}
        return cls(
            id=note.id,
            title=note.title,
            summary=note.summary,
            key_facts=_coerce_string_list(structured.get("key_facts")),
            decisions=_coerce_string_list(structured.get("decisions")),
            follow_ups=_coerce_string_list(structured.get("follow_ups")),
            source=note.source,
            source_conversation_id=note.source_conversation_id,
            markdown_filename=note.markdown_filename,
            created_at=_as_utc(note.created_at) or datetime.now(UTC),
            updated_at=_as_utc(note.updated_at) or datetime.now(UTC),
            similarity=similarity,
        )


class MemoryNoteList(BaseModel):
    notes: list[MemoryNoteOut]
    storage_path: str


class MemoryNotePatch(BaseModel):
    title: str | None = None
    summary: str | None = None
    key_facts: list[str] | None = None
    decisions: list[str] | None = None
    follow_ups: list[str] | None = None


class MemorySearchRequest(BaseModel):
    query: str
    top_k: int | None = None
    min_similarity: float | None = None


class MemorySearchHit(BaseModel):
    note: MemoryNoteOut
    similarity: float


class MemorySearchResponse(BaseModel):
    hits: list[MemorySearchHit]


class SummarizeRequest(BaseModel):
    conversation_id: UUID
    title: str | None = None


@router.get("", response_model=MemoryNoteList)
async def list_memory_notes(
    q: str | None = None,
    session: AsyncSession = Depends(get_session),
) -> MemoryNoteList:
    """List all memory notes (newest first), optionally filtered by ``q``.

    The ``q`` filter is a simple ILIKE match on title + summary — it's
    the right tool when the user is *browsing* the archive in the UI.
    For semantic recall use ``POST /memory/search`` instead.
    """
    stmt = select(MemoryNote).order_by(MemoryNote.created_at.desc())
    if q and q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(MemoryNote.title.ilike(like), MemoryNote.summary.ilike(like))
        )
    rows = (await session.execute(stmt)).scalars().all()
    return MemoryNoteList(
        notes=[MemoryNoteOut.from_model(n) for n in rows],
        storage_path=_settings.alfred_memory_dir,
    )


@router.get("/{note_id}", response_model=MemoryNoteOut)
async def get_memory_note(
    note_id: UUID,
    session: AsyncSession = Depends(get_session),
) -> MemoryNoteOut:
    note = await session.get(MemoryNote, note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Memory note not found.")
    return MemoryNoteOut.from_model(note)


@router.patch("/{note_id}", response_model=MemoryNoteOut)
async def update_memory_note(
    note_id: UUID,
    patch: MemoryNotePatch,
    session: AsyncSession = Depends(get_session),
) -> MemoryNoteOut:
    note = await session.get(MemoryNote, note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Memory note not found.")

    text_changed = False
    if patch.title is not None and patch.title.strip():
        note.title = patch.title.strip()[:200]
        text_changed = True
    if patch.summary is not None:
        note.summary = patch.summary.strip()
        text_changed = True
    structured = dict(note.structured) if isinstance(note.structured, dict) else {}
    if patch.key_facts is not None:
        structured["key_facts"] = [
            s.strip() for s in patch.key_facts if isinstance(s, str) and s.strip()
        ]
    if patch.decisions is not None:
        structured["decisions"] = [
            s.strip() for s in patch.decisions if isinstance(s, str) and s.strip()
        ]
    if patch.follow_ups is not None:
        structured["follow_ups"] = [
            s.strip() for s in patch.follow_ups if isinstance(s, str) and s.strip()
        ]
    note.structured = structured
    # Note: ``source`` is intentionally not changed by an edit. It
    # records *how* the note got into the archive (auto-archive, rollup,
    # manual archive button) — editing the body afterwards doesn't
    # rewrite that history.
    # Re-embed when the user edits the title / summary so retrieval
    # stays accurate. Best-effort — failure leaves the existing
    # embedding in place.
    if text_changed:
        new_embedding = await embed_note_text(
            note.title, note.summary, settings=_settings
        )
        if new_embedding is not None:
            note.embedding = new_embedding

    # Refresh the markdown mirror so the on-disk file matches the DB.
    filename = write_markdown_mirror(note, settings=_settings)
    if filename:
        note.markdown_filename = filename

    await session.commit()
    await session.refresh(note)
    return MemoryNoteOut.from_model(note)


@router.delete("/{note_id}", status_code=204)
async def delete_memory_note(
    note_id: UUID,
    session: AsyncSession = Depends(get_session),
) -> None:
    note = await session.get(MemoryNote, note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Memory note not found.")
    filename = note.markdown_filename
    await session.delete(note)
    await session.commit()
    if filename:
        delete_markdown_mirror(filename, settings=_settings)


@router.post("/search", response_model=MemorySearchResponse)
async def search_memory(
    body: MemorySearchRequest,
    session: AsyncSession = Depends(get_session),
) -> MemorySearchResponse:
    if not body.query.strip():
        return MemorySearchResponse(hits=[])
    hits = await search_relevant_notes(
        session,
        settings=_settings,
        query_text=body.query,
        top_k=body.top_k,
        min_similarity=body.min_similarity,
    )
    return MemorySearchResponse(
        hits=[
            MemorySearchHit(
                note=MemoryNoteOut.from_model(h.note, similarity=h.similarity),
                similarity=h.similarity,
            )
            for h in hits
        ]
    )


@router.post("/summarize", response_model=MemoryNoteOut)
async def summarize_conversation(
    body: SummarizeRequest,
    session: AsyncSession = Depends(get_session),
) -> MemoryNoteOut:
    """Summarise a past conversation into a long-term memory note.

    Used by the UI's MEMORY tab when the user clicks "Archive this
    conversation". Returns the freshly-created note. 404 if the
    conversation can't be found, 422 if it's empty or the LLM couldn't
    produce a usable summary.
    """
    note = await summarise_and_persist_conversation(
        session=session,
        settings=_settings,
        llm_router=_llm_router,
        conversation_id=body.conversation_id,
        suggested_title=body.title,
    )
    if note is None:
        raise HTTPException(
            status_code=422,
            detail=(
                "Couldn't summarise that conversation. It may be empty, or "
                "the LLM didn't produce a usable response — try again or "
                "check that Ollama is running."
            ),
        )
    await session.commit()
    await session.refresh(note)
    return MemoryNoteOut.from_model(note)
