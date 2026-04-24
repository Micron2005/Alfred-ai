"""Async SQLAlchemy engine + session factory."""

from __future__ import annotations

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from alfred_core.config import get_settings
from alfred_core.db.models import Base


def _async_url(sync_url: str) -> str:
    """Make sure the URL uses an async driver."""
    if sync_url.startswith("postgresql+psycopg://"):
        # `psycopg` v3 supports async natively through the same driver name.
        return sync_url
    if sync_url.startswith("postgresql://"):
        return sync_url.replace("postgresql://", "postgresql+psycopg://", 1)
    return sync_url


_engine = create_async_engine(_async_url(get_settings().database_url), future=True)
_Session = async_sessionmaker(_engine, expire_on_commit=False)


async def init_db() -> None:
    """Create tables on startup. In production we'd use Alembic migrations."""
    async with _engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with _Session() as session:
        yield session
