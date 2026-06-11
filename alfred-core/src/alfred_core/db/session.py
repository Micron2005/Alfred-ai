"""Async SQLAlchemy engine + session factory."""

from __future__ import annotations

from collections.abc import AsyncIterator

from sqlalchemy import text
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
    """Create tables on startup. In production we'd use Alembic migrations.

    The pgvector extension has to exist *before* any table that uses a
    ``vector`` column is created. The Postgres image we ship is
    ``pgvector/pgvector:pg16`` which has the extension's libraries
    available, but the role still needs to opt in with ``CREATE
    EXTENSION``.
    """
    async with _engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await conn.run_sync(Base.metadata.create_all)
        # Lightweight "additive" migrations for columns added after
        # a user's first ``create_all`` run. Alembic would be
        # cleaner, but with a single-user self-hosted app the
        # overhead isn't worth it. Each statement is idempotent
        # (``IF NOT EXISTS``) so it's safe to re-run on every boot.
        await conn.execute(
            text(
                "ALTER TABLE face_enrollments "
                "ADD COLUMN IF NOT EXISTS is_admin BOOLEAN "
                "NOT NULL DEFAULT FALSE"
            )
        )


async def get_session() -> AsyncIterator[AsyncSession]:
    async with _Session() as session:
        yield session
