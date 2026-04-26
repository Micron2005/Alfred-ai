"""Endpoints for listing, loading, and deleting past conversations.

This is what lets Mukarram close his browser, come back tomorrow, and pick
up exactly where he left off — Alfred's memory of the conversation lives in
Postgres, not in the browser tab.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import overload
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from alfred_core.db.models import Conversation, Message
from alfred_core.db.session import get_session

router = APIRouter(prefix="/conversations", tags=["conversations"])


@overload
def _as_utc(dt: datetime) -> datetime: ...
@overload
def _as_utc(dt: None) -> None: ...
def _as_utc(dt: datetime | None) -> datetime | None:
    """The Postgres column is TIMESTAMP WITHOUT TIME ZONE, so SQLAlchemy
    returns naive datetimes even though we always write UTC. Tag those
    naive values as UTC so JSON serialization includes the +00:00 suffix
    and the browser doesn't read them as local-clock values."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def _extract_images(metadata: dict[str, object] | None) -> list[MessageImageOut]:
    """Pull image attachments out of a Message's ``metadata_json`` blob.

    Images live there as ``{"images": [{"data": "...", "mime_type": "..."}]}``.
    If anything is missing or malformed we return an empty list rather than
    erroring — old messages predate the field, and we'd rather degrade
    gracefully than 500 the whole conversation.
    """
    if not metadata:
        return []
    raw = metadata.get("images")
    if not isinstance(raw, list):
        return []
    out: list[MessageImageOut] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        data = entry.get("data")
        mime = entry.get("mime_type")
        if isinstance(data, str) and isinstance(mime, str):
            out.append(MessageImageOut(data=data, mime_type=mime))
    return out


class ConversationSummary(BaseModel):
    id: UUID
    title: str
    mode: str
    created_at: datetime
    last_message_at: datetime | None
    message_count: int


class ConversationList(BaseModel):
    conversations: list[ConversationSummary]


class MessageImageOut(BaseModel):
    data: str
    mime_type: str


class MessageOut(BaseModel):
    id: UUID
    role: str
    content: str
    backend: str | None = None
    model: str | None = None
    images: list[MessageImageOut] = []
    created_at: datetime


class ConversationDetail(BaseModel):
    id: UUID
    title: str
    mode: str
    created_at: datetime
    messages: list[MessageOut]


@router.get("", response_model=ConversationList)
async def list_conversations(
    session: AsyncSession = Depends(get_session),
) -> ConversationList:
    # Join to get last message time + count in one query per conversation.
    last_at = func.max(Message.created_at).label("last_at")
    count = func.count(Message.id).label("count")
    stmt = (
        select(Conversation, last_at, count)
        .outerjoin(Message, Message.conversation_id == Conversation.id)
        .group_by(Conversation.id)
        .order_by(func.coalesce(last_at, Conversation.created_at).desc())
    )
    rows = (await session.execute(stmt)).all()

    summaries = [
        ConversationSummary(
            id=convo.id,
            title=convo.title,
            mode=convo.mode,
            created_at=_as_utc(convo.created_at),
            last_message_at=_as_utc(last_message_at),
            message_count=message_count or 0,
        )
        for convo, last_message_at, message_count in rows
    ]
    return ConversationList(conversations=summaries)


@router.get("/{conversation_id}", response_model=ConversationDetail)
async def get_conversation(
    conversation_id: UUID,
    session: AsyncSession = Depends(get_session),
) -> ConversationDetail:
    convo = await session.get(Conversation, conversation_id)
    if convo is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")

    msgs = (
        await session.execute(
            select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.created_at.asc())
        )
    ).scalars().all()

    return ConversationDetail(
        id=convo.id,
        title=convo.title,
        mode=convo.mode,
        created_at=_as_utc(convo.created_at),
        messages=[
            MessageOut(
                id=m.id,
                role=m.role,
                content=m.content,
                backend=m.backend,
                model=m.model,
                images=_extract_images(m.metadata_json),
                created_at=_as_utc(m.created_at),
            )
            for m in msgs
            if m.role in ("user", "assistant")
        ],
    )


@router.delete("/{conversation_id}", status_code=204)
async def delete_conversation(
    conversation_id: UUID,
    session: AsyncSession = Depends(get_session),
) -> None:
    convo = await session.get(Conversation, conversation_id)
    if convo is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    await session.delete(convo)
    await session.commit()
