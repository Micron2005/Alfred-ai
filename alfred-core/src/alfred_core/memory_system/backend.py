"""Abstract storage backend.

Backends store *records* — plain JSON-safe dicts produced by
``MemoryEntity.to_record()`` — and know nothing about entity classes.
That keeps the storage layer trivially swappable: the in-memory backend
is a dict, the SQLite backend is two tables, and a future Postgres or
vector-store backend only has to implement the same handful of methods.

Versioning contract
-------------------
``put(record, search_text=...)`` is *append-only*: every call stores ``record`` under
``(id, version)`` and, if ``version`` is the highest seen for that id,
makes it the current version. Re-putting an identical ``(id, version)``
is a no-op, which makes migrations idempotent. ``get`` returns only the
current version; ``history`` returns every version oldest-first.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterator
from typing import Any

Record = dict[str, Any]


class MemoryBackend(ABC):
    """Storage contract for the memory subsystem."""

    @abstractmethod
    def put(self, record: Record, *, search_text: str = "") -> None:
        """Store one version of an entity (see module docstring).

        ``search_text`` is a pre-computed lower-cased blob the backend
        indexes for :meth:`search`; the record itself is stored verbatim.
        """

    @abstractmethod
    def get(self, entity_id: str) -> Record | None:
        """Return the current version of ``entity_id`` or ``None``."""

    @abstractmethod
    def delete(self, entity_id: str) -> bool:
        """Remove the entity *and* its history. Returns ``True`` if it existed."""

    @abstractmethod
    def list_all(
        self, kind: str | None = None, *, limit: int | None = None, offset: int = 0
    ) -> list[Record]:
        """Current versions, newest ``updated_at`` first, optionally by ``kind``."""

    @abstractmethod
    def history(self, entity_id: str) -> list[Record]:
        """Every stored version of ``entity_id``, oldest first."""

    @abstractmethod
    def search(self, query: str, kind: str | None = None, *, limit: int = 20) -> list[Record]:
        """Substring match of ``query`` against each current record's ``search_text``."""

    @abstractmethod
    def ids(self) -> Iterator[str]:
        """Every entity id known to the backend (used by migrations)."""

    def count(self, kind: str | None = None) -> int:
        return len(self.list_all(kind))

    def close(self) -> None:  # noqa: B027 — optional hook; most backends hold no resources
        """Release resources. Default is a no-op."""

    def __enter__(self) -> MemoryBackend:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()
