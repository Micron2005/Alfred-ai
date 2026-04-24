"""Endpoints for Alfred's long-term 'facts about the user' memory."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from alfred_core.db.models import Fact
from alfred_core.db.session import get_session

router = APIRouter(prefix="/facts", tags=["facts"])


class FactOut(BaseModel):
    id: UUID
    content: str
    source: str


class FactCreate(BaseModel):
    content: str


class FactList(BaseModel):
    facts: list[FactOut]


@router.get("", response_model=FactList)
async def list_facts(session: AsyncSession = Depends(get_session)) -> FactList:
    result = await session.execute(select(Fact).order_by(Fact.created_at.desc()))
    facts = [
        FactOut(id=f.id, content=f.content, source=f.source)
        for f in result.scalars().all()
    ]
    return FactList(facts=facts)


@router.post("", response_model=FactOut)
async def create_fact(
    req: FactCreate,
    session: AsyncSession = Depends(get_session),
) -> FactOut:
    content = req.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Fact content is empty.")
    existing = await session.execute(select(Fact).where(Fact.content == content))
    found = existing.scalar_one_or_none()
    if found is not None:
        return FactOut(id=found.id, content=found.content, source=found.source)
    fact = Fact(content=content, source="manual")
    session.add(fact)
    await session.commit()
    await session.refresh(fact)
    return FactOut(id=fact.id, content=fact.content, source=fact.source)


@router.delete("/{fact_id}", status_code=204)
async def delete_fact(
    fact_id: UUID,
    session: AsyncSession = Depends(get_session),
) -> None:
    fact = await session.get(Fact, fact_id)
    if fact is None:
        raise HTTPException(status_code=404, detail="Fact not found.")
    await session.delete(fact)
    await session.commit()
