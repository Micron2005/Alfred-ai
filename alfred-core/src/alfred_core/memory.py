"""Long-term 'facts about the user' memory.

Alfred commits facts to this table in two ways:

1. Automatically, by emitting a ``[REMEMBER: <fact>]`` marker anywhere in his
   own reply. The chat pipeline extracts the marker, strips it from what the
   user sees, and persists the fact.
2. Explicitly, via the ``POST /facts`` endpoint (for a future UI).

On every chat turn, recent facts are pulled and injected into Alfred's system
prompt so he always has them in mind.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from alfred_core.db.models import Fact

_REMEMBER_PATTERN = re.compile(
    r"\[REMEMBER:\s*(.+?)\s*\]",
    re.IGNORECASE | re.DOTALL,
)


def extract_and_strip(reply: str) -> tuple[str, list[str]]:
    """Pull ``[REMEMBER: ...]`` markers out of an assistant reply.

    Returns ``(visible_reply, facts)`` where ``visible_reply`` is the reply
    with every marker removed (and collapsed whitespace tidied up) and
    ``facts`` is the list of fact strings to persist.
    """
    facts = [m.group(1).strip() for m in _REMEMBER_PATTERN.finditer(reply)]
    cleaned = _REMEMBER_PATTERN.sub("", reply)
    # Collapse multiple blank lines the removals may leave behind.
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return cleaned, facts


async def save_facts(session: AsyncSession, contents: Iterable[str]) -> list[Fact]:
    """Persist a batch of new facts. Skips exact duplicates already stored."""
    existing = set(
        (await session.execute(select(Fact.content))).scalars().all()
    )
    stored: list[Fact] = []
    for raw in contents:
        content = raw.strip()
        if not content or content in existing:
            continue
        fact = Fact(content=content)
        session.add(fact)
        stored.append(fact)
        existing.add(content)
    return stored


async def recent_facts(session: AsyncSession, *, limit: int = 40) -> list[Fact]:
    """Return the most recently added facts (newest first)."""
    result = await session.execute(
        select(Fact).order_by(Fact.created_at.desc()).limit(limit)
    )
    return list(result.scalars().all())
